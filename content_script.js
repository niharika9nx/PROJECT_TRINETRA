// Trinetra — content script (Phases 2 + 6 + 8)
// Responsibilities: AT extraction, action injection, approval UI, message bridge.
// Phase 2: AT extraction via lib/at_extractor.js logic (inlined helpers + message handler).
// Future phases will extend this file without breaking Phase 2 API.

if (typeof window !== 'undefined' && window.__TRINETRA_CONTENT_SCRIPT_LOADED) {
  console.log('[Trinetra] content script already loaded, skipping duplicate injection');
} else {
if (typeof window !== 'undefined') window.__TRINETRA_CONTENT_SCRIPT_LOADED = true;

// --- Helpers (duplicated from lib/at_extractor.js for MV3 content_script without import) ---
function inferRole(el) {
  if (el.getAttribute && el.getAttribute('role')) return el.getAttribute('role');
  const tag = el.tagName ? el.tagName.toLowerCase() : '';
  const type = el.getAttribute ? (el.getAttribute('type') || '').toLowerCase() : '';
  const roleMap = {
    a: el.hasAttribute && el.hasAttribute('href') ? 'link' : 'generic',
    button: 'button',
    input: type === 'checkbox' ? 'checkbox' : type === 'radio' ? 'radio' : 'textbox',
    select: 'combobox',
    textarea: 'textbox',
    h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading',
    img: 'img',
    ul: 'list', ol: 'list', li: 'listitem',
    nav: 'navigation', header: 'banner', footer: 'contentinfo', main: 'main',
    form: 'form', table: 'table', tr: 'row',
  };
  return roleMap[tag] || 'generic';
}

function getAccessibleName(el) {
  if (!el) return '';
  const ariaLabel = el.getAttribute && el.getAttribute('aria-label');
  if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();
  const alt = el.getAttribute && el.getAttribute('alt');
  if (alt && alt.trim()) return alt.trim();
  const placeholder = el.getAttribute && el.getAttribute('placeholder');
  if (placeholder && placeholder.trim()) return placeholder.trim();
  if (el.id) {
    try {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label && label.textContent) return label.textContent.trim().slice(0, 200);
    } catch (e) {}
  }
  let text = el.textContent ? el.textContent.replace(/\s+/g, ' ').trim() : '';
  if (text.length > 300) text = text.slice(0, 300);
  return text;
}

function getState(el) {
  const state = {};
  if (!el) return state;
  if (el.disabled) state.disabled = true;
  if (el.checked !== undefined && el.tagName.toLowerCase() === 'input') state.checked = !!el.checked;
  if (el.getAttribute) {
    if (el.getAttribute('aria-disabled') === 'true') state.disabled = true;
    if (el.getAttribute('aria-checked') !== null) state.checked = el.getAttribute('aria-checked') === 'true';
    if (el.getAttribute('aria-expanded') !== null) state.expanded = el.getAttribute('aria-expanded') === 'true';
    if (el.getAttribute('aria-hidden') === 'true') state.hidden = true;
  }
  try {
    const style = window.getComputedStyle(el);
    if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) state.hidden = true;
  } catch (e) {}
  return state;
}

function getBounds(el) {
  try {
    const rect = el.getBoundingClientRect();
    return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
  } catch (e) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
}

function generateSelector(el) {
  try {
    if (el.id) return `#${CSS.escape(el.id)}`;
    let sel = el.tagName.toLowerCase();
    if (el.className && typeof el.className === 'string') {
      const classes = el.className.trim().split(/\s+/).slice(0, 2).map(c => `.${CSS.escape(c)}`).join('');
      if (classes) sel += classes;
    }
    return sel;
  } catch (e) {
    return el.tagName ? el.tagName.toLowerCase() : '*';
  }
}

// Stable, content-derived node id.
//
// The previous scheme was positional (`node_0`, `node_1`, ... by DOM order).
// That is a serious problem for a cloud-driven agent: the plan is produced from
// an AT snapshot, but execution happens after sanitization plus a model call
// (seconds later), by which time a dynamic page has re-rendered and node_137
// refers to a different element. Deriving the id from the element's content
// keeps the same logical element addressable across those re-renders.
//
// A short FNV-1a hash of tag|selector|normalized-name, plus an occurrence
// counter for genuinely identical siblings (e.g. 20 "Add to cart" buttons).
// Bounds are deliberately NOT part of the signature — that would make the id
// change on scroll.
function _trStableHash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(36);
}

function _trNormalizeName(name) {
  return String(name || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 60);
}

// Elements the agent can actually act on. These are never dropped in favour of
// decorative nodes, so every actionable control stays reachable even on a very
// large page — the old positional cap silently made anything past node 2000
// impossible to target.
const _TR_ACTIONABLE_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea', 'summary', 'label', 'option']);
const _TR_ACTIONABLE_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'tab', 'switch', 'slider', 'spinbutton',
]);

function _trIsActionable(tag, role, elem) {
  if (_TR_ACTIONABLE_TAGS.has(tag)) return true;
  if (role && _TR_ACTIONABLE_ROLES.has(role)) return true;
  try {
    if (elem.getAttribute && elem.getAttribute('contenteditable') === 'true') return true;
    if (elem.onclick) return true;
  } catch (e) {}
  return false;
}

function extractAccessibilityTree(options = {}) {
  const { maxNodes = 2000, includeHidden = false } = options;
  const allElements = document.querySelectorAll('*');

  // Collect first, stamp second: interactive nodes are always kept, then the
  // remaining budget is filled with structural nodes.
  const actionable = [];
  const filler = [];
  for (let i = 0; i < allElements.length; i++) {
    const elem = allElements[i];
    const tag = elem.tagName ? elem.tagName.toLowerCase() : '';
    if (['script', 'style', 'noscript', 'meta', 'link', 'head'].includes(tag)) continue;
    const state = getState(elem);
    if (!includeHidden && state.hidden) continue;
    const bounds = getBounds(elem);
    const role = inferRole(elem);
    const name = getAccessibleName(elem);
    const hasRoleAttr = !!elem.getAttribute('role');
    const visuallyInteractive = _TR_ACTIONABLE_TAGS.has(tag) || hasRoleAttr;
    // Zero-area and unnamed generic nodes carry no information worth sending.
    if (!visuallyInteractive && bounds.width === 0 && bounds.height === 0) continue;
    if (role === 'generic' && !name && !visuallyInteractive) continue;

    const node = { role, name: name || '', state, bounds, tag, selector: generateSelector(elem) };
    if (_trIsActionable(tag, role, elem)) actionable.push({ elem, node });
    else filler.push({ elem, node });
  }

  const budget = Math.max(maxNodes, actionable.length);
  const chosen = actionable.concat(filler).slice(0, budget);

  const seen = new Map();
  const nodes = [];
  for (const { elem, node } of chosen) {
    const sig = node.tag + '|' + node.selector + '|' + _trNormalizeName(node.name);
    const base = _trStableHash(sig);
    const nth = seen.get(base) || 0;
    seen.set(base, nth + 1);
    const id = 'n' + base + '_' + nth;
    try { elem.setAttribute('data-trinetra-id', id); } catch (e) {}
    nodes.push({ id, ...node });
  }
  return nodes;
}

// --- Approval Modal (Phase 6) ---
let _approvalResolver = null;
let _approvalTimer = null;

function ensureApprovalModal() {
  if (document.getElementById('trinetra-approval-modal')) return;  const style = document.createElement('style');
  style.textContent = `
    #trinetra-approval-modal { position: fixed; inset: 0; z-index: 2147483647; display: none; align-items: center; justify-content: center; background: rgba(0,0,0,0.55); font-family: system-ui, sans-serif; }
    #trinetra-approval-modal.trinetra-visible { display: flex; }
    #trinetra-approval-card { background: #0f172a; color: #e2e8f0; border: 1px solid #334155; border-radius: 12px; padding: 20px; width: 420px; max-width: 90vw; box-shadow: 0 20px 40px rgba(0,0,0,0.4); }
    #trinetra-approval-card h3 { margin: 0 0 8px; font-size: 15px; color: #f8fafc; }
    #trinetra-approval-card p { margin: 0 0 14px; font-size: 12px; color: #cbd5e1; line-height: 1.5; white-space: pre-line; }
    #trinetra-approval-card .trinetra-target { background: #1e293b; padding: 6px 8px; border-radius: 6px; font-size: 11px; color: #94a3b8; margin-bottom: 14px; word-break: break-all; }
    #trinetra-approval-actions { display: flex; gap: 10px; justify-content: flex-end; }
    #trinetra-approval-actions button { padding: 8px 16px; border-radius: 8px; font-weight: 700; font-size: 12px; cursor: pointer; border: none; }
    #trinetra-approve-btn { background: #0ea5e9; color: white; }
    #trinetra-approve-btn:hover { background: #0284c7; }
    #trinetra-approve-btn.tr-purchase { background: #dc2626; }
    #trinetra-approve-btn.tr-purchase:hover { background: #b91c1c; }
    #trinetra-deny-btn { background: #334155; color: #e2e8f0; }
    #trinetra-deny-btn:hover { background: #475569; }
  `;
  document.documentElement.appendChild(style);

  const overlay = document.createElement('div');
  overlay.id = 'trinetra-approval-modal';
  overlay.innerHTML = `
    <div id="trinetra-approval-card">
      <h3>Agent Approval Required</h3>
      <p id="trinetra-approval-desc">The agent wants to perform a sensitive action.</p>
      <div class="trinetra-target" id="trinetra-approval-target"></div>
      <div id="trinetra-approval-actions">
        <button id="trinetra-deny-btn">Deny</button>
        <button id="trinetra-approve-btn">Approve</button>
      </div>
    </div>
  `;
  document.documentElement.appendChild(overlay);

  document.getElementById('trinetra-approve-btn').addEventListener('click', () => resolveApproval(true));
  document.getElementById('trinetra-deny-btn').addEventListener('click', () => resolveApproval(false));
  overlay.addEventListener('click', (e) => { if (e.target === overlay) resolveApproval(false); });
}

