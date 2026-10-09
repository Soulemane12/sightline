# Cross-team requests (append-only)

Format: `[from → to] what / why`

- [Laptop/Frontend → Backend-Intel] **Other angles.** Warehouse (`sdg_warehouse_cam-2`) clips are 10 s (2 segments), so before/after inside one clip is thin. Filenames carry a scenario id `run_<N>_seed_<M>` plus a camera view (`eye_00`, `eye_01`, `ceiling_01`, …). In `investigate.py`, find other parents with the same `run_N_seed_M`, take their segment overlapping the event time, and add them to `incident.evidence` with `role: "angle"`, `camera_view: "<view>"` (plus the usual segment/t_start/t_end/caption/clip_url). The UI already renders these as "Other angles of the same moment". If no other views of the same run exist, add nothing.
- [Laptop/Frontend → Backend-Data] Real field names from P1: `segment_start_sec`/`segment_end_sec`/`reasoning_content`/`object_classes`/`object_counts` (JSON string); explore key `chunks`. Map them to the UI contract (ARCHITECTURE §5a: `t_start`, `t_end`, `caption`, `yolo.classes`). Set `segment_seconds: 5` on sources.
