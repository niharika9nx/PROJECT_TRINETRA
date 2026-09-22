// Trinetra — Workflow Loop (Phases 7 + 11)
// Browser agent: user goal + screen state → think → act → verify
// Uses AT-diff heuristic to track progress and detect goal achievement.

const MAX_ITERATIONS = 10;
var WORKFLOW_DEFAULT_THRESHOLD = 0.7;
var DEFAULT_THRESHOLD = WORKFLOW_DEFAULT_THRESHOLD;

let localReasoning = null;
let actionExecutor = null;
let atExtractor = null;

if (typeof require !== 'undefined') {
  try { localReasoning = require('./local_reasoning.js'); } catch (e) {}
  try { actionExecutor = require('./action_executor.js'); } catch (e) {}
  try { atExtractor = require('./at_extractor.js'); } catch (e) {}
}

// ========== AT-DIFF: detect screen changes between iterations ==========

function computeATDiff(prevAT, currentAT) {
  if (!prevAT || !currentAT) return null;
  const prevIds = new Set(prevAT.map(n => n.id));
  const currIds = new Set(currentAT.map(n => n.id));
  const newNodes = currentAT.filter(n => !prevIds.has(n.id));
  const removedNodes = prevAT.filter(n => !currIds.has(n.id));
  const stateChanges = currentAT.filter(n => {
    const prev = prevAT.find(p => p.id === n.id);
    return prev && JSON.stringify(prev.state) !== JSON.stringify(n.state);
  });
  const nameChanges = currentAT.filter(n => {
    const prev = prevAT.find(p => p.id === n.id);
    return prev && (prev.name || '') !== (n.name || '');
  });
  const nodeCountDelta = currentAT.length - prevAT.length;
  const pageChanged = Math.abs(nodeCountDelta) > 50 ||
    (prevAT.length > 0 && currentAT.length > 0 &&
     prevAT[0].tag !== currentAT[0].tag &&
     Math.abs(nodeCountDelta) > 10);
  return {
    nodeCountDelta,
    newNodes,
    removedNodes,
    stateChanges,
    nameChanges,
    pageChanged,
    nodeCount: currentAT.length,
    prevNodeCount: prevAT.length,
  };
}

// ========== QUERY CLASSIFICATION ==========

function classifyQuery(userGoal) {
  const g = (userGoal || '').toLowerCase();
  if (/checkout|payment|buy|purchase|order|pay|cart/.test(g)) return { type: 'auth_gated' };
  if (/go\s*to|open|navigate|visit/.test(g)) return { type: 'navigate' };
  if (/click|press|tap|hit|select|choose/.test(g)) return { type: 'action' };
  if (/what|how\s*(much|many)|tell|price|rating|spec|review|compare|difference/.test(g)) return { type: 'info' };
  if (/find|search|show|browse|look|fetch|get|want|need|suggest|recommend|cheapest|best|good|under|below/.test(g)) return { type: 'search' };
  return { type: 'search' };
}

function extractGoalKeywords(userGoal) {
  const stopWords = new Set([
    'the', 'and', 'for', 'with', 'under', 'below', 'above', 'over', 'good', 'best',
    'fetch', 'get', 'show', 'find', 'search', 'want', 'need', 'me', 'a', 'an', 'in',
    'on', 'at', 'to', 'from', 'please', 'can', 'you', 'give', 'look'
  ]);
  const words = (userGoal || '').toLowerCase().split(/\W+/).filter(w => w.length > 2);
  const meaningful = words.filter(w => !stopWords.has(w));
  return meaningful.length > 0 ? meaningful : words;
}

function atContainsKeywords(at, keywords) {
  if (!at || !keywords || keywords.length === 0) return false;
  return at.some(n => {
    const name = (n.name || '').toLowerCase();
    return keywords.some(k => name.includes(k));
  });
}

// ========== GOAL ACHIEVEMENT via AT-DIFF ==========

