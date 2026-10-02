// derive.js — derived quantities: virtual variables computed from the ones in a
// Dataset. Three kinds of definition ("def"): a windowed statistic over one dim
// (reduce), an elementwise binary op broadcast by dim NAME (combine), and a
// unary function (transform). A computed def is registered as an ordinary
// numeric Variable (flag .derived, .def = canonical def) in ds.vars, so traces,
// x sources and sweep sources use it like any other variable; defs may chain.
// Pure: no DOM, no Node APIs — the same module runs in the browser and in the
// Node tests. The semantics are mirrored by the Python report script, so any
// change here must be made there too.

import { Variable } from "./dataset.js";
import { asFloatArray } from "./explore.js";

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
  { id: "fixed", label: "Fixed x range" },
  { id: "relative", label: "Relative to a coordinate/variable" },
];
export const DB_MODES = [
  { id: "auto", label: "Auto (from units)" },
  { id: "yes", label: "dB data: average in linear power" },
  { id: "no", label: "Linear data" },
];
export const MAX_DERIVED = 256;
export const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_ .+\-]{0,63}$/;

const KINDS = ["reduce", "combine", "transform"];
const idSet = (list) => new Set(list.map((e) => e.id));
const STAT_IDS = idSet(STATS), REGION_IDS = idSet(REGIONS), OP_IDS = idSet(OPS),
  FN_IDS = idSet(TRANSFORMS), MODE_IDS = idSet(WINDOW_MODES), DB_IDS = idSet(DB_MODES);
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
const iota = (n) => { const a = new Float64Array(n); for (let i = 0; i < n; i++) a[i] = i; return a; };
// names that are Object.prototype members ("__proto__", "constructor", ...) are
// refused: ds.vars is a plain object, so ds.vars["__proto__"] = v would replace
// its prototype instead of adding a variable
const reserved = (name) => hasOwn(Object.prototype, name);
const sameFile = (ds, d) => !d.file || !ds || !ds.filename || d.file === ds.filename;
const refName = (s, pre) => (typeof s === "string" && s.startsWith(pre) ? s.slice(pre.length) : null);

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

// ---- def records ------------------------------------------------------------
const head = (d, kind) => ({
  name: d.name, file: d.file, kind, units: d.units, description: d.description,
});

export function newDef(kind, file) {
  const base = { name: "", file: String(file ?? ""), units: "", description: "" };
  if (kind === "combine") return { ...head(base, "combine"), a: "", op: "-", b: "" };
  if (kind === "transform")
    return { ...head(base, "transform"), src: "", fn: "db2lin", scale: 1, offset: 0 };
  return {        // unknown kinds get a reduce (the main use)
    ...head(base, "reduce"), src: "", over: "", xsrc: "index",
    window: { mode: "none", lo: null, hi: null, lo2: null, hi2: null, center: "", k: 1,
      offset: 0, halfwidth: null, halfwidth2: null },
    region: "inside", stat: "max", db: "auto",
  };
}

// deep copy in canonical key order (§1.1). No validation: values are copied
// as-is (missing ones take the newDef defaults), so a half-edited def survives.
export function canonicalDef(def) {
  const d = isObj(def) ? def : {};
  const kind = own(d, "kind") === undefined ? "reduce" : own(d, "kind");
  const dflt = newDef(KINDS.includes(kind) ? kind : "reduce", "");
  const pick = (o, base, k) => (own(o, k) === undefined ? base[k] : own(o, k));
  const out = {};
  for (const k of Object.keys(dflt)) {
    if (k === "kind") { out.kind = kind; continue; }
    if (k === "window") {
      const w = isObj(own(d, "window")) ? d.window : {};
      out.window = {};
      for (const wk of Object.keys(dflt.window)) out.window[wk] = pick(w, dflt.window, wk);
      continue;
    }
    out[k] = pick(d, dflt, k);
  }
  return out;
}