function resolveApproval(approved) {
  const modal = document.getElementById('trinetra-approval-modal');
  if (modal) modal.classList.remove('trinetra-visible');
  // Restore the neutral button labels for the next approval.
  const approveBtn = document.getElementById('trinetra-approve-btn');
  const denyBtn = document.getElementById('trinetra-deny-btn');
  if (approveBtn) { approveBtn.textContent = 'Approve'; approveBtn.classList.remove('tr-purchase'); }
  if (denyBtn) denyBtn.textContent = 'Deny';
  if (_approvalTimer) { clearTimeout(_approvalTimer); _approvalTimer = null; }
  if (_approvalResolver) {
    const r = _approvalResolver;
    _approvalResolver = null;
    r(approved);
  }
}

// An unattended modal would otherwise leave executeAction pending forever and
// wedge the whole loop. Treat a timeout as a denial — the safe default.
const APPROVAL_TIMEOUT_MS = 120000;

function showApprovalModal(action) {
  ensureApprovalModal();
  const modal = document.getElementById('trinetra-approval-modal');
  const desc = document.getElementById('trinetra-approval-desc');
  const targetEl = document.getElementById('trinetra-approval-target');
  const type = (action.type || 'unknown').toLowerCase();
  const targetDesc = action.target ? `${action.target.mode}:${action.target.value}` : 'no target';
  const paramsDesc = action.params ? JSON.stringify(action.params).slice(0, 120) : '';
  desc.textContent = `The agent wants to [${type}] on [${targetDesc}] ${paramsDesc}. This requires your approval.`;
  targetEl.textContent = `Action: ${type} | Target: ${targetDesc} | Params: ${paramsDesc || 'none'}`;
  modal.classList.add('trinetra-visible');
  return new Promise((resolve) => {
    _approvalResolver = resolve;
    if (_approvalTimer) clearTimeout(_approvalTimer);
    _approvalTimer = setTimeout(() => {
      console.warn('[Trinetra] Approval modal timed out — treating as denied');
      resolveApproval(false);
    }, APPROVAL_TIMEOUT_MS);
  });
}

// Expose globally for lib/action_executor.js
window.TrinetraShowApprovalModal = showApprovalModal;
if (typeof self !== 'undefined') self.TrinetraShowApprovalModal = showApprovalModal;

// --- Action helpers (mirrors lib/action_executor.js for content script context) ---
const RESTRICTED_SET = new Set(['type','fill','submit','confirm','payment','payments','sensitive_ops']);
function isRestricted(type) { return RESTRICTED_SET.has((type||'').toLowerCase()); }
function resolveTarget(target, at) {
  if (!target) return null;
  const mode = (target.mode||'').toLowerCase();
  const value = target.value;
  if (mode === 'at_node_id') return document.querySelector(`[data-trinetra-id="${CSS.escape(value)}"]`);
  if (mode === 'css_selector') { try { return document.querySelector(value); } catch(e){ return null; } }
  if (mode === 'bbox') {
    let bbox = value; if (typeof value==='string') bbox = value.split(',').map(Number);
    if (Array.isArray(bbox) && bbox.length>=4) return document.elementFromPoint(bbox[0]+bbox[2]/2, bbox[1]+bbox[3]/2);
  }
  if (mode === 'semantic') {
    // Prefer AT node when available (live pages pass observation.at)
    if (Array.isArray(at) && at.length > 0 && value) {
      const desc = (value||'').toLowerCase();
      const interactive = n => ['link','button','textbox','searchbox','combobox'].includes(n.role) || n.tag === 'a' || n.tag === 'button' || n.tag === 'input';
      let atNode = null;
      if (desc.includes('cart')) {
        // Prefer real cart/nav link: name contains cart, prefer link over generic button
        atNode = at.find(n => interactive(n) && /\bcart\b/i.test(n.name || '') && (n.role === 'link' || n.tag === 'a')) ||
                 at.find(n => interactive(n) && /\bcart\b/i.test(n.name || ''));
      } else if (desc.includes('search')) {
        atNode = at.find(n => n.role === 'searchbox' || n.role === 'combobox' || /search/i.test(n.name || ''));
      } else {
        // Generic: any interactive node whose name matches the description words
        atNode = at.find(n => interactive(n) && (n.name || '').toLowerCase().includes(desc));
      }
      if (atNode && atNode.id) {
        const el = document.querySelector(`[data-trinetra-id="${CSS.escape(atNode.id)}"]`);
        if (el) return el;
      }
    }

    const desc = (value||'').toLowerCase();
    // Search boxes (Amazon, Flipkart, Google, generic e-commerce)
    if (desc.includes('search')) {
      return document.querySelector('#twotabsearchtextbox') ||
        document.querySelector('input[name="field-keywords"]') ||
        document.querySelector('[role="searchbox"], [role="combobox"]') ||
        document.querySelector('input[name*="search"], input[name*="q"], input[class*="search"]') ||
        document.querySelector('input[type="search"]');
    }
    // Submit buttons — search-specific first, generic last
    if (desc.includes('submit') || desc.includes('button') || desc.includes('go')) {
      return document.querySelector('#nav-search-submit-button') ||
        document.querySelector('input[id*="search-submit"], button[id*="search-submit"]') ||
        document.querySelector('input[type="submit"], button[type="submit"]');
    }
    // Price elements
    if (desc.includes('price') || /price|₹|rs|\d{2,}/i.test(desc)) {
      return document.querySelector('[class*="price"], [class*="Price"]') ||
        document.querySelector('.a-price-whole, .a-price') ||
        (document.querySelector('span, div, p') && Array.from(document.querySelectorAll('*')).find(el => /₹|rs\.?|price|\d{2,}/i.test(el.textContent||'')));
    }
    // Cart / open cart: prefer nav cart link, NOT first button, NOT add-to-cart first
    if (desc.includes('cart')) {
      return document.querySelector('#nav-cart') ||
        document.querySelector('a[href*="/cart"]') ||
        Array.from(document.querySelectorAll('a, [role="link"], button, [role="button"]')).find(el =>
          /\bcart\b/i.test((el.getAttribute('aria-label') || '') + ' ' + (el.textContent || ''))
        ) ||
        document.querySelector('[class*="cart"]') ||
        document.querySelector('#add-to-cart-button, #buy-now-button');
    }
    if (desc.includes('add') || desc.includes('buy')) {
      return document.querySelector('#add-to-cart-button, #buy-now-button') ||
        Array.from(document.querySelectorAll('button, [role="button"]')).find(el =>
          /\b(add|buy)\b/i.test((el.getAttribute('aria-label') || '') + ' ' + (el.textContent || ''))
        );
    }
    // Generic: match by name attribute
    return document.querySelector(`[name*="${CSS.escape(desc)}"], [aria-label*="${CSS.escape(desc)}"]`);
  }
  return null;
}
async function execScroll(action, at){ const amt=action.params?.amount??action.amount??300; const t=resolveTarget(action.target, at); if(t&&t.scrollBy) t.scrollBy({top:amt,behavior:'smooth'}); else window.scrollBy({top:amt,behavior:'smooth'}); await new Promise(r=>setTimeout(r,200)); return {success:true,type:'scroll',amount:amt};}
async function execClick(action, at){
  let el=resolveTarget(action.target, at);
  if(!el&&action.target?.value) try{el=document.querySelector(action.target.value);}catch(e){}
  if(!el) return {success:false,error:'click target not found'};
  // CSP: block javascript: hrefs and inline javascript: handlers (other e-com sites)
  try {
    const href = el.getAttribute && el.getAttribute('href');
    const onclick = el.getAttribute && el.getAttribute('onclick');
    if ((href && href.trim().toLowerCase().startsWith('javascript:')) || (onclick && onclick.trim().toLowerCase().includes('javascript:'))) {
      console.warn('[Trinetra] click blocked javascript: href/onclick, safe dispatch', (href||onclick||'').slice(0,60));
      if (href && href.trim().toLowerCase().startsWith('javascript:')) el.removeAttribute('href');
      if (onclick && onclick.toLowerCase().includes('javascript:')) el.removeAttribute('onclick');
      // prevent navigation, just dispatch
      const evt = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
      el.dispatchEvent(evt);
      await new Promise(r=>setTimeout(r,100));
      return {success:true,type:'click', via:'dispatched', blocked_javascript:true};
    }
  } catch(e){}
  try {
    el.click();
  } catch(e) {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }
  await new Promise(r=>setTimeout(r,100));
  return {success:true,type:'click'};
}
async function execNavigate(action){
  const url=action.params?.url||action.target?.value;
  if(!url || typeof url!=='string') return {success:false,error:'navigate missing or non-string url'};
  const trimmed=url.trim();
  const lower=trimmed.toLowerCase();
  if(lower.startsWith('javascript:') || lower.startsWith('data:') || lower.startsWith('blob:') || lower.startsWith('file:')) {
    return {success:false,error:'navigate blocked: javascript:/data:/blob:/file: URLs violate CSP'};
  }
  // Protocol-relative "//evil.com" resolves cross-origin — require an absolute scheme.
  const isAbsoluteHttp = /^https?:\/\//i.test(trimmed);
  if(!isAbsoluteHttp) return {success:false,error:'navigate blocked: only absolute http(s) URLs allowed'};
  try {
    const bgRes = await new Promise((resolve)=>{
      try { chrome.runtime.sendMessage({type:'TRINETRA_NAVIGATE', url:trimmed}, (r)=> resolve(r)); } catch(e){ resolve(null); }
    });
    if(bgRes && bgRes.success) return {success:true,type:'navigate',url:trimmed, via:'background'};
    if(bgRes && bgRes.error) return {success:false,error:bgRes.error};
  } catch(e){}
  // Background unavailable. Only navigate directly when the target is same-origin,
  // so a stale panel can never bounce the user to another site on its own.
  if(location.origin && trimmed.startsWith(location.origin)){
    window.location.href=trimmed;
    return {success:true,type:'navigate',url:trimmed, via:'content'};
  }
  return {success:false,error:'navigate failed: background unavailable and target is cross-origin'};
}
async function execRead(){ let at=[]; try{ at=extractAccessibilityTree(); }catch(e){} return {success:true,type:'read',at,count:at.length};}
async function execType(action, at){
  const el=at ? resolveTarget(action.target, at) : resolveTarget(action.target);
  if(!el) return {success:false,error:'type target not found'};
  const text=action.params?.text??action.params?.value??'';
  el.focus();
  try {
    const proto = Object.getPrototypeOf(el);
    const valueSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set ||
                        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (valueSetter) {
      valueSetter.call(el, text);
    } else {
      el.value = text;
    }
  } catch (e) {
    el.value = text;
  }
  el.dispatchEvent(new Event('input',{bubbles:true}));
  el.dispatchEvent(new Event('change',{bubbles:true}));
  await new Promise(r=>setTimeout(r,50));
  return {success:true,type:'type'};
}

