# Sightline: Demo Plan

**Submitted as:** **Sightline**, *Self-configuring video safety agents*. Use case: autonomous discovery and investigation of **dangerous person–vehicle interactions**, with no operator-written rules or search prompts.

**Judges want to leave asking:** "What if every camera could configure its own AI monitoring system?"

**Framing rule:** the use case is specific; the solution is general. The first sentence is always about self-configuration, never "near-miss detection" (the most crowded SF category).

**Rule:** never type "find forklift near person" in the primary demo. The message is: *"I didn't ask Sightline what happened. Sightline decided this mattered."* Search appears only afterwards, as "find similar".

## 1. Formats

| Format | Length | Where |
|---|---|---|
| Submission video | 2:00–2:45 | Screen recording of the **deployed** app plus voiceover; YouTube unlisted or Loom link |
| Judge walkthrough (first round, at your table) | 3–4 min + Q&A | Live on the deployed app from your laptop |
| Stage demo (if a finalist; format unknown) | Same script, tighter | Live, with the video ready as backup |

## 2. Script (live walkthrough, about 3:30)

| t | Beat | On screen | Say (roughly) |
|---|---|---|---|
| 0:00 | Hook | Overview: sources all "Configured by Sightline", incident feed ticking (Archive replay badge visible) | "Most video AI needs someone to tell it what to look for. Sightline looks first, decides what matters, configures its own analysis, and investigates on its own. Today we pointed it at one problem: dangerous person–vehicle interactions. We never built a warehouse detector or a traffic detector." |
| 0:20 | Self-configuration | Source detail → "How Sightline configured this source": **Warehouse · 95%**, evidence list (forklifts in 7/12 captions, YOLO persons, racks) | "Nobody told it this is a warehouse. It sampled the index, the detections and one direct look with Cosmos, and classified it." |
| 0:45 | Planning | Objectives with severity; the **generated Cosmos prompt 612/800**; information gaps ("captions never say whether the forklift is moving") | "Then it planned what matters here, and noticed that the existing descriptions don't contain what it needs. So it wrote its own instructions for Cosmos." |
| 1:05 | Self-improvement | **Analysis Evolution** cards: generic caption → objective → prompt → re-analyzed caption → event. Re-ingest job history with real timings | "It re-ran VAST's pipeline on that footage with its own prompt. Before: 'a person walks in an aisle'. After: 'worker steps into the forklift path as it approaches.' That's the gap that turns video into an operational event." |
| 1:35 | Autonomous incident | Click the HIGH incident → BEFORE / EVENT / AFTER playing; timeline; why flagged; confidence breakdown (LLM 0.86, temporal 4/5, YOLO+caption agree, second look YES) | "It didn't alert right away. It pulled the segments before and after, checked the detections, asked Cosmos for a second look, and only then raised this, with every claim tied to a clip." |
| 2:05 | Adaptation | Switch to the dashcam/street source: different environment, different objectives, a pedestrian ↔ car incident. Optionally show the indoor source where Sightline marked the objective **not applicable** | "Same risk, different camera. In a warehouse it's a worker and a forklift; on the street it's a pedestrian and a car; indoors, Sightline decided it doesn't apply. Different rules, severity and action, and none of it hand-written." |
| 2:35 | New footage (if lane works) | "+ New footage" → a staged clip it has never seen → pipeline panel animates: analyzing environment → plan → prompt → upload with its own prompt | "Here's footage it's never seen. It's writing its ingestion prompt *before* the footage enters the index." (Talk over the steps; if indexing takes minutes, show the plan and prompt, then a previously processed upload.) |
| 3:00 | Stack | Pipeline panel / architecture slide in the README | "VAST stores and re-indexes the video, Cosmos and YOLO see, Embed retrieves, CoreWeave serves the GPUs, and W&B is Sightline's planning brain, traced in Weave." |
| 3:20 | Close | Overview | "What if every camera could configure its own AI monitoring system? That's Sightline." |

**Live-mode variant (if P11 works):** replace the 2:35 beat with the webcam. Sightline classifies the room ("indoor office/facility"), proposes objectives, and flags a staged "bag left unattended". Show measured latency and Cosmos calls/min to stay honest.

## 3. State to prepare before judges arrive (checklist)
- [ ] Deployed from tag `final`; `seed_state.json` exported after the last good run.
- [ ] Primary and secondary sources configured, with ≥ 1 incident each that you have **watched** (no surprises).
- [ ] Analysis Evolution populated from R1/R2 with a clear before/after caption pair.
- [ ] A `demo_reserved` chunk ready: optionally click **Plan re-ingest → Approve** at the start of a judge visit so they see a real job progressing.
- [ ] New-footage clip on the laptop desktop (H.264, ≤ 30 s, under the upload limit).
- [ ] Logged into https://workshop.thecosmoslabs.com (Cloudflare Access) on the laptop; the app opened via **App**.
- [ ] Tabs open: the app (overview), incident detail, Weave trace, README, demo video (local copy). Optional: a terminal with `query.py --schema sightline --table incidents_flat` to show incidents living in VastDB.
- [ ] Laptop: notifications off, display sleep off, charger in, Chrome flag set (live mode), zoom 110%.

