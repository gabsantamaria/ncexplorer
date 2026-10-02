// derive.test.mjs — tests for docs/js/derive.js (derived quantities).
//   node tests/derive.test.mjs            (exit code 1 on any failure)
// (a) reduceSamples semantics, (b) computeDef/registerDerived on synthetic
// Datasets — expression windows, formulas, builder helpers, (c) sanitizeDef/
// canonicalDef incl. the migration of bc9812f (legacy) windows, (d) the real
// lab files in tests/data (skipped when missing), (d2) legacy defs computed by
// the bc9812f engine (from git) vs the migrated defs here — identical numbers,
// (e) performance, (f) a cross-check of the real-file defs against
// tests/xcheck_derive.py, an independent numpy/xarray implementation (python
// from $NCX_PYTHON, skipped when unavailable).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { check, skip, summary, loadDataset, haveData, dataFile, PYTHON, moduleUrl, REPO } from "./node_env.mjs";

const D = await import(moduleUrl("derive.js"));
const { Dataset, Variable } = await import(moduleUrl("dataset.js"));

const isNaNum = (v) => typeof v === "number" && Number.isNaN(v);
const near = (a, b, rel = 1e-12) => (isNaNum(a) && isNaNum(b)) || a === b
  || (Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= rel * Math.max(Math.abs(a), Math.abs(b)));
const allNear = (a, b, rel) => a.length === b.length && Array.from(a).every((v, i) => near(v, b[i], rel));
// bitwise-equal arrays (NaN == NaN)
const same = (a, b) => a.length === b.length && Array.from(a).every((v, i) => v === b[i] || (isNaNum(v) && isNaNum(b[i])));
const lin = (d) => Math.pow(10, d / 10);
const todb = (l) => 10 * Math.log10(l);
const show = (a) => JSON.stringify(Array.from(a, (v) => (Number.isNaN(v) ? "NaN" : v)));
const J = (x) => JSON.stringify(x);

// =============================================================================
// (a) reduceSamples
// =============================================================================
{
  const R = D.reduceSamples;
  const x = [0, 1, 2, 3, 4, 5, 6];
  const y = [1, 5, 3, 5, 2, 7, 4];
  const w = { lo: 1, hi: 3 };
  check("a: max inside, inclusive edges", R(x, y, w, "inside", "max", false) === 5);
  check("a: argmax_x first of ties", R(x, y, w, "inside", "argmax_x", false) === 1);
  check("a: min inside", R(x, y, w, "inside", "min", false) === 3);
  check("a: argmin_x inside", R(x, y, w, "inside", "argmin_x", false) === 2);
  check("a: count inside counts both edges", R(x, y, w, "inside", "count", false) === 3);
  check("a: sum inside", R(x, y, w, "inside", "sum", false) === 13);
  check("a: mean inside", near(R(x, y, w, "inside", "mean", false), 13 / 3));
  check("a: median inside (odd)", R(x, y, w, "inside", "median", false) === 5);
  check("a: std inside (population)", near(R(x, y, w, "inside", "std", false), Math.sqrt(8 / 9)));
  check("a: integral inside", R(x, y, w, "inside", "integral", false) === 0.5 * (5 + 3) + 0.5 * (3 + 5));
  // outside [1,3]: x = 0,4,5,6 -> y 1,2,7,4
  check("a: max outside", R(x, y, w, "outside", "max", false) === 7);
  check("a: argmax_x outside", R(x, y, w, "outside", "argmax_x", false) === 5);
  check("a: count outside", R(x, y, w, "outside", "count", false) === 4);
  check("a: mean outside", R(x, y, w, "outside", "mean", false) === 3.5);
  check("a: median outside (even)", R(x, y, w, "outside", "median", false) === 3);
  // outside_within [1,3] within [0,5]: x = 0,4,5 -> y 1,2,7
  const w2 = { lo: 1, hi: 3, lo2: 0, hi2: 5 };
  check("a: count outside_within (outer edges inclusive)", R(x, y, w2, "outside_within", "count", false) === 3);
  check("a: median outside_within", R(x, y, w2, "outside_within", "median", false) === 2);
  check("a: max outside_within", R(x, y, w2, "outside_within", "max", false) === 7);
  check("a: lo > hi is swapped", R(x, y, { lo: 3, hi: 1 }, "inside", "count", false) === 3);
  check("a: lo2 > hi2 is swapped", R(x, y, { lo: 1, hi: 3, lo2: 5, hi2: 0 }, "outside_within", "count", false) === 3);
  check("a: null bound = unbounded", R(x, y, { lo: null, hi: 2 }, "inside", "count", false) === 3);
  check("a: no window = whole span", R(x, y, null, "inside", "count", false) === 7);
  check("a: integral whole span", R(x, y, null, "inside", "integral", false)
    === [0, 1, 2, 3, 4, 5].reduce((s, k) => s + 0.5 * (y[k] + y[k + 1]), 0));

  // NaN in x and y; +-Inf y ignored
  const xn = [0, 1, NaN, 3, 4], yn = [1, NaN, 9, 2, Infinity];
  check("a: NaN x never a member, NaN/Inf y ignored", R(xn, yn, null, "inside", "count", false) === 2);
  check("a: max ignores NaN y / NaN x", R(xn, yn, null, "inside", "max", false) === 2);
  check("a: argmax_x with NaNs", R(xn, yn, null, "inside", "argmax_x", false) === 3);
  check("a: NaN x not a member of outside", R(xn, [1, 1, 1, 1, 1], { lo: 10, hi: 20 }, "outside", "count", false) === 4);
  check("a: NaN x not a member of outside_within",
    R(xn, [1, 1, 1, 1, 1], { lo: 10, hi: 20, lo2: -1e9, hi2: 1e9 }, "outside_within", "count", false) === 4);
  check("a: -Inf y ignored", R([0, 1], [-Infinity, -5], null, "inside", "min", false) === -5);

  // empty windows
  const emptyW = { lo: 100, hi: 200 };
  for (const s of ["max", "min", "mean", "median", "std", "sum", "integral", "argmax_x", "argmin_x"]) {
    check(`a: empty window ${s} -> NaN`, isNaNum(R(x, y, emptyW, "inside", s, false)));
    check(`a: empty window ${s} (dB) -> NaN`, isNaNum(R(x, y, emptyW, "inside", s, true)));
  }
  check("a: empty window count -> 0", R(x, y, emptyW, "inside", "count", false) === 0);
  check("a: empty arrays", R([], [], null, "inside", "count", false) === 0 && isNaNum(R([], [], null, "inside", "mean", true)));

  // dB vs linear
  const xd = [0, 1], yd = [-10, -20];
  check("a: dB mean = 10log10 of linear mean", near(R(xd, yd, null, "inside", "mean", true), todb((0.1 + 0.01) / 2)));
  check("a: dbMode 'yes' == true", near(R(xd, yd, null, "inside", "mean", "yes"), todb(0.055)));
  check("a: linear mean of dB values", R(xd, yd, null, "inside", "mean", false) === -15);
  check("a: dB sum", near(R(xd, yd, null, "inside", "sum", true), todb(0.11)));
  check("a: dB median (even) in linear", near(R(xd, yd, null, "inside", "median", true), todb(0.055)));
  check("a: dB median (odd)", near(R([0, 1, 2], [-10, -30, -20], null, "inside", "median", true), -20));
  check("a: dB std (population, linear)", near(R(xd, yd, null, "inside", "std", true), todb(0.045)));
  check("a: dB std of equal values -> r=0 -> NaN", isNaNum(R(xd, [-10, -10], null, "inside", "std", true)));
  check("a: linear std of equal values -> 0", R(xd, [5, 5], null, "inside", "std", false) === 0);
  check("a: dB max unaffected", R(xd, yd, null, "inside", "max", true) === -10);
  check("a: dB argmin unaffected", R(xd, yd, null, "inside", "argmin_x", true) === 1);
  check("a: dB count unaffected", R(xd, yd, null, "inside", "count", true) === 2);
  check("a: dB extreme underflow -> NaN", isNaNum(R([0], [-5000], null, "inside", "mean", true)));

  // integral: gaps, orientation, non-uniform x, dB
  const xi = [0, 1, 2, 3, 4, 5, 6], ones = [1, 1, 1, 1, 1, 1, 1];
  check("a: integral of ones", R(xi, ones, null, "inside", "integral", false) === 6);
  check("a: integral never bridges the excluded window",
    R(xi, ones, { lo: 2.5, hi: 3.5 }, "outside", "integral", false) === 4);
  check("a: integral never bridges a NaN y", R(xi, [1, 1, 1, NaN, 1, 1, 1], null, "inside", "integral", false) === 4);
  check("a: integral outside_within", R(xi, ones, { lo: 2.5, hi: 3.5, lo2: 1, hi2: 5 }, "outside_within", "integral", false) === 2);
  check("a: integral uses |dx| (descending x)", R([6, 5, 4, 3, 2, 1, 0], ones, null, "inside", "integral", false) === 6);
  check("a: integral non-uniform x", R([0, 1, 3], [0, 2, 2], null, "inside", "integral", false) === 5);
  check("a: integral dB (linear power, back to dB)", near(R([0, 1, 2], [0, 0, 0], null, "inside", "integral", true), todb(2)));
  check("a: integral single member -> NaN", isNaNum(R(xi, ones, { lo: 3, hi: 3 }, "inside", "integral", false)));
  check("a: integral zero-width (linear) -> 0", R([1, 1], [1, 1], null, "inside", "integral", false) === 0);
  check("a: integral zero-width (dB) -> NaN", isNaNum(R([1, 1], [1, 1], null, "inside", "integral", true)));

  // ties, medians, non-finite results
  check("a: argmax tie -> first", R([10, 20, 30, 40], [3, 7, 7, 1], null, "inside", "argmax_x", false) === 20);
  check("a: argmin tie -> first", R([10, 20, 30], [1, 0, 0], null, "inside", "argmin_x", false) === 20);
  check("a: median even", R([0, 1, 2, 3], [4, 1, 3, 2], null, "inside", "median", false) === 2.5);
  check("a: median odd", R([0, 1, 2], [3, 1, 2], null, "inside", "median", false) === 2);
  check("a: median duplicates", R([0, 1, 2, 3], [2, 2, 2, 2], null, "inside", "median", false) === 2);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  let medOk = true;
  for (let t = 0; t < 300; t++) {
    const n = 1 + (t % 41);
    const yy = Array.from({ length: n }, () => Math.round(rnd() * 20) - 10);   // many ties
    const s = [...yy].sort((a, b) => a - b);
    const ref = n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
    if (R(yy.map((_, i) => i), yy, null, "inside", "median", false) !== ref) { medOk = false; break; }
  }
  check("a: median matches sort reference (300 random arrays)", medOk);
  check("a: overflowing sum -> NaN", isNaNum(R([0, 1], [1e308, 1e308], null, "inside", "sum", false)));
  check("a: Inf x (whole span) integral -> NaN", isNaNum(R([0, Infinity], [1, 1], null, "inside", "integral", false)));
  let threw = 0;
  for (const f of [() => R(x, y, null, "inside", "mode", false), () => R(x, y, null, "nowhere", "max", false),
    () => R([1, 2], [1], null, "inside", "max", false), () => R(x, y, null, "inside", "constructor", false)]) {
    try { f(); } catch (e) { threw++; }
  }
  check("a: bad stat / region / lengths throw", threw === 4);
  check("a: typed arrays accepted", R(Float32Array.of(0, 1), Int16Array.of(3, 4), null, "inside", "sum", false) === 7);
}


// =============================================================================
// (b) synthetic datasets
// =============================================================================
function mkds(filename, dims, vars) {
  const variables = {};
  for (const [n, v] of Object.entries(vars)) {
    const shape = v.shape || v.dims.map((d) => dims[d]);
    variables[n] = {
      dims: v.dims, shape, attrs: v.units != null ? { units: v.units } : {},
      dtype: v.char ? "char" : "double", numeric: !v.char, isChar: !!v.char,
      data: v.char ? v.data : Float64Array.from(v.data),
    };
  }
  return new Dataset({ dims, attrs: {}, variables,
    coords: new Set(Object.keys(vars).filter((n) => n in dims)) }, filename);
}
const SPEC = [
  [-50, -20, -40, -30, -60, -45],
  [-55, -52, -25, -35, -51, -58],
  [-40, -48, -49, -47, -22, -30],
];
const mk1 = () => mkds("syn.nc", { t: 3, f: 6, q: 2, e: 0 }, {
  f: { dims: ["f"], data: [10, 20, 30, 40, 50, 60], units: "Hz" },
  t: { dims: ["t"], data: [20, 30, 50], units: "Hz" },
  q: { dims: ["q"], data: [1, 0] },
  spec: { dims: ["t", "f"], data: SPEC.flat(), units: "dBm" },
  cen: { dims: ["t"], data: [30, 40, 55], units: "Hz" },
  fx: { dims: ["t", "f"], data: SPEC.flatMap((_, r) => [10, 20, 30, 40, 50, 60].map((v) => v + 5 * r)), units: "Hz" },
  line: { dims: ["f"], data: [1, 2, 3, 4, 5, 6], units: "V" },
  g: { dims: ["t"], data: [2, 4, 8], units: "A" },
  s3: { dims: ["t", "f", "q"], data: SPEC.flatMap((row) => row.flatMap((v) => [v, v + 1])), units: "dBm" },
  ze: { dims: ["e", "f"], data: [], units: "dBm" },
  scal: { dims: [], shape: [], data: [7], units: "Hz" },
  label: { dims: ["t"], data: "abc", char: true },
  nanv: { dims: ["t"], data: [1, NaN, 3], units: "dBm" },
  zero: { dims: ["t"], data: [0, 1, -2], units: "V" },
  dbw: { dims: ["t"], data: [0, 10, 20], units: " DBW\n" },
  db: { dims: ["t"], data: [0, 10, 20], units: "dB" },
  mw: { dims: ["t"], data: [1, 10, 100], units: "mW" },
  w: { dims: ["t"], data: [1, 10, 100], units: "W" },
  dbm2: { dims: ["t"], data: [0, 10, 20], units: "DBM" },
});
// window helpers: every field is an expression string
const RG = (lo, hi, lo2 = "", hi2 = "") => ({ mode: "range", lo, hi, lo2, hi2 });
const CT = (center, halfwidth, halfwidth2 = "") => ({ mode: "center", center, halfwidth, halfwidth2 });
const RD = (name, o, w) => ({ ...D.newDef("reduce", "syn.nc"), name, ...o,
  window: { ...D.newDef("reduce").window, ...(w || {}) } });
const CB = (name, a, op, b, o) => ({ ...D.newDef("combine", "syn.nc"), name, a, op, b, ...(o || {}) });
const TF = (name, src, fn, o) => ({ ...D.newDef("transform", "syn.nc"), name, src, fn, ...(o || {}) });
const FM = (name, expr, o) => ({ ...D.newDef("formula", "syn.nc"), name, expr, ...(o || {}) });
const comp = (ds, def) => D.computeDef(ds, def);
const err = (ds, def) => D.validateDef(ds, def);

