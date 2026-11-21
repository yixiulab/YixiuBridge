// YixiuBridge — minimal fake DOM for Node tests (zero dependencies).
// Implements just enough of the DOM API for the Gemini adapter:
// querySelector / querySelectorAll with tag, .class, #id, [attr], [attr="v"],
// [attr*="v"], [attr^="v"] and descendant combinators, plus click/input
// events, textContent/innerText, value and disabled.
export class FakeEvent {
  constructor(type, opts = {}) {
    this.type = type;
    this.bubbles = !!opts.bubbles;
    this.defaultPrevented = false;
  }
  preventDefault() { this.defaultPrevented = true; }
}

export class FakeKeyboardEvent extends FakeEvent {
  constructor(type, opts = {}) {
    super(type, opts);
    this.key = opts.key || '';
    this.code = opts.code || '';
  }
}

function parseSimple(sel) {
  // Returns { tag, id, classes[], attrs[] } or null if unsupported.
  const out = { tag: null, id: null, classes: [], attrs: [] };
  let rest = sel.trim();
  const tagM = rest.match(/^([a-zA-Z][a-zA-Z0-9]*)/);
  if (tagM) { out.tag = tagM[1].toUpperCase(); rest = rest.slice(tagM[0].length); }
  while (rest.length) {
    if (rest[0] === '.') {
      const m = rest.match(/^\.([a-zA-Z0-9_-]+)/);
      if (!m) return null;
      out.classes.push(m[1]);
      rest = rest.slice(m[0].length);
    } else if (rest[0] === '#') {
      const m = rest.match(/^#([a-zA-Z0-9_-]+)/);
      if (!m) return null;
      out.id = m[1];
      rest = rest.slice(m[0].length);
    } else if (rest[0] === '[') {
      const m = rest.match(/^\[([a-zA-Z0-9_-]+)(\*|\^)?="?([^"\]]*)"?\]/);
      if (!m) return null;
      out.attrs.push({ name: m[1], op: m[2] || '=', value: m[3] });
      rest = rest.slice(m[0].length);
    } else {
      return null;
    }
  }
  return out;
}

function matchesSimple(el, simple) {
  if (simple.tag && el.tagName !== simple.tag) return false;
  if (simple.id && el.getAttribute('id') !== simple.id) return false;
  for (const c of simple.classes) {
    if (!el.classList.contains(c)) return false;
  }
  for (const a of simple.attrs) {
    const v = el.getAttribute(a.name);
    if (v === null || v === undefined) return false;
    if (a.op === '=' && v !== a.value) return false;
    if (a.op === '*' && !String(v).includes(a.value)) return false;
    if (a.op === '^' && !String(v).startsWith(a.value)) return false;
  }
  return true;
}

function matchesSelector(el, selector) {
  // Comma groups, descendant combinators (space). The rightmost part must
  // match the element itself; earlier parts match ancestors.
  const groups = selector.split(',').map((s) => s.trim()).filter(Boolean);
  for (const group of groups) {
    const parts = group.split(/\s+/).map(parseSimple);
    if (parts.some((p) => p === null)) continue;
    if (!matchesSimple(el, parts[parts.length - 1])) continue;
    let cur = el.parent;
    let ok = true;
    for (let i = parts.length - 2; i >= 0; i--) {
      let found = false;
      let node = cur;
      while (node) {
        if (matchesSimple(node, parts[i])) { found = true; cur = node.parent; break; }
        node = node.parent;
      }
      if (!found) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

export class FakeElement {
  constructor(tagName, attrs = {}) {
    this.tagName = String(tagName).toUpperCase();
    this.attributes = new Map(Object.entries(attrs));
    this.children = [];
    this.parent = null;
    this._ownText = '';
    this.value = '';
    this.disabled = false;
    this._listeners = {};
    this._classes = new Set((attrs.class || '').split(/\s+/).filter(Boolean));
  }

  get classList() {
    const self = this;
    return { contains: (c) => self._classes.has(c), add: (c) => self._classes.add(c), remove: (c) => self._classes.delete(c) };
  }

  getAttribute(name) {
    const v = this.attributes.get(name);
    return v === undefined ? null : v;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }

  get textContent() {
    let t = this._ownText;
    for (const c of this.children) t += c.textContent;
    return t;
  }
  set textContent(v) {
    this._ownText = String(v);
    this.children = [];
  }
  get innerText() { return this.textContent; }

  appendChild(child) {
    child.parent = this;
    this.children.push(child);
    return child;
  }
  remove() {
    if (!this.parent) return;
    const i = this.parent.children.indexOf(this);
    if (i !== -1) this.parent.children.splice(i, 1);
    this.parent = null;
  }

  addEventListener(type, fn) {
    (this._listeners[type] = this._listeners[type] || []).push(fn);
  }
  dispatchEvent(ev) {
    const list = this._listeners[ev.type] || [];
    for (const fn of list) fn.call(this, ev);
    return true;
  }
  click() { this.dispatchEvent(new FakeEvent('click', { bubbles: true })); }

  querySelector(selector) {
    const all = this.querySelectorAll(selector);
    return all.length ? all[0] : null;
  }
  querySelectorAll(selector) {
    const out = [];
    const walk = (el) => {
      if (el !== this && matchesSelector(el, selector)) out.push(el);
      for (const c of el.children) walk(c);
    };
    // Include self in the search (document-style: search descendants only
    // is the spec, but including self is harmless for our tests).
    for (const c of this.children) walk(c);
    return out;
  }
}

export class FakeDocument {
  constructor() {
    this.documentElement = new FakeElement('html');
    this.body = new FakeElement('body');
    this.documentElement.appendChild(this.body);
    this.title = 'Gemini (mock)';
  }
  createElement(tag, attrs = {}) { return new FakeElement(tag, attrs); }
  querySelector(selector) {
    const all = this.querySelectorAll(selector);
    return all.length ? all[0] : null;
  }
  querySelectorAll(selector) {
    return this.documentElement.querySelectorAll(selector);
  }
}

export class FakeWindow {
  constructor() {
    this.Event = FakeEvent;
    this.KeyboardEvent = FakeKeyboardEvent;
    this.HTMLTextAreaElement = undefined; // forces the adapter's direct-assignment path
    this.HTMLInputElement = undefined;
  }
}
