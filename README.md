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
  waterfall**. The **colorbar** can be captioned and mapped to the variable of
  your choice — the sweep coordinate, the index, or *any parallel array sharing
  the sweep dimension* (just like the X axis), so a family of traces is colored
  by the real parameter value instead of a bare index — with **SI unit scaling**
  (MHz/GHz/…) on the colorbar too.
- **Derived quantities** (ƒ): turn a stack of spectra into processed curves —
  e.g. the **peak power** in a window around the stimulus frequency, the **noise
  floor** outside it, and **SNR = peak − floor**, each vs the remaining
  dimensions — without writing a script. See [Derived quantities](#derived-quantities).
- **Tabs — many plots, one project**: each tab is its own independently-formatted
  plot (its own traces, cosmetics, markers, sliders), while the **datasets on the
  left are shared** across all tabs. Add (`＋`), rename (double-click), close, and
  right-click a tab to **Duplicate** it, move it, or **Duplicate for another
  file** (the same plots reading the next measurement, derived recipes included).
- **Cosmetics** you can edit before export: title, axis labels, per-trace legend
  labels, **per-trace color**, **line / markers / both**, **line width** and
  **dash style**, per-line **sweep-label templates** (`T = {v} K`), legend
  location, grid, log axes, colormap, optional **axis limits** (X/Y min/max, per
  tab — set one side to fix just that end), and **SI unit scaling**
  (k/M/G/T/m/µ/n/p) on both axes (labels and CSV follow).
- **Markers** that attach to trace data points and **follow the sliders** —
  left-click to add, right-click to delete.
- **Fixed plot size** (lock to N inches) so exported text is the same size no
  matter how big the browser window is.
- **Export** the figure as **PNG / SVG / vector PDF**, or the plotted data as
  **CSV**.
- **Reports**: one **multi-page vector PDF** of several tabs (made in the
  browser), or a **Python script** that regenerates them — derived quantities and
  cosmetics included — as a multi-page vector PDF with matplotlib. See
  [Reports](#reports).
- **Projects** (`.ncproj`, plain JSON): save the whole visualization — **every
  tab**, its traces, slicing, cosmetics, per-trace styles, markers, plot size,
  and every **derived quantity** — and reload it later (drag the `.ncproj` back
  in). Data files are referenced by name; re-open them alongside (until you do,
  the project keeps the traces that need them and a banner lists the missing
  files). **Save ▾ → Save self-contained** bundles the file bytes into the project
  so it is a single **shareable file** (larger).
- **Never lose work**: the session (open files + all tabs) is **auto-saved in your
  browser**, so an accidental tab close restores on the next visit. **Undo / redo**
  (Ctrl+Z / Ctrl+Y) covers every edit. **New project** clears everything.
- **Friendly UI**: a toolbar for the main actions, drag-and-drop anywhere, a
  getting-started card on an empty plot, notifications for important messages,
  a searchable variable tree with right-click actions, drag-to-reorder traces with
  color swatches, and keyboard shortcuts (press **?** in the app for the list).

Recognized lab formats (`DHO924S_snapshots_v1`, `VNA_OSA_sidebands_v1`) get
sensible default traces on open.

## Use it

Just open `docs/index.html`. On GitHub Pages, browse to your Pages URL. There's
a small synthetic `docs/sample/demo.nc` to try immediately (**Try the sample** on
the start card): `signal` along `time`, one line per `temperature`; scrub the
`frequency` slider.

### Keyboard shortcuts

| keys | action |
|---|---|
| Ctrl/Cmd + O | open .nc files |
| Ctrl/Cmd + S · + Shift | save project · save self-contained (embeds data) |
| Ctrl/Cmd + Z · Ctrl + Y (or Ctrl + Shift + Z) | undo · redo |
| Delete | remove the selected trace |
| Ctrl/Cmd + D | duplicate the selected trace |
| M | toggle marker mode |
| ? | help |

## Derived quantities

A typical lab dataset is a stack of spectra: e.g. `spectrums(TraceIndex,
stimulusFrequency, stimulusAmp, trace)` with a per-spectrum frequency axis
`frequencies(TraceIndex, stimulusFrequency, stimulusAmp)`. **ƒ Derived…** (toolbar,
a file's ƒ button, or right-click a variable → *Derive from this variable*)
opens the builder:

- **Window statistic** — collapse one dimension (*Reduce along*, e.g. the
  frequency bins) into one number per remaining index:
  - **X values**: the index, the dimension's coordinate, or any variable sharing
    the dimensions (window membership is evaluated on *each spectrum's own* x
    values, so per-spectrum frequency arrays work).
  - **Window**: the whole span, a **fixed** x range, or **relative** to a
    coordinate/variable that shares the remaining dimensions — `k × center +
    offset ± half width` (e.g. `stimulusFrequency ± 1 MHz`, or harmonic `k = 2`).
    Drag across the preview spectrum to set it; drag the shaded band or its edges
    to adjust it. Inputs accept SI suffixes (`5k`, `1.5M`).
  - **Use points** inside the window, outside it, or outside it but within a
    wider span.
  - **Statistic**: peak (max), minimum, mean, median, std, sum, integral
    (trapezoid; never bridges an excluded gap), count, x at peak, x at minimum.
  - **dB data** (units containing “dB”, e.g. `dBm`, `DBM`; overridable): mean,
    median, std, sum and integral are computed in **linear power**
    (10^(x/10)) and converted back to dB — averaging in dB would bias Gaussian
    noise low by ≈ 2.5 dB. Max/min/argmax are unaffected. NaN samples are
    ignored; an empty window (or a NaN window center) gives NaN.
- **Combine** `a ∘ b` (− + × ÷ max min), matching dimensions **by name** (so
  `spectrum − its own peak` broadcasts), with b a variable or a number.
- **Transform**: dB → linear, linear → dB, `a·x + b`, `|x|`.
- **Presets**: *Peak in window*, *Noise floor outside*, and *Peak + floor + SNR*
  (creates the three chained quantities at once).

A derived quantity is a virtual variable of its file (listed in the tree under
**ƒ derived quantities**), so it plots like any variable — as a trace, an X
source, or a sweep (colorbar) source — and can feed other derived quantities.
The builder shows the source spectrum with the window and the points used, plus
the result vs any remaining dimension, live. **Save & plot** adds the trace(s).
Definitions are saved in the project and recomputed on load. To reuse a recipe on
another measurement: right-click it → **Copy recipe to** another open file (the
recipe and the quantities it depends on are copied if the file has the same
structure), **Export recipe…** / file menu → **Import recipe…** (JSON), or
right-click a tab → **Duplicate for another file**.

## Reports

**Report ▾** in the toolbar:

- **PDF report of tabs…** — one vector PDF, a page per selected tab, each at its
  locked size (or the current plot size). Made in the browser.
- **Python script → PDF report…** — downloads `ncx_report_<stamp>.py`, a
  standalone, commented script that rebuilds the selected tabs — slicing,
  derived quantities (same semantics, incl. linear-power dB statistics), sweeps,
  colormaps/colorbars, right axis, markers, limits, SI scaling, log axes, line
  styles — as a **multi-page vector PDF** (matplotlib `PdfPages`, one page per
  tab). Edit it as a starting point for custom processing.

  ```bash
  python ncx_report_<stamp>.py --data-dir path/to/the/nc/files   # writes the PDF next to the script
  python ncx_report_<stamp>.py --out report.pdf --png             # also one PNG per page
  ```

  Requires `numpy`, `xarray`, `matplotlib`, plus `scipy` (NetCDF-3) and
  `h5netcdf` or `netCDF4` (NetCDF-4/HDF5). By default it looks for the data files
  next to itself; edit the `FILES` map at the top to point elsewhere. Pages whose
  data file is missing are skipped with a warning.

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
| `docs/js/derive.js`  | derived quantities: the pure compute engine (window statistics, combine, transform), validation, units |
| `docs/js/colormaps.js` | colormaps shared by rainbow lines and the colorbar |
| `docs/js/app.js`     | UI state, tree/traces/editor, Plotly rendering, markers, exports, projects, undo/redo |
| `docs/js/builder.js` | the derived-quantity dialog (form + live previews) |
| `docs/js/report.js`  | the report dialogs (multi-page PDF, Python script) |
| `docs/js/pyexport.js` | generates the standalone Python report script |
| `docs/js/ui.js`      | small UI primitives: icons, toasts, menus, modal dialogs |
| `docs/js/project.js` | `.ncproj` save/load (canonical, sanitized) |
| `docs/vendor/`       | Plotly, h5wasm, jsPDF, svg2pdf (vendored) |

**Project format.** `nc_explorer_project_v2` (plain JSON): `files`, `active`,
`tabs[]` (`name`, `plot` = cosmetics, `traces[]`, `markers[]`, `selected`),
`derived[]` (derived-quantity definitions, project-level like the datasets),
optional `embedded` (base64 file bytes), plus the active tab mirrored at top level
for v1/desktop readers. New fields are additive, so older versions still open the
plots they understand; v1 and desktop projects load as one tab. Serialization is
canonical: save → load → save is byte-identical apart from `created`. Derived
quantities are mirrored by the Python report script — a change to `derive.js`
semantics must be made in `pyexport.js` too (the tests cross-check them).

`NC_Explorer_desktop.py` is the original PyQt5 desktop version this web app was
ported from — kept for reference and feature parity.

`tests/smoke.html` is a browser smoke test. It fetches `.nc` files from
`tests/data/` (git-ignored — drop your own there) and asserts the readers,
slicing, derived quantities and project round trip behave. Serve the folder
(`python -m http.server` from `nc-explorer/`) and open
`http://localhost:8000/tests/smoke.html`.

Node tests (Node 18+; HDF5 files open through the vendored h5wasm). Set
`NCX_PYTHON` to a Python with numpy/xarray/matplotlib/scipy/h5netcdf/pypdf to run
the cross-checks against independent numpy implementations (skipped otherwise):

```bash
node tests/derive.test.mjs      # derived-quantity engine (+ numpy cross-check)
node tests/project.test.mjs     # .ncproj round trips, real lab projects, hostile input
node tests/pyexport.test.mjs    # generated Python report: runs it, checks the PDF + numbers
```
