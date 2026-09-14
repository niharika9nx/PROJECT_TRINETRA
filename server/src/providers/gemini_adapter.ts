// Trinetra — Gemini Adapter (Phase 10, API-key cloud)
// Calls Google Gemini 1.5 Flash via REST. Keeps same LocalModelOutput contract as local_model_adapter.ts
// Env: GEMINI_API_KEY (required), GEMINI_MODEL (default gemini-1.5-flash), GEMINI_TIMEOUT_MS (default 20000)
// Adapter is server-side only — key never leaves server, sanitized payload only.

export interface GeminiInput {
  sanitizedScreenshot?: string;
  sanitizedAT?: any[];
  userGoal?: string;
  sessionId?: string;
  historyLength?: number;
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

function generateId(): string {
  return `gemini-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function getConfig() {
  const apiKey = process.env.GEMINI_API_KEY || '';
  // Allow GOOGLE_API_KEY alias per .env.example history
  const fallbackKey = process.env.GOOGLE_API_KEY || '';
  const key = apiKey || fallbackKey;
  const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
  const timeoutMs = process.env.GEMINI_TIMEOUT_MS ? Number(process.env.GEMINI_TIMEOUT_MS) : 20000;
  const fallbackModelsRaw = process.env.GEMINI_FALLBACK_MODELS || 'gemini-flash-lite-latest,gemini-3.5-flash-lite,gemini-flash-latest';
  const fallbackModels = fallbackModelsRaw.split(',').map(s => s.trim()).filter(Boolean);
  return { key, model, timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 20000, fallbackModels };
}

function getModelChain(): string[] {
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
  return top.slice(0, max).map((n: any) => ({
    id: n.id,
    role: n.role,
    name: (n.name || '').slice(0, 120),
    tag: n.tag,
    bounds: n.bounds,
    state: n.state,
    selector: n.selector,
  }));
}

function buildSystemPrompt(): string {
  return `You are Trinetra Cloud Brain for a privacy-preserving web agent (any query, not just price).
DOM is primary; screenshot is absent unless VLM flagged.

Return STRICT JSON only, no markdown, matching this schema:
{
  "version": "1.0",
  "source": "cloud",
  "confidence": 0.0-1.0,
  "reasoning": "string — explain what you see and why you chose actions; mention needs_vlm if AT insufficient",
  "needs_vlm": boolean,
  "vlm_reason": "string if needs_vlm true",
  "actions": [
    {"id":"string","type":"scroll|click|navigate|read|type|submit|payment","requires_approval":false,"target":{"mode":"at_node_id|bbox|css_selector","value":"string or null"},"params":{}}
  ]
}
Rules (generic for ANY userGoal):
- Allowed auto: scroll, click, navigate, read. Restricted (requires_approval true): type/fill, submit/confirm, payment/sensitive_ops.
- Prefer at_node_id with IDs from provided AT; fallback to css_selector if needed. bbox as [x,y,w,h] numbers if used.
- For any query: search → click searchbox + type text; price/filter → click filter or cheapest matching price; navigation → navigate; generic → scroll/read. Choose one best action per turn.
- For "cheapest laptop under ₹60k" etc: if price nodes visible, among all price nodes under limit click cheapest (parse numbers ignoring commas/₹/Rs); else scroll to reveal more.
- Flipkart/Amazon both use ₹/Rs/$ price; handle both. Use name match for query keywords across any e-commerce.
- If AT empty or sparse (<3 nodes) or task needs visual layout you cannot infer from AT, set needs_vlm:true and explain vlm_reason, but still return a best-effort action (usually read or scroll).
- confidence 0.0-1.0 reflecting certainty. Keep reasoning concise (1-3 sentences) but specific to nodes you saw.
- SECURITY: never use javascript: URLs — only https:// for navigate.target.value or params.url. If you would use javascript:, return read instead.
- Return valid JSON only.`;
}

function buildUserPrompt(input: GeminiInput): string {
  const at = input.sanitizedAT || [];
  const atTrunc = truncateAT(at, input.userGoal, 80);
  const atSummary =
    at.length === 0
      ? 'no accessible nodes (needs_vlm likely true)'
      : `${at.length} nodes (showing ${atTrunc.length}), e.g. ${atTrunc.slice(0, 3).map((n: any) => `${n.role}:${(n.name || '').slice(0, 40)}`).join(' | ')}`;
  return `UserGoal: ${input.userGoal || '(none)'}
Session: ${input.sessionId || 'unknown'} historyTurns: ${input.historyLength ?? 0}
Sanitized AT summary: ${atSummary}
Full truncated AT JSON:
${JSON.stringify(atTrunc, null, 2)}
Instructions: Return Action Plan JSON per system prompt. No extra text.`;
}

function tryParseJson(text: string): any | null {
  if (!text) return null;
  const t = text.trim();
  // Direct parse
  try {
    return JSON.parse(t);
  } catch {}
  // Extract first {...} block
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
    return {
      id: a.id || generateId(),
      type: String(a.type || 'read').toLowerCase(),
      requires_approval: a.requires_approval === true || ['type', 'fill', 'submit', 'confirm', 'payment', 'payments', 'sensitive_ops'].includes(String(a.type || '').toLowerCase()),
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
  console.log(`[Gemini] Chain: ${chain.join(' → ')}`);

  // Try each model in chain on 429/503/timeout — 3-4 backups
  let lastError: any = null;
  for (let mi = 0; mi < chain.length; mi++) {
    const model = chain[mi];
    const isLast = mi === chain.length - 1;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
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
        responseMimeType: 'application/json',
      },
    };

    async function doFetch(attemptBody: any): Promise<any> {
      let res: Response;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
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
        if (res.status === 503) throw new Error(`Gemini 503 unavailable (${model}): ${text.slice(0, 400)}`);
        throw new Error(`Gemini ${res.status} (${model}): ${text.slice(0, 600)}`);
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
      const isRateOrUnavailable = msg.includes('429') || msg.includes('503') || msg.includes('timeout');
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

  // All Gemini models failed (429/503/timeout) — final fallback to local stub logic (never 500 for demo)
  console.warn(`[Gemini] All models in chain failed, lastError: ${lastError?.message?.slice(0,200)}, falling back to local stub`);
  const at = input.sanitizedAT || [];
  const priceNode = at.find((n: any) => /₹|rs\.?|price|\d{3,}/i.test(n.name || ''));
  if (priceNode) {
    return normalizeOutput(
      {
        version: '1.0',
        source: 'cloud',
        confidence: 0.65,
        reasoning: `Fallback stub (all Gemini 429): found price node "${(priceNode.name || '').slice(0,50)}" — clicking cheapest candidate. Original error: ${lastError?.message?.slice(0,100)}`,
        needs_vlm: at.length < 3,
        vlm_reason: at.length < 3 ? 'AT sparse — VLM flagged in fallback' : '',
        actions: [{ id: generateId(), type: 'click', requires_approval: false, target: { mode: 'at_node_id', value: priceNode.id }, params: {} }],
      },
      at
    );
  }
  return normalizeOutput(
    {
      version: '1.0',
      source: 'cloud',
      confidence: 0.6,
      reasoning: `Fallback stub (all Gemini 429): no price node visible, scrolling. Original error: ${lastError?.message?.slice(0,100)}`,
      needs_vlm: at.length < 3,
      vlm_reason: at.length < 3 ? 'AT sparse' : '',
      actions: [{ id: generateId(), type: 'scroll', requires_approval: false, target: null, params: { amount: 600 } }],
    },
    at
  );
}

// Compat alias so cloud_agent can import either name
export const callLocalModel = callGeminiModel;
