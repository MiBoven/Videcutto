/*
 * app.js — Videcutto UI: loading, pre-trimming, timeline editing, preview
 * playback and export. The heavy lifting lives in mp4.js and render.js.
 */
(() => {
  'use strict';

  const VERSION = '0.3.0';
  const $ = (id) => document.getElementById(id);

  // ---------------------------------------------------------------------------
  // Storage (wrapped — private mode or blocked storage must not break the app)
  // ---------------------------------------------------------------------------
  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem('videcutto-' + key); return v === null ? fallback : JSON.parse(v); } catch (e) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem('videcutto-' + key, JSON.stringify(value)); } catch (e) { /* ignore */ }
    },
  };

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  let uid = 0;
  const newId = () => 'c' + (++uid);

  function fmtTime(t, cs = true) {
    t = Math.max(0, t || 0);
    if (!cs) t = Math.round(t);
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = t % 60;
    const ss = cs ? s.toFixed(2).padStart(5, '0') : String(Math.floor(s)).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  }
  function fmtSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 ** 3) return (bytes / 1024 / 1024).toFixed(bytes < 100 * 1024 * 1024 ? 1 : 0) + ' MB';
    return (bytes / 1024 ** 3).toFixed(2) + ' GB';
  }

  let toastTimer = null;
  function toast(msg, ms = 3200) {
    const el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms);
  }

  function once(target, event, timeout = 0) {
    return new Promise((resolve) => {
      let t = null;
      const done = (ok) => { clearTimeout(t); target.removeEventListener(event, handler); resolve(ok); };
      const handler = () => done(true);
      target.addEventListener(event, handler);
      if (timeout) t = setTimeout(() => done(false), timeout);
    });
  }

  const isCoarse = window.matchMedia('(pointer: coarse)').matches;

  // ---------------------------------------------------------------------------
  // Version
  // ---------------------------------------------------------------------------
  $('versionFooter').textContent = VERSION;
  $('versionAbout').textContent = VERSION;

  // ---------------------------------------------------------------------------
  // Theme / menu / fullscreen / modals
  // ---------------------------------------------------------------------------
  const root = document.documentElement;
  function setTheme(t) {
    root.setAttribute('data-theme', t);
    store.set('theme', t);
    $('themeLabel').textContent = t === 'dark' ? 'Light mode' : 'Dark mode';
    document.querySelector('meta[name="theme-color"]').setAttribute('content', t === 'dark' ? '#131313' : '#f4f4f2');
  }
  setTheme(store.get('theme', 'dark'));

  const menu = $('menu');
  const closeMenu = () => { menu.style.display = 'none'; };
  $('menuBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
  });
  document.addEventListener('click', (e) => { if (!menu.contains(e.target)) closeMenu(); });
  $('themeItem').addEventListener('click', () => { setTheme(root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'); closeMenu(); });
  $('settingsItem').addEventListener('click', () => { closeMenu(); openModal('settingsModal'); });
  $('aboutItem').addEventListener('click', () => { closeMenu(); openModal('aboutModal'); });

  function openModal(id) { $(id).hidden = false; }
  function closeModal(id) { $(id).hidden = true; }
  $('closeAbout').addEventListener('click', () => closeModal('aboutModal'));
  $('closeSettings').addEventListener('click', () => closeModal('settingsModal'));
  ['aboutModal', 'settingsModal'].forEach((id) => {
    $(id).addEventListener('click', (e) => { if (e.target.id === id) closeModal(id); });
  });

  const fsBtn = $('fullscreenBtn');
  if (!document.fullscreenEnabled) fsBtn.hidden = true;
  fsBtn.addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  });

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------
  const settings = {
    trimMode: store.get('trimMode', 'auto'),
    undoSteps: store.get('undoSteps', 10),
  };
  const THRESH = isCoarse ? { bytes: 150 * 1024 * 1024, secs: 180 } : { bytes: 1024 * 1024 * 1024, secs: 900 };
  $('trimModeSel').value = settings.trimMode;
  $('undoStepsInput').value = settings.undoSteps;
  $('trimThresholdHint').textContent = `On this device, "large" means bigger than ${fmtSize(THRESH.bytes)} or longer than ${THRESH.secs / 60} minutes.`;
  $('trimModeSel').addEventListener('change', (e) => { settings.trimMode = e.target.value; store.set('trimMode', settings.trimMode); });
  $('undoStepsInput').addEventListener('change', (e) => {
    settings.undoSteps = clamp(parseInt(e.target.value, 10) || 10, 1, 100);
    e.target.value = settings.undoSteps;
    store.set('undoSteps', settings.undoSteps);
    while (undoStack.length > settings.undoSteps) undoStack.shift();
    updateToolbar();
  });

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  const sources = new Map(); // id -> source
  let clips = [];            // { id, srcId, in, out, muted }
  let selectedId = null;
  let clipboard = null;
  let undoStack = [];
  let redoStack = [];
  let muteAll = false;
  let playhead = 0;
  let playing = false;
  let pps = 60; // timeline pixels per second
  let exporting = false;
  let saveEnabled = false;     // false while a saved project waits to be resumed or discarded
  let pendingProject = null;   // saved project from a previous visit, not opened yet

  const totalDuration = () => clips.reduce((s, c) => s + (c.out - c.in), 0);
  const clipStart = (idx) => { let s = 0; for (let i = 0; i < idx; i++) s += clips[i].out - clips[i].in; return s; };
  const srcOf = (clip) => (clip && clip.srcId ? sources.get(clip.srcId) : null);

  function clipAt(t) {
    let s = 0;
    for (let i = 0; i < clips.length; i++) {
      const len = clips[i].out - clips[i].in;
      if (t < s + len - 1e-6 || i === clips.length - 1) return { idx: i, offset: clamp(t - s, 0, len), start: s };
      s += len;
    }
    return { idx: -1, offset: 0, start: 0 };
  }

  // The project is saved automatically; only warn if leaving would lose work.
  window.addEventListener('beforeunload', (e) => {
    const unsaved = exporting || [...sources.values()].some((s) => s.storage === 'none');
    if (clips.length && unsaved) { e.preventDefault(); e.returnValue = ''; }
  });

  // ---------------------------------------------------------------------------
  // Screens
  // ---------------------------------------------------------------------------
  function showStart() {
    pause();
    $('startScreen').hidden = false;
    $('editorScreen').hidden = true;
    updateResumeCard();
    document.body.classList.remove('editing');
  }
  function showEditor() {
    $('startScreen').hidden = true;
    $('editorScreen').hidden = false;
    document.body.classList.add('editing');
    requestAnimationFrame(() => { renderTimeline(); seek(playhead); });
  }
  const brand = $('brand');
  brand.addEventListener('click', showStart);
  brand.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showStart(); } });

  if (!Render.hasWebCodecs()) {
    const n = $('noSupport');
    n.hidden = false;
    n.textContent = 'This browser doesn\'t support WebCodecs, which Videcutto needs to process videos. Please use a current version of Chrome, Edge, Safari (17+) or Firefox (130+).';
  }

  // ---------------------------------------------------------------------------
  // File picking (Videos / Files toggle as in JPG75)
  // ---------------------------------------------------------------------------
  const fileInput = $('fileInput');
  const drop = $('drop');
  const hints = {
    videos: "Gallery picker — fast, but original file names aren't preserved on Android.",
    files: 'File browser — pick "Files"/"My Files" (not Google Photos) to keep original file names.',
  };
  function setSourceMode(mode) {
    $('sourceToggle').querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
    fileInput.accept = mode === 'files' ? '*/*' : 'video/*,image/*';
    $('sourceHint').textContent = hints[mode];
    store.set('sourceMode', mode);
  }
  setSourceMode(store.get('sourceMode', 'videos'));
  // The Gallery/Files distinction only matters for the Android pickers.
  if (!isCoarse) {
    $('sourceToggle').hidden = true;
    $('sourceHint').hidden = true;
    $('dropTitle').textContent = 'Click to choose videos or images';
    $('dropSub').textContent = 'or drag & drop or paste (Ctrl+V) them here';
  }
  $('sourceToggle').addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (btn) setSourceMode(btn.dataset.mode);
  });
  // Desktop Chrome/Edge: the file picker returns handles, so the original files
  // can be reopened after a reload without copying them.
  const useHandlePicker = () => !isCoarse && Project.canUseHandles();
  const PICKER_TYPES = [{
    description: 'Videos and images',
    accept: { 'video/*': ['.mp4', '.mov', '.m4v', '.3gp'], 'image/*': ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif', '.heic'] },
  }];

  /** @returns {Promise<{file: File, handle?: FileSystemFileHandle}[]>} */
  async function pickFiles(multiple) {
    if (useHandlePicker()) {
      try {
        const hs = await window.showOpenFilePicker({ multiple, types: PICKER_TYPES });
        return Promise.all(hs.map(async (h) => ({ file: await h.getFile(), handle: h })));
      } catch (e) {
        if (e && e.name === 'AbortError') return [];
        // Other errors (e.g. blocked in an iframe): fall back to the input element.
      }
    }
    return new Promise((resolve) => {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = fileInput.accept;
      inp.multiple = multiple;
      inp.addEventListener('change', () => resolve([...inp.files].map((file) => ({ file }))));
      inp.addEventListener('cancel', () => resolve([]));
      inp.click();
    });
  }

  async function fromDataTransfer(dt) {
    // Handles must be requested synchronously inside the drop event.
    const items = [...(dt.items || [])].filter((it) => it.kind === 'file');
    const handlePromises = items.map((it) => (it.getAsFileSystemHandle ? it.getAsFileSystemHandle().catch(() => null) : Promise.resolve(null)));
    const files = [...dt.files];
    const handles = await Promise.all(handlePromises);
    return files.map((file, i) => ({ file, handle: handles[i] && handles[i].kind === 'file' ? handles[i] : null }));
  }

  const pickAndAdd = async () => { const list = await pickFiles(true); if (list.length) handleFiles(list); };
  const addMenu = $('addMenu');
  const closeAddMenu = () => { addMenu.style.display = 'none'; };
  document.addEventListener('click', (e) => { if (!e.target.closest('.add-wrap')) closeAddMenu(); });
  drop.addEventListener('click', pickAndAdd);
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickAndAdd(); } });
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('drag'); }));
  drop.addEventListener('drop', async (e) => { e.stopPropagation(); handleFiles(await fromDataTransfer(e.dataTransfer)); });
  $('addBtn').addEventListener('click', () => { addMenu.style.display = addMenu.style.display === 'none' ? 'block' : 'none'; });
  $('addMediaItem').addEventListener('click', () => { closeAddMenu(); pickAndAdd(); });
  $('addColorItem').addEventListener('click', () => { closeAddMenu(); addColorClip(); });

  // Dropping files anywhere in the editor adds them too
  document.addEventListener('dragover', (e) => { if (!$('editorScreen').hidden) e.preventDefault(); });
  document.addEventListener('drop', async (e) => {
    if ($('editorScreen').hidden || !e.dataTransfer.files.length) return;
    e.preventDefault();
    handleFiles(await fromDataTransfer(e.dataTransfer));
  });

  const isVideoFile = (f) => f.type.startsWith('video/') || /\.(mp4|m4v|mov|3gp)$/i.test(f.name);
  const isImageFile = (f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|bmp|avif|heic|heif)$/i.test(f.name);

  let loadingQueue = Promise.resolve();
  function handleFiles(list) {
    const entries = [...list].map((x) => (x instanceof File ? { file: x } : x));
    const media = entries.filter((x) => isVideoFile(x.file) || isImageFile(x.file));
    if (!media.length) { if (entries.length) toast('Please choose videos (MP4, MOV, M4V) or images (JPG, PNG, WebP).'); return; }
    if (media.length < entries.length) toast('Some files were skipped because they are neither videos nor images.');
    if (pendingProject && !clips.length) {
      if (!confirm('Start a new project? Your last project will be discarded.')) return;
      loadingQueue = loadingQueue.then(() => newProject(true));
    }
    loadingQueue = loadingQueue.then(async () => {
      for (const m of media) {
        if (isImageFile(m.file) && !isVideoFile(m.file)) await addImage(m.file, m.handle, m.pasted);
        else await addFile(m.file, m.handle, m.pasted);
      }
    }).catch((e) => { console.error(e); hideBusy(); });
  }

  const nextSrcId = () => 's' + (++uid);

  /**
   * Read a file's structure and check that this browser can work with it.
   * Throws an Error with a user-facing message otherwise.
   */
  async function probe(file) {
    let demux;
    try {
      demux = await MP4.demux(file);
    } catch (e) {
      if (e && e.name === 'NotReadableError') throw e;
      const msg = e.code === 'FRAGMENTED'
        ? `"${file.name}" is a fragmented MP4 (common for screen recordings), which isn't supported yet.`
        : /webm|mkv/i.test(file.name) || /Not an MP4/.test(e.message)
          ? `"${file.name}" isn't an MP4/MOV file. Videcutto currently supports MP4, MOV and M4V.`
          : `"${file.name}" couldn't be read: ${e.message}`;
      throw new Error(msg);
    }
    const v = demux.video;
    if (!(await Render.canDecodeVideo(v))) {
      throw new Error(v.codec === 'hevc'
        ? `"${file.name}" uses HEVC (H.265), which this browser can't decode. Try Chrome, Edge or Safari — or set your camera to "Most compatible" (H.264).`
        : `"${file.name}" uses a video codec (${v.codecString || v.format}) this browser can't decode.`);
    }
    const audioDecodable = demux.audio ? await Render.canDecodeAudio(demux.audio) : false;
    return { demux, audioDecodable };
  }

  const trackBitrate = (t) => {
    if (!t) return 0;
    let bytes = 0;
    for (let i = 0; i < t.samples.count; i++) bytes += t.samples.sizes[i];
    return (bytes * 8) / Math.max(0.1, t.duration - t.start);
  };

  /**
   * Build a source object. `meta` holds the media's identity and times in the
   * ORIGINAL file's time base; `base` is the original time at which `file`
   * starts (non-zero for trimmed working copies).
   */
  function makeSource(meta, file, probed, base) {
    const { demux, audioDecodable } = probed;
    const v = demux.video;
    return {
      id: meta.id,
      kind: 'video',
      name: meta.name,
      origSize: meta.origSize,
      origLastModified: meta.origLastModified,
      file,
      url: URL.createObjectURL(file),
      demux,
      base,
      width: v.width,
      height: v.height,
      rotation: v.rotation,
      frameRate: v.frameRate || 30,
      fileDuration: v.duration,
      start: meta.start,
      duration: meta.duration,
      hasAudio: !!demux.audio,
      audioDecodable,
      videoBitrate: trackBitrate(v),
      audioBitrate: trackBitrate(demux.audio),
      rangeIn: meta.rangeIn,
      rangeOut: meta.rangeOut,
      storage: meta.storage || 'none',
      copyName: meta.copyName || null,
      thumbs: [],
      thumbStep: 1,
      missing: false,
    };
  }

  function mediaMeta(src) {
    return {
      id: src.id, kind: src.kind, name: src.name, origSize: src.origSize, origLastModified: src.origLastModified,
      base: src.base, start: src.start, duration: src.duration, rangeIn: src.rangeIn, rangeOut: src.rangeOut,
      width: src.width, height: src.height, rotation: src.rotation, storage: src.storage, copyName: src.copyName,
    };
  }

  // Busy overlay with progress
  function showBusy(title, text) {
    $('busyTitle').textContent = title;
    $('busyText').textContent = text || '';
    $('busyFill').style.width = '0%';
    $('busyModal').hidden = false;
  }
  const busyProgress = (f) => { $('busyFill').style.width = (clamp(f, 0, 1) * 100).toFixed(1) + '%'; };
  const hideBusy = () => { $('busyModal').hidden = true; };

  let copyCounter = 0;
  /**
   * Phones: store a working copy in the browser's private storage, so the
   * video stays readable after Android revokes the picker's permission and
   * after a reload. Only the pre-trimmed part is copied (losslessly).
   * Replaces src.file/demux/base on success. Returns true if a copy was made.
   */
  async function makeWorkingCopy(src, force) {
    if ((!isCoarse && !force) || !Project.canCopy()) return false;
    const full = src.rangeIn <= src.start + 0.05 && src.rangeOut >= src.duration - 0.05;
    const estimate = full ? src.file.size : ((src.rangeOut - src.rangeIn) / Math.max(0.1, src.fileDuration)) * src.file.size;
    if ((await Project.freeSpace()) < estimate * 1.2 + 50 * 1024 * 1024) {
      toast('Not enough free storage for a working copy — you may have to select this video again after a reload.', 6000);
      return false;
    }
    const name = `${src.id}-${Date.now().toString(36)}-${++copyCounter}.mp4`;
    showBusy('Preparing video…', `Saving a working copy of "${src.name}" on this device, so it stays available.`);
    try {
      let base = src.base;
      const copy = full
        ? await Project.copyWhole(name, src.file, busyProgress)
        : await Project.writeCopy(name, async (write) => {
          const r = await MP4.remuxRange(src.demux, src.rangeIn - src.base, src.rangeOut - src.base, write, busyProgress);
          base = src.base + r.base;
        });
      const probed = await probe(copy);
      const prevUrl = src.url;
      Object.assign(src, makeSource(mediaMeta(src), copy, probed, base), { thumbs: src.thumbs, thumbStep: src.thumbStep, thumbAspect: src.thumbAspect });
      src.storage = 'opfs';
      src.copyName = name;
      URL.revokeObjectURL(prevUrl);
      Project.requestPersist();
      return true;
    } catch (e) {
      console.error(e);
      await Project.removeCopy(name);
      toast('Couldn\'t save a working copy — you may have to select this video again after a reload.', 6000);
      return false;
    } finally {
      hideBusy();
    }
  }

  async function addFile(file, handle, pasted) {
    if (!Render.hasWebCodecs()) { toast('This browser can\'t process videos (no WebCodecs support).', 5000); return; }
    let probed;
    try { probed = await probe(file); } catch (e) { toast(e.message, 7000); return; }
    const v = probed.demux.video;
    const start = Math.max(0, v.start);
    const meta = {
      id: nextSrcId(), name: file.name, origSize: file.size, origLastModified: file.lastModified,
      start, duration: v.duration, rangeIn: start, rangeOut: v.duration,
    };
    const src = makeSource(meta, file, probed, 0);
    if (src.hasAudio && !src.audioDecodable) toast(`The sound of "${file.name}" (${probed.demux.audio.codecString || probed.demux.audio.format}) can't be decoded here — it will be silent in the export.`, 6000);

    const big = file.size > THRESH.bytes || v.duration > THRESH.secs;
    const offer = settings.trimMode === 'always' || (settings.trimMode === 'auto' && big);
    if (offer) {
      const range = await openTrim(src, big);
      if (!range) { URL.revokeObjectURL(src.url); return; }
      src.rangeIn = range.in;
      src.rangeOut = range.out;
    }

    // Pasted files have no handle, so keep a copy on desktop too.
    if (!(await makeWorkingCopy(src, pasted)) && handle) {
      src.storage = 'handle';
      await Project.saveHandle(src.id, handle);
    }

    const wasEmpty = clips.length === 0;
    sources.set(src.id, src);
    saveEnabled = true;
    // A new project starting with a video takes that video's format.
    if (wasEmpty) {
      canvasState = Object.assign(defaultCanvas(), { aspect: 'video', videoSrcId: src.id });
      // Full HD by default, but don't upscale smaller videos.
      const d = Render.displaySize(src);
      exportState.res = Math.min(d.w, d.h) >= 1080 ? '1080' : 'source';
    }
    commit(() => {
      clips.push({ id: newId(), kind: 'video', srcId: src.id, in: src.rangeIn, out: src.rangeOut, muted: false });
    });
    if (wasEmpty) { playhead = 0; onCanvasChange(); }
    showEditor();
    queueThumbs(src);
  }

  // ---------------------------------------------------------------------------
  // Images and colour clips
  // ---------------------------------------------------------------------------
  const STILL_DURATION = 4;

  async function decodeImage(file) {
    let bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const MAX = 4096; // plenty for UHD output, keeps memory in check with big photos
    const long = Math.max(bmp.width, bmp.height);
    if (long > MAX) {
      const f = MAX / long;
      const small = await createImageBitmap(bmp, { resizeWidth: Math.round(bmp.width * f), resizeHeight: Math.round(bmp.height * f), resizeQuality: 'high' });
      bmp.close();
      bmp = small;
    }
    return bmp;
  }

  function makeImageSource(meta, file, bitmap) {
    return {
      id: meta.id, kind: 'image', name: meta.name, origSize: meta.origSize, origLastModified: meta.origLastModified,
      file, url: null, bitmap, demux: null, base: 0, width: bitmap.width, height: bitmap.height, rotation: 0, frameRate: 30,
      fileDuration: 0, start: 0, duration: 0, hasAudio: false, audioDecodable: false, videoBitrate: 0, audioBitrate: 0,
      rangeIn: 0, rangeOut: 0, storage: meta.storage || 'none', copyName: meta.copyName || null, thumbs: [], thumbStep: Infinity, missing: false,
    };
  }

  async function addImage(file, handle, pasted) {
    let bmp;
    try { bmp = await decodeImage(file); } catch (e) { toast(`"${file.name}" couldn't be opened as an image in this browser.`, 6000); return; }
    const meta = { id: nextSrcId(), name: file.name || 'Pasted image', origSize: file.size, origLastModified: file.lastModified };
    const src = makeImageSource(meta, file, bmp);
    // Images are small: always keep a copy so they survive reloads.
    if (Project.canCopy()) {
      const name = `${src.id}-${Date.now().toString(36)}-${++copyCounter}${(/\.[a-z0-9]+$/i.exec(file.name || '') || ['.img'])[0]}`;
      try { src.file = await Project.copyWhole(name, file); src.storage = 'opfs'; src.copyName = name; Project.requestPersist(); } catch (e) { /* keep original */ }
    }
    if (src.storage === 'none' && handle) { src.storage = 'handle'; await Project.saveHandle(src.id, handle); }
    if (pasted && src.storage === 'none') toast('This pasted image can\'t be stored here — it will be missing after a reload.', 5000);
    const wasEmpty = clips.length === 0;
    sources.set(src.id, src);
    saveEnabled = true;
    commit(() => { clips.push({ id: newId(), kind: 'image', srcId: src.id, in: 0, out: STILL_DURATION, muted: false }); });
    if (wasEmpty) { playhead = 0; onCanvasChange(); }
    showEditor();
    queueThumbs(src);
  }

  function addColorClip() {
    const wasEmpty = clips.length === 0;
    saveEnabled = true;
    let insertAt = clips.length;
    commit(() => {
      const nc = { id: newId(), kind: 'color', srcId: null, in: 0, out: STILL_DURATION, muted: false, color: DEFAULT_COLOR, size: '1920x1080', w: 1920, h: 1080 };
      clips.splice(insertAt, 0, nc);
      selectedId = nc.id;
    });
    if (wasEmpty) playhead = 0;
    showEditor();
  }

  async function startEmptyCanvas() {
    if ((clips.length || pendingProject) && !(await newProject(false))) return;
    canvasState = defaultCanvas();
    exportState.res = '1080';
    saveEnabled = true;
    commit(() => { clips.push({ id: newId(), kind: 'color', srcId: null, in: 0, out: STILL_DURATION, muted: false, color: DEFAULT_COLOR, size: '1920x1080', w: 1920, h: 1080 }); });
    undoStack = [];
    playhead = 0;
    showEditor();
    onCanvasChange();
  }
  $('emptyCanvasBtn').addEventListener('click', startEmptyCanvas);

  // ---------------------------------------------------------------------------
  // Thumbnails
  // ---------------------------------------------------------------------------
  let thumbQueue = Promise.resolve();
  function queueThumbs(src) { thumbQueue = thumbQueue.then(() => makeThumbs(src)).catch(() => {}); }

  async function makeThumbs(src) {
    if (src.kind === 'image') {
      if (!src.bitmap) return;
      const th = 72, tw = Math.round(clamp(th * src.width / src.height, 40, 128));
      const c = document.createElement('canvas');
      c.width = tw; c.height = th;
      const x = c.getContext('2d');
      const sc = Math.max(tw / src.width, th / src.height);
      x.drawImage(src.bitmap, (tw - src.width * sc) / 2, (th - src.height * sc) / 2, src.width * sc, src.height * sc);
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.7));
      if (blob) src.thumbs = [URL.createObjectURL(blob)];
      src.thumbAspect = tw / th;
      src.thumbStep = Infinity;
      renderClips();
      return;
    }
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    v.src = src.url;
    if (!(await once(v, 'loadeddata', 8000))) return;
    const len = src.rangeOut - src.rangeIn;
    const count = clamp(Math.ceil(len / 1.5), 1, 48);
    src.thumbStep = len / count;
    const aspect = v.videoWidth / v.videoHeight || 16 / 9;
    const th = 72, tw = Math.round(clamp(th * aspect, 40, 128));
    const canvas = document.createElement('canvas');
    canvas.width = tw; canvas.height = th;
    const ctx = canvas.getContext('2d');
    let lastRender = 0;
    for (let k = 0; k < count; k++) {
      const t = src.rangeIn + (k + 0.5) * src.thumbStep - src.base;
      v.currentTime = clamp(t, 0, src.fileDuration - 0.05);
      if (!(await once(v, 'seeked', 4000))) continue;
      const scale = Math.max(tw / v.videoWidth, th / v.videoHeight);
      ctx.drawImage(v, (tw - v.videoWidth * scale) / 2, (th - v.videoHeight * scale) / 2, v.videoWidth * scale, v.videoHeight * scale);
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.6));
      if (blob) src.thumbs[k] = URL.createObjectURL(blob);
      if (performance.now() - lastRender > 400 || k === count - 1) { lastRender = performance.now(); renderClips(); }
    }
    src.thumbAspect = tw / th;
    v.removeAttribute('src'); v.load();
    renderClips();
  }

  // ---------------------------------------------------------------------------
  // Pre-trim dialog
  // ---------------------------------------------------------------------------
  function openTrim(src, big) {
    return new Promise((resolve) => {
      const modal = $('trimModal');
      const video = $('trimVideo');
      const range = $('trimRange');
      const hS = $('trimStartH'), hE = $('trimEndH'), sel = $('trimSel'), pos = $('trimPos');
      const min = src.start, max = src.duration, full = max - min;
      let tIn = min, tOut = max;
      let raf = 0;

      $('trimInfo').textContent = `${src.name} · ${fmtSize(src.file.size)} · ${fmtTime(full, false)}. ` +
        (big ? 'This is a large video — pick just the part you need to keep editing and exporting fast.' : 'Pick the part you want to keep.');
      video.src = src.url;
      video.currentTime = min;
      const ds = Render.displaySize(src);
      video.parentElement.style.aspectRatio = `${ds.w} / ${ds.h}`;
      modal.hidden = false;

      const pct = (t) => ((t - min) / full) * 100;
      const update = () => {
        hS.style.left = pct(tIn) + '%';
        hE.style.left = pct(tOut) + '%';
        sel.style.left = pct(tIn) + '%';
        sel.style.width = (pct(tOut) - pct(tIn)) + '%';
        pos.style.left = pct(clamp(video.currentTime, min, max)) + '%';
        hS.setAttribute('aria-valuetext', fmtTime(tIn));
        hE.setAttribute('aria-valuetext', fmtTime(tOut));
        const est = ((tOut - tIn) / full) * src.file.size;
        $('trimLen').innerHTML = `<strong>${fmtTime(tOut - tIn, false)}</strong><br>${fmtTime(tIn, false)} – ${fmtTime(tOut, false)} · ~${fmtSize(est)}`;
      };
      update();

      const seekTo = (t) => {
        if (video.fastSeek && Math.abs(video.currentTime - t) > 2) video.fastSeek(t); else video.currentTime = t;
      };
      const timeFromX = (clientX) => {
        const r = range.getBoundingClientRect();
        return min + clamp((clientX - r.left) / r.width, 0, 1) * full;
      };
      const MIN_LEN = 0.3;
      const dragHandle = (handle, isStart) => (e) => {
        e.preventDefault();
        e.stopPropagation();
        handle.setPointerCapture(e.pointerId);
        stop();
        const move = (ev) => {
          const t = timeFromX(ev.clientX);
          if (isStart) tIn = clamp(t, min, tOut - MIN_LEN); else tOut = clamp(t, tIn + MIN_LEN, max);
          seekTo(isStart ? tIn : tOut);
          update();
        };
        const up = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', up); };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
        handle.addEventListener('pointercancel', up);
      };
      const onStartDown = dragHandle(hS, true);
      const onEndDown = dragHandle(hE, false);
      const onRangeDown = (e) => { stop(); seekTo(timeFromX(e.clientX)); update(); };
      const onKey = (isStart) => (e) => {
        const step = e.shiftKey ? 10 : 1;
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        const d = e.key === 'ArrowLeft' ? -step : step;
        if (isStart) { tIn = clamp(tIn + d, min, tOut - MIN_LEN); seekTo(tIn); } else { tOut = clamp(tOut + d, tIn + MIN_LEN, max); seekTo(tOut); }
        update();
      };
      const keyS = onKey(true), keyE = onKey(false);

      const loop = () => {
        if (video.currentTime >= tOut) { video.pause(); video.currentTime = tOut; }
        update();
        if (!video.paused) raf = requestAnimationFrame(loop);
      };
      const stop = () => { video.pause(); cancelAnimationFrame(raf); };
      const onPlay = () => {
        if (!video.paused) { stop(); return; }
        if (video.currentTime < tIn || video.currentTime >= tOut - 0.05) video.currentTime = tIn;
        video.muted = false;
        video.play().then(() => { raf = requestAnimationFrame(loop); }).catch(() => {});
      };
      const onSeeked = () => update();
      const setStart = () => { tIn = clamp(video.currentTime, min, tOut - MIN_LEN); update(); };
      const setEnd = () => { tOut = clamp(video.currentTime, tIn + MIN_LEN, max); update(); };

      hS.addEventListener('pointerdown', onStartDown);
      hE.addEventListener('pointerdown', onEndDown);
      range.addEventListener('pointerdown', onRangeDown);
      hS.addEventListener('keydown', keyS);
      hE.addEventListener('keydown', keyE);
      video.addEventListener('seeked', onSeeked);
      $('trimPlayBtn').addEventListener('click', onPlay);
      $('setStartBtn').addEventListener('click', setStart);
      $('setEndBtn').addEventListener('click', setEnd);

      const finish = (result) => {
        stop();
        hS.removeEventListener('pointerdown', onStartDown);
        hE.removeEventListener('pointerdown', onEndDown);
        range.removeEventListener('pointerdown', onRangeDown);
        hS.removeEventListener('keydown', keyS);
        hE.removeEventListener('keydown', keyE);
        video.removeEventListener('seeked', onSeeked);
        $('trimPlayBtn').removeEventListener('click', onPlay);
        $('setStartBtn').removeEventListener('click', setStart);
        $('setEndBtn').removeEventListener('click', setEnd);
        $('trimSkipBtn').onclick = $('trimApplyBtn').onclick = $('trimCancelBtn').onclick = null;
        video.removeAttribute('src'); video.load();
        modal.hidden = true;
        resolve(result);
      };
      $('trimSkipBtn').onclick = () => finish({ in: min, out: max });
      $('trimApplyBtn').onclick = () => finish({ in: tIn, out: tOut });
      $('trimCancelBtn').onclick = () => finish(null);
    });
  }

  // ---------------------------------------------------------------------------
  // Undo / redo
  // ---------------------------------------------------------------------------
  const snapshot = () => clips.map((c) => ({ ...c }));
  function commit(fn) {
    const before = snapshot();
    fn();
    undoStack.push(before);
    while (undoStack.length > settings.undoSteps) undoStack.shift();
    redoStack = [];
    afterEdit();
  }
  function undo() {
    if (!undoStack.length) return;
    redoStack.push(snapshot());
    clips = undoStack.pop();
    afterEdit();
  }
  function redo() {
    if (!redoStack.length) return;
    undoStack.push(snapshot());
    clips = redoStack.pop();
    afterEdit();
  }
  function afterEdit() {
    if (selectedId && !clips.some((c) => c.id === selectedId)) selectedId = null;
    playhead = clamp(playhead, 0, totalDuration());
    renderTimeline();
    seek(playhead);
    updateEstimate();
    scheduleSave();
  }

  // ---------------------------------------------------------------------------
  // Editing operations
  // ---------------------------------------------------------------------------
  const EDGE = 0.05;
  function selectedIndex() { return clips.findIndex((c) => c.id === selectedId); }

  function splitAtPlayhead() {
    const { idx, offset } = clipAt(playhead);
    if (idx < 0) return;
    const c = clips[idx];
    if (offset < EDGE || offset > c.out - c.in - EDGE) { toast('Move the playhead inside a clip to split it.'); return; }
    commit(() => {
      const left = { ...c, id: newId(), out: c.in + offset };
      const right = { ...c, id: newId(), in: c.in + offset };
      clips.splice(idx, 1, left, right);
      selectedId = right.id;
    });
  }
  function deleteSelected() {
    const i = selectedIndex();
    if (i < 0) { toast('Select a clip first.'); return; }
    commit(() => { clips.splice(i, 1); selectedId = null; });
  }
  function copySelected(silent) {
    const i = selectedIndex();
    if (i < 0) { toast('Select a clip first.'); return false; }
    const c = clips[i];
    const { id, ...rest } = c;
    clipboard = { ...rest };
    if (!silent) toast('Clip copied — move the playhead and paste.');
    updateToolbar();
    return true;
  }
  function paste() {
    if (!clipboard) return;
    let insertAt = clips.length;
    let insertTime = totalDuration();
    commit(() => {
      if (clips.length && playhead < totalDuration() - EDGE) {
        const { idx, offset, start } = clipAt(playhead);
        const c = clips[idx];
        const len = c.out - c.in;
        if (offset <= EDGE) { insertAt = idx; insertTime = start; } else if (offset >= len - EDGE) { insertAt = idx + 1; insertTime = start + len; } else {
          const left = { ...c, id: newId(), out: c.in + offset };
          const right = { ...c, id: newId(), in: c.in + offset };
          clips.splice(idx, 1, left, right);
          insertAt = idx + 1; insertTime = start + offset;
        }
      }
      const nc = { id: newId(), ...clipboard };
      clips.splice(insertAt, 0, nc);
      selectedId = nc.id;
    });
    playhead = insertTime;
    seek(playhead);
  }
  function toggleMuteClip() {
    let i = selectedIndex();
    if (i < 0) i = clipAt(playhead).idx;
    if (i < 0 || !isVideoClip(clips[i])) return;
    commit(() => { clips[i] = { ...clips[i], muted: !clips[i].muted }; });
  }
  function updateSelected(patch) {
    const i = selectedIndex();
    if (i < 0) return;
    commit(() => { clips[i] = { ...clips[i], ...patch }; });
  }
  function toggleMuteAll() {
    muteAll = !muteAll;
    $('muteAllBtn').setAttribute('aria-pressed', String(muteAll));
    $('muteAllBtn').title = muteAll ? 'Unmute all audio' : 'Mute all audio';
    applyMute();
    updateEstimate();
    scheduleSave();
  }

  $('undoBtn').addEventListener('click', () => { if (undoStack.length) undo(); else toast('Nothing to undo.', 1500); });
  $('redoBtn').addEventListener('click', () => { if (redoStack.length) redo(); else toast('Nothing to redo.', 1500); });
  $('splitBtn').addEventListener('click', splitAtPlayhead);
  $('deleteBtn').addEventListener('click', deleteSelected);
  $('copyBtn').addEventListener('click', () => copySelected(false));
  $('cpClose').addEventListener('click', () => { selectedId = null; renderClips(); updateToolbar(); });

  // Clip panel fields
  $('cpDuration').addEventListener('change', (e) => {
    const c = clips[selectedIndex()];
    if (!c || c.kind === 'video') return;
    const d = clamp(parseFloat(e.target.value) || STILL_DURATION, 0.1, 3600);
    updateSelected({ out: c.in + d });
  });
  $('cpColor').addEventListener('input', (e) => {
    // Live preview without creating an undo step for every colour tick.
    const c = clips[selectedIndex()];
    if (c && c.kind === 'color') { c.color = e.target.value; renderPreview(); renderClips(); }
  });
  // The colour picker previews live; the undo step is recorded once on 'change'.
  let clipColorBefore = null;
  const rememberColor = () => { const c = clips[selectedIndex()]; clipColorBefore = c ? c.color : null; };
  $('cpColor').addEventListener('focus', rememberColor);
  $('cpColor').addEventListener('click', rememberColor);
  $('cpColor').addEventListener('change', (e) => {
    const c = clips[selectedIndex()];
    if (!c || c.kind !== 'color') return;
    if (clipColorBefore) c.color = clipColorBefore; // so the undo snapshot holds the old colour
    clipColorBefore = null;
    updateSelected({ color: e.target.value });
  });
  $('cpSize').addEventListener('change', (e) => {
    const v = e.target.value;
    const c = clips[selectedIndex()];
    if (!c || c.kind !== 'color') return;
    if (v === 'canvas') updateSelected({ size: 'canvas' });
    else if (v === 'custom') updateSelected({ size: 'custom' });
    else { const [w, h] = v.split('x').map(Number); updateSelected({ size: v, w, h }); }
  });
  ['cpW', 'cpH'].forEach((id) => $(id).addEventListener('change', () => {
    const w = Math.round(clamp(parseInt($('cpW').value, 10) || 1920, 16, 8192));
    const h = Math.round(clamp(parseInt($('cpH').value, 10) || 1080, 16, 8192));
    updateSelected({ size: 'custom', w, h });
  }));

  function updateClipPanel() {
    const i = selectedIndex();
    const panel = $('clipPanel');
    if (i < 0) { panel.hidden = true; return; }
    const c = clips[i];
    const src = srcOf(c);
    panel.hidden = false;
    $('cpKind').textContent = c.kind === 'video' ? 'Video' : c.kind === 'image' ? 'Image' : 'Color clip';
    $('cpTitle').textContent = src ? src.name : `${(c.color || DEFAULT_COLOR).toUpperCase()} · ${c.size === 'canvas' ? 'canvas size' : `${c.w}×${c.h}`}`;
    $('muteClipBtn').hidden = c.kind !== 'video';
    $('muteClipBtn').classList.toggle('on', !!c.muted);
    $('muteClipBtn').querySelector('span').textContent = c.muted ? 'Unmute' : 'Mute';
    $('cpDurField').hidden = c.kind === 'video';
    if (document.activeElement !== $('cpDuration')) $('cpDuration').value = +(c.out - c.in).toFixed(2);
    $('cpColorField').hidden = c.kind !== 'color';
    $('cpSizeField').hidden = c.kind !== 'color';
    $('cpCustomField').hidden = !(c.kind === 'color' && c.size === 'custom');
    if (c.kind === 'color') {
      $('cpColor').value = c.color || DEFAULT_COLOR;
      $('cpSize').value = c.size || 'custom';
      $('cpW').value = c.w || 1920;
      $('cpH').value = c.h || 1080;
    }
  }
  $('pasteBtn').addEventListener('click', paste);
  $('muteClipBtn').addEventListener('click', toggleMuteClip);
  $('muteAllBtn').addEventListener('click', toggleMuteAll);

  function updateToolbar() {
    // Undo/redo stay clickable; they just look dimmed when there's nothing to do.
    $('undoBtn').classList.toggle('idle', !undoStack.length);
    $('redoBtn').classList.toggle('idle', !redoStack.length);
    $('splitBtn').disabled = !clips.length;
    $('pasteBtn').disabled = !clipboard;
    $('exportBtn').disabled = !clips.length || exporting;
    updateClipPanel();
  }

  // ---------------------------------------------------------------------------
  // Timeline rendering
  // ---------------------------------------------------------------------------
  const timeline = $('timeline');
  const tlInner = $('tlInner');
  const tlRuler = $('tlRuler');
  const tlTrack = $('tlTrack');
  const MAX_WIDTH = 80000;

  const pad = () => timeline.clientWidth / 2;
  function clampPps(v) {
    const total = Math.max(0.5, totalDuration());
    return clamp(v, Math.max(2, (timeline.clientWidth * 0.5) / total), Math.min(600, MAX_WIDTH / total));
  }
  let ppsUserSet = false;

  function renderTimeline() {
    if ($('editorScreen').hidden) return;
    const total = totalDuration();
    if (!ppsUserSet && total > 0) pps = clamp(timeline.clientWidth / total, 4, 160);
    pps = clampPps(pps);
    const p = pad();
    tlInner.style.width = (p * 2 + total * pps) + 'px';

    // Ruler
    const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800];
    const step = steps.find((s) => s * pps >= 64) || 3600;
    const frag = document.createDocumentFragment();
    for (let t = 0; t <= total + 1e-6; t += step) {
      const d = document.createElement('div');
      d.className = 'tick';
      d.style.left = (p + t * pps) + 'px';
      d.textContent = step < 1 ? fmtTime(t).replace(/0$/, '') : fmtTime(t, false);
      frag.appendChild(d);
      for (let k = 1; k < 4; k++) {
        const mt = t + (step * k) / 4;
        if (mt > total) break;
        const m = document.createElement('div');
        m.className = 'tick minor';
        m.style.left = (p + mt * pps) + 'px';
        frag.appendChild(m);
      }
    }
    tlRuler.replaceChildren(frag);
    renderClips();
    syncScroll();
    updateToolbar();
    updateTime();
    updatePreviewAspect();
    $('stutterHint').hidden = clips.filter(isVideoClip).length < 2;
    $('previewEmpty').hidden = clips.length > 0;
  }

  const MUTE_SVG = '<svg viewBox="0 0 24 24"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/></svg>';

  function renderClips() {
    if ($('editorScreen').hidden) return;
    const p = pad();
    const frag = document.createDocumentFragment();
    let t = 0;
    clips.forEach((c, i) => {
      const len = c.out - c.in;
      const src = srcOf(c);
      const el = document.createElement('div');
      el.className = 'clip' + (c.id === selectedId ? ' selected' : '') + (c.kind === 'color' ? ' color-clip' : '');
      if (c.kind === 'color') el.style.background = c.color || DEFAULT_COLOR;
      el.dataset.id = c.id;
      el.dataset.idx = i;
      const w = Math.max(3, len * pps - 2);
      el.style.left = (p + t * pps + 1) + 'px';
      el.style.width = w + 'px';
      if (src && src.thumbs.length) {
        const tw = Math.round(60 * (src.thumbAspect || 16 / 9));
        const n = Math.min(400, Math.ceil(w / tw));
        for (let k = 0; k < n; k++) {
          const time = c.in + ((k + 0.5) * tw) / pps;
          const ti = clamp(Math.floor((time - src.rangeIn) / src.thumbStep), 0, src.thumbs.length - 1);
          const url = src.thumbs[ti] || src.thumbs.find(Boolean);
          if (!url) break;
          const img = document.createElement('img');
          img.src = url;
          img.alt = '';
          img.style.width = tw + 'px';
          el.appendChild(img);
        }
      }
      if (w > 50) {
        const label = document.createElement('span');
        label.className = 'clip-label';
        const nm = src ? src.name : c.kind === 'color' ? 'Color' : '';
        label.textContent = `${fmtTime(len, false)}${w > 140 && nm ? ' · ' + nm : ''}`;
        el.appendChild(label);
      }
      if (c.muted) {
        const m = document.createElement('span');
        m.className = 'clip-muted';
        m.innerHTML = MUTE_SVG;
        el.appendChild(m);
      }
      frag.appendChild(el);
      t += len;
    });
    tlTrack.replaceChildren(frag);
  }

  // Keep scroll position and playhead in sync (playhead fixed at the centre).
  let expectedScroll = -1;
  function syncScroll() {
    const target = Math.round(playhead * pps);
    expectedScroll = target;
    timeline.scrollLeft = target;
  }
  let scrollRaf = 0;
  timeline.addEventListener('scroll', () => {
    if (drag) return;
    if (Math.abs(timeline.scrollLeft - expectedScroll) <= 1) return;
    expectedScroll = -1;
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      if (playing) pause();
      const t = clamp(timeline.scrollLeft / pps, 0, totalDuration());
      seek(t, true);
    });
  }, { passive: true });

  function setZoom(newPps) {
    ppsUserSet = true;
    pps = clampPps(newPps);
    renderTimeline();
  }
  $('zoomInBtn').addEventListener('click', () => setZoom(pps * 1.6));
  $('zoomOutBtn').addEventListener('click', () => setZoom(pps / 1.6));
  timeline.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    setZoom(pps * Math.exp(-e.deltaY * 0.01));
  }, { passive: false });

  // Pinch zoom (touch events so we can stop the browser from zooming the page)
  let pinch = null;
  const touchDist = (e) => Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
  timeline.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) pinch = { d: touchDist(e), pps };
  }, { passive: true });
  timeline.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2 && pinch) {
      e.preventDefault();
      setZoom(pinch.pps * (touchDist(e) / pinch.d));
    }
  }, { passive: false });
  timeline.addEventListener('touchend', (e) => { if (e.touches.length < 2) pinch = null; });

  let resizeTimer = 0;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(renderTimeline, 120); });

  // ---------------------------------------------------------------------------
  // Clip selection and drag & drop reordering
  // ---------------------------------------------------------------------------
  let drag = null;
  let suppressClick = false;

  tlTrack.addEventListener('click', (e) => {
    if (suppressClick) { suppressClick = false; return; }
    const el = e.target.closest('.clip');
    selectedId = el ? (selectedId === el.dataset.id ? null : el.dataset.id) : null;
    renderClips();
    updateToolbar();
  });

  tlTrack.addEventListener('pointerdown', (e) => {
    const el = e.target.closest('.clip');
    if (!el || e.button > 0) return;
    // Touch: only the selected clip can be dragged (others scroll the timeline).
    if (e.pointerType !== 'mouse' && el.dataset.id !== selectedId) return;
    drag = { el, id: el.dataset.id, startX: e.clientX, pointerId: e.pointerId, active: false, dropIdx: -1, marker: null, raf: 0, lastX: e.clientX };
  });

  window.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const dx = e.clientX - drag.startX;
    if (!drag.active) {
      if (Math.abs(dx) < 6) return;
      drag.active = true;
      if (selectedId !== drag.id) { selectedId = drag.id; renderClips(); drag.el = tlTrack.querySelector(`.clip[data-id="${drag.id}"]`); }
      drag.el.classList.add('dragging');
      try { drag.el.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      drag.origLeft = parseFloat(drag.el.style.left);
      drag.scroll0 = timeline.scrollLeft;
      drag.marker = document.createElement('div');
      drag.marker.className = 'drop-marker';
      tlTrack.appendChild(drag.marker);
      autoScroll();
    }
    drag.lastX = e.clientX;
    positionDrag();
  });

  function positionDrag() {
    const dx = drag.lastX - drag.startX + (timeline.scrollLeft - drag.scroll0);
    drag.el.style.left = (drag.origLeft + dx) + 'px';
    // Determine the drop slot from the pointer's timeline time.
    const rect = timeline.getBoundingClientRect();
    const x = drag.lastX - rect.left + timeline.scrollLeft - pad();
    const time = x / pps;
    const others = clips.filter((c) => c.id !== drag.id);
    let t = 0, idx = 0;
    for (const c of others) {
      const len = c.out - c.in;
      if (time > t + len / 2) idx++;
      t += len;
    }
    drag.dropIdx = idx;
    let boundary = 0;
    for (let i = 0; i < idx; i++) boundary += others[i].out - others[i].in;
    drag.marker.style.left = (pad() + boundary * pps - 1) + 'px';
  }

  function autoScroll() {
    if (!drag || !drag.active) return;
    const rect = timeline.getBoundingClientRect();
    const edge = 40;
    let v = 0;
    if (drag.lastX < rect.left + edge) v = -(rect.left + edge - drag.lastX) / 2;
    else if (drag.lastX > rect.right - edge) v = (drag.lastX - (rect.right - edge)) / 2;
    if (v) { timeline.scrollLeft += v; positionDrag(); }
    drag.raf = requestAnimationFrame(autoScroll);
  }

  function endDrag(e) {
    if (!drag || (e && e.pointerId !== drag.pointerId)) return;
    const d = drag;
    drag = null;
    if (!d.active) return;
    cancelAnimationFrame(d.raf);
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 50);
    const from = clips.findIndex((c) => c.id === d.id);
    if (from >= 0 && d.dropIdx >= 0 && d.dropIdx !== from) {
      commit(() => {
        const [c] = clips.splice(from, 1);
        clips.splice(d.dropIdx, 0, c);
      });
    } else {
      renderTimeline();
    }
  }
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);

  // ---------------------------------------------------------------------------
  // Preview (a canvas draws the composition exactly like the export; two
  // <video> elements underneath supply frames and sound, the next video clip
  // is always preloaded in the element that isn't showing)
  // ---------------------------------------------------------------------------
  const vids = [$('vidA'), $('vidB')];
  const pv = $('pvCanvas');
  const pvCtx = pv.getContext('2d', { alpha: false });
  let showing = null;   // <video> element currently providing frames (null for stills)
  let activeIdx = -1;
  let clock = null;     // stills: { t0, ph0 } — wall clock instead of a video's time
  const unlocked = new WeakSet();

  const isVideoClip = (c) => !!c && c.kind === 'video';
  const playableVideo = (c) => isVideoClip(c) && srcOf(c) && !srcOf(c).missing;

  function setVideoTime(el, t) {
    if (el.readyState >= 1) el.currentTime = t;
    else el.addEventListener('loadedmetadata', () => { el.currentTime = t; }, { once: true });
  }
  // t is in media time; the element plays the actual file (which may be a trimmed copy).
  function loadInto(el, clip, t) {
    const src = srcOf(clip);
    if (!src || src.missing) return;
    if (el.dataset.src !== src.id || el.dataset.url !== src.url) {
      el.dataset.src = src.id;
      el.dataset.url = src.url;
      el.src = src.url;
    }
    el.dataset.clip = clip.id;
    setVideoTime(el, Math.max(0, t - src.base));
  }
  const mediaTime = (el) => { const s = sources.get(el.dataset.src); return el.currentTime + (s ? s.base : 0); };

  // Element for a video clip: prefer one that already holds the same source.
  function elementFor(clip, avoid) {
    const src = srcOf(clip);
    const cand = vids.filter((v) => v !== avoid);
    return cand.find((v) => v.dataset.clip === clip.id) || cand.find((v) => v.dataset.src === src.id) || cand[0];
  }

  function applyMute() {
    vids.forEach((el) => {
      const clip = clips.find((c) => c.id === el.dataset.clip);
      el.muted = muteAll || !clip || clip.muted || el !== showing;
    });
  }

  function prepareNext() {
    const next = clips[activeIdx + 1];
    if (playableVideo(next)) loadInto(elementFor(next, showing), next, next.in);
  }

  function resetVideos() {
    vids.forEach((v) => { v.pause(); v.removeAttribute('src'); delete v.dataset.src; delete v.dataset.url; delete v.dataset.clip; v.load(); });
  }

  function seek(t, fromScroll) {
    playhead = clamp(t, 0, totalDuration());
    if (!clips.length) {
      resetVideos();
      showing = null;
      activeIdx = -1;
      updateTime();
      renderPreview();
      return;
    }
    const { idx, offset } = clipAt(playhead);
    const clip = clips[idx];
    activeIdx = idx;
    if (playableVideo(clip)) {
      const el = elementFor(clip, null);
      if (showing && showing !== el) showing.pause();
      showing = el;
      loadInto(el, clip, clip.in + offset);
      if (playing) el.play().catch(() => {});
    } else {
      if (showing) showing.pause();
      showing = null;
      clock = { t0: performance.now(), ph0: playhead };
    }
    prepareNext();
    applyMute();
    if (!fromScroll) syncScroll();
    updateTime();
    updateToolbar();
    renderPreview();
  }

  function setPlayIcon() {
    $('playIcon').innerHTML = playing
      ? '<path class="fill" d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/>'
      : '<path class="fill" d="M8 5.5v13l10.5-6.5z"/>';
    $('playBtn').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }

  function unlock(el) {
    // iOS only lets a <video> play with sound if play() was first called in a user gesture.
    if (unlocked.has(el) || !el.getAttribute('src')) return;
    unlocked.add(el);
    const t = el.currentTime;
    el.muted = true;
    el.play().then(() => { if (el !== showing) { el.pause(); el.currentTime = t; } applyMute(); }).catch(() => {});
  }

  function play() {
    if (!clips.length) return;
    if (playhead >= totalDuration() - 0.03) seek(0);
    playing = true;
    setPlayIcon();
    vids.forEach((v) => { if (v !== showing) unlock(v); });
    if (showing) {
      unlocked.add(showing);
      applyMute();
      showing.play().catch((err) => {
        if (err && err.name === 'NotAllowedError') { showing.muted = true; showing.play().catch(() => {}); toast('Sound was blocked by the browser — tap play again for sound.'); }
      });
    } else {
      clock = { t0: performance.now(), ph0: playhead };
    }
    requestAnimationFrame(tick);
  }
  function pause() {
    if (!playing) return;
    playing = false;
    vids.forEach((v) => v.pause());
    setPlayIcon();
  }
  $('playBtn').addEventListener('click', () => (playing ? pause() : play()));

  // Move on to the next clip while playing. Returns false at the end.
  function advance() {
    const nextIdx = activeIdx + 1;
    if (nextIdx >= clips.length) {
      playhead = totalDuration();
      pause();
      syncScroll();
      updateTime();
      return false;
    }
    const next = clips[nextIdx];
    const prev = showing;
    activeIdx = nextIdx;
    if (playableVideo(next)) {
      const el = elementFor(next, prev);
      if (el.dataset.clip !== next.id || Math.abs(mediaTime(el) - next.in) > 0.25) loadInto(el, next, next.in);
      if (prev) prev.pause();
      showing = el;
      applyMute();
      el.play().catch(() => { el.muted = true; el.play().catch(() => {}); });
    } else {
      if (prev) prev.pause();
      showing = null;
      clock = { t0: performance.now(), ph0: clipStart(nextIdx) };
      applyMute();
    }
    prepareNext();
    return true;
  }

  function tick() {
    if (!playing) return;
    const clip = clips[activeIdx];
    if (!clip) { pause(); return; }
    const start = clipStart(activeIdx);
    const len = clip.out - clip.in;
    let done;
    if (showing && isVideoClip(clip)) {
      const t = mediaTime(showing);
      playhead = start + clamp(t - clip.in, 0, len);
      done = t >= clip.out - 0.02 || showing.ended;
    } else {
      playhead = Math.min(start + len, clock.ph0 + (performance.now() - clock.t0) / 1000);
      done = playhead >= start + len - 1e-3;
    }
    if (done && !advance()) { renderPreview(); return; }
    syncScroll();
    updateTime();
    renderPreview();
    requestAnimationFrame(tick);
  }

  function frameStep(dir) {
    if (!clips.length) return;
    pause();
    const src = srcOf(clips[clipAt(playhead).idx]);
    seek(playhead + dir / (src && src.kind === 'video' ? src.frameRate : 30));
  }
  $('frameBackBtn').addEventListener('click', () => frameStep(-1));
  $('frameFwdBtn').addEventListener('click', () => frameStep(1));

  function updateTime() {
    $('curTime').textContent = fmtTime(playhead);
    $('totalTime').textContent = fmtTime(totalDuration());
  }

  // ---------------------------------------------------------------------------
  // Canvas (format, background)
  // ---------------------------------------------------------------------------
  const DEFAULT_COLOR = '#293133'; // anthracite (RAL 7016)
  const ASPECTS = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:5': 4 / 5, '4:3': 4 / 3, '3:4': 3 / 4, '21:9': 64 / 27 };
  const defaultCanvas = () => ({ aspect: '16:9', videoSrcId: null, ratioW: 3, ratioH: 2, bg: 'color', bgColor: DEFAULT_COLOR });
  let canvasState = defaultCanvas();

  const videoSources = () => [...sources.values()].filter((s) => s.kind === 'video' && !s.missing);
  function aspectVideo() {
    const s = sources.get(canvasState.videoSrcId);
    return s && s.kind === 'video' ? s : videoSources()[0] || null;
  }
  function canvasAspect() {
    const a = canvasState.aspect;
    if (ASPECTS[a]) return ASPECTS[a];
    if (a === 'custom') return clamp((canvasState.ratioW || 1) / (canvasState.ratioH || 1), 0.1, 10);
    const v = aspectVideo();
    if (v) { const d = Render.displaySize(v); return d.w / d.h; }
    return 16 / 9;
  }

  function syncCanvasUI() {
    $('aspectSel').value = canvasState.aspect;
    $('aspectCustomField').hidden = canvasState.aspect !== 'custom';
    $('aspectVideoField').hidden = canvasState.aspect !== 'video';
    $('ratioW').value = canvasState.ratioW;
    $('ratioH').value = canvasState.ratioH;
    const vs = videoSources();
    const sel = $('aspectVideoSel');
    sel.replaceChildren(...(vs.length ? vs.map((s) => {
      const o = document.createElement('option');
      const d = Render.displaySize(s);
      o.value = s.id;
      o.textContent = `${s.name} · ${d.w}×${d.h}`;
      return o;
    }) : [Object.assign(document.createElement('option'), { value: '', textContent: 'No video loaded — using 16:9' })]));
    const av = aspectVideo();
    if (av) sel.value = av.id;
    $('bgToggle').querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.bg === canvasState.bg));
    $('bgColor').value = canvasState.bgColor;
    $('bgHint').textContent = canvasState.bg === 'blur'
      ? 'Blurred copy of the visible video or image. Color clips and empty areas use the color.'
      : 'Fills the space around videos and images that don\'t match the format.';
  }

  function onCanvasChange() {
    syncCanvasUI();
    updateResolutionOptions();
    updatePreviewAspect();
    updateEstimate();
    renderPreview();
    scheduleSave();
  }
  $('aspectSel').addEventListener('change', (e) => {
    canvasState.aspect = e.target.value;
    if (canvasState.aspect === 'video' && !sources.get(canvasState.videoSrcId)) canvasState.videoSrcId = (videoSources()[0] || {}).id || null;
    onCanvasChange();
  });
  $('aspectVideoSel').addEventListener('change', (e) => { canvasState.videoSrcId = e.target.value || null; onCanvasChange(); });
  ['ratioW', 'ratioH'].forEach((id) => $(id).addEventListener('change', () => {
    canvasState.ratioW = clamp(parseFloat($('ratioW').value) || 1, 0.1, 100);
    canvasState.ratioH = clamp(parseFloat($('ratioH').value) || 1, 0.1, 100);
    onCanvasChange();
  }));
  $('bgToggle').addEventListener('click', (e) => {
    const b = e.target.closest('.seg-btn');
    if (!b) return;
    canvasState.bg = b.dataset.bg;
    onCanvasChange();
  });
  $('bgColor').addEventListener('input', (e) => { canvasState.bgColor = e.target.value; renderPreview(); });
  $('bgColor').addEventListener('change', (e) => { canvasState.bgColor = e.target.value; onCanvasChange(); });

  // Preview format
  const preview = $('preview');
  function updatePreviewAspect() {
    const a = canvasAspect();
    preview.style.aspectRatio = String(a);
    // Limit width for portrait formats so the preview fits on screen.
    preview.style.maxWidth = a < 1 ? `calc(52vh * ${a})` : '';
    renderPreview();
  }

  // Colour clips are drawn from a small cached canvas with the clip's shape.
  const colorCache = new Map();
  function colorCanvas(color, w, h) {
    const k = 64;
    const cw = w >= h ? k : Math.max(1, Math.round(k * w / h));
    const ch = w >= h ? Math.max(1, Math.round(k * h / w)) : k;
    const key = `${color}|${cw}|${ch}`;
    let c = colorCache.get(key);
    if (!c) {
      c = document.createElement('canvas');
      c.width = cw; c.height = ch;
      const x = c.getContext('2d');
      x.fillStyle = color;
      x.fillRect(0, 0, cw, ch);
      if (colorCache.size > 50) colorCache.clear();
      colorCache.set(key, c);
    }
    return c;
  }
  function colorDims(clip, outW, outH) {
    if (clip.size === 'canvas') return { w: outW, h: outH };
    return { w: clip.w || 1920, h: clip.h || 1080 };
  }

  // What to draw for a clip (null = not ready yet).
  function stillFor(clip, outW, outH) {
    if (clip.kind === 'image') {
      const s = srcOf(clip);
      if (!s || !s.bitmap) return null;
      return { drawable: s.bitmap, w: s.width, h: s.height, isColor: false };
    }
    if (clip.kind === 'color') {
      const d = colorDims(clip, outW, outH);
      return { drawable: colorCanvas(clip.color || DEFAULT_COLOR, d.w, d.h), w: d.w, h: d.h, isColor: true };
    }
    return null;
  }

  function renderPreview() {
    if ($('editorScreen').hidden) return;
    const cw = pv.clientWidth, ch = pv.clientHeight;
    if (!cw || !ch) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.round(cw * dpr), H = Math.round(ch * dpr);
    if (pv.width !== W || pv.height !== H) { pv.width = W; pv.height = H; }
    const bg = canvasState.bgColor;
    const fit = canvasState.bg === 'blur' ? 'blur' : 'bars';
    const clip = clips[activeIdx];
    if (!clip) { pvCtx.fillStyle = bg; pvCtx.fillRect(0, 0, W, H); return; }
    if (isVideoClip(clip)) {
      const el = showing;
      if (!el || el.readyState < 2 || !el.videoWidth) return; // keep the last frame while seeking
      Render.drawFit(pvCtx, el, el.videoWidth, el.videoHeight, 0, W, H, fit, bg);
      return;
    }
    const out = outputDims();
    const st = stillFor(clip, out.w, out.h);
    if (!st) { pvCtx.fillStyle = bg; pvCtx.fillRect(0, 0, W, H); return; }
    Render.drawFit(pvCtx, st.drawable, st.w, st.h, 0, W, H, st.isColor ? 'bars' : fit, bg);
  }

  vids.forEach((v) => {
    v.addEventListener('seeked', () => { if (v === showing) renderPreview(); });
    v.addEventListener('loadeddata', () => { if (v === showing) renderPreview(); });
    v.addEventListener('error', async () => {
      if (v !== showing || !v.getAttribute('src')) return;
      const src = sources.get(v.dataset.src);
      if (src && !(await isReadable(src))) { lostAccess([src]); return; }
      toast('This browser can\'t preview this video, but exporting may still work.', 5000);
    });
  });

  // ---------------------------------------------------------------------------
  // Keyboard shortcuts and pasting
  // ---------------------------------------------------------------------------
  let pasteFallback = 0;
  document.addEventListener('keydown', (e) => {
    if ($('editorScreen').hidden || exporting) return;
    if (document.querySelector('.modal-bg:not([hidden])')) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
    else if (mod && k === 'c') { e.preventDefault(); copySelected(false); }
    else if (mod && k === 'v') {
      // The paste event decides (files in the clipboard win); if the browser
      // sends none, paste the copied clip.
      clearTimeout(pasteFallback);
      pasteFallback = setTimeout(() => { if (clipboard) paste(); }, 80);
    }
    else if (mod) return;
    else if (e.key === ' ') { e.preventDefault(); playing ? pause() : play(); }
    else if (k === 's' || k === 'c') splitAtPlayhead();
    else if (k === 'm') toggleMuteClip();
    else if (e.key === 'Escape') { selectedId = null; renderClips(); updateToolbar(); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); e.shiftKey ? (pause(), seek(playhead - 1)) : frameStep(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); e.shiftKey ? (pause(), seek(playhead + 1)) : frameStep(1); }
    else if (e.key === 'Home') { pause(); seek(0); }
    else if (e.key === 'End') { pause(); seek(totalDuration()); }
  });

  // Paste images or video files from the clipboard (start screen and editor),
  // otherwise paste the copied clip.
  document.addEventListener('paste', (e) => {
    clearTimeout(pasteFallback);
    if (exporting || document.querySelector('.modal-bg:not([hidden])')) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;
    const files = [...((e.clipboardData && e.clipboardData.files) || [])];
    if (files.length) {
      e.preventDefault();
      handleFiles(files.map((file) => ({ file, pasted: true })));
      return;
    }
    if (!$('editorScreen').hidden && clipboard) { e.preventDefault(); paste(); }
  });

  // ---------------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------------
  const exportDefaults = () => ({ res: '1080', resW: 1920, resH: 1080, quality: 'standard', bitrateMbps: 5, targetMB: 25, lockRes: false, fps: '30', codec: 'avc' });
  let exportState = Object.assign(exportDefaults(), store.get('export2', {}));

  function resolutionOptions() {
    const a = canvasAspect();
    const land = a >= 1;
    const dims = (short) => (land ? { w: even(short * a), h: short } : { w: short, h: even(short / a) });
    const opts = [];
    if (canvasState.aspect === 'video') {
      const v = aspectVideo();
      if (v) { const d = Render.displaySize(v); opts.push({ key: 'source', label: `Source · ${even(d.w)}×${even(d.h)}`, w: even(d.w), h: even(d.h) }); }
    }
    const wide = canvasState.aspect === '16:9' || canvasState.aspect === '9:16';
    const names = wide ? { 720: 'HD', 1080: 'Full HD', 2160: 'UHD' } : { 720: '720p', 1080: '1080p', 2160: '4K' };
    for (const sh of [720, 1080, 2160]) { const d = dims(sh); opts.push({ key: String(sh), label: `${names[sh]} · ${d.w}×${d.h}`, w: d.w, h: d.h }); }
    opts.push({ key: 'custom', label: 'Custom…' });
    return opts;
  }
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);

  function updateResolutionOptions() {
    const opts = resolutionOptions();
    const sel = $('resSel');
    sel.replaceChildren(...opts.map((o) => Object.assign(document.createElement('option'), { value: o.key, textContent: o.label })));
    if (!opts.some((o) => o.key === exportState.res)) exportState.res = '1080';
    sel.value = exportState.res;
    if (exportState.res !== 'custom') {
      const o = opts.find((x) => x.key === exportState.res);
      exportState.resW = o.w; exportState.resH = o.h;
    }
    $('resCustomField').hidden = exportState.res !== 'custom';
    $('resW').value = exportState.resW;
    $('resH').value = exportState.resH;
    updateQualityLabels();
  }

  function outputDims() {
    if (exportState.res === 'custom') return { w: even(clamp(exportState.resW, 16, 8192)), h: even(clamp(exportState.resH, 16, 8192)) };
    const o = resolutionOptions().find((x) => x.key === exportState.res) || resolutionOptions().find((x) => x.key === '1080');
    return { w: o.w, h: o.h };
  }

  function getExportSettings() {
    const d = outputDims();
    return {
      width: d.w, height: d.h,
      quality: exportState.quality, bitrateMbps: exportState.bitrateMbps, targetMB: exportState.targetMB, lockRes: exportState.lockRes,
      fps: exportState.fps, codec: exportState.codec, muteAll,
      fit: canvasState.bg === 'blur' ? 'blur' : 'bars', bg: canvasState.bgColor,
    };
  }

  function syncExportUI() {
    updateResolutionOptions();
    $('qualitySel').value = exportState.quality;
    $('bitrateMbps').value = exportState.bitrateMbps;
    $('targetMB').value = exportState.targetMB;
    $('lockRes').checked = !!exportState.lockRes;
    $('fpsSel').value = exportState.fps;
    if (!$('codecSel').querySelector(`option[value="${exportState.codec}"]`).disabled) $('codecSel').value = exportState.codec;
    $('bitrateField').hidden = exportState.quality !== 'custom';
    $('targetField').hidden = exportState.quality !== 'target';
    $('lockResField').hidden = exportState.quality !== 'target';
    updateQualityLabels();
  }

  function updateQualityLabels() {
    const d = outputDims();
    const fps = Number(exportState.fps) || 30;
    const names = { small: 'Small', standard: 'Standard', high: 'High' };
    for (const q of Object.keys(names)) {
      const o = $('qualitySel').querySelector(`option[value="${q}"]`);
      o.textContent = `${names[q]} · ≈ ${(Render.presetBitrate(q, d.w, d.h, fps) / 1e6).toFixed(1)} Mbit/s`;
    }
  }

  function onExportChange() {
    exportState.quality = $('qualitySel').value;
    exportState.bitrateMbps = clamp(parseFloat($('bitrateMbps').value) || 5, 0.1, 100);
    exportState.targetMB = clamp(parseFloat($('targetMB').value) || 25, 0.2, 100000);
    exportState.lockRes = $('lockRes').checked;
    exportState.fps = $('fpsSel').value;
    exportState.codec = $('codecSel').value;
    store.set('export2', exportState);
    syncExportUI();
    updateEstimate();
    scheduleSave();
  }
  ['qualitySel', 'bitrateMbps', 'targetMB', 'lockRes', 'fpsSel', 'codecSel'].forEach((id) => $(id).addEventListener('change', onExportChange));
  $('resSel').addEventListener('change', (e) => {
    exportState.res = e.target.value;
    if (exportState.res === 'custom') {
      const d = outputDims();
      exportState.resW = d.w; exportState.resH = d.h;
    }
    onExportChange();
    renderPreview();
  });
  // Custom resolution: width and height stay linked to the canvas format.
  $('resW').addEventListener('change', () => {
    exportState.resW = even(clamp(parseInt($('resW').value, 10) || 1920, 16, 8192));
    exportState.resH = even(clamp(exportState.resW / canvasAspect(), 16, 8192));
    onExportChange();
  });
  $('resH').addEventListener('change', () => {
    exportState.resH = even(clamp(parseInt($('resH').value, 10) || 1080, 16, 8192));
    exportState.resW = even(clamp(exportState.resH * canvasAspect(), 16, 8192));
    onExportChange();
  });

  Render.canEncodeHevc().then((ok) => {
    const opt = $('codecSel').querySelector('option[value="hevc"]');
    if (ok) {
      opt.disabled = false;
      opt.textContent = 'H.265 (HEVC) · smaller, newer devices';
      if (exportState.codec === 'hevc') $('codecSel').value = 'hevc';
    } else if (exportState.codec === 'hevc') {
      exportState.codec = 'avc';
      $('codecSel').value = 'avc';
    }
  });

  const usedSources = () => [...new Set(clips.map((c) => srcOf(c)).filter(Boolean))];

  function sourceBytes() {
    return clips.reduce((sum, c) => {
      const s = srcOf(c);
      return s && s.kind === 'video' && s.file ? sum + ((c.out - c.in) / Math.max(0.01, s.fileDuration)) * s.file.size : sum;
    }, 0);
  }

  function updateEstimate() {
    if (!clips.length) { $('estimate').textContent = ''; return; }
    const s = getExportSettings();
    const used = usedSources();
    const dur = totalDuration();
    const out = Render.computeOutput(s, used, dur);
    const withAudio = !muteAll && clips.some((c) => isVideoClip(c) && !c.muted && srcOf(c) && srcOf(c).audioDecodable);
    const est = Render.estimateSize(out, dur, withAudio);
    const srcBytes = sourceBytes();
    const onlyVideos = used.length && used.every((x) => x.kind === 'video');
    let html = `${out.width}×${out.height} · ${out.fps} fps · ${(out.bitrate / 1e6).toFixed(1)} Mbit/s · ${fmtTime(dur, false)}<br>` +
      `Estimated size: <strong>≈ ${fmtSize(est)}</strong>` + (srcBytes ? ` (source videos ≈ ${fmtSize(srcBytes)})` : '');
    if (out.scaled) html += `<span class="warn-line">Exported as ${out.width}×${out.height} — at this file size, a smaller picture looks better than a blocky one. Tick "Keep resolution" to prevent this.</span>`;
    if (onlyVideos && est >= srcBytes * 0.9) html += '<span class="warn-line">This video is already strongly compressed — exporting won\'t make it noticeably smaller.</span>';
    else if (out.capped) html += '<span class="hint-line">Bitrate limited so the file doesn\'t get bigger than the source.</span>';
    $('estimate').innerHTML = html;
  }

  let abortCtl = null;
  let resultUrl = null;
  let resultFile = null;
  let wakeLock = null;

  async function doExport() {
    if (!clips.length || exporting) return;
    pause();
    const unreadable = await unreadableSources();
    if (unreadable.length) { lostAccess(unreadable); return; }
    exporting = true;
    updateToolbar();
    $('resultBox').hidden = true;
    $('progressBox').hidden = false;
    $('progressFill').style.width = '0%';
    $('progressLabel').textContent = 'Preparing…';
    abortCtl = new AbortController();
    try { if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { wakeLock = null; }

    const s = getExportSettings();
    // Clip times are in media time; the export reads the actual (possibly trimmed-copy) file.
    const expClips = clips.map((c) => {
      if (isVideoClip(c)) { const src = srcOf(c); return { kind: 'video', source: src, in: c.in - src.base, out: c.out - src.base, muted: c.muted }; }
      return { kind: c.kind, source: srcOf(c) || null, in: c.in, out: c.out, muted: true, still: stillFor(c, s.width, s.height) };
    });
    const t0 = performance.now();
    try {
      const r = await Render.exportTimeline({
        clips: expClips,
        settings: s,
        signal: abortCtl.signal,
        onProgress: (f, stage) => {
          $('progressFill').style.width = (f * 100).toFixed(1) + '%';
          const el = (performance.now() - t0) / 1000;
          const eta = f > 0.03 ? el / f - el : null;
          const label = stage === 'audio' ? 'Encoding audio' : stage === 'finalizing' ? 'Writing file' : 'Encoding video';
          $('progressLabel').textContent = `${label}… ${Math.floor(f * 100)}%${eta !== null && stage !== 'finalizing' ? ' · ~' + fmtTime(eta, false) + ' left' : ''}`;
        },
      });
      showResult(r);
    } catch (e) {
      if (e && e.name === 'AbortError') toast('Export cancelled.');
      else if (e && e.name === 'NotReadableError') { const u = await unreadableSources(); if (u.length) lostAccess(u); else toast('Export failed: a video couldn\'t be read.', 7000); }
      else { console.error(e); toast('Export failed: ' + (e && e.message ? e.message : e), 7000); }
    } finally {
      exporting = false;
      abortCtl = null;
      $('progressBox').hidden = true;
      if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
      updateToolbar();
    }
  }
  $('exportBtn').addEventListener('click', doExport);
  $('cancelExportBtn').addEventListener('click', () => { if (abortCtl) abortCtl.abort(); });

  function showResult(r) {
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    const first = clips.map((c) => srcOf(c)).find(Boolean);
    const base = (first ? first.name : 'videcutto').replace(/\.[^.]+$/, '');
    const name = `${base}_videcutto.mp4`;
    resultFile = new File([r.blob], name, { type: 'video/mp4' });
    resultUrl = URL.createObjectURL(resultFile);
    const link = $('downloadLink');
    link.href = resultUrl;
    link.download = name;
    const before = sourceBytes();
    const after = r.blob.size;
    const saving = before ? Math.round((1 - after / before) * 100) : 0;
    $('resultSizes').innerHTML = (before ? `Done! ${fmtSize(before)} → <strong>${fmtSize(after)}</strong>` : `Done! <strong>${fmtSize(after)}</strong>`) +
      (saving > 0 ? ` <span class="saving">−${saving}%</span>` : '') +
      `<br><span class="hint">${r.out.width}×${r.out.height} · ${r.videoCodec === 'hevc' ? 'H.265' : 'H.264'}${r.audioCodec ? ' · ' + (r.audioCodec === 'aac' ? 'AAC' : 'Opus') : ' · no sound'}</span>`;
    const onlyVideos = usedSources().every((x) => x.kind === 'video');
    if (before && onlyVideos && after >= before * 0.95) r.warnings.push('The source was already strongly compressed, so the file didn\'t get noticeably smaller.');
    const ul = $('resultWarnings');
    ul.replaceChildren(...r.warnings.map((w) => { const li = document.createElement('li'); li.textContent = w; return li; }));
    $('shareBtn').hidden = !(navigator.canShare && navigator.canShare({ files: [resultFile] }));
    $('resultBox').hidden = false;
    $('resultBox').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  $('shareBtn').addEventListener('click', () => {
    if (!resultFile) return;
    navigator.share({ files: [resultFile], title: resultFile.name }).catch(() => {});
  });

  // ---------------------------------------------------------------------------
  // Project persistence (autosave, restore, relink)
  // ---------------------------------------------------------------------------
  let saveTimer = 0;
  function scheduleSave() {
    if (!saveEnabled) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 400);
  }

  function referencedIds() {
    const ids = new Set();
    const add = (list) => list.forEach((c) => { if (c.srcId) ids.add(c.srcId); });
    add(clips);
    undoStack.forEach(add);
    redoStack.forEach(add);
    if (clipboard && clipboard.srcId) ids.add(clipboard.srcId);
    return ids;
  }

  // Drop media that nothing (timeline, undo/redo, clipboard) refers to anymore.
  function cleanupMedia() {
    const used = referencedIds();
    for (const src of [...sources.values()]) {
      if (used.has(src.id)) continue;
      if (src.storage === 'opfs' && src.copyName) Project.removeCopy(src.copyName);
      if (src.storage === 'handle') Project.removeHandle(src.id);
      if (src.url) URL.revokeObjectURL(src.url);
      src.thumbs.forEach((u) => u && URL.revokeObjectURL(u));
      if (src.bitmap) src.bitmap.close();
      sources.delete(src.id);
    }
  }

  async function saveNow() {
    if (!saveEnabled) return;
    cleanupMedia();
    await Project.saveProject({
      version: 2,
      app: VERSION,
      savedAt: Date.now(),
      playhead,
      muteAll,
      canvas: { ...canvasState },
      export: { ...exportState },
      // Tracks are prepared for multiple timelines; for now there is one main track.
      tracks: [{ id: 't1', kind: 'main', clips: clips.map((c) => ({ ...c })) }],
      media: [...sources.values()].map(mediaMeta),
    });
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden && saveEnabled) { clearTimeout(saveTimer); saveNow(); } });

  async function isReadable(src) {
    if (!src || !src.file) return false;
    try { await src.file.slice(0, 16).arrayBuffer(); return true; } catch (e) { return false; }
  }
  async function unreadableSources() {
    // Images are decoded into memory when loaded, only videos are read during export.
    const used = [...new Set(clips.filter(isVideoClip).map((c) => srcOf(c)).filter(Boolean))];
    const out = [];
    for (const s of used) if (s.missing || !(await isReadable(s))) out.push(s);
    return out;
  }

  function projectSummary(p) {
    const cl = (p.tracks && p.tracks[0] && p.tracks[0].clips) || [];
    const dur = cl.reduce((s, c) => s + (c.out - c.in), 0);
    return { count: cl.length, dur, media: (p.media || []).length };
  }

  function updateResumeCard() {
    const card = $('resumeCard');
    if (clips.length) {
      $('resumeTitle').textContent = 'Current project';
      $('resumeMeta').textContent = `${clips.length} clip${clips.length === 1 ? '' : 's'} · ${fmtTime(totalDuration(), false)}`;
      card.hidden = false;
    } else if (pendingProject) {
      const sum = projectSummary(pendingProject);
      const when = new Date(pendingProject.savedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
      $('resumeTitle').textContent = 'Last project';
      $('resumeMeta').textContent = `${sum.count} clip${sum.count === 1 ? '' : 's'} · ${fmtTime(sum.dur, false)} · saved ${when}`;
      card.hidden = false;
    } else {
      card.hidden = true;
    }
  }

  async function newProject(skipConfirm) {
    if (!skipConfirm && (clips.length || pendingProject) && !confirm('Start a new project? The current project and its saved videos will be deleted.')) return false;
    pause();
    clearTimeout(saveTimer);
    clips = []; undoStack = []; redoStack = []; clipboard = null; selectedId = null; playhead = 0;
    for (const src of sources.values()) { if (src.url) URL.revokeObjectURL(src.url); src.thumbs.forEach((u) => u && URL.revokeObjectURL(u)); if (src.bitmap) src.bitmap.close(); }
    sources.clear();
    pendingProject = null;
    await Project.clearAll();
    canvasState = defaultCanvas();
    syncCanvasUI();
    syncExportUI();
    saveEnabled = true;
    seek(0);
    updateResumeCard();
    updateToolbar();
    return true;
  }

  $('resumeBtn').addEventListener('click', () => { if (pendingProject && !clips.length) restoreProject(pendingProject); else showEditor(); });
  $('newProjectBtn').addEventListener('click', async () => { if (await newProject(false)) showStart(); });

  /** Try to get a readable file for a saved media entry without user interaction. */
  async function locateMedia(m) {
    if (m.storage === 'opfs' && m.copyName) {
      const f = await Project.getCopy(m.copyName);
      if (f) return { file: f, base: m.base, isCopy: true };
    }
    const handle = await Project.loadHandle(m.id);
    if (handle) {
      try {
        const perm = await handle.queryPermission({ mode: 'read' });
        if (perm === 'granted') return { file: await handle.getFile(), base: 0, handle };
        return { needsPermission: true, handle };
      } catch (e) { /* handle stale */ }
    }
    return {};
  }

  async function attach(m, file, base, extra = {}) {
    if (m.kind === 'image') {
      const bmp = await decodeImage(file).catch(() => { throw new Error(`"${file.name}" couldn't be opened as an image.`); });
      return Object.assign(makeImageSource(m, file, bmp), extra);
    }
    const probed = await probe(file);
    const src = makeSource(m, file, probed, base);
    Object.assign(src, extra);
    return src;
  }

  async function restoreProject(p) {
    showBusy('Opening project…', '');
    let maxId = 0;
    const bump = (id) => { const n = parseInt(String(id).replace(/\D/g, ''), 10); if (n > maxId) maxId = n; };
    const entries = [];
    try {
      for (const m of p.media || []) {
        bump(m.id);
        const loc = await locateMedia(m);
        let src = null;
        if (loc.file) {
          try {
            src = await attach(m, loc.file, loc.base, { storage: loc.isCopy ? 'opfs' : 'handle', copyName: loc.isCopy ? m.copyName : null });
          } catch (e) { src = null; }
        }
        entries.push({ meta: m, src, handle: loc.handle || null, needsPermission: !!loc.needsPermission });
      }
    } finally {
      hideBusy();
    }
    const cl = (p.tracks && p.tracks[0] && p.tracks[0].clips) || [];
    cl.forEach((c) => bump(c.id));
    uid = Math.max(uid, maxId);
    clips = cl.map((c) => ({ ...c, kind: c.kind || 'video' }));
    undoStack = []; redoStack = []; clipboard = null; selectedId = null;
    muteAll = !!p.muteAll;
    $('muteAllBtn').setAttribute('aria-pressed', String(muteAll));
    if (p.version >= 2 && p.canvas) {
      canvasState = Object.assign(defaultCanvas(), p.canvas);
      exportState = Object.assign(exportDefaults(), p.export || {});
    } else {
      // Projects from 0.2.x: format and background lived in the export settings.
      const old = p.export || {};
      canvasState = defaultCanvas();
      if (old.aspect === 'auto' || !old.aspect) canvasState.aspect = 'video';
      else if (ASPECTS[old.aspect]) canvasState.aspect = old.aspect;
      if (old.fit === 'blur') canvasState.bg = 'blur';
      exportState = Object.assign(exportDefaults(), { fps: old.fps || '30', codec: old.codec || 'avc' });
      if (old.preset === 'target') Object.assign(exportState, { quality: 'target', targetMB: old.target || 25 });
      if (old.preset === 'hd' || old.preset === 'small') exportState.res = '720';
    }
    entries.forEach((e) => { if (e.src) sources.set(e.src.id, e.src); });
    const missing = entries.filter((e) => !e.src);
    const finish = () => {
      pendingProject = null;
      saveEnabled = true;
      playhead = clamp(p.playhead || 0, 0, totalDuration());
      showEditor();
      syncCanvasUI();
      syncExportUI();
      updatePreviewAspect();
      updateEstimate();
      sources.forEach((s) => { if (!s.thumbs.length) queueThumbs(s); });
      scheduleSave();
    };
    if (!missing.length) { finish(); return; }
    const ok = await openRelink(entries, 'restore');
    if (ok) finish();
    else {
      // Back to the start screen; the saved project stays untouched.
      clips = [];
      sources.clear();
      updateResumeCard();
    }
  }

  /** Access to sources was lost during editing (e.g. Android revoked it). */
  async function lostAccess(srcs) {
    if (!$('relinkModal').hidden) return;
    pause();
    const entries = [...sources.values()].map((s) => ({ meta: mediaMeta(s), src: srcs.includes(s) ? null : s, handle: null, needsPermission: false, old: s }));
    for (const e of entries) if (!e.src && e.meta.storage === 'handle') {
      e.handle = await Project.loadHandle(e.meta.id);
      e.needsPermission = !!e.handle;
    }
    srcs.forEach((s) => { s.missing = true; });
    const ok = await openRelink(entries.filter((e) => clips.some((c) => c.srcId === e.meta.id) || !e.src), 'edit');
    if (ok) { renderTimeline(); seek(playhead); updateEstimate(); scheduleSave(); }
  }

  /**
   * Shows the list of media; missing ones can be granted access, selected
   * again (matched by file size, then by duration), or their clips removed.
   * Resolves true when every listed media is available again.
   */
  function openRelink(entries, mode) {
    return new Promise((resolve) => {
      const modal = $('relinkModal');
      const list = $('relinkList');
      const isRestore = mode === 'restore';
      $('relinkTitle').textContent = isRestore ? 'Open last project' : 'Video no longer available';
      $('relinkSub').textContent = isRestore
        ? 'Some videos of this project need to be opened again. Select the same files — they are recognised automatically, even if Android renamed them.'
        : 'The browser lost access to this video (Android does this after a while, or the file was changed). Select it again — your edits are kept.';
      $('relinkDoneBtn').textContent = isRestore ? 'Open project' : 'Continue';
      $('relinkCancelBtn').textContent = isRestore ? 'Back' : 'Close';

      const resolved = (e) => !!e.src;
      const render = () => {
        list.replaceChildren(...entries.map((e, i) => {
          const li = document.createElement('li');
          const info = document.createElement('div');
          info.className = 'm-info';
          const name = document.createElement('div');
          name.className = 'm-name';
          name.textContent = e.meta.name;
          const meta = document.createElement('div');
          meta.className = 'm-meta';
          meta.textContent = e.meta.kind === 'image'
            ? `Image · ${e.meta.width}×${e.meta.height} · ${fmtSize(e.meta.origSize)}`
            : `${fmtTime(e.meta.duration - e.meta.start, false)} · ${fmtSize(e.meta.origSize)}`;
          info.append(name, meta);
          const st = document.createElement('span');
          st.className = 'status ' + (resolved(e) ? 'ok' : e.needsPermission ? 'ask' : 'missing');
          st.textContent = resolved(e) ? 'Ready' : e.needsPermission ? 'Needs access' : 'Missing';
          li.append(info, st);
          if (!resolved(e)) {
            const b = document.createElement('button');
            b.className = 'btn-chip';
            b.textContent = 'Select';
            b.addEventListener('click', () => pickFor(i));
            li.append(b);
          }
          return li;
        }));
        const open = entries.filter((e) => !resolved(e));
        $('relinkAllowBtn').hidden = !open.some((e) => e.needsPermission);
        $('relinkPickBtn').hidden = !open.length;
        $('relinkRemoveBtn').hidden = !open.length;
        $('relinkDoneBtn').disabled = open.length > 0 || !clips.length;
      };

      const assign = async (e, file, handle) => {
        showBusy(e.meta.kind === 'image' ? 'Opening image…' : 'Opening video…', file.name);
        try {
          const m = e.meta;
          const src = await attach(m, file, 0, { storage: handle ? 'handle' : 'none', copyName: null });
          if (e.old) { src.thumbs = e.old.thumbs; src.thumbStep = e.old.thumbStep; src.thumbAspect = e.old.thumbAspect; if (e.old.url) URL.revokeObjectURL(e.old.url); }
          if (m.kind !== 'image' && src.fileDuration + 0.05 < m.rangeOut) toast(`"${file.name}" is shorter than the original — some cuts may be cut off.`, 6000);
          hideBusy();
          if (m.kind === 'image') {
            if (Project.canCopy()) {
              const name = `${src.id}-${Date.now().toString(36)}-${++copyCounter}.img`;
              try { src.file = await Project.copyWhole(name, file); src.storage = 'opfs'; src.copyName = name; } catch (err) { /* keep */ }
            }
            if (src.storage !== 'opfs' && handle) await Project.saveHandle(src.id, handle);
            if (!src.thumbs.length) queueThumbs(src);
          } else if (!(await makeWorkingCopy(src)) && handle) await Project.saveHandle(src.id, handle);
          if (e.old && e.old.storage === 'opfs' && e.old.copyName && e.old.copyName !== src.copyName) Project.removeCopy(e.old.copyName);
          e.src = src;
          sources.set(src.id, src);
          vids.forEach((v) => { if (v.dataset.src === src.id) delete v.dataset.url; });
        } catch (err) {
          toast(err.message || String(err), 6000);
        } finally {
          hideBusy();
        }
      };

      const pickFor = async (i) => {
        const [sel] = await pickFiles(false);
        if (!sel) return;
        const e = entries[i];
        if (sel.file.size !== e.meta.origSize) toast('This file isn\'t identical to the original — cuts may not line up exactly.', 5000);
        await assign(e, sel.file, sel.handle);
        render();
      };

      const onPick = async () => {
        const picked = await pickFiles(true);
        const unmatched = [];
        for (const { file, handle } of picked) {
          let e = entries.find((x) => !resolved(x) && x.meta.origSize === file.size);
          if (!e) {
            // Fall back to duration (e.g. the file was re-saved by another app).
            try {
              const d = await MP4.demux(file);
              e = entries.find((x) => !resolved(x) && Math.abs(x.meta.duration - d.video.duration) < 0.2 && x.meta.width === d.video.width && x.meta.height === d.video.height);
            } catch (err) { /* not a video */ }
          }
          if (e) await assign(e, file, handle);
          else if (!entries.some((x) => resolved(x) && x.meta.origSize === file.size)) unmatched.push(file.name);
        }
        if (unmatched.length) toast(`Not part of this project: ${unmatched.join(', ')}`, 5000);
        render();
      };

      const onAllow = async () => {
        for (const e of entries) {
          if (resolved(e) || !e.needsPermission || !e.handle) continue;
          try {
            const perm = await e.handle.requestPermission({ mode: 'read' });
            if (perm === 'granted') await assign(e, await e.handle.getFile(), e.handle);
          } catch (err) { /* user declined or file gone */ }
          if (!resolved(e)) e.needsPermission = false;
        }
        render();
      };

      const onRemove = () => {
        const gone = new Set(entries.filter((e) => !resolved(e)).map((e) => e.meta.id));
        const keep = (list) => list.filter((c) => !gone.has(c.srcId));
        clips = keep(clips);
        undoStack = undoStack.map(keep);
        redoStack = redoStack.map(keep);
        if (clipboard && gone.has(clipboard.srcId)) clipboard = null;
        gone.forEach((id) => { const s = sources.get(id); if (s && s.storage === 'opfs' && s.copyName) Project.removeCopy(s.copyName); Project.removeHandle(id); sources.delete(id); });
        entries = entries.filter((e) => resolved(e));
        if (!clips.length) {
          close(false, true);
          newProject(true).then(() => { showStart(); toast('No clips were left — started a new project.'); });
          return;
        }
        close(true);
      };

      const close = (ok, silent) => {
        modal.hidden = true;
        $('relinkPickBtn').onclick = $('relinkAllowBtn').onclick = $('relinkRemoveBtn').onclick = $('relinkDoneBtn').onclick = $('relinkCancelBtn').onclick = null;
        if (!ok && !silent && !isRestore) toast('The missing video can\'t be played or exported until it is selected again.', 5000);
        resolve(ok);
      };

      $('relinkPickBtn').onclick = onPick;
      $('relinkAllowBtn').onclick = onAllow;
      $('relinkRemoveBtn').onclick = () => {
        if (!confirm('Remove all clips of the missing videos from the project?')) return;
        onRemove();
      };
      $('relinkDoneBtn').onclick = () => close(true);
      $('relinkCancelBtn').onclick = () => close(false);
      render();
      modal.hidden = false;
    });
  }

  // Settings: storage info and project deletion
  $('settingsItem').addEventListener('click', async () => {
    const copies = await Project.listCopies();
    const bytes = copies.reduce((s, c) => s + c.size, 0);
    const linked = [...sources.values()].filter((s) => s.storage === 'handle').length;
    let txt = 'Your project is saved automatically on this device.';
    if (copies.length) txt += ` Working copies of ${copies.length} video${copies.length === 1 ? '' : 's'} use ${fmtSize(bytes)}.`;
    if (linked) txt += ` ${linked} video${linked === 1 ? ' is' : 's are'} linked to the original file${linked === 1 ? '' : 's'} (no extra space).`;
    $('storageInfo').textContent = txt;
  });
  $('deleteProjectBtn').addEventListener('click', async () => {
    if (await newProject(false)) { closeModal('settingsModal'); showStart(); toast('Project deleted.'); }
  });

  // On start: look for a saved project.
  (async () => {
    const p = await Project.loadProject().catch(() => null);
    if (p && projectSummary(p).count) pendingProject = p;
    else saveEnabled = true;
    updateResumeCard();
  })();

  // ---------------------------------------------------------------------------
  // Service worker
  // ---------------------------------------------------------------------------
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });
  }

  setPlayIcon();
  syncCanvasUI();
  syncExportUI();
  updatePreviewAspect();
  updateToolbar();
})();