function findSearchForm() {
  return document.querySelector('#nav-search-bar-form') ||
         document.querySelector('form[action*="/s"]') ||
         document.querySelector('form[action*="search"]') ||
         document.querySelector('form[role="search"]') ||
         null;
}

async function execSubmit(action, at){
  let el=at ? resolveTarget(action.target, at) : resolveTarget(action.target);
  let method = null;

  // Preferred: target is a text/search input inside a form → use THAT form's submit button
  if (el && el.tagName === 'INPUT' && (el.type === 'text' || el.type === 'search' || el.type === '')) {
    const form = el.closest('form') || findSearchForm();
    if (form) {
      const submitBtn = form.querySelector('#nav-search-submit-button, input[type="submit"], button[type="submit"], input[type="image"]');
      if (submitBtn) {
        submitBtn.click();
        method = 'form_submit_button';
      } else {
        // Native form.submit — bypasses synthetic-event handlers entirely
        form.submit();
        method = 'form_submit_native';
      }
    } else {
      // No form found — dispatch Enter as last resort
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      method = 'enter_key';
    }
  } else if (el && el.tagName === 'FORM') {
    el.submit();
    method = 'direct_form_submit';
  } else if (el) {
    // Target is a button/other element
    el.click();
    method = 'element_click';
  } else {
    // No resolved target — find search form directly (NEVER bare document.querySelector('form'))
    const form = findSearchForm();
    if (form) {
      const submitBtn = form.querySelector('#nav-search-submit-button, input[type="submit"], button[type="submit"]');
      if (submitBtn) { submitBtn.click(); method = 'search_form_button'; }
      else { form.submit(); method = 'search_form_native'; }
    } else {
      // Last resort: any explicit search submit button
      const btn = document.querySelector('#nav-search-submit-button, input[name="go"], button[type="submit"]');
      if (btn) { btn.click(); method = 'global_search_button'; }
    }
  }

  if (!method) return {success:false,error:'submit target not found and no search form available'};
  await new Promise(r=>setTimeout(r,150));
  return {success:true,type:'submit',method};
}

// Single source of truth for the approval policy, so the per-action dispatcher
// and the plan-level batch prompt can never disagree.
function actionNeedsApproval(action) {
  const type = (action && action.type || '').toLowerCase();
  const isSensitive = isRestricted(type) ||
                      (action.params && /password|credit|card|cvv|otp|pin|ssn/i.test(JSON.stringify(action.params)));
  return action.requires_approval === true ? true : isSensitive;
}

// Human-readable line for the batched approval prompt.
function _describeAction(a) {
  const t = (a.type || '').toLowerCase();
  const target = a.target ? `${a.target.mode}:${a.target.value}` : 'the page';
  const text = a.params && (a.params.text ?? a.params.value);
  if (t === 'type' || t === 'fill') return `Type "${text ?? ''}" into ${target}`;
  if (t === 'submit' || t === 'confirm') return `Submit ${target}`;
  if (t === 'payment' || t === 'payments' || t === 'sensitive_ops') return `Payment / sensitive action on ${target}`;
  if (typeof text === 'string' && text) return `${t} on ${target} with "${text.slice(0, 60)}"`;
  return `${t} on ${target}`;
}

// One prompt for the whole plan rather than one per action. Gate strength is
// unchanged — every restricted action is still listed and must be approved
// before any of them runs — but a search plan is a single question instead of
// two, which is what made multi-iteration runs tedious.
function showPlanApprovalModal(actions) {
  ensureApprovalModal();
  const modal = document.getElementById('trinetra-approval-modal');
  const desc = document.getElementById('trinetra-approval-desc');
  const targetEl = document.getElementById('trinetra-approval-target');
  const n = actions.length;
  desc.textContent =
    `Trinetra wants to run ${n} action${n === 1 ? '' : 's'} that need${n === 1 ? 's' : ''} your approval:\n\n` +
    actions.map((a, i) => `  ${i + 1}. ${_describeAction(a)}`).join('\n') +
    `\n\nApproving runs all ${n}.`;
  targetEl.textContent = 'Everything above runs only if you approve.';
  modal.classList.add('trinetra-visible');
  return new Promise((resolve) => {
    _approvalResolver = resolve;
    if (_approvalTimer) clearTimeout(_approvalTimer);
    _approvalTimer = setTimeout(() => {
      console.warn('[Trinetra] Approval modal timed out — treating as denied');
      resolveApproval(false);
    }, APPROVAL_TIMEOUT_MS);
  });
}

// Purchase confirmation — the last gate before an irreversible order.
// Shows the item and the exact total read from the page, and requires a
// deliberate confirm. This is the ONLY thing standing between the planner and
// a real purchase, so it fails closed: no handler, no purchase.
function showPurchaseModal(info) {
  ensureApprovalModal();
  const modal = document.getElementById('trinetra-approval-modal');
  const desc = document.getElementById('trinetra-approval-desc');
  const targetEl = document.getElementById('trinetra-approval-target');
  // Purchase mode: relabel the buttons so the stakes are unambiguous.
  const approveBtn = document.getElementById('trinetra-approve-btn');
  const denyBtn = document.getElementById('trinetra-deny-btn');
  if (approveBtn) { approveBtn.textContent = 'Place order'; approveBtn.classList.add('tr-purchase'); }
  if (denyBtn) denyBtn.textContent = 'Cancel';
  const total = info && info.total;
  const lines = ['Trinetra is ready to place an order. This cannot be undone.\n'];
  if (info && info.item) lines.push('Item:  ' + String(info.item).slice(0, 120));
  lines.push('Total: ' + (total === null || total === undefined ? 'unknown' : '₹' + Number(total).toLocaleString('en-IN')));
  if (info && info.label) lines.push('\nAction: ' + String(info.label).slice(0, 80));
  lines.push('\nPayment details are never entered by the agent — you will be asked for those yourself.');
  desc.textContent = lines.join('\n');
  targetEl.textContent = 'Confirm places a real order. Cancel stops here.';
  modal.classList.add('trinetra-visible');
  return new Promise((resolve) => {
    _approvalResolver = resolve;
    if (_approvalTimer) clearTimeout(_approvalTimer);
    _approvalTimer = setTimeout(() => {
      console.warn('[Trinetra] Purchase confirmation timed out — defaulting to cancel');
      resolveApproval(false);
    }, 180000);
  });
}

function _trConfirmPurchase(info) {
  return showPurchaseModal(info);
}

