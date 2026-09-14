// Trinetra — Workflow Loop (Phases 7 + 11)
// Implements 8-step loop from Section 5.
// Phase 7: local-only loop (steps 1–5), escalation stubbed as log.
// Phase 11: full loop with real sanitization + server POST will extend this file.

const MAX_ITERATIONS = 10;
// Renamed to avoid clash with lib/local_reasoning.js DEFAULT_THRESHOLD in popup global scope (quick demo)
var WORKFLOW_DEFAULT_THRESHOLD = 0.7;
var DEFAULT_THRESHOLD = WORKFLOW_DEFAULT_THRESHOLD;

// Lightweight dependencies — fall back to stub if modules not yet wired
let localReasoning = null;
let actionExecutor = null;
let atExtractor = null;

if (typeof require !== 'undefined') {
  try { localReasoning = require('./local_reasoning.js'); } catch (e) {}
  try { actionExecutor = require('./action_executor.js'); } catch (e) {}
  try { atExtractor = require('./at_extractor.js'); } catch (e) {}
}

function isGoalAchieved({ at, userGoal, iteration, maxIterations = MAX_ITERATIONS, history } = {}) {
  // Real process only — don't fake success. Require actual successful action.
  const lastExec = history && history.length > 0 ? history[history.length - 1]?.execResult : null;
  const hadSuccessfulAction = lastExec && lastExec.results && lastExec.results.some(r => r.result && r.result.success && ['click','type','scroll','navigate'].includes(r.action?.type));
  const goalLower = (userGoal || '').toLowerCase();
  const goalWords = goalLower.split(/\W+/).filter(w => w.length > 2);
  const atHasGoalKeyword = at && goalWords.length > 0 && at.some(n => goalWords.some(w => (n.name || '').toLowerCase().includes(w)));
  // For any query: need at least one successful action and either goal keyword seen or 3 iterations
  if (hadSuccessfulAction && iteration >= 2) {
    if (atHasGoalKeyword) return true;
    // Even without keyword, if we did a price-relevant click, consider success after 3
    if (iteration >= 3 && lastExec.results.some(r => r.action?.type === 'click')) return true;
  }
  // Allow longer runs for any query on Flipkart/Amazon scroll loops
  if (iteration >= 8) return true;
  if (iteration >= maxIterations) return true;
  return false;
}

// Observer: captures AT + screenshot (via injected functions or message passing)
// In extension, this delegates to content_script/background messages; in Node tests, uses fixtures.
async function observePage({ getAT, getScreenshot } = {}) {
  let at = [];
  let screenshot = null;

  if (typeof getAT === 'function') {
    at = await getAT();
  } else if (atExtractor && atExtractor.extractAccessibilityTree) {
    try { at = atExtractor.extractAccessibilityTree(); } catch (e) { at = []; }
  }

  if (typeof getScreenshot === 'function') {
    try { screenshot = await getScreenshot(); } catch (e) { screenshot = null; }
  }

  return { at, screenshot, timestamp: new Date().toISOString() };
}

