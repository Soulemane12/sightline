# Sightline: Architecture

This is the build-day reference for all agents. Read `PROJECT_CONTEXT.md` first. Field names marked *(verify)* must be matched to the real responses captured in `fixtures/` on Friday morning, and the Architect agent updates this file when reality differs.

## 1. System overview

```
 Browser (laptop / judge)                      Event Kubernetes cluster (team namespace)
 ┌──────────────────────────┐ workshop portal "App" button ┌───────────────────────────────────────────┐
 │ index.html + app.js      │ ───────────────────────────▶ │ Ingress /app(/|$)(.*) → Service → Pod      │
 │ BASE from location       │   relative URLs, 2s polling   │ python:3.12-slim, code from ConfigMap      │
 │ webcam (live mode)       │ ◀─────────────────────────── │ FastAPI + uvicorn (main.py)                │
 └──────────────────────────┘   clips via api/clip proxy    │                                           │
                                                           │  ┌── Sightline core ────────────────────┐ │
                                                           │  │ Configurator  (classify→plan→prompt) │ │
                                                           │  │ ReingestOrchestrator (async jobs)     │ │
                                                           │  │ MonitoringEngine (rules→LLM eval)     │ │
                                                           │  │ InvestigationEngine (N±2, related)    │ │
                                                           │  │ LiveSession / NewFootage (flagged)    │ │
                                                           │  └──────────────────────────────────────┘ │
                                                           │  Adapters: VSSClient · GPUClient · LLM ·  │
                                                           │            VideoRepository · Store        │
                                                           └───────┬──────────────┬──────────────┬─────┘
                                                                   │              │              │
                                              VSS backend ($INGRESS_URL/api/v1)   │   W&B Inference (+Weave)
                                              search · explore · tools/segments   │   api.inference.wandb.ai/v1
                                              detections · reingest · upload      │
                                              stream · dashboard · synthesize     GPU endpoints (CoreWeave)
                                                     │                             Cosmos3-Reason · YOLO11
                                              VAST S3 + DataEngine + VastDB        Embed1 · Canary
                                              VastDB schema "sightline" ◀── Store (our durable memory, SDK via data VIP)
```

**Principles**
1. **Thin, deployable, flat.** One Python process, one HTML page, everything inside a single flat ConfigMap. No build step, no npm, no bundled media.
2. **Adapters isolate the infrastructure.** Only `vss_client.py` knows VSS routes, only `gpu_client.py` knows GPU endpoints, and only `llm.py` knows W&B. Everything else uses normalized models from `models.py`.
3. **Deterministic first, LLM for ambiguity.** Rules gate candidates cheaply. The LLM evaluates, plans and explains, and every LLM output is schema-validated.
4. **Everything long is a job.** Configure, monitor, investigate, re-ingest and upload all return a `job_id` immediately, and the UI polls. No request holds the connection longer than 30 s.
5. **Honest about time.** Archive monitoring is labeled "Archive replay". Re-ingest status comes only from the VSS APIs, and "Ready" means verified captions.
6. **Always demoable.** State lives in VastDB (`sightline` schema), so it survives every redeploy. A `seed_state.json` snapshot of real results also ships with each deploy as a fallback, and the UI shows a badge whenever it serves cached data.

## 2. Repository layout (on the VM)

```
~/vast-builders-challenge/            official repo (skills + Cursor rules load from here)
└── sightline/                        OUR git repo (nested; add to ../.git/info/exclude)
    ├── planning/                     these docs (Architect)
    ├── app/                          FLAT, deployed as ConfigMap. Keep < 200 KB
    ├── deploy/                       deploy.sh, k8s yaml templates (QA)
    ├── scripts/                      probes, one-off generators, size check (QA)
    ├── tests/                        smoke + e2e (QA)
    └── fixtures/                     real API responses captured Friday (gitignored, never deployed)
```

### `app/` file ownership (one owner per file, no exceptions)

