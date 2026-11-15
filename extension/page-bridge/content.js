// Runs in the page's isolated world. Builds a compact model of what a person could read or
// operate on the page, and performs single operations on it. Loaded on demand, once per document.
(() => {
  if (window.__assistantPage) return;
  // Reading is cheap here, so the limits are generous: cutting a page off by document order would
  // lose whatever happens to come last. Plain text gives way first, controls last.
  const MAX_NODES = 4000, MAX_TEXT_NODES = 1500, MAX_TEXT = 220;
  // Element numbers restart in every document, so each document also gets a name of its own.
  // An action that names another document is refused instead of landing on a look-alike.
  const DOCUMENT = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const MAX_EXTRA = 200;
  let counter = 0;
  const ids = new WeakMap(), refs = new Map();
  const idOf = el => {
    let id = ids.get(el);
    if (!id) { id = ++counter; ids.set(el, id); refs.set(id, new WeakRef(el)); }
    return id;
  };
  const clean = (text, max = 160) => {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    return value.length > max ? value.slice(0, max - 1) + '…' : value;
  };
  const ROLE_ALIAS = { textbox: 'textfield', searchbox: 'searchfield', radio: 'radiobutton', img: 'image' };
  const CONTAINER_ROLES = new Set(['dialog', 'alertdialog', 'form', 'navigation', 'main', 'banner', 'contentinfo', 'complementary',
    'region', 'list', 'listitem', 'table', 'row', 'toolbar', 'menu', 'menubar', 'tablist', 'tabpanel', 'group', 'grid', 'listbox',
    'search', 'article', 'feed', 'tree']);
  const CLICK_ROLES = new Set(['link', 'button', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'checkbox',
    'radiobutton', 'switch', 'treeitem', 'gridcell']);
  const TEXT_INPUTS = new Set(['', 'text', 'email', 'url', 'tel', 'password', 'number', 'search', 'date', 'time', 'datetime-local', 'month', 'week']);
  const LEAF_TEXT = new Set(['P', 'SPAN', 'DIV', 'TD', 'TH', 'LI', 'LABEL', 'DD', 'DT', 'STRONG', 'EM', 'B', 'H4', 'H5', 'H6',
    'CAPTION', 'FIGCAPTION', 'TIME', 'OUTPUT', 'SMALL', 'CODE', 'PRE', 'BLOCKQUOTE']);

  function roleOf(el) {
    const explicit = (el.getAttribute('role') || '').trim().split(/\s+/)[0].toLowerCase();
    if (explicit && explicit !== 'presentation' && explicit !== 'none') return ROLE_ALIAS[explicit] || explicit;
    const tag = el.tagName;
    if (tag === 'VIDEO' || tag === 'AUDIO') return tag.toLowerCase();
    if (tag === 'A') return el.hasAttribute('href') ? 'link' : '';
    if (tag === 'BUTTON' || tag === 'SUMMARY') return 'button';
    if (tag === 'INPUT') {
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (type === 'hidden') return '';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radiobutton';
      if (type === 'range') return 'slider';
      if (['button', 'submit', 'reset', 'image', 'file'].includes(type)) return 'button';
      if (type === 'search') return 'searchfield';
      return TEXT_INPUTS.has(type) ? 'textfield' : 'textfield';
    }
    if (tag === 'TEXTAREA') return 'textarea';
    if (tag === 'SELECT') return 'combobox';
    if (el.isContentEditable && (!el.parentElement || !el.parentElement.isContentEditable)) return 'textarea';
    if (/^H[1-3]$/.test(tag)) return 'heading';
    if (tag === 'DIALOG') return 'dialog';
    if (tag === 'NAV') return 'navigation';
    if (tag === 'MAIN') return 'main';
    if (tag === 'FORM') return 'form';
    if (tag === 'UL' || tag === 'OL') return 'list';
    if (tag === 'LI') return 'listitem';
    if (tag === 'TABLE') return 'table';
    if (tag === 'TR') return 'row';
    if (tag === 'HEADER' && !el.closest('article, section')) return 'banner';
    if (tag === 'FOOTER' && !el.closest('article, section')) return 'contentinfo';
    if (tag === 'ASIDE') return 'complementary';
    if (tag === 'ARTICLE') return 'article';
    if ((tag === 'SECTION' || tag === 'FIELDSET' || tag === 'DETAILS') && (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || tag !== 'SECTION')) return tag === 'SECTION' ? 'region' : 'group';
    if (tag === 'IMG' && (el.getAttribute('alt') || '').trim()) return 'image';
    return '';
  }

  function nameOf(el, role) {
    if (role === 'video' || role === 'audio') return clean(el.getAttribute('aria-label') || el.title || role + ' playback');
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy.split(/\s+/).map(id => document.getElementById(id)).filter(Boolean).map(node => node.innerText || node.textContent).join(' ');
      if (clean(text)) return clean(text);
    }
    const aria = el.getAttribute('aria-label');
    if (clean(aria)) return clean(aria);
    if (el.labels && el.labels.length) {
      const text = Array.from(el.labels).map(label => label.innerText || label.textContent).join(' ');
      if (clean(text)) return clean(text);
    }
    const tag = el.tagName;
    if (tag === 'IMG') return clean(el.getAttribute('alt') || el.title);
    if (tag === 'INPUT' && ['button', 'submit', 'reset'].includes((el.type || '').toLowerCase())) return clean(el.value || el.type);
    if (tag === 'FIELDSET') return clean(el.querySelector('legend')?.innerText);
    const editable = ['textfield', 'searchfield', 'textarea', 'combobox', 'slider'].includes(role) ||
      el.tagName === 'TEXTAREA' || el.isContentEditable || (el.tagName === 'INPUT' && TEXT_INPUTS.has((el.getAttribute('type') || '').toLowerCase()));
    if (!editable && !CONTAINER_ROLES.has(role)) {
      const text = clean(el.innerText || el.textContent);
      if (text) return text;
      const image = el.querySelector('img[alt], svg[aria-label], [aria-label]');
      if (image) return clean(image.getAttribute('alt') || image.getAttribute('aria-label'));
    }
    return clean(el.getAttribute('placeholder') || el.title || (editable ? el.getAttribute('name') : ''));
  }

  function valueOf(el, role) {
    const tag = el.tagName;
    if (tag === 'VIDEO' || tag === 'AUDIO') return String(el.currentTime);
    if (tag === 'INPUT') {
      const type = (el.type || '').toLowerCase();
      // A password is never read out of the page.
      if (type === 'password' || type === 'checkbox' || type === 'radio' || type === 'file') return '';
      return clean(el.value, 500);
    }
    if (tag === 'TEXTAREA') return clean(el.value, 500);
    if (tag === 'SELECT') return clean(Array.from(el.selectedOptions).map(option => option.text).join(', '), 300);
    if (role === 'textarea' && el.isContentEditable) return clean(el.innerText, 500);
    return clean(el.getAttribute('aria-valuetext') || el.getAttribute('aria-valuenow') || '', 100);
  }

  function describe(el, role) {
    const tag = el.tagName, states = [], actions = [];
    if (tag === 'VIDEO' || tag === 'AUDIO') {
      states.push(el.ended ? 'ended' : el.paused ? 'paused' : 'playing');
      if (el.readyState < 3) states.push('buffering');
      actions.push('ScrollTo');
    }
    const disabled = el.disabled === true || el.getAttribute('aria-disabled') === 'true' || !!el.closest('fieldset[disabled]');
    if (disabled) states.push('disabled');
    const checked = el.getAttribute('aria-checked') === 'true' || el.checked === true;
    if (checked && ['checkbox', 'radiobutton', 'switch', 'menuitemcheckbox', 'menuitemradio'].includes(role)) states.push('checked');
    if (el.getAttribute('aria-selected') === 'true' || el.selected === true) states.push('selected');
    if (el.getAttribute('aria-expanded') === 'true' || (tag === 'DETAILS' && el.open)) states.push('expanded');
    if (el.getAttribute('aria-current') && el.getAttribute('aria-current') !== 'false') states.push('current');
    if (document.activeElement === el) states.push('focused');
    if (el.readOnly === true || el.getAttribute('aria-readonly') === 'true') states.push('readonly');
    if (el.required === true || el.getAttribute('aria-required') === 'true') states.push('required');
    if (tag === 'INPUT' && (el.type || '').toLowerCase() === 'password') states.push('secure');
    if ((tag === 'DIALOG' && el.matches(':modal')) || el.getAttribute('aria-modal') === 'true') states.push('modal');
    if (el.getAttribute('aria-invalid') === 'true') states.push('invalid');
    const rect = el.getBoundingClientRect();
    const offscreen = rect.bottom < 0 || rect.right < 0 || rect.top > innerHeight || rect.left > innerWidth;
    if (offscreen) states.push('offscreen');
    // What can be typed into is decided by what the element is, not by the role it announces:
    // a search box is commonly an <input> that calls itself a combobox.
    const inputType = tag === 'INPUT' ? (el.getAttribute('type') || '').toLowerCase() : '';
    const editable = (tag === 'INPUT' && TEXT_INPUTS.has(inputType)) || tag === 'TEXTAREA' || el.isContentEditable ||
      ['textfield', 'searchfield', 'textarea'].includes(role);
    if (CLICK_ROLES.has(role) || role === 'combobox' || el.hasAttribute('onclick') || (tag === 'LABEL' && el.control)) actions.push('Click');
    if (['checkbox', 'radiobutton', 'switch', 'menuitemcheckbox'].includes(role)) actions.push('Check', 'Uncheck');
    if (editable && !states.includes('readonly')) actions.push('SetValue', 'TypeText');
    if (tag === 'SELECT') actions.push('Select');
    if (editable || tag === 'SELECT' || CLICK_ROLES.has(role) || el.tabIndex >= 0) actions.push('SetFocus');
    if (actions.length || role === 'heading') actions.push('ScrollTo');
    return { states, actions: [...new Set(actions)],
      bounds: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } };
  }

  function snapshot(query) {
    const started = performance.now();
    let count = 0, texts = 0, truncated = false, frames = 0;
    // Past the size limit nothing is listed wholesale, but anything matching the search still is,
    // so a control far down a very long page can always be found.
    const wanted = String(query || '').toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || [];
    const matches = text => { const lower = text.toLowerCase(); return wanted.some(token => lower.includes(token)); };
    const extra = { id: 0, role: 'group', name: 'Matches further down this page', value: '', states: [], actions: [], children: [] };
    const root = { id: 0, role: 'webarea', name: clean(document.title, 200), value: location.href, states: [], actions: [], children: [] };
    const visit = (el, parent, insideNamed) => {
      const overflow = count >= MAX_NODES;
      if (overflow) { truncated = true; if (!wanted.length || extra.children.length >= MAX_EXTRA) return; }
      const tag = el.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE' || tag === 'HEAD') return;
      if (tag === 'IFRAME' || tag === 'FRAME') { frames++; return; }
      if (el.getAttribute('aria-hidden') === 'true' || el.hidden) return;
      if (el.checkVisibility && !el.checkVisibility({ checkVisibilityCSS: true })) {
        // An element with display: contents has no box of its own, but its children are drawn.
        if (getComputedStyle(el).display === 'contents') {
          for (const child of el.children) visit(child, parent, insideNamed);
          if (el.shadowRoot) for (const child of el.shadowRoot.children) visit(child, parent, insideNamed);
        }
        return;
      }
      const role = roleOf(el);
      if (overflow) {
        if (role && !CONTAINER_ROLES.has(role)) {
          const name = nameOf(el, role), details = describe(el, role);
          if (details.actions.length > 1 && details.bounds.width > 0 && matches(name + ' ' + valueOf(el, role)))
            extra.children.push({ id: idOf(el), role, name, value: valueOf(el, role), states: details.states, actions: details.actions, bounds: details.bounds, children: [] });
        } else if (!role && LEAF_TEXT.has(tag) && el.childElementCount === 0 && !insideNamed) {
          const text = clean(el.textContent, MAX_TEXT);
          if (text.length >= 2 && matches(text)) extra.children.push({ id: idOf(el), role: 'statictext', name: text, value: '', states: [], actions: [], children: [] });
        }
        for (const child of el.children) visit(child, parent, insideNamed);
        if (el.shadowRoot) for (const child of el.shadowRoot.children) visit(child, parent, insideNamed);
        return;
      }
      let next = parent, named = insideNamed;
      if (role) {
        const container = CONTAINER_ROLES.has(role);
        const name = nameOf(el, role);
        const details = describe(el, role);
        const worth = container || details.actions.length > 1 || role === 'heading' || role === 'image' || role === 'video' || role === 'audio' || details.states.includes('modal');
        if (worth && (details.bounds.width > 0 || container)) {
          const node = { id: idOf(el), role, name, value: valueOf(el, role), states: details.states, actions: details.actions,
            bounds: details.bounds, children: [] };
          parent.children.push(node);
          count++;
          next = node;
          // A named control already carries the text inside it; do not list that text again.
          named = named || (!container && !!name);
        }
      }
      // Text is content whatever role wraps it: a live announcement is something to read, never a blocker.
      if (next === parent && !insideNamed && el.childElementCount === 0 && (LEAF_TEXT.has(tag) || role)) {
        // A label's text is already the name of the control it labels.
        if (tag === 'LABEL' && el.control) return;
        const text = clean(el.textContent, MAX_TEXT);
        if (texts >= MAX_TEXT_NODES) {
          truncated = true;
          if (text.length >= 2 && wanted.length && extra.children.length < MAX_EXTRA && matches(text))
            extra.children.push({ id: idOf(el), role: 'statictext', name: text, value: '', states: [], actions: [], children: [] });
          return;
        }
        if (text.length >= 2) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            parent.children.push({ id: idOf(el), role: 'statictext', name: text, value: '', actions: [],
              states: rect.bottom < 0 || rect.top > innerHeight ? ['offscreen'] : [], children: [] });
            count++;
            texts++;
          }
        }
        return;
      }
      for (const child of el.children) visit(child, next, named);
      if (el.shadowRoot) for (const child of el.shadowRoot.children) visit(child, next, named);
    };
    if (document.body) visit(document.body, root, false);
    // Containers that ended up holding nothing a person could use only add noise.
    const prune = node => {
      node.children = node.children.filter(child => {
        prune(child);
        return child.children.length || !CONTAINER_ROLES.has(child.role) || child.states.includes('modal');
      });
    };
    prune(root);
    if (extra.children.length) root.children.push(extra);
    return { document: DOCUMENT, url: location.href, title: document.title, readyState: document.readyState, nodes: root, count, truncated, frames,
      ms: Math.round((performance.now() - started) * 10) / 10 };
  }

  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value); else el.value = value;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: value }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function pointerClick(el) {
    const rect = el.getBoundingClientRect();
    const init = { bubbles: true, cancelable: true, composed: true, view: window, button: 0,
      clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
    el.dispatchEvent(new PointerEvent('pointerdown', { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
    el.dispatchEvent(new MouseEvent('mousedown', init));
    if (typeof el.focus === 'function') el.focus({ preventScroll: true });
    el.dispatchEvent(new PointerEvent('pointerup', { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
    el.dispatchEvent(new MouseEvent('mouseup', init));
    el.click();
  }
  const KEYS = { return: ['Enter', 'Enter', 13], escape: ['Escape', 'Escape', 27], space: [' ', 'Space', 32],
    up: ['ArrowUp', 'ArrowUp', 38], down: ['ArrowDown', 'ArrowDown', 40] };

  // Every result says two separate things: whether anything was sent to the page (dispatched), and
  // what was seen afterwards (verified, observedValue). "Sent but not yet confirmed" is never
  // reported as "not sent": that would make a repeat look safe.
  const refused = (code, message) => ({ dispatched: false, code, message });
  function act(id, operation, argument, options) {
    if (options && options.document && options.document !== DOCUMENT) return refused('STALE', 'The page has changed since it was read.');
    const el = id ? refs.get(id)?.deref() : document.activeElement;
    if (!el || !el.isConnected) return refused('STALE', 'That element is no longer on the page.');
    if (el.disabled === true || el.getAttribute?.('aria-disabled') === 'true') return refused('DISABLED', 'That element is disabled.');
    // A key goes to whatever has focus. If that is no longer the field it was meant for, send nothing.
    if (operation === 'press' && options && options.requireFocus && document.activeElement !== el)
      return refused('FOCUS_MOVED', 'Keyboard focus is no longer on that field.');
    if (operation !== 'scroll' && operation !== 'press' && typeof el.scrollIntoView === 'function') {
      const rect = el.getBoundingClientRect();
      if (rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth) el.scrollIntoView({ block: 'center', inline: 'nearest' });
    }
    const editable = el.isContentEditable;
    const read = () => (editable ? el.innerText : el.tagName === 'SELECT' ? Array.from(el.selectedOptions).map(o => o.text).join(', ') : el.value);
    const isChecked = () => (el.getAttribute('aria-checked') ? el.getAttribute('aria-checked') === 'true' : el.checked === true);
    switch (operation) {
      case 'click': pointerClick(el); return { dispatched: true };
      case 'focus': el.focus(); return { dispatched: true, verified: document.activeElement === el };
      case 'scrollTo': el.scrollIntoView({ block: 'center', inline: 'nearest' }); return { dispatched: true };
      case 'scroll': scrollBy({ top: (argument === 'up' ? -1 : argument === 'down' ? 1 : 0) * innerHeight * 0.8,
        left: (argument === 'left' ? -1 : argument === 'right' ? 1 : 0) * innerWidth * 0.8 }); return { dispatched: true };
      case 'check': case 'uncheck': {
        const want = operation === 'check';
        if (isChecked() === want) return { dispatched: false, already: true, verified: true };
        pointerClick(el);
        // The page may update the state a moment later; the click was sent either way.
        return { dispatched: true, verified: isChecked() === want };
      }
      case 'setValue': case 'type': {
        if (el.tagName === 'INPUT' && (el.type || '').toLowerCase() === 'password') return refused('SECURE', 'Passwords are not typed by the assistant.');
        if (!editable && !('value' in el)) return refused('NOT_EDITABLE', 'That element does not take text.');
        const selection = getSelection();
        // Typing goes where the caret already is, when it is inside this editor; otherwise at the end.
        const caretInside = editable && selection.rangeCount > 0 && el.contains(selection.anchorNode) && el.contains(selection.focusNode);
        const range = caretInside ? selection.getRangeAt(0).cloneRange() : null;
        let expectedValue = operation === 'setValue' ? String(argument) : undefined;
        el.focus();
        if (editable) {
          if (operation === 'setValue') selection.selectAllChildren(el);
          else if (range) { selection.removeAllRanges(); selection.addRange(range); }
          else { selection.selectAllChildren(el); selection.collapseToEnd(); }
          document.execCommand('insertText', false, String(argument));
        } else {
          const start = typeof el.selectionStart === 'number' ? el.selectionStart : el.value.length;
          const end = typeof el.selectionEnd === 'number' ? el.selectionEnd : el.value.length;
          expectedValue = operation === 'setValue' ? String(argument) : el.value.slice(0, start) + String(argument) + el.value.slice(end);
          setNativeValue(el, expectedValue);
        }
        // Compute the expectation before dispatch; a page handler can reject or transform input.
        // Rich-editor insertions without a reliable linear caret mapping remain unverified.
        const observedValue = String(read() ?? '');
        return { dispatched: true, expectedValue, observedValue: editable ? observedValue.replace(/\n$/, '') : observedValue };
      }
      case 'select': {
        if (el.tagName !== 'SELECT') return refused('NOT_SELECT', 'That element is not a list of options.');
        const wanted = String(argument).trim().toLowerCase();
        const option = Array.from(el.options).find(o => o.text.trim().toLowerCase() === wanted || o.value.toLowerCase() === wanted);
        if (!option) return refused('NO_OPTION', 'No option has that name. Options: ' + Array.from(el.options).slice(0, 20).map(o => o.text.trim()).join(', '));
        setNativeValue(el, option.value);
        return { dispatched: true, observedValue: read() };
      }
      case 'press': {
        const key = KEYS[argument];
        if (!key) return refused('KEY', 'That key is not available on a page.');
        const init = { key: key[0], code: key[1], keyCode: key[2], which: key[2], bubbles: true, cancelable: true, composed: true };
        const proceed = el.dispatchEvent(new KeyboardEvent('keydown', init));
        if (proceed && argument === 'return') {
          // What the browser itself does for Enter: submit the form, or activate the control.
          if (el.tagName === 'INPUT' && el.form) { if (typeof el.form.requestSubmit === 'function') el.form.requestSubmit(); else el.form.submit(); }
          else if (el.tagName === 'BUTTON' || el.tagName === 'A' || el.getAttribute('role') === 'button') el.click();
        }
        if (proceed && argument === 'space' && (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button')) el.click();
        el.dispatchEvent(new KeyboardEvent('keyup', init));
        return { dispatched: true };
      }
    }
    return refused('UNSUPPORTED', 'Unknown operation ' + operation);
  }

  window.__assistantPage = { snapshot, act };
})();
