"""probe_helpers.py SCRIPT.py REQUEST.json OUT.json

Loads a generated report script as a module (main() does not run) and evaluates
its helper functions on the inputs in REQUEST.json, so tests/pyexport.test.mjs
can compare them with the web app's JavaScript (fmt6, colormap colors, SI
labels, legend labels, axis limits) and check that CONFIG round-trips every
string exactly. Non-finite numbers travel as the strings "NaN", "Infinity",
"-Infinity".

Optional request keys (expression engine, SPEC_EXPR):
  exprs    [text, ...]  -> parsed + computed as a formula over a small fake file
                           (see FakeFile): {dims, data, units, funits (a formula
                           def's automatic units), names, refs} or {error, pos}
  migrate  [window, ...] -> migrate_window(window)
  js_str   [number, ...] -> js_str(number)"""
import json
import math
import re
import runpy
import sys

import numpy as np


def num(v):
    return float(v) if isinstance(v, str) else v


def enc(v):
    if isinstance(v, float) and not math.isfinite(v):
        return "NaN" if math.isnan(v) else ("Infinity" if v > 0 else "-Infinity")
    if isinstance(v, (list, tuple)):
        return [enc(x) for x in v]
    if isinstance(v, dict):
        return dict((k, enc(x)) for k, x in v.items())
    return v


class FakeFile(object):
    """Stands in for the script's DataFile: scalars a = 2 V, b = 3 V, c = NaN;
    v(d) = [1, 2, 3] dBm, w(e) = [10, 20] dBm, t(d) = [1, 2, 3] ns; dims d (3),
    e (2, no variable), s (4, only a NON-numeric variable s), h (2, only a numeric
    variable h(d, h) that is NOT its coordinate); str(d) non-numeric."""

    def __init__(self, Var):
        self.name = "fake.nc"
        self.sizes = {"d": 3, "e": 2, "s": 4, "h": 2}
        nan = float("nan")
        self._vars = dict((v.name, v) for v in (
            Var("a", (), np.array(2.0), "V"), Var("b", (), np.array(3.0), "V"),
            Var("c", (), np.array(nan), ""), Var("v", ("d",), np.array([1.0, 2.0, 3.0]), "dBm"),
            Var("w", ("e",), np.array([10.0, 20.0]), "dBm"), Var("t", ("d",), np.array([1.0, 2.0, 3.0]), "ns"),
            Var("s", ("s",), None, "", numeric=False), Var("str", ("d",), None, "", numeric=False),
            Var("h", ("d", "h"), np.arange(6.0).reshape(3, 2) + 5, "V")))

    def var(self, name):
        return self._vars.get(name)

    def size(self, dim):
        return self.sizes.get(dim, 0)


def probe_expr(ns, fake, text):
    try:
        node = ns["parse_expr"](text)
        dims, data = ns["compute_formula"](fake, {"expr": text})
        return {"dims": list(dims), "data": enc([float(x) for x in np.ravel(data)]),
                "units": ns["expr_units"](node, lambda n: ns["name_units"](fake, n)),
                "funits": ns["auto_units"](fake, {"kind": "formula", "expr": text}),
                "names": ns["expr_names"](node), "refs": ns["expr_refs"](text)}
    except ns["ExprError"] as e:
        return {"error": str(e), "pos": e.pos}
    except ns["DeriveError"] as e:
        m = re.search(r" at position (\d+)", str(e))
        return {"error": str(e), "pos": int(m.group(1)) if m else -1}


def main(script, req_path, out_path):
    ns = runpy.run_path(script, run_name="ncx_probe")
    with open(req_path, encoding="utf-8") as fh:
        req = json.load(fh)
    out = {
        "fmt6": [ns["fmt6"](num(x)) for x in req["fmt6"]],
        "cmap": dict((name, [[round(c * 255) for c in ns["cmap_color"](name, num(t))] for t in req["ts"]])
                     for name in req["cmaps"]),
        "scaled": [ns["scaled_label"](b, p) for b, p in req["scaled"]],
        "line_label": [ns["line_label"](t, sw, None if sv is None else num(sv), j)
                       for t, sw, sv, j in req["line_label"]],
        "axis_range": [ns["axis_range"](a, b, num(c), num(d), e) for a, b, c, d, e in req["axis_range"]],
        "time_scale": [ns["time_scale"](u) for u in req["time_scale"]],
        "config": ns["CONFIG"],
        "files": ns["FILES"],
    }
    if "exprs" in req:
        fake = FakeFile(ns["Var"])
        out["exprs"] = [probe_expr(ns, fake, t) for t in req["exprs"]]
    if "migrate" in req:
        out["migrate"] = [ns["migrate_window"](w) for w in req["migrate"]]
    if "js_str" in req:
        out["js_str"] = [ns["js_str"](num(x)) for x in req["js_str"]]
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(enc(out), fh, ensure_ascii=True)


if __name__ == "__main__":
    main(*sys.argv[1:4])
