// derive.js — derived quantities: virtual variables computed from the ones in a
// Dataset. Kinds of definition ("def"): a windowed statistic over one dim
// (reduce) whose window bounds are expressions (e.g. center stimulusFrequency,
// half width 0.01*stimulusFrequency), a free formula over variables and dims
// broadcast by dim NAME (formula, e.g. peak - floor), and — still computed for
// older projects — an elementwise binary op (combine) and a unary function
// (transform). The expression language lives in expr.js. A computed def is
// registered as an ordinary numeric Variable (flag .derived, .def = canonical
// def) in ds.vars, so traces, x sources, sweep sources and other defs use it
// like any other variable.
// Pure: no DOM, no Node APIs — the same module runs in the browser and in the
// Node tests. The semantics are mirrored by the Python report script, so any
// change here must be made there too.

import { Variable } from "./dataset.js";
import { asFloatArray } from "./explore.js";
import { FUNCTIONS, ExprError, parseExpr, exprRefs, exprNames, evalExpr, exprUnits, quoteName, num,
  renameInExpr } from "./expr.js";

export { FUNCTIONS, quoteName } from "./expr.js";

export const STATS = [
  { id: "max", label: "Peak (max)", hint: "largest value in the region" },
  { id: "min", label: "Minimum", hint: "smallest value in the region" },
  { id: "mean", label: "Mean", hint: "average; dB data are averaged in linear power" },
  { id: "median", label: "Median", hint: "middle value (even count: mean of the two middle values)" },
  { id: "std", label: "Std. deviation", hint: "population standard deviation (ddof = 0)" },
  { id: "sum", label: "Sum", hint: "sum of the values (linear power for dB data)" },
  { id: "integral", label: "Integral (trapezoid)",
    hint: "trapezoid area vs x over adjacent contributing points; never bridges an excluded gap" },
  { id: "count", label: "Count of points", hint: "number of finite points in the region" },
  { id: "argmax_x", label: "x at peak (argmax)", hint: "x of the (first) maximum in the region" },
  { id: "argmin_x", label: "x at minimum (argmin)", hint: "x of the (first) minimum in the region" },
];
export const REGIONS = [
  { id: "inside", label: "Inside window" },
  { id: "outside", label: "Outside window" },
  { id: "outside_within", label: "Outside window, within outer span" },
];
export const OPS = [
  { id: "-", label: "a − b" }, { id: "+", label: "a + b" },
  { id: "*", label: "a × b" }, { id: "/", label: "a ÷ b" },
  { id: "max", label: "max(a, b)" }, { id: "min", label: "min(a, b)" },
];
export const TRANSFORMS = [
  { id: "db2lin", label: "dB → linear (10^(x/10))" },
  { id: "lin2db", label: "linear → dB (10·log10(x))" },
  { id: "scale", label: "a·x + b" },
  { id: "abs", label: "Absolute value |x|" },
];
export const WINDOW_MODES = [
  { id: "none", label: "Whole span" },
  { id: "range", label: "From … to …" },
  { id: "center", label: "Center ± half width" },
];
export const DB_MODES = [
  { id: "auto", label: "Auto (from units)" },
  { id: "yes", label: "dB data: average in linear power" },
  { id: "no", label: "Linear data" },
];
export const MAX_DERIVED = 256;
export const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_ .+\-]{0,63}$/;
export const KINDS = ["reduce", "combine", "transform", "formula"];
// length caps of the expression strings (window fields / formula). 320, not
// 300: a migrated bc9812f center "k*<256-char name> + offset" can be 311
// characters long, and cutting it would change what it computes.
export const EXPR_MAX = 320, FORMULA_MAX = 1000;

const idSet = (list) => new Set(list.map((e) => e.id));
const STAT_IDS = idSet(STATS), REGION_IDS = idSet(REGIONS), OP_IDS = idSet(OPS),
  FN_IDS = idSet(TRANSFORMS), MODE_IDS = idSet(WINDOW_MODES), DB_IDS = idSet(DB_MODES);
const FN_NAMES = new Set(FUNCTIONS.map((f) => f.name));
const label = (list, id) => (list.find((e) => e.id === id) || { label: id }).label;

// kernel codes (ints keep the hot loop monomorphic)
const R_IN = 0, R_OUT = 1, R_OW = 2;
const REGION_CODE = { inside: R_IN, outside: R_OUT, outside_within: R_OW };
const S_MAX = 0, S_MIN = 1, S_MEAN = 2, S_MEDIAN = 3, S_STD = 4, S_SUM = 5,
  S_INTEGRAL = 6, S_COUNT = 7, S_ARGMAX = 8, S_ARGMIN = 9;
const STAT_CODE = { max: S_MAX, min: S_MIN, mean: S_MEAN, median: S_MEDIAN, std: S_STD,
  sum: S_SUM, integral: S_INTEGRAL, count: S_COUNT, argmax_x: S_ARGMAX, argmin_x: S_ARGMIN };
// stats computed on linear power (then back to dB) in dB mode
const DB_STATS = new Set(["mean", "median", "std", "sum", "integral"]);

// ---- small helpers -----------------------------------------------------------
const hasOwn = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);
const own = (o, k) => (hasOwn(o, k) ? o[k] : undefined);   // never reads the prototype
const isObj = (o) => o !== null && typeof o === "object" && !Array.isArray(o);
const isFin = (x) => typeof x === "number" && Number.isFinite(x);
const prod = (a) => a.reduce((p, q) => p * q, 1);
const fail = (msg) => { throw new Error(msg); };

function stridesOf(shape) {
  const s = new Array(shape.length);
  let acc = 1;
  for (let i = shape.length - 1; i >= 0; i--) { s[i] = acc; acc *= shape[i]; }
  return s;
}
// own-property lookup: a def naming "constructor" must not find Object.prototype's
function getVar(ds, name) {
  return ds && typeof name === "string" && name && hasOwn(ds.vars, name) ? ds.vars[name] : null;
}
function isNumVar(v) {
  return !!v && typeof v.isNumeric === "function" && v.isNumeric()
    && v.data != null && typeof v.data !== "string" && typeof v.data.length === "number";
}
const unitsOf = (v) => (v ? trimUnits(v.attrs && v.attrs.units) : "");
// the numeric coordinate variable of `dim` (same-named, 1-D along it), or null
function numCoord(ds, dim) {
  const v = getVar(ds, dim);
  return v && isNumVar(v) && v.dims.length === 1 && v.dims[0] === dim
    && v.data.length === v.shape[0] ? v : null;
}
const f64 = (a) => (a instanceof Float64Array ? a : Float64Array.from(a, Number));
const scaled = (v) => asFloatArray(v.data, v.attrs && v.attrs.units);   // time units -> s
// the same values without a copy when nothing would change (float64 data,
// units that are not time-like); the caller must not write into the result
const scaledRO = (v) => (v.data instanceof Float64Array && asFloatArray([1], v.attrs && v.attrs.units)[0] === 1
  ? v.data : scaled(v));
const iota = (n) => { const a = new Float64Array(n); for (let i = 0; i < n; i++) a[i] = i; return a; };
// names that are Object.prototype members ("__proto__", "constructor", ...) are
// refused: ds.vars is a plain object, so ds.vars["__proto__"] = v would replace
// its prototype instead of adding a variable
const reserved = (name) => hasOwn(Object.prototype, name);
const sameFile = (ds, d) => !d.file || !ds || !ds.filename || d.file === ds.filename;
const refName = (s, pre) => (typeof s === "string" && s.startsWith(pre) ? s.slice(pre.length) : null);
const oneLine = (s) => String(s ?? "").replace(/\s*[\r\n]+\s*/g, " ").trim();

// %g-style number text for descriptions (1e6 -> "1e+06", 0.02 -> "0.02")
function fmtG(x) {
  if (!Number.isFinite(x)) return String(x);
  if (x === 0) return "0";
  const [mant, es] = x.toExponential(5).split("e");
  const e = +es;
  if (e < -4 || e >= 6)
    return `${mant.replace(/\.?0+$/, "")}e${e < 0 ? "-" : "+"}${String(Math.abs(e)).padStart(2, "0")}`;
  return String(parseFloat(x.toPrecision(6)));
}

