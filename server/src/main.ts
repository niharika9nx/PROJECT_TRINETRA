// Trinetra — Express Server Entrypoint (Phase 9 skeleton)
// Accepts sanitized payload from extension and returns hardcoded Action Instructions (Section 4).
// No real model call yet — Phase 10 replaces hardcoded response with LocalModelAdapter.

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { z } from 'zod';
import { sessionManager } from './session_manager.js';
import { orchestrate } from './cloud_agent.js';

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Request schema (Phase 9 DoD: accepts sanitizedScreenshot, sanitizedAT, sessionId) — CSP: block javascript: URLs
const AgentActSchema = z.object({
  sanitizedScreenshot: z.string().optional().refine((v) => !v || !v.trim().toLowerCase().startsWith('javascript:'), { message: 'javascript: URL blocked by CSP' }),
  sanitizedAT: z.array(z.any()).optional(),
  sanitized_at: z.array(z.any()).optional(), // alias from sanitization engine
  sessionId: z.string().min(1).default('default-session'),
  userGoal: z.string().optional().refine((v) => !v || !v.toLowerCase().includes('javascript:'), { message: 'javascript: in userGoal blocked' }),
  timestamp: z.string().optional(),
});

app.get('/health', (_req, res) => {
  const geminiConfigured = !!((process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) && (process.env.GEMINI_API_KEY !== 'PASTE_YOUR_KEY_HERE'));
  const fallback = (process.env.GEMINI_FALLBACK_MODELS || 'gemini-flash-lite-latest,gemini-3.5-flash-lite,gemini-flash-latest').split(',').map(s=>s.trim()).filter(Boolean);
  const chain = geminiConfigured ? [process.env.GEMINI_MODEL || 'gemini-3.5-flash', ...fallback.filter(m=>m!==(process.env.GEMINI_MODEL || 'gemini-3.5-flash'))] : [];
  res.json({
    status: 'ok',
    version: '0.1.0',
    phase: geminiConfigured ? `Gemini 3.5 Flash active (chain: ${chain.join(' → ')} → local stub)` : 'Phase 10 local stub (set GEMINI_API_KEY to enable Gemini)',
    gemini: {
      configured: geminiConfigured,
      model: process.env.GEMINI_MODEL || 'gemini-3.5-flash',
      fallbackModels: fallback,
      chain,
      provider: geminiConfigured ? 'gemini' : 'local-stub',
    },
  });
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

const server = app.listen(PORT, () => {
  console.log(`[Trinetra Server] Phase 9 skeleton listening on http://localhost:${PORT}`);
  console.log(`[Trinetra Server] POST /api/agent/act expects { sanitizedScreenshot, sanitizedAT, sessionId }`);
});
server.on('error', (err: any) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[Trinetra Server] Port ${PORT} already in use. Kill existing node (taskkill /F /IM node.exe) or set PORT=3002 in server/.env`);
  } else {
    console.error('[Trinetra Server] listen error', err);
  }
  process.exit(1);
});

export default app;
