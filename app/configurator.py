"""Self-configuration: classify → plan → generate Cosmos prompt (ARCHITECTURE §6.1)."""

from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional, Type, TypeVar

from pydantic import BaseModel, ValidationError

import prompts
from gpu_client import GPUClient, get_gpu
from llm import LLM, get_llm, _extract_json_object
from models import (
    ClassifyLLMResponse,
    CosmosPrompt,
    CosmosPromptLLMResponse,
    DetectorSpec,
    DroppedObjective,
    EnvironmentClassification,
    EvidenceSignal,
    MonitoringObjective,
    MonitoringProfile,
    PipelineRun,
    PipelineStep,
    PlanLLMResponse,
    RuleCall,
    VideoSegment,
    VideoSource,
)
from repository import VideoRepository, get_repository
from store import Store, get_store

log = logging.getLogger("sightline.configurator")

T = TypeVar("T", bound=BaseModel)

DOMAINS_PATH = Path(__file__).resolve().parent / "domains.json"

# Person–vehicle objective ids that indoor smart-space should drop.
PERSON_VEHICLE_OBJECTIVE_IDS = {
    "worker_vehicle_proximity",
    "person_in_vehicle_path",
    "pedestrian_vehicle_proximity",
    "person_vehicle_proximity",
    "hard_braking",
    "lane_conflict",
    "stalled_vehicle",
    "unusual_vehicle_stop",
}

SAFE_DISTANCE_TERMS = (
    "stationary",
    "walks away",
    "walking away",
    "moves further",
    "moving away",
    "remains stationary",
    "no visible",
    "no spills",
    "no hazards",
)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def load_domains() -> dict[str, Any]:
    return json.loads(DOMAINS_PATH.read_text())


def vocabulary_names(domains: dict[str, Any] | None = None) -> set[str]:
    d = domains or load_domains()
    return {str(r["primitive"]) for r in d.get("rule_vocabulary") or []}


