// Export: renders every frame at full resolution, mixes audio, encodes with WebCodecs, writes MP4.
import {
  Output,
  Mp4OutputFormat,
  StreamTarget,
  CanvasSource,
  AudioBufferSource,
  Quality,
  canEncodeVideo,
  canEncodeAudio,
} from 'mediabunny';
import { activeAt, musicLayout, clipGain, musicGain, renderComposite, outputSize } from './engine.js';
import { FrameCursor, AudioCursor, sampleSource, bitmapSource, decodeImageForExport } from './media.js';

const SAMPLE_RATE = 48000;

export function estimateBitrate(width, height, fps, codec, quality) {
  const bpp = quality === 'max' ? 0.24 : 0.15;
  let br = width * height * fps * bpp * (fps > 30 ? 0.8 : 1);
  if (codec === 'hevc') br *= 0.6;
  return Math.round(Math.min(br, 160e6));
}

/** Picks the first codec this device can encode at the requested size. */
export async function chooseVideoCodec(preferred, width, height, fps, quality) {
  const order = preferred === 'hevc' ? ['hevc', 'avc'] : ['avc', 'hevc'];
  for (const codec of order) {
    const bitrate = estimateBitrate(width, height, fps, codec, quality);
    try {
      if (await canEncodeVideo(codec, { width, height, bitrate })) return { codec, bitrate };
    } catch {
      /* try next */
    }
  }
  return null;
}

let aacRegistered = false;
export async function chooseAudioCodec() {
  if (await canEncodeAudio('aac', { numberOfChannels: 2, sampleRate: SAMPLE_RATE, bitrate: 192000 }).catch(() => false))
    return 'aac';
  // No native AAC encoder (e.g. Linux, some Safari versions): load the bundled one.
  if (!aacRegistered) {
    try {
      const mod = await import('@mediabunny/aac-encoder');
      mod.registerAacEncoder();
      aacRegistered = true;
    } catch (e) {
      console.warn('AAC fallback unavailable', e);
    }
  }
  if (aacRegistered) return 'aac';
  if (await canEncodeAudio('opus').catch(() => false)) return 'opus';
  return null;
}

/** A writable that assembles random-access writes into a Blob (used when no file system access). */
function blobWritable() {
  let blob = new Blob([]);
  const state = { blob: null };
  const writable = new WritableStream({
    write(chunk) {
      const { data, position } = chunk;
      const size = blob.size;
      if (position === size) blob = new Blob([blob, data]);
      else if (position > size) blob = new Blob([blob, new Uint8Array(position - size), data]);
      else {
        const end = position + data.byteLength;
        blob = new Blob([blob.slice(0, position), data, end < size ? blob.slice(end) : new Blob([])]);
      }
    },
    close() {
      state.blob = blob;
    },
  });
  return { writable, state };
}

/**
 * Where the export goes. Desktop Chrome/Edge: straight to a file the user picks.
 * Elsewhere: browser storage (OPFS) if available, otherwise an in-memory Blob.
 * Must be called from a click handler (the save dialog needs a user gesture).
 */
export async function prepareTarget(fileName, allowPicker) {
  if (allowPicker && window.showSaveFilePicker && window.top === window.self) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: fileName,
        types: [{ description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }],
      });
      const writable = await handle.createWritable();
      return { kind: 'disk', writable, handle, fileName: handle.name };
    } catch (e) {
      if (e && e.name === 'AbortError') return null;
      console.warn('save picker failed, falling back', e);
    }
  }
  try {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle('seam-export.mp4', { create: true });
    if (handle.createWritable) {
      const writable = await handle.createWritable();
      return { kind: 'opfs', writable, handle, fileName };
    }
  } catch (e) {
    console.warn('OPFS unavailable', e);
  }
  const { writable, state } = blobWritable();
  return { kind: 'blob', writable, state, fileName };
}

