# Sightline: Live Unknowns (resolve Friday morning)

QA fills the **Answer** column during P1/P2. The lead writes decisions at the top. Anything still blank at 10:30 gets its fallback by default.

## Decisions (LOCKED)
- **D1 primary:** `sdg_warehouse_cam-2` / warehouse3
- **D1 secondary:** `nyc_streets_cam-1` / new_york / streets
- **D1 optional negative:** `smartspace_cam-1`
- **Runtime overrides (locked):** Cosmos model `nvidia/cosmos3-nano-reasoner`; YOLO has **no forklift** (forklift = Cosmos/captions/LLM); W&B primary `nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B`, fallback `meta-llama/Llama-3.3-70B-Instruct`; W&B calls need **User-Agent**
- **Reserved chunks:** early = TBD by lead · demo_reserved = TBD
- **In-pod VSS URL:** `http://video-backend-service:8000` (public Ingress hostname does **not** resolve inside pods)
- **Differences from ARCHITECTURE.md:** see P0b; plus in-pod VSS must use ClusterIP Service, not `$INGRESS_URL`

## P0b staleness (doc → reality → fix)

| # | Doc assumption | Reality | Fix |
|---|---|---|---|
| S1 | `PROJECT_CONTEXT.md`: team is solo | Team **22**, 3-station plan in `BUILD_DAY_PLAN.md` §1b; `/config/team-22.config` | Treat §1b as source of truth for team ops; update PROJECT_CONTEXT when Architect edits |
| S2 | Cosmos model `nvidia/cosmos3-reason` | Live `/v1/models` id = **`nvidia/cosmos3-nano-reasoner`** | Always resolve model id from `/v1/models` (smoke-test skill pattern) |
| S3 | GPU URLs in env / team config | `COSMOS3_*` / `YOLO_*` / `CANARY_*` **not** in `team-22.config`; skill hardcodes `GPU_HOST=166.19.38.112` | Follow `gpu/model-health` skill; optional env overrides if set |
| S4 | WANDB keys in team config | `WANDB_*` present in **VM env**, absent from `team-22.config` | Read from env for app Secret; do not expect them in `.config` |
| S5 | Old kubeconfig path `/config/kubeconfig` | Skill: `KUBECONFIG=/config/${NS}-k8s.yaml` → `/config/team-22-k8s.yaml` | Skill wins (ARCHITECTURE §3 already notes this) |
| S6 | Explore returns `videos` | Response key is **`chunks`** (+ `total`, timelines, metadata) | Map `chunks` → sources in `repository.py` |
| S7 | Segment timing `t_start`/`t_end` / caption field | Fields: `segment_start_sec`, `segment_end_sec`, `duration`, caption in **`reasoning_content`** | Architect: freeze models from fixtures |
| S8 | VM has pip/venv ready | No system `pip` / `ensurepip`; `python3 -m venv` fails without `python3.12-venv` | Use `get-pip.py --user --break-system-packages` or install venv package; note for deploy image (`python:3.12-slim` has pip) |
| S9 | W&B OpenAI Python client “just works” | Bare `urllib` without User-Agent → Cloudflare **1010**; `curl` + UA works | Set a User-Agent (or use `openai`/`httpx` with UA) in `llm.py` |
| S10 | “No app code before Friday” | `sightline/app/{index,app,styles,mock}.*` already on `main` | Frontend ahead of schedule; QA still owns deploy later — do not rewrite UI in P1 |
| S11 | `gh` available for GitHub | **`gh` not installed** on VM | PAT / credential helper for push (per §1b) |
| S12 | ~8 GB RAM | **9.7 GiB** total; ~7.5 GiB available during P1 | Still cap concurrent agents; check `free -h` before 3rd seat |
| S13 | YOLO has forklift class | COCO only — **no forklift** in `objects[]` / detections; captions still say “forklift” | Entity map: forklift → caption/LLM, not YOLO label |
| S14 | App open via ingress URL | Skill: humans use **https://workshop.thecosmoslabs.com → App**; Ingress host `video-lab-team-22.cosmos.vastdata.com` path `/app` | Never demo via `$INGRESS_URL` |
| S15 | Pod `VSS_URL=$INGRESS_URL` | Public host `video-lab-team-22.cosmos.vastdata.com` → DNS **Errno -5** in pod | Secret uses `http://video-backend-service:8000` |

Official repo HEAD at recon: `0c6b756` (matches planning pin). Skills layout matches `.cursor/README.md`.

## A. Corpus and index

