/*
 * render.js — Videcutto's export engine.
 *
 * Decodes the clips of the timeline with WebCodecs (hardware-accelerated where
 * the device supports it), composes every frame onto a canvas (fit with black
 * bars or a blurred background, rotation applied), encodes to H.264 or HEVC
 * plus AAC (Opus as fallback) and muxes everything into an MP4 via mp4.js.
 */
(function (global) {
  'use strict';

  const MP4 = global.MP4;
  const OUT_RATE = 48000;
  const OUT_CHANNELS = 2;

  // ---------------------------------------------------------------------------
  // Quality
  // ---------------------------------------------------------------------------
  // Bits per pixel per frame for the quality presets (at 30 fps).
  const QUALITY = { small: 0.05, standard: 0.08, high: 0.14 };

  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  const isVideo = (s) => s && (s.kind === 'video' || !s.kind);

  // Display (rotation-applied) size of a source.
  function displaySize(src) {
    const r = src.rotation === 90 || src.rotation === 270;
    return r ? { w: src.height, h: src.width } : { w: src.width, h: src.height };
  }

  // 60 fps needs more bits than 30 fps, but not twice as many.
  const fpsFactor = (fps) => (fps <= 30 ? fps : 30 + (fps - 30) * 0.5);

  /** Bitrate a quality preset uses for a given size and frame rate. */
  function presetBitrate(quality, w, h, fps) {
    return Math.round(w * h * fpsFactor(fps) * (QUALITY[quality] || QUALITY.standard));
  }

  /**
   * Work out the final output parameters.
   * @param settings { width, height, fps, quality: small|standard|high|custom|target, bitrateMbps, targetMB, lockRes }
   * @param sources  all sources used on the timeline (videos and images)
   * @param duration timeline duration in seconds
   */
  function computeOutput(settings, sources, duration) {
    const vids = sources.filter(isVideo);
    const maxFps = vids.length ? Math.max(...vids.map((s) => s.frameRate || 30)) : 30;
    let fps;
    if (settings.fps === 'original') fps = Math.min(60, Math.round(maxFps));
    else fps = Number(settings.fps) || 30;
    // Don't invent frames the sources don't have (stills are fine at any rate).
    if (vids.length && settings.fps !== 'original') fps = Math.min(fps, Math.max(24, Math.round(maxFps)));

    let w = even(settings.width || 1920), h = even(settings.height || 1080);
    let audioBitrate = 128_000;
    let bitrate;
    let scaled = false;

    if (settings.quality === 'custom') {
      bitrate = Math.round(Math.min(100, Math.max(0.1, settings.bitrateMbps || 5)) * 1e6);
    } else if (settings.quality === 'target') {
      const totalBits = Math.max(0.2, settings.targetMB || 25) * 8e6 * 0.96;
      const perSec = totalBits / Math.max(0.5, duration);
      audioBitrate = perSec > 1_000_000 ? 128_000 : perSec > 400_000 ? 96_000 : 64_000;
      bitrate = Math.max(120_000, perSec - audioBitrate);
      if (!settings.lockRes) {
        // Too few bits for this many pixels looks blocky — a smaller picture with
        // enough bits looks better. Keep at least ~0.06 bits per pixel.
        const need = w * h * fpsFactor(fps) * 0.06;
        if (bitrate < need) {
          const f = Math.max(Math.sqrt(bitrate / need), 240 / Math.min(w, h));
          w = even(w * f); h = even(h * f);
          scaled = true;
        }
      }
    } else {
      bitrate = presetBitrate(settings.quality, w, h, fps);
    }

    // Never spend more bits than the source videos have: re-encoding an already
    // compressed video (e.g. from Instagram or WhatsApp) at a higher bitrate
    // only makes the file bigger without improving quality.
    let capped = false;
    if (settings.quality !== 'custom') {
      const withRate = vids.filter((s) => s.videoBitrate > 0);
      const onlyVideos = withRate.length && withRate.length === sources.length;
      if (onlyVideos) {
        const cap = Math.max(...withRate.map((s) => {
          const d = displaySize(s);
          const px = Math.min(1, (w * h) / (d.w * d.h));
          const fr = Math.min(1, fps / Math.max(1, s.frameRate || fps));
          return s.videoBitrate * Math.pow(px, 0.75) * Math.pow(fr, 0.5) * 0.75;
        }));
        if (cap < bitrate) { bitrate = Math.max(250_000, Math.round(cap)); capped = true; }
      }
    }
    const srcAudio = Math.max(0, ...vids.map((s) => s.audioBitrate || 0));
    if (srcAudio > 0) audioBitrate = Math.min(audioBitrate, Math.max(64_000, Math.ceil(srcAudio / 32_000) * 32_000));

    return { width: w, height: h, fps, bitrate, audioBitrate, capped, scaled };
  }

  function estimateSize(out, duration, withAudio) {
    return ((out.bitrate + (withAudio ? out.audioBitrate : 0)) * duration) / 8 * 1.02;
  }

  // ---------------------------------------------------------------------------
  // Drawing (shared by preview and export)
  // ---------------------------------------------------------------------------
  let blurCanvas = null;
  function getBlurCanvas() {
    if (!blurCanvas) {
      blurCanvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(32, 32) : document.createElement('canvas');
    }
    return blurCanvas;
  }

  // ---------------------------------------------------------------------------
  // Per-clip transform: crop, size, anchor + offset, rotation, flip
  // ---------------------------------------------------------------------------
  // crop: normalised rect in the source's display space (after its rotation metadata).
  // fit: 'fit' (whole clip visible) | 'fill' (canvas covered) | 'free' (scale × fit size).
  // anchor: which point of the clip sits on the same point of the canvas.
  // dx, dy: extra offset as a fraction of the canvas width/height.
  const DEFAULT_TF = Object.freeze({
    crop: Object.freeze({ x: 0, y: 0, w: 1, h: 1 }), cropRatio: null,
    fit: 'fit', scale: 1, anchor: 'c', dx: 0, dy: 0, rot: 0, flipH: false, flipV: false,
  });
  const ANCHORS = { tl: [0, 0], t: [0.5, 0], tr: [1, 0], l: [0, 0.5], c: [0.5, 0.5], r: [1, 0.5], bl: [0, 1], b: [0.5, 1], br: [1, 1] };
  const tfOf = (tf) => (tf ? { ...DEFAULT_TF, ...tf, crop: { ...DEFAULT_TF.crop, ...(tf.crop || {}) } } : { ...DEFAULT_TF, crop: { ...DEFAULT_TF.crop } });

  /**
   * Where a clip lands on a W×H canvas. cw/ch: size of the cropped picture in
   * source pixels. Returns the centre (cx, cy), the drawn size of the picture
   * (dw, dh), the scale and the axis-aligned bounding box size (bbW, bbH).
   */
  function clipLayout(cw, ch, W, H, tfIn) {
    const t = tfOf(tfIn);
    const rad = t.rot * Math.PI / 180;
    const c = Math.abs(Math.cos(rad)), s = Math.abs(Math.sin(rad));
    const bw0 = cw * c + ch * s, bh0 = cw * s + ch * c;
    const fitS = Math.min(W / bw0, H / bh0);
    const fillS = Math.max(W / bw0, H / bh0);
    const sc = t.fit === 'fill' ? fillS : t.fit === 'free' ? fitS * t.scale : fitS;
    const bbW = bw0 * sc, bbH = bh0 * sc;
    const [ax, ay] = ANCHORS[t.anchor] || ANCHORS.c;
    return {
      cx: ax * (W - bbW) + bbW / 2 + t.dx * W,
      cy: ay * (H - bbH) + bbH / 2 + t.dy * H,
      dw: cw * sc, dh: ch * sc, s: sc, bbW, bbH, fitS, fillS, rad, t,
    };
  }

  /**
   * Draw one clip onto the canvas (background first).
   * src: VideoFrame / <video> / ImageBitmap / canvas; rawW/rawH its size;
   * metaRot: rotation stored in the file (clockwise degrees).
   * bgMode: 'blur' or anything else for the plain colour bg.
   */
  function drawClip(ctx, src, rawW, rawH, metaRot, W, H, tfIn, bgMode, bg) {
    const r = ((metaRot || 0) % 360 + 360) % 360;
    const rotated = r === 90 || r === 270;
    const sw = rotated ? rawH : rawW, sh = rotated ? rawW : rawH;
    const g = clipLayout(sw * tfOf(tfIn).crop.w, sh * tfOf(tfIn).crop.h, W, H, tfIn);
    const t = g.t;

    ctx.save();
    if (bg !== null) { // null: draw only the clip (a layer of a composition)
      ctx.fillStyle = bg || '#000';
      ctx.fillRect(0, 0, W, H);
      if (bgMode === 'blur') drawBlurBg(ctx, src, rawW, rawH, r, sw, sh, W, H);
    }

    ctx.translate(g.cx, g.cy);
    ctx.rotate(g.rad);
    ctx.scale(t.flipH ? -1 : 1, t.flipV ? -1 : 1);
    ctx.beginPath();
    ctx.rect(-g.dw / 2, -g.dh / 2, g.dw, g.dh);
    ctx.clip();
    // Full (uncropped) picture positioned so that the crop rect fills the clip.
    const fw = sw * g.s, fh = sh * g.s;
    const x0 = -g.dw / 2 - t.crop.x * fw, y0 = -g.dh / 2 - t.crop.y * fh;
    ctx.translate(x0 + fw / 2, y0 + fh / 2);
    ctx.rotate(r * Math.PI / 180);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, -rawW * g.s / 2, -rawH * g.s / 2, rawW * g.s, rawH * g.s);
    ctx.restore();
  }

  // Cheap, universally supported blur: draw tiny, then scale up smoothly.
  function drawBlurBg(ctx, src, rawW, rawH, r, sw, sh, W, H) {
    const bc = getBlurCanvas();
    const small = 24;
    const bw = W >= H ? small : Math.max(4, Math.round(small * W / H));
    const bh = W >= H ? Math.max(4, Math.round(small * H / W)) : small;
    bc.width = bw; bc.height = bh;
    const bctx = bc.getContext('2d');
    const cover = Math.max(bw / sw, bh / sh);
    bctx.save();
    bctx.translate(bw / 2, bh / 2);
    bctx.rotate(r * Math.PI / 180);
    bctx.drawImage(src, -rawW * cover / 2, -rawH * cover / 2, rawW * cover, rawH * cover);
    bctx.restore();
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bc, -W * 0.05, -H * 0.05, W * 1.1, H * 1.1);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  // Capability checks
  // ---------------------------------------------------------------------------
  function hasWebCodecs() {
    return typeof VideoDecoder !== 'undefined' && typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';
  }

  function videoDecoderConfig(track) {
    const cfg = { codec: track.codecString, codedWidth: track.codedWidth, codedHeight: track.codedHeight };
    if (track.description) cfg.description = track.description;
    return cfg;
  }

  async function canDecodeVideo(track) {
    if (!hasWebCodecs() || !track.codecString) return false;
    try { return (await VideoDecoder.isConfigSupported(videoDecoderConfig(track))).supported === true; } catch (e) { return false; }
  }

  function audioDecoderConfig(track) {
    const cfg = { codec: track.codecString, sampleRate: track.sampleRate, numberOfChannels: track.channels };
    if (track.description && track.codec === 'aac') cfg.description = track.description;
    return cfg;
  }

  async function canDecodeAudio(track) {
    if (typeof AudioDecoder === 'undefined' || !track || !track.codecString) return false;
    try { return (await AudioDecoder.isConfigSupported(audioDecoderConfig(track))).supported === true; } catch (e) { return false; }
  }

  // H.264 level selection by frame size and macroblock rate.
  const AVC_LEVELS = [
    [0x1f, 3600, 108000], [0x20, 5120, 216000], [0x28, 8192, 245760], [0x2a, 8704, 522240],
    [0x32, 22080, 589824], [0x33, 36864, 983040], [0x34, 36864, 2073600],
  ];
  const HEVC_LEVELS = [ // level_idc, max luma samples, max luma rate
    [93, 983040, 33177600], [120, 2228224, 66846720], [123, 2228224, 133693440],
    [150, 8912896, 267386880], [153, 8912896, 534773760], [156, 8912896, 1069547520],
  ];

  function avcCodecs(w, h, fps) {
    const mbs = Math.ceil(w / 16) * Math.ceil(h / 16);
    const lvl = (AVC_LEVELS.find(([, fs, rate]) => mbs <= fs && mbs * fps <= rate) || AVC_LEVELS[AVC_LEVELS.length - 1])[0];
    const L = lvl.toString(16).toUpperCase().padStart(2, '0');
    return [`avc1.6400${L}`, `avc1.4D00${L}`, `avc1.4200${L}`, `avc1.42E0${L}`];
  }
  function hevcCodecs(w, h, fps) {
    const lum = w * h;
    const lvl = (HEVC_LEVELS.find(([, fs, rate]) => lum <= fs && lum * fps <= rate) || HEVC_LEVELS[HEVC_LEVELS.length - 1])[0];
    return [`hvc1.1.6.L${lvl}.B0`, `hev1.1.6.L${lvl}.B0`];
  }

  async function pickVideoEncoder(codec, w, h, fps, bitrate) {
    const list = codec === 'hevc' ? hevcCodecs(w, h, fps) : avcCodecs(w, h, fps);
    for (const c of list) {
      for (const hw of ['prefer-hardware', 'no-preference']) {
        const cfg = { codec: c, width: w, height: h, bitrate, framerate: fps, bitrateMode: 'variable', latencyMode: 'quality', hardwareAcceleration: hw };
        if (codec === 'hevc') cfg.hevc = { format: 'hevc' }; else cfg.avc = { format: 'avc' };
        try {
          const r = await VideoEncoder.isConfigSupported(cfg);
          if (r.supported) return r.config || cfg;
        } catch (e) { /* try next */ }
      }
    }
    return null;
  }

  async function canEncodeHevc() {
    if (!hasWebCodecs()) return false;
    return !!(await pickVideoEncoder('hevc', 1280, 720, 30, 2_000_000));
  }

  async function pickAudioEncoder(bitrate) {
    if (typeof AudioEncoder === 'undefined') return null;
    const candidates = [
      { kind: 'aac', cfg: { codec: 'mp4a.40.2', sampleRate: OUT_RATE, numberOfChannels: OUT_CHANNELS, bitrate, aac: { format: 'aac' } } },
      { kind: 'aac', cfg: { codec: 'mp4a.40.2', sampleRate: OUT_RATE, numberOfChannels: OUT_CHANNELS, bitrate } },
      { kind: 'opus', cfg: { codec: 'opus', sampleRate: OUT_RATE, numberOfChannels: OUT_CHANNELS, bitrate: Math.min(bitrate, 128_000) } },
    ];
    for (const c of candidates) {
      try {
        const r = await AudioEncoder.isConfigSupported(c.cfg);
        if (r.supported) return { kind: c.kind, cfg: r.config || c.cfg };
      } catch (e) { /* next */ }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(cond, signal) {
    while (!cond()) {
      if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
      await sleep(4);
    }
  }

  function makeCanvas(w, h) {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  /**
   * Draw one frame of the composition: background, optional blur from the main
   * track's picture, then every layer bottom to top with its track opacity.
   * layers: [{ drawable, w, h, rot, tf, opacity, isMain, isColor }]
   */
  function composite(ctx, W, H, layers, bgMode, bg) {
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.fillStyle = bg || '#000';
    ctx.fillRect(0, 0, W, H);
    const main = layers.find((l) => l.isMain);
    if (bgMode === 'blur' && main && !main.isColor) {
      const r = ((main.rot || 0) % 360 + 360) % 360;
      const rotated = r === 90 || r === 270;
      drawBlurBg(ctx, main.drawable, main.w, main.h, r, rotated ? main.h : main.w, rotated ? main.w : main.h, W, H);
    }
    for (const l of layers) {
      ctx.globalAlpha = l.opacity == null ? 1 : l.opacity;
      drawClip(ctx, l.drawable, l.w, l.h, l.rot, W, H, l.tf, 'none', null);
    }
    ctx.restore();
  }

  // Clip of a track that is visible at time t (tracks keep clips sorted by start).
  function clipAtTime(trackClips, t) {
    for (const c of trackClips) if (t >= c.start - 1e-6 && t < c.start + (c.out - c.in) - 1e-6) return c;
    return null;
  }

  /** Decodes one video clip forward and hands out the frame for a given time. */
  class VideoReader {
    constructor(clip) {
      this.clip = clip;
      this.track = clip.source.demux.video;
      this.reader = new MP4.BlobReader(clip.source.file);
      this.s = this.track.samples;
      this.i = MP4.keyframeBefore(this.track, clip.in);
      this.pending = [];
      this.cur = null;
      this.ended = false;
      this.flushed = false;
      this.err = null;
      this.decoder = new VideoDecoder({ output: (f) => this.pending.push(f), error: (e) => { this.err = e; } });
      this.decoder.configure(videoDecoderConfig(this.track));
    }
    async feed(signal) {
      const s = this.s;
      let n = 0;
      while (n < 4 && this.i < s.count && s.pts[this.i] < this.clip.out + 0.5) {
        const k = this.i++;
        const data = await this.reader.read(s.offsets[k], s.sizes[k]);
        this.decoder.decode(new EncodedVideoChunk({ type: s.sync[k] ? 'key' : 'delta', timestamp: Math.round(s.pts[k] * 1e6), duration: Math.round(s.dur[k] * 1e6), data }));
        n++;
      }
      if (!n) {
        if (!this.flushed) { this.flushed = true; await this.decoder.flush(); }
        this.ended = true;
        return;
      }
      await waitFor(() => this.decoder.decodeQueueSize < 3 || this.pending.length > 0 || this.err, signal);
    }
    /** Latest frame at or before t (file time). */
    async frameAt(t, signal) {
      for (;;) {
        if (this.err) throw this.err;
        while (this.pending.length && this.pending[0].timestamp / 1e6 <= t + 1e-4) {
          if (this.cur) this.cur.close();
          this.cur = this.pending.shift();
        }
        if (this.pending.length || this.ended) return this.cur || this.pending[0] || null;
        await this.feed(signal);
      }
    }
    close() {
      for (const f of this.pending) f.close();
      this.pending = [];
      if (this.cur) { this.cur.close(); this.cur = null; }
      if (this.decoder.state !== 'closed') this.decoder.close();
    }
  }

  /** Decodes one clip's audio and mixes it, resampled to 48 kHz stereo, into buffers. */
  class AudioReader {
    constructor(clip) {
      this.clip = clip;
      this.track = clip.source.demux.audio;
      this.reader = new MP4.BlobReader(clip.source.file);
      this.rate = this.track.sampleRate;
      this.step = this.rate / OUT_RATE;
      this.queue = [];
      this.buf = null; // [Float32Array L, Float32Array R]
      this.pos = 0;    // fractional read position in buf (source samples)
      this.err = null;
      this.flushed = false;
      const s = this.track.samples;
      this.i = 0;
      for (let k = 0; k < s.count; k++) if (s.pts[k] <= clip.in) this.i = k; else break;
      this.decoder = new AudioDecoder({ output: (d) => this.queue.push(d), error: (e) => { this.err = e; } });
      this.decoder.configure(audioDecoderConfig(this.track));
    }
    async more(signal) {
      // Decode until at least one block of samples is available. Returns false at the end.
      for (;;) {
        if (this.err) throw this.err;
        if (this.queue.length) break;
        const s = this.track.samples;
        let n = 0;
        while (n < 8 && this.i < s.count && s.pts[this.i] <= this.clip.out + 0.1) {
          const k = this.i++;
          const data = await this.reader.read(s.offsets[k], s.sizes[k]);
          this.decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round(s.pts[k] * 1e6), duration: Math.round(s.dur[k] * 1e6), data }));
          n++;
        }
        if (!n) {
          if (this.flushed) return false;
          this.flushed = true;
          await this.decoder.flush();
          continue;
        }
        await waitFor(() => this.decoder.decodeQueueSize < 8 || this.queue.length > 0 || this.err, signal);
      }
      while (this.queue.length) {
        const ad = this.queue.shift();
        const n = ad.numberOfFrames;
        const L = new Float32Array(n), R = new Float32Array(n);
        ad.copyTo(L, { planeIndex: 0, format: 'f32-planar' });
        if (ad.numberOfChannels > 1) ad.copyTo(R, { planeIndex: 1, format: 'f32-planar' }); else R.set(L);
        const ts = ad.timestamp / 1e6;
        ad.close();
        if (!this.buf) {
          this.buf = [L, R];
          this.pos = (this.clip.in - ts) * this.rate; // where the in-point lies in the decoded data
        } else {
          const keep = this.buf[0].length;
          const nl = new Float32Array(keep + n), nr = new Float32Array(keep + n);
          nl.set(this.buf[0]); nl.set(L, keep);
          nr.set(this.buf[1]); nr.set(R, keep);
          this.buf = [nl, nr];
        }
      }
      return true;
    }
    /** Add n output samples (from the current position) × gain into L/R starting at off. */
    async mixInto(L, R, off, n, gain, signal) {
      let produced = 0;
      while (produced < n) {
        if (this.buf) {
          const [bl, br] = this.buf;
          const len = bl.length;
          while (produced < n && this.pos + 1 < len) {
            if (this.pos >= 0) {
              const i = Math.floor(this.pos), f = this.pos - i;
              L[off + produced] += (bl[i] + (bl[i + 1] - bl[i]) * f) * gain;
              R[off + produced] += (br[i] + (br[i + 1] - br[i]) * f) * gain;
            }
            this.pos += this.step;
            produced++;
          }
          // Drop consumed samples, keep one for interpolation.
          const drop = Math.max(0, Math.floor(this.pos) - 1);
          if (drop > 0) { this.buf = [bl.slice(drop), br.slice(drop)]; this.pos -= drop; }
        }
        if (produced >= n) break;
        if (!(await this.more(signal))) break; // no more sound: the rest stays silent
      }
    }
    close() {
      for (const d of this.queue) d.close();
      this.queue = [];
      if (this.decoder.state !== 'closed') this.decoder.close();
    }
  }

  /**
   * @param opts {
   *   tracks: [{ hidden, opacity, muted, volume, clips: [{ kind, source, start, in, out, muted, tf, still }] }]
   *     — bottom (main) track first; clip in/out are in the file's time, start in timeline time
   *   duration, settings: { width, height, fps, quality, …, codec, muteAll, fit, bg },
   *   onProgress(fraction, label), signal
   * }
   * @returns { blob, warnings, out, audioCodec, videoCodec }
   */
  async function exportTimeline(opts) {
    const { tracks, settings, onProgress = () => {}, signal } = opts;
    const warnings = [];
    if (!hasWebCodecs()) throw new Error('This browser does not support WebCodecs video encoding.');
    const all = tracks.flatMap((t) => t.clips);
    if (!all.length) throw new Error('The timeline is empty.');
    const sources = [...new Set(all.map((c) => c.source).filter(Boolean))];
    const duration = opts.duration || Math.max(...all.map((c) => c.start + (c.out - c.in)));
    const out = computeOutput(settings, sources, duration);

    // Encoder selection
    let vcfg = await pickVideoEncoder(settings.codec === 'hevc' ? 'hevc' : 'avc', out.width, out.height, out.fps, out.bitrate);
    let vcodec = settings.codec === 'hevc' ? 'hevc' : 'avc';
    if (!vcfg && vcodec === 'hevc') {
      warnings.push('HEVC encoding is not available here — exported as H.264 instead.');
      vcodec = 'avc';
      vcfg = await pickVideoEncoder('avc', out.width, out.height, out.fps, out.bitrate);
    }
    if (!vcfg) throw new Error(`No video encoder available for ${out.width}×${out.height}.`);

    const audible = (t) => !settings.muteAll && !t.muted && (t.volume == null || t.volume > 0);
    const anyAudio = tracks.some((t) => audible(t) && t.clips.some((c) => c.kind === 'video' && !c.muted && c.source.audioDecodable));
    let acfg = null;
    if (anyAudio) {
      acfg = await pickAudioEncoder(out.audioBitrate);
      if (!acfg) warnings.push('This browser cannot encode audio — the video was exported without sound.');
      else if (acfg.kind === 'opus') warnings.push('AAC encoding is not available in this browser — audio was encoded as Opus instead (plays everywhere except some older Apple devices).');
    }

    const muxer = new MP4.Muxer({
      video: { codec: vcodec, width: out.width, height: out.height },
      audio: acfg ? { codec: acfg.kind, sampleRate: OUT_RATE, channels: OUT_CHANNELS, bitrate: out.audioBitrate } : null,
    });

    const audioShare = acfg ? 0.12 : 0;
    await encodeVideo({ tracks, settings, out, vcfg, muxer, signal, duration, onProgress: (f) => onProgress(f * (1 - audioShare), 'video') });
    if (acfg) {
      await encodeAudio({ tracks, settings, acfg, muxer, signal, duration, audible, onProgress: (f) => onProgress((1 - audioShare) + f * audioShare, 'audio') });
    }
    onProgress(1, 'finalizing');
    const blob = muxer.finalize();
    return { blob, warnings, out, audioCodec: acfg ? acfg.kind : null, videoCodec: vcodec };
  }

  async function encodeVideo({ tracks, settings, out, vcfg, muxer, signal, duration, onProgress }) {
    const canvas = makeCanvas(out.width, out.height);
    const ctx = canvas.getContext('2d', { alpha: false });
    let encError = null;
    const encoder = new VideoEncoder({
      output: (chunk, meta) => {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        muxer.addVideo(data, chunk.timestamp / 1e6, (chunk.duration || 0) / 1e6, chunk.type === 'key', meta && meta.decoderConfig && meta.decoderConfig.description);
      },
      error: (e) => { encError = e; },
    });
    encoder.configure(vcfg);

    const frameDur = 1 / out.fps;
    const keyEvery = 2; // seconds
    let lastKeyAt = -Infinity;
    const nFrames = Math.max(1, Math.round(duration * out.fps));
    const readers = new Map(); // clip -> VideoReader
    const bgMode = settings.fit === 'blur' ? 'blur' : 'bars';

    try {
      for (let k = 0; k < nFrames; k++) {
        if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
        if (encError) throw encError;
        const t = k * frameDur;
        const layers = [];
        for (let ti = 0; ti < tracks.length; ti++) {
          const tr = tracks[ti];
          if (tr.hidden || tr.opacity === 0) continue;
          const c = clipAtTime(tr.clips, t);
          if (!c) continue;
          const base = { tf: c.tf, opacity: tr.opacity == null ? 1 : tr.opacity, isMain: ti === 0 };
          if (c.kind === 'video') {
            let r = readers.get(c);
            if (!r) { r = new VideoReader(c); readers.set(c, r); }
            const f = await r.frameAt(c.in + (t - c.start), signal);
            if (f) layers.push({ ...base, drawable: f, w: f.displayWidth, h: f.displayHeight, rot: c.source.rotation, isColor: false });
          } else if (c.still) {
            layers.push({ ...base, drawable: c.still.drawable, w: c.still.w, h: c.still.h, rot: 0, isColor: c.still.isColor });
          }
        }
        composite(ctx, out.width, out.height, layers, bgMode, settings.bg);
        // Free decoders of clips that are over.
        for (const [c, r] of readers) if (t + frameDur >= c.start + (c.out - c.in) - 1e-6) { r.close(); readers.delete(c); }
        const vf = new VideoFrame(canvas, { timestamp: Math.round(t * 1e6), duration: Math.round(frameDur * 1e6) });
        const key = t - lastKeyAt >= keyEvery - 1e-6;
        if (key) lastKeyAt = t;
        await waitFor(() => encoder.encodeQueueSize < 6, signal);
        encoder.encode(vf, { keyFrame: key });
        vf.close();
        if (k % 5 === 0) onProgress(Math.min(0.999, k / nFrames));
      }
      await encoder.flush();
      if (encError) throw encError;
    } finally {
      for (const r of readers.values()) r.close();
      if (encoder.state !== 'closed') encoder.close();
    }
    onProgress(1);
  }

  async function encodeAudio({ tracks, acfg, muxer, signal, duration, audible, onProgress }) {
    let encError = null;
    const encoder = new AudioEncoder({
      output: (chunk, meta) => {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        muxer.addAudio(data, chunk.timestamp / 1e6, (chunk.duration || 0) / 1e6, meta && meta.decoderConfig && meta.decoderConfig.description);
      },
      error: (e) => { encError = e; },
    });
    encoder.configure(acfg.cfg);

    const BLOCK = 4800; // 0.1 s
    const total = Math.round(duration * OUT_RATE);
    const readers = new Map(); // clip -> AudioReader
    const items = [];
    for (const tr of tracks) {
      if (!audible(tr)) continue;
      const gain = tr.volume == null ? 1 : tr.volume;
      for (const c of tr.clips) {
        if (c.kind !== 'video' || c.muted || !c.source || !c.source.audioDecodable || !c.source.demux.audio) continue;
        items.push({ c, gain, s0: Math.round(c.start * OUT_RATE), s1: Math.round((c.start + (c.out - c.in)) * OUT_RATE) });
      }
    }

    try {
      for (let b = 0; b < total; b += BLOCK) {
        if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
        if (encError) throw encError;
        const n = Math.min(BLOCK, total - b);
        const L = new Float32Array(n), R = new Float32Array(n);
        for (const it of items) {
          const from = Math.max(b, it.s0), to = Math.min(b + n, it.s1);
          if (to <= from) continue;
          let r = readers.get(it.c);
          if (!r) { r = new AudioReader(it.c); readers.set(it.c, r); }
          await r.mixInto(L, R, from - b, to - from, it.gain, signal);
          if (to >= it.s1) { r.close(); readers.delete(it.c); }
        }
        const data = new Float32Array(n * OUT_CHANNELS);
        for (let i = 0; i < n; i++) {
          data[i] = Math.max(-1, Math.min(1, L[i]));
          data[n + i] = Math.max(-1, Math.min(1, R[i]));
        }
        const ad = new AudioData({ format: 'f32-planar', sampleRate: OUT_RATE, numberOfFrames: n, numberOfChannels: OUT_CHANNELS, timestamp: Math.round((b / OUT_RATE) * 1e6), data });
        await waitFor(() => encoder.encodeQueueSize < 10, signal);
        encoder.encode(ad);
        ad.close();
        onProgress(Math.min(0.999, (b + n) / total));
      }
      await encoder.flush();
      if (encError) throw encError;
    } finally {
      for (const r of readers.values()) r.close();
      if (encoder.state !== 'closed') encoder.close();
    }
    onProgress(1);
  }

  global.Render = {
    QUALITY, presetBitrate, computeOutput, estimateSize, drawClip, composite, clipAtTime, clipLayout, tfOf, DEFAULT_TF, ANCHORS, displaySize,
    hasWebCodecs, canDecodeVideo, canDecodeAudio, canEncodeHevc, exportTimeline,
  };
})(typeof window !== 'undefined' ? window : globalThis);