{
  const ds = mk1();
  const base = { src: "spec", over: "f", xsrc: "coord", stat: "max" };
  let r = comp(ds, RD("a", base, RG("40", "20")));
  check("b: range window (lo>hi swapped), dims/shape", J(r.dims) === '["t"]' && J(r.shape) === "[3]");
  check("b: range window values", allNear(r.data, [-20, -25, -47]), show(r.data));
  check("b: units auto = src units", r.attrs.units === "dBm");
  check("b: long_name = description (expressions verbatim)", r.attrs.long_name === "Peak (max) of spec over f, inside [40, 20]", r.attrs.long_name);
  r = comp(ds, RD("a", { ...base, stat: "argmax_x" }, RG("20", "40")));
  check("b: argmax_x values + units", allNear(r.data, [20, 30, 40]) && r.attrs.units === "Hz", show(r.data));
  r = comp(ds, RD("a", base, CT("t", "10")));
  check("b: center = a coordinate variable", allNear(r.data, [-20, -25, -22]), show(r.data));
  r = comp(ds, RD("a", base, CT("cen", "-10")));
  check("b: center = a variable, negative half width -> |hw|", allNear(r.data, [-20, -25, -22]), show(r.data));
  r = comp(ds, RD("a", base, CT("2*t - 30", "5")));
  check("b: center expression (harmonic)", allNear(r.data, [-50, -25, NaN]), show(r.data));
  r = comp(ds, RD("a", { ...base, stat: "count" }, CT("2*t - 30", "5")));
  check("b: count never NaN", allNear(r.data, [1, 1, 0]) && r.attrs.units === "", show(r.data));
  r = comp(ds, RD("a", { ...base, stat: "mean", region: "outside_within", db: "no" }, CT("t", "10", "20")));
  check("b: outside_within center", allNear(r.data, [-30, -53, -49]), show(r.data));
  r = comp(ds, RD("a", { ...base, stat: "mean", region: "outside" }, RG("20", "40")));
  check("b: outside, auto dB mean", near(r.data[0], todb((lin(-50) + lin(-60) + lin(-45)) / 3)), show(r.data));
  r = comp(ds, RD("a", { ...base, xsrc: "var:fx" }, CT("t", "5")));
  check("b: 2-D x variable", allNear(r.data, [-20, -25, -47]), show(r.data));
  r = comp(ds, RD("a", { ...base, src: "s3", xsrc: "var:fx" }, CT("t", "5")));
  check("b: x var with fewer dims than src", J(r.dims) === '["t","q"]'
    && allNear(r.data, [-20, -19, -25, -24, -47, -46]), show(r.data));
  r = comp(ds, RD("a", { src: "line", over: "f", xsrc: "coord", stat: "sum" }));
  check("b: 1-D src -> 0-D result", r.dims.length === 0 && r.shape.length === 0 && r.data.length === 1 && r.data[0] === 21);
  r = comp(ds, RD("a", { src: "spec", over: "t", xsrc: "coord", stat: "max" }, RG("20", "30")));
  check("b: reduce over the first dim", J(r.dims) === '["f"]' && allNear(r.data, [-50, -20, -25, -30, -51, -45]), show(r.data));
  r = comp(ds, RD("a", { src: "spec", over: "t", xsrc: "coord", stat: "max" }, CT("f", "5")));
  check("b: reduce over t, center = coordinate of the remaining dim", allNear(r.data, [NaN, -20, -25, NaN, -22, NaN]), show(r.data));
  // q's coordinate is [1, 0]: center = 2·q -> x index 2 (q=0) and 0 (q=1)
  const qdef = RD("a", { src: "s3", over: "f", xsrc: "index", stat: "max" }, CT("2*q", "0"));
  r = comp(ds, qdef);
  check("b: index x with a center from the q coordinate", allNear(r.data, [-40, -49, -25, -54, -49, -39]), show(r.data));
  {
    const ds0 = mk1();
    delete ds0.vars.q;                          // no variable: the name q is the dim's index
    r = comp(ds0, qdef);
    check("b: a dim name without a variable stands for its index", allNear(r.data, [-50, -39, -55, -24, -40, -48]), show(r.data));
    r = comp(ds0, RD("a", { src: "s3", over: "q", xsrc: "coord", stat: "argmax_x" }));
    check("b: xsrc coord without a coordinate falls back to index", r.data[0] === 1 && D.autoUnits(ds0, RD("a", { src: "s3", over: "q", xsrc: "coord", stat: "argmax_x" })) === "");
  }
  r = comp(ds, RD("a", { src: "ze", over: "f", stat: "max" }));
  check("b: size-0 result dim -> empty data", J(r.shape) === "[0]" && r.data.length === 0);
  r = comp(ds, RD("a", { src: "ze", over: "e", stat: "max" }));
  check("b: size-0 reduced dim -> all NaN", r.data.length === 6 && Array.from(r.data).every(isNaNum));
  r = comp(ds, RD("a", { src: "ze", over: "e", stat: "count" }));
  check("b: size-0 reduced dim count -> 0", Array.from(r.data).every((v) => v === 0));
  r = comp(ds, RD("a", { src: "ze", over: "e", stat: "count" }, CT("f", "1")));
  check("b: size-0 reduced dim with a center window -> count 0", r.data.length === 6 && Array.from(r.data).every((v) => v === 0));
  r = comp(ds, RD("a", { src: "spec", over: "f", xsrc: "coord", stat: "integral", db: "no" }, RG("10", "30")));
  check("b: integral units su·xu", r.attrs.units === "dBm·Hz" && near(r.data[0], 0.5 * (-50 - 20) * 10 + 0.5 * (-20 - 40) * 10));
  r = comp(ds, RD("a", { src: "spec", over: "f", xsrc: "index", stat: "integral" }));
  check("b: integral units with index x = su", r.attrs.units === "dBm");
  r = comp(ds, RD("a", { src: "spec", over: "f", xsrc: "coord", stat: "max", units: " my units " }));
  check("b: explicit units trimmed", r.attrs.units === "my units");
  r = comp(ds, RD("a", { src: "nanv", over: "t", xsrc: "coord", stat: "mean", db: "no" }));
  check("b: NaN element skipped", r.data[0] === 2);
  r = comp(ds, RD("a", { src: "spec", over: "f", xsrc: "coord", stat: "max", description: "  my peak " }));
  check("b: long_name from description", r.attrs.long_name === "my peak");

  // expression windows: equivalent forms, expressions over the result dims
  const cen10 = comp(ds, RD("a", { ...base, stat: "mean", region: "outside" }, CT("t", "10"))).data;
  check("b: range from expressions == center ± hw (bitwise)",
    same(comp(ds, RD("a", { ...base, stat: "mean", region: "outside" }, RG("t - 10", "t + 10"))).data, cen10));
  check("b: half width from a variable (5*g/2 - 5*g/2 + 10)",
    same(comp(ds, RD("a", { ...base, stat: "mean", region: "outside" }, CT("t", "5*g/2 - 5*g/2 + 10"))).data, cen10));
  r = comp(ds, RD("a", base, CT("t", "g*2.5")));             // hw 5, 10, 20
  check("b: half width proportional to a variable", allNear(r.data, [-20, -25, -22]), show(r.data));
  r = comp(ds, RD("a", { ...base, stat: "count" }, CT("t", "t/2")));   // [10,30] [15,45] [25,75]
  check("b: half width proportional to the center", allNear(r.data, [3, 3, 4]), show(r.data));
  r = comp(ds, RD("a", { ...base, stat: "count" }, CT("scal*0 + 35", "10")));
  check("b: a 0-D variable in a window expression", allNear(r.data, [2, 2, 2]), show(r.data));
  r = comp(ds, RD("a", { ...base, stat: "count" }, CT("pi*10", "pi")));    // [28.3, 34.6] -> x = 30
  check("b: the constant pi", allNear(r.data, [1, 1, 1]), show(r.data));
  r = comp(ds, RD("a", { ...base, stat: "count" }, RG("max(t, 25)", "min(cen + 5, 50)")));  // [25,35] [30,45] [50,50]
  check("b: functions in window expressions", allNear(r.data, [1, 2, 1]), show(r.data));

  // undefined windows: a NEEDED bound that is not finite -> no member in any region
  r = comp(ds, RD("a", { ...base, stat: "count" }, CT("nanv", "100")));
  check("b: NaN center -> count 0 there", allNear(r.data, [6, 0, 6]), show(r.data));
  r = comp(ds, RD("a", { ...base, stat: "count", region: "outside" }, CT("nanv", "15")));
  check("b: NaN center -> outside count 0 too", allNear(r.data, [5, 0, 5]), show(r.data));
  r = comp(ds, RD("a", { ...base, stat: "count" }, RG("nanv", "100")));
  check("b: NaN range bound -> undefined", allNear(r.data, [6, 0, 6]), show(r.data));
  r = comp(ds, RD("a", { ...base, stat: "count" }, CT("t", "nanv*0 + 10")));
  check("b: NaN half width -> undefined", allNear(r.data, [3, 0, 3]), show(r.data));
  r = comp(ds, RD("a", base, CT("t", "1/(g - 4)")));                  // hw -0.5, +Inf, 0.25
  check("b: infinite half width -> undefined (NaN)", allNear(r.data, [-20, NaN, -22]), show(r.data));
  r = comp(ds, RD("a", { ...base, stat: "count", region: "outside_within" }, CT("t", "10", "nanv*0 + 25")));
  check("b: NaN outer half width (needed) -> undefined", allNear(r.data, [1, 0, 1]), show(r.data));
  r = comp(ds, RD("a", { ...base, stat: "count" }, CT("t", "10", "nanv*0 + 25")));
  check("b: NaN outer half width not needed for 'inside'", allNear(r.data, [3, 3, 3]), show(r.data));
  r = comp(ds, RD("a", { ...base, stat: "count", region: "outside_within" }, RG("20", "30", "nanv", "60")));
  check("b: NaN outer range bound (needed) -> undefined", allNear(r.data, [4, 0, 4]), show(r.data));
  const pvu = D.previewSlice(ds, RD("a", { ...base, region: "outside" }, CT("nanv", "100")), { t: 1 });
  check("b: preview of an undefined window", pvu.inner === null && pvu.outer === null && isNaNum(pvu.center)
    && isNaNum(pvu.value) && pvu.count === 0 && Array.from(pvu.member).every((m) => m === 0));

  // time units are scaled to seconds in expressions, like x values
  const dt = mkds("time.nc", { t: 3, s: 4 }, {
    s: { dims: ["s"], data: [0, 1, 2, 3] },
    sig: { dims: ["t", "s"], data: [9, 1, 2, 3, 0, 9, 2, 3, 0, 1, 9, 3] },
    tms: { dims: ["t"], data: [0, 1000, 2000], units: "milliseconds" },
  });
  r = comp(dt, { ...D.newDef("reduce", "time.nc"), name: "tm", src: "sig", over: "s", xsrc: "coord", stat: "argmax_x",
    window: CT("tms", "0.5") });
  check("b: time-unit variable scaled to seconds in a window", allNear(r.data, [0, 1, 2]), show(r.data));
  r = comp(dt, { ...D.newDef("formula", "time.nc"), name: "tf", expr: "tms*2" });
  check("b: time-unit variable scaled to seconds in a formula", allNear(r.data, [0, 2, 4]), show(r.data));

  // combine (broadcast by dim NAME, both directions) + constants — old kind, still computed
  r = comp(ds, CB("c", "spec", "-", "g"));
  check("b: combine a(t,f) - b(t)", J(r.dims) === '["t","f"]' && r.data[0] === -52 && r.data[6] === -59 && r.data[17] === -38);
  r = comp(ds, CB("c", "g", "-", "spec"));
  check("b: combine a(t) - b(t,f) -> dims t,f", J(r.dims) === '["t","f"]' && r.data[0] === 52 && r.data[17] === 38);
  r = comp(ds, CB("c", "g", "*", "line"));
  check("b: combine outer product a(t)*b(f)", J(r.dims) === '["t","f"]'
    && allNear(r.data, [2, 4, 6, 8, 10, 12, 4, 8, 12, 16, 20, 24, 8, 16, 24, 32, 40, 48]) && r.attrs.units === "A·V");
  r = comp(ds, CB("c", "line", "/", "g"));
  check("b: combine a(f)/b(t) -> dims f,t", J(r.dims) === '["f","t"]' && r.data[1] === 0.25 && r.attrs.units === "V/A");
  r = comp(ds, CB("c", "spec", "+", 30));
  check("b: combine + constant", r.data[0] === -20 && r.attrs.units === "dBm" && J(r.shape) === "[3,6]");
  r = comp(ds, CB("c", "zero", "/", 0));
  check("b: x/0 -> NaN (non-finite stored as NaN)", Array.from(r.data).every(isNaNum));
  r = comp(ds, CB("c", "nanv", "max", "g"));
  check("b: max with NaN -> NaN", allNear(r.data, [2, NaN, 8]), show(r.data));
  r = comp(ds, CB("c", "nanv", "min", 2));
  check("b: min with constant", allNear(r.data, [1, NaN, 2]), show(r.data));
  r = comp(ds, CB("c", "scal", "*", "g"));
  check("b: 0-D a broadcast over b", J(r.dims) === '["t"]' && allNear(r.data, [14, 28, 56]));

  // formulas: dims = the names' dims in order of first appearance, broadcast by NAME
  const fm = (expr) => comp(ds, FM("fm", expr));
  const eqCombine = (expr, cb) => { const a = fm(expr), b = comp(ds, cb);
    return J(a.dims) === J(b.dims) && J(a.shape) === J(b.shape) && same(a.data, b.data) && a.attrs.units === b.attrs.units; };
  check("b: formula spec - g == combine (dims, values, units)", eqCombine("spec - g", CB("c", "spec", "-", "g")));
  check("b: formula g - spec == combine (dims t,f)", eqCombine("g - spec", CB("c", "g", "-", "spec")));
  check("b: formula g*line == combine (outer product, A·V)", eqCombine("g*line", CB("c", "g", "*", "line")));
  check("b: formula line/g == combine (dims f,t, V/A)", eqCombine("line/g", CB("c", "line", "/", "g")));
  check("b: formula spec + 30 == combine", eqCombine("spec + 30", CB("c", "spec", "+", 30)));
  check("b: formula max(nanv, g) == combine", eqCombine("max(nanv, g)", CB("c", "nanv", "max", "g")));
  check("b: formula scal*g == combine (0-D broadcast)", eqCombine("scal*g", CB("c", "scal", "*", "g")));
  check("b: formula db2lin(spec) == transform", (() => { const a = fm("db2lin(spec)"), b = comp(ds, TF("x", "spec", "db2lin"));
    return same(a.data, b.data) && a.attrs.units === "mW" && b.attrs.units === "mW"; })());
  check("b: formula lin2db(zero) == transform", (() => { const a = fm("lin2db(zero)"), b = comp(ds, TF("x", "zero", "lin2db"));
    return same(a.data, b.data) && a.attrs.units === "dB"; })());
  check("b: formula 2*g - 1 == transform scale", same(fm("2*g - 1").data, comp(ds, TF("x", "g", "scale", { scale: 2, offset: -1 })).data));
  r = fm("zero/0");
  check("b: formula x/0 -> NaN", Array.from(r.data).every(isNaNum));
  r = fm("1/(g - 4)");
  check("b: formula ±Inf -> NaN", allNear(r.data, [-0.5, NaN, 0.25]), show(r.data));
  r = fm("2*pi");
  check("b: formula of constants -> 0-D", J(r.dims) === "[]" && J(r.shape) === "[]" && r.data.length === 1
    && r.data[0] === 2 * Math.PI && r.attrs.units === "");
  r = fm("ze + 1");
  check("b: formula with a size-0 dim", J(r.dims) === '["e","f"]' && J(r.shape) === "[0,6]" && r.data.length === 0);
  r = fm("g*1k + line*0");
  check("b: formula with SI suffix", J(r.dims) === '["t","f"]' && r.data[0] === 2000 && r.data[17] === 8000);
  r = fm("t + f/10");
  check("b: formula dims follow first appearance", J(r.dims) === '["t","f"]' && r.data[1] === 22 && r.data[6] === 31, show(r.data));
  r = fm("f/10 + t");
  check("b: formula dims follow first appearance (swapped)", J(r.dims) === '["f","t"]' && r.data[1] === 31, show(r.data));
  {
    const ds0 = mk1();
    delete ds0.vars.q;
    r = comp(ds0, FM("fq", "q*10 + g"));
    check("b: formula with a dim index", J(r.dims) === '["q","t"]' && allNear(r.data, [2, 4, 8, 12, 14, 18]), show(r.data));
  }
  check("b: formula units dBm - DBM -> dB", fm("spec - dbm2").attrs.units === "dB");
  check("b: formula units dBm - 10*log10(W) -> dBm", fm("spec - 10*log10(w)").attrs.units === "dBm");
  check("b: formula units V^2", fm("line^2").attrs.units === "V^2" && fm("pow(line, -1)").attrs.units === "V^-1");
  check("b: formula explicit units win", comp(ds, FM("fm", "spec - dbm2", { units: " dBc " })).attrs.units === "dBc");
  check("b: formula long_name = expression", fm("spec  -  g").attrs.long_name === "spec  -  g");

  // transforms
  r = comp(ds, TF("x", "spec", "db2lin"));
  check("b: db2lin values + dBm -> mW", near(r.data[0], 1e-5) && r.attrs.units === "mW");
  r = comp(ds, TF("x", "zero", "lin2db"));
  check("b: lin2db x<=0 -> NaN", allNear(r.data, [NaN, 0, NaN]) && r.attrs.units === "dB", show(r.data));
  r = comp(ds, TF("x", "g", "scale", { scale: 2, offset: -1 }));
  check("b: scale a·x + b", allNear(r.data, [3, 7, 15]) && r.attrs.units === "A");
  r = comp(ds, TF("x", "zero", "abs"));
  check("b: abs", allNear(r.data, [0, 1, 2]));
  r = comp(ds, TF("x", "scal", "scale", { scale: 3 }));
  check("b: transform of a 0-D var", r.shape.length === 0 && r.data[0] === 21);

  // auto units (§1.5)
  const au = (def) => D.autoUnits(ds, def);
  check("b: units db2lin DBM -> mW", au(TF("x", "dbm2", "db2lin")) === "mW");
  check("b: units db2lin ' DBW\\n' -> W", au(TF("x", "dbw", "db2lin")) === "W");
  check("b: units db2lin dB -> ''", au(TF("x", "db", "db2lin")) === "");
  check("b: units db2lin V -> lin(V)", au(TF("x", "line", "db2lin")) === "lin(V)");
  check("b: units db2lin (none) -> ''", au(TF("x", "q", "db2lin")) === "");
  check("b: units lin2db mW -> dBm", au(TF("x", "mw", "lin2db")) === "dBm");
  check("b: units lin2db W -> dBW", au(TF("x", "w", "lin2db")) === "dBW");
  check("b: units lin2db V -> dB", au(TF("x", "line", "lin2db")) === "dB");
  check("b: units abs keeps", au(TF("x", "line", "abs")) === "V");
  check("b: units dBm - dBm -> dB", au(CB("c", "spec", "-", "s3")) === "dB");
  check("b: units DBM - dBm -> dB (case-insensitive)", au(CB("c", "dbm2", "-", "spec")) === "dB");
  check("b: units dBm - dB -> dBm", au(CB("c", "spec", "-", "db")) === "dBm");
  check("b: units dBm - const -> dBm", au(CB("c", "spec", "-", 3)) === "dBm");
  check("b: units V + A -> V", au(CB("c", "line", "+", "g")) === "V");
  check("b: units dBm / dBm -> ''", au(CB("c", "spec", "/", "s3")) === "");
  check("b: units '' / A -> 1/A", au(CB("c", "q", "/", "g")) === "1/A");
  check("b: units V / const -> V", au(CB("c", "line", "/", 2)) === "V");
  check("b: units '' * A -> A", au(CB("c", "q", "*", "g")) === "A");
  check("b: units max -> ua", au(CB("c", "q", "max", "g")) === "");
  check("b: units argmin_x var -> x units", au(RD("r", { src: "spec", over: "f", xsrc: "var:fx", stat: "argmin_x" })) === "Hz");
  check("b: units argmax_x index -> ''", au(RD("r", { src: "spec", over: "f", xsrc: "index", stat: "argmax_x" })) === "");
  check("b: units integral, src without units -> xu",
    au(RD("r", { src: "q", over: "q", xsrc: "var:line", stat: "integral" })) === "V");
  check("b: effectiveUnits prefers explicit", D.effectiveUnits(ds, { ...CB("c", "spec", "-", "s3"), units: " x " }) === "x");
  check("b: formula units: unknown name / bad text -> ''", au(FM("f", "nope*2")) === "" && au(FM("f", "spec +")) === ""
    && au(FM("f", "")) === "");
  check("b: formula units: dims-only names -> ''", au(FM("f", "e*2")) === "");
}