function isGoalAchieved({ at, userGoal, iteration, maxIterations = MAX_ITERATIONS, history = [], atDiff, classification } = {}) {
  const cls = classification || classifyQuery(userGoal);
  const goalKeywords = extractGoalKeywords(userGoal);

  // Auth-gated goals: require explicit confirmation keywords
  if (cls.type === 'auth_gated') {
    const confirmKeywords = /order\s*placed|thank\s*you|order\s*confirmed|payment\s*successful|order\s*complete|your\s*order|purchase\s*complete/i;
    return !!(at && at.some(n => confirmKeywords.test(n.name || '')));
  }

  // Navigation: page must have changed and goal keywords visible
  if (cls.type === 'navigate') {
    return !!(atDiff && atDiff.pageChanged && atContainsKeywords(at, goalKeywords));
  }

  // Action: element state changed or page changed after click/type
  if (cls.type === 'action') {
    const hadAction = history.some(h => (h.reasoning?.actions || []).some(a => ['click', 'type', 'submit'].includes(a.type)));
    return !!(hadAction && atDiff && (atDiff.stateChanges.length > 0 || atDiff.pageChanged));
  }

  // Info extraction: goal keywords visible in AT
  if (cls.type === 'info') {
    return atContainsKeywords(at, goalKeywords);
  }

  // Search/Browse: requires a page transition after a search submit, with matching product results
  if (cls.type === 'search') {
    // Did the history include a submit or navigate action? (i.e., a search was actually performed)
    const didSearch = history.some(h =>
      (h.execResult?.results || []).some(r => ['submit', 'navigate'].includes((r.action?.type || '').toLowerCase()) && r.result?.success)
      || (h.reasoning?.actions || []).some(a => ['submit', 'navigate'].includes((a.type || '').toLowerCase()))
    );
    // Did the page actually change since a previous iteration? (results loaded)
    const pageChanged = atDiff && atDiff.pageChanged;
    // Are there matching product links visible in the AT?
    const hasProductResults = at && at.some(n =>
      (['link', 'button'].includes(n.role) || n.tag === 'a') &&
      goalKeywords.some(k => (n.name || '').toLowerCase().includes(k))
    );
    // Success = searched + page changed + product links visible
    if (didSearch && pageChanged && hasProductResults && iteration >= 2) return true;
    // Also succeed if page changed with goal content AND more than 5 nodes match (strong signal)
    const keywordMatchCount = at ? at.filter(n => goalKeywords.some(k => (n.name || '').toLowerCase().includes(k))).length : 0;
    if (didSearch && pageChanged && keywordMatchCount >= 3 && iteration >= 2) return true;
    return false;
  }

  return false;
}

// Detect if AT indicates a login/auth page (actual login form, not just nav links)
function detectAuthPage(at) {
  if (!Array.isArray(at) || at.length === 0) return { isAuth: false, reason: '' };
  const emailLike = /email|phone|mobile|username|e-mail/i;
  const signInButton = /sign\s*in|log\s*in|login|continue|verify|submit/i;
  let hasEmailInput = false;
  let hasSignInButton = false;
  for (const node of at) {
    const name = (node.name || '').toLowerCase();
    const tag = (node.tag || '').toLowerCase();
    const role = (node.role || '').toLowerCase();
    // Password field = definite login page
    if (/password/i.test(name)) {
      return { isAuth: true, reason: 'Password input field detected on page' };
    }
    // Check for email/phone input
    if ((tag === 'input' || role === 'textbox') && emailLike.test(name)) {
      hasEmailInput = true;
    }
    // Check for sign-in button/link
    if ((tag === 'button' || tag === 'a' || role === 'button' || role === 'link') && signInButton.test(name)) {
      hasSignInButton = true;
    }
  }
  // Multi-step login (e.g., Amazon email-first): email input + sign-in button
  // BUT only if page is minimal (< 15 nodes) — product pages have 50+ nodes with headers/nav
  if (hasEmailInput && hasSignInButton && at.length < 15) {
    return { isAuth: true, reason: `Minimal page (${at.length} nodes) with email input and sign-in button — likely login form` };
  }
  return { isAuth: false, reason: '' };
}

