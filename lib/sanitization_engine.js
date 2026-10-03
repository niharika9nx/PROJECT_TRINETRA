// Trinetra — Sanitization Engine (Phase 8, Stage 3)
// Applies redaction strategies via Canvas/OffscreenCanvas and produces sanitized screenshot + AT.
// Strategies: blur (faces, photos), blackout (passwords, card numbers), mask ([REDACTED]), replace_with_placeholder
//
// IMPORTANT: Stage 1 detections only describe real pixels when a real VLM produced
// them. StubVLMProvider.detectPII returns fixed fixture coordinates unrelated to the
// actual image, so painting those would redact arbitrary parts of every screenshot.
// Detections therefore carry a `grounded` flag; canvas redaction is applied only to
// grounded regions. The AT (Stage 3) pass is regex-based and always runs.

(function () {

// Resolve pii_detector / pii_validator in both Node (require) and browser (global) contexts.
function resolveModule(globalName, relativePath, exportName) {
  if (typeof require !== 'undefined') {
    try {
      const mod = require(relativePath);
      if (mod && mod[exportName]) return mod[exportName];
    } catch (e) {}
  }
  const g = (typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null));
  if (g && g[globalName] && g[globalName][exportName]) return g[globalName][exportName];
  return null;
}

async function sanitizeScreenshot({ screenshot, redactedRegions } = {}) {
  if (!screenshot || typeof screenshot !== 'string' || !screenshot.startsWith('data:image/')) {
    return { sanitizedScreenshot: screenshot, applied: [] };
  }
  // Only paint regions the detector actually grounded in this screenshot.
  const grounded = (redactedRegions || []).filter(r => r && r.grounded !== false);

  // Browser path: use OffscreenCanvas / Canvas
  if (typeof document !== 'undefined' && typeof Image !== 'undefined') {
    return sanitizeWithCanvas(screenshot, grounded);
  }

  // Node/test fallback: no canvas available — report intent without transforming.
  const applied = grounded.map(r => ({
    bbox: r.bbox,
    type: r.type,
    strategy: r.strategy,
    confidence: r.confidence,
    applied: true
  }));
  return { sanitizedScreenshot: screenshot, applied, simulated: true };
}

function sanitizeWithCanvas(dataUrl, regions) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = typeof OffscreenCanvas !== 'undefined'
          ? new OffscreenCanvas(img.width, img.height)
          : document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);

        const applied = [];
        for (const r of (regions || [])) {
          const [x, y, w, h] = r.bbox;
          const strategy = r.strategy || 'mask';
          if (strategy === 'blackout') {
            ctx.fillStyle = '#000000';
            ctx.fillRect(x, y, w, h);
          } else if (strategy === 'blur') {
            // Simple blur: downscale then upscale region (approx)
            // Fallback to semi-transparent overlay if filter not supported
            try {
              ctx.filter = 'blur(8px)';
              ctx.drawImage(canvas, x, y, w, h, x, y, w, h);
              ctx.filter = 'none';
            } catch (e) {
              ctx.fillStyle = 'rgba(100,100,100,0.6)';
              ctx.fillRect(x, y, w, h);
            }
          } else if (strategy === 'mask' || strategy === 'replace' || strategy === 'replace_with_placeholder') {
            ctx.fillStyle = '#334155';
            ctx.fillRect(x, y, w, h);
            ctx.fillStyle = '#e2e8f0';
            ctx.font = '12px sans-serif';
            ctx.fillText('[REDACTED]', x + 4, y + h / 2);
          } else {
            ctx.fillStyle = '#000';
            ctx.fillRect(x, y, w, h);
          }
          applied.push({ bbox: r.bbox, type: r.type, strategy, confidence: r.confidence, applied: true });
        }

        let sanitizedScreenshot;
        if (canvas.convertToBlob) {
          // OffscreenCanvas path — async
          canvas.convertToBlob({ type: 'image/png' }).then(blob => {
            const reader = new FileReader();
            reader.onloadend = () => resolve({ sanitizedScreenshot: reader.result, applied });
            reader.onerror = () => resolve({ sanitizedScreenshot: dataUrl, applied, error: 'blob read failed' });
            reader.readAsDataURL(blob);
          });
        } else {
          sanitizedScreenshot = canvas.toDataURL('image/png');
          resolve({ sanitizedScreenshot, applied });
        }
      } catch (e) {
        reject(e);
      }
    };
    img.onerror = () => resolve({ sanitizedScreenshot: dataUrl, applied: [], error: 'image load failed' });
    img.src = dataUrl;
  });
}

