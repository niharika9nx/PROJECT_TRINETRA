import 'dotenv/config';
import { callGeminiModel } from './providers/gemini_adapter.js';

async function testDirect() {
  const start = Date.now();
  try {
    const res = await callGeminiModel({
      sessionId: 'test-direct-1',
      userGoal: 'fetch me a good gojo satoru keychain under 500',
      sanitizedAT: [
        { id: 'twotabsearchtextbox', role: 'searchbox', name: 'Search Amazon.in', tag: 'input' },
        { id: 'nav-search-submit-button', role: 'button', name: 'Go', tag: 'input' }
      ],
      iteration: 1
    });
    console.log('SUCCESS in ' + (Date.now() - start) + 'ms:');
    console.dir(res, { depth: null });
  } catch (e) {
    console.error('FAILED in ' + (Date.now() - start) + 'ms:', e);
  }
}

testDirect();
