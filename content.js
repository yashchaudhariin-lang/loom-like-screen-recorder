(function () {
  /* ── Re-injection guard ───────────────────────────────────────────────── */
  if (window.__recurLoaded) {
    if (typeof window.__recurShowWidget === "function") window.__recurShowWidget();
    return;
  }
  window.__recurLoaded = true;

  /* ── Helpers ──────────────────────────────────────────────────────────── */
  function fmt(s) {
    s = Math.max(0, Math.floor(s || 0));
    return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
  }
  function makeFile() {
    var d = new Date(), z = function (n) { return String(n).padStart(2, "0"); };
    return "recur-" + d.getFullYear() + "-" + z(d.getMonth()+1) + "-" + z(d.getDate()) +
           "_" + z(d.getHours()) + "-" + z(d.getMinutes()) + "-" + z(d.getSeconds()) + ".webm";
  }
  /* ── No idbSave here — background service worker handles storage ─────── */

  /* ── Chunk streaming helper — sends each chunk to background as it arrives ─ */
  function sendChunk(chunkBlob, index) {
    chunkBlob.arrayBuffer().then(function(buf) {
      chrome.runtime.sendMessage({
        type:  "RECORDING_CHUNK",
        index: index,
        data:  Array.from(new Uint8Array(buf))
      });
    }).catch(function(e){ console.warn("[Recur] chunk send failed:", e); });
  }

  /* ── Recorder ─────────────────────────────────────────────────────────── */
  function Rec(ev) {
    this.ev = ev;
    this.mr = this.disp = this.mic = this.combined = null;
    this.chunks = []; this.t0 = 0; this.pauseAt = 0; this.pausedMs = 0;
    this.tick = null; this.file = "";
    this.chunkIndex = 0;  // streaming chunk counter
  }
  Rec.prototype.start = async function (disp, cfg, camStream) {
    try {
      this.file = makeFile(); this.chunks = []; this.pausedMs = 0;
      this.disp = disp;
      var aud = [].concat(disp.getAudioTracks());
      if (cfg.mic) {
        try {
          this.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
          aud = aud.concat(this.mic.getAudioTracks());
        } catch (_) {}
      }
      var vid = disp.getVideoTracks();
      var tracks = [].concat(vid);
      if (aud.length === 1) { tracks.push(aud[0]); }
      else if (aud.length > 1) { var mx = await this._mix(aud); if (mx) tracks.push(mx); }
      /* camera PiP overlay */
      if (camStream && camStream.getVideoTracks().length) {
        try {
          var ct = camStream.getVideoTracks()[0];
          var ss = vid[0] ? vid[0].getSettings() : {};
          var cv = document.createElement("canvas");
          cv.width = ss.width || 1280; cv.height = ss.height || 720;
          var ctx = cv.getContext("2d");
          var sv = document.createElement("video"); sv.srcObject = new MediaStream(vid); sv.muted = true; await sv.play();
          var cm = document.createElement("video"); cm.srcObject = new MediaStream([ct]); cm.muted = true; await cm.play();
          var cw = Math.round(cv.width * 0.22), ch = Math.round(cw * (cm.videoHeight || 9) / (cm.videoWidth || 16)), pad = 16;
          var self = this;
          // Use setInterval NOT requestAnimationFrame — rAF freezes in background tabs
          var drawInterval = setInterval(function() {
            if (!self.mr || self.mr.state === "inactive") {
              clearInterval(drawInterval);
              return;
            }
            ctx.drawImage(sv, 0, 0, cv.width, cv.height);
            ctx.save(); ctx.beginPath();
            ctx.arc(cv.width - pad - cw / 2, cv.height - pad - ch / 2, Math.min(cw, ch) / 2, 0, Math.PI * 2);
            ctx.clip(); ctx.drawImage(cm, cv.width - pad - cw, cv.height - pad - ch, cw, ch); ctx.restore();
          }, 1000 / 30);
          var cs = cv.captureStream(30);
          tracks = [cs.getVideoTracks()[0]].concat(tracks.filter(function (t) { return t.kind === "audio"; }));
        } catch (e) { console.warn("[Recur] cam overlay:", e); }
      }
      this.combined = new MediaStream(tracks);
      var self = this;
      if (vid[0]) vid[0].addEventListener("ended", function () { if (self.mr && self.mr.state !== "inactive") self.stop(); });
      var mime = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]
        .find(function (m) { return MediaRecorder.isTypeSupported(m); }) || "";
      this.mr = new MediaRecorder(this.combined, { mimeType: mime, videoBitsPerSecond: 3000000, audioBitsPerSecond: 128000 });
      this.mr.ondataavailable = function (e) {
        if (e.data.size > 0) {
          self.chunks.push(e.data);           // keep local copy for _done()
          sendChunk(e.data, self.chunkIndex++); // stream to background IDB
        }
      };
      this.mr.onstop  = function () { self._done(); };
      this.mr.onerror = function () { self.ev.onError(new Error("MediaRecorder error")); self._cleanup(); };
      this.mr.start(1000);
      this.t0 = Date.now();
      this._tick();
      this.ev.onStart();
    } catch (err) {
      this._cleanup();
      var e = err instanceof Error ? err : new Error(String(err));
      this.ev.onError((e.name === "AbortError" || e.name === "NotAllowedError") ? new Error("CANCELLED") : e);
    }
  };
  Rec.prototype.stop   = function () {
    if (this.mr && this.mr.state !== "inactive") {
      this._clrTick();
      try { this.mr.requestData(); } catch(_) {}  // flush final chunk
      this.mr.stop();
    }
  };
  Rec.prototype.pause  = function () { if (this.mr && this.mr.state === "recording") { this.mr.pause(); this.pauseAt = Date.now(); this._clrTick(); this.ev.onPause(); } };
  Rec.prototype.resume = function () { if (this.mr && this.mr.state === "paused") { this.pausedMs += Date.now() - this.pauseAt; this.mr.resume(); this._tick(); this.ev.onResume(); } };
  Rec.prototype.elapsed = function () {
    if (!this.t0) return 0;
    var adj = (this.mr && this.mr.state === "paused") ? Date.now() - this.pauseAt : 0;
    return Math.floor((Date.now() - this.t0 - this.pausedMs - adj) / 1000);
  };
  Rec.prototype._mix = async function (tracks) {
    try {
      var ac = new AudioContext(), d = ac.createMediaStreamDestination();
      tracks.forEach(function (t) { ac.createMediaStreamSource(new MediaStream([t])).connect(d); });
      return d.stream.getAudioTracks()[0] || null;
    } catch (_) { return tracks[0] || null; }
  };
  Rec.prototype._done = function () {
    var dur  = this.elapsed();   // capture BEFORE cleanup nulls t0
    var blob = new Blob(this.chunks, { type: "video/webm" });
    var f    = this.file;
    this._cleanup();
    this.ev.onStop(blob, f, dur);
  };
  var MAX_RECORDING_SECS = 20 * 60; // 20 minute hard limit

  Rec.prototype._tick = function () {
    var self = this;
    // Keepalive ping every 20s to prevent SW from being killed
    var pingInterval = setInterval(function () {
      try { chrome.runtime.sendMessage({ type: "PING" }); } catch(_) {}
    }, 20000);
    this.tick = setInterval(function () {
      var s = self.elapsed();
      self.ev.onTick(s);
      // Auto-stop at 20 minutes
      if (s >= MAX_RECORDING_SECS) {
        clearInterval(pingInterval);
        self.stop();
      }
    }, 1000);
    // Store ping interval ref so we can clear it
    this._pingInterval = pingInterval;
  };
  Rec.prototype._clrTick = function () {
    if (this.tick)          { clearInterval(this.tick);          this.tick          = null; }
    if (this._pingInterval) { clearInterval(this._pingInterval); this._pingInterval = null; }
  };
  Rec.prototype._cleanup = function () {
    this._clrTick();
    [this.disp, this.mic, this.combined].forEach(function (s) { if (s) s.getTracks().forEach(function (t) { t.stop(); }); });
    this.disp = this.mic = this.combined = this.mr = null; this.chunks = [];
  };

  /* ── Widget — uses Shadow DOM so page CSP never touches our styles ─────── */
  var hostEl   = null;  // the <div> appended to document.body
  var shadow   = null;  // shadowRoot
  var rec      = null;
  var ui       = "setup";        // setup | recording | min_setup | min_rec
  var micPerm  = "pending";      // pending | granted | denied
  var camPerm  = "pending";
  var camOn    = false;
  var camStr   = null;
  var recState = "idle";         // idle | recording | paused
  var elapsed  = 0;
  var mode     = "screen";
  var micInRec = false;

  window.__recurShowWidget = function () {
    if (hostEl) {
      if (ui === "min_setup") { ui = "setup"; render(); }
      return;
    }
    /* Create host element + shadow root */
    hostEl = document.createElement("div");
    hostEl.id = "recur-host";
    /* Position the host with inline styles — not affected by any stylesheet */
    hostEl.style.cssText = "position:fixed!important;top:20px!important;right:20px!important;" +
      "z-index:2147483647!important;display:block!important;width:auto!important;" +
      "height:auto!important;overflow:visible!important;pointer-events:auto!important;" +
      "border:none!important;background:none!important;padding:0!important;margin:0!important;";
    document.body.appendChild(hostEl);

    shadow = hostEl.attachShadow({ mode: "open" });

    /* Inject CSS inside shadow — completely isolated from page CSP */
    var styleEl = document.createElement("style");
    styleEl.textContent = SHADOW_CSS;
    shadow.appendChild(styleEl);

    /* Root container inside shadow */
    var wrapper = document.createElement("div");
    wrapper.id = "root";
    shadow.appendChild(wrapper);

    ui = "setup";
    render();
    askPerms();
  };

  /* ── Permissions ──────────────────────────────────────────────────────── */
  function askPerms() {
    navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      .then(function (s) { s.getTracks().forEach(function (t) { t.stop(); }); micPerm = "granted"; render(); })
      .catch(function () { micPerm = "denied"; render(); });

    navigator.mediaDevices.getUserMedia({ video: true, audio: false })
      .then(function (s) {
        camStr = s; camPerm = "granted"; camOn = true; render();
        setTimeout(function () {
          var v = shadow && shadow.getElementById("cam-vid");
          if (v && camStr) { v.srcObject = camStr; v.play().catch(function () {}); }
        }, 40);
      })
      .catch(function () { camPerm = "denied"; camOn = false; render(); });
  }

  function stopCam() { if (camStr) { camStr.getTracks().forEach(function (t) { t.stop(); }); camStr = null; } }

  /* ── Render ───────────────────────────────────────────────────────────── */
  function root() { return shadow && shadow.getElementById("root"); }
  function q(id)  { return shadow && shadow.getElementById(id); }

  function render() {
    var r = root(); if (!r) return;
    if (ui === "min_setup" || ui === "min_rec") { r.innerHTML = pillHTML(); }
    else if (ui === "setup")                    { r.innerHTML = setupHTML(); }
    else                                        { r.innerHTML = recHTML();   }
    bindEvents();
    if (ui === "setup" && camOn && camPerm === "granted") {
      setTimeout(function () {
        var v = q("cam-vid");
        if (v && camStr) { v.srcObject = camStr; v.play().catch(function () {}); }
      }, 30);
    }
  }

  /* ── HTML templates ───────────────────────────────────────────────────── */
  function pillHTML() {
    var isRec = ui === "min_rec", paused = recState === "paused";
    return '<div class="pill" id="pill">' +
      '<div class="dot' + (isRec && !paused ? " pulse" : "") + '"></div>' +
      (isRec ? '<span class="ptimer" id="pill-t">' + fmt(elapsed) + '</span>' : '<span class="plbl">Recur</span>') +
      '<button class="ibtn" id="max-btn">' + I.expand + '</button></div>';
  }

  function setupHTML() {
    var mp = micPerm, cp = camPerm;
    var mdot = mp === "granted" ? "#34d399" : mp === "denied" ? "#f87171" : "#fbbf24";
    var cdot = cp === "granted" ? "#34d399" : cp === "denied" ? "#f87171" : "#fbbf24";
    var mlbl = mp === "granted" ? "Ready" : mp === "denied" ? "Denied — no mic audio" : "Requesting…";
    var clbl = cp === "granted" ? "Live preview ready" : cp === "denied" ? "Denied — no cam overlay" : "Requesting…";
    var mtag = mp === "granted" ? '<span class="tag green">' + I.check + " OK</span>"
             : mp === "denied"  ? '<span class="tag red">' + I.x + " Denied</span>"
             : '<span class="tag amber"><span class="spin-xs"></span></span>';
    var ctag = cp === "granted" ? '<span class="tag green">' + I.check + " OK</span>"
             : cp === "denied"  ? '<span class="tag red">' + I.x + " Denied</span>"
             : '<span class="tag amber"><span class="spin-xs"></span></span>';
    var camArea = (camOn && cp === "granted")
      ? '<video id="cam-vid" class="camvid" autoplay muted playsinline></video><div class="livebadge"><span class="livedot"></span>Live</div>'
      : '<div class="ph">' +
          (cp === "pending" ? '<div class="spin-lg"></div><p class="phtext">Requesting camera…</p>'
           : cp === "denied" ? I.camIcon + '<p class="phtext" style="color:#f87171">Camera denied</p>'
           : I.camIcon + '<p class="phtext">Camera preview</p>') +
        '</div>';
    return '<div class="card">' +
      '<div class="hdr" id="drag"><div class="brand"><div class="bdot"></div><span class="bname">Recur</span></div>' +
      '<div class="hbtns"><button class="ibtn" id="min-btn">' + I.minus + '</button>' +
      '<button class="ibtn xbtn" id="close-btn">' + I.close + '</button></div></div>' +
      '<div class="preview">' + camArea + '</div>' +
      '<div class="perms">' +
        '<div class="prow"><div class="pdot" style="background:' + mdot + '"></div><div class="pico">' + I.mic() + '</div><div class="ptxt"><span class="plbl">Microphone</span><span class="psub">' + mlbl + '</span></div>' + mtag + '</div>' +
        '<div class="prow"><div class="pdot" style="background:' + cdot + '"></div><div class="pico">' + I.cam + '</div><div class="ptxt"><span class="plbl">Camera</span><span class="psub">' + clbl + '</span></div>' + ctag + '</div>' +
      '</div>' +
      '<div class="divider"></div>' +
      '<div class="modes">' +
        '<button class="mbtn' + (mode === "screen" ? " active" : "") + '" id="m-screen">' + I.monitor + ' Screen</button>' +
        '<button class="mbtn' + (mode === "tab"    ? " active" : "") + '" id="m-tab">'    + I.tab     + ' This Tab</button>' +
      '</div>' +
      '<button class="startbtn" id="start-btn">' + I.rec + ' Start Recording</button>' +
      '<p class="hint">Max 20 min · Choose what to share in the dialog</p></div>';
  }

  function recHTML() {
    var paused = recState === "paused";
    return '<div class="card">' +
      '<div class="rechdr' + (paused ? " paused" : "") + '" id="drag">' +
        '<div class="recdot' + (paused ? "" : " pulse") + '"></div>' +
        '<span class="reclbl">' + (paused ? "Paused" : "Recording") + '</span>' +
        '<div class="hbtns"><button class="ibtn light" id="min-btn">' + I.minus + '</button></div>' +
      '</div>' +
      '<div class="recbody">' +
        '<div class="trow"><span class="timer" id="timer">' + fmt(elapsed) + '</span>' +
        '<span class="tag' + (paused ? " amber" : " red") + '">' + (paused ? "PAUSED" : "● REC") + '</span></div>' +
        '<div class="microw">' + (micInRec ? I.mic("rgba(52,211,153,.85)") : I.micOff) + '<span>' + (micInRec ? "Mic on" : "No mic") + '</span></div>' +
        '<div class="divider"></div>' +
        '<div class="ctls">' +
          '<button class="pausebtn" id="pause-btn">' + (paused ? I.play + " Resume" : I.pause + " Pause") + '</button>' +
          '<button class="stopbtn" id="stop-btn">' + I.stop + '</button>' +
        '</div>' +
      '</div></div>';
  }

  /* ── Event binding ────────────────────────────────────────────────────── */
  function bindEvents() {
    function on(id, fn) { var el = q(id); if (el) el.addEventListener("click", fn); }

    on("min-btn", function (e) { e.stopPropagation(); ui = ui === "setup" ? "min_setup" : "min_rec"; render(); });
    on("max-btn", function (e) { e.stopPropagation(); ui = ui === "min_setup" ? "setup" : "recording"; render(); });
    on("close-btn", closeWidget);

    var drag = q("drag") || q("pill");
    if (drag && hostEl) makeDraggable(drag, hostEl, shadow);

    if (ui === "setup") {
      on("m-screen", function () { mode = "screen"; render(); });
      on("m-tab",    function () { mode = "tab";    render(); });
      on("start-btn", startRec);
    }
    if (ui === "recording") {
      on("pause-btn", function () {
        if (recState === "paused") { rec && rec.resume(); recState = "recording"; }
        else                       { rec && rec.pause();  recState = "paused";   }
        render();
      });
      on("stop-btn", function () { rec && rec.stop(); });
    }
  }

  /* ── Close ────────────────────────────────────────────────────────────── */
  function closeWidget() {
    if (rec) rec.stop();
    stopCam();
    if (hostEl) { hostEl.remove(); hostEl = null; shadow = null; }
    window.__recurLoaded = false;
  }

  /* ── Start recording ──────────────────────────────────────────────────── */
  function startRec() {
    var constraints = { video: { frameRate: { ideal: 30 }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: true };
    if (mode === "tab") constraints.video.preferCurrentTab = true;

    navigator.mediaDevices.getDisplayMedia(constraints)
      .then(function (disp) {
        micInRec = micPerm === "granted";
        recState = "recording"; ui = "recording"; elapsed = 0; render();
        var camForRec = (camOn && camPerm === "granted" && camStr) ? camStr : null;

        rec = new Rec({
          onStart:  function () {},
          onPause:  function () { recState = "paused";    render(); },
          onResume: function () { recState = "recording"; render(); },
          onTick:   function (s) {
            elapsed = s;
            var t = q("timer"), p = q("pill-t");
            if (t) t.textContent = fmt(s);
            if (p) p.textContent = fmt(s);
          },
          onStop: function (blob, fname, dur) {
            recState = "idle"; stopCam();
            if (hostEl) { hostEl.remove(); hostEl = null; shadow = null; }
            window.__recurLoaded = false;
            // All chunks already streamed — just send finalise signal
            chrome.runtime.sendMessage({
              type:     "RECORDING_COMPLETE",
              mimeType: blob.type || "video/webm",
              duration: dur,
              filename: fname
            });
          },
          onError: function (err) {
            if (err.message !== "CANCELLED") console.error("[Recur]", err);
            recState = "idle"; ui = "setup"; rec = null; render();
          }
        });
        rec.start(disp, { mic: micInRec }, camForRec);
        try { chrome.runtime.sendMessage({ type: "RECORDING_STARTED" }); } catch (_) {}
      })
      .catch(function () { recState = "idle"; ui = "setup"; render(); });
  }

  /* ── Drag — moves the host element ───────────────────────────────────── */
  function makeDraggable(handle, el, sh) {
    var dragging = false, ox = 0, oy = 0;
    handle.addEventListener("mousedown", function (e) {
      if (e.target.closest && e.target.closest("button")) return;
      e.preventDefault(); dragging = true;
      /* get actual card position from the card inside shadow */
      var card = sh.querySelector(".card,.pill");
      var r = card ? card.getBoundingClientRect() : el.getBoundingClientRect();
      ox = e.clientX - r.left; oy = e.clientY - r.top;
      el.style.setProperty("right", "auto", "important");
      el.style.setProperty("bottom", "auto", "important");
      el.style.setProperty("left", r.left + "px", "important");
      el.style.setProperty("top",  r.top  + "px", "important");
    });
    document.addEventListener("mousemove", function (e) {
      if (!dragging) return;
      el.style.setProperty("left", Math.max(0, Math.min(e.clientX - ox, innerWidth  - 284)) + "px", "important");
      el.style.setProperty("top",  Math.max(0, Math.min(e.clientY - oy, innerHeight - 500)) + "px", "important");
    });
    document.addEventListener("mouseup", function () { dragging = false; });
  }

  /* ── Icons ────────────────────────────────────────────────────────────── */
  var I = {
    minus:   '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>',
    expand:  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>',
    close:   '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    pause:   '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1.5"/><rect x="14" y="4" width="4" height="16" rx="1.5"/></svg>',
    play:    '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21"/></svg>',
    stop:    '<svg width="15" height="15" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="3" fill="rgba(255,59,59,.9)"/></svg>',
    rec:     '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="8"/></svg>',
    check:   '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    x:       '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    cam:     '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>',
    camIcon: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,.13)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>',
    monitor: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>',
    tab:     '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3H5a2 2 0 0 0-2 2v4"/><path d="M9 3h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/></svg>',
    mic:  function (c) { c = c || "currentColor"; return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="' + c + '" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/></svg>'; },
    micOff:  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,.25)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V5a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2"/><line x1="12" y1="19" x2="12" y2="22"/></svg>'
  };

  /* ── Shadow DOM CSS — lives inside shadow, never touched by page CSP ─── */
  var SHADOW_CSS = [
    /* reset only within shadow */
    "*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;font-family:'DM Sans',system-ui,sans-serif;}",

    /* fonts — loaded via @font-face equivalent or system fallback */
    "@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600&family=DM+Mono:wght@500&display=swap');",

    /* keyframes */
    "@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.3;transform:scale(.75)}}",
    "@keyframes appear{from{opacity:0;transform:translateY(-8px) scale(.95)}to{opacity:1;transform:none}}",
    "@keyframes spin{to{transform:rotate(360deg)}}",

    /* card */
    "#root{display:block;width:264px;}",
    ".card{width:264px;border-radius:16px;overflow:hidden;background:rgba(13,13,16,.98);border:1px solid rgba(255,255,255,.09);box-shadow:0 20px 60px rgba(0,0,0,.7),0 0 0 1px rgba(255,255,255,.03);animation:appear .2s cubic-bezier(.34,1.4,.64,1);}",

    /* header */
    ".hdr{display:flex;align-items:center;gap:8px;padding:11px 12px;border-bottom:1px solid rgba(255,255,255,.06);cursor:grab;}",
    ".hdr:active{cursor:grabbing;}",
    ".brand{display:flex;align-items:center;gap:7px;flex:1;}",
    ".bdot{width:9px;height:9px;border-radius:50%;background:#ff3b3b;flex-shrink:0;}",
    ".bname{font-size:12px;font-weight:600;color:rgba(255,255,255,.7);letter-spacing:.03em;}",
    ".hbtns{display:flex;align-items:center;gap:2px;}",

    /* camera area */
    ".preview{width:100%;height:118px;background:#07070a;position:relative;overflow:hidden;}",
    ".camvid{width:100%;height:100%;object-fit:cover;transform:scaleX(-1);display:block;}",
    ".livebadge{position:absolute;top:7px;right:7px;display:flex;align-items:center;gap:5px;background:rgba(0,0,0,.6);backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,.1);border-radius:100px;padding:3px 8px;font-size:10px;font-weight:500;color:rgba(255,255,255,.8);}",
    ".livedot{width:6px;height:6px;border-radius:50%;background:#34d399;animation:pulse 2s ease-in-out infinite;}",
    ".ph{width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;}",
    ".phtext{font-size:11px;color:rgba(255,255,255,.22);}",

    /* permissions */
    ".perms{padding:10px 12px;display:flex;flex-direction:column;gap:3px;}",
    ".prow{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:10px;}",
    ".pdot{width:7px;height:7px;border-radius:50%;flex-shrink:0;transition:background .3s;}",
    ".pico{width:27px;height:27px;border-radius:8px;background:rgba(255,255,255,.05);display:flex;align-items:center;justify-content:center;flex-shrink:0;}",
    ".ptxt{flex:1;min-width:0;}",
    ".plbl{display:block;font-size:12px;font-weight:500;color:rgba(255,255,255,.8);line-height:1.3;}",
    ".psub{display:block;font-size:10px;color:rgba(255,255,255,.25);margin-top:1px;}",
    ".tag{display:inline-flex;align-items:center;gap:4px;font-size:10px;font-weight:500;border-radius:100px;padding:2px 7px;white-space:nowrap;}",
    ".tag.green{color:rgba(52,211,153,.9);background:rgba(52,211,153,.1);}",
    ".tag.amber{color:rgba(251,191,36,.9);background:rgba(251,191,36,.1);}",
    ".tag.red{color:rgba(248,113,113,.9);background:rgba(248,113,113,.1);}",

    /* divider / modes / start */
    ".divider{height:1px;background:rgba(255,255,255,.06);margin:2px 12px;}",
    ".modes{display:flex;gap:4px;padding:8px 10px;background:rgba(255,255,255,.03);margin:8px 12px 0;border-radius:10px;border:1px solid rgba(255,255,255,.06);}",
    ".mbtn{all:unset;cursor:pointer;flex:1;display:flex;align-items:center;justify-content:center;gap:5px;padding:6px 8px;border-radius:7px;font-size:11px;font-weight:500;color:rgba(255,255,255,.35);transition:background .15s,color .15s;}",
    ".mbtn.active{background:rgba(255,255,255,.1);color:rgba(255,255,255,.9);}",
    ".startbtn{all:unset;cursor:pointer;width:calc(100% - 24px);margin:8px 12px 4px;display:flex;align-items:center;justify-content:center;gap:7px;height:38px;border-radius:11px;background:#ff3b3b;color:white;font-size:13px;font-weight:600;box-shadow:0 4px 18px rgba(255,59,59,.35);transition:filter .15s,transform .1s;}",
    ".startbtn:hover{filter:brightness(1.12);}",
    ".startbtn:active{transform:scale(.97);}",
    ".hint{font-size:10px;color:rgba(255,255,255,.2);text-align:center;padding:4px 12px 12px;line-height:1.4;}",

    /* recording card */
    ".rechdr{background:#ff3b3b;padding:9px 12px;display:flex;align-items:center;gap:8px;cursor:grab;transition:background .3s;}",
    ".rechdr.paused{background:#1c1c22;}",
    ".rechdr:active{cursor:grabbing;}",
    ".recdot{width:8px;height:8px;border-radius:50%;background:rgba(255,255,255,.9);flex-shrink:0;}",
    ".recdot.pulse{animation:pulse 1.5s ease-in-out infinite;}",
    ".reclbl{font-size:11px;font-weight:600;color:rgba(255,255,255,.95);letter-spacing:.04em;text-transform:uppercase;flex:1;}",
    ".recbody{padding:12px;display:flex;flex-direction:column;gap:10px;}",
    ".trow{display:flex;align-items:center;gap:8px;}",
    ".timer{font-family:'DM Mono',monospace;font-size:22px;font-weight:500;color:rgba(255,255,255,.95);flex:1;}",
    ".microw{display:flex;align-items:center;gap:6px;font-size:11px;color:rgba(255,255,255,.35);}",
    ".ctls{display:flex;gap:6px;}",
    ".pausebtn{all:unset;cursor:pointer;flex:1;height:36px;border-radius:10px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.08);display:flex;align-items:center;justify-content:center;gap:6px;font-size:12px;font-weight:500;color:rgba(255,255,255,.75);transition:background .15s,transform .1s;}",
    ".pausebtn:hover{background:rgba(255,255,255,.12);color:white;}",
    ".pausebtn:active{transform:scale(.96);}",
    ".stopbtn{all:unset;cursor:pointer;width:36px;height:36px;border-radius:10px;background:rgba(255,59,59,.12);border:1px solid rgba(255,59,59,.22);display:flex;align-items:center;justify-content:center;transition:background .15s,transform .1s;flex-shrink:0;}",
    ".stopbtn:hover{background:rgba(255,59,59,.28);}",
    ".stopbtn:active{transform:scale(.92);}",

    /* pill */
    ".pill{display:inline-flex;align-items:center;gap:7px;background:rgba(13,13,16,.97);backdrop-filter:blur(20px);border:1px solid rgba(255,255,255,.09);border-radius:100px;padding:7px 11px 7px 9px;box-shadow:0 4px 20px rgba(0,0,0,.5);cursor:grab;animation:appear .18s ease-out;}",
    ".pill:active{cursor:grabbing;}",
    ".dot{width:7px;height:7px;border-radius:50%;background:#ff3b3b;flex-shrink:0;}",
    ".dot.pulse{animation:pulse 1.5s ease-in-out infinite;}",
    ".ptimer{font-family:'DM Mono',monospace;font-size:12px;font-weight:500;color:rgba(255,255,255,.85);min-width:36px;}",
    ".plbl{font-size:12px;font-weight:500;color:rgba(255,255,255,.5);}",

    /* buttons */
    ".ibtn{all:unset;cursor:pointer;width:22px;height:22px;border-radius:6px;display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,.5);transition:background .15s,color .15s;flex-shrink:0;}",
    ".ibtn:hover{background:rgba(255,255,255,.1);color:rgba(255,255,255,.9);}",
    ".ibtn.light{color:rgba(255,255,255,.7);}",
    ".ibtn.light:hover{background:rgba(0,0,0,.2);color:white;}",
    ".xbtn:hover{background:rgba(255,59,59,.2)!important;color:#f87171!important;}",

    /* spinners */
    ".spin-lg{width:26px;height:26px;border-radius:50%;border:2.5px solid rgba(255,255,255,.1);border-top-color:rgba(255,255,255,.5);animation:spin .7s linear infinite;}",
    ".spin-xs{display:inline-block;width:10px;height:10px;border-radius:50%;border:1.5px solid currentColor;border-top-color:transparent;animation:spin .7s linear infinite;flex-shrink:0;}"
  ].join("\n");

  /* ── Boot ─────────────────────────────────────────────────────────────── */
  if (typeof navigator !== "undefined" && navigator.mediaDevices) {
    window.__recurShowWidget();
  } else {
    window.__recurShowWidget = function () {};
  }
})();
