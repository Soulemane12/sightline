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
  route: { name: 'home' },
  ovTab: 'incidents',
  filter: { cams: [], sev: 'low', period: 'all', since: '', until: '' },
  busy: false,
  offline: false,
  live: null,
  fresh: null,
  tags: {},
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
function timelineHTML(src, incs, tags) {
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
  const tagMarks = (tags || []).filter(t => t.frac != null).map(t =>
    `<span class="tl-mark tag" style="left:${(t.frac * 100).toFixed(2)}%" data-action="tag-open" data-id="${esc(src.id)}" data-frac="${esc(t.frac)}" ${areaAttrs(t.area, t.note)} title="Your tag · ${esc(t.note)}"></span>`).join('');
  return `<div class="tl">
      <div class="tl-labels"><div class="tl-l ruler-l">${segSec ? 'TC' : 'SEG'}</div><div class="tl-l">Footage</div><div class="tl-l">Markers</div></div>
      <div class="tl-lanes" data-scrub="${esc(src.id)}" title="Click or drag to scrub through this camera's footage">
        <div class="tl-ruler">${ticks}</div>
        <div class="tl-lane">${clips}</div>
        <div class="tl-lane">${marks}${tagMarks}</div>
        ${(() => {
          const w = S.ovWatch && S.ovWatch.id === src.id ? S.ovWatch : null;
          const at = w ? w.start : pos;
          return at != null ? `<div class="playhead" id="ov-head" style="left:${(at * 100).toFixed(2)}%" title="${w ? 'What the viewer is playing' : 'Replay clock'}"></div>` : '';
        })()}
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
  if (S.route.name === 'overview' && !DRAG) VIEWS.overview.update($('#main'));  // tag bar follows the scrub
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

// ---------------------------------------------------------------- incident filter (Monitor scope = report scope)
const SEV_RANK = { low: 0, medium: 1, high: 2, critical: 3 };
const PERIODS = [['1h', 'Last hour'], ['today', 'Today'], ['all', 'All time'], ['custom', 'Custom range']];
const REDUCED_MOTION = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
const DEFAULT_FILTER = { cams: [], sev: 'low', period: 'all', since: '', until: '' };

function filterFromQuery(q) {
  const sev = q.get('sev'), period = q.get('period');
  return {
    cams: (q.get('cams') || '').split(',').filter(Boolean),
    sev: SEV_RANK[sev] != null ? sev : 'low',
    period: PERIODS.some(p => p[0] === period) ? period : 'all',
    since: q.get('since') || '', until: q.get('until') || '',
  };
}
function filterQuery(f) {
  const q = new URLSearchParams();
  if (f.cams.length) q.set('cams', f.cams.join(','));
  if (f.sev !== 'low') q.set('sev', f.sev);
  if (f.period !== 'all') q.set('period', f.period);
  if (f.period === 'custom') { if (f.since) q.set('since', f.since); if (f.until) q.set('until', f.until); }
  return q.toString();
}
const isoOrNull = v => { const d = v ? new Date(v) : null; return d && !isNaN(d) ? d.toISOString() : null; };
/** Presets are relative to now, so they resolve to absolute bounds at the moment of use. */
function filterRange(f) {
  if (f.period === '1h') return { since: new Date(Date.now() - 3600e3).toISOString(), until: null };
  if (f.period === 'today') { const d = new Date(); d.setHours(0, 0, 0, 0); return { since: d.toISOString(), until: null }; }
  if (f.period === 'custom') return { since: isoOrNull(f.since), until: isoOrNull(f.until) };
  return { since: null, until: null };
}
function applyFilter(list, f) {
  const { since, until } = filterRange(f);
  const lo = since ? Date.parse(since) : null, hi = until ? Date.parse(until) : null;
  const floor = SEV_RANK[f.sev] || 0;
  return list.filter(i => {
    if (f.cams.length && !f.cams.includes(i.source_id)) return false;
    if ((SEV_RANK[i.severity] || 0) < floor) return false;
    const t = Date.parse(i.created_at);
    if (lo != null && !(t >= lo)) return false;
    if (hi != null && !(t <= hi)) return false;
    return true;
  });
}
function reportRequest(f) {
  const r = filterRange(f);
  return { source_ids: f.cams, since: r.since, until: r.until, min_severity: f.sev };
}
function previewQuery(f) {
  const r = reportRequest(f), q = new URLSearchParams();
  if (r.source_ids.length) q.set('sources', r.source_ids.join(','));
  if (r.since) q.set('since', r.since);
  if (r.until) q.set('until', r.until);
  q.set('min_severity', r.min_severity);
  return q.toString();
}
function toLocalInput(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || isNaN(d)) return '';
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
/** A saved report's backend filter, as a Monitor filter (absolute range). */
function fromReportFilter(rf) {
  rf = rf || {};
  const ranged = rf.since || rf.until;
  return { cams: rf.source_ids || [], sev: rf.min_severity || 'low', period: ranged ? 'custom' : 'all',
    since: toLocalInput(rf.since), until: toLocalInput(rf.until) };
}
function fmtDateTime(iso) {
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function sevWords(bySev) {
  return ['critical', 'high', 'medium', 'low'].filter(k => bySev && bySev[k]).map(k => `${bySev[k]} ${k}`).join(', ');
}
function scopeText(rf) {
  const cams = rf.source_ids && rf.source_ids.length ? rf.source_ids.map(sourceLabel).join(', ') : 'All cameras';
  const period = rf.since || rf.until ? `${rf.since ? fmtDateTime(rf.since) : 'the start'} to ${rf.until ? fmtDateTime(rf.until) : 'now'}` : 'All time';
  const sev = rf.min_severity && rf.min_severity !== 'low' ? `${SEV_LABEL[rf.min_severity]}${rf.min_severity === 'critical' ? ' only' : ' and above'}` : 'Any severity';
  return { cams, period, sev };
}

function filterBarHTML(f, scope, { camera = true } = {}) {
  const cams = S.sources.filter(s => s.classification || s.status === 'monitoring' || f.cams.includes(s.id));
  const camVal = f.cams.length === 1 ? f.cams[0] : f.cams.length > 1 ? '__multi' : '';
  const opt = (v, label, on) => `<option value="${esc(v)}"${on ? ' selected' : ''}>${esc(label)}</option>`;
  return `<form class="filters" data-filter="${esc(scope)}" aria-label="Incident filter">
    ${camera ? `<label><span>Camera</span><select name="cam">${opt('', 'All cameras', !camVal)}
      ${f.cams.length > 1 ? opt('__multi', `${f.cams.length} cameras`, true) : ''}
      ${cams.map(s => opt(s.id, s.label || s.camera_id, camVal === s.id)).join('')}</select></label>` : ''}
    <label><span>Severity</span><select name="sev">${['low', 'medium', 'high', 'critical'].map(k =>
      opt(k, k === 'low' ? 'Any severity' : SEV_LABEL[k] + (k === 'critical' ? ' only' : ' and above'), f.sev === k)).join('')}</select></label>
    <label><span>Raised</span><select name="period">${PERIODS.map(([v, l]) => opt(v, l, f.period === v)).join('')}</select></label>
    ${f.period === 'custom' ? `<label><span>From</span><input type="datetime-local" name="since" value="${esc(f.since)}"></label>
      <label><span>To</span><input type="datetime-local" name="until" value="${esc(f.until)}"></label>` : ''}
  </form>`;
}
function readFilter(form, prev) {
  const fd = new FormData(form);
  const cam = fd.get('cam');
  return { cams: cam === null || cam === '__multi' ? prev.cams : cam ? [cam] : [], sev: fd.get('sev') || 'low', period: fd.get('period') || 'all',
    since: fd.get('since') || prev.since || '', until: fd.get('until') || prev.until || '' };
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
  const page = { overview: 'monitor', source: 'monitor', incident: 'monitor', search: 'search', report: 'report', new: 'new', live: 'live' }[S.route.name];
  const flags = st.flags || {};
  const shown = { new: MOCK || !!flags.upload || !!S.uploadEnabled, live: MOCK || !!flags.live };
  document.querySelectorAll('#pages button').forEach(b => {
    b.classList.toggle('active', b.dataset.page === page);
    if (b.dataset.page in shown) b.hidden = !shown[b.dataset.page];  // hide features disabled on this deployment
  });
}

/** A feed is a source you added (configured or monitoring); the rest of the archive lives in Search. */
const isFeed = src => !!src && !String(src.id).startsWith('upload-') && (['monitoring', 'configuring', 'configured', 'specializing'].includes(src.status) || !!AM[src.id]);
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

/** One camera's footage as a thin strip: incidents at their position in the footage, playhead at the replay clock. */
function watchStripHTML(src, incs) {
  const r = src.replay;
  const total = (r && r.total_segments) || src.segment_count || 0;
  const pos = r && total ? Math.min(1, (r.segment || 0) / total) : null;
  const marks = incs.filter(i => i.replay_pos != null).map(i =>
    `<span class="tl-mark ${esc(i.severity)}" style="left:${(i.replay_pos * 100).toFixed(2)}%" title="${esc(i.title)}"></span>`).join('');
  return `<span class="w-strip" aria-hidden="true">${marks}${pos != null ? `<span class="playhead" style="left:${(pos * 100).toFixed(2)}%"></span>` : ''}</span>`;
}

VIEWS.home = {
  mount(main) {
    main.innerHTML = `<div class="home">
      <section class="home-hero">
        <form class="ask" id="home-ask" role="search">
          <h1><label for="home-q">What happened?</label></h1>
          <p class="lede">Describe a moment in plain words. Sightline searches every indexed camera; you review what it flagged in Monitor, then turn it into a safety report.</p>
          <div class="ask-row"><input id="home-q" type="text" name="q" placeholder="car turning through a crosswalk with people in it" autocomplete="off">
            <button class="btn primary">Search</button></div>
          <div class="ask-chips" id="home-chips"></div>
        </form>
        <div class="home-clip" id="home-clip"></div>
      </section>
      ${pane('Cameras on watch', '', { id: 'home-watch', flush: true, right: '<span id="home-watch-meta"></span>' })}
      ${pane('Safety report', '', { id: 'home-report' })}
    </div>`;
    $('#home-ask', main).addEventListener('submit', e => {
      e.preventDefault();
      const q = String(new FormData(e.target).get('q') || '').trim();
      if (q) nav(`/search?q=${enc(q)}`);
      else $('#home-q', main).focus();
    });
  },
  update(main) {
    const incidents = sortIncidents(S.incidents);
    const watching = S.sources.filter(s => s.status === 'monitoring');

    const hints = [...new Set(incidents.map(i => i.search_hint || i.title).filter(Boolean))].slice(0, 4);
    setHTML($('#home-chips', main), hints.map(h => `<button type="button" class="chip-q" data-nav="/search?q=${enc(h)}">${esc(h)}</button>`).join(''));

    const lead = incidents.find(i => i.severity === 'critical' || i.severity === 'high') || incidents[0];
    const ev = lead && (lead.evidence || []).find(e => e.role === 'event');
    setHTML($('#home-clip', main), lead && ev ? `${player(ev, { autoplay: !REDUCED_MOTION, cam: lead.camera_id })}
        <div class="clip-cap">
          <div class="cc-title">${sevPill(lead.severity)}<span>${esc(lead.title)}</span></div>
          <div class="cc-meta">${esc(lead.camera_id || sourceLabel(lead.source_id))}, ${pct(lead.confidence && lead.confidence.value)} confidence, raised ${esc(clock(lead.created_at))}</div>
          <button class="btn" data-nav="/incident/${enc(lead.id)}">Review this incident</button>
        </div>`
      : `<div class="clip-empty">${watching.length
        ? `<p>Sightline is watching ${watching.length} camera${watching.length > 1 ? 's' : ''}. Incidents appear here as soon as one is raised.</p>`
        : `<p>No camera is being watched yet. Search the archive, then choose Add to Monitor on a result to start.</p>
           <button class="btn primary" data-nav="/search">Search the archive</button>`}</div>`);

    setHTML($('#home-watch-meta', main), watching.length ? `${watching.length} of ${S.sources.length} cameras` : '');
    setHTML($('#home-watch', main), watching.length ? watching.map(src => {
      const mine = incidents.filter(i => i.source_id === src.id);
      const c = src.incident_counts || {};
      const counts = ['critical', 'high', 'medium'].filter(k => c[k]).map(k => `<span class="sev ${k}"><i></i>${esc(c[k])}</span>`).join('');
      return `<button class="watch-row" data-nav="/monitor?cams=${enc(src.id)}">
          <span class="w-name">${esc(src.label || src.camera_id)}<span class="w-sub">${src.classification ? esc(cap(src.classification.domain)) : 'Not configured'}</span></span>
          ${watchStripHTML(src, mine)}
          <span class="w-count">${counts || '<span class="muted small">No incidents</span>'}</span>
        </button>`;
    }).join('') : '<div class="empty" style="padding:12px">No cameras on watch. Choose Add to Monitor on a search result to start.</div>');

    const n = applyFilter(incidents, S.filter).length;
    setHTML($('#home-report', main), `${filterBarHTML(S.filter, 'home')}
      <div class="report-go"><span class="small ${n ? '' : 'muted'}">${n ? `${n} incident${n > 1 ? 's' : ''} match` : 'No incidents match. Widen the period or lower the severity.'}</span>
        <button class="btn primary" data-nav="/report?${esc(filterQuery(S.filter))}">Start report</button></div>`);
  },
};

VIEWS.overview = {
  mount(main) {
    main.innerHTML = `<div id="ov-empty"></div>
      <div class="ws" id="ov-ws">
      <section class="pane viewer-pane">
        <header class="pane-h"><span class="pt" id="ov-title">Feed</span><span class="pr" id="ov-actions"></span></header>
        <div class="pane-b" id="ov-player"></div>
        <div class="transport" id="ov-transport"></div>
        <div id="ov-tagbar"></div>
      </section>
      <section class="pane side-pane">
        <header class="pane-h"><span class="pt">Incidents</span><span class="pr" id="ov-feed-meta"></span></header>
        <div id="ov-filter"></div>
        <div class="pane-b flush" id="ov-side"></div>
        <div class="ov-report" id="ov-report"></div>
      </section>
      <section class="pane timeline-pane">
        <header class="pane-h"><span class="pt">Timeline</span></header>
        <div class="pane-b flush" id="ov-timeline"></div>
      </section>
    </div>`;
  },
  async update(main) {
    if (!S.route.camPinned) {
      S.route.camPinned = true;
      const want = S.filter.cams[0];
      if (want && isFeed(sourceById(want))) { S.selected = want; S.scrub = null; }
    }
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
    if (S.filter.cams.length !== 1 || S.filter.cams[0] !== src.id) {
      if (S.filter.cams.length) S.route.from = '';  // switched away from the camera the search opened
      S.filter = S.route.filter = { ...S.filter, cams: [src.id] };
      history.replaceState(null, '', `#/monitor?${filterQuery(S.filter)}${S.route.from ? `&from=${enc(S.route.from)}` : ''}`);
    }
    const live = src.status === 'monitoring';
    const feedAll = sortIncidents(S.incidents.filter(i => i.source_id === src.id));
    const mine = applyFilter(feedAll, S.filter);
    const cl = src.classification;

    setHTML($('#ov-title', main), `${esc(src.label || src.camera_id)} <span class="tag" style="margin-left:6px">${esc(feedState(src))}</span>${cl ? `<span class="tag">${esc(cap(cl.domain))}</span>` : ''}`);
    setHTML($('#ov-actions', main), `<button class="btn" data-nav="/source/${enc(src.id)}">Details</button>
      ${live ? `<button class="btn" data-action="monitor-stop" data-id="${esc(src.id)}">Pause</button>` : addMonitorInline(src.id, true)}
      <button class="btn danger" data-action="remove-feed" data-id="${esc(src.id)}" title="Stop monitoring and clear this feed's incidents and configuration">Remove</button>`);

    const latest = mine[0];
    const ev = latest && (latest.evidence || []).find(e => e.role === 'event');
    const replay = live ? (src.replay || null) : null;
    const segTotal = (src.replay && src.replay.total_segments) || src.segment_count || 0;
    const watchStart = !segTotal ? null
      : S.scrub && S.scrub.id === src.id && S.scrub.seg ? Math.floor(S.scrub.frac * segTotal) / segTotal
      : latest && ev && latest.replay_pos != null ? latest.replay_pos
      : replay && replay.segment_uri ? (replay.segment || 0) / segTotal : null;
    S.ovWatch = watchStart == null ? null : { id: src.id, start: watchStart, span: 1 / segTotal, total: segTotal, segSec: src.segment_seconds || 5 };
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
    setHTML($('#ov-feed-meta', main), mine.length !== feedAll.length ? `${mine.length} of ${feedAll.length}` : `${mine.length}`);
    const from = S.route.from;
    setHTML($('#ov-filter', main), `${from ? `<button class="back from-search" data-nav="/search?q=${enc(from)}">← Results for “${esc(from)}”</button>` : ''}${filterBarHTML(S.filter, 'monitor', { camera: false })}`);
    try { S.tags[src.id] = await GET(`api/tags?source_id=${enc(src.id)}`); } catch (_) { /* optional */ }
    const tags = S.tags[src.id] || [];
    setHTML($('#ov-side', main), (mine.length ? `<div class="feed">${mine.map(i => feedItem(i, fresh.has(i.id))).join('')}</div>`
      : feedAll.length ? '<div class="empty" style="padding:12px">No incidents match this filter. Widen the period or lower the severity.</div>'
      : `<div class="empty" style="padding:12px">${live ? 'No incidents yet. Sightline is watching.' : 'Not monitoring this feed.'}</div>`)
      + (tags.length ? `<div class="side-h">Your tags</div><div class="feed">${tags.map(tg => tagItemHTML(tg, `data-action="tag-open" data-id="${esc(src.id)}" data-frac="${esc(tg.frac ?? 0)}"`)).join('')}</div>` : ''));
    const sc = S.scrub && S.scrub.id === src.id && S.scrub.seg ? S.scrub : null;
    setHTML($('#ov-tagbar', main), sc
      ? tagFormHTML({ source: src.id, video: '#ov-player video', segment: sc.seg.source_uri, tstart: sc.seg.t_start, tend: sc.seg.t_end, frac: sc.frac })
      : '<div class="tag-hint">To tag a moment yourself, drag the timeline to it.</div>');
    const n = mine.length;
    setHTML($('#ov-report', main), `<button class="btn primary" data-nav="/report?${esc(filterQuery(S.filter))}"${n ? '' : ' disabled'}>Build report from ${n === 1 ? 'this incident' : `these ${n} incidents`}</button>`);
    if (!DRAG) setHTML($('#ov-timeline', main), timelineHTML(src, mine, tags));
    syncOvHead();
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
        ${monitoring ? `<button class="btn" data-nav="/monitor?cams=${enc(d.id)}">Watch</button><button class="btn" data-action="monitor-stop" data-id="${esc(d.id)}">Pause</button>`
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
        <button class="back" data-nav="/monitor?${esc(filterQuery(S.filter))}">← Monitor</button>
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
      <div class="small muted" style="margin-top:8px">Find any moment in the VAST archive. On a camera that is already one of your feeds, <b>Review in Monitor</b> opens it with its incidents. On any other camera, <b>Add to Monitor</b>: Sightline works out what the feed shows, decides what to watch for, writes its own prompt and starts monitoring. No rules or queries to write.</div>`,
      { right: 'VAST hybrid search · Cosmos-Embed1' })}
      ${pane('Results', '<div class="empty">Describe a moment to find it, for example “forklift close to a worker”.</div>', { id: 'search-results' })}</div>`;
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
      if (!S.sources.length) {
        try {
          const [sources, incidents] = await Promise.all([GET('api/sources'), GET('api/incidents')]);
          S.sources = sources;
          S.incidents = dedupeIncidents(incidents);
        } catch (_) { /* buttons fall back to Add to Monitor */ }
      }
      const res = await GET(`api/search?q=${enc(q)}${source ? '&source=' + enc(source) : ''}`);
      const hits = Array.isArray(res) ? res : (res && res.results) || [];
      const watched = id => isFeed(sourceById(id));
      const review = id => `<div class="btn-row" style="margin-top:8px"><button class="btn primary" data-nav="/monitor?${esc(filterQuery({ ...DEFAULT_FILTER, cams: [id] }))}&from=${enc(q)}">Review in Monitor</button></div>`;
      box.innerHTML = hits.length ? `<div class="results">${hits.map(h => `<div class="rel">${player(h)}
        <div class="mono small" style="margin-top:4px">${esc(h.camera_id || '')} · ${esc(fmtTC(h.t_start))}${h.similarity != null ? ' · ' + pct(h.similarity) : ''}</div>
        <div>${esc(String(h.caption || '').slice(0, 200))}</div>
        ${!h.camera_id ? '' : watched(h.camera_id) ? review(h.camera_id) : addMonitorButton(h.camera_id, false, h.original_video)}</div>`).join('')}</div>`
        : `<div class="empty">No footage matched “${esc(q)}”${source ? ' on this camera' : ''}. Try fewer words, describe what is visible${source ? ', or search all cameras' : ''}.</div>`;
    } catch (e) { box.innerHTML = `<div class="empty">Search failed: ${esc(e.message)}. Check the VSS light in the top bar, then search again.</div>`; }
  },
};

