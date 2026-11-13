// Timeline layout, audio envelopes, compositor and transitions.
// Shared by the live preview and the exporter so what you see is what you export.

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const clamp01 = (v) => clamp(v, 0, 1);
const easeInOut = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);

export const TRANSITIONS = [
  { id: 'none', name: 'None' },
  { id: 'fade', name: 'Crossfade' },
  { id: 'black', name: 'Dip to black' },
  { id: 'white', name: 'Flash' },
  { id: 'slideLeft', name: 'Slide left' },
  { id: 'slideRight', name: 'Slide right' },
  { id: 'slideUp', name: 'Slide up' },
  { id: 'slideDown', name: 'Slide down' },
  { id: 'pushLeft', name: 'Push left' },
  { id: 'pushRight', name: 'Push right' },
  { id: 'pushUp', name: 'Push up' },
  { id: 'pushDown', name: 'Push down' },
  { id: 'wipeLeft', name: 'Wipe left' },
  { id: 'wipeRight', name: 'Wipe right' },
  { id: 'wipeDown', name: 'Wipe down' },
  { id: 'diagonal', name: 'Diagonal' },
  { id: 'circle', name: 'Circle' },
  { id: 'blinds', name: 'Blinds' },
  { id: 'zoomIn', name: 'Zoom in' },
  { id: 'zoomOut', name: 'Zoom out' },
];

export const MOTIONS = [
  { id: 'none', name: 'None' },
  { id: 'zoomIn', name: 'Slow zoom in' },
  { id: 'zoomOut', name: 'Slow zoom out' },
  { id: 'panLeft', name: 'Pan left' },
  { id: 'panRight', name: 'Pan right' },
];

export const FITS = [
  { id: 'contain', name: 'Fit' },
  { id: 'blur', name: 'Fit + blur' },
  { id: 'cover', name: 'Fill' },
];

export function clipDuration(c) {
  return c.type === 'image' ? c.dur : c.out - c.in;
}

/** Lays the main track out in time. A transition overlaps the end of one clip with the start of the next. */
export function computeLayout(clips) {
  const items = [];
  let t = 0;
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    const d = clipDuration(c);
    let td = 0;
    if (i > 0 && c.transition && c.transition.type !== 'none') {
      td = Math.max(0, Math.min(c.transition.dur, clipDuration(clips[i - 1]) / 2, d / 2));
    }
    const start = i === 0 ? 0 : t - td;
    items.push({ clip: c, index: i, start, end: start + d, dur: d, transIn: td, transOut: 0 });
    t = start + d;
  }
  for (let i = 0; i < items.length - 1; i++) items[i].transOut = items[i + 1].transIn;
  return { items, total: t };
}

/** Clips visible at time t (one, or two during a transition). */
export function activeAt(layout, t) {
  const { items, total } = layout;
  if (!items.length) return [];
  const tt = Math.min(t, total - 1e-6);
  const out = [];
  for (const it of items) {
    if (it.start <= tt && tt < it.end) out.push(it);
    else if (it.start > tt) break;
  }
  return out.slice(-2);
}

export function musicLayout(audio, total) {
  return audio
    .map((a) => {
      const len = a.out - a.in;
      return { clip: a, start: a.start, end: Math.min(a.start + len, total), fullEnd: a.start + len };
    })
    .filter((m) => m.end > m.start);
}

/** Gain of a video clip's own sound at timeline time t. */
export function clipGain(item, t) {
  const c = item.clip;
  if (c.muted) return 0;
  const a = t - item.start;
  const b = item.end - t;
  let g = c.volume ?? 1;
  g *= item.transIn > 0 ? clamp01(a / item.transIn) : clamp01(a / 0.008);
  g *= item.transOut > 0 ? clamp01(b / item.transOut) : clamp01(b / 0.008);
  return g;
}

/** Gain of a music clip at timeline time t. */
export function musicGain(m, t) {
  const c = m.clip;
  const a = t - m.start;
  const b = m.end - t;
  let g = c.volume ?? 1;
  g *= c.fadeIn > 0 ? clamp01(a / c.fadeIn) : clamp01(a / 0.008);
  g *= c.fadeOut > 0 ? clamp01(b / c.fadeOut) : clamp01(b / 0.008);
  return g;
}

// ---------- compositor ----------

let blurA = null;
let blurB = null;
function blurCanvases() {
  if (!blurA) {
    blurA = document.createElement('canvas');
    blurB = document.createElement('canvas');
  }
  return [blurA, blurB];
}

