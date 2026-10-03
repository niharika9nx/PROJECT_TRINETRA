// Trinetra — background service worker (Phases 3, 9, 11)
// Orchestration, screenshot capture, server communication.

// --- Screenshot helpers (mirrors lib/screenshot.js for service worker context) ---
async function captureScreenshot(options = {}) {
  const { format = 'png', quality = 92 } = options;
  return new Promise((resolve, reject) => {
    chrome.tabs.captureVisibleTab(null, { format, quality }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!dataUrl || !dataUrl.startsWith('data:image/')) {
        reject(new Error('captureVisibleTab returned invalid data URL'));
        return;
      }
      resolve(dataUrl);
    });
  });
}

function isValidScreenshotDataUrl(dataUrl) {
  return typeof dataUrl === 'string' && /^data:image\/(png|jpeg|jpg);base64,[A-Za-z0-9+/=]+$/.test(dataUrl);
}

// Must stay in sync with the manifest.json content_scripts list.
const CONTENT_SCRIPT_BUNDLE = [
  'lib/providers/model_provider_interface.js',
  'lib/providers/stub_provider.js',
  'lib/pii_detector.js',
  'lib/pii_validator.js',
  'lib/sanitization_engine.js',
  'lib/local_reasoning.js',
  'lib/products.js',
  'lib/workflow_loop.js',
  'content_script.js'
];

// --- Icon click → toggle content script panel ---
chrome.action.onClicked.addListener((tab) => {
  if (!tab || !tab.id) return;
  // chrome://, edge://, extension pages cannot be injected
  if (tab.url && (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('edge://') || tab.url.startsWith('about:'))) {
    return;
  }
  chrome.tabs.sendMessage(tab.id, { type: 'TRINETRA_TOGGLE_PANEL' }).catch(() => {
    chrome.scripting.executeScript({ target: { tabId: tab.id }, files: CONTENT_SCRIPT_BUNDLE }).then(() => {
      setTimeout(() => chrome.tabs.sendMessage(tab.id, { type: 'TRINETRA_TOGGLE_PANEL' }), 300);
    }).catch(() => {});
  });
});

