// Trinetra — content script (Phases 2 + 6 + 8)
// Responsibilities: AT extraction, action injection, approval UI, message bridge.
// Phase 2: AT extraction via lib/at_extractor.js logic (inlined helpers + message handler).
// Future phases will extend this file without breaking Phase 2 API.

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

function extractAccessibilityTree(options = {}) {
  const { maxNodes = 2000, includeHidden = false } = options;
  const nodes = [];
  const allElements = document.querySelectorAll('*');
  let index = 0;
  for (let i = 0; i < allElements.length && nodes.length < maxNodes; i++) {
    const elem = allElements[i];
    const tag = elem.tagName ? elem.tagName.toLowerCase() : '';
    if (['script', 'style', 'noscript', 'meta', 'link', 'head'].includes(tag)) continue;
    const state = getState(elem);
    if (!includeHidden && state.hidden) continue;
    const bounds = getBounds(elem);
    const isInteractive = ['a', 'button', 'input', 'select', 'textarea'].includes(tag) || elem.getAttribute('role');
    if (!isInteractive && bounds.width === 0 && bounds.height === 0) continue;
    const role = inferRole(elem);
    const name = getAccessibleName(elem);
    if (role === 'generic' && !name && !isInteractive) continue;
    const id = `node_${index++}`;
    try { elem.setAttribute('data-trinetra-id', id); } catch (e) {}
    nodes.push({ id, role, name: name || '', state, bounds, tag, selector: generateSelector(elem) });
  }
  return nodes;
}

// --- Approval Modal (Phase 6) ---
let _approvalResolver = null;

