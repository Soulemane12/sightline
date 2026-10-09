"""Manual tags: a person marks a moment on a feed or an uploaded clip and says what happened.

The tag is stored as-is (it is the human's claim). Sightline then takes its own look: the clip and
the note go to Cosmos as a YES / NO / UNCLEAR question, and the answer is shown next to the tag.
It never overwrites the note.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import os
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

import prompts
from store import get_store

log = logging.getLogger("sightline.tags")
router = APIRouter()

CHECK_MAX_BYTES = int(os.getenv("TAG_CHECK_MAX_BYTES", str(16 * 1024 * 1024)))
CHECK_TIMEOUT_S = float(os.getenv("TAG_CHECK_TIMEOUT_S", "60"))
_TASKS: set[asyncio.Task] = set()


class Area(BaseModel):
    """Where the person says to look, as fractions of the frame from the top-left corner."""
    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)
    w: float = Field(gt=0, le=1)
    h: float = Field(gt=0, le=1)


class TagIn(BaseModel):
    source_id: str
    note: str = Field(min_length=1, max_length=300)
    t: Optional[float] = None          # seconds into an uploaded clip
    segment: Optional[str] = None      # feed: the segment shown in the scrub viewer
    t_start: Optional[float] = None
    t_end: Optional[float] = None
    frac: Optional[float] = None       # feed: position on the feed timeline (0..1)
    area: Optional[Area] = None        # optional box: where Sightline should look


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def area_words(a: dict[str, float]) -> str:
    cx, cy = a["x"] + a["w"] / 2, a["y"] + a["h"] / 2
    h = "left" if cx < 1 / 3 else "right" if cx > 2 / 3 else "center"
    v = "upper" if cy < 1 / 3 else "lower" if cy > 2 / 3 else "middle"
    return "center" if (v, h) == ("middle", "center") else f"{v} {h}"


def _question(tag: dict[str, Any]) -> str:
    note = tag["note"].strip().rstrip(".?!")
    where = f"Around {tag['t']:.0f} seconds into this clip, a" if tag.get("t") is not None else "A"
    look = ""
    a = tag.get("area")
    if a:
        pc = lambda v: round(100 * v)  # noqa: E731
        look = (f" Look specifically at the {area_words(a)} part of the frame "
                f"({pc(a['x'])}% to {pc(a['x'] + a['w'])}% from the left, {pc(a['y'])}% to {pc(a['y'] + a['h'])}% from the top).")
    return (f"{where} person reported: \"{note}\".{look} Does the clip show this"
            f"{' there' if a else ''}? Answer YES only if it is clearly visible.")


async def _clip_bytes(tag: dict[str, Any]) -> bytes:
    sid = tag["source_id"]
    if sid.startswith("upload-"):
        from newsource import video_path
        path = video_path(sid)
        if not path:
            raise FileNotFoundError("uploaded file is gone (pod restarted)")
        if path.stat().st_size > CHECK_MAX_BYTES:
            raise ValueError("clip too large to check")
        return path.read_bytes()
    if not tag.get("segment"):
        raise ValueError("no segment")
    from vss_client import get_vss
    _resp, body = await get_vss().stream(tag["segment"])
    buf = bytearray()
    async for chunk in body:
        buf.extend(chunk)
        if len(buf) > CHECK_MAX_BYTES:
            raise ValueError("clip too large to check")
    return bytes(buf)


async def _check(tag_id: str) -> None:
    from gpu_client import get_gpu
    from investigate import parse_second_look
    store = get_store()
    tag = store.get("tag", tag_id)
    if not tag:
        return
    try:
        async def run() -> dict[str, Any]:
            b64 = base64.b64encode(await _clip_bytes(tag)).decode()
            text = prompts.fill(prompts.COSMOS_SECOND_LOOK, objective_question=_question(tag))
            out = await get_gpu().cosmos_chat([{"role": "user", "content": [
                {"type": "text", "text": text},
                {"type": "video_url", "video_url": {"url": f"data:video/mp4;base64,{b64}"}},
            ]}], max_tokens=120, temperature=0.0)
            sl = parse_second_look(out)
            if not sl:
                return {"status": "done", "verdict": "UNCLEAR", "text": (out or "").strip()[:300]}
            return {"status": "done", "verdict": sl.verdict, "text": sl.text}
        check = await asyncio.wait_for(run(), timeout=CHECK_TIMEOUT_S)
    except Exception as e:  # noqa: BLE001
        log.info("tag check skipped: %s", type(e).__name__)
        check = {"status": "skipped", "text": f"Sightline could not look at this clip ({type(e).__name__})"}
    tag = store.get("tag", tag_id)
    if tag:
        store.put("tag", tag_id, {**tag, "check": {**check, "at": _now(), "by": "Cosmos (direct look)"}},
                  source_id=tag["source_id"])


@router.post("/api/tags")
async def api_tag_create(body: TagIn) -> dict[str, Any]:
    store = get_store()
    if not store.get("source", body.source_id) and not body.source_id.startswith("upload-"):
        raise HTTPException(404, "unknown feed")
    tag = {"id": "tag-" + uuid.uuid4().hex[:10], **body.model_dump(), "note": body.note.strip(),
           "created_at": _now(), "check": {"status": "checking"}}
    store.put("tag", tag["id"], tag, source_id=body.source_id)
    task = asyncio.create_task(_check(tag["id"]))
    _TASKS.add(task)
    task.add_done_callback(_TASKS.discard)
    return tag


@router.get("/api/tags")
async def api_tags(source_id: Optional[str] = Query(None)) -> list[dict[str, Any]]:
    tags = [t for t in get_store().list_kind("tag", source_id=source_id) if t]
    return sorted(tags, key=lambda t: (t.get("t") if t.get("t") is not None else (t.get("frac") or 0)))


@router.delete("/api/tags/{tag_id}")
async def api_tag_delete(tag_id: str) -> dict[str, Any]:
    get_store().delete_local("tag", tag_id)
    return {"ok": True, "id": tag_id}
