"""P12 upload flow end-to-end with fakes: real Store, Configurator, MonitoringEngine and
InvestigationEngine run on an UploadRepo; Cosmos/YOLO/W&B are faked (LLM down → rules-only paths)."""

from __future__ import annotations

import asyncio
import sys
import tempfile
from pathlib import Path

APP = Path(__file__).resolve().parents[1] / "app"
sys.path.insert(0, str(APP))

import newsource as ns  # noqa: E402
from store import Store  # noqa: E402

GENERIC = "PLACE: residential driveway. ENTITIES: one person, one car. ACTIVITY: a car is parked; a person walks nearby."
SPECIAL = ("SCENE: driveway. The car is reversing toward the person, who walks directly behind it, very close to the car. "
           "FLAGS: pedestrian_vehicle_proximity")


class FakeGPU:
    def __init__(self):
        self.calls = []

    async def cosmos_chat(self, messages, images=None, **kw):
        text = messages[-1]["content"] if isinstance(messages[-1]["content"], str) else ""
        self.calls.append(text[:40])
        if images:
            assert images[0].startswith("data:image/jpeg;base64,")
            return GENERIC if text.startswith("Describe this frame") else SPECIAL
        return "PLACE: driveway"

    async def yolo_infer(self, video_b64, filename="clip.mp4"):
        return {"video_shape": [720, 1280], "frames": [
            {"time_sec": 4.0, "detections": [{"label": "person", "bbox": [100, 100, 150, 300]},
                                             {"label": "car", "bbox": [160, 120, 600, 320]}]}]}

    async def discover_cosmos_model(self, force=False):
        return "nvidia/cosmos3-nano-reasoner"


class DownLLM:
    """W&B unavailable: every structured call must fall back deterministically."""

    async def complete(self, *a, **kw):
        raise RuntimeError("W&B down")

    async def structured(self, template, variables, model, fallback, **kw):
        return fallback()


class FakeVSS:
    def __init__(self, indexed=True):
        self.uploads, self.indexed = [], indexed

    async def upload_video(self, files, data):
        self.uploads.append((files["file"][0], data))
        return {"success": True, "object_key": "team-22/20261009_150000_driveway.mp4"}

    async def dashboard_stats(self, scope="all"):
        n = 6 if self.indexed else 0
        return {"recent_videos": [{"original_video": "s3://b/team-22/20261009_150000_driveway.mp4",
                                   "indexed_clips": n, "expected_segments": 6}]}


async def drain(svc):
    while svc._tasks:
        await asyncio.gather(*list(svc._tasks))


def make_store():
    st = Store()
    st._tmp_path = Path(tempfile.mkdtemp()) / "state.json"
    return st


def test_windows_cover_the_clip():
    w = ns.windows_from_frames("upload-x", [1.0, 3.0, 5.0], 6.0, ["a", "b", "c FLAGS: person_vehicle_proximity"])
    assert [(x.t_start, x.t_end) for x in w] == [(0.0, 2.0), (2.0, 4.0), (4.0, 6.0)]
    assert w[2].flags == ["person_vehicle_proximity"] and w[0].source_uri == "upload://upload-x/w001"


def test_yolo_frames_map_to_windows_without_forklift_class():
    w = ns.windows_from_frames("u", [1.0, 5.0], 8.0, ["", ""])
    frames = ns.map_yolo_frames(w, {"frames": [{"time_sec": 5.5, "detections": [{"label": "person"}, {"label": "forklift"}]}]})
    assert w[1].yolo.classes == {"person": 1} and len(frames[w[1].source_uri]) == 1 and not frames[w[0].source_uri]