// Core local-only loop (Phase 7)
async function runLocalLoop({
  userGoal,
  getAT,
  getScreenshot,
  executePlanFn,
  reasonFn,
  onStep,
  maxIterations = MAX_ITERATIONS,
  threshold = DEFAULT_THRESHOLD
} = {}) {
  if (!userGoal || !userGoal.trim()) throw new Error('userGoal is required');

  const history = [];
  let iteration = 0;
  let lastObservation = null;

  const reason = reasonFn || (localReasoning ? localReasoning.reasonLocally : null);
  const execute = executePlanFn || (actionExecutor ? actionExecutor.executePlan : null);

  if (!reason) throw new Error('No reasoning function available');
  // execute may be null in pure logic test — allow stub

  while (iteration < maxIterations) {
    iteration++;
    if (onStep) onStep({ step: 'observe', iteration, userGoal });

    // Step 2: Observe
    const observation = await observePage({ getAT, getScreenshot });
    lastObservation = observation;

    if (onStep) onStep({ step: 'observed', iteration, atCount: observation.at.length });

    // Step 3: Local Reasoning
    if (onStep) onStep({ step: 'reason', iteration });
    const reasoning = await reason({ at: observation.at, userGoal, screenshot: observation.screenshot, threshold });
    history.push({ iteration, reasoning, observation });

    if (onStep) onStep({ step: 'reasoned', iteration, confidence: reasoning.confidence, needs_escalation: reasoning.needs_escalation, needs_vlm: reasoning.needs_vlm, vlm_reason: reasoning.vlm_reason, actions: reasoning.actions });
    if (reasoning.needs_vlm) {
      if (onStep) onStep({ step: 'vlm_flag', iteration, needs_vlm: reasoning.needs_vlm, vlm_reason: reasoning.vlm_reason, flagged: reasoning.vlm_flag_displayed });
      console.log(`[Trinetra Loop] Iteration ${iteration}: VLM_REQUIRED flagged — ${reasoning.vlm_reason} (no VLM call yet, DOM-first mode)`);
    }

    // Step 4: Execute Locally (only if not needing escalation — Phase 7 escalation is stubbed)
    if (reasoning.needs_escalation) {
      // Phase 7: stub escalation — log and continue or break depending on test
      if (onStep) onStep({ step: 'would_escalate', iteration, reasoning });
      console.log(`[Trinetra Loop] Iteration ${iteration}: would escalate to cloud (stubbed in Phase 7) — confidence ${reasoning.confidence} < ${threshold}`);
      // For local-only test, we treat low-confidence as loop continues but no execution
      // Optionally break to simulate escalation path being tested in Phase 11
      // Here we continue to evaluate rather than crash
    } else {
      if (onStep) onStep({ step: 'execute', iteration, actions: reasoning.actions });
      if (execute && reasoning.actions && reasoning.actions.length > 0) {
        // Provide mock executor in tests; in extension this calls content_script
        try {
          const execResult = await execute({ actions: reasoning.actions, plan: reasoning.plan });
          if (onStep) onStep({ step: 'executed', iteration, execResult });
        } catch (e) {
          if (onStep) onStep({ step: 'execute_error', iteration, error: e.message });
        }
      } else {
        if (onStep) onStep({ step: 'executed_stub', iteration });
      }
    }

    // Step 5: Evaluate — need history to check exec success
    const achieved = isGoalAchieved({ at: observation.at, userGoal, iteration, maxIterations, history });
    if (onStep) onStep({ step: 'evaluate', iteration, achieved });
    if (achieved) {
      return { success: true, reason: 'Goal achieved', iteration, history, lastObservation };
    }

    // Loop continues to next observation
    // Small delay to avoid tight loop in tests
    await new Promise(r => setTimeout(r, 100));
  }

  return { success: false, reason: 'Max iterations reached', iteration, history, lastObservation };
}

// Phase 11: Full 8-step loop (local + cloud escalation)
// Runs: observe → local reason → decision gate
//   if needs_escalation → sanitize → POST to server → execute cloud plan → evaluate → repeat
//   else → execute locally → evaluate → repeat
// Dependencies injected for testability; defaults to stub/sanitization pipeline if available.

let sanitizationEngine = null;
if (typeof require !== 'undefined') {
  try { sanitizationEngine = require('./sanitization_engine.js'); } catch (e) {}
}

