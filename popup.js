(async function() {
  var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  var tab = tabs[0];
  if (!tab || !tab.id) { window.close(); return; }
  var bad = ["chrome://", "chrome-extension://", "about:", "edge://", "data:", "file://"];
  if (!tab.url || bad.some(function(p) { return tab.url.startsWith(p); })) {
    window.close(); return;
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
  } catch(_) {}
  window.close();
})();
