// compat.test.mjs — adversarial BACKWARD-COMPATIBILITY test (SPEC_EXPR E3).
// Projects saved by the deployed version (git bc9812f) store reduce windows in
// the OLD format {mode fixed|relative, numbers, center "coord:<dim>" |
// "var:<name>", k, offset}; they must load, compute, save and export exactly as
// before.
//   NCX_PYTHON=<python> node tests/compat.test.mjs        (exit code 1 on any failure)
// Optional: NCX_DEMO_PROJ=<a .ncproj saved by bc9812f> is checked verbatim too;
// NCX_KEEP=1 keeps the temp folder.
//
// The bc9812f modules are taken from git (`git show`, no checkout) into a temp
// folder and run side by side with the working tree:
//  (a) E3 strings: migrated windows == an independent implementation of E3
//      (sanitizeDef, canonicalDef, pyexport's migrateWindow, the script's
//      migrate_window), canonical key order, no k/offset;
//  (b) numbers: a broad generated set of old-format defs on the real files —
//      every stat / region / dB mode, fixed + relative windows with k != 1,
//      +/- offsets, outer spans, centers via coord: and var:, dims without a
//      coordinate variable, NaN centers, exact-sample (inclusive) edges, chains
//      through combine / transform / reduce-of-derived, defs named like
//      functions or with odd characters — bc9812f numbers == migrated numbers
//      BITWISE (NaN == NaN), same dims / shape / units / errors; previews too;
//  (c) projects: old file -> load -> save -> load -> save is byte-identical and
//      only the windows change (exactly per E3); real lab projects unchanged;
//  (d) the Python report script of the migrated project (--dump-derived) gives
//      the bc9812f JS numbers, and the same numbers as bc9812f's own script;
//  (e) synthetic + hostile legacy input (time units, non-coordinate variables
//      named like a dim, odd names, overflow, k NaN, offset strings, empty
//      "coord:", unknown modes, ...).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { check, skip, summary, loadDataset, moduleUrl, REPO, DATA_DIR, PYTHON } from "./node_env.mjs";

const D = await import(moduleUrl("derive.js"));
const P = await import(moduleUrl("project.js"));
const PY = await import(moduleUrl("pyexport.js"));
const X = await import(moduleUrl("explore.js"));
const { Dataset } = await import(moduleUrl("dataset.js"));

const HEAD = "bc9812f";
const J = JSON.stringify;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ncx-compat-"));
const KEEP = !!process.env.NCX_KEEP;
const info = (s) => console.log("INFO " + s);
const short = (s, n = 400) => { s = typeof s === "string" ? s : J(s); return s.length > n ? s.slice(0, n) + "..." : s; };
function done() {
  summary("compat");
  if (KEEP) console.log("temp folder kept: " + TMP);
  else fs.rmSync(TMP, { recursive: true, force: true });
}

// ============================================================ the bc9812f modules
let H = null, HP = null, HPY = null, HDS = null;
{
  const dir = path.join(TMP, "head");
  fs.mkdirSync(dir);
  try {
    for (const f of ["derive.js", "dataset.js", "explore.js", "netcdf3.js", "hdf5.js", "project.js", "colormaps.js", "pyexport.js"]) {
      const r = spawnSync("git", ["show", `${HEAD}:docs/js/${f}`], { cwd: REPO, encoding: "utf8", maxBuffer: 64 << 20 });
      if (r.error || r.status !== 0) throw new Error(`git show ${HEAD}:docs/js/${f}: ${r.error ? r.error.code : (r.stderr || "").trim()}`);
      fs.writeFileSync(path.join(dir, f), r.stdout);
    }
    const imp = (f) => import(pathToFileURL(path.join(dir, f)).href);
    [H, HP, HPY, HDS] = await Promise.all(["derive.js", "project.js", "pyexport.js", "dataset.js"].map(imp));
  } catch (e) { H = null; skip("compat: everything (needs the bc9812f modules from git)", e.message); }
}
if (!H) { done(); process.exit(); }

// a dataset read by the bc9812f readers (old engine) / by the working tree's
async function loadOld(file) {
  const b = fs.readFileSync(file);
  return HDS.openBuffer(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), path.basename(file));
}

// ============================================================ helpers
// bit-identical: Object.is per element, except that any NaN equals any NaN
function sameBits(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x !== x && y !== y) continue;
    if (!Object.is(x, y)) return false;
  }
  return true;
}
// numerically equal (NaN == NaN, -0 == +0): for preview bounds/centers, where
// k*c + 0 (bc9812f) and k*c (now) may differ only in the sign of a zero
function sameNums(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!(a[i] === b[i] || (a[i] !== a[i] && b[i] !== b[i]))) return false;
  return true;
}
function firstDiff(a, b) {
  if (!a || !b || a.length !== b.length) return `length ${a && a.length} vs ${b && b.length}`;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (!(x !== x && y !== y) && !Object.is(x, y)) return `[${i}] ${x} vs ${y}`;
  }
  return "";
}
const STATS = ["max", "min", "mean", "median", "std", "sum", "integral", "count", "argmax_x", "argmin_x"];
const REGIONS = ["inside", "outside", "outside_within"];
const iota = (n) => Float64Array.from({ length: n }, (_, i) => i);
function finiteRange(a) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < a.length; i++) { const v = a[i]; if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } }
  return lo <= hi ? [lo, hi] : [0, 1];
}
function finiteSample(a, max = 4000) {
  const out = [], step = Math.max(1, Math.floor(a.length / max));
  for (let i = 0; i < a.length; i += step) if (Number.isFinite(a[i])) out.push(a[i]);
  return out;
}
// deterministic pseudo-random choices (same defs on every run)
function rng(seed) {
  let s = seed >>> 0;
  const r = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  r.pick = (a) => a[Math.floor(r() * a.length)];
  return r;
}
// a def exactly as bc9812f saved it (sanitized, canonical, through JSON)
const asSaved = (raw) => { const s = H.sanitizeDef(raw); return s ? JSON.parse(J(H.canonicalDef(s))) : null; };

// ---- SPEC_EXPR E3, implemented independently from the text of the spec
const E1_FUNCTIONS = ["abs", "sqrt", "exp", "ln", "log", "log10", "floor", "ceil", "round", "db2lin", "lin2db",
  "pow", "min", "max"];
const e3Quote = (n) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(n) && !E1_FUNCTIONS.includes(n) && n !== "pi" ? n : `"${n}"`);
// w: a window as bc9812f saved it (canonical: every key present, finite k/offset)
function e3(w) {
  const num = (x) => String(x);
  const fin = (x) => (typeof x === "number" && Number.isFinite(x) ? num(x) : "");
  const out = { mode: "none", lo: "", hi: "", lo2: "", hi2: "", center: "", halfwidth: "", halfwidth2: "" };
  if (w.mode === "fixed") {
    out.mode = "range";
    for (const k of ["lo", "hi", "lo2", "hi2"]) out[k] = fin(w[k]);
  } else if (w.mode === "relative") {
    out.mode = "center";
    const c = typeof w.center === "string" ? w.center : "";
    const name = c.startsWith("coord:") ? c.slice(6) : c.startsWith("var:") ? c.slice(4) : "";
    if (name) {
      const q = e3Quote(name), k = w.k, off = w.offset;
      out.center = (k === 1 ? q : `${num(k)}*${q}`) + (off === 0 ? "" : off < 0 ? ` - ${num(-off)}` : ` + ${num(off)}`);
    }
    out.halfwidth = typeof w.halfwidth === "number" ? num(Math.abs(w.halfwidth)) : "";
    out.halfwidth2 = typeof w.halfwidth2 === "number" ? num(Math.abs(w.halfwidth2)) : "";
  }
  return out;
}

// ---- the app's applyProject, minus the DOM (as tests/project.test.mjs)
function stateFrom(parsed, fileOrder = []) {
  return {
    fileOrder,
    wantedFiles: [...new Set(parsed.files.map((f) => P.basename(f)))],
    projectOrder: [...new Set(parsed.files.map((f) => P.basename(f)))].map((f) => f.toLowerCase()),
    derived: parsed.derived.map((d) => JSON.parse(J(d))),
    active: parsed.active,
    tabs: parsed.tabs.map((pt) => ({
      name: pt.name, plotcfg: { ...pt.plotcfg }, cur: pt.selected,
      traces: pt.traces.map((t) => ({ ...t, slices: { ...t.slices } })),
      markers: pt.markers.map((m) => ({ ...m })),
    })),
  };
}
const strip = (text) => { const o = JSON.parse(text); delete o.created; return J(o, null, 2); };

