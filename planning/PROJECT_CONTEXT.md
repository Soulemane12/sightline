# Sightline: Project Context

Read this first. Every AI agent working on Sightline should load this file before doing anything.

## What Sightline is

**One-liner:** Sightline is a self-configuring video intelligence agent. It works out what a camera is watching, decides what matters there, configures its own analysis strategy (including its own Cosmos ingestion prompt), monitors for meaningful events, investigates them automatically, and presents the evidence.

**Demo line:** "Most video AI systems need someone to tell them what to look for. Sightline looks at the environment first, decides what matters, configures its own analysis strategy, and starts investigating events automatically."

**North star:** a judge hands Sightline footage from a new environment. Sightline recognizes it, explains what it sees, generates objectives and an analysis prompt, analyzes the footage, detects an event, investigates it and presents evidence. Nobody writes new code for that domain.

**Core loop:** UNDERSTAND → PLAN → RECONFIGURE ANALYSIS → OBSERVE → INVESTIGATE → ACT

## Submission focus: specific use case, general solution (decided 10-08)

The tokens& page tells teams to pick a specific use case: "flag someone missing a hard hat," rather than "watch for safety issues." So Sightline is **submitted and demoed as one concrete use case**, while the architecture stays general.

- **Title:** **Sightline**, *Self-configuring video safety agents*
- **Use case:** autonomous discovery and investigation of **dangerous person–vehicle interactions** (worker ↔ forklift, pedestrian ↔ car, person ↔ passing vehicle), with no operator-written detection rules or search prompts.
- **Why this use case:** it's the organizers' own cross-corpus anchor query ("person close to a moving vehicle"), so the footage supports it best, and it spans several environments, which is exactly where self-configuration shows.
- **Submission north star:** Sightline configures itself to find dangerous person–vehicle interactions, improves the video index when the descriptions lack what it needs, and investigates incidents without a human search prompt.
- **Pitch line:** "For today we applied Sightline to person–vehicle safety. We never configured a warehouse detector or a traffic detector. Sightline looks at the environment, generates its own monitoring strategy and analysis prompt, and investigates relevant events automatically."
- **Specific use case ≠ hard-coded detector.** No `if person and forklift: alert()`. The configurator still classifies, plans, writes prompts and drops or adjusts objectives per camera. Other domains (security, retail, sports, general) stay in `domains.json` and the architecture, but are not the headline.
- **Risk:** person–vehicle conflict was the most crowded SF category (about 7 projects). Self-configuration must come **in the first sentence** of every pitch and the first 15 s of the video. Never open with "near-miss detection".

## What Sightline is NOT

These would all miss the product:

- a search UI
- a clone of the organizers' VSS demo app
- a YOLO dashboard
- a warehouse safety detector
- a chatbot
- a static rules engine
- a hard-coded demo

Warehouse safety, road safety, sports coaching and retail operations are *manifestations* of Sightline, not the product. At SF (Oct 2) about 6 teams built warehouse safety, about 7 built near-miss or pedestrian-vehicle conflict detection, and about 7 built driving edge-case miners. Do not pitch Sightline as any of those.

## Event facts

