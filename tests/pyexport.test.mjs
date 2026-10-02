// pyexport.test.mjs — tests for docs/js/pyexport.js, the "Download Python report
// script" feature. Builds realistic projects in the exact app format (via
// project.js buildProject), generates the .py report scripts, RUNS them against
// tests/data and checks:
//   - exit code 0, the PDF exists with the expected page count, no raster images
//   - --dump-lines matches X.traceLines (docs/js/explore.js) on the same data,
//     for every visible trace (derived ones too when docs/js/derive.js is present)
//   - --dump-derived matches an independent reference implementation written
//     here from the specs (incl. a small expression evaluator of its own), a
//     hand-written numpy computation (tests/py/expr_reference.py) for the
//     expression case, AND derive.js's registerDerived (rel 1e-9, NaN <-> NaN)
//     when derive.js already implements SPEC_EXPR (expression windows)
//   - the script's helpers (fmt6, colormaps, SI labels, legend labels, axis
//     limits, time units) match the JavaScript, and CONFIG round-trips every
//     string (quotes, backslashes, triple quotes, unicode)
//   - the script's expression engine (parser, evaluator, units, legacy-window
//     migration, JS-style number text) on hand-written expectations, and vs
//     docs/js/expr.js when it exists
//
// Run:  NCX_PYTHON=/path/to/python node tests/pyexport.test.mjs
// Python needs numpy, xarray, matplotlib, scipy, h5netcdf, pypdf. Without a
// usable Python (or without a data file) the affected checks are SKIPPED.
// NCX_KEEP=1 keeps the temp folder (scripts, PDFs, PNGs) for inspection.
// NCX_NO_DERIVE=1 skips the derive.js cross-check; NCX_CASES=A,I runs only those cases.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { REPO, DATA_DIR, PYTHON, loadDataset, dataFile, haveData, moduleUrl,
  check, skip, summary } from "./node_env.mjs";

const X = await import(moduleUrl("explore.js"));
const CM = await import(moduleUrl("colormaps.js"));
const P = await import(moduleUrl("pyexport.js"));
const { Variable } = await import(moduleUrl("dataset.js"));
// derive.js (the web app's engine) is a cross-check only once it implements
// the expression windows (SPEC_EXPR E4); before that the derived traces are
// compared on the script's own dumped values
let D = null, E = null;
if (!process.env.NCX_NO_DERIVE) {
  try {
    D = await import(moduleUrl("derive.js"));
    const modes = Array.isArray(D.WINDOW_MODES) ? D.WINDOW_MODES.map((m) => m.id) : [];
    if (typeof D.registerDerived !== "function" || !modes.includes("center") || typeof D.exprError !== "function") {
      console.log("derive.js does not implement expression windows yet - derive.js cross-check skipped");
      D = null;
    }
  } catch (e) { console.log("derive.js not usable: " + e.message); D = null; }
}
// defs as the app loads them from a project (sanitizeDef migrates legacy
// windows; a refused def is dropped, so it counts as "not computed")
const jsDefs = (defs) => (D && typeof D.sanitizeDef === "function" ? defs.map((d) => D.sanitizeDef(d)).filter(Boolean) : defs);
if (fs.existsSync(path.join(REPO, "docs", "js", "expr.js"))) {
  try {
    E = await import(moduleUrl("expr.js"));
    if (typeof E.parseExpr !== "function" || typeof E.evalExpr !== "function") E = null;
  } catch (e) { console.log("expr.js not usable: " + e.message); E = null; }
}
let appBuildProject = null;
try { appBuildProject = (await import(moduleUrl("project.js"))).buildProject; }
catch (e) { console.log("project.js not usable (" + e.message + ") - using a local project builder"); }

const PY_DIR = path.join(REPO, "tests", "py");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ncx-pyexport-"));
const KEEP = !!process.env.NCX_KEEP;
const u = (...cps) => String.fromCodePoint(...cps);

// ============================================================ helpers
function runPy(args, opts = {}) {
  const r = spawnSync(PYTHON, args, { encoding: "utf8", timeout: 300000, maxBuffer: 64 << 20, ...opts });
  return { status: r.status, out: (r.stdout || "") + (r.stderr || ""), error: r.error };
}

function pyAvailable() {
  const r = runPy(["-c", "import numpy, xarray, matplotlib, scipy, pypdf; print('ok')"]);
  return r.status === 0 && r.out.includes("ok");
}

const nz = (v) => (v === null || v === undefined || !Number.isFinite(v) ? null : v);
function close(a, b, rel) {
  a = nz(a); b = nz(b);
  if (a === null || b === null) return a === b;
  if (a === b) return true;
  return Math.abs(a - b) <= rel * Math.max(Math.abs(a), Math.abs(b)) + 1e-300;
}
function arrClose(a, b, rel) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!close(a[i], b[i], rel)) return false;
  return true;
}
function firstDiff(a, b, rel) {
  if (!a || !b) return "missing array";
  if (a.length !== b.length) return `length ${a.length} vs ${b.length}`;
  for (let i = 0; i < a.length; i++) if (!close(a[i], b[i], rel)) return `[${i}] ${a[i]} vs ${b[i]}`;
  return "";
}

// ------------------------------------------------------------ project builders
function tr(file, v, lineDim, xsrc, sweep, slices, extra = {}) {
  return { ...X.makeTrace(file, v, lineDim, xsrc, sweep, slices, extra.label, extra.ssrc), ...extra };
}
function tab(name, plot, traces, markers = []) {
  return { name, plotcfg: { ...X.DEFAULT_PLOTCFG, ...plot }, traces, markers, cur: traces.length ? 0 : -1 };
}
// the exact JSON a saved .ncproj holds
function project(tabs, derived = []) {
  const files = [...new Set(tabs.flatMap((t) => t.traces.map((x) => x.file)))];
  const state = { tabs, active: 0, fileOrder: files, wantedFiles: [], derived };
  const p = appBuildProject ? appBuildProject(state) : {
    format: X.PROJECT_FORMAT_V2, created: new Date().toISOString(), files, active: 0,
    tabs: tabs.map((t) => ({ name: t.name, plot: { ...t.plotcfg }, traces: t.traces, markers: t.markers,
      selected: t.cur })),
    plot: { ...tabs[0].plotcfg }, traces: tabs[0].traces, markers: tabs[0].markers, derived,
  };
  return JSON.parse(JSON.stringify(p));
}
// windows: the expression format (SPEC_EXPR E2) and the legacy one (projects
// saved before expressions; buildReportScript must migrate them)
const W0 = { mode: "none", lo: "", hi: "", lo2: "", hi2: "", center: "", halfwidth: "", halfwidth2: "" };
const W0_LEGACY = { mode: "none", lo: null, hi: null, lo2: null, hi2: null, center: "", k: 1, offset: 0,
  halfwidth: null, halfwidth2: null };
const R = (name, file, src, over, xsrc, win, region, stat, extra = {}) => ({ name, file, kind: "reduce",
  units: "", description: "", src, over, xsrc, window: { ...W0, ...win }, region, stat, db: "auto", ...extra });
const RL = (name, file, src, over, xsrc, win, region, stat, extra = {}) => ({ name, file, kind: "reduce",
  units: "", description: "", src, over, xsrc, window: { ...W0_LEGACY, ...win }, region, stat, db: "auto", ...extra });
const FM = (name, file, expr, extra = {}) => ({ name, file, kind: "formula", units: "", description: "", expr, ...extra });
const CB = (name, file, a, op, b, extra = {}) => ({ name, file, kind: "combine", units: "", description: "",
  a, op, b, ...extra });
const TF = (name, file, src, fn, extra = {}) => ({ name, file, kind: "transform", units: "", description: "",
  src, fn, scale: 1, offset: 0, ...extra });

// ------------------------------------------------------------ JS copy of app.js axisRange (not exported there)
function jsAxisRange(umin, umax, dmin, dmax, isLog) {
  const nmin = parseFloat(umin), nmax = parseFloat(umax);
  const hasMin = Number.isFinite(nmin), hasMax = Number.isFinite(nmax);
  if (!hasMin && !hasMax) return null;
  let lo = hasMin ? nmin : dmin;
  let hi = hasMax ? nmax : dmax;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  if (lo > hi) { const t = lo; lo = hi; hi = t; }
  if (lo === hi) { lo -= 0.5; hi += 0.5; }
  if (isLog) {
    if (hi <= 0) return null;
    if (lo <= 0) lo = (Number.isFinite(dmin) && dmin > 0) ? dmin : hi / 1000;
    return [Math.log10(lo), Math.log10(hi)];
  }
  return [lo, hi];
}

// ============================================================ independent derived reference
// A small expression evaluator of its own (SPEC_EXPR E1; shares no code with
// docs/js/expr.js or the Python script): text -> { names (first appearance),
// fn(v) } where v(name) returns a name's value at the current element.
// Throws on any syntax error.
const MICRO = [u(0xb5), u(0x3bc)];
const REF_SI = { p: 1e-12, n: 1e-9, u: 1e-6, m: 1e-3, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12,
  [MICRO[0]]: 1e-6, [MICRO[1]]: 1e-6 };
const cpow = (a, b) => (a === 1 || b === 0 || (a === -1 && Math.abs(b) === Infinity) ? 1 : Math.pow(a, b));
const REF_FN = {
  abs: [1, Math.abs], sqrt: [1, Math.sqrt], exp: [1, Math.exp], ln: [1, Math.log], log: [1, Math.log],
  log10: [1, Math.log10], floor: [1, Math.floor], ceil: [1, Math.ceil], round: [1, (x) => Math.floor(x + 0.5)],
  db2lin: [1, (x) => cpow(10, x / 10)], lin2db: [1, (x) => (x > 0 ? 10 * Math.log10(x) : NaN)],
  pow: [2, cpow], min: [-1, (...a) => Math.min(...a)], max: [-1, (...a) => Math.max(...a)],
};
function refExpr(text) {
  const toks = [];
  const re = new RegExp("[ \\t\\r\\n]+|\"([^\"]+)\"|((?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?)([pnumkKMGT"
    + MICRO.join("") + "]?)(?![A-Za-z0-9_." + MICRO.join("") + "])|([A-Za-z_][A-Za-z0-9_]*)|(\\*\\*|[-+*/^(),])", "y");
  while (re.lastIndex < text.length) {
    const at = re.lastIndex, m = re.exec(text);
    if (!m) throw new Error(`ref: cannot read '${text}' at ${at}`);
    if (m[1] !== undefined) toks.push({ k: "name", v: m[1], quoted: true });
    else if (m[2] !== undefined) toks.push({ k: "num", v: m[3] ? parseFloat(m[2]) * REF_SI[m[3]] : parseFloat(m[2]) });
    else if (m[4] !== undefined) toks.push({ k: "name", v: m[4] });
    else if (m[5] !== undefined) toks.push({ k: "op", v: m[5] === "**" ? "^" : m[5] });
  }
  if (!toks.length) throw new Error("ref: empty expression");
  let p = 0;
  const names = [];
  const isOp = (v) => p < toks.length && toks[p].k === "op" && toks[p].v === v;
  const need = (v) => { if (!isOp(v)) throw new Error(`ref: '${v}' expected in '${text}'`); p++; };
  const binary = (sub, ops) => {
    let a = sub();
    while (ops.some(isOp)) {
      const o = toks[p++].v, l = a, r = sub();
      a = o === "+" ? (v) => l(v) + r(v) : o === "-" ? (v) => l(v) - r(v) : o === "*" ? (v) => l(v) * r(v) : (v) => l(v) / r(v);
    }
    return a;
  };
  const expr = () => binary(term, ["+", "-"]);
  const term = () => binary(unary, ["*", "/"]);
  const unary = () => {
    if (isOp("-")) { p++; const a = unary(); return (v) => -a(v); }
    if (isOp("+")) { p++; return unary(); }
    return power();
  };
  const power = () => {
    const a = atom();
    if (!isOp("^")) return a;
    p++;
    const b = unary();
    return (v) => cpow(a(v), b(v));
  };
  const atom = () => {
    const t = toks[p++];
    if (!t) throw new Error(`ref: unexpected end of '${text}'`);
    if (t.k === "num") return () => t.v;
    if (t.k === "name" && !t.quoted && isOp("(")) {
      p++;
      const args = [];
      if (!isOp(")")) { args.push(expr()); while (isOp(",")) { p++; args.push(expr()); } }
      need(")");
      const f = REF_FN[t.v];
      if (!f || (f[0] > 0 ? args.length !== f[0] : args.length < 1)) throw new Error(`ref: bad call ${t.v}`);
      return (v) => f[1](...args.map((g) => g(v)));
    }
    if (t.k === "name") { if (!names.includes(t.v)) names.push(t.v); return (v) => v(t.v); }
    if (t.k === "op" && t.v === "(") { const e = expr(); need(")"); return e; }
    throw new Error(`ref: unexpected '${t.v}' in '${text}'`);
  };
  const fn = expr();
  if (p < toks.length) throw new Error(`ref: trailing text in '${text}'`);
  return { names, fn };
}
// names an expression text references (for the dependency order); [] if unreadable
const refNames = (text) => { try { return refExpr(text).names; } catch (e) { return []; } };