export async function finishTarget(target) {
  if (target.kind === 'disk') return { file: null, savedToDisk: true, name: target.fileName };
  if (target.kind === 'opfs') {
    const f = await target.handle.getFile();
    return { file: new File([f], target.fileName, { type: 'video/mp4' }), name: target.fileName };
  }
  return { file: new File([target.state.blob], target.fileName, { type: 'video/mp4' }), name: target.fileName };
}

export async function abortTarget(target) {
  try {
    await target.writable.abort();
  } catch {
    /* ignore */
  }
  if (target.kind === 'opfs') {
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry('seam-export.mp4');
    } catch {
      /* ignore */
    }
  }
}

/**
 * Runs the export. project = { layout, audio, media }, opts = { aspect, res, fps, codec, quality }.
 * onProgress({ done, total, fps, frameCanvas }) is called periodically.
 */
export async function runExport(project, opts, target, onProgress, signal) {
  const { layout, media } = project;
  const { width: W, height: H } = outputSize(opts.aspect, opts.res);
  const fps = opts.fps;
  const total = layout.total;
  const frameCount = Math.max(1, Math.round(total * fps));

  const vc = await chooseVideoCodec(opts.codec, W, H, fps, opts.quality);
  if (!vc) {
    throw new Error(
      `This device can’t encode ${W}×${H} video. Try a lower resolution in the export settings.`,
    );
  }

  const music = musicLayout(project.audio, total);
  const audioItems = [];
  for (const it of layout.items) {
    const c = it.clip;
    const m = media.get(c.mediaId);
    if (c.type === 'video' && m && m.at && !c.muted && c.volume > 0) {
      audioItems.push({ m, start: it.start, end: it.end, srcIn: c.in, gainAt: (x) => clipGain(it, x) });
    }
  }
  for (const mm of music) {
    const m = media.get(mm.clip.mediaId);
    if (m && m.at && mm.clip.volume > 0)
      audioItems.push({ m, start: mm.start, end: mm.end, srcIn: mm.clip.in, gainAt: (x) => musicGain(mm, x) });
  }
  const acodec = audioItems.length ? await chooseAudioCodec() : null;
  if (audioItems.length && !acodec) throw new Error('This browser can’t encode audio. Try Chrome or Edge.');

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { alpha: false });

  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: false }),
    target: new StreamTarget(target.writable, { chunked: true, chunkSize: 8 * 1024 * 1024 }),
  });
  const videoSource = new CanvasSource(canvas, {
    codec: vc.codec,
    quality: new Quality({ bitrate: vc.bitrate }),
    keyFrameInterval: 2,
    latencyMode: 'quality',
  });
  output.addVideoTrack(videoSource, { frameRate: fps });
  let audioSource = null;
  if (acodec) {
    audioSource = new AudioBufferSource({ codec: acodec, quality: new Quality({ bitrate: 256000 }) });
    output.addAudioTrack(audioSource);
  }
  await output.start();

  const cursors = new Map(); // clip id -> FrameCursor | ImageBitmap
  const audioCursors = new Map(); // audio item -> AudioCursor
  const closeAll = () => {
    for (const v of cursors.values()) v && v.close && v.close();
    cursors.clear();
    for (const a of audioCursors.values()) a.close();
    audioCursors.clear();
  };

  const AUDIO_WINDOW = 4;
  let audioDoneUntil = 0;
  const mixAudioWindow = async (w0) => {
    const w1 = Math.min(total, w0 + AUDIO_WINDOW);
    const len = Math.max(1, Math.round((w1 - w0) * SAMPLE_RATE));
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const oac = new OAC(2, len, SAMPLE_RATE);
    for (const a of audioItems) {
      if (a.end <= w0 || a.start >= w1) {
        if (a.end <= w0 && audioCursors.has(a)) {
          audioCursors.get(a).close();
          audioCursors.delete(a);
        }
        continue;
      }
      const m = a.m;
      let cur = audioCursors.get(a);
      if (!cur) {
        const srcStart = m.base + a.srcIn + Math.max(0, w0 - a.start);
        cur = new AudioCursor(m.at, srcStart, m.base + a.srcIn + (a.end - a.start));
        audioCursors.set(a, cur);
      }
      const toSrc = (x) => m.base + a.srcIn + (x - a.start);
      await cur.fillTo(toSrc(w1));
      const g = oac.createGain();
      // Gain envelope sampled every 20 ms.
      const segStart = Math.max(w0, a.start);
      const segEnd = Math.min(w1, a.end);
      g.gain.setValueAtTime(a.gainAt(segStart), segStart - w0);
      for (let x = segStart + 0.02; x < segEnd; x += 0.02) g.gain.linearRampToValueAtTime(a.gainAt(x), x - w0);
      g.gain.linearRampToValueAtTime(a.gainAt(segEnd), segEnd - w0);
      g.connect(oac.destination);
      for (const { buffer, timestamp } of cur.queue) {
        const pos = a.start + (timestamp - m.base - a.srcIn);
        if (pos >= w1 || pos + buffer.duration <= w0) continue;
        const node = oac.createBufferSource();
        node.buffer = buffer;
        node.connect(g);
        const when = pos - w0;
        if (when < 0) node.start(0, -when);
        else node.start(when);
        node.stop(segEnd - w0);
      }
      cur.dropBefore(toSrc(w1) - 0.5);
    }
    const rendered = await oac.startRendering();
    await audioSource.add(rendered);
    audioDoneUntil = w1;
  };

  const getVideoSource = async (it, t) => {
    const c = it.clip;
    const m = media.get(c.mediaId);
    if (!m) return null;
    if (c.type === 'image') {
      let bmp = cursors.get(c.id);
      if (!bmp) {
        bmp = await decodeImageForExport(m, W, H);
        cursors.set(c.id, bmp);
      }
      return bitmapSource(bmp);
    }
    if (!m.videoSink) return null;
    let cur = cursors.get(c.id);
    const ts = m.base + c.in + (t - it.start);
    if (!cur) {
      cur = new FrameCursor(m.videoSink, ts, m.base + c.out + 0.1);
      await cur.init();
      cursors.set(c.id, cur);
    }
    return sampleSource(await cur.advanceTo(ts));
  };

  const started = performance.now();
  let lastReport = 0;
  try {
    for (let n = 0; n < frameCount; n++) {
      if (signal.aborted) throw new DOMException('Export cancelled', 'AbortError');
      const t = n / fps;
      if (audioSource) {
        while (audioDoneUntil < total && audioDoneUntil <= t + 0.5) await mixAudioWindow(audioDoneUntil);
      }
      const actives = activeAt(layout, t);
      // Release clips that are finished.
      for (const [id, v] of cursors) {
        if (!actives.some((it) => it.clip.id === id)) {
          v && v.close && v.close();
          cursors.delete(id);
        }
      }
      const srcs = new Map();
      for (const it of actives) srcs.set(it, await getVideoSource(it, t));
      renderComposite(ctx, W, H, t, actives, (it) => srcs.get(it));
      await videoSource.add(t, 1 / fps);
      const now = performance.now();
      if (now - lastReport > 250 || n === frameCount - 1) {
        lastReport = now;
        onProgress({ done: n + 1, total: frameCount, fps: (n + 1) / ((now - started) / 1000), canvas });
      }
    }
    if (audioSource) while (audioDoneUntil < total - 1e-6) await mixAudioWindow(audioDoneUntil);
    closeAll();
    await output.finalize();
  } catch (e) {
    closeAll();
    try {
      await output.cancel();
    } catch {
      /* ignore */
    }
    throw e;
  }
  return { width: W, height: H, codec: vc.codec, bitrate: vc.bitrate, audioCodec: acodec };
}