function drawSource(ctx, src) {
  // Assumes ctx is translated to the destination centre.
  const rot = src.rot || 0;
  if (rot) ctx.rotate((rot * Math.PI) / 180);
  if (src.flip) ctx.scale(-1, 1);
  ctx.drawImage(src.img, -src.w / 2, -src.h / 2, src.w, src.h);
}

function drawBlurBackground(ctx, W, H, src, dw, dh) {
  const [a, b] = blurCanvases();
  const aw = 24;
  const ah = Math.max(2, Math.round((aw * H) / W));
  if (a.width !== aw || a.height !== ah) {
    a.width = aw;
    a.height = ah;
  }
  const bw = aw * 4;
  const bh = ah * 4;
  if (b.width !== bw || b.height !== bh) {
    b.width = bw;
    b.height = bh;
  }
  const ac = a.getContext('2d');
  ac.setTransform(1, 0, 0, 1, 0, 0);
  ac.fillStyle = '#000';
  ac.fillRect(0, 0, aw, ah);
  const s = Math.max(aw / dw, ah / dh) * 1.1;
  ac.translate(aw / 2, ah / 2);
  ac.scale(s, s);
  drawSource(ac, src);
  const bc = b.getContext('2d');
  bc.imageSmoothingEnabled = true;
  bc.imageSmoothingQuality = 'high';
  bc.drawImage(a, 0, 0, bw, bh);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(b, 0, 0, W, H);
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  ctx.fillRect(0, 0, W, H);
}

function motionTransform(motion, q, W) {
  switch (motion) {
    case 'zoomIn':
      return { s: 1 + 0.14 * q, x: 0 };
    case 'zoomOut':
      return { s: 1.14 - 0.14 * q, x: 0 };
    case 'panLeft':
      return { s: 1.16, x: (0.5 - q) * 0.14 * W };
    case 'panRight':
      return { s: 1.16, x: (q - 0.5) * 0.14 * W };
    default:
      return { s: 1, x: 0 };
  }
}

/**
 * Draws one clip as a full-frame opaque layer.
 * src: { img: CanvasImageSource, w, h, rot, flip } or null when the frame isn't ready.
 * tf: transition transform { tx, ty, scale, alpha, clip(ctx) }.
 */
export function drawLayer(ctx, W, H, item, src, t, tf = {}) {
  ctx.save();
  if (tf.clip) {
    ctx.beginPath();
    tf.clip(ctx);
    ctx.clip();
  }
  ctx.globalAlpha = tf.alpha ?? 1;
  if (tf.tx || tf.ty || (tf.scale && tf.scale !== 1)) {
    ctx.translate(W / 2 + (tf.tx || 0), H / 2 + (tf.ty || 0));
    if (tf.scale && tf.scale !== 1) ctx.scale(tf.scale, tf.scale);
    ctx.translate(-W / 2, -H / 2);
  }
  const c = item.clip;
  const fit = c.fit || 'contain';
  if (!src) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
    return;
  }
  const rotated = (src.rot || 0) % 180 !== 0;
  const dw = rotated ? src.h : src.w;
  const dh = rotated ? src.w : src.h;
  if (fit === 'blur') drawBlurBackground(ctx, W, H, src, dw, dh);
  else {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
  }
  const base = fit === 'cover' ? Math.max(W / dw, H / dh) : Math.min(W / dw, H / dh);
  const q = item.dur > 0 ? clamp01((t - item.start) / item.dur) : 0;
  const m = motionTransform(c.motion, q, W);
  if (m.s !== 1 || m.x) {
    // Keep motion inside the frame for "fit" so the bars don't swim around.
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.clip();
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.translate(W / 2 + m.x, H / 2);
  ctx.scale(base * m.s, base * m.s);
  drawSource(ctx, src);
  ctx.restore();
}

function overlay(ctx, W, H, color, a) {
  ctx.save();
  ctx.globalAlpha = clamp01(a);
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
}

