// Trinetra — PII Detector (Phase 8, Stage 1)
// Calls LocalVLMProvider.detectPII(screenshot) → [{ bbox, type, confidence }]

let vlmProvider = null;
try {
  const stub = require('./providers/stub_provider.js');
  vlmProvider = stub.StubVLMProvider;
} catch (e) {
  if (typeof window !== 'undefined' && window.TrinetraStubProvider) vlmProvider = window.TrinetraStubProvider.StubVLMProvider;
  else if (typeof self !== 'undefined' && self.TrinetraStubProvider) vlmProvider = self.TrinetraStubProvider.StubVLMProvider;
}

function setVLMProvider(p) { vlmProvider = p; }
function getVLMProvider() {
  if (!vlmProvider) throw new Error('VLM provider not set for PII detection');
  return vlmProvider;
}

// Stage 1: Visual Detection
async function detectPII({ screenshot } = {}) {
  const provider = getVLMProvider();
  const detections = await provider.detectPII(screenshot);
  // Normalize: ensure bbox is [x,y,w,h] numbers, type string, confidence 0-1
  return (detections || []).map(d => ({
    bbox: Array.isArray(d.bbox) ? d.bbox.map(Number) : [0,0,0,0],
    type: String(d.type || 'unknown'),
    confidence: typeof d.confidence === 'number' ? d.confidence : 0.9
  }));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { detectPII, setVLMProvider, getVLMProvider };
}
if (typeof window !== 'undefined') {
  window.TrinetraPIIDetector = { detectPII, setVLMProvider, getVLMProvider };
}
if (typeof self !== 'undefined') {
  self.TrinetraPIIDetector = { detectPII, setVLMProvider, getVLMProvider };
}
