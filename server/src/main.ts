// Trinetra — Express Server Entrypoint
// Accepts a sanitized payload from the extension and returns an Action Plan.
// Provider routing lives in cloud_agent.ts (Gemini -> local rule-based stub fallback).

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { z } from 'zod';
import { sessionManager } from './session_manager.js';
import { orchestrate, type CloudAgentResult } from './cloud_agent.js';
import { getModelChain, isGeminiConfigured } from './providers/gemini_adapter.js';

const app = express();
const parsedPort = process.env.PORT ? Number(process.env.PORT) : 3001;
const PORT = Number.isFinite(parsedPort) ? parsedPort : 3001;
const HOST = process.env.HOST || '127.0.0.1';

// Optional shared secret. When set, /api/* requires the matching header.
// When unset, security relies on the CORS allow-list + loopback bind alone.
const SERVER_TOKEN = process.env.TRINETRA_SERVER_TOKEN || '';

// Origin allow-list. A page the user visits cannot read responses from an
// origin it is not allowed to name, and the JSON content-type forces a
// preflight that this list blocks — so arbitrary sites cannot spend API quota.
function isAllowedOrigin(origin: string | undefined): boolean {
  // Non-browser callers (curl, health checks) send no Origin header.
  if (!origin) return true;
  if (/^chrome-extension:\/\/[a-z]{32}$/i.test(origin)) return true;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) return true;
  return false;
}

app.use(cors({
  origin: (origin, callback) => callback(null, isAllowedOrigin(origin)),
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'X-Trinetra-Token'],
}));

function requireToken(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (!SERVER_TOKEN) return next();
  if (req.get('X-Trinetra-Token') === SERVER_TOKEN) return next();
  res.status(401).json({ success: false, error: 'Unauthorized — missing or invalid X-Trinetra-Token' });
}

app.use('/api', requireToken);
app.use(express.json({ limit: '10mb' }));

// Request log — diagnose extension connectivity
app.use((req, res, next) => {
  if (req.method === 'POST') {
    console.log(`[Server] POST ${req.path} content-length=${req.headers['content-length'] || '?'} origin=${req.headers.origin || '-'}`);
  }
  next();
});

// Request schema — accepts the sanitized payload from the extension.
// CSP: block javascript: URLs. Note sanitizedScreenshot is nullable: the
// extension passes getScreenshot: null when no capture is available, which
// previously caused a 400 on every cloud escalation.
const SanitizationReportSchema = z.object({
  redacted_regions: z.array(z.object({
    bbox: z.array(z.number()).length(4),
    type: z.string(),
    strategy: z.string(),
    confidence: z.number(),
  })).default([]),
  sanitized_at_summary: z.string().default(''),
  removedCount: z.number().optional(),
  maskedCount: z.number().optional(),
  timestamp: z.string().optional(),
}).passthrough();

const AgentActSchema = z.object({
  sanitizedScreenshot: z.string().nullable().optional().refine((v) => !v || !v.trim().toLowerCase().startsWith('javascript:'), { message: 'javascript: URL blocked by CSP' }),
  sanitizedAT: z.array(z.any()).optional(),
  sanitized_at: z.array(z.any()).optional(), // alias from sanitization engine
  sanitizationReport: SanitizationReportSchema.optional(),
  sessionId: z.string().min(1).default('default-session'),
  userGoal: z.string().optional().refine((v) => !v || !v.toLowerCase().includes('javascript:'), { message: 'javascript: in userGoal blocked' }),
  timestamp: z.string().optional(),
  atDiff: z.object({
    nodeCountDelta: z.number(),
    newNodesCount: z.number(),
    stateChangesCount: z.number(),
    pageChanged: z.boolean(),
    nodeCount: z.number(),
    urlChanged: z.boolean().optional(),
  }).optional(),
  classification: z.string().optional(),
  iteration: z.number().optional(),
  noChangeCount: z.number().optional(),
  // Loop health signals — the model needs these to escape a failing cycle.
  executeFailures: z.number().optional(),
  noTransitionCount: z.number().optional(),
});

app.get('/health', (_req, res) => {
  // Single source of truth: the adapter owns the chain, /health only reports it.
  const geminiConfigured = isGeminiConfigured();
  const chain = getModelChain();
  res.json({
    status: 'ok',
    version: '0.1.0',
    phase: geminiConfigured ? `Gemini active (chain: ${chain.join(' -> ')} -> local stub)` : 'Local stub only (set GEMINI_API_KEY to enable Gemini)',
    gemini: {
      configured: geminiConfigured,
      model: chain[0] || null,
      chain,
      provider: geminiConfigured ? 'gemini' : 'local-stub',
    },
    auth: SERVER_TOKEN ? 'token' : 'open (CORS + loopback only)',
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
    console.log(`[Server] /api/agent/act invalid request:`, parsed.error.flatten());
    return res.status(400).json({ success: false, error: 'Invalid request', details: parsed.error.flatten() });
  }

  const { sanitizedScreenshot, sanitizedAT, sanitized_at, sanitizationReport, sessionId, userGoal, atDiff, classification, iteration, noChangeCount, executeFailures, noTransitionCount } = parsed.data;
  const at = sanitizedAT || sanitized_at || [];

  console.log(`[Server] /api/agent/act session=${sessionId} goal="${(userGoal || '').slice(0, 60)}" iter=${iteration ?? '-'} at=${Array.isArray(at) ? at.length : 0}`);

  const result: CloudAgentResult = await orchestrate({
    sanitizedScreenshot,
    sanitizedAT: Array.isArray(at) ? at : [],
    sessionId,
    userGoal,
    atDiff,
    classification,
    iteration,
    noChangeCount,
    executeFailures,
    noTransitionCount,
    sanitizationReport,
  });

  if (!result.success) {
    console.log(`[Server] orchestrate failed:`, result.reason || result.error);
    return res.status(500).json(result);
  }

  console.log(`[Server] -> ${result.source || 'cloud'} actions=${result.actions?.length ?? 0} reasoning=${String(result.reasoning || '').slice(0, 80)}`);

  // Legacy single-action alias for Section 4 compatibility
  const firstAction = result.actions?.[0];
  const legacyAlias = firstAction
    ? { action: firstAction.type, amount: firstAction.params?.amount ?? 500, target: firstAction.target ?? null }
    : { action: 'scroll', amount: 500, target: null };

  res.json({
    ...result,
    ...legacyAlias,
    explanation: result.reasoning || result.explanation,
  });
});

// Catch-all
app.use((req, res) => res.status(404).json({ success: false, error: 'Not found', path: req.path }));

const server = app.listen(PORT, HOST, () => {
  console.log(`[Trinetra Server] listening on http://${HOST}:${PORT}`);
  console.log(`[Trinetra Server] POST /api/agent/act expects { sanitizedScreenshot, sanitizedAT, sessionId }`);
  console.log(`[Trinetra Server] auth: ${SERVER_TOKEN ? 'token required (X-Trinetra-Token)' : 'open — CORS allow-list + loopback bind only'}`);
  console.log(`[Trinetra Server] model chain: ${getModelChain().join(' -> ') || '(none)'}`);
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