// Parse an untrusted def (e.g. from a project file) into a canonical def, or
// null. Policy: only own properties are read (so "__proto__"/"constructor"
// keys can't inject anything — they are simply never looked at) and the output
// is a fresh object literal.
//  - kind must be reduce|combine|transform, and the name must match NAME_RE
//    after trimming/capping to 64 chars — otherwise null.
//  - enum fields (stat, region, db, window.mode, op, fn, xsrc, window.center):
//    a MISSING value takes the default; a present but unrecognized value
//    rejects the def (substituting a default would silently change what is
//    computed — better to drop it).
//  - free strings (file, units, description) of the wrong type become "";
//    capped: units 32 (trimmed), description 200, file and var names 256.
//  - var-name fields (src, over, a, b) of the wrong type become "" (the def is
//    kept and validateDef reports it, so the user can repair it); b may also be
//    a finite number.
//  - number fields: finite numbers or null (lo/hi/lo2/hi2/halfwidth/2);
//    k/scale default 1 and offset 0 when not a finite number.
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
  const ref = (v, prefixes, d) => {              // "<prefix><name>" with 1..256 name chars
    if (v === undefined || v === d) return d;
    if (typeof v !== "string") return undefined;
    if (prefixes.fixed && prefixes.fixed.includes(v)) return v;
    for (const p of prefixes.refs) {
      if (v.startsWith(p) && v.length > p.length) return p + v.slice(p.length, p.length + 256);
    }
    return undefined;
  };
  const xsrc = ref(own(raw, "xsrc"), { fixed: ["index", "coord"], refs: ["var:"] }, "index");
  let w = own(raw, "window");
  if (w === undefined) w = {};
  if (!isObj(w)) return null;
  const mode = en(own(w, "mode"), MODE_IDS, "none");
  const center = ref(own(w, "center"), { refs: ["coord:", "var:"] }, "");
  const region = en(own(raw, "region"), REGION_IDS, "inside");
  const stat = en(own(raw, "stat"), STAT_IDS, "max");
  const db = en(own(raw, "db"), DB_IDS, "auto");
  if ([xsrc, mode, center, region, stat, db].includes(undefined)) return null;
  const nn = (k) => numOr(own(w, k), null);
  return {
    ...out, src: vname(own(raw, "src")), over: vname(own(raw, "over")), xsrc,
    window: { mode, lo: nn("lo"), hi: nn("hi"), lo2: nn("lo2"), hi2: nn("hi2"), center,
      k: numOr(own(w, "k"), 1), offset: numOr(own(w, "offset"), 0),
      halfwidth: nn("halfwidth"), halfwidth2: nn("halfwidth2") },
    region, stat, db,
  };
}