function ensureApprovalModal() {
  if (document.getElementById('trinetra-approval-modal')) return;
  const style = document.createElement('style');
  style.textContent = `
    #trinetra-approval-modal { position: fixed; inset: 0; z-index: 2147483647; display: none; align-items: center; justify-content: center; background: rgba(0,0,0,0.55); font-family: system-ui, sans-serif; }
    #trinetra-approval-modal.trinetra-visible { display: flex; }
    #trinetra-approval-card { background: #0f172a; color: #e2e8f0; border: 1px solid #334155; border-radius: 12px; padding: 20px; width: 420px; max-width: 90vw; box-shadow: 0 20px 40px rgba(0,0,0,0.4); }
    #trinetra-approval-card h3 { margin: 0 0 8px; font-size: 15px; color: #f8fafc; }
    #trinetra-approval-card p { margin: 0 0 14px; font-size: 12px; color: #cbd5e1; line-height: 1.5; }
    #trinetra-approval-card .trinetra-target { background: #1e293b; padding: 6px 8px; border-radius: 6px; font-size: 11px; color: #94a3b8; margin-bottom: 14px; word-break: break-all; }
    #trinetra-approval-actions { display: flex; gap: 10px; justify-content: flex-end; }
    #trinetra-approval-actions button { padding: 8px 16px; border-radius: 8px; font-weight: 700; font-size: 12px; cursor: pointer; border: none; }
    #trinetra-approve-btn { background: #0ea5e9; color: white; }
    #trinetra-approve-btn:hover { background: #0284c7; }
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
  if (_approvalResolver) {
    _approvalResolver(approved);
    _approvalResolver = null;
  }
}

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
  return new Promise((resolve) => { _approvalResolver = resolve; });
}

// Expose globally for lib/action_executor.js
window.TrinetraShowApprovalModal = showApprovalModal;
if (typeof self !== 'undefined') self.TrinetraShowApprovalModal = showApprovalModal;

// --- Action helpers (mirrors lib/action_executor.js for content script context) ---
const RESTRICTED_SET = new Set(['type','fill','submit','confirm','payment','payments','sensitive_ops']);
function isRestricted(type) { return RESTRICTED_SET.has((type||'').toLowerCase()); }
function resolveTarget(target) {
  if (!target) return null;
  const mode = (target.mode||'').toLowerCase();
  const value = target.value;
  if (mode === 'at_node_id') return document.querySelector(`[data-trinetra-id="${CSS.escape(value)}"]`);
  if (mode === 'css_selector') { try { return document.querySelector(value); } catch(e){ return null; } }
  if (mode === 'bbox') {
    let bbox = value; if (typeof value==='string') bbox = value.split(',').map(Number);
    if (Array.isArray(bbox) && bbox.length>=4) return document.elementFromPoint(bbox[0]+bbox[2]/2, bbox[1]+bbox[3]/2);
  }
  return null;
}
async function execScroll(action){ const amt=action.params?.amount??action.amount??300; const t=resolveTarget(action.target); if(t&&t.scrollBy) t.scrollBy({top:amt,behavior:'smooth'}); else window.scrollBy({top:amt,behavior:'smooth'}); await new Promise(r=>setTimeout(r,400)); return {success:true,type:'scroll',amount:amt};}
async function execClick(action){
  let el=resolveTarget(action.target);
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
      // stop immediate propagation to inline handler already removed, but keep for safety
      el.dispatchEvent(evt);
      await new Promise(r=>setTimeout(r,300));
      return {success:true,type:'click', via:'dispatched', blocked_javascript:true};
    }
  } catch(e){}
  // Use safe click that doesn't trigger javascript: navigation via href
  try {
    el.click();
  } catch(e) {
    // fallback dispatch
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }
  await new Promise(r=>setTimeout(r,300));
  return {success:true,type:'click'};
}
async function execNavigate(action){
  const url=action.params?.url||action.target?.value;
  if(!url) return {success:false,error:'navigate missing url'};
  if(typeof url==='string' && url.trim().toLowerCase().startsWith('javascript:')) return {success:false,error:'navigate blocked: javascript: URL violates CSP'};
  if(typeof url==='string' && !url.startsWith('http') && !url.startsWith('/') && !url.startsWith('#')) return {success:false,error:'navigate blocked: only http(s) URLs allowed'};
  try {
    const bgRes = await new Promise((resolve)=>{
      try { chrome.runtime.sendMessage({type:'TRINETRA_NAVIGATE', url}, (r)=> resolve(r)); } catch(e){ resolve(null); }
    });
    if(bgRes && bgRes.success) return {success:true,type:'navigate',url, via:'background'};
    if(bgRes && bgRes.error) return {success:false,error:bgRes.error};
  } catch(e){}
  window.location.href=url;
  return {success:true,type:'navigate',url, via:'content'};
}
async function execRead(){ let at=[]; try{ at=extractAccessibilityTree(); }catch(e){} return {success:true,type:'read',at,count:at.length};}
async function execType(action){ const el=resolveTarget(action.target); if(!el) return {success:false,error:'type target not found'}; const text=action.params?.text??action.params?.value??''; el.focus(); if(el.tagName==='INPUT'||el.tagName==='TEXTAREA'||el.isContentEditable){ el.value=text; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); } await new Promise(r=>setTimeout(r,200)); return {success:true,type:'type'};}
async function execSubmit(action){ let el=resolveTarget(action.target)||document.querySelector('form'); if(!el) return {success:false,error:'submit target not found'}; if(el.tagName==='FORM') el.submit(); else el.click(); await new Promise(r=>setTimeout(r,300)); return {success:true,type:'submit'};}
async function executeAction(action){
  const type=(action.type||'').toLowerCase();
  const needsApproval = action.requires_approval===true || isRestricted(type);
  if(needsApproval){ const approved=await showApprovalModal(action); if(!approved) return {success:false,denied:true,reason:'User denied approval'}; }
  switch(type){
    case 'scroll': return execScroll(action);
    case 'click': return execClick(action);
    case 'navigate': return execNavigate(action);
    case 'read': case 'observe': return execRead(action);
    case 'type': case 'fill': return execType(action);
    case 'submit': case 'confirm': case 'payment': case 'payments': case 'sensitive_ops': return execSubmit(action);
    default: return {success:false,error:`Unknown action type: ${type}`};
  }
}
async function executePlan(plan){
  const actions=plan.actions||plan.plan||[];
  const results=[];
  for(const a of actions){ const r=await executeAction(a); results.push({action:a,result:r}); if(r.denied) return {success:false,denied:true,results}; await new Promise(x=>setTimeout(x,200)); }
  return {success:true,results};
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

  if (message.type === 'TRINETRA_EXECUTE_ACTION') {
    executeAction(message.action || {}).then(r => sendResponse({ success: !r.denied && r.success, result: r })).catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (message.type === 'TRINETRA_EXECUTE_PLAN') {
    executePlan(message.plan || {}).then(r => sendResponse({ success: r.success, result: r })).catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (message.type === 'TRINETRA_PING') {
    sendResponse({ success: true, message: 'Trinetra content script ready', url: location.href });
    return true;
  }
});

console.log('[Trinetra] content script loaded — AT + action executor + approval modal ready (Phase 6)');
