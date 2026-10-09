"""P12 New footage: upload any clip → Sightline configures itself → markers + incidents (ARCHITECTURE §6.6).

The VAST indexing queue was too slow to depend on (R1), so an uploaded clip is analyzed directly:
  1. the browser sends the file plus frames sampled every few seconds (no ffmpeg in the pod)
  2. Cosmos describes every frame with a generic prompt                       → "Scene look"
  3. the SAME Configurator classifies, plans and writes a Cosmos prompt       → self-configuration
  4. Cosmos re-describes every frame with Sightline's own prompt              → re-analysis
  5. the SAME MonitoringEngine evaluates the windows; candidates are investigated by the SAME
     InvestigationEngine                                                      → markers + incidents
  6. optional YOLO on the whole clip gives person/vehicle boxes per window (best effort)

The clip becomes a virtual camera through UploadRepo, which implements the repository methods those
components call. Nothing is written to the VAST index unless UPLOAD_TO_VSS=1.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import prompts
from models import DetectionSummary, VideoRef, VideoSegment, VideoSource, parse_flags

log = logging.getLogger("sightline.newsource")

UPLOAD_DIR = Path(os.getenv("UPLOAD_DIR", "/tmp/sightline-uploads"))
COSMOS_CONCURRENCY = int(os.getenv("NEWSOURCE_COSMOS_CONCURRENCY", "4"))
FRAME_TIMEOUT_S = float(os.getenv("NEWSOURCE_FRAME_TIMEOUT_S", "40"))
YOLO_TIMEOUT_S = float(os.getenv("NEWSOURCE_YOLO_TIMEOUT_S", "60"))
YOLO_MAX_BYTES = int(os.getenv("NEWSOURCE_YOLO_MAX_BYTES", str(40 * 1024 * 1024)))
MAX_FRAMES = 40
GENERIC_PROMPT = (
    "Describe this frame from a camera feed so its environment can be identified. PLACE: what kind of place "
    "this is. CAMERA: viewpoint. ENTITIES: people, vehicles and notable objects with counts. ACTIVITY: what "
    "they are doing. NOTABLE: anything unusual or risky."
)
REANALYSIS_LABEL = "Re-analysis with Sightline's prompt (direct Cosmos, not indexed)"
VAST_LABEL = "Stored in VAST · DataEngine indexing with Sightline's prompt"
VAST_POLL_S = float(os.getenv("NEWSOURCE_VAST_POLL_S", "20"))
VAST_MAX_WAIT_S = float(os.getenv("NEWSOURCE_VAST_MAX_WAIT_S", str(45 * 60)))
_MIME = {".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
         ".mkv": "video/x-matroska", ".avi": "video/x-msvideo"}


def to_vast_enabled() -> bool:
    return os.getenv("NEWSOURCE_TO_VAST", "1").strip().lower() not in {"0", "false", "no", "off"}


def _count(v: Any) -> int:
    """The engine summary reports counts as ints; older shapes used lists."""
    return v if isinstance(v, int) else len(v or [])


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def upload_enabled() -> bool:
    return os.getenv("NEWSOURCE_ENABLED", "1").strip().lower() not in {"0", "false", "no", "off"}


def video_path(source_id: str) -> Optional[Path]:
    for p in UPLOAD_DIR.glob(f"{source_id}.*"):
        if p.suffix.lower() in {".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v"}:
            return p
    return None


def windows_from_frames(source_id: str, times: list[float], duration: float, captions: list[str]) -> list[VideoSegment]:
    """One window per sampled frame, centred on the frame time."""
    out: list[VideoSegment] = []
    n = len(times)
    for i, t in enumerate(times):
        prev_t = times[i - 1] if i > 0 else 0.0
        next_t = times[i + 1] if i + 1 < n else (duration or t + 2.0)
        start = 0.0 if i == 0 else (prev_t + t) / 2
        end = (duration or next_t) if i == n - 1 else (t + next_t) / 2
        cap = captions[i] if i < len(captions) else ""
        out.append(VideoSegment(
            source_uri=f"upload://{source_id}/w{i + 1:03d}",
            original_video=f"upload://{source_id}",
            index=i + 1,
            t_start=round(start, 2),
            t_end=round(max(end, start + 0.1), 2),
            caption=cap,
            flags=parse_flags(cap),
            yolo=DetectionSummary(),
            camera_id=source_id,
            location="uploaded",
            duration=round(max(end, start + 0.1) - start, 2),
        ))
    return out


def map_yolo_frames(windows: list[VideoSegment], yolo: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    """Assign YOLO frames (with time_sec) to windows; set per-window class max-counts."""
    frames = yolo.get("frames") or []
    by_window: dict[str, list[dict[str, Any]]] = {w.source_uri: [] for w in windows}
    for fr in frames:
        t = fr.get("time_sec")
        if t is None:
            continue
        for w in windows:
            if w.t_start <= float(t) < w.t_end or (w is windows[-1] and float(t) >= w.t_start):
                by_window[w.source_uri].append(fr)
                break
    for i, w in enumerate(windows):
        counts: dict[str, int] = {}
        for fr in by_window[w.source_uri]:
            per: dict[str, int] = {}
            for d in fr.get("detections") or []:
                lab = str(d.get("label") or "")
                if lab and lab != "forklift":
                    per[lab] = per.get(lab, 0) + 1
            for k, v in per.items():
                counts[k] = max(counts.get(k, 0), v)
        windows[i] = w.model_copy(update={"yolo": DetectionSummary(classes=counts, frames_sampled=len(by_window[w.source_uri]),
                                                                      has_sidecar=bool(by_window[w.source_uri]))})
    return by_window


class UploadRepo:
    """Repository facade over one uploaded clip (methods used by Configurator / Engine / Investigation)."""

    def __init__(self, source: VideoSource, windows: list[VideoSegment], frames: dict[str, list[dict[str, Any]]] | None = None,
                 shape: tuple[int, int] | None = None):
        self.source, self.windows, self.frames, self.shape = source, windows, frames or {}, shape

    async def list_sources(self, *, force: bool = False):
        return [self.source]

    async def get_source(self, source_id: str):
        return self.source if source_id in {self.source.id, self.source.camera_id} else None

    async def segments_for_video(self, original_video: str, *, with_detections: bool = False):
        return list(self.windows) if original_video == self.source.videos[0].original_video else []

    async def segments_for_source(self, source_id: str, *, video: str | None = None, with_detections: bool = False):
        return list(self.windows)

    async def sample_segments(self, source_id: str, n: int = 12, *, with_detections: bool = False):
        if len(self.windows) <= n:
            return list(self.windows)
        step = len(self.windows) / n
        return [self.windows[int(i * step)] for i in range(n)]

    async def enrich_segment_detections(self, seg: VideoSegment) -> VideoSegment:
        return seg

    async def ensure_bbox_frames(self, source_uri: str):
        return list(self.frames.get(source_uri) or [])

    def bbox_frames(self, source_uri: str):
        return list(self.frames.get(source_uri) or [])

    def video_shape(self, source_uri: str):
        return self.shape

    @staticmethod
    def frame_diagonal(video_shape):
        if not video_shape:
            return 1.0
        h, w = video_shape
        return float((h * h + w * w) ** 0.5) or 1.0

    async def find_other_angles(self, **kw):
        return []

    async def search_hits(self, query: str, **kw):
        return []


class _NoStreamVSS:
    """Second look on uploads is skipped cleanly (the clip is not in VSS)."""

    async def stream(self, source: str, range_header: str | None = None):
        raise RuntimeError("uploaded clip is not in VSS")


class NewSourceService:
    def __init__(self, gpu=None, llm=None, store=None, vss=None):
        self._gpu, self._llm, self._store, self._vss = gpu, llm, store, vss
        self._tasks: set[asyncio.Task] = set()

    @property
    def gpu(self):
        if self._gpu is None:
            from gpu_client import get_gpu
            self._gpu = get_gpu()
        return self._gpu

    @property
    def llm(self):
        if self._llm is None:
            from llm import get_llm
            self._llm = get_llm()
        return self._llm

    @property
    def store(self):
        if self._store is None:
            from store import get_store
            self._store = get_store()
        return self._store

    @property
    def vss(self):
        if self._vss is None:
            from vss_client import get_vss
            self._vss = get_vss()
        return self._vss

    # ------------------------------------------------------------ state

    def _meta(self, sid: str) -> dict[str, Any]:
        return self.store.get("source", sid) or {"id": sid}

    def _put_meta(self, sid: str, **upd: Any) -> dict[str, Any]:
        meta = self._meta(sid)
        meta.update(upd)
        self.store.put("source", sid, meta, source_id=sid)
        return meta

    def _step(self, sid: str, key: str, label: str, status: str, summary: str = "") -> None:
        run = self.store.get_pipeline(sid) or {"source_id": sid, "steps": []}
        steps = run.setdefault("steps", [])
        st = next((s for s in steps if s.get("key") == key), None)
        if st is None:
            st = {"key": key, "label": label}
            steps.append(st)
        st.update(status=status, label=label, summary=summary)
        if status == "running" and not st.get("started_at"):
            st["started_at"] = _now_iso()
        if status in {"done", "failed", "skipped"}:
            st["ended_at"] = _now_iso()
        self.store.put("pipeline", sid, run, source_id=sid)

    # ------------------------------------------------------------ entry

    async def create(self, *, filename: str, data: bytes, frames: list[bytes], times: list[float],
                     duration: float, shape: tuple[int, int] | None = None) -> dict[str, Any]:
        if not frames:
            raise ValueError("no frames were sent; the browser could not decode this clip")
        frames, times = frames[:MAX_FRAMES], times[:MAX_FRAMES]
        sid = f"upload-{uuid.uuid4().hex[:6]}"
        UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        ext = (Path(filename).suffix or ".mp4").lower()
        (UPLOAD_DIR / f"{sid}{ext}").write_bytes(data)
        self._put_meta(sid, id=sid, camera_id=sid, label=f"Uploaded: {filename}"[:60], location="uploaded",
                       capture_type="self-recorded", status="configuring", upload={
                           "filename": filename, "size_mb": round(len(data) / 1048576, 2), "duration": duration,
                           "frames": len(frames), "created_at": _now_iso(), "status": "running"})
        self.store.put("pipeline", sid, {"source_id": sid, "steps": []}, source_id=sid)
        task = asyncio.create_task(self.run(sid, data, frames, times, duration, shape))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return {"source_id": sid}

    async def _describe(self, frames: list[bytes], prompt_text: str) -> tuple[list[str], list[str]]:
        sem = asyncio.Semaphore(COSMOS_CONCURRENCY)
        errors: list[str] = []

        async def one(jpg: bytes) -> str:
            async with sem:
                try:
                    url = "data:image/jpeg;base64," + base64.b64encode(jpg).decode()
                    out = await asyncio.wait_for(
                        self.gpu.cosmos_chat([{"role": "user", "content": prompt_text}], images=[url], max_tokens=400),
                        timeout=FRAME_TIMEOUT_S)
                    return (out or "").strip()
                except Exception as e:  # noqa: BLE001
                    errors.append(f"{type(e).__name__}")
                    return ""

        caps = await asyncio.gather(*(one(f) for f in frames))
        return list(caps), errors

    async def _yolo(self, data: bytes, filename: str) -> dict[str, Any] | None:
        if len(data) > YOLO_MAX_BYTES:
            return None
        try:
            return await asyncio.wait_for(self.gpu.yolo_infer(base64.b64encode(data).decode(), filename=filename),
                                          timeout=YOLO_TIMEOUT_S)
        except Exception as e:  # noqa: BLE001
            log.info("yolo on upload skipped: %s", type(e).__name__)
            return None

    async def run(self, sid: str, data: bytes, frames: list[bytes], times: list[float], duration: float,
                  shape: tuple[int, int] | None) -> None:
        from configurator import Configurator
        from engine import MonitoringEngine
        from investigate import InvestigationEngine

        meta = self._meta(sid)
        filename = (meta.get("upload") or {}).get("filename", "clip.mp4")
        t_all = time.monotonic()
        try:
            # 1) scene look: generic descriptions (+ YOLO on the whole clip in parallel)
            self._step(sid, "look", f"Scene look: Cosmos describes {len(frames)} frames", "running")
            t0 = time.monotonic()
            (generic, errs), yolo = await asyncio.gather(self._describe(frames, GENERIC_PROMPT), self._yolo(data, filename))
            if not any(generic):
                raise RuntimeError(f"Cosmos could not describe the frames ({', '.join(sorted(set(errs))) or 'empty'})")
            windows = windows_from_frames(sid, times, duration, generic)
            self._put_meta(sid, windows=[{"segment": w.source_uri, "t_start": w.t_start, "t_end": w.t_end} for w in windows])
            frame_map = map_yolo_frames(windows, yolo) if yolo else {}
            if yolo and not shape:
                vs = yolo.get("video_shape")
                shape = (int(vs[0]), int(vs[1])) if isinstance(vs, (list, tuple)) and len(vs) >= 2 else None
            self._step(sid, "look", f"Scene look: Cosmos describes {len(frames)} frames", "done",
                       f"{sum(1 for g in generic if g)}/{len(frames)} frames in {time.monotonic() - t0:.1f} s"
                       + (" · YOLO on the clip" if yolo else " · YOLO skipped"))

            source = VideoSource(id=sid, camera_id=sid, location="uploaded", capture_type="self-recorded",
                                 label=meta.get("label", sid), status="configuring", segment_count=len(windows),
                                 videos=[VideoRef(original_video=f"upload://{sid}", filename=filename,
                                                  total_segments=len(windows), chunk_duration_sec=duration)])
            repo = UploadRepo(source, windows, frame_map, shape)

            # 2) self-configuration with the SAME configurator (classify → plan → prompt)
            cfg = Configurator(repo=repo, llm=self.llm, gpu=self.gpu, store=self.store)
            look_step = (self.store.get_pipeline(sid) or {}).get("steps", [])[:1]
            result = await cfg.configure(sid)
            run = self.store.get_pipeline(sid) or {"source_id": sid, "steps": []}
            run["steps"] = look_step + [s for s in run.get("steps", []) if s.get("key") != "look"]
            self.store.put("pipeline", sid, run, source_id=sid)
            prompt_text = ((result.get("prompt") or {}).get("text") or prompts.short_template(result["classification"]["domain"]))
            self._spawn(self._submit_to_vast(sid, data, filename, prompt_text))

            # 3) re-analysis of every frame with Sightline's own prompt
            self._step(sid, "reanalyze", REANALYSIS_LABEL, "running")
            t1 = time.monotonic()
            special, _errs2 = await self._describe(frames, prompt_text)
            for i, cap in enumerate(special):
                if cap:
                    w = windows[i]
                    windows[i] = w.model_copy(update={"caption": cap, "flags": parse_flags(cap)})
            repo.windows = windows
            changed = sum(1 for s in special if s)
            self._step(sid, "reanalyze", REANALYSIS_LABEL, "done" if changed else "failed",
                       f"{changed}/{len(frames)} frames in {time.monotonic() - t1:.1f} s · prompt {len(prompt_text)}/800")
            best = max(range(len(windows)), key=lambda i: (len(windows[i].flags), len(special[i] or "")))
            self._evolution(sid, generic[best], windows[best].caption, prompt_text)

            # 4) monitoring + investigation with the SAME engine and investigator
            investigator = InvestigationEngine(repo=repo, llm=self.llm, gpu=self.gpu, vss=_NoStreamVSS(), store=self.store)
            engine = _UploadEngine(repo=repo, store=self.store, llm=self.llm)
            engine.investigator = investigator
            engine.source_id = sid
            summary = await engine.run_once(sid, max_videos=1, max_segments=MAX_FRAMES)
            self._fix_clip_urls(sid, windows)
            n_inc = len(self.store.list_incidents(source_id=sid))
            self._put_meta(sid, status="configured", upload={**(self._meta(sid).get("upload") or {}), "status": "done",
                           "elapsed_s": round(time.monotonic() - t_all, 1), "incidents": n_inc,
                           "candidates": _count((summary or {}).get("candidates"))})
        except Exception as e:  # noqa: BLE001
            log.warning("newsource %s failed: %s", sid, e)
            self._put_meta(sid, status="failed", upload={**(self._meta(sid).get("upload") or {}), "status": "failed",
                           "error": f"{type(e).__name__}: {str(e)[:240]}"})

    # ------------------------------------------------------------ VAST: store the footage and index it

    def _spawn(self, coro) -> None:
        t = asyncio.create_task(coro)
        self._tasks.add(t)
        t.add_done_callback(self._tasks.discard)

    def _vast(self, sid: str, **upd: Any) -> dict[str, Any]:
        up = dict(self._meta(sid).get("upload") or {})
        vast = {**(up.get("vast") or {}), **upd}
        up["vast"] = vast
        self._put_meta(sid, upload=up)
        return vast

    async def _submit_to_vast(self, sid: str, data: bytes, filename: str, prompt_text: str) -> None:
        """Upload the clip into VAST (S3 → DataEngine → VastDB) with Sightline's own prompt."""
        if not to_vast_enabled():
            self._step(sid, "vast", VAST_LABEL, "skipped", "disabled on this deployment")
            return
        self._step(sid, "vast", VAST_LABEL, "running", "uploading to VAST…")
        mime = _MIME.get(Path(filename).suffix.lower(), "video/mp4")
        form = {"is_public": "false", "camera_id": sid, "location": "uploaded", "tags": "sightline,upload",
                "custom_prompt": prompt_text[: prompts.CUSTOM_PROMPT_MAX_CHARS]}
        try:
            resp = await self.vss.upload_video({"file": (filename, data, mime)}, form)
        except Exception as e:  # noqa: BLE001
            self._vast(sid, status="failed", error=f"{type(e).__name__}: {str(e)[:200]}")
            self._step(sid, "vast", VAST_LABEL, "failed", f"VAST upload failed: {type(e).__name__}")
            return
        key = str(resp.get("object_key") or "")
        if resp.get("success") is False or not key:
            self._vast(sid, status="failed", error=str(resp.get("message") or "no object_key returned")[:200])
            self._step(sid, "vast", VAST_LABEL, "failed", "VAST did not accept the upload")
            return
        self._vast(sid, status="indexing", object_key=key, submitted_at=_now_iso(), prompt_chars=len(form["custom_prompt"]))
        self._step(sid, "vast", VAST_LABEL, "running", f"saved to VAST S3 ({key.rsplit('/', 1)[-1]}) · indexing…")
        t0 = time.monotonic()
        while time.monotonic() - t0 < VAST_MAX_WAIT_S:
            if await self.poll_vast_once(sid):
                return
            await asyncio.sleep(VAST_POLL_S)
        self._vast(sid, status="indexing", note=f"still indexing after {int(VAST_MAX_WAIT_S // 60)} min (VAST queue)")
        self._step(sid, "vast", VAST_LABEL, "running", "saved to VAST S3 · still indexing (VAST queue)")

    async def poll_vast_once(self, sid: str) -> bool:
        """True once VAST reports the clip indexed (real numbers from the dashboard, never assumed)."""
        vast = (self._meta(sid).get("upload") or {}).get("vast") or {}
        key = vast.get("object_key") or ""
        base = key.rsplit("/", 1)[-1]
        try:
            stats = await self.vss.dashboard_stats(scope="mine")
        except Exception:  # noqa: BLE001
            return False
        for v in (stats or {}).get("recent_videos") or []:
            ident = f"{v.get('original_video') or ''} {v.get('filename') or ''}"
            if base and base in ident:
                indexed = int(v.get("indexed_clips") or v.get("unique_segments") or 0)
                expected = int(v.get("expected_segments") or 0)
                if indexed and (not expected or indexed >= expected):
                    self._vast(sid, status="indexed", indexed_at=_now_iso(), segments=indexed,
                               original_video=v.get("original_video"))
                    self._step(sid, "vast", VAST_LABEL, "done",
                               f"indexed in VastDB · {indexed} segments · searchable in VAST as {sid}")
                    return True
                self._vast(sid, status="indexing", segments=indexed, expected=expected)
                self._step(sid, "vast", VAST_LABEL, "running",
                           f"saved to VAST S3 · indexing {indexed}/{expected or '?'} segments")
                return False
        return False

    def _evolution(self, sid: str, generic: str, special: str, prompt_text: str) -> None:
        prof = self.store.get_profile(sid) or {}
        obj = (prof.get("objectives") or [{}])[0]
        steps = [
            {"stage": "generic", "text": generic or "(no description)", "label": "Generic Cosmos description"},
            {"stage": "objective", "text": f"{obj.get('name', 'Monitoring objective')} ({obj.get('severity', '')})".strip()},
            {"stage": "prompt", "text": prompt_text},
            {"stage": "reanalyzed", "text": special or "(no re-analysis)", "kind": "preview", "label": REANALYSIS_LABEL},
        ]
        self.store.put("evolution", sid, {"source_id": sid, "steps": steps}, source_id=sid)

    def _fix_clip_urls(self, sid: str, windows: list[VideoSegment]) -> None:
        """Evidence plays from the uploaded file at the window's time range (media fragment)."""
        for inc in self.store.list_incidents(source_id=sid):
            changed = False
            for ev in inc.get("evidence") or []:
                if str(ev.get("segment", "")).startswith(f"upload://{sid}"):
                    ev["clip_url"] = f"api/newsource/{sid}/video#t={ev.get('t_start', 0)},{ev.get('t_end', 0)}"
                    changed = True
            if changed:
                self.store.put("incident", inc["id"], inc, source_id=sid)

    # ------------------------------------------------------------ read model for the UI

    def view(self, sid: str) -> Optional[dict[str, Any]]:
        meta = self.store.get("source", sid)
        if not meta or not str(sid).startswith("upload-") or meta.get("status") == "unconfigured":
            return None
        events = self.store.list_kind("event", source_id=sid)
        incidents = self.store.list_incidents(source_id=sid)
        by_event = {i.get("id", "").replace("inc-", "", 1): i for i in incidents}
        markers = []
        for e in events:
            if not e:
                continue
            inc = by_event.get(e.get("id")) or next((i for i in incidents if (i.get("investigation") or {}).get("event_id") == e.get("id")), None)
            t0, t1 = e.get("t_start"), e.get("t_end")
            if t0 is None:
                w = next((w for w in meta.get("windows") or [] if w.get("segment") == e.get("segment")), None)
                t0, t1 = (w["t_start"], w["t_end"]) if w else (0.0, 0.0)
            markers.append({
                "event_id": e.get("id"), "objective_id": e.get("objective_id"), "status": "incident" if inc else e.get("status"),
                "t_start": t0, "t_end": t1, "t": ((t0 or 0) + (t1 if t1 is not None else (t0 or 0))) / 2,
                "severity": inc.get("severity") if inc else None, "title": inc.get("title") if inc else (e.get("objective_id") or "").replace("_", " "),
                "confidence": ((inc.get("confidence") or {}).get("value") if inc else (e.get("llm") or {}).get("confidence")),
                "incident_id": inc.get("id") if inc else None,
            })
        for tg in self.store.list_kind("tag", source_id=sid):
            if tg:
                t = float(tg.get("t") or 0.0)
                markers.append({"tag_id": tg.get("id"), "status": "tagged", "t_start": t, "t_end": t, "t": t,
                                "title": tg.get("note"), "check": tg.get("check") or {}, "severity": None,
                                "confidence": None, "incident_id": None})
        markers.sort(key=lambda m: m["t"] or 0)
        prof = self.store.get_profile(sid) or {}
        return {
            "source_id": sid, "label": meta.get("label"), "status": meta.get("status"), "upload": meta.get("upload") or {},
            "video_url": f"api/newsource/{sid}/video",
            "pipeline": self.store.get_pipeline(sid) or {"source_id": sid, "steps": []},
            "classification": self.store.get_classification(sid), "profile": prof,
            "evolution": self.store.get_evolution(sid) or {"source_id": sid, "steps": []},
            "markers": markers, "incidents": incidents, "windows": meta.get("windows") or [],
        }

    def list(self) -> list[dict[str, Any]]:
        out = []
        for meta in self.store.list_kind("source"):
            if meta and str(meta.get("id", "")).startswith("upload-") and meta.get("status") != "unconfigured":
                out.append({"source_id": meta["id"], "label": meta.get("label"), "status": meta.get("status"),
                            "upload": meta.get("upload") or {}})
        return sorted(out, key=lambda m: (m["upload"].get("created_at") or ""), reverse=True)


def _make_upload_engine_base():
    from engine import MonitoringEngine
    return MonitoringEngine


class _UploadEngine(_make_upload_engine_base()):  # type: ignore[misc]
    """MonitoringEngine that investigates with the upload-aware investigator."""

    investigator = None
    source_id = ""

    async def _investigate_candidates(self, source_id, candidates):
        incidents = []
        for ev in candidates[:8]:
            payload = dict(ev)
            payload["original_video"] = f"upload://{source_id}"
            try:
                inc = await self.investigator.investigate(payload)
            except Exception as e:  # noqa: BLE001
                log.warning("upload investigate failed: %s", e)
                continue
            if inc is not None:
                incidents.append(inc.model_dump())
        return incidents


_svc: NewSourceService | None = None


def get_newsource() -> NewSourceService:
    global _svc
    if _svc is None:
        _svc = NewSourceService()
    return _svc
