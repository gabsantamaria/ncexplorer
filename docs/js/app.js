// app.js — NC Explorer (web). Ties the readers, the trace logic, and Plotly
// into the full interactive UI: file open, variable tree, traces + sliders,
// 2D/rainbow/3D plotting, cosmetics, unit scaling, markers, exports, projects,
// and a lockable plot size for deterministic export text.

import { openBuffer } from "./dataset.js";
import * as X from "./explore.js";
import { cmapColor, cmapScale, CMAP_NAMES } from "./colormaps.js";
import { buildProject, downloadProject, parseProject, triggerDownload,
  abToB64Chunks, b64ChunksToAb } from "./project.js";

const PX_PER_IN = 96;                 // inches -> px (fixed => consistent export)
// qualitative palette for discrete (non-sweep) traces; index = trace position.
// A per-trace color override (t.color) wins over this; sweep families are
// colored by the colormap instead.
const CYCLE = ["#1565c0", "#c0392b", "#0d6b3f", "#7d3cff", "#e6a700", "#00838f", "#ad1457", "#4e342e"];
// state splits into SHARED fields (datasets — the left panel, common to all
// tabs) and PER-TAB fields (each tab is its own formatted plot). The per-tab
// fields are exposed on `state` via accessors that transparently forward to the
// ACTIVE tab, so every existing call site that reads/writes state.traces /
// markers / cur / plotcfg / drawnMap keeps working unchanged.
const state = {
  dsets: new Map(),                   // display name -> Dataset      (SHARED)
  fileOrder: [],                      // SHARED
  markerMode: false,                  // SHARED (global UI toggle)
  pendingProject: null,               // SHARED: project awaiting its data file(s)
  _updating: false,                   // SHARED: DOM re-entrancy guard
  _loadingProject: false,             // SHARED: locks tab edits during embedded decode
  tabs: [],                           // filled below
  active: 0,
};

let _tabSeq = 0;
function makeTab(name) {
  return {
    id: "t" + (++_tabSeq),
    name: name || `Plot ${state.tabs.length + 1}`,
    traces: [],
    markers: [],                      // {trace, line, idx}
    cur: -1,                          // selected trace
    plotcfg: { ...X.DEFAULT_PLOTCFG },
    drawnMap: [],                     // curveNumber -> {ti, j} (2D only)
    _markerXY: [],                    // transient marker hit-test geometry
  };
}
function activeTab() { return state.tabs[state.active]; }

state.tabs = [makeTab("Plot 1")];
state.active = 0;

// per-tab fields proxied onto `state` -> the active tab. The setter writes
// THROUGH, so `state.traces = []` and `state.traces.push(...)` both land on the
// active tab. Never spread `state` (would serialize only the active tab) — the
// project builder reads state.tabs directly.
for (const key of ["traces", "markers", "cur", "plotcfg", "drawnMap", "_markerXY"]) {
  Object.defineProperty(state, key, {
    get() { const t = activeTab(); return t ? t[key] : (key === "cur" ? -1 : []); },
    set(v) { const t = activeTab(); if (t) t[key] = v; },
    enumerable: true, configurable: true,
  });
}

const $ = (id) => document.getElementById(id);
const gd = () => $("plot");
function status(msg) { $("status").textContent = msg; }

// ================================================================  autosave (IndexedDB)
// Persists the whole working session — the opened files' bytes AND the project
// (traces, cosmetics, markers, layout) — so an accidental tab close loses
// nothing. Files go in the "files" store (ArrayBuffers), the project JSON in
// "meta". Restored on next load.
const DB_NAME = "ncx-session";
function _openDB() {
  return new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(DB_NAME, 1); }
    catch (e) { return reject(e); }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("files")) db.createObjectStore("files");
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function _tx(store, mode, fn) {
  return _openDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));   // an IDBRequest
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    tx.onabort = () => reject(tx.error);
  }));
}
const idbPut = (store, key, val) => _tx(store, "readwrite", (os) => os.put(val, key));
const idbGet = (store, key) => _tx(store, "readonly", (os) => os.get(key));
const idbKeys = (store) => _tx(store, "readonly", (os) => os.getAllKeys());
const idbDel = (store, key) => _tx(store, "readwrite", (os) => os.delete(key));
const idbClearStore = (store) => _tx(store, "readwrite", (os) => os.clear());

let _saveTimer = null;
function scheduleSave() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    const anyTraces = state.tabs.some((tb) => tb.traces.length);
    if (!state.fileOrder.length && !anyTraces) return;
    // autosave never embeds — file bytes already live in the "files" store
    idbPut("meta", "project", JSON.stringify(buildProject(state))).catch(() => {});
  }, 600);
}

async function restoreSession() {
  let names;
  try { names = await idbKeys("files"); } catch (e) { return false; }
  if (!names || !names.length) return false;
  status("Restoring your last session…");
  for (const name of names) {
    try {
      const buf = await idbGet("files", name);
      if (!buf) continue;
      const ds = await openBuffer(buf, name);
      state.dsets.set(name, ds);
      state.fileOrder.push(name);
    } catch (e) { /* skip a file that no longer parses */ }
  }
  rebuildTree();
  let projText;
  try { projText = await idbGet("meta", "project"); } catch (e) { projText = null; }
  if (projText) {
    try { await applyProject(parseProject(projText)); } catch (e) { /* ignore bad project */ }
  }
  const nTr = state.tabs.reduce((s, tb) => s + tb.traces.length, 0);
  status(`Restored ${state.fileOrder.length} file(s), ${state.tabs.length} tab(s) and ${nTr} trace(s) `
    + "from your last session.");
  return true;
}

async function clearSession() {
  try { await idbClearStore("files"); await idbDel("meta", "project"); } catch (e) { /* ignore */ }
}