// Straight from the frozen specs (SPEC.md section 1 + SPEC_EXPR), with plain
// loops (no code shared with derive.js or the Python script). Windows in the
// legacy format ("fixed" / "relative") are computed with the OLD semantics, so
// a legacy def the script migrates must give the same numbers.
// Returns Map(name -> {dims, shape, data, units} | {err}); units null = not
// worked out here (formulas: the cases list their expected units instead).
function refDerived(ds, defs) {
  const out = new Map();
  const names = new Set(defs.map((d) => d.name));
  const scaleOf = (units) => X.asFloatArray([1], units)[0];
  const getVar = (n) => {
    if (names.has(n)) { const r = out.get(n); return r && !r.err ? r : null; }
    const v = Object.prototype.hasOwnProperty.call(ds.vars, n) ? ds.vars[n] : null;
    if (!v || v.derived || !v.isNumeric()) return null;
    return { dims: v.dims, shape: v.shape, data: v.data, units: X.unitsOf(v) };
  };
  const strides = (shape) => { const s = []; let a = 1; for (let i = shape.length - 1; i >= 0; i--) { s[i] = a; a *= shape[i]; } return s; };
  const flat = (v, idx) => { const st = strides(v.shape); let f = 0; v.dims.forEach((d, i) => { f += idx[d] * st[i]; }); return f; };
  const each = (dims, shape, fn) => {
    const n = shape.reduce((a, b) => a * b, 1), I = new Array(dims.length).fill(0);
    for (let f = 0; f < n; f++) {
      const idx = {}; dims.forEach((d, i) => { idx[d] = I[i]; });
      fn(idx, f);
      for (let a = dims.length - 1; a >= 0; a--) { if (++I[a] < shape[a]) break; I[a] = 0; }
    }
  };
  // what a name in an expression is: its dims + its value at a multi-index
  const refName = (n) => {
    const v = getVar(n);
    if (v) return { dims: v.dims, at: (idx) => Number(v.data[flat(v, idx)]) * scaleOf(v.units) };
    if (Object.prototype.hasOwnProperty.call(ds.dims, n)) return { dims: [n], at: (idx) => idx[n] };
    if (names.has(n)) throw new Error(`'${n}' could not be computed`);
    if (ds.vars[n]) throw new Error(`'${n}' is not numeric`);
    if (n === "pi") return { dims: [], at: () => Math.PI };
    throw new Error(`unknown name '${n}'`);
  };
  // a compiled expression over the result dims (each name's dims must be among them)
  const compile = (text, rdims) => {
    if (typeof text !== "string" || !text.trim()) throw new Error("empty expression");
    const { names: used, fn } = refExpr(text);
    const res = new Map(used.map((n) => [n, refName(n)]));
    for (const [n, r] of res) if (r.dims.some((x) => !rdims.includes(x))) throw new Error(`'${n}' has a dim the result lacks`);
    return { used, res, at: (idx) => fn((n) => res.get(n).at(idx)) };
  };
  const legacy = (w) => w.mode === "fixed" || w.mode === "relative";
  const deps = (d) => {
    const r = [];
    if (d.kind === "reduce") {
      r.push(d.src);
      if (d.xsrc.startsWith("var:")) r.push(d.xsrc.slice(4));
      if (legacy(d.window)) { if (d.window.center.startsWith("var:")) r.push(d.window.center.slice(4)); }
      else {
        const ow = d.region === "outside_within";
        const used = d.window.mode === "range" ? ["lo", "hi"].concat(ow ? ["lo2", "hi2"] : [])
          : d.window.mode === "center" ? ["center", "halfwidth"].concat(ow ? ["halfwidth2"] : []) : [];
        for (const k of used) r.push(...refNames(d.window[k]));
      }
    } else if (d.kind === "combine") { r.push(d.a); if (typeof d.b === "string") r.push(d.b); }
    else if (d.kind === "formula") r.push(...refNames(d.expr));
    else r.push(d.src);
    return r.filter((n) => names.has(n) && n !== d.name);
  };
  const stat = (xs, ys, lo, hi, lo2, hi2, region, st, db) => {
    const use = xs.map((x, k) => {
      if (Number.isNaN(x)) return false;
      const inn = lo <= x && x <= hi;
      const mem = region === "inside" ? inn : region === "outside" ? !inn : (!inn && lo2 <= x && x <= hi2);
      return mem && Number.isFinite(ys[k]);
    });
    const ks = []; use.forEach((ok, k) => { if (ok) ks.push(k); });
    if (st === "count") return ks.length;
    if (!ks.length) return NaN;
    if (st === "max" || st === "argmax_x") { let b = ks[0]; for (const k of ks) if (ys[k] > ys[b]) b = k; return st === "max" ? ys[b] : xs[b]; }
    if (st === "min" || st === "argmin_x") { let b = ks[0]; for (const k of ks) if (ys[k] < ys[b]) b = k; return st === "min" ? ys[b] : xs[b]; }
    const v = ys.map((y) => (db ? Math.pow(10, y / 10) : y));
    let r;
    if (st === "mean") r = ks.reduce((a, k) => a + v[k], 0) / ks.length;
    else if (st === "sum") r = ks.reduce((a, k) => a + v[k], 0);
    else if (st === "median") {
      const s = ks.map((k) => v[k]).sort((a, b) => a - b), m = s.length >> 1;
      r = s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    } else if (st === "std") {
      const mu = ks.reduce((a, k) => a + v[k], 0) / ks.length;
      r = Math.sqrt(ks.reduce((a, k) => a + (v[k] - mu) ** 2, 0) / ks.length);
    } else if (st === "integral") {
      let any = false; r = 0;
      for (let k = 0; k + 1 < xs.length; k++) if (use[k] && use[k + 1]) { any = true; r += 0.5 * (v[k] + v[k + 1]) * Math.abs(xs[k + 1] - xs[k]); }
      if (!any) return NaN;
    } else throw new Error("unknown stat " + st);
    if (db) r = r > 0 ? 10 * Math.log10(r) : NaN;
    return r;
  };
  const compute = (d) => {
    if (d.kind === "reduce") {
      const src = getVar(d.src);
      if (!src || !src.dims.length || !src.dims.includes(d.over)) throw new Error("bad src/over");
      const STATS = ["max", "min", "mean", "median", "std", "sum", "integral", "count", "argmax_x", "argmin_x"];
      if (!STATS.includes(d.stat)) throw new Error("bad stat");
      const w = d.window, n = ds.size(d.over), ow = d.region === "outside_within";
      if (w.mode === "none" && d.region !== "inside") throw new Error("region needs window");
      const rdims = src.dims.filter((x) => x !== d.over), rshape = rdims.map((x) => ds.size(x));
      let xv = null, coord = null;
      if (d.xsrc.startsWith("var:")) {
        xv = getVar(d.xsrc.slice(4));
        if (!xv || !xv.dims.includes(d.over) || xv.dims.some((x) => !src.dims.includes(x))) throw new Error("bad xsrc");
      } else if (d.xsrc === "coord") {
        const cv = ds.vars[d.over];
        if (cv && cv.isNumeric()) coord = cv;
      }
      // window -> bounds(idx) = [lo, hi, lo2, hi2] or null (undefined: no members)
      let bounds;
      if (w.mode === "none") bounds = () => [-Infinity, Infinity, -Infinity, Infinity];
      else if (w.mode === "fixed") {          // legacy, old semantics
        if (w.lo === null || w.hi === null) throw new Error("fixed needs lo/hi");
        let lo2 = -Infinity, hi2 = Infinity;
        if (w.lo2 !== null && w.hi2 !== null) { lo2 = Math.min(w.lo2, w.hi2); hi2 = Math.max(w.lo2, w.hi2); }
        const b = [Math.min(w.lo, w.hi), Math.max(w.lo, w.hi), lo2, hi2];
        bounds = () => b;
      } else if (w.mode === "relative") {     // legacy, old semantics: k*c + offset +- |hw|
        if (w.halfwidth === null) throw new Error("relative needs halfwidth");
        let cAt;
        if (w.center.startsWith("coord:")) {
          const cdim = w.center.slice(6);
          if (!rdims.includes(cdim)) throw new Error("bad center dim");
          const cv = ds.vars[cdim];
          cAt = cv && cv.isNumeric() ? (idx) => Number(cv.data[idx[cdim]]) * scaleOf(X.unitsOf(cv)) : (idx) => idx[cdim];
        } else if (w.center.startsWith("var:")) {
          const cvar = getVar(w.center.slice(4));
          if (!cvar || cvar.dims.some((x) => !rdims.includes(x))) throw new Error("bad center var");
          cAt = (idx) => cvar.data[flat(cvar, idx)] * scaleOf(cvar.units);
        } else throw new Error("no center");
        bounds = (idx) => {
          const m = w.k * cAt(idx) + w.offset;
          if (!Number.isFinite(m)) return null;
          const h2 = w.halfwidth2 === null ? Infinity : Math.abs(w.halfwidth2);
          return [m - Math.abs(w.halfwidth), m + Math.abs(w.halfwidth), m - h2, m + h2];
        };
      } else if (w.mode === "range") {
        const lo = compile(w.lo, rdims), hi = compile(w.hi, rdims);
        const lo2 = ow ? compile(w.lo2, rdims) : null, hi2 = ow ? compile(w.hi2, rdims) : null;
        bounds = (idx) => {
          const a = lo.at(idx), b = hi.at(idx);
          const r = [Math.min(a, b), Math.max(a, b), -Infinity, Infinity];
          if (ow) { const a2 = lo2.at(idx), b2 = hi2.at(idx); r[2] = Math.min(a2, b2); r[3] = Math.max(a2, b2); }
          return r;
        };
      } else if (w.mode === "center") {
        const c = compile(w.center, rdims), h = compile(w.halfwidth, rdims), h2 = ow ? compile(w.halfwidth2, rdims) : null;
        bounds = (idx) => {
          const m = c.at(idx), hw = Math.abs(h.at(idx));
          const r = [m - hw, m + hw, -Infinity, Infinity];
          if (ow) { const hw2 = Math.abs(h2.at(idx)); r[2] = m - hw2; r[3] = m + hw2; }
          return r;
        };
      } else throw new Error("bad window mode");
      const db = d.db === "yes" || (d.db === "auto" && src.units.toLowerCase().includes("db"));
      const data = new Float64Array(rshape.reduce((a, b) => a * b, 1));
      each(rdims, rshape, (idx, f) => {
        const b = bounds(idx);
        // an undefined window (a needed bound not finite) has NO members
        const defined = w.mode === "none" || (b && Number.isFinite(b[0]) && Number.isFinite(b[1])
          && (!ow || (Number.isFinite(b[2]) && Number.isFinite(b[3]))));
        if (!defined) {
          data[f] = d.stat === "count" ? 0 : NaN;
          return;
        }
        const xs = [], ys = [];
        for (let k = 0; k < n; k++) {
          const j = { ...idx, [d.over]: k };
          ys.push(src.data[flat(src, j)]);
          if (xv) xs.push(xv.data[flat(xv, j)] * scaleOf(xv.units));
          else if (coord) xs.push(Number(coord.data[k]) * scaleOf(X.unitsOf(coord)));
          else xs.push(k);
        }
        data[f] = stat(xs, ys, b[0], b[1], b[2], b[3], d.region, d.stat, db);
      });
      return { dims: rdims, shape: rshape, data };
    }
    if (d.kind === "formula") {
      const { names: used } = refExpr(d.expr);
      const dims = [];
      for (const nm of used) for (const x of refName(nm).dims) if (!dims.includes(x)) dims.push(x);
      const c = compile(d.expr, dims), shape = dims.map((x) => ds.size(x));
      const data = new Float64Array(shape.reduce((p, q) => p * q, 1));
      each(dims, shape, (idx, f) => { data[f] = c.at(idx); });
      return { dims, shape, data };
    }
    if (d.kind === "combine") {
      const a = getVar(d.a);
      if (!a) throw new Error("bad a");
      const bnum = typeof d.b === "number";
      const b = bnum ? null : getVar(d.b);
      if (!bnum && !b) throw new Error("bad b");
      const dims = bnum ? a.dims.slice() : a.dims.concat(b.dims.filter((x) => !a.dims.includes(x)));
      const shape = dims.map((x) => ds.size(x));
      const data = new Float64Array(shape.reduce((p, q) => p * q, 1));
      each(dims, shape, (idx, f) => {
        const av = a.data[flat(a, idx)], bv = bnum ? d.b : b.data[flat(b, idx)];
        let r;
        if (Number.isNaN(av) || Number.isNaN(bv)) r = NaN;
        else if (d.op === "-") r = av - bv; else if (d.op === "+") r = av + bv;
        else if (d.op === "*") r = av * bv; else if (d.op === "/") r = av / bv;
        else if (d.op === "max") r = Math.max(av, bv); else if (d.op === "min") r = Math.min(av, bv);
        else throw new Error("bad op");
        data[f] = r;
      });
      return { dims, shape, data };
    }
    const s = getVar(d.src);
    if (!s) throw new Error("bad src");
    const data = Float64Array.from(s.data, (x) => {
      if (d.fn === "db2lin") return Math.pow(10, x / 10);
      if (d.fn === "lin2db") return x > 0 ? 10 * Math.log10(x) : NaN;
      if (d.fn === "scale") return x * d.scale + d.offset;
      if (d.fn === "abs") return Math.abs(x);
      throw new Error("bad fn");
    });
    return { dims: s.dims.slice(), shape: s.shape.slice(), data };
  };
  // AUTO units, SPEC.md section 1.5 (null in -> null out: not worked out here)
  const DOT = u(0xb7), norm = (s) => String(s).trim().toLowerCase(), isDb = (s) => norm(s).includes("db");
  const unitsOf = (n) => { const v = typeof n === "string" ? getVar(n) : null; return v ? v.units : ""; };
  const autoUnits = (d) => {
    if (d.kind === "formula") return null;
    if (d.kind === "reduce") {
      const su = unitsOf(d.src);
      const xu = d.xsrc === "coord" ? (ds.vars[d.over] ? X.unitsOf(ds.vars[d.over]) : "")
        : d.xsrc.startsWith("var:") ? unitsOf(d.xsrc.slice(4)) : "";
      if (d.stat === "count") return "";
      if (su === null || xu === null) return null;
      if (["max", "min", "mean", "median", "std", "sum"].includes(d.stat)) return su;
      if (d.stat === "integral") return su && xu ? su + DOT + xu : (su || xu);
      return xu;
    }
    if (d.kind === "combine") {
      const bVar = typeof d.b === "string", ua = unitsOf(d.a), ub = bVar ? unitsOf(d.b) : "";
      if (ua === null || ub === null) return null;
      if (d.op === "-") return bVar && isDb(ua) && isDb(ub) && norm(ua) === norm(ub) ? "dB" : ua;
      if (d.op === "*") return ua && ub ? ua + DOT + ub : (ua || ub);
      if (d.op === "/") return ua && norm(ua) === norm(ub) ? "" : (ua && ub ? ua + "/" + ub : (ua || (ub ? "1/" + ub : "")));
      return ua;
    }
    const su = unitsOf(d.src);
    if (su === null) return null;
    const n = norm(su);
    if (d.fn === "db2lin") return n === "dbm" ? "mW" : n === "dbw" ? "W" : n === "db" ? "" : (su ? `lin(${su})` : "");
    if (d.fn === "lin2db") return n === "mw" ? "dBm" : n === "w" ? "dBW" : "dB";
    return su;
  };
  const pending = defs.slice();
  let progress = true;
  while (pending.length && progress) {
    progress = false;
    for (let i = 0; i < pending.length; i++) {
      const d = pending[i];
      if (deps(d).some((n) => !out.has(n))) continue;
      try {
        const r = compute(d);
        for (let k = 0; k < r.data.length; k++) if (!Number.isFinite(r.data[k])) r.data[k] = NaN;
        r.units = String(d.units).trim() || autoUnits(d);
        out.set(d.name, r);
      } catch (e) { out.set(d.name, { err: e.message }); }
      pending.splice(i, 1); i--; progress = true;
    }
  }
  for (const d of pending) out.set(d.name, { err: "cycle" });
  return out;
}

