"""VideoRepository: sources, ordered segments, detections, other-angle discovery.

Normalizes VSS wire fields via VideoSegment.from_vss_segment / video_ref_from_explore.
Explore list key is `videos` (not `chunks`). Pixel xyxy boxes are preserved in a
sidecar cache for bbox_proximity rules. Forklift is never treated as a YOLO class.
"""

from __future__ import annotations

import logging
import re
import time
from collections import OrderedDict
from typing import Any, Optional

from models import (
    DetectionSummary,
    Evidence,
    VideoSegment,
    VideoSource,
    video_ref_from_explore,
)
from vss_client import VSSClient, get_vss

log = logging.getLogger("sightline.repo")

# Warehouse multi-view: run_N_seed_M + eye_* / ceiling_*
RUN_SEED_VIEW_RE = re.compile(
    r"(run_\d+_seed_\d+)\.(eye_\d+|ceiling_\d+)\b",
    re.IGNORECASE,
)


def parse_run_seed_view(filename: str | None) -> tuple[str | None, str | None]:
    """Return (run_N_seed_M, camera_view) from a warehouse filename, else (None, None)."""
    if not filename:
        return None, None
    m = RUN_SEED_VIEW_RE.search(filename)
    if not m:
        return None, None
    return m.group(1).lower(), m.group(2).lower()


def _label_for_camera(camera_id: str, location: str, capture_type: str) -> str:
    pretty = camera_id.replace("_", " ").replace("-", " ")
    if location:
        return f"{pretty} · {location}"
    if capture_type:
        return f"{pretty} · {capture_type}"
    return pretty


class _LRU:
    def __init__(self, maxsize: int = 128):
        self.maxsize = maxsize
        self._data: OrderedDict[str, tuple[float, Any]] = OrderedDict()

    def get(self, key: str) -> Any | None:
        if key not in self._data:
            return None
        ts, val = self._data.pop(key)
        self._data[key] = (ts, val)
        return val

    def set(self, key: str, val: Any) -> None:
        if key in self._data:
            self._data.pop(key)
        self._data[key] = (time.time(), val)
        while len(self._data) > self.maxsize:
            self._data.popitem(last=False)


