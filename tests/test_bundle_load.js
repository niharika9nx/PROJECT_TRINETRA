// Trinetra — content-script bundle load test
//
// Why this exists: the rest of the suite loads lib/*.js through require(),
// which gives every file its own module scope. Chrome does NOT do that. Every
// entry in manifest.json content_scripts[].js is injected as a classic script
// into ONE shared realm, where a duplicate top-level `let`/`const`/`class` is a
// SyntaxError and the file silently never executes.
//
// That mismatch hid a real regression: lib/pii_validator.js and
// lib/local_reasoning.js both declared `let llmProvider`, so loading the
// validator (added for the sanitization pipeline) broke local_reasoning.js.
// All Node tests stayed green because require() cannot see the collision.
//
// This test reproduces the browser's load model:
//   - files loaded in manifest order into a single vm context
//   - window === self === globalThis
//   - no `require`, no `module` — same as a content script
//   - a minimal chrome stub, which is all content_script.js touches at load
//
// It then asserts zero load errors, that every global the panel depends on
// exists, and that no module-private state leaked into the global scope.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// Globals the extension runtime resolves. If any is missing the agent silently
// falls back or throws, so each one is pinned here.
const REQUIRED_GLOBALS = [
  'TrinetraProviderInterface',
  'TrinetraStubProvider',
  'TrinetraPIIDetector',
  'TrinetraPIIValidator',
  'TrinetraSanitizationEngine',
  'TrinetraSanitization',
  'TrinetraLocalReasoning',
  'TrinetraWorkflowLoop',
];

// Names that must NEVER appear as globals. These are per-file module state; if
// one shows up here, a file is not wrapped in an IIFE and a future file that
// happens to use the same name will break the whole bundle again.
const MUST_NOT_LEAK = [
  'llmProvider', 'vlmProvider', 'DEFAULT_THRESHOLD', 'WORKFLOW_DEFAULT_THRESHOLD',
  'localReasoning', 'actionExecutor', 'atExtractor', 'sanitizationEngine',
  'vlmDeps', 'RESTRICTED_SET', 'RESTRICTED_ACTIONS',
];

function makeSandbox() {
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, JSON, Math, Promise, RegExp,
    Error, Object, Array, String, Number, Boolean, Symbol, Map, Set, WeakMap, WeakSet,
    isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
    // content_script.js registers a message listener at load; nothing else in
    // the bundle touches a Chrome API at load time.
    chrome: {
      runtime: { onMessage: { addListener() {} }, lastError: null, sendMessage() {} },
    },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  return sandbox;
}

(async () => {
  // --- manifest drives the file list, so the test can never drift from it ---
  const manifest = JSON.parse(read('manifest.json'));
  const files = manifest.content_scripts[0].js;
  assert.ok(Array.isArray(files) && files.length > 0, 'manifest declares content scripts');

  // --- background.js injects the same list; the two must not drift ---
  {
    const bg = read('background.js');
    const block = /CONTENT_SCRIPT_BUNDLE\s*=\s*\[([\s\S]*?)\]/.exec(bg);
    assert.ok(block, 'background.js declares CONTENT_SCRIPT_BUNDLE');
    const bgFiles = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    assert.deepStrictEqual(
      bgFiles, files,
      'background.js CONTENT_SCRIPT_BUNDLE must match manifest content_scripts order'
    );
  }

  // --- every declared file exists on disk ---
  for (const f of files) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), `manifest lists a missing file: ${f}`);
  }

  // --- load them the way Chrome does ---
  const sandbox = makeSandbox();
  const failures = [];
  for (const f of files) {
    try {
      vm.runInContext(read(f), sandbox, { filename: f });
    } catch (e) {
      failures.push(`${f} -> ${e.message}`);
    }
  }
  assert.strictEqual(
    failures.length, 0,
    `content-script bundle failed to load:\n   ${failures.join('\n   ')}`
  );

  // --- every global the runtime needs actually exists ---
  for (const g of REQUIRED_GLOBALS) {
    assert.ok(sandbox[g], `missing global window.${g} after loading the bundle`);
  }
  assert.strictEqual(
    typeof sandbox.TrinetraSanitizationEngine.runSanitizationPipeline, 'function',
    'TrinetraSanitizationEngine exposes runSanitizationPipeline'
  );
  assert.strictEqual(
    typeof sandbox.TrinetraLocalReasoning.reasonLocally, 'function',
    'TrinetraLocalReasoning exposes reasonLocally'
  );
  assert.strictEqual(
    typeof sandbox.TrinetraWorkflowLoop.runFullLoop, 'function',
    'TrinetraWorkflowLoop exposes runFullLoop'
  );
  assert.strictEqual(
    sandbox.TrinetraSanitization, sandbox.TrinetraSanitizationEngine,
    'TrinetraSanitization and TrinetraSanitizationEngine are the same object'
  );

  // --- no module-private state leaked into the shared realm ---
  for (const name of MUST_NOT_LEAK) {
    assert.ok(
      !(name in sandbox),
      `top-level "${name}" leaked into the shared content-script global scope — ` +
      'wrap the file in an IIFE so it stays module-private'
    );
  }

  // --- the privacy path works in the browser model, not just under require() ---
  {
    const r = await sandbox.TrinetraSanitizationEngine.runSanitizationPipeline({
      screenshot: null,
      at: [
        { id: 'n1', role: 'textbox', name: 'john.doe@example.com', tag: 'input' },
        { id: 'n2', role: 'textbox', name: '+91 98765 43210', tag: 'input' },
        { id: 'n3', role: 'link', name: 'Laptop under 1 lakh', tag: 'a' },
      ],
    });
    const out = JSON.stringify(r.sanitizedAT);
    assert.ok(!out.includes('john.doe@example.com'), 'email stripped in the content-script world');
    assert.ok(!out.includes('98765 43210'), 'phone stripped in the content-script world');
    assert.ok(out.includes('Laptop under 1 lakh'), 'product name survives');
    assert.ok(r.report.maskedCount >= 2, 'expected both PII nodes to be masked');
  }

  // --- local reasoning is reachable and stays on the 0-1 confidence scale ---
  {
    const r = await sandbox.TrinetraLocalReasoning.reasonLocally({
      at: [{ id: 'n0', role: 'textbox', name: 'Search Amazon', tag: 'input', selector: '#q', state: {} }],
      userGoal: 'find me a laptop under 1 lakh',
      threshold: 0.7,
    });
    assert.ok(
      r.confidence >= 0 && r.confidence <= 1,
      `confidence must be 0-1, got ${r.confidence}`
    );
    assert.ok(Array.isArray(r.actions), 'reasonLocally returns actions');
  }

  console.log(`test_bundle_load: all passed (${files.length} files, ${REQUIRED_GLOBALS.length} globals)`);
})().catch((e) => {
  console.error('test_bundle_load FAILED:', e);
  process.exit(1);
});
