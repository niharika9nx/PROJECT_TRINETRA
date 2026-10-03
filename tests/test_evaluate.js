// Step 4 — EVALUATE: isGoalAchieved regression tests (Bug 3 false-positive fixes)
const assert = require('assert');
const { isGoalAchieved, classifyQuery } = require('../lib/workflow_loop.js');

// Fixture ATs
const homepageAT = [
  { id: 'n0', role: 'link', name: 'Laptops', tag: 'a', state: {} },
  { id: 'n1', role: 'link', name: 'Laptops', tag: 'a', state: {} },
  { id: 'n2', role: 'link', name: 'Laptops', tag: 'a', state: {} },
  { id: 'n3', role: 'searchbox', name: 'Search Amazon', tag: 'input', state: {} },
  { id: 'n4', role: 'generic', name: 'Welcome', tag: 'div', state: {} },
];

const resultsAT = [
  { id: 'n0', role: 'searchbox', name: 'Search Amazon', tag: 'input', state: {} },
  { id: 'n1', role: 'link', name: 'HP Laptop 15s, Ryzen 5 — ₹42,990', tag: 'a', state: {} },
  { id: 'n2', role: 'link', name: 'Lenovo IdeaPad Slim 3 — ₹38,990', tag: 'a', state: {} },
  { id: 'n3', role: 'link', name: 'ASUS Vivobook 15 — ₹55,990', tag: 'a', state: {} },
  { id: 'n4', role: 'generic', name: 'Results', tag: 'div', state: {} },
];

const goal = 'fetch me a laptop';
const cls = classifyQuery(goal);
assert.strictEqual(cls.type, 'search', 'fetch goal classifies as search');

// --- REGRESSION 1: planned submit but execResult shows failure → NOT achieved ---
{
  const history = [{
    iteration: 1,
    reasoning: { actions: [{ type: 'submit' }, { type: 'click' }], confidence: 3 },
    execResult: {
      success: false,
      failedCount: 2,
      results: [
        { action: { type: 'submit' }, result: { success: false, error: 'not found' } },
        { action: { type: 'click' }, result: { success: false, error: 'not found' } },
      ],
    },
    observation: { at: homepageAT, url: 'https://amazon.in/' },
  }];
  const atDiff = { pageChanged: true, urlChanged: true, urlKnown: true }; // even with pageChanged
  const achieved = isGoalAchieved({ at: resultsAT, userGoal: goal, iteration: 2, history, atDiff, classification: cls });
  assert.strictEqual(achieved, false, 'REGRESSION: planned-but-failed submit must NOT count as didSearch');
}

// --- REGRESSION 2: no URL change (same page) → NOT achieved even with successful submit ---
{
  const history = [{
    iteration: 1,
    reasoning: { actions: [{ type: 'submit' }] },
    execResult: {
      success: true,
      results: [{ action: { type: 'submit' }, result: { success: true } }],
    },
    observation: { at: homepageAT, url: 'https://amazon.in/' },
  }];
  const atDiff = { pageChanged: false, urlChanged: false, urlKnown: true, nodeCountDelta: 80 };
  const achieved = isGoalAchieved({ at: homepageAT, userGoal: goal, iteration: 2, history, atDiff, classification: cls });
  assert.strictEqual(achieved, false, 'REGRESSION: same URL + churn must NOT count as pageChanged');
}

// --- REGRESSION 3: homepage nav links alone (no URL change) → NOT achieved ---
{
  const history = [{
    iteration: 1,
    reasoning: { actions: [{ type: 'submit' }] },
    execResult: { success: true, results: [{ action: { type: 'submit' }, result: { success: true } }] },
  }];
  // 3 "Laptops" nav links exist, but URL never changed
  const atDiff = { pageChanged: false, urlChanged: false, urlKnown: true };
  const achieved = isGoalAchieved({ at: homepageAT, userGoal: goal, iteration: 2, history, atDiff, classification: cls });
  assert.strictEqual(achieved, false, 'REGRESSION: nav links without URL change → not achieved');
}

// --- POSITIVE: real submit success + URL change + product links → achieved at iter >= 2 ---
{
  const history = [{
    iteration: 1,
    reasoning: { actions: [{ type: 'submit' }] },
    execResult: { success: true, results: [{ action: { type: 'submit' }, result: { success: true } }] },
    observation: { at: resultsAT, url: 'https://amazon.in/s?k=laptop' },
  }];
  const atDiff = { pageChanged: true, urlChanged: true, urlKnown: true, nodeCountDelta: 40 };
  const achieved = isGoalAchieved({ at: resultsAT, userGoal: goal, iteration: 2, history, atDiff, classification: cls });
  assert.strictEqual(achieved, true, 'real submit + URL change + product links → achieved');
}

// --- iteration < 2 → never achieved on first pass ---
{
  const history = [{
    iteration: 1,
    reasoning: { actions: [{ type: 'submit' }] },
    execResult: { success: true, results: [{ action: { type: 'submit' }, result: { success: true } }] },
  }];
  const atDiff = { pageChanged: true, urlChanged: true, urlKnown: true };
  const achieved = isGoalAchieved({ at: resultsAT, userGoal: goal, iteration: 1, history, atDiff, classification: cls });
  assert.strictEqual(achieved, false, 'iteration 1 never achieves search goal');
}

// --- navigate-type success also counts as didSearch ---
{
  const history = [{
    iteration: 1,
    reasoning: { actions: [{ type: 'navigate' }] },
    execResult: { success: true, results: [{ action: { type: 'navigate' }, result: { success: true } }] },
  }];
  const atDiff = { pageChanged: true, urlChanged: true, urlKnown: true };
  const achieved = isGoalAchieved({ at: resultsAT, userGoal: goal, iteration: 2, history, atDiff, classification: cls });
  assert.strictEqual(achieved, true, 'successful navigate counts as search transition');
}

