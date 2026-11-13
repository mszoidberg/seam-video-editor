import {
  TRANSITIONS,
  MOTIONS,
  FITS,
  ASPECTS,
  RESOLUTIONS,
  computeLayout,
  activeAt,
  clipDuration,
  outputSize,
  formatTime,
  drawLayer,
  drawTransition,
  clamp,
} from './engine.js';
import { importFile, guessKind, uid } from './media.js';
import { Player } from './player.js';
import { runExport, prepareTarget, finishTarget, abortTarget, estimateBitrate } from './exporter.js';
import { icon } from './icons.js';

// ---------------------------------------------------------------- state
const media = new Map();
const S = {
  clips: [],
  audio: [],
  aspect: '16:9',
  aspectAuto: true,
  photoDur: 3,
  defaultTransition: { type: 'none', dur: 0.6 },
  sel: null, // { kind: 'clip' | 'music', id }
  pps: 60, // pixels per second
  exp: { res: 2160, fps: 30, quality: 'high', codec: 'avc' },
};
let layout = computeLayout([]);
const undoStack = [];
const redoStack = [];
let exporting = false;

const $ = (s) => document.querySelector(s);
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
};

const canvas = $('#preview');
const player = new Player(
  canvas,
  () => ({ layout, media, audio: S.audio }),
  (t) => onPlayerTime(t),
  () => updatePlayButton(),
);

// ---------------------------------------------------------------- undo
function snapshot() {
  return JSON.stringify({ clips: S.clips, audio: S.audio, aspect: S.aspect });
}
function pushUndo() {
  undoStack.push(snapshot());
  if (undoStack.length > 100) undoStack.shift();
  redoStack.length = 0;
}
function restore(snap) {
  const o = JSON.parse(snap);
  S.clips = o.clips;
  S.audio = o.audio;
  if (S.aspect !== o.aspect) {
    S.aspect = o.aspect;
    resizePreview();
  }
  if (S.sel && !findSel()) S.sel = null;
  afterEdit();
}
function undo() {
  if (!undoStack.length) return;
  redoStack.push(snapshot());
  restore(undoStack.pop());
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshot());
  restore(redoStack.pop());
}
function edit(fn) {
  pushUndo();
  fn();
  afterEdit();
}

function afterEdit(opts = {}) {
  layout = computeLayout(S.clips);
  renderTimeline();
  renderToolbar();
  if (!opts.keepPlayer) player.invalidate();
  if (player.time > layout.total) setTime(layout.total);
  updateTimeLabel();
  $('#undoBtn').disabled = !undoStack.length;
  $('#redoBtn').disabled = !redoStack.length;
  $('#exportBtn').disabled = !S.clips.length;
  $('#emptyState').hidden = S.clips.length > 0;
}

function findSel() {
  if (!S.sel) return null;
  const list = S.sel.kind === 'clip' ? S.clips : S.audio;
  return list.find((c) => c.id === S.sel.id) || null;
}

// ---------------------------------------------------------------- import
async function importFiles(files, target) {
  files = [...files];
  if (!files.length) return;
  const wasEmpty = S.clips.length === 0;
  toast(files.length > 1 ? `Adding ${files.length} files…` : `Adding ${files[0].name}…`, 1500);
  const added = [];
  const errors = [];
  for (const f of files) {
    try {
      const m = await importFile(f, onMediaUpdate);
      if (m.error) {
        errors.push(`${m.name}: ${m.error}`);
        continue;
      }
      media.set(m.id, m);
      added.push(m);
    } catch (e) {
      errors.push(e.message || String(e));
    }
  }
  if (added.length) {
    pushUndo();
    for (const m of added) {
      const asMusic = target === 'music' || m.kind === 'audio';
      if (asMusic) {
        if (!m.at) {
          errors.push(`${m.name}: no sound in this file.`);
          continue;
        }
        const last = S.audio.reduce((a, c) => Math.max(a, c.start + (c.out - c.in)), 0);
        S.audio.push({ id: uid('a'), mediaId: m.id, start: S.audio.length ? last : 0, in: 0, out: m.duration, volume: 1, fadeIn: 0, fadeOut: 1.5 });
        if (m.warning) errors.push(`${m.name}: ${m.warning}`);
      } else {
        const base = {
          id: uid('c'),
          mediaId: m.id,
          transition: { ...S.defaultTransition },
          fit: 'contain',
          motion: 'none',
          volume: 1,
          muted: false,
        };
        if (m.kind === 'image') S.clips.push({ ...base, type: 'image', dur: S.photoDur });
        else S.clips.push({ ...base, type: 'video', in: 0, out: m.duration });
        if (m.warning) errors.push(`${m.name}: ${m.warning}`);
      }
    }
    if (wasEmpty && S.aspectAuto) {
      const first = added.find((m) => m.kind !== 'audio');
      if (first && first.width && first.height) {
        const r = first.width / first.height;
        const a = r < 0.85 ? '9:16' : r < 1.15 ? '1:1' : '16:9';
        if (a !== S.aspect) {
          S.aspect = a;
          resizePreview();
        }
      }
    }
    afterEdit();
    if (wasEmpty) setTime(0);
  }
  if (errors.length) toast(errors.join('\n'), 7000, true);
}

let mediaUpdateTimer = 0;
function onMediaUpdate() {
  clearTimeout(mediaUpdateTimer);
  mediaUpdateTimer = setTimeout(() => renderTimeline(), 120);
}

// ---------------------------------------------------------------- timeline
const scroller = $('#tlScroll');
const content = $('#tlContent');
const videoTrack = $('#videoTrack');
const musicTrack = $('#musicTrack');
const ruler = $('#ruler');
let pad = 0;
let programmaticScroll = -1;

const visualSpan = (it, i) => {
  const a = i === 0 ? 0 : it.start + it.transIn / 2;
  const b = it.end - it.transOut / 2;
  return [a, b];
};

