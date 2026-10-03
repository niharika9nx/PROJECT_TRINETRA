# Trinetra — Privacy-Preserving AI Web Agent (SIH 2026)

A Chrome Manifest V3 extension + Express (Node.js + TypeScript) backend that acts as an intelligent web agent. Trinetra navigates web pages, extracts information, and performs actions on your behalf — all while keeping your data private through local-first processing and a 3-stage sanitization pipeline.

## Architecture

```
User Goal
  → [Observe]    DOM Accessibility Tree + Screenshot captured in parallel
  → [Reason]     Local LLM plans next action (confidence-scored)
  → [Gate]       confidence ≥ threshold → Execute locally
                          ↓ (< threshold)
  → [Sanitize]   3-stage pipeline: PII detect → classify → redaction (fails closed)
  → [Cloud]      Sanitized payload POSTed to server for deeper reasoning
  → [Execute]    Actions run on page (restricted actions require approval)
  → [Evaluate]   Goal achieved? Loop or continue
```

**Key design principles:**
- **Privacy first** — No unsanitized data leaves the device. The 3-stage sanitization pipeline runs locally before any network request, and fails closed: if the sanitizer is unavailable or throws, the accessibility tree is withheld rather than shipped raw.
- **Local-first** — DOM Accessibility Tree + local model reasoning preferred; cloud escalation is the exception.
- **Human-in-the-loop** — Sensitive actions (`type`, `fill`, `submit`, `confirm`, `payment`) always pause for explicit approval. An action flagged `requires_approval: true` is never downgraded, regardless of its content. Approval is requested once per plan with every restricted action listed, and denial halts the remaining plan.
- **Provider-agnostic** — Adapter pattern allows swapping the local stub for Gemini, OpenAI, Anthropic, etc. with a single file change.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Extension | Chrome Manifest V3, `chrome.tabs.captureVisibleTab()`, content scripts |
| DOM Extraction | Custom Accessibility Tree walker via `getBoundingClientRect()` |
| Client Models | Pluggable `LocalLLMProvider` / `LocalVLMProvider` interfaces (stub → real in Phase 13) |
| Sanitization | OffscreenCanvas / Canvas API (3-stage PII redaction) |
| Server | Express + TypeScript, Zod validation, in-memory session store |
| Cloud Brain | Gemini with fallback chain, or a local rule-based stub |

## File Structure

```
PROJECT_TRINETRA/
├── manifest.json                  # MV3 extension manifest
├── background.js                  # Service worker: screenshot, message routing, server comms
├── content_script.js              # DOM/AT extraction, action execution, approval UI, floating panel
├── package.json                   # npm test -> node tests/run_all.js
├── lib/
│   ├── providers/
│   │   ├── model_provider_interface.js  # Provider contracts + registry
│   │   ├── stub_provider.js             # Deterministic mock (Phases 1–12)
│   │   └── real_provider.js             # Real client-side runtime (Phase 13)
│   ├── at_extractor.js           # DOM → Accessibility Tree
│   ├── screenshot.js             # Screenshot capture helpers
│   ├── local_reasoning.js        # Primary AT → plan + VLM fallback
│   ├── visual_analysis.js        # VLM screenshot analysis
│   ├── action_executor.js        # Action dispatch (scroll/click/type/navigate/etc.)
│   ├── pii_detector.js           # Stage 1: PII detection
│   ├── pii_validator.js          # Stage 2: PII classification
│   ├── sanitization_engine.js    # Stage 3: Canvas + AT redaction
│   ├── products.js               # Product extraction, scoring, purchase safety guard
│   └── workflow_loop.js          # 8-step observe→reason→act loop
├── tests/                        # Node assert-based suite (npm test)
├── local_models/
│   ├── llm/                      # Quantized LLM artifacts (Phase 13)
│   └── vlm/                      # Quantized VLM artifacts (Phase 13)
└── server/
    ├── package.json
    ├── tsconfig.json
    ├── .env.example
    └── src/
        ├── main.ts               # Express entrypoint
        ├── session_manager.ts    # In-memory session store
        ├── cloud_agent.ts        # Orchestration + provider routing
        └── providers/
            ├── local_model_adapter.ts  # Local rule-based stub adapter
            └── gemini_adapter.ts       # Gemini adapter + model chain
```

## Prerequisites

- **Node.js** ≥ 18 (for native `fetch` in server)
- **Google Chrome** (or Chromium-based browser)
- A **Gemini API key** (optional — server runs the local stub if not provided)

## Setup

### 1. Extension

1. Open `chrome://extensions` in Chrome
2. Enable **Developer mode** (toggle in top-right)
3. Click **Load unpacked** → select the `PROJECT_TRINETRA` root folder
4. The Trinetra icon appears in the toolbar. **Click it to open the in-page agent panel** (there is no browser-action popup — the panel is injected into the current page).

### 2. Server

```bash
cd server
cp .env.example .env        # edit .env and add your GEMINI_API_KEY (optional)
npm install
npm run dev                  # starts on http://127.0.0.1:3001
```

The server exposes:
- `GET /health` — status, the resolved model chain, auth mode
- `POST /api/agent/act` — accepts a sanitized payload, returns an Action Plan
- `GET /api/session/:id` — retrieve session history

**Security posture:** the server binds to `127.0.0.1` and its CORS allow-list accepts
only `chrome-extension://` origins and loopback, so an arbitrary website the user
visits cannot spend your Gemini quota. For defence in depth, set
`TRINETRA_SERVER_TOKEN` in `server/.env`; `/api/*` will then require a matching
`X-Trinetra-Token` header.