// ============================================================ 1. pure JS checks
function jsChecks() {
  check("reportFileName stamp", P.reportFileName("20261002_101500") === "ncx_report_20261002_101500.py");
  check("reportFileName sanitizes", P.reportFileName("2026/10:02 x") === "ncx_report_20261002x.py");
  check("reportFileName empty", P.reportFileName("") === "ncx_report.py");

  // pyStr / pyLiteral
  check("pyStr quotes+backslash", P.pyStr('a"b\\c\n') === '"a\\"b\\\\c\\n"', P.pyStr('a"b\\c\n'));
  check("pyStr line separator escaped", P.pyStr("x" + u(0x2028) + "y") === '"x\\u2028y"', P.pyStr("x" + u(0x2028) + "y"));
  check("pyStr bidi escaped", P.pyStr(u(0x202e)) === '"\\u202e"');
  check("pyStr lone surrogate replaced", P.pyStr("a" + String.fromCharCode(0xd800) + "b") === '"a' + u(0xfffd) + 'b"');
  check("pyStr keeps printable unicode", P.pyStr(u(0x394) + "f " + u(0xb5) + "s") === '"' + u(0x394) + "f " + u(0xb5) + 's"');
  const lit = P.pyLiteral({ a: NaN, b: Infinity, c: -Infinity, d: -0, e: null, f: true, g: false, h: [1, 2.5, "x"], i: 1e21, j: 1e-7 });
  check("pyLiteral specials", lit.includes('"a": float("nan")') && lit.includes('"c": -float("inf")')
    && lit.includes('"d": -0.0') && lit.includes('"e": None') && lit.includes('"f": True') && lit.includes('"g": False')
    && lit.includes('"i": 1e+21') && lit.includes('"j": 1e-7'), lit);
  const long = P.pyLiteral({ list: Array.from({ length: 40 }, (_, i) => "item" + i) });
  check("pyLiteral breaks long containers", long.split("\n").length > 10 && long.split("\n").every((l) => l.length <= 100));

  // neededDerived: transitive through src / a / b / xsrc var / center var; ssrc var; per file; per tab
  const defs = [
    RL("pk", "Darpa.NC", "spectrums", "TraceIndex", "var:fx", { mode: "relative", center: "var:ctr", halfwidth: 1 }, "inside", "max"),
    R("ctr", "darpa.nc", "spectrums", "TraceIndex", "index", {}, "inside", "argmax_x"),
    TF("fx", "darpa.nc", "frequencies", "scale"),
    CB("snr", "darpa.nc", "pk", "-", "fl"),
    R("fl", "darpa.nc", "spectrums", "TraceIndex", "index", {}, "inside", "mean"),
    TF("unused", "darpa.nc", "spectrums", "abs"),
    TF("pk", "other.nc", "x", "abs"),
    R("sv", "darpa.nc", "laswrPowers", "stimulusAmp", "index", {}, "inside", "max"),
    TF("t2only", "darpa.nc", "spectrums", "abs"),
  ];
  const ptabs = [
    { name: "a", plot: {}, traces: [{ file: "C:\\data\\darpa.nc", var: "snr", ssrc: "var:sv" }], markers: [] },
    { name: "b", plot: {}, traces: [{ file: "darpa.nc", var: "t2only" }], markers: [] },
  ];
  const need = (sel) => P.neededDerived({ tabs: ptabs, derived: defs }, sel).map((d) => d.file + "/" + d.name).sort().join(",");
  check("neededDerived transitive (tab 0)", need([0]) === "Darpa.NC/pk,darpa.nc/ctr,darpa.nc/fl,darpa.nc/fx,darpa.nc/snr,darpa.nc/sv", need([0]));
  check("neededDerived tab 1 only", need([1]) === "darpa.nc/t2only", need([1]));
  check("neededDerived default = all tabs", need(undefined).split(",").length === 7, need(undefined));
  const nd = P.neededDerived({ tabs: ptabs, derived: defs }, [0]);
  check("neededDerived canonical key order", JSON.stringify(Object.keys(nd.find((d) => d.name === "pk")))
    === JSON.stringify(["name", "file", "kind", "units", "description", "src", "over", "xsrc", "window", "region", "stat", "db"]));
  const WKEYS = ["mode", "lo", "hi", "lo2", "hi2", "center", "halfwidth", "halfwidth2"];
  const pkw = nd.find((d) => d.name === "pk").window;
  check("neededDerived migrates a legacy window", JSON.stringify(pkw)
    === JSON.stringify({ mode: "center", lo: "", hi: "", lo2: "", hi2: "", center: "ctr", halfwidth: "1", halfwidth2: "" }), pkw);

  // dependencies through EXPRESSIONS: the window fields in use + formula expr;
  // numbers with an SI suffix, function names and unused fields are not references
  const xdefs = [
    R("w1", "e.nc", "s", "x", "index", { mode: "center", center: '"c f.1" + k', halfwidth: "3*hw(1)" }, "inside", "max"),
    R("w2", "e.nc", "s", "x", "index", { mode: "range", lo: "5m + 2e3k", hi: "max(lo_def, 1)", lo2: "stale_ref", center: "m" }, "inside", "max"),
    R("w3", "e.nc", "s", "x", "index", { mode: "center", center: "k", halfwidth: "1", halfwidth2: "ow_def", lo: "m" }, "outside_within", "max"),
    FM("f1", "e.nc", "w1 - w2 + log10(  w1) + pi + w3"),
    FM("c f.1", "e.nc", "2 * \"deep\""), FM("deep", "e.nc", "1"),
    TF("k", "e.nc", "s", "abs"), TF("m", "e.nc", "s", "abs"), TF("hw", "e.nc", "s", "abs"),
    TF("lo_def", "e.nc", "s", "abs"), TF("stale_ref", "e.nc", "s", "abs"), TF("log10", "e.nc", "s", "abs"),
    TF("ow_def", "e.nc", "s", "abs"),
    FM("unused", "e.nc", "k"),
  ];
  const xneed = P.neededDerived({ tabs: [{ name: "x", plot: {}, traces: [{ file: "e.nc", var: "f1" }], markers: [] }],
    derived: xdefs }, [0]).map((d) => d.name).sort().join(",");
  check("neededDerived follows expression names", xneed === "c f.1,deep,f1,k,lo_def,ow_def,w1,w2,w3", xneed);
  check("exprRefs", JSON.stringify(P.exprRefs('3*RBW + "pk f" - max(a, 5m) + 2e3k*b2 - log10 ( c) + "pk f" + .5u'))
    === JSON.stringify(["RBW", "pk f", "a", "b2", "c"]), P.exprRefs('3*RBW + "pk f" - max(a, 5m) + 2e3k*b2 - log10 ( c) + "pk f"'));
  const fdef = P.neededDerived({ tabs: [{ name: "x", plot: {}, traces: [{ file: "e.nc", var: "f1" }], markers: [] }],
    derived: [{ ...FM("f1", "e.nc", "x".repeat(1500)), extra: 1 }] }, [0])[0];
  check("formula canonical keys + expr capped at 1000", JSON.stringify(Object.keys(fdef))
    === JSON.stringify(["name", "file", "kind", "units", "description", "expr"]) && fdef.expr.length === 1000);

  // legacy windows (SPEC_EXPR E3) and new-format clean-up
  const MW = [
    [{ mode: "relative", center: "coord:stimulusFrequency", k: 1, offset: 0, halfwidth: 1e6, halfwidth2: null },
      { mode: "center", center: "stimulusFrequency", halfwidth: "1000000" }],
    [{ mode: "relative", center: "var:peak f", k: 0.5, offset: -5e6, halfwidth: -0.02, halfwidth2: -1e-7 },
      { mode: "center", center: '0.5*"peak f" - 5000000', halfwidth: "0.02", halfwidth2: "1e-7" }],
    [{ mode: "relative", center: "var:max", k: -2, offset: 1e21, halfwidth: 3 },
      { mode: "center", center: '-2*"max" + 1e+21', halfwidth: "3" }],
    [{ mode: "relative", center: "var:pi", offset: 2.5, halfwidth: null }, { mode: "center", center: '"pi" + 2.5' }],
    [{ mode: "relative", center: "", k: 3, halfwidth: 1 }, { mode: "center", halfwidth: "1" }],
    [{ mode: "fixed", lo: 31e6, hi: 29e6, lo2: null, hi2: 4e7, center: "", k: 1, offset: 0, halfwidth: null, halfwidth2: null },
      { mode: "range", lo: "31000000", hi: "29000000", hi2: "40000000" }],
    [{ mode: "none", lo: 1, hi: 2, center: "coord:x", k: 1, offset: 0, halfwidth: 5 }, { mode: "none" }],
    // a "range" / "center" window is never legacy (derive.js's rule): "var:f_c"
    // stays as typed (an error in the app and in the script alike), unused
    // fields are kept, numbers become their text, strings are capped at 320
    [{ mode: "center", center: "var:f_c", halfwidth: "0.01*f_c" }, { mode: "center", center: "var:f_c", halfwidth: "0.01*f_c" }],
    [{ mode: "range", lo: 5, hi: "x*2", lo2: true, hi2: null, center: "ignored", junk: 1 },
      { mode: "range", lo: "5", hi: "x*2", center: "ignored" }],
    [{ mode: "center", center: "a".repeat(400), halfwidth: 7 }, { mode: "center", center: "a".repeat(320), halfwidth: "7" }],
    // a mode-none window with typed expressions is not taken for a legacy one
    [{ mode: "none", center: "var:f", halfwidth: "0.01*f" }, { mode: "none", center: "var:f", halfwidth: "0.01*f" }],
    [{ center: "coord:t" }, { mode: "none" }],
    // legacy: only numbers count; a plain-text center is dropped; long names
    // are not cut (311 characters at most)
    [{ mode: "relative", center: "var:c", halfwidth: "20", halfwidth2: 5 }, { mode: "center", center: "c", halfwidth2: "5" }],
    [{ mode: "relative", center: "c", halfwidth: 1 }, { mode: "center", halfwidth: "1" }],
    [{ mode: "fixed", lo: "10", hi: 20 }, { mode: "range", hi: "20" }],
    [{ mode: "relative", center: "var:L" + "x".repeat(255), k: -1.2345678901234567e-7, offset: 1.2345678901234567e-7, halfwidth: 1 },
      { mode: "center", center: "-1.2345678901234566e-7*L" + "x".repeat(255) + " + 1.2345678901234566e-7", halfwidth: "1" }],
    [{ mode: "relative", center: 'var:a"b', halfwidth: 1 }, { mode: "center", center: '"a"b"', halfwidth: "1" }],
    [{ mode: "center", center: "f + 1", halfwidth: "2", lo: "kept" }, { mode: "center", lo: "kept", center: "f + 1", halfwidth: "2" }],
    [{ mode: "bogus", lo: 1 }, { mode: "bogus" }],
    [null, { mode: "none" }],
    [{}, { mode: "none" }],
  ];
  const mbad = MW.map(([w, want]) => [w, P.migrateWindow(w), { ...W0, ...want }])
    .filter(([, got, want]) => JSON.stringify(got) !== JSON.stringify(want) || JSON.stringify(Object.keys(got)) !== JSON.stringify(WKEYS));
  check("migrateWindow (legacy -> expressions, key order)", mbad.length === 0, mbad);
  MIGRATE_INPUTS.push(...MW.map(([w]) => w));

  // buildReportScript basics
  const proj = { format: "nc_explorer_project_v2", tabs: ptabs, derived: defs };
  const s = P.buildReportScript(proj, { generatedAt: "2026-10-02T00:00:00.000Z", source: 'proj "x" \\ """' });
  check("script: shebang", s.startsWith("#!/usr/bin/env python3"));
  check("script: no placeholder left", !/__NCX_[A-Z]+__/.test(s));
  check("script: FILES + CONFIG + main", s.includes("\nFILES = {") && s.includes("\nCONFIG = {") && s.includes("def main("));
  check("script: helpers before CONFIG before main", s.indexOf("def reduce_samples") < s.indexOf("\nCONFIG = {")
    && s.indexOf("\nCONFIG = {") < s.indexOf("def main("));
  check("script: FILES keyed by basename", s.includes('"darpa.nc": "darpa.nc"') && !s.includes("C:\\\\data"));
  check("script: docstring-safe source", s.includes('Project   : proj \\"x\\" \\\\ \\"\\"\\"'));
  let threw = false; try { P.buildReportScript(proj, { tabs: [] }); } catch (e) { threw = true; }
  check("script: empty selection throws", threw);
  threw = false; try { P.buildReportScript(proj, { tabs: [7, -1, "x"] }); } catch (e) { threw = true; }
  check("script: invalid selection throws", threw);
  const v1 = P.buildReportScript({ format: "nc_explorer_project_v1", plot: { cmap: "viridis" },
    traces: [{ file: "/x/y/a.nc", var: "v", line_dim: "d", slices: {}, xsrc: "coord" }] });
  check("script: v1 project -> one tab", v1.includes('"name": "Plot 1"') && v1.includes('"a.nc": "a.nc"') && v1.includes('"cmap": "Viridis"'));
}

