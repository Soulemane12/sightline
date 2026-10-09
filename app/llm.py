"""W&B Inference client with structured JSON output (Backend-Data).

Requires User-Agent (Cloudflare 1010 without it). Primary:
nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B — fallback Llama-3.3-70B-Instruct.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any, Callable, Optional, Type, TypeVar

from openai import AsyncOpenAI
from pydantic import BaseModel, ValidationError

from config import Settings, get_settings
from models import ComponentHealth, LlmHealth

log = logging.getLogger("sightline.llm")

T = TypeVar("T", bound=BaseModel)

_JSON_RE = re.compile(r"\{[\s\S]*\}")


def _extract_json_object(text: str) -> dict[str, Any]:
    text = (text or "").strip()
    if not text:
        raise ValueError("empty LLM response")
    try:
        data = json.loads(text)
        if isinstance(data, dict):
            return data
    except json.JSONDecodeError:
        pass
    m = _JSON_RE.search(text)
    if not m:
        raise ValueError("no JSON object in LLM response")
    data = json.loads(m.group(0))
    if not isinstance(data, dict):
        raise ValueError("JSON root is not an object")
    return data


class LLM:
    def __init__(self, settings: Settings | None = None):
        self.settings = settings or get_settings()
        self._client: AsyncOpenAI | None = None
        self._weave_ok = False
        self._init_weave()

    def _init_weave(self) -> None:
        if not self.settings.weave_enabled:
            return
        try:
            import weave  # type: ignore

            team = self.settings.wandb_team
            project = self.settings.wandb_project
            if team and project:
                weave.init(f"{team}/{project}")
                self._weave_ok = True
        except Exception as e:  # noqa: BLE001
            log.warning("weave init failed (disabled): %s", type(e).__name__)
            self._weave_ok = False

    @property
    def client(self) -> AsyncOpenAI:
        if self._client is None:
            s = self.settings
            if not s.wandb_api_key:
                raise RuntimeError("WANDB_API_KEY not configured")
            default_headers: dict[str, str] = {"User-Agent": s.user_agent}
            if s.wandb_team and s.wandb_project:
                default_headers["OpenAI-Project"] = f"{s.wandb_team}/{s.wandb_project}"
            self._client = AsyncOpenAI(
                api_key=s.wandb_api_key,
                base_url=s.wandb_base_url,
                default_headers=default_headers,
                timeout=s.llm_timeout_s,
            )
        return self._client

    def _render(self, template: str, variables: dict[str, Any]) -> str:
        out = template
        for k, v in variables.items():
            out = out.replace("{" + k + "}", str(v))
        return out

    async def complete(
        self,
        prompt: str,
        *,
        model: str | None = None,
        system: str = "You are a careful JSON API. Reply with one JSON object only.",
        json_object: bool = True,
    ) -> str:
        model = model or self.settings.wandb_primary_model
        kwargs: dict[str, Any] = {
            "model": model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": prompt},
            ],
            "temperature": 0.2,
        }
        if json_object:
            kwargs["response_format"] = {"type": "json_object"}
        try:
            resp = await self.client.chat.completions.create(**kwargs)
        except Exception:
            # Retry once on primary without response_format, then fallback model.
            try:
                kwargs.pop("response_format", None)
                resp = await self.client.chat.completions.create(**kwargs)
            except Exception:
                if model == self.settings.wandb_fallback_model:
                    raise
                return await self.complete(
                    prompt,
                    model=self.settings.wandb_fallback_model,
                    system=system,
                    json_object=json_object,
                )
        return str(resp.choices[0].message.content or "")

    async def structured(
        self,
        template: str,
        variables: dict[str, Any],
        model: Type[T],
        fallback: Callable[[], T],
        *,
        llm_model: str | None = None,
    ) -> T:
        """Call → extract first JSON object → validate → one repair retry → fallback()."""
        prompt = self._render(template, variables)
        try:
            raw = await self.complete(prompt, model=llm_model)
            data = _extract_json_object(raw)
            return model.model_validate(data)
        except (ValidationError, ValueError, json.JSONDecodeError) as first_err:
            log.info("structured parse failed, repairing: %s", type(first_err).__name__)
            try:
                repair = (
                    "Your previous reply was invalid. Return ONLY a JSON object matching the schema. "
                    f"Error: {first_err}\n\nOriginal request:\n{prompt}"
                )
                raw2 = await self.complete(repair, model=llm_model or self.settings.wandb_fallback_model)
                data2 = _extract_json_object(raw2)
                return model.model_validate(data2)
            except Exception as e:  # noqa: BLE001
                log.warning("structured fallback after repair fail: %s", type(e).__name__)
                return fallback()
        except Exception as e:  # noqa: BLE001
            log.warning("structured LLM error, using fallback: %s", type(e).__name__)
            return fallback()

    async def health(self) -> LlmHealth:
        try:
            models = await self.client.models.list()
            ids = [m.id for m in (models.data or [])]
            primary = self.settings.wandb_primary_model
            ok = bool(ids)
            mode = "llm" if ok else "rules_only"
            chosen = primary if primary in ids else (ids[0] if ids else primary)
            return LlmHealth(ok=ok, model=chosen, mode=mode)  # type: ignore[arg-type]
        except Exception as e:  # noqa: BLE001
            return LlmHealth(ok=False, model=self.settings.wandb_primary_model, mode="rules_only")


_llm: LLM | None = None


def get_llm() -> LLM:
    global _llm
    if _llm is None:
        _llm = LLM()
    return _llm
