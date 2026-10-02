// derive.test.mjs — tests for docs/js/derive.js (derived quantities).
//   node tests/derive.test.mjs            (exit code 1 on any failure)
// (a) reduceSamples semantics, (b) computeDef/registerDerived on synthetic
// Datasets, (c) sanitizeDef/canonicalDef, (d) the real lab files in tests/data
// (skipped when missing), (e) performance, (f) a cross-check of ~50 defs over
// the real files against tests/xcheck_derive.py, an independent numpy/xarray
// implementation (python from $NCX_PYTHON, skipped when unavailable).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { check, skip, summary, loadDataset, haveData, dataFile, PYTHON, moduleUrl, REPO } from "./node_env.mjs";

const D = await import(moduleUrl("derive.js"));
const { Dataset, Variable } = await import(moduleUrl("dataset.js"));

const isNaNum = (v) => typeof v === "number" && Number.isNaN(v);
const near = (a, b, rel = 1e-12) => (isNaNum(a) && isNaNum(b)) || a === b
  || (Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= rel * Math.max(Math.abs(a), Math.abs(b)));
const allNear = (a, b, rel) => a.length === b.length && Array.from(a).every((v, i) => near(v, b[i], rel));
const lin = (d) => Math.pow(10, d / 10);
const todb = (l) => 10 * Math.log10(l);
const show = (a) => JSON.stringify(Array.from(a, (v) => (Number.isNaN(v) ? "NaN" : v)));

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
const RD = (name, o, w) => ({ ...D.newDef("reduce", "syn.nc"), name, ...o,
  window: { ...D.newDef("reduce").window, ...(w || {}) } });
const CB = (name, a, op, b, o) => ({ ...D.newDef("combine", "syn.nc"), name, a, op, b, ...(o || {}) });
const TF = (name, src, fn, o) => ({ ...D.newDef("transform", "syn.nc"), name, src, fn, ...(o || {}) });
const comp = (ds, def) => D.computeDef(ds, def);
const err = (ds, def) => D.validateDef(ds, def);

