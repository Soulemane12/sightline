"""Sightline v1 data contracts (frozen at G1).

Normalized app models. VSS wire fields differ (see from_vss_* helpers and
planning/HACKATHON_UNKNOWN.md). Additive-only changes after freeze — Architect only.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

# ---------------------------------------------------------------------------
# Enums / literals
# ---------------------------------------------------------------------------

Domain = Literal["security", "warehouse", "retail", "sports", "traffic", "general"]
CameraType = Literal["fixed", "moving", "unknown"]
Severity = Literal["critical", "high", "medium", "low"]
SourceStatus = Literal[
    "unconfigured", "configuring", "configured", "specializing", "monitoring"
]
EventStatus = Literal["candidate", "rejected", "investigating", "incident"]
Verdict = Literal["confirmed", "likely", "unclear", "false_positive"]
EvidenceRole = Literal["before", "event", "after", "related", "angle"]  # angle: same scenario, other camera view
SignalKind = Literal[
    "rule", "caption_flag", "semantic", "llm", "temporal", "second_look"
]
PipelineStepStatus = Literal["pending", "running", "done", "failed", "skipped"]
ReingestStatus = Literal[
    "planned",
    "preparing",
    "reingesting",
    "indexing",
    "verifying",
    "ready",
    "failed",
]
ClassifyMode = Literal["llm", "rules_only"]
DataOrigin = Literal["vastdb", "seed", "memory"]
StateBackend = Literal["vastdb", "local"]
JobStatus = Literal["running", "done", "failed"]

FLAGS_RE = re.compile(r"FLAGS:\s*(.+)", re.IGNORECASE)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def parse_flags(caption: str | None) -> list[str]:
    """Extract FLAG tokens from a Cosmos caption's FLAGS: line."""
    if not caption:
        return []
    m = FLAGS_RE.search(caption)
    if not m:
        return []
    raw = m.group(1).strip()
    if not raw or raw.lower() == "none":
        return []
    return [p.strip() for p in re.split(r"[,;]", raw) if p.strip() and p.strip().lower() != "none"]


def _parse_object_counts(raw: Any) -> dict[str, int]:
    if raw is None:
        return {}
    if isinstance(raw, dict):
        return {str(k): int(v) for k, v in raw.items()}
    if isinstance(raw, str):
        s = raw.strip()
        if not s:
            return {}
        try:
            data = json.loads(s)
            if isinstance(data, dict):
                return {str(k): int(v) for k, v in data.items()}
        except json.JSONDecodeError:
            return {}
    return {}


def _parse_object_classes(raw: Any) -> list[str]:
    if raw is None:
        return []
    if isinstance(raw, list):
        return [str(x) for x in raw]
    if isinstance(raw, str):
        s = raw.strip()
        if not s:
            return []
        if s.startswith("["):
            try:
                data = json.loads(s)
                if isinstance(data, list):
                    return [str(x) for x in data]
            except json.JSONDecodeError:
                pass
        return [p.strip() for p in s.split(",") if p.strip()]
    return []


# ---------------------------------------------------------------------------
# Perception / video
# ---------------------------------------------------------------------------


class BBoxPair(BaseModel):
    model_config = ConfigDict(extra="ignore")

    a: str
    b: str
    min_gap_norm: float
    frames_close: int = 0


class DetectionSummary(BaseModel):
    """Normalized YOLO summary for a segment (app-facing)."""

    model_config = ConfigDict(extra="ignore")

    classes: dict[str, int] = Field(default_factory=dict)
    frames_sampled: int = 0
    has_sidecar: bool = False
    pairs: list[BBoxPair] = Field(default_factory=list)


class VideoRef(BaseModel):
    model_config = ConfigDict(extra="ignore")

    original_video: str
    filename: str = ""
    stream_id: Optional[str] = None
    total_segments: int = 0
    preview_source: Optional[str] = None
    uploaded_at: Optional[str] = None
    chunk_duration_sec: Optional[float] = None


