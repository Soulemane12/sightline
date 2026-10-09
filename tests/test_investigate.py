"""P8 InvestigationEngine tests with fakes (no VSS / W&B / GPU access needed)."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

APP = Path(__file__).resolve().parents[1] / "app"
sys.path.insert(0, str(APP))

import investigate as inv  # noqa: E402
from models import (  # noqa: E402
    Evidence,
    InvestigateLLMResponse,
    VideoRef,
    VideoSegment,
    VideoSource,
)

CAM = "sdg_warehouse_cam-2"
OV = "s3://team-22-vss-chunks/team-22/20261001_075554_x_run_7_seed_900334964.eye_00.rgb_chunk_0000.mp4"
OV2 = "s3://team-22-vss-chunks/team-22/20261001_080000_y_run_9_seed_1.eye_00.rgb_chunk_0000.mp4"


def seg_row(ov: str, n: int, caption: str, classes: str = '{"person": 1, "truck": 1}') -> dict:
    return {
        "source": f"{ov}.segments/segment_{n:03d}.mp4",
        "original_video": ov,
        "segment_number": n,
        "segment_start_sec": (n - 1) * 5.0,
        "segment_end_sec": n * 5.0,
        "reasoning_content": caption,
        "object_counts": classes,
        "camera_id": CAM,
        "location": "warehouse3",
        "filename": ov.rsplit("/", 1)[-1],
    }


SEGS = [
    VideoSegment.from_vss_segment(seg_row(OV, 1, "A worker walks along the aisle. A forklift is parked in a bay.")),
    VideoSegment.from_vss_segment(seg_row(OV, 2, "The forklift starts moving and the worker turns and runs toward it, very close to the forklift. FLAGS: person_vehicle_proximity")),
    VideoSegment.from_vss_segment(seg_row(OV, 3, "The worker steps aside as the forklift passes.")),
]
OTHER = [VideoSegment.from_vss_segment(seg_row(OV2, 1, "Empty aisle.", '{}'))]

PROFILE = {
    "source_id": CAM,
    "domain": "warehouse",
    "objectives": [{
        "id": "worker_vehicle_proximity",
        "name": "Worker / forklift proximity",
        "description": "A person within close range of a moving forklift.",
        "severity": "high",
        "semantic_probes": ["forklift moving close to a worker in an aisle"],
        "investigation_questions": ["Is a person close to a moving forklift?"],
        "wording": {"title": "Worker / forklift proximity", "review_action": "Notify the floor lead"},
    }],
}

EVENT = {
    "id": "ev-1",
    "source_id": CAM,
    "objective_id": "worker_vehicle_proximity",
    "segment": SEGS[1].source_uri,
    "rule_score": 0.8,
    "signals": [{"kind": "caption_flag", "name": "caption_flag", "value": "person_vehicle_proximity"}],
    "llm": {"is_event": True, "confidence": 0.86, "reason": "quote found", "evidence_quote": "very close to the forklift"},
}


class FakeRepo:
    def __init__(self):
        self.src = VideoSource(
            id=CAM, camera_id=CAM, location="warehouse3", capture_type="warehouse",
            videos=[VideoRef(original_video=OV2, total_segments=1), VideoRef(original_video=OV, total_segments=3)],
            segment_count=4,
        )

    async def get_source(self, sid):
        return self.src if sid == CAM else None

    async def segments_for_video(self, ov):
        return {OV: SEGS, OV2: OTHER}.get(ov, [])

    async def enrich_segment_detections(self, seg):
        return seg

    async def ensure_bbox_frames(self, uri):
        if uri.endswith("segment_002.mp4"):
            return [{"detections": [
                {"label": "person", "bbox": [100, 100, 150, 300]},
                {"label": "truck", "bbox": [160, 120, 400, 320]},
            ]}]
        return []

    def video_shape(self, uri):
        return (720, 1280)

    @staticmethod
    def frame_diagonal(shape):
        return (shape[0] ** 2 + shape[1] ** 2) ** 0.5 if shape else 1.0

    async def find_other_angles(self, **kw):
        ev = Evidence(role="angle", camera_view="ceiling_04", segment="s3://x/run_7_seed_900334964.ceiling_04/segment_002.mp4",
                      t_start=5.0, t_end=10.0, caption="Overhead: the worker runs toward the moving forklift.").model_dump()
        ev["original_video"] = "s3://x/run_7_seed_900334964.ceiling_04.mp4"
        return [ev]

    async def search_hits(self, q, *, source_id=None, top_k=15, min_similarity=0.3):
        return [Evidence(role="related", segment=SEGS[1].source_uri, caption="dup", camera_id=CAM).model_dump(),
                Evidence(role="related", segment="s3://x/other.mp4", caption="Forklift near a worker", camera_id=CAM,
                         similarity=0.55).model_dump()]


class FakeLLM:
    def __init__(self, resp=None, fail=False):
        self.resp, self.fail, self.prompts = resp, fail, []

    async def structured(self, template, variables, model, fallback, **kw):
        self.prompts.append(template)
        if self.fail:
            return fallback()
        return model.model_validate(self.resp)


class FakeGPU:
    def __init__(self, text="VERDICT: YES\nWHY: A worker runs toward a moving forklift.", fail=False):
        self.text, self.fail = text, fail

    async def cosmos_chat(self, messages, **kw):
        if self.fail:
            raise RuntimeError("cosmos down")
        assert messages[0]["content"][1]["type"] == "video_url"
        return self.text


class FakeVSS:
    async def stream(self, source, range_header=None):
        async def body():
            yield b"\x00\x00\x00\x18ftypmp42"
        return None, body()


class FakeStore:
    def __init__(self):
        self.data = {"profile": {CAM: PROFILE}, "pipeline": {CAM: {"source_id": CAM, "steps": [
            {"key": "investigate", "status": "pending"}, {"key": "incident", "status": "pending"}]}}}

    def get(self, kind, id):
        return self.data.get(kind, {}).get(id)

    def put(self, kind, id, payload, source_id=""):
        if hasattr(payload, "model_dump"):
            payload = payload.model_dump()
        self.data.setdefault(kind, {})[id] = payload

    def list_kind(self, kind, source_id=None):
        return list(self.data.get(kind, {}).values())

    def list_incidents(self, source_id=None, since=None):
        return self.list_kind("incident")

    def get_profile(self, sid):
        return self.get("profile", sid)

    def get_pipeline(self, sid):
        return self.get("pipeline", sid)


CONFIRMED = {
    "verdict": "confirmed",
    "event_type": "worker_vehicle_proximity",
    "title": "Worker runs toward a moving forklift",
    "summary": "The forklift starts moving and the worker runs toward it.",
    "timeline": [{"t": 2.0, "text": "Worker in aisle", "segment": "S1"},
                 {"t": 6.0, "text": "Worker runs toward moving forklift", "segment": "S2"},
                 {"t": 11.0, "text": "Worker steps aside", "segment": "S3"},
                 {"t": 30.0, "text": "hallucinated", "segment": "S9"}],
    "start_segment": "S2", "peak_segment": "S2", "end_segment": "S2",
    "entities": ["worker", "forklift"],
    "why_flagged": "Person close to a moving forklift.",
    "counter_evidence": "Speed is estimated.",
    "temporal_support": 0.67,
    "answers": [{"question": "Is a person close to a moving forklift?", "answer": "Yes, in S2."}],
    "recommended_action": "Notify the floor lead.",
}


def engine(llm=None, gpu=None):
    return inv.InvestigationEngine(repo=FakeRepo(), llm=llm or FakeLLM(CONFIRMED), gpu=gpu or FakeGPU(),
                                   vss=FakeVSS(), store=FakeStore())


# ---------------------------------------------------------------- pure helpers


def test_box_gap_and_pair_normalized_by_diagonal():
    assert inv.box_gap([0, 0, 10, 10], [5, 5, 20, 20]) == 0.0
    assert inv.box_gap([0, 0, 10, 10], [13, 0, 20, 10]) == 3.0
    frames = [{"detections": [{"label": "person", "bbox": [0, 0, 10, 10]}, {"label": "truck", "bbox": [40, 0, 60, 10]}]}]
    pair = inv.person_vehicle_pair(frames, diagonal=1000.0)
    assert pair and pair.b == "truck" and abs(pair.min_gap_norm - 0.03) < 1e-6 and pair.frames_close == 1
    assert inv.person_vehicle_pair([{"detections": [{"label": "forklift", "bbox": [0, 0, 1, 1]}]}], 100.0) is None


def test_parse_second_look():
    sl = inv.parse_second_look("VERDICT: unclear\nWHY: too dark")
    assert sl.verdict == "UNCLEAR" and sl.text == "too dark"
    assert inv.parse_second_look("no structure") is None


def test_confidence_renormalizes_without_second_look():
    c = inv.combine_confidence({"llm": (1.0, ""), "temporal": (0.0, ""), "second_look": (None, "")})
    assert [x.name for x in c.components] == ["LLM evaluation", "Temporal consistency"]
    assert abs(c.value - 0.30 / 0.55) < 1e-3


def test_severity_modifiers_clamped():
    from models import SecondLook
    assert inv.adjust_severity("high", span_segments=3, repeats=5, second_look=SecondLook(verdict="YES"), temporal=0.9)[0] == "critical"
    assert inv.adjust_severity("critical", span_segments=3, repeats=1, second_look=None, temporal=0.9)[0] == "critical"
    assert inv.adjust_severity("high", span_segments=1, repeats=1, second_look=SecondLook(verdict="NO"), temporal=0.2)[0] == "medium"
    assert inv.adjust_severity("high", span_segments=1, repeats=1, second_look=None, temporal=0.5)[0] == "high"


def test_cross_signal_forklift_is_caption_only():
    s = SEGS[1]
    score, why = inv.cross_signal_score(s)
    assert score == 1.0 and "person" in why


# ---------------------------------------------------------------- engine


def test_confirmed_event_becomes_incident_with_full_evidence():
    eng = engine()
    inc = asyncio.run(eng.investigate(EVENT))
    assert inc is not None
    roles = [e.role for e in inc.evidence]
    assert roles[:3] == ["before", "event", "after"] and "angle" in roles
    angle = next(e for e in inc.evidence if e.role == "angle")
    assert angle.camera_view == "ceiling_04" and angle.clip_url.startswith("api/clip?source=s3%3A%2F%2F")
    # timeline cites only context segments, mapped back to URIs
    assert [t.segment for t in inc.investigation.timeline] == [s.source_uri for s in SEGS]
    assert inc.investigation.peak_segment == SEGS[1].source_uri
    assert inc.peak_at == 7.5 and inc.started_at == 5.0 and inc.ended_at == 10.0
    # related excludes context duplicates
    assert all(r.segment != SEGS[1].source_uri for r in inc.investigation.related)
    assert inc.investigation.second_look.verdict == "YES"
    names = [c.name for c in inc.confidence.components]
    assert names == ["LLM evaluation", "Temporal consistency", "YOLO + caption agree", "Cosmos second look", "Rule score"]
    assert 0.7 < inc.confidence.value <= 1.0
    assert inc.mode == "llm" and inc.search_hint == "forklift moving close to a worker in an aisle"
    assert inc.replay_pos == round((1 + 1) / 4, 4)  # OV2 (1 seg) before OV, event at index 1
    # proximity computed on the event segment and shown to the LLM
    ev_ev = next(e for e in inc.evidence if e.role == "event")
    assert ev_ev.yolo.pairs and ev_ev.yolo.pairs[0].frames_close == 1
    assert "min_gap=" in eng._llm.prompts[0]
    # persisted: incident + event status + pipeline summaries
    st = eng._store
    assert st.get("incident", inc.id)["severity"] in {"high", "critical"}
    assert st.get("event", "ev-1")["status"] == "incident"
    steps = {s["key"]: s for s in st.get("pipeline", CAM)["steps"]}
    assert steps["incident"]["summary"] == "1 incident" and steps["incident"]["status"] == "done"


def test_false_positive_is_rejected_not_alerted():
    eng = engine(llm=FakeLLM({**CONFIRMED, "verdict": "false_positive", "temporal_support": 0.2}))
    assert asyncio.run(eng.investigate(EVENT)) is None
    ev = eng._store.get("event", "ev-1")
    assert ev["status"] == "rejected" and ev["investigation"]["verdict"] == "false_positive"
    assert not eng._store.list_incidents()


def test_llm_down_uses_rules_only_and_cosmos_down_is_skipped():
    eng = engine(llm=FakeLLM(fail=True), gpu=FakeGPU(fail=True))
    inc = asyncio.run(eng.investigate(EVENT))
    assert inc is not None and inc.mode == "rules_only"
    assert inc.investigation.second_look is None
    assert "Cosmos second look" not in [c.name for c in inc.confidence.components]
    assert "rules-only" in inc.investigation.counter_evidence


def test_unknown_segment_is_rejected():
    eng = engine()
    bad = {**EVENT, "id": "ev-x", "segment": "s3://nope.mp4"}
    assert asyncio.run(eng.investigate(bad)) is None
    assert eng._store.get("event", "ev-x")["status"] == "rejected"


def test_investigate_response_model_accepts_llm_shape():
    InvestigateLLMResponse.model_validate(CONFIRMED)


def test_second_look_asks_a_confirmation_question():
    from models import MonitoringObjective
    o = MonitoringObjective(id="x", name="Worker / forklift proximity", description="A person within close range of a moving forklift.",
                            investigation_questions=["Was the forklift moving?"])
    q = inv.second_look_question(o)
    assert q.startswith("Does this clip show the following: A person within close range of a moving forklift?")
    assert "Was the forklift moving" not in q


def test_rerun_updates_the_same_incident():
    eng = engine()
    a = asyncio.run(eng.investigate(EVENT))
    b = asyncio.run(eng.investigate({**EVENT, "id": "ev-2"}))  # same moment, new event id
    assert a.id == b.id and len(eng._store.list_incidents()) == 1
