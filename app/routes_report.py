"""Safety report routes: preview the scope, generate (as a job), list and read saved reports."""

from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query

from jobs import get_jobs
from models import ReportFilter
from report import build_report, compute_stats, get_report, list_reports, select_incidents

router = APIRouter()


def _filter(sources: str, since: Optional[str], until: Optional[str], min_severity: str) -> ReportFilter:
    try:
        return ReportFilter(
            source_ids=[s for s in sources.split(",") if s],
            since=since or None,
            until=until or None,
            min_severity=min_severity or "low",
        )
    except ValueError as e:
        raise HTTPException(400, f"invalid report filter: {e}") from e


# Declared before /api/reports/{report_id} so "preview" is not read as an id.
@router.get("/api/reports/preview")
async def api_report_preview(
    sources: str = Query(""),
    since: Optional[str] = Query(None),
    until: Optional[str] = Query(None),
    min_severity: str = Query("low"),
) -> dict[str, Any]:
    incidents = select_incidents(_filter(sources, since, until, min_severity))
    return {"count": len(incidents), "stats": compute_stats(incidents).model_dump()}


@router.post("/api/reports")
async def api_report_create(f: ReportFilter) -> dict[str, Any]:
    async def run() -> dict[str, Any]:
        return (await build_report(f)).model_dump()

    return {"job_id": await get_jobs().submit(run)}


@router.get("/api/reports")
async def api_reports() -> list[dict[str, Any]]:
    return list_reports()


@router.get("/api/reports/{report_id}")
async def api_report(report_id: str) -> dict[str, Any]:
    r = get_report(report_id)
    if not r:
        raise HTTPException(404, "report not found")
    return r
