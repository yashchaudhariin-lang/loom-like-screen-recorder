
# Recur — Engineering Architecture Document

**Project:** Recur Screen Recorder Chrome Extension  
**Version:** 20.0.0  
**Stack:** Vanilla JavaScript · Chrome Manifest V3 · MediaRecorder API · IndexedDB · Shadow DOM  
**Constraint:** 2-day take-home assignment

---

## Table of Contents

1. [Why Manifest V3](#1-why-manifest-v3)
2. [Extension Contexts and Communication](#2-extension-contexts-and-communication)
3. [MediaRecorder Workflow](#3-mediarecorder-workflow)
4. [Permission Handling Architecture](#4-permission-handling-architecture)
5. [State Handling Approach](#5-state-handling-approach)
6. [Local-First Recording: Rationale](#6-local-first-recording-rationale)
7. [UX Decisions](#7-ux-decisions)
8. [Error Handling](#8-error-handling)
9. [Technical Tradeoffs](#9-technical-tradeoffs)
10. [Limitations Within the 2-Day Constraint](#10-limitations-within-the-2-day-constraint)
11. [Scalability Considerations](#11-scalability-considerations)
12. [Future Improvements](#12-future-improvements)

---

## 1. Why Manifest V3

Chrome deprecated Manifest V2 support for new extensions in 2022, with forced migration completing in 2024. All new extensions targeting the Chrome Web Store must use MV3. This was not a choice — it was a hard constraint.

That said, MV3 has meaningful architectural implications that shaped every part of this project.

### What MV3 changes

**Background pages → Service workers.** MV3 replaces persistent background pages with ephemeral service workers. A service worker has no guaranteed lifetime — Chrome kills it after approximately 30 seconds of inactivity and restarts it on demand. This is the single most consequential constraint in the entire project. Any state stored in memory (variables, arrays, object references) is lost the moment the SW is killed.

**`chrome.scripting` API.** Content script injection at runtime now requires the `scripting` permission and the `chrome.scripting.executeScript` API rather than background page messaging. This is why `popup.js` exists as a thin orchestration layer — its sole job is to call `executeScript` and close.

**CSP on extension pages.** MV3 enforces `script-src 'self'` on all extension HTML pages. Any inline `<script>` block in `popup.html` or `preview.html` is silently blocked. This was responsible for the majority of early failures in this project — the popup's inline script never executed, so the content script was never injected, and nothing appeared. Both popup and preview scripts were moved to external `.js` files to comply.

### Adapting to SW ephemerality

The entire storage architecture — streaming chunks to IndexedDB as they arrive rather than buffering in memory — exists solely because of MV3's service worker lifecycle. Under MV2's persistent background page, a simple in-memory chunk array would have been sufficient and would have worked reliably. Under MV3, it would lose all data for any recording longer than 30 seconds if no message arrived in that window.

The keepalive ping mechanism (a `PING` message sent from `content.js` every 20 seconds during recording) is a standard MV3 workaround to prevent the service worker from being killed while a recording is in progress. It is not a clean solution — it is an acknowledged hack necessitated by the platform.

---

## 2. Extension Contexts and Communication

A Chrome extension operates across four isolated JavaScript execution contexts. Understanding how they communicate is the foundation of the architecture.

### The four contexts

```
┌─────────────────────────────────────────────────────────────────────────┐
│  CONTEXT 1: Extension popup (chrome-extension://[id]/popup.html)        │
│  Lifetime: open while popup is visible (~200ms in this project)         │
│  Access: chrome.* APIs, scripting                                       │
├─────────────────────────────────────────────────────────────────────────┤
│  CONTEXT 2: Content script (injected into e.g. google.com)              │
│  Lifetime: persists until tab navigates or closes                       │
│  Origin: the host page's origin (e.g. google.com)                      │
│  Access: limited chrome.* APIs, full DOM of host page                  │
├─────────────────────────────────────────────────────────────────────────┤
│  CONTEXT 3: Background service worker (chrome-extension://[id])         │
│  Lifetime: ephemeral, killed after ~30s inactivity, restarted on demand │
│  Origin: extension origin                                               │
│  Access: full chrome.* APIs, IndexedDB, fetch                           │
├─────────────────────────────────────────────────────────────────────────┤
│  CONTEXT 4: Preview page (chrome-extension://[id]/preview.html)         │
│  Lifetime: persists until user closes the tab                           │
│  Origin: extension origin (same as background)                          │
│  Access: full chrome.* APIs, IndexedDB shared with background           │
└─────────────────────────────────────────────────────────────────────────┘
```

### Message flow

```
User clicks toolbar icon
        │
        ▼
[popup.js] chrome.scripting.executeScript({ files: ["content.js"] })
        │
        ▼
[content.js] Injected into active tab. Renders widget inside Shadow DOM.
Requests mic + camera permissions via getUserMedia.
User starts recording → getDisplayMedia → MediaRecorder starts.
        │
        │  ondataavailable fires every ~1 second
        ▼
[content.js → background.js] chrome.runtime.sendMessage({ type: "RECORDING_CHUNK", index, data })
        │
        ▼
[background.js] Writes chunk to IndexedDB as "chunk_00000001", "chunk_00000002", …
        │
        │  (every 20 seconds)
[content.js → background.js] chrome.runtime.sendMessage({ type: "PING" })
        │                     Resets the SW 30s kill timer
        ▼
User stops recording
        │
[content.js → background.js] chrome.runtime.sendMessage({ type: "RECORDING_COMPLETE", … })
        │
        ▼
[background.js] Reads all chunk_ keys from IDB → sorts → assembles Blob
                Saves to IDB["latest"] → deletes chunk_ entries
                chrome.tabs.create({ url: "preview.html" })
        │
        ▼
[preview.js] Opens IDB → reads IDB["latest"] → createObjectURL(blob) → renders player
```

### Why the background is the IDB writer, not the content script

IndexedDB is origin-scoped. A content script running inside `google.com` writes to `google.com`'s IndexedDB. The preview page, hosted at `chrome-extension://[id]`, cannot read that database. The background service worker and the preview page share the same extension origin, so IDB written by the background is readable by the preview page without any cross-origin issues.

This is one of the least obvious constraints in Chrome extension development. The symptom — "No recording found" on the preview page despite data being written — is indistinguishable from a write failure unless you specifically query IDB from both contexts separately to observe the origin isolation.

### Message serialisation constraints

`chrome.runtime.sendMessage` serialises payloads to JSON. This has two important implications:

**Binary data must be converted.** `Blob` and `ArrayBuffer` cannot be sent directly via `sendMessage`. Raw binary is converted to a `Uint8Array` then to a plain JavaScript `Array` of numbers before sending. On the receiving end, `new Uint8Array(msg.data)` reconstructs the binary. Each 1-second chunk at 3 Mbps is approximately 375 KB of binary → ~375K numbers in a JSON array → approximately 1–1.5 MB per message. This is well within the `sendMessage` practical limit.

**One large message cannot replace many small ones.** Sending the entire recording blob as a single message at stop time (the initial naive approach) fails for recordings longer than ~90 seconds. At 3 Mbps, a 5-minute recording is ~112 MB of binary → ~336 MB of JSON → well over Chrome's message size limit, causing a silent failure. Per-chunk streaming eliminates this ceiling entirely.

---

## 3. MediaRecorder Workflow

### Stream acquisition

Recording requires compositing up to three independent media sources:

```
getDisplayMedia()  → display stream (video + optional system audio)
getUserMedia()     → microphone stream (audio only)
getUserMedia()     → camera stream (video only, for PiP overlay)
```

These three sources cannot be combined directly into a single `MediaStream` in a way that MediaRecorder handles natively for the camera PiP case. The camera is composited separately onto a `<canvas>` element.

### Canvas compositing for camera PiP

```
display video track → <video id="sv"> → canvas.drawImage(sv, 0, 0, w, h)  [full frame]
camera video track  → <video id="cm"> → canvas.drawImage(cm, x, y, cw, ch) [bottom-right circle]

canvas.captureStream(30) → new video track replacing the display track
```

The draw loop runs via `setInterval` at 33ms intervals (30 fps), not `requestAnimationFrame`. This is intentional: `rAF` is throttled to 0 fps in background tabs by Chrome to conserve resources. When a user shares their screen and the recording tab moves to the background, `rAF` stops entirely — producing a static first frame for the entire recording. `setInterval` runs continuously regardless of tab visibility.

### Codec selection

At runtime, `MediaRecorder.isTypeSupported()` is queried against a priority list:

```javascript
["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]
```

VP9 is preferred for its superior compression at equivalent quality. VP8 is the fallback for older Chrome versions. The final fallback lets the browser choose its own codec. In practice, all modern Chrome versions support VP9.

### Bitrate configuration

```javascript
videoBitsPerSecond: 3_000_000   // 3 Mbps
audioBitsPerSecond: 128_000     // 128 Kbps
```

3 Mbps was chosen after empirical testing. It matches YouTube's recommended upload bitrate for 1080p60 content and produces excellent quality for screen recording (which contains large static regions that compress very efficiently). Higher bitrates (8 Mbps was tried initially) produce diminishing visual returns for screen content while significantly increasing file size and IDB write pressure.

### Chunk timeslice and final flush

`MediaRecorder.start(1000)` produces an `ondataavailable` event approximately every 1 second. Before calling `stop()`, `requestData()` is called explicitly to flush the final partial chunk. Without this call, the last partial second of recording is frequently lost because `stop()` does not guarantee a final `ondataavailable` event for the incomplete buffer.

```javascript
Rec.prototype.stop = function() {
  if (this.mr && this.mr.state !== "inactive") {
    this._clrTick();
    try { this.mr.requestData(); } catch(_) {}  // flush final chunk
    this.mr.stop();
  }
};
```

### Stream cleanup

All acquired streams — display, microphone, combined — are explicitly stopped on recording end and on widget close. Failing to stop tracks leaves the browser's recording indicator active in the tab/OS, which is a confusing and unacceptable UX failure.

---

## 4. Permission Handling Architecture

### Permissions requested at widget open, not at record start

Camera and microphone permissions are requested immediately when the widget opens, before the user clicks Start Recording. This is a deliberate UX decision — it surfaces the browser's permission prompt while the user is in "setup mode" and can see the permission status indicators update in real time. Requesting at record start would interrupt the flow at a more disruptive moment and provide no visual feedback about what was granted.

### Permission result states

Each permission (mic, camera) tracks one of four states: `pending`, `granted`, `denied`. The widget renders differently for each state:

- **Pending:** amber indicator, spinner tag, "Requesting…" sublabel
- **Granted:** green indicator, checkmark tag, "Ready" / "Live preview ready"
- **Denied:** red indicator, ✕ tag, descriptive message explaining the consequence

### Graceful degradation

A denied permission is not a blocking error. It is a configuration state.

- Denied microphone → recording proceeds without audio
- Denied camera → recording proceeds without PiP overlay
- Both denied → screen-only recording, fully functional

The user is never blocked from recording by a permission denial. The consequence is clearly communicated but the action is not prevented.

### `getDisplayMedia` is not a permission

`getDisplayMedia` (screen capture) does not use the browser permission system. It presents a native OS-level picker every time — it cannot be pre-granted or persisted. This is a browser security model decision. The extension does not attempt to work around it.

---

## 5. State Handling Approach

### Widget UI state machine

The widget UI is modelled as a simple string-keyed state variable:

```
"setup"           → Full setup card (permissions, mode selector, start button)
"min_setup"       → Minimised pill (Recur label + expand button)
"recording"       → Full recording card (timer, pause/stop)
"min_rec"         → Minimised pill (live timer + expand button)
```

State transitions are explicit and exhaustive. Every user action (minimise, expand, start, pause, resume, stop, close) maps to exactly one state transition. The `render()` function is a pure projection from state to HTML — it rebuilds the innerHTML of the shadow root's container on every state change. This is intentional simplicity: no virtual DOM, no diffing, no component lifecycle. For a widget of this complexity, the overhead of rebuilding a ~30-element DOM tree on state change is immeasurable.

### Recorder state machine

The recorder itself tracks a separate state:

```
"idle"       → No recording in progress
"recording"  → Active recording
"paused"     → Paused (MediaRecorder.pause() called)
```

These two state machines (UI state and recorder state) are intentionally separate. The UI state determines what the widget looks like; the recorder state determines what media operations are valid. They are composed at render time but never conflated.

### No shared global state

All state is local to the IIFE closure in `content.js`. There is no `window.recurState`, no event bus, no store. The re-injection guard (`window.__recurLoaded`) is the only piece of state that lives outside the closure, and it is a boolean flag with a single purpose: prevent double-injection of the content script.

---

## 6. Local-First Recording: Rationale

All recording data stays on the user's machine. There is no server, no upload, no account, no network request for video data.

### Why local-first for this project

**Time constraint.** A backend capable of accepting large video uploads, transcoding, storage, and shareable link generation is a multi-week project. Within a 2-day constraint, local-first is the only realistic choice that produces a working, testable product.

**Privacy.** Screen recordings often capture sensitive information — passwords, private messages, financial data. Local storage means no data leaves the machine without the user explicitly clicking Download.

**No infrastructure cost.** Local-first requires no cloud account, no S3 bucket, no CDN, no server, no auth system.

**Alignment with the core requirement.** The assignment asked for a working screen recorder, not a sharing platform. Local playback and download satisfies the requirement completely.

### Storage architecture

Recordings are stored in IndexedDB under the extension's origin (`chrome-extension://[id]`). This storage persists across browser sessions (unlike `sessionStorage` or in-memory) and has no practical size limit for the recording lengths this extension targets.

IndexedDB was chosen over:
- `chrome.storage.local` — 10 MB quota by default, insufficient for video
- `chrome.storage.session` — wiped on browser close, no persistence
- File System API — requires user to pick a directory, adds UX friction
- OPFS (Origin Private File System) — would be the ideal choice for a production system (see Future Improvements), but requires more complex async file handle management

---

## 7. UX Decisions

### Shadow DOM widget isolation

The widget is injected into every webpage the user visits. Without isolation, the host page's CSS can collapse, recolour, or break the widget's layout entirely. Shadow DOM provides a complete style boundary — the widget's CSS lives inside the shadow root and is unaffected by any host page stylesheet, regardless of how aggressive the host's CSS resets are.

An additional consequence: the Shadow DOM's `<style>` tag is not subject to the host page's Content Security Policy. This allows the widget to render correctly on CSP-strict sites (Google, YouTube, GitHub, etc.) that would otherwise block injected stylesheets.

### Fonts loaded via `<link>`, not `@import`

Google Fonts are loaded via a `<link rel="stylesheet">` element injected into the host page's `<head>`, rather than via `@import` inside a `<style>` tag. Chrome blocks `@import` inside dynamically injected style elements on pages with a strict `style-src` CSP. Using a `<link>` element bypasses this restriction because `<link>` tags are evaluated by the HTML parser, not the CSS parser.

### Immediate widget display on click

The widget appears immediately on the first extension icon click without requiring a second click. This required careful handling of the content script re-injection guard. The IIFE checks `window.__recurLoaded` on entry — if already loaded, it calls `__recurShowWidget()` and returns. If not, it runs full initialisation and then calls `__recurShowWidget()` at the end. Both paths always result in the widget being shown.

### Floating, draggable, minimisable

The widget does not anchor itself to a fixed corner and stay there. Users are working on pages they care about; a large floating element that cannot be moved or shrunk is an obstruction. The drag handle on the card header allows repositioning anywhere on the screen. The minimise button collapses it to a compact pill that shows either "Recur" (in setup) or the live timer (during recording). The pill takes up approximately 120×30px and is designed to be unobtrusive during active recording.

### Permissions visible before recording starts

Showing mic and camera permission status in the setup card serves two purposes: it confirms to the user that the extension has the access it needs, and it communicates clearly what will be recorded. A "Ready" status next to the microphone indicator is more informative than discovering after the fact that the recording has no audio.

### No modal, no redirect, no new tab until recording ends

The widget is entirely self-contained in the host page until the recording stops. No new tabs open, no redirects happen, no focus is stolen during recording. The preview tab opens only after `MediaRecorder.stop()` fires and the blob is fully assembled and saved to IDB.

---

## 8. Error Handling

### MediaRecorder error

`MediaRecorder` exposes an `onerror` event. When fired, the recorder is cleaned up, all streams are stopped, and the UI returns to the setup state. The error is logged to the console but not surfaced to the user as an alert — surfacing it would be disruptive and the user has already lost the recording at that point.

### Permission denial

Handled as a state, not an error. Covered in Section 4.

### `getDisplayMedia` cancellation

If the user opens the screen picker and then presses Cancel (or hits Escape), `getDisplayMedia` rejects with a `NotAllowedError`. This is caught in the `startRec` `.catch()` handler, which resets `recState` to `"idle"` and `ui` to `"setup"`, returning the user to the setup card as if nothing happened.

### Chunk IDB write failure

Each chunk write to IndexedDB is fire-and-forget with a `.catch(console.error)`. A failed chunk write means a gap in the recording — the assembly step skips chunks whose IDB reads fail (`req.onerror → next()`). This is a graceful degradation: a recording with one failed chunk write is better than a recording that throws and produces nothing.

### Assembly with zero chunks

If `RECORDING_COMPLETE` arrives and no `chunk_` keys exist in IDB (e.g. the SW was killed despite the keepalive), the preview tab is opened anyway with a console error. The preview page's `idbLoad()` function rejects and displays "No recording found" with a clear message. The failure is visible and non-cryptic.

### Preview page with no recording

The preview page does not assume data exists. `idbLoad()` wraps the IDB `get` in a Promise and rejects explicitly if `req.result` is `undefined`. The catch renders a clear empty state rather than a broken player.

### `vid.duration === Infinity`

Raw WebM files produced by `MediaRecorder` contain no duration metadata in the container header. Browsers report `vid.duration` as `Infinity` for such files. The preview player detects this with `isFinite(vd)` and falls back to the elapsed seconds recorded by the content script's timer, which is passed as `duration` in the `RECORDING_COMPLETE` message and stored in IDB alongside the blob.

---

## 9. Technical Tradeoffs

### Per-chunk streaming vs. single blob transfer

**Chosen:** Stream each ~375 KB chunk to background as it arrives.  
**Alternative:** Buffer all chunks in memory, send as one blob on stop.

Per-chunk streaming adds per-chunk serialisation overhead (Array.from → JSON → Uint8Array reconstruction). For a 5-minute recording at 3 Mbps, this is approximately 300 serialisation round-trips of ~375 KB each. The overhead is real but acceptable — the alternative (single blob transfer) silently fails for any recording over ~90 seconds due to Chrome message size limits, and loses all data if the SW is killed.

### IndexedDB vs. OPFS

**Chosen:** IndexedDB  
**Alternative:** Origin Private File System (OPFS)

OPFS provides a proper file handle API with streaming write support, no practical size ceiling, and better performance for large sequential writes. It is the correct production choice for a screen recorder. It was not implemented here due to the 2-day constraint and the additional complexity of managing file handles across the background service worker lifecycle. IndexedDB is well-understood, widely documented, and sufficient for recordings up to the 20-minute limit.

### No WebM duration header patching

**Chosen:** Use elapsed timer as duration fallback.  
**Alternative:** Post-process the WebM container to inject a valid `Duration` element.

Patching a WebM container's Segment Info block to add a valid duration atom requires either parsing the EBML (Extensible Binary Meta Language) format that WebM is built on, or using a library like `fix-webm-duration`. A naive scan for the `0x4489` element ID in the first 4 KB is unreliable because `MediaRecorder` WebM output frequently omits the `Duration` element entirely rather than setting it to zero. The correct fix requires either finding and inserting the element, or using a library. Within the 2-day constraint, the elapsed-time fallback was chosen as a reliable approximation that does not require binary container parsing.

### Shadow DOM vs. iframe isolation

**Chosen:** Shadow DOM  
**Alternative:** Injected `<iframe>` for widget containment

An `<iframe>` provides complete isolation (separate browsing context, separate JS environment). However, it introduces cross-frame communication overhead, cannot be positioned as flexibly, and has more restrictions on certain APIs. Shadow DOM provides sufficient CSS isolation for this use case without the complexity overhead.

### Vanilla JS vs. React/Vue

**Chosen:** Vanilla JS  
**Alternative:** A UI framework (React, Preact, Vue)

A framework would provide component lifecycle management, reactive state, and more maintainable render logic at the cost of a build step, bundle size, and complexity. Given that the widget is injected as a content script, bundle size matters — a React bundle would be 30–40 KB min+gzip just for the framework. The widget's state machine is simple enough that a manual `render()` function rebuilding innerHTML on state change is readable and correct. No build tooling is also a meaningful advantage for reviewer auditability.

---

## 10. Limitations Within the 2-Day Constraint

These are known limitations that were explicitly deprioritised to ship a working product within the time constraint.

**No WebM duration metadata.** The downloaded `.webm` file lacks a valid duration atom. It plays correctly in VLC and Chrome but may not seek correctly in all players or show a valid duration in file metadata viewers.

**No recording persistence across sessions.** The `latest` IDB key is overwritten by each new recording. A recording that has not been downloaded is lost when a new recording starts. There is no history, no naming, no cloud backup.

**20-minute hard limit.** Enforced in the content script's tick handler. This exists because the in-memory chunk accumulation in the background has not been tested beyond this duration, and the IDB write pattern has not been profiled under large-volume sustained writes.

**Camera PiP CPU cost.** Canvas compositing at 30 fps runs `setInterval` unconditionally during recording. On lower-end hardware recording for extended periods, this contributes measurably to CPU usage. An adaptive frame rate (dropping to 15 fps when the machine is under load) was not implemented.

**No system audio mixing UI.** System audio (from `getDisplayMedia`'s audio track) and microphone audio are merged via an `AudioContext` mixer, but there are no gain controls. The user cannot adjust the relative volume of system audio vs. microphone.

**No error recovery UI.** If the service worker is killed despite the keepalive and the recording is lost, the user sees "No recording found" with no explanation of what happened or what they can do.

**Single-recording-at-a-time.** The IDB key `latest` is a singleton. Multiple simultaneous recordings are architecturally unsupported.

---

## 11. Scalability Considerations

Scalability here means two things: what happens as recordings get longer, and what a production version of this system would look like.

### Recording duration scalability

The current architecture scales to the 20-minute limit without issues. The per-chunk IDB write pattern is O(n) in recording duration — each additional second adds one additional chunk write of approximately constant size. IDB itself has no practical write limit beyond available disk space.

Beyond 20 minutes, two constraints become relevant:

1. **Background service worker memory.** The `chunkBuffer` array (in previous versions) held all chunks in memory. The current architecture writes each chunk to IDB immediately, so memory pressure is bounded by the size of one chunk (~375 KB) regardless of recording duration.

2. **IDB read-time assembly.** On `RECORDING_COMPLETE`, the background reads all `chunk_` keys sequentially and assembles a `Blob`. For a 20-minute recording at 3 Mbps, this is approximately 1,200 chunks. Sequential IDB reads are fast but not instantaneous — for very long recordings, this assembly step could take several seconds. A progress indicator on the preview page during "Loading your recording…" would address the UX.

### Production architecture

A production version of this extension would differ from the take-home submission in several ways:

**OPFS for chunk storage.** The Origin Private File System provides a synchronous-style file write API (via `FileSystemSyncAccessHandle` in a web worker) that is dramatically faster than IDB for sequential binary writes. Chunks would be appended to a single file handle rather than written as individual IDB keys, eliminating the assembly step entirely — the file is already assembled as it's written.

**Upload pipeline.** After recording stops, the assembled blob would be uploaded to object storage (S3/R2/GCS) via a multipart upload. The background service worker would manage the upload queue, resuming from the last successful part on failure. The preview tab would show upload progress and generate a shareable link on completion.

**Backend for sharing.** A shareable link requires a URL that resolves to the video. This requires either direct object storage URLs (public S3) or a lightweight backend that maps short IDs to storage keys and streams the video with correct `Content-Type` headers and `Range` request support for seeking.

**Chunk integrity verification.** In production, each chunk sent from content script to background should include a checksum (CRC32 or similar) that the background verifies before writing to IDB. Silent corruption of a chunk produces a corrupt WebM container that may not play past the corrupted segment.

**Auth and access control.** Any sharing feature requires user authentication and access-controlled video URLs. This adds the full auth surface (OAuth, session tokens, CORS, signed URLs) that was explicitly out of scope for this assignment.

---

## 12. Future Improvements

Listed in approximate order of engineering value.

**OPFS chunk streaming** — Replace IDB chunk storage with an OPFS `FileSystemSyncAccessHandle` in a shared worker. Eliminates the assembly step, improves write throughput, and removes the practical recording length ceiling.

**WebM container post-processing** — After recording stops, parse the EBML structure of the assembled WebM blob and inject a valid `Duration` element into the Segment Info block. This makes the file fully seekable in all players and correct in file metadata.

**Recording library** — Store multiple recordings in IDB with unique keys (timestamp-based), display a library view in the preview page, allow renaming and deletion.

**Upload to object storage** — Add an optional upload step after recording, with multipart upload, retry on failure, and a shareable link copied to clipboard.

**Adaptive PiP frame rate** — Reduce the canvas draw interval dynamically when the host machine is under CPU pressure, preserving recording quality at the cost of camera smoothness.

**System audio vs. mic gain controls** — Surface two volume sliders in the setup card for independent level control of system audio and microphone input.

**Custom recording duration limit** — Allow users to configure the maximum recording duration (default 20 minutes) via an options page.

**Error recovery UX** — If assembly produces an empty blob or the preview page finds no recording, display a specific error state explaining what went wrong (SW killed, IDB write failed, etc.) rather than a generic "No recording found."

**Annotations overlay** — A draw-on-screen mode during recording using a transparent canvas layer over the display stream, allowing the user to highlight or annotate during recording.

**Keyboard shortcuts** — Start, pause, stop via configurable keyboard shortcuts without requiring interaction with the widget, registered via `chrome.commands`.

---

*Recur — Engineering Architecture Document · v20.0.0*