// ----- safety report: scope + saved list on the left, the selected report summarized in the main pane
VIEWS.report = {
  seq: 0,
  busy: false,
  cache: {},
  shown: null,
  more: false,
  mount(main) {
    this.shown = null;
    this.more = false;
    main.innerHTML = `<div class="rp-layout">
      <div class="stack">
        ${pane('New report', '<div id="rb-filter"></div><div id="rb-count" class="rb-count"></div><div id="rb-actions"></div>')}
        ${pane('Saved reports', '<div class="empty" style="padding:12px">Loading…</div>', { id: 'rb-saved', flush: true })}
      </div>
      <section class="pane rp-view" id="rp-view"></section>
    </div>`;
  },
  async update(main) {
    setHTML($('#rb-filter', main), filterBarHTML(S.filter, 'report'));
    await Promise.all([this.preview(main), this.saved(main), this.view(main)]);
  },
  async preview(main) {
    const seq = ++this.seq;
    let p;
    try { p = await GET('api/reports/preview?' + previewQuery(S.filter)); }
    catch (e) { setHTML($('#rb-count', main), `<span class="muted">Could not count matching incidents: ${esc(e.message)}</span>`); return; }
    if (seq !== this.seq) return;
    const n = p.count || 0, st = p.stats || {};
    const cams = Object.keys(st.by_camera || {}).length;
    setHTML($('#rb-count', main), n
      ? `<b>${n} incident${n > 1 ? 's' : ''}</b> match: ${esc(sevWords(st.by_severity))}, on ${cams} camera${cams > 1 ? 's' : ''}.`
      : '<span class="muted">No incidents match. Widen the period or lower the severity.</span>');
    setHTML($('#rb-actions', main), this.busy
      ? `<div class="btn-row"><button class="btn primary" disabled>Generating report…</button></div><div class="small muted" style="margin-top:6px">Sightline is writing the summary, findings and recommended actions. This can take up to a minute.</div>`
      : `<div class="btn-row"><button class="btn primary" data-action="report-generate"${n ? '' : ' disabled'}>Generate report</button></div>`);
  },
  async saved(main) {
    let list;
    try { list = await GET('api/reports'); } catch (e) { setHTML($('#rb-saved', main), `<div class="empty" style="padding:12px">Saved reports unavailable: ${esc(e.message)}</div>`); return; }
    setHTML($('#rb-saved', main), list.length ? `<div class="feed">${list.map(r => {
      const sc = scopeText(r.filter || {});
      const n = (r.stats && r.stats.total) || 0;
      return `<div class="feed-item ${r.id === S.route.id ? 'on' : ''}" data-action="report-open" data-id="${esc(r.id)}" aria-current="${r.id === S.route.id}">
        <span class="sev-dot ${r.stats && r.stats.by_severity && r.stats.by_severity.critical ? 'critical' : ''}"></span>
        <div style="min-width:0"><div class="ft">${esc(r.title || 'Safety report')}</div>
          <div class="fs">${n} incident${n === 1 ? '' : 's'} · ${esc(sc.period)} · ${esc(sc.sev)}${r.mode === 'rules_only' ? ' · rules-only' : ''}</div></div>
        <span class="fs">${esc(fmtDateTime(r.generated_at))}</span></div>`;
    }).join('')}</div>` : '<div class="empty" style="padding:12px">No reports yet. Set a scope and choose Generate report.</div>');
  },
  async view(main) {
    const box = $('#rp-view', main);
    const id = S.route.id;
    if (!id) {
      setHTML(box, `<div class="rp-empty"><div class="big">No report open</div>
        <p>Pick a saved report, or set a scope and choose Generate report. The summary opens here.</p></div>`);
      return;
    }
    if (!this.cache[id]) {
      if (this.shown !== id) setHTML(box, '<div class="rp-empty"><p>Loading report…</p></div>');
      try { this.cache[id] = await GET(`api/reports/${enc(id)}`); }
      catch (e) { setHTML(box, `<div class="rp-empty"><div class="big">Report unavailable</div><p>${esc(e.message)}</p></div>`); return; }
      if (S.route.id !== id) return;
    }
    if (this.shown !== id) { this.shown = id; this.more = false; }
    setHTML(box, reportSummaryHTML(this.cache[id], this.more));
  },
  open(id) {
    if (S.route.name !== 'report') { nav('/report/' + enc(id)); return; }
    S.route.id = id;
    const q = filterQuery(S.filter);
    history.replaceState(null, '', `#/report/${enc(id)}${q ? '?' + q : ''}`);
    const main = $('#main');
    this.saved(main);
    this.view(main);
  },
  async generate() {
    if (this.busy) return;
    this.busy = true;
    const main = $('#main');
    this.preview(main);
    try {
      const { job_id } = await POST('api/reports', reportRequest(S.filter));
      const rep = await waitJob(job_id, 150000);
      if (!rep || !rep.id) throw new Error('the report job returned nothing');
      this.cache[rep.id] = rep;
      toast('Report generated', 'info');
      this.open(rep.id);
    } finally {
      this.busy = false;
      this.preview(main);
    }
  },
};

