// netcdf3.js — a self-contained NetCDF classic (CDF-1 / CDF-2 / CDF-5) reader.
//
// Pure browser JS, no dependencies: give it an ArrayBuffer, get back dimensions,
// variables (with typed-array data), coordinates, and attributes. The lab's
// instrument GUIs write CDF-2 (scipy engine); CDF-1 and CDF-5 are handled too.
// Record (unlimited-dimension) variables are supported, including the padded
// interleaved record layout.
//
// Spec: https://docs.unidata.ucar.edu/netcdf-c/current/file_format_specifications.html
// All integers are big-endian; strings/values are padded to 4-byte boundaries.

const NC_TAGS = { DIMENSION: 10, VARIABLE: 11, ATTRIBUTE: 12 };
// nc_type -> [name, bytes, DataView reader]
const NC_TYPE = {
  1: { name: "byte", bytes: 1, get: (dv, o) => dv.getInt8(o) },
  2: { name: "char", bytes: 1, get: (dv, o) => dv.getUint8(o) },
  3: { name: "short", bytes: 2, get: (dv, o) => dv.getInt16(o, false) },
  4: { name: "int", bytes: 4, get: (dv, o) => dv.getInt32(o, false) },
  5: { name: "float", bytes: 4, get: (dv, o) => dv.getFloat32(o, false) },
  6: { name: "double", bytes: 8, get: (dv, o) => dv.getFloat64(o, false) },
  // CDF-5 extras (rarely needed, but harmless to support)
  7: { name: "ubyte", bytes: 1, get: (dv, o) => dv.getUint8(o) },
  8: { name: "ushort", bytes: 2, get: (dv, o) => dv.getUint16(o, false) },
  9: { name: "uint", bytes: 4, get: (dv, o) => dv.getUint32(o, false) },
  10: { name: "int64", bytes: 8, get: (dv, o) => Number(dv.getBigInt64(o, false)) },
  11: { name: "uint64", bytes: 8, get: (dv, o) => Number(dv.getBigUint64(o, false)) },
};

class Reader {
  constructor(buffer) {
    this.dv = new DataView(buffer);
    this.u8 = new Uint8Array(buffer);
    this.pos = 0;
    this.version = 0;
  }
  _u32() { const v = this.dv.getUint32(this.pos, false); this.pos += 4; return v; }
  _i32() { const v = this.dv.getInt32(this.pos, false); this.pos += 4; return v; }
  _u64() { const v = Number(this.dv.getBigUint64(this.pos, false)); this.pos += 8; return v; }
  // "non-negative" count: 8 bytes in CDF-5, else 4
  _size() { return this.version === 5 ? this._u64() : this._u32(); }
  // file offset: 8 bytes in CDF-2/CDF-5, 4 in CDF-1
  _offset() { return this.version === 1 ? this._u32() : this._u64(); }

  _name() {
    const nchars = this._size();
    const bytes = this.u8.subarray(this.pos, this.pos + nchars);
    let s = "";
    for (let i = 0; i < nchars; i++) s += String.fromCharCode(bytes[i]);
    // decode UTF-8 if present (attribute strings can be UTF-8)
    try { s = new TextDecoder("utf-8").decode(bytes); } catch (e) { /* keep ascii */ }
    this.pos += nchars;
    this._pad(nchars);
    return s;
  }
  _pad(n) { const r = n % 4; if (r) this.pos += 4 - r; }

  _readValues(ncType, nelems) {
    const t = NC_TYPE[ncType];
    if (!t) throw new Error("unsupported nc_type " + ncType);
    if (ncType === 2) {                       // CHAR -> string
      const bytes = this.u8.subarray(this.pos, this.pos + nelems);
      this.pos += nelems; this._pad(nelems);
      let s;
      try { s = new TextDecoder("utf-8").decode(bytes); }
      catch (e) { s = ""; for (const b of bytes) s += String.fromCharCode(b); }
      return s.replace(/\0+$/, "");
    }
    const out = new Array(nelems);
    for (let i = 0; i < nelems; i++) { out[i] = t.get(this.dv, this.pos); this.pos += t.bytes; }
    this._pad(nelems * t.bytes);
    return out;
  }

  _attrList() {
    const tag = this._size();
    const n = this._size();
    const attrs = {};
    if (tag === 0 && n === 0) return attrs;
    if (tag !== NC_TAGS.ATTRIBUTE) throw new Error("bad attribute tag " + tag);
    for (let i = 0; i < n; i++) {
      const name = this._name();
      const nctype = this._i32();
      const nelems = this._size();
      const vals = this._readValues(nctype, nelems);
      attrs[name] = (Array.isArray(vals) && vals.length === 1) ? vals[0] : vals;
    }
    return attrs;
  }

