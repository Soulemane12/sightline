"""P12 routes: upload any clip and let Sightline configure itself on it (see newsource.py)."""

from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse

from config import get_settings
from newsource import get_newsource, upload_enabled, video_path

router = APIRouter()

_MEDIA = {".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
          ".mkv": "video/x-matroska", ".avi": "video/x-msvideo"}


@router.get("/api/newsource/enabled")
async def api_newsource_enabled() -> dict[str, Any]:
    return {"enabled": upload_enabled(), "max_mb": get_settings().upload_mb}


@router.post("/api/newsource")
async def api_newsource_create(request: Request) -> dict[str, Any]:
    """Multipart: file, keyframe_<i> JPEGs, keyframe_times (JSON list), duration, width, height."""
    if not upload_enabled():
        raise HTTPException(403, "uploads are disabled on this deployment")
    form = await request.form()
    up = form.get("file")
    if up is None or not hasattr(up, "read"):
        raise HTTPException(400, "file is required")
    data = await up.read()
    max_mb = get_settings().upload_mb
    if len(data) > max_mb * 1024 * 1024:
        raise HTTPException(413, f"file is larger than {max_mb} MB")
    keys = sorted((k for k in form.keys() if k.startswith("keyframe_") and k != "keyframe_times"),
                  key=lambda k: int(k.split("_", 1)[1]) if k.split("_", 1)[1].isdigit() else 0)
    frames = [await form[k].read() for k in keys if hasattr(form[k], "read")]
    try:
        times = [float(t) for t in json.loads(str(form.get("keyframe_times") or "[]"))]
    except (ValueError, TypeError):
        raise HTTPException(400, "keyframe_times must be a JSON list of seconds")
    if len(times) != len(frames):
        times = [float(i) for i in range(len(frames))]
    duration = float(form.get("duration") or (times[-1] if times else 0) or 0)
    shape = None
    try:
        if form.get("height") and form.get("width"):
            shape = (int(form["height"]), int(form["width"]))
    except ValueError:
        shape = None
    try:
        out = await get_newsource().create(filename=getattr(up, "filename", "clip.mp4") or "clip.mp4", data=data,
                                           frames=frames, times=times, duration=duration, shape=shape)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {"source_id": out["source_id"], "job_id": out["source_id"]}


@router.get("/api/newsource")
async def api_newsource_list() -> list[dict[str, Any]]:
    return get_newsource().list()


@router.get("/api/newsource/{source_id}")
async def api_newsource_get(source_id: str) -> dict[str, Any]:
    view = get_newsource().view(source_id)
    if not view:
        raise HTTPException(404, "upload not found")
    return view


@router.get("/api/newsource/{source_id}/video")
async def api_newsource_video(source_id: str):
    path = video_path(source_id)
    if not path:
        raise HTTPException(404, "video not found (pod restarted?)")
    return FileResponse(path, media_type=_MEDIA.get(path.suffix.lower(), "video/mp4"))


@router.delete("/api/newsource/{source_id}")
async def api_newsource_delete(source_id: str) -> dict[str, Any]:
    """Remove an uploaded feed: its analysis, markers, incidents and the stored file."""
    from routes_feeds import _remove_upload_file, clear_feed
    removed = clear_feed(source_id)
    _remove_upload_file(source_id)
    return {"ok": True, "source_id": source_id, "removed": removed}