// x values a reduce of src over `over` sees (to place windows sensibly)
function xValuesOf(ds, over, xsrc) {
  if (xsrc === "coord") {
    const cv = ds.vars[over];
    if (cv && cv.isNumeric() && cv.dims.length === 1 && cv.dims[0] === over) return X.asFloatArray(cv.data, cv.attrs.units);
  } else if (xsrc.startsWith("var:")) {
    const v = ds.vars[xsrc.slice(4)];
    return X.asFloatArray(v.data, v.attrs.units);
  }
  return iota(ds.dims[over]);
}
function centerValuesOf(ds, c) {
  if (c.startsWith("coord:")) {
    const d = c.slice(6), cv = ds.vars[d];
    if (cv && cv.isNumeric() && cv.dims.length === 1 && cv.dims[0] === d) return X.asFloatArray(cv.data, cv.attrs.units);
    return iota(ds.dims[d]);
  }
  const v = ds.vars[c.slice(4)];
  return X.asFloatArray(v.data, v.attrs.units);
}

// ---- generated old-format defs: every (src, over) of the file round-robin,
// random x source / window / region / stat / dB mode (bc9812f's own option
// lists: xSourceOptions, centerSourceOptions)
function genLegacy(ds, file, count, r, maxResult) {
  const combos = [];
  for (const [src, v] of Object.entries(ds.vars)) {
    if (!v.isNumeric() || !v.dims.length || v.derived) continue;
    for (const over of v.dims) {
      if (v.data.length / v.shape[v.dims.indexOf(over)] > maxResult) continue;
      combos.push({ src, over, xs: H.xSourceOptions(ds, src, over), cs: H.centerSourceOptions(ds, src, over) });
    }
  }
  // (src, over) pairs with something to center on first
  combos.sort((a, b) => (b.cs.length > 0) - (a.cs.length > 0));
  const out = [];
  for (let i = 0; i < count && combos.length; i++) {
    const c = combos[i % combos.length];
    const xsrc = r.pick(c.xs);
    const xv = xValuesOf(ds, c.over, xsrc);
    const [xmin, xmax] = finiteRange(xv);
    const span = xmax - xmin || 1;
    const samples = finiteSample(xv);
    const frac = (p) => xmin + p * span;
    const sample = () => (samples.length ? r.pick(samples) : frac(r()));
    let region = r.pick(REGIONS);
    const stat = STATS[i % STATS.length];
    const db = r.pick(["auto", "auto", "yes", "no"]);
    let w;
    const roll = r();
    if (roll < 0.1) { w = { mode: "none" }; region = "inside"; }
    else if (roll < 0.42 || !c.cs.length) {
      const kind = Math.floor(r() * 4);
      let lo, hi;
      if (kind === 0) { lo = sample(); hi = sample(); }             // exact sample values (inclusive edges)
      else if (kind === 1) { lo = frac(0.3); hi = frac(0.6); }
      else if (kind === 2) { lo = frac(0.7); hi = frac(0.2); }       // reversed
      else { lo = hi = sample(); }                                   // degenerate
      w = { mode: "fixed", lo, hi };
      if (region === "outside_within" || r() < 0.3) {
        let lo2 = r() < 0.5 ? frac(0.05) : sample(), hi2 = r() < 0.5 ? frac(0.95) : sample();
        if (r() < 0.3) [lo2, hi2] = [hi2, lo2];
        Object.assign(w, { lo2, hi2 });
      }
    } else {
      const center = r.pick(c.cs);
      const [cmin, cmax] = finiteRange(centerValuesOf(ds, center));
      let k = 1, offset = 0;
      const variant = Math.floor(r() * 6);
      if (variant === 1 && cmax > cmin) { k = 0.5 * span / (cmax - cmin); offset = xmin + 0.25 * span - k * cmin; }
      else if (variant === 2 && cmax > cmin) { k = -0.5 * span / (cmax - cmin); offset = xmin + 0.75 * span - k * cmin; }
      else if (variant === 3) offset = (xmin + xmax) / 2 - (cmin + cmax) / 2;
      else if (variant === 4) { k = 1 / 3; offset = -1 / 7; }
      else if (variant === 5) { k = 2; offset = -(xmin + xmax) / 2; }
      const halfwidth = r() < 0.04 ? 1e308 : r.pick([0, 0.02 * span, 0.15 * span, -0.1 * span, span / 3, 0.5]);
      w = { mode: "relative", center, k, offset, halfwidth };
      if (region === "outside_within" || r() < 0.3) {
        w.halfwidth2 = halfwidth === 1e308 ? -1.5e308 : r.pick([3 * Math.abs(halfwidth) + 0.05 * span, 0.5 * span, -0.4 * span]);
      }
    }
    const raw = { kind: "reduce", name: `g${i}_${stat}`, file, units: i % 13 === 0 ? "u" + i : "",
      description: i % 17 === 0 ? `generated #${i}` : "", src: c.src, over: c.over, xsrc, window: w, region, stat, db };
    const s = asSaved(raw);
    if (s) out.push(s);
  }
  return out;
}

// ---- chains through derived variables, with names that need quoting or are
// function names (all legal in bc9812f): around an ok reduce `base`
function genChains(ds, file, base, suffix) {
  const taken = (n) => Object.prototype.hasOwnProperty.call(ds.vars, n) || Object.prototype.hasOwnProperty.call(ds.dims, n);
  const nm = (n) => { let s = n + suffix; while (taken(s)) s += "_"; return s; };
  const N = { pk: nm("floor"), win: nm("max"), diff: nm("noise floor"), lin: nm("a.b-c"), mul: nm("peak+1"),
    red: nm("3dB bw"), cnt: nm("log"), pi: nm("pi"), rnd: nm("round"), d0: nm("0start") };
  const v = ds.vars[base.src];
  const rdims = v.dims.filter((d) => d !== base.over);
  const xv = xValuesOf(ds, base.over, base.xsrc);
  const [xmin, xmax] = finiteRange(xv);
  const span = xmax - xmin || 1;
  const R = (name, o) => ({ ...base, name, units: "", description: "", ...o });
  const rel = (center, hw, extra) => ({ mode: "relative", center, k: 1, offset: 0, halfwidth: hw, ...(extra || {}) });
  const raws = [
    R(N.pk, { stat: "argmax_x", region: "inside" }),                                       // where the peak is
    R(N.win, { stat: "max", region: "inside", window: rel("var:" + N.pk, 0.03 * span) }),  // window around it
    { kind: "combine", name: N.diff, file, a: N.win, op: "-", b: base.name },
    { kind: "transform", name: N.lin, file, src: N.diff, fn: "db2lin" },
    { kind: "combine", name: N.mul, file, a: N.lin, op: "*", b: 2.5 },
    R(N.pi, { stat: "min", region: "outside", window: rel("var:" + N.pk, 0.1 * span, { k: 1 / 3, offset: -1 / 7 }) }),
    R(N.rnd, { stat: "count", region: "outside_within",
      window: rel("var:" + N.pi, 0.01 * span, { halfwidth2: 0.4 * span, offset: 1e-3 * span }) }),
    { kind: "transform", name: N.d0, file, src: N.pk, fn: "scale", scale: -2, offset: 1 / 3 },
  ];
  if (rdims.length) {
    // reduce OF a derived variable, windowed on another derived one
    const over2 = rdims[0], rest = rdims.slice(1);
    raws.push({ kind: "reduce", name: N.red, file, src: N.win, over: over2, xsrc: "index", stat: "mean", db: "auto",
      region: "inside", window: rest.length ? rel("coord:" + rest[0], 0.75, { k: 0.5, offset: 0.25 })
        : { mode: "fixed", lo: 0, hi: Math.max(1, ds.dims[over2] - 2) } });
    raws.push(R(N.cnt, { stat: "count", region: "outside",
      window: rel("var:" + N.red, 0.2 * span, { k: rest.length ? 1e-3 : 1, offset: (xmin + xmax) / 2 }) }));
  }
  return raws.map(asSaved).filter(Boolean);
}

// ---- compare bc9812f vs the working tree on one dataset; returns a list of deviations
function compareRegistered(defs, dsOld, so, dsNew, sn, tag) {
  const bad = [];
  for (const d of defs) {
    const o = so.get(d.name), n = sn.get(d.name);
    if (!o || !n) { bad.push(`${tag}${d.name}: no status (old ${!!o}, new ${!!n})`); continue; }
    if (o.ok !== n.ok) {
      bad.push(`${tag}${d.name}: old ${o.ok ? "ok" : "error '" + o.error + "'"} / new ${n.ok ? "ok" : "error '" + n.error + "'"}`
        + ` window ${short(J(d.window || null), 600)}`);
      continue;
    }
    if (!o.ok) continue;
    const a = dsOld.vars[d.name], b = dsNew.vars[d.name];
    if (J(a.dims) !== J(b.dims) || J(a.shape) !== J(b.shape)) bad.push(`${tag}${d.name}: dims ${J(a.dims)} vs ${J(b.dims)}`);
    else if (a.attrs.units !== b.attrs.units) bad.push(`${tag}${d.name}: units '${a.attrs.units}' vs '${b.attrs.units}'`);
    else if (!sameBits(a.data, b.data)) bad.push(`${tag}${d.name}: values ${firstDiff(a.data, b.data)} window ${short(J(d.window || null), 600)}`);
  }
  return bad;
}

