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
  } else if (goal.includes('search') || goal.includes('find')) {
    const searchNode = at.find((n: any) => /search/i.test(n.name || '') || n.role === 'searchbox' || n.tag === 'input');
    if (searchNode) {
      actions = [{ id: generateId(), type: 'click', requires_approval: false, target: { mode: 'at_node_id', value: searchNode.id }, params: {} }];
      reasoning = `Located search box "${(searchNode.name || searchNode.id)}" in ${atSummary}. Clicking to focus.`;
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
