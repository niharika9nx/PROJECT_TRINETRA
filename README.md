# Trinetra — Privacy-Preserving AI Web Agent (SIH 2026)

Chrome Manifest V3 extension + Express (Node.js + TypeScript) backend. Local-first architecture: DOM Accessibility Tree + screenshot captured in parallel, local LLM/VLM reasoning via pluggable `LocalLLMProvider`/`LocalVLMProvider` interfaces (stub-first through Phases 1–12, real client-side runtime in Phase 13), approval-gated actions, and a 3-stage Canvas sanitization pipeline that runs locally before any network leaves the device. When confidence < 0.7, sanitized payload is POSTed to the local-model "cloud" adapter for deeper reasoning; otherwise actions execute locally. Full 8-step observe→reason→act loop until goal achieved.

> Stack: MV3 Chrome-first, `chrome.tabs.captureVisibleTab()` + DOM AT via content scripts, OffscreenCanvas redaction, Express+TS server with in-memory session store. See `plan.md` for the 14-phase build plan and DoDs.

**Quick start (Phase 0):** Load unpacked extension in Chrome via `chrome://extensions` → Developer mode → Load unpacked → select this folder. Server (from Phase 9): `cd server && npm install && npm run dev`.
