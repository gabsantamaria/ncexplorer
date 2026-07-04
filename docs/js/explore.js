// explore.js — the pure trace/slicing/scaling logic, ported faithfully from the
// tested Python NC_Explorer (trace_lines, unit prefixes, auto labels, lab-format
// suggestions, legend/sweep labels, nearest-point). No DOM, no Plotly — this is
// the testable core the UI drives.

import { lineAlong } from "./dataset.js";

export const UNIT_PREFIXES = ["—", "k", "M", "G", "T", "m", "µ", "n", "p"];
export const PREFIX_FACTOR = {
  "": 1, k: 1e3, M: 1e6, G: 1e9, T: 1e12,
  m: 1e-3, "µ": 1e-6, n: 1e-9, p: 1e-12,
};
export const CMAPS = ["Viridis", "Plasma", "Inferno", "Turbo", "RdBu", "Rainbow"];
export const LEGEND_LOCS = ["best", "upper right", "upper left", "lower right", "lower left"];
export const MAX_SWEEP_LINES = 200;
export const PROJECT_FORMAT = "nc_explorer_project_v1";      // v1 / desktop (single plot)
export const PROJECT_FORMAT_V2 = "nc_explorer_project_v2";   // multi-tab, optional embedded data

export const DEFAULT_PLOTCFG = {
  mode: "2D lines", title: "", xlabel: "", ylabel: "", zlabel: "",
  legend: true, legend_loc: "best", grid: true, logx: false, logy: false,
  cmap: "Viridis", xunit: "", yunit: "",
  ylabel2: "", yunit2: "", logy2: false,      // secondary (right) y axis
  xmin: "", xmax: "", ymin: "", ymax: "",     // axis limits ("" = auto), in displayed units
  ymin2: "", ymax2: "",                       // right y axis limits
  lock_size: false, figw: 8.0, figh: 5.2,
};

export function scaledLabel(base, prefix) {
  if (!prefix) return base;
  const factor = PREFIX_FACTOR[prefix];
  const exp = Math.round(Math.log10(factor));
  if (base.endsWith(")") && base.includes("(")) {
    const i = base.lastIndexOf("(");
    return base.slice(0, i) + "(" + prefix + base.slice(i + 1);
  }
  return base ? `${base} (×1e${exp})` : `×1e${exp}`;
}

// datetime/timedelta-ish coords/vars -> seconds; numbers pass through
export function asFloatArray(arr, unitsAttr) {
  const u = String(unitsAttr || "").toLowerCase();
  let scale = 1;
  if (/^nanoseconds\b|\bns\b/.test(u)) scale = 1e-9;
  else if (/^microseconds\b/.test(u)) scale = 1e-6;
  else if (/^milliseconds\b/.test(u)) scale = 1e-3;
  else if (/^minutes\b/.test(u)) scale = 60;
  else if (/^hours\b/.test(u)) scale = 3600;
  else if (/^days\b/.test(u)) scale = 86400;
  const out = new Float64Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = Number(arr[i]) * scale;
  return out;
}

// default traces for the lab formats written by the desktop GUIs
export function suggestTraces(ds, path) {
  const fmt = String((ds.attrs && ds.attrs.format) || "");
  const out = [];
  if (fmt === "DHO924S_snapshots_v1" && ds.has("volts") && ds.has("time_s")) {
    out.push(makeTrace(path, "volts", "sample", "var:time_s", "channel", { snap: 0 }, "volts"));
  } else if (fmt === "VNA_OSA_sidebands_v1" && ds.has("spectra_dbm")) {
    out.push(makeTrace(path, "spectra_dbm", "wl",
      ds.has("wl_nm") ? "var:wl_nm" : "index", "", { freq: 0 }, "OSA spectrum"));
  }
  return out;
}

export function makeTrace(file, varName, lineDim, xsrc, sweep, slices, label) {
  return {
    file, var: varName, line_dim: lineDim, xsrc, sweep: sweep || "",
    slices: { ...(slices || {}) }, label: label || varName,
    sweep_label: "", yaxis: "left", visible: true, color: "",
  };
}

// natural default for a fresh trace off a variable
export function defaultTrace(ds, varName, path) {
  const v = ds.variable(varName);
  const lineDim = v.dims[v.dims.length - 1];
  const coord = ds.vars[lineDim];
  let xsrc = "index";
  if (coord && (coord.isNumeric())) xsrc = "coord";
  else {
    const cands = ds.dimAxisCandidates(lineDim);
    const pref = cands.filter((c) => c.startsWith(lineDim));
    if (cands.length === 1) xsrc = "var:" + cands[0];
    else if (pref.length === 1) xsrc = "var:" + pref[0];
  }
  const slices = {};
  v.dims.forEach((d) => { if (d !== lineDim) slices[d] = 0; });
  return makeTrace(path, varName, lineDim, xsrc, "", slices, varName);
}

