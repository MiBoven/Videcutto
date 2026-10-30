# Videcutto

*Videos go cut & play!*

A privacy-friendly video editor and compressor that runs entirely in your browser. Cut, split, reorder and join videos on a timeline, then export them as a much smaller MP4 — no uploads, no server, works offline.

**Live at:** [videcutto.michels.world](https://videcutto.michels.world)

## Features

### Loading
- Select, drag & drop or **paste** (Ctrl+V, as in JPG75 is Enough) one or several **videos** (MP4, MOV, M4V — what phones and cameras record), **images** (JPG, PNG, WebP, GIF, AVIF; HEIC where the browser supports it) and **audio files** (MP3, M4A, WAV, FLAC, OGG)
- **Gallery / Files** toggle above the picker on phones and tablets (hidden on desktop, where it makes no difference):
  - **Gallery** uses the OS media picker — quick, but Android doesn't preserve the original file name
  - **Files** opens the regular file browser and keeps real file names
- **Start with an empty canvas:** a new project with a 16:9 Full HD canvas and a 4-second anthracite color clip
- **Fragmented MP4** (streaming downloads, Safari/OBS "fragmented" recordings) is supported as well; a short note appears when a video has no sound
- Videos are read **on demand** straight from the file instead of being loaded into memory as a whole, so even multi-gigabyte recordings open instantly
- New media are appended to the end of the main track; *Add → As overlay* puts them on a track above, at the playhead. You can also drop or paste files into the editor

### Images and color clips
- **Images** become clips of 4 seconds (adjustable); very large photos are scaled to max. 4096 px on the long side, EXIF orientation is respected
- **Color clips** (*Add → Color clip*) are single-color images: 4 seconds, anthracite and 1920×1080 by default; color, duration and size (presets, *Like canvas* or custom) are adjustable
- Both behave like videos on the timeline: cut, copy, paste, delete, reorder, overlay

### Pre-trimming
- For large videos, a **trim dialog** appears before the editor: drag the start/end handles (or use *Start here* / *End here* while previewing) to keep only the part you need
- "Large" means > 150 MB or > 3 min on phones/tablets, and > 1 GB or > 15 min on desktop
- Pre-trimming is instant — nothing is re-encoded; it simply limits which part of the file goes onto the timeline
- Configurable in **Settings**: offer for large videos (default), for every video, or never

### Audio
- **Audio files** — MP3, M4A/AAC, WAV, FLAC, OGG/Opus (whatever the browser can decode; Safari has no OGG) — via *Add → Audio*, drag & drop or paste. They land at the playhead on the topmost **audio track** with room, or on a new one
- **Audio tracks** lie below the main track; they hold sound only (pictures can't be dragged onto them and vice versa). Clips sit freely in time, gaps are silent. Track header: 🔊 mute; tap it for volume, order and delete
- **Snapping:** while dragging, clips on free tracks (audio and overlays) snap to the start and end of all other clips and to the playhead (index points will follow) — within 14 px on desktop, 20 px on touch screens. A **blue line across all tracks** shows where the clip docks; Android phones vibrate briefly on each new snap (can be switched off in Settings). The magnet button below the timeline turns snapping off (remembered); hold Alt to move freely for a moment
- **Detach audio** (clip panel of a video): the sound becomes an audio clip right below, the video is muted. Both are independent afterwards (gluing comes later); undo reverts it
- **Audio tab** for videos and audio clips: **volume** 0–200 % (amplified above 100 %, a soft limiter prevents clipping) and **fade in / fade out** in seconds (smooth curve). Fades show as dark ramps, a changed volume as a badge on the clip
- **Waveform** on audio clips — computed once (also for detached video sound, in the background) and saved with the project
- Track volume × clip volume; all audible clips are mixed
- Preview: `<audio>` elements play the sound; volumes above 100 % use Web Audio (switched on with the first play that needs it)
- Exporting decodes audio files completely (48 kHz stereo) — fine for songs; a note appears for files longer than 30 min on phones / 2 h on desktop. Storage like videos: working copy on phones, linked original on desktop
- A project can consist of sound only — the video then shows the canvas background (audio-only export follows in a later version)

### Tracks (multiple timelines)
- The **main track** is at the bottom, under all others. It is **magnetic**: clips follow each other without gaps and are reordered by dragging. In its track settings the magnet can be switched off ("released") to place clips freely in time — gaps show the canvas background; switching it back on closes the gaps in the current order
- **Overlay tracks** above it are free: clips sit at any time, empty space is transparent, so the tracks below show through. Higher tracks are drawn on top
- **Add → As overlay** (videos & images, or a color clip) places the new clip at the playhead on the lowest overlay track with room — a new track is created if none has space. Overlays start at **50 % size, centred** (Size *Free*), ready to be moved
- **Move clips between tracks:** select a clip, then drag it up or down (and sideways). On the magnetic main track a marker shows where it will be inserted; on free tracks it snaps to the playhead and the edges of other clips. If there is no room at the drop position — or you drop above the top track — a new track is created. Only the selected clip can be dragged (also with the mouse), so scrolling never moves clips by accident
- **Track header** (left of each track): 👁 **hide** and 🔊 **mute** the track. Tap the header for the **track settings**: **opacity** 0–100 %, **volume** 0–100 %, move the track **up/down**, **delete** the track (overlay tracks), and *Magnetic* for the main track
- Empty overlay tracks disappear automatically
- The timeline grows with the tracks up to a limit, then scrolls vertically; how many tracks are visible before it scrolls is set in **Settings** (default 3 on phones, 5 on desktop). On phones the main track is taller, overlay tracks are flatter
- All audible clips are mixed; hidden tracks keep their sound, muted tracks stay silent
- **Background blur** uses the picture of the main track only
- A hint appears when three or more videos play at the same time — the preview may stutter on slower devices, the export is not affected

### Editing
- Timeline with thumbnail strips. **Phones/tablets:** the playhead stays fixed in the centre — scroll the timeline to scrub. **Desktop:** the playhead moves freely — click or drag in the time ruler, or drag the red line; scrolling only moves the view, and during playback the view pages along
- **Fit** button between the zoom buttons: the whole project, or — with a clip selected — that clip at about 80 % of the width (phones also move the playhead into it)
- **Exact timing** (clips on free tracks): the *Start* field in the clip panel accepts `0:43.79`, `43.79` or `1:02:03.5` (comma works too); if another clip is in the way, the clip moves to a new track. Nudge buttons move by ±1 s / ±0.1 s / ±0.01 s and stop at neighbouring clips; on desktop `Alt` + `←`/`→` (0.1 s) and `Alt` + `Shift` + `←`/`→` (0.01 s). A series of nudges is one undo step. Clips on the magnetic main track follow their order instead (release the magnet to place them freely)
- **+** above the track headers adds an empty video track (on top) or audio track (at the bottom) as a drop target; tracks added by hand stay until deleted, automatically created tracks disappear when empty
- Preview player with play/pause, frame-by-frame stepping and a time display
- Toolbar: **Undo / Redo** fixed on the left, **Add** (videos & images or a color clip, on the main track or as overlay) fixed on the right; in between **Cut** at the playhead (split icon — splits the selected clip, otherwise the clip of the main track under the playhead), **Copy**, **Paste** at the playhead and **Delete**. Pasting a clip copied from the magnetic main track inserts it there (splitting a clip if necessary); clips from overlay tracks are pasted as overlays. If space ever runs out, only the middle part scrolls
- **Clip panel:** appears below the timeline while a clip is selected — **Mute** (videos), and for images/color clips the **duration**; for color clips also **color** and **size**
- **Reorder / move** clips by dragging the selected clip (tap or click to select first)
- Mute all audio at once with the speaker button
- **Undo / Redo** — 10 steps by default (adjustable in Settings, 1–100); the steps are saved with the project, so they still work after a reload. Files that older steps refer to are kept until those steps are gone
- Zoom the timeline with the zoom buttons, pinch, or Ctrl + mouse wheel
- Keyboard shortcuts on desktop:

  | Key | Action |
  |---|---|
  | `Space` | Play / pause |
  | `←` / `→` | Previous / next frame |
  | `Shift` + `←` / `→` | Jump 1 second |
  | Click/drag in the ruler | Set the playhead (desktop) |
  | `C` or `S` | Cut at playhead |
  | `M` | Mute / unmute clip |
  | `Delete` / `Backspace` | Delete selected clip |
  | `Esc` | Deselect clip |
  | `Ctrl` + `C` / `V` | Copy clip / paste clip or files from the clipboard |
  | `Ctrl` + `Z` / `Y` | Undo / redo |
  | `Home` / `End` | Jump to start / end |
  | `Alt` + `←` / `→` | Move the selected clip by 0.1 s (`Shift`: 0.01 s) |
  | `Ctrl` + `E` | Open the *Create video* window |
  | `?` | Help & shortcuts |

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

### Project files (.videcutto) — other devices & backups
- **Save project file** (⇪ next to the project name, or *Export project file* on a project card) creates a `.videcutto` file (the extension is defined in one place, `PROJECT_EXT` in `app.js`; older extensions stay importable if the app is renamed):
  - **Project only** — cuts, canvas and settings, a few KB. On the other device the videos and images are selected again and recognised automatically (by file size)
  - **Project with all files** — everything included (trimmed working copies only contain the chosen part); the size is shown beforehand. Opens on the other device without selecting anything
- **Download** or **Share** the file (cloud, USB stick, messenger, e-mail …)
- **Import** with *Import a project file (.videcutto)…* on the start screen, or drop/paste the file anywhere. It becomes a new project (the name gets "(2)" if it already exists); included files are stored as working copies
- The file is a standard ZIP archive (uncompressed, ZIP64 for files over 4 GB) with `project.json` and a `media/` folder. It is built as a Blob of references to the original files, so even very large projects are never loaded into memory — each file is only read once to compute its checksum

### Saving & restoring media
- **Phones/tablets:** each video gets a **working copy** in the browser's private storage (OPFS) right after loading — after pre-trimming only the chosen part is copied, losslessly (no re-encoding). This keeps videos available after a reload and fixes Android revoking the picker's read permission after a while ("The requested file could not be read…")
- **Desktop Chrome/Edge:** the app remembers the original files (File System Access API) instead of copying them; after a reload one click on *Allow access* reopens them
- **Everywhere (fallback):** if a video is missing — no copy, storage cleared, or access lost while editing — a dialog lists it and you **select it again**. Files are matched automatically by size (and by length/resolution as a fallback), so renamed files are recognised; all cuts are kept. Clips of videos that can't be found can be removed instead
- Working copies of videos no longer used anywhere (timeline, undo/redo, clipboard) are deleted automatically
- **Settings → Project** shows how much space the open project and all projects use and lets you **delete** the open project
- Leftover working copies that no project refers to (e.g. after a crash) are cleaned up after a day
- Projects are saved with all tracks (format version 3); projects of earlier versions open as a single main track

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
- The Canvas card can be folded to one line (click its title); the line shows the format and background, the state is remembered
- **Format:** 16:9, 9:16, 1:1, 4:5 (Instagram portrait), 4:3, 3:4, 21:9, **Like a video…** (choose which one; by default the first loaded video), **Like a crop…** (choose the clip; follows later changes of that crop, also after splitting the clip) or **Custom** (any ratio, e.g. 3 : 2)
- A new project that starts with a video takes that video's format; an empty canvas starts as 16:9
- **Background** for the space around videos and images that don't match the format: a **color** (default anthracite #293133) or a **blurred** copy of the visible video or image (color clips always use the color)
- The preview draws the canvas exactly like the export and always keeps the canvas ratio

### Export & compression
- **Create video…** below the canvas settings (or `Ctrl` + `E` on desktop) opens the export window with all settings, progress and result, so the editor itself stays uncluttered
- **File name:** prefilled with the project name (`_clip` is added for *Selected clip only*); `.mp4` is added automatically. A changed name is remembered per project; as long as you don't change it, it follows the project name. Characters that Windows, macOS, Linux or Android memory cards don't allow are replaced (`< > : " / \ | ? *`, control characters), leading dots and trailing dots/spaces are removed, reserved Windows names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`9`, `LPT1`–`9`) get a `_`, and names are limited to 120 characters. Some Android browsers ignore the name when downloading; sharing keeps it
- The window can be closed while the video is being created — the button in the editor shows the progress ("Creating video… 45 %") and then "Video ready — download…". Closing the project cancels a running export
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
- **Whole timeline** (all tracks) or **Selected clip only** — export just one clip without deleting the others (prepared for special exports such as GIF or audio-only later). *Selected clip only* is greyed out while no clip is selected
- **Create video** starts the export; **Download** the result, or **Share** it directly (e.g. to a messenger) on devices that support sharing files

### Layout (Menu → View)
- **Wide layout** (automatically from about 1200 px window width, also outside fullscreen): preview on the left, clip/track panel, canvas and *Create video…* in a column on the right, timeline across the full width below; the page itself doesn't scroll and the timeline gets all the remaining height. In fullscreen it uses the whole screen without margins
- **Classic layout:** everything in one column (as on phones)
- **View** in the menu: Layout *Auto / Wide / Classic*; arrangement *Balanced*, *Large preview* or *Large timeline*; **Reset panel sizes**
- The borders between preview and right column and between top and timeline can be dragged; sizes are remembered, double-click a border to reset

### Notes button (⚠)
- Instead of permanent hint texts, a small amber **⚠** button appears next to the time only when there's something to know; a click shows the note(s): the preview really stuttered (detected while playing), three or more videos play at once, or amplified sound had to be limited in the preview

### General
- Dark mode by default, light mode via the menu
- Menu with theme toggle, View, Settings, **Help & shortcuts** and About; fullscreen toggle in the header
- **Help & shortcuts:** a short guide in collapsible sections — getting started, timeline & editing, tracks & overlays, crop/position/rotate, canvas & creating the video, saving & other devices, and (desktop only) the keyboard shortcuts. Small **?** buttons in the track settings, the clip panel and the *Create video* window open the matching section; `?` opens it on desktop
- Mobile-first layout; the editor gets more width on desktop screens
- Installable as an app (PWA) and works offline after the first visit
- You're warned before a reload throws away your timeline

## Hints shown in the app

- **HEVC videos** (e.g. iPhone "High Efficiency") can't be decoded by every browser (Firefox, some Linux setups). The app tells you so instead of failing silently — use Chrome, Edge or Safari, or record in "Most compatible" (H.264).
- **Preview stutter:** the app notices when the preview has to wait for or re-sync videos repeatedly and shows a note (⚠); with three or more videos playing at once a note warns that slower devices may stutter. The exported file is not affected.
- Sound that can't be decoded, unsupported files and audio fallbacks are reported with a short message.

## How it works

Videcutto uses no third-party libraries — everything is vanilla HTML/CSS/JS, so there are no vendor files to download.

- **`mp4.js`** — a small ISO-BMFF demuxer and muxer. The demuxer reads only the `moov` box (plus the `moof` boxes of fragmented files, whose `trun` entries are turned into ordinary sample tables) and the exact byte ranges of the samples it needs (via `Blob.slice()` with an 8 MB read window), supporting H.264, HEVC, VP9 and AV1 video, AAC and Opus audio, rotation metadata and edit lists. The muxer writes a "fast start" MP4 (moov before mdat, interleaved in 0.5 s chunks, 64-bit offsets for files > 4 GB).
- **`render.js`** — the export engine and the shared drawing code (`clipLayout` / `drawClip` / `composite`: crop, size, anchor + offset, rotation and flip, track opacity and layering, used identically by preview and export). The export walks a fixed frame grid: for every output frame it looks up the visible clip of each track, takes the matching frame from a forward-decoding **WebCodecs** reader per video clip (`VideoDecoder`, hardware-accelerated where available, started at the nearest keyframe), composites all tracks bottom to top onto a canvas (background color or blur from the main track) and encodes it with `VideoEncoder`. Audio of all audible clips is decoded, resampled to 48 kHz stereo, mixed per track volume in 0.1 s blocks (clamped) and encoded with `AudioEncoder`; silence fills the gaps so audio and video stay in sync.
- **`project.js`** — persistence: the projects in IndexedDB (`project:<id>`), shared/duplicated working copies with reference checks, working copies in the Origin Private File System, file handles of originals on desktop. `mp4.js` provides the lossless range copy (`remuxRange`) used for trimmed working copies: it copies the samples from the keyframe before the in-point, keeps the original sample descriptions and rotation, and streams straight to storage without holding the video in memory.
- **`app.js`** — the UI: file and clipboard loading, pre-trim dialog, timeline, canvas and export settings, clip panel, undo/redo and the preview. The preview draws onto a `<canvas>` with the same compositing code as the export. A pool of `<video>`/`<audio>` elements supplies frames and sound — one per clip playing at the playhead plus the clips starting within the next 1.5 s (preloaded). Playback never stops: a wall clock always runs, and the bottom-most playing video drives the playhead as long as it keeps up (the clock slowly follows it). If it falls behind or gets stuck, the clock carries on and the video is re-synced in the background; only right after Play or a jump the preview waits up to ½ s for loading. Other elements follow by slightly changing their playback rate and are only re-positioned when they drift more than 0.5 s. When the preview stutters, the ⚠ note names the reason (which video couldn't keep up, had to be re-synced or loaded too slowly). Volumes above 100 % use Web Audio; if no sound arrives that way (some setups), the preview falls back to plain elements at most 100 % and says so.

The preview uses the browser's native `<video>` decoding; the export uses WebCodecs, so what plays in the preview and what can be exported is decided by each browser's codec support.

## Files

- `index.html` — markup
- `style.css` — all styling
- `app.js` — UI logic
- `mp4.js` — MP4/MOV demuxer and muxer
- `render.js` — WebCodecs export engine
- `project.js` — autosave, working copies and file handles
- `zip.js` — streaming ZIP writer/reader for project files
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
