(function(){
  var app = document.getElementById("app");

  function fmt(s) {
    s = Math.max(0, Math.floor(s || 0));
    return String(Math.floor(s/60)).padStart(2,"0") + ":" + String(s%60).padStart(2,"0");
  }
  function fmtBytes(b) {
    if (!b) return "";
    if (b < 1024) return b + " B";
    if (b < 1048576) return (b/1024).toFixed(1) + " KB";
    return (b/1048576).toFixed(1) + " MB";
  }

  app.innerHTML = '<div class="center"><div class="sbox"><div class="spinner"></div>' +
    '<p class="smsg">Loading your recording…</p></div></div>';

  // Read blob from IndexedDB (no size limit, no base64 overhead)
  function idbLoad() {
    return new Promise(function(res, rej) {
      var req = indexedDB.open('recur_bg_db', 3);
      req.onupgradeneeded = function(e) {
        e.target.result.createObjectStore('recordings');
      };
      req.onsuccess = function(e) {
        var db = e.target.result;
        var tx = db.transaction('recordings', 'readonly');
        var get = tx.objectStore('recordings').get('latest');
        get.onsuccess = function() {
          db.close();
          if (get.result) res(get.result);
          else rej(new Error("No recording found"));
        };
        get.onerror = function() { db.close(); rej(get.error); };
      };
      req.onerror = function() { rej(req.error); };
    });
  }

  idbLoad().then(function(record) {
    var blob    = record.blob;
    var meta    = record.meta || {};
    var url     = URL.createObjectURL(blob);
    buildPlayer(url, meta.filename || "recur.webm", meta.duration || 0, blob.size);
  }).catch(function(err) {
    // Fallback: try session storage metadata for display, but show error for video
    app.innerHTML = '<div class="center"><div class="sbox">' +
      '<div class="sicon"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,.3)" stroke-width="1.5">' +
      '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/>' +
      '<line x1="12" y1="16" x2="12.01" y2="16"/></svg></div>' +
      '<p class="smsg">No recording found.<br>Please record something first.</p>' +
      '</div></div>';
  });

  function buildPlayer(url, fname, metaDur, fsize) {
    var dur = metaDur || 0;
    app.innerHTML =
      '<div class="page fi">' +
        '<div class="hdr">' +
          '<div class="logo"><div class="ldot"></div>' +
            '<span class="lname">Recur</span>' +
            '<span class="lsep">/ Preview</span>' +
          '</div>' +
          '<div class="hmeta">' +
            (fsize ? '<span class="mtxt" id="h-sz">' + fmtBytes(fsize) + '</span>' : '') +
            '<span class="mtxt" id="h-dur">' + fmt(metaDur || 0) + '</span>' +
            '<button class="dlbtn" id="dlbtn">' +
              '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
                '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>' +
                '<polyline points="7 10 12 15 17 10"/>' +
                '<line x1="12" y1="15" x2="12" y2="3"/>' +
              '</svg> Download' +
            '</button>' +
          '</div>' +
        '</div>' +
        '<div class="main">' +
          '<div class="vwrap">' +
            '<video id="vid" playsinline></video>' +
            '<div class="pov" id="pov">' +
              '<div class="pcircle">' + SVG_PLAY + '</div>' +
            '</div>' +
          '</div>' +
          '<div class="ctrls">' +
            '<input type="range" id="seek" min="0" max="100" step="0.1" value="0"/>' +
            '<div class="crow">' +
              '<button class="cpbtn" id="cpbtn">' + SVG_PLAY + '</button>' +
              '<span class="ttxt" id="cur">00:00</span>' +
              '<span class="tsep">/</span>' +
              '<span class="ttxt" id="total">' + fmt(metaDur || 0) + '</span>' +
              '<span class="fnm">' + fname + '</span>' +
            '</div>' +
          '</div>' +
          '<p class="hint">Recording saved locally — click Download to save</p>' +
        '</div>' +
      '</div>';

    var vid    = document.getElementById("vid");
    var seek   = document.getElementById("seek");
    var pov    = document.getElementById("pov");
    var cpbtn  = document.getElementById("cpbtn");
    var curEl  = document.getElementById("cur");
    var totalEl= document.getElementById("total");
    var dlbtn  = document.getElementById("dlbtn");
    var hDur   = document.getElementById("h-dur");

    vid.src = url;

    function setPlaying(v) {
      pov.className  = "pov" + (v ? " gone" : "");
      cpbtn.innerHTML = v ? SVG_PAUSE : SVG_PLAY;
    }
    function toggle() {
      if (vid.paused) { vid.play(); setPlaying(true); }
      else            { vid.pause(); setPlaying(false); }
    }

    vid.addEventListener("loadedmetadata", function() {
      // vid.duration is Infinity for raw WebM files - use our recorded duration instead
      var vd = vid.duration;
      dur = (vd && isFinite(vd) && vd > 0) ? vd : (metaDur || 0);
      totalEl.textContent = fmt(dur);
      if (hDur) hDur.textContent = fmt(dur);
      seek.max = dur || 100;
    });
    vid.addEventListener("timeupdate", function() {
      var t = vid.currentTime;
      curEl.textContent = fmt(t);
      seek.value = t;
      if (dur) seek.style.background =
        "linear-gradient(to right,#ff3b3b " + (t/dur*100) + "%,rgba(255,255,255,.1) " + (t/dur*100) + "%)";
    });
    vid.addEventListener("ended",  function() { setPlaying(false); vid.currentTime = 0; });
    vid.addEventListener("play",   function() { setPlaying(true); });
    vid.addEventListener("pause",  function() { setPlaying(false); });

    seek.addEventListener("input", function() {
      var t = parseFloat(seek.value);
      vid.currentTime = t;
      curEl.textContent = fmt(t);
    });
    pov.addEventListener("click",   toggle);
    cpbtn.addEventListener("click", toggle);

    dlbtn.addEventListener("click", function() {
      var a = document.createElement("a");
      a.href = url; a.download = fname; a.click();
      dlbtn.className = "dlbtn done";
      dlbtn.textContent = "Downloaded ✓";
    });
  }

  var SVG_PLAY  = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21"/></svg>';
  var SVG_PAUSE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1.5"/><rect x="14" y="4" width="4" height="16" rx="1.5"/></svg>';
})();
