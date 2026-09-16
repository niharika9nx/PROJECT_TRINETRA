// Trinetra — Stub Provider (Phase 4)
// Deterministic, rule-based mocks for LocalLLMProvider and LocalVLMProvider.
// No ML dependency — plain JS keyword heuristics, satisfying exact schemas from 2.2 and 3.
// Used through Phases 1–12; RealProvider replaces this in Phase 13 behind same interface.

function uuid() {
  // Simple deterministic-ish UUID for stub; not cryptographically strong
  return 'stub-' + Math.random().toString(36).slice(2, 9);
}

function confidenceForGoal(userGoal) {
  const g = (userGoal || '').toLowerCase();
  // 5-point confidence scale; threshold is 2 (below 2 → cloud escalation)
  if (g.includes('compare') || g.includes('summarize') || g.includes('complex') || g.includes('ambiguous') || g.includes('uncertain')) {
    return 2;
  }
  // Find/search intent goes to Gemini for proper query understanding + search box handling
  if (g.includes('find') || g.includes('search')) {
    return 1;
  }
  if (g.includes('price') || g.includes('laptop') || g.includes('cheapest') || g.includes('filter') || g.includes('scroll') || g.includes('lakh')) {
    return 4;
  }
  if (g.trim().length < 5) return 1;
  return 3;
}

