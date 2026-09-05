# Project Trinetra — Build Plan (SIH 2026)

> **Created:** 2026-09-05
> **Status:** Approved — Build in Progress
> **Decisions locked:** Server = Express (Node.js + TypeScript) | Cloud Provider = Local Models (no commercial API for now) | Browser = Chrome (Manifest V3)
> **Architecture source:** SYSTEM PROMPT Build AI Web Agent Browser Extension (Sections 1–11) — including corrections vs original Kimi prompt
> **Execution constraint:** OpenCode with free/open-weight models — execute Section 10 strictly phase-by-phase, one phase at a time, verify Definition-of-Done before next phase. No phase touches files outside its scope.

---

## 1. Project Overview

**Privacy-preserving AI web agent as a Chrome Manifest V3 extension + Express backend.** Local-first: DOM Accessibility Tree (AT) + screenshot captured in parallel; local LLM/VLM reasoning via pluggable `LocalLLMProvider`/`LocalVLMProvider` interfaces; local action execution with Human-in-the-Loop approval gate; 3-stage local sanitization before any network leaves device; server orchestrates session + local-model "cloud" reasoning (adapter pattern leaves door open to swap in OpenAI/Anthropic/Google/Perplexity later). Full 8-step workflow loop until goal achieved.

**Corrections applied vs. original diagram prompt:**
1. Diagram's "Cloud Models" = OpenAI/Anthropic/Google/Perplexity logos → architecture intended commercial frontier API calls. This build **defers** that and uses **local models as the cloud tier** per current decision (adapter still provider-agnostic, commercial swap is one-file change).
2. Confidence threshold 0.7 is **not in diagram** — treated as configurable default (Section 2.2).
3. Scaffolding strategy: **stub-first, real model last** — `StubLLMProvider`/`StubVLMProvider` back every component through Phases 1–12. Real runtime (`onnxruntime-web` vs `@xenova/transformers` vs WebGPU) + quantized weights dropped in Phase 13 behind same interface with no refactors.

## 2. Key Principles (Hardcoded Rules — Section 6)

- **Privacy First:** No unsanitized data leaves device; sanitization runs locally before any `fetch`.
- **Local-First:** AT + local LLM preferred; escalation is exception.
- **Human-in-the-Loop:** `type/fill/submit/payment` require explicit modal approval.
- **Secure by Design:** PII detection/validation/redaction before network.
- **Separation of Roles:** Cloud = Brain (when escalated, currently local-model brain on server); Local = Hands + lightweight brain.

## 3. Architecture (Section 2–5 Summary)

```
User Goal
  → [Observe] capture AT (content_script.js) + Screenshot (background.js via captureVisibleTab) in parallel
  → [Local Reasoning] LocalLLMProvider.plan({at, userGoal, visualContext?}) primary; fallback LocalVLMProvider.analyze({screenshot}) if AT insufficient
  → [Decision Gate] confidence >=0.7 → Execute Locally : Escalate
  → [Execute Locally] scroll/click/navigate/read auto | type/submit/payment → Approval Modal → Approve/Deny
  → [Evaluate] new AT+screenshot, goal achieved? YES→Done : NO→Sanitize→Escalate
  → [Sanitize Locally] Stage1 VLM detectPII → Stage2 LLM classifyPII → Stage3 Canvas redaction → sanitized payload
  → [Cloud Reasoning — Server] Express POST /api/agent/act {sanitizedScreenshot, sanitizedAT, sessionId} → session_manager → cloud_agent (LocalModelAdapter currently, commercial adapter later) → Action Instructions + Reasoning
  → [Execute & Repeat] local executor runs cloud plan; loop to Observe
```

## 4. Technology Stack (Locked)

