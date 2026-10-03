// Phase test — FULL LOOP: classify → observe → cloud → execute → evaluate (mocked cloud + location)
const assert = require('assert');

// Mock browser location so URL is the page-change signal
global.location = { href: 'https://shop.example.com/' };

const { runFullLoop, classifyQuery, isGoalAchieved } = require('../lib/workflow_loop.js');

const homeAT = [
  { id: 'n0', role: 'searchbox', name: 'Search Amazon', tag: 'input', state: {} },
  { id: 'n1', role: 'button', name: 'Go', tag: 'button', state: {} },
  { id: 'n2', role: 'link', name: 'Laptops', tag: 'a', state: {} },
];
const resultsAT = [
  { id: 'r0', role: 'searchbox', name: 'Search Amazon', tag: 'input', state: {} },
  { id: 'r1', role: 'link', name: 'HP Laptop under 1 lakh', tag: 'a', state: {} },
  { id: 'r2', role: 'generic', name: 'Results for laptop under 1 lakh', tag: 'div', state: {} },
];

(async () => {
  const steps = [];
  const onStep = (p) => steps.push(p);

  let cloudCalls = 0;
  const execLog = [];

  const result = await runFullLoop({
    userGoal: 'laptop under 1 lakh',
    getAT: async () => (execLog.length > 0 ? resultsAT : homeAT),
    getScreenshot: null,
    executePlanFn: async ({ actions }) => {
      execLog.push(...actions);
      // Simulate SPA/URL navigation after submit
      if (actions.some(a => a.type === 'submit' || a.type === 'navigate')) {
        global.location.href = 'https://shop.example.com/s?k=laptop+under+1+lakh';
      }
      return { success: true, results: actions.map((a) => ({ action: a, result: { success: true } })), failedCount: 0 };
    },
    reasonFn: async () => ({
      confidence: 1,
      needs_escalation: true,
      actions: [],
      reasoning: 'local should escalate for search',
    }),
    sanitizeFn: async ({ at }) => ({ sanitizedScreenshot: null, sanitizedAT: at, report: { redacted_regions: [] } }),
    cloudCallFn: async (payload) => {
      cloudCalls++;
      assert.ok(payload.userGoal.includes('1 lakh'), 'cloud gets full goal');
      assert.strictEqual(payload.classification, 'search', 'classification hint sent to cloud');
      if (cloudCalls === 1) {
        return {
          success: true,
          actions: [
            { id: 'a1', type: 'type', requires_approval: false, target: { mode: 'at_node_id', value: 'n0' }, params: { text: 'laptop under 1 lakh' } },
            { id: 'a2', type: 'submit', requires_approval: false, target: { mode: 'at_node_id', value: 'n0' }, params: {} },
          ],
          reasoning: 'typing full phrase and submitting',
        };
      }
      return { success: true, actions: [{ id: 'a3', type: 'click', requires_approval: false, target: { mode: 'at_node_id', value: 'r1' }, params: {} }], reasoning: 'clicked result' };
    },
    onStep,
    maxIterations: 5,
    threshold: 0.7,
  });

  const kinds = steps.map((s) => s.step);
  assert.ok(kinds.includes('classify'), 'emits classify');
  assert.ok(kinds.includes('observe') && kinds.includes('observed'), 'emits observe');
  assert.ok(kinds.includes('cloud_call') && kinds.includes('cloud_result'), 'emits cloud phases');
  assert.ok(!kinds.includes('cloud_error'), 'no cloud_error when cloudCallFn works');
  assert.ok(kinds.includes('execute') || kinds.includes('executed'), 'emits execute');
  assert.ok(kinds.includes('page_transitioned') || kinds.includes('evaluate'), 'emits transition/evaluate');
  assert.ok(cloudCalls >= 1, 'cloud called at least once');
  assert.ok(execLog.some(a => a.type === 'type' && /1 lakh/.test(a.params?.text || '')), 'executed full-phrase type');
  assert.strictEqual(result.success, true, `loop succeeded: ${result.reason}`);
  assert.strictEqual(result.reason, 'Goal achieved');
  console.log('test_loop_phase: OK', { cloudCalls, iter: result.iteration, kinds: kinds.join(',') });
})().catch((e) => {
  console.error('test_loop_phase FAILED:', e);
  process.exit(1);
});