// ---- the core: expand a trace into drawable lines -------------------------
// returns { lines: [{x:Float64Array, y:Float64Array, sval:number|null}], sweep }
export function traceLines(ds, t, statusCb) {
  if (!ds || !ds.has(t.var)) return { lines: [], sweep: null };
  const v = ds.variable(t.var);
  const ldim = t.line_dim;
  if (!v.dims.includes(ldim)) return { lines: [], sweep: null };
  let sweep = t.sweep || null;
  if (sweep && !v.dims.includes(sweep)) sweep = null;
  if (v.dims.some((d) => ds.size(d) === 0)) {
    if (statusCb) statusCb(`${t.var}: a dimension has size 0 — nothing to plot.`);
    return { lines: [], sweep: null };
  }

  // fixed indices for every dim except line & sweep
  const fixed = {};
  for (const d of v.dims) {
    if (d === ldim || d === sweep) continue;
    fixed[d] = Math.max(0, Math.min((t.slices[d] | 0), ds.size(d) - 1));
  }
  const view = ds.isel(t.var, fixed);

  const xvals = (extraFixed) => {
    const n = ds.size(ldim);
    if (t.xsrc === "coord" && ds.vars[ldim]) {
      const cv = ds.vars[ldim];
      if (cv.isNumeric() || cv.attrs.units) return asFloatArray(cv.data, cv.attrs.units);
    }
    if (t.xsrc && t.xsrc.startsWith("var:")) {
      const name = t.xsrc.slice(4);
      const xa = ds.vars[name];
      if (xa && xa.dims.includes(ldim)) {
        const xfixed = {};
        xa.dims.forEach((d) => {
          if (d === ldim) return;
          xfixed[d] = (extraFixed && d in extraFixed) ? extraFixed[d] : (fixed[d] || 0);
        });
        const xview = ds.isel(name, xfixed);
        return asFloatArray(lineAlong(xview, ldim, {}), xa.attrs.units);
      }
    }
    const idx = new Float64Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    return idx;
  };

  const lines = [];
  if (!sweep) {
    lines.push({ x: xvals({}), y: lineAlong(view, ldim, {}), sval: null });
  } else {
    const nS = ds.size(sweep);
    const svalsCoord = ds.coordValues(sweep);
    let idxs = Array.from({ length: nS }, (_, i) => i);
    if (nS > MAX_SWEEP_LINES) {
      idxs = [];
      for (let k = 0; k < MAX_SWEEP_LINES; k++)
        idxs.push(Math.round((k * (nS - 1)) / (MAX_SWEEP_LINES - 1)));
      idxs = [...new Set(idxs)];
      if (statusCb) statusCb(`sweep '${sweep}' has ${nS} lines — showing ${idxs.length} evenly spaced.`);
    }
    for (const i of idxs) {
      const y = lineAlong(view, ldim, { [sweep]: i });
      const sval = svalsCoord ? Number(svalsCoord[i]) : i;
      lines.push({ x: xvals({ [sweep]: i }), y, sval });
    }
  }
  return { lines, sweep };
}

export function lineLabel(t, sweep, sval, j) {
  const base = t.label || t.var;
  if (sval === null || sval === undefined) return base;
  const tmpl = (t.sweep_label || "").trim();
  if (tmpl) {
    return tmpl.replace(/\{label\}/g, base).replace(/\{sweep\}/g, sweep || "")
      .replace(/\{v\}/g, fmt6(sval)).replace(/\{n\}/g, String(j));
  }
  return `${base} [${sweep}=${fmt6(sval)}]`;
}

// dsets: Map(file -> Dataset). Units are read from each trace's OWN file.
// Returns the auto X label plus SEPARATE left/right Y labels (secondary axis).
export function autoLabels(dsets, traces) {
  let xl = "", ylLeft = "", ylRight = "";
  for (const t of traces) {
    if (!t.visible) continue;
    const ds = dsets && dsets.get && dsets.get(t.file);
    if (!ds || !ds.has(t.var)) continue;
    const v = ds.variable(t.var);
    let yl = t.var;
    if (v.attrs.units) yl += ` (${v.attrs.units})`;
    if ((t.yaxis || "left") === "right") { if (!ylRight) ylRight = yl; }
    else if (!ylLeft) ylLeft = yl;
    if (!xl) {
      if (t.xsrc && t.xsrc.startsWith("var:")) {
        const name = t.xsrc.slice(4);
        xl = name;
        if (ds.vars[name] && ds.vars[name].attrs.units) xl += ` (${ds.vars[name].attrs.units})`;
      } else if (t.xsrc === "coord") {
        xl = t.line_dim;
        if (ds.vars[t.line_dim] && ds.vars[t.line_dim].attrs.units)
          xl += ` (${ds.vars[t.line_dim].attrs.units})`;
      } else xl = `${t.line_dim} (index)`;
    }
  }
  return { xl, yl: ylLeft, ylLeft, ylRight };
}

// slider display value for a dim (coordinate value, or a differently-named axis)
export function sliderValue(ds, dim, idx) {
  let src = ds.coordValues(dim);
  if (src === null) {
    const cands = ds.dimAxisCandidates(dim);
    if (cands.length) {
      const pref = cands.filter((c) => c.startsWith(dim));
      src = ds.variable(pref.length ? pref[0] : cands[0]).data;
    }
  }
  if (src && idx < src.length) {
    const val = Number(src[idx]);
    if (Number.isFinite(val)) return `${idx}: ${fmt6(val)}`;
  }
  return `${idx}/${ds.size(dim) - 1}`;
}

export function fmt6(x) {
  if (!Number.isFinite(x)) return String(x);
  const a = Math.abs(x);
  if (a !== 0 && (a < 1e-4 || a >= 1e6)) return x.toExponential(4).replace(/e/, "e");
  return parseFloat(x.toPrecision(6)).toString();
}