| Layer | Choice | Notes |
|-------|--------|-------|
| Extension Manifest | V3 Chrome-first (Firefox compat deferred) | `permissions: activeTab, scripting, storage`; `debugger` optional |
| Screenshot | `chrome.tabs.captureVisibleTab()` | Base64 PNG/JPEG; scroll-and-stitch optional |
| DOM/AT | Content scripts + `getBoundingClientRect()` | `chrome.debugger Accessibility.getFullAXTree` optional enhancement |
| Redaction | OffscreenCanvas / Canvas API | Stage 3 |
| Model layer | `LocalLLMProvider`/`LocalVLMProvider` interfaces | `StubProvider` Phases 1–12; `RealProvider` Phase 13; `MODEL_BACKEND=stub\|real` flag + `ModelProviderRegistry` |
| Runtime candidates (Phase 13 eval) | `onnxruntime-web` (WebGPU) vs `@xenova/transformers` vs alternatives + ≤3B INT4/INT8 LLM + lightweight VLM | Decision deferred |
| Server | **Express + TypeScript** (not FastAPI) | `npm`, `tsx`/`ts-node`, `zod` validation |
| Server models | **Local models via LocalModelAdapter** (not commercial APIs for now) | Adapter layer per Section 4 — commercial swap later stays one-file change |
| Session | In-memory `Map` keyed by `sessionId` (Redis later) | `server/session_manager.ts` |
| Protocol | REST `POST /api/agent/act` (WebSocket later if needed) | HTTPS, encrypted payload |

## 5. Data Schemas (Section 8 — Contracts)

**Action Plan (v1.0):**
```json
{
  "version": "1.0",
  "source": "local|cloud",
  "confidence": 0.0,
  "actions": [
    {"id": "uuid", "type": "scroll|click|navigate|read|type|submit|payment", "requires_approval": false, "target": {"mode": "at_node_id|bbox|css_selector", "value": "string"}, "params": {}}
  ],
  "reasoning": "string"
}
```

**Sanitization Report:**
```json
{
  "redacted_regions": [{"bbox":[0,0,0,0], "type":"face|password|credit_card|name|address|email|phone", "strategy":"blur|blackout|mask|replace", "confidence":0.95}],
  "sanitized_at_summary": "PII nodes removed: 3",
  "timestamp": "ISO8601"
}
```

**PII detection (Stage 1) + Action Plan examples in Sections 2.2/3/4 are authoritative JSON shapes for stubs.**

## 6. File Structure (Section 9 — Target, with TS adaptation)

```
ai-web-agent-extension/  (repo root = C:\Users\nihar\PROJECT_TRINETRA)
├── manifest.json
├── background.js              // Service worker: orchestration, screenshot, server comms
├── content_script.js          // DOM/AT extraction, action injection, approval UI
├── popup.html / popup.js      // User goal input, status dashboard, task history
├── local_models/
│   ├── llm/                    // Quantized LLM artifacts — TBD Phase 13
│   └── vlm/                    // Quantized VLM artifacts — TBD Phase 13
├── lib/
│   ├── providers/
│   │   ├── model_provider_interface.js  // Contracts
│   │   ├── stub_provider.js             // Deterministic mock — Phases 1–12
│   │   └── real_provider.js             // Wraps chosen runtime — Phase 13
│   ├── at_extractor.js
│   ├── screenshot.js
│   ├── local_reasoning.js
│   ├── visual_analysis.js
│   ├── action_executor.js
│   ├── pii_detector.js
│   ├── pii_validator.js
│   ├── sanitization_engine.js
│   └── workflow_loop.js
└── server/
    ├── package.json
    ├── tsconfig.json
    ├── src/
    │   ├── main.ts                // Express entrypoint (was main.py)
    │   ├── session_manager.ts
    │   ├── cloud_agent.ts
    │   └── providers/
    │       └── local_model_adapter.ts // Local adapter (was OpenAI/Anthropic adapters)
    └── .env.example
```

## 7. Implementation Phases (Section 10 — In Order, Do Not Skip)

