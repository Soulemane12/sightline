"""P9 re-analysis routes (ARCHITECTURE §5 / §5a).

Plan is autonomous, execution needs an explicit approve (re-ingest rewrites the shared index).
Approve starts both paths: a fast direct-Cosmos preview and the real VAST re-ingest.
Preview-only never touches the index, so it is allowed on demo-reserved footage.
"""

from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Body, HTTPException

from reingest import get_orchestrator
from store import get_store

router = APIRouter()


def _orch():
    o = get_orchestrator()
    o.resume_active()  # lazy: resume polling after a pod restart
    return o


@router.post("/api/sources/{source_id}/reingest/plan")
async def api_reingest_plan(source_id: str, body: Optional[dict[str, Any]] = Body(None)) -> dict[str, Any]:
    body = body or {}
    try:
        return await _orch().plan(source_id, original_video=body.get("original_video"),
                                  chunk_count=int(body.get("chunk_count") or 1))
    except PermissionError as e:
        raise HTTPException(403, str(e)) from e
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@router.post("/api/reingest/{job_id}/approve")
async def api_reingest_approve(job_id: str) -> dict[str, Any]:
    try:
        return await _orch().approve(job_id)
    except KeyError as e:
        raise HTTPException(404, "job not found") from e
    except PermissionError as e:
        raise HTTPException(403, str(e)) from e


@router.post("/api/reingest/{job_id}/preview")
async def api_reingest_preview_only(job_id: str) -> dict[str, Any]:
    """Run only the fast Cosmos preview for a planned job; the VAST index is not touched."""
    try:
        return await _orch().approve(job_id, submit_vast=False)
    except KeyError as e:
        raise HTTPException(404, "job not found") from e


@router.post("/api/sources/{source_id}/preview")
async def api_source_preview(source_id: str, body: Optional[dict[str, Any]] = Body(None)) -> dict[str, Any]:
    """Preview re-analysis of one clip (allowed on demo-reserved footage; no index change)."""
    body = body or {}
    o = _orch()
    try:
        job = await o.plan(source_id, original_video=body.get("original_video"), preview_only=True)
        return await o.approve(job["id"], submit_vast=False)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@router.get("/api/reingest/{job_id}")
async def api_reingest_get(job_id: str) -> dict[str, Any]:
    job = _orch().get(job_id)
    if not job:
        raise HTTPException(404, "job not found")
    return job


@router.get("/api/sources/{source_id}/evolution")
async def api_evolution(source_id: str) -> dict[str, Any]:
    return get_store().get_evolution(source_id) or {"source_id": source_id, "steps": []}
