'use strict';
/* Sightline UI. Talks only to our backend's internal API (planning/ARCHITECTURE.md §5),
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

/** Replace innerHTML only when it changed, so playing videos and scroll positions survive polling. */
function setHTML(el, html) {
  if (el && el._html !== html) { el.innerHTML = html; el._html = html; }
}

function toast(msg, kind = 'error') {
  const box = $('#toast');
  const d = document.createElement('div');
  d.className = kind;
  d.textContent = msg;
  box.appendChild(d);
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

// ---------------------------------------------------------------- shared renderers
const SIGNAL = { critical: 'Danger', high: 'Warning', medium: 'Caution', low: 'Notice' };
const ALERT_SVG = '<svg viewBox="0 0 14 12" aria-hidden="true"><path d="M7 .4 13.6 11.6H.4Z" fill="currentColor"/><path class="bang" d="M7 4.3v3.4M7 9.6v.1"/></svg>';
function sevPill(sev) {
  const k = SIGNAL[sev] ? sev : 'low';
  return `<span class="sev ${k}" title="${esc(k)} severity">${k === 'low' ? '' : ALERT_SVG}${SIGNAL[k]}</span>`;
}
/** Cosmos captions with the FLAGS line Sightline asked for highlighted as evidence. */
function captionHTML(text) { return esc(text).replace(/(FLAGS:[^\n]*)/, '<mark>$1</mark>'); }
function fmtTC(v) {
  if (v == null || isNaN(v)) return '';
  const s = Math.max(0, Math.round(Number(v)));
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map(n => String(n).padStart(2, '0')).join(':');
}
function camOf(ev) {
  if (!ev) return '';
  if (ev.camera_id) return ev.camera_id;
  const parts = String(ev.segment || '').split('/').filter(Boolean);
  return parts.length > 2 ? parts[parts.length - 2] : '';
}

function player(ev, { badge = '', autoplay = false, overlay = '', controls = true, cam = '' } = {}) {
  const src = clipSrc(ev);
  const inner = src
    ? `<video src="${esc(src)}" preload="metadata" muted playsinline ${controls ? 'controls' : ''} ${autoplay ? 'autoplay loop' : ''}></video>`
    : `<div class="ph"><div><div class="big">${MOCK ? 'Mock clip' : 'Clip unavailable'}</div><div class="small">${esc(shortSeg(ev && ev.segment))}</div></div></div>`;
  const camId = cam || camOf(ev);
  const osd = ev || badge ? `<div class="osd"><span>${camId ? 'CAM ' + esc(camId) : ''}</span><span>${badge ? `<span class="ev">● ${esc(badge)}</span> ` : ''}${ev && ev.t_start != null ? esc(fmtTC(ev.t_start)) : ''}</span></div>` : '';
  return `<div class="player">${inner}${osd}${overlay ? `<div class="overlay">${overlay}</div>` : ''}</div>`;
}

function yoloTags(y) {
  if (!y || !y.classes) return '';
  return Object.entries(y.classes).map(([k, v]) => `<span class="tag" title="YOLO11 max count in this segment">${esc(k)} ×${esc(v)}</span>`).join('');
}

const STEP_LABELS = {
  classify: 'Scene classified',
  plan: 'Monitoring plan generated',
  prompt: 'Specialized Cosmos prompt written',
  reingest: 'Footage re-analyzed (VAST re-ingest)',
  monitor: 'Monitoring',
  detect: 'Potential events evaluated',
  investigate: 'Investigations',
  incident: 'Incidents raised',
};
const STEP_ICON = { done: '✓', running: '◐', failed: '✕', skipped: '–', pending: '' };

function pipelineHTML(run, horizontal) {
  const steps = (run && run.steps) || [];
  if (!steps.length) return `<div class="empty">Not configured yet. Sightline hasn't looked at this source.</div>`;
  return `<div class="steps${horizontal ? ' h' : ''}">${steps.map(st => `
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
  return `<div class="feed-item ${isNew ? 'new' : ''}" data-nav="/incident/${enc(inc.id)}">
    <span>${sevPill(inc.severity)}</span>
    <div><div class="ft">${esc(inc.title)}</div>
      <div class="fs">${esc(sourceLabel(inc.source_id))} · video ${esc(fmtT(inc.peak_at ?? inc.started_at))}${inc.mode === 'rules_only' ? ' · rules-only' : ''}${inc.created_at ? ' · ' + esc(clock(inc.created_at)) : ''}</div></div>
    <div class="fc" title="${esc('Confidence components: ' + comps)}"><b>${pct(inc.confidence && inc.confidence.value)}</b><br>${esc(inc.investigation && inc.investigation.verdict || '')}</div>
  </div>`;
}

function sourceById(id) { return S.sources.find(s => s.id === id); }
function sourceLabel(id) { const s = sourceById(id); return s ? (s.label || s.camera_id) : id; }
function domainOf(src) { return src && src.classification ? src.classification.domain : null; }

function sortIncidents(list) {
  return [...list].sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
}

// ---------------------------------------------------------------- top bar + sidebar
function renderTop() {
  const st = S.status || {};
  const monitoring = S.sources.filter(s => s.status === 'monitoring').length;
  const speed = st.replay && st.replay.speed;
  setHTML($('#monitor-state'), monitoring
    ? `<span class="pulse"></span><span><b>MONITORING</b> ${monitoring} source${monitoring > 1 ? 's' : ''}</span>
       <span class="chip" title="Indexed archive footage replayed in chronological order. This is not a live camera feed.">Archive replay${speed ? ' ' + esc(speed) + '×' : ''}</span>`
    : `<span class="pulse off"></span><span>Idle. No source is being monitored.</span>`);

  const chip = (name, ok, title, warn) => `<span class="chip ${ok == null ? '' : ok ? (warn ? 'warn' : 'ok') : 'bad'}" title="${esc(title)}"><span class="dot"></span>${name}</span>`;
  const gpu = st.gpu || {};
  const gpuOk = gpu.cosmos ? (gpu.cosmos.ok && (!gpu.yolo || gpu.yolo.ok)) : null;
  const llm = st.llm || {};
  const state = st.state || {};
  let html = '';
  if (MOCK) html += `<span class="chip mock" title="UI is running on mock.js data, not the real backend">MOCK DATA</span>`;
  if (state.data_origin === 'seed') html += `<span class="chip cached" title="Backend is serving a saved snapshot">Cached snapshot ${esc(clock(state.snapshot_at))}</span>`;
  html += chip('VSS', st.vss ? st.vss.ok : null, (st.vss && st.vss.detail) || 'VAST video search backend');
  html += chip('GPU', gpuOk, 'Cosmos3-Reason, YOLO11, Embed1 endpoints on CoreWeave');
  html += chip('LLM', st.llm ? llm.ok : null, `W&B Inference${llm.model ? ': ' + llm.model : ''}${llm.mode === 'rules_only' ? ' (rules-only fallback active)' : ''}`, llm.mode === 'rules_only');
  html += chip('STATE', st.state ? true : null, state.backend === 'vastdb' ? 'Sightline memory persisted in VastDB (schema "sightline")' : 'State is local only (not persisted to VastDB)', state.backend !== 'vastdb');
  if (!st.vss && !MOCK) html += `<span class="chip bad" title="api/status unreachable"><span class="dot"></span>OFFLINE</span>`;
  setHTML($('#health'), html);
}

function renderSidebar() {
  const st = S.status || {};
  const flags = st.flags || {};
  const sel = sourceById(S.selected);
  const activeId = S.route.name === 'source' ? S.route.id : S.selected;
  const items = S.sources.map((src, idx) => {
    const c = src.incident_counts || {};
    const n = (c.critical || 0) + (c.high || 0) + (c.medium || 0) + (c.low || 0);
    const hot = (c.critical || 0) + (c.high || 0) > 0;
    const cl = src.classification;
    return `<div class="src ${src.id === activeId ? 'active' : ''}" data-nav="/source/${enc(src.id)}" title="${esc(src.status || '')}">
      <span class="ch">CH${idx + 1}</span>
      <div><div class="label">${esc(src.label || src.camera_id)}</div>
        <div class="sub">${esc(src.camera_id)}<br>${cl ? esc(cap(cl.domain)) + ' ' + pct(cl.confidence) : 'not configured'}${src.status === 'monitoring' ? ' · watching' : ''}</div></div>
      <span class="count ${hot ? 'hot' : ''}" title="Incidents raised">${n}</span>
    </div>`;
  }).join('');
  const prof = sel && sel.profile_summary;
  let profile = '<div class="empty small">No source selected</div>';
  if (sel) {
    profile = prof
      ? `<div class="profile-box"><div class="ptitle">${esc(prof.title || cap(domainOf(sel)))}</div>
          <div class="muted small">${esc(sel.label || sel.camera_id)} · ${esc(prof.objectives ?? 0)} objectives${prof.mode === 'rules_only' ? ' · rules-only' : ''}</div>
          ${prof.entities && prof.entities.length ? `<div class="small" style="margin-top:8px">Watching:</div><ul>${prof.entities.map(e => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}</div>`
      : `<div class="profile-box muted small">${esc(sel.label || sel.camera_id)} has no monitoring profile yet.</div>`;
  }
  setHTML($('#sidebar'), `
    <div class="side-title">Sources</div>
    ${items || '<div class="empty small">No indexed sources found</div>'}
    ${flags.upload || MOCK ? `<button class="side-link" data-nav="/new">Add new footage</button>` : ''}
    ${flags.live || MOCK ? `<button class="side-link" data-nav="/live">Live camera</button>` : ''}
    <button class="side-link" data-nav="/search">Search the archive</button>
    <div class="side-title">Active profile</div>
    ${profile}`);
}

// ---------------------------------------------------------------- views
const VIEWS = {};

VIEWS.overview = {
  mount(main) {
    main.innerHTML = `
      <div id="ov-stats"></div>
      <div class="grid-3-2">
        <div class="panel"><h2>Watching <span class="spacer"></span><span id="ov-tabs" class="btn-row"></span></h2>
          <div id="ov-player"></div><div id="ov-replay"></div></div>
        <div class="panel"><h2>Incidents <span class="spacer"></span><span class="muted" id="ov-feed-meta"></span></h2>
          <div id="ov-feed" class="feed tall"></div></div>
      </div>
      <div class="panel"><h2>How Sightline handled this camera <span id="ov-pipe-src" class="muted"></span></h2>
        <div id="ov-pipeline"></div></div>`;
  },
  async update(main) {
    const src = sourceById(S.selected);
    const st = (S.status && S.status.stats) || null;
    const incidents = sortIncidents(S.incidents);
    const severe = incidents.filter(i => i.severity === 'critical' || i.severity === 'high').length;
    const configured = S.sources.filter(s => s.classification).length;
    const fig = (v, l, t) => `<span title="${esc(t)}"><b>${esc(v)}</b>${esc(l)}</span>`;
    setHTML($('#ov-stats', main), `<div class="figures">
      ${fig(`${configured}/${S.sources.length}`, 'cameras configured themselves', 'Sources with a Sightline-generated classification and monitoring profile')}
      ${st ? fig(st.candidates ?? '–', 'candidate moments evaluated', 'Segments that passed deterministic gates and were evaluated') : ''}
      ${st ? fig(st.rejected ?? '–', 'rejected after investigation', 'Candidates the investigation judged unclear or false positive (kept for audit)') : ''}
      ${fig(incidents.length, `incident${incidents.length === 1 ? '' : 's'} raised, ${severe} warning or danger`, 'Incidents that passed investigation')}
    </div>`);

    setHTML($('#ov-tabs', main), S.sources.filter(s => s.classification).map(s =>
      `<button class="btn ${s.id === S.selected ? 'primary' : ''}" data-action="select-source" data-id="${esc(s.id)}">${esc(s.label || s.camera_id)}</button>`).join(''));

    const mine = incidents.filter(i => i.source_id === S.selected);
    const latest = mine[0];
    const ev = latest && (latest.evidence || []).find(e => e.role === 'event');
    const replay = (src && src.replay) || null;
    if (latest && ev) {
      setHTML($('#ov-player', main), player(ev, {
        badge: 'LATEST INCIDENT', autoplay: true, cam: latest.camera_id,
        overlay: `${sevPill(latest.severity)} <b>${esc(latest.title)}</b> <span class="muted">· video ${esc(fmtT(latest.peak_at ?? latest.started_at))} · ${pct(latest.confidence && latest.confidence.value)}</span>`,
      }));
    } else {
      setHTML($('#ov-player', main), player(replay && replay.segment_uri ? { segment: replay.segment_uri } : null, {
        badge: replay && replay.active ? 'REPLAY' : '', cam: src && src.camera_id,
        overlay: replay && replay.caption ? `<span class="muted">${esc(replay.caption)}</span>` : (src ? esc(src.label || src.camera_id) : 'No source'),
      }));
    }
    if (replay && replay.total_segments) {
      const pos = Math.min(1, (replay.segment || 0) / replay.total_segments);
      const marks = mine.filter(i => i.replay_pos != null).map(i => `<span class="mark" style="left:${(i.replay_pos * 100).toFixed(1)}%" title="${esc(i.title)}"></span>`).join('');
      setHTML($('#ov-replay', main), `<div class="replay-bar" title="Indexed archive replayed in order; each segment is evaluated as the replay clock passes it">
        <span>${replay.active ? 'Archive replay' : 'Paused'}${replay.speed ? ' · ' + esc(replay.speed) + '×' : ''}</span>
        <div class="track"><div class="fill" style="width:${(pos * 100).toFixed(1)}%"></div>${marks}</div>
        <span class="mono">${esc(replay.segment || 0)}/${esc(replay.total_segments)}</span></div>`);
    } else setHTML($('#ov-replay', main), '');

    setHTML($('#ov-pipe-src', main), src ? esc(src.label || src.camera_id) : '');
    if (src) {
      try { setHTML($('#ov-pipeline', main), pipelineHTML(await GET(`api/pipeline/${enc(src.id)}`), true)); }
      catch (e) { setHTML($('#ov-pipeline', main), `<div class="empty">Pipeline unavailable (${esc(e.message)})</div>`); }
    }

    const fresh = new Set();
    if (S.feedReady) incidents.forEach(i => { if (!S.seen.has(i.id)) fresh.add(i.id); });
    incidents.forEach(i => S.seen.add(i.id));
    S.feedReady = true;
    setHTML($('#ov-feed-meta', main), `${incidents.length} raised · 0 searches typed`);
    setHTML($('#ov-feed', main), incidents.length ? incidents.map(i => feedItem(i, fresh.has(i.id))).join('') : '<div class="empty">No incidents yet.</div>');
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

function reingestHTML(src, job) {
  if (!src.profile) return `<div class="empty">Configure the source first. Sightline needs a plan before it can write a prompt.</div>`;
  if (!job) {
    return `<p class="muted small">Sightline can re-run VAST's pipeline (YOLO → Cosmos → Embed → VastDB) on this footage using <b>its own prompt</b>. Planning is autonomous; execution waits for your approval because re-ingest rewrites the shared index.</p>
      <button class="btn primary" data-action="plan-reingest" data-id="${esc(src.id)}">Plan re-analysis</button>`;
  }
  if (job.status === 'planned') {
    return `<div class="plan-card">
        <div><b>Sightline's plan</b>: re-analyze <span class="mono">${esc(job.filename || shortSeg(job.original_video))}</span></div>
        <div class="small muted" style="margin:6px 0">${esc(job.chunk_count)} chunk · ${esc(job.clips ?? '?')} clips · ETA ${esc(job.eta || 'a few minutes')} · prompt ${esc(job.prompt && job.prompt.chars)}/800 chars</div>
        ${job.reason ? `<div class="small">${esc(job.reason)}</div>` : ''}
      </div>
      <div class="btn-row" style="margin-top:10px"><button class="btn go" data-action="approve-reingest" data-job="${esc(job.id)}">Approve &amp; start re-ingest</button></div>`;
  }
  const idx = REINGEST_STAGES.indexOf(job.status);
  const failed = job.status === 'failed';
  const failedAt = failed ? Math.max(0, REINGEST_STAGES.indexOf(job.failed_stage || 'reingesting')) : -1;
  const pr = job.progress || {};
  const frac = pr.total_segments ? pr.indexed_segments / pr.total_segments : (job.status === 'ready' ? 1 : 0);
  return `<div class="stepper">${REINGEST_STAGES.map((s, i) => {
      let c = '';
      if (failed) c = i < failedAt ? 'done' : i === failedAt ? 'failed' : '';
      else c = i < idx ? 'done' : i === idx ? (s === 'ready' ? 'done' : 'current') : '';
      return `<div class="st ${c}">${esc(cap(s))}</div>`;
    }).join('')}</div>
    <div class="progress"><i style="width:${(frac * 100).toFixed(0)}%"></i></div>
    <div class="small muted" title="Progress reported by VAST's re-ingest API; never estimated by Sightline">
      ${esc(pr.completed_chunks ?? 0)}/${esc(pr.total_chunks ?? job.chunk_count ?? 1)} chunks · ${esc(pr.indexed_segments ?? 0)}/${esc(pr.total_segments ?? job.clips ?? '?')} clips
      ${job.started_at ? ' · ' + esc(elapsed(job.started_at, job.finished_at)) : ''} · <span class="mono">${esc(job.filename || shortSeg(job.original_video))}</span></div>
    ${job.verify ? `<div class="callout" style="margin-top:12px">Verified: captions changed in ${esc(job.verify.changed)}/${esc(job.verify.total)} segments; ${esc(job.verify.with_terms ?? 0)} mention objective-specific details.</div>` : ''}
    ${failed ? `<div class="callout warn" style="margin-top:10px">Failed: ${esc(job.error || 'unknown error')}. Monitoring continues on the original captions.</div>` : ''}`;
}

const EVO_LABELS = { generic: 'Generic understanding', objective: 'Monitoring objective', prompt: "Sightline's prompt", reanalyzed: 'Re-analyzed by Cosmos', event: 'Operational event' };
function evolutionHTML(evo) {
  const steps = (evo && evo.steps) || [];
  if (!steps.length) return `<div class="empty">No re-analysis yet. After an approved re-ingest, this shows how Sightline changed what the index knows.</div>`;
  return `<div class="evo">${steps.map(s => `<div class="card ${s.stage === 'event' ? 'event' : ''}" ${s.stage === 'event' && s.ref ? `data-nav="/incident/${enc(s.ref)}" style="cursor:pointer"` : ''}>
      <div class="k">${esc(EVO_LABELS[s.stage] || cap(s.stage))}</div>
      <div class="${s.stage === 'prompt' ? 'mono small' : ''}">${s.stage === 'reanalyzed' ? captionHTML(s.text) : esc(s.text)}</div></div>`).join('')}</div>`;
}

VIEWS.source = {
  mount(main) {
    main.innerHTML = `<div id="sv-head"></div>
      <div class="grid2">
        <div class="panel"><h2>How Sightline configured this source</h2><div id="sv-config"></div></div>
        <div class="panel"><h2>Autonomous pipeline</h2><div id="sv-pipeline"></div></div>
      </div>
      <div class="panel"><h2>Monitoring plan <span class="spacer"></span><span class="muted small">generated, not hand-written</span></h2><div id="sv-plan"></div></div>
      <div class="grid2">
        <div class="panel"><h2>Specialized Cosmos prompt</h2><div id="sv-prompt"></div></div>
        <div class="panel"><h2>Re-analysis (VAST re-ingest)</h2><div id="sv-reingest"></div></div>
      </div>
      <div class="panel"><h2>Analysis evolution</h2><div id="sv-evo"></div></div>
      <div class="panel"><h2>Incidents from this source</h2><div id="sv-incidents" class="feed"></div></div>`;
  },
  async update(main) {
    const id = S.route.id;
    S.selected = id;
    let d;
    try { d = await GET(`api/sources/${enc(id)}`); }
    catch (e) { setHTML($('#sv-head', main), `<div class="panel">Source unavailable: ${esc(e.message)}</div>`); return; }
    const cl = d.classification, pf = d.profile;
    const monitoring = d.status === 'monitoring';
    setHTML($('#sv-head', main), `<div class="page-head">
      <div class="grow"><h1>${esc(d.label || d.camera_id)}</h1>
        <div class="meta">${esc(d.camera_id)} · ${esc(d.location || '–')} · ${esc(d.capture_type || '–')} · ${esc(d.segment_count ?? '?')} indexed segments · status <b>${esc(d.status)}</b></div>
        <div style="margin-top:8px">${cl ? `<span class="tag accent" title="Sightline's environment classification">${esc(cap(cl.domain))} · ${pct(cl.confidence)}</span>` : ''}
          ${cl && cl.mode === 'rules_only' ? '<span class="tag warn">rules-only (LLM unavailable)</span>' : ''}
          ${cl && cl.camera_type ? `<span class="tag">${esc(cl.camera_type)} camera</span>` : ''}</div></div>
      <div class="btn-row">
        <button class="btn" data-action="configure" data-id="${esc(d.id)}">${cl ? 'Re-run self-configuration' : 'Let Sightline configure this source'}</button>
        ${pf ? (monitoring
          ? `<button class="btn danger" data-action="monitor-stop" data-id="${esc(d.id)}">Stop monitoring</button>`
          : `<button class="btn primary" data-action="monitor-start" data-id="${esc(d.id)}">Start monitoring</button>`) : ''}
      </div></div>`);

    setHTML($('#sv-config', main), cl ? `
      <div style="margin-bottom:10px">${esc(cl.description || '')}</div>
      <div class="small muted" style="margin-bottom:6px">Why Sightline thinks so:</div>
      <ul class="evidence-list">${(cl.evidence || []).map(e => `<li><span class="tag">${esc(e.source)}</span><span><b>${esc(e.signal)}</b> <span class="muted">${esc(e.supports || '')}</span></span></li>`).join('')}</ul>
      ${cl.important_entities && cl.important_entities.length ? `<div style="margin-top:10px">${cl.important_entities.map(e => `<span class="tag accent">${esc(e)}</span>`).join('')}</div>` : ''}`
      : `<div class="empty">Not configured. Click “Let Sightline configure this source”.</div>`);

    setHTML($('#sv-pipeline', main), pipelineHTML(d.pipeline));

    setHTML($('#sv-plan', main), pf ? `
      <table class="obj"><thead><tr><th>Severity</th><th>Objective</th><th>Detects when</th><th>Probe</th></tr></thead><tbody>
      ${(pf.objectives || []).map(o => `<tr><td>${sevPill(o.severity)}</td>
        <td><b>${esc(o.name)}</b><div class="od">${esc(o.description || '')}</div>${o.rationale ? `<div class="od" style="margin-top:4px">Why: ${esc(o.rationale)}</div>` : ''}</td>
        <td class="od">${esc(detectorWords(o.detector))}</td>
        <td class="od">${(o.semantic_probes || []).map(q => `“${esc(q)}”`).join('<br>')}</td></tr>`).join('')}
      </tbody></table>
      ${pf.dropped && pf.dropped.length ? `<div class="callout warn" style="margin-top:12px"><b>Not applicable here</b>${pf.dropped.map(x => `<div class="small">${esc(x.name || x.id)}: ${esc(x.reason)}</div>`).join('')}</div>` : ''}`
      : `<div class="empty">No plan yet.</div>`);

    const pr = pf && pf.generated_prompt;
    setHTML($('#sv-prompt', main), pr ? `
      <div class="prompt-box">${esc(pr.text)}</div>
      <div class="meter"><span>${esc(pr.chars ?? (pr.text || '').length)}/800 chars</span><div class="track"><i style="width:${Math.min(100, ((pr.chars ?? (pr.text || '').length) / 8)).toFixed(0)}%"></i></div>
        ${pr.template_fallback ? '<span class="tag warn">template fallback</span>' : '<span class="tag accent">written by Sightline</span>'}</div>
      ${pf.information_gaps && pf.information_gaps.length ? `<div class="small muted" style="margin-top:12px">Information gaps this prompt closes:</div><ul class="small">${pf.information_gaps.map(g => `<li>${esc(g)}</li>`).join('')}</ul>` : ''}
      ${pr.covers && pr.covers.length ? `<div>${pr.covers.map(c => `<span class="tag">${esc(c)}</span>`).join('')}</div>` : ''}`
      : `<div class="empty">No prompt generated yet.</div>`);

    setHTML($('#sv-reingest', main), reingestHTML(d, d.reingest));
    setHTML($('#sv-evo', main), evolutionHTML(d.evolution));
    const incs = sortIncidents(d.incidents || S.incidents.filter(i => i.source_id === id));
    setHTML($('#sv-incidents', main), incs.length ? incs.map(i => feedItem(i, false)).join('') : '<div class="empty">No incidents from this source yet.</div>');
  },
};

VIEWS.incident = {
  async mount(main) {
    let inc;
    try { inc = await GET(`api/incidents/${enc(S.route.id)}`); }
    catch (e) { main.innerHTML = `<div class="panel">Incident unavailable: ${esc(e.message)}</div>`; return; }
    S.selected = inc.source_id;
    const inv = inc.investigation || {};
    const evs = inc.evidence || [];
    const before = evs.filter(e => e.role === 'before');
    const pick = { BEFORE: before[before.length - 1], EVENT: evs.find(e => e.role === 'event'), AFTER: evs.find(e => e.role === 'after') };
    const conf = inc.confidence || {};
    const probe = inc.search_hint || inc.title;
    const trip = (role, ev) => `<div class="trip ${role === 'EVENT' ? 'event' : ''}" data-seg="${esc(ev ? ev.segment : '')}">
      <div class="role"><span>${role}</span><span class="mono">${ev ? esc(fmtT(ev.t_start)) + '–' + esc(fmtT(ev.t_end)) : ''}</span></div>
      ${ev ? player(ev, { autoplay: role === 'EVENT', badge: role === 'EVENT' ? 'EVENT' : '', cam: inc.camera_id }) : `<div class="player"><div class="ph"><div class="big">No ${role.toLowerCase()} segment</div></div></div>`}
      ${ev ? `<div class="caption" data-action="toggle-caption" title="Cosmos description (click to expand)">${captionHTML(ev.caption)}</div><div style="margin-top:6px">${yoloTags(ev.yolo)}</div>` : ''}
    </div>`;

    main.innerHTML = `
      <button class="back" data-nav="/source/${enc(inc.source_id)}">← ${esc(sourceLabel(inc.source_id))}</button>
      <div class="page-head">
        <div class="grow">
          <div>${sevPill(inc.severity)} <span class="tag">${esc(cap(inc.domain))}</span> <span class="tag">${esc(cap(inv.verdict || ''))}</span>${inc.mode === 'rules_only' ? '<span class="tag warn">rules-only</span>' : ''}</div>
          <h1 style="margin-top:8px">${esc(inc.title)}</h1>
          <div class="meta">${esc(inc.camera_id || '')} · ${esc(inc.location || '')} · video ${esc(fmtT(inc.started_at))}–${esc(fmtT(inc.ended_at))} (peak ${esc(fmtT(inc.peak_at))}) · raised automatically ${esc(clock(inc.created_at))}</div>
        </div>
        <div class="conf-box" data-action="toggle-conf" title="Click for the breakdown">
          <div class="conf-big">${pct(conf.value)}</div><div class="conf-label">confidence: how it's computed</div>
        </div>
      </div>
      <div class="panel components" id="conf-components"><h2>Why this confidence</h2>
        ${(conf.components || []).map(c => `<div class="comp"><span>${esc(c.name)}</span><div class="bar"><i style="width:${pct(c.value)}"></i></div><span class="mono">${pct(c.value)}</span>
          <div class="ex">${esc(c.explanation || '')}${c.weight != null ? ` · weight ${esc(c.weight)}` : ''}</div></div>`).join('') || '<div class="empty">No breakdown</div>'}
      </div>
      <div class="panel"><h2>Evidence</h2><div class="triptych">${trip('BEFORE', pick.BEFORE)}${trip('EVENT', pick.EVENT)}${trip('AFTER', pick.AFTER)}</div></div>
      <div class="grid-3-2">
        <div>
          <div class="panel"><h2>Timeline</h2>
            <ul class="timeline">${(inv.timeline || []).map(t => `<li class="${t.segment && t.segment === inv.peak_segment ? 'peak' : ''}" data-action="play-seg" data-seg="${esc(t.segment || '')}"><span class="tt">${esc(fmtT(t.t))}</span>${esc(t.text)}</li>`).join('') || '<li>No timeline</li>'}</ul></div>
          <div class="panel"><h2>Why Sightline flagged this</h2><div>${esc(inv.why_flagged || '')}</div>
            ${inc.summary ? `<div class="muted" style="margin-top:10px">${esc(inc.summary)}</div>` : ''}</div>
          <div class="panel"><h2>Investigation</h2>
            ${(inv.answers || []).map(a => `<div class="qa"><div class="q">${esc(a.question)}</div><div class="a">${esc(a.answer)}</div></div>`).join('') || '<div class="empty">No questions recorded</div>'}
            ${inv.counter_evidence ? `<div class="callout warn" style="margin-top:10px"><b>Counter-evidence considered:</b> ${esc(inv.counter_evidence)}</div>` : ''}
            ${inv.second_look ? `<div class="callout" style="margin-top:10px"><b>Cosmos second look: ${esc(inv.second_look.verdict)}</b>. ${esc(inv.second_look.text || '')}</div>` : ''}
          </div>
        </div>
        <div>
          <div class="panel"><h2>Recommended action</h2><div class="callout action">${esc(inc.recommended_action || 'Review the evidence.')}</div></div>
          <div class="panel"><h2>Entities</h2>${(inc.entities || inv.entities || []).map(e => `<span class="tag accent">${esc(e)}</span>`).join('') || '<span class="muted">–</span>'}</div>
          <div class="panel"><h2>Related moments <span class="spacer"></span><button class="btn" data-nav="/search?q=${enc(probe)}&source=${enc(inc.source_id)}">Find similar</button></h2>
            <div class="related">${(inv.related || []).map(r => `<div class="rel">${player(r, { controls: true })}
              <div class="muted">${esc(r.camera_id || '')} · ${esc(fmtT(r.t_start))}${r.similarity != null ? ' · ' + pct(r.similarity) : ''}</div><div>${esc(String(r.caption || '').slice(0, 140))}</div></div>`).join('') || '<div class="empty">None found</div>'}</div></div>
        </div>
      </div>`;
  },
};

VIEWS.search = {
  mount(main) {
    const r = S.route;
    main.innerHTML = `<div class="page-head"><div class="grow"><h1>Search the archive</h1>
      <div class="meta">Secondary tool: Sightline finds incidents on its own; search is for following up.</div></div></div>
      <form class="search-row" id="search-form">
        <input type="text" name="q" placeholder="e.g. forklift close to a worker" value="${esc(r.q)}">
        <select name="source"><option value="">All sources</option>${S.sources.map(s => `<option value="${esc(s.id)}" ${s.id === r.source ? 'selected' : ''}>${esc(s.label || s.camera_id)}</option>`).join('')}</select>
        <button class="btn primary">Search</button></form>
      <div id="search-results"></div>`;
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
        <div class="muted small" style="margin-top:6px">${esc(sourceLabel(h.camera_id || h.source_id))} · ${esc(fmtT(h.t_start))}–${esc(fmtT(h.t_end))}${h.similarity != null ? ' · similarity ' + pct(h.similarity) : ''}</div>
        <div class="small">${esc(String(h.caption || '').slice(0, 220))}</div></div>`).join('')}</div>` : '<div class="empty">No matches.</div>';
    } catch (e) { box.innerHTML = `<div class="empty">Search failed: ${esc(e.message)}</div>`; }
  },
};

// ----- new footage: Sightline configures itself on clips it has never seen
VIEWS.new = {
  mount(main) {
    const flags = (S.status && S.status.flags) || {};
    if (!flags.upload && !MOCK) { main.innerHTML = `<div class="panel"><h2>New footage</h2><div class="empty">Disabled on this deployment (UPLOAD_ENABLED is off).</div></div>`; return; }
    const lim = S.status && S.status.limits && S.status.limits.upload_mb;
    S.fresh = S.fresh || {};
    main.innerHTML = `<div class="page-head"><div class="grow"><h1>New footage</h1>
      <div class="meta">Give Sightline a clip it has never seen. It looks first, then writes its own ingestion prompt <b>before</b> the footage enters the VAST index.</div></div></div>
      <div class="grid2">
        <div class="panel"><h2>Clip</h2>
          <input type="file" id="nf-file" accept="video/*" hidden>
          <div class="drop" data-action="nf-pick">Choose a video file${lim ? ` (max ${esc(lim)} MB)` : ''}<div class="small">Self-recorded footage only, H.264 MP4 works best</div></div>
          <div id="nf-preview"></div></div>
        <div class="panel"><h2>Autonomous pipeline</h2><div id="nf-pipeline"><div class="empty">Waiting for a clip.</div></div></div>
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
      <div class="small muted">${esc(f.file.name)} · ${(f.file.size / 1048576).toFixed(1)} MB · ${fmtT(f.duration)}</div>
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
        (job.status === 'failed' ? `<div class="callout warn" style="margin-top:10px">Failed: ${esc(job.error || '')}</div>` : '') +
        (done && f.source_id ? `<div class="btn-row" style="margin-top:12px"><button class="btn primary" data-nav="/source/${enc(f.source_id)}">Open the new source</button></div>` : ''));
    } catch (e) { setHTML($('#nf-pipeline', main), `<div class="empty">${esc(e.message)}</div>`); }
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