// ============================================================ 2. cases that RUN the script
const MISSING = "nonexistent_run42.nc";
const NASTY = "Uni" + u(0xdc) + "c" + u(0xf6) + 'de "dq" \'sq\' \\back\\slash """tri""" ${x} `bt` $5 & $10 '
  + u(0x2014) + " " + u(0x394) + "f " + u(0xb5) + "s " + u(0x65e5, 0x672c) + u(0x2028) + "ls";

function buildCases() {
  const cases = [];

  // --- A. darpa: the motivating derived chain (+ every statistic)
  {
    const F = "darpa.nc";
    const rel = { mode: "center", center: "stimulusFrequency", halfwidth: "1e6" };
    const derived = [
      R("peak", F, "spectrums", "TraceIndex", "var:frequencies", rel, "inside", "max"),
      // "floor" is an expression function now: the app no longer lets you NAME
      // a new quantity so, but an old project's "floor" must still compute
      R("floor", F, "spectrums", "TraceIndex", "var:frequencies", rel, "outside", "mean"),
      CB("SNR", F, "peak", "-", "floor"),
      R("peak_f", F, "spectrums", "TraceIndex", "var:frequencies", rel, "inside", "argmax_x"),
      R("around_peak", F, "spectrums", "TraceIndex", "var:frequencies", { mode: "center", center: "peak_f", halfwidth: "2e5" }, "inside", "mean"),
      R("floor_med", F, "spectrums", "TraceIndex", "var:frequencies", { ...rel, halfwidth2: "5e6" }, "outside_within", "median"),
      R("floor_std_lin", F, "spectrums", "TraceIndex", "var:frequencies", rel, "outside", "std", { db: "no" }),
      R("floor_std_db", F, "spectrums", "TraceIndex", "var:frequencies", rel, "outside", "std"),
      RL("band_int", F, "spectrums", "TraceIndex", "var:frequencies", { mode: "fixed", lo: 31e6, hi: 29e6 }, "inside", "integral"),   // legacy
      R("band_cnt", F, "spectrums", "TraceIndex", "var:frequencies", { mode: "range", lo: "29M", hi: "31M", lo2: "20e6", hi2: "40e6" }, "outside_within", "count"),
      RL("harm", F, "spectrums", "TraceIndex", "var:frequencies", { mode: "relative", center: "coord:stimulusFrequency", k: 0.5, offset: 5e6, halfwidth: 1e6 }, "inside", "max"),   // legacy
      R("argmin_out", F, "spectrums", "TraceIndex", "coord", { mode: "range", lo: "400", hi: "100" }, "outside", "argmin_x"),
      R("tot_sum", F, "spectrums", "TraceIndex", "index", {}, "inside", "sum", { db: "yes" }),
      R("min_all", F, "spectrums", "TraceIndex", "index", {}, "inside", "min"),
      R("peak_db_mean", F, "peak", "trace", "index", {}, "inside", "mean"),
      TF("peak_mW", F, "peak", "db2lin"),
      TF("back_dBm", F, "peak_mW", "lin2db"),
      TF("peak_x2", F, "peak", "scale", { scale: 2, offset: 3 }),
      TF("abs_snr", F, "SNR", "abs", { units: " custom u " }),
      CB("ratio", F, "peak_mW", "/", "peak_mW"),
      CB("clip", F, "peak", "max", -30),
      CB("norm_spec", F, "spectrums", "-", "peak"),
      CB("cyc_a", F, "cyc_b", "+", 1),
      CB("cyc_b", F, "cyc_a", "+", 1),
      CB("dep_cyc", F, "cyc_a", "*", 2),
      R("bad_stat", F, "spectrums", "TraceIndex", "index", {}, "inside", "bogus"),
      R("bad_fixed", F, "spectrums", "TraceIndex", "index", { mode: "range", lo: "1" }, "inside", "max"),   // hi empty
      TF("not_needed", F, "spectrums", "abs"),
      TF("case_mix", "C:\\lab\\DARPA.NC", "peak", "abs"),     // same file, other spelling + a path
    ];
    const vs = (v, extra = {}) => tr(F, v, "stimulusFrequency", "coord", "stimulusAmp", { trace: 0 }, extra);
    const tabs = [
      tab("Peak & floor vs stimulus", { title: "Tone peak and noise floor", legend_loc: "lower left" }, [
        vs("peak", { draw: "lines+markers" }), vs("floor", { draw: "lines+markers", dash: "dash" }),
      ], [{ trace: 0, line: 1, idx: 0 }, { trace: 1, line: 0, idx: 1 }]),
      tab("SNR", { ylabel2: "", yunit2: "" }, [
        vs("SNR", { draw: "lines+markers", lw: 2 }), vs("peak_f", { yaxis: "right" }),
      ]),
      tab("All statistics", { legend: false }, [
        "around_peak", "floor_med", "floor_std_lin", "floor_std_db", "band_int", "band_cnt", "harm", "argmin_out",
        "tot_sum", "min_all", "peak_mW", "back_dBm", "peak_x2", "abs_snr", "ratio", "clip", "case_mix",
      ].map((v) => vs(v)).concat([
        tr(F, "peak_db_mean", "stimulusFrequency", "coord", "stimulusAmp", {}),
        vs("dep_cyc", { visible: false }), vs("bad_stat", { visible: false }), vs("bad_fixed", { visible: false }),
      ])),
      tab("Raw spectra", { xunit: "M", ylabel: "Power (dBm)" }, [
        tr(F, "spectrums", "TraceIndex", "var:frequencies", "trace", { stimulusFrequency: 1, stimulusAmp: 1 }),
        tr(F, "norm_spec", "TraceIndex", "var:frequencies", "trace", { stimulusFrequency: 1, stimulusAmp: 1 }, { yaxis: "right" }),
        tr(F, "spectrums", "stimulusFrequency", "coord", "TraceIndex", { stimulusAmp: 1, trace: 2 }, { visible: false }),
      ], [{ trace: 0, line: 2, idx: 300 }, { trace: 1, line: 0, idx: 300 }]),
      tab("Over 200 lines (TraceIndex sweep)", { mode: "Rainbow", cmap: "Jet" }, [
        tr(F, "spectrums", "stimulusFrequency", "coord", "TraceIndex", { stimulusAmp: 1, trace: 2 }, { ssrc: "var:frequencies" }),
      ]),
    ];
    cases.push({ id: "A_darpa_derived", files: [F], project: project(tabs, derived), opts: {},
      pages: 5, derivedErrors: ["cyc_a", "cyc_b", "dep_cyc", "bad_stat", "bad_fixed"], notDumped: ["not_needed"],
      expectOut: [/circular definition/, /unknown statistic/, /showing 200 evenly spaced/, /window hi is empty/],
      units: { peak: "DBM", floor: "DBM", SNR: "dB", peak_mW: "mW", back_dBm: "dBm", ratio: "", abs_snr: "custom u", band_cnt: "" },
      // legacy windows are migrated by buildReportScript (SPEC_EXPR E3)
      configWindows: { harm: { mode: "center", center: "0.5*stimulusFrequency + 5000000", halfwidth: "1000000" },
        band_int: { mode: "range", lo: "31000000", hi: "29000000" }, peak: { mode: "center", center: "stimulusFrequency", halfwidth: "1e6" } },
      png: true });
  }

  // --- B. sidebands: Rainbow + colorbar + ssrc var + SI prefixes + limits + markers + sweep_label
  {
    const F = "sidebands.nc";
    const derived = [
      R("pump_pk", F, "spectra_dbm", "wl", "var:wl_nm", { mode: "center", center: "pump_nm", halfwidth: "0.05" }, "inside", "max"),
      R("sb_floor", F, "spectra_dbm", "wl", "var:wl_nm", { mode: "center", center: "pump_nm", halfwidth: "0.3", halfwidth2: "0.9" }, "outside_within", "median"),
      R("pump_int", F, "spectra_dbm", "wl", "var:wl_nm", { mode: "center", center: "pump_nm", halfwidth: "0.05" }, "inside", "integral"),
      // sb_low_nm has NaN entries: around a NaN center nothing is a member (NaN; count 0)
      R("sb_low_out", F, "spectra_dbm", "wl", "var:wl_nm", { mode: "center", center: "sb_low_nm", halfwidth: "0.02" }, "outside", "mean"),
      R("sb_low_cnt", F, "spectra_dbm", "wl", "var:wl_nm", { mode: "center", center: "sb_low_nm", halfwidth: "0.02" }, "outside", "count"),
      // windows over DIMENSION INDICES (freq / wl have no variables) and formula units
      R("pk_idx", F, "spectra_dbm", "wl", "index", { mode: "center", center: "250 + 0*freq", halfwidth: "freq/10" }, "inside", "max"),
      R("pk_idx_rng", F, "spectra_dbm", "wl", "index", { mode: "range", lo: "freq", hi: "freq + 100" }, "inside", "argmax_x"),
      FM("wl_sq", F, "wl_nm^2"), FM("inv_f", F, "1/freq_Hz"), FM("f_over_f", F, "freq_Hz / freq_Hz"),
      FM("pw_mul", F, "pump_dbm * freq_Hz"), FM("pw_neg", F, "wl_nm^-1"), FM("pw_half", F, "pow(wl_nm, 0.5)"),
      FM("idx2d", F, "wl * 2 + freq"), FM("sb_add", F, "pump_dbm + 3"), FM("sb_db", F, "pump_dbm - sb_low_dbm"),
      FM("sb_rt", F, "lin2db(db2lin(pump_dbm))"),
    ];
    const FORMULA_UNITS = { wl_sq: "nm^2", inv_f: "1/Hz", f_over_f: "", pw_mul: "dBm" + u(0xb7) + "Hz", pw_neg: "nm^-1",
      pw_half: "nm^0.5", idx2d: "", sb_add: "dBm", sb_db: "dB", sb_rt: "dBm", pk_idx: "dBm", pk_idx_rng: "" };
    const tabs = [
      tab("Rainbow spectra", { mode: "Rainbow", cmap: "Rainbow", cunit: "G", xunit: "k", xmin: "1.5502", xmax: "1.5508",
        ymin: "-75", title: "OSA spectra vs VNA frequency" }, [
        tr(F, "spectra_dbm", "wl", "var:wl_nm", "freq", { freq: 0 }, { ssrc: "var:freq_Hz", label: "OSA", sweep_label: "{label} @ {v} Hz (#{n})" }),
      ], [{ trace: 0, line: 3, idx: 250 }, { trace: 0, line: 150, idx: 260 }]),
      tab("Pump & sidebands", { xunit: "G", grid: false, legend_loc: "center right", ylabel: "Power (dBm)" }, [
        tr(F, "pump_dbm", "freq", "var:freq_Hz", "", {}, { label: "pump (stored)" }),
        tr(F, "pump_pk", "freq", "var:freq_Hz", "", {}, { label: "pump (derived)", draw: "markers" }),
        tr(F, "sb_low_dbm", "freq", "var:freq_Hz", "", {}, { dash: "dot" }),
        tr(F, "sb_up_dbm", "freq", "var:freq_Hz", "", {}, { dash: "dashdot", color: "#123456" }),
        tr(F, "sb_floor", "freq", "var:freq_Hz", "", {}),
        tr(F, "pump_int", "freq", "var:freq_Hz", "", {}, { yaxis: "right" }),
        tr(F, "sb_low_out", "freq", "var:freq_Hz", "", {}, { visible: false }),
        tr(F, "sb_low_cnt", "freq", "var:freq_Hz", "", {}, { visible: false }),
        ...Object.keys(FORMULA_UNITS).map((v) => tr(F, v, "freq", "index", "", {}, { visible: false })),
      ]),
      tab("2D sweep, index colorbar", { cmap: "CoolWarm", cunit: "G" }, [
        tr(F, "spectra_dbm", "wl", "var:wl_nm", "freq", {}, { ssrc: "index" }),
      ]),
    ];
    cases.push({ id: "B_sidebands_rainbow", files: [F], project: project(tabs, derived),
      opts: { pdfName: "sidebands_report", source: "sidebands" }, pages: 3, derivedErrors: [], units: FORMULA_UNITS,
      dimsOf: { idx2d: ["wl", "freq"], pk_idx: ["freq"], wl_sq: ["freq", "wl"] },
      expectOut: [/legend omitted/, /index - SI scaling not applied/],
      pdfText: [{ page: 0, includes: "OSA spectra vs VNA frequency" }, { page: 0, includes: "freq_Hz (GHz)" }],
      configPdfName: "sidebands_report.pdf", png: true, svg: true });
  }

  // --- C. fourd: 3D waterfall
  {
    const F = "fourd.nc";
    const derived = [R("fpk", F, "spectra", "traceindex", "var:frequency", { mode: "range", lo: "2G", hi: "4e9" }, "inside", "max")];
    const tabs = [
      tab("3D waterfall", { mode: "3D waterfall", xunit: "G", zlabel: "d3 index", logx: true, xmin: "2",
        title: "4-D spectra" }, [
        tr(F, "spectra", "traceindex", "var:frequency", "d3", { d1: 1, d2: 1 }, { lw: 2 }),
      ], [{ trace: 0, line: 0, idx: 5 }]),
      tab("Peak vs d3 (index colorbar)", { mode: "Rainbow", cmap: "Turbo", cunit: "k" }, [
        tr(F, "fpk", "d3", "coord", "d1", { d2: 0 }, { ssrc: "index", draw: "lines+markers" }),
      ]),
      tab("3D, no sweep", { mode: "3D waterfall" }, [
        tr(F, "spectra", "traceindex", "var:frequency", "", { d1: 0, d2: 1, d3: 2 }),
        tr(F, "spectra", "traceindex", "index", "", { d1: 2, d2: 0, d3: 3 }, { yaxis: "right", color: "#00aa00" }),
      ]),
      tab("Empty tab", { title: "nothing here" }, []),
      tab("All hidden", { mode: "Rainbow" }, [tr(F, "spectra", "traceindex", "index", "d3", {}, { visible: false })]),
    ];
    cases.push({ id: "C_fourd_3d", files: [F], project: project(tabs, derived), opts: {}, pages: 5,
      derivedErrors: [], expectOut: [/log axes are not applied in the 3D view/, /markers are shown in the 2D views only/],
      png: true });
  }

  // --- D. powercal_hdf5: right axis, log y, one-sided limits, color, dash, locked size, markers-only, >200 lines
  {
    const F = "powercal_hdf5.nc";
    const derived = [TF("sa_mW", F, "sa_peak_mean", "db2lin")];
    const tabs = [
      tab("Power cal", { logy: true, ymin: "1e-4", ymax2: "0", xunit: "G", lock_size: true, figw: 7, figh: 4.5,
        legend_loc: "lower left" }, [
        tr(F, "sa_mW", "frequency", "coord", "vna_power", {}, { color: "#1f77b4", label: "SA peak (mW)" }),
        tr(F, "gain", "frequency", "coord", "vna_power", {}, { yaxis: "right", color: "#ff7f0e", dash: "dash", lw: 2.5 }),
      ], [{ trace: 1, line: 2, idx: 10 }]),
      tab("SA traces (markers)", { xunit: "M" }, [
        tr(F, "sa_trace", "sa_point", "var:sa_freq", "sweep", { vna_power: 2, frequency: 5 }, { draw: "markers" }),
      ]),
      tab("601-line sweep", { cunit: "M" }, [
        tr(F, "sa_trace", "frequency", "coord", "sa_point", { vna_power: 1, sweep: 0 }, { ssrc: "var:sa_freq" }),
      ]),
    ];
    cases.push({ id: "D_powercal_right_axis", files: [F], project: project(tabs, derived), opts: {}, pages: 3,
      derivedErrors: [], units: { sa_mW: "mW" }, pageSize: { 0: [504, 324] },
      expectOut: [/sweep 'sa_point' has 601 lines - showing 200 evenly spaced/], png: true });
  }

  // --- E. snapshots (time axis) + a synthetic 450-line file referenced by ABSOLUTE path in FILES
  {
    const F = "snapshots.nc", B = "bigsweep.nc";
    const tabs = [
      tab("Scope snapshot", { xunit: "m", legend_loc: "lower left", title: "Scope snapshot #1" }, [
        tr(F, "volts", "sample", "var:time_s", "channel", { snap: 1 }, { sweep_label: "CH{v} (#{n}) {label}/{sweep}", lw: 0.8 }),
        tr(F, "volts", "sample", "var:time_s", "channel", { snap: 2 }, { visible: false }),
      ], [{ trace: 0, line: 1, idx: 500 }]),
      tab("Synthetic 450-line sweep", { mode: "Rainbow", cmap: "Gray" }, [
        tr(B, "sig", "n", "coord", "k", {}),
      ]),
      tab("Synthetic parallel ns x", {}, [
        tr(B, "sig", "n", "var:tt", "k", {}, { ssrc: "var:amp" }),
      ]),
    ];
    cases.push({ id: "E_snapshots_bigsweep", files: [F], synthetic: { [B]: "make_bigsweep.py" },
      project: project(tabs, []), opts: {}, pages: 3, derivedErrors: [],
      expectOut: [/sweep .k. has 450 lines - showing 200 evenly spaced/], png: true });
  }

  // --- F. unicode / quotes / backslashes / triple quotes + a missing file + tab selection
  {
    const F = "sidebands.nc";
    const tabs = [
      tab("Missing data", {}, [tr(MISSING, "whatever", "x", "index", "", {})]),
      tab(NASTY.slice(0, 70), { title: NASTY, xlabel: NASTY, clabel: NASTY }, [
        tr(F, "pump_dbm", "freq", "var:freq_Hz", "", {}, { label: NASTY }),
        tr(F, "sb_up_dbm", "freq", "var:freq_Hz", "", {}, { label: "two\nlines \\n" }),
      ]),
      tab("Hidden trace on a missing file", {}, [
        tr(F, "pump_dbm", "freq", "index", "", {}),
        tr(MISSING, "whatever", "x", "index", "", {}, { visible: false }),
      ]),
      tab("Not selected", {}, [tr(F, "pump_dbm", "freq", "index", "", {})]),
    ];
    cases.push({ id: "F_unicode_missing", files: [F], project: project(tabs, []),
      opts: { tabs: [2, 0, 1, 2, 99], source: NASTY, pdfName: 'rep"ort' + u(0xb5) + ".PDF" }, pages: 2,
      skippedTabs: [0], derivedErrors: [], expectOut: [/WARNING: data file 'nonexistent_run42\.nc' not found/,
        /page 1\/3 'Missing data' skipped/],
      configNames: [0, 1, 2], configPdfName: 'rep"ort' + u(0xb5) + ".PDF" });
  }

  // --- H. NetCDF-3 powercal with the data file NEXT TO the script (no --data-dir, no --out)
  {
    const F = "powercal_nc3.nc";
    const derived = [
      R("sp_mean", F, "sensor_power", "reading", "index", {}, "inside", "mean"),
      R("sp_mean_dbavg", F, "sensor_power", "reading", "index", {}, "inside", "mean", { db: "no" }),
      R("sp_std", F, "sensor_power", "reading", "coord", {}, "inside", "std", { db: "no" }),
      CB("gain_check", F, "sp_mean", "-", "vna_power_actual"),
    ];
    const tabs = [
      tab("Sensor power", { xunit: "G", legend_loc: "upper right" }, [
        tr(F, "sensor_power_mean", "frequency", "coord", "vna_power", {}, { label: "stored mean" }),
        tr(F, "sp_mean", "frequency", "coord", "vna_power", {}, { label: "linear-power mean", draw: "markers" }),
        tr(F, "sp_mean_dbavg", "frequency", "coord", "vna_power", {}, { visible: false }),
        tr(F, "sp_std", "frequency", "coord", "vna_power", {}, { yaxis: "right" }),
      ]),
      tab("Gain check", {}, [tr(F, "gain_check", "frequency", "coord", "vna_power", {})]),
    ];
    cases.push({ id: "H_nc3_beside_script", files: [F], project: project(tabs, derived),
      opts: { pdfName: "powercal.pdf" }, pages: 2, derivedErrors: [], units: { sp_mean: "dBm", gain_check: "dB" },
      besideScript: { [F]: "PowerCal_NC3.nc" }, defaultPaths: "powercal.pdf" });
  }

  // --- I. darpa: EXPRESSION windows (the PI's case: f0 +- 1% of f0, f0 +- 3 RBW,
  //        0.9 f0 .. 1.1 f0), formula chains, SI suffixes, quoted names,
  //        functions, undefined windows, expression errors (the page that
  //        plots one is skipped, exit code 0) and LEGACY defs written into
  //        CONFIG by hand (the script migrates them; old semantics expected)
  {
    const F = "darpa.nc";
    const S = (name, win, region, stat, extra) => R(name, F, "spectrums", "TraceIndex", "var:frequencies", win, region, stat, extra);
    const cw = (center, halfwidth, halfwidth2 = "") => ({ mode: "center", center, halfwidth, halfwidth2 });
    const nanHw = "0.01*stimulusFrequency + 0*sqrt(stimulusAmp - 0.01)";   // NaN where stimulusAmp < 0.01
    const derived = [
      S("pk_rel", cw("stimulusFrequency", "0.01*stimulusFrequency"), "inside", "max"),
      S("fl_rbw", cw("stimulusFrequency", "3*ResolutionBWs"), "outside", "mean"),
      S("pk_rng", { mode: "range", lo: "stimulusFrequency*0.9", hi: "stimulusFrequency*1.1" }, "inside", "max"),
      S("pk_f", { mode: "range", lo: "stimulusFrequency * 1.1", hi: " stimulusFrequency*0.9 " }, "inside", "argmax_x"),
      S("fl_ow", cw('"stimulusFrequency"', "3*ResolutionBWs", "0.25 * stimulusFrequency"), "outside_within", "median"),
      S("cnt_si", { mode: "range", lo: "29.5M", hi: "30500k" }, "inside", "count"),
      S("pk dBm", cw("2*stimulusFrequency - stimulusFrequency", "(1e6)"), "inside", "max"),
      S("pk_nan", cw("stimulusFrequency", nanHw), "inside", "max"),
      S("cnt_nan", cw("stimulusFrequency", nanHw), "inside", "count"),
      S("fl_nanouter", cw("stimulusFrequency", "1M", "ln(stimulusAmp*100 - 1) * 10M"), "outside_within", "mean"),
      S("pk_trace", cw("stimulusFrequency + trace*0", "250k"), "inside", "max"),
      // fields the mode/region does not use are ignored (no false cycle, no error)
      S("unused_f", { ...cw("stimulusFrequency", "1M", "unused_f + nonsense("), lo: "unused_f" }, "inside", "max"),
      FM("snr", F, "pk_rel - fl_rbw"),
      FM("density", F, "fl_rbw - 10*log10(ResolutionBWs)"),
      FM("q_snr", F, '"pk dBm" - fl_rbw'),
      FM("dimorder", F, "trace + ResolutionBWs"),
      FM("fn_mix", F, "max(pk_rel, fl_rbw + 20) - min(pk_rel, -30)"),
      FM("fn_all", F, "abs(fl_rbw) + sqrt(ResolutionBWs) + exp(-stimulusAmp) + ln(VideoBWs) + log(2) + log10(100)"
        + " + floor(pk_rel) + ceil(fl_rbw) + round(pk_rel)"),
      FM("lin", F, "db2lin(pk_rel)"), FM("back", F, "lin2db(lin)"), FM("ratio", F, "lin / lin"),
      FM("pw", F, "pow(2, 10) + 2^3^2 - -2^2 + 2**-1"),
      FM("si", F, "2e3k + 5m + 1" + u(0xb5) + " + 1" + u(0x3bc) + " + 3K + 4G + 2T + 7p + 9n + 3u + .5"),
      FM("twopi", F, "2*pi"),
      FM("chain2", F, "snr + 0*density"),
      // mistakes: each is reported with its field / name / position
      S("bad_hw", cw("stimulusFrequency", "3*RBWs"), "inside", "max"),
      S("bad_dim", cw("frequencies", "1M"), "inside", "max"),
      S("bad_empty", cw("stimulusFrequency", " "), "inside", "max"),
      FM("bad_syntax", F, "pk_rel +"),
      FM("bad_fn", F, "foo(pk_rel)"),
      FM("bad_num", F, "5ms * pk_rel"),
      FM("bad_dep", F, "bad_hw + 1"),
      // an OLD def named like a function still computes (the app keeps it); in
      // an expression max(...) is the function and a bare max the variable
      FM("max", F, "1"), FM("uses_max", F, 'max + max(1, 2) + "max"'),
    ];
    // hand-edited CONFIG: legacy defs inserted at the FRONT (leg_var's migrated
    // center "pk_f - 100000" must still order it after pk_f)
    const legacyDefs = [
      RL("leg_rel", F, "spectrums", "TraceIndex", "var:frequencies",
        { mode: "relative", center: "coord:stimulusFrequency", k: 0.5, offset: 5e6, halfwidth: -1e6 }, "inside", "max"),
      RL("leg_fix", F, "spectrums", "TraceIndex", "var:frequencies",
        { mode: "fixed", lo: 31e6, hi: 29e6, lo2: 20e6, hi2: 40e6 }, "outside_within", "count"),
      RL("leg_var", F, "spectrums", "TraceIndex", "var:frequencies",
        { mode: "relative", center: "var:pk_f", k: 1, offset: -1e5, halfwidth: 2e5, halfwidth2: 1e6 }, "outside_within", "mean"),
    ];
    const vs = (v, extra = {}) => tr(F, v, "stimulusFrequency", "coord", "stimulusAmp", { trace: 0 }, extra);
    const hidden = (v) => vs(v, { visible: false });
    const tabs = [
      tab("Expression windows", { title: "Peak within f0 ± 1 %, floor outside f0 ± 3 RBW", legend_loc: "center right",
        ylabel: "Power (dBm)", ylabel2: "SNR (dB)" }, [
        vs("pk_rel", { draw: "lines+markers" }), vs("fl_rbw", { draw: "lines+markers", dash: "dash" }),
        vs("pk_rng", { label: "peak in 0.9 f0 .. 1.1 f0", dash: "dot" }), vs("snr", { yaxis: "right", lw: 2 }),
      ]),
      tab("Formulas", {}, [
        vs("density"), vs("q_snr"),
        tr(F, "dimorder", "trace", "index", "stimulusAmp", { stimulusFrequency: 1 }, { yaxis: "right" }),
      ]),
      tab("Broken", {}, [vs("pk_rel"), vs("bad_hw")]),
      tab("Undefined windows", {}, [
        vs("pk_nan"), vs("cnt_nan", { yaxis: "right" }),
        ...["pk_f", "fl_ow", "cnt_si", "pk dBm", "fl_nanouter", "pk_trace", "fn_mix", "fn_all", "lin", "back", "ratio",
          "pw", "si", "twopi", "chain2", "unused_f", "bad_dim", "bad_empty", "bad_syntax", "bad_fn", "bad_num", "bad_dep", "uses_max"].map(hidden),
      ]),
    ];
    const si = 2e3 * 1e3 + 5 * 1e-3 + 1 * 1e-6 + 1 * 1e-6 + 3 * 1e3 + 4 * 1e9 + 2 * 1e12 + 7 * 1e-12 + 9 * 1e-9 + 3 * 1e-6 + 0.5;
    cases.push({ id: "I_darpa_expressions", files: [F], project: project(tabs, derived), opts: {},
      appendConfig: legacyDefs.map((d) => `CONFIG["derived"].insert(0, ${P.pyLiteral(d, 0, 30)})`).join("\n"),
      pages: 3, skippedTabs: [2],
      derivedErrors: ["bad_hw", "bad_dim", "bad_empty", "bad_syntax", "bad_fn", "bad_num", "bad_dep"],
      expectOut: [/WARNING: page 3\/4 'Broken' skipped: it plots derived 'bad_hw' \(darpa\.nc\), which could not be computed/,
        /derived 'bad_hw' \(darpa\.nc\) not computed: window halfwidth: unknown name 'RBWs' at position 2\r?\n {8}3\*RBWs\r?\n {10}\^/,
        /derived 'bad_dim' .* window center: 'frequencies' has dimension 'TraceIndex', which the result lacks at position 0/,
        /derived 'bad_empty' .* window halfwidth is empty/, /derived 'bad_fn' .* formula: unknown function 'foo' at position 0/,
        /derived 'bad_num' .* formula: invalid number '5ms' at position 0/,
        /derived 'bad_syntax' .* formula: unexpected end of the expression at position 8/,
        /derived 'bad_dep' \(darpa\.nc\) not computed: uses 'bad_hw', which could not be computed/],
      units: { pk_rel: "DBM", fl_rbw: "DBM", pk_f: "", cnt_si: "", snr: "dB", density: "DBM", q_snr: "dB", dimorder: "",
        fn_mix: "dB", fn_all: "DBM", lin: "mW", back: "dBm", ratio: "", pw: "", si: "", twopi: "", chain2: "DBM", max: "", uses_max: "",
        leg_rel: "DBM", leg_fix: "", leg_var: "DBM", unused_f: "DBM" },
      dimsOf: { dimorder: ["trace", "stimulusFrequency", "stimulusAmp"], twopi: [], pk_rel: ["stimulusFrequency", "stimulusAmp", "trace"] },
      expectValues: { pw: [1540.5], twopi: [2 * Math.PI], si: [si], ratio: Array(12).fill(1), max: [1], uses_max: [4],
        cnt_si: [21, 21, 21, 21, 21, 21, 0, 0, 0, 0, 0, 0] },
      numpyRef: "expr_reference.py", png: true });
  }

  // --- G. a v1 / desktop project (absolute Windows paths), remapped through FILES
  if (fs.existsSync(dataFile("desktop.ncproj"))) {
    const proj = JSON.parse(fs.readFileSync(dataFile("desktop.ncproj"), "utf8"));
    const names = [...new Set((proj.traces || []).map((t) => String(t.file).replace(/\\/g, "/").split("/").pop()))];
    cases.push({ id: "G_desktop_v1", files: ["sidebands.nc"], project: proj, opts: {}, pages: 1, derivedErrors: [],
      remap: Object.fromEntries(names.map((n) => [n, "sidebands.nc"])) });
  }
  return cases;
}

