"""make_bigsweep.py OUT.nc -- a small synthetic NetCDF-3 file whose sweep dim has
more than 200 entries (MAX_SWEEP_LINES), for tests/pyexport.test.mjs:

  sig(k=450, n=64)   float64, _FillValue -999 (a few samples are fill)
  k(k)               "days since 2000-01-01" (sweep coordinate: NOT time-scaled)
  n(n)               "milliseconds"          (x coordinate: scaled to seconds)
  tt(k, n)           "ns"                     (parallel x: scaled to seconds)
  amp(k)             "dBm"                    (sweep-value source)
"""
import sys

import numpy as np
from scipy.io import netcdf_file


def main(path):
    nk, nn = 450, 64
    k = np.arange(nk, dtype=float) * 0.5 + 100.0
    t = np.linspace(0.0, 6.3, nn)
    sig = np.sin(np.outer(np.linspace(1.0, 3.0, nk), t)) * np.linspace(1.0, 2.0, nk)[:, None]
    sig[3, 5] = -999.0
    sig[200, :4] = -999.0
    tt = (np.arange(nn, dtype=float)[None, :] * 1500.0) + np.arange(nk, dtype=float)[:, None] * 7.0
    amp = -40.0 + 0.05 * np.arange(nk, dtype=float)
    f = netcdf_file(path, "w", version=1)
    f.createDimension("k", nk)
    f.createDimension("n", nn)
    v = f.createVariable("k", "d", ("k",))
    v[:] = k
    v.units = "days since 2000-01-01"
    v = f.createVariable("n", "d", ("n",))
    v[:] = t
    v.units = "milliseconds"
    v = f.createVariable("tt", "d", ("k", "n"))
    v[:] = tt
    v.units = "ns"
    v = f.createVariable("amp", "d", ("k",))
    v[:] = amp
    v.units = "dBm"
    v = f.createVariable("sig", "d", ("k", "n"))
    v._FillValue = -999.0
    v[:] = sig
    v.units = "V"
    f.close()


if __name__ == "__main__":
    main(sys.argv[1])
