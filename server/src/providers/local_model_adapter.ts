// Trinetra — Local Model Adapter (cloud-tier fallback)
// Rule-based brain used when no API key is configured or when the Gemini chain
// fails. It labels itself 'local-stub', NOT 'cloud' — cloud_agent.ts relies on
// that distinction to tell the client when it has been silently downgraded.

export interface LocalModelInput {
  sanitizedScreenshot?: string | null;
  sanitizedAT?: any[];
  userGoal?: string;
  sessionId?: string;
  historyLength?: number;
  recentActions?: Array<{ reasoning?: string; action?: any }>;
  atDiff?: any;
  classification?: string;
  iteration?: number;
  noChangeCount?: number;
  executeFailures?: number;
  noTransitionCount?: number;
}

export interface LocalModelOutput {
  version: string;
  source: 'local-stub';
  confidence: number;
  actions: Array<{
    id: string;
    type: string;
    requires_approval: boolean;
    target: any;
    params: Record<string, any>;
  }>;
  reasoning: string;
  explanation?: string;
  degraded?: boolean;
  degraded_reason?: string;
}

// Restricted action types always require human approval.
// Mirrors RESTRICTED_ACTIONS in lib/action_executor.js, content_script.js and gemini_adapter.ts.
const RESTRICTED_ACTIONS = new Set(['type', 'fill', 'submit', 'confirm', 'payment', 'payments', 'sensitive_ops']);

function requiresApproval(type: string): boolean {
  return RESTRICTED_ACTIONS.has((type || '').toLowerCase());
}

// Escape a user-derived string before interpolating it into a RegExp.
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---- product helpers (server-side mirror of lib/products.js) -------------
// The extension bundle cannot be imported here, so the parsing/selection rules
// are duplicated. test_products.js pins the browser side; keep these in step.

const CURRENCY_RE = /₹|\$|\brs\b|\bmrp\b|\bprice\b|\bamount\b|\bcost\b|\btotal\b|\bupees?\b|\binr\b|\blakhs?\b|\blacs?\b|\bcrores?\b/i;
const RATING_CTX_RE = /out of|stars?\b|ratings?\b|rated|reviews?\b|votes?\b/i;
const UNITS: Record<string, number> = { lakh: 1e5, lakhs: 1e5, lac: 1e5, lacs: 1e5, l: 1e5, k: 1e3, thousand: 1e3, crore: 1e7, cr: 1e7, m: 1e6 };

function scaleAmount(n: number, unit?: string): number {
  const u = String(unit || '').toLowerCase().replace(/[^a-z]/g, '');
  return u in UNITS ? n * UNITS[u] : n;
}

function parsePrice(text: unknown): number | null {
  if (text === null || text === undefined) return null;
  const s = String(text);
  if (!/\d/.test(s)) return null;
  const hasCurrency = CURRENCY_RE.test(s);
  if (RATING_CTX_RE.test(s) && !hasCurrency) return null;
  if (!hasCurrency && !/\d{1,3}(?:,\d{3})+/.test(s)) return null;
  const m = s.replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*(lakh|lakhs|lac|lacs|crore|cr|thousand|k|m)?/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!isFinite(n) || n <= 0) return null;
  return scaleAmount(n, m[2]);
}

function parseRating(text: unknown): number | null {
  if (!text) return null;
  const s = String(text);
  if (!/star|rating|rated|\breview/i.test(s)) return null;
  const m = s.match(/(\d+(?:\.\d+)?)/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!isFinite(n) || n <= 0 || n > 5) return null;
  return n;
}

function parseBudget(userGoal: string): number | null {
  const g = String(userGoal || '').toLowerCase();
  const m = g.match(/\b(under|below|less\s+than|within|max(?:imum)?|up\s+to|cheaper\s+than|budget)\s*(?:rs\.?|₹|\$)?\s*(\d+(?:\.\d+)?)\s*(?:(lakh|lakhs|lac|lacs|crore|cr|thousand|k|l|m)\b)?/i);
  if (!m) return null;
  const n = parseFloat(m[2]);
  if (!isFinite(n)) return null;
  return scaleAmount(n, m[3]);
}

const CHROME_RE = /^(cart|orders?|account|sign\s*in|log\s*in|home|deals|coupons?|sell|help|menu|search|suggestions?|see\s+all|shop\s+all|prime|best\s+sellers|new\s+releases|filter|sort|next|previous|prev|1|2|3|4|5)$/i;

