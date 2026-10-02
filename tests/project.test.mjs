// project.test.mjs — persistence tests for docs/js/project.js (.ncproj):
//   node tests/project.test.mjs            (exit code 1 on any failure)
// (a) every real project on disk (tests/data/*.ncproj and ../data/**/*.ncproj,
//     read-only) parses with no trace/marker/tab lost, round-trips
//     save -> load -> save BYTE-IDENTICALLY (apart from "created"), and — when
//     its .nc files sit next to it — still draws every visible trace;
// (b) derived quantities + the new trace fields round-trip;
// (c) hostile / corrupt project files are contained.

import fs from "node:fs";
import path from "node:path";
import { check, skip, summary, loadDataset, moduleUrl, REPO, DATA_DIR } from "./node_env.mjs";

const P = await import(moduleUrl("project.js"));
const X = await import(moduleUrl("explore.js"));
const D = await import(moduleUrl("derive.js"));

// the app's applyProject, minus the DOM: parsed project -> live state
function stateFrom(parsed, fileOrder = []) {
  return {
    fileOrder,
    wantedFiles: [...new Set(parsed.files.map((f) => P.basename(f)))],
    projectOrder: [...new Set(parsed.files.map((f) => P.basename(f)))].map((f) => f.toLowerCase()),
    derived: parsed.derived.map((d) => JSON.parse(JSON.stringify(d))),
    active: parsed.active,
    tabs: parsed.tabs.map((pt) => ({
      name: pt.name, plotcfg: { ...pt.plotcfg }, cur: pt.selected,
      traces: pt.traces.map((t) => ({ ...t, slices: { ...t.slices } })),
      markers: pt.markers.map((m) => ({ ...m })),
    })),
  };
}
const strip = (text) => { const o = JSON.parse(text); delete o.created; return JSON.stringify(o, null, 2); };
const roundTrip = (state) => {
  const a = strip(P.projectText(state));
  const b = strip(P.projectText(stateFrom(P.parseProject(a), state.fileOrder)));
  return { a, b };
};

// ---------------------------------------------------------------- (a) real projects
function findProjects(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) findProjects(p, out);
    else if (/\.ncproj$/i.test(e.name)) out.push(p);
  }
  return out;
}
const projects = [...findProjects(DATA_DIR), ...findProjects(path.join(REPO, "..", "data"))];
if (!projects.length) skip("a: real projects", "none found");
const dsCache = new Map();
async function dsFor(dir, name) {
  // the project may name its file by an absolute (desktop) path: try the
  // basename next to the project, then case-insensitively
  const base = P.basename(name);
  const cands = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const hit = cands.find((f) => f === base) || cands.find((f) => f.toLowerCase() === base.toLowerCase());
  if (!hit) return null;
  const full = path.join(dir, hit);
  if (!dsCache.has(full)) {
    try { dsCache.set(full, await loadDataset(full)); } catch (e) { dsCache.set(full, null); }
  }
  return dsCache.get(full);
}

let drawn = 0, notDrawn = 0;
for (const file of projects) {
  const rel = path.relative(REPO, file);
  const text = fs.readFileSync(file, "utf8");
  const raw = JSON.parse(text);
  let parsed;
  try { parsed = P.parseProject(text); } catch (e) { check(`a: ${rel} parses`, false, e.message); continue; }
  const rawTabs = raw.format === "nc_explorer_project_v2" && Array.isArray(raw.tabs) && raw.tabs.length
    ? raw.tabs : [{ traces: raw.traces || [], markers: raw.markers || [] }];
  check(`a: ${rel} keeps every tab`, parsed.tabs.length === rawTabs.length, [parsed.tabs.length, rawTabs.length]);
  rawTabs.forEach((rt, i) => {
    const pt = parsed.tabs[i];
    check(`a: ${rel} tab ${i} keeps every trace`, pt.traces.length === (rt.traces || []).length,
      [pt.traces.length, (rt.traces || []).length]);
    check(`a: ${rel} tab ${i} keeps every marker`, pt.markers.length === (rt.markers || []).length);
    // every original field survives sanitization (file reduced to its basename)
    (rt.traces || []).forEach((t, k) => {
      const s = pt.traces[k];
      const same = s.file === P.basename(t.file) && s.var === t.var && s.line_dim === (t.line_dim || "")
        && s.sweep === (t.sweep || "") && JSON.stringify(s.slices) === JSON.stringify(t.slices || {})
        && s.xsrc === (t.xsrc || "index") && s.label === (t.label || t.var) && s.sweep_label === (t.sweep_label || "")
        && s.ssrc === (t.ssrc || "coord") && s.yaxis === (t.yaxis === "right" ? "right" : "left")
        && s.visible === (t.visible !== false) && s.color === (t.color || "");
      check(`a: ${rel} tab ${i} trace ${k} fields preserved`, same, { raw: t, parsed: s });
    });
    if (rt.plot) for (const [k, v] of Object.entries(rt.plot)) {
      if (!(k in X.DEFAULT_PLOTCFG) || k === "cmap" || k === "figw" || k === "figh") continue;
      check(`a: ${rel} tab ${i} plot.${k} preserved`, pt.plotcfg[k] === v, [pt.plotcfg[k], v]);
    }
  });
  const st = stateFrom(parsed);
  const { a, b } = roundTrip(st);
  check(`a: ${rel} save -> load -> save is byte-identical`, a === b);
  // the embedded-data projects keep working (bytes decode to a real dataset)
  if (parsed.embedded) {
    for (const [name, entry] of Object.entries(parsed.embedded.files)) {
      const buf = P.b64ChunksToAb(entry);
      check(`a: ${rel} embedded ${name} decodes (${buf.byteLength} B)`, buf.byteLength === entry.size);
    }
  }
  // traces still draw against the real data next to the project
  for (const pt of parsed.tabs) for (const t of pt.traces) {
    if (t.visible === false) continue;
    const ds = await dsFor(path.dirname(file), t.file);
    if (!ds) continue;
    const r = X.traceLines(ds, t, () => {});
    if (r.lines.length && r.lines[0].y.length) drawn++;
    else { notDrawn++; check(`a: ${rel} trace ${t.var} draws`, false, t); }
  }
}
console.log(`INFO real projects: ${projects.length} files, ${drawn} visible traces drawn from their data (${notDrawn} failed)`);