// ---- units ------------------------------------------------------------------
export function trimUnits(u) { return String(u ?? "").trim(); }
export function isDb(u) { return trimUnits(u).toLowerCase().includes("db"); }
const norm = (u) => trimUnits(u).toLowerCase();

// ---- windows: expression fields, and the bc9812f (legacy) form -------------------
// new form: { mode: none|range|center, lo, hi, lo2, hi2, center, halfwidth,
// halfwidth2 } — every field an expression string ("" = not set)
const WIN_FIELDS = ["lo", "hi", "lo2", "hi2", "center", "halfwidth", "halfwidth2"];
const MODE_FIELDS = { none: [], range: ["lo", "hi", "lo2", "hi2"], center: ["center", "halfwidth", "halfwidth2"] };
const INNER = { range: ["lo", "hi"], center: ["center", "halfwidth"] };
const OUTER = { range: ["lo2", "hi2"], center: ["halfwidth2"] };
const FIELD_LABEL = { lo: "from", hi: "to", lo2: "outer from", hi2: "outer to", center: "center",
  halfwidth: "half width", halfwidth2: "outer half width" };
const emptyWindow = (mode) => ({ mode, lo: "", hi: "", lo2: "", hi2: "", center: "", halfwidth: "", halfwidth2: "" });
// an expression field: strings capped as-is, finite numbers as num(x), else ""
const exprStr = (v, max) => (typeof v === "string" ? v.slice(0, max) : isFin(v) ? num(v).slice(0, max) : "");

// the expressions a window needs: the inner ones (mode != none), plus the
// outer ones for region outside_within
function neededFields(mode, region) {
  if (!hasOwn(INNER, mode)) return [];
  return region === "outside_within" ? [...INNER[mode], ...OUTER[mode]] : INNER[mode].slice();
}

// A window as saved by bc9812f: mode fixed/relative; or, with mode none or
// missing, a k/offset key (bc9812f always wrote both), a number in a field, or
// a "coord:"/"var:" center with no other expression text (a hand-written old
// window). A mode none window with typed expressions is NOT legacy, whatever
// its center says. pyexport.js (migrateWindow and the script's
// migrate_window) uses the same rule.
function isLegacyWindow(w) {
  const mode = own(w, "mode");
  if (mode === "fixed" || mode === "relative") return true;
  if (mode === "range" || mode === "center") return false;
  if (hasOwn(w, "k") || hasOwn(w, "offset") || WIN_FIELDS.some((k) => typeof own(w, k) === "number")) return true;
  const c = own(w, "center");
  return typeof c === "string" && /^(coord|var):/.test(c)
    && WIN_FIELDS.every((k) => k === "center" || typeof own(w, k) !== "string" || own(w, k) === "");
}
// Legacy -> new form: fixed -> range (bounds as num(x)); relative -> center
// "[k*]name [± offset]" with |half widths|. It computes exactly the old
// numbers: k*c + offset == (k*c) - (-offset) in IEEE arithmetic, and the
// number texts round-trip. Never cut: with bc9812f's 256-character names the
// center is at most 311 characters (< EXPR_MAX).
function migrateWindow(w) {
  const mode = own(w, "mode");
  const fin = (v) => (isFin(v) ? num(v) : "");
  if (mode === "fixed") {
    const out = emptyWindow("range");
    for (const k of ["lo", "hi", "lo2", "hi2"]) out[k] = fin(own(w, k));
    return out;
  }
  if (mode !== "relative") return emptyWindow(mode == null || mode === "none" ? "none" : mode);
  const out = emptyWindow("center");
  const c = own(w, "center");
  const name = (refName(c, "coord:") ?? refName(c, "var:") ?? "").slice(0, 256);
  if (name) {
    const kv = own(w, "k"), ov = own(w, "offset");
    const k = isFin(kv) ? kv : 1, off = isFin(ov) ? ov : 0;
    const q = quoteName(name);
    out.center = (k === 1 ? q : `${num(k)}*${q}`)
      + (off === 0 ? "" : off < 0 ? ` - ${num(-off)}` : ` + ${num(off)}`);
  }
  const hw = own(w, "halfwidth"), hw2 = own(w, "halfwidth2");
  out.halfwidth = isFin(hw) ? num(Math.abs(hw)) : "";
  out.halfwidth2 = isFin(hw2) ? num(Math.abs(hw2)) : "";
  return out;
}
// any window object -> the new form (legacy migrated); no validation. A
// missing or null mode is "none" (as bc9812f and the report script read it;
// sanitizeDef still rejects a null mode, like bc9812f)
function canonicalWindow(w) {
  const o = isObj(w) ? w : {};
  if (isLegacyWindow(o)) return migrateWindow(o);
  const mode = own(o, "mode");
  const out = { mode: mode == null ? "none" : mode };
  for (const k of WIN_FIELDS) out[k] = exprStr(own(o, k), EXPR_MAX);
  return out;
}
// untrusted window -> the new form, or null (unknown mode; a legacy window
// with a center that is not "", "coord:<name>" or "var:<name>", as bc9812f)
function sanitizeWindow(w) {
  const mode = own(w, "mode");
  if (isLegacyWindow(w)) {
    if (![undefined, "none", "fixed", "relative"].includes(mode)) return null;
    const c = own(w, "center");
    if (c !== undefined && c !== "" && !(typeof c === "string" && /^(coord|var):[\s\S]/.test(c))) return null;
    return migrateWindow(w);
  }
  if (!MODE_IDS.has(mode === undefined ? "none" : mode)) return null;
  return canonicalWindow(w);
}

// ---- expressions: parse cache + name resolution ------------------------------------
const _parsed = new Map();
// AST of `text` (shared — never mutated) or throws ExprError
function parseCached(text) {
  let r = _parsed.get(text);
  if (!r) {
    try { r = { ast: parseExpr(text) }; } catch (e) {
      if (!(e instanceof ExprError)) throw e;
      r = { err: e };
    }
    if (_parsed.size >= 500) _parsed.clear();
    _parsed.set(text, r);
  }
  if (r.err) throw r.err;
  return r.ast;
}
const namesOf = (text) => { try { return exprNames(parseCached(text)); } catch (e) { return []; } };