  parseHeader() {
    if (this.u8[0] !== 0x43 || this.u8[1] !== 0x44 || this.u8[2] !== 0x46)
      throw new Error("not a NetCDF classic file (bad magic)");
    this.version = this.u8[3];
    if (![1, 2, 5].includes(this.version))
      throw new Error("unsupported NetCDF version byte " + this.version);
    this.pos = 4;
    let numrecs = this._size();            // STREAMING (all-1s) handled below
    if ((this.version !== 5 && numrecs === 0xffffffff)) numrecs = -1;

    // dim_list
    const dims = [];
    let tag = this._size(), n = this._size();
    if (tag === NC_TAGS.DIMENSION) {
      for (let i = 0; i < n; i++) {
        const name = this._name();
        const len = this._size();          // 0 => the record (unlimited) dim
        dims.push({ name, length: len, unlimited: len === 0 });
      }
    } else if (!(tag === 0 && n === 0)) throw new Error("bad dim tag " + tag);

    const gatts = this._attrList();

    // var_list
    const vars = [];
    tag = this._size(); n = this._size();
    if (tag === NC_TAGS.VARIABLE) {
      for (let i = 0; i < n; i++) {
        const name = this._name();
        const ndims = this._size();
        const dimids = [];
        for (let d = 0; d < ndims; d++) dimids.push(this._i32());
        const atts = this._attrList();
        const nctype = this._i32();
        const vsize = this._size();
        const begin = this._offset();
        const record = ndims > 0 && dims[dimids[0]] && dims[dimids[0]].unlimited;
        vars.push({ name, dimids, atts, nctype, vsize, begin, record });
      }
    } else if (!(tag === 0 && n === 0)) throw new Error("bad var tag " + tag);

    // if numrecs was streaming, infer it from the record vars + file size
    if (numrecs < 0) {
      const recVars = vars.filter((v) => v.record);
      const recSize = recVars.reduce((s, v) => s + v.vsize, 0);
      numrecs = recSize > 0
        ? Math.floor((this.dv.byteLength - Math.min(...recVars.map((v) => v.begin))) / recSize)
        : 0;
    }
    this.header = { numrecs, dims, gatts, vars };
    return this.header;
  }

  // materialize one variable's data as a flat JS Array (numbers) or string
  readVariable(v) {
    const t = NC_TYPE[v.nctype];
    if (v.nctype === 2) {
      // CHAR variable: decode as a string (join the whole thing)
      return this._readCharVar(v);
    }
    const shape = v.dimids.map((id) => {
      const d = this.header.dims[id];
      return d.unlimited ? this.header.numrecs : d.length;
    });
    const total = shape.reduce((a, b) => a * b, 1);
    const out = new Float64Array(total);
    if (!v.record) {
      let off = v.begin;
      for (let i = 0; i < total; i++) { out[i] = t.get(this.dv, off); off += t.bytes; }
    } else {
      // record var: element (r, rest...) at begin + r*recStride + rest*t.bytes
      const nrec = this.header.numrecs;
      const inner = total / Math.max(nrec, 1);      // elements per record slab
      const recVars = this.header.vars.filter((x) => x.record);
      const recStride = recVars.length === 1 ? v.vsize
        : recVars.reduce((s, x) => s + x.vsize, 0);
      let k = 0;
      for (let r = 0; r < nrec; r++) {
        let off = v.begin + r * recStride;
        for (let j = 0; j < inner; j++) { out[k++] = t.get(this.dv, off); off += t.bytes; }
      }
    }
    return out;
  }

  _readCharVar(v) {
    const shape = v.dimids.map((id) => {
      const d = this.header.dims[id];
      return d.unlimited ? this.header.numrecs : d.length;
    });
    const total = shape.reduce((a, b) => a * b, 1);
    // string(s): the last dim is the character length
    const clen = shape.length ? shape[shape.length - 1] : total;
    const nstr = clen ? total / clen : 1;
    const bytes = this.u8.subarray(v.begin, v.begin + total);
    const strings = [];
    for (let s = 0; s < nstr; s++) {
      const slice = bytes.subarray(s * clen, (s + 1) * clen);
      let str;
      try { str = new TextDecoder("utf-8").decode(slice); }
      catch (e) { str = ""; for (const b of slice) str += String.fromCharCode(b); }
      strings.push(str.replace(/\0+$/, ""));
    }
    return nstr === 1 ? strings[0] : strings;
  }
}

// Public API: parse an ArrayBuffer into a plain object dataset.
//   { dims:{name:size}, unlimited:name|null, attrs:{}, variables:{ name:{
//       dims:[...], shape:[...], attrs:{}, dtype, isChar, data } },
//     coords:Set<name> }
export function parseNetCDF3(buffer) {
  const r = new Reader(buffer);
  r.parseHeader();
  const h = r.header;
  const dims = {};
  let unlimited = null;
  for (const d of h.dims) {
    dims[d.name] = d.unlimited ? h.numrecs : d.length;
    if (d.unlimited) unlimited = d.name;
  }
  const variables = {};
  for (const v of h.vars) {
    const dimNames = v.dimids.map((id) => h.dims[id].name);
    const shape = v.dimids.map((id) =>
      h.dims[id].unlimited ? h.numrecs : h.dims[id].length);
    const isChar = v.nctype === 2;
    variables[v.name] = {
      dims: dimNames, shape, attrs: v.atts,
      dtype: NC_TYPE[v.nctype].name, isChar,
      data: r.readVariable(v),
    };
  }
  // a variable named exactly like a dimension is that dimension's coordinate
  const coords = new Set(Object.keys(variables).filter((n) => dims[n] !== undefined));
  return { dims, unlimited, attrs: h.gatts, variables, coords };
}

export const _internals = { NC_TYPE, Reader };