// ---------------------------------------------------------------- (b) derived + new fields
{
  const peak = { ...D.newDef("reduce", "darpa.nc"), name: "pk", src: "spectrums", over: "TraceIndex", xsrc: "var:frequencies",
    window: { mode: "relative", lo: null, hi: null, lo2: null, hi2: null, center: "coord:stimulusFrequency", k: 1, offset: 0,
      halfwidth: 1e6, halfwidth2: null }, region: "inside", stat: "max", db: "auto" };
  const floor = { ...peak, name: "fl", stat: "median", region: "outside_within",
    window: { ...peak.window, halfwidth2: 5e6 }, units: "dBm", description: "noise “floor” ± 5 MHz" };
  const snr = { ...D.newDef("combine", "darpa.nc"), name: "snr", a: "pk", op: "-", b: "fl" };
  const scaled = { ...D.newDef("transform", "darpa.nc"), name: "half", src: "snr", fn: "scale", scale: 0.5, offset: -3 };
  const constB = { ...D.newDef("combine", "darpa.nc"), name: "pk_rel", a: "pk", op: "-", b: -40.5 };
  const tr = X.makeTrace("darpa.nc", "snr", "stimulusFrequency", "coord", "stimulusAmp", { trace: 2 }, "SNR", "index");
  Object.assign(tr, { yaxis: "right", color: "#123abc", draw: "lines+markers", lw: 2.5, dash: "dashdot", visible: false,
    sweep_label: "A = {v} V ({n})" });
  const st = {
    fileOrder: ["darpa.nc", "sidebands.nc"], wantedFiles: ["missing.nc"], projectOrder: [], active: 1,
    derived: [peak, floor, snr, scaled, constB].map(D.canonicalDef),
    tabs: [
      { name: "A", plotcfg: { ...X.DEFAULT_PLOTCFG, title: "tab A", xunit: "M", ymin: "-80", lock_size: true, figw: 6.5 },
        traces: [tr], markers: [{ trace: 0, line: 1, idx: 0 }], cur: 0 },
      { name: "B ünïcødé \"quoted\" \\ back", plotcfg: { ...X.DEFAULT_PLOTCFG, mode: "Rainbow", cmap: "Turbo" },
        traces: [X.makeTrace("missing.nc", "v", "d", "index", "", {}, "v")], markers: [], cur: 0 },
    ],
  };
  const { a, b } = roundTrip(st);
  check("b: derived + new fields round-trip byte-identically", a === b);
  const p = P.parseProject(a);
  check("b: 5 derived defs survive in order", p.derived.map((d) => d.name).join(",") === "pk,fl,snr,half,pk_rel");
  check("b: numeric b (constant) survives", p.derived[4].b === -40.5);
  check("b: description with quotes survives", p.derived[1].description === "noise “floor” ± 5 MHz");
  const t = p.tabs[0].traces[0];
  check("b: draw/lw/dash survive", t.draw === "lines+markers" && t.lw === 2.5 && t.dash === "dashdot");
  check("b: hidden trace survives", t.visible === false);
  check("b: selected survives", p.tabs[0].selected === 0 && p.tabs[1].selected === 0);
  check("b: a missing file is still listed", JSON.parse(a).files.includes("missing.nc"));
  check("b: trace of a missing file is kept", p.tabs[1].traces.length === 1 && p.tabs[1].traces[0].file === "missing.nc");
  check("b: canonical trace key order", Object.keys(JSON.parse(a).tabs[0].traces[0]).join(",") === X.TRACE_KEYS.join(","));
  // older traces (no draw/lw/dash) get the defaults
  const old = P.parseProject(JSON.stringify({ format: "nc_explorer_project_v2", tabs: [{ traces: [{ file: "a.nc", var: "x" }] }] }));
  const ot = old.tabs[0].traces[0];
  check("b: old trace defaults", ot.draw === "lines" && ot.lw === 1.5 && ot.dash === "auto" && ot.ssrc === "coord" && ot.xsrc === "index");
  check("b: project without 'derived' -> []", Array.isArray(old.derived) && old.derived.length === 0);
}