function looksLikeTitle(n: any): boolean {
  if (!n) return false;
  const role = String(n.role || '').toLowerCase();
  const tag = String(n.tag || '').toLowerCase();
  if (role !== 'link' && tag !== 'a') return false;
  const name = String(n.name || '').trim();
  if (name.length < 8) return false;
  if (CHROME_RE.test(name)) return false;
  if (/^[\d\s.,₹$%]+$/.test(name)) return false;
  if (/\b(out of 5|stars?)\b/i.test(name)) return false;
  if (/^(add to cart|buy now|add to basket|shop now|see options)$/i.test(name)) return false;
  return /\s|[A-Za-z]{3}/.test(name);
}

interface Product { id: string; title: string; price: number | null; rating: number | null; selector: string | null }

function extractProducts(at: any[]): Product[] {
  if (!Array.isArray(at) || at.length === 0) return [];
  const products: Product[] = [];
  let cur: Product | null = null;
  const flush = () => { if (cur && (cur.price !== null || cur.rating !== null || cur.title)) products.push(cur); cur = null; };
  for (const n of at) {
    if (looksLikeTitle(n)) {
      flush();
      cur = { id: n.id, title: String(n.name || '').trim(), price: null, rating: null, selector: n.selector || null };
      continue;
    }
    if (!cur) continue;
    if (cur.price === null) { const p = parsePrice(n.name); if (p !== null) cur.price = p; }
    if (cur.rating === null) { const r = parseRating(n.name); if (r !== null) cur.rating = r; }
  }
  flush();
  return products;
}

