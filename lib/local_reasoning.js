// Trinetra — Local Reasoning Wiring (Phase 5)
// Implements Primary Path (AT → LocalLLMProvider.plan()) + Fallback Path (screenshot → LocalVLMProvider.analyze())
// and the confidence decision gate (5-point scale, default threshold 2, configurable).
// Entirely provider-agnostic — backed by stub through Phases 5–12, real provider in Phase 13.

if (typeof DEFAULT_THRESHOLD === 'undefined') { var DEFAULT_THRESHOLD = 2; }

let llmProvider = null;
let vlmDeps = null;

if (typeof require !== 'undefined') {
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
} else if (typeof window !== 'undefined' && window.TrinetraStubProvider) {
  llmProvider = window.TrinetraStubProvider.StubLLMProvider;
} else if (typeof self !== 'undefined' && self.TrinetraStubProvider) {
  llmProvider = self.TrinetraStubProvider.StubLLMProvider;
}

if (typeof require !== 'undefined') {
  try {
    vlmDeps = require('./visual_analysis.js');
  } catch (e) {
    vlmDeps = null;
  }
}

function setLLMProvider(provider) {
  llmProvider = provider;
}

function getLLMProvider() {
  if (!llmProvider) throw new Error('LLM provider not set — call setLLMProvider() or ensure stub is available');
  return llmProvider;
}

// Decide if fallback VLM should be called — DOM-first, VLM only when AT insufficient.
// For testing without real VLM, we flag needs_vlm instead of calling analyze.
// Flag details returned in reasonLocally output for later switch to real VLM.
function needsVisualFallback({ at, primaryResult } = {}) {
  if (!at || at.length === 0) return { needed: true, reason: 'AT empty — no nodes' };
  if (primaryResult && primaryResult.reasoning && primaryResult.reasoning.toLowerCase().includes('at appears empty')) {
    return { needed: true, reason: 'LLM signaled AT appears empty' };
  }
  // Check visual_analysis helper if available
  if (vlmDeps && vlmDeps.shouldTriggerFallback) {
    const fallback = vlmDeps.shouldTriggerFallback({ at, planResult: primaryResult });
    if (fallback === true) return { needed: true, reason: 'AT sparse and low confidence (<0.5 with <3 nodes)' };
    if (fallback && typeof fallback === 'object') {
      // New contract: {needed:boolean, reason:string} — honor it exactly
      if (typeof fallback.needed === 'boolean') return fallback;
    }
    if (fallback === true) return { needed: true, reason: 'visual_analysis flagged fallback' };
  }
  return { needed: false, reason: '' };
}

function toNeedsVlmFlag(fallbackResult) {
  if (!fallbackResult) return { needs_vlm: false, vlm_reason: '' };
  if (typeof fallbackResult === 'boolean') return { needs_vlm: fallbackResult, vlm_reason: fallbackResult ? 'AT insufficient' : '' };
  return { needs_vlm: !!fallbackResult.needed, vlm_reason: fallbackResult.reason || '' };
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

  // DOM-first VLM flagging: detect if VLM would help; for now FLAG only, don't call VLM.
  // When real VLM available, this branch will actually call analyze and re-plan.
  const fallbackCheck = needsVisualFallback({ at, primaryResult });
  const vlmFlag = toNeedsVlmFlag(fallbackCheck);
  const VLM_ENABLED = false; // flip to true when real VLM wired (Phase 13) — then will actually call analyze
  let vlmFlagDisplayed = false;

  if (fallbackCheck.needed) {
    if (VLM_ENABLED && screenshot) {
      // Real VLM path (future): only if screenshot available and VLM enabled
      let vlmProvider = vlm;
      if (!vlmProvider && vlmDeps) {
        vlmProvider = vlmDeps.getVLMProvider ? vlmDeps.getVLMProvider() : null;
      }
      if (!vlmProvider && typeof require !== 'undefined') {
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
    } else {
      // Flag-only path (current testing): mark that VLM would be needed, no image call
      vlmFlagDisplayed = true;
      // Annotate reasoning so output clearly shows flag (will later switch to real VLM call)
      if (finalResult && finalResult.reasoning) {
        finalResult = {
          ...finalResult,
          reasoning: `${finalResult.reasoning} [VLM_REQUIRED: ${vlmFlag.vlm_reason} — no VLM available yet, flagged for future switch]`,
        };
      }
    }
  }

  // Decision gate: compare confidence against threshold (5-point scale; < 2 → cloud)
  const effectiveThreshold = threshold;
  const confidence = typeof finalResult.confidence === 'number' ? finalResult.confidence : 0;
  const needs_escalation = confidence < effectiveThreshold;

  // hasSearchAT: if AT lacks search form elements and goal involves find/search, escalate to cloud
  const hasSearchAT = Array.isArray(at) && at.some(n =>
    n.role === 'searchbox' || n.role === 'combobox' || n.tag === 'input' ||
    (n.name && /search|query|find/i.test(n.name)) || n.tag === 'form'
  );
  const lowerGoal = (userGoal || '').toLowerCase();
  const goalNeedsSearch = lowerGoal.includes('find') || lowerGoal.includes('search');
  if (goalNeedsSearch && !hasSearchAT) {
    return {
      version: '1.0', source: 'local', confidence: 1,
      needs_escalation: true, effectiveThreshold: 2,
      needs_vlm: false, vlm_reason: '', vlm_flag_displayed: false,
      plan: [], actions: [],
      reasoning: 'AT lacks search form elements — deferring to cloud agent to navigate to amazon.in and locate search bar',
      visualContextUsed: false, threshold: 2, raw: {}
    };
  }

  // Normalize output to both Section 2.2 and Section 8 schemas
  const actions = finalResult.actions || finalResult.plan || [];
  const plan = finalResult.plan || actions;

  return {
    version: finalResult.version || '1.0',
    source: finalResult.source || 'local',
    confidence,
    needs_escalation,
    effectiveThreshold,
    needs_vlm: vlmFlag.needs_vlm,
    vlm_reason: vlmFlag.vlm_reason,
    vlm_flag_displayed: vlmFlagDisplayed,
    plan,
    actions,
    reasoning: finalResult.reasoning || '',
    visualContext,
    visualContextUsed: !!visualContext,
    threshold: effectiveThreshold,
    raw: finalResult
  };
}

// Convenience: set threshold globally (also reads from env/storage if needed)
function getThreshold(override) {
  if (typeof override === 'number') return override;
  if (typeof process !== 'undefined' && process.env && process.env.TRINETRA_CONFIDENCE_THRESHOLD) {
    const v = parseFloat(process.env.TRINETRA_CONFIDENCE_THRESHOLD);
    if (!isNaN(v) && v >= 0 && v <= 5) return v;
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
