"""Monitoring engine: archive replay + objective probes → rules → LLM evaluate (ARCHITECTURE §6.3)."""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from pydantic import ValidationError

import prompts
from configurator import load_domains, _structured
from llm import get_llm
from models import (
    EvaluateLLMResponse,
    EvaluateResultItem,
    LlmEval,
    MonitoringObjective,
    MonitoringProfile,
    PotentialEvent,
    Signal,
    VideoSegment,
)
from repository import VideoRepository, get_repository
from rules import (
    RuleContext,
    eval_detector,
    looks_safe_interaction,
    load_entity_map,
)
from store import Store, get_store

log = logging.getLogger("sightline.engine")

RULES_ONLY_THRESHOLD = 0.75
EVAL_BATCH = 8
DEFAULT_MIN_SIM = 0.3


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _eid() -> str:
    return f"evt-{uuid.uuid4().hex[:10]}"


class MonitoringEngine:
    def __init__(
        self,
        repo: VideoRepository | None = None,
        store: Store | None = None,
        llm=None,
    ):
        self.repo = repo or get_repository()
        self.store = store or get_store()
        self.llm = llm or get_llm()
        self.domains = load_domains()
        self.entity_map = load_entity_map(self.domains)
        self._active: dict[str, bool] = {}
        self._tasks: dict[str, asyncio.Task] = {}

    def is_active(self, source_id: str) -> bool:
        return bool(self._active.get(source_id))

    async def stop(self, source_id: str) -> None:
        self._active[source_id] = False
        task = self._tasks.pop(source_id, None)
        if task and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        meta = self.store.get("source", source_id) or {"id": source_id}
        replay = dict(meta.get("replay") or {})
        replay["active"] = False
        self.store.set_source_status(source_id, "configured", replay=replay)

    async def start(
        self,
        source_id: str,
        *,
        video: str | None = None,
        speed: float | None = None,
        max_videos: int = 8,
        max_segments: int = 80,
    ) -> dict[str, Any]:
        """Start archive-replay monitoring as a background task; return immediately."""
        await self.stop(source_id)
        self._active[source_id] = True
        self.store.set_source_status(source_id, "monitoring")
        speed = float(speed or 6.0)

        async def _run() -> None:
            try:
                await self._monitor_loop(
                    source_id,
                    video=video,
                    speed=speed,
                    max_videos=max_videos,
                    max_segments=max_segments,
                )
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                log.warning("monitor %s failed: %s", source_id, e)
                self._active[source_id] = False

        self._tasks[source_id] = asyncio.create_task(_run())
        return {"ok": True, "source_id": source_id, "speed": speed}

    async def run_once(
        self,
        source_id: str,
        *,
        video: str | None = None,
        max_videos: int = 6,
        max_segments: int = 60,
        use_llm: bool = True,
    ) -> dict[str, Any]:
        """Synchronous-style full sweep (for tests / proof). Returns summary + events."""
        return await self._monitor_loop(
            source_id,
            video=video,
            speed=0,  # no sleep
            max_videos=max_videos,
            max_segments=max_segments,
            use_llm=use_llm,
            once=True,
        )

    async def _load_profile(self, source_id: str) -> MonitoringProfile:
        raw = self.store.get_profile(source_id)
        if not raw:
            raise ValueError(f"source {source_id} has no profile — configure first")
        return MonitoringProfile.model_validate(raw)

    async def _probe_map(
        self, source_id: str, objectives: list[MonitoringObjective]
    ) -> dict[str, float]:
        """Union of semantic probe hits → source_uri → best similarity."""
        hits: dict[str, float] = {}
        for obj in objectives:
            for q in obj.semantic_probes or []:
                try:
                    rows = await self.repo.search_hits(
                        q,
                        source_id=source_id,
                        top_k=15,
                        min_similarity=DEFAULT_MIN_SIM,
                    )
                except Exception as e:  # noqa: BLE001
                    log.info("probe search failed: %s", type(e).__name__)
                    continue
                for row in rows:
                    uri = row.get("segment") or ""
                    sim = row.get("similarity")
                    if not uri or sim is None:
                        continue
                    try:
                        sim_f = float(sim)
                    except (TypeError, ValueError):
                        continue
                    hits[uri] = max(hits.get(uri, 0.0), sim_f)
        return hits

    async def _enrich_ctx_frames(
        self, segs: list[VideoSegment], ctx: RuleContext
    ) -> None:
        for seg in segs:
            if seg.source_uri in ctx.bbox_frames:
                continue
            try:
                frames = await self.repo.ensure_bbox_frames(seg.source_uri)
                shape = self.repo.video_shape(seg.source_uri)
                ctx.bbox_frames[seg.source_uri] = frames
                if shape:
                    ctx.video_shapes[seg.source_uri] = shape
            except Exception:  # noqa: BLE001
                ctx.bbox_frames[seg.source_uri] = []

    def _gate_extra(
        self, seg: VideoSegment, score: float, gate: bool, signals: list[Signal], ctx: RuleContext
    ) -> bool:
        """Also pass if caption FLAG or strong probe hit (ARCHITECTURE §6.3)."""
        if gate:
            return True
        if seg.flags:
            signals.append(
                Signal(kind="caption_flag", name="flags", value=seg.flags, detail="FLAGS present")
            )
            return True
        sim = ctx.probe_hits.get(seg.source_uri)
        if sim is not None and sim >= 0.45:
            signals.append(
                Signal(kind="semantic", name="strong_probe", value=sim, detail="probe hit")
            )
            return True
        return False

    async def _evaluate_batch(
        self,
        objective: MonitoringObjective,
        candidates: list[dict[str, Any]],
        *,
        use_llm: bool,
    ) -> list[PotentialEvent]:
        """candidates: [{id, seg, score, signals}]"""
        events: list[PotentialEvent] = []
        if not candidates:
            return events

        captions_by_id = {c["id"]: (c["seg"].caption or "") for c in candidates}

        def _rules_only_fallback() -> EvaluateLLMResponse:
            results = []
            for c in candidates:
                # Safe scenes stay negative even with cooccur
                safe = looks_safe_interaction(c["seg"].caption or "")
                is_evt = (c["score"] >= RULES_ONLY_THRESHOLD) and not safe
                # Require proximity/path language or FLAG for person-vehicle
                cap = (c["seg"].caption or "").lower()
                risk = any(
                    t in cap
                    for t in (
                        "near",
                        "close",
                        "beside",
                        "approaching",
                        "in front",
                        "path",
                        "crossing",
                        "behind",
                        "moving",
                    )
                )
                if "forklift" in cap and "person" in cap.replace("personnel", ""):
                    # person+forklift alone is not enough when clearly safe
                    if safe and not risk:
                        is_evt = False
                    elif risk and not safe:
                        is_evt = True
                results.append(
                    EvaluateResultItem(
                        id=c["id"],
                        is_event=is_evt,
                        confidence=c["score"] if is_evt else max(0.1, 1.0 - c["score"]),
                        reason="rules_only"
                        + (" · safe_interaction" if safe and not is_evt else ""),
                        evidence_quote="",
                    )
                )
            return EvaluateLLMResponse(results=results)

        llm_resp: EvaluateLLMResponse
        if use_llm:
            block_lines = []
            for c in candidates:
                seg: VideoSegment = c["seg"]
                yolo = (seg.yolo.classes if seg.yolo else {}) or {}
                passed = [s.name for s in c["signals"] if s.kind == "rule" and s.value is not False]
                # better: list rule signals that passed
                passed = [
                    s.detail or s.name
                    for s in c["signals"]
                    if s.kind == "rule" and getattr(s, "value", None) is not None
                ]
                rule_passed = []
                for s in c["signals"]:
                    if s.kind != "rule":
                        continue
                    # Signal.value for rules is dict; passed encoded in detail
                    if "absent" in (s.detail or "") or "not matched" in (s.detail or "") or "skipped" in (s.detail or ""):
                        continue
                    if s.detail and (
                        "present" in s.detail
                        or "matched" in s.detail
                        or "FLAG" in s.detail
                        or "gap_norm" in s.detail
                        or "sim=" in s.detail
                    ):
                        rule_passed.append(s.name)
                sim = None
                for s in c["signals"]:
                    if s.kind == "semantic":
                        sim = s.value
                block_lines.append(
                    f'[{c["id"]}] t={seg.t_start}-{seg.t_end}s caption: "{(seg.caption or "")[:500]}" '
                    f"yolo: {json.dumps(yolo)} rule_signals: {rule_passed} "
                    f"probe_similarity: {sim} rule_score: {c['score']:.2f}"
                )
            user = prompts.fill(
                prompts.EVALUATE_USER,
                objective_json=objective.model_dump_json(),
                candidates_block="\n".join(block_lines),
            )
            # Emphasize: do not flag safe stationary/walking-away scenes
            user += (
                "\n\nStrictness: if the caption says the forklift/vehicle is stationary and the person "
                "is walking away / observing / no hazards, set is_event=false. Only flag unsafe "
                "proximity, path conflicts, or moving-vehicle near people."
            )
            llm_resp = await _structured(
                self.llm,
                system=prompts.EVALUATE_SYSTEM,
                user=user,
                model=EvaluateLLMResponse,
                fallback=_rules_only_fallback,
            )
        else:
            llm_resp = _rules_only_fallback()

        by_id = {r.id: r for r in (llm_resp.results or [])}
        for c in candidates:
            seg: VideoSegment = c["seg"]
            rid = c["id"]
            item = by_id.get(rid)
            caption = captions_by_id.get(rid, "")
            llm_eval: LlmEval | None = None
            status = "rejected"
            if item:
                quote = item.evidence_quote or ""
                # Hallucination guard: evidence_quote must be exact substring
                if item.is_event and quote and quote not in caption:
                    item = item.model_copy(update={"is_event": False, "reason": (item.reason or "") + " · bad_quote"})
                if item.is_event and looks_safe_interaction(caption) and (item.confidence or 0) < 0.85:
                    # Soft guard for safe scenes unless LLM is very confident with risk language
                    item = item.model_copy(
                        update={
                            "is_event": False,
                            "reason": (item.reason or "") + " · safe_override",
                        }
                    )
                llm_eval = LlmEval(
                    is_event=bool(item.is_event),
                    confidence=float(item.confidence or 0),
                    reason=item.reason or "",
                    evidence_quote=item.evidence_quote or "",
                )
                status = "candidate" if item.is_event else "rejected"
            else:
                # Missing from LLM → rules_only
                fb = _rules_only_fallback()
                fb_item = next((r for r in fb.results if r.id == rid), None)
                if fb_item and fb_item.is_event:
                    llm_eval = LlmEval(
                        is_event=True,
                        confidence=float(fb_item.confidence),
                        reason="rules_only",
                        evidence_quote="",
                    )
                    status = "candidate"
                else:
                    status = "rejected"

            ev = PotentialEvent(
                id=rid,
                source_id=c["source_id"],
                objective_id=objective.id,
                segment=seg.source_uri,
                signals=c["signals"],
                rule_score=float(c["score"]),
                llm=llm_eval,
                status=status,  # type: ignore[arg-type]
                t_start=seg.t_start,
                t_end=seg.t_end,
                start_segment=seg.source_uri,
                peak_segment=seg.source_uri,
                end_segment=seg.source_uri,
            )
            events.append(ev)
        return events

    def _merge_events(
        self, events: list[PotentialEvent], merge_gap: int, ordered_uris: list[str]
    ) -> list[PotentialEvent]:
        """Merge consecutive positive candidates within merge_gap_segments."""
        positives = [e for e in events if e.status == "candidate"]
        if not positives:
            return events
        uri_pos = {u: i for i, u in enumerate(ordered_uris)}
        positives.sort(key=lambda e: uri_pos.get(e.segment, 10**9))
        merged: list[PotentialEvent] = []
        rejected = [e for e in events if e.status != "candidate"]
        current: PotentialEvent | None = None
        for e in positives:
            if current is None:
                current = e
                continue
            i0 = uri_pos.get(current.end_segment or current.segment, -100)
            i1 = uri_pos.get(e.segment, 10**9)
            same_obj = current.objective_id == e.objective_id
            if same_obj and 0 <= i1 - i0 <= merge_gap + 1:
                # extend
                current = current.model_copy(
                    update={
                        "end_segment": e.segment,
                        "t_end": e.t_end if e.t_end is not None else current.t_end,
                        "rule_score": max(current.rule_score, e.rule_score),
                        "signals": list(current.signals) + list(e.signals),
                    }
                )
            else:
                merged.append(current)
                current = e
        if current:
            merged.append(current)
        return rejected + merged

    async def _monitor_loop(
        self,
        source_id: str,
        *,
        video: str | None,
        speed: float,
        max_videos: int,
        max_segments: int,
        use_llm: bool = True,
        once: bool = False,
    ) -> dict[str, Any]:
        profile = await self._load_profile(source_id)
        src = await self.repo.get_source(source_id)
        if not src:
            raise ValueError("source not found")

        objectives = list(profile.objectives or [])
        if not objectives:
            return {
                "source_id": source_id,
                "candidates": 0,
                "events": 0,
                "rejected": 0,
                "note": "no objectives (all dropped?)",
                "events_detail": [],
            }

        probe_hits = await self._probe_map(source_id, objectives)
        videos = []
        if video:
            videos = [video]
        else:
            videos = [v.original_video for v in src.videos[:max_videos]]

        all_events: list[PotentialEvent] = []
        ordered_uris: list[str] = []
        seg_counter = 0
        total_estimate = min(src.segment_count, max_segments) or max_segments

        # Pipeline monitor step
        pipe = self.store.get_pipeline(source_id) or {"source_id": source_id, "steps": []}
        steps = [s for s in (pipe.get("steps") or []) if s.get("key") != "monitor"]
        steps.append(
            {
                "key": "monitor",
                "label": "Monitoring",
                "status": "running",
                "summary": f"Archive replay {speed or 6}×",
                "started_at": _now(),
            }
        )
        self.store.put(
            "pipeline",
            source_id,
            {"source_id": source_id, "steps": steps},
            source_id=source_id,
        )

        for ov in videos:
            if not self._active.get(source_id, True) and not once:
                break
            if seg_counter >= max_segments:
                break
            try:
                segs = await self.repo.segments_for_video(ov, with_detections=False)
            except Exception as e:  # noqa: BLE001
                log.info("segments failed for %s: %s", ov, type(e).__name__)
                continue
            if not segs:
                continue

            ctx = RuleContext(
                segments=segs,
                probe_hits=probe_hits,
                entity_map=self.entity_map,
            )
            # Enrich a subset with bbox frames (cap cost)
            await self._enrich_ctx_frames(segs[: min(len(segs), 12)], ctx)

            # Per-objective candidate collection for this video
            per_obj_cands: dict[str, list[dict[str, Any]]] = {o.id: [] for o in objectives}

            for idx, seg in enumerate(segs):
                if seg_counter >= max_segments:
                    break
                if not self._active.get(source_id, True) and not once:
                    break
                ctx.segment_index = idx
                ordered_uris.append(seg.source_uri)
                seg_counter += 1

                # Update replay clock
                self.store.set_source_status(
                    source_id,
                    "monitoring",
                    replay={
                        "active": True,
                        "speed": speed or 6,
                        "segment": seg_counter,
                        "total_segments": total_estimate,
                        "segment_uri": seg.source_uri,
                        "caption": (seg.caption or "")[:240],
                    },
                )

                for obj in objectives:
                    score, signals, gate = eval_detector(
                        seg, obj.detector.all_of, obj.detector.any_of, ctx
                    )
                    # Inject semantic_probe signal if hit
                    if seg.source_uri in probe_hits:
                        signals.append(
                            Signal(
                                kind="semantic",
                                name="probe",
                                value=probe_hits[seg.source_uri],
                                detail=f"sim={probe_hits[seg.source_uri]:.3f}",
                            )
                        )
                    if not self._gate_extra(seg, score, gate, signals, ctx):
                        continue
                    # Soft skip pure safe cooccur with weak score
                    if looks_safe_interaction(seg.caption or "") and score < 0.55:
                        # Still record as rejected candidate for proof of negatives
                        rej = PotentialEvent(
                            id=_eid(),
                            source_id=source_id,
                            objective_id=obj.id,
                            segment=seg.source_uri,
                            signals=signals
                            + [
                                Signal(
                                    kind="rule",
                                    name="safe_interaction",
                                    value=True,
                                    detail="safe cues in caption",
                                )
                            ],
                            rule_score=score,
                            llm=LlmEval(
                                is_event=False,
                                confidence=0.8,
                                reason="safe person–vehicle interaction (stationary / walking away)",
                                evidence_quote="",
                            ),
                            status="rejected",
                            t_start=seg.t_start,
                            t_end=seg.t_end,
                            start_segment=seg.source_uri,
                            peak_segment=seg.source_uri,
                            end_segment=seg.source_uri,
                        )
                        all_events.append(rej)
                        self.store.put("event", rej.id, rej, source_id=source_id)
                        continue

                    per_obj_cands[obj.id].append(
                        {
                            "id": _eid(),
                            "seg": seg,
                            "score": score,
                            "signals": signals,
                            "source_id": source_id,
                        }
                    )

                if speed and speed > 0 and not once:
                    # Reveal at video time: segment_duration / speed
                    await asyncio.sleep(max(0.05, (seg.duration or 5.0) / speed))

            # Evaluate batches per objective
            for obj in objectives:
                cands = per_obj_cands.get(obj.id) or []
                for i in range(0, len(cands), EVAL_BATCH):
                    batch = cands[i : i + EVAL_BATCH]
                    evs = await self._evaluate_batch(obj, batch, use_llm=use_llm)
                    merge_gap = obj.detector.merge_gap_segments or 1
                    # merge within this video's ordered uris
                    evs = self._merge_events(evs, merge_gap, [s.source_uri for s in segs])
                    for ev in evs:
                        all_events.append(ev)
                        self.store.put("event", ev.id, ev, source_id=source_id)

        candidates = [e for e in all_events if e.status == "candidate"]
        rejected = [e for e in all_events if e.status == "rejected"]

        # Pipeline done summary
        pipe = self.store.get_pipeline(source_id) or {"source_id": source_id, "steps": []}
        steps = []
        for s in pipe.get("steps") or []:
            if s.get("key") == "monitor":
                steps.append(
                    {
                        **s,
                        "status": "done" if once else "running",
                        "summary": f"{len(candidates)} candidates · {len(rejected)} rejected",
                        "ended_at": _now() if once else None,
                    }
                )
            else:
                steps.append(s)
        if once:
            steps = [
                s
                if s.get("key") != "detect"
                else s
                for s in steps
            ]
            # add detect step
            steps = [s for s in steps if s.get("key") != "detect"]
            steps.append(
                {
                    "key": "detect",
                    "label": "Events detected",
                    "status": "done",
                    "summary": f"{len(candidates)} candidate events",
                    "started_at": _now(),
                    "ended_at": _now(),
                }
            )
        self.store.put(
            "pipeline",
            source_id,
            {"source_id": source_id, "steps": steps},
            source_id=source_id,
        )

        if once:
            self.store.set_source_status(
                source_id,
                "configured",
                replay={
                    "active": False,
                    "speed": speed or 6,
                    "segment": seg_counter,
                    "total_segments": total_estimate,
                },
            )

        return {
            "source_id": source_id,
            "domain": profile.domain,
            "objectives": [o.id for o in objectives],
            "segments_scanned": seg_counter,
            "candidates": len(candidates),
            "rejected": len(rejected),
            "events": len(candidates),
            "events_detail": [e.model_dump() for e in candidates[:20]],
            "rejected_detail": [e.model_dump() for e in rejected[:10]],
        }


_engine: MonitoringEngine | None = None


def get_engine() -> MonitoringEngine:
    global _engine
    if _engine is None:
        _engine = MonitoringEngine()
    return _engine