// ============================================================ data files
const FILES = [
  { name: "darpa.nc", path: path.join(DATA_DIR, "darpa.nc"), count: 110 },
  { name: "sidebands.nc", path: path.join(DATA_DIR, "sidebands.nc"), count: 90 },
  { name: "fourd.nc", path: path.join(DATA_DIR, "fourd.nc"), count: 90 },
  { name: "powercal_hdf5.nc", path: path.join(DATA_DIR, "powercal_hdf5.nc"), count: 90 },
  { name: "powercal_nc3.nc", path: path.join(DATA_DIR, "powercal_nc3.nc"), count: 70 },
  { name: "snapshots.nc", path: path.join(DATA_DIR, "snapshots.nc"), count: 70 },
  // real lab files next to the repo (read-only; skipped when absent)
  { name: "V1550A_transmission_20260928_152746.nc", count: 70,
    path: path.join(REPO, "..", "data", "2026_09_25_V1550A_OpticalAttenuator_Characterization", "V1550A_transmission_20260928_152746.nc") },
  { name: "DL_TempTune_350mA.nc", count: 50,
    path: path.join(REPO, "..", "data", "2026_07_27_ESAresonator_test", "DL_TempTune_350mA.nc") },
];
// the derived array + tabs of a project saved by bc9812f (the lab's demo project)
const DEMO_DERIVED = JSON.parse(`[
  {"name":"peak","file":"darpa.nc","kind":"reduce","units":"","description":"tone power at the stimulus frequency","src":"spectrums","over":"TraceIndex","xsrc":"var:frequencies","window":{"mode":"relative","lo":null,"hi":null,"lo2":null,"hi2":null,"center":"coord:stimulusFrequency","k":1,"offset":0,"halfwidth":1000000,"halfwidth2":10000000},"region":"inside","stat":"max","db":"auto"},
  {"name":"floor","file":"darpa.nc","kind":"reduce","units":"","description":"","src":"spectrums","over":"TraceIndex","xsrc":"var:frequencies","window":{"mode":"relative","lo":null,"hi":null,"lo2":null,"hi2":null,"center":"coord:stimulusFrequency","k":1,"offset":0,"halfwidth":1000000,"halfwidth2":10000000},"region":"outside_within","stat":"mean","db":"auto"},
  {"name":"snr","file":"darpa.nc","kind":"combine","units":"","description":"","a":"peak","op":"-","b":"floor"},
  {"name":"peak_freq","file":"darpa.nc","kind":"reduce","units":"","description":"","src":"spectrums","over":"TraceIndex","xsrc":"var:frequencies","window":{"mode":"relative","lo":null,"hi":null,"lo2":null,"hi2":null,"center":"coord:stimulusFrequency","k":1,"offset":0,"halfwidth":1000000,"halfwidth2":10000000},"region":"inside","stat":"argmax_x","db":"auto"},
  {"name":"pump_peak","file":"sidebands.nc","kind":"reduce","units":"","description":"","src":"spectra_dbm","over":"wl","xsrc":"var:wl_nm","window":{"mode":"relative","lo":null,"hi":null,"lo2":null,"hi2":null,"center":"var:pump_nm","k":1,"offset":0,"halfwidth":0.02,"halfwidth2":0.5},"region":"inside","stat":"max","db":"auto"},
  {"name":"osa_floor","file":"sidebands.nc","kind":"reduce","units":"","description":"","src":"spectra_dbm","over":"wl","xsrc":"var:wl_nm","window":{"mode":"relative","lo":null,"hi":null,"lo2":null,"hi2":null,"center":"var:pump_nm","k":1,"offset":0,"halfwidth":0.02,"halfwidth2":0.5},"region":"outside_within","stat":"median","db":"auto"},
  {"name":"pump_mW","file":"sidebands.nc","kind":"transform","units":"","description":"","src":"pump_peak","fn":"db2lin","scale":1,"offset":0},
  {"name":"sa_pk","file":"powercal_hdf5.nc","kind":"reduce","units":"","description":"","src":"sa_trace","over":"sa_point","xsrc":"var:sa_freq","window":{"mode":"relative","lo":null,"hi":null,"lo2":null,"hi2":null,"center":"coord:frequency","k":1,"offset":0,"halfwidth":20000000,"halfwidth2":null},"region":"inside","stat":"max","db":"auto"},
  {"name":"sa_pk_mean","file":"powercal_hdf5.nc","kind":"reduce","units":"","description":"","src":"sa_pk","over":"sweep","xsrc":"index","window":{"mode":"none","lo":null,"hi":null,"lo2":null,"hi2":null,"center":"","k":1,"offset":0,"halfwidth":null,"halfwidth2":null},"region":"inside","stat":"mean","db":"auto"}
]`);
const DEMO_TABS = [
  ["darpa: peak, floor, SNR", { title: "DARPA: tone peak and noise floor vs stimulus frequency", xunit: "M" }, [
    ["darpa.nc", "peak", "stimulusFrequency", "stimulusAmp", { trace: 0 }, "coord"],
    ["darpa.nc", "floor", "stimulusFrequency", "stimulusAmp", { trace: 0 }, "coord"]]],
  ["darpa: SNR", { title: "SNR = peak − floor (stimulusAmp index 1)", xunit: "M" }, [
    ["darpa.nc", "snr", "stimulusFrequency", "trace", { stimulusAmp: 1 }, "coord"]]],
  ["darpa: spectra", { xunit: "M", lock_size: true }, [
    ["darpa.nc", "spectrums", "TraceIndex", "trace", { stimulusFrequency: 0, stimulusAmp: 1 }, "var:frequencies"]]],
  ["sidebands: OSA spectra", { mode: "Rainbow" }, [
    ["sidebands.nc", "spectra_dbm", "wl", "freq", {}, "var:wl_nm", "var:freq_Hz"]]],
  ["sidebands: pump power", { title: "Pump peak (max within pump_nm ± 0.02 nm)", xunit: "G" }, [
    ["sidebands.nc", "pump_peak", "freq", "", {}, "var:freq_Hz"], ["sidebands.nc", "pump_mW", "freq", "", {}, "var:freq_Hz"]]],
  ["powercal: SA peak & gain", { title: "SA peak (linear-power mean of 3 sweeps) and gain", xunit: "G" }, [
    ["powercal_hdf5.nc", "sa_pk_mean", "frequency", "vna_power", {}, "coord"],
    ["powercal_hdf5.nc", "gain", "frequency", "", { vna_power: 0 }, "coord"]]],
];
const mkTrace = ([file, v, line_dim, sweep, slices, xsrc, ssrc, visible]) =>
  ({ file, var: v, line_dim, sweep, slices, xsrc, label: v, sweep_label: "", ssrc: ssrc || "coord", yaxis: "left",
    visible: visible !== false, color: "", draw: "lines", lw: 1.5, dash: "auto" });
// an old-app state -> the .ncproj text bc9812f writes
function oldProjectText(files, derived, tabs) {
  return HP.projectText({
    fileOrder: files.slice(), wantedFiles: [], projectOrder: [], active: 0, derived,
    tabs: tabs.map(([name, plot, traces]) => ({ name, plotcfg: { ...X.DEFAULT_PLOTCFG, ...plot },
      traces: traces.map((t) => (Array.isArray(t) ? mkTrace(t) : t)), markers: [], cur: traces.length ? 0 : -1 })),
  });
}

// ============================================================ (a) + (b) per file
const projects = [];        // {name, text0 (as bc9812f saved it), stored defs, files, visible}
const oldResults = new Map();   // file -> Map(name -> {ok, dims, shape, units, data})
let nDefs = 0, nRel = 0, nFixed = 0, nNone = 0, nOther = 0;
const cov = new Proxy({}, { get: (o, k) => o[k] || 0 });     // what the generated legacy defs cover
const e3Bad = [], valBad = [], prevBad = [], rawBad = [], checkBad = [], depBad = [], longNames = [];

