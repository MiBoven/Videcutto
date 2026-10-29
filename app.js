/*
 * app.js — Videcutto UI: loading, pre-trimming, timeline editing, preview
 * playback and export. The heavy lifting lives in mp4.js and render.js.
 */
(() => {
  'use strict';

  const VERSION = '0.8.1';
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
    rows: store.get('tlRows', isCoarse ? 3 : 5),
  };
  const THRESH = isCoarse ? { bytes: 150 * 1024 * 1024, secs: 180 } : { bytes: 1024 * 1024 * 1024, secs: 900 };
  $('trimModeSel').value = settings.trimMode;
  $('undoStepsInput').value = settings.undoSteps;
  $('trimThresholdHint').textContent = `On this device, "large" means bigger than ${fmtSize(THRESH.bytes)} or longer than ${THRESH.secs / 60} minutes.`;
  $('tlRowsInput').value = settings.rows;
  $('tlRowsInput').addEventListener('change', (e) => {
    settings.rows = clamp(parseInt(e.target.value, 10) || 3, 1, 20);
    e.target.value = settings.rows;
    store.set('tlRows', settings.rows);
    renderTimeline();
  });
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
  // Tracks are stored bottom first: tracks[0] is the main track (under all
  // others). Every clip has a `start` on the timeline; on a magnetic track the
  // starts follow from the order (no gaps).
  const sources = new Map(); // id -> source
  let tracks = [];
  let clips = [];            // the main track's clips (alias of tracks[0].clips)
  let selectedId = null;
  let selectedTrackId = null;
  let clipboard = null;
  let undoStack = [];
  let redoStack = [];
  let muteAll = false;
  let playhead = 0;
  let playing = false;
  let pps = 60; // timeline pixels per second
  let exporting = false;
  let saveEnabled = false;     // true while a project is open in this tab and may be saved

  const newTrack = (main) => ({ id: 't' + (++uid), main: !!main, magnetic: !!main, hidden: false, opacity: 1, muted: false, volume: 1, clips: [] });
  const clipLen = (c) => c.out - c.in;
  const clipEnd = (c) => c.start + clipLen(c);
  const allClips = () => tracks.flatMap((t) => t.clips);
  function layoutTrack(tr) {
    if (tr.magnetic) {
      let s = 0;
      for (const c of tr.clips) { c.start = s; s += clipLen(c); }
    } else {
      for (const c of tr.clips) if (!(c.start >= 0)) c.start = 0;
      tr.clips.sort((a, b) => a.start - b.start);
    }
  }
  const relayout = () => tracks.forEach(layoutTrack);
  function setTracks(t) {
    tracks = t;
    if (!tracks.length || !tracks[0].main) tracks.unshift(newTrack(true));
    clips = tracks[0].clips;
    relayout();
  }
  setTracks([newTrack(true)]);

  const totalDuration = () => { let m = 0; for (const t of tracks) for (const c of t.clips) m = Math.max(m, clipEnd(c)); return m; };
  const srcOf = (clip) => (clip && clip.srcId ? sources.get(clip.srcId) : null);

  function clipAtTrack(tr, t) {
    for (let i = 0; i < tr.clips.length; i++) {
      const c = tr.clips[i];
      if (t >= c.start - 1e-6 && t < clipEnd(c) - 1e-6) return { idx: i, offset: t - c.start, start: c.start, clip: c };
    }
    return { idx: -1, offset: 0, start: 0, clip: null };
  }
  const clipAt = (t) => clipAtTrack(tracks[0], t);
  function findClip(id) {
    if (!id) return null;
    for (let ti = 0; ti < tracks.length; ti++) {
      const idx = tracks[ti].clips.findIndex((c) => c.id === id);
      if (idx >= 0) return { tr: tracks[ti], ti, idx, clip: tracks[ti].clips[idx] };
    }
    return null;
  }
  const findTrack = (id) => tracks.find((t) => t.id === id) || null;
  const selClip = () => { const f = findClip(selectedId); return f ? f.clip : null; };

  // The project is saved automatically; only warn if leaving would lose work.
  window.addEventListener('beforeunload', (e) => {
    const unsaved = exporting || [...sources.values()].some((s) => s.storage === 'none');
    if (allClips().length && unsaved) { e.preventDefault(); e.returnValue = ''; }
  });

  // ---------------------------------------------------------------------------
  // Screens
  // ---------------------------------------------------------------------------
  function showStart() {
    pause();
    $('startScreen').hidden = false;
    $('editorScreen').hidden = true;
    renderProjectList();
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

  const pickAndAdd = async (overlay) => { const list = await pickFiles(true); if (list.length) handleFiles(list, { overlay: overlay === true }); };
  const addMenu = $('addMenu');
  const closeAddMenu = () => { addMenu.style.display = 'none'; };
  document.addEventListener('click', (e) => { if (!e.target.closest('.add-wrap')) closeAddMenu(); });
  drop.addEventListener('click', () => pickAndAdd());
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickAndAdd(); } });
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('drag'); }));
  drop.addEventListener('drop', async (e) => { e.stopPropagation(); handleFiles(await fromDataTransfer(e.dataTransfer)); });
  $('addBtn').addEventListener('click', () => { addMenu.style.display = addMenu.style.display === 'none' ? 'block' : 'none'; });
  $('addMediaItem').addEventListener('click', () => { closeAddMenu(); pickAndAdd(); });
  $('addColorItem').addEventListener('click', () => { closeAddMenu(); addColorClip(); });
  $('addOverlayMediaItem').addEventListener('click', () => { closeAddMenu(); pickAndAdd(true); });
  $('addOverlayColorItem').addEventListener('click', () => { closeAddMenu(); addColorClip(true); });

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
  function handleFiles(list, opts = {}) {
    let entries = [...list].map((x) => (x instanceof File ? { file: x } : x));
    // Project files are imported as new projects.
    const projFiles = entries.filter((x) => isProjectFile(x.file.name));
    if (projFiles.length) {
      loadingQueue = loadingQueue.then(async () => { for (const pf of projFiles) await importProjectFile(pf.file); }).catch(() => {});
      entries = entries.filter((x) => !projFiles.includes(x));
      if (!entries.length) return;
    }
    const media = entries.filter((x) => isVideoFile(x.file) || isImageFile(x.file));
    if (!media.length) { if (entries.length) toast('Please choose videos (MP4, MOV, M4V) or images (JPG, PNG, WebP).'); return; }
    if (media.length < entries.length) toast('Some files were skipped because they are neither videos nor images.');
    // From the start screen, media always start a new project; in the editor they are added.
    const fresh = !$('startScreen').hidden || !projectId;
    loadingQueue = loadingQueue.then(async () => {
      if (fresh) await createProject(baseName(media[0].file.name) || '');
      for (const m of media) {
        const overlay = !!opts.overlay && !fresh;
        if (isImageFile(m.file) && !isVideoFile(m.file)) await addImage(m.file, m.handle, m.pasted, overlay);
        else await addFile(m.file, m.handle, m.pasted, overlay);
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

  async function addFile(file, handle, pasted, overlay) {
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

    const wasEmpty = allClips().length === 0;
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
      addClipToTimeline({ id: newId(), kind: 'video', srcId: src.id, in: src.rangeIn, out: src.rangeOut, muted: false }, overlay);
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

  async function addImage(file, handle, pasted, overlay) {
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
    const wasEmpty = allClips().length === 0;
    sources.set(src.id, src);
    saveEnabled = true;
    commit(() => { addClipToTimeline({ id: newId(), kind: 'image', srcId: src.id, in: 0, out: STILL_DURATION, muted: false }, overlay); });
    if (wasEmpty) { playhead = 0; onCanvasChange(); }
    showEditor();
    queueThumbs(src);
  }

  function addColorClip(overlay) {
    const wasEmpty = allClips().length === 0;
    saveEnabled = true;
    commit(() => {
      const nc = { id: newId(), kind: 'color', srcId: null, in: 0, out: STILL_DURATION, muted: false, color: DEFAULT_COLOR, size: '1920x1080', w: 1920, h: 1080 };
      addClipToTimeline(nc, overlay === true);
      selectedId = nc.id;
    });
    if (wasEmpty) playhead = 0;
    showEditor();
  }

  async function startEmptyCanvas() {
    await createProject('');
    canvasState = defaultCanvas();
    exportState.res = '1080';
    saveEnabled = true;
    commit(() => { addClipToTimeline({ id: newId(), kind: 'color', srcId: null, in: 0, out: STILL_DURATION, muted: false, color: DEFAULT_COLOR, size: '1920x1080', w: 1920, h: 1080 }); });
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
  // Undo / redo (snapshots of all tracks)
  // ---------------------------------------------------------------------------
  const snapshot = () => tracks.map((t) => ({ ...t, clips: t.clips.map((c) => ({ ...c })) }));
  function pushUndo(before) {
    undoStack.push(before);
    while (undoStack.length > settings.undoSteps) undoStack.shift();
    redoStack = [];
  }
  function commit(fn) {
    const before = snapshot();
    fn();
    pushUndo(before);
    afterEdit();
  }
  function undo() {
    if (!undoStack.length) return;
    redoStack.push(snapshot());
    setTracks(undoStack.pop());
    afterEdit();
  }
  function redo() {
    if (!redoStack.length) return;
    undoStack.push(snapshot());
    setTracks(redoStack.pop());
    afterEdit();
  }
  // The canvas follows the crop when its format is "Like a crop…".
  function syncCropCanvas() {
    if (canvasState.aspect !== 'crop') return;
    const c = cropClip();
    if (c) { canvasState.cropClipId = c.id; canvasState.cropSrcId = c.srcId; }
    syncCanvasUI();
    updateResolutionOptions();
    updatePreviewAspect();
  }
  // Empty overlay tracks disappear automatically.
  function pruneTracks() {
    const keep = tracks.filter((t, i) => i === 0 || t.clips.length);
    if (keep.length !== tracks.length) setTracks(keep);
  }
  function afterEdit() {
    relayout();
    pruneTracks();
    if (selectedId && !findClip(selectedId)) selectedId = null;
    if (selectedTrackId && !findTrack(selectedTrackId)) selectedTrackId = null;
    syncCropCanvas();
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
  const OVERLAY_TF = { fit: 'free', scale: 0.5 }; // new overlays: half size, centred

  // Does [start, start+len) collide with a clip of the track (ignoring one id)?
  function overlaps(tr, start, len, ignoreId) {
    return tr.clips.some((c) => c.id !== ignoreId && start < clipEnd(c) - 1e-6 && start + len > c.start + 1e-6);
  }

  /** Put a clip on the lowest overlay track that has room at `start`, or on a new track on top. */
  function placeOverlay(clip, start) {
    clip.start = Math.max(0, start);
    let tr = tracks.slice(1).find((t) => !t.magnetic && !overlaps(t, clip.start, clipLen(clip)));
    if (!tr) { tr = newTrack(false); tracks.push(tr); }
    tr.clips.push(clip);
    layoutTrack(tr);
    return tr;
  }

  /** Append to the main track (or put it as overlay at the playhead). */
  function addClipToTimeline(clip, overlay) {
    if (overlay && allClips().length) {
      clip.tf = { ...Render.tfOf(clip.tf), ...OVERLAY_TF };
      placeOverlay(clip, playhead);
      selectedId = clip.id;
      return;
    } else {
      const main = tracks[0];
      clip.start = main.clips.length ? Math.max(...main.clips.map(clipEnd)) : 0;
      main.clips.push(clip);
    }
  }

  // Clip to split: the selected one if the playhead is inside it, else the
  // main track's clip (or the topmost clip) under the playhead.
  function splitTarget() {
    const sel = findClip(selectedId);
    if (sel && playhead > sel.clip.start + EDGE && playhead < clipEnd(sel.clip) - EDGE) return sel;
    const order = [0, ...tracks.map((_, i) => i).slice(1).reverse()];
    for (const ti of order) {
      const a = clipAtTrack(tracks[ti], playhead);
      if (a.idx >= 0) return { tr: tracks[ti], ti, idx: a.idx, clip: a.clip };
    }
    return null;
  }
  function splitAtPlayhead() {
    const f = splitTarget();
    if (!f) { toast('Move the playhead over a clip to cut it.'); return; }
    const c = f.clip;
    const offset = playhead - c.start;
    if (offset < EDGE || offset > clipLen(c) - EDGE) { toast('Move the playhead inside a clip to cut it.'); return; }
    commit(() => {
      const left = { ...c, id: newId(), out: c.in + offset };
      const right = { ...c, id: newId(), in: c.in + offset, start: c.start + offset };
      f.tr.clips.splice(f.idx, 1, left, right);
      selectedId = right.id;
      if (canvasState.cropClipId === c.id) canvasState.cropClipId = left.id;
    });
  }
  function deleteSelected() {
    const f = findClip(selectedId);
    if (!f) { toast('Select a clip first.'); return; }
    commit(() => { f.tr.clips.splice(f.idx, 1); selectedId = null; });
  }
  function copySelected(silent) {
    const f = findClip(selectedId);
    if (!f) { toast('Select a clip first.'); return false; }
    const { id, ...rest } = f.clip;
    clipboard = { ...rest, fromMain: f.ti === 0 };
    if (!silent) toast('Clip copied — move the playhead and paste.');
    updateToolbar();
    return true;
  }
  function paste() {
    if (!clipboard) return;
    const { fromMain, ...data } = clipboard;
    const nc = { ...data, id: newId() };
    let insertTime = playhead;
    commit(() => {
      const main = tracks[0];
      if (fromMain && main.magnetic) {
        let insertAt = main.clips.length;
        insertTime = totalMain();
        const a = clipAt(playhead);
        if (a.idx >= 0) {
          const c = a.clip, len = clipLen(c);
          if (a.offset <= EDGE) { insertAt = a.idx; insertTime = a.start; } else if (a.offset >= len - EDGE) { insertAt = a.idx + 1; insertTime = a.start + len; } else {
            const left = { ...c, id: newId(), out: c.in + a.offset };
            const right = { ...c, id: newId(), in: c.in + a.offset };
            main.clips.splice(a.idx, 1, left, right);
            insertAt = a.idx + 1; insertTime = a.start + a.offset;
          }
        } else if (playhead <= 0) { insertAt = 0; insertTime = 0; }
        main.clips.splice(insertAt, 0, nc);
      } else if (fromMain && !overlaps(main, playhead, clipLen(nc))) {
        nc.start = playhead;
        main.clips.push(nc);
      } else {
        placeOverlay(nc, playhead);
      }
      selectedId = nc.id;
    });
    playhead = insertTime;
    seek(playhead);
  }
  const totalMain = () => (tracks[0].clips.length ? Math.max(...tracks[0].clips.map(clipEnd)) : 0);

  function toggleMuteClip() {
    let f = findClip(selectedId);
    if (!f) { const a = clipAt(playhead); if (a.idx >= 0) f = { tr: tracks[0], idx: a.idx, clip: a.clip }; }
    if (!f || !isVideoClip(f.clip)) return;
    commit(() => { f.tr.clips[f.idx] = { ...f.clip, muted: !f.clip.muted }; });
  }
  function updateSelected(patch) {
    const f = findClip(selectedId);
    if (!f) return;
    commit(() => { f.tr.clips[f.idx] = { ...f.clip, ...patch }; });
  }
  function toggleMuteAll() {
    muteAll = !muteAll;
    $('muteAllBtn').setAttribute('aria-pressed', String(muteAll));
    $('muteAllBtn').title = muteAll ? 'Unmute all audio' : 'Mute all audio';
    syncPool();
    updateEstimate();
    scheduleSave();
  }

  $('undoBtn').addEventListener('click', () => { if (undoStack.length) undo(); else toast('Nothing to undo.', 1500); });
  $('redoBtn').addEventListener('click', () => { if (redoStack.length) redo(); else toast('Nothing to redo.', 1500); });
  $('splitBtn').addEventListener('click', splitAtPlayhead);
  $('deleteBtn').addEventListener('click', deleteSelected);
  $('copyBtn').addEventListener('click', () => copySelected(false));
  $('cpClose').addEventListener('click', () => { selectedId = null; renderClips(); updateToolbar(); renderPreview(); });

  // Clip panel fields
  $('cpDuration').addEventListener('change', (e) => {
    const f = findClip(selectedId);
    if (!f || f.clip.kind === 'video') return;
    let d = clamp(parseFloat(e.target.value) || STILL_DURATION, 0.1, 3600);
    // On a free track a still can't grow into the next clip.
    const next = f.tr.clips[f.idx + 1];
    if (!f.tr.magnetic && next) d = Math.min(d, next.start - f.clip.start);
    updateSelected({ out: f.clip.in + d });
  });
  $('cpColor').addEventListener('input', (e) => {
    // Live preview without creating an undo step for every colour tick.
    const c = selClip();
    if (c && c.kind === 'color') { c.color = e.target.value; renderPreview(); renderClips(); }
  });
  // The colour picker previews live; the undo step is recorded once on 'change'.
  let clipColorBefore = null;
  const rememberColor = () => { const c = selClip(); clipColorBefore = c ? c.color : null; };
  $('cpColor').addEventListener('focus', rememberColor);
  $('cpColor').addEventListener('click', rememberColor);
  $('cpColor').addEventListener('change', (e) => {
    const c = selClip();
    if (!c || c.kind !== 'color') return;
    if (clipColorBefore) c.color = clipColorBefore; // so the undo snapshot holds the old colour
    clipColorBefore = null;
    updateSelected({ color: e.target.value });
  });
  $('cpSize').addEventListener('change', (e) => {
    const v = e.target.value;
    const c = selClip();
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
    const c = selClip();
    const panel = $('clipPanel');
    if (!c) { panel.hidden = true; updateTransformingClass(); updateTrackPanel(); return; }
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
    $('cpTabCrop').hidden = c.kind === 'color';
    if (cpTab === 'crop' && c.kind === 'color') showTab('clip');
    updateTransformingClass();
    syncTransformUI();
    if (c.kind === 'color') {
      $('cpColor').value = c.color || DEFAULT_COLOR;
      $('cpSize').value = c.size || 'custom';
      $('cpW').value = c.w || 1920;
      $('cpH').value = c.h || 1080;
    }
    updateTrackPanel();
  }
  $('pasteBtn').addEventListener('click', paste);
  $('muteClipBtn').addEventListener('click', toggleMuteClip);
  $('muteAllBtn').addEventListener('click', toggleMuteAll);

  function updateToolbar() {
    // Undo/redo stay clickable; they just look dimmed when there's nothing to do.
    $('undoBtn').classList.toggle('idle', !undoStack.length);
    $('redoBtn').classList.toggle('idle', !redoStack.length);
    $('splitBtn').disabled = !allClips().length;
    $('pasteBtn').disabled = !clipboard;
    const hasSel = !!findClip(selectedId);
    $('copyBtn').disabled = !hasSel;
    $('deleteBtn').disabled = !hasSel;
    // "Selected clip only" needs a selection.
    const selBtn = $('scopeToggle').querySelector('[data-scope="selected"]');
    selBtn.disabled = !hasSel;
    if (!hasSel && exportState.scope === 'selected') { exportState.scope = 'all'; syncExportUI(); updateEstimate(); }
    $('exportBtn').disabled = !exportClips().length || exporting;
    if (exportState.scope === 'selected') updateEstimate();
    updateClipPanel();
  }

  // ---------------------------------------------------------------------------
  // Track panel (opacity, volume, magnetic, order, delete)
  // ---------------------------------------------------------------------------
  const trackLabel = (tr) => (tr.main ? 'Main track' : `Track ${tracks.indexOf(tr) + 1}`);
  function updateTrackPanel() {
    const tr = findTrack(selectedTrackId);
    const panel = $('trackPanel');
    if (!tr || findClip(selectedId)) { panel.hidden = true; return; }
    panel.hidden = false;
    const ti = tracks.indexOf(tr);
    $('tpTitle').textContent = trackLabel(tr);
    if (document.activeElement !== $('tpOpacity')) $('tpOpacity').value = Math.round(tr.opacity * 100);
    $('tpOpacityVal').textContent = Math.round(tr.opacity * 100) + '%';
    if (document.activeElement !== $('tpVolume')) $('tpVolume').value = Math.round(tr.volume * 100);
    $('tpVolumeVal').textContent = Math.round(tr.volume * 100) + '%';
    $('tpMagneticRow').hidden = !tr.main;
    $('tpMagnetic').checked = !!tr.magnetic;
    $('tpUp').disabled = tr.main || ti >= tracks.length - 1;
    $('tpDown').disabled = tr.main || ti <= 1;
    $('tpDelete').hidden = tr.main;
  }
  // Track edits from sliders are live; one undo step per slider move.
  let trackLiveBefore = null;
  function trackLive(prop, value) {
    const tr = findTrack(selectedTrackId);
    if (!tr) return;
    if (!trackLiveBefore) trackLiveBefore = snapshot();
    tr[prop] = value;
    renderTrackHeads();
    syncPool();
    renderPreview();
    updateTrackPanel();
  }
  function trackLiveCommit() {
    if (!trackLiveBefore) return;
    pushUndo(trackLiveBefore);
    trackLiveBefore = null;
    afterEdit();
  }
  $('tpOpacity').addEventListener('input', (e) => trackLive('opacity', e.target.value / 100));
  $('tpOpacity').addEventListener('change', trackLiveCommit);
  $('tpVolume').addEventListener('input', (e) => trackLive('volume', e.target.value / 100));
  $('tpVolume').addEventListener('change', trackLiveCommit);
  $('tpMagnetic').addEventListener('change', (e) => {
    const tr = findTrack(selectedTrackId);
    if (!tr) return;
    commit(() => {
      // Back to magnetic: keep the order of the clips, close the gaps.
      if (e.target.checked) tr.clips.sort((a, b) => a.start - b.start);
      tr.magnetic = e.target.checked;
    });
    toast(e.target.checked ? 'Main track is magnetic again — gaps are closed.' : 'Main track released — clips can be placed freely.');
  });
  function moveTrack(dir) {
    const tr = findTrack(selectedTrackId);
    if (!tr || tr.main) return;
    const i = tracks.indexOf(tr), j = i + dir;
    if (j < 1 || j >= tracks.length) return;
    commit(() => { tracks.splice(i, 1); tracks.splice(j, 0, tr); });
  }
  $('tpUp').addEventListener('click', () => moveTrack(1));
  $('tpDown').addEventListener('click', () => moveTrack(-1));
  $('tpDelete').addEventListener('click', () => {
    const tr = findTrack(selectedTrackId);
    if (!tr || tr.main) return;
    if (tr.clips.length && !confirm(`Delete ${trackLabel(tr)} with its ${tr.clips.length} clip${tr.clips.length === 1 ? '' : 's'}?`)) return;
    commit(() => { tracks.splice(tracks.indexOf(tr), 1); selectedTrackId = null; });
  });
  $('tpClose').addEventListener('click', () => { selectedTrackId = null; renderTrackHeads(); updateClipPanel(); });

  // ---------------------------------------------------------------------------
  // Timeline rendering (one row per track, the top track first)
  // ---------------------------------------------------------------------------
  const timeline = $('timeline');
  const tlInner = $('tlInner');
  const tlRuler = $('tlRuler');
  const tlRows = $('tlRows');
  const trackHeads = $('trackHeads');
  const MAX_WIDTH = 80000;
  const RULER_H = 24;
  const rowH = (tr) => (tr.main ? 66 : isCoarse ? 46 : 50);

  const pad = () => timeline.clientWidth / 2;
  function clampPps(v) {
    const total = Math.max(0.5, totalDuration());
    return clamp(v, Math.max(2, (timeline.clientWidth * 0.5) / total), Math.min(600, MAX_WIDTH / total));
  }
  let ppsUserSet = false;
  let lastTrackCount = 0;

  function renderTimeline() {
    if ($('editorScreen').hidden) return;
    const total = totalDuration();
    if (!ppsUserSet && total > 0) pps = clamp(timeline.clientWidth / total, 4, 160);
    pps = clampPps(pps);
    const p = pad();
    tlInner.style.width = (p * 2 + total * pps) + 'px';
    // Playhead in the middle of the visible clip area (scrollbars change its width).
    $('playheadLine').style.left = (timeline.offsetLeft + timeline.clientWidth / 2) + 'px';
    // Height: show `settings.rows` tracks before scrolling vertically.
    const shown = tracks.slice(0, settings.rows);
    const maxH = RULER_H + shown.reduce((s, t) => s + rowH(t), 0) + 6;
    timeline.style.maxHeight = maxH + 'px';
    trackHeads.style.maxHeight = maxH + 'px';

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
    renderTrackHeads();
    // New tracks: keep the main track in view.
    if (tracks.length !== lastTrackCount) { timeline.scrollTop = timeline.scrollHeight; lastTrackCount = tracks.length; }
    syncScroll();
    updateToolbar();
    updateTime();
    updatePreviewAspect();
    const vids2 = allClips().filter(isVideoClip);
    $('stutterHint').hidden = vids2.length < 2;
    $('perfHint').hidden = maxConcurrentVideos() < 3;
    $('previewEmpty').hidden = allClips().length > 0;
  }

  // Most video clips playing at the same moment (for the performance hint).
  function maxConcurrentVideos() {
    const ev = [];
    for (const tr of tracks) for (const c of tr.clips) if (isVideoClip(c)) { ev.push([c.start, 1]); ev.push([clipEnd(c), -1]); }
    ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let cur = 0, max = 0;
    for (const [, d] of ev) { cur += d; max = Math.max(max, cur); }
    return max;
  }

  const MUTE_SVG = '<svg viewBox="0 0 24 24"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/></svg>';
  const EYE_SVG = '<svg viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF_SVG = '<svg viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7c2 0 3.7.6 5.1 1.5M22 12s-3.5 7-10 7c-2 0-3.7-.6-5.1-1.5"/><path d="M4 20L20 4"/></svg>';
  const SOUND_SVG = '<svg viewBox="0 0 24 24"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M16 9a4 4 0 010 6"/></svg>';

  function clipElement(c, tr, i) {
    const len = clipLen(c);
    const src = srcOf(c);
    const p = pad();
    const el = document.createElement('div');
    el.className = 'clip' + (c.id === selectedId ? ' selected' : '') + (c.kind === 'color' ? ' color-clip' : '') + (tr.main ? '' : ' overlay');
    if (c.kind === 'color') el.style.background = c.color || DEFAULT_COLOR;
    el.dataset.id = c.id;
    el.dataset.idx = i;
    const w = Math.max(3, len * pps - 2);
    const h = rowH(tr) - 4;
    el.style.left = (p + c.start * pps + 1) + 'px';
    el.style.width = w + 'px';
    el.style.height = h + 'px';
    if (src && src.thumbs.length) {
      const tw = Math.round((h - 4) * (src.thumbAspect || 16 / 9));
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
    return el;
  }

  function renderClips() {
    if ($('editorScreen').hidden) return;
    const frag = document.createDocumentFragment();
    for (let ti = tracks.length - 1; ti >= 0; ti--) {
      const tr = tracks[ti];
      const row = document.createElement('div');
      row.className = 'tl-row' + (tr.main ? ' main' : '') + (tr.hidden ? ' is-hidden' : '') + (tr.id === selectedTrackId ? ' track-selected' : '');
      row.dataset.track = tr.id;
      row.style.height = rowH(tr) + 'px';
      tr.clips.forEach((c, i) => row.appendChild(clipElement(c, tr, i)));
      frag.appendChild(row);
    }
    tlRows.replaceChildren(frag);
  }

  function renderTrackHeads() {
    const frag = document.createDocumentFragment();
    const spacer = document.createElement('div');
    spacer.className = 'th-spacer';
    spacer.style.height = RULER_H + 'px';
    frag.appendChild(spacer);
    for (let ti = tracks.length - 1; ti >= 0; ti--) {
      const tr = tracks[ti];
      const h = document.createElement('div');
      h.className = 'track-head' + (tr.id === selectedTrackId ? ' selected' : '') + (tr.main ? ' main' : '');
      h.style.height = rowH(tr) + 'px';
      h.dataset.track = tr.id;
      h.title = `${trackLabel(tr)} — tap for opacity, volume and more`;
      const eye = document.createElement('button');
      eye.type = 'button';
      eye.className = 'th-btn' + (tr.hidden ? ' off' : '');
      eye.dataset.act = 'eye';
      eye.title = tr.hidden ? 'Show track' : 'Hide track';
      eye.innerHTML = tr.hidden ? EYE_OFF_SVG : EYE_SVG;
      const snd = document.createElement('button');
      snd.type = 'button';
      snd.className = 'th-btn' + (tr.muted ? ' off' : '');
      snd.dataset.act = 'mute';
      snd.title = tr.muted ? 'Unmute track' : 'Mute track';
      snd.innerHTML = tr.muted ? MUTE_SVG : SOUND_SVG;
      h.append(eye, snd);
      frag.appendChild(h);
    }
    trackHeads.replaceChildren(frag);
    trackHeads.scrollTop = timeline.scrollTop;
  }

  trackHeads.addEventListener('click', (e) => {
    const head = e.target.closest('.track-head');
    if (!head) return;
    const tr = findTrack(head.dataset.track);
    if (!tr) return;
    const act = e.target.closest('.th-btn');
    if (act) {
      const prop = act.dataset.act === 'eye' ? 'hidden' : 'muted';
      commit(() => { tr[prop] = !tr[prop]; });
      return;
    }
    selectedTrackId = selectedTrackId === tr.id ? null : tr.id;
    selectedId = null;
    renderClips();
    renderTrackHeads();
    updateToolbar();
    renderPreview();
  });

  // Keep scroll position and playhead in sync (playhead fixed at the centre).
  let expectedScroll = -1;
  let lastScrollLeft = 0;
  function syncScroll() {
    const target = Math.round(playhead * pps);
    expectedScroll = target;
    timeline.scrollLeft = target;
    lastScrollLeft = timeline.scrollLeft;
  }
  let scrollRaf = 0;
  timeline.addEventListener('scroll', () => {
    trackHeads.scrollTop = timeline.scrollTop;
    if (drag) return;
    if (timeline.scrollLeft === lastScrollLeft) return; // vertical scrolling only
    lastScrollLeft = timeline.scrollLeft;
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
  // Clip selection and dragging (only the selected clip can be dragged):
  // sideways = reorder (magnetic main track) or move in time (free tracks),
  // up/down = move to another track; above the top track = new track.
  // ---------------------------------------------------------------------------
  let drag = null;
  let suppressClick = false;

  tlRows.addEventListener('click', (e) => {
    if (suppressClick) { suppressClick = false; return; }
    const el = e.target.closest('.clip');
    selectedId = el ? (selectedId === el.dataset.id ? null : el.dataset.id) : null;
    if (selectedId) selectedTrackId = null;
    renderClips();
    renderTrackHeads();
    updateToolbar();
    if (selectedId && cpTab !== 'clip') ensureVisible();
    renderPreview();
  });

  tlRows.addEventListener('pointerdown', (e) => {
    const el = e.target.closest('.clip');
    if (!el || e.button > 0 || el.dataset.id !== selectedId) return;
    drag = { el, id: el.dataset.id, startX: e.clientX, startY: e.clientY, pointerId: e.pointerId, active: false, marker: null, raf: 0, lastX: e.clientX, lastY: e.clientY, target: null };
  });

  window.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const dx = e.clientX - drag.startX, dy = e.clientY - drag.startY;
    if (!drag.active) {
      if (Math.hypot(dx, dy) < 6) return;
      drag.active = true;
      drag.el.classList.add('dragging');
      try { drag.el.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      drag.origLeft = parseFloat(drag.el.style.left);
      drag.scroll0 = timeline.scrollLeft;
      drag.marker = document.createElement('div');
      drag.marker.className = 'drop-marker';
      drag.marker.hidden = true;
      tlRows.appendChild(drag.marker);
      autoScroll();
    }
    drag.lastX = e.clientX;
    drag.lastY = e.clientY;
    positionDrag();
  });

  // Track row under a screen y (null above the top row = new track).
  function rowAtY(y) {
    const rows = [...tlRows.querySelectorAll('.tl-row')];
    for (const r of rows) { const b = r.getBoundingClientRect(); if (y >= b.top && y < b.bottom) return r; }
    if (rows.length && y < rows[0].getBoundingClientRect().top) return null;
    return rows[rows.length - 1] || null;
  }

  function positionDrag() {
    const f = findClip(drag.id);
    if (!f) return;
    const dx = drag.lastX - drag.startX + (timeline.scrollLeft - drag.scroll0);
    drag.el.style.left = (drag.origLeft + dx) + 'px';
    drag.el.style.transform = `translateY(${drag.lastY - drag.startY}px)`;
    const row = rowAtY(drag.lastY);
    const tr = row ? findTrack(row.dataset.track) : null;
    drag.target = tr ? tr.id : 'new';
    const rect = timeline.getBoundingClientRect();
    const time = (drag.lastX - rect.left + timeline.scrollLeft - pad()) / pps;
    drag.time = Math.max(0, f.clip.start + dx / pps);
    if (tr && tr.magnetic) {
      // Insert position between the other clips of the magnetic track.
      const others = tr.clips.filter((c) => c.id !== drag.id);
      let idx = 0;
      for (const c of others) if (time > c.start + clipLen(c) / 2) idx++;
      drag.dropIdx = idx;
      let boundary = 0;
      for (let i = 0; i < idx; i++) boundary += clipLen(others[i]);
      const rb = row.getBoundingClientRect(), pb = tlRows.getBoundingClientRect();
      drag.marker.hidden = false;
      drag.marker.style.left = (pad() + boundary * pps - 1) + 'px';
      drag.marker.style.top = (rb.top - pb.top) + 'px';
      drag.marker.style.height = rb.height + 'px';
    } else {
      drag.marker.hidden = true;
      // Snap the start to the playhead and to edges of other clips (8 px).
      const thr = 8 / pps;
      let best = null;
      const len = clipLen(f.clip);
      const cands = [playhead, 0];
      for (const c of allClips()) if (c.id !== drag.id) cands.push(c.start, clipEnd(c));
      for (const cnd of cands) {
        for (const [edge, off] of [[drag.time, 0], [drag.time + len, len]]) {
          const d = Math.abs(edge - cnd);
          if (d < thr && (!best || d < best.d)) best = { d, t: cnd - off };
        }
      }
      if (best) drag.time = Math.max(0, best.t);
    }
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
    const f = findClip(d.id);
    if (!f) { renderTimeline(); return; }
    const sameTrack = d.target === f.tr.id;
    if (sameTrack && f.tr.magnetic && d.dropIdx === f.idx) { renderTimeline(); return; }
    if (sameTrack && !f.tr.magnetic && Math.abs(d.time - f.clip.start) < 1e-3) { renderTimeline(); return; }
    commit(() => {
      const c = f.clip;
      f.tr.clips.splice(f.idx, 1);
      let tr = d.target === 'new' ? null : findTrack(d.target);
      if (!tr) { tr = newTrack(false); tracks.push(tr); }
      if (tr.magnetic) {
        tr.clips.splice(clamp(d.dropIdx, 0, tr.clips.length), 0, c);
      } else {
        c.start = d.time;
        if (overlaps(tr, c.start, clipLen(c), c.id)) {
          // No room here: put it on a new track right above.
          const nt = newTrack(false);
          tracks.splice(tracks.indexOf(tr) + 1, 0, nt);
          tr = nt;
        }
        tr.clips.push(c);
      }
      selectedId = c.id;
    });
  }
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);

  // ---------------------------------------------------------------------------
  // Preview (a canvas draws the composition exactly like the export). A pool
  // of <video> elements supplies frames and sound: one per video clip playing
  // right now, plus the clips starting soon (preloaded). A wall clock drives
  // the playhead; it waits while a playing video is still buffering.
  // ---------------------------------------------------------------------------
  const vids = [$('vidA'), $('vidB')];
  const POOL_MAX = 8;
  const PRELOAD = 1.5; // seconds ahead
  function poolElement() {
    if (vids.length >= POOL_MAX) return null;
    const v = vids[0].cloneNode(false);
    v.removeAttribute('id');
    v.removeAttribute('src');
    vids[0].parentNode.insertBefore(v, vids[vids.length - 1].nextSibling);
    vids.push(v);
    hookVideo(v);
    return v;
  }
  const pv = $('pvCanvas');
  const pvCtx = pv.getContext('2d', { alpha: false });
  let clock = { t0: 0, ph0: 0 };
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
  const elOf = (clipId) => vids.find((v) => v.dataset.clip === clipId) || null;

  // The time shown: at the very end the last frame stays visible.
  const viewTime = () => { const tot = totalDuration(); return playhead >= tot - 1e-6 ? Math.max(0, tot - 1e-3) : playhead; };

  // Video clips playing at time t (with their track), bottom track first.
  function activeVideos(t) {
    const out = [];
    for (const tr of tracks) {
      const a = clipAtTrack(tr, t);
      if (a.idx >= 0 && playableVideo(a.clip)) out.push({ tr, clip: a.clip });
    }
    return out;
  }

  /**
   * Give every playing and upcoming video clip an element, keep the playing
   * ones in sync with the playhead and set their sound.
   * forceTime: re-position the playing elements (after a seek).
   */
  function syncPool(forceTime) {
    const t = viewTime();
    const active = activeVideos(t);
    const upcoming = [];
    if (playing) {
      for (const tr of tracks) for (const c of tr.clips) {
        if (playableVideo(c) && c.start > t + 1e-6 && c.start <= t + PRELOAD) upcoming.push({ tr, clip: c });
      }
      upcoming.sort((a, b) => a.clip.start - b.clip.start);
    }
    const wanted = [...active, ...upcoming];
    const ids = new Set(wanted.map((w) => w.clip.id));
    const used = new Set();
    for (const w of wanted) { const el = elOf(w.clip.id); if (el) { used.add(el); w.el = el; } }
    for (const w of wanted) {
      if (w.el) continue;
      const free = vids.filter((v) => !used.has(v) && !ids.has(v.dataset.clip));
      const src = srcOf(w.clip);
      let el = free.find((v) => v.dataset.src === src.id) || free.find((v) => !v.dataset.clip) || free[0] || poolElement();
      if (!el) continue; // more videos at once than elements: this one isn't shown
      used.add(el);
      w.el = el;
      w.fresh = true;
    }
    // Elements nobody needs right now pause.
    vids.forEach((v) => { if (!used.has(v)) { if (!v.paused) v.pause(); v.muted = true; } });
    const activeIds = new Set(active.map((a) => a.clip.id));
    for (const w of wanted) {
      const { el, clip, tr } = w;
      if (!el) continue;
      const isActive = activeIds.has(clip.id);
      const target = isActive ? clip.in + (t - clip.start) : clip.in;
      if (w.fresh) loadInto(el, clip, target);
      else if (isActive && (forceTime || Math.abs(mediaTime(el) - target) > (playing ? 0.25 : 0.01))) setVideoTime(el, Math.max(0, target - srcOf(clip).base));
      el.muted = !isActive || muteAll || !!clip.muted || tr.muted || tr.volume <= 0;
      el.volume = clamp(tr.volume, 0, 1);
      if (isActive && playing) {
        if (el.paused) el.play().catch((err) => { if (err && err.name === 'NotAllowedError') { el.muted = true; el.play().catch(() => {}); } });
      } else if (!el.paused) el.pause();
    }
    return active.map((a) => ({ ...a, el: elOf(a.clip.id) }));
  }

  function resetVideos() {
    vids.forEach((v) => { v.pause(); v.removeAttribute('src'); delete v.dataset.src; delete v.dataset.url; delete v.dataset.clip; v.load(); });
  }

  function seek(t, fromScroll) {
    playhead = clamp(t, 0, totalDuration());
    clock = { t0: performance.now(), ph0: playhead };
    if (!allClips().length) resetVideos();
    else syncPool(true);
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
    if (!el.paused) return; // already playing in this gesture
    const t = el.currentTime;
    el.muted = true;
    el.play().then(() => {
      const active = playing && activeVideos(viewTime()).some((a) => a.clip.id === el.dataset.clip);
      if (!active) { el.pause(); el.currentTime = t; }
      syncPool();
    }).catch(() => {});
  }

  function play() {
    if (!allClips().length) return;
    if (playhead >= totalDuration() - 0.03) seek(0);
    // Make sure a few elements exist so they can be unlocked in this gesture.
    while (vids.length < 4 && poolElement());
    playing = true;
    setPlayIcon();
    clock = { t0: performance.now(), ph0: playhead };
    syncPool(true);
    vids.forEach(unlock);
    requestAnimationFrame(tick);
  }
  function pause() {
    if (!playing) return;
    playing = false;
    vids.forEach((v) => v.pause());
    setPlayIcon();
    syncPool();
  }
  $('playBtn').addEventListener('click', () => (playing ? pause() : play()));

  function tick() {
    if (!playing) return;
    const now = performance.now();
    const total = totalDuration();
    // Wait while a playing video is still loading, so pictures and sound stay together.
    const act = activeVideos(viewTime());
    const waiting = act.some((a) => { const el = elOf(a.clip.id); return el && (el.seeking || el.readyState < 3); });
    if (waiting) clock = { t0: now, ph0: playhead };
    else playhead = Math.min(total, clock.ph0 + (now - clock.t0) / 1000);
    if (playhead >= total - 1e-4) {
      playhead = total;
      pause();
      syncScroll();
      updateTime();
      renderPreview();
      return;
    }
    syncPool();
    syncScroll();
    updateTime();
    renderPreview();
    requestAnimationFrame(tick);
  }

  function frameStep(dir) {
    if (!allClips().length) return;
    pause();
    const v = activeVideos(viewTime())[0];
    const src = v ? srcOf(v.clip) : null;
    seek(playhead + dir / (src ? src.frameRate : 30));
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
  // Clip whose crop defines the canvas ("Like a crop…"). Clip ids change when a clip
  // is split or an edit is undone, so fall back to a clip of the same media.
  function cropClip() {
    if (canvasState.aspect !== 'crop') return null;
    const cands = allClips().filter((c) => c.kind !== 'color');
    return cands.find((c) => c.id === canvasState.cropClipId) || cands.find((c) => c.srcId === canvasState.cropSrcId) || cands[0] || null;
  }
  // Pixel size of a clip's crop (display space; 90° rotations swap width and height).
  function cropPixels(c) {
    const d = srcDims(c);
    const t = Render.tfOf(c.tf);
    let w = d.w * t.crop.w, h = d.h * t.crop.h;
    if (Math.round(Math.abs(t.rot) / 90) % 2 === 1) [w, h] = [h, w];
    return { w: Math.max(2, Math.round(w)), h: Math.max(2, Math.round(h)) };
  }
  function canvasAspect() {
    const a = canvasState.aspect;
    if (ASPECTS[a]) return ASPECTS[a];
    if (a === 'custom') return clamp((canvasState.ratioW || 1) / (canvasState.ratioH || 1), 0.1, 10);
    if (a === 'crop') {
      const c = cropClip();
      if (c) { const p = cropPixels(c); return p.w / p.h; }
      return 16 / 9;
    }
    const v = aspectVideo();
    if (v) { const d = Render.displaySize(v); return d.w / d.h; }
    return 16 / 9;
  }

  function syncCanvasUI() {
    $('aspectSel').value = canvasState.aspect;
    $('aspectCustomField').hidden = canvasState.aspect !== 'custom';
    $('aspectVideoField').hidden = canvasState.aspect !== 'video';
    $('aspectCropField').hidden = canvasState.aspect !== 'crop';
    const cc = cropClip();
    const csel = $('aspectCropSel');
    const cands = [];
    tracks.forEach((tr, ti) => tr.clips.forEach((c, i) => { if (c.kind !== 'color') cands.push({ c, label: tracks.length > 1 ? `${ti === 0 ? 'Main' : 'Track ' + (ti + 1)} · clip ${i + 1}` : `Clip ${i + 1}` }); }));
    csel.replaceChildren(...(cands.length ? cands.map(({ c, label }) => {
      const p = cropPixels(c);
      const s = srcOf(c);
      return Object.assign(document.createElement('option'), { value: c.id, textContent: `${label} · ${s ? s.name : ''} · ${even(p.w)}×${even(p.h)}` });
    }) : [Object.assign(document.createElement('option'), { value: '', textContent: 'No video or image — using 16:9' })]));
    if (cc) csel.value = cc.id;
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
    if (canvasState.aspect === 'crop') { setCropCanvas(selClip() && selClip().kind !== 'color' ? selClip() : cropClip()); exportState.res = 'crop'; }
    onCanvasChange();
  });
  $('aspectVideoSel').addEventListener('change', (e) => { canvasState.videoSrcId = e.target.value || null; onCanvasChange(); });
  function setCropCanvas(c) {
    canvasState.aspect = 'crop';
    canvasState.cropClipId = c ? c.id : null;
    canvasState.cropSrcId = c ? c.srcId : null;
  }
  $('aspectCropSel').addEventListener('change', (e) => {
    setCropCanvas(allClips().find((c) => c.id === e.target.value));
    exportState.res = 'crop';
    onCanvasChange();
  });
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
    // Limit the width by the maximum height so the box always keeps the canvas ratio.
    preview.style.maxWidth = `calc(var(--pv-h) * ${a})`;
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
    const mode = editMode();
    pv.classList.toggle('editing', mode === 'move');
    pv.classList.toggle('cropping', mode === 'crop');
    const out = outputDims();
    const t = viewTime();
    const sel = selClip();
    if (mode === 'crop') {
      const d = currentDrawable(sel, out.w, out.h);
      if (d) drawCropMode(sel, d, W, H);
      return;
    }
    const layers = [];
    let selLayer = null;
    for (let ti = 0; ti < tracks.length; ti++) {
      const tr = tracks[ti];
      if (tr.hidden || tr.opacity <= 0) continue;
      const a = clipAtTrack(tr, t);
      if (a.idx < 0) continue;
      const d = currentDrawable(a.clip, out.w, out.h);
      if (!d) {
        if (playableVideo(a.clip) && elOf(a.clip.id)) return; // keep the last frame while seeking
        continue;
      }
      const l = { drawable: d.drawable, w: d.w, h: d.h, rot: 0, tf: a.clip.tf, opacity: tr.opacity, isMain: ti === 0, isColor: d.isColor };
      if (sel && a.clip.id === sel.id) selLayer = { clip: a.clip, d };
      layers.push(l);
    }
    Render.composite(pvCtx, W, H, layers, canvasState.bg === 'blur' ? 'blur' : 'bars', bg);
    if (mode === 'move' && selLayer) drawMoveOverlay(selLayer.clip, selLayer.d, W, H, dpr);
  }

  // Preview <video> elements are already rotated by the browser, so rotation 0 here.
  function currentDrawable(clip, outW, outH) {
    if (!clip) return null;
    if (isVideoClip(clip)) {
      const el = elOf(clip.id);
      if (!el || el.readyState < 2 || !el.videoWidth) return null;
      return { drawable: el, w: el.videoWidth, h: el.videoHeight, isColor: false };
    }
    return stillFor(clip, outW, outH);
  }

  function hookVideo(v) {
    v.addEventListener('seeked', () => { if (!playing) renderPreview(); });
    v.addEventListener('loadeddata', () => { if (!playing) renderPreview(); });
    v.addEventListener('error', async () => {
      if (!v.getAttribute('src') || !v.dataset.clip) return;
      const src = sources.get(v.dataset.src);
      if (src && !(await isReadable(src))) { lostAccess([src]); return; }
      toast('This browser can\'t preview this video, but exporting may still work.', 5000);
    });
  }
  vids.forEach(hookVideo);

  // ---------------------------------------------------------------------------
  // Clip transform: crop, position & size, rotation (clip panel tabs + preview gestures)
  // ---------------------------------------------------------------------------
  let cpTab = 'clip';
  const ACCENT = '#4f8cff';

  // The preview is interactive only while a transform tab is open and the selected clip is the visible one.
  function editMode() {
    const f = findClip(selectedId);
    if (!f || cpTab === 'clip' || playing || f.tr.hidden) return null;
    const c = f.clip;
    const t = viewTime();
    if (t < c.start - 1e-6 || t >= clipEnd(c) - 1e-6) return null;
    if (cpTab === 'crop') return c.kind === 'color' ? null : 'crop';
    return 'move';
  }

  // Move the playhead into the selected clip so it can be edited in the preview.
  function ensureVisible() {
    const c = selClip();
    if (!c) return;
    const st = c.start, len = clipLen(c);
    if (playhead < st || playhead >= st + len - 1e-3) { pause(); seek(st + Math.min(0.05, len / 2)); }
  }

  // Display size of a clip's picture (before crop).
  function srcDims(c) {
    if (c.kind === 'color') { const o = outputDims(); return colorDims(c, o.w, o.h); }
    const s = srcOf(c);
    if (!s) return { w: 16, h: 9 };
    return c.kind === 'video' ? Render.displaySize(s) : { w: s.width, h: s.height };
  }
  function layoutFor(c, W, H, tf) {
    const d = srcDims(c);
    const t = Render.tfOf(tf || c.tf);
    return Render.clipLayout(d.w * t.crop.w, d.h * t.crop.h, W, H, t);
  }
  // Size relative to "fit" (1 = fit), whatever the size mode is.
  function effectiveScale(c) {
    const o = outputDims();
    const g = layoutFor(c, o.w, o.h);
    return g.s / g.fitS;
  }

  // Live edits (drags, sliders) change the clip directly; one undo step is recorded at the end.
  let liveBefore = null;
  function liveEdit(patch) {
    const f = findClip(selectedId);
    if (!f) return;
    if (!liveBefore) liveBefore = snapshot();
    const c = f.clip;
    f.tr.clips[f.idx] = { ...c, tf: { ...Render.tfOf(c.tf), ...patch } };
    renderPreview();
    syncTransformUI();
  }
  function liveCommit() {
    if (!liveBefore) return;
    pushUndo(liveBefore);
    liveBefore = null;
    syncCropCanvas();
    updateEstimate();
    updateToolbar();
    scheduleSave();
  }
  function setTf(patch) {
    const c = selClip();
    if (!c) return;
    liveCommit();
    updateSelected({ tf: { ...Render.tfOf(c.tf), ...patch } });
  }

  function syncTransformUI() {
    const c = selClip();
    if (!c) return;
    const t = Render.tfOf(c.tf);
    $('anchorGrid').querySelectorAll('button').forEach((b) => {
      const on = b.dataset.anchor === t.anchor;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', String(on));
      b.setAttribute('role', 'radio');
    });
    $('fitToggle').querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.fit === t.fit));
    const pct = Math.round(effectiveScale(c) * 100);
    if (document.activeElement !== $('scaleRange')) $('scaleRange').value = clamp(pct, 10, 400);
    $('scaleVal').textContent = pct + '%';
    if (document.activeElement !== $('rotRange')) $('rotRange').value = Math.round(t.rot);
    $('rotVal').textContent = Math.round(t.rot) + '°';
    $('flipHBtn').classList.toggle('on', t.flipH);
    $('flipVBtn').classList.toggle('on', t.flipV);
    $('cropPresets').querySelectorAll('.btn-chip').forEach((b) => b.classList.toggle('active', b.dataset.ratio === (t.cropRatio || 'free')));
  }

  function showTab(tab) {
    const c = selClip();
    if (tab === 'crop' && c && c.kind === 'color') tab = 'clip';
    cpTab = tab;
    $('cpTabs').querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('#clipPanel .cp-pane').forEach((p) => { p.hidden = p.dataset.pane !== tab; });
    updateTransformingClass();
  }
  // On phones the preview sticks to the top while a transform tab is open.
  function updateTransformingClass() {
    const on = !$('clipPanel').hidden && cpTab !== 'clip';
    if (document.body.classList.contains('transforming') !== on) {
      document.body.classList.toggle('transforming', on);
      requestAnimationFrame(renderPreview);
    }
  }
  $('cpTabs').addEventListener('click', (e) => {
    const b = e.target.closest('.seg-btn');
    if (!b) return;
    showTab(b.dataset.tab);
    if (cpTab !== 'clip') ensureVisible();
    syncTransformUI();
    renderPreview();
  });

  // Position: anchor grid, nudging, size
  $('anchorGrid').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    ensureVisible();
    setTf({ anchor: b.dataset.anchor, dx: 0, dy: 0 });
  });
  let nudgeTimer = 0;
  $('nudgePad').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    const c = selClip();
    if (!b || !c) return;
    ensureVisible();
    if (b.dataset.nudge === 'reset') { setTf({ dx: 0, dy: 0 }); return; }
    const [x, y] = b.dataset.nudge.split(',').map(Number);
    const t = Render.tfOf(c.tf);
    const step = 0.005; // 0.5 % of the canvas per tap
    liveEdit({ dx: t.dx + x * step, dy: t.dy + y * step });
    clearTimeout(nudgeTimer);
    nudgeTimer = setTimeout(liveCommit, 700); // a series of taps is one undo step
  });
  $('fitToggle').addEventListener('click', (e) => {
    const b = e.target.closest('.seg-btn');
    const c = selClip();
    if (!b || !c) return;
    ensureVisible();
    if (b.dataset.fit === 'free') setTf({ fit: 'free', scale: effectiveScale(c) });
    else setTf({ fit: b.dataset.fit });
  });
  $('scaleRange').addEventListener('input', (e) => { ensureVisible(); liveEdit({ fit: 'free', scale: e.target.value / 100 }); });
  $('scaleRange').addEventListener('change', liveCommit);
  $('snapChk').checked = store.get('snap', true);
  if (isCoarse) document.querySelector('.hint-inline').hidden = true;
  $('snapChk').addEventListener('change', (e) => store.set('snap', e.target.checked));

  // Rotate & flip
  const normAngle = (a) => { a = ((a + 180) % 360 + 360) % 360 - 180; return a === -180 ? 180 : a; };
  $('rotLeftBtn').addEventListener('click', () => { const c = selClip(); if (!c) return; ensureVisible(); setTf({ rot: normAngle(Render.tfOf(c.tf).rot - 90) }); });
  $('rotRightBtn').addEventListener('click', () => { const c = selClip(); if (!c) return; ensureVisible(); setTf({ rot: normAngle(Render.tfOf(c.tf).rot + 90) }); });
  $('flipHBtn').addEventListener('click', () => { const c = selClip(); if (!c) return; ensureVisible(); setTf({ flipH: !Render.tfOf(c.tf).flipH }); });
  $('flipVBtn').addEventListener('click', () => { const c = selClip(); if (!c) return; ensureVisible(); setTf({ flipV: !Render.tfOf(c.tf).flipV }); });
  $('rotRange').addEventListener('input', (e) => {
    ensureVisible();
    let a = Number(e.target.value);
    if (Math.abs(a) < 2) a = 0; // easy to get back to straight
    liveEdit({ rot: a });
  });
  $('rotRange').addEventListener('change', liveCommit);
  $('rotReset').addEventListener('click', () => { ensureVisible(); setTf({ rot: 0, flipH: false, flipV: false }); });

  // Crop presets
  const RATIOS = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:5': 4 / 5, '4:3': 4 / 3 };
  const ratioValue = (key) => (key === 'canvas' ? canvasAspect() : RATIOS[key] || null);
  function centeredCrop(c, ratio) {
    const d = srcDims(c);
    const a = d.w / d.h;
    let w = 1, h = 1;
    if (ratio > a) h = a / ratio; else w = ratio / a;
    return { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
  }
  $('cropPresets').addEventListener('click', (e) => {
    const b = e.target.closest('.btn-chip');
    const c = selClip();
    if (!b || !c) return;
    ensureVisible();
    const key = b.dataset.ratio;
    if (key === 'free') { setTf({ cropRatio: null }); return; }
    setTf({ crop: centeredCrop(c, ratioValue(key)), cropRatio: key });
  });
  $('cropAsCanvas').addEventListener('click', () => {
    const c = selClip();
    if (!c || c.kind === 'color') return;
    setCropCanvas(c);
    exportState.res = 'crop';
    // Let the clip fill the new canvas exactly.
    const t = Render.tfOf(c.tf);
    if (t.fit !== 'fit' || t.anchor !== 'c' || t.dx || t.dy) setTf({ fit: 'fit', anchor: 'c', dx: 0, dy: 0 });
    onCanvasChange();
    const p = cropPixels(c);
    toast(`Canvas set to the crop: ${even(p.w)}×${even(p.h)}.`);
  });
  $('cropReset').addEventListener('click', () => { ensureVisible(); setTf({ crop: { x: 0, y: 0, w: 1, h: 1 }, cropRatio: null }); });

  // --- Overlays ---------------------------------------------------------------
  let snapGuides = null; // { x: [...], y: [...] } in preview pixels

  function drawMoveOverlay(clip, d, W, H, dpr) {
    const t = Render.tfOf(clip.tf);
    const g = Render.clipLayout(d.w * t.crop.w, d.h * t.crop.h, W, H, t);
    pvCtx.save();
    pvCtx.translate(g.cx, g.cy);
    pvCtx.rotate(g.rad);
    pvCtx.lineWidth = 2 * dpr;
    pvCtx.setLineDash([7 * dpr, 5 * dpr]);
    pvCtx.strokeStyle = 'rgba(0,0,0,.6)';
    pvCtx.strokeRect(-g.dw / 2, -g.dh / 2, g.dw, g.dh);
    pvCtx.lineDashOffset = 6 * dpr;
    pvCtx.strokeStyle = ACCENT;
    pvCtx.strokeRect(-g.dw / 2, -g.dh / 2, g.dw, g.dh);
    pvCtx.setLineDash([]);
    pvCtx.fillStyle = ACCENT;
    pvCtx.beginPath();
    pvCtx.arc(0, 0, 4 * dpr, 0, Math.PI * 2);
    pvCtx.fill();
    pvCtx.restore();
    if (snapGuides) {
      pvCtx.save();
      pvCtx.strokeStyle = '#ff4fd8';
      pvCtx.lineWidth = 1.5 * dpr;
      for (const x of snapGuides.x) { pvCtx.beginPath(); pvCtx.moveTo(x, 0); pvCtx.lineTo(x, H); pvCtx.stroke(); }
      for (const y of snapGuides.y) { pvCtx.beginPath(); pvCtx.moveTo(0, y); pvCtx.lineTo(W, y); pvCtx.stroke(); }
      pvCtx.restore();
    }
  }

  // Crop mode shows the whole picture with the crop frame on top.
  function cropGeom(d, W, H) {
    const s0 = Math.min(W / d.w, H / d.h) * 0.9;
    const fw = d.w * s0, fh = d.h * s0;
    return { s0, fw, fh, ox: (W - fw) / 2, oy: (H - fh) / 2 };
  }
  function cropRectPx(t, cg) {
    return { x: cg.ox + t.crop.x * cg.fw, y: cg.oy + t.crop.y * cg.fh, w: t.crop.w * cg.fw, h: t.crop.h * cg.fh };
  }
  function drawCropMode(clip, d, W, H) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const t = Render.tfOf(clip.tf);
    const cg = cropGeom(d, W, H);
    pvCtx.save();
    pvCtx.fillStyle = '#0d0d0d';
    pvCtx.fillRect(0, 0, W, H);
    pvCtx.drawImage(d.drawable, cg.ox, cg.oy, cg.fw, cg.fh);
    const r = cropRectPx(t, cg);
    pvCtx.fillStyle = 'rgba(0,0,0,.6)';
    pvCtx.beginPath();
    pvCtx.rect(cg.ox, cg.oy, cg.fw, cg.fh);
    pvCtx.rect(r.x, r.y, r.w, r.h);
    pvCtx.fill('evenodd');
    pvCtx.strokeStyle = 'rgba(255,255,255,.35)';
    pvCtx.lineWidth = 1 * dpr;
    for (let k = 1; k < 3; k++) {
      pvCtx.beginPath(); pvCtx.moveTo(r.x + r.w * k / 3, r.y); pvCtx.lineTo(r.x + r.w * k / 3, r.y + r.h); pvCtx.stroke();
      pvCtx.beginPath(); pvCtx.moveTo(r.x, r.y + r.h * k / 3); pvCtx.lineTo(r.x + r.w, r.y + r.h * k / 3); pvCtx.stroke();
    }
    pvCtx.strokeStyle = '#fff';
    pvCtx.lineWidth = 2 * dpr;
    pvCtx.strokeRect(r.x, r.y, r.w, r.h);
    pvCtx.fillStyle = ACCENT;
    const hs = 12 * dpr;
    for (const h of cropHandles(r, !!t.cropRatio)) pvCtx.fillRect(h.x - hs / 2, h.y - hs / 2, hs, hs);
    pvCtx.restore();
  }
  function cropHandles(r, locked) {
    const hs = [
      { k: 'nw', x: r.x, y: r.y }, { k: 'ne', x: r.x + r.w, y: r.y },
      { k: 'sw', x: r.x, y: r.y + r.h }, { k: 'se', x: r.x + r.w, y: r.y + r.h },
    ];
    if (!locked) {
      hs.push({ k: 'n', x: r.x + r.w / 2, y: r.y }, { k: 's', x: r.x + r.w / 2, y: r.y + r.h },
        { k: 'w', x: r.x, y: r.y + r.h / 2 }, { k: 'e', x: r.x + r.w, y: r.y + r.h / 2 });
    }
    return hs;
  }

  // --- Preview gestures -----------------------------------------------------
  const pointers = new Map();
  let gesture = null;
  function pvPoint(e) {
    const r = pv.getBoundingClientRect();
    return { x: (e.clientX - r.left) * pv.width / r.width, y: (e.clientY - r.top) * pv.height / r.height };
  }
  const pdist = () => { const [a, b] = [...pointers.values()]; return Math.hypot(a.x - b.x, a.y - b.y) || 1; };

  pv.addEventListener('pointerdown', (e) => {
    const mode = editMode();
    if (!mode) return;
    e.preventDefault();
    try { pv.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    const p = pvPoint(e);
    pointers.set(e.pointerId, p);
    const c = selClip();
    const t = Render.tfOf(c.tf);
    if (mode === 'move') {
      if (pointers.size === 2) gesture = { type: 'pinch', d0: pdist(), s0: effectiveScale(c) };
      else if (pointers.size === 1) gesture = { type: 'move', start: p, dx0: t.dx, dy0: t.dy };
      return;
    }
    // crop
    if (pointers.size > 1) return;
    const d = srcDims(c);
    const cg = cropGeom(d, pv.width, pv.height);
    const r = cropRectPx(t, cg);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const hit = cropHandles(r, !!t.cropRatio).find((h) => Math.abs(h.x - p.x) < 18 * dpr && Math.abs(h.y - p.y) < 18 * dpr);
    const inside = p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h;
    if (!hit && !inside) return;
    gesture = { type: 'crop', handle: hit ? hit.k : 'move', start: p, crop0: { ...t.crop }, cg, d, ratio: t.cropRatio ? ratioValue(t.cropRatio) : null };
  });

  pv.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    const p = pvPoint(e);
    pointers.set(e.pointerId, p);
    if (!gesture) return;
    const c = selClip();
    if (!c) return;
    const W = pv.width, H = pv.height;
    if (gesture.type === 'pinch' && pointers.size === 2) {
      liveEdit({ fit: 'free', scale: clamp(gesture.s0 * pdist() / gesture.d0, 0.05, 10) });
    } else if (gesture.type === 'move' && pointers.size === 1) {
      let dx = gesture.dx0 + (p.x - gesture.start.x) / W;
      let dy = gesture.dy0 + (p.y - gesture.start.y) / H;
      snapGuides = null;
      if ($('snapChk').checked && !e.altKey) {
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const thr = 10 * dpr;
        const g = layoutFor(c, W, H, { ...Render.tfOf(c.tf), dx, dy });
        const guides = { x: [], y: [] };
        const snap1 = (pos, half, size) => {
          const cands = [[pos - size / 2, size / 2], [pos - half, 0], [pos + half - size, size]];
          let best = null;
          for (const [diff, line] of cands) if (Math.abs(diff) < thr && (!best || Math.abs(diff) < Math.abs(best[0]))) best = [diff, line];
          return best;
        };
        const sx = snap1(g.cx, g.bbW / 2, W);
        if (sx) { dx -= sx[0] / W; guides.x.push(sx[1]); }
        const sy = snap1(g.cy, g.bbH / 2, H);
        if (sy) { dy -= sy[0] / H; guides.y.push(sy[1]); }
        if (guides.x.length || guides.y.length) snapGuides = guides;
      }
      liveEdit({ dx, dy });
    } else if (gesture.type === 'crop') {
      const { cg, crop0, d } = gesture;
      const du = (p.x - gesture.start.x) / cg.fw;
      const dv = (p.y - gesture.start.y) / cg.fh;
      const MIN = 0.05;
      let { x, y, w, h } = crop0;
      if (gesture.handle === 'move') {
        x = clamp(crop0.x + du, 0, 1 - w);
        y = clamp(crop0.y + dv, 0, 1 - h);
      } else {
        let l = crop0.x, r = crop0.x + crop0.w, t = crop0.y, b = crop0.y + crop0.h;
        const k = gesture.handle;
        if (k.includes('w')) l = clamp(l + du, 0, r - MIN);
        if (k.includes('e')) r = clamp(r + du, l + MIN, 1);
        if (k.includes('n')) t = clamp(t + dv, 0, b - MIN);
        if (k.includes('s')) b = clamp(b + dv, t + MIN, 1);
        if (gesture.ratio) {
          // Keep the preset's ratio: width leads, height follows (anchored at the opposite corner).
          const toH = (ww) => (ww * d.w) / (gesture.ratio * d.h);
          const toW = (hh) => (hh * gesture.ratio * d.h) / d.w;
          let ww = r - l;
          let hh = toH(ww);
          const maxH = k.includes('n') ? b : 1 - t;
          if (hh > maxH) { hh = maxH; ww = toW(hh); }
          if (k.includes('w')) l = r - ww; else r = l + ww;
          if (k.includes('n')) t = b - hh; else b = t + hh;
        }
        x = l; y = t; w = r - l; h = b - t;
      }
      liveEdit({ crop: { x, y, w, h } });
    }
  });

  function endGesture(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (pointers.size === 1 && gesture && gesture.type === 'pinch') {
      // Continue as a move with the remaining finger.
      const [p] = pointers.values();
      const t = Render.tfOf((selClip() || {}).tf);
      gesture = { type: 'move', start: p, dx0: t.dx, dy0: t.dy };
      return;
    }
    if (pointers.size) return;
    gesture = null;
    snapGuides = null;
    liveCommit();
    renderPreview();
  }
  pv.addEventListener('pointerup', endGesture);
  pv.addEventListener('pointercancel', endGesture);

  let wheelTimer = 0;
  pv.addEventListener('wheel', (e) => {
    if (editMode() !== 'move') return;
    e.preventDefault();
    const c = selClip();
    liveEdit({ fit: 'free', scale: clamp(effectiveScale(c) * Math.exp(-e.deltaY * 0.0015), 0.05, 10) });
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(liveCommit, 400);
  }, { passive: false });

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
  // File names that work on Windows, macOS, Linux, Android (FAT/exFAT) and iOS.
  function cleanFileName(n) {
    let s = String(n || '').normalize('NFC')
      .replace(/[\x00-\x1f\x7f<>:"/\\|?*]+/g, '_')   // forbidden on Windows/FAT (/ and : on macOS too)
      .replace(/\s+/g, ' ').trim()
      .replace(/\.mp4$/i, '')
      .replace(/^[.\s]+/, '')                       // leading dot = hidden file on macOS/Linux
      .replace(/[.\s]+$/, '');                      // trailing dots/spaces aren't allowed on Windows
    if (s.length > 120) s = s.slice(0, 120).replace(/[.\s]+$/, '');
    if (/^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i.test(s)) s += '_'; // reserved names on Windows
    return s;
  }
  // File name of the video: empty = follow the project name.
  let exportName = '';
  const nameBase = () => exportName || cleanFileName(projectName) || 'video';
  const exportFileName = () => nameBase() + (exportState.scope === 'selected' ? '_clip' : '');
  function syncFileName() {
    if (document.activeElement !== $('fileNameInput')) $('fileNameInput').value = exportFileName();
  }
  $('fileNameInput').addEventListener('change', (e) => {
    let v = cleanFileName(e.target.value);
    if (exportState.scope === 'selected') v = v.replace(/_clip$/, '');
    exportName = v && v !== cleanFileName(projectName) ? v : '';
    e.target.value = exportFileName();
    scheduleSave();
  });

  const exportDefaults = () => ({ scope: 'all', res: '1080', resW: 1920, resH: 1080, quality: 'standard', bitrateMbps: 5, targetMB: 25, lockRes: false, fps: '30', codec: 'avc' });
  let exportState = Object.assign(exportDefaults(), store.get('export2', {}));

  function resolutionOptions() {
    const a = canvasAspect();
    const land = a >= 1;
    const dims = (short) => (land ? { w: even(short * a), h: short } : { w: short, h: even(short / a) });
    const opts = [];
    if (canvasState.aspect === 'crop') {
      const c = cropClip();
      if (c) { const p = cropPixels(c); opts.push({ key: 'crop', label: `Crop size · ${even(p.w)}×${even(p.h)}`, w: even(p.w), h: even(p.h) }); }
    }
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
    $('scopeToggle').querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.scope === exportState.scope));
    syncFileName();
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
  $('scopeToggle').addEventListener('click', (e) => {
    const b = e.target.closest('.seg-btn');
    if (!b) return;
    exportState.scope = b.dataset.scope;
    store.set('export2', exportState);
    syncExportUI();
    updateEstimate();
    updateToolbar();
    scheduleSave();
  });
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

  // Clips that go into the export: the whole timeline or only the selected clip.
  function exportClips() {
    if (exportState.scope !== 'selected') return allClips();
    const c = selClip();
    return c ? [c] : [];
  }
  const exportDuration = () => (exportState.scope === 'selected' ? (selClip() ? clipLen(selClip()) : 0) : totalDuration());
  // Is a clip's sound part of the export?
  function audibleClip(c) {
    if (muteAll || !isVideoClip(c) || c.muted || !srcOf(c) || !srcOf(c).audioDecodable) return false;
    if (exportState.scope === 'selected') return true;
    const f = findClip(c.id);
    return !f || (!f.tr.muted && f.tr.volume > 0);
  }
  const usedSources = () => [...new Set(exportClips().map((c) => srcOf(c)).filter(Boolean))];

  function sourceBytes() {
    return exportClips().reduce((sum, c) => {
      const s = srcOf(c);
      return s && s.kind === 'video' && s.file ? sum + ((c.out - c.in) / Math.max(0.01, s.fileDuration)) * s.file.size : sum;
    }, 0);
  }

  function updateEstimate() {
    if (exportState.scope === 'selected' && !exportClips().length) { $('estimate').textContent = 'Select a clip on the timeline to export only that clip.'; return; }
    if (!allClips().length) { $('estimate').textContent = ''; return; }
    const s = getExportSettings();
    const used = usedSources();
    const list = exportClips();
    const dur = exportDuration();
    const out = Render.computeOutput(s, used, dur);
    const withAudio = list.some(audibleClip);
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
    if (!exportClips().length || exporting) return;
    pause();
    const unreadable = await unreadableSources();
    if (unreadable.length) { lostAccess(unreadable); return; }
    exporting = true;
    fileNameAtStart = exportFileName();
    setCreateButton(0);
    updateToolbar();
    $('resultBox').hidden = true;
    $('progressBox').hidden = false;
    $('progressFill').style.width = '0%';
    $('progressLabel').textContent = 'Preparing…';
    abortCtl = new AbortController();
    try { if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { wakeLock = null; }

    const s = getExportSettings();
    // Clip times are in media time; the export reads the actual (possibly trimmed-copy) file.
    const scopeSelected = exportState.scope === 'selected';
    const expClip = (c, start) => {
      if (isVideoClip(c)) { const src = srcOf(c); return { kind: 'video', source: src, start, in: c.in - src.base, out: c.out - src.base, muted: c.muted, tf: c.tf }; }
      return { kind: c.kind, source: srcOf(c) || null, start, in: c.in, out: c.out, muted: true, still: stillFor(c, s.width, s.height), tf: c.tf };
    };
    const sel = selClip();
    const expTracks = scopeSelected && sel
      ? [{ hidden: false, opacity: 1, muted: false, volume: 1, clips: [expClip(sel, 0)] }]
      : tracks.map((tr) => ({ hidden: tr.hidden, opacity: tr.opacity, muted: tr.muted, volume: tr.volume, clips: tr.clips.map((c) => expClip(c, c.start)) }));
    const duration = exportDuration();
    const t0 = performance.now();
    try {
      const r = await Render.exportTimeline({
        tracks: expTracks,
        duration,
        settings: s,
        signal: abortCtl.signal,
        onProgress: (f, stage) => {
          $('progressFill').style.width = (f * 100).toFixed(1) + '%';
          const el = (performance.now() - t0) / 1000;
          const eta = f > 0.03 ? el / f - el : null;
          const label = stage === 'audio' ? 'Encoding audio' : stage === 'finalizing' ? 'Writing file' : 'Encoding video';
          $('progressLabel').textContent = `${label}… ${Math.floor(f * 100)}%${eta !== null && stage !== 'finalizing' ? ' · ~' + fmtTime(eta, false) + ' left' : ''}`;
          setCreateButton(f);
        },
      });
      showResult(r, scopeSelected);
      exportDone = $('exportModal').hidden;
      if ($('exportModal').hidden) toast('Your video is ready — tap "Video ready" to download it.', 5000);
    } catch (e) {
      if (e && e.name === 'AbortError') toast('Export cancelled.');
      else if (e && e.name === 'NotReadableError') { const u = await unreadableSources(); if (u.length) lostAccess(u); else toast('Export failed: a video couldn\'t be read.', 7000); }
      else { console.error(e); toast('Export failed: ' + (e && e.message ? e.message : e), 7000); }
    } finally {
      exporting = false;
      abortCtl = null;
      $('progressBox').hidden = true;
      if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
      setCreateButton(null);
      updateToolbar();
    }
  }
  $('exportBtn').addEventListener('click', doExport);

  // The button in the editor opens the export window and shows the progress.
  let fileNameAtStart = '';
  let exportDone = false; // a finished video waits in the closed window
  function setCreateButton(f) {
    const btn = $('openExportBtn');
    const busy = f !== null && exporting;
    btn.classList.toggle('busy', busy);
    btn.style.setProperty('--p', busy ? (f * 100).toFixed(1) + '%' : '0%');
    const ready = !busy && exportDone && $('exportModal').hidden;
    btn.classList.toggle('ready', ready);
    $('openExportLabel').textContent = busy ? `Creating video… ${Math.floor(f * 100)} %` : ready ? 'Video ready — download…' : 'Create video…';
  }
  function openExport() {
    if (!allClips().length && !exporting) { toast('Add a video, an image or a color clip first.'); return; }
    pause();
    syncExportUI();
    updateEstimate();
    openModal('exportModal');
    exportDone = false;
    setCreateButton(exporting ? parseFloat($('progressFill').style.width) / 100 || 0 : null);
  }
  function closeExport() {
    if (document.activeElement === $('fileNameInput')) $('fileNameInput').dispatchEvent(new Event('change'));
    closeModal('exportModal');
    if (exporting) setCreateButton(parseFloat($('progressFill').style.width) / 100 || 0);
  }
  $('openExportBtn').addEventListener('click', openExport);
  $('exportCloseBtn').addEventListener('click', closeExport);
  $('exportModal').addEventListener('click', (e) => { if (e.target.id === 'exportModal') closeExport(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('exportModal').hidden) { closeExport(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'e' && !$('editorScreen').hidden && $('exportModal').hidden
      && !document.querySelector('.modal-bg:not([hidden])')) { e.preventDefault(); openExport(); }
  });
  $('fileNameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } });
  $('cancelExportBtn').addEventListener('click', () => { if (abortCtl) abortCtl.abort(); });

  function showResult(r, onlyClip) {
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    const name = `${fileNameAtStart || exportFileName()}.mp4`;
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
    if (!saveEnabled || !projectId) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 400);
  }

  function referencedIds() {
    const ids = new Set();
    const add = (list) => list.forEach((tr) => tr.clips.forEach((c) => { if (c.srcId) ids.add(c.srcId); }));
    add(tracks);
    undoStack.forEach(add);
    redoStack.forEach(add);
    if (clipboard && clipboard.srcId) ids.add(clipboard.srcId);
    return ids;
  }

  function disposeSource(src) {
    if (src.url) URL.revokeObjectURL(src.url);
    src.thumbs.forEach((u) => u && URL.revokeObjectURL(u));
    if (src.bitmap) src.bitmap.close();
  }

  // Drop media that nothing (timeline, undo/redo, clipboard) refers to anymore.
  // Working copies are only deleted if no other project uses them.
  function cleanupMedia() {
    const used = referencedIds();
    for (const src of [...sources.values()]) {
      if (used.has(src.id)) continue;
      if (src.storage === 'opfs' && src.copyName) Project.releaseCopy(src.copyName);
      if (src.storage === 'handle') Project.removeHandle(src.id);
      disposeSource(src);
      sources.delete(src.id);
    }
  }

  // Small cover image for the project list (first clip).
  let thumbCache = { key: '', data: '' };
  async function projectThumb() {
    const c = tracks[0].clips[0] || allClips()[0];
    if (!c) return '';
    const src = srcOf(c);
    const key = `${c.id}|${c.color || ''}|${src && src.thumbs[0] ? src.thumbs[0] : ''}`;
    if (key === thumbCache.key) return thumbCache.data;
    const cv = document.createElement('canvas');
    cv.width = 160; cv.height = 90;
    const x = cv.getContext('2d');
    x.fillStyle = canvasState.bgColor || DEFAULT_COLOR;
    x.fillRect(0, 0, 160, 90);
    if (c.kind === 'color') {
      x.fillStyle = c.color || DEFAULT_COLOR;
      x.fillRect(0, 0, 160, 90);
    } else if (src && src.thumbs[0]) {
      const img = new Image();
      img.src = src.thumbs[0];
      try { await img.decode(); } catch (e) { return thumbCache.data; }
      const s = Math.max(160 / img.width, 90 / img.height);
      x.drawImage(img, (160 - img.width * s) / 2, (90 - img.height * s) / 2, img.width * s, img.height * s);
    } else {
      return thumbCache.data;
    }
    thumbCache = { key, data: cv.toDataURL('image/jpeg', 0.7) };
    return thumbCache.data;
  }

  let projectSaved = false; // a document exists for the open project
  async function saveNow() {
    if (!saveEnabled || !projectId) return;
    if (!allClips().length && !projectSaved) return; // don't create empty projects
    cleanupMedia();
    const id = projectId;
    const doc = {
      id,
      name: projectName,
      createdAt: projectCreated,
      version: 3,
      app: VERSION,
      savedAt: Date.now(),
      playhead,
      muteAll,
      canvas: { ...canvasState },
      export: { ...exportState },
      exportName,
      // Bottom track first; tracks[0] is the main track.
      tracks: tracks.map((t) => ({ ...t, kind: t.main ? 'main' : 'video', clips: t.clips.map((c) => ({ ...c })) })),
      media: [...sources.values()].map(mediaMeta),
      thumb: await projectThumb().catch(() => ''),
    };
    if (id !== projectId || !saveEnabled) return; // project closed meanwhile
    await Project.saveProject(doc);
    projectSaved = true;
    if (bc) bc.postMessage({ type: 'saved', id });
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden && saveEnabled) { clearTimeout(saveTimer); saveNow(); } });

  async function isReadable(src) {
    if (!src || !src.file) return false;
    try { await src.file.slice(0, 16).arrayBuffer(); return true; } catch (e) { return false; }
  }
  async function unreadableSources() {
    // Images are decoded into memory when loaded, only videos are read during export.
    const used = [...new Set(exportClips().filter(isVideoClip).map((c) => srcOf(c)).filter(Boolean))];
    const out = [];
    for (const s of used) if (s.missing || !(await isReadable(s))) out.push(s);
    return out;
  }

  function projectSummary(p) {
    let count = 0, dur = 0;
    (p.tracks || []).forEach((t, i) => {
      let s = 0;
      for (const c of t.clips || []) {
        const len = c.out - c.in;
        const st = (t.magnetic !== undefined ? t.magnetic : i === 0) ? s : (c.start || 0);
        s = st + len;
        dur = Math.max(dur, st + len);
        count++;
      }
    });
    return { count, dur, media: (p.media || []).length };
  }

  // ---------------------------------------------------------------------------
  // Project library: open / create / close, one project per tab
  // ---------------------------------------------------------------------------
  let projectId = null;
  let projectName = '';
  let projectCreated = 0;
  let lockRelease = null;
  const bc = 'BroadcastChannel' in window ? new BroadcastChannel('videcutto') : null;

  const hashId = () => { const m = /[#&]p=([a-z0-9]+)/i.exec(location.hash); return m ? m[1] : null; };
  function setHash(id) {
    const url = id ? `${location.pathname}${location.search}#p=${id}` : `${location.pathname}${location.search}`;
    history.replaceState(null, '', url);
  }

  function syncProjectBar() {
    $('projectName').value = projectName;
    document.title = projectId && projectName ? `${projectName} · Videcutto` : 'Videcutto';
  }
  $('projectName').addEventListener('change', (e) => {
    const v = e.target.value.trim();
    if (v) projectName = v;
    syncProjectBar();
    if (projectSaved) saveNow(); else scheduleSave();
  });
  $('projectName').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });

  // Web Locks make sure a project is edited in only one tab at a time.
  async function acquireLock(id, fresh) {
    if (!navigator.locks) return true;
    const name = 'videcutto-project-' + id;
    const take = (opts) => new Promise((resolve) => {
      navigator.locks.request(name, opts, (lock) => {
        if (!lock) { resolve(false); return undefined; }
        resolve(true);
        return new Promise((r) => { lockRelease = r; });
      }).catch(() => resolve(false));
    });
    if (await take({ ifAvailable: true })) return true;
    if (fresh) return true;
    if (!confirm('This project is open in another tab. Continue editing it here? The other tab will stop editing it.')) return false;
    if (bc) bc.postMessage({ type: 'takeover', id });
    await take({ steal: true });
    return true;
  }
  function releaseLock() { if (lockRelease) { lockRelease(); lockRelease = null; } }

  function onTakenOver() {
    saveEnabled = false;
    clearTimeout(saveTimer);
    pause();
    lockRelease = null;
    document.querySelectorAll('.modal-bg').forEach((m) => { m.hidden = true; });
    openModal('takeoverModal');
  }
  $('takeoverBackBtn').addEventListener('click', async () => {
    closeModal('takeoverModal');
    await closeProject(true);
    showStart();
  });
  if (bc) {
    bc.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === 'takeover' && m.id === projectId) onTakenOver();
      if ((m.type === 'saved' || m.type === 'changed') && !$('startScreen').hidden) renderProjectList();
    };
  }

  function resetState() {
    setTracks([newTrack(true)]);
    exportName = ''; exportDone = false;
    $('resultBox').hidden = true;
    $('exportModal').hidden = true;
    setCreateButton(null);
    undoStack = []; redoStack = []; clipboard = null; selectedId = null; selectedTrackId = null; playhead = 0;
    for (const src of sources.values()) disposeSource(src);
    sources.clear();
    canvasState = defaultCanvas();
    muteAll = false;
    $('muteAllBtn').setAttribute('aria-pressed', 'false');
    thumbCache = { key: '', data: '' };
    $('resultBox').hidden = true;
    syncCanvasUI();
    syncExportUI();
    seek(0);
    updateToolbar();
  }

  /** Close the open project (saving it first unless skipSave). */
  async function closeProject(skipSave) {
    if (abortCtl) abortCtl.abort(); // a running export belongs to this project
    if (projectId && saveEnabled && !skipSave) { clearTimeout(saveTimer); await saveNow(); }
    pause();
    clearTimeout(saveTimer);
    saveEnabled = false;
    releaseLock();
    resetState();
    projectId = null;
    projectName = '';
    projectSaved = false;
    Project.setCurrent(null);
    setHash(null);
    syncProjectBar();
  }

  async function createProject(name) {
    await closeProject();
    const docs = await Project.listProjects();
    projectId = Project.newId();
    Project.setCurrent(projectId);
    projectName = name || `Project ${docs.length + 1}`;
    projectCreated = Date.now();
    projectSaved = false;
    await acquireLock(projectId, true);
    setHash(projectId);
    saveEnabled = true;
    syncProjectBar();
  }

  async function openProject(id) {
    if (id === projectId) { showEditor(); return; }
    const doc = await Project.loadProject(id);
    if (!doc) { toast('This project doesn\'t exist anymore.'); setHash(projectId); return; }
    await closeProject();
    if (!(await acquireLock(id))) { showStart(); return; }
    projectId = id;
    Project.setCurrent(id);
    projectName = doc.name || 'Project';
    projectCreated = doc.createdAt || doc.savedAt || Date.now();
    projectSaved = true;
    setHash(id);
    syncProjectBar();
    await restoreProject(doc);
  }

  const baseName = (n) => String(n || '').replace(/\.[^.]+$/, '');

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
    const tl = (p.tracks && p.tracks.length ? p.tracks : [{ clips: [] }]);
    tl.forEach((t) => { if (t.id) bump(t.id); (t.clips || []).forEach((c) => bump(c.id)); });
    uid = Math.max(uid, maxId);
    // Projects before 0.8 have one track without track settings.
    setTracks(tl.map((t, i) => ({
      ...newTrack(i === 0),
      ...(t.id ? { id: t.id } : {}),
      magnetic: t.magnetic !== undefined ? !!t.magnetic : i === 0,
      hidden: !!t.hidden,
      opacity: t.opacity != null ? clamp(+t.opacity, 0, 1) : 1,
      muted: !!t.muted,
      volume: t.volume != null ? clamp(+t.volume, 0, 1) : 1,
      clips: (t.clips || []).map((c) => ({ ...c, kind: c.kind || 'video' })),
    })).filter((t, i) => i === 0 || t.clips.length));
    undoStack = []; redoStack = []; clipboard = null; selectedId = null; selectedTrackId = null;
    exportName = cleanFileName(p.exportName || '');
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
      await closeProject(true);
      showStart();
    }
  }

  /**
   * Replace a media's file (relink): the clips keep their cuts. Keeps a working
   * copy on phones, otherwise links the handle; frees the previous copy.
   */
  async function replaceMedia(m, old, file, handle) {
    showBusy(m.kind === 'image' ? 'Opening image…' : 'Opening video…', file.name);
    try {
      const src = await attach(m, file, 0, { storage: handle ? 'handle' : 'none', copyName: null });
      if (old) { src.thumbs = old.thumbs; src.thumbStep = old.thumbStep; src.thumbAspect = old.thumbAspect; if (old.url) URL.revokeObjectURL(old.url); }
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
      if (src.storage !== 'handle') Project.removeHandle(src.id);
      if (old && old.storage === 'opfs' && old.copyName && old.copyName !== src.copyName) {
        Project.releaseCopy(old.copyName);
      }
      sources.set(src.id, src);
      vids.forEach((v) => { if (v.dataset.src === src.id) delete v.dataset.url; });
      scheduleSave();
      return src;
    } catch (err) {
      toast(err.message || String(err), 6000);
      return null;
    } finally {
      hideBusy();
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
    const ok = await openRelink(entries.filter((e) => allClips().some((c) => c.srcId === e.meta.id) || !e.src), 'edit');
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
        $('relinkDoneBtn').disabled = open.length > 0 || !allClips().length;
      };

      const assign = async (e, file, handle) => {
        const src = await replaceMedia(e.meta, e.old, file, handle);
        if (src) e.src = src;
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
        const keep = (list) => list.map((t) => ({ ...t, clips: t.clips.filter((c) => !gone.has(c.srcId)) })).filter((t, i) => i === 0 || t.clips.length);
        setTracks(keep(tracks));
        undoStack = undoStack.map(keep);
        redoStack = redoStack.map(keep);
        if (selectedId && !findClip(selectedId)) selectedId = null;
        if (clipboard && gone.has(clipboard.srcId)) clipboard = null;
        gone.forEach((id) => { const s = sources.get(id); if (s && s.storage === 'opfs' && s.copyName) Project.releaseCopy(s.copyName); Project.removeHandle(id); if (s) disposeSource(s); sources.delete(id); });
        entries = entries.filter((e) => resolved(e));
        if (!allClips().length) {
          close(false, true);
          scheduleSave();
          showStart();
          toast('No clips are left in this project.');
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
  // ---------------------------------------------------------------------------
  // Start screen: project list
  // ---------------------------------------------------------------------------
  const ICON = {
    rename: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></svg>',
    duplicate: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 012-2h9"/></svg>',
    files: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><path class="fill" d="M12 6.6a1.2 1.2 0 110 2.4 1.2 1.2 0 010-2.4z"/></svg>',
    remove: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
    export: '<svg viewBox="0 0 24 24"><path d="M12 3v12M7 8l5-5 5 5"/><path d="M5 13v6a2 2 0 002 2h10a2 2 0 002-2v-6"/></svg>',
  };

  let listRendering = null;
  function renderProjectList() {
    // Coalesce calls; the list reads from IndexedDB/OPFS asynchronously.
    if (listRendering) { listRendering.again = true; return; }
    listRendering = { again: false };
    (async () => {
      try {
        const docs = await Project.listProjects();
        const sizes = await Project.copySizes();
        let held = new Set();
        try { if (navigator.locks && navigator.locks.query) held = new Set((await navigator.locks.query()).held.map((l) => l.name)); } catch (e) { /* ignore */ }
        const list = $('projectList');
        list.replaceChildren(...docs.map((d) => projectCard(d, sizes, held)));
        $('projectsSection').hidden = !docs.length;
        $('newProjectHead').hidden = !docs.length;
        const used = new Set();
        let total = 0;
        for (const d of docs) for (const m of d.media || []) if (m.copyName && !used.has(m.copyName)) { used.add(m.copyName); total += sizes.get(m.copyName) || 0; }
        const free = await Project.freeSpace();
        $('projectsStorage').textContent = docs.length
          ? `${docs.length} project${docs.length === 1 ? '' : 's'} · working copies use ${fmtSize(total)}${Number.isFinite(free) ? ` · ${fmtSize(free)} free in this browser` : ''}`
          : '';
        $('projectsStorage').classList.toggle('warn-text', Number.isFinite(free) && free < 500 * 1024 * 1024);
      } finally {
        const again = listRendering.again;
        listRendering = null;
        if (again) renderProjectList();
      }
    })();
  }

  function projectCard(d, sizes, held) {
    const sum = projectSummary(d);
    const card = document.createElement('div');
    card.className = 'project-card';
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'pc-open';
    open.title = 'Open project';
    const th = document.createElement('div');
    th.className = 'pc-thumb';
    if (d.thumb) th.style.backgroundImage = `url("${d.thumb}")`;
    const info = document.createElement('div');
    info.className = 'pc-info';
    const name = document.createElement('strong');
    name.textContent = d.name || 'Project';
    const meta = document.createElement('span');
    const when = new Date(d.savedAt || Date.now()).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
    meta.textContent = `${sum.count} clip${sum.count === 1 ? '' : 's'} · ${fmtTime(sum.dur, false)} · ${when}`;
    const meta2 = document.createElement('span');
    const bytes = Project.projectBytes(d, sizes);
    const linked = (d.media || []).filter((m) => m.storage === 'handle').length;
    meta2.textContent = bytes ? `${fmtSize(bytes)} in browser storage${linked ? ` · ${linked} linked` : ''}` : linked ? `${linked} linked file${linked === 1 ? '' : 's'} · no extra space` : 'No stored copies';
    info.append(name, meta, meta2);
    if (d.id === projectId) {
      const b = document.createElement('span'); b.className = 'pc-badge'; b.textContent = 'Open in this tab'; info.append(b);
    } else if (held.has('videcutto-project-' + d.id)) {
      const b = document.createElement('span'); b.className = 'pc-badge other'; b.textContent = 'Open in another tab'; info.append(b);
    }
    open.append(th, info);
    open.addEventListener('click', () => openProject(d.id));
    const actions = document.createElement('div');
    actions.className = 'pc-actions';
    const act = (key, label, fn) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'icon small';
      b.title = label;
      b.setAttribute('aria-label', `${label}: ${d.name}`);
      b.innerHTML = ICON[key];
      b.addEventListener('click', fn);
      actions.append(b);
    };
    act('rename', 'Rename', () => renameProject(d));
    act('duplicate', 'Duplicate', () => openDuplicate(d));
    act('export', 'Export project file', async () => { await openProject(d.id); if (projectId === d.id) openProjectExport(); });
    act('files', 'Files & storage', () => openFilesModal(d));
    act('remove', 'Delete', () => deleteProject(d));
    card.append(open, actions);
    return card;
  }

  async function renameProject(d) {
    const v = prompt('Project name', d.name || '');
    if (v === null || !v.trim()) return;
    if (d.id === projectId) {
      projectName = v.trim();
      syncProjectBar();
      await saveNow();
    } else {
      const doc = await Project.loadProject(d.id);
      if (!doc) return;
      doc.name = v.trim();
      await Project.saveProject(doc);
    }
    if (bc) bc.postMessage({ type: 'changed' });
    renderProjectList();
  }

  async function deleteProject(d) {
    if (!confirm(`Delete "${d.name}"? Its working copies are removed from this browser (unless another project uses them). Your original files are not touched.`)) return;
    if (d.id === projectId) await closeProject(true);
    await Project.deleteProject(d.id);
    if (bc) bc.postMessage({ type: 'changed' });
    renderProjectList();
    toast('Project deleted.');
  }

  // Duplicate: share the video files or make independent copies.
  let dupTarget = null;
  async function openDuplicate(d) {
    if (d.id === projectId) await saveNow();
    dupTarget = d;
    const sizes = await Project.copySizes();
    const bytes = Project.projectBytes(d, sizes);
    $('dupInfo').textContent = `"${d.name}" uses ${fmtSize(bytes)} of working copies in this browser.`;
    $('dupIndependentNote').textContent = bytes ? `Needs another ${fmtSize(bytes)}. The two projects are completely separate.` : 'This project has no stored copies, so this needs no extra space.';
    openModal('duplicateModal');
  }
  async function doDuplicate(mode) {
    const d = dupTarget;
    closeModal('duplicateModal');
    if (!d) return;
    if (mode === 'independent') {
      const sizes = await Project.copySizes();
      if ((await Project.freeSpace()) < Project.projectBytes(d, sizes) * 1.1) { toast('Not enough free storage for independent copies.', 5000); return; }
      showBusy('Duplicating…', 'Copying the video files.');
    }
    try {
      const copy = await Project.duplicateProject(d.id, mode, busyProgress);
      toast(`Created "${copy.name}".`);
      if (bc) bc.postMessage({ type: 'changed' });
    } catch (e) {
      toast('Duplicating failed: ' + (e.message || e), 6000);
    } finally {
      hideBusy();
      renderProjectList();
    }
  }
  $('dupShareBtn').addEventListener('click', () => doDuplicate('share'));
  $('dupIndependentBtn').addEventListener('click', () => doDuplicate('independent'));
  $('dupCancelBtn').addEventListener('click', () => closeModal('duplicateModal'));

  // ---------------------------------------------------------------------------
  // Files & storage of a project
  // ---------------------------------------------------------------------------
  let filesDoc = null;
  async function openFilesModal(d) {
    filesDoc = d;
    if (d.id === projectId) await saveNow();
    await renderFilesModal();
    openModal('filesModal');
  }
  async function renderFilesModal() {
    const d = filesDoc;
    const isCurrent = d.id === projectId;
    const sizes = await Project.copySizes();
    const metas = isCurrent ? [...sources.values()].map((s) => ({ ...mediaMeta(s), missing: s.missing })) : (d.media || []);
    $('filesTitle').textContent = `Files of "${isCurrent ? projectName : d.name}"`;
    const rows = metas.map((m) => {
      const li = document.createElement('li');
      const info = document.createElement('div');
      info.className = 'm-info';
      const name = document.createElement('div');
      name.className = 'm-name';
      name.textContent = m.name;
      const where = document.createElement('div');
      where.className = 'm-meta';
      const kind = m.kind === 'image' ? 'Image' : 'Video';
      if (m.missing) where.textContent = `${kind} · missing — select it again`;
      else if (m.storage === 'opfs') where.textContent = `${kind} · working copy in this browser's storage · ${fmtSize(sizes.get(m.copyName) || 0)}`;
      else if (m.storage === 'handle') where.textContent = `${kind} · linked to the original file "${m.name}" on this computer`;
      else where.textContent = `${kind} · not stored — has to be selected again after a reload`;
      info.append(name, where);
      li.append(info);
      if (isCurrent) {
        const src = sources.get(m.id);
        const btns = document.createElement('div');
        btns.className = 'm-btns';
        const mk = (label, title, fn) => {
          const b = document.createElement('button');
          b.className = 'btn-chip';
          b.textContent = label;
          b.title = title;
          b.addEventListener('click', async () => { await fn(); await renderFilesModal(); });
          btns.append(b);
        };
        mk('Relink…', 'Select the file again, e.g. after moving or renaming it', async () => {
          const [sel] = await pickFiles(false);
          if (!sel) return;
          if (sel.file.size !== m.origSize && !confirm('This file isn\'t identical to the original — cuts may not line up exactly. Use it anyway?')) return;
          await replaceMedia(m, src, sel.file, sel.handle);
          afterRelink();
        });
        if (src && m.storage !== 'opfs' && Project.canCopy() && !src.missing) {
          mk('Copy to browser', 'Keep a working copy in this browser, independent of the original file', async () => {
            const ok = m.kind === 'image' ? await copyImageToBrowser(src) : await makeWorkingCopy(src, true);
            if (ok) { Project.removeHandle(src.id); scheduleSave(); toast('Working copy saved.'); }
          });
        }
        if (src && m.storage === 'opfs' && useHandlePicker()) {
          mk('Use original', 'Link the original file instead of a copy (frees space)', async () => {
            const [sel] = await pickFiles(false);
            if (!sel) return;
            if (!sel.handle) { toast('This browser can\'t link files.'); return; }
            if (sel.file.size !== m.origSize && !confirm('This file isn\'t identical to the original — cuts may not line up exactly. Use it anyway?')) return;
            await replaceMedia(m, src, sel.file, sel.handle);
            afterRelink();
          });
        }
        li.append(btns);
      }
      return li;
    });
    $('filesList').replaceChildren(...rows);
    $('filesOpenBtn').hidden = isCurrent;
    $('filesEmpty').hidden = metas.length > 0;
  }
  function afterRelink() {
    renderTimeline();
    seek(playhead);
    updateEstimate();
    scheduleSave();
  }
  async function copyImageToBrowser(src) {
    const name = `${src.id}-${Date.now().toString(36)}-${++copyCounter}.img`;
    try { src.file = await Project.copyWhole(name, src.file); src.storage = 'opfs'; src.copyName = name; return true; } catch (e) { return false; }
  }
  $('filesOpenBtn').addEventListener('click', () => { closeModal('filesModal'); if (filesDoc) openProject(filesDoc.id); });
  $('filesCloseBtn').addEventListener('click', () => { closeModal('filesModal'); if (!$('startScreen').hidden) renderProjectList(); });
  $('projectFilesBtn').addEventListener('click', () => { if (projectId) openFilesModal({ id: projectId, name: projectName }); });
  ['filesModal', 'duplicateModal'].forEach((id) => $(id).addEventListener('click', (e) => { if (e.target.id === id) closeModal(id); }));

  // Settings: storage info and project deletion
  $('settingsItem').addEventListener('click', async () => {
    const docs = await Project.listProjects();
    const sizes = await Project.copySizes();
    let txt = 'Projects are saved automatically in this browser.';
    if (projectId) {
      const mine = [...sources.values()];
      const bytes = Project.projectBytes({ media: mine.map(mediaMeta) }, sizes);
      const linked = mine.filter((s) => s.storage === 'handle').length;
      txt += ` This project: ${fmtSize(bytes)} of working copies`;
      if (linked) txt += `, ${linked} linked file${linked === 1 ? '' : 's'} (no extra space)`;
      txt += '.';
    }
    const all = new Set();
    let total = 0;
    for (const d of docs) for (const m of d.media || []) if (m.copyName && !all.has(m.copyName)) { all.add(m.copyName); total += sizes.get(m.copyName) || 0; }
    txt += ` All ${docs.length} project${docs.length === 1 ? '' : 's'}: ${fmtSize(total)}.`;
    $('storageInfo').textContent = txt;
    $('deleteProjectBtn').hidden = !projectId;
  });
  $('deleteProjectBtn').addEventListener('click', async () => {
    if (!projectId) return;
    closeModal('settingsModal');
    await deleteProject({ id: projectId, name: projectName });
    showStart();
  });

  // ---------------------------------------------------------------------------
  // Project files: export and import, e.g. to move to another device.
  // The extension lives in one place so the app can be renamed; older
  // extensions stay importable.
  // ---------------------------------------------------------------------------
  const PROJECT_FORMAT = 'videcutto-project';
  const PROJECT_EXT = 'videcutto';
  const LEGACY_EXTS = ['videcutto'];
  const isProjectFile = (name) => [PROJECT_EXT, ...LEGACY_EXTS].some((x) => String(name || '').toLowerCase().endsWith('.' + x));
  const safeFileName = (n) => cleanFileName(n) || 'project';
  let pxUrl = null;
  let pxFile = null;
  let pxAbort = null;

  async function packableSources() {
    const out = [];
    for (const src of sources.values()) {
      if (!src.missing && src.file && (await isReadable(src))) out.push(src);
    }
    return out;
  }

  async function openProjectExport() {
    if (!projectId) return;
    pause();
    await saveNow();
    const all = [...sources.values()];
    const ok = await packableSources();
    const bytes = ok.reduce((s, x) => s + x.file.size, 0);
    const missing = all.length - ok.length;
    $('pxFullNote').textContent = `Everything included — opens on the other device without selecting files again · ≈ ${fmtSize(bytes + 4096)}` +
      (missing ? `. ${missing} file${missing === 1 ? ' is' : 's are'} missing here and can't be included.` : '');
    $('pxResult').hidden = true;
    $('pxProgress').hidden = true;
    $('pxChoices').hidden = false;
    openModal('projExportModal');
  }

  async function exportProjectFile(withFiles) {
    const doc = await Project.loadProject(projectId);
    if (!doc) { toast('Add something to the project first.'); return; }
    const pkg = JSON.parse(JSON.stringify(doc));
    pkg.format = PROJECT_FORMAT;
    pkg.formatVersion = 1;
    const entries = [];
    const ok = withFiles ? await packableSources() : [];
    for (const m of pkg.media || []) {
      delete m.copyName;
      const src = ok.find((s) => s.id === m.id);
      if (!src) { m.pack = null; continue; }
      const ext = (/\.[a-z0-9]{1,5}$/i.exec(src.name || '') || [m.kind === 'image' ? '.img' : '.mp4'])[0];
      m.pack = `media/${m.id}${ext.toLowerCase()}`;
      m.packBase = src.base || 0; // a trimmed working copy starts later than the original
      entries.push({ name: m.pack, blob: src.file });
    }
    entries.unshift({ name: 'project.json', blob: new Blob([JSON.stringify(pkg)], { type: 'application/json' }) });
    $('pxChoices').hidden = true;
    $('pxProgress').hidden = false;
    $('pxFill').style.width = '0%';
    pxAbort = new AbortController();
    try {
      const blob = await Zip.createZip(entries, {
        signal: pxAbort.signal,
        onProgress: (f) => { $('pxFill').style.width = (f * 100).toFixed(1) + '%'; },
      });
      if (pxUrl) URL.revokeObjectURL(pxUrl);
      const name = `${safeFileName(projectName)}${withFiles ? '' : '_project-only'}.${PROJECT_EXT}`;
      pxFile = new File([blob], name, { type: 'application/zip' });
      pxUrl = URL.createObjectURL(pxFile);
      $('pxDownload').href = pxUrl;
      $('pxDownload').download = name;
      $('pxResultText').textContent = `${name} · ${fmtSize(pxFile.size)}`;
      let canShare = false;
      try { canShare = !!(navigator.canShare && navigator.canShare({ files: [pxFile] })); } catch (e) { canShare = false; }
      $('pxShare').hidden = !canShare;
      $('pxResult').hidden = false;
    } catch (e) {
      if (e && e.name === 'AbortError') toast('Export cancelled.');
      else toast('Couldn\'t create the project file: ' + (e.message || e), 6000);
      $('pxChoices').hidden = false;
    } finally {
      $('pxProgress').hidden = true;
      pxAbort = null;
    }
  }
  $('pxSmallBtn').addEventListener('click', () => exportProjectFile(false));
  $('pxFullBtn').addEventListener('click', () => exportProjectFile(true));
  $('pxCancel').addEventListener('click', () => { if (pxAbort) pxAbort.abort(); });
  $('pxShare').addEventListener('click', () => { if (pxFile) navigator.share({ files: [pxFile], title: pxFile.name }).catch(() => {}); });
  $('pxClose').addEventListener('click', () => { if (pxAbort) pxAbort.abort(); closeModal('projExportModal'); });
  $('projectExportBtn').addEventListener('click', openProjectExport);

  async function importProjectFile(file) {
    showBusy('Importing project…', file.name);
    try {
      let toc;
      try { toc = await Zip.readZip(file); } catch (e) { throw new Error('This is not a Videcutto project file.'); }
      const pj = toc.get('project.json');
      if (!pj) throw new Error('This is not a Videcutto project file.');
      const doc = JSON.parse(await file.slice(pj.offset, pj.offset + pj.size).text());
      if (doc.format !== PROJECT_FORMAT) throw new Error('This is not a Videcutto project file.');
      const packed = (doc.media || []).filter((m) => m.pack && toc.has(m.pack));
      const bytes = packed.reduce((s, m) => s + toc.get(m.pack).size, 0);
      const canStore = Project.canCopy();
      if (packed.length && canStore && (await Project.freeSpace()) < bytes * 1.1) throw new Error(`Not enough free storage (needs ${fmtSize(bytes)}).`);
      if (packed.length && !canStore) toast('This browser can\'t store the included files — select them again when opening the project.', 6000);
      // New id; keep the name but avoid duplicates in the list.
      const names = new Set((await Project.listProjects()).map((d) => d.name));
      let name = doc.name || 'Imported project';
      if (names.has(name)) { let k = 2; while (names.has(`${name} (${k})`)) k++; name = `${name} (${k})`; }
      doc.id = Project.newId();
      doc.name = name;
      doc.createdAt = doc.savedAt = Date.now();
      let copied = 0;
      for (const m of doc.media || []) {
        const e = m.pack && toc.get(m.pack);
        if (e && canStore) {
          const ext = (/\.[a-z0-9]{1,5}$/i.exec(m.pack) || ['.bin'])[0];
          const cname = `${m.id}-${Date.now().toString(36)}-i${++copyCounter}${ext}`;
          const base = copied;
          await Project.copyWhole(cname, file.slice(e.offset, e.offset + e.size), (f) => busyProgress(bytes ? (base + f * e.size) / bytes : 1));
          copied += e.size;
          m.storage = 'opfs';
          m.copyName = cname;
          m.base = m.packBase || 0;
        } else {
          m.storage = 'none';
          m.copyName = null;
        }
        delete m.pack;
        delete m.packBase;
      }
      delete doc.format;
      delete doc.formatVersion;
      await Project.saveProject(doc);
      Project.requestPersist();
      if (bc) bc.postMessage({ type: 'changed' });
      hideBusy();
      toast(`Imported "${name}".`);
      await openProject(doc.id);
    } catch (e) {
      toast('Import failed: ' + (e.message || e), 6000);
    } finally {
      hideBusy();
      renderProjectList();
    }
  }

  function pickProjectFile() {
    const inp = document.createElement('input');
    inp.type = 'file';
    // Android pickers grey out unknown extensions, so allow everything there.
    inp.accept = isCoarse ? '*/*' : [...new Set([PROJECT_EXT, ...LEGACY_EXTS])].map((x) => '.' + x).join(',') + ',application/zip';
    inp.addEventListener('change', () => { const f = inp.files[0]; if (f) handleFiles([f]); });
    inp.click();
  }
  $('importProjectBtn').addEventListener('click', pickProjectFile);

  // On start: migrate the single project of 0.2–0.5, open the project in the URL.
  (async () => {
    try { await Project.migrateLegacy(); } catch (e) { /* ignore */ }
    Project.cleanupOrphans().catch(() => {});
    const id = hashId();
    if (id) await openProject(id);
    renderProjectList();
  })();
  window.addEventListener('hashchange', () => { const id = hashId(); if (id && id !== projectId) openProject(id); });

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