// --- Message router ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return;

  // Resolve the tab to act on. Prefer the sender's own tab so a stale panel
  // cannot steer whichever tab the user happens to have focused; fall back to
  // the active tab for messages from the extension's own pages.
  const resolveTab = (callback) => {
    if (sender && sender.tab && sender.tab.id) return callback(sender.tab);
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || !tabs[0]) return callback(null);
      callback(tabs[0]);
    });
  };

  const isRestrictedPage = (tab) => !!(tab && tab.url && (
    tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') ||
    tab.url.startsWith('edge://') || tab.url.startsWith('about:')
  ));

  // Phase 3: screenshot capture requested by panel/content
  if (message.type === 'TRINETRA_CAPTURE_SCREENSHOT') {
    captureScreenshot(message.options || {})
      .then((dataUrl) => {
        sendResponse({ success: true, dataUrl, valid: isValidScreenshotDataUrl(dataUrl) });
      })
      .catch((err) => {
        sendResponse({ success: false, error: err.message });
      });
    return true; // async response
  }

  // Utility: extract AT via content script (Phase 2 bridge through background) — with auto-inject retry for new tabs/other e-commerce
  if (message.type === 'TRINETRA_REQUEST_AT') {
    resolveTab(async (tab) => {
      if (!tab) {
        sendResponse({ success: false, error: 'No active tab' });
        return;
      }
      // chrome:// and extension pages cannot be injected — give clear message
      if (isRestrictedPage(tab)) {
        sendResponse({ success: false, error: `Cannot run Trinetra on ${tab.url.split(':')[0]}:// pages — this is the Chrome New Tab page. Open a https:// e-commerce website instead.` });
        return;
      }
      const trySend = () => new Promise((resolve) => {
        chrome.tabs.sendMessage(tab.id, { type: 'TRINETRA_EXTRACT_AT', options: message.options || {} }, (res) => {
          if (chrome.runtime.lastError) resolve({ _lastError: chrome.runtime.lastError.message });
          else resolve(res);
        });
      });
      let res = await trySend();
      if (res && res._lastError && res._lastError.includes('Receiving end does not exist')) {
        console.warn('[Trinetra] AT no receiver, injecting bundle', tab.id);
        try {
          await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: CONTENT_SCRIPT_BUNDLE });
          await new Promise(r => setTimeout(r, 400));
          res = await trySend();
          if (res && res._lastError) {
            sendResponse({ success: false, error: `AT still failed after inject: ${res._lastError} — reload the tab (F5)` });
            return;
          }
        } catch (e) {
          sendResponse({ success: false, error: `AT inject failed: ${e.message} — reload the tab. Original: ${res._lastError}` });
          return;
        }
      } else if (res && res._lastError) {
        sendResponse({ success: false, error: res._lastError + ' — reload the tab after reloading extension' });
        return;
      }
      sendResponse(res);
    });
    return true;
  }

  // Phase 11: cloud escalation proxy — background does fetch to avoid CORS in content script
  if (message.type === 'TRINETRA_CLOUD_ACT') {
    const payload = message.payload || {};
    const serverUrl = message.serverUrl || 'http://localhost:3001/api/agent/act';
    fetch(serverUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(async (res) => {
        const json = await res.json().catch(() => ({ success: false, error: 'Invalid JSON from server' }));
        if (!res.ok) {
          sendResponse({ success: false, error: `Server ${res.status}`, details: json });
        } else {
          sendResponse({ success: true, result: json });
        }
      })
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // Phase 11: execute plan via content script — with same auto-inject retry
  if (message.type === 'TRINETRA_EXECUTE_PLAN_BG') {
    resolveTab(async (tab) => {
      if (!tab) {
        sendResponse({ success: false, error: 'No active tab for execution' });
        return;
      }
      if (isRestrictedPage(tab)) {
        sendResponse({ success: false, error: `Cannot execute on ${tab.url.split(':')[0]}:// pages` });
        return;
      }
      const tryExec = () => new Promise((resolve) => {
        chrome.tabs.sendMessage(tab.id, { type: 'TRINETRA_EXECUTE_PLAN', plan: message.plan, at: message.at || [] }, (res) => {
          if (chrome.runtime.lastError) resolve({ _lastError: chrome.runtime.lastError.message });
          else resolve(res);
        });
      });
      let res = await tryExec();
      if (res && res._lastError && res._lastError.includes('Receiving end does not exist')) {
        console.warn('[Trinetra] Execute no receiver, injecting bundle', tab.id);
        try {
          await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: CONTENT_SCRIPT_BUNDLE });
          await new Promise(r => setTimeout(r, 400));
          res = await tryExec();
          if (res && res._lastError) {
            sendResponse({ success: false, error: `Execute still failed after inject: ${res._lastError} — reload tab` });
            return;
          }
        } catch (e) {
          sendResponse({ success: false, error: `Execute inject failed: ${e.message}` });
          return;
        }
      } else if (res && res._lastError) {
        sendResponse({ success: false, error: res._lastError });
        return;
      }
      sendResponse(res);
    });
    return true;
  }

  // Navigation via background (avoids CSP javascript: URL block in content script)
  if (message.type === 'TRINETRA_NAVIGATE') {
    const url = message.url;
    // Reject protocol-relative "//evil.com" as well as javascript:/data: —
    // startsWith('http') alone would let the former through.
    if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      sendResponse({ success: false, error: 'Navigate requires an absolute http(s) URL — javascript:, data: and protocol-relative URLs are blocked' });
      return true;
    }
    resolveTab((tab) => {
      if (!tab) {
        sendResponse({ success: false, error: 'No active tab for navigate' });
        return;
      }
      if (isRestrictedPage(tab)) {
        sendResponse({ success: false, error: `Cannot navigate ${tab.url.split(':')[0]}:// pages` });
        return;
      }
      chrome.tabs.update(tab.id, { url }, () => {
        if (chrome.runtime.lastError) sendResponse({ success: false, error: chrome.runtime.lastError.message });
        else sendResponse({ success: true });
      });
    });
    return true;
  }

  // Auto-reload tab after stalled iterations (get fresh AT)
  if (message.type === 'TRINETRA_RELOAD_TAB') {
    resolveTab((tab) => {
      if (!tab) {
        sendResponse({ success: false, error: 'No active tab to reload' });
        return;
      }
      if (isRestrictedPage(tab)) {
        sendResponse({ success: false, error: `Cannot reload ${tab.url.split(':')[0]}:// pages` });
        return;
      }
      chrome.tabs.reload(tab.id, () => {
        if (chrome.runtime.lastError) sendResponse({ success: false, error: chrome.runtime.lastError.message });
        else sendResponse({ success: true });
      });
    });
    return true;
  }
});

console.log('[Trinetra] background service worker loaded — screenshot + message router ready');