function renderTimeline() {
  const vw = scroller.clientWidth;
  pad = Math.round(vw / 2);
  const totalW = Math.max(layout.total * S.pps, 1);
  const musicEnd = S.audio.reduce((a, c) => Math.max(a, c.start + c.out - c.in), 0);
  const contentW = pad * 2 + Math.max(totalW, musicEnd * S.pps) + 80;
  content.style.width = `${contentW}px`;

  // Video track
  videoTrack.textContent = '';
  layout.items.forEach((it, i) => {
    const c = it.clip;
    const m = media.get(c.mediaId);
    const [a, b] = visualSpan(it, i);
    const left = pad + a * S.pps;
    const w = Math.max(6, (b - a) * S.pps);
    const blk = el('div', 'clip');
    blk.dataset.id = c.id;
    blk.style.left = `${left}px`;
    blk.style.width = `${w}px`;
    if (S.sel && S.sel.kind === 'clip' && S.sel.id === c.id) blk.classList.add('sel');
    const strip = el('div', 'strip');
    const tileW = 56 * (16 / 9);
    const n = Math.min(400, Math.ceil(w / tileW));
    const thumbs = m ? m.thumbs : [];
    for (let k = 0; k < n; k++) {
      const tile = el('div', 'tile');
      tile.style.width = `${tileW}px`;
      let th = thumbs[0];
      if (c.type === 'video' && thumbs.length > 1) {
        const tt = c.in + ((k + 0.5) * tileW) / S.pps;
        th = nearestThumb(thumbs, tt);
      }
      if (th) tile.style.backgroundImage = `url(${th.url})`;
      strip.appendChild(tile);
    }
    blk.appendChild(strip);
    const label = el('div', 'clip-label');
    label.innerHTML = `${c.type === 'image' ? icon('photo', 12) : ''}${c.muted ? icon('mute', 12) : ''}<span>${clipDuration(c).toFixed(1)}s</span>`;
    blk.appendChild(label);
    if (blk.classList.contains('sel')) {
      blk.appendChild(el('div', 'handle hl', '<i></i>'));
      blk.appendChild(el('div', 'handle hr', '<i></i>'));
    }
    videoTrack.appendChild(blk);
  });
  // transition badges
  layout.items.forEach((it, i) => {
    if (i === 0) return;
    const x = pad + (it.start + it.transIn / 2) * S.pps;
    const t = it.clip.transition || { type: 'none' };
    const btn = el('button', `trans-badge${t.type !== 'none' ? ' on' : ''}`, t.type !== 'none' ? icon('transition', 14) : icon('plus', 12));
    btn.style.left = `${x}px`;
    btn.title = t.type !== 'none' ? TRANSITIONS.find((q) => q.id === t.type)?.name || 'Transition' : 'Add transition';
    btn.setAttribute('aria-label', btn.title);
    btn.dataset.index = i;
    videoTrack.appendChild(btn);
  });
  const add = el('button', 'add-tile', icon('plus', 22));
  add.title = 'Add videos & photos';
  add.setAttribute('aria-label', 'Add videos and photos');
  add.style.left = `${pad + totalW + 8}px`;
  add.addEventListener('click', () => $('#fileVisual').click());
  if (S.clips.length) videoTrack.appendChild(add);

  // Music track
  musicTrack.textContent = '';
  for (const c of S.audio) {
    const m = media.get(c.mediaId);
    const len = c.out - c.in;
    const blk = el('div', 'mclip');
    blk.dataset.id = c.id;
    blk.style.left = `${pad + c.start * S.pps}px`;
    const w = Math.max(6, len * S.pps);
    blk.style.width = `${w}px`;
    if (S.sel && S.sel.kind === 'music' && S.sel.id === c.id) blk.classList.add('sel');
    const cv = document.createElement('canvas');
    cv.className = 'wave';
    blk.appendChild(cv);
    drawWave(cv, m, c, w);
    const overflow = c.start + len - layout.total;
    if (overflow > 0 && S.clips.length) {
      const cut = el('div', 'mcut');
      cut.style.width = `${Math.min(w, overflow * S.pps)}px`;
      cut.title = 'Past the end of the video – not exported';
      blk.appendChild(cut);
    }
    const label = el('div', 'clip-label', `${icon('music', 12)}<span>${escapeHtml(m ? m.name : '')}</span>`);
    blk.appendChild(label);
    if (blk.classList.contains('sel')) {
      blk.appendChild(el('div', 'handle hl', '<i></i>'));
      blk.appendChild(el('div', 'handle hr', '<i></i>'));
    }
    musicTrack.appendChild(blk);
  }
  const addMusic = el('button', 'add-music', `${icon('music', 14)}<span>${S.audio.length ? '' : 'Add music'}</span>`);
  addMusic.setAttribute('aria-label', 'Add music');
  addMusic.style.left = `${pad + (S.audio.length ? musicEnd * S.pps + 8 : 0)}px`;
  addMusic.addEventListener('click', () => $('#fileAudio').click());
  musicTrack.appendChild(addMusic);

  drawRuler();
  syncScrollToTime();
}

function nearestThumb(thumbs, t) {
  let best = thumbs[0];
  let bd = Infinity;
  for (const th of thumbs) {
    const d = Math.abs(th.t - t);
    if (d < bd) {
      bd = d;
      best = th;
    }
  }
  return best;
}

function drawWave(cv, m, c, w) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cw = Math.min(8000, Math.ceil(w));
  const ch = 34;
  cv.width = Math.ceil(cw * dpr);
  cv.height = Math.ceil(ch * dpr);
  cv.style.width = `${w}px`;
  cv.style.height = `${ch}px`;
  const x = cv.getContext('2d');
  x.scale(dpr, dpr);
  x.fillStyle = 'rgba(255,255,255,0.55)';
  if (!m || !m.peaks) {
    x.fillRect(0, ch / 2 - 0.5, cw, 1);
    return;
  }
  const len = c.out - c.in;
  const sx = cw / w;
  const norm = 0.9 / Math.max(0.02, m.peakMax || 0.7);
  for (let px = 0; px < cw; px += 2) {
    const t0 = c.in + ((px / sx) / w) * len;
    const t1 = c.in + (((px + 2) / sx) / w) * len;
    let v = 0;
    for (let k = Math.floor(t0 * m.peakRate); k <= Math.floor(t1 * m.peakRate); k++) v = Math.max(v, m.peaks[k] || 0);
    const h = Math.max(1, Math.min(1, v * norm) * (ch - 6));
    x.fillRect(px, (ch - h) / 2, 1.4, h);
  }
}

