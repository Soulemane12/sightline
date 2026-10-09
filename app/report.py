"""Safety report: every incident matching a camera, severity and time-range filter, plus a narrative.

Counts are computed here; the LLM only writes the summary, findings and recommendations, and may
only cite incidents in the selection. Without the LLM the same fields are written from the counts.
"""

from __future__ import annotations

import json
import logging
import uuid
from collections import Counter
from datetime import datetime, timezone
from typing import Any, Optional

import prompts
from config import get_settings
from configurator import _structured
from llm import get_llm
from models import (
    ReportFilter,
    ReportFinding,
    ReportNarrative,
    ReportRecommendation,
    ReportStats,
    SafetyReport,
)
from repository import get_repository
from store import get_store

log = logging.getLogger("sightline.report")

SEV_RANK = {"low": 0, "medium": 1, "high": 2, "critical": 3}
SEV_ORDER = ("critical", "high", "medium", "low")
MAX_PROMPT_INCIDENTS = 60


def _parse_dt(v: Optional[str]) -> Optional[datetime]:
    if not v:
        return None
    try:
        d = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def _event_evidence(inc: dict[str, Any]) -> dict[str, Any]:
    return next((e for e in inc.get("evidence") or [] if e.get("role") == "event"), {}) or {}


def _conf(inc: dict[str, Any]) -> float:
    return float((inc.get("confidence") or {}).get("value") or 0.0)


