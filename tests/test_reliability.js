// Trinetra — agent loop reliability tests
//
// Covers the behaviour that made the first iterations of a real run fail on a
// heavy page like Amazon:
//   - AT node ids must survive a re-render (they used to be positional, so a
//     plan built from a snapshot resolved to the wrong element seconds later)
//   - actionable controls must stay reachable past the node cap
//   - page settling must distinguish "slow render" from "no navigation"
//   - the loop must not declare itself stuck before it has done anything, and
//     must not blame the page when its own actions failed
//   - a successful run must never be reported as a failure

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const loop = require(path.join(ROOT, 'lib', 'workflow_loop.js'));
const at = require(path.join(ROOT, 'lib', 'at_extractor.js'));

// ---------- minimal DOM for the extractor ----------

function mkEl(spec) {
  const attrs = spec.attrs || {};
  return {
    tagName: (spec.tag || 'div').toUpperCase(),
    type: spec.type || null,
    id: spec.id || '',
    className: spec.className || '',
    textContent: spec.text || '',
    innerText: spec.text || '',
    disabled: false,
    checked: false,
    expanded: false,
    onclick: spec.onclick || null,
    style: {},
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    setAttribute(k, v) { attrs[k] = v; this._attrs = attrs; },
    getBoundingClientRect: () => ({
      x: 0, y: 0, width: spec.w ?? 100, height: spec.h ?? 20,
      top: 0, left: 0, right: 100, bottom: 20,
    }),
  };
}

function installDom(elements) {
  global.document = {
    body: { appendChild() {} },
    documentElement: { appendChild() {} },
    readyState: 'complete',
    querySelectorAll: () => elements,
    querySelector: () => null,
    getElementById: () => null,
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
    addEventListener() {},
  };
  global.document.createTreeWalker = () => ({ currentNode: elements[0] });
  global.CSS = { escape: (s) => String(s) };
  global.NodeFilter = { SHOW_ELEMENT: 1 };
  // getState() consults the computed style to decide visibility.
  global.window = global;
  global.window.getComputedStyle = () => ({ display: 'block', visibility: 'visible' });
  global.getComputedStyle = global.window.getComputedStyle;
}

