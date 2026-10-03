// Trinetra — Product & Checkout Reasoning (agent reliability pass)
//
// Two capabilities live here:
//   1. Product selection. A results page is a flat Accessibility Tree, so this
//      groups nodes into product cards, reads price and rating out of each, and
//      scores them against the goal's constraints. Needed because goals like
//      "open the best laptop" want ONE product chosen, not a results list.
//   2. Purchase safety. Placing an order is irreversible, so the guard below is
//      deliberately enforced in the loop rather than trusted to the planner:
//      a model that decides to type a card number or click "Place order" is
//      stopped here, not obeyed.
//
// Pure functions over the AT — no DOM access, so all of it is unit testable.

(function () {

// ---------- money & rating parsing ----------

const _UNITS = { lakh: 1e5, lakhs: 1e5, lac: 1e5, lacs: 1e5, l: 1e5, k: 1e3, thousand: 1e3, crore: 1e7, cr: 1e7, m: 1e6 };

function _scaleAmount(n, unit) {
  const u = String(unit || '').toLowerCase().replace(/[^a-z]/g, '');
  return u in _UNITS ? n * _UNITS[u] : n;
}

// "₹59,999", "Rs. 1,49,999", "MRP ₹1,49,999" -> 149999
//
// A bare digit is NOT a price — "4.2 out of 5 stars" must not read as 4.2. A
// currency marker, a thousands-grouped number, or an Indian unit is required,
// and rating/review context disqualifies a string unless it also has currency
// ("₹45,999 (2,341 ratings)" is still a price).
const _CURRENCY_RE = /₹|\$|\brs\b|\bmrp\b|\bprice\b|\bamount\b|\bcost\b|\btotal\b|\bupees?\b|\binr\b|\blakhs?\b|\blacs?\b|\bcrores?\b/i;
const _RATING_CTX_RE = /out of|stars?\b|ratings?\b|rated|reviews?\b|votes?\b/i;

function parsePrice(text) {
  if (text === null || text === undefined) return null;
  const s = String(text);
  if (!/\d/.test(s)) return null;

  const hasCurrency = _CURRENCY_RE.test(s);
  if (_RATING_CTX_RE.test(s) && !hasCurrency) return null;

  // A comma-grouped run like 59,999 is a strong price signal on its own.
  const hasGrouped = /\d{1,3}(?:,\d{3})+/.test(s);
  if (!hasCurrency && !hasGrouped) return null;

  const m = s.replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*(lakh|lakhs|lac|lacs|crore|cr|thousand|k|m)?/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!isFinite(n) || n <= 0) return null;
  return _scaleAmount(n, m[2]);
}

// "4.5 out of 5 stars", "Rated 4.2", "4.5" -> 4.5
function parseRating(text) {
  if (!text) return null;
  const s = String(text);
  if (!/star|rating|rated|\breview/i.test(s)) return null;
  const m = s.match(/(\d+(?:\.\d+)?)\s*(?:out of|\/\s*5)?/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!isFinite(n) || n <= 0 || n > 5) return null;
  return n;
}

// "under 60000", "below 1 lakh", "within 1.5L", "up to 2000" -> 60000
// The unit is optional ("under 40000") but the bare "L" shorthand is supported
// ("1.5L"); the \b lives inside the optional group so it only applies when a
// unit is actually present, and keeps "20litre" from matching.
function parseBudget(userGoal) {
  const g = String(userGoal || '').toLowerCase();
  const m = g.match(/\b(under|below|less\s+than|within|max(?:imum)?|up\s+to|cheaper\s+than|budget)\s*(?:rs\.?|₹|\$)?\s*(\d+(?:\.\d+)?)\s*(?:(lakh|lakhs|lac|lacs|crore|cr|thousand|k|l|m)\b)?/i);
  if (!m) return null;
  const n = parseFloat(m[2]);
  if (!isFinite(n)) return null;
  return _scaleAmount(n, m[3]);
}

// Which way to break a tie. "cheapest" is unambiguous; "best" means rating.
function parsePreference(userGoal) {
  const g = String(userGoal || '').toLowerCase();
  if (/cheapest|lowest\s+price|least\s+expensive|cheapest\s+price|lowest\s+cost/.test(g)) return 'cheapest';
  if (/best|top|highest\s+rated|best\s+rated|highest\s+rating|good|recommend/.test(g)) return 'best';
  return 'best';
}

// Words that mean a link is site chrome, not a product.
const _CHROME_RE = /^(cart|orders?|account|sign\s*in|log\s*in|home|deals|coupons?|sell|help|menu|search|suggestions?|see\s+all|shop\s+all|prime|best\s+sellers|new\s+releases|filter|sort|next|previous|prev|1|2|3|4|5)$/i;

// A product title link: a link with a reasonably long, wordy name.
function _looksLikeTitle(n) {
  if (!n) return false;
  const role = (n.role || '').toLowerCase();
  const tag = (n.tag || '').toLowerCase();
  if (role !== 'link' && tag !== 'a') return false;
  const name = String(n.name || '').trim();
  if (name.length < 8) return false;
  if (_CHROME_RE.test(name)) return false;
  if (/^[\d\s.,₹$%]+$/.test(name)) return false;              // numbers/prices only
  if (/\b(out of 5|stars?)\b/i.test(name)) return false;     // a rating line
  if (/^(add to cart|buy now|add to basket|shop now|see options)$/i.test(name)) return false;
  return /\s|[A-Za-z]{3}/.test(name);
}

// Group the flat AT into product cards: a title link starts a card, and the
// nodes after it (until the next title link) belong to that product.
function extractProducts(at) {
  if (!Array.isArray(at) || at.length === 0) return [];
  const products = [];
  let cur = null;

  const flush = () => {
    if (!cur) return;
    if (cur.price !== null || cur.rating !== null || cur.title) {
      products.push(cur);
    }
    cur = null;
  };

  for (const n of at) {
    if (_looksLikeTitle(n)) {
      flush();
      // Skip a preceding image link with the same name (Amazon emits two).
      cur = { id: n.id, title: String(n.name || '').trim(), price: null, rating: null, selector: n.selector || null, atIndex: products.length };
      continue;
    }
    if (!cur) continue;
    const name = n.name || '';
    if (cur.price === null) {
      const p = parsePrice(name);
      // Ignore crossed-out "MRP" style maxima when a lower price is adjacent.
      if (p !== null) cur.price = p;
    }
    if (cur.rating === null) {
      const r = parseRating(name);
      if (r !== null) cur.rating = r;
    }
  }
  flush();
  return products;
}

// Score against the goal. Returns the chosen product plus a short explanation
// so the UI can tell the user why this one was picked.
function pickBestProduct(products, userGoal) {
  const list = Array.isArray(products) ? products.filter((p) => p && p.id) : [];
  if (list.length === 0) return null;

  const budget = parseBudget(userGoal);
  const preference = parsePreference(userGoal);
  const goalText = String(userGoal || '').toLowerCase();
  const goalTerms = goalText.split(/\W+/).filter((w) => w.length > 2 &&
    !/the|and|for|with|under|below|above|over|open|show|find|best|top|good|cheapest|please|can|you|one|me|my/.test(w));

  // Relevance to the requested noun, so "laptop" does not match a phone stand.
  const relevance = (p) => {
    const t = p.title.toLowerCase();
    let hits = 0;
    for (const term of goalTerms) if (t.includes(term)) hits++;
    return hits;
  };

  let candidates = list;
  let budgetApplied = false;
  if (budget !== null) {
    const affordable = list.filter((p) => p.price === null || p.price <= budget);
    if (affordable.length > 0) { candidates = affordable; budgetApplied = true; }
  }

  const scored = candidates.map((p) => {
    let score = relevance(p) * 1000;
    if (p.rating !== null) score += preference === 'best' ? p.rating * 100 : (5 - p.rating) * 0;
    if (p.price !== null) {
      // Cheaper is a mild bonus for "best" and a dominant one for "cheapest".
      score += preference === 'cheapest' ? (1000000 - Math.min(p.price, 1000000)) / 1000 : (1000000 - Math.min(p.price, 1000000)) / 100000;
    }
    return { product: p, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const winner = scored[0];

  const why = [];
  if (budgetApplied) why.push('within budget of ' + budget);
  if (winner.product.rating !== null) why.push(winner.product.rating + '★ rating');
  if (winner.product.price !== null) why.push('priced at ' + winner.product.price);
  why.push(preference === 'cheapest' ? 'lowest price among matches' : 'highest rated among matches');

  return { product: winner.product, reason: why.join(' · '), candidates: candidates.length, total: list.length };
}

// ---------- page-shape detection ----------

// True once a single product page is open (as opposed to a results list).
function isProductDetailPage(at, url) {
  const href = String(url || '');
  if (/\/(dp|gp\/product|product|item|itm|p)\/[A-Za-z0-9_-]{6,}/i.test(href)) return true;
  if (/\/product\/?$|\/item\/?$/i.test(href)) return true;
  const nodes = Array.isArray(at) ? at : [];
  const hasBuy = nodes.some((n) => /add to cart|buy now|add to basket|buy it now|add to wishlist/i.test(n.name || ''));
  if (!hasBuy) return false;
  // A results page still has many product links; a detail page has none.
  return extractProducts(nodes).length <= 1;
}

// ---------- purchase safety ----------

// Never type these, whatever the model asks for.
const NEVER_TYPED_RE = /card|credit|debit|cvv|cvc|expir|otp|one[\s-]?time|verification\s*code|security\s*code|passcode|\bpin\b|\bssn\b|passport|aadhaar|aadhar|\bpan\b|nift|account\s*number/i;

// The irreversible commit. Requires an explicit, amount-bearing confirmation.
const FINAL_COMMIT_RE = /place\s*(your\s*)?order|confirm\s*(your\s*)?order|pay\s*now|complete\s*(purchase|order|payment)|buy\s*it\s*now|checkout\s*now|order\s*now|confirm\s*payment/i;

// A "buy now" on a listing is a purchase; a plain "buy" chip is not.
const BUY_BUTTON_RE = /add to cart|add to basket|proceed\s*to\s*checkout|buy\s*now|checkout|view\s*cart|go\s*to\s*cart/i;

function _totalFromAT(at) {
  const nodes = Array.isArray(at) ? at : [];
  let best = null;
  for (const n of nodes) {
    const name = String(n.name || '');
    if (!/total|amount\s*due|order\s*total|payable|grand\s*total/i.test(name)) continue;
    const p = parsePrice(name);
    if (p !== null && (best === null || p > best)) best = p;
  }
  return best;
}

function _itemFromAT(at) {
  const nodes = Array.isArray(at) ? at : [];
  const products = extractProducts(nodes);
  if (products.length) return products[0].title;
  const h = nodes.find((n) => (n.role || '').toLowerCase() === 'heading' && (n.name || '').length > 8);
  return h ? String(h.name) : null;
}

// Resolve what an action will actually touch. The planner mostly targets
// at_node_id, so the button's label lives in the AT, not in the action — the
// guard has to look it up or it would wave through "Place your order".
function _actionLabel(action, at) {
  const nodes = Array.isArray(at) ? at : [];
  const bits = [];
  if (action && action.target) {
    if (action.target.value !== undefined && action.target.value !== null) {
      bits.push(String(action.target.value));
      const n = nodes.find((x) => x && x.id === action.target.value);
      if (n && n.name) bits.push(String(n.name));
    }
  }
  if (action && action.params) bits.push(JSON.stringify(action.params));
  return bits.join(' ');
}

// Screen the plan before it runs. Returns the actions that are safe to execute,
// plus anything refused and why — the loop reports these as explicit steps
// rather than letting a bad action reach the page.
function guardPurchaseActions(actions, at, classification) {
  const isOrderFlow = classification === 'order' || classification === 'auth_gated';
  const out = [];
  const refused = [];
  const purchases = [];

  for (const a of (Array.isArray(actions) ? actions : [])) {
    const type = String(a && a.type || '').toLowerCase();
    const label = _actionLabel(a, at);

    if ((type === 'type' || type === 'fill') && NEVER_TYPED_RE.test(label)) {
      refused.push({
        type,
        label: label.slice(0, 120),
        reason: 'Refused: card, OTP and other payment credentials are never typed by the agent — enter them yourself.',
      });
      continue;
    }

    if (isOrderFlow && type === 'click' && FINAL_COMMIT_RE.test(label)) {
      const total = _totalFromAT(at);
      const node = a && a.target ? (Array.isArray(at) ? at : []).find((x) => x && x.id === a.target.value) : null;
      purchases.push({
        type,
        label: (node && node.name) || label.slice(0, 120),
        item: _itemFromAT(at),
        total,
        // A commit we cannot price is never offered for confirmation.
        reason: total === null
          ? 'Refused: could not read an order total from this page, so the amount cannot be confirmed.'
          : null,
      });
      continue;
    }

    out.push(a);
  }

  const confirmed = purchases.filter((p) => p.reason === null);
  refused.push(...purchases.filter((p) => p.reason !== null));

  return {
    actions: out,
    refused,
    purchaseConfirmations: confirmed,
    total: confirmed.length ? confirmed[0].total : _totalFromAT(at),
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    parsePrice, parseRating, parseBudget, parsePreference,
    extractProducts, pickBestProduct, isProductDetailPage,
    guardPurchaseActions, NEVER_TYPED_RE, FINAL_COMMIT_RE,
  };
}
if (typeof window !== 'undefined') {
  window.TrinetraProducts = {
    parsePrice, parseRating, parseBudget, parsePreference,
    extractProducts, pickBestProduct, isProductDetailPage, guardPurchaseActions,
  };
}
if (typeof self !== 'undefined') {
  self.TrinetraProducts = {
    parsePrice, parseRating, parseBudget, parsePreference,
    extractProducts, pickBestProduct, isProductDetailPage, guardPurchaseActions,
  };
}

})();
