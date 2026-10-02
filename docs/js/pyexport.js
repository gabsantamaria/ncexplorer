// pyexport.js — builds the standalone "Python report script": a .py file that
// regenerates the plots of all (or selected) tabs of a project as ONE
// multi-page VECTOR PDF (matplotlib PdfPages, one page per tab), including the
// derived quantities the tabs need. Pure module (no DOM): runs in the browser
// and in Node.
//
//   buildReportScript(project, opts) -> the full text of the .py file
//   reportFileName(stamp)            -> "ncx_report_<stamp>.py"
//   neededDerived(project, tabIdx)   -> canonical derived defs the tabs need (transitively)
//   exprRefs(text)                   -> names an expression mentions (tolerant scan)
//   migrateWindow(w)                 -> a reduce window in the expression format
//                                       (legacy "fixed"/"relative" windows converted)
//
// Window bounds and "formula" defs are EXPRESSIONS (SPEC_EXPR E1); the Python
// script carries its own parser/evaluator (section 1e of the template), so this
// module only needs the names an expression refers to (for the dependencies).
//
// The Python side is ONE readable template (PY_TEMPLATE below, a String.raw
// literal so backslashes reach Python untouched; it must never contain a
// backtick or a dollar sign directly followed by an opening brace). Its
// placeholders __NCX_*__ are filled with Python LITERALS produced by pyLiteral()
// (True/False/None, float("nan"), JSON-compatible string escapes), so any
// label, tab name or file name — quotes, backslashes, triple quotes, unicode —
// yields valid Python.

import { DEFAULT_PLOTCFG } from "./explore.js";
import { CMAP_NAMES, cmapColor } from "./colormaps.js";

export const REPORT_PDF_DEFAULT = "ncx_report.pdf";

// ---------------------------------------------------------------- public API

export function reportFileName(stamp) {
  const s = String(stamp == null ? "" : stamp).replace(/[^A-Za-z0-9_-]+/g, "");
  return s ? `ncx_report_${s}.py` : "ncx_report.py";
}

// The derived defs the selected tabs need: every def referenced by a trace's
// variable, x source (var:) or sweep-value source (var:), plus — transitively —
// the defs those depend on (src / a / b / x source / names used in the window
// expressions or the formula). Returned canonical (see reportDef), in project order.
export function neededDerived(project, tabIdx) {
  const defs = projectDefs(project).map(reportDef).filter(Boolean);
  const tabs = projectTabs(project);
  const sel = selectTabs(tabs.length, tabIdx);
  const key = (file, name) => baseName(file).toLowerCase() + "\u0000" + name;
  const byKey = new Map();
  for (const d of defs) { const k = key(d.file, d.name); if (!byKey.has(k)) byKey.set(k, d); }
  const want = new Set(), stack = [];
  const visit = (file, name) => {
    if (!name) return;
    const k = key(file, name);
    if (!byKey.has(k) || want.has(k)) return;
    want.add(k);
    stack.push(byKey.get(k));
  };
  for (const i of sel) {
    const tr = Array.isArray(tabs[i].traces) ? tabs[i].traces : [];
    for (const t of tr) {
      if (!t || typeof t !== "object") continue;
      visit(t.file, typeof t.var === "string" ? t.var : "");
      visit(t.file, varRef(t.xsrc));
      visit(t.file, varRef(t.ssrc));
    }
  }
  while (stack.length) {
    const d = stack.pop();
    for (const dep of defDeps(d)) visit(d.file, dep);
  }
  return defs.filter((d) => { const k = key(d.file, d.name); return want.has(k) && byKey.get(k) === d; });
}