// FILES entry rewrite: '"name": "name"' -> '"name": <path>'
function patchFiles(script, name, target) {
  const from = `${P.pyStr(name)}: ${P.pyStr(name)}`;
  if (!script.includes(from)) throw new Error("FILES entry not found for " + name);
  return script.replace(from, () => `${P.pyStr(name)}: ${P.pyStr(target)}`);
}

// ============================================================ 3. run one case
const dsCache = new Map();
async function plainDs(p) {
  if (!dsCache.has(p)) dsCache.set(p, await loadDataset(p));
  return dsCache.get(p);
}

async function runCase(cs) {
  const tag = cs.id;
  for (const f of cs.files) if (!haveData(f)) { skip(tag, `tests/data/${f} missing`); return; }
  const dir = path.join(TMP, tag);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = {};     // FILES name -> absolute data path (for the JS side)
  for (const f of cs.files) filePath[f] = dataFile(f);

  let script = P.buildReportScript(cs.project, { generatedAt: "2026-10-02T12:00:00.000Z", ...cs.opts });
  for (const [name, gen] of Object.entries(cs.synthetic || {})) {
    const target = path.join(dir, "synthetic", name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const r = runPy([path.join(PY_DIR, gen), target]);
    if (!check(`${tag}: synthetic ${name} created`, r.status === 0 && fs.existsSync(target), r.out)) return;
    script = patchFiles(script, name, target);          // absolute path in FILES
    filePath[name] = target;
  }
  for (const [name, target] of Object.entries(cs.remap || {})) {
    script = patchFiles(script, name, target);          // relative path in FILES
    filePath[name] = dataFile(target);
  }
  if (cs.appendConfig) {      // a hand edit of the CONFIG section
    if (!script.includes("\nSCRIPT_DIR = ")) throw new Error("SCRIPT_DIR marker not found");
    script = script.replace("\nSCRIPT_DIR = ", () => "\n" + cs.appendConfig + "\n\nSCRIPT_DIR = ");
  }
  const scriptPath = path.join(dir, "report.py");
  fs.writeFileSync(scriptPath, script, "utf8");
  const g = runPy(["-c", "import ast, sys; ast.parse(open(sys.argv[1], encoding='utf-8').read(), feature_version=(3, 8))", scriptPath]);
  check(`${tag}: script is valid Python 3.8 syntax`, g.status === 0, g.out);

  // data copied NEXT TO the script (default data folder), under another letter case
  for (const [src, as] of Object.entries(cs.besideScript || {})) {
    fs.copyFileSync(dataFile(src), path.join(dir, as));
    filePath[src] = path.join(dir, as);
  }

  // --- run it
  const lj = path.join(dir, "lines.json"), dj = path.join(dir, "derived.json");
  const pdf = cs.defaultPaths ? path.join(dir, cs.defaultPaths) : path.join(dir, "out.pdf");
  const args = cs.defaultPaths ? [scriptPath, "--dump-lines", lj, "--dump-derived", dj]
    : [scriptPath, "--data-dir", DATA_DIR, "--out", pdf, "--dump-lines", lj, "--dump-derived", dj];
  if (cs.png) args.push("--png", "--dpi", "110");
  if (cs.svg) args.push("--svg");
  const t0 = Date.now();
  const r = runPy(args);
  fs.writeFileSync(path.join(dir, "stdout.txt"), r.out);
  if (!check(`${tag}: exit code 0`, r.status === 0, r.out.slice(-3000))) return;
  console.log(`  ${tag}: ran in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  check(`${tag}: no ERROR / traceback in output`, !/ERROR|Traceback/.test(r.out), r.out.slice(-2000));
  for (const re of cs.expectOut || []) check(`${tag}: output matches ${re}`, re.test(r.out), r.out.slice(-1500));
  for (const n of cs.derivedErrors || [])
    check(`${tag}: derived '${n}' reported as not computed`, new RegExp(`derived '${n}' \\(.*\\) not computed`).test(r.out));

  // --- PDF: pages, vector only, sizes, text
  const pj = path.join(dir, "pdf.json");
  const pr = runPy([path.join(PY_DIR, "pdfcheck.py"), pdf, pj]);
  let info = null;
  if (check(`${tag}: pdfcheck ran`, pr.status === 0, pr.out)) {
    info = JSON.parse(fs.readFileSync(pj, "utf8"));
    check(`${tag}: ${cs.pages} page(s)`, info.pages.length === cs.pages, info.pages.length);
    check(`${tag}: no raster images (vector only)`, info.pages.every((p) => p.xobject_images === 0 && p.images === 0),
      info.pages.map((p) => [p.xobject_images, p.images]));
    for (const [pg, [w, h]] of Object.entries(cs.pageSize || {}))
      check(`${tag}: page ${pg} size ${w}x${h} pt`, Math.abs(info.pages[pg].w - w) < 0.5 && Math.abs(info.pages[pg].h - h) < 0.5,
        [info.pages[pg].w, info.pages[pg].h]);
    for (const tc of cs.pdfText || [])
      check(`${tag}: page ${tc.page} text has '${tc.includes}'`, (info.pages[tc.page].text || "").includes(tc.includes),
        (info.pages[tc.page].text || "").slice(0, 300));
  }
  if (cs.png) {
    const pngs = fs.readdirSync(dir).filter((f) => f.endsWith(".png"));
    check(`${tag}: one PNG per page`, pngs.length === cs.pages, pngs);
  }
  if (cs.svg) {
    const svgs = fs.readdirSync(dir).filter((f) => f.endsWith(".svg"));
    check(`${tag}: one SVG per page`, svgs.length === cs.pages && svgs.every((f) => !fs.readFileSync(path.join(dir, f), "utf8").includes("<image")), svgs);
  }

  // --- the script's CONFIG as Python sees it (+ helper probe)
  const probe = await probeHelpers(tag, scriptPath, dir);
  if (!probe) return;
  const cfg = probe.config;
  const allTabs = cs.project.tabs || [{ name: "Plot 1", plot: cs.project.plot, traces: cs.project.traces, markers: cs.project.markers }];
  const sel = Array.isArray(cs.opts.tabs) ? [...new Set(cs.opts.tabs)].filter((i) => i >= 0 && i < allTabs.length).sort((a, b) => a - b)
    : allTabs.map((_, i) => i);
  check(`${tag}: CONFIG tab indices`, JSON.stringify(cfg.tabs.map((t) => t.index)) === JSON.stringify(sel), cfg.tabs.map((t) => t.index));
  cfg.tabs.forEach((ct) => {
    const pt = allTabs[ct.index];
    check(`${tag}: tab ${ct.index} name round-trips`, ct.name === (String(pt.name || "").trim().slice(0, 80) || `Plot ${ct.index + 1}`),
      [ct.name, pt.name]);
    check(`${tag}: tab ${ct.index} title round-trips`, ct.plot.title === ((pt.plot && pt.plot.title) || ""));
    ct.traces.forEach((t, i) => {
      const raw = pt.traces[i];
      check(`${tag}: tab ${ct.index} trace ${i} label round-trips`, t.label === String(raw.label || raw.var));
      check(`${tag}: tab ${ct.index} trace ${i} all fields`, JSON.stringify(Object.keys(t)) === JSON.stringify(X.TRACE_KEYS || Object.keys(t)), Object.keys(t));
    });
  });
  if (info) {   // page size = the tab's locked plot size, else 8 x 5.2 in
    const drawn = cfg.tabs.filter((t) => !(cs.skippedTabs || []).includes(t.index));
    const sizes = drawn.map((t) => (t.plot.lock_size ? [t.plot.figw * 72, t.plot.figh * 72] : [576, 374.4]));
    check(`${tag}: page sizes (locked size or 8 x 5.2 in)`, sizes.length === info.pages.length
      && sizes.every(([w, h], i) => Math.abs(info.pages[i].w - w) < 0.5 && Math.abs(info.pages[i].h - h) < 0.5),
      [sizes, info.pages.map((p) => [p.w, p.h])]);
  }
  if (cs.opts.source !== undefined) check(`${tag}: CONFIG source round-trips`, cfg.source === cs.opts.source);
  if (cs.configPdfName) check(`${tag}: CONFIG pdf_name`, cfg.pdf_name === cs.configPdfName, cfg.pdf_name);

  // --- lines + derived
  const lines = JSON.parse(fs.readFileSync(lj, "utf8"));
  const der = JSON.parse(fs.readFileSync(dj, "utf8"));
  for (const [name, want] of Object.entries(cs.configWindows || {})) {
    const d = cfg.derived.find((x) => x.name === name), w = { ...W0, ...want };
    check(`${tag}: CONFIG window of '${name}' (expression format)`, d && JSON.stringify(d.window) === JSON.stringify(w), d && d.window);
  }
  if (cs.numpyRef) {          // hand-written numpy computation of the same quantities
    const nj = path.join(dir, "numpy_ref.json");
    const nr = runPy([path.join(PY_DIR, cs.numpyRef), DATA_DIR, nj]);
    if (check(`${tag}: numpy reference ran`, nr.status === 0, nr.out)) {
      const ref = JSON.parse(fs.readFileSync(nj, "utf8")), got = der[cs.files[0]] || {};
      for (const [name, e] of Object.entries(ref)) {
        const pv = got[name];
        if (!check(`${tag}: ${name} dumped (numpy ref)`, !!pv)) continue;
        check(`${tag}: ${name} dims/shape vs numpy ref`, JSON.stringify([pv.dims, pv.shape]) === JSON.stringify([e.dims, e.shape]),
          [pv.dims, pv.shape, e.dims, e.shape]);
        check(`${tag}: ${name} values vs numpy ref (rel 1e-9)`, arrClose(pv.data, e.data, 1e-9), firstDiff(pv.data, e.data, 1e-9));
      }
      console.log(`  ${tag}: compared ${Object.keys(ref).length} quantities with the hand-written numpy reference`);
    }
  }
  await compareDerived(tag, cs, cfg, der, filePath);
  await compareLines(tag, cs, cfg, lines, der, filePath);
}

async function probeHelpers(tag, scriptPath, dir) {
  const fmtVals = [0, -0, 1, -1, 0.5, 1 / 3, 2e-5 / 3, 123456.5, 1234565, 999999.5, 999999.4, 1e6, 1.5e6,
    10000500, 1234650, -1234650, 1e-4, 9.99995e-5, 0.000123455, 1e21, 1e-300, 5e-324, 1.7976931348623157e308,
    12345.65, 0.1 + 0.2, 100, 1550.488, -8.5818, 3e7, 2.5, 0.000125, 4.35e10, 1.25e-7, 99999.95, 0.00099999995];
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let i = 0; i < 300; i++) fmtVals.push((rnd() - 0.5) * Math.pow(10, Math.floor(rnd() * 24) - 10));
  for (let i = 0; i < 60; i++) fmtVals.push(Math.floor(rnd() * 9e6 + 1e6) * 10 + 5);   // exact 7th-digit ties
  for (let i = 0; i < 60; i++) fmtVals.push(Math.round(rnd() * 1e6) / 1e3);
  const fmtIn = fmtVals.concat([NaN, Infinity, -Infinity]);
  const ts = Array.from({ length: 101 }, (_, i) => i / 100).concat([-0.5, 1.5, 0.125, 0.3333]);
  const tsIn = ts.concat([NaN]);
  const enc = (v) => (Number.isFinite(v) ? v : String(v));
  const scaled = [["freq_Hz (Hz)", "G"], ["x", ""], ["x", "k"], ["", "M"], ["a (b) (c)", "m"], ["volts", u(0xb5)],
    ["v (V)", u(0xb5)], ["(", "n"], ["x)", "p"], ["t (s)", "T"], ["wl_nm (nm)", "k"]];
  const llTraces = [
    [{ label: "L", var: "v", sweep_label: "" }, "ch", 3.5, 2],
    [{ label: "L", var: "v", sweep_label: "{label}@{v}/{sweep}#{n} {v}" }, "ch", 1e7, 0],
    [{ label: "", var: "v", sweep_label: "   " }, "freq", 0.000012345, 5],
    [{ label: "base", var: "v", sweep_label: "x" }, "s", null, 1],
    [{ label: "B", var: "v", sweep_label: " CH{v} " }, "", NaN, 7],
  ];
  const ar = [["", "", 0, 1, false], ["1", "", -2, 5, false], ["", "3", 4, 9, false], ["5", "2", 0, 1, false],
    ["2", "2", 0, 1, false], ["", "", NaN, NaN, false], ["1", "", NaN, NaN, false], ["0", "", 0.5, 100, true],
    ["", "10", -3, 50, true], ["-1", "-0.5", 1, 2, true], ["1e-4", "", 1e-6, 2e-3, true], ["abc", "", 0, 1, false],
    [" 12x", "", 0, 100, false]];
  const tsu = ["", "ns", "nanoseconds since 2000", "s", "milliseconds", "ms", "Microseconds", "minutes",
    "hours since 1970", "days since 2000-01-01", "dns", "x ns y", "seconds", "DBM", " minutes", "ns\n", "\ufeffhours"];
  const req = {
    fmt6: fmtIn.map(enc), ts: tsIn.map(enc), cmaps: [...CM.CMAP_NAMES, "Nope"], scaled,
    line_label: llTraces.map(([t, sw, sv, j]) => [t, sw, sv === null ? null : enc(sv), j]),
    axis_range: ar.map(([a, b, c, d, e]) => [a, b, enc(c), enc(d), e]), time_scale: tsu,
  };
  if (tag.startsWith("A")) {      // the expression engine, once
    req.exprs = EXPR_CASES.map((c) => c[0]);
    // (a > 320-char field is capped by the JS side only: a hand-typed one stays whole)
    req.migrate = MIGRATE_INPUTS.filter((w) => !(w && typeof w.center === "string" && w.center.length > 320));
    req.js_str = JS_STR_VALUES;
  }
  const rq = path.join(dir, "probe_req.json"), ro = path.join(dir, "probe_out.json");
  fs.writeFileSync(rq, JSON.stringify(req));
  const r = runPy([path.join(PY_DIR, "probe_helpers.py"), scriptPath, rq, ro]);
  if (!check(`${tag}: helper probe ran`, r.status === 0, r.out.slice(-2000))) return null;
  const out = JSON.parse(fs.readFileSync(ro, "utf8"));
  if (tag.startsWith("A")) {      // helper equivalence once is enough
    const bad = fmtIn.map((x, i) => [x, X.fmt6(x), out.fmt6[i]]).filter(([, a, b]) => a !== b);
    check(`fmt6 matches JS on ${fmtIn.length} values`, bad.length === 0, bad.slice(0, 5));
    let cbad = [];
    for (const name of req.cmaps) tsIn.forEach((t, i) => {
      const js = CM.cmapColor(name, t).match(/\d+/g).map(Number);
      if (JSON.stringify(js) !== JSON.stringify(out.cmap[name][i])) cbad.push([name, t, js, out.cmap[name][i]]);
    });
    check(`cmap_color matches JS cmapColor (${req.cmaps.length} maps x ${tsIn.length} positions)`, cbad.length === 0, cbad.slice(0, 5));
    const sbad = scaled.map(([b, p], i) => [b, p, X.scaledLabel(b, p), out.scaled[i]]).filter((x) => x[2] !== x[3]);
    check("scaled_label matches JS scaledLabel", sbad.length === 0, sbad);
    const lbad = llTraces.map(([t, sw, sv, j], i) => [X.lineLabel(t, sw, sv, j), out.line_label[i]]).filter((x) => x[0] !== x[1]);
    check("line_label matches JS lineLabel", lbad.length === 0, lbad);
    const abad = [];
    ar.forEach(([a, b, c, d, e], i) => {
      const js = jsAxisRange(a, b, c, d, e), py = out.axis_range[i];
      const jsLin = js && e ? js.map((v) => Math.pow(10, v)) : js;
      const ok = (jsLin === null && py === null) || (jsLin && py && close(jsLin[0], py[0], 1e-12) && close(jsLin[1], py[1], 1e-12));
      if (!ok) abad.push([ar[i], jsLin, py]);
    });
    check("axis_range matches app.js axisRange", abad.length === 0, abad);
    const tbad = tsu.map((s, i) => [s, X.asFloatArray([1], s)[0], out.time_scale[i]]).filter((x) => x[1] !== x[2]);
    check("time_scale matches JS asFloatArray", tbad.length === 0, tbad);
    checkExprProbe(out, req);
  }
  return out;
}

// ------------------------------------------------------------ expression engine (Python) checks
// Formulas over the probe's fake file (tests/py/probe_helpers.py FakeFile):
// a = 2 V, b = 3 V, c = NaN; v(d) = [1,2,3] dBm; w(e) = [10,20] dBm; t(d) =
// [1,2,3] ns; dim e (2) has no variable; dim s (4) only a non-numeric
// variable; str(d) is non-numeric.
// [text, {v: values, dims, units, names}]  or  [text, {err: true, pos}]
const DOT = u(0xb7);
const EXPR_CASES = [
  ["1+2*3", { v: [7], dims: [], units: "" }], ["(1+2)*3", { v: [9] }], ["2^3^2", { v: [512] }], ["2**3**2", { v: [512] }],
  ["-2^2", { v: [-4] }], ["(-2)^2", { v: [4] }], ["2^-1", { v: [0.5] }], ["-a^2", { v: [-4], units: "V^2" }],
  ["a^b", { v: [8], units: "" }], ["1 - 2 - 3", { v: [-4] }], ["8/4/2", { v: [1] }], ["+a", { v: [2], units: "V" }],
  ["--a", { v: [2], units: "V" }], ["2*-a", { v: [-4], units: "V" }], ["-a^-1", { v: [-0.5], units: "V^-1" }],
  ["10k", { v: [10 * 1e3] }], ["2.5M", { v: [2.5 * 1e6] }], ["1e3m", { v: [1e3 * 1e-3] }], ["2e3k", { v: [2e3 * 1e3] }],
  [".5u", { v: [0.5 * 1e-6] }], ["3" + u(0xb5), { v: [3 * 1e-6] }], ["3" + u(0x3bc), { v: [3 * 1e-6] }], ["7p", { v: [7 * 1e-12] }],
  ["4G", { v: [4 * 1e9] }], ["1T", { v: [1 * 1e12] }], ["2K", { v: [2 * 1e3] }], ["5n", { v: [5 * 1e-9] }], ["3.E2k", { v: [300 * 1e3] }],
  ["0.1 + 0.2", { v: [0.1 + 0.2] }], ["pi", { v: [Math.PI], units: "", names: ["pi"] }], ["2*pi", { v: [2 * Math.PI] }],
  ["abs(-3)", { v: [3] }], ["sqrt(16)", { v: [4] }], ["exp(0)", { v: [1] }], ["ln(1)", { v: [0] }], ["log(1)", { v: [0] }],
  ["log10(1000)", { v: [Math.log10(1000)] }], ["floor(-2.5)", { v: [-3] }], ["ceil(-2.5)", { v: [-2] }],
  ["round(2.5)", { v: [3] }], ["round(-2.5)", { v: [-2] }], ["round(-0.5)", { v: [0] }], ["db2lin(20)", { v: [100] }],
  ["lin2db(100)", { v: [20] }], ["lin2db(0)", { v: [NaN] }], ["lin2db(-1)", { v: [NaN] }], ["pow(2, 10)", { v: [1024] }],
  ["min(3, 1, 2)", { v: [1] }], ["max(3, 1, 2)", { v: [3] }], ["max(1)", { v: [1] }], ["max(1, c)", { v: [NaN] }],
  ["min(c, 1)", { v: [NaN] }], ["pow(1, c)", { v: [1] }], ["c^0", { v: [1] }], ["1^c", { v: [1] }], ["(-1)^(1/0)", { v: [1] }],
  ["(-1)^(-1/0)", { v: [1] }], ["2^c", { v: [NaN] }], ["(-8)^(1/3)", { v: [NaN] }], ["1/0", { v: [Infinity] }],
  ["-1/0", { v: [-Infinity] }], ["0/0", { v: [NaN] }], ["sqrt(-1)", { v: [NaN] }], ["ln(0)", { v: [-Infinity] }],
  ["c + 1", { v: [NaN] }], ["  a  *\tb\r\n", { v: [6], units: "V" + DOT + "V" }], ['"a" + "b"', { v: [5], units: "V", names: ["a", "b"] }],
  ["log10 (100)", { v: [2] }],
  // broadcasting by dimension NAME; dims in order of first appearance
  ["v + e", { v: [1, 2, 2, 3, 3, 4], dims: ["d", "e"], units: "dBm", funits: "dBm" }],
  ["e * 10 + v", { v: [1, 2, 3, 11, 12, 13], dims: ["e", "d"], units: "dBm" }],
  // (funits = a formula def's automatic units: time-like units -> "s", as the values are seconds)
  ["t", { v: [1 * 1e-9, 2 * 1e-9, 3 * 1e-9], dims: ["d"], units: "ns", funits: "s" }],
  ["t * v", { dims: ["d"], units: "ns" + DOT + "dBm", funits: "s" + DOT + "dBm" }],
  // a dim name never means a NON-coordinate variable of that name: the index
  ["h * 10", { v: [0, 10], dims: ["h"], units: "", funits: "" }],
  ["s * 2", { v: [0, 2, 4, 6], dims: ["s"], units: "" }],
  ["w - v", { v: [9, 8, 7, 19, 18, 17], dims: ["e", "d"], units: "dB" }],
  ["w - v + log10(a) + \"a\"", { names: ["w", "v", "a"], dims: ["e", "d"] }],
  // units (SPEC_EXPR E1)
  ["a/b", { v: [2 / 3], units: "" }], ["a*b", { units: "V" + DOT + "V" }], ["a^2", { units: "V^2" }], ["a^-2", { units: "V^-2" }],
  ["pow(a, 0.5)", { units: "V^0.5" }], ["a^(2)", { units: "V^2" }], ["a^1e21", { units: "V^1e+21" }], ["a^0.1", { units: "V^0.1" }],
  ["a^2k", { units: "V^2000" }], ["a^1e-7", { units: "V^1e-7" }], ["lin2db(a)", { units: "dB" }], ["db2lin(v)", { units: "mW" }],
  ["db2lin(a)", { units: "lin(V)" }], ["db2lin(c)", { units: "" }], ["1/a", { units: "1/V" }], ["a + v", { units: "V" }],
  ["v + a", { units: "dBm" }], ["abs(c) + min(c, a)", { units: "V" }], ["sqrt(a)", { units: "" }], ["-v", { units: "dBm" }],
  ["v - w", { units: "dB" }], ["v + w", { units: "dBm" }], ["(v - w) + w", { units: "dBm" }], ["a - 1", { units: "V" }],
  ["1 - a", { units: "V" }], ["v / v", { units: "" }], ["v / a", { units: "dBm/V" }], ["lin2db(db2lin(v))", { units: "dBm" }],
  ["max(c, v, a)", { units: "dBm" }], ["e + a", { units: "V" }],
  // errors (pos = 0-based character position, where it is unambiguous)
  ["", { err: true, pos: -1 }], ["   ", { err: true, pos: -1 }], ["5ms", { err: true, pos: 0 }], ["2e", { err: true, pos: 0 }],
  ["1.2.3", { err: true, pos: 0 }], ["3x", { err: true, pos: 0 }], ["a b", { err: true, pos: 2 }], ["1 +", { err: true }],
  ["(1", { err: true }], ["1)", { err: true, pos: 1 }], ["@", { err: true, pos: 0 }], ["a # b", { err: true, pos: 2 }],
  ["foo(1)", { err: true, pos: 0 }], ["abs()", { err: true }], ["abs(1, 2)", { err: true }], ["pow(1)", { err: true }],
  ["min()", { err: true }], ['"unterminated', { err: true, pos: 0 }], ['""', { err: true, pos: 0 }],
  ["unknown + 1", { err: true, pos: 0 }], ["1 + nope", { err: true, pos: 4 }], ["str * 2", { err: true, pos: 0 }],
  ["a +* b", { err: true, pos: 3 }], ["2 ^", { err: true }], ["max(1,)", { err: true }], [",", { err: true, pos: 0 }],
  ["1..2", { err: true, pos: 0 }], ["5 m", { err: true, pos: 2 }], [u(0xa0) + "1", { err: true, pos: 0 }],
  ["1" + u(0x2028), { err: true, pos: 1 }], ["abs", { err: true, pos: 0 }], ['"abs"(2)', { err: true }],
  ["a(2)", { err: true, pos: 0 }], ["2 3", { err: true, pos: 2 }], ["1e5e", { err: true, pos: 0 }],
  // positions count UTF-16 units, like the app (an emoji counts 2)
  ['"' + String.fromCodePoint(0x1f600) + '" + @', { err: true, pos: 7 }],
  // a quote followed by a letter / digit / _ belongs to the quoted name
  ['"a"b" + 1', { err: true, pos: 0 }], ['"a"5', { err: true, pos: 0 }], ['"a""b"', { err: true, pos: 3 }],
  // nesting limit (64, as the app): ( ), signs, ^ and calls
  ["(".repeat(64) + "1" + ")".repeat(64), { v: [1] }], ["(".repeat(65) + "1" + ")".repeat(65), { err: true, pos: 64 }],
  ["-".repeat(65) + "1", { err: true, pos: 64 }], ["2^".repeat(65) + "1", { err: true, pos: 129 }],
  ["abs(".repeat(65) + "1" + ")".repeat(65), { err: true, pos: 256 }], ["-".repeat(64) + "1", { v: [1] }],
  // C99 pow even for the exponent 0.5 (numpy would take sqrt), sign of zero in min / max
  ["(-1/0)^0.5", { v: [Infinity] }], ["1/(-0)^0.5", { v: [Infinity] }], ["1/pow(-0, 0.5)", { v: [Infinity] }],
  ["1/min(-0, 0)", { v: [-Infinity] }], ["1/min(0, -0)", { v: [-Infinity] }], ["1/max(0, -0)", { v: [Infinity] }],
  ["1/max(-0, -0)", { v: [-Infinity] }], ["1/max(-0, -5)", { v: [-Infinity] }], ["1/min(0, 5)", { v: [Infinity] }],
];
const NAME_ERRORS = new Set(["unknown + 1", "1 + nope", "str * 2", "abs", '"a"b" + 1']);   // not syntax errors
const MIGRATE_INPUTS = [];          // filled by jsChecks (the migrateWindow cases)
const JS_STR_VALUES = [0, 1, -1, 0.5, 2, 1e21, 1e20, 1e-7, 1e-6, 1.5e-6, 123.456, 2.5e-7, 0.1 + 0.2, 1 / 3, 5e-324,
  1.7976931348623157e308, 123456789012345680000, 1e100, -1.5e-10, 100, 3e6, 1000000, 0.02, 31e6, -5e6, 1234.5e-12];

function checkExprProbe(out, req) {
  const bad = [];
  EXPR_CASES.forEach(([text, want], i) => {
    const got = out.exprs[i];
    if (want.err) {
      if (!got.error || (want.pos !== undefined && got.pos !== want.pos)) bad.push([text, "want error", want.pos, got]);
      return;
    }
    if (got.error) { bad.push([text, "unexpected error", got.error]); return; }
    const data = got.data.map((x) => (typeof x === "string" ? Number(x) : x));
    if (want.v && !(data.length === want.v.length && data.every((x, k) => (Number.isNaN(want.v[k]) ? Number.isNaN(x)
      : !Number.isFinite(want.v[k]) ? x === want.v[k] : close(x, want.v[k], 1e-12)))))
      bad.push([text, "value", got.data, want.v]);
    if (want.dims && JSON.stringify(got.dims) !== JSON.stringify(want.dims)) bad.push([text, "dims", got.dims, want.dims]);
    if (want.units !== undefined && got.units !== want.units) bad.push([text, "units", got.units, want.units]);
    if (want.funits !== undefined && got.funits !== want.funits) bad.push([text, "funits", got.funits, want.funits]);
    if (want.names && JSON.stringify(got.names) !== JSON.stringify(want.names)) bad.push([text, "names", got.names, want.names]);
    // the tolerant dependency scan (Python expr_refs == JS exprRefs) finds the same names on valid text
    if (JSON.stringify(got.refs) !== JSON.stringify(P.exprRefs(text)) || JSON.stringify(got.refs) !== JSON.stringify(got.names))
      bad.push([text, "refs", got.refs, P.exprRefs(text), got.names]);
  });
  check(`python expressions: ${EXPR_CASES.length} cases (values, dims, units, names, errors + positions)`, bad.length === 0, bad.slice(0, 6));

  const mig = req.migrate.map((w, i) => [w, P.migrateWindow(w), out.migrate[i]])
    .filter(([, js, py]) => JSON.stringify(js) !== JSON.stringify(py));
  check(`python migrate_window == JS migrateWindow (${req.migrate.length} windows)`, req.migrate.length > 5 && mig.length === 0, mig);
  const jbad = JS_STR_VALUES.map((x, i) => [x, String(x), out.js_str[i]]).filter(([, a, b]) => a !== b);
  check(`python js_str == JS String(x) (${JS_STR_VALUES.length} values)`, jbad.length === 0, jbad);

  // docs/js/expr.js (the web app's engine), when present: same values / errors / units
  if (!E) { skip("python expressions vs docs/js/expr.js", "expr.js not available"); return; }
  const SC = { a: 2, b: 3, c: NaN }, SU = { a: "V", b: "V", c: "" };
  const xbad = [];
  let n = 0;
  EXPR_CASES.forEach(([text, want], i) => {
    const got = out.exprs[i];
    if (got.error && NAME_ERRORS.has(text)) return;
    const scalar = !got.error && (got.names || []).every((nm) => nm in SC || nm === "pi");
    if (!got.error && !scalar) return;
    n++;
    // a syntax error may surface in parseExpr or (unknown function / arity) in evalExpr
    const lookup = (nm) => (nm in SC ? SC[nm] : nm === "pi" ? Math.PI : NaN);
    let ast = null, r = null, jsErr = null;
    try { ast = E.parseExpr(text); r = E.evalExpr(ast, lookup, 1); } catch (e) { jsErr = e; }
    if (got.error) { if (!jsErr) xbad.push([text, "python error, expr.js computes", got.error]); return; }
    if (jsErr) { xbad.push([text, "expr.js error", jsErr.message]); return; }
    try {
      const v = r[0], pv = typeof got.data[0] === "string" ? Number(got.data[0]) : got.data[0];
      if (!(Number.isNaN(v) ? Number.isNaN(pv) : !Number.isFinite(v) ? v === pv : close(v, pv, 1e-12))) xbad.push([text, "value", v, pv]);
      if (typeof E.exprUnits === "function") {
        const ju = E.exprUnits(ast, (nm) => SU[nm] || "");
        if (ju !== got.units) xbad.push([text, "units", ju, got.units]);
      }
    } catch (e) { xbad.push([text, "expr.js threw", e.message]); }
  });
  check(`python expressions == docs/js/expr.js (${n} cases)`, xbad.length === 0, xbad.slice(0, 6));
}

async function compareDerived(tag, cs, cfg, der, filePath) {
  const defs = cfg.derived;
  for (const n of cs.notDumped || []) check(`${tag}: unneeded def '${n}' not exported`, !defs.some((d) => d.name === n));
  const byFile = {};
  for (const d of defs) (byFile[d.file] = byFile[d.file] || []).push(d);
  for (const [file, fdefs] of Object.entries(byFile)) {
    const pyF = der[file] || {};
    // (a) independent reference
    const ref = refDerived(await loadDataset(filePath[file]), fdefs);
    for (const d of fdefs) {
      const rv = ref.get(d.name), pv = pyF[d.name];
      const expectErr = (cs.derivedErrors || []).includes(d.name);
      if (expectErr) {
        check(`${tag}: ${d.name} fails (python)`, !pv);
        check(`${tag}: ${d.name} fails (reference)`, rv && rv.err);
        continue;
      }
      if (!check(`${tag}: ${d.name} computed by python`, !!pv)) continue;
      if (!check(`${tag}: ${d.name} computed by reference`, rv && !rv.err, rv && rv.err)) continue;
      check(`${tag}: ${d.name} dims/shape vs reference`, JSON.stringify(pv.dims) === JSON.stringify(rv.dims)
        && JSON.stringify(pv.shape) === JSON.stringify(rv.shape), [pv.dims, rv.dims, pv.shape, rv.shape]);
      check(`${tag}: ${d.name} values vs reference (rel 1e-9)`, arrClose(pv.data, Array.from(rv.data), 1e-9),
        firstDiff(pv.data, Array.from(rv.data), 1e-9));
      if (rv.units !== null) check(`${tag}: ${d.name} units vs reference`, pv.units === rv.units, [pv.units, rv.units]);
      if (cs.units && d.name in cs.units) check(`${tag}: ${d.name} units '${cs.units[d.name]}'`, pv.units === cs.units[d.name], pv.units);
      else if (rv.units === null) check(`${tag}: ${d.name} has expected units listed in the case`, false);
    }
    for (const [name, want] of Object.entries(cs.expectValues || {})) {
      const pv = pyF[name];
      check(`${tag}: ${name} == ${JSON.stringify(want).slice(0, 60)}`, pv && arrClose(pv.data, want, 1e-12), pv && pv.data);
    }
    for (const [name, want] of Object.entries(cs.dimsOf || {})) {
      const pv = pyF[name];
      check(`${tag}: ${name} dims ${JSON.stringify(want)}`, pv && JSON.stringify(pv.dims) === JSON.stringify(want), pv && pv.dims);
    }
    // (b) derive.js (the web app's engine), on the defs it would load from a
    // project (sanitizeDef migrates legacy windows; null = refused)
    if (!D) continue;
    const ds = await loadDataset(filePath[file]);
    const st = D.registerDerived(ds, jsDefs(fdefs));
    for (const d of fdefs) {
      const s = st.get(d.name), pv = pyF[d.name];
      const expectErr = (cs.derivedErrors || []).includes(d.name);
      if (expectErr) { check(`${tag}: ${d.name} fails in derive.js too`, !s || !s.ok, s); continue; }
      if (!check(`${tag}: ${d.name} ok in derive.js`, s && s.ok, s)) continue;
      const v = ds.vars[d.name];
      check(`${tag}: ${d.name} python vs derive.js dims`, JSON.stringify(v.dims) === JSON.stringify(pv.dims));
      check(`${tag}: ${d.name} python vs derive.js values (rel 1e-9)`, arrClose(pv.data, Array.from(v.data), 1e-9),
        firstDiff(pv.data, Array.from(v.data), 1e-9));
      check(`${tag}: ${d.name} python vs derive.js units`, pv.units === String(v.attrs.units), [pv.units, v.attrs.units]);
    }
  }
}

async function compareLines(tag, cs, cfg, lines, der, filePath) {
  const derivedNames = new Set(cfg.derived.map((d) => d.file + "\u0000" + d.name));
  const usesDerived = (t) => [t.var, t.xsrc.startsWith("var:") ? t.xsrc.slice(4) : "", t.ssrc.startsWith("var:") ? t.ssrc.slice(4) : ""]
    .some((n) => n && derivedNames.has(t.file + "\u0000" + n));
  // file -> Dataset with the derived vars: computed by derive.js when it is
  // usable, else the script's own dumped values (then this checks how the
  // script turns derived variables into lines, not how it computes them)
  const derivedDs = new Map();
  const dsFor = async (t) => {
    if (!filePath[t.file]) return null;
    if (!usesDerived(t)) return plainDs(filePath[t.file]);
    if (!derivedDs.has(t.file)) {
      const ds = await loadDataset(filePath[t.file]);
      if (D) D.registerDerived(ds, jsDefs(cfg.derived.filter((d) => d.file === t.file)));
      else {
        for (const [name, e] of Object.entries(der[t.file] || {})) {
          const v = new Variable(name, { dims: e.dims, shape: e.shape, attrs: { units: e.units }, dtype: "double",
            numeric: true, data: Float64Array.from(e.data, (x) => (x === null ? NaN : x)) });
          v.derived = true;
          ds.vars[name] = v;
        }
      }
      derivedDs.set(t.file, ds);
    }
    return derivedDs.get(t.file);
  };
  let nCompared = 0, nDerived = 0;
  for (const ct of cfg.tabs) {
    const key = String(ct.index);
    const skipped = (cs.skippedTabs || []).includes(ct.index);
    if (skipped) { check(`${tag}: tab ${ct.index} skipped (no lines dumped)`, !(key in lines)); continue; }
    if (!check(`${tag}: tab ${ct.index} lines dumped`, key in lines)) continue;
    const got = new Map(lines[key].map((e) => [e.trace, e.lines]));
    for (let ti = 0; ti < ct.traces.length; ti++) {
      const t = ct.traces[ti];
      if (!t.visible) { check(`${tag}: tab ${ct.index} hidden trace ${ti} not drawn`, !got.has(ti)); continue; }
      const ds = await dsFor(t);
      if (!ds) { if (usesDerived(t)) skip(`${tag}: tab ${ct.index} trace ${ti} (derived) lines`, "derive.js unavailable"); continue; }
      const js = X.traceLines(ds, t, () => {});
      const py = got.get(ti);
      if (!js.lines.length) { check(`${tag}: tab ${ct.index} trace ${ti}: nothing drawn (as in JS)`, !py); continue; }
      if (!check(`${tag}: tab ${ct.index} trace ${ti} drawn`, !!py)) continue;
      const rel = usesDerived(t) ? 1e-9 : 1e-12;
      let ok = py.length === js.lines.length, why = ok ? "" : `line count ${py.length} vs ${js.lines.length}`;
      for (let j = 0; ok && j < py.length; j++) {
        const a = py[j], b = js.lines[j];
        if (!arrClose(a.x, Array.from(b.x), rel)) { ok = false; why = `line ${j} x ${firstDiff(a.x, Array.from(b.x), rel)}`; }
        else if (!arrClose(a.y, Array.from(b.y), rel)) { ok = false; why = `line ${j} y ${firstDiff(a.y, Array.from(b.y), rel)}`; }
        else if (!close(a.sval, b.sval, rel)) { ok = false; why = `line ${j} sval ${a.sval} vs ${b.sval}`; }
      }
      check(`${tag}: tab ${ct.index} trace ${ti} (${t.var}) lines == X.traceLines`, ok, why);
      nCompared++; if (usesDerived(t)) nDerived++;
    }
  }
  console.log(`  ${tag}: compared ${nCompared} trace(s) with X.traceLines (${nDerived} on derived vars)`);
}

// ============================================================ main
console.log(`pyexport tests  (python: ${PYTHON}; derive.js: ${D ? "yes" : "NO"}; temp: ${TMP})`);
jsChecks();
if (!pyAvailable()) {
  skip("all script runs", `no usable Python at '${PYTHON}' (needs numpy xarray matplotlib scipy pypdf); set NCX_PYTHON`);
} else {
  const only = process.env.NCX_CASES ? process.env.NCX_CASES.split(",") : null;   // e.g. NCX_CASES=A,I
  for (const cs of buildCases()) {
    if (only && !only.some((p) => cs.id.startsWith(p))) { skip(cs.id, "not in NCX_CASES"); continue; }
    try { await runCase(cs); }
    catch (e) { check(`${cs.id}: no exception in the test harness`, false, e.stack); }
  }
}
const ok = summary("pyexport");
if (KEEP || !ok) console.log("outputs kept in " + TMP);
else fs.rmSync(TMP, { recursive: true, force: true });