| # | Unknown | Why it matters | How to resolve | Fallback | Answer |
|---|---|---|---|---|---|
| A1 | Which camera_ids are actually indexed, with clip counts | Picks demo sources | P1: explore all + dashboard metadata | traffic-first plan | **13 cameras**, 612 parents / 3537 segments. Counts (parents/segs): `pie_cam-3` 180/1080; `nyc_bike_gopro-1` 78/465; `nyc_streets_cam-1` 60/360; `neighborhood_cam-1` 52/307; `nyc_streets_cam-2` 30/180; `sf_streets_cam-{2,4,5}` 30/180 each; `smartspace_cam-1` 30/180; `sdg_warehouse_cam-2` 30/60; `i24_cam-1` 30/180; `sf_streets_cam-1` 25/148; `sf_streets_cam-3` 7/37. Pipeline `healthy=true`, `pending_index=0`. |
| A2 | Warehouse (`sdg_warehouse_cam-2`) present? Captions mention forklifts? | Primary domain choice | search "forklift near a person in an aisle"; read 5 captions | highway/dashcam primary | **Yes.** 30 parents / 60 segs. Captions clearly describe person + blue/black ATLAS forklift; search sim 0.48–0.58. |
| A3 | Indoor smart-space and SF street cams present? | Third domain | explore | skip | **Yes.** `smartspace_cam-1` (indoor/crowds); SF `sf_streets_cam-1..5` present. |
| A4 | Segment length (s) and segments per chunk | N±2 window, replay speed, triptych | `tools/segments` timings | assume 5 s | **5.0 s** segments. Warehouse chunks often **10 s → 2 segs**; street/dashcam often **30 s → 6 segs**. |
| A5 | `tools/segments` response fields (order index, t_start/t_end, caption field name) | `repository.py` mapping | fixture | `videos/metadata` per segment | Shape `{original_video,total,segments[]}`. Per seg: `segment_number`, `segment_start_sec`, `segment_end_sec`, `duration`, `reasoning_content`, `object_classes`, `object_counts`, detection sidecar fields, camera metadata. Fixture: `segments_sdg_warehouse_cam-2.json`, `segments_nyc_streets_cam-1.json`. |
| A6 | Do segment rows include YOLO classes/counts, or only the detections sidecar? | rules without extra calls | `videos/metadata` fixture | sidecar per segment (cache) | **Both.** Rows include `object_classes` + `object_counts` JSON string; sidecar also available via `/videos/detections`. |
| A7 | Detections sidecar format: frames sampled, box format, normalized? | `bbox_proximity` | fixture | caption-only proximity | `{source, video_shape:[H,W], fps, frame_count, frames:[{frame_index,time_sec,shape,detections:[{label,confidence,bbox:[x1,y1,x2,y2]}]}]}`. **Pixel xyxy** (not normalized); 30 fps; ~150 frames / 5 s seg. |
| A8 | Which YOLO classes appear in `objects[]` | entity map | dashboard fixture | COCO defaults | person, car, traffic light, truck, bicycle, bus, handbag, backpack, motorcycle, fire hydrant, clock, bench, potted plant, suitcase, skateboard, cell phone, umbrella, stop sign, parking meter, chair, train, airplane, kite, horse, tv. **No forklift.** |
| A9 | Wall-clock timestamp per segment? | after-hours rule, timeline labels | metadata fixture | video-relative times only | **`upload_timestamp`** (ingest time) only. Playback timing is video-relative `segment_start_sec`/`segment_end_sec`. No true capture wall-clock. |
| A10 | Scenario presets live (`ingest-config`) and the custom prompt limit | prompt generator | `GET /metadata/ingest-config` | 800 chars | **`custom_prompt_max_length`: 800**. Scenarios include warehouse, traffic, live_driving, nhl, sports, retail, nyc_*, etc. |
| A11 | Any sports/NHL/retail footage indexed? | sports or retail demo | explore / search "basketball", "store shelf" | self-recorded or architecture-only | **No real sports/NHL hits** (basketball/hockey searches garbage or empty). Retail/shelf weak (smartspace shelves only). Sports/retail lanes need self-recorded upload. |

## B. Re-ingest and upload

| # | Unknown | Why | How | Fallback | Answer |
|---|---|---|---|---|---|
| B1 | Wall time for a 1-chunk re-ingest | demo timing, R2 start time | R1 stopwatch | assume 20 min | **Deferred** (no re-ingest in P1). |
| B2 | Does the detailed (sectioned) prompt get followed? Is the FLAGS line present? | `caption_flag` primitive | R1 caption diff | baseline prose prompt; caption_terms only | **Deferred** (R1). |
| B3 | Does job status expose progress fields as documented? | stepper UI | R1 polling | dashboard `pipeline_alignment` | **Deferred** (R1). |
| B4 | Upload size limit and allowed types | new-footage lane | `GET /api/v1/config` | ≤ 25 MB clips | **`app.max_upload_size_mb`: 100**. Fixture `config.json` (secrets redacted). |
| B5 | Upload → indexed latency for a 20–30 s clip | new-footage demo beat | test upload of a staged clip (is_public false) | show plan + prompt only | **Not tested** in P1 (no upload yet). |
| B6 | Can an uploaded video get our custom_prompt (and does it show in captions)? | "prompt before indexing" story | B5 test | scenario preset | **Not tested** in P1. |