def test_upload_flow_end_to_end_rules_only(monkeypatch):
    monkeypatch.setattr(ns, "UPLOAD_DIR", Path(tempfile.mkdtemp()))
    store = make_store()
    gpu = FakeGPU()
    vss = FakeVSS()
    svc = ns.NewSourceService(gpu=gpu, llm=DownLLM(), store=store, vss=vss)
    frames = [b"\xff\xd8jpeg"] * 6
    times = [1.0, 3.0, 5.0, 7.0, 9.0, 11.0]

    async def go():
        out = await svc.create(filename="driveway.mp4", data=b"\x00\x00\x00\x18ftypmp42", frames=frames, times=times, duration=12.0)
        await drain(svc)
        return out["source_id"]

    sid = asyncio.run(go())
    view = svc.view(sid)
    assert view["upload"]["status"] == "done", view["upload"]
    keys = [s["key"] for s in view["pipeline"]["steps"]]
    assert keys[0] == "look" and "classify" in keys and "plan" in keys and "prompt" in keys and "reanalyze" in keys
    assert view["classification"]["domain"] and view["profile"]["objectives"]
    # both passes ran on every frame: generic look, then Sightline's own prompt
    assert sum(1 for c in gpu.calls if c.startswith("Describe this frame")) == 6
    assert sum(1 for c in gpu.calls if not c.startswith("Describe this frame") and c) >= 6
    evo = view["evolution"]["steps"]
    assert evo[0]["text"] == GENERIC and evo[-1]["kind"] == "preview" and "FLAGS" in evo[-1]["text"]
    assert ns.video_path(sid) is not None and view["video_url"].endswith(f"{sid}/video")
    # markers exist and incident evidence plays from the uploaded file
    assert view["markers"], "expected at least one marker"
    for inc in view["incidents"]:
        for ev in inc["evidence"]:
            assert ev["clip_url"].startswith(f"api/newsource/{sid}/video#t=")
    assert svc.list()[0]["source_id"] == sid
    # the footage went into VAST with Sightline's own prompt, and indexing was confirmed by VAST
    fname, form = vss.uploads[0]
    assert fname == "driveway.mp4" and form["camera_id"] == sid and form["custom_prompt"]
    assert len(form["custom_prompt"]) <= 800 and form["is_public"] == "false"
    vast = view["upload"]["vast"] if "vast" in view["upload"] else svc.view(sid)["upload"]["vast"]
    assert vast["status"] == "indexed" and vast["segments"] == 6
    step = next(s for s in svc.view(sid)["pipeline"]["steps"] if s["key"] == "vast")
    assert step["status"] == "done" and "indexed in VastDB" in step["summary"]


def test_vast_pending_is_reported_honestly(monkeypatch):
    monkeypatch.setattr(ns, "UPLOAD_DIR", Path(tempfile.mkdtemp()))
    monkeypatch.setattr(ns, "VAST_POLL_S", 0.0)
    monkeypatch.setattr(ns, "VAST_MAX_WAIT_S", 0.05)
    store = make_store()
    svc = ns.NewSourceService(gpu=FakeGPU(), llm=DownLLM(), store=store, vss=FakeVSS(indexed=False))

    async def go():
        out = await svc.create(filename="driveway.mp4", data=b"x", frames=[b"j"] * 3, times=[1, 2, 3], duration=4)
        await drain(svc)
        return out["source_id"]

    sid = asyncio.run(go())
    vast = svc.view(sid)["upload"]["vast"]
    step = next(s for s in svc.view(sid)["pipeline"]["steps"] if s["key"] == "vast")
    assert vast["status"] == "indexing" and step["status"] == "running" and "still indexing" in step["summary"]


def test_cosmos_down_fails_honestly(monkeypatch):
    monkeypatch.setattr(ns, "UPLOAD_DIR", Path(tempfile.mkdtemp()))

    class DeadGPU(FakeGPU):
        async def cosmos_chat(self, *a, **kw):
            raise RuntimeError("cosmos down")

        async def yolo_infer(self, *a, **kw):
            raise RuntimeError("yolo down")

    store = make_store()
    svc = ns.NewSourceService(gpu=DeadGPU(), llm=DownLLM(), store=store, vss=FakeVSS())

    async def go():
        out = await svc.create(filename="x.mp4", data=b"x", frames=[b"j"] * 3, times=[1, 2, 3], duration=4)
        await drain(svc)
        return out["source_id"]

    sid = asyncio.run(go())
    up = svc.view(sid)["upload"]
    assert up["status"] == "failed" and "Cosmos could not describe" in up["error"]


def test_candidate_counts_accept_ints_and_lists():
    # The engine reports `candidates` as an int; len() on it failed the upload after incidents were raised.
    assert ns._count(5) == 5 and ns._count([1, 2]) == 2 and ns._count(None) == 0
