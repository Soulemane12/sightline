# Sightline: Domain Profiles

These are **priors**, not hard-coded behavior. On Friday the Architect turns this file into `app/domains.json`. The planner LLM receives the matching prior as a *starting menu* and must adapt it to what the camera actually shows: drop objectives the camera can't observe, add ones the evidence suggests, and tune parameters. The deterministic engine only executes the resulting `DetectorSpec`s built from the vocabulary below.

## 1. Rule primitive vocabulary (the only primitives the engine runs)

| Primitive | Params | Needs | Passes when |
|---|---|---|---|
| `entities_present` | `entities: [str]`, `min_count: {entity: n}` | YOLO or caption | every listed entity is present (YOLO class map **or** caption synonym) |
| `cooccur` | `a`, `b` | YOLO or caption | a and b both present in the segment |
| `bbox_proximity` | `a`, `b`, `max_gap_norm` (0.03–0.10), `min_frames` (≥ 2) | YOLO sidecar | the closest box edge gap / frame diagonal is ≤ max for ≥ min frames |
| `count_threshold` | `entity`, `op` (`>=`, `<=`), `value` | YOLO or caption numbers | count condition holds |
| `persistence` | `entity`, `min_segments`, `stationary: bool` | YOLO sidecar across segments | the entity stays in a similar box position for ≥ N consecutive segments |
| `disappearance` | `entity`, `present_segments`, `absent_segments` | YOLO across segments | present for N segments, then absent for M |
| `caption_terms` | `any: [str]`, `all: [str]`, `none: [str]` | caption | case-insensitive term/regex match |
| `caption_flag` | `flag` | specialized caption | the `FLAGS:` line contains the flag (only after Sightline's prompt re-ingest) |
| `semantic_probe` | `query`, `min_similarity` | VSS search | the segment appears in the probe results above threshold |
| `time_window` | `start`, `end` (HH:MM) | wall-clock metadata *(verify exists)* | captured_at falls in the window |

`DetectorSpec = {all_of: [...], any_of: [...], merge_gap_segments}`. The rule score is the fraction of rule calls that passed (all_of counts double).

## 2. Entity → YOLO class map (COCO-pretrained YOLO11s)

Use YOLO classes **only if they appear in `fixtures/dashboard_stats.json objects[]`** on Friday.

| Entity | YOLO classes | Caption synonyms | Note |
|---|---|---|---|
| person | `person` | person, worker, pedestrian, people, man, woman, shopper, player | reliable |
| vehicle | `car, truck, bus, motorcycle` | car, vehicle, truck, van, bus | reliable on roads |
| forklift | none (sometimes mis-detected as `truck`/`car`) | forklift, lift truck, reach truck, pallet jack | **caption-driven** |
| pallet | none | pallet, skid, boxes, crate, load | caption-driven |
| cyclist | `bicycle` (+ `person`) | cyclist, bike, bicycle | |
| bag | `backpack, handbag, suitcase` | bag, backpack, suitcase, package, box | unattended object |
| cart | none | cart, trolley, shopping cart | caption-driven |
| ball | `sports ball` | ball, basketball | small; often missed |
| phone | `cell phone` | phone | |

## 3. Shared severity rubric

| Severity | Meaning |
|---|---|
| critical | an imminent or actual injury, collision or fall; immediate response |
| high | an unsafe interaction that could cause harm in seconds (person and moving vehicle, restricted entry during activity) |
| medium | an operational hazard or anomaly needing attention this shift (blocked aisle, stalled vehicle, unattended object) |
| low | an unusual pattern worth review; no immediate risk |

**Modifiers** (investigation): +1 level if the event lasts ≥ 3 segments, repeats ≥ 3× in the source, or the second look confirms; −1 level if neighbors contradict or only one weak signal supports it. Never go above critical or below low.

## 4. Domain priors

Each prior has: **cues** (for classification), **entities**, **objectives** (id · severity · detector · probe · investigation questions), **wording**, and **actions**.

### 4.1 Warehouse / industrial safety
- **Cues:** racks, aisles, forklift, pallets, loading dock, hi-vis vests, ceiling-mounted fixed view. Corpus: `sdg_warehouse_cam-2`.
- **Entities:** person, forklift, pallet, cart, vehicle.

| id | sev | detector | semantic probe | investigation questions |
|---|---|---|---|---|
| `worker_vehicle_proximity` | high | all: cooccur(person, forklift); any: bbox_proximity(person, truck\|car, 0.06), caption_terms(near, close, beside, approaching), caption_flag(person_vehicle_proximity) | "forklift moving close to a worker in an aisle" | Was the forklift moving? Did their paths intersect? For how many segments? Did anyone react? |
| `person_in_vehicle_path` | high | all: cooccur(person, forklift); any: caption_terms(path, crossing, in front of, behind), caption_flag(person_in_vehicle_path) | "worker walks into the forklift travel path" | Did the person enter the lane before or after the forklift arrived? |
| `person_fall` | critical | any: caption_terms(fall, fell, slipped, on the ground, lying), caption_flag(fall) | "person falls to the floor in the warehouse" | Is the person still down in N+1/N+2? Did anyone respond? |
| `blocked_aisle` | medium | any: caption_terms(blocked, obstruct, pallet in aisle, debris), caption_flag(blocked_aisle); optional persistence(pallet) | "pallet left blocking an aisle or walkway" | How long has it stayed? Is traffic rerouting around it? |
| `restricted_zone_entry` | high | any: caption_terms(restricted, marked zone, caution area), caption_flag(restricted_zone) | "person inside a marked restricted zone" | Was equipment active at the time? |
| `congestion` | medium | any: count_threshold(person, >=, 5), caption_terms(crowded, congested), caption_flag(congestion) | "many workers and vehicles crowded in one aisle" | Duration? Vehicles waiting? |
| `repeated_near_miss` | high | derived by `patterns.py` (≥ 3 proximity incidents in the same zone) | n/a | Same location or time pattern? |

- **Wording:** "Worker / forklift proximity", "Possible fall, requires immediate review".
- **Actions:** "Notify the floor lead", "Review aisle traffic plan", "Add a pedestrian barrier at <location>".

### 4.2 Traffic / road safety
- **Cues:** lanes, road markings, vehicles in motion, intersection, highway overhead view (fixed) or a dashcam's forward view (moving). Corpus: `i24_cam-1`, `pie_cam-3`, `neighborhood_cam-1`, `sf_streets_cam-*`.
- **Entities:** vehicle, person, cyclist.

| id | sev | detector | semantic probe | investigation questions |
|---|---|---|---|---|
| `pedestrian_vehicle_proximity` | high | all: cooccur(person, vehicle); any: bbox_proximity(person, car\|truck\|bus, 0.05), caption_terms(crossing, near the car, in front of), caption_flag(pedestrian_vehicle_proximity) | "pedestrian close to a moving vehicle" | Was the vehicle moving? Who yielded? Was it a crosswalk? |
| `hard_braking` | high | any: caption_terms(brak, sudden stop, abrupt), caption_flag(hard_braking) | "vehicle braking hard" | What preceded it? Was there a following vehicle? |
| `lane_conflict` | medium | any: caption_terms(cut off, merg, swerv, lane change), caption_flag(lane_conflict) | "vehicle cuts into another lane abruptly" | Did both vehicles adjust? |
| `stalled_vehicle` | medium | any: persistence(car\|truck, 3, stationary), caption_terms(stopped, stalled, hazard lights, shoulder), caption_flag(stalled_vehicle) | "vehicle stopped in a travel lane" | How long? Is traffic queuing behind it? |
| `congestion` | low | any: count_threshold(car, >=, 15), caption_terms(congested, heavy traffic, queue), caption_flag(congestion) | "dense slow traffic" | Building or clearing? |
| `road_obstruction` | medium | any: caption_terms(debris, object on the road, obstruction), caption_flag(road_obstruction) | "object or debris on the road" | Are vehicles swerving around it? |

- **Wording:** neutral and observational ("Vehicle–pedestrian conflict"). No speed or distance claims unless measured.
- **Actions:** "Flag intersection for a signal-timing review", "Dispatch a road crew", "Add to the conflict hotspot report".

### 4.3 Security / surveillance
- **Cues:** a fixed elevated camera, building entrance, parking, street frontage, corridors, low activity with sporadic people or vehicles. Corpus: `neighborhood_cam-1`, `smartspace_cam-1`, `sf_streets_cam-*`.
- **Entities:** person, vehicle, bag.

| id | sev | detector | semantic probe | investigation questions |
|---|---|---|---|---|
| `restricted_entry` | high | any: caption_terms(restricted, behind the counter, staff door, fence, climb), caption_flag(restricted_entry) | "person enters a restricted area" | Entry point? Duration? Did they leave? |
| `loitering` | low | all: persistence(person, 4, stationary); any: caption_terms(waiting, standing, lingering), caption_flag(loitering) | "person lingering in one spot for a long time" | How long? Any interaction? |
| `unattended_object` | medium | any: persistence(backpack\|suitcase\|handbag, 3, stationary) without a person nearby, caption_terms(left behind, unattended), caption_flag(unattended_object) | "bag left unattended" | Who left it (N−k)? Was it picked up later? |
| `object_moved` | low | any: disappearance(bag, 2, 2), caption_terms(picked up, removed, carried away), caption_flag(object_moved) | "item removed from where it was" | Whose item? Neutral language only. |
| `unusual_vehicle_stop` | medium | any: persistence(car\|truck, 3, stationary) in the travel area, caption_terms(stops, idling, double-parked), caption_flag(unusual_vehicle_stop) | "vehicle stops in the street and waits" | Duration? Anyone entering or exiting? |
| `crowd_buildup` | medium | any: count_threshold(person, >=, 8), caption_flag(crowd_buildup) | "group of people gathering" | Growing? Movement pattern? |
| `after_hours_activity` | medium | all: time_window(20:00, 06:00) *(only if wall-clock exists)*; any: entities_present(person) | n/a | Expected personnel? |

- **Wording (mandatory):** "potential incident", "anomalous event", "requires review", "possible loss-prevention event". Never "theft", "suspect" or "criminal".
- **Actions:** "Review footage", "Notify on-site security", "Check access logs for <time>".

### 4.4 Retail
- **Cues:** shelves with products, checkout counters, carts, store entrance, shoppers. No corpus footage known; upload your own (staged) if used.
- **Entities:** person, cart, bag, product.

| id | sev | detector | semantic probe | investigation questions |
|---|---|---|---|---|
| `item_out_of_view` | medium | any: caption_terms(into a bag, into pocket, under jacket, out of view), caption_flag(item_out_of_view) | "shopper puts an item into a bag" | Sequence shelf → bag → checkout or exit? |
| `exit_after_pickup` | medium | derived: an item_out_of_view event followed within 3 segments by caption_terms(exit, door, leaves) | n/a | Did the person pass checkout? |
| `unattended_checkout` | medium | any: caption_terms(no cashier, unattended register, waiting at checkout), caption_flag(unattended_checkout) | "customers waiting at an unattended checkout" | Queue length? Duration? |
| `queue_buildup` | low | any: count_threshold(person, >=, 6), caption_flag(queue_buildup) | "long checkout line" | Growing? |
| `spill` | medium | any: caption_terms(spill, liquid on floor, broken), caption_flag(spill) | "spill on the store floor" | Has anyone walked through it? |
| `abandoned_cart` | low | any: persistence(cart, 4, stationary) | "cart left in an aisle" | |
| `restricted_entry` | medium | any: caption_terms(staff only, stockroom, behind counter), caption_flag(restricted_entry) | "customer enters a staff-only area" | |

- **Wording (mandatory):** "possible loss-prevention event, requires review". **Detection is not guilt.**
- **Actions:** "Ask staff to assist", "Open another register", "Send a cleanup crew", "Review for loss prevention".

### 4.5 Sports
- **Cues:** court or field markings, jerseys, a ball, players in formation, scoreboard. No corpus footage known; the presets `sports` and `nhl` exist (check whether any footage is indexed). Self-recorded footage only.
- **Entities:** player (person), ball, hoop/goal.

| id | sev* | detector | semantic probe | investigation questions |
|---|---|---|---|---|
| `shot_attempt` | info | any: caption_terms(shoot, shot, layup, dunk, three-pointer), caption_flag(shot_made\|shot_missed) | "player takes a shot" | Open or contested? Made? Location? |
| `open_look` | notable | any: caption_terms(wide open, unguarded, open shot), caption_flag(open_look) | "player wide open for a shot" | Which defensive action left them open (N−1, N−2)? |
| `turnover` | notable | any: caption_terms(steal, turnover, lost the ball, out of bounds), caption_flag(turnover) | "turnover / steal" | Pass or dribble? Pressure? |
| `defensive_breakdown` | notable | any: caption_terms(late rotation, missed assignment, left open, switch), caption_flag(defensive_breakdown) | "defense fails to rotate" | Who was responsible? Result? |
| `fast_break` | info | any: caption_terms(fast break, transition), caption_flag(fast_break) | "fast break" | Numbers advantage? |
| `highlight` | info | derived: shot_made after a fast_break or open_look | n/a | |

*Sports maps severity to **coaching importance**: info → low, notable → medium, pattern → high. Output is a **coaching report**: patterns from `patterns.py` with evidence clips ("Late weak-side rotation produced 3 open corner attempts: clips 1, 2, 3"). Canary can align commentary to events (optional).

### 4.6 General (fallback)
- **When:** classification confidence < 0.6 or no prior fits.
- **Objectives:** `notable_activity` (low; caption_terms(unusual, sudden, falls, crowd, running)), `person_vehicle_proximity` (medium; cooccur(person, vehicle)), `scene_change` (low; YOLO entity set changes markedly between segments).
- The planner is told to propose up to 3 environment-specific objectives from the evidence. This is how Sightline handles "something nobody's thought of".

## 5. Cross-domain example: one risk, different rules

The architecture doc's showcase query, "person close to a moving vehicle", spans every pack. Sightline must contextualize it:

| Environment | Entities | Rule | Severity | Action |
|---|---|---|---|---|
| Warehouse | worker + **forklift** (caption) | cooccur + caption proximity; YOLO person box only | high | notify floor lead, barrier |
| Highway (overhead) | (rare) person + car/truck | person present on a highway is itself anomalous | critical | dispatch / alert |
| Dashcam (moving camera) | pedestrian + **ego vehicle** | person box large and central + caption "in front of" | high | driver coaching clip |
| Neighborhood / street | person + passing car | bbox_proximity + crossing terms | medium | hotspot report |
| Indoor smart space | person + cart / equipment | usually not applicable → objective dropped | n/a | n/a |

A judge seeing the same concept produce different objectives, severities and actions per camera is the clearest proof that Sightline is not a YOLO rule engine.

## 6. Example generated profile (warehouse)

```json
{
  "source_id": "sdg_warehouse_cam-2",
  "domain": "warehouse",
  "version": 1,
  "mode": "llm",
  "objectives": [
    {
      "id": "worker_vehicle_proximity",
      "name": "Worker / forklift proximity",
      "description": "A person within close range of a moving forklift.",
      "severity": "high",
      "rationale": "Captions show forklifts and pedestrians sharing aisles in 7 of 12 sampled segments.",
      "detector": {
        "all_of": [{"primitive": "cooccur", "params": {"a": "person", "b": "forklift"}}],
        "any_of": [
          {"primitive": "caption_terms", "params": {"any": ["near", "close to", "approaching", "beside"]}},
          {"primitive": "caption_flag", "params": {"flag": "person_vehicle_proximity"}}
        ],
        "merge_gap_segments": 1
      },
      "semantic_probes": ["forklift moving close to a worker in an aisle"],
      "investigation_questions": ["Was the forklift moving?", "Did paths intersect?", "How long were they close?"],
      "wording": {"title": "Worker / forklift proximity", "review_action": "Notify floor lead; review aisle traffic plan"}
    }
  ],
  "information_gaps": [
    "Captions rarely state whether the forklift is moving",
    "Captions never describe distance between workers and vehicles"
  ],
  "generated_prompt": {
    "text": "Warehouse safety analysis. SCENE: ... FLAGS: ...",
    "chars": 612,
    "covers": ["worker_vehicle_proximity", "person_in_vehicle_path", "blocked_aisle"],
    "rationale": "Adds vehicle motion and person–vehicle distance, which current captions lack.",
    "template_fallback": false
  }
}
```
