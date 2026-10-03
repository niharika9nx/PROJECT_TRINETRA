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
| 2026-09-29 | Correctness + security pass (see §12) |

## 12. Correctness & Security Pass (2026-09-29)

Fixes applied after a codebase review. All changes are covered by `npm test`.

**Security**
- A live Gemini API key was committed in `scratch/test_gemma.js`. File deleted,
  `scratch/` gitignored. **The key must be rotated** — history rewriting was not
  performed as it rewrites every commit hash.
- Server: CORS wildcard + bind-all replaced with an origin allow-list
  (`chrome-extension://` + loopback) and a `127.0.0.1` bind. Optional
  `TRINETRA_SERVER_TOKEN` adds a shared-secret header check on `/api/*`.
- API key moved out of the Gemini URL query string into the `x-goog-api-key` header.
- Sanitization now actually runs: `pii_detector.js`, `pii_validator.js` and
  `sanitization_engine.js` were implemented but never loaded, and both UIs
  supplied a passthrough `sanitizeFn` that shipped the **raw** accessibility tree
  to the cloud. Fixed in the manifest bundle, `CONTENT_SCRIPT_BUNDLE`, and the
  loop now forwards the Sanitization Report to the server.
- Sanitization **fails closed**: if the pipeline is missing or throws, the AT is
  withheld rather than sent raw.
- Fixed two leaks inside the sanitizer itself: masked nodes retained the raw
  value in `originalName`, and the phone regex missed 5-digit subscriber formats
  such as `+91 98765 43210`.
- Stub VLM detections are marked `grounded: false` so fixture coordinates are
  never painted onto real screenshots, and the report no longer claims a
  redaction that did not happen.
- Navigation hardened: absolute `http(s)` only (blocks `//evil.com`), and the
  content-script fallback only navigates same-origin when the background is
  unavailable.
- Removed the Google Fonts `@import` — it fired a request to Google from every
  page the agent touched.

**Approval gate**
- `type`/`fill`/`submit`/`confirm`/`payment` were effectively ungated: an
  `isSearchAction` heuristic treated any `type` whose text did not match
  `/password|card|cvv|otp/i` as a search action and stripped its
  `requires_approval: true`. Addresses, phone numbers and usernames ran with no
  prompt. The identical flaw existed in three places
  (`content_script.js`, `lib/action_executor.js`, `gemini_adapter.ts`); all three
  now use the `RESTRICTED_ACTIONS` set and never downgrade an explicit flag.
- Added a 120s approval-modal timeout (an unattended modal previously wedged the
  loop forever) and fail-closed denial when no handler exists.
- The local rule-based adapter emitted `requires_approval: false` on every
  action, including `type`+`submit` against login forms.

**Cloud path**
- `sanitizedScreenshot` was optional but not nullable, so the extension's
  `getScreenshot: null` produced a 400 on **every** escalation (9 such 400s are
  recorded in the old `server/server_log.txt`). Fixed.
- `executeFailures`, `noTransitionCount` and `atDiff.urlChanged` were sent by the
  client but silently stripped by Zod, so the model never saw the signal needed
  to escape a failing loop. Now part of the schema.
- A Gemini failure was silently downgraded to the local stub and still returned
  `success: true`; the stub also labelled itself `source: 'cloud'`. Downgrades are
  now flagged `degraded: true` / `source: 'local-stub'` and surfaced in the panel.
- A timeout skipped the entire backup model chain silently; the skipped models
  are now logged.
- `/health` advertised a different model chain than the one actually used. It now
  imports `getModelChain()` from the adapter as the single source of truth.
- `RegExp` injection in the local adapter (unescaped user-derived word) fixed;
  AT nodes with missing fields no longer throw.

**Contracts & consistency**
- Confidence normalized to a 0–1 scale everywhere (interface, stub, threshold,
  UI). Previously the interface required 0–1 while the stub returned 1–5 and the
  UI multiplied by 100, so a confidence of 3 rendered as "300%".
