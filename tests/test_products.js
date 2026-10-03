// Trinetra — product selection & purchase safety tests
//
// Two capabilities under test:
//   1. Choosing ONE product from a results page for goals like
//      "open the best laptop under 60000" — requires grouping the flat AT into
//      product cards and reading price/rating out of each.
//   2. The purchase safety boundary. Placing an order is irreversible, so the
//      guard must hold even when the planner asks for something dangerous —
//      these tests encode the line that must never be crossed.

const assert = require('assert');
const path = require('path');

const P = require(path.join(__dirname, '..', 'lib', 'products.js'));

const L = (id, name) => ({ id, role: 'link', name, tag: 'a', state: {} });
const T = (id, name) => ({ id, role: 'text', name, tag: 'span', state: {} });
const B = (id, name) => ({ id, role: 'button', name, tag: 'button', state: {} });
const click = (id) => ({ id, type: 'click', target: { mode: 'at_node_id', value: id }, params: {} });
const type = (id, text) => ({ id, type: 'type', target: { mode: 'at_node_id', value: id }, params: { text } });

// A realistic Amazon-shaped results page: chrome, then three product cards.
const RESULTS = [
  L('nav1', 'Cart'), B('nav2', 'Search'),
  L('p1', 'ASUS VivoBook 15 Ryzen 5 8GB 512GB SSD'),
  T('p1r', '4.2 out of 5 stars'), T('p1p', '₹45,999'),
  L('p2', 'HP 15s Ryzen 5 8GB 512GB SSD Laptop'),
  T('p2r', '4.5 out of 5 stars'), T('p2p', '₹52,499'),
  L('p3', 'Dell Inspiron 15 Intel Core i5 16GB'),
  T('p3r', '4.0 out of 5 stars'), T('p3p', '₹39,999'),
  B('ac1', 'Add to cart'),
];