// Check if userGoal involves checkout, payment, or purchase
function goalNeedsAuth(userGoal) {
  const g = (userGoal || '').toLowerCase();
  return /checkout|payment|buy|purchase|order|pay|cart/.test(g);
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
  let prevAT = null;
  let noChangeCount = 0;

  const reason = reasonFn ||
    (localReasoning ? localReasoning.reasonLocally : null) ||
    (typeof window !== 'undefined' && window.TrinetraLocalReasoning ? window.TrinetraLocalReasoning.reasonLocally : null) ||
    (typeof self !== 'undefined' && self.TrinetraLocalReasoning ? self.TrinetraLocalReasoning.reasonLocally : null);
  const execute = executePlanFn ||
    (actionExecutor ? actionExecutor.executePlan : null) ||
    (typeof window !== 'undefined' && window.TrinetraActionExecutor ? window.TrinetraActionExecutor.executePlan : null) ||
    (typeof self !== 'undefined' && self.TrinetraActionExecutor ? self.TrinetraActionExecutor.executePlan : null);

  if (!reason) throw new Error('No reasoning function available');

  const classification = classifyQuery(userGoal);

  while (iteration < maxIterations) {
    iteration++;
    if (onStep) onStep({ step: 'observe', iteration, userGoal });

    const observation = await observePage({ getAT, getScreenshot });
    lastObservation = observation;

    if (onStep) onStep({ step: 'observed', iteration, atCount: observation.at.length });

    // Compute AT-diff
    const atDiff = computeATDiff(prevAT, observation.at);

    // Stuck detection
    const screenChanged = atDiff && (atDiff.newNodes.length > 0 || atDiff.removedNodes.length > 0 || atDiff.stateChanges.length > 0 || atDiff.pageChanged);
    if (iteration > 1 && !screenChanged) {
      noChangeCount++;
      if (noChangeCount >= 3) {
        return { success: false, reason: 'Stuck — no screen change for 3 iterations', iteration, history, lastObservation };
      }
    } else {
      noChangeCount = 0;
    }

    if (onStep) onStep({ step: 'reason', iteration });
    const reasoning = await reason({ at: observation.at, userGoal, screenshot: observation.screenshot, threshold, atDiff: atDiff ? { nodeCountDelta: atDiff.nodeCountDelta, newNodesCount: atDiff.newNodes.length, stateChangesCount: atDiff.stateChanges.length, pageChanged: atDiff.pageChanged, nodeCount: atDiff.nodeCount } : null, iteration, classification: classification.type });
    history.push({ iteration, reasoning, observation, atDiff, classification });

    if (onStep) onStep({ step: 'reasoned', iteration, confidence: reasoning.confidence, needs_escalation: reasoning.needs_escalation, needs_vlm: reasoning.needs_vlm, vlm_reason: reasoning.vlm_reason, actions: reasoning.actions });
    if (reasoning.needs_vlm) {
      if (onStep) onStep({ step: 'vlm_flag', iteration, needs_vlm: reasoning.needs_vlm, vlm_reason: reasoning.vlm_reason, flagged: reasoning.vlm_flag_displayed });
      console.log(`[Trinetra Loop] Iteration ${iteration}: VLM_REQUIRED flagged — ${reasoning.vlm_reason} (no VLM call yet, DOM-first mode)`);
    }

    if (reasoning.needs_escalation) {
      if (onStep) onStep({ step: 'would_escalate', iteration, reasoning });
      console.log(`[Trinetra Loop] Iteration ${iteration}: would escalate to cloud (stubbed in Phase 7) — confidence ${reasoning.confidence} < ${threshold}`);
    } else {
      if (onStep) onStep({ step: 'execute', iteration, actions: reasoning.actions });
      if (execute && reasoning.actions && reasoning.actions.length > 0) {
        try {
          const execResult = await execute({ actions: reasoning.actions, plan: reasoning.plan, at: observation.at });
          if (onStep) onStep({ step: 'executed', iteration, execResult });
          history[history.length - 1].execResult = execResult;
        } catch (e) {
          if (onStep) onStep({ step: 'execute_error', iteration, error: e.message });
        }
      } else {
        if (onStep) onStep({ step: 'executed_stub', iteration });
      }

      const achieved = isGoalAchieved({ at: observation.at, userGoal, iteration, maxIterations, history, atDiff, classification });
      if (onStep) onStep({ step: 'evaluate', iteration, achieved });
      if (achieved) {
        return { success: true, reason: 'Goal achieved', iteration, history, lastObservation };
      }

      prevAT = observation.at;
      await new Promise(r => setTimeout(r, 100));
    }

  }

  return { success: false, reason: 'Max iterations reached', iteration, history, lastObservation };
}

