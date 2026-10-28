# Videcutto

*Videos go cut & play!*

A privacy-friendly video editor and compressor that runs entirely in your browser. Cut, split, reorder and join videos on a timeline, then export them as a much smaller MP4 — no uploads, no server, works offline.

**Live at:** [videcutto.michels.world](https://videcutto.michels.world)

## Features

### Loading
- Select, drag & drop or **paste** (Ctrl+V, as in JPG75 is Enough) one or several **videos** (MP4, MOV, M4V — what phones and cameras record) and **images** (JPG, PNG, WebP, GIF, AVIF; HEIC where the browser supports it)
- **Gallery / Files** toggle above the picker on phones and tablets (hidden on desktop, where it makes no difference):
  - **Gallery** uses the OS media picker — quick, but Android doesn't preserve the original file name
  - **Files** opens the regular file browser and keeps real file names
- **Start with an empty canvas:** a new project with a 16:9 Full HD canvas and a 4-second anthracite color clip
- Videos are read **on demand** straight from the file instead of being loaded into memory as a whole, so even multi-gigabyte recordings open instantly
- New media are appended to the end of the timeline; you can also drop or paste files into the editor

### Images and color clips
- **Images** become clips of 4 seconds (adjustable); very large photos are scaled to max. 4096 px on the long side, EXIF orientation is respected
- **Color clips** (*Add → Color clip*) are single-color images: 4 seconds, anthracite and 1920×1080 by default; color, duration and size (presets, *Like canvas* or custom) are adjustable
- Both behave like videos on the timeline: cut, copy, paste, delete, reorder

### Pre-trimming
- For large videos, a **trim dialog** appears before the editor: drag the start/end handles (or use *Start here* / *End here* while previewing) to keep only the part you need
- "Large" means > 150 MB or > 3 min on phones/tablets, and > 1 GB or > 15 min on desktop
- Pre-trimming is instant — nothing is re-encoded; it simply limits which part of the file goes onto the timeline
- Configurable in **Settings**: offer for large videos (default), for every video, or never

### Editing
- One timeline with thumbnail strips; the playhead stays fixed in the centre — scroll the timeline to scrub
- Preview player with play/pause, frame-by-frame stepping and a time display
- Toolbar: **Undo / Redo** fixed on the left, **Add** (videos & images, or a color clip) fixed on the right; in between **Cut** at the playhead (split icon — splits the clip), **Copy**, **Paste** at the playhead (splits a clip if necessary) and **Delete**. If space ever runs out, only the middle part scrolls
- **Clip panel:** appears below the timeline while a clip is selected — **Mute** (videos), and for images/color clips the **duration**; for color clips also **color** and **size**
- **Reorder** clips by dragging (on touch devices: tap to select, then drag the selected clip)
- Mute all audio at once with the speaker button
- **Undo / Redo** — 10 steps by default (adjustable in Settings, 1–100)
- Zoom the timeline with the zoom buttons, pinch, or Ctrl + mouse wheel
- Keyboard shortcuts on desktop:

  | Key | Action |
  |---|---|
  | `Space` | Play / pause |
  | `←` / `→` | Previous / next frame |
  | `Shift` + `←` / `→` | Jump 1 second |
  | `C` or `S` | Cut at playhead |
  | `M` | Mute / unmute clip |
  | `Delete` / `Backspace` | Delete selected clip |
  | `Esc` | Deselect clip |
  | `Ctrl` + `C` / `V` | Copy clip / paste clip or files from the clipboard |
  | `Ctrl` + `Z` / `Y` | Undo / redo |
  | `Home` / `End` | Jump to start / end |

### Projects
- **Any number of projects**, each saved automatically after every change (clips, canvas, export settings, name)
- The start screen lists **Your projects** (most recent first) with cover image, name, clip count, length, last change and the storage they use; total storage and free space are shown below the list (with a warning when space gets low)
- Per project: **open**, **rename**, **duplicate**, **files & storage (ⓘ)** and **delete**
- Choosing media or *Start with an empty canvas* on the start screen always creates a **new project** (named after the first file, or "Project N"); nothing is discarded anymore
- The project name is shown above the preview in the editor and can be edited there
- **Duplicate** asks how: **share the video files** (no extra space — a shared working copy is only deleted when no project needs it anymore) or **independent copies** (needs the same space again, shown beforehand)
- **Several tabs:** each project has its own address (`#p=…`), so a reload reopens the same project and different projects can be edited side by side in different tabs. Opening a project that is already open in another tab asks first; the other tab then stops editing and saving it (Web Locks API). The list marks projects that are open in this or another tab
- **Files & storage (ⓘ):** lists every video/image of a project and where it is kept — *working copy in this browser's storage* (with size), *linked to the original file* (desktop) or *not stored*. Browsers never reveal folder paths for privacy reasons, so moved or renamed files are found again with **Relink…**; on desktop you can also switch between **Copy to browser** and **Use original** (frees space)
- Deleting a project removes only the copies no other project uses; original files are never touched
- The single project of versions 0.2–0.5 is moved into the list automatically

### Saving & restoring media
- **Phones/tablets:** each video gets a **working copy** in the browser's private storage (OPFS) right after loading — after pre-trimming only the chosen part is copied, losslessly (no re-encoding). This keeps videos available after a reload and fixes Android revoking the picker's read permission after a while ("The requested file could not be read…")
- **Desktop Chrome/Edge:** the app remembers the original files (File System Access API) instead of copying them; after a reload one click on *Allow access* reopens them
- **Everywhere (fallback):** if a video is missing — no copy, storage cleared, or access lost while editing — a dialog lists it and you **select it again**. Files are matched automatically by size (and by length/resolution as a fallback), so renamed files are recognised; all cuts are kept. Clips of videos that can't be found can be removed instead
- Working copies of videos no longer used anywhere (timeline, undo/redo, clipboard) are deleted automatically
- **Settings → Project** shows how much space the open project and all projects use and lets you **delete** the open project
- Leftover working copies that no project refers to (e.g. after a crash) are cleaned up after a day
- The saved format already supports several tracks, prepared for multiple timelines in a later version

### Crop, position, size & rotation (per clip)
The clip panel has four tabs — **Clip**, **Crop**, **Position**, **Rotate**. Opening a transform tab moves the playhead into the selected clip so it can be edited directly in the preview; on phones the preview then stays pinned at the top while you scroll the panel.
- **Crop** (videos and images): drag the frame or its corners in the preview (the whole picture is shown, the cut-off part darkened). Presets *Free*, *Like canvas*, 16:9, 9:16, 1:1, 4:5, 4:3 keep their ratio while resizing; *Reset crop*
- **Use as canvas** (in the Crop tab): the canvas takes the crop's aspect ratio and the export its exact pixel size, and the clip is fitted to fill it — together with *Selected clip only* this saves just that section of a video
- **Position:** 3×3 anchor grid (as in JPG75's watermark position) — e.g. top left puts the clip's top-left corner into the canvas' top-left corner, bottom center its bottom edge centre onto the canvas' bottom centre; choosing an anchor removes any manual offset
- **Move** the clip by dragging it in the preview (finger or mouse) — also beyond the canvas edges; parts outside are cut off, the canvas size never changes. A dashed frame shows where the clip lies. Fine-tune with the arrow pad (0.5 % per tap), ⊙ returns to the anchor
- **Snap** to the canvas centre and edges while dragging (guide lines appear); switchable, hold Alt on desktop to move freely
- **Size:** *Fit* (whole clip visible, default), *Fill* (canvas covered), *Free* with a slider (10–400 %), pinch with two fingers or scroll the mouse wheel over the preview
- **Rotate:** 90° left/right, free angle slider (−180° to 180°, snaps to 0°), flip horizontally/vertically, *Reset*
- Every change is one undo step (a drag, a slider move or a series of arrow taps); split clips keep their settings
- Color clips can be positioned, sized and rotated too (no crop)

### Canvas
- **Format:** 16:9, 9:16, 1:1, 4:5 (Instagram portrait), 4:3, 3:4, 21:9, **Like a video…** (choose which one; by default the first loaded video), **Like a crop…** (choose the clip; follows later changes of that crop, also after splitting the clip) or **Custom** (any ratio, e.g. 3 : 2)
- A new project that starts with a video takes that video's format; an empty canvas starts as 16:9
- **Background** for the space around videos and images that don't match the format: a **color** (default anthracite #293133) or a **blurred** copy of the visible video or image (color clips always use the color)
- The preview draws the canvas exactly like the export and always keeps the canvas ratio

### Export & compression
- **Resolution** — only sizes that fit the format, e.g. 16:9: HD 1280×720, Full HD 1920×1080 (default), UHD 3840×2160; 1:1: 1080×1080; 4:5: 1080×1350; *Like a video* adds *Source*, *Like a crop* adds *Crop size* (the crop's own pixels, no scaling); plus **Custom** (width and height stay linked to the format). A project that starts with a video smaller than 1080p uses its source size instead of upscaling
- **Quality:** Small / Standard (default) / High — about 0.05 / 0.08 / 0.14 bits per pixel, the resulting Mbit/s are shown in the list (e.g. Standard at Full HD 30 fps ≈ 5 Mbit/s); **Custom bitrate** in Mbit/s; or **Max. file size** in MB
- With *Max. file size*, the resolution is lowered automatically when the bitrate would be too low for it (a smaller sharp picture looks better than a large blocky one) — tick **Keep resolution** to prevent this; the estimate says when it happens
- Phone recordings typically shrink by 70–95 %, similar to what messengers do, but you choose the quality
- **Frame rate:** 30 fps (default), 60 fps, or like the source (max. 60)
- **Codec:** H.264 (plays everywhere) or H.265 (HEVC) where the browser can encode it
- Audio: AAC at 48 kHz stereo; where a browser can't encode AAC (e.g. Chromium on Linux, Firefox), Opus is used automatically and a note is shown
- Estimated output size is shown before exporting; progress with time remaining and a **Cancel** button during export
- **Never uses a higher bitrate than the source** (quality presets and max. file size, timelines with videos only): the video bitrate is capped at ~75 % of the source's (scaled to the output resolution and frame rate), and the audio bitrate at the source's. Already strongly compressed videos (e.g. from Instagram or WhatsApp) no longer get bigger — the estimate and the result show a note when exporting won't make a video noticeably smaller. A custom bitrate is used as entered
- Keeps the screen awake while exporting (Wake Lock API, where supported)
- **Whole timeline** or **Selected clip only** — export just one clip without deleting the others (prepared for special exports such as GIF or audio-only later)
- **Create video** starts the export; **Download** the result, or **Share** it directly (e.g. to a messenger) on devices that support sharing files

### General
- Dark mode by default, light mode via the menu
- Menu with theme toggle, Settings and About; fullscreen toggle in the header
- Mobile-first layout; the editor gets more width on desktop screens
- Installable as an app (PWA) and works offline after the first visit
- You're warned before a reload throws away your timeline

## Hints shown in the app

- **HEVC videos** (e.g. iPhone "High Efficiency") can't be decoded by every browser (Firefox, some Linux setups). The app tells you so instead of failing silently — use Chrome, Edge or Safari, or record in "Most compatible" (H.264).
- **Preview stutter:** with two or more clips, the preview may stutter briefly where clips meet, because the browser switches between video elements there. The exported file is not affected.
- Sound that can't be decoded, unsupported files and audio fallbacks are reported with a short message.

## How it works

Videcutto uses no third-party libraries — everything is vanilla HTML/CSS/JS, so there are no vendor files to download.

- **`mp4.js`** — a small ISO-BMFF demuxer and muxer. The demuxer reads only the `moov` box and the exact byte ranges of the samples it needs (via `Blob.slice()` with an 8 MB read window), supporting H.264, HEVC, VP9 and AV1 video, AAC and Opus audio, rotation metadata and edit lists. The muxer writes a "fast start" MP4 (moov before mdat, interleaved in 0.5 s chunks, 64-bit offsets for files > 4 GB).
- **`render.js`** — the export engine and the shared drawing code (`clipLayout` / `drawClip`: crop, size, anchor + offset, rotation and flip, used identically by preview and export). Each clip is decoded with **WebCodecs** (`VideoDecoder` / `AudioDecoder`, hardware-accelerated where available) starting at the nearest keyframe, every frame is drawn onto a canvas (rotation applied, fitted with black bars or a blurred background), and encoded with `VideoEncoder` / `AudioEncoder`. Audio is resampled to 48 kHz stereo; muted clips and clips without sound are filled with silence so audio and video stay in sync.
- **`project.js`** — persistence: the projects in IndexedDB (`project:<id>`), shared/duplicated working copies with reference checks, working copies in the Origin Private File System, file handles of originals on desktop. `mp4.js` provides the lossless range copy (`remuxRange`) used for trimmed working copies: it copies the samples from the keyframe before the in-point, keeps the original sample descriptions and rotation, and streams straight to storage without holding the video in memory.
- **`app.js`** — the UI: file and clipboard loading, pre-trim dialog, timeline, canvas and export settings, clip panel, undo/redo and the preview. The preview draws onto a `<canvas>` with the same drawing code as the export; two `<video>` elements underneath supply frames and sound (the next video clip is always preloaded), images and color clips run on a wall clock.

The preview uses the browser's native `<video>` decoding; the export uses WebCodecs, so what plays in the preview and what can be exported is decided by each browser's codec support.

## Files

- `index.html` — markup
- `style.css` — all styling
- `app.js` — UI logic
- `mp4.js` — MP4/MOV demuxer and muxer
- `render.js` — WebCodecs export engine
- `project.js` — autosave, working copies and file handles
- `sw.js` — service worker (offline, stale-while-revalidate)
- `manifest.json` — PWA manifest
- `netlify.toml` — security headers (no `Permissions-Policy` on purpose)
- `favicon.ico` — at the repo root for crawlers
- `icons/` — `logo.svg`, `favicon-16x16.png`, `favicon-32x32.png`, `apple-touch-icon.png`, `android-chrome-192x192.png`, `android-chrome-512x512.png`
- `CHANGELOG.md` — version history

## Browser support

Requires WebCodecs: current **Chrome / Edge** (best support, incl. HEVC on most devices), **Safari 17+** and **Firefox 130+**. Firefox can't decode HEVC videos. Fragmented MP4 files (some screen recorders) and WebM/MKV input aren't supported yet.

## Privacy

Videos are processed only on your device and never leave it. No tracking, no cookies, no third-party requests. `localStorage` is used only for the theme, settings and the last export settings; the project and working copies of your videos are kept in the browser's private storage on your device (IndexedDB / Origin Private File System) until you delete the project.
