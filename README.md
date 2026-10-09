# Sightline

**Self-configuring video safety agents.** Built at the VAST Builders Challenge: Real-Time Video Agents Hack, New York, October 9, 2026 (Team 22).

Most video AI needs someone to tell it what to look for. Sightline looks at a camera first, decides what matters there, writes its own analysis strategy, and then finds and investigates incidents on its own. Nobody types a search.

For this build we pointed it at one problem: **dangerous person–vehicle interactions** (worker ↔ forklift in a warehouse, pedestrian ↔ car on a street). We never wrote a warehouse detector or a traffic detector; the same engine configured itself differently for each camera.

## What it does

```
camera footage (indexed in VAST)
   │
   ▼
1. UNDERSTAND   sample the index + YOLO detections → classify the environment
2. PLAN         generate monitoring objectives, detection rules and severities for this camera
                (and drop objectives that cannot happen here, e.g. vehicles indoors)
3. RECONFIGURE  notice what the existing descriptions don't say, write a new Cosmos prompt (≤ 800 chars)
                ├─ preview: send that prompt + the clip straight to Cosmos → specialized description in seconds
                └─ index:   submit the same prompt as a VAST re-ingest (asynchronous, tracked honestly)
4. OBSERVE      replay the archive in order; deterministic gates first, LLM only for ambiguous moments
5. INVESTIGATE  before/event/after segments, the same moment from other camera angles, related moments,
                a direct Cosmos second look, and a W&B verdict that must cite real segments
6. ACT          incident with severity, an explainable confidence breakdown, evidence clips and a
                recommended action; rejected candidates are kept for audit
```

### Results from the live run (Team 22 environment)

| Step | Result |
|---|---|
| Environment classification | `sdg_warehouse_cam-2` → warehouse (0.95), `nyc_streets_cam-1` → traffic (0.95), `smartspace_cam-1` → security (0.97) with person–vehicle objectives dropped as not applicable |
| Self-written Cosmos prompt | 700 of 800 characters for the warehouse camera; asks for forklift motion, person–vehicle distance, path crossings, before/during/after, and a `FLAGS:` line |
| Autonomous monitoring | first warehouse scan: 6 candidate moments, 47 rejected (safe scenes such as a worker standing near a parked forklift stay negative) |
| Investigation | confirmed incident with before/event evidence, **9 other camera angles** of the same scenario, a Cosmos second look and a 5-part confidence breakdown |
| Preview re-analysis | the clip plus Sightline's prompt, sent directly to Cosmos: specialized description back in **9.4 s** (`nvidia/cosmos3-nano-reasoner`), original VAST caption preserved, index untouched |

## Why it is built this way

- **Specific use case, general solution.** Domains are data (`app/domains.json`), not code paths. The planner turns a prior into a profile for each camera from evidence, using a fixed vocabulary of rule primitives the deterministic engine executes.
- **Evidence first.** An incident is only raised after the investigation checks context, other angles and a second look. Every claim in the timeline has to cite a real segment; the evaluator's quote must be an exact substring of the caption. Confidence is a weighted, displayed combination: LLM verdict, temporal consistency, YOLO/caption agreement, Cosmos second look, rule score.
- **Honest about time.** Monitoring replays indexed footage chronologically and the UI says "archive replay". A VAST re-ingest is shown as "submitted / pending index / indexed" from real status and an actual caption diff; it is never marked done early. In our environment a test re-ingest was accepted in 0.34 s but had not been indexed after 40 minutes, which is why the preview path exists.
- **Neutral language.** It flags interactions for human review; it never asserts intent or fault.

## Sponsor technology, and what each one does here

| | Role in Sightline |
|---|---|
| **VAST Data** (S3, DataEngine, VastDB) | The indexed video archive Sightline reads (hybrid search, ordered segments, detections), the re-ingest pipeline it drives with its own prompts, and the store for Sightline's own state (`sightline` schema next to the video index) |
| **NVIDIA Cosmos Reason** | Segment descriptions in the index, the direct second look during investigation, and the preview re-analysis with Sightline's prompt |
| **YOLO11** | Object classes, counts and pixel boxes for deterministic rules (person ↔ vehicle distance normalized by frame diagonal). It has no forklift class, so forklift understanding comes from Cosmos |
| **NVIDIA Cosmos Embed** | Semantic retrieval for objective probes and related moments |
| **CoreWeave** | GPU inference for all of the above |
| **Weights & Biases Inference** | Sightline's planning and decision layer: classify, plan, write prompts, evaluate candidates, investigate (Nemotron 3 Ultra, Llama 3.3 70B fallback) |
| **Cursor** | Agent-driven development with the challenge skills |

## Architecture

```
Browser ──HTTPS──▶ workshop App button ──▶ Ingress /app ──▶ FastAPI pod (code from a ConfigMap)
                                                             ├─ configurator.py   classify → plan → prompt
                                                             ├─ engine.py, rules.py  monitoring + candidates
                                                             ├─ investigate.py    evidence → verdict → incident
                                                             ├─ reingest.py       preview + VAST re-ingest
                                                             └─ adapters: vss_client · gpu_client · llm · repository · store
                                                                   │            │             │
                                                     VAST VSS backend   Cosmos / YOLO / Embed   W&B Inference
                                                     (search, segments, (CoreWeave GPUs)
                                                      re-ingest, VastDB)
```

- `app/`: backend (Python, FastAPI) and the single-page UI (vanilla JS, no build step). Deployed flat into a ConfigMap.
- `deploy/deploy.sh`: deploys to the team namespace on the event cluster.
- `planning/`: architecture, prompts, domain priors and the build plan written before and during the event.
- `tests/`: unit tests with fakes (`python -m pytest tests`).

Run the UI without any backend: serve `app/` statically and open `index.html?mock=1` (clearly marked mock data).

## Limitations

- Archive replay, not a live camera feed. A live-camera path exists in the design but is disabled in this deployment.
- Distances are estimated from the image, not measured.
- The VAST re-ingest queue did not finish during the event; the preview path shows the improved understanding without claiming the index changed.
