// ui.js — small, dependency-free UI primitives shared by the app: inline SVG
// icons, toast notifications, pop-up menus, modal dialogs (incl. async
// confirm), and a tiny element builder. No app state lives here.

// 16x16 stroke icons (currentColor), drawn for this app
const ICON_PATHS = {
  open: '<path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z"/>',
  save: '<path d="M3 2.5h8l2.5 2.5v8.5H3z"/><path d="M5 2.5V6h5V2.5M5 13.5V9.5h6v4"/>',
  load: '<path d="M8 11V3M5 6l3-3 3 3"/><path d="M3 10.5v3h10v-3"/>',
  func: '<text x="3.2" y="13" font-size="13.5" font-style="italic" font-weight="700" font-family="Georgia, serif" fill="currentColor" stroke="none">ƒ</text>',
  export: '<path d="M8 2.5v8M5 7.5l3 3 3-3"/><path d="M3 10.5v3h10v-3"/>',
  report: '<path d="M4 2h5.5L13 5.5V14H4z"/><path d="M9.5 2v3.5H13M6 8.5h5M6 11h5"/>',
  undo: '<path d="M5.5 3 2.5 6l3 3"/><path d="M2.5 6h7a3.5 3.5 0 0 1 0 7H6"/>',
  redo: '<path d="M10.5 3l3 3-3 3"/><path d="M13.5 6h-7a3.5 3.5 0 0 0 0 7H10"/>',
  new: '<path d="M4 2h5.5L13 5.5V14H4z"/><path d="M8.5 7.5v4.5M6.25 9.75h4.5"/>',
  help: '<circle cx="8" cy="8" r="6.2"/><path d="M6.2 6.3a1.9 1.9 0 1 1 2.6 1.75c-.55.22-.8.6-.8 1.15v.35"/><circle cx="8" cy="11.7" r=".65" fill="currentColor" stroke="none"/>',
  edit: '<path d="M10.5 2.5l3 3L6 13H3v-3z"/>',
  more: '<circle cx="3.5" cy="8" r="1.1" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none"/><circle cx="12.5" cy="8" r="1.1" fill="currentColor" stroke="none"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
  file: '<path d="M4 2h5.5L13 5.5V14H4z"/><path d="M9.5 2v3.5H13"/>',
  chevron: '<path d="M6 4l4 4-4 4"/>',
  grip: '<circle cx="6" cy="4" r="1" fill="currentColor" stroke="none"/><circle cx="10" cy="4" r="1" fill="currentColor" stroke="none"/><circle cx="6" cy="8" r="1" fill="currentColor" stroke="none"/><circle cx="10" cy="8" r="1" fill="currentColor" stroke="none"/><circle cx="6" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="10" cy="12" r="1" fill="currentColor" stroke="none"/>',
  warn: '<path d="M8 2.2 14.3 13.5H1.7z"/><path d="M8 6.5v3.2"/><circle cx="8" cy="11.6" r=".6" fill="currentColor" stroke="none"/>',
};

