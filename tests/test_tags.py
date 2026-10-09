"""Manual tags: stored as the person wrote them, checked by Sightline, removable, cleared with the feed."""

from __future__ import annotations

import asyncio
import sys
import tempfile
from pathlib import Path

APP = Path(__file__).resolve().parents[1] / "app"
sys.path.insert(0, str(APP))

import prompts  # noqa: E402
import routes_feeds  # noqa: E402
import routes_tags  # noqa: E402
from store import Store  # noqa: E402


def _store(monkeypatch) -> Store:
    st = Store()
    st._tmp_path = Path(tempfile.mkdtemp()) / "s.json"
    monkeypatch.setattr(routes_tags, "get_store", lambda: st)
    monkeypatch.setattr(routes_feeds, "get_store", lambda: st)
    return st


def test_tag_is_stored_checked_listed_and_removed(monkeypatch):
    st = _store(monkeypatch)
    st.put("source", "cam-a", {"id": "cam-a", "status": "monitoring"}, source_id="cam-a")

    async def fake_bytes(tag):
        return b"\x00\x00"

    class GPU:
        async def cosmos_chat(self, messages, **kw):
            assert "swimmer goes under" in messages[0]["content"][0]["text"]
            return "VERDICT: YES\nWHY: A swimmer sinks below the surface."

    monkeypatch.setattr(routes_tags, "_clip_bytes", fake_bytes)
    import gpu_client
    monkeypatch.setattr(gpu_client, "get_gpu", lambda: GPU())

    async def go():
        tag = await routes_tags.api_tag_create(routes_tags.TagIn(source_id="cam-a", note=" swimmer goes under ",
                                                                  segment="s3://x/seg-3.mp4", frac=0.4))
        assert tag["note"] == "swimmer goes under" and tag["check"]["status"] == "checking"
        await asyncio.gather(*list(routes_tags._TASKS))
        listed = await routes_tags.api_tags(source_id="cam-a")
        assert listed[0]["check"]["verdict"] == "YES" and listed[0]["note"] == "swimmer goes under"
        await routes_tags.api_tag_delete(tag["id"])
        assert await routes_tags.api_tags(source_id="cam-a") == []
    asyncio.run(go())


def test_failed_check_keeps_the_tag(monkeypatch):
    st = _store(monkeypatch)

    async def boom(tag):
        raise FileNotFoundError("gone")

    monkeypatch.setattr(routes_tags, "_clip_bytes", boom)

    async def go():
        tag = await routes_tags.api_tag_create(routes_tags.TagIn(source_id="upload-abc", note="kid falls", t=4.2))
        await asyncio.gather(*list(routes_tags._TASKS))
        kept = st.get("tag", tag["id"])
        assert kept["note"] == "kid falls" and kept["check"]["status"] == "skipped"
    asyncio.run(go())


def test_removing_a_feed_clears_its_tags(monkeypatch):
    st = _store(monkeypatch)
    st.put("tag", "tag-1", {"id": "tag-1", "source_id": "cam-a", "note": "x"}, source_id="cam-a")
    st.put("tag", "tag-2", {"id": "tag-2", "source_id": "cam-b", "note": "y"}, source_id="cam-b")
    routes_feeds.clear_feed("cam-a")
    assert st.get("tag", "tag-1") is None and st.get("tag", "tag-2")


def test_fallback_prompt_comes_from_the_objectives_and_fits():
    objs = [(f"Objective number {i} with a long descriptive name", f"objective_{i}") for i in range(30)]
    text = prompts.objective_prompt("sports", objs, 800)
    assert len(text) <= 800 and "objective_0" in text and "FLAGS:" in text
    short = prompts.objective_prompt("sports", [("Distressed swimmer", "distressed_swimmer")], 800)
    assert "Distressed swimmer" in short and "basketball" not in short.lower()


def test_area_steers_the_question():
    q = routes_tags._question({"note": "swimmer goes under", "t": 6.2, "area": {"x": 0.05, "y": 0.1, "w": 0.2, "h": 0.2}})
    assert "upper left part of the frame" in q and "5% to 25% from the left" in q and "show this there" in q
    assert "Look specifically" not in routes_tags._question({"note": "x", "t": 1.0})


