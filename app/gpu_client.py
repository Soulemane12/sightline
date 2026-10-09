"""GPU NIM clients: Cosmos3-Reason, YOLO11, Embed1, Canary (Backend-Data).

Health paths follow gpu/model-health skill. Cosmos model id is discovered from
GET /v1/models (live id: nvidia/cosmos3-nano-reasoner). Never log the bearer token.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

import httpx

from config import Settings, get_settings
from models import ComponentHealth, GpuHealth

log = logging.getLogger("sightline.gpu")


class GPUClient:
    def __init__(self, settings: Settings | None = None, client: httpx.AsyncClient | None = None):
        self.settings = settings or get_settings()
        self._client = client
        self._owns_client = client is None
        self._cosmos_model: str | None = None
        self._embed_model: str | None = None

    async def _ensure_client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                timeout=httpx.Timeout(self.settings.http_timeout_s, read=120.0),
                headers={"User-Agent": self.settings.user_agent},
            )
        return self._client

    async def aclose(self) -> None:
        if self._owns_client and self._client is not None:
            await self._client.aclose()
            self._client = None

    def _auth(self) -> dict[str, str]:
        token = self.settings.gpu_bearer_token
        if not token:
            return {}
        return {"Authorization": f"Bearer {token}"}

    async def _get(self, url: str) -> httpx.Response:
        client = await self._ensure_client()
        return await client.get(url, headers=self._auth())

    async def _post_json(self, url: str, body: dict[str, Any]) -> httpx.Response:
        client = await self._ensure_client()
        return await client.post(url, headers={**self._auth(), "Content-Type": "application/json"}, json=body)

    async def discover_cosmos_model(self, force: bool = False) -> str:
        if self._cosmos_model and not force:
            return self._cosmos_model
        base = self.settings.cosmos3_reason_url
        r = await self._get(f"{base}/v1/models")
        r.raise_for_status()
        data = r.json()
        models = data.get("data") or []
        mid = None
        hint = self.settings.cosmos_model_hint
        for m in models:
            mid = m.get("id") or mid
            if m.get("id") == hint:
                mid = hint
                break
        if not mid and models:
            mid = models[0].get("id")
        self._cosmos_model = mid or hint
        return self._cosmos_model

    async def discover_embed_model(self, force: bool = False) -> str:
        if self._embed_model and not force:
            return self._embed_model
        base = self.settings.cosmos_embed1_url
        r = await self._get(f"{base}/v1/models")
        r.raise_for_status()
        data = r.json()
        models = data.get("data") or []
        self._embed_model = (models[0].get("id") if models else None) or "nvidia/cosmos-embed1"
        return self._embed_model

    async def cosmos_chat(
        self,
        messages: list[dict[str, Any]],
        *,
        images: list[str] | None = None,
        video_b64: str | None = None,
        max_tokens: int = 512,
        temperature: float = 0.2,
    ) -> str:
        """Chat completions. `images` are data-URL or http URLs for image_url parts."""
        model = await self.discover_cosmos_model()
        # If caller passed plain text messages and images, wrap last user turn.
        msgs = list(messages)
        if images or video_b64:
            content: list[dict[str, Any]] = []
            if msgs and isinstance(msgs[-1].get("content"), str):
                content.append({"type": "text", "text": msgs[-1]["content"]})
                msgs = msgs[:-1]
            for url in images or []:
                content.append({"type": "image_url", "image_url": {"url": url}})
            if video_b64:
                # Best-effort; NIMs that reject video will error — caller handles.
                content.append(
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:video/mp4;base64,{video_b64}"},
                    }
                )
            msgs.append({"role": "user", "content": content})
        body = {
            "model": model,
            "messages": msgs,
            "max_tokens": max_tokens,
            "temperature": temperature,
        }
        r = await self._post_json(f"{self.settings.cosmos3_reason_url}/v1/chat/completions", body)
        r.raise_for_status()
        data = r.json()
        choices = data.get("choices") or []
        if not choices:
            return ""
        return str((choices[0].get("message") or {}).get("content") or "")

    async def yolo_infer(self, video_b64: str, filename: str = "clip.mp4") -> dict[str, Any]:
        body = {"video_base64": video_b64, "filename": filename, "include_frames": True}
        r = await self._post_json(f"{self.settings.yolo_url}/v1/infer", body)
        r.raise_for_status()
        return r.json()

    async def embed(self, text: str) -> list[float]:
        model = await self.discover_embed_model()
        body = {
            "input": text,
            "model": model,
            "request_type": "query",
            "encoding_format": "float",
        }
        r = await self._post_json(f"{self.settings.cosmos_embed1_url}/v1/embeddings", body)
        r.raise_for_status()
        data = r.json()
        emb = ((data.get("data") or [{}])[0]).get("embedding") or []
        return list(emb)

    async def canary_transcribe(self, wav_bytes: bytes, filename: str = "audio.wav") -> dict[str, Any]:
        client = await self._ensure_client()
        files = {"file": (filename, wav_bytes, "audio/wav")}
        data = {"model": "nvidia/canary-1b"}
        r = await client.post(
            f"{self.settings.canary_1b_url}/v1/audio/transcriptions",
            headers=self._auth(),
            files=files,
            data=data,
        )
        r.raise_for_status()
        return r.json()

    async def health(self) -> GpuHealth:
        """Per-model health using only supported paths (gpu/model-health)."""
        out = GpuHealth()

        async def cosmos() -> ComponentHealth:
            try:
                m = await self._get(f"{self.settings.cosmos3_reason_url}/v1/models")
                ready = await self._get(f"{self.settings.cosmos3_reason_url}/v1/health/ready")
                live = await self._get(f"{self.settings.cosmos3_reason_url}/v1/health/live")
                ok = m.status_code == 200 and ready.status_code == 200 and live.status_code == 200
                mid = ""
                if m.status_code == 200:
                    try:
                        mid = await self.discover_cosmos_model()
                    except Exception:  # noqa: BLE001
                        mid = self.settings.cosmos_model_hint
                return ComponentHealth(ok=ok, detail=mid or None)
            except Exception as e:  # noqa: BLE001
                return ComponentHealth(ok=False, detail=f"{type(e).__name__}: {e}")

        async def yolo() -> ComponentHealth:
            try:
                r = await self._get(f"{self.settings.yolo_url}/healthz")
                if r.status_code != 200:
                    return ComponentHealth(ok=False, detail=f"HTTP {r.status_code}")
                data = r.json()
                ok = bool(data.get("ok") and data.get("model_loaded"))
                return ComponentHealth(ok=ok, detail="ok + model_loaded" if ok else str(data)[:120])
            except Exception as e:  # noqa: BLE001
                return ComponentHealth(ok=False, detail=f"{type(e).__name__}: {e}")

        async def embed() -> ComponentHealth:
            try:
                m = await self._get(f"{self.settings.cosmos_embed1_url}/v1/models")
                ready = await self._get(f"{self.settings.cosmos_embed1_url}/v1/health/ready")
                live = await self._get(f"{self.settings.cosmos_embed1_url}/v1/health/live")
                ok = m.status_code == 200 and ready.status_code == 200 and live.status_code == 200
                return ComponentHealth(ok=ok)
            except Exception as e:  # noqa: BLE001
                return ComponentHealth(ok=False, detail=f"{type(e).__name__}: {e}")

        async def canary() -> ComponentHealth:
            try:
                ready = await self._get(f"{self.settings.canary_1b_url}/v1/health/ready")
                live = await self._get(f"{self.settings.canary_1b_url}/v1/health/live")
                ok = ready.status_code == 200 and live.status_code == 200
                return ComponentHealth(ok=ok)
            except Exception as e:  # noqa: BLE001
                return ComponentHealth(ok=False, detail=f"{type(e).__name__}: {e}")

        out.cosmos = await cosmos()
        out.yolo = await yolo()
        out.embed = await embed()
        out.canary = await canary()
        return out


_gpu: GPUClient | None = None


def get_gpu() -> GPUClient:
    global _gpu
    if _gpu is None:
        _gpu = GPUClient()
    return _gpu