const REPORT_LIST_MAX = 6;

/** The report as a workspace summary: scope, counts, narrative, cited findings and actions, incidents. */
function reportSummaryHTML(r, more) {
  const incs = r.incidents || [];
  const num = new Map(incs.map((i, k) => [i.id, k + 1]));
  const sc = scopeText(r.filter || {});
  const st = r.stats || {};
  const bySev = st.by_severity || {};
  const cams = Object.keys(st.by_camera || {});
  const refs = ids => {
    const list = [...new Set(ids || [])].filter(id => num.has(id)).sort((a, b) => num.get(a) - num.get(b));
    return list.length ? `<span class="rp-refs">${list.map(id => {
      const i = incs[num.get(id) - 1];
      return `<button class="rp-ref ${esc(i.severity)}" data-nav="/incident/${enc(id)}" title="${esc(i.title)}">#${num.get(id)}</button>`;
    }).join('')}</span>` : '';
  };
  const fig = (n, label, cls = '') => `<div class="rp-fig ${cls}"><b>${esc(n)}</b><span>${esc(label)}</span></div>`;
  const shown = more ? incs : incs.slice(0, REPORT_LIST_MAX);
  const monitorCam = cams.length === 1 ? cams[0] : null;
  const by = r.mode === 'rules_only' ? 'Written from the incident records (no language model)' : `Written by Sightline with ${r.model || 'a language model'}`;

  return `<header class="pane-h"><span class="pt">Report</span><span class="pr mono">${esc(r.id)}</span></header>
    <div class="rp-body">
      <div class="rp-head">
        <div class="grow">
          <h2>${esc(r.title || 'Safety report')}</h2>
          <div class="rp-meta">${esc(sc.cams)} · raised ${esc(sc.period.toLowerCase() === 'all time' ? 'any time' : sc.period)} · ${esc(sc.sev)}</div>
          <div class="rp-meta">Generated ${esc(fmtDateTime(r.generated_at))} · ${esc(by)}</div>
        </div>
        ${monitorCam ? `<button class="btn" data-nav="/monitor?${esc(filterQuery({ ...fromReportFilter(r.filter), cams: [monitorCam] }))}">Review in Monitor</button>` : ''}
      </div>
      <div class="rp-figs">
        ${fig(st.total || 0, st.total === 1 ? 'incident' : 'incidents')}
        ${['critical', 'high', 'medium', 'low'].filter(k => bySev[k]).map(k => fig(bySev[k], SEV_LABEL[k].toLowerCase(), k)).join('')}
        ${fig(cams.length, cams.length === 1 ? 'camera' : 'cameras')}
      </div>
      <p class="rp-summary">${esc(r.summary || '')}</p>
      ${(r.findings || []).length || (r.recommendations || []).length ? `<div class="rp-cols">
        <section><h3>Findings</h3>${(r.findings || []).length ? `<ul class="rp-list">${r.findings.map(f =>
          `<li><span>${esc(f.statement)}</span>${refs(f.incident_ids)}</li>`).join('')}</ul>` : '<div class="muted small">No findings.</div>'}</section>
        <section><h3>Recommended actions</h3>${(r.recommendations || []).length ? `<ul class="rp-list">${r.recommendations.map(a =>
          `<li><span>${esc(a.action)}</span>${refs(a.incident_ids)}</li>`).join('')}</ul>` : '<div class="muted small">No actions.</div>'}</section>
      </div>` : ''}
      ${incs.length ? `<section class="rp-incs"><h3>Incidents <span class="muted">${incs.length}</span></h3>
        <div class="feed">${shown.map(i => `<div class="feed-item" data-nav="/incident/${enc(i.id)}">
          <span class="sev-dot ${esc(i.severity)}"></span>
          <div style="min-width:0"><div class="ft"><span class="rp-num">#${num.get(i.id)}</span>${esc(i.title)}</div>
            <div class="fs">${esc(sourceLabel(i.camera_id || i.source_id))} · raised ${esc(fmtDateTime(i.created_at))}</div></div>
          <span class="fc">${i.confidence != null ? pct(i.confidence) : ''}</span></div>`).join('')}</div>
        ${incs.length > REPORT_LIST_MAX ? `<button class="linkbtn rp-more" data-action="report-more">${more ? 'Show fewer' : `Show all ${incs.length} incidents`}</button>` : ''}
      </section>` : '<div class="muted">No incidents matched this scope.</div>'}
    </div>`;
}

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
    if (file.size > 25 * 1048576) toast(`This file is ${(file.size / 1048576).toFixed(0)} MB. On venue Wi-Fi that can take minutes; a 720p export uploads about 10× faster.`, 'info');
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
      ${f.sid ? tagFormHTML({ source: f.sid, video: '#nf-video' }) : ''}
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
      const btn = $('[data-action="nf-submit"]', main);
      const r = MOCK ? await POST('api/newsource', fd, true) : await uploadWithProgress('api/newsource', fd, p => {
        if (btn) { btn.disabled = true; btn.textContent = p < 1 ? `Uploading ${Math.round(p * 100)}%…` : 'Uploaded · Sightline is starting'; }
      });
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
    S.fresh.dur = dur;
    setHTML($('#nf-markers'), clipTimelineHTML(dur, v.windows || [], marks, up.status === 'done'));
    syncClipHead();
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
        ${pane('Markers on the timeline', marks.length ? `<div class="feed">${marks.map(m => m.status === 'tagged' ? tagItemHTML({ id: m.tag_id, note: m.title, t: m.t, check: m.check, area: m.area }, `data-action="nf-seek" data-t="${esc(m.t)}"`) : `<div class="feed-item" ${m.incident_id ? `data-nav="/incident/${enc(m.incident_id)}"` : `data-action="nf-seek" data-t="${esc(m.t_start ?? m.t)}"`}>
            <span class="sev-dot ${esc(m.status === 'incident' ? (m.severity || 'medium') : 'low')}"></span>
            <div style="min-width:0"><div class="ft">${esc(m.title)}</div><div class="fs">${esc(fmtT(m.t_start))}–${esc(fmtT(m.t_end))} · ${esc(m.status)}</div></div>
            <span class="fc">${m.confidence != null ? pct(m.confidence) : ''}</span></div>`).join('')}</div>` : '<div class="empty" style="padding:12px">No markers yet.</div>', { flush: true })}
      </div>
      <div style="margin-top:6px">${pane('Analysis versions', evolutionHTML(v.evolution))}</div>` : '');
  },
};