for (const [fi, F] of FILES.entries()) {
  if (!fs.existsSync(F.path)) { skip(`b: ${F.name}`, "data file missing"); continue; }
  const dsOld = await loadOld(F.path), dsNew = await loadDataset(F.path), dsRaw = await loadDataset(F.path);
  const r = rng(1000 + fi);
  let stored = genLegacy(dsOld, F.name, F.count, r, 1200);
  // chains around two ok reduce defs with a window (first pass on bc9812f)
  const st0 = H.registerDerived(dsOld, stored);
  const bases = stored.filter((d) => d.kind === "reduce" && d.window.mode !== "none" && st0.get(d.name).ok
    && ["max", "mean", "median", "min"].includes(d.stat));
  if (bases.length) stored = stored.concat(genChains(dsOld, F.name, bases[0], ""));
  if (bases.length > 3) stored = stored.concat(genChains(dsOld, F.name, bases[Math.floor(bases.length / 2)], " 2"));
  if (F.name === "darpa.nc" || F.name === "sidebands.nc" || F.name === "powercal_hdf5.nc") {
    // + the demo project's defs (renamed where they clash)
    const have = new Set(stored.map((d) => d.name));
    for (const d of DEMO_DERIVED) if (d.file === F.name && !have.has(d.name)) stored.push(asSaved(d));
  }
  stored = stored.slice(0, D.MAX_DERIVED);
  for (const d of stored) {
    nDefs++;
    if (d.kind !== "reduce") { nOther++; continue; }
    const w = d.window;
    cov[d.region]++; cov["db " + d.db]++;
    if (w.mode === "relative") {
      nRel++;
      const c = w.center, dim = c.startsWith("coord:") ? c.slice(6) : null;
      if (dim) cov[dsOld.vars[dim] ? "center coord: (coordinate var)" : "center coord: (no variable: index)"]++;
      else cov[`center var:${stored.some((x) => x.name === c.slice(4)) ? "<derived>" : "<variable>"}`]++;
      const cv = c.startsWith("var:") && dsOld.vars[c.slice(4)];
      if (cv && !cv.derived && Array.prototype.some.call(cv.data, (v) => v !== v)) cov["NaN centers"]++;
      if (w.k !== 1) cov["k != 1"]++;
      if (w.offset < 0) cov["offset < 0"]++; else if (w.offset > 0) cov["offset > 0"]++;
      if (w.halfwidth < 0) cov["halfwidth < 0"]++;
      if (w.halfwidth2 !== null) cov.halfwidth2++;
      if (e3Quote(c.replace(/^(coord|var):/, "")).startsWith('"')) cov["quoted name"]++;
    } else if (w.mode === "fixed") { nFixed++; if (w.lo > w.hi) cov["lo > hi"]++; if (w.lo === w.hi) cov["lo == hi"]++; if (w.lo2 !== null) cov["lo2/hi2"]++; }
    else nNone++;
  }

  // (a) E3 strings, three migrations
  for (const d of stored) {
    if (d.kind !== "reduce") continue;
    const want = J(e3(d.window));
    const s = D.sanitizeDef(d), c = D.canonicalDef(d), m = PY.migrateWindow(d.window);
    const got = { sanitize: s && J(s.window), canonical: J(c.window), report: J(m) };
    for (const [how, g] of Object.entries(got)) {
      if (g !== want) e3Bad.push(`${F.name}/${d.name} (${how}): got ${short(g, 700)} want ${short(want, 700)}`);
    }
    if (s && J(D.canonicalDef(s)) !== J(s)) e3Bad.push(`${F.name}/${d.name}: sanitizeDef output is not canonical`);
  }

  // (b) the numbers: bc9812f vs the project path (parse -> sanitize) vs raw legacy defs
  const text0 = oldProjectText([F.name], stored, [[F.name + " (all)", {}, stored.map((d) => [F.name, d.name, "", "", {}, "index", "coord", false])]]);
  const parsed = P.parseProject(text0);
  check(`b: ${F.name}: every one of ${stored.length} legacy defs survives parseProject`, parsed.derived.length === stored.length,
    stored.filter((d) => !parsed.derived.some((p) => p.name === d.name)).map((d) => d.name));
  const so = H.registerDerived(dsOld, stored);
  const sn = D.registerDerived(dsNew, parsed.derived);
  const sr = D.registerDerived(dsRaw, stored);           // unsanitized legacy defs straight into the engine
  valBad.push(...compareRegistered(stored, dsOld, so, dsNew, sn, F.name + "/"));
  rawBad.push(...compareRegistered(stored, dsNew, sn, dsRaw, sr, F.name + "/"));
  // the long_name attribute (info panel) is describeDef, which now shows the
  // expressions (E4): informational
  for (const d of stored) {
    const a = dsOld.vars[d.name], b = dsNew.vars[d.name];
    if (a && b && a.attrs.long_name !== b.attrs.long_name) longNames.push(`'${a.attrs.long_name}' -> '${b.attrs.long_name}'`);
  }
  const res = new Map();
  for (const d of stored) {
    const st = so.get(d.name), v = dsOld.vars[d.name];
    res.set(d.name, st.ok ? { ok: true, dims: v.dims, shape: v.shape, units: v.attrs.units, data: v.data } : { ok: false, error: st.error });
  }
  oldResults.set(F.name, res);
  const okN = [...so.values()].filter((s) => s.ok).length;
  info(`${F.name}: ${stored.length} legacy defs, ${okN} compute in bc9812f`);

  // previews (builder) at a few result positions + live checks of the migrated fields
  let pv = 0;
  for (const [i, d] of parsed.derived.entries()) {
    if (d.kind !== "reduce" || !sn.get(d.name).ok) continue;
    for (const f of ["lo", "hi", "lo2", "hi2", "center", "halfwidth", "halfwidth2"]) {
      const e = D.exprError(dsNew, d, f);
      if (e) checkBad.push(`${F.name}/${d.name}: exprError(${f}) = ${e}`);
    }
    if (D.validateDef(dsNew, d)) checkBad.push(`${F.name}/${d.name}: validateDef = ${D.validateDef(dsNew, d)}`);
    if (i % 5) continue;
    const rd = dsNew.vars[d.src].dims.filter((x) => x !== d.over);
    for (const pos of [{}, Object.fromEntries(rd.map((x, j) => [x, dsNew.dims[x] - 1 - (j % 2)]))]) {
      let po, pn;
      try { po = H.previewSlice(dsOld, stored[i], pos); } catch (e) { po = { err: e.message }; }
      try { pn = D.previewSlice(dsNew, d, pos); } catch (e) { pn = { err: e.message }; }
      pv++;
      const same = po.err || pn.err ? po.err === pn.err
        : sameBits(po.x, pn.x) && sameBits(po.y, pn.y) && sameBits(po.member, pn.member)
          && sameNums(po.inner || [], pn.inner || []) && !po.inner === !pn.inner
          && sameNums(po.outer || [], pn.outer || []) && !po.outer === !pn.outer
          && sameNums([po.center ?? -1.5], [pn.center ?? -1.5]) && sameBits([po.value], [pn.value])
          && po.count === pn.count && po.db === pn.db;
      if (!same) prevBad.push(`${F.name}/${d.name} @${J(pos)}: old ${short(J({ i: po.inner, o: po.outer, c: po.center, v: po.value, n: po.count, e: po.err }))}`
        + ` new ${short(J({ i: pn.inner, o: pn.outer, c: pn.center, v: pn.value, n: pn.count, e: pn.err }))}`);
    }
  }

  // which defs a report of this project needs: bc9812f's report vs the new one
  {
    const oldP = JSON.parse(text0), newP = JSON.parse(P.projectText(stateFrom(parsed)));
    const a = HPY.neededDerived(oldP).map((d) => d.name).sort(), b = PY.neededDerived(newP).map((d) => d.name).sort();
    if (J(a) !== J(b)) depBad.push(`${F.name}: neededDerived old ${a.length} [${a.filter((x) => !b.includes(x))}] vs new ${b.length} [${b.filter((x) => !a.includes(x))}]`);
  }
  projects.push({ name: F.name, text0, stored, files: [F] });
  info(`${F.name}: ${pv} previews compared`);
}
info(`legacy defs: ${nDefs} (${nRel} relative, ${nFixed} fixed, ${nNone} none, ${nOther} combine/transform); `
  + Object.keys(cov).sort().map((k) => `${k}: ${cov[k]}`).join(", "));
check(`a: migrated windows follow E3 exactly (sanitizeDef, canonicalDef, pyexport.migrateWindow)`, e3Bad.length === 0,
  `${e3Bad.length}: ${short(e3Bad.slice(0, 4).join(" | "), 3000)}`);
