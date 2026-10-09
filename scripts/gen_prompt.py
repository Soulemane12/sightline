#!/usr/bin/env python3
"""Generate a Cosmos ingestion prompt via W&B for a camera_id (P2).

Usage:
  python scripts/gen_prompt.py sdg_warehouse_cam-2
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.request
from pathlib import Path

USER_AGENT = "SightlineGenPrompt/0.1"
WANDB_BASE = "https://api.inference.wandb.ai/v1"
PRIMARY_MODEL = "nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B"
FALLBACK_MODEL = "meta-llama/Llama-3.3-70B-Instruct"

COSMOS_PROMPT_SYSTEM = """You write analysis instructions for NVIDIA Cosmos Reason, a video model that describes
short video segments for a searchable index. Anything the instructions don't ask about will never
be written down."""

FEW_SHOT_OTHER = (
    "Traffic safety analysis. SCENE: road type, lanes, signals. ENTITIES: vehicles and pedestrians. "
    "ACTIONS: motion and stops. CONFLICTS: near collisions. TIMELINE: before/during/after. "
    "FLAGS: list any of pedestrian_vehicle_proximity, hard_braking, or none."
)

WAREHOUSE_PROFILE = {
    "domain": "warehouse",
    "objectives": [
        "person_vehicle_proximity",
        "person_in_vehicle_path",
        "blocked_aisle",
    ],
    "entities": ["person", "forklift"],
    "note": "YOLO has no forklift class; captions/LLM must name forklifts",
}


def load_team_config() -> dict[str, str]:
    configs = sorted(Path("/config").glob("*.config"))
    if len(configs) != 1:
        raise SystemExit(f"expected one /config/*.config, found {len(configs)}")
    env: dict[str, str] = {}
    for raw in configs[0].read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        env[k.strip()] = v.strip()
    return env


def vss_login(backend: str, username: str, password: str) -> str:
    body = json.dumps({"username": username, "password": password}).encode()
    req = urllib.request.Request(
        f"{backend}/api/v1/auth/login",
        data=body,
        headers={"Content-Type": "application/json", "User-Agent": USER_AGENT},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read().decode())
    return data["access_token"]


def fetch_captions(backend: str, token: str, camera_id: str, n: int = 6) -> list[str]:
    # Prefer explore filtered by paging + camera match; fall back to search.
    captions: list[str] = []
    offset = 0
    while len(captions) < n and offset < 600:
        url = f"{backend}/api/v1/videos/explore?scope=all&limit=100&offset={offset}"
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}", "User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read().decode())
        chunks = data.get("chunks") or []
        if not chunks:
            break
        for ch in chunks:
            if ch.get("camera_id") != camera_id:
                continue
            text = (ch.get("reasoning_content") or "").strip()
            if text:
                captions.append(text)
            if len(captions) >= n:
                break
        offset += 100
    if len(captions) >= n:
        return captions[:n]

    # Search fallback for the camera
    body = {
        "query": "person near a forklift or moving vehicle",
        "top_k": n,
        "llm_top_n": 1,
        "min_similarity": 0.2,
        "time_filter": "all",
        "metadata_filters": {"camera_id": camera_id},
        "include_public": True,
    }
    req = urllib.request.Request(
        f"{backend}/api/v1/search",
        data=json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = json.loads(resp.read().decode())
    for r in data.get("results") or []:
        text = (r.get("reasoning_content") or "").strip()
        if text:
            captions.append(text)
    return captions[:n]


def wandb_chat(model: str, system: str, user: str) -> str:
    key = os.environ["WANDB_API_KEY"]
    project = f"{os.environ['WANDB_TEAM']}/{os.environ['WANDB_PROJECT']}"
    payload = {
        "model": model,
        "temperature": 0,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    }
    with __import__("tempfile").NamedTemporaryFile("w", delete=False, suffix=".json") as f:
        json.dump(payload, f)
        path = f.name
    cmd = [
        "curl",
        "-sS",
        f"{WANDB_BASE}/chat/completions",
        "-H",
        f"Authorization: Bearer {key}",
        "-H",
        f"OpenAI-Project: {project}",
        "-H",
        f"User-Agent: {USER_AGENT}",
        "-H",
        "Content-Type: application/json",
        "--data-binary",
        f"@{path}",
    ]
    out = subprocess.check_output(cmd, text=True)
    data = json.loads(out)
    if "error" in data:
        raise RuntimeError(str(data["error"])[:300])
    return data["choices"][0]["message"]["content"]


def parse_prompt_json(content: str) -> dict:
    try:
        return json.loads(content)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", content, re.S)
        if not m:
            raise
        return json.loads(m.group(0))


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate Cosmos prompt for a camera_id")
    parser.add_argument("camera_id", help="e.g. sdg_warehouse_cam-2")
    parser.add_argument("--model", default=PRIMARY_MODEL)
    args = parser.parse_args()

    for k in ("WANDB_API_KEY", "WANDB_TEAM", "WANDB_PROJECT"):
        if not os.environ.get(k):
            raise SystemExit(f"{k} not set")

    cfg = load_team_config()
    backend = cfg["INGRESS_URL"].rstrip("/")
    token = vss_login(backend, cfg["USERNAME"], cfg["PASSWORD"])
    captions = fetch_captions(backend, token, args.camera_id, n=6)
    if not captions:
        raise SystemExit(f"no captions found for camera_id={args.camera_id}")

    # B.3 template: use up to 3 captions in evidence; we pulled 6 for richness.
    evidence = "\n---\n".join(captions[:3])
    gaps = [
        "whether each forklift is moving",
        "distance/path between people and forklifts",
        "blocked aisles or restricted zones",
    ]
    user = f"""Monitoring profile: {json.dumps(WAREHOUSE_PROFILE)}
