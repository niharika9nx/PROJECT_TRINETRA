// Trinetra — Local Model Adapter (Phase 10)
// Implements the "cloud" tier using local models (not commercial frontier APIs per decision).
// Adapter pattern keeps provider-agnostic interface — swapping to OpenAI/Anthropic later is one-file change.

export interface LocalModelInput {
  sanitizedScreenshot?: string;
  sanitizedAT?: any[];
  userGoal?: string;
  sessionId?: string;
  historyLength?: number;
}

export interface LocalModelOutput {
  version: string;
  source: 'cloud';
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
}

function generateId(): string {
  return `cloud-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

// Deterministic stub logic mirroring lib/providers/stub_provider but server-side
// This is the "local model" brain — rule-based until real quantized weights are wired (Phase 13)
export async function callLocalModel(input: LocalModelInput): Promise<LocalModelOutput> {
  const at = input.sanitizedAT || [];
  const goal = (input.userGoal || '').toLowerCase();

  // Simulate latency
  await new Promise(r => setTimeout(r, 80));

  // Describe what was seen (for DoD check: asking to describe matches sanitized input)
  const atSummary = at.length === 0
    ? 'no accessible nodes'
    : `${at.length} nodes, e.g. ${at.slice(0, 2).map((n: any) => n.role + ':' + (n.name || '').slice(0, 30)).join(', ')}`;

  let actions: LocalModelOutput['actions'] = [];
  let reasoning = '';
  let confidence = 0.88;

  if (at.length === 0) {
    actions = [{ id: generateId(), type: 'read', requires_approval: false, target: null, params: {} }];
    reasoning = `I see ${atSummary}. No actionable nodes found; requesting fresh observation.`;
    confidence = 0.62;
  } else if (goal.includes('laptop') || goal.includes('price') || goal.includes('cheapest')) {
    // Price-aware action: click cheapest-like node or scroll
    const priceNode = at.find((n: any) => /₹|price|\d{3,}/i.test(n.name || ''));
    if (priceNode) {
      actions = [{ id: generateId(), type: 'click', requires_approval: false, target: { mode: 'at_node_id', value: priceNode.id }, params: {} }];
      reasoning = `Found price-related node "${(priceNode.name || '').slice(0, 50)}" among ${atSummary}. Clicking cheapest candidate.`;
      confidence = 0.91;
    } else {
      actions = [{ id: generateId(), type: 'scroll', requires_approval: false, target: null, params: { amount: 500 } }];
      reasoning = `Saw ${atSummary} but no price node visible. Scrolling to reveal more products.`;
      confidence = 0.84;
    }
  } else if (/search|find|fetch|get|show|want|need|recommend|suggest|buy|purchase|order|keychain|under|below|browse|look/i.test(goal)) {
    // Shopping/search intent — find search box and type the query
    const searchNode = at.find((n: any) =>
      /search/i.test(n.name || '') || n.role === 'searchbox' || n.role === 'combobox' || n.tag === 'input'
    );

    // Extract meaningful search term from goal (exclude numbers/prices/stopwords)
    const productWords = goal.split(/\W+/).filter((w: string) =>
      w.length > 2 &&
      !/^\d+$/.test(w) &&
      !['the','and','for','with','under','below','above','over','good','best','fetch','get','show','find','search','want','need','give','please','can','you','look','browse','from','into','rs','inr','rupees','bucks'].includes(w)
    );
    const searchText = productWords.join(' ') || goal;

    // If matching product links are already visible on screen (results page), click top product
    const matchingProducts = at.filter((n: any) =>
      productWords.some((pw: string) => (n.name || '').toLowerCase().includes(pw)) &&
      (['link', 'button'].includes(n.role) || n.tag === 'a' || /keychain|item|product/i.test(n.name || ''))
    );

    if (matchingProducts.length > 0 && at.length > 5) {
      const targetProduct = matchingProducts[0];
      actions = [
        { id: generateId(), type: 'scroll', requires_approval: false, target: { mode: 'at_node_id', value: targetProduct.id }, params: { amount: 200 } },
        { id: generateId(), type: 'click', requires_approval: false, target: { mode: 'at_node_id', value: targetProduct.id }, params: {} },
      ];
      reasoning = `Observed search results on page with ${matchingProducts.length} matching items. Clicking top match "${(targetProduct.name || targetProduct.id).slice(0, 50)}".`;
      confidence = 0.92;
    } else if (searchNode) {
      actions = [
        { id: generateId(), type: 'click', requires_approval: false, target: { mode: 'at_node_id', value: searchNode.id }, params: {} },
        { id: generateId(), type: 'type', requires_approval: false, target: { mode: 'at_node_id', value: searchNode.id }, params: { text: searchText } },
        { id: generateId(), type: 'submit', requires_approval: false, target: { mode: 'at_node_id', value: searchNode.id }, params: {} },
      ];
      reasoning = `Located search box "${(searchNode.name || searchNode.id)}" in ${atSummary}. Typing "${searchText}" and submitting to search.`;
    } else {
      actions = [{ id: generateId(), type: 'scroll', requires_approval: false, target: null, params: { amount: 400 } }];
      reasoning = `No search box in ${atSummary}. Scrolling to locate it.`;
    }
  } else {
    // Generic fallback — read
    actions = [{ id: generateId(), type: 'read', requires_approval: false, target: null, params: {} }];
    reasoning = `Analyzed sanitized view: ${atSummary}. No specific goal pattern matched; returning observation.`;
    confidence = 0.75;
  }

  return {
    version: '1.0',
    source: 'cloud',
    confidence,
    actions,
    reasoning,
    explanation: reasoning,
  };
}

// Error simulation helper for testing DoD error handling
export async function callLocalModelWithErrorHandling(input: LocalModelInput): Promise<LocalModelOutput | { error: string; reason: string }> {
  try {
    if (!input) throw new Error('Missing input');
    // Simulate bad input error
    if (input.sanitizedAT && !Array.isArray(input.sanitizedAT)) throw new Error('sanitizedAT must be an array');
    return await callLocalModel(input);
  } catch (e: any) {
    return { error: 'LocalModelError', reason: e.message || 'Unknown error' };
  }
}
