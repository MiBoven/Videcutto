/*
 * mp4.js — minimal ISO-BMFF (MP4 / MOV) demuxer and muxer for Videcutto.
 *
 * Demuxer: reads only the boxes and sample ranges it needs straight from the
 * File/Blob (never loads the whole video into memory). Supports progressive
 * (non-fragmented) MP4/MOV with H.264, HEVC, VP9, AV1 video and AAC / Opus
 * audio — that covers virtually every phone and camera recording.
 *
 * Muxer: writes a progressive "fast start" MP4 (moov before mdat) from
 * encoded WebCodecs chunks — H.264 or HEVC video, AAC or Opus audio.
 */
(function (global) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Byte helpers
  // ---------------------------------------------------------------------------
  const td = new TextDecoder('latin1');
  const fourcc = (u8, o) => td.decode(u8.subarray(o, o + 4));
  const hex2 = (n) => n.toString(16).toUpperCase().padStart(2, '0');

  function dv(u8) { return new DataView(u8.buffer, u8.byteOffset, u8.byteLength); }

  // Windowed reader: serves small reads from a cached slice of the Blob so that
  // reading thousands of consecutive samples doesn't hit the disk thousands of times.
  class BlobReader {
    constructor(blob, windowSize = 8 * 1024 * 1024) {
      this.blob = blob;
      this.size = blob.size;
      this.windowSize = windowSize;
      this.start = 0;
      this.buf = null;
    }
    async read(offset, length) {
      if (this.buf && offset >= this.start && offset + length <= this.start + this.buf.length) {
        return this.buf.subarray(offset - this.start, offset - this.start + length);
      }
      const end = Math.min(this.size, offset + Math.max(length, this.windowSize));
      this.buf = new Uint8Array(await this.blob.slice(offset, end).arrayBuffer());
      this.start = offset;
      if (this.buf.length < length) throw new Error('Unexpected end of file');
      return this.buf.subarray(0, length);
    }
    // Large one-off read that bypasses (and doesn't evict) the window.
    async readDirect(offset, length) {
      return new Uint8Array(await this.blob.slice(offset, offset + length).arrayBuffer());
    }
  }

  // Iterate child boxes inside a buffer region.
  function* boxes(u8, start = 0, end = u8.length) {
    const v = dv(u8);
    let p = start;
    while (p + 8 <= end) {
      let size = v.getUint32(p);
      const type = fourcc(u8, p + 4);
      let header = 8;
      if (size === 1) {
        size = Number(v.getBigUint64(p + 8));
        header = 16;
      } else if (size === 0) {
        size = end - p;
      }
      if (size < header || p + size > end) break;
      yield { type, start: p, size, data: p + header, end: p + size };
      p += size;
    }
  }

  function findBox(u8, type, start, end) {
    for (const b of boxes(u8, start, end)) if (b.type === type) return b;
    return null;
  }

  function findPath(u8, path, start = 0, end = u8.length) {
    let box = { data: start, end };
    for (const t of path) {
      box = findBox(u8, t, box.data, box.end);
      if (!box) return null;
    }
    return box;
  }

  // ---------------------------------------------------------------------------
  // Demuxer
  // ---------------------------------------------------------------------------
  async function readTopLevel(reader) {
    const out = [];
    let p = 0;
    while (p + 8 <= reader.size) {
      const h = await reader.readDirect(p, 16);
      const v = dv(h);
      let size = v.getUint32(0);
      const type = fourcc(h, 4);
      if (size === 1) size = Number(v.getBigUint64(8));
      else if (size === 0) size = reader.size - p;
      if (size < 8) break;
      out.push({ type, start: p, size });
      p += size;
    }
    return out;
  }

  function parseMatrixRotation(v, o) {
    // Matrix is 9 x 32-bit values; a, b are 16.16 fixed point.
    const a = v.getInt32(o) / 65536;
    const b = v.getInt32(o + 4) / 65536;
    let deg = Math.round(Math.atan2(b, a) * 180 / Math.PI);
    deg = ((deg % 360) + 360) % 360;
    // Normalise to multiples of 90
    return (Math.round(deg / 90) * 90) % 360;
  }

  function reverseBits32(n) {
    let r = 0;
    for (let i = 0; i < 32; i++) { r = (r << 1) | (n & 1); n >>>= 1; }
    return r >>> 0;
  }

  function hevcCodecString(prefix, c) {
    const space = c[1] >> 6;
    const tier = (c[1] >> 5) & 1;
    const profile = c[1] & 0x1f;
    const compat = (c[2] << 24 | c[3] << 16 | c[4] << 8 | c[5]) >>> 0;
    const level = c[12];
    let s = `${prefix}.${['', 'A', 'B', 'C'][space]}${profile}.${reverseBits32(compat).toString(16).toUpperCase()}.${tier ? 'H' : 'L'}${level}`;
    const cons = Array.from(c.subarray(6, 12));
    while (cons.length && cons[cons.length - 1] === 0) cons.pop();
    for (const b of cons) s += '.' + hex2(b);
    return s;
  }

  function parseEsds(u8, b) {
    // Full box: skip version/flags
    let p = b.data + 4;
    const readLen = () => {
      let len = 0;
      for (let i = 0; i < 4; i++) {
        const x = u8[p++];
        len = (len << 7) | (x & 0x7f);
        if (!(x & 0x80)) break;
      }
      return len;
    };
    const result = { objectType: 0, asc: null };
    while (p < b.end) {
      const tag = u8[p++];
      const len = readLen();
      if (tag === 0x03) {
        p += 2; // ES_ID
        const flags = u8[p++];
        if (flags & 0x80) p += 2;
        if (flags & 0x40) p += 1 + u8[p];
        if (flags & 0x20) p += 2;
        continue; // descend
      } else if (tag === 0x04) {
        result.objectType = u8[p];
        p += 13;
        continue; // descend into DecSpecificInfo
      } else if (tag === 0x05) {
        result.asc = u8.slice(p, p + len);
        break;
      } else {
        p += len;
      }
    }
    return result;
  }

  function searchBox(u8, type, start, end) {
    // Depth-first search for a box type (used for esds inside QuickTime 'wave').
    for (const b of boxes(u8, start, end)) {
      if (b.type === type) return b;
      if (b.type === 'wave' || b.type === 'mp4a') {
        const r = searchBox(u8, type, b.data, b.end);
        if (r) return r;
      }
    }
    return null;
  }

  function parseStsd(u8, b, handler) {
    const v = dv(u8);
    const entry = boxes(u8, b.data + 8, b.end).next().value;
    if (!entry) return null;
    const type = entry.type;
    // Raw sample entry, used to copy streams losslessly (any codec) when remuxing.
    const info = { format: type, rawEntry: u8.slice(entry.start, entry.end) };
    if (handler === 'vide') {
      info.codedWidth = v.getUint16(entry.data + 24);
      info.codedHeight = v.getUint16(entry.data + 26);
      const childStart = entry.data + 78;
      for (const c of boxes(u8, childStart, entry.end)) {
        const payload = u8.slice(c.data, c.end);
        if (c.type === 'avcC') {
          info.codec = 'avc';
          info.codecString = `${type === 'avc3' ? 'avc3' : 'avc1'}.${hex2(payload[1])}${hex2(payload[2])}${hex2(payload[3])}`;
          info.description = payload;
        } else if (c.type === 'hvcC') {
          info.codec = 'hevc';
          info.codecString = hevcCodecString(type === 'hev1' ? 'hev1' : 'hvc1', payload);
          info.description = payload;
        } else if (c.type === 'vpcC') {
          info.codec = 'vp9';
          // full box: 4 bytes version/flags
          const prof = payload[4], lvl = payload[5], depth = payload[6] >> 4;
          info.codecString = `vp09.${String(prof).padStart(2, '0')}.${String(lvl).padStart(2, '0')}.${String(depth).padStart(2, '0')}`;
        } else if (c.type === 'av1C') {
          info.codec = 'av1';
          const prof = payload[1] >> 5, lvl = payload[1] & 0x1f;
          const tier = payload[2] >> 7, high = (payload[2] >> 6) & 1, twelve = (payload[2] >> 5) & 1;
          const depth = high ? (twelve ? 12 : 10) : 8;
          info.codecString = `av01.${prof}.${String(lvl).padStart(2, '0')}${tier ? 'H' : 'M'}.${String(depth).padStart(2, '0')}`;
        }
      }
      if (!info.codec) info.codec = 'unsupported';
    } else if (handler === 'soun') {
      const version = v.getUint16(entry.data + 8);
      info.channels = v.getUint16(entry.data + 16);
      info.sampleRate = v.getUint32(entry.data + 24) >>> 16;
      let childStart = entry.data + 28;
      if (version === 1) childStart += 16;
      if (version === 2) {
        info.sampleRate = Math.round(v.getFloat64(entry.data + 32));
        info.channels = v.getUint32(entry.data + 40);
        childStart += 36;
      }
      if (type === 'mp4a') {
        const esds = searchBox(u8, 'esds', childStart, entry.end);
        if (esds) {
          const e = parseEsds(u8, esds);
          if (e.objectType === 0x40 && e.asc) {
            let aot = e.asc[0] >> 3;
            if (aot === 31) aot = 32 + (((e.asc[0] & 7) << 3) | (e.asc[1] >> 5));
            info.codec = 'aac';
            info.codecString = 'mp4a.40.' + aot;
            info.description = e.asc;
          } else if (e.objectType === 0x6B || e.objectType === 0x69) {
            info.codec = 'mp3';
            info.codecString = 'mp3';
          }
        }
      } else if (type === 'Opus') {
        info.codec = 'opus';
        info.codecString = 'opus';
        info.sampleRate = 48000;
      }
      if (!info.codec) info.codec = 'unsupported';
    }
    return info;
  }

  function buildSampleTable(u8, stbl) {
    const v = dv(u8);
    const get = (t) => findBox(u8, t, stbl.data, stbl.end);

    // sizes
    let sizes;
    const stsz = get('stsz');
    const stz2 = get('stz2');
    if (stsz) {
      const fixed = v.getUint32(stsz.data + 4);
      const count = v.getUint32(stsz.data + 8);
      sizes = new Uint32Array(count);
      if (fixed) sizes.fill(fixed);
      else for (let i = 0; i < count; i++) sizes[i] = v.getUint32(stsz.data + 12 + i * 4);
    } else if (stz2) {
      const field = u8[stz2.data + 7];
      const count = v.getUint32(stz2.data + 8);
      sizes = new Uint32Array(count);
      for (let i = 0; i < count; i++) {
        const o = stz2.data + 12;
        if (field === 16) sizes[i] = v.getUint16(o + i * 2);
        else if (field === 8) sizes[i] = u8[o + i];
        else sizes[i] = (i & 1) ? (u8[o + (i >> 1)] & 0xf) : (u8[o + (i >> 1)] >> 4);
      }
    } else {
      sizes = new Uint32Array(0);
    }
    const n = sizes.length;

    // chunk offsets
    let chunkOffsets;
    const stco = get('stco');
    const co64 = get('co64');
    if (stco) {
      const c = v.getUint32(stco.data + 4);
      chunkOffsets = new Float64Array(c);
      for (let i = 0; i < c; i++) chunkOffsets[i] = v.getUint32(stco.data + 8 + i * 4);
    } else if (co64) {
      const c = v.getUint32(co64.data + 4);
      chunkOffsets = new Float64Array(c);
      for (let i = 0; i < c; i++) chunkOffsets[i] = Number(v.getBigUint64(co64.data + 8 + i * 8));
    } else {
      chunkOffsets = new Float64Array(0);
    }

    // sample -> chunk
    const offsets = new Float64Array(n);
    const stsc = get('stsc');
    if (stsc) {
      const entries = v.getUint32(stsc.data + 4);
      let s = 0;
      for (let e = 0; e < entries; e++) {
        const base = stsc.data + 8 + e * 12;
        const firstChunk = v.getUint32(base) - 1;
        const perChunk = v.getUint32(base + 4);
        const nextFirst = e + 1 < entries ? v.getUint32(base + 12) - 1 : chunkOffsets.length;
        for (let c = firstChunk; c < nextFirst && s < n; c++) {
          let off = chunkOffsets[c];
          for (let k = 0; k < perChunk && s < n; k++) {
            offsets[s] = off;
            off += sizes[s];
            s++;
          }
        }
      }
    }

    // decode timestamps
    const dts = new Float64Array(n);
    const durations = new Float64Array(n);
    const stts = get('stts');
    if (stts) {
      const entries = v.getUint32(stts.data + 4);
      let s = 0, t = 0;
      for (let e = 0; e < entries; e++) {
        const count = v.getUint32(stts.data + 8 + e * 8);
        const delta = v.getUint32(stts.data + 12 + e * 8);
        for (let k = 0; k < count && s < n; k++) {
          dts[s] = t; durations[s] = delta; t += delta; s++;
        }
      }
    }

    // composition offsets
    const cts = Float64Array.from(dts);
    const ctts = get('ctts');
    if (ctts) {
      const version = u8[ctts.data];
      const entries = v.getUint32(ctts.data + 4);
      let s = 0;
      for (let e = 0; e < entries; e++) {
        const count = v.getUint32(ctts.data + 8 + e * 8);
        const off = version === 1 ? v.getInt32(ctts.data + 12 + e * 8) : v.getUint32(ctts.data + 12 + e * 8);
        for (let k = 0; k < count && s < n; k++) { cts[s] += off; s++; }
      }
    }

    // sync samples
    const sync = new Uint8Array(n);
    const stss = get('stss');
    if (stss) {
      const entries = v.getUint32(stss.data + 4);
      for (let e = 0; e < entries; e++) {
        const idx = v.getUint32(stss.data + 8 + e * 4) - 1;
        if (idx < n) sync[idx] = 1;
      }
    } else {
      sync.fill(1);
    }

    return { count: n, offsets, sizes, dts, cts, durations, sync };
  }

  function parseTrak(u8, trak, movieTimescale) {
    const v = dv(u8);
    const tkhd = findBox(u8, 'tkhd', trak.data, trak.end);
    const mdia = findBox(u8, 'mdia', trak.data, trak.end);
    if (!tkhd || !mdia) return null;
    const mdhd = findBox(u8, 'mdhd', mdia.data, mdia.end);
    const hdlr = findBox(u8, 'hdlr', mdia.data, mdia.end);
    const stbl = findPath(u8, ['minf', 'stbl'], mdia.data, mdia.end);
    if (!mdhd || !hdlr || !stbl) return null;
    const handler = fourcc(u8, hdlr.data + 8);
    if (handler !== 'vide' && handler !== 'soun') return null;

    const tkVersion = u8[tkhd.data];
    const tkBase = tkhd.data + (tkVersion === 1 ? 36 : 24);
    // tkBase points at reserved(8) layer(2) altgroup(2) volume(2) reserved(2) matrix(36) width height
    const matrixOff = tkBase + 16;
    const rotation = parseMatrixRotation(v, matrixOff);
    const tkWidth = v.getUint32(matrixOff + 36) / 65536;
    const tkHeight = v.getUint32(matrixOff + 40) / 65536;
    const trackId = v.getUint32(tkhd.data + (tkVersion === 1 ? 20 : 12));

    const mdVersion = u8[mdhd.data];
    const timescale = v.getUint32(mdhd.data + (mdVersion === 1 ? 20 : 12));

    const stsd = findBox(u8, 'stsd', stbl.data, stbl.end);
    const info = stsd ? parseStsd(u8, stsd, handler) : null;
    if (!info) return null;
    const table = buildSampleTable(u8, stbl);

    // Edit list: shift presentation times (common with B-frames / iPhone files).
    let shift = 0; // in media timescale units, subtracted from cts
    let emptyLead = 0; // seconds of empty edit at the start
    const elst = findPath(u8, ['edts', 'elst'], trak.data, trak.end);
    if (elst) {
      const ver = u8[elst.data];
      const entries = v.getUint32(elst.data + 4);
      let p = elst.data + 8;
      for (let e = 0; e < entries; e++) {
        const segDur = ver === 1 ? Number(v.getBigUint64(p)) : v.getUint32(p);
        const mediaTime = ver === 1 ? Number(v.getBigInt64(p + 8)) : v.getInt32(p + 4);
        p += ver === 1 ? 20 : 12;
        if (mediaTime === -1) { emptyLead += segDur / movieTimescale; continue; }
        shift = mediaTime;
        break;
      }
    }

    const pts = new Float64Array(table.count);
    let minPts = Infinity, maxEnd = 0;
    for (let i = 0; i < table.count; i++) {
      pts[i] = (table.cts[i] - shift) / timescale + emptyLead;
      if (pts[i] < minPts) minPts = pts[i];
      const end = pts[i] + table.durations[i] / timescale;
      if (end > maxEnd) maxEnd = end;
    }

    const track = {
      id: trackId,
      type: handler === 'vide' ? 'video' : 'audio',
      timescale,
      ...info,
      samples: {
        count: table.count,
        offsets: table.offsets,
        sizes: table.sizes,
        pts,
        dur: Float64Array.from(table.durations, (d) => d / timescale),
        sync: table.sync,
      },
      duration: table.count ? maxEnd : 0,
      start: table.count ? minPts : 0,
    };
    if (track.type === 'video') {
      track.rotation = rotation;
      // Display size before rotation is applied (tkhd may include pixel aspect).
      const w = Math.round(tkWidth) || info.codedWidth;
      const h = Math.round(tkHeight) || info.codedHeight;
      // tkhd width/height of a rotated track are usually already swapped in some
      // writers and not in others; we normalise to un-rotated dimensions here.
      const rotated = rotation === 90 || rotation === 270;
      const swapped = rotated && Math.abs(w / h - info.codedHeight / info.codedWidth) < 0.02 && w !== h;
      track.width = swapped ? h : w;
      track.height = swapped ? w : h;
      track.frameRate = track.duration > 0 ? table.count / (track.duration - track.start || track.duration) : 30;
    }
    return track;
  }

  async function demux(blob) {
    const reader = new BlobReader(blob);
    const top = await readTopLevel(reader);
    const moovInfo = top.find((b) => b.type === 'moov');
    if (!moovInfo) {
      const isWebm = top.length === 0;
      throw new Error(isWebm ? 'Not an MP4/MOV file' : 'No movie header found');
    }
    if (top.some((b) => b.type === 'moof')) {
      // Fragmented MP4: the sample tables live in moof boxes we don't parse yet.
      const err = new Error('Fragmented MP4 files are not supported yet');
      err.code = 'FRAGMENTED';
      throw err;
    }
    const moov = await reader.readDirect(moovInfo.start, moovInfo.size);
    const inner = { data: 8, end: moov.length };
    const mvhd = findBox(moov, 'mvhd', inner.data, inner.end);
    const mv = dv(moov);
    const movieTimescale = mvhd ? mv.getUint32(mvhd.data + (moov[mvhd.data] === 1 ? 20 : 12)) : 1000;

    let video = null, audio = null;
    for (const b of boxes(moov, inner.data, inner.end)) {
      if (b.type !== 'trak') continue;
      const t = parseTrak(moov, b, movieTimescale);
      if (!t || t.samples.count === 0) continue;
      if (t.type === 'video' && !video) video = t;
      if (t.type === 'audio' && !audio) audio = t;
    }
    if (!video) throw new Error('No video track found');
    const duration = Math.max(video.duration, audio ? audio.duration : 0);
    return { reader, video, audio, duration, blob };
  }

  // Index of the last sample (in decode order) whose pts <= t. Samples are in
  // decode order, so we scan pts with a binary search on dts-ordered data
  // approximated by sorting once.
  function presentationOrder(track) {
    if (track._order) return track._order;
    const idx = Array.from({ length: track.samples.count }, (_, i) => i);
    idx.sort((a, b) => track.samples.pts[a] - track.samples.pts[b]);
    track._order = idx;
    return idx;
  }

  // Decode-order index of the keyframe to start decoding from to show time t.
  function keyframeBefore(track, t) {
    const s = track.samples;
    let best = 0;
    for (let i = 0; i < s.count; i++) {
      if (s.sync[i] && s.pts[i] <= t + 1e-6) best = i;
    }
    return best;
  }

  async function readSample(reader, track, i) {
    return reader.read(track.samples.offsets[i], track.samples.sizes[i]);
  }

  // ---------------------------------------------------------------------------
  // Muxer
  // ---------------------------------------------------------------------------
  class Writer {
    constructor() { this.parts = []; this.length = 0; }
    bytes(u8) { this.parts.push(u8); this.length += u8.length; }
    u8(n) { this.bytes(Uint8Array.of(n & 0xff)); }
    u16(n) { const b = new Uint8Array(2); dv(b).setUint16(0, n); this.bytes(b); }
    i16(n) { const b = new Uint8Array(2); dv(b).setInt16(0, n); this.bytes(b); }
    u24(n) { this.bytes(Uint8Array.of((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff)); }
    u32(n) { const b = new Uint8Array(4); dv(b).setUint32(0, n >>> 0); this.bytes(b); }
    i32(n) { const b = new Uint8Array(4); dv(b).setInt32(0, n); this.bytes(b); }
    u64(n) { const b = new Uint8Array(8); dv(b).setBigUint64(0, BigInt(Math.round(n))); this.bytes(b); }
    str(s) { for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i)); }
    zeros(n) { this.bytes(new Uint8Array(n)); }
    toU8() {
      const out = new Uint8Array(this.length);
      let p = 0;
      for (const part of this.parts) { out.set(part, p); p += part.length; }
      return out;
    }
  }

  function box(type, ...children) {
    const w = new Writer();
    let len = 8;
    const parts = children.map((c) => (c instanceof Uint8Array ? c : c.toU8 ? c.toU8() : c));
    for (const p of parts) len += p.length;
    w.u32(len); w.str(type);
    for (const p of parts) w.bytes(p);
    return w.toU8();
  }
  function fullBox(type, version, flags, build) {
    const w = new Writer();
    w.u8(version); w.u24(flags);
    build(w);
    return box(type, w.toU8());
  }

  const MATRIX = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000];
  // Display matrix for a clockwise rotation (0/90/180/270), inverse of parseMatrixRotation.
  function rotationMatrix(deg) {
    const r = ((deg || 0) % 360 + 360) % 360;
    const cos = Math.round(Math.cos(r * Math.PI / 180)), sin = Math.round(Math.sin(r * Math.PI / 180));
    return [cos * 0x10000, sin * 0x10000, 0, -sin * 0x10000, cos * 0x10000, 0, 0, 0, 0x40000000].map((x) => x >>> 0);
  }

  function descriptor(tag, payload) {
    const w = new Writer();
    w.u8(tag);
    // 4-byte length encoding (widely compatible)
    const len = payload.length;
    w.u8(0x80 | ((len >> 21) & 0x7f)); w.u8(0x80 | ((len >> 14) & 0x7f)); w.u8(0x80 | ((len >> 7) & 0x7f)); w.u8(len & 0x7f);
    w.bytes(payload);
    return w.toU8();
  }

  function buildAsc(sampleRate, channels) {
    const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
    const idx = Math.max(0, rates.indexOf(sampleRate));
    return Uint8Array.of((2 << 3) | (idx >> 1), ((idx & 1) << 7) | (channels << 3));
  }

  class Muxer {
    /**
     * @param {object} opts
     *   video: { codec: 'avc'|'hevc', width, height, description }
     *   audio: { codec: 'aac'|'opus', sampleRate, channels, description } | null
     */
    constructor(opts) {
      this.tracks = [];
      if (opts.video) {
        this.tracks.push({ kind: 'video', id: 1, timescale: 90000, cfg: opts.video, samples: [] });
      }
      if (opts.audio) {
        this.tracks.push({ kind: 'audio', id: this.tracks.length + 1, timescale: opts.audio.sampleRate, cfg: opts.audio, samples: [] });
      }
    }
    get video() { return this.tracks.find((t) => t.kind === 'video'); }
    get audio() { return this.tracks.find((t) => t.kind === 'audio'); }

    addVideo(data, pts, dur, key, description) {
      const t = this.video;
      if (description && !t.cfg.description) t.cfg.description = new Uint8Array(description);
      t.samples.push({ data, size: data.length, pts, dur, key });
    }
    addAudio(data, pts, dur, description) {
      const t = this.audio;
      if (description && !t.cfg.description) t.cfg.description = new Uint8Array(description);
      t.samples.push({ data, size: data.length, pts, dur, key: true });
    }
    // Sample whose bytes are fetched later (see layout()); `ref` is passed back to the caller.
    addLazy(kind, size, pts, dur, key, ref) {
      this[kind].samples.push({ data: null, size, pts, dur, key, ref });
    }

    _prepare(t) {
      // Convert seconds into integer ticks, derive decode timestamps and
      // composition offsets (handles encoders that emit B-frames).
      const ts = t.timescale;
      const s = t.samples;
      const n = s.length;
      const ptsT = s.map((x) => Math.round(x.pts * ts));
      const sorted = ptsT.slice().sort((a, b) => a - b);
      let shift = 0;
      for (let i = 0; i < n; i++) shift = Math.max(shift, sorted[i] - ptsT[i]);
      const dtsT = sorted.map((x) => x - shift);
      const durT = new Array(n);
      for (let i = 0; i < n; i++) {
        durT[i] = i + 1 < n ? dtsT[i + 1] - dtsT[i] : Math.max(1, Math.round(s[i].dur * ts));
      }
      const ctts = ptsT.map((p, i) => p - dtsT[i]);
      t.prep = { ptsT, dtsT, durT, ctts, shift, needCtts: ctts.some((c) => c !== 0) };
      const first = n ? sorted[0] : 0;
      t.prep.mediaStart = first; // media time of first presented sample
      t.prep.mediaDuration = n ? (sorted[n - 1] + Math.max(1, Math.round(s[s.length - 1].dur * ts))) - first : 0;
    }

    _sampleEntry(t) {
      const c = t.cfg;
      if (c.rawEntry) return c.rawEntry; // lossless passthrough
      if (t.kind === 'video') {
        const w = new Writer();
        w.zeros(6); w.u16(1); // reserved + data_reference_index
        w.u16(0); w.u16(0); w.zeros(12);
        w.u16(c.width); w.u16(c.height);
        w.u32(0x00480000); w.u32(0x00480000); w.u32(0); w.u16(1);
        w.zeros(32); w.u16(0x18); w.i16(-1);
        const cfgBox = box(c.codec === 'hevc' ? 'hvcC' : 'avcC', c.description || new Uint8Array(0));
        w.bytes(cfgBox);
        return box(c.codec === 'hevc' ? 'hvc1' : 'avc1', w.toU8());
      }
      const w = new Writer();
      w.zeros(6); w.u16(1);
      w.zeros(8);
      w.u16(c.channels); w.u16(16); w.u16(0); w.u16(0);
      w.u32((c.codec === 'opus' ? 48000 : c.sampleRate) * 65536 >>> 0);
      if (c.codec === 'opus') {
        // dOps (big-endian). Pre-skip from OpusHead if the encoder provided it.
        let preSkip = 312;
        const d = c.description;
        if (d && d.length >= 12 && td.decode(d.subarray(0, 8)) === 'OpusHead') preSkip = d[10] | (d[11] << 8);
        const o = new Writer();
        o.u8(0); o.u8(c.channels); o.u16(preSkip); o.u32(c.sampleRate); o.i16(0); o.u8(0);
        w.bytes(box('dOps', o.toU8()));
        return box('Opus', w.toU8());
      }
      const asc = c.description && c.description.length ? c.description : buildAsc(c.sampleRate, c.channels);
      const dsi = descriptor(0x05, asc);
      const dcdW = new Writer();
      dcdW.u8(0x40); dcdW.u8(0x15); dcdW.u24(0); dcdW.u32(c.bitrate || 128000); dcdW.u32(c.bitrate || 128000);
      dcdW.bytes(dsi);
      const dcd = descriptor(0x04, dcdW.toU8());
      const sl = descriptor(0x06, Uint8Array.of(0x02));
      const esW = new Writer();
      esW.u16(1); esW.u8(0); esW.bytes(dcd); esW.bytes(sl);
      const es = descriptor(0x03, esW.toU8());
      const esds = fullBox('esds', 0, 0, (x) => x.bytes(es));
      w.bytes(esds);
      return box('mp4a', w.toU8());
    }

    _trak(t, movieTs, chunkOffsets, chunks) {
      const p = t.prep;
      const durMovie = Math.round(p.mediaDuration / t.timescale * movieTs);
      const isV = t.kind === 'video';
      const tkhd = fullBox('tkhd', 0, 3, (w) => {
        w.u32(0); w.u32(0); w.u32(t.id); w.u32(0); w.u32(durMovie);
        w.zeros(8); w.u16(0); w.u16(0); w.u16(isV ? 0 : 0x0100); w.u16(0);
        for (const m of (isV ? rotationMatrix(t.cfg.rotation) : MATRIX)) w.u32(m);
        w.u32(isV ? t.cfg.width * 65536 : 0); w.u32(isV ? t.cfg.height * 65536 : 0);
      });
      // Edit list so the first presented sample starts at 0.
      const elst = fullBox('elst', 0, 0, (w) => {
        w.u32(1); w.u32(durMovie); w.i32(p.shift); w.u16(1); w.u16(0);
      });
      const edts = box('edts', elst);
      const mdhd = fullBox('mdhd', 0, 0, (w) => {
        w.u32(0); w.u32(0); w.u32(t.timescale); w.u32(p.dtsT.length ? p.dtsT[p.dtsT.length - 1] + p.durT[p.durT.length - 1] - p.dtsT[0] : 0);
        w.u16(0x55c4); w.u16(0);
      });
      const hdlr = fullBox('hdlr', 0, 0, (w) => {
        w.u32(0); w.str(isV ? 'vide' : 'soun'); w.zeros(12); w.str(isV ? 'VideoHandler' : 'SoundHandler'); w.u8(0);
      });
      const mhd = isV ? fullBox('vmhd', 0, 1, (w) => { w.u16(0); w.zeros(6); }) : fullBox('smhd', 0, 0, (w) => { w.u16(0); w.u16(0); });
      const dinf = box('dinf', fullBox('dref', 0, 0, (w) => { w.u32(1); w.bytes(fullBox('url ', 0, 1, () => {})); }));
      const stsd = fullBox('stsd', 0, 0, (w) => { w.u32(1); w.bytes(this._sampleEntry(t)); });
      // stts (run-length)
      const sttsRuns = [];
      for (const d of p.durT) {
        const last = sttsRuns[sttsRuns.length - 1];
        if (last && last[1] === d) last[0]++; else sttsRuns.push([1, d]);
      }
      const stts = fullBox('stts', 0, 0, (w) => { w.u32(sttsRuns.length); for (const [c, d] of sttsRuns) { w.u32(c); w.u32(d); } });
      const parts = [stsd, stts];
      if (isV) {
        const keys = [];
        t.samples.forEach((s, i) => { if (s.key) keys.push(i + 1); });
        parts.push(fullBox('stss', 0, 0, (w) => { w.u32(keys.length); for (const k of keys) w.u32(k); }));
      }
      if (p.needCtts) {
        const runs = [];
        for (const c of p.ctts) {
          const last = runs[runs.length - 1];
          if (last && last[1] === c) last[0]++; else runs.push([1, c]);
        }
        parts.push(fullBox('ctts', 1, 0, (w) => { w.u32(runs.length); for (const [c, o] of runs) { w.u32(c); w.i32(o); } }));
      }
      // stsc
      const stscRuns = [];
      chunks.forEach((ch, i) => {
        const last = stscRuns[stscRuns.length - 1];
        if (!last || last[1] !== ch.count) stscRuns.push([i + 1, ch.count]);
      });
      parts.push(fullBox('stsc', 0, 0, (w) => { w.u32(stscRuns.length); for (const [f, c] of stscRuns) { w.u32(f); w.u32(c); w.u32(1); } }));
      parts.push(fullBox('stsz', 0, 0, (w) => { w.u32(0); w.u32(t.samples.length); for (const s of t.samples) w.u32(s.size); }));
      parts.push(fullBox('co64', 0, 0, (w) => { w.u32(chunkOffsets.length); for (const o of chunkOffsets) w.u64(o); }));
      const stbl = box('stbl', ...parts);
      const minf = box('minf', mhd, dinf, stbl);
      const mdia = box('mdia', mdhd, hdlr, minf);
      return box('trak', tkhd, edts, mdia);
    }

    // Computes the file layout. Returns the header bytes (ftyp + moov + mdat
    // header) and the samples in the order their bytes must follow.
    layout() {
      const tracks = this.tracks.filter((t) => t.samples.length);
      for (const t of tracks) this._prepare(t);

      // Interleave: chunks of ~0.5 s per track, ordered by start time.
      const chunkList = [];
      for (const t of tracks) {
        t.chunks = [];
        let cur = null;
        t.samples.forEach((s, i) => {
          const time = t.prep.dtsT[i] / t.timescale;
          if (!cur || time - cur.time >= 0.5) {
            cur = { track: t, time, first: i, count: 0, size: 0 };
            t.chunks.push(cur);
            chunkList.push(cur);
          }
          cur.count++;
          cur.size += s.size;
        });
      }
      chunkList.sort((a, b) => a.time - b.time || a.track.id - b.track.id);

      const movieTs = 1000;
      const buildMoov = (offsetsFor) => {
        let dur = 0;
        for (const t of tracks) dur = Math.max(dur, Math.round(t.prep.mediaDuration / t.timescale * movieTs));
        const mvhd = fullBox('mvhd', 0, 0, (w) => {
          w.u32(0); w.u32(0); w.u32(movieTs); w.u32(dur);
          w.u32(0x00010000); w.u16(0x0100); w.zeros(10);
          for (const m of MATRIX) w.u32(m);
          w.zeros(24); w.u32(tracks.length + 1);
        });
        const traks = tracks.map((t) => this._trak(t, movieTs, offsetsFor(t), t.chunks));
        return box('moov', mvhd, ...traks);
      };

      const ftyp = box('ftyp', (() => { const w = new Writer(); w.str('isom'); w.u32(0x200); w.str('isom'); w.str('iso2'); w.str(this.video && this.video.cfg.codec === 'hevc' ? 'hvc1' : 'avc1'); w.str('mp41'); return w.toU8(); })());

      // First pass to learn moov size (co64 entries are fixed-width).
      const placeholder = buildMoov((t) => new Array(t.chunks.length).fill(0));
      let mdatPayload = 0;
      for (const c of chunkList) mdatPayload += c.size;
      const large = mdatPayload + 8 > 0xffffffff;
      const mdatHeader = large ? 16 : 8;
      let pos = ftyp.length + placeholder.length + mdatHeader;
      for (const c of chunkList) { c.offset = pos; pos += c.size; }
      const moov = buildMoov((t) => t.chunks.map((c) => c.offset));

      const hw = new Writer();
      if (large) { hw.u32(1); hw.str('mdat'); hw.u64(mdatPayload + 16); } else { hw.u32(mdatPayload + 8); hw.str('mdat'); }
      const header = new Uint8Array(ftyp.length + moov.length + hw.length);
      header.set(ftyp, 0); header.set(moov, ftyp.length); header.set(hw.toU8(), ftyp.length + moov.length);
      const order = [];
      for (const c of chunkList) {
        for (let i = c.first; i < c.first + c.count; i++) order.push(c.track.samples[i]);
      }
      return { header, order };
    }

    finalize() {
      const { header, order } = this.layout();
      return new Blob([header, ...order.map((s) => s.data)], { type: 'video/mp4' });
    }
  }

  /**
   * Losslessly copy the part [tIn, tOut] of a demuxed file into a new MP4,
   * streaming the bytes to `write(u8)` (nothing is held in memory). The cut
   * starts at the keyframe before tIn, so the copy may begin slightly earlier.
   * @returns {Promise<{ base: number, duration: number }>} base = source time of the copy's t=0
   */
  async function remuxRange(d, tIn, tOut, write, onProgress = () => {}) {
    const v = d.video, a = d.audio;
    const vs = v.samples;
    const k0 = keyframeBefore(v, tIn);
    let k1 = vs.count;
    for (let i = k0 + 1; i < vs.count; i++) if (vs.sync[i] && vs.pts[i] >= tOut) { k1 = i; break; }
    let base = Infinity, end = 0;
    for (let i = k0; i < k1; i++) { base = Math.min(base, vs.pts[i]); end = Math.max(end, vs.pts[i] + vs.dur[i]); }

    const mux = new Muxer({
      video: { rawEntry: v.rawEntry, width: v.width, height: v.height, rotation: v.rotation },
      // AAC/Opus entries are rebuilt (QuickTime v1/v2 sound entries aren't valid in MP4); others are copied.
      audio: a ? (a.codec === 'aac' || a.codec === 'opus'
        ? { codec: a.codec, sampleRate: a.sampleRate, channels: a.channels, description: a.description }
        : { rawEntry: a.rawEntry, sampleRate: a.timescale, channels: a.channels }) : null,
    });
    for (let i = k0; i < k1; i++) mux.addLazy('video', vs.sizes[i], vs.pts[i] - base, vs.dur[i], !!vs.sync[i], { t: 'v', i });
    if (a) {
      const as = a.samples;
      for (let i = 0; i < as.count; i++) {
        const t = as.pts[i] - base;
        if (t < -1e-6 || as.pts[i] >= end) continue;
        mux.addLazy('audio', as.sizes[i], t, as.dur[i], true, { t: 'a', i });
      }
      if (!mux.audio.samples.length) mux.tracks = mux.tracks.filter((t) => t.kind !== 'audio');
    }
    const { header, order } = mux.layout();
    const total = header.length + order.reduce((s, x) => s + x.size, 0);
    const reader = new BlobReader(d.blob);
    const BUF = 4 * 1024 * 1024;
    let buf = new Uint8Array(BUF), fill = 0, written = 0;
    const flush = async () => { if (fill) { await write(buf.slice(0, fill)); written += fill; fill = 0; onProgress(written / total); } };
    const push = async (u8) => {
      if (u8.length > BUF) { await flush(); await write(u8); written += u8.length; return; }
      if (fill + u8.length > BUF) await flush();
      buf.set(u8, fill); fill += u8.length;
    };
    await push(header);
    for (const s of order) {
      const tr = s.ref.t === 'v' ? v : a;
      await push(await reader.read(tr.samples.offsets[s.ref.i], tr.samples.sizes[s.ref.i]));
    }
    await flush();
    return { base, duration: end - base };
  }

  global.MP4 = { demux, Muxer, BlobReader, keyframeBefore, presentationOrder, readSample, remuxRange };
})(typeof window !== 'undefined' ? window : globalThis);
