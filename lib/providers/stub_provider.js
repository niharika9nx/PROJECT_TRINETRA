// Trinetra — Stub Provider (Phase 4)
// Deterministic, rule-based mocks for LocalLLMProvider and LocalVLMProvider.
// No ML dependency — plain JS keyword heuristics, satisfying exact schemas from 2.2 and 3.
// Used through Phases 1–12; RealProvider replaces this in Phase 13 behind same interface.

(function () {

// Product helpers (lib/products.js), resolved the same way as everywhere else:
// require in Node, window/self in the bundle.
let products = null;
if (typeof require !== 'undefined') {
  try { products = require('../products.js'); } catch (e) {}
}
if (!products) {
  const g = (typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null));
  if (g && g.TrinetraProducts) products = g.TrinetraProducts;
}

function uuid() {
  // Simple deterministic-ish UUID for stub; not cryptographically strong
  return 'stub-' + Math.random().toString(36).slice(2, 9);
}

function isSearchNode(n) {
  if (!n) return false;
  if (n.role === 'searchbox' || n.role === 'combobox') return true;
  if (n.name && /search|query/i.test(n.name)) return true;
  if (n.selector && /search/i.test(n.selector)) return true;
  // input only counts if it's clearly a search input (name/selector/id)
  if (n.tag === 'input') {
    return /search|query/i.test(n.name || '') ||
           /search/i.test(n.selector || '') ||
           /search/i.test(n.id || '');
  }
  return false;
}

function hasSearchElementsInAT(at) {
  return Array.isArray(at) && at.some(isSearchNode);
}

// Confidence is a 0-1 scale, matching model_provider_interface.js validateActionPlan
// and the plan.md Action Plan schema. Default gate is 0.7 (README / plan.md §3).
// Values are chosen so the 0.7 gate produces the intended routing:
//   < 0.7  -> escalate to cloud      (no search UI, ambiguous, too short)
//   >= 0.7 -> execute locally        (search UI present, price/laptop, generic)
function confidenceForGoal(userGoal, at) {
  const g = (userGoal || '').toLowerCase();
  if (g.includes('compare') || g.includes('summarize') || g.includes('complex') || g.includes('ambiguous') || g.includes('uncertain')) {
    return 0.5;
  }
  // Find/search/fetch/shopping intent: local stub can handle it when the AT
  // actually contains a search form. Missing search UI → escalate to cloud.
  if (/find|search|fetch|get|show|want|need|recommend|suggest|buy|purchase|order|keychain|under|below|browse|look\s*for/i.test(g)) {
    return hasSearchElementsInAT(at) ? 0.75 : 0.3;
  }
  if (g.includes('price') || g.includes('laptop') || g.includes('cheapest') || g.includes('filter') || g.includes('scroll') || g.includes('lakh')) {
    return 0.85;
  }
  if (g.trim().length < 5) return 0.3;
  return 0.75;
}

const StubLLMProvider = {
  // Section 2.2: plan({ at, userGoal, visualContext? }) → { plan, confidence, needs_escalation, version, source, actions, reasoning }
  async plan({ at, userGoal, visualContext, threshold = 0.7 } = {}) {
    const goal = userGoal || '';
    const lower = goal.toLowerCase();
    const confidence = confidenceForGoal(goal, at);
    // 0-1 scale: below threshold → cloud escalation
    const needs_escalation = confidence < threshold;
    // Check if AT contains search form elements (search-specific only — not any <input>)
    const hasSearch = hasSearchElementsInAT(at);
    const searchTerm = hasSearch ? null : 'not_found';

    let actions = [];
    let reasoning = '';

    // hasSearchAT: if AT lacks search form elements and goal involves find/search, defer to cloud
    const hasSearchForm = hasSearch;
    const hasFindOrSearch = /find|search|fetch|get|show|want|need|recommend|suggest|buy|purchase|order|keychain|under|below|browse|look\s*for/i.test(lower);
    if (hasFindOrSearch && !hasSearchForm) {
      return {
        version: '1.0', source: 'local', confidence: 0.3,
        needs_escalation: true, effectiveThreshold: threshold,
        needs_vlm: false, vlm_reason: '', vlm_flag_displayed: false,
        plan: [], actions: [],
        reasoning: 'AT lacks search form elements — deferring to cloud agent to locate the search bar',
        visualContextUsed: false, threshold, raw: {}
      };
    }

    // Helper: pick real AT node IDs so execute resolves on real pages (Amazon demo)
    function findATNode(predicate) {
      if (Array.isArray(at) && at.length > 0) {
        const found = at.find(predicate);
        if (found && found.id) return found.id;
        // fallback to first visible interactive or any node
        const anyInteractive = at.find(n => ['button','link','textbox','combobox','searchbox'].includes(n.role) || n.tag === 'input' || n.tag === 'a' || n.tag === 'button');
        if (anyInteractive) return anyInteractive.id;
        return at[0].id;
      }
      return null;
    }
    function priceNodeId() {
      const pn = Array.isArray(at) ? at.find(n => /₹|rs\.?|price|\d{3,}/i.test(n.name || '')) : null;
      return pn ? pn.id : findATNode(() => true);
    }

    // Query understanding: prioritize search intent (Find me a laptop...)
    // For "Find me a laptop under 1 lakh" on homepage, must search first, not directly click price
    const hasFind = /find|search|fetch|get|show|want|need|recommend|suggest|buy|purchase|order|keychain|under|below|browse|look\s*for/i.test(lower);
    // Generic: extract meaningful content words for type text — KEEP constraints (under, lakh, budget…)
    function extractSearchTerm(q) {
      const stop = new Set(['the','and','for','with','above','over','good','best','fetch','get','show',
        'find','search','want','need','me','a','an','in','on','at','to','from','please','can','you','give','look']);
      const words = (q || '').toLowerCase().split(/\W+/).filter(w => (w.length > 1 || /\d/.test(w)) && !stop.has(w));
      return words.join(' ') || (q || '').trim();
    }
    // Generic offline rule: if goal names a noun and AT has interactive node matching it → click that node
    // (covers "open my cart" when cloud is down — not cart-specific, any noun works)
    function findGoalNounNode() {
      if (!Array.isArray(at) || at.length === 0) return null;
      const interactive = n => ['link','button','textbox','searchbox','combobox'].includes(n.role) || n.tag === 'a' || n.tag === 'button' || n.tag === 'input';
      const goalWords = lower.split(/\W+/).filter(w => w.length > 2 && !['the','and','for','with','open','please','show','find'].includes(w));
      for (const w of goalWords) {
        const hit = at.find(n => interactive(n) && new RegExp(`\\b${w}\\b`, 'i').test(n.name || ''));
        if (hit) return hit;
      }
      return null;
    }

    // Select-one-product: on a results page, actually choose one product and
    // click it, instead of stopping at the results list.
    if (products && /open|show|select|pick|choose|best|cheapest|top/.test(lower)) {
      const found = products.extractProducts(at);
      if (found.length > 0) {
        const sel = products.pickBestProduct(found, goal);
        if (sel && sel.product) {
          actions = [
            { id: uuid(), type: 'click', requires_approval: false, target: { mode: 'at_node_id', value: sel.product.id }, params: {} }
          ];
          reasoning = `Stub: ${found.length} products on this page; opening "${sel.product.title.slice(0, 60)}" — ${sel.reason}.`;
        }
      } else if (hasSearchElementsInAT(at)) {
        // No results yet — search first.
        const searchId = findATNode(isSearchNode);
        const searchTarget = searchId ? { mode: 'at_node_id', value: searchId } : { mode: 'semantic', value: 'search' };
        const term = extractSearchTerm(goal);
        actions = [
          { id: uuid(), type: 'click', requires_approval: false, target: searchTarget, params: {} },
          { id: uuid(), type: 'type', requires_approval: true, target: searchTarget, params: { text: term } },
          { id: uuid(), type: 'submit', requires_approval: false, target: searchTarget, params: {} }
        ];
        reasoning = `Stub: selection goal with no results yet — searching for "${term}" first.`;
      }
    }

    // Rule-based plans for at least 3 sample goal families (covers Phase 4 DoD)
    if (actions.length > 0) {
      // Product selection already produced a plan.
    } else if (hasFind && (lower.includes('laptop') || lower.includes('cheapest') || lower.includes('price') || lower.includes('under') || /\d/.test(lower))) {
      // Find + price/constraint: type FULL phrase (keep budget words), then submit
      const searchId = findATNode(isSearchNode);
      const searchTarget = searchId ? { mode: 'at_node_id', value: searchId } : { mode: 'semantic', value: 'search' };
      const term = extractSearchTerm(goal);
      actions = [
        { id: uuid(), type: 'click', requires_approval: false, target: searchTarget, params: {} },
        { id: uuid(), type: 'type', requires_approval: true, target: searchTarget, params: { text: term } },
        { id: uuid(), type: 'submit', requires_approval: false, target: searchTarget, params: {} }
      ];
      reasoning = `Stub: Find+constraint query; plan click searchbox → type full phrase "${term}" → submit (constraints preserved for results filtering).`;
    } else if (hasFind) {
      const searchId = findATNode(isSearchNode);
      const searchTarget = searchId ? { mode: 'at_node_id', value: searchId } : { mode: 'semantic', value: 'search' };
      const term = extractSearchTerm(goal);
      actions = [
        { id: uuid(), type: 'click', requires_approval: false, target: searchTarget, params: {} },
        { id: uuid(), type: 'type', requires_approval: false, target: searchTarget, params: { text: term } },
        { id: uuid(), type: 'submit', requires_approval: false, target: searchTarget, params: {} }
      ];
      reasoning = `Stub: search/fetch goal detected; plan click searchbox → type "${term}" → submit search.`;
    } else if (lower.includes('login') || lower.includes('password') || lower.includes('payment') || lower.includes('pay')) {
      actions = [
        { id: uuid(), type: 'type', requires_approval: true, target: { mode: 'css_selector', value: 'input[type=password]' }, params: { text: '[REDACTED]' } },
        { id: uuid(), type: 'submit', requires_approval: true, target: { mode: 'css_selector', value: 'form' }, params: {} }
      ];
      reasoning = 'Stub: sensitive action detected; plan type→submit both require approval.';
    } else {
      // Generic offline fallback: try to click AT node matching goal noun (e.g. cart, settings, orders)
      const nounNode = findGoalNounNode();
      if (nounNode) {
        actions = [
          { id: uuid(), type: 'click', requires_approval: false, target: { mode: 'at_node_id', value: nounNode.id }, params: {} }
        ];
        reasoning = `Stub: offline — found interactive AT node matching goal noun: "${(nounNode.name || '').slice(0, 60)}". Clicking it.`;
      } else {
        actions = [
          { id: uuid(), type: 'read', requires_approval: false, target: null, params: {} },
          { id: uuid(), type: 'scroll', requires_approval: false, target: null, params: { amount: 300 } }
        ];
        reasoning = `Stub: generic goal "${goal.slice(0, 60)}"; no matching AT node — plan read→scroll. VisualContext ${visualContext ? 'present' : 'absent'}.`;
      }
    }

    // If AT is empty and no visualContext, signal AT insufficient by lowering confidence slightly
    if ((!at || at.length === 0) && !visualContext) {
      // keep as fallback trigger for Phase 5, but do not break schema
      reasoning += ' AT appears empty — fallback VLM may help.';
    }

    const plan = actions; // alias for Section 2.2 example shape

    return {
      version: '1.0',
      source: 'local',
      confidence,
      needs_escalation,
      plan,
      actions,
      reasoning,
      visualContextUsed: !!visualContext
    };
  },

  // Section 3 Stage 2: classifyPII(detections) → enriched detections with sensitivity + strategy
  async classifyPII(detections = []) {
    return detections.map((d) => {
      let sensitivity = 'medium';
      let strategy = 'mask';
      if (d.type === 'face' || d.type === 'profile_photo') {
        sensitivity = 'high';
        strategy = 'blur';
      } else if (d.type === 'password_field' || d.type === 'password' || d.type === 'credit_card') {
        sensitivity = 'critical';
        strategy = 'blackout';
      } else if (d.type === 'email' || d.type === 'phone') {
        sensitivity = 'high';
        strategy = 'mask';
      } else if (d.type === 'name' || d.type === 'address') {
        sensitivity = 'medium';
        strategy = 'mask';
      }
      // Simple false-positive filter: drop low confidence <0.5
      if (d.confidence !== undefined && d.confidence < 0.5) return null;
      // Preserve the `grounded` flag — dropping it here would make the engine
      // paint ungrounded fixture coordinates onto real screenshots.
      return { ...d, sensitivity, strategy };
    }).filter(Boolean);
  }
};

const StubVLMProvider = {
  // Section 2.2 fallback: analyze({ screenshot }) → { elements, bboxes, ocrText, labels }
  async analyze({ screenshot } = {}) {
    // Deterministic fake visual context — not dependent on real image
    return {
      elements: [
        { id: 'vlm_0', label: 'search_box', bbox: [100, 80, 400, 40], confidence: 0.92 },
        { id: 'vlm_1', label: 'product_card', bbox: [120, 200, 280, 180], confidence: 0.88 },
        { id: 'vlm_2', label: 'price_tag', bbox: [130, 320, 120, 24], confidence: 0.9 }
      ],
      bboxes: [[100, 80, 400, 40], [120, 200, 280, 180], [130, 320, 120, 24]],
      ocrText: 'Sample OCR: Search products, ₹60,000, Add to cart',
      labels: ['search_box', 'product_card', 'price_tag']
    };
  },

  // Section 3 Stage 1: detectPII(screenshot) → [{ bbox, type, confidence }]
  async detectPII(screenshot) {
    // Fixed fixture regions for pipeline testing. These coordinates do NOT
    // correspond to anything in a real screenshot, so they are marked
    // `grounded: false` — the sanitization engine will not paint them.
    return [
      { bbox: [120, 200, 150, 50], type: 'face', confidence: 0.96, grounded: false },
      { bbox: [300, 450, 200, 30], type: 'password_field', confidence: 0.99, grounded: false },
      { bbox: [50, 500, 180, 28], type: 'email', confidence: 0.88, grounded: false }
    ];
  }
};

// Config flag wiring
const MODEL_BACKEND = 'stub';

// Registry helper
function createStubRegistry() {
  // Lazy import to avoid circular dep if interface not yet loaded
  let Registry;
  try {
    Registry = require('./model_provider_interface.js').ModelProviderRegistry;
  } catch (e) {
    Registry = null;
  }
  if (Registry) {
    return new Registry({ llmProvider: StubLLMProvider, vlmProvider: StubVLMProvider, backend: 'stub' });
  }
  return { llmProvider: StubLLMProvider, vlmProvider: StubVLMProvider, backend: 'stub' };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { StubLLMProvider, StubVLMProvider, MODEL_BACKEND, createStubRegistry };
}
if (typeof window !== 'undefined') {
  window.TrinetraStubProvider = { StubLLMProvider, StubVLMProvider, MODEL_BACKEND, createStubRegistry };
}
if (typeof self !== 'undefined') {
  self.TrinetraStubProvider = { StubLLMProvider, StubVLMProvider, MODEL_BACKEND, createStubRegistry };
}


})();