// ----- uploaded clip timeline: same layout as a feed's (TC ruler, footage, markers); seeks the clip's video
const fmtClipT = (sec, dur) => dur < 60 ? `0:${(Math.max(0, sec)).toFixed(1).padStart(4, '0')}` : fmtTC(sec).slice(0, 8);
function clipTimelineHTML(dur, windows, marks, analyzed) {
  const ticks = Array.from({ length: 9 }, (_, i) =>
    `<span class="tl-tick" style="left:${(i * 12.5).toFixed(2)}%">${esc(fmtClipT(dur * i / 8, dur))}</span>`).join('');
  const wins = windows.length ? windows : Array.from({ length: Math.min(28, Math.max(4, Math.ceil(dur / 2))) }, (_, i, a) => ({ t_start: dur * i / a.length, t_end: dur * (i + 1) / a.length }));
  const clips = wins.map(w => {
    const a = Math.max(0, w.t_start / dur), b = Math.min(1, (w.t_end ?? w.t_start) / dur);
    return `<span class="tl-clip ${analyzed ? 'done' : ''}" style="left:calc(${(a * 100).toFixed(2)}% + 1px);width:calc(${(Math.max(0.005, b - a) * 100).toFixed(2)}% - 2px)" title="${esc(fmtT(w.t_start))}–${esc(fmtT(w.t_end))}"></span>`;
  }).join('');
  const mk = marks.map(m => `<span class="tl-mark ${esc(m.status === 'tagged' ? 'tag' : m.status === 'incident' ? (m.severity || 'medium') : 'low')}" style="left:${Math.min(100, 100 * (m.t || 0) / dur).toFixed(2)}%;${m.status === 'rejected' ? 'opacity:.35;' : ''}" data-action="nf-seek" data-t="${esc(m.t_start ?? m.t)}" ${areaAttrs(m.area, m.title)} title="${esc(fmtT(m.t))} · ${esc(m.title)} · ${esc(m.status === 'tagged' ? 'your tag' : m.status)}${m.confidence != null ? ' · ' + pct(m.confidence) : ''}"></span>`).join('');
  const n = { incident: 0, tagged: 0 };
  marks.forEach(m => { if (n[m.status] != null) n[m.status]++; });
  return `<div class="tl" style="margin-top:8px">
      <div class="tl-labels"><div class="tl-l ruler-l">TC</div><div class="tl-l">Footage</div><div class="tl-l">Markers</div></div>
      <div class="tl-lanes" data-seek="1" title="Click or drag to move through the clip">
        <div class="tl-ruler">${ticks}</div>
        <div class="tl-lane">${clips}</div>
        <div class="tl-lane">${mk}</div>
        <div class="playhead" id="nf-head" style="left:0%"></div>
      </div>
    </div>
    <div class="tl-foot">Uploaded clip · <span id="nf-tc">${esc(fmtClipT(0, dur))}</span> / ${esc(fmtClipT(dur, dur))} · ${wins.length} analysis windows · ${n.incident} incident(s) · ${n.tagged} tag(s) · click or drag the timeline to scrub · click a marker to jump to it</div>`;
}
function syncOvHead() {
  const w = S.ovWatch, head = $('#ov-head');
  if (!w || !head || DRAG) return;
  const v = $('#ov-player video');
  const p = v && v.duration ? Math.min(1, v.currentTime / v.duration) : 0;
  head.style.left = (Math.min(1, w.start + p * w.span) * 100).toFixed(3) + '%';
  const tc = $('#ov-transport .tc');
  if (tc && v) tc.textContent = fmtTC((w.start * w.total + p) * w.segSec);
}
function syncClipHead() {
  const v = $('#nf-video'), head = $('#nf-head'), dur = (S.fresh && S.fresh.dur) || (v && v.duration) || 0;
  if (!v || !head || !dur) return;
  head.style.left = Math.min(100, 100 * v.currentTime / dur).toFixed(2) + '%';
  const tc = $('#nf-tc');
  if (tc) tc.textContent = fmtClipT(v.currentTime, dur);
}
let SEEK = null;
function seekFrac(e) {
  const r = SEEK.getBoundingClientRect();
  return Math.max(0, Math.min(1, (e.clientX - r.left) / (r.width || 1)));
}
function seekTo(f) {
  const v = $('#nf-video'), dur = (S.fresh && S.fresh.dur) || (v && v.duration) || 0;
  if (!v || !dur) return;
  v.currentTime = Math.min(dur - 0.05, f * dur);
  syncClipHead();
}
document.addEventListener('pointerdown', e => {
  const lanes = e.target.closest('.tl-lanes[data-seek]');
  if (!lanes || e.target.closest('.tl-mark') || e.button !== 0) return;
  e.preventDefault();
  SEEK = lanes;
  const v = $('#nf-video');
  if (v) v.pause();
  seekTo(seekFrac(e));
});
document.addEventListener('pointermove', e => { if (SEEK) seekTo(seekFrac(e)); });
document.addEventListener('pointerup', () => { SEEK = null; });
// Media events don't bubble; capture them on the document. The upload page and the Monitor viewer
// each move their timeline's playhead with the video that is playing.
const headSync = t => t && t.id === 'nf-video' ? syncClipHead : t && t.closest && t.closest('#ov-player') ? syncOvHead : null;
['timeupdate', 'seeked', 'loadedmetadata'].forEach(ev => document.addEventListener(ev, e => { const f = headSync(e.target); if (f) f(); }, true));
document.addEventListener('play', e => {
  const f = headSync(e.target), v = e.target;
  if (!f) return;
  (function tick() { f(); if (!v.paused && !v.ended && v.isConnected) requestAnimationFrame(tick); })();
}, true);

