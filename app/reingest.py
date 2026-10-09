"""ReingestOrchestrator (P9): agent-planned re-analysis with two honest paths.

R1 (HACKATHON_UNKNOWN.md): VAST accepted a re-ingest in 0.34 s but indexing never finished in 40+ min
(pending_index stuck, captions unchanged, job status flaky 404 ↔ running). So nothing here waits on VAST:

  FAST PREVIEW  — Sightline's generated prompt + the real clip sent directly to Cosmos; the specialized
                  caption comes back in seconds. Labelled "Preview re-analysis"; it never claims the VAST
                  index changed.
  REAL INDEX    — the same prompt submitted through POST /dashboard/reingest; status advances only on real
                  evidence (VSS job progress, pending_index, and an actual reasoning_content diff). If it
                  stalls it stays "indexing" with a note; success is never manufactured.

ReingestStatus mapping (models.py): submitted → "reingesting", pending_index → "indexing".
The UI (ARCHITECTURE §5a) reads ReingestJob + AnalysisEvolution from the store via routes_core.py;
extra keys (`preview`, step `label`/`kind`) pass through unchanged.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import os
import re
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

import prompts
from models import (
    CaptionSnapshot,
    CosmosPrompt,
    MonitoringProfile,
    ReingestJob,
    ReingestProgress,
    ReingestVerify,
    VideoSegment,
)

log = logging.getLogger("sightline.reingest")

ACTIVE = {"preparing", "reingesting", "indexing", "verifying"}
MAX_CHUNKS = 2
POLL_S = float(os.getenv("REINGEST_POLL_S", "8"))
MAX_WAIT_S = float(os.getenv("REINGEST_MAX_WAIT_S", str(90 * 60)))
READY_SHARE = 0.6
PREVIEW_TIMEOUT_S = float(os.getenv("PREVIEW_TIMEOUT_S", "45"))
PREVIEW_MAX_BYTES = int(os.getenv("PREVIEW_MAX_BYTES", str(12 * 1024 * 1024)))
PREVIEW_MAX_SEGMENTS = int(os.getenv("PREVIEW_MAX_SEGMENTS", "2"))
PREVIEW_LABEL = "Preview re-analysis (direct Cosmos, not indexed)"
INDEXED_LABEL = "VAST index updated"
# Demo footage that must never be re-ingested (substring match on original_video / filename).
DEFAULT_RESERVED = (
    "20261001_075554_16face5576497e69c190_03a2937960b9e61f1c99_run_7_seed_900334964.eye_00",
    "20261001_074538_0851b7a332077a4fc0e2_01021d3989e38beb3395_run_10_seed_213384163.ceiling_01",
)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def reserved_patterns() -> tuple[str, ...]:
    extra = [p.strip() for p in os.getenv("DEMO_RESERVED", "").split(",") if p.strip()]
    return tuple(DEFAULT_RESERVED) + tuple(extra)


def is_reserved(original_video: str, filename: str = "") -> bool:
    hay = f"{original_video} {filename}"
    return any(p in hay for p in reserved_patterns())


def preview_enabled() -> bool:
    return os.getenv("PREVIEW_ENABLED", "1").strip().lower() not in {"0", "false", "no", "off"}


def objective_terms(profile: Optional[MonitoringProfile]) -> list[str]:
    """Words that show a caption now carries objective-specific detail."""
    terms = {"flags:", "moving", "stationary", "distance", "path", "close", "near"}
    for o in (profile.objectives if profile else []):
        terms.add(o.id.lower())
        terms.update(w for w in re.split(r"[\s_/]+", o.name.lower()) if len(w) > 3)
    return sorted(terms)


def verify_captions(before: list[CaptionSnapshot], after: list[CaptionSnapshot], terms: list[str]) -> ReingestVerify:
    old = {b.segment: (b.caption or "").strip() for b in before}
    changed = with_terms = 0
    for a in after:
        if a.segment in old and (a.caption or "").strip() and (a.caption or "").strip() != old[a.segment]:
            changed += 1
            low = a.caption.lower()
            if any(t in low for t in terms):
                with_terms += 1
    return ReingestVerify(changed=changed, total=len(before), with_terms=with_terms)


class ReingestOrchestrator:
    def __init__(self, repo=None, vss=None, gpu=None, store=None, sleep=asyncio.sleep):
        self._repo, self._vss, self._gpu, self._store = repo, vss, gpu, store
        self._sleep = sleep
        self._tasks: set[asyncio.Task] = set()
        self._resumed = False

    @property
    def repo(self):
        if self._repo is None:
            from repository import get_repository
            self._repo = get_repository()
        return self._repo

    @property
    def vss(self):
        if self._vss is None:
            from vss_client import get_vss
            self._vss = get_vss()
        return self._vss

    @property
    def gpu(self):
        if self._gpu is None:
            from gpu_client import get_gpu
            self._gpu = get_gpu()
        return self._gpu

    @property
    def store(self):
        if self._store is None:
            from store import get_store
            self._store = get_store()
        return self._store

    # ------------------------------------------------------------ helpers

    def _profile(self, source_id: str) -> Optional[MonitoringProfile]:
        raw = self.store.get_profile(source_id)
        try:
            return MonitoringProfile.model_validate(raw) if raw else None
        except Exception:  # noqa: BLE001
            return None

    def _prompt(self, profile: Optional[MonitoringProfile], domain: str) -> CosmosPrompt:
        gp = profile.generated_prompt if profile else None
        if gp and gp.text and len(gp.text) <= prompts.CUSTOM_PROMPT_MAX_CHARS:
            return gp
        text = prompts.short_template(domain)[: prompts.CUSTOM_PROMPT_MAX_CHARS]
        return CosmosPrompt(text=text, covers=[], rationale="template fallback", template_fallback=True)

    def _save(self, job: dict[str, Any]) -> dict[str, Any]:
        self.store.put("reingest_job", job["id"], job, source_id=job["source_id"])
        return job

    def get(self, job_id: str) -> Optional[dict[str, Any]]:
        return self.store.get("reingest_job", job_id)

    async def _fresh_segments(self, original_video: str) -> list[VideoSegment]:
        """Bypass the repository cache: re-ingest changes rows underneath it."""
        raw = await self.vss.tools_segments(original_video)
        segs = [VideoSegment.from_vss_segment(r) for r in (raw.get("segments") or [])]
        segs.sort(key=lambda s: (s.t_start, s.index))
        return segs

    def _candidate_segments(self, source_id: str) -> set[str]:
        return {e.get("segment") for e in self.store.list_kind("event", source_id=source_id)
                if e and e.get("status") in {"candidate", "incident", "investigating"}}

    # ------------------------------------------------------------ plan

    async def plan(self, source_id: str, *, original_video: str | None = None, chunk_count: int = 1,
                   preview_only: bool = False) -> dict[str, Any]:
        active = [j for j in self.store.list_kind("reingest_job", source_id=source_id) if j.get("status") in ACTIVE]
        if active and not preview_only:
            return active[0]
        src = await self.repo.get_source(source_id)
        if not src or not src.videos:
            raise ValueError("source has no indexed videos")
        profile = self._profile(source_id)
        domain = profile.domain if profile else (src.domain_hint_from_metadata or "general")
        cands = self._candidate_segments(source_id)
        refs = [r for r in src.videos if not is_reserved(r.original_video, r.filename)]
        reason = "selected by the operator"
        if original_video:
            ref = next((r for r in src.videos if r.original_video == original_video), None)
            if not ref:
                raise ValueError("video not in this source")
            if is_reserved(ref.original_video, ref.filename) and not preview_only:
                raise PermissionError("demo-reserved footage cannot be re-ingested (preview is allowed)")
        else:
            if not refs:
                raise PermissionError("every video in this source is demo-reserved")
            ref, reason = refs[0], "most recent non-reserved clip"
            for r in refs[:8]:
                segs = await self.repo.segments_for_video(r.original_video)
                hits = sum(1 for s in segs if s.source_uri in cands)
                if hits:
                    ref, reason = r, f"{hits} candidate event(s) whose captions lack objective-specific detail"
                    break
        segs = await self.repo.segments_for_video(ref.original_video)
        prompt = self._prompt(profile, domain)
        gaps = "; ".join(profile.information_gaps) if profile and profile.information_gaps else ""
        job = ReingestJob(
            id=f"rj-{uuid.uuid4().hex[:8]}",
            source_id=source_id,
            original_video=ref.original_video,
            chunk_count=max(1, min(MAX_CHUNKS, chunk_count)),
            clips=len(segs) or int(ref.total_segments or 0),
            prompt=prompt,
            status="planned",
            filename=ref.filename or ref.original_video.rsplit("/", 1)[-1],
            eta="preview in seconds · VAST index update is asynchronous (R1: not finished after 40 min)",
            reason=reason + (f". Gaps: {gaps}" if gaps else ""),
        ).model_dump()
        job["preview"] = {"status": "not_started", "label": PREVIEW_LABEL}
        job["preview_only"] = preview_only
        job["created_at"] = _now_iso()
        return self._save(job)

    # ------------------------------------------------------------ approve → both paths

    async def approve(self, job_id: str, *, submit_vast: bool = True) -> dict[str, Any]:
        job = self.get(job_id)
        if not job:
            raise KeyError(job_id)
        submit_vast = submit_vast and not job.get("preview_only")
        if job.get("status") != "planned":
            return job
        if submit_vast and is_reserved(job["original_video"], job.get("filename") or ""):
            raise PermissionError("demo-reserved footage cannot be re-ingested")
        job["status"] = "preparing"
        job["started_at"] = _now_iso()
        job.setdefault("timestamps", {})["approved"] = job["started_at"]
        segs = await self._fresh_segments(job["original_video"])
        job["snapshot_before"] = [CaptionSnapshot(segment=s.source_uri, caption=s.caption).model_dump() for s in segs]
        job["clips"] = len(segs) or job.get("clips", 0)
        job["progress"] = ReingestProgress(total_chunks=job["chunk_count"], total_segments=len(segs)).model_dump()
        self._save(job)
        self._spawn(self.run_preview(job_id))
        if submit_vast:
            await self.submit_vast(job_id)
        else:
            job = self.get(job_id)
            job["status"] = "planned"
            job["vast"] = {"submitted": False, "note": "preview only; the VAST index was not changed"}
            self._save(job)
        return self.get(job_id)

    async def submit_vast(self, job_id: str) -> dict[str, Any]:
        job = self.get(job_id)
        body = {"original_video": job["original_video"], "chunk_count": job["chunk_count"],
                "custom_prompt": (job.get("prompt") or {}).get("text", "")}
        try:
            resp = await self.vss.reingest_start(body)
        except Exception as e:  # noqa: BLE001
            job.update(status="failed", failed_stage="reingesting", error=f"VAST rejected the re-ingest: {type(e).__name__}: {e}"[:300],
                       finished_at=_now_iso())
            return self._save(job)
        job["vss_job_id"] = str(resp.get("job_id") or resp.get("id") or "") or None
        job["status"] = "reingesting"
        job.setdefault("timestamps", {})["submitted"] = _now_iso()
        job["vast"] = {"submitted": True, "accepted_at": job["timestamps"]["submitted"],
                       "selected_chunks": resp.get("selected_chunks"), "copied_segments": resp.get("copied_segments")}
        self._save(job)
        self._spawn(self.poll_until_done(job_id))
        return job

    # ------------------------------------------------------------ fast preview

    async def preview_segment(self, seg: VideoSegment, prompt_text: str) -> dict[str, Any]:
        t0 = time.monotonic()
        _resp, body = await self.vss.stream(seg.source_uri)
        buf = bytearray()
        async for chunk in body:
            buf.extend(chunk)
            if len(buf) > PREVIEW_MAX_BYTES:
                raise ValueError("clip too large for preview")
        b64 = base64.b64encode(bytes(buf)).decode()
        messages = [{"role": "user", "content": [
            {"type": "text", "text": prompt_text},
            {"type": "video_url", "video_url": {"url": f"data:video/mp4;base64,{b64}"}},
        ]}]
        text = await self.gpu.cosmos_chat(messages, max_tokens=500, temperature=0.2)
        if not (text or "").strip():
            raise ValueError("Cosmos returned an empty description")
        return {"segment": seg.source_uri, "t_start": seg.t_start, "t_end": seg.t_end,
                "original_caption": seg.caption, "preview_caption": text.strip(),
                "latency_ms": round((time.monotonic() - t0) * 1000)}

    async def run_preview(self, job_id: str) -> dict[str, Any]:
        job = self.get(job_id)
        pv = job.setdefault("preview", {"label": PREVIEW_LABEL})
        if not preview_enabled():
            pv.update(status="disabled", note="PREVIEW_ENABLED is off")
            return self._save(job)["preview"]
        pv.update(status="running", started_at=_now_iso(), label=PREVIEW_LABEL,
                  prompt_chars=len((job.get("prompt") or {}).get("text", "")))
        self._save(job)
        try:
            pv["model"] = await self.gpu.discover_cosmos_model()
        except Exception:  # noqa: BLE001
            pv["model"] = None
        prompt_text = (job.get("prompt") or {}).get("text", "")
        segs = await self.repo.segments_for_video(job["original_video"])
        cands = self._candidate_segments(job["source_id"])
        ordered = sorted(segs, key=lambda s: (s.source_uri not in cands, s.t_start))[:PREVIEW_MAX_SEGMENTS]
        results, errors = [], []
        t0 = time.monotonic()
        for seg in ordered:
            try:
                results.append(await asyncio.wait_for(self.preview_segment(seg, prompt_text), timeout=PREVIEW_TIMEOUT_S))
            except Exception as e:  # noqa: BLE001
                errors.append(f"{type(e).__name__}: {str(e)[:160]}")
        job = self.get(job_id)
        pv = job["preview"]
        pv.update(results=results, finished_at=_now_iso(), latency_ms=round((time.monotonic() - t0) * 1000))
        if results:
            pv["status"] = "done"
            if errors:
                pv["partial_errors"] = errors
        else:
            pv.update(status="failed", error=errors[0] if errors else "no segments to preview")
        self._save(job)
        if results:
            self._write_evolution(job, results[0]["original_caption"], results[0]["preview_caption"], kind="preview")
        self._touch_pipeline(job)
        return pv

    # ------------------------------------------------------------ real VAST path

    async def poll_once(self, job_id: str) -> dict[str, Any]:
        """One honest status update. Advances only on real evidence."""
        job = self.get(job_id)
        if not job or job.get("status") not in ACTIVE:
            return job
        status = None
        if job.get("vss_job_id"):
            try:
                status = await self.vss.reingest_status(job["vss_job_id"])
            except Exception as e:  # noqa: BLE001
                job["status_note"] = f"job status unavailable ({type(e).__name__}); using pending_index + caption diff"
        pending = None
        try:
            stats = await self.vss.dashboard_stats()
            pending = ((stats or {}).get("pipeline_alignment") or {}).get("pending_index")
        except Exception:  # noqa: BLE001
            pass
        if status and str(status.get("status", "")).lower() in {"failed", "error"}:
            job.update(status="failed", failed_stage=job.get("status") or "reingesting",
                       error=str(status.get("error") or status.get("detail") or "VAST reported failure")[:300],
                       finished_at=_now_iso())
            return self._save(job)
        prog = job.get("progress") or {}
        if status:
            prog["completed_chunks"] = int(status.get("completed_chunks") or prog.get("completed_chunks") or 0)
            prog["total_chunks"] = int(status.get("total_chunks") or prog.get("total_chunks") or job["chunk_count"])
        before = [CaptionSnapshot.model_validate(b) for b in job.get("snapshot_before") or []]
        segs = await self._fresh_segments(job["original_video"])
        after = [CaptionSnapshot(segment=s.source_uri, caption=s.caption) for s in segs]
        verify = verify_captions(before, after, objective_terms(self._profile(job["source_id"])))
        prog["indexed_segments"] = verify.changed
        prog["total_segments"] = len(before)
        job["progress"] = prog
        job["vast"] = {**(job.get("vast") or {}), "pending_index": pending, "last_poll": _now_iso()}
        job_done = bool(status) and (str(status.get("status", "")).lower() in {"completed", "done", "success"}
                                     or (prog["total_chunks"] and prog["completed_chunks"] >= prog["total_chunks"]))
        if verify.changed:
            job["verify"] = verify.model_dump()
            job["after"] = [a.model_dump() for a in after]
            if before and verify.changed / len(before) >= READY_SHARE:
                job.update(status="ready", finished_at=_now_iso())
                self._save(job)
                changed = next((a for a in after if a.caption.strip() != next((b.caption for b in before if b.segment == a.segment), "").strip()), after[0])
                orig = next((b.caption for b in before if b.segment == changed.segment), "")
                self._write_evolution(job, orig, changed.caption, kind="indexed")
                self._touch_pipeline(job)
                return job
            job["status"] = "verifying"
        elif job_done or (pending or 0) > 0 or job.get("status") == "indexing":
            job["status"] = "indexing"  # accepted, but VAST has not written new captions yet
        self._save(job)
        return job

    async def poll_until_done(self, job_id: str) -> dict[str, Any]:
        start = time.monotonic()
        while True:
            job = await self.poll_once(job_id)
            if not job or job.get("status") not in ACTIVE:
                return job
            if time.monotonic() - start > MAX_WAIT_S:
                job["status_note"] = f"still pending after {int(MAX_WAIT_S // 60)} min; VAST index not updated (not marked failed)"
                job["stalled"] = True
                return self._save(job)
            await self._sleep(POLL_S)

    # ------------------------------------------------------------ evolution + pipeline

    def _write_evolution(self, job: dict[str, Any], original: str, new_caption: str, *, kind: str) -> None:
        sid = job["source_id"]
        profile = self._profile(sid)
        obj = profile.objectives[0] if profile and profile.objectives else None
        steps = [
            {"stage": "generic", "text": original or "(no original caption)", "label": "Original VAST caption"},
            {"stage": "objective", "text": f"{obj.name} ({obj.severity})" if obj else "Person–vehicle safety"},
            {"stage": "prompt", "text": (job.get("prompt") or {}).get("text", "")},
        ]
        prev = self.store.get_evolution(sid) or {}
        for st in prev.get("steps") or []:  # keep an earlier preview when the index catches up
            if st.get("stage") == "reanalyzed" and st.get("kind") == "preview" and kind == "indexed":
                steps.append(st)
        steps.append({"stage": "reanalyzed", "text": new_caption, "kind": kind,
                      "label": PREVIEW_LABEL if kind == "preview" else INDEXED_LABEL, "ref": job["id"]})
        incs = self.store.list_incidents(source_id=sid)
        if incs:
            i = incs[0]
            conf = (i.get("confidence") or {}).get("value")
            steps.append({"stage": "event", "text": f"{i.get('title')} · {i.get('severity')}" + (f" · {round(conf * 100)}%" if conf is not None else ""),
                          "ref": i.get("id")})
        self.store.put("evolution", sid, {"source_id": sid, "steps": steps, "job_id": job["id"]}, source_id=sid)

    def _touch_pipeline(self, job: dict[str, Any]) -> None:
        try:
            run = self.store.get_pipeline(job["source_id"])
            if not run or not isinstance(run, dict):
                return
            pv = job.get("preview") or {}
            parts = []
            if pv.get("status") == "done":
                parts.append(f"preview ready in {round((pv.get('latency_ms') or 0) / 1000, 1)} s")
            elif pv.get("status") in {"failed", "disabled"}:
                parts.append(f"preview {pv['status']}")
            parts.append("VAST index " + {"ready": "updated", "failed": "failed"}.get(job.get("status"), "pending"))
            for st in run.get("steps") or []:
                if st.get("key") == "reingest":
                    st.update(status="done" if job.get("status") == "ready" or pv.get("status") == "done" else
                              ("failed" if job.get("status") == "failed" and pv.get("status") != "done" else "running"),
                              summary=" · ".join(parts))
            self.store.put("pipeline", job["source_id"], run, source_id=job["source_id"])
        except Exception as e:  # noqa: BLE001
            log.info("pipeline touch skipped: %s", type(e).__name__)

    # ------------------------------------------------------------ background tasks

    def _spawn(self, coro) -> None:
        t = asyncio.create_task(coro)
        self._tasks.add(t)
        t.add_done_callback(self._tasks.discard)

    def resume_active(self) -> int:
        """After a pod restart, resume polling jobs that were still active (idempotent)."""
        if self._resumed:
            return 0
        self._resumed = True
        n = 0
        for job in self.store.list_kind("reingest_job"):
            if job and job.get("status") in ACTIVE and job.get("vss_job_id") is not None:
                self._spawn(self.poll_until_done(job["id"]))
                n += 1
        return n


_orch: ReingestOrchestrator | None = None


def get_orchestrator() -> ReingestOrchestrator:
    global _orch
    if _orch is None:
        _orch = ReingestOrchestrator()
    return _orch