## 4. Surviving infrastructure failures

| Failure during demo | Detect | Recover in under 15 s | Line to say |
|---|---|---|---|
| VSS backend slow or down | red VSS chip | App serves `seed_state.json` (badge "cached snapshot from 2:10 PM"); clips may not play → show captions + timeline | "VAST's backend is busy; this is the same agent's output from a run an hour ago, unedited." |
| W&B inference down | red LLM chip | Already-configured sources still work; new configs run `rules_only` (labeled) | "The planner falls back to deterministic rules, so it degrades instead of dying." |
| Cosmos/GPU down | red GPU chip | Skip second look and live; incidents still show the investigation from earlier | — |
| Re-ingest stuck | stepper not moving | Show the completed R1/R2 evolution | "Re-ingest is asynchronous; here's one that finished earlier." |
| Deployed app down | page error | `kubectl rollout undo` (30 s), or play the demo video | "Let me show the recording while it restarts." |
| Venue Wi-Fi down | — | Play the **local copy** of the demo video | — |
| Your laptop dies | — | Video link on your phone | — |

Two simultaneous failures (e.g. VSS + W&B): go straight to the video, then answer questions with the README architecture diagram.

## 5. Video recording plan
- **v1 insurance (at G3, ~1:45):** 90 s, rough, one source: config → incident triptych. Upload unlisted immediately and **save the link in `planning/SUBMISSION.md`**.
- **v2 final (record 3:50, upload by 4:05):** follow §2, 2:00–2:45. QuickTime screen recording (⌘⇧5) with built-in mic, or OBS. One take plus one retake max; no editing beyond trimming. Upload, check the link opens in an incognito window, keep a local copy.
- If v2 fails or runs late, submit v1. **Never reach 4:15 without a link.**

## 6. Judge Q&A prep

| Likely question | Answer |
|---|---|
| Isn't this just rules per domain? | The engine has *no* domain code. Domains are priors in a JSON file; the LLM planner generates the profile for each camera from evidence, and drops or adds objectives. Show the `general` fallback and new footage. |
| How do you avoid hallucinated events? | Deterministic gates first; the LLM must quote an exact substring of the caption; investigation checks temporal consistency across neighbors and a second look by Cosmos; the confidence breakdown shows every component. |
| Is it real-time? | Archive mode replays indexed segments chronologically, and the UI says so. Live mode runs on frames with a motion gate, and Cosmos only on changes, at a measured ~N calls/min. Re-ingest is honest async. |
| Why re-ingest? | Cosmos writes down only what the prompt asks for. Sightline detects information gaps and fixes the index itself, with snapshot, verification and a chunk cap. |
| What does W&B do? | Classification, planning, prompt writing, evaluation and investigation all run on W&B Inference, and each step is a Weave trace (show one). |
| What about VAST? | VAST is Sightline's memory twice over. The video index (hybrid search for probes and related events, ordered segments for investigation, re-ingest as an agent action) and Sightline's own knowledge (profiles, incidents, re-ingest history) sit side by side in the same VastDB, in a `sightline` schema next to `vss-collection`. |
| False positive rate? | Rejected candidates are kept for audit (show the count); we tuned on N segments. Don't invent precision numbers. |
| Privacy / accusation risk? | Neutral wording is enforced for security and retail; it's evidence for human review, never a verdict. |
| What's next? | Fleet onboarding: thousands of cameras self-configure; humans approve profiles; feedback on incidents tunes the priors. |

## 7. Submission checklist (submit by 4:15; official deadline 4:30)
- [ ] 4:10: repo switched to **public** and opened in an incognito window; README present; no secrets (`git log -p | grep -iE "password|token|secret"` checked).
- [ ] Video link works logged-out.
- [ ] tokens& → **Submit your project**: project name **Sightline**, subtitle *Self-configuring video safety agents*, description (`planning/SUBMISSION.md`), tools (VAST AI OS: S3/DataEngine/VastDB; NVIDIA Cosmos3-Reason, Cosmos-Embed1; YOLO11; CoreWeave GPUs; W&B Inference + Weave; Cursor), your name and email, deployed URL, screenshot.
- [ ] Re-check the tokens& page for format changes announced on the day.
