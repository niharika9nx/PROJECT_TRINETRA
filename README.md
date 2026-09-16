# Trinetra — Privacy-Preserving AI Web Agent (SIH 2026)

A Chrome Manifest V3 extension + Express (Node.js + TypeScript) backend that acts as an intelligent web agent. Trinetra navigates web pages, extracts information, and performs actions on your behalf — all while keeping your data private through local-first processing and a 3-stage sanitization pipeline.

## Architecture

```
User Goal
  → [Observe]    DOM Accessibility Tree + Screenshot captured in parallel
  → [Reason]     Local LLM plans next action (confidence-scored)
  → [Gate]       confidence ≥ threshold → Execute locally
                          ↓ (< threshold)
  → [Sanitize]   3-stage pipeline: PII detect → classify → Canvas redaction
  → [Cloud]      Sanitized payload POSTed to server for deeper reasoning
  → [Execute]    Actions run on page (restricted actions require approval)
  → [Evaluate]   Goal achieved? Loop or continue
```

**Key design principles:**
- **Privacy first** — No unsanitized data leaves the device. Sanitization runs locally before any network request.
- **Local-first** — DOM Accessibility Tree + local model reasoning preferred; cloud escalation is the exception.
- **Human-in-the-loop** — Sensitive actions (type, submit, payment) require explicit approval via modal.
- **Provider-agnostic** — Adapter pattern allows swapping local stub for Gemini, OpenAI, Anthropic, etc. with a single file change.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Extension | Chrome Manifest V3, `chrome.tabs.captureVisibleTab()`, content scripts |
| DOM Extraction | Custom Accessibility Tree walker via `getBoundingClientRect()` |
| Client Models | Pluggable `LocalLLMProvider` / `LocalVLMProvider` interfaces (stub → real in Phase 13) |
| Sanitization | OffscreenCanvas / Canvas API (3-stage PII redaction) |
| Server | Express + TypeScript, Zod validation, in-memory session store |
| Cloud Brain | Gemini 3.5 Flash (with fallback chain) or local stub adapter |

## File Structure

```
PROJECT_TRINETRA/
├── manifest.json                  # MV3 extension manifest
├── background.js                  # Service worker: screenshot, message routing, server comms
├── content_script.js              # DOM/AT extraction, action execution, approval UI, floating panel
├── popup.html / popup.js          # Extension popup UI (glassmorphism chat interface)
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
│   ├── sanitization_engine.js    # Stage 3: Canvas redaction
│   └── workflow_loop.js          # 8-step observe→reason→act loop
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
            ├── local_model_adapter.ts  # Local stub cloud adapter
            └── gemini_adapter.ts       # Gemini 3.5 Flash adapter
```

## Prerequisites

- **Node.js** ≥ 18 (for native `fetch` in server)
- **Google Chrome** (or Chromium-based browser)
- A **Gemini API key** (optional — server runs with local stub if not provided)

## Setup

### 1. Extension

1. Open `chrome://extensions` in Chrome
2. Enable **Developer mode** (toggle in top-right)
3. Click **Load unpacked** → select the `PROJECT_TRINETRA` root folder
4. The Trinetra icon appears in the toolbar; click it to open the popup

### 2. Server

```bash
cd server
cp .env.example .env        # edit .env and add your GEMINI_API_KEY (optional)
npm install
npm run dev                  # starts on http://localhost:3001
```

The server exposes:
- `GET /health` — status, Gemini config, fallback chain
- `POST /api/agent/act` — accepts sanitized payload, returns action plan
- `GET /api/session/:id` — retrieve session history

### 3. Usage

1. Navigate to any webpage (e.g., an e-commerce site)
2. Click the Trinetra icon or use the popup
3. Type a goal (e.g., "Find the cheapest laptop under ₹60,000 and open it")
4. Trinetra observes the page, reasons about next steps, and executes actions
5. Sensitive actions (typing, submitting) pause for your approval
6. The agent loops until the goal is achieved or max iterations are reached

## How It Works

Trinetra runs an 8-step workflow loop:

1. **Observe** — Captures the DOM Accessibility Tree and a screenshot in parallel
2. **Reason** — Local LLM analyzes the page context against the user goal, producing a confidence-scored action plan
3. **Gate** — If confidence ≥ threshold (default 0.7), actions execute locally. Below threshold, the payload is sanitized and sent to the cloud adapter.
4. **Sanitize** (when escalating) — 3-stage pipeline: PII detection → classification → Canvas redaction
5. **Cloud** — Sanitized payload POSTed to the server, which routes to Gemini or local stub
6. **Execute** — Actions dispatched on the page (scroll, click, navigate, type, submit, etc.)
7. **Evaluate** — Check if goal is achieved; if not, loop back to Observe
8. **Repeat** — Up to `maxIterations` (default 6)

## Current Status

Completed through **Phase 11** (full 8-step loop with cloud escalation). See `plan.md` for the complete 14-phase build plan.

| Phase | Description | Status |
|-------|-------------|--------|
| 0 | Project skeleton | Done |
| 1 | Popup UI shell | Done |
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
