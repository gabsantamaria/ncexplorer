"""xcheck_derive.py -- independent numpy/xarray reference for NC Explorer's
derived quantities (docs/js/derive.js), written from the spec (section 1), not
ported from the JS: every statistic is a vectorized array expression over the
whole variable instead of a per-line loop.

    python tests/xcheck_derive.py cases.json out.json

cases.json: [{"file": "<path>", "defs": [def, ...]}, ...]  (defs in any order)
out.json:   [{"file": ..., "results": {name: {"dims": [...], "shape": [...],
             "data": [... NaN -> null], "units": "..."} | {"error": "..."}}}, ...]

Used by tests/derive.test.mjs; needs numpy + xarray (+ h5netcdf / scipy).
"""
import json
import re
import sys
import warnings

import numpy as np
import xarray as xr


# ---- data access ----------------------------------------------------------
def units_of(v):
    return str(v.attrs.get("units", "")).strip() if v is not None else ""


def time_scale(units):
    """same seconds scaling as explore.js asFloatArray"""
    u = str(units or "").lower()
    if re.search(r"^nanoseconds\b|\bns\b", u):
        return 1e-9
    for pat, s in ((r"^microseconds\b", 1e-6), (r"^milliseconds\b", 1e-3),
                   (r"^minutes\b", 60.0), (r"^hours\b", 3600.0), (r"^days\b", 86400.0)):
        if re.search(pat, u):
            return s
    return 1.0


class Arr:
    """a numeric variable: float64 values + dim names + units"""
    def __init__(self, values, dims, units=""):
        self.values = np.asarray(values, dtype=np.float64)
        self.dims = tuple(dims)
        self.units = units

    def scaled(self):
        return self.values * time_scale(self.units)

    def size_of(self, d):
        return self.values.shape[self.dims.index(d)]


def to_dims(arr, dims_from, dims_to, shape_to):
    """broadcast array with dims `dims_from` onto (dims_to, shape_to) by NAME"""
    a = np.asarray(arr, dtype=np.float64)
    present = [d for d in dims_to if d in dims_from]
    a = np.transpose(a, [dims_from.index(d) for d in present]) if a.ndim else a
    shp = [shape_to[i] if d in dims_from else 1 for i, d in enumerate(dims_to)]
    return np.broadcast_to(a.reshape(shp), tuple(shape_to))


def is_db(u):
    return "db" in str(u or "").strip().lower()


def coord_of(env, dim):
    """the numeric 1-D coordinate variable named like `dim`, or None"""
    v = env.get(dim)
    if v is not None and v.dims == (dim,):
        return v
    return None


# ---- reduce -----------------------------------------------------------------
def to_db(r):
    with np.errstate(divide="ignore", invalid="ignore"):
        return np.where(r > 0, 10.0 * np.log10(np.where(r > 0, r, 1.0)), np.nan)


