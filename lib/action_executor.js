// Trinetra — Action Executor (Phase 6)
// Executes Action Plans from Section 2.3.
// Allowed (auto): scroll, click, navigate, read/observe
// Restricted (approval required): type/fill, submit/confirm, payments/sensitive_ops

(function () {

const ALLOWED_ACTIONS = new Set(['scroll', 'click', 'navigate', 'read', 'observe']);
const RESTRICTED_ACTIONS = new Set(['type', 'fill', 'submit', 'confirm', 'payment', 'payments', 'sensitive_ops']);

function isRestricted(actionType) {
  return RESTRICTED_ACTIONS.has((actionType || '').toLowerCase());
}

function isAllowed(actionType) {
  return ALLOWED_ACTIONS.has((actionType || '').toLowerCase());
}

// Resolve target element by mode: at_node_id | bbox | css_selector | semantic
function resolveSemanticTarget(at, actionType, description) {
  if (!at || !description) return null;
  const desc = (description || '').toLowerCase();

  // Search boxes — across all ecommerce sites
  if (desc.includes('search')) {
    return at.find(n =>
      n.role === 'searchbox' ||
      n.role === 'combobox' ||
      /search/i.test(n.name)
    );
  }

  // Submit buttons / "go" buttons
  if (desc.includes('submit') || desc.includes('button')) {
    return at.find(n =>
      (n.role === 'button' || n.tag === 'button') &&
      /submit|search|go|ok|continue|verify/i.test(n.name)
    );
  }

  // Price elements
  if (desc.includes('price') || /price|₹|rs|\d{2,}/i.test(desc)) {
    return at.find(n => /₹|rs\.?|price|\d{2,}/i.test(n.name || ''));
  }

  // Cart / open cart: prefer real cart LINK (nav), not generic button / add-to-cart
  if (desc.includes('cart')) {
    return (
      at.find(n => /\bcart\b/i.test(n.name || '') && (n.role === 'link' || n.tag === 'a')) ||
      at.find(n => /\bcart\b/i.test(n.name || '') && (n.role === 'button' || n.tag === 'button')) ||
      at.find(n => /cart/i.test(n.name || ''))
    );
  }
  if (desc.includes('add') || desc.includes('buy')) {
    return at.find(n =>
      /cart|add|buy|purchase/i.test(n.name || '') &&
      (n.role === 'button' || n.tag === 'button' || n.tag === 'a')
    );
  }

  // Form fields by type
  if (desc.includes('name') && !desc.includes('last') && !desc.includes('first')) {
    return at.find(n =>
      n.tag === 'input' && n.type === 'text' && /name/i.test(n.name)
    );
  }
  if (desc.includes('email')) {
    return at.find(n =>
      (n.tag === 'input' || n.role === 'textbox') && /email|e-mail/i.test(n.name)
    );
  }
  if (desc.includes('password')) {
    return at.find(n =>
      /password/i.test(n.name) && (n.tag === 'input' || n.role === 'textbox')
    );
  }
  if (desc.includes('phone') || desc.includes('mobile')) {
    return at.find(n =>
      /phone|mobile|cell/i.test(n.name) && (n.tag === 'input' || n.role === 'textbox')
    );
  }

  // Generic: match by name
  return at.find(n => (n.name || '').toLowerCase().includes(desc));
}

function resolveTarget(target, at) {
  if (!target) return null;
  const mode = (target.mode || '').toLowerCase();
  const value = target.value;

  if (mode === 'at_node_id') {
    // content_script sets data-trinetra-id on each node
    return document.querySelector(`[data-trinetra-id="${CSS.escape(value)}"]`);
  }
    if (mode === 'semantic') {
    // Resolve semantic target using AT; pass null for actionType
    const element = resolveSemanticTarget(at, null, value);
    if (element && typeof document !== 'undefined') {
      const el = document.querySelector(`[data-trinetra-id="${element.id}"]`);
      if (el) return el;
    }
    if (typeof document !== 'undefined') {
      const desc = (value || '').toLowerCase();
      if (desc.includes('search')) {
        return document.querySelector('#twotabsearchtextbox, input[name="field-keywords"], [role="searchbox"], input[type="search"]');
      }
      if (desc.includes('submit') || desc.includes('button')) {
        return document.querySelector('#nav-search-submit-button, input[type="submit"], button[type="submit"]');
      }
      if (desc.includes('cart')) {
        return document.querySelector('#nav-cart') ||
          document.querySelector('a[href*="/cart"]') ||
          Array.from(document.querySelectorAll('a, [role="link"], button, [role="button"]')).find(el =>
            /\bcart\b/i.test((el.getAttribute('aria-label') || '') + ' ' + (el.textContent || ''))
          );
      }
    }
    return null;
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

async function executeScroll(action, options = {}) {
  const amount = action.params?.amount ?? action.amount ?? 300;
  const target = resolveTarget(action.target, options.at);
  if (target && target.scrollBy) {
    target.scrollBy({ top: amount, behavior: 'smooth' });
  } else {
    window.scrollBy({ top: amount, behavior: 'smooth' });
  }
  await new Promise(r => setTimeout(r, 200));
  return { success: true, type: 'scroll', amount };
}

async function executeClick(action, options = {}) {
  let el = resolveTarget(action.target, options.at);
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
      await new Promise(r=>setTimeout(r,100));
      return { success: true, type: 'click', target: action.target, blocked_javascript_href:true };
    }
  } catch(e){}
  el.click();
  await new Promise(r => setTimeout(r, 100));
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

async function executeType(action, options = {}) {
  const at = options.at;
  const el = at ? resolveTarget(action.target, at) : resolveTarget(action.target);
  if (!el) return { success: false, error: 'type target not found' };
  const text = action.params?.text ?? action.params?.value ?? '';
  el.focus();
  try {
    const proto = Object.getPrototypeOf(el);
    const valueSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set ||
                        (typeof window !== 'undefined' && Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set);
    if (valueSetter) {
      valueSetter.call(el, text);
    } else {
      el.value = text;
    }
  } catch (e) {
    el.value = text;
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 50));
  return { success: true, type: 'type', target: action.target, textLength: text.length };
}

async function executeSubmit(action, options = {}) {
  const at = options.at;
  let el = at ? resolveTarget(action.target, at) : resolveTarget(action.target);
  if (!el && typeof document !== 'undefined') {
    el = document.querySelector('#nav-search-submit-button, input[id*="search-submit"], input[type="submit"]') ||
         document.querySelector('form');
  }
  if (!el) return { success: false, error: 'submit target not found' };
  if (el.tagName === 'FORM') {
    el.submit();
  } else if (el.tagName === 'INPUT' && (el.type === 'text' || el.type === 'search')) {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    const form = el.closest('form');
    const submitBtn = form?.querySelector('#nav-search-submit-button, input[type="submit"], button[type="submit"]');
    if (submitBtn) submitBtn.click();
    else if (form) form.submit();
  } else {
    el.click();
  }
  await new Promise(r => setTimeout(r, 150));
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

// Single source of truth for the approval policy, so the per-action dispatcher
// and the plan-level batch prompt can never disagree.
function actionNeedsApproval(action) {
  const type = (action && action.type || '').toLowerCase();
  const isSensitive = isRestricted(type) ||
                      (action.params && /password|credit|card|cvv|otp|pin|ssn/i.test(JSON.stringify(action.params)));
  return action.requires_approval === true ? true : isSensitive;
}

// Single action dispatcher — checks approval gate for restricted actions
async function executeAction(action, options = {}) {
  const type = (action.type || '').toLowerCase();

  if (actionNeedsApproval(action) && !options.skipApproval) {
    const approved = await requestApproval(action, options.approvalHandler);
    if (!approved) {
      return { success: false, type, denied: true, reason: 'User denied approval for restricted action' };
    }
  }

  switch (type) {
    case 'scroll': return executeScroll(action, options);
    case 'click': return executeClick(action, options);
    case 'navigate': return executeNavigate(action);
    case 'read':
    case 'observe': return executeRead(action);
    case 'type':
    case 'fill': return executeType(action, options);
    case 'submit':
    case 'confirm':
    case 'payment':
    case 'payments':
    case 'sensitive_ops': return executeSubmit(action, options);
    default: return { success: false, error: `Unknown action type: ${type}` };
  }
}

// Execute full plan (array of actions) sequentially.
//
// Restricted actions are gated once per plan rather than once per action: when
// the first gated action is reached, every restricted action remaining in the
// plan is presented in a single approval request. Gate strength is unchanged —
// all of them must be approved before any runs — but a search plan costs one
// prompt instead of two.
async function executePlan(plan, options = {}) {
  const actions = plan.actions || plan.plan || [];
  const results = [];
  let failedCount = 0;
  let executedCount = 0;
  let planApproved = false;

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    if (actionNeedsApproval(action) && !planApproved) {
      const gated = actions.slice(i).filter(actionNeedsApproval);
      const approved = await requestApproval(
        { type: 'plan', plan_actions: gated, actions: gated, params: {} },
        options.approvalHandler
      );
      if (!approved) {
        results.push({ action, result: { success: false, denied: true, reason: 'User denied the plan' } });
        return { success: false, denied: true, results, message: 'Plan paused — approval denied, needs replanning' };
      }
      planApproved = true;
    }
    const result = await executeAction(action, { ...options, skipApproval: true });
    results.push({ action, result });
    // If a restricted action was denied, stop and signal replanning needed
    if (result.denied) {
      return { success: false, denied: true, results, message: 'Plan paused — approval denied, needs replanning' };
    }
    const t = (action.type || '').toLowerCase();
    if (t !== 'read' && t !== 'observe') {
      executedCount++;
      if (!result.success) failedCount++;
    }
    // Small delay between actions
    await new Promise(r => setTimeout(r, 50));
  }
  // All non-read actions failed → surface failure so callers can re-plan
  if (executedCount > 0 && failedCount === executedCount) {
    return { success: false, results, failedCount, executedCount, message: 'All actions failed' };
  }
  return { success: true, results, failedCount, executedCount };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    executeAction, executePlan, executeScroll, executeClick, executeNavigate, executeRead, executeType, executeSubmit,
    isRestricted, isAllowed, resolveTarget, ALLOWED_ACTIONS, RESTRICTED_ACTIONS, requestApproval, actionNeedsApproval
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


})();