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

// --- Message router ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return;

  // Phase 3: screenshot capture requested by popup/content
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

  // Utility: extract AT via content script (Phase 2 bridge through background)
  if (message.type === 'TRINETRA_REQUEST_AT') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || !tabs[0]) {
        sendResponse({ success: false, error: 'No active tab' });
        return;
      }
      chrome.tabs.sendMessage(tabs[0].id, { type: 'TRINETRA_EXTRACT_AT', options: message.options || {} }, (res) => {
        if (chrome.runtime.lastError) {
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
          return;
        }
        sendResponse(res);
      });
    });
    return true;
  }

  // Phase 11: cloud escalation proxy — background does fetch to avoid CORS in content script
  if (message.type === 'TRINETRA_CLOUD_ACT') {
    const payload = message.payload || {};
    const serverUrl = message.serverUrl || 'http://localhost:3000/api/agent/act';
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

  // Phase 11: execute plan via content script
  if (message.type === 'TRINETRA_EXECUTE_PLAN_BG') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || !tabs[0]) {
        sendResponse({ success: false, error: 'No active tab for execution' });
        return;
      }
      chrome.tabs.sendMessage(tabs[0].id, { type: 'TRINETRA_EXECUTE_PLAN', plan: message.plan }, (res) => {
        if (chrome.runtime.lastError) {
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
          return;
        }
        sendResponse(res);
      });
    });
    return true;
  }

  // Ping
  if (message.type === 'TRINETRA_BG_PING') {
    sendResponse({ success: true, message: 'Trinetra background ready', version: '0.1.0' });
    return true;
  }
});

console.log('[Trinetra] background service worker loaded — screenshot + message router ready (Phase 3)');
