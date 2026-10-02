// app.js — NC Explorer (web). Ties the readers, the trace logic, the derived-
// quantity engine and Plotly into the full interactive UI: file open, variable
// tree, traces + sliders, 2D/rainbow/3D plotting, cosmetics, unit scaling,
// markers, exports, multi-tab projects (saved/loaded/autosaved), undo/redo, and
// the multi-page reports (in-browser PDF, or a Python script that regenerates it).

import { openBuffer } from "./dataset.js";
import * as X from "./explore.js";
import * as D from "./derive.js";
import { cmapColor, cmapScale, CMAP_NAMES } from "./colormaps.js";
import { buildProject, projectText, parseProject, triggerDownload,
  abToB64Chunks, b64ChunksToAb, basename } from "./project.js";
import { icon, decorateIcons, h, esc, toast, menu, closeMenu, isMenuOpenFor, modal, modalOpen, ask } from "./ui.js";
import { openBuilder } from "./builder.js";
import { openReportDialog } from "./report.js";

const PX_PER_IN = 96;                 // inches -> px (fixed => consistent export)
// qualitative palette for discrete (non-sweep) traces; index = trace position.
// A per-trace color override (t.color) wins over this; sweep families are
// colored by the colormap instead.
const CYCLE = ["#1565c0", "#c0392b", "#0d6b3f", "#7d3cff", "#e6a700", "#00838f", "#ad1457", "#4e342e"];
// state splits into SHARED fields (datasets and the derived quantities defined
// on them — the left panel, common to all tabs) and PER-TAB fields (each tab is
// its own formatted plot). The per-tab fields are exposed on `state` via
// accessors that transparently forward to the ACTIVE tab, so every call site
// that reads/writes state.traces / markers / cur / plotcfg / drawnMap keeps
// working unchanged.
const state = {
  dsets: new Map(),                   // display name -> Dataset      (SHARED)
  fileOrder: [],                      // SHARED
  derived: [],                        // SHARED: derived-quantity defs (see derive.js), creation order
  derivedStatus: new Map(),           // SHARED: "file\0name" -> {ok, error}
  wantedFiles: [],                    // SHARED: files a loaded project refers to that aren't open yet
  projectOrder: [],                   // SHARED: lowercased basenames, in the loaded project's file order
  markerMode: false,                  // SHARED (global UI toggle)
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
function status(msg) { const el = $("status"); el.textContent = msg; el.title = msg; }

// ================================================================  autosave (IndexedDB)
// Persists the whole working session — the opened files' bytes AND the project
// (tabs, traces, derived quantities, cosmetics, markers) — so an accidental tab
// close loses nothing. Files go in the "files" store (ArrayBuffers), the
// project JSON in "meta". Restored on next load.
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
    captureHistory();
    const anyTraces = state.tabs.some((tb) => tb.traces.length);
    if (!state.fileOrder.length && !anyTraces && !state.derived.length) return;
    // autosave never embeds — file bytes already live in the "files" store
    idbPut("meta", "project", JSON.stringify(buildProject(state)))
      .then(() => {
        const d = new Date(), p = (n) => String(n).padStart(2, "0");
        $("saveState").textContent = `✓ autosaved ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
      })
      .catch(() => { $("saveState").textContent = "⚠ autosave unavailable"; });
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
  let projText;
  try { projText = await idbGet("meta", "project"); } catch (e) { projText = null; }
  if (projText) {
    try { await applyProject(parseProject(projText)); } catch (e) { /* ignore bad project */ }
  }
  rebuildTree();
  refreshTab();
  resetHistory();
  const nTr = state.tabs.reduce((s, tb) => s + tb.traces.length, 0);
  const msg = `Restored ${state.fileOrder.length} file(s), ${state.tabs.length} tab(s), ${nTr} trace(s)`
    + (state.derived.length ? ` and ${state.derived.length} derived quantit${state.derived.length === 1 ? "y" : "ies"}` : "")
    + " from your last session.";
  status(msg);
  if (state.fileOrder.length) toast(msg, "ok");
  return true;
}

async function clearSession() {
  try { await idbClearStore("files"); await idbDel("meta", "project"); } catch (e) { /* ignore */ }
}

// ================================================================  undo / redo
// Snapshot-based: every settled change (the same debounce as the autosave)
// pushes the canonical project JSON; undo/redo re-applies a snapshot. The
// snapshots never contain file bytes, so files closed in the meantime come
// back as "missing" (their traces resolve again when the file is re-opened).
const hist = { stack: [], idx: -1, applying: false };
function snapshotText() {
  const p = buildProject(state);
  delete p.created;
  return JSON.stringify(p);
}
function captureHistory() {
  if (hist.applying) return;
  const s = snapshotText();
  if (hist.idx >= 0 && hist.stack[hist.idx] === s) return;
  hist.stack = hist.stack.slice(0, hist.idx + 1);
  hist.stack.push(s);
  if (hist.stack.length > 120) hist.stack.shift();
  hist.idx = hist.stack.length - 1;
  updateUndoButtons();
}
function resetHistory() {
  hist.stack = [snapshotText()];
  hist.idx = 0;
  updateUndoButtons();
}
function updateUndoButtons() {
  $("btnUndo").disabled = hist.idx <= 0;
  $("btnRedo").disabled = hist.idx >= hist.stack.length - 1;
}
async function applySnapshot(s) {
  hist.applying = true;
  try { await applyProject(parseProject(s)); }
  finally { hist.applying = false; }
  updateUndoButtons();
}
async function undo() {
  if (state._loadingProject) return;
  // fold a change that hasn't settled yet into history first, so it is undoable
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; captureHistory(); scheduleSave(); }
  if (hist.idx <= 0) { status("Nothing to undo."); return; }
  hist.idx--;
  await applySnapshot(hist.stack[hist.idx]);
  status("Undone.");
}
async function redo() {
  if (state._loadingProject) return;
  if (hist.idx >= hist.stack.length - 1) { status("Nothing to redo."); return; }
  hist.idx++;
  await applySnapshot(hist.stack[hist.idx]);
  status("Redone.");
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
  add.onclick = () => addTab();
  bar.appendChild(add);
}

function addTab(name) {
  if (state._loadingProject) return null;
  const tb = makeTab(name ? uniqueTabName(name) : undefined);
  state.tabs.push(tb);
  state.active = state.tabs.length - 1;
  refreshTab();
  return tb;
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

function moveTab(i, dir) {
  const j = i + dir;
  if (state._loadingProject || j < 0 || j >= state.tabs.length) return;
  const [tb] = state.tabs.splice(i, 1);
  state.tabs.splice(j, 0, tb);
  if (state.active === i) state.active = j;
  else if (state.active === j) state.active = i;
  refreshTab();
}

// duplicate a tab with its traces switched from one data file to another
// (copying the derived-quantity recipes those traces plot) — "same plots for
// the next measurement"
function duplicateTabForFile(i) {
  const src = state.tabs[i];
  const used = [...new Set(src.traces.map((t) => t.file))].filter((f) => state.dsets.has(f));
  if (!used.length) { toast("This tab has no traces from an open file.", "warn"); return; }
  if (state.fileOrder.length < 2) { toast("Open the other .nc file first.", "warn"); return; }
  const fromSel = h("select"), toSel = h("select");
  addOpts(fromSel, used, used[0]);
  const fillTo = () => { toSel.innerHTML = ""; addOpts(toSel, state.fileOrder.filter((f) => f !== fromSel.value), ""); };
  fromSel.onchange = fillTo; fillTo();
  modal({
    title: `Duplicate “${src.name}” for another file`, cls: "small", enterButton: "ok",
    body: h("div", {},
      h("p", { class: "hint", text: "Makes a copy of this tab whose traces read the other file instead — e.g. the same "
        + "plots for the next measurement. Derived quantities the traces use are copied to that file too." }),
      h("div", { class: "form-grid" }, h("label", { text: "Replace" }), fromSel, h("label", { text: "with" }), toSel)),
    buttons: [{ spacer: true }, { label: "Cancel", kind: "ghost", id: "cancel" },
      { label: "Duplicate", kind: "primary", id: "ok", onClick: () => {
        const from = fromSel.value, to = toSel.value;
        if (!to) return false;
        const tds = state.dsets.get(to);
        // derived recipes the traces need (x / sweep sources included)
        const needed = new Set();
        for (const t of src.traces) {
          if (t.file !== from) continue;
          for (const n of [t.var, t.xsrc.startsWith("var:") ? t.xsrc.slice(4) : "", t.ssrc.startsWith("var:") ? t.ssrc.slice(4) : ""])
            if (n && findDef(from, n)) needed.add(n);
        }
        const copied = [];
        for (const n of needed) if (!findDef(to, n) && !tds.has(n)) copied.push(...(applyDerivedToFile(from, n, to, true) || []));
        const copy = makeTab(uniqueTabName(`${src.name} — ${basename(to).replace(/\.[^.]+$/, "")}`));
        copy.traces = src.traces.map((t) => ({ ...t, slices: { ...t.slices }, file: t.file === from ? to : t.file }));
        copy.markers = src.markers.map((m) => ({ ...m }));
        copy.plotcfg = { ...src.plotcfg };
        copy.cur = src.cur;
        copy.traces.forEach(normalizeTrace);
        state.tabs.splice(i + 1, 0, copy);
        state.active = i + 1;
        refreshTab();
        const bad = copy.traces.filter((t) => traceProblem(t));
        if (bad.length) toast(`${bad.length} trace(s) can't be drawn from ${to}: ${traceProblem(bad[0])}`, "warn", 9000);
        else toast(`New tab “${copy.name}” plots ${to}`
          + (copied.length ? ` (derived quantities copied: ${[...new Set(copied)].join(", ")})` : "") + ".", "ok");
      } }],
  });
}