{
  const ds = mk1();
  const base = { src: "spec", over: "f", xsrc: "coord", stat: "max" };
  let r = comp(ds, RD("a", base, { mode: "fixed", lo: 40, hi: 20 }));
  check("b: fixed window (lo>hi swapped), dims/shape", JSON.stringify(r.dims) === '["t"]' && JSON.stringify(r.shape) === "[3]");
  check("b: fixed window values", allNear(r.data, [-20, -25, -47]), show(r.data));
  check("b: units auto = src units", r.attrs.units === "dBm");
  check("b: long_name = description", r.attrs.long_name === "Peak (max) of spec over f, inside [20, 40]", r.attrs.long_name);
  r = comp(ds, RD("a", { ...base, stat: "argmax_x" }, { mode: "fixed", lo: 20, hi: 40 }));
  check("b: argmax_x values + units", allNear(r.data, [20, 30, 40]) && r.attrs.units === "Hz", show(r.data));
  r = comp(ds, RD("a", base, { mode: "relative", center: "coord:t", halfwidth: 10 }));
  check("b: relative, coord center", allNear(r.data, [-20, -25, -22]), show(r.data));
  r = comp(ds, RD("a", base, { mode: "relative", center: "var:cen", halfwidth: -10 }));
  check("b: relative, var center, negative halfwidth -> |hw|", allNear(r.data, [-20, -25, -22]), show(r.data));
  r = comp(ds, RD("a", base, { mode: "relative", center: "coord:t", k: 2, offset: -30, halfwidth: 5 }));
  check("b: k and offset (harmonic)", allNear(r.data, [-50, -25, NaN]), show(r.data));
  r = comp(ds, RD("a", { ...base, stat: "count" }, { mode: "relative", center: "coord:t", k: 2, offset: -30, halfwidth: 5 }));
  check("b: count never NaN", allNear(r.data, [1, 1, 0]) && r.attrs.units === "", show(r.data));
  r = comp(ds, RD("a", { ...base, stat: "mean", region: "outside_within", db: "no" },
    { mode: "relative", center: "coord:t", halfwidth: 10, halfwidth2: 20 }));
  check("b: outside_within relative", allNear(r.data, [-30, -53, -49]), show(r.data));
  r = comp(ds, RD("a", { ...base, stat: "mean", region: "outside" }, { mode: "fixed", lo: 20, hi: 40 }));
  check("b: outside, auto dB mean", near(r.data[0], todb((lin(-50) + lin(-60) + lin(-45)) / 3)), show(r.data));
  r = comp(ds, RD("a", { ...base, xsrc: "var:fx" }, { mode: "relative", center: "coord:t", halfwidth: 5 }));
  check("b: 2-D x variable", allNear(r.data, [-20, -25, -47]), show(r.data));
  r = comp(ds, RD("a", { ...base, src: "s3", xsrc: "var:fx" }, { mode: "relative", center: "coord:t", halfwidth: 5 }));
  check("b: x var with fewer dims than src", JSON.stringify(r.dims) === '["t","q"]'
    && allNear(r.data, [-20, -19, -25, -24, -47, -46]), show(r.data));
  r = comp(ds, RD("a", { src: "line", over: "f", xsrc: "coord", stat: "sum" }));
  check("b: 1-D src -> 0-D result", r.dims.length === 0 && r.shape.length === 0 && r.data.length === 1 && r.data[0] === 21);
  r = comp(ds, RD("a", { src: "spec", over: "t", xsrc: "coord", stat: "max" }, { mode: "fixed", lo: 20, hi: 30 }));
  check("b: reduce over the first dim", JSON.stringify(r.dims) === '["f"]' && allNear(r.data, [-50, -20, -25, -30, -51, -45]), show(r.data));
  r = comp(ds, RD("a", { src: "spec", over: "t", xsrc: "coord", stat: "max" }, { mode: "relative", center: "coord:f", halfwidth: 5 }));
  check("b: reduce over t, center from coord of remaining dim", allNear(r.data, [NaN, -20, -25, NaN, -22, NaN]), show(r.data));
  // q's coordinate is [1, 0]: center = 2·q-coord -> x index 2 (q=0) and 0 (q=1)
  const qdef = RD("a", { src: "s3", over: "f", xsrc: "index", stat: "max" }, { mode: "relative", center: "coord:q", k: 2, halfwidth: 0 });
  r = comp(ds, qdef);
  check("b: index x with coord:q center", allNear(r.data, [-40, -49, -25, -54, -49, -39]), show(r.data));
  {
    const ds0 = mk1();
    delete ds0.vars.q;                          // no coordinate -> the index is the center
    r = comp(ds0, qdef);
    check("b: coord:<dim> center without a coordinate uses the index", allNear(r.data, [-50, -39, -55, -24, -40, -48]), show(r.data));
    r = comp(ds0, RD("a", { src: "s3", over: "q", xsrc: "coord", stat: "argmax_x" }));
    check("b: xsrc coord without a coordinate falls back to index", r.data[0] === 1 && D.autoUnits(ds0, RD("a", { src: "s3", over: "q", xsrc: "coord", stat: "argmax_x" })) === "");
  }
  r = comp(ds, RD("a", { src: "ze", over: "f", stat: "max" }));
  check("b: size-0 result dim -> empty data", JSON.stringify(r.shape) === "[0]" && r.data.length === 0);
  r = comp(ds, RD("a", { src: "ze", over: "e", stat: "max" }));
  check("b: size-0 reduced dim -> all NaN", r.data.length === 6 && Array.from(r.data).every(isNaNum));
  r = comp(ds, RD("a", { src: "ze", over: "e", stat: "count" }));
  check("b: size-0 reduced dim count -> 0", Array.from(r.data).every((v) => v === 0));
  r = comp(ds, RD("a", { src: "spec", over: "f", xsrc: "coord", stat: "integral", db: "no" }, { mode: "fixed", lo: 10, hi: 30 }));
  check("b: integral units su·xu", r.attrs.units === "dBm·Hz" && near(r.data[0], 0.5 * (-50 - 20) * 10 + 0.5 * (-20 - 40) * 10));
  r = comp(ds, RD("a", { src: "spec", over: "f", xsrc: "index", stat: "integral" }));
  check("b: integral units with index x = su", r.attrs.units === "dBm");
  r = comp(ds, RD("a", { src: "spec", over: "f", xsrc: "coord", stat: "max", units: " my units " }));
  check("b: explicit units trimmed", r.attrs.units === "my units");
  r = comp(ds, RD("a", { src: "nanv", over: "t", xsrc: "coord", stat: "mean", db: "no" }));
  check("b: NaN element skipped", r.data[0] === 2);
  r = comp(ds, RD("a", { src: "spec", over: "f", xsrc: "coord", stat: "max", description: "  my peak " }));
  check("b: long_name from description", r.attrs.long_name === "my peak");

  // combine (broadcast by dim NAME, both directions) + constants
  r = comp(ds, CB("c", "spec", "-", "g"));
  check("b: combine a(t,f) - b(t)", JSON.stringify(r.dims) === '["t","f"]' && r.data[0] === -52 && r.data[6] === -59 && r.data[17] === -38);
  r = comp(ds, CB("c", "g", "-", "spec"));
  check("b: combine a(t) - b(t,f) -> dims t,f", JSON.stringify(r.dims) === '["t","f"]' && r.data[0] === 52 && r.data[17] === 38);
  r = comp(ds, CB("c", "g", "*", "line"));
  check("b: combine outer product a(t)*b(f)", JSON.stringify(r.dims) === '["t","f"]'
    && allNear(r.data, [2, 4, 6, 8, 10, 12, 4, 8, 12, 16, 20, 24, 8, 16, 24, 32, 40, 48]) && r.attrs.units === "A·V");
  r = comp(ds, CB("c", "line", "/", "g"));
  check("b: combine a(f)/b(t) -> dims f,t", JSON.stringify(r.dims) === '["f","t"]' && r.data[1] === 0.25 && r.attrs.units === "V/A");
  r = comp(ds, CB("c", "spec", "+", 30));
  check("b: combine + constant", r.data[0] === -20 && r.attrs.units === "dBm" && JSON.stringify(r.shape) === "[3,6]");
  r = comp(ds, CB("c", "zero", "/", 0));
  check("b: x/0 -> NaN (non-finite stored as NaN)", Array.from(r.data).every(isNaNum));
  r = comp(ds, CB("c", "nanv", "max", "g"));
  check("b: max with NaN -> NaN", allNear(r.data, [2, NaN, 8]), show(r.data));
  r = comp(ds, CB("c", "nanv", "min", 2));
  check("b: min with constant", allNear(r.data, [1, NaN, 2]), show(r.data));
  r = comp(ds, CB("c", "scal", "*", "g"));
  check("b: 0-D a broadcast over b", JSON.stringify(r.dims) === '["t"]' && allNear(r.data, [14, 28, 56]));

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
}

