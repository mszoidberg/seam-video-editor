// Live preview: decodes frames with WebCodecs and plays sound through one AudioContext,
// which is also the master clock (keeps picture and sound in sync, and works on iOS).
import { computeLayout, activeAt, musicLayout, clipGain, musicGain, renderComposite } from './engine.js';
import { FrameCursor, AudioCursor, sampleSource, bitmapSource } from './media.js';

export class Player {
  constructor(canvas, getProject, onTime, onEnd) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.getProject = getProject;
    this.onTime = onTime;
    this.onEnd = onEnd;
    this.playing = false;
    this.time = 0;
    this.audioCtx = null;
    this.videoStreams = new Map();
    this.audioStreams = new Map();
    this.gen = 0;
    this.stillToken = 0;
    this.stillBusy = false;
    this.stillWanted = null;
    this.stillSamples = new Map();
  }

  ensureAudio() {
    if (!this.audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = new AC({ latencyHint: 'playback' });
      this.master = this.audioCtx.createGain();
      this.master.connect(this.audioCtx.destination);
      try {
        // Play through the iPhone silent switch, like a video app.
        if (navigator.audioSession) navigator.audioSession.type = 'playback';
      } catch {
        /* ignore */
      }
    }
    if (this.audioCtx.state !== 'running') this.audioCtx.resume();
    return this.audioCtx;
  }

  now() {
    if (!this.playing) return this.time;
    return Math.max(this.t0, this.t0 + (this.audioCtx.currentTime - this.c0));
  }

  async play() {
    const { layout } = this.getProject();
    if (!layout.items.length) return;
    if (this.time >= layout.total - 0.05) this.time = 0;
    const ac = this.ensureAudio();
    this.clearStill();
    this.playing = true;
    this.gen++;
    this.t0 = this.time;
    this.c0 = ac.currentTime + 0.12;
    this.tick();
  }

  pause() {
    if (!this.playing) return;
    this.time = this.now();
    this.playing = false;
    this.gen++;
    cancelAnimationFrame(this.raf);
    this.stopStreams();
    this.renderStill(this.time);
  }

  seek(t) {
    const { layout } = this.getProject();
    t = Math.max(0, Math.min(t, layout.total));
    if (this.playing) {
      this.time = t;
      this.stopStreams();
      this.gen++;
      this.t0 = t;
      this.c0 = this.audioCtx.currentTime + 0.12;
    } else {
      this.time = t;
      this.renderStill(t);
    }
  }

  stopStreams() {
    for (const s of this.videoStreams.values()) s.cursor && s.cursor.close();
    this.videoStreams.clear();
    for (const s of this.audioStreams.values()) {
      s.cancelled = true;
      s.cursor && s.cursor.close();
      for (const n of s.nodes) {
        try {
          n.stop();
        } catch {
          /* ignore */
        }
      }
      try {
        s.gain.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.audioStreams.clear();
  }

  /** Called after any edit: restart streams so changes are heard/seen immediately. */
  invalidate() {
    if (this.playing) {
      const t = this.now();
      this.stopStreams();
      this.gen++;
      this.t0 = t;
      this.time = t;
      this.c0 = this.audioCtx.currentTime + 0.08;
    } else {
      this.clearStill();
      this.renderStill(this.time);
    }
  }

  tick() {
    if (!this.playing) return;
    const proj = this.getProject();
    const { layout } = proj;
    const t = this.now();
    if (t >= layout.total) {
      this.time = layout.total;
      this.playing = false;
      this.stopStreams();
      this.renderStill(this.time);
      this.onTime(this.time);
      this.onEnd && this.onEnd();
      return;
    }
    this.syncVideo(proj, t);
    this.syncAudio(proj, t);
    this.draw(proj, t, true);
    this.onTime(t);
    this.raf = requestAnimationFrame(() => this.tick());
  }

  syncVideo(proj, t) {
    const { layout, media } = proj;
    const want = new Set();
    for (const it of layout.items) {
      if (it.end <= t) continue;
      if (it.start > t + 1.2) break;
      const c = it.clip;
      const m = media.get(c.mediaId);
      if (!m || c.type !== 'video' || !m.videoSink) continue;
      want.add(c.id);
      if (!this.videoStreams.has(c.id)) {
        const startTs = m.base + c.in + Math.max(0, t - it.start);
        const cursor = new FrameCursor(m.videoSink, startTs, m.base + c.out + 0.05);
        cursor.init().catch((e) => console.warn(e));
        this.videoStreams.set(c.id, { cursor, item: it });
      }
    }
    for (const [id, s] of this.videoStreams) {
      if (!want.has(id)) {
        s.cursor.close();
        this.videoStreams.delete(id);
      }
    }
  }

  syncAudio(proj, t) {
    const { layout, media } = proj;
    const ac = this.audioCtx;
    const items = [];
    for (const it of layout.items) {
      const c = it.clip;
      if (c.type !== 'video' || c.muted || !(c.volume > 0)) continue;
      const m = media.get(c.mediaId);
      if (!m || !m.at) continue;
      items.push({ key: c.id, start: it.start, end: it.end, srcIn: c.in, m, gainAt: (x) => clipGain(it, x) });
    }
    for (const mm of musicLayout(proj.audio, layout.total)) {
      const c = mm.clip;
      const m = media.get(c.mediaId);
      if (!m || !m.at || !(c.volume > 0)) continue;
      items.push({ key: c.id, start: mm.start, end: mm.end, srcIn: c.in, m, gainAt: (x) => musicGain(mm, x) });
    }
    const want = new Set();
    for (const a of items) {
      if (a.end <= t || a.start > t + 1.5) continue;
      want.add(a.key);
      let s = this.audioStreams.get(a.key);
      if (!s) {
        const gain = ac.createGain();
        gain.gain.value = a.gainAt(Math.max(t, a.start));
        gain.connect(this.master);
        s = { a, gain, nodes: new Set(), cancelled: false };
        this.audioStreams.set(a.key, s);
        this.feedAudio(s, t, this.gen);
      }
      s.gain.gain.setTargetAtTime(a.gainAt(t + 0.03), ac.currentTime, 0.015);
    }
    for (const [k, s] of this.audioStreams) {
      if (!want.has(k)) {
        s.cancelled = true;
        s.cursor && s.cursor.close();
        setTimeout(() => {
          try {
            s.gain.disconnect();
          } catch {
            /* ignore */
          }
        }, 300);
        this.audioStreams.delete(k);
      }
    }
  }

  async feedAudio(s, tStart, gen) {
    const { a } = s;
    const ac = this.audioCtx;
    const m = a.m;
    const srcStart = m.base + a.srcIn + Math.max(0, tStart - a.start);
    const srcEnd = m.base + a.srcIn + (a.end - a.start);
    const cursor = new AudioCursor(m.at, srcStart, srcEnd);
    s.cursor = cursor;
    try {
      for await (const { buffer, timestamp } of cursor.it) {
        if (s.cancelled || gen !== this.gen) break;
        const pos = a.start + (timestamp - m.base - a.srcIn); // timeline position of the buffer
        const when = this.c0 + (pos - this.t0);
        const endWhen = this.c0 + (a.end - this.t0);
        const node = ac.createBufferSource();
        node.buffer = buffer;
        node.connect(s.gain);
        const now = ac.currentTime;
        if (when + buffer.duration <= now) continue;
        if (when < now) node.start(now, now - when);
        else node.start(when);
        node.stop(Math.max(now, endWhen));
        s.nodes.add(node);
        node.onended = () => s.nodes.delete(node);
        // Stay about a second ahead of the playhead.
        while (!s.cancelled && gen === this.gen && pos - this.now() > 1.0) {
          await new Promise((r) => setTimeout(r, 120));
        }
      }
    } catch (e) {
      if (!s.cancelled) console.warn('audio preview', e);
    }
  }

  sizeCanvas(W, H) {
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W;
      this.canvas.height = H;
    }
  }

  draw(proj, t, live) {
    const { layout, media } = proj;
    const actives = activeAt(layout, t);
    const W = this.canvas.width;
    const H = this.canvas.height;
    const sources = new Map();
    let missing = false;
    for (const it of actives) {
      const c = it.clip;
      const m = media.get(c.mediaId);
      let src = null;
      if (m && c.type === 'image') src = bitmapSource(m.preview);
      else if (m && live) {
        const s = this.videoStreams.get(c.id);
        if (s) {
          const ts = m.base + c.in + (t - it.start);
          src = sampleSource(s.cursor.poll(ts));
        }
        if (!src && m.videoSink) missing = true;
      } else if (m) {
        const smp = this.stillSamples.get(c.id);
        src = smp ? sampleSource(smp) : null;
      }
      sources.set(it, src);
    }
    // Avoid flashing black while the first frame of a clip is still decoding.
    if (live && missing && this.hasDrawn) return;
    renderComposite(this.ctx, W, H, t, actives, (it) => sources.get(it));
    this.hasDrawn = true;
  }

  clearStill() {
    for (const s of this.stillSamples.values()) s && s.close();
    this.stillSamples.clear();
  }

  /** Draws a paused frame. Coalesces rapid requests (scrubbing). */
  renderStill(t) {
    this.stillWanted = t;
    if (this.stillBusy) return;
    this.stillBusy = true;
    const run = async () => {
      while (this.stillWanted !== null && !this.playing) {
        const tt = this.stillWanted;
        this.stillWanted = null;
        const proj = this.getProject();
        const actives = activeAt(proj.layout, tt);
        const next = new Map();
        for (const it of actives) {
          const c = it.clip;
          const m = proj.media.get(c.mediaId);
          if (c.type !== 'video' || !m || !m.videoSink) continue;
          const ts = m.base + c.in + Math.min(tt - it.start, it.dur - 0.001);
          try {
            let smp = await m.videoSink.getSample(ts);
            if (!smp) smp = await m.videoSink.getSample(m.base + c.in + 0.05);
            next.set(c.id, smp);
          } catch (e) {
            console.warn(e);
          }
        }
        if (this.playing) {
          for (const s of next.values()) s && s.close();
          break;
        }
        this.clearStill();
        this.stillSamples = next;
        this.draw(proj, tt, false);
      }
      this.stillBusy = false;
    };
    run();
  }

  redraw() {
    if (this.playing) return;
    this.draw(this.getProject(), this.time, false);
  }
}

export { computeLayout };