// =====================================================================  tabs
// Each tab is its own formatted plot; the datasets (left panel) are shared. A
// tab switch refreshes everything per-tab (cosmetics widgets, trace list,
// editor, sliders, canvas) but never touches the shared datasets/tree.
// while an embedded project is decoding (async), lock tab edits so a click that
// lands during the await isn't clobbered when applyProject rebuilds state.tabs
function setTabsBusy(on) {
  state._loadingProject = on;
  const bar = $("tabbar");
  if (bar) bar.classList.toggle("busy", on);
}

function renderTabs() {
  const bar = $("tabbar");
  if (state._loadingProject) bar.classList.add("busy");
  bar.innerHTML = "";
  state.tabs.forEach((tp, i) => {
    const el = document.createElement("div");
    el.className = "tab" + (i === state.active ? " active" : "");
    el.dataset.i = i;
    const nm = document.createElement("span");
    nm.className = "tab-name"; nm.textContent = tp.name;
    nm.title = tp.name + " — double-click to rename · right-click for options";
    const x = document.createElement("span");
    x.className = "x"; x.textContent = "✕"; x.title = "close plot";
    el.appendChild(nm); el.appendChild(x);
    el.onclick = () => switchTab(i);
    x.onclick = (e) => { e.stopPropagation(); closeTab(i); };
    nm.ondblclick = (e) => { e.stopPropagation(); beginRename(i, nm); };
    el.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); showTabMenu(i, e.clientX, e.clientY); };
    bar.appendChild(el);
  });
  const add = document.createElement("button");
  add.className = "tab-add"; add.textContent = "＋"; add.title = "new plot (tab)";
  add.onclick = addTab;
  bar.appendChild(add);
}

function addTab() {
  if (state._loadingProject) return;
  state.tabs.push(makeTab());
  state.active = state.tabs.length - 1;
  refreshTab();
}

function uniqueTabName(base) {
  const names = new Set(state.tabs.map((t) => t.name));
  if (!names.has(base)) return base;
  for (let n = 2; ; n++) { const cand = `${base} ${n}`; if (!names.has(cand)) return cand; }
}

// deep-copy a tab (independent traces/markers/cosmetics), insert after it, activate
function duplicateTab(i) {
  if (state._loadingProject) return;
  const src = state.tabs[i];
  if (!src) return;
  const copy = makeTab(uniqueTabName(src.name + " copy"));
  copy.traces = src.traces.map((t) => ({ ...t, slices: { ...t.slices } }));
  copy.markers = src.markers.map((m) => ({ ...m }));
  copy.plotcfg = { ...src.plotcfg };
  copy.cur = src.cur;
  // drawnMap/_markerXY are transient — redraw rebuilds them for the copy
  state.tabs.splice(i + 1, 0, copy);
  state.active = i + 1;
  refreshTab();
}

// right-click menu on a tab: Duplicate / Rename / Close
let _tabMenu = null;
function closeTabMenu() {
  if (!_tabMenu) return;
  _tabMenu.remove(); _tabMenu = null;
  document.removeEventListener("mousedown", onTabMenuOutside, true);
  document.removeEventListener("keydown", onTabMenuKey, true);
  window.removeEventListener("blur", closeTabMenu);
}
function onTabMenuOutside(e) { if (_tabMenu && !_tabMenu.contains(e.target)) closeTabMenu(); }
function onTabMenuKey(e) { if (e.key === "Escape") closeTabMenu(); }

function showTabMenu(i, x, y) {
  closeTabMenu();
  const menu = document.createElement("div");
  menu.className = "ctxmenu";
  const item = (label, fn) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.onclick = () => { closeTabMenu(); fn(); };
    menu.appendChild(b);
  };
  item("Duplicate", () => duplicateTab(i));
  item("Rename…", () => { const el = $("tabbar").querySelectorAll(".tab-name")[i]; if (el) beginRename(i, el); });
  item("Close", () => closeTab(i));
  document.body.appendChild(menu);
  _tabMenu = menu;
  // clamp to the viewport so the menu never spills off-screen
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.max(2, Math.min(x, window.innerWidth - r.width - 4)) + "px";
  menu.style.top = Math.max(2, Math.min(y, window.innerHeight - r.height - 4)) + "px";
  document.addEventListener("mousedown", onTabMenuOutside, true);
  document.addEventListener("keydown", onTabMenuKey, true);
  window.addEventListener("blur", closeTabMenu);
}

function switchTab(i) {
  if (state._loadingProject) return;
  if (i === state.active || i < 0 || i >= state.tabs.length) return;
  state.active = i;
  refreshTab();
}

function beginRename(i, span) {
  if (state._loadingProject) return;
  const inp = document.createElement("input");
  inp.type = "text"; inp.value = state.tabs[i].name; inp.className = "tab-rename";
  span.replaceWith(inp); inp.focus(); inp.select();
  let done = false;
  const commit = (save) => {
    if (done) return; done = true;
    if (save) { const v = inp.value.trim().slice(0, 80); if (v) state.tabs[i].name = v; }
    renderTabs(); scheduleSave();
  };
  inp.onkeydown = (e) => { if (e.key === "Enter") commit(true); else if (e.key === "Escape") commit(false); };
  inp.onblur = () => commit(true);
}

function closeTab(i) {
  if (state._loadingProject) return;
  const tp = state.tabs[i];
  if ((tp.traces.length || tp.markers.length)
      && !confirm(`Close "${tp.name}"? Its ${tp.traces.length} trace(s) will be discarded.`)) return;
  if (state.tabs.length === 1) { state.tabs = [makeTab("Plot 1")]; state.active = 0; }
  else {
    state.tabs.splice(i, 1);
    if (state.active > i) state.active--;
    state.active = Math.max(0, Math.min(state.active, state.tabs.length - 1));
  }
  refreshTab();
}

