// Trinetra — Local Reasoning Wiring (Phase 5)
// Implements Primary Path (AT → LocalLLMProvider.plan()) + Fallback Path (screenshot → LocalVLMProvider.analyze())
// and the confidence decision gate (default threshold 0.7, configurable).
// Entirely provider-agnostic — backed by stub through Phases 5–12, real provider in Phase 13.

const DEFAULT_THRESHOLD = 0.7;

let llmProvider = null;
let vlmDeps = null;

try {
  const stub = require('./providers/stub_provider.js');
  llmProvider = stub.StubLLMProvider;
} catch (e) {
  if (typeof window !== 'undefined' && window.TrinetraStubProvider) {
    llmProvider = window.TrinetraStubProvider.StubLLMProvider;
  } else if (typeof self !== 'undefined' && self.TrinetraStubProvider) {
    llmProvider = self.TrinetraStubProvider.StubLLMProvider;
  }
}

try {
  vlmDeps = require('./visual_analysis.js');
} catch (e) {
  vlmDeps = null;
}

function setLLMProvider(provider) {
  llmProvider = provider;
}

function getLLMProvider() {
  if (!llmProvider) throw new Error('LLM provider not set — call setLLMProvider() or ensure stub is available');
  return llmProvider;
}

// Decide if fallback VLM should be called
function needsVisualFallback({ at, primaryResult } = {}) {
  if (!at || at.length === 0) return true;
  if (primaryResult && primaryResult.reasoning && primaryResult.reasoning.toLowerCase().includes('at appears empty')) return true;
  // Check visual_analysis helper if available
  if (vlmDeps && vlmDeps.shouldTriggerFallback) {
    return vlmDeps.shouldTriggerFallback({ at, planResult: primaryResult });
  }
  return false;
}

// Main entry: local reasoning with decision gate
// Input: { at, userGoal, screenshot?, threshold?, providers? }
// Output: { plan, actions, confidence, needs_escalation, reasoning, visualContext, threshold, source }
async function reasonLocally({ at, userGoal, screenshot, threshold = DEFAULT_THRESHOLD, llm = null, vlm = null } = {}) {
  const activeLLM = llm || getLLMProvider();

  // Primary path: AT + userGoal → plan
  const primaryResult = await activeLLM.plan({ at, userGoal });

  let visualContext = null;
  let finalResult = primaryResult;

  // Fallback path: only if AT insufficient and screenshot available
  if (needsVisualFallback({ at, primaryResult }) && screenshot) {
    // Use provided vlm or visual_analysis module
    let vlmProvider = vlm;
    if (!vlmProvider && vlmDeps) {
      vlmProvider = vlmDeps.getVLMProvider ? vlmDeps.getVLMProvider() : null;
    }
    if (!vlmProvider) {
      try {
        const stub = require('./providers/stub_provider.js');
        vlmProvider = stub.StubVLMProvider;
      } catch (e) {}
    }

    if (vlmProvider) {
      const visual = await vlmProvider.analyze({ screenshot });
      visualContext = {
        elements: visual.elements || [],
        bboxes: visual.bboxes || [],
        ocrText: visual.ocrText || '',
        labels: visual.labels || [],
        raw: visual
      };
      // Re-plan with visual context
      finalResult = await activeLLM.plan({ at, userGoal, visualContext });
    }
  }

  // Decision gate: compare confidence against threshold
  const confidence = typeof finalResult.confidence === 'number' ? finalResult.confidence : 0;
  const needs_escalation = confidence < threshold;

  // Normalize output to both Section 2.2 and Section 8 schemas
  const actions = finalResult.actions || finalResult.plan || [];
  const plan = finalResult.plan || actions;

  return {
    version: finalResult.version || '1.0',
    source: finalResult.source || 'local',
    confidence,
    needs_escalation,
    plan,
    actions,
    reasoning: finalResult.reasoning || '',
    visualContext,
    visualContextUsed: !!visualContext,
    threshold,
    raw: finalResult
  };
}

// Convenience: set threshold globally (also reads from env/storage if needed)
function getThreshold(override) {
  if (typeof override === 'number') return override;
  if (typeof process !== 'undefined' && process.env && process.env.TRINETRA_CONFIDENCE_THRESHOLD) {
    const v = parseFloat(process.env.TRINETRA_CONFIDENCE_THRESHOLD);
    if (!isNaN(v) && v >= 0 && v <= 1) return v;
  }
  return DEFAULT_THRESHOLD;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { reasonLocally, setLLMProvider, getLLMProvider, DEFAULT_THRESHOLD, getThreshold, needsVisualFallback };
}
if (typeof window !== 'undefined') {
  window.TrinetraLocalReasoning = { reasonLocally, setLLMProvider, getLLMProvider, DEFAULT_THRESHOLD, getThreshold };
}
if (typeof self !== 'undefined') {
  self.TrinetraLocalReasoning = { reasonLocally, setLLMProvider, getLLMProvider, DEFAULT_THRESHOLD, getThreshold };
}
