// Trinetra — sanitization pipeline tests
//
// Covers the project's central privacy claim: PII must not leave the device.
// Also guards the "grounded detection" gate — StubVLMProvider returns fixed
// coordinates that match nothing in a real screenshot, so painting them would
// redact arbitrary regions of every captured page.

const assert = require('assert');
const path = require('path');

const LIB = path.join(__dirname, '..', 'lib');
const {
  runSanitizationPipeline,
  sanitizeAT,
} = require(path.join(LIB, 'sanitization_engine.js'));
const { detectPII } = require(path.join(LIB, 'pii_detector.js'));
const { validateAndClassify } = require(path.join(LIB, 'pii_validator.js'));

const at = [
  { id: 'n1', role: 'textbox', name: 'Email', tag: 'input' },
  { id: 'n2', role: 'textbox', name: 'john.doe@example.com', tag: 'input' },
  { id: 'n3', role: 'textbox', name: '+91 98765 43210', tag: 'input' },
  { id: 'n4', role: 'textbox', name: '98765 43210', tag: 'input' },
  { id: 'n5', role: 'textbox', name: '4111 1111 1111 1111', tag: 'input' },
  { id: 'n6', role: 'button', name: 'Search laptops', tag: 'button' },
  { id: 'n7', role: 'link', name: 'Laptop under 1 lakh', tag: 'a' },
  { id: 'n8', role: 'text', name: 'Rs 59,999', tag: 'span' },
  { id: 'n9', role: 'text', name: 'Order 403-1234567-1234567', tag: 'span' },
];

const dump = (nodes) => JSON.stringify(nodes);