check(`b: ${nDefs} legacy defs: bc9812f == migrated (status, dims, units, values bitwise)`, valBad.length === 0,
  `${valBad.length}: ${short(valBad.slice(0, 6).join(" | "), 4000)}`);
check("b: unsanitized legacy defs compute exactly as the sanitized ones (canonicalDef path)", rawBad.length === 0,
  `${rawBad.length}: ${short(rawBad.slice(0, 4).join(" | "), 2000)}`);
check("b: previews of legacy defs == bc9812f previews (x, y, members, bounds, center, value, count)", prevBad.length === 0,
  `${prevBad.length}: ${short(prevBad.slice(0, 4).join(" | "), 3000)}`);
check("b: migrated defs that compute pass validateDef / exprError", checkBad.length === 0,
  `${checkBad.length}: ${short(checkBad.slice(0, 4).join(" | "), 2000)}`);
check("b: a report needs the same derived defs as in bc9812f (neededDerived)", depBad.length === 0, depBad.join(" | "));
if (longNames.length) info(`long_name (= describeDef, shown in the info panel) changed for ${longNames.length} defs, e.g. ${short(longNames.slice(0, 2).join(" | "), 400)}`);
{
  // legacy detection by "coord:"/"var:" text (E3) also fires on a NEW window in
  // mode none: every typed expression of the window is cleared
  const w = { mode: "none", lo: "", hi: "", lo2: "", hi2: "", center: "var:stimulusFrequency",
    halfwidth: "0.01*stimulusFrequency", halfwidth2: "3*ResolutionBWs" };
  const c = D.canonicalDef({ ...D.newDef("reduce", "darpa.nc"), name: "x", window: w }).window;
  if (c.halfwidth !== w.halfwidth) info(`a mode-none window whose center text starts with 'var:' is taken for a legacy one: `
    + `${J(w)} -> ${J(c)} (the typed expressions are lost)`);
}

// ============================================================ (c) projects
// the demo project (as bc9812f wrote it), plus NCX_DEMO_PROJ verbatim
{
  const demoText = oldProjectText(["darpa.nc", "sidebands.nc", "powercal_hdf5.nc"], DEMO_DERIVED, DEMO_TABS);
  projects.push({ name: "demo (embedded)", text0: demoText, stored: DEMO_DERIVED, files: FILES.filter((f) => /^(darpa|sidebands|powercal_hdf5)\.nc$/.test(f.name)), visible: true });
  const dp = process.env.NCX_DEMO_PROJ;
  if (dp && fs.existsSync(dp)) {
    const t = fs.readFileSync(dp, "utf8");
    const raw = JSON.parse(t);
    projects.push({ name: "NCX_DEMO_PROJ " + path.basename(dp), text0: t, stored: raw.derived || [],
      files: FILES.filter((f) => (raw.files || []).includes(f.name)), visible: true });
  } else skip("c: NCX_DEMO_PROJ verbatim", "set NCX_DEMO_PROJ to a .ncproj saved by bc9812f");
}
for (const pr of projects) {
  const tag = `c: ${pr.name}`;
  const p0 = P.parseProject(pr.text0);
  const t1 = P.projectText(stateFrom(p0));
  const t2 = P.projectText(stateFrom(P.parseProject(t1)));
  check(`${tag}: old file -> load -> save -> load -> save is byte-identical`, strip(t1) === strip(t2));
  const o0 = JSON.parse(pr.text0), o1 = JSON.parse(t1);
  delete o0.created; delete o1.created;
  const d0 = o0.derived || [], d1 = o1.derived || [];
  delete o0.derived; delete o1.derived;
  check(`${tag}: everything but the derived windows is unchanged by load + save`, J(o0) === J(o1));
  const bad = [];
  if (d0.length !== d1.length) bad.push(`count ${d0.length} -> ${d1.length}`);
  d0.forEach((d, i) => {
    const n = d1[i] || {};
    const want = d.kind === "reduce" ? { ...d, window: e3(d.window) } : d;
    const keys = Object.keys(D.newDef(d.kind, "")).join(",");
    if (J(n) !== J(want)) bad.push(`${d.name}: ${short(J(n), 500)} != ${short(J(want), 500)}`);
    else if (Object.keys(n).join(",") !== keys) bad.push(`${d.name}: key order ${Object.keys(n)}`);
  });
  check(`${tag}: saved derived defs = the old ones with E3 windows (canonical keys, no k/offset)`, bad.length === 0, bad.slice(0, 3).join(" | "));
  // forward compatibility (informational): the deployed app reading the new file
  const back = HP.parseProject(t1);
  if (back.derived.length !== d0.length) {
    info(`${tag}: bc9812f re-opening the NEW file keeps ${back.derived.length} of ${d0.length} derived defs `
      + `(dropped: ${short(d0.filter((d) => !back.derived.some((b) => b.name === d.name)).map((d) => d.name).join(", "), 200)})`);
  }
}
// real lab projects (no derived defs) and the desktop v1 project: the new
// project.js writes exactly what bc9812f wrote, and round-trips
{
  const found = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p); else if (/\.ncproj$/i.test(e.name)) found.push(p);
    }
  };
  walk(DATA_DIR); walk(path.join(REPO, "..", "data"));
  if (!found.length) skip("c: real projects", "none found");
  for (const f of found) {
    const t = fs.readFileSync(f, "utf8"), rel = path.relative(REPO, f);
    const a = strip(P.projectText(stateFrom(P.parseProject(t))));
    const b = strip(HP.projectText(stateFrom(HP.parseProject(t))));
    check(`c: ${rel}: saved exactly as bc9812f saves it`, a === b);
    check(`c: ${rel}: round-trips byte-identically`, a === strip(P.projectText(stateFrom(P.parseProject(a)))));
  }
}

// ============================================================ (e) synthetic + hostile legacy input
// one synthetic file with what the lab files lack: time units on the x
// variable and on a center, a dim without a variable, a CHARACTER variable
// named like a dim (CF labels), a NUMERIC non-coordinate variable named like a
// dim (legal in netCDF-3), permuted dims, Float32 / Int32 data, a scalar, NaN
// centers, huge values, odd names
const LONG = "L" + "x".repeat(255);              // 256 characters (the name cap)
function synth(opts) {
  const sz = { t: 4, q: 3, g: 2, s2: 3, h: 2, f: 24 };
  const V = {};
  const n = (dims) => dims.reduce((p, d) => p * sz[d], 1);
  const add = (name, dims, data, units, extra) => {
    V[name] = { dims, shape: dims.map((d) => sz[d]), attrs: units ? { units } : {}, dtype: "double", numeric: true, data, ...(extra || {}) };
  };
  const spec = new Float64Array(n(["t", "q", "g", "h", "f"]));
  for (let i = 0; i < spec.length; i++) spec[i] = (i % 97 === 5) ? NaN : -60 + ((i * 7919) % 41) * 0.5 + ((i % 24) === 11 ? 25 : 0);
  add("spec", ["t", "q", "g", "h", "f"], spec, "dBm");
  const fx = new Float64Array(n(["t", "q", "f"]));
  for (let i = 0; i < fx.length; i++) fx[i] = (i % 61 === 7) ? NaN : 1000 * ((i % 24) * 10 + Math.floor(i / 24) % 3);   // ms
  add("fx", ["t", "q", "f"], fx, "milliseconds");
  add("f", ["f"], Float64Array.from({ length: 24 }, (_, i) => 1e6 + i * 2.5e5), "Hz");
  add("t", ["t"], Int32Array.from([0, 5, 10, 15]), "minutes");
  add("cen", ["g", "t"], Float64Array.from([40e9, NaN, 90e9, 120e9, 60e9, 75e9, NaN, 200e9]), "ns");
  add("cenp", ["h", "q"], Float64Array.from([20, 40, 60, 80, 100, 120]), "s");
  add("h", ["q", "h"], Float64Array.from([5, 16, 27, 38, 49, 60]), "");            // NOT h's coordinate
  add("g", ["g", "s2"], ["a", "b", "c", "d", "e", "f"], "", { dtype: "char", numeric: false, isChar: true });
  add("big", ["t"], Float64Array.from([1e308, -1.7e308, 50, 1.7e308]), "");
  add('a"b', ["t"], Float64Array.from([20, 30, 40, 50]), "");
  add(LONG, ["t"], Float64Array.from([20, 30, 40, 50]), "");
  add("pi", ["t"], Float64Array.from([25, 35, 45, 55]), "");
  add("floor", ["q"], Float64Array.from([60, 120, 180]), "");
  add("noise floor", ["t"], Float64Array.from([10, 70, 130, 190]), "");
  add("3x", ["g"], Float64Array.from([33, 66]), "");
  add("max", ["g", "h"], Float64Array.from([10, 20, 30, 40]), "");
  add("f32", ["t"], Float32Array.from([12.1, 55.3, 101.7, 230.9]), "");
  add("scal", [], Float64Array.from([95]), "");
  add("e", ["q"], Float64Array.from([1, 2, 3]), "");
  if (opts && opts.noPi) delete V.pi;
  return new Dataset({ dims: sz, attrs: {}, coords: new Set(["f", "t"]), variables: V }, "synth.nc");
}
{
  const ds0 = synth();
  const r = rng(77);
  let stored = genLegacy(ds0, "synth.nc", 220, r, 100000).filter((d) => d.src === "spec" || r() < 0.3);
  const so0 = H.registerDerived(ds0, stored);
  const base = stored.find((d) => d.window.mode !== "none" && d.src === "spec" && so0.get(d.name).ok && d.stat === "max");
  if (base) stored = stored.concat(genChains(ds0, "synth.nc", base, ""));
  stored = stored.slice(0, D.MAX_DERIVED);
  const dsO = synth(), dsN = synth();
  const so = H.registerDerived(dsO, stored), sn = D.registerDerived(dsN, stored.map((d) => D.sanitizeDef(d)));
  const bad = compareRegistered(stored, dsO, so, dsN, sn, "");
  const okBoth = stored.filter((d) => so.get(d.name).ok && sn.get(d.name).ok).length;
  check(`e: synthetic file: ${stored.length} legacy defs (${okBoth} ok): bc9812f == migrated`, bad.length === 0,
    `${bad.length}: ${short(bad.slice(0, 8).join(" | "), 5000)}`);
  const e3s = stored.filter((d) => d.kind === "reduce" && J(D.sanitizeDef(d).window) !== J(e3(d.window)));
  check("e: synthetic file: migrated windows follow E3 exactly", e3s.length === 0,
    e3s.slice(0, 3).map((d) => `${d.name}: ${short(J(D.sanitizeDef(d).window), 500)} vs ${short(J(e3(d.window)), 500)}`).join(" | "));
}

