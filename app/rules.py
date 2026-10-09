"""Deterministic rule primitives over VideoSegment lists (DOMAIN_PROFILES §1).

bbox_proximity normalizes pixel xyxy edge gaps by frame diagonal.
Forklift is caption/synonym only — never a YOLO class.
time_window is unavailable and always skipped.
"""

from __future__ import annotations

import logging
import math
import re
from dataclasses import dataclass, field
from typing import Any, Optional

from models import BBoxPair, DetectionSummary, RuleCall, Signal, VideoSegment

log = logging.getLogger("sightline.rules")


@dataclass
class RuleContext:
    """Optional extras for multi-segment / search-backed primitives."""

    segments: list[VideoSegment] = field(default_factory=list)
    segment_index: int = 0
    # source_uri → similarity from semantic probes
    probe_hits: dict[str, float] = field(default_factory=dict)
    # source_uri → list of frame dicts with pixel xyxy detections
    bbox_frames: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    # source_uri → (H, W)
    video_shapes: dict[str, tuple[int, int]] = field(default_factory=dict)
    entity_map: dict[str, Any] = field(default_factory=dict)


@dataclass
class RuleResult:
    passed: bool
    name: str
    value: Any = None
    detail: str = ""

    def as_signal(self) -> Signal:
        return Signal(
            kind="rule",
            name=self.name,
            value=self.value,
            detail=self.detail,
        )


def load_entity_map(domains: dict[str, Any] | None = None) -> dict[str, Any]:
    if domains is None:
        from configurator import load_domains

        domains = load_domains()
    return dict(domains.get("entity_map") or {})


def _entity_spec(entity: str, entity_map: dict[str, Any]) -> dict[str, Any]:
    key = (entity or "").strip().lower()
    if key in entity_map:
        return entity_map[key]
    # Allow direct YOLO class names
    return {
        "yolo": [key] if key else [],
        "caption_synonyms": [key] if key else [],
    }


def _caption_has_synonym(caption: str, synonyms: list[str]) -> bool:
    low = (caption or "").lower()
    for syn in synonyms:
        if not syn:
            continue
        if re.search(rf"\b{re.escape(syn.lower())}\b", low):
            return True
    return False


def entity_count(seg: VideoSegment, entity: str, entity_map: dict[str, Any]) -> int:
    """Max count from YOLO classes, else 1 if caption synonym matches, else 0.

    Forklift (and other caption-only entities with empty yolo list) never use YOLO.
    """
    spec = _entity_spec(entity, entity_map)
    yolo_labels = list(spec.get("yolo") or [])
    synonyms = list(spec.get("caption_synonyms") or [])
    classes = (seg.yolo.classes if seg.yolo else {}) or {}

    count = 0
    for lab in yolo_labels:
        count = max(count, int(classes.get(lab, 0)))
    if count > 0:
        return count
    if _caption_has_synonym(seg.caption or "", synonyms):
        return 1
    # Also check object_classes list text
    joined = " ".join(seg.object_classes or []).lower()
    if any(s.lower() in joined for s in synonyms if s):
        return 1
    return 0


def entity_present(seg: VideoSegment, entity: str, entity_map: dict[str, Any]) -> bool:
    return entity_count(seg, entity, entity_map) > 0


def entities_present(seg: VideoSegment, params: dict[str, Any], ctx: RuleContext) -> RuleResult:
    entities = params.get("entities") or []
    min_count = params.get("min_count") or {}
    missing = []
    for ent in entities:
        need = int(min_count.get(ent, 1)) if isinstance(min_count, dict) else 1
        got = entity_count(seg, str(ent), ctx.entity_map)
        if got < need:
            missing.append(f"{ent}<{need}")
    ok = not missing
    return RuleResult(
        passed=ok,
        name="entities_present",
        value={"missing": missing},
        detail="all present" if ok else f"missing {missing}",
    )


def cooccur(seg: VideoSegment, params: dict[str, Any], ctx: RuleContext) -> RuleResult:
    a = str(params.get("a") or "")
    b = str(params.get("b") or "")
    ok = entity_present(seg, a, ctx.entity_map) and entity_present(seg, b, ctx.entity_map)
    return RuleResult(
        passed=ok,
        name="cooccur",
        value={"a": a, "b": b},
        detail=f"{a}+{b} {'present' if ok else 'absent'}",
    )