function uploadWithProgress(path, fd, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', new URL(path, document.baseURI));
    x.upload.onprogress = e => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    x.upload.onload = () => onProgress(1);
    x.onload = () => {
      let j = null;
      try { j = JSON.parse(x.responseText); } catch (_) { /* not json */ }
      if (x.status >= 200 && x.status < 300) resolve(j);
      else reject(new Error(`${x.status} ${(j && j.detail) || x.statusText || 'upload failed'}`));
    };
    x.onerror = () => reject(new Error('network error (connection dropped during upload)'));
    x.send(fd);
  });
}

// ----- manual tags: a person marks a moment and says what happened; Sightline takes its own look
function tagFormHTML(o) {
  const attrs = Object.entries(o).filter(([, v]) => v != null).map(([k, v]) => `data-${k}="${esc(v)}"`).join(' ');
  return `<form class="tagbar" data-tag-form ${attrs}>
    <input name="note" maxlength="300" autocomplete="off" placeholder="Something happened here? Describe what you saw">
    <button type="button" class="btn" data-action="tag-area" title="Drag a box on the video around where Sightline should look">Mark area</button>
    <button class="btn">Tag this moment</button></form>`;
}
function tagCheckHTML(c) {
  c = c || {};
  if (c.status === 'checking') return '<span class="muted">Sightline is taking a look…</span>';
  if (c.status === 'skipped') return `<span class="muted">${esc(c.text || 'Sightline could not look at this clip')}</span>`;
  if (!c.verdict) return '';
  const cls = c.verdict === 'YES' ? 'ok' : c.verdict === 'NO' ? 'bad' : 'muted';
  return `<span class="tag-verdict ${cls}">Sightline: ${esc(c.verdict === 'YES' ? 'sees it' : c.verdict === 'NO' ? "doesn't see it" : 'unclear')}</span> <span class="muted">${esc(c.text || '')}</span>`;
}
function tagItemHTML(tg, openAttr) {
  const when = tg.t != null ? fmtT(tg.t) : (tg.t_start != null ? fmtTC(tg.t_start).slice(0, 8) : '');
  return `<div class="feed-item tag-item" ${openAttr || ''} ${areaAttrs(tg.area, tg.note)}>
    <span class="sev-dot tag"></span>
    <div style="min-width:0"><div class="ft">${esc(tg.note)}</div><div class="fs">Tagged by you${when ? ' · ' + esc(when) : ''}${tg.area ? ' · look at the ' + esc(areaWords(tg.area)) : ''}</div>
    <div class="fs">${tagCheckHTML(tg.check)}</div></div>
    <button class="linkbtn" data-action="tag-remove" data-id="${esc(tg.id)}" title="Remove this tag">✕</button></div>`;
}

