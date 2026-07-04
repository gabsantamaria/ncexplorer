// project.js — save/load a visualization project (.ncproj, plain JSON).
//
// v2 format holds MULTIPLE tabs (each an independently-formatted plot) that share
// the session's datasets, plus — optionally — the .nc file bytes embedded as
// base64 so the whole project is self-contained in one file. For backward and
// forward compatibility a v2 file ALSO mirrors the active tab at the top level
// (plot/traces/markers), so a v1 or desktop reader that keys off those still
// opens one valid plot. Loading a v1 (or desktop) single-plot file yields one tab.
//
// Data files are referenced by name; on load, files that aren't already open and
// aren't embedded must be re-picked by the user.

import { DEFAULT_PLOTCFG, PROJECT_FORMAT, PROJECT_FORMAT_V2 } from "./explore.js";
import { CMAP_NAMES } from "./colormaps.js";

const MAX_TABS = 64;

// deep-copy one tab record into its serializable plot/traces/markers shape
function tabToJSON(tb) {
  return {
    name: tb.name,
    plot: { ...tb.plotcfg },
    traces: tb.traces.map((t) => ({ ...t, slices: { ...t.slices } })),
    markers: tb.markers.map((m) => ({ ...m })),
  };
}

// union of every tab's referenced file names (basenames as stored on traces)
function filesFromTabs(tabs) {
  const seen = new Set(), out = [];
  for (const tb of tabs) for (const t of (tb.traces || [])) {
    const f = t.file;
    if (f && !seen.has(f)) { seen.add(f); out.push(f); }
  }
  return out;
}

// opts.embedded (optional) is attached verbatim under "embedded".
export function buildProject(state, opts = {}) {
  const tabs = state.tabs;
  const active = Math.max(0, Math.min(state.active | 0, tabs.length - 1));
  const mirror = tabs[active] || tabs[0];
  const proj = {
    format: PROJECT_FORMAT_V2,
    created: new Date().toISOString(),
    files: state.fileOrder.slice(),        // shared display names
    active,
    tabs: tabs.map(tabToJSON),
    // forward/back-compat: the active tab duplicated at top level for v1/desktop
    // readers. A v2 reader ignores these and uses "tabs".
    plot: { ...mirror.plotcfg },
    traces: mirror.traces.map((t) => ({ ...t, slices: { ...t.slices } })),
    markers: mirror.markers.map((m) => ({ ...m })),
  };
  if (opts.embedded) proj.embedded = opts.embedded;
  return proj;
}

export function downloadProject(state, name, opts) {
  const blob = new Blob([JSON.stringify(buildProject(state, opts), null, opts && opts.embedded ? 0 : 2)],
    { type: "application/json" });
  triggerDownload(blob, name || "ncplot.ncproj");
}

// --- sanitizers -------------------------------------------------------------

// sanitize a raw cosmetics object into a full plotcfg (clamp sizes, block
// prototype pollution, only accept known keys with the right type, canonicalize
// the colormap name to the web app's case).
function sanitizePlot(rawPlot) {
  const plotcfg = { ...DEFAULT_PLOTCFG };
  for (const [k, v] of Object.entries(rawPlot || {})) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
    if (!(k in plotcfg)) continue;
    const dv = DEFAULT_PLOTCFG[k];
    if (typeof dv === "boolean") { if (typeof v === "boolean") plotcfg[k] = v; }
    else if (typeof dv === "number") { if (typeof v === "number") plotcfg[k] = v; }
    else if (typeof v === typeof dv) plotcfg[k] = v;
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

function sanitizeName(v, i) { return (String(v == null ? "" : v).trim().slice(0, 80)) || ("Plot " + (i + 1)); }
function clampInt(v, lo, hi) { const n = (v | 0); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : lo; }

function parsedTab(raw, i) {
  return {
    name: sanitizeName(raw && raw.name, i),
    plotcfg: sanitizePlot(raw && raw.plot),
    traces: Array.isArray(raw && raw.traces) ? raw.traces : [],
    markers: Array.isArray(raw && raw.markers) ? raw.markers : [],
  };
}

// returns { version, format, files, active, tabs:[{name,plotcfg,traces,markers}], embedded }
export function parseProject(text) {
  const proj = JSON.parse(text);
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

  const files = Array.isArray(proj.files) ? proj.files.map(String) : filesFromTabs(tabs);

  // carry embedded bytes through only if it looks like the expected shape
  let embedded = null;
  if (proj.embedded && typeof proj.embedded === "object" && proj.embedded.files
      && typeof proj.embedded.files === "object") {
    embedded = proj.embedded;
  }

  return { version: isV2 ? 2 : 1, format: fmt, files, active, tabs, embedded };
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
