// Importing media: probing, thumbnails, waveforms and decoding helpers.
import { Input, ALL_FORMATS, BlobSource, VideoSampleSink, AudioBufferSink, CanvasSink } from 'mediabunny';

let nextId = 1;
export const uid = (p) => `${p}${Date.now().toString(36)}${(nextId++).toString(36)}`;

const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|avi|3gp|ts|mts|m2ts)$/i;
const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif|bmp|heic|heif)$/i;
const AUDIO_EXT = /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac|weba)$/i;

export function guessKind(file) {
  const t = file.type || '';
  if (t.startsWith('video/')) return 'video';
  if (t.startsWith('image/')) return 'image';
  if (t.startsWith('audio/')) return 'audio';
  if (VIDEO_EXT.test(file.name)) return 'video';
  if (IMAGE_EXT.test(file.name)) return 'image';
  if (AUDIO_EXT.test(file.name)) return 'audio';
  return null;
}

const CODEC_NAMES = { avc: 'H.264', hevc: 'HEVC (H.265)', vp9: 'VP9', av1: 'AV1', vp8: 'VP8' };

function hevcHint() {
  return 'This browser can’t decode HEVC video (the iPhone default). Try Safari or Edge, or set iPhone Camera → Formats → Most Compatible.';
}

/** Probes a file and returns a media record. onUpdate is called when thumbnails/waveform arrive. */
export async function importFile(file, onUpdate) {
  const kind = guessKind(file);
  if (!kind) throw new Error(`${file.name}: not a video, photo or audio file.`);
  if (kind === 'image') return importImage(file);
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  let vt = null;
  let at = null;
  try {
    vt = kind === 'video' ? await input.getPrimaryVideoTrack() : null;
    at = await input.getPrimaryAudioTrack();
  } catch (e) {
    throw new Error(`${file.name}: this file type can’t be read (${e.message || e}).`);
  }
  if (!vt && !at) throw new Error(`${file.name}: no video or audio found in this file.`);
  const tracks = [vt, at].filter(Boolean);
  const base = await input.getFirstTimestamp(tracks);
  const end = await input.computeDuration(tracks);
  const duration = Math.max(0, end - base);
  if (!(duration > 0)) throw new Error(`${file.name}: this file looks empty.`);

  const m = {
    id: uid('m'),
    kind: vt ? 'video' : 'audio',
    file,
    name: file.name,
    input,
    base,
    duration,
    vt: null,
    at: null,
    error: null,
    warning: null,
    thumbs: [],
    peaks: null,
    peakRate: 20,
  };

  if (vt) {
    const ok = await vt.canDecode();
    if (!ok) {
      const codec = vt.codec;
      m.error = codec === 'hevc' ? hevcHint() : `This browser can’t decode ${CODEC_NAMES[codec] || codec || 'this'} video.`;
    } else {
      m.vt = vt;
      m.videoSink = new VideoSampleSink(vt);
    }
    m.width = vt.displayWidth;
    m.height = vt.displayHeight;
  }
  if (at) {
    const ok = await at.canDecode().catch(() => false);
    if (ok) {
      m.at = at;
    } else if (m.kind === 'audio') {
      m.error = `This browser can’t decode the audio in ${file.name}.`;
    } else {
      m.warning = 'Sound in this video can’t be decoded, so it will be silent.';
    }
  }

  if (m.kind === 'video' && m.vt) makeThumbs(m, onUpdate);
  if (m.at && m.kind === 'audio') makeWaveform(m, onUpdate);
  return m;
}

async function importImage(file) {
  let bmp;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    const heic = /\.(heic|heif)$/i.test(file.name) || /hei[cf]/i.test(file.type);
    throw new Error(
      heic
        ? `${file.name}: this browser can’t open HEIC photos. Use Safari, or share the photo as JPEG.`
        : `${file.name}: this photo can’t be opened.`,
    );
  }
  const width = bmp.width;
  const height = bmp.height;
  // Keep a preview-sized copy in memory; the full size is decoded again at export time.
  const preview = await scaleBitmap(bmp, 1920);
  const thumb = await scaleBitmap(preview, 160, true);
  if (preview !== bmp) bmp.close();
  return {
    id: uid('m'),
    kind: 'image',
    file,
    name: file.name,
    width,
    height,
    preview,
    thumbs: [{ t: 0, url: thumb }],
    duration: Infinity,
    error: null,
  };
}

async function scaleBitmap(bmp, maxSide, asDataUrl = false) {
  const s = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  if (s >= 1 && !asDataUrl) return bmp;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * s));
  c.height = Math.max(1, Math.round(bmp.height * s));
  const x = c.getContext('2d');
  x.imageSmoothingQuality = 'high';
  x.drawImage(bmp, 0, 0, c.width, c.height);
  if (asDataUrl) return c.toDataURL('image/jpeg', 0.75);
  return createImageBitmap(c);
}

/** Full-resolution photo for export, scaled down only if it is far larger than needed. */
export async function decodeImageForExport(media, W, H) {
  const bmp = await createImageBitmap(media.file);
  const need = Math.max(W, H) * 1.25;
  if (Math.max(bmp.width, bmp.height) <= need * 1.5) return bmp;
  const out = await scaleBitmap(bmp, need);
  bmp.close();
  return out;
}

