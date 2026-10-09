"""Sightline FastAPI entrypoint (Backend-Data).

Serves the flat frontend files and auto-includes every routes_*.py so Intel/QA
can add routes without editing this file.
"""

from __future__ import annotations

import importlib
import logging
import pkgutil
import sys
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles

from config import get_settings
from store import get_store

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
log = logging.getLogger("sightline")

APP_DIR = Path(__file__).resolve().parent
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))

settings = get_settings()
app = FastAPI(title="Sightline", version="0.4.0")


def _include_route_modules() -> None:
    """Import every routes_*.py in this directory and mount its `router`."""
    for info in pkgutil.iter_modules([str(APP_DIR)]):
        name = info.name
        if not name.startswith("routes_"):
            continue
        try:
            mod = importlib.import_module(name)
        except Exception as e:  # noqa: BLE001
            log.warning("failed to import %s: %s", name, e)
            continue
        router = getattr(mod, "router", None)
        if router is not None:
            app.include_router(router)
            log.info("mounted %s", name)


_include_route_modules()


@app.on_event("startup")
async def on_startup() -> None:
    store = get_store()
    health = store.boot()
    log.info(
        "store ready backend=%s origin=%s vss=%s",
        health.backend,
        health.data_origin,
        settings.vss_url,
    )
    # Prove VastDB write path early (sightline schema only).
    try:
        store.put(
            "meta",
            "boot",
            {"app": "sightline", "event": "startup"},
            source_id="",
        )
        n = store.flush_pending_sync()
        log.info("vastdb flush on boot wrote %d row(s)", n)
    except Exception as e:  # noqa: BLE001
        log.warning("boot flush skipped: %s", type(e).__name__)
    await store.start_flusher(2.0)


@app.on_event("shutdown")
async def on_shutdown() -> None:
    await get_store().stop_flusher()
    try:
        from vss_client import get_vss

        await get_vss().aclose()
    except Exception:  # noqa: BLE001
        pass
    try:
        from gpu_client import get_gpu

        await get_gpu().aclose()
    except Exception:  # noqa: BLE001
        pass


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "app": "sightline"}


# Static frontend (flat ConfigMap layout). API routes registered above win first.
_STATIC = {
    "index.html": "text/html; charset=utf-8",
    "app.js": "application/javascript; charset=utf-8",
    "styles.css": "text/css; charset=utf-8",
    "mock.js": "application/javascript; charset=utf-8",
}


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(APP_DIR / "index.html", media_type="text/html; charset=utf-8")


@app.get("/{name}")
async def static_file(name: str):
    if name in _STATIC and (APP_DIR / name).is_file():
        return FileResponse(APP_DIR / name, media_type=_STATIC[name])
    # SPA-ish: unknown paths still serve the shell (hash routing lives client-side)
    if (APP_DIR / "index.html").is_file() and "." not in name:
        return FileResponse(APP_DIR / "index.html", media_type="text/html; charset=utf-8")
    return HTMLResponse("Not found", status_code=404)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=settings.port)
