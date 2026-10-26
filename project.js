/*
 * project.js — persistence for Videcutto's last project.
 *
 * - The edit state (tracks, clips, settings) is stored in IndexedDB.
 * - Media files can be copied into the Origin Private File System (OPFS), so
 *   they survive reloads and lost file permissions (mainly on phones).
 * - On desktop Chrome/Edge, FileSystemFileHandles of the original files are
 *   stored instead, so no extra space is used.
 * Everything is best-effort: if storage is blocked, the app keeps working
 * without saving.
 */
(function (global) {
  'use strict';

  const DB_NAME = 'videcutto';
  const STORE = 'kv';
  const MEDIA_DIR = 'media';
  let dbPromise = null;

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
        if (h.kind === 'file') out.push({ name, size: (await h.getFile()).size });
      }
    } catch (e) { /* no OPFS */ }
    return out;
  }

  // ---------------------------------------------------------------------------
  // File handles (Chrome/Edge desktop)
  // ---------------------------------------------------------------------------
  const canUseHandles = () => typeof global.showOpenFilePicker === 'function';

  async function saveHandle(mediaId, handle) {
    try { await set('handle:' + mediaId, handle); } catch (e) { /* not cloneable / blocked */ }
  }
  const loadHandle = (mediaId) => get('handle:' + mediaId);
  const removeHandle = (mediaId) => del('handle:' + mediaId);

  // ---------------------------------------------------------------------------
  // Project
  // ---------------------------------------------------------------------------
  const saveProject = (project) => set('project', project).catch(() => {});
  const loadProject = () => get('project');

  /** Remove the project, all copies and all stored handles. */
  async function clearAll() {
    await del('project');
    for (const k of await keys()) if (String(k).startsWith('handle:')) await del(k);
    for (const c of await listCopies()) await removeCopy(c.name);
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
    canCopy, writeCopy, copyWhole, getCopy, removeCopy, listCopies,
    canUseHandles, saveHandle, loadHandle, removeHandle,
    saveProject, loadProject, clearAll, requestPersist, freeSpace,
  };
})(typeof window !== 'undefined' ? window : globalThis);
