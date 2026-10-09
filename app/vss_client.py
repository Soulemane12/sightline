"""VSS retrieval/ingest HTTP client (Backend-Data).

Only this module knows VSS routes. JWT is cached and refreshed once on 401.
Never log tokens or passwords.
"""

from __future__ import annotations

import logging
from typing import Any, AsyncIterator, Optional

import httpx

from config import Settings, get_settings

log = logging.getLogger("sightline.vss")


class VSSError(RuntimeError):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


class VSSClient:
    def __init__(self, settings: Settings | None = None, client: httpx.AsyncClient | None = None):
        self.settings = settings or get_settings()
        self._client = client
        self._owns_client = client is None
        self._token: str | None = None

    @property
    def base(self) -> str:
        return self.settings.vss_url.rstrip("/")

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

    async def login(self, force: bool = False) -> str:
        if self._token and not force:
            return self._token
        if not (self.base and self.settings.vss_username and self.settings.vss_password):
            raise VSSError("VSS_URL / credentials not configured")
        client = await self._ensure_client()
        r = await client.post(
            f"{self.base}/api/v1/auth/login",
            json={
                "username": self.settings.vss_username,
                "password": self.settings.vss_password,
            },
        )
        if r.status_code >= 400:
            raise VSSError(f"login failed HTTP {r.status_code}", r.status_code)
        data = r.json()
        token = data.get("access_token")
        if not token:
            raise VSSError("login response missing access_token")
        self._token = token
        return token

    def _auth_headers(self, token: str) -> dict[str, str]:
        return {"Authorization": f"Bearer {token}"}

    async def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json: Any = None,
        data: Any = None,
        files: Any = None,
        headers: dict[str, str] | None = None,
        retry_401: bool = True,
    ) -> httpx.Response:
        client = await self._ensure_client()
        token = await self.login()
        hdrs = {**(headers or {}), **self._auth_headers(token)}
        url = path if path.startswith("http") else f"{self.base}{path}"
        r = await client.request(method, url, params=params, json=json, data=data, files=files, headers=hdrs)
        if r.status_code == 401 and retry_401:
            await self.login(force=True)
            return await self._request(
                method, path, params=params, json=json, data=data, files=files, headers=headers, retry_401=False
            )
        return r

    async def _json(self, method: str, path: str, **kwargs: Any) -> Any:
        r = await self._request(method, path, **kwargs)
        if r.status_code == 404:
            return None
        if r.status_code >= 400:
            raise VSSError(f"{method} {path} → HTTP {r.status_code}", r.status_code)
        if not r.content:
            return {}
        return r.json()

    async def me(self) -> dict[str, Any]:
        return await self._json("GET", "/api/v1/auth/me") or {}

    async def search(
        self,
        query: str,
        *,
        top_k: int = 15,
        min_similarity: float = 0.3,
        metadata_filters: dict[str, Any] | None = None,
        tags: list[str] | None = None,
        time_filter: str = "all",
        llm_top_n: int | None = None,
        include_public: bool = True,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {
            "query": query,
            "top_k": top_k,
            "min_similarity": min_similarity,
            "time_filter": time_filter,
            "include_public": include_public,
        }
        # API requires llm_top_n >= 1 when present; omit to skip synthesis cost.
        if llm_top_n is not None:
            body["llm_top_n"] = max(1, int(llm_top_n))
        if metadata_filters:
            body["metadata_filters"] = metadata_filters
        if tags:
            body["tags"] = tags
        return await self._json("POST", "/api/v1/search", json=body) or {"results": []}

    async def explore(
        self,
        *,
        scope: str = "all",
        limit: int = 48,
        offset: int = 0,
        location: str | None = None,
        date: str | None = None,
    ) -> dict[str, Any]:
        params: dict[str, Any] = {"scope": scope, "limit": limit, "offset": offset}
        if location:
            params["location"] = location
        if date:
            params["date"] = date
        return await self._json("GET", "/api/v1/videos/explore", params=params) or {"videos": [], "total": 0}

    @staticmethod
    def explore_parent_rows(page: dict[str, Any]) -> list[dict[str, Any]]:
        """Parents from explore: key is `videos`; `chunks` only as defensive alias."""
        if "videos" in page:
            return list(page.get("videos") or [])
        if "chunks" in page:
            return list(page.get("chunks") or [])
        return []

    async def explore_all(self, *, scope: str = "all", page_size: int = 48) -> list[dict[str, Any]]:
        """Page through explore until exhausted. Primary key `videos` (alias `chunks`)."""
        out: list[dict[str, Any]] = []
        offset = 0
        total: int | None = None
        while True:
            page = await self.explore(scope=scope, limit=page_size, offset=offset)
            rows = self.explore_parent_rows(page)
            if total is None:
                total = int(page.get("total") or 0)
            out.extend(rows)
            offset += len(rows)
            if not rows or (total is not None and offset >= total) or len(rows) < page_size:
                break
        return out

    async def max_upload_size_mb(self, default: int = 100) -> int:
        """Live limit from GET /api/v1/config → app.max_upload_size_mb (recon: 100)."""
        try:
            cfg = await self.app_config()
            app = cfg.get("app") if isinstance(cfg, dict) else None
            if isinstance(app, dict) and app.get("max_upload_size_mb") is not None:
                return int(app["max_upload_size_mb"])
            # Some payloads put it at top level
            if isinstance(cfg, dict) and cfg.get("max_upload_size_mb") is not None:
                return int(cfg["max_upload_size_mb"])
        except Exception as e:  # noqa: BLE001
            log.info("app_config upload limit unavailable: %s", type(e).__name__)
        return default

    async def tools_segments(self, original_video: str) -> dict[str, Any]:
        return (
            await self._json("GET", "/api/v1/tools/segments", params={"original_video": original_video})
            or {"segments": []}
        )

    async def segment_metadata(self, source: str) -> dict[str, Any] | None:
        return await self._json("GET", "/api/v1/videos/metadata", params={"source": source})

    async def detections(self, source: str) -> dict[str, Any] | None:
        """YOLO sidecar. 404 → None (detector missing is not an error)."""
        return await self._json("GET", "/api/v1/videos/detections", params={"source": source})

    async def synthesize(
        self, original_video: str, question: str = "Summarize what happens in this video", max_segments: int = 40
    ) -> dict[str, Any]:
        return (
            await self._json(
                "POST",
                "/api/v1/videos/synthesize",
                json={"original_video": original_video, "question": question, "max_segments": max_segments},
            )
            or {}
        )

    async def dashboard_stats(self, scope: str = "all") -> dict[str, Any]:
        return await self._json("GET", "/api/v1/dashboard/stats", params={"scope": scope}) or {}

    async def ingest_config(self) -> dict[str, Any]:
        return await self._json("GET", "/api/v1/metadata/ingest-config") or {}

    async def app_config(self) -> dict[str, Any]:
        return await self._json("GET", "/api/v1/config") or {}

    async def reingest_start(self, body: dict[str, Any]) -> dict[str, Any]:
        return await self._json("POST", "/api/v1/dashboard/reingest", json=body) or {}

    async def reingest_status(self, job_id: str) -> dict[str, Any] | None:
        return await self._json("GET", f"/api/v1/dashboard/reingest/{job_id}")

    async def upload_video(self, files: Any, data: dict[str, Any]) -> dict[str, Any]:
        return await self._json("POST", "/api/v1/videos/upload", data=data, files=files) or {}

    async def stream(
        self, source: str, range_header: str | None = None
    ) -> tuple[httpx.Response, AsyncIterator[bytes]]:
        """Proxy VSS stream. Token goes in query (video Range support)."""
        client = await self._ensure_client()
        token = await self.login()
        params = {"source": source, "token": token}
        headers: dict[str, str] = {}
        if range_header:
            headers["Range"] = range_header
        req = client.build_request(
            "GET", f"{self.base}/api/v1/videos/stream", params=params, headers=headers
        )
        r = await client.send(req, stream=True)
        if r.status_code == 401:
            await r.aclose()
            await self.login(force=True)
            params["token"] = self._token or ""
            req = client.build_request(
                "GET", f"{self.base}/api/v1/videos/stream", params=params, headers=headers
            )
            r = await client.send(req, stream=True)
        if r.status_code >= 400 and r.status_code != 206:
            body = await r.aread()
            await r.aclose()
            raise VSSError(f"stream HTTP {r.status_code}: {body[:200]!r}", r.status_code)

        async def _iter() -> AsyncIterator[bytes]:
            try:
                async for chunk in r.aiter_bytes():
                    yield chunk
            finally:
                await r.aclose()

        return r, _iter()

    async def health_ok(self) -> tuple[bool, str]:
        try:
            await self.login()
            me = await self.me()
            user = me.get("username") or self.settings.vss_username
            return True, f"ok as {user}"
        except Exception as e:  # noqa: BLE001
            return False, f"{type(e).__name__}: {e}"


_vss: VSSClient | None = None


def get_vss() -> VSSClient:
    global _vss
    if _vss is None:
        _vss = VSSClient()
    return _vss
