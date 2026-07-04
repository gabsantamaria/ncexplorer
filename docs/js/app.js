// app.js — NC Explorer (web). Ties the readers, the trace logic, and Plotly
// into the full interactive UI: file open, variable tree, traces + sliders,
// 2D/rainbow/3D plotting, cosmetics, unit scaling, markers, exports, projects,
// and a lockable plot size for deterministic export text.

import { openBuffer } from "./dataset.js";
import * as X from "./explore.js";
import { cmapColor, cmapScale, CMAP_NAMES } from "./colormaps.js";
import { buildProject, downloadProject, parseProject, triggerDownload } from "./project.js";

const PX_PER_IN = 96;                 // inches -> px (fixed => consistent export)
const state = {
  dsets: new Map(),                   // display name -> Dataset
  fileOrder: [],
  traces: [],
  markers: [],                        // {trace, line, idx}
  cur: -1,
  plotcfg: { ...X.DEFAULT_PLOTCFG },
  markerMode: false,
  drawnMap: [],                       // curveNumber -> {ti, j} (2D only)
  pendingProject: null,               // project awaiting its data file(s)
  _updating: false,
};

const $ = (id) => document.getElementById(id);
const gd = () => $("plot");
function status(msg) { $("status").textContent = msg; }

// =====================================================================  files
async function openFile(file) {
  const name = file.name;
  if (state.dsets.has(name)) return { name, reused: true };   // kept, not reloaded
  const buf = await file.arrayBuffer();
  let ds;
  try { ds = openBuffer(buf, name); }
  catch (e) { status(`Cannot open ${name}: ${e.message}`); return null; }
  state.dsets.set(name, ds);
  state.fileOrder.push(name);
  rebuildTree();
  return { name, reused: false };
}

async function onFilesChosen(fileList) {
  const opened = [], reused = [];
  for (const f of fileList) {
    const r = await openFile(f);
    if (!r) continue;
    (r.reused ? reused : opened).push(r.name);
  }
  const reusedNote = reused.length
    ? `  (already open, not reloaded: ${reused.join(", ")})` : "";
  // a project was loaded earlier but was waiting for its data file — finish it
  // now that more files are open
  if (state.pendingProject && (opened.length || reused.length)) {
    const still = applyProject(state.pendingProject);
    if (!still.length) {
      state.pendingProject = null;
      status(`Project complete: ${state.traces.length} trace(s) drawn.`);
      return;
    }
    status(`Project still needs: ${still.join(", ")} — open it too.`);
    return;
  }
  // auto-suggest lab-format traces only for a fresh session
  if (opened.length && state.traces.length === 0) {
    for (const nm of opened) {
      const sug = X.suggestTraces(state.dsets.get(nm), nm);
      if (sug.length) { state.traces.push(...sug); break; }
    }
    if (state.traces.length) {
      rebuildTraceList(state.traces.length - 1);
      redraw();
      status(`Opened ${opened.join(", ")}${reusedNote} — added default trace(s). Use the sliders to explore.`);
      return;
    }
  }
  const head = opened.length ? `Opened ${opened.join(", ")}.` : "No new files opened.";
  status(`${head}${reusedNote} Pick a variable and "Add trace".`);
}

function closeFile(name) {
  const used = state.traces.filter((t) => t.file === name).length;
  if (used && !confirm(`${used} trace(s) use ${name} and will be removed. Close it?`)) return;
  state.dsets.delete(name);
  state.fileOrder = state.fileOrder.filter((f) => f !== name);
  const keep = [];
  const remap = {};
  state.traces.forEach((t, i) => { if (t.file !== name) { remap[i] = keep.length; keep.push(t); } });
  state.markers = state.markers.filter((m) => remap[m.trace] !== undefined)
    .map((m) => ({ ...m, trace: remap[m.trace] }));
  state.traces = keep;
  rebuildTree();
  // preserve the selected trace's identity when it survived; else clamp
  const newCur = state.traces.length
    ? (remap[state.cur] !== undefined ? remap[state.cur]
       : Math.min(state.cur, state.traces.length - 1))
    : -1;
  rebuildTraceList(newCur);
  redraw();
}

