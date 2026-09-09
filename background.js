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

  // Utility: extract AT via content script (Phase 2 bridge through background) — with auto-inject retry for new tabs/other e-commerce
  if (message.type === 'TRINETRA_REQUEST_AT') {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      if (!tabs || !tabs[0]) {
        sendResponse({ success: false, error: 'No active tab' });
        return;
      }
      const tab = tabs[0];
      // chrome:// and extension pages cannot be injected — give clear message
      if (tab.url && (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('edge://') || tab.url.startsWith('about:'))) {
        sendResponse({ success: false, error: `Cannot run on ${tab.url.split(':')[0]}:// pages — open a https:// e-commerce page` });
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
        console.warn('[Trinetra] AT no receiver, injecting content_script.js', tab.id);
        try {
          await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content_script.js'] });
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
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      if (!tabs || !tabs[0]) {
        sendResponse({ success: false, error: 'No active tab for execution' });
        return;
      }
      const tab = tabs[0];
      if (tab.url && (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://'))) {
        sendResponse({ success: false, error: `Cannot execute on ${tab.url.split(':')[0]}:// pages` });
        return;
      }
      const tryExec = () => new Promise((resolve) => {
        chrome.tabs.sendMessage(tab.id, { type: 'TRINETRA_EXECUTE_PLAN', plan: message.plan }, (res) => {
          if (chrome.runtime.lastError) resolve({ _lastError: chrome.runtime.lastError.message });
          else resolve(res);
        });
      });
      let res = await tryExec();
      if (res && res._lastError && res._lastError.includes('Receiving end does not exist')) {
        console.warn('[Trinetra] Execute no receiver, injecting', tab.id);
        try {
          await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content_script.js'] });
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
    if (!url || typeof url !== 'string' || !url.startsWith('http')) {
      sendResponse({ success: false, error: 'Navigate requires http(s) URL — javascript: blocked by CSP' });
      return true;
    }
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || !tabs[0]) {
        sendResponse({ success: false, error: 'No active tab for navigate' });
        return;
      }
      chrome.tabs.update(tabs[0].id, { url }, () => {
        if (chrome.runtime.lastError) sendResponse({ success: false, error: chrome.runtime.lastError.message });
        else sendResponse({ success: true });
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
