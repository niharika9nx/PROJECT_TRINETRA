// Trinetra — Cloud Agent Orchestration (Phase 10)
// Wraps LocalModelAdapter (local models as cloud) with session context and error handling.
// Provider-agnostic: swapping LocalModelAdapter for OpenAI/Anthropic adapter later requires only changing the import.

import { sessionManager } from './session_manager.js';
import { callLocalModel as callLocalStub } from './providers/local_model_adapter.js';
import { callGeminiModel } from './providers/gemini_adapter.js';

function useGemini(): boolean {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
  if (!key || key === 'PASTE_YOUR_KEY_HERE') return false;
  // Allow explicit opt-out via CLOUD_PROVIDER=local
  if (process.env.CLOUD_PROVIDER === 'local') return false;
  return true;
}

async function callLocalModel(input: any): Promise<any> {
  if (useGemini()) {
    try {
      return await callGeminiModel(input);
    } catch (err: any) {
      // Surface the downgrade instead of silently returning stub output as success.
      // The full provider error stays in the log; only a compact, single-line
      // summary is sent to the browser so upstream internals are not exposed.
      console.warn(`[CloudAgent] Gemini chain failed (${err.message}). Falling back to local model adapter.`);
      const stub = await callLocalStub(input);
      return {
        ...stub,
        source: 'local-stub',
        degraded: true,
        degraded_reason: (err.message || 'unknown error').split('\n')[0].slice(0, 200),
      };
    }
  }
  return callLocalStub(input);
}

export interface CloudAgentInput {
  sanitizedScreenshot?: string | null;
  sanitizedAT?: any[];
  sessionId: string;
  userGoal?: string;
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
  sanitizationReport?: Record<string, any>;
}

export type CloudAgentResult =
  | {
      success: true;
      version: string;
      source: string;
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
      degraded?: boolean;
      degraded_reason?: string;
      sessionId: string;
      historyLength: number;
    }
  | {
      success: false;
      error: string;
      reason?: string;
      sessionId: string;
    };

export async function orchestrate(input: CloudAgentInput): Promise<CloudAgentResult> {
  const {
    sanitizedScreenshot, sanitizedAT, sessionId, userGoal, atDiff, classification,
    iteration, noChangeCount, executeFailures, noTransitionCount, sanitizationReport,
  } = input;

  // Retrieve history for context
  const history = sessionManager.getHistory(sessionId);
  const recentActions = history.slice(-3).map(h => ({
    reasoning: (h.reasoning || '').slice(0, 120),
    action: h.action,
  }));

  if (sanitizationReport) {
    console.log(
      `[Server] sanitization report: ${(sanitizationReport.redacted_regions || []).length} region(s), ` +
      `${sanitizationReport.sanitized_at_summary || 'no summary'}`
    );
  } else {
    console.warn('[Server] WARNING: request arrived with no sanitizationReport — payload was not verified as sanitized');
  }

  try {
    const result = await callLocalModel({
      sanitizedScreenshot,
      sanitizedAT: sanitizedAT || [],
      userGoal,
      sessionId,
      historyLength: history.length,
      recentActions,
      atDiff,
      classification,
      iteration,
      noChangeCount,
      executeFailures,
      noTransitionCount,
    });

    // Persist successful turn
    sessionManager.addTurn(sessionId, {
      timestamp: new Date().toISOString(),
      sanitizedAT: (sanitizedAT || []).slice(0, 20),
      sanitizedScreenshot: sanitizedScreenshot ? sanitizedScreenshot.slice(0, 80) + '...' : undefined,
      reasoning: result.reasoning || result.explanation,
      action: result.actions?.[0],
    });

    return {
      success: true,
      version: result.version || '1.0',
      source: result.source || 'cloud',
      confidence: typeof result.confidence === 'number' ? result.confidence : 0.7,
      actions: Array.isArray(result.actions) ? result.actions : [],
      reasoning: result.reasoning || '',
      explanation: result.explanation,
      needs_vlm: result.needs_vlm,
      vlm_reason: result.vlm_reason,
      degraded: result.degraded,
      degraded_reason: result.degraded_reason,
      sessionId,
      historyLength: history.length + 1,
    };
  } catch (e: any) {
    // Clear error envelope — never crash (Phase 10 DoD).
    // Full detail goes to the server log; the client gets a compact reason so
    // provider internals are not echoed into the browser.
    console.error(`[CloudAgent] orchestrate failed for session ${sessionId}:`, e);
    return {
      success: false,
      error: 'CloudAgentError',
      reason: (e.message || 'Unknown cloud agent error').split('\n')[0].slice(0, 200),
      sessionId,
    };
  }
}
