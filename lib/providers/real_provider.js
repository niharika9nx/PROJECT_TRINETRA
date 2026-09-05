// Trinetra — Real Provider (Phase 13 placeholder)
// Wraps chosen client-side AI runtime (WebGPU-accelerated ONNX Runtime Web vs Transformers.js)
// Implements SAME interface as StubProvider so no other file changes.
// Currently delegates to stub until runtime + weights are evaluated and dropped into local_models/.
//
// To activate: implement RealLLMProvider / RealVLMProvider below and set MODEL_BACKEND=real.
// See plan.md Phase 13 DoD for required re-tests.

let RealLLMProvider = null;
let RealVLMProvider = null;

// Placeholder — will be replaced with actual ONNX Runtime Web / Transformers.js implementation.
// Example shape (do not enable until weights are available):
// RealLLMProvider = {
//   async plan({ at, userGoal, visualContext }) {
//     // Load quantized LLM via ONNX Runtime Web or Transformers.js, run inference, return Action Plan JSON
//     throw new Error('RealProvider not yet implemented — weights/runtime not selected');
//   },
//   async classifyPII(detections) { /* ... */ }
// };

try {
  // During scaffolding, fall back to stub so pipeline remains testable
  const stub = require('./stub_provider.js');
  RealLLMProvider = stub.StubLLMProvider;
  RealVLMProvider = stub.StubVLMProvider;
  console.warn('[Trinetra] RealProvider placeholder — currently delegating to StubProvider. Replace with real runtime in Phase 13.');
} catch (e) {
  // browser context fallback
}

const MODEL_BACKEND = 'real-placeholder';

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { RealLLMProvider, RealVLMProvider, MODEL_BACKEND };
}
if (typeof window !== 'undefined') {
  window.TrinetraRealProvider = { RealLLMProvider, RealVLMProvider, MODEL_BACKEND };
}
if (typeof self !== 'undefined') {
  self.TrinetraRealProvider = { RealLLMProvider, RealVLMProvider, MODEL_BACKEND };
}
