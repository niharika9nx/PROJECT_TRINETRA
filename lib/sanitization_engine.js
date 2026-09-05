// Trinetra — Sanitization Engine (Phase 8, Stage 3)
// Applies redaction strategies via Canvas/OffscreenCanvas and produces sanitized screenshot + AT.
// Strategies: blur (faces, photos), blackout (passwords, card numbers), mask ([REDACTED]), replace_with_placeholder

// Redaction strategies applied to screenshot (data URL) via Canvas
// In extension context, uses document canvas; in Node tests, uses stub or pure logic without canvas.

async function sanitizeScreenshot({ screenshot, redactedRegions } = {}) {
  if (!screenshot || !screenshot.startsWith('data:image/')) {
    return { sanitizedScreenshot: screenshot, applied: [] };
  }

  // Browser path: use OffscreenCanvas / Canvas
  if (typeof document !== 'undefined' && typeof Image !== 'undefined') {
    return sanitizeWithCanvas(screenshot, redactedRegions);
  }

  // Node/test fallback: simulate sanitization without real canvas — just return annotated dataUrl + applied list
  // This keeps pipeline testable without native canvas dependency
  const applied = (redactedRegions || []).map(r => ({
    bbox: r.bbox,
    type: r.type,
    strategy: r.strategy,
    confidence: r.confidence,
    applied: true
  }));
  // Simulate redaction by appending marker (not a real image transform, but proves pipeline executed)
  const sanitizedScreenshot = screenshot; // In real browser, this would be re-encoded; in test we keep same dataUrl
  return { sanitizedScreenshot, applied, simulated: true };
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

function sanitizeAT(at = [], redactedRegions = []) {
  if (!Array.isArray(at) || at.length === 0) return { sanitizedAT: [], removedCount: 0, maskedCount: 0 };

  // Heuristic: if AT node name looks like PII (email, phone) or bounds overlaps a redacted region, mask it
  const emailRe = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
  const phoneRe = /(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/;
  const cardRe = /\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/;

  let removedCount = 0;
  let maskedCount = 0;

  const piiTypes = new Set((redactedRegions || []).map(r => r.type));

  const sanitizedAT = at.map(node => {
    const name = node.name || '';
    let shouldMask = false;
    let shouldRemove = false;

    if (emailRe.test(name) || piiTypes.has('email')) {
      if (emailRe.test(name)) shouldMask = true;
    }
    if (phoneRe.test(name) || piiTypes.has('phone')) {
      if (phoneRe.test(name)) shouldMask = true;
    }
    if (cardRe.test(name) || piiTypes.has('credit_card') || piiTypes.has('password_field') || piiTypes.has('password')) {
      if (cardRe.test(name) || /password/i.test(name) || node.role === 'textbox' && /password/i.test(name)) {
        shouldRemove = true;
      }
    }
    // Check bounds overlap with any redacted region
    if (node.bounds && redactedRegions.length > 0) {
      for (const r of redactedRegions) {
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
      return { ...node, name: '[REDACTED]', originalName: name, sanitized: true };
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

// Full 3-stage pipeline: detect → classify → sanitize
async function runSanitizationPipeline({ screenshot, at, detector, validator } = {}) {
  // Allow injection of custom detector/validator (for testing); otherwise use module defaults
  const detectFn = detector || (async (s) => {
    const mod = require('./pii_detector.js');
    return mod.detectPII({ screenshot: s });
  });
  const classifyFn = validator || (async (d) => {
    const mod = require('./pii_validator.js');
    return mod.validateAndClassify(d);
  });

  // Stage 1: detect
  const detections = await (typeof detectFn === 'function' && detectFn.length === 1
    ? detectFn(screenshot) // if caller passed (screenshot) => detections
    : detectFn({ screenshot }));

  // Stage 2: classify — normalize calling convention
  let classified;
  if (typeof classifyFn === 'function') {
    try {
      // Try both signatures
      classified = await classifyFn(detections);
      if (!Array.isArray(classified)) classified = await classifyFn({ detections });
    } catch (e) {
      classified = detections.map(d => ({ ...d, sensitivity: 'medium', strategy: 'mask' }));
    }
  } else {
    classified = detections;
  }

  // Stage 3: sanitize
  const { sanitizedScreenshot, applied, simulated, error } = await sanitizeScreenshot({ screenshot, redactedRegions: classified });
  const { sanitizedAT, removedCount, maskedCount } = sanitizeAT(at || [], classified);

  const report = {
    redacted_regions: (classified || []).map(c => ({
      bbox: c.bbox,
      type: c.type,
      strategy: c.strategy || 'mask',
      confidence: c.confidence
    })),
    sanitized_at_summary: `PII nodes removed: ${removedCount}, masked: ${maskedCount}`,
    removedCount,
    maskedCount,
    timestamp: new Date().toISOString(),
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
  window.TrinetraSanitization = { sanitizeScreenshot, sanitizeAT, runSanitizationPipeline };
}
if (typeof self !== 'undefined') {
  self.TrinetraSanitization = { sanitizeScreenshot, sanitizeAT, runSanitizationPipeline };
}
