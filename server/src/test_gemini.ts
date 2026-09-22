import 'dotenv/config';
import { callGeminiModel } from './providers/gemini_adapter.js';

async function testGemini() {
  const mockAmazonAT = [
    { id: 'nav-logo', role: 'link', name: 'Amazon.in', tag: 'a' },
    { id: 'twotabsearchtextbox', role: 'searchbox', name: 'Search Amazon.in', tag: 'input' },
    { id: 'nav-search-submit-button', role: 'button', name: 'Go', tag: 'input' },
    { id: 'deal-1', role: 'link', name: 'Deals of the day', tag: 'a' },
    { id: 'cat-1', role: 'link', name: 'Electronics', tag: 'a' }
  ];

  try {
    const result = await callGeminiModel({
      userGoal: 'fetch me a good gojo satoru keychain under 500',
      sanitizedAT: mockAmazonAT,
      sessionId: 'test-session-amazon',
      iteration: 1
    });

    console.log('Gemini Result:');
    console.log('Confidence:', result.confidence);
    console.log('Reasoning:', result.reasoning);
    console.log('Actions:');
    console.dir(result.actions, { depth: null });
  } catch (e) {
    console.error('Gemini error:', e);
  }
}

testGemini();