// the single "a tab switch refreshes EVERYTHING per-tab" routine
function refreshTab() {
  renderTabs();
  applyCfgWidgets();     // cosmetics widgets <- active tab's plotcfg
  rebuildTraceList(activeTab().cur >= 0 ? activeTab().cur : (state.traces.length ? 0 : -1));
  redraw();              // repaints #plot and fires scheduleSave
}

// =====================================================================  files
async function openFile(file) {
  const name = file.name;
  if (state.dsets.has(name)) return { name, reused: true };   // kept, not reloaded
  const buf = await file.arrayBuffer();
  let ds;
  try { ds = await openBuffer(buf, name); }   // HDF5 path is async (WASM)
  catch (e) { status(`Cannot open ${name}: ${e.message}`); return null; }
  state.dsets.set(name, ds);
  state.fileOrder.push(name);
  idbPut("files", name, buf).catch(() => {});   // persist for session restore
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
    const still = await applyProject(state.pendingProject);
    if (!still.length) {
      state.pendingProject = null;
      const nTr = state.tabs.reduce((s, tb) => s + tb.traces.length, 0);
      status(`Project complete: ${state.tabs.length} tab(s), ${nTr} trace(s) drawn.`);
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

// drop every trace referencing `name` from ONE tab, remapping its markers and
// selected-trace index against that tab's own before/after trace order
function pruneFileFromTab(tp, name) {
  const keep = [], remap = {};
  tp.traces.forEach((t, i) => { if (t.file !== name) { remap[i] = keep.length; keep.push(t); } });
  tp.markers = tp.markers.filter((m) => remap[m.trace] !== undefined)
    .map((m) => ({ ...m, trace: remap[m.trace] }));
  tp.cur = keep.length
    ? (remap[tp.cur] !== undefined ? remap[tp.cur] : Math.min(tp.cur, keep.length - 1))
    : -1;
  tp.traces = keep;
}

function closeFile(name) {
  // datasets are shared: a closed file's traces must be purged from EVERY tab
  const used = state.tabs.reduce((s, tb) => s + tb.traces.filter((t) => t.file === name).length, 0);
  if (used && !confirm(`${used} trace(s) across all tabs use ${name} and will be removed. Close it?`)) return;
  state.dsets.delete(name);
  state.fileOrder = state.fileOrder.filter((f) => f !== name);
  idbDel("files", name).catch(() => {});
  state.tabs.forEach((tp) => pruneFileFromTab(tp, name));
  rebuildTree();
  rebuildTraceList(activeTab().cur);   // active tab's already-remapped selection
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
    label = $("ed_label"), swlabel = $("ed_sweeplabel"), yax = $("ed_yaxis"),
    ssrc = $("ed_ssrc");
  [ldim, xsrc, sweep, yax, ssrc].forEach((s) => (s.innerHTML = ""));
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
  addOpts(yax, ["left", "right"], t.yaxis || "left");
  // colorbar (sweep-value) source — analogous to x sources but keyed on the
  // sweep dim; only meaningful when a sweep is set
  const sw = t.sweep || "";
  const ss = ["coord", "index"];
  if (sw) {
    for (const [nm, sv] of Object.entries(ds.vars)) {
      if (nm === t.var || nm === sw || !sv.isNumeric()) continue;
      const sd = new Set(sv.dims);
      if (sd.has(sw) && [...sd].every((d) => dims.includes(d))) ss.push("var:" + nm);
    }
  }
  if (!t.ssrc || !ss.includes(t.ssrc)) t.ssrc = "coord";   // repair missing/stale
  addOpts(ssrc, ss, t.ssrc);
  ssrc.disabled = !sw;
  label.value = t.label || t.var;
  swlabel.value = t.sweep_label || "";
  swlabel.disabled = !t.sweep;
  // color: "auto" follows the qualitative cycle (by trace position); a set
  // color overrides it. The picker still shows the effective color when auto.
  const auto = !t.color;
  $("ed_autocolor").checked = auto;
  const col = $("ed_color");
  col.value = t.color || CYCLE[state.cur % CYCLE.length];
  col.disabled = auto;
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
      t.ssrc = "coord";     // a new sweep dim starts from its own coordinate
      const keep = {};
      ds.variable(t.var).dims.forEach((d) => { if (d !== t.line_dim && d !== nv) keep[d] = t.slices[d] || 0; });
      t.slices = keep;
      populateEditor(); rebuildSliders();   // refresh the colorbar-source options
    }
  } else if (what === "ssrc") { t.ssrc = $("ed_ssrc").value; }
  else if (what === "label") {
    t.label = $("ed_label").value.trim() || t.var;
    const row = $("traceList").children[state.cur];
    if (row) row.querySelector("span").textContent = traceName(t);
  } else if (what === "sweep_label") { t.sweep_label = $("ed_sweeplabel").value; }
  else if (what === "yaxis") { t.yaxis = $("ed_yaxis").value === "right" ? "right" : "left"; }
  else if (what === "color") { t.color = $("ed_color").value; $("ed_autocolor").checked = false; $("ed_color").disabled = false; }
  else if (what === "autocolor") {
    const auto = $("ed_autocolor").checked;
    if (auto) { t.color = ""; $("ed_color").disabled = true; $("ed_color").value = CYCLE[state.cur % CYCLE.length]; }
    else { t.color = $("ed_color").value; $("ed_color").disabled = false; }
  }
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
  const yfL = X.PREFIX_FACTOR[c.yunit] || 1;
  const yfR = X.PREFIX_FACTOR[c.yunit2] || 1;
  const is3d = c.mode === "3D waterfall";
  // a trace's y unit factor / Plotly axis, by its left/right assignment
  const traceOnRight = (ti) => !is3d && (state.traces[ti].yaxis === "right");
  const yfFor = (ti) => traceOnRight(ti) ? yfR : yfL;
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

  const cycle = CYCLE;
  const data = [];
  state.drawnMap = [];
  let firstX = null;
  let coloredNoLegend = false;    // sweep lines colored but with no legend entry
  // data extents (in displayed units) so a one-sided axis limit can fill the
  // other side from the data
  let xDMin = Infinity, xDMax = -Infinity;
  let yLMin = Infinity, yLMax = -Infinity, yRMin = Infinity, yRMax = -Infinity;

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
    // per-trace color override wins; else the qualitative cycle. (A sweep
    // family is still colored by the colormap below — normFor decides that.)
    const base = f.t.color || cycle[f.ti % cycle.length];
    if (f.sweep && f.lines.length > 12 && c.legend && c.mode === "2D lines")
      notes.push(`'${f.t.label || f.t.var}': ${f.lines.length} sweep lines — legend omitted`);
    const yf = yfFor(f.ti);
    const onRight = traceOnRight(f.ti);
    f.lines.forEach((ln, j) => {
      const m = Math.min(ln.x.length, ln.y.length);
      const xs = new Array(m), ys = new Array(m);
      for (let k = 0; k < m; k++) {
        const xv = ln.x[k] / xf, yv = ln.y[k] / yf;
        xs[k] = xv; ys[k] = yv;
        if (Number.isFinite(xv)) { if (xv < xDMin) xDMin = xv; if (xv > xDMax) xDMax = xv; }
        if (Number.isFinite(yv)) {
          if (onRight) { if (yv < yRMin) yRMin = yv; if (yv > yRMax) yRMax = yv; }
          else { if (yv < yLMin) yLMin = yv; if (yv > yLMax) yLMax = yv; }
        }
      }
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
          x: xs, y: ys, yaxis: onRight ? "y2" : "y",
          line: { color, width: onRight ? 1.5 : 1.5, dash: onRight ? "dot" : "solid" },
          name, showlegend, hoverinfo: "x+y+name" });
      }
    });
  }

  // shared colorbar: in Rainbow mode, or whenever a single-sweep family is
  // colored in 2D but had its legend omitted (>12 lines) so colors stay mappable
  if ((c.mode === "Rainbow" || (!is3d && coloredNoLegend)) && sharedName) {
    // the trace driving this shared colorbar (first one with this sweep)
    const rep = fetched.find((f) => f.sweep === sharedName);
    // an index source is dimensionless — never SI-scale it or fold a prefix into
    // its caption. Otherwise scale the DISPLAYED range (line colors stay
    // ratio-normalized on the raw values, so they keep matching the bar).
    const isIndex = rep && (rep.t.ssrc || "coord") === "index";
    const cf = isIndex ? 1 : (X.PREFIX_FACTOR[c.cunit] || 1);
    if (isIndex && c.cunit) notes.push("colorbar source is an index — SI scaling not applied");
    const lo = ranges[sharedName][0] / cf, hi = ranges[sharedName][1] / cf;
    // caption: explicit override (verbatim), else the source label (with the SI
    // prefix folded in, except for the dimensionless index)
    const srcLabel = rep ? X.sweepSourceLabel(state.dsets.get(rep.t.file), rep.t, sharedName) : sharedName;
    const clab = (c.clabel && c.clabel.trim()) || (isIndex ? srcLabel : X.scaledLabel(srcLabel, c.cunit));
    data.push({
      type: "scatter", x: [firstX ? firstX[0] : 0], y: [null], mode: "markers",
      marker: { size: 0.1, color: [lo], colorscale: cmapScale(c.cmap), cmin: lo, cmax: hi > lo ? hi : lo + 1,
        colorbar: { title: { text: clab, side: "right" }, thickness: 14 }, showscale: true },
      hoverinfo: "skip", showlegend: false,
    });
  } else if (c.mode === "Rainbow" && !Object.keys(ranges).length) {
    notes.push("Rainbow mode needs a trace with a sweep dim");
  }

  // markers (2D only), anchored to (trace,line,idx) so they follow sliders;
  // each marker sits on its trace's own y axis
  state._markerXY = [];
  const anyRight = !is3d && fetched.some((f) => traceOnRight(f.ti));
  if (!is3d) drawMarkers(data, fetched, xf, yfFor, traceOnRight);
  else if (state.markers.length) notes.push("markers are shown in the 2D views only");

  const auto = X.autoLabels(state.dsets, state.traces);
  const xlab = c.xlabel || X.scaledLabel(auto.xl || "", c.xunit);
  const ylab = c.ylabel || X.scaledLabel(auto.ylLeft || "", c.yunit);
  const ylab2 = c.ylabel2 || X.scaledLabel(auto.ylRight || "", c.yunit2);
  const layout = {
    title: { text: c.title || "", font: { size: 15 } },
    margin: { l: 64, r: anyRight ? 64 : 20, t: c.title ? 44 : 20, b: 54 },
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
    if (c.xmin || c.xmax || c.ymin || c.ymax || c.ymin2 || c.ymax2)
      notes.push("axis limits are applied in the 2D views only");
  } else {
    // a full box frame with visible axis lines and outward ticks
    const frame = { showline: true, linecolor: "#2a2a2a", linewidth: 1.2,
      ticks: "outside", tickcolor: "#2a2a2a", ticklen: 5 };
    layout.xaxis = { title: { text: xlab }, showgrid: c.grid, zeroline: false,
      type: c.logx ? "log" : "linear", mirror: true, ...frame };
    layout.yaxis = { title: { text: ylab }, showgrid: c.grid, zeroline: false,
      type: c.logy ? "log" : "linear", mirror: anyRight ? false : true, ...frame };
    if (anyRight) {
      layout.yaxis2 = { title: { text: ylab2 }, overlaying: "y", side: "right",
        showgrid: false, zeroline: false, type: c.logy2 ? "log" : "linear",
        mirror: true, ...frame };
    }
    // optional per-tab axis limits (blank = auto); a one-sided limit fills the
    // other end from the data extent
    const xr = axisRange(c.xmin, c.xmax, xDMin, xDMax, c.logx);
    if (xr) { layout.xaxis.range = xr; layout.xaxis.autorange = false; }
    const yr = axisRange(c.ymin, c.ymax, yLMin, yLMax, c.logy);
    if (yr) { layout.yaxis.range = yr; layout.yaxis.autorange = false; }
    if (anyRight) {
      const yr2 = axisRange(c.ymin2, c.ymax2, yRMin, yRMax, c.logy2);
      if (yr2) { layout.yaxis2.range = yr2; layout.yaxis2.autorange = false; }
    }
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
  scheduleSave();   // autosave the session (debounced)
}

