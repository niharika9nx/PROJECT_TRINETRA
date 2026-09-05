// Trinetra — Model Provider Interface (Phase 4)
// Defines contracts for LocalLLMProvider and LocalVLMProvider.
// All providers (stub, real) must implement these exact signatures.
// Sections 2.2 and 3 are authoritative for schemas.

/**
 * Action Plan schema (Section 2.2 + Section 8):
 * {
 *   version: "1.0",
 *   source: "local"|"cloud",
 *   confidence: 0.0-1.0,
 *   actions: [{ id, type, requires_approval, target, params }],
 *   reasoning: string,
 *   // Convenience aliases for 2.2 example:
 *   plan?: actions alias,
 *   needs_escalation?: boolean
 * }
 */

/**
 * @interface LocalLLMProvider
 * plan({ at, userGoal, visualContext? }) => Promise<{ plan, confidence, needs_escalation, version, source, actions, reasoning }>
 * classifyPII(detections) => Promise<Array<{...detection, sensitivity, strategy}>>
 */

/**
 * @interface LocalVLMProvider
 * analyze({ screenshot }) => Promise<{ elements, bboxes, ocrText, labels }>
 * detectPII(screenshot) => Promise<Array<{ bbox, type, confidence }>>
 */

// Config flag — MODEL_BACKEND=stub|real (Phase 4 default stub; Phase 13 flips to real)
// In extension context this reads from chrome.storage or global; in Node/testing from env.
const MODEL_BACKEND_KEY = 'MODEL_BACKEND';
function getModelBackend() {
  // Priority: window global > process.env > default stub
  if (typeof window !== 'undefined' && window.TRINETRA_MODEL_BACKEND) {
    return window.TRINETRA_MODEL_BACKEND;
  }
  if (typeof self !== 'undefined' && self.TRINETRA_MODEL_BACKEND) {
    return self.TRINETRA_MODEL_BACKEND;
  }
  if (typeof process !== 'undefined' && process.env && process.env[MODEL_BACKEND_KEY]) {
    return process.env[MODEL_BACKEND_KEY];
  }
  return 'stub';
}

// Registry — selects active provider pair without callers knowing which backend is active
class ModelProviderRegistry {
  constructor({ llmProvider, vlmProvider, backend = getModelBackend() } = {}) {
    this.backend = backend;
    this.llmProvider = llmProvider;
    this.vlmProvider = vlmProvider;
  }

  getLLMProvider() {
    if (!this.llmProvider) throw new Error('No LLM provider registered');
    return this.llmProvider;
  }

  getVLMProvider() {
    if (!this.vlmProvider) throw new Error('No VLM provider registered');
    return this.vlmProvider;
  }

  getBackend() {
    return this.backend;
  }

  static fromStub(stubModule) {
    return new ModelProviderRegistry({
      llmProvider: stubModule.StubLLMProvider,
      vlmProvider: stubModule.StubVLMProvider,
      backend: 'stub'
    });
  }
}

// Validation helpers (shared across stub and future real provider)
function validateActionPlan(plan) {
  if (!plan || typeof plan !== 'object') throw new Error('Action Plan must be an object');
  if (typeof plan.confidence !== 'number' || plan.confidence < 0 || plan.confidence > 1) {
    throw new Error('Action Plan confidence must be number 0-1');
  }
  if (!Array.isArray(plan.actions) && !Array.isArray(plan.plan)) {
    throw new Error('Action Plan must have actions[] or plan[]');
  }
  return true;
}

// Export for module and global contexts
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getModelBackend, ModelProviderRegistry, validateActionPlan, MODEL_BACKEND_KEY };
}
if (typeof window !== 'undefined') {
  window.TrinetraProviderInterface = { getModelBackend, ModelProviderRegistry, validateActionPlan };
}
if (typeof self !== 'undefined') {
  self.TrinetraProviderInterface = { getModelBackend, ModelProviderRegistry, validateActionPlan };
}
