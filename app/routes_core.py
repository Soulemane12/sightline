"""Core HTTP API owned by Backend-Data (ARCHITECTURE §5 / §5a).

Stub GET api/incidents + api/pipeline read from the store so the existing UI
works before Backend-Intel lands; Intel should replace those handlers.
"""

from __future__ import annotations

import logging
from typing import Any, Optional
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import JSONResponse, StreamingResponse

from config import get_settings
from gpu_client import get_gpu
from jobs import get_jobs
from llm import get_llm
from models import (
    ComponentHealth,
    FeatureFlags,
    StatusResponse,
)
from repository import get_repository
from store import get_store
from vss_client import VSSError, get_vss

log = logging.getLogger("sightline.routes")
router = APIRouter()


def _clip_url(source_uri: str) -> str:
    return f"api/clip?source={quote(source_uri, safe='')}"


def _profile_summary(profile: dict[str, Any] | None, classification: dict[str, Any] | None) -> dict[str, Any] | None:
    if not profile:
        return None
    domain = profile.get("domain") or (classification or {}).get("domain") or "general"
    titles = {
        "warehouse": "Warehouse person–vehicle safety",
        "traffic": "Road person–vehicle safety",
        "security": "Street & facility monitoring",
        "retail": "Retail floor monitoring",
        "sports": "Sports coaching events",
        "general": "General monitoring",
    }
    entities = (classification or {}).get("important_entities") or []
    return {
        "title": titles.get(str(domain), f"{domain} monitoring"),
        "objectives": len(profile.get("objectives") or []),
        "entities": entities,
        "mode": profile.get("mode") or "llm",
    }


def _classification_brief(c: dict[str, Any] | None) -> dict[str, Any] | None:
    if not c:
        return None
    return {"domain": c.get("domain"), "confidence": c.get("confidence")}


@router.get("/api/status")
async def api_status() -> dict[str, Any]:
    settings = get_settings()
    store = get_store()
    vss_ok, vss_detail = await get_vss().health_ok()
    try:
        gpu = await get_gpu().health()
        gpu_d = gpu.model_dump()
    except Exception as e:  # noqa: BLE001
        gpu_d = {
            "cosmos": {"ok": False, "detail": str(e)},
            "yolo": {"ok": False},
            "embed": {"ok": False},
            "canary": {"ok": False},
        }
    try:
        llm = await get_llm().health()
        llm_d = llm.model_dump()
    except Exception:  # noqa: BLE001
        llm_d = {"ok": False, "model": settings.wandb_primary_model, "mode": "rules_only"}

    incidents = store.list_incidents()
    events = store.list_kind("event")
    resp = StatusResponse(
        vss=ComponentHealth(ok=vss_ok, detail=vss_detail if not vss_ok else None),
        gpu=gpu_d,  # type: ignore[arg-type]
        llm=llm_d,  # type: ignore[arg-type]
        state=store.health(),
        flags=FeatureFlags(
            live=settings.live_enabled,
            upload=settings.upload_enabled,
            weave=settings.weave_enabled,
            sports=settings.sports_enabled,
        ),
        replay={"speed": settings.replay_speed},
        limits={"upload_mb": settings.upload_mb},
        stats={
            "candidates": len(events),
            "rejected": sum(1 for e in events if (e or {}).get("status") == "rejected"),
            "incidents": len(incidents),
        },
    )
    return resp.model_dump()


@router.get("/api/sources")
async def api_sources() -> list[dict[str, Any]]:
    settings = get_settings()
    store = get_store()
    repo = get_repository()
    try:
        sources = await repo.list_sources()
    except Exception as e:  # noqa: BLE001
        log.warning("list_sources failed: %s", e)
        raise HTTPException(502, f"VSS explore failed: {type(e).__name__}") from e

    out: list[dict[str, Any]] = []
    for src in sources:
        classification = store.get_classification(src.id)
        profile = store.get_profile(src.id)
        status = store.source_status(src.id, default=src.status)
        reingest = store.get_reingest(src.id)
        replay_meta = (store.get("source", src.id) or {}).get("replay")
        out.append(
            {
                "id": src.id,
                "camera_id": src.camera_id,
                "label": src.label,
                "location": src.location,
                "capture_type": src.capture_type,
                "segment_count": src.segment_count,
                "status": status,
                "classification": _classification_brief(classification),
                "profile_summary": _profile_summary(profile, classification),
                "incident_counts": store.incident_counts(src.id),
                "replay": replay_meta,
                "segment_seconds": settings.segment_seconds,
                "reingest_status": (reingest or {}).get("status") if reingest else None,
            }
        )
    return out


