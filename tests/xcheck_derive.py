"""xcheck_derive.py -- independent numpy/xarray reference for NC Explorer's
derived quantities (docs/js/derive.js + docs/js/expr.js), written from the
specs (SPEC.md section 1, SPEC_EXPR.md E1/E2), not ported from the JS: every
statistic is a vectorized array expression over the whole variable instead of
a per-line loop, and expressions are not parsed by a recursive-descent parser
but translated token by token into a Python expression (the E1 grammar has
exactly Python's precedence once `^` becomes `**`: unary minus binds looser
than `**`, `**` is right-associative and takes a signed exponent) that numpy
evaluates -- once with arrays for the values, once with unit objects whose
operators implement the E1 units rules.

    python tests/xcheck_derive.py cases.json out.json

cases.json: [{"file": "<path>", "defs": [def, ...]}, ...]  (defs in any order,
            canonical NEW-format defs: window expressions, kind "formula")
out.json:   [{"file": ..., "results": {name: {"dims": [...], "shape": [...],
             "data": [... NaN -> null], "units": "..."} | {"error": "..."}}}, ...]

Used by tests/derive.test.mjs; needs numpy + xarray (+ h5netcdf / scipy).
"""
import functools
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


class Env(dict):
    """name -> Arr (numeric variables, real and derived) + .dims {dim: size}"""
    dims = None


def to_dims(arr, dims_from, dims_to, shape_to):
    """broadcast array with dims `dims_from` onto (dims_to, shape_to) by NAME"""
    a = np.asarray(arr, dtype=np.float64)
    for d in dims_from:
        if d not in dims_to:
            raise ValueError(f"dim {d} not in {dims_to}")
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


# ---- expressions (SPEC_EXPR E1) ---------------------------------------------
SI = {"p": 1e-12, "n": 1e-9, "u": 1e-6, "µ": 1e-6, "μ": 1e-6, "m": 1e-3,
      "k": 1e3, "K": 1e3, "M": 1e6, "G": 1e9, "T": 1e12}
NUM = re.compile(r"([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?")
IDENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
FUNCS = ("abs", "sqrt", "exp", "ln", "log", "log10", "floor", "ceil", "round",
         "db2lin", "lin2db", "pow", "min", "max")


def tokenize(text):
    """[(kind, value)]: ("num", float) | ("name", str) | ("call", fn) | ("op", python op)"""
    toks, i, n = [], 0, len(text)
    while i < n:
        c = text[i]
        if c in " \t\r\n":
            i += 1
            continue
        m = NUM.match(text, i)
        if m:
            v, j = float(m.group(0)), m.end()
            if j < n and text[j] in SI:
                v, j = v * SI[text[j]], j + 1
            if j < n and (re.match(r"[A-Za-z0-9_.]", text[j]) or text[j] in "µμ"):
                raise ValueError(f"invalid number at {i}")
            toks.append(("num", v))
            i = j
        elif c == '"':
            k = text.index('"', i + 1)
            if k == i + 1:
                raise ValueError("empty quoted name")
            toks.append(("name", text[i + 1:k]))
            i = k + 1
        elif IDENT.match(text, i):
            name = IDENT.match(text, i).group(0)
            i += len(name)
            rest = text[i:].lstrip(" \t\r\n")
            if rest.startswith("("):
                if name not in FUNCS:
                    raise ValueError(f"unknown function {name}")
                toks.append(("call", name))
            else:
                toks.append(("name", name))
        elif text.startswith("**", i):
            toks.append(("op", "**"))
            i += 2
        elif c in "+-*/^(),":
            toks.append(("op", "**" if c == "^" else c))
            i += 1
        else:
            raise ValueError(f"unexpected character {c!r}")
    if not toks:
        raise ValueError("empty expression")
    return toks


def expr_names(text):
    """referenced names (no function names), first appearance first"""
    out = []
    for kind, v in tokenize(text):
        if kind == "name" and v not in out:
            out.append(v)
    return out


def translate(text):
    """-> (python source, {slot: name}, {slot: constant})"""
    parts, names, consts = [], {}, {}
    slot = {}
    for kind, v in tokenize(text):
        if kind == "num":
            k = f"_k{len(consts)}"
            consts[k] = v
            parts.append(k)
        elif kind == "name":
            if v not in slot:
                slot[v] = f"_v{len(slot)}"
                names[slot[v]] = v
            parts.append(slot[v])
        elif kind == "call":
            parts.append("_f_" + v)
        else:
            parts.append(v)
    return " ".join(parts), names, consts


def c99_pow(a, b):
    return np.power(a, b)                  # numpy follows C pow (1^NaN = 1, (-1)^inf = 1)


