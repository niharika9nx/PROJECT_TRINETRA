// Trinetra — PII Validator (Phase 8, Stage 2)
// Calls LocalLLMProvider.classifyPII(detections) → enriched [{ bbox, type, confidence, sensitivity, strategy }]

let llmProvider = null;
if (typeof require !== 'undefined') {
  try {
    const stub = require('./providers/stub_provider.js');
    llmProvider = stub.StubLLMProvider;
  } catch (e) {}
}
if (!llmProvider) {
  if (typeof window !== 'undefined' && window.TrinetraStubProvider) llmProvider = window.TrinetraStubProvider.StubLLMProvider;
  else if (typeof self !== 'undefined' && self.TrinetraStubProvider) llmProvider = self.TrinetraStubProvider.StubLLMProvider;
}

function setLLMProvider(p) { llmProvider = p; }
function getLLMProvider() {
  if (!llmProvider) throw new Error('LLM provider not set for PII validation');
  return llmProvider;
}

// Stage 2: Validation & Classification
async function validateAndClassify(detections = []) {
  const provider = getLLMProvider();
  const classified = await provider.classifyPII(detections);
  // Ensure each has sensitivity and strategy
  return (classified || []).map(c => ({
    bbox: c.bbox,
    type: c.type,
    confidence: c.confidence,
    sensitivity: c.sensitivity || 'medium',
    strategy: c.strategy || 'mask' // blur | blackout | mask | replace
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
