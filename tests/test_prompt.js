// Gemini prompt must reason from full goal + AT, not strip constraints / only search
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'providers', 'gemini_adapter.ts'),
  'utf8'
);

// Extract buildSystemPrompt template literal body (between return ` and `;)
const m = src.match(/export function buildSystemPrompt\(\)[\s\S]*?return `([\s\S]*?)`;/);
assert.ok(m, 'buildSystemPrompt found');
const prompt = m[1];

// Must NOT teach constraint stripping (old bug)
assert.ok(
  !/search for "gojo satoru keychain"/.test(prompt),
  'prompt must not strip "under 500" → bare product keywords example'
);
assert.ok(
  !/Extract concise, effective search keywords from userGoal \(e.g\./.test(prompt),
  'prompt must not instruct keyword-only extraction that drops constraints'
);

// Must reason about full goal + constraints
assert.ok(/constraints/i.test(prompt), 'prompt mentions constraints');
assert.ok(/do not discard/i.test(prompt), 'prompt says do not discard constraints');
assert.ok(/laptop under 1 lakh|budget/i.test(prompt), 'prompt keeps budget constraint in type text guidance');

// Must cover navigation goals (open cart / go to page)
assert.ok(/navigation|navigate/i.test(prompt), 'prompt covers navigation');
assert.ok(/cart|link\/button/i.test(prompt), 'prompt covers opening pages via AT links');

// Must prefer AT node ids
assert.ok(/at_node_id/.test(prompt), 'prompt includes at_node_id targeting');

// User prompt must support recent actions when provided
const um = src.match(/export function buildUserPrompt\([\s\S]*?\n}/);
assert.ok(um, 'buildUserPrompt found');
assert.ok(/recentActions/.test(src), 'GeminiInput / user prompt supports recentActions');
assert.ok(/Recent attempts/.test(src), 'user prompt injects recent attempts');

console.log('test_prompt: all passed');