def _lin2db(x):
    x = np.asarray(x, dtype=np.float64)
    return np.where(x > 0, 10.0 * np.log10(np.where(x > 0, x, 1.0)), np.nan)


VALUE_FUNCS = {
    "_f_abs": np.abs, "_f_sqrt": np.sqrt, "_f_exp": np.exp, "_f_ln": np.log, "_f_log": np.log,
    "_f_log10": np.log10, "_f_floor": np.floor, "_f_ceil": np.ceil,
    "_f_round": lambda x: np.floor(x + np.float64(0.5)),
    "_f_db2lin": lambda x: np.power(np.float64(10.0), x / np.float64(10.0)),
    "_f_lin2db": _lin2db, "_f_pow": c99_pow,
    "_f_min": lambda *a: functools.reduce(np.minimum, a),     # NaN-propagating
    "_f_max": lambda *a: functools.reduce(np.maximum, a),
}


def name_values(env, name):
    """(values, dims) of a name: numeric var > dim index > pi"""
    if name in env:
        v = env[name]
        return v.scaled(), v.dims
    if name in env.dims:
        return np.arange(env.dims[name], dtype=np.float64), (name,)
    if name == "pi":
        return np.float64(np.pi), ()
    raise ValueError(f"unknown name {name}")


def eval_expr(env, text, dims, shape):
    """evaluate over (dims, shape); every name must have dims within `dims`"""
    src, names, consts = translate(text)
    ns = {"__builtins__": {}}
    ns.update(VALUE_FUNCS)
    for k, v in consts.items():
        ns[k] = np.float64(v)
    for slot, name in names.items():
        vals, vd = name_values(env, name)
        ns[slot] = np.ascontiguousarray(to_dims(vals, vd, dims, shape)) if vd else vals
    with np.errstate(all="ignore"), warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        r = eval(src, ns)                   # noqa: S307 -- our own translated tokens only
    return np.broadcast_to(np.asarray(r, dtype=np.float64), tuple(shape))


def js_num(v):
    """JS String(number) for the exponents that occur (2, -1, 0.5)"""
    if v == int(v) and abs(v) < 1e21:
        return str(int(v))
    return repr(v)


class U:
    """units of a sub-expression; lit = the value of a (signed) number literal"""
    def __init__(self, u="", lit=None):
        self.u = str(u or "").strip()
        self.lit = lit

    def __neg__(self):
        return U(self.u, -self.lit if self.lit is not None else None)

    def __pos__(self):
        return U(self.u)

    def __add__(self, o):
        a, b = self.u, o.u
        if not a:
            return U(b)
        if not b:
            return U(a)
        if is_db(a) and is_db(b):
            return U(b if a.lower() == "db" else a)
        return U(a)

    def __sub__(self, o):
        a, b = self.u, o.u
        if is_db(a) and is_db(b) and a.lower() == b.lower():
            return U("dB")
        if not b:
            return U(a)
        if not a:
            return U(b)
        return U(a)

    def __mul__(self, o):
        a, b = self.u, o.u
        return U(f"{a}·{b}" if a and b else (a or b))

    def __truediv__(self, o):
        a, b = self.u, o.u
        if a and a.lower() == b.lower():
            return U("")
        if a and b:
            return U(f"{a}/{b}")
        if a:
            return U(a)
        return U(f"1/{b}" if b else "")

    def __pow__(self, o):
        return U(f"{self.u}^{js_num(o.lit)}" if self.u and o.lit is not None else "")


def _first_units(*a):
    return U(next((x.u for x in a if x.u), ""))


def _lin2db_u(x):
    return U({"mw": "dBm", "w": "dBW"}.get(x.u.lower(), "dB"))


def _db2lin_u(x):
    n = x.u.lower()
    return U({"dbm": "mW", "dbw": "W", "db": ""}.get(n, f"lin({x.u})" if x.u else ""))


UNIT_FUNCS = {
    "_f_abs": _first_units, "_f_floor": _first_units, "_f_ceil": _first_units,
    "_f_round": _first_units, "_f_min": _first_units, "_f_max": _first_units,
    "_f_sqrt": lambda x: U(), "_f_exp": lambda x: U(), "_f_ln": lambda x: U(),
    "_f_log": lambda x: U(), "_f_log10": lambda x: U(),
    "_f_lin2db": _lin2db_u, "_f_db2lin": _db2lin_u, "_f_pow": lambda a, b: a ** b,
}


def expr_units(env, text):
    src, names, consts = translate(text)
    ns = {"__builtins__": {}}
    ns.update(UNIT_FUNCS)
    for k, v in consts.items():
        ns[k] = U("", v)
    for slot, name in names.items():
        ns[slot] = U(env[name].units if name in env else "")
    return eval(src, ns).u                 # noqa: S307