// topo order, chains, cycles, missing deps, registration
{
  const ds = mk1();
  const peak = RD("peak", { src: "spec", over: "f", xsrc: "coord", stat: "max" }, { mode: "relative", center: "coord:t", halfwidth: 10 });
  const floor = RD("floor", { src: "spec", over: "f", xsrc: "coord", stat: "mean", region: "outside" },
    { mode: "relative", center: "coord:t", halfwidth: 10 });
  const snr = CB("SNR", "peak", "-", "floor");
  let st = D.registerDerived(ds, [snr, peak, floor]);
  check("b: chain registered in topo order", [...st.values()].every((s) => s.ok), JSON.stringify([...st]));
  const pv = ds.vars.peak, fv = ds.vars.floor, sv = ds.vars.SNR;
  check("b: SNR = peak - floor", sv && allNear(sv.data, Array.from(pv.data, (v, i) => v - fv.data[i]), 0));
  check("b: SNR units dB", sv.attrs.units === "dB");
  check("b: registered var is a Variable, derived, with canonical def",
    sv instanceof Variable && sv.derived === true && sv.isNumeric() && sv.dtype === "double"
    && JSON.stringify(sv.def) === JSON.stringify(D.canonicalDef(snr)));
  check("b: status shape", JSON.stringify(st.get("peak").shape) === "[3]" && st.get("peak").error === null);
  const { order } = D.topoOrder([snr, peak, floor]);
  check("b: topoOrder deps first, else input order", order.map((d) => d.name).join(",") === "peak,floor,SNR");

  // derived var as center and as x source
  const pkx = RD("pkx", { src: "spec", over: "f", xsrc: "coord", stat: "argmax_x" });
  const pk2 = RD("pk2", { src: "spec", over: "f", xsrc: "coord", stat: "max" }, { mode: "relative", center: "var:pkx", halfwidth: 0 });
  const fk = TF("fk", "fx", "scale", { scale: 0.001 });
  const pk3 = RD("pk3", { src: "spec", over: "f", xsrc: "var:fk", stat: "max" }, { mode: "fixed", lo: 0.014, hi: 0.026 });
  st = D.registerDerived(ds, [pk3, pk2, fk, pkx]);
  check("b: previous derived vars dropped", !ds.vars.peak && !ds.vars.SNR && !ds.has("floor"));
  check("b: center var depending on a derived var", st.get("pk2").ok && allNear(ds.vars.pk2.data, [-20, -25, -22]), JSON.stringify([...st]));
  check("b: derived var used as x source", st.get("pk3").ok && allNear(ds.vars.pk3.data, [-20, -52, -40]), show(ds.vars.pk3 && ds.vars.pk3.data));

  // cycles / self refs / missing / dependents
  const A = CB("A", "B", "+", 1), B = CB("B", "A", "+", 1), C = CB("C", "A", "*", 2), S = CB("S", "S", "+", 1);
  const M = CB("M", "nope", "+", 1), N = TF("N", "M", "abs"), OK = TF("OK", "g", "abs");
  const t = D.topoOrder([A, B, C, S, M, N, OK]);
  check("b: topo cycle errors", /circular/.test(t.errors.get("A") || "") && /circular/.test(t.errors.get("B") || ""), JSON.stringify([...t.errors]));
  check("b: topo self reference", /itself/.test(t.errors.get("S") || ""));
  check("b: topo dependent of a cycle", /depends on 'A'/.test(t.errors.get("C") || ""));
  check("b: topo order excludes errors", t.order.map((d) => d.name).join(",") === "M,N,OK");
  st = D.registerDerived(ds, [A, B, C, S, M, N, OK]);
  check("b: register: cycle + self + dependents fail", ["A", "B", "C", "S"].every((n) => !st.get(n).ok && !ds.vars[n]));
  check("b: register: missing dep is an error", !st.get("M").ok && /not found/.test(st.get("M").error));
  check("b: register: dependent of failed def", !st.get("N").ok && /depends on 'M'/.test(st.get("N").error));
  check("b: register: independent def still ok", st.get("OK").ok && ds.vars.OK.derived);
  check("b: validateDef self reference", /itself/.test(err(ds, S) || ""));

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
  check("b: name of a registered derived var is not a 'real var' clash", D.validateName(ds, [], "OK") === null);
  st = D.registerDerived(ds, [TF("spec", "g", "abs"), TF("t", "g", "abs"), TF("bad/x", "g", "abs"), TF("ok2", "spec", "abs"),
    TF("dup", "g", "abs"), TF("dup", "line", "abs")]);
  check("b: register rejects real-var / dim / bad names", !st.get("spec").ok && !st.get("t").ok && !st.get("bad/x").ok);
  check("b: real var untouched by a clashing def", !ds.vars.spec.derived && ds.vars.spec.dims.length === 2);
  check("b: dep named like a failed clashing def resolves to the real var", st.get("ok2").ok && ds.vars.ok2.data[0] === 50);
  check("b: duplicate names: first wins", st.get("dup").ok && JSON.stringify(ds.vars.dup.dims) === '["t"]');
  D.unregisterDerived(ds);
  check("b: unregisterDerived", !Object.values(ds.vars).some((v) => v.derived) && ds.has("spec"));
  check("b: __proto__ def is never registered", (D.registerDerived(ds, [TF("__proto__", "g", "abs")]),
    Object.getPrototypeOf(ds.vars) === Object.prototype));
}

// validation errors
{
  const ds = mk1();
  const base = { src: "spec", over: "f", xsrc: "coord", stat: "max" };
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
    ["fixed lo null", RD("r", base, { mode: "fixed", hi: 3 }), /lo and hi/],
    ["fixed non-number", RD("r", base, { mode: "fixed", lo: "1", hi: 3 }), /finite/],
    ["outside_within fixed needs lo2/hi2", RD("r", { ...base, region: "outside_within" }, { mode: "fixed", lo: 1, hi: 3, lo2: 0 }), /outer/],
    ["relative center missing", RD("r", base, { mode: "relative", halfwidth: 1 }), /center/],
    ["relative center var missing", RD("r", base, { mode: "relative", center: "var:nope", halfwidth: 1 }), /not found/],
    ["relative center dims not in result", RD("r", base, { mode: "relative", center: "var:fx", halfwidth: 1 }), /lacks/],
    ["relative center coord of reduced dim", RD("r", base, { mode: "relative", center: "coord:f", halfwidth: 1 }), /not a remaining/],
    ["relative halfwidth null", RD("r", base, { mode: "relative", center: "coord:t" }), /half width/],
    ["outside_within relative needs halfwidth2", RD("r", { ...base, region: "outside_within" },
      { mode: "relative", center: "coord:t", halfwidth: 1 }), /outer half width/],
    ["outside with mode none", RD("r", { ...base, region: "outside" }), /needs a window/],
    ["outside_within with mode none", RD("r", { ...base, region: "outside_within" }), /needs a window/],
    ["unknown stat", RD("r", { ...base, stat: "mode" }), /statistic/],
    ["unknown region", RD("r", { ...base, region: "x" }), /region/],
    ["unknown db", RD("r", { ...base, db: "maybe" }), /dB mode/],
    ["unknown mode", RD("r", base, { mode: "x" }), /window mode/],
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
  check("b: resultShape", JSON.stringify(D.resultShape(ds, RD("r", base))) === '{"dims":["t"],"shape":[3]}');
  check("b: resultShape combine", JSON.stringify(D.resultShape(ds, CB("c", "g", "+", "line"))) === '{"dims":["t","f"],"shape":[3,6]}');
  check("b: xsrc coord on a dim without coordinate is valid", err(ds, RD("r", { src: "ze", over: "e", xsrc: "coord" })) === null);
}

