# P1 recon notes (QA) — 2026-10-09

Fixtures live under `sightline/fixtures/` (gitignored). Full answers in `planning/HACKATHON_UNKNOWN.md`.

## Health
- VSS login OK (`team-22`); dashboard `pipeline_alignment.healthy=true`, `pending_index=0`.
- GPU: Cosmos / Embed1 / YOLO / Canary all pass skill health matrix.
- Cosmos live model id: `nvidia/cosmos3-nano-reasoner` (not `cosmos3-reason`).

## Inventory (explore paged 612)
| camera_id | parents | segments | location | capture |
|---|---:|---:|---|---|
| pie_cam-3 | 180 | 1080 | toronto | streets |
| nyc_bike_gopro-1 | 78 | 465 | new_york | streets |
| nyc_streets_cam-1 | 60 | 360 | new_york | streets |
| neighborhood_cam-1 | 52 | 307 | neighborhood | streets |
| nyc_streets_cam-2 | 30 | 180 | new_york | traffic |
| sf_streets_cam-2/4/5 | 30 each | 180 | san_francisco | streets |
| smartspace_cam-1 | 30 | 180 | indoor | crowds |
| sdg_warehouse_cam-2 | 30 | 60 | warehouse3 | warehouse |
| i24_cam-1 | 30 | 180 | nashville | traffic |
| sf_streets_cam-1 | 25 | 148 | san_francisco | streets |
| sf_streets_cam-3 | 7 | 37 | san_francisco | streets |

## Segments / detections
- Segment duration **5 s**; fields `segment_start_sec` / `segment_end_sec` / `reasoning_content`.
- Rows include `object_classes` + counts; detections sidecar is pixel xyxy @ 30 fps.
- No YOLO `forklift` class (caption-only for forklifts).

## Search (person–vehicle)
- Best: forklift near person → warehouse (sim ~0.5+).
- Best secondary: pedestrian crossing in front of car → nyc_streets_cam-1 (~0.39).
- Generic “person close to a moving vehicle” was weak (neighborhood cars).

## W&B / Cosmos / VastDB
- Prefer `nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B`; fallback `meta-llama/Llama-3.3-70B-Instruct`.
- `response_format=json_object` works; ~0.4–1.2 s.
- W&B: use curl/httpx with User-Agent (raw urllib → CF 1010).
- Cosmos text ~0.4 s; JPEG `image_url` ~0.7 s.
- VastDB: `sightline.probe` created; insert/select OK (~0.1 s).

## Not done (by design)
- No re-ingest, no app code, no P2 deploy.
