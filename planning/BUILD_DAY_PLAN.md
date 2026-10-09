# Sightline: Build-Day Plan (solo + AI agents)

**Goal:** a deployed Sightline (opened via **https://workshop.thecosmoslabs.com → App**) that, for the submitted use case of **dangerous person–vehicle interactions**, configures itself on real VAST footage, improves the index with its own Cosmos prompt, finds and investigates incidents with no human search prompt, and is **submitted by 4:15 PM** (official deadline 4:30).

**Two morning rules:** (1) **arrive 8:00–8:15**, because build-environment access is limited to the first 100 attendees, and bring a **physical government photo ID**; (2) the official repo and skills are the runtime source of truth, so where they disagree with these docs, the skill wins.

**Principle:** the full vision stays in the architecture; the build order protects integration. At every moment there is a tagged, deployed, known-good version.

---

## 0. Before Friday vs. Friday

| Can prepare before Friday (no app code) | Must execute Friday |
|---|---|
| These planning docs; prompt drafts; domain priors; UX layout; demo script | All application code (`app/`, `deploy/`, `tests/`, `scripts/`) |
| A GitHub repo `sightline` containing only `planning/` | Recon of the live index; fixture capture |
| Accounts: Cursor (usage page shows Free), W&B, Cosmos Community, GitHub; Luma shows Going | Hello-world deploy to `/app`; egress checks |
| Laptop: screen recorder, Chrome, video host account (YouTube unlisted or Loom) | Re-ingest tests and all real data work |
| *Optional, low-risk:* 2–3 staged phone clips (H.264, ≤ 30 s), see `PRE_HACKATHON_CHECKLIST.md` | Demo video recording and submission |

---

## 1. Operating model: you lead four agent roles

You are the tech lead. You make decisions, approve re-ingests, review diffs, watch the gates and record the demo. Agents are separate **Cursor Agent CLI sessions**, each in its own terminal tab on the VM, all started from `~/vast-builders-challenge` (so the official skills and rules load).

| Role | Session(s) | Owns (exclusive write) | Starts |
|---|---|---|---|
| **Architect** | 1 | `planning/*`, `app/models.py`, `app/domains.json`, `app/prompts.py`, later `README.md` | 10:00 |
| **Backend-Data** | 1 | `app/config.py, vss_client.py, gpu_client.py, llm.py, repository.py, store.py, jobs.py, main.py, routes_core.py, requirements.txt` | 10:00 |
| **Backend-Intel** | 1–2 | `app/configurator.py, rules.py, engine.py, investigate.py, reingest.py, live.py, newsource.py, patterns.py, audio.py` and their `routes_*.py` (second session takes the flagged lanes) | 10:45 |
| **Frontend** | 1 | `app/index.html, app.js, styles.css, mock.js` | 10:45 |
| **QA / Integration** | 1 | `deploy/*, scripts/*, tests/*, app/seed_state.json`, `planning/HACKATHON_UNKNOWN.md` answers; **only QA tags and deploys** | 9:35 |

**The VM is 4 vCPU / 8 GB RAM, so there are 3 agent seats.** At most 3 Cursor sessions run at once (check `free -h` in recon; try a 4th only if more than 2.5 GB stays free). The timeline in §2 says who occupies each seat. A role that finishes closes its session; the next role opens a fresh one, which re-reads the docs, so nothing is lost. Run only **one** dev server (QA's :8080); other agents test against it or with unit tests. Use `/model → Auto`.

**Collision rules (every session's preamble includes these)**
1. Edit only the files you own. If you need a change elsewhere, write a request in `planning/REQUESTS.md` (append-only, `[from → to] what/why`), or tell the lead.
2. `main.py` auto-loads every `routes_*.py`, so nobody else touches `main.py`.
3. `models.py` is frozen after G1. Only the Architect changes it, and only additive changes.
4. Commit only your own files: `git add <your files> && git commit -m "<type>: <what>"`. Never `git add -A`. Never commit `fixtures/`, `/config` contents or `.env`.
5. One dev server: QA owns :8080 (uvicorn `--reload` picks up everyone's edits). Others use :8081 only briefly, then stop it (RAM).
6. Read the matching `.cursor/skills/**/SKILL.md` before any VSS, GPU or deploy call. Never print secrets; list env var **names** only.

**Why one working tree instead of worktrees:** disjoint file ownership and scoped commits avoid merge work, and the deploy reads one directory. If an agent breaks the tree, `git checkout <tag> -- <file>`.

---

## 2. Timeline and gates

| Time | Lead (you) | Seat A | Seat B | Seat C |
|---|---|---|---|---|
| **8:00–8:15** | **Arrive** (first 100 get build access), ID check, sit near power | | | |
| 8:15–9:00 | **Onboard now** (§4 pre-build): Cosmos login → email code → workshop → Builders Challenge → passcode when shown → team number → Open desktop. On the laptop: open the VSS UI; open tokens& **Submit your project** and note every field; check the Cursor usage page | | | |
| 9:00–9:30 | Keynotes. Environment setup only (git pull/auth/clone, §4 T+2–T+3); no project code before 9:30 | | | |
| 9:30–10:00 | §4 checklist; watch clips in the VSS UI | **QA**: P0b staleness check → P1 recon | | |
| 10:00 | **D1:** primary and secondary sources; reserve chunks (§3) | **QA**: P2 hello deploy | **Architect**: P3 contracts | **Backend-Data**: P4 data layer |
| 10:30 | Run **R1** (de-risk re-ingest) with QA's `gen_prompt.py` | QA: P2 / gen_prompt | Architect | Backend-Data |
| 10:45 | Review contracts; draft submission text | close QA → **Frontend**: P5 UI (mock) | close Architect → **Backend-Intel**: P6 configurator | Backend-Data: P4 |
| **11:30 G1** | Check: app **via the workshop App button** lists real sources, plays a real clip, state chip = VastDB · tag `good-1` | Frontend | Backend-Intel | close Backend-Data → **QA**: P10 integrate |
| 11:30–12:30 | Verify R1; save evolution snapshot | Frontend: wire to live API | Backend-Intel: **P7 engine** | QA: tests, seed export |
| **12:30 G2** | Check: **Configure** on a real source → classification + profile + prompt on the deployed app · tag `good-2` | | | QA: P10 |
| 12:30–1:00 | Lunch (agents keep running) | Frontend: incident detail | Backend-Intel: **P8 investigation** | QA |
| **1:45 G3** | **FIRST VERTICAL SLICE** (§5) on the deployed app · tag `good-3` · **record insurance video v1, upload, save link** | | | QA: P10 + seed |
| 1:45–2:45 | Approve in-app re-ingest **R2** at about 2:00 | Frontend: pipeline, evolution, source switching | Backend-Intel: **P9 re-ingest orchestrator** | close QA → **Backend-Intel-2**: second-environment tuning |
| **2:45 G4** | Check: 2 environments (e.g. worker↔forklift, pedestrian↔car) + in-app re-ingest + Analysis Evolution · tag `good-4` | | | → **QA**: P10 |
| 2:45–3:30 | Pick **one** advanced lane (§5) | Frontend: lane UI, search | Backend-Intel: **P12 new footage** or **P11 live** (flagged) | QA: P14 Weave → **Architect**: P15 README |
| **3:30** | **Feature freeze begins**: integrate only green features; the rest stays flag-off | | | QA: P10 |
| **3:45** | **Final deploy** from tag `final`; export seed; one rehearsal | | | |
| **3:50** | **Record final video** (`DEMO_PLAN.md` §5) | | | |
| **4:05** | Upload video; copy the link; check it opens logged-out | | | |
| **4:10** | Make the GitHub repo **public**; verify it in an incognito window | | | |
| **4:15** | **SUBMIT** on tokens& (personal deadline) | | | |
| 4:30 | Official deadline · demos | | | |

Missing a gate by more than 20 min means cutting scope from the *next* layer, never the gate itself. Rule of thumb: if G3 slips past 2:30, skip G4's second domain and go straight to polish plus video.

---

## 3. Footage and re-ingest plan

**Decision D1 (10:00)**, from recon results plus your own viewing:
Choose for the **person–vehicle** use case: cameras where people and moving vehicles share space and the captions say so.
- **Primary source:** warehouse (`sdg_warehouse_cam-2`, worker ↔ forklift) if indexed and the captions show forklifts near people; else dashcam (`pie_cam-3`) or street cams (pedestrian ↔ car).
- **Secondary source:** a *different* environment for the same risk (pedestrian ↔ car on dashcam/street, or person ↔ passing vehicle in the neighborhood). This proves the self-configuration.
- **Optional third:** an environment where the planner should **drop or downgrade** the objective (e.g. indoor smart spaces with no vehicles). Showing it decide "not applicable here" is a strong proof that nothing is hard-coded.

For each source, designate chunks:
| Label | Use |
|---|---|
| `early` | Re-ingested at about 10:30 (**R1**) with a Sightline-generated prompt; feeds the Analysis Evolution panel |
| `demo_reserved` | Never touched until the demo; Sightline plans its re-ingest live in front of judges (or at the start of a judge visit) |
| rest | Generic captions; normal monitoring |

**R1 (10:30, de-risk).** Measures real re-ingest time and caption quality early.
1. QA's `scripts/gen_prompt.py` runs the **`COSMOS_PROMPT` meta-prompt from `PROMPTS.md` on W&B** with real captions from the `early` chunk. This becomes `configurator.generate_prompt` later, so the prompt really is Sightline-generated.
2. Snapshot the `early` chunk's captions to `fixtures/snapshot_<chunk>.json` (**before** re-ingest; it overwrites them).
3. In Cursor: "re-ingest only `<original_video>` (chunk_count 1) with this custom prompt: …" (skill `ingest/reingest-chunk`; it asks for confirmations).
4. Record the elapsed time and caption diff in `HACKATHON_UNKNOWN.md`.

**R2 (about 2:00, in-app).** Sightline plans the re-ingest of a second chunk itself (P9). You click Approve. The app polls, verifies and fills the evolution panel.

**Never** re-ingest whole sources. Hard cap: 2 chunks per action.

---

## 4. Morning checklist (arrival → first 30 minutes of build)

**Pre-build (8:15–9:30), as soon as you're seated**
- [ ] Cosmos Community login → Cloudflare Access → **6-digit code from your email** (expires in 10 min) → workshop login (same email) → **Builders Challenge** tile → lab passcode (shown on screen) → **select your team number once** (ask the coordinator for it; type `Team N` to confirm) → wait for setup → **Open desktop**. Disconnected? Close extra desktop tabs → Open desktop. **Never refresh the desktop tab.**
- [ ] On the **laptop** (not in the VM): open **Video Search & Summary** from the workshop page; open https://tokensand.com/vastnyc → **Submit your project** and write every required field into `planning/SUBMISSION.md`; check that cursor.com/dashboard/usage shows requests as **Free** (if not, use the README credit form now).

**Environment setup (before 9:30 is fine; this is setup, not project code)**
- [ ] **T+0** In the VM terminal:
  ```bash
  cd ~/vast-builders-challenge && git pull && git log --oneline -5   # expect >= 0c6b756 (10-08 20:16)
  git diff 0c6b756 --stat                                            # if anything changed: skim it
  nproc; free -h                                                     # expect 4 vCPU / 8 GB
  env | cut -d= -f1 | sort | grep -E 'INGRESS|USERNAME|WANDB|COSMOS|YOLO|CANARY|GPU|S3|VDB|PIPELINE'   # names only
  ls /config                                                         # expect <team>.config and <team>-k8s.yaml
  ```
- [ ] **T+2** GitHub auth (the repo is private): `gh auth status || gh auth login` (device code, approved on your laptop), or a PAT when git prompts. Then `git config --global user.name/user.email`.
- [ ] **T+3** `git clone https://github.com/<you>/sightline.git && echo "sightline/" >> .git/info/exclude`
- [ ] **T+4** `agent` → `/model` → Auto. Paste **P0 + P0b** (staleness check), then **P1** in the same session.
- [ ] *Optional:* `/build-day-quickstart` exists (guided UI → skills → test-drive loop). Use it **only** as a sanity reference; P1 covers more ground faster. Don't let it eat the morning.

**First 30 minutes of build (9:30–10:00)**
- [ ] **While P1 runs:** in the VSS UI on your laptop:
  - Explore tab: which cameras exist, and how many clips each.
  - Dashboard: totals, `objects[]`, is the pipeline healthy?
  - Search: "person close to a moving vehicle", "forklift near a person in an aisle", "pedestrian crossing in front of a car". Play 2–3 hits and judge the captions yourself. **This decides D1.**
- [ ] **T+15** Check the tokens& page and Discord for announcements.
- [ ] **T+20** P0b + P1 summary arrives: stale assumptions, indexed cameras, segment length, `tools/segments` shape, detections format, W&B models and JSON behavior, VastDB write test, upload limit.
- [ ] **T+22** Same QA session (or a new tab if P1 is still running) → **P2 hello deploy**.
- [ ] **T+25** Make **D1** and write it at the top of `planning/HACKATHON_UNKNOWN.md`.
- [ ] **T+27** When P2 is up: **on your laptop**, open https://workshop.thecosmoslabs.com → **App**. New tab or iframe? Final URL and path prefix? HTTPS? Does `api/probe` work through it? Record in D4/D6/D12.
- [ ] **T+28** Live mode only: if the App view is **not** top-level HTTPS, set `chrome://flags/#unsafely-treat-insecure-origin-as-secure` for the origin actually used → relaunch.
- [ ] **T+30** Open seats B and C: Architect (P3) and Backend-Data (P4).

**Stop and ask organizers if:** login fails, the dashboard shows `healthy=false`, or `kubectl` can't reach the namespace. Run `/ask-cosmos` (it prepares a redacted note, never posts) and **post it yourself** at community.vastdata.com/c/workshop/27, or flag down an organizer. Don't debug infrastructure yourself for more than 10 minutes.

---

## 5. Paths: core, parallel, fallback

### Core demo path (must work; built in order)
1. **Layer 1, integration foundation (G1):** VSS auth, explore, ordered segments, clip proxy, W&B call, deployed `/app`.
2. **Layer 2, self-configuration (G2):** classify → profile → generated Cosmos prompt, with a visible pipeline panel.
3. **Layer 3, autonomous events (G3):** archive replay + objective probes → rules → LLM evaluate → events.
4. **Layer 4, investigation (G3):** N±2 context, related search, verdict, incident with triptych.
5. **Layer 5, adaptation (G4):** second domain on the same engine; in-app re-ingest + Analysis Evolution.

**First vertical slice (G3):** real VAST footage → Sightline classifies → generates a profile → evaluates footage → detects ≥ 1 event automatically → retrieves before/after evidence → produces an incident → renders it on the deployed UI. No end-user prompt anywhere.

### Parallel feature paths (each behind a flag; merged only when green)
| Lane | Prompt | Depends on | Flag |
|---|---|---|---|
| New footage self-configuration (upload) | P12 | G2, upload test in recon | `UPLOAD_ENABLED` |
| Live camera mode | P11 | G2, Chrome flag, Cosmos image test | `LIVE_ENABLED` |
| Sports mode + coaching patterns | P13 | own sports clip; P12 | `SPORTS_ENABLED` |
| Weave tracing | P14 | G1 | `WEAVE_ENABLED` |
| Semantic search panel ("find similar") | in P5/P7 | G1 | always on |
| Cross-camera related events | in P8 | G3 | always on |
| Canary audio (commentary or spoken warnings) | P16 | P12 | `CANARY_ENABLED` |
| Retail mode | via P12 with a staged clip | P12 | data only |

### Fallback paths
| If… | Then… |
|---|---|
| Warehouse not indexed or captions weak | Primary = highway or dashcam traffic; secondary = neighborhood or smart spaces |
| Re-ingest slow (> 20 min) or failing | Monitor on generic captions; the evolution panel uses the R1 result once it lands; demo shows a job in progress |
| W&B down or unreliable JSON | `rules_only` mode (deterministic classify, prior profiles, rule-score events, template prompts), labeled in the UI |
| Cosmos direct calls slow | Skip env look and second look; live mode off |
| K8s deploy broken | `kubectl rollout undo`; worst case port-forward and demo in the VM browser, plus the recorded video |
| Second domain not ready | Demo one domain + self-configuration + new-footage or prompt-generation proof |
| Everything flaky at 3:45 | Deploy the last good tag with `seed_state.json`; demo from the cached snapshot (badge visible) + insurance video |

---

## 6. Cursor prompt sheet (paste in order; each session starts with P0)

> Tip: if clipboard paste into the VM is flaky, tell the agent: "Read `sightline/planning/BUILD_DAY_PLAN.md` and execute prompt **P4** as the **Backend-Data** agent."

### P0: Session preamble (prefix for every session; fill in ROLE and FILES)
```text
You are the <ROLE> agent on Sightline, a hackathon app in ./sightline (our own git repo; the
official challenge repo is the current directory). First read sightline/planning/PROJECT_CONTEXT.md
and sightline/planning/ARCHITECTURE.md. Rules: edit ONLY these files: <FILES>. Never edit other
files; put cross-team requests in sightline/planning/REQUESTS.md. Before any VSS/GPU/deploy call,
read the matching .cursor/skills/**/SKILL.md and follow it. Never print secrets, never run bare env
or printenv (list names only), never write .env files, never commit fixtures/. Commit only your
files with small conventional commits (git add <files>; never git add -A). When done, reply with a
<=15 line summary: what works, what's verified against the real backend, what's blocked.
```

### P0b: Staleness check (QA, first thing at 9:30, before P1)
```text
Read the CURRENT README.md, .cursor/rules/build-day.mdc, .cursor/README.md,
.cursor/skills/build-day-quickstart/SKILL.md, .cursor/skills/deployment/deploy-app-no-registry/SKILL.md,
.cursor/skills/vast-database/*/SKILL.md, and git log -10, before doing anything. Then read
sightline/planning/PROJECT_CONTEXT.md, ARCHITECTURE.md and BUILD_DAY_PLAN.md. The official repo
is the runtime source of truth. List every planning assumption that is now stale or contradicted
(paths, hosts, kubeconfig, skill names, routes, limits, app URL flow), as "doc → reality → fix".
Do not modify application code. Do not run re-ingest. Then continue with P1.
```

### P1: Recon (QA) · 9:35
```text
ROLE=QA/Integration. FILES=sightline/fixtures/*, sightline/planning/HACKATHON_UNKNOWN.md, sightline/scripts/*.
Do not write application code. Using the official skills (retrieval/login, dashboard, list-metadata,
videos, search, agent-qa; gpu/model-health; ingest docs for reference only, NO re-ingest):
1. Health: login, dashboard pipeline_alignment, model health for all 4 GPU endpoints.
2. Inventory: from videos/explore (page through all) and dashboard metadata, list every camera_id
   with location, capture_type, #parent videos, #segments, complete chunks.
3. Save redacted responses (strip tokens/passwords) to sightline/fixtures/: dashboard_stats.json,
   metadata_schema.json, ingest_config.json, explore_all.json, config.json (GET /api/v1/config),
   search_person_vehicle.json (query "person close to a moving vehicle", top_k 10),
   search_forklift_person.json ("forklift near a person in an aisle"),
   search_pedestrian_car.json ("pedestrian crossing in front of a car"),
   and for one warehouse video and one traffic video: segments_<cam>.json (GET /api/v1/tools/segments),
   segment_meta_<cam>.json (videos/metadata), detections_<cam>.json (videos/detections).
4. Report: segment duration, caption style/length, whether rows contain YOLO classes, detection
   sidecar format (frames, boxes, normalization), whether a wall-clock timestamp exists.
5. W&B Inference: OpenAI client, base_url https://api.inference.wandb.ai/v1, api_key=$WANDB_API_KEY,
   project=f"{WANDB_TEAM}/{WANDB_PROJECT}". List models; for the 2 most capable, test a strict JSON
   reply and response_format={"type":"json_object"}; record latency.
6. Cosmos direct: one chat call with text only, and one with a single small JPEG as image_url
   (extract a frame from a segment via the stream route if ffmpeg exists; else skip). Record latency.
7. VastDB (skills vast-database/vastdb-read and vastdb-write; parse the config with grep, don't
   source it in zsh): run list_catalog.py for our bucket. Then, pre-approved by the lead: create
   schema "sightline" with table "probe" (id int64, note utf8), insert one row with insert.py, and
   read it back with query.py. NEVER write vss-collection or vss-prompts-events. Record whether
   insert works and its latency.
8. Write every answer into the Answer column of sightline/planning/HACKATHON_UNKNOWN.md.
Finish with: indexed cameras + counts, segment length, and the recommended primary/secondary sources
for the PERSON–VEHICLE use case (which cameras show people near moving vehicles, with clear captions) and why.
```

### P2: Hello deploy (QA) · 10:00
```text
ROLE=QA/Integration. FILES=sightline/deploy/*, sightline/scripts/*, sightline/app/main.py (TEMPORARY
hello app; Backend-Data takes ownership after this), sightline/app/requirements.txt (temporary).
Read the CURRENT .cursor/skills/deployment/deploy-app-no-registry/SKILL.md and FOLLOW IT for the
namespace, KUBECONFIG path, Ingress host, Secret pattern, manifests and how users open the app. Do not
trust host/kubeconfig values written in our docs; the skill wins on any conflict. Then apply only the
deltas in sightline/planning/ARCHITECTURE.md §3 (flat ConfigMap with server-side apply plus a size
check; extra Secret keys from the team config, never echoed, parsed in bash; Ingress annotations for
body size, timeouts and buffering). Write it as sightline/deploy/deploy.sh (bash).
Hello app: FastAPI+uvicorn, plus vastdb and pyarrow in requirements.txt, GET /health, and
GET /api/probe that checks FROM INSIDE THE POD: VSS login ok, Cosmos /v1/health/ready, YOLO /healthz,
W&B models list, VastDB connect plus a select on sightline.probe, and reports pass/fail per check
with no secrets in the output. The page at / must show the probe results and the browser's
location.href (so the lead can see the App button's real URL and prefix). Deploy, record the pod
startup time, wait for rollout, curl http://$APP_HOST/app/health and /app/api/probe from the VM,
then tell the lead to open https://workshop.thecosmoslabs.com → App on the laptop. Record results
in HACKATHON_UNKNOWN.md. Then write
sightline/scripts/gen_prompt.py: given a source camera_id, pull 6 captions, run the COSMOS_PROMPT
template from sightline/planning/PROMPTS.md (B.3) via W&B, print the prompt + char count (<=800).
```

### P3: Contracts (Architect) · 10:00
```text
ROLE=Architect. FILES=sightline/app/models.py, sightline/app/domains.json, sightline/app/prompts.py,
sightline/planning/*.
Read ARCHITECTURE.md, DOMAIN_PROFILES.md, PROMPTS.md and the real responses in sightline/fixtures/.
1. models.py: Pydantic v2 models for every type in ARCHITECTURE.md §4, with field names reconciled
   to the real VSS responses (add from_vss_* helpers only where trivial). Additive-only after this.
2. domains.json: the 6 domain priors, rule vocabulary and entity→YOLO map from DOMAIN_PROFILES.md,
   using only YOLO classes present in fixtures/dashboard_stats.json objects[].
3. prompts.py: every template in PROMPTS.md Part B as constants, plus SHORT_TEMPLATES (Part A
   detailed prompts) and FEW_SHOT_PROMPTS.
4. Update ARCHITECTURE.md §4/§5 where reality differs, and list the differences at the top of
   HACKATHON_UNKNOWN.md. Commit: "feat: freeze v1 contracts". Target: done by 10:45.
```

### P4: Data layer (Backend-Data) · 10:00
```text
ROLE=Backend-Data. FILES=sightline/app/{config,vss_client,gpu_client,llm,repository,store,jobs,main,
routes_core}.py, sightline/app/requirements.txt.
Read ARCHITECTURE.md §1–5, §8–10 and the skills in .cursor/skills/retrieval, ingest, gpu (they are the
API docs). models.py is being written by the Architect; start with vss_client.py and gpu_client.py
(no dependency), then use models.py when it appears.
- VSSClient (httpx, timeouts): login with a cached JWT and a single re-login on 401; search; explore
  (paged); tools_segments(original_video); segment_metadata; detections (404 → None); synthesize;
  dashboard_stats; ingest_config; app_config; reingest_start; reingest_status; upload_video;
  stream(source, range_header) → streaming response.
- GPUClient: cosmos_chat(messages, images=[], video_b64=None), yolo_infer(video_b64), embed(text),
  canary_transcribe(wav), health(). URLs and token from env; never log the token.
- llm.py: W&B OpenAI client; structured(template, vars, Model, fallback) = call → extract the first
  JSON object → validate → one repair retry → fallback(); per-call timeout 45 s; optional Weave
  (WEAVE_ENABLED, try/except).
- repository.py: sources grouped by camera_id; ordered VideoSegment lists with caption, flags parsed
  from "FLAGS:", DetectionSummary from the sidecar (class max-counts + per-frame boxes kept for rules);
  sample_segments(source, n) spread across videos/time; LRU caching.
- store.py per ARCHITECTURE.md §9: VastDB append-only write-through to sightline.records via the
  vastdb SDK (pattern from .cursor/skills/vast-database/vastdb-write), batched every 2 s, hydrated
  at boot, with a /tmp + seed_state.json fallback and data_origin reporting. jobs.py per §5. main.py: FastAPI, /health, serves index.html,
  app.js, styles.css, mock.js from its own directory, auto-includes every routes_*.py module,
  uvicorn.run on 0.0.0.0:$PORT.
- routes_core.py: api/status, api/sources, api/sources/{id}, api/sources/{id}/segments, api/clip
  (Range passthrough), api/search, api/jobs/{id}, api/state/export|import.
Test locally on :8081 against the real backend; write tests/test_data_layer.py.
```

### P5: UI shell (Frontend) · 10:45
```text
ROLE=Frontend. FILES=sightline/app/index.html, app.js, styles.css, mock.js.
Read ARCHITECTURE.md §5 and §13 and planning/DEMO_PLAN.md. Build the single-page ops dashboard in
vanilla JS (no npm, no build; CDN only if essential): overview, source detail (configuration "why",
objectives, generated prompt with a char counter, re-ingest stepper, Analysis Evolution), incident
detail (BEFORE/EVENT/AFTER players, clickable timeline, entities, why flagged, confidence breakdown,
investigation, related), autonomous pipeline panel, health chips, search panel. Derive
BASE at runtime from location.pathname (add a trailing "/") and call BASE + "api/..."; never
"/api/..." and never a hardcoded "/app/" (the workshop App button's prefix is unknown). Poll every 2 s; no SSE. ?mock=1 loads mock.js (realistic
data shaped like ARCHITECTURE.md §4; use real captions from sightline/fixtures/ if present). Keep all
4 files < 150 KB. Dark ops style, severity colors, readable on a projector. Serve app/ on :8082 to test.
```

### P6: Self-configuration (Backend-Intel) · 10:45
```text
ROLE=Backend-Intel. FILES=sightline/app/configurator.py, routes_config.py.
Implement ARCHITECTURE.md §6.1 exactly, using models.py, prompts.py (CLASSIFY, PLAN, COSMOS_PROMPT,
COSMOS_ENV_LOOK), domains.json, repository, llm.structured and gpu_client. Validate every RuleCall
against the vocabulary; enforce prompt length <= 800 (shorten retry → SHORT_TEMPLATES fallback);
deterministic rules_classify fallback (PROMPTS.md B.10). Each step appends to PipelineRun in the store.
Routes: POST api/sources/{id}/configure (job), GET api/pipeline/{id}. Run it on the two D1 sources;
save outputs to sightline/fixtures/config_<cam>.json and paste the classification + objective names +
prompt (with char count) in your summary.
```

### P7: Monitoring engine (Backend-Intel) · 11:30
```text
ROLE=Backend-Intel. FILES=sightline/app/rules.py, engine.py, routes_monitor.py.
Implement ARCHITECTURE.md §6.3: every rule primitive in DOMAIN_PROFILES.md §1 (pure functions over
VideoSegment lists, unit-tested with fixtures), the chronological replay with a replay clock and the
objective probes via search filtered by camera_id, batched EVALUATE with the exact-substring
evidence_quote guard, merging consecutive segments into PotentialEvents, and a rules-only fallback.
Routes: POST/DELETE api/sources/{id}/monitor, GET api/incidents?source=&since= (returns incidents
once investigated; PotentialEvents included with status for the pipeline panel). Run on the primary
source and report how many candidates, events and rejections you got, and why.
```

### P8: Investigation (Backend-Intel) · 12:30
```text
ROLE=Backend-Intel. FILES=sightline/app/investigate.py, routes_incidents.py.
Implement ARCHITECTURE.md §6.4: N±2 context from tools/segments, detections + bbox proximity per
segment, related events (same camera top 5 excluding the window, cross-camera top 3), optional Cosmos
second look (COSMOS_SECOND_LOOK on the event clip, skip on timeout), the INVESTIGATE call with
seg-id citation validation, severity modifiers (DOMAIN_PROFILES.md §3), the explainable Confidence
(components exactly as in §6.4), and Incidents with evidence clip URLs (api/clip?source=...).
Route GET api/incidents/{id}. Investigation is triggered automatically by the engine.
Produce >= 1 real incident on the primary source and report it.
```

### P9: Re-ingest orchestrator + Analysis Evolution (Backend-Intel) · 1:45
```text
ROLE=Backend-Intel. FILES=sightline/app/reingest.py, routes_reingest.py.
Implement ARCHITECTURE.md §6.2 with real statuses only (preparing, reingesting, indexing, verifying,
ready, failed), snapshot-before, a hard cap of 2 chunks, one active job per source, the
demo_reserved guard, polling every 4–8 s in a background task, verification rules, and on ready:
build AnalysisEvolution and trigger monitoring on the target. Routes: POST api/sources/{id}/reingest/plan,
POST api/reingest/{job}/approve, GET api/reingest/{job}, GET api/sources/{id}/evolution.
Also import the R1 snapshot (sightline/fixtures/snapshot_*.json) + current captions as a completed
evolution record for that chunk.
```

### P10: Integrate and deploy (QA) · at every gate
```text
ROLE=QA/Integration. Pull nothing (shared tree). Run tests/ (unit + smoke against the local dev
server on :8080 started from sightline/app with uvicorn). Check: app/ size, no absolute "/api/"
or hardcoded "/app/" in the frontend files, no secrets in the diff (grep for token/password/key values from env without
printing them). If green: run deploy/deploy.sh, verify /app/health, /app/api/status and the gate
criterion "<GATE CRITERION>" on the DEPLOYED URL, export api/state/export → app/seed_state.json, redeploy,
git tag good-<n>. If red: report the failing check and the owning agent; do not fix others' files.
```

### P11: Live mode (Backend-Intel 2nd session + Frontend) · flagged
```text
ROLE=Backend-Intel (live). FILES=sightline/app/live.py, routes_live.py.
Implement ARCHITECTURE.md §6.5 behind LIVE_ENABLED: sessions; frames (JPEG b64) → optional YOLO
(only if the recon showed it accepts images) → gate (entity-set change, rule trigger, or a 5 s
checkpoint) → Cosmos COSMOS_LIVE_OBSERVE → after 3 observations run the configurator's classify+plan
on observations → the same rules + EVALUATE → live incidents with stored frames as evidence. Track
latency and calls/min. Frontend request in REQUESTS.md: live view with getUserMedia, canvas
capture every 500 ms, JS pixel-diff motion gate, gate stats.
```

### P12: New footage self-configuration (Backend-Intel) · flagged
```text
ROLE=Backend-Intel (new footage). FILES=sightline/app/newsource.py, routes_upload.py.
Implement ARCHITECTURE.md §6.6 behind UPLOAD_ENABLED: POST api/newsource (multipart file + up to 4
JPEG keyframes) → COSMOS_ENV_LOOK on keyframes → classify → plan → generate prompt → VSS upload
(skill ingest/upload-video; is_public false; camera_id sightline-new-<n>; custom_prompt = generated)
→ poll explore until indexed → configure + monitor as a normal source. Respect the live upload size
limit from /api/v1/config. Every step goes to PipelineRun so the UI can animate the real progress.
```

### P13: Sports mode + patterns (Backend-Intel) · flagged, only with own sports footage
```text
ROLE=Backend-Intel (sports). FILES=sightline/app/patterns.py, routes_patterns.py.
Implement ARCHITECTURE.md §6.7 and the sports prior behavior: incidents are coaching events; run
PATTERNS over a source's incidents; GET api/patterns?source= returns pattern statements with evidence
clips. Test on the uploaded sports clip (via P12). No new code paths per domain beyond patterns.py.
```

### P14: Weave tracing (QA) · flagged
```text
ROLE=QA. FILES=sightline/app/tracing.py (new; Backend-Data imports it with one line via REQUESTS.md).
Implement ARCHITECTURE.md §11 behind WEAVE_ENABLED with try/except (it must never break the app).
Verify traces appear in the W&B project; put trace URLs on PipelineSteps. Measure pod startup time
with weave installed; if > 90 s, leave it disabled.
```

### P15: README and submission text (Architect) · 3:00
```text
ROLE=Architect. FILES=sightline/README.md, sightline/planning/SUBMISSION.md.
Write the public README: one-liner, demo line, the self-configuring loop, architecture diagram,
sponsor stack (PROJECT_CONTEXT.md table), how each component is used, what's real vs replayed,
screenshots placeholders, how to deploy (deploy/deploy.sh on the event VM), limitations. No
secrets, team URLs or bucket names. SUBMISSION.md: a 100-word description + tools list for the
tokens& form.
```

### P16: Canary (optional)
```text
ROLE=Backend-Intel. FILES=sightline/app/audio.py, routes_audio.py. Behind CANARY_ENABLED: accept a
WAV (Frontend extracts audio from the picked file with WebAudio and encodes WAV in the browser; no
ffmpeg), call Canary transcriptions, align transcript chunks to segment times, and add them as an
"audio" Signal and Evidence on incidents (sports commentary names, spoken warnings).
```

---

## 7. Git and checkpoints
- Commit types: `chore:` baseline, `feat:` features, `fix:`, `test:`, `docs:`. Small commits.
- Only QA creates tags: `good-1` … `good-4`, `final`. Deploy for a demo only from a tag.
- Before any risky change, the lead says "checkpoint" → QA tags `wip-<time>`.
- Revert fast: `git checkout good-3 -- app/<file>`, redeploy.
- **Repo visibility:** **private until 4:10**, then switch to **public** and verify it in an incognito window before submitting. Because it's private, cloning on the VM needs GitHub auth first (§4 T+2). `.gitignore`: `fixtures/`, `app/seed_state.json`, `.env*`, `__pycache__/`.
- **Pushing from the VM needs GitHub auth.** Either `gh auth login` (device code: you approve it on your laptop) if `gh` exists on the VM, or a fine-grained PAT created Thursday, scoped to the `sightline` repo only (Contents: read/write), which you type when git prompts. Push after every tag so the work survives a VM failure.