## C. Models

| # | Unknown | Why | How | Fallback | Answer |
|---|---|---|---|---|---|
| C1 | W&B models available to our key | planner quality | `client.models.list()` | Llama 3.3 70B / Nemotron | **20 models** incl. Nemotron-3-Ultra-550B, gpt-oss-120b, DeepSeek-V3.1/V4, Llama-3.3-70B, Qwen3.x, Kimi-K2.6, etc. Fixture `wandb_json_probe.json`. |
| C2 | JSON reliability: `response_format=json_object` support? | `structured()` | P1 test | extract + repair retry | **Yes** on Nemotron Ultra, gpt-oss-120b, Llama-3.3-70B, DeepSeek-V3.1 (all parsed_ok with `json_object`). |
| C3 | W&B latency (p50) and rate limits | batching sizes, timeouts | P1 timing | batch 8, 45 s timeout | Observed ~**0.4–1.2 s** with `json_object` (Llama ~0.9 s, Nemotron ~1.2 s, DeepSeek ~0.7 s). Rate limits not hit in recon. |
| C4 | Cosmos3-Reason latency (text, 1 image, 5 s clip) | second look, live mode | P1 timing | skip second look | Model **`nvidia/cosmos3-nano-reasoner`**. Text ~**0.41 s**; 1 JPEG `image_url` ~**0.71 s**. 5 s clip not timed. |
| C5 | Does Cosmos accept `image_url`? Multiple images? Max video payload? | live + new-footage keyframes | P1 test | send a short clip; or skip live | **`image_url` works** (data JPEG). Multi-image / max video payload not stress-tested. |
| C6 | Does YOLO `/v1/infer` accept images or non-mp4 video? | live gate | test a JPEG / webm | JS motion gate only | **Not tested** in P1 (health only: `/healthz` ok). |
| C7 | GPU auth: is `GPU_BEARER_TOKEN` set? Do env URLs match the skill's host? | `gpu_client` config | env names + health | follow the skill | **Token set.** URL env vars not in config; skill host `166.19.38.112` ports 8001–8004. All 4 models **healthy**. |
| C8 | Canary reachable; WAV format accepted | audio lane | health + tiny WAV | drop audio | **Health ready+live 200.** WAV transcription not exercised in P1. |

## D. Deployment and network

