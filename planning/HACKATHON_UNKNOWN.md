# Sightline: Live Unknowns (resolve Friday morning)

QA fills the **Answer** column during P1/P2. The lead writes decisions at the top. Anything still blank at 10:30 gets its fallback by default.

## Decisions
- **D1 (10:00) primary source:** ______  **secondary:** ______  **optional third:** ______
- **Reserved chunks:** early = ______ · demo_reserved = ______
- **W&B model:** ______ (fallback model: ______)
- **Differences from ARCHITECTURE.md found in recon:** ______

## A. Corpus and index

| # | Unknown | Why it matters | How to resolve | Fallback | Answer |
|---|---|---|---|---|---|
| A1 | Which camera_ids are actually indexed, with clip counts | Picks demo sources | P1: explore all + dashboard metadata | traffic-first plan | |
| A2 | Warehouse (`sdg_warehouse_cam-2`) present? Captions mention forklifts? | Primary domain choice | search "forklift near a person in an aisle"; read 5 captions | highway/dashcam primary | |
| A3 | Indoor smart-space and SF street cams present? | Third domain | explore | skip | |
| A4 | Segment length (s) and segments per chunk | N±2 window, replay speed, triptych | `tools/segments` timings | assume 5 s | |
| A5 | `tools/segments` response fields (order index, t_start/t_end, caption field name) | `repository.py` mapping | fixture | `videos/metadata` per segment | |
| A6 | Do segment rows include YOLO classes/counts, or only the detections sidecar? | rules without extra calls | `videos/metadata` fixture | sidecar per segment (cache) | |
| A7 | Detections sidecar format: frames sampled, box format, normalized? | `bbox_proximity` | fixture | caption-only proximity | |
| A8 | Which YOLO classes appear in `objects[]` | entity map | dashboard fixture | COCO defaults | |
| A9 | Wall-clock timestamp per segment? | after-hours rule, timeline labels | metadata fixture | video-relative times only | |
| A10 | Scenario presets live (`ingest-config`) and the custom prompt limit | prompt generator | `GET /metadata/ingest-config` | 800 chars | |
| A11 | Any sports/NHL/retail footage indexed? | sports or retail demo | explore / search "basketball", "store shelf" | self-recorded or architecture-only | |

## B. Re-ingest and upload

| # | Unknown | Why | How | Fallback | Answer |
|---|---|---|---|---|---|
| B1 | Wall time for a 1-chunk re-ingest | demo timing, R2 start time | R1 stopwatch | assume 20 min | |
| B2 | Does the detailed (sectioned) prompt get followed? Is the FLAGS line present? | `caption_flag` primitive | R1 caption diff | baseline prose prompt; caption_terms only | |
| B3 | Does job status expose progress fields as documented? | stepper UI | R1 polling | dashboard `pipeline_alignment` | |
| B4 | Upload size limit and allowed types | new-footage lane | `GET /api/v1/config` | ≤ 25 MB clips | |
| B5 | Upload → indexed latency for a 20–30 s clip | new-footage demo beat | test upload of a staged clip (is_public false) | show plan + prompt only | |
| B6 | Can an uploaded video get our custom_prompt (and does it show in captions)? | "prompt before indexing" story | B5 test | scenario preset | |

## C. Models

| # | Unknown | Why | How | Fallback | Answer |
|---|---|---|---|---|---|
| C1 | W&B models available to our key | planner quality | `client.models.list()` | Llama 3.3 70B / Nemotron | |
| C2 | JSON reliability: `response_format=json_object` support? | `structured()` | P1 test | extract + repair retry | |
| C3 | W&B latency (p50) and rate limits | batching sizes, timeouts | P1 timing | batch 8, 45 s timeout | |
| C4 | Cosmos3-Reason latency (text, 1 image, 5 s clip) | second look, live mode | P1 timing | skip second look | |
| C5 | Does Cosmos accept `image_url`? Multiple images? Max video payload? | live + new-footage keyframes | P1 test | send a short clip; or skip live | |
| C6 | Does YOLO `/v1/infer` accept images or non-mp4 video? | live gate | test a JPEG / webm | JS motion gate only | |
| C7 | GPU auth: is `GPU_BEARER_TOKEN` set? Do env URLs match the skill's host? | `gpu_client` config | env names + health | follow the skill | |
| C8 | Canary reachable; WAV format accepted | audio lane | health + tiny WAV | drop audio | |

## D. Deployment and network

| # | Unknown | Why | How | Fallback | Answer |
|---|---|---|---|---|---|
| D1 | `/app` hello deploy works (namespace, ingress class, rewrite) | everything | P2 | port-forward demo | |
| D2 | Pod egress: PyPI, W&B API, GPU endpoints, VSS from inside the pod | runtime deps | `/api/probe` | vendor-free stdlib server; call VSS by `INGRESS_URL` | |
| D3 | Pod startup time with requirements installed (with and without weave) | rollout speed | time P2 | drop weave | |
| D4 | Is the page served over HTTPS **top-level** (not in an iframe without `allow="camera"`) when opened via the App button? | getUserMedia secure context | open the App button; check `location.href` on the hello page | Chrome insecure-origin flag for the origin used | |
| D5 | Ingress annotations honored (body size, timeouts, buffering) | uploads, clip streaming | upload a 20 MB file to a test route | smaller uploads via VSS directly | |
| D6 | Does the App button work from the laptop (Cloudflare Access login), and can judges reach it? | demo from laptop | open https://workshop.thecosmoslabs.com → App | demo in the VM browser; video | |
| D7 | Do CDN scripts load in the viewer's browser? | frontend libs | no CDN needed by design | vanilla only | |
| D8 | VastDB custom tables work **from the VM** (create `sightline` schema, insert, select) | durable state + VAST story | P1 step 7 (`vast-database` skills) | seed_state.json | |
| D12 | App button mechanics: new tab vs iframe, final URL, **path prefix**, request size and timeout limits through the portal | frontend `BASE`, uploads | hello page shows `location.href`; upload a test file | keep runtime `BASE`; smaller uploads | |
| D13 | VastDB reachable **from inside the pod** (data VIP), and pod startup time with `vastdb` + `pyarrow` | store backend | `api/probe` in P2 | `/tmp` + seed store; drop pyarrow if startup > 90 s | |
| D9 | Clipboard paste into the VM terminal works? | prompt sheet | try | "read BUILD_DAY_PLAN.md and run P#" | |
| D10 | How many Cursor `agent` sessions fit on the 4 vCPU / 8 GB VM (RAM, credits)? | parallel seats | `free -h` with 2, then 3 sessions running | 3 seats (default); 2 if memory is tight | |
| D11 | `gh` on the VM / GitHub push works | backups, submission | `gh auth status` | PAT | |

## E. Event logistics

| # | Unknown | Why | How | Answer |
|---|---|---|---|---|
| E1 | Final submission form: exact fields and video length limits | submission | tokens& → **Submit your project** (live now); open it at 8:30 | Known: repo, demo video link, description, tools, names and emails; site and screenshot optional |
| E6 | Team number assignment for a solo builder | VM team select (once only) | ask the coordinator before selecting | |
| E7 | Do you hold one of the first 100 build-environment seats? | everything | arrive 8:00–8:15 | |
| E2 | Judging format: table walkthrough length; finalist stage demo? | demo length | ask an organizer at 9:00 | |
| E3 | Demo duration per team | script cut | ask | |
| E4 | Are uploaded self-recorded clips OK? (licensing) | new-footage lane | ask an organizer | |
| E5 | Are pre-written planning docs OK? (they are not code) | rules | confirm with an organizer if in doubt | |
