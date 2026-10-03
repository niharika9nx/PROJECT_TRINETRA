// Step 2 — REASON: confidence gate + stub plan schema + reasonLocally threshold behavior
const assert = require('assert');
const { StubLLMProvider } = require('../lib/providers/stub_provider.js');
const { reasonLocally, setLLMProvider } = require('../lib/local_reasoning.js');

setLLMProvider(StubLLMProvider);

const searchAT = [
  { id: 'n0', role: 'searchbox', name: 'Search Amazon', tag: 'input', state: {} },
  { id: 'n1', role: 'button', name: 'Go', tag: 'button', state: {} },
  { id: 'n2', role: 'link', name: 'Laptops', tag: 'a', state: {} },
];
const emptyAT = [];

(async () => {
  // --- Bug 2 regression: find/fetch goal + search box present → NO escalation ---
  // Confidence is a 0-1 scale (model_provider_interface.js validateActionPlan),
  // default threshold 0.7.
  {
    const r = await StubLLMProvider.plan({ at: searchAT, userGoal: 'fetch me a laptop' });
    assert.ok(r.confidence >= 0.5, `search-box-present fetch goal confidence >= 0.5, got ${r.confidence}`);
    assert.strictEqual(r.needs_escalation, false, 'must not escalate when search UI present');
    assert.ok(Array.isArray(r.actions) && r.actions.length > 0, 'stub returns actions');
    assert.ok(r.reasoning && r.reasoning.length > 0, 'stub returns reasoning');
  }

  // --- fetch goal + NO search box → escalate (confidence 0.3) ---
  {
    const r = await StubLLMProvider.plan({ at: emptyAT, userGoal: 'fetch me a laptop' });
    assert.strictEqual(r.confidence, 0.3, 'missing search UI - confidence 0.3');
    assert.strictEqual(r.needs_escalation, true, 'missing search UI → escalate');
  }

  // --- complex/ambiguous goal → confidence 0.5 (below 0.7 threshold) ---
  {
    const r = await StubLLMProvider.plan({ at: searchAT, userGoal: 'compare and summarize complex options' });
    assert.strictEqual(r.confidence, 0.5, 'compare/summarize - confidence 0.5');
  }

  // --- price goal (no search-intent word) → confidence 0.8 ---
  {
    const r = await StubLLMProvider.plan({ at: searchAT, userGoal: 'laptop price cheapest' });
    assert.ok(r.confidence >= 0.85, `price/laptop goal confidence >= 0.85, got ${r.confidence}`);
  }

  // --- "under" matches search-intent branch first → 0.75 with search present (still no escalate) ---
  {
    const r = await StubLLMProvider.plan({ at: searchAT, userGoal: 'laptop price under 1 lakh' });
    assert.ok(r.confidence >= 0.5, `under-variant confidence >= 0.5, got ${r.confidence}`);
    assert.strictEqual(r.needs_escalation, false, 'under-variant with search UI must not escalate');
  }

  // --- reasonLocally end-to-end: below threshold → needs_escalation ---
  {
    const r = await reasonLocally({ at: searchAT, userGoal: 'fetch me a laptop', threshold: 0.7 });
    assert.strictEqual(typeof r.confidence, 'number');
    assert.ok(r.confidence >= 0 && r.confidence <= 1, 'confidence stays on the 0-1 scale');
    assert.strictEqual(r.needs_escalation, r.confidence < 0.7, 'escalation matches threshold gate');
    assert.strictEqual(r.needs_escalation, false, 'search present → local path, no escalate');
    assert.ok(Array.isArray(r.actions));
  }

  // --- reasonLocally: executeFailures >= 2 forces escalation ---
  {
    const r = await reasonLocally({ at: searchAT, userGoal: 'fetch me a laptop', threshold: 0.7, executeFailures: 2 });
    assert.strictEqual(r.needs_escalation, true, 'executeFailures >= 2 forces escalation');
  }

  // --- reasonLocally: noTransitionCount >= 2 forces escalation (Fix 1) ---
  {
    const r = await reasonLocally({ at: searchAT, userGoal: 'fetch me a laptop', threshold: 0.7, noTransitionCount: 2 });
    assert.strictEqual(r.needs_escalation, true, 'noTransitionCount >= 2 forces escalation');
  }

  // --- reasonLocally: noTransitionCount 1 alone does not force escalation ---
  {
    const r = await reasonLocally({ at: searchAT, userGoal: 'fetch me a laptop', threshold: 0.7, noTransitionCount: 1 });
    assert.strictEqual(r.needs_escalation, false, 'noTransitionCount 1 alone does not escalate');
  }

  // --- reasonLocally: executeFailures 1 does not force escalation (confidence still high) ---
  {
    const r = await reasonLocally({ at: searchAT, userGoal: 'fetch me a laptop', threshold: 0.7, executeFailures: 1 });
    assert.strictEqual(r.needs_escalation, false, 'executeFailures 1 alone does not escalate');
  }

  // --- FIX 3 regression: bare <input> without search name/selector does NOT count as search ---
  {
    const bareInputAT = [
      { id: 'n0', role: 'textbox', name: '', tag: 'input', selector: '#csrf-token', state: {} },
      { id: 'n1', role: 'generic', name: 'Welcome', tag: 'div', state: {} },
    ];
    const r = await StubLLMProvider.plan({ at: bareInputAT, userGoal: 'fetch me a laptop' });
    assert.strictEqual(r.confidence, 0.3, 'bare input without search indicators - confidence 0.3');
    assert.strictEqual(r.needs_escalation, true, 'bare input → escalate (not treated as search form)');
  }

  // --- FIX 3: search input with search in name/selector DOES count ---
  {
    const realSearchAT = [
      { id: 'n0', role: 'textbox', name: 'Search Amazon', tag: 'input', selector: '#twotabsearchtextbox', state: {} },
    ];
    const r = await StubLLMProvider.plan({ at: realSearchAT, userGoal: 'fetch me a laptop' });
    assert.ok(r.confidence >= 0.5, 'real search input - confidence >= 0.5');
    assert.strictEqual(r.needs_escalation, false, 'real search input → no escalate');
  }

  // --- Cloud-first: search classification always escalates (no local LLM) ---
  {
    const r = await reasonLocally({ at: searchAT, userGoal: 'fetch me a laptop', threshold: 0.7, classification: 'search' });
    assert.strictEqual(r.needs_escalation, true, 'search → cloud-first escalation');
    assert.ok(r.reasoning.includes('Cloud-first'), 'reasoning notes cloud-first');
  }

  // --- Cloud-first: navigate / info / auth_gated also escalate ---
  for (const cls of ['navigate', 'info', 'auth_gated']) {
    const r = await reasonLocally({ at: searchAT, userGoal: 'open settings', threshold: 0.7, classification: cls });
    assert.strictEqual(r.needs_escalation, true, `${cls} → cloud-first escalation`);
  }

  // --- Cloud-first: action classification may stay local (stub path) ---
  {
    const r = await reasonLocally({ at: searchAT, userGoal: 'fetch me a laptop', threshold: 0.7, classification: 'action' });
    assert.strictEqual(r.needs_escalation, false, 'action → local stub path when search UI present');
    assert.ok(Array.isArray(r.actions) && r.actions.length > 0, 'local stub returns actions');
  }

  // --- Choice A: type text keeps constraint words (under/lakh) ---
  {
    const r = await StubLLMProvider.plan({ at: searchAT, userGoal: 'find me a laptop under 1 lakh' });
    const typeAction = (r.actions || []).find(a => a.type === 'type');
    assert.ok(typeAction, 'has type action');
    const text = (typeAction.params && typeAction.params.text) || '';
    assert.ok(/laptop/i.test(text), `type text includes laptop, got: ${text}`);
    assert.ok(/under/i.test(text), `type text keeps "under" constraint, got: ${text}`);
    assert.ok(/lakh/i.test(text), `type text keeps "lakh" constraint, got: ${text}`);

    // Reasoning must be derived from the goal, not a fixed laptop-specific
    // string: a different product should produce different reasoning and text.
    const other = await StubLLMProvider.plan({ at: searchAT, userGoal: 'find me a keychain under 500' });
    const otherType = (other.actions || []).find(a => a.type === 'type');
    const otherText = (otherType.params && otherType.params.text) || '';
    assert.ok(/keychain/i.test(otherText), `type text follows the goal, got: ${otherText}`);
    assert.ok(!/laptop/i.test(otherText), 'type text is not hardcoded to "laptop"');
    assert.notStrictEqual(r.reasoning, other.reasoning, 'reasoning varies with the goal');
  }

  // --- Choice 3: offline generic noun→AT click for "open my cart" ---
  {
    const cartAT = [
      { id: 'n0', role: 'link', name: 'Cart 0 items', tag: 'a', state: {} },
      { id: 'n1', role: 'generic', name: 'Welcome', tag: 'div', state: {} },
    ];
    const r = await StubLLMProvider.plan({ at: cartAT, userGoal: 'open my cart' });
    const click = (r.actions || []).find(a => a.type === 'click');
    assert.ok(click, 'offline stub returns click for open cart');
    assert.strictEqual(click.target && click.target.mode, 'at_node_id', 'click targets AT node id');
    assert.strictEqual(click.target.value, 'n0', 'clicks the Cart link node');
    assert.ok(/cart/i.test(r.reasoning), 'reasoning mentions cart node');
  }

  // --- schema contract ---
  {
    const r = await StubLLMProvider.plan({ at: searchAT, userGoal: 'find shoes' });
    for (const key of ['version', 'source', 'confidence', 'plan', 'actions', 'reasoning']) {
      assert.ok(key in r, `plan output has ${key}`);
    }
    assert.ok(Array.isArray(r.actions));
    for (const a of r.actions) {
      assert.ok(a.type, 'action has type');
      assert.ok('requires_approval' in a, 'action has requires_approval');
    }
  }

  console.log('test_reason: all passed');
})().catch(e => { console.error(e); process.exit(1); });
