"""Configuration routes: POST configure + GET pipeline (Backend-Intel P6)."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException

from configurator import get_configurator
from jobs import get_jobs
from repository import get_repository
from store import get_store

log = logging.getLogger("sightline.routes_config")
router = APIRouter()


@router.post("/api/sources/{source_id}/configure")
async def api_configure(source_id: str) -> dict[str, Any]:
    repo = get_repository()
    src = await repo.get_source(source_id)
    if not src:
        raise HTTPException(404, "source not found")

    async def _job() -> dict[str, Any]:
        return await get_configurator().configure(source_id)

    jid = await get_jobs().submit(_job)
    return {"job_id": jid, "source_id": source_id}


@router.get("/api/pipeline/{source_id}")
async def api_pipeline(source_id: str) -> dict[str, Any]:
    pipe = get_store().get_pipeline(source_id)
    if pipe:
        return pipe
    return {"source_id": source_id, "steps": []}
