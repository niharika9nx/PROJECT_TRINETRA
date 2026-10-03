// Fix 4 — buildSearchNavigateAction: direct navigate fallback URL construction
const assert = require('assert');

// Mock DOM for Node
const mockForm = {
  action: 'https://www.amazon.in/s',
  querySelector: (sel) => {
    if (sel === 'input[name]') return { name: 'k' };
    return null;
  },
};
global.location = { href: 'https://www.amazon.in/', origin: 'https://www.amazon.in', hostname: 'www.amazon.in' };
global.document = {
  querySelector: (sel) => {
    if (sel === '#nav-search-bar-form') return mockForm;
    if (sel && sel.startsWith('form[action')) return null;
    return null;
  },
};

const { buildSearchNavigateAction, isValidNavigateURL } = require('../lib/workflow_loop.js');

// --- builds Amazon search URL from form action ---
{
  const action = buildSearchNavigateAction('find me a laptop under 1 lakh');
  assert.ok(action, 'action should be built');
  assert.strictEqual(action.type, 'navigate', 'type is navigate');
  const url = action.target.value;
  assert.ok(url.startsWith('https://www.amazon.in/s?'), `Amazon search URL, got: ${url}`);
  assert.ok(url.includes('k=laptop'), `search term in URL, got: ${url}`);
  assert.strictEqual(isValidNavigateURL(url), true, 'URL passes validation');
}

// --- extracts product keyword, strips stop words ---
{
  const action = buildSearchNavigateAction('please find me the cheapest wireless headphones');
  const url = action.target.value;
  assert.ok(url.includes('headphones') || url.includes('wireless'), `term extracted, got: ${url}`);
  assert.ok(!url.includes('please'), 'stop words stripped');
}

// --- no document (Node without form) + amazon hostname fallback ---
{
  // Simulate no form found
  const savedQS = global.document.querySelector;
  global.document.querySelector = () => null;
  const action = buildSearchNavigateAction('find a laptop');
  assert.ok(action, 'hostname heuristic fallback works');
  assert.ok(action.target.value.includes('amazon.in/s'), `Amazon heuristic, got: ${action.target.value}`);
  assert.ok(action.target.value.includes('k=laptop'), 'term present');
  global.document.querySelector = savedQS;
}

// --- empty goal → null ---
{
  const action = buildSearchNavigateAction('');
  assert.strictEqual(action, null, 'empty goal returns null');
}

// --- isValidNavigateURL rejects bad URLs ---
{
  assert.strictEqual(isValidNavigateURL('javascript:alert(1)'), false);
  assert.strictEqual(isValidNavigateURL('http://example.com'), false);
  assert.strictEqual(isValidNavigateURL('https://www.amazon.in/s?k=laptop'), true);
}

console.log('test_navigate_fallback: all passed');