// Phase 11: Full 8-step loop (local + cloud escalation)
// Browser agent: user goal + screen state → think → act → verify
// Uses AT-diff heuristic to track progress and detect goal achievement.

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
  sanitizeFn,
  cloudCallFn,
  reloadPageFn,
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
  let stallCount = 0;
  let noChangeCount = 0;
  let prevAT = null;
  let prevATDiff = null;
  const currentSteps = [];

  const reason = reasonFn ||
    (localReasoning ? localReasoning.reasonLocally : null) ||
    (typeof window !== 'undefined' && window.TrinetraLocalReasoning ? window.TrinetraLocalReasoning.reasonLocally : null) ||
    (typeof self !== 'undefined' && self.TrinetraLocalReasoning ? self.TrinetraLocalReasoning.reasonLocally : null);
  const execute = executePlanFn ||
    (actionExecutor ? actionExecutor.executePlan : null) ||
    (typeof window !== 'undefined' && window.TrinetraActionExecutor ? window.TrinetraActionExecutor.executePlan : null) ||
    (typeof self !== 'undefined' && self.TrinetraActionExecutor ? self.TrinetraActionExecutor.executePlan : null);
  if (!reason) throw new Error('No reasoning function available');

  const sanitize = sanitizeFn ||
    (sanitizationEngine ? sanitizationEngine.runSanitizationPipeline : null) ||
    (typeof window !== 'undefined' && window.TrinetraSanitizationEngine ? window.TrinetraSanitizationEngine.runSanitizationPipeline : null);
  const cloudCall = cloudCallFn || (async ({ sanitizedScreenshot, sanitizedAT, sessionId: sid, userGoal: ug, atDiff: ad, classification: cls, iteration: iter, noChangeCount: ncc }) => {
    const res = await fetch(serverUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sanitizedScreenshot, sanitizedAT, sessionId: sid, userGoal: ug, atDiff: ad, classification: cls, iteration: iter, noChangeCount: ncc })
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Cloud call failed ${res.status}: ${text.slice(0,200)}`);
    }
    return res.json();
  });

  // Classify query once at the start
  const classification = classifyQuery(userGoal);
  if (onStep) onStep({ step: 'classify', iteration: 0, classification: classification.type, userGoal });

  while (iteration < maxIterations) {
    iteration++;

    // --- Observe ---
    if (onStep) onStep({ step: 'observe', iteration, userGoal });
    currentSteps.push({ step: 'observe', iteration });

    const observation = await observePage({ getAT, getScreenshot });
    lastObservation = observation;
    if (onStep) onStep({ step: 'observed', iteration, atCount: observation.at.length, hasScreenshot: !!observation.screenshot });
    currentSteps.push({ step: 'observed', iteration, atCount: observation.at.length });

    // --- Compute AT-diff ---
    const atDiff = computeATDiff(prevAT, observation.at);
    if (atDiff) {
      if (onStep) onStep({ step: 'at_diff', iteration, nodeCountDelta: atDiff.nodeCountDelta, newNodes: atDiff.newNodes.length, removedNodes: atDiff.removedNodes.length, stateChanges: atDiff.stateChanges.length, pageChanged: atDiff.pageChanged });
      currentSteps.push({ step: 'at_diff', iteration, nodeCountDelta: atDiff.nodeCountDelta, pageChanged: atDiff.pageChanged });
    }

    // --- Stuck detection: no meaningful screen change for 3 iterations ---
    const screenChanged = atDiff && (atDiff.newNodes.length > 0 || atDiff.removedNodes.length > 0 || atDiff.stateChanges.length > 0 || atDiff.pageChanged);
    if (iteration > 1 && !screenChanged) {
      noChangeCount++;
      if (onStep) onStep({ step: 'no_change', iteration, noChangeCount });
      if (noChangeCount >= 3) {
        if (onStep) onStep({ step: 'stuck', iteration, reason: 'No screen change for 3 iterations' });
        // Try reload if available
        if (typeof reloadPageFn === 'function') {
          if (onStep) onStep({ step: 'reload', iteration });
          reloadPageFn();
          noChangeCount = 0;
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }
        return {
          success: false,
          reason: `Stuck — no screen change for 3 iterations. Task may require authentication or the page is not responding.`,
          iteration,
          history,
          lastObservation,
          sessionId
        };
      }
    } else {
      noChangeCount = 0;
    }

    // --- Auth page check (for checkout/payment goals) ---
    if (classification.type === 'auth_gated') {
      const authCheck = detectAuthPage(observation.at);
      if (authCheck.isAuth) {
        if (onStep) onStep({ step: 'auth_required', iteration, reason: authCheck.reason });
        currentSteps.push({ step: 'auth_required', iteration, reason: authCheck.reason });
        return {
          success: false,
          reason: `Login required — ${authCheck.reason}. Cannot proceed to checkout without authentication.`,
          iteration,
          history,
          lastObservation,
          sessionId
        };
      }
    }

    // --- Reason (local or cloud) ---
    if (onStep) onStep({ step: 'reason', iteration });

    // Build context for LLM: pass AT-diff info so it knows what changed
    const llmContext = {
      at: observation.at,
      userGoal,
      screenshot: observation.screenshot,
      threshold,
      atDiff: atDiff ? {
        nodeCountDelta: atDiff.nodeCountDelta,
        newNodesCount: atDiff.newNodes.length,
        stateChangesCount: atDiff.stateChanges.length,
        pageChanged: atDiff.pageChanged,
        nodeCount: atDiff.nodeCount,
      } : null,
      iteration,
      classification: classification.type,
      noChangeCount,
    };

    const reasoning = await reason(llmContext);
    history.push({ iteration, reasoning, observation, atDiff, classification, escalated: reasoning.needs_escalation, needs_vlm: reasoning.needs_vlm });
    if (onStep) onStep({ step: 'reasoned', iteration, confidence: reasoning.confidence, needs_escalation: reasoning.needs_escalation, needs_vlm: reasoning.needs_vlm, vlm_reason: reasoning.vlm_reason, actions: reasoning.actions });
    currentSteps.push({ step: 'reasoned', iteration, confidence: reasoning.confidence });
    if (reasoning.needs_vlm) {
      if (onStep) onStep({ step: 'vlm_flag', iteration, needs_vlm: true, vlm_reason: reasoning.vlm_reason });
      currentSteps.push({ step: 'vlm_flag', iteration, needs_vlm: true });
    }

    let actionsToExecute = reasoning.actions;
    let cloudResult = null;

    // --- Cloud escalation ---
    if (reasoning.needs_escalation) {
      if (onStep) onStep({ step: 'sanitize', iteration });
      let sanitized = null;
      if (sanitize) {
        try {
          sanitized = await sanitize({ screenshot: observation.screenshot, at: observation.at });
        } catch (e) {
          if (onStep) onStep({ step: 'sanitize_error', iteration, error: e.message });
          sanitized = { sanitizedScreenshot: observation.screenshot, sanitizedAT: observation.at, report: { redacted_regions: [], sanitized_at_summary: 'fallback' } };
        }
      } else {
        sanitized = { sanitizedScreenshot: observation.screenshot, sanitizedAT: observation.at, report: { redacted_regions: [] } };
      }
      if (onStep) onStep({ step: 'sanitized', iteration, report: sanitized.report, sanitizedCount: (sanitized.sanitizedAT || sanitized.sanitized_at || []).length });
      currentSteps.push({ step: 'sanitized', iteration });

      if (onStep) onStep({ step: 'cloud_call', iteration, sessionId });
      try {
        cloudResult = await cloudCall({
          sanitizedScreenshot: sanitized.sanitizedScreenshot || sanitized.sanitized_screenshot || observation.screenshot,
          sanitizedAT: sanitized.sanitizedAT || sanitized.sanitized_at || observation.at,
          sessionId,
          userGoal,
          atDiff: atDiff ? {
            nodeCountDelta: atDiff.nodeCountDelta,
            newNodesCount: atDiff.newNodes.length,
            stateChangesCount: atDiff.stateChanges.length,
            pageChanged: atDiff.pageChanged,
            nodeCount: atDiff.nodeCount,
          } : undefined,
          classification: classification.type,
          iteration,
          noChangeCount,
        });
        if (onStep) onStep({ step: 'cloud_result', iteration, cloudResult });
        actionsToExecute = cloudResult.actions || cloudResult.plan || actionsToExecute;
        currentSteps.push({ step: 'cloud_result', iteration });
      } catch (e) {
        if (onStep) onStep({ step: 'cloud_error', iteration, error: e.message });
        currentSteps.push({ step: 'cloud_error', iteration, error: e.message });
        console.log(`[Trinetra Loop] Iteration ${iteration}: cloud failed (${e.message}), falling back to local reasoning`);
        try {
          const fallbackReasoning = await reason({ at: observation.at, userGoal, screenshot: observation.screenshot, threshold, atDiff: llmContext.atDiff, iteration, classification: classification.type });
          actionsToExecute = fallbackReasoning.actions || fallbackReasoning.plan || [];
          if (onStep) onStep({ step: 'local_fallback', iteration, actions: actionsToExecute, reason: e.message });
        } catch (fallbackErr) {
          console.log(`[Trinetra Loop] Iteration ${iteration}: local fallback also failed (${fallbackErr.message}), no actions`);
          actionsToExecute = [];
        }
      }
    }

    // --- Execute ---
    if (actionsToExecute && actionsToExecute.length > 0) {
      if (onStep) onStep({ step: 'execute', iteration, actions: actionsToExecute, source: reasoning.needs_escalation ? 'cloud' : 'local' });
      if (execute) {
        // Validate navigate URLs before execution — block example.com/placeholder URLs
        const navigateActions = actionsToExecute.filter(a => (a.type || '').toLowerCase() === 'navigate');
        const invalidNavigations = navigateActions.filter(a => !isValidNavigateURL(a.target?.value));
        if (invalidNavigations.length > 0) {
          console.log(`[Trinetra Loop] Invalid navigate URLs detected, re-reasoning`);
          actionsToExecute = [];
        } else {
          try {
            const execResult = await execute({ actions: actionsToExecute, plan: actionsToExecute, at: observation.at });
            if (onStep) onStep({ step: 'executed', iteration, execResult, source: reasoning.needs_escalation ? 'cloud' : 'local' });
            history[history.length - 1].execResult = execResult;
            currentSteps.push({ step: 'executed', iteration, execResult });
            // If submit or navigate was executed, wait for page to load before next observation
            const hasPageTransition = actionsToExecute.some(a =>
              ['submit', 'navigate'].includes((a.type || '').toLowerCase())
            );
            if (hasPageTransition) {
              if (onStep) onStep({ step: 'page_load_wait', iteration, waitMs: 2500 });
              await new Promise(r => setTimeout(r, 2500));
            }
          } catch (e) {
            if (onStep) onStep({ step: 'execute_error', iteration, error: e.message });
            currentSteps.push({ step: 'execute_error', iteration, error: e.message });
          }
        }
      } else {
        if (onStep) onStep({ step: 'executed_stub', iteration, source: reasoning.needs_escalation ? 'cloud' : 'local' });
        currentSteps.push({ step: 'executed_stub', iteration });
      }
    } else {
      if (onStep) onStep({ step: 'no_actions', iteration });
      currentSteps.push({ step: 'no_actions', iteration });
    }

    // --- Evaluate goal (uses AT-diff signals) ---
    const achieved = isGoalAchieved({ at: observation.at, userGoal, iteration, maxIterations, history, atDiff, classification });
    if (onStep) onStep({ step: 'evaluate', iteration, achieved, classification: classification.type, atDiffChanged: !!screenChanged });
    currentSteps.push({ step: 'evaluate', iteration, achieved });
    if (achieved) {
      return { success: true, reason: 'Goal achieved', iteration, history, lastObservation, sessionId, cloudResult, classification };
    }

    // --- Update prevAT for next iteration's diff ---
    prevAT = observation.at;
    prevATDiff = atDiff;

    // --- Stall counter ---
    const lastStep = currentSteps.length > 0 ? currentSteps[currentSteps.length - 1] : null;
    const tookValidAction = achieved || (lastStep && lastStep.step !== 'no_actions' && lastStep.step !== 'cloud_error');
    if (!tookValidAction) {
      stallCount++;
      if (onStep) onStep({ step: 'stall', iteration, stallCount });
    } else {
      stallCount = 0;
    }
    if (stallCount >= 3 && typeof reloadPageFn === 'function') {
      if (onStep) onStep({ step: 'reload', iteration, stallCount });
      reloadPageFn();
      stallCount = 0;
      await new Promise(r => setTimeout(r, 1000));
      continue;
    }

    await new Promise(r => setTimeout(r, 300));
  }

  return { success: false, reason: 'Max iterations reached', iteration, history, lastObservation, sessionId };
}

// ========== NAVIGATE URL VALIDATION ==========

function isValidNavigateURL(url) {
  if (!url || typeof url !== 'string') return false;
  const lower = url.toLowerCase();
  // Block obvious placeholder/example domains
  if (lower.includes('example') || lower.includes('placeholder') || lower === 'about:blank') return false;
  // Must be http(s) URL
  if (!lower.startsWith('http://') && !lower.startsWith('https://')) return false;
  // Block javascript: URLs
  if (lower.startsWith('javascript:')) return false;
  return true;
}

// ========== QUERY CLASSIFICATION ==========
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { runLocalLoop, runFullLoop, observePage, isGoalAchieved, computeATDiff, classifyQuery, extractGoalKeywords, atContainsKeywords, detectAuthPage, MAX_ITERATIONS, DEFAULT_THRESHOLD: WORKFLOW_DEFAULT_THRESHOLD };
}
if (typeof window !== 'undefined') {
  window.TrinetraWorkflowLoop = { runLocalLoop, runFullLoop, observePage, isGoalAchieved, computeATDiff, classifyQuery };
}
if (typeof self !== 'undefined') {
  self.TrinetraWorkflowLoop = { runLocalLoop, runFullLoop, observePage, isGoalAchieved, computeATDiff, classifyQuery };
}