function pickBestProduct(products: Product[], userGoal: string): { product: Product; reason: string } | null {
  const list = (products || []).filter((p) => p && p.id);
  if (list.length === 0) return null;
  const budget = parseBudget(userGoal);
  const preference = /cheapest|lowest\s+price|least\s+expensive/.test(String(userGoal).toLowerCase()) ? 'cheapest' : 'best';
  const goalTerms = String(userGoal || '').toLowerCase().split(/\W+/).filter((w) => w.length > 2 &&
    !/the|and|for|with|under|below|above|over|open|show|find|best|top|good|cheapest|please|can|you|one|me|my/.test(w));

  let candidates = list;
  let budgetApplied = false;
  if (budget !== null) {
    const affordable = list.filter((p) => p.price === null || p.price <= budget);
    if (affordable.length > 0) { candidates = affordable; budgetApplied = true; }
  }

  const scored = candidates.map((p) => {
    const t = p.title.toLowerCase();
    let score = goalTerms.filter((term) => t.includes(term)).length * 1000;
    if (p.rating !== null && preference === 'best') score += p.rating * 100;
    if (p.price !== null) {
      score += preference === 'cheapest'
        ? (1000000 - Math.min(p.price, 1000000)) / 1000
        : (1000000 - Math.min(p.price, 1000000)) / 100000;
    }
    return { p, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const winner = scored[0].p;
  const why: string[] = [];
  if (budgetApplied) why.push(`within budget of ${budget}`);
  if (winner.rating !== null) why.push(`${winner.rating}★ rating`);
  if (winner.price !== null) why.push(`priced at ${winner.price}`);
  why.push(preference === 'cheapest' ? 'lowest price among matches' : 'highest rated among matches');
  return { product: winner, reason: why.join(' · ') };
}

function generateId(): string {
  return `cloud-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

// Deterministic rule engine — no inference. Real quantized weights land in Phase 13.
export async function callLocalModel(input: LocalModelInput): Promise<LocalModelOutput> {
  const at = Array.isArray(input.sanitizedAT) ? input.sanitizedAT.filter((n: any) => n && typeof n === 'object') : [];
  const goal = (input.userGoal || '').toLowerCase();

  // Simulate latency
  await new Promise(r => setTimeout(r, 80));

  // Describe what was seen (for DoD check: asking to describe matches sanitized input)
  const atSummary = at.length === 0
    ? 'no accessible nodes'
    : `${at.length} nodes, e.g. ${at.slice(0, 2).map((n: any) => `${n.role || 'node'}:${String(n.name || '').slice(0, 30)}`).join(', ')}`;

  let actions: LocalModelOutput['actions'] = [];
  let reasoning = '';
  let confidence = 0.88;

  if (at.length === 0) {
    actions = [{ id: generateId(), type: 'read', requires_approval: false, target: null, params: {} }];
    reasoning = `I see ${atSummary}. No actionable nodes found; requesting fresh observation.`;
    confidence = 0.62;
  } else {
    // Extract meaningful search/content words — KEEP constraints (under, lakh, budget…) AND numbers (1 lakh)
    const stop = new Set(['the','and','for','with','above','over','good','best','fetch','get','show','find','search','want','need','give','please','can','you','look','browse','from','into']);
    const contentWords = goal.split(/\W+/).filter((w: string) => (w.length > 1 || /\d/.test(w)) && !stop.has(w));
    const searchText = contentWords.join(' ') || goal;

    // Generic offline rule: goal names a noun and AT has interactive node matching it -> click it
    const interactive = (n: any) => ['link','button','textbox','searchbox','combobox'].includes(n.role) || n.tag === 'a' || n.tag === 'button' || n.tag === 'input';
    let nounNode: any = null;
    for (const w of contentWords) {
      if (w.length < 3) continue;
      // Escape the user-derived word so regex metacharacters cannot break the match
      const hit = at.find((n: any) => interactive(n) && new RegExp(`\\b${escapeRegExp(w)}\\b`, 'i').test(n.name || ''));
      if (hit) { nounNode = hit; break; }
    }

    const searchNode = at.find((n: any) =>
      /search/i.test(n.name || '') || n.role === 'searchbox' || n.role === 'combobox'
    );
    const searchIntent = /search|find|fetch|get|show|want|need|recommend|suggest|buy|purchase|order|under|below|browse|look|open|best|cheapest|top|select|pick|choose/i.test(goal);

    // Select-one-product: when the page already lists products, choose ONE and
    // click it rather than returning the results list again.
    const wantsSelection = /open|show|select|pick|choose|best|cheapest|top/.test(goal);
    if (wantsSelection) {
      const found = extractProducts(at);
      if (found.length > 0) {
        const sel = pickBestProduct(found, input.userGoal || '');
        if (sel) {
          actions = [{ id: generateId(), type: 'click', requires_approval: false, target: { mode: 'at_node_id', value: sel.product.id }, params: {} }];
          reasoning = `Found ${found.length} products. Opening "${sel.product.title.slice(0, 60)}" — ${sel.reason}.`;
          confidence = 0.9;
        }
      }
    }

    if (actions.length === 0 && nounNode && !searchIntent) {
      // Navigation-style goal (open cart, go to orders…) — click matching node
      actions = [{ id: generateId(), type: 'click', requires_approval: false, target: { mode: 'at_node_id', value: nounNode.id }, params: {} }];
      reasoning = `Observed interactive node matching goal noun: "${(nounNode.name || '').slice(0, 60)}". Clicking it.`;
      confidence = 0.9;
    } else if (searchIntent && searchNode) {
      // Search with FULL phrase (constraints preserved)
      const matchingProducts = at.filter((n: any) =>
        contentWords.some((pw: string) => pw.length > 3 && (n.name || '').toLowerCase().includes(pw)) &&
        (['link', 'button'].includes(n.role) || n.tag === 'a')
      );
      if (matchingProducts.length > 0 && at.length > 5) {
        const targetProduct = matchingProducts[0];
        actions = [
          { id: generateId(), type: 'scroll', requires_approval: false, target: { mode: 'at_node_id', value: targetProduct.id }, params: { amount: 200 } },
          { id: generateId(), type: 'click', requires_approval: false, target: { mode: 'at_node_id', value: targetProduct.id }, params: {} },
        ];
        reasoning = `Observed search results with ${matchingProducts.length} matching items. Clicking top match "${String(targetProduct.name || targetProduct.id).slice(0, 50)}".`;
        confidence = 0.92;
      } else {
        actions = [
          { id: generateId(), type: 'click', requires_approval: false, target: { mode: 'at_node_id', value: searchNode.id }, params: {} },
          { id: generateId(), type: 'type', requires_approval: requiresApproval('type'), target: { mode: 'at_node_id', value: searchNode.id }, params: { text: searchText } },
          { id: generateId(), type: 'submit', requires_approval: requiresApproval('submit'), target: { mode: 'at_node_id', value: searchNode.id }, params: {} },
        ];
        reasoning = `Located search box. Typing full phrase "${searchText}" (constraints preserved) and submitting.`;
      }
    } else if (nounNode) {
      actions = [{ id: generateId(), type: 'click', requires_approval: false, target: { mode: 'at_node_id', value: nounNode.id }, params: {} }];
      reasoning = `Found goal-related node "${(nounNode.name || '').slice(0, 60)}" in ${atSummary}. Clicking it.`;
      confidence = 0.88;
    } else {
      // Generic observe
      actions = [{ id: generateId(), type: 'read', requires_approval: false, target: null, params: {} }];
      reasoning = `Analyzed sanitized view: ${atSummary}. No clear target matched the goal nouns; returning observation.`;
      confidence = 0.75;
    }
  }

  return {
    version: '1.0',
    source: 'local-stub',
    confidence,
    actions,
    reasoning,
    explanation: reasoning,
  };
}