// What `name` stands for in ds (in this order): a numeric variable (real or
// derived) | a dimension (its index 0..n-1) | the constant pi. A dimension
// name means the dimension's own numeric 1-D coordinate variable, else its
// index — never a non-coordinate variable that happens to share its name
// (legal in NetCDF-3; bc9812f's "coord:<dim>" centers and the x source "coord"
// read it the same way). A non-numeric variable is an error, even one named
// pi. Throws ExprError. The Python script's resolve_name() is the same rule.
function resolveName(ds, name, pos) {
  const v = getVar(ds, name);
  const isDim = !!ds && hasOwn(ds.dims, name);
  if (v && isNumVar(v) && (!isDim || numCoord(ds, name))) {
    if (v.shape.length !== v.dims.length || v.data.length !== prod(v.shape))
      throw new ExprError(`'${name}' data does not match its shape`, pos);
    return { name, pos, kind: "var", v, dims: v.dims, shape: v.shape };
  }
  if (isDim) return { name, pos, kind: "dim", dims: [name], shape: [ds.dims[name]] };
  if (v) throw new ExprError(`'${name}' is not numeric`, pos);
  if (name === "pi") return { name, pos, kind: "const", dims: [], shape: [] };
  throw new ExprError(`unknown name '${name}'`, pos);
}
// units of a name in a formula: those of the variable it resolves to, but "s"
// for time-like units (its values are converted to seconds, see scaledRO) so a
// derived result is not labelled 'ns' and scaled again where it is used; ""
// for a dimension index, pi or an unknown name
function nameUnits(ds, name) {
  let b;
  try { b = resolveName(ds, name, -1); } catch (e) { return ""; }
  if (b.kind !== "var") return "";
  const u = unitsOf(b.v);
  return u && asFloatArray([1], u)[0] !== 1 ? "s" : u;
}
// Resolve every name of `ast` (first appearance first). `self` (the def's own
// name) may not appear. With `dims` (the result dims) the dims rule applies:
// every dim of a name must be a result dim, of the same size.
function bindNames(ds, ast, self, dims, shape) {
  return exprRefs(ast).map(({ name, pos }) => {
    if (self && name === self) throw new ExprError(`'${name}' refers to this quantity itself`, pos);
    const b = resolveName(ds, name, pos);
    if (dims) {
      b.dims.forEach((d, i) => {
        const j = dims.indexOf(d);
        if (j < 0) throw new ExprError(`'${name}' has dimension '${d}', which the result lacks`, pos);
        if (shape[j] !== b.shape[i]) throw new ExprError(`'${d}' has a different size in '${name}'`, pos);
      });
    }
    return b;
  });
}
// values with dims `vd`/shape `vs` (C order) broadcast onto (dims, shape) by
// dim NAME (vd ⊆ dims); the input itself when the layout is already the same
function broadcast(vals, vd, vs, dims, shape) {
  if (vd.length === dims.length && vd.every((d, i) => d === dims[i])) return vals;
  const st = stridesOf(vs);
  const str = dims.map((d) => { const i = vd.indexOf(d); return i < 0 ? 0 : st[i]; });
  const total = prod(shape), nd = dims.length;
  const out = new Float64Array(total), idx = new Int32Array(nd);
  let o = 0;
  for (let f = 0; f < total; f++) {
    out[f] = vals[o];
    for (let d = nd - 1; d >= 0; d--) {         // odometer over (dims, shape)
      o += str[d];
      if (++idx[d] < shape[d]) break;
      o -= str[d] * shape[d];
      idx[d] = 0;
    }
  }
  return out;
}
// evalExpr lookups: every bound name over the whole result (dims, shape) ...
function lookupAll(binds, dims, shape) {
  const m = new Map(binds.map((b) => [b.name, b]));
  return (name) => {
    const b = m.get(name);
    if (!b || b.kind === "const") return undefined;          // pi
    if (b.kind === "dim") return broadcast(iota(b.shape[0]), b.dims, b.shape, dims, shape);
    const vals = scaledRO(b.v);                 // evalExpr never writes into a lookup's array
    return b.dims.length ? broadcast(vals, b.dims, b.shape, dims, shape) : vals[0];
  };
}
// ... or at one result multi-index `idx` (same arithmetic, one element)
function lookupAt(binds, dims, idx) {
  const m = new Map(binds.map((b) => [b.name, b]));
  return (name) => {
    const b = m.get(name);
    if (!b || b.kind === "const") return undefined;
    if (b.kind === "dim") return idx[dims.indexOf(name)];
    const st = stridesOf(b.shape);
    let off = 0;
    b.dims.forEach((d, i) => { off += idx[dims.indexOf(d)] * st[i]; });
    return asFloatArray([b.v.data[off]], b.v.attrs && b.v.attrs.units)[0];
  };
}
// a formula's AST + bindings + result dims: the dims of each referenced name,
// first appearance first, broadcast by dim name. Throws ExprError.
function formulaCore(ds, def, text) {
  const ast = parseCached(text);
  const binds = bindNames(ds, ast, def.name, null, null);
  const dims = [], shape = [], from = [];
  for (const b of binds) {
    b.dims.forEach((d, i) => {
      const j = dims.indexOf(d);
      if (j < 0) { dims.push(d); shape.push(b.shape[i]); from.push(b.name); }
      else if (shape[j] !== b.shape[i])
        throw new ExprError(`'${d}' has size ${shape[j]} in '${from[j]}' but ${b.shape[i]} in '${b.name}'`, b.pos);
    });
  }
  return { ast, binds, dims, shape };
}
// result dims of a reduce (null when src/over are not usable)
function reduceDims(ds, def) {
  const v = getVar(ds, def.src);
  if (!isNumVar(v) || !v.dims.length) return null;
  const ax = v.dims.indexOf(def.over);
  if (ax < 0) return null;
  return { dims: v.dims.filter((_, i) => i !== ax), shape: v.shape.filter((_, i) => i !== ax) };
}

// ---- def records ------------------------------------------------------------
const head = (d, kind) => ({
  name: d.name, file: d.file, kind, units: d.units, description: d.description,
});

export function newDef(kind, file) {
  const base = { name: "", file: String(file ?? ""), units: "", description: "" };
  if (kind === "combine") return { ...head(base, "combine"), a: "", op: "-", b: "" };
  if (kind === "transform")
    return { ...head(base, "transform"), src: "", fn: "db2lin", scale: 1, offset: 0 };
  if (kind === "formula") return { ...head(base, "formula"), expr: "" };
  return {        // unknown kinds get a reduce (the main use)
    ...head(base, "reduce"), src: "", over: "", xsrc: "index",
    window: emptyWindow("none"), region: "inside", stat: "max", db: "auto",
  };
}

// deep copy in canonical key order (§1.1 / E2). No validation: values are
// copied as-is (missing ones take the newDef defaults), so a half-edited def
// survives — except that expression fields are always strings (numbers as
// num(x), capped) and a legacy window is migrated to the new form.
export function canonicalDef(def) {
  const d = isObj(def) ? def : {};
  const kind = own(d, "kind") === undefined ? "reduce" : own(d, "kind");
  const dflt = newDef(KINDS.includes(kind) ? kind : "reduce", "");
  const out = {};
  for (const k of Object.keys(dflt)) {
    if (k === "kind") out.kind = kind;
    else if (k === "window") out.window = canonicalWindow(own(d, "window"));
    else if (k === "expr") out.expr = exprStr(own(d, "expr"), FORMULA_MAX);
    else out[k] = own(d, k) === undefined ? dflt[k] : own(d, k);
  }
  return out;
}

// Parse an untrusted def (e.g. from a project file) into a canonical def, or
// null. Policy: only own properties are read (so "__proto__"/"constructor"
// keys can't inject anything — they are simply never looked at) and the output
// is a fresh object literal.
//  - kind must be reduce|combine|transform|formula, and the name must match
//    NAME_RE after trimming/capping to 64 chars — otherwise null.
//  - enum fields (stat, region, db, window.mode, op, fn, xsrc): a MISSING value
//    takes the default; a present but unrecognized value rejects the def
//    (substituting a default would silently change what is computed).
//  - free strings (file, units, description) of the wrong type become "";
//    capped: units 32 (trimmed), description 200, file and var names 256.
//  - var-name fields (src, over, a, b) of the wrong type become "" (the def is
//    kept and validateDef reports it, so the user can repair it); b may also be
//    a finite number.
//  - expression fields (window fields, formula expr): strings capped at 320 /
//    1000 chars (not trimmed), finite numbers -> num(x), anything else "".
//  - a legacy (bc9812f) window is migrated (see migrateWindow); its center must
//    be "", "coord:<name>" or "var:<name>" as before.
//  - transform: scale defaults to 1 and offset to 0 when not a finite number.
export function sanitizeDef(raw) {
  if (!isObj(raw)) return null;
  const kind = own(raw, "kind");
  if (!KINDS.includes(kind)) return null;
  const s = (v, max, trim) => {
    if (typeof v !== "string") return "";
    return trim ? v.trim().slice(0, max).trim() : v.slice(0, max);
  };
  const name = s(own(raw, "name"), 64, true);
  if (!NAME_RE.test(name) || reserved(name)) return null;
  const vname = (v) => s(v, 256, false);
  const numOr = (v, d) => (isFin(v) ? v : d);
  const en = (v, set, d) => (v === undefined ? d : (set.has(v) ? v : undefined));
  const out = head({ name, file: s(own(raw, "file"), 256, false), units: s(own(raw, "units"), 32, true),
    description: s(own(raw, "description"), 200, true) }, kind);

  if (kind === "formula") return { ...out, expr: exprStr(own(raw, "expr"), FORMULA_MAX) };
  if (kind === "combine") {
    const op = en(own(raw, "op"), OP_IDS, "-");
    if (op === undefined) return null;
    const b = own(raw, "b");
    return { ...out, a: vname(own(raw, "a")), op, b: isFin(b) ? b : vname(b) };
  }
  if (kind === "transform") {
    const fn = en(own(raw, "fn"), FN_IDS, "db2lin");
    if (fn === undefined) return null;
    return { ...out, src: vname(own(raw, "src")), fn,
      scale: numOr(own(raw, "scale"), 1), offset: numOr(own(raw, "offset"), 0) };
  }
  // reduce
  let xsrc = own(raw, "xsrc");                   // index | coord | var:<1..256 chars>
  if (xsrc === undefined) xsrc = "index";
  else if (typeof xsrc !== "string") xsrc = undefined;
  else if (xsrc !== "index" && xsrc !== "coord") {
    xsrc = xsrc.startsWith("var:") && xsrc.length > 4 ? "var:" + xsrc.slice(4, 260) : undefined;
  }
  let w = own(raw, "window");
  if (w === undefined) w = {};
  if (!isObj(w)) return null;
  const window = sanitizeWindow(w);
  const region = en(own(raw, "region"), REGION_IDS, "inside");
  const stat = en(own(raw, "stat"), STAT_IDS, "max");
  const db = en(own(raw, "db"), DB_IDS, "auto");
  if (window === null || [xsrc, region, stat, db].includes(undefined)) return null;
  return {
    ...out, src: vname(own(raw, "src")), over: vname(own(raw, "over")), xsrc,
    window, region, stat, db,
  };
}