// =====================================================================  tree
function rebuildTree() {
  const tree = $("tree");
  tree.innerHTML = "";
  for (const name of state.fileOrder) {
    const ds = state.dsets.get(name);
    const top = document.createElement("div");
    top.className = "tree-file";
    const hdr = document.createElement("div");
    hdr.className = "tree-file-hdr";
    hdr.innerHTML = `<span>📄 ${esc(name)}</span>`;
    const x = document.createElement("button");
    x.textContent = "✕"; x.title = "close file"; x.className = "mini";
    x.onclick = (e) => { e.stopPropagation(); closeFile(name); };
    hdr.appendChild(x);
    top.appendChild(hdr);
    const listVars = (names, tag) => {
      for (const vn of names) {
        const v = ds.variable(vn);
        const row = document.createElement("div");
        row.className = "tree-var" + (v.isNumeric() ? "" : " nonnum");
        const dimtxt = v.dims.map((d) => `${d}:${ds.size(d)}`).join(" × ") || "scalar";
        row.innerHTML = `<span class="vn">${esc(vn)}</span><span class="vd">${esc(dimtxt)}${tag}</span>`;
        row.title = v.isNumeric() ? "double-click to add a trace" : "non-numeric (text)";
        row.onclick = () => selectTreeVar(name, vn, row);
        row.ondblclick = () => { selectTreeVar(name, vn, row); addTrace(); };
        top.appendChild(row);
      }
    };
    const dataVars = ds.varNames().filter((n) => !ds.isCoord(n));
    const coordVars = ds.varNames().filter((n) => ds.isCoord(n));
    listVars(dataVars, "");
    listVars(coordVars, " (coord)");
    tree.appendChild(top);
  }
}

let selTreeVar = null;
function selectTreeVar(file, varName, row) {
  selTreeVar = { file, var: varName };
  [...document.querySelectorAll(".tree-var.sel")].forEach((r) => r.classList.remove("sel"));
  if (row) row.classList.add("sel");
  showInfo(file, varName);
}

function showInfo(file, varName) {
  const ds = state.dsets.get(file);
  const v = ds.variable(varName);
  const lines = [`${varName}  (${v.dtype})`, `dims: ${v.dims.map((d) => `${d}=${ds.size(d)}`).join(", ") || "scalar"}`];
  for (const [k, val] of Object.entries(v.attrs)) lines.push(`  ${k}: ${val}`);
  $("info").textContent = lines.join("\n");
}

// =====================================================================  traces
function addTrace() {
  if (!selTreeVar) { status("Select a variable in the tree first."); return; }
  const ds = state.dsets.get(selTreeVar.file);
  const v = ds.variable(selTreeVar.var);
  if (!v.isNumeric()) { status(`${v.name} is not numeric — cannot plot.`); return; }
  if (v.ndim === 0) { status(`${v.name} is a scalar — nothing to plot.`); return; }
  state.traces.push(X.defaultTrace(ds, selTreeVar.var, selTreeVar.file));
  rebuildTraceList(state.traces.length - 1);
  redraw();
}

function removeTrace() {
  const r = state.cur;
  if (r < 0 || r >= state.traces.length) return;
  state.traces.splice(r, 1);
  state.markers = state.markers.filter((m) => m.trace !== r)
    .map((m) => ({ ...m, trace: m.trace - (m.trace > r ? 1 : 0) }));
  rebuildTraceList(Math.max(0, r - 1));
  redraw();
}

function clearTraces() {
  state.traces = []; state.markers = [];
  rebuildTraceList(-1); redraw();
}

function traceName(t) {
  return `${t.label || t.var}  [${t.var} @ ${t.file}]`;
}

function rebuildTraceList(select) {
  const prev = state.cur;
  state._updating = true;
  const list = $("traceList");
  list.innerHTML = "";
  state.traces.forEach((t, i) => {
    const row = document.createElement("div");
    row.className = "trace-row" + (i === select ? " sel" : "");
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.checked = t.visible !== false;
    cb.onclick = (e) => { e.stopPropagation(); t.visible = cb.checked; redraw(); };
    const label = document.createElement("span");
    label.textContent = traceName(t);
    row.appendChild(cb); row.appendChild(label);
    row.onclick = () => selectTrace(i);
    list.appendChild(row);
  });
  state._updating = false;
  const sel = (select === undefined) ? Math.min(prev, state.traces.length - 1) : select;
  selectTrace(sel);
}

function selectTrace(row) {
  state.cur = row;
  [...document.querySelectorAll(".trace-row")].forEach((r, i) =>
    r.classList.toggle("sel", i === row));
  populateEditor();
  rebuildSliders();
}

