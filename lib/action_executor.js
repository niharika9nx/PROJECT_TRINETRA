// Trinetra — Action Executor (Phase 6)
// Executes Action Plans from Section 2.3.
// Allowed (auto): scroll, click, navigate, read/observe
// Restricted (approval required): type/fill, submit/confirm, payments/sensitive_ops

const ALLOWED_ACTIONS = new Set(['scroll', 'click', 'navigate', 'read', 'observe']);
const RESTRICTED_ACTIONS = new Set(['type', 'fill', 'submit', 'confirm', 'payment', 'payments', 'sensitive_ops']);

function isRestricted(actionType) {
  return RESTRICTED_ACTIONS.has((actionType || '').toLowerCase());
}

function isAllowed(actionType) {
  return ALLOWED_ACTIONS.has((actionType || '').toLowerCase());
}

// Resolve target element by mode: at_node_id | bbox | css_selector
function resolveTarget(target) {
  if (!target) return null;
  const mode = (target.mode || '').toLowerCase();
  const value = target.value;

  if (mode === 'at_node_id') {
    // content_script sets data-trinetra-id on each node
    return document.querySelector(`[data-trinetra-id="${CSS.escape(value)}"]`);
  }
  if (mode === 'css_selector') {
    try { return document.querySelector(value); } catch (e) { return null; }
  }
  if (mode === 'bbox') {
    // value is [x,y,width,height] or "x,y,width,height" — find element at center point
    let bbox = value;
    if (typeof value === 'string') bbox = value.split(',').map(Number);
    if (Array.isArray(bbox) && bbox.length >= 4) {
      const cx = bbox[0] + bbox[2] / 2;
      const cy = bbox[1] + bbox[3] / 2;
      return document.elementFromPoint(cx, cy);
    }
  }
  return null;
}

async function executeScroll(action) {
  const amount = action.params?.amount ?? action.amount ?? 300;
  const target = resolveTarget(action.target);
  if (target && target.scrollBy) {
    target.scrollBy({ top: amount, behavior: 'smooth' });
  } else {
    window.scrollBy({ top: amount, behavior: 'smooth' });
  }
  await new Promise(r => setTimeout(r, 400));
  return { success: true, type: 'scroll', amount };
}

async function executeClick(action) {
  let el = resolveTarget(action.target);
  if (!el && action.target?.mode === 'bbox') {
    // bbox already handled
  }
  if (!el) {
    // fallback: try selector if provided
    if (action.target?.value) {
      try { el = document.querySelector(action.target.value); } catch (e) {}
    }
  }
  if (!el) return { success: false, error: 'click target not found', action };
  try {
    const href = el.getAttribute && el.getAttribute('href');
    if (href && href.trim().toLowerCase().startsWith('javascript:')) {
      console.warn('[Trinetra] click blocked javascript: href', href.slice(0,60));
      el.removeAttribute('href');
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      await new Promise(r=>setTimeout(r,300));
      return { success: true, type: 'click', target: action.target, blocked_javascript_href:true };
    }
  } catch(e){}
  el.click();
  await new Promise(r => setTimeout(r, 300));
  return { success: true, type: 'click', target: action.target };
}

async function executeNavigate(action) {
  const url = action.params?.url || action.target?.value;
  if (!url) return { success: false, error: 'navigate missing url' };
  if (typeof url === 'string' && url.trim().toLowerCase().startsWith('javascript:')) {
    return { success: false, error: 'navigate blocked: javascript: URL violates CSP' };
  }
  if (typeof url === 'string' && !url.startsWith('http') && !url.startsWith('/') && !url.startsWith('#')) {
    return { success: false, error: 'navigate blocked: only http(s) URLs allowed' };
  }
  // Prefer background navigation to avoid CSP inline issues in content script
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      const res = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'TRINETRA_NAVIGATE', url }, (r) => resolve(r));
      });
      if (res && res.success) return { success: true, type: 'navigate', url, via: 'background' };
      // fallback to direct if background fails
      if (res && res.error) return { success: false, error: res.error };
    }
  } catch (e) {}
  window.location.href = url;
  return { success: true, type: 'navigate', url, via: 'content' };
}