// names a def reads (src / a / b / x source / the needed window expressions /
// the formula), deduped, in order. Expression names may also be dims or pi.
export function depsOf(def) {
  if (!isObj(def)) return [];
  const out = [];
  const add = (n) => { if (typeof n === "string" && n && !out.includes(n)) out.push(n); };
  if (def.kind === "combine") { add(def.a); add(def.b); }
  else if (def.kind === "transform") add(def.src);
  else if (def.kind === "formula") namesOf(exprStr(def.expr, FORMULA_MAX)).forEach(add);
  else {
    add(def.src);
    add(refName(def.xsrc, "var:"));
    const w = canonicalWindow(def.window);
    for (const f of neededFields(w.mode, def.region ?? "inside")) namesOf(w[f]).forEach(add);
  }
  return out;
}

// Dependency order (deps first, otherwise input order). Only references to
// other defs in `defs` are edges (real variables need no ordering). A cycle
// (incl. a self reference) is an error for every def on it and for every def
// that depends on one. If two defs share a name, the first one wins and later
// ones are ignored.
export function topoOrder(defs) {
  const byName = new Map();
  for (const d of defs || []) {
    if (isObj(d) && typeof d.name === "string" && !byName.has(d.name)) byName.set(d.name, d);
  }
  const errors = new Map(), order = [], mark = new Map(), stack = [];
  const visit = (d) => {
    const n = d.name;
    if (mark.get(n) === 2) return;
    if (mark.get(n) === 1) {                     // back edge: n ... -> n
      const i = stack.indexOf(n);
      const msg = stack.length - i === 1 ? `'${n}' refers to itself`
        : `circular dependency: ${stack.slice(i).concat(n).join(" → ")}`;
      for (const m of stack.slice(i)) if (!errors.has(m)) errors.set(m, msg);
      return;
    }
    mark.set(n, 1); stack.push(n);
    const deps = depsOf(d).filter((x) => byName.has(x));
    for (const x of deps) visit(byName.get(x));
    stack.pop(); mark.set(n, 2);
    if (errors.has(n)) return;
    const bad = deps.find((x) => errors.has(x));
    if (bad) errors.set(n, `depends on '${bad}', which has an error`);
    else order.push(d);
  };
  for (const d of byName.values()) visit(d);
  return { order, errors };
}

// name rules (§1, E2): pattern, not a real variable or a dim of this file, not
// a function name or pi, unique among this file's defs (`ignoreName` = the def
// being renamed/edited). The function-name/pi rule spares `ignoreName` itself:
// projects saved by bc9812f may hold a def named e.g. "floor", which must keep
// computing (expressions still reach it: a bare name not followed by "(" is a
// reference, and quoteName quotes it).
export function validateName(ds, defs, name, ignoreName) {
  if (typeof name !== "string" || !name.trim()) return "Enter a name.";
  if (!NAME_RE.test(name))
    return "Names start with a letter, digit or _, then letters, digits, space, _ . + - (max 64 characters).";
  if (reserved(name)) return `'${name}' is a reserved name.`;
  if ((FN_NAMES.has(name) || name === "pi") && name !== ignoreName)
    return `'${name}' is ${name === "pi" ? "the constant pi" : "a function"} in expressions — choose another name.`;
  const v = getVar(ds, name);
  if (v && !v.derived) return `'${name}' is already a variable in ${(ds && ds.filename) || "this file"}.`;
  if (ds && hasOwn(ds.dims, name)) return `'${name}' is a dimension name.`;
  for (const d of defs || []) {
    if (isObj(d) && d.name === name && name !== ignoreName && sameFile(ds, d))
      return `Another derived quantity is already named '${name}'.`;
  }
  return null;
}

// ---- resolution (validation + everything the compute needs, no heavy work) --
function needNumVar(ds, name, what) {
  if (typeof name !== "string" || !name) fail(`Choose ${what}.`);
  const v = getVar(ds, name);
  if (!v) fail(`Variable '${name}' not found.`);
  if (!isNumVar(v)) fail(`'${name}' is not numeric.`);
  if (v.shape.length !== v.dims.length || v.data.length !== prod(v.shape))
    fail(`'${name}' data does not match its shape.`);
  return v;
}
const dimSize = (v, d) => v.shape[v.dims.indexOf(d)];

function resolve(ds, def) {
  if (!isObj(def)) fail("Not a derived-quantity definition.");
  if (!ds || !ds.vars) fail("No dataset.");
  if (!KINDS.includes(def.kind)) fail(`Unknown kind '${def.kind}'.`);
  const self = depsOf(def).find((n) => n === def.name);
  if (self) fail(`'${def.name}' refers to itself.`);
  if (def.kind === "combine") return resolveCombine(ds, def);
  if (def.kind === "transform") return resolveTransform(ds, def);
  if (def.kind === "formula") return resolveFormula(ds, def);
  return resolveReduce(ds, def);
}

// one needed window expression: parsed + bound over the result dims
function windowField(ds, def, text, field, dims, shape) {
  const what = `Window '${FIELD_LABEL[field]}'`;
  if (!text.trim()) fail(`${what} is empty — enter an expression.`);
  try {
    const ast = parseCached(text);
    return { field, ast, binds: bindNames(ds, ast, def.name, dims, shape) };
  } catch (e) {
    if (e instanceof ExprError) fail(`${what}: ${e.message}`);
    throw e;
  }
}

function resolveReduce(ds, def) {
  const src = needNumVar(ds, def.src, "a source variable");
  if (!src.dims.length) fail(`'${src.name}' is a scalar — there is no dimension to reduce.`);
  const ax = src.dims.indexOf(def.over);
  if (typeof def.over !== "string" || !def.over || ax < 0)
    fail(def.over ? `'${def.over}' is not a dimension of '${src.name}'.` : "Choose the dimension to reduce.");
  const over = def.over, n = src.shape[ax];
  const dims = src.dims.filter((_, i) => i !== ax);
  const shape = src.shape.filter((_, i) => i !== ax);

  // x source: index | coord (numeric coordinate, else index) | var:<name>
  let xv = null, xkind = "index";
  const xsrc = def.xsrc ?? "index";
  if (xsrc === "coord") {
    xv = numCoord(ds, over);
    if (xv && xv.shape[0] === n) xkind = "coord"; else xv = null;
  } else if (refName(xsrc, "var:")) {
    xv = needNumVar(ds, refName(xsrc, "var:"), "an x variable");
    if (!xv.dims.includes(over)) fail(`x variable '${xv.name}' does not span '${over}'.`);
    for (const d of xv.dims) {
      if (!src.dims.includes(d)) fail(`x variable '${xv.name}' has dimension '${d}', which '${src.name}' lacks.`);
      if (dimSize(xv, d) !== dimSize(src, d)) fail(`'${d}' has a different size in '${xv.name}' and '${src.name}'.`);
    }
    xkind = "var";
  } else if (xsrc !== "index") fail(`Unknown x source '${xsrc}'.`);

  const w = canonicalWindow(def.window);
  const mode = w.mode, region = def.region ?? "inside", stat = def.stat ?? "max";
  const db = def.db ?? "auto";
  if (!MODE_IDS.has(mode)) fail(`Unknown window mode '${mode}'.`);
  if (!REGION_IDS.has(region)) fail(`Unknown region '${region}'.`);
  if (!STAT_IDS.has(stat)) fail(`Unknown statistic '${stat}'.`);
  if (!DB_IDS.has(db)) fail(`Unknown dB mode '${db}'.`);
  if (mode === "none" && region !== "inside") fail("An 'outside' region needs a window.");
  return { kind: "reduce", src, ax, over, n, dims, shape, xkind, xv, mode, region, stat,
    ow: region === "outside_within",
    win: neededFields(mode, region).map((f) => windowField(ds, def, w[f], f, dims, shape)),
    db: db === "yes" || (db === "auto" && isDb(unitsOf(src))) };
}

