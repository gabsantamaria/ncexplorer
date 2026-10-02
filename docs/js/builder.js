// builder.js — the "Derived quantity" dialog. Left: a form for one definition
// (a windowed statistic over a dimension, a combination a ∘ b, or a transform),
// with presets for the common lab cases (peak in a window, noise floor outside
// it, and peak + floor + SNR in one go). Right: a live preview — one source line
// (e.g. one spectrum) with the window drawn as draggable shaded bands, and the
// resulting quantity vs a remaining dimension. All computation is derive.js; this
// file is only the UI. The app passes a context (state, X, D, commitDerived …).

import { h, modal, parseNum, fmtSI, ask } from "./ui.js";

const CYCLE = ["#1565c0", "#c0392b", "#0d6b3f", "#7d3cff", "#e6a700", "#00838f", "#ad1457", "#4e342e"];
const KINDS = [
  { id: "reduce", label: "Window statistic", title: "reduce one dimension: peak, mean, … of the points in an x window" },
  { id: "combine", label: "Combine a ∘ b", title: "a − b, a ÷ b, … (e.g. SNR = peak − floor), broadcast by dimension name" },
  { id: "transform", label: "Transform", title: "dB ↔ linear, a·x + b, |x|" },
];
const PRESETS = [
  { id: "peak", label: "Peak in window", title: "largest value inside a window (e.g. around the stimulus frequency)" },
  { id: "floor", label: "Noise floor outside", title: "mean (in linear power for dB data) outside the window" },
  { id: "snr", label: "Peak + floor + SNR", title: "creates three quantities at once: peak, floor and SNR = peak − floor" },
  { id: "custom", label: "Custom", title: "any statistic / combination / transform" },
];
const OP_WORD = { "-": "minus", "+": "plus", "*": "times", "/": "over", max: "max", min: "min" };
const FN_WORD = { db2lin: "lin", lin2db: "dB", scale: "scaled", abs: "abs" };

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
  // pick a center source whose value lies inside the x range of the line
  function defaultCenter(def) {
    const opts2 = D.centerSourceOptions(ds(), def.src, def.over);
    const xr = xRange(def);
    if (!opts2.length) return { center: "", ok: false };
    if (xr) {
      for (const c of opts2) {
        try {
          const test = { ...def, window: { ...def.window, mode: "relative", center: c, k: 1, offset: 0, halfwidth: 0 }, region: "inside" };
          const p = D.previewSlice(ds(), test, S.slice);
          if (Number.isFinite(p.center) && p.center >= xr[0] && p.center <= xr[1] && p.center !== xr[0]) return { center: c, ok: true };
        } catch (e) { /* try the next */ }
      }
    }
    return { center: opts2[0], ok: false };
  }
  function setupWindow(def, wantRelative) {
    const xr = xRange(def);
    const span = xr ? xr[1] - xr[0] : 0;
    if (wantRelative) {
      const c = defaultCenter(def);
      if (c.ok) {
        def.window = { ...def.window, mode: "relative", center: c.center, k: 1, offset: 0,
          halfwidth: nice(span * 0.01) || 1, halfwidth2: nice(span * 0.25) || 10 };
        return;
      }
    }
    if (xr) {
      const mid = (xr[0] + xr[1]) / 2;
      def.window = { ...def.window, mode: "fixed", lo: nice(mid - span * 0.05), hi: nice(mid + span * 0.05),
        lo2: nice(mid - span * 0.3), hi2: nice(mid + span * 0.3) };
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
    if (d.kind === "combine") base = `${d.a || "a"}_${OP_WORD[d.op] || "op"}_${typeof d.b === "number" ? "c" : (d.b || "b")}`;
    else if (d.kind === "transform") base = `${d.src || "x"}_${FN_WORD[d.fn] || d.fn}`;
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
    const w = S.def && S.def.window;
    const cdim = w && w.mode === "relative" && typeof w.center === "string" && w.center.startsWith("coord:")
      ? w.center.slice(6) : null;
    if (cdim && dims.includes(cdim) && d.size(cdim) > 1) S.vs = cdim;
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
    const snr = D.newDef("combine", S.file);
    snr.name = S.names.snr; snr.a = d.name; snr.op = "-"; snr.b = floor.name;
    return [d, floor, snr];
  }

  // ---------------------------------------------------------------- init def
  if (opts.edit) {
    S.def = D.canonicalDef(opts.edit);
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
  const numInput = (val, onval, ph, title) => {
    const inp = h("input", { type: "text", value: val == null ? "" : fmtSI(val), placeholder: ph || "", title: title || "accepts SI suffixes: 5k, 1.5M, 2G, 10m, 3u" });
    inp.oninput = () => {
      const v = parseNum(inp.value);
      inp.classList.toggle("bad", inp.value.trim() !== "" && v === null);
      if (v !== null || inp.value.trim() === "") { onval(v); schedule(); }
    };
    return inp;
  };
  const set = (k, v, rerender = true) => { S.def[k] = v; autoNames(); pickResultAxes(); if (rerender) render(); else schedule(); };
  const setW = (k, v, rerender = false) => { S.def.window[k] = v; if (rerender) { autoNames(); pickResultAxes(); render(); } else schedule(); };

  function render() {
    form.innerHTML = "";
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
          if (k.id === "combine") { const vs = numericVars(0); nd.a = vs[0] || ""; nd.b = vs[1] || vs[0] || ""; }
          if (k.id === "transform") nd.src = defaultSource();
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
      } else S.def = D.newDef(old.kind, v);
      autoNames(); pickResultAxes(true); render();
    }, { disabled: !!editing });
    sec0.appendChild(field("File", fsel, editing ? "a saved quantity stays on its file — use 'Copy recipe to' to put it on another file" : "the dataset to compute from"));
    form.appendChild(sec0);

    if (def.kind === "reduce") renderReduce(sec0, d, def);
    else if (def.kind === "combine") renderCombine(sec0, d, def);
    else renderTransform(sec0, d, def);

    // output
    const sec = h("div", { class: "sec" }, h("div", { class: "sec-t", text: "Result" }));
    const nameInp = h("input", { type: "text", value: S.names.main, placeholder: "name", maxlength: 64 });
    nameInp.oninput = () => { S.names.main = nameInp.value.trim(); S.nameTouched = true; schedule(); };
    if (S.preset === "snr" && def.kind === "reduce") {
      sec.appendChild(field("Peak name", nameInp, "name of the peak quantity"));
      const f1 = h("input", { type: "text", value: S.names.floor, maxlength: 64 });
      f1.oninput = () => { S.names.floor = f1.value.trim(); S.nameTouched = true; schedule(); };
      const f2 = h("input", { type: "text", value: S.names.snr, maxlength: 64 });
      f2.oninput = () => { S.names.snr = f2.value.trim(); S.nameTouched = true; schedule(); };
      sec.appendChild(field("Floor name", f1));
      sec.appendChild(field("SNR name", f2, "SNR = peak − floor (dB for dB data)"));
    } else {
      sec.appendChild(field("Name", nameInp, "letters, digits, space, _ . + - (max 64)"));
    }
    let autoU = "";
    try { autoU = D.autoUnits(d, { ...def, file: S.file }); } catch (e) { /* ignore */ }
    const unitsInp = h("input", { type: "text", value: def.units || "", maxlength: 32,
      placeholder: autoU ? `auto: ${autoU}` : "auto (none)" });
    unitsInp.oninput = () => { S.def.units = unitsInp.value; schedule(); };
    sec.appendChild(field("Units", unitsInp, "blank = automatic from the source units"));
    const descInp = h("input", { type: "text", value: def.description || "", maxlength: 200,
      placeholder: D.describeDef(def) || "description" });
    descInp.oninput = () => { S.def.description = descInp.value; };
    sec.appendChild(field("Description", descInp, "free text (shown in the Info panel); blank = automatic"));
    form.appendChild(sec);
    form.appendChild(statusEl);
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
      if (S.def.window.mode === "relative" && !D.centerSourceOptions(d, S.def.src, val).includes(S.def.window.center)) S.def.window.mode = "none";
      autoNames(); pickResultAxes(true); render();
    }), "the dimension that is collapsed — usually the spectrum's frequency-bin dimension"));
    const xs = D.xSourceOptions(d, def.src, def.over);
    if (!xs.includes(def.xsrc)) def.xsrc = D.suggestXsrc(d, def.src, def.over);
    sec.appendChild(field("X values", sel(xs, def.xsrc, (val) => set("xsrc", val)),
      "the x value of each point — the window is defined in these units (e.g. a per-spectrum frequency array)"));
    const xu = (() => { const n = def.xsrc === "coord" ? def.over : (def.xsrc.startsWith("var:") ? def.xsrc.slice(4) : null); return n && d.vars[n] ? X.unitsOf(d.vars[n]) : ""; })();

    // window
    const w = def.window;
    const sw = h("div", { class: "sec" }, h("div", { class: "sec-t", text: "Window" + (xu ? ` (x in ${xu})` : "") }));
    sw.appendChild(field("Window", sel(D.WINDOW_MODES, w.mode, (val) => {
      if (val === "relative" && !w.center) { setupWindow(S.def, true); if (S.def.window.mode !== "relative") { S.def.window.mode = "relative"; S.def.window.center = D.centerSourceOptions(d, def.src, def.over)[0] || ""; } }
      else if (val === "fixed" && (w.lo == null || w.hi == null)) setupWindow(S.def, false);
      S.def.window.mode = val;
      if (val === "none") S.def.region = "inside";
      autoNames(); pickResultAxes(); render();
    }), "which x values are used"));
    if (w.mode === "fixed") {
      const r = h("div", { class: "row" },
        field("from", numInput(w.lo, (x) => { S.def.window.lo = x; }, "lo")),
        field("to", numInput(w.hi, (x) => { S.def.window.hi = x; }, "hi")));
      r.querySelectorAll("span.lt").forEach((s) => { s.style.width = "auto"; });
      sw.appendChild(r);
    } else if (w.mode === "relative") {
      const cs = D.centerSourceOptions(d, def.src, def.over);
      sw.appendChild(field("Centered on", sel(cs.map((c) => ({ id: c, label: centerLabel(d, c) })), w.center, (val) => {
        S.def.window.center = val; pickResultAxes(true); render();
      }), "a coordinate or variable that shares the remaining dimensions (e.g. the stimulus frequency)"));
      const r = h("div", { class: "row" },
        field("× k", numInput(w.k, (x) => { S.def.window.k = x == null ? 1 : x; }, "1", "harmonic number: the window center is k × center + offset")),
        field("+ offset", numInput(w.offset, (x) => { S.def.window.offset = x == null ? 0 : x; }, "0", "shift of the window center (x units; SI suffixes ok)")));
      r.querySelectorAll("span.lt").forEach((s) => { s.style.width = "auto"; });
      sw.appendChild(r);
      sw.appendChild(field("± half width", numInput(w.halfwidth, (x) => { S.def.window.halfwidth = x; }, "e.g. 5k"),
        "the window is center ± this (x units)"));
    }
    if (w.mode !== "none") {
      sw.appendChild(field("Use points", sel(D.REGIONS, def.region, (val) => {
        if (val === "outside_within") {
          if (w.mode === "fixed" && (w.lo2 == null || w.hi2 == null)) {
            const span = (w.hi ?? 0) - (w.lo ?? 0);
            S.def.window.lo2 = (w.lo ?? 0) - 3 * Math.abs(span || 1); S.def.window.hi2 = (w.hi ?? 0) + 3 * Math.abs(span || 1);
          }
          if (w.mode === "relative" && w.halfwidth2 == null) S.def.window.halfwidth2 = Math.abs(w.halfwidth || 1) * 5;
        }
        set("region", val);
      }), "inside the window (e.g. the tone), outside it (e.g. the noise floor), or outside it but within a wider span"));
      if (def.region === "outside_within") {
        if (w.mode === "fixed") {
          const r = h("div", { class: "row" },
            field("outer from", numInput(w.lo2, (x) => { S.def.window.lo2 = x; }, "lo2")),
            field("to", numInput(w.hi2, (x) => { S.def.window.hi2 = x; }, "hi2")));
          r.querySelectorAll("span.lt").forEach((s) => { s.style.width = "auto"; });
          sw.appendChild(r);
        } else {
          sw.appendChild(field("outer ± half width", numInput(w.halfwidth2, (x) => { S.def.window.halfwidth2 = x; }, "e.g. 50k"),
            "points farther than this from the center are ignored"));
        }
      }
    }
    sw.appendChild(note("Tip: drag across the spectrum preview to set the window; drag the shaded band or its edges to adjust it."));
    form.appendChild(sw);

    // statistic
    const st = h("div", { class: "sec" }, h("div", { class: "sec-t", text: "Statistic" }));
    if (S.preset === "snr") {
      st.appendChild(note("<b>Peak</b> = max inside the window · <b>Floor</b> = statistic below, over the points chosen here · <b>SNR</b> = peak − floor.", ""));
      st.appendChild(field("Floor statistic", sel(D.STATS.filter((s) => ["mean", "median", "min", "max"].includes(s.id)), S.floorStat,
        (val) => { S.floorStat = val; schedule(); })));
      st.appendChild(field("Floor points", sel(D.REGIONS.filter((r) => r.id !== "inside"), S.floorRegion, (val) => {
        S.floorRegion = val;
        if (val === "outside_within") {
          if (w.mode === "fixed" && (w.lo2 == null || w.hi2 == null)) { const span = (w.hi ?? 0) - (w.lo ?? 0); S.def.window.lo2 = (w.lo ?? 0) - 3 * Math.abs(span || 1); S.def.window.hi2 = (w.hi ?? 0) + 3 * Math.abs(span || 1); }
          if (w.mode === "relative" && w.halfwidth2 == null) S.def.window.halfwidth2 = Math.abs(w.halfwidth || 1) * 5;
        }
        render();
      })));
      if (S.floorRegion === "outside_within" && w.mode !== "none") {
        if (w.mode === "fixed") {
          const r = h("div", { class: "row" },
            field("outer from", numInput(w.lo2, (x) => { S.def.window.lo2 = x; }, "lo2")),
            field("to", numInput(w.hi2, (x) => { S.def.window.hi2 = x; }, "hi2")));
          r.querySelectorAll("span.lt").forEach((s) => { s.style.width = "auto"; });
          st.appendChild(r);
        } else {
          st.appendChild(field("outer ± half width", numInput(w.halfwidth2, (x) => { S.def.window.halfwidth2 = x; }, "e.g. 50k")));
        }
      }
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

  function renderCombine(sec, d, def) {
    const vars = numericVars(0);
    if (!vars.length) { sec.appendChild(note("No numeric variables in this file.", "err")); return; }
    if (!vars.includes(def.a)) def.a = vars[0];
    const lab = (n) => ({ id: n, label: `${n}  (${d.vars[n].dims.join(", ") || "scalar"})` });
    sec.appendChild(field("a", sel(vars.map(lab), def.a, (val) => set("a", val))));
    sec.appendChild(field("Operation", sel(D.OPS, def.op, (val) => set("op", val))));
    const isNum = typeof def.b === "number";
    const kindSel = sel([{ id: "var", label: "a variable" }, { id: "num", label: "a number" }], isNum ? "num" : "var", (val) => {
      S.def.b = val === "num" ? 0 : (vars[1] || vars[0]); autoNames(); pickResultAxes(); render();
    });
    sec.appendChild(field("b is", kindSel));
    if (isNum) sec.appendChild(field("b", numInput(def.b, (x) => { S.def.b = x == null ? 0 : x; autoNames(); }, "0")));
    else {
      if (!vars.includes(def.b)) def.b = vars[1] || vars[0];
      sec.appendChild(field("b", sel(vars.map(lab), def.b, (val) => set("b", val))));
    }
    sec.appendChild(note("Dimensions are matched by name; the result has all of a's dimensions plus any extra ones of b. "
      + "Example: SNR = peak − floor; or normalize each spectrum: spectrum − (its peak)."));
  }

  function renderTransform(sec, d, def) {
    const vars = numericVars(0);
    if (!vars.length) { sec.appendChild(note("No numeric variables in this file.", "err")); return; }
    if (!vars.includes(def.src)) def.src = vars[0];
    sec.appendChild(field("Source", sel(vars.map((n) => ({ id: n, label: `${n}  (${d.vars[n].dims.join(", ") || "scalar"})` })), def.src, (val) => set("src", val))));
    sec.appendChild(field("Function", sel(D.TRANSFORMS, def.fn, (val) => set("fn", val))));
    if (def.fn === "scale") {
      const r = h("div", { class: "row" },
        field("a", numInput(def.scale, (x) => { S.def.scale = x == null ? 1 : x; }, "1")),
        field("b", numInput(def.offset, (x) => { S.def.offset = x == null ? 0 : x; }, "0")));
      r.querySelectorAll("span.lt").forEach((s) => { s.style.width = "auto"; });
      sec.appendChild(r);
    }
  }

  function centerLabel(d, c) {
    if (c.startsWith("coord:")) {
      const dim = c.slice(6);
      const cv = d.vars[dim];
      const u = cv ? X.unitsOf(cv) : "";
      let ex = "";
      if (cv && cv.data && cv.data.length) ex = ` = ${X.fmt6(Number(cv.data[0]))}${cv.data.length > 1 ? ", …" : ""}`;
      return `${dim} (coordinate${u ? ", " + u : ""})${ex}`;
    }
    const n = c.slice(4); const cv = d.vars[n];
    return `${n}${cv && X.unitsOf(cv) ? ` (${X.unitsOf(cv)})` : ""}`;
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
      if (q.kind === "combine" && out.length === 2 && q.a === defs[0].name && q.b === defs[1].name) {
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
      pvHead.append(h("span", { class: "bp-title", text: "Source" }),
        h("span", { class: "bp-stat", text: def.kind === "combine" ? "elementwise: " + D.describeDef(def) : D.describeDef(def) }));
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

  // window edits from the plot -> the def
  function setWindowFromRange(x0, x1, role) {
    const w = S.def.window;
    const lo = Math.min(x0, x1), hi = Math.max(x0, x1);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return;
    const p = S._p;
    if (w.mode === "none") {
      // a drag on a whole-span window creates a fixed one
      S.def.window.mode = "fixed"; S.def.window.lo = lo; S.def.window.hi = hi;
      if (S.preset !== "floor" && S.def.region === "inside") { /* keep */ }
    } else if (w.mode === "fixed") {
      if (role === "outer") { w.lo2 = lo; w.hi2 = hi; } else { w.lo = lo; w.hi = hi; }
    } else {
      const k = Number.isFinite(w.k) ? w.k : 1, off = Number.isFinite(w.offset) ? w.offset : 0;
      const center = p && Number.isFinite(p.center) ? p.center : (lo + hi) / 2;
      const c = k !== 0 ? (center - off) / k : 0;              // the raw center value
      if (role === "outer") {
        w.halfwidth2 = nice3(Math.max(Math.abs(lo - center), Math.abs(hi - center)));
      } else if (role === "center") {
        w.offset = nice3((lo + hi) / 2 - k * c);
      } else {
        // a drag roughly centered on the current center only sets the width;
        // an off-center one also shifts the window (offset)
        const mid = (lo + hi) / 2, hw = (hi - lo) / 2;
        w.halfwidth = nice3(hw);
        if (Math.abs(mid - center) > 0.25 * hw || role === "drag-move") w.offset = nice3(mid - k * c);
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
        <p>The <b>window</b> is in the units of the chosen <b>X values</b>. It can be <i>fixed</i> (from … to …) or
        <i>relative</i>: centered on a coordinate or variable that shares the remaining dimensions, times <i>k</i> (harmonics)
        plus an offset, ± a half width. <i>Use points</i> picks the points inside it, outside it (the noise floor), or
        outside it but within a wider span.</p>
        <p><b>dB data</b> (units containing “dB”) are averaged in <b>linear power</b>: mean, median, std, sum and integral
        convert 10^(x/10), compute, and convert back to dB (averaging in dB would bias Gaussian noise low by ≈2.5 dB).
        Max/min/argmax are unaffected. NaNs and empty windows are ignored (an empty window gives NaN).</p>
        <p><b>Combine</b> computes a ∘ b elementwise, matching dimensions by name (SNR = peak − floor). <b>Transform</b>
        converts dB ↔ linear or applies a·x + b.</p>
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
