// Step 3 — EXECUTE: resolveTarget modes, all-fail → success:false, approval gate
const assert = require('assert');

// --- Minimal DOM mocks (must be set before requiring action_executor) ---
const elements = {};
function mockEl(id, extra = {}) {
  return Object.assign({
    id,
    value: '',
    tagName: 'DIV',
    clickCalled: 0,
    focused: 0,
    dispatched: [],
    getAttribute: () => null,
    setAttribute: () => {},
    removeAttribute: () => {},
    focus() { this.focused++; },
    click() { this.clickCalled++; },
    scrollBy() {},
    dispatchEvent(e) { this.dispatched.push(e); return true; },
    closest: () => null,
    querySelector: () => null,
  }, extra);
}

global.window = {
  scrollBy: () => {},
  HTMLInputElement: { prototype: {} },
  TrinetraShowApprovalModal: undefined,
};
global.document = {
  querySelector(sel) {
    // data-trinetra-id lookups
    const m = /data-trinetra-id="([^"]+)"/.exec(sel);
    if (m) return elements[`id:${m[1]}`] || null;
    // css selector map
    if (elements[`sel:${sel}`]) return elements[`sel:${sel}`];
    return null;
  },
  querySelectorAll: () => [],
  elementFromPoint: () => null,
  documentElement: mockEl('root'),
};
global.CSS = { escape: s => String(s).replace(/["\\]/g, '\\$&') };
global.Event = class Event { constructor(type, opts) { this.type = type; Object.assign(this, opts); } };
global.KeyboardEvent = class KeyboardEvent { constructor(type, opts) { this.type = type; Object.assign(this, opts); } };
global.MouseEvent = class MouseEvent { constructor(type, opts) { this.type = type; Object.assign(this, opts); } };

const {
  executePlan, executeAction, resolveTarget, requestApproval,
} = require('../lib/action_executor.js');

(async () => {
  // --- resolveTarget: at_node_id ---
  {
    const el = mockEl('searchbox');
    elements['id:node_5'] = el;
    const found = resolveTarget({ mode: 'at_node_id', value: 'node_5' });
    assert.strictEqual(found, el, 'at_node_id resolves via data-trinetra-id');
  }

  // --- resolveTarget: css_selector ---
  {
    const el = mockEl('css');
    elements['sel:#my-btn'] = el;
    const found = resolveTarget({ mode: 'css_selector', value: '#my-btn' });
    assert.strictEqual(found, el, 'css_selector resolves');
  }

  // --- resolveTarget: missing → null ---
  {
    assert.strictEqual(resolveTarget({ mode: 'at_node_id', value: 'nope' }), null, 'missing at_node_id → null');
    assert.strictEqual(resolveTarget(null), null, 'null target → null');
  }

  // --- BUG 3 compounding: all non-read actions fail → success:false ---
  {
    // No elements registered → click/type targets not found.
    // `type` is a restricted action and always gates, so approve it here —
    // this block tests the all-fail accounting, not the approval gate.
    const approve = () => Promise.resolve(true);
    const r = await executePlan({
      actions: [
        { id: 'a1', type: 'click', requires_approval: false, target: { mode: 'at_node_id', value: 'missing1' }, params: {} },
        { id: 'a2', type: 'type', requires_approval: false, target: { mode: 'at_node_id', value: 'missing2' }, params: { text: 'x' } },
      ],
    }, { approvalHandler: approve });
    assert.strictEqual(r.success, false, 'all-fail plan → success false');
    assert.ok(r.failedCount >= 2, `failedCount >= 2, got ${r.failedCount}`);
    assert.ok(r.results.length === 2, 'per-action results preserved');
  }

  // --- restricted actions auto-deny when no approval handler exists ---
  {
    const r = await executePlan({
      actions: [{ id: 'a1', type: 'type', requires_approval: false, target: { mode: 'at_node_id', value: 'good' }, params: { text: 'x' } }],
    }, {});
    assert.strictEqual(r.denied, true, 'type without approval handler → denied (fail closed)');
  }

  // --- mixed success/failure → success true (partial progress) ---
  {
    const good = mockEl('good');
    elements['id:good'] = good;
    const r = await executePlan({
      actions: [
        { id: 'a1', type: 'click', requires_approval: false, target: { mode: 'at_node_id', value: 'good' }, params: {} },
        { id: 'a2', type: 'click', requires_approval: false, target: { mode: 'at_node_id', value: 'missing' }, params: {} },
      ],
    }, {});
    assert.strictEqual(r.success, true, 'partial success → success true');
    assert.strictEqual(r.failedCount, 1, 'one failure recorded');
    assert.strictEqual(r.executedCount, 2, 'two non-read actions attempted');
    assert.ok(good.clickCalled === 1, 'good element was clicked');
  }

  // --- read failures don't count toward all-fail ---
  {
    const r = await executePlan({
      actions: [
        { id: 'a1', type: 'read', requires_approval: false, target: null, params: {} },
        { id: 'a2', type: 'click', requires_approval: false, target: { mode: 'at_node_id', value: 'missing' }, params: {} },
        { id: 'a3', type: 'click', requires_approval: false, target: { mode: 'at_node_id', value: 'missing2' }, params: {} },
      ],
    }, {});
    // read ok, 2 clicks fail → all non-read failed → false
    assert.strictEqual(r.success, false, 'read excluded; all non-read failed → false');
  }

  // --- all success → success true ---
  {
    const el = mockEl('ok');
    elements['id:ok'] = el;
    const r = await executePlan({
      actions: [
        { id: 'a1', type: 'click', requires_approval: false, target: { mode: 'at_node_id', value: 'ok' }, params: {} },
      ],
    }, {});
    assert.strictEqual(r.success, true);
    assert.strictEqual(r.failedCount, 0);
  }

  // --- approval gate: restricted action denied when handler returns false ---
  {
    const r = await executeAction(
      { id: 'p1', type: 'submit', requires_approval: true, target: { mode: 'css_selector', value: '#x' }, params: {} },
      { approvalHandler: async () => false }
    );
    assert.strictEqual(r.denied, true, 'denied action flagged');
    assert.strictEqual(r.success, false);
  }

  // --- approval gate: approved action proceeds ---
  {
    const el = mockEl('form-like', { tagName: 'FORM', submit() { this.submitted = true; } });
    elements['sel:#sub'] = el;
    const r = await executeAction(
      { id: 'p2', type: 'submit', requires_approval: true, target: { mode: 'css_selector', value: '#sub' }, params: {} },
      { approvalHandler: async () => true }
    );
    assert.strictEqual(r.denied, undefined, 'approved → not denied');
    assert.strictEqual(r.success, true, 'approved submit succeeds');
  }

  // --- denied plan stops and returns denied:true ---
  {
    const r = await executePlan({
      actions: [
        { id: 'a1', type: 'click', requires_approval: false, target: { mode: 'at_node_id', value: 'missing' }, params: {} },
        { id: 'a2', type: 'submit', requires_approval: true, target: { mode: 'css_selector', value: '#x' }, params: {} },
      ],
    }, { approvalHandler: async () => false });
    assert.strictEqual(r.denied, true, 'plan halts on denial');
    assert.strictEqual(r.success, false);
  }

  console.log('test_execute: all passed');
})().catch(e => { console.error(e); process.exit(1); });