| Item | Value |
|---|---|
| Event | VAST Builders Challenge: Real-Time Video Agents Hack, NYC |
| Date / place | Fri 2026-10-09, The Maison Projects, 229 W 28th St, 11th floor |
| Schedule | 8:30 doors · 9:00 keynotes · **9:30 build** · 12:30 lunch · **4:30 hard submission deadline and demos** · 6:30 awards |
| **Arrival** | **Build-environment access is limited to the first 100 attendees** (organizer email, 10-08). **Arrive 8:00–8:15.** |
| **ID** | **Physical government-issued photo ID** (driver's license, state ID, passport). Student and digital IDs are not accepted. 18+. |
| Team | Solo (one VM; solo permitted). One project per team. |
| Submit (tokens&) | https://tokensand.com/vastnyc → **Submit your project**. Fields: accessible GitHub repo · short shareable demo video · what you built · tools used · team names and contact emails. A working site and screenshot are optional but welcome. Judges expect a **working prototype**, not a deck. **Personal deadline 4:15.** |
| Judging | First round: judges visit each team for a walkthrough. Criteria not published. |
| Judges | NVIDIA ×2 (one does AI/AV simulation), VAST ×2, CoreWeave ×2, W&B ×1 |
| Prizes | Confirmed on tokens&: 1st NVIDIA DGX Spark; additional Hugging Face Microduck; "more prizes will be announced". (Luma also lists Cursor credits and gift cards, so treat those as unconfirmed.) |

## Rules (non-negotiable)

1. **Build the project during the event.** The tokens& page says so. Before Friday: planning docs only, no app code.
2. **No internet or YouTube footage** (licensing). Self-recorded footage via `ingest/upload-video` is allowed.
3. **Never expose secrets.** Never print `/config/<team>.config`, never run bare `env`/`printenv` (use `env | cut -d= -f1 | sort`), never commit tokens, passwords or W&B keys, never create a repo-local `.env`.
4. **Skills first.** Read the matching `.cursor/skills/**/SKILL.md` before writing any raw API call. They are the API docs.
5. **The deliverable runs on Kubernetes**: Ingress host `video-lab-team-<N>.cosmos.vastdata.com` (N from `$USERNAME`, e.g. `team-11`), path `/app` (deploy skill: `deployment/deploy-app-no-registry`). **People open it via https://workshop.thecosmoslabs.com → the "App" button** (behind a Cloudflare Access login), not by the ingress URL, and never via `$INGRESS_URL`, which is the internal VSS API. Localhost is for development only.
6. **Web app only.** No native or mobile app.
7. **Don't rebuild infrastructure:** no redeploying DataEngine, models or the VSS stack.

## Verified platform facts

Source: official repo `vast-data/vast-builders-challenge` at commit **`0c6b756`** (2026-10-08 20:16 EDT). History: `ca713cd` (10-05) → `e9bbd56` (10-06: `vast-database` skills, workshop App button) → `1ab07e9`/`3557209` (10-06: `build-day-quickstart` skill, infra-onboarding PDF, ask-cosmos hand-off) → `88272ea` (10-08: **kubeconfig path**) → `0c6b756` (10-08: Cursor credits). The repo changes almost daily: `git pull` and diff on Friday, and **where a skill and these docs disagree, the current skill wins**.

### Pipeline (pre-built, already running)
`S3 chunks → Segmenter → S3 segments → Detector (YOLO11s) → Reasoner (Cosmos3-Reason) → Embedder (Cosmos-Embed1, 256-dim) → VastDB writer`. The corpus is pre-ingested, and the Segmenter is not in our path. A scheduled `prompt-suggester` writes suggestions to `vss-prompts-events`.

### Models (shared GPU endpoints on CoreWeave)
| Model | Env var | Notes |
|---|---|---|
| Cosmos3-Reason `nvidia/cosmos3-reason` | `COSMOS3_REASON_URL` | OpenAI-compatible `/v1/chat/completions`; content may include `video_url` as `data:video/mp4;base64,...` |
| YOLO11s (Ultralytics) | `YOLO_URL` | `POST /v1/infer {video_base64, filename, include_frames}`; health is `/healthz` only. Pretrained on COCO, so there is **no forklift or pallet class**. |
| Cosmos-Embed1 | `COSMOS_EMBED1_URL` | `/v1/embeddings` with `request_type`; must stay 256-dim |
| Canary-1B (ASR) | `CANARY_1B_URL` | `POST /v1/audio/transcriptions` (multipart). **Not** in the ingest pipeline. `/v1/models` returning 404 is normal. |

Auth discrepancy: `config.example` says no token is needed, but the gpu skills send `Authorization: Bearer $GPU_BEARER_TOKEN` and hardcode a host IP. Use env vars when they are set, then follow the skill.

### VSS backend API (`$INGRESS_URL/api/v1`, JWT from `POST /auth/login`)
| Need | Route |
|---|---|
| Search | `POST /search` → `results[]` (segments), `chunk_results[]` (per parent video), `llm_synthesis` |
| Q&A | `POST /agent/ask`, `POST /agent/search-and-answer` |
| Browse indexed parents | `GET /videos/explore?scope=all&limit=100&offset=` (has `timeline`, `total_segments`, `stream_id`, `original_video`, `preview_source`, `filename`) |
| **Ordered segments of one video** | `GET /tools/segments?original_video=` (the basis for before/after investigation) |
| One segment row | `GET /videos/metadata?source=` or `GET /tools/segment?source=` |
| YOLO bbox sidecar | `GET /videos/detections?source=` (404 means no sidecar) |
| Whole-video summary | `POST /videos/synthesize` |
| Stats and ingest health | `GET /dashboard/stats` (`objects[]`, `metadata{}`, `pipeline_alignment`, `recent_videos[]`) |
| Filters | `GET /metadata/schema`, `GET /metadata/values?field=`, `GET /metadata/ingest-config` (public; lists scenarios and the 800-char custom prompt limit) |
| Re-ingest | `POST /dashboard/reingest {original_video \| stream_id, chunk_count, scenario?, custom_prompt?, camera_id?, capture_type?, location?}` → `job_id`; poll `GET /dashboard/reingest/<job_id>` |
| Upload new video | `POST /videos/upload` (multipart: `file`, `is_public`, `tags`, `scenario`, `custom_prompt`, `camera_id`, `capture_type`, `location`); size limit comes from `GET /config` |
| Playback | `GET /videos/stream?source=...&token=<JWT>` (Range-capable), `GET /videos/playback-url` |

**These routes do not exist:** `/reports`, `/alerts`, `/analytics`, `/videos/ask`, `/tags`, `/locations`, `/extra-metadata`. Alerts and the event engine are ours to build.

### VastDB direct access (skills `vast-database/vastdb-read`, `vast-database/vastdb-write`), new on 10-06
- The `vastdb` Python SDK (`pip install vastdb pyarrow`) connects to the **data VIP = `S3_ENDPOINT`** with `ACCESS_KEY`/`SECRET_KEY`, scoped to our `VASTDB_BUCKET`. From the VM it's "usually reachable directly, no SSH tunnel". Reachability **from inside our pod** is unverified.
- **We can create our own schema and tables and insert rows** (e.g. schema `sightline`). This is officially intended for "hackathon apps that need custom tables alongside vss-collection". Writes must use the data VIP, never the Query Engine VIP.
- **Never write, drop or recreate `vss-collection` or `vss-prompts-events`** (that breaks VSS search). The skill's `insert.py` refuses them.
- Reads: `query.py` / `list_catalog.py`. Never `select()` all columns on `vss-collection` (vector columns can crash the SDK).
- The skill says not to `source` the team config in **zsh** (`USERNAME` is reserved); parse keys with `grep`, or use bash. Our scripts use `#!/usr/bin/env bash`.
- The skill asks the agent to confirm schema/table names with the user before creating them. Our names are pre-approved in `ARCHITECTURE.md` §9.

### Re-ingest semantics (important)
- It re-runs detect → reason → embed → write on **whole chunks** and **atomically replaces** each segment's row. **The original description is gone afterwards**, so Sightline must snapshot captions *before* re-ingesting.
- The scenario or custom prompt used is **not stored** in the row. Sightline must store its generated prompts itself.
- Custom prompt max is 800 chars, and a custom prompt overrides a scenario. Presets: `surveillance, traffic, live_driving, retail, warehouse, egocentric, sports, nhl, general` (re-list live).
- Docs say "a few minutes". An SF team observed **up to about 20 min**. Always treat it as async.
- A 404 on job status after a backend restart only means the progress record was lost.

### Corpus (documented, not guaranteed live)
| Pack | camera_id | Documented | Domain |
|---|---|---|---|
| A Highway | `i24_cam-1` (nashville) | ~51 multi-cam clips | traffic |
| B Live driving | `pie_cam-3` (toronto) | 6 long drive sets | traffic (dashcam) |
| C Warehouse | `sdg_warehouse_cam-2` (warehouse3) | ~178 ceiling/aisle clips (synthetic "SDG") | warehouse |
| D Neighborhood | `neighborhood_cam-1` | 2 day merges | security/streets |
| E SF streets | `sf_streets_cam-1..4` | "ingesting soon" | security/streets |
| F Smart spaces | `smartspace_cam-1` (indoor) | ~102 clips | security/facility |

The README publicly confirms only dashcam, highway and neighborhood ("two more pending"). At SF, one team found only 3 of ~49 highway cameras live. **The live index on Friday is the final authority.** Segments are probably about 5 s (the architecture doc implies it); verify on the day.

### Environment
- Everything runs on the browser-based workshop VM. Repo at `~/vast-builders-challenge`. Credentials are in `/config/<team>.config`, exported as env vars (names listed in `config.example`).
- **Kubeconfig at `/config/${NS}-k8s.yaml`** (e.g. `/config/team-11-k8s.yaml`; `NS=$USERNAME`). **Not** `/config/kubeconfig` (changed 10-08). Namespace is `$USERNAME`. Ingress host is `video-lab-team-${USERNAME#team-}.cosmos.vastdata.com`. `$INGRESS_URL` is used **only** as the app's backend `VSS_URL`.
- Build tool: Cursor Agent CLI (`agent`, then `/model` → Auto). Credits: requests should show as **Free** at cursor.com/dashboard/usage; if not, use the credit/top-up form linked in the README.
- **Lab VM: 4 vCPU · 8 GB RAM · 64 GB disk.** Run at most **3 concurrent Cursor agent sessions** and **one** dev server.
- **Getting in:** Cosmos Community account → Cloudflare Access **6-digit email code** (expires in 10 min, so have that inbox on your phone) → workshop login (same email) → **Builders Challenge** tile → lab passcode (shown on screen at the event) → **select team number once** (type `Team N` to confirm) → wait for setup → **Open desktop**. If the desktop disconnects: close extra desktop tabs and click Open desktop again, **never refresh the desktop tab** (the session is kept about 30 min).
- Official helpers: `/build-day-quickstart` (guided UI → skills → test-drive loop; reference only, ours is faster) and `/ask-cosmos` (prepares a redacted help note; **you** post it at community.vastdata.com/c/workshop/27).
- The VSS UI should be opened in your **own laptop browser** (from the workshop page), not inside the VM.
- W&B Inference: OpenAI-compatible at `https://api.inference.wandb.ai/v1`, `api_key=$WANDB_API_KEY`, `project="$WANDB_TEAM/$WANDB_PROJECT"`. Models seen at SF: Nemotron 3.5 (Lightning 30B), Llama 3.3 70B. JSON-mode support is unknown.

## Design-relevant gotchas (inferred; test early)

| Gotcha | Consequence |
|---|---|
| `kubectl create configmap --from-file=<dir>` is **not recursive** | Keep `app/` **flat** (no `static/` subfolder) |
| `kubectl apply` stores a copy of the object in an annotation capped at 256 KB | Keep `app/` under ~200 KB **or** use `kubectl apply --server-side` |
| Ingress strips `/app`; the VSS backend owns `/api` on the same host; **and the workshop "App" button may serve the page under a different origin or path prefix** (unknown until Friday) | Frontend never hardcodes a prefix. `app.js` derives `BASE` at runtime from `location.pathname` (add a trailing `/` if missing) and calls `BASE + "api/..."`. Never `/api/...`, never a hardcoded `/app/`. |
| nginx ingress default body limit is 1 MB and read timeout is 60 s | Add `proxy-body-size` and timeout annotations. Never hold a request over 30 s; long work becomes a background job the UI polls. |
| ConfigMap update needs a rollout restart, and an in-memory store is lost on restart | **Durable state in VastDB** (`sightline` schema, append-only rows), loaded on boot; `seed_state.json` remains the fallback if VastDB isn't reachable from the pod |
| `getUserMedia` (webcam) needs a secure context. The workshop portal is HTTPS (Cloudflare Access), so it *may* work if the App button opens our page top-level over HTTPS. If it embeds our page in an iframe without `allow="camera"`, or opens plain `http://`, it's blocked. | Test on Friday. Fallback: Chrome flag `#unsafely-treat-insecure-origin-as-secure` for the origin actually used, on the demo laptop |
| YOLO is COCO-trained | Forklift and pallet come from Cosmos captions. YOLO provides person, car, truck, bus, bicycle, motorcycle, backpack, handbag, suitcase, sports ball and similar. |
| Re-ingest overwrites captions | Snapshot first; keep some chunks un-specialized for the live demo |
| The public app must never send the VSS JWT to the browser | Proxy clips through our backend (`api/clip`), passing the Range header through |
| iPhone records HEVC `.mov` by default | Record demo footage with Camera → Formats → *Most Compatible* (H.264) |

## Sponsor story (each component must be necessary)

| Sponsor | Role in Sightline |
|---|---|
| VAST | Stores and indexes operational video intelligence (S3, DataEngine, VastDB), runs the re-ingest Sightline triggers, and **holds Sightline's own memory** (profiles, incidents, re-ingest jobs, analysis evolution) in VastDB tables right next to the video index |
| NVIDIA Cosmos3-Reason | Understands scenes; executes Sightline's self-written prompts; gives a second look during investigation |
| YOLO11 | Object-level perception: entity presence, counts and bbox proximity for deterministic rules |
| Cosmos-Embed1 | Semantic retrieval for objective probes and related-event search |
| CoreWeave | Serves the GPU inference |
| W&B Inference + Weave | Sightline's planning and decision layer (classify, plan, write prompts, evaluate, investigate), traced end to end |
| Cursor | Agent-orchestrated development using the challenge skills |
