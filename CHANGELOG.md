# Changelog

### 0.3.0 — 2026-10-28 — Canvas, images & color clips
- New **Canvas** section: formats 16:9, 9:16, 1:1, 4:5, 4:3, 3:4, 21:9, like a chosen video, or a custom ratio; background color (default anthracite) or blur
- Format and background moved out of the export section
- Export reworked: resolution options matching the format (incl. custom), quality Small / Standard / High with Mbit/s shown, custom bitrate, or max. file size with optional "Keep resolution"; H.264 or H.265 (HEVC)
- Images can be added (4 s by default, adjustable) and are always stored as a copy
- Color clips (color, duration and size adjustable); "Start with an empty canvas" creates a 4 s anthracite color clip on a 16:9 Full HD canvas
- Paste images and video files from the clipboard (Ctrl+V); pasted videos get a working copy on desktop too
- Toolbar: Undo/Redo always visible, "Split" renamed to "Cut" (scissors), old Cut removed, Add menu (media / color clip)
- Clip panel below the timeline for the selected clip: copy, mute, delete, duration, color, size
- Preview now draws the composition on a canvas exactly like the export (incl. blurred background)
- Gallery/Files toggle hidden on desktop
- Projects from 0.2.x are migrated (format and background move to the canvas)

### 0.2.0 — 2026-10-26 — Saved projects & no bigger files
- The last project is saved automatically and can be continued after a reload ("Continue" / "New project" on the start screen)
- Phones: working copy of each video in the browser's private storage (only the pre-trimmed part, copied losslessly) — fixes "The requested file could not be read" on Android
- Desktop Chrome/Edge: original files are remembered via file handles; one click on "Allow access" reopens them
- Relink dialog: missing videos can be selected again and are matched automatically by size (or length/resolution); clips of missing videos can be removed
- Lost access during editing is detected (preview and export) and opens the relink dialog instead of failing
- Settings: storage usage and "Delete project"
- Export bitrate is capped to the source's, so already compressed videos (e.g. from Instagram) don't get bigger; warning in the estimate and result when a video won't get noticeably smaller
- Project format prepared for multiple tracks
- Shorter codec label so it fits on phones

### 0.1.0 — 2026-10-23 — Initial release
- Load MP4/MOV/M4V videos via picker (Videos / Files toggle) or drag & drop; files are read on demand instead of being loaded into memory
- Pre-trim dialog for large videos (> 150 MB / 3 min on phones, > 1 GB / 15 min on desktop), configurable in Settings
- Timeline editor with thumbnails, centred playhead, preview player and frame stepping
- Split, delete, cut/copy/paste, drag-to-reorder, mute per clip and mute all
- Undo/redo (10 steps by default, adjustable)
- Timeline zoom via buttons, pinch and Ctrl + wheel; keyboard shortcuts on desktop
- Export via WebCodecs: presets HD (default), Full HD, Small, Original resolution and Target size
- Output format like first video / 16:9 / 9:16 / 1:1 with black bars or blurred background
- H.264 output (HEVC where supported), AAC audio with automatic Opus fallback
- Size estimate, progress with remaining time, cancel, save and share
- Hints for HEVC decoding limits, preview stutter between clips and audio fallbacks
- Self-written MP4 demuxer/muxer — no third-party libraries
- Dark mode default, menu with theme/Settings/About, fullscreen toggle, PWA with offline support