function populateEditor() {
  state._updating = true;
  const box = $("editor");
  const ldim = $("ed_ldim"), xsrc = $("ed_xsrc"), sweep = $("ed_sweep"),
    label = $("ed_label"), swlabel = $("ed_sweeplabel");
  [ldim, xsrc, sweep].forEach((s) => (s.innerHTML = ""));
  label.value = ""; swlabel.value = "";
  if (state.cur < 0 || state.cur >= state.traces.length) { box.style.opacity = 0.5; state._updating = false; return; }
  box.style.opacity = 1;
  const t = state.traces[state.cur];
  const ds = state.dsets.get(t.file);
  if (!ds || !ds.has(t.var)) { state._updating = false; return; }
  const v = ds.variable(t.var);
  const dims = v.dims;
  addOpts(ldim, dims, t.line_dim);
  // x sources
  const xs = ["index"];
  const coord = ds.vars[t.line_dim];
  if (coord && (coord.isNumeric() || coord.attrs.units)) xs.push("coord");
  for (const [nm, xv] of Object.entries(ds.vars)) {
    if (nm === t.var || !xv.isNumeric()) continue;
    const xd = new Set(xv.dims);
    if (xd.has(t.line_dim) && [...xd].every((d) => dims.includes(d))) xs.push("var:" + nm);
  }
  if (!xs.includes(t.xsrc)) t.xsrc = "index";
  addOpts(xsrc, xs, t.xsrc);
  addOpts(sweep, ["(none)", ...dims.filter((d) => d !== t.line_dim)], t.sweep || "(none)");
  label.value = t.label || t.var;
  swlabel.value = t.sweep_label || "";
  swlabel.disabled = !t.sweep;
  state._updating = false;
}

function editorChanged(what) {
  if (state._updating || state.cur < 0) return;
  const t = state.traces[state.cur];
  const ds = state.dsets.get(t.file);
  if (what === "line_dim") {
    const nd = $("ed_ldim").value;
    if (nd && nd !== t.line_dim) {
      t.line_dim = nd;
      if (t.sweep === nd) t.sweep = "";
      const keep = {};
      ds.variable(t.var).dims.forEach((d) => { if (d !== nd && d !== t.sweep) keep[d] = t.slices[d] || 0; });
      t.slices = keep;
      populateEditor(); rebuildSliders();
    }
  } else if (what === "xsrc") { t.xsrc = $("ed_xsrc").value; }
  else if (what === "sweep") {
    let nv = $("ed_sweep").value; nv = nv === "(none)" ? "" : nv;
    if (nv !== t.sweep) {
      t.sweep = nv; $("ed_sweeplabel").disabled = !nv;
      const keep = {};
      ds.variable(t.var).dims.forEach((d) => { if (d !== t.line_dim && d !== nv) keep[d] = t.slices[d] || 0; });
      t.slices = keep;
      rebuildSliders();
    }
  } else if (what === "label") {
    t.label = $("ed_label").value.trim() || t.var;
    const row = $("traceList").children[state.cur];
    if (row) row.querySelector("span").textContent = traceName(t);
  } else if (what === "sweep_label") { t.sweep_label = $("ed_sweeplabel").value; }
  redraw();
}

function rebuildSliders() {
  const box = $("sliders");
  box.innerHTML = "";
  if (state.cur < 0 || state.cur >= state.traces.length) return;
  const t = state.traces[state.cur];
  const ds = state.dsets.get(t.file);
  if (!ds || !ds.has(t.var)) return;
  const v = ds.variable(t.var);
  let any = false;
  for (const d of v.dims) {
    if (d === t.line_dim || d === t.sweep) continue;
    any = true;
    const n = ds.size(d);
    const row = document.createElement("div");
    row.className = "slider-row";
    const lab = document.createElement("span"); lab.className = "sl-name"; lab.textContent = d;
    const sld = document.createElement("input");
    sld.type = "range"; sld.min = 0; sld.max = Math.max(0, n - 1);
    sld.value = Math.max(0, Math.min(t.slices[d] | 0, n - 1));
    t.slices[d] = +sld.value;
    const val = document.createElement("span"); val.className = "sl-val";
    val.textContent = X.sliderValue(ds, d, +sld.value);
    sld.oninput = () => { t.slices[d] = +sld.value; val.textContent = X.sliderValue(ds, d, +sld.value); redraw(); };
    row.appendChild(lab); row.appendChild(sld); row.appendChild(val);
    box.appendChild(row);
  }
  if (!any) box.innerHTML = '<div class="muted">(no free dims)</div>';
}

// =====================================================================  plot
function fetchAll() {
  // returns [{ti, t, lines, sweep}] for visible, plottable traces
  const out = [];
  state.traces.forEach((t, ti) => {
    if (t.visible === false) return;
    const ds = state.dsets.get(t.file);
    if (!ds) return;
    const { lines, sweep } = X.traceLines(ds, t, status);
    if (lines.length) out.push({ ti, t, lines, sweep });
  });
  return out;
}