async function executeAction(action, at, opts = {}){
  const type=(action.type||'').toLowerCase();
  if(!opts.skipApproval && actionNeedsApproval(action)){
    const approved=await showApprovalModal(action);
    if(!approved) return {success:false,denied:true,reason:'User denied approval'};
  }
  switch(type){
    case 'scroll': return execScroll(action, at);
    case 'click': return execClick(action, at);
    case 'navigate': return execNavigate(action);
    case 'read': case 'observe': return execRead(action);
    case 'type': case 'fill': return execType(action, at);
    case 'submit': case 'confirm': case 'payment': case 'payments': case 'sensitive_ops': return execSubmit(action, at);
    default: return {success:false,error:`Unknown action type: ${type}`};
  }
}
async function executePlan(plan, at){
  const actions=plan.actions||plan.plan||[];
  const results=[];
  let failedCount=0, executedCount=0;
  // Once the user has approved this plan, the remaining restricted actions in it
  // are covered by that same consent.
  let planApproved=false;
  for(let i=0;i<actions.length;i++){
    const a=actions[i];
    if(actionNeedsApproval(a) && !planApproved){
      // Collect every restricted action still to come, so the user sees the
      // whole picture in one prompt instead of being asked repeatedly.
      const gated=actions.slice(i).filter(actionNeedsApproval);
      const approved=await showPlanApprovalModal(gated);
      if(!approved){
        results.push({action:a,result:{success:false,denied:true,reason:'User denied the plan'}});
        return {success:false,denied:true,results};
      }
      planApproved=true;
    }
    const r=await executeAction(a, at, {skipApproval:true});
    results.push({action:a,result:r});
    if(r.denied) return {success:false,denied:true,results};
    const t=(a.type||'').toLowerCase();
    if(t!=='read' && t!=='observe'){
      executedCount++;
      if(!r.success) failedCount++;
    }
    await new Promise(x=>setTimeout(x,50));
  }
  // All non-read actions failed → signal failure so the loop can re-plan
  if(executedCount>0 && failedCount===executedCount){
    return {success:false,results,failedCount,executedCount,message:'All actions failed'};
  }
  return {success:true,results,failedCount,executedCount};
}

// --- Message bridge (Phases 2 + 6) ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return;

  if (message.type === 'TRINETRA_EXTRACT_AT') {
    try {
      const at = extractAccessibilityTree(message.options || {});
      sendResponse({ success: true, at, url: location.href, timestamp: new Date().toISOString() });
    } catch (e) {
      sendResponse({ success: false, error: e.message });
    }
    return true;
  }

  if (message.type === 'TRINETRA_EXECUTE_PLAN') {
    const at = message.at || [];
    executePlan(message.plan || {}, at).then(r => sendResponse({ success: r.success, result: r })).catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (message.type === 'TRINETRA_TOGGLE_PANEL') {
    try { _trTogglePanel(); } catch (e) { console.warn('[Trinetra] toggle panel error', e); }
    sendResponse({ success: true });
    return true;
  }
});

// ========== FLOATING PANEL (Content Script Overlay) ==========

let _trPanelVisible = false;
let _trPanelEl = null;
let _trPanelMessages = [];
let _trPanelRunning = false;
let _trPanelCurrentSteps = [];
let _trPanelAgentBubble = null;
let _trPanelAgentTimeline = null;
let _trPanelCurrentAssistantEl = null;