def dedupe(incidents: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Same rule as the UI's dedupeIncidents: one incident per moment, highest confidence wins."""
    best: dict[str, dict[str, Any]] = {}
    for inc in incidents:
        inv = inc.get("investigation") or {}
        key = "|".join(
            str(x)
            for x in (
                inc.get("source_id"),
                inc.get("objective_id"),
                inv.get("peak_segment") or _event_evidence(inc).get("segment") or inc.get("peak_at"),
            )
        )
        cur = best.get(key)
        if cur is None or _conf(inc) > _conf(cur):
            best[key] = inc
    return list(best.values())


def select_incidents(f: ReportFilter) -> list[dict[str, Any]]:
    since, until = _parse_dt(f.since), _parse_dt(f.until)
    floor = SEV_RANK.get(f.min_severity, 0)
    wanted = set(f.source_ids)
    out = []
    # Dedupe before filtering, as the UI does: a moment's best incident is chosen first, so a
    # lower-confidence twin can't slip in when the best one is filtered out by severity.
    for inc in dedupe(get_store().list_incidents()):
        if wanted and inc.get("source_id") not in wanted:
            continue
        if SEV_RANK.get(inc.get("severity") or "low", 0) < floor:
            continue
        at = _parse_dt(inc.get("created_at"))
        if since and (at is None or at < since):
            continue
        if until and (at is None or at > until):
            continue
        out.append(inc)
    out.sort(key=lambda i: (-SEV_RANK.get(i.get("severity") or "low", 0), i.get("created_at") or ""))
    return out


def compute_stats(incidents: list[dict[str, Any]]) -> ReportStats:
    sev = Counter(i.get("severity") or "low" for i in incidents)
    cams = Counter(i.get("camera_id") or i.get("source_id") or "unknown" for i in incidents)
    types = Counter(i.get("event_type") or i.get("objective_id") or "unclassified" for i in incidents)
    times = sorted(i.get("created_at") for i in incidents if i.get("created_at"))
    return ReportStats(
        total=len(incidents),
        by_severity={k: sev[k] for k in SEV_ORDER if sev[k]},
        by_camera=dict(cams.most_common()),
        by_event_type=dict(types.most_common()),
        first_at=times[0] if times else None,
        last_at=times[-1] if times else None,
    )


def _snapshot(inc: dict[str, Any]) -> dict[str, Any]:
    ev = _event_evidence(inc)
    inv = inc.get("investigation") or {}
    return {
        "id": inc.get("id"),
        "source_id": inc.get("source_id"),
        "camera_id": inc.get("camera_id") or inc.get("source_id"),
        "title": inc.get("title"),
        "severity": inc.get("severity"),
        "confidence": _conf(inc),
        "verdict": inv.get("verdict"),
        "event_type": inc.get("event_type") or inc.get("objective_id"),
        "objective_id": inc.get("objective_id"),
        "location": inc.get("location"),
        "created_at": inc.get("created_at"),
        "started_at": inc.get("started_at"),
        "peak_at": inc.get("peak_at"),
        "ended_at": inc.get("ended_at"),
        "replay_pos": inc.get("replay_pos"),
        "summary": inc.get("summary") or inv.get("summary") or "",
        "recommended_action": inc.get("recommended_action") or inv.get("recommended_action") or "",
        "caption": ev.get("caption") or "",
        "segment": ev.get("segment") or "",
        "clip_url": ev.get("clip_url") or "",
        "mode": inc.get("mode"),
    }


def _human(v: str) -> str:
    return str(v).replace("_", " ")


def _rules_narrative(incidents: list[dict[str, Any]], stats: ReportStats) -> ReportNarrative:
    if not incidents:
        return ReportNarrative(summary="No incidents were raised for this scope.")
    sev_words = ", ".join(f"{n} {k}" for k, n in stats.by_severity.items())
    top_cam, top_n = next(iter(stats.by_camera.items()))
    summary = (
        f"Sightline raised {stats.total} incident{'s' if stats.total != 1 else ''} "
        f"on {len(stats.by_camera)} camera{'s' if len(stats.by_camera) != 1 else ''} ({sev_words})."
    )
    if len(stats.by_camera) > 1:
        summary += f" The most came from {top_cam} ({top_n})."

    findings: list[ReportFinding] = []
    by_type: dict[str, list[dict[str, Any]]] = {}
    for inc in incidents:
        by_type.setdefault(inc.get("event_type") or inc.get("objective_id") or "unclassified", []).append(inc)
    for etype, group in sorted(by_type.items(), key=lambda kv: -len(kv[1])):
        if len(group) < 2:
            continue
        cams = sorted({g.get("camera_id") or g.get("source_id") for g in group})
        findings.append(ReportFinding(
            statement=f"{len(group)} incidents of {_human(etype)} on {', '.join(cams)}.",
            incident_ids=[g["id"] for g in group],
            why_it_matters="Repeated events of the same kind point to a condition at the site, not a one-off.",
        ))
    for inc in incidents:
        if inc.get("severity") == "critical" and len(findings) < 5:
            findings.append(ReportFinding(
                statement=f"Critical: {inc.get('title')} on {inc.get('camera_id') or inc.get('source_id')}.",
                incident_ids=[inc["id"]],
                why_it_matters=(inc.get("summary") or "")[:240],
            ))

    recs: dict[str, list[str]] = {}
    for inc in incidents:
        action = (inc.get("recommended_action") or "").strip()
        if action:
            recs.setdefault(action, []).append(inc["id"])
    recommendations = [ReportRecommendation(action=a, incident_ids=ids) for a, ids in list(recs.items())[:5]]
    return ReportNarrative(summary=summary, findings=findings[:5], recommendations=recommendations)


def _incident_line(inc: dict[str, Any]) -> str:
    return " | ".join(
        str(x).replace("\n", " ")
        for x in (
            inc.get("id"),
            inc.get("severity"),
            inc.get("camera_id") or inc.get("source_id"),
            inc.get("event_type") or inc.get("objective_id") or "",
            (inc.get("summary") or "")[:300],
            (inc.get("recommended_action") or "")[:200],
        )
    )


def _scope_words(f: ReportFilter) -> str:
    cams = ", ".join(f.source_ids) if f.source_ids else "all cameras"
    period = "in a chosen period" if f.since or f.until else "at any time"
    return f"{cams}; incidents raised {period}; severity {f.min_severity} and above"


def _title(f: ReportFilter, stats: ReportStats, labels: dict[str, str]) -> str:
    cams = [labels.get(c, c) for c in f.source_ids or list(stats.by_camera)]
    if not cams:
        return "Safety report"
    if len(cams) <= 2:
        return "Safety report: " + " and ".join(cams)
    return f"Safety report: {len(cams)} cameras"


async def build_report(f: ReportFilter) -> SafetyReport:
    incidents = select_incidents(f)
    stats = compute_stats(incidents)
    used_fallback = False

    def _fallback() -> ReportNarrative:
        nonlocal used_fallback
        used_fallback = True
        return _rules_narrative(incidents, stats)

    if incidents:
        user = prompts.fill(
            prompts.REPORT_USER,
            scope=_scope_words(f),
            stats=json.dumps(stats.model_dump(exclude={"first_at", "last_at"})),
            incident_list="\n".join(_incident_line(i) for i in incidents[:MAX_PROMPT_INCIDENTS]),
        )
        narrative = await _structured(
            get_llm(), system=prompts.REPORT_SYSTEM, user=user, model=ReportNarrative, fallback=_fallback
        )
    else:
        narrative = _fallback()

    ids = {i["id"] for i in incidents}
    findings = [
        x.model_copy(update={"incident_ids": [i for i in x.incident_ids if i in ids]})
        for x in narrative.findings
        if any(i in ids for i in x.incident_ids)
    ]
    recommendations = [
        x.model_copy(update={"incident_ids": [i for i in x.incident_ids if i in ids]})
        for x in narrative.recommendations
        if x.action.strip()
    ]
    try:
        labels = {s.id: s.label or s.camera_id for s in await get_repository().list_sources()}
    except Exception as e:  # noqa: BLE001 - the title falls back to camera ids
        log.warning("report title: source labels unavailable: %s", e)
        labels = {}
    report = SafetyReport(
        id=f"rpt-{uuid.uuid4().hex[:10]}",
        filter=f,
        title=_title(f, stats, labels),
        stats=stats,
        summary=narrative.summary.strip() or _rules_narrative(incidents, stats).summary,
        findings=findings,
        recommendations=recommendations,
        incident_ids=[i["id"] for i in incidents],
        incidents=[_snapshot(i) for i in incidents],
        mode="rules_only" if used_fallback else "llm",
        model="" if used_fallback else get_settings().wandb_primary_model,
    )
    get_store().put("report", report.id, report)
    log.info("report %s: %d incidents, mode=%s", report.id, stats.total, report.mode)
    return report


def list_reports() -> list[dict[str, Any]]:
    items = get_store().list_kind("report")
    items.sort(key=lambda r: r.get("generated_at") or "", reverse=True)
    return [
        {k: r.get(k) for k in ("id", "title", "generated_at", "filter", "stats", "mode")}
        for r in items
    ]


def get_report(report_id: str) -> Optional[dict[str, Any]]:
    return get_store().get("report", report_id)