def _box_edge_gap(a: list[float], b: list[float]) -> float:
    """Closest edge gap between two xyxy boxes (0 if overlapping)."""
    ax1, ay1, ax2, ay2 = [float(x) for x in a[:4]]
    bx1, by1, bx2, by2 = [float(x) for x in b[:4]]
    if ax2 < bx1:
        dx = bx1 - ax2
    elif bx2 < ax1:
        dx = ax1 - bx2
    else:
        dx = 0.0
    if ay2 < by1:
        dy = by1 - ay2
    elif by2 < ay1:
        dy = ay1 - by2
    else:
        dy = 0.0
    return math.sqrt(dx * dx + dy * dy)


def _labels_for_entity(entity: str, entity_map: dict[str, Any]) -> list[str]:
    spec = _entity_spec(entity, entity_map)
    labels = list(spec.get("yolo") or [])
    # Direct class name fallback
    if entity and entity not in labels:
        # Only add if entity looks like a YOLO class (not forklift)
        if entity.lower() != "forklift" and (spec.get("yolo") or entity.lower() in (
            "person", "car", "truck", "bus", "motorcycle", "bicycle"
        )):
            if entity.lower() not in [l.lower() for l in labels]:
                labels.append(entity)
    return labels


def bbox_proximity(seg: VideoSegment, params: dict[str, Any], ctx: RuleContext) -> RuleResult:
    """Closest box edge gap / frame diagonal <= max_gap_norm for >= min_frames."""
    a = str(params.get("a") or "person")
    b = str(params.get("b") or "car")
    max_gap = float(params.get("max_gap_norm") or 0.06)
    min_frames = int(params.get("min_frames") or 2)

    # Forklift has no YOLO boxes — cannot pass bbox_proximity on forklift entity.
    if a.lower() == "forklift" or b.lower() == "forklift":
        return RuleResult(
            passed=False,
            name="bbox_proximity",
            value={"reason": "forklift_not_yolo"},
            detail="forklift is caption-only; bbox_proximity skipped",
        )

    frames = ctx.bbox_frames.get(seg.source_uri) or []
    shape = ctx.video_shapes.get(seg.source_uri)
    if not frames or not shape:
        return RuleResult(
            passed=False,
            name="bbox_proximity",
            value={"reason": "no_sidecar"},
            detail="no detection sidecar frames",
        )

    diag = math.sqrt(shape[0] ** 2 + shape[1] ** 2) or 1.0
    labels_a = _labels_for_entity(a, ctx.entity_map)
    labels_b = _labels_for_entity(b, ctx.entity_map)
    if not labels_a or not labels_b:
        return RuleResult(
            passed=False,
            name="bbox_proximity",
            value={"reason": "no_yolo_labels"},
            detail=f"no YOLO labels for {a}/{b}",
        )

    frames_close = 0
    min_gap_norm = 1.0
    for fr in frames:
        dets = fr.get("detections") or []
        boxes_a = [d["bbox"] for d in dets if d.get("label") in labels_a and d.get("bbox")]
        boxes_b = [d["bbox"] for d in dets if d.get("label") in labels_b and d.get("bbox")]
        if not boxes_a or not boxes_b:
            continue
        best = min(_box_edge_gap(ba, bb) for ba in boxes_a for bb in boxes_b)
        gap_norm = best / diag
        min_gap_norm = min(min_gap_norm, gap_norm)
        if gap_norm <= max_gap:
            frames_close += 1

    ok = frames_close >= min_frames
    # Attach pair summary onto segment.yolo when available
    if seg.yolo is not None:
        pairs = list(seg.yolo.pairs or [])
        pairs.append(
            BBoxPair(a=a, b=b, min_gap_norm=round(min_gap_norm, 4), frames_close=frames_close)
        )
        seg.yolo = DetectionSummary(
            classes=seg.yolo.classes,
            frames_sampled=seg.yolo.frames_sampled,
            has_sidecar=seg.yolo.has_sidecar,
            pairs=pairs,
        )

    return RuleResult(
        passed=ok,
        name="bbox_proximity",
        value={
            "a": a,
            "b": b,
            "min_gap_norm": round(min_gap_norm, 4),
            "frames_close": frames_close,
            "max_gap_norm": max_gap,
        },
        detail=f"gap_norm={min_gap_norm:.4f} close_frames={frames_close}",
    )


def count_threshold(seg: VideoSegment, params: dict[str, Any], ctx: RuleContext) -> RuleResult:
    entity = str(params.get("entity") or "person")
    op = str(params.get("op") or ">=")
    value = float(params.get("value") or 1)
    got = entity_count(seg, entity, ctx.entity_map)
    if op == ">=":
        ok = got >= value
    elif op == "<=":
        ok = got <= value
    elif op == ">":
        ok = got > value
    elif op == "<":
        ok = got < value
    elif op == "==":
        ok = got == value
    else:
        ok = got >= value
    return RuleResult(
        passed=ok,
        name="count_threshold",
        value={"entity": entity, "got": got, "op": op, "value": value},
        detail=f"{entity} {got} {op} {value}",
    )