function _trEnsurePanelStyles() {
  if (document.getElementById('trinetra-panel-styles')) return;
  const s = document.createElement('style');
  s.id = 'trinetra-panel-styles';
  s.textContent = `
    /* No @import of remote fonts here on purpose: this stylesheet is injected
       into every page the agent touches, so a Google Fonts request would leak
       a visit to Google and break the privacy guarantee. The system font
       stack below is used instead. */

    #trinetra-panel {
      position: fixed; z-index: 2147483646; display: none;
      flex-direction: column; overflow: hidden;
      background: rgba(0, 0, 0, 0.88);
      backdrop-filter: blur(20px) saturate(120%);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 16px;
      box-shadow: 0 24px 80px rgba(0, 0, 0, 0.6), 0 0 1px rgba(255,255,255,0.1);
      font-family: Montserrat, ui-sans-serif, system-ui, -apple-system, sans-serif;
      color: #e2e8f0; font-size: 13px; line-height: 1.5;
      min-width: 340px; min-height: 420px;
      top: 60px; left: calc(100vw - 420px);
      width: 400px; height: 600px;
      transition: opacity 0.15s ease, transform 0.15s ease;
    }
    #trinetra-panel.tr-visible { display: flex; }
    #trinetra-panel.tr-minimized {
      height: auto !important; min-height: 0 !important; min-width: 0 !important; width: 320px !important;
    }
    #trinetra-panel.tr-minimized .tr-conversation,
    #trinetra-panel.tr-minimized .tr-input-bar,
    #trinetra-panel.tr-minimized .tr-state-bar,
    #trinetra-panel.tr-minimized .tr-privacy-footer { display: none; }

    .tr-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 10px 14px; flex-shrink: 0; cursor: grab; user-select: none;
      border-bottom: 1px solid rgba(255,255,255,0.06);
      background: rgba(255,255,255,0.03);
      transition: background 0.15s;
    }
    .tr-header:hover { background: rgba(255,255,255,0.05); }
    .tr-header.dragging { cursor: grabbing; background: rgba(255,255,255,0.07); }
    .tr-header-left { display: flex; align-items: center; gap: 10px; }
    .tr-title { font-size: 14px; font-weight: 700; color: #e2e8f0; }
    .tr-subtitle { font-size: 10px; color: #475569; }
    .tr-header-right { display: flex; align-items: center; gap: 5px; }
    .tr-pill {
      padding: 3px 8px; border-radius: 12px; font-size: 9px; font-weight: 600;
      letter-spacing: 0.04em; text-transform: uppercase;
      background: rgba(34,197,94,0.1); border: 1px solid rgba(34,197,94,0.2); color: #4ade80;
      display: flex; align-items: center; gap: 4px;
    }
    .tr-pill.tr-cloud { background: rgba(255,255,255,0.08); border-color: rgba(255,255,255,0.15); color: #d4d4d4; }
    .tr-pill-dot { width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
    .tr-pill.tr-cloud .tr-pill-dot { animation: trPulse 1.5s ease-in-out infinite; }
    @keyframes trPulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
    .tr-icon-btn {
      width: 26px; height: 26px; border-radius: 7px;
      border: 1px solid rgba(255,255,255,0.08); background: rgba(255,255,255,0.04);
      color: #475569; font-size: 11px; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      transition: all 0.12s;
    }
    .tr-icon-btn:hover { background: rgba(255,255,255,0.1); color: #e2e8f0; border-color: rgba(255,255,255,0.15); }
    .tr-icon-btn:active { transform: scale(0.92); }
    .tr-icon-btn.tr-danger:hover { background: rgba(239,68,68,0.15); color: #f87171; border-color: rgba(239,68,68,0.3); }

    .tr-state-bar {
      padding: 7px 14px; flex-shrink: 0; display: flex; align-items: center;
      justify-content: space-between; border-bottom: 1px solid rgba(255,255,255,0.04);
    }
    .tr-state-indicator { display: flex; align-items: center; gap: 7px; font-size: 11px; color: #94a3b8; }
    .tr-state-dot {
      width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0;
      background: #475569; transition: all 0.3s;
    }
    .tr-state-dot.tr-thinking { background: #f59e0b; animation: trPulse 1.2s ease-in-out infinite; }
    .tr-state-dot.tr-observing { background: #a3a3a3; animation: trPulse 1.2s ease-in-out infinite; }
    .tr-state-dot.tr-executing { background: #737373; animation: trPulse 1s ease-in-out infinite; }
    .tr-state-dot.tr-cloud { background: #d4d4d4; animation: trPulse 1s ease-in-out infinite; }
    .tr-state-dot.tr-completed { background: #22c55e; }
    .tr-state-dot.tr-error { background: #ef4444; }
    .tr-confidence {
      padding: 2px 7px; border-radius: 5px; font-size: 10px; font-weight: 600;
      background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.12); color: #a3a3a3;
      font-variant-numeric: tabular-nums; display: none;
    }

    .tr-conversation {
      flex: 1; overflow-y: auto; padding: 14px;
      display: flex; flex-direction: column; gap: 10px;
      scroll-behavior: smooth;
    }
    .tr-conversation::-webkit-scrollbar { width: 4px; }
    .tr-conversation::-webkit-scrollbar-track { background: transparent; }
    .tr-conversation::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 4px; }

    .tr-empty {
      flex: 1; display: flex; flex-direction: column; align-items: center;
      justify-content: center; gap: 10px; padding: 20px 14px; text-align: center;
    }
    .tr-empty h3 { font-size: 14px; font-weight: 600; color: #e2e8f0; margin: 0; }
    .tr-empty p { font-size: 11px; color: #475569; max-width: 260px; line-height: 1.5; margin: 0; }
    .tr-suggestions { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px; justify-content: center; }
    .tr-suggestion {
      padding: 6px 11px; border-radius: 16px; background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.08); color: #94a3b8;
      font-size: 11px; cursor: pointer; transition: all 0.12s;
    }
    .tr-suggestion:hover { background: rgba(255,255,255,0.08); color: #e2e8f0; border-color: rgba(255,255,255,0.15); }

    .tr-msg { display: flex; animation: trFadeIn 0.2s ease-out; }
    .tr-msg.tr-user { justify-content: flex-end; }
    .tr-msg.tr-assistant { flex-direction: column; gap: 8px; }
    .tr-user-bubble {
      max-width: 82%; padding: 9px 13px; border-radius: 14px;
      background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.08);
      color: #e2e8f0; font-size: 12px; line-height: 1.5;
      word-break: break-word; white-space: pre-wrap; border-bottom-right-radius: 4px;
    }
    .tr-agent-header { display: flex; align-items: center; gap: 7px; }
    .tr-agent-label { font-size: 10px; font-weight: 600; color: #94a3b8; }
    .tr-agent-bubble {
      max-width: 88%; padding: 11px 13px; border-radius: 14px;
      background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06);
      color: #e2e8f0; font-size: 12px; line-height: 1.55;
      word-break: break-word; white-space: pre-wrap; border-bottom-left-radius: 4px;
    }
    .tr-result-card {
      padding: 12px; border-radius: 10px;
      background: rgba(34,197,94,0.05); border: 1px solid rgba(34,197,94,0.15);
    }
    .tr-result-card.tr-error { background: rgba(239,68,68,0.05); border-color: rgba(239,68,68,0.15); }
    .tr-result-header { display: flex; align-items: center; gap: 7px; margin-bottom: 6px; }
    .tr-result-check {
      width: 18px; height: 18px; border-radius: 50%;
      background: rgba(34,197,94,0.2); display: flex; align-items: center;
      justify-content: center; font-size: 10px; font-weight: 700; color: #4ade80;
    }
    .tr-result-card.tr-error .tr-result-check { background: rgba(239,68,68,0.2); color: #f87171; }
    .tr-result-title { font-size: 12px; font-weight: 600; color: #4ade80; }
    .tr-result-card.tr-error .tr-result-title { color: #f87171; }
    .tr-result-body { font-size: 11px; color: #94a3b8; line-height: 1.5; white-space: pre-line; }

    .tr-timeline { display: flex; flex-direction: column; gap: 0; margin-top: 3px; }
    .tr-tl-item {
      display: flex; align-items: flex-start; gap: 9px; padding: 6px 8px;
      border-radius: 6px; cursor: pointer; transition: all 0.15s;
      animation: trSlideUp 0.25s ease-out;
    }
    .tr-tl-item:hover { background: rgba(255,255,255,0.03); }
    .tr-tl-item.tr-done { opacity: 0.65; }
    .tr-tl-item.tr-active { background: rgba(255,255,255,0.04); }
    .tr-tl-item.tr-expanded .tr-tl-details { display: block; }
    .tr-tl-track { display: flex; flex-direction: column; align-items: center; flex-shrink: 0; width: 16px; }
    .tr-tl-dot {
      width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; z-index: 1;
      background: rgba(255,255,255,0.1); transition: all 0.3s;
    }
    .tr-tl-dot.tr-done { background: #22c55e; box-shadow: 0 0 5px rgba(34,197,94,0.3); }
    .tr-tl-dot.tr-active { background: #a3a3a3; box-shadow: 0 0 7px rgba(163,163,163,0.4); animation: trPulse 1.2s ease-in-out infinite; }
    .tr-tl-dot.tr-cloud { background: #d4d4d4; box-shadow: 0 0 7px rgba(212,212,212,0.4); animation: trPulse 1.2s ease-in-out infinite; }
    .tr-tl-line { width: 2px; flex: 1; min-height: 6px; background: rgba(255,255,255,0.06); margin-top: 2px; }
    .tr-tl-line.tr-done { background: rgba(34,197,94,0.2); }
    .tr-tl-content { flex: 1; min-width: 0; padding-bottom: 3px; }
    .tr-tl-title { font-size: 11px; font-weight: 500; color: #e2e8f0; line-height: 1.4; }
    .tr-tl-sub { font-size: 10px; color: #475569; margin-top: 2px; line-height: 1.4; display: none; }
    .tr-tl-item.tr-done .tr-tl-sub { display: block; }
    .tr-tl-badge {
      font-size: 8px; font-weight: 600; letter-spacing: 0.03em; padding: 2px 5px;
      border-radius: 3px; flex-shrink: 0;
    }
    .tr-tl-badge.tr-done { background: rgba(34,197,94,0.1); color: #4ade80; }
    .tr-tl-badge.tr-active { background: rgba(255,255,255,0.08); color: #a3a3a3; }
    .tr-tl-badge.tr-cloud { background: rgba(255,255,255,0.08); color: #d4d4d4; }
    .tr-tl-details {
      display: none; margin-top: 6px; padding-top: 6px;
      border-top: 1px solid rgba(255,255,255,0.06);
      font-size: 10px; color: #475569; line-height: 1.5;
    }

    .tr-input-bar {
      padding: 10px 14px; border-top: 1px solid rgba(255,255,255,0.06);
      background: rgba(0,0,0,0.2); flex-shrink: 0;
    }
    .tr-input-wrap {
      display: flex; gap: 7px; align-items: flex-end;
      background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08);
      border-radius: 14px; padding: 9px 12px; transition: all 0.2s;
    }
    .tr-input-wrap.tr-focus { border-color: rgba(255,255,255,0.15); background: rgba(255,255,255,0.04); box-shadow: 0 0 0 3px rgba(255,255,255,0.06); }
    #tr-panel-input {
      flex: 1; min-height: 18px; max-height: 70px; background: transparent;
      border: none; outline: none; color: #e2e8f0; font-size: 12px;
      resize: none; font-family: inherit; line-height: 1.5;
    }
    #tr-panel-input::placeholder { color: #475569; }
    .tr-send-btn {
      width: 28px; height: 28px; border-radius: 50%; border: none;
      background: linear-gradient(135deg, #ffffff, #d4d4d4); color: #000;
      display: flex; align-items: center; justify-content: center;
      cursor: pointer; flex-shrink: 0; font-size: 13px; font-weight: 700;
      transition: all 0.12s; box-shadow: 0 2px 8px rgba(255,255,255,0.1);
    }
    .tr-send-btn:hover { transform: scale(1.05); }
    .tr-send-btn:active { transform: scale(0.95); }
    .tr-send-btn:disabled { opacity: 0.4; cursor: not-allowed; transform: none; }
    .tr-send-btn.tr-stop { background: linear-gradient(135deg, #ef4444, #dc2626); box-shadow: 0 2px 8px rgba(239,68,68,0.3); }
    .tr-input-hint {
      margin-top: 5px; font-size: 9px; color: #475569; text-align: center;
      display: flex; align-items: center; justify-content: center; gap: 10px;
    }

    .tr-privacy {
      padding: 5px 14px 8px; display: flex; align-items: center; justify-content: center;
      gap: 5px; font-size: 9px; color: #475569; flex-shrink: 0;
    }

    @keyframes trFadeIn { from{opacity:0} to{opacity:1} }
    @keyframes trSlideUp { from{opacity:0;transform:translateY(6px)} to{opacity:1;transform:translateY(0)} }
    @keyframes trSpin { to{transform:rotate(360deg)} }

    .tr-spinner { width: 12px; height: 12px; border: 2px solid rgba(255,255,255,0.15); border-top-color: #a3a3a3; border-radius: 50%; animation: trSpin 0.8s linear infinite; }

    .tr-resize-handle {
      position: absolute; z-index: 10;
    }
    .tr-resize-n { top: -4px; left: 10px; right: 10px; height: 8px; cursor: n-resize; }
    .tr-resize-s { bottom: -4px; left: 10px; right: 10px; height: 8px; cursor: s-resize; }
    .tr-resize-e { top: 10px; right: -4px; bottom: 10px; width: 8px; cursor: e-resize; }
    .tr-resize-w { top: 10px; left: -4px; bottom: 10px; width: 8px; cursor: w-resize; }
    .tr-resize-nw { top: -4px; left: -4px; width: 14px; height: 14px; cursor: nw-resize; }
    .tr-resize-ne { top: -4px; right: -4px; width: 14px; height: 14px; cursor: ne-resize; }
    .tr-resize-sw { bottom: -4px; left: -4px; width: 14px; height: 14px; cursor: sw-resize; }
    .tr-resize-se { bottom: -4px; right: -4px; width: 14px; height: 14px; cursor: se-resize; }

    #tr-panel-input::placeholder { color: #475569; }
  `;
  document.documentElement.appendChild(s);
}

function _trEnsurePanel() {
  if (_trPanelEl) return _trPanelEl;
  _trEnsurePanelStyles();

  const panel = document.createElement('div');
  panel.id = 'trinetra-panel';
  panel.innerHTML = `
    <div class="tr-header" id="tr-panel-header">
      <div class="tr-header-left">
        <div>
          <div class="tr-title">Trinetra</div>
          <div class="tr-subtitle">Privacy-preserving agent</div>
        </div>
      </div>
      <div class="tr-header-right">
        <div class="tr-pill" id="tr-pill"><span class="tr-pill-dot"></span><span id="tr-pill-text">LOCAL</span></div>
        <button class="tr-icon-btn" id="tr-new-btn" title="New conversation">+</button>
        <button class="tr-icon-btn" id="tr-min-btn" title="Minimize">-</button>
        <button class="tr-icon-btn tr-danger" id="tr-close-btn" title="Close">x</button>
      </div>
    </div>
    <div class="tr-state-bar" id="tr-state-bar">
      <div class="tr-state-indicator">
        <div class="tr-state-dot" id="tr-state-dot"></div>
        <span id="tr-state-text">Ready</span>
      </div>
      <div class="tr-confidence" id="tr-confidence"></div>
    </div>
    <div class="tr-conversation" id="tr-conversation">
      <div class="tr-empty" id="tr-empty">
        <h3>Trinetra is ready</h3>
        <p>Local-first processing. Only sanitized context is shared with cloud when needed.</p>
        <div class="tr-suggestions">
          <div class="tr-suggestion" data-goal="Find me a laptop under 1 lakh">Find a laptop</div>
          <div class="tr-suggestion" data-goal="Find the cheapest laptop under 60000 and open it">Cheapest laptop</div>
          <div class="tr-suggestion" data-goal="Search for shoes under 2000">Search for shoes</div>
        </div>
      </div>
    </div>
    <div class="tr-input-bar">
      <div class="tr-input-wrap" id="tr-input-wrap">
        <textarea id="tr-panel-input" rows="1" placeholder="Ask Trinetra..."></textarea>
        <button class="tr-send-btn" id="tr-send-btn" title="Send">^</button>
      </div>
      <div class="tr-input-hint">
        <span>Enter: Send</span><span>Shift+Enter: New line</span>
      </div>
    </div>
    <div class="tr-privacy">Local-first / Sanitized context only</div>
    <div class="tr-resize-handle tr-resize-n" data-dir="n"></div>
    <div class="tr-resize-handle tr-resize-s" data-dir="s"></div>
    <div class="tr-resize-handle tr-resize-e" data-dir="e"></div>
    <div class="tr-resize-handle tr-resize-w" data-dir="w"></div>
    <div class="tr-resize-handle tr-resize-nw" data-dir="nw"></div>
    <div class="tr-resize-handle tr-resize-ne" data-dir="ne"></div>
    <div class="tr-resize-handle tr-resize-sw" data-dir="sw"></div>
    <div class="tr-resize-handle tr-resize-se" data-dir="se"></div>
  `;
  document.documentElement.appendChild(panel);
  _trPanelEl = panel;

  _trInitDrag(panel);
  _trInitResize(panel);
  _trInitPanelEvents(panel);
  _trRenderAll();

  return panel;
}

