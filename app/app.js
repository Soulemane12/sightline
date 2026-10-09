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
      <div class="tl-lanes" data-scrub="${esc(src.id)}" title="Click or drag to scrub through this camera's footage">
        <div class="tl-ruler">${ticks}</div>
        <div class="tl-lane">${clips}</div>
        <div class="tl-lane">${marks}</div>
        ${pos != null ? `<div class="playhead" style="left:${(pos * 100).toFixed(2)}%" title="Replay clock"></div>` : ''}
        ${S.scrub && S.scrub.id === src.id ? `<div class="scrubhead" style="left:${(S.scrub.frac * 100).toFixed(2)}%"><span>${esc(scrubLabel(src, S.scrub.frac))}</span></div>` : ''}
      </div>
    </div>
    <div class="tl-foot">${r && r.active ? `Archive replay ${esc(r.speed || '')}× · segment ${esc(r.segment)}/${esc(total)} · ` : ''}click or drag the timeline to scrub · click a marker to open its incident</div>`;
}

function scrubLabel(src, frac) {
  const total = (src.replay && src.replay.total_segments) || src.segment_count || 0;
  const segSec = src.segment_seconds || 5;
  return fmtTC(Math.floor(frac * total) * segSec).slice(0, 8);
}

const VIDEO_CACHE = {};   // source id → videos[] (replay order)
const SEG_CACHE = {};     // original_video → segments[]
async function sourceVideos(id) {
  if (!VIDEO_CACHE[id]) VIDEO_CACHE[id] = (await GET(`api/sources/${enc(id)}`)).videos || [];
  return VIDEO_CACHE[id];
}
async function videoSegments(id, ov) {
  if (!SEG_CACHE[ov]) SEG_CACHE[ov] = await GET(`api/sources/${enc(id)}/segments?video=${enc(ov)}`);
  return SEG_CACHE[ov];
}

/** Map a timeline position to the real segment (videos in replay order) and show it in the viewer. */
async function scrubCommit(id, frac) {
  S.scrub = { id, frac, loading: true };
  renderScrubViewer();
  try {
    const vids = await sourceVideos(id);
    const total = vids.reduce((a, v) => a + (v.total_segments || 0), 0);
    if (!total) throw new Error('no segments');
    let g = Math.min(total - 1, Math.floor(frac * total)), i = 0;
    while (i < vids.length - 1 && g >= (vids[i].total_segments || 0)) { g -= vids[i].total_segments || 0; i++; }
    const segs = await videoSegments(id, vids[i].original_video);
    const seg = segs[Math.min(g, segs.length - 1)];
    if (!S.scrub || S.scrub.id !== id || S.scrub.frac !== frac) return;  // a newer scrub won
    S.scrub = { id, frac, seg, clip: i + 1, clips: vids.length, local: g + 1, filename: vids[i].filename };
  } catch (e) {
    if (S.scrub && S.scrub.frac === frac) S.scrub = { id, frac, error: e.message };
  }
  renderScrubViewer();
}

function renderScrubViewer() {
  const box = $('#ov-player');
  const sc = S.scrub;
  if (!box || !sc || sc.id !== S.selected) return;
  const back = `<button class="btn" data-action="scrub-clear" style="position:absolute;top:8px;right:8px;z-index:3">Back to latest incident</button>`;
  if (sc.loading || sc.error || !sc.seg) {
    setHTML(box, `<div class="player">${back}<div class="ph"><div><div class="big">${sc.error ? 'Clip unavailable' : 'Loading clip…'}</div><div>${esc(sc.error || '')}</div></div></div></div>`);
    return;
  }
  const seg = sc.seg;
  setHTML(box, `<div style="position:relative;width:100%;height:100%">${back}${player({ segment: seg.source_uri, camera_id: seg.camera_id, t_start: seg.t_start }, {
    autoplay: true, badge: 'SCRUB', cam: seg.camera_id,
    overlay: `<span class="mono small">clip ${esc(sc.clip)}/${esc(sc.clips)} · segment ${esc(sc.local)}</span><br><span class="muted">${captionHTML(String(seg.caption || '').slice(0, 220))}</span>`,
  })}</div>`);
}

let DRAG = null;
function scrubFrac(e) {
  const r = DRAG.lanes.getBoundingClientRect();
  return Math.max(0, Math.min(0.9999, (e.clientX - r.left) / (r.width || 1)));
}
document.addEventListener('pointerdown', e => {
  const lanes = e.target.closest('.tl-lanes[data-scrub]');
  if (!lanes || e.target.closest('.tl-mark') || e.button !== 0) return;
  e.preventDefault();
  DRAG = { lanes, id: lanes.dataset.scrub };
  S.selected = DRAG.id;
  moveScrubHead(scrubFrac(e));
});
document.addEventListener('pointermove', e => { if (DRAG) moveScrubHead(scrubFrac(e)); });
document.addEventListener('pointerup', e => {
  if (!DRAG) return;
  const f = scrubFrac(e), id = DRAG.id;
  DRAG = null;
  scrubCommit(id, f);
});
function moveScrubHead(f) {
  let head = DRAG.lanes.querySelector('.scrubhead');
  if (!head) { head = document.createElement('div'); head.className = 'scrubhead'; head.appendChild(document.createElement('span')); DRAG.lanes.appendChild(head); }
  head.style.left = (f * 100).toFixed(2) + '%';
  const src = sourceById(DRAG.id);
  if (src) head.firstChild.textContent = scrubLabel(src, f);
  S.scrub = { ...(S.scrub || {}), id: DRAG.id, frac: f };
}

/** The same moment can be re-investigated on every monitoring run; keep one incident per moment. */
function dedupeIncidents(list) {
  const best = new Map();
  for (const inc of list) {
    const inv = inc.investigation || {};
    const ev = (inc.evidence || []).find(e => e.role === 'event');
    const key = [inc.source_id, inc.objective_id, inv.peak_segment || (ev && ev.segment) || inc.peak_at].join('|');
    const cur = best.get(key);
    const conf = (inc.confidence && inc.confidence.value) || 0;
    if (!cur || conf > ((cur.confidence && cur.confidence.value) || 0)) best.set(key, inc);
  }
  return [...best.values()];
}

// ---------------------------------------------------------------- top bar + sidebar
function renderTop() {
  const st = S.status || {};
  const monitoring = S.sources.filter(s => s.status === 'monitoring').length;
  const speed = st.replay && st.replay.speed;
  setHTML($('#monitor-state'), monitoring
    ? `<span class="rec"></span><span><b>Monitoring</b> ${monitoring} feed${monitoring > 1 ? 's' : ''}</span>
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
  const shown = { new: MOCK || !!flags.upload || !!S.uploadEnabled, live: MOCK || !!flags.live };
  document.querySelectorAll('#pages button').forEach(b => {
    b.classList.toggle('active', b.dataset.page === page);
    if (b.dataset.page in shown) b.hidden = !shown[b.dataset.page];  // hide features disabled on this deployment
  });
}

