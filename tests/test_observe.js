// Step 1 — OBSERVE: computeATDiff (URL-primary pageChanged) + observePage URL capture
const assert = require('assert');
const { computeATDiff, observePage } = require('../lib/workflow_loop.js');

function makeAT(n, prefix = 'n') {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${i}`,
    role: i % 2 === 0 ? 'link' : 'generic',
    name: `node ${i}`,
    tag: 'div',
    state: {},
  }));
}

// --- computeATDiff basics ---
{
  const a = makeAT(10);
  const b = makeAT(10);
  b[0] = { ...b[0], name: 'renamed' };
  const d = computeATDiff(a, b, 'https://x.com/', 'https://x.com/');
  assert.ok(d, 'diff should exist for same-size ATs');
  assert.strictEqual(d.pageChanged, false, 'same URL → pageChanged false');
  assert.strictEqual(d.urlKnown, true);
  assert.strictEqual(d.urlChanged, false);
  assert.strictEqual(d.stateChanges.length, 0);
}

// --- URL change → pageChanged true (URL is primary) ---
{
  const a = makeAT(10);
  const b = makeAT(12);
  const d = computeATDiff(a, b, 'https://amazon.in/', 'https://amazon.in/s?k=laptop');
  assert.strictEqual(d.urlChanged, true, 'URL change detected');
  assert.strictEqual(d.pageChanged, true, 'URL change → pageChanged true');
}

// --- Amazon churn: 50+ node delta, SAME URL → pageChanged FALSE (Bug 3 regression) ---
{
  const a = makeAT(100, 'a');
  const b = makeAT(200, 'b'); // 100 node delta, all new
  const d = computeATDiff(a, b, 'https://amazon.in/', 'https://amazon.in/');
  assert.strictEqual(d.pageChanged, false, 'same URL + churn must NOT set pageChanged');
  assert.strictEqual(d.nodeCountDelta, 100);
}

// --- URL unavailable → node-count fallback with strict threshold ---
{
  const a = makeAT(10, 'a');
  const b = makeAT(80, 'b'); // delta 70, below 200 → still false
  const d = computeATDiff(a, b, null, null);
  assert.strictEqual(d.urlKnown, false, 'null URLs → urlKnown false');
  assert.strictEqual(d.pageChanged, false, 'fallback threshold >200: delta 70 → false');

  const c = makeAT(250, 'c'); // delta 240 > 200 → true
  const d2 = computeATDiff(a, c, null, null);
  assert.strictEqual(d2.pageChanged, true, 'fallback: delta >200 → true');
}

// --- One URL missing → treat as unknown ---
{
  const a = makeAT(10, 'a');
  const b = makeAT(300, 'b');
  const d = computeATDiff(a, b, 'https://amazon.in/', null);
  assert.strictEqual(d.urlKnown, false, 'one URL missing → urlKnown false');
  assert.strictEqual(d.pageChanged, true, 'fallback with huge delta → true');
}

// --- null inputs → null diff ---
{
  assert.strictEqual(computeATDiff(null, makeAT(5)), null);
  assert.strictEqual(computeATDiff(makeAT(5), null), null);
}

// Both blocks mutate global.location, so they run in sequence rather than as
// concurrent floating IIFEs (which raced and could leave a rejection unhandled).
(async () => {
  // --- observePage captures URL when location exists + skips screenshot by default ---
  const observation = await observePage({ getAT: async () => makeAT(3) });
  assert.ok(Array.isArray(observation.at), 'observePage returns at array');
  assert.ok('url' in observation, 'observePage includes url field');
  assert.strictEqual(observation.screenshot, null, 'screenshot skipped when needScreenshot not set (default off)');
  // In Node, location is undefined → url null (graceful)
  assert.ok(observation.url === null || typeof observation.url === 'string', 'url is null or string');

  // needScreenshot=true DOES call getScreenshot
  const obs2 = await observePage({
    getAT: async () => makeAT(3),
    getScreenshot: async () => 'data:image/png;base64,xxx',
    needScreenshot: true,
  });
  assert.strictEqual(obs2.screenshot, 'data:image/png;base64,xxx', 'needScreenshot=true captures screenshot');

  // needScreenshot=false even when getScreenshot provided → skipped
  const obs3 = await observePage({
    getAT: async () => makeAT(3),
    getScreenshot: async () => 'data:image/png;base64,yyy',
    needScreenshot: false,
  });
  assert.strictEqual(obs3.screenshot, null, 'needScreenshot=false skips capture');

  console.log('test_observe: all passed');

  // --- waitForNavigation: early exit on URL change ---
  const { waitForNavigation } = require('../lib/workflow_loop.js');
  // Simulate URL change after 200ms
  global.location = { href: 'https://start.example/' };
  const startUrl = 'https://start.example/';
  setTimeout(() => { global.location.href = 'https://start.example/s?k=laptop'; }, 200);
  const t0 = Date.now();
  const nav = await waitForNavigation(startUrl, { maxMs: 1800, pollMs: 50 });
  const elapsed = Date.now() - t0;
  assert.strictEqual(nav.changed, true, 'URL change detected');
  assert.strictEqual(nav.urlAfter, 'https://start.example/s?k=laptop');
  assert.ok(elapsed < 800, `early exit on change, waited ${elapsed}ms < 800ms`);
  assert.ok(nav.waitedMs < 800, `waitedMs ${nav.waitedMs} < 800`);

  // Timeout: URL never changes → waited ≈ maxMs, changed false
  global.location = { href: 'https://static.example/' };
  const t1 = Date.now();
  const nav2 = await waitForNavigation('https://static.example/', { maxMs: 400, pollMs: 50 });
  const elapsed2 = Date.now() - t1;
  assert.strictEqual(nav2.changed, false, 'no change → changed false');
  assert.ok(elapsed2 >= 350 && elapsed2 < 700, `timeout ~400ms, got ${elapsed2}ms`);

  console.log('test_waitForNavigation: all passed');
})().catch((e) => {
  console.error('test_observe FAILED:', e);
  process.exit(1);
});