def reduce_def(env, d):
    src = env[d["src"]]
    over = d["over"]
    if over not in src.dims:
        raise ValueError("over not in src dims")
    rdims = [x for x in src.dims if x != over]
    rshape = [src.size_of(x) for x in rdims]
    n = src.size_of(over)
    full_dims = rdims + [over]
    full_shape = rshape + [n]
    y = to_dims(src.values, src.dims, full_dims, full_shape)

    xs = d.get("xsrc", "index")
    xu = ""
    if xs.startswith("var:"):
        xv = env[xs[4:]]
        x = to_dims(xv.scaled(), xv.dims, full_dims, full_shape)
        xu = xv.units
    elif xs == "coord" and coord_of(env, over) is not None:
        cv = coord_of(env, over)
        x = to_dims(cv.scaled(), (over,), full_dims, full_shape)
        xu = cv.units
    else:
        x = to_dims(np.arange(n, dtype=np.float64), (over,), full_dims, full_shape)

    w = d["window"]
    mode, region = w["mode"], d["region"]
    inf = np.inf
    if mode == "none":
        lo, hi, lo2, hi2 = -inf, inf, -inf, inf
    elif mode == "fixed":
        lo, hi = min(w["lo"], w["hi"]), max(w["lo"], w["hi"])
        if w.get("lo2") is not None and w.get("hi2") is not None:
            lo2, hi2 = min(w["lo2"], w["hi2"]), max(w["lo2"], w["hi2"])
        else:
            lo2, hi2 = -inf, inf
    else:
        c = w["center"]
        if c.startswith("coord:"):
            cd = c[6:]
            cv = coord_of(env, cd)
            vals = cv.scaled() if cv is not None else np.arange(rshape[rdims.index(cd)], dtype=np.float64)
            cen = to_dims(vals, (cd,), rdims, rshape)
        else:
            cv = env[c[4:]]
            cen = to_dims(cv.scaled(), cv.dims, rdims, rshape)
        m = w.get("k", 1) * cen + w.get("offset", 0)
        hw = abs(w["halfwidth"])
        hw2 = abs(w["halfwidth2"]) if w.get("halfwidth2") is not None else inf
        lo, hi = (m - hw)[..., None], (m + hw)[..., None]
        lo2, hi2 = (m - hw2)[..., None], (m + hw2)[..., None]
        # a NaN center makes the window undefined: no sample is a member of any region
        undef = ~np.isfinite(m)[..., None]

    with np.errstate(invalid="ignore"):
        in_in = (x >= lo) & (x <= hi)
        xok = ~np.isnan(x)
        if region == "inside":
            member = in_in
        elif region == "outside":
            member = ~in_in & xok
        else:
            member = ~in_in & xok & (x >= lo2) & (x <= hi2)
    if mode == "relative":
        member = member & ~undef
    contrib = member & np.isfinite(y)
    count = contrib.sum(axis=-1)

    db = d["db"] == "yes" or (d["db"] == "auto" and is_db(src.units))
    stat = d["stat"]
    with np.errstate(over="ignore", invalid="ignore", divide="ignore"), warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        v = np.power(10.0, y / 10.0) if db else y
        if stat == "count":
            r = count.astype(np.float64)
        elif stat in ("max", "argmax_x"):
            ym = np.where(contrib, y, -inf)
            k = np.argmax(ym, axis=-1)                         # first occurrence
            r = ym.max(axis=-1) if stat == "max" else np.take_along_axis(x, k[..., None], -1)[..., 0]
            r = np.where(count > 0, r, np.nan)
        elif stat in ("min", "argmin_x"):
            ym = np.where(contrib, y, inf)
            k = np.argmin(ym, axis=-1)
            r = ym.min(axis=-1) if stat == "min" else np.take_along_axis(x, k[..., None], -1)[..., 0]
            r = np.where(count > 0, r, np.nan)
        elif stat in ("sum", "mean", "std"):
            s = np.where(contrib, v, 0.0).sum(axis=-1)
            if stat == "sum":
                r = s
            else:
                mean = s / count
                if stat == "mean":
                    r = mean
                else:
                    dev = np.where(contrib, v - mean[..., None], 0.0)
                    r = np.sqrt((dev * dev).sum(axis=-1) / count)
            r = np.where(count > 0, r, np.nan)
        elif stat == "median":
            r = np.nanmedian(np.where(contrib, v, np.nan), axis=-1)
        elif stat == "integral":
            pair = contrib[..., :-1] & contrib[..., 1:]
            seg = 0.5 * (v[..., :-1] + v[..., 1:]) * np.abs(np.diff(x, axis=-1))
            r = np.where(pair, seg, 0.0).sum(axis=-1)
            r = np.where(pair.sum(axis=-1) > 0, r, np.nan)
        else:
            raise ValueError("unknown stat " + stat)
        r = np.asarray(r, dtype=np.float64)
        if db and stat in ("mean", "median", "std", "sum", "integral"):
            r = to_db(r)

    su = src.units
    if stat == "count":
        units = ""
    elif stat in ("argmax_x", "argmin_x"):
        units = xu
    elif stat == "integral":
        units = f"{su}·{xu}" if su and xu else (su or xu)
    else:
        units = su
    return Arr(r, rdims, units)


