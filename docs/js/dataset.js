// dataset.js — a lightweight, xarray-like view over a parsed .nc file, plus
// format dispatch (NetCDF-3 vs HDF5) and the array helpers the explorer needs
// (isel slicing, transpose, coordinate access). Both readers produce the same
// { dims, attrs, variables:{ name:{dims,shape,attrs,dtype,isChar,data} }, coords }.

import { parseNetCDF3 } from "./netcdf3.js";
import { parseHDF5 } from "./hdf5.js";

export function openBuffer(buffer, filename) {
  if (!buffer || buffer.byteLength < 4)
    throw new Error("file is too small to be a NetCDF file");
  const u8 = new Uint8Array(buffer, 0, 4);
  if (u8[0] === 0x43 && u8[1] === 0x44 && u8[2] === 0x46)          // "CDF"
    return new Dataset(parseNetCDF3(buffer), filename);
  if (u8[0] === 0x89 && u8[1] === 0x48 && u8[2] === 0x44 && u8[3] === 0x46) // HDF5
    return new Dataset(parseHDF5(buffer, filename), filename);
  throw new Error("not a NetCDF file (magic is neither 'CDF' nor HDF5)");
}

// accepts both NetCDF-3 type names ("double","int") and numpy dtype strings
// from jsfive ("<f8","<i4","|u1","|b1"); numpy string types are S/U/O (capital)
const NC3_NUMERIC = /^(byte|short|int|float|double|ubyte|ushort|uint|int64|uint64)$/i;
const NPY_NUMERIC = /^[<>|=]?[fiub]\d+$/;   // case-sensitive: excludes S/U/O

export class Variable {
  constructor(name, v) {
    this.name = name;
    this.dims = v.dims.map(String);
    this.shape = v.shape.slice();
    this.attrs = v.attrs || {};
    this.dtype = v.dtype;
    this.isChar = !!v.isChar;
    this.data = v.data;                 // flat numeric array, or string / string[]
    this._maskFill();
  }
  // apply CF/netCDF _FillValue / missing_value: sentinels -> NaN so they gap
  // in the plot instead of being drawn as real data
  _maskFill() {
    if (this.isChar || typeof this.data === "string" || !this.data
        || this.data.length === undefined) return;
    const a = this.attrs || {};
    const fills = [];
    const push = (x) => { const n = Number(x); if (Number.isFinite(n)) fills.push(n); };
    if (a._FillValue != null) [].concat(a._FillValue).forEach(push);
    if (a.missing_value != null) [].concat(a.missing_value).forEach(push);
    if (!fills.length) return;
    const src = this.data;
    const out = new Float64Array(src.length);   // int arrays can't hold NaN
    const isFill = (x) => fills.some((fv) =>
      x === fv || (Math.abs(fv) > 1e30 && Math.abs(x - fv) <= Math.abs(fv) * 1e-5));
    for (let i = 0; i < src.length; i++) { const x = Number(src[i]); out[i] = isFill(x) ? NaN : x; }
    this.data = out;
  }
  get ndim() { return this.dims.length; }
  get size() { return this.shape.reduce((a, b) => a * b, 1); }
  isNumeric() {
    if (this.isChar) return false;
    const d = String(this.dtype || "");
    return NC3_NUMERIC.test(d) || NPY_NUMERIC.test(d);
  }
  // C-order strides for flat indexing
  strides() {
    const s = new Array(this.shape.length);
    let acc = 1;
    for (let i = this.shape.length - 1; i >= 0; i--) { s[i] = acc; acc *= this.shape[i]; }
    return s;
  }
}

export class Dataset {
  constructor(parsed, filename) {
    this.filename = filename || "";
    this.dims = parsed.dims;            // {name: size}
    this.attrs = parsed.attrs || {};
    this.coordNames = parsed.coords || new Set();
    this.vars = {};
    for (const [n, v] of Object.entries(parsed.variables)) this.vars[n] = new Variable(n, v);
  }
  has(name) { return this.vars[name] !== undefined; }
  variable(name) { return this.vars[name]; }
  varNames() { return Object.keys(this.vars); }
  isCoord(name) { return this.coordNames.has(name); }
  size(dim) { return this.dims[dim]; }

  // coordinate values for a dim (the same-named variable), or null
  coordValues(dim) {
    if (this.vars[dim] && !this.vars[dim].isChar) return this.vars[dim].data;
    return null;
  }

  // 1-D numeric/label variables/coords spanning exactly `dim` (natural axes)
  dimAxisCandidates(dim) {
    const out = [];
    for (const [n, v] of Object.entries(this.vars)) {
      if (n === dim) continue;
      if (v.dims.length === 1 && v.dims[0] === dim && (v.isNumeric() || isTimeLike(v)))
        out.push(n);
    }
    return out;
  }

  // isel: fixed integer index on some dims, keep the rest. Returns a plain
  // object {dims, shape, get(flatIndexIntoKeptDims)} — enough for the explorer.
  isel(varName, fixed) {
    const v = this.vars[varName];
    const strides = v.strides();
    const keptDims = [], keptShape = [], keptStride = [];
    let base = 0;
    v.dims.forEach((d, ax) => {
      if (Object.prototype.hasOwnProperty.call(fixed, d)) {
        let idx = fixed[d];
        idx = Math.max(0, Math.min(idx | 0, v.shape[ax] - 1));
        base += idx * strides[ax];
      } else {
        keptDims.push(d); keptShape.push(v.shape[ax]); keptStride.push(strides[ax]);
      }
    });
    return { dims: keptDims, shape: keptShape, base, keptStride, data: v.data };
  }
}

// pull a 1-D line out along `lineDim`, at fixed indices on the OTHER kept dims
export function lineAlong(view, lineDim, otherFixed) {
  const ax = view.dims.indexOf(lineDim);
  if (ax < 0) return new Float64Array(0);
  const n = view.shape[ax];
  const stride = view.keptStride[ax];
  let base = view.base;
  view.dims.forEach((d, i) => {
    if (i === ax) return;
    const idx = Math.max(0, Math.min((otherFixed[d] | 0), view.shape[i] - 1));
    base += idx * view.keptStride[i];
  });
  const out = new Float64Array(n);
  const data = view.data;
  for (let k = 0; k < n; k++) out[k] = Number(data[base + k * stride]);
  return out;
}

export function isTimeLike(v) {
  const u = String((v.attrs && v.attrs.units) || "").toLowerCase();
  return /since/.test(u) || /^(seconds|minutes|hours|days|nanoseconds|microseconds|milliseconds)\b/.test(u);
}