def test_tag_raises_an_incident_that_the_check_updates_and_delete_removes(monkeypatch):
    st = _store(monkeypatch)
    st.put("source", "cam-a", {"id": "cam-a", "camera_id": "cam-a", "status": "monitoring"}, source_id="cam-a")
    st.put("classification", "cam-a", {"domain": "traffic"}, source_id="cam-a")

    async def fake_bytes(tag):
        return b"\x00"

    class GPU:
        async def cosmos_chat(self, messages, **kw):
            return "VERDICT: YES\nWHY: A pedestrian steps in front of the car."

    monkeypatch.setattr(routes_tags, "_clip_bytes", fake_bytes)
    import gpu_client
    monkeypatch.setattr(gpu_client, "get_gpu", lambda: GPU())

    async def go():
        tag = await routes_tags.api_tag_create(routes_tags.TagIn(
            source_id="cam-a", note="pedestrian steps in front of car", segment="s3://x/seg-3.mp4",
            t_start=10.0, t_end=15.0, frac=0.4, severity="critical"))
        inc = st.get("incident", tag["incident_id"])
        assert inc["origin"] == "manual" and inc["severity"] == "critical" and inc["domain"] == "traffic"
        assert inc["replay_pos"] == 0.4 and inc["evidence"][0]["segment"] == "s3://x/seg-3.mp4"
        assert inc["investigation"]["verdict"] == "unclear" and inc["confidence"]["value"] == 0.6
        await asyncio.gather(*list(routes_tags._TASKS))
        inc = st.get("incident", tag["incident_id"])
        assert inc["investigation"]["verdict"] == "confirmed" and inc["investigation"]["second_look"]["verdict"] == "YES"
        assert inc["confidence"]["value"] == 0.81 and len(inc["confidence"]["components"]) == 2
        await routes_tags.api_tag_delete(tag["id"])
        assert st.get("incident", tag["incident_id"]) is None
    asyncio.run(go())


def test_upload_tag_incident_plays_from_the_file_and_counts(monkeypatch):
    st = _store(monkeypatch)
    st.put("source", "upload-x", {"id": "upload-x", "camera_id": "upload-x", "upload": {"incidents": 0}}, source_id="upload-x")

    async def boom(tag):
        raise ValueError("the file is 31 MB; export it at 720p to get Sightline's look")

    monkeypatch.setattr(routes_tags, "_clip_bytes", boom)

    async def go():
        tag = await routes_tags.api_tag_create(routes_tags.TagIn(source_id="upload-x", note="swimmer goes under", t=6.0))
        inc = st.get("incident", tag["incident_id"])
        assert inc["evidence"][0]["clip_url"] == "api/newsource/upload-x/video#t=4.50,8.50"
        assert st.get("source", "upload-x")["upload"]["incidents"] == 1
        await asyncio.gather(*list(routes_tags._TASKS))
        inc = st.get("incident", tag["incident_id"])
        assert inc["investigation"]["verdict"] == "unclear" and "31 MB" in inc["investigation"]["counter_evidence"]
        await routes_tags.api_tag_delete(tag["id"])
        assert st.get("source", "upload-x")["upload"]["incidents"] == 0
    asyncio.run(go())


def test_old_tags_become_incidents_with_their_verdict(monkeypatch):
    st = _store(monkeypatch)
    st.put("source", "nyc_streets_cam-2", {"id": "nyc_streets_cam-2", "status": "monitoring"}, source_id="nyc_streets_cam-2")
    st.put("tag", "tag-old", {"id": "tag-old", "source_id": "nyc_streets_cam-2", "note": "people jay walking",
                              "segment": "s3://x/seg.mp4", "t_start": 0.0, "t_end": 5.0, "frac": 0.5,
                              "check": {"status": "done", "verdict": "YES", "text": "Pedestrians cross mid-block."}},
           source_id="nyc_streets_cam-2")
    st.put("tag", "tag-gone", {"id": "tag-gone", "source_id": "removed-cam", "note": "x"}, source_id="removed-cam")
    assert routes_tags.backfill_incidents() == 1 and routes_tags.backfill_incidents() == 0
    inc = st.get("incident", st.get("tag", "tag-old")["incident_id"])
    assert inc["origin"] == "manual" and inc["investigation"]["verdict"] == "confirmed" and inc["confidence"]["value"] == 0.81


def test_deleted_tag_stays_deleted_after_restart(monkeypatch):
    st = _store(monkeypatch)
    st.put("source", "cam-a", {"id": "cam-a", "status": "monitoring"}, source_id="cam-a")

    async def go():
        tag = await routes_tags.api_tag_create(routes_tags.TagIn(source_id="cam-a", note="near miss", segment="s", frac=0.1))
        for t in list(routes_tags._TASKS):
            t.cancel()
        await routes_tags.api_tag_delete(tag["id"])
        return tag
    tag = asyncio.run(go())
    snap = st.export_snapshot()        # what a restart hydrates from (append-only history)
    st2 = Store()
    st2._tmp_path = Path(tempfile.mkdtemp()) / "s2.json"
    st2.import_snapshot(snap)
    assert st2.get("tag", tag["id"]) is None and st2.get("incident", tag["incident_id"]) is None
    assert not st2.list_kind("tag") and not st2.list_incidents(source_id="cam-a")
