"""Sightline P2 hello app — health + in-pod probe. Temporary until Backend-Data owns main.py."""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from typing import Any

from fastapi import FastAPI
from fastapi.responses import HTMLResponse, JSONResponse

app = FastAPI(title="Sightline Hello", version="0.1.0")

PORT = int(os.environ.get("PORT", "8080"))
USER_AGENT = "SightlineHello/0.1"


def _env(name: str, default: str = "") -> str:
    return (os.environ.get(name) or default).strip()


def _check(name: str, fn) -> dict[str, Any]:
    t0 = time.time()
    try:
        detail = fn()
        return {"name": name, "ok": True, "detail": detail, "latency_s": round(time.time() - t0, 3)}
    except Exception as e:  # noqa: BLE001 — probe must never crash the page
        return {
            "name": name,
            "ok": False,
            "detail": f"{type(e).__name__}: {e}",
            "latency_s": round(time.time() - t0, 3),
        }


def probe_vss_login() -> str:
    base = _env("VSS_URL").rstrip("/")
    user = _env("VSS_USERNAME")
    password = _env("VSS_PASSWORD")
    if not (base and user and password):
        raise RuntimeError("VSS_URL/VSS_USERNAME/VSS_PASSWORD missing")
    body = json.dumps({"username": user, "password": password}).encode()
    req = urllib.request.Request(
        f"{base}/api/v1/auth/login",
        data=body,
        headers={"Content-Type": "application/json", "User-Agent": USER_AGENT},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read().decode())
    if not data.get("access_token"):
        raise RuntimeError("login response missing access_token")
    return f"login ok as {data.get('username') or user}"


def probe_cosmos_ready() -> str:
    url = _env("COSMOS3_REASON_URL").rstrip("/")
    token = _env("GPU_BEARER_TOKEN")
    if not url or not token:
        raise RuntimeError("COSMOS3_REASON_URL or GPU_BEARER_TOKEN missing")
    req = urllib.request.Request(
        f"{url}/v1/health/ready",
        headers={"Authorization": f"Bearer {token}", "User-Agent": USER_AGENT},
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        code = resp.status
        _ = resp.read()
    if code != 200:
        raise RuntimeError(f"HTTP {code}")
    return "ready 200"


def probe_yolo_healthz() -> str:
    url = _env("YOLO_URL").rstrip("/")
    token = _env("GPU_BEARER_TOKEN")
    if not url or not token:
        raise RuntimeError("YOLO_URL or GPU_BEARER_TOKEN missing")
    req = urllib.request.Request(
        f"{url}/healthz",
        headers={"Authorization": f"Bearer {token}", "User-Agent": USER_AGENT},
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        data = json.loads(resp.read().decode())
    if not (data.get("ok") and data.get("model_loaded")):
        raise RuntimeError(f"unexpected healthz: ok={data.get('ok')} model_loaded={data.get('model_loaded')}")
    return "ok + model_loaded"


def probe_wandb_models() -> str:
    key = _env("WANDB_API_KEY")
    team = _env("WANDB_TEAM")
    project = _env("WANDB_PROJECT")
    if not key:
        raise RuntimeError("WANDB_API_KEY missing")
    req = urllib.request.Request(
        "https://api.inference.wandb.ai/v1/models",
        headers={
            "Authorization": f"Bearer {key}",
            "OpenAI-Project": f"{team}/{project}" if team and project else "wandb/inference",
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read().decode())
    n = len(data.get("data") or [])
    if n < 1:
        raise RuntimeError("models list empty")
    return f"{n} models"


def probe_vastdb() -> str:
    import pyarrow as pa  # noqa: F401 — ensure wheel loads
    import vastdb

    endpoint = _env("S3_ENDPOINT")
    access = _env("ACCESS_KEY")
    secret = _env("SECRET_KEY")
    bucket = _env("VASTDB_BUCKET")
    if not all([endpoint, access, secret, bucket]):
        raise RuntimeError("S3_ENDPOINT/ACCESS_KEY/SECRET_KEY/VASTDB_BUCKET missing")
    if not endpoint.startswith(("http://", "https://")):
        endpoint = f"https://{endpoint}"
    session = vastdb.connect(endpoint=endpoint, access=access, secret=secret, ssl_verify=False)
    with session.transaction() as tx:
        b = tx.bucket(bucket)
        schema = b.schema("sightline", fail_if_missing=True)
        table = schema.table("probe", fail_if_missing=True)
        reader = table.select()
        try:
            result = reader.read_all()
        except Exception:
            result = reader
        n = getattr(result, "num_rows", None)
        if n is None:
            raise RuntimeError("select returned no num_rows")
    return f"sightline.probe rows={n}"


def run_probes() -> dict[str, Any]:
    checks = [
        _check("vss_login", probe_vss_login),
        _check("cosmos_ready", probe_cosmos_ready),
        _check("yolo_healthz", probe_yolo_healthz),
        _check("wandb_models", probe_wandb_models),
        _check("vastdb_probe", probe_vastdb),
    ]
    return {
        "ok": all(c["ok"] for c in checks),
        "checks": checks,
        "app": "sightline-hello",
        "note": "no secrets in this payload",
    }


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "app": "sightline-hello"}


@app.get("/api/probe")
def api_probe() -> JSONResponse:
    return JSONResponse(run_probes())


@app.get("/", response_class=HTMLResponse)
def index() -> str:
    # Probe runs server-side; page also shows location.href for App-button URL/prefix.
    try:
        probe = run_probes()
        probe_json = json.dumps(probe, indent=2)
    except Exception as e:  # noqa: BLE001
        probe_json = json.dumps({"ok": False, "error": str(e)}, indent=2)
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Sightline Hello Probe</title>
  <style>
    body {{ font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
           background: #0f1419; color: #e7ecf1; margin: 0; padding: 24px; }}
    h1 {{ font-size: 1.25rem; margin: 0 0 8px; }}
    .meta {{ color: #9aa7b5; margin-bottom: 16px; }}
    pre {{ background: #1a222c; padding: 16px; overflow: auto; border-radius: 6px; }}
    .ok {{ color: #3dd68c; }} .bad {{ color: #ff6b6b; }}
  </style>
</head>
<body>
  <h1>Sightline · hello deploy</h1>
  <p class="meta">location.href = <span id="href"></span></p>
  <p class="meta">pathname = <span id="path"></span> · path prefix for BASE = <span id="base"></span></p>
  <pre id="probe">{probe_json}</pre>
  <script>
    const href = String(location.href);
    const path = String(location.pathname);
    document.getElementById('href').textContent = href;
    document.getElementById('path').textContent = path;
    // Derive BASE from pathname (trailing slash) for later frontend wiring.
    const base = path.endsWith('/') ? path : (path.replace(/\\/[^/]*$/, '/') || '/');
    document.getElementById('base').textContent = base;
  </script>
</body>
</html>"""


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=PORT)