// ---------------------------------------------------------------- (c) hostile input
{
  const evil = JSON.stringify({
    format: "nc_explorer_project_v2", active: 99,
    tabs: [
      { name: "x".repeat(500), plot: { figw: 1e9, figh: -5, title: 7, cmap: "nope", __proto__: { polluted: 1 } },
        traces: [
          { file: "C:\\a\\b\\data.nc", var: "v", slices: { __proto__: { polluted: 1 }, constructor: 3, d: "7", e: -2, f: 1e99 },
            lw: "wide", draw: "bars", dash: 3, color: "red", yaxis: "up", label: { a: 1 } },
          null, 42, { var: "" },
          { file: "b.nc", var: "w" },
        ],
        markers: [{ trace: 0, line: 0, idx: 1 }, { trace: 1, line: 0, idx: 1 }, { trace: 4, line: -3, idx: 2 }, "junk"] },
    ],
    derived: [
      { name: "ok1", kind: "reduce", src: "v", over: "d" },
      { name: "bad name!", kind: "reduce" },
      { name: "k2", kind: "nope" },
      { name: "k3", kind: "combine", a: "v", op: "**", b: "w" },
      JSON.parse('{"__proto__": {"polluted": 1}, "name": "k4", "kind": "transform", "src": "v", "fn": "abs"}'),
      "junk", null,
    ],
  });
  const p = P.parseProject(evil);
  check("c: no prototype pollution", ({}).polluted === undefined && Object.prototype.polluted === undefined);
  const tb = p.tabs[0];
  check("c: tab name capped", tb.name.length === 80);
  check("c: figw/figh clamped", tb.plotcfg.figw === 40 && tb.plotcfg.figh === 2);
  check("c: wrong-type title ignored", tb.plotcfg.title === "");
  check("c: unknown cmap -> default", tb.plotcfg.cmap === X.DEFAULT_PLOTCFG.cmap);
  check("c: junk traces dropped, 2 kept", tb.traces.length === 2, tb.traces.length);
  const t0 = tb.traces[0];
  check("c: path reduced to basename", t0.file === "data.nc");
  check("c: slices sanitized", JSON.stringify(t0.slices) === JSON.stringify({ d: 7, e: 0, f: 2 ** 31 - 1 }), t0.slices);
  check("c: bad style fields -> defaults", t0.lw === 1.5 && t0.draw === "lines" && t0.dash === "auto" && t0.color === "" && t0.yaxis === "left");
  check("c: object label -> var name", t0.label === "v");
  check("c: markers remapped to surviving traces", JSON.stringify(tb.markers) === JSON.stringify([
    { trace: 0, line: 0, idx: 1 }, { trace: 1, line: 0, idx: 2 }]), tb.markers);
  check("c: active clamped", p.active === 0);
  check("c: only valid derived defs kept", p.derived.map((d) => d.name).join(",") === "ok1,k4", p.derived.map((d) => d.name));
  // caps
  const many = JSON.stringify({ format: "nc_explorer_project_v2",
    tabs: Array.from({ length: 100 }, () => ({ traces: Array.from({ length: 600 }, () => ({ file: "a.nc", var: "v" })) })),
    derived: Array.from({ length: 400 }, (_, i) => ({ name: "d" + i, kind: "transform", src: "v", fn: "abs" })) });
  const pm = P.parseProject(many);
  check("c: tabs capped at 64", pm.tabs.length === 64);
  check("c: traces capped at 512 per tab", pm.tabs[0].traces.length === 512);
  check("c: derived capped at 256", pm.derived.length === D.MAX_DERIVED);
  let threw = false;
  try { P.parseProject('{"format":"something else"}'); } catch (e) { threw = true; }
  check("c: foreign JSON rejected", threw);
}

summary("project");