def available_vocabulary(domains: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """Rule vocab entries that are available (skip time_window — no capture wall-clock)."""
    d = domains or load_domains()
    out = []
    for r in d.get("rule_vocabulary") or []:
        if r.get("available") is False:
            continue
        out.append(r)
    return out


def aggregate_yolo(segments: list[VideoSegment]) -> dict[str, dict[str, int]]:
    """Return {class: {segments_with: n, max_count: m}} — never invent forklift."""
    hist: dict[str, dict[str, int]] = {}
    for seg in segments:
        classes = (seg.yolo.classes if seg.yolo else {}) or {}
        for label, count in classes.items():
            if label == "forklift":
                continue
            slot = hist.setdefault(label, {"segments_with": 0, "max_count": 0})
            slot["segments_with"] += 1
            slot["max_count"] = max(slot["max_count"], int(count))
    return hist


def _numbered_captions(segments: list[VideoSegment], limit: int = 12) -> str:
    lines = []
    for i, seg in enumerate(segments[:limit], 1):
        cap = (seg.caption or "").replace("\n", " ").strip()
        if len(cap) > 400:
            cap = cap[:397] + "..."
        lines.append(f"{i}. [{seg.t_start:.0f}-{seg.t_end:.0f}s] {cap}")
    return "\n".join(lines) if lines else "(no captions)"


async def _structured(
    llm: LLM,
    *,
    system: str,
    user: str,
    model: Type[T],
    fallback: Callable[[], T],
) -> T:
    """Fill-aware structured call (prompts use <<key>>; llm._render uses {key})."""
    try:
        raw = await llm.complete(user, system=system, json_object=True)
        data = _extract_json_object(raw)
        return model.model_validate(data)
    except (ValidationError, ValueError, json.JSONDecodeError) as first_err:
        log.info("configurator structured parse failed: %s", type(first_err).__name__)
        try:
            repair = (
                "Your previous reply was invalid. Return ONLY a JSON object matching the schema. "
                f"Error: {first_err}\n\nOriginal request:\n{user}"
            )
            raw2 = await llm.complete(repair, system=system, json_object=True)
            return model.model_validate(_extract_json_object(raw2))
        except Exception as e:  # noqa: BLE001
            log.warning("configurator structured fallback: %s", type(e).__name__)
            return fallback()
    except Exception as e:  # noqa: BLE001
        log.warning("configurator LLM error, fallback: %s", type(e).__name__)
        return fallback()


def rules_classify(
    *,
    source: VideoSource,
    segments: list[VideoSegment],
    yolo_hist: dict[str, dict[str, int]],
    domains: dict[str, Any] | None = None,
) -> EnvironmentClassification:
    """Deterministic domain scorer from domains.json cues (PROMPTS.md B.10 / §6.1)."""
    domains = domains or load_domains()
    captions = " ".join((s.caption or "").lower() for s in segments)
    cam = (source.camera_id or "").lower()
    loc = (source.location or "").lower()
    cap_type = (source.capture_type or "").lower()
    scores: dict[str, float] = {}
    evidence: list[EvidenceSignal] = []

    for domain_id, prior in (domains.get("domains") or {}).items():
        cues = prior.get("cues") or {}
        score = 0.0
        for kw in cues.get("caption_keywords") or []:
            if kw.lower() in captions:
                score += 1.5
        for yc in cues.get("yolo_classes") or []:
            if yc in yolo_hist:
                score += 1.0 + 0.1 * yolo_hist[yc]["segments_with"]
        hints = cues.get("metadata_hints") or {}
        for ct in hints.get("capture_type") or []:
            if ct.lower() in cap_type or ct.lower() in loc:
                score += 0.8
        for frag in hints.get("camera_id_contains") or []:
            if frag.lower() in cam:
                score += 1.2
        # Corpus camera exact match is a strong but not sole signal.
        if cam in [c.lower() for c in (prior.get("corpus_cameras") or [])]:
            score += 2.0
        # Explicit smartspace bias toward security (indoor crowds, not warehouse)
        if "smartspace" in cam and domain_id == "security":
            score += 4.0
        if "smartspace" in cam and domain_id == "warehouse":
            score -= 3.0
        scores[domain_id] = score

    if not scores or max(scores.values()) <= 0:
        domain = "general"
        conf = 0.4
    else:
        domain = max(scores, key=lambda k: scores[k])
        best = scores[domain]
        total = sum(scores.values()) or 1.0
        conf = min(0.95, 0.45 + 0.5 * (best / total) + min(0.2, best / 20.0))
        if conf < 0.6:
            domain = "general"

    # Evidence from captions / yolo / metadata
    if "forklift" in captions or "atlas" in captions:
        evidence.append(
            EvidenceSignal(
                signal="Captions mention forklift/ATLAS",
                source="caption",
                supports="warehouse industrial equipment",
            )
        )
    if "person" in yolo_hist:
        evidence.append(
            EvidenceSignal(
                signal=f"YOLO person in {yolo_hist['person']['segments_with']} sampled segments",
                source="yolo",
                supports="people present",
            )
        )
    if any(k in yolo_hist for k in ("car", "truck", "bus", "motorcycle")):
        evidence.append(
            EvidenceSignal(
                signal="YOLO road vehicles present",
                source="yolo",
                supports="traffic or street scene",
            )
        )
    if cap_type or cam:
        evidence.append(
            EvidenceSignal(
                signal=f"metadata camera_id={source.camera_id} capture_type={source.capture_type}",
                source="metadata",
                supports=domain,
            )
        )
    if not evidence:
        evidence.append(
            EvidenceSignal(signal="weak cues; general fallback", source="metadata", supports="general")
        )

    entities = list((domains.get("domains") or {}).get(domain, {}).get("entities") or ["person"])
    # Prefer concrete caption entities when warehouse.
    if domain == "warehouse" and "forklift" not in entities:
        entities = ["person", "forklift"] + [e for e in entities if e not in ("person", "forklift")]

    camera_type = "moving" if any(
        t in captions for t in ("dashcam", "ego", "from the vehicle", "windshield")
    ) else ("fixed" if domain in ("warehouse", "security", "retail") else "unknown")

    return EnvironmentClassification(
        domain=domain,  # type: ignore[arg-type]
        confidence=round(conf, 3),
        secondary_domain=None,
        description=f"rules_only: scored {domain} from caption/YOLO/metadata cues",
        camera_type=camera_type,  # type: ignore[arg-type]
        important_entities=entities[:6],
        evidence=evidence[:6],
        mode="rules_only",
    )


def validate_rule_call(call: RuleCall, vocab: set[str], domains: dict[str, Any]) -> RuleCall | None:
    """Drop unknown primitives and unavailable ones (time_window)."""
    if call.primitive not in vocab:
        return None
    # Skip time_window — domains.json marks available:false
    for entry in domains.get("rule_vocabulary") or []:
        if entry.get("primitive") == call.primitive and entry.get("available") is False:
            return None
    return call


def validate_objective(
    obj: MonitoringObjective, vocab: set[str], domains: dict[str, Any]
) -> MonitoringObjective | None:
    all_of: list[RuleCall] = []
    any_of: list[RuleCall] = []
    for rc in obj.detector.all_of or []:
        v = validate_rule_call(rc, vocab, domains)
        if v:
            all_of.append(v)
    for rc in obj.detector.any_of or []:
        v = validate_rule_call(rc, vocab, domains)
        if v:
            any_of.append(v)
    if not all_of and not any_of:
        return None
    det = DetectorSpec(
        all_of=all_of,
        any_of=any_of,
        merge_gap_segments=obj.detector.merge_gap_segments or 1,
    )
    return obj.model_copy(update={"detector": det})


def _prior_profile_fallback(
    source_id: str,
    classification: EnvironmentClassification,
    domains: dict[str, Any],
) -> MonitoringProfile:
    prior = (domains.get("domains") or {}).get(classification.domain) or (
        domains.get("domains") or {}
    ).get("general") or {}
    vocab = vocabulary_names(domains)
    objectives: list[MonitoringObjective] = []
    dropped: list[DroppedObjective] = []
    raw_objs = prior.get("objectives") or []
    for raw in raw_objs:
        try:
            obj = MonitoringObjective.model_validate(raw)
        except ValidationError:
            continue
        # Smart-space / indoor with no vehicles: drop person–vehicle objectives.
        if _should_drop_person_vehicle(source_id, classification, domains) and (
            obj.id in PERSON_VEHICLE_OBJECTIVE_IDS
            or "vehicle" in obj.id
            or "forklift" in (obj.name or "").lower()
            or "pedestrian" in (obj.name or "").lower()
        ):
            dropped.append(
                DroppedObjective(
                    id=obj.id,
                    name=obj.name,
                    reason="Camera shows no vehicles / person–vehicle risk not applicable",
                )
            )
            continue
        validated = validate_objective(obj, vocab, domains)
        if validated:
            objectives.append(validated)
    if not objectives:
        # Ensure at least notable_activity from general
        gen = (domains.get("domains") or {}).get("general") or {}
        for raw in gen.get("objectives") or []:
            try:
                obj = MonitoringObjective.model_validate(raw)
                v = validate_objective(obj, vocab, domains)
                if v and v.id not in PERSON_VEHICLE_OBJECTIVE_IDS:
                    objectives.append(v)
            except ValidationError:
                continue
            if len(objectives) >= 3:
                break
    objectives = objectives[:8]
    gaps = [
        "whether vehicles/forklifts are moving",
        "distance between people and vehicles",
        "FLAGS line not present until specialized re-ingest",
    ]
    return MonitoringProfile(
        source_id=source_id,
        domain=classification.domain,
        version=1,
        objectives=objectives,
        information_gaps=gaps,
        generated_prompt=None,
        severity_rules=domains.get("severity_rubric") or {},
        created_at=_now(),
        mode=classification.mode,
        dropped=dropped,
    )


def _should_drop_person_vehicle(
    source_id: str, classification: EnvironmentClassification, domains: dict[str, Any]
) -> bool:
    cam = (source_id or "").lower()
    if "smartspace" in cam:
        return True
    # Indoor security with no vehicle evidence
    if classification.domain in ("security", "retail", "sports"):
        ents = [e.lower() for e in classification.important_entities]
        has_vehicleish = any(
            e in ents
            for e in ("vehicle", "car", "truck", "forklift", "bus", "motorcycle", "agv")
        )
        desc = (classification.description or "").lower()
        if not has_vehicleish and not any(
            t in desc for t in ("street", "road", "crosswalk", "parking", "vehicle", "car")
        ):
            return True
        # Smart-space / indoor security: always drop classic person–vehicle road/warehouse objs
        if "indoor" in desc or "office" in desc or "crowd" in desc:
            return True
    return False


def _apply_dropped(
    profile: MonitoringProfile,
    classification: EnvironmentClassification,
    domains: dict[str, Any],
) -> MonitoringProfile:
    if not _should_drop_person_vehicle(profile.source_id, classification, domains):
        return profile
    kept: list[MonitoringObjective] = []
    dropped = list(profile.dropped or [])
    seen_drop = {d.id for d in dropped}
    for obj in profile.objectives:
        blob = f"{obj.id} {obj.name or ''} {obj.description or ''}"
        if obj.id in PERSON_VEHICLE_OBJECTIVE_IDS or re.search(
            r"vehicle|forklift|pedestrian|agv|pallet.?jack|hard.?brak|lane.?conflict|crosswalk|traffic",
            blob,
            re.I,
        ):
            if obj.id not in seen_drop:
                dropped.append(
                    DroppedObjective(
                        id=obj.id,
                        name=obj.name,
                        reason="Not applicable: indoor smart-space / no person–vehicle risk on this camera",
                    )
                )
                seen_drop.add(obj.id)
            continue
        kept.append(obj)
    if not kept:
        # Keep non-vehicle security-style objectives from prior
        prior = (domains.get("domains") or {}).get("security") or {}
        vocab = vocabulary_names(domains)
        for raw in prior.get("objectives") or []:
            try:
                obj = MonitoringObjective.model_validate(raw)
            except ValidationError:
                continue
            if obj.id in PERSON_VEHICLE_OBJECTIVE_IDS:
                continue
            v = validate_objective(obj, vocab, domains)
            if v:
                kept.append(v)
            if len(kept) >= 4:
                break
    return profile.model_copy(update={"objectives": kept[:8], "dropped": dropped})


def _information_gaps(
    objectives: list[MonitoringObjective], captions: str
) -> list[str]:
    gaps: list[str] = []
    low = captions.lower()
    if "moving" not in low and "motion" not in low:
        gaps.append("whether the forklift or vehicle is moving")
    if "distance" not in low and "meters" not in low and "feet" not in low:
        gaps.append("numeric distance between people and vehicles")
    if "flags:" not in low:
        gaps.append("structured FLAGS line for objective tags")
    if "near" not in low and "close" not in low and "beside" not in low:
        gaps.append("explicit proximity language between workers and forklifts")
    # Objective-specific
    for obj in objectives:
        if "path" in obj.id and "path" not in low and "crossing" not in low:
            gaps.append(f"facts for {obj.id}: travel-path crossing not described")
    return gaps[:6] or ["specialized proximity and motion details missing from generic captions"]


class Configurator:
    def __init__(
        self,
        repo: VideoRepository | None = None,
        llm: LLM | None = None,
        gpu: GPUClient | None = None,
        store: Store | None = None,
    ):
        self.repo = repo or get_repository()
        self.llm = llm or get_llm()
        self.gpu = gpu or get_gpu()
        self.store = store or get_store()
        self.domains = load_domains()

    def _pipeline_get(self, source_id: str) -> PipelineRun:
        raw = self.store.get_pipeline(source_id)
        if raw:
            try:
                return PipelineRun.model_validate(raw)
            except ValidationError:
                pass
        return PipelineRun(source_id=source_id, steps=[])

    def _pipeline_set(self, run: PipelineRun) -> None:
        self.store.put("pipeline", run.source_id, run, source_id=run.source_id)

    def _step_start(self, source_id: str, key: str, label: str | None = None) -> PipelineRun:
        run = self._pipeline_get(source_id)
        # Replace existing step with same key or append
        steps = [s for s in run.steps if s.key != key]
        steps.append(
            PipelineStep(
                key=key,
                label=label,
                status="running",
                summary="",
                started_at=_now(),
            )
        )
        run = PipelineRun(source_id=source_id, steps=steps)
        self._pipeline_set(run)
        return run

    def _step_end(
        self,
        source_id: str,
        key: str,
        *,
        status: str = "done",
        summary: str = "",
    ) -> None:
        run = self._pipeline_get(source_id)
        steps = []
        for s in run.steps:
            if s.key == key:
                steps.append(
                    s.model_copy(
                        update={
                            "status": status,
                            "summary": summary,
                            "ended_at": _now(),
                        }
                    )
                )
            else:
                steps.append(s)
        self._pipeline_set(PipelineRun(source_id=source_id, steps=steps))

    async def classify(self, source_id: str) -> EnvironmentClassification:
        self._step_start(source_id, "classify", "Scene classified")
        src = await self.repo.get_source(source_id)
        if not src:
            self._step_end(source_id, "classify", status="failed", summary="source not found")
            raise ValueError(f"source not found: {source_id}")

        sample = await self.repo.sample_segments(source_id, n=12, with_detections=False)
        yolo_hist = aggregate_yolo(sample)
        visual_look = ""
        try:
            # Optional Cosmos env look on one caption as text-only (skip heavy video on timeout)
            preview_cap = (sample[0].caption if sample else "")[:500]
            if preview_cap:
                visual_look = await self.gpu.cosmos_chat(
                    [
                        {"role": "user", "content": prompts.COSMOS_ENV_LOOK + "\n\nCaption context:\n" + preview_cap}
                    ],
                    max_tokens=256,
                )
                visual_look = (visual_look or "")[:800]
        except Exception as e:  # noqa: BLE001
            log.info("cosmos env look skipped: %s", type(e).__name__)
            visual_look = ""

        def _fallback() -> ClassifyLLMResponse:
            rc = rules_classify(
                source=src, segments=sample, yolo_hist=yolo_hist, domains=self.domains
            )
            return ClassifyLLMResponse(
                domain=rc.domain,
                confidence=rc.confidence,
                secondary_domain=rc.secondary_domain,
                description=rc.description,
                camera_type=rc.camera_type,
                important_entities=rc.important_entities,
                evidence=rc.evidence,
            )

        user = prompts.fill(
            prompts.CLASSIFY_USER,
            camera_id=src.camera_id,
            location=src.location,
            capture_type=src.capture_type,
            yolo_hist=json.dumps(yolo_hist),
            n=str(len(sample)),
            total=str(src.segment_count),
            numbered_captions=_numbered_captions(sample),
            visual_look=visual_look or "(skipped)",
        )
        raw = await _structured(
            self.llm,
            system=prompts.CLASSIFY_SYSTEM,
            user=user,
            model=ClassifyLLMResponse,
            fallback=_fallback,
        )
        # Prefer rules_only marker when LLM fell back path set description
        mode = "rules_only" if raw.description.startswith("rules_only:") else "llm"
        # If LLM returned nonsense domain for warehouse camera, prefer rules
        rules = rules_classify(
            source=src, segments=sample, yolo_hist=yolo_hist, domains=self.domains
        )
        domain = raw.domain
        conf = float(raw.confidence)
        cam_l = (src.camera_id or "").lower()
        if cam_l.startswith("sdg_warehouse") and domain != "warehouse" and rules.domain == "warehouse":
            domain = "warehouse"
            conf = max(conf, rules.confidence)
            mode = "llm" if mode == "llm" else "rules_only"
        # Smart-space cams are indoor facility/security — never warehouse/traffic even if LLM confuses AGVs
        if "smartspace" in cam_l and domain in ("warehouse", "traffic", "sports"):
            domain = "security"
            conf = max(0.75, conf)
            raw = raw.model_copy(
                update={
                    "description": (raw.description or "")
                    + " (corrected: smartspace → security; person–vehicle objectives not applicable)",
                    "important_entities": ["person", "bag"]
                    + [e for e in (raw.important_entities or []) if e.lower() not in ("forklift", "vehicle", "car", "truck")],
                }
            )
        if conf < 0.6:
            domain = "general"

        classification = EnvironmentClassification(
            domain=domain,  # type: ignore[arg-type]
            confidence=round(min(1.0, max(0.0, conf)), 3),
            secondary_domain=raw.secondary_domain,
            description=raw.description or rules.description,
            camera_type=raw.camera_type or rules.camera_type,
            important_entities=(raw.important_entities or rules.important_entities)[:6],
            evidence=(raw.evidence or rules.evidence)[:6],
            mode=mode,  # type: ignore[arg-type]
        )
        # Ensure warehouse entities mention forklift (caption-driven, not YOLO)
        if classification.domain == "warehouse":
            ents = list(classification.important_entities)
            if "forklift" not in [e.lower() for e in ents]:
                ents = (["person", "forklift"] + [e for e in ents if e.lower() not in ("person", "forklift")])[:6]
                classification = classification.model_copy(update={"important_entities": ents})

        self.store.put("classification", source_id, classification, source_id=source_id)
        self._step_end(
            source_id,
            "classify",
            summary=f"{classification.domain} · {int(classification.confidence * 100)}% · {classification.mode}",
        )
        return classification

    async def plan(
        self, source_id: str, classification: EnvironmentClassification | None = None
    ) -> MonitoringProfile:
        self._step_start(source_id, "plan", "Plan generated")
        classification = classification or EnvironmentClassification.model_validate(
            self.store.get_classification(source_id) or {}
        )
        sample = await self.repo.sample_segments(source_id, n=12)
        yolo_hist = aggregate_yolo(sample)
        prior = (self.domains.get("domains") or {}).get(classification.domain) or (
            self.domains.get("domains") or {}
        ).get("general")
        vocab_list = available_vocabulary(self.domains)
        vocab_names = {str(v["primitive"]) for v in vocab_list}

        def _fallback() -> PlanLLMResponse:
            pf = _prior_profile_fallback(source_id, classification, self.domains)
            return PlanLLMResponse(
                domain=pf.domain,
                objectives=pf.objectives,
                information_gaps=pf.information_gaps,
            )

        user = prompts.fill(
            prompts.PLAN_USER,
            classification_json=classification.model_dump_json(),
            domain_prior_json=json.dumps(prior),
            rule_vocabulary_json=json.dumps(vocab_list),
            yolo_classes=json.dumps(list(yolo_hist.keys())),
            numbered_captions=_numbered_captions(sample),
        )
        raw = await _structured(
            self.llm,
            system=prompts.PLAN_SYSTEM,
            user=user,
            model=PlanLLMResponse,
            fallback=_fallback,
        )
        objectives: list[MonitoringObjective] = []
        for obj in raw.objectives or []:
            v = validate_objective(obj, vocab_names, self.domains)
            if v:
                objectives.append(v)
        if len(objectives) < 3:
            fb = _prior_profile_fallback(source_id, classification, self.domains)
            have = {o.id for o in objectives}
            for o in fb.objectives:
                if o.id not in have:
                    objectives.append(o)
                if len(objectives) >= 3:
                    break
        objectives = objectives[:8]
        captions_blob = " ".join(s.caption or "" for s in sample)
        gaps = list(raw.information_gaps or []) or _information_gaps(objectives, captions_blob)
        profile = MonitoringProfile(
            source_id=source_id,
            domain=classification.domain,
            version=1,
            objectives=objectives,
            information_gaps=gaps,
            generated_prompt=None,
            severity_rules=self.domains.get("severity_rubric") or {},
            created_at=_now(),
            mode=classification.mode,
            dropped=[],
        )
        profile = _apply_dropped(profile, classification, self.domains)
        self.store.put("profile", source_id, profile, source_id=source_id)
        drop_n = len(profile.dropped or [])
        self._step_end(
            source_id,
            "plan",
            summary=f"{len(profile.objectives)} objectives"
            + (f" · {drop_n} dropped" if drop_n else ""),
        )
        return profile

    async def generate_prompt(
        self, source_id: str, profile: MonitoringProfile | None = None
    ) -> CosmosPrompt:
        self._step_start(source_id, "prompt", "Prompt generated")
        if profile is None:
            raw_p = self.store.get_profile(source_id)
            profile = MonitoringProfile.model_validate(raw_p) if raw_p else None
        if profile is None:
            self._step_end(source_id, "prompt", status="failed", summary="no profile")
            raise ValueError("no profile")

        sample = await self.repo.sample_segments(source_id, n=3)
        three = _numbered_captions(sample, limit=3)
        few = prompts.few_shot_for(profile.domain)
        max_chars = prompts.CUSTOM_PROMPT_MAX_CHARS

        def _template_prompt() -> CosmosPrompt:
            # Built from this camera's own objectives: a domain template can miss them entirely
            # (e.g. a pool classified as "sports" would get the basketball template).
            objs = [(o.name, o.id) for o in profile.objectives]
            if objs:
                text = prompts.objective_prompt(profile.domain, objs, max_chars)
                rationale = "assembled from the plan's objectives (LLM prompt unavailable or too long)"
            else:
                text = prompts.short_template(profile.domain)
                if len(text) > max_chars:
                    text = prompts.ULTRA_SHORT_TEMPLATES.get(profile.domain) or text[: max_chars - 1]
                rationale = "SHORT_TEMPLATES fallback"
            return CosmosPrompt(
                text=text,
                chars=len(text),
                covers=[o.id for o in profile.objectives],
                rationale=rationale,
                template_fallback=True,
            )

        def _fallback() -> CosmosPromptLLMResponse:
            tp = _template_prompt()
            return CosmosPromptLLMResponse(text=tp.text, covers=tp.covers, rationale=tp.rationale)

        slim_profile = {
            "domain": profile.domain,
            "objectives": [
                {"id": o.id, "name": o.name, "severity": o.severity, "description": o.description}
                for o in profile.objectives
            ],
            "information_gaps": profile.information_gaps,
        }
        # <<3_captions>> is not a valid kwarg name — rewrite placeholder first
        user = prompts.fill(
            prompts.COSMOS_PROMPT_USER.replace("<<3_captions>>", "<<three_captions>>"),
            profile_json=json.dumps(slim_profile),
            information_gaps=json.dumps(profile.information_gaps),
            three_captions=three,
            few_shot_prompt_other_domain=few,
        )

        raw = await _structured(
            self.llm,
            system=prompts.COSMOS_PROMPT_SYSTEM,
            user=user,
            model=CosmosPromptLLMResponse,
            fallback=_fallback,
        )
        text = (raw.text or "").strip()
        template_fallback = False
        if len(text) > max_chars:
            # One shorten retry
            shorten_user = (
                prompts.SHORTEN_PROMPT_USER
                + "\n\nCurrent JSON:\n"
                + json.dumps({"text": text, "covers": raw.covers, "rationale": raw.rationale})
            )
            try:
                shortened = await _structured(
                    self.llm,
                    system=prompts.COSMOS_PROMPT_SYSTEM,
                    user=shorten_user,
                    model=CosmosPromptLLMResponse,
                    fallback=_fallback,
                )
                text = (shortened.text or text).strip()
                raw = shortened
            except Exception:  # noqa: BLE001
                pass
        if len(text) > max_chars or not text:
            tp = _template_prompt()
            text = tp.text
            template_fallback = True
            covers = tp.covers
            rationale = tp.rationale
        else:
            covers = raw.covers or [o.id for o in profile.objectives]
            rationale = raw.rationale or ""

        # Ensure FLAGS mention objective ids when LLM omitted them
        if "FLAGS:" not in text.upper() and not template_fallback:
            flag_ids = ", ".join(covers[:6]) or "none"
            suffix = f" FLAGS: list any of {flag_ids}, or none."
            if len(text) + len(suffix) <= max_chars:
                text = text.rstrip() + suffix

        if len(text) > max_chars:
            tp = _template_prompt()
            text = tp.text
            template_fallback = True
            covers = tp.covers
            rationale = tp.rationale

        cosmos = CosmosPrompt(
            text=text,
            chars=len(text),
            covers=covers,
            rationale=rationale,
            template_fallback=template_fallback,
        )
        profile = profile.model_copy(update={"generated_prompt": cosmos})
        self.store.put("profile", source_id, profile, source_id=source_id)
        self._step_end(
            source_id,
            "prompt",
            summary=f"{cosmos.chars}/800"
            + (" · template" if cosmos.template_fallback else ""),
        )
        return cosmos

    async def configure(self, source_id: str) -> dict[str, Any]:
        """Full classify → plan → prompt. Returns contract-compatible payload."""
        self.store.set_source_status(source_id, "configuring")
        # Reset pipeline for a fresh run
        self._pipeline_set(PipelineRun(source_id=source_id, steps=[]))
        classification = await self.classify(source_id)
        profile = await self.plan(source_id, classification)
        prompt = await self.generate_prompt(source_id, profile)
        profile = MonitoringProfile.model_validate(self.store.get_profile(source_id))
        self.store.set_source_status(source_id, "configured")
        return {
            "source_id": source_id,
            "classification": classification.model_dump(),
            "profile": profile.model_dump(),
            "prompt": prompt.model_dump(),
        }


_configurator: Configurator | None = None


def get_configurator() -> Configurator:
    global _configurator
    if _configurator is None:
        _configurator = Configurator()
    return _configurator