let checks = 0;
const eq = (label, got, want) => {
  checks++;
  assert.deepStrictEqual(got, want, `${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
};
const ok = (label, cond) => {
  checks++;
  assert.ok(cond, label);
};

// ---------- 1. A rating must never be read as a price ----------
// This was a real bug: "4.2 out of 5 stars" parsed as a price of 4.2, which
// made every product look free and defeated the budget filter.
{
  eq('bare rating', P.parsePrice('4.2 out of 5 stars'), null);
  eq('rated prefix', P.parsePrice('Rated 4.2'), null);
  eq('review count', P.parsePrice('2,341 ratings'), null);
  eq('bare decimal', P.parsePrice('4.6'), null);
  eq('rupee price', P.parsePrice('₹45,999'), 45999);
  eq('rs prefix', P.parsePrice('Rs. 1,49,999'), 149999);
  eq('mrp prefix', P.parsePrice('MRP ₹1,49,999'), 149999);
  eq('bare grouped', P.parsePrice('59,999'), 59999);
  eq('lakh unit', P.parsePrice('1.5 lakh'), 150000);
  eq('price with review count', P.parsePrice('₹45,999 (2,341 ratings)'), 45999);
}

// ---------- 2. Budget parsing, including the bare L shorthand ----------
{
  eq('bare number', P.parseBudget('best laptop under 40000'), 40000);
  eq('lakh', P.parseBudget('best laptop under 1 lakh'), 100000);
  eq('lakh shorthand', P.parseBudget('under 1.5L'), 150000);
  eq('crore', P.parseBudget('under 1 crore'), 10000000);
  eq('below', P.parseBudget('below 2000'), 2000);
  eq('within', P.parseBudget('within 50k'), 50000);
  eq('no budget', P.parseBudget('open the best laptop'), null);
  // "20litre" must not read the "l" as a lakh marker.
  eq('l not a unit mid-word', P.parseBudget('20litre under 5'), 5);
}

// ---------- 3. Card grouping on a results page ----------
{
  const prods = P.extractProducts(RESULTS);
  eq('three product cards', prods.length, 3);
  eq('p1 price', prods[0].price, 45999);
  eq('p1 rating', prods[0].rating, 4.2);
  eq('p3 price', prods[2].price, 39999);
  eq('chrome links excluded', prods.some((p) => p.title === 'Cart'), false);
  eq('empty AT', P.extractProducts([]), []);
  eq('null AT', P.extractProducts(null), []);
}

// ---------- 4. Selection picks ONE product that satisfies the goal ----------
{
  const prods = P.extractProducts(RESULTS);
  eq('best within budget', P.pickBestProduct(prods, 'open the best laptop under 60000').product.id, 'p2');
  eq('cheapest wins for cheapest', P.pickBestProduct(prods, 'cheapest laptop under 60000').product.id, 'p3');
  eq('budget narrows candidates', P.pickBestProduct(prods, 'best laptop under 40000').product.id, 'p3');
  eq('no budget still returns one', P.pickBestProduct(prods, 'open the best laptop').product.id, 'p2');
  eq('nothing to pick', P.pickBestProduct([], 'open best laptop'), null);

  const sel = P.pickBestProduct(prods, 'open the best laptop under 60000');
  ok('selection explains itself', /budget/i.test(sel.reason) && /rating/i.test(sel.reason));
  ok('selected product is addressable', !!sel.product.id);

  // A product outside every budget must not be chosen when an affordable one exists.
  const pricey = P.extractProducts([
    L('q1', 'Ultra Premium Laptop Pro Max'), T('q1r', '4.9 out of 5 stars'), T('q1p', '₹2,50,000'),
    L('q2', 'Basic Laptop'), T('q2r', '3.8 out of 5 stars'), T('q2p', '₹30,000'),
  ]);
  eq('over-budget favourite rejected', P.pickBestProduct(pricey, 'best laptop under 60000').product.id, 'q2');
}

// ---------- 5. Product detail vs results page ----------
{
  const detail = [
    T('d1', 'ASUS VivoBook 15'), T('d2', '₹45,999'),
    B('d3', 'Add to cart'), B('d4', 'Buy Now'), T('d5', '4.2 out of 5 stars'),
  ];
  eq('results page', P.isProductDetailPage(RESULTS, 'https://amazon.in/s?k=laptop'), false);
  eq('detail via product url', P.isProductDetailPage(RESULTS, 'https://amazon.in/dp/B0ABC12345'), true);
  eq('detail via buy button', P.isProductDetailPage(detail, 'https://amazon.in/somewhere'), true);
  eq('detail needs a buy button', P.isProductDetailPage([T('x', 'just text')], 'https://amazon.in/x'), false);
}

// ---------- 6. SAFETY: credentials are never typed ----------
{
  for (const [label, target, text] of [
    ['card number', 'cardNumber', '4111 1111 1111 1111'],
    ['cvv', 'cvv-input', '123'],
    ['otp', 'otp', '123456'],
    ['expiry', 'expiry', '03/28'],
    ['account number', 'accountNumber', '000111222333'],
  ]) {
    const g = P.guardPurchaseActions([type('f1', text)], [{ id: 'f1', ...B('f1', label) }], 'order');
    eq(`${label} typing blocked`, g.actions.length, 0);
    ok(`${label} blocked with a reason`, /never typed/i.test(g.refused[0] && g.refused[0].reason));
  }
}

// ---------- 7. SAFETY: the final commit needs a priced confirmation ----------
// The planner targets at_node_id, so the button's label is in the AT, not the
// action. The guard must resolve it or it would wave through "Place your order".
{
  const cart = [
    L('c1', 'ASUS VivoBook 15'),
    T('c2', 'Order Total: ₹1,29,999'),
    B('c3', 'Place your order'),
    B('c4', 'Add to cart'),
  ];
  const g = P.guardPurchaseActions([click('c3'), click('c4')], cart, 'order');
  eq('commit held back for confirmation', g.actions.map((a) => a.id), ['c4']);
  eq('one confirmation offered', g.purchaseConfirmations.length, 1);
  eq('total read from the page', g.purchaseConfirmations[0].total, 129999);
  eq('item read from the page', g.purchaseConfirmations[0].item, 'ASUS VivoBook 15');

  // A commit we cannot price is refused outright, never gated.
  const blind = P.guardPurchaseActions([click('x1')], [B('x1', 'Place your order')], 'order');
  eq('unpriced commit not offered', blind.purchaseConfirmations.length, 0);
  eq('unpriced commit not executed', blind.actions.length, 0);
  eq('unpriced commit reported', blind.refused.length, 1);
  ok('unpriced refusal explains why', /total/i.test(blind.refused[0].reason));
}

// ---------- 8. SAFETY: committing is only guarded on an order goal ----------
{
  const cart = [T('c2', 'Order Total: ₹1,29,999'), B('c3', 'Place your order'), B('c4', 'Add to cart')];
  const browse = P.guardPurchaseActions([click('c4')], cart, 'select_product');
  eq('add to cart allowed while browsing', browse.actions.length, 1);
  eq('no purchase prompt while browsing', browse.purchaseConfirmations.length, 0);

  const search = P.guardPurchaseActions([click('c4')], cart, 'search');
  eq('add to cart allowed while searching', search.actions.length, 1);
}

// ---------- 9. The guard never blocks a normal browse/search plan ----------
{
  const plan = [
    { id: '1', type: 'click', target: { mode: 'at_node_id', value: 'p2' }, params: {} },
    { id: '2', type: 'scroll', target: null, params: { amount: 300 } },
    { id: '3', type: 'read', target: null, params: {} },
  ];
  const g = P.guardPurchaseActions(plan, RESULTS, 'select_product');
  eq('nothing refused', g.refused.length, 0);
  eq('everything passes', g.actions.length, 3);
  eq('no purchase prompt', g.purchaseConfirmations.length, 0);
}

// ---------- 10. Malformed input is survivable ----------
{
  eq('null actions', P.guardPurchaseActions(null, null, 'order').actions.length, 0);
  eq('null at', P.isProductDetailPage(null, null), false);
  eq('no goal', P.parseBudget(undefined), null);
  eq('preference default', P.parsePreference(''), 'best');
}

// ---------- 11. Classification routes the new intents ----------
{
  const loop = require(path.join(__dirname, '..', 'lib', 'workflow_loop.js'));
  // The reported bug: /open/ matched first, so "open best laptop" became
  // navigate and never selected a product.
  eq('open best laptop', loop.classifyQuery('open best laptop').type, 'select_product');
  eq('open the best laptop under 60000', loop.classifyQuery('open the best laptop under 60000').type, 'select_product');
  eq('show me the cheapest phone', loop.classifyQuery('show me the cheapest phone').type, 'select_product');
  eq('pick the top rated laptop', loop.classifyQuery('pick the top rated laptop').type, 'select_product');
  // Navigation must survive.
  eq('open my cart', loop.classifyQuery('open my cart').type, 'navigate');
  eq('go to orders', loop.classifyQuery('go to orders').type, 'navigate');
  eq('go to amazon.in', loop.classifyQuery('go to amazon.in').type, 'navigate');
  eq('visit settings', loop.classifyQuery('visit settings').type, 'navigate');
  // Order intent.
  eq('place order', loop.classifyQuery('place order for the laptop').type, 'order');
  eq('buy it', loop.classifyQuery('buy it').type, 'order');
  eq('checkout', loop.classifyQuery('checkout').type, 'order');
  // Existing buckets still work.
  eq('plain search', loop.classifyQuery('find me a laptop').type, 'search');
  eq('what is the price', loop.classifyQuery('what is the price').type, 'info');
  eq('add to cart', loop.classifyQuery('add to cart').type, 'action');
}

// ---------- 12/13: end-to-end through runFullLoop ----------
// Wrapped in an async IIFE: this file is CommonJS and top-level await is
// ambiguous for Node's module-format detection.
(async () => {
  const loop = require(path.join(__dirname, '..', 'lib', 'workflow_loop.js'));

  // ---------- 12. Select one product and open it ----------
  {
    let currentAT = [B('s', 'Search'), { id: 'q', role: 'textbox', name: 'Search Amazon', tag: 'input', state: {} }];
    // observePage reads the real location, so drive that rather than a local var.
    global.location = { href: 'https://amazon.in/' };
    const executed = [];
    // Record the page state at the moment the loop declares the goal met.
    // The loop evaluates against the observation taken BEFORE execution, so
    // the URL is captured on the 'observed' step, not on 'evaluate'.
    let achievedAt = null;
    let observedUrl = null;
    const steps = [];

    const r = await loop.runFullLoop({
      userGoal: 'open the best laptop under 60000',
      getAT: async () => currentAT,
      getScreenshot: null,
      reasonFn: async () => {
        // Mimic the planner: results present -> click the chosen product.
        const found = P.extractProducts(currentAT);
        if (found.length > 0) {
          const sel = P.pickBestProduct(found, 'open the best laptop under 60000');
          return {
            confidence: 0.9, needs_escalation: false,
            actions: [{ id: '1', type: 'click', target: { mode: 'at_node_id', value: sel.product.id }, params: {} }],
            reasoning: sel.reason,
          };
        }
        return {
          confidence: 0.9, needs_escalation: false,
          actions: [
            { id: '1', type: 'type', target: { mode: 'at_node_id', value: 'q' }, params: { text: 'laptop under 60000' } },
            { id: '2', type: 'submit', target: { mode: 'at_node_id', value: 'q' }, params: {} },
          ],
          reasoning: 'search first',
        };
      },
      executePlanFn: async ({ actions }) => {
        for (const a of actions) {
          executed.push(a);
          if (a.type === 'submit') {
            currentAT = RESULTS;
            global.location.href = 'https://amazon.in/s?k=laptop';
          } else if (a.type === 'click' && P.extractProducts(currentAT).some((p) => p.id === a.target.value)) {
            const sel = P.pickBestProduct(P.extractProducts(currentAT), 'open the best laptop under 60000');
            // A product detail page: buy buttons, one price, and a heading-like
            // link. Note it must NOT look like a results list again.
            currentAT = [
              L('d0', sel.product.title + ' - Product detail'),
              T('pr', '₹52,499'), T('rt', '4.5 out of 5 stars'),
              B('buy', 'Add to cart'), B('bn', 'Buy Now'),
            ];
            global.location.href = 'https://amazon.in/dp/B0XYZ12345';
          }
        }
        return { success: true, results: actions.map((a) => ({ action: a, result: { success: true } })), failedCount: 0 };
      },
      sanitizeFn: async ({ at }) => ({ sanitizedScreenshot: null, sanitizedAT: at, report: { redacted_regions: [] } }),
      cloudCallFn: async () => ({ success: true, actions: [] }),
      onStep: (p) => {
        steps.push(p);
        if (p.step === 'observed') observedUrl = global.location.href;
        if (p.step === 'evaluate' && p.achieved) achievedAt = observedUrl;
      },
      maxIterations: 6,
      threshold: 0.7,
    });

    eq('selection goal succeeds', r.success, true);
    eq('goal reached on a product page', r.reason, 'Goal achieved');
    const clicked = executed.find((a) => a.type === 'click');
    ok('a product was actually clicked', !!clicked);
    eq('the best-rated affordable product was chosen', clicked.target.value, 'p2');
    // The goal must not be declared while still sitting on the results list.
    eq('succeeded only once a product page was open', achievedAt, 'https://amazon.in/dp/B0XYZ12345');
  }

  // ---------- 13. A card number is refused mid-order ----------
  {
    const steps = [];
    const cartAT = [
      L('k1', 'ASUS VivoBook 15'), T('k2', 'Order Total: ₹1,29,999'),
      B('k3', 'Place your order'), { id: 'k4', role: 'textbox', name: 'Card number', tag: 'input', state: {} },
    ];
    await loop.runFullLoop({
      userGoal: 'buy it now',
      getAT: async () => cartAT,
      getScreenshot: null,
      reasonFn: async () => ({
        confidence: 0.9, needs_escalation: false,
        actions: [
          // The planner tries to do the wrong thing; the guard must stop it.
          { id: '1', type: 'type', target: { mode: 'at_node_id', value: 'k4' }, params: { text: '4111 1111 1111 1111' } },
          { id: '2', type: 'click', target: { mode: 'at_node_id', value: 'k3' }, params: {} },
        ],
        reasoning: 'attempting purchase',
      }),
      executePlanFn: async ({ actions }) => {
        // Only the approved commit should reach here — never the card typing.
        for (const a of actions) {
          assert.notStrictEqual(a.type, 'type', 'the card-typing action must never execute');
        }
        return { success: true, results: actions.map((a) => ({ action: a, result: { success: true } })), failedCount: 0 };
      },
      sanitizeFn: async ({ at }) => ({ sanitizedScreenshot: null, sanitizedAT: at, report: { redacted_regions: [] } }),
      cloudCallFn: async () => ({ success: true, actions: [] }),
      confirmPurchaseFn: async () => true,   // user says yes to the order
      onStep: (p) => steps.push(p),
      maxIterations: 2,
      threshold: 0.7,
    });

    const refused = steps.filter((s) => s.step === 'purchase_refused');
    ok('card typing was refused', refused.length >= 1);
    ok('refusal is reported to the user', /never typed/i.test(refused[0].reason));
    const approved = steps.filter((s) => s.step === 'purchase_approved');
    eq('priced commit confirmed with the total', approved[0].total, 129999);
  }

  console.log(`test_products: all passed (${checks} checks)`);
})().catch((e) => {
  console.error('test_products FAILED:', e);
  process.exit(1);
});