function resolveCombine(ds, def) {
  if (!OP_IDS.has(def.op)) fail(`Unknown operation '${def.op}'.`);
  const a = needNumVar(ds, def.a, "variable a");
  let b = null, bnum = null;
  if (typeof def.b === "number") {
    if (!Number.isFinite(def.b)) fail("b must be a finite number.");
    bnum = def.b;
  } else b = needNumVar(ds, def.b, "b (a variable or a number)");
  const dims = a.dims.slice(), shape = a.shape.slice();
  if (b) {
    b.dims.forEach((d, i) => {
      const j = dims.indexOf(d);
      if (j < 0) { dims.push(d); shape.push(b.shape[i]); }
      else if (shape[j] !== b.shape[i])
        fail(`'${d}' has size ${shape[j]} in '${a.name}' but ${b.shape[i]} in '${b.name}'.`);
    });
  }
  return { kind: "combine", a, b, bnum, op: def.op, dims, shape };
}

function resolveTransform(ds, def) {
  if (!FN_IDS.has(def.fn)) fail(`Unknown function '${def.fn}'.`);
  const src = needNumVar(ds, def.src, "a source variable");
  const scale = def.scale ?? 1, offset = def.offset ?? 0;
  if (def.fn === "scale" && (!isFin(scale) || !isFin(offset))) fail("Scale and offset must be finite numbers.");
  return { kind: "transform", src, fn: def.fn, scale, offset, dims: src.dims.slice(), shape: src.shape.slice() };
}

function resolveFormula(ds, def) {
  const text = exprStr(def.expr, FORMULA_MAX);
  if (!text.trim()) fail("The formula is empty — enter an expression.");
  try {
    return { kind: "formula", ...formulaCore(ds, def, text) };
  } catch (e) {
    if (e instanceof ExprError) fail(`Formula: ${e.message}`);
    throw e;
  }
}

// error string | null. Structure + references only (deps must be registered);
// name rules are validateName's job (registerDerived applies both).
export function validateDef(ds, def) {
  try { resolve(ds, def); return null; } catch (e) { return e.message; }
}

export function resultShape(ds, def) {
  try { const p = resolve(ds, def); return { dims: p.dims, shape: p.shape }; } catch (e) { return null; }
}

// Live check of ONE expression box: field lo|hi|lo2|hi2|center|halfwidth|
// halfwidth2 (reduce) or expr (formula). Parse + name resolution + the dims
// rule (when src/over are usable). Empty: an error only when the field is
// needed. A field the def's kind/mode does not use -> null. Message|null.
export function exprError(ds, def, field) {
  if (!isObj(def)) return null;
  const kind = def.kind ?? "reduce";
  try {
    if (field === "expr") {
      if (kind !== "formula") return null;
      const text = exprStr(def.expr, FORMULA_MAX);
      if (!text.trim()) return "Enter an expression (required).";
      formulaCore(ds, def, text);
      return null;
    }
    if (kind !== "reduce" || !WIN_FIELDS.includes(field)) return null;
    const w = canonicalWindow(def.window);
    if (!hasOwn(MODE_FIELDS, w.mode) || !MODE_FIELDS[w.mode].includes(field)) return null;
    const text = w[field];
    if (!text.trim())
      return neededFields(w.mode, def.region ?? "inside").includes(field) ? "Enter an expression (required)." : null;
    const ast = parseCached(text);
    const rd = reduceDims(ds, def);
    bindNames(ds, ast, def.name, rd && rd.dims, rd && rd.shape);
    return null;
  } catch (e) {
    return e.message;
  }
}

// The value of one expression field at result multi-index `fixed` {dim: idx}
// (missing dims -> 0, clamped): a window field (any of the seven, whatever the
// mode) over the reduce's result dims, or the formula ("expr", non-finite ->
// NaN like the stored result). NaN when it cannot be computed.
export function exprValueAt(ds, def, field, fixed) {
  if (!isObj(def)) return NaN;
  try {
    let ast, binds, dims, shape;
    if (field === "expr") {
      if (def.kind !== "formula") return NaN;
      const text = exprStr(def.expr, FORMULA_MAX);
      if (!text.trim()) return NaN;
      ({ ast, binds, dims, shape } = formulaCore(ds, def, text));
    } else if (WIN_FIELDS.includes(field) && (def.kind ?? "reduce") === "reduce") {
      const rd = reduceDims(ds, def);
      const text = canonicalWindow(def.window)[field];
      if (!rd || !text.trim()) return NaN;
      ({ dims, shape } = rd);
      ast = parseCached(text);
      binds = bindNames(ds, ast, def.name, dims, shape);
    } else return NaN;
    if (shape.some((s) => s === 0)) return NaN;
    const f = isObj(fixed) ? fixed : {};
    const idx = dims.map((d, r) => Math.max(0, Math.min((Number(own(f, d)) | 0), shape[r] - 1)));
    const v = evalExpr(ast, lookupAt(binds, dims, idx), 1)[0];
    return field === "expr" && !Number.isFinite(v) ? NaN : v;
  } catch (e) {
    return NaN;
  }
}

// ---- units / descriptions ------------------------------------------------------
export function autoUnits(ds, def) {
  if (!isObj(def)) return "";
  const u = (n) => unitsOf(getVar(ds, n));
  if (def.kind === "formula") {
    try {
      const ast = parseCached(exprStr(def.expr, FORMULA_MAX));
      return exprUnits(ast, (n) => nameUnits(ds, n));
    } catch (e) { return ""; }
  }
  if (def.kind === "combine") {
    const ua = u(def.a), ub = typeof def.b === "string" ? u(def.b) : "";
    switch (def.op) {
      case "-": return typeof def.b === "string" && isDb(ua) && isDb(ub) && norm(ua) === norm(ub) ? "dB" : ua;
      case "*": return ua && ub ? `${ua}·${ub}` : (ua || ub);
      case "/":
        if (ua && norm(ua) === norm(ub)) return "";
        if (ua && ub) return `${ua}/${ub}`;
        return ua || (ub ? `1/${ub}` : "");
      default: return ua;     // + max min
    }
  }
  if (def.kind === "transform") {
    const su = u(def.src), ns = norm(su);
    if (def.fn === "db2lin")
      return ns === "dbm" ? "mW" : ns === "dbw" ? "W" : ns === "db" ? "" : (su ? `lin(${su})` : "");
    if (def.fn === "lin2db") return ns === "mw" ? "dBm" : ns === "w" ? "dBW" : "dB";
    return su;
  }
  const su = u(def.src);
  let xu = "";
  if (def.xsrc === "coord") xu = unitsOf(numCoord(ds, def.over));
  else if (refName(def.xsrc, "var:")) xu = u(refName(def.xsrc, "var:"));
  switch (def.stat) {
    case "count": return "";
    case "argmax_x": case "argmin_x": return xu;
    case "integral": return su && xu ? `${su}·${xu}` : (su || xu);
    default: return su;
  }
}

export function effectiveUnits(ds, def) {
  return trimUnits(isObj(def) ? def.units : "") || autoUnits(ds, def);
}