async function executeRead(action) {
  // read/observe captures new state (AT + screenshot) — here we just re-extract AT
  // Screenshot is captured via background message in full loop; here we return AT
  let at = [];
  try {
    if (typeof window.TrinetraATExtractor !== 'undefined' && window.TrinetraATExtractor.extractAccessibilityTree) {
      at = window.TrinetraATExtractor.extractAccessibilityTree();
    } else if (typeof extractAccessibilityTree === 'function') {
      at = extractAccessibilityTree();
    }
  } catch (e) {
    // fallback empty
  }
  return { success: true, type: 'read', at, count: at.length };
}

async function executeType(action) {
  const el = resolveTarget(action.target);
  if (!el) return { success: false, error: 'type target not found' };
  const text = action.params?.text ?? action.params?.value ?? '';
  el.focus();
  // For input/textarea, set value and dispatch events
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) {
    el.value = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    // fallback: try to type via value property
    try { el.value = text; } catch (e) {}
  }
  await new Promise(r => setTimeout(r, 200));
  return { success: true, type: 'type', target: action.target, textLength: text.length };
}

async function executeSubmit(action) {
  let el = resolveTarget(action.target);
  if (!el) {
    // find nearest form
    el = document.querySelector('form');
  }
  if (!el) return { success: false, error: 'submit target not found' };
  if (el.tagName === 'FORM') {
    el.submit();
  } else {
    el.click();
  }
  await new Promise(r => setTimeout(r, 300));
  return { success: true, type: 'submit' };
}

// Approval modal wiring — delegates to content_script modal if available
function requestApproval(action, approvalHandler) {
  // If a custom handler is provided (tests), use it
  if (typeof approvalHandler === 'function') {
    return approvalHandler(action);
  }
  // If global modal exists (content_script.js injects showApprovalModal), use it
  if (typeof window !== 'undefined' && typeof window.TrinetraShowApprovalModal === 'function') {
    return window.TrinetraShowApprovalModal(action);
  }
  if (typeof self !== 'undefined' && typeof self.TrinetraShowApprovalModal === 'function') {
    return self.TrinetraShowApprovalModal(action);
  }
  // Fallback: auto-deny for safety in non-UI contexts
  return Promise.resolve(false);
}

// Single action dispatcher — checks approval gate for restricted actions
async function executeAction(action, options = {}) {
  const type = (action.type || '').toLowerCase();
  const requiresApproval = action.requires_approval === true || isRestricted(type);

  if (requiresApproval) {
    const approved = await requestApproval(action, options.approvalHandler);
    if (!approved) {
      return { success: false, type, denied: true, reason: 'User denied approval for restricted action' };
    }
  }

  switch (type) {
    case 'scroll': return executeScroll(action);
    case 'click': return executeClick(action);
    case 'navigate': return executeNavigate(action);
    case 'read':
    case 'observe': return executeRead(action);
    case 'type':
    case 'fill': return executeType(action);
    case 'submit':
    case 'confirm':
    case 'payment':
    case 'payments':
    case 'sensitive_ops': return executeSubmit(action);
    default: return { success: false, error: `Unknown action type: ${type}` };
  }
}

// Execute full plan (array of actions) sequentially
async function executePlan(plan, options = {}) {
  const actions = plan.actions || plan.plan || [];
  const results = [];
  for (const action of actions) {
    const result = await executeAction(action, options);
    results.push({ action, result });
    // If a restricted action was denied, stop and signal replanning needed
    if (result.denied) {
      return { success: false, denied: true, results, message: 'Plan paused — approval denied, needs replanning' };
    }
    if (!result.success && action.type !== 'read') {
      // continue but log — read failures are non-fatal, others may need handling
    }
    // Small delay between actions
    await new Promise(r => setTimeout(r, 200));
  }
  return { success: true, results };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    executeAction, executePlan, executeScroll, executeClick, executeNavigate, executeRead, executeType, executeSubmit,
    isRestricted, isAllowed, resolveTarget, ALLOWED_ACTIONS, RESTRICTED_ACTIONS, requestApproval
  };
}
if (typeof window !== 'undefined') {
  window.TrinetraActionExecutor = {
    executeAction, executePlan, isRestricted, isAllowed, requestApproval
  };
}
if (typeof self !== 'undefined') {
  self.TrinetraActionExecutor = {
    executeAction, executePlan, isRestricted, isAllowed, requestApproval
  };
}