// --- REGRESSION: phantom submit (execResult success) + same URL → NOT achieved ---
{
  const history = [{
    iteration: 1,
    reasoning: { actions: [{ type: 'submit' }] },
    execResult: { success: true, results: [{ action: { type: 'submit' }, result: { success: true, method: 'form_submit_button' } }] },
    observation: { at: homepageAT, url: 'https://amazon.in/' },
  }];
  const atDiff = { pageChanged: false, urlChanged: false, urlKnown: true, prevURL: 'https://amazon.in/', currURL: 'https://amazon.in/' };
  const achieved = isGoalAchieved({ at: homepageAT, userGoal: goal, iteration: 2, history, atDiff, classification: cls });
  assert.strictEqual(achieved, false, 'phantom submit success + same URL → not achieved');
}

// --- navigate classification branch still works ---
{
  const navCls = classifyQuery('go to amazon.in');
  assert.strictEqual(navCls.type, 'navigate');
  const achieved = isGoalAchieved({
    at: [{ id: 'x', role: 'link', name: 'Amazon', tag: 'a' }],
    userGoal: 'go to amazon deals',
    iteration: 2,
    history: [],
    atDiff: { pageChanged: true, urlChanged: true, urlKnown: true },
    classification: navCls,
  });
  assert.strictEqual(achieved, true, 'navigate: pageChanged + keyword → true');
}

// --- order branch (purchase intent; 'auth_gated' is the legacy alias) ---
{
  const orderCls = classifyQuery('buy this laptop');
  assert.strictEqual(orderCls.type, 'order', 'purchase intent classifies as order');
  const notAchieved = isGoalAchieved({
    at: [{ id: 'x', role: 'generic', name: 'Product page', tag: 'div' }],
    userGoal: 'buy this laptop', iteration: 3, history: [], atDiff: null, classification: orderCls,
  });
  assert.strictEqual(notAchieved, false, 'order without order confirmation → false');

  const achieved = isGoalAchieved({
    at: [{ id: 'x', role: 'generic', name: 'Your order has been placed', tag: 'div' }],
    userGoal: 'buy this laptop', iteration: 3, history: [], atDiff: null, classification: orderCls,
  });
  assert.strictEqual(achieved, true, 'order with order confirmation → true');

  // Reaching a checkout page is NOT a placed order.
  const atCheckout = isGoalAchieved({
    at: [{ id: 'x', role: 'button', name: 'Proceed to checkout', tag: 'button' }],
    userGoal: 'buy this laptop', iteration: 3, history: [], atDiff: null, classification: orderCls,
  });
  assert.strictEqual(atCheckout, false, 'a checkout page is not an order confirmation');

  // The legacy classification name still routes the same way.
  const legacy = isGoalAchieved({
    at: [{ id: 'x', role: 'generic', name: 'Order confirmed', tag: 'div' }],
    userGoal: 'buy this laptop', iteration: 3, history: [], atDiff: null,
    classification: { type: 'auth_gated' },
  });
  assert.strictEqual(legacy, true, 'auth_gated remains a working alias for order');
}

// --- info classification ---
{
  const infoCls = classifyQuery('what is the price of this laptop');
  assert.strictEqual(infoCls.type, 'info');
  const achieved = isGoalAchieved({
    at: [{ id: 'x', role: 'generic', name: 'laptop price ₹42990', tag: 'span' }],
    userGoal: 'laptop price', iteration: 1, history: [], atDiff: null, classification: infoCls,
  });
  assert.strictEqual(achieved, true, 'info: keyword visible → true');
}

// --- open my cart → navigate (not auth_gated) ---
{
  const cartCls = classifyQuery('open my cart');
  assert.strictEqual(cartCls.type, 'navigate', '"open my cart" classifies as navigate');
}

// --- cart achievement via pageChanged + keywords ---
{
  const cartCls = classifyQuery('open my cart');
  const cartAT = [
    { id: 'h', role: 'heading', name: 'Your Amazon Cart', tag: 'h1' },
    { id: 'i', role: 'generic', name: 'Cart 0 items', tag: 'div' },
  ];
  const achieved = isGoalAchieved({
    at: cartAT,
    userGoal: 'open my cart',
    iteration: 2,
    history: [{ iteration: 1, execResult: { success: true, results: [{ action: { type: 'click' }, result: { success: true } }] } }],
    atDiff: { pageChanged: true, urlChanged: true, urlKnown: true, currURL: 'https://www.amazon.in/gp/cart/view.html' },
    classification: cartCls,
  });
  assert.strictEqual(achieved, true, 'navigate + cart heading + pageChanged → achieved');
}

// --- cart achievement via URL path containing goal noun ---
{
  const cartCls = classifyQuery('open my cart');
  const minimalAT = [{ id: 'a', role: 'generic', name: 'Subtotal', tag: 'div' }];
  const achieved = isGoalAchieved({
    at: minimalAT,
    userGoal: 'open my cart',
    iteration: 2,
    history: [{ execResult: { success: true } }],
    atDiff: { pageChanged: true, urlChanged: true, urlKnown: true, currURL: 'https://www.amazon.in/cart' },
    classification: cartCls,
  });
  assert.strictEqual(achieved, true, 'URL /cart + pageChanged → achieved');
}

// --- add to cart is NOT navigate (stays non-navigate so search/action paths apply) ---
{
  assert.notStrictEqual(classifyQuery('add this to cart').type, 'navigate', 'add to cart is not pure navigate');
}

console.log('test_evaluate: all passed');