// var names a def reads (src / a / b / x source / center), deduped, in order
export function depsOf(def) {
  if (!isObj(def)) return [];
  const out = [];
  const add = (n) => { if (typeof n === "string" && n && !out.includes(n)) out.push(n); };
  if (def.kind === "combine") { add(def.a); add(def.b); }
  else if (def.kind === "transform") add(def.src);
  else {
    add(def.src);
    add(refName(def.xsrc, "var:"));
    add(refName(isObj(def.window) ? def.window.center : "", "var:"));
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

// name rules (§1): pattern, not a real variable or a dim of this file, unique
// among this file's defs (`ignoreName` = the def being renamed/edited)
export function validateName(ds, defs, name, ignoreName) {
  if (typeof name !== "string" || !name.trim()) return "Enter a name.";
  if (!NAME_RE.test(name))
    return "Names start with a letter, digit or _, then letters, digits, space, _ . + - (max 64 characters).";
  if (reserved(name)) return `'${name}' is a reserved name.`;
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
  return resolveReduce(ds, def);
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

  const w = isObj(def.window) ? def.window : {};
  const mode = own(w, "mode") ?? "none", region = def.region ?? "inside", stat = def.stat ?? "max";
  const db = def.db ?? "auto";
  if (!MODE_IDS.has(mode)) fail(`Unknown window mode '${mode}'.`);
  if (!REGION_IDS.has(region)) fail(`Unknown region '${region}'.`);
  if (!STAT_IDS.has(stat)) fail(`Unknown statistic '${stat}'.`);
  if (!DB_IDS.has(db)) fail(`Unknown dB mode '${db}'.`);
  if (mode === "none" && region !== "inside") fail("An 'outside' region needs a window.");
  const ow = region === "outside_within";
  const num = (k) => {
    const v = own(w, k);
    return v == null ? null : (isFin(v) ? v : fail(`Window ${k} must be a finite number.`));
  };
  const plan = { kind: "reduce", src, ax, over, n, dims, shape, xkind, xv, mode, region, stat,
    db: db === "yes" || (db === "auto" && isDb(unitsOf(src))) };

  if (mode === "fixed") {
    const lo = num("lo"), hi = num("hi");
    if (lo === null || hi === null) fail("A fixed window needs both lo and hi.");
    plan.lo = Math.min(lo, hi); plan.hi = Math.max(lo, hi);
    const lo2 = num("lo2"), hi2 = num("hi2");
    if (ow && (lo2 === null || hi2 === null)) fail("'Within outer span' needs the outer lo and hi.");
    plan.lo2 = lo2 === null ? -Infinity : Math.min(lo2, hi2 ?? lo2);
    plan.hi2 = hi2 === null ? Infinity : Math.max(hi2, lo2 ?? hi2);
  } else if (mode === "relative") {
    const c = own(w, "center");
    const cdim = refName(c, "coord:"), cname = refName(c, "var:");
    if (cdim) {
      if (!dims.includes(cdim)) fail(`Window center '${cdim}' is not a remaining dimension of the result.`);
      const cv = numCoord(ds, cdim);
      plan.ckind = "coord"; plan.cdim = cdim;
      plan.cv = cv && cv.shape[0] === shape[dims.indexOf(cdim)] ? cv : null;
    } else if (cname) {
      const cv = needNumVar(ds, cname, "a window center");
      for (const d of cv.dims) {
        if (!dims.includes(d)) fail(`Window center '${cname}' has dimension '${d}', which the result lacks.`);
        if (dimSize(cv, d) !== shape[dims.indexOf(d)]) fail(`'${d}' has a different size in '${cname}'.`);
      }
      plan.ckind = "var"; plan.cv = cv;
    } else fail("Choose the window center (a coordinate or variable).");
    const hw = num("halfwidth"), hw2 = num("halfwidth2");
    if (hw === null) fail("A relative window needs a half width.");
    if (ow && hw2 === null) fail("'Within outer span' needs the outer half width.");
    plan.hw = Math.abs(hw); plan.hw2 = hw2 === null ? Infinity : Math.abs(hw2);
    const k = own(w, "k") ?? 1, off = own(w, "offset") ?? 0;
    if (!isFin(k) || !isFin(off)) fail("Window k and offset must be finite numbers.");
    plan.k = k; plan.off = off;
  } else {
    plan.lo = -Infinity; plan.hi = Infinity; plan.lo2 = -Infinity; plan.hi2 = Infinity;
  }
  return plan;
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

// error string | null. Structure + references only (deps must be registered);
// name rules are validateName's job (registerDerived applies both).
export function validateDef(ds, def) {
  try { resolve(ds, def); return null; } catch (e) { return e.message; }
}

export function resultShape(ds, def) {
  try { const p = resolve(ds, def); return { dims: p.dims, shape: p.shape }; } catch (e) { return null; }
}

// ---- units / descriptions ------------------------------------------------------
export function autoUnits(ds, def) {
  if (!isObj(def)) return "";
  const u = (n) => unitsOf(getVar(ds, n));
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

export function describeDef(def) {
  if (!isObj(def)) return "";
  const nm = (s) => (s === "" || s == null ? "?" : String(s));
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
  const w = isObj(def.window) ? def.window : {};
  const g = (x) => (isFin(x) ? fmtG(x) : "?");
  let inner = "", outer = "";
  if (w.mode === "fixed") {
    const lo = isFin(w.lo) && isFin(w.hi) ? Math.min(w.lo, w.hi) : w.lo;
    const hi = isFin(w.lo) && isFin(w.hi) ? Math.max(w.lo, w.hi) : w.hi;
    inner = `[${g(lo)}, ${g(hi)}]`;
    const lo2 = isFin(w.lo2) && isFin(w.hi2) ? Math.min(w.lo2, w.hi2) : w.lo2;
    const hi2 = isFin(w.lo2) && isFin(w.hi2) ? Math.max(w.lo2, w.hi2) : w.hi2;
    outer = `[${g(lo2)}, ${g(hi2)}]`;
  } else if (w.mode === "relative") {
    const c = refName(w.center, "coord:") || refName(w.center, "var:") || "?";
    const k = own(w, "k") ?? 1, off = own(w, "offset") ?? 0;
    let m = k === 1 ? c : `${g(k)}·${c}`;
    if (off) m += off < 0 ? ` - ${g(-off)}` : ` + ${g(off)}`;
    inner = `${m} ± ${isFin(w.halfwidth) ? fmtG(Math.abs(w.halfwidth)) : "?"}`;
    outer = `${m} ± ${isFin(w.halfwidth2) ? fmtG(Math.abs(w.halfwidth2)) : "?"}`;
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

// arrays + strides for walking a reduce: src, x and center addressed by the
// result multi-index (strides per result dim) plus a step along `over`
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
  if (p.mode === "relative") {
    if (p.ckind === "var") { q.c = scaled(p.cv); q.cStr = stridesIn(p.cv, dims); }
    else {
      q.c = p.cv ? scaled(p.cv) : iota(p.shape[dims.indexOf(p.cdim)]);
      q.cStr = dims.map((d) => (d === p.cdim ? 1 : 0));
    }
  } else { q.c = null; q.cStr = dims.map(() => 0); }
  return q;
}

function computeReduce(ds, p) {
  const q = prepareReduce(ds, p);
  const { y, step, sStr, x, xStep, xStr, c, cStr } = q;
  const nr = p.dims.length, rshape = p.shape, total = prod(rshape), n = p.n;
  const region = REGION_CODE[p.region], stat = STAT_CODE[p.stat], db = p.db;
  const rel = p.mode === "relative";
  const out = new Float64Array(total);
  const idx = new Int32Array(nr);
  let oS = 0, oX = 0, oC = 0;
  let lo = p.lo, hi = p.hi, lo2 = p.lo2, hi2 = p.hi2;
  for (let f = 0; f < total; f++) {
    let undef = false;
    if (rel) {
      const m = p.k * c[oC] + p.off;
      lo = m - p.hw; hi = m + p.hw; lo2 = m - p.hw2; hi2 = m + p.hw2;
      undef = !Number.isFinite(m);
    }
    // a relative window around a NaN center is undefined: no sample is a
    // member of ANY region (inside or outside) -> NaN (count 0)
    out[f] = undef ? (stat === S_COUNT ? 0 : NaN)
      : kernel(y, oS, step, x, oX, xStep, n, lo, hi, lo2, hi2, region, stat, db);
    for (let d = nr - 1; d >= 0; d--) {        // odometer over the result dims
      oS += sStr[d]; oX += xStr[d]; oC += cStr[d];
      if (++idx[d] < rshape[d]) break;
      oS -= sStr[d] * rshape[d]; oX -= xStr[d] * rshape[d]; oC -= cStr[d] * rshape[d];
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

// { dims, shape, data: Float64Array, attrs: {units, long_name} }; throws Error(msg)
export function computeDef(ds, def) {
  const p = resolve(ds, def);
  const data = p.kind === "reduce" ? computeReduce(ds, p)
    : p.kind === "combine" ? computeCombine(ds, p) : computeTransform(ds, p);
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
    const e = validateName(ds, [], name);
    if (e) { bad(name, e); continue; }
    list.push(d);
  }
  const { order, errors } = topoOrder(list);
  for (const [n, msg] of errors) bad(n, msg);
  for (const d of order) {
    // a dep that is a failed def (and not a real variable) fails this one too
    const dep = depsOf(d).find((n) => !getVar(ds, n) && status.has(n) && !status.get(n).ok);
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

// window-center sources: each remaining dim's coordinate (index if it has
// none) and every numeric var whose dims are a subset of the result dims
// (a dim's own coordinate variable is listed once, as coord:<dim>)
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

// Builder preview of one reduce line at result multi-index `fixed` {dim: idx}
// (missing dims -> 0, clamped). member = region membership by x (whether or not
// y is finite); inner/outer = the window bounds actually used (outer only for
// outside_within); center = the window center k·c + offset (relative mode).
export function previewSlice(ds, def, fixed) {
  const p = resolve(ds, def);
  if (p.kind !== "reduce") throw new Error("Preview is only available for window statistics.");
  if (p.shape.some((s) => s === 0)) throw new Error("The result has a dimension of size 0.");
  const q = prepareReduce(ds, p);
  const f = isObj(fixed) ? fixed : {};
  let oS = 0, oX = 0, oC = 0;
  p.dims.forEach((d, r) => {
    const i = Math.max(0, Math.min((Number(own(f, d)) | 0), p.shape[r] - 1));
    oS += i * q.sStr[r]; oX += i * q.xStr[r]; oC += i * q.cStr[r];
  });
  let { lo, hi, lo2, hi2 } = p, center = null;
  if (p.mode === "relative") {
    center = p.k * q.c[oC] + p.off;
    lo = center - p.hw; hi = center + p.hw; lo2 = center - p.hw2; hi2 = center + p.hw2;
  }
  const n = p.n, region = REGION_CODE[p.region];
  const undef = center !== null && !Number.isFinite(center);    // NaN center: nothing is a member
  const x = new Float64Array(n), y = new Float64Array(n), member = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    x[k] = q.x[oX + k * q.xStep];
    y[k] = q.y[oS + k * q.step];
    member[k] = !undef && isMember(x[k], region, lo, hi, lo2, hi2) ? 1 : 0;
  }
  const args = [q.y, oS, q.step, q.x, oX, q.xStep, n, lo, hi, lo2, hi2, region];
  return {
    x, y, member,
    inner: p.mode === "none" || undef ? null : [lo, hi],
    outer: p.mode !== "none" && !undef && p.region === "outside_within" ? [lo2, hi2] : null,
    center,
    value: undef ? (p.stat === "count" ? 0 : NaN) : kernel(...args, STAT_CODE[p.stat], p.db),
    count: undef ? 0 : kernel(...args, S_COUNT, false),
    db: p.db,
  };
}
