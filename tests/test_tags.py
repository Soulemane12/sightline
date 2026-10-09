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