function redraw() {
  const c = state.plotcfg;
  const fetched = fetchAll();
  const xf = X.PREFIX_FACTOR[c.xunit] || 1;
  const yf = X.PREFIX_FACTOR[c.yunit] || 1;
  const is3d = c.mode === "3D waterfall";
  const notes = [];

  // group sweep ranges by name (shared colorbar only if all share one sweep)
  const ranges = {};
  for (const f of fetched) if (f.sweep) {
    const fin = f.lines.map((l) => l.sval).filter((s) => s != null && Number.isFinite(s));
    if (fin.length) {
      const r = ranges[f.sweep] || [Infinity, -Infinity];
      r[0] = Math.min(r[0], ...fin); r[1] = Math.max(r[1], ...fin);
      ranges[f.sweep] = r;
    }
  }
  const sharedName = Object.keys(ranges).length === 1 ? Object.keys(ranges)[0] : null;
  if (Object.keys(ranges).length > 1) notes.push("traces sweep different quantities — shared colorbar suppressed");

  const cycle = ["#1565c0", "#c0392b", "#0d6b3f", "#7d3cff", "#e6a700", "#00838f", "#ad1457", "#4e342e"];
  const data = [];
  state.drawnMap = [];
  let firstX = null;
  let coloredNoLegend = false;    // sweep lines colored but with no legend entry

  const normFor = (f) => {
    if (!f.sweep) return null;
    let lo, hi;
    if (sharedName) [lo, hi] = ranges[sharedName];
    else {
      const fin = f.lines.map((l) => l.sval).filter((s) => s != null && Number.isFinite(s));
      if (!fin.length) return null;
      lo = Math.min(...fin); hi = Math.max(...fin);
    }
    return { lo, hi: hi > lo ? hi : lo + 1 };
  };

  for (const f of fetched) {
    const nrm = normFor(f);
    const base = cycle[f.ti % cycle.length];
    if (f.sweep && f.lines.length > 12 && c.legend && c.mode === "2D lines")
      notes.push(`'${f.t.label || f.t.var}': ${f.lines.length} sweep lines — legend omitted`);
    f.lines.forEach((ln, j) => {
      const m = Math.min(ln.x.length, ln.y.length);
      const xs = new Array(m), ys = new Array(m);
      for (let k = 0; k < m; k++) { xs[k] = ln.x[k] / xf; ys[k] = ln.y[k] / yf; }
      if (firstX === null) firstX = xs;
      const sOk = ln.sval != null && Number.isFinite(ln.sval);
      const color = (sOk && nrm) ? cmapColor(c.cmap, (ln.sval - nrm.lo) / (nrm.hi - nrm.lo)) : base;
      let name = null, showlegend = false;
      if (ln.sval === null || f.lines.length <= 12) { name = X.lineLabel(f.t, f.sweep, ln.sval, j); showlegend = c.legend; }
      else if (sOk && nrm) coloredNoLegend = true;   // colored but unlabeled
      if (is3d) {
        const yy = new Array(m).fill(sOk ? ln.sval : f.ti);
        data.push({ type: "scatter3d", mode: "lines", x: xs, y: yy, z: ys,
          line: { color, width: 3 }, name, showlegend });
      } else {
        state.drawnMap.push({ ti: f.ti, j });
        // SVG scatter keeps exports truly vector; only very large lines fall
        // back to WebGL (scattergl) for rendering performance
        data.push({ type: m > 20000 ? "scattergl" : "scatter", mode: "lines",
          x: xs, y: ys, line: { color, width: 1.5 }, name, showlegend,
          hoverinfo: "x+y+name" });
      }
    });
  }

  // shared colorbar: in Rainbow mode, or whenever a single-sweep family is
  // colored in 2D but had its legend omitted (>12 lines) so colors stay mappable
  if ((c.mode === "Rainbow" || (!is3d && coloredNoLegend)) && sharedName) {
    const [lo, hi] = ranges[sharedName];
    data.push({
      type: "scatter", x: [firstX ? firstX[0] : 0], y: [null], mode: "markers",
      marker: { size: 0.1, color: [lo], colorscale: cmapScale(c.cmap), cmin: lo, cmax: hi > lo ? hi : lo + 1,
        colorbar: { title: { text: sharedName, side: "right" }, thickness: 14 }, showscale: true },
      hoverinfo: "skip", showlegend: false,
    });
  } else if (c.mode === "Rainbow" && !Object.keys(ranges).length) {
    notes.push("Rainbow mode needs a trace with a sweep dim");
  }

  // markers (2D only), anchored to (trace,line,idx) so they follow sliders
  state._markerXY = [];
  if (!is3d) drawMarkers(data, fetched, xf, yf);
  else if (state.markers.length) notes.push("markers are shown in the 2D views only");

  const auto = X.autoLabels(state.dsets, state.traces);
  const xlab = c.xlabel || X.scaledLabel(auto.xl || "", c.xunit);
  const ylab = c.ylabel || X.scaledLabel(auto.yl || "", c.yunit);
  const layout = {
    title: { text: c.title || "", font: { size: 15 } },
    margin: { l: 64, r: 20, t: c.title ? 44 : 20, b: 54 },
    showlegend: c.legend && data.some((d) => d.showlegend),
    legend: legendLoc(c.legend_loc),
    paper_bgcolor: "white", plot_bgcolor: "white",
    hovermode: "closest",
  };
  if (is3d) {
    layout.scene = {
      xaxis: { title: { text: xlab }, showgrid: c.grid },
      yaxis: { title: { text: c.zlabel || sharedName || "trace" }, showgrid: c.grid },
      zaxis: { title: { text: ylab }, showgrid: c.grid },
    };
    if (c.logx || c.logy) notes.push("log axes are not applied in the 3D view");
  } else {
    layout.xaxis = { title: { text: xlab }, showgrid: c.grid, zeroline: false, type: c.logx ? "log" : "linear" };
    layout.yaxis = { title: { text: ylab }, showgrid: c.grid, zeroline: false, type: c.logy ? "log" : "linear" };
  }
  if (c.lock_size) {
    const clamp = (v, d) => Math.min(40, Math.max(2, Number.isFinite(v) ? v : d));
    layout.width = Math.round(clamp(c.figw, 8) * PX_PER_IN);
    layout.height = Math.round(clamp(c.figh, 5.2) * PX_PER_IN);
    layout.autosize = false;
  } else { layout.autosize = true; }

  Plotly.react(gd(), data, layout, {
    responsive: !c.lock_size, displaylogo: false, scrollZoom: true,
    modeBarButtonsToRemove: ["lasso2d", "select2d"],
  });
  if (notes.length) status(notes.join(" | "));
}

