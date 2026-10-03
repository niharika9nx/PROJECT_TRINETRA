// Trinetra — approval gate regression tests
//
// Guards the two bypasses that let sensitive actions run without a prompt:
//   1. an explicit requires_approval:true being downgraded by an "is this a
//      search action?" heuristic, and
//   2. restricted action types (type/fill/submit/confirm/payment) executing
//      at all when no approval handler is present.
// Also asserts the policy in lib/action_executor.js and in the content script
// copy agree, since they are separate implementations of the same rule.

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const LIB = path.join(__dirname, '..', 'lib');
const exec = require(path.join(LIB, 'action_executor.js'));

// Minimal DOM stub so the executor can resolve targets.
const elements = {};
function mockEl(id) {
  return {
    id,
    tagName: 'INPUT',
    type: 'text',
    value: '',
    focus() {},
    click() { this.clickCalled = (this.clickCalled || 0) + 1; },
    clickCalled: 0,
    dispatchEvent() { return true; },
    getAttribute() { return null; },
    setAttribute() {},
    closest() { return null; },
    form: null,
    ownerDocument: global.document,
  };
}
global.document = {
  querySelector: (sel) => elements[sel] || null,
  querySelectorAll: () => [],
  createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
  addEventListener() {},
  body: { appendChild() {} },
};
global.CSS = { escape: (s) => String(s) };
global.MouseEvent = class {};
global.Event = class {};
global.KeyboardEvent = class {};
global.window = global;   // executors reach for window.scrollBy
global.window.scrollBy = () => {};
global.window.HTMLInputElement = class {};

const RESTRICTED = ['type', 'fill', 'submit', 'confirm', 'payment', 'payments', 'sensitive_ops'];

// Approval is requested once per plan, carrying every restricted action that
// is still to run. Record the gated action types across all requests.
function trackingHandler(log) {
  return (action) => {
    const gated = action.plan_actions || [action];
    log.push(...gated.map((a) => a.type));
    return Promise.resolve(true);
  };
}

