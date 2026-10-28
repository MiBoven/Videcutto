/*
 * zip.js — minimal ZIP writer and reader for Videcutto project files.
 *
 * Entries are stored uncompressed (videos and images are compressed already).
 * The writer builds the archive as a Blob made of small header parts and the
 * original File/Blob objects, so even multi-gigabyte videos are never loaded
 * into memory — only read once in chunks to compute their CRC-32. ZIP64 is
 * used automatically when sizes or offsets exceed 4 GB.
 */
(function (global) {
  'use strict';

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crcUpdate(crc, u8) {
    let c = crc ^ 0xffffffff;
    for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  /** CRC-32 of a Blob, read in chunks. onBytes(n) is called with the bytes read. */
  async function crc32Blob(blob, onBytes = () => {}, signal) {
    const CHUNK = 8 * 1024 * 1024;
    let crc = 0;
    for (let p = 0; p < blob.size; p += CHUNK) {
      if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const u8 = new Uint8Array(await blob.slice(p, Math.min(blob.size, p + CHUNK)).arrayBuffer());
      crc = crcUpdate(crc, u8);
      onBytes(u8.length);
    }
    return crc;
  }

  const enc = new TextEncoder();
  const LIMIT = 0xffffffff;

  function dosDateTime(d) {
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2));
    const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return { time, date };
  }

  class Buf {
    constructor(n) { this.u8 = new Uint8Array(n); this.v = new DataView(this.u8.buffer); this.p = 0; }
    u16(x) { this.v.setUint16(this.p, x, true); this.p += 2; return this; }
    u32(x) { this.v.setUint32(this.p, x >>> 0, true); this.p += 4; return this; }
    u64(x) { this.v.setBigUint64(this.p, BigInt(x), true); this.p += 8; return this; }
    bytes(b) { this.u8.set(b, this.p); this.p += b.length; return this; }
  }

  /**
   * Build a ZIP archive.
   * @param entries [{ name, blob }] (blob may be a File)
   * @param opts { onProgress(fraction), signal, force64 (tests) }
   * @returns {Promise<Blob>}
   */
  async function createZip(entries, opts = {}) {
    const { onProgress = () => {}, signal, force64 = false } = opts;
    const total = entries.reduce((s, e) => s + e.blob.size, 0) || 1;
    let done = 0;
    const { time, date } = dosDateTime(new Date());
    const parts = [];
    const central = [];
    let offset = 0;

    for (const e of entries) {
      const name = enc.encode(e.name);
      const size = e.blob.size;
      const crc = await crc32Blob(e.blob, (n) => { done += n; onProgress(done / total); }, signal);
      const z64 = force64 || size >= LIMIT || offset >= LIMIT;
      // Local header
      const lh = new Buf(30 + name.length + (z64 ? 20 : 0));
      lh.u32(0x04034b50).u16(z64 ? 45 : 20).u16(0x0800).u16(0).u16(time).u16(date)
        .u32(crc).u32(z64 ? LIMIT : size).u32(z64 ? LIMIT : size).u16(name.length).u16(z64 ? 20 : 0).bytes(name);
      if (z64) lh.u16(0x0001).u16(16).u64(size).u64(size);
      parts.push(lh.u8, e.blob);
      central.push({ name, size, crc, offset, z64 });
      offset += lh.u8.length + size;
    }

    const cdStart = offset;
    for (const c of central) {
      const extra = c.z64 ? 28 : 0;
      const ch = new Buf(46 + c.name.length + extra);
      ch.u32(0x02014b50).u16(c.z64 ? 45 : 20).u16(c.z64 ? 45 : 20).u16(0x0800).u16(0).u16(time).u16(date)
        .u32(c.crc).u32(c.z64 ? LIMIT : c.size).u32(c.z64 ? LIMIT : c.size).u16(c.name.length).u16(extra).u16(0)
        .u16(0).u16(0).u32(0).u32(c.z64 ? LIMIT : c.offset).bytes(c.name);
      if (c.z64) ch.u16(0x0001).u16(24).u64(c.size).u64(c.size).u64(c.offset);
      parts.push(ch.u8);
      offset += ch.u8.length;
    }
    const cdSize = offset - cdStart;
    const n = central.length;
    const need64 = force64 || n >= 0xffff || cdStart >= LIMIT || cdSize >= LIMIT;
    if (need64) {
      const z = new Buf(56 + 20);
      z.u32(0x06064b50).u64(44).u16(45).u16(45).u32(0).u32(0).u64(n).u64(n).u64(cdSize).u64(cdStart);
      z.u32(0x07064b50).u32(0).u64(offset).u32(1);
      parts.push(z.u8);
    }
    const eocd = new Buf(22);
    eocd.u32(0x06054b50).u16(0).u16(0).u16(need64 ? 0xffff : n).u16(need64 ? 0xffff : n)
      .u32(need64 ? LIMIT : cdSize).u32(need64 ? LIMIT : cdStart).u16(0);
    parts.push(eocd.u8);
    onProgress(1);
    return new Blob(parts, { type: 'application/zip' });
  }

  /**
   * Read the table of contents of a ZIP file (stored entries only).
   * @returns {Promise<Map<string, {offset, size, crc}>>} offset = start of the entry's data
   */
  async function readZip(file) {
    const tailLen = Math.min(file.size, 65536 + 22);
    const tail = new Uint8Array(await file.slice(file.size - tailLen).arrayBuffer());
    const tv = new DataView(tail.buffer);
    let e = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tv.getUint32(i, true) === 0x06054b50) { e = i; break; }
    if (e < 0) throw new Error('Not a ZIP file');
    let count = tv.getUint16(e + 10, true);
    let cdSize = tv.getUint32(e + 12, true);
    let cdStart = tv.getUint32(e + 16, true);
    if (count === 0xffff || cdSize === LIMIT || cdStart === LIMIT) {
      const loc = e - 20;
      if (loc < 0 || tv.getUint32(loc, true) !== 0x07064b50) throw new Error('Broken ZIP64 file');
      const z64off = Number(tv.getBigUint64(loc + 8, true));
      const z = new DataView(await file.slice(z64off, z64off + 56).arrayBuffer());
      if (z.getUint32(0, true) !== 0x06064b50) throw new Error('Broken ZIP64 file');
      count = Number(z.getBigUint64(32, true));
      cdSize = Number(z.getBigUint64(40, true));
      cdStart = Number(z.getBigUint64(48, true));
    }
    const cd = new Uint8Array(await file.slice(cdStart, cdStart + cdSize).arrayBuffer());
    const cv = new DataView(cd.buffer);
    const dec = new TextDecoder();
    const out = new Map();
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (cv.getUint32(p, true) !== 0x02014b50) throw new Error('Broken ZIP directory');
      const method = cv.getUint16(p + 10, true);
      const crc = cv.getUint32(p + 16, true);
      let size = cv.getUint32(p + 24, true);
      const nameLen = cv.getUint16(p + 28, true);
      const extraLen = cv.getUint16(p + 30, true);
      const commentLen = cv.getUint16(p + 32, true);
      let lho = cv.getUint32(p + 42, true);
      const name = dec.decode(cd.subarray(p + 46, p + 46 + nameLen));
      // ZIP64 extra: present values replace the 0xFFFFFFFF fields in order.
      let x = p + 46 + nameLen;
      const xEnd = x + extraLen;
      while (x + 4 <= xEnd) {
        const id = cv.getUint16(x, true), len = cv.getUint16(x + 2, true);
        if (id === 0x0001) {
          let q = x + 4;
          const csize = cv.getUint32(p + 20, true);
          if (size === LIMIT) { size = Number(cv.getBigUint64(q, true)); q += 8; }
          if (csize === LIMIT) q += 8;
          if (lho === LIMIT) { lho = Number(cv.getBigUint64(q, true)); q += 8; }
        }
        x += 4 + len;
      }
      if (method !== 0) throw new Error('Compressed entries are not supported');
      const lh = new DataView(await file.slice(lho, lho + 30).arrayBuffer());
      const dataOffset = lho + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
      out.set(name, { offset: dataOffset, size, crc });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  }

  global.Zip = { createZip, readZip, crc32Blob };
})(typeof window !== 'undefined' ? window : globalThis);