def caption_terms(seg: VideoSegment, params: dict[str, Any], ctx: RuleContext) -> RuleResult:
    cap = (seg.caption or "").lower()
    any_terms = [str(t).lower() for t in (params.get("any") or [])]
    all_terms = [str(t).lower() for t in (params.get("all") or [])]
    none_terms = [str(t).lower() for t in (params.get("none") or [])]
    any_ok = True if not any_terms else any(t in cap for t in any_terms)
    all_ok = all(t in cap for t in all_terms) if all_terms else True
    none_ok = not any(t in cap for t in none_terms) if none_terms else True
    ok = any_ok and all_ok and none_ok
    return RuleResult(
        passed=ok,
        name="caption_terms",
        value={"any_hit": any_ok, "all_hit": all_ok, "none_ok": none_ok},
        detail="terms matched" if ok else "terms not matched",
    )


def caption_flag(seg: VideoSegment, params: dict[str, Any], ctx: RuleContext) -> RuleResult:
    flag = str(params.get("flag") or "").strip().lower()
    flags = [f.lower() for f in (seg.flags or [])]
    ok = bool(flag) and flag in flags
    return RuleResult(
        passed=ok,
        name="caption_flag",
        value={"flag": flag, "flags": flags},
        detail=f"FLAG {flag} {'present' if ok else 'absent'}",
    )


def semantic_probe(seg: VideoSegment, params: dict[str, Any], ctx: RuleContext) -> RuleResult:
    min_sim = float(params.get("min_similarity") or 0.3)
    sim = ctx.probe_hits.get(seg.source_uri)
    ok = sim is not None and sim >= min_sim
    return RuleResult(
        passed=ok,
        name="semantic_probe",
        value={"similarity": sim, "min_similarity": min_sim},
        detail=f"sim={sim}" if sim is not None else "not in probe hits",
    )


def time_window(seg: VideoSegment, params: dict[str, Any], ctx: RuleContext) -> RuleResult:
    """DISABLED — no capture wall-clock in the index."""
    return RuleResult(
        passed=False,
        name="time_window",
        value={"available": False},
        detail="skipped: no capture wall-clock",
    )


def _box_center(bbox: list[float]) -> tuple[float, float]:
    return ((bbox[0] + bbox[2]) / 2.0, (bbox[1] + bbox[3]) / 2.0)


def persistence(seg: VideoSegment, params: dict[str, Any], ctx: RuleContext) -> RuleResult:
    """Entity stays in a similar box position across consecutive segments ending at current."""
    entity = str(params.get("entity") or "person")
    min_segments = int(params.get("min_segments") or 3)
    stationary = bool(params.get("stationary", True))
    labels = _labels_for_entity(entity, ctx.entity_map)
    if not labels:
        # Caption-only: fall back to presence across captions
        segs = ctx.segments[max(0, ctx.segment_index - min_segments + 1) : ctx.segment_index + 1]
        if len(segs) < min_segments:
            return RuleResult(False, "persistence", detail="insufficient window")
        ok = all(entity_present(s, entity, ctx.entity_map) for s in segs)
        return RuleResult(ok, "persistence", value={"caption_mode": True}, detail="caption persistence")

    window = ctx.segments[max(0, ctx.segment_index - min_segments + 1) : ctx.segment_index + 1]
    if len(window) < min_segments:
        return RuleResult(False, "persistence", detail="insufficient segments")

    centers: list[tuple[float, float]] = []
    for s in window:
        frames = ctx.bbox_frames.get(s.source_uri) or []
        found = None
        for fr in frames:
            for d in fr.get("detections") or []:
                if d.get("label") in labels and d.get("bbox"):
                    found = _box_center(d["bbox"])
                    break
            if found:
                break
        if not found:
            return RuleResult(False, "persistence", detail=f"{entity} missing in window")
        centers.append(found)

    if not stationary:
        return RuleResult(True, "persistence", value={"centers": len(centers)}, detail="present across window")

    # Stationary: centers within ~5% of frame diagonal of mean
    shape = ctx.video_shapes.get(seg.source_uri) or (1080, 1920)
    diag = math.sqrt(shape[0] ** 2 + shape[1] ** 2) or 1.0
    mx = sum(c[0] for c in centers) / len(centers)
    my = sum(c[1] for c in centers) / len(centers)
    ok = all(math.hypot(c[0] - mx, c[1] - my) / diag <= 0.05 for c in centers)
    return RuleResult(
        passed=ok,
        name="persistence",
        value={"min_segments": min_segments, "stationary": stationary},
        detail="stationary" if ok else "moved",
    )