function drawMarkers(data, fetched, xf, yfFor, traceOnRight) {
  const byTrace = {};
  for (const f of fetched) byTrace[f.ti] = f.lines;
  // one overlay per y axis so a marker lands on its trace's own axis
  const groups = { y: { mx: [], my: [], mt: [] }, y2: { mx: [], my: [], mt: [] } };
  state._markerXY = [];
  state.markers.forEach((mk, mi) => {
    const lines = byTrace[mk.trace];
    if (!lines) return;
    const j = Math.max(0, Math.min(mk.line | 0, lines.length - 1));
    const ln = lines[j];
    const m = Math.min(ln.x.length, ln.y.length);
    if (!m) return;
    const k = Math.max(0, Math.min(mk.idx | 0, m - 1));
    const ax = traceOnRight(mk.trace) ? "y2" : "y";
    const xs = ln.x[k] / xf, ys = ln.y[k] / yfFor(mk.trace);
    if (!Number.isFinite(xs) || !Number.isFinite(ys)) return;
    const g = groups[ax];
    g.mx.push(xs); g.my.push(ys); g.mt.push(`${X.fmt6(xs)}, ${X.fmt6(ys)}`);
    state._markerXY.push({ mi, x: xs, y: ys, axis: ax });
  });
  for (const ax of ["y", "y2"]) {
    const g = groups[ax];
    if (!g.mx.length) continue;
    data.push({
      type: "scatter", x: g.mx, y: g.my, yaxis: ax, mode: "markers+text", text: g.mt,
      textposition: "top right", textfont: { size: 10, color: "#c0392b" },
      marker: { symbol: "circle-open", size: 11, color: "#c0392b", line: { width: 2 } },
      hoverinfo: "text", showlegend: false, cliponaxis: false,
    });
  }
}

