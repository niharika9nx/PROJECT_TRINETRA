// Trinetra — popup.js (Phase 12: wired Start → runFullLoop)
// One-click demo: observe AT+screenshot → local reasoning (DOM-first, needs_vlm flagged) → sanitize → Gemini 3.5 → execute → loop

document.addEventListener('DOMContentLoaded', () => {
  const goalInput = document.getElementById('goalInput');
  const startBtn = document.getElementById('startBtn');
  const statusText = document.getElementById('statusText');

  if (!goalInput || !startBtn || !statusText) {
    console.error('[Trinetra] popup.js: required elements not found');
    return;
  }

  try {
    chrome.storage.local.get(['lastGoal'], (result) => {
      if (result && result.lastGoal) goalInput.value = result.lastGoal;
    });
  } catch (e) {}

  function setStatus(msg, color = '#cbd5e1') {
    statusText.textContent = msg;
    statusText.style.color = color;
  }

  function bgSend(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (res) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(res);
      });
    });
  }

  // Helpers injected into runFullLoop
  async function getAT() {
    const res = await bgSend({ type: 'TRINETRA_REQUEST_AT', options: { maxNodes: 2000 } });
    if (!res || !res.success) throw new Error(res?.error || 'AT extraction failed — is content script active? Try reloading the page.');
    return res.at || [];
  }

  async function getScreenshot() {
    try {
      const res = await bgSend({ type: 'TRINETRA_CAPTURE_SCREENSHOT', options: { format: 'png', quality: 92 } });
      if (res && res.success && res.dataUrl) return res.dataUrl;
      console.warn('[Trinetra] screenshot failed', res);
      return null;
    } catch (e) {
      console.warn('[Trinetra] screenshot error', e);
      return null;
    }
  }

  async function executePlanFn({ actions }) {
    const res = await bgSend({ type: 'TRINETRA_EXECUTE_PLAN_BG', plan: { actions } });
    if (!res || !res.success) throw new Error(res?.error || 'execute failed');
    return res.result;
  }

  async function sanitizeFn({ screenshot, at }) {
    // Use loaded sanitization engine if available, else passthrough
    const eng = (typeof window !== 'undefined' && window.TrinetraSanitization) || (typeof self !== 'undefined' && self.TrinetraSanitization) || null;
    if (eng && eng.runSanitizationPipeline) {
      try {
        return await eng.runSanitizationPipeline({ screenshot, at });
      } catch (e) {
        console.warn('[Trinetra] sanitization failed, passthrough', e);
      }
    }
    return { sanitizedScreenshot: screenshot, sanitizedAT: at, report: { redacted_regions: [], sanitized_at_summary: 'passthrough (no engine)' } };
  }

  function getReasonFn() {
    const lr = (typeof window !== 'undefined' && window.TrinetraLocalReasoning) || (typeof self !== 'undefined' && self.TrinetraLocalReasoning) || null;
    if (lr && lr.reasonLocally) return lr.reasonLocally;
    // Fallback stub direct
    const stub = (typeof window !== 'undefined' && window.TrinetraStubProvider) || null;
    if (stub && stub.StubLLMProvider) {
      return async ({ at, userGoal, screenshot, threshold }) => {
        const c = await stub.StubLLMProvider.plan({ at, userGoal });
        return { ...c, needs_escalation: c.confidence < (threshold ?? 0.7), actions: c.actions, plan: c.plan, threshold };
      };
    }
    throw new Error('No reasoning provider available');
  }

  let running = false;
  startBtn.addEventListener('click', async () => {
    if (running) return;
    const goal = goalInput.value.trim();
    console.log('[Trinetra] User Goal:', goal);
    if (!goal) {
      setStatus('Please enter a goal before clicking Start.', '#fbbf24');
      return;
    }
    try { chrome.storage.local.set({ lastGoal: goal }); } catch (e) {}

    const loop = (typeof window !== 'undefined' && window.TrinetraWorkflowLoop) || (typeof self !== 'undefined' && self.TrinetraWorkflowLoop) || null;
    if (!loop || !loop.runFullLoop) {
      setStatus('Workflow engine not loaded — reload extension.', '#f87171');
      return;
    }

    running = true;
    startBtn.disabled = true;
    startBtn.textContent = 'Running...';
    setStatus(`Goal: "${goal}"\nStarting observe → local reasoning → sanitize → Gemini 3.5 (3001) → execute...`, '#38bdf8');

    const onStep = ({ step, iteration, confidence, needs_escalation, needs_vlm, vlm_reason, atCount, hasScreenshot, actions, report, cloudResult, error, source, achieved, execResult }) => {
      let msg = `[Iter ${iteration || '-'}] ${step}`;
      if (step === 'observed') msg = `[Iter ${iteration}] Observed ${atCount} nodes${hasScreenshot ? ' + screenshot' : ''}`;
      else if (step === 'reasoned') {
        const actPreview = actions ? ` actions:${actions.length} [${actions.map(a=>`${a.type}:${a.target?.value || a.target?.mode || 'null'}`).join(',').slice(0,80)}]` : '';
        msg = `[Iter ${iteration}] Local confidence ${(confidence ?? 0).toFixed(2)} ${needs_escalation ? '(→ cloud)' : '(→ local)'}${needs_vlm ? ` [VLM_FLAG: ${vlm_reason?.slice(0,40)}]` : ''}${actPreview}`;
      } else if (step === 'vlm_flag') msg = `[Iter ${iteration}] VLM_REQUIRED flagged: ${vlm_reason?.slice(0,80)} — no VLM call yet (DOM-first)`;
      else if (step === 'sanitized') msg = `[Iter ${iteration}] Sanitized ${report?.redacted_regions?.length ?? 0} regions`;
      else if (step === 'cloud_result') msg = `[Iter ${iteration}] Gemini: ${(cloudResult?.reasoning || '').slice(0,100)} needs_vlm=${cloudResult?.needs_vlm} actions:${cloudResult?.actions?.length}`;
      else if (step === 'executed' || step === 'executed_stub') {
        const execPreview = execResult?.results ? ` results:${execResult.results.map(r=>`${r.action.type}:${r.result?.success ? 'ok' : r.result?.error?.slice(0,30)}`).join(',').slice(0,120)}` : '';
        msg = `[Iter ${iteration}] Executed ${source} ${actions?.length ?? 0} actions${execPreview}`;
      } else if (step === 'execute_error' || step === 'cloud_error' || step === 'sanitize_error') msg = `[Iter ${iteration}] ${step}: ${error}`;
      else if (step === 'evaluate') msg = `[Iter ${iteration}] Evaluate: ${achieved ? 'Goal achieved ✅' : 'continue...'}`;
      else if (step === 'would_escalate') msg = `[Iter ${iteration}] Would escalate (low confidence)`;

      console.log('[Trinetra]', msg, { step, iteration, confidence, needs_escalation, needs_vlm, actions, cloudResult, execResult });
      // Append to status (keep last 14)
      const current = statusText.textContent || '';
      const lines = current.split('\n');
      if (lines.length > 14) lines.shift();
      lines.push(msg);
      setStatus(lines.join('\n'), '#cbd5e1');
      if (step === 'executed' && needs_vlm) {
        setStatus(statusText.textContent + '\n— VLM flagged, later will switch to real VLM —', '#fbbf24');
      }
    };

    try {
      const result = await loop.runFullLoop({
        userGoal: goal,
        getAT,
        getScreenshot,
        executePlanFn,
        reasonFn: getReasonFn(),
        sanitizeFn,
        // cloudCallFn uses background proxy default which hits 3001; pass explicit to be safe
        serverUrl: 'http://localhost:3001/api/agent/act',
        onStep,
        maxIterations: 6,
        threshold: 0.7,
      });

      console.log('[Trinetra] Loop result', result);
      if (result.success) {
        setStatus(`Done after ${result.iteration} iterations: ${result.reason}\nGoal achieved ✅\nCheck page for action results.`, '#86efac');
      } else {
        setStatus(`Stopped after ${result.iteration} iterations: ${result.reason}\n${result.history?.slice(-1)[0]?.reasoning?.vlm_reason ? 'VLM flag: ' + result.history.slice(-1)[0].reasoning.vlm_reason : ''}`, '#fbbf24');
      }
    } catch (err) {
      console.error('[Trinetra] loop error', err);
      setStatus(`Error: ${err.message}\nTry: 1) reload page 2) ensure server on 3001 (health) 3) check console`, '#f87171');
    } finally {
      running = false;
      startBtn.disabled = false;
      startBtn.textContent = 'Start';
    }
  });

  goalInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) startBtn.click();
  });
});
