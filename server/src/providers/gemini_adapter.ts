// Trinetra — Gemini Adapter (cloud brain)
// Calls Google Gemini via REST. Keeps same LocalModelOutput contract as local_model_adapter.ts
// Env: GEMINI_API_KEY (required), GEMINI_MODEL, GEMINI_FALLBACK_MODELS, GEMINI_TIMEOUT_MS
// Adapter is server-side only — key never leaves server, sanitized payload only.

export interface GeminiInput {
  sanitizedScreenshot?: string | null;
  sanitizedAT?: any[];
  userGoal?: string;
  sessionId?: string;
  historyLength?: number;
  recentActions?: Array<{ reasoning?: string; action?: any }>;
  atDiff?: {
    nodeCountDelta: number;
    newNodesCount: number;
    stateChangesCount: number;
    pageChanged: boolean;
    nodeCount: number;
    urlChanged?: boolean;
  };
  classification?: string;
  iteration?: number;
  noChangeCount?: number;
  executeFailures?: number;
  noTransitionCount?: number;
}

export interface GeminiOutput {
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
  needs_vlm?: boolean;
  vlm_reason?: string;
}

// Action types that must never execute without explicit human approval.
// Mirrors RESTRICTED_ACTIONS in lib/action_executor.js and content_script.js.
const RESTRICTED_ACTIONS = new Set(['type', 'fill', 'submit', 'confirm', 'payment', 'payments', 'sensitive_ops']);

