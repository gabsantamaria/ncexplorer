// pyexport.test.mjs — tests for docs/js/pyexport.js, the "Download Python report
// script" feature. Builds realistic projects in the exact app format (via
// project.js buildProject), generates the .py report scripts, RUNS them against
// tests/data and checks:
//   - exit code 0, the PDF exists with the expected page count, no raster images
//   - --dump-lines matches X.traceLines (docs/js/explore.js) on the same data,
//     for every visible trace (derived ones too when docs/js/derive.js is present)
//   - --dump-derived matches an independent reference implementation written
//     here from the spec, AND derive.js's registerDerived (rel 1e-9, NaN <-> NaN)
//   - the script's helpers (fmt6, colormaps, SI labels, legend labels, axis
//     limits, time units) match the JavaScript, and CONFIG round-trips every
//     string (quotes, backslashes, triple quotes, unicode)
//
// Run:  NCX_PYTHON=/path/to/python node tests/pyexport.test.mjs
// Python needs numpy, xarray, matplotlib, scipy, h5netcdf, pypdf. Without a
// usable Python (or without a data file) the affected checks are SKIPPED.
// NCX_KEEP=1 keeps the temp folder (scripts, PDFs, PNGs) for inspection.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { REPO, DATA_DIR, PYTHON, loadDataset, dataFile, haveData, moduleUrl,
  check, skip, summary } from "./node_env.mjs";

const X = await import(moduleUrl("explore.js"));
const CM = await import(moduleUrl("colormaps.js"));
const P = await import(moduleUrl("pyexport.js"));
let D = null;
try {
  D = await import(moduleUrl("derive.js"));
  if (typeof D.registerDerived !== "function") D = null;
} catch (e) { console.log("derive.js not usable: " + e.message); D = null; }
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
const W0 = { mode: "none", lo: null, hi: null, lo2: null, hi2: null, center: "", k: 1, offset: 0,
  halfwidth: null, halfwidth2: null };