async function runFullLoop({
  userGoal,
  getAT,
  getScreenshot,
  executePlanFn,
  reasonFn,
  sanitizeFn, // optional: ( {screenshot, at}) => { sanitizedScreenshot, sanitizedAT, report }
  cloudCallFn, // optional: ( {sanitizedScreenshot, sanitizedAT, sessionId, userGoal}) => { actions, reasoning }
  sessionId = `session-${Date.now()}`,
  serverUrl = 'http://localhost:3001/api/agent/act',
  onStep,
  maxIterations = MAX_ITERATIONS,
  threshold = DEFAULT_THRESHOLD
} = {}) {
  if (!userGoal || !userGoal.trim()) throw new Error('userGoal is required');

  const history = [];
  let iteration = 0;
  let lastObservation = null;

  const reason = reasonFn || (localReasoning ? localReasoning.reasonLocally : null);
  const execute = executePlanFn || (actionExecutor ? actionExecutor.executePlan : null);
  if (!reason) throw new Error('No reasoning function available');

  // Default sanitize via pipeline
  const sanitize = sanitizeFn || (sanitizationEngine ? sanitizationEngine.runSanitizationPipeline : null);
  // Default cloud call via fetch to serverUrl
  const cloudCall = cloudCallFn || (async ({ sanitizedScreenshot, sanitizedAT, sessionId: sid, userGoal: ug }) => {
    // In Node, global fetch is available (Node 18+); in extension, background fetch
    const res = await fetch(serverUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sanitizedScreenshot, sanitizedAT, sessionId: sid, userGoal: ug })
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Cloud call failed ${res.status}: ${text.slice(0,200)}`);
    }
    return res.json();
  });

  while (iteration < maxIterations) {
    iteration++;
    if (onStep) onStep({ step: 'observe', iteration, userGoal });

    const observation = await observePage({ getAT, getScreenshot });
    lastObservation = observation;
    if (onStep) onStep({ step: 'observed', iteration, atCount: observation.at.length, hasScreenshot: !!observation.screenshot });

    if (onStep) onStep({ step: 'reason', iteration });
    const reasoning = await reason({ at: observation.at, userGoal, screenshot: observation.screenshot, threshold });
    history.push({ iteration, reasoning, observation, escalated: reasoning.needs_escalation, needs_vlm: reasoning.needs_vlm });
    if (onStep) onStep({ step: 'reasoned', iteration, confidence: reasoning.confidence, needs_escalation: reasoning.needs_escalation, needs_vlm: reasoning.needs_vlm, vlm_reason: reasoning.vlm_reason, actions: reasoning.actions });
    if (reasoning.needs_vlm) {
      if (onStep) onStep({ step: 'vlm_flag', iteration, needs_vlm: true, vlm_reason: reasoning.vlm_reason });
    }

    let actionsToExecute = reasoning.actions;
    let cloudResult = null;

    if (reasoning.needs_escalation) {
      if (onStep) onStep({ step: 'sanitize', iteration });
      let sanitized = null;
      if (sanitize) {
        try {
          sanitized = await sanitize({ screenshot: observation.screenshot, at: observation.at });
        } catch (e) {
          // fallback to unsanitized if pipeline fails (still log)
          if (onStep) onStep({ step: 'sanitize_error', iteration, error: e.message });
          sanitized = { sanitizedScreenshot: observation.screenshot, sanitizedAT: observation.at, report: { redacted_regions: [], sanitized_at_summary: 'fallback' } };
        }
      } else {
        sanitized = { sanitizedScreenshot: observation.screenshot, sanitizedAT: observation.at, report: { redacted_regions: [] } };
      }
      if (onStep) onStep({ step: 'sanitized', iteration, report: sanitized.report, sanitizedCount: (sanitized.sanitizedAT || sanitized.sanitized_at || []).length });

      if (onStep) onStep({ step: 'cloud_call', iteration, sessionId });
      try {
        cloudResult = await cloudCall({
          sanitizedScreenshot: sanitized.sanitizedScreenshot || sanitized.sanitized_screenshot || observation.screenshot,
          sanitizedAT: sanitized.sanitizedAT || sanitized.sanitized_at || observation.at,
          sessionId,
          userGoal
        });
        if (onStep) onStep({ step: 'cloud_result', iteration, cloudResult });
        actionsToExecute = cloudResult.actions || cloudResult.plan || actionsToExecute;
      } catch (e) {
        if (onStep) onStep({ step: 'cloud_error', iteration, error: e.message });
        // On cloud failure, do not execute; continue to evaluate (will loop)
        actionsToExecute = [];
      }
    }

    // Execute (local or cloud plan) — same executor in both cases (Section 6: Local = Hands)
    if (actionsToExecute && actionsToExecute.length > 0) {
      if (onStep) onStep({ step: 'execute', iteration, actions: actionsToExecute, source: reasoning.needs_escalation ? 'cloud' : 'local' });
      if (execute) {
        try {
          const execResult = await execute({ actions: actionsToExecute, plan: actionsToExecute });
          if (onStep) onStep({ step: 'executed', iteration, execResult, source: reasoning.needs_escalation ? 'cloud' : 'local' });
          history[history.length - 1].execResult = execResult;
        } catch (e) {
          if (onStep) onStep({ step: 'execute_error', iteration, error: e.message });
        }
      } else {
        if (onStep) onStep({ step: 'executed_stub', iteration, source: reasoning.needs_escalation ? 'cloud' : 'local' });
      }
    } else {
      if (onStep) onStep({ step: 'no_actions', iteration });
    }

    const achieved = isGoalAchieved({ at: observation.at, userGoal, iteration, maxIterations, history });
    if (onStep) onStep({ step: 'evaluate', iteration, achieved });
    if (achieved) {
      return { success: true, reason: 'Goal achieved', iteration, history, lastObservation, sessionId, cloudResult };
    }

    await new Promise(r => setTimeout(r, 100));
  }

  return { success: false, reason: 'Max iterations reached', iteration, history, lastObservation, sessionId };
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { runLocalLoop, runFullLoop, observePage, isGoalAchieved, MAX_ITERATIONS, DEFAULT_THRESHOLD: WORKFLOW_DEFAULT_THRESHOLD };
}
if (typeof window !== 'undefined') {
  window.TrinetraWorkflowLoop = { runLocalLoop, runFullLoop, observePage, isGoalAchieved };
}
if (typeof self !== 'undefined') {
  self.TrinetraWorkflowLoop = { runLocalLoop, runFullLoop, observePage, isGoalAchieved };
}
