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
    return callGeminiModel(input);
  }
  return callLocalStub(input);
}

export interface CloudAgentInput {
  sanitizedScreenshot?: string;
  sanitizedAT?: any[];
  sessionId: string;
  userGoal?: string;
}

export async function orchestrate(input: CloudAgentInput) {
  const { sanitizedScreenshot, sanitizedAT, sessionId, userGoal } = input;

  // Retrieve history for context
  const history = sessionManager.getHistory(sessionId);

  try {
    const result = await callLocalModel({
      sanitizedScreenshot,
      sanitizedAT: sanitizedAT || [],
      userGoal,
      sessionId,
      historyLength: history.length,
    });

    // Persist successful turn
    sessionManager.addTurn(sessionId, {
      timestamp: new Date().toISOString(),
      sanitizedAT: (sanitizedAT || []).slice(0, 20),
      sanitizedScreenshot: sanitizedScreenshot ? sanitizedScreenshot.slice(0, 80) + '...' : undefined,
      reasoning: (result as any).reasoning || (result as any).explanation,
      action: (result as any).actions?.[0],
    });

    return { success: true, ...(result as any), sessionId, historyLength: history.length + 1 };
  } catch (e: any) {
    // Clear error envelope — never crash (Phase 10 DoD)
    return {
      success: false,
      error: 'CloudAgentError',
      reason: e.message || 'Unknown cloud agent error',
      sessionId,
    };
  }
}