function drawRuler() {
  const vw = scroller.clientWidth;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const h = 22;
  ruler.width = Math.ceil(vw * dpr);
  ruler.height = h * dpr;
  ruler.style.width = `${vw}px`;
  const x = ruler.getContext('2d');
  x.setTransform(dpr, 0, 0, dpr, 0, 0);
  x.clearRect(0, 0, vw, h);
  const steps = [0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const step = steps.find((s) => s * S.pps >= 64) || 600;
  const sl = scroller.scrollLeft;
  const t0 = Math.max(0, Math.floor((sl - pad) / S.pps / step) * step);
  const t1 = (sl - pad + vw) / S.pps;
  const css = getComputedStyle(document.documentElement);
  x.fillStyle = css.getPropertyValue('--muted').trim() || '#888';
  x.strokeStyle = x.fillStyle;
  x.font = '10px system-ui, sans-serif';
  x.textBaseline = 'top';
  for (let t = t0; t <= t1 + step; t += step) {
    const px = pad + t * S.pps - sl;
    x.globalAlpha = 0.9;
    x.fillRect(Math.round(px), 14, 1, 8);
    x.fillText(formatTime(t, step < 1), Math.round(px) + 3, 3);
    x.globalAlpha = 0.45;
    for (let k = 1; k < 4; k++) x.fillRect(Math.round(px + (k * step * S.pps) / 4), 18, 1, 4);
  }
}

function syncScrollToTime() {
  const target = Math.round(player.time * S.pps);
  if (Math.abs(scroller.scrollLeft - target) >= 1) {
    programmaticScroll = target;
    scroller.scrollLeft = target;
  }
}

scroller.addEventListener('scroll', () => {
  drawRuler();
  if (programmaticScroll >= 0 && Math.abs(scroller.scrollLeft - programmaticScroll) <= 1.5) {
    programmaticScroll = -1;
    return;
  }
  programmaticScroll = -1;
  if (player.playing) return;
  const t = clamp(scroller.scrollLeft / S.pps, 0, layout.total);
  player.seek(t);
  updateTimeLabel();
});

function setTime(t) {
  player.seek(clamp(t, 0, layout.total));
  syncScrollToTime();
  updateTimeLabel();
}

function onPlayerTime(t) {
  const target = Math.round(t * S.pps);
  programmaticScroll = target;
  scroller.scrollLeft = target;
  updateTimeLabel(t);
}

// Editor-style timecode: minutes:seconds:frames at the export frame rate.
function timecode(t) {
  const fps = S.exp.fps;
  const f = Math.max(0, Math.round(t * fps));
  const ff = f % fps;
  const sec = Math.floor(f / fps);
  const p2 = (n) => String(n).padStart(2, '0');
  const h = Math.floor(sec / 3600);
  const mm = Math.floor(sec / 60) % 60;
  return `${h ? `${h}:` : ''}${p2(mm)}:${p2(sec % 60)}:${p2(ff)}`;
}
function updateTimeLabel(t = player.time) {
  $('#timeLabel').innerHTML = `<b>${timecode(t)}</b> / ${timecode(layout.total)}`;
}

function setZoom(pps) {
  const t = player.time;
  S.pps = clamp(pps, 6, 480);
  renderTimeline();
  programmaticScroll = Math.round(t * S.pps);
  scroller.scrollLeft = programmaticScroll;
}

// Pause when the user grabs the timeline during playback.
['pointerdown', 'wheel'].forEach((ev) =>
  scroller.addEventListener(
    ev,
    () => {
      if (player.playing) {
        player.pause();
        updatePlayButton();
      }
    },
    { passive: true },
  ),
);

// Mouse wheel: scroll horizontally; ctrl/pinch-trackpad: zoom.
scroller.addEventListener(
  'wheel',
  (e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      setZoom(S.pps * Math.exp(-e.deltaY * 0.01));
    } else if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      e.preventDefault();
      scroller.scrollLeft += e.deltaY;
    }
  },
  { passive: false },
);

// Pinch to zoom (touch).
let pinch = null;
scroller.addEventListener(
  'touchstart',
  (e) => {
    if (e.touches.length === 2) {
      const d = Math.abs(e.touches[0].clientX - e.touches[1].clientX) + 1;
      pinch = { d, pps: S.pps };
    }
  },
  { passive: true },
);
scroller.addEventListener(
  'touchmove',
  (e) => {
    if (drag && drag.active) {
      e.preventDefault();
      return;
    }
    if (pinch && e.touches.length === 2) {
      e.preventDefault();
      const d = Math.abs(e.touches[0].clientX - e.touches[1].clientX) + 1;
      setZoom(pinch.pps * (d / pinch.d));
    }
  },
  { passive: false },
);
scroller.addEventListener('touchend', (e) => {
  if (e.touches.length < 2) pinch = null;
});

// ---------------------------------------------------------------- timeline gestures
let drag = null;

content.addEventListener('pointerdown', (e) => {
  if (exporting) return;
  const badge = e.target.closest('.trans-badge');
  if (badge) return; // handled by click
  const handle = e.target.closest('.handle');
  const blk = e.target.closest('.clip, .mclip');
  if (!blk) {
    drag = { kind: 'empty', x0: e.clientX, y0: e.clientY, moved: false };
    return;
  }
  const isMusic = blk.classList.contains('mclip');
  const id = blk.dataset.id;
  const c = (isMusic ? S.audio : S.clips).find((q) => q.id === id);
  if (!c) return;
  if (handle) {
    e.preventDefault();
    blk.setPointerCapture?.(e.pointerId);
    pushUndo();
    drag = {
      kind: 'trim',
      side: handle.classList.contains('hl') ? 'l' : 'r',
      isMusic,
      c,
      x0: e.clientX,
      orig: { ...c },
      active: true,
      pointerId: e.pointerId,
      el: blk,
    };
    return;
  }
  drag = {
    kind: 'press',
    isMusic,
    c,
    blk,
    x0: e.clientX,
    y0: e.clientY,
    pointerId: e.pointerId,
    touch: e.pointerType !== 'mouse',
    active: false,
    moved: false,
  };
  if (drag.touch) {
    const d = drag;
    d.timer = setTimeout(() => {
      if (drag === d && !d.moved) startMoveDrag(d);
    }, 380);
  }
});

function startMoveDrag(d) {
  d.active = true;
  d.kind = d.isMusic ? 'moveMusic' : 'reorder';
  try {
    d.blk.setPointerCapture(d.pointerId);
  } catch {
    /* ignore */
  }
  navigator.vibrate?.(15);
  pushUndo();
  d.orig = { ...d.c };
  S.sel = { kind: d.isMusic ? 'music' : 'clip', id: d.c.id };
  renderTimeline();
  renderToolbar();
  d.blk = content.querySelector(`[data-id="${d.c.id}"]`);
  d.blk.classList.add('dragging');
  if (d.kind === 'reorder') {
    d.indicator = el('div', 'drop-indicator');
    videoTrack.appendChild(d.indicator);
    d.fromIndex = S.clips.indexOf(d.c);
    d.toIndex = d.fromIndex;
  }
  d.scrollStart = scroller.scrollLeft;
  autoScrollLoop(d);
}

