# Videcutto

*Videos go cut & play!*

A privacy-friendly video editor and compressor that runs entirely in your browser. Cut, split, reorder and join videos on a timeline, then export them as a much smaller MP4 — no uploads, no server, works offline.

**Live at:** [videcutto.michels.world](https://videcutto.michels.world)

## Features

### Loading
- Select or drag & drop one or several videos (MP4, MOV, M4V — i.e. what phones and cameras record)
- **Videos / Files** toggle above the picker (as in JPG75 is Enough):
  - **Videos** uses the OS media picker — quick, but Android doesn't preserve the original file name
  - **Files** opens the regular file browser and keeps real file names
- Videos are read **on demand** straight from the file instead of being loaded into memory as a whole, so even multi-gigabyte recordings open instantly
- Videos added later are appended to the end of the timeline; you can also drop files onto the editor

### Pre-trimming
- For large videos, a **trim dialog** appears before the editor: drag the start/end handles (or use *Start here* / *End here* while previewing) to keep only the part you need
- "Large" means > 150 MB or > 3 min on phones/tablets, and > 1 GB or > 15 min on desktop
- Pre-trimming is instant — nothing is re-encoded; it simply limits which part of the file goes onto the timeline
- Configurable in **Settings**: offer for large videos (default), for every video, or never

### Editing
- One timeline with thumbnail strips; the playhead stays fixed in the centre — scroll the timeline to scrub
- Preview player with play/pause, frame-by-frame stepping and a time display
- **Split** at the playhead, **Delete**, **Cut / Copy / Paste** (pastes at the playhead, splitting a clip if necessary)
- **Reorder** clips by dragging (on touch devices: tap to select, then drag the selected clip)
- **Mute** a single clip, or mute all audio at once
- **Undo / Redo** — 10 steps by default (adjustable in Settings, 1–100)
- Zoom the timeline with the zoom buttons, pinch, or Ctrl + mouse wheel
- Keyboard shortcuts on desktop:

  | Key | Action |
  |---|---|
  | `Space` | Play / pause |
  | `←` / `→` | Previous / next frame |
  | `Shift` + `←` / `→` | Jump 1 second |
  | `S` | Split at playhead |
  | `M` | Mute / unmute clip |
  | `Delete` / `Backspace` | Delete selected clip |
  | `Ctrl` + `X` / `C` / `V` | Cut / copy / paste |
  | `Ctrl` + `Z` / `Y` | Undo / redo |
  | `Home` / `End` | Jump to start / end |

### Export & compression
- **Quality presets:** HD 720p (default, ~2.5 Mbit/s), Full HD 1080p (~5 Mbit/s), Small 480p (~1 Mbit/s), Original resolution (bitrate lowered to ~0.07 bits per pixel), or **Target size** (enter a maximum in MB — bitrate and resolution are calculated from the total length)
- Phone recordings typically shrink by 80–95 %, similar to what messengers do, but you choose the quality
- **Format:** like the first video, 16:9, 9:16 or 1:1 — videos with a different shape get **black bars** or a **blurred background**
- **Frame rate:** 30 fps (default), 60 fps, or like the source (max. 60)
- **Codec:** H.264 (plays everywhere) or HEVC/H.265 where the browser can encode it
- Audio: AAC at 48 kHz stereo; where a browser can't encode AAC (e.g. Chromium on Linux, Firefox), Opus is used automatically and a note is shown
- Estimated output size is shown before exporting; progress with time remaining and a **Cancel** button during export
- Never upscales beyond the largest source video
- Keeps the screen awake while exporting (Wake Lock API, where supported)
- **Save** the result, or **Share** it directly (e.g. to a messenger) on devices that support sharing files

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
- **`render.js`** — the export engine. Each clip is decoded with **WebCodecs** (`VideoDecoder` / `AudioDecoder`, hardware-accelerated where available) starting at the nearest keyframe, every frame is drawn onto a canvas (rotation applied, fitted with black bars or a blurred background), and encoded with `VideoEncoder` / `AudioEncoder`. Audio is resampled to 48 kHz stereo; muted clips and clips without sound are filled with silence so audio and video stay in sync.
- **`app.js`** — the UI: file loading, pre-trim dialog, timeline, preview playback (two `<video>` elements, the next clip is always preloaded), undo/redo and export.

The preview uses the browser's native `<video>` playback; the export uses WebCodecs, so what plays in the preview and what can be exported is decided by each browser's codec support.

## Files

- `index.html` — markup
- `style.css` — all styling
- `app.js` — UI logic
- `mp4.js` — MP4/MOV demuxer and muxer
- `render.js` — WebCodecs export engine
- `sw.js` — service worker (offline, stale-while-revalidate)
- `manifest.json` — PWA manifest
- `netlify.toml` — security headers (no `Permissions-Policy` on purpose)
- `favicon.ico` — at the repo root for crawlers
- `icons/` — `logo.svg`, `favicon-16x16.png`, `favicon-32x32.png`, `apple-touch-icon.png`, `android-chrome-192x192.png`, `android-chrome-512x512.png`
- `CHANGELOG.md` — version history

## Browser support

Requires WebCodecs: current **Chrome / Edge** (best support, incl. HEVC on most devices), **Safari 17+** and **Firefox 130+**. Firefox can't decode HEVC videos. Fragmented MP4 files (some screen recorders) and WebM/MKV input aren't supported yet.

## Privacy

Videos are processed only on your device and never leave it. No tracking, no cookies, no third-party requests. `localStorage` is used only for the theme, settings and the last export settings.