// topo order, chains, cycles, missing deps, registration
{
  const ds = mk1();
  const peak = RD("peak", { src: "spec", over: "f", xsrc: "coord", stat: "max" }, CT("t", "10"));
  const floor = RD("floor", { src: "spec", over: "f", xsrc: "coord", stat: "mean", region: "outside" }, CT("t", "10"));
  const snr = FM("SNR", "peak - floor");
  const snr2 = CB("SNR2", "peak", "-", "floor");
  let st = D.registerDerived(ds, [snr, peak, floor, snr2]);
  check("b: chain registered in topo order", [...st.values()].every((s) => s.ok), J([...st]));
  const pv = ds.vars.peak, fv = ds.vars.floor, sv = ds.vars.SNR;
  check("b: SNR = peak - floor", sv && allNear(sv.data, Array.from(pv.data, (v, i) => v - fv.data[i]), 0));
  check("b: SNR formula == SNR combine", same(sv.data, ds.vars.SNR2.data) && J(sv.dims) === J(ds.vars.SNR2.dims));
  check("b: SNR units dB", sv.attrs.units === "dB" && ds.vars.SNR2.attrs.units === "dB");
  check("b: a def named like a function ('floor', as saved by bc9812f) registers; bare 'floor' is a reference",
    st.get("floor").ok && D.depsOf(snr).join() === "peak,floor");
  check("b: registered var is a Variable, derived, with canonical def",
    sv instanceof Variable && sv.derived === true && sv.isNumeric() && sv.dtype === "double"
    && J(sv.def) === J(D.canonicalDef(snr)));
  check("b: status shape", J(st.get("peak").shape) === "[3]" && st.get("peak").error === null);
  const { order } = D.topoOrder([snr, peak, floor]);
  check("b: topoOrder deps first, else input order", order.map((d) => d.name).join(",") === "peak,floor,SNR");

  // derived var as center and as x source; a window referencing derived vars
  const pkx = RD("pkx", { src: "spec", over: "f", xsrc: "coord", stat: "argmax_x" });
  const pk2 = RD("pk2", { src: "spec", over: "f", xsrc: "coord", stat: "max" }, CT("pkx", "0"));
  const fk = TF("fk", "fx", "scale", { scale: 0.001 });
  const pk3 = RD("pk3", { src: "spec", over: "f", xsrc: "var:fk", stat: "max" }, RG("0.014", "0.026"));
  const hwv = FM("hwv", "g*0 + 10");
  const pk4 = RD("pk4", { src: "spec", over: "f", xsrc: "coord", stat: "max", region: "outside_within" }, CT("pkx", "hwv", "hwv*2"));
  st = D.registerDerived(ds, [pk4, pk3, pk2, fk, pkx, hwv]);
  check("b: previous derived vars dropped", !ds.vars.peak && !ds.vars.SNR && !ds.has("floor"));
  check("b: center var depending on a derived var", st.get("pk2").ok && allNear(ds.vars.pk2.data, [-20, -25, -22]), J([...st]));
  check("b: derived var used as x source", st.get("pk3").ok && allNear(ds.vars.pk3.data, [-20, -52, -40]), show(ds.vars.pk3 && ds.vars.pk3.data));
  check("b: window expressions over derived vars (topo order)", st.get("pk4").ok
    && D.topoOrder([pk4, pk3, pk2, fk, pkx, hwv]).order.map((d) => d.name).join(",") === "pkx,hwv,pk4,fk,pk3,pk2"
    && allNear(ds.vars.pk4.data, [-30, -51, -49]), show(ds.vars.pk4 ? ds.vars.pk4.data : []));

  // cycles / self refs / missing / dependents
  const A = CB("A", "B", "+", 1), B = CB("B", "A", "+", 1), C = CB("C", "A", "*", 2), S = CB("S", "S", "+", 1);
  const M = CB("M", "nope", "+", 1), N = TF("N", "M", "abs"), OK = TF("OK", "g", "abs");
  const t = D.topoOrder([A, B, C, S, M, N, OK]);
  check("b: topo cycle errors", /circular/.test(t.errors.get("A") || "") && /circular/.test(t.errors.get("B") || ""), J([...t.errors]));
  check("b: topo self reference", /itself/.test(t.errors.get("S") || ""));
  check("b: topo dependent of a cycle", /depends on 'A'/.test(t.errors.get("C") || ""));
  check("b: topo order excludes errors", t.order.map((d) => d.name).join(",") === "M,N,OK");
  st = D.registerDerived(ds, [A, B, C, S, M, N, OK]);
  check("b: register: cycle + self + dependents fail", ["A", "B", "C", "S"].every((n) => !st.get(n).ok && !ds.vars[n]));
  check("b: register: missing dep is an error", !st.get("M").ok && /not found/.test(st.get("M").error));
  check("b: register: dependent of failed def", !st.get("N").ok && /depends on 'M'/.test(st.get("N").error));
  check("b: register: independent def still ok", st.get("OK").ok && ds.vars.OK.derived);
  check("b: validateDef self reference", /itself/.test(err(ds, S) || ""));
  // the same through formulas and window expressions
  const fA = FM("fA", "fB + 1"), fB = FM("fB", "max(fA, 2)"), fC = FM("fC", "fA*2"), fS = FM("fS", "1 + fS");
  const w1 = RD("w1", { src: "spec", over: "f", xsrc: "coord" }, CT("w2", "1"));
  const w2 = RD("w2", { src: "spec", over: "f", xsrc: "coord" }, CT("t", "w1"));
  const fM = FM("fM", "nope + g"), fN = RD("fN", { src: "spec", over: "f", xsrc: "coord" }, CT("fM", "1"));
  const t2 = D.topoOrder([fA, fB, fC, fS, w1, w2, fM, fN]);
  check("b: topo formula cycle", /circular/.test(t2.errors.get("fA") || "") && /circular/.test(t2.errors.get("fB") || "")
    && /depends on 'fA'/.test(t2.errors.get("fC") || "") && /itself/.test(t2.errors.get("fS") || ""), J([...t2.errors]));
  check("b: topo cycle through window expressions", /circular/.test(t2.errors.get("w1") || "") && /circular/.test(t2.errors.get("w2") || ""));
  st = D.registerDerived(ds, [fA, fB, fC, fS, w1, w2, fM, fN]);
  check("b: register: formula with unknown name fails, window dependent too", !st.get("fM").ok
    && /Formula: unknown name 'nope' at position 0/.test(st.get("fM").error) && /depends on 'fM'/.test(st.get("fN").error),
  J([...st]));
  check("b: validateDef formula self reference", /itself/.test(err(ds, fS) || ""));
  {
    // a failed def named like a dim does not poison expressions using the dim
    // index; a failed def named pi DOES fail its dependents (they meant that
    // def, not the constant — as in bc9812f and the Python script)
    const ds0 = mk1();
    delete ds0.vars.q;
    st = D.registerDerived(ds0, [TF("q", "g", "abs"), TF("pi", "nope", "abs"), FM("uq", "q + 1"), FM("upi", "pi*g")]);
    check("b: register: failed def named like a dim / pi", !st.get("q").ok && !st.get("pi").ok
      && st.get("uq").ok && allNear(ds0.vars.uq.data, [1, 2])
      && !st.get("upi").ok && /depends on 'pi'/.test(st.get("upi").error), J([...st]));
    st = D.registerDerived(ds0, [FM("upi", "pi*g")]);
    check("b: register: without a def named pi, pi is the constant", st.get("upi").ok
      && allNear(ds0.vars.upi.data, [2 * Math.PI, 4 * Math.PI, 8 * Math.PI]), J([...st]));
    st = D.registerDerived(ds0, [TF("pi", "g", "scale", { scale: 0.5 }), FM("upi", "pi*g")]);
    check("b: register: a (bc9812f) def named pi shadows the constant", st.get("pi").ok && st.get("upi").ok
      && allNear(ds0.vars.upi.data, [2, 8, 32]), J([...st]));
  }

  // names
  const defs = [peak, floor];
  check("b: name collides with real var", /already a variable/.test(D.validateName(ds, defs, "spec") || ""));
  check("b: name collides with a dim", /dimension/.test(D.validateName(ds, defs, "e") || ""));
  check("b: name bad chars", !!D.validateName(ds, defs, "a/b") && !!D.validateName(ds, defs, "SNR (dB)"));
  check("b: name empty", !!D.validateName(ds, defs, "") && !!D.validateName(ds, defs, "   "));
  check("b: name leading space", !!D.validateName(ds, defs, " a"));
  check("b: name 64 ok, 65 rejected", D.validateName(ds, defs, "a".repeat(64)) === null && !!D.validateName(ds, defs, "a".repeat(65)));
  check("b: name allowed chars", D.validateName(ds, defs, "pk_1.2+x-y z") === null);
  check("b: name duplicate def", /Another/.test(D.validateName(ds, defs, "peak") || ""));
  check("b: name duplicate ignored when editing that def", D.validateName(ds, defs, "peak", "peak") === null);
  check("b: same name in another file's def is fine", D.validateName(ds, [{ ...peak, file: "other.nc" }], "peak") === null);
  check("b: reserved names", !!D.validateName(ds, defs, "__proto__") && !!D.validateName(ds, defs, "constructor"));
  check("b: function names and pi are not def names", ["abs", "log10", "db2lin", "min", "max", "pow", "round"].every(
    (n) => /function/.test(D.validateName(ds, defs, n) || "")) && /constant/.test(D.validateName(ds, defs, "pi") || "")
    && D.validateName(ds, defs, "Pi") === null && D.validateName(ds, defs, "max2") === null
    && D.validateName(ds, defs, "floor", "floor") === null && !!D.validateName(ds, defs, "floor", "peak"));
  check("b: name of a registered derived var is not a 'real var' clash", D.validateName(ds, [], "OK") === null);
  st = D.registerDerived(ds, [TF("spec", "g", "abs"), TF("t", "g", "abs"), TF("bad/x", "g", "abs"), TF("ok2", "spec", "abs"),
    TF("dup", "g", "abs"), TF("dup", "line", "abs"), TF("max", "g", "abs")]);
  check("b: register rejects real-var / dim / bad names, keeps a function-named (old) def", !st.get("spec").ok && !st.get("t").ok
    && !st.get("bad/x").ok && st.get("max").ok);
  check("b: real var untouched by a clashing def", !ds.vars.spec.derived && ds.vars.spec.dims.length === 2);
  check("b: dep named like a failed clashing def resolves to the real var", st.get("ok2").ok && ds.vars.ok2.data[0] === 50);
  check("b: duplicate names: first wins", st.get("dup").ok && J(ds.vars.dup.dims) === '["t"]');
  D.unregisterDerived(ds);
  check("b: unregisterDerived", !Object.values(ds.vars).some((v) => v.derived) && ds.has("spec"));
  check("b: __proto__ def is never registered", (D.registerDerived(ds, [TF("__proto__", "g", "abs")]),
    Object.getPrototypeOf(ds.vars) === Object.prototype));
}

// validation errors
{
  const ds = mk1();
  const base = { src: "spec", over: "f", xsrc: "coord", stat: "max" };
  const ow = { ...base, region: "outside_within" };
  const cases = [
    ["src missing", RD("r", { ...base, src: "nope" }), /not found/],
    ["src empty", RD("r", { ...base, src: "" }), /Choose/],
    ["src non-numeric", RD("r", { ...base, src: "label", over: "t" }), /not numeric/],
    ["src 0-D", RD("r", { ...base, src: "scal", over: "x" }), /scalar/],
    ["src via prototype name", RD("r", { ...base, src: "constructor" }), /not found/],
    ["over not a dim of src", RD("r", { ...base, over: "q" }), /not a dimension/],
    ["xsrc var missing", RD("r", { ...base, xsrc: "var:nope" }), /not found/],
    ["xsrc var lacks over", RD("r", { ...base, xsrc: "var:g" }), /does not span/],
    ["xsrc var extra dim", RD("r", { ...base, xsrc: "var:s3" }), /lacks/],
    ["xsrc unknown", RD("r", { ...base, xsrc: "bogus" }), /Unknown x source/],
    ["range 'from' empty", RD("r", base, RG("", "3")), /^Window 'from' is empty/],
    ["range 'to' blank", RD("r", base, RG("1", "  \n")), /^Window 'to' is empty/],
    ["range syntax error + position", RD("r", base, RG("1 +", "3")), /^Window 'from': unexpected end of expression at position 3$/],
    ["outside_within range needs the outer span", RD("r", ow, RG("1", "3", "0", "")), /'outer to' is empty/],
    ["center empty", RD("r", base, CT("", "1")), /'center' is empty/],
    ["center unknown name", RD("r", base, CT("nope", "1")), /^Window 'center': unknown name 'nope' at position 0$/],
    ["center name dims not in result", RD("r", base, CT("fx", "1")), /'fx' has dimension 'f', which the result lacks/],
    ["center = the reduced dim's coordinate", RD("r", base, CT("2 + f", "1")), /'f' has dimension 'f', which the result lacks at position 4/],
    ["dim index not in result", RD("r", base, RG("e", "1")), /'e' has dimension 'e', which the result lacks/],
    ["center non-numeric", RD("r", base, CT("label", "1")), /'label' is not numeric/],
    ["center unknown function", RD("r", base, CT("foo(t)", "1")), /unknown function 'foo' at position 0/],
    ["center wrong arity", RD("r", base, CT("pow(t)", "1")), /pow\(\) takes 2 arguments/],
    ["half width empty", RD("r", base, CT("t", "")), /'half width' is empty/],
    ["half width size mismatch", RD("r", base, CT("t", "bad_t")), /'t' has a different size in 'bad_t'/],
    ["outside_within center needs halfwidth2", RD("r", ow, CT("t", "1")), /'outer half width' is empty/],
    ["window refers to the def itself", RD("r", base, CT("r + t", "1")), /refers to itself/],
    ["outside with mode none", RD("r", { ...base, region: "outside" }), /needs a window/],
    ["outside_within with mode none", RD("r", { ...base, region: "outside_within" }), /needs a window/],
    ["unknown stat", RD("r", { ...base, stat: "mode" }), /statistic/],
    ["unknown region", RD("r", { ...base, region: "x" }), /region/],
    ["unknown db", RD("r", { ...base, db: "maybe" }), /dB mode/],
    ["unknown mode", RD("r", base, { mode: "x" }), /window mode/],
    ["formula empty", FM("x", "  "), /formula is empty/],
    ["formula syntax", FM("x", "spec +"), /^Formula: unexpected end of expression at position 6$/],
    ["formula unknown name", FM("x", "spec - nope"), /^Formula: unknown name 'nope' at position 7$/],
    ["formula prototype name", FM("x", "constructor + __proto__"), /unknown name 'constructor'/],
    ["formula non-numeric", FM("x", "label + 1"), /'label' is not numeric/],
    ["formula dim size mismatch", FM("x", "spec - bad_t"), /'t' has size 3 in 'spec' but 2 in 'bad_t' at position 7/],
    ["formula self reference", FM("x", "x + 1"), /itself/],
    ["formula bad character", FM("x", "spec % 2"), /unexpected character '%' at position 5/],
    ["combine b missing", CB("c", "spec", "-", "nope"), /not found/],
    ["combine b NaN", CB("c", "spec", "-", NaN), /finite/],
    ["combine bad op", CB("c", "spec", "^", 1), /operation/],
    ["combine dim size mismatch", CB("c", "spec", "-", "bad_t"), /size/],
    ["transform bad fn", TF("x", "spec", "sqrt"), /function/],
    ["transform src missing", TF("x", "nope", "abs"), /not found/],
    ["unknown kind", { ...TF("x", "spec", "abs"), kind: "magic" }, /kind/],
  ];
  // a var whose 't' disagrees in size (only reachable through broken inputs)
  ds.vars.bad_t = new Variable("bad_t", { dims: ["t"], shape: [2], attrs: {}, dtype: "double", numeric: true, data: Float64Array.of(1, 2) });
  for (const [what, def, re] of cases) {
    const e = err(ds, def);
    check(`b: validate: ${what}`, e !== null && re.test(e), e);
    let threw = false;
    try { D.computeDef(ds, def); } catch (x) { threw = true; }
    check(`b: computeDef throws: ${what}`, threw);
    check(`b: resultShape null: ${what}`, D.resultShape(ds, def) === null);
  }
  check("b: valid def -> validateDef null", err(ds, RD("r", base)) === null);
  check("b: unused window fields are not validated", err(ds, RD("r", base, { ...CT("t", "10"), lo: "%%", halfwidth2: "nope(" })) === null
    && err(ds, RD("r", base, { ...RG("1", "2"), center: "+" })) === null && err(ds, RD("r", base, { ...RG("", ""), mode: "none" })) === null);
  check("b: resultShape", J(D.resultShape(ds, RD("r", base))) === '{"dims":["t"],"shape":[3]}');
  check("b: resultShape combine", J(D.resultShape(ds, CB("c", "g", "+", "line"))) === '{"dims":["t","f"],"shape":[3,6]}');
  check("b: resultShape formula", J(D.resultShape(ds, FM("c", "line*g + scal"))) === '{"dims":["f","t"],"shape":[6,3]}');
  check("b: xsrc coord on a dim without coordinate is valid", err(ds, RD("r", { src: "ze", over: "e", xsrc: "coord" })) === null);
}