function drawMarkers(data, fetched, xf, yf) {
  const byTrace = {};
  for (const f of fetched) byTrace[f.ti] = f.lines;
  const mx = [], my = [], mtext = [];
  state._markerXY = [];
  state.markers.forEach((mk, mi) => {
    const lines = byTrace[mk.trace];
    if (!lines) return;
    const j = Math.max(0, Math.min(mk.line | 0, lines.length - 1));
    const ln = lines[j];
    const m = Math.min(ln.x.length, ln.y.length);
    if (!m) return;
    const k = Math.max(0, Math.min(mk.idx | 0, m - 1));
    const xs = ln.x[k] / xf, ys = ln.y[k] / yf;
    if (!Number.isFinite(xs) || !Number.isFinite(ys)) return;
    mx.push(xs); my.push(ys); mtext.push(`${X.fmt6(xs)}, ${X.fmt6(ys)}`);
    state._markerXY.push({ mi, x: xs, y: ys });
  });
  if (mx.length) {
    data.push({
      type: "scatter", x: mx, y: my, mode: "markers+text", text: mtext,
      textposition: "top right", textfont: { size: 10, color: "#c0392b" },
      marker: { symbol: "circle-open", size: 11, color: "#c0392b", line: { width: 2 } },
      hoverinfo: "text", showlegend: false, cliponaxis: false,
    });
  }
}

function legendLoc(loc) {
  const m = {
    "best": { x: 1, y: 1, xanchor: "right", yanchor: "top" },
    "upper right": { x: 1, y: 1, xanchor: "right", yanchor: "top" },
    "upper left": { x: 0, y: 1, xanchor: "left", yanchor: "top" },
    "lower right": { x: 1, y: 0, xanchor: "right", yanchor: "bottom" },
    "lower left": { x: 0, y: 0, xanchor: "left", yanchor: "bottom" },
  };
  return { ...(m[loc] || m.best), bgcolor: "rgba(255,255,255,0.7)", font: { size: 11 } };
}

// =====================================================================  markers
function onPlotClick(ev) {
  if (!state.markerMode || state.plotcfg.mode === "3D waterfall") return;
  const p = ev.points && ev.points[0];
  if (!p) return;
  const map = state.drawnMap[p.curveNumber];
  if (!map) return;                    // clicked the colorbar/marker overlay
  state.markers.push({ trace: map.ti, line: map.j, idx: p.pointNumber });
  redraw();
}

