// Trinetra test runner — runs every test_*.js in this directory.
//
// Each file runs in its own process on purpose: several of them replace
// globals (document, CSS, location, MouseEvent), so a single-process runner
// would produce cross-file contamination and phantom failures.
const { spawnSync } = require('child_process');
const path = require('path');

const tests = [
  'test_bundle_load.js',
  'test_observe.js',
  'test_reason.js',
  'test_execute.js',
  'test_evaluate.js',
  'test_navigate_fallback.js',
  'test_prompt.js',
  'test_loop_phase.js',
  'test_approval.js',
  'test_sanitize.js',
  'test_reliability.js',
  'test_products.js',
  'test_cloud_phase.js',
];

let passed = 0;
let failed = 0;
const failures = [];

for (const t of tests) {
  const file = path.join(__dirname, t);
  console.log(`\n=== ${t} ===`);
  const r = spawnSync(process.execPath, [file], { stdio: 'inherit', cwd: __dirname });
  if (r.status === 0) {
    passed++;
  } else {
    failed++;
    failures.push(t);
    console.error(`FAIL: ${t} (exit ${r.status})`);
  }
}

console.log(`\n========== SUMMARY ==========`);
console.log(`Passed: ${passed}/${tests.length}`);
if (failed > 0) {
  console.log(`Failed: ${failed}/${tests.length}`);
  console.log(`Failing: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('All tests passed.');