function autoScrollLoop(d) {
  const step = () => {
    if (drag !== d || !d.active) return;
    const r = scroller.getBoundingClientRect();
    const edge = 48;
    if (d.lastX != null) {
      if (d.lastX < r.left + edge) scroller.scrollLeft -= 8;
      else if (d.lastX > r.right - edge) scroller.scrollLeft += 8;
      if (d.kind === 'reorder' || d.kind === 'moveMusic') updateMoveDrag(d, d.lastX);
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function updateMoveDrag(d, x) {
  const dx = x - d.x0 + (scroller.scrollLeft - d.scrollStart);
  if (d.kind === 'reorder') {
    d.blk.style.transform = `translateX(${dx}px)`;
    const tx = (x - scroller.getBoundingClientRect().left + scroller.scrollLeft - pad) / S.pps;
    // drop index = number of other clips whose midpoint is left of the pointer
    let idx = 0;
    const others = layout.items.filter((it) => it.clip !== d.c);
    for (const it of others) if ((it.start + it.end) / 2 < tx) idx++;
    d.toIndex = idx;
    const ref = others[idx];
    const pos = ref ? ref.start + ref.transIn / 2 : layout.total;
    d.indicator.style.left = `${pad + pos * S.pps}px`;
  } else {
    let start = Math.max(0, d.orig.start + dx / S.pps);
    // Snap to 0, the playhead and clip boundaries.
    const snaps = [0, player.time, ...layout.items.map((it) => it.start)];
    for (const s of snaps) if (Math.abs(start - s) * S.pps < 10) start = s;
    d.c.start = start;
    d.blk.style.left = `${pad + start * S.pps}px`;
  }
}

window.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (drag.kind === 'empty') {
    if (Math.abs(e.clientX - drag.x0) > 6) drag.moved = true;
    return;
  }
  if (drag.kind === 'press') {
    const dist = Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0);
    if (drag.touch) {
      if (dist > 8) {
        drag.moved = true;
        clearTimeout(drag.timer);
      }
    } else if (dist > 5) {
      startMoveDrag(drag);
    }
    if (!drag.active) return;
  }
  if (!drag.active) return;
  e.preventDefault();
  drag.lastX = e.clientX;
  if (drag.kind === 'trim') doTrim(drag, e.clientX);
  else updateMoveDrag(drag, e.clientX);
});

function doTrim(d, x) {
  const dt = (x - d.x0) / S.pps;
  const c = d.c;
  const o = d.orig;
  const m = media.get(c.mediaId);
  const MIN = 0.2;
  let previewT = null;
  if (d.isMusic) {
    if (d.side === 'l') {
      const nin = clamp(o.in + dt, 0, o.out - MIN);
      const delta = nin - o.in;
      c.in = nin;
      c.start = Math.max(0, o.start + delta);
    } else {
      c.out = clamp(o.out + dt, o.in + MIN, m.duration);
    }
  } else if (c.type === 'image') {
    c.dur = clamp(d.side === 'l' ? o.dur - dt : o.dur + dt, MIN, 600);
  } else {
    if (d.side === 'l') c.in = clamp(o.in + dt, 0, o.out - MIN);
    else c.out = clamp(o.out + dt, o.in + MIN, m.duration);
  }
  layout = computeLayout(S.clips);
  renderTimeline();
  if (!d.isMusic) {
    const it = layout.items.find((q) => q.clip === c);
    if (it) previewT = d.side === 'l' ? it.start + 0.001 : it.end - 0.02;
  }
  if (previewT != null) {
    player.time = previewT;
    player.clearStill();
    player.renderStill(previewT);
    updateTimeLabel(previewT);
  }
}

window.addEventListener('pointerup', (e) => endDrag(e, false));
window.addEventListener('pointercancel', (e) => endDrag(e, true));

function endDrag(e, cancelled) {
  const d = drag;
  if (!d) return;
  drag = null;
  clearTimeout(d.timer);
  if (d.kind === 'empty') {
    if (!d.moved && !cancelled && S.sel) {
      S.sel = null;
      renderTimeline();
      renderToolbar();
    }
    return;
  }
  if (d.kind === 'press' && !d.active) {
    if (!d.moved && !cancelled) {
      const kind = d.isMusic ? 'music' : 'clip';
      S.sel = S.sel && S.sel.id === d.c.id ? null : { kind, id: d.c.id };
      renderTimeline();
      renderToolbar();
    }
    return;
  }
  if (d.kind === 'reorder') {
    const from = S.clips.indexOf(d.c);
    if (d.toIndex !== from) {
      S.clips.splice(from, 1);
      S.clips.splice(d.toIndex, 0, d.c);
    } else if (undoStack.length) undoStack.pop();
    d.indicator && d.indicator.remove();
  } else if (d.kind === 'moveMusic') {
    if (d.c.start === d.orig.start && undoStack.length) undoStack.pop();
  }
  afterEdit();
}

videoTrack.addEventListener('click', (e) => {
  const b = e.target.closest('.trans-badge');
  if (b) openTransitionSheet(Number(b.dataset.index));
});

$('#rulerHit').addEventListener('click', (e) => {
  const r = scroller.getBoundingClientRect();
  const t = (e.clientX - r.left + scroller.scrollLeft - pad) / S.pps;
  setTime(t);
});

// ---------------------------------------------------------------- toolbar
function tb(iconName, label, fn, opts = {}) {
  const b = el('button', `tool${opts.danger ? ' danger' : ''}`, `${icon(iconName)}<span>${label}</span>`);
  b.addEventListener('click', fn);
  if (opts.disabled) b.disabled = true;
  return b;
}

function renderToolbar() {
  const bar = $('#toolbar');
  bar.textContent = '';
  const c = findSel();
  if (!c) {
    bar.append(
      tb('plus', 'Media', () => $('#fileVisual').click()),
      tb('music', 'Music', () => $('#fileAudio').click()),
      tb('transition', 'Transitions', () => openTransitionSheet('all'), { disabled: S.clips.length < 2 }),
      tb('clock', 'Photo length', () => openPhotoDurSheet(null), { disabled: !S.clips.some((q) => q.type === 'image') }),
      tb('fit', 'Fit all', () => openFitSheet(null), { disabled: !S.clips.length }),
      tb('gear', 'Format', openSettingsSheet),
    );
    return;
  }
  const back = el('button', 'tool back', `${icon('left')}<span>Done</span>`);
  back.addEventListener('click', () => {
    S.sel = null;
    renderTimeline();
    renderToolbar();
  });
  bar.append(back);
  if (S.sel.kind === 'clip') {
    const idx = S.clips.indexOf(c);
    bar.append(tb('split', 'Split', splitAtPlayhead));
    if (c.type === 'video') bar.append(tb(c.muted ? 'mute' : 'volume', 'Volume', () => openVolumeSheet(c)));
    if (c.type === 'image') bar.append(tb('clock', 'Duration', () => openPhotoDurSheet(c)));
    bar.append(
      tb('fit', 'Fit', () => openFitSheet(c)),
      tb('motion', 'Motion', () => openMotionSheet(c)),
      tb('transition', 'Transition', () => openTransitionSheet(idx > 0 ? idx : 1), { disabled: S.clips.length < 2 }),
      tb('left', 'Move', () => moveClip(c, -1), { disabled: idx === 0 }),
      tb('right', 'Move', () => moveClip(c, 1), { disabled: idx === S.clips.length - 1 }),
      tb('copy', 'Duplicate', () => duplicateSel()),
      tb('trash', 'Delete', deleteSel, { danger: true }),
    );
  } else {
    bar.append(
      tb('split', 'Split', splitAtPlayhead),
      tb('volume', 'Volume', () => openVolumeSheet(c)),
      tb('fade', 'Fades', () => openFadeSheet(c)),
      tb('playhead', 'To playhead', () => edit(() => (c.start = player.time))),
      tb('copy', 'Duplicate', () => duplicateSel()),
      tb('trash', 'Delete', deleteSel, { danger: true }),
    );
  }
}

