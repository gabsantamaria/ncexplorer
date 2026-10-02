"""probe_helpers.py SCRIPT.py REQUEST.json OUT.json

Loads a generated report script as a module (main() does not run) and evaluates
its helper functions on the inputs in REQUEST.json, so tests/pyexport.test.mjs
can compare them with the web app's JavaScript (fmt6, colormap colors, SI
labels, legend labels, axis limits) and check that CONFIG round-trips every
string exactly. Non-finite numbers travel as the strings "NaN", "Infinity",
"-Infinity"."""
import json
import math
import runpy
import sys


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
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(enc(out), fh, ensure_ascii=True)


if __name__ == "__main__":
    main(*sys.argv[1:4])
