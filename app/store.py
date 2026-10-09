"""In-memory state with VastDB append-only write-through (schema `sightline` only).

Never touches organizer tables (vss-collection / vss-prompts-events).
Falls back to /tmp/state.json + seed_state.json when VastDB is unreachable.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from config import Settings, get_settings
from models import StateHealth

log = logging.getLogger("sightline.store")

KINDS = (
    "source",
    "classification",
    "profile",
    "pipeline",
    "event",
    "incident",
    "reingest_job",
    "evolution",
    "meta",
)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class Store:
    def __init__(self, settings: Settings | None = None):
        self.settings = settings or get_settings()
        self._lock = threading.RLock()
        # kind -> id -> {version, payload, source_id, created_at}
        self._mem: dict[str, dict[str, dict[str, Any]]] = {k: {} for k in KINDS}
        self._pending: list[dict[str, Any]] = []
        self.backend: str = "local"  # vastdb | local
        self.data_origin: str = "memory"  # vastdb | seed | memory
        self.snapshot_at: str | None = None
        self._flush_task: asyncio.Task | None = None
        self._session = None
        self._tmp_path = Path("/tmp/sightline_state.json")
        self._seed_path = Path(self.settings.app_dir) / "seed_state.json"

    # ------------------------------------------------------------------ boot

    def boot(self) -> StateHealth:
        if self._try_vastdb_hydrate():
            self.backend = "vastdb"
            self.data_origin = "vastdb"
            self.snapshot_at = _now_iso()
            return self.health()
        if self._load_file(self._tmp_path):
            self.backend = "local"
            self.data_origin = "memory"
            self.snapshot_at = _now_iso()
            return self.health()
        if self._load_file(self._seed_path):
            self.backend = "local"
            self.data_origin = "seed"
            self.snapshot_at = _now_iso()
            return self.health()
        self.backend = "local"
        self.data_origin = "memory"
        return self.health()

    def health(self) -> StateHealth:
        return StateHealth(
            backend=self.backend,  # type: ignore[arg-type]
            data_origin=self.data_origin,  # type: ignore[arg-type]
            snapshot_at=self.snapshot_at,
        )

    def _connect(self):
        import vastdb

        endpoint = self.settings.s3_endpoint
        if not endpoint:
            raise RuntimeError("S3_ENDPOINT missing")
        if not endpoint.startswith(("http://", "https://")):
            endpoint = f"https://{endpoint}"
        return vastdb.connect(
            endpoint=endpoint,
            access=self.settings.access_key,
            secret=self.settings.secret_key,
            ssl_verify=False,
        )

    def _ensure_records_table(self, tx) -> Any:
        import pyarrow as pa

        bucket = tx.bucket(self.settings.vastdb_bucket)
        schema = bucket.schema(self.settings.sightline_schema, fail_if_missing=False)
        if schema is None:
            schema = bucket.create_schema(self.settings.sightline_schema, fail_if_exists=False)
        table = schema.table(self.settings.records_table, fail_if_missing=False)
        if table is None:
            columns = pa.schema(
                [
                    ("id", pa.utf8()),
                    ("kind", pa.utf8()),
                    ("source_id", pa.utf8()),
                    ("version", pa.int64()),
                    ("payload", pa.utf8()),
                    ("created_at", pa.utf8()),
                ]
            )
            table = schema.create_table(
                self.settings.records_table, columns=columns, fail_if_exists=False
            )
        return table

    def _try_vastdb_hydrate(self) -> bool:
        try:
            if not all(
                [
                    self.settings.s3_endpoint,
                    self.settings.access_key,
                    self.settings.secret_key,
                    self.settings.vastdb_bucket,
                ]
            ):
                return False
            session = self._connect()
            with session.transaction() as tx:
                table = self._ensure_records_table(tx)
                reader = table.select()
                try:
                    batch = reader.read_all()
                    rows = batch.to_pylist() if hasattr(batch, "to_pylist") else []
                except Exception:
                    rows = []
            for row in rows:
                kind = str(row.get("kind") or "")
                rid = str(row.get("id") or "")
                if kind not in self._mem or not rid:
                    continue
                ver = int(row.get("version") or 0)
                prev = self._mem[kind].get(rid)
                if prev and int(prev.get("version") or 0) >= ver:
                    continue
                payload_raw = row.get("payload") or "{}"
                try:
                    payload = json.loads(payload_raw) if isinstance(payload_raw, str) else payload_raw
                except json.JSONDecodeError:
                    payload = {}
                self._mem[kind][rid] = {
                    "version": ver,
                    "payload": payload,
                    "source_id": str(row.get("source_id") or ""),
                    "created_at": str(row.get("created_at") or ""),
                }
            self._session = session
            log.info("store hydrated from vastdb sightline.records (%d kinds)", len(KINDS))
            return True
        except Exception as e:  # noqa: BLE001
            log.warning("vastdb hydrate failed: %s: %s", type(e).__name__, e)
            return False

    def _load_file(self, path: Path) -> bool:
        try:
            if not path.is_file():
                return False
            data = json.loads(path.read_text())
            records = data.get("records") or data
            if not isinstance(records, dict):
                return False
            with self._lock:
                for kind, items in records.items():
                    if kind not in self._mem or not isinstance(items, dict):
                        continue
                    for rid, entry in items.items():
                        self._mem[kind][rid] = entry
            return True
        except Exception as e:  # noqa: BLE001
            log.warning("load %s failed: %s", path, type(e).__name__)
            return False

    # ------------------------------------------------------------------ CRUD

    def get(self, kind: str, id: str) -> Any | None:
        with self._lock:
            entry = self._mem.get(kind, {}).get(id)
            return None if not entry else entry.get("payload")

    def list_kind(self, kind: str, *, source_id: str | None = None) -> list[Any]:
        with self._lock:
            out = []
            for entry in self._mem.get(kind, {}).values():
                if source_id and entry.get("source_id") != source_id:
                    continue
                out.append(entry.get("payload"))
            return out

    def put(self, kind: str, id: str, payload: Any, *, source_id: str = "") -> None:
        if kind not in self._mem:
            raise ValueError(f"unknown kind {kind}")
        if hasattr(payload, "model_dump"):
            payload = payload.model_dump()
        with self._lock:
            prev = self._mem[kind].get(id)
            ver = int(prev.get("version") or 0) + 1 if prev else 1
            created = _now_iso()
            self._mem[kind][id] = {
                "version": ver,
                "payload": payload,
                "source_id": source_id,
                "created_at": created,
            }
            self._pending.append(
                {
                    "id": id,
                    "kind": kind,
                    "source_id": source_id,
                    "version": ver,
                    "payload": json.dumps(payload),
                    "created_at": created,
                }
            )
        self._write_tmp()

    def delete_local(self, kind: str, id: str) -> None:
        """Memory-only delete (append-only VastDB keeps history)."""
        with self._lock:
            self._mem.get(kind, {}).pop(id, None)

    # convenience accessors used by routes / Intel

    def get_classification(self, source_id: str) -> Any | None:
        return self.get("classification", source_id)

    def get_profile(self, source_id: str) -> Any | None:
        return self.get("profile", source_id)

    def get_pipeline(self, source_id: str) -> Any | None:
        return self.get("pipeline", source_id)

    def get_evolution(self, source_id: str) -> Any | None:
        return self.get("evolution", source_id)

    def get_reingest(self, source_id: str) -> Any | None:
        jobs = self.list_kind("reingest_job", source_id=source_id)
        if not jobs:
            return None
        return sorted(jobs, key=lambda j: j.get("started_at") or j.get("created_at") or "", reverse=True)[0]

    def list_incidents(self, *, source_id: str | None = None, since: str | None = None) -> list[Any]:
        items = self.list_kind("incident", source_id=source_id)
        if since:
            items = [i for i in items if (i.get("created_at") or "") >= since]
        items.sort(key=lambda i: i.get("created_at") or "", reverse=True)
        return items

    def incident_counts(self, source_id: str) -> dict[str, int]:
        counts = {"critical": 0, "high": 0, "medium": 0, "low": 0}
        for inc in self.list_incidents(source_id=source_id):
            sev = str(inc.get("severity") or "low")
            if sev in counts:
                counts[sev] += 1
        return counts

    def source_status(self, source_id: str, default: str = "unconfigured") -> str:
        meta = self.get("source", source_id) or {}
        return str(meta.get("status") or default)

    def set_source_status(self, source_id: str, status: str, **extra: Any) -> None:
        cur = self.get("source", source_id) or {"id": source_id}
        cur.update(extra)
        cur["status"] = status
        self.put("source", source_id, cur, source_id=source_id)

    # ------------------------------------------------------------------ export / import

    def export_snapshot(self) -> dict[str, Any]:
        with self._lock:
            records = {k: dict(v) for k, v in self._mem.items()}
        return {
            "exported_at": _now_iso(),
            "backend": self.backend,
            "data_origin": self.data_origin,
            "records": records,
        }

    def import_snapshot(self, data: dict[str, Any]) -> None:
        records = data.get("records") or {}
        with self._lock:
            for kind, items in records.items():
                if kind not in self._mem or not isinstance(items, dict):
                    continue
                for rid, entry in items.items():
                    self._mem[kind][rid] = entry
                    self._pending.append(
                        {
                            "id": rid,
                            "kind": kind,
                            "source_id": entry.get("source_id") or "",
                            "version": int(entry.get("version") or 1),
                            "payload": json.dumps(entry.get("payload") or {}),
                            "created_at": entry.get("created_at") or _now_iso(),
                        }
                    )
        self._write_tmp()
        self.snapshot_at = _now_iso()

    def _write_tmp(self) -> None:
        try:
            snap = self.export_snapshot()
            self._tmp_path.write_text(json.dumps(snap))
        except Exception as e:  # noqa: BLE001
            log.warning("tmp write failed: %s", type(e).__name__)

    # ------------------------------------------------------------------ flush

    def flush_pending_sync(self) -> int:
        with self._lock:
            batch = list(self._pending)
            self._pending.clear()
        if not batch:
            return 0
        try:
            import pyarrow as pa

            session = self._session or self._connect()
            self._session = session
            with session.transaction() as tx:
                table = self._ensure_records_table(tx)
                arrow = pa.table(
                    {
                        "id": [r["id"] for r in batch],
                        "kind": [r["kind"] for r in batch],
                        "source_id": [r["source_id"] for r in batch],
                        "version": [int(r["version"]) for r in batch],
                        "payload": [r["payload"] for r in batch],
                        "created_at": [r["created_at"] for r in batch],
                    }
                )
                table.insert(arrow)
            self.backend = "vastdb"
            if self.data_origin == "memory":
                self.data_origin = "vastdb"
            return len(batch)
        except Exception as e:  # noqa: BLE001
            log.warning("vastdb flush failed: %s: %s", type(e).__name__, e)
            with self._lock:
                self._pending = batch + self._pending
            self.backend = "local"
            return 0

    async def start_flusher(self, interval_s: float = 2.0) -> None:
        async def _loop() -> None:
            while True:
                await asyncio.sleep(interval_s)
                try:
                    await asyncio.to_thread(self.flush_pending_sync)
                except Exception as e:  # noqa: BLE001
                    log.warning("flush loop: %s", type(e).__name__)

        self._flush_task = asyncio.create_task(_loop())

    async def stop_flusher(self) -> None:
        if self._flush_task:
            self._flush_task.cancel()
            try:
                await self._flush_task
            except asyncio.CancelledError:
                pass
            self._flush_task = None
        await asyncio.to_thread(self.flush_pending_sync)


_store: Store | None = None


def get_store() -> Store:
    global _store
    if _store is None:
        _store = Store()
    return _store