const emailRe = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const cardRe = /\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/;
// Phone detection normalizes separators rather than matching one fixed shape:
// the old /\d{3}\d{3}\d{4}/ form missed common formats like "+91 98765 43210".
function looksLikePhone(name, node) {
  if (typeof name !== 'string' || name.length === 0) return false;
  const digits = name.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) return false;
  if (/[\s+().-]/.test(name)) return true;
  // Bare digits are only treated as a phone when they are a form field value —
  // otherwise they are just as likely to be an order id or a price.
  return node && node.role === 'textbox' && /^\+?\d+$/.test(name.trim());
}

function sanitizeAT(at = [], redactedRegions = []) {
  if (!Array.isArray(at) || at.length === 0) return { sanitizedAT: [], removedCount: 0, maskedCount: 0 };

  // Heuristic: if AT node name looks like PII (email, phone) or bounds overlaps a redacted region, mask it
  let removedCount = 0;
  let maskedCount = 0;

  const piiTypes = new Set((redactedRegions || []).map(r => r.type));

  const sanitizedAT = at.map(node => {
    const name = node.name || '';
    let shouldMask = false;
    let shouldRemove = false;

    if (emailRe.test(name)) shouldMask = true;
    if (cardRe.test(name)) shouldRemove = true;
    if (looksLikePhone(name, node)) shouldMask = true;
    if (piiTypes.has('email') && emailRe.test(name)) shouldMask = true;
    if (piiTypes.has('phone') && looksLikePhone(name, node)) shouldMask = true;
    if (piiTypes.has('credit_card') || piiTypes.has('password_field') || piiTypes.has('password')) {
      if (cardRe.test(name) || /password/i.test(name)) shouldRemove = true;
    }
    // Check bounds overlap with any redacted region
    if (node.bounds && redactedRegions.length > 0) {
      for (const r of redactedRegions) {
        // Only trust bbox overlap for detections grounded in this screenshot.
        if (r.grounded === false) continue;
        if (boundsOverlap(node.bounds, r.bbox)) {
          if (r.strategy === 'blackout') shouldRemove = true;
          else shouldMask = true;
          break;
        }
      }
    }
    // Generic name containing sensitive keywords
    if (/face|profile photo|address/i.test(name) && (piiTypes.has('face') || piiTypes.has('address') || piiTypes.has('name'))) {
      shouldMask = true;
    }

    if (shouldRemove) {
      removedCount++;
      return null; // removed
    }
    if (shouldMask) {
      maskedCount++;
      // Strip every property that could carry the raw value — notably
      // originalName, value and placeholder. Retaining any of them would ship
      // the very PII this function just claimed to redact.
      const { originalName, value, placeholder, description, title, alt, innerText, textContent, ...safe } = node;
      return { ...safe, name: '[REDACTED]', sanitized: true };
    }
    return node;
  }).filter(Boolean);

  return { sanitizedAT, removedCount, maskedCount };
}

function boundsOverlap(bounds, bbox) {
  // bounds: {x,y,width,height}, bbox: [x,y,w,h]
  if (!bounds || !bbox) return false;
  const [bx, by, bw, bh] = bbox;
  const ax1 = bounds.x, ay1 = bounds.y, ax2 = bounds.x + bounds.width, ay2 = bounds.y + bounds.height;
  const bx1 = bx, by1 = by, bx2 = bx + bw, by2 = by + bh;
  return !(ax2 < bx1 || bx2 < ax1 || ay2 < by1 || by2 < ay1);
}