// ========== TOGGLE ==========

function _trTogglePanel() {
  _trEnsurePanel();
  _trPanelVisible = !_trPanelVisible;
  if (_trPanelVisible) {
    _trPanelEl.classList.add('tr-visible');
    const input = _trPanelEl.querySelector('#tr-panel-input');
    if (input) setTimeout(() => input.focus(), 100);
  } else {
    _trPanelEl.classList.remove('tr-visible');
  }
}

// ========== DRAG ==========

function _trInitDrag(panel) {
  const header = panel.querySelector('#tr-panel-header');
  let dragging = false, sx = 0, sy = 0, px = 0, py = 0;

  header.addEventListener('mousedown', (e) => {
    if (e.target.closest('.tr-header-right')) return;
    dragging = true;
    sx = e.clientX; sy = e.clientY;
    const r = panel.getBoundingClientRect();
    px = r.left; py = r.top;
    header.classList.add('dragging');
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    let nx = px + dx, ny = py + dy;
    nx = Math.max(0, Math.min(window.innerWidth - panel.offsetWidth, nx));
    ny = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, ny));
    panel.style.left = nx + 'px';
    panel.style.top = ny + 'px';
    panel.style.right = 'auto';
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    header.classList.remove('dragging');
  });
}

// ========== RESIZE ==========

function _trInitResize(panel) {
  let resizing = false, dir = '', startX = 0, startY = 0, startW = 0, startH = 0, startL = 0, startT = 0;
  const MIN_W = 320, MIN_H = 400;

  panel.querySelectorAll('.tr-resize-handle').forEach(h => {
    h.addEventListener('mousedown', (e) => {
      resizing = true;
      dir = h.getAttribute('data-dir');
      startX = e.clientX; startY = e.clientY;
      const r = panel.getBoundingClientRect();
      startW = r.width; startH = r.height;
      startL = r.left; startT = r.top;
      e.preventDefault();
      e.stopPropagation();
    });
  });

  document.addEventListener('mousemove', (e) => {
    if (!resizing) return;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    let w = startW, h = startH, l = startL, t = startT;

    if (dir.includes('e')) w = Math.max(MIN_W, startW + dx);
    if (dir.includes('w')) { w = Math.max(MIN_W, startW - dx); l = startL + (startW - w); }
    if (dir.includes('s')) h = Math.max(MIN_H, startH + dy);
    if (dir.includes('n')) { h = Math.max(MIN_H, startH - dy); t = startT + (startH - h); }

    panel.style.width = w + 'px';
    panel.style.height = h + 'px';
    panel.style.left = l + 'px';
    panel.style.top = t + 'px';
    panel.style.right = 'auto';
  });

  document.addEventListener('mouseup', () => { resizing = false; });
}

// ========== PANEL EVENTS ==========

function _trInitPanelEvents(panel) {
  const input = panel.querySelector('#tr-panel-input');
  const sendBtn = panel.querySelector('#tr-send-btn');
  const newBtn = panel.querySelector('#tr-new-btn');
  const minBtn = panel.querySelector('#tr-min-btn');
  const closeBtn = panel.querySelector('#tr-close-btn');
  const inputWrap = panel.querySelector('#tr-input-wrap');

  input.addEventListener('focus', () => inputWrap.classList.add('tr-focus'));
  input.addEventListener('blur', () => inputWrap.classList.remove('tr-focus'));

  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 70) + 'px';
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!_trPanelRunning) _trHandleSend();
    }
  });

  sendBtn.addEventListener('click', () => {
    if (_trPanelRunning) return;
    _trHandleSend();
  });

  newBtn.addEventListener('click', () => {
    _trPanelMessages = [];
    _trPanelCurrentSteps = [];
    _trRenderAll();
  });

  minBtn.addEventListener('click', () => {
    panel.classList.toggle('tr-minimized');
  });

  closeBtn.addEventListener('click', () => {
    _trPanelVisible = false;
    panel.classList.remove('tr-visible');
  });

  panel.querySelectorAll('.tr-suggestion').forEach(el => {
    el.addEventListener('click', () => {
      input.value = el.getAttribute('data-goal') || el.textContent;
      input.focus();
      input.dispatchEvent(new Event('input'));
    });
  });
}

// ========== RENDERING ==========

function _trRenderAll() {
  const conv = _trPanelEl.querySelector('#tr-conversation');
  const empty = _trPanelEl.querySelector('#tr-empty');
  while (conv.firstChild) conv.removeChild(conv.firstChild);

  if (_trPanelMessages.length === 0) {
    if (empty) { empty.style.display = 'flex'; conv.appendChild(empty); }
    return;
  }
  if (empty) { empty.style.display = 'none'; conv.appendChild(empty); }
  _trPanelMessages.forEach(m => {
    conv.appendChild(_trCreateMsgEl(m));
  });
  if (_trPanelRunning && _trPanelCurrentAssistantEl) {
    conv.appendChild(_trPanelCurrentAssistantEl);
  }
  conv.scrollTop = conv.scrollHeight;
}

function _trCreateMsgEl(m) {
  const wrap = document.createElement('div');
  wrap.className = 'tr-msg tr-' + m.role;

  if (m.role === 'user') {
    const b = document.createElement('div');
    b.className = 'tr-user-bubble';
    b.textContent = m.content;
    wrap.appendChild(b);
  } else if (m.role === 'assistant') {
    if (m.isResult) {
      const card = document.createElement('div');
      card.className = 'tr-result-card' + (m.resultSuccess === false ? ' tr-error' : '');
      const hdr = document.createElement('div');
      hdr.className = 'tr-result-header';
      const chk = document.createElement('span');
      chk.className = 'tr-result-check';
      chk.textContent = m.resultSuccess === false ? 'x' : 'v';
      const ttl = document.createElement('span');
      ttl.className = 'tr-result-title';
      ttl.textContent = m.resultSuccess === false ? 'Task failed' : 'Task completed';
      hdr.appendChild(chk);
      hdr.appendChild(ttl);
      const body = document.createElement('div');
      body.className = 'tr-result-body';
      body.textContent = m.content;
      card.appendChild(hdr);
      card.appendChild(body);
      if (m.steps && m.steps.length) card.appendChild(_trCreateTimelineEl(m.steps));
      // Contextual next steps, only on a successful run.
      if (m.resultSuccess !== false && m.followUps && m.followUps.length) {
        const wrapEl = document.createElement('div');
        wrapEl.className = 'tr-suggestions';
        wrapEl.style.marginTop = '10px';
        wrapEl.style.justifyContent = 'flex-start';
        for (const goal of m.followUps) {
          const chip = document.createElement('div');
          chip.className = 'tr-suggestion';
          chip.textContent = goal;
          chip.title = 'Run this next';
          chip.addEventListener('click', () => {
            const input = _trPanelEl.querySelector('#tr-panel-input');
            if (!input) return;
            input.value = goal;
            input.focus();
            _trHandleSend();
          });
          wrapEl.appendChild(chip);
        }
        card.appendChild(wrapEl);
      }
      wrap.appendChild(card);
    } else {
      const msg = document.createElement('div');
      msg.style.display = 'flex';
      msg.style.flexDirection = 'column';
      msg.style.gap = '8px';
      const hdr = document.createElement('div');
      hdr.className = 'tr-agent-header';
      const lbl = document.createElement('span');
      lbl.className = 'tr-agent-label';
      lbl.textContent = 'Trinetra';
      hdr.appendChild(lbl);
      const b = document.createElement('div');
      b.className = 'tr-agent-bubble';
      b.textContent = m.content;
      msg.appendChild(hdr);
      msg.appendChild(b);
      if (m.steps && m.steps.length) msg.appendChild(_trCreateTimelineEl(m.steps));
      wrap.appendChild(msg);
    }
  }
  return wrap;
}