// builder helpers + preview + describe
{
  const ds = mk1();
  check("b: xSourceOptions", JSON.stringify(D.xSourceOptions(ds, "spec", "f")) === '["index","coord","var:f","var:fx","var:line"]',
    JSON.stringify(D.xSourceOptions(ds, "spec", "f")));
  check("b: suggestXsrc numeric coord", D.suggestXsrc(ds, "spec", "f") === "coord");
  const ds2 = mkds("s.nc", { k: 3, m: 2 }, {
    k: { dims: ["k"], data: [0, 1, 2] }, m: { dims: ["m"], data: [5, 6] },
    sp: { dims: ["k", "m"], data: [1, 2, 3, 4, 5, 6], units: "dBm" },
    freqs: { dims: ["k", "m"], data: [1, 2, 3, 4, 5, 6], units: "Hz" },
    other: { dims: ["k"], data: [1, 2, 3] },
  });
  check("b: suggestXsrc skips an index-like coord for a 'freq' var", D.suggestXsrc(ds2, "sp", "k") === "var:freqs");
  check("b: suggestXsrc index when nothing fits", D.suggestXsrc(mkds("z.nc", { k: 2 }, { a: { dims: ["k"], data: [1, 2] } }), "a", "k") === "index");
  check("b: centerSourceOptions", JSON.stringify(D.centerSourceOptions(ds, "spec", "f")) === '["coord:t","var:cen","var:g","var:scal","var:nanv","var:zero","var:dbw","var:db","var:mw","var:w","var:dbm2"]',
    JSON.stringify(D.centerSourceOptions(ds, "spec", "f")));
  const def = RD("p", { src: "s3", over: "f", xsrc: "var:fx", stat: "mean", region: "outside_within" },
    { mode: "relative", center: "coord:t", k: 1, offset: 5, halfwidth: 10, halfwidth2: 22 });
  const pv = D.previewSlice(ds, def, { t: 1, q: 9 });          // q clamped to 1
  check("b: preview x/y", allNear(pv.x, [15, 25, 35, 45, 55, 65]) && allNear(pv.y, SPEC[1].map((v) => v + 1)), show(pv.y));
  check("b: preview center = k·c + offset", pv.center === 35);
  check("b: preview windows", JSON.stringify(pv.inner) === "[25,45]" && JSON.stringify(pv.outer) === "[13,57]");
  check("b: preview member", Array.from(pv.member).join("") === "100010");
  check("b: preview value/count/db", pv.count === 2 && pv.db === true
    && near(pv.value, todb((lin(-54) + lin(-50)) / 2)) && near(pv.value, D.computeDef(ds, def).data[3]));
  const pv0 = D.previewSlice(ds, RD("p", { src: "spec", over: "f", stat: "count" }), {});
  check("b: preview mode none", pv0.inner === null && pv0.outer === null && pv0.center === null && pv0.value === 6 && pv0.db === true);
  let threw = false;
  try { D.previewSlice(ds, CB("c", "spec", "-", 1), {}); } catch (e) { threw = true; }
  check("b: preview only for reduce", threw);
  check("b: describe reduce relative",
    D.describeDef(RD("p", { src: "spectrums", over: "TraceIndex" }, { mode: "relative", center: "coord:stimulusFrequency", halfwidth: 1e6 }))
    + "|" === "Peak (max) of spectrums over TraceIndex, inside stimulusFrequency ± 1e+06|");
  check("b: describe k/offset/outside_within/db",
    D.describeDef(def) === "Mean of s3 over f, outside t + 5 ± 10, within t + 5 ± 22",
    D.describeDef(def));
  check("b: describe harmonic", D.describeDef(RD("p", { src: "a", over: "b", region: "outside", db: "yes", stat: "mean" },
    { mode: "relative", center: "var:f0", k: 2, offset: -1500, halfwidth: 0.02 }))
    === "Mean of a over b, outside 2·f0 - 1500 ± 0.02 (dB data, linear-power stats)");
  check("b: describe combine/transform", D.describeDef(CB("c", "peak", "-", "floor")) === "peak - floor"
    && D.describeDef(CB("c", "a", "max", 3)) === "max(a, 3)" && D.describeDef(TF("x", "p", "db2lin")) === "10^(p/10)"
    && D.describeDef(TF("x", "p", "scale", { scale: 1e-9, offset: 2 })) === "1e-09·p + 2");
  check("b: STATS ids/order", D.STATS.map((s) => s.id).join() === "max,min,mean,median,std,sum,integral,count,argmax_x,argmin_x"
    && D.STATS.every((s) => s.label && s.hint) && D.STATS[0].label === "Peak (max)");
  check("b: REGIONS/OPS/TRANSFORMS/WINDOW_MODES/DB_MODES",
    D.REGIONS.map((s) => s.id).join() === "inside,outside,outside_within"
    && D.OPS.map((s) => s.id).join() === "-,+,*,/,max,min" && D.OPS[0].label === "a − b"
    && D.TRANSFORMS.map((s) => s.id).join() === "db2lin,lin2db,scale,abs"
    && D.WINDOW_MODES.map((s) => s.id).join() === "none,fixed,relative"
    && D.DB_MODES.map((s) => s.id).join() === "auto,yes,no" && D.MAX_DERIVED === 256);
  check("b: depsOf", JSON.stringify(D.depsOf(RD("p", { src: "a", xsrc: "var:x" }, { center: "var:a" }))) === '["a","x"]'
    && JSON.stringify(D.depsOf(CB("c", "a", "-", 3))) === '["a"]' && JSON.stringify(D.depsOf(CB("c", "a", "-", "b"))) === '["a","b"]');
  check("b: trimUnits / isDb", D.trimUnits(" DBM\n") === "DBM" && D.trimUnits(null) === "" && D.isDb("DBM\n")
    && D.isDb("dBm/Hz") && !D.isDb("mW") && !D.isDb(undefined));
}