function onPlotContext(e) {
  if (!state.markerMode || !state._markerXY || !state._markerXY.length) return;
  e.preventDefault();
  const g = gd();
  const xa = g._fullLayout.xaxis, ya = g._fullLayout.yaxis;
  if (!xa || !ya) return;
  const rect = g.getBoundingClientRect();
  const px = e.clientX - rect.left - g._fullLayout.margin.l;
  const py = e.clientY - rect.top - g._fullLayout.margin.t;
  let best = -1, bd = 30 * 30;
  state._markerXY.forEach(({ mi, x, y }) => {
    // c2p applies the axis transform (log10 on a log axis), so the hit-test
    // is correct on both linear and log axes; c2p === l2p on linear
    const dx = xa.c2p(x) - px, dy = ya.c2p(y) - py;
    const d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = mi; }
  });
  if (best >= 0) { state.markers.splice(best, 1); redraw(); }
}

// =====================================================================  cosmetics
function cfgChanged() {
  if (state._updating) return;
  const c = state.plotcfg;
  c.mode = $("cfg_mode").value;
  c.title = $("cfg_title").value; c.xlabel = $("cfg_xlab").value;
  c.ylabel = $("cfg_ylab").value; c.zlabel = $("cfg_zlab").value;
  c.legend = $("cfg_legend").checked; c.legend_loc = $("cfg_legloc").value;
  c.grid = $("cfg_grid").checked; c.logx = $("cfg_logx").checked; c.logy = $("cfg_logy").checked;
  c.cmap = $("cfg_cmap").value;
  c.xunit = $("cfg_xscale").value === "—" ? "" : $("cfg_xscale").value;
  c.yunit = $("cfg_yscale").value === "—" ? "" : $("cfg_yscale").value;
  c.lock_size = $("cfg_lock").checked;
  c.figw = +$("cfg_figw").value; c.figh = +$("cfg_figh").value;
  $("cfg_figw").disabled = !c.lock_size; $("cfg_figh").disabled = !c.lock_size;
  redraw();
}

function applyCfgWidgets() {
  state._updating = true;
  const c = state.plotcfg;
  $("cfg_mode").value = c.mode; $("cfg_title").value = c.title;
  $("cfg_xlab").value = c.xlabel; $("cfg_ylab").value = c.ylabel; $("cfg_zlab").value = c.zlabel;
  $("cfg_legend").checked = c.legend; $("cfg_legloc").value = c.legend_loc;
  $("cfg_grid").checked = c.grid; $("cfg_logx").checked = c.logx; $("cfg_logy").checked = c.logy;
  $("cfg_cmap").value = c.cmap;
  $("cfg_xscale").value = c.xunit || "—"; $("cfg_yscale").value = c.yunit || "—";
  $("cfg_lock").checked = c.lock_size; $("cfg_figw").value = c.figw; $("cfg_figh").value = c.figh;
  $("cfg_figw").disabled = !c.lock_size; $("cfg_figh").disabled = !c.lock_size;
  state._updating = false;
}

// =====================================================================  export
function exportImage(fmt) {
  const c = state.plotcfg;
  const w = c.lock_size ? Math.round(c.figw * PX_PER_IN) : gd().clientWidth;
  const h = c.lock_size ? Math.round(c.figh * PX_PER_IN) : gd().clientHeight;
  Plotly.downloadImage(gd(), { format: fmt, width: w, height: h, scale: fmt === "png" ? 2 : 1,
    filename: "ncplot_" + stamp() });
  status(`Exported ${fmt.toUpperCase()}.`);
}

async function exportPDF() {
  const c = state.plotcfg;
  const w = c.lock_size ? Math.round(c.figw * PX_PER_IN) : gd().clientWidth;
  const h = c.lock_size ? Math.round(c.figh * PX_PER_IN) : gd().clientHeight;
  try {
    const uri = await Plotly.toImage(gd(), { format: "svg", width: w, height: h });
    const svgText = decodeURIComponent(uri.replace(/^data:image\/svg\+xml,/, ""));
    const svgEl = new DOMParser().parseFromString(svgText, "image/svg+xml").documentElement;
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ orientation: w >= h ? "landscape" : "portrait", unit: "pt", format: [w, h] });
    // svg2pdf.js patches jsPDF with an async .svg() method
    await pdf.svg(svgEl, { width: w, height: h });
    pdf.save("ncplot_" + stamp() + ".pdf");
    status("Exported vector PDF.");
  } catch (e) { status("PDF export error: " + e.message); }
}