function _trCreateTimelineEl(steps) {
  const tl = document.createElement('div');
  tl.className = 'tr-timeline';
  steps.forEach((s, i) => {
    const isLast = i === steps.length - 1;
    const isCloud = s.step === 'cloud_call' || s.step === 'cloud_result';
    const isDone = s.step && s.step.endsWith('ed');
    const isActive = !isDone && isLast;

    const item = document.createElement('div');
    item.className = 'tr-tl-item' + (isDone ? ' tr-done' : '') + (isActive ? ' tr-active' : '');

    const track = document.createElement('div');
    track.className = 'tr-tl-track';
    const dot = document.createElement('div');
    dot.className = 'tr-tl-dot' + (isDone ? ' tr-done' : '') + (isActive ? ' tr-active' : '') + (isCloud ? ' tr-cloud' : '');
    const line = document.createElement('div');
    line.className = 'tr-tl-line' + (isDone ? ' tr-done' : '');
    track.appendChild(dot);
    track.appendChild(line);

    const content = document.createElement('div');
    content.className = 'tr-tl-content';
    const title = document.createElement('div');
    title.className = 'tr-tl-title';
    title.textContent = _trStepLabel(s);
    content.appendChild(title);

    const badge = document.createElement('span');
    badge.className = 'tr-tl-badge' + (isDone ? ' tr-done' : '') + (isActive ? ' tr-active' : '') + (isCloud ? ' tr-cloud' : '');
    badge.textContent = isDone ? 'done' : isActive ? 'active' : isCloud ? 'cloud' : 'pending';

    const main = document.createElement('div');
    main.style.display = 'flex';
    main.style.alignItems = 'center';
    main.style.gap = '6px';
    main.appendChild(title);
    main.appendChild(badge);
    content.innerHTML = '';
    content.appendChild(main);

    item.appendChild(track);
    item.appendChild(content);

    item.addEventListener('click', () => item.classList.toggle('tr-expanded'));

    tl.appendChild(item);
  });
  return tl;
}

function _trStepLabel(stepOrKey) {
  const key = typeof stepOrKey === 'object' && stepOrKey ? stepOrKey.step : stepOrKey;
  const map = {
    classify: 'Classifying request',
    observe: 'Observing page', observed: 'Page observed',
    at_diff: 'Comparing page state',
    reason: 'Understanding request', reasoned: 'Request understood',
    sanitize: 'Sanitizing context', sanitized: 'Context sanitized',
    cloud_call: 'Consulting cloud agent', cloud_result: 'Cloud response received',
    cloud_error: (s) => `Cloud error — ${s?.error || 'falling back'}`,
    local_fallback: (s) => `Using local fallback${s?.reason ? ` (${String(s.reason).slice(0, 80)})` : ''}`,
    auth_required: 'Login required — cannot proceed',
    execute: 'Executing action', executed: 'Action executed',
    execute_failed: 'Action failed',
    execute_error: 'Execution error',
    page_load_wait: 'Waiting for page load',
    transition_failed: 'Page did not navigate',
    page_transitioned: 'Page navigated',
    navigate_fallback: 'Direct navigation fallback',
    no_actions: 'No actions planned',
    no_change: 'No screen change',
    stuck: 'Stuck — no progress',
    reload: 'Reloading page',
    stall: 'Stalled',
    evaluate: 'Evaluating progress', vlm_flag: 'VLM analysis flagged',
    purchase_refused: 'Action blocked for safety',
    purchase_approved: 'Purchase confirmed',
    purchase_declined: 'Purchase cancelled',
    execute_denied: 'Approval denied',
    error: 'Error occurred'
  };
  const entry = map[key];
  if (typeof entry === 'function') return entry(stepOrKey);
  return entry || key || 'Processing';
}

// ========== STATE MANAGEMENT ==========

function _trSetState(state) {
  const dot = _trPanelEl.querySelector('#tr-state-dot');
  const txt = _trPanelEl.querySelector('#tr-state-text');
  if (!dot || !txt) return;
  dot.className = 'tr-state-dot';
  if (state === 'thinking') { dot.classList.add('tr-thinking'); txt.textContent = 'Thinking'; }
  else if (state === 'observing') { dot.classList.add('tr-observing'); txt.textContent = 'Observing'; }
  else if (state === 'executing') { dot.classList.add('tr-executing'); txt.textContent = 'Executing'; }
  else if (state === 'cloud') { dot.classList.add('tr-cloud'); txt.textContent = 'Cloud'; }
  else if (state === 'completed') { dot.classList.add('tr-completed'); txt.textContent = 'Completed'; }
  else if (state === 'error') { dot.classList.add('tr-error'); txt.textContent = 'Error'; }
  else { txt.textContent = 'Ready'; }
}

function _trSetCloud(mode) {
  const pill = _trPanelEl.querySelector('#tr-pill');
  const txt = _trPanelEl.querySelector('#tr-pill-text');
  if (!pill || !txt) return;
  pill.className = 'tr-pill';
  if (mode === 'cloud') { pill.classList.add('tr-cloud'); txt.textContent = 'CLOUD'; }
  else if (mode === 'cloud-result') { pill.classList.add('tr-cloud'); txt.textContent = 'CLOUD RESULT'; }
  else { txt.textContent = 'LOCAL'; }
}

function _trSetConfidence(c) {
  const el = _trPanelEl.querySelector('#tr-confidence');
  if (!el) return;
  el.style.display = 'inline-block';
  el.textContent = Math.round(c * 100) + '%';
}

function _trHideConfidence() {
  const el = _trPanelEl.querySelector('#tr-confidence');
  if (el) el.style.display = 'none';
}

// ========== MESSAGES ==========

function _trAddUserMsg(text) {
  _trPanelMessages.push({ role: 'user', content: text, timestamp: new Date().toISOString() });
  _trRenderAll();
}

function _trStartAssistant() {
  const wrap = document.createElement('div');
  wrap.className = 'tr-msg tr-assistant';
  const hdr = document.createElement('div');
  hdr.className = 'tr-agent-header';
  const lbl = document.createElement('span');
  lbl.className = 'tr-agent-label';
  lbl.textContent = 'Trinetra';
  hdr.appendChild(lbl);
  const b = document.createElement('div');
  b.className = 'tr-agent-bubble';
  b.textContent = 'Thinking...';
  const tl = document.createElement('div');
  tl.className = 'tr-timeline';
  wrap.appendChild(hdr);
  wrap.appendChild(b);
  wrap.appendChild(tl);
  _trPanelCurrentAssistantEl = wrap;
  _trPanelAgentBubble = b;
  _trPanelAgentTimeline = tl;
  _trRenderAll();
  return { bubble: b, timeline: tl };
}

function _trUpdateTimeline(step) {
  if (!_trPanelAgentTimeline) return;
  const item = document.createElement('div');
  item.className = 'tr-tl-item tr-active';
  const track = document.createElement('div');
  track.className = 'tr-tl-track';
  const dot = document.createElement('div');
  dot.className = 'tr-tl-dot tr-active';
  const line = document.createElement('div');
  line.className = 'tr-tl-line';
  track.appendChild(dot);
  track.appendChild(line);
  const content = document.createElement('div');
  content.className = 'tr-tl-content';
  const main = document.createElement('div');
  main.style.display = 'flex';
  main.style.alignItems = 'center';
  main.style.gap = '6px';
  const title = document.createElement('span');
  title.className = 'tr-tl-title';
  title.textContent = _trStepLabel(step);
  const badge = document.createElement('span');
  badge.className = 'tr-tl-badge tr-active';
  badge.textContent = 'active';
  main.appendChild(title);
  main.appendChild(badge);
  content.appendChild(main);
  item.appendChild(track);
  item.appendChild(content);

  const prev = _trPanelAgentTimeline.querySelectorAll('.tr-tl-item');
  if (prev.length > 0) {
    const last = prev[prev.length - 1];
    last.classList.remove('tr-active');
    last.classList.add('tr-done');
    const lastDot = last.querySelector('.tr-tl-dot');
    if (lastDot) { lastDot.classList.remove('tr-active'); lastDot.classList.add('tr-done'); }
    const lastBadge = last.querySelector('.tr-tl-badge');
    if (lastBadge) { lastBadge.className = 'tr-tl-badge tr-done'; lastBadge.textContent = 'done'; }
  }
  _trPanelAgentTimeline.appendChild(item);
}

// Terminal state of the last run. The previous code set 'completed' inside the
// try block and then reset to 'ready' in the finally block on the same tick, so
// the success state was never actually visible. `completed`/`error` are sticky
// until the next run starts.
let _trLastTerminalState = 'ready';

function _trFinalizeAssistant(text, steps, opts = {}) {
  // Success is passed in explicitly. It used to be inferred by regexing the
  // text for /error|failed|couldn't|unable|stopped/i, which meant a successful
  // run whose model reasoning happened to contain the word "failed" was
  // rendered as "Task failed".
  const isSuccess = opts.success === true;
  _trPanelMessages.push({
    role: 'assistant', content: text, steps: [...steps],
    timestamp: new Date().toISOString(), isResult: true, resultSuccess: isSuccess,
    followUps: Array.isArray(opts.followUps) ? opts.followUps : []
  });
  _trPanelCurrentAssistantEl = null;
  _trPanelAgentBubble = null;
  _trPanelAgentTimeline = null;
  _trPanelCurrentSteps = [];
  _trRenderAll();
}

// ========== WORKFLOW LOOP ==========

function _trBgSend(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(res);
    });
  });
}

