import 'dotenv/config';
import { buildSystemPrompt, buildUserPrompt } from './providers/gemini_adapter.js';

const key = process.env.GEMINI_API_KEY;

async function testDifference() {
  const mockInput = {
    sessionId: 'test-direct-1',
    userGoal: 'fetch me a good gojo satoru keychain under 500',
    sanitizedAT: [
      { id: 'twotabsearchtextbox', role: 'searchbox', name: 'Search Amazon.in', tag: 'input' },
      { id: 'nav-search-submit-button', role: 'button', name: 'Go', tag: 'input' }
    ],
    iteration: 1
  };

  const model = 'gemini-3-flash-preview';
  // Test 1: Short prompt from test_prompt.js that worked
  console.log('--- Test 1: Short prompt ---');
  const res1 = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: 'Return JSON: {"status": "ok"}' }] }]
    })
  });
  console.log('Test 1 status:', res1.status);

  // Test 2: gemini_adapter userPrompt alone
  console.log('--- Test 2: gemini_adapter userPrompt alone ---');
  const userP = buildUserPrompt(mockInput);
  const res2 = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: userP }] }]
    })
  });
  console.log('Test 2 status:', res2.status);

  // Test 3: systemPrompt alone
  console.log('--- Test 3: systemPrompt alone ---');
  const sysP = buildSystemPrompt();
  const res3 = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: sysP }] }]
    })
  });
  console.log('Test 3 status:', res3.status);
}

testDifference().catch(console.error);