// one line; expressions are shown verbatim ("?" when empty)
export function describeDef(def) {
  if (!isObj(def)) return "";
  const nm = (s) => (s === "" || s == null ? "?" : String(s));
  if (def.kind === "formula") return oneLine(exprStr(def.expr, FORMULA_MAX)) || "?";
  if (def.kind === "combine") {
    const a = nm(def.a), b = typeof def.b === "number" ? fmtG(def.b) : nm(def.b);
    if (def.op === "max" || def.op === "min") return `${def.op}(${a}, ${b})`;
    const sym = { "-": "-", "+": "+", "*": "×", "/": "÷" }[def.op] || String(def.op);
    return `${a} ${sym} ${b}`;
  }
  if (def.kind === "transform") {
    const s = nm(def.src);
    if (def.fn === "db2lin") return `10^(${s}/10)`;
    if (def.fn === "lin2db") return `10·log10(${s})`;
    if (def.fn === "abs") return `|${s}|`;
    const sc = def.scale ?? 1, off = def.offset ?? 0;
    let t = sc === 1 ? s : `${fmtG(sc)}·${s}`;
    if (off) t += off < 0 ? ` - ${fmtG(-off)}` : ` + ${fmtG(off)}`;
    return t;
  }
  let t = `${label(STATS, def.stat)} of ${nm(def.src)} over ${nm(def.over)}`;
  const w = canonicalWindow(def.window);
  const e = (s) => oneLine(s) || "?";
  let inner = "", outer = "";
  if (w.mode === "range") {
    inner = `[${e(w.lo)}, ${e(w.hi)}]`;
    outer = `[${e(w.lo2)}, ${e(w.hi2)}]`;
  } else if (w.mode === "center") {
    inner = `${e(w.center)} ± ${e(w.halfwidth)}`;
    outer = `${e(w.center)} ± ${e(w.halfwidth2)}`;
  }
  if (inner) {
    if (def.region === "outside") t += `, outside ${inner}`;
    else if (def.region === "outside_within") t += `, outside ${inner}, within ${outer}`;
    else t += `, inside ${inner}`;
  }
  if (DB_STATS.has(def.stat)) {
    if (def.db === "yes") t += " (dB data, linear-power stats)";
    else if (def.db === "no") t += " (linear data)";
  }
  return t;
}

// ---- the statistic kernel ----------------------------------------------------------
// x NaN is never a member; the inner test is inclusive at both edges
function isMember(xv, region, lo, hi, lo2, hi2) {
  const inIn = xv >= lo && xv <= hi;
  if (region === R_IN) return inIn;
  if (inIn || xv !== xv) return false;
  return region === R_OUT || (xv >= lo2 && xv <= hi2);
}

let _buf = new Float64Array(1024);        // reused scratch: no allocation per line
function scratch(n) {
  if (_buf.length < n) _buf = new Float64Array(Math.max(n, 2 * _buf.length));
  return _buf;
}

// k-th smallest of a[0..n) by in-place quickselect; afterwards a[k+1..n) >= a[k]
function selectK(a, n, k) {
  let l = 0, r = n - 1;
  while (r > l) {
    const piv = a[(l + r) >> 1];
    let i = l, j = r;
    while (i <= j) {
      while (a[i] < piv) i++;
      while (a[j] > piv) j--;
      if (i <= j) { const t = a[i]; a[i] = a[j]; a[j] = t; i++; j--; }
    }
    if (k <= j) r = j;
    else if (k >= i) l = i;
    else return a[k];
  }
  return a[k];
}

const toDb = (r) => (r > 0 ? 10 * Math.log10(r) : NaN);

// one line: sample k is y[yo + k*ys] at x[xo + k*xs]; it contributes when it is
// a region member with a finite y. Returns the statistic (non-finite -> NaN).
function kernel(y, yo, ys, x, xo, xs, n, lo, hi, lo2, hi2, region, stat, db) {
  let r = NaN;
  if (stat === S_COUNT) {
    let c = 0;
    for (let k = 0; k < n; k++) {
      if (Number.isFinite(y[yo + k * ys]) && isMember(x[xo + k * xs], region, lo, hi, lo2, hi2)) c++;
    }
    return c;
  }
  if (stat === S_MAX || stat === S_ARGMAX || stat === S_MIN || stat === S_ARGMIN) {
    const wantMax = stat === S_MAX || stat === S_ARGMAX;
    let best = wantMax ? -Infinity : Infinity, bx = NaN, found = false;
    for (let k = 0; k < n; k++) {
      const yv = y[yo + k * ys];
      if (!Number.isFinite(yv)) continue;
      const xv = x[xo + k * xs];
      if (!isMember(xv, region, lo, hi, lo2, hi2)) continue;
      if (!found || (wantMax ? yv > best : yv < best)) { best = yv; bx = xv; found = true; }  // first wins ties
    }
    if (found) r = (stat === S_MAX || stat === S_MIN) ? best : bx;
    return Number.isFinite(r) ? r : NaN;
  }
  if (stat === S_INTEGRAL) {
    let prev = false, px = 0, pv = 0, acc = 0, pairs = 0;
    for (let k = 0; k < n; k++) {
      const yv = y[yo + k * ys], xv = x[xo + k * xs];
      const ok = Number.isFinite(yv) && isMember(xv, region, lo, hi, lo2, hi2);
      if (ok) {
        const v = db ? Math.pow(10, yv / 10) : yv;
        if (prev) { acc += 0.5 * (pv + v) * Math.abs(xv - px); pairs++; }
        px = xv; pv = v;
      }
      prev = ok;
    }
    if (pairs) r = db ? toDb(acc) : acc;
    return Number.isFinite(r) ? r : NaN;
  }
  // mean / median / std / sum: gather the (linear) values
  const a = scratch(n);
  let c = 0, sum = 0;
  for (let k = 0; k < n; k++) {
    const yv = y[yo + k * ys];
    if (!Number.isFinite(yv) || !isMember(x[xo + k * xs], region, lo, hi, lo2, hi2)) continue;
    const v = db ? Math.pow(10, yv / 10) : yv;
    a[c++] = v; sum += v;
  }
  if (c === 0) return NaN;
  if (stat === S_SUM) r = sum;
  else if (stat === S_MEAN) r = sum / c;
  else if (stat === S_STD) {
    const m = sum / c;
    let ss = 0;
    for (let i = 0; i < c; i++) { const d = a[i] - m; ss += d * d; }
    r = Math.sqrt(ss / c);
  } else {                                   // median
    const h = c >> 1;
    if (c & 1) r = selectK(a, c, h);
    else {
      const lo1 = selectK(a, c, h - 1);
      let hi1 = Infinity;
      for (let i = h; i < c; i++) if (a[i] < hi1) hi1 = a[i];
      r = (lo1 + hi1) / 2;
    }
  }
  if (db) r = toDb(r);
  return Number.isFinite(r) ? r : NaN;
}

// public core: x, y array-likes of equal length; win = {lo, hi, lo2, hi2} with
// null/missing bounds = unbounded (lo > hi is swapped); region/stat ids;
// dbMode true | "yes" -> dB data (linear-power stats)
export function reduceSamples(x, y, win, region, stat, dbMode) {
  if (!x || !y || x.length !== y.length) throw new Error("x and y must have the same length");
  const rc = REGION_CODE[region], sc = STAT_CODE[stat];
  if (rc === undefined || !hasOwn(REGION_CODE, region)) throw new Error(`unknown region '${region}'`);
  if (sc === undefined || !hasOwn(STAT_CODE, stat)) throw new Error(`unknown statistic '${stat}'`);
  const w = win || {};
  const b = (v, d) => (typeof v === "number" ? v : d);
  let lo = b(w.lo, -Infinity), hi = b(w.hi, Infinity), lo2 = b(w.lo2, -Infinity), hi2 = b(w.hi2, Infinity);
  if (lo > hi) [lo, hi] = [hi, lo];
  if (lo2 > hi2) [lo2, hi2] = [hi2, lo2];
  return kernel(f64(y), 0, 1, f64(x), 0, 1, x.length, lo, hi, lo2, hi2, rc, sc,
    dbMode === true || dbMode === "yes");
}

// ---- compute ---------------------------------------------------------------------
// per-result-dim strides of variable v (0 for dims v lacks)
const stridesIn = (v, dims) => {
  const s = stridesOf(v.shape);
  return dims.map((d) => { const i = v.dims.indexOf(d); return i < 0 ? 0 : s[i]; });
};

// arrays + strides for walking a reduce: src and x addressed by the result
// multi-index (strides per result dim) plus a step along `over`
function prepareReduce(ds, p) {
  const { src, ax, dims, n } = p;
  const q = { y: f64(src.data), step: stridesOf(src.shape)[ax], sStr: stridesIn(src, dims) };
  if (p.xkind === "var") {
    q.x = scaled(p.xv);
    q.xStep = stridesOf(p.xv.shape)[p.xv.dims.indexOf(p.over)];
    q.xStr = stridesIn(p.xv, dims);
  } else {
    q.x = p.xkind === "coord" ? scaled(p.xv) : iota(n);
    q.xStep = 1; q.xStr = dims.map(() => 0);
  }
  return q;
}