// Names an expression mentions, first appearance first: identifiers and
// "quoted names", minus numbers (incl. SI suffix) and function-call names (an
// identifier followed by "("). A tolerant scan, not a parse — a half-typed or
// invalid expression still yields its names, which is all the dependency
// order needs. The Python script's expr_refs() is the same scan.
// (In a quoted name a '"' directly followed by a letter, digit or _ belongs to
// the name, as in expr.js.)
const REF_TOKEN = /"((?:[^"]|"(?=[A-Za-z0-9_]))*)"?|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[pnumkKMGT\u00b5\u03bc]?|([A-Za-z_][A-Za-z0-9_]*)([ \t\r\n]*\()?/g;
export function exprRefs(text) {
  const out = [];
  if (typeof text !== "string") return out;
  for (const m of text.matchAll(REF_TOKEN)) {
    const n = m[1] !== undefined ? m[1] : (m[2] !== undefined && m[3] === undefined ? m[2] : "");
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

// ---- reduce windows (SPEC_EXPR E2/E3) --------------------------------------
const WINDOW_FIELDS = ["lo", "hi", "lo2", "hi2", "center", "halfwidth", "halfwidth2"];
const EXPR_FUNCTIONS = ["abs", "sqrt", "exp", "ln", "log", "log10", "floor", "ceil", "round",
  "db2lin", "lin2db", "pow", "min", "max"];
const MAX_WINDOW_EXPR = 320, MAX_FORMULA_EXPR = 1000;     // = derive.js EXPR_MAX / FORMULA_MAX
const isFiniteNum = (v) => typeof v === "number" && Number.isFinite(v);
const num = (x) => String(x);           // shortest round-trip text: 1000000, 0.02, 1e-7, 1e+21
// a name as written in an expression: quoted unless a plain identifier that is
// not a function name / pi
function quoteName(n) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(n) && !EXPR_FUNCTIONS.includes(n) && n !== "pi" ? n : `"${n}"`;
}
// an expression field: strings (capped) as they are, finite numbers -> num(x), else ""
const exprField = (v, max = MAX_WINDOW_EXPR) => (typeof v === "string" ? v.slice(0, max) : isFiniteNum(v) ? num(v) : "");

// A window in the expression format {mode, lo, hi, lo2, hi2, center, halfwidth,
// halfwidth2} (all strings). Windows saved before expressions existed are
// converted so they compute exactly the same numbers: mode "fixed" -> "range"
// (numbers -> their text), "relative" -> "center" with center
// "k*name + offset" (k = 1 and offset = 0 left out), half widths |hw|; in an
// old window only numbers count (anything else -> ""). Which windows are old:
// the rule of derive.js (isLegacyWindow) — mode fixed / relative; or mode
// none / missing with a k or offset key, a number in a field, or a
// "coord:"/"var:" center and no other expression text. A "range" / "center"
// window is never converted ("var:x" stays as typed and is an error there too).
// Unknown modes are kept (the script reports them).
export function migrateWindow(raw) {
  const w = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const get = (k) => (own(w, k) ? w[k] : undefined);
  const rawMode = get("mode");
  const center = get("center");
  let legacy = rawMode === "fixed" || rawMode === "relative";
  if (!legacy && rawMode !== "range" && rawMode !== "center") {
    legacy = own(w, "k") || own(w, "offset") || WINDOW_FIELDS.some((k) => typeof get(k) === "number")
      || (typeof center === "string" && /^(coord|var):/.test(center)
        && WINDOW_FIELDS.every((k) => k === "center" || typeof get(k) !== "string" || get(k) === ""));
  }
  const mode = str(rawMode, "none") || "none";
  const out = { mode, lo: "", hi: "", lo2: "", hi2: "", center: "", halfwidth: "", halfwidth2: "" };
  if (!legacy) {
    for (const k of WINDOW_FIELDS) out[k] = exprField(get(k));
    return out;
  }
  const fin = (v) => (isFiniteNum(v) ? num(v) : "");
  if (mode === "fixed") {
    out.mode = "range";
    for (const k of ["lo", "hi", "lo2", "hi2"]) out[k] = fin(get(k));
  } else if (mode === "relative") {
    out.mode = "center";
    const m = typeof center === "string" ? /^(coord|var):/.exec(center) : null;
    const name = m ? center.slice(m[0].length, m[0].length + 256) : "";     // bc9812f's name cap
    if (name) {
      const k = isFiniteNum(get("k")) ? get("k") : 1, off = isFiniteNum(get("offset")) ? get("offset") : 0;
      const q = quoteName(name);
      // never cut: at most 311 characters (< MAX_WINDOW_EXPR)
      out.center = (k === 1 ? q : `${num(k)}*${q}`)
        + (off === 0 ? "" : off < 0 ? ` - ${num(-off)}` : ` + ${num(off)}`);
    }
    for (const k of ["halfwidth", "halfwidth2"]) out[k] = isFiniteNum(get(k)) ? num(Math.abs(get(k))) : "";
  }
  return out;          // "none" (and unknown modes): every field ""
}

// opts = { tabs: [indices into project.tabs] (default all), pdfName, generatedAt, source }
export function buildReportScript(project, opts = {}) {
  const allTabs = projectTabs(project);
  const sel = selectTabs(allTabs.length, opts.tabs);
  if (!sel.length) throw new Error("buildReportScript: no tab selected");
  const tabs = sel.map((i) => cfgTab(allTabs[i], i));
  const derived = neededDerived(project, sel);

  // one spelling per file (names are matched ignoring case, like the app does)
  const spelling = new Map();
  const canon = (f) => {
    if (!f) return f;
    const k = f.toLowerCase();
    if (!spelling.has(k)) spelling.set(k, f);
    return spelling.get(k);
  };
  for (const tb of tabs) for (const t of tb.traces) t.file = canon(t.file);
  for (const d of derived) d.file = canon(d.file);

  // every data file the selected tabs (and their derived defs) reference,
  // keyed by basename; default location = that basename inside DATA_DIR
  const files = Object.create(null);
  for (const tb of tabs) for (const t of tb.traces) if (t.file) files[t.file] = t.file;
  for (const d of derived) if (d.file) files[d.file] = d.file;

  const generatedAt = String(opts.generatedAt || new Date().toISOString());
  const source = String(opts.source == null ? "" : opts.source);
  const pdfName = pdfFileName(opts.pdfName);

  const config = {
    generated_at: generatedAt,
    source,
    pdf_name: pdfName,
    files: new PyExpr("FILES"),
    derived,
    tabs,
  };

  // header docstring summary (docstring-safe text only)
  const info = [
    `Generated : ${docSafe(generatedAt)} by NC Explorer`,
    `Project   : ${docSafe(source) || "(unnamed)"}`,
    `Data files: ${Object.keys(files).map(docSafe).join(", ") || "(none)"}`,
    `Pages     : ${tabs.length} (one per tab)`,
    ...tabs.map((tb, k) => `    ${k + 1}. ${docSafe(tb.name)}`
      + (tb.index !== k ? `   (tab ${tb.index + 1} in the app)` : "")),
  ].join("\n");

  return fill(PY_TEMPLATE, {
    __NCX_INFO__: info,
    __NCX_COLORMAPS__: colormapsLiteral(),
    __NCX_FILES__: "FILES = " + pyLiteral({ ...files }, 0, "FILES = ".length),
    __NCX_CONFIG__: "CONFIG = " + pyLiteral(config, 0, "CONFIG = ".length),
  });
}

// ---------------------------------------------------------------- Python literals

// a raw Python expression emitted verbatim by pyLiteral (e.g. the name FILES)
export class PyExpr { constructor(code) { this.code = String(code); } }

// characters escaped as \uXXXX even though they are legal inside a Python
// string: DEL/C1 controls, soft hyphen, zero-width + bidi controls, line/para
// separators, BOM — so the file never contains invisible or line-breaking text
const PY_ESCAPE = /[\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/g;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

// a Python str literal. JSON string escapes (\" \\ \n \t \uXXXX ...) are all
// valid Python escapes, so JSON.stringify does the heavy lifting.
export function pyStr(s) {
  const t = String(s).replace(LONE_SURROGATE, "\ufffd");
  return JSON.stringify(t).replace(PY_ESCAPE,
    (ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"));
}

function pyNum(n) {
  if (Number.isNaN(n)) return 'float("nan")';
  if (n === Infinity) return 'float("inf")';
  if (n === -Infinity) return '-float("inf")';
  if (Object.is(n, -0)) return "-0.0";
  return String(n);          // 3, 1.5, 1e-7, 1e+21 are all valid Python literals
}

function isSeq(v) { return Array.isArray(v) || (ArrayBuffer.isView(v) && !(v instanceof DataView)); }
function isMap(v) { return v !== null && typeof v === "object" && !isSeq(v) && !(v instanceof PyExpr); }

function pyInline(v) {
  if (v instanceof PyExpr) return v.code;
  if (v === null || v === undefined || typeof v === "function" || typeof v === "symbol") return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return pyNum(v);
  if (typeof v === "bigint") return String(v);
  if (typeof v === "string") return pyStr(v);
  if (isSeq(v)) return "[" + Array.from(v, pyInline).join(", ") + "]";
  if (typeof v === "object") return "{" + Object.keys(v).map((k) => pyStr(k) + ": " + pyInline(v[k])).join(", ") + "}";
  return pyStr(String(v));
}

const PY_WIDTH = 92;
// pretty-printed Python literal: containers that do not fit on one line are
// broken one item per line (with trailing commas). `indent` = current indent,
// `prefix` = characters already on the line before the value.
export function pyLiteral(v, indent = 0, prefix = 0) {
  const inl = pyInline(v);
  const empty = isSeq(v) ? v.length === 0 : (isMap(v) ? Object.keys(v).length === 0 : true);
  if (empty || indent + prefix + inl.length + 1 <= PY_WIDTH) return inl;
  const pad = " ".repeat(indent + 4), end = " ".repeat(indent);
  if (isSeq(v))
    return "[\n" + Array.from(v, (x) => pad + pyLiteral(x, indent + 4, 0) + ",").join("\n") + "\n" + end + "]";
  return "{\n" + Object.keys(v).map((k) => {
    const kp = pyStr(k) + ": ";
    return pad + kp + pyLiteral(v[k], indent + 4, kp.length) + ",";
  }).join("\n") + "\n" + end + "}";
}

// text that is safe inside the (non-raw) triple-quoted header docstring
function docSafe(s) {
  return String(s == null ? "" : s)
    .replace(LONE_SURROGATE, "\ufffd")
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\ufeff]/g, " ")
    .replace(PY_ESCAPE, " ")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .trim();
}

function fill(template, values) {
  let out = template;
  // split/join, NOT String.replace: replacement text may contain "$&" etc.
  for (const [k, v] of Object.entries(values)) out = out.split(k).join(v);
  return out;
}

function colormapsLiteral() {
  // the 5 stops of every app colormap, sampled from colormaps.js itself so the
  // script can never drift from the web app (cmapColor is exact at the stops)
  const rows = CMAP_NAMES.map((name) => {
    const stops = [0, 1, 2, 3, 4].map((i) => cmapColor(name, i / 4).match(/\d+/g).map(Number));
    return `    ${pyStr(name)}: [${stops.map((s) => `(${s.join(", ")})`).join(", ")}],`;
  });
  return "{\n" + rows.join("\n") + "\n}";
}

// ---------------------------------------------------------------- project -> CONFIG

const BAD_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const LIMIT_KEYS = ["xmin", "xmax", "ymin", "ymax", "ymin2", "ymax2"];
const DRAW_MODES = ["lines", "markers", "lines+markers"];
const DASHES = ["auto", "solid", "dash", "dot", "dashdot"];
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function baseName(p) { return String(p == null ? "" : p).replace(/\\/g, "/").split("/").pop(); }
function varRef(src) { return (typeof src === "string" && src.startsWith("var:")) ? src.slice(4) : ""; }
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
function finiteOr(v, d) { return (typeof v === "number" && Number.isFinite(v)) ? v : d; }

function pdfFileName(name) {
  let s = baseName(name).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!s) return REPORT_PDF_DEFAULT;
  if (!/\.pdf$/i.test(s)) s += ".pdf";
  return s;
}

function projectTabs(project) {
  const p = project && typeof project === "object" ? project : {};
  if (Array.isArray(p.tabs) && p.tabs.length) return p.tabs.map((t) => (t && typeof t === "object") ? t : {});
  // v1 / desktop project: a single plot at the top level
  return [{ name: "Plot 1", plot: p.plot, traces: p.traces, markers: p.markers }];
}

function projectDefs(project) {
  const d = project && Array.isArray(project.derived) ? project.derived : [];
  return d.filter((x) => x && typeof x === "object" && typeof x.name === "string" && x.name
    && ["reduce", "combine", "transform", "formula"].includes(x.kind));
}

// sorted, de-duplicated valid indices; anything but an array -> all tabs
function selectTabs(n, idx) {
  if (!Array.isArray(idx)) return Array.from({ length: n }, (_, i) => i);
  const set = new Set();
  for (const v of idx) { const i = Number(v); if (Number.isInteger(i) && i >= 0 && i < n) set.add(i); }
  return [...set].sort((a, b) => a - b);
}

function tabName(v, i) { return String(v == null ? "" : v).trim().slice(0, 80) || `Plot ${i + 1}`; }

// cosmetics: DEFAULT_PLOTCFG + known keys of the right type (as project.js's
// sanitizePlot), figure size clamped to 2..40 in, colormap name canonicalized,
// and the axis-limit STRINGS parsed exactly like the app (parseFloat; "" -> None)
function cfgPlot(raw) {
  const p = { ...DEFAULT_PLOTCFG };
  const src = raw && typeof raw === "object" ? raw : {};
  for (const k of Object.keys(src)) {
    if (BAD_KEYS.has(k) || !own(DEFAULT_PLOTCFG, k)) continue;
    const v = src[k];
    if (LIMIT_KEYS.includes(k)) { if (typeof v === "string" || typeof v === "number") p[k] = v; continue; }
    if (typeof v === typeof DEFAULT_PLOTCFG[k]) p[k] = v;
  }
  p.figw = clamp(finiteOr(p.figw, 8), 2, 40);
  p.figh = clamp(finiteOr(p.figh, 5.2), 2, 40);
  p.cmap = CMAP_NAMES.find((n) => n.toLowerCase() === String(p.cmap).toLowerCase()) || DEFAULT_PLOTCFG.cmap;
  for (const k of LIMIT_KEYS) {
    if (!own(p, k)) continue;
    const n = parseFloat(p[k]);
    p[k] = Number.isFinite(n) ? n : null;
  }
  return p;
}

// one trace with every field present, in the canonical order; missing/invalid
// fields get the app's defaults (makeTrace / buildTabFromParsed)
function cfgTrace(raw) {
  const t = raw && typeof raw === "object" ? raw : {};
  const varName = String(t.var == null ? "" : t.var);
  const slices = {};
  if (t.slices && typeof t.slices === "object")
    for (const k of Object.keys(t.slices)) { if (!BAD_KEYS.has(k)) slices[k] = Math.max(0, t.slices[k] | 0); }
  return {
    file: baseName(t.file),
    var: varName,
    line_dim: String(t.line_dim == null ? "" : t.line_dim),
    sweep: String(t.sweep || ""),
    slices,
    xsrc: String(t.xsrc || "index"),
    label: String(t.label || varName),
    sweep_label: String(t.sweep_label || ""),
    ssrc: String(t.ssrc || "coord"),
    yaxis: t.yaxis === "right" ? "right" : "left",
    visible: t.visible !== false,
    color: (typeof t.color === "string" && /^#[0-9a-fA-F]{6}$/.test(t.color)) ? t.color : "",
    draw: DRAW_MODES.includes(t.draw) ? t.draw : "lines",
    lw: clamp(finiteOr(t.lw, 1.5), 0.25, 10),
    dash: DASHES.includes(t.dash) ? t.dash : "auto",
  };
}

function cfgTab(raw, i) {
  const traces = (Array.isArray(raw.traces) ? raw.traces : []).map(cfgTrace);
  const markers = (Array.isArray(raw.markers) ? raw.markers : [])
    .filter((m) => m && typeof m === "object")
    .map((m) => ({ trace: m.trace | 0, line: Math.max(0, m.line | 0), idx: Math.max(0, m.idx | 0) }))
    .filter((m) => m.trace >= 0 && m.trace < traces.length);
  return { index: i, name: tabName(raw.name, i), plot: cfgPlot(raw.plot || raw.plotcfg), traces, markers };
}

// the window fields a reduce actually uses (as derive.js): the inner window
// always (mode != none), the outer span only for region "outside_within"
function neededWindowFields(mode, region) {
  const inner = { range: ["lo", "hi"], center: ["center", "halfwidth"] }[mode];
  if (!inner) return [];
  return region === "outside_within" ? inner.concat(mode === "range" ? ["lo2", "hi2"] : ["halfwidth2"]) : inner;
}

// var names a canonical (reportDef) def reads — other defs of the same file may
// be among them. Only the window fields in use count (like derive.js's depsOf).
function defDeps(d) {
  const out = [];
  const add = (n) => { if (typeof n === "string" && n && !out.includes(n)) out.push(n); };
  if (d.kind === "reduce") {
    add(d.src);
    add(varRef(d.xsrc));
    for (const k of neededWindowFields(d.window.mode, d.region)) exprRefs(d.window[k]).forEach(add);
  } else if (d.kind === "combine") {
    add(d.a);
    if (typeof d.b === "string") add(d.b);
  } else if (d.kind === "transform") add(d.src);
  else if (d.kind === "formula") exprRefs(d.expr).forEach(add);
  return out;
}

// canonical key order (SPEC.md §1.1 + SPEC_EXPR E2); missing fields ->
// defaults; legacy windows migrated. Values of the wrong kind for an enumerated
// field are kept verbatim so the script reports a clear error for that def
// instead of silently changing its meaning.
const str = (v, d = "") => (v == null ? d : String(v));
function reportDef(d) {
  if (!d || typeof d !== "object") return null;
  const head = { name: str(d.name), file: baseName(d.file), kind: d.kind, units: str(d.units), description: str(d.description) };
  if (d.kind === "reduce") {
    return {
      ...head, src: str(d.src), over: str(d.over), xsrc: str(d.xsrc, "index") || "index",
      window: migrateWindow(d.window),
      region: str(d.region, "inside") || "inside", stat: str(d.stat, "max") || "max", db: str(d.db, "auto") || "auto",
    };
  }
  if (d.kind === "formula") return { ...head, expr: exprField(d.expr, MAX_FORMULA_EXPR) };
  if (d.kind === "combine") {
    const b = typeof d.b === "number" ? d.b : str(d.b);
    return { ...head, a: str(d.a), op: str(d.op, "-") || "-", b };
  }
  if (d.kind === "transform")
    return { ...head, src: str(d.src), fn: str(d.fn, "db2lin") || "db2lin", scale: finiteOr(d.scale, 1), offset: finiteOr(d.offset, 0) };
  return null;
}

// =====================================================================
// The Python template. Placeholders: __NCX_INFO__, __NCX_COLORMAPS__,
// __NCX_FILES__, __NCX_CONFIG__.
// =====================================================================
const PY_TEMPLATE = String.raw`#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
NC Explorer report script
=========================

Regenerates the plots of an NC Explorer project (https://nc.mwphotonics.com)
as ONE multi-page vector PDF, one page per tab, including the derived
quantities (peak in a window, noise floor outside it, SNR, ...) the plots use.
It is meant as a starting point: edit it freely.

__NCX_INFO__

How to run
----------
    python <this file>                         # data files next to this script
    python <this file> --data-dir /path/to/data --out report.pdf
    python <this file> --png --dpi 300         # also one PNG per page

    --data-dir DIR        folder with the data files (default: this script's folder)
    --out FILE            output PDF (default: CONFIG["pdf_name"] next to this script)
    --png, --svg          also save every page as a PNG / SVG file next to the PDF
    --dpi N               resolution of the PNG pages (default 200; the PDF is vector)
    --dump-derived FILE   save every computed derived variable to a JSON file
    --dump-lines FILE     save the raw x/y values of every plotted line to a JSON file

Data files are looked up in the data folder by name (exact name first, then
ignoring upper/lower case). To use a file from somewhere else, edit FILES in
the CONFIG section (relative paths are relative to the data folder; absolute
paths work too). A page whose traces need a file that cannot be found is
skipped with a warning; the other pages are still written.

Requirements
------------
Python >= 3.8 with numpy, xarray and matplotlib, plus the reader xarray needs
for your files: scipy for NetCDF-3 ("classic") files, h5netcdf or netCDF4 for
NetCDF-4/HDF5 files.
    pip install numpy xarray matplotlib scipy h5netcdf

Layout of this file
-------------------
1. HELPERS: look & feel, reading data, derived quantities, turning a trace into
   lines, drawing one page. They reproduce what the web app does.
2. CONFIG: YOUR plots: data files, derived-quantity definitions and one entry
   per tab (cosmetics, traces, markers). Edit freely.
3. main(): command-line options and the page loop.
"""

import argparse
import json
import math
import os
import re
import sys
import traceback
from decimal import Decimal, ROUND_HALF_UP

import numpy as np

import matplotlib
matplotlib.use("Agg")  # draw to files only (no window)
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib import font_manager, ticker  # noqa: E402
from matplotlib.backends.backend_pdf import PdfPages  # noqa: E402
from matplotlib.cm import ScalarMappable  # noqa: E402
from matplotlib.colors import LinearSegmentedColormap, Normalize  # noqa: E402

try:
    import xarray as xr
except ImportError:  # pragma: no cover
    sys.exit("This script needs xarray:  pip install xarray scipy h5netcdf")


# =============================================================================
# 1. HELPERS
# =============================================================================

# ---- 1a. Look & feel ---------------------------------------------------------
# Sizes in the web app are CSS pixels (96 per inch); matplotlib works in points
# (72 per inch), so 1 px = 0.75 pt.
PX = 0.75

FIGSIZE_DEFAULT = (8.0, 5.2)  # inches, for tabs whose plot size is not locked
SHOW_PAGE_FOOTER = True       # small grey "tab name - page n/N" on PDF pages
ALLOW_MATHTEXT = False        # True: "$...$" in labels is rendered as math


def _font_family():
    """Arial/Helvetica when installed (closest to the web app), then DejaVu Sans,
    then any installed CJK-capable font: matplotlib >= 3.6 takes each missing
    character from the next font in this list."""
    have = set(f.name for f in font_manager.fontManager.ttflist)
    main = [f for f in ("Arial", "Helvetica", "Liberation Sans", "Nimbus Sans") if f in have]
    extra = [f for f in ("Noto Sans CJK JP", "Noto Sans CJK SC", "Microsoft YaHei", "Yu Gothic",
                         "MS Gothic", "Arial Unicode MS", "Segoe UI Symbol") if f in have]
    return main + ["DejaVu Sans"] + extra


STYLE = {
    "font.family": _font_family(),
    "font.size": 12 * PX,
    "axes.titlesize": 15 * PX,
    "axes.labelsize": 14 * PX,
    "xtick.labelsize": 12 * PX,
    "ytick.labelsize": 12 * PX,
    "legend.fontsize": 11 * PX,
    "text.color": "#222222",
    "axes.labelcolor": "#222222",
    "axes.edgecolor": "#2a2a2a",          # full box frame, like the app
    "axes.linewidth": 1.2 * PX,
    "axes.facecolor": "white",
    "axes.formatter.useoffset": False,    # show 1550.2, not 0.2 + 1.55e3
    "axes.formatter.use_mathtext": True,  # exponents as x10^9
    "xtick.direction": "out",
    "ytick.direction": "out",
    "xtick.major.size": 5 * PX,
    "ytick.major.size": 5 * PX,
    "xtick.major.width": 1 * PX,
    "ytick.major.width": 1 * PX,
    "xtick.color": "#2a2a2a",
    "ytick.color": "#2a2a2a",
    "grid.color": "#e3e3e3",
    "grid.linewidth": 1 * PX,
    "legend.frameon": True,
    "legend.framealpha": 0.7,             # semi-transparent white legend box
    "legend.facecolor": "white",
    "legend.edgecolor": "#cccccc",
    "legend.fancybox": False,
    "figure.facecolor": "white",
    "savefig.facecolor": "white",
    "pdf.fonttype": 42,                   # embed TrueType: text stays editable
    "svg.fonttype": "none",
}

# ---- 1b. Behavior shared with the web app -------------------------------------
MAX_SWEEP_LINES = 200   # larger sweep families are evenly subsampled to this many lines
LEGEND_MAX_LINES = 12   # a sweep family with more lines gets no legend entries
# color of trace i (when it has no color of its own) = CYCLE[i % 8]
CYCLE = ["#1565c0", "#c0392b", "#0d6b3f", "#7d3cff", "#e6a700", "#00838f", "#ad1457", "#4e342e"]
# SI prefixes for axis / colorbar scaling (values are DIVIDED by the factor)
PREFIX_FACTOR = {"": 1.0, "k": 1e3, "M": 1e6, "G": 1e9, "T": 1e12,
                 "m": 1e-3, "\u00b5": 1e-6, "n": 1e-9, "p": 1e-12}
DASHES = {"solid": "-", "dash": "--", "dot": ":", "dashdot": "-."}
LEGEND_LOCS = ("best", "upper right", "upper left", "lower right", "lower left",
               "upper center", "lower center", "center left", "center right", "center")
MARKER_COLOR = "#c0392b"

# The colormaps: 5 RGB stops each, identical to the web app (docs/js/colormaps.js)
COLORMAPS = __NCX_COLORMAPS__


# ---- 1c. Small formatting helpers ---------------------------------------------
def _js_round(x):
    """JavaScript's Math.round: halves round up (Python's round() goes to even)."""
    return int(math.floor(x + 0.5))


def _round_sig(x, digits):
    """x rounded to 'digits' significant digits, ties away from zero (the rule of
    JavaScript's toPrecision/toExponential). Returns (Decimal, decimal exponent)."""
    d = Decimal(x)
    e = d.adjusted()
    r = d.quantize(Decimal(1).scaleb(e - digits + 1), rounding=ROUND_HALF_UP)
    if r != 0 and r.adjusted() > e:  # 9.99999 -> 10.0000
        e += 1
        r = d.quantize(Decimal(1).scaleb(e - digits + 1), rounding=ROUND_HALF_UP)
    return r, e


def fmt6(x):
    """Numbers in legends, markers and sweep labels: 6 significant digits,
    exponent form below 1e-4 / from 1e6 on (exactly like the web app)."""
    x = float(x)
    if math.isnan(x):
        return "NaN"
    if math.isinf(x):
        return "Infinity" if x > 0 else "-Infinity"
    a = abs(x)
    if a == 0:
        return "0"
    if a < 1e-4 or a >= 1e6:
        r, e = _round_sig(x, 5)
        return "%se%s%d" % (format(r.scaleb(-e), "f"), "+" if e >= 0 else "-", abs(e))
    s = repr(float(_round_sig(x, 6)[0]))
    return s[:-2] if s.endswith(".0") else s


def scaled_label(base, prefix):
    """Fold an SI prefix into a label: 'f (Hz)' + 'G' -> 'f (GHz)';
    a label without a unit gets ' (x1e9)'."""
    if not prefix:
        return base
    factor = PREFIX_FACTOR.get(prefix)
    exp = str(_js_round(math.log10(factor))) if factor else "NaN"
    if base.endswith(")") and "(" in base:
        i = base.rfind("(")
        return base[:i] + "(" + prefix + base[i + 1:]
    return "%s (\u00d71e%s)" % (base, exp) if base else "\u00d71e%s" % exp


def tex_safe(s):
    """Text shown verbatim: escape '$' so matplotlib does not render it as math."""
    s = "" if s is None else str(s)
    return s if ALLOW_MATHTEXT else s.replace("$", r"\$")


# the characters JavaScript's trim() removes (the web app trims units with it;
# Python's strip() would also remove \x1c-\x1f and \x85 but keep the BOM)
_JS_SPACE = (" \t\n\x0b\x0c\r\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006"
             "\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff")


def js_trim(s):
    """s without leading/trailing white space, exactly like the web app."""
    return (s or "").strip(_JS_SPACE)


def is_db(units):
    """dB-like units (dB, dBm, DBM, dBc ...): averaged in linear power."""
    return "db" in js_trim(units).lower()


_TIME_UNITS = ((r"^nanoseconds\b|\bns\b", 1e-9), (r"^microseconds\b", 1e-6),
               (r"^milliseconds\b", 1e-3), (r"^minutes\b", 60.0),
               (r"^hours\b", 3600.0), (r"^days\b", 86400.0))


def time_scale(units):
    """Factor that converts time-like units to SECONDS (1.0 for anything else)."""
    u = js_trim(units).lower()
    for pattern, factor in _TIME_UNITS:
        if re.search(pattern, u, re.ASCII):
            return factor
    return 1.0


def as_float(values, units):
    """Values as float64; time-like units (ns, ms, minutes, hours, days ...) are
    converted to seconds, like the app does for x, sweep and window values."""
    return np.asarray(values, dtype=float) * time_scale(units)


def _json_list(a):
    """Array -> flat JSON-ready list (NaN/Inf -> None)."""
    return [v if math.isfinite(v) else None for v in np.asarray(a, dtype=float).ravel().tolist()]


# ---- 1d. Reading the data files ------------------------------------------------
class Var(object):
    """One variable: dimension names, float64 data (NaN where missing), units."""

    def __init__(self, name, dims, data, units="", numeric=True, derived=False):
        self.name = name
        self.dims = tuple(dims)
        self.data = data          # numpy float64 array, or None if not numeric
        self.units = units
        self.numeric = numeric
        self.derived = derived


def _attr_str(value):
    if value is None:
        return ""
    if isinstance(value, bytes):
        value = value.decode("utf-8", "replace")
    return js_trim(str(value))     # e.g. units 'DBM\n' -> 'DBM'


def open_netcdf(path):
    """Open a NetCDF file with xarray: fill values -> NaN and packed data
    unpacked (CF mask_and_scale on), times NOT decoded (kept as numbers), char
    arrays NOT joined into strings (so a dimension used only by them, e.g.
    'nchar', stays a dimension as in the app). Tries the available readers in
    turn, and simpler options for very old xarray versions."""
    problems = []
    for extra in ({}, {"engine": "h5netcdf"}, {"engine": "netcdf4"}, {"engine": "scipy"}):
        last = None
        for opts in ({"decode_timedelta": False, "concat_characters": False},
                     {"decode_timedelta": False}, {}):
            kw = dict(decode_times=False, **opts)
            kw.update(extra)
            try:
                return xr.open_dataset(path, **kw)
            except Exception as e:
                last = e
        problems.append("%s: %s" % (extra.get("engine", "auto"), last))
    raise IOError("cannot open %s (%s). NetCDF-3 files need scipy, NetCDF-4/HDF5 files "
                  "need h5netcdf or netCDF4." % (path, "; ".join(problems)))


def _is_netcdf3(path):
    try:
        with open(path, "rb") as fh:
            return fh.read(3) == b"CDF"
    except OSError:
        return False


def _utf8_name(s):
    """NetCDF-3 names are UTF-8 (netCDF-C and the web app read them so), but
    scipy's reader decodes them as latin-1: 'pwr \u00c2\u00b5W' -> 'pwr \u00b5W'."""
    try:
        return s.encode("latin-1").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return s


def _near_fill(data, v):
    """The web app also treats values within 1e-5 (relative) of a HUGE fill value
    (|fill| > 1e30, e.g. 9.96921e36) as missing; xarray masks exact matches only.
    (Packed variables: exact matches only.)"""
    enc = getattr(v, "encoding", None) or {}
    if "scale_factor" in enc or "add_offset" in enc:
        return data
    fills = []
    for src in (enc, v.attrs):
        for key in ("_FillValue", "missing_value"):
            if key in src:
                for x in np.ravel(np.asarray(src[key])).tolist():
                    try:
                        x = float(x)
                    except (TypeError, ValueError):
                        continue
                    if math.isfinite(x) and abs(x) > 1e30:
                        fills.append(x)
    if not fills:
        return data
    with np.errstate(all="ignore"):
        bad = np.zeros(data.shape, dtype=bool)
        for fv in fills:
            bad |= np.abs(data - fv) <= abs(fv) * 1e-5
    return np.where(bad, np.nan, data) if bad.any() else data


class DataFile(object):
    """An opened data file. var(name) returns a Var (real variables are read on
    first use); derived variables are added with add_derived(). Names are the
    ones the app shows (UTF-8 decoded)."""

    def __init__(self, name, path):
        self.name = name
        self.path = path
        self.ds = open_netcdf(path)
        fix = _utf8_name if _is_netcdf3(path) else str
        sizes = getattr(self.ds, "sizes", None) or self.ds.dims
        self._dim_names = dict((str(k), fix(str(k))) for k in sizes)
        self.sizes = dict((fix(str(k)), int(v)) for k, v in sizes.items())
        self._names = dict((fix(str(k)), k) for k in self.ds.variables)   # shown name -> xarray's
        self._vars = {}

    def var(self, name):
        if name in self._vars:
            return self._vars[name]
        if not isinstance(name, str) or name not in self._names:
            return None
        v = self.ds.variables[self._names[name]]
        numeric = v.dtype.kind in "biuf"
        data = _near_fill(np.asarray(v.values, dtype=float), v) if numeric else None
        self._vars[name] = Var(name, [self._dim_names.get(str(d), str(d)) for d in v.dims], data,
                               _attr_str(v.attrs.get("units")), numeric)
        return self._vars[name]

    def is_real(self, name):
        return name in self._names

    def add_derived(self, var):
        self._vars[var.name] = var

    def size(self, dim):
        return self.sizes.get(dim, 0)

    def close(self):
        try:
            self.ds.close()
        except Exception:
            pass


def find_data_file(name, data_dir):
    """Path of data file 'name': FILES[name] (absolute, or relative to data_dir),
    else data_dir/name; exact spelling first, then ignoring case. None if absent."""
    entry = os.path.expanduser(str(FILES.get(name, name)))
    candidates = [entry if os.path.isabs(entry) else os.path.join(data_dir, entry),
                  os.path.join(data_dir, os.path.basename(name))]
    for c in candidates:
        if os.path.isfile(c):
            return c
    for c in candidates:
        folder, base = os.path.split(c)
        try:
            entries = os.listdir(folder or ".")
        except OSError:
            continue
        for e in entries:
            if e.lower() == base.lower() and os.path.isfile(os.path.join(folder, e)):
                return os.path.join(folder, e)
    return None


def _align(var, dims):
    """var.data reshaped to broadcast against an array with dimensions 'dims'
    (var's own dims must be a subset of 'dims'): broadcasting BY NAME."""
    order = [var.dims.index(d) for d in dims if d in var.dims]
    arr = np.transpose(var.data, order) if len(order) > 1 else var.data
    shape = [var.data.shape[var.dims.index(d)] if d in var.dims else 1 for d in dims]
    return np.reshape(arr, shape)


def _along(values, dim, dims, shape):
    """A 1-D array along 'dim', broadcast to an array with dimensions 'dims'."""
    sh = [len(values) if d == dim else 1 for d in dims]
    return np.broadcast_to(np.reshape(values, sh), shape)


# ---- 1e. Expressions ----------------------------------------------------------------
# Window bounds and "formula" quantities are small math expressions over the
# variables and dimensions of ONE data file (the syntax is explained in the
# CONFIG section below). parse_expr() reads the text into a tree of Node
# objects (a syntax error says where it is), eval_on() computes the tree with
# numpy, broadcasting variables BY DIMENSION NAME, and expr_units() works out
# the units of the result. The arithmetic is plain IEEE double, evaluated
# exactly as written (nothing reordered), so the numbers are the web app's.

class ExprError(Exception):
    """A problem in an expression; pos = its 0-based character position (-1: none),
    counted like the web app does (a character outside the BMP, e.g. an emoji,
    counts 2)."""

    def __init__(self, message, pos=-1):
        Exception.__init__(self, message)
        self.pos = pos


# number suffixes: 300k = 300000, 2.5M = 2.5e6, 10u = 1e-5 (both micro signs = u)
SI_SUFFIX = {"p": 1e-12, "n": 1e-9, "u": 1e-6, "\u00b5": 1e-6, "\u03bc": 1e-6, "m": 1e-3,
             "k": 1e3, "K": 1e3, "M": 1e6, "G": 1e9, "T": 1e12}
# the functions: name -> (fewest, most arguments; None = no limit)
FUNCTIONS = {"abs": (1, 1), "sqrt": (1, 1), "exp": (1, 1), "ln": (1, 1), "log": (1, 1),
             "log10": (1, 1), "floor": (1, 1), "ceil": (1, 1), "round": (1, 1),
             "db2lin": (1, 1), "lin2db": (1, 1), "pow": (2, 2), "min": (1, None), "max": (1, None)}

_SPACE = " \t\r\n"
_NUMBER = re.compile(r"([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?")
_IDENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_ID_CHAR = re.compile(r"[A-Za-z0-9_]")
_GLUED = re.compile(r"[A-Za-z0-9_.\u00b5\u03bc]*")   # text that may not touch a number
MAX_DEPTH = 64   # nesting limit: parentheses, signs, ^ and function calls (as in the app)


def tokenize(text):
    """The tokens of an expression, as (kind, value, position, text): kind "num"
    (value = the number, SI suffix applied), "name", "qname" (a "quoted name"),
    "op" (+ - * / ^ ( ) , - and ** is read as ^), and a final "end"."""
    tokens, i, n = [], 0, len(text)
    if any(ord(c) > 0xFFFF for c in text):   # positions as the app counts them
        at, u = [], 0
        for c in text:
            at.append(u)
            u += 2 if ord(c) > 0xFFFF else 1
        at.append(u)
    else:
        at = range(n + 1)
    while i < n:
        c = text[i]
        if c in _SPACE:
            i += 1
            continue
        m = _NUMBER.match(text, i)
        if m:
            value, j = float(m.group(0)), m.end()
            if j < n and text[j] in SI_SUFFIX:
                value *= SI_SUFFIX[text[j]]   # ONE multiplication, as in the app
                j += 1
            k = _GLUED.match(text, j).end()
            if k > j:                         # 5ms, 2e, 1.2.3, 3x ...
                raise ExprError("invalid number '%s'" % text[i:k], at[i])
            tokens.append(("num", value, at[i], text[i:j]))
            i = j
            continue
        m = _IDENT.match(text, i)
        if m:
            tokens.append(("name", m.group(0), at[i], m.group(0)))
            i = m.end()
            continue
        if c == '"':
            # the name ends at the first " NOT directly followed by a letter, digit
            # or _ (such a quote belongs to the name: "a"b" is the name a"b)
            j = text.find('"', i + 1)
            while j >= 0 and j + 1 < n and _ID_CHAR.match(text, j + 1):
                j = text.find('"', j + 1)
            if j < 0:
                raise ExprError('the quoted name has no closing "', at[i])
            if j == i + 1:
                raise ExprError('empty quoted name ""', at[i])
            tokens.append(("qname", text[i + 1:j], at[i], text[i:j + 1]))
            i = j + 1
            continue
        if text.startswith("**", i):
            tokens.append(("op", "^", at[i], "**"))
            i += 2
            continue
        if c in "+-*/^(),":
            tokens.append(("op", c, at[i], c))
            i += 1
            continue
        raise ExprError("unexpected character '%s'" % c, at[i])
    tokens.append(("end", None, at[n], ""))
    return tokens


class Node(object):
    """One node of a parsed expression. kind "num": value = the number; "name":
    value = a variable / dimension name; "neg" / "plus": unary minus / plus of
    args[0]; "op": value = "+", "-", "*", "/" or "^", args = [left, right];
    "call": value = the function name, args = its arguments. pos = where the
    node starts in the text."""
    __slots__ = ("kind", "value", "args", "pos")

    def __init__(self, kind, value=None, args=(), pos=-1):
        self.kind, self.value, self.args, self.pos = kind, value, list(args), pos

    def __repr__(self):
        if self.kind in ("num", "name"):
            return "%s(%r)" % (self.kind, self.value)
        return "%s(%s)" % (self.value or self.kind, ", ".join(repr(a) for a in self.args))


class _Parser(object):
    """Recursive descent over the grammar, lowest precedence first:
        expr  := term (("+" | "-") term)*
        term  := unary (("*" | "/") unary)*
        unary := ("-" | "+") unary | power        so -a^2 = -(a^2)
        power := atom ("^" unary)?                 so a^b^c = a^(b^c); 2^-x works
        atom  := number | name "(" args ")" | name | "(" expr ")"
    A name directly followed by "(" is a function call; a "quoted name" never is.
    At most MAX_DEPTH nested parentheses / signs / ^ / calls."""

    def __init__(self, text):
        self.tokens = tokenize(text)
        self.k = 0
        self.depth = 0

    def enter(self, pos):
        self.depth += 1
        if self.depth > MAX_DEPTH:
            raise ExprError("expression is nested too deeply", pos)

    def peek(self):
        return self.tokens[self.k]

    def take(self):
        tok = self.tokens[self.k]
        self.k += 1
        return tok

    def at(self, *ops):
        tok = self.tokens[self.k]
        return tok[0] == "op" and tok[1] in ops

    def unexpected(self, tok):
        if tok[0] == "end":
            return ExprError("unexpected end of the expression", tok[2])
        return ExprError("unexpected '%s'" % tok[3], tok[2])

    def expect(self, op):
        if not self.at(op):
            tok = self.peek()
            if tok[0] == "end":
                raise ExprError("missing '%s'" % op, tok[2])
            raise ExprError("expected '%s' but found '%s'" % (op, tok[3]), tok[2])
        self.take()

    def expr(self):
        node = self.term()
        while self.at("+", "-"):
            tok = self.take()
            node = Node("op", tok[1], [node, self.term()], tok[2])
        return node

    def term(self):
        node = self.unary()
        while self.at("*", "/"):
            tok = self.take()
            node = Node("op", tok[1], [node, self.unary()], tok[2])
        return node

    def unary(self):
        if self.at("-", "+"):
            tok = self.take()
            self.enter(tok[2])
            node = Node("neg" if tok[1] == "-" else "plus", None, [self.unary()], tok[2])
            self.depth -= 1
            return node
        return self.power()

    def power(self):
        node = self.atom()
        if self.at("^"):
            tok = self.take()
            self.enter(tok[2])
            node = Node("op", "^", [node, self.unary()], tok[2])
            self.depth -= 1
        return node

    def atom(self):
        tok = self.take()
        kind, value, pos = tok[0], tok[1], tok[2]
        if kind == "num":
            return Node("num", value, (), pos)
        if kind == "name" and self.at("("):
            return self.call(value, pos)
        if kind in ("name", "qname"):
            return Node("name", value, (), pos)
        if kind == "op" and value == "(":
            self.enter(pos)
            node = self.expr()
            self.expect(")")
            self.depth -= 1
            return node
        raise self.unexpected(tok)

    def call(self, name, pos):
        if name not in FUNCTIONS:
            raise ExprError("unknown function '%s'" % name, pos)
        self.take()  # "("
        self.enter(pos)
        args = []
        if not self.at(")"):
            args.append(self.expr())
            while self.at(","):
                self.take()
                args.append(self.expr())
        self.expect(")")
        self.depth -= 1
        fewest, most = FUNCTIONS[name]
        if len(args) < fewest or (most is not None and len(args) > most):
            need = ("%d" % fewest) if fewest == most else ("at least %d" % fewest)
            raise ExprError("%s() takes %s argument%s (%d given)"
                            % (name, need, "" if fewest == 1 else "s", len(args)), pos)
        return Node("call", name, args, pos)


def parse_expr(text):
    """Parse an expression -> its Node tree. Raises ExprError (with the position)."""
    if not isinstance(text, str):
        raise ExprError("an expression must be a text, not %r" % (text,))
    if not text.strip(_SPACE):
        raise ExprError("empty expression", -1)
    p = _Parser(text)
    node = p.expr()
    if p.peek()[0] != "end":
        raise p.unexpected(p.peek())
    return node


def expr_name_nodes(node, out=None):
    """The "name" nodes of a tree in text order, each name once (first appearance)."""
    if out is None:
        out = []
    if node.kind == "name" and all(n.value != node.value for n in out):
        out.append(node)
    for a in node.args:
        expr_name_nodes(a, out)
    return out


def expr_names(node):
    """The names an expression uses (not function names), in order of first appearance."""
    return [n.value for n in expr_name_nodes(node)]


_REF_TOKEN = re.compile(r'"((?:[^"]|"(?=[A-Za-z0-9_]))*)"?|(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?'
                        r'[pnumkKMGT\u00b5\u03bc]?|([A-Za-z_][A-Za-z0-9_]*)([ \t\r\n]*\()?')


def expr_refs(text):
    """The names an expression text mentions, found by a quick scan that also works
    on a broken expression (numbers and function names skipped). Used to order the
    derived quantities; the same scan as the web app's exprRefs()."""
    out = []
    for m in _REF_TOKEN.finditer(text if isinstance(text, str) else ""):
        name = m.group(1) if m.group(1) is not None else (m.group(2) if not m.group(3) else None)
        if name and name not in out:
            out.append(name)
    return out


def c_pow(a, b):
    """a^b with the rules of C's pow(), which the web app follows too: 1 when
    a == 1 or b == 0 (even if the other one is NaN), and (-1)^(+-inf) = 1."""
    a, b = np.asarray(a, dtype=float), np.asarray(b, dtype=float)
    with np.errstate(all="ignore"):
        r = np.power(a, b)
    # numpy computes x^0.5 as sqrt(x) when the exponent is a single number:
    # sqrt(-inf) = nan and sqrt(-0) = -0, where pow() gives +inf and +0
    half = b == 0.5
    r = np.where(half & (a == -np.inf), np.inf, np.where(half & (a == 0), 0.0, r))
    return np.where((a == 1) | (b == 0) | ((a == -1) & np.isinf(b)), 1.0, r)


def _lin2db(x):
    return np.where(x > 0, 10.0 * np.log10(np.where(x > 0, x, 1.0)), np.nan)


# min / max: NaN in any argument -> NaN (np.minimum / np.maximum), and the sign of
# a zero result as in the app: min(0, -0) = -0, max(0, -0) = 0 (numpy returns
# whichever operand it happens to pick)
def _nan_min(*args):
    r = args[0]
    for a in args[1:]:
        m = np.minimum(r, a)
        r = np.where(m == 0, np.where(np.signbit(r) | np.signbit(a), -0.0, 0.0), m)
    return r


def _nan_max(*args):
    r = args[0]
    for a in args[1:]:
        m = np.maximum(r, a)
        r = np.where(m == 0, np.where(np.signbit(r) & np.signbit(a), -0.0, 0.0), m)
    return r


_FUNCTION_IMPL = {
    "abs": np.abs, "sqrt": np.sqrt, "exp": np.exp, "ln": np.log, "log": np.log,
    "log10": np.log10, "floor": np.floor, "ceil": np.ceil,
    "round": lambda x: np.floor(x + 0.5),           # halves round up, like the app
    "db2lin": lambda x: c_pow(10.0, x / 10.0),
    "lin2db": _lin2db, "pow": c_pow, "min": _nan_min, "max": _nan_max,
}


def eval_expr(node, value_of):
    """Compute a parsed expression with numpy. value_of(name, pos) returns the
    values of a name as an array that broadcasts against the result."""
    with np.errstate(all="ignore"):   # 1/0 = inf, sqrt(-1) = NaN ... as in the app
        return np.asarray(_ev(node, value_of), dtype=float)


def _ev(node, value_of):
    kind = node.kind
    if kind == "num":
        return np.float64(node.value)
    if kind == "name":
        return value_of(node.value, node.pos)
    if kind == "neg":
        return -_ev(node.args[0], value_of)
    if kind == "plus":
        return _ev(node.args[0], value_of)
    if kind == "call":
        return _FUNCTION_IMPL[node.value](*[_ev(x, value_of) for x in node.args])
    # (no list comprehension here: a+b+c+... nests one level per term, and on
    # Python < 3.12 a comprehension would add a second stack frame per level)
    a = _ev(node.args[0], value_of)
    b = _ev(node.args[1], value_of)
    op = node.value
    if op == "+":
        return a + b
    if op == "-":
        return a - b
    if op == "*":
        return a * b
    if op == "/":
        return a / b
    return c_pow(a, b)   # ^


def resolve_name(f, name, pos=-1):
    """What a name in an expression stands for in file f: ("var", Var) = a numeric
    variable (derived ones too), ("dim", None) = a dimension without a numeric
    coordinate variable (its index 0, 1, 2, ...), ("const", value) = pi. A
    dimension name never means a variable of that name that is not the
    dimension's own 1-D coordinate (possible in NetCDF-3 files)."""
    v = f.var(name)
    is_dim = name in f.sizes
    if v is not None and v.numeric and (not is_dim or v.dims == (name,)):
        return "var", v
    if is_dim:
        return "dim", None
    if v is not None:
        raise ExprError("'%s' is not numeric" % name, pos)
    if name == "pi":
        return "const", math.pi
    raise ExprError("unknown name '%s'" % name, pos)


def name_dims(f, name, pos=-1):
    """The dimensions a name brings into an expression."""
    kind, v = resolve_name(f, name, pos)
    return v.dims if kind == "var" else ((name,) if kind == "dim" else ())


def name_units(f, name):
    """Units of a name in an expression ('' for a dimension index, pi or unknown names)."""
    try:
        kind, v = resolve_name(f, name)
    except ExprError:
        return ""
    return v.units if kind == "var" else ""


def eval_on(f, node, dims):
    """Evaluate a parsed expression at every element of an array with dimensions
    'dims' (dimensions of file f). Each name used must have all its dimensions
    among 'dims'. Returns an array that broadcasts to that array's shape."""
    dims = tuple(dims)

    def value_of(name, pos):
        kind, v = resolve_name(f, name, pos)
        if kind == "const":
            return np.float64(v)
        for d in (v.dims if kind == "var" else (name,)):
            if d not in dims:
                raise ExprError("'%s' has dimension '%s', which the result lacks" % (name, d), pos)
        if kind == "var":
            return as_float(_align(v, dims), v.units)      # time units -> seconds
        n = f.size(name)
        return np.arange(n, dtype=float).reshape([n if d == name else 1 for d in dims])
    return eval_expr(node, value_of)


def formula_name_units(f, name):
    """Units of a name in a formula's automatic units: name_units(), but "s" for
    time-like units, whose values the expression sees in seconds (otherwise the
    result would be labelled 'ns' and converted again where it is used)."""
    u = name_units(f, name)
    return "s" if u and time_scale(u) != 1.0 else u


def _units_norm(u):
    return js_trim(u).lower()


def _pow_units(ua, exponent):
    """Units of a^b: e.g. 'nm^2' when a has units and b is a plain number, else ''."""
    sign = 1.0
    if exponent.kind == "neg" and exponent.args[0].kind == "num":
        exponent, sign = exponent.args[0], -1.0
    if ua and exponent.kind == "num":
        return "%s^%s" % (ua, js_str(sign * exponent.value))
    return ""


def expr_units(node, units_of):
    """Units of an expression's result, from the units of the names it uses
    (units_of(name) -> text): dBm - dBm -> dB, W / W -> '', V * A -> V.A (with a
    middle dot), lin2db(mW) -> dBm, ... (the web app's rules)."""
    kind = node.kind
    if kind == "num":
        return ""
    if kind == "name":
        return units_of(node.value)
    if kind in ("neg", "plus"):
        return expr_units(node.args[0], units_of)
    us = []
    for a in node.args:   # (a loop, not a comprehension: see _ev)
        us.append(expr_units(a, units_of))
    if kind == "op":
        ua, ub = us
        op = node.value
        if op == "+":
            if not ua or not ub:
                return ua or ub
            if is_db(ua) and is_db(ub):
                return ub if _units_norm(ua) == "db" else ua
            return ua
        if op == "-":
            if is_db(ua) and is_db(ub) and _units_norm(ua) == _units_norm(ub):
                return "dB"
            return ua or ub
        if op == "*":
            return ua + "\u00b7" + ub if (ua and ub) else (ua or ub)
        if op == "/":
            if ua and _units_norm(ua) == _units_norm(ub):
                return ""
            if ua and ub:
                return ua + "/" + ub
            return ua or ("1/" + ub if ub else "")
        return _pow_units(ua, node.args[1])
    fn = node.value
    if fn in ("abs", "floor", "ceil", "round", "min", "max"):
        return next((u for u in us if u), "")
    if fn == "pow":
        return _pow_units(us[0], node.args[1])
    if fn == "lin2db":
        return {"mw": "dBm", "w": "dBW"}.get(_units_norm(us[0]), "dB")
    if fn == "db2lin":
        return {"dbm": "mW", "dbw": "W", "db": ""}.get(_units_norm(us[0]), "lin(%s)" % us[0] if us[0] else "")
    return ""  # sqrt exp ln log log10


def js_str(x):
    """A number written the way JavaScript's String(x) writes it: 2, -0.5, 1e-7,
    1e+21 (the shortest text that reads back as the same number)."""
    x = float(x)
    if math.isnan(x):
        return "NaN"
    if math.isinf(x):
        return "Infinity" if x > 0 else "-Infinity"
    if x == 0:
        return "0"
    _sign, digits, exp = Decimal(repr(abs(x))).normalize().as_tuple()
    digits = "".join(str(d) for d in digits)
    k, n = len(digits), len(digits) + exp      # n = position of the decimal point
    if k <= n <= 21:
        s = digits + "0" * (n - k)
    elif 0 < n <= 21:
        s = digits[:n] + "." + digits[n:]
    elif -6 < n <= 0:
        s = "0." + "0" * (-n) + digits
    else:
        s = digits[0] + ("." + digits[1:] if k > 1 else "") + "e%+d" % (n - 1)
    return ("-" if x < 0 else "") + s


_PLAIN_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*\Z")


def quote_name(name):
    """A name as written in an expression: in double quotes unless it is a plain
    identifier that is not a function name or pi."""
    if _PLAIN_NAME.match(name) and name not in FUNCTIONS and name != "pi":
        return name
    return '"%s"' % name


# ---- 1f. Derived quantities ----------------------------------------------------------
# A derived quantity is a new variable computed from the variables of ONE file:
#   reduce    - a statistic over one dimension, optionally restricted to a window
#               of x values whose bounds are expressions, e.g. the peak power
#               within stimulusFrequency +- 0.01*stimulusFrequency
#   formula   - an expression of the file's variables (e.g. SNR = peak - floor),
#               broadcasting by dimension NAME
#   combine   - a OP b element by element (older projects; formula does more)
#   transform - a function of one variable (older projects)
# For dB data, mean / median / std / sum / integral are computed on the LINEAR
# power 10^(y/10) and converted back to dB (averaging dB numbers directly biases
# noise low by about 2.5 dB). max / min / argmax are the same either way.
# Results that come out infinite are stored as NaN.

class DeriveError(Exception):
    """A derived quantity that cannot be computed (the message says why)."""


STATS = ("max", "min", "mean", "median", "std", "sum", "integral", "count", "argmax_x", "argmin_x")
REGIONS = ("inside", "outside", "outside_within")
WINDOW_MODES = ("none", "range", "center")
WINDOW_FIELDS = ("lo", "hi", "lo2", "hi2", "center", "halfwidth", "halfwidth2")
OPS = ("-", "+", "*", "/", "max", "min")
TRANSFORMS = ("db2lin", "lin2db", "scale", "abs")
NAME_RE = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_ .+\-]{0,63}")


def migrate_window(w):
    """A reduce window in the current format: {"mode", "lo", "hi", "lo2", "hi2",
    "center", "halfwidth", "halfwidth2"}, every field an expression text ("" = not
    set). A window written by an older NC Explorer (mode "fixed" with numbers
    lo/hi/lo2/hi2, or mode "relative" = k*center + offset +- halfwidth with center
    "coord:<dim>" or "var:<name>") is converted so that it computes exactly the
    same numbers; a number given for a field becomes its text."""
    w = w if isinstance(w, dict) else {}

    def is_num(v):
        return isinstance(v, (int, float)) and not isinstance(v, bool)

    def fin(v):
        return is_num(v) and math.isfinite(v)

    def text(v):
        if isinstance(v, str):
            return v
        return js_str(v) if fin(v) else ""

    raw_mode = w.get("mode")
    center = w.get("center")
    # an old window: mode fixed / relative; or mode none / missing with a k or
    # offset key (always written by older versions), a number in a field, or a
    # "coord:" / "var:" center and no other expression text. A "range" /
    # "center" window is never converted (the web app's rule).
    legacy = raw_mode in ("fixed", "relative")
    if not legacy and raw_mode not in ("range", "center"):
        legacy = ("k" in w or "offset" in w or any(is_num(w.get(k)) for k in WINDOW_FIELDS)
                  or (isinstance(center, str) and center.startswith(("coord:", "var:"))
                      and all(k == "center" or not isinstance(w.get(k), str) or w.get(k) == ""
                              for k in WINDOW_FIELDS)))
    mode = ("none" if raw_mode is None else str(raw_mode)) or "none"
    out = {"mode": mode}
    out.update((k, "") for k in WINDOW_FIELDS)
    if not legacy:
        for k in WINDOW_FIELDS:
            out[k] = text(w.get(k))
        return out
    if mode == "fixed":            # only numbers count in an old window
        out["mode"] = "range"
        for k in ("lo", "hi", "lo2", "hi2"):
            out[k] = js_str(w[k]) if fin(w.get(k)) else ""
    elif mode == "relative":
        out["mode"] = "center"
        if isinstance(center, str) and center.startswith(("coord:", "var:")):
            name = center.split(":", 1)[1][:256]
            if name:
                k = w["k"] if fin(w.get("k")) else 1
                off = w["offset"] if fin(w.get("offset")) else 0
                c = quote_name(name) if k == 1 else "%s*%s" % (js_str(k), quote_name(name))
                if off != 0:
                    c += (" - %s" % js_str(-off)) if off < 0 else (" + %s" % js_str(off))
                out["center"] = c
        for k in ("halfwidth", "halfwidth2"):
            out[k] = js_str(abs(w[k])) if fin(w.get(k)) else ""
    return out   # "none" (and unknown modes): every field ""


_DEF_FIELDS = {
    "reduce": (("src", ""), ("over", ""), ("xsrc", "index"), ("window", None),
               ("region", "inside"), ("stat", "max"), ("db", "auto")),
    "formula": (("expr", ""),),
    "combine": (("a", ""), ("op", "-"), ("b", "")),
    "transform": (("src", ""), ("fn", "db2lin"), ("scale", 1.0), ("offset", 0.0)),
}


def normalize_def(d):
    """A definition with every field present (defaults for missing ones) and, for a
    reduce, its window in the current format (see migrate_window)."""
    out = {"name": "", "file": "", "kind": "", "units": "", "description": ""}
    out.update(d if isinstance(d, dict) else {})
    for k in ("name", "file", "kind", "units", "description"):
        if not isinstance(out[k], str):
            out[k] = "" if out[k] is None else str(out[k])
    for k, default in _DEF_FIELDS.get(out["kind"], ()):
        out.setdefault(k, default)
    if out["kind"] == "reduce":
        out["window"] = migrate_window(out["window"])
    return out


def expr_failure(what, text, err):
    """A DeriveError saying which setting is wrong, what is wrong and where, e.g.
        window halfwidth: unknown name 'RBW' at position 2
            3*RBW
              ^"""
    msg = "%s: %s" % (what, err)
    if isinstance(text, str) and 0 <= err.pos:
        # err.pos counts a character outside the BMP as 2 (like the app)
        col, u = 0, 0
        while col < len(text) and u < err.pos:
            u += 2 if ord(text[col]) > 0xFFFF else 1
            col += 1
        if u == err.pos:
            shown = re.sub(r"[\t\r\n]", " ", text)
            msg += " at position %d\n        %s\n        %s^" % (err.pos, shown, " " * col)
    return DeriveError(msg)


def reduce_samples(x, y, window, region, stat, db):
    """The statistic 'stat' of the samples y[k] whose x[k] is in the region.

    window = (lo, hi, lo2, hi2): the inner window [lo, hi] (inclusive) and, for
    region "outside_within", the outer span [lo2, hi2]. A sample counts only if
    its x is in the region (a NaN x never is) AND its y is finite.
    db=True: mean/median/std/sum/integral are computed on 10^(y/10), then 10*log10."""
    x = np.asarray(x, dtype=float)
    y = np.asarray(y, dtype=float)
    lo, hi, lo2, hi2 = window
    with np.errstate(invalid="ignore", over="ignore", divide="ignore"):
        inside = (x >= lo) & (x <= hi)
        if region == "inside":
            member = inside
        elif region == "outside":
            member = ~inside & ~np.isnan(x)
        else:  # "outside_within": outside the window but inside the outer span
            member = ~inside & (x >= lo2) & (x <= hi2)
        use = member & np.isfinite(y)
        if stat == "count":
            return float(np.count_nonzero(use))
        if not use.any():
            return math.nan
        if stat in ("max", "min", "argmax_x", "argmin_x"):
            k = np.flatnonzero(use)
            pick = k[np.argmax(y[k])] if stat in ("max", "argmax_x") else k[np.argmin(y[k])]
            return float(y[pick]) if stat in ("max", "min") else float(x[pick])  # first one
        v = np.power(10.0, y / 10.0) if db else y      # linear power for dB data
        if stat == "mean":
            r = float(np.mean(v[use]))
        elif stat == "median":
            r = float(np.median(v[use]))
        elif stat == "std":
            r = float(np.std(v[use]))                 # population std (ddof = 0)
        elif stat == "sum":
            r = float(np.sum(v[use]))
        elif stat == "integral":
            # trapezoids between CONSECUTIVE samples that both count (never across a gap)
            pair = use[:-1] & use[1:]
            if not pair.any():
                return math.nan
            r = float(np.sum((0.5 * (v[:-1] + v[1:]) * np.abs(np.diff(x)))[pair]))
        else:
            raise DeriveError("unknown statistic %r" % stat)
        if db:
            r = 10.0 * math.log10(r) if r > 0 else math.nan
    return r


def eval_setting(f, text, what, dims):
    """Evaluate the expression of one setting ('what', for messages) over 'dims'."""
    try:
        return eval_on(f, parse_expr(text), dims)
    except ExprError as e:
        raise expr_failure(what, text, e)


def window_bounds(f, win, region, dims, shape):
    """The window at every element of a reduce's result (dims/shape = the
    result's): arrays lo, hi (the window), lo2, hi2 (the outer span; +-inf when
    not used) and 'defined'. Where a needed expression (lo, hi, center,
    halfwidth, ...) is not a finite number the window is undefined: no sample
    belongs to ANY region there. (Finite values whose center +- halfwidth
    overflows give an infinite edge, not an undefined window.)"""
    mode = win["mode"]
    inf = np.full(shape, math.inf)
    if mode == "none":
        return -inf, inf, -inf, inf, np.ones(shape, dtype=bool)
    outer = region == "outside_within"

    def value(field, why):
        text = win.get(field)
        if not isinstance(text, str) or not text.strip(_SPACE):
            raise DeriveError("window %s is empty: %s" % (field, why))
        return np.broadcast_to(eval_setting(f, text, "window " + field, dims), shape)

    with np.errstate(all="ignore"):
        if mode == "range":     # from lo to hi (either order)
            a, b = value("lo", "a 'range' window needs lo and hi"), value("hi", "a 'range' window needs lo and hi")
            lo, hi = np.minimum(a, b), np.maximum(a, b)
            defined = np.isfinite(a) & np.isfinite(b)
            if outer:
                why = "region 'outside_within' needs the outer span lo2 and hi2"
                a, b = value("lo2", why), value("hi2", why)
                lo2, hi2 = np.minimum(a, b), np.maximum(a, b)
                defined &= np.isfinite(a) & np.isfinite(b)
        else:                   # center +- |halfwidth|
            why = "a 'center' window needs center and halfwidth"
            mid = value("center", why)
            hw = value("halfwidth", why)
            lo, hi = mid - np.abs(hw), mid + np.abs(hw)
            defined = np.isfinite(mid) & np.isfinite(hw)
            if outer:
                hw2 = value("halfwidth2", "region 'outside_within' needs the outer halfwidth2")
                lo2, hi2 = mid - np.abs(hw2), mid + np.abs(hw2)
                defined &= np.isfinite(hw2)
    if not outer:
        lo2, hi2 = -inf, inf
    return lo, hi, lo2, hi2, defined


def _numeric_var(f, name, role):
    v = f.var(name) if isinstance(name, str) and name else None
    if v is None:
        raise DeriveError("%s '%s' not found in %s" % (role, name, f.name))
    if not v.numeric:
        raise DeriveError("%s '%s' is not numeric" % (role, name))
    return v


def reduce_x_values(f, xsrc, src, over):
    """x value of every element of src for a reduce, as an array shaped like src."""
    n = f.size(over)
    if xsrc == "index":
        return _along(np.arange(n, dtype=float), over, src.dims, src.data.shape)
    if xsrc == "coord":  # the coordinate variable of 'over', else the index
        cv = f.var(over)
        if cv is not None and cv.numeric and cv.dims == (over,):
            return _along(as_float(cv.data, cv.units), over, src.dims, src.data.shape)
        return _along(np.arange(n, dtype=float), over, src.dims, src.data.shape)
    if xsrc.startswith("var:"):  # a parallel x array, e.g. each spectrum's own frequencies
        xa = _numeric_var(f, xsrc[4:], "x source")
        if over not in xa.dims:
            raise DeriveError("x source '%s' does not span '%s'" % (xa.name, over))
        extra = [d for d in xa.dims if d not in src.dims]
        if extra:
            raise DeriveError("x source '%s' has dimension(s) %s that '%s' does not have"
                              % (xa.name, ", ".join(extra), src.name))
        return np.broadcast_to(as_float(_align(xa, src.dims), xa.units), src.data.shape)
    raise DeriveError("unknown x source %r" % xsrc)


def compute_reduce(f, d):
    src = _numeric_var(f, d["src"], "source variable")
    if not src.dims:
        raise DeriveError("source variable '%s' is a scalar: nothing to reduce" % src.name)
    over = d["over"]
    if over not in src.dims:
        raise DeriveError("'%s' is not a dimension of '%s' (%s)" % (over, src.name, ", ".join(src.dims)))
    win, region, stat = d["window"], d["region"], d["stat"]
    mode = win["mode"]
    if stat not in STATS:
        raise DeriveError("unknown statistic %r" % stat)
    if region not in REGIONS:
        raise DeriveError("unknown region %r" % region)
    if mode not in WINDOW_MODES:
        raise DeriveError("unknown window mode %r (none, range or center)" % mode)
    if d["db"] not in ("auto", "yes", "no"):
        raise DeriveError("unknown dB mode %r" % d["db"])
    if mode == "none" and region != "inside":
        raise DeriveError("region '%s' needs a window (the window mode is 'none')" % region)
    res_dims = tuple(dm for dm in src.dims if dm != over)
    res_shape = tuple(f.size(dm) for dm in res_dims)
    lo, hi, lo2, hi2, defined = window_bounds(f, win, region, res_dims, res_shape)
    db = d["db"] == "yes" or (d["db"] == "auto" and is_db(src.units))
    # y and x with the reduced dimension LAST: shape = result shape + (n,)
    ax = src.dims.index(over)
    Y = np.moveaxis(src.data, ax, -1)
    X = np.moveaxis(reduce_x_values(f, d["xsrc"], src, over), ax, -1)
    out = np.full(res_shape, math.nan)
    for I in np.ndindex(*res_shape):  # one 1-D slice per result element
        if not defined[I]:            # undefined window: no sample counts
            out[I] = 0.0 if stat == "count" else math.nan
        else:
            bounds = (float(lo[I]), float(hi[I]), float(lo2[I]), float(hi2[I]))
            out[I] = reduce_samples(X[I], Y[I], bounds, region, stat, db)
    return res_dims, out


def compute_formula(f, d):
    """An expression of the file's variables. The result has the dimensions of the
    names it uses, in order of first appearance (only numbers: a scalar)."""
    text = d["expr"]
    if not isinstance(text, str) or not text.strip(_SPACE):
        raise DeriveError("the formula (expr) is empty")
    try:
        node = parse_expr(text)
        dims = []
        for nm in expr_name_nodes(node):
            for dm in name_dims(f, nm.value, nm.pos):
                if dm not in dims:
                    dims.append(dm)
        values = eval_on(f, node, dims)
    except ExprError as e:
        raise expr_failure("formula", text, e)
    shape = tuple(f.size(dm) for dm in dims)
    return tuple(dims), np.array(np.broadcast_to(values, shape), dtype=float)


def compute_combine(f, d):
    a = _numeric_var(f, d["a"], "operand a")
    op, b = d["op"], d["b"]
    if op not in OPS:
        raise DeriveError("unknown operation %r" % op)
    if isinstance(b, (int, float)) and not isinstance(b, bool):
        if not math.isfinite(b):
            raise DeriveError("operand b must be a finite number")
        dims, A, B = a.dims, a.data, float(b)
    else:
        bv = _numeric_var(f, b, "operand b")
        dims = a.dims + tuple(dm for dm in bv.dims if dm not in a.dims)
        A, B = _align(a, dims), _align(bv, dims)
    with np.errstate(all="ignore"):
        if op == "-":
            r = A - B
        elif op == "+":
            r = A + B
        elif op == "*":
            r = A * B
        elif op == "/":
            r = A / B
        elif op == "max":
            r = _nan_max(A, B)     # NaN in either operand -> NaN
        else:
            r = _nan_min(A, B)
    shape = tuple(f.size(dm) for dm in dims)
    return dims, np.array(np.broadcast_to(r, shape), dtype=float)


def compute_transform(f, d):
    s = _numeric_var(f, d["src"], "source variable")
    x, fn = s.data, d["fn"]
    with np.errstate(all="ignore"):
        if fn == "db2lin":
            r = np.power(10.0, x / 10.0)
        elif fn == "lin2db":
            r = np.where(x > 0, 10.0 * np.log10(np.where(x > 0, x, 1.0)), np.nan)
        elif fn == "scale":
            r = x * d["scale"] + d["offset"]
        elif fn == "abs":
            r = np.abs(x)
        else:
            raise DeriveError("unknown function %r" % fn)
    return s.dims, np.array(r, dtype=float)


COMPUTE = {"reduce": compute_reduce, "formula": compute_formula,
           "combine": compute_combine, "transform": compute_transform}


def auto_units(f, d):
    """Units of a derived variable when its definition leaves them empty."""
    def units(name):
        v = f.var(name) if isinstance(name, str) else None
        return v.units if v is not None else ""

    def norm(u):
        return js_trim(u).lower()

    kind = d["kind"]
    if kind == "reduce":
        su = units(d["src"])
        xs = d["xsrc"]
        xu = units(d["over"]) if xs == "coord" else (units(xs[4:]) if xs.startswith("var:") else "")
        st = d["stat"]
        if st in ("max", "min", "mean", "median", "std", "sum"):
            return su
        if st == "integral":
            return su + "\u00b7" + xu if (su and xu) else (su or xu)
        if st == "count":
            return ""
        return xu  # argmax_x / argmin_x
    if kind == "formula":
        try:
            return expr_units(parse_expr(d["expr"]), lambda name: formula_name_units(f, name))
        except ExprError:
            return ""
    if kind == "combine":
        b_is_var = isinstance(d["b"], str)
        ua, ub = units(d["a"]), (units(d["b"]) if b_is_var else "")
        op = d["op"]
        if op == "-":
            same_db = b_is_var and is_db(ua) and is_db(ub) and norm(ua) == norm(ub)
            return "dB" if same_db else ua
        if op == "*":
            return ua + "\u00b7" + ub if (ua and ub) else (ua or ub)
        if op == "/":
            if ua and norm(ua) == norm(ub):
                return ""
            if ua and ub:
                return ua + "/" + ub
            return ua or ("1/" + ub if ub else "")
        return ua  # + max min
    if kind == "transform":
        su = units(d["src"])
        fn = d["fn"]
        if fn == "db2lin":
            return {"dbm": "mW", "dbw": "W", "db": ""}.get(norm(su), "lin(%s)" % su if su else "")
        if fn == "lin2db":
            return {"mw": "dBm", "w": "dBW"}.get(norm(su), "dB")
        return su
    return ""


def window_fields_used(mode, region):
    """The window fields a reduce uses: the window itself (unless mode "none") and
    the outer span only for region "outside_within"."""
    inner = {"range": ["lo", "hi"], "center": ["center", "halfwidth"]}.get(mode, [])
    if inner and region == "outside_within":
        return inner + (["lo2", "hi2"] if mode == "range" else ["halfwidth2"])
    return inner


def def_deps(d):
    """Variable names a definition reads (other derived variables among them): its
    source / operands / x source and every name its expressions mention (only the
    window fields in use, like the web app)."""
    out = []

    def add(n):
        if isinstance(n, str) and n and n not in out:
            out.append(n)
    kind = d["kind"]
    if kind == "reduce":
        add(d["src"])
        if isinstance(d["xsrc"], str) and d["xsrc"].startswith("var:"):
            add(d["xsrc"][4:])
        for k in window_fields_used(d["window"]["mode"], d["region"]):
            for n in expr_refs(d["window"][k]):
                add(n)
    elif kind == "formula":
        for n in expr_refs(d["expr"]):
            add(n)
    elif kind == "combine":
        add(d["a"])
        add(d["b"])
    else:
        add(d.get("src"))
    return out


def derived_order(f, defs, warn):
    """Order the definitions of ONE file so each comes after the ones it uses.
    Returns (ordered defs, {name: error}) - bad names and cycles are errors.
    (New quantities cannot be named like a function or pi in the app, but older
    ones may be, e.g. "floor": they still compute, as in the app. In an
    expression, floor(x) is the function and a bare floor is the variable.)"""
    errors, by_name = {}, {}
    for d in defs:
        name = d["name"]
        if not NAME_RE.fullmatch(name or ""):
            errors[name] = "invalid name %r" % name
        elif f.is_real(name) or name in f.sizes:
            errors[name] = "'%s' is already a variable or dimension of %s" % (name, f.name)
        elif name in by_name:
            warn("derived '%s' is defined twice for %s - the second definition is ignored" % (name, f.name))
        else:
            by_name[name] = d
    order, state = [], {}

    def visit(name, stack):
        if state.get(name) == "done":
            return
        if state.get(name) == "active":
            cycle = stack[stack.index(name):] + [name]
            for n in cycle:
                errors.setdefault(n, "circular definition (%s)" % " -> ".join(cycle))
            return
        state[name] = "active"
        stack.append(name)
        for dep in def_deps(by_name[name]):
            if dep in by_name:
                visit(dep, stack)
        stack.pop()
        state[name] = "done"
        order.append(by_name[name])

    for name in by_name:
        visit(name, [])
    return [d for d in order if d["name"] not in errors], errors


def compute_derived(files, defs, warn):
    """Compute every derived definition (dependency order) and add the results to
    their files as ordinary variables. Returns {(file, name): None or error}."""
    status, by_file = {}, {}
    for d in defs:
        d = normalize_def(d)
        by_file.setdefault(d["file"], []).append(d)
    for fname, fdefs in by_file.items():
        f = files.get(fname)
        if f is None:
            for d in fdefs:
                status[(fname, d["name"])] = "data file '%s' is not available" % fname
            continue
        order, errors = derived_order(f, fdefs, warn)
        for name, msg in errors.items():
            status[(fname, name)] = msg
        for d in order:
            # a failed dependency fails this one too - unless the name means
            # something else here (a real variable or a dimension of the file)
            failed = [dep for dep in def_deps(d) if status.get((fname, dep))
                      and not f.is_real(dep) and dep not in f.sizes]
            if failed:
                status[(fname, d["name"])] = "uses '%s', which could not be computed" % failed[0]
                continue
            try:
                compute = COMPUTE.get(d["kind"])
                if compute is None:
                    raise DeriveError("unknown kind %r" % d["kind"])
                dims, data = compute(f, d)
                data = np.where(np.isfinite(data), data, np.nan)
                units = js_trim(d["units"]) or auto_units(f, d)
                f.add_derived(Var(d["name"], dims, data, units, numeric=True, derived=True))
                status[(fname, d["name"])] = None
            except DeriveError as e:
                status[(fname, d["name"])] = str(e)
            except Exception as e:  # a bug or a hand-edited definition of the wrong shape
                status[(fname, d["name"])] = "%s: %s" % (type(e).__name__, e)
    return status


def failed_derived(tab, status):
    """The derived variables that a tab's VISIBLE traces use (as y, x or sweep-value
    source) but that could not be computed: [(file, name), ...]."""
    out = []
    for t in tab["traces"]:
        if not t["visible"]:
            continue
        names = [t["var"]] + [s[4:] for s in (t["xsrc"], t["ssrc"]) if s.startswith("var:")]
        for name in names:
            key = (t["file"], name)
            if name and status.get(key) and key not in out:
                out.append(key)
    return out


# ---- 1g. From a trace to lines ----------------------------------------------------
def normalize_trace(f, t):
    """The fix-ups the app applies to a loaded trace: an unknown line dim becomes the
    variable's last dim; a sweep that is not a dim (or is the line dim) is dropped."""
    t = dict(t)
    v = f.var(t["var"]) if f is not None else None
    if v is not None and v.dims:
        if t["line_dim"] not in v.dims:
            t["line_dim"] = v.dims[-1]
        if t["sweep"] and (t["sweep"] not in v.dims or t["sweep"] == t["line_dim"]):
            t["sweep"] = ""
    return t


def trace_name(t):
    return t["label"] or t["var"]


def sweep_source_values(f, t, sweep, fixed):
    """The value of every sweep index (colorbar / legend values), or None for 'use
    the index'. Source t["ssrc"]: "coord" (the sweep dim's coordinate, raw values),
    "index", or "var:<name>" (a parallel variable along the sweep dim)."""
    src = t["ssrc"] or "coord"
    if src == "index":
        return None
    if src.startswith("var:"):
        sa = f.var(src[4:])
        if sa is not None and sa.numeric and sweep in sa.dims:
            idx = tuple(slice(None) if d == sweep else
                        max(0, min(fixed.get(d, 0), sa.data.shape[k] - 1))
                        for k, d in enumerate(sa.dims))
            return as_float(sa.data[idx], sa.units)
    cv = f.var(sweep)
    return cv.data.ravel() if (cv is not None and cv.numeric) else None


def sweep_source_label(f, t, sweep):
    """Caption for the sweep values, e.g. 'freq_Hz (Hz)' or 'freq (index)'."""
    s = sweep or t["sweep"]
    if not s:
        return ""
    src = t["ssrc"] or "coord"
    if src.startswith("var:"):
        sa = f.var(src[4:]) if f is not None else None
        if sa is not None and s in sa.dims:
            return "%s (%s)" % (src[4:], sa.units) if sa.units else src[4:]
    if src == "index":
        return "%s (index)" % s
    cv = f.var(s) if f is not None else None
    u = cv.units if cv is not None else ""
    return "%s (%s)" % (s, u) if u else s


def trace_lines(f, t, notes):
    """Expand one trace into its lines -> (lines, sweep dim or None).
    Each line is {"x": array, "y": array, "sval": sweep value or None}.

    The variable is sliced at t["slices"] on every dim except the line dim (along
    which each line runs) and the sweep dim (one line per index, subsampled to
    MAX_SWEEP_LINES). x comes from t["xsrc"]: "index", "coord" (the line dim's
    coordinate) or "var:<name>" (a parallel x variable, sliced the same way)."""
    v = f.var(t["var"])
    if v is None or not v.numeric:
        notes.append("trace '%s': %s variable '%s' in %s - not drawn"
                     % (trace_name(t), "no" if v is None else "non-numeric", t["var"], f.name))
        return [], None
    ldim = t["line_dim"]
    if ldim not in v.dims:
        notes.append("trace '%s': '%s' is not a dimension of %s - not drawn" % (trace_name(t), ldim, t["var"]))
        return [], None
    sweep = t["sweep"] or None
    if sweep is not None and sweep not in v.dims:
        sweep = None
    if any(f.size(d) == 0 for d in v.dims):
        notes.append("%s: a dimension has size 0 - nothing to plot." % t["var"])
        return [], None
    # fixed index on every dim except the line and sweep dims (clamped to range)
    fixed = {}
    for d in v.dims:
        if d not in (ldim, sweep):
            fixed[d] = max(0, min(int(t["slices"].get(d, 0)), f.size(d) - 1))

    def y_line(extra):
        idx = tuple(slice(None) if d == ldim else extra.get(d, fixed.get(d, 0)) for d in v.dims)
        return np.asarray(v.data[idx], dtype=float)

    def x_line(extra):
        n = f.size(ldim)
        if t["xsrc"] == "coord":
            cv = f.var(ldim)
            if cv is not None and cv.numeric:
                return as_float(cv.data.ravel(), cv.units)
        if t["xsrc"].startswith("var:"):
            xa = f.var(t["xsrc"][4:])
            if xa is not None and xa.numeric and ldim in xa.dims:
                idx = []
                for k, d in enumerate(xa.dims):
                    if d == ldim:
                        idx.append(slice(None))
                    else:
                        i = extra[d] if d in extra else fixed.get(d, 0)
                        idx.append(max(0, min(i, xa.data.shape[k] - 1)))
                return as_float(xa.data[tuple(idx)], xa.units)
        return np.arange(n, dtype=float)

    if sweep is None:
        return [{"x": x_line({}), "y": y_line({}), "sval": None}], None

    n_s = f.size(sweep)
    svals = sweep_source_values(f, t, sweep, fixed)
    idxs = list(range(n_s))
    if n_s > MAX_SWEEP_LINES:  # evenly subsample (first and last kept)
        idxs = []
        for k in range(MAX_SWEEP_LINES):
            i = _js_round(k * (n_s - 1) / (MAX_SWEEP_LINES - 1))
            if i not in idxs:
                idxs.append(i)
        notes.append("sweep '%s' has %d lines - showing %d evenly spaced." % (sweep, n_s, len(idxs)))
    lines = []
    for i in idxs:
        if svals is None:
            sval = float(i)
        else:
            sval = float(svals[i]) if i < len(svals) else math.nan
        lines.append({"x": x_line({sweep: i}), "y": y_line({sweep: i}), "sval": sval})
    return lines, sweep


def line_label(t, sweep, sval, j):
    """Legend text of one line: the trace label, plus '[sweep=value]' for a sweep
    line, or the trace's sweep-label template ({label} {sweep} {v} {n})."""
    base = t["label"] or t["var"]
    if sval is None:
        return base
    tmpl = js_trim(t["sweep_label"])
    if tmpl:
        return (tmpl.replace("{label}", base).replace("{sweep}", sweep or "")
                .replace("{v}", fmt6(sval)).replace("{n}", str(j)))
    return "%s [%s=%s]" % (base, sweep, fmt6(sval))


def auto_labels(files, traces):
    """Automatic axis labels: from the first visible trace whose variable exists
    (x), and the first such trace on each y axis. Units in parentheses."""
    xl = yl_left = yl_right = ""
    for t in traces:
        if not t["visible"]:
            continue
        f = files.get(t["file"])
        v = f.var(t["var"]) if f is not None else None
        if v is None:
            continue
        yl = t["var"] + (" (%s)" % v.units if v.units else "")
        if t["yaxis"] == "right":
            yl_right = yl_right or yl
        else:
            yl_left = yl_left or yl
        if not xl:
            if t["xsrc"].startswith("var:"):
                name = t["xsrc"][4:]
                xv = f.var(name)
                xl = name + (" (%s)" % xv.units if xv is not None and xv.units else "")
            elif t["xsrc"] == "coord":
                cv = f.var(t["line_dim"])
                xl = t["line_dim"] + (" (%s)" % cv.units if cv is not None and cv.units else "")
            else:
                xl = "%s (index)" % t["line_dim"]
    return xl, yl_left, yl_right


# ---- 1h. Colors ----------------------------------------------------------------------
def cmap_color(name, t):
    """RGB color at position t (0..1) of a colormap: the same piecewise-linear
    interpolation, rounded to whole RGB values, as the web app."""
    stops = COLORMAPS.get(name) or COLORMAPS["Viridis"]
    t = float(t) if math.isfinite(t) else 0.0
    t = min(1.0, max(0.0, t))
    seg = (len(stops) - 1) * t
    i = min(int(math.floor(seg)), len(stops) - 2)
    f = seg - i
    return tuple(_js_round(a + (b - a) * f) / 255.0 for a, b in zip(stops[i], stops[i + 1]))


def mpl_colormap(name):
    """The same colormap as a matplotlib Colormap (for the colorbar)."""
    stops = COLORMAPS.get(name) or COLORMAPS["Viridis"]
    n = len(stops) - 1
    return LinearSegmentedColormap.from_list(
        "ncx_" + name, [(i / n, tuple(c / 255.0 for c in rgb)) for i, rgb in enumerate(stops)], N=256)


# ---- 1i. Drawing one page --------------------------------------------------------------
def figure_size(c):
    """(width, height) in inches: the tab's locked plot size, else FIGSIZE_DEFAULT."""
    def clamp(v, default):
        try:
            v = float(v)
        except (TypeError, ValueError):
            v = default
        return min(40.0, max(2.0, v if math.isfinite(v) else default))
    if c.get("lock_size"):
        return (clamp(c.get("figw"), 8.0), clamp(c.get("figh"), 5.2))
    return FIGSIZE_DEFAULT


def new_figure(size):
    try:
        return plt.figure(figsize=size, layout="constrained")
    except TypeError:  # matplotlib < 3.5
        return plt.figure(figsize=size, constrained_layout=True)


def line_style(t, on_right):
    """matplotlib keywords for a trace: width (px -> pt), dash, markers.
    dash "auto" = solid on the left y axis, dotted on the right one."""
    lw = min(10.0, max(0.25, float(t["lw"])))
    kw = {"linewidth": lw * PX, "linestyle": DASHES.get(t["dash"]) or (":" if on_right else "-")}
    if t["draw"] == "markers":
        kw.update(linestyle="none", marker="o", markersize=6 * PX, markeredgewidth=0)
    elif t["draw"] == "lines+markers":
        kw.update(marker="o", markersize=6 * PX, markeredgewidth=0)
    return kw


_NUMBER_PREFIX = re.compile(r"\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)")


def _limit(v):
    """An axis-limit setting as a float, or None (= automatic). Text is read like
    the app reads its limit boxes (JavaScript parseFloat: '12x' -> 12, '' -> None)."""
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, str):
        m = _NUMBER_PREFIX.match(v)
        if not m:
            return None
        v = m.group(1)
    v = float(v)
    return v if math.isfinite(v) else None


def axis_range(umin, umax, dmin, dmax, is_log):
    """Axis limits from the optional user min/max (in displayed units, None = auto).
    A one-sided limit takes the other end from the data. None = let matplotlib choose."""
    umin, umax = _limit(umin), _limit(umax)
    if umin is None and umax is None:
        return None
    lo = umin if umin is not None else dmin
    hi = umax if umax is not None else dmax
    if not (math.isfinite(lo) and math.isfinite(hi)):
        return None                      # no data to fill the automatic side
    if lo > hi:
        lo, hi = hi, lo
    if lo == hi:
        lo, hi = lo - 0.5, hi + 0.5      # avoid a zero-width axis
    if is_log:
        if hi <= 0:
            return None                  # nothing positive to show
        if lo <= 0:
            lo = dmin if (math.isfinite(dmin) and dmin > 0) else hi / 1000.0
    return (lo, hi)


def _set_log(ax, which):
    setter = ax.set_xscale if which == "x" else ax.set_yscale
    try:
        setter("log", nonpositive="mask")  # values <= 0 leave gaps, like the app
    except TypeError:                      # matplotlib < 3.3
        setter("log")
    _log_tick_labels(ax.xaxis if which == "x" else ax.yaxis)


def _log_tick_labels(axis):
    """Plain-number labels on a log axis (1, 2, 5, 10, 20, 50, ...) like the web
    app, instead of matplotlib's 10^n. The 2 and 5 in between are labeled only
    while the axis spans at most 3 decades."""
    def major(v, _pos):
        return "%g" % v

    def minor(v, _pos):
        lo, hi = sorted(axis.get_view_interval())
        if not (v > 0 and lo > 0 and hi / lo <= 1e3):
            return ""
        m = v / 10.0 ** math.floor(math.log10(v) + 1e-9)   # mantissa 1..9.99
        return "%g" % v if abs(m - 2) < 1e-6 or abs(m - 5) < 1e-6 else ""
    axis.set_major_formatter(ticker.FuncFormatter(major))
    axis.set_minor_formatter(ticker.FuncFormatter(minor))


class _Extent(object):
    """Running min/max of the finite values drawn on one axis."""

    def __init__(self):
        self.lo, self.hi = math.inf, -math.inf

    def add(self, a):
        a = a[np.isfinite(a)]
        if a.size:
            self.lo, self.hi = min(self.lo, float(a.min())), max(self.hi, float(a.max()))


def draw_tab(tab, files):
    """Draw one tab -> (figure, fetched lines, notes). Mirrors the web app's redraw()."""
    c = tab["plot"]
    traces = [normalize_trace(files.get(t["file"]), t) for t in tab["traces"]]
    mode = c.get("mode", "2D lines")
    is3d = mode == "3D waterfall"
    notes = []

    # 1) every visible trace -> lines
    fetched = []
    for ti, t in enumerate(traces):
        f = files.get(t["file"])
        if not t["visible"] or f is None:
            continue
        lines, sweep = trace_lines(f, t, notes)
        if lines:
            fetched.append({"ti": ti, "t": t, "lines": lines, "sweep": sweep})

    # 2) sweep ranges; ONE shared color scale only if all sweeps are the same dim
    ranges = {}
    for fe in fetched:
        fin = [ln["sval"] for ln in fe["lines"] if ln["sval"] is not None and math.isfinite(ln["sval"])]
        if fe["sweep"] and fin:
            lo, hi = ranges.get(fe["sweep"], (math.inf, -math.inf))
            ranges[fe["sweep"]] = (min(lo, min(fin)), max(hi, max(fin)))
    shared = list(ranges)[0] if len(ranges) == 1 else None
    if len(ranges) > 1:
        notes.append("traces sweep different quantities - shared colorbar suppressed")

    def norm_for(fe):
        if not fe["sweep"]:
            return None
        if shared is not None:
            lo, hi = ranges[shared]
        else:
            fin = [ln["sval"] for ln in fe["lines"] if ln["sval"] is not None and math.isfinite(ln["sval"])]
            if not fin:
                return None
            lo, hi = min(fin), max(fin)
        return (lo, hi if hi > lo else lo + 1)

    # 3) axes (a twin right-hand y axis when a trace asks for it)
    xf = PREFIX_FACTOR.get(c["xunit"]) or 1.0
    yf_left = PREFIX_FACTOR.get(c["yunit"]) or 1.0
    yf_right = PREFIX_FACTOR.get(c["yunit2"]) or 1.0

    def on_right(ti):
        return (not is3d) and traces[ti]["yaxis"] == "right"
    any_right = any(on_right(fe["ti"]) for fe in fetched)
    fig = new_figure(figure_size(c))
    if is3d:
        from mpl_toolkits.mplot3d import Axes3D  # noqa: F401  (registers "3d")
        ax = fig.add_subplot(111, projection="3d")
        ax2 = None
    else:
        ax = fig.add_subplot(111)
        ax2 = ax.twinx() if any_right else None

    # 4) the lines
    legend_items = []          # (handle, text) in drawing order
    colored_no_legend = False  # a sweep family colored by value but with no legend
    ext_x, ext_l, ext_r = _Extent(), _Extent(), _Extent()
    padded_x = False           # markers on the plot: pad the x range like Plotly does
    for fe in fetched:
        ti, t, lines, sweep = fe["ti"], fe["t"], fe["lines"], fe["sweep"]
        nrm = norm_for(fe)
        base = t["color"] or CYCLE[ti % len(CYCLE)]
        if sweep and len(lines) > LEGEND_MAX_LINES and c["legend"] and mode == "2D lines":
            notes.append("'%s': %d sweep lines - legend omitted" % (trace_name(t), len(lines)))
        right = on_right(ti)
        yf = yf_right if right else yf_left
        target = ax2 if right else ax
        style = line_style(t, right)
        padded_x = padded_x or t["draw"] != "lines"
        for j, ln in enumerate(lines):
            m = min(len(ln["x"]), len(ln["y"]))
            xs, ys = ln["x"][:m] / xf, ln["y"][:m] / yf
            ext_x.add(xs)
            (ext_r if right else ext_l).add(ys)
            s_ok = ln["sval"] is not None and math.isfinite(ln["sval"])
            if s_ok and nrm is not None:
                color = cmap_color(c["cmap"], (ln["sval"] - nrm[0]) / (nrm[1] - nrm[0]))
            else:
                color = base
            label = None
            if ln["sval"] is None or len(lines) <= LEGEND_MAX_LINES:
                label = line_label(t, sweep, ln["sval"], j)
            elif s_ok and nrm is not None:
                colored_no_legend = True
            if is3d:  # waterfall: depth = sweep value (or the trace number)
                depth = np.full(m, ln["sval"] if s_ok else float(ti))
                handle, = ax.plot(xs, depth, ys, color=color, **style)
            else:
                handle, = target.plot(xs, ys, color=color, **style)
            if label is not None and c["legend"]:
                legend_items.append((handle, label))

    # 5) colorbar: Rainbow mode, or a 2D sweep family too big for a legend
    if (mode == "Rainbow" or (not is3d and colored_no_legend)) and shared is not None:
        rep = [fe for fe in fetched if fe["sweep"] == shared][0]
        is_index = (rep["t"]["ssrc"] or "coord") == "index"   # an index is never SI-scaled
        cf = 1.0 if is_index else (PREFIX_FACTOR.get(c["cunit"]) or 1.0)
        if is_index and c["cunit"]:
            notes.append("colorbar source is an index - SI scaling not applied")
        lo, hi = ranges[shared][0] / cf, ranges[shared][1] / cf
        src_label = sweep_source_label(files.get(rep["t"]["file"]), rep["t"], shared)
        caption = js_trim(c["clabel"]) or (src_label if is_index else scaled_label(src_label, c["cunit"]))
        sm = ScalarMappable(norm=Normalize(lo, hi if hi > lo else lo + 1), cmap=mpl_colormap(c["cmap"]))
        sm.set_array(np.array([]))
        cb = fig.colorbar(sm, ax=ax, pad=0.02, aspect=30)
        cb.n_rasterize = 10 ** 9            # matplotlib rasterizes long colorbars by default;
        if cb.solids is not None:           # keep the page 100% vector
            cb.solids.set_rasterized(False)
            cb.solids.set_edgecolor("face")
        cb.outline.set_linewidth(0.8 * PX)
        cb.set_label(tex_safe(caption), fontsize=12 * PX)
    elif mode == "Rainbow" and not ranges:
        notes.append("Rainbow mode needs a trace with a sweep dim")

    # 6) markers (2D only): red open circles + "x, y" on their trace's own y axis
    if not is3d:
        by_trace = dict((fe["ti"], fe["lines"]) for fe in fetched)
        for mk in tab["markers"]:
            lines = by_trace.get(mk["trace"])
            if not lines:
                continue
            ln = lines[max(0, min(int(mk["line"]), len(lines) - 1))]
            m = min(len(ln["x"]), len(ln["y"]))
            if m == 0:
                continue
            k = max(0, min(int(mk["idx"]), m - 1))
            right = on_right(mk["trace"])
            xm = float(ln["x"][k]) / xf
            ym = float(ln["y"][k]) / (yf_right if right else yf_left)
            if not (math.isfinite(xm) and math.isfinite(ym)):
                continue
            target = ax2 if right else ax
            target.plot([xm], [ym], linestyle="none", marker="o", markersize=11 * PX,
                        markerfacecolor="none", markeredgecolor=MARKER_COLOR,
                        markeredgewidth=2 * PX, zorder=10, clip_on=False)
            target.annotate("%s, %s" % (fmt6(xm), fmt6(ym)), xy=(xm, ym), xytext=(5, 4),
                            textcoords="offset points", ha="left", va="bottom",
                            fontsize=10 * PX, color=MARKER_COLOR, zorder=11, annotation_clip=False)
            padded_x = True
    elif tab["markers"]:
        notes.append("markers are shown in the 2D views only")

    # 7) labels, scales, limits, grid
    auto_x, auto_left, auto_right = auto_labels(files, traces)
    xlab = c["xlabel"] or scaled_label(auto_x, c["xunit"])
    ylab = c["ylabel"] or scaled_label(auto_left, c["yunit"])
    ylab2 = c["ylabel2"] or scaled_label(auto_right, c["yunit2"])
    if c["title"]:
        ax.set_title(tex_safe(c["title"]))
    if is3d:
        ax.set_xlabel(tex_safe(xlab))
        ax.set_ylabel(tex_safe(c["zlabel"] or shared or "trace"))
        ax.set_zlabel(tex_safe(ylab))
        ax.grid(bool(c["grid"]))
        for axis in (ax.xaxis, ax.yaxis, ax.zaxis):
            try:
                axis.set_pane_color((1.0, 1.0, 1.0, 0.0))   # white panes, like the app
            except AttributeError:
                pass
        if c["logx"] or c["logy"]:
            notes.append("log axes are not applied in the 3D view")
        if any(_limit(c.get(k)) is not None for k in ("xmin", "xmax", "ymin", "ymax", "ymin2", "ymax2")):
            notes.append("axis limits are applied in the 2D views only")
    else:
        ax.set_xlabel(tex_safe(xlab))
        ax.set_ylabel(tex_safe(ylab))
        if c["grid"]:
            ax.grid(True)
            ax.set_axisbelow(True)
        if c["logx"]:
            _set_log(ax, "x")
        if c["logy"]:
            _set_log(ax, "y")
        # Plotly pads the y range by 5%, and the x range only when markers are drawn
        for a in (ax, ax2):
            if a is not None:
                a.margins(x=0.05 if padded_x else 0.0, y=0.05)
        xr = axis_range(c["xmin"], c["xmax"], ext_x.lo, ext_x.hi, c["logx"])
        if xr:
            ax.set_xlim(xr)
        yr = axis_range(c["ymin"], c["ymax"], ext_l.lo, ext_l.hi, c["logy"])
        if yr:
            ax.set_ylim(yr)
        if ax2 is not None:
            ax2.set_ylabel(tex_safe(ylab2))
            if c["logy2"]:
                _set_log(ax2, "y")
            yr2 = axis_range(c["ymin2"], c["ymax2"], ext_r.lo, ext_r.hi, c["logy2"])
            if yr2:
                ax2.set_ylim(yr2)

    # 8) legend (all traces of both y axes in ONE box, on top)
    if c["legend"] and legend_items:
        loc = c["legend_loc"] if c["legend_loc"] in LEGEND_LOCS else "best"
        top = ax2 if ax2 is not None else ax
        leg = top.legend([h for h, _ in legend_items], [tex_safe(s) for _, s in legend_items], loc=loc)
        leg.get_frame().set_linewidth(0.6 * PX)
    return fig, fetched, notes


# =============================================================================
# 2. CONFIG - your plots. Edit freely.
# =============================================================================
# FILES: where each data file is. Keys are the names the traces use; values are
# paths, relative to the data folder (--data-dir, default: this script's
# folder) or absolute.
#
# CONFIG["derived"]: derived quantities, computed in dependency order and then
#   usable like any variable of their file. Kinds:
#   reduce   : stat of 'src' over dim 'over'. x values along 'over' come from
#              'xsrc' ("index", "coord" or "var:<name>"). window.mode:
#                "none"   all x values (region must be "inside");
#                "range"  from lo to hi; outer span from lo2 to hi2;
#                "center" center +- halfwidth; outer span center +- halfwidth2.
#              Window fields are EXPRESSIONS (see below) computed for every
#              element of the result, so they can follow the variables that
#              vary along the result's dimensions: e.g. center
#              "stimulusFrequency" with halfwidth "0.01*stimulusFrequency" or
#              "3*ResolutionBWs". Where a bound is not a finite number the
#              window is undefined: no sample counts (result NaN, count 0).
#              region "inside", "outside" or "outside_within" (outside the
#              window but inside the outer span). stat: max min mean median std
#              sum integral count argmax_x argmin_x. db "auto" (from units) /
#              "yes" / "no" (dB data: mean median std sum integral are taken
#              on linear power).
#   formula  : expr = an expression of the file's variables, e.g. "peak - floor"
#              or "floor - 10*log10(ResolutionBWs)". The result has the
#              dimensions of the names it uses, in order of first appearance.
#   combine  : a op b (op - + * / max min); b is a variable name or a number.
#   transform: fn "db2lin", "lin2db", "scale" (x*scale + offset) or "abs".
#   units "" = automatic (dBm - dBm -> dB, W/W -> no units, lin2db(mW) -> dBm ...).
#
# Expressions (window fields and formulas):
#   numbers    12  0.5  .5  2e-3  1.5E6, optionally followed (no space) by an SI
#              suffix p n u m k K M G T (u, or a micro sign, = 1e-6): 300k =
#              300000, 2.5M = 2500000, 10u = 0.00001. Errors: 5ms, 2e, 1.2.3.
#   names      a numeric variable of the same file (derived ones too; time units
#              are converted to seconds, and a formula using one gets units
#              "s") or a dimension: its coordinate variable, or its index 0, 1,
#              2, ... when it has none. A name that is not a plain identifier
#              (letters, digits, _) goes in double quotes: "peak f", "wl.nm"
#              (a " directly followed by a letter, digit or _ is part of the
#              name: "a"b" is a"b). pi = 3.14159... (unless a variable is
#              called pi).
#   operators  + - * /, ^ or ** for powers, ( ) for grouping. ^ binds tightest
#              and from the right: -a^2 = -(a^2), a^b^c = a^(b^c), 2^-x is fine.
#              At most 64 levels of nested ( ), signs, ^ and function calls.
#   functions  abs(x) sqrt(x) exp(x) ln(x) log(x) (= ln) log10(x) floor(x)
#              ceil(x) round(x) (halves up) db2lin(x) (= 10^(x/10)) lin2db(x)
#              (= 10*log10(x); NaN for x <= 0) pow(a, b) min(a, b, ...)
#              max(a, b, ...) (min/max: NaN if any argument is NaN)
#   Variables with different dimensions combine by dimension NAME (like
#   xarray). A window expression may only use names whose dimensions the
#   result has (not the reduced dimension). Plain IEEE arithmetic: 1/0 = inf,
#   sqrt(-1) = NaN, and NaN anywhere gives NaN. A mistake (unknown name,
#   syntax error) is reported with its position; that quantity is skipped, and
#   so is every page that plots it.
#
# CONFIG["tabs"]: one PDF page each ("index" = the tab's position in the app).
#   plot   : cosmetics. mode "2D lines" / "Rainbow" / "3D waterfall"; labels
#            ("" = automatic); xunit / yunit / yunit2 / cunit = SI prefix ("",
#            "k", "M", "G", "T", "m", "\u00b5", "n", "p") that divides the values;
#            axis limits xmin ... ymax2 in DISPLAYED units (None = automatic);
#            cmap (Viridis Turbo Jet Rainbow CoolWarm Gray); clabel = colorbar
#            caption; lock_size + figw/figh = page size in inches.
#   traces : file, var, line_dim (each line runs along it), sweep (one line per
#            index of this dim), slices {dim: index} for the other dims, xsrc,
#            label, sweep_label (template: {label} {sweep} {v} {n}), ssrc (sweep
#            value source: "coord" / "index" / "var:<name>"), yaxis "left" /
#            "right", visible, color ("" = automatic), draw ("lines" /
#            "markers" / "lines+markers"), lw (px), dash ("auto" / "solid" /
#            "dash" / "dot" / "dashdot").
#   markers: {trace: trace number, line: line number, idx: point number}.

__NCX_FILES__

__NCX_CONFIG__


# =============================================================================
# 3. main()
# =============================================================================
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = None  # set a folder here to change the default data folder


def parse_args(argv=None):
    p = argparse.ArgumentParser(
        description="Regenerate the NC Explorer plots of this project as a multi-page vector PDF.")
    p.add_argument("--data-dir", metavar="DIR", default=None,
                   help="folder with the data files (default: this script's folder)")
    p.add_argument("--out", metavar="FILE", default=None,
                   help="output PDF (default: %s next to this script)" % CONFIG["pdf_name"])
    p.add_argument("--png", action="store_true", help="also save every page as a PNG")
    p.add_argument("--svg", action="store_true", help="also save every page as an SVG")
    p.add_argument("--dpi", type=float, default=200, help="PNG resolution (default 200)")
    p.add_argument("--dump-derived", metavar="FILE", default=None,
                   help="save the computed derived variables to a JSON file")
    p.add_argument("--dump-lines", metavar="FILE", default=None,
                   help="save the raw x/y values of every plotted line to a JSON file")
    return p.parse_args(argv)


def _console_safe():
    """Never crash on printing unicode labels to a limited console."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except Exception:
            pass


def _slug(s):
    return re.sub(r"[^A-Za-z0-9_-]+", "_", s).strip("_")[:40] or "tab"


def _write_json(path, obj):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, allow_nan=False)
    print("wrote %s" % path)


def main(argv=None):
    _console_safe()
    args = parse_args(argv)
    data_dir = os.path.abspath(args.data_dir or DATA_DIR or SCRIPT_DIR)
    out_pdf = os.path.abspath(args.out or os.path.join(SCRIPT_DIR, CONFIG["pdf_name"]))
    out_base = os.path.splitext(out_pdf)[0]
    matplotlib.rcParams.update(STYLE)
    tabs = CONFIG["tabs"]
    exit_code = 0

    def warn(msg):
        print("WARNING: " + msg)

    print("NC Explorer report: %d tab(s) -> %s" % (len(tabs), out_pdf))
    print("data folder: %s" % data_dir)

    # 1) open the data files used by visible traces and derived definitions
    wanted = []
    for tab in tabs:
        for t in tab["traces"]:
            if t["visible"] and t["file"] and t["file"] not in wanted:
                wanted.append(t["file"])
    for d in CONFIG["derived"]:
        if d["file"] and d["file"] not in wanted:
            wanted.append(d["file"])
    files = {}
    for name in wanted:
        path = find_data_file(name, data_dir)
        if path is None:
            warn("data file '%s' not found in %s - pages that plot it are skipped "
                 "(use --data-dir, or edit FILES in this script)" % (name, data_dir))
            files[name] = None
            continue
        try:
            files[name] = DataFile(name, path)
            print("opened %s" % path)
        except Exception as e:
            warn("cannot read %s: %s - pages that plot it are skipped" % (path, e))
            files[name] = None

    # 2) derived quantities
    status = compute_derived(files, CONFIG["derived"], warn)
    for (fname, name), err in status.items():
        if err:
            warn("derived '%s' (%s) not computed: %s" % (name, fname, err))
        else:
            v = files[fname].var(name)
            print("derived %s/%s: dims (%s), units '%s'" % (fname, name, ", ".join(v.dims), v.units))
    if args.dump_derived:
        dump = {}
        for (fname, name), err in status.items():
            if err is None:
                v = files[fname].var(name)
                dump.setdefault(fname, {})[name] = {
                    "dims": list(v.dims), "shape": list(v.data.shape),
                    "units": v.units, "data": _json_list(v.data)}
        _write_json(args.dump_derived, dump)

    # 3) one page per tab
    pdf, written, skipped, line_dump = None, 0, 0, {}
    for page_no, tab in enumerate(tabs, 1):
        head = "page %d/%d '%s'" % (page_no, len(tabs), tab["name"])
        missing = sorted(set(t["file"] for t in tab["traces"]
                             if t["visible"] and files.get(t["file"]) is None))
        if missing:
            warn("%s skipped: data file(s) not available: %s" % (head, ", ".join(missing)))
            skipped += 1
            continue
        broken = failed_derived(tab, status)
        if broken:
            warn("%s skipped: it plots %s, which could not be computed (see above)"
                 % (head, ", ".join("derived '%s' (%s)" % (n, fn) for fn, n in broken)))
            skipped += 1
            continue
        try:
            fig, fetched, notes = draw_tab(tab, files)
        except Exception:
            print("ERROR: %s could not be drawn:" % head)
            traceback.print_exc(file=sys.stdout)
            exit_code = 1
            skipped += 1
            continue
        footer = None
        if SHOW_PAGE_FOOTER:
            footer = fig.text(0.995, 0.004, "%s - page %d/%d" % (tex_safe(tab["name"]), page_no, len(tabs)),
                              ha="right", va="bottom", fontsize=6, color="#9a9a9a")
        if pdf is None:
            pdf = PdfPages(out_pdf, metadata={"Title": CONFIG["source"] or "NC Explorer report",
                                              "Creator": "NC Explorer report script"})
        pdf.savefig(fig)   # vector: nothing on the page is rasterized
        if footer is not None:
            footer.remove()  # PNG/SVG copies are clean figures without the footer
        for ext, wanted_fmt in (("png", args.png), ("svg", args.svg)):
            if wanted_fmt:
                path = "%s_p%02d_%s.%s" % (out_base, page_no, _slug(tab["name"]), ext)
                fig.savefig(path, dpi=args.dpi if ext == "png" else None)
                print("    wrote %s" % path)
        plt.close(fig)
        written += 1
        n_lines = sum(len(fe["lines"]) for fe in fetched)
        print("%s: %d trace(s), %d line(s)" % (head, len(fetched), n_lines))
        for n in notes:
            print("    note: " + n)
        line_dump[str(tab["index"])] = [
            {"trace": fe["ti"], "lines": [
                {"x": _json_list(ln["x"]), "y": _json_list(ln["y"]),
                 "sval": None if ln["sval"] is None or not math.isfinite(ln["sval"]) else ln["sval"]}
                for ln in fe["lines"]]}
            for fe in fetched]
    if pdf is not None:
        pdf.close()
    if args.dump_lines:
        _write_json(args.dump_lines, line_dump)
    for f in files.values():
        if f is not None:
            f.close()

    if written:
        print("Done: %d page(s) written to %s%s" % (written, out_pdf,
                                                     " (%d skipped)" % skipped if skipped else ""))
    else:
        print("ERROR: no page could be drawn - no PDF written.")
        exit_code = 1
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
`;
