// node_env.mjs — shared Node harness for the NC Explorer tests: loads the
// vendored h5wasm (an IIFE that declares a global `h5wasm`) into this realm so
// docs/js/hdf5.js can open NetCDF-4/HDF5 files exactly as in the browser, and
// re-exports a loadDataset(path) that goes through the app's own openBuffer.
// Also a tiny check()/summary() helper so test files need no framework.

import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = path.join(REPO, "tests", "data");
export const PYTHON = process.env.NCX_PYTHON || "python";

// hdf5.js reads window.h5wasm; in Node `window` is just the global object
globalThis.window = globalThis;
if (!globalThis.h5wasm) {
  vm.runInThisContext(fs.readFileSync(path.join(REPO, "docs/vendor/h5wasm.js"), "utf8")
    + "\n;globalThis.h5wasm = h5wasm;", { filename: "h5wasm.js" });
}
const { openBuffer } = await import(pathToFileURL(path.join(REPO, "docs/js/dataset.js")).href);

// file URL of a docs/js module (for dynamic import from tests)
export function moduleUrl(rel) { return pathToFileURL(path.join(REPO, "docs/js", rel)).href; }

export function dataFile(name) { return path.join(DATA_DIR, name); }
export function haveData(name) { return fs.existsSync(dataFile(name)); }

export async function loadDataset(file) {
  const b = fs.readFileSync(file);
  return openBuffer(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), path.basename(file));
}

// ---- minimal test reporting ------------------------------------------------
let _pass = 0, _fail = 0, _skip = 0;
const _failures = [];
export function check(name, cond, extra) {
  if (cond) { _pass++; return true; }
  _fail++;
  _failures.push(name);
  console.log(`FAIL ${name}` + (extra !== undefined ? `  -- ${typeof extra === "string" ? extra : JSON.stringify(extra)}` : ""));
  return false;
}
export function skip(name, why) { _skip++; console.log(`SKIP ${name}${why ? ": " + why : ""}`); }
export function counts() { return { pass: _pass, fail: _fail, skip: _skip }; }
// prints the tally; sets a failing exit code if anything failed
export function summary(label) {
  console.log(`${label ? label + ": " : ""}${_pass} passed, ${_fail} failed, ${_skip} skipped`);
  if (_fail) {
    console.log("failures:\n  " + _failures.join("\n  "));
    process.exitCode = 1;
  }
  return _fail === 0;
}