| File | Owner | Responsibility |
|---|---|---|
| `models.py` | Architect | Pydantic v2 models for every type in §4. **Frozen at G1**; changes go through the Architect only. |
| `domains.json` | Architect | Domain priors, rule vocabulary, entity→YOLO map (from `DOMAIN_PROFILES.md`) |
| `prompts.py` | Architect | LLM and Cosmos prompt templates (from `PROMPTS.md`) |
| `config.py` | Backend-Data | Env loading, feature flags (`LIVE_ENABLED`, `UPLOAD_ENABLED`, `WEAVE_ENABLED`, `SPORTS_ENABLED`), timeouts |
| `vss_client.py` | Backend-Data | VSSClient: JWT cache, re-login on 401, every VSS route we use, stream proxy |
| `gpu_client.py` | Backend-Data | GPUClient: Cosmos chat (text/image/video), YOLO infer, Embed, Canary, health |
| `llm.py` | Backend-Data | W&B client; `structured(template, vars, Model, fallback)`; optional Weave |
| `repository.py` | Backend-Data | VideoRepository: Sources, ordered segments, normalized `VideoSegment`, caching |
| `store.py` | Backend-Data | In-memory state with a write-through to **VastDB** (`sightline` schema, §9); falls back to `/tmp/state.json` + `seed_state.json`; export and import |
| `jobs.py` | Backend-Data | Tiny async job runner (`submit(fn) → job_id`, status, result, error) |
| `main.py` | Backend-Data | FastAPI app, `/health`, static files, **auto-includes every `routes_*.py`** (so nobody else edits main.py) |
| `routes_core.py` | Backend-Data | `api/status`, `api/sources*`, `api/clip`, `api/state/*`, `api/search` |
| `configurator.py`, `routes_config.py` | Backend-Intel | EnvironmentAgent, MonitoringPlanner, PromptGenerator |
| `rules.py`, `engine.py`, `routes_monitor.py` | Backend-Intel | Rule primitives; MonitoringEngine |
| `investigate.py`, `routes_incidents.py` | Backend-Intel | InvestigationEngine; incident API |
| `reingest.py`, `routes_reingest.py` | Backend-Intel | ReingestOrchestrator + Analysis Evolution |
| `live.py`, `routes_live.py` | Backend-Intel (flagged) | Live camera sessions |
| `newsource.py`, `routes_upload.py` | Backend-Intel (flagged) | New-footage self-configuration + VSS upload |
| `patterns.py`, `routes_patterns.py` | Backend-Intel (flagged) | Cross-incident pattern mining (sports coaching, repeated near-misses) |
| `audio.py`, `routes_audio.py` | Backend-Intel (flagged) | Canary transcription aligned to segments |
| `tracing.py` | QA (flagged) | Weave init + op decorators; a no-op when disabled |
| `index.html`, `app.js`, `styles.css`, `mock.js` | Frontend | The whole UI; `mock.js` holds mock API data for `?mock=1` |
| `seed_state.json` | QA | Exported known-good state (gitignored if it contains team URIs) |
| `requirements.txt` | Backend-Data | `fastapi uvicorn httpx openai pydantic vastdb pyarrow` (+ `weave` only if `WEAVE_ENABLED`). pyarrow is a big wheel, so measure pod startup. |

## 3. Deployment (`deploy/deploy.sh`, owned by QA)

**Follow the CURRENT `.cursor/skills/deployment/deploy-app-no-registry/SKILL.md`** for namespace, `KUBECONFIG`, Ingress host, Secret pattern and manifests. It changed on 10-06 and again on 10-08; as of `0c6b756`: `NS=$USERNAME`, `KUBECONFIG=/config/${NS}-k8s.yaml` (**not** `/config/kubeconfig`), host `video-lab-team-${USERNAME#team-}.cosmos.vastdata.com`, users open the app via the workshop **App** button. Where this section and the skill disagree, the skill wins. Our deltas on top of it:

- **ConfigMap:** `kubectl -n $NS create configmap sightline-code --from-file=app/ --dry-run=client -o yaml | kubectl apply --server-side --force-conflicts -f -`. Fail the script if `app/` is over 900 KB, and warn over 200 KB.
- **Secret `sightline-env`** (values from the team config, never echoed; the script is bash, or it parses with `grep` because zsh reserves `USERNAME`): `VSS_URL=$INGRESS_URL, VSS_USERNAME, VSS_PASSWORD, WANDB_API_KEY, WANDB_TEAM, WANDB_PROJECT, GPU_BEARER_TOKEN, COSMOS3_REASON_URL, YOLO_URL, COSMOS_EMBED1_URL, CANARY_1B_URL, S3_ENDPOINT, ACCESS_KEY, SECRET_KEY, VASTDB_BUCKET`. Use `envFrom: secretRef`.
- **Pod:** `python:3.12-slim`, `PYTHONDONTWRITEBYTECODE=1`, `pip install -r requirements.txt` at start, `exec python main.py` (main.py calls `uvicorn.run(app, host="0.0.0.0", port=8080)`). Readiness probe `/health`.
- **Ingress** (host `video-lab-team-${USERNAME#team-}.cosmos.vastdata.com`, as in the current skill; **not** derived from `$INGRESS_URL`. Path `/app(/|$)(.*)`, rewrite `/$2`). Annotations:
  `nginx.ingress.kubernetes.io/proxy-body-size: "200m"`, `proxy-read-timeout: "120"`, `proxy-send-timeout: "120"`, `proxy-buffering: "off"` (for clip streaming).