class VideoSource(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str
    camera_id: str
    location: str = ""
    capture_type: str = ""
    label: str = ""
    videos: list[VideoRef] = Field(default_factory=list)
    segment_count: int = 0
    domain_hint_from_metadata: Optional[str] = None
    status: SourceStatus = "unconfigured"


class VideoSegment(BaseModel):
    """Normalized segment. Times are seconds within the parent video."""

    model_config = ConfigDict(extra="ignore")

    source_uri: str
    original_video: str
    index: int = Field(description="1-based segment_number")
    t_start: float = 0.0
    t_end: float = 0.0
    caption: str = ""
    flags: list[str] = Field(default_factory=list)
    yolo: Optional[DetectionSummary] = None
    camera_id: str = ""
    location: str = ""
    filename: str = ""
    duration: float = 0.0
    upload_timestamp: Optional[str] = None
    object_classes: list[str] = Field(default_factory=list)

    @classmethod
    def from_vss_segment(cls, row: dict[str, Any]) -> "VideoSegment":
        """Map a VSS tools/segments or videos/metadata row → VideoSegment.

        Wire fields (fixtures 2026-10-09):
          source, original_video, segment_number, segment_start_sec,
          segment_end_sec, reasoning_content, object_classes, object_counts,
          camera_id, location, filename, duration, upload_timestamp,
          detection_sidecar_uri, detection_frame_count
        """
        caption = row.get("reasoning_content") or row.get("caption") or ""
        counts = _parse_object_counts(row.get("object_counts"))
        classes = _parse_object_classes(row.get("object_classes"))
        if not counts and classes:
            counts = {c: 1 for c in classes}
        has_sidecar = bool(row.get("detection_sidecar_uri"))
        frames = int(row.get("detection_frame_count") or 0)
        yolo = DetectionSummary(
            classes=counts,
            frames_sampled=frames,
            has_sidecar=has_sidecar,
        )
        t_start = float(row.get("segment_start_sec") if row.get("segment_start_sec") is not None else row.get("t_start") or 0.0)
        t_end = float(row.get("segment_end_sec") if row.get("segment_end_sec") is not None else row.get("t_end") or 0.0)
        dur = float(row.get("duration") or (t_end - t_start) or 0.0)
        return cls(
            source_uri=str(row.get("source") or row.get("source_uri") or ""),
            original_video=str(row.get("original_video") or ""),
            index=int(row.get("segment_number") or row.get("index") or 0),
            t_start=t_start,
            t_end=t_end,
            caption=str(caption),
            flags=parse_flags(str(caption)),
            yolo=yolo,
            camera_id=str(row.get("camera_id") or ""),
            location=str(row.get("location") or ""),
            filename=str(row.get("filename") or ""),
            duration=dur,
            upload_timestamp=row.get("upload_timestamp"),
            object_classes=classes,
        )


class VideoSourceListItem(BaseModel):
    """GET api/sources list row (ARCHITECTURE §5a)."""

    model_config = ConfigDict(extra="ignore")

    id: str
    camera_id: str
    label: str = ""
    location: str = ""
    capture_type: str = ""
    segment_count: int = 0
    status: SourceStatus = "unconfigured"
    classification: Optional[dict[str, Any]] = None
    profile_summary: Optional[dict[str, Any]] = None
    incident_counts: dict[str, int] = Field(
        default_factory=lambda: {"critical": 0, "high": 0, "medium": 0, "low": 0}
    )
    replay: Optional[dict[str, Any]] = None
    segment_seconds: Optional[float] = 5.0
    reingest_status: Optional[str] = None


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------


class EvidenceSignal(BaseModel):
    model_config = ConfigDict(extra="ignore")

    signal: str
    source: Literal["caption", "yolo", "metadata", "visual"]
    supports: str = ""


class EnvironmentClassification(BaseModel):
    model_config = ConfigDict(extra="ignore")

    domain: Domain
    confidence: float = Field(ge=0.0, le=1.0)
    secondary_domain: Optional[str] = None
    description: str = ""
    camera_type: CameraType = "unknown"
    important_entities: list[str] = Field(default_factory=list)
    evidence: list[EvidenceSignal] = Field(default_factory=list)
    mode: ClassifyMode = "llm"


class RuleCall(BaseModel):
    model_config = ConfigDict(extra="ignore")

    primitive: str
    params: dict[str, Any] = Field(default_factory=dict)


class DetectorSpec(BaseModel):
    model_config = ConfigDict(extra="ignore")

    all_of: list[RuleCall] = Field(default_factory=list)
    any_of: list[RuleCall] = Field(default_factory=list)
    merge_gap_segments: int = 1


class ObjectiveWording(BaseModel):
    model_config = ConfigDict(extra="ignore")

    title: str = ""
    review_action: str = ""


class MonitoringObjective(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str
    name: str
    description: str = ""
    severity: Severity = "medium"
    rationale: str = ""
    detector: DetectorSpec = Field(default_factory=DetectorSpec)
    semantic_probes: list[str] = Field(default_factory=list)
    investigation_questions: list[str] = Field(default_factory=list)
    wording: ObjectiveWording = Field(default_factory=ObjectiveWording)


class DroppedObjective(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str
    name: str
    reason: str


class CosmosPrompt(BaseModel):
    model_config = ConfigDict(extra="ignore")

    text: str
    chars: int = 0
    covers: list[str] = Field(default_factory=list)
    rationale: str = ""
    template_fallback: bool = False

    @model_validator(mode="after")
    def _set_chars(self) -> "CosmosPrompt":
        if not self.chars:
            self.chars = len(self.text or "")
        return self


class MonitoringProfile(BaseModel):
    model_config = ConfigDict(extra="ignore")

    source_id: str
    domain: Domain
    version: int = 1
    objectives: list[MonitoringObjective] = Field(default_factory=list)
    information_gaps: list[str] = Field(default_factory=list)
    generated_prompt: Optional[CosmosPrompt] = None
    severity_rules: dict[str, Any] = Field(default_factory=dict)
    created_at: str = Field(default_factory=_now_iso)
    mode: ClassifyMode = "llm"
    dropped: list[DroppedObjective] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Events / investigation / incidents
# ---------------------------------------------------------------------------


class Signal(BaseModel):
    model_config = ConfigDict(extra="ignore")

    kind: SignalKind
    name: str
    value: Any = None
    detail: str = ""


class LlmEval(BaseModel):
    model_config = ConfigDict(extra="ignore")

    is_event: bool
    confidence: float = 0.0
    reason: str = ""
    evidence_quote: str = ""


class PotentialEvent(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str
    source_id: str
    objective_id: str
    segment: str
    signals: list[Signal] = Field(default_factory=list)
    rule_score: float = 0.0
    llm: Optional[LlmEval] = None
    status: EventStatus = "candidate"
    t_start: Optional[float] = None
    t_end: Optional[float] = None
    start_segment: Optional[str] = None
    peak_segment: Optional[str] = None
    end_segment: Optional[str] = None


class Evidence(BaseModel):
    model_config = ConfigDict(extra="ignore")

    role: EvidenceRole
    segment: str
    t_start: float = 0.0
    t_end: float = 0.0
    caption: str = ""
    yolo: Optional[DetectionSummary] = None
    clip_url: str = ""
    camera_id: Optional[str] = None
    similarity: Optional[float] = None
    camera_view: Optional[str] = None  # e.g. "ceiling_01" for role="angle" (SDG run_N_seed_M multi-view)


class ConfidenceComponent(BaseModel):
    model_config = ConfigDict(extra="ignore")

    name: str
    value: float
    weight: float
    explanation: str = ""


class Confidence(BaseModel):
    model_config = ConfigDict(extra="ignore")

    value: float = Field(ge=0.0, le=1.0)
    components: list[ConfidenceComponent] = Field(default_factory=list)


class TimelineItem(BaseModel):
    model_config = ConfigDict(extra="ignore")

    t: float
    text: str
    segment: str


class InvestigationAnswer(BaseModel):
    model_config = ConfigDict(extra="ignore")

    question: str
    answer: str


class SecondLook(BaseModel):
    model_config = ConfigDict(extra="ignore")

    verdict: str
    text: str = ""


class Investigation(BaseModel):
    model_config = ConfigDict(extra="ignore")

    event_id: str = ""
    verdict: Verdict
    timeline: list[TimelineItem] = Field(default_factory=list)
    start_segment: str = ""
    peak_segment: str = ""
    end_segment: str = ""
    entities: list[str] = Field(default_factory=list)
    why_flagged: str = ""
    counter_evidence: str = ""
    related: list[Evidence] = Field(default_factory=list)
    second_look: Optional[SecondLook] = None
    confidence: Optional[Confidence] = None
    answers: list[InvestigationAnswer] = Field(default_factory=list)
    temporal_support: Optional[float] = None
    event_type: Optional[str] = None
    title: Optional[str] = None
    summary: Optional[str] = None
    recommended_action: Optional[str] = None


class Incident(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str
    source_id: str
    domain: Domain | str
    objective_id: str
    event_type: str = ""
    title: str
    severity: Severity
    confidence: Confidence
    summary: str = ""
    started_at: float = 0.0
    peak_at: float = 0.0
    ended_at: float = 0.0
    camera_id: str = ""
    location: str = ""
    entities: list[str] = Field(default_factory=list)
    evidence: list[Evidence] = Field(default_factory=list)
    investigation: Optional[Investigation] = None
    recommended_action: str = ""
    created_at: str = Field(default_factory=_now_iso)
    search_hint: Optional[str] = None
    replay_pos: Optional[float] = None
    mode: Optional[ClassifyMode] = None


# ---------------------------------------------------------------------------
# Re-ingest / evolution / pipeline
# ---------------------------------------------------------------------------


class CaptionSnapshot(BaseModel):
    model_config = ConfigDict(extra="ignore")

    segment: str
    caption: str


class ReingestProgress(BaseModel):
    model_config = ConfigDict(extra="ignore")

    completed_chunks: int = 0
    total_chunks: int = 0
    indexed_segments: int = 0
    total_segments: int = 0


class ReingestVerify(BaseModel):
    model_config = ConfigDict(extra="ignore")

    changed: int = 0
    total: int = 0
    with_terms: int = 0


class ReingestJob(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str
    source_id: str
    original_video: str
    chunk_count: int = 1
    clips: int = 0
    prompt: Optional[CosmosPrompt] = None
    vss_job_id: Optional[str] = None
    status: ReingestStatus = "planned"
    progress: ReingestProgress = Field(default_factory=ReingestProgress)
    snapshot_before: list[CaptionSnapshot] = Field(default_factory=list)
    after: list[CaptionSnapshot] = Field(default_factory=list)
    error: Optional[str] = None
    timestamps: dict[str, str] = Field(default_factory=dict)
    # §5a extras consumed by the UI
    filename: Optional[str] = None
    eta: Optional[str] = None
    reason: Optional[str] = None
    started_at: Optional[str] = None
    finished_at: Optional[str] = None
    failed_stage: Optional[str] = None
    verify: Optional[ReingestVerify] = None


class EvolutionStep(BaseModel):
    model_config = ConfigDict(extra="ignore")

    stage: Literal["generic", "objective", "prompt", "reanalyzed", "event"]
    text: str
    ref: Optional[str] = None


class AnalysisEvolution(BaseModel):
    model_config = ConfigDict(extra="ignore")

    source_id: str
    steps: list[EvolutionStep] = Field(default_factory=list)


class PipelineStep(BaseModel):
    model_config = ConfigDict(extra="ignore")

    key: str
    label: Optional[str] = None
    status: PipelineStepStatus = "pending"
    summary: str = ""
    started_at: Optional[str] = None
    ended_at: Optional[str] = None
    trace_url: Optional[str] = None


class PipelineRun(BaseModel):
    model_config = ConfigDict(extra="ignore")

    source_id: str
    steps: list[PipelineStep] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Jobs / status / patterns / live (API surface)
# ---------------------------------------------------------------------------


class JobResult(BaseModel):
    model_config = ConfigDict(extra="ignore")

    status: JobStatus
    result: Optional[Any] = None
    error: Optional[str] = None


class ComponentHealth(BaseModel):
    model_config = ConfigDict(extra="ignore")

    ok: bool
    detail: Optional[str] = None


class GpuHealth(BaseModel):
    model_config = ConfigDict(extra="ignore")

    cosmos: ComponentHealth = Field(default_factory=lambda: ComponentHealth(ok=False))
    yolo: ComponentHealth = Field(default_factory=lambda: ComponentHealth(ok=False))
    embed: ComponentHealth = Field(default_factory=lambda: ComponentHealth(ok=False))
    canary: ComponentHealth = Field(default_factory=lambda: ComponentHealth(ok=False))


class LlmHealth(BaseModel):
    model_config = ConfigDict(extra="ignore")

    ok: bool = False
    model: str = ""
    mode: ClassifyMode = "llm"


class StateHealth(BaseModel):
    model_config = ConfigDict(extra="ignore")

    backend: StateBackend = "local"
    data_origin: DataOrigin = "memory"
    snapshot_at: Optional[str] = None


class FeatureFlags(BaseModel):
    model_config = ConfigDict(extra="ignore")

    live: bool = False
    upload: bool = False
    weave: bool = False
    sports: bool = False


class StatusResponse(BaseModel):
    """GET api/status (§5a)."""

    model_config = ConfigDict(extra="ignore")

    vss: ComponentHealth = Field(default_factory=lambda: ComponentHealth(ok=False))
    gpu: GpuHealth = Field(default_factory=GpuHealth)
    llm: LlmHealth = Field(default_factory=LlmHealth)
    state: StateHealth = Field(default_factory=StateHealth)
    flags: FeatureFlags = Field(default_factory=FeatureFlags)
    replay: dict[str, Any] = Field(default_factory=lambda: {"speed": 6})
    limits: dict[str, Any] = Field(default_factory=lambda: {"upload_mb": 100})
    stats: Optional[dict[str, int]] = None


class PatternHit(BaseModel):
    model_config = ConfigDict(extra="ignore")

    statement: str
    count: int = 0
    evidence: list[Evidence] = Field(default_factory=list)
    incident_ids: list[str] = Field(default_factory=list)
    why_it_matters: str = ""
    suggested_action: str = ""


# ---------------------------------------------------------------------------
# LLM structured I/O helpers (planner / evaluator shapes)
# ---------------------------------------------------------------------------


class ClassifyLLMResponse(BaseModel):
    """Raw CLASSIFY JSON before EnvironmentClassification.mode is set."""

    model_config = ConfigDict(extra="ignore")

    domain: Domain
    confidence: float
    secondary_domain: Optional[str] = None
    description: str = ""
    camera_type: CameraType = "unknown"
    important_entities: list[str] = Field(default_factory=list)
    evidence: list[EvidenceSignal] = Field(default_factory=list)


class PlanLLMResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")

    domain: Domain | str
    objectives: list[MonitoringObjective] = Field(default_factory=list)
    information_gaps: list[str] = Field(default_factory=list)


class CosmosPromptLLMResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")

    text: str
    covers: list[str] = Field(default_factory=list)
    rationale: str = ""


class EvaluateResultItem(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str
    is_event: bool
    confidence: float = 0.0
    reason: str = ""
    evidence_quote: str = ""


class EvaluateLLMResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")

    results: list[EvaluateResultItem] = Field(default_factory=list)


class InvestigateLLMResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")

    verdict: Verdict
    event_type: str = ""
    title: str = ""
    summary: str = ""
    timeline: list[TimelineItem] = Field(default_factory=list)
    start_segment: str = ""
    peak_segment: str = ""
    end_segment: str = ""
    entities: list[str] = Field(default_factory=list)
    why_flagged: str = ""
    counter_evidence: str = ""
    temporal_support: float = 0.0
    answers: list[InvestigationAnswer] = Field(default_factory=list)
    recommended_action: str = ""


class PatternsLLMResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")

    patterns: list[PatternHit] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Safety report
# ---------------------------------------------------------------------------


class ReportFilter(BaseModel):
    """Which incidents a report covers. since/until bound when Sightline raised the incident."""

    model_config = ConfigDict(extra="ignore")

    source_ids: list[str] = Field(default_factory=list)
    since: Optional[str] = None
    until: Optional[str] = None
    min_severity: Severity = "low"


class ReportFinding(BaseModel):
    model_config = ConfigDict(extra="ignore")

    statement: str
    incident_ids: list[str] = Field(default_factory=list)
    why_it_matters: str = ""


class ReportRecommendation(BaseModel):
    model_config = ConfigDict(extra="ignore")

    action: str
    incident_ids: list[str] = Field(default_factory=list)


class ReportStats(BaseModel):
    model_config = ConfigDict(extra="ignore")

    total: int = 0
    by_severity: dict[str, int] = Field(default_factory=dict)
    by_camera: dict[str, int] = Field(default_factory=dict)
    by_event_type: dict[str, int] = Field(default_factory=dict)
    first_at: Optional[str] = None
    last_at: Optional[str] = None


class ReportNarrative(BaseModel):
    """REPORT LLM shape (and the rules-only fallback)."""

    model_config = ConfigDict(extra="ignore")

    summary: str = ""
    findings: list[ReportFinding] = Field(default_factory=list)
    recommendations: list[ReportRecommendation] = Field(default_factory=list)


class SafetyReport(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str
    filter: ReportFilter
    generated_at: str = Field(default_factory=_now_iso)
    title: str = ""
    stats: ReportStats = Field(default_factory=ReportStats)
    summary: str = ""
    findings: list[ReportFinding] = Field(default_factory=list)
    recommendations: list[ReportRecommendation] = Field(default_factory=list)
    incident_ids: list[str] = Field(default_factory=list)
    # Snapshot of each incident at generation time, so the report stays a fixed record.
    incidents: list[dict[str, Any]] = Field(default_factory=list)
    mode: ClassifyMode = "llm"
    model: str = ""


# ---------------------------------------------------------------------------
# VSS explore → VideoRef helper
# ---------------------------------------------------------------------------


def video_ref_from_explore(row: dict[str, Any]) -> VideoRef:
    """Map one explore `videos[]` (or legacy `chunks[]`) parent row."""
    return VideoRef(
        original_video=str(row.get("original_video") or ""),
        filename=str(row.get("filename") or ""),
        stream_id=row.get("stream_id"),
        total_segments=int(row.get("total_segments") or 0),
        preview_source=row.get("preview_source"),
        uploaded_at=row.get("upload_timestamp"),
        chunk_duration_sec=(
            float(row["chunk_duration_sec"])
            if row.get("chunk_duration_sec") is not None
            else None
        ),
    )


__all__ = [
    "AnalysisEvolution",
    "BBoxPair",
    "CaptionSnapshot",
    "ClassifyLLMResponse",
    "ComponentHealth",
    "Confidence",
    "ConfidenceComponent",
    "CosmosPrompt",
    "CosmosPromptLLMResponse",
    "DetectionSummary",
    "DetectorSpec",
    "DroppedObjective",
    "EnvironmentClassification",
    "EvaluateLLMResponse",
    "EvaluateResultItem",
    "Evidence",
    "EvidenceSignal",
    "EvolutionStep",
    "FeatureFlags",
    "GpuHealth",
    "Incident",
    "InvestigateLLMResponse",
    "Investigation",
    "InvestigationAnswer",
    "JobResult",
    "LlmEval",
    "LlmHealth",
    "MonitoringObjective",
    "MonitoringProfile",
    "ObjectiveWording",
    "PatternHit",
    "PatternsLLMResponse",
    "PipelineRun",
    "PipelineStep",
    "PlanLLMResponse",
    "PotentialEvent",
    "ReingestJob",
    "ReingestProgress",
    "ReingestVerify",
    "ReportFilter",
    "ReportFinding",
    "ReportNarrative",
    "ReportRecommendation",
    "ReportStats",
    "RuleCall",
    "SafetyReport",
    "SecondLook",
    "Signal",
    "StateHealth",
    "StatusResponse",
    "TimelineItem",
    "VideoRef",
    "VideoSegment",
    "VideoSource",
    "VideoSourceListItem",
    "parse_flags",
    "video_ref_from_explore",
]