function moveClip(c, dir) {
  const i = S.clips.indexOf(c);
  const j = i + dir;
  if (j < 0 || j >= S.clips.length) return;
  edit(() => {
    S.clips.splice(i, 1);
    S.clips.splice(j, 0, c);
  });
}

function deleteSel() {
  const c = findSel();
  if (!c) return;
  edit(() => {
    if (S.sel.kind === 'clip') S.clips = S.clips.filter((q) => q !== c);
    else S.audio = S.audio.filter((q) => q !== c);
    S.sel = null;
  });
}

function duplicateSel() {
  const c = findSel();
  if (!c) return;
  edit(() => {
    const copy = JSON.parse(JSON.stringify(c));
    copy.id = uid(S.sel.kind === 'clip' ? 'c' : 'a');
    if (S.sel.kind === 'clip') S.clips.splice(S.clips.indexOf(c) + 1, 0, copy);
    else {
      copy.start = c.start + (c.out - c.in);
      S.audio.push(copy);
    }
    S.sel = { kind: S.sel.kind, id: copy.id };
  });
}

function splitAtPlayhead() {
  const t = player.time;
  if (S.sel && S.sel.kind === 'music') {
    const c = findSel();
    const rel = t - c.start;
    if (rel <= 0.1 || rel >= c.out - c.in - 0.1) return toast('Move the playhead over the music to split it.');
    edit(() => {
      const b = { ...c, id: uid('a'), in: c.in + rel, start: t, fadeIn: 0 };
      c.out = c.in + rel;
      c.fadeOut = 0;
      S.audio.splice(S.audio.indexOf(c) + 1, 0, b);
    });
    return;
  }
  const actives = activeAt(layout, t);
  let it = actives.find((q) => S.sel && q.clip.id === S.sel.id) || actives[actives.length - 1];
  if (!it) return;
  const c = it.clip;
  const rel = t - it.start;
  if (rel <= 0.1 || rel >= it.dur - 0.1) return toast('Move the playhead inside the clip to split it.');
  edit(() => {
    const b = { ...JSON.parse(JSON.stringify(c)), id: uid('c'), transition: { type: 'none', dur: c.transition.dur } };
    if (c.type === 'image') {
      b.dur = c.dur - rel;
      c.dur = rel;
    } else {
      b.in = c.in + rel;
      c.out = c.in + rel;
    }
    S.clips.splice(S.clips.indexOf(c) + 1, 0, b);
    S.sel = { kind: 'clip', id: b.id };
  });
}

// ---------------------------------------------------------------- sheets
const sheet = $('#sheet');
const backdrop = $('#sheetBackdrop');
let sheetCleanup = null;
let sheetLocked = false;

function openSheet(title, body, opts = {}) {
  closeSheet(true);
  sheet.innerHTML = '';
  const head = el('div', 'sheet-head');
  head.appendChild(el('h2', '', title));
  if (!opts.noClose) {
    const x = el('button', 'icon-btn', icon('check'));
    x.setAttribute('aria-label', 'Done');
    x.addEventListener('click', () => closeSheet());
    head.appendChild(x);
  }
  sheet.appendChild(head);
  const bodyEl = el('div', 'sheet-body');
  bodyEl.append(...[].concat(body));
  sheet.appendChild(bodyEl);
  sheet.classList.add('open');
  backdrop.classList.add('open');
  sheetLocked = !!opts.locked;
  sheetCleanup = opts.cleanup || null;
  return bodyEl;
}
function closeSheet(force) {
  if (sheetLocked && !force) return;
  sheet.classList.remove('open');
  backdrop.classList.remove('open');
  sheetLocked = false;
  if (sheetCleanup) {
    const f = sheetCleanup;
    sheetCleanup = null;
    f();
  }
}
backdrop.addEventListener('click', () => closeSheet());

function optionGrid(options, current, onPick, cls = '') {
  const g = el('div', `opt-grid ${cls}`);
  for (const o of options) {
    const b = el('button', `opt${o.id === current ? ' on' : ''}`);
    if (o.html) b.innerHTML = o.html;
    else b.textContent = o.name;
    b.addEventListener('click', () => {
      g.querySelectorAll('.opt').forEach((q) => q.classList.remove('on'));
      b.classList.add('on');
      onPick(o.id);
    });
    g.appendChild(b);
  }
  return g;
}

function slider(label, min, max, step, value, fmt, onInput, onCommit) {
  const wrap = el('label', 'slider');
  const top = el('div', 'slider-top', `<span>${label}</span><b>${fmt(value)}</b>`);
  const r = el('input');
  r.type = 'range';
  r.min = min;
  r.max = max;
  r.step = step;
  r.value = value;
  r.addEventListener('input', () => {
    top.querySelector('b').textContent = fmt(Number(r.value));
    onInput(Number(r.value));
  });
  r.addEventListener('change', () => onCommit && onCommit(Number(r.value)));
  wrap.append(top, r);
  return wrap;
}

function button(label, cls, fn) {
  const b = el('button', `btn ${cls || ''}`, label);
  b.addEventListener('click', fn);
  return b;
}

// Live-edit helper: one undo entry per sheet session.
function liveEditor() {
  let pushed = false;
  return (fn) => {
    if (!pushed) {
      pushUndo();
      pushed = true;
    }
    fn();
    afterEdit();
  };
}

function makeSwatch(hue, label) {
  const c = document.createElement('canvas');
  c.width = 160;
  c.height = 90;
  const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 160, 90);
  g.addColorStop(0, `hsl(${hue} 70% 55%)`);
  g.addColorStop(1, `hsl(${hue + 40} 70% 35%)`);
  x.fillStyle = g;
  x.fillRect(0, 0, 160, 90);
  x.fillStyle = 'rgba(255,255,255,0.9)';
  x.font = 'bold 40px system-ui, sans-serif';
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  x.fillText(label, 80, 47);
  return c;
}