/** A feed is a source you added (configured or monitoring); the rest of the archive lives in Search. */
const isFeed = src => !!src && (['monitoring', 'configuring', 'configured', 'specializing'].includes(src.status) || !!AM[src.id]);
const feedState = src => src.status === 'monitoring' ? 'Monitoring' : (src.status === 'configuring' || AM[src.id]) ? 'Setting up…' : 'Paused';
function defaultFeed() {
  const feeds = S.sources.filter(isFeed);
  return feeds.find(s => s.status === 'monitoring') || feeds[0] || null;
}

function renderSidebar() {
  const feeds = S.sources.filter(isFeed);
  const activeId = S.route.name === 'source' ? S.route.id : S.selected;
  const items = feeds.map(src => {
    const c = src.incident_counts || {};
    const live = src.status === 'monitoring';
    const n = live ? (c.critical || 0) + (c.high || 0) + (c.medium || 0) + (c.low || 0) : 0;
    const hot = live && (c.critical || 0) + (c.high || 0) > 0;
    const cl = src.classification;
    return `<div class="src ${src.id === activeId ? 'active' : ''}" data-action="open-feed" data-id="${esc(src.id)}">
      <span class="thumb ${esc(src.status || '')}"></span>
      <div style="min-width:0"><div class="label">${esc(src.label || src.camera_id)}</div>
        <div class="sub">${cl ? esc(cap(cl.domain)) + ' · ' : ''}${esc(feedState(src))}</div></div>
      <span class="count ${hot ? 'hot' : ''}" title="Incidents">${n || ''}</span>
    </div>`;
  }).join('');
  const ups = (S.uploads || []).map(u => {
    const up = u.upload || {};
    const active = S.route.name === 'new' && S.fresh && S.fresh.sid === u.source_id;
    const state = up.status === 'done' ? `${up.incidents ?? 0} incident${up.incidents === 1 ? '' : 's'}` : up.status === 'failed' ? 'Failed' : 'Analyzing…';
    return `<div class="src ${active ? 'active' : ''}" data-action="open-upload" data-sid="${esc(u.source_id)}">
      <span class="thumb ${up.status === 'done' ? 'configured' : 'configuring'}"></span>
      <div style="min-width:0"><div class="label">${esc(up.filename || u.label)}</div><div class="sub">Uploaded · ${esc(state)}</div></div>
      <span class="count"></span></div>`;
  }).join('');
  setHTML($('#sidebar'), `
    <div class="side-h"><span>Feeds <span class="mono muted">${feeds.length + (S.uploads || []).length}</span></span>${feeds.length + (S.uploads || []).length ? '<button class="linkbtn" data-action="clear-feeds">Clear all</button>' : ''}</div>
    ${items + ups || '<div class="empty" style="padding:12px">No feeds yet.</div>'}
    <div style="padding:12px 12px 6px" class="btn-row"><button class="btn primary" style="flex:1" data-nav="/search">＋ Add a feed</button>${S.uploadEnabled ? '<button class="btn" style="flex:1" data-nav="/new">Upload a clip</button>' : ''}</div>
    <div class="small muted" style="padding:0 12px">Search the VAST archive and press <b>Add to Monitor</b>${S.uploadEnabled ? ', or Import a clip' : ''}.</div>`);
}