async function _trGetAT() {
  // Direct extraction — no background roundtrip (same content-script world)
  try {
    return extractAccessibilityTree({ maxNodes: 2000 });
  } catch (e) {
    const res = await _trBgSend({ type: 'TRINETRA_REQUEST_AT', options: { maxNodes: 2000 } });
    if (!res || !res.success) throw new Error(res?.error || 'AT extraction failed');
    return res.at || [];
  }
}

async function _trGetScreenshot() {
  try {
    const res = await _trBgSend({ type: 'TRINETRA_CAPTURE_SCREENSHOT', options: { format: 'png', quality: 92 } });
    return (res && res.success && res.dataUrl) ? res.dataUrl : null;
  } catch (e) { return null; }
}

async function _trExecPlan({ actions, plan, at }) {
  const acts = actions || plan || [];
  try {
    const r = await executePlan({ actions: acts }, at || []);
    // Return both success and failure results — only fall through on thrown errors
    if (r) return r;
  } catch (e) {}
  const res = await _trBgSend({ type: 'TRINETRA_EXECUTE_PLAN_BG', plan: { actions: acts }, at: at || [] });
  if (!res || !res.success) throw new Error(res?.error || 'execute failed');
  return res.result;
}

// Delegates to the real 3-stage pipeline (lib/sanitization_engine.js), which is
// loaded via manifest.json. The previous passthrough here sent raw, un-redacted
// AT to the cloud while reporting an empty redaction report.
function _trSanitize(args) {
  const engine = (typeof window !== 'undefined' && window.TrinetraSanitizationEngine)
    || (typeof self !== 'undefined' && self.TrinetraSanitizationEngine)
    || null;
  if (engine && typeof engine.runSanitizationPipeline === 'function') {
    return engine.runSanitizationPipeline(args);
  }
  // No pipeline available — fail closed on the AT by sending nothing rather
  // than leaking the raw tree, and tell the caller redaction did not run.
  console.warn('[Trinetra] Sanitization engine not loaded — sending empty AT instead of raw data');
  return Promise.resolve({
    sanitizedScreenshot: args.screenshot,
    sanitizedAT: [],
    report: {
      redacted_regions: [],
      sanitized_at_summary: 'sanitizer unavailable — AT withheld',
      pipeline_unavailable: true,
      timestamp: new Date().toISOString(),
    },
  });
}

function _trGetReasonFn() {
  const lr = (typeof window !== 'undefined' && window.TrinetraLocalReasoning) || (typeof self !== 'undefined' && self.TrinetraLocalReasoning) || null;
  if (lr && lr.reasonLocally) return lr.reasonLocally;
  const stub = (typeof window !== 'undefined' && window.TrinetraStubProvider) || null;
  if (stub && stub.StubLLMProvider) {
    return async ({ at, userGoal, screenshot, threshold }) => {
      const c = await stub.StubLLMProvider.plan({ at, userGoal });
      return { ...c, needs_escalation: c.confidence < (threshold ?? 0.7), actions: c.actions, plan: c.plan, threshold };
    };
  }
  throw new Error('No reasoning provider available');
}

// Libs loaded via manifest.json content_scripts — no injection needed

async function _trHandleSend() {
  const input = _trPanelEl.querySelector('#tr-panel-input');
  const sendBtn = _trPanelEl.querySelector('#tr-send-btn');
  const goal = input.value.trim();
  if (!goal || _trPanelRunning) return;

  _trAddUserMsg(goal);
  input.value = '';
  input.style.height = 'auto';

  _trPanelRunning = true;
  sendBtn.textContent = '■';
  sendBtn.classList.add('tr-stop');
  // A new run clears the previous run's terminal state.
  _trLastTerminalState = 'running';
  _trSetState('thinking');

  _trStartAssistant();
  _trPanelCurrentSteps = [];

  const loop = (typeof window !== 'undefined' && window.TrinetraWorkflowLoop) || (typeof self !== 'undefined' && self.TrinetraWorkflowLoop) || null;
  if (!loop || !loop.runFullLoop) {
    _trFinalizeAssistant('Workflow engine not loaded. Reload the page.', _trPanelCurrentSteps, { success: false });
    _trPanelRunning = false;
    sendBtn.textContent = '^';
    sendBtn.classList.remove('tr-stop');
    _trSetState('ready');
    return;
  }

  const onStep = (payload) => {
    const stepObj = { ...payload, ts: Date.now() };
    _trPanelCurrentSteps.push(stepObj);
    if (payload.step === 'observe' || payload.step === 'observed') _trSetState('observing');
    else if (payload.step === 'reason' || payload.step === 'reasoned') { _trSetState('thinking'); if (payload.confidence != null) _trSetConfidence(payload.confidence); }
    else if (payload.step === 'cloud_call') { _trSetState('cloud'); _trSetCloud('cloud'); }
    else if (payload.step === 'cloud_result') {
      _trSetState('thinking');
      // Distinguish a real cloud answer from a silent local-stub downgrade.
      const cr = payload.cloudResult;
      if (cr && cr.degraded) {
        _trSetCloud('local');
        _trPanelCurrentSteps[_trPanelCurrentSteps.length - 1].note =
          `cloud unavailable - fell back to local rule engine (${cr.degraded_reason || 'unknown'})`;
      } else if (cr) {
        _trSetCloud('cloud-result');
      }
    }
    else if (payload.step === 'cloud_error') { _trSetState('error'); _trSetCloud('local'); }
    else if (payload.step === 'execute' || payload.step === 'executed' || payload.step === 'navigate_fallback') {
      _trSetState('executing');
      if (payload.source) _trSetCloud(payload.source === 'cloud' ? 'cloud-result' : 'local');
    }
    else if (payload.step === 'execute_failed' || payload.step === 'transition_failed' || payload.step === 'execute_error') _trSetState('error');
    else if (payload.step === 'page_transitioned') _trSetState('observing');
    else if (payload.step === 'evaluate' && payload.achieved) _trSetState('completed');
    else if (payload.step === 'sanitize') _trSetState('observing');
    _trUpdateTimeline(stepObj);
  };

  // Background proxy — content-script fetch to http://localhost is blocked as mixed content on HTTPS pages
  async function _trCloudCall(payload) {
    const res = await _trBgSend({ type: 'TRINETRA_CLOUD_ACT', payload, serverUrl: 'http://localhost:3001/api/agent/act' });
    if (!res || !res.success) {
      const detail = res?.details?.error || res?.details?.reason || res?.error || 'Cloud proxy failed';
      throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
    }
    return res.result;
  }

  try {
    const result = await loop.runFullLoop({
      userGoal: goal,
      getAT: _trGetAT,
      getScreenshot: null, // VLM disabled — skip capture entirely (faster observe)
      executePlanFn: _trExecPlan,
      reasonFn: _trGetReasonFn(),
      sanitizeFn: _trSanitize,
      cloudCallFn: _trCloudCall,
      serverUrl: 'http://localhost:3001/api/agent/act',
      confirmPurchaseFn: _trConfirmPurchase,
      onStep,
      maxIterations: 10,
      threshold: 0.7,
      reloadPageFn: async () => { try { await _trBgSend({ type: 'TRINETRA_RELOAD_TAB' }); } catch (e) {} },
    });

    // The summary/follow-ups are built in lib/workflow_loop.js so the
    // classification is testable rather than living in the panel.
    const loopLib = (typeof window !== 'undefined' && window.TrinetraWorkflowLoop)
      || (typeof self !== 'undefined' && self.TrinetraWorkflowLoop) || null;
    const summary = loopLib && loopLib.buildResultSummary
      ? loopLib.buildResultSummary(result, goal)
      : {
          success: result.success === true,
          title: result.success ? 'Task completed' : 'Task stopped',
          body: (result.success ? 'Completed' : 'Stopped') + ' after ' + (result.iteration || 0) + ' iterations' +
                (result.reason ? '\n' + result.reason : ''),
          followUps: [],
        };

    if (summary.success) { _trSetState('completed'); _trLastTerminalState = 'completed'; }
    else { _trSetState('error'); _trLastTerminalState = 'error'; }

    _trFinalizeAssistant(summary.body, _trPanelCurrentSteps, {
      success: summary.success,
      followUps: summary.followUps,
    });
  } catch (err) {
    console.error('[Trinetra] loop error', err);
    _trSetState('error');
    _trLastTerminalState = 'error';
    _trHideConfidence();
    _trFinalizeAssistant('Error: ' + err.message, _trPanelCurrentSteps, { success: false });
  } finally {
    _trPanelRunning = false;
    sendBtn.textContent = '^';
    sendBtn.classList.remove('tr-stop');
    // Preserve a terminal 'completed' / 'error' state — resetting to 'ready'
    // here on the same tick as the success message made the completion
    // invisible. It stays sticky until the next run starts.
    if (_trLastTerminalState !== 'completed' && _trLastTerminalState !== 'error') {
      _trSetState('ready');
    }
    _trHideConfidence();
    if (_trLastTerminalState !== 'completed') input.focus();
  }
}

console.log('[Trinetra] content script loaded — AT + action executor + approval modal + panel ready');
} // end idempotent guard
if (typeof window !== 'undefined' && window.__TRINETRA_CONTENT_SCRIPT_LOADED && !window.__TRINETRA_CONTENT_SCRIPT_LISTENER) {
  window.__TRINETRA_CONTENT_SCRIPT_LISTENER = true;
}