(async () => {
  // --- 1. Every restricted type is gated, even with requires_approval:false ---
  for (const type of RESTRICTED) {
    const log = [];
    const el = mockEl('n1');
    elements['[data-trinetra-id="n1"]'] = el;
    await exec.executePlan(
      { actions: [{ id: 'a', type, requires_approval: false, target: { mode: 'at_node_id', value: 'n1' }, params: { text: 'hello' } }] },
      { approvalHandler: trackingHandler(log) }
    );
    assert.ok(log.includes(type), `restricted action "${type}" must request approval (got ${JSON.stringify(log)})`);
  }

  // --- 2. requires_approval:true is NEVER downgraded, whatever the text ---
  // This is the original bypass: a `type` whose params.text did not match
  // /password|card|cvv|otp/i was treated as a "search action" and skipped.
  const sneakyTexts = [
    'laptop under 1 lakh',
    'john.doe@example.com',
    '+91 98765 43210',
    '12MG34A4WR',
    '4111 1111 1111 1111',   // a PAN, not a card
    'Flat 4B, 12 Residency Road',
    'correct horse battery staple',
  ];
  for (const text of sneakyTexts) {
    const log = [];
    const el = mockEl('n2');
    elements['[data-trinetra-id="n2"]'] = el;
    await exec.executePlan(
      { actions: [{ id: 'a', type: 'type', requires_approval: true, target: { mode: 'at_node_id', value: 'n2' }, params: { text } }] },
      { approvalHandler: trackingHandler(log) }
    );
    assert.ok(log.includes('type'), `requires_approval:true must gate even for text ${JSON.stringify(text)}`);
  }

  // --- 3. Fail closed: no handler and no modal means deny, not execute ---
  for (const type of RESTRICTED) {
    const el = mockEl('n3');
    elements['[data-trinetra-id="n3"]'] = el;
    const before = el.clickCalled;
    const r = await exec.executePlan(
      { actions: [{ id: 'a', type, requires_approval: false, target: { mode: 'at_node_id', value: 'n3' }, params: { text: 'secret' } }] },
      {}
    );
    assert.strictEqual(r.denied, true, `"${type}" without an approval handler must be denied`);
    assert.strictEqual(el.clickCalled, before, `"${type}" must not have executed when denied`);
  }

  // --- 4. Non-restricted actions are not gated ---
  for (const type of ['scroll', 'read']) {
    const log = [];
    await exec.executePlan(
      { actions: [{ id: 'a', type, requires_approval: false, target: null, params: {} }] },
      { approvalHandler: trackingHandler(log) }
    );
    assert.ok(!log.includes(type), `non-restricted action "${type}" must not request approval`);
  }

  // --- 5. Denial halts the rest of the plan ---
  {
    const el = mockEl('n4');
    elements['[data-trinetra-id="n4"]'] = el;
    const clicked = [];
    const r = await exec.executePlan({
      actions: [
        { id: 'a1', type: 'type', requires_approval: false, target: { mode: 'at_node_id', value: 'n4' }, params: { text: 'x' } },
        { id: 'a2', type: 'click', requires_approval: false, target: { mode: 'at_node_id', value: 'n4' }, params: {} },
      ],
    }, { approvalHandler: () => Promise.resolve(false) });
    assert.strictEqual(r.denied, true, 'denial is reported');
    assert.strictEqual(el.clickCalled, 0, 'actions after a denial do not run');
    assert.ok(clicked.length === 0, 'no side effects after denial');
  }

  // --- 6. A realistic search plan asks ONCE, not once per action ---
  // click -> type -> submit produced two separate prompts before, which is what
  // made a multi-iteration run tedious. All restricted actions must still be
  // listed in that single request.
  {
    let requests = 0;
    let listed = null;
    const el = mockEl('n5');
    elements['[data-trinetra-id="n5"]'] = el;
    const r = await exec.executePlan({
      actions: [
        { id: 'a1', type: 'click', requires_approval: false, target: { mode: 'at_node_id', value: 'n5' }, params: {} },
        { id: 'a2', type: 'type', requires_approval: false, target: { mode: 'at_node_id', value: 'n5' }, params: { text: 'laptop under 1 lakh' } },
        { id: 'a3', type: 'submit', requires_approval: false, target: { mode: 'at_node_id', value: 'n5' }, params: {} },
      ],
    }, {
      approvalHandler: (action) => {
        requests++;
        listed = (action.plan_actions || []).map((a) => a.type);
        return Promise.resolve(true);
      },
    });
    assert.strictEqual(requests, 1, `one approval request per plan (got ${requests})`);
    assert.deepStrictEqual(listed, ['type', 'submit'], 'the prompt lists every restricted action still to run');
    assert.ok(!listed.includes('click'), 'ungated actions are not listed for approval');
    assert.strictEqual(r.success, true, 'approved plan executes');
  }

  // --- 7. One prompt covers all restricted actions, and denying blocks them all ---
  {
    let requests = 0;
    const el = mockEl('n6');
    elements['[data-trinetra-id="n6"]'] = el;
    const r = await exec.executePlan({
      actions: [
        { id: 'a1', type: 'type', requires_approval: false, target: { mode: 'at_node_id', value: 'n6' }, params: { text: 'laptop' } },
        { id: 'a2', type: 'submit', requires_approval: false, target: { mode: 'at_node_id', value: 'n6' }, params: {} },
        { id: 'a3', type: 'type', requires_approval: false, target: { mode: 'at_node_id', value: 'n6' }, params: { text: 'more' } },
      ],
    }, {
      approvalHandler: () => { requests++; return Promise.resolve(false); },
    });
    assert.strictEqual(requests, 1, 'still one prompt for three restricted actions');
    assert.strictEqual(r.denied, true, 'denying the batch denies the plan');
    assert.strictEqual(el.clickCalled, 0, 'nothing ran after a batch denial');
  }

  // --- 6. The content-script copy of the rule must match the lib copy ---
  // content_script.js inlines the executor; if the two drift, the gate that
  // actually runs in the browser is the one that matters. Match code, not the
  // explanatory comments that name the old heuristic.
  const hasBypassCode = (src) => /!isSearchAction|isSearchAction\s*\?/.test(src);
  {
    const cs = fs.readFileSync(path.join(__dirname, '..', 'content_script.js'), 'utf8');
    assert.ok(!hasBypassCode(cs), 'content_script.js must not use the isSearchAction bypass');
    const lib = fs.readFileSync(path.join(LIB, 'action_executor.js'), 'utf8');
    assert.ok(!hasBypassCode(lib), 'action_executor.js must not use the isSearchAction bypass');
    assert.ok(
      /requires_approval === true \? true : isSensitive/.test(cs),
      'content_script.js honours requires_approval:true unconditionally'
    );
    assert.ok(
      /requires_approval === true \? true : isSensitive/.test(lib),
      'action_executor.js honours requires_approval:true unconditionally'
    );
  }

  // --- 7. The server-side normalizer must apply the same policy ---
  {
    const ga = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'providers', 'gemini_adapter.ts'), 'utf8');
    assert.ok(!hasBypassCode(ga), 'gemini_adapter.ts must not use the isSearchAction bypass');
    assert.ok(
      /a\.requires_approval === true \? true : isSensitive/.test(ga),
      'gemini_adapter.ts honours requires_approval:true unconditionally'
    );
  }

  console.log('test_approval: all passed');
})().catch((e) => {
  console.error('test_approval FAILED:', e);
  process.exit(1);
});
