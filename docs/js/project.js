// project.js — save/load a visualization project (.ncproj, plain JSON): the
// file list, every trace with its slicing, all cosmetics, markers, and the
// locked plot size. Mirrors the desktop NC_Explorer project format so files
// interchange. Data files are referenced by name (the browser can't store
// absolute paths); on load the user re-picks any file that isn't already open.

import { DEFAULT_PLOTCFG, PROJECT_FORMAT } from "./explore.js";

export function buildProject(state) {
  return {
    format: PROJECT_FORMAT,
    created: new Date().toISOString(),
    files: state.fileOrder.slice(),        // display names
    plot: { ...state.plotcfg },
    traces: state.traces.map((t) => ({ ...t, slices: { ...t.slices } })),
    markers: state.markers.map((m) => ({ ...m })),
  };
}

export function downloadProject(state, name) {
  const blob = new Blob([JSON.stringify(buildProject(state), null, 2)],
    { type: "application/json" });
  triggerDownload(blob, name || "ncplot.ncproj");
}

// returns { plotcfg, traces, markers, files } sanitized; the caller resolves
// which files are open and remaps trace.file / marker indices.
export function parseProject(text) {
  const proj = JSON.parse(text);
  if (proj.format !== PROJECT_FORMAT) throw new Error("not an NC Explorer project");
  const plotcfg = { ...DEFAULT_PLOTCFG };
  for (const [k, v] of Object.entries(proj.plot || {})) {
    if (!(k in plotcfg)) continue;
    const dv = DEFAULT_PLOTCFG[k];
    if (typeof dv === "boolean") { if (typeof v === "boolean") plotcfg[k] = v; }
    else if (typeof dv === "number") { if (typeof v === "number") plotcfg[k] = v; }
    else if (typeof v === typeof dv) plotcfg[k] = v;
  }
  return {
    plotcfg,
    files: Array.isArray(proj.files) ? proj.files.map(String) : [],
    traces: Array.isArray(proj.traces) ? proj.traces : [],
    markers: Array.isArray(proj.markers) ? proj.markers : [],
  };
}

export function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
}