Information gaps to close: {json.dumps(gaps)}
<evidence>
Current descriptions (what the index says today): {evidence}
</evidence>
Example of a good prompt for a different domain: {FEW_SHOT_OTHER}

Write ONE prompt for Cosmos:
- At most 760 characters (hard limit 800).
- Imperative, concrete, visual. Use labeled sections (SCENE:, ENTITIES:, ACTIONS:, ... TIMELINE:).
- Explicitly ask for every fact in the information gaps.
- Ask what happens before, during and after notable moments.
- End with: FLAGS: list any of person_vehicle_proximity, person_in_vehicle_path, blocked_aisle, or none.
- No speculation about intent; neutral wording for people.

Return only one JSON object:
{{"text": str, "covers": [objective_id], "rationale": str}}"""

    models = [args.model, FALLBACK_MODEL] if args.model != FALLBACK_MODEL else [args.model]
    last_err: Exception | None = None
    parsed: dict | None = None
    used_model = models[0]
    for model in models:
        try:
            content = wandb_chat(model, COSMOS_PROMPT_SYSTEM, user)
            parsed = parse_prompt_json(content)
            used_model = model
            break
        except Exception as e:  # noqa: BLE001
            last_err = e
            continue
    if parsed is None:
        raise SystemExit(f"W&B failed: {last_err}")

    text = (parsed.get("text") or "").strip()
    if len(text) > 800:
        # one shorten retry
        shorten_user = user + f"\n\nYour previous text was {len(text)} chars. Shorten to under 700 characters.\nPrevious: {text}"
        content = wandb_chat(used_model, COSMOS_PROMPT_SYSTEM, shorten_user)
        parsed = parse_prompt_json(content)
        text = (parsed.get("text") or "").strip()
    if len(text) > 800:
        raise SystemExit(f"prompt still too long: {len(text)} chars")

    print(f"camera_id={args.camera_id}")
    print(f"model={used_model}")
    print(f"captions_used={min(3, len(captions))} of {len(captions)} pulled")
    print(f"char_count={len(text)}")
    print("--- PROMPT ---")
    print(text)
    print("--- JSON ---")
    print(json.dumps({"text": text, "covers": parsed.get("covers"), "rationale": parsed.get("rationale")}, indent=2))


if __name__ == "__main__":
    main()