# ---- reduce -----------------------------------------------------------------
def to_db(r):
    with np.errstate(divide="ignore", invalid="ignore"):
        return np.where(r > 0, 10.0 * np.log10(np.where(r > 0, r, 1.0)), np.nan)


def needed_fields(w, region):
    inner = {"range": ["lo", "hi"], "center": ["center", "halfwidth"]}.get(w["mode"], [])
    outer = {"range": ["lo2", "hi2"], "center": ["halfwidth2"]}.get(w["mode"], [])
    return inner + (outer if region == "outside_within" else [])


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

    w, region = d["window"], d["region"]
    mode = w["mode"]
    inf = np.inf
    vals = {}
    for f in needed_fields(w, region):
        if not w[f].strip():
            raise ValueError(f"window {f} empty")
        vals[f] = eval_expr(env, w[f], rdims, rshape)
    with np.errstate(invalid="ignore", over="ignore"):
        if mode == "none":
            lo, hi, lo2, hi2 = -inf, inf, -inf, inf
            undef = np.zeros(rshape, dtype=bool)
        else:
            if mode == "range":
                lo, hi = np.minimum(vals["lo"], vals["hi"]), np.maximum(vals["lo"], vals["hi"])
            else:
                m, hw = vals["center"], np.abs(vals["halfwidth"])
                lo, hi = m - hw, m + hw
            ok = np.isfinite(lo) & np.isfinite(hi)
            if region == "outside_within":
                if mode == "range":
                    lo2, hi2 = np.minimum(vals["lo2"], vals["hi2"]), np.maximum(vals["lo2"], vals["hi2"])
                else:
                    hw2 = np.abs(vals["halfwidth2"])
                    lo2, hi2 = vals["center"] - hw2, vals["center"] + hw2
                ok = ok & np.isfinite(lo2) & np.isfinite(hi2)
            else:
                lo2, hi2 = np.full(rshape, -inf), np.full(rshape, inf)
            # a needed bound that is NaN/inf makes the window undefined: no member in any region
            undef = ~ok
            lo, hi = np.asarray(lo)[..., None], np.asarray(hi)[..., None]
            lo2, hi2 = np.asarray(lo2)[..., None], np.asarray(hi2)[..., None]

        in_in = (x >= lo) & (x <= hi)
        xok = ~np.isnan(x)
        if region == "inside":
            member = in_in
        elif region == "outside":
            member = ~in_in & xok
        else:
            member = ~in_in & xok & (x >= lo2) & (x <= hi2)
    member = member & ~undef[..., None]
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


# ---- formula / combine / transform ---------------------------------------------
def formula_def(env, d):
    text = d["expr"]
    dims, shape = [], []
    for name in expr_names(text):              # dims in order of first appearance
        _, vd = name_values(env, name)
        for dd in vd:
            size = env[name].size_of(dd) if name in env else env.dims[dd]
            if dd not in dims:
                dims.append(dd)
                shape.append(size)
            elif shape[dims.index(dd)] != size:
                raise ValueError(f"size mismatch on {dd}")
    r = eval_expr(env, text, dims, shape)
    return Arr(np.array(r, dtype=np.float64), dims, expr_units(env, text))


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
    names = lambda t: expr_names(t) if t.strip() else []
    if d["kind"] == "combine":
        return [d["a"]] + ([d["b"]] if isinstance(d["b"], str) else [])
    if d["kind"] == "transform":
        return [d["src"]]
    if d["kind"] == "formula":
        return names(d["expr"])
    out = [d["src"]]
    if d["xsrc"].startswith("var:"):
        out.append(d["xsrc"][4:])
    for f in needed_fields(d["window"], d["region"]):
        out += names(d["window"][f])
    return out


def load_env(path):
    ds = xr.open_dataset(path, decode_times=False, decode_timedelta=False)
    env = Env()
    env.dims = {k: int(v) for k, v in ds.sizes.items()}
    for name, v in ds.variables.items():
        if v.dtype.kind in "fiub":
            env[name] = Arr(v.values, v.dims, units_of(v))
    return env


def run_case(case):
    env = load_env(case["file"])
    pending = list(case["defs"])
    names = {d["name"] for d in pending}
    results = {}
    while pending:                                   # simple repeated-pass topo order
        progressed = False
        for d in list(pending):
            dd = [x for x in deps(d) if x in names]   # only other defs are edges
            if all(x in results for x in dd):
                pending.remove(d)
                progressed = True
                try:
                    if any("error" in results[x] for x in dd):
                        raise ValueError("dependency failed")
                    fn = {"reduce": reduce_def, "combine": combine_def,
                          "transform": transform_def, "formula": formula_def}[d["kind"]]
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