def disappearance(seg: VideoSegment, params: dict[str, Any], ctx: RuleContext) -> RuleResult:
    entity = str(params.get("entity") or "bag")
    present_n = int(params.get("present_segments") or 2)
    absent_n = int(params.get("absent_segments") or 2)
    need = present_n + absent_n
    start = ctx.segment_index - need + 1
    if start < 0 or ctx.segment_index >= len(ctx.segments):
        return RuleResult(False, "disappearance", detail="insufficient history")
    window = ctx.segments[start : ctx.segment_index + 1]
    if len(window) < need:
        return RuleResult(False, "disappearance", detail="short window")
    present_part = window[:present_n]
    absent_part = window[present_n:]
    ok = all(entity_present(s, entity, ctx.entity_map) for s in present_part) and all(
        not entity_present(s, entity, ctx.entity_map) for s in absent_part
    )
    return RuleResult(
        passed=ok,
        name="disappearance",
        value={"entity": entity},
        detail="disappeared" if ok else "pattern not matched",
    )


PRIMITIVES = {
    "entities_present": entities_present,
    "cooccur": cooccur,
    "bbox_proximity": bbox_proximity,
    "count_threshold": count_threshold,
    "persistence": persistence,
    "disappearance": disappearance,
    "caption_terms": caption_terms,
    "caption_flag": caption_flag,
    "semantic_probe": semantic_probe,
    "time_window": time_window,
}


def eval_rule(seg: VideoSegment, call: RuleCall, ctx: RuleContext) -> RuleResult:
    fn = PRIMITIVES.get(call.primitive)
    if not fn:
        return RuleResult(False, call.primitive, detail="unknown primitive")
    if call.primitive == "time_window":
        return time_window(seg, call.params or {}, ctx)
    try:
        return fn(seg, call.params or {}, ctx)
    except Exception as e:  # noqa: BLE001
        log.info("rule %s error: %s", call.primitive, type(e).__name__)
        return RuleResult(False, call.primitive, detail=f"error:{type(e).__name__}")


def eval_detector(
    seg: VideoSegment,
    all_of: list[RuleCall],
    any_of: list[RuleCall],
    ctx: RuleContext,
) -> tuple[float, list[Signal], bool]:
    """Return (rule_score, signals, gate_pass).

    Gate: all_of must all pass (if any); if all_of empty, any_of must pass at least one
    (or caption FLAG / strong probe handled by caller). Score: fraction of rule calls
    that passed, with all_of counting double (DOMAIN_PROFILES §1).
    """
    signals: list[Signal] = []
    weighted_pass = 0.0
    weighted_total = 0.0

    all_results = [eval_rule(seg, rc, ctx) for rc in all_of]
    any_results = [eval_rule(seg, rc, ctx) for rc in any_of]

    for r in all_results:
        signals.append(r.as_signal())
        weighted_total += 2.0
        if r.passed:
            weighted_pass += 2.0
    for r in any_results:
        signals.append(r.as_signal())
        weighted_total += 1.0
        if r.passed:
            weighted_pass += 1.0

    all_ok = all(r.passed for r in all_results) if all_results else True
    any_ok = any(r.passed for r in any_results) if any_results else False

    # Gate: if all_of fails → skip; if all_of empty and any_of empty → fail unless caller adds FLAG
    if all_of and not all_ok:
        gate = False
    elif all_of and all_ok:
        # all_of passed; prefer also any_of if present, but allow through if any_of empty
        gate = True if not any_of else any_ok
        # Warehouse cooccur alone is not enough — ARCHITECTURE: all_of fails AND no any_of → skip
        # If all_of ok and any_of present but none pass, still skip (require proximity evidence)
        if any_of and not any_ok:
            gate = False
    else:
        # no all_of
        gate = any_ok

    score = (weighted_pass / weighted_total) if weighted_total else 0.0
    return score, signals, gate


def looks_safe_interaction(caption: str) -> bool:
    """Heuristic for safe person+vehicle scenes that should stay negative."""
    low = (caption or "").lower()
    safe_cues = [
        "stationary",
        "walks away",
        "walking away",
        "moves further",
        "moving away",
        "remains stationary",
        "no hazards",
        "no spills",
        "no visible signs of spills",
        "observing or preparing",
        "maintaining a steady pace",
        "typical warehouse operation",
    ]
    risk_cues = [
        "near miss",
        "almost",
        "collision",
        "in the path",
        "in front of a moving",
        "rushing",
        "running toward",
        "swerve",
        "hard brak",
        "cut off",
    ]
    if any(r in low for r in risk_cues):
        return False
    return sum(1 for s in safe_cues if s in low) >= 2