// right-click menu on a tab
function showTabMenu(i, x, y) {
  menu({ x, y }, [
    { label: "Rename…", icon: "edit", onClick: () => { const el = $("tabbar").querySelectorAll(".tab-name")[i]; if (el) beginRename(i, el); } },
    { label: "Duplicate", onClick: () => duplicateTab(i) },
    { label: "Duplicate for another file…", title: "same plots, reading another (open) .nc file", onClick: () => duplicateTabForFile(i) },
    { sep: true },
    { label: "Move left", disabled: i === 0, onClick: () => moveTab(i, -1) },
    { label: "Move right", disabled: i === state.tabs.length - 1, onClick: () => moveTab(i, 1) },
    { sep: true },
    { label: "Close", danger: true, onClick: () => closeTab(i) },
  ]);
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

async function closeTab(i) {
  if (state._loadingProject) return;
  const tp = state.tabs[i];
  if ((tp.traces.length || tp.markers.length)
      && !(await ask(`Close "${tp.name}"? Its ${tp.traces.length} trace(s) will be discarded (Undo brings them back).`,
        { title: "Close tab", ok: "Close tab", danger: true }))) return;
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
  const cur = activeTab().cur;
  rebuildTraceList(cur >= 0 && cur < state.traces.length ? cur : (state.traces.length ? 0 : -1));
  redraw();              // repaints #plot and fires scheduleSave
}

// =====================================================================  files
async function openFile(file) {
  const name = file.name;
  if (state.dsets.has(name)) return { name, reused: true };   // kept, not reloaded
  const buf = await file.arrayBuffer();
  let ds;
  try { ds = await openBuffer(buf, name); }   // HDF5 path is async (WASM)
  catch (e) { toast(`Cannot open ${name}: ${e.message}`, "error"); return null; }
  state.dsets.set(name, ds);
  state.fileOrder.push(name);
  idbPut("files", name, buf).catch(() => {});   // persist for session restore
  return { name, reused: false };
}

async function onFilesChosen(fileList) {
  const opened = [], reused = [];
  const waiting = new Set(missingFiles().map((f) => f.toLowerCase()));   // before opening
  status("Opening…");
  for (const f of fileList) {
    const r = await openFile(f);
    if (!r) continue;
    (r.reused ? reused : opened).push(r.name);
  }
  rebindAll();            // traces / derived quantities waiting for these files resolve now
  rebuildTree();
  const reusedNote = reused.length ? `  (already open, not reloaded: ${reused.join(", ")})` : "";
  if (opened.some((nm) => waiting.has(basename(nm).toLowerCase()))) {
    const still = missingFiles();
    refreshTab();
    if (!still.length) {
      const nTr = state.tabs.reduce((s, tb) => s + tb.traces.length, 0);
      toast(`Project complete: ${state.tabs.length} tab(s), ${nTr} trace(s).`, "ok");
      status(`Opened ${opened.join(", ")} — project complete.`);
    } else status(`Opened ${opened.join(", ")}. The project still needs: ${still.join(", ")}.`);
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
  redraw();
  const head = opened.length ? `Opened ${opened.join(", ")}.` : "No new files opened.";
  status(`${head}${reusedNote} Double-click a variable to plot it.`);
}

async function openSample() {
  try {
    const res = await fetch("sample/demo.nc");
    if (!res.ok) throw new Error(res.status + " " + res.statusText);
    const buf = await res.arrayBuffer();
    await onFilesChosen([new File([buf], "demo.nc")]);
    if (!state.traces.length && state.dsets.has("demo.nc")) {
      const ds = state.dsets.get("demo.nc");
      if (ds.has("signal")) {
        const t = X.defaultTrace(ds, "signal", "demo.nc");
        if (ds.variable("signal").dims.includes("temperature")) {
          t.sweep = "temperature"; delete t.slices.temperature;
        }
        state.traces.push(t);
        rebuildTraceList(0); redraw();
      }
    }
    toast("Sample loaded: 'signal' along time, one line per temperature. Try the frequency slider →", "ok");
  } catch (e) { toast("Could not load the sample: " + e.message, "error"); }
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

async function closeFile(name) {
  // datasets are shared: a closed file's traces must be purged from EVERY tab
  const used = state.tabs.reduce((s, tb) => s + tb.traces.filter((t) => t.file === name).length, 0);
  const nDer = state.derived.filter((d) => d.file === name).length;
  if ((used || nDer) && !(await ask(
    `Close ${name}? ${used ? `${used} trace(s) across all tabs` : ""}${used && nDer ? " and " : ""}`
    + `${nDer ? `${nDer} derived quantit${nDer === 1 ? "y" : "ies"}` : ""} use it and will be removed.`,
    { title: "Close file", ok: "Close file", danger: true }))) return;
  state.dsets.delete(name);
  state.fileOrder = state.fileOrder.filter((f) => f !== name);
  state.wantedFiles = state.wantedFiles.filter((f) => basename(f).toLowerCase() !== basename(name).toLowerCase());
  state.derived = state.derived.filter((d) => d.file !== name);
  idbDel("files", name).catch(() => {});
  state.tabs.forEach((tp) => pruneFileFromTab(tp, name));
  if (selTreeVar && selTreeVar.file === name) selTreeVar = null;
  rebuildTree();
  rebuildTraceList(activeTab().cur);   // active tab's already-remapped selection
  redraw();
}

// ================================================================  file resolution
// Traces and derived quantities refer to files by display name (= basename).
// A project can reference files that aren't open yet; those records are KEPT
// (not drawn) and bound to the dataset as soon as a file with that basename is
// opened — so nothing is ever silently dropped from a project.
function resolver() {
  const byBase = new Map();
  for (const nm of state.fileOrder) byBase.set(basename(nm).toLowerCase(), nm);
  return (f) => (f && (state.dsets.has(f) ? f : byBase.get(basename(f).toLowerCase()))) || null;
}

function missingFiles() {
  const resolve = resolver();
  const out = [], seen = new Set();
  const add = (f) => {
    if (!f) return;
    const b = basename(f);
    if (seen.has(b.toLowerCase()) || resolve(f)) return;
    seen.add(b.toLowerCase()); out.push(b);
  };
  for (const tb of state.tabs) for (const t of tb.traces) add(t.file);
  for (const d of state.derived) add(d.file);
  for (const f of state.wantedFiles) add(f);
  return out;
}

// repair a trace's dims against its (now open) dataset
function normalizeTrace(t) {
  const ds = state.dsets.get(t.file);
  if (!ds || !ds.has(t.var)) return;
  const dims = ds.variable(t.var).dims;
  if (!dims.length) return;
  if (!dims.includes(t.line_dim)) t.line_dim = dims[dims.length - 1];
  if (t.sweep && (!dims.includes(t.sweep) || t.sweep === t.line_dim)) t.sweep = "";
}

// bind every trace / derived def to the open datasets, (re)compute the derived
// variables, and forget wanted files that are now open
function rebindAll() {
  // datasets listed in the project's file order (then any others, as opened)
  const rank = new Map(state.projectOrder.map((b, i) => [b, i]));
  const r = (f) => { const k = rank.get(basename(f).toLowerCase()); return k === undefined ? Infinity : k; };
  state.fileOrder = state.fileOrder.map((f, i) => [f, i]).sort((a, b) => (r(a[0]) - r(b[0])) || (a[1] - b[1])).map((e) => e[0]);
  const resolve = resolver();
  for (const d of state.derived) { const r = resolve(d.file); if (r && r !== d.file) d.file = r; }
  registerAllDerived();
  for (const tb of state.tabs) for (const t of tb.traces) {
    const r = resolve(t.file);
    if (r) { if (r !== t.file) t.file = r; normalizeTrace(t); }
  }
  state.wantedFiles = state.wantedFiles.filter((f) => !resolve(f));
}

// why a trace can't be drawn right now (null = fine)
function traceProblem(t) {
  const ds = state.dsets.get(t.file);
  if (!ds) return `file not open: ${t.file}`;
  if (!ds.has(t.var)) {
    const d = state.derived.find((q) => q.file === t.file && q.name === t.var);
    if (d) {
      const st = state.derivedStatus.get(dkey(d));
      return `derived quantity '${t.var}' is not available${st && st.error ? ": " + st.error : ""}`;
    }
    return `variable '${t.var}' not found in ${t.file}`;
  }
  return null;
}

function updateBanner() {
  const miss = missingFiles();
  const el = $("banner");
  if (!miss.length) { el.hidden = true; el.innerHTML = ""; return; }
  el.hidden = false;
  el.innerHTML = "";
  el.append(
    h("span", { html: icon("warn") }),
    h("span", { class: "bmsg", html: `This project needs <b>${miss.map(esc).join(", ")}</b> — open `
      + `${miss.length === 1 ? "it" : "them"} and the waiting traces and derived quantities appear automatically.` }),
    h("button", { class: "primary", text: "Open files…", onclick: () => $("fileInput").click() }),
    h("button", { class: "ghost", text: "Forget", title: "remove the traces and derived quantities that need these files",
      onclick: forgetMissing }));
}

async function forgetMissing() {
  const miss = new Set(missingFiles().map((f) => f.toLowerCase()));
  if (!miss.size) return;
  if (!(await ask("Remove every trace and derived quantity that needs a file that isn't open?",
    { title: "Forget missing files", ok: "Remove", danger: true }))) return;
  const isMissing = (f) => miss.has(basename(f).toLowerCase());
  state.wantedFiles = state.wantedFiles.filter((f) => !isMissing(f));
  state.derived = state.derived.filter((d) => !isMissing(d.file));
  for (const tp of state.tabs) {
    for (const f of new Set(tp.traces.map((t) => t.file).filter(isMissing))) pruneFileFromTab(tp, f);
  }
  rebuildTraceList(activeTab().cur);
  redraw();
}

// ================================================================  derived quantities
function dkey(d) { return d.file + "\u0000" + d.name; }
function findDef(file, name) { return state.derived.find((d) => d.file === file && d.name === name) || null; }

// (re)compute the derived variables of one open file; records each def's status
function registerFile(name) {
  const ds = state.dsets.get(name);
  if (!ds) return;
  const defs = state.derived.filter((d) => d.file === name);
  let res;
  try { res = D.registerDerived(ds, defs); }
  catch (e) { res = new Map(defs.map((d) => [d.name, { ok: false, error: e.message }])); }
  for (const d of defs) state.derivedStatus.set(dkey(d), res.get(d.name) || { ok: false, error: "not computed" });
}
function registerAllDerived() {
  state.derivedStatus.clear();
  for (const name of state.fileOrder) registerFile(name);
}

// update every reference to a renamed derived variable (traces, other defs)
function renameRefs(file, oldName, newName) {
  if (oldName === newName) return;
  for (const tb of state.tabs) for (const t of tb.traces) {
    if (t.file !== file) continue;
    if (t.var === oldName) t.var = newName;
    if (t.xsrc === "var:" + oldName) t.xsrc = "var:" + newName;
    if (t.ssrc === "var:" + oldName) t.ssrc = "var:" + newName;
  }
  for (const d of state.derived) {
    if (d.file !== file) continue;
    for (const k of ["src", "a"]) if (d[k] === oldName) d[k] = newName;
    if (d.b === oldName) d.b = newName;
    if (d.xsrc === "var:" + oldName) d.xsrc = "var:" + newName;
    if (d.window && d.window.center === "var:" + oldName) d.window.center = "var:" + newName;
  }
}

// save defs from the builder. `replace` = {file, name} of the def being edited.
// `plot` = optional [{name, line_dim, sweep, slices, xsrc, yaxis}] traces to add,
// `where` = "here" | "new" (tab)
function commitDerived(defs, { replace = null, plot = null, where = "here" } = {}) {
  if (replace) {
    const i = state.derived.findIndex((d) => d.file === replace.file && d.name === replace.name);
    const nd = defs[0];
    if (i >= 0) {
      state.derived[i] = nd;
      renameRefs(nd.file, replace.name, nd.name);
    } else state.derived.push(nd);
    for (const d of defs.slice(1)) state.derived.push(d);
  } else {
    for (const d of defs) state.derived.push(d);
  }
  const file = defs[0].file;
  registerFile(file);
  const failed = defs.filter((d) => !(state.derivedStatus.get(dkey(d)) || {}).ok);
  if (plot && plot.length) {
    if (where === "new") addTab(defs[0].name);
    const ds = state.dsets.get(file);
    for (const p of plot) {
      if (!ds || !ds.has(p.name)) continue;
      const t = X.defaultTrace(ds, p.name, file);
      const dims = ds.variable(p.name).dims;
      if (p.line_dim && dims.includes(p.line_dim)) t.line_dim = p.line_dim;
      t.sweep = (p.sweep && dims.includes(p.sweep) && p.sweep !== t.line_dim) ? p.sweep : "";
      t.slices = {};
      for (const d of dims) if (d !== t.line_dim && d !== t.sweep) t.slices[d] = (p.slices && p.slices[d]) | 0;
      t.xsrc = p.xsrc || D.suggestXsrc(ds, p.name, t.line_dim) || "index";
      t.draw = "lines+markers";
      if (p.yaxis) t.yaxis = p.yaxis;
      state.traces.push(t);
    }
    rebuildTraceList(state.traces.length - 1);
  }
  rebuildTree();
  if (selTreeVar && selTreeVar.file === file) showInfo(file, selTreeVar.var);
  populateEditor(); rebuildSliders();
  redraw();
  if (failed.length) toast(`Saved, but ${failed.map((d) => d.name).join(", ")} could not be computed: `
    + ((state.derivedStatus.get(dkey(failed[0])) || {}).error || "error"), "warn");
  else toast(`Derived quantit${defs.length === 1 ? "y" : "ies"} saved: ${defs.map((d) => d.name).join(", ")}`, "ok");
}

function builderCtx() {
  return { state, X, D, findDef, commitDerived, toast, status, dkey };
}
function newDerived(file, src) {
  if (!state.fileOrder.length) { toast("Open a .nc file first — derived quantities are computed from its variables.", "warn"); return; }
  openBuilder(builderCtx(), { file: file || (selTreeVar && selTreeVar.file) || state.fileOrder[0],
    src: src || (selTreeVar && file === undefined ? selTreeVar.var : src) });
}
function editDerived(file, name) {
  const d = findDef(file, name);
  if (d) openBuilder(builderCtx(), { edit: d });
}
function duplicateDerived(file, name) {
  const d = findDef(file, name);
  if (!d) return;
  const copy = JSON.parse(JSON.stringify(d));
  let n = 2;
  while (findDef(file, `${d.name}_${n}`) || (state.dsets.get(file) || { has: () => false }).has(`${d.name}_${n}`)) n++;
  copy.name = `${d.name}_${n}`.slice(0, 64);
  openBuilder(builderCtx(), { edit: copy, asNew: true });
}
async function deleteDerived(file, name) {
  const d = findDef(file, name);
  if (!d) return;
  const users = state.tabs.reduce((s, tb) => s + tb.traces.filter((t) => t.file === file && t.var === name).length, 0);
  const dependents = state.derived.filter((q) => q.file === file && q !== d && D.depsOf(q).includes(name)).map((q) => q.name);
  const why = [users ? `${users} trace(s) plot it` : "", dependents.length ? `${dependents.join(", ")} depend${dependents.length === 1 ? "s" : ""} on it` : ""]
    .filter(Boolean).join("; ");
  if (!(await ask(`Delete the derived quantity '${name}'?${why ? `\n\n${why} — they will show as unavailable until you recreate it (or Undo).` : ""}`,
    { title: "Delete derived quantity", ok: "Delete", danger: true }))) return;
  state.derived = state.derived.filter((q) => q !== d);
  registerFile(file);
  if (selTreeVar && selTreeVar.file === file && selTreeVar.var === name) selTreeVar = null;
  rebuildTree(); rebuildTraceList(state.cur); redraw();
}

// copy a def (and the derived quantities it depends on) onto another open file
function applyDerivedToFile(file, name, target, quiet = false) {
  const d = findDef(file, name);
  const tds = state.dsets.get(target);
  if (!d || !tds) return;
  // transitive closure of derived deps, dependencies first
  const chain = [], seen = new Set();
  const visit = (q) => {
    if (seen.has(q.name)) return;
    seen.add(q.name);
    for (const dep of D.depsOf(q)) { const qd = findDef(file, dep); if (qd) visit(qd); }
    chain.push(q);
  };
  visit(d);
  const added = [], skipped = [];
  for (const q of chain) {
    if (findDef(target, q.name)) { skipped.push(q.name); continue; }
    if (tds.has(q.name)) { skipped.push(q.name + " (a real variable has that name)"); continue; }
    const c = JSON.parse(JSON.stringify(q));
    c.file = target;
    state.derived.push(c);
    added.push(c);
  }
  registerFile(target);
  const bad = added.filter((q) => !(state.derivedStatus.get(dkey(q)) || {}).ok);
  if (bad.length) {
    // all or nothing: a recipe that doesn't fit the target's data isn't copied
    const why = (state.derivedStatus.get(dkey(bad[0])) || {}).error || "error";
    state.derived = state.derived.filter((q) => !added.includes(q));
    registerFile(target);
    if (!quiet) toast(`'${name}' doesn't fit ${target}: ${why}`, "warn", 9000);
    return [];
  }
  rebuildTree(); redraw();
  if (quiet) return added.map((q) => q.name);
  if (!added.length) toast(`Nothing copied — ${target} already has ${skipped.join(", ")}.`, "warn");
  else toast(`Copied ${added.map((q) => q.name).join(", ")} to ${target}`
    + (skipped.length ? ` (kept existing: ${skipped.join(", ")})` : "") + ". Find them under ƒ in its tree.", "ok");
  return added.map((q) => q.name);
}

function exportRecipes(file, names) {
  const defs = state.derived.filter((d) => d.file === file && (!names || names.includes(d.name)));
  if (!defs.length) { toast("No derived quantities to export.", "warn"); return; }
  const out = { format: "nc_explorer_recipe_v1", created: new Date().toISOString(),
    derived: defs.map((d) => { const c = D.canonicalDef(d); delete c.file; return c; }) };
  triggerDownload(new Blob([JSON.stringify(out, null, 2)], { type: "application/json" }),
    `${(names && names.length === 1 ? names[0] : basename(file).replace(/\.[^.]+$/, "")) }_recipe.json`);
  toast(`Exported ${defs.length} recipe(s). Import them onto another file from its ⋯ menu.`, "ok");
}

let _recipeTarget = null;
function importRecipeInto(file) { _recipeTarget = file; $("recipeInput").click(); }
async function onRecipeChosen(f) {
  const target = _recipeTarget; _recipeTarget = null;
  if (!f || !target || !state.dsets.has(target)) return;
  let raw;
  try { raw = JSON.parse(await f.text()); } catch (e) { toast("Not a valid recipe file: " + e.message, "error"); return; }
  const list = raw && raw.format === "nc_explorer_recipe_v1" && Array.isArray(raw.derived) ? raw.derived
    : (raw && Array.isArray(raw.derived) ? raw.derived : null);   // a .ncproj works too
  if (!list) { toast("Not an NC Explorer recipe (or project) file.", "error"); return; }
  const added = [], skipped = [];
  for (const r of list.slice(0, D.MAX_DERIVED)) {
    const d = D.sanitizeDef({ ...r, file: target });
    if (!d) continue;
    if (findDef(target, d.name) || state.dsets.get(target).has(d.name)) { skipped.push(d.name); continue; }
    d.file = target;
    state.derived.push(d); added.push(d);
  }
  registerFile(target);
  // recipes that don't fit this file's data are dropped (with the reason)
  const bad = added.filter((q) => !(state.derivedStatus.get(dkey(q)) || {}).ok);
  const why = bad.length ? (state.derivedStatus.get(dkey(bad[0])) || {}).error : "";
  if (bad.length) {
    state.derived = state.derived.filter((q) => !bad.includes(q));
    registerFile(target);
  }
  rebuildTree(); redraw();
  const ok = added.length - bad.length;
  toast(`Imported ${ok} recipe(s) onto ${target}`
    + (skipped.length ? `; skipped (name taken): ${skipped.join(", ")}` : "")
    + (bad.length ? `; not imported (don't fit): ${bad.map((q) => q.name).join(", ")} — ${why}` : "") + ".",
  bad.length || !ok ? "warn" : "ok", bad.length ? 10000 : undefined);
}

// =====================================================================  tree
let selTreeVar = null;
const collapsedFiles = new Set();

function rebuildTree() {
  const tree = $("tree");
  tree.innerHTML = "";
  const q = ($("treeFilter").value || "").trim().toLowerCase();
  $("dsCount").textContent = state.fileOrder.length ? `${state.fileOrder.length} file(s)` : "";
  if (!state.fileOrder.length) {
    tree.appendChild(h("div", { class: "tree-empty", html: "No files open. Click <b>Open .nc…</b> or drop files anywhere." }));
  }
  for (const name of state.fileOrder) {
    const ds = state.dsets.get(name);
    const top = h("div", { class: "tree-file" + (collapsedFiles.has(name) && !q ? " collapsed" : "") });
    const fmeta = `${ds.varNames().filter((n) => !ds.vars[n].derived).length} vars`;
    const hdr = h("div", { class: "tree-file-hdr", title: name + " — click to collapse/expand · right-click for options" },
      h("span", { class: "chev", html: icon("chevron") }),
      h("span", { class: "fname", text: name }),
      h("span", { class: "fmeta", text: fmeta }));
    const fx = h("button", { class: "icon", title: "New derived quantity on this file", html: icon("func") });
    fx.onclick = (e) => { e.stopPropagation(); newDerived(name); };
    const more = h("button", { class: "icon", title: "File options", html: icon("more") });
    more.onclick = (e) => { e.stopPropagation(); fileMenu(name, more); };
    const x = h("button", { class: "icon", title: "Close this file", html: icon("close") });
    x.onclick = (e) => { e.stopPropagation(); closeFile(name); };
    hdr.append(fx, more, x);
    hdr.onclick = () => {
      if (collapsedFiles.has(name)) collapsedFiles.delete(name); else collapsedFiles.add(name);
      top.classList.toggle("collapsed");
    };
    hdr.oncontextmenu = (e) => { e.preventDefault(); fileMenu(name, { x: e.clientX, y: e.clientY }); };
    top.appendChild(hdr);
    const body = h("div", { class: "tree-body" });
    const match = (vn) => !q || vn.toLowerCase().includes(q);
    let shown = 0;
    const listVars = (names, kind) => {
      for (const vn of names) {
        if (!match(vn)) continue;
        shown++;
        const v = ds.variable(vn);
        const row = h("div", { class: "tree-var" + (v.isNumeric() ? "" : " nonnum"), role: "treeitem" });
        const dimtxt = v.dims.map((d) => `${d}:${ds.size(d)}`).join(" × ") || "scalar";
        if (kind === "coord") row.appendChild(h("span", { class: "badge coord", title: "coordinate variable", text: "c" }));
        row.append(h("span", { class: "vn", text: vn }), h("span", { class: "vd", text: dimtxt }));
        row.title = `${vn} (${dimtxt})` + (v.isNumeric() ? " — double-click to plot · right-click for options" : " — non-numeric (text)");
        row.onclick = () => selectTreeVar(name, vn, row);
        row.ondblclick = () => { selectTreeVar(name, vn, row); addTrace(); };
        row.oncontextmenu = (e) => { e.preventDefault(); selectTreeVar(name, vn, row); varMenu(name, vn, { x: e.clientX, y: e.clientY }); };
        if (selTreeVar && selTreeVar.file === name && selTreeVar.var === vn) row.classList.add("sel");
        body.appendChild(row);
      }
    };
    const real = ds.varNames().filter((n) => !ds.vars[n].derived);
    listVars(real.filter((n) => !ds.isCoord(n)), "data");
    listVars(real.filter((n) => ds.isCoord(n)), "coord");
    // derived quantities of this file (incl. ones that failed to compute)
    const defs = state.derived.filter((d) => d.file === name && match(d.name));
    if (defs.length) {
      body.appendChild(h("div", { class: "tree-sub", text: "ƒ derived quantities" }));
      for (const d of defs) {
        shown++;
        const st = state.derivedStatus.get(dkey(d)) || { ok: false, error: "not computed" };
        const v = st.ok ? ds.variable(d.name) : null;
        const row = h("div", { class: "tree-var derived" + (st.ok ? "" : " error"), role: "treeitem" });
        const dimtxt = v ? (v.dims.map((dd) => `${dd}:${ds.size(dd)}`).join(" × ") || "scalar") : "error";
        row.append(h("span", { class: "badge fx", text: "ƒ" }), h("span", { class: "vn", text: d.name }),
          h("span", { class: "vd", text: dimtxt }));
        const acts = h("span", { class: "acts" });
        const ed = h("button", { class: "icon", title: "Edit…", html: icon("edit") });
        ed.onclick = (e) => { e.stopPropagation(); editDerived(name, d.name); };
        const mo = h("button", { class: "icon", title: "More…", html: icon("more") });
        mo.onclick = (e) => { e.stopPropagation(); selectTreeVar(name, d.name, row); varMenu(name, d.name, mo); };
        acts.append(ed, mo);
        row.appendChild(acts);
        row.title = (st.ok ? D.describeDef(d) : `Error: ${st.error}`) + "\nclick: info · double-click: plot · ✎ edit";
        row.onclick = () => selectTreeVar(name, d.name, row);
        row.ondblclick = () => { selectTreeVar(name, d.name, row); if (st.ok) addTrace(); else editDerived(name, d.name); };
        row.oncontextmenu = (e) => { e.preventDefault(); selectTreeVar(name, d.name, row); varMenu(name, d.name, { x: e.clientX, y: e.clientY }); };
        if (selTreeVar && selTreeVar.file === name && selTreeVar.var === d.name) row.classList.add("sel");
        body.appendChild(row);
      }
    }
    if (q && !shown) continue;            // filter: hide files with no match
    top.appendChild(body);
    tree.appendChild(top);
  }
  if (q && !tree.children.length) tree.appendChild(h("div", { class: "tree-empty", text: `No variable matches "${q}".` }));
  updateAddButton();
  updateBanner();
}

function updateAddButton() {
  let ok = false;
  if (selTreeVar) {
    const ds = state.dsets.get(selTreeVar.file);
    const v = ds && ds.variable(selTreeVar.var);
    ok = !!(v && v.isNumeric() && v.ndim > 0);
  }
  $("btnAdd").disabled = !ok;
}

function fileMenu(name, at) {
  const others = state.fileOrder.filter((f) => f !== name);
  const nDer = state.derived.filter((d) => d.file === name).length;
  menu(at, [
    { label: "New derived quantity…", icon: "func", onClick: () => newDerived(name) },
    { label: "Import recipe…", title: "add derived-quantity recipes saved from another file", onClick: () => importRecipeInto(name) },
    { label: "Export all recipes…", disabled: !nDer, onClick: () => exportRecipes(name) },
    { sep: true },
    { label: collapsedFiles.has(name) ? "Expand" : "Collapse", onClick: () => {
      if (collapsedFiles.has(name)) collapsedFiles.delete(name); else collapsedFiles.add(name); rebuildTree(); } },
    { label: "Collapse all others", disabled: !others.length, onClick: () => { others.forEach((f) => collapsedFiles.add(f)); collapsedFiles.delete(name); rebuildTree(); } },
    { sep: true },
    { label: "Close file", icon: "close", danger: true, onClick: () => closeFile(name) },
  ]);
}

function varMenu(file, vn, at) {
  const ds = state.dsets.get(file);
  const v = ds && ds.variable(vn);
  const d = findDef(file, vn);
  const plottable = !!(v && v.isNumeric() && v.ndim > 0);
  const others = state.fileOrder.filter((f) => f !== file);
  const items = [
    { label: "Plot in this tab", hint: "dbl-click", disabled: !plottable, onClick: () => addTrace() },
    { label: "Plot in a new tab", disabled: !plottable, onClick: () => { addTab(vn); selTreeVar = { file, var: vn }; addTrace(); } },
    { sep: true },
    { label: "Derive from this variable…", icon: "func", disabled: !plottable,
      title: "peak / floor / mean / … over one of its dimensions, in a window", onClick: () => newDerived(file, vn) },
  ];
  if (d) {
    items.push(
      { sep: true }, { header: "Derived quantity" },
      { label: "Edit…", icon: "edit", onClick: () => editDerived(file, vn) },
      { label: "Duplicate…", onClick: () => duplicateDerived(file, vn) },
      ...(others.length
        ? [{ header: "Copy recipe to" }, ...others.map((o) => ({ label: o, onClick: () => applyDerivedToFile(file, vn, o) }))]
        : [{ label: "Copy recipe to another file…", disabled: true, title: "open another file first" }]),
      { label: "Export recipe…", onClick: () => exportRecipes(file, [vn]) },
      { sep: true },
      { label: "Delete", danger: true, onClick: () => deleteDerived(file, vn) });
  }
  menu(at, items);
}

function selectTreeVar(file, varName, row) {
  selTreeVar = { file, var: varName };
  [...document.querySelectorAll(".tree-var.sel")].forEach((r) => r.classList.remove("sel"));
  if (row) row.classList.add("sel");
  showInfo(file, varName);
  updateAddButton();
}

function showInfo(file, varName) {
  const ds = state.dsets.get(file);
  const box = $("info");
  const d = findDef(file, varName);
  const v = ds && ds.variable(varName);
  const lines = [];
  if (d) {
    const st = state.derivedStatus.get(dkey(d)) || {};
    lines.push(`ƒ ${varName}  (derived)`, D.describeDef(d));
    if (!st.ok) { lines.push("", `⚠ ${st.error || "not computed"}`); box.textContent = lines.join("\n"); return; }
  }
  if (!v) { box.textContent = lines.join("\n") || "—"; return; }
  if (!d) lines.push(`${varName}  (${v.dtype})`);
  lines.push(`dims: ${v.dims.map((dd) => `${dd}=${ds.size(dd)}`).join(", ") || "scalar"}`);
  for (const [k, val] of Object.entries(v.attrs)) lines.push(`  ${k}: ${val}`);
  if (v.isNumeric() && v.data && v.data.length) {
    let lo = Infinity, hi = -Infinity, nn = 0;
    const n = v.data.length, step = Math.max(1, Math.floor(n / 200000));   // sample huge arrays
    for (let i = 0; i < n; i += step) { const x = Number(v.data[i]); if (Number.isFinite(x)) { if (x < lo) lo = x; if (x > hi) hi = x; } else nn++; }
    if (lo <= hi) lines.push(`range: ${X.fmt6(lo)} … ${X.fmt6(hi)}${nn ? `  (${step > 1 ? "~" : ""}${nn * step} NaN)` : ""}`);
  }
  box.textContent = lines.join("\n");
}

// =====================================================================  traces
function addTrace() {
  if (!selTreeVar) { toast("Select a variable in the Datasets tree first.", "warn"); return; }
  const ds = state.dsets.get(selTreeVar.file);
  const v = ds && ds.variable(selTreeVar.var);
  if (!v) { toast(`${selTreeVar.var} is not available.`, "warn"); return; }
  if (!v.isNumeric()) { toast(`${v.name} is not numeric — cannot plot.`, "warn"); return; }
  if (v.ndim === 0) { toast(`${v.name} is a scalar: ${X.fmt6(Number(v.data[0]))} — nothing to plot.`, "warn"); return; }
  const t = X.defaultTrace(ds, selTreeVar.var, selTreeVar.file);
  if (v.derived) {
    t.draw = "lines+markers";
    const sx = D.suggestXsrc(ds, selTreeVar.var, t.line_dim);
    if (sx) t.xsrc = sx;
  }
  state.traces.push(t);
  rebuildTraceList(state.traces.length - 1);
  redraw();
}

function removeTrace() {
  const r = state.cur;
  if (r < 0 || r >= state.traces.length) return;
  state.traces.splice(r, 1);
  state.markers = state.markers.filter((m) => m.trace !== r)
    .map((m) => ({ ...m, trace: m.trace - (m.trace > r ? 1 : 0) }));
  rebuildTraceList(Math.min(r, state.traces.length - 1));
  redraw();
}

function duplicateTrace() {
  const r = state.cur;
  if (r < 0 || r >= state.traces.length) return;
  const t = state.traces[r];
  const c = { ...t, slices: { ...t.slices }, label: (t.label || t.var) + " (copy)" };
  state.traces.splice(r + 1, 0, c);
  // markers after the insertion point shift by one
  state.markers = state.markers.map((m) => ({ ...m, trace: m.trace > r ? m.trace + 1 : m.trace }));
  rebuildTraceList(r + 1);
  redraw();
}

async function clearTraces() {
  if (!state.traces.length) return;
  if (!(await ask(`Remove all ${state.traces.length} trace(s) from "${activeTab().name}"?`,
    { title: "Clear traces", ok: "Remove all", danger: true }))) return;
  state.traces = []; state.markers = [];
  rebuildTraceList(-1); redraw();
}

// move trace `from` to position `to` (index in the final order); markers and
// the selection follow their traces
function moveTrace(from, to) {
  const n = state.traces.length;
  if (from === to || from < 0 || from >= n || to < 0 || to >= n) return;
  const order = [...Array(n).keys()];
  order.splice(from, 1); order.splice(to, 0, from);       // order[newIdx] = oldIdx
  const oldToNew = {};
  order.forEach((o, ni) => { oldToNew[o] = ni; });
  state.traces = order.map((o) => state.traces[o]);
  state.markers = state.markers.map((m) => ({ ...m, trace: oldToNew[m.trace] }));
  rebuildTraceList(oldToNew[state.cur] !== undefined ? oldToNew[state.cur] : to);
  redraw();
}

function traceColor(t, i) { return t.color || CYCLE[i % CYCLE.length]; }

function swatchFor(t, i) {
  const sw = h("span", { class: "swatch" + (t.yaxis === "right" ? " right" : "") });
  if (t.sweep) {
    const stops = [0, 0.25, 0.5, 0.75, 1].map((f) => cmapColor(state.plotcfg.cmap, f)).join(",");
    sw.style.background = `linear-gradient(90deg,${stops})`;
    sw.title = `sweep over ${t.sweep} — colored by the ${state.plotcfg.cmap} colormap`;
  } else {
    sw.style.background = traceColor(t, i);
    sw.title = t.color ? "custom color" : "auto color";
  }
  if (t.visible === false) sw.style.opacity = 0.3;
  return sw;
}

let _dragFrom = -1;
function rebuildTraceList(select) {
  const prev = state.cur;
  state._updating = true;
  const list = $("traceList");
  list.innerHTML = "";
  state.traces.forEach((t, i) => {
    const prob = traceProblem(t);
    const row = h("div", { class: "trace-row" + (i === select ? " sel" : "") + (t.visible === false ? " hidden-t" : "")
      + (prob ? " missing" : ""), draggable: "true" });
    const grip = h("span", { class: "grip", html: icon("grip"), title: "drag to reorder" });
    const cb = h("input", { type: "checkbox", title: "show / hide" });
    cb.checked = t.visible !== false;
    cb.onclick = (e) => { e.stopPropagation(); t.visible = cb.checked; row.classList.toggle("hidden-t", !cb.checked); redraw(); refreshSwatches(); };
    const name = h("span", { class: "tname" });
    name.append(prob ? h("span", { class: "badge miss", text: "!", title: prob }) : "",
      " ", t.label || t.var, " ", h("small", { text: `${t.var} @ ${t.file}` }));
    name.title = prob ? `${traceName(t)}\n⚠ ${prob}` : traceName(t) + "\ndouble-click to rename";
    row.append(grip, cb, swatchFor(t, i), name);
    row.onclick = () => selectTrace(i);
    name.ondblclick = (e) => { e.stopPropagation(); renameTraceInline(i, name); };
    row.oncontextmenu = (e) => { e.preventDefault(); selectTrace(i); traceMenu(i, { x: e.clientX, y: e.clientY }); };
    // drag to reorder
    row.ondragstart = (e) => { _dragFrom = i; row.classList.add("dragging"); e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setData("text/x-ncx-trace", String(i)); } catch (err) { /* ignore */ } };
    row.ondragend = () => { _dragFrom = -1; row.classList.remove("dragging");
      list.querySelectorAll(".drop-before,.drop-after").forEach((r) => r.classList.remove("drop-before", "drop-after")); };
    row.ondragover = (e) => {
      if (_dragFrom < 0) return;
      e.preventDefault(); e.stopPropagation();
      const r = row.getBoundingClientRect(), after = e.clientY > r.top + r.height / 2;
      list.querySelectorAll(".drop-before,.drop-after").forEach((q) => q.classList.remove("drop-before", "drop-after"));
      row.classList.add(after ? "drop-after" : "drop-before");
    };
    row.ondrop = (e) => {
      if (_dragFrom < 0) return;
      e.preventDefault(); e.stopPropagation();
      const r = row.getBoundingClientRect(), after = e.clientY > r.top + r.height / 2;
      let to = i + (after ? 1 : 0);
      if (_dragFrom < to) to--;
      const from = _dragFrom; _dragFrom = -1;
      moveTrace(from, to);
    };
    list.appendChild(row);
  });
  $("traceCount").textContent = state.traces.length ? `${state.traces.length}` : "";
  state._updating = false;
  const sel = (select === undefined) ? Math.min(prev, state.traces.length - 1) : select;
  selectTrace(sel);
}

function refreshSwatches() {
  const rows = $("traceList").children;
  state.traces.forEach((t, i) => {
    const old = rows[i] && rows[i].querySelector(".swatch");
    if (old) old.replaceWith(swatchFor(t, i));
  });
}

function renameTraceInline(i, span) {
  const t = state.traces[i];
  const inp = h("input", { type: "text", class: "rename", value: t.label || t.var });
  span.replaceWith(inp); inp.focus(); inp.select();
  let done = false;
  const commit = (save) => {
    if (done) return; done = true;
    if (save) t.label = inp.value.trim() || t.var;
    rebuildTraceList(i); redraw();
  };
  inp.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Enter") commit(true); else if (e.key === "Escape") commit(false); };
  inp.onblur = () => commit(true);
  inp.onclick = (e) => e.stopPropagation();
}

function traceMenu(i, at) {
  const t = state.traces[i];
  const d = findDef(t.file, t.var);
  const others = state.tabs.map((tb, k) => ({ tb, k })).filter(({ k }) => k !== state.active);
  menu(at, [
    { label: "Rename…", icon: "edit", onClick: () => { const el = $("traceList").children[i]; if (el) renameTraceInline(i, el.querySelector(".tname")); } },
    { label: "Duplicate", hint: "Ctrl+D", onClick: duplicateTrace },
    { label: t.visible === false ? "Show" : "Hide", onClick: () => { t.visible = t.visible === false; rebuildTraceList(i); redraw(); } },
    { label: t.yaxis === "right" ? "Move to left Y axis" : "Move to right Y axis",
      onClick: () => { t.yaxis = t.yaxis === "right" ? "left" : "right"; rebuildTraceList(i); redraw(); } },
    d ? { label: "Edit derived quantity…", icon: "func", onClick: () => editDerived(t.file, t.var) } : null,
    { sep: true },
    others.length ? { header: "Copy to tab" } : null,
    ...others.map(({ tb, k }) => ({ label: tb.name, onClick: () => {
      tb.traces.push({ ...t, slices: { ...t.slices } }); scheduleSave(); toast(`Copied to "${tb.name}".`, "ok"); } })),
    { label: "Copy to a new tab", onClick: () => { const c = { ...t, slices: { ...t.slices } }; addTab(t.label || t.var); state.traces.push(c); rebuildTraceList(0); redraw(); } },
    { sep: true },
    { label: "Remove", danger: true, hint: "Del", onClick: removeTrace },
  ]);
}

function traceName(t) {
  return `${t.label || t.var}  [${t.var} @ ${t.file}]`;
}

function selectTrace(row) {
  state.cur = row;
  [...document.querySelectorAll(".trace-row")].forEach((r, i) =>
    r.classList.toggle("sel", i === row));
  populateEditor();
  rebuildSliders();
  updateTraceButtons();
}

function updateTraceButtons() {
  const has = state.cur >= 0 && state.cur < state.traces.length;
  $("btnRemove").disabled = !has;
  $("btnDupTrace").disabled = !has;
  $("btnClear").disabled = !state.traces.length;
}

function populateEditor() {
  state._updating = true;
  const ldim = $("ed_ldim"), xsrc = $("ed_xsrc"), sweep = $("ed_sweep"),
    label = $("ed_label"), swlabel = $("ed_sweeplabel"), yax = $("ed_yaxis"),
    ssrc = $("ed_ssrc"), draw = $("ed_draw"), dash = $("ed_dash");
  [ldim, xsrc, sweep, yax, ssrc, draw, dash].forEach((s) => (s.innerHTML = ""));
  label.value = ""; swlabel.value = "";
  const has = state.cur >= 0 && state.cur < state.traces.length;
  $("edBody").hidden = !has;
  $("edEmpty").hidden = has;
  $("edWhat").textContent = "";
  if (!has) {
    $("edEmpty").textContent = state.traces.length ? "Select a trace in the list above to edit it." : "Add a trace to edit it here.";
    state._updating = false; return;
  }
  const t = state.traces[state.cur];
  $("edWhat").textContent = `${t.var} @ ${t.file}`;
  $("edWhat").title = `${t.var} @ ${t.file}`;
  const ds = state.dsets.get(t.file);
  const prob = traceProblem(t);
  if (prob) {
    $("edBody").hidden = true; $("edEmpty").hidden = false;
    $("edEmpty").textContent = `⚠ ${prob}. The trace is kept and will draw again once that is fixed.`;
    state._updating = false; return;
  }
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
  $("row_ssrc").hidden = !sw;
  $("row_sweeplabel").hidden = !sw;
  label.value = t.label || t.var;
  swlabel.value = t.sweep_label || "";
  addOpts(draw, X.DRAW_MODES, t.draw || "lines");
  addOpts(dash, X.DASHES, t.dash || "auto");
  $("ed_lw").value = Number.isFinite(t.lw) ? t.lw : X.LW_DEFAULT;
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
  if (!ds || !ds.has(t.var)) return;
  if (what === "line_dim") {
    const nd = $("ed_ldim").value;
    if (nd && nd !== t.line_dim) {
      t.line_dim = nd;
      if (t.sweep === nd) t.sweep = "";
      const keep = {};
      ds.variable(t.var).dims.forEach((d) => { if (d !== nd && d !== t.sweep) keep[d] = t.slices[d] || 0; });
      t.slices = keep;
      // the natural x for the new line dim
      t.xsrc = X.defaultTrace(ds, t.var, t.file).line_dim === nd ? X.defaultTrace(ds, t.var, t.file).xsrc
        : (D.suggestXsrc(ds, t.var, nd) || "index");
      populateEditor(); rebuildSliders();
    }
  } else if (what === "xsrc") { t.xsrc = $("ed_xsrc").value; }
  else if (what === "sweep") {
    let nv = $("ed_sweep").value; nv = nv === "(none)" ? "" : nv;
    if (nv !== t.sweep) {
      t.sweep = nv;
      t.ssrc = "coord";     // a new sweep dim starts from its own coordinate
      const keep = {};
      ds.variable(t.var).dims.forEach((d) => { if (d !== t.line_dim && d !== nv) keep[d] = t.slices[d] || 0; });
      t.slices = keep;
      populateEditor(); rebuildSliders();   // refresh the colorbar-source options
      refreshSwatches();
    }
  } else if (what === "ssrc") { t.ssrc = $("ed_ssrc").value; }
  else if (what === "label") {
    t.label = $("ed_label").value.trim() || t.var;
    const row = $("traceList").children[state.cur];
    if (row) rebuildTraceList(state.cur);
  } else if (what === "sweep_label") { t.sweep_label = $("ed_sweeplabel").value; }
  else if (what === "yaxis") { t.yaxis = $("ed_yaxis").value === "right" ? "right" : "left"; refreshSwatches(); }
  else if (what === "draw") { t.draw = $("ed_draw").value; }
  else if (what === "dash") { t.dash = $("ed_dash").value; }
  else if (what === "lw") {
    const v = parseFloat($("ed_lw").value);
    t.lw = Number.isFinite(v) ? Math.min(10, Math.max(0.25, v)) : X.LW_DEFAULT;
  }
  else if (what === "color") { t.color = $("ed_color").value; $("ed_autocolor").checked = false; $("ed_color").disabled = false; refreshSwatches(); }
  else if (what === "autocolor") {
    const auto = $("ed_autocolor").checked;
    if (auto) { t.color = ""; $("ed_color").disabled = true; $("ed_color").value = CYCLE[state.cur % CYCLE.length]; }
    else { t.color = $("ed_color").value; $("ed_color").disabled = false; }
    refreshSwatches();
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
    const lab = document.createElement("span"); lab.className = "sl-name"; lab.textContent = d; lab.title = d;
    const sld = document.createElement("input");
    sld.type = "range"; sld.min = 0; sld.max = Math.max(0, n - 1);
    sld.value = Math.max(0, Math.min(t.slices[d] | 0, n - 1));
    sld.title = `${d}: index 0…${n - 1} (arrow keys step by one)`;
    t.slices[d] = +sld.value;
    const val = document.createElement("span"); val.className = "sl-val";
    val.textContent = X.sliderValue(ds, d, +sld.value);
    const set = (k) => {
      k = Math.max(0, Math.min(n - 1, k));
      sld.value = k; t.slices[d] = k; val.textContent = X.sliderValue(ds, d, k); redraw();
    };
    sld.oninput = () => set(+sld.value);
    const dec = h("button", { class: "sl-step", text: "‹", title: "previous" });
    const inc = h("button", { class: "sl-step", text: "›", title: "next" });
    dec.onclick = () => set(+sld.value - 1);
    inc.onclick = () => set(+sld.value + 1);
    row.append(lab, dec, sld, inc, val);
    box.appendChild(row);
  }
  if (!any) box.innerHTML = '<div class="muted">(no other dims to slice)</div>';
}

// =====================================================================  plot
// expand one tab's visible traces into drawable lines
function fetchTab(tab, statusCb) {
  // returns [{ti, t, lines, sweep}] for visible, plottable traces
  const out = [];
  tab.traces.forEach((t, ti) => {
    if (t.visible === false) return;
    const ds = state.dsets.get(t.file);
    if (!ds) return;
    const { lines, sweep } = X.traceLines(ds, t, statusCb);
    if (lines.length) out.push({ ti, t, lines, sweep });
  });
  return out;
}

// the Plotly figure for one tab (no side effects on the DOM): {data, layout,
// config, notes, drawnMap, markerXY}. redraw() paints the active tab with it;
// the multi-page PDF report renders the other tabs with it too.
function buildFigure(tab, statusCb) {
  const c = tab.plotcfg;
  const fetched = fetchTab(tab, statusCb);
  const xf = X.PREFIX_FACTOR[c.xunit] || 1;
  const yfL = X.PREFIX_FACTOR[c.yunit] || 1;
  const yfR = X.PREFIX_FACTOR[c.yunit2] || 1;
  const is3d = c.mode === "3D waterfall";
  // a trace's y unit factor / Plotly axis, by its left/right assignment
  const traceOnRight = (ti) => !is3d && (tab.traces[ti].yaxis === "right");
  const yfFor = (ti) => traceOnRight(ti) ? yfR : yfL;
  const notes = [];
  const drawnMap = [];

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

  const data = [];
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
    const base = f.t.color || CYCLE[f.ti % CYCLE.length];
    if (f.sweep && f.lines.length > 12 && c.legend && c.mode === "2D lines")
      notes.push(`'${f.t.label || f.t.var}': ${f.lines.length} sweep lines — legend omitted`);
    const yf = yfFor(f.ti);
    const onRight = traceOnRight(f.ti);
    const lw = Number.isFinite(f.t.lw) ? f.t.lw : X.LW_DEFAULT;
    const dash = (f.t.dash && f.t.dash !== "auto") ? f.t.dash : (onRight ? "dot" : "solid");
    const mode = X.DRAW_MODES.includes(f.t.draw) ? f.t.draw : "lines";
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
          line: { color, width: Math.max(1, lw * 2) }, name, showlegend });
      } else {
        drawnMap.push({ ti: f.ti, j });
        // SVG scatter keeps exports truly vector; only very large lines fall
        // back to WebGL (scattergl) for rendering performance
        data.push({ type: m > 20000 ? "scattergl" : "scatter", mode,
          x: xs, y: ys, yaxis: onRight ? "y2" : "y",
          line: { color, width: lw, dash }, marker: { color, size: 6 },
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
  const anyRight = !is3d && fetched.some((f) => traceOnRight(f.ti));
  let markerXY = [];
  if (!is3d) markerXY = drawMarkers(tab, data, fetched, xf, yfFor, traceOnRight);
  else if (tab.markers.length) notes.push("markers are shown in the 2D views only");

  const auto = X.autoLabels(state.dsets, tab.traces);
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
  const config = {
    responsive: !c.lock_size, displaylogo: false, scrollZoom: true,
    modeBarButtonsToRemove: ["lasso2d", "select2d"],
  };
  return { data, layout, config, notes, drawnMap, markerXY };
}

function redraw() {
  const tab = activeTab();
  const fig = buildFigure(tab, status);
  tab.drawnMap = fig.drawnMap;
  tab._markerXY = fig.markerXY;
  Plotly.react(gd(), fig.data, fig.layout, fig.config);
  if (fig.notes.length) status(fig.notes.join(" | "));
  $("markerCount").textContent = tab.markers.length ? String(tab.markers.length) : "";
  updateEmptyState();
  updateTraceButtons();
  scheduleSave();   // autosave the session (debounced)
}

function drawMarkers(tab, data, fetched, xf, yfFor, traceOnRight) {
  const byTrace = {};
  for (const f of fetched) byTrace[f.ti] = f.lines;
  // one overlay per y axis so a marker lands on its trace's own axis
  const groups = { y: { mx: [], my: [], mt: [] }, y2: { mx: [], my: [], mt: [] } };
  const markerXY = [];
  tab.markers.forEach((mk, mi) => {
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
    markerXY.push({ mi, x: xs, y: ys, axis: ax });
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
  return markerXY;
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
    "upper center": { x: 0.5, y: 1, xanchor: "center", yanchor: "top" },
    "lower center": { x: 0.5, y: 0, xanchor: "center", yanchor: "bottom" },
    "center left": { x: 0, y: 0.5, xanchor: "left", yanchor: "middle" },
    "center right": { x: 1, y: 0.5, xanchor: "right", yanchor: "middle" },
    "center": { x: 0.5, y: 0.5, xanchor: "center", yanchor: "middle" },
  };
  return { ...(m[loc] || m.best), bgcolor: "rgba(255,255,255,0.7)", font: { size: 11 } };
}

// the onboarding card over an empty plot
function updateEmptyState() {
  const el = $("emptyState");
  if (state.traces.length) { el.hidden = true; return; }
  el.hidden = false;
  const noFiles = !state.fileOrder.length;
  el.className = "empty" + (noFiles ? "" : " compact");
  el.innerHTML = "";
  const card = h("div", { class: "empty-card" });
  if (noFiles) {
    card.append(
      h("h3", { text: "Drop .nc files here" }),
      h("p", { text: "NetCDF-3 and NetCDF-4/HDF5 files open right in your browser — nothing is uploaded." }),
      h("div", { class: "row" },
        h("button", { class: "primary", html: icon("open") + " Open .nc files…", onclick: () => $("fileInput").click() }),
        h("button", { class: "ghost", html: icon("load") + " Load a project…", onclick: () => $("projInput").click() }),
        h("button", { class: "ghost", text: "Try the sample", onclick: openSample })),
      h("ul", {},
        h("li", { html: "Double-click a variable to plot it; use the <b>sliders</b> to scrub the other dimensions." }),
        h("li", { html: "<b>ƒ Derived…</b> computes peak power, noise floor, SNR… in a window, vs any other dimension." }),
        h("li", { html: "<b>Save</b> keeps every tab and derived quantity; <b>Report ▾</b> makes a multi-page PDF or a Python script." })));
  } else {
    const tabs = state.tabs.length > 1 ? " in this tab" : "";
    card.append(
      h("h3", { text: `Nothing plotted${tabs} yet` }),
      h("p", { html: "Double-click a variable in <b>Datasets</b> (or select it and press <b>Add trace ➜</b>)." }),
      h("div", { class: "row" },
        h("button", { class: "ghost", html: icon("func") + " New derived quantity…", onclick: () => newDerived() }),
        h("button", { class: "ghost", html: icon("open") + " Open more files…", onclick: () => $("fileInput").click() })));
  }
  el.appendChild(card);
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

function toggleMarkerMode() {
  state.markerMode = !state.markerMode;
  $("btnMarker").classList.toggle("active", state.markerMode);
  gd().classList.toggle("marker-mode", state.markerMode);
  status(state.markerMode ? "Marker mode ON — left-click a point to add, right-click a marker to delete."
    : "Marker mode off.");
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
  const cmapChanged = c.cmap !== $("cfg_cmap").value;
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
  const fw = parseFloat($("cfg_figw").value), fh = parseFloat($("cfg_figh").value);
  c.figw = Number.isFinite(fw) ? Math.min(40, Math.max(2, fw)) : X.DEFAULT_PLOTCFG.figw;
  c.figh = Number.isFinite(fh) ? Math.min(40, Math.max(2, fh)) : X.DEFAULT_PLOTCFG.figh;
  $("cfg_figw").disabled = !c.lock_size; $("cfg_figh").disabled = !c.lock_size;
  if (cmapChanged) refreshSwatches();
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

async function resetCfg() {
  if (!(await ask(`Reset the appearance of "${activeTab().name}" to the defaults? (Traces and markers are kept.)`,
    { title: "Reset appearance", ok: "Reset" }))) return;
  state.plotcfg = { ...X.DEFAULT_PLOTCFG };
  applyCfgWidgets(); refreshSwatches(); redraw();
}

// =====================================================================  export
const PNG_DPI = 600;
function figSize(tab) {
  const c = tab.plotcfg;
  return {
    w: c.lock_size ? Math.round(c.figw * PX_PER_IN) : (gd().clientWidth || 800),
    h: c.lock_size ? Math.round(c.figh * PX_PER_IN) : (gd().clientHeight || 520),
  };
}
function nothingPlotted() {
  if (fetchTab(activeTab()).length) return false;
  toast("Nothing is plotted in this tab — nothing to export.", "warn");
  return true;
}

function exportImage(fmt) {
  if (nothingPlotted()) return;
  const { w, h: hh } = figSize(activeTab());
  // PNG at 600 DPI relative to the logical (96 px/in) figure size
  const scale = fmt === "png" ? PNG_DPI / PX_PER_IN : 1;
  Plotly.downloadImage(gd(), { format: fmt, width: w, height: hh, scale,
    filename: "ncplot_" + stamp() });
  toast(`Exported ${fmt.toUpperCase()}${fmt === "png" ? ` (${PNG_DPI} dpi)` : ""}.`, "ok");
}

// Plotly figure (in `div`) -> SVG element ready for svg2pdf
async function figureSVG(div, w, hh) {
  const uri = await Plotly.toImage(div, { format: "svg", width: w, height: hh });
  let svgText = decodeURIComponent(uri.replace(/^data:image\/svg\+xml,/, ""));
  // Plotly labels negatives with the Unicode MINUS SIGN (U+2212), which
  // jsPDF's built-in Helvetica can't render (it shows a fallback glyph that
  // looks like "). Swap it for an ASCII hyphen so the vector PDF is clean.
  svgText = svgText.replace(/−/g, "-");
  return new DOMParser().parseFromString(svgText, "image/svg+xml").documentElement;
}

async function exportPDF() {
  if (nothingPlotted()) return;
  const { w, h: hh } = figSize(activeTab());
  try {
    const svgEl = await figureSVG(gd(), w, hh);
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ orientation: w >= hh ? "landscape" : "portrait", unit: "pt", format: [w, hh] });
    // svg2pdf.js patches jsPDF with an async .svg() method
    await pdf.svg(svgEl, { width: w, height: hh });
    pdf.save("ncplot_" + stamp() + ".pdf");
    toast("Exported vector PDF.", "ok");
  } catch (e) { toast("PDF export error: " + e.message, "error"); }
}

// multi-page vector PDF: one page per selected tab, each at its own size
async function exportReportPDF(tabIdx, fileName, onProgress) {
  const { jsPDF } = window.jspdf;
  let pdf = null;
  const host = h("div", { style: { position: "fixed", left: "-20000px", top: "0", width: "10px", height: "10px", overflow: "hidden" } });
  document.body.appendChild(host);
  let pages = 0;
  const skipped = [];
  try {
    for (const i of tabIdx) {
      const tab = state.tabs[i];
      if (!tab) continue;
      if (onProgress) onProgress(`Rendering “${tab.name}” (${pages + 1}/${tabIdx.length})…`);
      const fig = buildFigure(tab, () => {});
      if (!fig.data.length) { skipped.push(tab.name); continue; }
      const { w, h: hh } = figSize(tab);
      const div = h("div", { style: { width: w + "px", height: hh + "px" } });
      host.appendChild(div);
      await Plotly.newPlot(div, fig.data, { ...fig.layout, width: w, height: hh, autosize: false },
        { ...fig.config, responsive: false, staticPlot: true });
      const svgEl = await figureSVG(div, w, hh);
      Plotly.purge(div); div.remove();
      const orient = w >= hh ? "landscape" : "portrait";
      if (!pdf) pdf = new jsPDF({ orientation: orient, unit: "pt", format: [w, hh] });
      else pdf.addPage([w, hh], orient);
      await pdf.svg(svgEl, { width: w, height: hh });
      pages++;
    }
    if (!pdf) { toast("None of the selected tabs has anything plotted.", "warn"); return false; }
    pdf.setProperties({ title: fileName.replace(/\.pdf$/i, ""), creator: "NC Explorer" });
    pdf.save(fileName);
    toast(`PDF report saved: ${pages} page(s)` + (skipped.length ? ` (empty, skipped: ${skipped.join(", ")})` : "") + ".", "ok");
    return true;
  } catch (e) {
    toast("PDF report error: " + e.message, "error");
    return false;
  } finally { host.remove(); }
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
  if (!rows.length) { toast("Nothing plotted — nothing to export.", "warn"); return; }
  let head = "# NC Explorer export (long format)\n";
  const scf = sweepScaled ? cf : 1;            // only claim a sweep scale if one was applied
  if (xf !== 1 || yfL !== 1 || yfR !== 1 || scf !== 1)
    head += `# axis scale: x÷${xf} (${c.xunit || "1"}), y-left÷${yfL} (${c.yunit || "1"}), `
      + `y-right÷${yfR} (${c.yunit2 || "1"}), sweep÷${scf} (${scf !== 1 ? c.cunit : "1"}) — as displayed\n`;
  head += "trace,sweep,x,y,yaxis\n";
  triggerDownload(new Blob([head + rows.join("\n") + "\n"], { type: "text/csv" }), "ncplot_" + stamp() + ".csv");
  toast(`Exported ${rows.length} CSV rows.`, "ok");
}

function exportMenu() {
  const btn = $("btnExportMenu");
  if (isMenuOpenFor(btn)) { closeMenu(); return; }
  menu(btn, [
    { header: "Active plot" },
    { label: "PNG image (600 dpi)", onClick: () => exportImage("png") },
    { label: "SVG (vector)", onClick: () => exportImage("svg") },
    { label: "PDF (vector)", onClick: exportPDF },
    { sep: true },
    { label: "CSV data (plotted lines)", onClick: exportCSV },
  ]);
}

function reportCtx() {
  return { state, buildProject, exportReportPDF, toast, stamp, missingFiles, fetchTab };
}
function reportMenu() {
  const btn = $("btnReportMenu");
  if (isMenuOpenFor(btn)) { closeMenu(); return; }
  menu(btn, [
    { label: "PDF report of tabs…", icon: "report", title: "a multi-page vector PDF (one page per tab), made right here",
      onClick: () => openReportDialog(reportCtx(), "pdf") },
    { label: "Python script → PDF report…", icon: "export",
      title: "download a .py that regenerates the selected tabs (incl. derived quantities) as a multi-page vector PDF",
      onClick: () => openReportDialog(reportCtx(), "python") },
  ]);
}

// =====================================================================  projects
function saveProject() {
  if (!state.fileOrder.length && !state.derived.length && !state.tabs.some((t) => t.traces.length)) {
    toast("Nothing to save yet — open a file first.", "warn"); return;
  }
  triggerDownload(new Blob([projectText(state)], { type: "application/json" }), "ncplot_" + stamp() + ".ncproj");
  toast(`Project saved — ${state.tabs.length} tab(s)` + (state.derived.length ? `, ${state.derived.length} derived` : "")
    + `. The .nc files are referenced by name (keep them next to the project).`, "ok");
}

// self-contained save: bundle every open file's bytes into the .ncproj as
// base64. Bytes come from the IndexedDB "files" store (no re-read of the File).
async function saveProjectEmbedded() {
  if (!state.fileOrder.length) { toast("Nothing to save yet — open a file first.", "warn"); return; }
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
    toast("Could not read file bytes to embed — saved a name-referenced project instead.", "warn");
    saveProject();
    return;
  }
  const mb = total / 1e6;
  if (total > 200e6 && !(await ask(`Embedding ~${mb.toFixed(0)} MB of data makes a ~${(mb * 1.4).toFixed(0)} MB `
    + "project file. Continue?", { title: "Large project", ok: "Save anyway" }))) { status("Save cancelled."); return; }
  const text = projectText(state, { embedded: { encoding: "base64", files } });
  triggerDownload(new Blob([text], { type: "application/json" }), "ncplot_" + stamp() + ".ncproj");
  toast(`Self-contained project saved — ${state.tabs.length} tab(s), ~${mb.toFixed(1)} MB of data embedded.`, "ok");
}

function saveMenu() {
  const btn = $("btnSaveMenu");
  if (isMenuOpenFor(btn)) { closeMenu(); return; }
  menu(btn, [
    { label: "Save project", hint: "Ctrl+S", icon: "save", title: "tabs, traces, derived quantities, cosmetics; .nc files referenced by name",
      onClick: saveProject },
    { label: "Save self-contained (embed .nc data)", hint: "Ctrl+Shift+S",
      title: "one shareable file with the data inside (larger)", onClick: saveProjectEmbedded },
    { sep: true },
    { label: "Load project…", icon: "load", onClick: () => $("projInput").click() },
  ]);
}

// blank the whole project: drop every file + trace + marker + derived quantity,
// reset cosmetics to defaults, and clear the autosaved session.
async function newProject() {
  const anyTraces = state.tabs.some((tb) => tb.traces.length);
  const hasWork = state.fileOrder.length || anyTraces || state.derived.length;
  if (hasWork && !(await ask("Start a new project? This closes all files and clears every tab, derived quantity, "
    + "marker and cosmetic, and the browser autosave. Save your project first if you want to keep it.",
    { title: "New project", ok: "Clear everything", danger: true }))) return;
  clearTimeout(_saveTimer); _saveTimer = null;  // cancel any pending autosave of the old state
  state.dsets.clear();
  state.fileOrder = [];
  state.derived = [];
  state.derivedStatus.clear();
  state.wantedFiles = [];
  state.projectOrder = [];
  state.markerMode = false;
  $("btnMarker").classList.remove("active");
  selTreeVar = null;
  state.tabs = [makeTab("Plot 1")];   // one fresh empty tab
  state.active = 0;
  await clearSession();               // wipe IndexedDB (files + saved project)
  $("info").innerHTML = '<span class="muted">Select a variable to see its dimensions and attributes.</span>';
  $("saveState").textContent = "";
  rebuildTree();
  refreshTab();
  clearTimeout(_saveTimer); _saveTimer = null;
  resetHistory();
  status("New project — everything cleared. Open a .nc file to begin.");
}

async function loadProjectFile(file) {
  let proj;
  try { proj = parseProject(await file.text()); }
  catch (e) { toast("Project load error: " + e.message, "error"); return; }
  const still = await applyProject(proj);
  const nTr = state.tabs.reduce((s, tb) => s + tb.traces.length, 0);
  const der = state.derived.length ? `, ${state.derived.length} derived quantit${state.derived.length === 1 ? "y" : "ies"}` : "";
  if (still.length) {
    // can't open files by path from the browser — the user must pick the .nc.
    // Everything is kept; it resolves automatically when they open the file.
    toast(`Project loaded (${state.tabs.length} tab(s)${der}). Now open: ${still.join(", ")} — `
      + "the waiting traces appear automatically.", "warn", 12000);
    status(`Project loaded — waiting for: ${still.join(", ")}.`);
  } else {
    toast(`Project loaded: ${state.tabs.length} tab(s), ${nTr} trace(s)${der}.`, "ok");
    status(`Project loaded: ${state.tabs.length} tab(s), ${nTr} trace(s)${der}.`);
  }
}

// build one live tab record from a parsed (sanitized) project tab. Traces whose
// file isn't open are kept as-is; rebindAll() resolves them.
function buildTabFromParsed(ptab) {
  const tab = makeTab(ptab.name);
  tab.traces = ptab.traces.map((t) => ({ ...t, slices: { ...t.slices } }));
  tab.markers = ptab.markers.map((m) => ({ trace: m.trace, line: m.line, idx: m.idx }));
  tab.plotcfg = { ...ptab.plotcfg };  // cosmetics apply even before the data opens
  tab.cur = ptab.selected;
  return tab;
}

// apply a parsed project: decode any embedded files, then rebuild the derived
// quantities and ALL tabs, binding file refs by BASENAME to open datasets
// (desktop projects store absolute paths, web ones bare names). RETURNS the
// still-missing file basenames (empty when fully applied). Async because an
// embedded HDF5 decode awaits WASM.
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
          const nm = basename(name);
          const ds = await openBuffer(buf, nm);         // HDF5 path is async (WASM)
          state.dsets.set(nm, ds);
          state.fileOrder.push(nm);
          openBase.set(base, nm);
          idbPut("files", nm, buf).catch(() => {});     // persist so autosave restores it
        } catch (e) { /* skip a corrupt embedded file; its traces stay missing */ }
      }
    }

    // 2) derived quantities first (traces may plot them), then every tab
    state.derived = proj.derived.map((d) => JSON.parse(JSON.stringify(d)));
    state.wantedFiles = [...new Set(proj.files.map((f) => basename(f)))];
    state.projectOrder = state.wantedFiles.map((f) => f.toLowerCase());
    const built = proj.tabs.map((pt) => buildTabFromParsed(pt));
    state.tabs = built.length ? built : [makeTab("Plot 1")];
    state.active = Math.max(0, Math.min(proj.active | 0, state.tabs.length - 1));

    // 3) bind to open datasets + compute derived variables
    rebindAll();
    rebuildTree();
    refreshTab();     // renderTabs + applyCfgWidgets + rebuildTraceList + redraw
    return missingFiles();
  } finally {
    if (hasEmbed) setTabsBusy(false);
  }
}