// The needed window expressions, each evaluated ONCE: over the whole result
// (idx null; Float64Array(total) per field) or at one result multi-index
// (Float64Array(1)). Same arithmetic either way.
function windowValues(p, idx) {
  const W = {};
  const n = idx ? 1 : prod(p.shape);
  for (const f of p.win) {
    W[f.field] = evalExpr(f.ast, idx ? lookupAt(f.binds, p.dims, idx) : lookupAll(f.binds, p.dims, p.shape), n);
  }
  return W;
}

// Window bounds of result element i into B = [lo, hi, lo2, hi2]. range: lo/hi
// sorted; center: m ∓ |hw|. Returns false when the window is undefined there:
// a needed EXPRESSION value is NaN/±Inf (e.g. a NaN center). Finite values
// whose m ± |hw| overflows give an infinite edge, not an undefined window
// (as bc9812f's relative windows did).
function bounds(p, W, i, B) {
  let lo = -Infinity, hi = Infinity, lo2 = -Infinity, hi2 = Infinity, ok = true;
  if (p.mode === "range") {
    const a = W.lo[i], b = W.hi[i];
    lo = Math.min(a, b); hi = Math.max(a, b);
    ok = Number.isFinite(a) && Number.isFinite(b);
    if (p.ow) {
      const a2 = W.lo2[i], b2 = W.hi2[i];
      lo2 = Math.min(a2, b2); hi2 = Math.max(a2, b2);
      ok = ok && Number.isFinite(a2) && Number.isFinite(b2);
    }
  } else if (p.mode === "center") {
    const m = W.center[i], h = W.halfwidth[i], hw = Math.abs(h);
    lo = m - hw; hi = m + hw;
    ok = Number.isFinite(m) && Number.isFinite(h);
    if (p.ow) {
      const h2 = W.halfwidth2[i], hw2 = Math.abs(h2);
      lo2 = m - hw2; hi2 = m + hw2;
      ok = ok && Number.isFinite(h2);
    }
  }
  B[0] = lo; B[1] = hi; B[2] = lo2; B[3] = hi2;
  return ok;
}

function computeReduce(ds, p) {
  const q = prepareReduce(ds, p);
  const { y, step, sStr, x, xStep, xStr } = q;
  const nr = p.dims.length, rshape = p.shape, total = prod(rshape), n = p.n;
  const region = REGION_CODE[p.region], stat = STAT_CODE[p.stat], db = p.db;
  const W = windowValues(p, null), B = new Float64Array(4);
  const out = new Float64Array(total);
  const idx = new Int32Array(nr);
  let oS = 0, oX = 0;
  for (let f = 0; f < total; f++) {
    // an undefined window has no members in ANY region (inside or outside)
    // -> NaN (count 0)
    out[f] = !bounds(p, W, f, B) ? (stat === S_COUNT ? 0 : NaN)
      : kernel(y, oS, step, x, oX, xStep, n, B[0], B[1], B[2], B[3], region, stat, db);
    for (let d = nr - 1; d >= 0; d--) {        // odometer over the result dims
      oS += sStr[d]; oX += xStr[d];
      if (++idx[d] < rshape[d]) break;
      oS -= sStr[d] * rshape[d]; oX -= xStr[d] * rshape[d];
      idx[d] = 0;
    }
  }
  return out;
}

function computeCombine(ds, p) {
  const { dims, shape } = p;
  const total = prod(shape), nd = dims.length;
  const A = f64(p.a.data), aStr = stridesIn(p.a, dims);
  const B = p.b ? f64(p.b.data) : Float64Array.of(p.bnum);
  const bStr = p.b ? stridesIn(p.b, dims) : dims.map(() => 0);
  const opc = ["-", "+", "*", "/", "max", "min"].indexOf(p.op);
  const out = new Float64Array(total);
  const idx = new Int32Array(nd);
  let oA = 0, oB = 0;
  for (let f = 0; f < total; f++) {
    const a = A[oA], b = B[oB];
    let r;
    switch (opc) {
      case 0: r = a - b; break;
      case 1: r = a + b; break;
      case 2: r = a * b; break;
      case 3: r = a / b; break;
      case 4: r = Math.max(a, b); break;          // NaN-propagating
      default: r = Math.min(a, b);
    }
    out[f] = Number.isFinite(r) ? r : NaN;
    for (let d = nd - 1; d >= 0; d--) {
      oA += aStr[d]; oB += bStr[d];
      if (++idx[d] < shape[d]) break;
      oA -= aStr[d] * shape[d]; oB -= bStr[d] * shape[d];
      idx[d] = 0;
    }
  }
  return out;
}

function computeTransform(ds, p) {
  const X = f64(p.src.data), n = X.length;
  const out = new Float64Array(n);
  const { fn, scale, offset } = p;
  for (let i = 0; i < n; i++) {
    const v = X[i];
    let r;
    if (fn === "db2lin") r = Math.pow(10, v / 10);
    else if (fn === "lin2db") r = v > 0 ? 10 * Math.log10(v) : NaN;
    else if (fn === "scale") r = v * scale + offset;
    else r = Math.abs(v);
    out[i] = Number.isFinite(r) ? r : NaN;
  }
  return out;
}

// the whole formula in one vectorized pass over the result
function computeFormula(ds, p) {
  const total = prod(p.shape);
  const out = evalExpr(p.ast, lookupAll(p.binds, p.dims, p.shape), total);
  for (let i = 0; i < total; i++) if (!Number.isFinite(out[i])) out[i] = NaN;
  return out;
}

// { dims, shape, data: Float64Array, attrs: {units, long_name} }; throws Error(msg)
export function computeDef(ds, def) {
  const p = resolve(ds, def);
  const data = p.kind === "reduce" ? computeReduce(ds, p)
    : p.kind === "combine" ? computeCombine(ds, p)
      : p.kind === "formula" ? computeFormula(ds, p) : computeTransform(ds, p);
  const desc = typeof def.description === "string" ? def.description.trim() : "";
  return { dims: p.dims.slice(), shape: p.shape.slice(), data,
    attrs: { units: effectiveUnits(ds, def), long_name: desc || describeDef(def) } };
}

// ---- registration on a Dataset -------------------------------------------------
export function unregisterDerived(ds) {
  if (!ds || !ds.vars) return;
  for (const n of Object.keys(ds.vars)) if (ds.vars[n] && ds.vars[n].derived) delete ds.vars[n];
}

// Drop every derived var from ds, then compute + register `defs` (this file's)
// in dependency order. Returns Map(name -> {ok, error, shape}). A def fails on a
// bad name, a cycle, an invalid/missing reference, or a failed dependency; its
// dependents then fail too. Duplicate names: the first def wins. At most
// MAX_DERIVED defs are considered.
export function registerDerived(ds, defs) {
  const status = new Map();
  if (!ds || !ds.vars) return status;
  unregisterDerived(ds);
  const bad = (name, error) => status.set(name, { ok: false, error, shape: null });
  const list = [];
  for (const d of (defs || []).slice(0, MAX_DERIVED)) {
    if (!isObj(d)) continue;
    const name = typeof d.name === "string" ? d.name : "";
    if (status.has(name) || list.some((e) => e.name === name)) continue;
    const e = validateName(ds, [], name, name);     // (a function-named old def is kept)
    if (e) { bad(name, e); continue; }
    list.push(d);
  }
  const { order, errors } = topoOrder(list);
  for (const [n, msg] of errors) bad(n, msg);
  for (const d of order) {
    // a dep that is a failed def fails this one too — unless the name means
    // something else here (a real variable, a dimension). A failed def named
    // pi does fail its dependents (as in bc9812f and the Python script): the
    // reference meant that def, not the constant.
    const dep = depsOf(d).find((n) => !getVar(ds, n) && !hasOwn(ds.dims, n)
      && status.has(n) && !status.get(n).ok);
    if (dep) { bad(d.name, `depends on '${dep}', which has an error`); continue; }
    try {
      const r = computeDef(ds, d);
      const v = new Variable(d.name, { dims: r.dims, shape: r.shape, attrs: r.attrs,
        dtype: "double", numeric: true, data: r.data });
      v.derived = true;
      v.def = canonicalDef(d);
      ds.vars[d.name] = v;
      status.set(d.name, { ok: true, error: null, shape: r.shape.slice() });
    } catch (e) { bad(d.name, e.message); }
  }
  return status;
}