- `target.mode` in the cloud prompt offers `semantic`, which is not in the
  plan.md contract; the executor accepts both. Left as-is, flagged for Phase 12.
- Removed the dead `popup.html` / `popup.js` (≈700 lines). They were unreachable
  because the manifest sets `action.default_title` and not `default_popup`, so
  `chrome.action.onClicked` opens the in-page panel. `plan.md` Phase 0 required a
  popup; this reverses that decision in favour of the panel, which is the UI that
  actually runs.

**Agent reliability pass (2026-09-29)**
Reported symptom: the first 2–3 iterations of every run fail with "action failed",
"page did not navigate" and "no screen change", and the run never shows a clear
success state. Four root causes, all confirmed in code:

1. **Stale targets.** AT node ids were positional (`node_0`, `node_1`, … by DOM
   order). A plan is produced from an AT snapshot but executed after
   sanitization plus a model call — seconds later — by which time a dynamic page
   has re-rendered and `node_137` refers to a different element. Ids are now
   derived from element content (FNV-1a over tag + selector + normalized
   accessible name, plus an occurrence counter for identical siblings), so the
   same logical element stays addressable across a re-render. Bounds are excluded
   so scrolling does not invalidate an id.
2. **Unreachable controls.** `maxNodes: 2000` stopped the extraction loop, so
   elements past that point never received a `data-trinetra-id` and could never
   be targeted — on a listing page that is exactly where filters and results
   live. Actionable elements are now collected first and are never dropped in
   favour of decorative nodes.
3. **A slow page was reported as a dead page.** The post-transition wait was a
   fixed 1800ms, and the inter-iteration delay 100ms. Amazon changes the URL
   quickly but renders for seconds, so a normal load was logged as
   "page did not navigate", which bumped `failureCount` and fed the model a false
   "your last attempts failed" signal — the cascade that turned one slow load
   into three broken iterations. Replaced with `waitForPageSettled()`: wait for
   the URL change (8s cap), then wait for the DOM to stop structurally mutating
   (MutationObserver, 350ms quiet, 4s cap).
4. **Success was inferred by regexing the model's prose.** `/error|failed|
   couldn't|unable|stopped/i` was matched against text that embeds the model
   reasoning, so a successful run whose reasoning said "the previous submit
   failed" rendered as **Task failed**. Success is now passed explicitly.

Also fixed:
- The panel set `completed` inside the `try` and reset to `ready` in the
  `finally` on the same tick, so success was never visible. Terminal
  `completed`/`error` states are now sticky until the next run.
- "Stuck" is now attributed honestly: the loop distinguishes "the agent could
  not find or use the target" from "the page is not responding", and no longer
  blames the page when its own actions failed. A grace period stops the counter
  arming before the agent has executed anything, and a successful page
  transition resets it.
- Approval is now requested **once per plan** rather than once per action. Every
  restricted action is listed in the single prompt; gate strength is unchanged.
- A successful run shows a result banner (iterations, actions, cloud/local,
  whether it degraded) plus three contextual follow-up chips built from the
  task classification and the product noun in the goal.
- User denial is now a distinct `execute_denied` step and no longer feeds the
  escalation signals as a failure.

**Product selection & ordering (2026-09-29)**
Reported gap: "open best laptop" never selected a product, and there was no
order handling.

- `classifyQuery` matched `/open/` before anything else, so *every* "open X" goal
  became `navigate` and no product was ever chosen. New `select_product` intent
  keys off a product qualifier (best/top/cheapest/under/rating) rather than the
  leading verb, with a true-possessive guard so "open my cart" still navigates.
  `order` replaces the ambiguous `auth_gated` for purchase intent
  (`auth_gated` is kept as a working alias).
- New `lib/products.js`: groups the flat accessibility tree into product cards,
  parses price (with lakh/crore/L units) and rating, and scores candidates
  against the goal's budget and preference. Deliberately refuses to read a bare
  number as a price — "4.2 out of 5 stars" parsing as ₹4.20 was a real bug that
  defeated the budget filter.
- Actionable elements beyond the old 2000-node cap are now extracted, so results
  deep in a listing page are reachable.
