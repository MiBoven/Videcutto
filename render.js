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
  // Presets
  // ---------------------------------------------------------------------------
  const PRESETS = {
    hd:       { label: 'HD',        short: 720,  bitrate: 2_500_000, audio: 128_000 },
    fullhd:   { label: 'Full HD',   short: 1080, bitrate: 5_000_000, audio: 128_000 },
    small:    { label: 'Small',     short: 480,  bitrate: 1_000_000, audio: 96_000 },
    original: { label: 'Original',  short: null, bitrate: null,      audio: 160_000 },
    target:   { label: 'Target size', short: null, bitrate: null,    audio: 96_000 },
  };

  const even = (n) => Math.max(2, Math.round(n / 2) * 2);

  // Display (rotation-applied) size of a source.
  function displaySize(src) {
    const r = src.rotation === 90 || src.rotation === 270;
    return r ? { w: src.height, h: src.width } : { w: src.width, h: src.height };
  }

  /**
   * Work out output width/height/bitrate/fps from the settings.
   * @param settings { preset, aspect, fit, fps, targetMB, codec }
   * @param first    first source on the timeline (for "auto" aspect / original size)
   * @param sources  all sources used (to avoid upscaling)
   * @param duration timeline duration in seconds
   */
  function computeOutput(settings, first, sources, duration) {
    const p = PRESETS[settings.preset] || PRESETS.hd;
    const fd = displaySize(first);
    let aspect;
    switch (settings.aspect) {
      case '16:9': aspect = 16 / 9; break;
      case '9:16': aspect = 9 / 16; break;
      case '1:1': aspect = 1; break;
      default: aspect = fd.w / fd.h;
    }
    const maxShort = Math.max(...sources.map((s) => { const d = displaySize(s); return Math.min(d.w, d.h); }));
    const maxFps = Math.max(...sources.map((s) => s.frameRate || 30));
    const fps = settings.fps === 'original' ? Math.min(60, Math.round(maxFps)) : Math.min(Number(settings.fps) || 30, Math.max(24, Math.round(maxFps)));

    let audioBitrate = p.audio;
    let bitrate = p.bitrate;
    let short = p.short;

    if (settings.preset === 'original') {
      short = Math.min(fd.w, fd.h);
    } else if (settings.preset === 'target') {
      const totalBits = Math.max(0.2, settings.targetMB || 25) * 8e6 * 0.96;
      const perSec = totalBits / Math.max(0.5, duration);
      audioBitrate = perSec > 1_000_000 ? 128_000 : perSec > 400_000 ? 96_000 : 64_000;
      bitrate = Math.max(120_000, perSec - audioBitrate);
      short = bitrate >= 4_000_000 ? 1080 : bitrate >= 1_800_000 ? 720 : bitrate >= 800_000 ? 480 : 360;
    }
    short = Math.min(short, maxShort);

    let w, h;
    if (aspect >= 1) { h = short; w = h * aspect; } else { w = short; h = w / aspect; }
    w = even(w); h = even(h);

    if (settings.preset === 'original') {
      // ~0.07 bits per pixel per frame — visually close to the source, far smaller than phone bitrates.
      bitrate = Math.round(Math.min(25_000_000, Math.max(1_500_000, w * h * fps * 0.07)));
    }
    // Scale preset bitrates a little for 60 fps.
    if (settings.preset !== 'target' && settings.preset !== 'original' && fps > 30) bitrate = Math.round(bitrate * 1.4);

    // Never spend more bits than the sources have: re-encoding an already
    // compressed video (e.g. from Instagram or WhatsApp) at a higher bitrate
    // only makes the file bigger without improving quality.
    let capped = false;
    const withRate = sources.filter((s) => s.videoBitrate > 0);
    if (withRate.length) {
      const cap = Math.max(...withRate.map((s) => {
        const d = displaySize(s);
        const px = Math.min(1, (w * h) / (d.w * d.h));
        const fr = Math.min(1, fps / Math.max(1, s.frameRate || fps));
        return s.videoBitrate * Math.pow(px, 0.75) * Math.pow(fr, 0.5) * 0.75;
      }));
      if (cap < bitrate) { bitrate = Math.max(250_000, Math.round(cap)); capped = true; }
    }
    const srcAudio = Math.max(0, ...sources.map((s) => s.audioBitrate || 0));
    if (srcAudio > 0) audioBitrate = Math.min(audioBitrate, Math.max(64_000, Math.ceil(srcAudio / 32_000) * 32_000));

    return { width: w, height: h, fps, bitrate, audioBitrate, capped };
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

  /**
   * Draw `src` (VideoFrame / video element / bitmap) into ctx with letterboxing.
   * w, h: un-rotated source size. rotation: clockwise degrees to apply.
   */
  function drawFit(ctx, src, w, h, rotation, outW, outH, fit) {
    const rot = ((rotation || 0) % 360 + 360) % 360;
    const rotated = rot === 90 || rot === 270;
    const dw = rotated ? h : w;
    const dh = rotated ? w : h;

    ctx.save();
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, outW, outH);

    const contain = Math.min(outW / dw, outH / dh);
    const fillsAll = Math.abs(dw * contain - outW) < 2 && Math.abs(dh * contain - outH) < 2;

    if (fit === 'blur' && !fillsAll) {
      // Cheap, universally supported blur: draw tiny, then scale up smoothly.
      const bc = getBlurCanvas();
      const small = 24;
      const bw = outW >= outH ? small : Math.max(4, Math.round(small * outW / outH));
      const bh = outW >= outH ? Math.max(4, Math.round(small * outH / outW)) : small;
      bc.width = bw; bc.height = bh;
      const bctx = bc.getContext('2d');
      const cover = Math.max(bw / dw, bh / dh);
      bctx.save();
      bctx.translate(bw / 2, bh / 2);
      bctx.rotate(rot * Math.PI / 180);
      bctx.drawImage(src, -w * cover / 2, -h * cover / 2, w * cover, h * cover);
      bctx.restore();
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bc, -outW * 0.05, -outH * 0.05, outW * 1.1, outH * 1.1);
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(0, 0, outW, outH);
    }

    ctx.translate(outW / 2, outH / 2);
    ctx.rotate(rot * Math.PI / 180);
    ctx.drawImage(src, -w * contain / 2, -h * contain / 2, w * contain, h * contain);
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
   * @param opts {
   *   clips: [{ source, in, out, muted }], // source = loaded source object (has .demux, .file, ...)
   *   settings: { preset, aspect, fit, fps, targetMB, codec, muteAll },
   *   onProgress(fraction, label), signal
   * }
   * @returns { blob, warnings, out, audioCodec }
   */
  async function exportTimeline(opts) {
    const { clips, settings, onProgress = () => {}, signal } = opts;
    const warnings = [];
    if (!hasWebCodecs()) throw new Error('This browser does not support WebCodecs video encoding.');
    if (!clips.length) throw new Error('The timeline is empty.');

    const sources = [...new Set(clips.map((c) => c.source))];
    const duration = clips.reduce((s, c) => s + (c.out - c.in), 0);
    const out = computeOutput(settings, clips[0].source, sources, duration);

    // Encoder selection
    let vcfg = await pickVideoEncoder(settings.codec === 'hevc' ? 'hevc' : 'avc', out.width, out.height, out.fps, out.bitrate);
    let vcodec = settings.codec === 'hevc' ? 'hevc' : 'avc';
    if (!vcfg && vcodec === 'hevc') {
      warnings.push('HEVC encoding is not available here — exported as H.264 instead.');
      vcodec = 'avc';
      vcfg = await pickVideoEncoder('avc', out.width, out.height, out.fps, out.bitrate);
    }
    if (!vcfg) throw new Error(`No video encoder available for ${out.width}×${out.height}.`);

    const anyAudio = !settings.muteAll && clips.some((c) => !c.muted && c.source.audioDecodable);
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
    await encodeVideo({ clips, settings, out, vcfg, muxer, signal, duration, onProgress: (f) => onProgress(f * (1 - audioShare), 'video') });
    if (acfg) {
      await encodeAudio({ clips, settings, acfg, muxer, signal, duration, onProgress: (f) => onProgress((1 - audioShare) + f * audioShare, 'audio') });
    }
    onProgress(1, 'finalizing');
    const blob = muxer.finalize();
    return { blob, warnings, out, audioCodec: acfg ? acfg.kind : null, videoCodec: vcodec };
  }

  async function encodeVideo({ clips, settings, out, vcfg, muxer, signal, duration, onProgress }) {
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
    let lastOut = -Infinity;
    let timelinePos = 0;
    let produced = 0;
    const expectedFrames = Math.max(1, Math.round(duration * out.fps));

    try {
      for (const clip of clips) {
        const src = clip.source;
        const track = src.demux.video;
        const reader = new MP4.BlobReader(src.file);
        const clipStart = timelinePos;
        const clipLen = clip.out - clip.in;
        let decError = null;
        let pendingFrames = [];

        const decoder = new VideoDecoder({
          output: (frame) => { pendingFrames.push(frame); },
          error: (e) => { decError = e; },
        });
        decoder.configure(videoDecoderConfig(track));

        const drain = async () => {
          // Frames arrive in presentation order.
          while (pendingFrames.length) {
            const frame = pendingFrames.shift();
            const t = frame.timestamp / 1e6;
            if (t < clip.in - 1e-4 || t >= clip.out - 1e-4) { frame.close(); continue; }
            const outT = clipStart + (t - clip.in);
            if (outT < lastOut + frameDur * 0.75) { frame.close(); continue; } // frame-rate cap
            drawFit(ctx, frame, frame.displayWidth, frame.displayHeight, src.rotation, out.width, out.height, settings.fit);
            frame.close();
            const vf = new VideoFrame(canvas, { timestamp: Math.round(outT * 1e6), duration: Math.round(frameDur * 1e6) });
            const key = outT - lastKeyAt >= keyEvery - 1e-6;
            if (key) lastKeyAt = outT;
            await waitFor(() => encoder.encodeQueueSize < 6, signal);
            encoder.encode(vf, { keyFrame: key });
            vf.close();
            lastOut = outT;
            produced++;
            if (produced % 5 === 0) onProgress(Math.min(0.999, produced / expectedFrames));
          }
        };

        const s = track.samples;
        const startIdx = MP4.keyframeBefore(track, clip.in);
        for (let i = startIdx; i < s.count; i++) {
          if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
          if (decError) throw decError;
          if (encError) throw encError;
          // Stop once we're safely past the out point (allow for frame reordering).
          if (s.pts[i] >= clip.out + 0.5) break;
          const data = await reader.read(s.offsets[i], s.sizes[i]);
          decoder.decode(new EncodedVideoChunk({
            type: s.sync[i] ? 'key' : 'delta',
            timestamp: Math.round(s.pts[i] * 1e6),
            duration: Math.round(s.dur[i] * 1e6),
            data,
          }));
          await waitFor(() => decoder.decodeQueueSize < 8 || pendingFrames.length > 0, signal);
          await drain();
        }
        await decoder.flush();
        await drain();
        decoder.close();
        if (decError) throw decError;
        timelinePos += clipLen;
      }
      await encoder.flush();
      if (encError) throw encError;
    } finally {
      if (encoder.state !== 'closed') encoder.close();
    }
    onProgress(1);
  }

  async function encodeAudio({ clips, settings, acfg, muxer, signal, duration, onProgress }) {
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

    const BLOCK = 4800;
    let written = 0; // output frames written so far
    let timelinePos = 0;
    const totalFrames = Math.round(duration * OUT_RATE);
    let block = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    let blockFill = 0;

    const flushBlock = async (force) => {
      if (blockFill === 0 || (!force && blockFill < BLOCK)) return;
      const data = new Float32Array(blockFill * OUT_CHANNELS);
      data.set(block[0].subarray(0, blockFill), 0);
      data.set(block[1].subarray(0, blockFill), blockFill);
      const ad = new AudioData({ format: 'f32-planar', sampleRate: OUT_RATE, numberOfFrames: blockFill, numberOfChannels: OUT_CHANNELS, timestamp: Math.round((written - blockFill) / OUT_RATE * 1e6), data });
      await waitFor(() => encoder.encodeQueueSize < 10, signal);
      encoder.encode(ad);
      ad.close();
      blockFill = 0;
      if (encError) throw encError;
    };
    const push = async (l, r) => {
      block[0][blockFill] = l; block[1][blockFill] = r;
      blockFill++; written++;
      if (blockFill === BLOCK) await flushBlock(true);
    };

    try {
      for (const clip of clips) {
        const clipLen = clip.out - clip.in;
        const targetEnd = Math.round((timelinePos + clipLen) * OUT_RATE);
        const src = clip.source;
        const track = src.demux.audio;
        const useAudio = !settings.muteAll && !clip.muted && track && src.audioDecodable;

        if (useAudio) {
          const reader = new MP4.BlobReader(src.file);
          const rate = track.sampleRate;
          const step = rate / OUT_RATE;
          let pending = null; // [Float32Array L, Float32Array R]
          let pendingStart = 0; // source time of pending[0]
          let pos = 0; // fractional read position in pending (source samples)
          let started = false;
          let decError = null;
          const queue = [];
          const decoder = new AudioDecoder({ output: (d) => queue.push(d), error: (e) => { decError = e; } });
          decoder.configure(audioDecoderConfig(track));

          const consume = async () => {
            while (queue.length) {
              const ad = queue.shift();
              const n = ad.numberOfFrames;
              const chs = ad.numberOfChannels;
              const L = new Float32Array(n), R = new Float32Array(n);
              ad.copyTo(L, { planeIndex: 0, format: 'f32-planar' });
              if (chs > 1) ad.copyTo(R, { planeIndex: 1, format: 'f32-planar' }); else R.set(L);
              const ts = ad.timestamp / 1e6;
              ad.close();
              if (!pending) {
                pending = [L, R];
                pendingStart = ts;
                // Position where the clip's in-point lies inside the decoded data.
                pos = (clip.in - ts) * rate;
                started = true;
              } else {
                const nl = new Float32Array(pending[0].length + n), nr = new Float32Array(pending[1].length + n);
                nl.set(pending[0]); nl.set(L, pending[0].length);
                nr.set(pending[1]); nr.set(R, pending[1].length);
                pending = [nl, nr];
              }
              // Produce output samples by linear interpolation.
              const len = pending[0].length;
              while (written < targetEnd && pos + 1 < len) {
                if (pos < 0) { await push(0, 0); pos += step; continue; }
                const i = Math.floor(pos), f = pos - i;
                const l = pending[0][i] + (pending[0][i + 1] - pending[0][i]) * f;
                const r = pending[1][i] + (pending[1][i + 1] - pending[1][i]) * f;
                await push(l, r);
                pos += step;
              }
              // Drop consumed samples, keep one for interpolation.
              const drop = Math.max(0, Math.floor(pos) - 1);
              if (drop > 0) {
                pending = [pending[0].slice(drop), pending[1].slice(drop)];
                pos -= drop;
                pendingStart += drop / rate;
              }
              onProgress(Math.min(0.999, written / totalFrames));
            }
          };

          const s = track.samples;
          let startIdx = 0;
          for (let i = 0; i < s.count; i++) if (s.pts[i] <= clip.in) startIdx = i; else break;
          for (let i = startIdx; i < s.count && written < targetEnd; i++) {
            if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
            if (decError) throw decError;
            if (s.pts[i] > clip.out + 0.1) break;
            const data = await reader.read(s.offsets[i], s.sizes[i]);
            decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round(s.pts[i] * 1e6), duration: Math.round(s.dur[i] * 1e6), data }));
            await waitFor(() => decoder.decodeQueueSize < 16 || queue.length > 0, signal);
            await consume();
          }
          await decoder.flush();
          await consume();
          decoder.close();
          if (!started && decError) throw decError;
        }
        // Pad with silence (muted clips, clips without audio, or short audio).
        while (written < targetEnd) await push(0, 0);
        timelinePos += clipLen;
        if (encError) throw encError;
      }
      await flushBlock(true);
      await encoder.flush();
      if (encError) throw encError;
    } finally {
      if (encoder.state !== 'closed') encoder.close();
    }
    onProgress(1);
  }

  global.Render = {
    PRESETS, computeOutput, estimateSize, drawFit, displaySize,
    hasWebCodecs, canDecodeVideo, canDecodeAudio, canEncodeHevc, exportTimeline,
  };
})(typeof window !== 'undefined' ? window : globalThis);