// ----- live camera: cheap motion gate in the browser, Cosmos only on change or checkpoint
VIEWS.live = {
  mount(main) {
    const flags = (S.status && S.status.flags) || {};
    if (!flags.live && !MOCK) { main.innerHTML = `<div class="panel"><h2>Live camera</h2><div class="empty">Disabled on this deployment (LIVE_ENABLED is off).</div></div>`; return; }
    main.innerHTML = `<div class="page-head"><div class="grow"><h1>Live camera</h1>
        <div class="meta">Frames pass a motion gate in your browser; Cosmos only sees frames when the scene changes or every 5 s. Measured, not claimed: see the numbers below.</div></div>
        <div class="btn-row"><button class="btn primary" data-action="live-start" id="live-start">Start camera</button><button class="btn danger" data-action="live-stop">Stop</button></div></div>
      ${window.isSecureContext ? '' : `<div class="callout warn" style="margin-bottom:14px">This page is not a secure context, so the browser will block the camera. Use HTTPS, or enable chrome://flags/#unsafely-treat-insecure-origin-as-secure for this origin.</div>`}
      <div class="grid-3-2">
        <div class="panel"><h2>Camera</h2><div class="player"><video id="live-video" muted playsinline autoplay></video></div><div id="live-gate" style="margin-top:12px"></div></div>
        <div class="panel"><h2>Sightline's read of this scene</h2><div id="live-config"><div class="empty">Start the camera.</div></div></div>
      </div>
      <div class="grid2">
        <div class="panel"><h2>Observations (Cosmos)</h2><div id="live-obs" class="feed"></div></div>
        <div class="panel"><h2>Live events</h2><div id="live-events" class="feed"></div></div>
      </div>`;
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
    const bctx = L.big.getContext('2d');
    bctx.drawImage(v, 0, 0, 640, 360);
    const b64 = L.big.toDataURL('image/jpeg', 0.72).split(',')[1];
    POST(`api/live/${enc(L.sid)}/frame`, { image_b64: b64, motion: diff, reason, ts: new Date().toISOString() })
      .catch(e => toast('Frame rejected: ' + e.message))
      .finally(() => { if (S.live) S.live.inflight = false; });
    this.renderGate();
  },
  renderGate() {
    const L = S.live; const st = (L && L.state && L.state.stats) || {};
    setHTML($('#live-gate'), L ? `<div class="stats">
      <div class="stat" title="Frames sampled from the camera (2/s)"><div class="v">${L.captured}</div><div class="l">frames sampled</div></div>
      <div class="stat" title="Frames sent to the backend after the motion gate"><div class="v">${L.sent}</div><div class="l">sent to Sightline</div></div>
      <div class="stat" title="Cosmos calls per minute, as measured by the backend"><div class="v">${esc(st.cosmos_calls_per_min ?? '–')}</div><div class="l">Cosmos calls/min</div></div>
      <div class="stat" title="Median Cosmos latency, as measured by the backend"><div class="v">${st.p50_latency_ms != null ? esc(Math.round(st.p50_latency_ms)) + 'ms' : '–'}</div><div class="l">p50 latency</div></div>
    </div><div class="small muted">Motion ${(100 * (L.motion || 0)).toFixed(1)}% · ${L.gated} frames skipped by the gate</div>` : '');
  },
  async poll() {
    const L = S.live;
    if (!L || !L.sid) return;
    try { L.state = await GET(`api/live/${enc(L.sid)}/state`); } catch (_) { return; }
    const st = L.state;
    const cl = st.classification;
    setHTML($('#live-config'), cl ? `<div><span class="tag accent">${esc(cap(cl.domain))} · ${pct(cl.confidence)}</span></div>
      <div style="margin:8px 0">${esc(cl.description || '')}</div>
      ${st.profile ? `<div class="small muted">Watching for:</div><ul class="small">${(st.profile.objectives || []).map(o => `<li>${sevPill(o.severity)} ${esc(o.name)}</li>`).join('')}</ul>` : '<div class="empty small">Planning…</div>'}`
      : `<div class="empty">Observing… (${(st.observations || []).length}/3 observations before classifying)</div>`);
    setHTML($('#live-obs'), (st.observations || []).slice().reverse().slice(0, 12).map(o => `<div class="feed-item" style="cursor:default">
      <span class="mono small">${esc(clock(o.ts))}</span><div><div>${esc(o.scene)}</div><div class="fs">${esc((o.entities || []).join(', '))}${o.flags && o.flags.length ? ' · flags: ' + esc(o.flags.join(', ')) : ''}</div></div>
      <span class="fc">${o.latency_ms != null ? esc(Math.round(o.latency_ms)) + 'ms' : ''}</span></div>`).join('') || '<div class="empty">None yet</div>');
    setHTML($('#live-events'), (st.events || []).slice().reverse().map(e => `<div class="feed-item" style="cursor:default">
      <span>${sevPill(e.severity)}</span><div><div class="ft">${esc(e.title)}</div><div class="fs">${esc(e.reason || '')}</div></div><span class="fc">${esc(clock(e.ts))}</span></div>`).join('') || '<div class="empty">No events</div>');
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
  window.scrollTo(0, 0);
  try {
    await VIEWS[S.route.name].mount(main);
    if (VIEWS[S.route.name].update) await VIEWS[S.route.name].update(main);
  } catch (e) { main.innerHTML = `<div class="panel">Something went wrong: ${esc(e.message)}</div>`; }
  renderSidebar();
}

const ACTIONS = {
  'select-source': el => { S.selected = el.dataset.id; refresh(); },
  'configure': async el => { await POST(`api/sources/${enc(el.dataset.id)}/configure`, {}); toast('Sightline is looking at this source…', 'info'); },
  'monitor-start': async el => { await POST(`api/sources/${enc(el.dataset.id)}/monitor`, {}); toast('Monitoring started (archive replay)', 'info'); },
  'monitor-stop': async el => { await DEL(`api/sources/${enc(el.dataset.id)}/monitor`); },
  'plan-reingest': async el => { await POST(`api/sources/${enc(el.dataset.id)}/reingest/plan`, {}); },
  'approve-reingest': async el => { el.disabled = true; await POST(`api/reingest/${enc(el.dataset.job)}/approve`, {}); toast('Re-ingest started on VAST', 'info'); },
  'toggle-conf': () => { const c = $('#conf-components'); if (c) c.classList.toggle('open'); },
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

// A clip that fails to load falls back to its caption instead of a black box.
document.addEventListener('error', e => {
  if (e.target && e.target.tagName === 'VIDEO' && !e.target.srcObject) {
    const ph = document.createElement('div');
    ph.className = 'ph';
    ph.innerHTML = '<div><div class="big">Clip unavailable</div><div class="small">VSS stream did not load</div></div>';
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
  await refresh();
  window.addEventListener('hashchange', render);
  await render();
  setInterval(refresh, POLL_MS);
  setInterval(refreshStatus, STATUS_MS);
}

boot().catch(e => { $('#main').innerHTML = `<div class="panel">Failed to start: ${esc(e.message)}</div>`; });
