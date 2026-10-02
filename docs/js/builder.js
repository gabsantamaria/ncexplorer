// builder.js — the "Derived quantity" dialog. Left: a form for one definition
// (a windowed statistic over a dimension, or a formula), with presets for the
// common lab cases (peak in a window, noise floor outside it, and peak + floor +
// SNR in one go). Window settings and formulas are EXPRESSIONS (e.g. a half
// width of 0.01*stimulusFrequency or 3*ResolutionBWs), with a picker that
// inserts variable / function names. Right: a live preview — one source line
// (e.g. one spectrum) with the window drawn as draggable shaded bands, and the
// resulting quantity vs a remaining dimension. All computation is derive.js /
// expr.js; this file is only the UI. The app passes a context (state, X, D, …).

import { h, modal, menu, parseNum, fmtSI, ask } from "./ui.js";
import { parseExpr, exprNames, quoteName, num } from "./expr.js";

const CYCLE = ["#1565c0", "#c0392b", "#0d6b3f", "#7d3cff", "#e6a700", "#00838f", "#ad1457", "#4e342e"];
const KINDS = [
  { id: "reduce", label: "Window statistic", title: "reduce one dimension: peak, mean, … of the points in an x window" },
  { id: "formula", label: "Formula", title: "any expression of variables, e.g. peak - floor or floor - 10*log10(ResolutionBWs)" },
];
const PRESETS = [
  { id: "peak", label: "Peak in window", title: "largest value inside a window (e.g. around the stimulus frequency)" },
  { id: "floor", label: "Noise floor outside", title: "mean (in linear power for dB data) outside the window" },
  { id: "snr", label: "Peak + floor + SNR", title: "creates three quantities at once: peak, floor and SNR = peak − floor" },
  { id: "custom", label: "Custom", title: "any statistic, or a formula" },
];

// an old "combine" / "transform" definition as the equivalent formula text
function legacyFormula(d) {
  const q = (n) => quoteName(String(n || "x"));
  if (d.kind === "combine") {
    const b = typeof d.b === "number" ? num(d.b) : q(d.b);
    if (d.op === "max" || d.op === "min") return `${d.op}(${q(d.a)}, ${b})`;
    return `${q(d.a)} ${d.op} ${b}`;
  }
  if (d.kind === "transform") {
    if (d.fn === "scale") {
      const sc = d.scale ?? 1, off = d.offset ?? 0;
      return `${sc === 1 ? "" : num(sc) + "*"}${q(d.src)}${off ? (off < 0 ? ` - ${num(-off)}` : ` + ${num(off)}`) : ""}`;
    }
    return `${d.fn}(${q(d.src)})`;
  }
  return "";
}
// names an expression refers to ([] when it doesn't parse)
function namesIn(text) {
  try { return exprNames(parseExpr(String(text || ""))); } catch (e) { return []; }
}