class VideoRepository:
    def __init__(self, vss: VSSClient | None = None, ttl_s: float = 60.0):
        self.vss = vss or get_vss()
        self.ttl_s = ttl_s
        self._sources_cache: tuple[float, list[VideoSource]] | None = None
        self._segments = _LRU(64)
        self._detections = _LRU(128)  # source_uri → raw sidecar (pixel xyxy preserved)
        self._explore_index: dict[str, dict[str, Any]] | None = None  # original_video → row

    async def list_sources(self, *, force: bool = False) -> list[VideoSource]:
        now = time.time()
        if (
            not force
            and self._sources_cache
            and now - self._sources_cache[0] < self.ttl_s
        ):
            return self._sources_cache[1]
        rows = await self.vss.explore_all()
        by_cam: dict[str, VideoSource] = {}
        explore_index: dict[str, dict[str, Any]] = {}
        for row in rows:
            cam = str(row.get("camera_id") or "unknown")
            ref = video_ref_from_explore(row)
            explore_index[ref.original_video] = row
            if cam not in by_cam:
                loc = str(row.get("location") or "")
                cap = str(row.get("capture_type") or "")
                by_cam[cam] = VideoSource(
                    id=cam,
                    camera_id=cam,
                    location=loc,
                    capture_type=cap,
                    label=_label_for_camera(cam, loc, cap),
                    videos=[],
                    segment_count=0,
                    domain_hint_from_metadata=cap or None,
                    status="unconfigured",
                )
            src = by_cam[cam]
            if not src.location and row.get("location"):
                src.location = str(row["location"])
            if not src.capture_type and row.get("capture_type"):
                src.capture_type = str(row["capture_type"])
            src.videos.append(ref)
            src.segment_count += int(ref.total_segments or 0)
        # Prefer recent uploads first within each source
        for src in by_cam.values():
            src.videos.sort(key=lambda v: v.uploaded_at or "", reverse=True)
        sources = sorted(by_cam.values(), key=lambda s: (-s.segment_count, s.camera_id))
        self._sources_cache = (now, sources)
        self._explore_index = explore_index
        return sources

    async def get_source(self, source_id: str) -> VideoSource | None:
        for s in await self.list_sources():
            if s.id == source_id or s.camera_id == source_id:
                return s
        return None

    async def segments_for_video(
        self, original_video: str, *, with_detections: bool = False
    ) -> list[VideoSegment]:
        cached = self._segments.get(original_video)
        if cached is not None:
            segs: list[VideoSegment] = cached
        else:
            raw = await self.vss.tools_segments(original_video)
            rows = raw.get("segments") or []
            segs = [VideoSegment.from_vss_segment(r) for r in rows]
            segs.sort(key=lambda s: (s.t_start, s.index))
            self._segments.set(original_video, segs)
        if with_detections:
            out = []
            for seg in segs:
                out.append(await self.enrich_segment_detections(seg))
            return out
        return list(segs)

    async def segments_for_source(
        self, source_id: str, *, video: str | None = None, with_detections: bool = False
    ) -> list[VideoSegment]:
        src = await self.get_source(source_id)
        if not src:
            return []
        if video:
            return await self.segments_for_video(video, with_detections=with_detections)
        # Default: first (most recent) parent video — keep response bounded
        if not src.videos:
            return []
        return await self.segments_for_video(
            src.videos[0].original_video, with_detections=with_detections
        )

    async def sample_segments(
        self, source_id: str, n: int = 12, *, with_detections: bool = False
    ) -> list[VideoSegment]:
        """Spread samples across parent videos and time."""
        src = await self.get_source(source_id)
        if not src or not src.videos:
            return []
        videos = src.videos[: max(1, min(len(src.videos), 6))]
        per = max(1, n // len(videos))
        out: list[VideoSegment] = []
        for ref in videos:
            segs = await self.segments_for_video(ref.original_video, with_detections=False)
            if not segs:
                continue
            if len(segs) <= per:
                picked = segs
            else:
                step = max(1, len(segs) // per)
                picked = [segs[i] for i in range(0, len(segs), step)][:per]
            out.extend(picked)
            if len(out) >= n:
                break
        out = out[:n]
        if with_detections:
            return [await self.enrich_segment_detections(s) for s in out]
        return out

    async def get_detections_raw(self, source_uri: str) -> dict[str, Any] | None:
        """Raw YOLO sidecar with pixel xyxy boxes (cached)."""
        cached = self._detections.get(source_uri)
        if cached is not None:
            return cached or None
        try:
            data = await self.vss.detections(source_uri)
        except Exception as e:  # noqa: BLE001
            log.info("detections fetch failed: %s", type(e).__name__)
            data = None
        self._detections.set(source_uri, data or {})
        return data

    @staticmethod
    def detection_summary_from_sidecar(sidecar: dict[str, Any] | None) -> DetectionSummary | None:
        if not sidecar:
            return None
        raw_counts = sidecar.get("object_counts") or {}
        if isinstance(raw_counts, str):
            import json as _json

            try:
                raw_counts = _json.loads(raw_counts) if raw_counts.strip() else {}
            except _json.JSONDecodeError:
                raw_counts = {}
        classes = {str(k): int(v) for k, v in (raw_counts or {}).items()} if isinstance(raw_counts, dict) else {}
        # Never invent a YOLO "forklift" class — COCO has none.
        classes.pop("forklift", None)
        frames = sidecar.get("frames") or []
        return DetectionSummary(
            classes=classes,
            frames_sampled=int(sidecar.get("frame_count") or len(frames) or 0),
            has_sidecar=True,
        )

    async def enrich_segment_detections(self, seg: VideoSegment) -> VideoSegment:
        sidecar = await self.get_detections_raw(seg.source_uri)
        if not sidecar:
            return seg
        summary = self.detection_summary_from_sidecar(sidecar)
        if summary:
            # Merge class max-counts; prefer sidecar.
            if seg.yolo and seg.yolo.classes:
                merged = dict(seg.yolo.classes)
                for k, v in summary.classes.items():
                    merged[k] = max(int(merged.get(k, 0)), int(v))
                merged.pop("forklift", None)
                summary.classes = merged
            seg = seg.model_copy(update={"yolo": summary})
        return seg

    def bbox_frames(self, source_uri: str) -> list[dict[str, Any]]:
        """Cached pixel-xyxy frame detections for rules.bbox_proximity.

        Each frame: {frame_index, time_sec, detections:[{label, confidence, bbox:[x1,y1,x2,y2]}]}.
        Gaps must be normalized by frame diagonal (H²+W²)^0.5 — never invent captured_at.
        """
        raw = self._detections.get(source_uri)
        if not raw:
            return []
        return list(raw.get("frames") or [])

    async def ensure_bbox_frames(self, source_uri: str) -> list[dict[str, Any]]:
        """Fetch sidecar if needed, then return preserved per-frame pixel xyxy boxes."""
        await self.get_detections_raw(source_uri)
        return self.bbox_frames(source_uri)

    def video_shape(self, source_uri: str) -> tuple[int, int] | None:
        """(H, W) from sidecar for bbox_proximity diagonal normalization."""
        raw = self._detections.get(source_uri)
        if not raw:
            return None
        shape = raw.get("video_shape")
        if isinstance(shape, (list, tuple)) and len(shape) >= 2:
            return int(shape[0]), int(shape[1])
        return None

    @staticmethod
    def frame_diagonal(video_shape: tuple[int, int] | None) -> float:
        if not video_shape:
            return 1.0
        h, w = video_shape
        return float((h * h + w * w) ** 0.5) or 1.0

    async def _ensure_explore_index(self) -> dict[str, dict[str, Any]]:
        if self._explore_index is None:
            await self.list_sources(force=True)
        return self._explore_index or {}

    async def find_other_angles(
        self,
        *,
        filename: str | None = None,
        original_video: str | None = None,
        t_start: float = 0.0,
        t_end: float = 5.0,
        exclude_original: str | None = None,
    ) -> list[dict[str, Any]]:
        """Other parents sharing run_N_seed_M with a different eye_*/ceiling_* view.

        Returns Evidence-like dicts with role \"angle\" and camera_view for Intel/UI.
        Overlapping segment by time is chosen; empty list if no siblings.
        """
        index = await self._ensure_explore_index()
        if not filename and original_video:
            row = index.get(original_video) or {}
            filename = str(row.get("filename") or "")
            exclude_original = exclude_original or original_video
        run_seed, own_view = parse_run_seed_view(filename)
        if not run_seed:
            return []
        siblings: list[tuple[str, str, dict[str, Any]]] = []
        for ov, row in index.items():
            if exclude_original and ov == exclude_original:
                continue
            fn = str(row.get("filename") or "")
            rs, view = parse_run_seed_view(fn)
            if rs != run_seed or not view or view == own_view:
                continue
            siblings.append((ov, view, row))
        out: list[dict[str, Any]] = []
        for ov, view, _row in siblings:
            segs = await self.segments_for_video(ov)
            if not segs:
                continue
            # Pick segment overlapping [t_start, t_end]
            best = None
            for seg in segs:
                if seg.t_end <= t_start or seg.t_start >= t_end:
                    continue
                best = seg
                break
            if best is None:
                # Fallback: nearest by start time
                best = min(segs, key=lambda s: abs(s.t_start - t_start))
            # Use Evidence contract from eb5cf00 (role="angle" + camera_view).
            ev = Evidence(
                role="angle",
                camera_view=view,
                segment=best.source_uri,
                t_start=best.t_start,
                t_end=best.t_end,
                caption=best.caption,
                yolo=best.yolo,
                clip_url=f"api/clip?source={best.source_uri}",
                camera_id=best.camera_id or None,
            )
            row_out = ev.model_dump()
            # Extra discovery metadata for Intel (not on Evidence schema).
            row_out["original_video"] = ov
            row_out["run_seed"] = run_seed
            out.append(row_out)
        out.sort(key=lambda d: d.get("camera_view") or "")
        return out

    async def search_hits(
        self,
        query: str,
        *,
        source_id: str | None = None,
        top_k: int = 15,
        min_similarity: float = 0.3,
    ) -> list[dict[str, Any]]:
        filters: dict[str, Any] | None = None
        if source_id:
            filters = {"camera_id": source_id}
        data = await self.vss.search(
            query,
            top_k=top_k,
            min_similarity=min_similarity,
            metadata_filters=filters,
        )
        hits: list[dict[str, Any]] = []
        index = self._explore_index or {}
        for row in data.get("results") or []:
            seg = VideoSegment.from_vss_segment(row)
            if not seg.camera_id and seg.original_video:
                # Some search rows omit camera_id; recover it from the parent video (explore index).
                if not index:
                    index = await self._ensure_explore_index()
                seg.camera_id = str((index.get(seg.original_video) or {}).get("camera_id") or "")
            sim = row.get("similarity_score")
            try:
                sim_f = float(sim) if sim is not None else None
            except (TypeError, ValueError):
                sim_f = None
            hits.append(
                Evidence(
                    role="related",
                    segment=seg.source_uri,
                    t_start=seg.t_start,
                    t_end=seg.t_end,
                    caption=seg.caption,
                    yolo=seg.yolo,
                    clip_url=f"api/clip?source={seg.source_uri}",
                    camera_id=seg.camera_id or None,
                    similarity=sim_f,
                ).model_dump()
                | {"original_video": seg.original_video or None}
            )
        return hits


_repo: VideoRepository | None = None


def get_repository() -> VideoRepository:
    global _repo
    if _repo is None:
        _repo = VideoRepository()
    return _repo