export function icon(name, cls = "") {
  const p = ICON_PATHS[name];
  if (!p) return "";
  return `<svg class="ico ${cls}" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" `
    + `stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
}

// prepend the icon named by data-icon to every such button (keeps its text)
export function decorateIcons(root = document) {
  for (const el of root.querySelectorAll("[data-icon]")) {
    if (el.querySelector("svg.ico")) continue;
    // wrap the text so narrow layouts can show the icon alone
    const txt = el.textContent.trim();
    if (txt) { el.textContent = ""; el.appendChild(h("span", { class: "tb-label", text: txt })); }
    el.insertAdjacentHTML("afterbegin", icon(el.dataset.icon));
  }
}

// element builder: h("div", {class: "x", onclick: fn, title: "t"}, child1, "text", ...)
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v;
    else if (k === "text") el.textContent = v;
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k.startsWith("on") && typeof v === "function") el[k] = v;
    else if (k in el && typeof v !== "string") el[k] = v;      // .checked, .disabled, .value …
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.appendChild(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------------------------------------------------------------- toasts
// transient notifications (top-right). kind: info | ok | warn | error.
export function toast(msg, kind = "info", ms) {
  const root = document.getElementById("toasts");
  if (!root) return;
  const life = ms || (kind === "error" ? 9000 : kind === "warn" ? 6500 : 3800);
  const el = h("div", { class: `toast ${kind}`, role: kind === "error" ? "alert" : "status" },
    h("span", { class: "toast-msg", text: msg }),
    h("button", { class: "toast-x", title: "dismiss", "aria-label": "dismiss", html: icon("close") }));
  const kill = () => { el.classList.add("out"); setTimeout(() => el.remove(), 200); };
  el.querySelector(".toast-x").onclick = kill;
  root.appendChild(el);
  // keep at most 4 on screen
  while (root.children.length > 4) root.firstChild.remove();
  setTimeout(kill, life);
}

// ---------------------------------------------------------------- menus
// pop-up menu at an anchor element (below it) or at {x, y}. items:
// {label, hint, onClick, disabled, danger, sep:true, title}
let _menu = null;
export function closeMenu() {
  if (!_menu) return;
  _menu.el.remove();
  document.removeEventListener("mousedown", _menu.outside, true);
  document.removeEventListener("keydown", _menu.key, true);
  window.removeEventListener("blur", closeMenu);
  window.removeEventListener("resize", closeMenu);
  if (_menu.anchor) _menu.anchor.classList.remove("open");
  _menu = null;
}
export function menu(at, items) {
  closeMenu();
  const el = h("div", { class: "ctxmenu", role: "menu" });
  const buttons = [];
  for (const it of items) {
    if (!it) continue;
    if (it.sep) { el.appendChild(h("div", { class: "menu-sep" })); continue; }
    if (it.header) { el.appendChild(h("div", { class: "menu-head", text: it.header })); continue; }
    const b = h("button", { role: "menuitem", class: it.danger ? "danger" : "", disabled: !!it.disabled,
      title: it.title || null },
      h("span", { class: "mi-label", html: (it.icon ? icon(it.icon) : "") + esc(it.label) }),
      it.hint ? h("span", { class: "mi-hint", text: it.hint }) : null);
    b.onclick = () => { closeMenu(); if (it.onClick) it.onClick(); };
    el.appendChild(b);
    buttons.push(b);
  }
  document.body.appendChild(el);
  const r = el.getBoundingClientRect();
  let x, y, anchor = null;
  if (at instanceof Element) {
    anchor = at;
    const a = at.getBoundingClientRect();
    x = a.left; y = a.bottom + 3;
    at.classList.add("open");
  } else { x = at.x; y = at.y; }
  el.style.left = Math.max(2, Math.min(x, window.innerWidth - r.width - 4)) + "px";
  el.style.top = Math.max(2, Math.min(y, window.innerHeight - r.height - 4)) + "px";
  const outside = (e) => { if (!el.contains(e.target) && !(anchor && anchor.contains(e.target))) closeMenu(); };
  const key = (e) => {
    if (e.key === "Escape") { e.preventDefault(); closeMenu(); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const live = buttons.filter((b) => !b.disabled);
      if (!live.length) return;
      let i = live.indexOf(document.activeElement);
      i = e.key === "ArrowDown" ? (i + 1) % live.length : (i <= 0 ? live.length - 1 : i - 1);
      live[i].focus();
    }
  };
  _menu = { el, outside, key, anchor };
  // a click on the same anchor toggles the menu closed (handled by the caller
  // checking isMenuOpenFor) — listeners attach after this event finishes
  setTimeout(() => {
    if (_menu && _menu.el === el) {
      document.addEventListener("mousedown", outside, true);
      document.addEventListener("keydown", key, true);
      window.addEventListener("blur", closeMenu);
      window.addEventListener("resize", closeMenu);
    }
  }, 0);
  return el;
}
export function isMenuOpenFor(anchor) { return !!(_menu && _menu.anchor === anchor); }

// ---------------------------------------------------------------- modals
// modal({title, body: Node|string, buttons:[{label, kind:"primary"|"ghost"|"danger",
// onClick(ctx) -> false keeps it open, id}], wide, dismissable, onClose})
// -> {el, body, close(), button(id)}
const _stack = [];
export function modal(opts) {
  const { title, body, buttons = [], wide = false, dismissable = true, onClose, cls = "" } = opts;
  const card = h("div", { class: `modal ${wide ? "wide" : ""} ${cls}`, role: "dialog", "aria-modal": "true",
    "aria-label": title || "dialog" });
  const head = h("div", { class: "modal-head" }, h("h3", { text: title || "" }));
  const x = h("button", { class: "modal-x", title: "close (Esc)", "aria-label": "close", html: icon("close") });
  head.appendChild(x);
  const bodyEl = h("div", { class: "modal-body" });
  if (typeof body === "string") bodyEl.innerHTML = body; else if (body) bodyEl.appendChild(body);
  const foot = h("div", { class: "modal-foot" });
  const back = h("div", { class: "modal-back" }, card);
  card.append(head, bodyEl, foot);
  let closed = false;
  const ctx = {
    el: card, body: bodyEl, foot,
    close(result) {
      if (closed) return;
      closed = true;
      back.remove();
      const i = _stack.indexOf(ctx); if (i >= 0) _stack.splice(i, 1);
      document.removeEventListener("keydown", onKey, true);
      if (onClose) onClose(result);
    },
    button(id) { return foot.querySelector(`[data-id="${id}"]`); },
  };
  const btnEls = [];
  for (const b of buttons) {
    if (b.spacer) { foot.appendChild(h("span", { class: "tb-grow" })); continue; }
    const el = h("button", { class: b.kind || "ghost", "data-id": b.id || "", title: b.title || null, text: b.label });
    el.onclick = async () => {
      if (el.disabled) return;
      if (b.id === "cancel" && !b.onClick) { ctx.dismiss(); return; }
      const r = b.onClick ? await b.onClick(ctx) : undefined;
      if (r !== false) ctx.close(b.id);
    };
    foot.appendChild(el);
    btnEls.push(el);
  }
  if (!buttons.length) foot.remove();
  // dismissing (✕ / Esc / a "cancel" button) may be vetoed, e.g. "discard changes?"
  ctx.dismiss = async () => {
    if (!dismissable) return;
    if (opts.confirmDismiss && !(await opts.confirmDismiss())) return;
    ctx.close("cancel");
  };
  x.onclick = () => ctx.dismiss();
  function onKey(e) {
    if (_stack[_stack.length - 1] !== ctx) return;
    if (e.key === "Escape" && dismissable) {
      // let an open menu / select swallow Esc first
      if (_menu) return;
      e.preventDefault(); e.stopPropagation(); ctx.dismiss();
    } else if (e.key === "Enter" && !e.shiftKey && e.target && e.target.tagName === "INPUT"
        && e.target.type !== "checkbox" && opts.enterButton) {
      const b = ctx.button(opts.enterButton);
      if (b && !b.disabled) { e.preventDefault(); b.click(); }
    }
  }
  document.addEventListener("keydown", onKey, true);
  document.body.appendChild(back);
  _stack.push(ctx);
  // focus the first field, else the primary button
  setTimeout(() => {
    const f = bodyEl.querySelector("input:not([type=hidden]):not([disabled]), select, textarea")
      || btnEls.find((b) => b.classList.contains("primary")) || x;
    try { f.focus(); if (f.select && f.type === "text") f.select(); } catch (e) { /* ignore */ }
  }, 0);
  return ctx;
}
export function modalOpen() { return _stack.length > 0; }

// async replacements for window.confirm / alert
export function ask(message, { title = "Please confirm", ok = "OK", cancel = "Cancel", danger = false } = {}) {
  return new Promise((resolve) => {
    modal({
      title, cls: "small",
      body: h("p", { class: "ask", text: message }),
      buttons: [
        { spacer: true },
        { label: cancel, kind: "ghost", id: "cancel", onClick: () => resolve(false) },
        { label: ok, kind: danger ? "danger" : "primary", id: "ok", onClick: () => resolve(true) },
      ],
      onClose: (r) => { if (r === "cancel") resolve(false); },
    });
  });
}

// SI-suffix number parsing for window inputs: "5k" -> 5000, "1.5M", "2e3", "-3 m"
const SI = { p: 1e-12, n: 1e-9, u: 1e-6, "µ": 1e-6, m: 1e-3, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12 };
export function parseNum(s) {
  if (typeof s === "number") return Number.isFinite(s) ? s : null;
  const t = String(s == null ? "" : s).trim().replace(/\s+/g, "");
  if (!t) return null;
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)([pnuµmkKMGT]?)$/.exec(t);
  if (!m) return null;
  const v = parseFloat(m[1]) * (m[2] ? SI[m[2]] : 1);
  return Number.isFinite(v) ? v : null;
}
// compact formatting for window inputs: 1500000 -> "1.5M"; mid-range values
// (1e-3 .. 1e5, e.g. wavelengths in nm) stay plain decimals
export function fmtSI(v) {
  if (v == null || !Number.isFinite(v)) return "";
  if (v === 0) return "0";
  const a = Math.abs(v);
  if (a >= 1e-3 && a < 1e5) return String(parseFloat(v.toPrecision(10)));
  const steps = [[1e12, "T"], [1e9, "G"], [1e6, "M"], [1e3, "k"], [1, ""], [1e-3, "m"], [1e-6, "u"], [1e-9, "n"], [1e-12, "p"]];
  for (const [f, s] of steps) {
    if (a >= f * 0.9999999) {
      const r = parseFloat((v / f).toPrecision(9));
      return String(r) + s;
    }
  }
  return String(v);
}
