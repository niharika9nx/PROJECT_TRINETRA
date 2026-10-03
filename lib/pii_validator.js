// Trinetra — PII Validator (Phase 8, Stage 2)
// Calls LocalLLMProvider.classifyPII(detections) → enriched [{ bbox, type, confidence, sensitivity, strategy }]

(function () {

// Named piiLlmProvider, not llmProvider: every file in the manifest
// content_scripts array is loaded as a classic script into one shared realm,
// where a duplicate top-level `let` is a SyntaxError. local_reasoning.js also
// declares `llmProvider` at top level.
let piiLlmProvider = null;
if (typeof require !== 'undefined') {
  try {
    const stub = require('./providers/stub_provider.js');
    piiLlmProvider = stub.StubLLMProvider;
  } catch (e) {}
}
if (!piiLlmProvider) {
  if (typeof window !== 'undefined' && window.TrinetraStubProvider) piiLlmProvider = window.TrinetraStubProvider.StubLLMProvider;
  else if (typeof self !== 'undefined' && self.TrinetraStubProvider) piiLlmProvider = self.TrinetraStubProvider.StubLLMProvider;
}

function setLLMProvider(p) { piiLlmProvider = p; }
function getLLMProvider() {
  if (!piiLlmProvider) throw new Error('LLM provider not set for PII validation');
  return piiLlmProvider;
}

// Stage 2: Validation & Classification
async function validateAndClassify(detections = []) {
  const provider = getLLMProvider();
  const classified = await provider.classifyPII(detections);
  // Ensure each has sensitivity, strategy — and preserve `grounded` so the
  // engine knows whether a region is safe to paint onto the screenshot.
  return (classified || []).map(c => ({
    bbox: c.bbox,
    type: c.type,
    confidence: c.confidence,
    sensitivity: c.sensitivity || 'medium',
    strategy: c.strategy || 'mask', // blur | blackout | mask | replace
    grounded: c.grounded !== false
  }));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { validateAndClassify, setLLMProvider, getLLMProvider };
}
if (typeof window !== 'undefined') {
  window.TrinetraPIIValidator = { validateAndClassify, setLLMProvider, getLLMProvider };
}
if (typeof self !== 'undefined') {
  self.TrinetraPIIValidator = { validateAndClassify, setLLMProvider, getLLMProvider };
}


})();