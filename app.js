/*
 * app.js — Videcutto UI: loading, pre-trimming, timeline editing, preview
 * playback and export. The heavy lifting lives in mp4.js and render.js.
 */
(() => {
  'use strict';

  const VERSION = '0.12.2';
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

  // Notes about the preview: a small ⚠ button next to the time shows them on demand.
  const previewNotes = new Map(); // key -> text
  function setHint(key, text) {
    const before = previewNotes.get(key) || null;
    if (text) previewNotes.set(key, text); else previewNotes.delete(key);
    if (before === (text || null)) return;
    const btn = $('hintBtn');
    btn.hidden = !previewNotes.size;
    if (!previewNotes.size) { $('hintPop').hidden = true; btn.setAttribute('aria-expanded', 'false'); return; }
    btn.title = previewNotes.size === 1 ? 'A note about the preview' : `${previewNotes.size} notes about the preview`;
    if (!$('hintPop').hidden) renderHints();
    // A new note makes the button pulse briefly.
    if (text && !before) { btn.classList.remove('pulse'); void btn.offsetWidth; btn.classList.add('pulse'); }
  }
  function renderHints() {
    const pop = $('hintPop');
    pop.replaceChildren(...[...previewNotes.values()].map((t) => Object.assign(document.createElement('p'), { textContent: t })));
  }
  $('hintBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    const pop = $('hintPop');
    pop.hidden = !pop.hidden;
    $('hintBtn').setAttribute('aria-expanded', String(!pop.hidden));
    if (!pop.hidden) {
      renderHints();
      const r = $('hintBtn').getBoundingClientRect();
      pop.style.top = (r.bottom + 8) + 'px';
      pop.style.left = Math.max(8, Math.min(window.innerWidth - pop.offsetWidth - 8, r.left + r.width / 2 - pop.offsetWidth / 2)) + 'px';
    }
  });
  const closeHints = () => { if (!$('hintPop').hidden) { $('hintPop').hidden = true; $('hintBtn').setAttribute('aria-expanded', 'false'); } };
  document.addEventListener('click', (e) => { if (!e.target.closest('#hintPop')) closeHints(); });
  window.addEventListener('scroll', closeHints, { passive: true });

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

  // Help: short guide with sections; ? links in panels open the matching one.
  if (isCoarse) document.body.classList.add('coarse');
  function openHelp(section) {
    const modal = $('helpModal');
    const target = section ? $('help-' + section) : null;
    if (target) {
      modal.querySelectorAll('details').forEach((d) => { d.open = d === target; });
      target.classList.add('flash');
      setTimeout(() => target.classList.remove('flash'), 1200);
    }
    openModal('helpModal');
    if (target) requestAnimationFrame(() => target.scrollIntoView({ block: 'start' }));
    else modal.querySelector('.modal').scrollTop = 0;
  }
  $('helpItem').addEventListener('click', () => { closeMenu(); openHelp(); });
  $('helpCloseBtn').addEventListener('click', () => closeModal('helpModal'));
  $('helpModal').addEventListener('click', (e) => { if (e.target.id === 'helpModal') closeModal('helpModal'); });
  document.addEventListener('click', (e) => {
    const b = e.target.closest('.help-link');
    if (b) { e.stopPropagation(); openHelp(b.dataset.help); }
  }, true);
  // Escape closes the help first (it can lie on top of another window); ? opens it.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('helpModal').hidden) { e.stopImmediatePropagation(); closeModal('helpModal'); return; }
    const tag = (e.target.tagName || '').toLowerCase();
    if (e.key === '?' && !e.ctrlKey && !e.metaKey && tag !== 'input' && tag !== 'textarea' && tag !== 'select'
      && !document.querySelector('.modal-bg:not([hidden])')) { e.preventDefault(); openHelp(); }
  }, true);

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
    snap: store.get('snap', true),
    haptics: store.get('haptics', true),
  };
  const THRESH = isCoarse ? { bytes: 150 * 1024 * 1024, secs: 180 } : { bytes: 1024 * 1024 * 1024, secs: 900 };
  $('trimModeSel').value = settings.trimMode;
  $('undoStepsInput').value = settings.undoSteps;
  $('trimThresholdHint').textContent = `On this device, "large" means bigger than ${fmtSize(THRESH.bytes)} or longer than ${THRESH.secs / 60} minutes.`;
  $('hapticsChk').checked = settings.haptics;
  $('hapticsChk').addEventListener('change', (e) => { settings.haptics = e.target.checked; store.set('haptics', settings.haptics); });
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
  // Visual tracks are stored bottom first: tracks[0] is the main track (under
  // all others). Audio tracks (kind 'audio') follow after the visual ones, in
  // display order (the first one sits right below the main track). Every clip
  // has a `start` on the timeline; on a magnetic track the starts follow from
  // the order (no gaps).
  const sources = new Map(); // id -> source
  let tracks = [];
  let clips = [];            // the main track's clips (alias of tracks[0].clips)
  let selectedId = null;       // the clip shown in the clip panel (also part of selIds)
  const selIds = new Set();    // all selected clips (multi-selection)
  let selAnchor = null;        // last clicked clip, for Shift + click ranges
  let selectMode = false;      // phones: taps add/remove clips (long press or the Select button)
  let selTrans = null;         // selected cut/transition: { track, clip } (clip = the one after the cut)
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

  const newTrack = (main, kind = 'video') => ({ id: 't' + (++uid), kind, main: !!main, magnetic: !!main, hidden: false, opacity: 1, muted: false, volume: 1, clips: [] });
  const isAudioTrack = (t) => !!t && t.kind === 'audio';
  const audioTracks = () => tracks.filter(isAudioTrack);
  const firstAudioIndex = () => { const i = tracks.findIndex(isAudioTrack); return i < 0 ? tracks.length : i; };
  const isSoundClip = (c) => !!c && (c.kind === 'video' || c.kind === 'audio');
  const clipLen = (c) => c.out - c.in;
  const clipEnd = (c) => c.start + clipLen(c);
  const allClips = () => tracks.flatMap((t) => t.clips);
  // A transition belongs to the clip after the cut (clip.tIn = { type, dir, dur, audio }):
  // the two clips overlap by its duration.
  const maxTransDur = (a, b) => Math.max(0.1, Math.min(3, clipLen(a) / 2, clipLen(b) / 2));
  function layoutTrack(tr) {
    if (tr.magnetic) {
      let s = 0;
      tr.clips.forEach((c, i) => {
        if (c.tIn) {
          if (i === 0) delete c.tIn;
          else c.tIn.dur = Math.min(c.tIn.dur, maxTransDur(tr.clips[i - 1], c));
        }
        if (c.tIn) s -= c.tIn.dur;
        c.start = Math.max(0, s);
        s = c.start + clipLen(c);
      });
    } else {
      for (const c of tr.clips) if (!(c.start >= 0)) c.start = 0;
      tr.clips.sort((a, b) => a.start - b.start);
      // On free tracks a transition stays only while the clips still meet exactly.
      tr.clips.forEach((c, i) => {
        if (!c.tIn) return;
        const prev = tr.clips[i - 1];
        if (!prev || Math.abs(clipEnd(prev) - c.tIn.dur - c.start) > 0.01 || c.tIn.dur > maxTransDur(prev, c) + 0.01) delete c.tIn;
      });
    }
    if (tr.main) followMain(tr);
  }
  // Attached clips (📎) move along when their main-track clip moves.
  let mainStarts = null; // clip id -> start at the last layout of the main track
  function followMain(tr) {
    const prev = mainStarts;
    mainStarts = new Map(tr.clips.map((c) => [c.id, c.start]));
    if (!prev) return;
    for (const t of tracks) {
      if (t === tr) continue;
      for (const c of t.clips) {
        if (!c.attach || !mainStarts.has(c.attach) || !prev.has(c.attach)) continue;
        const d = mainStarts.get(c.attach) - prev.get(c.attach);
        if (Math.abs(d) > 1e-9) c.start = Math.max(0, c.start + d);
      }
    }
  }
  const markersOf = () => (tracks[0] && tracks[0].markers) || [];
  // Transition after a clip (its sound and picture are faded out there).
  function tOutOf(tr, c) {
    const i = tr.clips.indexOf(c), n = tr.clips[i + 1];
    return n && n.tIn ? { dur: n.tIn.dur, audio: n.tIn.audio } : null;
  }
  const relayout = () => tracks.forEach(layoutTrack);
  function setTracks(t) {
    mainStarts = null; // a whole new state: nothing has moved
    tracks = [...t.filter((x) => !isAudioTrack(x)), ...t.filter(isAudioTrack)];
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
  function showStart(fromBack) {
    // Leaving the editor in a browser tab: drop the back-button guard again.
    if (fromBack !== true && backGuarded() && !$('editorScreen').hidden) { skipPop++; history.back(); }
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
    pushBackGuard(); // still within the tap that opened the editor
    requestAnimationFrame(() => { applyLayout(); seek(playhead); });
  }
  // ---------------------------------------------------------------------------
  // Back button (phones, installed app): closes an open window first, then
  // leaves the editor for the start screen; on the start screen of the
  // installed app it asks before closing. A history "guard" entry is added on
  // the first touch/key (browsers ignore entries added without one).
  // ---------------------------------------------------------------------------
  const isStandalone = () => matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches || matchMedia('(display-mode: minimal-ui)').matches || navigator.standalone === true;
  // History levels: [start] → 'home' (installed app only) → 'editor'. Each level
  // is its own entry, added during a tap/click/key so browsers don't skip it.
  const histLevel = () => (history.state && history.state.vc) || null;
  const backGuarded = () => histLevel() === 'editor';
  let skipPop = 0;
  const openModalsNow = () => [...document.querySelectorAll('.modal-bg:not([hidden])')].filter((m) => m.id !== 'busyModal');
  function pushLevel(level) {
    try { history.pushState({ ...(history.state || {}), vc: level }, '', location.href); } catch (e) { /* ignore */ }
  }
  function ensureLevels() {
    const editing = !$('editorScreen').hidden;
    if (isStandalone() && !histLevel()) pushLevel('home');
    if (editing && histLevel() !== 'editor') pushLevel('editor');
  }
  const pushBackGuard = ensureLevels;
  ['pointerup', 'click', 'keydown', 'touchend'].forEach((ev) => window.addEventListener(ev, (e) => {
    if (e.target && e.target.closest && e.target.closest('#exitModal')) return;
    ensureLevels();
  }, { capture: true, passive: true }));
  window.addEventListener('popstate', () => {
    if (skipPop) { skipPop--; return; }
    const mods = openModalsNow().filter((m) => m.id !== 'exitModal');
    if (mods.length) {
      const m = mods[mods.length - 1];
      const x = m.querySelector('.modal-head button:last-child') || m.querySelector('.modal-head button');
      if (x) x.click(); else m.hidden = true;
      ensureLevels(); // stay where we were (the next tap confirms the entry)
      return;
    }
    if (!$('editorScreen').hidden) { showStart(true); return; }
    if (isStandalone() && !histLevel()) openModal('exitModal'); // pressing back once more closes the app
  });
  $('exitStay').addEventListener('click', () => { closeModal('exitModal'); ensureLevels(); });
  $('exitClose').addEventListener('click', () => {
    try { window.close(); } catch (e) { /* not allowed */ }
    setTimeout(() => toast('Press back once more to close Videcutto.', 2500), 300);
  });

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
    fileInput.accept = mode === 'files' ? '*/*' : 'video/*,image/*,audio/*';
    $('sourceHint').textContent = hints[mode];
    store.set('sourceMode', mode);
  }
  setSourceMode(store.get('sourceMode', 'videos'));
  // The Gallery/Files distinction only matters for the Android pickers.
  if (!isCoarse) {
    $('sourceToggle').hidden = true;
    $('sourceHint').hidden = true;
    $('dropTitle').textContent = 'Click to choose videos, images or audio';
    $('dropSub').textContent = 'or drag & drop or paste (Ctrl+V) them here';
  }
  $('sourceToggle').addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (btn) setSourceMode(btn.dataset.mode);
  });
  // Desktop Chrome/Edge: the file picker returns handles, so the original files
  // can be reopened after a reload without copying them.
  const useHandlePicker = () => !isCoarse && Project.canUseHandles();
  const AUDIO_EXTS = ['.mp3', '.m4a', '.aac', '.wav', '.flac', '.ogg', '.oga', '.opus', '.weba'];
  const PICKER_TYPES = [{
    description: 'Videos and images',
    accept: { 'video/*': ['.mp4', '.mov', '.m4v', '.3gp'], 'image/*': ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif', '.heic'], 'audio/*': AUDIO_EXTS },
  }];
  const AUDIO_PICKER_TYPES = [{ description: 'Audio', accept: { 'audio/*': AUDIO_EXTS } }];
  const FONT_PICKER_TYPES = [{ description: 'Fonts', accept: { 'font/*': ['.ttf', '.otf', '.woff', '.woff2'] } }];

  /** @returns {Promise<{file: File, handle?: FileSystemFileHandle}[]>} */
  async function pickFiles(multiple, audioOnly) {
    if (useHandlePicker()) {
      try {
        const hs = await window.showOpenFilePicker({ multiple, types: audioOnly === 'font' ? FONT_PICKER_TYPES : audioOnly ? AUDIO_PICKER_TYPES : PICKER_TYPES });
        return Promise.all(hs.map(async (h) => ({ file: await h.getFile(), handle: h })));
      } catch (e) {
        if (e && e.name === 'AbortError') return [];
        // Other errors (e.g. blocked in an iframe): fall back to the input element.
      }
    }
    return new Promise((resolve) => {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = audioOnly === 'font' ? (isCoarse ? '*/*' : '.ttf,.otf,.woff,.woff2') : audioOnly ? (isCoarse && fileInput.accept === '*/*' ? '*/*' : 'audio/*,' + AUDIO_EXTS.join(',')) : fileInput.accept;
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
  $('addTextItem').addEventListener('click', () => { closeAddMenu(); addTextClip('title'); });
  $('addAudioItem').addEventListener('click', async () => {
    closeAddMenu();
    const list = await pickFiles(true, true);
    if (list.length) handleFiles(list);
  });

  // Dropping files anywhere in the editor adds them too
  document.addEventListener('dragover', (e) => { if (!$('editorScreen').hidden) e.preventDefault(); });
  document.addEventListener('drop', async (e) => {
    if ($('editorScreen').hidden || !e.dataTransfer.files.length) return;
    e.preventDefault();
    handleFiles(await fromDataTransfer(e.dataTransfer));
  });

  const isVideoFile = (f) => f.type.startsWith('video/') || /\.(mp4|m4v|mov|3gp)$/i.test(f.name);
  const isImageFile = (f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|bmp|avif|heic|heif)$/i.test(f.name);
  const isAudioFile = (f) => (f.type.startsWith('audio/') || /\.(mp3|m4a|aac|wav|wave|flac|ogg|oga|opus|weba)$/i.test(f.name)) && !/\.(mp4|m4v|mov|3gp)$/i.test(f.name);

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
    // Font files are added to the project's fonts (editor only).
    const fontFiles = entries.filter((x) => isFontFile(x.file));
    if (fontFiles.length) {
      entries = entries.filter((x) => !fontFiles.includes(x));
      if ($('editorScreen').hidden || !projectId) toast('Open a project first to add fonts.');
      else loadingQueue = loadingQueue.then(async () => { for (const ff of fontFiles) await addFontFile(ff.file, ff.handle); }).catch(() => {});
      if (!entries.length) return;
    }
    const media = entries.filter((x) => isVideoFile(x.file) || isImageFile(x.file) || isAudioFile(x.file));
    if (!media.length) { if (entries.length) toast('Please choose videos (MP4, MOV, M4V), images (JPG, PNG, WebP) or audio (MP3, M4A, WAV, …).'); return; }
    if (media.length < entries.length) toast('Some files were skipped because they are neither videos, images nor audio.');
    // From the start screen, media always start a new project; in the editor they are added.
    const fresh = !$('startScreen').hidden || !projectId;
    loadingQueue = loadingQueue.then(async () => {
      if (fresh) await createProject(baseName(media[0].file.name) || '');
      for (const m of media) {
        const overlay = !!opts.overlay && !fresh;
        if (isAudioFile(m.file)) await addAudio(m.file, m.handle, m.pasted);
        else if (isImageFile(m.file) && !isVideoFile(m.file)) await addImage(m.file, m.handle, m.pasted, overlay);
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
      // Recording date, place, camera … of the original (a trimmed working copy has none of its own).
      fileMeta: meta.fmeta || (base ? {} : demux.meta || {}),
    };
  }

  function mediaMeta(src) {
    const m = {
      id: src.id, kind: src.kind, name: src.name, origSize: src.origSize, origLastModified: src.origLastModified,
      base: src.base, start: src.start, duration: src.duration, rangeIn: src.rangeIn, rangeOut: src.rangeOut,
      width: src.width, height: src.height, rotation: src.rotation, storage: src.storage, copyName: src.copyName,
    };
    if (src.fontName) m.fontName = src.fontName;
    if (src.fileMeta && Object.keys(src.fileMeta).length) m.fmeta = src.fileMeta;
    // Waveform overview, so it doesn't have to be computed again after a reload.
    if (src.peaks && src.peaks.length) { m.peaks = toB64(src.peaks); m.peaksRate = src.peaksRate; m.peaksFrom = src.peaksFrom || 0; }
    return m;
  }
  function toB64(u8) { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }
  function fromB64(b) { try { const s = atob(b); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; } catch (e) { return null; } }
  const peaksFromMeta = (m) => (m.peaks ? { peaks: fromB64(m.peaks), peaksRate: m.peaksRate || PEAK_RATE, peaksFrom: m.peaksFrom || 0 } : {});

  // Busy overlay with progress
  let busyCtl = null; // set when the busy work can be cancelled
  function showBusy(title, text, ctl) {
    busyCtl = ctl || null;
    $('busyTitle').textContent = title;
    $('busyText').textContent = text || '';
    $('busyFill').style.width = '0%';
    $('busyCancel').hidden = !busyCtl;
    $('busyModal').hidden = false;
  }
  // Progress callbacks double as cancel points: they throw once Cancel was pressed.
  const busyProgress = (f) => {
    if (busyCtl && busyCtl.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    $('busyFill').style.width = (clamp(f, 0, 1) * 100).toFixed(1) + '%';
  };
  const hideBusy = () => { $('busyModal').hidden = true; busyCtl = null; };
  $('busyCancel').addEventListener('click', () => { if (busyCtl) { busyCtl.abort(); $('busyCancel').disabled = true; $('busyTitle').textContent = 'Cancelling…'; setTimeout(() => { $('busyCancel').disabled = false; }, 1500); } });

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
    showBusy('Preparing video…', `Saving a working copy of "${src.name}" on this device, so it stays available.`, new AbortController());
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
      await Project.removeCopy(name);
      if (e && e.name === 'AbortError') { toast('Cancelled — the video is used straight from the file (after a reload you may have to select it again).', 5000); return false; }
      console.error(e);
      toast('Couldn\'t save a working copy — you may have to select this video again after a reload.', 6000);
      return false;
    } finally {
      hideBusy();
    }
  }

  async function addFile(file, handle, pasted, overlay) {
    if (!Render.hasWebCodecs()) { toast('This browser can\'t process videos (no WebCodecs support).', 5000); return; }
    let probed;
    try { probed = await probe(file); } catch (e) {
      if (/No video track/.test(e.message)) return addAudio(file, handle, pasted); // e.g. an .mp4 with sound only
      toast(e.message, 7000);
      return;
    }
    const v = probed.demux.video;
    const start = Math.max(0, v.start);
    const meta = {
      id: nextSrcId(), name: file.name, origSize: file.size, origLastModified: file.lastModified,
      start, duration: v.duration, rangeIn: start, rangeOut: v.duration,
    };
    const src = makeSource(meta, file, probed, 0);
    if (!src.hasAudio) toast(`"${file.name}" has no sound.`, 3500);
    else if (!src.audioDecodable) toast(`The sound of "${file.name}" (${probed.demux.audio.codecString || probed.demux.audio.format}) can't be decoded here — it will be silent in the export.`, 6000);

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
  // Audio files: decoded once for length and waveform; played by <audio>
  // elements in the preview and decoded again (48 kHz stereo) when exporting.
  // ---------------------------------------------------------------------------
  const PEAK_RATE = 50; // waveform values per second

  async function decodeAudioFile(file) {
    const buf = await file.arrayBuffer();
    const C = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const ctx = new C(2, 1, 48000);
    return await ctx.decodeAudioData(buf);
  }
  function peaksOf(ab) {
    const step = Math.max(1, Math.round(ab.sampleRate / PEAK_RATE));
    const n = Math.ceil(ab.length / step);
    const chans = [];
    for (let c = 0; c < Math.min(2, ab.numberOfChannels); c++) chans.push(ab.getChannelData(c));
    const out = new Uint8Array(n);
    for (let k = 0; k < n; k++) {
      let m = 0;
      const e = Math.min(ab.length, (k + 1) * step);
      for (const d of chans) for (let i = k * step; i < e; i++) { const a = d[i] < 0 ? -d[i] : d[i]; if (a > m) m = a; }
      out[k] = Math.min(255, Math.round(m * 255));
    }
    return out;
  }
  /** Stereo PCM at 48 kHz for the export (mono is copied to both sides). */
  async function pcmOf(src) {
    const ab = await decodeAudioFile(src.file);
    const L = ab.getChannelData(0);
    const R = ab.numberOfChannels > 1 ? ab.getChannelData(1) : L;
    return [L, R];
  }

  function makeAudioSource(meta, file) {
    return {
      id: meta.id, kind: 'audio', name: meta.name, origSize: meta.origSize, origLastModified: meta.origLastModified,
      file, url: URL.createObjectURL(file), demux: null, base: 0, width: 0, height: 0, rotation: 0, frameRate: 30,
      fileDuration: meta.duration, start: 0, duration: meta.duration, hasAudio: true, audioDecodable: true, videoBitrate: 0, audioBitrate: 0,
      rangeIn: 0, rangeOut: meta.duration, storage: meta.storage || 'none', copyName: meta.copyName || null,
      thumbs: [], thumbStep: Infinity, missing: false, ...peaksFromMeta(meta),
    };
  }

  async function addAudio(file, handle, pasted) {
    showBusy('Reading audio…', `"${file.name || 'Audio'}"`);
    let ab;
    try { ab = await decodeAudioFile(file); } catch (e) {
      hideBusy();
      toast(`"${file.name}" couldn't be read as audio in this browser.`, 6000);
      return;
    }
    const duration = ab.duration;
    const peaks = peaksOf(ab);
    ab = null;
    if (duration > (isCoarse ? 1800 : 7200)) toast(`"${file.name}" is very long — creating the video needs a lot of memory for its sound on this device.`, 7000);
    const meta = { id: nextSrcId(), name: file.name || 'Pasted audio', origSize: file.size, origLastModified: file.lastModified, duration };
    const src = makeAudioSource(meta, file);
    src.peaks = peaks; src.peaksRate = PEAK_RATE; src.peaksFrom = 0;
    // Phones (and files without a handle) keep a copy; desktop links the original.
    if ((isCoarse || pasted || !handle) && Project.canCopy()) {
      const name = `${src.id}-${Date.now().toString(36)}-${++copyCounter}${(/\.[a-z0-9]+$/i.exec(file.name || '') || ['.audio'])[0]}`;
      showBusy('Preparing audio…', `Saving a working copy of "${src.name}" on this device.`, new AbortController());
      try {
        src.file = await Project.copyWhole(name, file, busyProgress);
        URL.revokeObjectURL(src.url);
        src.url = URL.createObjectURL(src.file);
        src.storage = 'opfs'; src.copyName = name; Project.requestPersist();
      } catch (e) { await Project.removeCopy(name); }
    }
    hideBusy();
    if (src.storage === 'none' && handle) { src.storage = 'handle'; await Project.saveHandle(src.id, handle); }
    const wasEmpty = allClips().length === 0;
    sources.set(src.id, src);
    saveEnabled = true;
    commit(() => { addClipToTimeline({ id: newId(), kind: 'audio', srcId: src.id, in: 0, out: duration, muted: false, volume: 1, fadeIn: 0, fadeOut: 0 }); });
    if (wasEmpty) { playhead = 0; onCanvasChange(); }
    showEditor();
  }

  // Waveform of a video's sound (for detached audio), computed in the background.
  let peakQueue = Promise.resolve();
  function queuePeaks(src) {
    if (!src || src.peaks || src.kind !== 'video' || !src.audioDecodable || src.peaksPending) return;
    src.peaksPending = true;
    peakQueue = peakQueue.then(async () => {
      try {
        const p = await Render.audioPeaks(src, src.rangeIn - src.base, src.rangeOut - src.base, PEAK_RATE);
        src.peaks = p; src.peaksRate = PEAK_RATE; src.peaksFrom = src.rangeIn;
        renderClips();
        scheduleSave();
      } catch (e) { console.warn('waveform', e); }
      src.peaksPending = false;
    });
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
    const src = makeImageSource0(meta, file, bitmap);
    src.fileMeta = meta.fmeta || {};
    if (!meta.fmeta && file && window.Meta) Meta.readImageMeta(file).then((m) => { src.fileMeta = m; });
    return src;
  }
  function makeImageSource0(meta, file, bitmap) {
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
    if (src.kind === 'audio' || src.kind === 'font') return;
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
  const copyClip = (c) => (c.tIn ? { ...c, tIn: { ...c.tIn } } : { ...c });
  const snapshot = () => tracks.map((t) => ({ ...t, clips: t.clips.map(copyClip), ...(t.markers ? { markers: t.markers.map((m) => ({ ...m })) } : {}) }));
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
    if (clipLiveBefore) { clearTimeout(clipNudgeTimer); liveClipCommit(); } // finish a series of nudges first
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
    const keep = tracks.filter((t, i) => i === 0 || t.clips.length || t.manual);
    if (keep.length !== tracks.length) setTracks(keep);
  }
  function afterEdit() {
    relayout();
    pruneTracks();
    syncSel();
    if (selectedTrackId && !findTrack(selectedTrackId)) selectedTrackId = null;
    syncSelBar();
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
  const EDGE = 0.05;      // paste: this close to a clip edge counts as the edge
  const CUT_EDGE = 0.005; // cut: pieces must be at least this long
  const OVERLAY_TF = { fit: 'free', scale: 0.5 }; // new overlays: half size, centred

  // Does [start, start+len) collide with a clip of the track (ignoring one id)?
  function overlaps(tr, start, len, ignoreId) {
    return tr.clips.some((c) => c.id !== ignoreId && start < clipEnd(c) - 1e-6 && start + len > c.start + 1e-6);
  }

  /** Put a clip on the lowest overlay track that has room at `start`, or on a new track on top. */
  function placeOverlay(clip, start) {
    clip.start = Math.max(0, start);
    let tr = tracks.slice(1).find((t) => !isAudioTrack(t) && !t.magnetic && !overlaps(t, clip.start, clipLen(clip)));
    if (!tr) { tr = newTrack(false); tracks.splice(firstAudioIndex(), 0, tr); }
    tr.clips.push(clip);
    layoutTrack(tr);
    return tr;
  }
  /** Put an audio clip on the topmost audio track that has room at `start`, or on a new one below. */
  function placeAudio(clip, start) {
    clip.start = Math.max(0, start);
    let tr = audioTracks().find((t) => !overlaps(t, clip.start, clipLen(clip)));
    if (!tr) { tr = newTrack(false, 'audio'); tracks.push(tr); }
    tr.clips.push(clip);
    layoutTrack(tr);
    return tr;
  }

  /** Append to the main track (or put it as overlay at the playhead). */
  function addClipToTimeline(clip, overlay) {
    if (clip.kind === 'audio') {
      placeAudio(clip, allClips().length ? playhead : 0);
      selectedId = clip.id;
      return;
    }
    if (overlay && allClips().length) {
      if (clip.kind !== 'text') clip.tf = { ...Render.tfOf(clip.tf), ...OVERLAY_TF }; // text keeps its own size
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
    if (sel && playhead > sel.clip.start + CUT_EDGE && playhead < clipEnd(sel.clip) - CUT_EDGE) return sel;
    const nVis = firstAudioIndex();
    const order = [0, ...tracks.map((_, i) => i).slice(1, nVis).reverse(), ...tracks.map((_, i) => i).slice(nVis)];
    for (const ti of order) {
      const a = clipAtTrack(tracks[ti], playhead);
      if (a.idx >= 0) return { tr: tracks[ti], ti, idx: a.idx, clip: a.clip };
    }
    return null;
  }
  function splitAtPlayhead() {
    // Several clips selected: cut all of them that lie under the playhead.
    if (multi()) {
      const hits = selFinds().filter((f) => playhead > f.clip.start + CUT_EDGE && playhead < clipEnd(f.clip) - CUT_EDGE);
      if (!hits.length) { toast('None of the selected clips lies under the playhead.'); return; }
      const rights = [];
      commit(() => {
        for (const f of hits) {
          const c = f.clip, offset = playhead - c.start, i = f.tr.clips.indexOf(c);
          const left = { ...c, id: newId(), out: c.in + offset };
          const right = { ...c, id: newId(), in: c.in + offset, start: c.start + offset, tIn: undefined };
          f.tr.clips.splice(i, 1, left, right);
          rights.push(right.id);
          if (canvasState.cropClipId === c.id) canvasState.cropClipId = left.id;
        }
        selectSet(rights, false);
      });
      syncSelBar();
      return;
    }
    const f = splitTarget();
    if (!f) { toast(allClips().length && playhead >= totalDuration() - 1e-6 ? 'The playhead is at the very end — there is nothing to cut there.' : 'Move the playhead over a clip to cut it.'); return; }
    const c = f.clip;
    const offset = playhead - c.start;
    if (offset < CUT_EDGE || offset > clipLen(c) - CUT_EDGE) { toast('The playhead is exactly at the edge of the clip — there is nothing to cut off there.'); return; }
    commit(() => {
      const left = { ...c, id: newId(), out: c.in + offset };
      const right = { ...c, id: newId(), in: c.in + offset, start: c.start + offset, tIn: undefined };
      f.tr.clips.splice(f.idx, 1, left, right);
      selectedId = right.id;
      if (canvasState.cropClipId === c.id) canvasState.cropClipId = left.id;
    });
  }
  // ---------------------------------------------------------------------------
  // Selection (one or several clips)
  // ---------------------------------------------------------------------------
  // Code that sets `selectedId` alone selects just that clip; the set follows.
  function syncSel() {
    for (const id of [...selIds]) if (!findClip(id)) selIds.delete(id);
    if (selectedId && !findClip(selectedId)) selectedId = [...selIds].pop() || null;
    if (!selectedId) { selIds.clear(); return; }
    if (!selIds.has(selectedId)) { selIds.clear(); selIds.add(selectedId); }
  }
  const multi = () => { syncSel(); return selIds.size > 1; };
  const selFinds = () => { syncSel(); return [...selIds].map(findClip).filter(Boolean); };
  // Grouped clips are selected together.
  function groupIds(id) {
    const f = findClip(id);
    if (!f || !f.clip.group) return id ? [id] : [];
    return allClips().filter((c) => c.group === f.clip.group).map((c) => c.id);
  }
  const wholeGroupSelected = (id) => { const g = groupIds(id); return g.length > 1 && selIds.size === g.length && g.every((x) => selIds.has(x)); };
  function selectOnly(id) { selIds.clear(); for (const x of groupIds(id)) selIds.add(x); selectedId = id; selAnchor = id; }
  function selectJust(id) { selIds.clear(); if (id) selIds.add(id); selectedId = id; selAnchor = id; }
  function selectToggle(id) {
    const g = groupIds(id);
    if (selIds.has(id)) {
      g.forEach((x) => selIds.delete(x));
      if (!selIds.has(selectedId)) selectedId = [...selIds].pop() || null;
    } else { g.forEach((x) => selIds.add(x)); selectedId = id; }
    selAnchor = id;
  }
  function selectSet(ids, add) {
    if (!add) selIds.clear();
    ids.forEach((i) => selIds.add(i));
    selectedId = ids.length ? ids[ids.length - 1] : [...selIds].pop() || null;
  }
  // Shift + click: the clips between two clips — on one track by order, across tracks by time.
  function selectRange(fromId, toId, add) {
    const a = findClip(fromId), b = findClip(toId);
    if (!a || !b) { selectOnly(toId); return; }
    let ids;
    if (a.tr === b.tr) {
      const [i0, i1] = [a.idx, b.idx].sort((x, y) => x - y);
      ids = a.tr.clips.slice(i0, i1 + 1).map((c) => c.id);
    } else {
      const order = displayTracks();
      const [r0, r1] = [order.indexOf(a.tr), order.indexOf(b.tr)].sort((x, y) => x - y);
      const t0 = Math.min(a.clip.start, b.clip.start), t1 = Math.max(clipEnd(a.clip), clipEnd(b.clip));
      ids = order.slice(r0, r1 + 1).flatMap((tr) => tr.clips.filter((c) => c.start < t1 - 1e-6 && clipEnd(c) > t0 + 1e-6).map((c) => c.id));
    }
    selectSet(ids, add);
    selectedId = toId;
    selAnchor = fromId;
  }
  function selectAll() { selectSet(allClips().map((c) => c.id), false); afterSelect(); }
  function clearSelection() { selectedId = null; selectMode = false; afterSelect(); }
  // Phones: bar with the number of selected clips while selecting several.
  function syncSelBar() {
    syncSel();
    const show = selectMode || selIds.size > 1;
    $('selBar').hidden = !show;
    $('selCount').textContent = selIds.size === 1 ? '1 clip selected' : `${selIds.size} clips selected`;
    $('selectBtn').classList.toggle('on', selectMode);
    $('selectBtn').setAttribute('aria-pressed', String(selectMode));
  }
  $('selectBtn').addEventListener('click', () => { selectMode = !selectMode; afterSelect(); if (selectMode) toast('Tap clips to add or remove them.', 2000); });
  $('selAllBtn').addEventListener('click', selectAll);
  $('selDoneBtn').addEventListener('click', clearSelection);

  // ---------------------------------------------------------------------------
  // Groups (move and select together) and attaching (📎: a clip on an upper or
  // audio track moves along with the main-track clip below it).
  // ---------------------------------------------------------------------------
  const isAttachedNow = (c) => !!(c.attach && tracks[0].clips.some((m) => m.id === c.attach));
  function toggleGroup() {
    const list = selFinds();
    if (list.length < 2 && !(list[0] && list[0].clip.group)) return;
    const grouped = list.some((f) => f.clip.group);
    const allSame = list.length > 1 && list.every((f) => f.clip.group && f.clip.group === list[0].clip.group);
    if (grouped && (allSame || list.length === 1)) {
      commit(() => list.forEach((f) => { delete f.clip.group; }));
      toast('Ungrouped.', 1500);
    } else {
      const gid = 'g' + (++uid);
      commit(() => list.forEach((f) => { f.clip.group = gid; }));
      toast(`${list.length} clips grouped — they are selected and moved together.`, 2500);
    }
  }
  // The main-track clip under (or just before) time t.
  function mainClipAt(t) {
    const m = tracks[0].clips;
    let best = null;
    for (const c of m) { if (c.start <= t + 1e-6) best = c; if (t < clipEnd(c) - 1e-6 && c.start <= t + 1e-6) return c; }
    return best || m[0] || null;
  }
  function setAttach(on) {
    const list = (multi() ? selFinds() : [findClip(selectedId)].filter(Boolean)).filter((f) => !f.tr.main);
    if (!list.length) return;
    if (on && !tracks[0].clips.length) { toast('There is no clip on the main track to attach to.'); updateClipPanel(); return; }
    commit(() => list.forEach((f) => {
      if (on) { const m = mainClipAt(f.clip.start); if (m) f.clip.attach = m.id; } else delete f.clip.attach;
    }));
  }
  function syncAttachUI(list) {
    const others = list.filter((f) => !f.tr.main);
    $('attachRow').hidden = !others.length || !tracks[0].clips.length;
    const on = others.length > 0 && others.every((f) => isAttachedNow(f.clip));
    $('attachChk').checked = on;
    $('attachChk').indeterminate = !on && others.some((f) => isAttachedNow(f.clip));
    const one = others.length === 1 ? others[0].clip : null;
    const m = one && isAttachedNow(one) ? tracks[0].clips.find((x) => x.id === one.attach) : null;
    $('attachInfo').textContent = m ? `Moves with the ${m.kind === 'video' || m.kind === 'image' ? (srcOf(m) ? srcOf(m).name : m.kind) : m.kind === 'text' ? 'text' : 'color clip'} at ${fmtTime(m.start, false)} on the main track.` : 'Moves along when the main-track clip below it moves (e.g. when you cut or reorder the main track).';
    const grouped = list.some((f) => f.clip.group);
    $('groupBtn').hidden = list.length < 2 && !grouped;
    const allSame = list.length > 1 && list.every((f) => f.clip.group && f.clip.group === list[0].clip.group);
    $('groupBtn').querySelector('span').textContent = grouped && (allSame || list.length === 1) ? 'Ungroup' : 'Group';
    $('groupBtn').classList.toggle('on', grouped && (allSame || list.length === 1));
  }
  $('attachChk').addEventListener('change', (e) => setAttach(e.target.checked));
  $('groupBtn').addEventListener('click', toggleGroup);

  // ---------------------------------------------------------------------------
  // Markers: named points on the timeline. Clips snap to them; tap one in the
  // ruler to jump there (tap again to edit it), drag it to move it.
  // ---------------------------------------------------------------------------
  const MARKER_COLORS = ['#f2b233', '#4c8dff', '#3ecf8e', '#ef5a5a', '#b57bff'];
  const markerAt = (t, tol = 0.04) => markersOf().find((m) => Math.abs(m.t - t) <= tol) || null;
  function addMarker() {
    if (!allClips().length) { toast('Add a clip first.'); return; }
    const t = +playhead.toFixed(3);
    const near = markerAt(t);
    if (near) { openMarker(near.id); return; }
    const n = markersOf().length + 1;
    commit(() => {
      const tr = tracks[0];
      tr.markers = [...(tr.markers || []), { id: 'mk' + (++uid), t, label: '', color: MARKER_COLORS[(n - 1) % MARKER_COLORS.length] }].sort((a, b) => a.t - b.t);
    });
    toast(`Index ${n} at ${fmtTime(t)} — tap it in the ruler to name it.`, 2500);
  }
  let editMarkerId = null;
  function openMarker(id) {
    const m = markersOf().find((x) => x.id === id);
    if (!m) return;
    editMarkerId = id;
    $('mkLabel').value = m.label || '';
    $('mkTime').textContent = fmtTime(m.t);
    $('mkColors').querySelectorAll('[data-color]').forEach((b) => b.classList.toggle('active', b.dataset.color === (m.color || MARKER_COLORS[0])));
    openModal('markerModal');
  }
  function patchMarker(patch) {
    const id = editMarkerId;
    commit(() => { tracks[0].markers = markersOf().map((x) => (x.id === id ? { ...x, ...patch } : x)); });
  }
  $('mkColors').append(...MARKER_COLORS.map((c) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'mk-swatch'; b.dataset.color = c; b.style.background = c; b.setAttribute('aria-label', 'Color ' + c); return b; }));
  $('mkColors').addEventListener('click', (e) => { const b = e.target.closest('[data-color]'); if (!b) return; patchMarker({ color: b.dataset.color }); $('mkColors').querySelectorAll('[data-color]').forEach((x) => x.classList.toggle('active', x === b)); });
  $('mkLabel').addEventListener('change', (e) => patchMarker({ label: e.target.value.trim().slice(0, 40) }));
  $('mkLabel').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); closeModal('markerModal'); } });
  $('mkJump').addEventListener('click', () => { const m = markersOf().find((x) => x.id === editMarkerId); closeModal('markerModal'); if (m) { pause(); seek(m.t); } });
  $('mkDelete').addEventListener('click', () => { const id = editMarkerId; closeModal('markerModal'); commit(() => { tracks[0].markers = markersOf().filter((x) => x.id !== id); if (!tracks[0].markers.length) delete tracks[0].markers; }); });
  $('mkClose').addEventListener('click', () => closeModal('markerModal'));
  $('markerModal').addEventListener('click', (e) => { if (e.target.id === 'markerModal') closeModal('markerModal'); });
  $('markerBtn').addEventListener('click', addMarker);
  // Ruler: tap = jump (tap again = edit), drag = move (snaps to clip edges and the playhead).
  let mkDrag = null;
  let suppressRulerClick = false;
  function initMarkerRuler() {
  tlRuler.addEventListener('pointerdown', (e) => {
    const f = e.target.closest('.marker');
    if (f) startMarkerDrag(e, f);
  }, true);
  // The playhead line lies over a marker at the playhead: hand the press to the marker.
  $('playheadLine').addEventListener('pointerdown', (e) => {
    const f = document.elementsFromPoint(e.clientX, e.clientY).find((x) => x.classList && x.classList.contains('marker'));
    if (f) startMarkerDrag(e, f);
  }, true);
  function startMarkerDrag(e, f) {
    e.stopPropagation(); e.preventDefault();
    const m = markersOf().find((x) => x.id === f.dataset.marker);
    if (!m) return;
    mkDrag = { id: m.id, el: f, x0: e.clientX, t0: m.t, t: m.t, moved: false, pid: e.pointerId };
  }
  window.addEventListener('pointermove', (e) => {
    if (!mkDrag || e.pointerId !== mkDrag.pid) return;
    const dx = e.clientX - mkDrag.x0;
    if (!mkDrag.moved && Math.abs(dx) < 6) return;
    mkDrag.moved = true;
    let t = clamp(mkDrag.t0 + dx / pps, 0, totalDuration());
    if (settings.snap && !e.altKey) {
      const thr = (isCoarse ? 20 : 14) / pps;
      let best = null;
      for (const c of [playhead, ...allClips().flatMap((c) => [c.start, clipEnd(c)])]) { const d = Math.abs(c - t); if (d < thr && (!best || d < best.d)) best = { d, t: c }; }
      if (best) t = best.t;
    }
    mkDrag.t = t;
    mkDrag.el.style.left = (pad() + t * pps) + 'px';
  });
  const endMk = (e) => {
    if (!mkDrag || e.pointerId !== mkDrag.pid) return;
    const d = mkDrag;
    mkDrag = null;
    suppressRulerClick = true;
    if (d.moved) { commit(() => { tracks[0].markers = markersOf().map((x) => (x.id === d.id ? { ...x, t: +d.t.toFixed(3) } : x)).sort((a, b) => a.t - b.t); }); return; }
    const m = markersOf().find((x) => x.id === d.id);
    if (!m) return;
    if (Math.abs(playhead - m.t) < 0.02) openMarker(m.id); else { pause(); seek(m.t); }
  };
  window.addEventListener('pointerup', endMk);
  window.addEventListener('pointercancel', (e) => { if (mkDrag && e.pointerId === mkDrag.pid) { mkDrag = null; renderTimeline(); } });
  }

  function deleteSelected() {
    const list = selFinds();
    if (!list.length) { toast('Select a clip first.'); return; }
    commit(() => {
      for (const f of list) { const i = f.tr.clips.indexOf(f.clip); if (i >= 0) f.tr.clips.splice(i, 1); }
      selectedId = null;
    });
    if (list.length > 1) toast(`${list.length} clips deleted.`, 1800);
  }
  // The clipboard keeps the clips' distances and which track they came from.
  function copySelected(silent) {
    const list = selFinds();
    if (!list.length) { toast('Select a clip first.'); return false; }
    const t0 = Math.min(...list.map((f) => f.clip.start));
    clipboard = {
      items: list.sort((x, y) => x.clip.start - y.clip.start).map((f) => {
        const { id, tIn, ...data } = f.clip;
        return { data, rel: f.clip.start - t0, fromMain: f.ti === 0, track: f.tr.id, kind: f.tr.kind || 'video' };
      }),
    };
    if (!silent) toast(list.length > 1 ? `${list.length} clips copied — move the playhead and paste.` : 'Clip copied — move the playhead and paste.');
    updateToolbar();
    return true;
  }
  function paste() {
    if (!clipboard || !clipboard.items || !clipboard.items.length) return;
    const items = clipboard.items.map((it) => ({ ...it, nc: { ...it.data, id: newId() } }));
    let insertTime = playhead;
    commit(() => {
      const main = tracks[0];
      // Clips from the magnetic main track are inserted there as a block.
      const block = items.filter((it) => it.fromMain && main.magnetic && it.nc.kind !== 'audio');
      if (block.length) {
        let insertAt = main.clips.length;
        insertTime = totalMain();
        const a = clipAt(playhead);
        if (a.idx >= 0) {
          const c = a.clip, len = clipLen(c);
          if (a.offset <= EDGE) { insertAt = a.idx; insertTime = a.start; } else if (a.offset >= len - EDGE) { insertAt = a.idx + 1; insertTime = a.start + len; } else {
            const left = { ...c, id: newId(), out: c.in + a.offset };
            const right = { ...c, id: newId(), in: c.in + a.offset, tIn: undefined };
            main.clips.splice(a.idx, 1, left, right);
            insertAt = a.idx + 1; insertTime = a.start + a.offset;
          }
        } else if (playhead <= 0) { insertAt = 0; insertTime = 0; }
        main.clips.splice(insertAt, 0, ...block.map((it) => it.nc));
      }
      // The others keep their distances; clips that shared a track share one again.
      const groups = new Map();
      for (const it of items) if (!block.includes(it)) { if (!groups.has(it.track)) groups.set(it.track, []); groups.get(it.track).push(it); }
      for (const g of groups.values()) {
        g.forEach((it) => { it.nc.start = Math.max(0, playhead + it.rel); });
        const audio = g[0].nc.kind === 'audio';
        const fits = (tr) => g.every((it) => !overlaps(tr, it.nc.start, clipLen(it.nc)));
        let tr = null;
        if (!audio && g[0].fromMain && !main.magnetic && fits(main)) tr = main;
        if (!tr) tr = (audio ? audioTracks() : tracks.slice(1).filter((t) => !isAudioTrack(t) && !t.magnetic)).find(fits);
        if (!tr) {
          tr = newTrack(false, audio ? 'audio' : 'video');
          if (audio) tracks.push(tr); else tracks.splice(firstAudioIndex(), 0, tr);
        }
        g.forEach((it) => tr.clips.push(it.nc));
        layoutTrack(tr);
      }
      selectSet(items.map((it) => it.nc.id), false);
    });
    syncSelBar();
    playhead = insertTime;
    seek(playhead);
  }
  const totalMain = () => (tracks[0].clips.length ? Math.max(...tracks[0].clips.map(clipEnd)) : 0);

  function toggleMuteClip() {
    if (multi()) {
      const list = selFinds().filter((f) => isSoundClip(f.clip));
      if (!list.length) return;
      const mute = list.some((f) => !f.clip.muted);
      commit(() => list.forEach((f) => { f.clip.muted = mute; }));
      return;
    }
    let f = findClip(selectedId);
    if (!f) { const a = clipAt(playhead); if (a.idx >= 0) f = { tr: tracks[0], idx: a.idx, clip: a.clip }; }
    if (!f || !isSoundClip(f.clip)) return;
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
    if (!f || isSoundClip(f.clip)) return;
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
    updateTransPanel();
    if (!c) { panel.hidden = true; updateTransformingClass(); updateTrackPanel(); return; }
    const src = srcOf(c);
    panel.hidden = false;
    panel.classList.toggle('multi', multi());
    if (multi()) { updateMultiPanel(); syncAttachUI(selFinds()); updateTrackPanel(); return; }
    syncAttachUI([findClip(c.id)].filter(Boolean));
    $('cpStartField').hidden = false;
    $('cpKind').textContent = { video: 'Video', image: 'Image', color: 'Color clip', text: 'Text', audio: src && src.kind === 'video' ? 'Audio of video' : 'Audio' }[c.kind] || '';
    $('cpTitle').textContent = src ? src.name : c.kind === 'text' ? `${fontName(textOf(c).font)} · “${textOf(c).content.split('\n')[0].slice(0, 30)}”` : `${(c.color || DEFAULT_COLOR).toUpperCase()} · ${c.size === 'canvas' ? 'canvas size' : `${c.w}×${c.h}`}`;
    $('muteClipBtn').hidden = !isSoundClip(c);
    $('detachBtn').hidden = !(c.kind === 'video' && src && src.hasAudio && src.audioDecodable);
    $('muteClipBtn').classList.toggle('on', !!c.muted);
    $('muteClipBtn').querySelector('span').textContent = c.muted ? 'Unmute' : 'Mute';
    $('cpDurField').hidden = isSoundClip(c);
    if (document.activeElement !== $('cpDuration')) $('cpDuration').value = +(c.out - c.in).toFixed(2);
    $('cpColorField').hidden = c.kind !== 'color';
    $('cpSizeField').hidden = c.kind !== 'color';
    $('cpCustomField').hidden = !(c.kind === 'color' && c.size === 'custom');
    const audio = c.kind === 'audio';
    $('cpTabCrop').hidden = c.kind === 'color' || c.kind === 'text' || audio;
    $('cpTabText').hidden = c.kind !== 'text';
    if (cpTab === 'text' && c.kind !== 'text') showTab('clip');
    if (c.kind === 'text') syncTextUI();
    $('cpTabPosition').hidden = audio;
    $('cpTabRotate').hidden = audio;
    $('cpTabAudio').hidden = !isSoundClip(c);
    $('cpTabFade').hidden = audio;
    if ((cpTab === 'crop' && (c.kind === 'color' || audio)) || (audio && (cpTab === 'position' || cpTab === 'rotate' || cpTab === 'fade')) || (cpTab === 'audio' && !isSoundClip(c))) showTab('clip');
    syncAudioUI(c);
    syncFadeUI(c);
    syncTimeUI();
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

  // Several clips selected: only what can be done to all of them at once.
  function updateMultiPanel() {
    const list = selFinds();
    const n = (k) => list.filter((f) => f.clip.kind === k).length;
    const parts = [['video', 'video'], ['image', 'image'], ['color', 'color clip'], ['audio', 'audio clip']].map(([k, w]) => (n(k) ? `${n(k)} ${w}${n(k) > 1 ? 's' : ''}` : '')).filter(Boolean);
    $('cpKind').textContent = `${list.length} clips`;
    $('cpTitle').textContent = parts.join(' · ');
    const sound = list.filter((f) => isSoundClip(f.clip));
    $('muteClipBtn').hidden = !sound.length;
    const allMuted = sound.length && sound.every((f) => f.clip.muted);
    $('muteClipBtn').classList.toggle('on', !!allMuted);
    $('muteClipBtn').querySelector('span').textContent = allMuted ? 'Unmute all' : 'Mute all';
    $('detachBtn').hidden = !list.some((f) => f.clip.kind === 'video' && srcOf(f.clip) && srcOf(f.clip).hasAudio && srcOf(f.clip).audioDecodable);
    $('cpStartField').hidden = true;
    ['cpDurField', 'cpColorField', 'cpSizeField', 'cpCustomField'].forEach((id) => { $(id).hidden = true; });
    const mag = list.some((f) => f.tr.magnetic);
    $('cpNudge').querySelectorAll('button').forEach((b) => { b.disabled = mag; });
    $('cpMagHint').hidden = !mag;
    // Crop, position and rotation apply to all selected pictures (crop not to color clips).
    const pics = list.filter((f) => f.clip.kind !== 'audio');
    const croppable = pics.filter((f) => f.clip.kind !== 'color' && f.clip.kind !== 'text');
    const texts = list.filter((f) => f.clip.kind === 'text');
    $('cpTabText').hidden = !texts.length;
    if (texts.length) { if (!texts.some((f) => f.clip.id === selectedId)) selectedId = texts[0].clip.id; syncTextUI(); }
    $('cpTabCrop').hidden = !croppable.length;
    $('cpTabPosition').hidden = !pics.length;
    $('cpTabRotate').hidden = !pics.length;
    $('cpTabAudio').hidden = !sound.length;
    $('cpTabFade').hidden = !pics.length;
    if (pics.length) syncFadeUI(pics.find((f) => f.clip.id === selectedId) ? selClip() : pics[0].clip);
    const ok = { clip: true, audio: sound.length > 0, crop: croppable.length > 0, position: pics.length > 0, rotate: pics.length > 0, fade: pics.length > 0, text: texts.length > 0 };
    if (!ok[cpTab]) showTab('clip');
    if (pics.length) syncTransformUI();
    if (sound.length) syncAudioUI(sound.find((f) => f.clip.id === selectedId) ? selClip() : sound[0].clip);
    updateTransformingClass();
  }

  // ---------------------------------------------------------------------------
  // Audio tab: clip volume and fades (live while dragging, one undo step)
  // ---------------------------------------------------------------------------
  function syncAudioUI(c) {
    if (!c || !isSoundClip(c)) return;
    const vol = Math.round((c.volume == null ? 1 : c.volume) * 100);
    const len = clipLen(c);
    const maxFade = Math.max(0.1, Math.min(10, len)).toFixed(1);
    if (document.activeElement !== $('volRange')) $('volRange').value = vol;
    $('volVal').textContent = vol + '%';
    for (const [k, id] of [['fadeIn', 'fadeIn'], ['fadeOut', 'fadeOut']]) {
      $(id + 'Range').max = maxFade;
      if (document.activeElement !== $(id + 'Range')) $(id + 'Range').value = c[k] || 0;
      $(id + 'Val').textContent = (c[k] || 0).toFixed(1) + ' s';
    }
  }
  let clipLiveBefore = null;
  function liveClip(patch) {
    // Volume and fades apply to every selected clip with sound.
    const pic = 'vFadeIn' in patch || 'vFadeOut' in patch;
    const list = multi() ? selFinds().filter((x) => isSoundClip(x.clip) || (pic && x.clip.kind !== 'audio')) : [findClip(selectedId)].filter(Boolean);
    if (!list.length) return;
    if (!clipLiveBefore) clipLiveBefore = snapshot();
    let shown = null;
    for (const f of list) {
      const c = { ...f.clip, ...patch };
      // Fades never overlap.
      const len = clipLen(c);
      for (const [i, o] of [['fadeIn', 'fadeOut'], ['vFadeIn', 'vFadeOut']]) {
        if ((c[i] || 0) + (c[o] || 0) > len) {
          if (i in patch) c[o] = Math.max(0, len - c[i]); else c[i] = Math.max(0, len - (c[o] || 0));
          c[i] = Math.min(c[i] || 0, len); c[o] = Math.min(c[o] || 0, len);
        }
      }
      f.tr.clips[f.tr.clips.indexOf(f.clip)] = c;
      if (!shown || c.id === selectedId) shown = c;
    }
    syncAudioUI(shown);
    syncFadeUI(shown);
    syncPool();
    renderClips();
  }
  function liveClipCommit() {
    if (!clipLiveBefore) return;
    pushUndo(clipLiveBefore);
    clipLiveBefore = null;
    afterEdit();
  }
  $('volRange').addEventListener('input', (e) => liveClip({ volume: Math.abs(e.target.value - 100) < 4 ? 1 : e.target.value / 100 }));
  // Videos: picture and sound fade together unless that's switched off.
  const linked = () => { const c = selClip(); return !!c && c.kind === 'video' && c.fadeLink !== false; };
  $('fadeInRange').addEventListener('input', (e) => liveClip(linked() ? { fadeIn: +e.target.value, vFadeIn: +e.target.value } : { fadeIn: +e.target.value }));
  $('fadeOutRange').addEventListener('input', (e) => liveClip(linked() ? { fadeOut: +e.target.value, vFadeOut: +e.target.value } : { fadeOut: +e.target.value }));
  $('vFadeInRange').addEventListener('input', (e) => liveClip(linked() ? { vFadeIn: +e.target.value, fadeIn: +e.target.value } : { vFadeIn: +e.target.value }));
  $('vFadeOutRange').addEventListener('input', (e) => liveClip(linked() ? { vFadeOut: +e.target.value, fadeOut: +e.target.value } : { vFadeOut: +e.target.value }));
  ['vFadeInRange', 'vFadeOutRange'].forEach((id) => $(id).addEventListener('change', liveClipCommit));
  $('fadeLinkChk').addEventListener('change', (e) => {
    const on = e.target.checked;
    const list = (multi() ? selFinds() : [findClip(selectedId)].filter(Boolean)).filter((f) => f.clip.kind === 'video');
    commit(() => list.forEach((f) => { f.clip.fadeLink = on; if (on) { f.clip.fadeIn = f.clip.vFadeIn || 0; f.clip.fadeOut = f.clip.vFadeOut || 0; } }));
  });
  function syncFadeUI(c) {
    if (!c || c.kind === 'audio') return;
    const len = clipLen(c);
    const maxFade = Math.max(0.1, Math.min(10, len)).toFixed(1);
    for (const [k, id] of [['vFadeIn', 'vFadeIn'], ['vFadeOut', 'vFadeOut']]) {
      $(id + 'Range').max = maxFade;
      if (document.activeElement !== $(id + 'Range')) $(id + 'Range').value = c[k] || 0;
      $(id + 'Val').textContent = (c[k] || 0).toFixed(1) + ' s';
    }
    $('fadeLinkRow').hidden = c.kind !== 'video';
    $('fadeLinkChk').checked = c.fadeLink !== false;
    for (const ph of ['in', 'out']) {
      const a = Render.animOf(c[ANIM_KEYS[ph][0]]);
      const sec = document.querySelector(`.anim-sec[data-phase="${ph}"]`);
      sec.querySelectorAll('[data-fx]').forEach((b) => {
        const k = b.dataset.fx;
        b.classList.toggle('active', b.dataset.v ? a[k] === b.dataset.v : !!a[k]);
      });
      const dir = sec.querySelector('.anim-dir');
      dir.hidden = !a.slide;
      dir.querySelectorAll('[data-dir]').forEach((b) => b.classList.toggle('active', b.dataset.dir === a.slide));
      sec.querySelector('.anim-text-row').hidden = c.kind !== 'text';
      sec.querySelectorAll('[data-text]').forEach((b) => b.classList.toggle('active', b.dataset.text === (a.text || 'whole')));
      if (!(c[ANIM_KEYS[ph][1]] > 0)) $(ANIM_KEYS[ph][1] + 'Val').textContent = 'off';
    }
  }
  // Animate tab: effects for appearing (in) and disappearing (out), combinable.
  const ANIM_KEYS = { in: ['animIn', 'vFadeIn', 'fadeIn'], out: ['animOut', 'vFadeOut', 'fadeOut'] };
  const animActive = (a) => !!(a.fade || a.zoom || a.slide || a.spin || a.blur || a.pop || (a.text && a.text !== 'whole'));
  let lastSlide = { in: 'left', out: 'left' };
  function setAnim(ph, fn) {
    const [ak, dk, sk] = ANIM_KEYS[ph];
    const list = (multi() ? selFinds() : [findClip(selectedId)].filter(Boolean)).filter((f) => f.clip.kind !== 'audio');
    if (!list.length) return;
    const shown = selClip() || list[0].clip;
    const next = fn(Render.animOf(shown[ak]));
    commit(() => list.forEach((f) => {
      const c = f.clip;
      const a = { ...Render.animOf(c[ak]), ...next };
      if (c.kind !== 'text') a.text = 'whole';
      c[ak] = a;
      // Switching an effect on while the duration is 0 gives it a useful length.
      if (!(c[dk] > 0) && animActive(a)) {
        const other = c[ANIM_KEYS[ph === 'in' ? 'out' : 'in'][1]] || 0;
        const want = c.kind === 'text' && a.text !== 'whole' ? 1.5 : 0.5;
        const d = Math.max(0, Math.min(want, clipLen(c) / 2, clipLen(c) - other));
        c[dk] = +d.toFixed(1);
        if (c.kind === 'video' && c.fadeLink !== false) c[sk] = c[dk];
      }
    }));
  }
  document.querySelectorAll('.anim-sec').forEach((sec) => {
    const ph = sec.dataset.phase;
    sec.querySelector('.anim-fx').addEventListener('click', (e) => {
      const b = e.target.closest('[data-fx]');
      if (!b) return;
      const k = b.dataset.fx;
      setAnim(ph, (a) => {
        if (k === 'zoom') return { zoom: a.zoom === b.dataset.v ? '' : b.dataset.v };
        if (k === 'slide') return { slide: a.slide ? '' : lastSlide[ph] };
        return { [k]: !a[k] };
      });
    });
    sec.querySelector('.anim-dir').addEventListener('click', (e) => {
      const b = e.target.closest('[data-dir]');
      if (!b) return;
      lastSlide[ph] = b.dataset.dir;
      setAnim(ph, () => ({ slide: b.dataset.dir }));
    });
    sec.querySelector('.anim-text').addEventListener('click', (e) => {
      const b = e.target.closest('[data-text]');
      if (b) setAnim(ph, () => ({ text: b.dataset.text }));
    });
  });
  ['volRange', 'fadeInRange', 'fadeOutRange'].forEach((id) => $(id).addEventListener('change', liveClipCommit));
  $('audioReset').addEventListener('click', () => {
    if (!multi()) { updateSelected({ volume: 1, fadeIn: 0, fadeOut: 0 }); return; }
    const list = selFinds().filter((f) => isSoundClip(f.clip));
    commit(() => list.forEach((f) => { Object.assign(f.clip, { volume: 1, fadeIn: 0, fadeOut: 0 }); }));
  });

  // Detach audio: the sound goes onto an audio track right under the clip, the video is muted.
  function detachAudio() {
    if (multi()) {
      const list = selFinds().filter((f) => f.clip.kind === 'video' && srcOf(f.clip) && srcOf(f.clip).hasAudio && srcOf(f.clip).audioDecodable);
      if (!list.length) return;
      const ids = [];
      commit(() => {
        for (const f of list) {
          const c = f.clip;
          const ac = { id: newId(), kind: 'audio', srcId: c.srcId, in: c.in, out: c.out, muted: !!c.muted, volume: c.volume == null ? 1 : c.volume, fadeIn: c.fadeIn || 0, fadeOut: c.fadeOut || 0 };
          placeAudio(ac, c.start);
          Object.assign(c, { muted: true, fadeIn: 0, fadeOut: 0, volume: 1 });
          ids.push(ac.id);
          queuePeaks(srcOf(c));
        }
        selectSet(ids, false);
      });
      syncSelBar();
      toast(`Sound of ${list.length} video${list.length > 1 ? 's' : ''} detached.`);
      return;
    }
    const f = findClip(selectedId);
    if (!f || f.clip.kind !== 'video') return;
    const src = srcOf(f.clip);
    if (!src || !src.hasAudio || !src.audioDecodable) { toast('This video has no sound that can be used.'); return; }
    let ac = null;
    commit(() => {
      const c = f.clip;
      ac = { id: newId(), kind: 'audio', srcId: c.srcId, in: c.in, out: c.out, muted: !!c.muted, volume: c.volume == null ? 1 : c.volume, fadeIn: c.fadeIn || 0, fadeOut: c.fadeOut || 0 };
      placeAudio(ac, c.start);
      f.tr.clips[f.idx] = { ...c, muted: true, fadeIn: 0, fadeOut: 0, volume: 1 };
      selectedId = ac.id;
    });
    queuePeaks(src);
    toast('Sound detached — it now has its own audio track.');
  }
  $('detachBtn').addEventListener('click', detachAudio);

  // ---------------------------------------------------------------------------
  // Exact timing: start field (absolute) and nudging (relative)
  // ---------------------------------------------------------------------------
  // Accepts 43.79, 0:43.79, 1:02:03.5 (comma works as decimal point too).
  function parseTime(str) {
    const parts = String(str || '').trim().replace(',', '.').split(':');
    if (!parts.length || parts.some((x) => x.trim() === '' || isNaN(+x))) return null;
    return parts.reduce((acc, x) => acc * 60 + +x, 0);
  }
  function syncTimeUI() {
    const f = findClip(selectedId);
    if (!f) return;
    const mag = f.tr.magnetic;
    if (document.activeElement !== $('cpStart')) $('cpStart').value = fmtTime(f.clip.start);
    $('cpStart').disabled = mag;
    $('cpEnd').textContent = `→ ${fmtTime(clipEnd(f.clip))}`;
    $('cpNudge').querySelectorAll('button').forEach((b) => { b.disabled = mag; });
    $('cpMagHint').hidden = !mag;
  }
  /** Move the selected clip to an exact start; no room there → a new track next to it. */
  function setClipStart(t) {
    const f = findClip(selectedId);
    if (!f || f.tr.magnetic) return;
    t = Math.max(0, Math.round(t * 1000) / 1000);
    if (Math.abs(t - f.clip.start) < 1e-4) { syncTimeUI(); return; }
    let moved = false;
    commit(() => {
      const c = f.clip;
      f.tr.clips.splice(f.idx, 1);
      c.start = t;
      let tr = f.tr;
      if (overlaps(tr, t, clipLen(c), c.id)) {
        tr = newTrack(false, tr.kind || 'video');
        tracks.splice(tracks.indexOf(f.tr) + 1, 0, tr);
        moved = true;
      }
      tr.clips.push(c);
    });
    if (moved) toast('Another clip is in the way there — the clip moved to a new track.');
  }
  $('cpStart').addEventListener('change', (e) => {
    const t = parseTime(e.target.value);
    if (t == null) { toast('Please enter a time like 0:43.79 or 43.79'); syncTimeUI(); return; }
    setClipStart(t);
  });
  $('cpStart').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } });

  // Nudging stops at neighbouring clips; a series of nudges is one undo step.
  let clipNudgeTimer = 0;
  function nudge(d) {
    if (multi()) return nudgeMany(d);
    const f = findClip(selectedId);
    if (!f || f.tr.magnetic) return;
    const c = f.clip, len = clipLen(c);
    const prev = f.tr.clips[f.idx - 1], next = f.tr.clips[f.idx + 1];
    const lo = prev ? clipEnd(prev) : 0;
    const hi = next ? next.start - len : Infinity;
    const t = Math.round(clamp(c.start + d, lo, Math.max(lo, hi)) * 1000) / 1000;
    if (Math.abs(t - c.start) < 1e-6) { toast(d < 0 ? 'The clip already touches its neighbour (or the start).' : 'The clip already touches the next clip.', 1500); return; }
    if (!clipLiveBefore) clipLiveBefore = snapshot();
    f.tr.clips[f.idx] = { ...c, start: t };
    renderClips();
    syncTimeUI();
    syncPool();
    renderPreview();
    updateTime();
    clearTimeout(clipNudgeTimer);
    clipNudgeTimer = setTimeout(liveClipCommit, 700);
  }
  // Several clips move by the same amount; they stop where the first one meets a neighbour.
  function nudgeMany(d) {
    const list = selFinds();
    if (!list.length || list.some((f) => f.tr.magnetic)) { toast('Clips on the magnetic main track follow their order — release the magnet to move them freely.', 3000); return; }
    const ids = new Set(list.map((f) => f.clip.id));
    let dmin = -Infinity, dmax = Infinity;
    for (const f of list) {
      const others = f.tr.clips.filter((c) => !ids.has(c.id));
      const prev = others.filter((c) => clipEnd(c) <= f.clip.start + 1e-6).pop();
      const next = others.find((c) => c.start >= clipEnd(f.clip) - 1e-6);
      dmin = Math.max(dmin, (prev ? clipEnd(prev) : 0) - f.clip.start);
      dmax = Math.min(dmax, next ? next.start - clipEnd(f.clip) : Infinity);
    }
    const dd = Math.round(clamp(d, Math.min(0, dmin), Math.max(0, dmax)) * 1000) / 1000;
    if (Math.abs(dd) < 1e-6) { toast('The clips already touch a neighbour (or the start).', 1500); return; }
    if (!clipLiveBefore) clipLiveBefore = snapshot();
    for (const f of list) f.clip.start = Math.round((f.clip.start + dd) * 1000) / 1000;
    renderClips();
    syncPool();
    renderPreview();
    updateTime();
    clearTimeout(clipNudgeTimer);
    clipNudgeTimer = setTimeout(liveClipCommit, 700);
  }
  $('cpNudge').addEventListener('click', (e) => { const b = e.target.closest('[data-nudge]'); if (b) nudge(+b.dataset.nudge); });

  // ---------------------------------------------------------------------------
  // Text clips & fonts
  // ---------------------------------------------------------------------------
  // Built-in fonts (OFL / Apache 2.0, Latin subset) are loaded when first used;
  // the service worker keeps them for offline use. Own fonts (font files or
  // installed fonts) are stored with the project like media (kind 'font').
  const BUILTIN_FONTS = [
    { id: 'inter', name: 'Inter', cat: 'Sans serif', faces: [['inter.woff', 'normal', '100 900'], ['inter-italic.woff', 'italic', '100 900']] },
    { id: 'poppins', name: 'Poppins', cat: 'Sans serif', faces: [['poppins-400.woff', 'normal', '400'], ['poppins-700.woff', 'normal', '700'], ['poppins-400-italic.woff', 'italic', '400'], ['poppins-700-italic.woff', 'italic', '700']] },
    { id: 'montserrat', name: 'Montserrat', cat: 'Sans serif', faces: [['montserrat.woff', 'normal', '100 900'], ['montserrat-italic.woff', 'italic', '100 900']] },
    { id: 'oswald', name: 'Oswald', cat: 'Condensed', faces: [['oswald.woff', 'normal', '200 700']] },
    { id: 'bebas', name: 'Bebas Neue', cat: 'Display', faces: [['bebas.woff', 'normal', '400']] },
    { id: 'lora', name: 'Lora', cat: 'Serif', faces: [['lora.woff', 'normal', '400 700'], ['lora-italic.woff', 'italic', '400 700']] },
    { id: 'playfair', name: 'Playfair Display', cat: 'Serif', faces: [['playfair.woff', 'normal', '400 900'], ['playfair-italic.woff', 'italic', '400 900']] },
    { id: 'pacifico', name: 'Pacifico', cat: 'Script', faces: [['pacifico.woff', 'normal', '400']] },
    { id: 'dancing', name: 'Dancing Script', cat: 'Script', faces: [['dancing.woff', 'normal', '400 700']] },
    { id: 'marker', name: 'Permanent Marker', cat: 'Handwriting', faces: [['marker.woff', 'normal', '400']] },
    { id: 'jetbrains', name: 'JetBrains Mono', cat: 'Monospace', faces: [['jetbrains.woff', 'normal', '100 800'], ['jetbrains-italic.woff', 'italic', '100 800']] },
  ];
  const fontLoads = new Map(); // font key -> Promise
  const fontReady = new Set();
  const fontFamily = (key) => (String(key || '').startsWith('src:') ? `vc-${key.slice(4)}` : `vc-${key || 'inter'}`);
  const familyCss = (key) => `"${fontFamily(key)}", "Inter", "Noto Color Emoji", sans-serif`;
  function fontName(key) {
    if (String(key).startsWith('src:')) { const s = sources.get(key.slice(4)); return s ? s.fontName || s.name : 'Missing font'; }
    const f = BUILTIN_FONTS.find((x) => x.id === key);
    return f ? f.name : key;
  }
  /** Load a font (all its faces) once; redraw when it's there. */
  function ensureFont(key) {
    key = key || 'inter';
    if (fontLoads.has(key)) return fontLoads.get(key);
    let p;
    if (key.startsWith('src:')) {
      const src = sources.get(key.slice(4));
      p = src ? registerUserFont(src) : Promise.resolve(false);
    } else {
      const f = BUILTIN_FONTS.find((x) => x.id === key);
      p = !f ? Promise.resolve(false) : Promise.all(f.faces.map(([file, style, weight]) => {
        const face = new FontFace(fontFamily(key), `url(/fonts/${file})`, { style, weight });
        document.fonts.add(face);
        return face.load();
      })).then(() => true).catch((e) => { console.warn('font', key, e); return false; });
    }
    p = p.then((ok) => {
      if (ok) { fontReady.add(key); textCache.clear(); renderPreview(); }
      else fontLoads.delete(key); // try again later (e.g. offline)
      return ok;
    });
    fontLoads.set(key, p);
    return p;
  }
  async function registerUserFont(src) {
    if (!src.file || src.missing) return false;
    try {
      const face = new FontFace(fontFamily('src:' + src.id), await src.file.arrayBuffer());
      document.fonts.add(face);
      await face.load();
      return true;
    } catch (e) {
      toast(`"${src.name}" couldn't be used as a font.`, 5000);
      return false;
    }
  }

  const TEXT_DEFAULTS = {
    content: 'Your text', font: 'inter', size: 8, bold: true, italic: false, align: 'center', lineHeight: 1.15, letter: 0,
    color: '#ffffff', opacity: 1,
    stroke: false, strokeColor: '#000000', strokeW: 6,
    shadow: true, shadowColor: '#000000', shadowOpacity: 0.55, shadowBlur: 12, shadowDist: 4,
    box: false, boxColor: '#000000', boxOpacity: 0.6, boxPad: 0.35, boxRadius: 0.2,
  };
  const TEXT_PRESETS = {
    title: { text: { size: 10, bold: true, italic: false, align: 'center', shadow: true, box: false, stroke: false, color: '#ffffff' }, tf: { anchor: 'c', dx: 0, dy: 0 } },
    subtitle: { text: { size: 5, bold: false, italic: false, align: 'center', shadow: false, box: true, boxColor: '#000000', boxOpacity: 0.6, boxPad: 0.35, boxRadius: 0.2, stroke: false, color: '#ffffff' }, tf: { anchor: 'b', dx: 0, dy: -0.06 } },
    lower: { text: { size: 4.5, bold: true, italic: false, align: 'left', shadow: false, box: true, boxColor: '#1f4fd8', boxOpacity: 0.9, boxPad: 0.45, boxRadius: 0.1, stroke: false, color: '#ffffff' }, tf: { anchor: 'bl', dx: 0.05, dy: -0.1 } },
  };
  const textOf = (c) => ({ ...TEXT_DEFAULTS, ...(c.text || {}) });
  const textTf = (c, outW) => ({ ...Render.tfOf(c.tf), fit: 'abs', absW: outW });
  const hexA = (hex, a) => { const n = parseInt(String(hex).replace('#', ''), 16) || 0; return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; };

  // The text drawn into its own canvas, at the size it has in the output.
  const textCache = new Map();
  let measureCtx = null;
  // units: { a, phase, p } — draw the text piece by piece (Animate tab), not cached.
  function renderTextCanvas(c, outW, outH, units) {
    const t = textOf(c);
    if (!fontReady.has(t.font)) ensureFont(t.font);
    const key = JSON.stringify([t, outH, fontReady.has(t.font)]);
    const hit = units ? null : textCache.get(key);
    if (hit) return hit;
    const px = Math.max(4, (t.size / 100) * outH);
    const font = `${t.italic ? 'italic ' : ''}${t.bold ? 700 : 400} ${px.toFixed(2)}px ${familyCss(t.font)}`;
    if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
    const m = measureCtx;
    m.font = font;
    if ('letterSpacing' in m) m.letterSpacing = `${(t.letter * px).toFixed(2)}px`;
    const lines = String(t.content || '').split('\n');
    const widths = lines.map((l) => m.measureText(l || ' ').width);
    const lineH = px * t.lineHeight;
    const sw = t.stroke ? (t.strokeW / 100) * px : 0;
    const pad = t.box ? t.boxPad * px : 0;
    const innerW = Math.max(...widths) + sw * 2, innerH = lines.length * lineH + sw * 2;
    const boxW = innerW + pad * 2, boxH = innerH + pad * 2;
    const blur = t.shadow ? (t.shadowBlur / 100) * px : 0, dist = t.shadow ? (t.shadowDist / 100) * px : 0;
    const margin = Math.ceil(blur * 2 + dist + 2);
    const W = Math.max(2, Math.ceil(boxW + margin * 2)), H = Math.max(2, Math.ceil(boxH + margin * 2));
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const x = cv.getContext('2d');
    if (units) { // the box fades in during the first and out during the last part
      const v = units.phase === 'in' ? units.p : 1 - units.p;
      x.globalAlpha = v >= 0.5 ? 1 : (1 - Math.cos(Math.PI * v * 2)) / 2;
    }
    if (t.box) {
      x.fillStyle = hexA(t.boxColor, t.boxOpacity * t.opacity);
      x.beginPath();
      if (x.roundRect) x.roundRect(margin, margin, boxW, boxH, Math.min(boxW, boxH) / 2 * Math.min(1, t.boxRadius * px / (Math.min(boxW, boxH) / 2)));
      else x.rect(margin, margin, boxW, boxH);
      x.fill();
    }
    x.font = font;
    if ('letterSpacing' in x) x.letterSpacing = `${(t.letter * px).toFixed(2)}px`;
    x.textBaseline = 'middle';
    x.textAlign = t.align === 'left' ? 'left' : t.align === 'right' ? 'right' : 'center';
    x.lineJoin = 'round';
    const tx = t.align === 'left' ? margin + pad + sw : t.align === 'right' ? margin + boxW - pad - sw : margin + boxW / 2;
    const shadowOn = () => { if (t.shadow) { x.shadowColor = hexA(t.shadowColor, t.shadowOpacity * t.opacity); x.shadowBlur = blur; x.shadowOffsetX = dist * 0.7; x.shadowOffsetY = dist; } };
    const shadowOff = () => { x.shadowColor = 'transparent'; x.shadowBlur = 0; x.shadowOffsetX = 0; x.shadowOffsetY = 0; };
    x.globalAlpha = 1;
    const drawText = (str, px0, y) => {
      if (sw) { shadowOn(); x.strokeStyle = hexA(t.strokeColor, t.opacity); x.lineWidth = sw * 2; x.strokeText(str, px0, y); shadowOff(); }
      else shadowOn();
      x.fillStyle = hexA(t.color, t.opacity);
      x.fillText(str, px0, y);
      shadowOff();
    };
    if (!units) lines.forEach((l, i) => drawText(l, tx, margin + pad + sw + lineH * (i + 0.5)));
    else drawTextPieces(x, lines, widths, units, { tx, align: t.align, y0: margin + pad + sw, lineH, px, measure: (str) => m.measureText(str).width, drawText });
    const r = { canvas: cv, w: W, h: H };
    if (units) return r;
    if (textCache.size > 60) textCache.clear();
    textCache.set(key, r);
    return r;
  }

  // Lines / words / letters appear one after the other, each with the chosen effects;
  // 'type' shows the letters like a typewriter (and removes them backwards).
  const graphemes = (str) => (typeof Intl !== 'undefined' && Intl.Segmenter ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(str)].map((g) => g.segment) : Array.from(str));
  function drawTextPieces(x, lines, widths, units, o) {
    const { a, phase, p } = units;
    const mode = a.text;
    const pieces = [];
    lines.forEach((l, i) => {
      const lw = widths[i];
      const start = o.align === 'left' ? o.tx : o.align === 'right' ? o.tx - lw : o.tx - lw / 2;
      const y = o.y0 + o.lineH * (i + 0.5);
      const parts = mode === 'lines' ? [l] : mode === 'words' ? (l.match(/\s*\S+/g) || []) : graphemes(l);
      let off = '';
      for (const part of parts) {
        const lead = mode === 'words' ? part.match(/^\s*/)[0] : '';
        const str = part.slice(lead.length);
        const px0 = start + o.measure(off + lead);
        off += part;
        if (!str.trim()) continue;
        pieces.push({ str, x: px0, y, w: o.measure(str) });
      }
    });
    const n = pieces.length;
    if (!n) return;
    x.textAlign = 'left';
    if (mode === 'type') {
      const shown = phase === 'in' ? Math.ceil(p * n - 1e-9) : n - Math.floor(p * n + 1e-9);
      for (let i = 0; i < Math.min(n, shown); i++) o.drawText(pieces[i].str, pieces[i].x, pieces[i].y);
      return;
    }
    const plain = !a.fade && !a.zoom && !a.slide && !a.spin && !a.blur && !a.pop;
    const fxA = plain ? { ...a, fade: true } : a;
    const u = n <= 1 ? 1 : Math.min(1, Math.max(0.2, 2.5 / n));
    const dist = o.px * 0.8;
    for (let i = 0; i < n; i++) {
      const st = n <= 1 ? 0 : i * (1 - u) / (n - 1);
      const f = Render.fxAt(fxA, phase, (p - st) / u);
      if (f.alpha <= 0.002 || f.s <= 0.002) continue;
      const pc = pieces[i];
      x.save();
      x.globalAlpha = f.alpha;
      x.translate(pc.x + pc.w / 2 + f.dx * dist, pc.y + f.dy * dist);
      if (f.rot) x.rotate(f.rot);
      if (f.s !== 1) x.scale(f.s, f.s);
      if (f.blur > 0 && typeof x.filter === 'string') x.filter = `blur(${(f.blur * 0.25 * o.px).toFixed(1)}px)`;
      o.drawText(pc.str, -pc.w / 2, 0);
      x.restore();
    }
  }

  function addTextClip(preset, font) {
    const pr = TEXT_PRESETS[preset || 'title'];
    const c = { id: newId(), kind: 'text', srcId: null, in: 0, out: STILL_DURATION, muted: true, text: { ...TEXT_DEFAULTS, ...pr.text, ...(font ? { font } : {}) }, tf: { fit: 'abs', scale: 1, ...pr.tf } };
    saveEnabled = true;
    commit(() => { addClipToTimeline(c, true); selectedId = c.id; });
    ensureFont(c.text.font);
    showTab('text');
    showEditor();
    setTimeout(() => { const ta = $('txContent'); if (ta && !isCoarse) { ta.focus(); ta.select(); } }, 50);
  }

  // Text tab: live edits, one undo step per change (typing: after a pause).
  let textTimer = 0;
  function liveText(patch, commitNow) {
    // Several text clips selected: style changes apply to all (the content only to the shown one).
    const list = (multi() ? selFinds() : [findClip(selectedId)].filter(Boolean)).filter((f) => f.clip.kind === 'text');
    if (!list.length) return;
    if (!clipLiveBefore) clipLiveBefore = snapshot();
    for (const f of list) {
      const p = 'content' in patch && f.clip.id !== selectedId ? (({ content, ...r }) => r)(patch) : patch;
      f.tr.clips[f.tr.clips.indexOf(f.clip)] = { ...f.clip, text: { ...textOf(f.clip), ...p } };
    }
    if (patch.font) ensureFont(patch.font);
    renderPreview();
    renderClips();
    syncTextUI();
    clearTimeout(textTimer);
    if (commitNow) liveClipCommit();
    else textTimer = setTimeout(liveClipCommit, 800);
  }
  function fillFontSelect(current) {
    const sel = $('txFont');
    const groups = [];
    const cats = [...new Set(BUILTIN_FONTS.map((f) => f.cat))];
    const og = (label, opts) => { const g = document.createElement('optgroup'); g.label = label; opts.forEach((o) => g.appendChild(o)); return g; };
    const opt = (v, t) => Object.assign(document.createElement('option'), { value: v, textContent: t });
    groups.push(og('Built-in', BUILTIN_FONTS.map((f) => opt(f.id, `${f.name} · ${f.cat}`))));
    void cats;
    const own = [...sources.values()].filter((s) => s.kind === 'font');
    if (own.length) groups.push(og('Project fonts', own.map((s) => opt('src:' + s.id, (s.fontName || s.name) + (s.missing ? ' (missing)' : '')))));
    const more = [opt('+file', '＋ Add a font file…')];
    if (window.queryLocalFonts && !isCoarse) more.push(opt('+local', '＋ Use an installed font…'));
    groups.push(og('More', more));
    sel.replaceChildren(...groups);
    sel.value = current;
    sel.style.fontFamily = familyCss(current);
  }
  function syncTextUI() {
    const c = selClip();
    if (!c || c.kind !== 'text') return;
    const t = textOf(c);
    if (document.activeElement !== $('txContent')) $('txContent').value = t.content;
    $('txContent').style.fontFamily = familyCss(t.font);
    if (document.activeElement !== $('txFont')) fillFontSelect(t.font);
    const setR = (id, v, label) => { if (document.activeElement !== $(id)) $(id).value = v; if (label != null) $(id + 'Val').textContent = label; };
    setR('txSize', t.size, t.size.toFixed(1) + '%');
    setR('txLine', t.lineHeight, t.lineHeight.toFixed(2));
    setR('txLetter', t.letter, (t.letter * 100).toFixed(0) + '%');
    setR('txOpacity', Math.round(t.opacity * 100), Math.round(t.opacity * 100) + '%');
    $('txBold').classList.toggle('active', t.bold);
    $('txItalic').classList.toggle('active', t.italic);
    $('txAlign').querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.align === t.align));
    $('txColor').value = t.color;
    $('txStroke').checked = t.stroke; $('txStrokeColor').value = t.strokeColor; setR('txStrokeW', t.strokeW, t.strokeW.toFixed(0) + '%');
    $('txShadow').checked = t.shadow; $('txShadowColor').value = t.shadowColor; setR('txShadowBlur', t.shadowBlur, t.shadowBlur.toFixed(0) + '%'); setR('txShadowDist', t.shadowDist, t.shadowDist.toFixed(0) + '%');
    $('txBox').checked = t.box; $('txBoxColor').value = t.boxColor; setR('txBoxOpacity', Math.round(t.boxOpacity * 100), Math.round(t.boxOpacity * 100) + '%'); setR('txBoxPad', t.boxPad, t.boxPad.toFixed(2)); setR('txBoxRadius', t.boxRadius, t.boxRadius.toFixed(2));
    $('txStrokeRow').classList.toggle('off', !t.stroke);
    $('txShadowRow').classList.toggle('off', !t.shadow);
    $('txBoxRow').classList.toggle('off', !t.box);
  }
  $('txContent').addEventListener('input', (e) => liveText({ content: e.target.value }));
  $('txContent').addEventListener('change', () => { clearTimeout(textTimer); liveClipCommit(); });
  $('txFont').addEventListener('change', async (e) => {
    const v = e.target.value;
    const c = selClip();
    const cur = c ? textOf(c).font : 'inter';
    if (v === '+file') { e.target.value = cur; const key = await pickFontFile(); if (key) liveText({ font: key }, true); return; }
    if (v === '+local') { e.target.value = cur; const key = await pickLocalFont(); if (key) liveText({ font: key }, true); return; }
    liveText({ font: v }, true);
  });
  const rangeText = (id, prop, f = (v) => +v) => {
    $(id).addEventListener('input', (e) => liveText({ [prop]: f(e.target.value) }));
    $(id).addEventListener('change', () => { clearTimeout(textTimer); liveClipCommit(); });
  };
  rangeText('txSize', 'size'); rangeText('txLine', 'lineHeight'); rangeText('txLetter', 'letter');
  rangeText('txOpacity', 'opacity', (v) => v / 100);
  rangeText('txStrokeW', 'strokeW'); rangeText('txShadowBlur', 'shadowBlur'); rangeText('txShadowDist', 'shadowDist');
  rangeText('txBoxOpacity', 'boxOpacity', (v) => v / 100); rangeText('txBoxPad', 'boxPad'); rangeText('txBoxRadius', 'boxRadius');
  $('txBold').addEventListener('click', () => { const c = selClip(); if (c) liveText({ bold: !textOf(c).bold }, true); });
  $('txItalic').addEventListener('click', () => { const c = selClip(); if (c) liveText({ italic: !textOf(c).italic }, true); });
  $('txAlign').addEventListener('click', (e) => { const b = e.target.closest('[data-align]'); if (b) liveText({ align: b.dataset.align }, true); });
  // Colour pickers preview live; one undo step when the picker closes.
  [['txColor', 'color'], ['txStrokeColor', 'strokeColor'], ['txShadowColor', 'shadowColor'], ['txBoxColor', 'boxColor']].forEach(([id, prop]) => {
    $(id).addEventListener('input', (e) => liveText({ [prop]: e.target.value }));
    $(id).addEventListener('change', () => { clearTimeout(textTimer); liveClipCommit(); });
  });
  [['txStroke', 'stroke'], ['txShadow', 'shadow'], ['txBox', 'box']].forEach(([id, prop]) => $(id).addEventListener('change', (e) => liveText({ [prop]: e.target.checked }, true)));
  $('txPresets').addEventListener('click', (e) => {
    const b = e.target.closest('[data-preset]');
    if (!b) return;
    const pr = TEXT_PRESETS[b.dataset.preset];
    const list = (multi() ? selFinds() : [findClip(selectedId)].filter(Boolean)).filter((f) => f.clip.kind === 'text');
    commit(() => list.forEach((f) => {
      f.tr.clips[f.tr.clips.indexOf(f.clip)] = { ...f.clip, text: { ...textOf(f.clip), ...pr.text }, tf: { ...Render.tfOf(f.clip.tf), ...pr.tf, fit: 'abs' } };
    }));
  });

  // Own fonts: a file, or (Chrome/Edge desktop) an installed font — copied into the project.
  const isFontFile = (f) => /\.(ttf|otf|woff2?)$/i.test(f.name) || /^font\//.test(f.type);
  function makeFontSource(meta, file) {
    return {
      id: meta.id, kind: 'font', name: meta.name, fontName: meta.fontName || baseName(meta.name), origSize: meta.origSize, origLastModified: meta.origLastModified,
      file, url: null, demux: null, base: 0, width: 0, height: 0, rotation: 0, frameRate: 30, fileDuration: 0, start: 0, duration: 0,
      hasAudio: false, audioDecodable: false, videoBitrate: 0, audioBitrate: 0, rangeIn: 0, rangeOut: 0,
      storage: meta.storage || 'none', copyName: meta.copyName || null, thumbs: [], thumbStep: Infinity, missing: false,
    };
  }
  async function addFontFile(file, handle, fontNameHint) {
    const meta = { id: nextSrcId(), name: file.name || 'Font', fontName: fontNameHint || baseName(file.name || 'Font'), origSize: file.size, origLastModified: file.lastModified };
    const src = makeFontSource(meta, file);
    if (Project.canCopy()) {
      const name = `${src.id}-${Date.now().toString(36)}-${++copyCounter}${(/\.[a-z0-9]+$/i.exec(file.name || '') || ['.font'])[0]}`;
      try { src.file = await Project.copyWhole(name, file); src.storage = 'opfs'; src.copyName = name; Project.requestPersist(); } catch (e) { /* keep the original */ }
    }
    if (src.storage === 'none' && handle) { src.storage = 'handle'; await Project.saveHandle(src.id, handle); }
    if (!(await registerUserFont(src))) return null;
    sources.set(src.id, src);
    saveEnabled = true;
    const key = 'src:' + src.id;
    fontLoads.set(key, Promise.resolve(true));
    fontReady.add(key);
    renderMediaList();
    scheduleSave();
    toast(`Font "${src.fontName}" added to the project.`, 2500);
    return key;
  }
  async function pickFontFile() {
    const list = await pickFiles(false, 'font');
    if (!list.length) return null;
    return addFontFile(list[0].file, list[0].handle);
  }
  async function pickLocalFont() {
    let fonts;
    try { fonts = await window.queryLocalFonts(); } catch (e) { toast('The browser didn\'t allow access to the installed fonts.', 4000); return null; }
    if (!fonts.length) { toast('No installed fonts available.'); return null; }
    return new Promise((resolve) => {
      const modal = $('localFontModal');
      const list = $('lfList');
      const render = () => {
        const q = $('lfSearch').value.trim().toLowerCase();
        const shown = fonts.filter((f) => !q || f.fullName.toLowerCase().includes(q)).slice(0, 300);
        list.replaceChildren(...shown.map((f) => {
          const li = document.createElement('li');
          li.textContent = f.fullName;
          li.title = f.family + ' · ' + f.style;
          li.addEventListener('click', async () => {
            close();
            try {
              const blob = await f.blob();
              const file = new File([blob], `${f.postscriptName || f.fullName}.ttf`, { type: 'font/ttf' });
              resolve(await addFontFile(file, null, f.fullName));
            } catch (e) { toast('This font couldn\'t be read.'); resolve(null); }
          });
          return li;
        }));
      };
      const close = () => { modal.hidden = true; $('lfSearch').oninput = null; $('lfCancel').onclick = null; };
      $('lfSearch').value = '';
      $('lfSearch').oninput = render;
      $('lfCancel').onclick = () => { close(); resolve(null); };
      render();
      modal.hidden = false;
      setTimeout(() => $('lfSearch').focus(), 50);
    });
  }

  // ---------------------------------------------------------------------------
  // Media list: every file of the project, also when no clip uses it
  // ---------------------------------------------------------------------------
  function missingStub(m) {
    return { ...m, file: null, url: null, bitmap: null, demux: null, thumbs: [], thumbStep: 1, missing: true, hasAudio: m.kind !== 'image', audioDecodable: true, fileDuration: m.duration || 0, ...peaksFromMeta(m) };
  }
  function clipFromSource(src) {
    if (src.kind === 'audio') return { id: newId(), kind: 'audio', srcId: src.id, in: 0, out: src.duration, muted: false, volume: 1, fadeIn: 0, fadeOut: 0 };
    if (src.kind === 'image') return { id: newId(), kind: 'image', srcId: src.id, in: 0, out: STILL_DURATION, muted: false };
    return { id: newId(), kind: 'video', srcId: src.id, in: src.rangeIn, out: src.rangeOut, muted: false };
  }
  const usesOf = (id) => allClips().filter((c) => c.srcId === id || (c.text && c.text.font === 'src:' + id));
  function setMediaFolded(folded) {
    $('mediaCard').classList.toggle('collapsed', folded);
    $('mediaBody').hidden = folded;
    $('mediaToggle').setAttribute('aria-expanded', String(!folded));
    contentsOpen = !folded; // remembered per project
    renderMediaList();
  }
  let contentsOpen = false;
  const openUses = new Set(); // files whose uses are unfolded in the Contents list
  // Pin the preview to the top of the screen while scrolling (classic layout / phones).
  // Camera button: a small menu — copy to the clipboard, save as file, share (phones).
  const canClip = () => !!(navigator.clipboard && navigator.clipboard.write && window.ClipboardItem);
  $('frameBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    const m = $('frameMenu');
    if (!m.hidden) { m.hidden = true; return; }
    $('frameCopy').hidden = !canClip();
    $('frameShare').hidden = !(isCoarse && navigator.canShare && navigator.canShare({ files: [new File([new Blob(['x'], { type: 'image/png' })], 'x.png', { type: 'image/png' })] }));
    m.hidden = false;
  });
  $('frameMenu').addEventListener('click', (e) => {
    const b = e.target.closest('[data-how]');
    if (!b) return;
    $('frameMenu').hidden = true;
    saveFrame(b.dataset.how);
  });
  document.addEventListener('pointerdown', (e) => { if (!$('frameMenu').hidden && !e.target.closest('#frameMenu, #frameBtn')) $('frameMenu').hidden = true; });
  function setPinned(on) {
    document.body.classList.toggle('pv-pinned', on);
    $('pinBtn').classList.toggle('on', on);
    $('pinBtn').setAttribute('aria-pressed', String(on));
    $('pinBtn').title = on ? 'Unpin the preview' : 'Pin the preview (stays at the top while scrolling)';
    store.set('pvPinned', on);
    syncPinTop();
    requestAnimationFrame(renderPreview);
  }
  function syncPinTop() {
    const bar = document.querySelector('#edStage .project-bar');
    $('edStage').style.setProperty('--pin-top', bar ? -(bar.offsetHeight + 8) + 'px' : '0px');
  }
  window.addEventListener('resize', syncPinTop);
  window.addEventListener('scroll', () => { if (document.body.classList.contains('pv-pinned')) syncPinTop(); }, { passive: true });
  $('pinBtn').addEventListener('click', (e) => { e.stopPropagation(); setPinned(!document.body.classList.contains('pv-pinned')); });
  setPinned(store.get('pvPinned', false));

  $('mediaToggle').addEventListener('click', () => { setMediaFolded(!$('mediaCard').classList.contains('collapsed')); scheduleSave(); });

  function mediaThumb(src) {
    const box = document.createElement('div');
    box.className = 'm-thumb';
    if (src.missing) { box.textContent = '⚠'; return box; }
    if (src.kind === 'font') {
      box.textContent = 'Aa';
      box.classList.add('font');
      box.style.fontFamily = familyCss('src:' + src.id);
      return box;
    }
    if (src.kind === 'audio') {
      const fake = { in: 0, out: src.duration || 1, volume: 1 };
      const cv = waveform(fake, src, 64, 40);
      box.appendChild(cv);
      return box;
    }
    if (src.thumbs && src.thumbs[0]) box.style.backgroundImage = `url("${src.thumbs[0]}")`;
    else box.textContent = src.kind === 'image' ? '🖼' : '▶';
    return box;
  }
  // What a use of a file does: where it starts in the file, visibility, sound, effects.
  function useTags(tr, c, i) {
    const t = [];
    const len = clipLen(c);
    if (c.kind === 'video' || c.kind === 'audio') t.push(`from ${fmtTime(c.in, false)} in the file`);
    t.push(`${len.toFixed(1)} s`);
    if (c.kind !== 'audio') {
      if (tr.hidden) t.push('track hidden');
      else if (tr.opacity < 1) t.push(`track ${Math.round(tr.opacity * 100)} % visible`);
      const f = Render.tfOf(c.tf);
      if (f.crop.w < 0.999 || f.crop.h < 0.999) t.push('cropped');
      if (f.rot || f.flipH || f.flipV) t.push('rotated/flipped');
      if (f.fit === 'free' || f.scale !== 1 || f.dx || f.dy) t.push('moved/sized');
      const fx = (a) => { const x = Render.animOf(a); return [x.fade && 'fade', x.zoom && 'zoom ' + x.zoom, x.slide && 'slide', x.spin && 'spin', x.blur && 'blur', x.pop && 'pop'].filter(Boolean).join('+') || '—'; };
      if (c.vFadeIn > 0) t.push(`in: ${fx(c.animIn)} ${c.vFadeIn.toFixed(1)} s`);
      if (c.vFadeOut > 0) t.push(`out: ${fx(c.animOut)} ${c.vFadeOut.toFixed(1)} s`);
      if (c.tIn && i > 0) t.push(`${TRANS_NAMES[c.tIn.type] || 'transition'} in`);
      const nx = tr.clips[i + 1];
      if (nx && nx.tIn) t.push(`${TRANS_NAMES[nx.tIn.type] || 'transition'} out`);
    }
    if (c.kind === 'video' || c.kind === 'audio') {
      const hasSound = c.kind === 'audio' || (srcOf(c) && srcOf(c).hasAudio !== false);
      if (!hasSound) t.push('no sound');
      else if (c.muted || tr.muted || muteAll) t.push('🔇 muted');
      else {
        const vol = (c.volume == null ? 1 : c.volume) * (tr.volume == null ? 1 : tr.volume);
        if (Math.abs(vol - 1) > 0.005) t.push(`🔊 ${Math.round(vol * 100)} %`);
        if (c.fadeIn > 0 || c.fadeOut > 0) t.push('sound fades');
      }
    }
    return t;
  }

  // Contents: the files, then texts, color clips and transitions of the timeline.
  function contentItems() {
    const texts = [], colors = [], cuts = [];
    tracks.forEach((tr) => tr.clips.forEach((c, i) => {
      if (c.kind === 'text') texts.push({ tr, c });
      else if (c.kind === 'color') colors.push({ tr, c });
      if (c.tIn && i > 0) cuts.push({ tr, c });
    }));
    const byStart = (a, b) => a.c.start - b.c.start;
    return { texts: texts.sort(byStart), colors: colors.sort(byStart), cuts: cuts.sort(byStart) };
  }
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  function contentRow(kind, thumb, name, meta, data) {
    const li = document.createElement('li');
    li.className = 'm-item-' + kind;
    Object.assign(li.dataset, data);
    const info = document.createElement('div');
    info.className = 'm-info';
    const nm = document.createElement('div');
    nm.className = 'm-name';
    nm.textContent = name;
    const mt = document.createElement('div');
    mt.className = 'm-meta';
    mt.textContent = meta;
    info.append(nm, mt);
    li.append(thumb, info);
    li.title = 'Select it and jump there';
    return li;
  }
  const spanOf = (c) => `${fmtTime(c.start, false)}–${fmtTime(clipEnd(c), false)}`;
  function renderMediaList() {
    const list = [...sources.values()];
    const unused = list.filter((s) => !usesOf(s.id).length).length;
    const ci = contentItems();
    const parts = [];
    if (list.length) parts.push(plural(list.length, 'file') + (unused ? ` (${unused} unused)` : ''));
    if (ci.texts.length) parts.push(plural(ci.texts.length, 'text'));
    if (ci.colors.length) parts.push(plural(ci.colors.length, 'color clip'));
    if (ci.cuts.length) parts.push(plural(ci.cuts.length, 'transition'));
    if (markersOf().length) parts.push(plural(markersOf().length, 'index point'));
    $('mediaSummary').textContent = parts.length ? parts.join(' · ') : 'nothing yet';
    if ($('mediaBody').hidden) return;
    const ul = $('mediaList');
    const head = (label) => { const h = document.createElement('li'); h.className = 'm-group'; h.textContent = label; return h; };
    const groups = [];
    const extra = ci.texts.length || ci.colors.length || ci.cuts.length || markersOf().length;
    if (list.length && extra) groups.push(head('Files'));
    groups.push(...list.map((src) => {
      const li = document.createElement('li');
      li.dataset.src = src.id;
      li.draggable = !isCoarse && !src.missing && src.kind !== 'font';
      li.title = src.missing ? 'Missing — select the file again' : 'Select its clips' + (isCoarse ? '' : ' · drag onto the timeline to add it');
      const info = document.createElement('div');
      info.className = 'm-info';
      const name = document.createElement('div');
      name.className = 'm-name';
      const n = usesOf(src.id).length;
      const open = n > 0 && openUses.has(src.id);
      if (n && src.kind !== 'font') { const ch = document.createElement('span'); ch.className = 'm-chev'; ch.textContent = open ? '▾' : '▸'; name.append(ch); }
      name.append(src.name);
      const meta = document.createElement('div');
      meta.className = 'm-meta';
      const what = src.kind === 'font' ? `Font · ${src.fontName || src.name}` : src.kind === 'image' ? `Image · ${src.width}×${src.height}` : src.kind === 'audio' ? `Audio · ${fmtTime(src.duration, false)}` : `Video · ${fmtTime((src.rangeOut || 0) - (src.rangeIn || 0), false)} · ${src.width}×${src.height}`;
      meta.innerHTML = '';
      meta.append(what + ' · ');
      const use = document.createElement('span');
      use.className = src.missing ? 'gone' : n ? '' : 'unused';
      use.textContent = src.missing ? 'missing' : n ? `used ${n}×` : 'unused';
      meta.append(use);
      info.append(name, meta);
      const acts = document.createElement('div');
      acts.className = 'm-acts';
      const btn = (label, title, act) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.title = title; b.dataset.act = act; acts.append(b); };
      if (src.missing) btn('Relink…', 'Select this file again', 'relink');
      else {
        btn('＋', src.kind === 'font' ? 'Add a text in this font' : src.kind === 'audio' ? 'Add at the playhead' : 'Add to the main track', 'add');
        if (src.kind !== 'audio' && src.kind !== 'font') btn('⧉', 'Add as overlay at the playhead', 'overlay');
      }
      if ((src.kind === 'video' || src.kind === 'image') && hasMeta(src.fileMeta)) {
        const ms = metaSource();
        const used = ms && ms.src === src;
        btn(used ? '🏷✓' : '🏷', used ? 'Metadata — goes into the export (tap: show)' : 'Metadata — tap: show · long press: use for the export', 'meta');
        const m = src.fileMeta;
        const tags = [m.utc != null && fmtMetaDate(m).split(',')[0], m.lat != null && '📍', (m.make || m.model) && [m.make, m.model].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
        if (tags) { const t = document.createElement('div'); t.className = 'm-meta m-tags' + (used ? ' used' : ''); t.textContent = tags; info.append(t); }
      }
      if (!n) btn('🗑', 'Remove from the project', 'remove');
      if (open && src.kind !== 'font') {
        const box = document.createElement('div');
        box.className = 'm-uses';
        const list = [];
        tracks.forEach((tr) => tr.clips.forEach((c, i) => { if (c.srcId === src.id) list.push({ tr, c, i }); }));
        list.sort((a, b) => a.c.start - b.c.start);
        list.forEach(({ tr, c, i }, k) => {
          const row = document.createElement('div');
          row.className = 'm-use';
          row.dataset.use = c.id;
          row.title = 'Select it and jump there';
          const a = document.createElement('div');
          a.className = 'm-use-a';
          a.textContent = `${k + 1}. ${fmtTime(c.start, false)}–${fmtTime(clipEnd(c), false)} · ${trackLabel(tr)}`;
          const b = document.createElement('div');
          b.className = 'm-use-b';
          b.textContent = useTags(tr, c, i).join(' · ');
          row.append(a, b);
          box.append(row);
        });
        li.classList.add('open');
        li.append(box);
      }
      const uses = li.querySelector('.m-uses');
      li.prepend(mediaThumb(src), info, acts);
      if (uses) li.append(uses);
      return li;
    }));
    if (ci.texts.length) {
      groups.push(head('Texts'));
      for (const { c } of ci.texts) {
        const t = textOf(c);
        const th = document.createElement('div');
        th.className = 'm-thumb font';
        th.textContent = 'Aa';
        th.style.fontFamily = familyCss(t.font);
        th.style.color = t.color;
        // Neutral background; light grey only when the text itself is dark.
        const hx = String(t.color || '#ffffff').replace('#', '');
        const lum = hx.length >= 6 ? (0.299 * parseInt(hx.slice(0, 2), 16) + 0.587 * parseInt(hx.slice(2, 4), 16) + 0.114 * parseInt(hx.slice(4, 6), 16)) : 255;
        if (lum < 90) th.classList.add('light');
        const first = String(t.content || '').split('\n').find((l) => l.trim()) || '(empty)';
        const row = contentRow('text', th, first, `Text · ${spanOf(c)}`, { clip: c.id });
        row.querySelector('.m-name').style.fontFamily = familyCss(t.font);
        groups.push(row);
      }
    }
    if (ci.colors.length) {
      groups.push(head('Color clips'));
      for (const { c } of ci.colors) {
        const th = document.createElement('div');
        th.className = 'm-thumb';
        th.style.background = c.color || DEFAULT_COLOR;
        groups.push(contentRow('color', th, String(c.color || DEFAULT_COLOR).toUpperCase(), `Color · ${spanOf(c)}`, { clip: c.id }));
      }
    }
    if (ci.cuts.length) {
      groups.push(head('Transitions'));
      for (const { tr, c } of ci.cuts) {
        const th = document.createElement('div');
        th.className = 'm-thumb trans-th';
        th.textContent = '⧓';
        const dir = (TRANS_DIRS[c.tIn.type] || []).length ? ` · ${c.tIn.dir}` : '';
        groups.push(contentRow('trans', th, (TRANS_NAMES[c.tIn.type] || c.tIn.type) + dir, `at ${fmtTime(c.start, false)} · ${c.tIn.dur.toFixed(1)} s${tr.main ? '' : ' · upper track'}`, { cutTrack: tr.id, cutClip: c.id }));
      }
    }
    if (markersOf().length) {
      groups.push(head('Index points'));
      markersOf().forEach((m, k) => {
        const th = document.createElement('div');
        th.className = 'm-thumb mk-th';
        th.style.setProperty('--mk', m.color || MARKER_COLORS[0]);
        const row = contentRow('marker', th, m.label || `Index ${k + 1}`, `at ${fmtTime(m.t)}`, { marker: m.id });
        const ed = document.createElement('button');
        ed.type = 'button'; ed.className = 'm-edit'; ed.textContent = '✎'; ed.title = 'Name, color, delete'; ed.dataset.act = 'marker-edit';
        row.append(ed);
        groups.push(row);
      });
    }
    ul.replaceChildren(...groups);
    markLiveContents(true);
  }
  // Tap a text, color clip or transition: select it and move the playhead there.
  function jumpToContent(li) {
    if (li.dataset.clip) {
      const f = findClip(li.dataset.clip);
      if (!f) return;
      selectSet([f.clip.id], false);
      afterSelect();
      // Land where it is fully visible (after its in-animation).
      seek(f.clip.start + Math.min(f.clip.vFadeIn || 0, clipLen(f.clip) / 2) + 0.001);
      return;
    }
    const f = findClip(li.dataset.cutClip);
    if (!f) return;
    selectCut(li.dataset.cutTrack, f.clip.id);
    seek(f.clip.start + (f.clip.tIn ? f.clip.tIn.dur / 2 : 0));
  }
  function addFromMedia(src, overlay) {
    const c = clipFromSource(src);
    commit(() => { addClipToTimeline(c, overlay); selectedId = c.id; });
    showEditor();
  }
  async function removeMedia(src) {
    const inUndo = [...undoStack, ...redoStack].some((st) => st.some((t) => t.clips.some((c) => c.srcId === src.id)));
    if (!confirm(`Remove "${src.name}" from the project?${inUndo ? ' Undo steps that still use it will be dropped.' : ''}`)) return;
    if (inUndo) {
      const ok = (st) => !st.some((t) => t.clips.some((c) => c.srcId === src.id));
      undoStack = undoStack.filter(ok);
      redoStack = redoStack.filter(ok);
    }
    if (clipboard && clipboard.items && clipboard.items.some((it) => it.data.srcId === src.id)) clipboard = null;
    dropSource(src);
    renderTimeline();
    scheduleSave();
  }
  $('mediaList').addEventListener('click', async (e) => {
    const li = e.target.closest('li');
    if (!li || li.classList.contains('m-group')) return;
    if (li.dataset.marker) {
      if (e.target.closest('[data-act="marker-edit"]')) openMarker(li.dataset.marker);
      else { const m = markersOf().find((x) => x.id === li.dataset.marker); if (m) { pause(); seek(m.t); } }
      return;
    }
    if (li.dataset.clip || li.dataset.cutClip) { jumpToContent(li); return; }
    const useRow = e.target.closest('.m-use');
    if (useRow) {
      const f = findClip(useRow.dataset.use);
      if (f) { selectSet([f.clip.id], false); afterSelect(); seek(f.clip.start + Math.min(f.clip.vFadeIn || 0, clipLen(f.clip) / 2) + 0.001); }
      return;
    }
    const src = sources.get(li.dataset.src);
    if (!src) return;
    const act = e.target.closest('[data-act]');
    if (act && act.dataset.act === 'meta' && metaLong) { metaLong = false; return; }
    if (act) {
      if (act.dataset.act === 'add' && src.kind === 'font') addTextClip('title', 'src:' + src.id);
      else if (act.dataset.act === 'add') addFromMedia(src, false);
      else if (act.dataset.act === 'overlay') addFromMedia(src, true);
      else if (act.dataset.act === 'remove') removeMedia(src);
      else if (act.dataset.act === 'meta') openMeta(src.id);
      else if (act.dataset.act === 'relink') {
        const [sel] = await pickFiles(false, src.kind === 'audio');
        if (!sel) return;
        if (sel.file.size !== src.origSize && !confirm('This file isn\'t identical to the original — cuts may not line up exactly. Use it anyway?')) return;
        const fresh = await replaceMedia(mediaMeta(src), src.missing ? null : src, sel.file, sel.handle);
        if (fresh) { if (fresh.kind !== 'audio') queueThumbs(fresh); renderTimeline(); seek(playhead); }
      }
      return;
    }
    const ids = usesOf(src.id).map((c) => c.id);
    if (!ids.length) { toast('This file isn\'t used on the timeline — ＋ adds it.', 2500); return; }
    // Tap: select all its clips and fold its uses out (or in).
    if (src.kind !== 'font') { if (openUses.has(src.id)) openUses.delete(src.id); else openUses.add(src.id); }
    selectSet(ids, false);
    afterSelect();
    renderMediaList();
  });
  // Long press on 🏷: use this file's metadata for the export (tap only shows it).
  let metaLong = false, metaTimer = 0;
  $('mediaList').addEventListener('pointerdown', (e) => {
    const b = e.target.closest('[data-act="meta"]');
    if (!b) return;
    metaLong = false;
    const id = b.closest('li').dataset.src;
    clearTimeout(metaTimer);
    metaTimer = setTimeout(() => {
      metaLong = true;
      metaChoice = { ...metaChoice, mode: 'file', srcId: id };
      if (settings.haptics && navigator.vibrate) { try { navigator.vibrate(20); } catch (err) { /* ignore */ } }
      toast(`Metadata of ${sources.get(id).name} is used for the export.`, 2500);
      $('metaSummary').textContent = metaSummary();
      renderMediaList(); syncFileName(); scheduleSave();
    }, 550);
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) => $('mediaList').addEventListener(ev, () => clearTimeout(metaTimer)));
  $('mediaList').addEventListener('contextmenu', (e) => { if (e.target.closest('[data-act="meta"]')) e.preventDefault(); });
  // Desktop: drag a file from the list onto the timeline.
  const MEDIA_DND = 'application/x-videcutto-media';
  $('mediaList').addEventListener('dragstart', (e) => {
    const li = e.target.closest('li');
    if (!li) return;
    e.dataTransfer.setData(MEDIA_DND, li.dataset.src);
    e.dataTransfer.effectAllowed = 'copy';
    li.classList.add('dragging');
  });
  $('mediaList').addEventListener('dragend', (e) => { const li = e.target.closest('li'); if (li) li.classList.remove('dragging'); tlRows.querySelectorAll('.drop-target').forEach((r) => r.classList.remove('drop-target')); });
  // (the timeline's drop handlers are set up in initMediaDrop, once the timeline exists)

  // Snapping while dragging clips on free tracks (switchable).
  function syncSnapBtn() {
    $('snapBtn').setAttribute('aria-pressed', String(settings.snap));
    $('snapBtn').classList.toggle('on', settings.snap);
    $('snapBtn').title = settings.snap ? 'Snapping on — clips snap to clip edges and the playhead (click to turn off)' : 'Snapping off — clips move freely (click to turn on)';
  }
  $('snapBtn').addEventListener('click', () => { settings.snap = !settings.snap; store.set('snap', settings.snap); syncSnapBtn(); toast(settings.snap ? 'Snapping on' : 'Snapping off — clips move freely', 1500); });
  syncSnapBtn();
  $('muteClipBtn').addEventListener('click', toggleMuteClip);
  $('muteAllBtn').addEventListener('click', toggleMuteAll);

  function updateToolbar() {
    // Undo/redo stay clickable; they just look dimmed when there's nothing to do.
    $('undoBtn').classList.toggle('idle', !undoStack.length);
    $('redoBtn').classList.toggle('idle', !redoStack.length);
    $('splitBtn').disabled = !allClips().length;
    $('pasteBtn').disabled = !clipboard;
    syncSel();
    const hasSel = !!findClip(selectedId);
    $('copyBtn').disabled = !hasSel;
    $('deleteBtn').disabled = !hasSel;
    // "Selected clip only" needs exactly one selected clip.
    const selBtn = $('scopeToggle').querySelector('[data-scope="selected"]');
    selBtn.disabled = !hasSel || selIds.size > 1;
    if (selIds.size > 1 && exportState.scope === 'selected') { exportState.scope = 'all'; syncExportUI(); updateEstimate(); }
    if (!hasSel && exportState.scope === 'selected') { exportState.scope = 'all'; syncExportUI(); updateEstimate(); }
    $('exportBtn').disabled = !exportClips().length || exporting;
    if (exportState.scope === 'selected') updateEstimate();
    updateClipPanel();
  }

  // ---------------------------------------------------------------------------
  // Transitions (tap ⧓ or + on a cut)
  // ---------------------------------------------------------------------------
  const TRANS_NAMES = { fade: 'Cross-fade', black: 'Dip to black', white: 'Dip to white', wipe: 'Wipe', slide: 'Slide', zoom: 'Zoom', circle: 'Circle', blur: 'Blur' };
  const TRANS_DIRS = { wipe: ['left', 'right', 'up', 'down'], slide: ['left', 'right', 'up', 'down'], zoom: ['in', 'out'] };
  const DIR_LABEL = { left: '← Left', right: 'Right →', up: '↑ Up', down: 'Down ↓', in: 'In', out: 'Out' };
  // The cut before clip `clipId` on track `trackId`: { tr, idx, prev, clip } if the clips meet.
  function cutAt(trackId, clipId) {
    const tr = findTrack(trackId);
    if (!tr) return null;
    const idx = tr.clips.findIndex((c) => c.id === clipId);
    if (idx < 1) return null;
    const prev = tr.clips[idx - 1], clip = tr.clips[idx];
    if (!clip.tIn && Math.abs(clipEnd(prev) - clip.start) > 0.01) return null;
    return { tr, idx, prev, clip };
  }
  // Give a cut a transition (free tracks: the second clip moves into the first by the duration).
  function setTransition(cut, t) {
    const old = cut.clip.tIn;
    const dur = clamp(t.dur, 0.1, maxTransDur(cut.prev, cut.clip));
    cut.clip.tIn = { type: t.type || 'fade', dir: t.dir || (TRANS_DIRS[t.type] || [])[0] || 'left', dur, audio: t.audio !== false };
    if (!cut.tr.magnetic) cut.clip.start = clipEnd(cut.prev) - dur;
    else if (old) { /* layoutTrack recomputes the starts */ }
  }
  function removeTransition(cut) {
    if (!cut.clip.tIn) return;
    if (!cut.tr.magnetic) cut.clip.start = clipEnd(cut.prev);
    delete cut.clip.tIn;
  }
  function selectCut(trackId, clipId) {
    const cut = cutAt(trackId, clipId);
    if (!cut) return;
    selectedId = null;
    selectedTrackId = null;
    selTrans = { track: trackId, clip: clipId };
    if (!cut.clip.tIn) {
      commit(() => { const c2 = cutAt(trackId, clipId); if (c2) setTransition(c2, lastTrans || { type: 'fade', dur: 0.5 }); });
    } else afterSelect();
  }
  let lastTrans = null; // the last chosen transition is the default for the next cut
  function updateTransPanel() {
    const panel = $('transPanel');
    const cut = selTrans && !selectedId && !selectedTrackId ? cutAt(selTrans.track, selTrans.clip) : null;
    if (!cut || !cut.clip.tIn) { panel.hidden = true; if (selTrans && (!cut || !cut.clip.tIn)) selTrans = null; return; }
    panel.hidden = false;
    const t = cut.clip.tIn;
    $('trTitle').textContent = `${TRANS_NAMES[t.type]} · between clip ${cut.idx} and ${cut.idx + 1}`;
    $('trTypes').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.type === t.type));
    const dirs = TRANS_DIRS[t.type];
    $('trDirRow').hidden = !dirs;
    if (dirs) {
      $('trDir').replaceChildren(...dirs.map((d) => {
        const b = Object.assign(document.createElement('button'), { type: 'button', className: 'seg-btn' + (t.dir === d ? ' active' : ''), textContent: DIR_LABEL[d] });
        b.dataset.dir = d;
        return b;
      }));
    }
    const max = maxTransDur(cut.prev, cut.clip);
    $('trDur').max = max.toFixed(1);
    if (document.activeElement !== $('trDur')) $('trDur').value = t.dur;
    $('trDurVal').textContent = t.dur.toFixed(1) + ' s';
    $('trAudio').checked = t.audio !== false;
    syncRollSlider();
  }
  const editCut = (fn) => {
    const cut = selTrans && cutAt(selTrans.track, selTrans.clip);
    if (!cut || !cut.clip.tIn) return;
    commit(() => { const c2 = cutAt(selTrans.track, selTrans.clip); if (c2) fn(c2); });
  };
  $('trTypes').addEventListener('click', (e) => {
    const b = e.target.closest('[data-type]');
    if (!b) return;
    editCut((cut) => {
      const dirs = TRANS_DIRS[b.dataset.type];
      setTransition(cut, { ...cut.clip.tIn, type: b.dataset.type, dir: dirs && dirs.includes(cut.clip.tIn.dir) ? cut.clip.tIn.dir : dirs ? dirs[0] : 'left' });
      lastTrans = { ...cut.clip.tIn };
    });
  });
  $('trDir').addEventListener('click', (e) => {
    const b = e.target.closest('[data-dir]');
    if (b) editCut((cut) => { cut.clip.tIn.dir = b.dataset.dir; lastTrans = { ...cut.clip.tIn }; });
  });
  $('trAudio').addEventListener('change', (e) => editCut((cut) => { cut.clip.tIn.audio = e.target.checked; lastTrans = { ...cut.clip.tIn }; }));
  // Duration: live while dragging, one undo step.
  $('trDur').addEventListener('input', (e) => {
    const cut = selTrans && cutAt(selTrans.track, selTrans.clip);
    if (!cut || !cut.clip.tIn) return;
    if (!clipLiveBefore) clipLiveBefore = snapshot();
    setTransition(cut, { ...cut.clip.tIn, dur: +e.target.value });
    layoutTrack(cut.tr);
    $('trDurVal').textContent = cut.clip.tIn.dur.toFixed(1) + ' s';
    renderClips();
    updateTime();
    renderPreview();
  });
  $('trDur').addEventListener('change', () => {
    const cut = selTrans && cutAt(selTrans.track, selTrans.clip);
    if (cut && cut.clip.tIn) lastTrans = { ...cut.clip.tIn };
    liveClipCommit();
  });
  $('trAll').addEventListener('click', () => {
    const cut = selTrans && cutAt(selTrans.track, selTrans.clip);
    if (!cut || !cut.clip.tIn) return;
    const t = { ...cut.clip.tIn };
    let n = 0;
    commit(() => {
      const tr = cut.tr;
      // Work from the end so moving clips on free tracks doesn't break the other cuts.
      for (let i = tr.clips.length - 1; i >= 1; i--) {
        const c2 = cutAt(tr.id, tr.clips[i].id);
        if (c2) { setTransition(c2, t); n++; }
        if (tr.magnetic) layoutTrack(tr);
      }
    });
    toast(`${TRANS_NAMES[t.type]} on ${n} cut${n === 1 ? '' : 's'}.`, 2000);
  });
  // Move the cut under a transition ("roll"): the first clip ends later, the second starts
  // later in its media (or the other way round); the overall length stays the same.
  function rollRange(cut) {
    const a = cut.prev, b = cut.clip, dur = b.tIn ? b.tIn.dur : 0;
    const still = (c) => c.kind === 'image' || c.kind === 'color' || c.kind === 'text';
    const sa = srcOf(a), sb = srcOf(b);
    let lo = -(clipLen(a) - 2 * dur - 0.05), hi = clipLen(b) - 2 * dur - 0.05;
    if (!still(a) && sa) hi = Math.min(hi, (sa.kind === 'audio' ? sa.duration : sa.rangeOut) - a.out);
    if (!still(b) && sb) lo = Math.max(lo, (sb.kind === 'audio' ? 0 : sb.rangeIn) - b.in);
    return { lo: Math.min(0, lo), hi: Math.max(0, hi) };
  }
  function applyRoll(cut, d) {
    const a = cut.prev, b = cut.clip;
    const still = b.kind === 'image' || b.kind === 'color' || b.kind === 'text';
    a.out += d;
    if (still) b.out -= d; else b.in += d;
    if (!cut.tr.magnetic) b.start = clipEnd(a) - (b.tIn ? b.tIn.dur : 0);
    layoutTrack(cut.tr);
  }
  let roll = null; // { base: snapshot clips of the cut, range }
  function rollTo(d) {
    if (!roll) return;
    const cut = cutAt(roll.track, roll.clip);
    if (!cut) return;
    d = clamp(d, roll.range.lo, roll.range.hi);
    // Always from the state when the move started, so rounding doesn't add up.
    Object.assign(cut.prev, roll.a);
    Object.assign(cut.clip, roll.b);
    applyRoll(cut, d);
    roll.d = d;
    $('trMoveVal').textContent = (d >= 0 ? '+' : '−') + Math.abs(d).toFixed(2) + ' s';
    renderClips();
    updateTime();
    renderPreview();
  }
  function startRoll() {
    const cut = selTrans && cutAt(selTrans.track, selTrans.clip);
    if (!cut || !cut.clip.tIn) return false;
    if (!clipLiveBefore) clipLiveBefore = snapshot();
    roll = { track: cut.tr.id, clip: cut.clip.id, a: { out: cut.prev.out, start: cut.prev.start }, b: { in: cut.clip.in, out: cut.clip.out, start: cut.clip.start, tIn: { ...cut.clip.tIn } }, range: rollRange(cut), d: 0 };
    return true;
  }
  function endRoll() {
    if (!roll) return;
    const moved = Math.abs(roll.d) > 1e-4;
    roll = null;
    if (moved) liveClipCommit(); else { clipLiveBefore = null; renderTimeline(); }
  }
  function syncRollSlider() {
    const cut = selTrans && cutAt(selTrans.track, selTrans.clip);
    if (!cut || !cut.clip.tIn || roll) return;
    const r = rollRange(cut);
    $('trMove').min = r.lo.toFixed(2);
    $('trMove').max = r.hi.toFixed(2);
    $('trMove').value = 0;
    $('trMove').disabled = r.hi - r.lo < 0.02;
    $('trMoveVal').textContent = '0.00 s';
  }
  $('trMove').addEventListener('input', (e) => { if (!roll && !startRoll()) return; rollTo(+e.target.value); });
  $('trMove').addEventListener('change', () => { endRoll(); syncRollSlider(); });

  $('trRemove').addEventListener('click', () => { editCut((cut) => removeTransition(cut)); selTrans = null; updateTransPanel(); });
  $('trClose').addEventListener('click', () => { selTrans = null; renderClips(); updateTransPanel(); });

  // ---------------------------------------------------------------------------
  // Track panel (opacity, volume, magnetic, order, delete)
  // ---------------------------------------------------------------------------
  const trackLabel = (tr) => (tr.main ? 'Main track' : isAudioTrack(tr) ? `Audio ${audioTracks().indexOf(tr) + 1}` : `Track ${tracks.indexOf(tr) + 1}`);
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
    $('tpOpacityRow').hidden = isAudioTrack(tr);
    const fa = firstAudioIndex();
    if (isAudioTrack(tr)) {
      $('tpUp').disabled = ti <= fa;
      $('tpDown').disabled = ti >= tracks.length - 1;
    } else {
      $('tpUp').disabled = tr.main || ti >= fa - 1;
      $('tpDown').disabled = tr.main || ti <= 1;
    }
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
  // dir: +1 = up on the screen, -1 = down.
  function moveTrack(dir) {
    const tr = findTrack(selectedTrackId);
    if (!tr || tr.main) return;
    const fa = firstAudioIndex();
    const i = tracks.indexOf(tr);
    const j = isAudioTrack(tr) ? i - dir : i + dir; // audio tracks are stored top to bottom
    if (isAudioTrack(tr) ? (j < fa || j >= tracks.length) : (j < 1 || j >= fa)) return;
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
  // Display order: visual tracks top to bottom (main last), then the audio tracks.
  const displayTracks = () => { const fa = firstAudioIndex(); return [...tracks.slice(0, fa).reverse(), ...tracks.slice(fa)]; };

  // Phones: the playhead stays in the middle and the timeline moves under it.
  // Desktop: the playhead moves freely (click/drag in the ruler or on the
  // line); scrolling only moves the view.
  const freeHead = !isCoarse;
  if (freeHead) {
    document.body.classList.add('free-head');
    document.querySelector('.below-timeline .hint').textContent = 'Click a clip to select it, then drag it — sideways to move it, up or down to another track. Click or drag in the time ruler to move the playhead. Click a track\'s left edge for its settings.';
  }
  const pad = () => (freeHead ? 16 : timeline.clientWidth / 2);
  const timeX = (t) => pad() + t * pps;
  const fitWidth = () => Math.max(50, timeline.clientWidth - (freeHead ? 2 * pad() : 0));
  function placePlayhead() {
    const line = $('playheadLine');
    if (!freeHead) { line.style.left = (timeline.offsetLeft + timeline.clientWidth / 2) + 'px'; return; }
    const x = timeX(playhead) - timeline.scrollLeft;
    line.style.left = (timeline.offsetLeft + x) + 'px';
    line.style.visibility = x < -1 || x > timeline.clientWidth + 1 ? 'hidden' : '';
  }
  function clampPps(v) {
    const total = Math.max(0.5, totalDuration());
    return clamp(v, Math.max(2, (timeline.clientWidth * 0.5) / total), Math.min(3000, MAX_WIDTH / total));
  }
  let ppsUserSet = false;
  let lastTrackCount = 0;

  function renderTimeline() {
    if ($('editorScreen').hidden) return;
    const total = totalDuration();
    if (!ppsUserSet && total > 0) pps = fitWidth() / total; // fit (limited by clampPps below)
    pps = clampPps(pps);
    const p = pad();
    tlInner.style.width = (p * 2 + total * pps) + 'px';
    placePlayhead();
    // Height: show `settings.rows` tracks before scrolling vertically.
    const shown = [tracks[0], ...tracks.slice(1)].slice(0, settings.rows);
    const maxH = RULER_H + shown.reduce((s, t) => s + rowH(t), 0) + 6;
    // The wide layout gives the timeline all the remaining height.
    const wideNow = document.body.classList.contains('wide');
    timeline.style.maxHeight = wideNow ? '' : maxH + 'px';
    trackHeads.style.maxHeight = wideNow ? '' : maxH + 'px';

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
    // Markers: a flag in the ruler and a thin line across the tracks
    tlInner.querySelectorAll('.mk-line').forEach((x) => x.remove());
    for (const m of markersOf()) {
      const x = p + m.t * pps;
      const f = document.createElement('div');
      f.className = 'marker';
      f.dataset.marker = m.id;
      f.style.left = x + 'px';
      f.style.setProperty('--mk', m.color || MARKER_COLORS[0]);
      f.title = (m.label || 'Index') + ' · ' + fmtTime(m.t) + ' — tap: jump there · tap again: edit · drag: move';
      const lab = document.createElement('span');
      lab.textContent = m.label || '';
      f.append(lab);
      frag.appendChild(f);
      const ln = document.createElement('div');
      ln.className = 'mk-line';
      ln.style.left = x + 'px';
      ln.style.setProperty('--mk', m.color || MARKER_COLORS[0]);
      tlInner.appendChild(ln);
    }
    tlRuler.replaceChildren(frag);
    renderClips();
    renderTrackHeads();
    renderMediaList();
    // New tracks: keep the main track in view.
    if (tracks.length !== lastTrackCount) { scrollToMain(); lastTrackCount = tracks.length; }
    syncScroll();
    updateToolbar();
    updateTime();
    updatePreviewAspect();
    setHint('many', maxConcurrentVideos() >= 3 ? 'Three or more videos play at the same time here — the preview may stutter on this device. The created video is not affected.' : null);
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
    el.className = 'clip' + (c.attach && isAttachedNow(c) ? ' attached' : '') + (c.group ? ' grouped' : '') + (selIds.has(c.id) ? ' selected' : '') + (selIds.size > 1 && c.id === selectedId ? ' primary' : '') + (c.kind === 'color' ? ' color-clip' : '') + (c.kind === 'text' ? ' text-clip' : '') + (c.kind === 'audio' ? ' audio-clip' : tr.main ? '' : ' overlay');
    if (c.kind === 'color') el.style.background = c.color || DEFAULT_COLOR;
    el.dataset.id = c.id;
    el.dataset.idx = i;
    const w = Math.max(3, len * pps - 2);
    const h = rowH(tr) - 4;
    el.style.left = (p + c.start * pps + 1) + 'px';
    el.style.width = w + 'px';
    el.style.height = h + 'px';
    if (c.kind === 'audio') el.appendChild(waveform(c, src, w, h));
    else if (src && src.thumbs.length) {
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
      const nm = src ? src.name : c.kind === 'color' ? 'Color' : c.kind === 'text' ? textOf(c).content.split('\n')[0].slice(0, 40) : '';
      label.textContent = `${fmtTime(len, false)}${w > 140 && nm ? ' · ' + nm : ''}`;
      el.appendChild(label);
    }
    // Trim handles on the (single) selected clip.
    if (selIds.size === 1 && c.id === selectedId) {
      for (const side of ['l', 'r']) {
        const hd = document.createElement('span');
        hd.className = 'trim-h ' + side;
        hd.dataset.side = side;
        hd.title = side === 'l' ? 'Drag to trim the start' : 'Drag to trim the end';
        el.appendChild(hd);
      }
    }
    if (c.muted) {
      const m = document.createElement('span');
      m.className = 'clip-muted';
      m.innerHTML = MUTE_SVG;
      el.appendChild(m);
    }
    // Fades as darkened ramps; volume ≠ 100 % as a small badge.
    for (const [k, cls] of [['fadeIn', 'fade-in'], ['fadeOut', 'fade-out']]) {
      if (!(c[k] > 0) || !isSoundClip(c)) continue;
      const f = document.createElement('span');
      f.className = 'clip-fade ' + cls;
      f.style.width = Math.min(w, c[k] * pps) + 'px';
      el.appendChild(f);
    }
    if (isSoundClip(c) && c.volume != null && Math.abs(c.volume - 1) > 0.005 && w > 40) {
      const v = document.createElement('span');
      v.className = 'clip-vol';
      v.textContent = Math.round(c.volume * 100) + '%';
      el.appendChild(v);
    }
    return el;
  }

  // Waveform of an audio clip (peaks are computed once when the sound is loaded).
  function waveform(c, src, w, h) {
    const cv = document.createElement('canvas');
    cv.className = 'wave';
    const cw = Math.max(1, Math.min(Math.round(w), 4096));
    const ch = Math.max(1, h - 4);
    cv.width = cw; cv.height = ch;
    cv.style.width = '100%';
    cv.style.height = ch + 'px';
    const x = cv.getContext('2d');
    x.fillStyle = 'rgba(255,255,255,.75)';
    const pk = src && src.peaks;
    if (!pk || !pk.length) {
      x.fillRect(0, ch / 2 - 0.5, cw, 1);
      return cv;
    }
    const rate = src.peaksRate || 50, from = src.peaksFrom || 0;
    const len = clipLen(c);
    const vol = Math.min(2, c.volume == null ? 1 : c.volume);
    for (let px = 0; px < cw; px++) {
      const t0 = c.in + (px / cw) * len, t1 = c.in + ((px + 1) / cw) * len;
      let i0 = Math.floor((t0 - from) * rate), i1 = Math.max(i0 + 1, Math.ceil((t1 - from) * rate));
      let m = 0;
      for (let i = Math.max(0, i0); i < Math.min(pk.length, i1); i++) if (pk[i] > m) m = pk[i];
      // Square root: quiet passages stay visible (closer to how loud it sounds).
      const a = Math.min(1, Math.sqrt((m / 255) * vol)) * (ch / 2 - 1);
      x.fillRect(px, ch / 2 - a, 1, Math.max(1, a * 2));
    }
    return cv;
  }

  // Keep the main track in view; show the audio tracks below it if there's room.
  function scrollToMain() {
    const row = tlRows.querySelector('.tl-row.main');
    if (!row) return;
    const bottom = Math.max(0, RULER_H + tlRows.scrollHeight - timeline.clientHeight);
    timeline.scrollTop = Math.min(row.offsetTop, bottom);
  }

  function renderClips() {
    if ($('editorScreen').hidden) return;
    syncSel();
    const frag = document.createDocumentFragment();
    for (const tr of displayTracks()) {
      const row = document.createElement('div');
      row.className = 'tl-row' + (tr.main ? ' main' : '') + (isAudioTrack(tr) ? ' audio' : '') + (tr.hidden ? ' is-hidden' : '') + (tr.id === selectedTrackId ? ' track-selected' : '');
      row.dataset.track = tr.id;
      row.style.height = rowH(tr) + 'px';
      tr.clips.forEach((c, i) => row.appendChild(clipElement(c, tr, i)));
      // Cuts between clips that meet: ⧓ for a transition, a small + to add one (not on audio tracks).
      if (!isAudioTrack(tr)) {
        tr.clips.forEach((c, i) => {
          if (i === 0) return;
          const prev = tr.clips[i - 1];
          const meets = c.tIn || Math.abs(clipEnd(prev) - c.start) < 0.01;
          if (!meets) return;
          const j = document.createElement('button');
          j.type = 'button';
          j.dataset.clip = c.id;
          j.dataset.track = tr.id;
          if (c.tIn) {
            j.className = 'trans' + (selTrans && selTrans.clip === c.id ? ' selected' : '');
            j.style.left = (timeX(c.start) + 1) + 'px';
            j.style.width = Math.max(18, c.tIn.dur * pps - 2) + 'px';
            j.title = `${TRANS_NAMES[c.tIn.type] || 'Transition'} · ${c.tIn.dur.toFixed(1)} s — tap to change`;
            j.textContent = '⧓';
          } else {
            j.className = 'junction' + (selTrans && selTrans.clip === c.id ? ' selected' : '');
            j.style.left = timeX(c.start) + 'px';
            j.title = 'Add a transition';
            j.textContent = '+';
          }
          row.appendChild(j);
        });
      }
      frag.appendChild(row);
    }
    tlRows.replaceChildren(frag);
  }

  function renderTrackHeads() {
    const frag = document.createDocumentFragment();
    const spacer = document.createElement('div');
    spacer.className = 'th-spacer';
    spacer.style.height = RULER_H + 'px';
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'th-add';
    add.id = 'addTrackBtn';
    add.title = 'Add an empty track';
    add.setAttribute('aria-label', 'Add an empty track');
    add.textContent = '+';
    spacer.appendChild(add);
    frag.appendChild(spacer);
    for (const tr of displayTracks()) {
      const h = document.createElement('div');
      h.className = 'track-head' + (tr.id === selectedTrackId ? ' selected' : '') + (tr.main ? ' main' : '') + (isAudioTrack(tr) ? ' audio' : '');
      h.style.height = rowH(tr) + 'px';
      h.dataset.track = tr.id;
      h.title = `${trackLabel(tr)} — tap for ${isAudioTrack(tr) ? 'volume' : 'opacity, volume'} and more`;
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
      if (isAudioTrack(tr)) h.append(snd); else h.append(eye, snd);
      frag.appendChild(h);
    }
    trackHeads.replaceChildren(frag);
    trackHeads.scrollTop = timeline.scrollTop;
  }

  // Empty tracks added by hand stay until they are deleted.
  function addEmptyTrack(kind) {
    commit(() => {
      const tr = newTrack(false, kind);
      tr.manual = true;
      if (kind === 'audio') tracks.push(tr); else tracks.splice(firstAudioIndex(), 0, tr);
    });
    toast(kind === 'audio' ? 'Empty audio track added at the bottom.' : 'Empty video track added at the top.', 2000);
  }
  function openTrackMenu(btn) {
    let m = $('trackAddMenu');
    if (!m) {
      m = document.createElement('div');
      m.id = 'trackAddMenu';
      m.className = 'dropdown floating';
      m.setAttribute('role', 'menu');
      m.innerHTML = '<button type="button" role="menuitem" data-kind="video"><span class="mi-icon">▭</span>Video track</button><button type="button" role="menuitem" data-kind="audio"><span class="mi-icon">♪</span>Audio track</button>';
      m.addEventListener('click', (e) => { const b = e.target.closest('[data-kind]'); if (b) { m.style.display = 'none'; addEmptyTrack(b.dataset.kind); } });
      document.body.appendChild(m);
      document.addEventListener('click', (e) => { if (!e.target.closest('#trackAddMenu') && !e.target.closest('#addTrackBtn')) m.style.display = 'none'; });
    }
    const r = btn.getBoundingClientRect();
    m.style.left = (r.left + window.scrollX) + 'px';
    m.style.top = (r.bottom + window.scrollY + 4) + 'px';
    m.style.display = m.style.display === 'block' ? 'none' : 'block';
  }

  trackHeads.addEventListener('click', (e) => {
    if (e.target.closest('#addTrackBtn')) { openTrackMenu(e.target.closest('#addTrackBtn')); return; }
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
    if (freeHead) {
      // Keep the playhead in view: page on when it runs out of the visible part.
      const x = timeX(playhead) - timeline.scrollLeft, w = timeline.clientWidth;
      if (x < 0 || x > w - 8) {
        timeline.scrollLeft = Math.max(0, timeX(playhead) - (playing ? w * 0.1 : w / 2));
        lastScrollLeft = timeline.scrollLeft;
      }
      placePlayhead();
      return;
    }
    const target = Math.round(playhead * pps);
    expectedScroll = target;
    timeline.scrollLeft = target;
    lastScrollLeft = timeline.scrollLeft;
  }
  let scrollRaf = 0;
  timeline.addEventListener('scroll', () => {
    trackHeads.scrollTop = timeline.scrollTop;
    if (freeHead) { lastScrollLeft = timeline.scrollLeft; placePlayhead(); return; }
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

  // Zoom; on desktop the time under `anchorX` (screen x in the timeline, default: the playhead) stays in place.
  function setZoom(newPps, anchorX) {
    ppsUserSet = true;
    let t = playhead, x0 = timeX(playhead) - timeline.scrollLeft;
    if (freeHead && anchorX != null) { x0 = anchorX; t = (timeline.scrollLeft + anchorX - pad()) / pps; }
    pps = clampPps(newPps);
    renderTimeline();
    if (freeHead) { timeline.scrollLeft = Math.max(0, timeX(t) - x0); placePlayhead(); }
  }
  $('zoomInBtn').addEventListener('click', () => setZoom(pps * 1.6));
  $('zoomOutBtn').addEventListener('click', () => setZoom(pps / 1.6));
  timeline.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    setZoom(pps * Math.exp(-e.deltaY * 0.01), e.clientX - timeline.getBoundingClientRect().left);
  }, { passive: false });

  // Fit: the whole project, or the selected clip (about 80 % of the width).
  function zoomFit() {
    const c = selClip();
    if (!c) {
      ppsUserSet = false;
      renderTimeline();
      if (freeHead) { timeline.scrollLeft = 0; placePlayhead(); }
      return;
    }
    const len = Math.max(0.05, clipLen(c));
    ppsUserSet = true;
    pps = clampPps((fitWidth() * 0.8) / len);
    renderTimeline();
    if (freeHead) { timeline.scrollLeft = Math.max(0, timeX(c.start + len / 2) - timeline.clientWidth / 2); placePlayhead(); }
    else { pause(); seek(c.start + len / 2); }
  }
  $('zoomFitBtn').addEventListener('click', zoomFit);

  // Desktop: click or drag in the ruler, or drag the playhead line, to set the playhead.
  const timeAtClientX = (x) => clamp((x - timeline.getBoundingClientRect().left + timeline.scrollLeft - pad()) / pps, 0, totalDuration());
  let headDrag = null;
  function startHeadDrag(e) {
    if (!freeHead || e.button > 0) return;
    e.preventDefault();
    pause();
    headDrag = { id: e.pointerId };
    seek(timeAtClientX(e.clientX), true);
  }
  tlRuler.addEventListener('pointerdown', startHeadDrag);
  $('playheadLine').addEventListener('pointerdown', startHeadDrag);
  window.addEventListener('pointermove', (e) => {
    if (!headDrag || e.pointerId !== headDrag.id) return;
    // Scroll along at the edges.
    const r = timeline.getBoundingClientRect();
    if (e.clientX > r.right - 20) timeline.scrollLeft += 12; else if (e.clientX < r.left + 20) timeline.scrollLeft -= 12;
    seek(timeAtClientX(clamp(e.clientX, r.left, r.right)), true);
  });
  const endHeadDrag = (e) => { if (headDrag && e.pointerId === headDrag.id) headDrag = null; };
  window.addEventListener('pointerup', endHeadDrag);
  window.addEventListener('pointercancel', endHeadDrag);

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
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(applyLayout, 120); });

  function initMediaDrop() {
  timeline.addEventListener('dragover', (e) => {
    if (![...e.dataTransfer.types].includes(MEDIA_DND)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const row = rowAtY(e.clientY);
    tlRows.querySelectorAll('.drop-target').forEach((r) => { if (r !== row) r.classList.remove('drop-target'); });
    if (row) row.classList.add('drop-target');
  });
  timeline.addEventListener('dragleave', (e) => { if (!timeline.contains(e.relatedTarget)) tlRows.querySelectorAll('.drop-target').forEach((r) => r.classList.remove('drop-target')); });
  timeline.addEventListener('drop', (e) => {
    const id = e.dataTransfer.getData(MEDIA_DND);
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    tlRows.querySelectorAll('.drop-target').forEach((r) => r.classList.remove('drop-target'));
    const src = sources.get(id);
    if (!src || src.missing) return;
    const t = Math.max(0, (e.clientX - timeline.getBoundingClientRect().left + timeline.scrollLeft - pad()) / pps);
    const row = rowAtY(e.clientY);
    let tr = row ? findTrack(row.dataset.track) : null;
    const c = clipFromSource(src);
    commit(() => {
      const audio = c.kind === 'audio';
      if (tr && isAudioTrack(tr) !== audio) tr = null; // wrong kind of track: find a fitting one
      if (tr && tr.magnetic) {
        let idx = 0;
        for (const x of tr.clips) if (t > x.start + clipLen(x) / 2) idx++;
        tr.clips.splice(idx, 0, c);
      } else if (tr && !overlaps(tr, t, clipLen(c))) {
        c.start = t;
        tr.clips.push(c);
      } else if (audio) placeAudio(c, t);
      else { if (!allClips().length) tracks[0].clips.push(c); else placeOverlay(c, t); }
      selectedId = c.id;
    });
  });
  }

  // ---------------------------------------------------------------------------
  // Layout: classic (one column) or wide (preview | settings, timeline below,
  // resizable). Menu → View.
  // ---------------------------------------------------------------------------
  const ARRANGE = { balanced: { top: 58, side: 380 }, preview: { top: 68, side: 340 }, timeline: { top: 44, side: 380 } };
  const view = { layout: store.get('layout', 'auto'), arrange: store.get('arrange', 'balanced'), sizes: store.get('panelSizes', null), mediaCol: store.get('mediaCol', false) };
  const isWide = () => view.layout === 'wide' || (view.layout === 'auto' && window.innerWidth >= 1200);
  function syncPvH() {
    const wrap = $('previewWrap');
    if (document.body.classList.contains('wide') && wrap.clientHeight) preview.style.setProperty('--pv-h', wrap.clientHeight + 'px');
    else preview.style.removeProperty('--pv-h');
  }
  function applyLayout() {
    const wide = isWide();
    document.body.classList.toggle('wide', wide);
    // Optional media column on the left: the media card moves there and opens.
    const col = wide && view.mediaCol;
    document.body.classList.toggle('media-col', col);
    const card = $('mediaCard');
    if (col && card.parentNode !== $('edMedia')) { $('edMedia').appendChild(card); if ($('mediaCard').classList.contains('collapsed')) setMediaFolded(false); }
    else if (!col && card.parentNode === $('edMedia')) $('edSide').insertBefore(card, $('canvasCard'));
    const sz = view.sizes || ARRANGE[view.arrange] || ARRANGE.balanced;
    const ed = $('editorScreen');
    ed.style.setProperty('--top-h', sz.top + '%');
    ed.style.setProperty('--side-w', sz.side + 'px');
    syncPvH();
    renderTimeline();
    updatePreviewAspect();
    syncViewUI();
  }
  if (window.ResizeObserver) new ResizeObserver(() => { syncPvH(); renderPreview(); }).observe($('previewWrap'));
  function syncViewUI() {
    $('layoutSeg').querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.layout === view.layout));
    $('arrangeSeg').querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', !view.sizes && b.dataset.arrange === view.arrange));
    $('mediaColChk').checked = !!view.mediaCol;
  }
  const saveView = () => { store.set('layout', view.layout); store.set('arrange', view.arrange); store.set('panelSizes', view.sizes); store.set('mediaCol', view.mediaCol); };
  $('mediaColChk').addEventListener('change', (e) => { view.mediaCol = e.target.checked; if (view.mediaCol && view.layout === 'classic') view.layout = 'auto'; saveView(); applyLayout(); });
  $('layoutSeg').addEventListener('click', (e) => { const b = e.target.closest('[data-layout]'); if (!b) return; view.layout = b.dataset.layout; saveView(); applyLayout(); });
  $('arrangeSeg').addEventListener('click', (e) => {
    const b = e.target.closest('[data-arrange]');
    if (!b) return;
    view.arrange = b.dataset.arrange;
    view.sizes = null;
    if (view.layout === 'classic') view.layout = 'auto';
    saveView(); applyLayout();
  });
  const resetSizes = () => { view.sizes = null; saveView(); applyLayout(); };
  $('resetSizesBtn').addEventListener('click', resetSizes);
  $('viewItem').addEventListener('click', () => { closeMenu(); syncViewUI(); openModal('viewModal'); });
  $('viewCloseBtn').addEventListener('click', () => closeModal('viewModal'));
  $('viewModal').addEventListener('click', (e) => { if (e.target.id === 'viewModal') closeModal('viewModal'); });

  // Drag the borders between the areas; double-click resets.
  function splitDrag(el, axis) {
    el.addEventListener('dblclick', resetSizes);
    el.addEventListener('pointerdown', (e) => {
      if (e.button > 0) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      el.classList.add('active');
      const r = $('editorScreen').getBoundingClientRect();
      const cur = { ...(view.sizes || ARRANGE[view.arrange] || ARRANGE.balanced) };
      const move = (ev) => {
        if (axis === 'x') cur.side = Math.round(clamp(r.right - ev.clientX - 4, 260, Math.max(300, r.width * 0.55)));
        else cur.top = Math.round(clamp(((ev.clientY - r.top) / r.height) * 100, 22, 82) * 10) / 10;
        view.sizes = cur;
        const ed = $('editorScreen');
        ed.style.setProperty('--top-h', cur.top + '%');
        ed.style.setProperty('--side-w', cur.side + 'px');
        syncPvH();
        renderPreview();
      };
      const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
        el.classList.remove('active');
        saveView();
        applyLayout();
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
  }
  splitDrag($('splitV'), 'x');
  splitDrag($('splitH'), 'y');

  // ---------------------------------------------------------------------------
  // Clip selection and dragging (only the selected clip can be dragged):
  // sideways = reorder (magnetic main track) or move in time (free tracks),
  // up/down = move to another track; above the top track = new track.
  // ---------------------------------------------------------------------------
  let drag = null;
  let suppressClick = false;

  function afterSelect() {
    syncSel();
    if (selectedId) { selectedTrackId = null; selTrans = null; }
    renderClips();
    renderTrackHeads();
    updateToolbar();
    syncSelBar();
    if (selectedId && !multi() && cpTab !== 'clip' && cpTab !== 'audio' && cpTab !== 'fade') ensureVisible();
    renderPreview();
  }
  tlRows.addEventListener('click', (e) => {
    if (suppressClick) { suppressClick = false; return; }
    const cutBtn = e.target.closest('.trans, .junction');
    if (cutBtn) { selectCut(cutBtn.dataset.track, cutBtn.dataset.clip); return; }
    const el = e.target.closest('.clip');
    const add = e.ctrlKey || e.metaKey;
    syncSel();
    if (!el) {
      if (!add && !e.shiftKey && !selectMode) selectedId = null;
    } else {
      const id = el.dataset.id;
      if (e.shiftKey && selAnchor && findClip(selAnchor)) selectRange(selAnchor, id, add);
      else if (add || selectMode) selectToggle(id);
      else if (selectedId === id && selIds.size === 1) selectedId = null;
      else if (wholeGroupSelected(id)) selectJust(id); // tap again: just this clip of the group
      else {
        selectOnly(id);
        if (selIds.size > 1 && !store.get('groupTip', false)) { store.set('groupTip', true); toast('A group is selected — tap the clip again to edit only that one.', 3500); }
      }
    }
    afterSelect();
  });

  // ---------------------------------------------------------------------------
  // Trimming: drag the start or end edge of the selected clip. On the magnetic
  // main track the following clips move along; on free tracks a clip stops at
  // its neighbours. Videos and sounds can't grow beyond their media; images and
  // color clips can. Edges snap like dragged clips. One undo step per drag.
  // ---------------------------------------------------------------------------
  const MIN_LEN = 0.05;
  let trim = null;
  function startTrim(e, handle) {
    e.preventDefault();
    e.stopPropagation();
    const f = findClip(handle.closest('.clip').dataset.id);
    if (!f) return;
    const src = srcOf(f.clip);
    const c = f.clip;
    const still = c.kind === 'image' || c.kind === 'color';
    // Media limits in media time.
    let minIn = -Infinity, maxOut = Infinity;
    if (!still && src) {
      if (src.kind === 'audio') { minIn = 0; maxOut = src.duration; }
      else { minIn = src.rangeIn; maxOut = src.rangeOut; }
    }
    pause();
    trim = { id: c.id, side: handle.dataset.side, x0: e.clientX, scroll0: timeline.scrollLeft, pointerId: e.pointerId, orig: { ...c }, still, minIn, maxOut, moved: false };
  }
  window.addEventListener('pointermove', (e) => {
    if (!trim || e.pointerId !== trim.pointerId) return;
    const f = findClip(trim.id);
    if (!f) return;
    const dx = e.clientX - trim.x0 + (timeline.scrollLeft - trim.scroll0);
    if (!trim.moved && Math.abs(dx) < 3) return;
    if (!trim.moved) { trim.moved = true; if (!clipLiveBefore) clipLiveBefore = snapshot(); }
    const o = trim.orig, len0 = o.out - o.in, end0 = o.start + len0;
    const others = f.tr.clips.filter((c) => c.id !== o.id);
    const prevEnd = f.tr.magnetic ? 0 : Math.max(0, ...others.filter((c) => clipEnd(c) <= o.start + 1e-6).map(clipEnd));
    const nextStart = f.tr.magnetic ? Infinity : Math.min(Infinity, ...others.filter((c) => c.start >= end0 - 1e-6).map((c) => c.start));
    let dt = dx / pps;
    const thr = (isCoarse ? 20 : 14) / pps;
    const snapTo = (t) => {
      if (!settings.snap || e.altKey) return null;
      let best = null;
      const cands = [playhead, ...markersOf().map((m) => m.t)];
      for (const c of allClips()) if (c.id !== o.id) cands.push(c.start, clipEnd(c));
      for (const cnd of cands) { const d = Math.abs(t - cnd); if (d < thr && (!best || d < best.d)) best = { d, t: cnd }; }
      return best;
    };
    const c = { ...f.clip };
    let snapAt = null;
    if (trim.side === 'r') {
      let end = end0 + dt;
      const sn = snapTo(end);
      if (sn) { end = sn.t; snapAt = sn.t; }
      end = clamp(end, o.start + MIN_LEN, Math.min(nextStart, o.start + (trim.maxOut - o.in)));
      c.out = o.in + (end - o.start);
    } else {
      let start = o.start + dt;
      if (!f.tr.magnetic) { const sn = snapTo(start); if (sn) { start = sn.t; snapAt = sn.t; } }
      // The start can't move before the previous clip, the media's start or 0.
      const lo = f.tr.magnetic ? o.start - (o.in - trim.minIn) : Math.max(prevEnd, o.start - (o.in - trim.minIn));
      start = clamp(start, lo, end0 - MIN_LEN);
      const d = start - o.start;
      if (trim.still) { c.in = 0; c.out = len0 - d; } else { c.in = o.in + d; c.out = o.out; }
      c.start = f.tr.magnetic ? o.start : start; // magnetic: the clip stays put and the rest follows
    }
    // Fades never get longer than the clip.
    const len = c.out - c.in;
    if ((c.fadeIn || 0) + (c.fadeOut || 0) > len) { c.fadeIn = Math.min(c.fadeIn || 0, len / 2); c.fadeOut = Math.min(c.fadeOut || 0, len / 2); }
    f.tr.clips[f.idx] = c;
    layoutTrack(f.tr);
    if (snapAt != null) { renderClips(); showSnapLine(snapAt); } else renderClips();
    syncTimeUI();
    updateTime();
    renderPreview();
  });
  const endTrim = (e) => {
    if (!trim || e.pointerId !== trim.pointerId) return;
    const t = trim;
    trim = null;
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 50);
    if (!t.moved) return;
    const now = findClip(t.id);
    if (now && now.clip.in === t.orig.in && now.clip.out === t.orig.out && now.clip.start === t.orig.start) { clipLiveBefore = null; renderTimeline(); return; } // nothing changed
    if (canvasState.cropClipId === t.id) syncCropCanvas();
    liveClipCommit();
  };
  window.addEventListener('pointerup', endTrim);
  window.addEventListener('pointercancel', endTrim);

  // Desktop: drag a frame in an empty part of the timeline to select the clips in it.
  let marquee = null;
  // Phones: a long press on a clip starts the multi-selection.
  let longPress = null;
  let longPressFired = false;
  tlRows.addEventListener('contextmenu', (e) => { if (isCoarse) e.preventDefault(); });

  // Drag the ⧓ of a transition sideways to move the cut (snaps to the playhead).
  let transDrag = null;
  tlRows.addEventListener('pointerdown', (e) => {
    const tb = e.target.closest('.trans');
    if (!tb || e.button > 0) return;
    transDrag = { x0: e.clientX, scroll0: timeline.scrollLeft, id: e.pointerId, track: tb.dataset.track, clip: tb.dataset.clip, active: false };
  }, true);
  window.addEventListener('pointermove', (e) => {
    if (!transDrag || e.pointerId !== transDrag.id) return;
    const dx = e.clientX - transDrag.x0 + (timeline.scrollLeft - transDrag.scroll0);
    if (!transDrag.active) {
      if (Math.abs(dx) < 5) return;
      transDrag.active = true;
      selTrans = { track: transDrag.track, clip: transDrag.clip };
      selectedId = null;
      if (!startRoll()) { transDrag = null; return; }
      updateTransPanel();
      const cut = cutAt(transDrag.track, transDrag.clip);
      transDrag.mid0 = cut.clip.start + cut.clip.tIn.dur / 2;
    }
    let d = dx / pps;
    // Snap the middle of the transition to the playhead.
    if (settings.snap && !e.altKey && Math.abs(transDrag.mid0 + d - playhead) < (isCoarse ? 20 : 14) / pps) d = playhead - transDrag.mid0;
    rollTo(d);
    $('trMove').value = roll ? roll.d : 0;
  });
  const endTransDrag = (e) => {
    if (!transDrag || e.pointerId !== transDrag.id) return;
    const was = transDrag.active;
    transDrag = null;
    if (!was) return;
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 50);
    endRoll();
    updateTransPanel();
  };
  window.addEventListener('pointerup', endTransDrag);
  window.addEventListener('pointercancel', endTransDrag);

  tlRows.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    if (e.target.closest('.trans, .junction')) return;
    const handle = e.target.closest('.trim-h');
    if (handle) { startTrim(e, handle); return; }
    const el = e.target.closest('.clip');
    if (!el) {
      if (freeHead && e.pointerType === 'mouse') {
        const r = tlRows.getBoundingClientRect();
        marquee = { x0: e.clientX - r.left, y0: e.clientY - r.top, add: e.ctrlKey || e.metaKey || e.shiftKey, active: false, pointerId: e.pointerId, el: null };
      }
      return;
    }
    if (e.pointerType !== 'mouse') {
      const id = el.dataset.id;
      longPress = { id, x: e.clientX, y: e.clientY, pointerId: e.pointerId, timer: setTimeout(() => {
        longPress = null;
        drag = null;
        selectMode = true;
        syncSel();
        if (!selIds.has(id)) selectToggle(id);
        suppressClick = true;   // the click that may follow the long press
        longPressFired = true;
        if (settings.haptics && navigator.vibrate) { try { navigator.vibrate(20); } catch (err) { /* ignore */ } }
        afterSelect();
      }, 500) };
    }
    syncSel();
    if (!selIds.has(el.dataset.id)) return; // only selected clips can be dragged (also in select mode)
    let group = null;
    if (multi()) {
      group = selFinds();
      // Only the main track can be magnetic; other magnetic cases don't exist.
      if (group.some((g) => g.tr.magnetic && g.ti !== 0)) group = null;
    }
    drag = { el, id: el.dataset.id, group, startX: e.clientX, startY: e.clientY, pointerId: e.pointerId, active: false, marker: null, raf: 0, lastX: e.clientX, lastY: e.clientY, target: null };
  });
  window.addEventListener('pointermove', (e) => {
    if (longPress && e.pointerId === longPress.pointerId && Math.hypot(e.clientX - longPress.x, e.clientY - longPress.y) > 8) { clearTimeout(longPress.timer); longPress = null; }
    if (!marquee || e.pointerId !== marquee.pointerId) return;
    const r = tlRows.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    if (!marquee.active) {
      if (Math.hypot(x - marquee.x0, y - marquee.y0) < 5) return;
      marquee.active = true;
      marquee.el = document.createElement('div');
      marquee.el.className = 'marquee';
      tlRows.appendChild(marquee.el);
    }
    const l = Math.min(x, marquee.x0), t = Math.min(y, marquee.y0);
    Object.assign(marquee.el.style, { left: l + 'px', top: t + 'px', width: Math.abs(x - marquee.x0) + 'px', height: Math.abs(y - marquee.y0) + 'px' });
    // Scroll along at the edges.
    const tr = timeline.getBoundingClientRect();
    if (e.clientX > tr.right - 20) timeline.scrollLeft += 10; else if (e.clientX < tr.left + 20) timeline.scrollLeft -= 10;
  });
  const endPress = (e) => {
    if (longPress && e.pointerId === longPress.pointerId) { clearTimeout(longPress.timer); longPress = null; }
    // Browsers often send no click after a long press: don't swallow the next tap.
    if (longPressFired) { longPressFired = false; setTimeout(() => { suppressClick = false; }, 120); }
    if (!marquee || e.pointerId !== marquee.pointerId) return;
    const m = marquee;
    marquee = null;
    if (!m.active) return;
    const box = m.el.getBoundingClientRect();
    m.el.remove();
    const ids = [...tlRows.querySelectorAll('.clip')].filter((c) => {
      const b = c.getBoundingClientRect();
      return b.right > box.left && b.left < box.right && b.bottom > box.top && b.top < box.bottom;
    }).map((c) => c.dataset.id);
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 50);
    syncSel();
    selectSet(ids, m.add);
    afterSelect();
  };
  window.addEventListener('pointerup', endPress);
  window.addEventListener('pointercancel', endPress);

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
      if (drag.group) {
        drag.main = tracks[0].magnetic ? drag.group.filter((g) => g.ti === 0).sort((a, b) => a.clip.start - b.clip.start) : [];
        drag.els = drag.group.map((g) => { const el = tlRows.querySelector(`.clip[data-id="${g.clip.id}"]`); if (el) el.classList.add('dragging'); return { el, left: el ? parseFloat(el.style.left) : 0 }; });
        drag.g0 = Math.min(...drag.group.map((g) => g.clip.start));
        drag.g1 = Math.max(...drag.group.map((g) => clipEnd(g.clip)));
      }
      drag.marker = document.createElement('div');
      drag.marker.className = 'drop-marker';
      drag.marker.hidden = true;
      tlRows.appendChild(drag.marker);
      autoScroll();
    }
    drag.lastX = e.clientX;
    drag.lastY = e.clientY;
    drag.alt = e.altKey;
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
    if (drag.group && drag.main.length) {
      // Several clips incl. some of the magnetic main track: those move as a block to
      // a new place in the main track, the others shift by the same amount of time.
      const ids = new Set(drag.group.map((g) => g.clip.id));
      const main = tracks[0];
      const others = main.clips.filter((c) => !ids.has(c.id));
      const rect = timeline.getBoundingClientRect();
      const time = (drag.lastX - rect.left + timeline.scrollLeft - pad()) / pps - (f.clip.start - drag.main[0].clip.start);
      let idx = 0;
      for (const c of others) if (time > c.start + clipLen(c) / 2) idx++;
      let boundary = 0;
      for (let i = 0; i < idx; i++) boundary += clipLen(others[i]);
      drag.dropIdx = idx;
      drag.delta = boundary - drag.main[0].clip.start;
      const mainIds = new Set(drag.main.map((g) => g.clip.id));
      drag.els.forEach((x, i) => {
        if (!x.el) return;
        const g = drag.group[i];
        x.el.style.left = (mainIds.has(g.clip.id) ? x.left + dx : x.left + drag.delta * pps) + 'px';
      });
      const row = tlRows.querySelector('.tl-row.main');
      const rb = row.getBoundingClientRect(), pb = tlRows.getBoundingClientRect();
      drag.marker.hidden = false;
      drag.marker.style.left = (pad() + boundary * pps - 1) + 'px';
      drag.marker.style.top = (rb.top - pb.top) + 'px';
      drag.marker.style.height = rb.height + 'px';
      return;
    }
    if (drag.group) {
      // Several clips: they move together in time and keep their tracks.
      const ids = new Set(drag.group.map((g) => g.clip.id));
      const len = drag.g1 - drag.g0;
      let t = Math.max(0, drag.g0 + dx / pps);
      showSnap(null);
      if (settings.snap && !drag.alt) {
        const thr = (isCoarse ? 20 : 14) / pps;
        let best = null;
        const cands = [playhead, 0, ...markersOf().map((m) => m.t)];
        for (const c of allClips()) if (!ids.has(c.id)) cands.push(c.start, clipEnd(c));
        for (const cnd of cands) for (const [edge, off] of [[t, 0], [t + len, len]]) {
          const d = Math.abs(edge - cnd);
          if (d < thr && (!best || d < best.d)) best = { d, t: cnd - off, at: cnd };
        }
        if (best) { t = Math.max(0, best.t); showSnap(best.at); }
      }
      drag.delta = t - drag.g0;
      drag.els.forEach((x) => { if (x.el) x.el.style.left = (x.left + drag.delta * pps) + 'px'; });
      return;
    }
    drag.el.style.left = (drag.origLeft + dx) + 'px';
    drag.el.style.transform = `translateY(${drag.lastY - drag.startY}px)`;
    let row = rowAtY(drag.lastY);
    let tr = row ? findTrack(row.dataset.track) : null;
    // Sound stays on audio tracks, pictures on visual tracks.
    if (f.clip.kind === 'audio') {
      if (!isAudioTrack(tr)) { tr = null; row = null; }
      drag.target = tr ? tr.id : 'newAudio';
    } else {
      if (isAudioTrack(tr)) { tr = f.tr; row = tlRows.querySelector(`.tl-row[data-track="${tr.id}"]`); }
      drag.target = tr ? tr.id : 'new';
    }
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
      // Snap the start or end to the playhead and to edges of other clips.
      // Switchable below the timeline; Alt moves freely for a moment.
      showSnap(null);
      if (!settings.snap || drag.alt) return;
      const thr = (isCoarse ? 20 : 14) / pps;
      let best = null;
      const len = clipLen(f.clip);
      const cands = [playhead, 0, ...markersOf().map((m) => m.t)];
      for (const c of allClips()) if (c.id !== drag.id) cands.push(c.start, clipEnd(c));
      for (const cnd of cands) {
        for (const [edge, off] of [[drag.time, 0], [drag.time + len, len]]) {
          const d = Math.abs(edge - cnd);
          if (d < thr && (!best || d < best.d)) best = { d, t: cnd - off, at: cnd };
        }
      }
      if (best) {
        drag.time = Math.max(0, best.t);
        // Place the dragged clip exactly where it will land and show the snap line.
        drag.el.style.left = (timeX(drag.time) + 1) + 'px';
        showSnap(best.at);
      }
    }
  }

  // Snap line while trimming (a vibration on each new snap point).
  let lastTrimSnap = null;
  function showSnapLine(t) {
    const line = document.createElement('div');
    line.className = 'snap-line';
    line.style.left = (timeX(t) - 1) + 'px';
    tlRows.appendChild(line);
    if (lastTrimSnap !== t) { lastTrimSnap = t; if (settings.haptics && navigator.vibrate) { try { navigator.vibrate(12); } catch (e) { /* ignore */ } } }
  }
  // Blue line across all tracks where a clip snaps; a short vibration (Android) on each new snap.
  let snapLine = null;
  function showSnap(t) {
    if (t == null) {
      if (snapLine) snapLine.hidden = true;
      if (drag) drag.snapAt = null;
      return;
    }
    if (!snapLine || !snapLine.isConnected) {
      snapLine = document.createElement('div');
      snapLine.className = 'snap-line';
      tlRows.appendChild(snapLine);
    }
    snapLine.hidden = false;
    snapLine.style.left = (timeX(t) - 1) + 'px';
    if (drag && drag.snapAt !== t) {
      drag.snapAt = t;
      if (settings.haptics && navigator.vibrate) { try { navigator.vibrate(12); } catch (e) { /* ignore */ } }
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
    if (d.group) {
      if (!d.delta || Math.abs(d.delta) < 1e-3) { renderTimeline(); return; }
      const keep = [...selIds];
      let moved = 0;
      commit(() => {
        const items = d.group.map((g) => findClip(g.clip.id)).filter(Boolean).map((g) => ({ c: g.clip, tr: g.tr }));
        for (const it of items) it.tr.clips.splice(it.tr.clips.indexOf(it.c), 1);
        // Main-track block: back in at the new place, in its order.
        const mainIds = new Set((d.main || []).map((g) => g.clip.id));
        if (mainIds.size) {
          const block = items.filter((it) => mainIds.has(it.c.id)).map((it) => it.c).sort((a, b) => a.start - b.start);
          tracks[0].clips.splice(clamp(d.dropIdx, 0, tracks[0].clips.length), 0, ...block);
          layoutTrack(tracks[0]);
        }
        for (const it of items) {
          if (mainIds.has(it.c.id)) continue;
          it.c.start = Math.max(0, it.c.start + d.delta);
          let tr = it.tr;
          if (overlaps(tr, it.c.start, clipLen(it.c), it.c.id)) {
            const nt = newTrack(false, tr.kind || 'video');
            tracks.splice(tracks.indexOf(tr) + 1, 0, nt);
            tr = nt;
            moved++;
          }
          tr.clips.push(it.c);
          layoutTrack(tr);
        }
      });
      selectSet(keep, false);
      selectedId = d.id;
      afterSelect();
      if (moved) toast('Some clips had no room there and moved to a new track.');
      return;
    }
    const sameTrack = d.target === f.tr.id;
    if (sameTrack && f.tr.magnetic && d.dropIdx === f.idx) { renderTimeline(); return; }
    if (sameTrack && !f.tr.magnetic && Math.abs(d.time - f.clip.start) < 1e-3) { renderTimeline(); return; }
    commit(() => {
      const c = f.clip;
      f.tr.clips.splice(f.idx, 1);
      let tr = d.target === 'new' || d.target === 'newAudio' ? null : findTrack(d.target);
      if (!tr && d.target === 'newAudio') { tr = newTrack(false, 'audio'); tracks.splice(firstAudioIndex(), 0, tr); }
      if (!tr) { tr = newTrack(false); tracks.splice(firstAudioIndex(), 0, tr); }
      if (tr.magnetic) {
        tr.clips.splice(clamp(d.dropIdx, 0, tr.clips.length), 0, c);
      } else {
        c.start = d.time;
        if (overlaps(tr, c.start, clipLen(c), c.id)) {
          // No room here: put it on a new track right above (audio: right below).
          const nt = newTrack(false, tr.kind || 'video');
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
  const auds = [];                      // <audio> elements for audio clips
  const POOL_MAX = 8;
  const PRELOAD = 1.5; // seconds ahead
  const allEls = () => [...vids, ...auds];
  function poolElement(kind) {
    const list = kind === 'audio' ? auds : vids;
    if (list.length >= POOL_MAX) return null;
    let v;
    if (kind === 'audio') {
      v = document.createElement('audio');
      v.preload = 'auto';
      v.muted = true;
      v.hidden = true;
      vids[0].parentNode.appendChild(v);
    } else {
      v = vids[0].cloneNode(false);
      v.removeAttribute('id');
      v.removeAttribute('src');
      vids[0].parentNode.insertBefore(v, vids[vids.length - 1].nextSibling);
    }
    list.push(v);
    hookVideo(v);
    connectGain(v);
    return v;
  }
  const pv = $('pvCanvas');
  const pvCtx = pv.getContext('2d', { alpha: false });
  let clock = { t0: 0, ph0: 0 };
  const unlocked = new WeakSet();

  // Volumes above 100 % need Web Audio (a media element only goes up to 1).
  // It's switched on in the first play gesture that needs it; from then on
  // every element plays through its own gain node.
  let actx = null;
  let boostBroken = false;           // Web Audio stayed silent here: preview at most 100 %
  const gains = new WeakMap();       // element -> { g: GainNode, an: AnalyserNode }
  const boost = { ok: false, silent: 0, last: 0 };
  function ensureAudioCtx() {
    if (boostBroken) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!actx && Ctx) {
      try { actx = new Ctx(); allEls().forEach(connectGain); } catch (e) { actx = null; }
    }
    if (actx && actx.state !== 'running') actx.resume().catch(() => {});
  }
  function connectGain(el) {
    if (!actx || boostBroken || gains.has(el)) return;
    try {
      const g = actx.createGain();
      const an = actx.createAnalyser();
      an.fftSize = 256;
      actx.createMediaElementSource(el).connect(g).connect(an).connect(actx.destination);
      gains.set(el, { g, an });
    } catch (e) { /* stays on element volume */ }
  }
  function setGain(el, g) {
    const node = gains.get(el);
    if (node) { el.volume = 1; node.g.gain.value = Math.max(0, g); } else el.volume = clamp(g, 0, 1);
  }
  /**
   * Some setups play nothing through Web Audio. While playing, check that sound
   * that should be audible actually arrives; if it stays silent (or the audio
   * context doesn't run), replace the elements with plain ones and play at most 100 %.
   */
  const probeBuf = new Float32Array(256);
  function checkBoost(now) {
    if (!actx || boost.ok || boostBroken || !playing) return;
    const dt = boost.last ? Math.min(0.2, (now - boost.last) / 1000) : 0;
    boost.last = now;
    let expect = false;
    for (const el of allEls()) {
      const node = gains.get(el);
      if (!node || el.paused || el.muted || node.g.gain.value <= 0.05 || el.readyState < 3) continue;
      const src = sources.get(el.dataset.src);
      if (!src || !src.hasAudio) continue;
      expect = true;
      node.an.getFloatTimeDomainData(probeBuf);
      for (let i = 0; i < probeBuf.length; i++) if (Math.abs(probeBuf[i]) > 1e-4) { boost.ok = true; return; }
    }
    if (actx.state !== 'running') expect = true;
    boost.silent = expect ? boost.silent + dt : 0;
    if (boost.silent > 2) disableBoost();
  }
  function disableBoost() {
    boostBroken = true;
    const old = actx;
    actx = null;
    // Elements routed into Web Audio can't be taken out again — replace them.
    const fresh = (el) => {
      const n = el.cloneNode(false);
      n.removeAttribute('src');
      delete n.dataset.src; delete n.dataset.url; delete n.dataset.clip;
      n.muted = true;
      el.pause();
      el.replaceWith(n);
      hookVideo(n);
      return n;
    };
    for (let i = 0; i < vids.length; i++) if (gains.has(vids[i])) vids[i] = fresh(vids[i]);
    for (let i = 0; i < auds.length; i++) if (gains.has(auds[i])) auds[i] = fresh(auds[i]);
    try { old.close(); } catch (e) { /* ignore */ }
    setHint('boost', 'This browser stayed silent with volumes above 100 % in the preview, so the preview now plays them at 100 %. The created video uses the full volume.');
    syncPool(true);
  }

  const isVideoClip = (c) => !!c && c.kind === 'video';
  const playableVideo = (c) => isVideoClip(c) && srcOf(c) && !srcOf(c).missing;
  const playableSound = (c) => !!c && c.kind === 'audio' && srcOf(c) && !srcOf(c).missing;

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
    setVideoTime(el, Math.max(0, t - (src.base || 0)));
  }
  const mediaTime = (el) => { const s = sources.get(el.dataset.src); return el.currentTime + (s ? s.base || 0 : 0); };
  const elOf = (clipId) => allEls().find((v) => v.dataset.clip === clipId) || null;

  // The time shown: at the very end the last frame stays visible.
  const viewTime = () => { const tot = totalDuration(); return playhead >= tot - 1e-6 ? Math.max(0, tot - 1e-3) : playhead; };

  // Clips with a media element playing at time t: videos on visual tracks, sounds on audio tracks.
  function activeMedia(t) {
    const out = [];
    for (const tr of tracks) {
      // Two clips at once during a transition.
      for (const c of Render.clipsAtTime(tr.clips, t)) {
        if (isAudioTrack(tr) ? playableSound(c) : playableVideo(c)) out.push({ tr, clip: c });
      }
    }
    return out;
  }
  const activeVideos = (t) => activeMedia(t).filter((a) => a.clip.kind === 'video');

  /**
   * Give every playing and upcoming clip an element, keep the playing ones in
   * sync with the playhead and set their sound (volume, fades).
   * forceTime: re-position the playing elements (after a seek).
   */
  function syncPool(forceTime) {
    const t = viewTime();
    const active = activeMedia(t);
    const upcoming = [];
    if (playing) {
      for (const tr of tracks) for (const c of tr.clips) {
        const ok = isAudioTrack(tr) ? playableSound(c) : playableVideo(c);
        if (ok && c.start > t + 1e-6 && c.start <= t + PRELOAD) upcoming.push({ tr, clip: c });
      }
      upcoming.sort((a, b) => a.clip.start - b.clip.start);
    }
    const wanted = [...active, ...upcoming];
    const ids = new Set(wanted.map((w) => w.clip.id));
    const used = new Set();
    for (const w of wanted) { const el = elOf(w.clip.id); if (el) { used.add(el); w.el = el; } }
    for (const w of wanted) {
      if (w.el) continue;
      const kind = w.clip.kind === 'audio' ? 'audio' : 'video';
      const pool = kind === 'audio' ? auds : vids;
      const free = pool.filter((v) => !used.has(v) && !ids.has(v.dataset.clip));
      const src = srcOf(w.clip);
      const el = free.find((v) => v.dataset.src === src.id) || free.find((v) => !v.dataset.clip) || free[0] || poolElement(kind);
      if (!el) continue; // more clips at once than elements: this one isn't played
      used.add(el);
      w.el = el;
      w.fresh = true;
    }
    // Elements nobody needs right now pause.
    allEls().forEach((v) => { if (!used.has(v)) { if (!v.paused) v.pause(); v.muted = true; } });
    const activeIds = new Set(active.map((a) => a.clip.id));
    for (const w of wanted) {
      const { el, clip, tr } = w;
      if (!el) continue;
      const isActive = activeIds.has(clip.id);
      const target = isActive ? clip.in + (t - clip.start) : clip.in;
      if (w.fresh) loadInto(el, clip, target);
      else if (isActive) {
        const drift = mediaTime(el) - target;
        if (!playing || forceTime) {
          if (forceTime || Math.abs(drift) > 0.01) setVideoTime(el, Math.max(0, target - (srcOf(clip).base || 0)));
          el.playbackRate = 1;
        } else if (clip.id === masterId) {
          el.playbackRate = 1; // the master gives the time
        } else if (Math.abs(drift) > 0.5 && !el.seeking) {
          setVideoTime(el, Math.max(0, target - (srcOf(clip).base || 0)));
          noteStutter('resync', srcOf(clip));
        } else {
          // Followers are nudged gently instead of jumping (a jump is visible as a stutter).
          el.playbackRate = Math.abs(drift) < 0.03 ? 1 : clamp(1 - drift * 0.8, 0.85, 1.15);
        }
      }
      const tOut = tOutOf(tr, clip);
      const g = (tr.volume == null ? 1 : tr.volume) * Render.clipGain(tOut ? { ...clip, tOut } : clip, t - clip.start);
      el.muted = !isActive || muteAll || !!clip.muted || tr.muted || g <= 0;
      setGain(el, g);
      if (isActive && playing) {
        if (el.paused) el.play().catch((err) => { if (err && err.name === 'NotAllowedError') { el.muted = true; el.play().catch(() => {}); } });
      } else if (!el.paused) el.pause();
    }
    return active.map((a) => ({ ...a, el: elOf(a.clip.id) }));
  }

  function resetVideos() {
    allEls().forEach((v) => { v.pause(); v.removeAttribute('src'); delete v.dataset.src; delete v.dataset.url; delete v.dataset.clip; v.load(); });
  }

  function seek(t, fromScroll) {
    playhead = clamp(t, 0, totalDuration());
    clock = { t0: performance.now(), ph0: playhead };
    startAt = performance.now();
    if (!allClips().length) resetVideos();
    else syncPool(true);
    if (!fromScroll) syncScroll(); else placePlayhead();
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
    // iOS only lets a media element play with sound if play() was first called in a user gesture.
    if (unlocked.has(el) || !el.getAttribute('src')) return;
    unlocked.add(el);
    if (!el.paused) return; // already playing in this gesture
    const t = el.currentTime;
    el.muted = true;
    el.play().then(() => {
      const active = playing && activeMedia(viewTime()).some((a) => a.clip.id === el.dataset.clip);
      if (!active) { el.pause(); el.currentTime = t; }
      syncPool();
    }).catch(() => {});
  }

  function play() {
    if (!allClips().length) return;
    if (playhead >= totalDuration() - 0.03) seek(0);
    // Make sure a few elements exist so they can be unlocked in this gesture.
    while (vids.length < 4 && poolElement('video'));
    if (audioTracks().length) while (auds.length < 3 && poolElement('audio'));
    if (actx || allClips().some((c) => isSoundClip(c) && c.volume > 1)) ensureAudioCtx();
    playing = true;
    setPlayIcon();
    clock = { t0: performance.now(), ph0: playhead };
    startAt = performance.now();
    syncPool(true);
    allEls().forEach(unlock);
    requestAnimationFrame(tick);
  }
  function pause() {
    if (!playing) return;
    playing = false;
    allEls().forEach((v) => v.pause());
    setPlayIcon();
    syncPool();
  }
  $('playBtn').addEventListener('click', () => (playing ? pause() : play()));

  // The clock never stops while playing. The bottom-most playing video gives
  // the time as long as it runs smoothly; if it falls behind or gets stuck,
  // the wall clock carries on and the video is re-synced in the background.
  // Only right after Play or a jump the preview waits up to ½ s for loading.
  let masterId = null;
  let startAt = 0;
  const stutter = [];               // [{ t, text }]
  const advance = new WeakMap();    // element -> { ct, at } last time its picture moved on
  function noteStutter(kind, src) {
    const now = performance.now();
    const name = src ? `"${src.name}"` : 'A video';
    const text = kind === 'slow' ? `${name} couldn't keep up — decoding is too slow on this device.`
      : kind === 'resync' ? `${name} drifted and had to be re-synced.`
        : `${name} took too long to load.`;
    stutter.push({ t: now, text, kind });
    while (stutter.length && now - stutter[0].t > 8000) stutter.shift();
    // A stuck video is reported at once, re-syncs only when they pile up.
    if (kind !== 'resync' || stutter.length >= 2) {
      const reasons = [...new Set(stutter.map((x) => x.text))].slice(-3);
      setHint('stutter', `The preview stuttered here. ${reasons.join(' ')} It keeps playing; the created video is not affected.`);
    }
  }
  function tick() {
    if (!playing) return;
    const now = performance.now();
    const total = totalDuration();
    const act = activeMedia(viewTime());
    const wall = clock.ph0 + (now - clock.t0) / 1000;
    const loading = act.filter((a) => { const el = elOf(a.clip.id); return el && (el.seeking || el.readyState < 3); });
    let next = wall;
    let master = null;
    if (loading.length && now - startAt < 500) {
      next = playhead; // short start-up wait, so the preview doesn't start black
      clock = { t0: now, ph0: playhead };
    } else {
      if (loading.length && now - startAt < 1500 && tick.loadNoted !== startAt) { tick.loadNoted = startAt; noteStutter('load', srcOf(loading[0].clip)); }
      const m = act.find((a) => a.clip.kind === 'video' && (() => { const el = elOf(a.clip.id); return el && !el.paused && !el.seeking && el.readyState >= 2; })());
      if (m) {
        const el = elOf(m.clip.id);
        const st = advance.get(el) || { ct: -1, at: now };
        if (el.currentTime !== st.ct) { st.ct = el.currentTime; st.at = now; }
        advance.set(el, st);
        const mt = m.clip.start + (mediaTime(el) - m.clip.in);
        const stuck = now - st.at > 250;
        if (!stuck && Math.abs(mt - wall) < 0.35) {
          next = Math.max(playhead, mt);
          master = m.clip.id;
          clock.ph0 += clamp((mt - wall) * 0.05, -0.002, 0.002); // the wall clock slowly follows a healthy video
        }
        else if (!st.reported) { st.reported = true; noteStutter('slow', srcOf(m.clip)); } // stuck or falling behind
        if (!stuck && Math.abs(mt - wall) < 0.1) st.reported = false;
      }
    }
    playhead = Math.min(total, next);
    masterId = master; // a lagging video becomes a follower and gets re-synced
    checkBoost(now);
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
  // One frame per click; held down it keeps going after a moment: forward plays
  // normally, backward steps back in real time (10 jumps per second).
  function holdStep(btn, dir) {
    let timer = 0, rep = 0, held = false;
    const stop = () => {
      clearTimeout(timer); clearInterval(rep);
      if (held) { held = false; if (dir > 0 && playing) pause(); }
    };
    btn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      stop();
      frameStep(dir);
      timer = setTimeout(() => {
        held = true;
        if (dir > 0) play();
        else rep = setInterval(() => { if (playhead <= 0.001) { stop(); return; } seek(Math.max(0, playhead - 0.1)); }, 100);
      }, 1000);
    });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => btn.addEventListener(ev, stop));
    btn.addEventListener('click', (e) => { if (e.detail === 0) frameStep(dir); }); // keyboard
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
  }
  holdStep($('frameBackBtn'), -1);
  holdStep($('frameFwdBtn'), 1);

  function updateTime() {
    $('curTime').textContent = fmtTime(playhead);
    $('totalTime').textContent = fmtTime(totalDuration());
    markLiveContents();
  }
  // Contents list: frame what is under the playhead right now (only while it's unfolded).
  let liveSig = '';
  function markLiveContents(force) {
    if ($('mediaBody').hidden) { liveSig = ''; return; }
    const t = playhead;
    const ids = new Set();
    const srcs = new Set();
    for (const tr of tracks) tr.clips.forEach((c, i) => {
      if (t >= c.start - 1e-6 && t < clipEnd(c) - 1e-6) { ids.add(c.id); if (c.srcId) srcs.add(c.srcId); }
      if (c.tIn && i > 0 && t >= c.start - 1e-6 && t < c.start + c.tIn.dur) ids.add('cut:' + c.id);
    });
    for (const m of markersOf()) if (Math.abs(m.t - t) < 0.02) ids.add('mk:' + m.id);
    const sig = [...ids, ...srcs].sort().join(',');
    if (sig === liveSig && !force) return;
    liveSig = sig;
    $('mediaList').querySelectorAll('li, .m-use').forEach((el) => {
      const d = el.dataset;
      const on = d.src ? srcs.has(d.src) : d.clip ? ids.has(d.clip) : d.use ? ids.has(d.use) : d.cutClip ? ids.has('cut:' + d.cutClip) : d.marker ? ids.has('mk:' + d.marker) : false;
      el.classList.toggle('live', on);
    });
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
    const cands = allClips().filter((c) => c.kind === 'video' || c.kind === 'image');
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
    tracks.forEach((tr, ti) => tr.clips.forEach((c, i) => { if (c.kind === 'video' || c.kind === 'image') cands.push({ c, label: tracks.length > 1 ? `${ti === 0 ? 'Main' : 'Track ' + (ti + 1)} · clip ${i + 1}` : `Clip ${i + 1}` }); }));
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
    syncCanvasSummary();
    $('bgHint').textContent = canvasState.bg === 'blur'
      ? 'Blurred copy of the visible video or image. Color clips and empty areas use the color.'
      : 'Fills the space around videos and images that don\'t match the format.';
  }

  // The canvas card can be folded to a single line (remembered).
  function syncCanvasSummary() {
    const a = $('aspectSel');
    const fmt = a.selectedOptions[0] ? a.selectedOptions[0].textContent.split(' · ')[0] : '';
    const ratio = canvasAspect();
    $('canvasSummary').textContent = `${fmt}${canvasState.aspect === 'video' || canvasState.aspect === 'crop' ? ` (${ratio >= 1 ? ratio.toFixed(2) + ':1' : '1:' + (1 / ratio).toFixed(2)})` : ''} · ${canvasState.bg === 'blur' ? 'Blur' : 'Color ' + canvasState.bgColor.toUpperCase()}`;
  }
  function setCanvasFolded(folded) {
    $('canvasCard').classList.toggle('collapsed', folded);
    $('canvasBody').hidden = folded;
    $('canvasToggle').setAttribute('aria-expanded', String(!folded));
    store.set('canvasFolded', folded);
  }
  $('canvasToggle').addEventListener('click', () => setCanvasFolded(!$('canvasCard').classList.contains('collapsed')));
  setCanvasFolded(store.get('canvasFolded', false));
  setMediaFolded(true);
  initMediaDrop();
  initMarkerRuler();

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
    if (canvasState.aspect === 'crop') { setCropCanvas(selClip() && (selClip().kind === 'video' || selClip().kind === 'image') ? selClip() : cropClip()); exportState.res = 'crop'; }
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
    if (clip.kind === 'text') {
      const r = renderTextCanvas(clip, outW, outH);
      return { drawable: r.canvas, w: r.w, h: r.h, isColor: false, tf: textTf(clip, outW) };
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
    const r = buildLayers(t, out, mode, sel);
    if (r.wait) return; // keep the last frame while a video is still seeking
    Render.composite(pvCtx, W, H, r.layers, canvasState.bg === 'blur' ? 'blur' : 'bars', bg);
    if (mode === 'move' && r.selLayer) drawMoveOverlay(r.selLayer.clip, r.selLayer.d, W, H, dpr);
  }
  // Layers of all visible tracks at time t (shared by the preview and the frame snapshot).
  function buildLayers(t, out, mode, sel) {
    const layers = [];
    let selLayer = null;
    for (let ti = 0; ti < tracks.length; ti++) {
      const tr = tracks[ti];
      if (isAudioTrack(tr) || tr.hidden || tr.opacity <= 0) continue;
      const cs = Render.clipsAtTime(tr.clips, t);
      if (!cs.length) continue;
      let wait = false;
      const layerOf = (c) => {
        const d = currentDrawable(c, out.w, out.h);
        if (!d) { if (playableVideo(c) && elOf(c.id)) wait = true; return null; }
        if (sel && c.id === sel.id) selLayer = { clip: c, d };
        // While moving/sizing the selected clip it is shown without its animation.
        const st = mode === 'move' && sel && c.id === sel.id ? { alpha: 1, fx: null, units: null } : Render.animState(c, t - c.start);
        const drawable = st.units && c.kind === 'text' ? renderTextCanvas(c, out.w, out.h, st.units).canvas : d.drawable;
        return { drawable, w: d.w, h: d.h, rot: 0, tf: d.tf || c.tf, opacity: tr.opacity, isMain: ti === 0, isColor: d.isColor, alpha: st.alpha, fx: st.fx };
      };
      const b = cs[cs.length - 1];
      if (cs.length > 1 && b.tIn) {
        const la = layerOf(cs[cs.length - 2]), lb = layerOf(b);
        if (la && lb) layers.push({ trans: { a: la, b: lb, type: b.tIn.type, dir: b.tIn.dir, p: (t - b.start) / b.tIn.dur }, opacity: tr.opacity, isMain: ti === 0 });
        else if (la || lb) layers.push(la || lb);
      } else {
        const l = layerOf(b);
        if (l) layers.push(l);
      }
      if (wait) return { wait: true, layers, selLayer };
    }
    return { wait: false, layers, selLayer };
  }

  // Snapshot: the current frame in the size of the created video, as PNG.
  async function saveFrame(how) {
    if (!allClips().length) return;
    pause();
    const out = outputDims();
    const t = viewTime();
    await Promise.all([...new Set(allClips().filter((c) => c.kind === 'text').map((c) => textOf(c).font))].map(ensureFont));
    let r = buildLayers(t, out, null, null);
    for (let k = 0; r.wait && k < 20; k++) { await new Promise((res) => setTimeout(res, 100)); r = buildLayers(t, out, null, null); }
    const cv = document.createElement('canvas');
    cv.width = out.w; cv.height = out.h;
    Render.composite(cv.getContext('2d'), out.w, out.h, r.layers, canvasState.bg === 'blur' ? 'blur' : 'bars', canvasState.bgColor);
    const blob = await new Promise((res) => cv.toBlob(res, 'image/png'));
    if (!blob) { toast('The frame couldn\'t be saved.'); return; }
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    const name = `vcshot_${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}.png`;
    if (how === 'copy') {
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        toast(`Frame copied (${out.w}×${out.h}) — paste it anywhere.`, 2500);
        return;
      } catch (e) { toast('Copying pictures isn\'t allowed here — saved as a file instead.', 3500); }
    }
    if (how === 'share') {
      const file = new File([blob], name, { type: 'image/png' });
      try { await navigator.share({ files: [file] }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
    }
    downloadBlob(blob, name);
    toast(`Frame saved as ${name} (${out.w}×${out.h}).`, 3000);
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
    if (!f || cpTab === 'clip' || cpTab === 'audio' || cpTab === 'fade' || playing || f.tr.hidden || f.clip.kind === 'audio') return null;
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
    if (c.kind === 'text') { const o = outputDims(); const r = renderTextCanvas(c, o.w, o.h); return { w: r.w, h: r.h }; }
    const s = srcOf(c);
    if (!s) return { w: 16, h: 9 };
    return c.kind === 'video' ? Render.displaySize(s) : { w: s.width, h: s.height };
  }
  function layoutFor(c, W, H, tf) {
    const d = srcDims(c);
    const t = Render.tfOf(c.kind === 'text' ? { ...(tf || c.tf), fit: 'abs', absW: outputDims().w } : tf || c.tf);
    return Render.clipLayout(d.w * t.crop.w, d.h * t.crop.h, W, H, t);
  }
  // Size relative to "fit" (1 = fit), whatever the size mode is.
  function effectiveScale(c) {
    if (c.kind === 'text') return Render.tfOf(c.tf).scale; // text: relative to its font size
    const o = outputDims();
    const g = layoutFor(c, o.w, o.h);
    return g.s / g.fitS;
  }

  // Live edits (drags, sliders) change the clip directly; one undo step is recorded at the end.
  let liveBefore = null;
  // Clips a transform change applies to: the selected one, or all selected pictures
  // (crop only for videos and images).
  function tfTargets(patch) {
    const list = multi() ? selFinds() : [findClip(selectedId)].filter(Boolean);
    return list.filter((f) => f.clip.kind !== 'audio' && !(('crop' in patch || 'cropRatio' in patch) && (f.clip.kind === 'color' || f.clip.kind === 'text')));
  }
  // Text keeps its own size mode (font size × scale); Fit/Fill don't apply.
  const tfPatchFor = (c, patch) => {
    if (c.kind !== 'text' || !('fit' in patch)) return patch;
    const { fit, ...rest } = patch;
    return fit === 'free' ? rest : ('scale' in rest ? rest : {});
  };
  function liveEdit(patch) {
    const list = tfTargets(patch);
    if (!list.length) return;
    if (!liveBefore) liveBefore = snapshot();
    for (const f of list) {
      const i = f.tr.clips.indexOf(f.clip);
      f.tr.clips[i] = { ...f.clip, tf: { ...Render.tfOf(f.clip.tf), ...tfPatchFor(f.clip, patch) } };
    }
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
    if (!multi()) { updateSelected({ tf: { ...Render.tfOf(c.tf), ...tfPatchFor(c, patch) } }); return; }
    const list = tfTargets(patch);
    commit(() => list.forEach((f) => { f.clip.tf = { ...Render.tfOf(f.clip.tf), ...tfPatchFor(f.clip, patch) }; }));
  }

  // The clip whose transform the tabs show: the selected one, or (several selected) the first picture.
  function tfRef() {
    const c = selClip();
    if (c && c.kind !== 'audio') return c;
    const f = selFinds().find((x) => x.clip.kind !== 'audio');
    return f ? f.clip : null;
  }
  function syncTransformUI() {
    const c = tfRef();
    if (!c) return;
    $('fitToggle').hidden = c.kind === 'text'; // text: size = font size × slider
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
    const c = tfRef();
    if (tab === 'crop' && c && c.kind === 'color') tab = 'clip';
    if (c && c.kind === 'audio' && !multi() && tab !== 'audio') tab = tab === 'clip' ? 'clip' : 'audio';
    cpTab = tab;
    $('cpTabs').querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('#clipPanel .cp-pane').forEach((p) => { p.hidden = p.dataset.pane !== tab; });
    updateTransformingClass();
  }
  // On phones the preview sticks to the top while a transform tab is open.
  function updateTransformingClass() {
    const on = !$('clipPanel').hidden && cpTab !== 'clip' && cpTab !== 'audio' && cpTab !== 'fade';
    if (document.body.classList.contains('transforming') !== on) {
      document.body.classList.toggle('transforming', on);
      requestAnimationFrame(renderPreview);
    }
  }
  $('cpTabs').addEventListener('click', (e) => {
    const b = e.target.closest('.seg-btn');
    if (!b) return;
    showTab(b.dataset.tab);
    if (cpTab !== 'clip' && cpTab !== 'audio' && cpTab !== 'fade') ensureVisible();
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
    const c = tfRef();
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
    const c = tfRef();
    if (!b || !c) return;
    ensureVisible();
    if (b.dataset.fit === 'free') setTf({ fit: 'free', scale: effectiveScale(c) });
    else setTf({ fit: b.dataset.fit });
  });
  $('scaleRange').addEventListener('input', (e) => { ensureVisible(); liveEdit({ fit: 'free', scale: e.target.value / 100 }); });
  $('scaleRange').addEventListener('change', liveCommit);
  $('snapChk').checked = store.get('snapCenter', false); // off by default (0.12.1)
  if (isCoarse) document.querySelector('.hint-inline').hidden = true;
  $('snapChk').addEventListener('change', (e) => store.set('snapCenter', e.target.checked));

  // Rotate & flip
  const normAngle = (a) => { a = ((a + 180) % 360 + 360) % 360 - 180; return a === -180 ? 180 : a; };
  $('rotLeftBtn').addEventListener('click', () => { const c = tfRef(); if (!c) return; ensureVisible(); setTf({ rot: normAngle(Render.tfOf(c.tf).rot - 90) }); });
  $('rotRightBtn').addEventListener('click', () => { const c = tfRef(); if (!c) return; ensureVisible(); setTf({ rot: normAngle(Render.tfOf(c.tf).rot + 90) }); });
  $('flipHBtn').addEventListener('click', () => { const c = tfRef(); if (!c) return; ensureVisible(); setTf({ flipH: !Render.tfOf(c.tf).flipH }); });
  $('flipVBtn').addEventListener('click', () => { const c = tfRef(); if (!c) return; ensureVisible(); setTf({ flipV: !Render.tfOf(c.tf).flipV }); });
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
    const c = tfRef();
    if (!b || !c) return;
    ensureVisible();
    const key = b.dataset.ratio;
    if (key === 'free') { setTf({ cropRatio: null }); return; }
    setTf({ crop: centeredCrop(c, ratioValue(key)), cropRatio: key });
  });
  $('cropAsCanvas').addEventListener('click', () => {
    const c = tfRef();
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
    const t = Render.tfOf(d.tf || clip.tf);
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
    const c = tfRef();
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
    const c = tfRef();
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
        // The element's centre and edges snap to the canvas edges and centre line
        // (centre on a corner works by snapping both directions).
        const snap1 = (pos, half, size) => {
          let best = null;
          for (const off of [0, -half, half]) for (const line of [0, size / 2, size]) {
            const diff = pos + off - line;
            if (Math.abs(diff) < thr && (!best || Math.abs(diff) < Math.abs(best[0]))) best = [diff, line];
          }
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
      const t = Render.tfOf((tfRef() || {}).tf);
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
    const c = tfRef();
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
    else if (mod && k === 'a') { e.preventDefault(); selectAll(); }
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
    else if (k === 'i') addMarker();
    else if (k === 'g' && selIds.size > 1) toggleGroup();
    else if (e.key === 'Escape') clearSelection();
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); }
    else if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && selClip()) { e.preventDefault(); nudge((e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 0.01 : 0.1)); }
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
  // ---------------------------------------------------------------------------
  // File name: automatic (original name + what changed, or the project name),
  // or the user's own name, which may contain placeholders (* # $Y $M $D …).
  // ---------------------------------------------------------------------------
  let exportName = ''; // '' = automatic
  // The one video file this export is made from (single-clip edits), if any.
  function nameSource() {
    const vis = [...new Set(exportClips().filter((c) => c.kind === 'video' || c.kind === 'image').map(srcOf).filter(Boolean))];
    return vis.length === 1 && vis[0].kind === 'video' ? vis[0] : null;
  }
  function qualityToken() {
    const q = exportState.quality;
    if (q === 'custom') return `${String(exportState.bitrateMbps).replace('.', ',')}mbps`.replace(',', '.');
    if (q === 'target') return `${exportState.targetMB}mb`;
    return q;
  }
  // Values for the name: tokens and which of them differ from the original.
  function nameInfo() {
    const out = Render.computeOutput(getExportSettings(), usedSources(), exportDuration());
    const src = nameSource();
    const short = Math.min(out.width, out.height);
    const sd = src ? Render.displaySize(src) : null;
    const t = {
      res: `${short}p`, quality: qualityToken(), fps: `${out.fps}fps`,
      bitrate: `${(out.bitrate / 1e6).toFixed(1).replace(/\.0$/, '')}mbps`, dims: `${out.width}x${out.height}`,
      codec: exportState.codec === 'hevc' ? 'hevc' : 'h264',
    };
    const changed = [];
    if (!sd || Math.abs(Math.min(sd.w, sd.h) - short) > 2) changed.push(t.res);
    changed.push(t.quality); // re-encoded with these settings
    if (!src || Math.round(src.frameRate || 30) !== out.fps) changed.push(t.fps);
    return { t, changed, src, out };
  }
  const projectBase = () => cleanFileName(projectName) || 'video';
  function autoName() {
    const i = nameInfo();
    if (i.src) return [cleanFileName(baseName(i.src.name)) || 'video', ...i.changed].join('_');
    return projectBase() + (exportState.scope === 'selected' ? '_clip' : '');
  }
  // Date for $Y…$s: recording date (metadata), else the file's date, else now.
  function nameDate() {
    const ms = metaSource();
    const src = nameSource() || (ms && ms.src) || null;
    const m = ms && ms.meta && ms.meta.utc != null ? ms.meta : src && src.fileMeta && src.fileMeta.utc != null ? src.fileMeta : null;
    if (m) { const tz = m.tz != null ? m.tz : -new Date(m.utc).getTimezoneOffset(); const d = new Date(m.utc + tz * 60000); return { Y: d.getUTCFullYear(), M: d.getUTCMonth() + 1, D: d.getUTCDate(), h: d.getUTCHours(), m: d.getUTCMinutes(), s: d.getUTCSeconds() }; }
    const d = new Date(src && src.origLastModified ? src.origLastModified : Date.now());
    return { Y: d.getFullYear(), M: d.getMonth() + 1, D: d.getDate(), h: d.getHours(), m: d.getMinutes(), s: d.getSeconds() };
  }
  /** Replace the placeholders of a name pattern (n = number for #). */
  function expandName(pattern, n = 1, info = nameInfo()) {
    if (!/[*#$]/.test(pattern)) return pattern;
    const base = info.base || (info.src ? cleanFileName(baseName(info.src.name)) : projectBase());
    let d = null;
    const date = (k) => { d = d || info.dateParts || nameDate(); return String(d[k]).padStart(k === 'Y' ? 4 : 2, '0'); };
    const vals = { R: () => info.t.dims, P: () => info.t.res, Q: () => info.t.quality, F: () => String(info.out.fps), B: () => info.t.bitrate };
    return pattern
      .replace(/#+/g, (h) => String(n).padStart(h.length, '0'))
      .replace(/\$([YMDhmsRPQFB])/g, (all, k) => ('YMDhms'.includes(k) ? date(k) : vals[k]()))
      .replace(/\*/g, base);
  }
  const rawName = () => exportName || autoName();
  const exportFileName = () => cleanFileName(expandName(rawName())) || 'video';
  function syncFileName() {
    if (document.activeElement !== $('fileNameInput')) $('fileNameInput').value = rawName();
    const raw = rawName();
    $('fileNamePreview').hidden = !/[*#$]/.test(raw);
    $('fileNamePreview').textContent = '→ ' + exportFileName() + '.mp4';
    fillNameOptions();
  }
  // Keep placeholders; everything else that isn't allowed in file names is replaced later.
  const cleanPattern = (v) => String(v || '').replace(/[\x00-\x1f\x7f<>:"/\\|?]+/g, '_').replace(/\.mp4$/i, '').trim().slice(0, 160);
  $('fileNameInput').addEventListener('change', (e) => {
    const v = cleanPattern(e.target.value);
    exportName = v && v !== autoName() ? v : '';
    syncFileName();
    e.target.value = rawName();
    scheduleSave();
  });
  $('fileNameInput').addEventListener('input', (e) => {
    const v = e.target.value;
    $('fileNamePreview').hidden = !/[*#$]/.test(v);
    $('fileNamePreview').textContent = '→ ' + (cleanFileName(expandName(cleanPattern(v))) || 'video') + '.mp4';
  });
  // The ▾ menu next to the name: whole names, parts to add, placeholders.
  // The ▾ box next to the name: whole names, tags to add, placeholders.
  function fillNameOptions() {
    if ($('nameBox').hidden) return;
    const i = nameInfo();
    const chip = (v, label, title, active) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn-chip' + (active ? ' active' : ''); b.dataset.v = v; b.textContent = label; b.title = title || label; return b; };
    const orig = i.src ? cleanFileName(baseName(i.src.name)) : null;
    const cur = rawName();
    const names = [chip('auto', 'Automatic', autoName(), !exportName)];
    if (orig) names.push(chip('name:' + orig, 'Original', orig, !!exportName && cur === orig));
    const vc = (orig || projectBase()) + '_videcutto';
    names.push(chip('name:' + vc, '…_videcutto', vc, cur === vc));
    if (!orig || orig !== projectBase()) names.push(chip('name:' + projectBase(), 'Project name', projectBase(), !!exportName && cur === projectBase()));
    const add = [i.t.res, i.t.quality, i.t.fps, i.t.bitrate, i.t.dims, i.t.codec];
    const c = exportClips();
    if (i.src && c.some((x) => x.kind === 'video' && (x.in > (i.src.rangeIn || 0) + 0.05 || x.out < (i.src.rangeOut || x.out) - 0.05))) add.push('cut');
    if (c.some((x) => x.tf && x.tf.crop && (x.tf.crop.w < 0.999 || x.tf.crop.h < 0.999))) add.push('crop');
    if (muteAll || (c.length && c.filter(isSoundClip).every((x) => x.muted))) add.push('mute');
    $('nameChips').replaceChildren(...names);
    $('tagChips').replaceChildren(...add.map((x) => chip('add:' + x, '+ _' + x, 'Add _' + x + ' to the name', cur.split('_').includes(x))));
  }
  function applyNameOption(v) {
    if (v === 'auto') exportName = '';
    else if (v.startsWith('name:')) exportName = v.slice(5) === autoName() ? '' : v.slice(5);
    else if (v.startsWith('add:')) exportName = rawName() + '_' + v.slice(4);
    syncFileName();
    scheduleSave();
  }
  $('nameBox').addEventListener('click', (e) => { const b = e.target.closest('[data-v]'); if (b) applyNameOption(b.dataset.v); });
  $('nameMoreBtn').addEventListener('click', () => {
    const open = $('nameBox').hidden;
    $('nameBox').hidden = !open;
    $('nameMoreBtn').setAttribute('aria-expanded', String(open));
    fillNameOptions();
  });
  $('namePhBtn').addEventListener('click', () => openModal('namePhModal'));
  $('namePhClose').addEventListener('click', () => closeModal('namePhModal'));
  $('namePhOk').addEventListener('click', () => closeModal('namePhModal'));
  $('namePhModal').addEventListener('click', (e) => { if (e.target.id === 'namePhModal') closeModal('namePhModal'); });

  // ---------------------------------------------------------------------------
  // Metadata of the exported video: automatic (first clip's file), a chosen
  // file, none, or own values. The place can be left out.
  // ---------------------------------------------------------------------------
  const defaultMetaChoice = () => ({ mode: 'auto', srcId: null, loc: true, custom: {} });
  let metaChoice = defaultMetaChoice();
  const META_FIELDS = ['title', 'description', 'author', 'make', 'model', 'software'];
  const CAMERA_FIELDS = ['iso', 'fnumber', 'exposure', 'ev', 'focal', 'focal35', 'lens'];
  const hasMeta = (m) => !!m && (m.utc != null || m.lat != null || META_FIELDS.some((f) => m[f]) || CAMERA_FIELDS.some((f) => m[f] != null));
  // "ISO 25 · 23 mm · 0.0 EV · f/1.8 · 1/403 s" like a phone's gallery.
  function cameraLine(m) {
    const p = [];
    if (m.iso) p.push(`ISO ${m.iso}`);
    if (m.focal35) p.push(`${m.focal35} mm`); else if (m.focal) p.push(`${m.focal} mm`);
    if (m.ev != null) p.push(`${m.ev >= 0 ? '' : '−'}${Math.abs(m.ev).toFixed(1)} EV`);
    if (m.fnumber) p.push(`f/${m.fnumber}`);
    if (m.exposure) p.push(m.exposure);
    return p.join(' · ');
  }
  const metaFiles = () => [...sources.values()].filter((x) => (x.kind === 'video' || x.kind === 'image') && hasMeta(x.fileMeta));
  function metaSource() {
    if (metaChoice.mode === 'none') return null;
    if (metaChoice.mode === 'custom') return { kind: 'custom', meta: metaChoice.custom || {} };
    if (metaChoice.mode === 'file') { const x = sources.get(metaChoice.srcId); if (x) return { kind: 'file', src: x, meta: x.fileMeta || {} }; }
    const order = [...new Set(exportClips().map(srcOf).filter(Boolean))];
    const x = order.find((y) => (y.kind === 'video' || y.kind === 'image') && hasMeta(y.fileMeta));
    return x ? { kind: 'auto', src: x, meta: x.fileMeta } : null;
  }
  function exportMeta() {
    const ms = metaSource();
    if (!ms || !hasMeta(ms.meta)) return null;
    const m = { ...ms.meta };
    if (!metaChoice.loc) { delete m.lat; delete m.lon; delete m.alt; }
    return m;
  }
  const fmtMetaDate = (m) => {
    if (!m || m.utc == null) return '';
    const tz = m.tz != null ? m.tz : -new Date(m.utc).getTimezoneOffset();
    const d = new Date(m.utc + tz * 60000);
    const p2 = (n) => String(n).padStart(2, '0');
    return `${p2(d.getUTCDate())}.${p2(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}, ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}` + (m.tz != null ? ` (UTC${m.tz >= 0 ? '+' : '−'}${p2(Math.floor(Math.abs(m.tz) / 60))}:${p2(Math.abs(m.tz) % 60)})` : '');
  };
  function metaSummary() {
    const ms = metaSource();
    const m = exportMeta();
    if (metaChoice.mode === 'none') return 'None — all removed';
    if (!m) return metaChoice.mode === 'custom' ? 'Own values (empty)' : 'None found in the files';
    const what = [m.utc != null && '📅', m.lat != null && '📍', (m.make || m.model) && '📷', m.title && 'T'].filter(Boolean).join(' ');
    const from = ms.kind === 'custom' ? 'Own values' : ms.kind === 'auto' ? 'Automatic' : 'From file';
    $('metaSummary').title = ms.src ? ms.src.name : '';
    return `${from} · ${what}`;
  }
  function extraText(e) {
    if (e.t !== 1) return '(data)';
    try { const b = atob(e.d); return decodeURIComponent(escape(b)).slice(0, 80); } catch (er) { return '(data)'; }
  }
  function metaRows(m, full) {
    const rows = [];
    if (!m) return rows;
    if (m.utc != null) rows.push(['Recorded', fmtMetaDate(m)]);
    if (m.lat != null) rows.push(['Place', `${m.lat.toFixed(5)}, ${m.lon.toFixed(5)}${m.alt != null ? ` · ${Math.round(m.alt)} m` : ''}`]);
    if (m.make || m.model) rows.push(['Camera', [m.make, m.model].filter(Boolean).join(' ')]);
    if (cameraLine(m)) rows.push(['Settings', cameraLine(m)]);
    if (m.lens) rows.push(['Lens', m.lens]);
    for (const [f, l] of [['software', 'Software'], ['title', 'Title'], ['description', 'Description'], ['author', 'Author']]) if (m[f]) rows.push([l, m[f]]);
    if (m.extra && m.extra.length) {
      if (full) for (const e of m.extra) rows.push([e.k.replace(/^com\.(apple\.quicktime|android)\./, ''), extraText(e)]);
      else rows.push(['More', `${m.extra.length} other entr${m.extra.length === 1 ? 'y' : 'ies'} (copied as they are)`]);
    }
    return rows;
  }
  function metaSourceOptions(sel, withAutoName) {
    const opt = (v, l) => Object.assign(document.createElement('option'), { value: v, textContent: l });
    const msA = metaChoice.mode === 'auto' ? metaSource() : null;
    const auto = withAutoName && msA && msA.src ? msA.src.name : null;
    sel.replaceChildren(
      opt('auto', 'Automatic · first clip with metadata' + (auto ? ` (${auto})` : '')),
      ...metaFiles().map((x) => opt('file:' + x.id, 'File: ' + x.name)),
      opt('custom', 'Own values (kept in this project)'),
      opt('none', 'None — remove all'),
    );
    sel.value = metaChoice.mode === 'file' && sources.has(metaChoice.srcId) ? 'file:' + metaChoice.srcId : metaChoice.mode === 'file' ? 'auto' : metaChoice.mode;
  }
  function syncMetaInfo() {
    metaSourceOptions($('metaQuick'), true);
    $('metaLocQuick').checked = metaChoice.loc !== false;
    const rows = metaRows(exportMeta(), true);
    const dl = $('metaInfoList');
    dl.replaceChildren(...(rows.length ? rows : [['', 'Nothing — the video gets no recording date, place or camera information.']]).flatMap(([k, v]) => [Object.assign(document.createElement('dt'), { textContent: k }), Object.assign(document.createElement('dd'), { textContent: v })]));
  }
  $('metaInfoBtn').addEventListener('click', () => {
    const show = $('metaInfo').hidden;
    $('metaInfo').hidden = !show;
    $('metaInfoBtn').setAttribute('aria-expanded', String(show));
    if (show) syncMetaInfo();
  });
  $('metaQuick').addEventListener('change', (e) => setMetaSource(e.target.value));
  $('metaLocQuick').addEventListener('change', (e) => { metaChoice.loc = e.target.checked; syncMetaUI(); scheduleSave(); });
  function syncMetaUI() {
    $('metaSummary').textContent = metaSummary();
    if (!$('metaInfo').hidden) syncMetaInfo();
    if ($('metaModal').hidden) return;
    metaSourceOptions($('metaSel'), true);
    const opt = (v, l) => Object.assign(document.createElement('option'), { value: v, textContent: l });
    $('metaFillSel').replaceChildren(opt('', 'Choose a file…'), ...metaFiles().map((x) => opt(x.id, x.name)));
    $('metaFillRow').hidden = !metaFiles().length;
    const custom = metaChoice.mode === 'custom';
    $('metaCustom').hidden = !custom;
    $('metaLocChk').checked = metaChoice.loc !== false;
    const ms = metaSource();
    const rows = custom || metaChoice.mode === 'none' ? [] : metaRows(ms && ms.meta);
    const dl = $('metaList');
    dl.replaceChildren(...rows.flatMap(([k, v]) => [Object.assign(document.createElement('dt'), { textContent: k }), Object.assign(document.createElement('dd'), { textContent: v })]));
    dl.hidden = !rows.length;
    $('metaEmpty').hidden = custom || rows.length > 0;
    $('metaEmpty').textContent = metaChoice.mode === 'none' ? 'The video gets no recording date, place or camera information.' : 'No metadata found.';
    $('metaEditBtn').hidden = custom || metaChoice.mode === 'none' || !rows.length;
    if (custom) fillMetaForm(metaChoice.custom || {});
    // Opened from a file (🏷): its own data on top, the export choice below.
    const vs = metaView && sources.get(metaView);
    $('metaFileBox').hidden = !vs;
    if (vs) {
      $('metaFileName').textContent = vs.name;
      const fr = metaRows(vs.fileMeta);
      $('metaFileList').replaceChildren(...fr.flatMap(([k, v]) => [Object.assign(document.createElement('dt'), { textContent: k }), Object.assign(document.createElement('dd'), { textContent: v })]));
      const used = !!(ms && ms.src === vs) && metaChoice.mode !== 'custom';
      $('metaUseBtn').textContent = used ? '✓ Used for the export' : 'Use for the export';
      $('metaUseBtn').disabled = used;
      dl.hidden = true; $('metaEmpty').hidden = true; $('metaEditBtn').hidden = true;
    }
  }
  // Own values: form <-> object
  const p2 = (n) => String(n).padStart(2, '0');
  function fillMetaForm(m) {
    if (m.utc != null) {
      const tz = m.tz != null ? m.tz : -new Date(m.utc).getTimezoneOffset();
      const d = new Date(m.utc + tz * 60000);
      $('metaDate').value = `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}T${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`;
    } else $('metaDate').value = '';
    $('metaLat').value = m.lat != null ? m.lat : '';
    $('metaLon').value = m.lon != null ? m.lon : '';
    for (const f of META_FIELDS) $('meta_' + f).value = m[f] || '';
  }
  function readMetaForm() {
    const old = metaChoice.custom || {};
    const m = {};
    const dv = $('metaDate').value;
    if (dv) { const d = MP4.parseDate(dv.length === 16 ? dv + ':00' : dv); if (d) { m.utc = d.utc; m.tz = null; } }
    const lat = parseFloat($('metaLat').value), lon = parseFloat($('metaLon').value);
    if (isFinite(lat) && isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) { m.lat = lat; m.lon = lon; if (old.lat === lat && old.lon === lon && old.alt != null) m.alt = old.alt; }
    for (const f of META_FIELDS) { const v = $('meta_' + f).value.trim(); if (v) m[f] = v; }
    if (old.extra) m.extra = old.extra;
    for (const f of CAMERA_FIELDS) if (old[f] != null) m[f] = old[f];
    return m;
  }
  let metaView = null; // file whose metadata is shown (opened with 🏷)
  function openMeta(srcId) {
    metaView = srcId || null;
    openModal('metaModal');
    syncMetaUI();
  }
  function useMetaOf(srcId) {
    metaChoice = { ...metaChoice, mode: 'file', srcId };
    syncMetaUI(); renderMediaList(); syncFileName(); scheduleSave();
  }
  $('metaUseBtn').addEventListener('click', () => { if (metaView) useMetaOf(metaView); });
  $('metaBtn').addEventListener('click', () => { setMetaSource('custom'); openMeta(); });
  // Own values stay in the project when another source is chosen in between;
  // they are only prefilled (from the current source) the very first time.
  function setMetaSource(v) {
    if (v === 'custom' && metaChoice.mode !== 'custom' && !Object.keys(metaChoice.custom || {}).length) {
      const ms = metaSource();
      metaChoice.custom = ms && ms.meta ? JSON.parse(JSON.stringify(ms.meta)) : {};
    }
    if (v.startsWith('file:')) metaChoice = { ...metaChoice, mode: 'file', srcId: v.slice(5) };
    else metaChoice = { ...metaChoice, mode: v };
    syncMetaUI(); syncFileName(); renderMediaList(); scheduleSave();
  }
  $('metaSel').addEventListener('change', (e) => setMetaSource(e.target.value));
  $('metaEditBtn').addEventListener('click', () => setMetaSource('custom'));
  $('metaFillSel').addEventListener('change', (e) => {
    const x = sources.get(e.target.value);
    e.target.value = '';
    if (!x || !x.fileMeta) return;
    metaChoice.custom = JSON.parse(JSON.stringify(x.fileMeta));
    fillMetaForm(metaChoice.custom);
    syncMetaUI(); syncFileName(); scheduleSave();
    toast(`Own values filled from ${x.name}.`, 2000);
  });
  // "There": a pasted map link or coordinates.
  function parseLocation(str) {
    const t = decodeURIComponent(String(str || '')).trim();
    const num = '(-?\\d{1,3}(?:\\.\\d+)?)';
    const tries = [
      new RegExp('!3d' + num + '!4d' + num),                   // google: the exact pin of a place
      new RegExp('@' + num + ',' + num),                       // google.com/maps/@lat,lon,zoom
      new RegExp('[?&](?:q|query|ll|center|daddr)=' + num + ',\\s*' + num),
      new RegExp('mlat=' + num + '.*?mlon=' + num),            // openstreetmap marker
      new RegExp('#map=\\d+/' + num + '/' + num),            // openstreetmap view
      new RegExp('geo:' + num + ',' + num),
      new RegExp('^' + num + '\\s*[,; ]\\s*' + num + '$'),
    ];
    for (const re of tries) { const m = re.exec(t); if (m) { const lat = +m[1], lon = +m[2]; if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return { lat, lon }; } }
    // 37°05'20"N 8°13'40"W
    const dms = /(\d{1,3})°\s*(\d{1,2})['′]\s*([\d.]+)["″]?\s*([NS])[,\s]+(\d{1,3})°\s*(\d{1,2})['′]\s*([\d.]+)["″]?\s*([EOW])/i.exec(t);
    if (dms) {
      const v = (d, m2, sec, h) => (+d + m2 / 60 + sec / 3600) * (/[SW]/i.test(h) ? -1 : 1);
      return { lat: +v(dms[1], dms[2], dms[3], dms[4]).toFixed(6), lon: +v(dms[5], dms[6], dms[7], dms[8]).toFixed(6) };
    }
    return null;
  }
  $('metaThere').addEventListener('click', () => { $('metaThereRow').hidden = !$('metaThereRow').hidden; if (!$('metaThereRow').hidden) $('metaThereInput').focus(); });
  const useThere = () => {
    const loc = parseLocation($('metaThereInput').value);
    if (!loc) { toast('No coordinates found — paste a map link (Google Maps, OpenStreetMap) or e.g. 37.0889, -8.2278.', 4000); return; }
    $('metaLat').value = loc.lat; $('metaLon').value = loc.lon;
    $('metaThereRow').hidden = true; $('metaThereInput').value = '';
    $('metaCustom').dispatchEvent(new Event('change'));
    toast(`Place set to ${loc.lat.toFixed(5)}, ${loc.lon.toFixed(5)}.`, 2000);
  };
  $('metaThereOk').addEventListener('click', useThere);
  $('metaThereInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); useThere(); } });
  $('metaCustom').addEventListener('change', () => { metaChoice.custom = readMetaForm(); $('metaSummary').textContent = metaSummary(); syncFileName(); scheduleSave(); });
  $('metaLocChk').addEventListener('change', (e) => { metaChoice.loc = e.target.checked; syncMetaUI(); scheduleSave(); });
  $('metaHere').addEventListener('click', () => {
    if (!navigator.geolocation) { toast('Location isn\'t available in this browser.'); return; }
    navigator.geolocation.getCurrentPosition((pos) => {
      $('metaLat').value = pos.coords.latitude.toFixed(6);
      $('metaLon').value = pos.coords.longitude.toFixed(6);
      $('metaCustom').dispatchEvent(new Event('change'));
    }, () => toast('Couldn\'t get your location.'), { timeout: 15000 });
  });
  $('metaNow').addEventListener('click', () => { const d = new Date(); $('metaDate').value = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`; $('metaCustom').dispatchEvent(new Event('change')); });
  const closeMeta = () => { closeModal('metaModal'); metaView = null; };
  $('metaClose').addEventListener('click', closeMeta);
  $('metaDone').addEventListener('click', closeMeta);
  $('metaModal').addEventListener('click', (e) => { if (e.target.id === 'metaModal') closeMeta(); });

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
      meta: exportMeta(),
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
    syncMetaUI();
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
    if (ok) { const bo = $('bCodecSel').querySelector('option[value="hevc"]'); bo.disabled = false; bo.textContent = 'H.265 (HEVC) · smaller'; }
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
    if (muteAll || !isSoundClip(c) || c.muted || c.volume === 0 || !srcOf(c) || !srcOf(c).audioDecodable) return false;
    if (exportState.scope === 'selected') return true;
    const f = findClip(c.id);
    return !f || (!f.tr.muted && f.tr.volume > 0);
  }
  const usedSources = () => [...new Set(exportClips().map((c) => srcOf(c)).filter(Boolean))];

  function sourceBytes() {
    return exportClips().reduce((sum, c) => {
      const s = srcOf(c);
      return s && c.kind === 'video' && s.kind === 'video' && s.file ? sum + ((c.out - c.in) / Math.max(0.01, s.fileDuration)) * s.file.size : sum;
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
    const visual = used.filter((x) => x.kind !== 'audio');
    const onlyVideos = visual.length && visual.every((x) => x.kind === 'video');
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

    // Fonts of text clips must be loaded before the text is drawn.
    await Promise.all([...new Set(allClips().filter((c) => c.kind === 'text').map((c) => textOf(c).font))].map(ensureFont));
    textCache.clear();
    const s = getExportSettings();
    // Clip times are in media time; the export reads the actual (possibly trimmed-copy) file.
    const scopeSelected = exportState.scope === 'selected';
    const sound = (c) => ({ volume: c.volume == null ? 1 : c.volume, fadeIn: c.fadeIn || 0, fadeOut: c.fadeOut || 0, vFadeIn: c.vFadeIn || 0, vFadeOut: c.vFadeOut || 0, animIn: c.animIn, animOut: c.animOut });
    const expClip = (c, start, tr) => {
      const e = expClip0(c, start);
      if (tr && c.tIn) e.tIn = { ...c.tIn };
      const tOut = tr ? tOutOf(tr, c) : null;
      if (tOut) e.tOut = tOut;
      return e;
    };
    const expClip0 = (c, start) => {
      if (isVideoClip(c)) { const src = srcOf(c); return { kind: 'video', source: src, start, in: c.in - src.base, out: c.out - src.base, muted: c.muted, tf: c.tf, ...sound(c) }; }
      if (c.kind === 'audio') { const src = srcOf(c); const b = src.base || 0; return { kind: 'audio', source: src, start, in: c.in - b, out: c.out - b, muted: c.muted, ...sound(c) }; }
      const still = stillFor(c, s.width, s.height);
      if (still && c.kind === 'text') still.frameAt = (u) => renderTextCanvas(c, s.width, s.height, u).canvas;
      return { kind: c.kind, source: srcOf(c) || null, start, in: c.in, out: c.out, muted: true, still, tf: (still && still.tf) || c.tf, vFadeIn: c.vFadeIn || 0, vFadeOut: c.vFadeOut || 0, animIn: c.animIn, animOut: c.animOut };
    };
    const sel = selClip();
    const expTracks = scopeSelected && sel
      ? [{ kind: sel.kind === 'audio' ? 'audio' : 'video', hidden: false, opacity: 1, muted: false, volume: 1, clips: [expClip(sel, 0)] }]
      : tracks.map((tr) => ({ kind: tr.kind || 'video', hidden: tr.hidden, opacity: tr.opacity, muted: tr.muted, volume: tr.volume, clips: tr.clips.map((c) => expClip(c, c.start, tr)) }));
    const duration = exportDuration();
    const t0 = performance.now();
    // Audio files are decoded completely before the export starts.
    const pcmSources = [...new Set(exportClips().filter((c) => c.kind === 'audio' && audibleClip(c)).map(srcOf).filter((x) => x && x.kind === 'audio'))];
    try {
      for (const src of pcmSources) {
        $('progressLabel').textContent = `Reading audio "${src.name}"…`;
        try { src.pcm = await pcmOf(src); } catch (e) { const er = new Error(`The audio file "${src.name}" couldn't be read.`); er.name = e && e.name === 'NotReadableError' ? 'NotReadableError' : 'Error'; throw er; }
      }
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
      for (const src of pcmSources) delete src.pcm; // free the memory
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
  // ---------------------------------------------------------------------------
  // Batch convert (Menu): many videos with the same settings, one after the
  // other. Each keeps its own format; projects aren't touched.
  // ---------------------------------------------------------------------------
  const batch = { items: [], running: false, ctl: null, name: '' };
  let batchUid = 0;
  const bSettings = () => ({
    res: $('bResSel').value, quality: $('bQualitySel').value,
    bitrateMbps: clamp(parseFloat($('bBitrate').value) || 4, 0.1, 100), targetMB: clamp(parseFloat($('bTarget').value) || 25, 1, 4000),
    fps: $('bFpsSel').value, codec: $('bCodecSel').value, sound: $('bSoundSel').value, meta: $('bMetaSel').value,
  });
  function bOutFor(it, st) {
    const src = it.src;
    const d = Render.displaySize(src);
    const short = Math.min(d.w, d.h);
    const f = (st.res === 'source' ? short : Math.min(short, +st.res)) / short;
    const settings = {
      width: even(d.w * f), height: even(d.h * f),
      quality: st.quality, bitrateMbps: st.bitrateMbps, targetMB: st.targetMB, lockRes: false,
      fps: st.fps, codec: st.codec, muteAll: st.sound === 'remove', fit: 'bars', bg: '#000000',
    };
    const dur = src.rangeOut - src.rangeIn;
    return { settings, out: Render.computeOutput(settings, [src], dur), dur };
  }
  function dateParts(m, fallbackMs) {
    if (m && m.utc != null) {
      const tz = m.tz != null ? m.tz : -new Date(m.utc).getTimezoneOffset();
      const d = new Date(m.utc + tz * 60000);
      return { Y: d.getUTCFullYear(), M: d.getUTCMonth() + 1, D: d.getUTCDate(), h: d.getUTCHours(), m: d.getUTCMinutes(), s: d.getUTCSeconds() };
    }
    const d = new Date(fallbackMs || Date.now());
    return { Y: d.getFullYear(), M: d.getMonth() + 1, D: d.getDate(), h: d.getHours(), m: d.getMinutes(), s: d.getSeconds() };
  }
  function bNameOf(it, n, st) {
    const { out } = bOutFor(it, st);
    const src = it.src;
    const d = Render.displaySize(src);
    const short = Math.min(out.width, out.height);
    const q = st.quality === 'custom' ? `${st.bitrateMbps}mbps` : st.quality === 'target' ? `${st.targetMB}mb` : st.quality;
    const t = { res: `${short}p`, quality: q, fps: `${out.fps}fps`, bitrate: `${(out.bitrate / 1e6).toFixed(1).replace(/\.0$/, '')}mbps`, dims: `${out.width}x${out.height}`, codec: st.codec === 'hevc' ? 'hevc' : 'h264' };
    const base = cleanFileName(baseName(src.name)) || 'video';
    if (!batch.name) {
      const changed = [];
      if (Math.abs(Math.min(d.w, d.h) - short) > 2) changed.push(t.res);
      changed.push(t.quality);
      if (Math.round(src.frameRate || 30) !== out.fps) changed.push(t.fps);
      return [base, ...changed].join('_');
    }
    return cleanFileName(expandName(batch.name, n, { src, base, t, out, dateParts: dateParts(src.fileMeta, src.origLastModified) })) || 'video';
  }
  // Names of all items, made unique (…_2, …_3).
  function bNames(st) {
    const seen = new Map();
    let n = 0;
    for (const it of batch.items) {
      if (!it.src) { it.outName = ''; continue; }
      let nm = bNameOf(it, ++n, st);
      const key = nm.toLowerCase();
      const c = (seen.get(key) || 0) + 1;
      seen.set(key, c);
      if (c > 1) nm += '_' + c;
      it.outName = nm;
    }
  }
  function renderBatch() {
    const st = bSettings();
    bNames(st);
    $('bBitrateField').hidden = st.quality !== 'custom';
    $('bTargetField').hidden = st.quality !== 'target';
    $('bFolderRow').hidden = !window.showDirectoryPicker;
    $('bFolder').disabled = $('bZip').checked;
    const ul = $('batchList');
    ul.replaceChildren(...batch.items.map((it) => {
      const li = document.createElement('li');
      li.dataset.id = it.id;
      const info = document.createElement('div');
      info.className = 'b-info';
      const nm = document.createElement('div');
      nm.className = 'b-name';
      nm.textContent = it.file.name;
      const mt = document.createElement('div');
      mt.className = 'b-meta';
      if (it.status === 'reading') mt.textContent = 'Reading…';
      else if (it.status === 'error') { mt.className += ' err'; mt.textContent = it.err; }
      else {
        const d = Render.displaySize(it.src);
        const { out, dur } = bOutFor(it, st);
        const est = Render.estimateSize(out, dur, st.sound !== 'remove' && it.src.audioDecodable);
        if (it.status === 'working') mt.textContent = `Converting… ${Math.floor((it.p || 0) * 100)} %`;
        else if (it.status === 'done') { mt.className += ' ok'; mt.textContent = `✓ ${fmtSize(it.file.size)} → ${fmtSize(it.outSize)} (−${Math.max(0, Math.round((1 - it.outSize / it.file.size) * 100))} %) · ${it.savedAs}`; }
        else if (it.status === 'kept') { mt.className += ' ok'; mt.textContent = `✓ Original kept — the result would have been bigger${it.savedAs ? ' · ' + it.savedAs : ''}`; }
        else mt.textContent = `${d.w}×${d.h} · ${fmtTime(dur, false)} · ${fmtSize(it.file.size)} → ≈ ${fmtSize(est)} → ${it.outName}.mp4`;
      }
      info.append(nm, mt);
      li.append(info);
      if (!batch.running) {
        const x = document.createElement('button');
        x.type = 'button'; x.textContent = '✕'; x.title = 'Remove from the list'; x.dataset.act = 'remove';
        li.append(x);
      }
      if (it.status === 'working') { const bar = document.createElement('div'); bar.className = 'b-bar'; bar.style.width = ((it.p || 0) * 100).toFixed(1) + '%'; li.append(bar); }
      return li;
    }));
    const ready = batch.items.filter((it) => it.src && it.status === 'ready').length;
    $('bStart').disabled = batch.running || !ready;
    $('bStart').textContent = batch.running ? 'Converting…' : `Convert ${ready} video${ready === 1 ? '' : 's'}`;
    $('batchSettings').querySelectorAll('select, input').forEach((el) => { el.disabled = batch.running || (el.id === 'bFolder' && $('bZip').checked); });
    $('batchAddBtn').disabled = batch.running;
    const first = batch.items.find((it) => it.src);
    $('bName').value = batch.name;
    $('bNamePreview').textContent = first ? `e.g. ${first.outName}.mp4` : batch.name ? '' : 'Original name + what changed, e.g. 20261105_175525_720p_small';
    fillBatchNameOptions();
  }
  function fillBatchNameOptions() {
    const opt = (v, l) => Object.assign(document.createElement('option'), { value: v, textContent: l });
    const grp = (label, opts) => { const g = document.createElement('optgroup'); g.label = label; g.append(...opts); return g; };
    $('bNameSel').replaceChildren(
      opt('', '▾'),
      grp('Name', [opt('set:', 'Automatic · original + what changed'), opt('set:*_videcutto', '*_videcutto'), opt('set:$Y$M$D_$h$m$s', '$Y$M$D_$h$m$s · recording date'), opt('set:*_$P_$Q', '*_$P_$Q'), opt('set:Video_###', 'Video_### · numbered')]),
      grp('Add to the name', ['$P', '$Q', '$F', '$B', '$R'].map((x) => opt('add:' + x, '+ _' + x))),
      grp('Pattern', [opt('help', 'Placeholders…')]),
    );
    $('bNameSel').value = '';
  }
  async function addBatchFiles(files) {
    for (const file of files) {
      if (!/^video\//.test(file.type) && !/\.(mp4|mov|m4v)$/i.test(file.name)) { toast(`"${file.name}" isn't a video.`, 3000); continue; }
      const it = { id: 'b' + (++batchUid), file, status: 'reading' };
      batch.items.push(it);
      renderBatch();
      try {
        const probed = await probe(file);
        const v = probed.demux.video;
        const start = Math.max(0, v.start);
        it.src = makeSource({ id: it.id, name: file.name, origSize: file.size, origLastModified: file.lastModified, start, duration: v.duration, rangeIn: start, rangeOut: v.duration }, file, probed, 0);
        it.status = 'ready';
      } catch (e) { it.status = 'error'; it.err = e && e.message ? e.message : String(e); }
      renderBatch();
    }
  }
  function dropBatchItem(it) {
    if (it.src && it.src.url) URL.revokeObjectURL(it.src.url);
    batch.items = batch.items.filter((x) => x !== it);
  }
  function downloadBlob(blob, name) {
    const a = document.createElement('a');
    const url = URL.createObjectURL(blob);
    a.href = url; a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 120000);
  }
  const stamp = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`; };
  async function runBatch() {
    if (batch.running) return;
    if (exporting) { toast('A video is being created — wait until it\'s done.'); return; }
    const todo = batch.items.filter((it) => it.src && it.status === 'ready');
    if (!todo.length) return;
    pause();
    const st = bSettings();
    bNames(st);
    const useZip = $('bZip').checked;
    let dir = null;
    if (!useZip && $('bFolder').checked && window.showDirectoryPicker) {
      try { dir = await window.showDirectoryPicker({ id: 'videcutto-batch', mode: 'readwrite' }); } catch (e) { return; }
    }
    batch.running = true; exporting = true;
    batch.ctl = new AbortController();
    const signal = batch.ctl.signal;
    $('bProgress').hidden = false; $('bSummary').hidden = true;
    let lock = null;
    try { if (navigator.wakeLock) lock = await navigator.wakeLock.request('screen'); } catch (e) { lock = null; }
    const zipEntries = [];
    const usedNames = new Set();
    const uniq = (name) => { let n = name, k = 2; const dot = name.lastIndexOf('.'); while (usedNames.has(n.toLowerCase())) n = name.slice(0, dot) + '_' + (k++) + name.slice(dot); usedNames.add(n.toLowerCase()); return n; };
    let saved = 0, before = 0, failed = 0, aborted = false;
    const label = (k, f, what) => {
      $('bProgressFill').style.width = (((k + f) / todo.length) * 100).toFixed(1) + '%';
      $('bProgressLabel').textContent = `${what} ${k + 1} of ${todo.length}… ${Math.floor(f * 100)} %`;
    };
    renderBatch();
    for (let k = 0; k < todo.length; k++) {
      const it = todo[k];
      if (signal.aborted) { aborted = true; break; }
      it.status = 'working'; it.p = 0;
      renderBatch();
      try {
        const { settings, dur } = bOutFor(it, st);
        const fm = it.src.fileMeta || {};
        let meta = st.meta === 'none' ? null : { ...fm };
        if (meta && st.meta === 'noloc') { delete meta.lat; delete meta.lon; delete meta.alt; }
        settings.meta = hasMeta(meta) ? meta : null;
        const src = it.src;
        const clip = { kind: 'video', source: src, start: 0, in: src.rangeIn, out: src.rangeOut, muted: st.sound === 'remove', tf: null, volume: 1, fadeIn: 0, fadeOut: 0, vFadeIn: 0, vFadeOut: 0 };
        let lastPaint = 0;
        const r = await Render.exportTimeline({
          tracks: [{ kind: 'video', hidden: false, opacity: 1, muted: false, volume: 1, clips: [clip] }],
          duration: dur, settings, signal,
          onProgress: (f) => {
            it.p = f; label(k, f, 'Converting');
            const now = performance.now();
            if (now - lastPaint > 250) { lastPaint = now; const li = $('batchList').querySelector(`li[data-id="${it.id}"]`); if (li) { const bar = li.querySelector('.b-bar'); if (bar) bar.style.width = (f * 100).toFixed(1) + '%'; li.querySelector('.b-meta').textContent = `Converting… ${Math.floor(f * 100)} %`; } }
          },
        });
        let blob = r.blob, name = it.outName + '.mp4', kept = false;
        if ($('bKeepSmaller').checked && blob.size >= it.file.size) { blob = it.file; name = it.file.name; kept = true; }
        name = uniq(name);
        if (useZip) { zipEntries.push({ name, blob }); it.savedAs = 'in the ZIP'; }
        else if (dir) { const fh = await dir.getFileHandle(name, { create: true }); const w = await fh.createWritable(); await w.write(blob); await w.close(); it.savedAs = `saved as ${name}`; }
        else if (!kept) { downloadBlob(blob, name); it.savedAs = `downloaded as ${name}`; }
        else it.savedAs = '';
        it.status = kept ? 'kept' : 'done';
        it.outSize = blob.size;
        before += it.file.size; saved += blob.size;
      } catch (e) {
        if (e && e.name === 'AbortError') { it.status = 'ready'; aborted = true; break; }
        console.error(e);
        it.status = 'error'; it.err = 'Failed: ' + (e && e.message ? e.message : e);
        failed++;
      }
      renderBatch();
    }
    try {
      if (useZip && zipEntries.length && !aborted) {
        $('bProgressLabel').textContent = 'Packing the ZIP file…';
        const z = await Zip.createZip(zipEntries, { signal, onProgress: (f) => { $('bProgressFill').style.width = (f * 100).toFixed(1) + '%'; } });
        downloadBlob(z, `videcutto_${stamp()}.zip`);
      }
    } catch (e) { if (!(e && e.name === 'AbortError')) toast('The ZIP file couldn\'t be created: ' + (e && e.message ? e.message : e), 6000); else aborted = true; }
    finally {
      batch.running = false; exporting = false; batch.ctl = null;
      if (lock) lock.release().catch(() => {});
      $('bProgress').hidden = true;
      const done = batch.items.filter((it) => it.status === 'done' || it.status === 'kept').length;
      $('bSummary').hidden = false;
      $('bSummary').textContent = (aborted ? 'Stopped. ' : 'Done! ') + `${done} video${done === 1 ? '' : 's'}` + (before ? `: ${fmtSize(before)} → ${fmtSize(saved)}` + (saved < before ? ` (−${Math.round((1 - saved / before) * 100)} %)` : '') : '') + (failed ? ` · ${failed} failed` : '') + (!useZip && !dir && done ? ' · the files are in your downloads.' : '');
      renderBatch();
    }
  }
  $('batchItem').addEventListener('click', () => { closeMenu(); openModal('batchModal'); renderBatch(); });
  $('batchAddBtn').addEventListener('click', async () => { const sel = await pickFiles(true, false); addBatchFiles(sel.map((x) => x.file)); });
  $('batchList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act="remove"]');
    if (!b || batch.running) return;
    const it = batch.items.find((x) => x.id === b.closest('li').dataset.id);
    if (it) { dropBatchItem(it); renderBatch(); }
  });
  $('batchSettings').addEventListener('change', (e) => { if (e.target.id !== 'bName' && e.target.id !== 'bNameSel') renderBatch(); });
  $('bName').addEventListener('change', (e) => { batch.name = cleanPattern(e.target.value); renderBatch(); });
  $('bName').addEventListener('input', (e) => { batch.name = cleanPattern(e.target.value); bNames(bSettings()); const first = batch.items.find((it) => it.src); $('bNamePreview').textContent = first ? `e.g. ${first.outName}.mp4` : ''; });
  $('bNameSel').addEventListener('change', (e) => {
    const v = e.target.value;
    e.target.value = '';
    if (!v) return;
    if (v === 'help') { openModal('namePhModal'); return; }
    if (v.startsWith('set:')) batch.name = v.slice(4);
    else if (v.startsWith('add:')) batch.name = (batch.name || '*') + '_' + v.slice(4);
    renderBatch();
  });
  $('bStart').addEventListener('click', runBatch);
  $('bCancel').addEventListener('click', () => { if (batch.ctl) batch.ctl.abort(); });
  function closeBatch() {
    if (batch.running) { if (!confirm('Stop the batch conversion?')) return; batch.ctl.abort(); }
    closeModal('batchModal');
    // Finished items leave the list; waiting ones stay for the next time.
    batch.items.filter((it) => it.status === 'done' || it.status === 'kept' || it.status === 'error').forEach(dropBatchItem);
    $('bSummary').hidden = true;
  }
  $('batchClose').addEventListener('click', closeBatch);
  $('batchModal').addEventListener('click', (e) => { if (e.target.id === 'batchModal' && !batch.running) closeBatch(); });
  $('batchModal').addEventListener('dragover', (e) => { if (!batch.running) e.preventDefault(); });
  $('batchModal').addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); if (!batch.running) addBatchFiles([...e.dataTransfer.files]); });

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
    const add = (list) => list.forEach((tr) => tr.clips.forEach((c) => {
      if (c.srcId) ids.add(c.srcId);
      if (c.text && String(c.text.font).startsWith('src:')) ids.add(c.text.font.slice(4)); // fonts of text clips
    }));
    add(tracks);
    undoStack.forEach(add);
    redoStack.forEach(add);
    if (clipboard && clipboard.items) clipboard.items.forEach((it) => { if (it.data.srcId) ids.add(it.data.srcId); });
    return ids;
  }

  function disposeSource(src) {
    if (src.url) URL.revokeObjectURL(src.url);
    (src.thumbs || []).forEach((u) => u && URL.revokeObjectURL(u));
    if (src.bitmap) src.bitmap.close();
  }

  // Drop media that nothing (timeline, undo/redo, clipboard) refers to anymore.
  // Working copies are only deleted if no other project uses them.
  // Files stay in the media list even when no clip uses them; they are only
  // dropped when removed there (removeMedia).
  function cleanupMedia() {}
  function dropSource(src) {
    if (src.storage === 'opfs' && src.copyName) Project.releaseCopy(src.copyName);
    if (src.storage === 'handle') Project.removeHandle(src.id);
    disposeSource(src);
    sources.delete(src.id);
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
      metaChoice,
      contentsOpen,
      // Undo/redo survive a reload (as many steps as set in Settings).
      undo: undoStack.slice(-settings.undoSteps),
      redo: redoStack.slice(-settings.undoSteps),
      // Bottom track first; tracks[0] is the main track.
      tracks: tracks.map((t) => ({ ...t, kind: t.kind || 'video', clips: t.clips.map((c) => ({ ...c })) })),
      media: [...sources.values()].map(mediaMeta),
      thumb: await projectThumb().catch(() => ''),
    };
    if (id !== projectId || !saveEnabled) return; // project closed meanwhile
    await Project.saveProject(doc);
    projectSaved = true;
    if (bc) bc.postMessage({ type: 'saved', id });
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden && saveEnabled) { clearTimeout(saveTimer); saveNow(); } });
  // After switching apps or a long screen-off the browser may have dropped the
  // videos (or a file's handle): check and load them again — what a reload did.
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => { if (document.hidden) hiddenAt = Date.now(); else healPreview(Date.now() - hiddenAt > 15000); });
  window.addEventListener('pageshow', (e) => { if (e.persisted) healPreview(true); });
  let healing = false;
  async function healPreview(long) {
    if (healing || $('editorScreen').hidden || !allClips().length) return;
    healing = true;
    try {
      let reopened = 0;
      for (const src of [...sources.values()]) {
        if (src.missing || !src.file || src.kind === 'font' || src.kind === 'image') continue;
        let ok = true;
        try { await src.file.slice(0, 16).arrayBuffer(); } catch (e) { ok = false; }
        if (ok || src.storage !== 'opfs' || !src.copyName) continue;
        try {
          const f = await Project.getCopy(src.copyName);
          if (!f) continue;
          const old = src.url;
          if (src.kind === 'video') Object.assign(src, makeSource(mediaMeta(src), f, await probe(f), src.base), { thumbs: src.thumbs, thumbStep: src.thumbStep, thumbAspect: src.thumbAspect, storage: 'opfs', copyName: src.copyName });
          else { src.file = f; src.url = URL.createObjectURL(f); }
          URL.revokeObjectURL(old);
          reopened++;
        } catch (e) { /* stays as it is */ }
      }
      const broken = allEls().some((v) => v.dataset.src && (v.error || v.readyState === 0));
      if (!long && !broken && !reopened) return;
      if (playing) pause();
      allEls().forEach((v) => { delete v.dataset.src; delete v.dataset.url; delete v.dataset.clip; v.removeAttribute('src'); try { v.load(); } catch (e) { /* ignore */ } });
      syncPool(true);
      renderPreview();
    } finally { healing = false; }
  }

  async function isReadable(src) {
    if (!src || !src.file) return false;
    try { await src.file.slice(0, 16).arrayBuffer(); return true; } catch (e) { return false; }
  }
  async function unreadableSources() {
    // Images are decoded into memory when loaded, only videos and sounds are read during export.
    const used = [...new Set(exportClips().filter(isSoundClip).map((c) => srcOf(c)).filter(Boolean))];
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
    history.replaceState(history.state, '', url); // keep the back-button guard
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
    exportName = ''; exportDone = false; metaChoice = defaultMetaChoice();
    openUses.clear(); setMediaFolded(true);
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
    if (m.kind === 'font') {
      const src = Object.assign(makeFontSource(m, file), extra);
      const key = 'src:' + m.id;
      const p = registerUserFont(src).then((ok) => { if (ok) { fontReady.add(key); textCache.clear(); renderPreview(); } else fontLoads.delete(key); return ok; });
      fontLoads.set(key, p);
      return src;
    }
    if (m.kind === 'audio') {
      let duration = m.duration;
      if (!(duration > 0)) duration = (await decodeAudioFile(file)).duration; // project file from elsewhere
      return Object.assign(makeAudioSource({ ...m, duration }, file), extra);
    }
    if (m.kind === 'image') {
      const bmp = await decodeImage(file).catch(() => { throw new Error(`"${file.name}" couldn't be opened as an image.`); });
      return Object.assign(makeImageSource(m, file, bmp), extra);
    }
    const probed = await probe(file);
    const src = makeSource(m, file, probed, base);
    Object.assign(src, peaksFromMeta(m), extra);
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
    const savedUndo = Array.isArray(p.undo) ? p.undo.filter(Array.isArray) : [];
    const savedRedo = Array.isArray(p.redo) ? p.redo.filter(Array.isArray) : [];
    for (const list of [tl, ...savedUndo, ...savedRedo]) list.forEach((t) => { if (t.id) bump(t.id); (t.clips || []).forEach((c) => { bump(c.id); if (c.group) bump(c.group); }); (t.markers || []).forEach((m) => bump(m.id)); });
    uid = Math.max(uid, maxId);
    // Projects before 0.8 have one track without track settings.
    const normTracks = (list) => list.map((t, i) => ({
      ...newTrack(i === 0, t.kind === 'audio' ? 'audio' : 'video'),
      ...(t.id ? { id: t.id } : {}),
      magnetic: t.magnetic !== undefined ? !!t.magnetic : i === 0,
      hidden: !!t.hidden,
      opacity: t.opacity != null ? clamp(+t.opacity, 0, 1) : 1,
      muted: !!t.muted,
      volume: t.volume != null ? clamp(+t.volume, 0, 1) : 1,
      manual: !!t.manual,
      ...(i === 0 && Array.isArray(t.markers) && t.markers.length ? { markers: t.markers.map((m) => ({ ...m })) } : {}),
      clips: (t.clips || []).map((c) => ({ ...c, kind: c.kind || 'video' })),
    })).filter((t, i) => i === 0 || t.clips.length || t.manual);
    setTracks(normTracks(tl));
    // Undo/redo steps saved with the project (since 0.9.6).
    undoStack = savedUndo.slice(-settings.undoSteps).map(normTracks);
    redoStack = savedRedo.slice(-settings.undoSteps).map(normTracks);
    clipboard = null; selectedId = null; selectedTrackId = null;
    exportName = cleanPattern(p.exportName || '');
    metaChoice = Object.assign(defaultMetaChoice(), p.metaChoice || {});
    setMediaFolded(!p.contentsOpen);
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
    // Files no clip (and no undo step) needs don't have to be found now: they
    // stay in the media list as missing and can be relinked from there.
    const usedIds = referencedIds();
    entries.forEach((e) => { if (!e.src && !usedIds.has(e.meta.id)) sources.set(e.meta.id, missingStub(e.meta)); });
    for (let i = entries.length - 1; i >= 0; i--) if (!entries[i].src && !usedIds.has(entries[i].meta.id)) entries.splice(i, 1);
    const missing = entries.filter((e) => !e.src);
    const finish = () => {
      saveEnabled = true;
      playhead = clamp(p.playhead || 0, 0, totalDuration());
      showEditor();
      syncCanvasUI();
      syncExportUI();
      updatePreviewAspect();
      updateEstimate();
      sources.forEach((s) => { if (!s.missing && !s.thumbs.length) queueThumbs(s); });
      allClips().forEach((c) => { if (c.kind === 'audio') queuePeaks(srcOf(c)); });
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
    showBusy(m.kind === 'image' ? 'Opening image…' : m.kind === 'audio' ? 'Opening audio…' : 'Opening video…', file.name);
    try {
      const src = await attach(m, file, 0, { storage: handle ? 'handle' : 'none', copyName: null });
      if (old) { src.thumbs = old.thumbs; src.thumbStep = old.thumbStep; src.thumbAspect = old.thumbAspect; if (old.url) URL.revokeObjectURL(old.url); }
      if (m.kind === 'video' && src.fileDuration + 0.05 < m.rangeOut) toast(`"${file.name}" is shorter than the original — some cuts may be cut off.`, 6000);
      hideBusy();
      if (m.kind === 'image') {
        if (Project.canCopy()) {
          const name = `${src.id}-${Date.now().toString(36)}-${++copyCounter}.img`;
          try { src.file = await Project.copyWhole(name, file); src.storage = 'opfs'; src.copyName = name; } catch (err) { /* keep */ }
        }
        if (src.storage !== 'opfs' && handle) await Project.saveHandle(src.id, handle);
        if (!src.thumbs.length) queueThumbs(src);
      } else if (m.kind === 'audio') {
        if ((isCoarse || !handle) && Project.canCopy()) {
          const name = `${src.id}-${Date.now().toString(36)}-${++copyCounter}${(/\.[a-z0-9]+$/i.exec(file.name || '') || ['.audio'])[0]}`;
          try {
            src.file = await Project.copyWhole(name, file);
            URL.revokeObjectURL(src.url); src.url = URL.createObjectURL(src.file);
            src.storage = 'opfs'; src.copyName = name;
          } catch (err) { /* keep */ }
        }
        if (src.storage !== 'opfs' && handle) await Project.saveHandle(src.id, handle);
      } else if (!(await makeWorkingCopy(src)) && handle) await Project.saveHandle(src.id, handle);
      if (src.storage !== 'handle') Project.removeHandle(src.id);
      if (old && old.storage === 'opfs' && old.copyName && old.copyName !== src.copyName) {
        Project.releaseCopy(old.copyName);
      }
      sources.set(src.id, src);
      allEls().forEach((v) => { if (v.dataset.src === src.id) delete v.dataset.url; });
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
            : e.meta.kind === 'audio' ? `Audio · ${fmtTime(e.meta.duration, false)} · ${fmtSize(e.meta.origSize)}`
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
              if (isAudioFile(file)) {
                const d = (await decodeAudioFile(file)).duration;
                e = entries.find((x) => !resolved(x) && x.meta.kind === 'audio' && Math.abs(x.meta.duration - d) < 0.2);
              } else {
                const d = await MP4.demux(file);
                e = entries.find((x) => !resolved(x) && Math.abs(x.meta.duration - d.video.duration) < 0.2 && x.meta.width === d.video.width && x.meta.height === d.video.height);
              }
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
        const keep = (list) => list.map((t) => ({ ...t, clips: t.clips.filter((c) => !gone.has(c.srcId)) })).filter((t, i) => i === 0 || t.clips.length || t.manual);
        setTracks(keep(tracks));
        undoStack = undoStack.map(keep);
        redoStack = redoStack.map(keep);
        if (selectedId && !findClip(selectedId)) selectedId = null;
        if (clipboard && clipboard.items && clipboard.items.some((it) => gone.has(it.data.srcId))) clipboard = null;
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
    meta2.textContent = bytes ? `${fmtSize(bytes)} in browser storage${linked ? ` · ${linked} linked` : ''}` : linked ? `${linked} linked file${linked === 1 ? '' : 's'} · no extra space` : 'Not stored — uses the picked file (select it again after a restart)';
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
      const kind = m.kind === 'image' ? 'Image' : m.kind === 'audio' ? 'Audio' : m.kind === 'font' ? 'Font' : 'Video';
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
            const ok = m.kind === 'image' || m.kind === 'audio' ? await copyImageToBrowser(src) : await makeWorkingCopy(src, true);
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
      const ext = (/\.[a-z0-9]{1,5}$/i.exec(src.name || '') || [m.kind === 'image' ? '.img' : m.kind === 'audio' ? '.audio' : '.mp4'])[0];
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