// targeted cases (each a minimal repro): raw def -> bc9812f vs the working tree
{
  const R = (name, window, o) => ({ kind: "reduce", name, file: "synth.nc", src: "spec", over: "f", xsrc: "var:fx",
    window, region: "inside", stat: "count", db: "auto", ...(o || {}) });
  const rel = (center, hw, o) => ({ mode: "relative", center, halfwidth: hw, ...(o || {}) });
  // [label, defs (the last one is compared), must match exactly (true) | informational (false)]
  const cases = [
    ["center coord:t (Int32 'minutes' coordinate -> seconds)", [R("c1", rel("coord:t", 30, { k: 1000, offset: 100 }))], true],
    ["center var:cen (ns -> s, NaN centers)", [R("c2", rel("var:cen", 15))], true],
    ["center var:cenp (dims in another order)", [R("c3", rel("var:cenp", 25, { k: 1000 }), { stat: "mean", region: "outside" })], true],
    ["center coord:q (dim without a variable -> index)", [R("c4", rel("coord:q", 50, { k: 100, offset: 40 }))], true],
    ["center coord:g (CHARACTER variable named like the dim -> index)", [R("c5", rel("coord:g", 60, { k: 100, offset: 20 }))], true],
    ["center var:f32 (Float32 data)", [R("c6", rel("var:f32", 20), { stat: "max" })], true],
    ["center var:scal (0-D)", [R("c7", rel("var:scal", 40), { stat: "integral" })], true],
    ["center var:pi (a VARIABLE named pi)", [R("c8", rel("var:pi", 20))], true],
    ["center var:floor (a variable named like a function)", [R("c9", rel("var:floor", 20, { k: 1 / 3 }))], true],
    ["center 'var:noise floor' (space)", [R("c10", rel("var:noise floor", 20))], true],
    ["center var:3x (starts with a digit)", [R("c11", rel("var:3x", 20))], true],
    ["center var:max (function name, 2-D)", [R("c12", rel("var:max", 20, { k: 3, offset: -5 }))], true],
    ["center var:e (the exponent letter)", [R("c13", rel("var:e", 20, { k: 60, offset: 1e-7 }))], true],
    ["k = -0 / offset = -0 / halfwidth = -0", [R("c14", rel("var:cen", -0, { k: -0, offset: -0 }), { region: "outside" })], true],
    ["k tiny, offset huge / tiny (exponent texts)", [R("c15", rel("var:cen", 1e-300, { k: 5e-324, offset: 1.5e-7 }))], true],
    ["fixed window at +-1.7e308", [R("c16", { mode: "fixed", lo: -1.7976931348623157e308, hi: 1.7976931348623157e308 })], true],
    ["fixed, lo2 > hi2, outside_within", [R("c17", { mode: "fixed", lo: 50, hi: 10, lo2: 230, hi2: -5 }, { region: "outside_within", stat: "sum" })], true],
    // --- the cases below were found by this test
    ["OVERFLOW: center 1e308 + half width 1e308 = Inf (bc9812f still used the window [0, Inf])",
      [R("v1", rel("var:big", 1e308))], true],
    ["OVERFLOW: outer span overflows (outside_within)",
      [R("v1b", rel("var:big", 1, { halfwidth2: 1.7e308 }), { region: "outside_within" })], true],
    ['QUOTE: a center variable whose name contains a double quote (a"b)', [R("v2", rel('var:a"b', 15))], true],
    ["LONG NAME: 256-char center variable, center text > 300 chars is cut: offset 1.23e-7 becomes 1.23",
      [R("v3", rel("var:" + LONG, 0.5, { k: -1.2345678901234567e-7, offset: 1.2345678901234567e-7 }), { stat: "argmin_x" })], true],
    ["LONG NAME: the cut leaves an invalid number", [R("v3b", rel("var:" + LONG, 0.5, { k: -0.30000000000000004, offset: -1.2345678901234567e-7 }))], true],
    ["NON-COORDINATE VARIABLE named like the dim (coord:h; var h has dims [q, h]): other numbers",
      [R("v4", rel("coord:h", 12))], true],
    ["NON-COORDINATE VARIABLE named like the dim, result without q: now an error",
      [R("v4b", rel("coord:h", 1), { src: "max", over: "g", xsrc: "index" })], true],
    ["a FAILED def named pi + a center var:pi (file without a variable pi)",
      [R("pi", { mode: "none" }, { src: "nosuch" }), R("v5", rel("var:pi", 20))], true, { noPi: true }],
    ["center var:q (a dim, no variable): bc9812f refused it", [R("i1", rel("var:q", 30, { k: 100 }))], false],
    ["center coord:big (not a dim): bc9812f refused it", [R("i2", rel("coord:big", 30))], false],
    ["unused center var:<failed def> in a FIXED window", [R("bad1", { mode: "none" }, { src: "nosuch" }),
      R("i3", { mode: "fixed", lo: 0, hi: 100e3, center: "var:bad1" })], false],
    ["unused center closes a cycle", [{ kind: "combine", name: "i4b", file: "synth.nc", a: "i4", op: "+", b: 1 },
      R("i4", { mode: "fixed", lo: 0, hi: 100e3, center: "var:i4b" })], false],
  ];
  for (const [label, defs, strict, dsOpts] of cases) {
    const stored = defs.map(asSaved);
    if (stored.some((d) => !d)) { check(`e: ${label}`, false, "bc9812f rejects the def"); continue; }
    const dsO = synth(dsOpts), dsN = synth(dsOpts);
    const so = H.registerDerived(dsO, stored);
    const migrated = stored.map((d) => D.sanitizeDef(d));
    const sn = D.registerDerived(dsN, migrated.filter(Boolean));
    const last = stored[stored.length - 1];
    const bad = migrated.some((m) => !m) ? ["sanitizeDef rejects it"] : compareRegistered([last], dsO, so, dsN, sn, "");
    const w = migrated[migrated.length - 1] && migrated[migrated.length - 1].window;
    const msg = `${label}: ${bad.join("; ")} | migrated ${short(J(w), 420)}`;
    if (strict) check(`e: ${label}`, bad.length === 0, msg);
    else if (bad.length) info(`changed vs bc9812f (old error -> now computes): ${msg}`);
  }
  // preview of k*c + 0 at c = 0 with k < 0: bc9812f's center is +0, now -0
  // (k*c); the same window, only the sign of a zero differs
  const lp = asSaved(R("pz", rel("coord:q", 0, { k: -1, offset: 0 }), { stat: "max" }));
  const po = H.previewSlice(synth(), lp, { q: 0 }), pn = D.previewSlice(synth(), D.sanitizeDef(lp), { q: 0 });
  check("e: preview of a legacy window, center k*c + 0 = 0 (k < 0): same bounds and value",
    sameNums([po.center], [pn.center]) && sameNums(po.inner, pn.inner) && sameBits([po.value], [pn.value]) && sameBits(po.member, pn.member));
  if (!Object.is(po.center, pn.center)) info(`preview center of k*c + 0 at c = 0, k = -1: bc9812f ${Object.is(po.center, -0) ? "-0" : po.center}, now ${Object.is(pn.center, -0) ? "-0" : pn.center} (sign of zero only)`);
}