// Full 3-stage pipeline: detect -> classify -> sanitize
async function runSanitizationPipeline({ screenshot, at, detector, validator } = {}) {
  // Stage 1: detect. Injected detector wins; otherwise use pii_detector.
  let detections = [];
  if (typeof detector === 'function') {
    try {
      detections = await detector({ screenshot });
    } catch (e) {
      console.warn('[Trinetra Sanitize] Stage 1 detectPII failed:', e.message);
      detections = [];
    }
  } else {
    const detectFn = resolveModule('TrinetraPIIDetector', './pii_detector.js', 'detectPII');
    if (detectFn) {
      try {
        detections = await detectFn({ screenshot });
      } catch (e) {
        console.warn('[Trinetra Sanitize] Stage 1 detectPII failed:', e.message);
        detections = [];
      }
    } else {
      console.warn('[Trinetra Sanitize] Stage 1 unavailable — no PII detector registered');
    }
  }

  // Stage 2: classify. Injected validator wins; otherwise use pii_validator.
  let classified = [];
  if (typeof validator === 'function') {
    try {
      classified = await validator(detections);
    } catch (e) {
      console.warn('[Trinetra Sanitize] Stage 2 classify failed:', e.message);
      classified = [];
    }
  } else {
    const classifyFn = resolveModule('TrinetraPIIValidator', './pii_validator.js', 'validateAndClassify');
    if (classifyFn) {
      try {
        classified = await classifyFn(detections);
      } catch (e) {
        console.warn('[Trinetra Sanitize] Stage 2 validateAndClassify failed:', e.message);
        classified = [];
      }
    } else {
      console.warn('[Trinetra Sanitize] Stage 2 unavailable — no PII validator registered');
    }
  }
  if (!Array.isArray(classified)) classified = [];

  // Stage 3: sanitize (screenshot redaction + AT redaction)
  const { sanitizedScreenshot, applied, simulated, error } = await sanitizeScreenshot({ screenshot, redactedRegions: classified });
  const { sanitizedAT, removedCount, maskedCount } = sanitizeAT(at || [], classified);

  // Detections the stub produced are not grounded in this image — do not claim
  // regions were redacted from the screenshot when nothing was painted.
  const groundedRegions = classified.filter(c => c && c.grounded !== false);

  const report = {
    redacted_regions: groundedRegions.map(c => ({
      bbox: c.bbox,
      type: c.type,
      strategy: c.strategy || 'mask',
      confidence: c.confidence
    })),
    detected_regions: classified.length,
    sanitized_at_summary: `PII nodes removed: ${removedCount}, masked: ${maskedCount}`,
    removedCount,
    maskedCount,
    timestamp: new Date().toISOString(),
    screenshot_redacted: applied.length > 0,
    screenshot_regions_detected: classified.length,
    simulated: !!simulated,
    screenshotError: error || null
  };

  return {
    sanitizedScreenshot,
    sanitizedAT,
    sanitized_at: sanitizedAT, // alias
    report,
    redacted_regions: report.redacted_regions,
    applied: applied || report.redacted_regions
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { sanitizeScreenshot, sanitizeAT, runSanitizationPipeline, boundsOverlap };
}
if (typeof window !== 'undefined') {
  // Both names exported: workflow_loop.js looks up TrinetraSanitizationEngine,
  // older callers use TrinetraSanitization.
  window.TrinetraSanitization = { sanitizeScreenshot, sanitizeAT, runSanitizationPipeline };
  window.TrinetraSanitizationEngine = window.TrinetraSanitization;
}
if (typeof self !== 'undefined') {
  self.TrinetraSanitization = { sanitizeScreenshot, sanitizeAT, runSanitizationPipeline };
  self.TrinetraSanitizationEngine = self.TrinetraSanitization;
}


})();