// builder helpers + preview + describe + expression boxes
{
  const ds = mk1();
  check("b: xSourceOptions", J(D.xSourceOptions(ds, "spec", "f")) === '["index","coord","var:f","var:fx","var:line"]',
    J(D.xSourceOptions(ds, "spec", "f")));
  check("b: suggestXsrc numeric coord", D.suggestXsrc(ds, "spec", "f") === "coord");
  const ds2 = mkds("s.nc", { k: 3, m: 2 }, {
    k: { dims: ["k"], data: [0, 1, 2] }, m: { dims: ["m"], data: [5, 6] },
    sp: { dims: ["k", "m"], data: [1, 2, 3, 4, 5, 6], units: "dBm" },
    freqs: { dims: ["k", "m"], data: [1, 2, 3, 4, 5, 6], units: "Hz" },
    other: { dims: ["k"], data: [1, 2, 3] },
  });
  check("b: suggestXsrc skips an index-like coord for a 'freq' var", D.suggestXsrc(ds2, "sp", "k") === "var:freqs");
  check("b: suggestXsrc index when nothing fits", D.suggestXsrc(mkds("z.nc", { k: 2 }, { a: { dims: ["k"], data: [1, 2] } }), "a", "k") === "index");
  check("b: centerSourceOptions (kept)", J(D.centerSourceOptions(ds, "spec", "f")) === '["coord:t","var:cen","var:g","var:scal","var:nanv","var:zero","var:dbw","var:db","var:mw","var:w","var:dbm2"]',
    J(D.centerSourceOptions(ds, "spec", "f")));

  // windowNames / formulaNames
  const wn = D.windowNames(ds, "spec", "f");
  check("b: windowNames: remaining dims first, then vars with dims ⊆ result dims",
    wn.map((e) => e.name).join() === "t,cen,g,scal,nanv,zero,dbw,db,mw,w,dbm2", wn.map((e) => e.name).join());
  check("b: windowNames entries", J(wn[0]) === J({ name: "t", dims: ["t"], units: "Hz", isDim: false, label: "t [Hz]" })
    && J(wn[3]) === J({ name: "scal", dims: [], units: "Hz", isDim: false, label: "scal [Hz]" })
    && wn.find((e) => e.name === "dbw").units === "DBW");
  {
    const ds0 = mk1();
    delete ds0.vars.q;
    const wq = D.windowNames(ds0, "s3", "f");
    check("b: windowNames: a dim without a variable is its index", wq.slice(0, 3).map((e) => e.name).join() === "t,q,cen"
      && J(wq[1]) === J({ name: "q", dims: ["q"], units: "", isDim: true, label: "q [index]" }), J(wq.slice(0, 3)));
    const fnm = D.formulaNames(ds0);
    check("b: formulaNames: numeric vars then plain dims", fnm.map((e) => e.name).join()
      === "f,t,spec,cen,fx,line,g,s3,ze,scal,nanv,zero,dbw,db,mw,w,dbm2,q,e" && fnm.at(-1).isDim && !fnm[0].isDim,
    fnm.map((e) => e.name).join());
  }
  check("b: windowNames of a bad src/over -> []", D.windowNames(ds, "nope", "f").length === 0
    && D.windowNames(ds, "spec", "q").length === 0 && D.windowNames(ds, "label", "t").length === 0);
  check("b: windowNames over t", D.windowNames(ds, "spec", "t").map((e) => e.name).join() === "f,line,scal", D.windowNames(ds, "spec", "t").map((e) => e.name).join());
  check("b: every windowName is usable in a window", D.windowNames(ds, "s3", "f").every((e) =>
    err(ds, RD("r", { src: "s3", over: "f", xsrc: "coord" }, CT(D.quoteName(e.name), "1"))) === null));

  // previewSlice
  const def = RD("p", { src: "s3", over: "f", xsrc: "var:fx", stat: "mean", region: "outside_within" }, CT("t + 5", "10", "22"));
  const pv = D.previewSlice(ds, def, { t: 1, q: 9 });          // q clamped to 1
  check("b: preview x/y", allNear(pv.x, [15, 25, 35, 45, 55, 65]) && allNear(pv.y, SPEC[1].map((v) => v + 1)), show(pv.y));
  check("b: preview center = the evaluated center expression", pv.center === 35);
  check("b: preview windows", J(pv.inner) === "[25,45]" && J(pv.outer) === "[13,57]");
  check("b: preview member", Array.from(pv.member).join("") === "100010");
  check("b: preview value/count/db", pv.count === 2 && pv.db === true
    && near(pv.value, todb((lin(-54) + lin(-50)) / 2)) && near(pv.value, D.computeDef(ds, def).data[3]));
  const pv0 = D.previewSlice(ds, RD("p", { src: "spec", over: "f", stat: "count" }), {});
  check("b: preview mode none", pv0.inner === null && pv0.outer === null && pv0.center === null && pv0.value === 6 && pv0.db === true);
  const pvr = D.previewSlice(ds, RD("p", { src: "spec", over: "f", xsrc: "coord", stat: "count" }, RG("t*2", "t")), { t: 2 });
  check("b: preview range from expressions", J(pvr.inner) === "[50,100]" && pvr.outer === null && pvr.center === null && pvr.count === 2);
  // every element of a computed def == its preview value
  const pdef = RD("p", { src: "s3", over: "f", xsrc: "var:fx", stat: "median", region: "outside_within" }, CT("cen - 3*g", "g*2", "g*4 + 7"));
  const full = D.computeDef(ds, pdef);
  let pOk = true;
  for (let t = 0; t < 3; t++) for (let q = 0; q < 2; q++) {
    if (!same([D.previewSlice(ds, pdef, { t, q }).value], [full.data[t * 2 + q]])) pOk = false;
  }
  check("b: preview value == computed element (all elements)", pOk);
  let threw = false;
  try { D.previewSlice(ds, CB("c", "spec", "-", 1), {}); } catch (e) { threw = true; }
  check("b: preview only for reduce", threw);
  threw = false;
  try { D.previewSlice(ds, FM("c", "spec"), {}); } catch (e) { threw = true; }
  check("b: preview not for formulas", threw);

  // exprError: one box at a time
  const eb = { src: "spec", over: "f", xsrc: "coord", stat: "max" };
  const ee = (w, field, o) => D.exprError(ds, RD("p", { ...eb, ...(o || {}) }, w), field);
  check("b: exprError valid -> null", ee(CT("t + 5", "2*g"), "center") === null && ee(CT("t + 5", "2*g"), "halfwidth") === null
    && ee(RG("cen - 1", "cen + 1"), "lo") === null);
  check("b: exprError empty needed -> required", /required/.test(ee(CT("", "1"), "center") || "")
    && /required/.test(ee(CT("t", "1"), "halfwidth2", { region: "outside_within" }) || ""));
  check("b: exprError empty, not needed -> null", ee(CT("t", "1"), "halfwidth2") === null && ee(RG("1", "2"), "lo2") === null);
  check("b: exprError field the mode does not use -> null", ee(CT("t", "1"), "lo") === null
    && ee({ ...RG("1", "2"), center: "%%" }, "center") === null && ee({ mode: "none", lo: "%%" }, "lo") === null);
  check("b: exprError syntax with position", ee(CT("t +", "1"), "center") === "unexpected end of expression at position 3");
  check("b: exprError unknown name", ee(CT("t", "nope*2"), "halfwidth") === "unknown name 'nope' at position 0");
  check("b: exprError dims rule", ee(CT("fx", "1"), "center") === "'fx' has dimension 'f', which the result lacks at position 0");
  check("b: exprError unused-but-filled field still checked", /unknown name/.test(ee(CT("t", "1", "zz"), "halfwidth2") || ""));
  check("b: exprError self reference", /itself/.test(D.exprError(ds, RD("me", eb, CT("me", "1")), "center") || ""));
  check("b: exprError with a bad src: names checked, dims rule skipped",
    D.exprError(ds, RD("p", { ...eb, src: "nope" }, CT("fx", "1")), "center") === null
    && /unknown name/.test(D.exprError(ds, RD("p", { ...eb, src: "nope" }, CT("zz", "1")), "center") || ""));
  check("b: exprError formula", D.exprError(ds, FM("x", "spec - g"), "expr") === null
    && /required/.test(D.exprError(ds, FM("x", ""), "expr") || "")
    && D.exprError(ds, FM("x", "spec - bad"), "expr") === "unknown name 'bad' at position 7"
    && D.exprError(ds, FM("x", "spec - nanv"), "lo") === null && D.exprError(ds, RD("p", eb, CT("t", "1")), "expr") === null
    && D.exprError(ds, CB("c", "spec", "-", "g"), "lo") === null && D.exprError(null, null, "expr") === null);
  check("b: exprError legacy window (migrated)", D.exprError(ds, RD("p", eb, { mode: "relative", center: "var:cen", halfwidth: 1 }), "center") === null);

  // exprValueAt
  const vd = RD("p", eb, { ...CT("t + 5", "10*g", "cen"), lo: "t*2" });
  check("b: exprValueAt center/halfwidth", D.exprValueAt(ds, vd, "center", { t: 1 }) === 35
    && D.exprValueAt(ds, vd, "halfwidth", { t: 2 }) === 80 && D.exprValueAt(ds, vd, "halfwidth2", { t: 0 }) === 30);
  check("b: exprValueAt any field (not only the mode's)", D.exprValueAt(ds, vd, "lo", { t: 1 }) === 60);
  check("b: exprValueAt clamps / defaults the index", D.exprValueAt(ds, vd, "center", { t: 99 }) === 55
    && D.exprValueAt(ds, vd, "center", {}) === 25 && D.exprValueAt(ds, vd, "center") === 25);
  check("b: exprValueAt NaN cases", isNaNum(D.exprValueAt(ds, vd, "hi", {})) && isNaNum(D.exprValueAt(ds, vd, "bogus", {}))
    && isNaNum(D.exprValueAt(ds, RD("p", eb, CT("nope", "1")), "center", {}))
    && isNaNum(D.exprValueAt(ds, RD("p", eb, CT("fx", "1")), "center", {}))
    && isNaNum(D.exprValueAt(ds, RD("p", { ...eb, src: "nope" }, CT("t", "1")), "center", {}))
    && isNaNum(D.exprValueAt(ds, RD("p", eb, CT("nanv", "1")), "center", { t: 1 })));
  check("b: exprValueAt keeps ±Inf for window fields", D.exprValueAt(ds, RD("p", eb, CT("t", "1/(g - 4)")), "halfwidth", { t: 1 }) === Infinity);
  check("b: exprValueAt formula", D.exprValueAt(ds, FM("x", "spec - g"), "expr", { t: 1, f: 2 }) === -29
    && D.exprValueAt(ds, FM("x", "2*pi"), "expr", {}) === 2 * Math.PI
    && isNaNum(D.exprValueAt(ds, FM("x", "1/(g - 4)"), "expr", { t: 1 })) && isNaNum(D.exprValueAt(ds, FM("x", ""), "expr", {})));
  check("b: exprValueAt == computed bound", (() => {
    const d = RD("p", { ...eb, stat: "count" }, CT("cen - g", "g/3"));
    return [0, 1, 2].every((t) => { const p = D.previewSlice(ds, d, { t });
      return p.center === D.exprValueAt(ds, d, "center", { t }) && p.inner[1] === p.center + Math.abs(D.exprValueAt(ds, d, "halfwidth", { t })); });
  })());

  // renameRef
  const rr = RD("p", { src: "peak", over: "peak", xsrc: "var:peak" }, { ...CT('peak + peak2 - "peak"', "abs(peak)"), lo: "peak*2" });
  D.renameRef(rr, "peak", "pk 2");
  check("b: renameRef reduce", rr.src === "pk 2" && rr.over === "peak" && rr.xsrc === "var:pk 2"
    && rr.window.center === '"pk 2" + peak2 - "pk 2"' && rr.window.halfwidth === 'abs("pk 2")' && rr.window.lo === '"pk 2"*2', J(rr));
  const rf = FM("f", "peak - floor*peak + max(peak, 1)");
  check("b: renameRef formula", D.renameRef(rf, "peak", "pk") === rf && rf.expr === "pk - floor*pk + max(pk, 1)");
  const rc = CB("c", "peak", "-", "peak"), rt = TF("t", "peak", "abs"), rcn = CB("c", "peak", "-", 3);
  D.renameRef(rc, "peak", "pk"); D.renameRef(rt, "peak", "pk"); D.renameRef(rcn, "peak", "pk");
  check("b: renameRef combine / transform", rc.a === "pk" && rc.b === "pk" && rt.src === "pk" && rcn.b === 3);
  const rl = RD("p", { src: "x" }, { mode: "relative", center: "var:peak", k: 2, offset: 0, halfwidth: 1 });
  D.renameRef(rl, "peak", "max");
  check("b: renameRef migrates a legacy window", rl.window.mode === "center" && rl.window.center === '2*"max"'
    && rl.window.halfwidth === "1" && !("k" in rl.window), J(rl.window));
  const ru = FM("f", "a + b");
  D.renameRef(ru, "zz", "yy"); D.renameRef(ru, "a", "a");
  check("b: renameRef no-op", ru.expr === "a + b" && D.renameRef(null, "a", "b") === null);

  // describe
  check("b: describe reduce center",
    D.describeDef(RD("p", { src: "spectrums", over: "TraceIndex" }, CT("stimulusFrequency", "0.01*stimulusFrequency")))
    === "Peak (max) of spectrums over TraceIndex, inside stimulusFrequency ± 0.01*stimulusFrequency");
  check("b: describe outside_within", D.describeDef(def) === "Mean of s3 over f, outside t + 5 ± 10, within t + 5 ± 22", D.describeDef(def));
  check("b: describe harmonic + db", D.describeDef(RD("p", { src: "a", over: "b", region: "outside", db: "yes", stat: "mean" },
    CT("2*f0 - 1500", "0.02"))) === "Mean of a over b, outside 2*f0 - 1500 ± 0.02 (dB data, linear-power stats)");
  check("b: describe range + empty fields", D.describeDef(RD("p", { src: "a", over: "b", region: "outside_within" }, RG(" lo1 ", "hi\n1", "", "x")))
    === "Peak (max) of a over b, outside [lo1, hi 1], within [?, x]", D.describeDef(RD("p", { src: "a", over: "b", region: "outside_within" }, RG(" lo1 ", "hi\n1", "", "x"))));
  check("b: describe legacy window (migrated)", D.describeDef(RD("p", { src: "a", over: "b" },
    { mode: "relative", center: "coord:f0", k: 1, offset: 0, halfwidth: 1e6 })) === "Peak (max) of a over b, inside f0 ± 1000000");
  check("b: describe formula", D.describeDef(FM("f", "  peak -\n floor ")) === "peak - floor" && D.describeDef(FM("f", "")) === "?");
  check("b: describe combine/transform", D.describeDef(CB("c", "peak", "-", "floor")) === "peak - floor"
    && D.describeDef(CB("c", "a", "max", 3)) === "max(a, 3)" && D.describeDef(TF("x", "p", "db2lin")) === "10^(p/10)"
    && D.describeDef(TF("x", "p", "scale", { scale: 1e-9, offset: 2 })) === "1e-09·p + 2");
  check("b: STATS ids/order", D.STATS.map((s) => s.id).join() === "max,min,mean,median,std,sum,integral,count,argmax_x,argmin_x"
    && D.STATS.every((s) => s.label && s.hint) && D.STATS[0].label === "Peak (max)");
  check("b: REGIONS/OPS/TRANSFORMS/WINDOW_MODES/DB_MODES/KINDS",
    D.REGIONS.map((s) => s.id).join() === "inside,outside,outside_within"
    && D.OPS.map((s) => s.id).join() === "-,+,*,/,max,min" && D.OPS[0].label === "a − b"
    && D.TRANSFORMS.map((s) => s.id).join() === "db2lin,lin2db,scale,abs"
    && J(D.WINDOW_MODES) === J([{ id: "none", label: "Whole span" }, { id: "range", label: "From … to …" },
      { id: "center", label: "Center ± half width" }])
    && D.DB_MODES.map((s) => s.id).join() === "auto,yes,no" && D.MAX_DERIVED === 256
    && D.KINDS.join() === "reduce,combine,transform,formula");
  check("b: re-exports FUNCTIONS / quoteName", D.FUNCTIONS.length === 14 && D.FUNCTIONS[0].name === "abs"
    && D.quoteName("a b") === '"a b"' && D.quoteName("ab") === "ab");
  check("b: depsOf reduce (needed window fields only)",
    J(D.depsOf(RD("p", { src: "a", xsrc: "var:x", region: "outside_within" }, CT("a + 2*b", "c", "d")))) === '["a","x","b","c","d"]'
    && J(D.depsOf(RD("p", { src: "a" }, CT("b", "c", "d")))) === '["a","b","c"]'
    && J(D.depsOf(RD("p", { src: "a" }, { ...RG("lo1", "hi1", "lo2v", "hi2v"), center: "zz" }))) === '["a","lo1","hi1"]'
    && J(D.depsOf(RD("p", { src: "a" }, { mode: "none", center: "zz", lo: "yy" }))) === '["a"]'
    && J(D.depsOf(RD("p", { src: "a" }, CT("max(", "q")))) === '["a","q"]');
  check("b: depsOf formula / combine", J(D.depsOf(FM("f", 'x + max(y, x) * pi - "odd name"'))) === '["x","y","pi","odd name"]'
    && J(D.depsOf(FM("f", "x +"))) === "[]" && J(D.depsOf(CB("c", "a", "-", 3))) === '["a"]'
    && J(D.depsOf(CB("c", "a", "-", "b"))) === '["a","b"]');
  check("b: depsOf legacy window", J(D.depsOf(RD("p", { src: "a", xsrc: "var:x" }, { mode: "relative", center: "var:c", halfwidth: 1 }))) === '["a","x","c"]'
    && J(D.depsOf(RD("p", { src: "a", xsrc: "var:x" }, { center: "var:a" }))) === '["a","x"]');
  check("b: trimUnits / isDb", D.trimUnits(" DBM\n") === "DBM" && D.trimUnits(null) === "" && D.isDb("DBM\n")
    && D.isDb("dBm/Hz") && !D.isDb("mW") && !D.isDb(undefined));
}