// hostile legacy windows as found in a project file: bc9812f and the working
// tree must accept / reject the same ones, and compute accepted ones identically
{
  const base = { kind: "reduce", name: "h", file: "synth.nc", src: "spec", over: "f", xsrc: "var:fx", region: "inside", stat: "max", db: "auto" };
  const W = [
    { mode: "relative", center: "var:cen", k: NaN, offset: 0, halfwidth: 20 },
    { mode: "relative", center: "var:cen", k: "2", offset: "5", halfwidth: 20 },
    { mode: "relative", center: "var:cen", k: null, offset: null, halfwidth: 20 },
    { mode: "relative", center: "var:cen", k: Infinity, offset: -Infinity, halfwidth: 20 },
    { mode: "relative", center: "var:cen", k: true, offset: [1], halfwidth: 20 },
    { mode: "relative", center: "coord:", halfwidth: 20 },
    { mode: "relative", center: "var:", halfwidth: 20 },
    { mode: "relative", center: "", halfwidth: 20 },
    { mode: "relative", halfwidth: 20 },
    { mode: "relative", center: "COORD:t", halfwidth: 20 },
    { mode: "relative", center: " var:cen", halfwidth: 20 },
    { mode: "relative", center: 5, halfwidth: 20 },
    { mode: "relative", center: null, halfwidth: 20 },
    { mode: "relative", center: { a: 1 }, halfwidth: 20 },
    { mode: "relative", center: "var:cen", halfwidth: "20" },
    { mode: "relative", center: "var:cen", halfwidth: null },
    { mode: "relative", center: "var:cen", halfwidth: 20, halfwidth2: "x" },
    { mode: "relative", center: "var:cen", halfwidth: "0.01*cen" },
    { mode: "relative", center: "var:" + "y".repeat(400), halfwidth: 20 },
    { mode: "relative", center: "var:__proto__", halfwidth: 20 },
    { mode: "relative", center: "coord:constructor", halfwidth: 20 },
    { mode: "relative", center: "var:toString", k: 2, halfwidth: 20 },
    { mode: "fixed", lo: "10", hi: 20 },
    { mode: "fixed", lo: 10 },
    { mode: "fixed", lo: 10, hi: 20, lo2: 5 },
    { mode: "fixed", lo: true, hi: 20 },
    { mode: "fixed", lo: 10, hi: 20, center: "var:cen", k: 2, offset: 3, halfwidth: 1 },
    { mode: "Fixed", lo: 10, hi: 20 },
    { mode: "relative ", center: "var:cen", halfwidth: 1 },
    { mode: "RELATIVE", center: "var:cen", halfwidth: 1 },
    { mode: null, lo: 1, hi: 2 },
    { mode: 3 },
    { mode: "none", lo: 1, hi: 2, center: "coord:t", k: 9, offset: 9, halfwidth: 1 },
    { lo: 1, hi: 2 },
    { k: 2 },
    {},
    JSON.parse('{"__proto__": {"mode": "fixed"}, "mode": "fixed", "lo": 1, "hi": 2}'),
    JSON.parse('{"mode": "relative", "center": "var:cen", "halfwidth": 5, "constructor": 1, "toString": 2}'),
  ];
  const rejectDiff = [], valueDiff = [], memDiff = [], throws = [], reportDiff = [];
  for (const [i, w] of W.entries()) {
    for (const region of ["inside", "outside_within"]) {
      const raw = { ...base, name: `h${i}`, window: w, region };
      const label = `#${i} ${short(J(w), 120)} ${region}`;
      const so = H.sanitizeDef(raw), sn = D.sanitizeDef(raw);
      if (!so !== !sn) { rejectDiff.push(`${label}: bc9812f ${so ? "accepts" : "rejects"}, now ${sn ? "accepts" : "rejects"}`); }
      if (so && sn) {
        let a, b;
        try { a = H.computeDef(synth(), so).data; } catch (e) { a = "ERR " + e.message; }
        try { b = D.computeDef(synth(), sn).data; } catch (e) { b = "ERR " + e.message; }
        const okA = typeof a !== "string", okB = typeof b !== "string";
        if (okA !== okB || (okA && !sameBits(a, b))) valueDiff.push(`${label}: old ${okA ? "values" : a} / new ${okB ? (okA ? firstDiff(a, b) : "values") : b}`);
        // the report's own migration of the same window
        const m = PY.migrateWindow(w);
        if (J(m) !== J(sn.window)) reportDiff.push(`${label}: app ${short(J(sn.window), 200)} vs report ${short(J(m), 200)}`);
      }
      // in-memory (never sanitized) def: bc9812f vs now
      let a, b;
      try { a = H.computeDef(synth(), raw).data; } catch (e) { a = "ERR " + e.message; }
      try { b = D.computeDef(synth(), raw).data; } catch (e) { b = "ERR " + e.message; }
      const okA = typeof a !== "string", okB = typeof b !== "string";
      if (okA !== okB || (okA && !sameBits(a, b))) memDiff.push(`${label}: old ${okA ? "values" : a} / new ${okB ? "values" : b}`);
      // no API may throw on it
      for (const [fn, call] of [["canonicalDef", () => D.canonicalDef(raw)], ["describeDef", () => D.describeDef(raw)],
        ["depsOf", () => D.depsOf(raw)], ["validateDef", () => D.validateDef(synth(), raw)],
        ["exprError", () => D.exprError(synth(), raw, "center")], ["exprValueAt", () => D.exprValueAt(synth(), raw, "center", {})],
        ["renameRef", () => D.renameRef(JSON.parse(J(raw)), "cen", "cen2")], ["topoOrder", () => D.topoOrder([raw])],
        ["report migrateWindow", () => PY.migrateWindow(w)]]) {
        try { call(); } catch (e) { throws.push(`${fn}(${label}): ${e.message}`); }
      }
    }
  }
  check("e: hostile legacy windows: bc9812f and now accept / reject the same ones", rejectDiff.length === 0, rejectDiff.join(" | "));
  check("e: hostile legacy windows: accepted ones compute identically", valueDiff.length === 0, valueDiff.join(" | "));
  check("e: hostile legacy windows: no API throws", throws.length === 0, throws.slice(0, 5).join(" | "));
  if (memDiff.length) info(`in-memory (unsanitized) hostile defs that changed (${memDiff.length}): ${short(memDiff.join(" | "), 1500)}`);
  if (reportDiff.length) info(`pyexport.migrateWindow differs from the app's sanitizeDef on accepted hostile windows (${reportDiff.length}): ${short(reportDiff.join(" | "), 1500)}`);
  // whole project files with hostile JSON: same derived defs survive in both versions
  const txt = J({ format: "nc_explorer_project_v2", tabs: [{ traces: [] }],
    derived: W.map((w, i) => ({ ...base, name: `p${i}`, window: w })) });
  const a = HP.parseProject(txt).derived.map((d) => d.name), b = P.parseProject(txt).derived.map((d) => d.name);
  check("e: hostile project file: the same derived defs survive parseProject", J(a) === J(b), { bc9812f: a, now: b });
}