// =====================================================================  help
function showHelp() {
  const sc = [
    ["Ctrl+O", "Open .nc files"], ["Ctrl+S", "Save project"], ["Ctrl+Shift+S", "Save self-contained project (embeds data)"],
    ["Ctrl+Z", "Undo"], ["Ctrl+Y · Ctrl+Shift+Z", "Redo"], ["Delete", "Remove the selected trace"],
    ["Ctrl+D", "Duplicate the selected trace"], ["M", "Toggle marker mode"], ["Esc", "Close a menu or dialog"], ["?", "This help"],
  ];
  const grid = h("div", { class: "shortcut-grid" });
  for (const [k, d] of sc) grid.append(h("span", {}, ...k.split(" · ").flatMap((kk, i) => [i ? " · " : "", h("kbd", { text: kk })])),
    h("span", { text: d }));
  const body = h("div", {},
    h("h4", { text: "Quick guide" }),
    h("p", { html: "<b>Open</b> one or more .nc files (or drop them anywhere). Double-click a variable to plot it. "
      + "In <b>Selected trace</b>, choose the dimension each line runs along, its X values (index, coordinate, or any "
      + "variable sharing the dims — e.g. a per-spectrum frequency array), an optional <b>sweep</b> (a family of lines), "
      + "and use the <b>sliders</b> to scrub the remaining dimensions." }),
    h("p", { html: "<b>ƒ Derived…</b> turns a stack of spectra into a processed quantity: e.g. the <i>peak power</i> in a "
      + "window around the stimulus frequency, the <i>noise floor</i> outside it, and their difference (SNR), "
      + "each vs the remaining dimensions. Statistics of dB data (mean, median, std, sum, integral) are computed "
      + "in linear power. Derived quantities appear in the tree with a <span class=\"badge fx\">ƒ</span> badge and plot "
      + "like any variable; right-click one to edit it or copy its recipe to another file." }),
    h("p", { html: "<b>Tabs</b> are independent plots that share the datasets. <b>Save</b> writes everything (tabs, "
      + "traces, derived quantities, cosmetics, markers) to a .ncproj; your session is also auto-saved in this browser. "
      + "<b>Report ▾</b> makes a multi-page vector PDF of several tabs, or downloads a Python script that regenerates "
      + "it (and that you can edit)." }),
    h("h4", { text: "Keyboard shortcuts" }), grid);
  modal({ title: "NC Explorer — help", body, buttons: [{ spacer: true }, { label: "Close", kind: "primary", id: "ok" }] });
}

