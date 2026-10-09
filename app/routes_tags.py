"""Manual tags: a person marks a moment on a feed or an uploaded clip and says what happened.

The tag is stored as-is (it is the human's claim) and raised as an incident marked "reported by you".
Sightline then takes its own look: the clip and the note go to Cosmos as a YES / NO / UNCLEAR
question. The answer is shown next to the tag and sets the incident's confidence; it never
overwrites the note, and a NO leaves the report open (unclear) rather than dismissing the person.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import os
import uuid
from datetime import datetime, timezone
from typing import Any, Literal, Optional

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
    severity: Literal["critical", "high", "medium", "low"] = "high"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# Confidence of a reported incident: the person's report, then Cosmos's own look at the clip.
REPORT_WEIGHT, LOOK_WEIGHT = 0.4, 0.6
LOOK_VALUE = {"YES": 0.95, "UNCLEAR": 0.5, "NO": 0.1}
LOOK_VERDICT = {"YES": "confirmed", "UNCLEAR": "unclear", "NO": "unclear"}


def _confidence(tag: dict[str, Any], check: Optional[dict[str, Any]]) -> dict[str, Any]:
    comps = [{"name": "Reported by a person", "value": 0.6, "weight": REPORT_WEIGHT,
              "explanation": f"Tagged by hand: \"{tag['note']}\""}]
    v = (check or {}).get("verdict")
    if v in LOOK_VALUE:
        comps.append({"name": "Cosmos direct look", "value": LOOK_VALUE[v], "weight": LOOK_WEIGHT,
                      "explanation": (check or {}).get("text") or v})
    total = sum(c["weight"] for c in comps)
    return {"value": round(sum(c["value"] * c["weight"] for c in comps) / total, 3), "components": comps}


def _incident(tag: dict[str, Any]) -> dict[str, Any]:
    """The tag as an incident (same shape as Sightline's own), clearly marked as a person's report."""
    from models import Incident
    store = get_store()
    sid = tag["source_id"]
    meta = store.get("source", sid) or {}
    domain = (store.get_classification(sid) or {}).get("domain") or "general"
    if sid.startswith("upload-"):
        t = float(tag.get("t") or 0.0)
        a, b = max(0.0, t - 1.5), t + 2.5
        ev = {"role": "event", "segment": f"upload://{sid}", "t_start": a, "t_end": b,
              "clip_url": f"api/newsource/{sid}/video#t={a:.2f},{b:.2f}", "caption": f"Reported: {tag['note']}"}
        start, peak, end = a, t, b
    else:
        a, b = float(tag.get("t_start") or 0.0), float(tag.get("t_end") or 0.0)
        ev = {"role": "event", "segment": tag.get("segment") or "", "t_start": a, "t_end": b,
              "caption": f"Reported: {tag['note']}"}
        start, peak, end = a, (a + b) / 2, b
    where = f" Look at the {area_words(tag['area'])} part of the frame." if tag.get("area") else ""
    inc = Incident(
        id=f"inc-{tag['id']}", source_id=sid, domain=domain, objective_id="manual_report", event_type="manual_report",
        title=tag["note"][:120], severity=tag.get("severity") or "high", confidence=_confidence(tag, None),
        summary=f"Reported by a person while reviewing the footage.{where}",
        started_at=start, peak_at=peak, ended_at=end, camera_id=meta.get("camera_id") or sid,
        location=meta.get("location") or "", evidence=[ev],
        investigation={"verdict": "unclear", "why_flagged": f"A person tagged this moment: \"{tag['note']}\"",
                       "peak_segment": ev["segment"], "title": tag["note"][:120]},
        recommended_action="Review the clip and confirm with the person who reported it.",
        replay_pos=tag.get("frac"),
    ).model_dump()
    return {**inc, "origin": "manual", "reported_by": "you", "tag_id": tag["id"]}


def _sync_upload_count(sid: str) -> None:
    store = get_store()
    meta = store.get("source", sid)
    if meta and isinstance(meta.get("upload"), dict):
        store.put("source", sid, {**meta, "upload": {**meta["upload"], "incidents": len(store.list_incidents(source_id=sid))}},
                  source_id=sid)


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
            raise ValueError(f"the file is {path.stat().st_size / 1048576:.0f} MB; export it at 720p to get Sightline's look")
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
        why = str(e) if isinstance(e, (ValueError, FileNotFoundError)) and str(e) else type(e).__name__
        check = {"status": "skipped", "text": f"Sightline could not look at this clip: {why}"}
    tag = store.get("tag", tag_id)
    if tag:
        store.put("tag", tag_id, {**tag, "check": {**check, "at": _now(), "by": "Cosmos (direct look)"}},
                  source_id=tag["source_id"])
        inc = store.get("incident", tag.get("incident_id") or "")
        if inc:
            inv = dict(inc.get("investigation") or {})
            if check.get("verdict"):
                inv["verdict"] = LOOK_VERDICT.get(check["verdict"], "unclear")
                inv["second_look"] = {"verdict": check["verdict"], "text": check.get("text") or ""}
            else:
                inv["counter_evidence"] = check.get("text") or ""
            store.put("incident", inc["id"], {**inc, "investigation": inv, "confidence": _confidence(tag, check)},
                      source_id=tag["source_id"])


@router.post("/api/tags")
async def api_tag_create(body: TagIn) -> dict[str, Any]:
    store = get_store()
    if not store.get("source", body.source_id) and not body.source_id.startswith("upload-"):
        raise HTTPException(404, "unknown feed")
    tag = {"id": "tag-" + uuid.uuid4().hex[:10], **body.model_dump(), "note": body.note.strip(),
           "created_at": _now(), "check": {"status": "checking"}}
    inc = _incident(tag)
    tag["incident_id"] = inc["id"]
    store.put("tag", tag["id"], tag, source_id=body.source_id)
    store.put("incident", inc["id"], inc, source_id=body.source_id)
    _sync_upload_count(body.source_id)
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
    """Removes the tag and the incident it raised."""
    store = get_store()
    tag = store.get("tag", tag_id) or {}
    store.delete_local("tag", tag_id)
    if tag.get("incident_id"):
        store.delete_local("incident", tag["incident_id"])
    if tag.get("source_id"):
        _sync_upload_count(tag["source_id"])
    return {"ok": True, "id": tag_id}