// ---------------------------------------------------------------- views
const VIEWS = {};

VIEWS.overview = {
  mount(main) {
    main.innerHTML = `<div id="ov-empty"></div>
      <div class="ws" id="ov-ws">
      <section class="pane viewer-pane">
        <header class="pane-h"><span class="pt" id="ov-title">Feed</span><span class="pr" id="ov-actions"></span></header>
        <div class="pane-b" id="ov-player"></div>
        <div class="transport" id="ov-transport"></div>
      </section>
      <section class="pane">
        <header class="pane-h"><span class="pt">Incidents</span><span class="pr" id="ov-feed-meta"></span></header>
        <div class="pane-b flush" id="ov-side"></div>
      </section>
      <section class="pane timeline-pane">
        <header class="pane-h"><span class="pt">Timeline</span></header>
        <div class="pane-b flush" id="ov-timeline"></div>
      </section>
    </div>`;
  },
  async update(main) {
    let src = sourceById(S.selected);
    if (!isFeed(src)) { src = defaultFeed(); S.selected = src ? src.id : null; }
    const empty = $('#ov-empty', main), ws = $('#ov-ws', main);
    if (!src) {
      if (ws) ws.style.display = 'none';
      setHTML(empty, `<div class="pane" style="max-width:640px;margin:60px auto"><div class="pane-b" style="padding:28px;text-align:center">
        <div style="font-size:18px;font-weight:600;margin-bottom:6px">Add your first feed</div>
        <div class="muted" style="margin-bottom:16px">Find footage in the VAST archive and press Add to Monitor. Sightline works out what the feed shows, decides what to watch for, and starts monitoring it.</div>
        <div class="btn-row" style="justify-content:center"><button class="btn primary" data-nav="/search">Search the archive</button>${S.uploadEnabled ? '<button class="btn" data-nav="/new">Import a clip</button>' : ''}</div></div></div>`);
      return;
    }
    if (ws) ws.style.display = '';
    setHTML(empty, '');
    const live = src.status === 'monitoring';
    const mine = live ? sortIncidents(S.incidents.filter(i => i.source_id === src.id)) : [];
    const cl = src.classification;

    setHTML($('#ov-title', main), `${esc(src.label || src.camera_id)} <span class="tag" style="margin-left:6px">${esc(feedState(src))}</span>${cl ? `<span class="tag">${esc(cap(cl.domain))}</span>` : ''}`);
    setHTML($('#ov-actions', main), `<button class="btn" data-nav="/source/${enc(src.id)}">Details</button>
      ${live ? `<button class="btn" data-action="monitor-stop" data-id="${esc(src.id)}">Pause</button>` : addMonitorInline(src.id, true)}
      <button class="btn danger" data-action="remove-feed" data-id="${esc(src.id)}" title="Stop monitoring and clear this feed's incidents and configuration">Remove</button>`);

    const latest = mine[0];
    const ev = latest && (latest.evidence || []).find(e => e.role === 'event');
    const replay = live ? (src.replay || null) : null;
    if (S.scrub && S.scrub.id === src.id && (S.scrub.seg || S.scrub.loading || S.scrub.error)) {
      renderScrubViewer();
    } else if (latest && ev) {
      setHTML($('#ov-player', main), player(ev, {
        badge: 'LATEST INCIDENT', autoplay: true, cam: latest.camera_id,
        overlay: `${sevPill(latest.severity)} <b style="margin-left:6px">${esc(latest.title)}</b> <span class="muted">· ${pct(latest.confidence && latest.confidence.value)}</span>`,
      }));
    } else {
      setHTML($('#ov-player', main), player(replay && replay.segment_uri ? { segment: replay.segment_uri } : null, {
        cam: src.camera_id,
        overlay: live ? '<span class="muted">Watching. No incidents yet. Drag the timeline to look through the footage.</span>'
                      : '<span class="muted">Paused. Press Start monitoring to have Sightline watch this feed.</span>',
      }));
    }
    const segSec = src.segment_seconds || 5;
    const scrubbing = S.scrub && S.scrub.id === src.id;
    setHTML($('#ov-transport', main), `<span>${esc(src.camera_id)}</span>
      <span class="tc">${scrubbing ? esc(fmtTC(Math.floor(S.scrub.frac * (src.segment_count || 0)) * segSec)) : replay ? esc(fmtTC((replay.segment || 0) * segSec)) : '--:--:--:--'}</span>
      <span class="r">${live && replay && replay.active ? `${esc(replay.speed)}× replay` : feedState(src).toLowerCase()}</span>`);

    const fresh = new Set();
    if (S.feedReady) mine.forEach(i => { if (!S.seen.has(i.id)) fresh.add(i.id); });
    S.incidents.forEach(i => S.seen.add(i.id));
    S.feedReady = true;
    setHTML($('#ov-feed-meta', main), live ? `${mine.length}` : '');
    setHTML($('#ov-side', main), !live ? '<div class="empty" style="padding:12px">Not monitoring this feed.</div>'
      : mine.length ? `<div class="feed">${mine.map(i => feedItem(i, fresh.has(i.id))).join('')}</div>`
      : '<div class="empty" style="padding:12px">No incidents yet. Sightline is watching.</div>');
    if (!DRAG) setHTML($('#ov-timeline', main), timelineHTML(src, mine));
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
      <div class="cols-3-2">
        ${pane('What Sightline decided', '', { id: 'sv-summary' })}
        ${pane('Incidents', '', { id: 'sv-incidents', flush: true })}
      </div>
      <div><button class="btn" data-action="toggle-how" id="sv-how-btn">${S.showHow ? 'Hide details' : 'Show how Sightline configured this feed'}</button></div>
      <div class="stack" id="sv-how" ${S.showHow ? '' : 'hidden'}>
        <div class="cols2">
          ${pane('Why it thinks so', '', { id: 'sv-config' })}
          ${pane('Agent pipeline', '', { id: 'sv-pipeline', flush: true })}
        </div>
        ${pane('Monitoring plan', '', { id: 'sv-plan', flush: true, right: 'generated by Sightline, not hand-written' })}
        <div class="cols2">
          ${pane('Cosmos prompt', '', { id: 'sv-prompt' })}
          ${pane('Re-analysis', '', { id: 'sv-reingest', right: 'preview in seconds · VAST index async' })}
        </div>
        ${pane('Analysis versions', '', { id: 'sv-evo' })}
      </div>
    </div>`;
  },
  async update(main) {
    const id = S.route.id;
    S.selected = id;
    let d;
    try { d = await GET(`api/sources/${enc(id)}`); }
    catch (e) { setHTML($('#sv-head', main), `<div class="page-h">Feed unavailable: ${esc(e.message)}</div>`); return; }
    const cl = d.classification, pf = d.profile;
    const monitoring = d.status === 'monitoring';
    const src0 = { ...d, status: d.status };
    setHTML($('#sv-head', main), `<div class="page-h">
      <div class="grow"><h1>${esc(d.label || d.camera_id)}
          ${cl ? `<span class="tag accent" title="Sightline's environment classification">${esc(cap(cl.domain))} ${pct(cl.confidence)}</span>` : ''}
          <span class="tag">${esc(feedState(src0))}</span></h1>
        <div class="meta">${esc(d.camera_id)} · ${esc(d.segment_count ?? '?')} segments${cl && cl.camera_type ? ' · ' + esc(cl.camera_type) + ' camera' : ''}</div></div>
      <div class="btn-row">
        ${monitoring ? `<button class="btn" data-nav="/">Watch</button><button class="btn" data-action="monitor-stop" data-id="${esc(d.id)}">Pause</button>`
                     : addMonitorInline(d.id, true)}
        ${isFeed(d) ? `<button class="btn danger" data-action="remove-feed" data-id="${esc(d.id)}" title="Stop monitoring and clear this feed's incidents and configuration">Remove feed</button>` : ''}
      </div></div>`);

    setHTML($('#sv-summary', main), cl ? `
      <div style="margin-bottom:10px">${esc(cl.description || '')}</div>
      <div class="small muted" style="margin-bottom:4px">Watching for</div>
      ${((pf && pf.objectives) || []).map(o => `<div style="padding:4px 0">${sevPill(o.severity)} <span style="margin-left:6px">${esc(o.name)}</span></div>`).join('') || '<div class="empty">Planning…</div>'}
      ${((pf && pf.dropped) || []).map(x => `<div style="padding:4px 0" class="muted"><span class="sev low"><i></i>N/A</span> <span style="margin-left:6px">${esc(x.name || x.id)}: not applicable here</span></div>`).join('')}`
      : `<div class="empty">Sightline hasn't looked at this feed yet. Press Add to Monitor.</div>`);

    setHTML($('#sv-config', main), cl ? `
      <ul class="evidence-list">${(cl.evidence || []).map(e => `<li><span class="tag">${esc(e.source)}</span><span>${esc(e.signal)} <span class="muted">${esc(e.supports || '')}</span></span></li>`).join('')}</ul>
      ${cl.important_entities && cl.important_entities.length ? `<div style="margin-top:10px">${cl.important_entities.map(e => `<span class="tag accent">${esc(e)}</span>`).join('')}</div>` : ''}`
      : `<div class="empty">Not configured yet.</div>`);

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

    setHTML($('#sv-reingest', main), reingestHTML(d, d.reingest) + (cl ? `<div class="btn-row" style="margin-top:10px"><button class="btn" data-action="configure" data-id="${esc(d.id)}">Re-run self-configuration</button></div>` : ''));
    setHTML($('#sv-evo', main), evolutionHTML(d.evolution));
    const incs = monitoring ? sortIncidents(dedupeIncidents(d.incidents || S.incidents.filter(i => i.source_id === id))) : [];
    setHTML($('#sv-incidents', main), !monitoring ? '<div class="empty" style="padding:12px">Not monitoring this feed.</div>'
      : incs.length ? `<div class="feed">${incs.map(i => feedItem(i, false)).join('')}</div>` : '<div class="empty" style="padding:12px">No incidents yet.</div>');
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

const AM = {};  // camera id → {btn, line} while an Add to Monitor flow is running (survives re-renders)

function addMonitorButton(id, stay, video) {
  return `<div class="btn-row" style="margin-top:8px">${addMonitorInline(id, stay, video)}</div>`;
}
function addMonitorInline(id, stay, video) {
  const src = sourceById(id);
  const busy = AM[id];
  const on = !busy && src && src.status === 'monitoring';
  const label = busy ? busy.btn : on ? 'Monitoring · open' : (src && src.classification ? '▶ Start monitoring' : '＋ Add to Monitor');
  return `<button class="btn ${on ? '' : 'primary'}" data-action="add-monitor" data-id="${esc(id)}"${video ? ` data-video="${esc(video)}"` : ''}${stay ? ' data-stay="1"' : ''}${busy ? ' disabled' : ''}>${esc(label)}</button>
    <span class="small muted mono" data-am-status="${esc(id)}">${esc(busy ? busy.line : '')}</span>`;
}

async function waitJob(jobId, timeoutMs, onTick) {
  const t0 = Date.now();
  for (;;) {
    const j = await GET(`api/jobs/${enc(jobId)}`);
    if (j.status === 'done' || j.status === 'completed') return j.result;
    if (j.status === 'failed') throw new Error(j.error || 'job failed');
    if (Date.now() - t0 > timeoutMs) throw new Error('timed out');
    if (onTick) await onTick();
    await new Promise(r => setTimeout(r, 1500));
  }
}

/** Search or camera page → one click: configure (if needed) → start monitoring → open the camera. */
async function addToMonitor(el) {
  const id = el.dataset.id;
  const stay = el.dataset.stay === '1';
  const say = (btn, line) => {
    AM[id] = { btn, line: line || '' };
    document.querySelectorAll(`[data-action="add-monitor"][data-id="${CSS.escape(id)}"]`).forEach(b => { b.textContent = btn; b.disabled = true; });
    document.querySelectorAll(`[data-am-status="${CSS.escape(id)}"]`).forEach(x => { x.textContent = line || ''; });
  };
  if (AM[id]) return;
  let src = sourceById(id);
  try { src = await GET(`api/sources/${enc(id)}`); } catch (_) { /* fall back to the cached list */ }
  if (src && src.status === 'monitoring') { S.selected = id; if (!stay) nav('/source/' + enc(id)); return; }
  try {
    if (!src || !src.classification) {
      say('Configuring…', 'Sightline is looking at this feed');
      const r = await POST(`api/sources/${enc(id)}/configure`, {});
      await waitJob(r.job_id, 180000, async () => {
        try {
          const run = await GET(`api/pipeline/${enc(id)}`);
          const cur = (run.steps || []).filter(s => s.status === 'running' || s.status === 'done').pop();
          if (cur) say('Configuring…', `${cur.label || STEP_LABELS[cur.key] || cur.key}${cur.summary ? ': ' + cur.summary : ''}`);
        } catch (_) { /* progress is best-effort */ }
      });
    }
    say('Starting…', 'Starting autonomous monitoring');
    await POST(`api/sources/${enc(id)}/monitor`, el.dataset.video ? { video: el.dataset.video } : {});
    delete AM[id];
    toast('Sightline configured this feed and started monitoring', 'info');
    S.selected = id;
    if (!stay) nav('/source/' + enc(id));
  } catch (e) {
    delete AM[id];
    document.querySelectorAll(`[data-am-status="${CSS.escape(id)}"]`).forEach(x => { x.textContent = 'Failed: ' + e.message; });
    document.querySelectorAll(`[data-action="add-monitor"][data-id="${CSS.escape(id)}"]`).forEach(b => { b.disabled = false; b.textContent = '＋ Add to Monitor'; });
    throw e;
  }
}

VIEWS.search = {
  mount(main) {
    const r = S.route;
    main.innerHTML = `<div class="stack">${pane('Search the archive', `
      <form class="search-row" id="search-form">
        <input type="text" name="q" placeholder="forklift close to a worker" value="${esc(r.q)}">
        <select name="source"><option value="">All cameras</option>${S.sources.map(s => `<option value="${esc(s.id)}" ${s.id === r.source ? 'selected' : ''}>${esc(s.label || s.camera_id)}</option>`).join('')}</select>
        <button class="btn primary">Search</button></form>
      <div class="small muted" style="margin-top:8px">Find any footage in the VAST archive, then <b>Add to Monitor</b>: Sightline works out what the feed shows, decides what to watch for, writes its own prompt and starts monitoring. No rules or queries to write.</div>`,
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
        <div>${esc(String(h.caption || '').slice(0, 200))}</div>
        ${h.camera_id ? addMonitorButton(h.camera_id, false, h.original_video) : ''}</div>`).join('')}</div>` : '<div class="empty">No matches.</div>';
    } catch (e) { box.innerHTML = `<div class="empty">Search failed: ${esc(e.message)}</div>`; }
  },
};

// ----- import: upload any clip; Sightline configures itself on it and puts markers on its timeline
VIEWS.new = {
  mount(main) {
    if (!S.uploadEnabled && !MOCK) { main.innerHTML = pane('Import', '<div class="empty">Disabled on this deployment.</div>'); return; }
    S.fresh = S.fresh || {};
    main.innerHTML = `<div class="stack">
      <div class="cols-3-2">
        ${pane('Import any footage', `
          <input type="file" id="nf-file" accept="video/*" hidden>
          <div class="drop" data-action="nf-pick">Choose a video file${S.uploadMax ? ` (max ${esc(S.uploadMax)} MB)` : ''}<div class="small">Self-recorded or licensed footage. H.264 MP4 works best; short clips (10–90 s) analyze fastest.</div></div>
          <div class="small muted" style="margin-top:8px">You don't tell Sightline what to look for. It samples the clip, works out what kind of place it is, decides what matters there, writes its own Cosmos prompt, re-analyzes the clip with it, and marks the moments that matter.</div>
          <div id="nf-preview"></div>`, { id: 'nf-left' })}
        ${pane('Agent pipeline', '<div class="empty" style="padding:12px">Waiting for a clip.</div>', { id: 'nf-pipeline', flush: true })}
      </div>
      <div id="nf-results"></div>
      ${pane('Recent uploads', '<div class="empty" style="padding:12px">None yet.</div>', { id: 'nf-recent', flush: true })}
    </div>`;
    $('#nf-file', main).addEventListener('change', e => this.pick(main, e.target.files[0]));
    if (S.fresh.frames || S.fresh.sid) this.showPreview(main);
  },
  async pick(main, file) {
    if (!file) return;
    const lim = S.uploadMax || (S.status && S.status.limits && S.status.limits.upload_mb);
    if (lim && file.size > lim * 1024 * 1024) { toast(`File is ${(file.size / 1048576).toFixed(1)} MB; the limit is ${lim} MB`); return; }
    $('#nf-preview', main).innerHTML = '<div class="empty">Sampling frames…</div>';
    try {
      const kf = await extractFrames(file);
      S.fresh = { file, frames: kf.frames, duration: kf.duration, width: kf.width, height: kf.height, url: kf.url };
      this.showPreview(main);
    } catch (e) { $('#nf-preview', main).innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  },
  showPreview(main) {
    const f = S.fresh;
    const url = f.url || (f.sid ? new URL(`api/newsource/${enc(f.sid)}/video`, document.baseURI).href : '');
    $('#nf-preview', main).innerHTML = `
      <div class="player" style="margin-top:12px"><video id="nf-video" src="${esc(url)}" controls muted playsinline></video></div>
      <div id="nf-markers"></div>
      ${f.frames ? `<div class="small muted mono" style="margin-top:6px">${esc(f.file ? f.file.name : '')} · ${f.file ? (f.file.size / 1048576).toFixed(1) + ' MB · ' : ''}${fmtT(f.duration)} · ${f.frames.length} frames sampled</div>
      <div class="btn-row" style="margin-top:10px"><button class="btn primary" data-action="nf-submit" ${f.sid ? 'disabled' : ''}>${f.sid ? 'Sightline is on it' : 'Let Sightline configure it'}</button></div>` : ''}
      ${f.sid ? `<div class="btn-row" style="margin-top:10px"><button class="btn danger" data-action="remove-upload" data-sid="${esc(f.sid)}">Remove this upload</button></div>` : ''}`;
  },
  async submit(main) {
    const f = S.fresh;
    if (!f || !f.file || f.sid) return;
    const fd = new FormData();
    fd.append('file', f.file, f.file.name);
    f.frames.forEach((k, i) => fd.append(`keyframe_${i}`, k.blob, `keyframe_${i}.jpg`));
    fd.append('keyframe_times', JSON.stringify(f.frames.map(k => k.t)));
    fd.append('duration', String(f.duration || 0));
    if (f.width && f.height) { fd.append('width', String(f.width)); fd.append('height', String(f.height)); }
    try {
      toast('Uploading… on slow Wi-Fi this can take a moment', 'info');
      const r = await POST('api/newsource', fd, true);
      f.sid = r.source_id;
      this.showPreview(main);
      this.update(main);
    } catch (e) { toast('Upload failed: ' + e.message); }
  },
  async update(main) {
    if (!$('#nf-recent', main)) return;
    try {
      const recent = await GET('api/newsource');
      setHTML($('#nf-recent', main), recent.length ? `<div class="feed">${recent.map(r => `<div class="feed-item" data-action="nf-open" data-sid="${esc(r.source_id)}">
        <span class="sev-dot"></span><div style="min-width:0"><div class="ft">${esc((r.upload && r.upload.filename) || r.label)}</div>
        <div class="fs">${esc(r.status)} · ${esc((r.upload && r.upload.incidents) ?? 0)} incidents · ${esc(clock(r.upload && r.upload.created_at))}</div></div><span class="fc"></span></div>`).join('')}</div>`
        : '<div class="empty" style="padding:12px">None yet.</div>');
    } catch (_) { /* optional */ }
    const f = S.fresh;
    if (!f || !f.sid) return;
    let v;
    try { v = await GET(`api/newsource/${enc(f.sid)}`); } catch (e) { setHTML($('#nf-pipeline', main), `<div class="empty" style="padding:12px">${esc(e.message)}</div>`); return; }
    const up = v.upload || {};
    setHTML($('#nf-pipeline', main), pipelineHTML(v.pipeline) +
      (up.status === 'failed' ? `<div class="callout warn" style="margin:10px">Failed: ${esc(up.error || '')}</div>` : '') +
      (up.status === 'done' ? `<div class="small muted" style="padding:10px">Done in ${esc(up.elapsed_s)} s · ${esc(up.incidents)} incident(s)</div>` : ''));
    const dur = f.duration || up.duration || 1;
    const marks = v.markers || [];
    setHTML($('#nf-markers'), `<div class="tl" style="margin-top:8px"><div class="tl-labels"><div class="tl-l">Markers</div></div><div class="tl-lanes">
        <div class="tl-lane">${marks.map(m => `<span class="tl-mark ${esc(m.status === 'incident' ? (m.severity || 'medium') : 'low')}" style="left:${Math.min(100, 100 * (m.t || 0) / dur).toFixed(2)}%;${m.status === 'rejected' ? 'opacity:.35;' : ''}" data-action="nf-seek" data-t="${esc(m.t_start ?? m.t)}" title="${esc(fmtT(m.t))} · ${esc(m.title)} · ${esc(m.status)}${m.confidence != null ? ' · ' + pct(m.confidence) : ''}"></span>`).join('')}</div>
      </div></div>`);
    const cl = v.classification, pf = v.profile || {};
    const pr = pf.generated_prompt;
    setHTML($('#nf-results'), cl ? `<div class="cols2">
        ${pane('What Sightline decided this is', `<div style="margin-bottom:8px"><span class="tag accent">${esc(cap(cl.domain))} ${pct(cl.confidence)}</span> ${cl.camera_type ? `<span class="tag">${esc(cl.camera_type)} camera</span>` : ''}</div>
          <div style="margin-bottom:8px">${esc(cl.description || '')}</div>
          <ul class="evidence-list">${(cl.evidence || []).map(e => `<li><span class="tag">${esc(e.source)}</span><span>${esc(e.signal)}</span></li>`).join('')}</ul>`)}
        ${pane('What it will watch for', `${(pf.objectives || []).map(o => `<div class="qa">${sevPill(o.severity)} <span style="margin-left:6px">${esc(o.name)}</span><div class="a small">${esc(o.description || '')}</div></div>`).join('') || '<div class="empty">Planning…</div>'}
          ${(pf.dropped || []).map(x => `<div class="qa"><span class="sev low"><i></i>N/A</span> <span class="muted" style="margin-left:6px">${esc(x.name || x.id)}</span><div class="a small">${esc(x.reason)}</div></div>`).join('')}`)}
      </div>
      <div class="cols2" style="margin-top:6px">
        ${pane('Cosmos prompt Sightline wrote for this clip', pr ? `<div class="editor"><pre class="prompt-box">${esc(pr.text)}</pre><div class="editor-status"><span class="ok">${esc(pr.chars ?? (pr.text || '').length)}/800</span><span>${pr.template_fallback ? 'template fallback' : 'written by Sightline'}</span></div></div>` : '<div class="empty">Writing…</div>')}
        ${pane('Markers on the timeline', marks.length ? `<div class="feed">${marks.map(m => `<div class="feed-item" ${m.incident_id ? `data-nav="/incident/${enc(m.incident_id)}"` : `data-action="nf-seek" data-t="${esc(m.t_start ?? m.t)}"`}>
            <span class="sev-dot ${esc(m.status === 'incident' ? (m.severity || 'medium') : 'low')}"></span>
            <div style="min-width:0"><div class="ft">${esc(m.title)}</div><div class="fs">${esc(fmtT(m.t_start))}–${esc(fmtT(m.t_end))} · ${esc(m.status)}</div></div>
            <span class="fc">${m.confidence != null ? pct(m.confidence) : ''}</span></div>`).join('')}</div>` : '<div class="empty" style="padding:12px">No markers yet.</div>', { flush: true })}
      </div>
      <div style="margin-top:6px">${pane('Analysis versions', evolutionHTML(v.evolution))}</div>` : '');
  },
};

async function extractFrames(file) {
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.src = url; v.muted = true; v.playsInline = true; v.preload = 'auto';
  await new Promise((res, rej) => {
    v.onloadeddata = res;
    v.onerror = () => rej(new Error('This browser cannot decode the clip. Try an H.264 MP4.'));
  });
  const dur = v.duration || 1;
  const step = Math.min(6, Math.max(1.5, dur / 24));
  const n = Math.max(4, Math.min(40, Math.ceil(dur / step)));
  const c = document.createElement('canvas');
  c.width = 512; c.height = Math.round(512 * (v.videoHeight || 288) / (v.videoWidth || 512));
  const ctx = c.getContext('2d');
  const frames = [];
  for (let i = 0; i < n; i++) {
    const t = Math.min(dur - 0.05, (i + 0.5) * dur / n);
    await new Promise(res => { v.onseeked = res; v.currentTime = t; setTimeout(res, 1500); });
    ctx.drawImage(v, 0, 0, c.width, c.height);
    frames.push({ t: Math.round(t * 100) / 100, blob: await new Promise(r => c.toBlob(r, 'image/jpeg', 0.8)) });
  }
  return { frames, duration: dur, width: v.videoWidth, height: v.videoHeight, url };
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

/** Destructive buttons need a second click within 4 s (no browser dialogs). */
function armed(el, prompt) {
  if (el.dataset.armed === '1') return true;
  const label = el.textContent;
  el.dataset.armed = '1';
  el.textContent = prompt;
  setTimeout(() => { if (el.isConnected && el.dataset.armed === '1') { el.dataset.armed = ''; el.textContent = label; } }, 4000);
  return false;
}

const ACTIONS = {
  'select-source': el => { S.selected = el.dataset.id; S.scrub = null; },
  'open-feed': el => { S.selected = el.dataset.id; S.scrub = null; const m = $('#main'); if (S.route.name === 'overview' && m) VIEWS.overview.update(m); else nav('/'); },
  'open-upload': el => { S.fresh = { sid: el.dataset.sid }; if (S.route.name === 'new') { VIEWS.new.mount($('#main')); VIEWS.new.update($('#main')); } else nav('/new'); },
  'remove-feed': async el => {
    if (!armed(el, 'Click again to remove')) return;
    await DEL(`api/feeds/${enc(el.dataset.id)}`);
    if (S.selected === el.dataset.id) S.selected = null;
    S.scrub = null;
    toast('Feed removed. Its footage stays searchable in the archive.', 'info');
    if (S.route.name !== 'overview') nav('/');
  },
  'remove-upload': async el => {
    if (!armed(el, 'Click again to remove')) return;
    await DEL(`api/newsource/${enc(el.dataset.sid)}`);
    S.fresh = null;
    toast('Upload removed', 'info');
    VIEWS.new.mount($('#main'));
  },
  'clear-feeds': async el => {
    if (!armed(el, 'Click again to clear all')) return;
    await DEL('api/feeds');
    S.selected = null; S.scrub = null; S.fresh = null;
    toast('All feeds cleared', 'info');
    nav('/');
  },
  'toggle-how': el => { S.showHow = !S.showHow; const h = $('#sv-how'); if (h) h.hidden = !S.showHow; el.textContent = S.showHow ? 'Hide details' : 'Show how Sightline configured this feed'; },
  'scrub-clear': () => { S.scrub = null; const b = $('#ov-player'); if (b) b._html = null; },
  'add-monitor': el => addToMonitor(el),
  'ov-tab': el => { S.ovTab = el.dataset.tab; },
  'configure': async el => { await POST(`api/sources/${enc(el.dataset.id)}/configure`, {}); toast('Sightline is looking at this feed…', 'info'); },
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
  'nf-seek': el => { const v = $('#nf-video'); if (v) { v.currentTime = Number(el.dataset.t) || 0; v.play().catch(() => {}); } },
  'nf-open': el => { S.fresh = { sid: el.dataset.sid }; VIEWS.new.showPreview($('#main')); },
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
    S.incidents = dedupeIncidents(Array.isArray(incidents) ? incidents : []);
    if (S.uploadEnabled) { try { S.uploads = await GET('api/newsource'); } catch (_) { S.uploads = S.uploads || []; } }
    if (!S.selected || !sourceById(S.selected)) S.selected = (defaultFeed() || {}).id || null;
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
  if (MOCK) await loadScript('mock.js?v=' + Date.now());
  try { const u = await GET('api/newsource/enabled'); S.uploadEnabled = !!u.enabled; S.uploadMax = u.max_mb; } catch (_) { S.uploadEnabled = false; }
  await refreshStatus();
  await refresh();
  window.addEventListener('hashchange', render);
  await render();
  setInterval(refresh, POLL_MS);
  setInterval(refreshStatus, STATUS_MS);
}

boot().catch(e => { $('#main').innerHTML = `<div class="page-h">Failed to start: ${esc(e.message)}</div>`; });
