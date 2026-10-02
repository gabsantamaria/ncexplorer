// project.js — save/load a visualization project (.ncproj, plain JSON).
//
// v2 format holds MULTIPLE tabs (each an independently-formatted plot) that share
// the session's datasets, the project-level DERIVED quantities (virtual
// variables computed from the data — see derive.js), plus — optionally — the .nc
// file bytes embedded as base64 so the whole project is self-contained in one
// file. For backward and forward compatibility a v2 file ALSO mirrors the active
// tab at the top level (plot/traces/markers), so a v1 or desktop reader that keys
// off those still opens one valid plot. Loading a v1 (or desktop) single-plot
// file yields one tab. New fields are additive (older app versions ignore them).
//
// Serialization is CANONICAL (fixed key order, defaults filled in), so a project
// saved -> loaded -> saved again is byte-identical apart from "created".
//
// Data files are referenced by name; on load, files that aren't already open and
// aren't embedded must be re-picked by the user (their traces and derived
// quantities are kept and resolve as soon as the file is opened).

import { DEFAULT_PLOTCFG, PROJECT_FORMAT, PROJECT_FORMAT_V2, DRAW_MODES, DASHES, LW_DEFAULT } from "./explore.js";
import { CMAP_NAMES } from "./colormaps.js";
import { sanitizeDef, canonicalDef, MAX_DERIVED } from "./derive.js";

const MAX_TABS = 64;
const MAX_TRACES = 512;          // per tab
const MAX_MARKERS = 1000;        // per tab
const BAD_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function basename(p) { return String(p).replace(/\\/g, "/").split("/").pop(); }

// ---- canonical serializers ---------------------------------------------------

// one trace in canonical key order (missing newer fields get their defaults)
export function traceToJSON(t) {
  const slices = {};
  for (const [k, v] of Object.entries(t.slices || {})) if (!BAD_KEYS.has(k)) slices[k] = v | 0;
  return {
    file: t.file, var: t.var, line_dim: t.line_dim || "", sweep: t.sweep || "", slices,
    xsrc: t.xsrc || "index", label: t.label || t.var, sweep_label: t.sweep_label || "",
    ssrc: t.ssrc || "coord", yaxis: t.yaxis === "right" ? "right" : "left",
    visible: t.visible !== false, color: t.color || "",
    draw: DRAW_MODES.includes(t.draw) ? t.draw : "lines",
    lw: Number.isFinite(t.lw) ? t.lw : LW_DEFAULT,
    dash: DASHES.includes(t.dash) ? t.dash : "auto",
  };
}

// cosmetics in DEFAULT_PLOTCFG key order
function plotToJSON(pc) {
  const o = {};
  for (const k of Object.keys(DEFAULT_PLOTCFG)) o[k] = (pc && k in pc) ? pc[k] : DEFAULT_PLOTCFG[k];
  return o;
}

function markerToJSON(m) { return { trace: m.trace | 0, line: m.line | 0, idx: m.idx | 0 }; }

// deep-copy one tab record into its serializable shape
function tabToJSON(tb) {
  const n = tb.traces.length;
  return {
    name: tb.name,
    plot: plotToJSON(tb.plotcfg),
    traces: tb.traces.map(traceToJSON),
    markers: tb.markers.map(markerToJSON),
    selected: n ? Math.max(-1, Math.min(tb.cur | 0, n - 1)) : -1,
  };
}

// every file the project refers to: the open files (in open order), then any
// file the project still WANTS but isn't open yet (e.g. a loaded project whose
// data hasn't been re-picked), so saving never forgets them
function projectFiles(state) {
  const out = state.fileOrder.slice();
  const have = new Set(out.map((f) => basename(f).toLowerCase()));
  const add = (f) => {
    if (!f) return;
    const b = basename(f);
    if (!have.has(b.toLowerCase())) { have.add(b.toLowerCase()); out.push(b); }
  };
  for (const f of state.wantedFiles || []) add(f);
  for (const tb of state.tabs) for (const t of tb.traces) add(t.file);
  for (const d of state.derived || []) add(d.file);
  // keep the order of the project these files came from (open order otherwise),
  // so saving never reshuffles a loaded project's file list
  const rank = new Map((state.projectOrder || []).map((b, i) => [b, i]));
  const r = (f) => { const k = rank.get(basename(f).toLowerCase()); return k === undefined ? Infinity : k; };
  return out.map((f, i) => [f, i]).sort((a, b) => (r(a[0]) - r(b[0])) || (a[1] - b[1])).map((e) => e[0]);
}

// opts.embedded (optional) is attached verbatim under "embedded".
export function buildProject(state, opts = {}) {
  const tabs = state.tabs;
  const active = Math.max(0, Math.min(state.active | 0, tabs.length - 1));
  const mirror = tabs[active] || tabs[0];
  const proj = {
    format: PROJECT_FORMAT_V2,
    created: new Date().toISOString(),
    files: projectFiles(state),
    active,
    tabs: tabs.map(tabToJSON),
    // forward/back-compat: the active tab duplicated at top level for v1/desktop
    // readers. A v2 reader ignores these and uses "tabs".
    plot: plotToJSON(mirror.plotcfg),
    traces: mirror.traces.map(traceToJSON),
    markers: mirror.markers.map(markerToJSON),
    // project-level derived quantities (shared by all tabs, like the datasets)
    derived: (state.derived || []).map(canonicalDef),
  };
  if (opts.embedded) proj.embedded = opts.embedded;
  return proj;
}