const R = (name, file, src, over, xsrc, win, region, stat, extra = {}) => ({ name, file, kind: "reduce",
  units: "", description: "", src, over, xsrc, window: { ...W0, ...win }, region, stat, db: "auto", ...extra });
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
// Straight from the frozen spec section 1, with plain loops (no code shared with
// derive.js or the Python script). Returns Map(name -> {dims, shape, data} | {err}).
function refDerived(ds, defs) {
  const out = new Map();
  const names = new Set(defs.map((d) => d.name));
  const scaleOf = (units) => X.asFloatArray([1], units)[0];
  const getVar = (n) => {
    if (names.has(n)) { const r = out.get(n); return r && !r.err ? r : null; }
    const v = ds.vars[n];
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
  const deps = (d) => {
    const r = [];
    if (d.kind === "reduce") { r.push(d.src); if (d.xsrc.startsWith("var:")) r.push(d.xsrc.slice(4)); if (d.window.center.startsWith("var:")) r.push(d.window.center.slice(4)); }
    else if (d.kind === "combine") { r.push(d.a); if (typeof d.b === "string") r.push(d.b); }
    else r.push(d.src);
    return r.filter((n) => names.has(n));
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
      const w = d.window, n = ds.size(d.over);
      if (w.mode === "none" && d.region !== "inside") throw new Error("region needs window");
      if (w.mode === "fixed" && (w.lo === null || w.hi === null)) throw new Error("fixed needs lo/hi");
      if (w.mode === "relative" && w.halfwidth === null) throw new Error("relative needs halfwidth");
      const rdims = src.dims.filter((x) => x !== d.over), rshape = rdims.map((x) => ds.size(x));
      let xv = null, coord = null;
      if (d.xsrc.startsWith("var:")) {
        xv = getVar(d.xsrc.slice(4));
        if (!xv || !xv.dims.includes(d.over) || xv.dims.some((x) => !src.dims.includes(x))) throw new Error("bad xsrc");
      } else if (d.xsrc === "coord") {
        const cv = ds.vars[d.over];
        if (cv && cv.isNumeric()) coord = cv;
      }
      let cvar = null, cdim = null, ccoord = null;
      if (w.mode === "relative") {
        if (w.center.startsWith("coord:")) {
          cdim = w.center.slice(6);
          if (!rdims.includes(cdim)) throw new Error("bad center dim");
          const cv = ds.vars[cdim];
          if (cv && cv.isNumeric()) ccoord = cv;
        } else if (w.center.startsWith("var:")) {
          cvar = getVar(w.center.slice(4));
          if (!cvar || cvar.dims.some((x) => !rdims.includes(x))) throw new Error("bad center var");
        } else throw new Error("no center");
      }
      const db = d.db === "yes" || (d.db === "auto" && src.units.toLowerCase().includes("db"));
      const data = new Float64Array(rshape.reduce((a, b) => a * b, 1));
      each(rdims, rshape, (idx, f) => {
        const xs = [], ys = [];
        for (let k = 0; k < n; k++) {
          const j = { ...idx, [d.over]: k };
          ys.push(src.data[flat(src, j)]);
          if (xv) xs.push(xv.data[flat(xv, j)] * scaleOf(xv.units));
          else if (coord) xs.push(Number(coord.data[k]) * scaleOf(X.unitsOf(coord)));
          else xs.push(k);
        }
        let lo = -Infinity, hi = Infinity, lo2 = -Infinity, hi2 = Infinity;
        if (w.mode === "fixed") {
          lo = Math.min(w.lo, w.hi); hi = Math.max(w.lo, w.hi);
          if (w.lo2 !== null && w.hi2 !== null) { lo2 = Math.min(w.lo2, w.hi2); hi2 = Math.max(w.lo2, w.hi2); }
        } else if (w.mode === "relative") {
          let c;
          if (cvar) c = cvar.data[flat(cvar, idx)] * scaleOf(cvar.units);
          else c = ccoord ? Number(ccoord.data[idx[cdim]]) * scaleOf(X.unitsOf(ccoord)) : idx[cdim];
          const m = w.k * c + w.offset;
          // spec amendment: a relative window around a non-finite center has NO members
          if (!Number.isFinite(m)) { data[f] = d.stat === "count" ? 0 : NaN; return; }
          lo = m - Math.abs(w.halfwidth); hi = m + Math.abs(w.halfwidth);
          if (w.halfwidth2 !== null) { lo2 = m - Math.abs(w.halfwidth2); hi2 = m + Math.abs(w.halfwidth2); }
        }
        data[f] = stat(xs, ys, lo, hi, lo2, hi2, d.region, d.stat, db);
      });
      return { dims: rdims, shape: rshape, data };
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
  // AUTO units, spec section 1.5
  const DOT = u(0xb7), norm = (s) => String(s).trim().toLowerCase(), isDb = (s) => norm(s).includes("db");
  const unitsOf = (n) => { const v = typeof n === "string" ? getVar(n) : null; return v ? v.units : ""; };
  const autoUnits = (d) => {
    if (d.kind === "reduce") {
      const su = unitsOf(d.src);
      const xu = d.xsrc === "coord" ? (ds.vars[d.over] ? X.unitsOf(ds.vars[d.over]) : "")
        : d.xsrc.startsWith("var:") ? unitsOf(d.xsrc.slice(4)) : "";
      if (["max", "min", "mean", "median", "std", "sum"].includes(d.stat)) return su;
      if (d.stat === "integral") return su && xu ? su + DOT + xu : (su || xu);
      if (d.stat === "count") return "";
      return xu;
    }
    if (d.kind === "combine") {
      const bVar = typeof d.b === "string", ua = unitsOf(d.a), ub = bVar ? unitsOf(d.b) : "";
      if (d.op === "-") return bVar && isDb(ua) && isDb(ub) && norm(ua) === norm(ub) ? "dB" : ua;
      if (d.op === "*") return ua && ub ? ua + DOT + ub : (ua || ub);
      if (d.op === "/") return ua && norm(ua) === norm(ub) ? "" : (ua && ub ? ua + "/" + ub : (ua || (ub ? "1/" + ub : "")));
      return ua;
    }
    const su = unitsOf(d.src), n = norm(su);
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
    R("pk", "Darpa.NC", "spectrums", "TraceIndex", "var:fx", { mode: "relative", center: "var:ctr", halfwidth: 1 }, "inside", "max"),
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
    const rel = { mode: "relative", center: "coord:stimulusFrequency", halfwidth: 1e6 };
    const derived = [
      R("peak", F, "spectrums", "TraceIndex", "var:frequencies", rel, "inside", "max"),
      R("floor", F, "spectrums", "TraceIndex", "var:frequencies", rel, "outside", "mean"),
      CB("SNR", F, "peak", "-", "floor"),
      R("peak_f", F, "spectrums", "TraceIndex", "var:frequencies", rel, "inside", "argmax_x"),
      R("around_peak", F, "spectrums", "TraceIndex", "var:frequencies", { mode: "relative", center: "var:peak_f", halfwidth: 2e5 }, "inside", "mean"),
      R("floor_med", F, "spectrums", "TraceIndex", "var:frequencies", { ...rel, halfwidth2: 5e6 }, "outside_within", "median"),
      R("floor_std_lin", F, "spectrums", "TraceIndex", "var:frequencies", rel, "outside", "std", { db: "no" }),
      R("floor_std_db", F, "spectrums", "TraceIndex", "var:frequencies", rel, "outside", "std"),
      R("band_int", F, "spectrums", "TraceIndex", "var:frequencies", { mode: "fixed", lo: 31e6, hi: 29e6 }, "inside", "integral"),
      R("band_cnt", F, "spectrums", "TraceIndex", "var:frequencies", { mode: "fixed", lo: 29e6, hi: 31e6, lo2: 20e6, hi2: 40e6 }, "outside_within", "count"),
      R("harm", F, "spectrums", "TraceIndex", "var:frequencies", { mode: "relative", center: "coord:stimulusFrequency", k: 0.5, offset: 5e6, halfwidth: 1e6 }, "inside", "max"),
      R("argmin_out", F, "spectrums", "TraceIndex", "coord", { mode: "fixed", lo: 400, hi: 100 }, "outside", "argmin_x"),
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
      R("bad_fixed", F, "spectrums", "TraceIndex", "index", { mode: "fixed", lo: 1 }, "inside", "max"),
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
      expectOut: [/circular definition/, /unknown statistic/, /showing 200 evenly spaced/],
      units: { peak: "DBM", floor: "DBM", SNR: "dB", peak_mW: "mW", back_dBm: "dBm", ratio: "", abs_snr: "custom u", band_cnt: "" },
      png: true });
  }

  // --- B. sidebands: Rainbow + colorbar + ssrc var + SI prefixes + limits + markers + sweep_label
  {
    const F = "sidebands.nc";
    const derived = [
      R("pump_pk", F, "spectra_dbm", "wl", "var:wl_nm", { mode: "relative", center: "var:pump_nm", halfwidth: 0.05 }, "inside", "max"),
      R("sb_floor", F, "spectra_dbm", "wl", "var:wl_nm", { mode: "relative", center: "var:pump_nm", halfwidth: 0.3, halfwidth2: 0.9 }, "outside_within", "median"),
      R("pump_int", F, "spectra_dbm", "wl", "var:wl_nm", { mode: "relative", center: "var:pump_nm", halfwidth: 0.05 }, "inside", "integral"),
      // sb_low_nm has NaN entries: around a NaN center nothing is a member (NaN; count 0)
      R("sb_low_out", F, "spectra_dbm", "wl", "var:wl_nm", { mode: "relative", center: "var:sb_low_nm", halfwidth: 0.02 }, "outside", "mean"),
      R("sb_low_cnt", F, "spectra_dbm", "wl", "var:wl_nm", { mode: "relative", center: "var:sb_low_nm", halfwidth: 0.02 }, "outside", "count"),
    ];
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
      ]),
      tab("2D sweep, index colorbar", { cmap: "CoolWarm", cunit: "G" }, [
        tr(F, "spectra_dbm", "wl", "var:wl_nm", "freq", {}, { ssrc: "index" }),
      ]),
    ];
    cases.push({ id: "B_sidebands_rainbow", files: [F], project: project(tabs, derived),
      opts: { pdfName: "sidebands_report", source: "sidebands" }, pages: 3, derivedErrors: [],
      expectOut: [/legend omitted/, /index - SI scaling not applied/],
      pdfText: [{ page: 0, includes: "OSA spectra vs VNA frequency" }, { page: 0, includes: "freq_Hz (GHz)" }],
      configPdfName: "sidebands_report.pdf", png: true, svg: true });
  }

  // --- C. fourd: 3D waterfall
  {
    const F = "fourd.nc";
    const derived = [R("fpk", F, "spectra", "traceindex", "var:frequency", { mode: "fixed", lo: 2e9, hi: 4e9 }, "inside", "max")];
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
    "hours since 1970", "days since 2000-01-01", "dns", "x ns y", "seconds", "DBM"];
  const req = {
    fmt6: fmtIn.map(enc), ts: tsIn.map(enc), cmaps: [...CM.CMAP_NAMES, "Nope"], scaled,
    line_label: llTraces.map(([t, sw, sv, j]) => [t, sw, sv === null ? null : enc(sv), j]),
    axis_range: ar.map(([a, b, c, d, e]) => [a, b, enc(c), enc(d), e]), time_scale: tsu,
  };
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
  }
  return out;
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
      check(`${tag}: ${d.name} units vs reference`, pv.units === rv.units, [pv.units, rv.units]);
      if (cs.units && d.name in cs.units) check(`${tag}: ${d.name} units '${cs.units[d.name]}'`, pv.units === cs.units[d.name], pv.units);
    }
    // (b) derive.js (the web app's engine)
    if (!D) continue;
    const ds = await loadDataset(filePath[file]);
    const st = D.registerDerived(ds, fdefs);
    for (const d of fdefs) {
      const s = st.get(d.name), pv = pyF[d.name];
      const expectErr = (cs.derivedErrors || []).includes(d.name);
      if (expectErr) { check(`${tag}: ${d.name} fails in derive.js too`, s && !s.ok, s); continue; }
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
  const derivedDs = new Map();      // file -> Dataset with derive.js vars registered
  const dsFor = async (t) => {
    if (!filePath[t.file]) return null;
    if (!usesDerived(t)) return plainDs(filePath[t.file]);
    if (!D) return null;
    if (!derivedDs.has(t.file)) {
      const ds = await loadDataset(filePath[t.file]);
      D.registerDerived(ds, cfg.derived.filter((d) => d.file === t.file));
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
  for (const cs of buildCases()) {
    try { await runCase(cs); }
    catch (e) { check(`${cs.id}: no exception in the test harness`, false, e.stack); }
  }
}
const ok = summary("pyexport");
if (KEEP || !ok) console.log("outputs kept in " + TMP);
else fs.rmSync(TMP, { recursive: true, force: true });
