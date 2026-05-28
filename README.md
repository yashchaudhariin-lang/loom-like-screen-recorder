# loom-like-screen-recorder
A Loom-inspired Chrome extension for screen recording built with React, TypeScript, TailwindCSS, and Manifest V3.
# Recur — Screen Recorder Chrome Extension

A Loom-inspired screen recording Chrome extension built as a take-home assignment. Records screen with optional microphone and camera overlay, stores recordings locally, and provides an in-browser preview and download experience — no backend required.

---

## Project Overview

Recur is a Manifest V3 Chrome extension that lets users record their screen directly from the browser toolbar. It injects a floating recording widget into any webpage, captures screen/tab video and audio via the browser's native `MediaRecorder` API, streams chunks in real time to the background service worker, and presents a playback preview page with download functionality when recording ends.

The project was built entirely without external dependencies — no bundler, no frameworks, no npm. All logic is vanilla JavaScript in six files.

---

## Implemented Features

| Feature | Status |
|---|---|
| Screen capture (full screen or current tab) | ✅ |
| Microphone audio capture | ✅ |
| Camera picture-in-picture overlay (canvas composite) | ✅ |
| Live camera preview in setup widget | ✅ |
| Permission status indicators (mic + camera) | ✅ |
| Floating draggable widget with Shadow DOM isolation | ✅ |
| Minimise to pill (with live timer) / expand | ✅ |
| Pause and resume recording | ✅ |
| Stop and preview | ✅ |
| Close / dismiss widget | ✅ |
| 20-minute recording limit with auto-stop | ✅ |
| In-browser video preview with seek bar | ✅ |
| Download recording as `.webm` | ✅ |
| Works on CSP-strict sites (Google, YouTube, etc.) | ✅ |

---

## Extension Architecture

```
Toolbar click
    │
    ▼
popup.js ──── executeScript ────► content.js (injected into page)
                                       │
                                       │  Shadow DOM widget rendered
                                       │  Mic + camera permissions requested
                                       │  User configures and starts recording
                                       │
                                       │  getDisplayMedia() → MediaRecorder
                                       │  ondataavailable (~1s chunks)
                                       │        │
                                       │        ▼
                                       │  sendChunk() ──► background.js
                                       │                      │
                                       │  PING every 20s ───► │ (SW keepalive)
                                       │                      │
                                       │                  Writes each chunk
                                       │                  to IndexedDB immediately
                                       │                  as chunk_00000001, ...
                                       │
                                       │  User stops recording
                                       │
                                       ▼
                               RECORDING_COMPLETE ──► background.js
                                                           │
                                                     Reads all chunk_ keys
                                                     Sorts + assembles Blob
                                                     Saves as IDB['latest']
                                                     Deletes chunk_ entries
                                                     Opens preview.html tab
                                                           │
                                                           ▼
                                                      preview.js
                                                     Reads IDB['latest']
                                                     createObjectURL(blob)
                                                     Renders video player
                                                     + Download button
```

### Key Files

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest — permissions, entry points |
| `popup.html` / `popup.js` | Toolbar click handler — injects content script |
| `content.js` | Full widget — UI, permissions, MediaRecorder, chunk streaming |
| `background.js` | Service worker — IDB chunk storage, blob assembly, preview tab |
| `preview.html` / `preview.js` | Playback page — IDB read, video player, download |

---

## Technical Decisions

### Shadow DOM for widget isolation
The widget is mounted inside a Shadow DOM attached to a host `<div>`. This completely isolates styles and DOM from the host page. It also bypasses the page's Content Security Policy for injected `<style>` tags — a requirement for working on CSP-strict sites like Google and YouTube.

### Streaming chunks to background IndexedDB
Rather than recording the full blob in memory and sending it in one message (which crashes for recordings over ~2 minutes due to message size limits), each `ondataavailable` chunk (~1 MB at 1-second intervals) is sent individually to the background and written to IndexedDB immediately. Assembly happens only once on stop. This approach handles any recording length up to the 20-minute limit.

### Service worker keepalive
Chrome MV3 service workers are killed after 30 seconds of inactivity. During recording, `content.js` sends a `PING` message every 20 seconds to keep the SW alive, preventing the in-memory state from being lost mid-recording.

### Cross-origin IDB strategy
Content scripts run in the host page's origin (e.g. `google.com`), while the preview page is `chrome-extension://...`. IndexedDB is origin-scoped, so the background service worker — which shares the extension origin — acts as the sole IDB writer and the preview page reads from the same origin without cross-origin issues.

### Camera PiP via Canvas
Camera overlay is composited onto the screen stream via a `<canvas>` element. The canvas draw loop uses `setInterval` at 30 fps rather than `requestAnimationFrame`, because `rAF` is throttled to 0 fps in background tabs — causing a frozen static frame for the entire recording when the user switches away to share their screen.

### No bundler / no dependencies
The extension is plain vanilla JS with no build step. This keeps the project auditable, fast to load, and easy to review without tooling setup.