export function projectText(state, opts) {
  return JSON.stringify(buildProject(state, opts), null, opts && opts.embedded ? 0 : 2);
}

export function downloadProject(state, name, opts) {
  const blob = new Blob([projectText(state, opts)], { type: "application/json" });
  triggerDownload(blob, name || "ncplot.ncproj");
}

// --- sanitizers -------------------------------------------------------------

// sanitize a raw cosmetics object into a full plotcfg (clamp sizes, block
// prototype pollution, only accept known keys with the right type, canonicalize
// the colormap name to the web app's case).
function sanitizePlot(rawPlot) {
  const plotcfg = { ...DEFAULT_PLOTCFG };
  for (const [k, v] of Object.entries(rawPlot || {})) {
    if (BAD_KEYS.has(k)) continue;
    if (!(k in plotcfg)) continue;
    const dv = DEFAULT_PLOTCFG[k];
    if (typeof dv === "boolean") { if (typeof v === "boolean") plotcfg[k] = v; }
    else if (typeof dv === "number") { if (typeof v === "number") plotcfg[k] = v; }
    else if (typeof v === typeof dv) plotcfg[k] = v.slice(0, 400);
  }
  // a hostile/corrupt project could set a huge figw/figh -> a giant Plotly
  // canvas that hangs the tab; clamp to the same range the UI allows
  plotcfg.figw = Math.min(40, Math.max(2, Number.isFinite(plotcfg.figw) ? plotcfg.figw : DEFAULT_PLOTCFG.figw));
  plotcfg.figh = Math.min(40, Math.max(2, Number.isFinite(plotcfg.figh) ? plotcfg.figh : DEFAULT_PLOTCFG.figh));
  // desktop projects use lowercase colormap names ("viridis"); map to canonical case
  const canon = CMAP_NAMES.find((n) => n.toLowerCase() === String(plotcfg.cmap).toLowerCase());
  plotcfg.cmap = canon || DEFAULT_PLOTCFG.cmap;
  return plotcfg;
}

function str(v, dflt, max) {
  const s = typeof v === "string" ? v : (v == null ? dflt : (typeof v === "object" ? dflt : String(v)));
  return s.slice(0, max);
}