(async () => {
  // ---------- 1. Node ids are stable across a re-render ----------
  {
    const searchBox = mkEl({ tag: 'input', id: 'twotabsearchtextbox', text: 'Search Amazon' });
    const submit = mkEl({ tag: 'input', id: 'nav-search-submit-button', text: 'Go' });
    const product = mkEl({ tag: 'a', className: 'a-link-normal', text: 'Laptop under 1 lakh', w: 300 });
    installDom([searchBox, submit, product]);

    const first = at.extractAccessibilityTree({ maxNodes: 2000 });
    const ids1 = first.map((n) => n.id);
    const boxId1 = first.find((n) => n.name === 'Search Amazon').id;

    // Simulate a re-render: same logical elements, different DOM position and
    // extra decorative nodes ahead of them (which is what shifts positional ids).
    const spacer = [1, 2, 3].map((i) => mkEl({ tag: 'div', text: 'ad ' + i, w: 10, h: 10 }));
    installDom([...spacer, searchBox, product, submit]);
    const second = at.extractAccessibilityTree({ maxNodes: 2000 });

    const box2 = second.find((n) => n.name === 'Search Amazon');
    assert.ok(box2, 'search box still present after re-render');
    assert.strictEqual(
      box2.id, boxId1,
      `search box id must be stable across a re-render (was ${boxId1}, now ${box2.id})`
    );

    // A plan built from the first snapshot must still resolve.
    assert.strictEqual(
      searchBox.getAttribute('data-trinetra-id'), boxId1,
      'data-trinetra-id is re-stamped with the same stable id, so the old plan resolves'
    );

    // Ids must be unique within a snapshot.
    assert.strictEqual(new Set(ids1).size, ids1.length, 'ids are unique within one extraction');
  }

  // ---------- 2. Identical siblings get distinct ids ----------
  {
    const buttons = [1, 2, 3].map((i) => mkEl({ tag: 'button', text: 'Add to cart', className: 'btn' }));
    installDom(buttons);
    const nodes = at.extractAccessibilityTree({ maxNodes: 2000 });
    const ids = nodes.map((n) => n.id);
    assert.strictEqual(new Set(ids).size, ids.length, 'identical siblings get distinct ids');
  }

  // ---------- 3. Actionable elements survive past the old cap ----------
  {
    // 3000 decorative nodes first, then the real control. Under the old
    // positional cap the control was never stamped and so was untargetable.
    const noise = [];
    for (let i = 0; i < 3000; i++) noise.push(mkEl({ tag: 'div', text: 'noise ' + i, w: 5, h: 5 }));
    const cta = mkEl({ tag: 'button', id: 'buy-now', text: 'Buy Now' });
    installDom([...noise, cta]);
    const nodes = at.extractAccessibilityTree({ maxNodes: 2000 });
    const hit = nodes.find((n) => n.name === 'Buy Now');
    assert.ok(hit, 'actionable control past 2000 nodes is still extracted');
    assert.strictEqual(
      cta.getAttribute('data-trinetra-id'), hit.id,
      'the deep control is stamped and therefore addressable'
    );
  }

  // ---------- 4. waitForPageSettled distinguishes slow render from no nav ----------
  {
    // No URL change within the window: reported as not changed, and the caller
    // can tell it waited properly rather than bailing after a fixed 1800ms.
    global.location = { href: 'https://shop.example.com/' };
    const noNav = await loop.waitForPageSettled('https://shop.example.com/', { navMaxMs: 300, pollMs: 50, settleMaxMs: 150, quietMs: 60 });
    assert.strictEqual(noNav.changed, false, 'URL unchanged is reported as unchanged');
    assert.ok(noNav.totalMs >= 300, `waited the full nav window (${noNav.totalMs}ms)`);

    // URL changes: reported as changed with the wait time recorded.
    global.location = { href: 'https://shop.example.com/s?k=laptop' };
    const nav = await loop.waitForPageSettled('https://shop.example.com/', { navMaxMs: 1000, pollMs: 50, settleMaxMs: 150, quietMs: 60 });
    assert.strictEqual(nav.changed, true, 'URL change is detected');
    assert.ok(nav.urlWaitMs < 1000, `early-exits on change (${nav.urlWaitMs}ms)`);
  }

  // ---------- 5. Stuck detection does not fire before the agent acts ----------
  {
    // The page never changes and no action ever succeeds. Before the grace
    // period this aborted at iteration 4 with "page is not responding".
    const steps = [];
    const r = await loop.runFullLoop({
      userGoal: 'find cheapest laptop under 1 lakh',
      getAT: async () => ([{ id: 'n0', role: 'textbox', name: 'Search', tag: 'input', state: {} }]),
      getScreenshot: null,
      reasonFn: async () => ({ confidence: 0.3, needs_escalation: false, actions: [], reasoning: 'no-op' }),
      executePlanFn: async () => ({ success: false, results: [], failedCount: 1 }),
      sanitizeFn: async ({ at }) => ({ sanitizedScreenshot: null, sanitizedAT: at, report: { redacted_regions: [] } }),
      cloudCallFn: async () => ({ success: true, actions: [] }),
      onStep: (p) => steps.push(p.step),
      maxIterations: 8,
      threshold: 0.7,
    });
    assert.strictEqual(r.success, false);
    // The message must name the real cause rather than blaming the page.
    assert.ok(
      !/page is not responding/i.test(r.reason),
      `must not blame the page when the agent never acted: ${r.reason}`
    );
    assert.ok(
      /has not yet completed a single action|could not be found/i.test(r.reason),
      `message should say the agent could not act: ${r.reason}`
    );
  }

  // ---------- 6. Result summary never mislabels a success ----------
  {
    // Reasoning that mentions failure used to flip the whole run to "Task failed"
    // because success was inferred by regexing the text.
    const result = {
      success: true,
      reason: 'Goal achieved',
      iteration: 2,
      classification: { type: 'search' },
      cloudResult: {
        reasoning: 'The previous submit failed, so I retried with a different approach.',
        degraded: false,
      },
      history: [
        { iteration: 1, escalated: true, execResult: { success: false, results: [] } },
        { iteration: 2, escalated: true, execResult: { success: true, results: [{ a: 1 }, { a: 2 }] } },
      ],
    };
    const s = loop.buildResultSummary(result, 'find the cheapest laptop under 60000');
    assert.strictEqual(s.success, true, 'success stays success despite "failed" in the reasoning');
    assert.strictEqual(s.title, 'Task completed');
    assert.ok(s.followUps.length === 3, `three follow-ups offered (got ${s.followUps.length})`);
    assert.ok(
      s.followUps.some((f) => /laptop/i.test(f)),
      `follow-ups should name the product: ${JSON.stringify(s.followUps)}`
    );
    assert.ok(!/laptop under 60000/.test(s.body), 'budget numbers are not used as a product noun');
  }

  // ---------- 7. Failure summary offers no follow-ups ----------
  {
    const s = loop.buildResultSummary({ success: false, reason: 'no progress', iteration: 4 }, 'buy a laptop');
    assert.strictEqual(s.success, false);
    assert.strictEqual(s.title, 'Task stopped');
    assert.deepStrictEqual(s.followUps, [], 'no next-step chips on a failed run');
  }

  // ---------- 8. Degraded cloud is disclosed, not hidden ----------
  {
    const s = loop.buildResultSummary({
      success: true, reason: 'Goal achieved', iteration: 1,
      cloudResult: { degraded: true, degraded_reason: 'Gemini 404' },
      history: [{ iteration: 1, execResult: { success: true, results: [{ a: 1 }] } }],
    }, 'find a laptop');
    assert.strictEqual(s.degraded, true);
    assert.ok(/local rule engine/.test(s.body), `degradation is disclosed: ${s.body}`);
  }

  // ---------- 9. Product noun extraction ----------
  {
    assert.strictEqual(loop.extractProductNoun('Find the cheapest laptop under 60000'), 'laptop');
    assert.strictEqual(loop.extractProductNoun('Search for shoes under 2000'), 'shoes');
    assert.strictEqual(loop.extractProductNoun('show me something cheap'), 'something');
    assert.strictEqual(loop.extractProductNoun(''), '', 'empty goal yields no noun');
  }

  // ---------- 10. content_script uses the same id scheme ----------
  {
    const cs = fs.readFileSync(path.join(ROOT, 'content_script.js'), 'utf8');
    assert.ok(/_trStableHash/.test(cs), 'content script uses the content-derived hash');
    assert.ok(
      !/const id = `node_\$\{index/.test(cs),
      'content script no longer assigns positional node ids'
    );
    assert.ok(/_TR_ACTIONABLE_TAGS/.test(cs), 'content script keeps actionable elements past the cap');
  }

  console.log('test_reliability: all passed');
})().catch((e) => {
  console.error('test_reliability FAILED:', e);
  process.exit(1);
});
