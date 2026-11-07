/*
 * meta.js — reads the EXIF data of photos (JPEG, WebP, PNG eXIf) for Videcutto:
 * recording date, place (GPS), camera, software, description, author.
 * Result in the same shape as MP4.readMeta():
 *   { utc, tz, lat, lon, alt, make, model, software, description, author }
 */
(function (global) {
  'use strict';

  function readTiff(u8, off) {
    const v = new DataView(u8.buffer, u8.byteOffset + off, u8.byteLength - off);
    const le = v.getUint16(0) === 0x4949;
    if (!le && v.getUint16(0) !== 0x4d4d) return null;
    const u16 = (p) => v.getUint16(p, le), u32 = (p) => v.getUint32(p, le);
    const SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
    function ifd(p) {
      const out = {};
      if (p <= 0 || p + 2 > v.byteLength) return out;
      const n = u16(p);
      for (let i = 0; i < n; i++) {
        const e = p + 2 + i * 12;
        if (e + 12 > v.byteLength) break;
        const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
        const len = (SIZE[type] || 1) * count;
        const at = len > 4 ? u32(e + 8) : e + 8;
        if (at + len > v.byteLength) continue;
        if (type === 2) { let s = ''; for (let k = 0; k < count; k++) { const c = v.getUint8(at + k); if (!c) break; s += String.fromCharCode(c); } out[tag] = s.trim(); }
        else if (type === 5 || type === 10) { const a = []; for (let k = 0; k < count; k++) { const d = u32(at + k * 8 + 4); a.push(d ? (type === 10 ? v.getInt32(at + k * 8, le) : u32(at + k * 8)) / d : 0); } out[tag] = a; }
        else if (type === 3) out[tag] = u16(at);
        else if (type === 4) out[tag] = u32(at);
        else if (type === 1 || type === 7) out[tag] = v.getUint8(at);
      }
      return out;
    }
    const i0 = ifd(u32(4));
    const ex = i0[0x8769] ? ifd(i0[0x8769]) : {};
    const gps = i0[0x8825] ? ifd(i0[0x8825]) : {};
    const m = {};
    const utf = (s) => { try { return decodeURIComponent(escape(s)); } catch (e) { return s; } }; // EXIF strings are often UTF-8
    if (i0[0x010f]) m.make = utf(i0[0x010f]);
    if (i0[0x0110]) m.model = utf(i0[0x0110]);
    if (i0[0x0131]) m.software = utf(i0[0x0131]);
    if (i0[0x010e]) m.description = utf(i0[0x010e]);
    if (i0[0x013b]) m.author = utf(i0[0x013b]);
    const date = ex[0x9003] || ex[0x9004] || i0[0x0132];
    const zone = ex[0x9011] || ex[0x9010];
    if (date && global.MP4) {
      const d = MP4.parseDate(date.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3') + (zone && /^[+-]\d{2}:\d{2}$/.test(zone) ? zone : ''));
      if (d) { m.utc = d.utc; m.tz = d.tz; }
    }
    const deg = (a) => (Array.isArray(a) && a.length >= 3 ? a[0] + a[1] / 60 + a[2] / 3600 : null);
    const lat = deg(gps[2]), lon = deg(gps[4]);
    if (lat != null && lon != null && (lat || lon)) {
      m.lat = +(gps[1] === 'S' ? -lat : lat).toFixed(6);
      m.lon = +(gps[3] === 'W' ? -lon : lon).toFixed(6);
      if (Array.isArray(gps[6])) m.alt = +((gps[5] === 1 ? -1 : 1) * gps[6][0]).toFixed(1);
    }
    return m;
  }

  /** EXIF of an image file (reads at most the first 256 KB). Never throws. */
  async function readImageMeta(file) {
    try {
      const u8 = new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer());
      const v = new DataView(u8.buffer);
      if (v.getUint16(0) === 0xffd8) { // JPEG: APP1 "Exif\0\0"
        let p = 2;
        while (p + 4 < u8.length && u8[p] === 0xff) {
          const marker = u8[p + 1], len = v.getUint16(p + 2);
          if (marker === 0xe1 && u8[p + 4] === 0x45 && u8[p + 5] === 0x78 && u8[p + 6] === 0x69 && u8[p + 7] === 0x66) return readTiff(u8, p + 10) || {};
          if (marker === 0xda) break;
          p += 2 + len;
        }
        return {};
      }
      const tag = String.fromCharCode(...u8.subarray(0, 4));
      if (tag === 'RIFF') { // WebP: EXIF chunk
        let p = 12;
        while (p + 8 < u8.length) {
          const id = String.fromCharCode(...u8.subarray(p, p + 4)), size = v.getUint32(p + 4, true);
          if (id === 'EXIF') { let o = p + 8; if (String.fromCharCode(...u8.subarray(o, o + 4)) === 'Exif') o += 6; return readTiff(u8, o) || {}; }
          p += 8 + size + (size & 1);
        }
      } else if (v.getUint32(0) === 0x89504e47) { // PNG: eXIf chunk
        let p = 8;
        while (p + 8 < u8.length) {
          const size = v.getUint32(p), id = String.fromCharCode(...u8.subarray(p + 4, p + 8));
          if (id === 'eXIf') return readTiff(u8, p + 8) || {};
          if (id === 'IDAT') break;
          p += 12 + size;
        }
      }
    } catch (e) { /* no metadata */ }
    return {};
  }

  global.Meta = { readImageMeta };
})(typeof window !== 'undefined' ? window : globalThis);
