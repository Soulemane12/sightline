"""Tiny async job runner: submit(fn) → job_id; GET status/result/error."""

from __future__ import annotations

import asyncio
import logging
import traceback
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Optional

from models import JobResult

log = logging.getLogger("sightline.jobs")

JobFn = Callable[[], Awaitable[Any] | Any]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class Job:
    id: str
    status: str = "running"  # running|done|failed
    result: Any = None
    error: str | None = None
    created_at: str = field(default_factory=_now)
    finished_at: str | None = None


class JobRunner:
    def __init__(self) -> None:
        self._jobs: dict[str, Job] = {}
        self._lock = asyncio.Lock()

    async def submit(self, fn: JobFn, *, job_id: str | None = None) -> str:
        jid = job_id or f"job-{uuid.uuid4().hex[:10]}"
        job = Job(id=jid)
        async with self._lock:
            self._jobs[jid] = job

        async def _run() -> None:
            try:
                out = fn()
                if asyncio.iscoroutine(out):
                    out = await out
                job.result = out
                job.status = "done"
            except Exception as e:  # noqa: BLE001
                job.status = "failed"
                job.error = f"{type(e).__name__}: {e}"
                log.warning("job %s failed: %s\n%s", jid, job.error, traceback.format_exc())
            finally:
                job.finished_at = _now()

        asyncio.create_task(_run())
        return jid

    def get(self, job_id: str) -> Job | None:
        return self._jobs.get(job_id)

    def result(self, job_id: str) -> JobResult | None:
        job = self.get(job_id)
        if not job:
            return None
        return JobResult(status=job.status, result=job.result, error=job.error)  # type: ignore[arg-type]


_runner: JobRunner | None = None


def get_jobs() -> JobRunner:
    global _runner
    if _runner is None:
        _runner = JobRunner()
    return _runner
