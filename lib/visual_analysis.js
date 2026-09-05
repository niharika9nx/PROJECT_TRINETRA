// Trinetra — Visual Analysis (Phase 5)
// Fallback / auxiliary path: wraps LocalVLMProvider.analyze().
// Only called when primary AT→LLM path signals AT is insufficient.
// Provider-agnostic — works with stub through Phases 5–12 and real provider in Phase 13.

// Default stub wiring for standalone testing; in extension, registry will inject real provider.
let vlmProvider = null;
try {
  const stub = require('./providers/stub_provider.js');
  vlmProvider = stub.StubVLMProvider;
} catch (e) {
  // In browser MV3 content script context, window.TrinetraStubProvider holds it
  if (typeof window !== 'undefined' && window.TrinetraStubProvider) {
    vlmProvider = window.TrinetraStubProvider.StubVLMProvider;
  } else if (typeof self !== 'undefined' && self.TrinetraStubProvider) {
    vlmProvider = self.TrinetraStubProvider.StubVLMProvider;
  }
}

function setVLMProvider(provider) {
  vlmProvider = provider;
}

function getVLMProvider() {
  if (!vlmProvider) throw new Error('VLM provider not set — call setVLMProvider() or ensure stub is available');
  return vlmProvider;
}

// Calls LocalVLMProvider.analyze({ screenshot }) and normalizes output
async function analyzeScreenshot({ screenshot } = {}) {
  const provider = getVLMProvider();
  if (!screenshot) {
    return { elements: [], bboxes: [], ocrText: '', labels: [], warning: 'no screenshot provided' };
  }
  const result = await provider.analyze({ screenshot });
  // Normalize: ensure required fields exist
  return {
    elements: result.elements || [],
    bboxes: result.bboxes || [],
    ocrText: result.ocrText || '',
    labels: result.labels || [],
    raw: result
  };
}

// Heuristic: determine if AT is insufficient and fallback should trigger
function shouldTriggerFallback({ at, planResult } = {}) {
  // Trigger if AT is empty, or planResult explicitly hints at needing visual context
  if (!at || at.length === 0) return true;
  if (planResult && planResult.reasoning && planResult.reasoning.toLowerCase().includes('at appears empty')) return true;
  // Also if plan confidence is very low and at is sparse
  if (at.length < 3 && planResult && planResult.confidence < 0.5) return true;
  return false;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { analyzeScreenshot, setVLMProvider, getVLMProvider, shouldTriggerFallback };
}
if (typeof window !== 'undefined') {
  window.TrinetraVisualAnalysis = { analyzeScreenshot, setVLMProvider, getVLMProvider, shouldTriggerFallback };
}
if (typeof self !== 'undefined') {
  self.TrinetraVisualAnalysis = { analyzeScreenshot, setVLMProvider, getVLMProvider, shouldTriggerFallback };
}
