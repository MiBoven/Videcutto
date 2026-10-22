/*
 * app.js — Videcutto UI: loading, pre-trimming, timeline editing, preview
 * playback and export. The heavy lifting lives in mp4.js and render.js.
 */
(() => {
  'use strict';

  const VERSION = '0.1.0';
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

  const totalDuration = () => clips.reduce((s, c) => s + (c.out - c.in), 0);
  const clipStart = (idx) => { let s = 0; for (let i = 0; i < idx; i++) s += clips[i].out - clips[i].in; return s; };
  const srcOf = (clip) => sources.get(clip.srcId);

  function clipAt(t) {
    let s = 0;
    for (let i = 0; i < clips.length; i++) {
      const len = clips[i].out - clips[i].in;
      if (t < s + len - 1e-6 || i === clips.length - 1) return { idx: i, offset: clamp(t - s, 0, len), start: s };
      s += len;
    }
    return { idx: -1, offset: 0, start: 0 };
  }

  window.addEventListener('beforeunload', (e) => {
    if (clips.length) { e.preventDefault(); e.returnValue = ''; }
  });

  // ---------------------------------------------------------------------------
  // Screens
  // ---------------------------------------------------------------------------
  function showStart() {
    pause();
    $('startScreen').hidden = false;
    $('editorScreen').hidden = true;
    $('backToEditor').hidden = clips.length === 0;
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
  $('backToEditor').addEventListener('click', showEditor);

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
    videos: "Video picker — fast, but original file names aren't preserved on Android.",
    files: 'File browser — pick "Files"/"My Files" (not Google Photos) to keep original file names.',
  };
  function setSourceMode(mode) {
    $('sourceToggle').querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
    fileInput.accept = mode === 'files' ? '*/*' : 'video/*';
    $('sourceHint').textContent = hints[mode];
    store.set('sourceMode', mode);
  }
  setSourceMode(store.get('sourceMode', 'videos'));
  $('sourceToggle').addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (btn) setSourceMode(btn.dataset.mode);
  });
  drop.addEventListener('click', () => fileInput.click());
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('drag'); }));
  drop.addEventListener('drop', (e) => handleFiles(e.dataTransfer.files));
  fileInput.addEventListener('change', () => { const f = [...fileInput.files]; fileInput.value = ''; handleFiles(f); });
  $('addBtn').addEventListener('click', () => fileInput.click());

  // Dropping files anywhere in the editor adds them too
  document.addEventListener('dragover', (e) => { if (!$('editorScreen').hidden) e.preventDefault(); });
  document.addEventListener('drop', (e) => {
    if ($('editorScreen').hidden || !e.dataTransfer.files.length) return;
    e.preventDefault();
    handleFiles(e.dataTransfer.files);
  });

  const isVideoFile = (f) => f.type.startsWith('video/') || /\.(mp4|m4v|mov|3gp)$/i.test(f.name);

  let loadingQueue = Promise.resolve();
  function handleFiles(fileList) {
    const files = [...fileList];
    const videos = files.filter(isVideoFile);
    if (!videos.length) { toast('Please choose video files (MP4, MOV, M4V).'); return; }
    if (videos.length < files.length) toast('Some files were skipped because they are not videos.');
    loadingQueue = loadingQueue.then(async () => {
      for (const f of videos) await addFile(f);
    });
  }

  async function addFile(file) {
    if (!Render.hasWebCodecs()) { toast('This browser can\'t process videos (no WebCodecs support).', 5000); return; }
    let demux;
    try {
      demux = await MP4.demux(file);
    } catch (e) {
      const msg = e.code === 'FRAGMENTED'
        ? `"${file.name}" is a fragmented MP4 (common for screen recordings), which isn't supported yet.`
        : /webm|mkv/i.test(file.name) || /Not an MP4/.test(e.message)
          ? `"${file.name}" isn't an MP4/MOV file. Videcutto currently supports MP4, MOV and M4V.`
          : `"${file.name}" couldn't be read: ${e.message}`;
      toast(msg, 6000);
      return;
    }
    const v = demux.video;
    if (!(await Render.canDecodeVideo(v))) {
      const hevc = v.codec === 'hevc';
      toast(hevc
        ? `"${file.name}" uses HEVC (H.265), which this browser can't decode. Try Chrome, Edge or Safari — or set your camera to "Most compatible" (H.264).`
        : `"${file.name}" uses a video codec (${v.codecString || v.format}) this browser can't decode.`, 7000);
      return;
    }
    const hasAudio = !!demux.audio;
    const audioDecodable = hasAudio ? await Render.canDecodeAudio(demux.audio) : false;
    const start = Math.max(0, v.start);
    const src = {
      id: 's' + (++uid),
      file,
      name: file.name,
      url: URL.createObjectURL(file),
      demux,
      width: v.width,
      height: v.height,
      rotation: v.rotation,
      frameRate: v.frameRate || 30,
      duration: v.duration,
      start,
      hasAudio,
      audioDecodable,
      thumbs: [],
      thumbStep: 1,
      rangeIn: start,
      rangeOut: v.duration,
    };
    if (hasAudio && !audioDecodable) toast(`The sound of "${file.name}" (${demux.audio.codecString || demux.audio.format}) can't be decoded here — it will be silent in the export.`, 6000);

    const big = file.size > THRESH.bytes || v.duration > THRESH.secs;
    const offer = settings.trimMode === 'always' || (settings.trimMode === 'auto' && big);
    if (offer) {
      const range = await openTrim(src, big);
      if (!range) { URL.revokeObjectURL(src.url); return; }
      src.rangeIn = range.in;
      src.rangeOut = range.out;
    }
    sources.set(src.id, src);
    const wasEmpty = clips.length === 0;
    commit(() => {
      clips.push({ id: newId(), srcId: src.id, in: src.rangeIn, out: src.rangeOut, muted: false });
    });
    if (wasEmpty) playhead = 0;
    showEditor();
    queueThumbs(src);
  }

  // ---------------------------------------------------------------------------
  // Thumbnails
  // ---------------------------------------------------------------------------
  let thumbQueue = Promise.resolve();
  function queueThumbs(src) { thumbQueue = thumbQueue.then(() => makeThumbs(src)).catch(() => {}); }

  async function makeThumbs(src) {
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
      const t = src.rangeIn + (k + 0.5) * src.thumbStep;
      v.currentTime = Math.min(t, src.duration - 0.05);
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
    clipboard = { srcId: c.srcId, in: c.in, out: c.out, muted: c.muted };
    if (!silent) toast('Clip copied — move the playhead and paste.');
    updateToolbar();
    return true;
  }
  function cutSelected() {
    if (!copySelected(true)) return;
    const i = selectedIndex();
    commit(() => { clips.splice(i, 1); selectedId = null; });
    toast('Clip cut — move the playhead and paste.');
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
    if (i < 0) return;
    commit(() => { clips[i] = { ...clips[i], muted: !clips[i].muted }; });
  }
  function toggleMuteAll() {
    muteAll = !muteAll;
    $('muteAllBtn').setAttribute('aria-pressed', String(muteAll));
    $('muteAllBtn').title = muteAll ? 'Unmute all audio' : 'Mute all audio';
    applyMute();
    updateEstimate();
  }

  $('undoBtn').addEventListener('click', undo);
  $('redoBtn').addEventListener('click', redo);
  $('splitBtn').addEventListener('click', splitAtPlayhead);
  $('deleteBtn').addEventListener('click', deleteSelected);
  $('cutBtn').addEventListener('click', cutSelected);
  $('copyBtn').addEventListener('click', () => copySelected(false));
  $('pasteBtn').addEventListener('click', paste);
  $('muteClipBtn').addEventListener('click', toggleMuteClip);
  $('muteAllBtn').addEventListener('click', toggleMuteAll);

  function updateToolbar() {
    const hasSel = selectedIndex() >= 0;
    $('undoBtn').disabled = !undoStack.length;
    $('redoBtn').disabled = !redoStack.length;
    $('splitBtn').disabled = !clips.length;
    $('deleteBtn').disabled = !hasSel;
    $('cutBtn').disabled = !hasSel;
    $('copyBtn').disabled = !hasSel;
    $('pasteBtn').disabled = !clipboard;
    $('muteClipBtn').disabled = !clips.length;
    const ref = hasSel ? clips[selectedIndex()] : (clips.length ? clips[clipAt(playhead).idx] : null);
    $('muteClipBtn').classList.toggle('on', !!(ref && ref.muted));
    $('muteClipBtn').querySelector('span').textContent = ref && ref.muted ? 'Unmute' : 'Mute';
    $('exportBtn').disabled = !clips.length || exporting;
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
    $('stutterHint').hidden = clips.length < 2;
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
      el.className = 'clip' + (c.id === selectedId ? ' selected' : '');
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
        label.textContent = `${fmtTime(len, false)}${w > 140 && src ? ' · ' + src.name : ''}`;
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
  // Preview playback (two <video> elements, the next clip is preloaded)
  // ---------------------------------------------------------------------------
  const vids = [$('vidA'), $('vidB')];
  let active = 0;
  let activeIdx = -1;
  const unlocked = new WeakSet();
  vids[1].classList.add('standby');

  function setVideoTime(el, t) {
    if (el.readyState >= 1) el.currentTime = t;
    else el.addEventListener('loadedmetadata', () => { el.currentTime = t; }, { once: true });
  }
  function loadInto(el, clip, t) {
    const src = srcOf(clip);
    if (!src) return;
    if (el.dataset.src !== src.id) {
      el.dataset.src = src.id;
      el.src = src.url;
    }
    setVideoTime(el, t);
  }
  function applyMute() {
    vids.forEach((el, i) => {
      const clip = i === active ? clips[activeIdx] : clips[activeIdx + 1];
      el.muted = muteAll || !clip || clip.muted;
    });
  }

  function seek(t, fromScroll) {
    playhead = clamp(t, 0, totalDuration());
    if (!clips.length) {
      vids.forEach((v) => { v.pause(); v.removeAttribute('src'); delete v.dataset.src; v.load(); });
      activeIdx = -1;
      updateTime();
      drawBlur();
      return;
    }
    const { idx, offset } = clipAt(playhead);
    const clip = clips[idx];
    activeIdx = idx;
    const el = vids[active];
    loadInto(el, clip, clip.in + offset);
    const next = clips[idx + 1];
    if (next) loadInto(vids[1 - active], next, next.in);
    applyMute();
    if (!fromScroll) syncScroll();
    updateTime();
    updateToolbar();
  }

  function setPlayIcon() {
    $('playIcon').innerHTML = playing
      ? '<path class="fill" d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/>'
      : '<path class="fill" d="M8 5.5v13l10.5-6.5z"/>';
    $('playBtn').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }

  function unlock(el) {
    // iOS only lets a <video> play with sound if play() was first called in a user gesture.
    if (unlocked.has(el)) return;
    unlocked.add(el);
    const wasMuted = el.muted;
    const t = el.currentTime;
    el.muted = true;
    el.play().then(() => { if (vids[active] !== el) { el.pause(); el.currentTime = t; } el.muted = wasMuted; applyMute(); }).catch(() => {});
  }

  function play() {
    if (!clips.length) return;
    if (playhead >= totalDuration() - 0.03) seek(0);
    playing = true;
    setPlayIcon();
    const el = vids[active];
    unlock(vids[1 - active]);
    unlocked.add(el);
    applyMute();
    el.play().catch((err) => {
      if (err && err.name === 'NotAllowedError') { el.muted = true; el.play().catch(() => {}); toast('Sound was blocked by the browser — tap play again for sound.'); }
    });
    requestAnimationFrame(tick);
  }
  function pause() {
    if (!playing) return;
    playing = false;
    vids.forEach((v) => v.pause());
    setPlayIcon();
  }
  $('playBtn').addEventListener('click', () => (playing ? pause() : play()));

  function switchToNext() {
    const cur = vids[active];
    const nextIdx = activeIdx + 1;
    const next = clips[nextIdx];
    const sb = vids[1 - active];
    cur.pause();
    // Make sure the standby element really holds the next clip.
    if (sb.dataset.src !== next.srcId || Math.abs(sb.currentTime - next.in) > 0.25) loadInto(sb, next, next.in);
    sb.classList.remove('standby');
    cur.classList.add('standby');
    active = 1 - active;
    activeIdx = nextIdx;
    applyMute();
    sb.play().catch(() => { sb.muted = true; sb.play().catch(() => {}); });
    const after = clips[nextIdx + 1];
    if (after) loadInto(cur, after, after.in);
  }

  function tick() {
    if (!playing) return;
    const el = vids[active];
    const clip = clips[activeIdx];
    if (!clip) { pause(); return; }
    const t = el.currentTime;
    playhead = clipStart(activeIdx) + clamp(t - clip.in, 0, clip.out - clip.in);
    if (t >= clip.out - 0.02 || el.ended) {
      if (activeIdx + 1 >= clips.length) {
        playhead = totalDuration();
        pause();
        syncScroll();
        updateTime();
        return;
      }
      switchToNext();
    }
    syncScroll();
    updateTime();
    drawBlur();
    requestAnimationFrame(tick);
  }

  function frameStep(dir) {
    if (!clips.length) return;
    pause();
    const src = srcOf(clips[clipAt(playhead).idx]);
    seek(playhead + dir / (src ? src.frameRate : 30));
  }
  $('frameBackBtn').addEventListener('click', () => frameStep(-1));
  $('frameFwdBtn').addEventListener('click', () => frameStep(1));

  function updateTime() {
    $('curTime').textContent = fmtTime(playhead);
    $('totalTime').textContent = fmtTime(totalDuration());
  }

  // Preview format and blurred background
  const preview = $('preview');
  const blurBg = $('blurBg');
  const blurCtx = blurBg.getContext('2d');
  let previewAspect = 16 / 9;

  function updatePreviewAspect() {
    if (!clips.length) return;
    const first = srcOf(clips[0]);
    if (!first) return;
    const a = $('aspectSel').value;
    const d = Render.displaySize(first);
    previewAspect = a === '16:9' ? 16 / 9 : a === '9:16' ? 9 / 16 : a === '1:1' ? 1 : d.w / d.h;
    preview.style.aspectRatio = String(previewAspect);
    // Limit width for portrait formats so the preview fits on screen.
    preview.style.maxWidth = previewAspect < 1 ? `calc(52vh * ${previewAspect})` : '';
    drawBlur();
  }

  function drawBlur() {
    const el = vids[active];
    const show = $('fitSel').value === 'blur' && clips.length && el.videoWidth &&
      Math.abs(el.videoWidth / el.videoHeight - previewAspect) > 0.02;
    blurBg.hidden = !show;
    if (!show) return;
    const w = 24, h = Math.max(4, Math.round(24 / previewAspect));
    if (blurBg.width !== w || blurBg.height !== h) { blurBg.width = w; blurBg.height = h; }
    const s = Math.max(w / el.videoWidth, h / el.videoHeight);
    try { blurCtx.drawImage(el, (w - el.videoWidth * s) / 2, (h - el.videoHeight * s) / 2, el.videoWidth * s, el.videoHeight * s); } catch (e) { /* not ready */ }
  }
  vids.forEach((v) => {
    v.addEventListener('seeked', () => { if (v === vids[active]) drawBlur(); });
    v.addEventListener('loadeddata', () => { if (v === vids[active]) drawBlur(); });
    v.addEventListener('error', () => {
      if (v === vids[active] && v.getAttribute('src')) toast('This browser can\'t preview this video, but exporting may still work.', 5000);
    });
  });

  // ---------------------------------------------------------------------------
  // Keyboard shortcuts
  // ---------------------------------------------------------------------------
  document.addEventListener('keydown', (e) => {
    if ($('editorScreen').hidden || exporting) return;
    if (document.querySelector('.modal-bg:not([hidden])')) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
    else if (mod && k === 'x') { e.preventDefault(); cutSelected(); }
    else if (mod && k === 'c') { e.preventDefault(); copySelected(false); }
    else if (mod && k === 'v') { e.preventDefault(); paste(); }
    else if (mod) return;
    else if (e.key === ' ') { e.preventDefault(); playing ? pause() : play(); }
    else if (k === 's') splitAtPlayhead();
    else if (k === 'm') toggleMuteClip();
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); e.shiftKey ? (pause(), seek(playhead - 1)) : frameStep(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); e.shiftKey ? (pause(), seek(playhead + 1)) : frameStep(1); }
    else if (e.key === 'Home') { pause(); seek(0); }
    else if (e.key === 'End') { pause(); seek(totalDuration()); }
  });

  // ---------------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------------
  const expEls = {
    preset: $('presetSel'), target: $('targetMB'), aspect: $('aspectSel'), fit: $('fitSel'), fps: $('fpsSel'), codec: $('codecSel'),
  };
  const savedExport = store.get('export', {});
  for (const k of Object.keys(expEls)) {
    if (savedExport[k] !== undefined) expEls[k].value = savedExport[k];
    expEls[k].addEventListener('change', onExportSettingChange);
    expEls[k].addEventListener('input', onExportSettingChange);
  }
  if (expEls.codec.value === 'hevc') expEls.codec.value = 'avc'; // re-enabled below if supported
  if (!expEls.preset.value) expEls.preset.value = 'hd';
  Render.canEncodeHevc().then((ok) => {
    const opt = expEls.codec.querySelector('option[value="hevc"]');
    if (ok) {
      opt.disabled = false;
      opt.textContent = 'HEVC · smaller, newer devices';
      if (savedExport.codec === 'hevc') expEls.codec.value = 'hevc';
    }
  });

  function getExportSettings() {
    return {
      preset: expEls.preset.value,
      targetMB: parseFloat(expEls.target.value) || 25,
      aspect: expEls.aspect.value,
      fit: expEls.fit.value,
      fps: expEls.fps.value,
      codec: expEls.codec.value,
      muteAll,
    };
  }
  function onExportSettingChange() {
    const s = getExportSettings();
    store.set('export', { preset: s.preset, target: s.targetMB, aspect: s.aspect, fit: s.fit, fps: s.fps, codec: s.codec });
    $('targetField').hidden = s.preset !== 'target';
    updatePreviewAspect();
    updateEstimate();
  }
  $('targetField').hidden = expEls.preset.value !== 'target';

  function sourceBytes() {
    return clips.reduce((sum, c) => {
      const s = srcOf(c);
      return s ? sum + ((c.out - c.in) / Math.max(0.01, s.duration)) * s.file.size : sum;
    }, 0);
  }

  function updateEstimate() {
    if (!clips.length) { $('estimate').textContent = ''; return; }
    const s = getExportSettings();
    const used = [...new Set(clips.map((c) => srcOf(c)).filter(Boolean))];
    const dur = totalDuration();
    const out = Render.computeOutput(s, srcOf(clips[0]), used, dur);
    const withAudio = !muteAll && clips.some((c) => !c.muted && srcOf(c) && srcOf(c).audioDecodable);
    const est = Render.estimateSize(out, dur, withAudio);
    $('estimate').innerHTML = `${out.width}×${out.height} · ${out.fps} fps · ${fmtTime(dur, false)}<br>` +
      `Estimated size: <strong>≈ ${fmtSize(est)}</strong> (source ≈ ${fmtSize(sourceBytes())})`;
  }

  let abortCtl = null;
  let resultUrl = null;
  let resultFile = null;
  let wakeLock = null;

  async function doExport() {
    if (!clips.length || exporting) return;
    pause();
    exporting = true;
    updateToolbar();
    $('resultBox').hidden = true;
    $('progressBox').hidden = false;
    $('progressFill').style.width = '0%';
    $('progressLabel').textContent = 'Preparing…';
    abortCtl = new AbortController();
    try { if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { wakeLock = null; }

    const s = getExportSettings();
    const expClips = clips.map((c) => ({ source: srcOf(c), in: c.in, out: c.out, muted: c.muted }));
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
    const first = srcOf(clips[0]);
    const base = (first ? first.name : 'video').replace(/\.[^.]+$/, '');
    const name = `${base}_videcutto.mp4`;
    resultFile = new File([r.blob], name, { type: 'video/mp4' });
    resultUrl = URL.createObjectURL(resultFile);
    const link = $('downloadLink');
    link.href = resultUrl;
    link.download = name;
    const before = sourceBytes();
    const after = r.blob.size;
    const saving = Math.round((1 - after / before) * 100);
    $('resultSizes').innerHTML = `Done! ${fmtSize(before)} → <strong>${fmtSize(after)}</strong>` +
      (saving > 0 ? ` <span class="saving">−${saving}%</span>` : '') +
      `<br><span class="hint">${r.out.width}×${r.out.height} · ${r.videoCodec === 'hevc' ? 'HEVC' : 'H.264'}${r.audioCodec ? ' · ' + (r.audioCodec === 'aac' ? 'AAC' : 'Opus') : ' · no sound'}</span>`;
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
  // Service worker
  // ---------------------------------------------------------------------------
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });
  }

  setPlayIcon();
  updateToolbar();
})();
