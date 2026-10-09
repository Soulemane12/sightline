"""P8 investigation routes.

Incidents themselves are served by the store-backed GET api/incidents[/{id}] in
routes_core.py (same shapes), so this module only adds triggers and an audit view
under api/investigate/* — no duplicate paths, no edits to routes_core.py.
"""

from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Body, HTTPException, Query

from investigate import get_investigator
from jobs import get_jobs
from store import get_store

router = APIRouter()


@router.post("/api/investigate/event")
async def api_investigate_event(event: dict[str, Any] = Body(...)) -> dict[str, Any]:
    """Investigate a PotentialEvent payload (engine or manual). Returns a job id."""
    if not event.get("id") or not event.get("source_id") or not event.get("segment"):
        raise HTTPException(400, "event needs id, source_id and segment")

    async def run() -> Optional[dict[str, Any]]:
        inc = await get_investigator().investigate(event)
        return inc.model_dump() if inc else None

    return {"job_id": await get_jobs().submit(run)}


@router.post("/api/investigate/event/{event_id}")
async def api_investigate_stored_event(event_id: str) -> dict[str, Any]:
    """Re-run the investigation for an event already in the store."""
    raw = get_store().get("event", event_id)
    if not raw:
        raise HTTPException(404, "event not found")

    async def run() -> Optional[dict[str, Any]]:
        inc = await get_investigator().investigate(raw)
        return inc.model_dump() if inc else None

    return {"job_id": await get_jobs().submit(run)}


@router.post("/api/investigate/source/{source_id}")
async def api_investigate_source(source_id: str, limit: int = Query(10, ge=1, le=50)) -> dict[str, Any]:
    """Investigate pending candidate events for a source."""

    async def run() -> dict[str, Any]:
        return await get_investigator().investigate_pending(source_id, limit=limit)

    return {"job_id": await get_jobs().submit(run)}


@router.get("/api/investigate/events")
async def api_investigated_events(source: Optional[str] = Query(None)) -> list[dict[str, Any]]:
    """Audit view: every evaluated event, including rejected ones and their investigation."""
    items = get_store().list_kind("event", source_id=source)
    return sorted(items, key=lambda e: e.get("id") or "")