// one raw trace -> a structurally valid trace record (or null). Dimension
// names are checked against the dataset later, once its file is open.
export function sanitizeTrace(raw) {
  if (!raw || typeof raw !== "object") return null;
  const varName = str(raw.var, "", 256);
  if (!varName) return null;
  const slices = {};
  if (raw.slices && typeof raw.slices === "object" && !Array.isArray(raw.slices)) {
    for (const [k, v] of Object.entries(raw.slices)) {
      if (BAD_KEYS.has(k) || k.length > 256) continue;
      const n = Number(v);
      slices[k] = Number.isFinite(n) ? Math.max(0, Math.min(2 ** 31 - 1, Math.trunc(n))) : 0;
    }
  }
  const lw = Number(raw.lw);
  return {
    file: basename(str(raw.file, "", 1024)), var: varName,
    line_dim: str(raw.line_dim, "", 256), sweep: str(raw.sweep, "", 256), slices,
    xsrc: str(raw.xsrc, "index", 300) || "index",
    label: str(raw.label, "", 200) || varName,
    sweep_label: str(raw.sweep_label, "", 200),
    ssrc: str(raw.ssrc, "coord", 300) || "coord",
    yaxis: raw.yaxis === "right" ? "right" : "left",
    visible: raw.visible !== false,
    color: (typeof raw.color === "string" && /^#[0-9a-fA-F]{6}$/.test(raw.color)) ? raw.color : "",
    draw: DRAW_MODES.includes(raw.draw) ? raw.draw : "lines",
    lw: Number.isFinite(lw) ? Math.min(10, Math.max(0.25, lw)) : LW_DEFAULT,
    dash: DASHES.includes(raw.dash) ? raw.dash : "auto",
  };
}

function sanitizeName(v, i) { return (String(v == null ? "" : v).trim().slice(0, 80)) || ("Plot " + (i + 1)); }
function clampInt(v, lo, hi) { const n = Math.trunc(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : lo; }

function parsedTab(raw, i) {
  const rawTraces = Array.isArray(raw && raw.traces) ? raw.traces.slice(0, MAX_TRACES) : [];
  const traces = [], remap = {};
  rawTraces.forEach((t, k) => { const s = sanitizeTrace(t); if (s) { remap[k] = traces.length; traces.push(s); } });
  const rawMarkers = Array.isArray(raw && raw.markers) ? raw.markers.slice(0, MAX_MARKERS) : [];
  const markers = rawMarkers
    .filter((m) => m && typeof m === "object" && remap[m.trace | 0] !== undefined)
    .map((m) => ({ trace: remap[m.trace | 0], line: Math.max(0, m.line | 0), idx: Math.max(0, m.idx | 0) }));
  const hasSel = raw && raw.selected !== undefined && raw.selected !== null;
  return {
    name: sanitizeName(raw && raw.name, i),
    plotcfg: sanitizePlot(raw && raw.plot),
    traces, markers,
    selected: traces.length ? (hasSel ? clampInt(raw.selected, -1, traces.length - 1) : 0) : -1,
  };
}

// returns { version, format, files, active, tabs:[{name,plotcfg,traces,markers,selected}], derived, embedded }
export function parseProject(text) {
  const proj = JSON.parse(text);
  if (!proj || typeof proj !== "object") throw new Error("not an NC Explorer project");
  const fmt = proj.format;
  const isV2 = fmt === PROJECT_FORMAT_V2;
  const isV1 = fmt === PROJECT_FORMAT;
  if (!isV2 && !isV1) throw new Error("not an NC Explorer project");

  let tabs, active;
  if (isV2 && Array.isArray(proj.tabs) && proj.tabs.length) {
    tabs = proj.tabs.slice(0, MAX_TABS).map(parsedTab);
    active = clampInt(proj.active, 0, tabs.length - 1);
  } else {
    // v1 / desktop, or a v2 file missing its tabs array: one tab from top-level
    tabs = [parsedTab({ name: "Plot 1", plot: proj.plot, traces: proj.traces, markers: proj.markers }, 0)];
    active = 0;
  }

  const files = Array.isArray(proj.files)
    ? proj.files.slice(0, 1000).filter((f) => typeof f === "string").map((f) => f.slice(0, 1024))
    : [];
  for (const tb of tabs) for (const t of tb.traces)
    if (t.file && !files.some((f) => basename(f).toLowerCase() === t.file.toLowerCase())) files.push(t.file);

  // derived quantities: sanitized (unknown keys dropped, types checked, capped)
  const derived = [];
  if (Array.isArray(proj.derived)) {
    for (const raw of proj.derived.slice(0, MAX_DERIVED)) {
      const d = sanitizeDef(raw);
      if (d) derived.push(d);
    }
  }

  // carry embedded bytes through only if it looks like the expected shape
  let embedded = null;
  if (proj.embedded && typeof proj.embedded === "object" && proj.embedded.files
      && typeof proj.embedded.files === "object") {
    embedded = proj.embedded;
  }

  return { version: isV2 ? 2 : 1, format: fmt, files, active, tabs, derived, embedded };
}

// --- base64 embedding (pure, testable) --------------------------------------
// _CHUNK is a multiple of 3 so every chunk encodes a whole number of 3-byte
// groups => each chunk is independently valid base64 (no mid-stream padding),
// and the decoder can concatenate by byte offset.
const _CHUNK = 0x30000;   // 196608 = 65536 * 3

export function abToB64Chunks(buf) {
  const u8 = new Uint8Array(buf), chunks = [];
  for (let off = 0; off < u8.length; off += _CHUNK) {
    const end = Math.min(off + _CHUNK, u8.length);
    let s = "";
    // sub-window keeps String.fromCharCode.apply arg count small (avoids RangeError)
    for (let i = off; i < end; i += 0x8000)
      s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + 0x8000, end)));
    chunks.push(btoa(s));
  }
  return chunks;
}

const _MAX_EMBED = 2e9;   // hard ceiling on a single decoded file (bytes)

export function b64ChunksToAb(entry) {
  const chunks = Array.isArray(entry.chunks) ? entry.chunks
    : (typeof entry.b64 === "string" ? [entry.b64]
      : (Array.isArray(entry.b64) ? entry.b64 : []));
  // Use a real numeric compare (NOT `| 0`, which truncates to int32 and would
  // let a declared size >= 2^31 wrap past the ceiling). A present-but-invalid
  // size is rejected outright so the caller's try/catch skips the file.
  const declared = Number(entry.size);
  const hasSize = Number.isFinite(declared) && declared >= 0 && declared <= _MAX_EMBED;
  if (entry.size != null && !hasSize) throw new Error("embedded file size invalid");

  if (hasSize) {
    // known size: stream chunk-by-chunk into a pre-sized buffer (low peak memory)
    const out = new Uint8Array(declared);
    let off = 0;
    for (const c of chunks) {
      if (typeof c !== "string") continue;
      const bin = atob(c);
      for (let i = 0; i < bin.length && off < out.length; i++) out[off++] = bin.charCodeAt(i);
    }
    return out.buffer;
  }

  // unknown size (foreign/hand-authored file): count first with a hard cap so a
  // malicious project can't grow an unbounded array, then fill.
  let total = 0;
  for (const c of chunks) {
    if (typeof c !== "string") continue;
    total += atob(c).length;
    if (total > _MAX_EMBED) throw new Error("embedded file too large");
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    if (typeof c !== "string") continue;
    const bin = atob(c);
    for (let i = 0; i < bin.length && off < out.length; i++) out[off++] = bin.charCodeAt(i);
  }
  return out.buffer;
}

export function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
}