// =============================================================================
// (c) sanitizeDef / canonicalDef
// =============================================================================
const EMPTY_W = { mode: "none", lo: "", hi: "", lo2: "", hi2: "", center: "", halfwidth: "", halfwidth2: "" };
const W_ = (o) => ({ ...EMPTY_W, ...o });
{
  const full = {
    name: "peak", file: "darpa.nc", kind: "reduce", units: "", description: "tone",
    src: "spectrums", over: "TraceIndex", xsrc: "var:frequencies",
    window: { mode: "center", lo: "", hi: "", lo2: "", hi2: "", center: "2*stimulusFrequency - 1.5M",
      halfwidth: "3*ResolutionBWs", halfwidth2: "0.25 * stimulusFrequency" },
    region: "outside_within", stat: "median", db: "yes",
  };
  const defs = [full, D.newDef("reduce", "a.nc"), D.newDef("combine", "a.nc"), D.newDef("transform", "a.nc"),
    D.newDef("formula", "a.nc"),
    { ...D.newDef("combine", "f.nc"), name: "SNR", a: "peak", op: "/", b: -3.25 },
    { ...D.newDef("transform", "f.nc"), name: "t1", src: "x", fn: "scale", scale: 1e-9, offset: 7 },
    { ...D.newDef("formula", "f.nc"), name: "snr f", expr: ' peak - "floor 2"\n + 10*log10(ResolutionBWs) ' },
    { ...full, window: { ...full.window, mode: "range", lo: "1", hi: "stimulusFrequency/2", lo2: "-1e3", hi2: "3k" } },
    { ...full, window: { ...full.window, mode: "none" } }];
  for (const d of defs.slice(1, 5)) d.name = "n1";
  for (const d of defs) {
    const c = D.canonicalDef(d);
    const j = J(c);
    const s = D.sanitizeDef(JSON.parse(j));
    check(`c: round trip byte-identical (${d.kind} ${d.name} ${d.window ? d.window.mode : ""})`, s && J(s) === j && J(D.canonicalDef(s)) === j, J(s));
  }
  check("c: newDef is canonical", D.KINDS.every((k) => J(D.canonicalDef(D.newDef(k, "x.nc"))) === J(D.newDef(k, "x.nc"))));
  check("c: newDef formula / reduce window", J(D.newDef("formula", "x.nc")) === J({ name: "", file: "x.nc", kind: "formula",
    units: "", description: "", expr: "" }) && J(D.newDef("reduce").window) === J(EMPTY_W));
  const shuffled = JSON.parse(J({ db: full.db, stat: full.stat, region: full.region,
    window: Object.fromEntries(Object.entries(full.window).reverse()), xsrc: full.xsrc, over: full.over, src: full.src,
    description: full.description, units: full.units, kind: full.kind, file: full.file, name: full.name }));
  check("c: key order canonical regardless of input order", J(D.sanitizeDef(shuffled)) === J(full)
    && J(D.canonicalDef(shuffled)) === J(full));
  check("c: canonical keys", Object.keys(D.canonicalDef(full)).join() === "name,file,kind,units,description,src,over,xsrc,window,region,stat,db"
    && Object.keys(D.canonicalDef(full).window).join() === "mode,lo,hi,lo2,hi2,center,halfwidth,halfwidth2"
    && Object.keys(D.newDef("combine")).join() === "name,file,kind,units,description,a,op,b"
    && Object.keys(D.newDef("transform")).join() === "name,file,kind,units,description,src,fn,scale,offset"
    && Object.keys(D.newDef("formula")).join() === "name,file,kind,units,description,expr");
  const cd = D.canonicalDef(full);
  cd.window.lo = "99";
  check("c: canonicalDef is a deep copy", full.window.lo === "");
  check("c: canonicalDef keeps a half-edited def", D.canonicalDef({ kind: "reduce", name: "" }).name === ""
    && D.canonicalDef({ kind: "reduce", stat: "bogus" }).stat === "bogus"
    && D.canonicalDef({ kind: "reduce", window: { mode: "bogus", lo: "x" } }).window.mode === "bogus");
  check("c: expression fields: numbers -> num(x), other types -> '', strings kept verbatim",
    J(D.canonicalDef({ kind: "reduce", window: { mode: "range", lo: 5e-7, hi: " a\n", lo2: null, hi2: {}, center: [1] } }).window)
    === J(W_({ mode: "range", lo: "5e-7", hi: " a\n" }))
    && J(D.sanitizeDef({ kind: "reduce", name: "x", window: { mode: "range", lo: 5e-7, hi: " a\n", lo2: null, hi2: {}, center: [1] } }).window)
    === J(W_({ mode: "range", lo: "5e-7", hi: " a\n" }))
    && D.canonicalDef({ kind: "formula", expr: 2.5 }).expr === "2.5" && D.sanitizeDef({ kind: "formula", name: "x", expr: 1e21 }).expr === "1e+21"
    && D.sanitizeDef({ kind: "formula", name: "x", expr: { a: 1 } }).expr === "" && D.sanitizeDef({ kind: "formula", name: "x" }).expr === "");
  // 320, not 300: a migrated bc9812f center can be 311 characters long
  check("c: expression caps 320 / 1000 (sanitize and canonical alike)",
    D.sanitizeDef({ kind: "reduce", name: "x", window: { mode: "center", center: "a".repeat(400) } }).window.center.length === 320
    && D.canonicalDef({ kind: "reduce", window: { mode: "center", halfwidth2: "b".repeat(400) } }).window.halfwidth2.length === 320
    && D.sanitizeDef({ kind: "formula", name: "x", expr: "c".repeat(5000) }).expr.length === 1000
    && D.canonicalDef({ kind: "formula", expr: "c".repeat(5000) }).expr.length === 1000
    && D.EXPR_MAX === 320 && D.FORMULA_MAX === 1000);

  // hostile input
  const hostile = JSON.parse(`{"__proto__": {"polluted": 1}, "constructor": {"prototype": {"polluted2": 1}},
    "kind": "reduce", "name": "  ${"a".repeat(10000)}  ", "units": "${"u".repeat(100)}", "description": "${"d".repeat(5000)}",
    "src": "${"s".repeat(1000)}", "over": 5, "xsrc": "var:${"x".repeat(1000)}",
    "window": {"__proto__": {"mode": "fixed"}, "lo": "5", "hi": 1e400, "k": "2", "offset": null, "halfwidth": {}, "center": "coord:t"},
    "stat": "mean"}`);
  const h = D.sanitizeDef(hostile);
  check("c: hostile def sanitized", h !== null);
  check("c: no prototype pollution", ({}).polluted === undefined && ({}).polluted2 === undefined
    && Object.getPrototypeOf(h) === Object.prototype && !("polluted" in h) && Object.getPrototypeOf(h.window) === Object.prototype);
  check("c: string caps", h.name.length === 64 && h.units.length === 32 && h.description.length === 200
    && h.src.length === 256 && h.xsrc.length === 4 + 256);
  check("c: hostile legacy window (numbers / coord: refs) -> migrated, mode none", h.over === "" && J(h.window) === J(EMPTY_W));
  check("c: hostile keys only canonical", Object.keys(h).join() === Object.keys(D.newDef("reduce")).join());
  const hostile2 = JSON.parse(`{"kind": "reduce", "name": "h2", "window": {"__proto__": {"mode": "range"}, "mode": "center",
    "center": 5, "halfwidth": {}, "lo": "${"x".repeat(1000)}", "halfwidth2": ["a"], "k": 3, "constructor": "zz"}}`);
  const h2 = D.sanitizeDef(hostile2);
  check("c: hostile new-format window", h2 && J(Object.keys(h2.window)) === J(Object.keys(EMPTY_W))
    && h2.window.mode === "center" && h2.window.center === "5" && h2.window.halfwidth === "" && h2.window.lo.length === 320
    && h2.window.halfwidth2 === "" && Object.getPrototypeOf(h2.window) === Object.prototype, J(h2));
  const hostile3 = JSON.parse('{"__proto__": {"expr": "evil"}, "kind": "formula", "name": "f", "expr": "a + b", "toString": 1}');
  const h3 = D.sanitizeDef(hostile3);
  check("c: hostile formula", h3 && J(h3) === J({ name: "f", file: "", kind: "formula", units: "", description: "", expr: "a + b" }));
  check("c: inherited formula expr ignored", D.sanitizeDef(JSON.parse('{"__proto__": {"expr": "evil"}, "kind": "formula", "name": "f"}')).expr === "");
  const bad = (o) => D.sanitizeDef({ kind: "reduce", name: "x", ...o });
  check("c: rejects", D.sanitizeDef(null) === null && D.sanitizeDef([]) === null && D.sanitizeDef("x") === null
    && D.sanitizeDef(5) === null && D.sanitizeDef({ kind: "magic", name: "x" }) === null
    && D.sanitizeDef({ name: "x" }) === null && D.sanitizeDef({ kind: "reduce" }) === null
    && D.sanitizeDef({ kind: "formula", name: "a/b", expr: "1" }) === null
    && D.sanitizeDef({ kind: "reduce", name: "a/b" }) === null && D.sanitizeDef({ kind: "reduce", name: "__proto__" }) === null
    && bad({ stat: "mode" }) === null && bad({ region: "x" }) === null && bad({ db: 1 }) === null
    && bad({ xsrc: "var:" }) === null && bad({ xsrc: 5 }) === null && bad({ window: [] }) === null && bad({ window: "x" }) === null
    && bad({ window: { mode: "x" } }) === null && bad({ window: { mode: 3 } }) === null
    && bad({ window: { mode: "relative", center: "foo" } }) === null && bad({ window: { mode: "fixed", center: 5 } }) === null
    && bad({ window: { mode: "relative", center: "var:" } }) === null && bad({ window: { mode: "bogus", lo: 5 } }) === null
    && bad({ window: { center: "coord:" } }) === null
    && D.sanitizeDef({ kind: "combine", name: "x", op: "^" }) === null
    && D.sanitizeDef({ kind: "transform", name: "x", fn: "sqrt" }) === null);
  check("c: new-format windows accept any expression text", J(bad({ window: { center: "foo" } }).window) === J(W_({ center: "foo" }))
    && bad({ window: { mode: "center", center: "var:x" } }).window.center === "var:x"
    && bad({ window: { mode: "range", lo: "%%", hi: "1 +" } }).window.lo === "%%");
  check("c: function-named defs are kept (validateName reports them)", bad({}) !== null
    && D.sanitizeDef({ kind: "formula", name: "max", expr: "1" }).name === "max"
    && D.sanitizeDef({ kind: "formula", name: "pi", expr: "1" }).name === "pi");
  check("c: inherited props ignored", D.sanitizeDef(Object.create({ kind: "reduce", name: "x" })) === null);
  const nullProto = Object.assign(Object.create(null), { kind: "transform", name: "x", src: "y", fn: "scale", scale: NaN, offset: "1" });
  const np = D.sanitizeDef(nullProto);
  check("c: null-prototype input, NaN/strings in numbers", np && np.scale === 1 && np.offset === 0);
  const npw = D.sanitizeDef(Object.assign(Object.create(null), { kind: "reduce", name: "x",
    window: Object.assign(Object.create(null), { mode: "center", center: "c", halfwidth: NaN }) }));
  check("c: null-prototype window, NaN -> ''", npw && npw.window.center === "c" && npw.window.halfwidth === "");
  check("c: combine b types", D.sanitizeDef({ kind: "combine", name: "x", b: NaN }).b === ""
    && D.sanitizeDef({ kind: "combine", name: "x", b: true }).b === ""
    && D.sanitizeDef({ kind: "combine", name: "x", b: -2.5 }).b === -2.5
    && D.sanitizeDef({ kind: "combine", name: "x", b: "v" }).b === "v");
  check("c: missing enums -> defaults", J(D.sanitizeDef({ kind: "reduce", name: "x" }))
    === J({ ...D.newDef("reduce", ""), name: "x" }));
  check("c: units trimmed", D.sanitizeDef({ kind: "transform", name: "x", units: " DBM\n" }).units === "DBM");
  for (const [i, raw] of [hostile, hostile2, hostile3].entries()) {
    const once = D.sanitizeDef(raw);
    check(`c: sanitize idempotent on hostile input ${i}`, J(D.sanitizeDef(JSON.parse(J(once)))) === J(once)
      && J(D.canonicalDef(once)) === J(once));
  }
}

// legacy (bc9812f) windows -> the new form (E3), identical in sanitizeDef and canonicalDef
const HEAD_DEFAULT_WINDOW = { mode: "none", lo: null, hi: null, lo2: null, hi2: null, center: "", k: 1,
  offset: 0, halfwidth: null, halfwidth2: null };
{
  const L = (o) => ({ ...HEAD_DEFAULT_WINDOW, ...o });
  const table = [
    ["fixed", L({ mode: "fixed", lo: 1e6, hi: 2.5e-7, hi2: 1e21 }),
      W_({ mode: "range", lo: "1000000", hi: "2.5e-7", hi2: "1e+21" })],
    ["fixed, negative / swapped / outer", L({ mode: "fixed", lo: 40, hi: -20.5, lo2: 0, hi2: -1e-7 }),
      W_({ mode: "range", lo: "40", hi: "-20.5", lo2: "0", hi2: "-1e-7" })],
    ["relative coord:, k 1, offset 0", L({ mode: "relative", center: "coord:stimulusFrequency", halfwidth: 1e6, halfwidth2: 1e7 }),
      W_({ mode: "center", center: "stimulusFrequency", halfwidth: "1000000", halfwidth2: "10000000" })],
    ["relative var:, k, negative offset, negative hw", L({ mode: "relative", center: "var:pump_nm", k: 2, offset: -1500, halfwidth: -0.02 }),
      W_({ mode: "center", center: "2*pump_nm - 1500", halfwidth: "0.02" })],
    ["relative negative k, positive offset", L({ mode: "relative", center: "coord:t", k: -10, offset: 200, halfwidth: 5, halfwidth2: -7.5 }),
      W_({ mode: "center", center: "-10*t + 200", halfwidth: "5", halfwidth2: "7.5" })],
    ["relative odd name, tiny offset", L({ mode: "relative", center: "var:my var.1", k: 0.5, offset: 1e-7 }),
      W_({ mode: "center", center: '0.5*"my var.1" + 1e-7' })],
    ["relative function-named var", L({ mode: "relative", center: "var:max", halfwidth: 1 }),
      W_({ mode: "center", center: '"max"', halfwidth: "1" })],
    ["relative var named pi, huge k", L({ mode: "relative", center: "var:pi", k: 1e21, halfwidth: 0 }),
      W_({ mode: "center", center: '1e+21*"pi"', halfwidth: "0" })],
    ["relative without center", L({ mode: "relative", center: "", k: 3, offset: 2, halfwidth: 2 }),
      W_({ mode: "center", halfwidth: "2" })],
    ["relative bad k/offset/hw types", { mode: "relative", center: "coord:x", k: "2", offset: null, halfwidth: "3" },
      W_({ mode: "center", center: "x" })],
    ["relative without k/offset keys", { mode: "relative", center: "var:a_b", halfwidth: 0.5 },
      W_({ mode: "center", center: "a_b", halfwidth: "0.5" })],
    ["relative long name capped", { mode: "relative", center: "coord:" + "z".repeat(300), halfwidth: 1 },
      W_({ mode: "center", center: "z".repeat(256), halfwidth: "1" })],
    ["none with values", L({ mode: "none", lo: 5, center: "var:x", halfwidth: 3 }), W_({})],
    ["mode missing, numeric field", { lo: 5 }, W_({})],
    ["mode missing, coord: center", { center: "coord:t" }, W_({})],
    ["the bc9812f default window", HEAD_DEFAULT_WINDOW, W_({})],
  ];
  for (const [what, legacy, want] of table) {
    const s = D.sanitizeDef({ kind: "reduce", name: "x", window: JSON.parse(J(legacy)) });
    const c = D.canonicalDef({ kind: "reduce", window: JSON.parse(J(legacy)) });
    check(`c: legacy window: ${what}`, s && J(s.window) === J(want) && J(c.window) === J(want), { s: s && s.window, c: c.window });
  }
  // migrated numbers parse back exactly (num(x) = shortest round trip)
  const E = await import(moduleUrl("expr.js"));
  let seed = 7, ok = true;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = 0; i < 2000 && ok; i++) {
    const x = (rnd() - 0.5) * Math.pow(10, Math.floor(rnd() * 40) - 20);
    const w = D.sanitizeDef({ kind: "reduce", name: "x", window: { mode: "relative", center: "var:c", k: x, offset: -x, halfwidth: x } }).window;
    const v = E.evalExpr(E.parseExpr(w.center), (n) => (n === "c" ? 3 : undefined), 1)[0];
    if (v !== x * 3 + -x || Number(w.halfwidth) !== Math.abs(x)) ok = false;
  }
  check("c: migrated center k*c + offset is bit-identical (2000 random k/offset)", ok);
}

