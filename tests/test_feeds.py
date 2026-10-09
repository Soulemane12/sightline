"""Feed removal clears Sightline's per-feed state and leaves a tombstone."""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

APP = Path(__file__).resolve().parents[1] / "app"
sys.path.insert(0, str(APP))

import routes_feeds  # noqa: E402
from store import Store  # noqa: E402


def test_clear_feed_removes_everything_for_that_source_only(monkeypatch):
    st = Store()
    st._tmp_path = Path(tempfile.mkdtemp()) / "s.json"
    monkeypatch.setattr(routes_feeds, "get_store", lambda: st)
    for sid in ("cam-a", "cam-b"):
        st.put("source", sid, {"id": sid, "status": "monitoring"}, source_id=sid)
        st.put("classification", sid, {"domain": "traffic"}, source_id=sid)
        st.put("profile", sid, {"objectives": []}, source_id=sid)
        st.put("incident", f"inc-{sid}", {"id": f"inc-{sid}", "source_id": sid}, source_id=sid)
        st.put("event", f"ev-{sid}", {"id": f"ev-{sid}", "source_id": sid}, source_id=sid)
    removed = routes_feeds.clear_feed("cam-a")
    assert removed["incident"] == 1 and removed["event"] == 1
    assert st.get_classification("cam-a") is None and st.get_profile("cam-a") is None
    assert not st.list_incidents(source_id="cam-a") and st.source_status("cam-a") == "unconfigured"
    assert st.get_classification("cam-b") and st.list_incidents(source_id="cam-b")