export function openBuilder(ctx, opts = {}) {
  const { state, D, X } = ctx;
  // Plotly (global setting) otherwise logs "unrecognized GUI edit" on every drag-select
  try { Plotly.setPlotConfig({ logging: 0 }); } catch (e) { /* older Plotly */ }
  const editing = opts.edit && !opts.asNew ? { file: opts.edit.file, name: opts.edit.name } : null;

  // ---------------------------------------------------------------- state
  const S = {
    file: (opts.edit && opts.edit.file) || opts.file || state.fileOrder[0],
    def: null,
    preset: opts.edit ? "custom" : "peak",
    floorStat: "mean", floorRegion: "outside",
    names: { main: "", floor: "", snr: "" },
    nameTouched: !!opts.edit,
    slice: {},            // result dim -> index (preview position)
    vs: "", lines: "",    // result plot axes
    // a tab that already shows other data gets a fresh tab for the new quantity
    plotWhere: state.traces.length ? "new" : "here",
    result: null,         // last computed result(s) for the preview
  };
  const ds = () => state.dsets.get(S.file);

  // defs of this file other than the one being edited, and everything that
  // depends on the edited one (not offered as sources — that would be a cycle)
  const otherDefs = () => state.derived.filter((d) => d.file === S.file
    && !(editing && d.file === editing.file && d.name === editing.name));
  const forbidden = () => {
    if (!editing) return new Set();
    const bad = new Set([editing.name]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const d of state.derived) {
        if (d.file !== editing.file || bad.has(d.name)) continue;
        if (D.depsOf(d).some((n) => bad.has(n))) { bad.add(d.name); grew = true; }
      }
    }
    return bad;
  };
  const numericVars = (minDims = 1) => {
    const d = ds(); if (!d) return [];
    const bad = forbidden();
    return d.varNames().filter((n) => {
      const v = d.vars[n];
      return !bad.has(n) && v.isNumeric() && v.ndim >= minDims && v.data && typeof v.data !== "string";
    });
  };

  // ---------------------------------------------------------------- defaults
  function defaultSource() {
    const vars = numericVars(1);
    if (opts.src && vars.includes(opts.src)) return opts.src;
    const d = ds();
    const score = (n) => {
      const v = d.vars[n];
      let s = v.ndim * 10 + Math.log10(v.size + 1);
      if (/spec|trace|dbm|psd|power|volts/i.test(n)) s += 25;
      if (d.isCoord(n)) s -= 100;
      if (v.derived) s -= 5;
      return s;
    };
    return vars.slice().sort((a, b) => score(b) - score(a))[0] || "";
  }
  // the dim to reduce: the longest one (spectral bins are the longest axis)
  function defaultOver(src) {
    const d = ds(); const v = d && d.vars[src];
    if (!v || !v.dims.length) return "";
    let best = v.dims[v.dims.length - 1];
    for (const dim of v.dims) if (d.size(dim) > d.size(best)) best = dim;
    return best;
  }
  function xRange(def) {
    // x span of the first preview line, for sensible default windows
    try {
      const p = D.previewSlice(ds(), { ...def, window: { ...def.window, mode: "none" }, region: "inside", stat: "max" }, S.slice);
      let lo = Infinity, hi = -Infinity;
      for (const x of p.x) if (Number.isFinite(x)) { if (x < lo) lo = x; if (x > hi) hi = x; }
      return lo <= hi ? [lo, hi] : null;
    } catch (e) { return null; }
  }
  const nice = (v) => (v ? parseFloat(v.toPrecision(2)) : 0);
  // pick a window-center name whose value (at the previewed slice) lies inside
  // the line's x range — e.g. stimulusFrequency for a spectrum around it
  function defaultCenter(def) {
    const xr = xRange(def);
    let cands = [];
    try { cands = D.windowNames(ds(), def.src, def.over); } catch (e) { cands = []; }
    if (!cands.length) return { center: "", value: NaN, ok: false };
    if (xr) {
      for (const c of cands) {
        const center = quoteName(c.name);
        const test = { ...def, window: { ...def.window, mode: "center", center, halfwidth: "0" }, region: "inside" };
        const v = D.exprValueAt(ds(), test, "center", S.slice);
        if (Number.isFinite(v) && v > xr[0] && v <= xr[1]) return { center, value: v, ok: true };
      }
    }
    return { center: quoteName(cands[0].name), value: NaN, ok: false };
  }
  // a half width as an expression: proportional to the center when the line's
  // x span scales with it (e.g. analyzer span = f0), else a plain number
  function widthExpr(width, c, span) {
    if (c.ok && Number.isFinite(c.value) && c.value > 0 && span / c.value > 0.05)
      return `${num(nice(width / c.value))}*${c.center}`;
    return num(nice(width) || 1);
  }
  function setupWindow(def, wantCenter) {
    const xr = xRange(def);
    const span = xr ? xr[1] - xr[0] : 0;
    if (wantCenter) {
      const c = defaultCenter(def);
      if (c.ok) {
        def.window = { ...def.window, mode: "center", center: c.center,
          halfwidth: widthExpr(span * 0.01, c, span), halfwidth2: widthExpr(span * 0.25, c, span) };
        return;
      }
    }
    if (xr) {
      const mid = (xr[0] + xr[1]) / 2;
      def.window = { ...def.window, mode: "range", lo: num(nice(mid - span * 0.05)), hi: num(nice(mid + span * 0.05)),
        lo2: num(nice(mid - span * 0.3)), hi2: num(nice(mid + span * 0.3)) };
    }
  }

  function freshReduce() {
    const def = D.newDef("reduce", S.file);
    def.src = defaultSource();
    def.over = defaultOver(def.src);
    def.xsrc = def.src ? D.suggestXsrc(ds(), def.src, def.over) : "index";
    return def;
  }

  function applyPreset(id) {
    S.preset = id;
    if (id === "custom") { render(); return; }
    let def = S.def && S.def.kind === "reduce" && S.def.src ? S.def : freshReduce();
    def = D.canonicalDef(def);
    if (def.window.mode === "none") setupWindow(def, true);
    def.stat = id === "floor" ? "mean" : "max";
    def.region = id === "floor" ? (def.region === "outside_within" ? "outside_within" : "outside") : "inside";
    S.def = def;
    S.nameTouched = false;
    autoNames();
    pickResultAxes(true);
    render();
  }

  // ---------------------------------------------------------------- names
  function uniqueName(base) {
    const d = ds();
    const taken = (n) => (d && d.has(n) && !(d.vars[n].derived)) || (d && d.dims[n] !== undefined)
      || otherDefs().some((q) => q.name === n);
    let b = String(base).replace(/[^A-Za-z0-9_ .+\-]/g, "_").replace(/^[^A-Za-z0-9_]/, "_").slice(0, 60) || "derived";
    if (!taken(b)) return b;
    for (let i = 2; ; i++) { const c = `${b}_${i}`; if (!taken(c)) return c; }
  }
  function autoNames() {
    if (S.nameTouched) return;
    const d = S.def;
    if (!d) return;
    let base;
    if (d.kind === "formula") { const nm = namesIn(d.expr); base = nm.length ? `${nm[0]}_expr` : "formula"; }
    else if (S.preset === "peak" || S.preset === "snr") base = `${d.src}_peak`;
    else if (S.preset === "floor") base = `${d.src}_floor`;
    else base = `${d.src}_${d.stat === "argmax_x" ? "xpeak" : d.stat === "argmin_x" ? "xmin" : d.stat}${d.region === "inside" ? "" : "_out"}`;
    S.names.main = uniqueName(base);
    const src = d.src || "x";
    S.names.floor = uniqueName(`${src}_floor`);
    S.names.snr = uniqueName(`${src}_snr`);
  }

  // ---------------------------------------------------------------- result axes
  function resultDims() {
    try { const r = D.resultShape(ds(), currentDefs()[0]); return r ? r.dims : []; } catch (e) { return []; }
  }
  function pickResultAxes(force) {
    const dims = resultDims();
    for (const k of Object.keys(S.slice)) if (!dims.includes(k)) delete S.slice[k];
    if (!force && dims.includes(S.vs) && (!S.lines || dims.includes(S.lines))) return;
    const d = ds();
    const w = S.def && S.def.kind === "reduce" && S.def.window;
    // the dim the window follows (e.g. stimulusFrequency) is the natural x axis
    const follow = w && w.mode !== "none"
      ? [...namesIn(w.center), ...namesIn(w.lo), ...namesIn(w.halfwidth)]
        .flatMap((n) => (d.vars[n] ? d.vars[n].dims : [n])).find((dd) => dims.includes(dd) && d.size(dd) > 1)
      : null;
    if (follow) S.vs = follow;
    else {
      let best = dims[0] || "";
      for (const dim of dims) if (d.size(dim) > d.size(best)) best = dim;
      S.vs = best;
    }
    if (S.lines && (!dims.includes(S.lines) || S.lines === S.vs)) S.lines = "";
  }

  // the defs this dialog will save, in dependency order
  function currentDefs() {
    const d = D.canonicalDef(S.def);
    d.file = S.file;
    d.name = S.names.main;
    if (S.preset !== "snr" || d.kind !== "reduce") return [d];
    d.stat = "max"; d.region = "inside";
    const floor = D.canonicalDef(d);
    floor.name = S.names.floor; floor.stat = S.floorStat; floor.region = S.floorRegion;
    floor.units = ""; floor.description = "";
    const snr = D.newDef("formula", S.file);
    snr.name = S.names.snr; snr.expr = `${quoteName(d.name)} - ${quoteName(floor.name)}`;
    return [d, floor, snr];
  }

  // ---------------------------------------------------------------- init def
  if (opts.edit) {
    S.def = D.canonicalDef(opts.edit);
    if (S.def.kind === "combine" || S.def.kind === "transform") {
      // edited as the equivalent formula (saved as kind "formula")
      const f = D.newDef("formula", S.def.file);
      f.expr = legacyFormula(S.def); f.units = S.def.units; f.description = S.def.description;
      S.def = f;
    }
    S.names.main = opts.edit.name;
    if (opts.asNew) S.nameTouched = true;
  } else {
    S.def = freshReduce();
  }

  let _initial = "";       // the defs as first shown (to detect unsaved changes)

  // ---------------------------------------------------------------- DOM
  const form = h("div", { class: "builder-form" });
  const pvHead = h("div", { class: "bp-head" });
  const pvPlot = h("div", { class: "bp-plot" });
  const pvSliders = h("div", { class: "bp-sliders" });
  const rsHead = h("div", { class: "bp-head" });
  const rsPlot = h("div", { class: "bp-plot" });
  const statusEl = h("div", { class: "status-line" });
  const preview = h("div", { class: "builder-preview" }, pvHead, pvPlot, pvSliders, rsHead, rsPlot);
  const body = h("div", { class: "builder" }, form, preview);

  const m = modal({
    title: editing ? `Edit derived quantity — ${editing.name}` : "New derived quantity",
    body, wide: true, dismissable: true,
    buttons: [
      { label: "Help", kind: "ghost", id: "help", onClick: () => { showBuilderHelp(); return false; } },
      { spacer: true },
      { label: "Cancel", kind: "ghost", id: "cancel" },
      { label: "Save", kind: "ghost", id: "save", title: "save (it appears in the Datasets tree with a ƒ badge)",
        onClick: () => save(false) },
      { label: editing ? "Save & plot" : "Save & plot", kind: "primary", id: "saveplot",
        title: "save and add it as trace(s) — vs the dimension chosen in the result preview", onClick: () => save(true) },
    ],
    onClose: () => { try { Plotly.purge(pvPlot); Plotly.purge(rsPlot); } catch (e) { /* ignore */ } },
    // closing after changes asks first (a window set by dragging is easy to lose)
    confirmDismiss: () => (JSON.stringify(currentDefs()) === _initial ? true
      : ask("Discard the changes to this derived quantity?", { title: "Discard changes", ok: "Discard", danger: true })),
  });
  // "plot into" chooser next to the buttons
  const whereSel = h("select", { title: "where Save & plot adds the trace(s)" },
    h("option", { value: "here", text: "in this tab" }), h("option", { value: "new", text: "in a new tab" }));
  whereSel.value = S.plotWhere;
  whereSel.onchange = () => { S.plotWhere = whereSel.value; };
  m.foot.insertBefore(h("span", { class: "foot-note", text: "Save & plot" }), m.button("cancel"));
  m.foot.insertBefore(whereSel, m.button("cancel"));
  whereSel.style.width = "auto";

  // ---------------------------------------------------------------- form
  const sel = (items, cur, onchange, attrs = {}) => {
    const s = h("select", attrs);
    for (const it of items) {
      const o = typeof it === "string" ? { id: it, label: it } : it;
      s.appendChild(h("option", { value: o.id, text: o.label, title: o.hint || null }));
    }
    s.value = cur;
    if (s.value !== cur && items.length) s.value = typeof items[0] === "string" ? items[0] : items[0].id;
    s.onchange = () => onchange(s.value);
    return s;
  };
  const field = (lt, ctl, title) => h("label", { title: title || null }, h("span", { class: "lt", text: lt }), ctl);
  const note = (html, cls = "") => h("div", { class: "note " + cls, html });
  const set = (k, v, rerender = true) => { S.def[k] = v; autoNames(); pickResultAxes(); if (rerender) render(); else schedule(); };

  // ---- expression inputs ----------------------------------------------------
  // a text box bound to one expression field (window bound / formula), checked
  // live; it shows the value the expression takes at the previewed slice
  let exprInputs = [];        // rebuilt on every render
  let lastExpr = null;        // the expression box the picker inserts into
  function exprInput(field, label, placeholder, title, target) {
    const obj = target();
    const inp = h("input", { type: "text", class: "expr", value: obj[field] || "", placeholder,
      spellcheck: false, autocomplete: "off" });
    const val = h("span", { class: "expr-val", title: "value at the previewed slice" });
    const err = h("div", { class: "note err expr-err", hidden: true });
    // the picker inserts into the box last focused / clicked / typed in
    const own = () => { if (!lastExpr || lastExpr.inp !== inp) { lastExpr = { inp, field }; markTarget(); } };
    inp.oninput = () => { own(); target()[field] = inp.value; autoNames(); schedule(); };
    inp.onfocus = own;
    inp.onclick = own;
    inp.onkeyup = own;
    const row = h("label", { class: "expr-row", title }, h("span", { class: "lt", text: label }), inp, val);
    exprInputs.push({ field, inp, val, err });
    return [row, err];
  }
  function markTarget() {
    for (const e of exprInputs) e.inp.classList.toggle("target", !!lastExpr && e.inp === lastExpr.inp);
  }
  // insert text at the cursor of the target box (a function wraps the selection)
  function insertIntoExpr(text, isFunc) {
    const t = (lastExpr && document.body.contains(lastExpr.inp)) ? lastExpr : exprInputs[0];
    if (!t) return;
    const inp = t.inp;
    const a = inp.selectionStart ?? inp.value.length, b = inp.selectionEnd ?? inp.value.length;
    const selTxt = inp.value.slice(a, b);
    const ins = isFunc ? `${text}(${selTxt})` : text;
    inp.value = inp.value.slice(0, a) + ins + inp.value.slice(b);
    const caret = isFunc && !selTxt ? a + text.length + 1 : a + ins.length;
    inp.focus();
    inp.setSelectionRange(caret, caret);
    inp.dispatchEvent(new Event("input"));
    lastExpr = t; markTarget();
  }
  // clickable names (variables / dimensions) + a functions menu + syntax help
  function picker(names, what) {
    const box = h("div", { class: "picker" });
    box.appendChild(h("span", { class: "picker-t", text: "Insert:" }));
    for (const n of names) {
      const dimsTxt = n.dims && n.dims.length ? n.dims.join(", ") : "scalar";
      const chip = h("button", { class: "chip" + (n.isDim ? " dim" : ""), type: "button",
        title: `${n.name}${n.units ? ` (${n.units})` : ""} — ${n.isDim ? "dimension index / coordinate" : `dims: ${dimsTxt}`}`
          + (what === "window" ? "\nits value for the spectrum being reduced" : "") },
      n.label || n.name);
      chip.onmousedown = (e) => e.preventDefault();        // keep the focus in the expression box
      chip.onclick = () => insertIntoExpr(quoteName(n.name), false);
      box.appendChild(chip);
    }
    const fn = h("button", { class: "chip fn", type: "button", text: "ƒ functions ▾", title: "insert a function" });
    fn.onmousedown = (e) => e.preventDefault();
    fn.onclick = () => menu(fn, D.FUNCTIONS.map((f) => ({ label: f.sig, hint: f.doc, onClick: () => insertIntoExpr(f.name, true) })));
    const help = h("button", { class: "chip link", type: "button", text: "syntax ?", title: "how expressions work" });
    help.onclick = () => showExprHelp(what);
    box.append(fn, help);
    return box;
  }

  // numbers written into expressions by drags. Positions are snapped to ~1/1000
  // of the visible x span (a pixel is coarser than that anyway); ratios to 2
  // significant digits, so a drag yields "6*RBW", not "6.037*RBW"
  const fmtE = (v) => fmtSI(parseFloat(Number(v).toPrecision(6)));
  function snapX(v) {
    const xa = pvPlot._fullLayout && pvPlot._fullLayout.xaxis;
    const span = xa && xa.range ? Math.abs(xa.range[1] - xa.range[0]) : NaN;
    if (!Number.isFinite(span) || span <= 0 || !Number.isFinite(v)) return v;
    const step = Math.pow(10, Math.floor(Math.log10(span)) - 3);
    return Math.round(v / step) * step;
  }
  const fmtX = (v) => fmtE(snapX(v));
  const fmtR = (v) => fmtSI(parseFloat(Number(v).toPrecision(2)));
  // does `t` have a + or - at the top level (outside parentheses / quotes)?
  function topLevelAddSub(t) {
    let depth = 0, q = false;
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      if (c === '"') { q = !q; continue; }
      if (q) continue;
      if (c === "(") depth++;
      else if (c === ")") depth--;
      else if ((c === "+" || c === "-") && depth === 0 && i > 0) {
        const before = t.slice(0, i).trimEnd();
        if (/[0-9.][eE]$/.test(before) || /[*/^(,+-]$/.test(before)) continue;   // exponent sign / unary
        return true;
      }
    }
    return false;
  }
  // a width expression scaled so it evaluates to `want` (it is `cur` now):
  // a plain number is replaced, "c*rest" gets a new coefficient, else "r*(expr)"
  function rescaleExpr(expr, want, cur) {
    const t = String(expr || "").trim();
    if (!t || parseNum(t) !== null || !Number.isFinite(cur) || cur === 0) return fmtX(want);
    const ratio = want / cur;
    const m = /^([0-9.]+(?:[eE][+-]?\d+)?[pnuµμmkKMGT]?)\s*\*\s*(.+)$/.exec(t);
    if (m && parseNum(m[1]) !== null && !topLevelAddSub(m[2])) return `${fmtR(parseNum(m[1]) * ratio)}*${m[2]}`;
    return `${fmtR(ratio)}*(${t})`;
  }
  // a center expression shifted by `delta` (a trailing "+/- number" is updated)
  function shiftExpr(expr, delta) {
    const t = String(expr || "").trim();
    if (!delta || !Number.isFinite(delta)) return t;
    const n = parseNum(t);
    if (n !== null) return fmtX(n + delta);
    const m = /^(.*\S)\s*([+-])\s*([0-9.]+(?:[eE][+-]?\d+)?[pnuµμmkKMGT]?)$/.exec(t);
    if (m && parseNum(m[3]) !== null && !/[*/^(,+-]$/.test(m[1])) {
      const r = snapX((m[2] === "-" ? -1 : 1) * parseNum(m[3]) + delta);
      return r === 0 ? m[1] : `${m[1]} ${r < 0 ? "-" : "+"} ${fmtE(Math.abs(r))}`;
    }
    const r = snapX(delta);
    return r === 0 ? t : `${t} ${r < 0 ? "-" : "+"} ${fmtE(Math.abs(r))}`;
  }

  function render() {
    form.innerHTML = "";
    exprInputs = [];
    const def = S.def;
    const d = ds();

    // presets (only for new defs)
    if (!editing) {
      const pr = h("div", { class: "presets" });
      for (const p of PRESETS) {
        const b = h("button", { class: "ghost" + (S.preset === p.id ? " on" : ""), text: p.label, title: p.title });
        b.onclick = () => applyPreset(p.id);
        pr.appendChild(b);
      }
      form.appendChild(pr);
    }
    // kind tabs (custom only)
    if (S.preset === "custom") {
      const kt = h("div", { class: "kind-tabs" });
      for (const k of KINDS) {
        const b = h("button", { class: def.kind === k.id ? "on" : "", text: k.label, title: k.title });
        b.onclick = () => {
          if (def.kind === k.id) return;
          const nd = k.id === "reduce" ? freshReduce() : D.newDef(k.id, S.file);
          nd.units = def.units; nd.description = def.description;
          S.def = nd; autoNames(); pickResultAxes(true); render();
        };
        kt.appendChild(b);
      }
      form.appendChild(kt);
    }

    // file
    const sec0 = h("div", { class: "sec" }, h("div", { class: "sec-t", text: "Data" }));
    const fsel = sel(state.fileOrder, S.file, (v) => {
      S.file = v; S.slice = {};
      const old = S.def;
      if (old.kind === "reduce") {
        const keep = { ...old, file: v };
        const vd = ds().vars[keep.src];
        S.def = vd ? D.canonicalDef(keep) : freshReduce();
      } else S.def = D.canonicalDef({ ...old, file: v });
      autoNames(); pickResultAxes(true); render();
    }, { disabled: !!editing });
    sec0.appendChild(field("File", fsel, editing ? "a saved quantity stays on its file — use 'Copy recipe to' to put it on another file" : "the dataset to compute from"));
    form.appendChild(sec0);

    if (def.kind === "reduce") renderReduce(sec0, d, def);
    else renderFormula(sec0, d, def);

    // output
    const sec = h("div", { class: "sec" }, h("div", { class: "sec-t", text: "Result" }));
    const nameInp = h("input", { type: "text", value: S.names.main, placeholder: "name", maxlength: 64 });
    nameInp.oninput = () => { S.names.main = nameInp.value.trim(); S.nameTouched = true; schedule(); };
    S._nameInps = { main: nameInp };
    if (S.preset === "snr" && def.kind === "reduce") {
      sec.appendChild(field("Peak name", nameInp, "name of the peak quantity"));
      const f1 = h("input", { type: "text", value: S.names.floor, maxlength: 64 });
      f1.oninput = () => { S.names.floor = f1.value.trim(); S.nameTouched = true; schedule(); };
      const f2 = h("input", { type: "text", value: S.names.snr, maxlength: 64 });
      f2.oninput = () => { S.names.snr = f2.value.trim(); S.nameTouched = true; schedule(); };
      sec.appendChild(field("Floor name", f1));
      sec.appendChild(field("SNR name", f2, "SNR = peak − floor (dB for dB data)"));
      S._nameInps.floor = f1; S._nameInps.snr = f2;
    } else {
      sec.appendChild(field("Name", nameInp, "letters, digits, space, _ . + - (max 64)"));
    }
    const unitsInp = h("input", { type: "text", value: def.units || "", maxlength: 32, placeholder: "auto" });
    unitsInp.oninput = () => { S.def.units = unitsInp.value; schedule(); };
    S._unitsInp = unitsInp;
    sec.appendChild(field("Units", unitsInp, "blank = automatic from the source units"));
    const descInp = h("input", { type: "text", value: def.description || "", maxlength: 200, placeholder: "description" });
    descInp.oninput = () => { S.def.description = descInp.value; };
    S._descInp = descInp;
    sec.appendChild(field("Description", descInp, "free text (shown in the Info panel); blank = automatic"));
    form.appendChild(sec);
    form.appendChild(statusEl);
    if (!exprInputs.some((e) => lastExpr && e.field === lastExpr.field)) lastExpr = null;
    else { const e = exprInputs.find((q) => q.field === lastExpr.field); lastExpr = { inp: e.inp, field: e.field }; }
    markTarget();
    schedule(true);
  }

  function renderReduce(sec, d, def) {
    const vars = numericVars(1);
    if (!vars.length) { sec.appendChild(note("This file has no numeric variable with a dimension.", "err")); return; }
    if (!vars.includes(def.src)) { def.src = vars[0]; def.over = defaultOver(def.src); def.xsrc = D.suggestXsrc(d, def.src, def.over); }
    const v = d.vars[def.src];
    sec.appendChild(field("Source", sel(vars.map((n) => ({ id: n, label: `${n}  (${d.vars[n].dims.join(", ")})` })), def.src, (val) => {
      S.def.src = val; S.def.over = defaultOver(val); S.def.xsrc = D.suggestXsrc(d, val, S.def.over);
      S.slice = {}; autoNames(); pickResultAxes(true); render();
    }), "the variable to process — e.g. the stack of spectra"));
    if (!v.dims.includes(def.over)) def.over = defaultOver(def.src);
    sec.appendChild(field("Reduce along", sel(v.dims.map((dim) => ({ id: dim, label: `${dim}  (${d.size(dim)})` })), def.over, (val) => {
      S.def.over = val; S.def.xsrc = D.suggestXsrc(d, S.def.src, val); S.slice = {};
      autoNames(); pickResultAxes(true); render();
    }), "the dimension that is collapsed — usually the spectrum's frequency-bin dimension"));
    const xs = D.xSourceOptions(d, def.src, def.over);
    if (!xs.includes(def.xsrc)) def.xsrc = D.suggestXsrc(d, def.src, def.over);
    sec.appendChild(field("X values", sel(xs, def.xsrc, (val) => set("xsrc", val)),
      "the x value of each point — the window is defined in these units (e.g. a per-spectrum frequency array)"));
    const xu = (() => { const n = def.xsrc === "coord" ? def.over : (def.xsrc.startsWith("var:") ? def.xsrc.slice(4) : null); return n && d.vars[n] ? X.unitsOf(d.vars[n]) : ""; })();

    // window: every bound is an expression of the names in the picker
    const w = def.window;
    const tw = () => S.def.window;
    const sw = h("div", { class: "sec" }, h("div", { class: "sec-t", text: "Window" + (xu ? ` (x in ${xu})` : "") }));
    sw.appendChild(field("Window", sel(D.WINDOW_MODES, w.mode, (val) => {
      if (val === "center" && !String(w.center || "").trim()) {
        setupWindow(S.def, true);
        if (S.def.window.mode !== "center") {
          const nm = (D.windowNames(d, def.src, def.over)[0] || {}).name;
          S.def.window.center = nm ? quoteName(nm) : "";
          if (!String(S.def.window.halfwidth || "").trim()) S.def.window.halfwidth = "1";
        }
      } else if (val === "range" && !(String(w.lo || "").trim() && String(w.hi || "").trim())) setupWindow(S.def, false);
      S.def.window.mode = val;
      if (val === "none") S.def.region = "inside";
      autoNames(); pickResultAxes(true); render();
    }), "which x values are used"));
    if (w.mode === "range") {
      sw.append(...exprInput("lo", "from", "e.g. 0.9*stimulusFrequency", "lower edge (x units)", tw));
      sw.append(...exprInput("hi", "to", "e.g. 1.1*stimulusFrequency", "upper edge (x units)", tw));
    } else if (w.mode === "center") {
      sw.append(...exprInput("center", "center", "e.g. stimulusFrequency or 2*stimulusFrequency",
        "the window center (x units) — e.g. the stimulus frequency, a harmonic k*f, plus an offset", tw));
      sw.append(...exprInput("halfwidth", "± half width", "e.g. 0.01*stimulusFrequency or 3*ResolutionBWs",
        "the window is center ± this (x units); it can follow other quantities", tw));
    }
    if (w.mode !== "none") {
      const outerDefault = () => {
        const p = S._p;
        if (w.mode === "range" && !(String(w.lo2 || "").trim() && String(w.hi2 || "").trim())) {
          const lo = p && p.inner ? p.inner[0] : D.exprValueAt(d, S.def, "lo", S.slice);
          const hi = p && p.inner ? p.inner[1] : D.exprValueAt(d, S.def, "hi", S.slice);
          if (Number.isFinite(lo) && Number.isFinite(hi)) {
            const span = Math.abs(hi - lo) || 1;
            S.def.window.lo2 = fmtE(Math.min(lo, hi) - 3 * span); S.def.window.hi2 = fmtE(Math.max(lo, hi) + 3 * span);
          }
        }
        if (w.mode === "center" && !String(w.halfwidth2 || "").trim()) {
          const cur = p && p.inner ? (p.inner[1] - p.inner[0]) / 2 : NaN;
          S.def.window.halfwidth2 = rescaleExpr(w.halfwidth, 5 * cur, cur);
        }
      };
      sw.appendChild(field("Use points", sel(D.REGIONS, def.region, (val) => {
        if (val === "outside_within") outerDefault();
        set("region", val);
      }), "inside the window (e.g. the tone), outside it (e.g. the noise floor), or outside it but within a wider span"));
      S._outerDefault = outerDefault;
      if (def.region === "outside_within") appendOuter(sw, w);
      sw.appendChild(picker(D.windowNames(d, def.src, def.over), "window"));
      sw.appendChild(note("Each expression is evaluated <b>per spectrum</b>: a name stands for its value for the spectrum being reduced "
        + "(e.g. <code>stimulusFrequency</code>, <code>ResolutionBWs</code>). Drag across the preview to set the window; drag the band or its edges to adjust it."));
    } else {
      sw.appendChild(note("Tip: drag across the spectrum preview to set a window."));
    }
    form.appendChild(sw);

    // statistic
    const st = h("div", { class: "sec" }, h("div", { class: "sec-t", text: "Statistic" }));
    if (S.preset === "snr") {
      st.appendChild(note("<b>Peak</b> = max inside the window · <b>Floor</b> = statistic below, over the points chosen here · <b>SNR</b> = peak − floor.", ""));
      st.appendChild(field("Floor statistic", sel(D.STATS.filter((s) => ["mean", "median", "min", "max"].includes(s.id)), S.floorStat,
        (val) => { S.floorStat = val; schedule(); })));
      st.appendChild(field("Floor points", sel(D.REGIONS.filter((r) => r.id !== "inside"), S.floorRegion, (val) => {
        S.floorRegion = val;
        if (val === "outside_within" && S._outerDefault) S._outerDefault();
        render();
      })));
      if (S.floorRegion === "outside_within" && w.mode !== "none") appendOuter(st, w);
    } else {
      const sSel = sel(D.STATS, def.stat, (val) => set("stat", val));
      st.appendChild(field("Statistic", sSel, (D.STATS.find((s) => s.id === def.stat) || {}).hint));
    }
    const srcU = X.unitsOf(v);
    const dbAuto = D.isDb(srcU);
    st.appendChild(field("dB handling", sel(D.DB_MODES, def.db, (val) => set("db", val)),
      "mean / median / std / sum / integral of dB data must be computed in linear power, then converted back to dB"));
    st.appendChild(note(def.db === "auto"
      ? (dbAuto ? `units “${srcU}” → dB data: averages are taken in <b>linear power</b> (10^(x/10)) and converted back.`
        : `units “${srcU || "none"}” → linear data (values used as-is).`)
      : (def.db === "yes" ? "Treated as dB: averages in linear power." : "Treated as linear: values used as-is."), ""));
    form.appendChild(st);
  }

  // the outer span of "outside, within outer span" (range: two bounds; center: a half width)
  function appendOuter(box, w) {
    const tw = () => S.def.window;
    if (w.mode === "range") {
      box.append(...exprInput("lo2", "outer from", "e.g. 0.5*stimulusFrequency", "points below this are ignored", tw));
      box.append(...exprInput("hi2", "outer to", "e.g. 1.5*stimulusFrequency", "points above this are ignored", tw));
    } else {
      box.append(...exprInput("halfwidth2", "outer ± half width", "e.g. 0.1*stimulusFrequency",
        "points farther than this from the center are ignored", tw));
    }
  }

  function renderFormula(sec, d, def) {
    sec.append(...exprInput("expr", "Formula", "e.g. peak - floor  ·  floor - 10*log10(ResolutionBWs)",
      "an expression of the variables of this file, computed element by element", () => S.def));
    sec.appendChild(picker(D.formulaNames(d).filter((n) => !forbidden().has(n.name)), "formula"));
    sec.appendChild(note("Variables are matched by <b>dimension name</b>: the result has every dimension of the variables "
      + "it uses (e.g. <code>spectrums - spectrums_peak</code> normalizes each spectrum to its own peak). "
      + "Units are worked out automatically (dBm − dBm → dB)."));
  }

  // live check of every expression box + the value it takes at the previewed slice
  function refreshExprBoxes(defs) {
    const d = ds();
    for (const e of exprInputs) {
      // the floor of the SNR preset is the def that needs the outer span
      const owner = defs.length === 3 && ["lo2", "hi2", "halfwidth2"].includes(e.field) ? defs[1] : defs[0];
      let err = null;
      try { err = D.exprError(d, owner, e.field); } catch (x) { err = x.message; }
      e.inp.classList.toggle("bad", !!err);
      e.err.hidden = !err;
      e.err.textContent = err ? "⚠ " + err : "";
      e.val.textContent = "";
      if (!err && e.field !== "expr" && String(e.inp.value).trim()) {
        let v = NaN;
        try { v = D.exprValueAt(d, owner, e.field, S.slice); } catch (x) { v = NaN; }
        e.val.textContent = Number.isFinite(v) ? "= " + fmtSI(parseFloat(v.toPrecision(5))) : "= NaN";
      }
    }
  }

  function showExprHelp(what) {
    const fns = D.FUNCTIONS.map((f) => `<tr><td><code>${f.sig}</code></td><td>${f.doc}</td></tr>`).join("");
    modal({
      title: "Expressions — syntax",
      body: h("div", { class: "expr-help", html: `
        <p>${what === "window"
          ? "Window expressions are evaluated <b>for every spectrum</b> (every index of the remaining dimensions): a name stands for its value for that spectrum. Usable names: the remaining dimensions (their coordinate, or the index when there is none) and the variables that depend only on them."
          : "A formula is computed element by element. Variables are matched by <b>dimension name</b>; the result has every dimension of the variables it uses."}</p>
        <h4>Examples</h4>
        <pre class="code">stimulusFrequency                  center on the stimulus
2*stimulusFrequency + 5k           2nd harmonic, shifted by 5 kHz
0.01*stimulusFrequency             half width = 1 % of the stimulus frequency
3*ResolutionBWs                    half width = 3 × the RBW used for that spectrum
peak - floor                       SNR (dB) from two derived quantities
floor - 10*log10(ResolutionBWs)    noise floor normalized to 1 Hz (dBm/Hz)</pre>
        <h4>Syntax</h4>
        <table class="kv">
          <tr><td><code>+ - * /</code></td><td>arithmetic; <code>^</code> (or <code>**</code>) power; parentheses</td></tr>
          <tr><td><code>5k 1.5M 2G 10m 3u 2e-3</code></td><td>numbers with SI suffixes p n u (µ) m k M G T, or exponents</td></tr>
          <tr><td><code>"my var"</code></td><td>quote names with spaces or other characters</td></tr>
          <tr><td><code>pi</code></td><td>π</td></tr>
          ${fns}
        </table>
        <p class="hint">NaN propagates; a result that is not a finite number becomes NaN. A window whose bounds are not finite numbers
        for some spectrum uses no points there (the result is NaN).</p>` }),
      buttons: [{ spacer: true }, { label: "Close", kind: "primary", id: "ok" }],
    });
  }

  // ---------------------------------------------------------------- preview
  let _t = null;
  function schedule(now) {
    clearTimeout(_t);
    _t = setTimeout(updatePreview, now ? 0 : 120);
  }

  function validateAll(defs) {
    const d = ds();
    const pending = [];        // defs saved earlier in this batch count as taken
    for (const q of defs) {
      const err = D.validateName(d, [...otherDefs(), ...pending], q.name, editing && q === defs[0] ? editing.name : undefined);
      if (err) return `${q === defs[0] ? "" : q.name + ": "}${err}`;
      if (editing && q.name !== editing.name && d.has(q.name) && !d.vars[q.name].derived) return `'${q.name}' is already a variable.`;
      pending.push(q);
    }
    return null;
  }

  function computeAll(defs) {
    // compute the batch against the dataset without registering it: the SNR of
    // a companion batch is computed from the two arrays it combines
    const d = ds();
    const out = [];
    for (const q of defs) {
      if (q.kind === "formula" && out.length === 2 && S.preset === "snr" && defs.length === 3) {
        const a = out[0].res, b = out[1].res;
        const data = new Float64Array(a.data.length);
        for (let i = 0; i < data.length; i++) { const v = a.data[i] - b.data[i]; data[i] = Number.isFinite(v) ? v : NaN; }
        out.push({ def: q, res: { dims: a.dims, shape: a.shape, data, attrs: { units: D.isDb(a.attrs.units) && D.isDb(b.attrs.units) ? "dB" : a.attrs.units } } });
        continue;
      }
      out.push({ def: q, res: D.computeDef(d, q) });
    }
    return out;
  }

  function updatePreview() {
    const d = ds();
    if (!d || !S.def) return;
    const defs = currentDefs();
    let res = null, err = null;
    try { res = computeAll(defs); } catch (e) { err = e.message; }
    S.result = res;
    const nameErr = validateAll(defs);
    // status line
    statusEl.className = "status-line" + (err ? " bad" : nameErr ? " bad" : " good");
    if (err) statusEl.textContent = "⚠ " + err;
    else {
      const r = res[0].res;
      const dimsTxt = r.dims.length ? r.dims.map((dd, i) => `${dd}:${r.shape[i]}`).join(" × ") : "scalar";
      const u = r.attrs.units ? ` · units ${r.attrs.units}` : "";
      statusEl.textContent = (nameErr ? `⚠ ${nameErr} — ` : "✓ ") + `result: ${dimsTxt} (${r.data.length} value${r.data.length === 1 ? "" : "s"})${u}`;
    }
    refreshExprBoxes(defs);
    // automatic names follow the definition until the user types one
    if (!S.nameTouched && S._nameInps)
      for (const [k, el] of Object.entries(S._nameInps)) if (el && el.value !== S.names[k]) el.value = S.names[k];
    let autoU = "";
    try { autoU = D.autoUnits(d, defs[0]); } catch (e) { /* ignore */ }
    if (S._unitsInp) S._unitsInp.placeholder = autoU ? `auto: ${autoU}` : "auto (none)";
    if (S._descInp) { let ds0 = ""; try { ds0 = D.describeDef(defs[0]); } catch (e) { /* ignore */ } S._descInp.placeholder = ds0 || "description"; }
    m.button("save").disabled = !!(err || nameErr);
    m.button("saveplot").disabled = !!(err || nameErr) || !res || res[0].res.dims.length === 0;
    drawSourcePreview(defs, err);
    drawResultPreview(res, err);
  }

  // one line of the source with the window drawn as draggable shaded bands
  let _roles = [];
  function drawSourcePreview(defs, err) {
    const d = ds();
    const def = defs[0];
    pvHead.innerHTML = "";
    pvSliders.innerHTML = "";
    if (def.kind !== "reduce") {
      pvHead.append(h("span", { class: "bp-title", text: "Formula" }),
        h("span", { class: "bp-stat", text: (def.expr || "").trim() ? `${def.name || "result"} = ${def.expr}` : "type an expression" }));
      pvPlot.style.display = "none";
      return;
    }
    pvPlot.style.display = "";
    let rd = [];
    try { const r = D.resultShape(d, def); rd = r ? r.dims : []; } catch (e) { rd = []; }
    // sliders for the result dims: which spectrum is previewed
    for (const dim of rd) {
      const n = d.size(dim);
      const k = Math.max(0, Math.min(S.slice[dim] | 0, n - 1));
      S.slice[dim] = k;
      if (n <= 1) continue;
      const row = h("div", { class: "slider-row" });
      const s = h("input", { type: "range", min: 0, max: n - 1, value: k, title: `${dim}: preview index` });
      const val = h("span", { class: "sl-val", text: X.sliderValue(d, dim, k) });
      s.oninput = () => { S.slice[dim] = +s.value; val.textContent = X.sliderValue(d, dim, +s.value); schedule(true); };
      row.append(h("span", { class: "sl-name", text: dim, title: dim }), s, val);
      pvSliders.appendChild(row);
    }
    let p = null, pErr = err;
    if (!pErr) { try { p = D.previewSlice(d, def, S.slice); } catch (e) { pErr = e.message; } }
    let pFloor = null;
    if (!pErr && defs.length === 3) { try { pFloor = D.previewSlice(d, defs[1], S.slice); } catch (e) { pFloor = null; } }
    const units = (() => { const v = d.vars[def.src]; return v ? X.unitsOf(v) : ""; })();
    const xname = def.xsrc === "index" ? `${def.over} (index)` : def.xsrc === "coord" ? def.over : def.xsrc.slice(4);
    const xv = def.xsrc === "coord" ? d.vars[def.over] : (def.xsrc.startsWith("var:") ? d.vars[def.xsrc.slice(4)] : null);
    const xu = xv ? X.unitsOf(xv) : "";
    const statLab = (D.STATS.find((s) => s.id === def.stat) || {}).label || def.stat;
    pvHead.append(h("span", { class: "bp-title", text: `${def.src} along ${def.over}` + (rd.length ? " — preview line" : "") }));
    if (p) {
      const fmtV = (x) => (Number.isFinite(x) ? X.fmt6(x) : "NaN");
      const vu = D.effectiveUnits(d, def);
      let txt = `${defs.length === 3 ? "peak" : statLab}: ${fmtV(p.value)}${vu ? " " + vu : ""} · ${p.count} point${p.count === 1 ? "" : "s"} used`;
      if (pFloor) txt += ` · floor: ${fmtV(pFloor.value)}${units ? " " + units : ""} (${pFloor.count} pts) · SNR: ${fmtV(p.value - pFloor.value)}${D.isDb(units) ? " dB" : ""}`;
      if (p.db && (defs.length === 3 || ["mean", "median", "std", "sum", "integral"].includes(def.stat))) txt += " · dB data → linear-power stats";
      pvHead.append(h("span", { class: "bp-stat", text: txt }));
    }
    pvHead.append(h("span", { class: "legend-chips", html: '<span><i style="background:rgba(21,101,192,.18);border:1px solid #1565c0"></i>window</span>'
      + '<span><i style="background:#1565c0"></i>points used</span>' + (defs.length === 3 ? '<span><i style="background:#e6a700"></i>floor points</span>' : "") }));
    if (!p) {
      Plotly.react(pvPlot, [], { margin: { l: 50, r: 10, t: 10, b: 30 }, annotations: [{ text: pErr ? "⚠ " + pErr : "", showarrow: false, xref: "paper", yref: "paper", x: 0.5, y: 0.5, font: { color: "#c0392b" } }],
        xaxis: { visible: false }, yaxis: { visible: false } }, { displaylogo: false, responsive: true });
      return;
    }
    const data = [{ type: "scatter", mode: "lines", x: Array.from(p.x), y: Array.from(p.y), line: { color: "#9aa6b4", width: 1 },
      name: "all points", hoverinfo: "x+y" }];
    const mx = [], my = [];
    for (let k = 0; k < p.x.length; k++) if (p.member[k] && Number.isFinite(p.y[k])) { mx.push(p.x[k]); my.push(p.y[k]); }
    data.push({ type: "scatter", mode: "markers", x: mx, y: my, marker: { color: "#1565c0", size: 4 }, name: "used", hoverinfo: "x+y" });
    if (pFloor) {
      const fx = [], fy = [];
      for (let k = 0; k < pFloor.x.length; k++) if (pFloor.member[k] && Number.isFinite(pFloor.y[k])) { fx.push(pFloor.x[k]); fy.push(pFloor.y[k]); }
      data.push({ type: "scatter", mode: "markers", x: fx, y: fy, marker: { color: "#e6a700", size: 3 }, name: "floor", hoverinfo: "x+y" });
    }
    // the result, drawn on the line where it makes sense
    const shapes = [];
    _roles = [];
    const markVal = (val, color, label) => {
      if (!Number.isFinite(val)) return;
      shapes.push({ type: "line", xref: "paper", x0: 0, x1: 1, y0: val, y1: val, line: { color, width: 1.5, dash: "dash" } });
      _roles.push("value");
    };
    if (["max", "min"].includes(def.stat) || defs.length === 3) {
      // marker at the extreme point
      let best = -1;
      for (let k = 0; k < p.x.length; k++) {
        if (!p.member[k] || !Number.isFinite(p.y[k])) continue;
        if (best < 0 || (def.stat === "min" && defs.length !== 3 ? p.y[k] < p.y[best] : p.y[k] > p.y[best])) best = k;
      }
      if (best >= 0) data.push({ type: "scatter", mode: "markers", x: [p.x[best]], y: [p.y[best]], name: "result",
        marker: { symbol: "circle-open", size: 13, color: "#c0392b", line: { width: 2 } }, hoverinfo: "x+y" });
    } else if (["argmax_x", "argmin_x"].includes(def.stat) && Number.isFinite(p.value)) {
      shapes.push({ type: "line", yref: "paper", x0: p.value, x1: p.value, y0: 0, y1: 1, line: { color: "#c0392b", width: 1.5, dash: "dash" } });
      _roles.push("value");
    } else if (["mean", "median"].includes(def.stat)) markVal(p.value, "#c0392b");
    if (pFloor) markVal(pFloor.value, "#e6a700");
    // windows (draggable)
    if (p.outer) {
      shapes.push({ type: "rect", xref: "x", yref: "paper", x0: p.outer[0], x1: p.outer[1], y0: 0, y1: 1, layer: "below",
        fillcolor: "rgba(13,107,63,0.06)", line: { color: "#0d6b3f", width: 1, dash: "dash" } });
      _roles.push("outer");
    }
    if (pFloor && !p.outer && S.floorRegion === "outside_within") {
      try {
        if (pFloor.outer) {
          shapes.push({ type: "rect", xref: "x", yref: "paper", x0: pFloor.outer[0], x1: pFloor.outer[1], y0: 0, y1: 1, layer: "below",
            fillcolor: "rgba(13,107,63,0.06)", line: { color: "#0d6b3f", width: 1, dash: "dash" } });
          _roles.push("outer");
        }
      } catch (e) { /* ignore */ }
    }
    if (p.inner) {
      shapes.push({ type: "rect", xref: "x", yref: "paper", x0: p.inner[0], x1: p.inner[1], y0: 0, y1: 1, layer: "below",
        fillcolor: def.region === "inside" ? "rgba(21,101,192,0.16)" : "rgba(192,57,43,0.10)",
        line: { color: def.region === "inside" ? "#1565c0" : "#c0392b", width: 1 } });
      _roles.push("inner");
    }
    if (p.center != null && Number.isFinite(p.center)) {
      shapes.push({ type: "line", xref: "x", yref: "paper", x0: p.center, x1: p.center, y0: 0, y1: 1, line: { color: "#7d3cff", width: 1, dash: "dot" } });
      _roles.push("center");
    }
    const layout = {
      margin: { l: 58, r: 12, t: 8, b: 40 }, showlegend: false, hovermode: "closest",
      xaxis: { title: { text: xname + (xu ? ` (${xu})` : ""), font: { size: 11 } }, showline: true, mirror: true, linecolor: "#444", zeroline: false },
      yaxis: { title: { text: def.src + (units ? ` (${units})` : ""), font: { size: 11 } }, showline: true, mirror: true, linecolor: "#444", zeroline: false },
      shapes, dragmode: "select", selectdirection: "h",
      uirevision: `${S.file}|${def.src}|${def.over}|${def.xsrc}|${JSON.stringify(S.slice)}`,
      paper_bgcolor: "white", plot_bgcolor: "white",
    };
    Plotly.react(pvPlot, data, layout, { displaylogo: false, responsive: true, edits: { shapePosition: true },
      modeBarButtonsToRemove: ["lasso2d", "autoScale2d", "toImage"] });
    if (!pvPlot._ncxBound) {
      pvPlot._ncxBound = true;
      pvPlot.on("plotly_relayout", onShapeEdit);
      pvPlot.on("plotly_selected", onSelect);
    }
    S._p = p;
  }

  // window edits from the plot -> the def (expressions are edited, not replaced,
  // where that keeps their meaning: "0.01*f" -> "0.02*f", "f + 5k" -> "f + 7k")
  function setWindowFromRange(x0, x1, role) {
    const w = S.def.window;
    const lo = Math.min(x0, x1), hi = Math.max(x0, x1);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return;
    const p = S._p;
    if (w.mode === "none") {
      // a drag on a whole-span window creates a range
      w.mode = "range"; w.lo = fmtX(lo); w.hi = fmtX(hi);
    } else if (w.mode === "range") {
      if (role === "outer") { w.lo2 = fmtX(lo); w.hi2 = fmtX(hi); } else { w.lo = fmtX(lo); w.hi = fmtX(hi); }
    } else {
      const center = p && Number.isFinite(p.center) ? p.center : (lo + hi) / 2;
      if (role === "outer") {
        const cur = p && p.outer ? (p.outer[1] - p.outer[0]) / 2 : NaN;
        w.halfwidth2 = rescaleExpr(w.halfwidth2, Math.max(Math.abs(lo - center), Math.abs(hi - center)), cur);
      } else if (role === "center") {
        w.center = shiftExpr(w.center, (lo + hi) / 2 - center);
      } else {
        // a drag roughly centered on the current center only sets the width;
        // an off-center one (or moving the band) also shifts the center
        const mid = (lo + hi) / 2, hw = (hi - lo) / 2;
        const cur = p && p.inner ? (p.inner[1] - p.inner[0]) / 2 : NaN;
        if (role !== "drag-move") w.halfwidth = rescaleExpr(w.halfwidth, hw, cur);
        if (Math.abs(mid - center) > 0.25 * hw || role === "drag-move") w.center = shiftExpr(w.center, mid - center);
      }
    }
    render();
  }
  const nice3 = (v) => (Number.isFinite(v) ? parseFloat(v.toPrecision(4)) : v);
  function onShapeEdit(ev) {
    if (!ev) return;
    const keys = Object.keys(ev).filter((k) => /^shapes\[\d+\]\.x[01]$/.test(k));
    if (!keys.length) return;
    const i = +/^shapes\[(\d+)\]/.exec(keys[0])[1];
    const role = _roles[i];
    if (!role || role === "value") { schedule(true); return; }
    const shp = pvPlot.layout.shapes[i];
    const x0 = ev[`shapes[${i}].x0`] ?? shp.x0, x1 = ev[`shapes[${i}].x1`] ?? shp.x1;
    // both edges changed = the band was moved (not resized)
    const moved = (`shapes[${i}].x0` in ev) && (`shapes[${i}].x1` in ev) && S._p && S._p.inner
      && Math.abs((+x1 - +x0) - (S._p.inner[1] - S._p.inner[0])) < 1e-9 * Math.max(1, Math.abs(+x1));
    setWindowFromRange(+x0, +x1, role === "inner" && moved ? "drag-move" : role);
  }
  function onSelect(ev) {
    if (!ev || !ev.range || !ev.range.x) return;
    const [a, b] = ev.range.x;
    setWindowFromRange(+a, +b, "inner");
  }

  // the derived result vs a chosen remaining dim
  function drawResultPreview(res, err) {
    const d = ds();
    rsHead.innerHTML = "";
    if (err || !res) {
      rsHead.append(h("span", { class: "bp-title", text: "Result" }));
      Plotly.react(rsPlot, [], { margin: { l: 50, r: 10, t: 10, b: 30 }, xaxis: { visible: false }, yaxis: { visible: false },
        annotations: [{ text: err ? "⚠ " + err : "", showarrow: false, xref: "paper", yref: "paper", x: 0.5, y: 0.5, font: { color: "#c0392b" } }] },
      { displaylogo: false, responsive: true });
      return;
    }
    const r0 = res[0].res;
    const dims = r0.dims;
    rsHead.append(h("span", { class: "bp-title", text: "Result" }));
    if (!dims.length) {
      rsHead.append(h("span", { class: "bp-stat", text: res.map((q) => `${q.def.name} = ${X.fmt6(q.res.data[0])} ${q.res.attrs.units || ""}`).join(" · ") }));
      Plotly.react(rsPlot, [], { margin: { l: 50, r: 10, t: 10, b: 30 }, xaxis: { visible: false }, yaxis: { visible: false },
        annotations: [{ text: "scalar result (nothing to plot vs a dimension)", showarrow: false, xref: "paper", yref: "paper", x: 0.5, y: 0.5 }] },
      { displaylogo: false, responsive: true });
      return;
    }
    if (!dims.includes(S.vs)) pickResultAxes(true);
    const vsSel = h("select", { title: "x axis of the result preview (and of the trace Save & plot adds)" });
    for (const dd of dims) vsSel.appendChild(h("option", { value: dd, text: `${dd} (${d.size(dd)})` }));
    vsSel.value = S.vs; vsSel.style.width = "auto";
    vsSel.onchange = () => { S.vs = vsSel.value; if (S.lines === S.vs) S.lines = ""; schedule(true); };
    const lnSel = h("select", { title: "one line per index of this dimension" });
    lnSel.appendChild(h("option", { value: "", text: "(none)" }));
    for (const dd of dims) if (dd !== S.vs) lnSel.appendChild(h("option", { value: dd, text: `${dd} (${d.size(dd)})` }));
    lnSel.value = S.lines; lnSel.style.width = "auto";
    lnSel.onchange = () => { S.lines = lnSel.value; schedule(true); };
    rsHead.append(h("span", { class: "bp-stat", text: "vs" }), vsSel, h("span", { class: "bp-stat", text: "lines for" }), lnSel);
    const others = dims.filter((dd) => dd !== S.vs && dd !== S.lines && d.size(dd) > 1);
    if (others.length) rsHead.append(h("span", { class: "bp-stat", text: `· ${others.map((dd) => `${dd}=${X.sliderValue(d, dd, S.slice[dd] | 0)}`).join(", ")} (sliders above)` }));

    // x values for the vs dim: numeric coordinate, else a 1-D axis var, else index
    const nx = d.size(S.vs);
    let xs = null, xlab = `${S.vs} (index)`;
    const cv = d.coordValues(S.vs);
    if (cv && d.vars[S.vs].isNumeric()) { xs = Array.from(cv, Number); xlab = S.vs + (X.unitsOf(d.vars[S.vs]) ? ` (${X.unitsOf(d.vars[S.vs])})` : ""); }
    else {
      // the dim's natural axis: a 1-D variable named like it (freq -> freq_Hz), else the
      // x source the trace would get
      const cands = d.dimAxisCandidates(S.vs);
      const pref = cands.filter((n) => n.startsWith(S.vs));
      const ref = res[0].def.src || res[0].def.a;
      const sx = ref && d.vars[ref] && d.vars[ref].dims.includes(S.vs) ? D.suggestXsrc(d, ref, S.vs) : "";
      const n0 = pref.length ? pref[0] : (sx && sx.startsWith("var:") && cands.includes(sx.slice(4)) ? sx.slice(4) : null);
      if (n0) { const n = n0; xs = Array.from(X.asFloatArray(d.vars[n].data, d.vars[n].attrs.units)); xlab = n + (X.unitsOf(d.vars[n]) ? ` (${X.unitsOf(d.vars[n])})` : ""); }
    }
    if (!xs) xs = Array.from({ length: nx }, (_, i) => i);
    const data = [];
    const nl = S.lines ? d.size(S.lines) : 1;
    const anyRight = res.length === 3;
    res.forEach((q, qi) => {
      const r = q.res;
      for (let li = 0; li < Math.min(nl, 24); li++) {
        const fixed = { ...S.slice };
        if (S.lines) fixed[S.lines] = li;
        const y = lineOf(r, S.vs, fixed);
        const right = anyRight && qi === 2;
        const color = res.length > 1 ? CYCLE[qi % CYCLE.length] : CYCLE[li % CYCLE.length];
        const nm = (res.length > 1 ? q.def.name : q.def.name) + (S.lines ? ` [${S.lines}=${X.sliderValue(d, S.lines, li).replace(/^\d+: /, "")}]` : "");
        data.push({ type: "scatter", mode: "lines+markers", x: xs, y, name: nm, yaxis: right ? "y2" : "y",
          line: { color, width: 1.5, dash: right ? "dot" : (res.length > 1 ? "solid" : ["solid", "dash", "dot", "dashdot"][Math.floor(li / CYCLE.length) % 4]) },
          marker: { color, size: 6 } });
      }
    });
    // highlight the previewed slice
    const k = S.slice[S.vs] | 0;
    const hx = [], hy = [];
    const fixedNow = { ...S.slice };
    const yNow = lineOf(r0, S.vs, fixedNow);
    if (Number.isFinite(yNow[k])) { hx.push(xs[k]); hy.push(yNow[k]); }
    data.push({ type: "scatter", mode: "markers", x: hx, y: hy, name: "previewed line", showlegend: false,
      marker: { symbol: "circle-open", size: 14, color: "#c0392b", line: { width: 2 } }, hoverinfo: "skip" });
    const u0 = r0.attrs.units;
    const layout = {
      margin: { l: 58, r: anyRight ? 58 : 12, t: 8, b: 40 }, hovermode: "closest",
      showlegend: data.length > 2, legend: { x: 1, y: 1, xanchor: "right", yanchor: "top", bgcolor: "rgba(255,255,255,.7)", font: { size: 10 } },
      xaxis: { title: { text: xlab, font: { size: 11 } }, showline: true, mirror: true, linecolor: "#444", zeroline: false },
      yaxis: { title: { text: (res.length === 3 ? "peak, floor" : res[0].def.name) + (u0 ? ` (${u0})` : ""), font: { size: 11 } }, showline: true, mirror: !anyRight, linecolor: "#444", zeroline: false },
      paper_bgcolor: "white", plot_bgcolor: "white",
    };
    if (anyRight) layout.yaxis2 = { title: { text: `${res[2].def.name}${res[2].res.attrs.units ? ` (${res[2].res.attrs.units})` : ""}`, font: { size: 11 } },
      overlaying: "y", side: "right", showline: true, linecolor: "#444", zeroline: false, showgrid: false };
    Plotly.react(rsPlot, data, layout, { displaylogo: false, responsive: true, modeBarButtonsToRemove: ["lasso2d", "select2d", "toImage"] });
  }

  function lineOf(r, along, fixed) {
    const ax = r.dims.indexOf(along);
    const strides = []; let acc = 1;
    for (let i = r.shape.length - 1; i >= 0; i--) { strides[i] = acc; acc *= r.shape[i]; }
    let base = 0;
    r.dims.forEach((dd, i) => { if (i !== ax) base += Math.max(0, Math.min(fixed[dd] | 0, r.shape[i] - 1)) * strides[i]; });
    const n = r.shape[ax], out = new Array(n);
    for (let k = 0; k < n; k++) { const v = r.data[base + k * strides[ax]]; out[k] = Number.isFinite(v) ? v : null; }
    return out;
  }

  // ---------------------------------------------------------------- save
  function save(plot) {
    const defs = currentDefs();
    const nameErr = validateAll(defs);
    if (nameErr) { ctx.toast(nameErr, "warn"); return false; }
    try { computeAll(defs); } catch (e) { ctx.toast(e.message, "error"); return false; }
    let specs = null;
    if (plot) {
      const dims = (S.result && S.result[0].res.dims) || [];
      const vs = dims.includes(S.vs) ? S.vs : dims[0];
      const lines = S.lines && dims.includes(S.lines) && S.lines !== vs ? S.lines : "";
      specs = defs.map((q, i) => ({ name: q.name, line_dim: vs, sweep: lines, slices: { ...S.slice },
        yaxis: defs.length === 3 && i === 2 ? "right" : "left" }));
    }
    ctx.commitDerived(defs.map((q) => D.canonicalDef(q)), { replace: editing, plot: specs, where: S.plotWhere });
    return true;
  }

  function showBuilderHelp() {
    modal({
      title: "Derived quantities — how they work",
      body: h("div", { html: `
        <p>A <b>window statistic</b> collapses one dimension of a variable (e.g. the frequency bins of a stack of
        spectra) into one number per remaining index — e.g. the <b>peak power</b> near the stimulus frequency for every
        stimulus frequency and amplitude.</p>
        <p>The <b>window</b> is in the units of the chosen <b>X values</b>: <i>from … to …</i>, or <i>center ± half width</i>.
        Every bound is an <b>expression</b> evaluated for each spectrum — e.g. center <code>stimulusFrequency</code> (or
        <code>2*stimulusFrequency</code> for the 2nd harmonic) with half width <code>0.01*stimulusFrequency</code> or
        <code>3*ResolutionBWs</code>. Click a name under the fields to insert it. <i>Use points</i> picks the points inside the
        window, outside it (the noise floor), or outside it but within a wider span.</p>
        <p><b>dB data</b> (units containing “dB”) are averaged in <b>linear power</b>: mean, median, std, sum and integral
        convert 10^(x/10), compute, and convert back to dB (averaging in dB would bias Gaussian noise low by ≈2.5 dB).
        Max/min/argmax are unaffected. NaNs and empty windows are ignored (an empty window gives NaN).</p>
        <p>A <b>formula</b> computes any expression of variables element by element, matching dimensions by name — e.g.
        <code>peak - floor</code> (SNR) or <code>floor - 10*log10(ResolutionBWs)</code> (noise in dBm/Hz).</p>
        <p>Derived quantities are saved in the project, recomputed when it loads, reproduced by the Python report
        script, and can be copied to another file with the same structure (right-click → Copy recipe to).</p>` }),
      buttons: [{ spacer: true }, { label: "Close", kind: "primary", id: "ok" }],
    });
  }

  // first paint
  autoNames();
  if (!opts.edit) applyPreset("peak");
  else { pickResultAxes(true); render(); }
  _initial = JSON.stringify(currentDefs());
}
