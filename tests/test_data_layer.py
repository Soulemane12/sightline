"""Smoke tests for Backend-Data layer (run against a live VSS when available)."""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

APP = Path(__file__).resolve().parents[1] / "app"
sys.path.insert(0, str(APP))


def test_from_vss_segment_mapping():
    from models import VideoSegment

    row = {
        "source": "s3://bucket/seg.mp4",
        "original_video": "s3://bucket/parent.mp4",
        "segment_number": 2,
        "segment_start_sec": 5.0,
        "segment_end_sec": 10.0,
        "reasoning_content": "A person near a forklift. FLAGS: person_vehicle_proximity",
        "object_classes": "person",
        "object_counts": '{"person": 1}',
        "camera_id": "sdg_warehouse_cam-2",
        "location": "warehouse3",
        "filename": "x.mp4",
        "duration": 5.0,
    }
    seg = VideoSegment.from_vss_segment(row)
    assert seg.t_start == 5.0 and seg.t_end == 10.0
    assert "forklift" not in (seg.yolo.classes if seg.yolo else {})
    assert seg.caption.startswith("A person")
    assert "person_vehicle_proximity" in seg.flags
    assert seg.yolo and seg.yolo.classes.get("person") == 1


def test_parse_run_seed_view():
    from repository import parse_run_seed_view

    rs, view = parse_run_seed_view(
        "20261001_075529_abc_run_7_seed_900334964.ceiling_04.rgb_chunk_0000.mp4"
    )
    assert rs == "run_7_seed_900334964"
    assert view == "ceiling_04"
    assert parse_run_seed_view("plain.mp4") == (None, None)


def test_evidence_angle_fields_preserved():
    """eb5cf00 contract: Evidence.role may be angle; camera_view is optional."""
    from models import Evidence

    ev = Evidence(
        role="angle",
        camera_view="ceiling_04",
        segment="s3://x/seg.mp4",
        t_start=0.0,
        t_end=5.0,
        caption="other view",
        clip_url="api/clip?source=s3://x/seg.mp4",
    )
    d = ev.model_dump()
    assert d["role"] == "angle"
    assert d["camera_view"] == "ceiling_04"


def test_explore_videos_primary_chunks_alias():
    from vss_client import VSSClient

    assert VSSClient.explore_parent_rows({"videos": [{"a": 1}], "chunks": [{"b": 2}]}) == [{"a": 1}]
    assert VSSClient.explore_parent_rows({"videos": []}) == []
    assert VSSClient.explore_parent_rows({"chunks": [{"b": 2}]}) == [{"b": 2}]


def test_no_captured_at_on_video_ref():
    from models import video_ref_from_explore

    ref = video_ref_from_explore(
        {
            "original_video": "s3://p",
            "filename": "f.mp4",
            "upload_timestamp": "2026-10-01T00:00:00",
            "captured_at": "DO-NOT-USE",
            "total_segments": 2,
        }
    )
    dumped = ref.model_dump()
    assert "captured_at" not in dumped
    assert dumped["uploaded_at"] == "2026-10-01T00:00:00"


def test_frame_diagonal():
    from repository import VideoRepository

    assert abs(VideoRepository.frame_diagonal((1080, 1920)) - (1080**2 + 1920**2) ** 0.5) < 1e-6


def test_object_counts_bad_json():
    from models import VideoSegment

    seg = VideoSegment.from_vss_segment(
        {
            "source": "s3://x",
            "original_video": "s3://y",
            "segment_number": 1,
            "segment_start_sec": 0,
            "segment_end_sec": 5,
            "reasoning_content": "ok",
            "object_counts": "not-json",
            "object_classes": ["person", "car"],
        }
    )
    assert seg.yolo and seg.yolo.classes.get("person") == 1


async def _live_smoke() -> None:
    if not (os.environ.get("INGRESS_URL") or os.environ.get("VSS_URL")):
        print("SKIP live smoke (no VSS_URL/INGRESS_URL)")
        return
    from repository import VideoRepository
    from vss_client import VSSClient

    vss = VSSClient()
    ok, detail = await vss.health_ok()
    assert ok, detail
    repo = VideoRepository(vss=vss)
    sources = await repo.list_sources()
    assert sources, "expected indexed sources"
    wh = next((s for s in sources if s.camera_id == "sdg_warehouse_cam-2"), sources[0])
    segs = await repo.segments_for_source(wh.id)
    assert segs and segs[0].caption
    # other angles on warehouse
    if wh.videos:
        angles = await repo.find_other_angles(
            filename=wh.videos[0].filename,
            original_video=wh.videos[0].original_video,
            t_start=0.0,
            t_end=5.0,
        )
        print(f"other_angles={len(angles)} for {wh.videos[0].filename}")
    hits = await repo.search_hits("person near a vehicle", source_id=wh.camera_id, top_k=5)
    print(f"sources={len(sources)} segs={len(segs)} search_hits={len(hits)}")
    await vss.aclose()


def test_live_smoke():
    asyncio.run(_live_smoke())


if __name__ == "__main__":
    test_from_vss_segment_mapping()
    test_parse_run_seed_view()
    test_evidence_angle_fields_preserved()
    test_explore_videos_primary_chunks_alias()
    test_no_captured_at_on_video_ref()
    test_frame_diagonal()
    test_object_counts_bad_json()
    test_live_smoke()
    print("OK")