// ----- "look here": the person drags a box on the frame; it travels with the tag and steers Sightline's look
const areaAttrs = (a, note) => a ? `data-area="${esc(JSON.stringify(a))}" data-note="${esc(note || '')}"` : '';
function areaWords(a) {
  const cx = a.x + a.w / 2, cy = a.y + a.h / 2;
  const h = cx < 1 / 3 ? 'left' : cx > 2 / 3 ? 'right' : 'center';
  const v = cy < 1 / 3 ? 'upper' : cy > 2 / 3 ? 'lower' : 'middle';
  return v === 'middle' && h === 'center' ? 'center' : `${v} ${h}`;
}
function videoContentRect(v) {
  const W = v.clientWidth, H = v.clientHeight, vw = v.videoWidth || 16, vh = v.videoHeight || 9;
  const sc = Math.min(W / vw, H / vh);
  return { left: (W - vw * sc) / 2, top: (H - vh * sc) / 2, width: vw * sc, height: vh * sc };
}
function areaLayer(v) {
  const host = v.closest('.player');
  let layer = host.querySelector('.area-layer');
  if (!layer) { layer = document.createElement('div'); layer.className = 'area-layer'; host.appendChild(layer); }
  return layer;
}
function drawArea(v, a, label) {
  const layer = areaLayer(v);
  layer.querySelectorAll('.area-box').forEach(b => b.remove());
  if (!a) return layer;
  const r = videoContentRect(v), b = document.createElement('div');
  b.className = 'area-box';
  Object.assign(b.style, { left: r.left + a.x * r.width + 'px', top: r.top + a.y * r.height + 'px', width: a.w * r.width + 'px', height: a.h * r.height + 'px' });
  if (label) { const sp = document.createElement('span'); sp.textContent = label; b.appendChild(sp); }
  layer.appendChild(b);
  return layer;
}
function showArea(v, a, label) {
  if (!v) return;
  if (a && !v.videoWidth) { v.addEventListener('loadedmetadata', () => drawArea(v, a, label), { once: true }); return; }
  drawArea(v, a, label);
}
function startAreaDraw(form) {
  const v = $(form.dataset.video || '#nf-video');
  if (!v) { toast('No video to mark'); return; }
  v.pause();
  const layer = drawArea(v, null);
  layer.classList.add('drawing');
  toast('Drag a box around where Sightline should look', 'info');
  let start = null, box = null;
  const pt = e => {
    const lr = layer.getBoundingClientRect(), r = videoContentRect(v);
    return { x: Math.max(0, Math.min(1, (e.clientX - lr.left - r.left) / r.width)), y: Math.max(0, Math.min(1, (e.clientY - lr.top - r.top) / r.height)) };
  };
  layer.onpointerdown = e => { e.preventDefault(); start = pt(e); layer.setPointerCapture(e.pointerId); };
  layer.onpointermove = e => {
    if (!start) return;
    const p = pt(e);
    box = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) };
    drawArea(v, box);
  };
  layer.onpointerup = () => {
    layer.onpointerdown = layer.onpointermove = layer.onpointerup = null;
    layer.classList.remove('drawing');
    if (!box || box.w < 0.02 || box.h < 0.02) { drawArea(v, null); toast('Box too small; press Mark area and drag again'); return; }
    box = Object.fromEntries(Object.entries(box).map(([k, n]) => [k, Math.round(n * 1000) / 1000]));
    S.tagArea = { form, box };
    drawArea(v, box, 'Sightline looks here');
    const b = form.querySelector('[data-action="tag-area"]');
    if (b) b.textContent = `Area: ${areaWords(box)}`;
    form.note.focus();
  };
}

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
  if (parts[0] === 'monitor') return { name: 'overview', filter: filterFromQuery(q), from: q.get('from') || '' };
  if (parts[0] === 'report') return { name: 'report', id: parts[1] ? decodeURIComponent(parts[1]) : null, filter: filterFromQuery(q) };
  if (parts[0] === 'new') return { name: 'new' };
  if (parts[0] === 'live') return { name: 'live' };
  return { name: 'home' };
}
// Set only the hash: with a runtime <base>, href="#..." links would navigate to the base URL instead.
function nav(path) { location.hash = '#' + path; }