function openTransitionSheet(index) {
  const all = index === 'all';
  const target = all ? null : S.clips[index];
  if (!all && !target) return;
  const cur = all ? S.defaultTransition : target.transition || { type: 'none', dur: 0.6 };
  let type = cur.type === 'none' && all ? 'fade' : cur.type;
  let dur = cur.dur || 0.6;
  const ed = liveEditor();
  const apply = () => {
    if (all) return;
    ed(() => (target.transition = { type, dur }));
    if (type !== 'none') {
      const it = layout.items[index];
      setTime(Math.max(0, it.start - 0.4));
      if (!player.playing) togglePlay();
    }
  };
  const A = makeSwatch(200, 'A');
  const B = makeSwatch(20, 'B');
  const srcA = { img: A, w: 160, h: 90, rot: 0 };
  const srcB = { img: B, w: 160, h: 90, rot: 0 };
  const fake = { clip: { fit: 'cover' }, start: 0, dur: 1 };
  const minis = [];
  const opts = TRANSITIONS.map((tr) => ({ id: tr.id, name: tr.name, html: `<canvas width="96" height="54"></canvas><span>${tr.name}</span>` }));
  const grid = optionGrid(opts, type, (id) => {
    type = id;
    apply();
  }, 'trans-grid');
  grid.querySelectorAll('canvas').forEach((cv, i) => minis.push({ cv, id: TRANSITIONS[i].id }));
  let raf = 0;
  const t0 = performance.now();
  const anim = () => {
    const ph = ((performance.now() - t0) / 1600) % 1;
    const p = clamp((ph - 0.2) / 0.6, 0, 1);
    for (const { cv, id } of minis) {
      const x = cv.getContext('2d');
      x.setTransform(1, 0, 0, 1, 0, 0);
      x.fillStyle = '#000';
      x.fillRect(0, 0, 96, 54);
      if (id === 'none') {
        drawLayer(x, 96, 54, fake, ph < 0.5 ? srcA : srcB, 0);
        continue;
      }
      drawTransition(x, 96, 54, id, p, (tf) => drawLayer(x, 96, 54, fake, srcA, 0, tf), (tf) => drawLayer(x, 96, 54, fake, srcB, 0, tf));
    }
    raf = requestAnimationFrame(anim);
  };
  anim();
  const dur$ = slider('Duration', 0.2, 2.5, 0.1, dur, (v) => `${v.toFixed(1)}s`, (v) => {
    dur = v;
  }, () => apply());
  const parts = [grid, dur$];
  const applyAll = button(all ? 'Apply to all clips' : 'Apply to all', all ? 'primary wide' : 'wide', () => {
    edit(() => {
      for (let i = 1; i < S.clips.length; i++) S.clips[i].transition = { type, dur };
      S.defaultTransition = { type, dur };
    });
    toast(type === 'none' ? 'Transitions removed' : `${TRANSITIONS.find((q) => q.id === type).name} added between every clip`);
    closeSheet();
  });
  parts.push(applyAll);
  openSheet(all ? 'Transitions for all clips' : `Transition into clip ${index + 1}`, parts, {
    cleanup: () => cancelAnimationFrame(raf),
  });
}

function openVolumeSheet(c) {
  const ed = liveEditor();
  const parts = [
    slider('Volume', 0, 2, 0.05, c.volume, (v) => `${Math.round(v * 100)}%`, (v) => ed(() => {
      c.volume = v;
      if (v > 0) c.muted = false;
    })),
  ];
  if (S.sel.kind === 'clip') {
    parts.push(button(c.muted ? 'Unmute' : 'Mute', 'wide', (e) => {
      ed(() => (c.muted = !c.muted));
      e.target.textContent = c.muted ? 'Unmute' : 'Mute';
    }));
    parts.push(button('Mute all video sound', 'wide ghost', () => {
      edit(() => S.clips.forEach((q) => q.type === 'video' && (q.muted = true)));
      closeSheet();
    }));
  }
  openSheet(S.sel.kind === 'clip' ? 'Clip volume' : 'Music volume', parts);
}

function openFadeSheet(c) {
  const ed = liveEditor();
  openSheet('Music fades', [
    slider('Fade in', 0, 8, 0.1, c.fadeIn, (v) => `${v.toFixed(1)}s`, (v) => ed(() => (c.fadeIn = v))),
    slider('Fade out', 0, 8, 0.1, c.fadeOut, (v) => `${v.toFixed(1)}s`, (v) => ed(() => (c.fadeOut = v))),
    el('p', 'hint', 'Music that runs past the end of your video is cut there, and the fade-out happens just before the cut.'),
  ]);
}

function openPhotoDurSheet(c) {
  const ed = liveEditor();
  const val = c ? c.dur : S.photoDur;
  const parts = [
    slider('Duration', 0.5, 15, 0.1, val, (v) => `${v.toFixed(1)}s`, (v) =>
      ed(() => {
        if (c) c.dur = v;
        else {
          S.photoDur = v;
          S.clips.forEach((q) => q.type === 'image' && (q.dur = v));
        }
      }),
    ),
  ];
  if (c)
    parts.push(button('Apply to all photos', 'wide', () => {
      edit(() => {
        S.photoDur = c.dur;
        S.clips.forEach((q) => q.type === 'image' && (q.dur = c.dur));
      });
      closeSheet();
    }));
  else parts.push(el('p', 'hint', 'Sets every photo to this length, and new photos too.'));
  openSheet(c ? 'Photo duration' : 'Length of all photos', parts);
}

function openFitSheet(c) {
  const ed = liveEditor();
  const cur = c ? c.fit : 'contain';
  const parts = [
    optionGrid(FITS, cur, (id) =>
      ed(() => {
        if (c) c.fit = id;
        else S.clips.forEach((q) => (q.fit = id));
      }),
    ),
    el('p', 'hint', '<b>Fit</b> shows the whole picture with black bars. <b>Fit + blur</b> fills the bars with a blurred copy. <b>Fill</b> crops to fill the frame.'),
  ];
  if (c) parts.push(button('Apply to all clips', 'wide', () => {
    edit(() => S.clips.forEach((q) => (q.fit = c.fit)));
    closeSheet();
  }));
  openSheet(c ? 'Fit in frame' : 'Fit for all clips', parts);
}

function openMotionSheet(c) {
  const ed = liveEditor();
  openSheet('Motion', [
    optionGrid(MOTIONS, c.motion || 'none', (id) => ed(() => (c.motion = id))),
    el('p', 'hint', 'A slow zoom or pan over the clip. Great on photos.'),
    button('Apply to all photos', 'wide', () => {
      edit(() => S.clips.forEach((q) => q.type === 'image' && (q.motion = c.motion)));
      closeSheet();
    }),
  ]);
}

function aspectIcon(a) {
  const [w, h] = ASPECTS[a];
  const s = 26 / Math.max(w, h);
  return `<i class="ar" style="width:${w * s}px;height:${h * s}px"></i><span>${a}</span>`;
}

function openSettingsSheet() {
  const opts = Object.keys(ASPECTS).map((a) => ({ id: a, html: aspectIcon(a) }));
  openSheet('Video format', [
    el('div', 'field-label', 'Aspect ratio'),
    optionGrid(opts, S.aspect, (id) => {
      pushUndo();
      S.aspect = id;
      S.aspectAuto = false;
      resizePreview();
      afterEdit();
      updateFormatChip();
    }, 'aspect-grid'),
    el('p', 'hint', '16:9 for YouTube and TVs, 9:16 for phones (Reels, TikTok, Shorts), 1:1 or 4:5 for feeds.'),
  ]);
}

