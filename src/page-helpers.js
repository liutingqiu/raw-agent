/**
 * Injected into every page (once) as a single expression.
 * Kept in a real .js file so regex escapes are not mangled by template literals.
 */
(() => {
  if (window.__mai) return 'ready';

  const textOf = (el) => {
    const labelled = (el.getAttribute('aria-labelledby') || '')
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => el.ownerDocument.getElementById(id)?.textContent || '')
      .join(' ');
    const labels = el.labels ? [...el.labels].map((label) => label.innerText || label.textContent || '').join(' ') : '';
    return [
      el.innerText || el.textContent || '', el.value || '', el.getAttribute('aria-label') || '',
      labelled, labels, el.getAttribute('placeholder') || '', el.getAttribute('title') || '', el.getAttribute('alt') || '',
    ].join(' ').replace(/\s+/g, ' ').trim();
  };

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const view = el.ownerDocument && el.ownerDocument.defaultView;
    const s = (view || window).getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || s.opacity === '0') return false;
    let win = el.ownerDocument && el.ownerDocument.defaultView;
    while (win && win !== window) {
      const frame = win.frameElement;
      if (!frame || !visible(frame)) return false;
      win = frame.ownerDocument && frame.ownerDocument.defaultView;
    }
    return true;
  };

  const INTERACTIVE =
    'a,button,input,textarea,select,[role=button],[role=link],[role=checkbox],[role=tab],[role=textbox],[onclick],[contenteditable=true]';
  const TEXTY = 'a,button,[role=button],[role=link],input,textarea,li,span,div,h1,h2,h3,label,td,p';

  const TEXT_RE = null; // replaced by explicit parsing below
  const ROLE_RE = /^role=([a-z]+)(?:\[name[*^$]?=["']?([^"']+)["']?\])?$/i;

  /** "text=Foo" / ":has-text(\"Foo\")" -> the needle, else null */
  const textNeedleOf = (s) => {
    let raw = null;
    if (s.startsWith('text=')) raw = s.slice(5);
    else if (s.startsWith(':has-text')) {
      const open = s.indexOf('(');
      if (open < 0) return null;
      raw = s.slice(open + 1, s.endsWith(')') ? -1 : undefined);
    }
    if (raw === null) return null;
    return raw.trim().replace(/^["']/, '').replace(/["']$/, '');
  };

  const roleSelector = (role) => {
    if (role === 'button') return 'button,[role=button],input[type=submit],input[type=button],input[type=reset]';
    if (role === 'link') return 'a,[role=link]';
    if (role === 'textbox') {
      return 'input:not([type=submit]):not([type=button]):not([type=reset]):not([type=checkbox]):not([type=radio]):not([type=file]):not([type=hidden]),textarea,[role=textbox],[contenteditable=true]';
    }
    if (role === 'checkbox') return 'input[type=checkbox],[role=checkbox]';
    if (role === 'combobox') return 'select,[role=combobox]';
    return '[role=' + role + ']';
  };

  /** top document plus every reachable same-origin frame document */
  const documents = () => {
    const out = [];
    const visit = (doc) => {
      if (!doc || out.includes(doc)) return;
      out.push(doc);
      let frames = [];
      try {
        frames = [...doc.querySelectorAll('iframe,frame')];
      } catch {
        return;
      }
      for (const frame of frames) {
        try {
          visit(frame.contentDocument);
        } catch {
          /* cross-origin iframe */
        }
      }
    };
    visit(document);
    return out;
  };

  const queryAll = (selector) => documents().flatMap((doc) => {
    try {
      return [...doc.querySelectorAll(selector)];
    } catch {
      return [];
    }
  });

  /** every locator syntax: number | css | css= | xpath= | text= | :has-text() | role= */
  const findAll = (sel) => {
    if (typeof sel === 'number') {
      const el = queryAll('[data-mai="' + sel + '"]')[0];
      return el ? [el] : [];
    }
    if (sel === undefined || sel === null || sel === '') return [];
    const s = String(sel).trim();

    if (s.startsWith('css=')) return queryAll(s.slice(4));

    if (s.startsWith('xpath=')) {
      const out = [];
      for (const doc of documents()) {
        const view = doc.defaultView || window;
        const it = doc.evaluate(s.slice(6), doc, null, view.XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        for (let i = 0; i < it.snapshotLength; i++) out.push(it.snapshotItem(i));
      }
      return out;
    }

    const needle = textNeedleOf(s);
    if (needle !== null) {
      const lower = needle.toLowerCase();
      if (!lower) return [];
      return queryAll(TEXTY)
        .filter((el) => visible(el) && textOf(el).toLowerCase().includes(lower))
        .sort((a, b) => textOf(a).length - textOf(b).length);
    }

    const roleMatch = ROLE_RE.exec(s);
    if (roleMatch) {
      const role = roleMatch[1].toLowerCase();
      const name = (roleMatch[2] || '').toLowerCase();
      return queryAll(roleSelector(role)).filter(
        (el) => visible(el) && (!name || textOf(el).toLowerCase().includes(name)),
      );
    }

    try {
      return queryAll(s);
    } catch {
      return [];
    }
  };

  const find = (sel) => findAll(sel)[0] || null;

  const absoluteRect = (el, scroll) => {
    const frames = [];
    let owner = el.ownerDocument && el.ownerDocument.defaultView;
    while (owner && owner !== window) {
      const frame = owner.frameElement;
      if (!frame) break;
      frames.push(frame);
      owner = frame.ownerDocument && frame.ownerDocument.defaultView;
    }
    if (scroll) {
      el.scrollIntoView({ block: 'center', inline: 'center' });
      for (const frame of frames) frame.scrollIntoView({ block: 'center', inline: 'center' });
    }
    const r = el.getBoundingClientRect();
    let left = r.left;
    let top = r.top;
    let win = el.ownerDocument && el.ownerDocument.defaultView;
    while (win && win !== window) {
      const frame = win.frameElement;
      if (!frame) break;
      const fr = frame.getBoundingClientRect();
      left += fr.left;
      top += fr.top;
      win = frame.ownerDocument && frame.ownerDocument.defaultView;
    }
    return { x: left + r.width / 2, y: top + r.height / 2, w: r.width, h: r.height };
  };
  const rect = (el) => absoluteRect(el, true);

  /** interactive elements from a document and its same-origin iframes */
  const collect = (doc, out) => {
    try {
      out.push(...doc.querySelectorAll(INTERACTIVE));
    } catch {
      /* cross-origin document */
    }
    let frames = [];
    try {
      frames = [...doc.querySelectorAll('iframe,frame')];
    } catch {
      /* ignore */
    }
    for (const f of frames) {
      try {
        if (f.contentDocument) collect(f.contentDocument, out);
      } catch {
        /* cross-origin iframe: skip */
      }
    }
    return out;
  };

  const snapshot = (opts) => {
    opts = opts || {};
    const scope = opts.scope || 'full';
    const max = Math.max(1, Math.min(Number(opts.max) || 400, 2000));
    const root = opts.root ? document.querySelector(opts.root) : null;
    if (opts.root && !root) return '(snapshot root not found: ' + opts.root + ')';

    const inViewport = (el) => {
      if (scope !== 'viewport') return true;
      const r = el.getBoundingClientRect();
      return r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth;
    };

    const lines = [];
    queryAll('[data-mai]').forEach((e) => e.removeAttribute('data-mai'));
    lines.push('# ' + (document.title || '').replace(/\s+/g, ' ').trim());
    lines.push('# ' + location.href);
    lines.push('# scope=' + scope + (opts.root ? ' root=' + opts.root : ''));
    lines.push('');
    lines.push('## elements');

    const candidates = root ? collect(root, []) : collect(document, []);
    let i = 0;
    for (const el of candidates) {
      if (!visible(el) || !inViewport(el)) continue;
      const tag = el.tagName.toLowerCase();
      const type = el.getAttribute('type');
      el.setAttribute('data-mai', String(i));
      lines.push('[' + i + '] ' + tag + (type ? ':' + type : '') + ' "' + textOf(el).slice(0, 120) + '"');
      if (++i >= max) {
        lines.push('(element list truncated at ' + max + ')');
        break;
      }
    }
    if (!i) lines.push('(no interactive elements found)');

    lines.push('');
    lines.push('## text');
    const bodies = root ? [root] : documents().map((doc) => doc.body).filter(Boolean);
    lines.push(bodies.map((body) => body.innerText || '').join('\n\n').replace(/\n{3,}/g, '\n\n').slice(0, 6000));
    return lines.join('\n');
  };

  const describe = (el) => ({
    tag: el.tagName.toLowerCase(),
    text: textOf(el).slice(0, 200),
    value: 'value' in el ? el.value : undefined,
    href: el.href || undefined,
    visible: visible(el),
    box: (() => {
      const r = absoluteRect(el, false);
      return { x: Math.round(r.x - r.w / 2), y: Math.round(r.y - r.h / 2), w: Math.round(r.w), h: Math.round(r.h) };
    })(),
  });

  Object.defineProperty(window, '__mai', { value: { find, findAll, describe, visible, textOf, rect, snapshot } });
  return 'ready';
})()