### Codec selection
`MediaRecorder` codec is selected at runtime from a preferred list: `vp9/opus` → `vp8/opus` → `video/webm` fallback. This maximises quality on supported Chrome versions while degrading gracefully.

### Bitrate
Video: 3 Mbps — appropriate for 1080p screen content (matches YouTube's recommended 1080p60 encode rate). Audio: 128 Kbps stereo. A 20-minute recording produces approximately 450 MB, well within IndexedDB limits.

---

## Folder Structure

```
recur-v11/
├── manifest.json       # MV3 config — permissions, service worker, popup
├── popup.html          # Toolbar popup shell (no inline script — CSP compliant)
├── popup.js            # Injects content.js into active tab
├── content.js          # Widget, recorder, permissions, chunk streaming (~534 lines)
├── background.js       # Service worker — IDB storage + blob assembly (~173 lines)
├── preview.html        # Preview page shell
├── preview.js          # Video player, IDB read, download (~154 lines)
└── icons/
    ├── icon16.png
    ├── icon32.png
    ├── icon48.png
    └── icon128.png
```

---

## Setup Instructions

No build step. No npm install. No dependencies.

Clone or unzip the project:

```bash
unzip recur-v11.zip
cd recur-v11
```

That's it. The extension is ready to load.

---

## How to Load in Chrome

1. Open Chrome and navigate to `chrome://extensions`
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked**
4. Select the `recur-v11` folder
5. The **Recur** extension icon will appear in your toolbar

> If you don't see the icon, click the puzzle piece (Extensions) icon and pin Recur.

---

## Recording Flow

1. **Click the Recur icon** in the Chrome toolbar on any webpage
2. The floating widget appears in the top-right corner
3. Chrome immediately requests **microphone** and **camera** permissions — grant or deny as preferred
4. Select capture mode: **Screen** (full display) or **This Tab**
5. Click **Start Recording** — Chrome's native screen picker dialog appears
6. Select what to share and click **Share**
7. Recording begins — widget minimises to a pill showing a live timer
8. Click the pill to expand back to the full widget
9. Use **Pause / Resume** as needed
10. Click the **Stop** button (red square) to end the recording
11. The **Preview** page opens automatically in a new tab
12. Watch the recording, scrub the seek bar, and click **Download** to save the `.webm` file

---

## Known Limitations

- Output format is `.webm` (VP8/VP9 + Opus) — native to Chrome's `MediaRecorder`. Not natively playable on older macOS QuickTime without a codec. VLC plays it correctly.
- `vid.duration` is `Infinity` for raw WebM from `MediaRecorder` (no duration atom in the container). The preview player uses the recorded elapsed time as a fallback for the timeline display.
- Camera PiP compositing adds a small CPU overhead. On lower-end machines, consider turning camera off for longer recordings.
- The 20-minute limit is intentional — longer recordings would require disk-backed chunk storage (OPFS) rather than IndexedDB, which is not implemented.
- Extension does not persist recordings between browser sessions. Once the preview tab is closed and the IDB entry is overwritten by a new recording, the previous file is gone.

---

## Future Improvements

- **OPFS (Origin Private File System)** — replacing IndexedDB for chunk storage would remove the practical size ceiling and enable truly unlimited recording length
- **WebM duration header patching** — post-processing the WebM container to inject a valid duration atom, making the file fully seekable in all players without relying on elapsed time
- **Recording library / history** — persist multiple recordings in IDB with timestamps, titles, and thumbnails
- **Cloud upload** — optional upload to S3/R2 with a shareable link, matching core Loom UX
- **Annotation tools** — draw/highlight overlay during recording
- **Tab-only audio** — separate system audio and microphone mixing controls
- **Settings page** — user-configurable bitrate, max duration, default capture mode

---

## AI Tools Used During Development

**Claude (Anthropic)** was used throughout this project as a development accelerator:

- Diagnosing silent bugs from DevTools screenshots (CSP violations, IDB version mismatches, `requestAnimationFrame` freeze in background tabs)
- Identifying architectural issues such as cross-origin IndexedDB scoping and Chrome MV3 service worker 30-second kill behaviour
- Iterative code generation and patching across the 20 versions of the extension
- Explaining Chrome extension API constraints (MV3 service worker lifecycle, `sendMessage` size limits, Shadow DOM CSP isolation)

All architectural decisions, debugging logic, and technical tradeoffs were reasoned through collaboratively. The final implementation reflects genuine understanding of the Chrome extension platform constraints encountered during development.

---

## Permissions Explained

| Permission | Reason |
|---|---|
| `activeTab` | Inject content script into the current tab on click |
| `scripting` | Execute `content.js` programmatically via `chrome.scripting.executeScript` |
| `storage` | Session storage for lightweight metadata |
| `tabCapture` | Required for "This Tab" capture mode |
| `desktopCapture` | Required for full-screen capture mode |
| `host_permissions: <all_urls>` | Allow content script injection on any site |

---

*Recur v20 — built without external dependencies on Chrome Manifest V3.*