# ---- combine / transform ------------------------------------------------------
def combine_def(env, d):
    a = env[d["a"]]
    b = d["b"]
    op = d["op"]
    if isinstance(b, str):
        bv = env[b]
        dims = list(a.dims) + [x for x in bv.dims if x not in a.dims]
        shape = [a.size_of(x) if x in a.dims else bv.size_of(x) for x in dims]
        A = to_dims(a.values, a.dims, dims, shape)
        B = to_dims(bv.values, bv.dims, dims, shape)
        ua, ub = a.units, bv.units
    else:
        dims, shape = list(a.dims), list(a.values.shape)
        A, B = a.values, np.float64(b)
        ua, ub = a.units, ""
    fn = {"-": np.subtract, "+": np.add, "*": np.multiply, "/": np.divide,
          "max": np.maximum, "min": np.minimum}[op]
    with np.errstate(all="ignore"):
        r = fn(A, B)
    nu = lambda u: u.strip().lower()
    if op == "-":
        units = "dB" if isinstance(b, str) and is_db(ua) and is_db(ub) and nu(ua) == nu(ub) else ua
    elif op == "*":
        units = f"{ua}·{ub}" if ua and ub else (ua or ub)
    elif op == "/":
        if ua and nu(ua) == nu(ub):
            units = ""
        elif ua and ub:
            units = f"{ua}/{ub}"
        else:
            units = ua or (f"1/{ub}" if ub else "")
    else:
        units = ua
    return Arr(r, dims, units)


def transform_def(env, d):
    s = env[d["src"]]
    x = s.values
    fn = d["fn"]
    with np.errstate(all="ignore"):
        if fn == "db2lin":
            r = np.power(10.0, x / 10.0)
        elif fn == "lin2db":
            r = np.where(x > 0, 10.0 * np.log10(np.where(x > 0, x, 1.0)), np.nan)
        elif fn == "scale":
            r = x * d.get("scale", 1) + d.get("offset", 0)
        else:
            r = np.abs(x)
    su, ns = s.units, s.units.strip().lower()
    if fn == "db2lin":
        units = {"dbm": "mW", "dbw": "W", "db": ""}.get(ns, f"lin({su})" if su else "")
    elif fn == "lin2db":
        units = {"mw": "dBm", "w": "dBW"}.get(ns, "dB")
    else:
        units = su
    return Arr(r, s.dims, units)


# ---- driver -----------------------------------------------------------------------
def deps(d):
    out = []
    if d["kind"] == "combine":
        out = [d["a"]] + ([d["b"]] if isinstance(d["b"], str) else [])
    elif d["kind"] == "transform":
        out = [d["src"]]
    else:
        out = [d["src"]]
        if d["xsrc"].startswith("var:"):
            out.append(d["xsrc"][4:])
        c = d["window"].get("center", "")
        if c.startswith("var:"):
            out.append(c[4:])
    return out


def load_env(path):
    ds = xr.open_dataset(path, decode_times=False, decode_timedelta=False)
    env = {}
    for name, v in ds.variables.items():
        if v.dtype.kind in "fiub":
            env[name] = Arr(v.values, v.dims, units_of(v))
    return env


def run_case(case):
    env = load_env(case["file"])
    pending = list(case["defs"])
    results = {}
    while pending:                                   # simple repeated-pass topo order
        progressed = False
        for d in list(pending):
            if all(x in env or x in results for x in deps(d)) or any(
                    x in results and "error" in results[x] for x in deps(d)):
                pending.remove(d)
                progressed = True
                try:
                    if any(x in results and "error" in results[x] for x in deps(d)):
                        raise ValueError("dependency failed")
                    fn = {"reduce": reduce_def, "combine": combine_def,
                          "transform": transform_def}[d["kind"]]
                    a = fn(env, d)
                    data = np.where(np.isfinite(a.values), a.values, np.nan)
                    a.values = data
                    if d.get("units", "").strip():
                        a.units = d["units"].strip()
                    env[d["name"]] = a
                    results[d["name"]] = {
                        "dims": list(a.dims), "shape": list(data.shape), "units": a.units,
                        "data": [None if np.isnan(t) else float(t) for t in data.ravel()]}
                except Exception as e:                    # noqa: BLE001
                    results[d["name"]] = {"error": f"{type(e).__name__}: {e}"}
        if not progressed:
            for d in pending:
                results[d["name"]] = {"error": "unresolved dependency"}
            break
    return results


def main(argv):
    if len(argv) != 3:
        print(__doc__)
        return 2
    with open(argv[1], encoding="utf-8") as f:
        cases = json.load(f)
    out = [{"file": c["file"], "results": run_case(c)} for c in cases]
    with open(argv[2], "w", encoding="utf-8") as f:
        json.dump(out, f, allow_nan=False)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
