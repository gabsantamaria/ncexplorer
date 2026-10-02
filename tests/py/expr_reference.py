"""expr_reference.py DATA_DIR OUT.json -- an independent, hand-written numpy
computation of the expression-window and formula quantities of case
I_darpa_expressions in tests/pyexport.test.mjs (darpa.nc): every window and
formula is spelled out in plain numpy below (no expression parser), so the
report script's --dump-derived can be checked against it.
Output: {name: {"dims": [...], "shape": [...], "data": [...] (NaN -> null)}}."""
import json
import math
import os
import sys

import numpy as np
import xarray as xr

NAN = float("nan")


def stat(kind, x, y, m):
    """Statistic of y[m] (dB data: mean/median on linear power)."""
    if kind == "count":
        return float(np.count_nonzero(m))
    if not m.any():
        return NAN
    if kind == "max":
        return float(y[m].max())
    if kind == "argmax_x":
        k = np.flatnonzero(m)
        return float(x[k[np.argmax(y[k])]])
    lin = 10.0 ** (y[m] / 10.0)
    r = float(lin.mean()) if kind == "mean" else float(np.median(lin))
    return 10.0 * math.log10(r) if r > 0 else NAN


def main(data_dir, out_path):
    ds = xr.open_dataset(os.path.join(data_dir, "darpa.nc"), decode_times=False)
    S = ds["spectrums"].values.astype(float)          # (TraceIndex, stimulusFrequency, stimulusAmp, trace)
    X = ds["frequencies"].values.astype(float)        # (TraceIndex, stimulusFrequency, stimulusAmp)
    sf = ds["stimulusFrequency"].values.astype(float)
    sa = ds["stimulusAmp"].values.astype(float)
    rbw = ds["ResolutionBWs"].values.astype(float)    # (stimulusFrequency, stimulusAmp)
    trace = ds["trace"].values.astype(float)
    nF, nA, nT = S.shape[1], S.shape[2], S.shape[3]
    res_dims = ["stimulusFrequency", "stimulusAmp", "trace"]

    def reduce(window, region, kind):
        """window(i, j, t) -> (lo, hi, lo2, hi2); lo2/hi2 None when not used. A
        non-finite needed bound -> the window is undefined (NaN; count 0)."""
        out = np.full((nF, nA, nT), NAN)
        for i in range(nF):
            for j in range(nA):
                for t in range(nT):
                    x, y = X[:, i, j], S[:, i, j, t]
                    lo, hi, lo2, hi2 = window(i, j, t)
                    needed = [lo, hi] + ([lo2, hi2] if region == "outside_within" else [])
                    if not all(math.isfinite(b) for b in needed):
                        out[i, j, t] = 0.0 if kind == "count" else NAN
                        continue
                    with np.errstate(invalid="ignore"):
                        inside = (x >= lo) & (x <= hi)
                        if region == "inside":
                            m = inside
                        elif region == "outside":
                            m = ~inside & ~np.isnan(x)
                        else:
                            m = ~inside & (x >= lo2) & (x <= hi2)
                    out[i, j, t] = stat(kind, x, y, m & np.isfinite(y))
        return out

    def around(c, hw, hw2=None):
        hw = abs(hw)
        if hw2 is None:
            return (c - hw, c + hw, None, None)
        return (c - hw, c + hw, c - abs(hw2), c + abs(hw2))

    def sqrt_or_nan(v):
        return math.sqrt(v) if v >= 0 else NAN

    def ln_or_nan(v):
        return math.log(v) if v > 0 else (-math.inf if v == 0 else NAN)

    r = {}
    # center stimulusFrequency, half width 0.01*stimulusFrequency
    r["pk_rel"] = reduce(lambda i, j, t: around(sf[i], 0.01 * sf[i]), "inside", "max")
    # center stimulusFrequency, half width 3*ResolutionBWs (the RBW used at that stimulus)
    r["fl_rbw"] = reduce(lambda i, j, t: around(sf[i], 3 * rbw[i, j]), "outside", "mean")
    # range stimulusFrequency*0.9 .. stimulusFrequency*1.1 (and reversed)
    r["pk_rng"] = reduce(lambda i, j, t: (sf[i] * 0.9, sf[i] * 1.1, None, None), "inside", "max")
    r["pk_f"] = reduce(lambda i, j, t: (sf[i] * 0.9, sf[i] * 1.1, None, None), "inside", "argmax_x")
    r["fl_ow"] = reduce(lambda i, j, t: around(sf[i], 3 * rbw[i, j], 0.25 * sf[i]), "outside_within", "median")
    r["cnt_si"] = reduce(lambda i, j, t: (29.5 * 1e6, 30500 * 1e3, None, None), "inside", "count")
    r["pk dBm"] = reduce(lambda i, j, t: around(2 * sf[i] - sf[i], 1e6), "inside", "max")
    # 0*sqrt(stimulusAmp - 0.01) is NaN where stimulusAmp < 0.01: undefined window there
    nan_hw = lambda i, j, t: around(sf[i], 0.01 * sf[i] + 0 * sqrt_or_nan(sa[j] - 0.01))   # noqa: E731
    r["pk_nan"] = reduce(nan_hw, "inside", "max")
    r["cnt_nan"] = reduce(nan_hw, "inside", "count")
    r["fl_nanouter"] = reduce(lambda i, j, t: around(sf[i], 1 * 1e6, ln_or_nan(sa[j] * 100 - 1) * (10 * 1e6)),
                              "outside_within", "mean")
    r["pk_trace"] = reduce(lambda i, j, t: around(sf[i] + trace[t] * 0, 250 * 1e3), "inside", "max")
    # formulas
    with np.errstate(all="ignore"):
        r["snr"] = r["pk_rel"] - r["fl_rbw"]
        r["density"] = r["fl_rbw"] - 10 * np.log10(rbw)[:, :, None]
        r["q_snr"] = r["pk dBm"] - r["fl_rbw"]
    out = {}
    for name, a in r.items():
        out[name] = {"dims": res_dims, "shape": list(a.shape), "data": a.ravel().tolist()}
    dimorder = trace[:, None, None] + rbw[None, :, :]
    out["dimorder"] = {"dims": ["trace", "stimulusFrequency", "stimulusAmp"], "shape": list(dimorder.shape),
                       "data": dimorder.ravel().tolist()}
    si = 2e3 * 1e3 + 5 * 1e-3 + 1 * 1e-6 + 1 * 1e-6 + 3 * 1e3 + 4 * 1e9 + 2 * 1e12 + 7 * 1e-12 + 9 * 1e-9 + 3 * 1e-6 + .5
    for name, v in (("twopi", 2 * math.pi), ("pw", 1024.0 + 512.0 + 4.0 + 0.5), ("si", si)):
        out[name] = {"dims": [], "shape": [], "data": [v]}
    for e in out.values():
        e["data"] = [v if math.isfinite(v) else None for v in e["data"]]
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(out, fh)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