### PHASE 0 — Project Skeleton
- **Scope:** `manifest.json`, empty folders (`lib/`, `lib/providers/`, `server/`, `server/src/providers/`, `local_models/llm/`, `local_models/vlm/`), `README.md`, server `package.json`+`tsconfig.json` shell.
- **Build:** Folder layout per Section 9 (TS adaptation noted). `manifest.json` V3 Chrome with `activeTab, scripting, storage` permissions, `background.service_worker`, `action.default_popup`. No logic.
- **DoD:**
  - [ ] Extension loads unpacked in Chrome with no errors (blank popup is fine).
  - [ ] Folder structure matches Section 9 exactly (with `server/src` TS variant).

### PHASE 1 — Popup UI Shell
- **Scope:** `popup.html`, `popup.js`.
- **Build:** Minimal popup: text input "User Goal" + "Start" button + status area. Clicking Start logs goal to console. No wiring.
- **DoD:**
  - [ ] Popup opens, accepts text, "Start" logs it.

### PHASE 2 — DOM Accessibility Tree (AT) Extraction
- **Scope:** `lib/at_extractor.js`, `content_script.js`.
- **Build:** Function walking DOM → JSON array `{role, name, state, bounds{x,y,width,height}}` per Section 2.1.A via `getBoundingClientRect()`; content script returns via message passing.
- **DoD:**
  - [ ] On real webpage, extractor returns non-empty array with 4 required fields per node.
  - [ ] Tested on ≥2 different websites.

### PHASE 3 — Screenshot Capture
- **Scope:** `lib/screenshot.js`, `background.js`.
- **Build:** `chrome.tabs.captureVisibleTab()` → Base64 image per 2.1.B.
- **DoD:**
  - [ ] Returns valid Base64 PNG/JPEG renderable in `<img>`.

### PHASE 4 — Model Provider Interface + Stub
- **Scope:** `lib/providers/model_provider_interface.js`, `lib/providers/stub_provider.js`.
- **Build:** Define `LocalLLMProvider.plan({at,userGoal,visualContext?})→{plan,confidence,needs_escalation}`, `LocalVLMProvider.analyze({screenshot})→{elements,bboxes,ocrText,labels}`, plus `detectPII()`/`classifyPII()` for sanitization. `StubLLMProvider`/`StubVLMProvider` deterministic rule-based mocks matching Section 2.2/3 schemas. `MODEL_BACKEND=stub` flag + registry.
- **DoD:**
  - [ ] `StubLLMProvider.plan()` returns valid Action Plan JSON for ≥3 sample goals.
  - [ ] `StubVLMProvider.analyze()` and `detectPII()` return valid JSON matching 2.2/3 schemas.
  - [ ] `MODEL_BACKEND=stub` selects stubs.

### PHASE 5 — Local Reasoning Wiring (Primary + Fallback)
- **Scope:** `lib/local_reasoning.js`, `lib/visual_analysis.js`.
- **Build:** Primary AT→`plan()` + fallback screenshot→`analyze()` only when primary signals AT insufficient; confidence gate 0.7 configurable routing to `proceed locally` vs `needs_escalation`.
- **DoD:**
  - [ ] Given goal+AT, returns Action Plan JSON with confidence.
  - [ ] Low-confidence stub → `needs_escalation:true`; high → `false`.

### PHASE 6 — Action Execution + Approval Flow
- **Scope:** `lib/action_executor.js`, approval modal in `content_script.js`/`popup.js`.
- **Build:** Allowed `scroll/click/navigate/read` auto-execute; Restricted `type/fill/submit/payments` → pause → modal "Agent Approval Required" → Approve executes / Deny replans.
- **DoD:**
  - [ ] Allowed actions execute immediately on real page given Phase 5 plan.
  - [ ] Restricted actions pause with modal; Approve executes, Deny does not.

### PHASE 7 — Local-Only Loop Test
- **Scope:** `lib/workflow_loop.js` (local-only version).
- **Build:** Wire Phases 2–6 into loop steps 1–5 (Goal→Observe→Reason→Execute→Evaluate); escalation stubbed as log.
- **DoD:**
  - [ ] Full local loop runs on real simple webpage without crash; stops correctly when stubbed goal met.

