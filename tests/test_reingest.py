"""P9 ReingestOrchestrator tests with fakes (no VSS / Cosmos access needed)."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

APP = Path(__file__).resolve().parents[1] / "app"
sys.path.insert(0, str(APP))

import pytest  # noqa: E402

import reingest as rj  # noqa: E402
from models import VideoRef, VideoSegment, VideoSource  # noqa: E402

CAM = "sdg_warehouse_cam-2"
DEMO = "s3://b/team-22/20261001_075554_16face5576497e69c190_03a2937960b9e61f1c99_run_7_seed_900334964.eye_00.rgb_chunk_0000.mp4"
TEST = "s3://b/team-22/20261001_075529_16face5576497e69c190_03a2937960b9e61f1c99_run_7_seed_900334964.ceiling_04.rgb_chunk_0000.mp4"
ORIG = ["A worker stands near a forklift in an aisle.", "The forklift is visible near racks."]
NEW = ["SCENE: aisle. The forklift is moving toward the worker, about 1 m away. FLAGS: person_vehicle_proximity",
       "SCENE: aisle. The worker steps out of the forklift path. FLAGS: person_in_vehicle_path"]


def rows(ov, captions):
    return [{"source": f"{ov}/seg_{i + 1}.mp4", "original_video": ov, "segment_number": i + 1,
             "segment_start_sec": i * 5.0, "segment_end_sec": (i + 1) * 5.0, "reasoning_content": c,
             "camera_id": CAM} for i, c in enumerate(captions)]


PROFILE = {"source_id": CAM, "domain": "warehouse", "information_gaps": ["captions never say whether the forklift moves"],
           "objectives": [{"id": "worker_forklift_proximity", "name": "Worker forklift proximity", "severity": "high"}],
           "generated_prompt": {"text": "Warehouse safety analysis. SCENE: ... FLAGS: person_vehicle_proximity or none."}}


class FakeRepo:
    def __init__(self, vss):
        self.vss = vss
        self.src = VideoSource(id=CAM, camera_id=CAM, videos=[
            VideoRef(original_video=DEMO, filename=DEMO.rsplit("/", 1)[-1], total_segments=2),
            VideoRef(original_video=TEST, filename=TEST.rsplit("/", 1)[-1], total_segments=2)])

    async def get_source(self, sid):
        return self.src if sid == CAM else None

    async def segments_for_video(self, ov):
        return [VideoSegment.from_vss_segment(r) for r in (await self.vss.tools_segments(ov))["segments"]]


class FakeVSS:
    def __init__(self):
        self.captions = {DEMO: list(ORIG), TEST: list(ORIG)}
        self.status = {"status": "running", "completed_chunks": 0, "total_chunks": 1}
        self.pending = 2
        self.submitted = []
        self.reject = False

    async def tools_segments(self, ov):
        return {"segments": rows(ov, self.captions[ov])}

    async def stream(self, source, range_header=None):
        async def body():
            yield b"\x00\x00\x00\x18ftypmp42"
        return None, body()

    async def reingest_start(self, body):
        if self.reject:
            raise RuntimeError("400 bad request")
        self.submitted.append(body)
        return {"job_id": "vss-123", "selected_chunks": 1, "copied_segments": 2}

    async def reingest_status(self, job_id):
        return dict(self.status)

    async def dashboard_stats(self, scope="all"):
        return {"pipeline_alignment": {"pending_index": self.pending}}


class FakeGPU:
    def __init__(self, fail=False):
        self.fail, self.calls = fail, 0

    async def discover_cosmos_model(self, force=False):
        return "nvidia/cosmos3-nano-reasoner"

    async def cosmos_chat(self, messages, **kw):
        self.calls += 1
        assert messages[0]["content"][1]["type"] == "video_url"
        assert messages[0]["content"][0]["text"].startswith("Warehouse safety analysis")
        if self.fail:
            raise asyncio.TimeoutError()
        return "SCENE: aisle. The forklift reverses toward the worker. FLAGS: person_vehicle_proximity"


class FakeStore:
    def __init__(self):
        self.data = {"profile": {CAM: PROFILE}, "pipeline": {CAM: {"source_id": CAM, "steps": [{"key": "reingest", "status": "pending"}]}},
                     "event": {"e1": {"id": "e1", "segment": f"{TEST}/seg_1.mp4", "status": "candidate"}}}

    def get(self, kind, id):
        return self.data.get(kind, {}).get(id)

    def put(self, kind, id, payload, source_id=""):
        if hasattr(payload, "model_dump"):
            payload = payload.model_dump()
        self.data.setdefault(kind, {})[id] = payload

    def list_kind(self, kind, source_id=None):
        return list(self.data.get(kind, {}).values())

    def list_incidents(self, source_id=None, since=None):
        return [{"id": "inc-1", "title": "Worker / forklift proximity", "severity": "high", "confidence": {"value": 0.88}}]

    def get_profile(self, sid):
        return self.get("profile", sid)

    def get_pipeline(self, sid):
        return self.get("pipeline", sid)

    def get_evolution(self, sid):
        return self.get("evolution", sid)


def make(gpu=None):
    vss = FakeVSS()
    o = rj.ReingestOrchestrator(repo=FakeRepo(vss), vss=vss, gpu=gpu or FakeGPU(), store=FakeStore())
    o.spawned = []
    o._spawn = lambda coro: o.spawned.append(coro)
    return o, vss


def run(coro):
    return asyncio.run(coro)


def test_plan_skips_reserved_and_prefers_candidates():
    o, _ = make()
    job = run(o.plan(CAM))
    assert job["original_video"] == TEST and job["status"] == "planned"
    assert "candidate event" in job["reason"] and job["prompt"]["text"].startswith("Warehouse")
    assert job["preview"]["status"] == "not_started" and job["clips"] == 2
    with pytest.raises(PermissionError):
        run(o.plan(CAM, original_video=DEMO))
    # preview-only may target the reserved demo clip (no index change)
    assert run(o.plan(CAM, original_video=DEMO, preview_only=True))["original_video"] == DEMO


def test_one_active_job_per_source():
    o, _ = make()

    async def go():
        j = await o.plan(CAM)
        await o.approve(j["id"])
        return j["id"], (await o.plan(CAM))["id"]

    a, b = run(go())
    assert a == b


def test_preview_success_preserves_original_and_labels_honestly():
    o, vss = make()

    async def go():
        j = await o.plan(CAM)
        await o.approve(j["id"])
        await o.spawned[0]  # run_preview
        return o.get(j["id"])

    job = run(go())
    assert [s["caption"] for s in job["snapshot_before"]] == ORIG
    pv = job["preview"]
    assert pv["status"] == "done" and pv["model"] == "nvidia/cosmos3-nano-reasoner"
    assert pv["results"][0]["original_caption"] == ORIG[0] and "FLAGS:" in pv["results"][0]["preview_caption"]
    assert "not indexed" in pv["label"] and pv["prompt_chars"] > 0
    evo = o.store.get_evolution(CAM)["steps"]
    re_step = next(s for s in evo if s["stage"] == "reanalyzed")
    assert re_step["kind"] == "preview" and "not indexed" in re_step["label"]
    assert evo[-1]["stage"] == "event" and evo[-1]["ref"] == "inc-1"
    # the VAST path was submitted for real and is NOT marked ready by the preview
    assert vss.submitted and vss.submitted[0]["custom_prompt"].startswith("Warehouse")
    assert job["status"] == "reingesting" and job["vss_job_id"] == "vss-123"
    assert vss.captions[TEST] == ORIG  # preview never changed the index


def test_cosmos_failure_is_reported_not_faked():
    o, _ = make(gpu=FakeGPU(fail=True))

    async def go():
        j = await o.plan(CAM)
        await o.approve(j["id"])
        await o.spawned[0]
        return o.get(j["id"])

    job = run(go())
    assert job["preview"]["status"] == "failed" and job["preview"]["error"]
    assert not o.store.get_evolution(CAM)


def test_vast_accepted_but_pending_stays_pending():
    o, vss = make()

    async def go():
        j = await o.plan(CAM)
        await o.approve(j["id"])
        return await o.poll_once(j["id"])

    job = run(go())
    assert job["status"] in {"reingesting", "indexing"} and job["status"] != "ready"
    assert job["progress"]["indexed_segments"] == 0 and job["vast"]["pending_index"] == 2


def test_eventual_ready_with_verification_keeps_preview_in_evolution():
    o, vss = make()

    async def go():
        j = await o.plan(CAM)
        await o.approve(j["id"])
        await o.spawned[0]
        vss.captions[TEST] = list(NEW)
        vss.status = {"status": "completed", "completed_chunks": 1, "total_chunks": 1}
        vss.pending = 0
        return await o.poll_once(j["id"])

    job = run(go())
    assert job["status"] == "ready" and job["verify"] == {"changed": 2, "total": 2, "with_terms": 2}
    assert [a["caption"] for a in job["after"]] == NEW and [b["caption"] for b in job["snapshot_before"]] == ORIG
    kinds = [s.get("kind") for s in o.store.get_evolution(CAM)["steps"] if s["stage"] == "reanalyzed"]
    assert kinds == ["preview", "indexed"]


def test_vast_failure_and_rejected_submit():
    o, vss = make()

    async def go():
        j = await o.plan(CAM)
        await o.approve(j["id"])
        vss.status = {"status": "failed", "error": "reasoner crashed"}
        return await o.poll_once(j["id"])

    job = run(go())
    assert job["status"] == "failed" and job["failed_stage"] and "reasoner" in job["error"]

    o2, vss2 = make()
    vss2.reject = True

    async def go2():
        j = await o2.plan(CAM)
        return await o2.approve(j["id"])

    job2 = run(go2())
    assert job2["status"] == "failed" and "VAST rejected" in job2["error"]


def test_stalled_job_is_left_honest(monkeypatch):
    monkeypatch.setattr(rj, "MAX_WAIT_S", 0.0)
    o, _ = make()

    async def no_sleep(_s):
        return None

    o._sleep = no_sleep

    async def go():
        j = await o.plan(CAM)
        await o.approve(j["id"])
        return await o.poll_until_done(j["id"])

    job = run(go())
    assert job["stalled"] is True and job["status"] in {"reingesting", "indexing"}
    assert "not marked failed" in job["status_note"]


def test_preview_only_never_submits_to_vast():
    o, vss = make()

    async def go():
        j = await o.plan(CAM, original_video=DEMO, preview_only=True)
        await o.approve(j["id"])
        await o.spawned[0]
        return o.get(j["id"])

    job = run(go())
    assert not vss.submitted and job["preview"]["status"] == "done"
    assert job["vast"]["submitted"] is False


def test_verify_counts_terms():
    from models import CaptionSnapshot as C
    v = rj.verify_captions([C(segment="a", caption="x"), C(segment="b", caption="y")],
                           [C(segment="a", caption="the forklift is moving"), C(segment="b", caption="y")], ["moving"])
    assert (v.changed, v.total, v.with_terms) == (1, 2, 1)
