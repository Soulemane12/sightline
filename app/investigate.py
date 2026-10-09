"""InvestigationEngine (P8): PotentialEvent → Incident (ARCHITECTURE §6.4).

Before alerting, gather context and check the event from several directions:
  1. ordered N±2 segments of the same parent video (before / event / after)
  2. other camera views of the same SDG scenario (role="angle")
  3. related moments via VSS semantic search (same camera, then other cameras)
  4. optional Cosmos second look on the event clip
  5. W&B investigation verdict (InvestigateLLMResponse), seg-id citations validated
  6. explainable confidence + severity modifiers → Incident persisted to the store

The store-backed GET api/incidents routes in routes_core.py serve what this writes,
so no incident route is redefined here. Forklift is never a YOLO class; vehicle boxes
come from COCO classes (truck/car/bus/motorcycle) and forklift semantics from captions.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import re
from datetime import datetime, timezone
from typing import Any, Optional
from urllib.parse import quote

from models import (
    BBoxPair,
    Confidence,
    ConfidenceComponent,
    DetectionSummary,
    Evidence,
    Incident,
    InvestigateLLMResponse,
    Investigation,
    MonitoringObjective,
    MonitoringProfile,
    PotentialEvent,
    SecondLook,
    TimelineItem,
    VideoSegment,
)
import prompts

log = logging.getLogger("sightline.investigate")

# Explainable confidence weights (ARCHITECTURE §6.4); renormalized over available components.
CONF_WEIGHTS: dict[str, float] = {
    "llm": 0.30,
    "temporal": 0.25,
    "cross_signal": 0.20,
    "second_look": 0.15,
    "rule": 0.10,
}
SEVERITY_ORDER = ["low", "medium", "high", "critical"]
VERDICT_SCORE = {"confirmed": 0.9, "likely": 0.7, "unclear": 0.4, "false_positive": 0.1}
INCIDENT_VERDICTS = {"confirmed", "likely"}

CONTEXT_RADIUS = 2
CLOSE_GAP_NORM = 0.06
SECOND_LOOK_TIMEOUT_S = float(os.getenv("SECOND_LOOK_TIMEOUT_S", "25"))
SECOND_LOOK_MAX_BYTES = int(os.getenv("SECOND_LOOK_MAX_BYTES", str(12 * 1024 * 1024)))

PERSON_CLASSES = {"person"}
VEHICLE_CLASSES = {"car", "truck", "bus", "motorcycle", "bicycle", "train"}
PERSON_TERMS = ("person", "worker", "pedestrian", "man", "woman", "people", "operator", "cyclist")
VEHICLE_TERMS = ("forklift", "vehicle", "car", "truck", "van", "bus", "pallet jack", "lift truck")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def second_look_enabled() -> bool:
    return os.getenv("SECOND_LOOK_ENABLED", "1").strip().lower() not in {"0", "false", "no", "off"}


def clip_url(source_uri: str) -> str:
    return f"api/clip?source={quote(source_uri, safe='')}"


# ---------------------------------------------------------------- pure helpers (unit-tested)


def box_gap(a: list[float], b: list[float]) -> float:
    """Pixel distance between two xyxy boxes (0 when they overlap)."""
    dx = max(0.0, max(a[0], b[0]) - min(a[2], b[2]))
    dy = max(0.0, max(a[1], b[1]) - min(a[3], b[3]))
    return (dx * dx + dy * dy) ** 0.5


def person_vehicle_pair(
    frames: list[dict[str, Any]], diagonal: float, *, close: float = CLOSE_GAP_NORM
) -> Optional[BBoxPair]:
    """Closest person↔vehicle gap over frames, normalized by the frame diagonal."""
    best: Optional[tuple[float, str]] = None
    close_frames = 0
    for fr in frames or []:
        dets = fr.get("detections") or []
        people = [d for d in dets if str(d.get("label", "")).lower() in PERSON_CLASSES and d.get("bbox")]
        vehicles = [d for d in dets if str(d.get("label", "")).lower() in VEHICLE_CLASSES and d.get("bbox")]
        frame_min: Optional[tuple[float, str]] = None
        for p in people:
            for v in vehicles:
                g = box_gap(p["bbox"], v["bbox"]) / (diagonal or 1.0)
                if frame_min is None or g < frame_min[0]:
                    frame_min = (g, str(v.get("label")))
        if frame_min is None:
            continue
        if frame_min[0] <= close:
            close_frames += 1
        if best is None or frame_min[0] < best[0]:
            best = frame_min
    if best is None:
        return None
    return BBoxPair(a="person", b=best[1], min_gap_norm=round(best[0], 4), frames_close=close_frames)


def mentions(caption: str, terms: tuple[str, ...]) -> bool:
    c = (caption or "").lower()
    return any(re.search(r"\b" + re.escape(t) + r"s?\b", c) for t in terms)


def cross_signal_score(seg: VideoSegment) -> tuple[float, str]:
    """Do YOLO and the Cosmos caption agree that a person and a vehicle are present?"""
    classes = {k.lower() for k, v in ((seg.yolo.classes if seg.yolo else {}) or {}).items() if v}
    y_person = bool(classes & PERSON_CLASSES)
    y_vehicle = bool(classes & VEHICLE_CLASSES)
    c_person = mentions(seg.caption, PERSON_TERMS)
    c_vehicle = mentions(seg.caption, VEHICLE_TERMS)
    caption_forklift = mentions(seg.caption, ("forklift", "lift truck", "pallet jack"))
    if c_person and c_vehicle and y_person and (y_vehicle or caption_forklift):
        return 1.0, "YOLO sees a person" + (" and a vehicle" if y_vehicle else "; the forklift is described by Cosmos (YOLO has no forklift class)") + "; the caption describes both"
    if c_person and c_vehicle:
        return 0.5, "Caption describes a person and a vehicle; YOLO only partly agrees"
    if y_person and y_vehicle:
        return 0.5, "YOLO sees a person and a vehicle; the caption does not describe the interaction"
    return 0.0, "Detections and caption do not agree on a person and a vehicle"


def parse_second_look(text: str) -> Optional[SecondLook]:
    if not text:
        return None
    m = re.search(r"VERDICT:\s*(YES|NO|UNCLEAR)", text, re.IGNORECASE)
    w = re.search(r"WHY:\s*(.+)", text, re.IGNORECASE)
    if not m:
        return None
    return SecondLook(verdict=m.group(1).upper(), text=(w.group(1).strip() if w else "")[:300])


def combine_confidence(parts: dict[str, tuple[float | None, str]]) -> Confidence:
    """Weighted average over the components that are available (value not None)."""
    comps: list[ConfidenceComponent] = []
    names = {
        "llm": "LLM evaluation",
        "temporal": "Temporal consistency",
        "cross_signal": "YOLO + caption agree",
        "second_look": "Cosmos second look",
        "rule": "Rule score",
    }
    total_w = 0.0
    acc = 0.0
    for key, w in CONF_WEIGHTS.items():
        val, expl = parts.get(key, (None, ""))
        if val is None:
            continue
        v = max(0.0, min(1.0, float(val)))
        comps.append(ConfidenceComponent(name=names[key], value=round(v, 3), weight=w, explanation=expl))
        total_w += w
        acc += w * v
    value = round(acc / total_w, 3) if total_w else 0.0
    return Confidence(value=value, components=comps)


def adjust_severity(base: str, *, span_segments: int, repeats: int, second_look: Optional[SecondLook],
                    temporal: float | None) -> tuple[str, str]:
    """DOMAIN_PROFILES §3 modifiers, net change clamped to ±1 level."""
    idx = SEVERITY_ORDER.index(base) if base in SEVERITY_ORDER else 1
    up = []
    down = []
    if span_segments >= 3:
        up.append(f"lasted {span_segments} segments")
    if repeats >= 3:
        up.append(f"repeated {repeats}× at this camera")
    if second_look and second_look.verdict == "YES":
        up.append("Cosmos second look confirmed")
    if temporal is not None and temporal < 0.34:
        down.append("neighbouring segments mostly contradict it")
    if second_look and second_look.verdict == "NO":
        down.append("Cosmos second look did not confirm")
    net = max(-1, min(1, (1 if up else 0) - (1 if down else 0)))
    new = SEVERITY_ORDER[max(0, min(len(SEVERITY_ORDER) - 1, idx + net))]
    reason = "; ".join((["+ " + u for u in up] if net > 0 else []) + (["− " + d for d in down] if net < 0 else []))
    return new, reason


# ---------------------------------------------------------------- engine


class InvestigationEngine:
    def __init__(self, repo=None, llm=None, gpu=None, vss=None, store=None):
        self._repo, self._llm, self._gpu, self._vss, self._store = repo, llm, gpu, vss, store

    # lazy singletons so tests can inject fakes
    @property
    def repo(self):
        if self._repo is None:
            from repository import get_repository
            self._repo = get_repository()
        return self._repo

    @property
    def llm(self):
        if self._llm is None:
            from llm import get_llm
            self._llm = get_llm()
        return self._llm

    @property
    def gpu(self):
        if self._gpu is None:
            from gpu_client import get_gpu
            self._gpu = get_gpu()
        return self._gpu

    @property
    def vss(self):
        if self._vss is None:
            from vss_client import get_vss
            self._vss = get_vss()
        return self._vss

    @property
    def store(self):
        if self._store is None:
            from store import get_store
            self._store = get_store()
        return self._store

    # ------------------------------------------------------------ lookup

    def _profile(self, source_id: str, profile: Any = None) -> Optional[MonitoringProfile]:
        raw = profile if profile is not None else self.store.get_profile(source_id)
        if raw is None:
            return None
        try:
            return raw if isinstance(raw, MonitoringProfile) else MonitoringProfile.model_validate(raw)
        except Exception as e:  # noqa: BLE001
            log.info("profile parse failed for %s: %s", source_id, type(e).__name__)
            return None

    @staticmethod
    def _objective(profile: Optional[MonitoringProfile], objective_id: str) -> MonitoringObjective:
        for o in (profile.objectives if profile else []):
            if o.id == objective_id:
                return o
        return MonitoringObjective(id=objective_id, name=objective_id.replace("_", " ").capitalize())

    async def _locate(self, source_id: str, segment_uri: str, hint_video: str | None) -> tuple[list[VideoSegment], int]:
        """Ordered segments of the event's parent video and the event's index in them."""
        candidates: list[str] = []
        if hint_video:
            candidates.append(hint_video)
        src = await self.repo.get_source(source_id)
        for ref in (src.videos if src else []):
            if ref.original_video not in candidates:
                candidates.append(ref.original_video)
        for ov in candidates:
            segs = await self.repo.segments_for_video(ov)
            for i, s in enumerate(segs):
                if s.source_uri == segment_uri:
                    return segs, i
        return [], -1

    def _replay_pos(self, src: Any, original_video: str, index: int) -> Optional[float]:
        """Position of the event in the source's replay order (videos list order)."""
        if not src or not src.segment_count:
            return None
        before = 0
        for ref in src.videos:
            if ref.original_video == original_video:
                return round(min(1.0, (before + max(0, index)) / src.segment_count), 4)
            before += int(ref.total_segments or 0)
        return None

    # ------------------------------------------------------------ evidence gathering

    async def _proximity(self, seg: VideoSegment) -> VideoSegment:
        seg = await self.repo.enrich_segment_detections(seg)
        try:
            frames = await self.repo.ensure_bbox_frames(seg.source_uri)
            diag = self.repo.frame_diagonal(self.repo.video_shape(seg.source_uri))
            pair = person_vehicle_pair(frames, diag)
        except Exception as e:  # noqa: BLE001
            log.info("bbox proximity skipped: %s", type(e).__name__)
            pair = None
        if pair:
            yolo = seg.yolo or DetectionSummary()
            yolo = yolo.model_copy(update={"pairs": [pair]})
            seg = seg.model_copy(update={"yolo": yolo})
        return seg

    async def _second_look(self, seg: VideoSegment, question: str) -> Optional[SecondLook]:
        if not second_look_enabled():
            return None

        async def run() -> Optional[SecondLook]:
            _resp, body = await self.vss.stream(seg.source_uri)
            buf = bytearray()
            async for chunk in body:
                buf.extend(chunk)
                if len(buf) > SECOND_LOOK_MAX_BYTES:
                    raise ValueError("clip too large for second look")
            b64 = base64.b64encode(bytes(buf)).decode()
            text = prompts.fill(prompts.COSMOS_SECOND_LOOK, objective_question=question)
            messages = [{"role": "user", "content": [
                {"type": "text", "text": text},
                {"type": "video_url", "video_url": {"url": f"data:video/mp4;base64,{b64}"}},
            ]}]
            out = await self.gpu.cosmos_chat(messages, max_tokens=120, temperature=0.0)
            return parse_second_look(out)

        try:
            return await asyncio.wait_for(run(), timeout=SECOND_LOOK_TIMEOUT_S)
        except Exception as e:  # noqa: BLE001
            log.info("second look skipped: %s", type(e).__name__)
            return None

    async def _related(self, probe: str, source_id: str, exclude: set[str]) -> list[Evidence]:
        out: list[Evidence] = []
        try:
            same = await self.repo.search_hits(probe, source_id=source_id, top_k=8, min_similarity=0.3)
            other = await self.repo.search_hits(probe, source_id=None, top_k=8, min_similarity=0.3)
        except Exception as e:  # noqa: BLE001
            log.info("related search skipped: %s", type(e).__name__)
            return out
        seen = set(exclude)
        for hit, limit in ((same, 4), ([h for h in other if h.get("camera_id") != source_id], 2)):
            n = 0
            for h in hit:
                if n >= limit or h.get("segment") in seen:
                    continue
                try:
                    ev = Evidence.model_validate({**h, "role": "related", "clip_url": clip_url(h.get("segment", ""))})
                except Exception:  # noqa: BLE001
                    continue
                seen.add(ev.segment)
                out.append(ev)
                n += 1
        return out

    # ------------------------------------------------------------ LLM prompt

    @staticmethod
    def _context_block(ctx: list[tuple[str, str, VideoSegment]]) -> str:
        lines = []
        for sid, role, s in ctx:
            classes = ", ".join(f"{k}×{v}" for k, v in ((s.yolo.classes if s.yolo else {}) or {}).items()) or "none"
            prox = ""
            if s.yolo and s.yolo.pairs:
                p = s.yolo.pairs[0]
                prox = f" proximity: person~{p.b} min_gap={p.min_gap_norm:.3f} of frame diagonal ({p.frames_close} close frames)"
            flags = f" flags: {', '.join(s.flags)}" if s.flags else ""
            lines.append(f"[{sid}] t={s.t_start:.1f}-{s.t_end:.1f}s role={role}\n   caption: \"{s.caption.strip()}\"\n   yolo: {classes}{prox}{flags}")
        return "\n".join(lines)

    @staticmethod
    def _related_block(angles: list[Evidence], related: list[Evidence]) -> str:
        lines = [f"[A{i + 1}] other camera view {a.camera_view or ''} t={a.t_start:.1f}s: \"{a.caption.strip()[:300]}\"" for i, a in enumerate(angles)]
        lines += [f"[R{i + 1}] {r.camera_id or ''} t={r.t_start:.1f}s sim={r.similarity if r.similarity is not None else '?'}: \"{r.caption.strip()[:240]}\"" for i, r in enumerate(related)]
        return "\n".join(lines) or "(none)"

    def _fallback(self, objective: MonitoringObjective, event: PotentialEvent, ctx, ev_sid: str) -> InvestigateLLMResponse:
        """Deterministic investigation when W&B is unavailable (labelled rules_only)."""
        ev_seg = next(s for sid, _r, s in ctx if sid == ev_sid)
        support = [s for _sid, _r, s in ctx if mentions(s.caption, PERSON_TERMS) and mentions(s.caption, VEHICLE_TERMS)]
        temporal = len(support) / max(1, len(ctx))
        strong = event.rule_score >= 0.75 or any(objective.id in f for f in ev_seg.flags)
        verdict = "likely" if strong else "unclear"
        return InvestigateLLMResponse(
            verdict=verdict,
            event_type=objective.id,
            title=(objective.wording.title or objective.name)[:60],
            summary=ev_seg.caption.strip()[:400],
            timeline=[TimelineItem(t=s.t_start, text=(s.caption.split(".")[0] or s.caption)[:140], segment=sid) for sid, _r, s in ctx],
            start_segment=ev_sid, peak_segment=ev_sid, end_segment=ev_sid,
            entities=[e for e in ("person", "vehicle") if support],
            why_flagged="; ".join(f"{sg.name}: {sg.detail or sg.value}" for sg in event.signals)[:400] or "Deterministic rules matched the objective.",
            counter_evidence="W&B planner unavailable; this is a deterministic rules-only judgement. Requires review.",
            temporal_support=round(temporal, 3),
            answers=[],
            recommended_action=objective.wording.review_action or "Review the evidence.",
        )

    # ------------------------------------------------------------ main entry

    async def investigate(
        self,
        event: PotentialEvent | dict[str, Any],
        *,
        profile: Any = None,
        original_video: str | None = None,
        persist: bool = True,
    ) -> Optional[Incident]:
        raw = event if isinstance(event, dict) else event.model_dump()
        hint_video = original_video or raw.get("original_video")
        ev = event if isinstance(event, PotentialEvent) else PotentialEvent.model_validate(raw)
        prof = self._profile(ev.source_id, profile)
        objective = self._objective(prof, ev.objective_id)
        domain = prof.domain if prof else "general"
        src = await self.repo.get_source(ev.source_id)

        # 1) context window
        segs, idx = await self._locate(ev.source_id, ev.segment, hint_video)
        if idx < 0:
            log.warning("event %s: segment not found in source %s", ev.id, ev.source_id)
            self._persist_event(ev, "rejected", note="segment not found", persist=persist)
            return None
        span = {ev.start_segment or ev.segment, ev.segment, ev.end_segment or ev.segment}
        lo, hi = max(0, idx - CONTEXT_RADIUS), min(len(segs), idx + CONTEXT_RADIUS + 1)
        window = [await self._proximity(s) for s in segs[lo:hi]]
        ctx: list[tuple[str, str, VideoSegment]] = []
        ev_sid = ""
        for k, s in enumerate(window):
            j = lo + k
            role = "event" if s.source_uri in span or j == idx else ("before" if j < idx else "after")
            sid = f"S{k + 1}"
            if j == idx:
                ev_sid = sid
            ctx.append((sid, role, s))
        sid_to_uri = {sid: s.source_uri for sid, _r, s in ctx}
        ev_seg = segs[idx]

        # 2) other angles, 3) related moments, 4) second look (in parallel)
        question = (objective.investigation_questions[0] if objective.investigation_questions
                    else f"Is {objective.description or objective.name} visible in this clip?")
        probe = objective.semantic_probes[0] if objective.semantic_probes else objective.name
        angles_raw, related, second = await asyncio.gather(
            self.repo.find_other_angles(original_video=ev_seg.original_video, t_start=ev_seg.t_start, t_end=ev_seg.t_end),
            self._related(probe, ev.source_id, set(sid_to_uri.values())),
            self._second_look(ev_seg, question),
            return_exceptions=True,
        )
        angles: list[Evidence] = []
        for a in (angles_raw if isinstance(angles_raw, list) else []):
            try:
                a = Evidence.model_validate({**a, "role": "angle", "clip_url": clip_url(a.get("segment", ""))})
                angles.append(a)
            except Exception:  # noqa: BLE001
                continue
        related = related if isinstance(related, list) else []
        second = second if isinstance(second, SecondLook) else None

        # 5) investigation verdict
        user = prompts.fill(
            prompts.INVESTIGATE_USER,
            domain=domain,
            objective_json=json.dumps(objective.model_dump(include={"id", "name", "description", "severity"})),
            investigation_questions=json.dumps(objective.investigation_questions or [question]),
            context_block=self._context_block(ctx),
            related_block=self._related_block(angles, related),
            second_look=f"VERDICT: {second.verdict}. {second.text}" if second else "(not available)",
        )
        used_fallback = {"v": False}

        def fb() -> InvestigateLLMResponse:
            used_fallback["v"] = True
            return self._fallback(objective, ev, ctx, ev_sid)

        resp: InvestigateLLMResponse = await self.llm.structured(
            prompts.INVESTIGATE_SYSTEM + "\n\n" + user, {}, InvestigateLLMResponse, fb
        )

        def to_uri(seg_id: str) -> str:
            if seg_id in sid_to_uri:
                return sid_to_uri[seg_id]
            return seg_id if seg_id in sid_to_uri.values() else ""

        timeline = [TimelineItem(t=t.t, text=t.text, segment=to_uri(t.segment)) for t in resp.timeline if to_uri(t.segment)]
        start_uri = to_uri(resp.start_segment) or ev.start_segment or ev_seg.source_uri
        peak_uri = to_uri(resp.peak_segment) or ev_seg.source_uri
        end_uri = to_uri(resp.end_segment) or ev.end_segment or ev_seg.source_uri
        by_uri = {s.source_uri: s for _sid, _r, s in ctx}

        # 6) confidence + severity
        cross, cross_expl = cross_signal_score(by_uri.get(peak_uri, ev_seg))
        llm_val = VERDICT_SCORE.get(resp.verdict, 0.4)
        if ev.llm and ev.llm.confidence:
            llm_val = (llm_val + float(ev.llm.confidence)) / 2
        temporal = max(0.0, min(1.0, float(resp.temporal_support or 0.0)))
        parts: dict[str, tuple[float | None, str]] = {
            "llm": (llm_val, "Investigation verdict" + (" combined with the evaluator's confidence" if ev.llm else "") + ("" if not used_fallback["v"] else " (rules-only)")),
            "temporal": (temporal, f"Share of the {len(ctx)} neighbouring segments consistent with the event"),
            "cross_signal": (cross, cross_expl),
            "second_look": ({"YES": 1.0, "UNCLEAR": 0.5, "NO": 0.0}.get(second.verdict) if second else None, "Direct Cosmos check of the event clip"),
            "rule": (ev.rule_score, "Fraction of the objective's deterministic rules that passed"),
        }
        confidence = combine_confidence(parts)
        span_len = len({start_uri, peak_uri, end_uri} | {s.source_uri for _sid, r, s in ctx if r == "event"})
        repeats = 1 + sum(1 for i in self.store.list_incidents(source_id=ev.source_id) if i.get("objective_id") == ev.objective_id)
        severity, sev_reason = adjust_severity(objective.severity, span_segments=span_len, repeats=repeats,
                                               second_look=second, temporal=temporal)

        evidence = [
            Evidence(role=r, segment=s.source_uri, t_start=s.t_start, t_end=s.t_end, caption=s.caption,
                     yolo=s.yolo, clip_url=clip_url(s.source_uri), camera_id=s.camera_id or ev.source_id)
            for _sid, r, s in ctx
        ] + angles
        investigation = Investigation(
            event_id=ev.id, verdict=resp.verdict, timeline=timeline,
            start_segment=start_uri, peak_segment=peak_uri, end_segment=end_uri,
            entities=resp.entities, why_flagged=resp.why_flagged + (f" Severity {sev_reason}." if sev_reason else ""),
            counter_evidence=resp.counter_evidence, related=related, second_look=second, confidence=confidence,
            answers=resp.answers, temporal_support=temporal, event_type=resp.event_type, title=resp.title,
            summary=resp.summary, recommended_action=resp.recommended_action,
        )
        if resp.verdict not in INCIDENT_VERDICTS:
            self._persist_event(ev, "rejected", investigation=investigation, persist=persist)
            return None

        peak = by_uri.get(peak_uri, ev_seg)
        incident = Incident(
            id=f"inc-{ev.id}",
            source_id=ev.source_id,
            domain=domain,
            objective_id=ev.objective_id,
            event_type=resp.event_type or ev.objective_id,
            title=(resp.title or objective.wording.title or objective.name)[:80],
            severity=severity,  # type: ignore[arg-type]
            confidence=confidence,
            summary=resp.summary,
            started_at=by_uri.get(start_uri, ev_seg).t_start,
            peak_at=round((peak.t_start + peak.t_end) / 2, 2),
            ended_at=by_uri.get(end_uri, ev_seg).t_end,
            camera_id=ev_seg.camera_id or ev.source_id,
            location=ev_seg.location or (src.location if src else ""),
            entities=resp.entities,
            evidence=evidence,
            investigation=investigation,
            recommended_action=resp.recommended_action or objective.wording.review_action,
            created_at=_now_iso(),
            search_hint=probe,
            replay_pos=self._replay_pos(src, ev_seg.original_video, idx),
            mode="rules_only" if used_fallback["v"] else "llm",
        )
        if persist:
            self.store.put("incident", incident.id, incident, source_id=ev.source_id)
            self._persist_event(ev, "incident", investigation=investigation, persist=True)
            self._touch_pipeline(ev.source_id)
        return incident

    # ------------------------------------------------------------ persistence

    def _persist_event(self, ev: PotentialEvent, status: str, *, investigation: Investigation | None = None,
                       note: str = "", persist: bool = True) -> None:
        if not persist:
            return
        payload = ev.model_dump()
        payload["status"] = status
        if investigation is not None:
            payload["investigation"] = investigation.model_dump()
        if note:
            payload["note"] = note
        self.store.put("event", ev.id, payload, source_id=ev.source_id)
        self._touch_pipeline(ev.source_id)

    def _touch_pipeline(self, source_id: str) -> None:
        """Refresh the investigate/incident step summaries if a pipeline run exists."""
        try:
            run = self.store.get_pipeline(source_id)
            if not run or not isinstance(run, dict):
                return
            events = self.store.list_kind("event", source_id=source_id)
            n_inv = sum(1 for e in events if e.get("status") in {"incident", "rejected"})
            n_rej = sum(1 for e in events if e.get("status") == "rejected")
            n_inc = len(self.store.list_incidents(source_id=source_id))
            changed = False
            for st in run.get("steps") or []:
                if st.get("key") == "investigate":
                    st.update(status="done" if n_inv else st.get("status", "pending"), summary=f"{n_inv} investigated · {n_rej} rejected")
                    changed = True
                elif st.get("key") == "incident":
                    st.update(status="done" if n_inc else st.get("status", "pending"), summary=f"{n_inc} incident{'s' if n_inc != 1 else ''}")
                    changed = True
            if changed:
                self.store.put("pipeline", source_id, run, source_id=source_id)
        except Exception as e:  # noqa: BLE001
            log.info("pipeline touch skipped: %s", type(e).__name__)

    async def investigate_pending(self, source_id: str, *, limit: int = 10) -> dict[str, Any]:
        """Investigate stored candidate events for a source (oldest first)."""
        events = [e for e in self.store.list_kind("event", source_id=source_id) if e.get("status") in {"candidate", "investigating"}]
        out = {"investigated": 0, "incidents": [], "rejected": 0}
        for raw in events[:limit]:
            inc = await self.investigate(raw)
            out["investigated"] += 1
            if inc:
                out["incidents"].append(inc.id)
            else:
                out["rejected"] += 1
        return out


_engine: InvestigationEngine | None = None


def get_investigator() -> InvestigationEngine:
    global _engine
    if _engine is None:
        _engine = InvestigationEngine()
    return _engine


async def investigate_event(event: PotentialEvent | dict[str, Any], **kw: Any) -> Optional[Incident]:
    """Entry point for the monitoring engine (P7): call after a candidate is accepted."""
    return await get_investigator().investigate(event, **kw)