function exportCSV() {
  const c = state.plotcfg;
  const xf = X.PREFIX_FACTOR[c.xunit] || 1, yf = X.PREFIX_FACTOR[c.yunit] || 1;
  const rows = [];
  for (const t of state.traces) {
    if (t.visible === false) continue;
    const ds = state.dsets.get(t.file);
    if (!ds) continue;
    const { lines } = X.traceLines(ds, t, status);
    for (const ln of lines) {
      const m = Math.min(ln.x.length, ln.y.length);
      const lab = csvField(t.label || t.var);
      const sv = ln.sval == null ? "" : X.fmt6(ln.sval);
      for (let k = 0; k < m; k++) rows.push(`"${lab}",${sv},${ln.x[k] / xf},${ln.y[k] / yf}`);
    }
  }
  if (!rows.length) { status("Nothing plotted — nothing to export."); return; }
  let head = "# NC Explorer export (long format)\n";
  if (xf !== 1 || yf !== 1) head += `# axis scale: x÷${xf} (${c.xunit || "1"}), y÷${yf} (${c.yunit || "1"}) — as displayed\n`;
  head += "trace,sweep,x,y\n";
  triggerDownload(new Blob([head + rows.join("\n") + "\n"], { type: "text/csv" }), "ncplot_" + stamp() + ".csv");
  status(`Exported ${rows.length} rows.`);
}

// =====================================================================  projects
function saveProject() {
  if (!state.fileOrder.length) { status("Nothing to save yet."); return; }
  downloadProject(state, "ncplot_" + stamp() + ".ncproj");
  status("Project downloaded (.ncproj).");
}

async function loadProjectFile(file) {
  let proj;
  try { proj = parseProject(await file.text()); }
  catch (e) { status("Project load error: " + e.message); return; }
  const still = applyProject(proj);
  if (still.length) {
    // can't open files by path from the browser — the user must pick the .nc.
    // keep the project pending; cosmetics are already applied, and it finishes
    // automatically the moment they open the referenced file.
    state.pendingProject = proj;
    status(`Project loaded — now click "Open .nc…" and select: ${still.join(", ")} `
      + "to draw the traces (or drag the .nc + .ncproj in together).");
  } else {
    state.pendingProject = null;
    status(`Project loaded: ${state.traces.length} trace(s).`);
  }
}

// resolve a project's file references against OPEN datasets by BASENAME (desktop
// projects store absolute paths; web projects store bare names). Applies the
// cosmetics + every trace whose file is open, and RETURNS the still-missing
// file basenames (empty when fully applied).
function applyProject(proj) {
  const openByBase = new Map();
  for (const nm of state.fileOrder) openByBase.set(basename(nm).toLowerCase(), nm);
  const resolve = (f) => openByBase.get(basename(f).toLowerCase()) || null;
  const missing = [...new Set(proj.files.map((f) => basename(f)))]
    .filter((b) => !openByBase.has(b.toLowerCase()));
  const projToNew = {};
  const newtraces = [];
  proj.traces.forEach((t, pi) => {
    const openName = resolve(t.file);
    const ds = openName && state.dsets.get(openName);
    if (!ds || !ds.has(t.var)) return;
    const dims = ds.variable(t.var).dims;
    let ldim = String(t.line_dim || "");
    if (!dims.includes(ldim)) ldim = dims[dims.length - 1];
    let sweep = String(t.sweep || "");
    if (sweep && (!dims.includes(sweep) || sweep === ldim)) sweep = "";
    const slices = Object.create(null);
    if (t.slices && typeof t.slices === "object")
      for (const [k, v] of Object.entries(t.slices)) {
        if (k === "__proto__" || k === "constructor") continue;
        slices[k] = Math.max(0, v | 0);
      }
    projToNew[pi] = newtraces.length;
    newtraces.push({ file: openName, var: t.var, line_dim: ldim, sweep, slices,
      xsrc: String(t.xsrc || "index"), label: String(t.label || t.var),
      sweep_label: String(t.sweep_label || ""), visible: t.visible !== false });
  });
  state.traces = newtraces;
  state.markers = (proj.markers || []).filter((m) => projToNew[m.trace] !== undefined)
    .map((m) => ({ trace: projToNew[m.trace], line: Math.max(0, m.line | 0), idx: Math.max(0, m.idx | 0) }));
  state.plotcfg = proj.plotcfg;      // cosmetics apply even before the data opens
  applyCfgWidgets();
  rebuildTraceList(state.traces.length ? 0 : -1);
  redraw();
  return missing;
}

