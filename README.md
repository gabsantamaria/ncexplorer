# NC Explorer (web)

A generic **NetCDF (`.nc`) plotter and explorer** that runs entirely in the
browser — no install, no server, no upload. Open it as a web page, drag in your
`.nc` files, and explore. Built for lab use so everyone can view instrument data
from any machine via a shared link.

Your data never leaves your computer: files are read **client-side** in the
browser. Nothing is sent anywhere.

## What it does

- **Reads both NetCDF formats**: classic **NetCDF-3** (CDF-1/2/5, the scipy
  engine output) and **NetCDF-4 / HDF5** (dimension scales + `_Netcdf4Coordinates`
  are decoded so variables get their real dimension names). Verified against the
  lab's own files of both kinds.
- **Multidimensional exploration**: each *trace* is a variable plotted along a
  chosen dimension, with an optional **sweep** dimension (a whole family of
  lines) and a **slider** for every remaining dimension to scrub live.
- **Flexible X axis**: index, the dimension's coordinate, or *any other variable
  sharing the dimensions* (e.g. a 2-D wavelength/time axis).
- **Combine traces** from any number of files on one plot: **2D lines**,
  **Rainbow** (a sweep family colored by a colormap + colorbar), or **3D
  waterfall**.
- **Tabs — many plots, one project**: each tab is its own independently-formatted
  plot (its own traces, cosmetics, markers, sliders), while the **datasets on the
  left are shared** across all tabs. Add (`＋`), rename (double-click), close, and
  **right-click a tab → Duplicate** to fork a formatted plot and tweak the copy.
- **Cosmetics** you can edit before export: title, axis labels, per-trace legend
  labels, **per-trace color**, per-line **sweep-label templates** (`T = {v} K`),
  legend location, grid, log axes, colormap, optional **axis limits** (X/Y
  min/max, per tab — set one side to fix just that end), and **SI unit scaling**
  (k/M/G/T/m/µ/n/p) on both axes (labels and CSV follow).
- **Markers** that attach to trace data points and **follow the sliders** —
  left-click to add, right-click to delete.
- **Fixed plot size** (lock to N inches) so exported text is the same size no
  matter how big the browser window is.
- **Export** the figure as **PNG / SVG / vector PDF**, or the plotted data as
  **CSV**.
- **Projects** (`.ncproj`, plain JSON): save the whole visualization — **every
  tab**, its traces, slicing, cosmetics, per-trace colors, markers, and plot size
  — and reload it later (drag the `.ncproj` back in). Data files are referenced by
  name; re-open them alongside. Tick **“Embed .nc data”** to bundle the file bytes
  into the project so it is a single **self-contained, shareable file** (larger).
- **Never lose work**: the session (open files + all tabs) is **auto-saved in your
  browser**, so an accidental tab close restores on the next visit. **New project**
  clears everything.

Recognized lab formats (`DHO924S_snapshots_v1`, `VNA_OSA_sidebands_v1`) get
sensible default traces on open.

## Use it

Just open `docs/index.html`. On GitHub Pages, browse to your Pages URL. There's
a small synthetic `docs/sample/demo.nc` to try immediately (Open → sample →
demo.nc): plot `signal` along `time`, sweep over `temperature`, and scrub the
`frequency` slider.

## Deploy to GitHub Pages

The app is a static site in `docs/` — Pages serves it with no build step.

1. Create a repo on GitHub (e.g. `nc-explorer`) and push this folder:
   ```bash
   git remote add origin https://github.com/<you>/nc-explorer.git
   git push -u origin main
   ```
2. On GitHub: **Settings → Pages → Build and deployment → Source: GitHub
   Actions.** The included workflow (`.github/workflows/deploy.yml`) publishes
   `docs/` on every push to `main`. (Alternatively, choose **Deploy from a
   branch → `main` / `/docs`** and delete the workflow — either works.)
3. After a minute the app is live at
   `https://<you>.github.io/nc-explorer/`. Share that link with the lab.

If a deploy fails with **"Deployment failed, try again later"**, that step is
usually transient — **re-run the failed job** (Actions tab → the run → *Re-run
failed jobs*) and it typically succeeds. The workflow's `concurrency` guard
prevents overlapping deploys, which is the most common durable cause. Use only
ONE Pages workflow; a second one that also deploys will race this one.

Everything the app needs (Plotly, the HDF5 reader, the PDF exporter) is vendored
under `docs/vendor/`, so the site is self-contained and works offline once
loaded — no CDN, no external requests.

### Updates propagate automatically (service worker)

A small **service worker** (`docs/sw.js`) makes updates appear on their own — no
cache-clearing needed. The app code (HTML/JS/CSS) is fetched **network-first**,
so an online browser always gets the latest version on the next reload; the
large vendored libraries are served from cache (fast) and refreshed in the
background. As a bonus, the app also works **offline** after the first visit.

So after you push a change to Pages, users get it on their next reload. Two
caveats:

- The **very first** load after this service worker was added needs one manual
  refresh (existing tabs are still on the pre-service-worker cache). After that
  it's automatic.
- If a tab was already open when you pushed, reload it to pick up the change. A
  **hard refresh** (Ctrl/Cmd + Shift + R) forces it instantly, and a
  private/incognito window always loads the latest — handy to confirm a deploy.

To turn the service worker off, follow the note at the top of `docs/sw.js`.

## How it's built (for maintainers)

Pure browser JavaScript, ES modules, zero build step:

| file | role |
|---|---|
| `docs/js/netcdf3.js` | self-contained NetCDF classic reader (validated byte-exact vs xarray) |
| `docs/js/hdf5.js`    | NetCDF-4/HDF5 via h5wasm (complete WebAssembly HDF5 reader) + the netCDF-4 convention decoder |
| `docs/js/dataset.js` | unified dataset object + C-order slicing (validated vs numpy) |
| `docs/js/explore.js` | trace/slice/scale logic, ported from the desktop `NC_Explorer.py` |
| `docs/js/colormaps.js` | colormaps shared by rainbow lines and the colorbar |
| `docs/js/app.js`     | UI, Plotly rendering, markers, exports, projects |
| `docs/js/project.js` | `.ncproj` save/load |
| `docs/vendor/`       | Plotly, h5wasm, jsPDF, svg2pdf (vendored) |

`NC_Explorer_desktop.py` is the original PyQt5 desktop version this web app was
ported from — kept for reference and feature parity.

`tests/smoke.html` is a browser smoke test. It fetches `.nc` files from
`tests/data/` (git-ignored — drop your own there) and asserts the readers and
slicing behave. Serve the folder (`python -m http.server` from `nc-explorer/`)
and open `http://localhost:8000/tests/smoke.html`.