// =============================================================================
// (c) sanitizeDef / canonicalDef
// =============================================================================
{
  const full = {
    name: "peak", file: "darpa.nc", kind: "reduce", units: "", description: "tone",
    src: "spectrums", over: "TraceIndex", xsrc: "var:frequencies",
    window: { mode: "relative", lo: null, hi: null, lo2: null, hi2: null, center: "coord:stimulusFrequency",
      k: 2, offset: -1.5e6, halfwidth: 1e6, halfwidth2: 5e6 },
    region: "outside_within", stat: "median", db: "yes",
  };
  const defs = [full, D.newDef("reduce", "a.nc"), D.newDef("combine", "a.nc"), D.newDef("transform", "a.nc"),
    { ...D.newDef("combine", "f.nc"), name: "SNR", a: "peak", op: "/", b: -3.25 },
    { ...D.newDef("transform", "f.nc"), name: "t1", src: "x", fn: "scale", scale: 1e-9, offset: 7 },
    { ...full, window: { ...full.window, mode: "fixed", lo: 1, hi: 2, lo2: 0, hi2: 3 } }];
  for (const d of defs.slice(1, 4)) d.name = "n1";
  for (const d of defs) {
    const c = D.canonicalDef(d);
    const j = JSON.stringify(c);
    const s = D.sanitizeDef(JSON.parse(j));
    check(`c: round trip byte-identical (${d.kind} ${d.name})`, s && JSON.stringify(s) === j && JSON.stringify(D.canonicalDef(s)) === j, JSON.stringify(s));
  }
  check("c: newDef is canonical", ["reduce", "combine", "transform"].every((k) =>
    JSON.stringify(D.canonicalDef(D.newDef(k, "x.nc"))) === JSON.stringify(D.newDef(k, "x.nc"))));
  const shuffled = JSON.parse(JSON.stringify({ db: full.db, stat: full.stat, region: full.region,
    window: Object.fromEntries(Object.entries(full.window).reverse()), xsrc: full.xsrc, over: full.over, src: full.src,
    description: full.description, units: full.units, kind: full.kind, file: full.file, name: full.name }));
  check("c: key order canonical regardless of input order", JSON.stringify(D.sanitizeDef(shuffled)) === JSON.stringify(full)
    && JSON.stringify(D.canonicalDef(shuffled)) === JSON.stringify(full));
  check("c: canonical keys", Object.keys(D.canonicalDef(full)).join() === "name,file,kind,units,description,src,over,xsrc,window,region,stat,db"
    && Object.keys(D.canonicalDef(full).window).join() === "mode,lo,hi,lo2,hi2,center,k,offset,halfwidth,halfwidth2"
    && Object.keys(D.newDef("combine")).join() === "name,file,kind,units,description,a,op,b"
    && Object.keys(D.newDef("transform")).join() === "name,file,kind,units,description,src,fn,scale,offset");
  const cd = D.canonicalDef(full);
  cd.window.lo = 99;
  check("c: canonicalDef is a deep copy", full.window.lo === null);
  check("c: canonicalDef keeps a half-edited def", D.canonicalDef({ kind: "reduce", name: "" }).name === ""
    && D.canonicalDef({ kind: "reduce", stat: "bogus" }).stat === "bogus");

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
  check("c: wrong types -> defaults", h.over === "" && h.window.lo === null && h.window.hi === null && h.window.k === 1
    && h.window.offset === 0 && h.window.halfwidth === null && h.window.mode === "none");
  check("c: hostile keys only canonical", Object.keys(h).join() === Object.keys(D.newDef("reduce")).join());
  const bad = (o) => D.sanitizeDef({ kind: "reduce", name: "x", ...o });
  check("c: rejects", D.sanitizeDef(null) === null && D.sanitizeDef([]) === null && D.sanitizeDef("x") === null
    && D.sanitizeDef(5) === null && D.sanitizeDef({ kind: "magic", name: "x" }) === null
    && D.sanitizeDef({ name: "x" }) === null && D.sanitizeDef({ kind: "reduce" }) === null
    && D.sanitizeDef({ kind: "reduce", name: "a/b" }) === null && D.sanitizeDef({ kind: "reduce", name: "__proto__" }) === null
    && bad({ stat: "mode" }) === null && bad({ region: "x" }) === null && bad({ db: 1 }) === null
    && bad({ xsrc: "var:" }) === null && bad({ xsrc: 5 }) === null && bad({ window: [] }) === null
    && bad({ window: { mode: "x" } }) === null && bad({ window: { center: "foo" } }) === null
    && D.sanitizeDef({ kind: "combine", name: "x", op: "^" }) === null
    && D.sanitizeDef({ kind: "transform", name: "x", fn: "sqrt" }) === null);
  check("c: inherited props ignored", D.sanitizeDef(Object.create({ kind: "reduce", name: "x" })) === null);
  const nullProto = Object.assign(Object.create(null), { kind: "transform", name: "x", src: "y", fn: "scale", scale: NaN, offset: "1" });
  const np = D.sanitizeDef(nullProto);
  check("c: null-prototype input, NaN/strings in numbers", np && np.scale === 1 && np.offset === 0);
  check("c: combine b types", D.sanitizeDef({ kind: "combine", name: "x", b: NaN }).b === ""
    && D.sanitizeDef({ kind: "combine", name: "x", b: true }).b === ""
    && D.sanitizeDef({ kind: "combine", name: "x", b: -2.5 }).b === -2.5
    && D.sanitizeDef({ kind: "combine", name: "x", b: "v" }).b === "v");
  check("c: missing enums -> defaults", JSON.stringify(D.sanitizeDef({ kind: "reduce", name: "x" }))
    === JSON.stringify({ ...D.newDef("reduce", ""), name: "x" }));
  check("c: units trimmed", D.sanitizeDef({ kind: "transform", name: "x", units: " DBM\n" }).units === "DBM");
  const once = D.sanitizeDef(hostile);
  check("c: sanitize idempotent on hostile input", JSON.stringify(D.sanitizeDef(JSON.parse(JSON.stringify(once)))) === JSON.stringify(once));
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
const rel = (center, hw, extra) => ({ mode: "relative", center, halfwidth: hw, ...(extra || {}) });

{
  const F = "darpa.nc", r = (n, o) => sd(F, "reduce", n, { src: "spectrums", over: "TraceIndex", xsrc: "var:frequencies", ...o });
  const W = rel("coord:stimulusFrequency", 1e6);
  realDefs[F] = [
    r("d_peak", { window: W, stat: "max" }),
    r("d_floor", { window: W, stat: "mean", region: "outside" }),
    sd(F, "combine", "d_SNR", { a: "d_peak", op: "-", b: "d_floor" }),
    r("d_fpk", { window: W, stat: "argmax_x" }),
    r("d_fmin", { window: rel("coord:stimulusFrequency", 1e6, { halfwidth2: 5e6 }), stat: "argmin_x", region: "outside_within" }),
    r("d_med", { window: rel("coord:stimulusFrequency", 1e6, { halfwidth2: 1e7 }), stat: "median", region: "outside_within" }),
    r("d_std_lin", { window: W, stat: "std", region: "outside", db: "no" }),
    r("d_std_db", { window: W, stat: "std", region: "outside", db: "yes" }),
    r("d_int", { window: rel("coord:stimulusFrequency", 2e6), stat: "integral" }),
    r("d_int_lin", { stat: "integral", db: "no" }),
    r("d_cnt", { window: rel("coord:stimulusFrequency", 3e6), stat: "count" }),
    r("d_h2", { window: rel("coord:stimulusFrequency", 1e6, { k: 2, offset: -4e7 }), stat: "max" }),
    r("d_pk2", { window: rel("var:d_fpk", 1e5), stat: "max" }),
    sd(F, "combine", "d_norm", { a: "spectrums", op: "-", b: "d_peak" }),
    sd(F, "combine", "d_rev", { a: "d_peak", op: "-", b: "spectrums" }),
    sd(F, "transform", "d_lin", { src: "spectrums", fn: "db2lin" }),
    sd(F, "reduce", "d_linsum", { src: "d_lin", over: "TraceIndex", xsrc: "var:frequencies", stat: "sum",
      window: { mode: "fixed", lo: 2.9e7, hi: 3.1e7 } }),
    sd(F, "transform", "d_back", { src: "d_lin", fn: "lin2db" }),
    sd(F, "transform", "d_fGHz", { src: "frequencies", fn: "scale", scale: 1e-9, offset: 0, units: "GHz" }),
    sd(F, "reduce", "d_pk_ghz", { src: "spectrums", over: "TraceIndex", xsrc: "var:d_fGHz", stat: "max",
      window: { mode: "fixed", lo: 0.031, hi: 0.029 } }),
    sd(F, "reduce", "d_tr_min", { src: "spectrums", over: "trace", xsrc: "index", stat: "min", window: { mode: "fixed", lo: 0, hi: 1 } }),
    sd(F, "reduce", "d_amp_mean", { src: "spectrums", over: "stimulusAmp", xsrc: "coord", stat: "mean", db: "yes" }),
    sd(F, "combine", "d_ratio", { a: "d_peak", op: "/", b: "d_floor" }),
    sd(F, "combine", "d_mul", { a: "d_peak", op: "*", b: 2 }),
    sd(F, "combine", "d_max", { a: "d_peak", op: "max", b: "d_floor" }),
    sd(F, "combine", "d_min", { a: "d_fpk", op: "min", b: "d_fmin" }),
    sd(F, "combine", "d_plus", { a: "d_peak", op: "+", b: -30 }),
    sd(F, "transform", "d_abs", { src: "spectrums", fn: "abs" }),
    sd(F, "reduce", "d_lw", { src: "spectrums", over: "TraceIndex", xsrc: "index", stat: "mean", db: "no",
      window: rel("var:laswrPowers", 50, { k: -10 }) }),
    sd(F, "reduce", "d_cidx", { src: "spectrums", over: "TraceIndex", xsrc: "coord", stat: "max",
      window: rel("coord:trace", 50, { k: 100, offset: 200 }) }),
  ];
}
{
  const F = "sidebands.nc", r = (n, o) => sd(F, "reduce", n, { src: "spectra_dbm", over: "wl", xsrc: "var:wl_nm", ...o });
  realDefs[F] = [
    r("s_pk", { window: rel("var:pump_nm", 0.02), stat: "max" }),
    r("s_sbl", { window: rel("var:sb_low_nm", 0.01), stat: "max" }),
    r("s_sbl_out", { window: rel("var:sb_low_nm", 0.01), stat: "mean", region: "outside" }),
    r("s_floor", { window: rel("var:pump_nm", 0.05, { halfwidth2: 0.5 }), stat: "mean", region: "outside_within" }),
    r("s_int", { window: { mode: "fixed", lo: 1550, hi: 1551 }, stat: "integral" }),
    r("s_med", { window: { mode: "fixed", lo: 1549.6, hi: 1550.3 }, stat: "median" }),
    sd(F, "combine", "s_snr", { a: "s_pk", op: "-", b: "s_floor" }),
    sd(F, "combine", "s_diff", { a: "pump_dbm", op: "-", b: "s_pk" }),
    sd(F, "reduce", "s_over_freq", { src: "spectra_dbm", over: "freq", xsrc: "var:freq_Hz", stat: "std", db: "no",
      window: { mode: "fixed", lo: 1e9, hi: 2e10 } }),
    sd(F, "reduce", "s_idxc", { src: "spectra_dbm", over: "freq", xsrc: "index", stat: "max",
      window: rel("coord:wl", 10, { k: 0.3 }) }),
    r("s_cnt", { window: { mode: "fixed", lo: 1550.4, hi: 1550.6, lo2: 1550, hi2: 1551 }, stat: "count", region: "outside_within" }),
  ];
}
{
  const F = "fourd.nc";
  realDefs[F] = [
    sd(F, "reduce", "f_pk", { src: "spectra", over: "traceindex", xsrc: "var:frequency", stat: "max" }),
    sd(F, "reduce", "f_fpk", { src: "spectra", over: "traceindex", xsrc: "var:frequency", stat: "argmax_x" }),
    sd(F, "reduce", "f_win", { src: "spectra", over: "traceindex", xsrc: "var:frequency", stat: "mean",
      window: rel("coord:d1", 5e8, { k: 1e9, offset: 2e9 }) }),
    sd(F, "reduce", "f_d1", { src: "spectra", over: "d1", xsrc: "coord", stat: "mean", db: "yes" }),
    sd(F, "reduce", "f_d3", { src: "spectra", over: "d3", xsrc: "coord", stat: "integral", db: "no",
      window: { mode: "fixed", lo: 0, hi: 2 } }),
    sd(F, "reduce", "f_sum", { src: "spectra", over: "d2", xsrc: "index", stat: "sum" }),
  ];
}
{
  const F = "powercal_hdf5.nc", W = rel("coord:frequency", 2e7);
  realDefs[F] = [
    sd(F, "reduce", "p_pk", { src: "sa_trace", over: "sa_point", xsrc: "var:sa_freq", stat: "max", window: W }),
    sd(F, "reduce", "p_floor", { src: "sa_trace", over: "sa_point", xsrc: "var:sa_freq", stat: "mean", region: "outside", window: W }),
    sd(F, "combine", "p_d", { a: "sa_peak", op: "-", b: "p_pk" }),
    sd(F, "reduce", "p_mean_sweep", { src: "sa_peak", over: "sweep", xsrc: "index", stat: "mean", db: "no" }),
    sd(F, "reduce", "p_mean_sweep_db", { src: "sa_peak", over: "sweep", xsrc: "index", stat: "mean" }),
    sd(F, "reduce", "p_std", { src: "sa_peak", over: "sweep", xsrc: "index", stat: "std", db: "no" }),
    sd(F, "reduce", "p_amin", { src: "sa_trace", over: "sa_point", xsrc: "coord", stat: "argmin_x" }),
    sd(F, "reduce", "p_pk_all", { src: "sa_trace", over: "sa_point", xsrc: "var:sa_freq", stat: "max" }),
  ];
}

const loaded = {};
for (const F of Object.keys(realDefs)) {
  if (!haveData(F)) { skip(`d: ${F}`, "tests/data file missing"); continue; }
  const ds = await loadDataset(dataFile(F));
  const st = D.registerDerived(ds, realDefs[F]);
  const bad = [...st].filter(([, s]) => !s.ok);
  check(`d: ${F}: all ${st.size} defs register`, bad.length === 0, JSON.stringify(bad));
  loaded[F] = ds;
}
if (loaded["darpa.nc"]) {
  const ds = loaded["darpa.nc"];
  const v = (n) => ds.vars[n];
  check("d: darpa suggestXsrc -> var:frequencies", D.suggestXsrc(ds, "spectrums", "TraceIndex") === "var:frequencies");
  check("d: darpa peak dims", JSON.stringify(v("d_peak").dims) === '["stimulusFrequency","stimulusAmp","trace"]'
    && JSON.stringify(v("d_peak").shape) === "[2,2,3]" && v("d_peak").attrs.units === "DBM");
  check("d: darpa SNR = peak - floor exactly", allNear(v("d_SNR").data, Array.from(v("d_peak").data, (p, i) => p - v("d_floor").data[i]), 0)
    && v("d_SNR").attrs.units === "dB");
  // brute force, independent of the kernel: [TraceIndex, sf, sa, trace] C order
  const S = v("spectrums").data, Fq = v("frequencies").data, sfv = v("stimulusFrequency").data;
  const pk = [], fl = [];
  for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) for (let t = 0; t < 3; t++) {
    let mx = -Infinity, sum = 0, c = 0;
    for (let k = 0; k < 601; k++) {
      const f = Fq[k * 4 + i * 2 + j], y = S[k * 12 + i * 6 + j * 3 + t];
      if (Math.abs(f - sfv[i]) <= 1e6) mx = Math.max(mx, y); else { sum += lin(y); c++; }
    }
    pk.push(mx); fl.push(todb(sum / c));
  }
  check("d: darpa peak = brute force", allNear(v("d_peak").data, pk, 0), show(v("d_peak").data));
  check("d: darpa floor = brute force (linear mean)", allNear(v("d_floor").data, fl, 1e-12));
  check("d: darpa SNR plausible (> 0 dB)", Array.from(v("d_SNR").data).every((x) => x > 0));
  check("d: darpa peak at derived center == peak", allNear(v("d_pk2").data, v("d_peak").data, 0));
  check("d: darpa db2lin units mW / lin2db back", v("d_lin").attrs.units === "mW" && v("d_back").attrs.units === "dBm"
    && allNear(v("d_back").data, S, 1e-12));
  check("d: darpa broadcast dims", JSON.stringify(v("d_norm").dims) === JSON.stringify(v("spectrums").dims)
    && JSON.stringify(v("d_rev").dims) === '["stimulusFrequency","stimulusAmp","trace","TraceIndex"]');
  check("d: darpa x at peak inside window", Array.from(v("d_fpk").data).every((x, i) => Math.abs(x - sfv[Math.floor(i / 6)]) <= 1e6));
  const pv = D.previewSlice(ds, realDefs["darpa.nc"][0], { stimulusFrequency: 1, stimulusAmp: 1, trace: 2 });
  check("d: darpa preview value = registered element", pv.value === v("d_peak").data[11] && pv.center === 1e8 && pv.db);
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
  check("d: powercal max in frequency ± 20 MHz == whole-trace max", eqAll);
  check("d: powercal sa_peak == round(max in window, 2 decimals)", mr < 1e-9 && md < 0.0034, { md, mr });
  const msw = ds.vars.p_mean_sweep.data, mref = ds.vars.sa_peak_mean.data;
  check("d: powercal sa_peak_mean == dB-domain mean over sweep (db: no)", allNear(msw, mref, 1e-12));
  let dd = 0;
  for (let i = 0; i < msw.length; i++) dd = Math.max(dd, Math.abs(ds.vars.p_mean_sweep_db.data[i] - mref[i]));
  console.log(`INFO powercal: sa_peak = round(max(sa_trace in frequency ± 20 MHz), 2): max |diff| before rounding ${md.toFixed(5)} dB; `
    + `sa_peak_mean is a dB-domain mean (linear-power mean differs by up to ${dd.toFixed(5)} dB); `
    + `sa_peak_std is the ddof=1 sample std (this engine's std is population, ddof=0)`);
}
if (loaded["fourd.nc"]) {
  const ds = loaded["fourd.nc"];
  check("d: fourd peak shape", JSON.stringify(ds.vars.f_pk.dims) === '["d1","d2","d3"]' && ds.vars.f_pk.data.length === 24);
  check("d: fourd argmax_x within the frequency range", Array.from(ds.vars.f_fpk.data).every((x) => x >= 1e9 && x <= 6.6e9)
    && ds.vars.f_fpk.attrs.units === "Hz");
  check("d: fourd suggestXsrc -> var:frequency", D.suggestXsrc(ds, "spectra", "traceindex") === "var:frequency");
}

