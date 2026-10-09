"""Sightline env config and feature flags (Backend-Data)."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from functools import lru_cache


def _env(name: str, default: str = "") -> str:
    return (os.environ.get(name) or default).strip()


def _env_bool(name: str, default: bool = False) -> bool:
    raw = _env(name)
    if not raw:
        return default
    return raw.lower() in {"1", "true", "yes", "on"}


def _env_int(name: str, default: int) -> int:
    raw = _env(name)
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    raw = _env(name)
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


# GPU host from gpu/model-health skill (env overrides win).
_GPU_HOST = "166.19.38.112"


@dataclass(frozen=True)
class Settings:
    port: int = 8080
    vss_url: str = ""
    vss_username: str = ""
    vss_password: str = ""

    wandb_api_key: str = ""
    wandb_team: str = ""
    wandb_project: str = ""
    wandb_primary_model: str = "nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B"
    wandb_fallback_model: str = "meta-llama/Llama-3.3-70B-Instruct"
    wandb_base_url: str = "https://api.inference.wandb.ai/v1"
    user_agent: str = "Sightline/1.0"

    gpu_bearer_token: str = ""
    cosmos3_reason_url: str = ""
    yolo_url: str = ""
    cosmos_embed1_url: str = ""
    canary_1b_url: str = ""
    cosmos_model_hint: str = "nvidia/cosmos3-nano-reasoner"

    s3_endpoint: str = ""
    access_key: str = ""
    secret_key: str = ""
    vastdb_bucket: str = ""
    sightline_schema: str = "sightline"
    records_table: str = "records"

    live_enabled: bool = False
    upload_enabled: bool = False
    weave_enabled: bool = False
    sports_enabled: bool = False
    canary_enabled: bool = False

    http_timeout_s: float = 30.0
    llm_timeout_s: float = 45.0
    upload_mb: int = 100
    replay_speed: float = 6.0
    segment_seconds: float = 5.0
    custom_prompt_max_chars: int = 800

    app_dir: str = field(default_factory=lambda: os.path.dirname(os.path.abspath(__file__)))


# Documented in-pod ClusterIP (set via Secret VSS_URL). Never hardcode as the only URL —
# on the VM fall back to INGRESS_URL; inside the pod public Ingress DNS fails.
IN_POD_VSS_URL = "http://video-backend-service:8000"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Load settings once. VSS_URL stays configurable (in-pod ClusterIP vs VM Ingress)."""
    ingress = _env("INGRESS_URL").rstrip("/")
    # Prefer explicit VSS_URL (pod Secret should be IN_POD_VSS_URL); else VM Ingress.
    vss = _env("VSS_URL").rstrip("/") or ingress
    return Settings(
        port=_env_int("PORT", 8080),
        vss_url=vss,
        vss_username=_env("VSS_USERNAME") or _env("USERNAME"),
        vss_password=_env("VSS_PASSWORD") or _env("PASSWORD"),
        wandb_api_key=_env("WANDB_API_KEY"),
        wandb_team=_env("WANDB_TEAM"),
        wandb_project=_env("WANDB_PROJECT"),
        wandb_primary_model=_env("WANDB_PRIMARY_MODEL", "nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B"),
        wandb_fallback_model=_env("WANDB_FALLBACK_MODEL", "meta-llama/Llama-3.3-70B-Instruct"),
        user_agent=_env("SIGHTLINE_USER_AGENT", "Sightline/1.0"),
        gpu_bearer_token=_env("GPU_BEARER_TOKEN"),
        cosmos3_reason_url=_env("COSMOS3_REASON_URL", f"http://{_GPU_HOST}:8001").rstrip("/"),
        yolo_url=_env("YOLO_URL", f"http://{_GPU_HOST}:8002").rstrip("/"),
        cosmos_embed1_url=_env("COSMOS_EMBED1_URL", f"http://{_GPU_HOST}:8003").rstrip("/"),
        canary_1b_url=_env("CANARY_1B_URL", f"http://{_GPU_HOST}:8004").rstrip("/"),
        cosmos_model_hint=_env("COSMOS_MODEL", "nvidia/cosmos3-nano-reasoner"),
        s3_endpoint=_env("S3_ENDPOINT"),
        access_key=_env("ACCESS_KEY"),
        secret_key=_env("SECRET_KEY"),
        vastdb_bucket=_env("VASTDB_BUCKET"),
        live_enabled=_env_bool("LIVE_ENABLED", False),
        upload_enabled=_env_bool("UPLOAD_ENABLED", False),
        weave_enabled=_env_bool("WEAVE_ENABLED", False),
        sports_enabled=_env_bool("SPORTS_ENABLED", False),
        canary_enabled=_env_bool("CANARY_ENABLED", False),
        http_timeout_s=_env_float("HTTP_TIMEOUT_S", 30.0),
        llm_timeout_s=_env_float("LLM_TIMEOUT_S", 45.0),
        upload_mb=_env_int("UPLOAD_MB", 100),
        replay_speed=_env_float("REPLAY_SPEED", 6.0),
    )