- Order flow: add to cart and checkout proceed automatically; the final commit is
  pulled out of the plan and only runs after an amount-bearing confirmation. A
  commit whose total cannot be read from the page is refused outright rather
  than gated. Reaching checkout is not treated as success — only an order
  confirmation is.
- **Purchase safety is enforced in the loop, not trusted to the planner.** Card
  numbers, CVVs, expiry, OTP and account numbers are never typed; the action is
  dropped before it reaches the page and reported to the user. The guard resolves
  `at_node_id` targets back to their label, because the planner targets by id and
  the button's text lives in the AT — without that lookup "Place your order"
  would have waved straight through. `confirmPurchaseFn` fails closed: absent or
  negative means no order.
- The Gemini system prompt now describes both intents and restates the purchase
  boundary, so the model is told the rule it is also checked against.

**Tests**
- Added `npm test` (root `package.json`) and `tests/test_approval.js` +
  `tests/test_sanitize.js`. Note the root `package.json` deliberately omits
  `"type": "module"` — the suite is CommonJS.
- `test_cloud_phase.js` now reads `PORT`, skips cleanly when the server is down,
  and asserts on the typed text plus its approval flag instead of soft-passing.
- Removed two vacuous assertions, and fixed two racing unguarded async IIFEs in
  `test_observe.js`.
- Confidence assertions ported from the 1–5 scale to 0–1.

**Content-script bundle load (follow-up regression)**
- Adding `pii_validator.js` / `pii_detector.js` to the manifest bundle exposed a
  load-breaking bug that the whole suite had stayed green on. Chrome injects
  every `content_scripts[].js` entry as a classic script into **one shared
  realm**, where a duplicate top-level `let` is a SyntaxError and the file
  silently never executes. `lib/pii_validator.js` and `lib/local_reasoning.js`
  both declared `let llmProvider`, so wiring up the sanitization pipeline
  silently killed `local_reasoning.js` — `window.TrinetraLocalReasoning` was
  never created and the agent fell back to a reduced stub path. Node's
  `require()` gives per-file module scope and cannot see this class of bug.
- Fixes: renamed the duplicate binding to `piiLlmProvider`; wrapped all 12
  `lib/*.js` files in an IIFE so no top-level `let`/`const`/`class` can reach the
  shared realm; and decoupled the two `DEFAULT_THRESHOLD` globals, which had
  only ever worked because `workflow_loop.js` happened to load second.
- Added `tests/test_bundle_load.js`, which reproduces the browser's load model
  (manifest order, single `vm` context, `window === self === globalThis`, no
  `require`/`module`, minimal `chrome` stub) and asserts zero load errors, that
  all 8 required globals exist, that no module-private state leaked, and that
  the sanitization pipeline strips PII **in the content-script world** rather
  than only under `require()`. It also pins `manifest.json` and
  `CONTENT_SCRIPT_BUNDLE` to the same file list.
- Suite is now 11/11 with the server up and 11/11 with it down.

**Known gaps (not addressed here)**
- `lib/at_extractor.js` and `lib/action_executor.js` are duplicated inline in
  `content_script.js` and have diverged; the lib copies are only exercised by
  tests, so the tests partly cover code that does not run in the browser. The
  approval-gate test asserts both copies agree to limit the risk.
- The panel and approval modal are injected into the light DOM with no shadow
  root, so page CSS can affect them and a hostile page can read the conversation.
- Screenshot capture is wired but unused (`getScreenshot: null`); the
  `sanitizedScreenshot` field is accepted by the schema and never read by the
  adapter.
- `session_manager.ts` has no TTL or size cap, and `sessionId` is client-supplied.

## 11. Next Actions

1. **Rotate the Gemini API key** and decide whether to rewrite git history.
2. Phase 12 — reference demo task.
3. Phase 13 — real client-side model; this is also what makes grounded screenshot
   redaction real.
4. Consider deduplicating `lib/` against the `content_script.js` inlines and
   moving the panel into a shadow root.

