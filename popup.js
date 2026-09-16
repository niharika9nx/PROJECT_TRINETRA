// Trinetra — popup.js Premium glassmorphism UI + agent activity timeline
// Frontend UI redesign only — all agent core logic preserved exactly as before

document.addEventListener('DOMContentLoaded', () => {
  const goalInput = document.getElementById('goalInput');
  const sendBtn = document.getElementById('sendBtn');
  const chatContainer = document.getElementById('conversationArea');
  const emptyState = document.getElementById('emptyState');
  const newChatBtn = document.getElementById('newChatBtn');
  const statusHint = document.getElementById('statusHint');
  const panelHeader = document.getElementById('panelHeader');
  const trinetraPanel = document.getElementById('trinetraPanel');
  const envPill = document.getElementById('envPill');
  const envPillText = document.getElementById('envPillText');
  const stateDot = document.getElementById('stateDot');
  const stateText = document.getElementById('stateText');
  const confidenceBadge = document.getElementById('confidenceBadge');
  const closeBtn = document.getElementById('closeBtn');
  const minimizeBtn = document.getElementById('minimizeBtn');
  const settingsBtn = document.getElementById('settingsBtn');
  const scrollBottomBtn = document.getElementById('scrollBottomBtn');

  if (!goalInput || !sendBtn || !chatContainer) {
    console.error('[Trinetra] popup.js: required elements not found');
    return;
  }

  let messages = [];
  let running = false;
  let currentAssistantEl = null;
  let currentSteps = [];
  let agentBubbleEl = null;
  let agentTimelineEl = null;
  let currentState = 'ready';
  let currentCloudState = 'local';

  try {
    chrome.storage.local.get(['trinetraChatHistory', 'lastGoal'], (result) => {
      if (result.trinetraChatHistory && Array.isArray(result.trinetraChatHistory) && result.trinetraChatHistory.length > 0) {
        messages = result.trinetraChatHistory;
        renderAll();
      }
      if (result.lastGoal && !goalInput.value) goalInput.value = result.lastGoal;
    });
  } catch (e) {}

  function saveHistory() {
    try { chrome.storage.local.set({ trinetraChatHistory: messages.slice(-30) }); } catch (e) {}
  }

  async function updateModelBadge() {
    try {
      const res = await fetch('http://localhost:3001/health').then(r => r.json());
      if (res.gemini && res.gemini.configured) {
        if (statusHint) statusHint.textContent = 'Gemini ' + (res.gemini.model || 'gemini') + ' active';
      } else {
        if (statusHint) statusHint.textContent = 'Local stub (no Gemini key)';
      }
    } catch (e) {
      if (statusHint) statusHint.textContent = 'Server offline';
    }
  }
  updateModelBadge();
  setInterval(updateModelBadge, 10000);

  function escapeHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  function bgSend(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (res) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(res);
      });
    });
  }
  async function getAT() {
    const res = await bgSend({ type: 'TRINETRA_REQUEST_AT', options: { maxNodes: 2000 } });
    if (!res || !res.success) throw new Error(res?.error || 'AT extraction failed — reload the page (F5)');
    return res.at || [];
  }
  async function getScreenshot() {
    try {
      const res = await bgSend({ type: 'TRINETRA_CAPTURE_SCREENSHOT', options: { format: 'png', quality: 92 } });
      if (res && res.success && res.dataUrl) return res.dataUrl;
      return null;
    } catch (e) { return null; }
  }
  async function executePlanFn({ actions }) {
    const res = await bgSend({ type: 'TRINETRA_EXECUTE_PLAN_BG', plan: { actions } });
    if (!res || !res.success) throw new Error(res?.error || 'execute failed');
    return res.result;
  }
  async function sanitizeFn({ screenshot, at }) {
    return { sanitizedScreenshot: screenshot, sanitizedAT: at, report: { redacted_regions: [], sanitized_at_summary: 'passthrough (frontend sanitization in background)' } };
  }
  function getReasonFn() {
    const lr = (typeof window !== 'undefined' && window.TrinetraLocalReasoning) || (typeof self !== 'undefined' && self.TrinetraLocalReasoning) || null;
    if (lr && lr.reasonLocally) return lr.reasonLocally;
    const stub = (typeof window !== 'undefined' && window.TrinetraStubProvider) || null;
    if (stub && stub.StubLLMProvider) {
      return async ({ at, userGoal, screenshot, threshold }) => {
        const c = await stub.StubLLMProvider.plan({ at, userGoal });
        return { ...c, needs_escalation: c.confidence < (threshold ?? 2), actions: c.actions, plan: c.plan, threshold };
      };
    }
    throw new Error('No reasoning provider available');
  }

  // ========== DRAG FUNCTIONALITY ==========
  let isDragging = false;
  let dragStartX = 0, dragStartY = 0, panelStartX = 0, panelStartY = 0;

  panelHeader.addEventListener('mousedown', (e) => {
    if (e.target.closest('.header-actions') || e.target.closest('.env-pill')) return;
    isDragging = true;
    panelHeader.classList.add('dragging');
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    const rect = trinetraPanel.getBoundingClientRect();
    panelStartX = rect.left;
    panelStartY = rect.top;
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;
    const newX = Math.max(0, Math.min(window.innerWidth - trinetraPanel.offsetWidth, panelStartX + dx));
    const newY = Math.max(0, Math.min(window.innerHeight - trinetraPanel.offsetHeight, panelStartY + dy));
    trinetraPanel.style.position = 'fixed';
    trinetraPanel.style.left = newX + 'px';
    trinetraPanel.style.top = newY + 'px';
    trinetraPanel.style.right = 'auto';
    trinetraPanel.style.bottom = 'auto';
  });

  document.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      panelHeader.classList.remove('dragging');
    }
  });

  // ========== STATE MANAGEMENT ==========
  const STATE_LABELS = {
    ready: 'Ready', thinking: 'Thinking...', observing: 'Observing page',
    executing: 'Executing', cloud: 'Consulting cloud', completed: 'Completed',
    error: 'Error'
  };

  function setAgentState(state, cloudState) {
    currentState = state;
    if (cloudState) currentCloudState = cloudState;
    if (stateDot) {
      stateDot.className = 'state-dot ' + state;
    }
    if (stateText) {
      stateText.textContent = STATE_LABELS[state] || state;
    }
    if (envPill && envPillText) {
      envPill.className = 'env-pill';
      if (currentCloudState === 'cloud') {
        envPill.classList.add('cloud-assist');
        envPillText.textContent = 'CLOUD';
      } else if (currentCloudState === 'cloud-result') {
        envPill.classList.add('cloud-result');
        envPillText.textContent = 'LOCAL';
      } else {
        envPillText.textContent = 'LOCAL';
      }
    }
  }

  function setConfidence(pct) {
    if (confidenceBadge) {
      confidenceBadge.style.display = 'block';
      confidenceBadge.textContent = Math.round(pct * 100) + '% conf';
    }
  }
  function hideConfidence() {
    if (confidenceBadge) confidenceBadge.style.display = 'none';
  }

  // ========== EVENT MAPPING ==========
  const EVENT_MAP = {
    'observe': { title: 'Observing page', subtitle: 'Scanning DOM for accessibility tree', icon: '👁', badge: 'active', detailKey: 'atCount', detailFn: (s) => s.atCount ? `${s.atCount} nodes detected` : '' },
    'observed': { title: 'Page structure analyzed', subtitle: 'Accessibility tree captured', icon: '✓', badge: 'done', detailKey: 'atCount', detailFn: (s) => s.atCount ? `${s.atCount} elements indexed` : '' },
    'reason': { title: 'Understanding request', subtitle: 'Analyzing goal against page context', icon: '🧠', badge: 'active' },
    'reasoned': { title: 'Action confidence evaluated', subtitle: (s) => `Confidence: ${Math.round((s.confidence||0)*100)}%`, icon: '✓', badge: 'done', detailKey: 'confidence', detailFn: (s) => `Confidence: ${((s.confidence||0)*100).toFixed(0)}% — ${s.needs_escalation ? 'Escalation needed' : 'Local execution'}` },
    'sanitize': { title: 'Protecting sensitive information', subtitle: 'Running local sanitization pipeline', icon: '🔒', badge: 'active' },
    'sanitized': { title: 'Data sanitized', subtitle: 'Sensitive data redacted before cloud', icon: '✓', badge: 'done' },
    'cloud_call': { title: 'Consulting cloud agent', subtitle: 'Sending sanitized payload for deeper reasoning', icon: '☁', badge: 'cloud' },
    'cloud_result': { title: 'Cloud response received', subtitle: 'Action plan returned from cloud', icon: '✓', badge: 'done' },
    'execute': { title: 'Executing action', subtitle: (s) => (s.actions||[]).map(a=>a.type).join(', ') || 'Running plan', icon: '⚡', badge: 'active' },
    'executed': { title: 'Action executed', subtitle: 'Step completed successfully', icon: '✓', badge: 'done' },
    'evaluate': { title: 'Evaluating progress', subtitle: (s) => s.achieved ? 'Goal achieved!' : 'Continuing analysis', icon: '◌', badge: 'pending' },
    'vlm_flag': { title: 'Visual analysis needed', subtitle: 'Flagged for visual fallback processing', icon: '📷', badge: 'active' },
    'cloud_error': { title: 'Cloud error', subtitle: (s) => s.error || 'Cloud service unavailable', icon: '⚠', badge: 'pending' },
    'local_fallback': { title: 'Falling back to local', subtitle: (s) => `Cloud failed: ${s.reason || 'unavailable'} — using local actions`, icon: '⚡', badge: 'active' },
    'auth_required': { title: 'Login required', subtitle: (s) => s.reason || 'Page requires authentication — cannot proceed', icon: '🔒', badge: 'pending' },
    'execute_error': { title: 'Execution error', subtitle: (s) => s.error || 'Action failed', icon: '⚠', badge: 'pending' },
    'no_actions': { title: 'No actions needed', subtitle: 'Current state requires no further action', icon: '○', badge: 'pending' },
    'would_escalate': { title: 'Escalating to cloud', subtitle: 'Confidence below threshold — routing to cloud', icon: '☁', badge: 'cloud' }
  };

  // ========== RENDERING ==========
  function renderAll() {
    while (chatContainer.firstChild) chatContainer.removeChild(chatContainer.firstChild);
    if (messages.length === 0) {
      emptyState.style.display = 'flex';
      chatContainer.appendChild(emptyState);
      return;
    }
    emptyState.style.display = 'none';
    messages.forEach(m => {
      const el = createMessageEl(m.role, m.content, m.steps, m.timestamp, m);
      chatContainer.appendChild(el);
    });
    if (running && currentAssistantEl) {
      chatContainer.appendChild(currentAssistantEl);
    }
    chatContainer.scrollTop = chatContainer.scrollHeight;
    updateScrollBtn();
  }

  function createMessageEl(role, content, steps, timestamp, msgObj) {
    const wrap = document.createElement('div');
    wrap.className = `message ${role}`;
    if (role === 'user') {
      const bubble = document.createElement('div');
      bubble.className = 'user-bubble';
      const parts = content.split('\n');
      bubble.innerHTML = parts.map((p, i) => {
        if (i === 0) return `<span class="query-highlight">${escapeHtml(p)}</span>`;
        return escapeHtml(p);
      }).join('<br>');
      wrap.appendChild(bubble);
    } else if (role === 'assistant') {
      if (msgObj && msgObj.isResult) {
        const card = document.createElement('div');
        card.className = msgObj.resultSuccess ? 'result-card' : 'result-card error-card';
        const header = document.createElement('div');
        header.className = 'result-card-header';
        const check = document.createElement('span');
        check.className = 'result-check';
        check.textContent = msgObj.resultSuccess ? '\u2713' : '\u2717';
        const title = document.createElement('span');
        title.className = 'result-title';
        title.textContent = msgObj.resultSuccess ? 'Task completed' : 'Task failed';
        header.appendChild(check);
        header.appendChild(title);
        const body = document.createElement('div');
        body.className = 'result-body';
        body.textContent = content;
        card.appendChild(header);
        card.appendChild(body);
        if (steps && steps.length > 0) {
          card.appendChild(createTimelineEl(steps));
        }
        wrap.appendChild(card);
      } else {
        const msg = document.createElement('div');
        msg.className = 'agent-message';
        const headerRow = document.createElement('div');
        headerRow.className = 'agent-header-row';
        const avatar = document.createElement('div');
        avatar.className = 'agent-avatar';
        avatar.textContent = 'T';
        const label = document.createElement('span');
        label.className = 'agent-label';
        label.textContent = 'Trinetra';
        headerRow.appendChild(avatar);
        headerRow.appendChild(label);
        const bubble = document.createElement('div');
        bubble.className = 'agent-bubble';
        bubble.textContent = content;
        msg.appendChild(headerRow);
        msg.appendChild(bubble);
        if (steps && steps.length > 0) {
          const timeline = createTimelineEl(steps);
          msg.appendChild(timeline);
        }
        wrap.appendChild(msg);
      }
    } else {
      const bubble = document.createElement('div');
      bubble.className = 'agent-bubble';
      bubble.style.borderColor = 'rgba(245, 158, 11, 0.2)';
      bubble.style.background = 'rgba(245, 158, 11, 0.05)';
      bubble.textContent = content;
      wrap.appendChild(bubble);
    }
    return wrap;
  }

  // ========== AGENT ACTIVITY TIMELINE ==========
  function createTimelineEl(steps) {
    const container = document.createElement('div');
    container.className = 'timeline';
    steps.forEach((step, idx) => {
      const item = createTimelineItem(step, idx, steps.length);
      container.appendChild(item);
    });
    return container;
  }

  function createTimelineItem(step, idx, totalSteps) {
    const mapping = EVENT_MAP[step.step] || { title: step.step, subtitle: '', icon: '•', badge: 'pending' };
    const item = document.createElement('div');
    item.className = 'timeline-item completed';
    item.dataset.step = step.step;

    const isActive = idx === totalSteps - 1 && running;
    if (isActive) item.classList.add('active');

    const track = document.createElement('div');
    track.className = 'timeline-track';

    const dotWrapper = document.createElement('div');
    dotWrapper.className = 'timeline-dot-wrapper';

    const dot = document.createElement('div');
    dot.className = `timeline-dot ${mapping.badge}`;
    if (isActive) dot.classList.add('active');
    dotWrapper.appendChild(dot);

    if (idx < totalSteps - 1) {
      const connector = document.createElement('div');
      connector.className = `timeline-connector ${mapping.badge === 'done' || mapping.badge === 'cloud' ? 'done' : ''}`;
      track.appendChild(dotWrapper);
      track.appendChild(connector);
    } else {
      track.appendChild(dotWrapper);
    }

    const content = document.createElement('div');
    content.className = 'timeline-content';

    const main = document.createElement('div');
    main.className = 'timeline-main';
    const icon = document.createElement('span');
    icon.className = 'timeline-icon';
    icon.textContent = mapping.icon;
    const title = document.createElement('span');
    title.className = 'timeline-title';
    title.textContent = mapping.title;
    main.appendChild(icon);
    main.appendChild(title);

    const badge = document.createElement('span');
    badge.className = `timeline-status-badge ${mapping.badge}`;
    badge.textContent = isActive ? '◌' : mapping.badge === 'done' ? '✓' : mapping.badge === 'cloud' ? '☁' : '…';

    content.appendChild(main);
    content.appendChild(badge);

    // Subtitle
    const subtitle = document.createElement('div');
    subtitle.className = 'timeline-subtitle';
    subtitle.textContent = typeof mapping.subtitle === 'function' ? mapping.subtitle(step) : mapping.subtitle;
    content.appendChild(subtitle);

    // Details
    const details = document.createElement('div');
    details.className = 'timeline-details';
    const detailText = buildDetailText(step);
    if (detailText) {
      details.textContent = detailText;
    } else {
      details.style.display = 'none';
    }
    content.appendChild(details);

    // Expand hint
    const hint = document.createElement('div');
    hint.className = 'timeline-expand-hint';
    hint.textContent = 'Click for details';
    content.appendChild(hint);

    // Click to expand
    item.addEventListener('click', () => {
      item.classList.toggle('expanded');
    });

    item.appendChild(track);
    item.appendChild(content);
    return item;
  }

  function buildDetailText(step) {
    const parts = [];
    if (step.atCount) parts.push(`${step.atCount} nodes analyzed`);
    if (step.confidence != null) parts.push(`Confidence: ${((step.confidence||0)*100).toFixed(0)}%`);
    if (step.needs_escalation != null) parts.push(step.needs_escalation ? 'Escalation triggered' : 'Local execution');
    if (step.actions && step.actions.length) parts.push(`Actions: ${step.actions.map(a=>a.type).join(', ')}`);
    if (step.vlm_reason) parts.push(`VLM flag: ${step.vlm_reason}`);
    if (step.error) parts.push(`Error: ${step.error}`);
    if (step.execResult && !step.execResult.success) parts.push(`Execution: failed`);
    if (step.achieved != null) parts.push(step.achieved ? 'Goal achieved!' : 'Goal not yet achieved');
    if (step.cloudResult) parts.push('Cloud response received');
    if (step.report && step.report.sanitized_at_summary) parts.push(step.report.sanitized_at_summary);
    return parts.length > 0 ? parts.join(' • ') : '';
  }

  // ========== PROGRESSIVE RENDERING ==========
  function addUserMessage(text) {
    const msg = { role: 'user', content: text, timestamp: new Date().toISOString(), steps: [] };
    messages.push(msg);
    saveHistory();
    renderAll();
  }

  function startAssistantMessage() {
    currentSteps = [];
    const wrap = document.createElement('div');
    wrap.className = 'agent-message';
    const headerRow = document.createElement('div');
    headerRow.className = 'agent-header-row';
    const avatar = document.createElement('div');
    avatar.className = 'agent-avatar';
    avatar.textContent = 'T';
    const label = document.createElement('span');
    label.className = 'agent-label';
    label.textContent = 'Trinetra';
    headerRow.appendChild(avatar);
    headerRow.appendChild(label);
    const bubble = document.createElement('div');
    bubble.className = 'agent-bubble';
    bubble.textContent = 'Thinking...';
    wrap.appendChild(headerRow);
    wrap.appendChild(bubble);
    const timeline = document.createElement('div');
    timeline.className = 'timeline';
    wrap.appendChild(timeline);
    chatContainer.appendChild(wrap);
    chatContainer.scrollTop = chatContainer.scrollHeight;
    emptyState.style.display = 'none';
    currentAssistantEl = wrap;
    agentBubbleEl = bubble;
    agentTimelineEl = timeline;
    return { bubble, wrap };
  }

  function onStep(payload) {
    const stepObj = { ...payload, ts: Date.now() };
    currentSteps.push(stepObj);
    updateTimeline(stepObj);
  }

  function updateTimeline(newStep) {
    // Mark previous last active as done
    const prevItems = agentTimelineEl ? agentTimelineEl.querySelectorAll('.timeline-item') : [];
    if (prevItems.length > 0) {
      const lastItem = prevItems[prevItems.length - 1];
      lastItem.classList.remove('active');
      lastItem.classList.add('completed');
      const dot = lastItem.querySelector('.timeline-dot');
      if (dot) { dot.className = 'timeline-dot done'; }
      const badge = lastItem.querySelector('.timeline-status-badge');
      if (badge) { badge.textContent = '✓'; badge.className = 'timeline-status-badge done'; }
    }

    // Add new item
    const item = createTimelineItem(newStep, currentSteps.length - 1, currentSteps.length);
    if (agentTimelineEl) {
      agentTimelineEl.appendChild(item);
      // Scroll to show new item
      agentTimelineEl.scrollTop = agentTimelineEl.scrollHeight;
    }
    chatContainer.scrollTop = chatContainer.scrollHeight;
  }

  function finalizeAssistantMessage(finalText, steps) {
    const isError = /error|failed|couldn't|unable|stopped/i.test(finalText);
    const isSuccess = /task completed|done|finished|achieved/i.test(finalText) || !isError;
    const msg = {
      role: 'assistant',
      content: finalText,
      steps: [...steps],
      timestamp: new Date().toISOString(),
      isResult: true,
      resultSuccess: isSuccess
    };
    messages.push(msg);
    saveHistory();
    renderAll();
    currentAssistantEl = null;
    currentSteps = [];
    agentBubbleEl = null;
    agentTimelineEl = null;
  }

  // ========== AUTO-GROW TEXTAREA ==========
  goalInput.addEventListener('input', () => {
    goalInput.style.height = 'auto';
    goalInput.style.height = Math.min(goalInput.scrollHeight, 80) + 'px';
  });
  goalInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!running) handleSend();
    }
  });

  // Suggestions
  document.querySelectorAll('.suggestion').forEach(el => {
    el.addEventListener('click', () => {
      goalInput.value = el.getAttribute('data-goal') || el.textContent;
      goalInput.focus();
      goalInput.dispatchEvent(new Event('input'));
    });
  });

  newChatBtn.addEventListener('click', () => {
    if (running) return;
    messages = [];
    saveHistory();
    renderAll();
    goalInput.value = '';
    goalInput.focus();
  });

  minimizeBtn.addEventListener('click', () => {
    trinetraPanel.classList.toggle('minimized');
  });

  closeBtn.addEventListener('click', () => {
    try { window.close(); } catch (e) {}
  });

  settingsBtn.addEventListener('click', () => {
    console.log('[Trinetra] Settings clicked');
  });

  scrollBottomBtn.addEventListener('click', () => {
    chatContainer.scrollTo({ top: chatContainer.scrollHeight, behavior: 'smooth' });
  });

  chatContainer.addEventListener('scroll', () => {
    updateScrollBtn();
  });

  function updateScrollBtn() {
    const atBottom = chatContainer.scrollHeight - chatContainer.scrollTop - chatContainer.clientHeight < 20;
    if (scrollBottomBtn) {
      scrollBottomBtn.classList.toggle('visible', !atBottom);
    }
  }

  async function handleSend() {
    const goal = goalInput.value.trim();
    if (!goal || running) return;
    console.log('[Trinetra] User Goal:', goal);
    try { chrome.storage.local.set({ lastGoal: goal }); } catch (e) {}

    const loop = (typeof window !== 'undefined' && window.TrinetraWorkflowLoop) || (typeof self !== 'undefined' && self.TrinetraWorkflowLoop) || null;
    if (!loop || !loop.runFullLoop) {
      messages.push({ role: 'assistant', content: 'Workflow engine not loaded — reload extension.', timestamp: new Date().toISOString(), steps: [] });
      saveHistory();
      renderAll();
      return;
    }

    addUserMessage(goal);
    goalInput.value = '';
    goalInput.style.height = 'auto';

    running = true;
    sendBtn.textContent = '■';
    sendBtn.classList.add('stop-btn');
    sendBtn.title = 'Stop';
    setAgentState('thinking');

    const assistantRef = startAssistantMessage();

    const onStep = (payload) => {
      const stepObj = { ...payload, ts: Date.now() };
      currentSteps.push(stepObj);

      // Update state based on step
      if (payload.step === 'observe' || payload.step === 'observed') {
        setAgentState('observing');
      } else if (payload.step === 'reason' || payload.step === 'reasoned') {
        setAgentState('thinking');
        if (payload.confidence != null) setConfidence(payload.confidence);
      } else if (payload.step === 'cloud_call') {
        setAgentState('cloud', 'cloud');
      } else if (payload.step === 'cloud_result') {
        setAgentState('thinking', 'cloud-result');
      } else if (payload.step === 'execute' || payload.step === 'executed') {
        setAgentState('executing');
      } else if (payload.step === 'evaluate' && payload.achieved) {
        setAgentState('completed');
      } else if (payload.step === 'sanitize') {
        setAgentState('observing');
      }

      updateTimeline(stepObj);
      console.log('[Trinetra]', payload.step, payload);
    };

    try {
      const result = await loop.runFullLoop({
        userGoal: goal,
        getAT,
        getScreenshot,
        executePlanFn,
        reasonFn: getReasonFn(),
        sanitizeFn,
        serverUrl: 'http://localhost:3001/api/agent/act',
        onStep,
        maxIterations: 6,
        threshold: 2,
        reloadPageFn: async () => {
          try { await bgSend({ type: 'TRINETRA_RELOAD_TAB' }); } catch (e) {}
        },
      });
      console.log('[Trinetra] Loop result', result);
      let finalText = '';
      hideConfidence();
      if (result.success) {
        setAgentState('completed');
        if (currentCloudState === 'cloud') setAgentState('completed', 'cloud-result');
        finalText = `Task completed after ${result.iteration} iteration${result.iteration > 1 ? 's' : ''}.\n\n${result.reason}`;
        if (result.history && result.history.some(h => h.reasoning?.needs_vlm)) finalText += '\n\n[Note] VLM_REQUIRED was flagged on some steps.';
      } else {
        setAgentState('error');
        const lastVlm = result.history?.slice(-1)[0]?.reasoning?.vlm_reason;
        finalText = `Stopped after ${result.iteration} iteration${result.iteration > 1 ? 's' : ''}: ${result.reason}` + (lastVlm ? `\nVLM flag: ${lastVlm}` : '');
      }
      finalizeAssistantMessage(finalText, currentSteps);
    } catch (err) {
      console.error('[Trinetra] loop error', err);
      setAgentState('error');
      hideConfidence();
      finalizeAssistantMessage(`Error: ${err.message}\n\nTry: 1) Reload the page (F5) 2) Ensure server on http://localhost:3001/health shows Gemini active.`, currentSteps);
    } finally {
      running = false;
      sendBtn.textContent = '↑';
      sendBtn.classList.remove('stop-btn');
      sendBtn.title = 'Send';
      setAgentState('ready');
      hideConfidence();
      goalInput.focus();
    }
  }

  sendBtn.addEventListener('click', () => {
    if (running) return;
    handleSend();
  });

  renderAll();
});