function updateFormatChip() {
  const r = RESOLUTIONS.find((q) => q.id === S.exp.res);
  $('#formatChip').textContent = `${S.aspect} · ${r ? r.name : ''}`;
}

// ---------------------------------------------------------------- export
function fmtBytes(b) {
  if (b > 1e9) return `${(b / 1e9).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(b / 1e6))} MB`;
}

function openExportSheet() {
  if (!S.clips.length) return;
  if (player.playing) togglePlay();
  const body = [];
  const info = el('div', 'export-info');
  const update = () => {
    const { width, height } = outputSize(S.aspect, S.exp.res);
    const br = estimateBitrate(width, height, S.exp.fps, S.exp.codec, S.exp.quality);
    const size = ((br + 256000) * layout.total) / 8;
    info.innerHTML = `<div><b>${width}×${height}</b> · ${S.exp.fps} fps · ${S.exp.codec === 'hevc' ? 'HEVC' : 'H.264'}</div><div>${formatTime(layout.total, false)} long · about ${fmtBytes(size)} · no watermark</div>`;
    updateFormatChip();
  };
  body.push(el('div', 'field-label', 'Resolution'));
  body.push(optionGrid(RESOLUTIONS.map((r) => ({ id: r.id, html: `<b>${r.name}</b><small>${r.sub}</small>` })), S.exp.res, (v) => {
    S.exp.res = v;
    update();
  }, 'seg'));
  body.push(el('div', 'field-label', 'Frame rate'));
  body.push(optionGrid([24, 25, 30, 60].map((f) => ({ id: f, name: `${f}` })), S.exp.fps, (v) => {
    S.exp.fps = v;
    update();
  }, 'seg'));
  body.push(el('div', 'field-label', 'Quality'));
  body.push(optionGrid([{ id: 'high', name: 'High' }, { id: 'max', name: 'Maximum' }], S.exp.quality, (v) => {
    S.exp.quality = v;
    update();
  }, 'seg'));
  body.push(el('div', 'field-label', 'Format'));
  body.push(optionGrid([{ id: 'avc', html: '<b>H.264</b><small>plays everywhere</small>' }, { id: 'hevc', html: '<b>HEVC</b><small>smaller file</small>' }], S.exp.codec, (v) => {
    S.exp.codec = v;
    update();
  }, 'seg'));
  body.push(info);
  const bad = S.clips.filter((c) => !media.get(c.mediaId));
  if (bad.length) body.push(el('p', 'hint warn', 'Some clips are missing their files.'));
  body.push(button(`${icon('download', 18)}<span>Export video</span>`, 'primary wide big', startExport));
  update();
  openSheet('Export', body);
}

async function startExport() {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const name = `video-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}.mp4`;
  let target;
  try {
    target = await prepareTarget(name, true);
  } catch (e) {
    return toast(`Couldn’t start the export: ${e.message}`, 6000, true);
  }
  if (!target) return; // cancelled the save dialog
  exporting = true;
  document.body.classList.add('exporting');
  const ctrl = new AbortController();
  const pct = el('div', 'progress-pct', '0%');
  const bar = el('div', 'progress-bar', '<i></i>');
  const stats = el('div', 'progress-stats', 'Preparing…');
  const mini = document.createElement('canvas');
  mini.className = 'progress-frame';
  const { width, height } = outputSize(S.aspect, S.exp.res);
  mini.width = 320;
  mini.height = Math.round((320 * height) / width);
  const note = el('p', 'hint', 'Keep this tab open and your screen on until it finishes.');
  const cancel = button('Cancel', 'wide ghost', () => ctrl.abort());
  openSheet('Exporting', [mini, pct, bar, stats, note, cancel], { locked: true, noClose: true });

  let wake = null;
  try {
    wake = await navigator.wakeLock?.request('screen');
  } catch {
    /* not available */
  }
  const t0 = performance.now();
  try {
    const res = await runExport(
      { layout, audio: S.audio, media },
      { aspect: S.aspect, ...S.exp },
      target,
      ({ done, total, fps, canvas: c }) => {
        const f = done / total;
        pct.textContent = `${Math.floor(f * 100)}%`;
        bar.firstChild.style.width = `${f * 100}%`;
        const eta = fps > 0 ? (total - done) / fps : 0;
        stats.textContent = `${done} / ${total} frames · ${fps.toFixed(1)} fps · ${eta > 1 ? `about ${formatTime(eta, false)} left` : 'finishing…'}`;
        mini.getContext('2d').drawImage(c, 0, 0, mini.width, mini.height);
      },
      ctrl.signal,
    );
    const out = await finishTarget(target);
    const secs = (performance.now() - t0) / 1000;
    showExportResult(out, res, secs);
  } catch (e) {
    await abortTarget(target);
    sheetLocked = false;
    if (e && e.name === 'AbortError') {
      closeSheet(true);
      toast('Export cancelled');
    } else {
      console.error(e);
      openSheet('Export failed', [
        el('p', 'hint warn', escapeHtml(e.message || String(e))),
        el('p', 'hint', 'Try a lower resolution or frame rate. If one clip causes this, try removing it.'),
        button('Close', 'wide', () => closeSheet()),
      ]);
    }
  } finally {
    exporting = false;
    document.body.classList.remove('exporting');
    try {
      wake && (await wake.release());
    } catch {
      /* ignore */
    }
  }
}

// Inside claude.ai, files are saved through the page's download permission.
const inClaude = !!(window.claude && window.claude.use);
const downloadsReady = inClaude ? window.claude.use('downloads').catch(() => null) : Promise.resolve(null);