async function makeThumbs(m, onUpdate) {
  try {
    const th = 72;
    const tw = Math.round((th * 16) / 9);
    const sink = new CanvasSink(m.vt, { width: tw, height: th, fit: 'cover', poolSize: 1 });
    const n = Math.max(1, Math.min(40, Math.ceil(m.duration / 1.5)));
    const ts = [];
    for (let i = 0; i < n; i++) ts.push(m.base + ((i + 0.5) / n) * m.duration);
    let i = 0;
    let lastPing = 0;
    for await (const w of sink.canvasesAtTimestamps(ts)) {
      if (w) m.thumbs.push({ t: ts[i] - m.base, url: w.canvas.toDataURL('image/jpeg', 0.7) });
      i++;
      const now = performance.now();
      if (i === 1 || now - lastPing > 400) {
        lastPing = now;
        onUpdate && onUpdate(m);
      }
    }
    onUpdate && onUpdate(m);
  } catch (e) {
    console.warn('thumbnails failed', e);
  }
}

async function makeWaveform(m, onUpdate) {
  try {
    const rate = m.peakRate;
    const peaks = new Float32Array(Math.ceil(m.duration * rate) + 1);
    const sink = new AudioBufferSink(m.at);
    let lastPing = performance.now();
    for await (const { buffer, timestamp } of sink.buffers()) {
      const ch = buffer.getChannelData(0);
      const sr = buffer.sampleRate;
      const step = Math.max(1, Math.floor(sr / rate / 8));
      for (let i = 0; i < ch.length; i += step) {
        const k = Math.floor((timestamp - m.base + i / sr) * rate);
        if (k >= 0 && k < peaks.length) {
          const v = Math.abs(ch[i]);
          if (v > peaks[k]) peaks[k] = v;
        }
      }
      if (performance.now() - lastPing > 500) {
        lastPing = performance.now();
        m.peaks = peaks;
        onUpdate && onUpdate(m);
      }
    }
    m.peaks = peaks;
    m.peakMax = peaks.reduce((a, v) => Math.max(a, v), 0);
    onUpdate && onUpdate(m);
  } catch (e) {
    console.warn('waveform failed', e);
  }
}

/** Wraps a decoded VideoSample as a drawable source for the compositor. */
export function sampleSource(sample) {
  if (!sample) return null;
  return {
    img: sample.toCanvasImageSource(),
    w: sample.squarePixelWidth,
    h: sample.squarePixelHeight,
    rot: sample.rotation || 0,
    flip: !!sample.flip,
  };
}

export function bitmapSource(bmp) {
  return bmp ? { img: bmp, w: bmp.width, h: bmp.height, rot: 0, flip: false } : null;
}

/**
 * Sequential frame reader: hands out the frame that should be on screen at a source timestamp.
 * Used by both the exporter (awaiting) and the preview (non-blocking).
 */
export class FrameCursor {
  constructor(sink, startTs, endTs) {
    this.it = sink.samples(Math.max(0, startTs), endTs);
    this.cur = null;
    this.next = null;
    this.done = false;
    this.closed = false;
    this.pending = null;
  }
  async pull() {
    if (this.done || this.closed) return null;
    const r = await this.it.next();
    if (r.done) {
      this.done = true;
      return null;
    }
    if (this.closed) {
      r.value.close();
      return null;
    }
    return r.value;
  }
  async init() {
    const a = await this.pull();
    if (this.closed) return a && a.close();
    this.cur = a;
    const b = await this.pull();
    if (this.closed) return b && b.close();
    this.next = b;
  }
  /** Await-based advance (export). */
  async advanceTo(ts) {
    while (this.next && this.next.timestamp <= ts + 1e-4) {
      this.cur && this.cur.close();
      this.cur = this.next;
      this.next = await this.pull();
    }
    return this.cur;
  }
  /** Non-blocking advance (preview). Fetches ahead in the background. */
  poll(ts) {
    while (this.next && this.next.timestamp <= ts + 1e-4) {
      this.cur && this.cur.close();
      this.cur = this.next;
      this.next = null;
    }
    if (!this.next && !this.done && !this.pending && !this.closed) {
      this.pending = this.pull().then((s) => {
        this.pending = null;
        if (this.closed) {
          s && s.close();
          return;
        }
        this.next = s;
      });
    }
    return this.cur;
  }
  close() {
    this.closed = true;
    this.cur && this.cur.close();
    this.next && this.next.close();
    this.cur = this.next = null;
    try {
      this.it.return();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Sequential audio reader for one clip: yields AudioBuffers with their source timestamps.
 */
export class AudioCursor {
  constructor(track, startTs, endTs) {
    this.sink = new AudioBufferSink(track);
    this.it = this.sink.buffers(Math.max(0, startTs), endTs);
    this.queue = [];
    this.done = false;
  }
  /** Ensures buffered audio covers up to source timestamp ts. */
  async fillTo(ts) {
    while (!this.done) {
      const last = this.queue[this.queue.length - 1];
      if (last && last.timestamp + last.buffer.duration >= ts) break;
      const r = await this.it.next();
      if (r.done) {
        this.done = true;
        break;
      }
      this.queue.push(r.value);
    }
  }
  dropBefore(ts) {
    while (this.queue.length && this.queue[0].timestamp + this.queue[0].buffer.duration < ts) this.queue.shift();
  }
  close() {
    this.done = true;
    this.queue = [];
    try {
      this.it.return();
    } catch {
      /* ignore */
    }
  }
}