// =====================================================================  helpers
function addOpts(sel, items, current) {
  for (const it of items) {
    const o = document.createElement("option");
    o.value = it; o.textContent = it; if (it === current) o.selected = true;
    sel.appendChild(o);
  }
}
function esc(s) { return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }
function basename(p) { return String(p).replace(/\\/g, "/").split("/").pop(); }
// CSV field: neutralize spreadsheet formula injection (a cell beginning with
// = + - @ or a control char is evaluated by Excel/Sheets), then quote
function csvField(s) {
  let v = String(s);
  if (/^[=+\-@\t\r]/.test(v)) v = "'" + v;
  return v.replace(/"/g, '""');
}
function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// =====================================================================  wiring
function init() {
  // populate static selects
  addOpts($("cfg_mode"), ["2D lines", "Rainbow", "3D waterfall"], "2D lines");
  addOpts($("cfg_legloc"), X.LEGEND_LOCS, "best");
  addOpts($("cfg_cmap"), CMAP_NAMES, "Viridis");
  addOpts($("cfg_xscale"), X.UNIT_PREFIXES, "—");
  addOpts($("cfg_yscale"), X.UNIT_PREFIXES, "—");
  applyCfgWidgets();

  $("btnOpen").onclick = () => $("fileInput").click();
  $("fileInput").onchange = (e) => { onFilesChosen(e.target.files); e.target.value = ""; };
  $("btnAdd").onclick = addTrace;
  $("btnRemove").onclick = removeTrace;
  $("btnClear").onclick = clearTraces;
  $("ed_ldim").onchange = () => editorChanged("line_dim");
  $("ed_xsrc").onchange = () => editorChanged("xsrc");
  $("ed_sweep").onchange = () => editorChanged("sweep");
  $("ed_label").onchange = () => editorChanged("label");
  $("ed_sweeplabel").onchange = () => editorChanged("sweep_label");
  ["cfg_mode", "cfg_title", "cfg_xlab", "cfg_ylab", "cfg_zlab", "cfg_legloc",
    "cfg_cmap", "cfg_xscale", "cfg_yscale", "cfg_figw", "cfg_figh"].forEach((id) => {
    $(id).onchange = cfgChanged;
  });
  ["cfg_legend", "cfg_grid", "cfg_logx", "cfg_logy", "cfg_lock"].forEach((id) => {
    $(id).onchange = cfgChanged;
  });
  $("btnMarker").onclick = () => {
    state.markerMode = !state.markerMode;
    $("btnMarker").classList.toggle("active", state.markerMode);
    status(state.markerMode ? "Marker mode ON — left-click a point to add, right-click a marker to delete."
      : "Marker mode off.");
  };
  $("btnMarkerClear").onclick = () => { if (state.markers.length) { state.markers = []; redraw(); } };
  $("btnPNG").onclick = () => exportImage("png");
  $("btnSVG").onclick = () => exportImage("svg");
  $("btnPDF").onclick = exportPDF;
  $("btnCSV").onclick = exportCSV;
  $("btnSaveProj").onclick = saveProject;
  $("btnLoadProj").onclick = () => $("projInput").click();
  $("projInput").onchange = (e) => { if (e.target.files[0]) loadProjectFile(e.target.files[0]); e.target.value = ""; };

  // drag & drop
  const dz = document.body;
  dz.addEventListener("dragover", (e) => { e.preventDefault(); });
  dz.addEventListener("drop", async (e) => {
    e.preventDefault();
    const all = [...e.dataTransfer.files];
    const ncproj = all.filter((f) => /\.(ncproj|json)$/i.test(f.name));
    const ncs = all.filter((f) => !/\.(ncproj|json)$/i.test(f.name));
    // open the data files FIRST (await) so a project dropped alongside them
    // resolves against the now-open datasets
    if (ncs.length) await onFilesChosen(ncs);
    if (ncproj.length) await loadProjectFile(ncproj[0]);
  });

  Plotly.newPlot(gd(), [], { margin: { t: 20 } }, { displaylogo: false, responsive: true });
  gd().on("plotly_click", onPlotClick);
  gd().addEventListener("contextmenu", onPlotContext);
  status("Open a .nc file (NetCDF-3 or NetCDF-4/HDF5), or drag one in.");
}

document.addEventListener("DOMContentLoaded", init);

// register the service worker so updates propagate automatically (see sw.js).
// Harmless if unsupported/blocked; the app works identically without it.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

// expose for a tiny in-page smoke test (see tests/smoke.html)
window.__ncx = { state, redraw, X, openBuffer, onFilesChosen };