const TRANSITION_FNS = {
  none: (c, W, H, p, A, B) => B({}),
  fade: (c, W, H, p, A, B) => {
    A({});
    B({ alpha: p });
  },
  black: (c, W, H, p, A, B) => {
    if (p < 0.5) {
      A({});
      overlay(c, W, H, '#000', p * 2);
    } else {
      B({});
      overlay(c, W, H, '#000', (1 - p) * 2);
    }
  },
  white: (c, W, H, p, A, B) => {
    if (p < 0.5) {
      A({});
      overlay(c, W, H, '#fff', p * 2);
    } else {
      B({});
      overlay(c, W, H, '#fff', (1 - p) * 2);
    }
  },
  slideLeft: (c, W, H, p, A, B) => {
    A({});
    B({ tx: W * (1 - p) });
  },
  slideRight: (c, W, H, p, A, B) => {
    A({});
    B({ tx: -W * (1 - p) });
  },
  slideUp: (c, W, H, p, A, B) => {
    A({});
    B({ ty: H * (1 - p) });
  },
  slideDown: (c, W, H, p, A, B) => {
    A({});
    B({ ty: -H * (1 - p) });
  },
  pushLeft: (c, W, H, p, A, B) => {
    A({ tx: -W * p });
    B({ tx: W * (1 - p) });
  },
  pushRight: (c, W, H, p, A, B) => {
    A({ tx: W * p });
    B({ tx: -W * (1 - p) });
  },
  pushUp: (c, W, H, p, A, B) => {
    A({ ty: -H * p });
    B({ ty: H * (1 - p) });
  },
  pushDown: (c, W, H, p, A, B) => {
    A({ ty: H * p });
    B({ ty: -H * (1 - p) });
  },
  wipeLeft: (c, W, H, p, A, B) => {
    A({});
    B({ clip: (x) => x.rect(W * (1 - p), 0, W * p + 1, H) });
  },
  wipeRight: (c, W, H, p, A, B) => {
    A({});
    B({ clip: (x) => x.rect(0, 0, W * p, H) });
  },
  wipeDown: (c, W, H, p, A, B) => {
    A({});
    B({ clip: (x) => x.rect(0, 0, W, H * p) });
  },
  diagonal: (c, W, H, p, A, B) => {
    A({});
    const k = p * (W + H) * 1.02;
    B({
      clip: (x) => {
        x.moveTo(0, 0);
        x.lineTo(k, 0);
        x.lineTo(0, k);
        x.closePath();
      },
    });
  },
  circle: (c, W, H, p, A, B) => {
    A({});
    const r = (p * Math.hypot(W, H)) / 2 + 0.5;
    B({ clip: (x) => x.arc(W / 2, H / 2, r, 0, Math.PI * 2) });
  },
  blinds: (c, W, H, p, A, B) => {
    A({});
    const n = 8;
    const h = H / n;
    B({
      clip: (x) => {
        for (let i = 0; i < n; i++) x.rect(0, i * h, W, h * p + 0.5);
      },
    });
  },
  zoomIn: (c, W, H, p, A, B) => {
    B({});
    A({ scale: 1 + 0.6 * p, alpha: 1 - p });
  },
  zoomOut: (c, W, H, p, A, B) => {
    A({});
    B({ scale: 1.6 - 0.6 * p, alpha: p });
  },
};

const LINEAR = new Set(['fade', 'black', 'white']);

export function drawTransition(ctx, W, H, type, p, drawA, drawB) {
  const fn = TRANSITION_FNS[type] || TRANSITION_FNS.fade;
  fn(ctx, W, H, LINEAR.has(type) ? p : easeInOut(p), drawA, drawB);
}

/** Renders the whole frame at time t. getSource(item) returns a src (see drawLayer) or null. */
export function renderComposite(ctx, W, H, t, actives, getSource) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  if (!actives.length) return;
  if (actives.length === 1) {
    drawLayer(ctx, W, H, actives[0], getSource(actives[0]), t);
    return;
  }
  const [A, B] = actives;
  const p = B.transIn > 0 ? clamp01((t - B.start) / B.transIn) : 1;
  drawTransition(
    ctx,
    W,
    H,
    B.clip.transition.type,
    p,
    (tf) => drawLayer(ctx, W, H, A, getSource(A), t, tf),
    (tf) => drawLayer(ctx, W, H, B, getSource(B), t, tf),
  );
}

// ---------- output sizes ----------

export const ASPECTS = {
  '16:9': [16, 9],
  '9:16': [9, 16],
  '1:1': [1, 1],
  '4:5': [4, 5],
  '4:3': [4, 3],
  '3:4': [3, 4],
};

export const RESOLUTIONS = [
  { id: 2160, name: '4K', sub: '2160p' },
  { id: 1440, name: '2K', sub: '1440p' },
  { id: 1080, name: 'Full HD', sub: '1080p' },
  { id: 720, name: 'HD', sub: '720p' },
];

const even = (v) => Math.max(2, Math.round(v / 2) * 2);

/** Output size: the short side equals the resolution (2160 for 4K). */
export function outputSize(aspect, res) {
  const [aw, ah] = ASPECTS[aspect] || ASPECTS['16:9'];
  if (aw >= ah) return { width: even((res * aw) / ah), height: res };
  return { width: res, height: even((res * ah) / aw) };
}

export function formatTime(t, withTenths = true) {
  t = Math.max(0, t);
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  const ss = withTenths ? s.toFixed(1).padStart(4, '0') : String(Math.floor(s)).padStart(2, '0');
  return `${m}:${ss}`;
}
