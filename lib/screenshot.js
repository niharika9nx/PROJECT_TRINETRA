// Trinetra — Screenshot Capture (Phase 3)
// Utilities for capturing viewport screenshot via chrome.tabs.captureVisibleTab().
// This file is loaded via background service worker context; it also exposes
// helpers testable outside the extension.

// Capture options type: { format: 'png'|'jpeg', quality: 0-100 }
// Returns Promise<string> — data URL (Base64) like "data:image/png;base64,..."

async function captureScreenshot(options = {}) {
  const { format = 'png', quality = 92 } = options;
  // MV3 background service worker has direct chrome.tabs access
  if (typeof chrome === 'undefined' || !chrome.tabs || !chrome.tabs.captureVisibleTab) {
    throw new Error('chrome.tabs.captureVisibleTab not available — must run in extension background context');
  }

  return new Promise((resolve, reject) => {
    chrome.tabs.captureVisibleTab(
      null,
      { format, quality },
      (dataUrl) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!dataUrl || !dataUrl.startsWith('data:image/')) {
          reject(new Error('captureVisibleTab returned invalid data URL'));
          return;
        }
        resolve(dataUrl);
      }
    );
  });
}

// Helper: convert data URL to Blob (useful for upload / canvas work)
function dataUrlToBlob(dataUrl) {
  const [header, base64] = dataUrl.split(',');
  const mimeMatch = header.match(/:(.*?);/);
  const mime = mimeMatch ? mimeMatch[1] : 'image/png';
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

// Helper: validate that a string is a usable image data URL (for Phase 3 DoD check)
function isValidScreenshotDataUrl(dataUrl) {
  return typeof dataUrl === 'string' && /^data:image\/(png|jpeg|jpg);base64,[A-Za-z0-9+/=]+$/.test(dataUrl);
}

// Export for background.js and testing
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { captureScreenshot, dataUrlToBlob, isValidScreenshotDataUrl };
}
if (typeof window !== 'undefined') {
  window.TrinetraScreenshot = { captureScreenshot, dataUrlToBlob, isValidScreenshotDataUrl };
}
// Also expose globally for service worker importScripts context
if (typeof self !== 'undefined') {
  self.TrinetraScreenshot = { captureScreenshot, dataUrlToBlob, isValidScreenshotDataUrl };
}