// build a Plotly axis range from optional user min/max (strings; "" = auto),
// filling an unset side from the data extent. Returns null to keep autorange.
// For a log axis the range must be in log10 units (positive values only).
function axisRange(umin, umax, dmin, dmax, isLog) {
  const nmin = parseFloat(umin), nmax = parseFloat(umax);
  const hasMin = Number.isFinite(nmin), hasMax = Number.isFinite(nmax);
  if (!hasMin && !hasMax) return null;
  let lo = hasMin ? nmin : dmin;
  let hi = hasMax ? nmax : dmax;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;   // no data to fill the auto side
  if (lo > hi) { const t = lo; lo = hi; hi = t; }                  // treat as bounds, keep min<max
  if (lo === hi) { lo -= 0.5; hi += 0.5; }                         // avoid a zero-width axis
  if (isLog) {
    if (hi <= 0) return null;                                      // nothing positive to show
    if (lo <= 0) lo = (Number.isFinite(dmin) && dmin > 0) ? dmin : hi / 1000;
    return [Math.log10(lo), Math.log10(hi)];
  }
  return [lo, hi];
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
  const xa = g._fullLayout.xaxis, ya = g._fullLayout.yaxis, ya2 = g._fullLayout.yaxis2;
  if (!xa || !ya) return;
  const rect = g.getBoundingClientRect();
  const px = e.clientX - rect.left - g._fullLayout.margin.l;
  const py = e.clientY - rect.top - g._fullLayout.margin.t;
  let best = -1, bd = 30 * 30;
  state._markerXY.forEach(({ mi, x, y, axis }) => {
    // c2p applies the axis transform (log10 on a log axis) and each marker's
    // own y axis (primary or secondary), so the hit-test is always correct
    const yax = (axis === "y2" && ya2) ? ya2 : ya;
    const dx = xa.c2p(x) - px, dy = yax.c2p(y) - py;
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
  c.clabel = $("cfg_clabel").value;
  c.legend = $("cfg_legend").checked; c.legend_loc = $("cfg_legloc").value;
  c.grid = $("cfg_grid").checked; c.logx = $("cfg_logx").checked; c.logy = $("cfg_logy").checked;
  c.cmap = $("cfg_cmap").value;
  c.cunit = $("cfg_cscale").value === "—" ? "" : $("cfg_cscale").value;
  c.xunit = $("cfg_xscale").value === "—" ? "" : $("cfg_xscale").value;
  c.yunit = $("cfg_yscale").value === "—" ? "" : $("cfg_yscale").value;
  c.ylabel2 = $("cfg_ylab2").value;
  c.yunit2 = $("cfg_yscale2").value === "—" ? "" : $("cfg_yscale2").value;
  c.logy2 = $("cfg_logy2").checked;
  c.xmin = $("cfg_xmin").value; c.xmax = $("cfg_xmax").value;
  c.ymin = $("cfg_ymin").value; c.ymax = $("cfg_ymax").value;
  c.ymin2 = $("cfg_ymin2").value; c.ymax2 = $("cfg_ymax2").value;
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
  $("cfg_clabel").value = c.clabel || "";
  $("cfg_legend").checked = c.legend; $("cfg_legloc").value = c.legend_loc;
  $("cfg_grid").checked = c.grid; $("cfg_logx").checked = c.logx; $("cfg_logy").checked = c.logy;
  $("cfg_cmap").value = c.cmap;
  $("cfg_cscale").value = c.cunit || "—";
  $("cfg_xscale").value = c.xunit || "—"; $("cfg_yscale").value = c.yunit || "—";
  $("cfg_ylab2").value = c.ylabel2 || ""; $("cfg_yscale2").value = c.yunit2 || "—";
  $("cfg_logy2").checked = !!c.logy2;
  $("cfg_xmin").value = c.xmin || ""; $("cfg_xmax").value = c.xmax || "";
  $("cfg_ymin").value = c.ymin || ""; $("cfg_ymax").value = c.ymax || "";
  $("cfg_ymin2").value = c.ymin2 || ""; $("cfg_ymax2").value = c.ymax2 || "";
  $("cfg_lock").checked = c.lock_size; $("cfg_figw").value = c.figw; $("cfg_figh").value = c.figh;
  $("cfg_figw").disabled = !c.lock_size; $("cfg_figh").disabled = !c.lock_size;
  state._updating = false;
}

// =====================================================================  export
const PNG_DPI = 600;
function exportImage(fmt) {
  const c = state.plotcfg;
  const w = c.lock_size ? Math.round(c.figw * PX_PER_IN) : gd().clientWidth;
  const h = c.lock_size ? Math.round(c.figh * PX_PER_IN) : gd().clientHeight;
  // PNG at 600 DPI relative to the logical (96 px/in) figure size
  const scale = fmt === "png" ? PNG_DPI / PX_PER_IN : 1;
  Plotly.downloadImage(gd(), { format: fmt, width: w, height: h, scale,
    filename: "ncplot_" + stamp() });
  status(`Exported ${fmt.toUpperCase()}${fmt === "png" ? ` (${PNG_DPI} dpi)` : ""}.`);
}

async function exportPDF() {
  const c = state.plotcfg;
  const w = c.lock_size ? Math.round(c.figw * PX_PER_IN) : gd().clientWidth;
  const h = c.lock_size ? Math.round(c.figh * PX_PER_IN) : gd().clientHeight;
  try {
    const uri = await Plotly.toImage(gd(), { format: "svg", width: w, height: h });
    let svgText = decodeURIComponent(uri.replace(/^data:image\/svg\+xml,/, ""));
    // Plotly labels negatives with the Unicode MINUS SIGN (U+2212), which
    // jsPDF's built-in Helvetica can't render (it shows a fallback glyph that
    // looks like "). Swap it for an ASCII hyphen so the vector PDF is clean.
    svgText = svgText.replace(/−/g, "-");
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
  const xf = X.PREFIX_FACTOR[c.xunit] || 1;
  const yfL = X.PREFIX_FACTOR[c.yunit] || 1, yfR = X.PREFIX_FACTOR[c.yunit2] || 1;
  const cf = X.PREFIX_FACTOR[c.cunit] || 1;    // sweep-value (colorbar) scale
  const rows = [];
  let sweepScaled = false;
  for (const t of state.traces) {
    if (t.visible === false) continue;
    const ds = state.dsets.get(t.file);
    if (!ds) continue;
    const yf = t.yaxis === "right" ? yfR : yfL;   // each trace's own axis scale
    const tcf = (t.ssrc || "coord") === "index" ? 1 : cf;   // index is dimensionless — never scale
    const axcol = t.yaxis === "right" ? "right" : "left";
    const { lines } = X.traceLines(ds, t, status);
    for (const ln of lines) {
      const m = Math.min(ln.x.length, ln.y.length);
      const lab = csvField(t.label || t.var);
      const sv = ln.sval == null ? "" : X.fmt6(ln.sval / tcf);   // scaled, as displayed
      if (ln.sval != null && tcf !== 1) sweepScaled = true;
      for (let k = 0; k < m; k++)
        rows.push(`"${lab}",${sv},${ln.x[k] / xf},${ln.y[k] / yf},${axcol}`);
    }
  }
  if (!rows.length) { status("Nothing plotted — nothing to export."); return; }
  let head = "# NC Explorer export (long format)\n";
  const scf = sweepScaled ? cf : 1;            // only claim a sweep scale if one was applied
  if (xf !== 1 || yfL !== 1 || yfR !== 1 || scf !== 1)
    head += `# axis scale: x÷${xf} (${c.xunit || "1"}), y-left÷${yfL} (${c.yunit || "1"}), `
      + `y-right÷${yfR} (${c.yunit2 || "1"}), sweep÷${scf} (${scf !== 1 ? c.cunit : "1"}) — as displayed\n`;
  head += "trace,sweep,x,y,yaxis\n";
  triggerDownload(new Blob([head + rows.join("\n") + "\n"], { type: "text/csv" }), "ncplot_" + stamp() + ".csv");
  status(`Exported ${rows.length} rows.`);
}

// =====================================================================  projects
function saveProject() {
  if (!state.fileOrder.length) { status("Nothing to save yet."); return; }
  downloadProject(state, "ncplot_" + stamp() + ".ncproj");
  status(`Project downloaded — ${state.tabs.length} tab(s); .nc files referenced by name.`);
}

// self-contained save: bundle every open file's bytes into the .ncproj as
// base64. Bytes come from the IndexedDB "files" store (no re-read of the File).
async function saveProjectEmbedded() {
  if (!state.fileOrder.length) { status("Nothing to save yet."); return; }
  status("Bundling .nc data into the project…");
  const files = {};
  let total = 0;
  for (const name of state.fileOrder) {
    let buf = null;
    try { buf = await idbGet("files", name); } catch (e) { /* ignore */ }
    if (!buf) continue;
    total += buf.byteLength;
    files[name] = { size: buf.byteLength, chunks: abToB64Chunks(buf) };
  }
  if (!Object.keys(files).length) {
    status("Could not read file bytes to embed — saved a name-referenced project instead.");
    downloadProject(state, "ncplot_" + stamp() + ".ncproj");
    return;
  }
  const mb = total / 1e6;
  if (total > 200e6 && !confirm(`Embedding ~${mb.toFixed(0)} MB of data makes a ~${(mb * 1.4).toFixed(0)} MB `
    + "project file. Continue?")) { status("Save cancelled."); return; }
  downloadProject(state, "ncplot_" + stamp() + ".ncproj", { embedded: { encoding: "base64", files } });
  status(`Self-contained project downloaded — ${state.tabs.length} tab(s), ~${mb.toFixed(1)} MB embedded.`);
}

function onSaveProject() {
  if ($("chk_embed") && $("chk_embed").checked) saveProjectEmbedded();
  else saveProject();
}

// blank the whole project: drop every file + trace + marker, reset cosmetics to
// defaults, and clear the autosaved session so nothing is restored next time.
async function newProject() {
  const anyTraces = state.tabs.some((tb) => tb.traces.length);
  const hasWork = state.fileOrder.length || anyTraces;
  if (hasWork && !confirm("Start a new project? This clears all open files, every tab, "
    + "markers, and cosmetics. Save your project first if you want to keep it.")) return;
  clearTimeout(_saveTimer);           // cancel any pending autosave of the old state
  state.dsets.clear();
  state.fileOrder = [];
  state.pendingProject = null;
  state.markerMode = false;
  $("btnMarker").classList.remove("active");
  state.tabs = [makeTab("Plot 1")];   // one fresh empty tab
  state.active = 0;
  await clearSession();               // wipe IndexedDB (files + saved project)
  renderTabs();
  applyCfgWidgets();
  rebuildTree();
  rebuildTraceList(-1);
  redraw();
  status("New project — everything cleared. Open a .nc file to begin.");
}

async function loadProjectFile(file) {
  let proj;
  try { proj = parseProject(await file.text()); }
  catch (e) { status("Project load error: " + e.message); return; }
  const still = await applyProject(proj);
  const nTr = state.tabs.reduce((s, tb) => s + tb.traces.length, 0);
  if (still.length) {
    // can't open files by path from the browser — the user must pick the .nc.
    // keep the project pending; cosmetics/tabs are already applied, and it
    // finishes automatically the moment they open the referenced file.
    state.pendingProject = proj;
    status(`Project loaded (${state.tabs.length} tab(s)) — now click "Open .nc…" and select: `
      + `${still.join(", ")} to draw the remaining traces (or drag the .nc + .ncproj in together).`);
  } else {
    state.pendingProject = null;
    status(`Project loaded: ${state.tabs.length} tab(s), ${nTr} trace(s).`);
  }
}

// build one live tab record from a parsed project tab, resolving each trace's
// file against OPEN datasets by basename (skipping traces whose file isn't open)
function buildTabFromParsed(ptab, resolve) {
  const tab = makeTab(ptab.name);
  const projToNew = {};
  const newtraces = [];
  ptab.traces.forEach((t, pi) => {
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
    const color = (typeof t.color === "string" && /^#[0-9a-fA-F]{6}$/.test(t.color)) ? t.color : "";
    projToNew[pi] = newtraces.length;
    newtraces.push({ file: openName, var: t.var, line_dim: ldim, sweep, slices,
      xsrc: String(t.xsrc || "index"), label: String(t.label || t.var),
      sweep_label: String(t.sweep_label || ""), ssrc: String(t.ssrc || "coord"),
      yaxis: t.yaxis === "right" ? "right" : "left", visible: t.visible !== false, color });
  });
  tab.traces = newtraces;
  tab.markers = (ptab.markers || []).filter((m) => projToNew[m.trace] !== undefined)
    .map((m) => ({ trace: projToNew[m.trace], line: Math.max(0, m.line | 0), idx: Math.max(0, m.idx | 0) }));
  tab.plotcfg = ptab.plotcfg;        // cosmetics apply even before the data opens
  tab.cur = tab.traces.length ? 0 : -1;
  return tab;
}

// apply a parsed project: decode any embedded files, rebuild ALL tabs resolving
// file refs by BASENAME against open datasets (desktop projects store absolute
// paths, web store bare names), and RETURN the still-missing file basenames
// (empty when fully applied). Async because embedded HDF5 decode awaits WASM.
async function applyProject(proj) {
  const hasEmbed = proj.embedded && proj.embedded.files && typeof proj.embedded.files === "object";
  // lock tab edits while embedded files decode (the only async window) so a
  // click landing during the await isn't discarded by the wholesale rebuild
  if (hasEmbed) setTabsBusy(true);
  try {
    // 1) decode + register embedded files that aren't already open
    if (hasEmbed) {
      const openBase = new Map(state.fileOrder.map((nm) => [basename(nm).toLowerCase(), nm]));
      for (const [name, entry] of Object.entries(proj.embedded.files)) {
        if (name === "__proto__" || name === "constructor") continue;
        const base = basename(name).toLowerCase();
        if (openBase.has(base)) continue;               // already open — keep it
        if (!entry) continue;
        const sz = Number(entry.size);                  // real compare (not int32 |0)
        if (Number.isFinite(sz) && sz > 2e9) continue;  // refuse absurd declared sizes
        try {
          const buf = b64ChunksToAb(entry);
          const ds = await openBuffer(buf, name);       // HDF5 path is async (WASM)
          state.dsets.set(name, ds);
          state.fileOrder.push(name);
          openBase.set(base, name);
          idbPut("files", name, buf).catch(() => {});   // persist so autosave restores it
        } catch (e) { /* skip a corrupt embedded file; its traces stay missing */ }
      }
      rebuildTree();
    }

    // 2) resolve refs against open datasets
    const openByBase = new Map();
    for (const nm of state.fileOrder) openByBase.set(basename(nm).toLowerCase(), nm);
    const resolve = (f) => openByBase.get(basename(f).toLowerCase()) || null;
    const missing = [...new Set(proj.files.map((f) => basename(f)))]
      .filter((b) => !openByBase.has(b.toLowerCase()));

    // 3) rebuild every tab wholesale (idempotent — re-runnable when files open)
    const built = proj.tabs.map((pt) => buildTabFromParsed(pt, resolve));
    state.tabs = built.length ? built : [makeTab("Plot 1")];
    state.active = Math.max(0, Math.min(proj.active | 0, state.tabs.length - 1));

    refreshTab();     // renderTabs + applyCfgWidgets + rebuildTraceList + redraw
    return missing;
  } finally {
    if (hasEmbed) setTabsBusy(false);
  }
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

// draggable dividers that resize the left / right panels; widths persist
function initSplitters() {
  const layout = $("layout");
  const setW = (leftPx, rightPx) => {
    if (leftPx != null) layout.style.setProperty("--left-w", leftPx + "px");
    if (rightPx != null) layout.style.setProperty("--right-w", rightPx + "px");
    try { Plotly.Plots.resize(gd()); } catch (e) { /* not drawn yet */ }
  };
  try {
    const s = JSON.parse(localStorage.getItem("ncx.panels") || "{}");
    setW(s.left, s.right);
  } catch (e) { /* ignore */ }
  const curW = () => {
    const cs = getComputedStyle(layout);
    return {
      left: parseFloat(cs.getPropertyValue("--left-w")) || 300,
      right: parseFloat(cs.getPropertyValue("--right-w")) || 330,
    };
  };
  const drag = (splitter, which) => {
    if (!splitter) return;
    splitter.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const startX = e.clientX, start = curW();
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      const onMove = (ev) => {
        const dx = ev.clientX - startX;
        if (which === "left") setW(Math.max(180, Math.min(600, start.left + dx)), null);
        else setW(null, Math.max(220, Math.min(640, start.right - dx)));
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.cursor = ""; document.body.style.userSelect = "";
        try { localStorage.setItem("ncx.panels", JSON.stringify(curW())); } catch (e) {}
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
    // double-click a divider resets that panel to its default width
    splitter.addEventListener("dblclick", () => {
      if (which === "left") setW(300, null); else setW(null, 330);
      try { localStorage.setItem("ncx.panels", JSON.stringify(curW())); } catch (e) {}
    });
  };
  drag($("splitL"), "left");
  drag($("splitR"), "right");
}

// =====================================================================  wiring
function init() {
  // populate static selects
  addOpts($("cfg_mode"), ["2D lines", "Rainbow", "3D waterfall"], "2D lines");
  addOpts($("cfg_legloc"), X.LEGEND_LOCS, "best");
  addOpts($("cfg_cmap"), CMAP_NAMES, "Viridis");
  addOpts($("cfg_cscale"), X.UNIT_PREFIXES, "—");
  addOpts($("cfg_xscale"), X.UNIT_PREFIXES, "—");
  addOpts($("cfg_yscale"), X.UNIT_PREFIXES, "—");
  addOpts($("cfg_yscale2"), X.UNIT_PREFIXES, "—");
  applyCfgWidgets();
  renderTabs();

  $("btnOpen").onclick = () => $("fileInput").click();
  $("fileInput").onchange = (e) => { onFilesChosen(e.target.files); e.target.value = ""; };
  $("btnAdd").onclick = addTrace;
  $("btnRemove").onclick = removeTrace;
  $("btnClear").onclick = clearTraces;
  $("ed_ldim").onchange = () => editorChanged("line_dim");
  $("ed_xsrc").onchange = () => editorChanged("xsrc");
  $("ed_sweep").onchange = () => editorChanged("sweep");
  $("ed_ssrc").onchange = () => editorChanged("ssrc");
  $("ed_label").onchange = () => editorChanged("label");
  $("ed_sweeplabel").onchange = () => editorChanged("sweep_label");
  $("ed_yaxis").onchange = () => editorChanged("yaxis");
  $("ed_color").oninput = () => editorChanged("color");
  $("ed_autocolor").onchange = () => editorChanged("autocolor");
  ["cfg_mode", "cfg_title", "cfg_xlab", "cfg_ylab", "cfg_zlab", "cfg_clabel", "cfg_legloc",
    "cfg_cmap", "cfg_cscale", "cfg_xscale", "cfg_yscale", "cfg_ylab2", "cfg_yscale2",
    "cfg_xmin", "cfg_xmax", "cfg_ymin", "cfg_ymax", "cfg_ymin2", "cfg_ymax2",
    "cfg_figw", "cfg_figh"].forEach((id) => {
    $(id).onchange = cfgChanged;
  });
  ["cfg_legend", "cfg_grid", "cfg_logx", "cfg_logy", "cfg_logy2", "cfg_lock"].forEach((id) => {
    $(id).onchange = cfgChanged;
  });
  initSplitters();
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
  $("btnSaveProj").onclick = onSaveProject;
  $("btnLoadProj").onclick = () => $("projInput").click();
  $("projInput").onchange = (e) => { if (e.target.files[0]) loadProjectFile(e.target.files[0]); e.target.value = ""; };
  $("btnNew").onclick = newProject;

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

  // restore an autosaved session, if any, so an accidental tab close lost nothing
  restoreSession().catch(() => {});
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
window.__ncx = { state, redraw, X, openBuffer, onFilesChosen,
  addTab, switchTab, closeTab, duplicateTab, applyProject, buildProject, parseProject };