// regressions from the verification of the expressions amendment
{
  const X = await import(moduleUrl("explore.js"));
  // a NON-numeric variable named pi is an error (E1), not the constant
  const dp = mkds("syn.nc", { t: 3, f: 2 }, {
    v: { dims: ["t"], data: [1, 2, 3], units: "V" },
    pi: { dims: ["t"], data: "abc", char: true },
    spec: { dims: ["t", "f"], data: [1, 2, 3, 4, 5, 6], units: "V" },
  });
  check("r: a non-numeric variable named pi is not the constant",
    /'pi' is not numeric/.test(err(dp, FM("x", "pi")) || "") && /'pi' is not numeric/.test(err(dp, FM("x", "v*pi")) || "")
    && /'pi' is not numeric/.test(D.exprError(dp, FM("x", "v*pi"), "expr") || "")
    && /'pi' is not numeric/.test(D.exprError(dp, RD("x", { src: "spec", over: "f" }, CT("pi", "1")), "center") || ""));

  // time units: the values are seconds, so a formula's auto units are "s" (a
  // derived result is not labelled 'ns' and scaled again where it is used);
  // units are trimmed before the time test (' minutes')
  const dt = mkds("syn.nc", { t: 3 }, {
    tn: { dims: ["t"], data: [1, 2, 3], units: "ns" },
    tm: { dims: ["t"], data: [1, 2, 3], units: " minutes" },
    v: { dims: ["t"], data: [1, 2, 3], units: "V" },
  });
  let st = D.registerDerived(dt, [FM("tt", "tn"), FM("tt2", "tt*1"), FM("mm", "tm"), FM("vt", "v*tn")]);
  check("r: time units -> seconds once, formula units 's'", [...st.values()].every((s) => s.ok)
    && allNear(dt.vars.tt.data, [1e-9, 2e-9, 3e-9]) && dt.vars.tt.attrs.units === "s"
    && same(dt.vars.tt2.data, dt.vars.tt.data) && dt.vars.tt2.attrs.units === "s"
    && allNear(dt.vars.mm.data, [60, 120, 180]) && dt.vars.mm.attrs.units === "s"
    && dt.vars.vt.attrs.units === "V·s", J([...st]));
  check("r: asFloatArray trims the units", X.asFloatArray([1], " minutes")[0] === 60 && X.asFloatArray([1], "ns\n")[0] === 1e-9);

  // a dimension name never means a NON-coordinate variable of that name
  // (bc9812f's "coord:<dim>" centers read the index there)
  const dh = mkds("syn.nc", { q: 3, h: 2, f: 2 }, {
    h: { dims: ["q", "h"], data: [5, 16, 27, 38, 49, 60] },
    spec: { dims: ["q", "h", "f"], data: Array.from({ length: 12 }, (_, i) => i), units: "dBm" },
  });
  let r = comp(dh, FM("x", "h*10"));
  check("r: dim name with a non-coordinate variable -> the index", J(r.dims) === '["h"]' && allNear(r.data, [0, 10]), show(r.data));
  r = comp(dh, RD("x", { src: "spec", over: "q", xsrc: "index", stat: "count" }, CT("h", "0")));
  check("r: ... also in a window over the result dims", allNear(r.data, [1, 1, 1, 1]), show(r.data));
  check("r: name pickers list it as the dim index", D.formulaNames(dh).filter((e) => e.name === "h").map((e) => e.isDim).join() === "true"
    && D.windowNames(dh, "spec", "f").filter((e) => e.name === "h").map((e) => e.isDim).join() === "true");

  // window defined by its EXPRESSION values: center ± half width overflowing
  // to ±Inf is an infinite edge (bc9812f), a non-finite half width is undefined
  const dv = mkds("syn.nc", { t: 2, f: 4 }, {
    big: { dims: ["t"], data: [1e308, 5] },
    f: { dims: ["f"], data: [0, 1e308, 1.7e308, 5] },
    spec: { dims: ["t", "f"], data: [1, 2, 3, 4, 5, 6, 7, 8], units: "V" },
  });
  const cnt = { src: "spec", over: "f", xsrc: "coord", stat: "count" };
  check("r: overflowing window edge", allNear(comp(dv, RD("o", cnt, CT("big", "1e308"))).data, [4, 3])
    && allNear(comp(dv, RD("o", { ...cnt, region: "outside_within" }, CT("big", "0", "1.7e308"))).data, [3, 3])
    && allNear(comp(dv, RD("o", cnt, CT("big", "1/0"))).data, [0, 0]));

  // legacy detection: a mode-none window with typed expressions is not legacy
  const typed = { mode: "none", lo: "", hi: "", lo2: "", hi2: "", center: "var:stimulusFrequency",
    halfwidth: "0.01*stimulusFrequency", halfwidth2: "3*ResolutionBWs" };
  check("r: mode-none window with expressions and a 'var:' center keeps its text",
    J(D.canonicalDef({ kind: "reduce", window: typed }).window) === J(typed)
    && J(D.sanitizeDef({ kind: "reduce", name: "x", window: typed }).window) === J(typed)
    && J(D.canonicalDef({ kind: "reduce", window: { center: "var:x", halfwidth: "" } }).window) === J(EMPTY_W)
    && J(D.canonicalDef({ kind: "reduce", window: { mode: "none", center: "coord:t", k: 1 } }).window) === J(EMPTY_W));
  check("r: a null window mode computes as none (as bc9812f), sanitizeDef still rejects it",
    D.canonicalDef({ kind: "reduce", window: { mode: null } }).window.mode === "none"
    && D.sanitizeDef({ kind: "reduce", name: "x", window: { mode: null } }) === null
    && allNear(comp(mk1(), RD("n", { src: "spec", over: "f", xsrc: "coord", stat: "max" }, { mode: null })).data, [-20, -25, -22]));

  // CF packing (as xarray's mask_and_scale in the report): fill first, then scale
  const pv = new Variable("sc", { dims: ["a"], shape: [3], dtype: "short", numeric: true,
    attrs: { scale_factor: [0.5], add_offset: [10], _FillValue: [-1] }, data: Int16Array.of(1, -1, 3) });
  check("r: scale_factor / add_offset applied after the fill mask", same(pv.data, [10.5, NaN, 11.5]), show(pv.data));
}

// =============================================================================
// (d) real data
// =============================================================================
const realDefs = {};      // file -> defs (also used by the cross-check)
const sd = (file, kind, name, o) => {
  const d = D.sanitizeDef({ kind, name, file, ...o });
  if (!d) throw new Error("bad test def " + name);
  return d;
};

{
  const F = "darpa.nc", r = (n, o) => sd(F, "reduce", n, { src: "spectrums", over: "TraceIndex", xsrc: "var:frequencies", ...o });
  const fm = (n, expr) => sd(F, "formula", n, { expr });
  const W = CT("stimulusFrequency", "1M");
  realDefs[F] = [
    r("d_peak", { window: W, stat: "max" }),
    r("d_floor", { window: W, stat: "mean", region: "outside" }),
    sd(F, "combine", "d_SNR", { a: "d_peak", op: "-", b: "d_floor" }),
    r("d_fpk", { window: W, stat: "argmax_x" }),
    r("d_fmin", { window: CT("stimulusFrequency", "1e6", "5e6"), stat: "argmin_x", region: "outside_within" }),
    r("d_med", { window: CT("stimulusFrequency", "1e6", "1e7"), stat: "median", region: "outside_within" }),
    r("d_std_lin", { window: W, stat: "std", region: "outside", db: "no" }),
    r("d_std_db", { window: W, stat: "std", region: "outside", db: "yes" }),
    r("d_int", { window: CT("stimulusFrequency", "2e6"), stat: "integral" }),
    r("d_int_lin", { stat: "integral", db: "no" }),
    r("d_cnt", { window: CT("stimulusFrequency", "3e6"), stat: "count" }),
    r("d_h2", { window: CT("2*stimulusFrequency - 40M", "1e6"), stat: "max" }),
    r("d_pk2", { window: CT("d_fpk", "1e5"), stat: "max" }),
    sd(F, "combine", "d_norm", { a: "spectrums", op: "-", b: "d_peak" }),
    sd(F, "combine", "d_rev", { a: "d_peak", op: "-", b: "spectrums" }),
    sd(F, "transform", "d_lin", { src: "spectrums", fn: "db2lin" }),
    sd(F, "reduce", "d_linsum", { src: "d_lin", over: "TraceIndex", xsrc: "var:frequencies", stat: "sum",
      window: RG("2.9e7", "3.1e7") }),
    sd(F, "transform", "d_back", { src: "d_lin", fn: "lin2db" }),
    sd(F, "transform", "d_fGHz", { src: "frequencies", fn: "scale", scale: 1e-9, offset: 0, units: "GHz" }),
    sd(F, "reduce", "d_pk_ghz", { src: "spectrums", over: "TraceIndex", xsrc: "var:d_fGHz", stat: "max",
      window: RG("0.031", "0.029") }),
    sd(F, "reduce", "d_tr_min", { src: "spectrums", over: "trace", xsrc: "index", stat: "min", window: RG("0", "1") }),
    sd(F, "reduce", "d_amp_mean", { src: "spectrums", over: "stimulusAmp", xsrc: "coord", stat: "mean", db: "yes" }),
    sd(F, "combine", "d_ratio", { a: "d_peak", op: "/", b: "d_floor" }),
    sd(F, "combine", "d_mul", { a: "d_peak", op: "*", b: 2 }),
    sd(F, "combine", "d_max", { a: "d_peak", op: "max", b: "d_floor" }),
    sd(F, "combine", "d_min", { a: "d_fpk", op: "min", b: "d_fmin" }),
    sd(F, "combine", "d_plus", { a: "d_peak", op: "+", b: -30 }),
    sd(F, "transform", "d_abs", { src: "spectrums", fn: "abs" }),
    sd(F, "reduce", "d_lw", { src: "spectrums", over: "TraceIndex", xsrc: "index", stat: "mean", db: "no",
      window: CT("-10*laswrPowers", "50") }),
    sd(F, "reduce", "d_cidx", { src: "spectrums", over: "TraceIndex", xsrc: "coord", stat: "max",
      window: CT("100*trace + 200", "50") }),
    // the PI's cases: half width proportional to the stimulus frequency / to the RBW used there
    r("d_pk_rel", { window: CT("stimulusFrequency", "0.01*stimulusFrequency"), stat: "max" }),
    r("d_pk_rbw", { window: CT("stimulusFrequency", "3*ResolutionBWs"), stat: "max" }),
    r("d_fl_rbw", { window: CT("stimulusFrequency", "3*ResolutionBWs", "0.25*stimulusFrequency"), stat: "mean",
      region: "outside_within" }),
    r("d_cnt_rbw", { window: CT("stimulusFrequency", "3*ResolutionBWs"), stat: "count" }),
    r("d_rng", { window: RG("stimulusFrequency - 2M", "stimulusFrequency + 2M"), stat: "integral" }),
    r("d_rng_ow", { window: RG("1.1*stimulusFrequency", "0.9*stimulusFrequency", "stimulusFrequency/2",
      "stimulusFrequency*1.5"), stat: "count", region: "outside_within" }),
    r("d_hwvbw", { window: CT("stimulusFrequency + VideoBWs", "100*VideoBWs + 2*stimulusAmp"), stat: "max" }),
    r("d_idx", { window: CT("stimulusFrequency", "(1 + trace)*1M"), stat: "argmax_x" }),
    fm("d_snr_f", "d_peak - d_floor"),
    fm("d_snr_rbw", "d_pk_rbw - d_fl_rbw"),
    fm("d_dens", "d_floor - 10*log10(ResolutionBWs)"),
    fm("d_normf", "spectrums - d_peak"),
    fm("d_revf", "d_peak - spectrums"),
    fm("d_ratiof", "ResolutionBWs/VideoBWs"),
    fm("d_mix", "trace*2 + stimulusAmp*1k - pi"),
    fm("d_linr", "db2lin(d_peak) / db2lin(d_floor)"),
    fm("d_fn", "max(d_peak, d_floor + 30) + min(abs(d_fpk/1M), 2)^2 - sqrt(abs(d_floor)) + round(d_peak) - ceil(ln(abs(d_floor)))"),
    fm("d_two_pi", "2*pi"),
    fm("d_pw", "(d_fpk/1M)^-2 + pow(stimulusAmp, 0.5)"),
  ];
}
{
  const F = "sidebands.nc", r = (n, o) => sd(F, "reduce", n, { src: "spectra_dbm", over: "wl", xsrc: "var:wl_nm", ...o });
  const fm = (n, expr) => sd(F, "formula", n, { expr });
  realDefs[F] = [
    r("s_pk", { window: CT("pump_nm", "0.02"), stat: "max" }),
    r("s_sbl", { window: CT("sb_low_nm", "0.01"), stat: "max" }),
    r("s_sbl_out", { window: CT("sb_low_nm", "0.01"), stat: "mean", region: "outside" }),
    r("s_floor", { window: CT("pump_nm", "0.05", "0.5"), stat: "mean", region: "outside_within" }),
    r("s_int", { window: RG("1550", "1551"), stat: "integral" }),
    r("s_med", { window: RG("1549.6", "1550.3"), stat: "median" }),
    sd(F, "combine", "s_snr", { a: "s_pk", op: "-", b: "s_floor" }),
    sd(F, "combine", "s_diff", { a: "pump_dbm", op: "-", b: "s_pk" }),
    sd(F, "reduce", "s_over_freq", { src: "spectra_dbm", over: "freq", xsrc: "var:freq_Hz", stat: "std", db: "no",
      window: RG("1G", "2e10") }),
    sd(F, "reduce", "s_idxc", { src: "spectra_dbm", over: "freq", xsrc: "index", stat: "max",
      window: CT("0.3*wl", "10") }),
    r("s_cnt", { window: RG("1550.4", "1550.6", "1550", "1551"), stat: "count", region: "outside_within" }),
    r("s_sbl_cnt", { window: CT("sb_low_nm", "0.01"), stat: "count" }),
    r("s_sbl_rng", { window: RG("sb_low_nm - 0.01", "sb_low_nm + 0.01"), stat: "max" }),
    r("s_sbu", { window: CT("(sb_up_nm + sb_low_nm)/2", "abs(sb_up_nm - sb_low_nm)/2 + 0.01"), stat: "count" }),
    fm("s_snr_f", "s_pk - s_floor"),
    fm("s_rel", "spectra_dbm - pump_dbm"),
    fm("s_lin", "db2lin(pump_dbm)"),
    fm("s_wlf", "wl_nm * freq_Hz / 1e9"),
    fm("s_pw", "pump_nm^2"),
    fm("s_inv", "1/freq_Hz"),
    fm("s_pow", "pow(pump_nm, -1) + 0*sb_resolved"),
    fm("s_sum", "pump_dbm + vna_power_actual"),
    fm("s_dbsum", "s_snr_f + pump_dbm"),
    fm("s_dev", "abs(pump_nm - 1550.5) * 1k"),
    fm("s_back", "lin2db(db2lin(pump_dbm))"),
    fm("s_q", '"pump_nm" - "sb_low_nm"'),
  ];
}
{
  const F = "fourd.nc";
  realDefs[F] = [
    sd(F, "reduce", "f_pk", { src: "spectra", over: "traceindex", xsrc: "var:frequency", stat: "max" }),
    sd(F, "reduce", "f_fpk", { src: "spectra", over: "traceindex", xsrc: "var:frequency", stat: "argmax_x" }),
    sd(F, "reduce", "f_win", { src: "spectra", over: "traceindex", xsrc: "var:frequency", stat: "mean",
      window: CT("1G*d1 + 2G", "500M") }),
    sd(F, "reduce", "f_d1", { src: "spectra", over: "d1", xsrc: "coord", stat: "mean", db: "yes" }),
    sd(F, "reduce", "f_d3", { src: "spectra", over: "d3", xsrc: "coord", stat: "integral", db: "no",
      window: RG("0", "2") }),
    sd(F, "reduce", "f_sum", { src: "spectra", over: "d2", xsrc: "index", stat: "sum" }),
    sd(F, "reduce", "f_cnt", { src: "spectra", over: "traceindex", xsrc: "var:frequency", stat: "count",
      window: CT("1G*d1 + 1G*d2 + 2G + 0*d3", "0.25G") }),
    sd(F, "formula", "f_form", { expr: "f_pk - f_d1" }),
  ];
}
{
  const F = "powercal_hdf5.nc", W = CT("frequency", "20M");
  realDefs[F] = [
    sd(F, "reduce", "p_pk", { src: "sa_trace", over: "sa_point", xsrc: "var:sa_freq", stat: "max", window: W }),
    sd(F, "reduce", "p_floor", { src: "sa_trace", over: "sa_point", xsrc: "var:sa_freq", stat: "mean", region: "outside", window: W }),
    sd(F, "combine", "p_d", { a: "sa_peak", op: "-", b: "p_pk" }),
    sd(F, "reduce", "p_mean_sweep", { src: "sa_peak", over: "sweep", xsrc: "index", stat: "mean", db: "no" }),
    sd(F, "reduce", "p_mean_sweep_db", { src: "sa_peak", over: "sweep", xsrc: "index", stat: "mean" }),
    sd(F, "reduce", "p_std", { src: "sa_peak", over: "sweep", xsrc: "index", stat: "std", db: "no" }),
    sd(F, "reduce", "p_amin", { src: "sa_trace", over: "sa_point", xsrc: "coord", stat: "argmin_x" }),
    sd(F, "reduce", "p_pk_all", { src: "sa_trace", over: "sa_point", xsrc: "var:sa_freq", stat: "max" }),
    sd(F, "reduce", "p_rel", { src: "sa_trace", over: "sa_point", xsrc: "var:sa_freq", stat: "max",
      window: CT("frequency", "0.01*frequency") }),
    sd(F, "formula", "p_gain", { expr: "p_pk - vna_power" }),
  ];
}

