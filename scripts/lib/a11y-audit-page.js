// Page-side accessibility audit, evaluated inside the real side panel by scripts/e2e-a11y-audit.mjs.
// Defines window.__a11y with checks based on WCAG 2.2 AA. It is a test aid, not a conformance claim: it can't judge
// meaning, reading order as heard by a screen reader, or whether text is understandable.
(() => {
  if (window.__a11y) return;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const cx = canvas.getContext('2d', { willReadFrequently: true });
  /** Any CSS colour → [r, g, b, a] (0-255, a 0-1), using the browser's own colour parser. */
  const rgba = (css) => {
    cx.clearRect(0, 0, 1, 1);
    cx.fillStyle = '#000';
    cx.fillStyle = css;
    cx.fillRect(0, 0, 1, 1);
    const d = cx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3] / 255];
  };
  const lum = ([r, g, b]) => {
    const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const blend = (top, base) => top.slice(0, 3).map((v, i) => v * top[3] + base[i] * (1 - top[3]));
  const visible = (el) => {
    if (!el.isConnected) return false;
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      if (e.hidden) return false;
      const s = getComputedStyle(e);
      if (s.display === 'none' || s.visibility === 'hidden') return false;
      if (e.tagName === 'DETAILS' && !e.open && e !== el && !e.querySelector(':scope > summary')?.contains(el)) return false;
      if (e.tagName === 'DIALOG' && !e.open) return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  /** Effective opaque background behind an element (background colours only; images are not used here). */
  const background = (el) => {
    const layers = [];
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const c = rgba(getComputedStyle(e).backgroundColor);
      if (c[3] > 0) { layers.push(c); if (c[3] >= 1) break; }
    }
    let base = rgba(getComputedStyle(document.documentElement).backgroundColor);
    if (base[3] < 1) base = blend(base, [255, 255, 255]);
    base = base.slice(0, 3);
    for (const l of layers.reverse()) base = blend(l, base);
    return base;
  };
  const opacity = (el) => { let o = 1; for (let e = el; e && e.nodeType === 1; e = e.parentElement) o *= Number(getComputedStyle(e).opacity); return o; };
  const text = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();
  const byId = (id) => document.getElementById(id);
  const describe = (el) => {
    if (!el || el.nodeType !== 1) return String(el);
    const role = el.getAttribute('role');
    const cls = typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    const t = (el.getAttribute('aria-label') || text(el)).slice(0, 40);
    return `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${cls}${role ? `[role=${role}]` : ''}${t ? ` "${t}"` : ''}`;
  };
  const name = (el) => {
    const lb = el.getAttribute('aria-labelledby');
    if (lb) { const t = lb.split(/\s+/).map(byId).filter(Boolean).map(text).join(' ').trim(); if (t) return t; }
    const al = el.getAttribute('aria-label');
    if (al && al.trim()) return al.trim();
    if (el.labels && el.labels.length) { const t = [...el.labels].map(text).join(' ').trim(); if (t) return t; }
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return (el.getAttribute('title') || '').trim();
    if (el.tagName === 'IMG') return (el.getAttribute('alt') || '').trim();
    const t = text(el);
    return t || (el.getAttribute('title') || '').trim();
  };
  const INTERACTIVE = 'button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=option], [role=radio], [role=tab], [role=checkbox], [role=switch], [role=menuitem], [tabindex]:not([tabindex="-1"])';
  const disabled = (el) => !!el.closest(':disabled, [aria-disabled="true"]');

  function audit(rootSel = 'body') {
    const root = document.querySelector(rootSel) || document.body;
    const fails = [];
    const warns = [];
    const fail = (rule, el, detail = '') => fails.push({ rule, el: describe(el), detail });
    const warn = (rule, el, detail = '') => warns.push({ rule, el: describe(el), detail });
    const all = [...root.querySelectorAll('*')];
    const shown = all.filter(visible);

    // 4.1.1/4.1.2: unique ids (whole document, since labels and ARIA references are document-wide)
    const seen = new Map();
    for (const el of document.querySelectorAll('[id]')) { if (seen.has(el.id)) fail('duplicate id', el, el.id); else seen.set(el.id, el); }
    // ARIA id references must resolve
    for (const el of all) for (const a of ['aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns', 'aria-activedescendant']) {
      const v = el.getAttribute(a);
      if (v) for (const id of v.split(/\s+/)) if (!byId(id)) fail(`${a} points to a missing id`, el, id);
    }
    // 4.1.2: every visible interactive element has an accessible name
    for (const el of shown.filter((e) => e.matches(INTERACTIVE))) if (!name(el)) fail('control without an accessible name', el);
    // Widget roles in the right container, and composite widgets with one tab stop (roving tabindex)
    const ctx = { option: '[role=listbox]', radio: '[role=radiogroup]', tab: '[role=tablist]' };
    for (const [role, parent] of Object.entries(ctx)) for (const el of root.querySelectorAll(`[role=${role}]`)) {
      if (!el.parentElement?.closest(parent)) fail(`role=${role} outside ${parent}`, el);
    }
    for (const box of root.querySelectorAll('[role=listbox], [role=radiogroup], [role=tablist]')) {
      if (!visible(box)) continue;
      if (!name(box) && !box.getAttribute('aria-label') && !box.getAttribute('aria-labelledby')) fail('composite widget without a name', box);
      const items = [...box.querySelectorAll('[role=option], [role=radio], [role=tab]')];
      const stops = items.filter((i) => i.tabIndex >= 0 && i.getAttribute('tabindex') !== '-1');
      if (items.length && stops.length !== 1) fail('composite widget must have exactly one tab stop (roving tabindex)', box, `${stops.length} of ${items.length} items are tab stops`);
      for (const i of box.querySelectorAll('[role=option]')) if (!i.hasAttribute('aria-selected')) fail('option without aria-selected', i);
    }
    for (const el of shown.filter((e) => e.matches('[aria-pressed]'))) if (!/^(true|false|mixed)$/.test(el.getAttribute('aria-pressed'))) fail('invalid aria-pressed', el);
    // 1.4.3: text contrast (large text 3:1, other text 4.5:1). Inactive controls are exempt.
    for (const el of shown) {
      const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      if (!own || disabled(el) || el.closest('[aria-hidden="true"]')) continue;
      const s = getComputedStyle(el);
      const size = parseFloat(s.fontSize);
      const large = size >= 24 || (size >= 18.66 && Number(s.fontWeight) >= 700);
      const bg = background(el);
      const fg = rgba(s.color);
      fg[3] *= opacity(el);
      const r = ratio(blend(fg, bg), bg);
      const need = large ? 3 : 4.5;
      if (r + 0.005 < need) fail('text contrast below WCAG AA', el, `${r.toFixed(2)}:1, needs ${need}:1 (${s.color} on rgb(${bg.map(Math.round).join(',')}))`);
    }
    // 1.4.11: form field boundaries (border or fill) at least 3:1 against what surrounds them
    for (const el of shown.filter((e) => e.matches('input:not([type=radio]):not([type=checkbox]):not([type=range]), textarea, select'))) {
      if (disabled(el)) continue;
      const s = getComputedStyle(el);
      const around = background(el.parentElement);
      const border = parseFloat(s.borderBottomWidth) > 0 && s.borderBottomStyle !== 'none' ? ratio(rgba(s.borderBottomColor).slice(0, 3), around) : 0;
      const fill = ratio(background(el), around);
      if (Math.max(border, fill) < 3) fail('form field boundary contrast below 3:1', el, `border ${border.toFixed(2)}:1, fill ${fill.toFixed(2)}:1`);
    }
    // 2.5.8: targets at least 24 by 24 CSS px (inline links inside a sentence are exempt)
    for (const el of shown.filter((e) => e.matches('button, input, select, textarea, summary, [role=button], [role=option], [role=radio], [role=tab], [role=checkbox]'))) {
      if (el.matches('a') && getComputedStyle(el).display === 'inline') continue;
      const r = el.getBoundingClientRect();
      let target = r;
      // A label that wraps or points to an input is part of its target (clicking it activates the input).
      if (el.matches('input') && el.labels?.[0]) {
        const lr = el.labels[0].getBoundingClientRect();
        if (lr.width * lr.height > r.width * r.height) target = lr;
      }
      if (target.width < 24 - 0.5 || target.height < 24 - 0.5) fail('target smaller than 24 by 24 px', el, `${Math.round(target.width)}x${Math.round(target.height)}`);
    }
    // Live regions: none nested inside another
    const live = all.filter((e) => e.matches('[aria-live], [role=status], [role=alert], [role=log]'));
    for (const el of live) if (el.parentElement?.closest('[aria-live], [role=status], [role=alert], [role=log]')) warn('live region nested inside another', el);
    // Headings: skipped levels inside the root
    let last = 0;
    for (const hd of shown.filter((e) => /^H[1-6]$/.test(e.tagName))) {
      const lvl = Number(hd.tagName[1]);
      if (last && lvl > last + 1) warn('heading level skipped', hd, `h${last} → h${lvl}`);
      last = lvl;
    }
    // Non-text content
    for (const el of shown.filter((e) => e.matches('img'))) if (!el.hasAttribute('alt')) fail('img without alt', el);
    for (const el of shown.filter((e) => e.matches('canvas'))) if (!el.closest('[aria-hidden="true"]') && !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby')) fail('canvas without a text alternative', el);
    for (const el of shown.filter((e) => e.matches('svg'))) if (el.getAttribute('aria-hidden') !== 'true' && !el.getAttribute('aria-label') && !el.querySelector('title')) warn('svg without aria-hidden or a name', el);
    return { fails, warns, checked: { elements: shown.length, interactive: shown.filter((e) => e.matches(INTERACTIVE)).length, liveRegions: live.length } };
  }

  /** The focused element and its focus indicator (2.4.7 visible, 2.4.11 not hidden, indicator contrast 3:1). */
  function focusInfo() {
    let el = document.activeElement;
    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
    if (!el || el === document.body || el === document.documentElement) return { desc: 'body', body: true };
    const s = getComputedStyle(el);
    const outline = s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 1;
    const shadow = s.boxShadow && s.boxShadow !== 'none';
    const bg = background(el.parentElement || el);
    const oc = outline ? ratio(rgba(s.outlineColor).slice(0, 3), bg) : 0;
    const r = el.getBoundingClientRect();
    // 2.4.11 (AA): the focused control must not be ENTIRELY hidden by author content. Sample its centre and corners.
    const pts = [[0.5, 0.5], [0.1, 0.15], [0.9, 0.15], [0.1, 0.85], [0.9, 0.85]].map(([fx, fy]) => [r.left + r.width * fx, r.top + r.height * fy]);
    const covered = pts.map(([x, y]) => {
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return true;
      const top = document.elementFromPoint(x, y);
      return !top || (top !== el && !el.contains(top) && !top.contains(el));
    });
    return { desc: describe(el), visible: visible(el), indicator: outline || shadow, outlineContrast: Number(oc.toFixed(2)), hasShadow: !!shadow, inViewport: r.bottom > 0 && r.top < innerHeight, obscured: covered.every(Boolean), partlyObscured: covered.some(Boolean), inDialog: !!el.closest('dialog[open]') };
  }

  /** 1.4.10 reflow: no horizontal scrolling of the page; report clipped text boxes. */
  function reflow() {
    const d = document.scrollingElement;
    const clipped = [...document.querySelectorAll('body *')].filter(visible).filter((e) => {
      const s = getComputedStyle(e);
      if (!/hidden|clip/.test(s.overflowX) || s.textOverflow === 'ellipsis') return false;
      // Visually hidden text for screen readers (1 px boxes, clip or clip-path) is meant to be clipped.
      const r = e.getBoundingClientRect();
      if (r.width <= 2 || r.height <= 2 || (s.clip && s.clip !== 'auto') || /inset\(50%\)|inset\(100%\)/.test(s.clipPath)) return false;
      return e.scrollWidth > e.clientWidth + 1 && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    }).map(describe);
    const wide = [...document.querySelectorAll('body *')].filter(visible).filter((e) => e.getBoundingClientRect().right > d.clientWidth + 1 && getComputedStyle(e).position !== 'fixed').map(describe).slice(0, 8);
    return { scrollWidth: d.scrollWidth, clientWidth: d.clientWidth, horizontalScroll: d.scrollWidth > d.clientWidth + 1, wide, clipped: clipped.slice(0, 8) };
  }

  /** 2.3.3 / user preference: with reduced motion, nothing animates or transitions for longer than 10 ms. */
  function motion() {
    const moving = [];
    for (const el of document.querySelectorAll('*')) {
      if (!visible(el)) continue;
      const s = getComputedStyle(el);
      const dur = (v) => Math.max(...v.split(',').map((x) => (x.trim().endsWith('ms') ? parseFloat(x) / 1000 : parseFloat(x)) || 0));
      if (s.animationName !== 'none' && dur(s.animationDuration) > 0.01) moving.push(`${describe(el)} animation ${s.animationName} ${s.animationDuration}`);
      if (dur(s.transitionDuration) > 0.01 && s.transitionProperty !== 'none') moving.push(`${describe(el)} transition ${s.transitionDuration}`);
    }
    return moving;
  }

  /** 1.4.12 text spacing: apply the WCAG spacing overrides. */
  function textSpacing(on) {
    let st = document.getElementById('__a11y-spacing');
    if (!on) { st?.remove(); return; }
    if (!st) { st = document.createElement('style'); st.id = '__a11y-spacing'; document.head.append(st); }
    st.textContent = '* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p { margin-bottom: 2em !important; }';
  }

  window.__a11y = { audit, focusInfo, reflow, motion, textSpacing };
})();
