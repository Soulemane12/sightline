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
    svc = ns.NewSourceService(gpu=gpu, llm=DownLLM(), store=store)
    frames = [b"\xff\xd8jpeg"] * 6
    times = [1.0, 3.0, 5.0, 7.0, 9.0, 11.0]

    async def go():
        out = await svc.create(filename="driveway.mp4", data=b"\x00\x00\x00\x18ftypmp42", frames=frames, times=times, duration=12.0)
        await asyncio.gather(*list(svc._tasks))
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


def test_cosmos_down_fails_honestly(monkeypatch):
    monkeypatch.setattr(ns, "UPLOAD_DIR", Path(tempfile.mkdtemp()))

    class DeadGPU(FakeGPU):
        async def cosmos_chat(self, *a, **kw):
            raise RuntimeError("cosmos down")

        async def yolo_infer(self, *a, **kw):
            raise RuntimeError("yolo down")

    store = make_store()
    svc = ns.NewSourceService(gpu=DeadGPU(), llm=DownLLM(), store=store)

    async def go():
        out = await svc.create(filename="x.mp4", data=b"x", frames=[b"j"] * 3, times=[1, 2, 3], duration=4)
        await asyncio.gather(*list(svc._tasks))
        return out["source_id"]

    sid = asyncio.run(go())
    up = svc.view(sid)["upload"]
    assert up["status"] == "failed" and "Cosmos could not describe" in up["error"]