- **After a deploy:** `kubectl rollout restart` (ConfigMap changes aren't hot), `rollout status`, then `curl http://$APP_HOST/app/health` and `/app/api/status` from the VM (cluster check). **The real check is a human opening https://workshop.thecosmoslabs.com → App**, which is how judges and the demo reach it.
- **Dev loop:** on the VM, run `cd sightline/app && uvicorn main:app --port 8080 --reload` against the real VSS backend using the VM's env. QA owns port 8080; other agents use 8081+. Deploy to K8s at every gate.
- **Emergency fallback** (not the deliverable): `kubectl port-forward deploy/sightline 8080:8080`, then open the VM browser at `localhost:8080`.

## 4. Data model (`models.py`)

**Frozen 2026-10-09 (P3 / G1).** App-facing field names below are stable. VSS wire names differ — map in `repository.py` via `VideoSegment.from_vss_segment` / `video_ref_from_explore` (see also `planning/HACKATHON_UNKNOWN.md` Architect freeze notes).

IDs are strings. Times are seconds within the parent video (`t_start`, `t_end`). **No capture wall-clock** exists in the live index (only `upload_timestamp` = ingest time); do not rely on `captured_at` / `time_window`.

**VSS → app mapping (fixtures 2026-10-09):**

| App field | VSS wire |
|---|---|
| `VideoSegment.source_uri` | `source` |
| `VideoSegment.index` | `segment_number` (1-based) |
| `VideoSegment.t_start` / `t_end` | `segment_start_sec` / `segment_end_sec` |
| `VideoSegment.caption` | `reasoning_content` |
| `VideoSegment.flags` | parsed from `FLAGS:` line in caption (absent until re-ingest) |
| `DetectionSummary.classes` | `object_counts` (JSON string) or sidecar |
| Explore parents list key | **`videos`** (fixture `explore_all.json`; not `chunks`) |
| Explore parent times | `chunk_duration_sec`, `upload_timestamp`, `stream_id`, `preview_source` |
| Detections bbox | pixel **xyxy** on `video_shape` `[H,W]`; normalize by frame diagonal for `bbox_proximity` |
| Segment length | **5.0 s** typical; warehouse chunks often 10 s / 2 segs; street 30 s / 6 segs |
| Cosmos model id | `nvidia/cosmos3-nano-reasoner` (not `cosmos3-reason`) |

```jsonc
// A camera / feed. Usually one per camera_id; groups many parent videos (chunks).
VideoSource { id, camera_id, location, capture_type, label, videos: [VideoRef],
              segment_count, domain_hint_from_metadata?, status: "unconfigured|configuring|configured|specializing|monitoring" }
VideoRef    { original_video, filename, stream_id?, total_segments, preview_source, uploaded_at?, chunk_duration_sec? }

VideoSegment { source_uri /* s3 segment */, original_video, index /* 1-based */, t_start, t_end,
               caption /* reasoning_content */, flags: [str] /* parsed from FLAGS: line if present */,
               yolo: DetectionSummary?, camera_id, location, filename?, duration?, upload_timestamp?, object_classes? }
DetectionSummary { classes: {label: max_count}, frames_sampled, has_sidecar,
                   pairs: [{a, b, min_gap_norm, frames_close}] /* computed by rules.bbox_proximity */ }

EnvironmentClassification { domain: "security|warehouse|retail|sports|traffic|general", confidence /*0..1*/,
               secondary_domain?, description, camera_type: "fixed|moving|unknown",
               important_entities: [str], evidence: [{signal, source: "caption|yolo|metadata|visual", supports}],
               mode: "llm|rules_only" }

MonitoringObjective { id /* snake_case */, name, description, severity: "critical|high|medium|low",
               rationale, detector: DetectorSpec, semantic_probes: [str],
               investigation_questions: [str], wording: {title, review_action} }
DetectorSpec { all_of: [RuleCall], any_of: [RuleCall], merge_gap_segments: 1 }
RuleCall     { primitive /* from DOMAIN_PROFILES.md vocabulary */, params: {} }

MonitoringProfile { source_id, domain, version, objectives: [MonitoringObjective],
               information_gaps: [str] /* what current captions don't describe */,
               generated_prompt: CosmosPrompt?, severity_rules: {}, created_at, mode,
               dropped?: [{id, name, reason}] /* §5a: objectives judged not applicable */ }
CosmosPrompt { text /* <= 800 chars, enforced */, chars, covers: [objective_id], rationale, template_fallback: bool }

PotentialEvent { id, source_id, objective_id, segment: str /* source_uri */, signals: [Signal],
               rule_score, llm: {is_event, confidence, reason, evidence_quote}? , status: "candidate|rejected|investigating|incident" }
Signal { kind: "rule|caption_flag|semantic|llm|temporal|second_look", name, value, detail }

Evidence { role: "before|event|after|related", segment: str, t_start, t_end, caption, yolo?, clip_url /* api/clip?source=… */,
           camera_id?, similarity? }
Investigation { event_id, verdict: "confirmed|likely|unclear|false_positive", timeline: [{t, text, segment}],
               start_segment, peak_segment, end_segment, entities: [str], why_flagged, counter_evidence,
               related: [Evidence], second_look?: {verdict, text}, confidence: Confidence,
               answers?: [{question, answer}], temporal_support? }
Confidence { value /*0..1*/, components: [{name, value, weight, explanation}] }   // always explainable

Incident { id, source_id, domain, objective_id, event_type, title, severity, confidence: Confidence,
           summary, started_at, peak_at, ended_at, camera_id, location, entities,
           evidence: [Evidence], investigation: Investigation, recommended_action, created_at,
           search_hint?, replay_pos?, mode? /* §5a UI extras */ }

ReingestJob { id, source_id, original_video, chunk_count, clips, prompt: CosmosPrompt, vss_job_id?,
              status: "planned|preparing|reingesting|indexing|verifying|ready|failed",
              progress: {completed_chunks, total_chunks, indexed_segments, total_segments},
              snapshot_before: [{segment, caption}], after: [{segment, caption}], error?, timestamps,
              filename?, eta?, reason?, started_at?, finished_at?, failed_stage?, verify?: {changed, total, with_terms} }
AnalysisEvolution { source_id, steps: [{stage: "generic|objective|prompt|reanalyzed|event", text, ref}] }

PipelineRun  { source_id, steps: [{key, label?, status: "pending|running|done|failed|skipped", summary, started_at, ended_at, trace_url?}] }
// step keys: classify, plan, prompt, reingest, monitor, detect, investigate, incident
```

## 5. Internal HTTP API (frontend ↔ backend)

All paths are relative to `/app/`. All JSON. Long operations return `{job_id}` and are tracked at `GET api/jobs/{id}` → `{status, result?, error?}`.

| Method & path | Returns | Owner |
|---|---|---|
| `GET health` | `ok` | Data |
| `GET api/status` | dependency health: vss, gpu{cosmos,yolo,embed,canary}, llm, mode flags, data freshness (`live` / `cached since …`) | Data |
| `GET api/sources` | `[VideoSource + {classification?, profile_summary?, incident_counts, reingest_status?}]` | Data |
| `GET api/sources/{id}` | source + classification + profile + pipeline + latest incidents + evolution | Data (aggregates the others' store entries) |
| `GET api/sources/{id}/segments?video=` | ordered `[VideoSegment]` | Data |
| `GET api/clip?source=<s3 uri>` | video bytes, proxied with Range passthrough | Data |
| `GET api/search?q=&source=` | normalized hits (secondary feature) | Data |
| `GET/POST api/state/export`, `api/state/import` | snapshot JSON | Data |
| `POST api/sources/{id}/configure` | job → classification + profile + prompt | Intel |
| `GET api/pipeline/{id}` | `PipelineRun` | Intel |
| `POST api/sources/{id}/monitor {video?, speed?}` / `DELETE` | start or stop archive replay monitoring | Intel |
| `GET api/incidents?source=&since=` | `[Incident]` (feed) | Intel |
| `GET api/incidents/{id}` | `Incident` (full) | Intel |
| `POST api/sources/{id}/reingest/plan` | `ReingestJob(status=planned)` with prompt, target, clip count, ETA | Intel |
| `POST api/reingest/{job}/approve` | starts it (snapshot → submit) | Intel |
| `GET api/reingest/{job}` | `ReingestJob` | Intel |
| `GET api/sources/{id}/evolution` | `AnalysisEvolution` | Intel |
| `POST api/live/session` → `{sid}`; `POST api/live/{sid}/frame` (jpeg b64); `GET api/live/{sid}/state` | live observations, classification, events | Intel (flag) |
| `POST api/newsource` (multipart: file + keyframes) | job → self-configuration on new footage, then optional VSS upload with the generated prompt | Intel (flag) |
| `GET api/patterns?source=` | `[{statement, count, evidence:[Evidence]}]` | Intel (flag) |

### 5a. Exact response shapes the UI consumes (frozen 10-09 by the built frontend; `app/mock.js` is the reference implementation)

Backend agents: match these fields. Anything optional can be omitted; the UI degrades. Run the UI against your dev server with no `?mock=1` to check.

- **`GET api/status`** → `{ vss:{ok, detail?}, gpu:{cosmos:{ok}, yolo:{ok}, embed:{ok}, canary:{ok}}, llm:{ok, model, mode:"llm"|"rules_only"}, state:{backend:"vastdb"|"local", data_origin:"vastdb"|"seed"|"memory", snapshot_at?}, flags:{live, upload, weave, sports}, replay:{speed}, limits:{upload_mb}, stats?:{candidates, rejected, incidents} }`
- **`GET api/sources`** → `[{ id, camera_id, label, location, capture_type, segment_count, status, classification:{domain, confidence}|null, profile_summary:{title, objectives:<count>, entities:[str], mode}|null, incident_counts:{critical,high,medium,low}, replay:{active, speed, segment, total_segments, segment_uri?, caption?}|null, segment_seconds?:<number, enables timecode on the timeline>, reingest_status?:<latest ReingestJob status> }]`
- **`GET api/sources/{id}`** → the same base fields plus `classification` (full EnvironmentClassification), `profile` (full MonitoringProfile, optionally `dropped:[{id, name, reason}]` for objectives judged not applicable), `pipeline` (PipelineRun), `reingest` (latest ReingestJob or null), `evolution` ({steps}), `replay`, `incidents` ([Incident])
- **ReingestJob extras:** `filename`, `clips`, `eta` (string), `reason` (why this target), `started_at`, `finished_at`, `failed_stage`, `verify:{changed, total, with_terms}`
- **PipelineStep:** `{key, label?, status, summary, started_at?, ended_at?, trace_url?}`. `label` overrides the default label for custom steps (e.g. upload/index in new footage).
- **Incident extras:** `search_hint` (probe used by "Find similar"), `replay_pos` (0–1, for marks on the replay bar), `mode`, `created_at` (ISO; feed sort key). Evidence: `{role, segment, t_start, t_end, caption, yolo:{classes:{label:max_count}}, clip_url:"api/clip?source=…", camera_id?, similarity?}`.
- **`GET api/search?q=&source=`** → `[Evidence-like hit + similarity]` (or `{results:[…]}`)
- **`POST api/newsource`** (multipart: `file`, `keyframe_0..3` JPEGs, `keyframe_times` JSON) → `{job_id, source_id}`; `GET api/jobs/{id}` → `{status:"running"|"done"|"failed", error?}`
- **`POST api/live/session`** → `{sid}`; `POST api/live/{sid}/frame` `{image_b64, motion, reason:"motion"|"checkpoint", ts}`; `GET api/live/{sid}/state` → `{observations:[{ts, scene, entities, flags, latency_ms}], events:[{ts, severity, title, reason}], classification?, profile?:{objectives:[{name, severity}]}, stats:{frames_received, cosmos_calls_per_min, p50_latency_ms}}`
- Times: `t_start`, `t_end`, `started_at`, `peak_at` and `ended_at` on incidents are **seconds within the video** (numbers). `created_at`, job and step times are ISO strings.

## 6. Core flows

### 6.1 Self-configuration (`configurator.py`), the centerpiece
```
classify(source):
  sample = repository.sample_segments(source, n=12, spread across videos and time)
  yolo_hist = aggregate DetectionSummary.classes over sample (fallback: dashboard objects[] filtered by camera)
  hints = camera_id, location, capture_type          # weak hints, never decisive alone
  visual = gpu.cosmos(prompts.COSMOS_ENV_LOOK, one preview clip)   # optional; skip on timeout
  → llm.structured(prompts.CLASSIFY, …, EnvironmentClassification, fallback=rules_classify)
plan(source, classification):
  priors = domains.json[classification.domain]       # starting menu, not the answer
  → llm.structured(prompts.PLAN, priors + sample + yolo_hist + rule vocabulary, MonitoringProfile)
  validate: every RuleCall.primitive ∈ vocabulary; params typed; 3–8 objectives; drop unobservable ones
  information_gaps = objectives whose required facts never appear in sample captions
generate_prompt(profile):
  → llm.structured(prompts.COSMOS_PROMPT, profile + gaps + 3 sample captions, CosmosPrompt)
  enforce len ≤ 800 (one shorten retry, then fill prompts.SHORT_TEMPLATES[domain]; mark template_fallback)
```
Each step appends to `PipelineRun`. `rules_classify` (deterministic fallback) scores each domain by YOLO-class and caption-keyword overlap with `domains.json` cues, and sets `mode="rules_only"`.

### 6.2 Agent-controlled re-ingestion (`reingest.py`)
```
plan     → choose target: the most recent complete chunk of the source with the most candidate events
           (or a user pick); chunk_count ≤ 2 (hard cap, override flag); show prompt/target/clips/ETA
approve  → (explicit click; the agent plans, a human approves execution)
preparing   : snapshot captions of every segment in the target (tools/segments) → job.snapshot_before
reingesting : POST /dashboard/reingest {original_video, chunk_count, custom_prompt}; poll every 4–8 s
indexing    : VSS job completed, but new rows not yet visible (caption unchanged or pending_index > 0)
verifying   : re-read segments; ready when ≥ 60% of segments changed AND the captions mention ≥ 1
              objective-specific term or FLAGS line; else failed("captions did not change")
ready       : write AnalysisEvolution (generic caption → objective → prompt → new caption → event)
              and trigger monitor on the target
failed      : keep snapshot; surface the error; the source keeps monitoring generic captions
```
Guardrails: one active job per source, a hard chunk cap, every action audit-logged in the store, and never re-ingest the chunk marked `demo_reserved`.

### 6.3 Monitoring engine (`engine.py` + `rules.py`)
Two complementary sweeps over a configured source:
1. **Chronological replay.** Iterate ordered segments (`tools/segments`) per video. A replay clock reveals results at their video time (configurable speed). The UI badge reads "Archive replay · N×".
2. **Objective probes.** For each objective, run `semantic_probes` through `POST /search` filtered to this `camera_id` (`min_similarity` ≈ 0.3) to find candidates anywhere in the archive.

```
for segment in candidates:
  signals = [rule results for objective.detector]          # deterministic, cheap
  if all_of fails and no any_of passes and no caption FLAG and no strong probe hit: skip
  batch candidates (≤ 8 per call) → llm.structured(prompts.EVALUATE, …)
     evidence_quote MUST be an exact substring of the caption, else is_event=false (hallucination guard)
  merge consecutive positive segments (gap ≤ merge_gap_segments) → PotentialEvent(start, peak, end)
  → investigation job
```
Fallback without the LLM: a candidate becomes an event when the rule score is ≥ 0.75 (marked "rules-only").

### 6.4 Investigation (`investigate.py`)
```
context  = segments N-2 … N+2 (same original_video; cross chunk boundary via the stream/next chunk if cheap)
for each : caption, DetectionSummary (+ bbox proximity), FLAGS
related  = search(objective semantic probe, same camera, top 5, exclude window) + same query across cameras (top 3)
second   = gpu.cosmos(prompts.COSMOS_SECOND_LOOK, event clip) if GPU healthy and time budget allows
verdict  = llm.structured(prompts.INVESTIGATE, context + related + second, Investigation)
           every timeline item must cite a segment in context; else drop the item
incident = only if verdict ∈ {confirmed, likely}; severity = objective base ± modifiers
           (duration, repeat count, second-look agreement); false positives kept for audit, hidden by default
```
**Confidence** (explainable, renormalized over available components):
`0.30·llm_confidence + 0.25·temporal_consistency (share of neighbors supporting) + 0.20·cross_signal (YOLO and caption agree) + 0.15·second_look + 0.10·rule_score`. The UI always shows the components.

### 6.5 Live mode (`live.py`, flagged)
```
browser: getUserMedia → canvas every 500 ms → cheap motion gate in JS (pixel diff) →
         send JPEG when motion > τ or every 5 s checkpoint
backend: if YOLO accepts images (verify) → YOLO; gate: entity set changed / rule trigger / checkpoint
         → Cosmos (image_url, or a short clip if supported) with prompts.COSMOS_LIVE_OBSERVE
         first 3 observations → classify → plan (same configurator, live-observation flavour)
         observations → same rules + EVALUATE → live incidents (evidence = stored frames)
```
Never claim 30 FPS semantic analysis. Show measured latency and calls per minute in the UI.

### 6.6 New footage (`newsource.py`, flagged), the strongest proof
```
browser: user picks a self-recorded clip → extract 4 keyframes via <video>+<canvas> → POST api/newsource
backend: Cosmos env look on keyframes (or the clip, if small) → classify → plan → generate prompt
         → POST /videos/upload with custom_prompt = Sightline's prompt (+ camera_id "sightline-new-N")
         → poll explore until indexed → monitor → incidents
```
Sightline writes the ingestion prompt **before the footage ever enters the index**. Upload latency is unknown; test it before depending on it.

### 6.7 Patterns (`patterns.py`, flagged)
Group incidents by `objective_id` + context features, use the LLM to name recurring patterns (≥ 3 instances), and attach evidence clips. Sports: "Late weak-side rotation → 3 open corner looks." Warehouse: "4 proximity events at aisle 3 end-cap."

## 7. Domain engine
One engine, no per-domain code paths. A domain influences behavior only through data:
`domains.json` priors → the generated `MonitoringProfile` (objectives, detector specs, severity, wording, actions) → the generated `CosmosPrompt`. Adding a domain means adding a prior entry, and even with no prior, `general` plus the LLM planner still produces a profile. See `DOMAIN_PROFILES.md`.

## 8. Clip playback
`api/clip?source=<s3>` → backend streams from VSS `GET /videos/stream?source=…&token=<server JWT>`, forwarding `Range`, `Content-Range`, `Content-Type` and `Accept-Ranges`. The JWT never reaches the browser. The evidence triptych uses three `<video preload="metadata">` elements, and only the event clip autoplays.

## 9. State and persistence (`store.py`)
**Primary: VastDB, append-only.** Uses the official `vast-database/vastdb-write` pattern (data VIP = `S3_ENDPOINT`, our `VASTDB_BUCKET`).
- Schema **`sightline`** (pre-approved name). One table, **`records`**: `id utf8, kind utf8 (source|classification|profile|pipeline|event|incident|reingest_job|evolution), source_id utf8, version int64, payload utf8 (JSON of the models.py object), created_at utf8`.
- **Writes:** in-memory dicts are the working set. Every change inserts a new row with `version+1` (no updates or deletes, so it's simple and race-free with one writer), batched every 2 s from a background task.
- **Boot:** select `sightline.records`, keep the latest version per `(kind, id)`, hydrate memory, and set `data_origin="vastdb"`.
- **Optional second table** `sightline.incidents_flat` (id, source_id, camera_id, domain, event_type, severity, confidence, started_at, title). Gives judges an at-a-glance SQL view ("Sightline's incidents live in VastDB next to the video index").
- **Never** touch `vss-collection` or `vss-prompts-events`.

**Fallback** (VastDB unreachable from the pod, or the SDK fails at startup): `/tmp/state.json` + `seed_state.json` as before, with `data_origin="seed"` so the UI shows a "cached snapshot from HH:MM" badge. QA still exports `api/state/export` → `app/seed_state.json` at each gate.

## 10. Degradation matrix

| Failure | Behavior | UI |
|---|---|---|
| VSS login or search down | Serve store or seed; disable actions needing VSS | red "VSS" chip, "cached snapshot" badge |
| W&B error or malformed JSON | 1 repair retry → deterministic fallback (`rules_classify`, prior profile, rule-score events, template prompt) | "rules-only mode" chip on affected items |
| Cosmos slow or down | Skip env look and second look; live mode off | component marked "skipped" in confidence |
| YOLO sidecar missing | Rules fall back to caption terms | signal "no detections" |
| Re-ingest slow | Job continues in the background; monitor on generic captions | job progress bar, ETA |
| Re-ingest failed | Keep snapshot, show the error | evolution panel shows "failed" with the reason |
| Clip proxy fails | Show caption plus a "clip unavailable" frame | inline |
| JWT expired | Re-login once automatically | none |
| VastDB write fails or is unreachable from the pod | Keep in memory + `/tmp`; retry the batch; at boot fall back to seed | amber "state: local only" chip |
| Rollout fails | Previous ReplicaSet keeps serving; `kubectl rollout undo` | n/a |
| ConfigMap too large | `deploy.sh` refuses; trim | n/a |

## 11. Observability (Weave, flagged)
`weave.init(f"{WANDB_TEAM}/{WANDB_PROJECT}")` behind `WEAVE_ENABLED`, wrapped in try/except. Decorate with `@weave.op`: `classify_environment, generate_monitoring_profile, generate_cosmos_prompt, evaluate_candidates, investigate_event, create_incident, live_observe`. Put the trace URL in `PipelineStep.trace_url` when available. The OpenAI client calls are auto-traced.

## 12. Security
- Secrets reach the pod only through the K8s Secret. Never log them; redact `Authorization`, `token=` and `password` in logs.
- The browser never receives the VSS JWT or the GPU or W&B keys.
- No endpoint can start a re-ingest without a planned job plus an approve call. Chunk count is hard-capped.
- `fixtures/` and any file containing team URIs are gitignored. The public repo gets README, code and docs only.

## 13. UI (`index.html`, `app.js`, `styles.css`)

This is an operations platform, not a chatbot. Evidence dominates. Use a dark theme with severity colors (critical red, high orange, medium amber, low slate). Vanilla JS with hash routing (`#/source/<id>`, `#/incident/<id>`).

```
┌────────────────────────────────────────────────────────────────────────────┐
│ SIGHTLINE      ● MONITORING 3 sources · Archive replay 6×   VSS● GPU● LLM●  │
├──────────────┬─────────────────────────────────────────────────────────────┤
│ SOURCES      │  VIDEO (current segment, replay clock)                      │
│ ▸ Warehouse ●│                                                             │
│ ▸ Highway   ●├──────────────────────────────┬──────────────────────────────┤
│ ▸ Streets   ○│ AUTONOMOUS EVENTS (feed)     │ AUTONOMOUS PIPELINE          │
│ + New footage│ HIGH  Worker/forklift  00:42 │ ✓ Scene classified  WH · 95% │
├──────────────┤ MED   Blocked aisle    01:10 │ ✓ Plan generated  6 objectives│
│ PROFILE      │ ...                          │ ✓ Prompt generated  612/800  │
│ Warehouse    │                              │ ◐ Re-ingesting 3/12 clips    │
│ Safety       │                              │ ✓ Monitoring · 2 incidents   │
│ Watching:    │                              │                              │
│ • person     │                              │                              │
│ • forklift   │                              │                              │
└──────────────┴──────────────────────────────┴──────────────────────────────┘
```

**Views**
1. **Overview** (above): sources list (status dot, domain badge), active profile summary, live feed of incidents across sources, the pipeline panel for the selected source, and health chips.
2. **Source detail:** "How Sightline configured this source" (environment + confidence + evidence list "why"), objectives (severity, detector summary in plain words), generated Cosmos prompt with a char counter and the "information gaps" it addresses, re-ingest panel (plan → Approve button → status stepper Preparing / Re-ingesting / Indexing / Verifying / Ready / Failed with real progress), **Analysis Evolution** (generic caption → objective → prompt → new caption → event, each a card), and the latest incidents.
3. **Incident detail:** title, severity, confidence (expandable component breakdown); **BEFORE / EVENT / AFTER** players; timeline with timestamps that click to seek; entities (YOLO + caption); "Why Sightline flagged this"; investigation summary and counter-evidence; related events (thumbnails/clips); recommended review action. Neutral wording for security and retail.
4. **Search** (secondary): a query box scoped to a source or all, with results as evidence cards. Entry point: "Find similar" on an incident.
5. **New footage** (flagged): file picker → keyframes preview → the pipeline panel animates through real steps.
6. **Live** (flagged): webcam preview, gate stats (frames sent, Cosmos calls/min, latency), live observations, live incidents.

**Rules:** no hardcoded prefix. `const BASE = location.pathname.endsWith('/') ? location.pathname : location.pathname + '/'`, and every call is `fetch(BASE + 'api/...')`; clip `src` = `BASE + 'api/clip?source=…'`. Never `/api/...` and never a hardcoded `/app/`, because the workshop App button's prefix is unknown until Friday. Other rules: poll `api/status` every 5 s and the active view's data every 2 s; never block the UI on a job; every number shown has a tooltip saying where it came from; `?mock=1` loads `mock.js` so the UI can be built before the backend exists.
