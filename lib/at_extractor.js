// Trinetra — AT Extractor (Phase 2)
// Extracts DOM Accessibility Tree per Section 2.1.A
// Captures per node: role, name, state, bounds {x,y,width,height}
// Works as both content_script inline and standalone lib import.

// Infer implicit ARIA role from tag when explicit role missing
function inferRole(el) {
  if (el.getAttribute && el.getAttribute('role')) {
    return el.getAttribute('role');
  }
  const tag = el.tagName ? el.tagName.toLowerCase() : '';
  const type = el.getAttribute ? (el.getAttribute('type') || '').toLowerCase() : '';
  const roleMap = {
    a: el.hasAttribute && el.hasAttribute('href') ? 'link' : 'generic',
    button: 'button',
    input: type === 'checkbox' ? 'checkbox' : type === 'radio' ? 'radio' : type === 'password' ? 'textbox' : 'textbox',
    select: 'combobox',
    textarea: 'textbox',
    h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading',
    img: 'img',
    ul: 'list', ol: 'list', li: 'listitem',
    nav: 'navigation',
    header: 'banner',
    footer: 'contentinfo',
    main: 'main',
    form: 'form',
    table: 'table',
    tr: 'row',
    td: 'cell', th: 'columnheader',
  };
  return roleMap[tag] || 'generic';
}

function getAccessibleName(el) {
  // Priority: aria-label > aria-labelledby > alt > placeholder > textContent (trimmed)
  if (!el) return '';
  const ariaLabel = el.getAttribute && el.getAttribute('aria-label');
  if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();

  const ariaLabelledby = el.getAttribute && el.getAttribute('aria-labelledby');
  if (ariaLabelledby) {
    const ref = document.getElementById(ariaLabelledby);
    if (ref && ref.textContent) return ref.textContent.trim().slice(0, 200);
  }

  if (el.getAttribute) {
    const alt = el.getAttribute('alt');
    if (alt && alt.trim()) return alt.trim();
    const placeholder = el.getAttribute('placeholder');
    if (placeholder && placeholder.trim()) return placeholder.trim();
    const title = el.getAttribute('title');
    if (title && title.trim()) return title.trim();
  }

  // For inputs, also check associated label
  if (el.id) {
    const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (label && label.textContent) return label.textContent.trim().slice(0, 200);
  }

  // Fallback to textContent but truncated and normalized
  let text = '';
  if (el.textContent) {
    text = el.textContent.replace(/\s+/g, ' ').trim();
  }
  // If element has children with text, prefer direct visible text slice
  if (text.length > 300) text = text.slice(0, 300);
  return text;
}

function getState(el) {
  const state = {};
  if (!el) return state;
  if (el.disabled) state.disabled = true;
  if (el.checked !== undefined) state.checked = !!el.checked;
  if (el.getAttribute) {
    const ariaDisabled = el.getAttribute('aria-disabled');
    if (ariaDisabled === 'true') state.disabled = true;
    const ariaChecked = el.getAttribute('aria-checked');
    if (ariaChecked !== null) state.checked = ariaChecked === 'true';
    const ariaExpanded = el.getAttribute('aria-expanded');
    if (ariaExpanded !== null) state.expanded = ariaExpanded === 'true';
    const ariaSelected = el.getAttribute('aria-selected');
    if (ariaSelected !== null) state.selected = ariaSelected === 'true';
    const ariaHidden = el.getAttribute('aria-hidden');
    if (ariaHidden === 'true') state.hidden = true;
  }
  // visibility check
  const style = window.getComputedStyle ? window.getComputedStyle(el) : null;
  if (style) {
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      state.hidden = true;
    }
  }
  return state;
}

function getBounds(el) {
  try {
    const rect = el.getBoundingClientRect();
    return {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    };
  } catch (e) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
}

// Main extractor — walks DOM and returns array of { id, role, name, state, bounds, tag, selector }
function extractAccessibilityTree(options = {}) {
  const { maxNodes = 2000, includeHidden = false } = options;
  const nodes = [];
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT, null);

  let el = walker.currentNode;
  let index = 0;

  // Manual iteration starting from body
  const allElements = document.querySelectorAll('*');
  for (let i = 0; i < allElements.length && nodes.length < maxNodes; i++) {
    const elem = allElements[i];
    // Skip script/style/noscript/meta/link
    const tag = elem.tagName ? elem.tagName.toLowerCase() : '';
    if (['script', 'style', 'noscript', 'meta', 'link', 'head'].includes(tag)) continue;

    const state = getState(elem);
    if (!includeHidden && state.hidden) continue;

    const bounds = getBounds(elem);
    // Optionally skip zero-area hidden nodes but keep interactive ones and price/query-relevant generics (Flipkart)
    const isInteractive = ['a', 'button', 'input', 'select', 'textarea'].includes(tag) || elem.getAttribute('role');
    const role = inferRole(elem);
    const name = getAccessibleName(elem);
    const isPriceLike = /₹|rs\.?|price|\$|\d[\d,]*\s*(₹|rs)/i.test(name || '');
    if (!isInteractive && !isPriceLike && bounds.width === 0 && bounds.height === 0) continue;

    // Only include nodes that have semantic value: role != generic OR has name OR interactive
    if (role === 'generic' && !name && !isInteractive) continue;

    const id = `node_${index++}`;
    elem.setAttribute('data-trinetra-id', id);

    nodes.push({
      id,
      role,
      name: name || '',
      state,
      bounds,
      tag,
      // lightweight selector for action execution fallback
      selector: generateSelector(elem)
    });
  }

  return nodes;
}

function generateSelector(el) {
  try {
    if (el.id) return `#${CSS.escape(el.id)}`;
    let selector = el.tagName.toLowerCase();
    if (el.className && typeof el.className === 'string') {
      const classes = el.className.trim().split(/\s+/).slice(0, 2).map(c => `.${CSS.escape(c)}`).join('');
      if (classes) selector += classes;
    }
    return selector;
  } catch (e) {
    return el.tagName ? el.tagName.toLowerCase() : '*';
  }
}

// Export for testing / module usage
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { extractAccessibilityTree, inferRole, getAccessibleName, getState, getBounds };
}

// Also expose globally for content_script non-module context
if (typeof window !== 'undefined') {
  window.TrinetraATExtractor = { extractAccessibilityTree, inferRole, getAccessibleName, getState, getBounds };
}