const StubLLMProvider = {
  // Section 2.2: plan({ at, userGoal, visualContext? }) → { plan, confidence, needs_escalation, version, source, actions, reasoning }
  async plan({ at, userGoal, visualContext, threshold = 2 } = {}) {
    const goal = userGoal || '';
    const lower = goal.toLowerCase();
    const confidence = confidenceForGoal(goal);
    // 5-point scale: below threshold → cloud escalation (default threshold = 2)
    const needs_escalation = confidence < threshold;
    // Check if AT contains search form elements
    const hasSearch = Array.isArray(at) && at.some(n =>
      n.role === 'searchbox' || n.role === 'combobox' || n.tag === 'input' ||
      (n.name && /search|query|find/i.test(n.name)) ||
      (n.tag === 'form' && n.name && /search/i.test(n.name))
    );
    const searchTerm = hasSearch ? null : 'not_found';

    let actions = [];
    let reasoning = '';

    // hasSearchAT: if AT lacks search form elements and goal involves find/search, defer to cloud
    const hasSearchForm = Array.isArray(at) && at.some(n =>
      n.role === 'searchbox' || n.role === 'combobox' || n.tag === 'input' ||
      (n.name && /search|query|find/i.test(n.name)) || n.tag === 'form'
    );
    const hasFindOrSearch = lower.includes('find') || lower.includes('search');
    if (hasFindOrSearch && !hasSearchForm) {
      return {
        version: '1.0', source: 'local', confidence: 1,
        needs_escalation: true, effectiveThreshold: 2,
        needs_vlm: false, vlm_reason: '', vlm_flag_displayed: false,
        plan: [], actions: [],
        reasoning: 'AT lacks search form elements — deferring to cloud agent to navigate to amazon.in and locate search bar',
        visualContextUsed: false, threshold: 2, raw: {}
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
    const hasFind = lower.includes('find') || lower.includes('search');
    const hasLaptop = lower.includes('laptop') || lower.includes('cheapest') || lower.includes('price') || lower.includes('lakh');
    // Helper to extract search term from query (e.g., "laptop" from "Find me a laptop under 1 lakh")
    function extractSearchTerm(q) {
      const lowerQ = q.toLowerCase();
      // look for product keywords
      const products = ['laptop','phone','mobile','shoes','book','headphone','earphone','watch','camera','tablet'];
      for (const p of products) if (lowerQ.includes(p)) return p;
      // fallback: first meaningful word after find/search
      const m = lowerQ.match(/find.*?a\s+(\w+)|search\s+(\w+)/);
      if (m) return m[1] || m[2];
      return 'laptop';
    }
    // Rule-based plans for at least 3 sample goal families (covers Phase 4 DoD)
    if (hasFind && hasLaptop) {
      // Find + price: first iteration search, later iterations will handle price filtering via Gemini/local
      const searchId = findATNode(n => /search/i.test(n.name || '') || n.role === 'searchbox' || n.role === 'combobox' || n.tag === 'input');
      const searchTarget = searchId ? { mode: 'at_node_id', value: searchId } : { mode: 'css_selector', value: 'input[type=search],input[name=\"q\"],input[placeholder*=\"Search\"]' };
      const term = extractSearchTerm(goal);
      actions = [
        { id: uuid(), type: 'click', requires_approval: false, target: searchTarget, params: {} },
        { id: uuid(), type: 'type', requires_approval: true, target: searchTarget, params: { text: term } },
        { id: uuid(), type: 'submit', requires_approval: false, target: searchTarget, params: {} }
      ];
      reasoning = `Stub: Find+price query detected; plan click searchbox → type "${term}" → submit to search for ${term} (will filter <1 lakh in next step via Gemini).`;
    } else if (lower.includes('laptop') || lower.includes('cheapest') || lower.includes('price') || lower.includes('lakh')) {
      // E-commerce price task — use real AT IDs so click/scroll resolves (after search)
      const pid = priceNodeId();
      const scrollTarget = pid ? { mode: 'at_node_id', value: pid } : null;
      const clickTarget = pid ? { mode: 'at_node_id', value: pid } : findATNode(n => /search/i.test(n.name || '')) ? { mode: 'at_node_id', value: findATNode(n => /search/i.test(n.name || '')) } : null;
      actions = [
        { id: uuid(), type: 'scroll', requires_approval: false, target: scrollTarget, params: { amount: 600 } },
        { id: uuid(), type: 'click', requires_approval: false, target: clickTarget, params: {} },
        { id: uuid(), type: 'read', requires_approval: false, target: null, params: {} }
      ];
      reasoning = 'Stub: identified price-related goal; plan scroll→click→read to locate cheapest item (real AT IDs).';
    } else if (lower.includes('search') || lower.includes('find') || lower.includes('navigate')) {
      const searchId = findATNode(n => /search/i.test(n.name || '') || n.role === 'searchbox' || n.tag === 'input');
      const searchTarget = searchId ? { mode: 'at_node_id', value: searchId } : { mode: 'css_selector', value: 'input[type=search]' };
      actions = [
        { id: uuid(), type: 'click', requires_approval: false, target: searchTarget, params: {} },
        { id: uuid(), type: 'type', requires_approval: true, target: searchTarget, params: { text: goal } },
        { id: uuid(), type: 'navigate', requires_approval: false, target: { mode: 'css_selector', value: 'a' }, params: { url: 'https://example.com/search?q=' + encodeURIComponent(goal) } }
      ];
      reasoning = 'Stub: search/navigate goal; plan click→type (needs approval)→navigate (real AT searchbox if found).';
    } else if (lower.includes('login') || lower.includes('password') || lower.includes('payment') || lower.includes('pay')) {
      actions = [
        { id: uuid(), type: 'type', requires_approval: true, target: { mode: 'css_selector', value: 'input[type=password]' }, params: { text: '[REDACTED]' } },
        { id: uuid(), type: 'submit', requires_approval: true, target: { mode: 'css_selector', value: 'form' }, params: {} }
      ];
      reasoning = 'Stub: sensitive action detected; plan type→submit both require approval.';
    } else {
      // Generic fallback
      actions = [
        { id: uuid(), type: 'read', requires_approval: false, target: { mode: 'at_node_id', value: 'node_0' }, params: {} },
        { id: uuid(), type: 'scroll', requires_approval: false, target: null, params: { amount: 300 } }
      ];
      reasoning = `Stub: generic goal "${goal.slice(0, 60)}"; plan read→scroll. VisualContext ${visualContext ? 'present' : 'absent'}.`;
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
    // Return small fixture set of fake PII regions for pipeline testing
    // Do not inspect screenshot — deterministic
    return [
      { bbox: [120, 200, 150, 50], type: 'face', confidence: 0.96 },
      { bbox: [300, 450, 200, 30], type: 'password_field', confidence: 0.99 },
      { bbox: [50, 500, 180, 28], type: 'email', confidence: 0.88 }
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