// =============================================================================
// (e) performance: ~2 million elements
// =============================================================================
{
  const nt = 2000, nf = 1000, N = nt * nf;
  const spec = new Float64Array(N), fx = new Float64Array(N), cen = new Float64Array(nt);
  for (let i = 0; i < nt; i++) {
    cen[i] = 100 + (i % 700);
    for (let j = 0; j < nf; j++) {
      fx[i * nf + j] = j + 0.5 * (i % 3);
      spec[i * nf + j] = -60 + 10 * Math.sin(i * 0.37 + j * 0.11) + (j === cen[i] ? 40 : 0);
    }
  }
  const ds = new Dataset({ dims: { t: nt, f: nf }, attrs: {}, coords: new Set(), variables: {
    spec: { dims: ["t", "f"], shape: [nt, nf], attrs: { units: "dBm" }, dtype: "double", numeric: true, data: spec },
    fx: { dims: ["t", "f"], shape: [nt, nf], attrs: { units: "Hz" }, dtype: "double", numeric: true, data: fx },
    cen: { dims: ["t"], shape: [nt], attrs: { units: "Hz" }, dtype: "double", numeric: true, data: cen },
  } }, "perf.nc");
  const time = (fn) => { const t0 = performance.now(); const r = fn(); return [performance.now() - t0, r]; };
  const base = { src: "spec", over: "f", xsrc: "var:fx", window: rel("var:cen", 20, { halfwidth2: 200 }) };
  const tests = [
    ["reduce mean (dB, outside_within)", sd("perf.nc", "reduce", "a", { ...base, stat: "mean", region: "outside_within" })],
    ["reduce median (dB, outside)", sd("perf.nc", "reduce", "b", { ...base, stat: "median", region: "outside" })],
    ["reduce integral (dB)", sd("perf.nc", "reduce", "c", { ...base, stat: "integral", region: "outside" })],
    ["reduce max", sd("perf.nc", "reduce", "d", { ...base, stat: "max" })],
    ["combine broadcast 2M", sd("perf.nc", "combine", "e", { a: "spec", op: "-", b: "cen" })],
    ["transform db2lin 2M", sd("perf.nc", "transform", "f", { src: "spec", fn: "db2lin" })],
  ];
  for (const [what, def] of tests) {
    D.computeDef(ds, def);                       // warm up
    const [ms, r] = time(() => D.computeDef(ds, def));
    console.log(`PERF ${what}: ${ms.toFixed(1)} ms (${N} elements in, ${r.data.length} out)`);
    check(`e: perf ${what} < 1000 ms`, ms < 1000, ms);
  }
  const [ms] = time(() => D.registerDerived(ds, tests.map((t) => t[1])));
  console.log(`PERF registerDerived (6 defs): ${ms.toFixed(1)} ms`);
  const r = D.computeDef(ds, tests[3][1]);
  check("e: perf max finds the planted peak", Array.from(r.data).every((v) => v >= -30 - 1e-9));
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
    fs.writeFileSync(casesPath, JSON.stringify(files.map((F) => ({ file: dataFile(F), defs: realDefs[F] }))));
    const run = spawnSync(PYTHON, [script, casesPath, outPath], { encoding: "utf8", maxBuffer: 64 << 20 });
    if (!check("f: xcheck_derive.py ran", run.status === 0, (run.stderr || "").slice(-2000))) {
      // reported
    } else {
      const out = JSON.parse(fs.readFileSync(outPath, "utf8"));
      let nDefs = 0, nElems = 0, nNaN = 0, worst = 0;
      files.forEach((F, fi) => {
        const ds = loaded[F], res = out[fi].results;
        for (const def of realDefs[F]) {
          const pr = res[def.name], v = ds.vars[def.name];
          const tag = `f: xcheck ${F}:${def.name}`;
          if (!check(`${tag} python ok`, pr && !pr.error, pr && pr.error)) continue;
          if (!check(`${tag} registered`, !!v)) continue;
          nDefs++;
          check(`${tag} dims/shape`, JSON.stringify(v.dims) === JSON.stringify(pr.dims) && JSON.stringify(v.shape) === JSON.stringify(pr.shape),
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
      console.log(`XCHECK ${nDefs} defs over ${files.length} files, ${nElems} elements (${nNaN} NaN) compared; `
        + `worst relative difference ${worst.toExponential(2)}`);
      check("f: cross-check covered >= 25 defs", nDefs >= 25, nDefs);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

summary("derive");
