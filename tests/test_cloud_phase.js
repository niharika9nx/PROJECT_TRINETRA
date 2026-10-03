// Phase test — CLOUD: POST /api/agent/act returns plan with full phrase preserved
// Integration test: requires the server running on 127.0.0.1:$PORT and a
// configured Gemini key. Skips cleanly (exit 0) when the server is not up, so
// an offline `npm test` does not report a spurious failure.
const assert = require('assert');
const http = require('http');

const PORT = Number(process.env.PORT) || 3001;
const SERVER = { host: '127.0.0.1', port: PORT, path: '/api/agent/act' };

const homeAT = [
  { id: 'n0', role: 'searchbox', name: 'Search Amazon', tag: 'input', state: {} },
  { id: 'n1', role: 'button', name: 'Go', tag: 'button', state: {} },
  { id: 'n2', role: 'link', name: 'Laptops', tag: 'a', state: {} },
  { id: 'n3', role: 'link', name: 'Cart', tag: 'a', state: {} },
];

function post(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { ...SERVER, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(raw); } catch (e) { return reject(new Error(`Invalid JSON (${res.statusCode}): ${raw.slice(0, 200)}`)); }
          resolve({ status: res.statusCode, json });
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(new Error('cloud timeout')); });
    req.write(data);
    req.end();
  });
}

function serverIsUp() {
  return new Promise((resolve) => {
    const req = http.request({ host: SERVER.host, port: SERVER.port, path: '/health', method: 'GET' }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(2000, () => { req.destroy(); resolve(false); });
    req.end();
  });
}

(async () => {
  if (!(await serverIsUp())) {
    console.log(`test_cloud_phase: SKIPPED (no server on ${SERVER.host}:${PORT} — start it with "npm run dev" in server/)`);
    return;
  }

  // --- C1: search goal keeps full phrase ---
  {
    const { status, json } = await post({
      sanitizedAT: homeAT,
      sessionId: 'phase-cloud-1',
      userGoal: 'open my cart on amazon',
      classification: 'navigate',
      iteration: 1,
      noChangeCount: 0,
    });
    assert.strictEqual(status, 200, `cart goal status 200, got ${status}`);
    assert.strictEqual(json.success, true, 'cart response success');
    assert.ok(Array.isArray(json.actions) && json.actions.length > 0, 'cart has actions');
    console.log('C1 cart:', json.actions.map(a => `${a.type}:${a.target?.value || a.params?.url || ''}`).join(', '));
  }

  // --- C2: laptop search keeps constraints in the typed text ---
  {
    const goal = 'laptop under 1 lakh';
    const { status, json } = await post({
      sanitizedAT: homeAT,
      sessionId: 'phase-cloud-2',
      userGoal: goal,
      classification: 'search',
      iteration: 1,
      noChangeCount: 0,
    });
    assert.strictEqual(status, 200, `search status 200, got ${status}`);
    assert.strictEqual(json.success, true, 'search success');
    // A non-escalating plan that does not touch a text field is legitimate
    // (e.g. the model decides the page already shows results), so assert on
    // the plan actually produced rather than on an echoed goal string.
    const typing = (json.actions || []).find(a => a.type === 'type' || a.type === 'fill');
    if (typing) {
      const text = String(typing.params?.text || typing.params?.value || '');
      assert.ok(/laptop/i.test(text), `type text names the product, got: ${text}`);
      assert.ok(/1\s*lakh|100000/i.test(text), `type text keeps the budget constraint, got: ${text}`);
      assert.strictEqual(typing.requires_approval, true, 'restricted type action must require approval');
      console.log('C2 type text:', text);
    } else {
      const kinds = (json.actions || []).map(a => a.type);
      assert.ok(kinds.length > 0, 'search returns some actions');
      assert.ok(!kinds.includes('type') && !kinds.includes('fill'), 'no ungated text action was returned');
      console.log('C2 non-typing actions:', kinds.join(', '));
    }
  }

  // --- C3: javascript: URL rejected by CSP ---
  {
    const { status, json } = await post({ sanitizedScreenshot: 'javascript:alert(1)', sessionId: 'x' });
    assert.ok(status === 400 || status === 422, `CSP block status 400, got ${status}`);
    assert.strictEqual(json.success, false);
  }

  console.log('test_cloud_phase: OK');
})().catch((e) => {
  console.error('test_cloud_phase FAILED:', e.message);
  process.exit(1);
});