### 3. Tests

```bash
npm test
```

Runs 13 files. The cloud integration test needs the server running; it skips
cleanly when it is not.

### 4. Usage

1. Navigate to any webpage (e.g., an e-commerce site)
2. Click the Trinetra toolbar icon to open the in-page panel
3. Type a goal (e.g., "Find the cheapest laptop under ₹60,000 and open it")
4. Trinetra observes the page, reasons about next steps, and executes actions
5. Sensitive actions pause for approval — **one prompt per plan**, listing every
   action it will run. Approving runs them all; Deny halts the plan.
6. On success the panel shows a result banner (iterations, actions, whether the
   cloud brain was used or the local fallback took over) plus three contextual
   follow-up chips you can click to run the next step.

Goal types it understands: search, **select one product and open it**, navigate,
info, action, and **order** (with the purchase boundaries described below).

### 5. Examples

| Goal | What happens |
|------|--------------|
| `find the cheapest laptop under 60000` | Searches, shows results |
| `open the best laptop under 60000` | Searches, then opens the single best-rated laptop within budget |
| `show me the cheapest phone under 20000` | Same, cheapest wins |
| `open my cart` / `go to orders` | Navigates |
| `place order for the laptop` | Adds to cart and reaches checkout, then stops for a priced confirmation |

## How It Works

Trinetra runs an 8-step workflow loop:

1. **Observe** — Captures the DOM Accessibility Tree and a screenshot in parallel
2. **Reason** — Local LLM analyzes the page context against the user goal, producing a confidence-scored action plan (confidence is a **0–1** scale)
3. **Gate** — If confidence ≥ threshold (default **0.7**), actions execute locally. Below threshold, the payload is sanitized and sent to the cloud adapter.
4. **Sanitize** (when escalating) — 3-stage pipeline: PII detection → classification → redaction
5. **Cloud** — Sanitized payload POSTed to the server, which routes to Gemini or the local stub
6. **Execute** — Actions dispatched on the page (scroll, click, navigate, type, submit, etc.)
7. **Settle** — After a page transition, wait for the URL to change *and* for the DOM to stop rendering, rather than a fixed timeout. A slow page is not a failed page.
8. **Evaluate** — Check if goal is achieved; if not, loop back to Observe
9. **Repeat** — Up to `maxIterations` (default 10)

### Targeting across re-renders

Accessibility-tree node ids are derived from element content (tag + selector +
normalized accessible name), not DOM position. A plan built from a snapshot taken
before a model call still resolves to the same element afterwards, which is what
keeps a dynamic page like Amazon from producing "action failed" on most
iterations. Actionable controls are extracted first and are never dropped behind
the node cap, so every element the agent can act on stays reachable.

### Choosing a product

For goals like *"open the best laptop under 60,000"* the agent does not stop at
the results list. It groups the accessibility tree into product cards, reads each
card's price and rating, applies the budget, and opens the single best match —
highest rated within budget, or lowest price when you said "cheapest". Prices are
read only where there is a currency marker, thousands separator, or Indian unit,
so a `4.2 out of 5 stars` line is never mistaken for a price of ₹4.20.

### Ordering, and where the agent stops

Ordering support is deliberately bounded:

| Step | Behaviour |
|------|-----------|
| Find the product, open it | Automatic |
| Add to cart, go to cart, go to checkout | Automatic |
| Card number, CVV, expiry, OTP, account number | **Refused.** The agent never types payment credentials, even if the page demands them — you enter those yourself |
| Place order / Pay now / Confirm order | **Always a dedicated confirmation** showing the item and the exact total read from the page. The buttons relabel to "Place order" / "Cancel", the approve button turns red, and the default on timeout is cancel |
| Total cannot be read from the page | **Refused** — an order is never committed at an unknown price |
| Login required | Stops and hands back to you |

The refusal is enforced in the workflow loop, not trusted to the model. If the
planner asks for a card number, the action is dropped before it reaches the page
and reported to you. "Place order" counts as success only when the page shows an
order confirmation — reaching checkout is not treated as success.

### Sanitization, honestly

Stage 1 (PII detection) is backed by `StubVLMProvider` until Phase 13. Its
detections are fixed fixture coordinates that correspond to nothing in a real
screenshot, so they are marked `grounded: false` and **nothing is painted onto
captured screenshots** — the report states `screenshot_redacted: false` rather
than claiming a redaction that did not happen.

The accessibility-tree pass (Stage 3) *is* real and always runs: emails, phone
numbers (including 5-digit Indian subscriber formats) and card numbers are
masked or removed, while product names, prices and order ids survive so the
agent can still do its job.

## Current Status

| Phase | Description | Status |
|-------|-------------|--------|
| 0 | Project skeleton | Done |
| 1 | In-page agent panel UI | Done |
| 2 | DOM Accessibility Tree extraction | Done |
| 3 | Screenshot capture | Done |
| 4 | Model provider interface + stub | Done |
| 5 | Local reasoning (primary + fallback) | Done |
| 6 | Action execution + approval flow | Done |
| 7 | Local-only loop test | Done |
| 8 | Sanitization pipeline (Stages 1–3) | Done |
| 9 | Backend server skeleton (Express+TS) | Done |
| 10 | Cloud model integration (Gemini adapter) | Done |
| 11 | Full 8-step loop (local + cloud) | Done |
| 12 | Reference demo task | Pending |
| 13 | Real client-side model integration | Pending |

## License

Internal project — Smart India Hackathon 2026.