const loaded = {};
for (const F of Object.keys(realDefs)) {
  if (!haveData(F)) { skip(`d: ${F}`, "tests/data file missing"); continue; }
  const ds = await loadDataset(dataFile(F));
  const st = D.registerDerived(ds, realDefs[F]);
  const bad = [...st].filter(([, s]) => !s.ok);
  check(`d: ${F}: all ${st.size} defs register`, bad.length === 0 && st.size === realDefs[F].length, J(bad));
  loaded[F] = ds;
}
if (loaded["darpa.nc"]) {
  const ds = loaded["darpa.nc"];
  const v = (n) => ds.vars[n];
  check("d: darpa suggestXsrc -> var:frequencies", D.suggestXsrc(ds, "spectrums", "TraceIndex") === "var:frequencies");
  check("d: darpa peak dims", J(v("d_peak").dims) === '["stimulusFrequency","stimulusAmp","trace"]'
    && J(v("d_peak").shape) === "[2,2,3]" && v("d_peak").attrs.units === "DBM");
  check("d: darpa SNR = peak - floor exactly", allNear(v("d_SNR").data, Array.from(v("d_peak").data, (p, i) => p - v("d_floor").data[i]), 0)
    && v("d_SNR").attrs.units === "dB");
  // brute force, independent of the kernel: [TraceIndex, sf, sa, trace] C order
  const S = v("spectrums").data, Fq = v("frequencies").data, sfv = v("stimulusFrequency").data;
  const rbw = v("ResolutionBWs").data;
  const brute = (hwOf) => {
    const pk = [], fl = [];
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) for (let t = 0; t < 3; t++) {
      const hw = hwOf(i, j);
      let mx = -Infinity, sum = 0, c = 0;
      for (let k = 0; k < 601; k++) {
        const f = Fq[k * 4 + i * 2 + j], y = S[k * 12 + i * 6 + j * 3 + t];
        if (f >= sfv[i] - hw && f <= sfv[i] + hw) mx = Math.max(mx, y); else { sum += lin(y); c++; }
      }
      pk.push(mx); fl.push(todb(sum / c));
    }
    return { pk, fl };
  };
  const b1 = brute(() => 1e6);
  check("d: darpa peak = brute force", allNear(v("d_peak").data, b1.pk, 0), show(v("d_peak").data));
  check("d: darpa floor = brute force (linear mean)", allNear(v("d_floor").data, b1.fl, 1e-12));
  check("d: darpa SNR plausible (> 0 dB)", Array.from(v("d_SNR").data).every((x) => x > 0));
  check("d: darpa peak at derived center == peak", allNear(v("d_pk2").data, v("d_peak").data, 0));
  check("d: darpa db2lin units mW / lin2db back", v("d_lin").attrs.units === "mW" && v("d_back").attrs.units === "dBm"
    && allNear(v("d_back").data, S, 1e-12));
  check("d: darpa broadcast dims", J(v("d_norm").dims) === J(v("spectrums").dims)
    && J(v("d_rev").dims) === '["stimulusFrequency","stimulusAmp","trace","TraceIndex"]');
  check("d: darpa x at peak inside window", Array.from(v("d_fpk").data).every((x, i) => Math.abs(x - sfv[Math.floor(i / 6)]) <= 1e6));
  const pv = D.previewSlice(ds, realDefs["darpa.nc"][0], { stimulusFrequency: 1, stimulusAmp: 1, trace: 2 });
  check("d: darpa preview value = registered element", pv.value === v("d_peak").data[11] && pv.center === 1e8 && pv.db);
  // expression windows (the PI's request)
  const b2 = brute((i) => 0.01 * sfv[i]), b3 = brute((i, j) => 3 * rbw[i * 2 + j]);
  check("d: darpa window ± 0.01*stimulusFrequency = brute force", allNear(v("d_pk_rel").data, b2.pk, 0), show(v("d_pk_rel").data));
  check("d: darpa window ± 3*ResolutionBWs = brute force", allNear(v("d_pk_rbw").data, b3.pk, 0), show(v("d_pk_rbw").data));
  {
    const def = realDefs["darpa.nc"].find((d) => d.name === "d_cnt_rbw");
    const w0 = D.previewSlice(ds, def, { stimulusFrequency: 0 }).inner, w1 = D.previewSlice(ds, def, { stimulusFrequency: 1 }).inner;
    // RBW ∝ span here, so ± 3 RBW always holds the same number of trace points
    check("d: darpa RBW window width follows the RBW of each stimulus", J(Array.from(rbw)) === "[300000,300000,1000000,1000000]"
      && J(w0) === J([3e7 - 9e5, 3e7 + 9e5]) && J(w1) === J([1e8 - 3e6, 1e8 + 3e6])
      && Array.from(v("d_cnt_rbw").data).every((c) => c === 37), show(v("d_cnt_rbw").data));
  }
  const pr = D.previewSlice(ds, realDefs["darpa.nc"].find((d) => d.name === "d_pk_rbw"), { stimulusFrequency: 1, stimulusAmp: 0, trace: 1 });
  check("d: darpa preview of the RBW window", pr.center === 1e8 && J(pr.inner) === J([1e8 - 3e6, 1e8 + 3e6])
    && pr.value === v("d_pk_rbw").data[7]);
  check("d: darpa exprValueAt of the RBW half width",
    D.exprValueAt(ds, realDefs["darpa.nc"].find((d) => d.name === "d_pk_rbw"), "halfwidth", { stimulusFrequency: 0, stimulusAmp: 1 }) === 9e5);
  check("d: darpa range from expressions == center ± 2M", same(v("d_rng").data, v("d_int").data));
  check("d: darpa formula peak - floor == combine, dB", same(v("d_snr_f").data, v("d_SNR").data) && v("d_snr_f").attrs.units === "dB");
  check("d: darpa formula spectrums - peak == combine (dims too)", same(v("d_normf").data, v("d_norm").data)
    && J(v("d_normf").dims) === J(v("d_norm").dims) && same(v("d_revf").data, v("d_rev").data)
    && J(v("d_revf").dims) === J(v("d_rev").dims));
  check("d: darpa formula floor - 10*log10(RBW): broadcast, units", J(v("d_dens").dims) === '["stimulusFrequency","stimulusAmp","trace"]'
    && v("d_dens").attrs.units === "DBM"
    && same(v("d_dens").data, Array.from(v("d_floor").data, (x, i) => x - 10 * Math.log10(rbw[Math.floor(i / 3)]))));
  check("d: darpa formula dims in order of first appearance", J(v("d_mix").dims) === '["trace","stimulusAmp"]'
    && J(v("d_ratiof").dims) === '["stimulusFrequency","stimulusAmp"]' && J(v("d_two_pi").shape) === "[]");
  const wn = D.windowNames(ds, "spectrums", "TraceIndex").map((e) => e.name);
  check("d: darpa windowNames", ["stimulusFrequency", "stimulusAmp", "trace", "laswrPowers", "VideoBWs", "ResolutionBWs", "d_peak"]
    .every((n) => wn.includes(n)) && !wn.includes("frequencies") && !wn.includes("spectrums") && !wn.includes("TraceIndex")
    && !wn.includes("d_norm"), J(wn));
}
if (loaded["sidebands.nc"]) {
  const ds = loaded["sidebands.nc"];
  const pk = ds.vars.s_pk.data, ref = ds.vars.pump_dbm.data;
  let md = 0;
  for (let i = 0; i < pk.length; i++) md = Math.max(md, Math.abs(pk[i] - ref[i]));
  check("d: sidebands max in pump_nm ± 0.02 == pump_dbm exactly", md === 0 && pk.length === 187, md);
  check("d: sidebands suggestXsrc -> var:wl_nm", D.suggestXsrc(ds, "spectra_dbm", "wl") === "var:wl_nm");
  const lo = ds.vars.sb_low_nm.data, sbl = ds.vars.s_sbl.data;
  check("d: sidebands NaN center -> NaN inside", Array.from(lo).every((c, i) => !Number.isNaN(c) || Number.isNaN(sbl[i])));
  // an undefined (NaN-centered) window has no members in ANY region
  const sblo = ds.vars.s_sbl_out.data;
  check("d: sidebands NaN center -> NaN outside too", Array.from(lo).some((c) => Number.isNaN(c))
    && Array.from(lo).every((c, i) => !Number.isNaN(c) || Number.isNaN(sblo[i])));
  const cnt = ds.vars.s_sbl_cnt.data;
  check("d: sidebands NaN center -> count 0, else > 0", Array.from(lo).every((c, i) => (Number.isNaN(c) ? cnt[i] === 0 : cnt[i] > 0)));
  check("d: sidebands range from expressions == center ± (bitwise)", same(ds.vars.s_sbl_rng.data, sbl));
  check("d: sidebands formula units", ds.vars.s_snr_f.attrs.units === "dB" && ds.vars.s_rel.attrs.units === "dB"
    && ds.vars.s_lin.attrs.units === "mW" && ds.vars.s_wlf.attrs.units === "nm·Hz" && ds.vars.s_pw.attrs.units === "nm^2"
    && ds.vars.s_inv.attrs.units === "1/Hz" && ds.vars.s_pow.attrs.units === "nm^-1" && ds.vars.s_sum.attrs.units === "dBm"
    && ds.vars.s_dbsum.attrs.units === "dBm" && ds.vars.s_dev.attrs.units === "nm" && ds.vars.s_back.attrs.units === "dBm"
    && ds.vars.s_q.attrs.units === "nm",
  realDefs["sidebands.nc"].filter((d) => d.kind === "formula").map((d) => `${d.name}=${ds.vars[d.name].attrs.units}`).join(" "));
  check("d: sidebands formula broadcast", J(ds.vars.s_rel.dims) === '["freq","wl"]'
    && ds.vars.s_rel.data[501 * 3 + 7] === ds.vars.spectra_dbm.data[501 * 3 + 7] - ref[3]);
  const sbd = ds.vars.sb_low_dbm.data;
  let mm = 0, n = 0;
  for (let i = 0; i < sbl.length; i++) if (!Number.isNaN(sbd[i])) { n++; if (Math.abs(sbl[i] - sbd[i]) > 1e-9) mm++; }
  console.log(`INFO sidebands: max in sb_low_nm ± 0.01 == stored sb_low_dbm for ${n - mm}/${n} resolved points`);
}
if (loaded["powercal_hdf5.nc"]) {
  const ds = loaded["powercal_hdf5.nc"];
  const pk = ds.vars.p_pk.data, all = ds.vars.p_pk_all.data, ref = ds.vars.sa_peak.data;
  let md = 0, mr = 0, eqAll = true;
  for (let i = 0; i < pk.length; i++) {
    md = Math.max(md, Math.abs(pk[i] - ref[i]));
    mr = Math.max(mr, Math.abs(Math.round(pk[i] * 100) / 100 - ref[i]));
    if (pk[i] !== all[i]) eqAll = false;
  }
  check("d: powercal max in frequency ± 20M == whole-trace max", eqAll);
  check("d: powercal sa_peak == round(max in window, 2 decimals)", mr < 1e-9 && md < 0.0034, { md, mr });
  const msw = ds.vars.p_mean_sweep.data, mref = ds.vars.sa_peak_mean.data;
  check("d: powercal sa_peak_mean == dB-domain mean over sweep (db: no)", allNear(msw, mref, 1e-12));
  check("d: powercal formula p_pk - vna_power", J(ds.vars.p_gain.dims) === '["vna_power","frequency","sweep"]'
    && ds.vars.p_gain.attrs.units === "dB" && ds.vars.p_gain.data[66 + 5] === pk[66 + 5] - ds.vars.vna_power.data[1]);
  let dd = 0;
  for (let i = 0; i < msw.length; i++) dd = Math.max(dd, Math.abs(ds.vars.p_mean_sweep_db.data[i] - mref[i]));
  console.log(`INFO powercal: sa_peak = round(max(sa_trace in frequency ± 20 MHz), 2): max |diff| before rounding ${md.toFixed(5)} dB; `
    + `sa_peak_mean is a dB-domain mean (linear-power mean differs by up to ${dd.toFixed(5)} dB); `
    + `sa_peak_std is the ddof=1 sample std (this engine's std is population, ddof=0)`);
}
if (loaded["fourd.nc"]) {
  const ds = loaded["fourd.nc"];
  check("d: fourd peak shape", J(ds.vars.f_pk.dims) === '["d1","d2","d3"]' && ds.vars.f_pk.data.length === 24);
  check("d: fourd argmax_x within the frequency range", Array.from(ds.vars.f_fpk.data).every((x) => x >= 1e9 && x <= 6.6e9)
    && ds.vars.f_fpk.attrs.units === "Hz");
  check("d: fourd suggestXsrc -> var:frequency", D.suggestXsrc(ds, "spectra", "traceindex") === "var:frequency");
  check("d: fourd formula dims union", J(ds.vars.f_form.dims) === '["d1","d2","d3","traceindex"]' && ds.vars.f_form.attrs.units === "dB");
}