// Rename every reference to oldName in `def` (mutated; also returned): src, a,
// b, an x source var:<old>, the window expressions and the formula. `over` is a
// dimension and never renamed. A legacy window is migrated first.
export function renameRef(def, oldName, newName) {
  if (!isObj(def) || typeof oldName !== "string" || !oldName || typeof newName !== "string"
    || oldName === newName) return def;
  const kind = def.kind ?? "reduce";
  if ((kind === "reduce" || kind === "transform") && def.src === oldName) def.src = newName;
  if (kind === "combine") {
    if (def.a === oldName) def.a = newName;
    if (def.b === oldName) def.b = newName;
  }
  if (kind === "formula" && typeof def.expr === "string") def.expr = renameInExpr(def.expr, oldName, newName);
  if (kind === "reduce") {
    if (def.xsrc === "var:" + oldName) def.xsrc = "var:" + newName;
    if (isObj(def.window)) {
      const w = isLegacyWindow(def.window) ? migrateWindow(def.window) : def.window;
      for (const f of WIN_FIELDS) if (typeof w[f] === "string") w[f] = renameInExpr(w[f], oldName, newName);
      def.window = w;
    }
  }
  return def;
}

// ---- builder helpers -------------------------------------------------------------
// x sources for reducing `src` over `over` (same rule as a trace's x sources)
export function xSourceOptions(ds, src, over) {
  const v = getVar(ds, src);
  const out = ["index"];
  if (!v) return out;
  if (numCoord(ds, over)) out.push("coord");
  for (const [n, xv] of Object.entries(ds.vars)) {
    if (n === src || !isNumVar(xv) || !xv.dims.includes(over)) continue;
    if (xv.dims.every((d) => v.dims.includes(d))) out.push("var:" + n);
  }
  return out;
}

// Best default x source. Deviation from a plain "coord first": a coordinate
// that is just 0..n-1 (e.g. darpa.nc's TraceIndex) carries no information, so a
// unique parallel x array (darpa's `frequencies`) is preferred over it.
export function suggestXsrc(ds, src, over) {
  const opts = xSourceOptions(ds, src, over);
  const cv = opts.includes("coord") ? numCoord(ds, over) : null;
  const indexLike = cv && Array.prototype.every.call(cv.data, (val, i) => Number(val) === i);
  if (cv && !indexLike) return "coord";
  const cands = opts.filter((o) => o.startsWith("var:") && o.slice(4) !== over);
  // file variables first: a derived result rarely is an x axis
  const real = cands.filter((o) => !ds.vars[o.slice(4)].derived);
  const vars = real.length ? real : cands;
  const ol = String(over).toLowerCase();
  const pref = vars.filter((o) => {
    const n = o.slice(4).toLowerCase();
    return /freq|wl|time/.test(n) || (ol && n.includes(ol));
  });
  if (vars.length === 1) return vars[0];
  if (pref.length === 1) return pref[0];
  return cv ? "coord" : "index";
}

// (bc9812f window-center sources; kept for compatibility — the expression
// builder uses windowNames) each remaining dim's coordinate (index if it has
// none) and every numeric var whose dims are a subset of the result dims
export function centerSourceOptions(ds, src, over) {
  const v = getVar(ds, src);
  if (!v) return [];
  const rdims = v.dims.filter((d) => d !== over);
  const out = rdims.map((d) => "coord:" + d);
  for (const [n, cv] of Object.entries(ds.vars)) {
    if (n === src || !isNumVar(cv) || rdims.includes(n)) continue;
    if (cv.dims.every((d) => rdims.includes(d))) out.push("var:" + n);
  }
  return out;
}

// name-picker entries: {name, dims, units, isDim, label}; isDim = the name is a
// dimension without a numeric coordinate variable (it stands for the index)
const varEntry = (n, v) => {
  const units = unitsOf(v);
  return { name: n, dims: v.dims.slice(), units, isDim: false, label: units ? `${n} [${units}]` : n };
};
const dimEntry = (d) => ({ name: d, dims: [d], units: "", isDim: true, label: `${d} [index]` });

// names usable in the window expressions of a reduce of `src` over `over`: the
// remaining dims (as their numeric coordinate variable when there is one, else
// the index) first, then every numeric var whose dims are remaining dims
export function windowNames(ds, src, over) {
  const v = getVar(ds, src);
  if (!ds || !isNumVar(v) || !v.dims.includes(over)) return [];
  const rd = reduceDims(ds, { src, over });
  if (!rd) return [];
  const usable = (cv) => cv.dims.every((d) => {
    const j = rd.dims.indexOf(d);
    return j >= 0 && dimSize(cv, d) === rd.shape[j];
  });
  const out = [], seen = new Set();
  for (const d of rd.dims) {
    seen.add(d);
    const cv = numCoord(ds, d);              // a dim name = its coordinate, else its index
    if (cv) { if (usable(cv)) out.push(varEntry(d, cv)); }
    else out.push(dimEntry(d));
  }
  for (const [n, cv] of Object.entries(ds.vars)) {
    if (seen.has(n) || n === src || !isNumVar(cv) || hasOwn(ds.dims, n)) continue;
    if (usable(cv)) out.push(varEntry(n, cv));
  }
  return out;
}

// names usable in a formula: every numeric variable (file order) — except one
// named like a dimension that is not its coordinate (the name means the index)
// — then every dimension without a numeric coordinate variable
export function formulaNames(ds) {
  if (!ds || !ds.vars) return [];
  const out = [];
  for (const [n, v] of Object.entries(ds.vars)) {
    if (isNumVar(v) && (!hasOwn(ds.dims, n) || numCoord(ds, n))) out.push(varEntry(n, v));
  }
  for (const d of Object.keys(ds.dims || {})) if (!numCoord(ds, d)) out.push(dimEntry(d));
  return out;
}

// Builder preview of one reduce line at result multi-index `fixed` {dim: idx}
// (missing dims -> 0, clamped). member = region membership by x (whether or not
// y is finite); inner/outer = the window bounds actually used (outer only for
// outside_within; both null when the window is undefined there); center = the
// evaluated center expression (center mode) or null.
export function previewSlice(ds, def, fixed) {
  const p = resolve(ds, def);
  if (p.kind !== "reduce") throw new Error("Preview is only available for window statistics.");
  if (p.shape.some((s) => s === 0)) throw new Error("The result has a dimension of size 0.");
  const q = prepareReduce(ds, p);
  const f = isObj(fixed) ? fixed : {};
  const idx = p.dims.map((d, r) => Math.max(0, Math.min((Number(own(f, d)) | 0), p.shape[r] - 1)));
  let oS = 0, oX = 0;
  idx.forEach((i, r) => { oS += i * q.sStr[r]; oX += i * q.xStr[r]; });
  const W = windowValues(p, idx), B = new Float64Array(4);
  const ok = bounds(p, W, 0, B);
  const [lo, hi, lo2, hi2] = B;
  const center = p.mode === "center" ? W.center[0] : null;
  const n = p.n, region = REGION_CODE[p.region];
  const x = new Float64Array(n), y = new Float64Array(n), member = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    x[k] = q.x[oX + k * q.xStep];
    y[k] = q.y[oS + k * q.step];
    member[k] = ok && isMember(x[k], region, lo, hi, lo2, hi2) ? 1 : 0;
  }
  const args = [q.y, oS, q.step, q.x, oX, q.xStep, n, lo, hi, lo2, hi2, region];
  return {
    x, y, member,
    inner: p.mode === "none" || !ok ? null : [lo, hi],
    outer: p.mode !== "none" && ok && p.ow ? [lo2, hi2] : null,
    center,
    value: !ok ? (p.stat === "count" ? 0 : NaN) : kernel(...args, STAT_CODE[p.stat], p.db),
    count: !ok ? 0 : kernel(...args, S_COUNT, false),
    db: p.db,
  };
}