| # | Unknown | Why | How | Fallback | Answer |
|---|---|---|---|---|---|
| D1 | `/app` hello deploy works (namespace, ingress class, rewrite) | everything | P2 | port-forward demo | **PASS.** `deploy/deploy.sh` → Deployment/Service/Ingress `sightline` in `team-22`; path `/app(/|$)(.*)`; rewrite `/$2`; curl `http://video-lab-team-22.cosmos.vastdata.com/app/health` → 200. Humans: workshop **App** button. |
| D2 | Pod egress: PyPI, W&B API, GPU endpoints, VSS from inside the pod | runtime deps | `/api/probe` | vendor-free stdlib server; call VSS by `INGRESS_URL` | **PASS** with in-cluster VSS. Probe all-green: vss_login, cosmos_ready, yolo_healthz, wandb_models (20), vastdb_probe (rows=1). PyPI works (pip at start). Public `$INGRESS_URL` hostname fails DNS in-pod → use `video-backend-service:8000`. |
| D3 | Pod startup time with requirements installed (with and without weave) | rollout speed | time P2 | drop weave | **~50–52 s** rollout wait (pip install fastapi/httpx/vastdb/pyarrow, no weave). Ready 1/1. |
| D4 | Is the page served over HTTPS **top-level** (not in an iframe without `allow="camera"`) when opened via the App button? | getUserMedia secure context | open the App button; check `location.href` on the hello page | Chrome insecure-origin flag for the origin used | **Needs laptop check.** Hello page prints `location.href` + BASE. Cluster HTTP `/app` works; workshop App is the human HTTPS path. |
| D5 | Ingress annotations honored (body size, timeouts, buffering) | uploads, clip streaming | upload a 20 MB file to a test route | smaller uploads via VSS directly | Annotations applied (`proxy-body-size 200m`, timeouts 120, buffering off). Upload stress **not** tested yet. |
| D6 | Does the App button work from the laptop (Cloudflare Access login), and can judges reach it? | demo from laptop | open https://workshop.thecosmoslabs.com → App | demo in the VM browser; video | **Needs human.** Lead: open workshop → **App**. |
| D7 | Do CDN scripts load in the viewer's browser? | frontend libs | no CDN needed by design | vanilla only | Design remains **vanilla / no CDN required**. |
| D8 | VastDB custom tables work **from the VM** (create `sightline` schema, insert, select) | durable state + VAST story | P1 step 7 (`vast-database` skills) | seed_state.json | **Yes.** Created `sightline.probe`; insert/select OK. **Also OK from pod** via `/api/probe`. |
| D12 | App button mechanics: new tab vs iframe, final URL, **path prefix**, request size and timeout limits through the portal | frontend `BASE`, uploads | hello page shows `location.href`; upload a test file | keep runtime `BASE`; smaller uploads | **Needs laptop.** Hello page JS derives BASE from `location.pathname`. Cluster path prefix is `/app`. |
| D13 | VastDB reachable **from inside the pod** (data VIP), and pod startup time with `vastdb` + `pyarrow` | store backend | `api/probe` in P2 | `/tmp` + seed store; drop pyarrow if startup > 90 s | **PASS.** In-pod select on `sightline.probe` ok (~0.3–0.4 s). Startup ~50 s with vastdb+pyarrow (< 90 s). |
| D9 | Clipboard paste into the VM terminal works? | prompt sheet | try | "read BUILD_DAY_PLAN.md and run P#" | Used file-read prompts successfully this session. |
| D10 | How many Cursor `agent` sessions fit on the 4 vCPU / 8 GB VM (RAM, credits)? | parallel seats | `free -h` with 2, then 3 sessions running | 3 seats (default); 2 if memory is tight | **4 vCPU / 9.7 GiB.** During P1 ~7.5 GiB available — start with **2** agents, add 3rd only if free stays >2.5 GiB. |
| D11 | `gh` on the VM / GitHub push works | backups, submission | `gh auth status` | PAT | **`gh` missing** → use PAT / git credential for `origin` (`Soulemane12/sightline`). |

## E. Event logistics

| # | Unknown | Why | How | Answer |
|---|---|---|---|---|
| E1 | Final submission form: exact fields and video length limits | submission | tokens& → **Submit your project** (live now); open it at 8:30 | Known: repo, demo video link, description, tools, names and emails; site and screenshot optional |
| E6 | Team number assignment for a solo builder | VM team select (once only) | ask the coordinator before selecting | **Team 22** (shared VM index). |
| E7 | Do you hold one of the first 100 build-environment seats? | everything | arrive 8:00–8:15 | Assumed yes (recon running on VM). |
| E2 | Judging format: table walkthrough length; finalist stage demo? | demo length | ask an organizer at 9:00 | |
| E3 | Demo duration per team | script cut | ask | |
| E4 | Are uploaded self-recorded clips OK? (licensing) | new-footage lane | ask an organizer | Official README allows self-recorded via upload-video; confirm if needed. |
| E5 | Are pre-written planning docs OK? (they are not code) | rules | confirm with an organizer if in doubt | Planning-only prep is allowed per tokens& / our docs. |

## P1 recon finish line

- **Indexed cameras + counts:** see A1 (612 parents, 3537 segs, pipeline healthy).
- **Segment length:** 5 s (2 segs/10 s warehouse chunk; 6 segs/30 s street chunk).
- **Recommended primary:** `sdg_warehouse_cam-2` — strongest person–vehicle (worker↔forklift) captions.
- **Recommended secondary:** `nyc_streets_cam-1` — pedestrian/crosswalk ↔ car/truck, clear captions + rich YOLO person/car boxes.
- **Strongest clips:** warehouse forklift+person (sim≈0.51–0.58); NYC crosswalk pedestrians with vehicles (sim≈0.39); SF crosswalk near-miss-ish (sim≈0.29) as backup.
- **Blockers for later:** no re-ingest yet (B1–B3); W&B clients need User-Agent; no system pip/venv (dev only); `gh` absent; YOLO cannot label forklifts; sports/retail not in index; P2 deploy / App-button HTTPS still open.

## P2 hello deploy
- Deployed `sightline` via ConfigMap (no Docker). Rollout ~50s. `/app/health` 200; `/api/probe` all-green with in-cluster VSS.
- `scripts/gen_prompt.py sdg_warehouse_cam-2` → Nemotron Ultra, **563 chars** Cosmos prompt (FLAGS + forklift motion/proximity).