// =============================================================================
// (d2) legacy defs: the bc9812f engine (from git) vs the migrated defs here
// =============================================================================
// projects saved by bc9812f store windows as {mode fixed|relative, numbers,
// center "coord:<dim>"|"var:<name>", k, offset}; sanitizeDef migrates them to
// expressions, which must compute exactly the same numbers
const relL = (center, hw, extra) => ({ mode: "relative", center, halfwidth: hw, ...(extra || {}) });
const legacyDefs = {
  "darpa.nc": [
    ...(() => {
      const r = (n, o) => ({ kind: "reduce", name: n, file: "darpa.nc", src: "spectrums", over: "TraceIndex", xsrc: "var:frequencies", ...o });
      const W = relL("coord:stimulusFrequency", 1e6);
      return [
        r("d_peak", { window: W, stat: "max" }), r("d_floor", { window: W, stat: "mean", region: "outside" }),
        r("d_fpk", { window: W, stat: "argmax_x" }),
        r("d_fmin", { window: relL("coord:stimulusFrequency", 1e6, { halfwidth2: 5e6 }), stat: "argmin_x", region: "outside_within" }),
        r("d_med", { window: relL("coord:stimulusFrequency", 1e6, { halfwidth2: 1e7 }), stat: "median", region: "outside_within" }),
        r("d_std_db", { window: W, stat: "std", region: "outside", db: "yes" }),
        r("d_int", { window: relL("coord:stimulusFrequency", 2e6), stat: "integral" }),
        r("d_cnt", { window: relL("coord:stimulusFrequency", 3e6), stat: "count" }),
        r("d_h2", { window: relL("coord:stimulusFrequency", 1e6, { k: 2, offset: -4e7 }), stat: "max" }),
        r("d_h3", { window: relL("coord:stimulusFrequency", 1.5e6, { k: 3, offset: 1234.5678 }), stat: "max" }),
        r("d_hx", { window: relL("var:stimulusFrequency", 2.5e6, { k: 0.1, offset: 1e-3, halfwidth2: 3.3e6 }),
          stat: "integral", region: "outside_within" }),
        r("d_pk2", { window: relL("var:d_fpk", 1e5), stat: "max" }),
        { kind: "reduce", name: "d_linsum", file: "darpa.nc", src: "spectrums", over: "TraceIndex", xsrc: "var:frequencies",
          stat: "sum", window: { mode: "fixed", lo: 2.9e7, hi: 3.1e7 } },
        { kind: "reduce", name: "d_fx_ow", file: "darpa.nc", src: "spectrums", over: "TraceIndex", xsrc: "var:frequencies",
          stat: "mean", region: "outside_within", window: { mode: "fixed", lo: 3.1e7, hi: 2.9e7, lo2: 1e8 / 3, hi2: 2e7 } },
        { kind: "reduce", name: "d_tr_min", file: "darpa.nc", src: "spectrums", over: "trace", xsrc: "index", stat: "min",
          window: { mode: "fixed", lo: 0, hi: 1 } },
        { kind: "reduce", name: "d_lw", file: "darpa.nc", src: "spectrums", over: "TraceIndex", xsrc: "index", stat: "mean",
          db: "no", window: relL("var:laswrPowers", 50, { k: -10 }) },
        { kind: "reduce", name: "d_cidx", file: "darpa.nc", src: "spectrums", over: "TraceIndex", xsrc: "coord", stat: "max",
          window: relL("coord:trace", 50, { k: 100, offset: 200 }) },
        { kind: "combine", name: "d_SNR", file: "darpa.nc", a: "d_peak", op: "-", b: "d_floor" },
      ];
    })(),
  ],
  "sidebands.nc": [
    ...(() => {
      const r = (n, o) => ({ kind: "reduce", name: n, file: "sidebands.nc", src: "spectra_dbm", over: "wl", xsrc: "var:wl_nm", ...o });
      return [
        r("s_pk", { window: relL("var:pump_nm", 0.02), stat: "max" }),
        r("s_sbl", { window: relL("var:sb_low_nm", 0.01), stat: "max" }),
        r("s_sbl_out", { window: relL("var:sb_low_nm", 0.01), stat: "mean", region: "outside" }),
        r("s_floor", { window: relL("var:pump_nm", 0.05, { halfwidth2: 0.5 }), stat: "mean", region: "outside_within" }),
        r("s_off", { window: relL("var:pump_nm", 0.03, { k: 1, offset: -0.1 }), stat: "argmax_x" }),
        r("s_int", { window: { mode: "fixed", lo: 1550, hi: 1551 }, stat: "integral" }),
        r("s_cnt", { window: { mode: "fixed", lo: 1550.4, hi: 1550.6, lo2: 1550, hi2: 1551 }, stat: "count", region: "outside_within" }),
        { kind: "reduce", name: "s_idxc", file: "sidebands.nc", src: "spectra_dbm", over: "freq", xsrc: "index", stat: "max",
          window: relL("coord:wl", 10, { k: 0.3 }) },
      ];
    })(),
  ],
  "fourd.nc": [
    { kind: "reduce", name: "f_win", file: "fourd.nc", src: "spectra", over: "traceindex", xsrc: "var:frequency", stat: "mean",
      window: relL("coord:d1", 5e8, { k: 1e9, offset: 2e9 }) },
    { kind: "reduce", name: "f_win3", file: "fourd.nc", src: "spectra", over: "traceindex", xsrc: "var:frequency", stat: "count",
      window: relL("coord:d3", 3e8, { k: -7e8, offset: 4.4e9 }) },
  ],
  "powercal_hdf5.nc": [
    { kind: "reduce", name: "p_pk", file: "powercal_hdf5.nc", src: "sa_trace", over: "sa_point", xsrc: "var:sa_freq", stat: "max",
      window: relL("coord:frequency", 2e7) },
    { kind: "reduce", name: "p_floor", file: "powercal_hdf5.nc", src: "sa_trace", over: "sa_point", xsrc: "var:sa_freq",
      stat: "mean", region: "outside", window: relL("coord:frequency", 2e7) },
  ],
};
// the "derived" array of a project saved by bc9812f (demo.ncproj), verbatim
const DEMO_DERIVED = JSON.parse(`[
  {"name":"peak","file":"darpa.nc","kind":"reduce","units":"","description":"tone power at the stimulus frequency","src":"spectrums","over":"TraceIndex","xsrc":"var:frequencies","window":{"mode":"relative","lo":null,"hi":null,"lo2":null,"hi2":null,"center":"coord:stimulusFrequency","k":1,"offset":0,"halfwidth":1000000,"halfwidth2":10000000},"region":"inside","stat":"max","db":"auto"},
  {"name":"floor","file":"darpa.nc","kind":"reduce","units":"","description":"","src":"spectrums","over":"TraceIndex","xsrc":"var:frequencies","window":{"mode":"relative","lo":null,"hi":null,"lo2":null,"hi2":null,"center":"coord:stimulusFrequency","k":1,"offset":0,"halfwidth":1000000,"halfwidth2":10000000},"region":"outside_within","stat":"mean","db":"auto"},
  {"name":"snr","file":"darpa.nc","kind":"combine","units":"","description":"","a":"peak","op":"-","b":"floor"},
  {"name":"peak_freq","file":"darpa.nc","kind":"reduce","units":"","description":"","src":"spectrums","over":"TraceIndex","xsrc":"var:frequencies","window":{"mode":"relative","lo":null,"hi":null,"lo2":null,"hi2":null,"center":"coord:stimulusFrequency","k":1,"offset":0,"halfwidth":1000000,"halfwidth2":10000000},"region":"inside","stat":"argmax_x","db":"auto"},
  {"name":"pump_peak","file":"sidebands.nc","kind":"reduce","units":"","description":"","src":"spectra_dbm","over":"wl","xsrc":"var:wl_nm","window":{"mode":"relative","lo":null,"hi":null,"lo2":null,"hi2":null,"center":"var:pump_nm","k":1,"offset":0,"halfwidth":0.02,"halfwidth2":0.5},"region":"inside","stat":"max","db":"auto"},
  {"name":"osa_floor","file":"sidebands.nc","kind":"reduce","units":"","description":"","src":"spectra_dbm","over":"wl","xsrc":"var:wl_nm","window":{"mode":"relative","lo":null,"hi":null,"lo2":null,"hi2":null,"center":"var:pump_nm","k":1,"offset":0,"halfwidth":0.02,"halfwidth2":0.5},"region":"outside_within","stat":"median","db":"auto"},
  {"name":"pump_mW","file":"sidebands.nc","kind":"transform","units":"","description":"","src":"pump_peak","fn":"db2lin","scale":1,"offset":0},
  {"name":"sa_pk","file":"powercal_hdf5.nc","kind":"reduce","units":"","description":"","src":"sa_trace","over":"sa_point","xsrc":"var:sa_freq","window":{"mode":"relative","lo":null,"hi":null,"lo2":null,"hi2":null,"center":"coord:frequency","k":1,"offset":0,"halfwidth":20000000,"halfwidth2":null},"region":"inside","stat":"max","db":"auto"},
  {"name":"sa_pk_mean","file":"powercal_hdf5.nc","kind":"reduce","units":"","description":"","src":"sa_pk","over":"sweep","xsrc":"index","stat":"mean","db":"auto","region":"inside","window":{"mode":"none","lo":null,"hi":null,"lo2":null,"hi2":null,"center":"","k":1,"offset":0,"halfwidth":null,"halfwidth2":null}}
]`);
{
  // migrated strings (E3)
  const mig = (d) => D.sanitizeDef(d).window;
  check("d2: demo.ncproj windows migrate", J(DEMO_DERIVED.filter((d) => d.kind === "reduce").map((d) => mig(d)))
    === J([W_({ mode: "center", center: "stimulusFrequency", halfwidth: "1000000", halfwidth2: "10000000" }),
      W_({ mode: "center", center: "stimulusFrequency", halfwidth: "1000000", halfwidth2: "10000000" }),
      W_({ mode: "center", center: "stimulusFrequency", halfwidth: "1000000", halfwidth2: "10000000" }),
      W_({ mode: "center", center: "pump_nm", halfwidth: "0.02", halfwidth2: "0.5" }),
      W_({ mode: "center", center: "pump_nm", halfwidth: "0.02", halfwidth2: "0.5" }),
      W_({ mode: "center", center: "frequency", halfwidth: "20000000" }),
      W_({})]), J(DEMO_DERIVED.map((d) => d.window && mig(d))));
  const byName = Object.fromEntries(Object.values(legacyDefs).flat().map((d) => [d.name, d]));
  const cen = (n) => mig(byName[n]).center;
  check("d2: legacy centers -> expressions", cen("d_h2") === "2*stimulusFrequency - 40000000"
    && cen("d_h3") === "3*stimulusFrequency + 1234.5678" && cen("d_hx") === "0.1*stimulusFrequency + 0.001"
    && cen("d_lw") === "-10*laswrPowers" && cen("d_cidx") === "100*trace + 200" && cen("s_idxc") === "0.3*wl"
    && cen("s_off") === "pump_nm - 0.1" && cen("f_win") === "1000000000*d1 + 2000000000" && cen("f_win3") === "-700000000*d3 + 4400000000",
  Object.keys(byName).map((n) => byName[n].window && `${n}: ${cen(n)}`).join(" | "));
  check("d2: legacy fixed -> range", J(mig(byName.d_fx_ow)) === J(W_({ mode: "range", lo: "31000000", hi: "29000000",
    lo2: "33333333.333333332", hi2: "20000000" })));
  check("d2: a migrated def is canonical (sanitize == canonical, no k/offset)", Object.values(legacyDefs).flat().concat(DEMO_DERIVED)
    .every((d) => J(D.sanitizeDef(d)) === J(D.canonicalDef(D.sanitizeDef(d))) && J(D.canonicalDef(d)) === J(D.sanitizeDef(d))));
}
{
  // the bc9812f engine, from git, next to its own dataset.js / explore.js / readers
  let H = null, why = "";
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ncx-head-"));
  try {
    for (const f of ["derive.js", "dataset.js", "explore.js", "netcdf3.js", "hdf5.js"]) {
      const r = spawnSync("git", ["show", `bc9812f:docs/js/${f}`], { cwd: REPO, encoding: "utf8", maxBuffer: 64 << 20 });
      if (r.error || r.status !== 0) throw new Error(`git show ${f}: ${r.error ? r.error.code : (r.stderr || "").trim()}`);
      fs.writeFileSync(path.join(tmp, f), r.stdout);
    }
    H = await import(pathToFileURL(path.join(tmp, "derive.js")).href);
  } catch (e) { why = e.message; }
  if (!H) skip("d2: legacy vs bc9812f engine", why);
  else {
    // (1) synthetic: many k / offset / half widths / regions / stats, bitwise
    const ds = mk1();
    const ks = [1, 2, -0.5, 1 / 3, 0.1, 1e-7, -1], offs = [0, -30, 2.5, 1 / 7, -1e-9, 1e3], hws = [0, 5, 7.5, 1 / 3, -10, 22.2];
    const centers = ["coord:t", "var:cen", "var:g", "coord:q", "var:scal", "var:nanv"];
    const regions = ["inside", "outside", "outside_within"], stats = ["max", "mean", "count", "argmin_x", "integral", "median", "std"];
    let n = 0, bad = 0, firstBad = null, i = 0;
    for (const center of centers) for (const k of ks) for (const offset of offs) {
      i++;
      const hw = hws[i % hws.length], hw2 = 3 * hws[(i + 2) % hws.length] + 1;
      const region = regions[i % 3], stat = stats[i % stats.length];
      const legacy = { kind: "reduce", name: "x", file: "syn.nc", src: "s3", over: "f", xsrc: i % 2 ? "var:fx" : "coord",
        window: { mode: "relative", lo: null, hi: null, lo2: null, hi2: null, center, k, offset, halfwidth: hw, halfwidth2: hw2 },
        region, stat, db: i % 4 ? "auto" : "no" };
      const old = H.computeDef(ds, H.sanitizeDef(legacy));
      const stored = JSON.parse(J(H.canonicalDef(H.sanitizeDef(legacy))));
      const now = D.computeDef(ds, D.sanitizeDef(stored));
      n++;
      if (!same(old.data, now.data) || J(old.dims) !== J(now.dims) || old.attrs.units !== now.attrs.units) {
        bad++;
        if (!firstBad) firstBad = { legacy: legacy.window, migrated: D.sanitizeDef(stored).window, old: show(old.data), now: show(now.data) };
      }
    }
    for (const [lo, hi, lo2, hi2] of [[20, 40, 10, 50], [40, 20, 55, 0], [1 / 3, 33.3, -1e-9, 1e21], [25, 25, 25, 45]]) {
      for (const region of regions) {
        const legacy = { kind: "reduce", name: "x", file: "syn.nc", src: "spec", over: "f", xsrc: "coord", stat: "mean",
          region, window: { mode: "fixed", lo, hi, lo2, hi2 } };
        const old = H.computeDef(ds, H.sanitizeDef(legacy)), now = D.computeDef(ds, D.sanitizeDef(legacy));
        n++;
        if (!same(old.data, now.data)) { bad++; if (!firstBad) firstBad = { legacy: legacy.window, old: show(old.data), now: show(now.data) }; }
      }
    }
    check(`d2: ${n} synthetic legacy defs: bc9812f numbers == migrated numbers (bitwise)`, bad === 0 && n > 250, firstBad);
    // previews too
    const lp = { kind: "reduce", name: "x", file: "syn.nc", src: "s3", over: "f", xsrc: "var:fx", stat: "mean", region: "outside_within",
      window: { mode: "relative", center: "var:cen", k: 1 / 3, offset: 17.25, halfwidth: 3.3, halfwidth2: 21 } };
    const po = H.previewSlice(ds, H.sanitizeDef(lp), { t: 2, q: 1 }), pn = D.previewSlice(ds, D.sanitizeDef(lp), { t: 2, q: 1 });
    check("d2: preview of a legacy def == bc9812f preview", J(po.inner) === J(pn.inner) && J(po.outer) === J(pn.outer)
      && po.center === pn.center && same([po.value], [pn.value]) && po.count === pn.count && same(po.member, pn.member));

    // (2) real files, incl. chains and the demo project's defs, as stored (canonical JSON)
    for (const F of Object.keys(legacyDefs)) {
      if (!haveData(F)) { skip(`d2: ${F}`, "tests/data file missing"); continue; }
      const raws = legacyDefs[F].concat(DEMO_DERIVED.filter((d) => d.file === F));
      const stored = JSON.parse(J(raws.map((d) => H.canonicalDef(H.sanitizeDef(d)))));
      const dsOld = await loadDataset(dataFile(F)), dsNew = await loadDataset(dataFile(F));
      const so = H.registerDerived(dsOld, stored);
      const sn = D.registerDerived(dsNew, stored.map((d) => D.sanitizeDef(d)));
      const diffs = [];
      for (const d of stored) {
        const a = dsOld.vars[d.name], b = dsNew.vars[d.name];
        if (!so.get(d.name).ok || !sn.get(d.name).ok || !a || !b) { diffs.push(`${d.name}: not registered`); continue; }
        if (J(a.dims) !== J(b.dims) || J(a.shape) !== J(b.shape)) diffs.push(`${d.name}: dims`);
        else if (a.attrs.units !== b.attrs.units) diffs.push(`${d.name}: units`);
        else if (!same(a.data, b.data)) diffs.push(`${d.name}: values`);
      }
      check(`d2: ${F}: ${stored.length} legacy defs: bc9812f numbers == migrated numbers (bitwise)`, diffs.length === 0, diffs.join("; "));
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

// =============================================================================
// (e) performance: ~2 million elements
// =============================================================================
{
  const nt = 2000, nf = 1000, N = nt * nf;
  const spec = new Float64Array(N), fx = new Float64Array(N), cen = new Float64Array(nt), rbw = new Float64Array(nt);
  for (let i = 0; i < nt; i++) {
    cen[i] = 100 + (i % 700);
    rbw[i] = 5 + (i % 4);
    for (let j = 0; j < nf; j++) {
      fx[i * nf + j] = j + 0.5 * (i % 3);
      spec[i * nf + j] = -60 + 10 * Math.sin(i * 0.37 + j * 0.11) + (j === cen[i] ? 40 : 0);
    }
  }
  const ds = new Dataset({ dims: { t: nt, f: nf }, attrs: {}, coords: new Set(), variables: {
    spec: { dims: ["t", "f"], shape: [nt, nf], attrs: { units: "dBm" }, dtype: "double", numeric: true, data: spec },
    fx: { dims: ["t", "f"], shape: [nt, nf], attrs: { units: "Hz" }, dtype: "double", numeric: true, data: fx },
    cen: { dims: ["t"], shape: [nt], attrs: { units: "Hz" }, dtype: "double", numeric: true, data: cen },
    rbw: { dims: ["t"], shape: [nt], attrs: { units: "Hz" }, dtype: "double", numeric: true, data: rbw },
  } }, "perf.nc");
  const time = (fn) => { const t0 = performance.now(); const r = fn(); return [performance.now() - t0, r]; };
  const base = { src: "spec", over: "f", xsrc: "var:fx", window: CT("cen", "20", "200") };
  const tests = [
    ["reduce mean (dB, outside_within)", sd("perf.nc", "reduce", "a", { ...base, stat: "mean", region: "outside_within" })],
    ["reduce median (dB, outside)", sd("perf.nc", "reduce", "b", { ...base, stat: "median", region: "outside" })],
    ["reduce integral (dB)", sd("perf.nc", "reduce", "c", { ...base, stat: "integral", region: "outside" })],
    ["reduce max", sd("perf.nc", "reduce", "d", { ...base, stat: "max" })],
    ["reduce max, window from expressions", sd("perf.nc", "reduce", "d2", { ...base, stat: "max", region: "outside_within",
      window: CT("cen + 0*t", "4*rbw", "0.2*cen + 3*rbw") })],
    ["combine broadcast 2M", sd("perf.nc", "combine", "e", { a: "spec", op: "-", b: "cen" })],
    ["transform db2lin 2M", sd("perf.nc", "transform", "f", { src: "spec", fn: "db2lin" })],
    ["formula broadcast 2M (spec - cen)", sd("perf.nc", "formula", "g", { expr: "spec - cen" })],
    ["formula 2M with functions", sd("perf.nc", "formula", "h", { expr: "lin2db(db2lin(spec) * 2 + abs(fx - cen)) - 10*log10(rbw)" })],
  ];
  for (const [what, def] of tests) {
    D.computeDef(ds, def);                       // warm up
    const [ms, r] = time(() => D.computeDef(ds, def));
    console.log(`PERF ${what}: ${ms.toFixed(1)} ms (${N} elements in, ${r.data.length} out)`);
    check(`e: perf ${what} < 1000 ms`, ms < 1000, ms);
  }
  const [ms] = time(() => D.registerDerived(ds, tests.map((t) => t[1])));
  console.log(`PERF registerDerived (${tests.length} defs): ${ms.toFixed(1)} ms`);
  const r = D.computeDef(ds, tests[3][1]);
  check("e: perf max finds the planted peak", Array.from(r.data).every((v) => v >= -30 - 1e-9));
  check("e: perf formula == combine", same(D.computeDef(ds, tests[7][1]).data, D.computeDef(ds, tests[5][1]).data));
}

// =============================================================================
// (f) cross-check against the independent numpy/xarray implementation
// =============================================================================
{
  const files = Object.keys(realDefs).filter((F) => loaded[F]);
  const script = path.join(REPO, "tests", "xcheck_derive.py");
  const probe = files.length ? spawnSync(PYTHON, ["-c", "import numpy, xarray"], { encoding: "utf8" }) : null;
  if (!files.length) skip("f: cross-check", "no data files");
  else if (probe.error || probe.status !== 0) {
    skip("f: cross-check", `python '${PYTHON}' with numpy+xarray unavailable (set NCX_PYTHON)`
      + (probe.error ? ` [${probe.error.code}]` : ` [${(probe.stderr || "").trim().split("\n").pop()}]`));
  } else {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ncx-derive-"));
    const casesPath = path.join(tmp, "cases.json"), outPath = path.join(tmp, "out.json");
    fs.writeFileSync(casesPath, J(files.map((F) => ({ file: dataFile(F), defs: realDefs[F] }))));
    const run = spawnSync(PYTHON, [script, casesPath, outPath], { encoding: "utf8", maxBuffer: 64 << 20 });
    if (!check("f: xcheck_derive.py ran", run.status === 0, (run.stderr || "").slice(-2000))) {
      // reported
    } else {
      const out = JSON.parse(fs.readFileSync(outPath, "utf8"));
      let nDefs = 0, nElems = 0, nNaN = 0, worst = 0, nFormula = 0, nExprWin = 0;
      files.forEach((F, fi) => {
        const ds = loaded[F], res = out[fi].results;
        for (const def of realDefs[F]) {
          const pr = res[def.name], v = ds.vars[def.name];
          const tag = `f: xcheck ${F}:${def.name}`;
          if (!check(`${tag} python ok`, pr && !pr.error, pr && pr.error)) continue;
          if (!check(`${tag} registered`, !!v)) continue;
          nDefs++;
          if (def.kind === "formula") nFormula++;
          if (def.kind === "reduce" && Object.values(def.window).some((t) => t !== def.window.mode && /[A-Za-z_"]/.test(t.replace(/[0-9.]+[eE][+-]?[0-9]+|[0-9][pnumkKMGT]/g, "")))) nExprWin++;
          check(`${tag} dims/shape`, J(v.dims) === J(pr.dims) && J(v.shape) === J(pr.shape),
            { js: [v.dims, v.shape], py: [pr.dims, pr.shape] });
          check(`${tag} units`, v.attrs.units === pr.units, { js: v.attrs.units, py: pr.units });
          let bad = 0, first = null;
          const exact = def.kind === "reduce" && def.stat === "count";
          for (let i = 0; i < pr.data.length; i++) {
            const a = v.data[i], b = pr.data[i] === null ? NaN : pr.data[i];
            nElems++;
            if (Number.isNaN(b)) nNaN++;
            let ok;
            if (Number.isNaN(a) || Number.isNaN(b)) ok = Number.isNaN(a) && Number.isNaN(b);
            else if (exact) ok = a === b;
            else {
              const d = Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-300);
              ok = a === b || d <= 1e-9;
              if (a !== b) worst = Math.max(worst, d);
            }
            if (!ok) { bad++; if (!first) first = { i, js: a, py: b }; }
          }
          check(`${tag} values (${pr.data.length})`, bad === 0 && pr.data.length === v.data.length, { bad, first });
        }
      });
      console.log(`XCHECK ${nDefs} defs (${nFormula} formulas, ${nExprWin} windows with names) over ${files.length} files, `
        + `${nElems} elements (${nNaN} NaN) compared; worst relative difference ${worst.toExponential(2)}`);
      check("f: cross-check covered >= 25 defs", nDefs >= 25, nDefs);
      check("f: cross-check covers formulas and expression windows", nFormula >= 10 && nExprWin >= 10, { nFormula, nExprWin });
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

summary("derive");
