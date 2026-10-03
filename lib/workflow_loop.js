// Trinetra — Workflow Loop (Phases 7 + 11)
// Browser agent: user goal + screen state → think → act → verify
// Uses AT-diff heuristic to track progress and detect goal achievement.

(function () {

const MAX_ITERATIONS = 10;
// Confidence gate, 0-1 scale (see model_provider_interface.js validateActionPlan).
// Module-private: each file owns its own default, so neither depends on load order.
var DEFAULT_THRESHOLD = 0.7;
// How many early iterations may pass with no screen change before the loop is
// allowed to call itself stuck. Without this the counter arms before the agent
// has executed anything, so ordinary setup rounds read as "page not responding".
const STUCK_GRACE_ITERATIONS = 3;

let localReasoning = null;
let actionExecutor = null;
let atExtractor = null;

if (typeof require !== 'undefined') {
  try { localReasoning = require('./local_reasoning.js'); } catch (e) {}
  try { actionExecutor = require('./action_executor.js'); } catch (e) {}
  try { atExtractor = require('./at_extractor.js'); } catch (e) {}
}

// ========== AT-DIFF: detect screen changes between iterations ==========

function computeATDiff(prevAT, currentAT, prevURL, currURL) {
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
  // URL is the primary page-change signal. Node-count is a fallback ONLY when
  // URL is unavailable (prevURL or currURL missing) — with a strict threshold
  // so dynamic pages (Amazon homepage churn) do not false-positive.
  const urlKnown = !!(prevURL && currURL);
  const urlChanged = urlKnown && prevURL !== currURL;
  let pageChanged;
  if (urlKnown) {
    pageChanged = urlChanged;
  } else {
    pageChanged = Math.abs(nodeCountDelta) > 200 ||
      (prevAT.length > 0 && currentAT.length > 0 &&
       prevAT[0].tag !== currentAT[0].tag &&
       Math.abs(nodeCountDelta) > 10);
  }
  return {
    nodeCountDelta,
    newNodes,
    removedNodes,
    stateChanges,
    nameChanges,
    pageChanged,
    urlChanged,
    urlKnown,
    prevURL: prevURL || null,
    currURL: currURL || null,
    nodeCount: currentAT.length,
    prevNodeCount: prevAT.length,
  };
}

// ========== QUERY CLASSIFICATION ==========

// Product module, when available (it is loaded before this file in the manifest
// bundle; the require path is for the Node test suite).
let productsLib = null;
if (typeof require !== 'undefined') {
  try { productsLib = require('./products.js'); } catch (e) {}
}
if (!productsLib) {
  const g = (typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null));
  if (g && g.TrinetraProducts) productsLib = g.TrinetraProducts;
}
const products = (productsLib && typeof productsLib.extractProducts === 'function') ? productsLib : null;

function classifyQuery(userGoal) {
  const g = (userGoal || '').toLowerCase();

  // Order intent FIRST — it is the highest-stakes flow, and phrases like
  // "buy the best laptop" also contain a selection word.
  if (/place\s*(an\s*)?order|check\s*out|checkout|pay\s*for|pay\s*now|complete\s*(my\s*)?(purchase|payment|order)|\bbuy\s*(it|this|that|now)\b|\bpurchase\b|\border\s*(it|this|that)\b/.test(g)) {
    return { type: 'order' };
  }

  // "open my cart" is navigation; "open the best laptop" wants one product
  // chosen and opened. Distinguish by a product-ish qualifier rather than by
  // the leading verb, which used to swallow every "open X" goal. Only a true
  // possessive ("my cart", "my orders") forces navigation — "show me the
  // cheapest phone" is a selection request despite the "me".
  const hasMyPossessive = /\bmy\b|\bmine\b/.test(g);
  if (/go\s*to|navigate|visit|open|show|select|pick|choose|view/.test(g)) {
    if (!hasMyPossessive && /best|top|cheapest|lowest|highest|good|best\s*rated|under|below|rating|popular/.test(g)) {
      return { type: 'select_product' };
    }
    return { type: 'navigate' };
  }

  // Bare cart (view cart) without a purchase verb → navigation
  if (/\bcart\b/.test(g) && !/checkout|buy|purchase|\badd\b|place\s*order|\border\b|\bpay\b/.test(g)) return { type: 'navigate' };
  if (/checkout|payment|\bbuy\b|\bpay\b/.test(g)) return { type: 'order' };
  if (/click|press|tap|hit|select|choose|\badd\b/.test(g)) return { type: 'action' };
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

// Explicit order confirmation. Kept strict: a page merely showing a cart is
// not a placed order.
const ORDER_CONFIRM_RE = /order\s*(has\s*been\s*)?(placed|confirmed|complete|successful)|thank\s*you\s*for\s*your\s*(order|purchase)|payment\s*(successful|received|complete)|your\s*order\s*(is|has)|purchase\s*complete/i;

function isGoalAchieved({ at, userGoal, iteration, maxIterations = MAX_ITERATIONS, history = [], atDiff, classification, url } = {}) {
  const cls = classification || classifyQuery(userGoal);
  const goalKeywords = extractGoalKeywords(userGoal);
  const currURL = url || ((typeof location !== 'undefined' && location.href) || (atDiff && atDiff.currURL) || '');

  // Order: only a confirmation counts. An order the user declined, or a
  // checkout page the agent reached but did not commit, is NOT success.
  if (cls.type === 'order' || cls.type === 'auth_gated') {
    return !!(at && at.some(n => ORDER_CONFIRM_RE.test(n.name || '')));
  }

  // Select-one-product: achieved once a single product page is open, which
  // means a product URL or a buy-button page with no results list left.
  // Requires a completed action first, so being on *some* product page when
  // the goal starts doesn't count as having selected the right one.
  if (cls.type === 'select_product') {
    const acted = history.some(h => h.execResult && h.execResult.success !== false);
    if (!acted) return false;
    return !!(products && products.isProductDetailPage(at, currURL));
  }

  // Navigation: page changed + keywords visible, OR URL path matches goal noun, OR AT shows goal page header
  if (cls.type === 'navigate') {
    // (a) pageChanged + goal keywords in AT
    if (atDiff && atDiff.pageChanged && atContainsKeywords(at, goalKeywords)) return true;
    // (b) URL path contains the goal noun (e.g. /cart for "open my cart")
    if (currURL) {
      for (const k of goalKeywords) {
        if (k.length >= 3 && currURL.toLowerCase().includes(k)) {
          // Prefer path-like match for page nouns
          if (currURL.toLowerCase().includes('/' + k) || currURL.toLowerCase().includes(k + '/') || currURL.toLowerCase().includes(k)) {
            if (atDiff && atDiff.pageChanged) return true;
            // Even without pageChanged flag, URL containing goal noun after an action is strong signal
            if (history.some(h => h.execResult)) return true;
          }
        }
      }
    }
    // (c) AT heading/header matches goal page (e.g. "Your Cart", "Cart 0 items")
    if (at && at.length > 0) {
      const pageHeaderRe = goalKeywords.length > 0
        ? new RegExp(goalKeywords.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i')
        : null;
      if (pageHeaderRe) {
        const hasHeader = at.some(n => {
          const name = (n.name || '');
          const role = (n.role || '').toLowerCase();
          if (!pageHeaderRe.test(name)) return false;
          // Heading, region, or first few nodes often are page titles
          return ['heading', 'title', 'region', 'document'].includes(role) ||
                 /cart|page|home|settings|account|order/i.test(name);
        });
        if (hasHeader && atDiff && atDiff.pageChanged) return true;
      }
    }
    return false;
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

  // Search/Browse: requires a real successful submit/navigate + URL change + product results
  if (cls.type === 'search') {
    // Did a submit or navigate actually SUCCEED on-page? (execResult, not just planned actions)
    const didSearch = history.some(h =>
      (h.execResult?.results || []).some(r =>
        ['submit', 'navigate'].includes((r.action?.type || '').toLowerCase()) && r.result?.success
      )
    );
    // URL is the primary page-change signal (set by computeATDiff); node-count only when URL unavailable
    const pageChanged = !!(atDiff && atDiff.pageChanged);
    // Product results: interactive node whose name matches a goal keyword
    // (loose keywordMatchCount shortcut removed — it matched homepage nav links)
    const hasProductResults = at && at.some(n =>
      (['link', 'button'].includes(n.role) || n.tag === 'a' || n.tag === 'button') &&
      goalKeywords.some(k => (n.name || '').toLowerCase().includes(k))
    );
    // Success = real submit succeeded + page actually changed + product links visible
    if (didSearch && pageChanged && hasProductResults && iteration >= 2) return true;
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
// VLM/screenshot disabled: skip capture when needScreenshot is falsy (default off).
async function observePage({ getAT, getScreenshot, needScreenshot = false } = {}) {
  let at = [];
  let screenshot = null;

  if (typeof getAT === 'function') {
    at = await getAT();
  } else if (atExtractor && atExtractor.extractAccessibilityTree) {
    try { at = atExtractor.extractAccessibilityTree(); } catch (e) { at = []; }
  }

  if (needScreenshot && typeof getScreenshot === 'function') {
    try { screenshot = await getScreenshot(); } catch (e) { screenshot = null; }
  }

  // URL is the primary page-change signal for AT-diff
  const url = (typeof location !== 'undefined' && location.href) || null;

  return { at, screenshot, url, timestamp: new Date().toISOString() };
}

// Smart navigation wait: poll URL every 150ms, early-exit on change, max 1800ms.
// Returns { changed, waitedMs, urlAfter }.
async function waitForNavigation(urlBefore, { maxMs = 1800, pollMs = 150 } = {}) {
  const start = Date.now();
  let urlAfter = (typeof location !== 'undefined' && location.href) || null;
  while (Date.now() - start < maxMs) {
    if (urlBefore && urlAfter && urlBefore !== urlAfter) {
      return { changed: true, waitedMs: Date.now() - start, urlAfter };
    }
    await new Promise(r => setTimeout(r, pollMs));
    urlAfter = (typeof location !== 'undefined' && location.href) || null;
  }
  return { changed: !!(urlBefore && urlAfter && urlBefore !== urlAfter), waitedMs: Date.now() - start, urlAfter };
}

const _readUrl = () => (typeof location !== 'undefined' && location.href) || null;

// Wait until the DOM stops structurally changing. Watching childList+subtree
// only: attribute mutations on a page like Amazon are driven by animations and
// carousels and never go quiet, so including them would always burn maxMs.
function waitForDomQuiet({ quietMs = 350, maxMs = 4000, pollMs = 80 } = {}) {
  return new Promise((resolve) => {
    const hasDom = typeof document !== 'undefined' && document && document.documentElement;
    if (typeof MutationObserver === 'undefined' || !hasDom) {
      resolve({ settled: false, waitedMs: 0, reason: 'no MutationObserver' });
      return;
    }
    const start = Date.now();
    let lastMutation = start;
    let mutations = 0;
    let obs;
    try {
      obs = new MutationObserver(() => { mutations++; lastMutation = Date.now(); });
      obs.observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) {
      resolve({ settled: false, waitedMs: 0, reason: 'observe failed: ' + e.message });
      return;
    }
    const finish = (settled, reason) => {
      try { obs.disconnect(); } catch (e) {}
      resolve({ settled, waitedMs: Date.now() - start, mutations, reason: reason || '' });
    };
    const check = () => {
      const now = Date.now();
      if (now - lastMutation >= quietMs) return finish(true);
      if (now - start >= maxMs) return finish(false, 'maxMs');
      setTimeout(check, pollMs);
    };
    check();
  });
}

// Two-phase settle for a real page: wait for the URL to change, then wait for
// the new document to stop rendering. The old fixed 1800ms treated a slow page
// as a dead page, which reported a false failure and fed the model a false
// "your last attempts failed" signal — the cascade that broke the first
// iterations of a run.
async function waitForPageSettled(urlBefore, {
  navMaxMs = 8000,     // a real e-commerce page load can take several seconds
  pollMs = 150,
  quietMs = 350,
  settleMaxMs = 4000,
} = {}) {
  const t0 = Date.now();
  const nav = await waitForNavigation(urlBefore, { maxMs: navMaxMs, pollMs });
  const urlAfter = nav.urlAfter;
  const urlWaitMs = Date.now() - t0;

  // If the document is still loading, that alone justifies waiting for render.
  let settling = { settled: false, waitedMs: 0, reason: 'skipped' };
  const docLoading = typeof document !== 'undefined' && document && document.readyState === 'loading';
  if (nav.changed || docLoading) {
    settling = await waitForDomQuiet({ quietMs, maxMs: settleMaxMs });
  }

  return {
    changed: nav.changed,
    urlAfter,
    urlWaitMs,
    settled: settling.settled,
    settleWaitMs: settling.waitedMs,
    mutations: settling.mutations || 0,
    totalMs: Date.now() - t0,
  };
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
  let prevURL = null;
  let noChangeCount = 0;
  let failureCount = 0;
  let noTransitionCount = 0;

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

    // Compute AT-diff (URL primary, node-count fallback)
    const atDiff = computeATDiff(prevAT, observation.at, prevURL, observation.url);

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
    const reasoning = await reason({ at: observation.at, userGoal, screenshot: observation.screenshot, threshold, atDiff: atDiff ? { nodeCountDelta: atDiff.nodeCountDelta, newNodesCount: atDiff.newNodes.length, stateChangesCount: atDiff.stateChanges.length, pageChanged: atDiff.pageChanged, urlChanged: atDiff.urlChanged, nodeCount: atDiff.nodeCount } : null, iteration, classification: classification.type, executeFailures: failureCount, noTransitionCount });
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
        const urlBefore = (typeof location !== 'undefined' && location.href) || observation.url || null;
        try {
          const execResult = await execute({ actions: reasoning.actions, plan: reasoning.plan, at: observation.at });
          history[history.length - 1].execResult = execResult;
          if (execResult && execResult.success === false && !execResult.denied) {
            failureCount += execResult.failedCount || 1;
            if (onStep) onStep({ step: 'execute_failed', iteration, failedCount: failureCount, results: execResult.results });
          } else {
            if (onStep) onStep({ step: 'executed', iteration, execResult });
            const hasPageTransition = reasoning.actions.some(a =>
              ['submit', 'navigate'].includes((a.type || '').toLowerCase())
            );
            if (hasPageTransition) {
              if (onStep) onStep({ step: 'page_load_wait', iteration });
              const nav = await waitForPageSettled(urlBefore);
              const urlAfter = nav.urlAfter;
              if (urlBefore && urlAfter && urlBefore === urlAfter) {
                noTransitionCount++;
                failureCount = Math.max(failureCount, noTransitionCount);
                if (onStep) onStep({ step: 'transition_failed', iteration, noTransitionCount });
              } else {
                noTransitionCount = 0;
                failureCount = 0;
                if (onStep) onStep({ step: 'page_transitioned', iteration, waitedMs: nav.totalMs, settled: nav.settled });
              }
            } else {
              failureCount = 0;
            }
          }
        } catch (e) {
          failureCount++;
          if (onStep) onStep({ step: 'execute_error', iteration, error: e.message });
        }
      } else {
        if (onStep) onStep({ step: 'executed_stub', iteration });
      }

    const achieved = isGoalAchieved({ at: observation.at, userGoal, iteration, maxIterations, history, atDiff, classification, url: observation.url });
      if (onStep) onStep({ step: 'evaluate', iteration, achieved });
      if (achieved) {
        return { success: true, reason: 'Goal achieved', iteration, history, lastObservation };
      }

      prevAT = observation.at;
      prevURL = observation.url;
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
  // Called with {total, item, label} before an irreversible order commit.
  // Absent or returning false means the order is NOT placed (fail closed).
  confirmPurchaseFn,
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
  let prevURL = null;
  let prevATDiff = null;
  let failureCount = 0;
  let noTransitionCount = 0;
  // Progress accounting, so "stuck" can be attributed honestly.
  let successExecCount = 0;
  let failedExecCount = 0;
  let pageTransitionedRecently = false;
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
    (typeof window !== 'undefined' && window.TrinetraSanitizationEngine ? window.TrinetraSanitizationEngine.runSanitizationPipeline : null) ||
    (typeof self !== 'undefined' && self.TrinetraSanitizationEngine ? self.TrinetraSanitizationEngine.runSanitizationPipeline : null);
  const cloudCall = cloudCallFn || (async ({ sanitizedScreenshot, sanitizedAT, sanitizationReport, sessionId: sid, userGoal: ug, atDiff: ad, classification: cls, iteration: iter, noChangeCount: ncc, executeFailures: ef, noTransitionCount: ntc }) => {
    const res = await fetch(serverUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sanitizedScreenshot, sanitizedAT, sanitizationReport,
        sessionId: sid, userGoal: ug, atDiff: ad, classification: cls,
        iteration: iter, noChangeCount: ncc, executeFailures: ef, noTransitionCount: ntc
      })
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

    // --- Compute AT-diff (URL primary, node-count fallback) ---
    const atDiff = computeATDiff(prevAT, observation.at, prevURL, observation.url);
    if (atDiff) {
      if (onStep) onStep({ step: 'at_diff', iteration, nodeCountDelta: atDiff.nodeCountDelta, newNodes: atDiff.newNodes.length, removedNodes: atDiff.removedNodes.length, stateChanges: atDiff.stateChanges.length, pageChanged: atDiff.pageChanged, urlChanged: atDiff.urlChanged });
      currentSteps.push({ step: 'at_diff', iteration, nodeCountDelta: atDiff.nodeCountDelta, pageChanged: atDiff.pageChanged, urlChanged: atDiff.urlChanged });
    }

    // --- Stuck detection ---
    // "No screen change" is ambiguous on its own: it can mean the page is
    // frozen, or it can mean the agent's own actions did not apply while the
    // page is perfectly healthy. Conflating them produced a "the page is not
    // responding" message on runs whose real problem was failing actions.
    //
    // Two changes: don't arm the counter until the agent has actually
    // succeeded at something (otherwise early setup rounds count as "stuck"),
    // and report the true cause on give-up.
    const screenChanged = atDiff && (atDiff.newNodes.length > 0 || atDiff.removedNodes.length > 0 || atDiff.stateChanges.length > 0 || atDiff.pageChanged);
    const hasProgressed = successExecCount > 0 || pageTransitionedRecently;
    const stallTolerated = !hasProgressed && iteration <= STUCK_GRACE_ITERATIONS;
    if (iteration > 1 && !screenChanged && !stallTolerated) {
      noChangeCount++;
      if (onStep) onStep({ step: 'no_change', iteration, noChangeCount });
      if (noChangeCount >= 3) {
        // Distinguish "my actions are failing" from "the page is dead".
        const cause = successExecCount === 0
          ? `the agent has not yet completed a single action — the target elements could not be found or used`
          : `the agent acted ${successExecCount} time(s) but the screen has not changed since — the plan is not applying to this page`;
        if (onStep) onStep({ step: 'stuck', iteration, reason: cause, successExecCount, failedExecCount });
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
          reason: `No progress after ${iteration} iterations — ${cause}.`,
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
    if (classification.type === 'order' || classification.type === 'auth_gated') {
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
        urlChanged: atDiff.urlChanged,
        nodeCount: atDiff.nodeCount,
      } : null,
      iteration,
      classification: classification.type,
      noChangeCount,
      executeFailures: failureCount,
      noTransitionCount,
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
          // Fail closed: an empty AT rather than the raw tree. Escalating
          // unsanitized data would defeat the project's central guarantee.
          console.warn(`[Trinetra Loop] Sanitization threw (${e.message}) — withholding AT rather than sending it raw`);
          sanitized = { sanitizedScreenshot: observation.screenshot, sanitizedAT: [], report: { redacted_regions: [], sanitized_at_summary: 'sanitizer threw — AT withheld', pipeline_unavailable: true } };
        }
      } else {
        // No sanitizer at all — still refuse to ship the raw tree.
        console.warn('[Trinetra Loop] No sanitization engine available — withholding AT rather than sending it raw');
        sanitized = { sanitizedScreenshot: observation.screenshot, sanitizedAT: [], report: { redacted_regions: [], sanitized_at_summary: 'no sanitizer — AT withheld', pipeline_unavailable: true } };
      }
      if (onStep) onStep({ step: 'sanitized', iteration, report: sanitized.report, sanitizedCount: (sanitized.sanitizedAT || sanitized.sanitized_at || []).length });
      currentSteps.push({ step: 'sanitized', iteration });

      if (onStep) onStep({ step: 'cloud_call', iteration, sessionId });
      try {
        cloudResult = await cloudCall({
          sanitizedScreenshot: sanitized.sanitizedScreenshot || sanitized.sanitized_screenshot || observation.screenshot,
          sanitizedAT: sanitized.sanitizedAT || sanitized.sanitized_at || observation.at,
          sanitizationReport: sanitized.report,
          sessionId,
          userGoal,
          atDiff: atDiff ? {
            nodeCountDelta: atDiff.nodeCountDelta,
            newNodesCount: atDiff.newNodes.length,
            stateChangesCount: atDiff.stateChanges.length,
            pageChanged: atDiff.pageChanged,
            urlChanged: atDiff.urlChanged,
            nodeCount: atDiff.nodeCount,
          } : undefined,
          classification: classification.type,
          iteration,
          noChangeCount,
          executeFailures: failureCount,
          noTransitionCount,
        });
        if (onStep) onStep({ step: 'cloud_result', iteration, cloudResult });
        actionsToExecute = cloudResult.actions || cloudResult.plan || actionsToExecute;
        currentSteps.push({ step: 'cloud_result', iteration });
      } catch (e) {
        if (onStep) onStep({ step: 'cloud_error', iteration, error: e.message });
        currentSteps.push({ step: 'cloud_error', iteration, error: e.message });
        console.log(`[Trinetra Loop] Iteration ${iteration}: cloud failed (${e.message}), falling back to local reasoning`);
        try {
          // Omit classification so cloud-first gate does not re-escalate — use stub plan as offline fallback
          const fallbackReasoning = await reason({ at: observation.at, userGoal, screenshot: observation.screenshot, threshold, atDiff: llmContext.atDiff, iteration, executeFailures: failureCount, noTransitionCount });
          actionsToExecute = fallbackReasoning.actions || fallbackReasoning.plan || [];
          if (onStep) onStep({ step: 'local_fallback', iteration, actions: actionsToExecute, reason: e.message });
          console.log(`[Trinetra Loop] local fallback actions:`, JSON.stringify(actionsToExecute));
        } catch (fallbackErr) {
          console.log(`[Trinetra Loop] Iteration ${iteration}: local fallback also failed (${fallbackErr.message}), no actions`);
          actionsToExecute = [];
        }
      }
    }

    // Escape hatch removed — pure cloud planning (no keyword URL override)

    // --- Purchase safety gate ---
    // Enforced here, not trusted to the planner: a model that decides to type a
    // card number or click "Place your order" is stopped before it reaches the
    // page. Irreversible commits are pulled out of the plan entirely and only
    // re-enter after an explicit, amount-bearing confirmation.
    let purchaseConfirmations = [];
    if (products && actionsToExecute && actionsToExecute.length > 0) {
      const guard = products.guardPurchaseActions(actionsToExecute, observation.at, classification.type);
      if (guard.refused.length) {
        for (const r of guard.refused) {
          console.warn(`[Trinetra Loop] Refused action: ${r.reason}`);
          if (onStep) onStep({ step: 'purchase_refused', iteration, ...r });
          currentSteps.push({ step: 'purchase_refused', iteration, reason: r.reason });
        }
      }
      if (guard.purchaseConfirmations.length) {
        for (const p of guard.purchaseConfirmations) {
          const approved = typeof confirmPurchaseFn === 'function'
            ? await confirmPurchaseFn(p)
            : false; // fail closed: no confirmation handler means no purchase
          if (approved) {
            if (onStep) onStep({ step: 'purchase_approved', iteration, ...p });
            currentSteps.push({ step: 'purchase_approved', iteration, total: p.total, item: p.item });
            // Re-admit the commit with its approval explicitly recorded.
            actionsToExecute = actionsToExecute.concat([{
              id: `purchase-${iteration}`,
              type: 'click',
              requires_approval: false,
              _purchaseApproved: { total: p.total, item: p.item },
              target: { mode: 'semantic', value: p.label || p.type },
              params: {},
            }]);
          } else {
            const why = 'Purchase not confirmed — stopping before the order is placed.';
            console.log(`[Trinetra Loop] ${why}`);
            if (onStep) onStep({ step: 'purchase_declined', iteration, ...p });
            currentSteps.push({ step: 'purchase_declined', iteration });
            return {
              success: false,
              reason: why,
              iteration,
              history,
              lastObservation,
              sessionId,
              classification,
              purchaseTotal: p.total,
            };
          }
        }
        purchaseConfirmations = guard.purchaseConfirmations;
      }
      if (guard.actions && guard.actions.length !== actionsToExecute.length) {
        actionsToExecute = guard.actions.concat(actionsToExecute.slice(guard.actions.length));
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
          const urlBefore = (typeof location !== 'undefined' && location.href) || observation.url || null;
          try {
            const execResult = await execute({ actions: actionsToExecute, plan: actionsToExecute, at: observation.at });
            history[history.length - 1].execResult = execResult;
            if (execResult && execResult.success === false && !execResult.denied) {
              failureCount += execResult.failedCount || 1;
              failedExecCount++;
              if (onStep) onStep({ step: 'execute_failed', iteration, failedCount: failureCount, results: execResult.results, source: reasoning.needs_escalation ? 'cloud' : 'local' });
              currentSteps.push({ step: 'execute_failed', iteration, failedCount: failureCount });
            } else if (execResult && execResult.denied) {
              // The user declined — that is a deliberate halt, not a failure to
              // retry, so it must not feed the "keep escalating" signals.
              if (onStep) onStep({ step: 'execute_denied', iteration });
              currentSteps.push({ step: 'execute_denied', iteration });
            } else {
              successExecCount++;
              pageTransitionedRecently = false;
              if (onStep) onStep({ step: 'executed', iteration, execResult, source: reasoning.needs_escalation ? 'cloud' : 'local' });
              currentSteps.push({ step: 'executed', iteration, execResult });
            }
            // If submit or navigate was executed, wait for page to load, then VERIFY URL changed
            const hasPageTransition = actionsToExecute.some(a =>
              ['submit', 'navigate'].includes((a.type || '').toLowerCase())
            );
            if (hasPageTransition) {
              if (onStep) onStep({ step: 'page_load_wait', iteration });
              const nav = await waitForPageSettled(urlBefore);
              const urlAfter = nav.urlAfter;
              if (urlBefore && urlAfter && urlBefore === urlAfter) {
                // Phantom success: actions claimed success but the page never navigated.
                // Only count this as a failure if the page was genuinely given time to
                // load — a page that changed but was still rendering is not a failure.
                noTransitionCount++;
                failureCount = Math.max(failureCount, noTransitionCount);
                if (onStep) onStep({ step: 'transition_failed', iteration, noTransitionCount, url: urlAfter, waitedMs: nav.totalMs, settled: nav.settled });
                currentSteps.push({ step: 'transition_failed', iteration, noTransitionCount });
                console.log(`[Trinetra Loop] Iteration ${iteration}: transition failed (URL unchanged ×${noTransitionCount} after ${nav.totalMs}ms, settled=${nav.settled})`);
              } else if (urlBefore && urlAfter && urlBefore !== urlAfter) {
                noTransitionCount = 0;
                failureCount = 0;
                // Arriving somewhere new is genuine progress — reset the stall
                // counter so a legitimate page change is never read as "stuck".
                pageTransitionedRecently = true;
                noChangeCount = 0;
                if (onStep) onStep({ step: 'page_transitioned', iteration, url: urlAfter, waitedMs: nav.totalMs, settled: nav.settled });
                currentSteps.push({ step: 'page_transitioned', iteration });
                console.log(`[Trinetra Loop] Iteration ${iteration}: navigated in ${nav.totalMs}ms (url ${nav.urlWaitMs}ms, settle ${nav.settleWaitMs}ms) → ${urlAfter}`);
              } else {
                // URL unavailable — no signal, don't penalize
                failureCount = execResult && execResult.success === false ? failureCount : 0;
              }
            } else {
              // No page transition planned — reset transition failures on clean exec
              if (execResult && execResult.success !== false) failureCount = 0;
            }
          } catch (e) {
            failureCount++;
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
    const achieved = isGoalAchieved({ at: observation.at, userGoal, iteration, maxIterations, history, atDiff, classification, url: observation.url });
    if (onStep) onStep({ step: 'evaluate', iteration, achieved, classification: classification.type, atDiffChanged: !!screenChanged });
    currentSteps.push({ step: 'evaluate', iteration, achieved });
    if (achieved) {
      return { success: true, reason: 'Goal achieved', iteration, history, lastObservation, sessionId, cloudResult, classification, successExecCount, failedExecCount, purchaseTotal: purchaseConfirmations.length ? purchaseConfirmations[0].total : null };
    }

    // --- Update prevAT/prevURL for next iteration's diff ---
    prevAT = observation.at;
    prevURL = observation.url;
    prevATDiff = atDiff;

    // --- Stall counter ---
    const lastStep = currentSteps.length > 0 ? currentSteps[currentSteps.length - 1] : null;
    const tookValidAction = achieved || (lastStep && !['no_actions', 'cloud_error', 'execute_failed', 'transition_failed'].includes(lastStep.step));
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

    await new Promise(r => setTimeout(r, 100));
  }

  return {
    success: false,
    reason: 'Max iterations reached',
    iteration,
    history,
    lastObservation,
    sessionId,
    successExecCount,
    failedExecCount,
  };
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

// Build a direct navigate action to the site's search results URL from the real search form.
// Site-agnostic: uses form action + input name (Amazon /s?k=, Flipkart /search?q=, etc.)
function buildSearchNavigateAction(userGoal) {
  if (typeof document === 'undefined' || typeof location === 'undefined') return null;
  try {
    const stopWords = new Set(['the','and','for','with','under','below','above','over','good','best',
      'fetch','get','show','find','search','want','need','me','a','an','in','on','at','to','from',
      'please','can','you','give','look','lakh','rupees','rs']);
    const words = (userGoal || '').toLowerCase().split(/\W+/).filter(w => w.length > 2 && !stopWords.has(w));
    const term = words.join(' ') || (userGoal || '').trim();
    if (!term) return null;

    const form = document.querySelector('#nav-search-bar-form') ||
                 document.querySelector('form[action*="/s"]') ||
                 document.querySelector('form[action*="search"]') ||
                 document.querySelector('form[role="search"]') ||
                 null;
    let url;
    if (form && form.action) {
      url = new URL(form.action, location.origin);
      const input = form.querySelector('input[name]');
      const paramName = input ? input.name : (url.searchParams.has('k') ? 'k' : 'q');
      // Clear existing search params and set ours
      url.search = '';
      url.searchParams.set(paramName, term);
    } else {
      // No form — generic search path heuristics
      const host = location.hostname;
      if (/amazon\./.test(host)) {
        url = new URL('https://' + host + '/s');
        url.searchParams.set('k', term);
      } else if (/flipkart\./.test(host)) {
        url = new URL('https://' + host + '/search');
        url.searchParams.set('q', term);
      } else if (/myntra\./.test(host)) {
        url = new URL('https://' + host + '/search');
        url.searchParams.set('q', term);
      } else {
        return null;
      }
    }
    const href = url.href;
    if (!isValidNavigateURL(href)) return null;
    return {
      id: `nav-fallback-${Date.now().toString(36)}`,
      type: 'navigate',
      requires_approval: false,
      target: { mode: 'css_selector', value: href },
      params: { url: href },
    };
  } catch (e) {
    return null;
  }
}

// ========== RUN SUMMARY (presentation logic) ==========
// Pure functions so the panel only has to render what these return, and so the
// classification can be unit tested. Note we never infer success by regexing
// the model's prose — a successful run whose reasoning mentions "failed" used
// to be rendered as a failure.

// Pull a product-ish noun out of the goal so follow-ups can name the thing the
// user actually asked about ("cheapest laptop" -> "laptop").
function extractProductNoun(userGoal) {
  const skip = new Set([
    'the', 'a', 'an', 'and', 'or', 'for', 'with', 'under', 'below', 'above', 'over',
    'find', 'show', 'search', 'look', 'browse', 'get', 'want', 'need', 'please',
    'cheapest', 'best', 'good', 'nice', 'cheap', 'cheaper', 'buy', 'purchase', 'order',
    'open', 'click', 'go', 'visit', 'navigate', 'price', 'prices', 'sort', 'filter',
    'me', 'my', 'can', 'you', 'new', 'used', 'all', 'any', 'some', 'of', 'in', 'on',
    'to', 'from', 'at', 'is', 'are', 'do', 'does', 'i', 'it', 'that', 'this', 'list',
  ]);
  const words = (userGoal || '').toLowerCase().split(/\W+/).filter(Boolean);
  for (const w of words) {
    if (w.length < 3) continue;
    if (skip.has(w)) continue;
    if (/\d/.test(w)) continue;                 // budget numbers are not nouns
    if (/^(is|are|ing|ed|ly)$/.test(w)) continue;
    return w;
  }
  return '';
}

// Contextual next steps, chosen from how the goal was classified.
function buildFollowUps(classification, userGoal) {
  const noun = extractProductNoun(userGoal);
  const n = noun ? noun + 's' : 'results';
  switch (classification) {
    case 'search':
      return [
        'Sort these ' + n + ' by price',
        'Filter to 4 stars and above',
        noun ? 'Show me the second-cheapest ' + noun : 'Show me a cheaper option',
      ];
    case 'info':
      return [
        'Summarise what you found',
        'Compare it with alternatives',
        'Show me the details',
      ];
    case 'navigate':
      return [
        'Go back to the previous page',
        'Open the next item in this list',
        'Show related items',
      ];
    case 'action':
      return [
        'Undo the last action',
        'Repeat the last action',
        'Show me what changed',
      ];
    case 'order':
    case 'auth_gated':
      return [
        'Show my cart',
        'Show my orders',
        'Start a new goal',
      ];
    default:
      return [
        'Run a new goal',
        'Show me what the agent did',
        'Start over',
      ];
  }
}

// Build everything the panel needs to render a finished run.
function buildResultSummary(result = {}, userGoal = '') {
  const success = result.success === true;
  const iteration = Number(result.iteration) || 0;
  const history = Array.isArray(result.history) ? result.history : [];

  const classification =
    (result.classification && result.classification.type) ||
    (history[0] && history[0].classification && history[0].classification.type) ||
    (typeof classifyQuery === 'function' ? classifyQuery(userGoal).type : '') ||
    '';

  // Tally what actually happened, for an honest one-line summary.
  let actionsRun = 0, failedRuns = 0, escalations = 0;
  for (const h of history) {
    if (h.escalated) escalations++;
    if (h.execResult && Array.isArray(h.execResult.results)) {
      actionsRun += h.execResult.results.length;
      if (h.execResult.success === false) failedRuns++;
    }
  }

  const cloudResult = result.cloudResult || null;
  const degraded = !!(cloudResult && cloudResult.degraded);
  const lastReasoning =
    (cloudResult && (cloudResult.explanation || cloudResult.reasoning)) ||
    (history.length && history[history.length - 1].reasoning &&
      (history[history.length - 1].reasoning.explanation || history[history.length - 1].reasoning.reasoning)) ||
    '';

  const lines = [];
  if (success) {
    lines.push(
      'Completed in ' + iteration + ' iteration' + (iteration === 1 ? '' : 's') +
      (actionsRun ? ' · ' + actionsRun + ' action' + (actionsRun === 1 ? '' : 's') : '')
    );
    if (escalations) lines.push('Escalated to the cloud brain ' + escalations + ' time' + (escalations === 1 ? '' : 's'));
    if (degraded) lines.push('Cloud brain was unavailable — the local rule engine produced the plan');
    if (failedRuns) lines.push(failedRuns + ' iteration' + (failedRuns === 1 ? '' : 's') + ' needed a retry before succeeding');
  } else {
    lines.push('Stopped after ' + iteration + ' iteration' + (iteration === 1 ? '' : 's') + ' · ' + (result.reason || 'no result'));
  }

  return {
    success,
    title: success ? 'Task completed' : 'Task stopped',
    classification,
    iterations: iteration,
    actionsRun,
    escalations,
    degraded,
    // The panel renders this body verbatim; keep it short and factual.
    body: lines.join('\n') + (lastReasoning && success ? '\n\n' + String(lastReasoning).slice(0, 600) : ''),
    // Only offer next steps when the run actually finished its goal.
    followUps: success ? buildFollowUps(classification, userGoal) : [],
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { runLocalLoop, runFullLoop, observePage, waitForNavigation, waitForPageSettled, isGoalAchieved, computeATDiff, classifyQuery, extractGoalKeywords, atContainsKeywords, detectAuthPage, buildSearchNavigateAction, isValidNavigateURL, extractProductNoun, buildFollowUps, buildResultSummary, MAX_ITERATIONS, DEFAULT_THRESHOLD };
}
if (typeof window !== 'undefined') {
  window.TrinetraWorkflowLoop = { runLocalLoop, runFullLoop, observePage, isGoalAchieved, computeATDiff, classifyQuery, buildSearchNavigateAction, isValidNavigateURL, extractProductNoun, buildFollowUps, buildResultSummary, waitForPageSettled };
}
if (typeof self !== 'undefined') {
  self.TrinetraWorkflowLoop = { runLocalLoop, runFullLoop, observePage, isGoalAchieved, computeATDiff, classifyQuery, buildSearchNavigateAction, isValidNavigateURL, extractProductNoun, buildFollowUps, buildResultSummary, waitForPageSettled };
}


})();