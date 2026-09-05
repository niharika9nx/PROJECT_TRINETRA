// Trinetra — Express Server Entrypoint (Phase 9 skeleton)
// Accepts sanitized payload from extension and returns hardcoded Action Instructions (Section 4).
// No real model call yet — Phase 10 replaces hardcoded response with LocalModelAdapter.

import express from 'express';
import cors from 'cors';
import { z } from 'zod';
import { sessionManager } from './session_manager.js';
import { orchestrate } from './cloud_agent.js';

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Request schema (Phase 9 DoD: accepts sanitizedScreenshot, sanitizedAT, sessionId)
const AgentActSchema = z.object({
  sanitizedScreenshot: z.string().optional(), // data URL or empty
  sanitizedAT: z.array(z.any()).optional(),
  sanitized_at: z.array(z.any()).optional(), // alias from sanitization engine
  sessionId: z.string().min(1).default('default-session'),
  userGoal: z.string().optional(),
  timestamp: z.string().optional(),
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', version: '0.1.0', phase: 'Phase 9 skeleton — hardcoded response' });
});

app.get('/api/session/:sessionId', (req, res) => {
  const session = sessionManager.getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ success: false, error: 'Session not found' });
  res.json({ success: true, session, turns: session.turns.length });
});

// POST /api/agent/act — core endpoint per Section 9 (Phase 10: via cloud_agent LocalModelAdapter)
app.post('/api/agent/act', async (req, res) => {
  const parsed = AgentActSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: 'Invalid request', details: parsed.error.flatten() });
  }

  const { sanitizedScreenshot, sanitizedAT, sanitized_at, sessionId, userGoal } = parsed.data;
  const at = sanitizedAT || sanitized_at || [];

  const result = await orchestrate({
    sanitizedScreenshot,
    sanitizedAT: Array.isArray(at) ? at : [],
    sessionId,
    userGoal,
  });

  if (!result.success) {
    return res.status(500).json(result);
  }

  // Add legacy single-action alias for Section 4 compat
  const firstAction = (result as any).actions?.[0];
  const legacyAlias = firstAction
    ? { action: firstAction.type, amount: firstAction.params?.amount ?? 500, target: firstAction.target ?? null }
    : { action: 'scroll', amount: 500, target: null };

  res.json({
    ...result,
    ...legacyAlias,
    explanation: (result as any).reasoning || (result as any).explanation,
  });
});

// Catch-all
app.use((req, res) => res.status(404).json({ success: false, error: 'Not found', path: req.path }));

app.listen(PORT, () => {
  console.log(`[Trinetra Server] Phase 9 skeleton listening on http://localhost:${PORT}`);
  console.log(`[Trinetra Server] POST /api/agent/act expects { sanitizedScreenshot, sanitizedAT, sessionId }`);
});

export default app;