(async () => {
  // --- 1. PII never survives in the serialized payload ---
  {
    const r = await runSanitizationPipeline({ screenshot: null, at });
    const out = dump(r.sanitizedAT);

    assert.ok(!out.includes('john.doe@example.com'), 'email is not present in sanitized AT');
    assert.ok(!out.includes('98765 43210'), 'phone number is not present in sanitized AT');
    assert.ok(!out.includes('4111 1111 1111 1111'), 'card number is not present in sanitized AT');
    assert.ok(!/"originalName"/.test(out), 'masked nodes must not retain originalName');
  }

  // --- 2. Utility is preserved: the agent still needs names, prices, ids ---
  {
    const r = await runSanitizationPipeline({ screenshot: null, at });
    const out = dump(r.sanitizedAT);
    assert.ok(out.includes('Laptop under 1 lakh'), 'product name survives');
    assert.ok(out.includes('Rs 59,999'), 'price survives (needed to find "cheapest")');
    assert.ok(out.includes('Order 403-1234567-1234567'), 'order id survives');
    assert.ok(out.includes('Search laptops'), 'search box label survives');
  }

  // --- 3. Credit card is removed outright, not merely masked ---
  {
    const r = await runSanitizationPipeline({ screenshot: null, at });
    assert.ok(!r.sanitizedAT.some(n => n.id === 'n5'), 'card node is removed');
  }

  // --- 4. Report shape matches the Sanitization Report contract ---
  {
    const r = await runSanitizationPipeline({ screenshot: null, at });
    const rep = r.report;
    assert.ok(Array.isArray(rep.redacted_regions), 'redacted_regions is an array');
    assert.ok(typeof rep.sanitized_at_summary === 'string' && rep.sanitized_at_summary.length > 0, 'has a summary');
    assert.ok(typeof rep.timestamp === 'string' && !isNaN(Date.parse(rep.timestamp)), 'timestamp is ISO8601');
    assert.strictEqual(typeof rep.removedCount, 'number', 'removedCount is numeric');
    assert.strictEqual(typeof rep.maskedCount, 'number', 'maskedCount is numeric');
    for (const reg of rep.redacted_regions) {
      assert.ok(Array.isArray(reg.bbox) && reg.bbox.length === 4, 'region bbox is [x,y,w,h]');
      assert.ok(typeof reg.type === 'string', 'region has a type');
      assert.ok(typeof reg.strategy === 'string', 'region has a strategy');
      assert.ok(typeof reg.confidence === 'number', 'region has a numeric confidence');
    }
  }

  // --- 5. Stub detections are ungrounded and must not be painted ---
  {
    const detections = await detectPII({ screenshot: null });
    assert.ok(detections.length > 0, 'stub still returns fixture detections');
    assert.ok(detections.every(d => d.grounded === false), 'stub detections are marked ungrounded');

    const classified = await validateAndClassify(detections);
    assert.ok(classified.every(d => d.grounded === false), 'the grounded flag survives Stage 2');

    const r = await runSanitizationPipeline({ screenshot: 'data:image/png;base64,AAAA', at: [] });
    assert.strictEqual(r.report.screenshot_redacted, false, 'nothing is painted for ungrounded detections');
    assert.strictEqual(r.report.redacted_regions.length, 0, 'no regions are claimed as redacted');
    assert.strictEqual(r.report.screenshot_regions_detected, detections.length, 'detections are still reported honestly');
  }

  // --- 6. Grounded detections ARE honoured (the real Phase 13 path) ---
  {
    const grounded = [{ bbox: [0, 0, 100, 40], type: 'face', confidence: 0.9, grounded: true, strategy: 'blur' }];
    const r = await runSanitizationPipeline({
      screenshot: 'data:image/png;base64,AAAA',
      at: [],
      detector: async () => grounded,
    });
    assert.strictEqual(r.report.screenshot_redacted, true, 'grounded regions are applied');
    assert.strictEqual(r.report.redacted_regions.length, 1, 'grounded region is reported as redacted');
  }

  // --- 7. sanitizeAT honours bbox overlap for grounded regions ---
  {
    // Neutral names so only bbox overlap can trigger masking — name-based
    // PII keywords are a separate, always-safe heuristic.
    const nodes = [
      { id: 'x1', role: 'text', name: 'Status', bounds: { x: 10, y: 10, width: 50, height: 50 } },
      { id: 'x2', role: 'text', name: 'Elsewhere', bounds: { x: 500, y: 500, width: 50, height: 50 } },
    ];
    const hit = sanitizeAT(nodes, [{ bbox: [0, 0, 100, 100], type: 'face', strategy: 'mask', confidence: 0.9, grounded: true }]);
    assert.strictEqual(hit.maskedCount, 1, 'overlapping grounded region masks the node');
    assert.ok(hit.sanitizedAT.some(n => n.name === '[REDACTED]'), 'overlapping node is masked');
    assert.ok(hit.sanitizedAT.some(n => n.name === 'Elsewhere'), 'non-overlapping node is untouched');

    // Same bbox but ungrounded (stub fixture) must not mask.
    const miss = sanitizeAT(nodes, [{ bbox: [0, 0, 100, 100], type: 'face', strategy: 'mask', confidence: 0.9, grounded: false }]);
    assert.strictEqual(miss.maskedCount, 0, 'ungrounded bbox does not mask');
  }

  // --- 8. Non-array / empty input is handled without throwing ---
  {
    const r = await runSanitizationPipeline({ screenshot: null, at: [] });
    assert.deepStrictEqual(r.sanitizedAT, [], 'empty AT yields empty output');
    const r2 = await runSanitizationPipeline({});
    assert.ok(Array.isArray(r2.sanitizedAT), 'missing AT is tolerated');
  }

  // --- 9. A failing detector must not leak the raw AT ---
  {
    const r = await runSanitizationPipeline({
      screenshot: null,
      at,
      detector: async () => { throw new Error('detector exploded'); },
    });
    assert.ok(Array.isArray(r.sanitizedAT), 'output is still an array');
    // Stage 3's AT pass still runs, so PII is still stripped.
    assert.ok(!dump(r.sanitizedAT).includes('john.doe@example.com'), 'email still stripped when detection fails');
  }

  console.log('test_sanitize: all passed');
})().catch((e) => {
  console.error('test_sanitize FAILED:', e);
  process.exit(1);
});
