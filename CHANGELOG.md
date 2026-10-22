# Changelog

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