// ============================================================ (d) Python report script
function runPy(args, opts = {}) {
  const r = spawnSync(PYTHON, args, { encoding: "utf8", timeout: 600000, maxBuffer: 256 << 20, ...opts });
  return { status: r.status, out: (r.stdout || "") + (r.stderr || ""), error: r.error };
}
const pyOk = (() => { const r = runPy(["-c", "import numpy, xarray, matplotlib; print('ok')"]); return r.status === 0 && r.out.includes("ok"); })();
// a --dump-derived value (null = NaN) vs a JS value: numpy may sum in another
// order, so rel 1e-9
const jsNum = (v) => (Number.isFinite(v) ? v : null);
const near = (a, b) => (a === null || b === null ? a === b : a === b || Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b)));
const about = (d) => (d.kind === "reduce" ? `${d.src} over ${d.over}, ${d.stat}, ${d.region}, db ${d.db}, x ${d.xsrc}, window ${short(J(d.window), 300)}` : d.kind);
// how a dumped entry differs from bc9812f's JS result ("" = it does not)
function vsJs(e, res) {
  if (!e) return res.ok ? "not computed (bc9812f JS computes it)" : "";
  if (!res.ok) return "computed (bc9812f JS fails: " + res.error + ")";
  if (J(e.dims) !== J(res.dims)) return `dims ${J(e.dims)} vs ${J(res.dims)}`;
  if (e.units !== res.units) return `units '${e.units}' vs '${res.units}'`;
  const k = e.data.findIndex((v, i) => !near(v, jsNum(res.data[i])));
  return k < 0 ? "" : `[${k}] script ${e.data[k]} vs JS ${res.data[k]}`;
}
if (!pyOk) skip("d: Python report script", `no usable Python (${PYTHON}) with numpy, xarray, matplotlib`);
else {
  const dataDir = path.join(TMP, "data");
  fs.mkdirSync(dataDir);
  for (const F of FILES) if (fs.existsSync(F.path)) fs.copyFileSync(F.path, path.join(dataDir, F.name));
  const pyDump = (script, tag) => {
    const sp = path.join(TMP, tag + ".py"), out = path.join(TMP, tag + ".json");
    fs.writeFileSync(sp, script);
    const r = runPy([sp, "--data-dir", dataDir, "--out", path.join(TMP, tag + ".pdf"), "--dump-derived", out]);
    if (r.status !== 0 || !fs.existsSync(out)) return { err: `exit ${r.status}: ${short(r.out, 1500)}` };
    return { dump: JSON.parse(fs.readFileSync(out, "utf8")), log: r.out };
  };
  const newDumps = new Map();   // "project#\0file\0name" -> entry dumped by the new script (migrated CONFIG)
  const preExisting = [];       // script-vs-JS differences that bc9812f's own script has too
  let firstScript = null;
  for (const [pi, pr] of projects.entries()) {
    if (!pr.files.length || pr.files.some((f) => !fs.existsSync(f.path))) { skip(`d: ${pr.name}`, "data missing"); continue; }
    const tag = `d: ${pr.name}`;
    const oldProj = JSON.parse(pr.text0);
    const newProj = JSON.parse(P.projectText(stateFrom(P.parseProject(pr.text0))));
    const opts = { generatedAt: "2026-10-02T00:00:00Z", source: pr.name };
    const sNew = PY.buildReportScript(newProj, opts), sOld = HPY.buildReportScript(oldProj, opts);
    if (!firstScript) firstScript = sNew;
    const nw = pyDump(sNew, `new${pi}`), od = pyDump(sOld, `old${pi}`);
    if (!check(`${tag}: the new script runs (--dump-derived)`, !nw.err, nw.err) || !check(`${tag}: bc9812f's script runs`, !od.err, od.err)) continue;
    // bc9812f JS results of this project's defs
    const jsRes = new Map();
    for (const F of pr.files) {
      const mine = pr.stored.filter((d) => d.file === F.name);
      if (!pr.visible && oldResults.has(F.name)) { for (const d of mine) jsRes.set(F.name + "\0" + d.name, oldResults.get(F.name).get(d.name)); continue; }
      const ds = await loadOld(F.path);
      const st = H.registerDerived(ds, mine.map(asSaved));
      for (const d of mine) {
        const s = st.get(d.name), v = ds.vars[d.name];
        jsRes.set(F.name + "\0" + d.name, s && s.ok ? { ok: true, dims: v.dims, shape: v.shape, units: v.attrs.units, data: v.data } : { ok: false, error: s && s.error });
      }
    }
    const needNew = PY.neededDerived(newProj).map((d) => d.file + "\0" + d.name);
    const needOld = HPY.neededDerived(oldProj).map((d) => d.file + "\0" + d.name);
    check(`${tag}: the report computes the same derived defs as bc9812f's`, J(needNew.slice().sort()) === J(needOld.slice().sort()));
    const reg = [], vsOld = [];
    for (const key of needNew) {
      const [file, name] = key.split("\0");
      const d = pr.stored.find((x) => x.file === file && x.name === name);
      const n = nw.dump[file] && nw.dump[file][name], o = od.dump[file] && od.dump[file][name];
      if (n) newDumps.set(pi + "\0" + key, n);
      if (!!n !== !!o) vsOld.push(`${name}: bc9812f script ${o ? "computes" : "fails"}, new ${n ? "computes" : "fails"}`);
      else if (n && J(n) !== J(o)) {
        const k = n.data.findIndex((v, i) => v !== o.data[i]);
        vsOld.push(`${name}: [${k}] new ${n.data[k]} vs bc9812f ${o.data[k]} (${about(d)})`);
      }
      const res = jsRes.get(key);
      if (!res) continue;
      const dn = vsJs(n, res), dold = vsJs(o, res);
      if (dn && !dold) reg.push(`${name}: ${dn} (${about(d)})`);
      else if (dn) preExisting.push(`${file}/${name}: ${dn} (${about(d)})`);
    }
    check(`${tag}: new script == bc9812f's script (${needNew.length} defs, exact)`, vsOld.length === 0, `${vsOld.length}: ${short(vsOld.slice(0, 5).join(" | "), 2500)}`);
    check(`${tag}: new script == bc9812f JS wherever bc9812f's script was`, reg.length === 0, `${reg.length}: ${short(reg.slice(0, 5).join(" | "), 2500)}`);
  }
  if (preExisting.length) info(`script vs JS differences already in bc9812f (not regressions), ${preExisting.length}: ${short(preExisting.join(" | "), 2500)}`);
  // the script's own legacy path (a hand-edited CONFIG with old windows):
  // migrate_window follows E3, and compute_derived on the LEGACY defs gives
  // exactly what the script computes for the migrated ones
  if (firstScript) {
    const sp = path.join(TMP, "probe_script.py"), drv = path.join(TMP, "probe.py");
    const rq = path.join(TMP, "probe_in.json"), ro = path.join(TMP, "probe_out.json");
    fs.writeFileSync(sp, firstScript);
    fs.writeFileSync(drv, [
      "import json, runpy, sys",
      "g = runpy.run_path(sys.argv[1], run_name='ncx_compat_probe')",
      "req = json.load(open(sys.argv[2], encoding='utf-8'))",
      "out = {'migrate': [g['migrate_window'](w) for w in req['windows']], 'derived': {}}",
      "files = dict((n, g['DataFile'](n, p)) for n, p in req['files'].items())",
      "for group in req['groups']:",
      "    status = g['compute_derived'](files, group, lambda m: None)",
      "    for (fname, name), err in status.items():",
      "        if err is None:",
      "            v = files[fname].var(name)",
      "            out['derived'][fname + '\\u0000' + name] = {'dims': list(v.dims), 'shape': list(v.data.shape),",
      "                                                    'units': v.units, 'data': g['_json_list'](v.data)}",
      "json.dump(out, open(sys.argv[3], 'w', encoding='utf-8'))",
      "",
    ].join("\n"));
    const files = {};
    for (const F of FILES) if (fs.existsSync(F.path)) files[F.name] = path.join(dataDir, F.name);
    const gp = projects.map((p, i) => [i, p]).filter(([, p]) => !p.visible);
    const groups = gp.map(([, p]) => p.stored.filter((d) => files[d.file]));
    const windows = groups.flat().filter((d) => d.kind === "reduce").map((d) => d.window);
    fs.writeFileSync(rq, J({ windows, files, groups }));
    const r = runPy([drv, sp, rq, ro]);
    if (check("d: the script's legacy probe runs", r.status === 0, short(r.out, 1500))) {
      const out = JSON.parse(fs.readFileSync(ro, "utf8"));
      const mb = [];
      windows.forEach((w, i) => { if (J(out.migrate[i]) !== J(e3(w))) mb.push(`${short(J(w), 300)} -> ${short(J(out.migrate[i]), 300)}`); });
      check(`d: script migrate_window follows E3 (${windows.length} windows)`, mb.length === 0, `${mb.length}: ${short(mb.slice(0, 3).join(" | "), 2000)}`);
      const vb = [];
      groups.forEach((g, j) => {
        for (const d of g) {
          const key = d.file + "\0" + d.name, a = out.derived[key], b = newDumps.get(gp[j][0] + "\0" + key);
          if (J(a) !== J(b)) vb.push(`${d.file}/${d.name}: legacy ${short(J(a), 150)} vs migrated ${short(J(b), 150)}`);
        }
      });
      check(`d: script with LEGACY defs in CONFIG == script with the migrated ones (${groups.flat().length} defs, exact)`,
        vb.length === 0, `${vb.length}: ${short(vb.slice(0, 5).join(" | "), 2000)}`);
    }
  }
}

done();
