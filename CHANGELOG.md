# Changelog

### 0.13.2 — 2026-11-10 — Fixes
- Straightening never changes the size anymore (it jumped at 45°); the size only follows the 90° buttons
- Groups removed (they made things harder to follow); existing groups are simply ignored
- Contents: under the playhead = thin mark on the left, selected = full frame; delete buttons are trash cans
- Export window: file name field under its label, options toggle on the right of the label row; metadata summary without icons
- "There": clear hint that short Google Maps links contain no coordinates
- Long checkbox labels wrap next to the box; US spelling ("color") everywhere

### 0.13.1 — 2026-11-09 — Turning keeps the size, eyedropper
- Turning keeps the picture's size; parts that turn out of the canvas are cut off (new default)
- Rotate tab: "Keep inside the canvas" makes it smaller instead; Crop tab: "Straighten inside the frame" zooms in and cuts the corners
- Turning grid over the whole canvas with two lines each way
- Eyedropper next to every color field: pick a color from the preview

### 0.13.0 — 2026-11-09 — Edit in the preview
- Selected pictures can be moved in the preview from every tab; a tap next to it deselects
- Touch: moving starts after a short rest (taps don't shift it), two fingers size; double-tap switches to Turn (one finger turns, two fingers turn and size)
- Mouse: Shift = turn, Ctrl = size, Shift+Ctrl = free size (width and height apart), Shift+Ctrl+Alt = crop
- Rotate tab: straightening wheel with 0.1° steps, ±0.1°/±1° buttons, grid while turning, "Fill the frame (cut the edges)"
- Opacity for every picture; a see-through main-track clip can get a color clip on a new main track
- Hex code fields next to all color pickers
- Contents: ✕ deletes single clips, texts, color clips, transitions and index points (with a question when linked)
- The magnet can be switched for every visual track

### 0.12.2 — 2026-11-09 — Compact export window, snapping
- Export window: file name options and metadata in fold-out boxes (▾ / ⓘ) — the box shows where the metadata comes from and lets you switch it
- Own metadata values stay in the project when you switch sources in between; "Fill from a file" copies a file's values on purpose
- 🗺 There: place from a pasted map link (Google Maps, OpenStreetMap, geo:) or coordinates
- Snapping in the preview: the centre and the edges of an element snap to the canvas edges and centre lines (centre on a corner works too)
- Frame buttons: hold for one second before playback starts
- Snapshot and pin buttons sit in the corners of the whole preview box
- Projects without a working copy say "Not stored — uses the picked file (select it again after a restart)"

### 0.12.1 — 2026-11-08 — Polish
- Frame buttons: one frame per click; hold to keep going (forward plays, backward runs back)
- The preview loads its videos again by itself after switching apps or a long screen-off
- Preparing a working copy (pre-trimmed or whole video, audio) can be cancelled
- Markers are now "index points", shortcut I
- Snapshot button in the top left corner of the image: copy to clipboard, save as file (vcshot_YYYYMMDD_HHMMSS.png) or share; pin in the top right corner
- Batch convert saves one ZIP file by default
- Snapping to the canvas centre and edges is off by default

### 0.12.0 — 2026-11-08 — Markers, groups & attaching
- Markers: add at the playhead (flag button / K), name and color, drag in the ruler, jump by tapping; clips snap to them; listed in Contents
- 📎 Attach: a clip on an upper or audio track moves along with the main-track clip below it
- Group / Ungroup (G): grouped clips are selected and moved together; tap again to pick one
- Frame snapshot: camera button in the preview saves the current frame as PNG in the video's size
- Contents: everything under the playhead is framed while the list is open
- Metadata: camera settings of photos (ISO, focal length, exposure bias, aperture, exposure time, lens); ⓘ in the export window lists exactly what goes into the video
- Fixed: the "Close Videcutto?" question didn't appear in the installed app (history entries were added without a tap and got skipped)

### 0.11.4 — 2026-11-07 — Batch convert
- Menu → Batch convert…: many videos with the same settings (max. resolution, quality, fps, codec, sound, metadata), each keeps its own format; automatic names or naming patterns; keep the original if the result would be bigger; download each, one ZIP, or save into a folder (desktop Chrome/Edge)
- Contents: tapping a file folds out where each of its clips is used (start, track, effects, sound) — tap one to jump there; folded by default per project (remembered when left open)
- 🏷 tap shows a file's metadata with "Use for the export"; long press uses it directly
- Neutral background for text thumbnails in the Contents list
- Back button: closes windows, leaves the editor; the installed app asks before closing on the start screen

### 0.11.3 — 2026-11-06 — File names & metadata
- Automatic file name for single-video exports: original name + tags for what changed (resolution, quality, frame rate), e.g. 20261105_175525_720p_small_30fps
- ▾ menu next to the file name: automatic / original / [name]_videcutto / project name, tags to add (resolution, quality, fps, bitrate, pixel size, codec, cut, crop, mute) and naming placeholders like JPG75 (* # $Y $M $D $h $m $s $R $P $Q $F $B) with a live preview
- Metadata is kept: recording date, GPS place, camera, software, title, description, author are read from videos (Android & Apple) and photos (EXIF) and written into the export (Android and Apple format); automatic from the first clip, from a chosen file, own values or none; the place can be left out
- Contents list shows each file's date, place and camera; 🏷 uses its metadata for the export
- Fixed: on phones, a long project name made the start screen much wider and taller than the screen

### 0.11.2 — 2026-11-06 — Animations & Contents
- The Fade tab is now the Animate tab: In and Out animations with combinable effects — Fade, Zoom in, Zoom out, Slide (4 directions), Spin, Blur, Pop — for videos, images, color clips and texts
- Text can appear/disappear line by line, word by word, letter by letter (each piece animated with the chosen effects) or like a typewriter
- The Media list is now "Contents": files, texts, color clips and transitions in groups; tapping a text, color clip or transition selects it and jumps there
- Clip panel tabs fit on narrow phones
- Older projects keep their picture fades (as Fade animations); preview and export draw animations identically

### 0.11.1 — 2026-10-31 — Move the cut, pin the preview
- Transitions can be moved: "Move the cut" slider in the transition panel or drag the ⧓ marker (snaps to the playhead); the first clip gets longer and the second shorter or vice versa, the total length stays the same
- Pin button in the preview (classic layout / phones): preview and playback controls stay at the top while scrolling
- Sliders in the Text tab (and other two/three-column slider rows) are stacked so nothing sticks out on narrow screens

### 0.11.0 — 2026-10-31 — Text & fonts
- Text clips (Add → Text) with a new Text tab: content, font, size (share of the canvas height), bold/italic, alignment, line/letter spacing, color, opacity, outline, shadow, background box; styles Title, Subtitle, Lower third
- Text works with Position (incl. size slider, pinch, wheel), Rotate, Fade, transitions, trimming and multi-selection
- 11 built-in fonts (Inter, Poppins, Montserrat, Oswald, Bebas Neue, Lora, Playfair Display, Pacifico, Dancing Script, Permanent Marker, JetBrains Mono), loaded on first use and cached for offline use
- Own fonts from a file (TTF/OTF/WOFF/WOFF2, also drag & drop) or from the installed fonts (Chrome/Edge desktop) — copied into the project, shown in the media list, included in project files

### 0.10.0 — 2026-10-31 — Transitions
- Transitions on cuts between clips (main track and upper tracks): cross-fade, dip to black, dip to white, wipe, slide, zoom, circle, blur; direction and duration 0.1–3 s
- + on every cut to add one, ⧓ marker to edit; transition panel with Apply to all cuts on this track and Remove
- The clips overlap by the transition's length (the project gets shorter); the sound is cross-faded, or cut hard in the middle if switched off
- New Fade tab: picture fade in/out for videos, images and color clips; "Picture and sound together" for videos
- Export and preview draw transitions and fades identically

### 0.9.10 — 2026-10-31 — Drag in select mode
- Fix: on phones, selected clips couldn't be dragged while the selection mode (long press / Select button) was on. Now a tap still adds or removes a clip, and dragging a selected clip moves all selected clips

### 0.9.9 — 2026-10-30 — Trimming & more for several clips
- Trim handles on the selected clip: drag start or end; ripple on the magnetic main track, stops at neighbours on free tracks; limited to the media for videos and sounds; snapping; one undo step
- Crop, position, size and rotation for several selected clips at once
- Several clips incl. clips of the magnetic main track can be dragged together: the main-track clips move as a block, the others shift along
- View: optional media column on the left in the wide layout

### 0.9.8 — 2026-10-30 — Multi-selection & media list
- Select several clips: Ctrl/⌘ + click, Shift + click (range), frame selection in empty timeline space, Ctrl + A; on phones long-press or the Select button, with a bar showing the count (All / Done)
- For all selected clips: delete, copy/paste (distances and track grouping kept), cut, mute, volume & fades, detach audio, nudging and dragging together on free tracks (with snapping)
- Media list (fold-out, folded by default): all files of the project incl. unused ones, with usage count; select a file's clips, add again (＋ / ⧉), remove unused files, relink missing ones, drag onto the timeline (desktop)
- Files are no longer removed automatically when their last clip is deleted; unused missing files don't block opening a project anymore
- "Selected clip only" export needs exactly one selected clip

### 0.9.7 — 2026-10-30 — Preview never stops
- Fix: the preview could stop (and not continue) when a video stuttered. Playback now always carries on: a lagging or stuck video is re-synced in the background, only the start waits up to ½ s for loading
- The ⚠ note names the reason for stuttering (which video couldn't keep up, had to be re-synced or loaded too slowly)
- The Canvas card can be folded to a single summary line (remembered)

### 0.9.6 — 2026-10-30 — Undo survives a reload
- Undo and redo steps are saved with the project (as many as set in Settings, default 10) and still work after a reload or when the project is opened again

### 0.9.5 — 2026-10-30 — Wide layout & smoother preview
- Wide layout (automatically from ~1200 px, also outside fullscreen; full screen width in fullscreen): preview left, settings column right, timeline across the full width with all remaining height; no page scrolling
- Menu → View: layout Auto / Wide / Classic, arrangements Balanced / Large preview / Large timeline, Reset panel sizes; draggable borders (remembered, double-click resets)
- Notes button ⚠ (amber) next to the time instead of hint texts; shows notes only when needed — incl. detected preview stutter
- Smoother preview: the bottom-most playing video drives the playhead again; other videos and sounds follow by adjusting their speed slightly instead of jumping
- Fix: with a clip volume above 100 % the whole preview sound could go silent in Chrome — the preview now checks that the amplified sound arrives and otherwise falls back to max. 100 % (the created video keeps the full volume)

### 0.9.4 — 2026-10-30 — Fit fills the width
- Fix: *Fit* (and the automatic zoom) stopped at 160 px per second, so short projects didn't fill the timeline's width; zooming in now goes up to 3000 px per second

### 0.9.3 — 2026-10-30 — Cutting close to a clip's edge
- Fix: Cut refused to split when the playhead was less than 0.05 s from a clip's start or end (e.g. one frame before the end) and wrongly asked to move the playhead onto the clip. Cuts now work down to a few milliseconds from the edge
- Clearer messages when the playhead is exactly at a clip's edge or at the very end

### 0.9.2 — 2026-10-30 — Precise placement & free playhead
- Snapping reacts earlier (14 px desktop, 20 px touch) and shows a blue line across all tracks where the clip docks; short vibration on Android (switchable in Settings)
- Exact start time per clip (e.g. 0:43.79) in the clip panel; nudge buttons ±1 s / ±0.1 s / ±0.01 s and Alt + ←/→ (Shift: 0.01 s) on desktop
- Desktop: the playhead moves freely — click or drag in the time ruler or drag the red line; scrolling only moves the view; zooming keeps the playhead (or the time under the mouse) in place
- Fit button: whole project, or the selected clip
- + above the track headers adds an empty video or audio track; tracks added by hand stay until deleted

### 0.9.1 — 2026-10-30 — Fragmented MP4
- Fragmented MP4 files can be opened (e.g. streaming downloads, Safari or OBS "fragmented" recordings): the demuxer now reads the samples from moof/trun boxes; pre-trimming, working copies and export work as usual (the working copy is written as a normal MP4)
- Fragmented files with sound only (e.g. .m4a) open as audio
- Short note when a video has no sound
- Start screen mentions audio files and tracks

### 0.9.0 — 2026-10-29 — Audio
- Audio files (MP3, M4A/AAC, WAV, FLAC, OGG/Opus) via Add → Audio, drag & drop or paste; placed at the playhead on audio tracks below the main track
- Audio tracks: sound only, free placement, header with mute, track settings with volume, order and delete
- Snapping to the start/end of all clips and to the playhead while dragging on free tracks — switchable with the magnet button below the timeline, Alt moves freely
- Detach audio: a video's sound becomes its own audio clip, the video is muted
- New Audio tab: clip volume 0–200 % with soft limiter, fade in / fade out
- Waveforms on audio clips (also for detached video sound), saved with the project
- Fades and changed volume are shown on the clips
- Preview plays audio clips and applies volume and fades live (Web Audio for volumes above 100 %)
- Export mixes video sound and audio files with volume, fades and track volume
- Audio-only projects possible (the video shows the background)
- Help: new section "Audio, volume & fades"

### 0.8.2 — 2026-10-29 — Help & shortcuts
- New menu item **Help & shortcuts**: a short guide in collapsible sections, including the keyboard shortcuts (shown on desktop only)
- **?** buttons in the track settings, the clip panel and the *Create video* window open the matching section
- `?` opens the help on desktop; Escape closes it first when it lies on top of another window

### 0.8.1 — 2026-10-29 — Export window & file name
- Export settings moved into their own window; the editor only shows a **Create video…** button (also `Ctrl` + `E`)
- File name field, prefilled with the project name (`_clip` for *Selected clip only*), remembered per project; characters and names not allowed on Windows, macOS, Linux or Android are cleaned up automatically
- The window can be closed during the export: the button shows the progress and then "Video ready — download…"
- Closing the project cancels a running export
- The project file button is now called "Save project file" to tell it apart from creating a video

### 0.8.0 — 2026-10-28 — Multiple tracks
- Any number of video tracks: the main track at the bottom, overlay tracks above it; higher tracks are drawn on top, empty space on overlay tracks is transparent
- Add → *As overlay* (videos & images or color clip): placed at the playhead on the lowest overlay track with room, or on a new track; overlays start at 50 % size, centred
- Selected clips can be dragged sideways and up/down between tracks; a new track is created when there is no room or when dropping above the top track. Only the selected clip can be dragged — now also with the mouse
- Main track stays magnetic, with the option to release it (place clips freely, gaps show the background)
- Track headers with hide 👁 and mute 🔊; tap for track settings: opacity, volume, move up/down, delete, magnetic (main)
- Timeline scrolls vertically after a number of tracks — adjustable in Settings (default 3 on phones, 5 on desktop)
- New export engine: composites all tracks frame by frame and mixes the sound of all audible clips; background blur comes from the main track
- New preview engine: plays several videos at once (element pool, wall clock with buffering wait and drift correction); hint when three or more videos play at the same time
- *Selected clip only* is greyed out while no clip is selected
- Cut splits the selected clip (or the main track's clip under the playhead); paste of overlay clips creates overlays
- Project format version 3 with all tracks; older projects open as a single main track
- The project file extension is defined in one place (`PROJECT_EXT`) for a possible rename; older extensions stay importable

### 0.7.0 — 2026-10-28 — Project files for other devices
- Export a project as a `.videcutto` file: project only (a few KB, files are selected again on the other device) or with all files (size shown beforehand)
- Download or share the file; import it via the start screen, drag & drop or paste — it becomes a new project
- Included files are stored as working copies on import; trimmed copies keep their timing
- Streaming ZIP writer/reader (`zip.js`, ZIP64 for large files) — big projects aren't loaded into memory

### 0.6.0 — 2026-10-28 — Project library
- Any number of projects: list on the start screen with cover, name, clips, length, last change and storage used; total storage and free space below
- Open, rename, duplicate, delete projects; project name editable above the preview
- Duplicate with shared video files (no extra space) or independent copies (space shown beforehand)
- Files & storage dialog per project: where each file is kept, Relink…, Copy to browser / Use original (desktop)
- Each project has its own address (#p=…); different projects can be edited in different tabs; the same project in a second tab asks first and the other tab stops editing (Web Locks)
- Choosing media or an empty canvas on the start screen always creates a new project — nothing is discarded anymore
- Working copies shared between projects are only deleted when no project needs them; orphaned copies are cleaned up after a day
- The single project from 0.2–0.5 is migrated into the list automatically

### 0.5.0 — 2026-10-28 — Save a crop, export one clip
- Crop tab: "Use as canvas" — canvas format and export resolution follow the crop (exact pixel size), the clip fills the canvas
- Canvas format "Like a crop…" with clip selection; follows later crop changes and splits
- Resolution option "Crop size" (no scaling)
- Export: "Whole timeline" or "Selected clip only"
- Toolbar: Undo/Redo fixed left, Add fixed right, Cut, Copy, Paste and Delete in between (only the middle part scrolls if needed); Copy and Delete moved out of the clip panel
- Cut now uses a split icon instead of scissors
- Buttons renamed: "Export video" → "Create video", "Save" → "Download"

### 0.4.0 — 2026-10-28 — Crop, position, size & rotation
- Clip panel tabs: Clip, Crop, Position, Rotate (opening one moves the playhead into the selected clip)
- Crop per clip with handles in the preview and presets (Free, Like canvas, 16:9, 9:16, 1:1, 4:5, 4:3), ratio kept while resizing
- Position per clip: 3×3 anchor grid, drag in the preview (also beyond the canvas), arrow pad for fine-tuning, snapping to centre and edges with guide lines (Alt = free)
- Size: Fit, Fill or Free with slider, pinch and mouse wheel
- Rotation: 90° steps, free angle slider, flip horizontal/vertical
- Each drag/slider move/series of arrow taps is one undo step; transforms are saved with the project
- Phones: preview stays pinned at the top while a transform tab is open
- Fix: the preview box now always keeps the canvas ratio on wide screens

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