// =====================================================================  helpers
function addOpts(sel, items, current) {
  for (const it of items) {
    const o = document.createElement("option");
    o.value = it; o.textContent = it; if (it === current) o.selected = true;
    sel.appendChild(o);
  }
}
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

// collapse/expand the bottom appearance bar; state persists and the plot reflows
function setAppearanceCollapsed(collapsed) {
  $("appearance").classList.toggle("collapsed", collapsed);
  $("appToggle").textContent = (collapsed ? "▸" : "▾") + " Appearance";
  try { localStorage.setItem("ncx.appCollapsed", collapsed ? "1" : "0"); } catch (e) {}
  try { Plotly.Plots.resize(gd()); } catch (e) { /* not drawn yet */ }
}
function initAppearanceBar() {
  $("appToggle").onclick = () =>
    setAppearanceCollapsed(!$("appearance").classList.contains("collapsed"));
  let collapsed = false;
  try { collapsed = localStorage.getItem("ncx.appCollapsed") === "1"; } catch (e) {}
  setAppearanceCollapsed(collapsed);
}

// is the user typing in a field (so single-key shortcuts must not fire)?
function typing(e) {
  const t = e.target;
  if (!t || !t.tagName) return false;
  if (t.isContentEditable) return true;
  if (t.tagName === "TEXTAREA" || t.tagName === "SELECT") return true;
  return t.tagName === "INPUT" && !["checkbox", "radio", "range", "button", "color"].includes(t.type);
}