### PHASE 8 — Sanitization Pipeline (Stages 1–3)
- **Scope:** `lib/pii_detector.js`, `lib/pii_validator.js`, `lib/sanitization_engine.js`.
- **Build:** Stage1 `detectPII()` stub, Stage2 `classifyPII()` stub, Stage3 Canvas/OffscreenCanvas redaction; outputs sanitized screenshot+AT + Sanitization Report.
- **DoD:**
  - [ ] Given screenshot + fake PII fixtures, outputs sanitized image (visual confirmation) + sanitized AT with PII replaced.
  - [ ] Matches Sanitization Report schema Section 8.

### PHASE 9 — Backend Server Skeleton (Express+TS)
- **Scope:** `server/src/main.ts`, `server/src/session_manager.ts`, `server/package.json`, `server/tsconfig.json`.
- **Build:** Minimal Express + TS server with `POST /api/agent/act {sanitizedScreenshot, sanitizedAT, sessionId}` → hardcoded Action Instructions JSON (Section 4 example); in-memory session store by `sessionId`.
- **DoD:**
  - [ ] `npm run dev` starts on localhost; test POST returns valid Action Instructions JSON.
  - [ ] Session store can retrieve prior turns by `sessionId`.

### PHASE 10 — Cloud Model Integration (Local Adapter)
- **Scope:** `server/src/cloud_agent.ts`, `server/src/providers/local_model_adapter.ts`.
- **Build:** Replace hardcoded response with call to `LocalModelAdapter` (local model path, not commercial API); sanitized screenshot+AT → structured Action Instructions + optional Explanation; API errors caught.
- **DoD:**
  - [ ] Adapter call returns plan reflecting sanitized input (describe-what-it-sees check).
  - [ ] Errors (timeout, bad input) return clear error JSON, no crash.

### PHASE 11 — Full 8-Step Loop (Local + Cloud)
- **Scope:** `lib/workflow_loop.js` (extend), `background.js` networking.
- **Build:** Wire real escalation (steps 6–8): gate `needs_escalation:true` → sanitization pipeline Phase 8 → POST to Phase 10 endpoint → executor Phase 6 → loop until done.
- **DoD:**
  - [ ] Forced low-confidence stub drives full cloud escalation path end-to-end on real page.
  - [ ] Forced high-confidence stub stays local (no network call — verified via logs).

### PHASE 12 — Reference Demo Task
- **Scope:** integration test only (no new files).
- **Build:** Run "Find the cheapest laptop under ₹60,000 and open it." on real e-commerce end-to-end (Section 11 steps 1–7).
- **DoD:**
  - [ ] All 7 expected-flow steps complete successfully at least once.

### PHASE 13 — Model Integration (swap stub for real client-side AI)
- **Scope:** `lib/providers/real_provider.js`, `local_models/llm/`, `local_models/vlm/`.
- **Build:** Only after 0–12 pass on stub: evaluate runtime winner, implement `RealProvider` behind same interface, flip `MODEL_BACKEND` to real.
- **DoD:**
  - [ ] Re-run Phases 5,7,8,11,12 checks against real provider — all still pass.
  - [ ] Threshold re-tuned using real confidence scores.

## 8. Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Free model loses multi-file state | Strict phase isolation, stop-and-summarize, small scopes, verbose explicit code |
| `chrome.debugger` permission friction | DOM-walk baseline first, debugger optional |
| Commercial→local "cloud" drift | Adapter pattern preserves swap; Phase 10 DoD validates schema parity |
| Canvas redaction fidelity | Fixture-based visual regression |

## 9. Reference Demo Task (Section 11)

"Find the cheapest laptop under ₹60,000 and open it." — navigate → search box (approval for type) → price filter <₹60k → scroll loop → read prices → click cheapest → product page → Task Completed.

## 10. Changelog

| Date | Change |
|------|--------|
| 2026-09-05 | Initial template created |
| 2026-09-05 | Full SIH 2026 plan written; locked to Express+TS, local-cloud, Chrome-first; phased DoDs |

## 11. Next Actions

1. Execute Phase 0 skeleton now.
2. After each phase, append verification notes here before proceeding.
