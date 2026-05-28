// background.js — Recur v19
// Writes each chunk to IDB immediately — survives SW restarts

var IDB_NAME  = 'recur_bg_db';
var IDB_STORE = 'recordings';

function idbOpen() {
  return new Promise(function(res, rej) {
    var req = indexedDB.open(IDB_NAME, 3);
    req.onupgradeneeded = function(e) {
      var db = e.target.result;
      // Only create if doesn't exist — never delete (would wipe recordings)
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = function(e) { res(e.target.result); };
    req.onerror   = function()  { rej(req.error); };
  });
}

function idbPut(key, value) {
  return idbOpen().then(function(db) {
    return new Promise(function(res, rej) {
      var tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(value, key);
      tx.oncomplete = function() { db.close(); res(); };
      tx.onerror    = function() { db.close(); rej(tx.error); };
    });
  });
}

function idbGet(key) {
  return idbOpen().then(function(db) {
    return new Promise(function(res, rej) {
      var tx  = db.transaction(IDB_STORE, 'readonly');
      var req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = function() { db.close(); res(req.result); };
      req.onerror   = function() { db.close(); rej(req.error); };
    });
  });
}

function idbGetAllKeys() {
  return idbOpen().then(function(db) {
    return new Promise(function(res, rej) {
      var tx  = db.transaction(IDB_STORE, 'readonly');
      var req = tx.objectStore(IDB_STORE).getAllKeys();
      req.onsuccess = function() { db.close(); res(req.result); };
      req.onerror   = function() { db.close(); rej(req.error); };
    });
  });
}

function idbDeleteChunks() {
  return idbOpen().then(function(db) {
    return new Promise(function(res, rej) {
      var tx  = db.transaction(IDB_STORE, 'readwrite');
      var req = tx.objectStore(IDB_STORE).getAllKeys();
      req.onsuccess = function() {
        var keys = req.result.filter(function(k) { return String(k).startsWith('chunk_'); });
        keys.forEach(function(k) { tx.objectStore(IDB_STORE).delete(k); });
        tx.oncomplete = function() { db.close(); res(); };
      };
      req.onerror = function() { db.close(); rej(req.error); };
    });
  });
}

var activeTabId   = null;
var expectedMime  = 'video/webm';
var chunkCount    = 0;

chrome.runtime.onMessage.addListener(function(msg, sender, reply) {
  var tabId = sender.tab ? sender.tab.id : null;

  // ── Keepalive ping — prevents SW from being killed during recording ────
  if (msg.type === "PING") {
    reply({ ok: true, ts: Date.now() });
    return true;
  }

  // ── New recording starting — clear old chunk data ─────────────────────
  if (msg.type === "RECORDING_STARTED") {
    activeTabId  = tabId || activeTabId;
    chunkCount   = 0;
    expectedMime = 'video/webm';
    // Clear any leftover chunks from previous recording
    idbDeleteChunks().catch(function(){});
    reply({ ok: true });
    return true;
  }

  // ── Receive chunk — write to IDB immediately (survives SW restart) ─────
  if (msg.type === "RECORDING_CHUNK") {
    if (msg.data && msg.data.length > 0) {
      var uint8 = new Uint8Array(msg.data);
      idbPut('chunk_' + String(msg.index).padStart(8, '0'), uint8)
        .catch(function(e) { console.error('[Recur BG] chunk IDB write failed:', e); });
      chunkCount++;
    }
    reply({ ok: true });
    return true;
  }

  // ── Recording complete — assemble all chunks into final blob ───────────
  if (msg.type === "RECORDING_COMPLETE") {
    activeTabId  = null;
    var mime     = msg.mimeType || 'video/webm';
    var duration = msg.duration || 0;
    var filename = msg.filename || 'recur.webm';

    // Read all chunk keys, sort, assemble blob
    idbGetAllKeys().then(function(keys) {
      var chunkKeys = keys
        .filter(function(k) { return String(k).startsWith('chunk_'); })
        .sort();

      if (chunkKeys.length === 0) {
        console.error('[Recur BG] No chunks found in IDB');
        chrome.tabs.create({ url: chrome.runtime.getURL('preview.html'), active: true });
        return;
      }

      // Read all chunks in order
      return idbOpen().then(function(db) {
        return new Promise(function(res, rej) {
          var parts = [];
          var i = 0;
          function next() {
            if (i >= chunkKeys.length) { db.close(); res(parts); return; }
            var req = db.transaction(IDB_STORE, 'readonly')
                        .objectStore(IDB_STORE).get(chunkKeys[i++]);
            req.onsuccess = function() {
              if (req.result) parts.push(req.result);
              next();
            };
            req.onerror = function() { next(); }; // skip failed chunks
          }
          next();
        });
      }).then(function(parts) {
        var blob = new Blob(parts, { type: mime });

        return idbPut('latest', {
          blob:     blob,
          mimeType: mime,
          duration: duration,
          filename: filename,
          savedAt:  Date.now()
        });
      }).then(function() {
        // Clean up chunk entries
        return idbDeleteChunks();
      }).then(function() {
        chrome.tabs.create({ url: chrome.runtime.getURL('preview.html'), active: true });
      });
    }).catch(function(err) {
      console.error('[Recur BG] assembly failed:', err);
      chrome.tabs.create({ url: chrome.runtime.getURL('preview.html'), active: true });
    });

    reply({ ok: true });
    return true;
  }

  reply({ ok: false });
  return true;
});

chrome.tabs.onRemoved.addListener(function(tid) {
  if (tid === activeTabId) activeTabId = null;
});