function onKeyDown(e) {
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (modalOpen()) return;                        // dialogs handle their own keys
  if (mod && k === "o" && !e.shiftKey) { e.preventDefault(); $("fileInput").click(); return; }
  if (mod && k === "s") { e.preventDefault(); if (e.shiftKey) saveProjectEmbedded(); else saveProject(); return; }
  if (typing(e)) return;                          // native undo etc. inside text fields
  if (mod && k === "z" && !e.shiftKey) { e.preventDefault(); undo(); return; }
  if (mod && (k === "y" || (k === "z" && e.shiftKey))) { e.preventDefault(); redo(); return; }
  if (mod && k === "d") { e.preventDefault(); duplicateTrace(); return; }
  if (mod || e.altKey) return;
  if (e.key === "Delete" || e.key === "Backspace") {
    if (state.cur >= 0) { e.preventDefault(); removeTrace(); }
    return;
  }
  if (k === "m") { toggleMarkerMode(); return; }
  if (e.key === "?" || (e.key === "/" && e.shiftKey)) { e.preventDefault(); showHelp(); }
}

// =====================================================================  wiring
function init() {
  decorateIcons();
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

  const openNc = () => $("fileInput").click();
  $("btnOpen").onclick = openNc;
  $("btnOpen2").onclick = openNc;
  $("fileInput").onchange = (e) => { const fl = [...e.target.files]; e.target.value = ""; onFilesChosen(fl); };
  $("btnAdd").onclick = addTrace;
  $("btnRemove").onclick = removeTrace;
  $("btnDupTrace").onclick = duplicateTrace;
  $("btnClear").onclick = clearTraces;
  $("treeFilter").oninput = () => rebuildTree();
  $("treeFilter").onkeydown = (e) => { if (e.key === "Escape") { e.target.value = ""; rebuildTree(); } };
  $("ed_ldim").onchange = () => editorChanged("line_dim");
  $("ed_xsrc").onchange = () => editorChanged("xsrc");
  $("ed_sweep").onchange = () => editorChanged("sweep");
  $("ed_ssrc").onchange = () => editorChanged("ssrc");
  $("ed_label").onchange = () => editorChanged("label");
  $("ed_sweeplabel").onchange = () => editorChanged("sweep_label");
  $("ed_yaxis").onchange = () => editorChanged("yaxis");
  $("ed_draw").onchange = () => editorChanged("draw");
  $("ed_dash").onchange = () => editorChanged("dash");
  $("ed_lw").onchange = () => editorChanged("lw");
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
  $("btnCfgReset").onclick = resetCfg;
  initSplitters();
  initAppearanceBar();
  $("btnMarker").onclick = toggleMarkerMode;
  $("btnMarkerClear").onclick = () => { if (state.markers.length) { state.markers = []; redraw(); } };
  $("btnExportMenu").onclick = exportMenu;
  $("btnReportMenu").onclick = reportMenu;
  $("btnSaveProj").onclick = saveProject;
  $("btnSaveMenu").onclick = saveMenu;
  $("btnLoadProj").onclick = () => $("projInput").click();
  $("projInput").onchange = (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) loadProjectFile(f); };
  $("recipeInput").onchange = (e) => { const f = e.target.files[0]; e.target.value = ""; onRecipeChosen(f); };
  $("btnNew").onclick = newProject;
  $("btnNewDerived").onclick = () => newDerived();
  $("btnUndo").onclick = undo;
  $("btnRedo").onclick = redo;
  $("btnHelp").onclick = showHelp;
  document.addEventListener("keydown", onKeyDown);

  // drag & drop anywhere, with a full-window overlay while files hover
  let dragDepth = 0;
  const isFileDrag = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes("Files");
  document.addEventListener("dragenter", (e) => { if (!isFileDrag(e)) return; dragDepth++; $("dropOverlay").hidden = false; });
  document.addEventListener("dragleave", (e) => { if (!isFileDrag(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $("dropOverlay").hidden = true; });
  document.addEventListener("dragover", (e) => { if (isFileDrag(e)) e.preventDefault(); });
  document.addEventListener("drop", async (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth = 0; $("dropOverlay").hidden = true;
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
  rebuildTree();
  rebuildTraceList(-1);
  updateEmptyState();
  status("Open a .nc file (NetCDF-3 or NetCDF-4/HDF5), or drag one in.");

  // restore an autosaved session, if any, so an accidental tab close lost nothing
  restoreSession().then((ok) => { if (!ok) resetHistory(); }).catch(() => resetHistory());
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
window.__ncx = { state, redraw, X, D, openBuffer, onFilesChosen, buildFigure,
  addTab, switchTab, closeTab, duplicateTab, applyProject, buildProject, parseProject, projectText,
  commitDerived, registerAllDerived, rebindAll, missingFiles, undo, redo, hist, moveTrace, exportReportPDF,
  selectTreeVar: (f, v) => selectTreeVar(f, v, null), addTrace, newDerived, editDerived,
  applyDerivedToFile, findDef, closeFile };
