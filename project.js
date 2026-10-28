/*
 * project.js — persistence for Videcutto's projects.
 *
 * - Every project is stored in IndexedDB as `project:<id>` (clips, canvas,
 *   export settings, media list, name, thumbnail).
 * - Media files can be copied into the Origin Private File System (OPFS), so
 *   they survive reloads and lost file permissions (mainly on phones). A copy
 *   can be shared by several projects (duplicates); it is only deleted when no
 *   project refers to it anymore.
 * - On desktop Chrome/Edge, FileSystemFileHandles of the original files are
 *   stored per project (`handle:<projectId>:<mediaId>`), so no extra space is used.
 * Everything is best-effort: if storage is blocked, the app keeps working
 * without saving.
 */
(function (global) {
  'use strict';

  const DB_NAME = 'videcutto';
  const STORE = 'kv';
  const MEDIA_DIR = 'media';
  let dbPromise = null;
  let current = null; // id of the project open in this tab

  function db() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        if (!global.indexedDB) { reject(new Error('IndexedDB unavailable')); return; }
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      dbPromise.catch(() => { dbPromise = null; });
    }
    return dbPromise;
  }

  async function tx(mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req ? req.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  const get = (key) => tx('readonly', (s) => s.get(key)).catch(() => undefined);
  const set = (key, value) => tx('readwrite', (s) => s.put(value, key));
  const del = (key) => tx('readwrite', (s) => s.delete(key)).catch(() => {});
  const keys = () => tx('readonly', (s) => s.getAllKeys()).catch(() => []);

  const newId = () => Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 6);

  // ---------------------------------------------------------------------------
  // OPFS copies
  // ---------------------------------------------------------------------------
  function canCopy() {
    return !!(navigator.storage && navigator.storage.getDirectory && global.FileSystemFileHandle &&
      'createWritable' in FileSystemFileHandle.prototype);
  }

  async function mediaDir() {
    const rootDir = await navigator.storage.getDirectory();
    return rootDir.getDirectoryHandle(MEDIA_DIR, { create: true });
  }

  /**
   * Create a copy. `produce(write)` is called with an async write(Uint8Array)
   * function and must write the complete file.
   * @returns {Promise<File>}
   */
  async function writeCopy(name, produce) {
    const dir = await mediaDir();
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    try {
      await produce((u8) => w.write(u8));
      await w.close();
    } catch (e) {
      try { await w.abort(); } catch (err) { /* ignore */ }
      await dir.removeEntry(name).catch(() => {});
      throw e;
    }
    return fh.getFile();
  }

  /** Copy a whole file in chunks (with progress). */
  async function copyWhole(name, file, onProgress = () => {}) {
    return writeCopy(name, async (write) => {
      const CHUNK = 8 * 1024 * 1024;
      for (let p = 0; p < file.size; p += CHUNK) {
        await write(new Uint8Array(await file.slice(p, Math.min(file.size, p + CHUNK)).arrayBuffer()));
        onProgress(Math.min(1, (p + CHUNK) / file.size));
      }
    });
  }

  async function getCopy(name) {
    try {
      const dir = await mediaDir();
      const fh = await dir.getFileHandle(name);
      return await fh.getFile();
    } catch (e) {
      return null;
    }
  }

  async function removeCopy(name) {
    try { const dir = await mediaDir(); await dir.removeEntry(name); } catch (e) { /* already gone */ }
  }

  async function listCopies() {
    const out = [];
    try {
      const dir = await mediaDir();
      for await (const [name, h] of dir.entries()) {
        if (h.kind === 'file') { const f = await h.getFile(); out.push({ name, size: f.size, lastModified: f.lastModified }); }
      }
    } catch (e) { /* no OPFS */ }
    return out;
  }

  /** Map of copy name -> size, for storage figures. */
  async function copySizes() {
    const m = new Map();
    for (const c of await listCopies()) m.set(c.name, c.size);
    return m;
  }

  /** Delete a copy unless another saved project still uses it. */
  async function releaseCopy(name, exceptProjectId = current) {
    if (!name) return;
    const docs = await listProjects();
    if (docs.some((d) => d.id !== exceptProjectId && (d.media || []).some((m) => m.copyName === name))) return;
    await removeCopy(name);
  }

  /**
   * Remove copies no project refers to (e.g. left over after a crash). Only
   * files older than a day are touched, so a copy another tab has just written
   * but not saved yet is never deleted.
   */
  async function cleanupOrphans() {
    const used = new Set();
    for (const d of await listProjects()) for (const m of d.media || []) if (m.copyName) used.add(m.copyName);
    const dayAgo = Date.now() - 24 * 3600 * 1000;
    for (const c of await listCopies()) if (!used.has(c.name) && c.lastModified < dayAgo) await removeCopy(c.name);
  }

  // ---------------------------------------------------------------------------
  // File handles (Chrome/Edge desktop), stored per project
  // ---------------------------------------------------------------------------
  const canUseHandles = () => typeof global.showOpenFilePicker === 'function';
  const hkey = (mediaId, pid) => `handle:${pid || current}:${mediaId}`;

  async function saveHandle(mediaId, handle, pid) {
    try { await set(hkey(mediaId, pid), handle); } catch (e) { /* not cloneable / blocked */ }
  }
  const loadHandle = (mediaId, pid) => get(hkey(mediaId, pid));
  const removeHandle = (mediaId, pid) => del(hkey(mediaId, pid));

  // ---------------------------------------------------------------------------
  // Projects
  // ---------------------------------------------------------------------------
  const setCurrent = (id) => { current = id; };
  const getCurrent = () => current;

  const saveProject = (doc) => set('project:' + doc.id, doc).catch(() => {});
  const loadProject = (id) => get('project:' + id);

  async function listProjects() {
    const out = [];
    for (const k of await keys()) {
      if (typeof k === 'string' && k.startsWith('project:')) {
        const d = await get(k);
        if (d) out.push(d);
      }
    }
    return out.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  }

  /** Delete a project, its handles and the copies only it used. */
  async function deleteProject(id) {
    const doc = await loadProject(id);
    await del('project:' + id);
    for (const k of await keys()) if (typeof k === 'string' && k.startsWith(`handle:${id}:`)) await del(k);
    for (const m of (doc && doc.media) || []) if (m.copyName) await releaseCopy(m.copyName, id);
  }

  /**
   * Duplicate a project. mode 'share': the copy uses the same video files;
   * mode 'independent': every working copy is duplicated as well.
   * @returns {Promise<object>} the new project document
   */
  async function duplicateProject(id, mode, onProgress = () => {}) {
    const doc = await loadProject(id);
    if (!doc) throw new Error('Project not found');
    const nid = newId();
    const copy = JSON.parse(JSON.stringify(doc));
    copy.id = nid;
    copy.name = `${doc.name || 'Project'} (copy)`;
    copy.createdAt = copy.savedAt = Date.now();
    if (mode === 'independent') {
      const list = copy.media.filter((m) => m.copyName);
      for (let i = 0; i < list.length; i++) {
        const m = list[i];
        const f = await getCopy(m.copyName);
        if (!f) continue;
        const name = m.copyName.replace(/(\.[a-z0-9]+)?$/i, (ext) => `-d${nid}${ext}`);
        await copyWhole(name, f, (p) => onProgress((i + p) / list.length));
        m.copyName = name;
      }
    }
    for (const m of copy.media || []) {
      const h = await loadHandle(m.id, id);
      if (h) await saveHandle(m.id, h, nid);
    }
    await saveProject(copy);
    return copy;
  }

  /** Bytes used by a project's working copies (shared copies count fully). */
  function projectBytes(doc, sizes) {
    const seen = new Set();
    let total = 0;
    for (const m of doc.media || []) {
      if (m.copyName && !seen.has(m.copyName)) { seen.add(m.copyName); total += sizes.get(m.copyName) || 0; }
    }
    return total;
  }

  /** 0.2–0.5 stored a single project under 'project'; move it into the library. */
  async function migrateLegacy() {
    const old = await get('project');
    if (!old) return null;
    const id = newId();
    const firstMedia = (old.media || [])[0];
    old.id = id;
    old.name = old.name || (firstMedia ? String(firstMedia.name).replace(/\.[^.]+$/, '') : 'Project 1');
    old.createdAt = old.savedAt || Date.now();
    await saveProject(old);
    for (const k of await keys()) {
      if (typeof k === 'string' && /^handle:[^:]+$/.test(k)) {
        const h = await get(k);
        if (h) await set(`handle:${id}:${k.slice(7)}`, h);
        await del(k);
      }
    }
    await del('project');
    return id;
  }

  let persistAsked = false;
  function requestPersist() {
    // Firefox shows a permission prompt for this; other browsers decide silently.
    if (persistAsked || !navigator.storage || !navigator.storage.persist || /firefox/i.test(navigator.userAgent)) return;
    persistAsked = true;
    navigator.storage.persist().catch(() => {});
  }

  async function freeSpace() {
    try {
      const e = await navigator.storage.estimate();
      return Math.max(0, (e.quota || 0) - (e.usage || 0));
    } catch (err) {
      return Infinity;
    }
  }

  global.Project = {
    newId, setCurrent, getCurrent,
    canCopy, writeCopy, copyWhole, getCopy, removeCopy, releaseCopy, listCopies, copySizes, cleanupOrphans,
    canUseHandles, saveHandle, loadHandle, removeHandle,
    saveProject, loadProject, listProjects, deleteProject, duplicateProject, projectBytes, migrateLegacy,
    requestPersist, freeSpace,
  };
})(typeof window !== 'undefined' ? window : globalThis);