async function render() {
  if (S.route.name === 'live') VIEWS.live.stop();
  S.route = parseRoute();
  if (S.route.filter) S.filter = S.route.filter;
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
  'open-feed': el => { S.selected = el.dataset.id; S.scrub = null; const m = $('#main'); if (S.route.name === 'overview' && m) VIEWS.overview.update(m); else nav('/monitor'); },
  'open-upload': el => { S.fresh = { sid: el.dataset.sid }; if (S.route.name === 'new') { VIEWS.new.mount($('#main')); VIEWS.new.update($('#main')); } else nav('/new'); },
  'remove-feed': async el => {
    if (!armed(el, 'Click again to remove')) return;
    await DEL(`api/feeds/${enc(el.dataset.id)}`);
    if (S.selected === el.dataset.id) S.selected = null;
    S.scrub = null;
    toast('Feed removed. Its footage stays searchable in the archive.', 'info');
    if (S.route.name !== 'overview') nav('/monitor');
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
    nav('/monitor');
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
  'nf-seek': el => {
    const v = $('#nf-video');
    if (!v) return;
    v.currentTime = Number(el.dataset.t) || 0;
    if (el.dataset.area) { v.pause(); showArea(v, JSON.parse(el.dataset.area), el.dataset.note); }
    else { drawArea(v, null); v.play().catch(() => {}); }
  },
  'tag-remove': async el => {
    await DEL(`api/tags/${enc(el.dataset.id)}`);
    toast('Tag removed', 'info');
    const m = $('#main');
    if (S.route.name === 'new') VIEWS.new.update(m); else if (S.route.name === 'overview') VIEWS.overview.update(m);
  },
  'tag-open': async el => {
    await scrubCommit(el.dataset.id, Number(el.dataset.frac) || 0);
    if (el.dataset.area) showArea($('#ov-player video'), JSON.parse(el.dataset.area), el.dataset.note);
  },
  'tag-area': el => startAreaDraw(el.closest('form')),
  'nf-open': el => { S.fresh = { sid: el.dataset.sid }; VIEWS.new.showPreview($('#main')); },
  'live-start': () => VIEWS.live.start(),
  'live-stop': () => VIEWS.live.stop(),
  'report-generate': () => VIEWS.report.generate(),
  'report-open': el => VIEWS.report.open(el.dataset.id),
  'report-more': () => { VIEWS.report.more = !VIEWS.report.more; VIEWS.report.view($('#main')); },
};

/** Filter forms (Monitor, Report, Home): keep the URL in step without a hashchange remount. */
document.addEventListener('change', e => {
  const form = e.target.closest && e.target.closest('form[data-filter]');
  if (!form) return;
  S.filter = readFilter(form, S.filter);
  const scope = form.dataset.filter;
  const main = $('#main');
  if (scope === 'monitor') {
    const from = S.route.from ? `&from=${enc(S.route.from)}` : '';
    history.replaceState(null, '', `#/monitor?${filterQuery(S.filter)}${from}`);
    S.route.filter = S.filter;
    VIEWS.overview.update(main);
  } else if (scope === 'report') {
    const q = filterQuery(S.filter);
    history.replaceState(null, '', `#/report${S.route.id ? '/' + enc(S.route.id) : ''}${q ? '?' + q : ''}`);
    S.route.filter = S.filter;
    VIEWS.report.update(main);
  } else if (scope === 'home') {
    VIEWS.home.update(main);
  }
  const again = e.target.name && document.querySelector(`form[data-filter="${scope}"] [name="${CSS.escape(e.target.name)}"]`);
  if (again && again !== document.activeElement) again.focus();
});

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

document.addEventListener('submit', async e => {
  const f = e.target.closest('form[data-tag-form]');
  if (!f) return;
  e.preventDefault();
  const note = (f.note.value || '').trim();
  if (!note) { f.note.focus(); return; }
  const d = f.dataset, body = { source_id: d.source, note };
  if (d.segment) Object.assign(body, { segment: d.segment, t_start: Number(d.tstart), t_end: Number(d.tend), frac: Number(d.frac) });
  else { const v = $('#nf-video'); body.t = v ? v.currentTime : 0; }
  if (S.tagArea && S.tagArea.form === f) body.area = S.tagArea.box;
  try {
    await POST('api/tags', body);
    f.note.value = '';
    S.tagArea = null;
    const ab = f.querySelector('[data-action="tag-area"]');
    if (ab) ab.textContent = 'Mark area';
    toast('Tagged. Sightline is taking its own look.', 'info');
    const m = $('#main');
    if (S.route.name === 'new') VIEWS.new.update(m); else if (S.route.name === 'overview') VIEWS.overview.update(m);
  } catch (err) { toast('Tag failed: ' + err.message); }
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
    if (S.offline) toast('Backend reachable again', 'info');
    S.offline = false;
    // A display bug must not look like an outage or stop the other panes from updating.
    const v = VIEWS[S.route.name];
    for (const [name, fn] of [['top bar', renderTop], ['sidebar', renderSidebar], ['page', async () => { if (v && v.update) await v.update($('#main')); }]]) {
      try { await fn(); } catch (err) { console.error(`Sightline: ${name} render failed`, err); }
    }
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
