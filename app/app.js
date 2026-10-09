'use strict';
/* Sightline UI. Talks only to our backend's internal API (planning/ARCHITECTURE.md §5, §5a),
   always relative to document.baseURI (set at runtime in index.html).
   ?mock=1 swaps the network for mock.js so the UI can be built without VAST access. */

const QS = new URLSearchParams(location.search);
const MOCK = QS.get('mock') === '1';
const POLL_MS = 2000;
const STATUS_MS = 5000;

const S = {
  status: null,
  sources: [],
  incidents: [],
  seen: new Set(),
  feedReady: false,
  selected: null,
  route: { name: 'overview' },
  ovTab: 'incidents',
  busy: false,
  offline: false,
  live: null,
  fresh: null,
};

// ---------------------------------------------------------------- utilities
const $ = (sel, root = document) => root.querySelector(sel);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = v => (v == null || isNaN(v)) ? '–' : Math.round(v * 100) + '%';
const cap = s => String(s || '').replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());
const enc = encodeURIComponent;

function fmtT(v) {
  if (v == null || v === '') return '–';
  if (typeof v === 'number' || /^\d+(\.\d+)?$/.test(String(v))) {
    const s = Math.max(0, Math.round(Number(v)));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }
  const d = new Date(v);
  return isNaN(d) ? String(v) : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
/** Video timecode HH:MM:SS:FF (frames shown as 00; segments are seconds-accurate). */
function fmtTC(v) {
  if (v == null || isNaN(v)) return '--:--:--:--';
  const s = Math.max(0, Math.floor(Number(v)));
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60, 0].map(n => String(n).padStart(2, '0')).join(':');
}
function clock(iso) {
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function elapsed(fromIso, toIso) {
  const a = new Date(fromIso), b = toIso ? new Date(toIso) : new Date();
  if (isNaN(a)) return '';
  const s = Math.max(0, Math.round((b - a) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}
const shortSeg = uri => uri ? String(uri).split('/').filter(Boolean).slice(-2).join('/') : '';
function camOf(ev) {
  if (!ev) return '';
  if (ev.camera_id) return ev.camera_id;
  const parts = String(ev.segment || '').split('/').filter(Boolean);
  return parts.length > 2 ? parts[parts.length - 2] : '';
}

/** Replace innerHTML only when it changed, so playing videos and scroll positions survive polling. */
function setHTML(el, html) {
  if (el && el._html !== html) { el.innerHTML = html; el._html = html; }
}

function toast(msg, kind = 'error') {
  const d = document.createElement('div');
  d.className = kind;
  d.textContent = msg;
  $('#toast').appendChild(d);
  setTimeout(() => d.remove(), kind === 'error' ? 7000 : 3500);
}

// ---------------------------------------------------------------- api
async function api(method, path, body, form) {
  if (MOCK) return window.SightlineMock.handle(method, path, body);
  const opts = { method, headers: {} };
  if (form) opts.body = body;
  else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(new URL(path, document.baseURI), opts);
  if (!res.ok) {
    let detail = res.statusText;
    try { const j = await res.json(); detail = j.detail || j.error || detail; } catch (_) { /* not json */ }
    throw new Error(`${res.status} ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
  }
  return res.status === 204 ? null : res.json();
}
const GET = p => api('GET', p);
const POST = (p, b, form) => api('POST', p, b, form);
const DEL = p => api('DELETE', p);

function clipSrc(ev) {
  if (!ev || MOCK) return null;
  const u = ev.clip_url || (ev.segment ? 'api/clip?source=' + enc(ev.segment) : null);
  return u ? new URL(u, document.baseURI).href : null;
}

// ---------------------------------------------------------------- building blocks
/** A docked pane. `title` and `right` are trusted markup; callers escape data. */
function pane(title, body, { right = '', cls = '', id = '', flush = false } = {}) {
  return `<section class="pane ${cls}"><header class="pane-h"><span class="pt">${title}</span>${right ? `<span class="pr">${right}</span>` : ''}</header>
    <div class="pane-b${flush ? ' flush' : ''}"${id ? ` id="${id}"` : ''}>${body}</div></section>`;
}

const SEV_LABEL = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };
function sevPill(sev) {
  const k = SEV_LABEL[sev] ? sev : 'low';
  return `<span class="sev ${k}"><i></i>${SEV_LABEL[k]}</span>`;
}
/** Cosmos captions, with the FLAGS line Sightline asked for highlighted as evidence. */
function captionHTML(text) { return esc(text).replace(/(FLAGS:[^\n]*)/, '<mark>$1</mark>'); }

function player(ev, { badge = '', autoplay = false, overlay = '', controls = true, cam = '' } = {}) {
  const src = clipSrc(ev);
  const inner = src
    ? `<video src="${esc(src)}" preload="metadata" muted playsinline ${controls ? 'controls' : ''} ${autoplay ? 'autoplay loop' : ''}></video>`
    : `<div class="ph"><div><div class="big">${MOCK ? 'Mock clip' : 'No clip'}</div><div>${esc(shortSeg(ev && ev.segment))}</div></div></div>`;
  const camId = cam || camOf(ev);
  const osd = ev || badge ? `<div class="osd"><span>${camId ? esc(camId) : ''}</span><span>${badge ? `<span class="ev">${esc(badge)}</span>` : ''}</span></div>` : '';
  return `<div class="player">${inner}${osd}${overlay ? `<div class="overlay">${overlay}</div>` : ''}</div>`;
}

function yoloTags(y) {
  if (!y || !y.classes) return '';
  return Object.entries(y.classes).map(([k, v]) => `<span class="tag" title="YOLO11 max count in this segment">${esc(k)} ×${esc(v)}</span>`).join('');
}

const STEP_LABELS = {
  classify: 'Scene classified',
  plan: 'Monitoring plan generated',
  prompt: 'Cosmos prompt written',
  reingest: 'Footage re-analyzed (VAST re-ingest)',
  monitor: 'Monitoring',
  detect: 'Candidates evaluated',
  investigate: 'Investigations',
  incident: 'Incidents raised',
};
const STEP_ICON = { done: '✓', running: '●', failed: '✕', skipped: '–', pending: '○' };

function pipelineHTML(run) {
  const steps = (run && run.steps) || [];
  if (!steps.length) return `<div class="empty" style="padding:12px">Not configured yet.</div>`;
  return `<div class="steps">${steps.map(st => `
    <div class="step ${esc(st.status)}">
      <span class="ic">${STEP_ICON[st.status] ?? ''}</span>
      <div><div class="sl">${esc(st.label || STEP_LABELS[st.key] || cap(st.key))}</div>
        ${st.summary ? `<div class="ss">${esc(st.summary)}</div>` : ''}
        ${st.trace_url ? `<a href="${esc(st.trace_url)}" target="_blank" rel="noopener">Weave trace ↗</a>` : ''}</div>
      <span class="sd">${st.started_at ? esc(elapsed(st.started_at, st.ended_at)) : ''}</span>
    </div>`).join('')}</div>`;
}

function feedItem(inc, isNew) {
  const comps = ((inc.confidence && inc.confidence.components) || []).map(c => `${c.name}: ${pct(c.value)}`).join(' · ');
  return `<div class="feed-item ${isNew ? 'new' : ''}" data-nav="/incident/${enc(inc.id)}" title="${esc(SEV_LABEL[inc.severity] || '')} · ${esc(comps)}">
    <span class="sev-dot ${esc(inc.severity)}"></span>
    <div style="min-width:0"><div class="ft">${esc(inc.title)}</div>
      <div class="fs">${esc(inc.camera_id || sourceLabel(inc.source_id))} · ${esc(fmtTC(inc.peak_at ?? inc.started_at))}${inc.mode === 'rules_only' ? ' · rules-only' : ''}${inc.created_at ? ' · ' + esc(clock(inc.created_at)) : ''}</div></div>
    <span class="fc">${pct(inc.confidence && inc.confidence.value)}</span>
  </div>`;
}

function sourceById(id) { return S.sources.find(s => s.id === id); }
function sourceLabel(id) { const s = sourceById(id); return s ? (s.label || s.camera_id) : id; }
function domainOf(src) { return src && src.classification ? src.classification.domain : null; }
function sortIncidents(list) { return [...list].sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''))); }

/** NLE-style timeline: footage track (processed vs pending), incident markers, playhead at the replay clock. */
function timelineHTML(src, incs) {
  if (!src) return '<div class="tl-foot">No camera selected.</div>';
  const r = src.replay;
  const total = (r && r.total_segments) || src.segment_count || 0;
  if (!total) return '<div class="tl-foot">No indexed segments for this camera.</div>';
  const segSec = src.segment_seconds || null;
  const pos = r ? Math.min(1, (r.segment || 0) / total) : null;
  const ticks = Array.from({ length: 9 }, (_, i) => {
    const seg = Math.round(total * i / 8);
    return `<span class="tl-tick" style="left:${(i * 12.5).toFixed(2)}%">${segSec ? esc(fmtTC(seg * segSec).slice(0, 8)) : 'seg ' + seg}</span>`;
  }).join('');
  const nClips = Math.min(28, total);
  const clips = Array.from({ length: nClips }, (_, i) => {
    const a = i / nClips, b = (i + 1) / nClips;
    const done = pos != null && b <= pos;
    return `<span class="tl-clip ${done ? 'done' : ''}" style="left:calc(${(a * 100).toFixed(2)}% + 1px);width:calc(${((b - a) * 100).toFixed(2)}% - 2px)"></span>`;
  }).join('');
  const marks = incs.filter(i => i.replay_pos != null).map(i =>
    `<span class="tl-mark ${esc(i.severity)}" style="left:${(i.replay_pos * 100).toFixed(2)}%" data-nav="/incident/${enc(i.id)}" title="${esc(i.title)} · ${esc(SEV_LABEL[i.severity] || '')} · ${pct(i.confidence && i.confidence.value)}"></span>`).join('');
  return `<div class="tl">
      <div class="tl-labels"><div class="tl-l ruler-l">${segSec ? 'TC' : 'SEG'}</div><div class="tl-l">Footage</div><div class="tl-l">Incidents</div></div>
      <div class="tl-lanes">
        <div class="tl-ruler">${ticks}</div>
        <div class="tl-lane">${clips}</div>
        <div class="tl-lane">${marks}</div>
        ${pos != null ? `<div class="playhead" style="left:${(pos * 100).toFixed(2)}%" title="Replay clock"></div>` : ''}
      </div>
    </div>
    <div class="tl-foot">${r && r.active ? `Archive replay ${esc(r.speed || '')}× · segment ${esc(r.segment)}/${esc(total)} · each segment is evaluated as the playhead passes it` : 'Not monitoring. Start monitoring from the camera page.'}</div>`;
}

// ---------------------------------------------------------------- top bar + sidebar
function renderTop() {
  const st = S.status || {};
  const monitoring = S.sources.filter(s => s.status === 'monitoring').length;
  const speed = st.replay && st.replay.speed;
  setHTML($('#monitor-state'), monitoring
    ? `<span class="rec"></span><span><b>Monitoring</b> ${monitoring} camera${monitoring > 1 ? 's' : ''}</span>
       <span class="chip" title="Indexed archive footage replayed in chronological order. Not a live camera feed.">archive replay${speed ? ' ' + esc(speed) + '×' : ''}</span>`
    : `<span class="rec off"></span><span>Idle</span>`);
  const chip = (name, ok, title, warn) => `<span class="chip ${ok == null ? '' : ok ? (warn ? 'warn' : 'ok') : 'bad'}" title="${esc(title)}"><span class="dot"></span>${name}</span>`;
  const gpu = st.gpu || {};
  const gpuOk = gpu.cosmos ? (gpu.cosmos.ok && (!gpu.yolo || gpu.yolo.ok)) : null;
  const llm = st.llm || {};
  const state = st.state || {};
  let html = '';
  if (MOCK) html += `<span class="chip mock" title="UI is running on mock.js data, not the real backend">MOCK DATA</span>`;
  if (state.data_origin === 'seed') html += `<span class="chip cached" title="Backend is serving a saved snapshot">cached ${esc(clock(state.snapshot_at))}</span>`;
  html += chip('VSS', st.vss ? st.vss.ok : null, (st.vss && st.vss.detail) || 'VAST video search backend');
  html += chip('GPU', gpuOk, 'Cosmos3-Reason, YOLO11, Embed1 on CoreWeave');
  html += chip('LLM', st.llm ? llm.ok : null, `W&B Inference${llm.model ? ': ' + llm.model : ''}${llm.mode === 'rules_only' ? ' (rules-only fallback active)' : ''}`, llm.mode === 'rules_only');
  html += chip('VastDB', st.state ? state.backend === 'vastdb' : null, state.backend === 'vastdb' ? 'Sightline state persisted in VastDB (schema "sightline")' : 'State is local only');
  setHTML($('#health'), html);
  const page = { overview: 'monitor', source: 'monitor', incident: 'monitor', search: 'search', new: 'new', live: 'live' }[S.route.name];
  const flags = st.flags || {};
  const shown = { new: MOCK || !!flags.upload, live: MOCK || !!flags.live };
  document.querySelectorAll('#pages button').forEach(b => {
    b.classList.toggle('active', b.dataset.page === page);
    if (b.dataset.page in shown) b.hidden = !shown[b.dataset.page];  // hide features disabled on this deployment
  });
}

function renderSidebar() {
  const sel = sourceById(S.selected);
  const activeId = S.route.name === 'source' ? S.route.id : S.selected;
  const items = S.sources.map(src => {
    const c = src.incident_counts || {};
    const n = (c.critical || 0) + (c.high || 0) + (c.medium || 0) + (c.low || 0);
    const hot = (c.critical || 0) + (c.high || 0) > 0;
    const cl = src.classification;
    return `<div class="src ${src.id === activeId ? 'active' : ''}" data-nav="/source/${enc(src.id)}" title="${esc(src.status || '')}">
      <span class="thumb ${esc(src.status || '')}"></span>
      <div style="min-width:0"><div class="label">${esc(src.label || src.camera_id)}</div>
        <div class="sub">${cl ? esc(cap(cl.domain)) + ' ' + pct(cl.confidence) : 'not configured'}</div></div>
      <span class="count ${hot ? 'hot' : ''}" title="Incidents raised">${n || ''}</span>
    </div>`;
  }).join('');
  const prof = sel && sel.profile_summary;
  const profile = !sel ? '<div class="profile-box muted">No camera selected</div>'
    : prof ? `<div class="profile-box"><div class="ptitle">${esc(prof.title || cap(domainOf(sel)))}</div>
        <div class="muted small">${esc(prof.objectives ?? 0)} objectives${prof.mode === 'rules_only' ? ' · rules-only' : ''}</div>
        ${prof.entities && prof.entities.length ? `<ul>${prof.entities.map(e => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}</div>`
    : `<div class="profile-box muted">No monitoring profile yet.</div>`;
  setHTML($('#sidebar'), `
    <div class="side-h"><span>Cameras</span><span class="mono muted">${S.sources.length}</span></div>
    ${items || '<div class="empty" style="padding:12px">No indexed cameras found</div>'}
    <div class="side-h"><span>Active profile</span></div>
    ${profile}`);
}

// ---------------------------------------------------------------- views
const VIEWS = {};

VIEWS.overview = {
  mount(main) {
    main.innerHTML = `<div class="ws">
      <section class="pane viewer-pane">
        <header class="pane-h"><span class="pt">Viewer</span><span class="pr" id="ov-tabs"></span></header>
        <div class="pane-b" id="ov-player"></div>
        <div class="transport" id="ov-transport"></div>
      </section>
      <section class="pane">
        <header class="pane-h"><div class="tabs">
          <button data-action="ov-tab" data-tab="incidents">Incidents</button>
          <button data-action="ov-tab" data-tab="agent">Agent</button></div>
          <span class="pr" id="ov-feed-meta"></span></header>
        <div class="pane-b flush" id="ov-side"></div>
      </section>
      <section class="pane timeline-pane">
        <header class="pane-h"><span class="pt">Timeline</span><span class="pr" id="ov-stats"></span></header>
        <div class="pane-b flush" id="ov-timeline"></div>
      </section>
    </div>`;
  },
  async update(main) {
    const src = sourceById(S.selected);
    const st = (S.status && S.status.stats) || null;
    const incidents = sortIncidents(S.incidents);
    const mine = incidents.filter(i => i.source_id === S.selected);
    const configured = S.sources.filter(s => s.classification).length;

    document.querySelectorAll('[data-action="ov-tab"]').forEach(b => b.classList.toggle('on', b.dataset.tab === S.ovTab));
    setHTML($('#ov-tabs', main), `<span class="seg">${S.sources.filter(s => s.classification).map(s =>
      `<button class="${s.id === S.selected ? 'on' : ''}" data-action="select-source" data-id="${esc(s.id)}">${esc(s.label || s.camera_id)}</button>`).join('')}</span>`);

    const latest = mine[0];
    const ev = latest && (latest.evidence || []).find(e => e.role === 'event');
    const replay = (src && src.replay) || null;
    if (latest && ev) {
      setHTML($('#ov-player', main), player(ev, {
        badge: 'LATEST INCIDENT', autoplay: true, cam: latest.camera_id,
        overlay: `${sevPill(latest.severity)} <b style="margin-left:6px">${esc(latest.title)}</b> <span class="muted">· ${pct(latest.confidence && latest.confidence.value)}</span>`,
      }));
    } else {
      setHTML($('#ov-player', main), player(replay && replay.segment_uri ? { segment: replay.segment_uri } : null, {
        badge: replay && replay.active ? 'REPLAY' : '', cam: src && src.camera_id,
        overlay: replay && replay.caption ? `<span class="muted">${esc(replay.caption)}</span>` : '',
      }));
    }
    const segSec = src && src.segment_seconds;
    setHTML($('#ov-transport', main), `<span>${esc(src ? src.camera_id : '')}</span>
      <span class="tc" title="${segSec ? 'Replay position' : 'Replay position (segment length unknown)'}">${replay ? (segSec ? esc(fmtTC(replay.segment * segSec)) : 'SEG ' + esc(replay.segment)) : '--:--:--:--'}</span>
      <span class="r">${replay && replay.active ? `${esc(replay.speed)}× · ${esc(replay.segment)}/${esc(replay.total_segments)}` : 'paused'}</span>`);

    const fresh = new Set();
    if (S.feedReady) incidents.forEach(i => { if (!S.seen.has(i.id)) fresh.add(i.id); });
    incidents.forEach(i => S.seen.add(i.id));
    S.feedReady = true;
    setHTML($('#ov-feed-meta', main), `${incidents.length} raised · 0 searches typed`);
    if (S.ovTab === 'agent') {
      try { setHTML($('#ov-side', main), src ? pipelineHTML(await GET(`api/pipeline/${enc(src.id)}`)) : ''); }
      catch (e) { setHTML($('#ov-side', main), `<div class="empty" style="padding:12px">Pipeline unavailable (${esc(e.message)})</div>`); }
    } else {
      setHTML($('#ov-side', main), incidents.length ? `<div class="feed">${incidents.map(i => feedItem(i, fresh.has(i.id))).join('')}</div>` : '<div class="empty" style="padding:12px">No incidents yet.</div>');
    }

    setHTML($('#ov-stats', main), `<span class="figures">
      <span title="Cameras with a Sightline-generated classification and monitoring profile"><b>${configured}/${S.sources.length}</b>self-configured</span>
      ${st ? `<span title="Segments that passed deterministic gates and were evaluated"><b>${esc(st.candidates ?? '–')}</b>evaluated</span>
      <span title="Candidates the investigation judged unclear or false (kept for audit)"><b>${esc(st.rejected ?? '–')}</b>rejected</span>` : ''}
      <span><b>${incidents.length}</b>incidents</span></span>`);
    setHTML($('#ov-timeline', main), timelineHTML(src, mine));
  },
};

// ----- rule descriptions in plain words (DOMAIN_PROFILES.md §1 vocabulary)
function ruleWords(rc) {
  const p = (rc && rc.params) || {};
  const list = a => (Array.isArray(a) ? a : [a]).filter(Boolean).map(x => `“${x}”`).join(', ');
  switch (rc && rc.primitive) {
    case 'entities_present': return `${(p.entities || []).join(' + ')} visible`;
    case 'cooccur': return `${p.a} and ${p.b} in the same moment`;
    case 'bbox_proximity': return `${p.a} box within ${Math.round((p.max_gap_norm || 0.05) * 100)}% of frame of a ${p.b} box (${p.min_frames || 2}+ frames)`;
    case 'count_threshold': return `${p.entity} count ${p.op || '>='} ${p.value}`;
    case 'persistence': return `${p.entity} ${p.stationary ? 'stays put' : 'present'} for ${p.min_segments}+ segments`;
    case 'disappearance': return `${p.entity} disappears after being present`;
    case 'caption_terms': return `description mentions ${list(p.any || p.all)}`;
    case 'caption_flag': return `Cosmos re-analysis flags ${p.flag}`;
    case 'semantic_probe': return `semantic match “${p.query}”`;
    case 'time_window': return `between ${p.start} and ${p.end}`;
    default: return rc ? rc.primitive : '';
  }
}
function detectorWords(d) {
  if (!d) return '';
  const all = (d.all_of || []).map(ruleWords);
  const any = (d.any_of || []).map(ruleWords);
  return [all.length ? 'Requires ' + all.join(' and ') : '', any.length ? (all.length ? 'plus any of: ' : 'Any of: ') + any.join(' / ') : ''].filter(Boolean).join('; ');
}

const REINGEST_STAGES = ['preparing', 'reingesting', 'indexing', 'verifying', 'ready'];
const STAGE_LABEL = { preparing: 'Preparing', reingesting: 'Submitted', indexing: 'Pending index', verifying: 'Verifying', ready: 'Indexed' };

/** Fast path: direct Cosmos preview. Never claims the VAST index changed. */
function previewHTML(pv) {
  if (!pv || pv.status === 'not_started') return '';
  const r = (pv.results || [])[0];
  const head = pv.status === 'done'
    ? `<span class="rq-status ready">Preview ready</span> <span class="mono small muted">${esc(((pv.latency_ms || 0) / 1000).toFixed(1))} s · ${esc(pv.model || 'Cosmos')} · prompt ${esc(pv.prompt_chars || '?')}/800</span>`
    : pv.status === 'running' ? `<span class="rq-status running">Preview running</span>`
    : `<span class="rq-status failed">Preview ${esc(pv.status)}</span> <span class="small muted">${esc(pv.error || pv.note || '')}</span>`;
  return `<div class="rq" style="margin-bottom:8px"><div class="rq-head"><span class="f">${esc(pv.label || 'Preview re-analysis (direct Cosmos, not indexed)')}</span><span>${head}</span></div>
    ${r ? `<div class="rq-body small"><div class="muted" style="margin-bottom:4px">Original VAST caption</div><div style="margin-bottom:8px">${esc(r.original_caption)}</div>
      <div class="muted" style="margin-bottom:4px">Cosmos with Sightline's prompt</div><div>${captionHTML(r.preview_caption)}</div></div>` : ''}</div>`;
}

function reingestHTML(src, job) {
  if (!src.profile) return `<div class="empty">Configure the camera first. Sightline needs a plan before it can write a prompt.</div>`;
  if (!job) {
    return `<p class="muted" style="margin-top:0">Re-runs VAST's pipeline (YOLO → Cosmos → Embed → VastDB) on a chunk of this footage with Sightline's prompt. Sightline picks the target; you approve the run, because re-ingest rewrites the shared index.</p>
      <button class="btn primary" data-action="plan-reingest" data-id="${esc(src.id)}">Plan re-analysis</button>`;
  }
  if (job.status === 'planned') {
    return `<div class="plan-card">
        <div class="mono small" style="margin-bottom:6px">${esc(job.filename || shortSeg(job.original_video))}</div>
        <div class="small muted">${esc(job.chunk_count)} chunk · ${esc(job.clips ?? '?')} clips · ETA ${esc(job.eta || 'a few minutes')} · prompt ${esc(job.prompt && job.prompt.chars)}/800</div>
        ${job.reason ? `<div class="small" style="margin-top:8px">${esc(job.reason)}</div>` : ''}
        <div class="btn-row" style="margin-top:10px"><button class="btn primary" data-action="approve-reingest" data-job="${esc(job.id)}">Approve: preview + VAST re-ingest</button>
          <button class="btn" data-action="preview-reingest" data-job="${esc(job.id)}" title="Direct Cosmos re-analysis; the VAST index is not touched">Preview only</button></div>
      </div>${previewHTML(job.preview)}`;
  }
  const idx = REINGEST_STAGES.indexOf(job.status);
  const failed = job.status === 'failed';
  const failedAt = failed ? Math.max(0, REINGEST_STAGES.indexOf(job.failed_stage || 'reingesting')) : -1;
  const pr = job.progress || {};
  const frac = pr.total_segments ? pr.indexed_segments / pr.total_segments : (job.status === 'ready' ? 1 : 0);
  const statusCls = failed ? 'failed' : job.status === 'ready' ? 'ready' : 'running';
  return `${previewHTML(job.preview)}<div class="rq">
      <div class="rq-head"><span class="f">VAST index update · ${esc(job.filename || shortSeg(job.original_video))}</span><span class="rq-status ${statusCls}">${esc(STAGE_LABEL[job.status] || cap(job.status))}</span></div>
      <div class="rq-body">
        <div class="stepper">${REINGEST_STAGES.map((s, i) => {
          let c = '';
          if (failed) c = i < failedAt ? 'done' : i === failedAt ? 'failed' : '';
          else c = i < idx ? 'done' : i === idx ? (s === 'ready' ? 'done' : 'current') : '';
          return `<div class="st ${c}">${esc(STAGE_LABEL[s] || cap(s))}</div>`;
        }).join('')}</div>
        <div class="progress"><i style="width:${(frac * 100).toFixed(0)}%"></i></div>
        <div class="small muted mono" title="Progress reported by VAST's re-ingest API, never estimated">
          ${esc(pr.completed_chunks ?? 0)}/${esc(pr.total_chunks ?? job.chunk_count ?? 1)} chunks · ${esc(pr.indexed_segments ?? 0)}/${esc(pr.total_segments ?? job.clips ?? '?')} clips${job.started_at ? ' · ' + esc(elapsed(job.started_at, job.finished_at)) : ''}</div>
        ${job.verify ? `<div class="callout" style="margin-top:8px">Verified: captions changed in ${esc(job.verify.changed)}/${esc(job.verify.total)} segments; ${esc(job.verify.with_terms ?? 0)} mention objective-specific details.</div>` : ''}
        ${failed ? `<div class="callout warn" style="margin-top:8px">Failed: ${esc(job.error || 'unknown error')}. Monitoring continues on the original captions.</div>` : ''}
        ${job.status_note ? `<div class="small muted" style="margin-top:6px">${esc(job.status_note)}</div>` : ''}
      </div></div>`;
}

const EVO_LABELS = { generic: ['Original caption', 'v1'], objective: ['Objective', ''], prompt: ["Sightline's prompt", ''], reanalyzed: ['Re-analyzed caption', 'v2'], event: ['Incident', ''] };
function evolutionHTML(evo) {
  const steps = (evo && evo.steps) || [];
  if (!steps.length) return `<div class="empty">No re-analysis yet. After an approved re-ingest, this shows how the index's description of the footage changed.</div>`;
  return `<div class="evo">${steps.map(s => {
    const [deflabel, ver0] = EVO_LABELS[s.stage] || [cap(s.stage), ''];
    const label = s.label || deflabel;
    const ver = s.kind === 'preview' ? 'preview' : s.kind === 'indexed' ? 'indexed' : ver0;
    return `<div class="card ${s.stage === 'event' ? 'event' : ''}" ${s.stage === 'event' && s.ref ? `data-nav="/incident/${enc(s.ref)}" style="cursor:pointer"` : ''}>
      <div class="k"><span>${esc(label)}</span><span class="v">${esc(ver)}</span></div>
      <div class="${s.stage === 'prompt' ? 'mono small' : ''}">${s.stage === 'reanalyzed' ? captionHTML(s.text) : esc(s.text)}</div></div>`;
  }).join('')}</div>`;
}

VIEWS.source = {
  mount(main) {
    main.innerHTML = `<div class="stack">
      <div id="sv-head"></div>
      <div class="cols2">
        ${pane('Environment', '', { id: 'sv-config' })}
        ${pane('Agent pipeline', '', { id: 'sv-pipeline', flush: true })}
      </div>
      ${pane('Monitoring plan', '', { id: 'sv-plan', flush: true, right: 'generated by Sightline, not hand-written' })}
      <div class="cols2">
        ${pane('Cosmos prompt', '', { id: 'sv-prompt' })}
        ${pane('Re-analysis', '', { id: 'sv-reingest', right: 'preview in seconds · VAST index async' })}
      </div>
      ${pane('Analysis versions', '', { id: 'sv-evo' })}
      ${pane('Incidents', '', { id: 'sv-incidents', flush: true })}
    </div>`;
  },
  async update(main) {
    const id = S.route.id;
    S.selected = id;
    let d;
    try { d = await GET(`api/sources/${enc(id)}`); }
    catch (e) { setHTML($('#sv-head', main), `<div class="page-h">Camera unavailable: ${esc(e.message)}</div>`); return; }
    const cl = d.classification, pf = d.profile;
    const monitoring = d.status === 'monitoring';
    setHTML($('#sv-head', main), `<div class="page-h">
      <div class="grow"><h1>${esc(d.label || d.camera_id)}
          ${cl ? `<span class="tag accent" title="Sightline's environment classification">${esc(cap(cl.domain))} ${pct(cl.confidence)}</span>` : ''}
          ${cl && cl.mode === 'rules_only' ? '<span class="tag warn">rules-only</span>' : ''}</h1>
        <div class="meta">${esc(d.camera_id)} · ${esc(d.location || '–')} · ${esc(d.capture_type || '–')} · ${esc(d.segment_count ?? '?')} segments · ${cl && cl.camera_type ? esc(cl.camera_type) + ' camera · ' : ''}${esc(d.status)}</div></div>
      <div class="btn-row">
        <button class="btn" data-action="configure" data-id="${esc(d.id)}">${cl ? 'Re-run self-configuration' : 'Configure this camera'}</button>
        ${pf ? (monitoring
          ? `<button class="btn danger" data-action="monitor-stop" data-id="${esc(d.id)}">Stop monitoring</button>`
          : `<button class="btn primary" data-action="monitor-start" data-id="${esc(d.id)}">Start monitoring</button>`) : ''}
      </div></div>`);

    setHTML($('#sv-config', main), cl ? `
      <div style="margin-bottom:8px">${esc(cl.description || '')}</div>
      <ul class="evidence-list">${(cl.evidence || []).map(e => `<li><span class="tag">${esc(e.source)}</span><span>${esc(e.signal)} <span class="muted">${esc(e.supports || '')}</span></span></li>`).join('')}</ul>
      ${cl.important_entities && cl.important_entities.length ? `<div style="margin-top:10px">${cl.important_entities.map(e => `<span class="tag accent">${esc(e)}</span>`).join('')}</div>` : ''}`
      : `<div class="empty">Not configured. Sightline hasn't looked at this camera yet.</div>`);

    setHTML($('#sv-pipeline', main), pipelineHTML(d.pipeline));

    setHTML($('#sv-plan', main), pf ? `
      <table class="obj"><thead><tr><th style="width:96px">Severity</th><th>Objective</th><th>Detects when</th><th style="width:24%">Search probe</th></tr></thead><tbody>
      ${(pf.objectives || []).map(o => `<tr><td>${sevPill(o.severity)}</td>
        <td><div>${esc(o.name)}</div><div class="od">${esc(o.description || '')}</div>${o.rationale ? `<div class="od muted" style="margin-top:3px">${esc(o.rationale)}</div>` : ''}</td>
        <td class="od">${esc(detectorWords(o.detector))}</td>
        <td class="od mono">${(o.semantic_probes || []).map(q => esc(q)).join('<br>')}</td></tr>`).join('')}
      ${(pf.dropped || []).map(x => `<tr><td><span class="sev low"><i></i>N/A</span></td><td><div class="muted">${esc(x.name || x.id)}</div></td><td class="od" colspan="2">Dropped: ${esc(x.reason)}</td></tr>`).join('')}
      </tbody></table>` : `<div class="empty" style="padding:12px">No plan yet.</div>`);

    const pr = pf && pf.generated_prompt;
    const chars = pr ? (pr.chars ?? (pr.text || '').length) : 0;
    setHTML($('#sv-prompt', main), pr ? `
      <div class="editor"><pre class="prompt-box">${esc(pr.text)}</pre>
        <div class="editor-status"><span class="${chars <= 800 ? 'ok' : 'warn'}">${esc(chars)}/800</span>
          <span>${pr.template_fallback ? 'template fallback' : 'written by Sightline'}</span>
          <span>${esc((pr.covers || []).length)} objectives covered</span></div></div>
      ${pf.information_gaps && pf.information_gaps.length ? `<div class="small muted" style="margin:10px 0 4px">Closes these gaps in the current captions:</div><ul class="small" style="margin:0;padding-left:18px">${pf.information_gaps.map(g => `<li>${esc(g)}</li>`).join('')}</ul>` : ''}`
      : `<div class="empty">No prompt generated. The existing captions already cover this camera's objectives.</div>`);

    setHTML($('#sv-reingest', main), reingestHTML(d, d.reingest));
    setHTML($('#sv-evo', main), evolutionHTML(d.evolution));
    const incs = sortIncidents(d.incidents || S.incidents.filter(i => i.source_id === id));
    setHTML($('#sv-incidents', main), incs.length ? `<div class="feed">${incs.map(i => feedItem(i, false)).join('')}</div>` : '<div class="empty" style="padding:12px">No incidents from this camera yet.</div>');
  },
};

VIEWS.incident = {
  async mount(main) {
    let inc;
    try { inc = await GET(`api/incidents/${enc(S.route.id)}`); }
    catch (e) { main.innerHTML = `<div class="page-h">Incident unavailable: ${esc(e.message)}</div>`; return; }
    S.selected = inc.source_id;
    const inv = inc.investigation || {};
    const evs = inc.evidence || [];
    const before = evs.filter(e => e.role === 'before');
    const pick = { Before: before[before.length - 1], Event: evs.find(e => e.role === 'event'), After: evs.find(e => e.role === 'after') };
    const conf = inc.confidence || {};
    const probe = inc.search_hint || inc.title;
    const trip = (role, ev) => `<div class="trip ${role === 'Event' ? 'event' : ''}" data-seg="${esc(ev ? ev.segment : '')}">
      <div class="role"><span>${role}</span><span class="mono">${ev ? esc(fmtTC(ev.t_start)) + ' – ' + esc(fmtTC(ev.t_end)) : ''}</span></div>
      ${ev ? player(ev, { autoplay: role === 'Event', cam: inc.camera_id }) : `<div class="player"><div class="ph"><div class="big">No ${role.toLowerCase()} segment</div></div></div>`}
      ${ev ? `<div class="meta-b"><div class="caption" data-action="toggle-caption" title="Cosmos description (click to expand)">${captionHTML(ev.caption)}</div><div style="margin-top:6px">${yoloTags(ev.yolo)}</div></div>` : ''}
    </div>`;
    const kv = (k, v) => `<dt>${k}</dt><dd>${v}</dd>`;

    main.innerHTML = `<div class="stack">
      <div class="page-h">
        <button class="back" data-nav="/source/${enc(inc.source_id)}">← ${esc(sourceLabel(inc.source_id))}</button>
        <div class="grow"><h1>${esc(inc.title)} ${sevPill(inc.severity)}${inc.mode === 'rules_only' ? '<span class="tag warn">rules-only</span>' : ''}</h1>
          <div class="meta">${esc(inc.camera_id || '')} · in ${esc(fmtTC(inc.started_at))} · peak ${esc(fmtTC(inc.peak_at))} · out ${esc(fmtTC(inc.ended_at))} · raised automatically ${esc(clock(inc.created_at))}</div></div>
        <div class="conf-box" title="Weighted combination of the components in the Confidence pane">
          <div class="conf-big">${pct(conf.value)}</div><div class="conf-label">confidence · ${esc(inv.verdict || '')}</div></div>
      </div>
      <div class="multicam">${trip('Before', pick.Before)}${trip('Event', pick.Event)}${trip('After', pick.After)}</div>
      ${evs.some(e => e.role === 'angle') ? pane('Other angles of the same moment', `<div class="related">${evs.filter(e => e.role === 'angle').map(a => `<div class="rel">${player(a, { cam: a.camera_view || camOf(a) })}
          <div class="mono small">${esc(a.camera_view || camOf(a))} · ${esc(fmtTC(a.t_start))}</div><div>${captionHTML(String(a.caption || '').slice(0, 160))}</div></div>`).join('')}</div>`,
        { right: 'same scenario, different camera' }) : ''}
      <div class="cols-3-2">
        <div class="stack">
          ${pane('Markers', `<ul class="timeline">${(inv.timeline || []).map(t => `<li class="${t.segment && t.segment === inv.peak_segment ? 'peak' : ''}" data-action="play-seg" data-seg="${esc(t.segment || '')}"><span class="tt">${esc(fmtTC(t.t))}</span><span>${esc(t.text)}</span></li>`).join('') || '<li><span></span><span>No markers</span></li>'}</ul>`)}
          ${pane('Why Sightline flagged this', `<div>${esc(inv.why_flagged || '')}</div>${inc.summary ? `<div class="muted" style="margin-top:8px">${esc(inc.summary)}</div>` : ''}`)}
          ${pane('Investigation', `${(inv.answers || []).map(a => `<div class="qa"><div class="q">${esc(a.question)}</div><div class="a">${esc(a.answer)}</div></div>`).join('') || '<div class="empty">No questions recorded</div>'}
            ${inv.counter_evidence ? `<div class="callout warn" style="margin-top:10px">Counter-evidence considered: ${esc(inv.counter_evidence)}</div>` : ''}
            ${inv.second_look ? `<div class="callout" style="margin-top:8px">Cosmos second look: <b>${esc(inv.second_look.verdict)}</b>. ${esc(inv.second_look.text || '')}</div>` : ''}`)}
        </div>
        <div class="stack">
          ${pane('Inspector', `<dl class="kv">
            ${kv('Severity', sevPill(inc.severity))}
            ${kv('Verdict', esc(cap(inv.verdict || '–')))}
            ${kv('Domain', esc(cap(inc.domain)))}
            ${kv('Camera', esc(inc.camera_id || '–'))}
            ${kv('Location', esc(inc.location || '–'))}
            ${kv('Objective', esc(inc.objective_id || '–'))}
            ${kv('Entities', esc((inc.entities || inv.entities || []).join(', ') || '–'))}
          </dl>`)}
          ${pane('Confidence', (conf.components || []).map(c => `<div class="comp"><span>${esc(c.name)}</span><div class="bar"><i style="width:${pct(c.value)}"></i></div><span class="mono">${pct(c.value)}</span>
            <div class="ex">${esc(c.explanation || '')}${c.weight != null ? ` · weight ${esc(c.weight)}` : ''}</div></div>`).join('') || '<div class="empty">No breakdown</div>', { right: pct(conf.value) })}
          ${pane('Recommended action', `<div class="callout action">${esc(inc.recommended_action || 'Review the evidence.')}</div>`)}
          ${pane('Related moments', `<div class="related">${(inv.related || []).map(r => `<div class="rel">${player(r)}
              <div class="mono small">${esc(fmtTC(r.t_start))}${r.similarity != null ? ' · ' + pct(r.similarity) : ''}</div><div>${esc(String(r.caption || '').slice(0, 120))}</div></div>`).join('') || '<div class="empty">None found</div>'}</div>`,
            { right: `<button class="btn" data-nav="/search?q=${enc(probe)}&source=${enc(inc.source_id)}">Find similar</button>` })}
        </div>
      </div></div>`;
  },
};

VIEWS.search = {
  mount(main) {
    const r = S.route;
    main.innerHTML = `<div class="stack">${pane('Search the archive', `
      <form class="search-row" id="search-form">
        <input type="text" name="q" placeholder="forklift close to a worker" value="${esc(r.q)}">
        <select name="source"><option value="">All cameras</option>${S.sources.map(s => `<option value="${esc(s.id)}" ${s.id === r.source ? 'selected' : ''}>${esc(s.label || s.camera_id)}</option>`).join('')}</select>
        <button class="btn primary">Search</button></form>
      <div class="small muted" style="margin-top:8px">Follow-up tool. Sightline raises incidents without searches; use this to look for more moments like one it found.</div>`,
      { right: 'VAST hybrid search · Cosmos-Embed1' })}
      ${pane('Results', '<div class="empty">Enter a query.</div>', { id: 'search-results' })}</div>`;
    $('#search-form', main).addEventListener('submit', e => {
      e.preventDefault();
      const f = new FormData(e.target);
      nav(`/search?q=${enc(f.get('q') || '')}&source=${enc(f.get('source') || '')}`);
    });
    if (r.q) this.run(main, r.q, r.source);
  },
  async run(main, q, source) {
    const box = $('#search-results', main);
    box.innerHTML = '<div class="empty">Searching…</div>';
    try {
      const res = await GET(`api/search?q=${enc(q)}${source ? '&source=' + enc(source) : ''}`);
      const hits = Array.isArray(res) ? res : (res && res.results) || [];
      box.innerHTML = hits.length ? `<div class="results">${hits.map(h => `<div class="rel">${player(h)}
        <div class="mono small" style="margin-top:4px">${esc(h.camera_id || '')} · ${esc(fmtTC(h.t_start))}${h.similarity != null ? ' · ' + pct(h.similarity) : ''}</div>
        <div>${esc(String(h.caption || '').slice(0, 200))}</div></div>`).join('')}</div>` : '<div class="empty">No matches.</div>';
    } catch (e) { box.innerHTML = `<div class="empty">Search failed: ${esc(e.message)}</div>`; }
  },
};

// ----- import: Sightline configures itself on footage it has never seen
VIEWS.new = {
  mount(main) {
    const flags = (S.status && S.status.flags) || {};
    if (!flags.upload && !MOCK) { main.innerHTML = pane('Import', '<div class="empty">Disabled on this deployment (UPLOAD_ENABLED is off).</div>'); return; }
    const lim = S.status && S.status.limits && S.status.limits.upload_mb;
    S.fresh = S.fresh || {};
    main.innerHTML = `<div class="cols2" style="align-items:start">
      ${pane('Import footage', `
        <input type="file" id="nf-file" accept="video/*" hidden>
        <div class="drop" data-action="nf-pick">Choose a video file${lim ? ` (max ${esc(lim)} MB)` : ''}<div class="small">Self-recorded footage only. H.264 MP4 works best.</div></div>
        <div class="small muted" style="margin-top:10px">Sightline looks at the clip first and writes its own Cosmos ingestion prompt before the footage enters the VAST index.</div>
        <div id="nf-preview"></div>`)}
      ${pane('Agent pipeline', '<div class="empty" style="padding:12px">Waiting for a clip.</div>', { id: 'nf-pipeline', flush: true })}
    </div>`;
    $('#nf-file', main).addEventListener('change', e => this.pick(main, e.target.files[0]));
    if (S.fresh.frames) this.showPreview(main);
  },
  async pick(main, file) {
    if (!file) return;
    const lim = S.status && S.status.limits && S.status.limits.upload_mb;
    if (lim && file.size > lim * 1024 * 1024) { toast(`File is ${(file.size / 1048576).toFixed(1)} MB; the limit is ${lim} MB`); return; }
    $('#nf-preview', main).innerHTML = '<div class="empty">Extracting keyframes…</div>';
    try {
      const kf = await extractKeyframes(file, 4);
      S.fresh = { file, frames: kf.frames, duration: kf.duration, url: kf.url };
      this.showPreview(main);
    } catch (e) { $('#nf-preview', main).innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  },
  showPreview(main) {
    const f = S.fresh;
    $('#nf-preview', main).innerHTML = `
      <div class="player" style="margin-top:12px"><video src="${esc(f.url)}" controls muted playsinline></video></div>
      <div class="keyframes">${f.frames.map(k => `<img src="${k.url}" alt="keyframe at ${fmtT(k.t)}" title="keyframe at ${fmtT(k.t)}">`).join('')}</div>
      <div class="small muted mono">${esc(f.file.name)} · ${(f.file.size / 1048576).toFixed(1)} MB · ${fmtT(f.duration)}</div>
      <div class="btn-row" style="margin-top:10px"><button class="btn primary" data-action="nf-submit" ${f.job ? 'disabled' : ''}>Let Sightline configure it</button></div>`;
  },
  async submit(main) {
    const f = S.fresh;
    if (!f || !f.file || f.job) return;
    const fd = new FormData();
    fd.append('file', f.file, f.file.name);
    f.frames.forEach((k, i) => fd.append(`keyframe_${i}`, k.blob, `keyframe_${i}.jpg`));
    fd.append('keyframe_times', JSON.stringify(f.frames.map(k => k.t)));
    try {
      const r = await POST('api/newsource', fd, true);
      f.job = r.job_id; f.source_id = r.source_id;
      this.showPreview(main);
      this.update(main);
    } catch (e) { toast('Upload failed: ' + e.message); }
  },
  async update(main) {
    const f = S.fresh;
    if (!f || !f.job || !$('#nf-pipeline', main)) return;
    try {
      const [job, run] = await Promise.all([GET(`api/jobs/${enc(f.job)}`), f.source_id ? GET(`api/pipeline/${enc(f.source_id)}`) : null]);
      const done = job.status === 'done' || job.status === 'completed';
      setHTML($('#nf-pipeline', main), pipelineHTML(run) +
        (job.status === 'failed' ? `<div class="callout warn" style="margin:10px">Failed: ${esc(job.error || '')}</div>` : '') +
        (done && f.source_id ? `<div class="btn-row" style="padding:10px"><button class="btn primary" data-nav="/source/${enc(f.source_id)}">Open the new camera</button></div>` : ''));
    } catch (e) { setHTML($('#nf-pipeline', main), `<div class="empty" style="padding:12px">${esc(e.message)}</div>`); }
  },
};

async function extractKeyframes(file, n) {
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.src = url; v.muted = true; v.playsInline = true; v.preload = 'auto';
  await new Promise((res, rej) => {
    v.onloadeddata = res;
    v.onerror = () => rej(new Error('This browser cannot decode the clip. Try an H.264 MP4.'));
  });
  const c = document.createElement('canvas');
  c.width = 640; c.height = Math.round(640 * (v.videoHeight || 360) / (v.videoWidth || 640));
  const ctx = c.getContext('2d');
  const frames = [];
  for (let i = 0; i < n; i++) {
    const t = (v.duration || 1) * (0.1 + 0.8 * i / Math.max(1, n - 1));
    await new Promise(res => { v.onseeked = res; v.currentTime = t; setTimeout(res, 1500); });
    ctx.drawImage(v, 0, 0, c.width, c.height);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.82));
    frames.push({ t, blob, url: c.toDataURL('image/jpeg', 0.6) });
  }
  return { frames, duration: v.duration, url };
}

// ----- live camera: motion gate in the browser, Cosmos only on change or checkpoint
VIEWS.live = {
  mount(main) {
    const flags = (S.status && S.status.flags) || {};
    if (!flags.live && !MOCK) { main.innerHTML = pane('Live camera', '<div class="empty">Disabled on this deployment (LIVE_ENABLED is off).</div>'); return; }
    main.innerHTML = `<div class="stack">
      ${window.isSecureContext ? '' : `<div class="callout warn">This page is not a secure context, so the browser will block the camera. Use HTTPS, or enable chrome://flags/#unsafely-treat-insecure-origin-as-secure for this origin.</div>`}
      <div class="cols-3-2">
        <section class="pane viewer-pane">
          <header class="pane-h"><span class="pt">Live viewer</span><span class="pr btn-row"><button class="btn primary" data-action="live-start">Start camera</button><button class="btn" data-action="live-stop">Stop</button></span></header>
          <div class="pane-b" style="aspect-ratio:16/9"><div class="player"><video id="live-video" muted playsinline autoplay></video></div></div>
          <div id="live-gate"></div>
        </section>
        ${pane("Sightline's read of this scene", '<div class="empty">Start the camera.</div>', { id: 'live-config' })}
      </div>
      <div class="cols2">
        ${pane('Observations (Cosmos)', '', { id: 'live-obs', flush: true })}
        ${pane('Live incidents', '', { id: 'live-events', flush: true })}
      </div></div>`;
  },
  async start() {
    if (S.live && S.live.stream) return;
    const L = S.live = { captured: 0, sent: 0, gated: 0, lastSent: 0, inflight: false, prev: null, state: null };
    try {
      L.stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: false });
    } catch (e) { toast('Camera unavailable: ' + e.message); S.live = null; return; }
    const v = $('#live-video');
    v.srcObject = L.stream;
    await v.play().catch(() => {});
    try { L.sid = (await POST('api/live/session', {})).sid; }
    catch (e) { toast('Could not start a live session: ' + e.message); this.stop(); return; }
    L.small = Object.assign(document.createElement('canvas'), { width: 64, height: 36 });
    L.big = Object.assign(document.createElement('canvas'), { width: 640, height: 360 });
    L.tick = setInterval(() => this.tick(v), 500);
    L.poll = setInterval(() => this.poll(), 1500);
  },
  tick(v) {
    const L = S.live;
    if (!L || !v.videoWidth) return;
    L.captured++;
    const sctx = L.small.getContext('2d', { willReadFrequently: true });
    sctx.drawImage(v, 0, 0, 64, 36);
    const px = sctx.getImageData(0, 0, 64, 36).data;
    const gray = new Uint8ClampedArray(64 * 36);
    for (let i = 0; i < gray.length; i++) gray[i] = (px[i * 4] * 0.299 + px[i * 4 + 1] * 0.587 + px[i * 4 + 2] * 0.114);
    let diff = 0;
    if (L.prev) { for (let i = 0; i < gray.length; i++) diff += Math.abs(gray[i] - L.prev[i]); diff /= gray.length * 255; }
    L.prev = gray;
    L.motion = diff;
    const now = Date.now();
    const reason = diff > 0.04 ? 'motion' : (now - L.lastSent > 5000 ? 'checkpoint' : null);
    if (!reason || L.inflight) { L.gated++; this.renderGate(); return; }
    L.inflight = true; L.lastSent = now; L.sent++;
    L.big.getContext('2d').drawImage(v, 0, 0, 640, 360);
    const b64 = L.big.toDataURL('image/jpeg', 0.72).split(',')[1];
    POST(`api/live/${enc(L.sid)}/frame`, { image_b64: b64, motion: diff, reason, ts: new Date().toISOString() })
      .catch(e => toast('Frame rejected: ' + e.message))
      .finally(() => { if (S.live) S.live.inflight = false; });
    this.renderGate();
  },
  renderGate() {
    const L = S.live; const st = (L && L.state && L.state.stats) || {};
    setHTML($('#live-gate'), L ? `<div class="transport" style="grid-template-columns:repeat(5,auto);justify-content:space-between">
      <span title="Frames sampled from the camera (2/s)">${L.captured} sampled</span>
      <span title="Frames sent after the motion gate">${L.sent} sent</span>
      <span title="Skipped by the motion gate">${L.gated} gated</span>
      <span title="Measured by the backend">${esc(st.cosmos_calls_per_min ?? '–')} Cosmos/min</span>
      <span title="Median Cosmos latency, measured">${st.p50_latency_ms != null ? 'p50 ' + esc(Math.round(st.p50_latency_ms)) + 'ms' : 'p50 –'}</span></div>` : '');
  },
  async poll() {
    const L = S.live;
    if (!L || !L.sid) return;
    try { L.state = await GET(`api/live/${enc(L.sid)}/state`); } catch (_) { return; }
    const st = L.state;
    const cl = st.classification;
    setHTML($('#live-config'), cl ? `<div><span class="tag accent">${esc(cap(cl.domain))} ${pct(cl.confidence)}</span></div>
      <div style="margin:8px 0">${esc(cl.description || '')}</div>
      ${st.profile ? `<div class="small muted">Watching for:</div><div>${(st.profile.objectives || []).map(o => `<div style="padding:4px 0">${sevPill(o.severity)} <span style="margin-left:6px">${esc(o.name)}</span></div>`).join('')}</div>` : '<div class="empty">Planning…</div>'}`
      : `<div class="empty">Observing… (${(st.observations || []).length}/3 observations before classifying)</div>`);
    setHTML($('#live-obs'), (st.observations || []).slice().reverse().slice(0, 12).map(o => `<div class="feed-item" style="cursor:default">
      <span class="sev-dot"></span><div style="min-width:0"><div class="ft">${esc(o.scene)}</div><div class="fs">${esc(clock(o.ts))} · ${esc((o.entities || []).join(', '))}${o.flags && o.flags.length ? ' · ' + esc(o.flags.join(', ')) : ''}</div></div>
      <span class="fc">${o.latency_ms != null ? esc(Math.round(o.latency_ms)) + 'ms' : ''}</span></div>`).join('') || '<div class="empty" style="padding:12px">None yet</div>');
    setHTML($('#live-events'), (st.events || []).slice().reverse().map(e => `<div class="feed-item" style="cursor:default">
      <span class="sev-dot ${esc(e.severity)}"></span><div style="min-width:0"><div class="ft">${esc(e.title)}</div><div class="fs">${esc(e.reason || '')}</div></div><span class="fc">${esc(clock(e.ts))}</span></div>`).join('') || '<div class="empty" style="padding:12px">No incidents</div>');
    this.renderGate();
  },
  stop() {
    const L = S.live;
    if (!L) return;
    clearInterval(L.tick); clearInterval(L.poll);
    if (L.stream) L.stream.getTracks().forEach(t => t.stop());
    S.live = null;
  },
};

// ---------------------------------------------------------------- routing, actions, polling
function parseRoute() {
  const h = location.hash.replace(/^#/, '') || '/';
  const [path, query] = h.split('?');
  const parts = path.split('/').filter(Boolean);
  const q = new URLSearchParams(query || '');
  if (parts[0] === 'source' && parts[1]) return { name: 'source', id: decodeURIComponent(parts[1]) };
  if (parts[0] === 'incident' && parts[1]) return { name: 'incident', id: decodeURIComponent(parts[1]) };
  if (parts[0] === 'search') return { name: 'search', q: q.get('q') || '', source: q.get('source') || '' };
  if (parts[0] === 'new') return { name: 'new' };
  if (parts[0] === 'live') return { name: 'live' };
  return { name: 'overview' };
}
// Set only the hash: with a runtime <base>, href="#..." links would navigate to the base URL instead.
function nav(path) { location.hash = '#' + path; }

async function render() {
  if (S.route.name === 'live') VIEWS.live.stop();
  S.route = parseRoute();
  const main = $('#main');
  main._html = null;
  main.innerHTML = '<div class="empty">Loading…</div>';
  main.scrollTo(0, 0);
  try {
    await VIEWS[S.route.name].mount(main);
    if (VIEWS[S.route.name].update) await VIEWS[S.route.name].update(main);
  } catch (e) { main.innerHTML = `<div class="page-h">Something went wrong: ${esc(e.message)}</div>`; }
  renderTop();
  renderSidebar();
}

const ACTIONS = {
  'select-source': el => { S.selected = el.dataset.id; },
  'ov-tab': el => { S.ovTab = el.dataset.tab; },
  'configure': async el => { await POST(`api/sources/${enc(el.dataset.id)}/configure`, {}); toast('Sightline is looking at this camera…', 'info'); },
  'monitor-start': async el => { await POST(`api/sources/${enc(el.dataset.id)}/monitor`, {}); toast('Monitoring started (archive replay)', 'info'); },
  'monitor-stop': async el => { await DEL(`api/sources/${enc(el.dataset.id)}/monitor`); },
  'plan-reingest': async el => { await POST(`api/sources/${enc(el.dataset.id)}/reingest/plan`, {}); },
  'approve-reingest': async el => { el.disabled = true; await POST(`api/reingest/${enc(el.dataset.job)}/approve`, {}); toast('Preview running; VAST re-ingest submitted', 'info'); },
  'preview-reingest': async el => { el.disabled = true; await POST(`api/reingest/${enc(el.dataset.job)}/preview`, {}); toast('Preview re-analysis running (index untouched)', 'info'); },
  'toggle-caption': el => el.classList.toggle('open'),
  'play-seg': el => {
    const seg = el.dataset.seg;
    const trip = [...document.querySelectorAll('.trip')].find(t => t.dataset.seg && t.dataset.seg === seg);
    if (!trip) return;
    trip.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const v = trip.querySelector('video');
    if (v) { v.currentTime = 0; v.play().catch(() => {}); }
  },
  'nf-pick': () => $('#nf-file') && $('#nf-file').click(),
  'nf-submit': () => VIEWS.new.submit($('#main')),
  'live-start': () => VIEWS.live.start(),
  'live-stop': () => VIEWS.live.stop(),
};

document.addEventListener('click', async e => {
  const act = e.target.closest('[data-action]');
  if (act && ACTIONS[act.dataset.action]) {
    e.preventDefault(); e.stopPropagation();
    try { await ACTIONS[act.dataset.action](act); refresh(); }
    catch (err) { toast(err.message); }
    return;
  }
  const n = e.target.closest('[data-nav]');
  if (n) { e.preventDefault(); nav(n.dataset.nav); }
});

// A clip that fails to load falls back to a placeholder instead of a black box.
document.addEventListener('error', e => {
  if (e.target && e.target.tagName === 'VIDEO' && !e.target.srcObject) {
    const ph = document.createElement('div');
    ph.className = 'ph';
    ph.innerHTML = '<div><div class="big">Clip unavailable</div><div>VSS stream did not load</div></div>';
    e.target.replaceWith(ph);
  }
}, true);

async function refresh() {
  if (S.busy) return;
  S.busy = true;
  try {
    const [sources, incidents] = await Promise.all([GET('api/sources'), GET('api/incidents')]);
    S.sources = Array.isArray(sources) ? sources : [];
    S.incidents = Array.isArray(incidents) ? incidents : [];
    if (!S.selected || !sourceById(S.selected)) S.selected = (S.sources.find(s => s.status === 'monitoring') || S.sources[0] || {}).id || null;
    renderTop();
    renderSidebar();
    const v = VIEWS[S.route.name];
    if (v && v.update) await v.update($('#main'));
    if (S.offline) toast('Backend reachable again', 'info');
    S.offline = false;
  } catch (e) {
    if (!S.offline) toast('Backend unreachable: ' + e.message);
    S.offline = true;
  } finally { S.busy = false; }
}

async function refreshStatus() {
  try { S.status = await GET('api/status'); }
  catch (_) { S.status = null; }
  renderTop();
}

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error('failed to load ' + src));
    document.head.appendChild(s);
  });
}

async function boot() {
  if (MOCK) await loadScript('mock.js');
  await refreshStatus();
  window.addEventListener('hashchange', render);
  await render();
  await refresh();
  setInterval(refresh, POLL_MS);
  setInterval(refreshStatus, STATUS_MS);
}

boot().catch(e => { $('#main').innerHTML = `<div class="page-h">Failed to start: ${esc(e.message)}</div>`; });
