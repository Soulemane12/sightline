"""Feed management: remove a feed (stop monitoring and clear what Sightline built for it).

The archive footage itself is untouched; the camera can be re-added from Search. VastDB is
append-only, so removal clears the working set and writes an 'unconfigured' tombstone that keeps
the feed removed after a restart.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter

from store import get_store

router = APIRouter()

_PER_SOURCE = ("classification", "profile", "pipeline", "evolution")
_BY_SOURCE = ("event", "incident", "reingest_job", "tag")


def clear_feed(source_id: str) -> dict[str, int]:
    store = get_store()
    removed = {}
    for kind in _BY_SOURCE:
        items = store.list_kind(kind, source_id=source_id)
        for it in items:
            if it and it.get("id"):
                store.delete_local(kind, it["id"])
        removed[kind] = len(items)
    for kind in _PER_SOURCE:
        store.delete_local(kind, source_id)
    store.delete_local("source", source_id)
    store.put("source", source_id, {"id": source_id, "status": "unconfigured",
                                    "removed_at": datetime.now(timezone.utc).isoformat()}, source_id=source_id)
    return removed


async def _stop(source_id: str) -> None:
    try:
        from engine import get_engine
        await get_engine().stop(source_id)
    except Exception:  # noqa: BLE001
        pass


@router.delete("/api/feeds/{source_id}")
async def api_remove_feed(source_id: str) -> dict[str, Any]:
    await _stop(source_id)
    return {"ok": True, "source_id": source_id, "removed": clear_feed(source_id)}


@router.delete("/api/feeds")
async def api_clear_feeds() -> dict[str, Any]:
    store = get_store()
    ids = [m.get("id") for m in store.list_kind("source")
           if m and m.get("id") and m.get("status") in {"monitoring", "configuring", "configured", "specializing"}]
    ids += [m.get("id") for m in store.list_kind("source")
            if m and str(m.get("id", "")).startswith("upload-") and m.get("status") != "unconfigured"]
    for sid in dict.fromkeys(ids):
        await _stop(sid)
        clear_feed(sid)
        if sid.startswith("upload-"):
            _remove_upload_file(sid)
    return {"ok": True, "removed": list(dict.fromkeys(ids))}


def _remove_upload_file(sid: str) -> None:
    try:
        from newsource import video_path
        p = video_path(sid)
        if p:
            p.unlink(missing_ok=True)
    except Exception:  # noqa: BLE001
        pass