function generateId(): string {
  return `gemini-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function isGeminiConfigured(): boolean {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
  if (!key || key === 'PASTE_YOUR_KEY_HERE') return false;
  if (process.env.CLOUD_PROVIDER === 'local') return false;
  return true;
}

export function getConfig() {
  const apiKey = process.env.GEMINI_API_KEY || '';
  // Allow GOOGLE_API_KEY alias per .env.example history
  const fallbackKey = process.env.GOOGLE_API_KEY || '';
  const key = apiKey || fallbackKey;
  const model = process.env.GEMINI_MODEL || 'gemini-flash-latest';
  const timeoutMs = process.env.GEMINI_TIMEOUT_MS ? Number(process.env.GEMINI_TIMEOUT_MS) : 15000;
  const fallbackModelsRaw = process.env.GEMINI_FALLBACK_MODELS || 'gemini-flash-lite-latest,gemini-3-flash-preview';
  const fallbackModels = fallbackModelsRaw.split(',').map(s => s.trim()).filter(Boolean);
  return { key, model, timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 15000, fallbackModels };
}

// Single source of truth for the model chain — /health reports this, callGeminiModel walks it.
export function getModelChain(): string[] {
  const { model, fallbackModels } = getConfig();
  const chain = [model, ...fallbackModels.filter(m => m !== model)];
  // Dedup
  return [...new Set(chain)];
}

function truncateAT(at: any[], userGoal?: string, max = 80): any[] {
  if (!Array.isArray(at)) return [];
  const goalWords = (userGoal || '').toLowerCase().split(/\W+/).filter(w => w.length > 2);
  const scored = at.map((n: any) => {
    const nameLower = (n.name || '').toLowerCase();
    let score = 0;
    for (const w of goalWords) if (nameLower.includes(w)) score += 10;
    if (/₹|rs\.?|price|\$|\d[\d,]*\s*(₹|rs)/i.test(n.name || '')) score += 5;
    if (/search|query|find/i.test(n.name || '') || /search/i.test(n.id || '') || n.role === 'searchbox') score += 12;
    if (['button','link','textbox','combobox','searchbox'].includes(n.role)) score += 3;
    if (n.tag === 'input' || n.tag === 'a' || n.tag === 'button') score += 2;
    return { n, score };
  });
  scored.sort((a, b) => b.score - a.score);
  // Keep top scored + first 20 in DOM order for context, then dedup
  const top = scored.slice(0, max).map(s => s.n);
  // If still sparse, fill with first nodes
  if (top.length < max && at.length > max) {
    for (let i = 0; i < at.length && top.length < max; i++) if (!top.includes(at[i])) top.push(at[i]);
  }
  return top;
}


// System prompt defining agent behavior and schema
export function buildSystemPrompt(): string {
  return `You are Trinetra — an intelligent autonomous web agent that achieves user goals by reasoning about live screen state from the DOM Accessibility Tree (AT). You are NOT a keyword matcher: you read the full goal, observe the real AT, and plan concrete actions for THIS screen.

THINKING PIPELINE (every turn):
1. UNDERSTAND the full userGoal: intent + all constraints (budget e.g. "under 1 lakh", brand, color, page name, filters). Constraints are part of the goal — do not discard them.
2. OBSERVE the AT: what elements are actually present? Search box? Product results with prices? Header links (Cart, Orders, Account)? Forms?
3. DECIDE one or more actions that make real progress on THIS screen:
   - Search goals: type a query that captures product + meaningful qualifiers (e.g. "laptop under 1 lakh"). On results pages, use constraints to pick which product to open (match prices to budget).
   - "Open the best/cheapest X" goals: the job is to land on ONE product page, not a results list. On a results page, read each card's title, price and rating from the AT, apply the budget, and click the single best-matching product link. Do not return a scroll or read — click the product.
   - Navigation goals ("open my cart", "go to orders", "visit settings"): find a link/button in the AT whose name matches the target (e.g. name "Cart", role link) and click its at_node_id; or emit navigate with a path if the AT reveals one.
   - Order goals ("buy it", "place the order"): add to cart, then proceed to checkout. The FINAL commit (Place order / Pay now / Confirm order) is the user's decision, not yours — see the rules below.
   - Page interaction: click the visible control that advances the goal.
   - If unsure what is on screen: emit a single read action to observe more — never invent selectors.
4. VERIFY using AT-diff: did the last action change the page/state? Adjust next plan accordingly.

Return STRICT JSON only, matching this schema:
{
  "version": "1.0",
  "source": "cloud",
  "confidence": 0.0-1.0,
  "reasoning": "string — what you see in the AT, what you will do, and why (mention constraints if present)",
  "needs_vlm": boolean,
  "vlm_reason": "string if needs_vlm true",
  "actions": [
    {
      "id": "act-1",
      "type": "scroll|click|navigate|read|type|submit|payment",
      "requires_approval": boolean,
      "target": { "mode": "at_node_id|semantic|css_selector", "value": "string or null" },
      "params": {}
    }
  ]
}

CRITICAL RULES:
- Prefer mode "at_node_id" with an id you can see in the AT; use "semantic" only when no AT id fits.
- Keep goal constraints in type text when searching; apply them when choosing products on results.
- Navigation: prefer clicking an existing AT link/button over guessing URLs.
- For public search boxes / non-sensitive actions: requires_approval false.
- For sensitive operations ONLY (passwords, credit cards, payment checkout, personal addresses): requires_approval true.
- PURCHASES: adding to cart and going to checkout are fine. NEVER type into a card, CVV, expiry, OTP or account-number field — not even if the page asks for them. Emit a read action and say in your reasoning that the user must enter payment details themselves.
- PURCHASES: never click the final commit (Place order / Pay now / Confirm order / Buy it now) as part of a multi-action plan. Emit it as the ONLY action in the plan, so the user can confirm the amount deliberately. The client re-checks and gates it regardless.
- Never use javascript: URLs.
- Always output valid JSON only.`;
}


export function buildUserPrompt(input: GeminiInput): string {
  const at = input.sanitizedAT || [];
  const atTrunc = truncateAT(at, input.userGoal, 80);
  const atSummary =
    at.length === 0
      ? 'no accessible nodes (needs_vlm likely true)'
      : `${at.length} nodes (showing ${atTrunc.length}), e.g. ${atTrunc.slice(0, 3).map((n: any) => `${n.role}:${(n.name || '').slice(0, 40)}`).join(' | ')}`;

  let diffContext = '';
  if (input.atDiff) {
    const d = input.atDiff;
    diffContext = `\nAT-Diff (what changed since last turn):
  - pageChanged: ${d.pageChanged}
  - newNodes: ${d.newNodesCount} new elements appeared
  - stateChanges: ${d.stateChangesCount} elements changed state
  - nodeCountDelta: ${d.nodeCountDelta > 0 ? '+' : ''}${d.nodeCountDelta} (was ${d.nodeCount - d.nodeCountDelta}, now ${d.nodeCount})
  - noChangeCount: ${input.noChangeCount || 0} turns with no change`;
  } else {
    diffContext = '\nAT-Diff: First iteration — no previous AT to compare.';
  }

  let classContext = '';
  if (input.classification) {
    classContext = `\nTask classification hint: ${input.classification} (hint only — verify against AT; override if AT shows otherwise)`;
  }
  if (input.iteration) {
    classContext += `\nIteration: ${input.iteration}`;
  }

  let recentContext = '';
  if (Array.isArray(input.recentActions) && input.recentActions.length > 0) {
    recentContext = `\nRecent attempts (do not blindly repeat; adapt): ${JSON.stringify(input.recentActions.slice(-3))}`;
  }

  return `UserGoal: ${input.userGoal || '(none)'}
Session: ${input.sessionId || 'unknown'} historyTurns: ${input.historyLength ?? 0}${classContext}${diffContext}${recentContext}
Sanitized AT summary: ${atSummary}
Full truncated AT JSON:
${JSON.stringify(atTrunc, null, 2)}
Instructions: Think through UNDERSTAND -> OBSERVE -> DECIDE -> VERIFY. Return Action Plan JSON per system prompt. No extra text.`;
}

function tryParseJson(text: string): any | null {
  if (!text) return null;
  const t = text.trim();
  // Direct parse
  try {
    return JSON.parse(t);
  } catch {}

  // Extract from markdown ```json ... ``` code fence
  const codeBlockMatch = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (codeBlockMatch && codeBlockMatch[1]) {
    try {
      return JSON.parse(codeBlockMatch[1].trim());
    } catch {}
  }

  // Extract outermost {...} block
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    const slice = t.slice(start, end + 1);
    try {
      return JSON.parse(slice);
    } catch {}
  }

  // Strip markdown fences
  const fenced = t.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    return JSON.parse(fenced);
  } catch {}
  return null;
}

function normalizeOutput(parsed: any, fallbackAt: any[]): GeminiOutput {
  const version = parsed?.version || '1.0';
  const confidence = typeof parsed?.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0.75;
  const reasoning = typeof parsed?.reasoning === 'string' ? parsed.reasoning : parsed?.explanation || 'Gemini reasoning';
  const needs_vlm = parsed?.needs_vlm === true || parsed?.needs_vlm === 'true';
  const vlm_reason = typeof parsed?.vlm_reason === 'string' ? parsed.vlm_reason : needs_vlm ? 'AT insufficient' : '';
  let actions: GeminiOutput['actions'] = Array.isArray(parsed?.actions) ? parsed.actions : Array.isArray(parsed?.plan) ? parsed.plan : [];
  // Normalize each action — strip javascript: URLs (CSP) to avoid content script block
  actions = actions.slice(0, 10).map((a: any) => {
    let target = a.target ?? null;
    let params = a.params && typeof a.params === 'object' ? a.params : {};
    const url = params.url || (target && target.value);
    if (typeof url === 'string' && url.trim().toLowerCase().startsWith('javascript:')) {
      // Convert to safe read
      return { id: a.id || generateId(), type: 'read', requires_approval: false, target: null, params: {} };
    }
    if (target && typeof target.value === 'string' && target.value.trim().toLowerCase().startsWith('javascript:')) {
      target = null;
      return { id: a.id || generateId(), type: 'read', requires_approval: false, target: null, params: {} };
    }
    const typeStr = String(a.type || 'read').toLowerCase();
    // Approval policy: restricted action types always gate. An explicit
    // requires_approval:true is honoured and never downgraded. The previous
    // heuristic treated any `type` whose text lacked /password|card|cvv|otp/i
    // as a "search action" and stripped its approval flag — that let addresses,
    // phone numbers and usernames through with no prompt.
    const isSensitive = RESTRICTED_ACTIONS.has(typeStr) ||
                        (params && /password|credit|card|cvv|otp|pin|ssn/i.test(JSON.stringify(params)));
    const reqApproval = a.requires_approval === true ? true : isSensitive;

    return {
      id: a.id || generateId(),
      type: typeStr,
      requires_approval: reqApproval,
      target,
      params,
    };
  });
  if (actions.length === 0) {
    actions = [{ id: generateId(), type: 'read', requires_approval: false, target: null, params: {} }];
  }
  // If fallback says empty AT and no flag, force flag
  let finalNeedsVlm = needs_vlm;
  let finalVlmReason = vlm_reason;
  if (!finalNeedsVlm && fallbackAt.length < 3) {
    // Heuristic: very sparse AT often needs VLM; let parsed decide but hint in reasoning
    // Do not override if model said false with high confidence
    if (confidence < 0.6) {
      finalNeedsVlm = true;
      finalVlmReason = finalVlmReason || `AT has only ${fallbackAt.length} nodes — visual layout may be needed (VLM_REQUIRED flag)`;
    }
  }

  return {
    version,
    source: 'cloud',
    confidence,
    actions,
    reasoning: finalNeedsVlm ? `${reasoning} [VLM_REQUIRED: ${finalVlmReason}]` : reasoning,
    explanation: reasoning,
    needs_vlm: finalNeedsVlm,
    vlm_reason: finalVlmReason,
  };
}

export async function callGeminiModel(input: GeminiInput): Promise<GeminiOutput> {
  const { key, timeoutMs } = getConfig();
  if (!key || key === 'PASTE_YOUR_KEY_HERE') {
    throw new Error('GEMINI_API_KEY missing — set server/.env GEMINI_API_KEY');
  }
  if (!input) throw new Error('Missing input');

  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(input);
  const chain = getModelChain();
  console.log(`[Gemini] Chain: ${chain.join(' -> ')}`);

  // Try each model in chain on 429/503/timeout — 3-4 backups
  let lastError: any = null;
  for (let mi = 0; mi < chain.length; mi++) {
    const model = chain[mi];
    const isLast = mi === chain.length - 1;
    // Key travels in a header, not the query string — query strings land in
    // proxy and CDN access logs.
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const authHeaders = { 'Content-Type': 'application/json', 'x-goog-api-key': key };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const body = {
      contents: [
        {
          role: 'user',
          parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }],
        },
      ],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 2048,
      },
    };

    async function doFetch(attemptBody: any): Promise<any> {
      let res: Response;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify(attemptBody),
          signal: controller.signal,
        });
      } catch (e: any) {
        if (e.name === 'AbortError') throw new Error(`Gemini timeout after ${timeoutMs}ms (model ${model})`);
        throw new Error(`Gemini fetch failed (${model}): ${e.message}`);
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        if (res.status === 400) throw new Error(`Gemini 400 bad request (${model}): ${text.slice(0, 600)}`);
        if (res.status === 401 || res.status === 403) throw new Error(`Gemini auth error ${res.status} (${model}): check GEMINI_API_KEY — ${text.slice(0, 400)}`);
        if (res.status === 429) throw new Error(`Gemini rate limited 429 (${model}): ${text.slice(0, 400)}`);
        if (res.status === 503) {
          // Retry once after 1s for temporary demand spike
          await new Promise(r => setTimeout(r, 1000));
          try {
            res = await fetch(url, {
              method: 'POST',
              headers: authHeaders,
              body: JSON.stringify(attemptBody),
              signal: controller.signal,
            });
          } catch (retryErr: any) {
            // A network error on the retry is a real failure — surface it
            // instead of falling through to a misleading "503 unavailable".
            throw new Error(`Gemini 503 retry failed (${model}): ${retryErr.message}`);
          }
          if (!res.ok) {
            const retryText = await res.text().catch(() => '');
            throw new Error(`Gemini 503 unavailable (${model}): ${retryText.slice(0, 400)}`);
          }
        }
        if (!res.ok) throw new Error(`Gemini ${res.status} (${model}): ${text.slice(0, 600)}`);
      }
      return res.json().catch(() => null);
    }

    let json: any = null;
    try {
      json = await doFetch(body);
      clearTimeout(timeout);
    } catch (e: any) {
      clearTimeout(timeout);
      lastError = e;
      const msg = e.message || '';
      // Timeout/abort: fail fast — do NOT retry across model chain (would multiply 8s -> 24s)
      if (msg.includes('timeout') || msg.includes('AbortError')) {
        const skipped = chain.length - mi - 1;
        console.warn(`[Gemini] ${model} timeout — failing fast (no model-chain retry). ${skipped} backup model(s) skipped: ${chain.slice(mi + 1).join(', ') || 'none'}`);
        throw e;
      }
      const isRateOrUnavailable = msg.includes('429') || msg.includes('503');
      if (isRateOrUnavailable && !isLast) {
        console.warn(`[Gemini] ${model} failed (${msg.slice(0,120)}), trying next backup: ${chain[mi+1]}`);
        // small backoff before next model
        await new Promise(r => setTimeout(r, 800));
        continue;
      }
      throw e;
    }

    // Check finishReason — if MAX_TOKENS, model was truncated and JSON may be incomplete
    const finishReason = json?.candidates?.[0]?.finishReason;
    let textOut: string | undefined = json?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!textOut) {
      if (!isLast) {
        console.warn(`[Gemini] ${model} returned no text, trying next backup`);
        await new Promise(r => setTimeout(r, 500));
        continue;
      }
      throw new Error('Gemini returned no text — ' + JSON.stringify(json).slice(0, 800));
    }

    let parsed = tryParseJson(textOut);
    if (!parsed) {
      // Truncated case: try repair by asking model to re-emit valid JSON only (one retry)
      console.warn(`[Gemini] First parse failed (finishReason=${finishReason}), retrying with repair prompt — snippet: ${textOut.slice(0, 300)}`);
      // If truncated due to MAX_TOKENS, last char may not close } — try to extract partial and fallback instead of retrying to same model
      if (finishReason === 'MAX_TOKENS') {
        console.warn('[Gemini] MAX_TOKENS detected, returning safe fallback action instead of retry');
        return normalizeOutput(
          {
            version: '1.0',
            source: 'cloud',
            confidence: 0.3,
            reasoning: 'AT empty/sparse — truncated response, falling back to safe read action while flagging VLM needed.',
            needs_vlm: true,
            vlm_reason: 'Empty or sparse AT caused truncated Gemini output (MAX_TOKENS)',
            actions: [{ id: generateId(), type: 'read', requires_approval: false, target: null, params: {} }],
          },
          input.sanitizedAT || []
        );
      }
      // One repair retry with explicit instruction to return valid JSON only
      const repairBody = {
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: `Your previous output was not valid JSON (snippet: ${textOut.slice(0, 400)}). Re-emit STRICT JSON ONLY per this schema: {"version":"1.0","source":"cloud","confidence":0.3,"reasoning":"AT empty/sparse — needs VLM","needs_vlm":true,"vlm_reason":"reason","actions":[{"id":"a","type":"read","requires_approval":false,"target":null,"params":{}}]} — no markdown.`,
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 1024,
          responseMimeType: 'application/json',
        },
      };
      try {
        const repairController = new AbortController();
        const repairTimeout = setTimeout(() => repairController.abort(), 10000);
        const repairRes = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(repairBody),
          signal: repairController.signal,
        });
        clearTimeout(repairTimeout);
        if (repairRes.ok) {
          const repairJson: any = await repairRes.json().catch(() => null);
          const repairText = repairJson?.candidates?.[0]?.content?.parts?.[0]?.text;
          const repairParsed = tryParseJson(repairText || '');
          if (repairParsed) {
            return normalizeOutput(repairParsed, input.sanitizedAT || []);
          }
        }
      } catch {}
      if (!isLast) {
        console.warn('[Gemini] Repair failed, trying next backup model');
        await new Promise(r => setTimeout(r, 500));
        continue;
      }
      // Final fallback: safe read with VLM flag — never throw 500 for empty AT (phase 12 loop must not stall)
      console.warn('[Gemini] Repair failed, returning safe fallback');
      return normalizeOutput(
        {
          version: '1.0',
          source: 'cloud',
          confidence: 0.3,
          reasoning: `Gemini returned unparsable output (${finishReason || 'parse error'}), fallback to read while flagging VLM. Raw: ${textOut.slice(0, 200)}`,
          needs_vlm: true,
          vlm_reason: `Unparsable Gemini output (finishReason=${finishReason}) — VLM fallback flagged`,
          actions: [{ id: generateId(), type: 'read', requires_approval: false, target: null, params: {} }],
        },
        input.sanitizedAT || []
      );
    }

    return normalizeOutput(parsed, input.sanitizedAT || []);
  } // end for chain

  // All Gemini models failed (429/503/timeout) — throw so cloud_agent.ts can fall back to smart local_model_adapter
  throw new Error(`All Gemini models failed (429/503/timeout). Last error: ${lastError?.message?.slice(0,300)}`);
}
