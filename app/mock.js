'use strict';
/* Mock backend for UI development (?mock=1 only). Shapes follow planning/ARCHITECTURE.md §4–5.
   All content here is invented for layout work; it must never be shown as real results. */
(function () {
  const T0 = Date.now();
  const SEG = 5;
  const iso = ms => new Date(ms).toISOString();
  const since = ms => Date.now() - ms;
  const segUri = (cam, i) => `s3://team-x-vss-chunks-segments/team-x/${cam}/segment_${String(i).padStart(4, '0')}.mp4`;
  const clone = o => JSON.parse(JSON.stringify(o));

  const WAREHOUSE_PROMPT = 'Warehouse safety analysis. SCENE: area type (aisle, dock, open floor) and layout. ENTITIES: count people, forklifts, pallets, carts; note hi-vis vests. ACTIONS: what each person and vehicle does; is each forklift moving, which direction, carrying a load. INTERACTIONS: how close people get to moving forklifts; anyone walking in a vehicle path or crossing in front of or behind a forklift. HAZARDS: blocked aisles or walkways, pallets or objects in paths, falls, people in marked or restricted zones. TIMELINE: for any notable moment, say what happens before, during and after. FLAGS: list any of person_vehicle_proximity, person_in_vehicle_path, blocked_aisle, fall, restricted_zone, congestion, or none.';
  const TRAFFIC_PROMPT = 'Traffic safety analysis. SCENE: road type (highway, intersection, residential street), lanes, signals, crosswalks, camera view (fixed or dashcam). ROAD USERS: cars, trucks, buses, cyclists, pedestrians and where they are. ACTIONS: turns, hard braking, sudden stops, vehicles failing to yield. CONFLICTS: pedestrians or cyclists close to moving vehicles, near collisions. TIMELINE: what happens before, during and after any notable moment. FLAGS: list any of pedestrian_vehicle_proximity, hard_braking, failure_to_yield, or none.';

  const objective = (id, name, severity, description, detector, probes, rationale) =>
    ({ id, name, severity, description, detector, semantic_probes: probes, rationale, investigation_questions: [], wording: { title: name, review_action: '' } });

  const SOURCES = [
    {
      id: 'sdg_warehouse_cam-2', camera_id: 'sdg_warehouse_cam-2', label: 'Warehouse aisle cam', location: 'warehouse3', capture_type: 'warehouse',
      segment_count: 178, status: 'monitoring', replayStart: 30, total: 178,
      classification: {
        domain: 'warehouse', confidence: 0.94, camera_type: 'fixed', mode: 'llm',
        description: 'Fixed ceiling camera over a warehouse aisle with pallet racking; workers on foot share the aisle with forklifts.',
        important_entities: ['person', 'forklift', 'pallet'],
        evidence: [
          { signal: 'Forklifts described in 9 of 12 sampled captions', source: 'caption', supports: 'warehouse' },
          { signal: 'Pallet racking and aisles in every sample', source: 'caption', supports: 'warehouse' },
          { signal: 'YOLO: person in 11/12 segments, truck in 4/12 (likely forklift)', source: 'yolo', supports: 'people and vehicles share space' },
          { signal: 'capture_type=warehouse', source: 'metadata', supports: 'weak hint only' },
        ],
      },
      profile: {
        domain: 'warehouse', mode: 'llm', version: 1,
        objectives: [
          objective('worker_vehicle_proximity', 'Worker / forklift proximity', 'high', 'A person within close range of a moving forklift.',
            { all_of: [{ primitive: 'cooccur', params: { a: 'person', b: 'forklift' } }], any_of: [{ primitive: 'caption_terms', params: { any: ['near', 'close to', 'approaching'] } }, { primitive: 'caption_flag', params: { flag: 'person_vehicle_proximity' } }] },
            ['forklift moving close to a worker in an aisle'], 'Forklifts and pedestrians share aisles in 7 of 12 samples.'),
          objective('person_in_vehicle_path', 'Person in forklift path', 'high', 'A worker steps into the travel path of a moving forklift.',
            { all_of: [{ primitive: 'cooccur', params: { a: 'person', b: 'forklift' } }], any_of: [{ primitive: 'caption_terms', params: { any: ['path', 'crossing', 'in front of', 'behind'] } }] },
            ['worker walks into the forklift travel path'], 'Aisles are single-lane; crossing behind a reversing forklift is the classic near miss.'),
          objective('blocked_aisle', 'Blocked aisle', 'medium', 'A pallet or object obstructs a walkway or aisle.',
            { all_of: [], any_of: [{ primitive: 'caption_terms', params: { any: ['blocked', 'pallet in the aisle', 'obstruct'] } }, { primitive: 'persistence', params: { entity: 'pallet', min_segments: 3, stationary: true } }] },
            ['pallet left blocking an aisle'], 'Blocked aisles push pedestrians into vehicle lanes.'),
          objective('person_fall', 'Possible fall', 'critical', 'A person on the floor or falling.',
            { all_of: [], any_of: [{ primitive: 'caption_terms', params: { any: ['fell', 'falls', 'on the ground', 'lying'] } }] },
            ['person falls to the floor'], 'Low base rate but critical severity.'),
        ],
        information_gaps: ['Captions rarely say whether a forklift is moving or parked', 'Captions never describe how close workers get to vehicles'],
        generated_prompt: { text: WAREHOUSE_PROMPT, chars: WAREHOUSE_PROMPT.length, covers: ['worker_vehicle_proximity', 'person_in_vehicle_path', 'blocked_aisle', 'person_fall'], rationale: 'Adds vehicle motion and person–vehicle distance.', template_fallback: false },
      },
    },
    {
      id: 'pie_cam-3', camera_id: 'pie_cam-3', label: 'Toronto dashcam', location: 'toronto', capture_type: 'live_driving',
      segment_count: 412, status: 'monitoring', replayStart: 70, total: 412,
      classification: {
        domain: 'traffic', confidence: 0.91, camera_type: 'moving', mode: 'llm',
        description: 'Forward-facing dashcam on urban streets; frequent intersections, crosswalks and pedestrians near the curb.',
        important_entities: ['pedestrian', 'car', 'cyclist'],
        evidence: [
          { signal: 'Captions describe the road ahead from the driver’s view', source: 'caption', supports: 'moving camera' },
          { signal: 'YOLO: car in 12/12, person in 8/12', source: 'yolo', supports: 'people near traffic' },
          { signal: 'Crosswalks and signals in 6 of 12 samples', source: 'caption', supports: 'urban intersections' },
        ],
      },
      profile: {
        domain: 'traffic', mode: 'llm', version: 1,
        objectives: [
          objective('pedestrian_vehicle_proximity', 'Pedestrian / vehicle conflict', 'high', 'A pedestrian close to the path of the moving ego vehicle.',
            { all_of: [{ primitive: 'cooccur', params: { a: 'person', b: 'vehicle' } }], any_of: [{ primitive: 'bbox_proximity', params: { a: 'person', b: 'car', max_gap_norm: 0.05, min_frames: 2 } }, { primitive: 'caption_terms', params: { any: ['crossing', 'in front of', 'steps into'] } }] },
            ['pedestrian crossing in front of the car'], 'Pedestrians appear near the curb in two thirds of samples.'),
          objective('hard_braking', 'Hard braking', 'medium', 'The ego vehicle or the vehicle ahead stops abruptly.',
            { all_of: [], any_of: [{ primitive: 'caption_terms', params: { any: ['brakes', 'sudden stop', 'abruptly'] } }] },
            ['vehicle braking hard'], 'Braking often precedes conflicts at intersections.'),
          objective('failure_to_yield', 'Failure to yield at crosswalk', 'high', 'A vehicle turns through a crosswalk while a pedestrian is crossing.',
            { all_of: [{ primitive: 'cooccur', params: { a: 'person', b: 'vehicle' } }], any_of: [{ primitive: 'caption_terms', params: { any: ['turns', 'crosswalk'] } }] },
            ['car turning while a pedestrian is in the crosswalk'], 'Turning traffic is visible at most intersections.'),
        ],
        information_gaps: ['Captions do not say who yielded at the crosswalk'],
        generated_prompt: { text: TRAFFIC_PROMPT, chars: TRAFFIC_PROMPT.length, covers: ['pedestrian_vehicle_proximity', 'hard_braking', 'failure_to_yield'], rationale: 'Adds yielding behavior and distance to pedestrians.', template_fallback: false },
      },
    },
    {
      id: 'neighborhood_cam-1', camera_id: 'neighborhood_cam-1', label: 'Neighborhood street', location: 'neighborhood', capture_type: 'surveillance',
      segment_count: 960, status: 'configured', total: 960,
      classification: {
        domain: 'security', confidence: 0.82, camera_type: 'fixed', mode: 'llm',
        description: 'Fixed residential street camera; cars pass and park, occasional pedestrians on the sidewalk.',
        important_entities: ['car', 'person'],
        evidence: [
          { signal: 'Houses and parked cars in every sample', source: 'caption', supports: 'residential street' },
          { signal: 'YOLO: car in 12/12, person in 3/12', source: 'yolo', supports: 'mostly vehicle traffic' },
        ],
      },
      profile: {
        domain: 'security', mode: 'llm', version: 1,
        objectives: [
          objective('person_vehicle_proximity', 'Person near a passing vehicle', 'medium', 'A pedestrian close to a moving car on the street.',
            { all_of: [{ primitive: 'cooccur', params: { a: 'person', b: 'car' } }], any_of: [{ primitive: 'bbox_proximity', params: { a: 'person', b: 'car', max_gap_norm: 0.06, min_frames: 2 } }] },
            ['person walking close to a passing car'], 'Sidewalk is narrow; cars pass close.'),
          objective('unusual_vehicle_stop', 'Unusual vehicle stop', 'low', 'A vehicle stops in the travel lane and waits.',
            { all_of: [], any_of: [{ primitive: 'persistence', params: { entity: 'car', min_segments: 3, stationary: true } }] },
            ['car stopped in the street'], 'Day-scale footage makes stops measurable.'),
        ],
        information_gaps: [],
      },
    },
    {
      id: 'smartspace_cam-1', camera_id: 'smartspace_cam-1', label: 'Indoor smart space', location: 'indoor', capture_type: 'surveillance',
      segment_count: 102, status: 'configured', total: 102,
      classification: {
        domain: 'security', confidence: 0.76, camera_type: 'fixed', mode: 'llm',
        description: 'Indoor facility corridor and open area; people walk through, no vehicles observed.',
        important_entities: ['person', 'bag'],
        evidence: [
          { signal: 'Corridors and equipment in every sample', source: 'caption', supports: 'indoor facility' },
          { signal: 'YOLO: person in 12/12, no vehicle classes in any sample', source: 'yolo', supports: 'no vehicles' },
        ],
      },
      profile: {
        domain: 'security', mode: 'llm', version: 1,
        objectives: [
          objective('crowd_buildup', 'Crowd buildup', 'medium', 'A group gathering in a corridor.',
            { all_of: [], any_of: [{ primitive: 'count_threshold', params: { entity: 'person', op: '>=', value: 8 } }] }, ['group of people gathering'], 'Corridor is a choke point.'),
        ],
        dropped: [{ id: 'person_vehicle_proximity', name: 'Person / vehicle proximity', reason: 'No vehicles detected in 12/12 sampled segments, so this objective cannot occur here.' }],
        information_gaps: [],
      },
    },
  ];

  // ---------- incidents (revealed when the replay clock passes them)
  function mkIncident(spec) {
    const n = spec.seg;
    const cap = spec.captions;
    const roles = ['before', 'before', 'event', 'after', 'after'];
    const evidence = cap.map((c, k) => ({
      role: roles[k], segment: segUri(spec.cam, n - 2 + k), t_start: (n - 2 + k) * SEG, t_end: (n - 1 + k) * SEG, caption: c,
      yolo: { classes: spec.yolo[k] || {} }, clip_url: null,
    }));
    const comps = [
      { name: 'LLM evaluation', value: spec.conf[0], weight: 0.30, explanation: 'Evaluator verdict with an exact quote from the caption' },
      { name: 'Temporal consistency', value: spec.conf[1], weight: 0.25, explanation: 'Share of N±2 neighbors consistent with the event' },
      { name: 'YOLO + caption agree', value: spec.conf[2], weight: 0.20, explanation: 'Detected classes match the entities in the description' },
      { name: 'Cosmos second look', value: spec.conf[3], weight: 0.15, explanation: 'Direct Cosmos3-Reason check of the event clip' },
      { name: 'Rule score', value: spec.conf[4], weight: 0.10, explanation: 'Fraction of the objective’s rules that passed' },
    ];
    const value = comps.reduce((s, c) => s + c.value * c.weight, 0);
    return {
      id: spec.id, source_id: spec.cam, domain: spec.domain, objective_id: spec.objective, event_type: spec.objective,
      title: spec.title, severity: spec.severity, confidence: { value, components: comps }, summary: spec.summary,
      started_at: (n - 1) * SEG, peak_at: n * SEG + 2, ended_at: (n + 1) * SEG, camera_id: spec.cam, location: spec.location,
      entities: spec.entities, evidence, recommended_action: spec.action, search_hint: spec.probe, seg: n, mode: 'llm',
      investigation: {
        verdict: spec.verdict || 'confirmed', why_flagged: spec.why, counter_evidence: spec.counter,
        timeline: spec.timeline.map(([dk, text]) => ({ t: (n + dk) * SEG + 1, text, segment: segUri(spec.cam, n + dk) })),
        start_segment: segUri(spec.cam, n - 1), peak_segment: segUri(spec.cam, n), end_segment: segUri(spec.cam, n + 1),
        answers: spec.answers.map(([question, answer]) => ({ question, answer })),
        second_look: { verdict: spec.second[0], text: spec.second[1] },
        related: (spec.related || []).map(([seg, cam, caption, sim]) => ({ role: 'related', segment: segUri(cam, seg), camera_id: cam, t_start: seg * SEG, t_end: (seg + 1) * SEG, caption, similarity: sim, clip_url: null })),
      },
    };
  }

  const INCIDENTS = [
    mkIncident({
      id: 'inc-wh-023', cam: 'sdg_warehouse_cam-2', domain: 'warehouse', location: 'warehouse3', seg: 23, objective: 'worker_vehicle_proximity',
      title: 'Worker / forklift proximity', severity: 'high', entities: ['person', 'forklift', 'pallet racking'], probe: 'forklift moving close to a worker in an aisle',
      summary: 'A worker walking north in aisle 3 came within roughly an arm’s length of a forklift reversing out of a rack bay. Neither stopped.',
      captions: [
        'A worker in a hi-vis vest walks along aisle 3 between pallet racks. A forklift is parked in a rack bay on the right.',
        'The worker continues walking north. The forklift’s reverse lights turn on. FLAGS: none',
        'The forklift reverses out of the bay into the aisle while the worker passes directly behind it, very close to the rear of the vehicle. FLAGS: person_vehicle_proximity, person_in_vehicle_path',
        'The forklift stops briefly and turns toward the dock. The worker continues past without stopping.',
        'The aisle is clear; the forklift moves away toward the loading dock.',
      ],
      yolo: [{ person: 1 }, { person: 1, truck: 1 }, { person: 1, truck: 1 }, { person: 1, truck: 1 }, { truck: 1 }],
      conf: [0.9, 0.8, 1.0, 1.0, 0.75], why: 'A person and a moving forklift were described in the same segment, close together, and the re-analysis flagged person_vehicle_proximity. The forklift was reversing, which the original captions never said.',
      counter: 'The forklift may have been moving slowly; distance is estimated from the image, not measured.',
      timeline: [[-2, 'Worker enters aisle 3 on foot'], [-1, 'Forklift reverse lights on'], [0, 'Forklift reverses into the aisle behind the worker (closest point)'], [1, 'Forklift stops, turns toward the dock'], [2, 'Paths separate']],
      answers: [['Was the forklift moving?', 'Yes. It was reversing out of a rack bay (segment 23).'], ['Did their paths intersect?', 'Yes. The worker passed directly behind the reversing forklift.'], ['How long were they close?', 'About one segment (≈5 s).'], ['Did anyone react?', 'The forklift stopped briefly after the pass; the worker did not stop.']],
      second: ['YES', 'A worker walks immediately behind a forklift that is reversing into the aisle.'],
      related: [[88, 'sdg_warehouse_cam-2', 'A forklift turns into aisle 3 while a worker walks along the racks.', 0.71], [140, 'sdg_warehouse_cam-2', 'Worker steps out from behind a rack as a forklift passes.', 0.66]],
      action: 'Notify the floor lead. Review the aisle 3 traffic plan; consider a pedestrian barrier at the rack-bay exits.',
    }),
    mkIncident({
      id: 'inc-wh-061', cam: 'sdg_warehouse_cam-2', domain: 'warehouse', location: 'warehouse3', seg: 61, objective: 'blocked_aisle',
      title: 'Pallet blocking the walkway', severity: 'medium', entities: ['pallet', 'person'], probe: 'pallet left blocking an aisle',
      summary: 'A pallet was left in the marked walkway for at least four segments; a worker stepped into the vehicle lane to get around it.',
      captions: ['A forklift sets a pallet down near the end of aisle 2.', 'The pallet remains on the floor partly inside the marked walkway.', 'A worker steps around the pallet into the vehicle lane to pass. FLAGS: blocked_aisle', 'The pallet is still in the walkway; nobody moves it.', 'The pallet remains in place.'],
      yolo: [{ truck: 1 }, {}, { person: 1 }, {}, {}],
      conf: [0.85, 1.0, 0.6, 0.0, 0.8], why: 'Re-analysis flagged blocked_aisle and the pallet persisted across 4 consecutive segments.',
      counter: 'The pallet may be in a temporary staging spot.', timeline: [[-2, 'Pallet set down'], [0, 'Worker detours into the vehicle lane'], [2, 'Pallet still in walkway']],
      answers: [['How long has it stayed?', 'At least 4 segments (≈20 s) in the sampled window.'], ['Is traffic rerouting?', 'Yes. A worker detoured into the vehicle lane.']],
      second: ['UNCLEAR', 'Second look skipped (time budget).'], action: 'Ask the floor team to clear the walkway at the end of aisle 2.',
    }),
    mkIncident({
      id: 'inc-wh-118', cam: 'sdg_warehouse_cam-2', domain: 'warehouse', location: 'warehouse3', seg: 118, objective: 'person_in_vehicle_path',
      title: 'Worker crosses in front of a moving forklift', severity: 'high', entities: ['person', 'forklift'], probe: 'worker walks into the forklift travel path',
      summary: 'A worker crossed the main aisle a few meters in front of a forklift carrying a load; the forklift braked.',
      captions: ['A loaded forklift drives down the main aisle toward the camera.', 'A worker appears at the end of a rack row, looking at a handheld scanner.', 'The worker steps into the main aisle in front of the moving forklift, which brakes. FLAGS: person_in_vehicle_path, person_vehicle_proximity', 'The forklift waits while the worker finishes crossing.', 'The forklift continues down the aisle.'],
      yolo: [{ truck: 1 }, { person: 1, truck: 1 }, { person: 1, truck: 1 }, { person: 1, truck: 1 }, { truck: 1 }],
      conf: [0.95, 1.0, 1.0, 1.0, 1.0], why: 'The worker entered the forklift’s travel path while it was moving; the forklift had to brake.',
      counter: 'None found in the context window.', timeline: [[-2, 'Loaded forklift approaching'], [-1, 'Worker distracted by scanner'], [0, 'Worker steps into the path; forklift brakes'], [1, 'Forklift waits'], [2, 'Normal traffic resumes']],
      answers: [['Did the person enter the lane before the forklift arrived?', 'No. The forklift was already approaching (segment 116).'], ['Was it avoided?', 'Yes. The forklift braked (segment 118).']],
      second: ['YES', 'A worker walks into the aisle directly in front of a moving forklift.'], action: 'Notify the floor lead; recurring at rack-row exits (see the related moment from 10:42).',
    }),
    mkIncident({
      id: 'inc-pie-077', cam: 'pie_cam-3', domain: 'traffic', location: 'toronto', seg: 77, objective: 'pedestrian_vehicle_proximity',
      title: 'Pedestrian steps out in front of the car', severity: 'high', entities: ['pedestrian', 'car'], probe: 'pedestrian crossing in front of the car',
      summary: 'A pedestrian stepped off the curb mid-block between parked cars; the driver braked hard.',
      captions: ['The car drives along a two-lane street with parked cars on the right.', 'A pedestrian stands between two parked cars near the curb.', 'The pedestrian steps into the lane directly in front of the car, which brakes hard. FLAGS: pedestrian_vehicle_proximity, hard_braking', 'The pedestrian finishes crossing; the car waits.', 'The car continues; the street ahead is clear.'],
      yolo: [{ car: 3 }, { car: 3, person: 1 }, { car: 2, person: 1 }, { car: 2, person: 1 }, { car: 2 }],
      conf: [0.92, 0.8, 1.0, 1.0, 1.0], why: 'A pedestrian box came within 3% of the frame of the car’s path for 4 frames, and the caption describes hard braking.',
      counter: 'Speed is unknown; dashcam distance is estimated.', timeline: [[-1, 'Pedestrian waiting between parked cars'], [0, 'Pedestrian steps out; car brakes hard'], [1, 'Car waits'], [2, 'Clear']],
      answers: [['Was it a crosswalk?', 'No. Mid-block, between parked cars.'], ['Who yielded?', 'The driver, by braking hard.']],
      second: ['YES', 'A pedestrian steps into the lane immediately in front of the vehicle.'], action: 'Add to the driver-coaching clip set; flag the block for a mid-block crossing review.',
    }),
    mkIncident({
      id: 'inc-pie-190', cam: 'pie_cam-3', domain: 'traffic', location: 'toronto', seg: 190, objective: 'failure_to_yield',
      title: 'Turning car cuts through an occupied crosswalk', severity: 'high', entities: ['pedestrian', 'car'], probe: 'car turning while a pedestrian is in the crosswalk',
      summary: 'A car ahead turned right through the crosswalk while two pedestrians were crossing.',
      captions: ['The car approaches a signalized intersection.', 'Two pedestrians begin crossing on the walk signal.', 'A white car ahead turns right through the crosswalk while the pedestrians are still in it. FLAGS: failure_to_yield, pedestrian_vehicle_proximity', 'The pedestrians pause, then continue crossing.', 'The intersection clears.'],
      yolo: [{ car: 4 }, { car: 4, person: 2 }, { car: 3, person: 2 }, { car: 3, person: 2 }, { car: 2 }],
      conf: [0.88, 0.6, 1.0, 1.0, 0.8], why: 'Person and vehicle co-occur at a crosswalk and the re-analysis flagged failure_to_yield.',
      counter: 'The turn could have been on the tail of the signal phase.', timeline: [[-1, 'Pedestrians start crossing'], [0, 'Car turns through the crosswalk'], [1, 'Pedestrians pause']],
      answers: [['Who yielded?', 'The pedestrians paused; the car did not yield.']],
      second: ['YES', 'A car turns across a crosswalk occupied by pedestrians.'], action: 'Add the intersection to the conflict hotspot report.',
    }),
  ];
  // replay positions for timeline marks
  INCIDENTS.forEach(i => { const s = SOURCES.find(x => x.id === i.source_id); i.replay_pos = i.seg / s.total; });

  // ---------- dynamic state
  const configureAt = {};        // source id -> ms when (re)configuration started
  const jobs = {};               // reingest jobs by id
  const latestJob = {};          // source id -> job id
  const evolution = {};          // source id -> steps
  const extraIncidents = [];
  const genericJobs = {};        // api/jobs
  const live = {};
  let jobSeq = 1;

  // a completed R1 re-ingest on the warehouse source
  const r1 = {
    id: 'rj-1', source_id: 'sdg_warehouse_cam-2', original_video: 's3://team-x-vss-chunks/team-x/20260901_sdg_warehouse_chunk_0004.mp4', filename: '20260901_sdg_warehouse_chunk_0004.mp4',
    chunk_count: 1, clips: 12, prompt: SOURCES[0].profile.generated_prompt, status: 'ready', started_at: iso(T0 - 26 * 60000), finished_at: iso(T0 - 9 * 60000),
    progress: { completed_chunks: 1, total_chunks: 1, indexed_segments: 12, total_segments: 12 }, verify: { changed: 12, total: 12, with_terms: 9 },
  };
  jobs[r1.id] = r1; latestJob[r1.source_id] = r1.id;
  evolution['sdg_warehouse_cam-2'] = [
    { stage: 'generic', text: 'A person walks in a warehouse aisle near some pallet racks. A forklift is visible.' },
    { stage: 'objective', text: 'Worker / forklift proximity (high): a person within close range of a moving forklift.' },
    { stage: 'prompt', text: WAREHOUSE_PROMPT.slice(0, 170) + '…' },
    { stage: 'reanalyzed', text: 'The forklift reverses out of the bay into the aisle while the worker passes directly behind it, very close to the rear of the vehicle. FLAGS: person_vehicle_proximity' },
    { stage: 'event', text: 'Worker / forklift proximity · high · 87%', ref: 'inc-wh-023' },
  ];

  function replay(src) {
    if (src.status !== 'monitoring' || !src.replayStart) return null;
    const seg = (src.replayStart + Math.floor(since(T0) / 900)) % src.total;
    return { active: true, speed: 6, segment: seg, total_segments: src.total, segment_uri: segUri(src.id, seg), caption: `Segment ${seg}: evaluating against ${src.profile.objectives.length} objectives…` };
  }
  function visibleIncidents() {
    const out = [];
    for (const inc of INCIDENTS) {
      const src = SOURCES.find(s => s.id === inc.source_id);
      const loops = Math.floor(((src.replayStart || 0) + since(T0) / 900) / src.total);
      const pos = src.status === 'monitoring' ? (src.replayStart + since(T0) / 900) % src.total : src.total;
      if (loops > 0 || pos >= inc.seg || src.status !== 'monitoring') {
        const firstSeen = T0 + Math.max(0, (inc.seg - (src.replayStart || 0)) * 900);
        out.push(Object.assign(clone(inc), { created_at: iso(Math.min(Date.now(), firstSeen)) }));
      }
    }
    return out.concat(clone(extraIncidents));
  }
  function counts(id) {
    const c = { critical: 0, high: 0, medium: 0, low: 0 };
    visibleIncidents().filter(i => i.source_id === id).forEach(i => { c[i.severity]++; });
    return c;
  }

  function pipeline(src) {
    const t = configureAt[src.id];
    const job = latestJob[src.id] && jobs[latestJob[src.id]];
    const step = (key, status, summary, startOffset, endOffset) => ({ key, status, summary,
      started_at: startOffset != null ? iso(T0 - startOffset) : null, ended_at: endOffset != null ? iso(T0 - endOffset) : null });
    const incs = visibleIncidents().filter(i => i.source_id === src.id);
    if (t) {
      const e = since(t);
      const st = (from, to) => e < from ? 'pending' : e < to ? 'running' : 'done';
      const at = ms => iso(t + ms);
      return { source_id: src.id, steps: [
        { key: 'classify', status: st(0, 2500), summary: e >= 2500 ? `${src.classification.domain} · ${Math.round(src.classification.confidence * 100)}%` : 'Sampling 12 segments + YOLO histogram + one Cosmos look', started_at: at(0), ended_at: e >= 2500 ? at(2500) : null },
        { key: 'plan', status: st(2500, 5000), summary: e >= 5000 ? `${src.profile.objectives.length} objectives` : '', started_at: e >= 2500 ? at(2500) : null, ended_at: e >= 5000 ? at(5000) : null },
        { key: 'prompt', status: src.profile.generated_prompt ? st(5000, 7000) : (e >= 5000 ? 'skipped' : 'pending'), summary: src.profile.generated_prompt && e >= 7000 ? `${src.profile.generated_prompt.chars}/800 chars` : (e >= 5000 && !src.profile.generated_prompt ? 'Existing captions already cover the objectives' : ''), started_at: e >= 5000 ? at(5000) : null, ended_at: e >= 7000 ? at(7000) : null },
        { key: 'reingest', status: e >= 7000 ? 'skipped' : 'pending', summary: e >= 7000 ? 'Awaiting approval' : '' },
        { key: 'monitor', status: e >= 7500 ? 'running' : 'pending', summary: e >= 7500 ? 'Archive replay 6×' : '' },
      ] };
    }
    if (!src.classification) return { source_id: src.id, steps: [] };
    return { source_id: src.id, steps: [
      step('classify', 'done', `${src.classification.domain} · ${Math.round(src.classification.confidence * 100)}%`, 31 * 60000, 31 * 60000 - 4200),
      step('plan', 'done', `${src.profile.objectives.length} objectives${src.profile.dropped ? ` · ${src.profile.dropped.length} dropped as not applicable` : ''}`, 31 * 60000 - 4200, 31 * 60000 - 9800),
      step('prompt', src.profile.generated_prompt ? 'done' : 'skipped', src.profile.generated_prompt ? `${src.profile.generated_prompt.chars}/800 chars` : 'Existing captions already cover the objectives'),
      step('reingest', job ? (job.status === 'ready' ? 'done' : job.status === 'failed' ? 'failed' : job.status === 'planned' ? 'pending' : 'running') : 'skipped', job ? (job.status === 'ready' ? `${job.verify ? job.verify.changed : job.clips}/${job.clips} clips re-analyzed` : cap(job.status)) : 'Not requested'),
      step('monitor', src.status === 'monitoring' ? 'running' : 'pending', src.status === 'monitoring' ? 'Archive replay 6×' : 'Not started'),
      step('detect', incs.length || src.status === 'monitoring' ? 'done' : 'pending', `${incs.length * 4 + 9} candidates evaluated`),
      step('investigate', incs.length ? 'done' : 'pending', `${incs.length + 3} investigated · 3 rejected`),
      step('incident', incs.length ? 'done' : 'pending', `${incs.length} incident${incs.length === 1 ? '' : 's'}`),
    ] };
  }
  const cap = s => String(s || '').replace(/^\w/, c => c.toUpperCase());

  function jobState(job) {
    if (!job.approved_at) return job;
    const e = since(job.approved_at);
    const total = job.clips;
    let status = 'preparing', indexed = 0;
    if (e > 3000) status = 'reingesting';
    if (e > 3000) indexed = Math.min(total, Math.floor((e - 3000) / 1000));
    if (e > 3000 + total * 1000) status = 'indexing';
    if (e > 6000 + total * 1000) status = 'verifying';
    if (e > 8500 + total * 1000) status = 'ready';
    job.status = status;
    job.progress = { completed_chunks: status === 'ready' || status === 'verifying' || status === 'indexing' ? 1 : 0, total_chunks: 1, indexed_segments: indexed, total_segments: total };
    if (status === 'ready' && !job.finished_at) {
      job.finished_at = iso(Date.now());
      job.verify = { changed: total, total, with_terms: total - 2 };
      const src = SOURCES.find(s => s.id === job.source_id);
      const inc = mkIncident({
        id: 'inc-reingest-' + job.id, cam: src.id, domain: src.classification.domain, location: src.location, seg: 233, objective: src.profile.objectives[0].id,
        title: src.profile.objectives[0].name + ' (found after re-analysis)', severity: src.profile.objectives[0].severity, entities: ['person', 'vehicle'], probe: src.profile.objectives[0].semantic_probes[0],
        summary: 'Only visible after Sightline re-analyzed this chunk with its own prompt; the original caption did not mention the person.',
        captions: ['A street scene with parked cars.', 'A cyclist approaches from the right side of the road.', 'A pedestrian steps off the curb as the car passes within close range; the driver slows. FLAGS: pedestrian_vehicle_proximity', 'The pedestrian waits at the curb.', 'Traffic continues normally.'],
        yolo: [{ car: 2 }, { car: 2, bicycle: 1 }, { car: 2, person: 1 }, { car: 1, person: 1 }, { car: 2 }],
        conf: [0.86, 0.6, 1.0, 1.0, 0.75], why: 'The specialized caption described the person stepping off the curb next to the moving car.', counter: 'Distance is estimated.',
        timeline: [[0, 'Pedestrian steps off the curb as the car passes'], [1, 'Pedestrian waits']], answers: [['Who yielded?', 'The driver slowed; the pedestrian stepped back.']],
        second: ['YES', 'A person is very close to a moving car.'], action: 'Add to the hotspot report.',
      });
      inc.created_at = iso(Date.now());
      extraIncidents.push(inc);
      evolution[src.id] = [
        { stage: 'generic', text: 'A car drives down a street with parked cars and a cyclist.' },
        { stage: 'objective', text: `${src.profile.objectives[0].name} (${src.profile.objectives[0].severity})` },
        { stage: 'prompt', text: (src.profile.generated_prompt ? src.profile.generated_prompt.text : '').slice(0, 170) + '…' },
        { stage: 'reanalyzed', text: 'A pedestrian steps off the curb as the car passes within close range; the driver slows. FLAGS: pedestrian_vehicle_proximity' },
        { stage: 'event', text: inc.title, ref: inc.id },
      ];
    }
    return job;
  }

  // ---------- new footage + live
  function newsourceJob(job) {
    const e = since(job.started);
    const src = SOURCES.find(s => s.id === job.source_id);
    const st = (a, b) => e < a ? 'pending' : e < b ? 'running' : 'done';
    src.pipeline = { source_id: src.id, steps: [
      { key: 'classify', label: 'Environment look (Cosmos on 4 keyframes)', status: st(0, 2500), summary: e >= 2500 ? 'Residential driveway · 88%' : '' },
      { key: 'plan', status: st(2500, 4500), summary: e >= 4500 ? '3 objectives (person ↔ moving car, unattended package, loitering)' : '' },
      { key: 'prompt', status: st(4500, 6500), summary: e >= 6500 ? 'Prompt written before indexing · 584/800 chars' : '' },
      { key: 'upload', label: 'Uploaded to VAST with Sightline’s prompt', status: st(6500, 8500), summary: e >= 8500 ? 'POST /videos/upload · custom_prompt set' : '' },
      { key: 'index', label: 'Indexed by VAST (YOLO → Cosmos → Embed → VastDB)', status: st(8500, 16000), summary: e >= 16000 ? '6/6 segments' : e >= 8500 ? 'Waiting for the pipeline…' : '' },
      { key: 'monitor', status: st(16000, 18000), summary: e >= 18000 ? '1 incident' : '' },
    ] };
    if (e >= 18000 && !src.classification) {
      src.status = 'monitoring'; src.replayStart = 1; src.total = 6;
      src.classification = { domain: 'security', confidence: 0.88, camera_type: 'fixed', mode: 'llm', description: 'Phone camera propped at a residential driveway; a car moves slowly while a person walks past.', important_entities: ['person', 'car'], evidence: [{ signal: 'Driveway, garage door and a slow-moving car in all 4 keyframes', source: 'visual', supports: 'residential driveway' }] };
      src.profile = { domain: 'security', mode: 'llm', objectives: [SOURCES[2].profile.objectives[0]], information_gaps: [] };
    }
    return { id: job.id, status: e >= 18000 ? 'done' : 'running' };
  }
  const LIVE_SCENES = ['A person sits at a desk facing the camera.', 'The person stands up and walks toward the door.', 'A backpack is placed on the chair.', 'The room is empty; the backpack remains on the chair.', 'The person returns and picks up the backpack.'];

  // ---------- router
  function route(method, path, body) {
    const [p, qs] = path.split('?');
    const q = new URLSearchParams(qs || '');
    const parts = p.split('/').filter(Boolean); // ['api', ...]
    const r = parts.slice(1);
    if (r[0] === 'status') {
      const vis = visibleIncidents();
      return { vss: { ok: true }, gpu: { cosmos: { ok: true }, yolo: { ok: true }, embed: { ok: true }, canary: { ok: true } },
        llm: { ok: true, model: 'mock-model', mode: 'llm' }, state: { backend: 'vastdb', data_origin: 'vastdb' },
        flags: { live: true, upload: true, weave: true, sports: false }, replay: { speed: 6 }, limits: { upload_mb: 50 },
        stats: { candidates: vis.length * 4 + 23, rejected: 6 + Math.floor(since(T0) / 20000), incidents: vis.length } };
    }
    if (r[0] === 'sources' && !r[1]) {
      return SOURCES.map(s => ({ id: s.id, camera_id: s.camera_id, label: s.label, location: s.location, capture_type: s.capture_type, segment_count: s.segment_count,
        status: configureAt[s.id] && since(configureAt[s.id]) < 7500 ? 'configuring' : s.status, classification: s.classification ? { domain: s.classification.domain, confidence: s.classification.confidence } : null,
        profile_summary: s.profile ? { title: s.profile.domain === 'warehouse' ? 'Warehouse person–vehicle safety' : s.profile.domain === 'traffic' ? 'Road person–vehicle safety' : 'Street & facility monitoring', objectives: s.profile.objectives.length, entities: s.classification.important_entities, mode: s.profile.mode } : null,
        incident_counts: counts(s.id), replay: replay(s), segment_seconds: SEG,
        reingest_status: latestJob[s.id] ? jobState(jobs[latestJob[s.id]]).status : null }));
    }
    if (r[0] === 'sources' && r[1]) {
      const src = SOURCES.find(s => s.id === decodeURIComponent(r[1]));
      if (!src) throw new Error('404 source not found');
      if (r[2] === 'configure' && method === 'POST') { configureAt[src.id] = Date.now(); return { job_id: 'cfg-' + jobSeq++ }; }
      if (r[2] === 'monitor') { src.status = method === 'DELETE' ? 'configured' : 'monitoring'; if (!src.replayStart) src.replayStart = 1; return { ok: true }; }
      if (r[2] === 'reingest' && r[3] === 'plan') {
        const id = 'rj-' + (++jobSeq);
        jobs[id] = { id, source_id: src.id, original_video: `s3://team-x-vss-chunks/team-x/${src.id}_chunk_0019.mp4`, filename: `${src.id}_chunk_0019.mp4`, chunk_count: 1, clips: 12,
          prompt: src.profile.generated_prompt || { chars: 0 }, status: 'planned', eta: '~4–20 min on the real stack (mock: 20 s)',
          reason: `Chunk 19 has the most candidate events whose captions lack: ${(src.profile.information_gaps || []).join('; ') || 'objective-specific detail'}.` };
        latestJob[src.id] = id;
        return jobs[id];
      }
      if (r[2] === 'evolution') return { source_id: src.id, steps: evolution[src.id] || [] };
      if (r[2] === 'segments') return [];
      const job = latestJob[src.id] ? jobState(jobs[latestJob[src.id]]) : null;
      return Object.assign(clone({ id: src.id, camera_id: src.camera_id, label: src.label, location: src.location, capture_type: src.capture_type, segment_count: src.segment_count,
        status: configureAt[src.id] && since(configureAt[src.id]) < 7500 ? 'configuring' : src.status, classification: src.classification || null, profile: src.profile || null, segment_seconds: SEG }),
        { pipeline: src.pipeline || pipeline(src), reingest: job ? clone(job) : null, evolution: { source_id: src.id, steps: evolution[src.id] || [] }, replay: replay(src),
          incidents: visibleIncidents().filter(i => i.source_id === src.id) });
    }
    if (r[0] === 'pipeline' && r[1]) {
      const src = SOURCES.find(s => s.id === decodeURIComponent(r[1]));
      if (!src) throw new Error('404 source not found');
      return src.pipeline || pipeline(src);
    }
    if (r[0] === 'incidents' && !r[1]) {
      const src = q.get('source');
      return visibleIncidents().filter(i => !src || i.source_id === src);
    }
    if (r[0] === 'incidents' && r[1]) {
      const inc = visibleIncidents().find(i => i.id === decodeURIComponent(r[1])) || INCIDENTS.find(i => i.id === decodeURIComponent(r[1]));
      if (!inc) throw new Error('404 incident not found');
      return clone(inc);
    }
    if (r[0] === 'reingest' && r[1]) {
      const job = jobs[decodeURIComponent(r[1])];
      if (!job) throw new Error('404 job not found');
      if (r[2] === 'approve') { job.approved_at = Date.now(); job.started_at = iso(Date.now()); job.status = 'preparing'; }
      return clone(jobState(job));
    }
    if (r[0] === 'search') {
      const words = (q.get('q') || '').toLowerCase().split(/\W+/).filter(w => w.length > 2);
      const src = q.get('source');
      const pool = [];
      INCIDENTS.forEach(i => (i.evidence || []).concat(i.investigation.related || []).forEach(e => pool.push(Object.assign({ camera_id: e.camera_id || i.camera_id }, e))));
      return pool.filter(h => !src || h.camera_id === src)
        .map(h => { const c = h.caption.toLowerCase(); const hits = words.filter(w => c.includes(w)).length; return Object.assign(h, { similarity: words.length ? Math.min(0.92, 0.35 + 0.6 * hits / words.length) : 0.3, _h: hits }); })
        .filter(h => h._h > 0).sort((a, b) => b.similarity - a.similarity).slice(0, 9);
    }
    if (r[0] === 'jobs' && r[1]) {
      const j = genericJobs[decodeURIComponent(r[1])];
      if (!j) return { id: r[1], status: 'done' };
      return newsourceJob(j);
    }
    if (r[0] === 'newsource' && method === 'POST') {
      const n = SOURCES.filter(s => s.id.startsWith('sightline-new')).length + 1;
      const id = `sightline-new-${n}`;
      SOURCES.push({ id, camera_id: id, label: `New footage ${n}`, location: 'uploaded', capture_type: 'self-recorded', segment_count: 6, status: 'configuring', total: 6 });
      const job = { id: 'ns-' + (++jobSeq), source_id: id, started: Date.now() };
      genericJobs[job.id] = job;
      return { job_id: job.id, source_id: id };
    }
    if (r[0] === 'live') {
      if (r[1] === 'session') { const sid = 'live-' + (++jobSeq); live[sid] = { frames: 0, observations: [], events: [], t0: Date.now() }; return { sid }; }
      const L = live[r[1]];
      if (!L) throw new Error('404 live session not found');
      if (r[2] === 'frame') {
        L.frames++;
        if (L.frames % 2 === 1) {
          const k = Math.min(LIVE_SCENES.length - 1, Math.floor(L.observations.length / 2));
          L.observations.push({ ts: iso(Date.now()), scene: LIVE_SCENES[k], entities: k === 3 ? ['backpack'] : ['person ×1', 'chair', 'desk'], flags: k === 3 ? ['unattended_object'] : [], latency_ms: 900 + Math.random() * 700 });
          if (k === 3 && !L.events.length) L.events.push({ ts: iso(Date.now()), severity: 'medium', title: 'Bag left unattended', reason: 'Backpack stationary for 2 observations with nobody in frame' });
        }
        return { ok: true };
      }
      if (r[2] === 'state') {
        const obs = L.observations;
        const mins = Math.max(1 / 60, since(L.t0) / 60000);
        return { observations: obs, events: L.events,
          classification: obs.length >= 3 ? { domain: 'security', confidence: 0.81, description: 'Indoor room with a desk and chair; one person, fixed laptop camera.' } : null,
          profile: obs.length >= 3 ? { objectives: [{ name: 'Unattended object', severity: 'medium' }, { name: 'Person / vehicle proximity: not applicable (no vehicles)', severity: 'low' }] } : null,
          stats: { frames_received: L.frames, cosmos_calls_per_min: Math.round(obs.length / mins), p50_latency_ms: obs.length ? 1150 : null } };
      }
    }
    throw new Error(`404 mock has no route for ${method} ${path}`);
  }

  window.SightlineMock = {
    handle(method, path, body) {
      return new Promise((resolve, reject) => setTimeout(() => {
        try { resolve(route(method, path, body)); } catch (e) { reject(e); }
      }, 80 + Math.random() * 120));
    },
  };
})();