@router.get("/api/sources/{source_id}")
async def api_source_detail(source_id: str) -> dict[str, Any]:
    settings = get_settings()
    store = get_store()
    repo = get_repository()
    src = await repo.get_source(source_id)
    if not src:
        raise HTTPException(404, "source not found")
    classification = store.get_classification(src.id)
    profile = store.get_profile(src.id)
    pipeline = store.get_pipeline(src.id) or {"source_id": src.id, "steps": []}
    evolution = store.get_evolution(src.id) or {"source_id": src.id, "steps": []}
    reingest = store.get_reingest(src.id)
    replay_meta = (store.get("source", src.id) or {}).get("replay")
    status = store.source_status(src.id, default=src.status)
    return {
        "id": src.id,
        "camera_id": src.camera_id,
        "label": src.label,
        "location": src.location,
        "capture_type": src.capture_type,
        "segment_count": src.segment_count,
        "status": status,
        "segment_seconds": settings.segment_seconds,
        "videos": [v.model_dump() for v in src.videos],
        "classification": classification,
        "profile": profile,
        "profile_summary": _profile_summary(profile, classification),
        "pipeline": pipeline,
        "reingest": reingest,
        "evolution": evolution,
        "replay": replay_meta,
        "incidents": store.list_incidents(source_id=src.id),
        "incident_counts": store.incident_counts(src.id),
        "reingest_status": (reingest or {}).get("status") if reingest else None,
    }


@router.get("/api/sources/{source_id}/segments")
async def api_source_segments(
    source_id: str,
    video: Optional[str] = Query(None),
    detections: bool = Query(False),
) -> list[dict[str, Any]]:
    repo = get_repository()
    src = await repo.get_source(source_id)
    if not src:
        raise HTTPException(404, "source not found")
    try:
        segs = await repo.segments_for_source(source_id, video=video, with_detections=detections)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"segments failed: {type(e).__name__}: {e}") from e
    return [s.model_dump() for s in segs]


@router.get("/api/sources/{source_id}/angles")
async def api_source_angles(
    source_id: str,
    filename: Optional[str] = Query(None),
    original_video: Optional[str] = Query(None),
    t_start: float = Query(0.0),
    t_end: float = Query(5.0),
) -> list[dict[str, Any]]:
    """Other-angle discovery for Intel (shared run_N_seed_M across eye_*/ceiling_*)."""
    repo = get_repository()
    src = await repo.get_source(source_id)
    if not src:
        raise HTTPException(404, "source not found")
    if not filename and not original_video and src.videos:
        original_video = src.videos[0].original_video
        filename = src.videos[0].filename
    return await repo.find_other_angles(
        filename=filename,
        original_video=original_video,
        t_start=t_start,
        t_end=t_end,
        exclude_original=original_video,
    )


@router.get("/api/clip")
async def api_clip(request: Request, source: str = Query(...)) -> StreamingResponse:
    if not source:
        raise HTTPException(400, "source required")
    range_header = request.headers.get("range") or request.headers.get("Range")
    try:
        upstream, body = await get_vss().stream(source, range_header)
    except VSSError as e:
        raise HTTPException(e.status or 502, str(e)) from e
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"clip proxy failed: {type(e).__name__}") from e

    headers: dict[str, str] = {}
    for key in ("content-range", "accept-ranges", "content-length"):
        val = upstream.headers.get(key)
        if val:
            headers[key.title()] = val
    if "Accept-Ranges" not in headers:
        headers["Accept-Ranges"] = "bytes"
    ctype = upstream.headers.get("content-type") or ""
    if "octet-stream" in ctype or not ctype:
        ctype = "video/mp4"
    # Avoid hop-by-hop / encoding surprises
    headers.pop("Transfer-Encoding", None)
    return StreamingResponse(
        body,
        status_code=upstream.status_code,
        media_type=ctype,
        headers=headers,
    )


@router.get("/api/search")
async def api_search(
    q: str = Query(""),
    source: Optional[str] = Query(None),
) -> list[dict[str, Any]]:
    if not q.strip():
        return []
    repo = get_repository()
    try:
        hits = await repo.search_hits(q.strip(), source_id=source)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"search failed: {type(e).__name__}: {e}") from e
    # Ensure clip_url present
    for h in hits:
        if h.get("segment") and not h.get("clip_url"):
            h["clip_url"] = _clip_url(h["segment"])
    return hits


@router.get("/api/jobs/{job_id}")
async def api_job(job_id: str) -> dict[str, Any]:
    job = get_jobs().get(job_id)
    if not job:
        # Soft 200 so UI polling during Intel jobs does not hard-fail
        return {"id": job_id, "status": "done", "result": None, "error": None}
    return {
        "id": job.id,
        "status": job.status,
        "result": job.result,
        "error": job.error,
        "created_at": job.created_at,
        "finished_at": job.finished_at,
    }


@router.get("/api/state/export")
async def api_state_export() -> dict[str, Any]:
    return get_store().export_snapshot()


@router.post("/api/state/import")
async def api_state_import(body: dict[str, Any]) -> dict[str, Any]:
    get_store().import_snapshot(body)
    return {"ok": True, "state": get_store().health().model_dump()}


# --- Store-backed stubs so the shipped UI can boot before Backend-Intel ---


@router.get("/api/incidents")
async def api_incidents(
    source: Optional[str] = Query(None),
    since: Optional[str] = Query(None),
) -> list[dict[str, Any]]:
    return get_store().list_incidents(source_id=source, since=since)


@router.get("/api/incidents/{incident_id}")
async def api_incident(incident_id: str) -> dict[str, Any]:
    for inc in get_store().list_incidents():
        if inc.get("id") == incident_id:
            return inc
    raise HTTPException(404, "incident not found")


@router.get("/api/pipeline/{source_id}")
async def api_pipeline(source_id: str) -> dict[str, Any]:
    pipe = get_store().get_pipeline(source_id)
    if pipe:
        return pipe
    return {"source_id": source_id, "steps": []}
