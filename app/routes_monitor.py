"""Monitoring routes: start/stop archive replay + incidents/events feed (Backend-Intel P7)."""

from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query, Request

from engine import get_engine
from jobs import get_jobs
from repository import get_repository
from store import get_store

log = logging.getLogger("sightline.routes_monitor")
router = APIRouter()


@router.post("/api/sources/{source_id}/monitor")
async def api_monitor_start(source_id: str, request: Request) -> dict[str, Any]:
    repo = get_repository()
    src = await repo.get_source(source_id)
    if not src:
        raise HTTPException(404, "source not found")
    profile = get_store().get_profile(source_id)
    if not profile:
        raise HTTPException(400, "configure source before monitoring")

    body: dict[str, Any] = {}
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        body = {}
    video = body.get("video")
    speed = body.get("speed")

    async def _job() -> dict[str, Any]:
        # Bounded autonomous sweep (rules → LLM evaluate → PotentialEvents)
        summary = await get_engine().run_once(
            source_id,
            video=video,
            max_videos=5,
            max_segments=50,
            use_llm=True,
        )
        # Keep archive-replay badge active for the UI after the sweep
        get_store().set_source_status(
            source_id,
            "monitoring",
            replay={
                "active": True,
                "speed": float(speed or 6),
                "segment": summary.get("segments_scanned") or 0,
                "total_segments": src.segment_count,
            },
        )
        get_engine()._active[source_id] = True  # noqa: SLF001
        return summary

    jid = await get_jobs().submit(_job)
    get_store().set_source_status(
        source_id,
        "monitoring",
        replay={
            "active": True,
            "speed": float(speed or 6),
            "segment": 0,
            "total_segments": src.segment_count,
        },
    )
    return {"job_id": jid, "ok": True, "source_id": source_id}


@router.delete("/api/sources/{source_id}/monitor")
async def api_monitor_stop(source_id: str) -> dict[str, Any]:
    await get_engine().stop(source_id)
    return {"ok": True, "source_id": source_id}


@router.get("/api/events")
async def api_events(
    source: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
) -> list[dict[str, Any]]:
    """PotentialEvents for the pipeline panel (candidates + rejected)."""
    items = get_store().list_kind("event", source_id=source)
    if status:
        items = [e for e in items if (e or {}).get("status") == status]
    items.sort(key=lambda e: (e or {}).get("t_start") or 0)
    return items


@router.get("/api/incidents")
async def api_incidents(
    source: Optional[str] = Query(None),
    since: Optional[str] = Query(None),
) -> list[dict[str, Any]]:
    """Incidents plus PotentialEvents (status field) for the pipeline/feed.

    Note: routes_core also registers this path; alphabetically routes_core loads
    first, so this handler may not win. We still write through the store so the
    core stub returns incidents; PotentialEvents are at GET api/events.
    """
    store = get_store()
    incidents = store.list_incidents(source_id=source, since=since)
    events = store.list_kind("event", source_id=source)
    # Surface candidate/rejected events alongside incidents for the panel
    out = list(incidents)
    for e in events:
        if not e:
            continue
        if since and (e.get("created_at") or "") < since:
            continue
        # Shape lightly for feed consumers that only check status/title
        out.append(
            {
                **e,
                "title": e.get("title")
                or f"{e.get('objective_id')} ({e.get('status')})",
                "severity": e.get("severity") or "medium",
                "confidence": {
                    "value": (e.get("llm") or {}).get("confidence") or e.get("rule_score") or 0,
                    "components": [
                        {
                            "name": "rule_score",
                            "value": e.get("rule_score") or 0,
                            "weight": 0.4,
                            "explanation": "deterministic detector",
                        },
                        {
                            "name": "llm_confidence",
                            "value": (e.get("llm") or {}).get("confidence") or 0,
                            "weight": 0.6,
                            "explanation": (e.get("llm") or {}).get("reason") or "",
                        },
                    ],
                },
                "created_at": e.get("created_at") or since or "",
            }
        )
    return out