let lastExportUrl = null;
function showExportResult(out, res, secs) {
  const parts = [];
  const desc = `${res.width}×${res.height} · ${res.codec === 'hevc' ? 'HEVC' : 'H.264'}${res.audioCodec ? ` · ${res.audioCodec.toUpperCase()} audio` : ''} · took ${formatTime(secs, false)}`;
  if (out.savedToDisk) {
    parts.push(el('div', 'done-badge', `${icon('check', 28)}`));
    parts.push(el('p', 'center', `Saved as <b>${escapeHtml(out.name)}</b>`));
    parts.push(el('p', 'hint center', desc));
    parts.push(button('Done', 'primary wide', () => closeSheet(true)));
    openSheet('Export finished', parts, { noClose: true });
    return;
  }
  if (lastExportUrl) URL.revokeObjectURL(lastExportUrl);
  const url = URL.createObjectURL(out.file);
  lastExportUrl = url;
  const v = document.createElement('video');
  v.className = 'result-video';
  v.src = url;
  v.controls = true;
  v.playsInline = true;
  parts.push(v);
  parts.push(el('p', 'hint center', `${fmtBytes(out.file.size)} · ${desc}`));
  const canShare = !inClaude && navigator.canShare && navigator.canShare({ files: [out.file] });
  if (canShare) {
    parts.push(button(`${icon('share', 18)}<span>Share / Save to Photos</span>`, 'primary wide big', async () => {
      try {
        await navigator.share({ files: [out.file] });
      } catch (e) {
        if (e.name !== 'AbortError') toast(`Sharing failed: ${e.message}`, 5000, true);
      }
    }));
  }
  if (inClaude) {
    const save = button(`${icon('download', 18)}<span>Save video</span>`, 'primary wide big', async () => {
      const dl = await downloadsReady;
      if (!dl) return toast('Saving isn\u2019t available in this view. Open the page in a web browser to save the video.', 6000, true);
      save.disabled = true;
      try {
        await dl.save({ filename: out.name, data: out.file });
        toast('Saved');
      } catch (e) {
        const code = e && e.code;
        if (code === 'declined') toast('Not saved');
        else if (code === 'too_large') toast('This file is too big to save in this app. Open the page in a web browser, or export at a lower resolution.', 7000, true);
        else if (code === 'rate_limited') toast('A save is already waiting for you to confirm.');
        else toast(`Couldn\u2019t save the video${e && e.message ? `: ${e.message}` : '.'}`, 6000, true);
      } finally {
        save.disabled = false;
      }
    });
    parts.push(save);
  } else {
    const a = el('a', `btn wide big${canShare ? '' : ' primary'}`, `${icon('download', 18)}<span>Download</span>`);
    a.href = url;
    a.download = out.name;
    parts.push(a);
  }
  parts.push(button('Close', 'wide ghost', () => closeSheet(true)));
  openSheet('Your video is ready', parts, { noClose: true });
}

// ---------------------------------------------------------------- preview sizing
function resizePreview() {
  const wrap = $('#previewWrap');
  const r = wrap.getBoundingClientRect();
  const { width, height } = outputSize(S.aspect, 1080);
  const ar = width / height;
  let cw = r.width;
  let ch = cw / ar;
  if (ch > r.height) {
    ch = r.height;
    cw = ch * ar;
  }
  cw = Math.max(40, Math.floor(cw));
  ch = Math.max(40, Math.floor(ch));
  canvas.style.width = `${cw}px`;
  canvas.style.height = `${ch}px`;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  let pw = cw * dpr;
  let ph = ch * dpr;
  const cap = 1280 / Math.max(pw, ph);
  if (cap < 1) {
    pw *= cap;
    ph *= cap;
  }
  player.sizeCanvas(Math.round(pw), Math.round(ph));
  player.hasDrawn = false;
  player.redraw();
  updateFormatChip();
}
new ResizeObserver(() => {
  resizePreview();
  renderTimeline();
}).observe($('#previewWrap'));

// ---------------------------------------------------------------- transport
function togglePlay() {
  if (!S.clips.length) return;
  if (player.playing) player.pause();
  else player.play();
  updatePlayButton();
}
function updatePlayButton() {
  const b = $('#playBtn');
  b.innerHTML = icon(player.playing ? 'pause' : 'play', 26);
  b.setAttribute('aria-label', player.playing ? 'Pause' : 'Play');
}

$('#playBtn').addEventListener('click', togglePlay);
$('#undoBtn').addEventListener('click', undo);
$('#redoBtn').addEventListener('click', redo);
$('#exportBtn').addEventListener('click', openExportSheet);
$('#formatChip').addEventListener('click', openSettingsSheet);
$('#zoomInBtn').addEventListener('click', () => setZoom(S.pps * 1.5));
$('#zoomOutBtn').addEventListener('click', () => setZoom(S.pps / 1.5));
$('#emptyAdd').addEventListener('click', () => $('#fileVisual').click());
$('#fileVisual').addEventListener('change', (e) => {
  importFiles(e.target.files, 'visual');
  e.target.value = '';
});
$('#fileAudio').addEventListener('change', (e) => {
  importFiles(e.target.files, 'music');
  e.target.value = '';
});

// Drag & drop files (desktop).
window.addEventListener('dragover', (e) => {
  if ([...(e.dataTransfer?.types || [])].includes('Files')) {
    e.preventDefault();
    document.body.classList.add('dropping');
  }
});
window.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) document.body.classList.remove('dropping');
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  document.body.classList.remove('dropping');
  const files = [...(e.dataTransfer?.files || [])];
  const visual = files.filter((f) => guessKind(f) !== 'audio');
  const audio = files.filter((f) => guessKind(f) === 'audio');
  (async () => {
    if (visual.length) await importFiles(visual, 'visual');
    if (audio.length) await importFiles(audio, 'music');
  })();
});

window.addEventListener('keydown', (e) => {
  if (exporting) return;
  if (e.target && e.target.closest && e.target.closest('input, textarea, select')) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    e.shiftKey ? redo() : undo();
  } else if (mod && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    redo();
  } else if (e.key === ' ') {
    e.preventDefault();
    togglePlay();
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    if (S.sel) {
      e.preventDefault();
      deleteSel();
    }
  } else if (e.key.toLowerCase() === 's' && !mod) {
    splitAtPlayhead();
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    if (player.playing) togglePlay();
    const step = e.shiftKey ? 1 : 1 / 30;
    setTime(player.time + (e.key === 'ArrowLeft' ? -step : step));
  } else if (e.key === 'Home') setTime(0);
  else if (e.key === 'End') setTime(layout.total);
  else if (e.key === 'Escape') {
    if (sheet.classList.contains('open')) closeSheet();
    else if (S.sel) {
      S.sel = null;
      renderTimeline();
      renderToolbar();
    }
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden && player.playing) {
    player.pause();
    updatePlayButton();
  }
});
window.addEventListener('beforeunload', (e) => {
  if (S.clips.length || exporting) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// ---------------------------------------------------------------- misc
let toastTimer = 0;
function toast(msg, ms = 2600, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('error', isError);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
$('#toast').addEventListener('click', () => $('#toast').classList.remove('show'));

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function checkSupport() {
  const missing = [];
  if (!('VideoEncoder' in window) || !('VideoDecoder' in window)) missing.push('video encoding (WebCodecs)');
  if (!('AudioDecoder' in window)) missing.push('audio decoding');
  if (missing.length) {
    const box = $('#unsupported');
    box.hidden = false;
    box.querySelector('span').textContent = `This browser is missing ${missing.join(' and ')}. Use a current Chrome, Edge or Safari (iOS 17+).`;
  }
}

// ---------------------------------------------------------------- boot
$('#undoBtn').innerHTML = icon('undo');
$('#redoBtn').innerHTML = icon('redo');
$('#zoomInBtn').innerHTML = icon('zoomIn', 20);
$('#zoomOutBtn').innerHTML = icon('zoomOut', 20);
updatePlayButton();
checkSupport();
afterEdit();
resizePreview();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Exposed for automated tests.
window.__seam = { S, media, importFiles, afterEdit, player, get layout() { return layout; }, runExport, outputSize };
