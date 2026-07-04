"""
NC_Explorer.py -- a generic NetCDF (.nc) plotter / explorer for lab data.

Open any number of .nc files and browse their variables. Build a plot from
"traces": each trace is one variable, a chosen dimension to plot along, an
optional SWEEP dimension (drawing a whole family of lines), and sliders for
every remaining dimension so multidimensional data can be scrubbed live.
X values can come from the dimension index, the dimension's coordinate, or
ANY other variable that shares the trace's dimensions (so e.g. spectra_dbm
can be plotted against the 2-D wl_nm variable, or scope volts against the
per-channel time_s).

Plot modes:
  * 2D lines      -- every trace/line on one axes (legend).
  * Rainbow       -- sweep families colored by a colormap + colorbar.
  * 3D waterfall  -- lines stacked along the sweep value.

Cosmetics (title, axis labels, per-trace legend labels, legend location,
grid, log axes, colormap) are editable before export. Export the figure as
PNG / vector PDF / SVG, or the plotted data as CSV.

The whole visualization is savable as a PROJECT (.ncproj, plain JSON): the
file list, every trace with its slicing, and all cosmetic edits -- reload it
later and continue where you left off (files are referenced by path).

Files written by the instrument GUIs in this folder are recognized by their
`format` attribute and get sensible default traces on open (snapshot stacks:
volts vs time_s swept over channels with a snapshot slider; sideband runs:
each OSA spectrum vs wavelength with an RF-frequency slider).

Run:  & 'C:\\ProgramData\\anaconda3\\python.exe' NC_Explorer.py [file.nc ...]
"""

import json
import os
import sys
import time
import numpy as np

try:
    from PyQt5 import QtCore, QtWidgets
except ModuleNotFoundError:
    sys.exit(
        "\nThis app needs PyQt5. Run it with the base Anaconda Python:\n"
        "    & 'C:\\ProgramData\\anaconda3\\python.exe' NC_Explorer.py\n")
from matplotlib.backends.backend_qt5agg import FigureCanvasQTAgg as FigureCanvas
from matplotlib.backends.backend_qt5agg import NavigationToolbar2QT as NavBar
from matplotlib.figure import Figure
from matplotlib import cm
from matplotlib.colors import Normalize
import matplotlib.cm as _cm
try:                                       # get_cmap is deprecated/removed in
    from matplotlib import colormaps as _colormaps   # newer matplotlib
except ImportError:
    _colormaps = None
from mpl_toolkits.mplot3d import Axes3D  # noqa: F401  (registers 3d projection)

CMAPS = ["viridis", "plasma", "inferno", "turbo", "coolwarm", "rainbow"]
LEGEND_LOCS = ["best", "upper right", "upper left", "lower right", "lower left"]
MAX_SWEEP_LINES = 200          # cap runaway sweep families; noted in the status bar
PROJECT_FORMAT = "nc_explorer_project_v1"
DEFAULT_PLOTCFG = {"mode": "2D lines", "title": "", "xlabel": "",
                   "ylabel": "", "zlabel": "", "legend": True,
                   "legend_loc": "best", "grid": True, "logx": False,
                   "logy": False, "cmap": "viridis",
                   "xunit": "", "yunit": "",
                   "lock_size": False, "figw": 7.6, "figh": 6.4}
UNIT_PREFIXES = ["—", "k", "M", "G", "T", "m", "µ", "n", "p"]
PREFIX_FACTOR = {"": 1.0, "k": 1e3, "M": 1e6, "G": 1e9, "T": 1e12,
                 "m": 1e-3, "µ": 1e-6, "n": 1e-9, "p": 1e-12}
MARKER_PICK_PX = 30            # click-to-data pixel radius


def _scaled_label(base, prefix):
    """'freq_Hz (Hz)' + 'G' -> 'freq_Hz (GHz)'; unitless gets '(×1e9)'."""
    if not prefix:
        return base
    factor = PREFIX_FACTOR[prefix]
    exp = int(round(np.log10(factor)))
    if base.endswith(")") and "(" in base:
        name, unit = base.rsplit("(", 1)
        return f"{name}({prefix}{unit}"
    return f"{base} (×1e{exp})" if base else f"×1e{exp}"


def _get_cmap(name):
    if _colormaps is not None:
        try:
            return _colormaps[name]
        except KeyError:
            return _colormaps["viridis"]
    return _cm.get_cmap(name)


def _canon(p):
    """Canonical path identity (case-insensitive FS on Windows)."""
    return os.path.normcase(os.path.abspath(p))


def _as_float(a):
    """Array -> float, converting datetimes/timedeltas to SECONDS instead of
    numpy's raw nanoseconds (a silent 1e9 scale error otherwise)."""
    a = np.asarray(a)
    if np.issubdtype(a.dtype, np.datetime64):
        a = a.astype("datetime64[ns]")
        ref = a.ravel()[0] if a.size else np.datetime64(0, "ns")
        return (a - ref) / np.timedelta64(1, "s")
    if np.issubdtype(a.dtype, np.timedelta64):
        return a.astype("timedelta64[ns]").astype(np.int64) / 1e9
    return np.asarray(a, dtype=float)

STYLESHEET = """
QWidget { font-family: 'Segoe UI', Arial; font-size: 10pt; color: #1f2733; }
QMainWindow { background: #eef1f5; }
QGroupBox {
    background: #ffffff; border: 1px solid #d4dae3; border-radius: 8px;
    margin-top: 14px; padding: 8px;
}
QGroupBox::title { subcontrol-origin: margin; left: 12px; padding: 0 5px;
                   color: #1565c0; font-weight: 700; }
QPushButton { background: #1565c0; color: white; border: none; border-radius: 5px;
              padding: 5px 10px; font-weight: 600; }
QPushButton:hover { background: #1976d2; }
QPushButton:disabled { background: #b9c2cf; color: #eef1f5; }
QPushButton[flavor="ghost"] { background: #e6ecf5; color: #1565c0; }
QPushButton[flavor="warn"] { background: #c0392b; }
QLineEdit, QComboBox, QSpinBox, QDoubleSpinBox {
    background: #f7f9fc; border: 1px solid #cfd6e0; border-radius: 4px; padding: 3px 6px; }
QTreeWidget, QListWidget, QPlainTextEdit {
    background: #ffffff; border: 1px solid #cfd6e0; border-radius: 4px; }
QStatusBar { background: #25303f; color: #e6ecf5; }
"""


def _is_numeric(da):
    return (np.issubdtype(da.dtype, np.number)
            or np.issubdtype(da.dtype, np.bool_))


def _x_ok(da):
    """Usable as an x source: numeric, or datetime/timedelta (converted to
    seconds by _as_float). String/byte label coords are NOT (crash the cast)."""
    return (_is_numeric(da) or np.issubdtype(da.dtype, np.datetime64)
            or np.issubdtype(da.dtype, np.timedelta64))


def _dim_axis_candidates(ds, dim):
    """1-D variables/coords that span exactly `dim` — the natural axis for it
    even when named differently (e.g. coordinate freq_Hz on dim freq)."""
    dim = str(dim)
    out = []
    for name, v in ds.variables.items():
        name = str(name)
        if (name != dim and [str(d) for d in v.dims] == [dim] and _x_ok(v)):
            out.append(name)
    return out


def _dec(x):
    if isinstance(x, bytes):
        return x.decode("utf-8", "replace")
    return str(x)


def open_nc(path):
    """xarray open with STAGED decode fallbacks. Returns (ds, warn_suffix).
    decode_timedelta=False keeps 'units: seconds' variables as plain numbers
    (decoded timedelta64 would silently plot as nanoseconds); the raw
    decode_cf=False last resort is clearly flagged (packed/unmasked values)."""
    import xarray as xr
    try:
        return xr.open_dataset(path, decode_timedelta=False), ""
    except TypeError:            # very old xarray without decode_timedelta
        return xr.open_dataset(path), ""
    except Exception:
        pass
    try:                         # keeps mask_and_scale/_FillValue applied
        return (xr.open_dataset(path, decode_times=False,
                                decode_timedelta=False),
                " (times not decoded)")
    except Exception:
        return (xr.open_dataset(path, decode_times=False, decode_cf=False),
                " (RAW: CF decoding disabled — values may be packed/unmasked)")


def suggest_traces(path, ds):
    """Default traces for the lab formats written by the GUIs in this repo."""
    fmt = str(ds.attrs.get("format", ""))
    out = []
    if fmt == "DHO924S_snapshots_v1" and "volts" in ds and "time_s" in ds:
        out.append({"file": path, "var": "volts", "line_dim": "sample",
                    "xsrc": "var:time_s", "sweep": "channel",
                    "slices": {"snap": 0}, "label": "volts", "visible": True})
    elif fmt == "VNA_OSA_sidebands_v1" and "spectra_dbm" in ds:
        out.append({"file": path, "var": "spectra_dbm", "line_dim": "wl",
                    "xsrc": "var:wl_nm" if "wl_nm" in ds else "index",
                    "sweep": "", "slices": {"freq": 0},
                    "label": "OSA spectrum", "visible": True})
    return out


class ExplorerWindow(QtWidgets.QMainWindow):
    def __init__(self, paths=()):
        super().__init__()
        self.setWindowTitle("NC Explorer")
        screen = QtWidgets.QApplication.primaryScreen()
        avail = screen.availableGeometry() if screen else QtCore.QRect(0, 0, 1280, 800)
        self.resize(min(1360, int(avail.width() * 0.95)),
                    min(800, int(avail.height() * 0.92)))
        self.dsets = {}              # path -> xr.Dataset
        self.traces = []             # list of trace dicts (JSON-serializable)
        self.markers = []            # [{"trace": i, "line": j, "idx": k}]
        self.cur = -1                # selected trace index
        self._updating = False
        self._plotted = []           # (trace_i, line_j, x_scaled, y_scaled)
        self._marker_pts = []        # (marker_i, x_scaled, y_scaled)
        self.plotcfg = dict(DEFAULT_PLOTCFG)
        self._build_ui()
        self.sp_figw.setEnabled(False)
        self.sp_figh.setEnabled(False)
        self._apply_plot_size()
        self.statusBar().showMessage(
            "Open a .nc file (or a saved .ncproj project) to begin.")
        for p in paths:
            self.open_file(p)

    # ------------------------------------------------------------------ UI
    def _build_ui(self):
        central = QtWidgets.QWidget()
        self.setCentralWidget(central)
        h = QtWidgets.QHBoxLayout(central)

        # ---------------- left: files + variables + info
        lhost = QtWidgets.QWidget()
        lv = QtWidgets.QVBoxLayout(lhost)
        lv.setContentsMargins(0, 0, 0, 0)
        box = QtWidgets.QGroupBox("Datasets")
        bv = QtWidgets.QVBoxLayout(box)
        row = QtWidgets.QHBoxLayout()
        b_open = QtWidgets.QPushButton("Open .nc…")
        b_close = QtWidgets.QPushButton("Close file"); b_close.setProperty("flavor", "ghost")
        row.addWidget(b_open); row.addWidget(b_close)
        bv.addLayout(row)
        self.tree = QtWidgets.QTreeWidget()
        self.tree.setHeaderLabels(["variable", "dims"])
        self.tree.setColumnWidth(0, 150)
        bv.addWidget(self.tree, 1)
        b_add = QtWidgets.QPushButton("Add trace ➜")
        bv.addWidget(b_add)
        lv.addWidget(box, 3)
        box = QtWidgets.QGroupBox("Info")
        bv = QtWidgets.QVBoxLayout(box)
        self.info = QtWidgets.QPlainTextEdit()
        self.info.setReadOnly(True)
        self.info.setStyleSheet("font-family: Consolas, monospace; font-size: 8.5pt;")
        bv.addWidget(self.info)
        lv.addWidget(box, 2)
        lhost.setMinimumWidth(270)
        lscroll = self._vscroll(lhost, 280)
        h.addWidget(lscroll)

        # ---------------- center: figure
        chost = QtWidgets.QWidget()
        cv = QtWidgets.QVBoxLayout(chost)
        cv.setContentsMargins(0, 0, 0, 0)
        self.fig = Figure(figsize=(7.6, 6.4), tight_layout=True)
        self.canvas = FigureCanvas(self.fig)
        cv.addWidget(NavBar(self.canvas, self))
        # the canvas lives in a scroll area: when the plot size is LOCKED the
        # figure stays a fixed number of inches (so exported text is the same
        # size no matter how big the app window is) and scrolls if it doesn't
        # fit; unlocked, it fills the window as before
        self.canvas_scroll = QtWidgets.QScrollArea()
        self.canvas_scroll.setWidgetResizable(True)
        self.canvas_scroll.setAlignment(QtCore.Qt.AlignCenter)
        self.canvas_scroll.setFrameShape(QtWidgets.QFrame.NoFrame)
        self.canvas_scroll.setWidget(self.canvas)
        cv.addWidget(self.canvas_scroll, 1)
        h.addWidget(chost, 1)

        # ---------------- right: plot config / traces / sliders / export
        rhost = QtWidgets.QWidget()
        rv = QtWidgets.QVBoxLayout(rhost)
        rv.setContentsMargins(0, 0, 0, 0)

        box = QtWidgets.QGroupBox("Plot")
        f = QtWidgets.QFormLayout(box)
        self.cb_mode = QtWidgets.QComboBox()
        self.cb_mode.addItems(["2D lines", "Rainbow", "3D waterfall"])
        self.le_title = QtWidgets.QLineEdit()
        self.le_xlab = QtWidgets.QLineEdit()
        self.le_ylab = QtWidgets.QLineEdit()
        self.le_zlab = QtWidgets.QLineEdit()
        for le, ph in ((self.le_title, "auto"), (self.le_xlab, "auto"),
                       (self.le_ylab, "auto"), (self.le_zlab, "auto")):
            le.setPlaceholderText(ph)
        self.ck_leg = QtWidgets.QCheckBox("Legend")
        self.ck_leg.setChecked(True)
        self.cb_legloc = QtWidgets.QComboBox()
        self.cb_legloc.addItems(LEGEND_LOCS)
        self.ck_grid = QtWidgets.QCheckBox("Grid")
        self.ck_grid.setChecked(True)
        self.ck_logx = QtWidgets.QCheckBox("log X")
        self.ck_logy = QtWidgets.QCheckBox("log Y")
        self.cb_cmap = QtWidgets.QComboBox()
        self.cb_cmap.addItems(CMAPS)
        f.addRow("Mode", self.cb_mode)
        f.addRow("Title", self.le_title)
        f.addRow("X label", self.le_xlab)
        f.addRow("Y label", self.le_ylab)
        f.addRow("Z label", self.le_zlab)
        lr = QtWidgets.QHBoxLayout()
        lr.addWidget(self.ck_leg); lr.addWidget(self.cb_legloc)
        f.addRow("", self._host(lr))
        gr = QtWidgets.QHBoxLayout()
        gr.addWidget(self.ck_grid); gr.addWidget(self.ck_logx); gr.addWidget(self.ck_logy)
        f.addRow("", self._host(gr))
        self.cb_xscale = QtWidgets.QComboBox()
        self.cb_xscale.addItems(UNIT_PREFIXES)
        self.cb_yscale = QtWidgets.QComboBox()
        self.cb_yscale.addItems(UNIT_PREFIXES)
        sr = QtWidgets.QHBoxLayout()
        sr.addWidget(QtWidgets.QLabel("X ÷")); sr.addWidget(self.cb_xscale)
        sr.addWidget(QtWidgets.QLabel("  Y ÷")); sr.addWidget(self.cb_yscale)
        sr.addStretch(1)
        f.addRow("Unit scale", self._host(sr))
        f.addRow("Colormap", self.cb_cmap)
        rv.addWidget(box)

        box = QtWidgets.QGroupBox("Plot size (fixed export)")
        f = QtWidgets.QFormLayout(box)
        self.ck_lock = QtWidgets.QCheckBox("Lock plot size")
        self.sp_figw = QtWidgets.QDoubleSpinBox()
        self.sp_figw.setRange(2.0, 40.0); self.sp_figw.setDecimals(1)
        self.sp_figw.setSingleStep(0.5); self.sp_figw.setSuffix(" in")
        self.sp_figw.setValue(7.6)
        self.sp_figh = QtWidgets.QDoubleSpinBox()
        self.sp_figh.setRange(2.0, 40.0); self.sp_figh.setDecimals(1)
        self.sp_figh.setSingleStep(0.5); self.sp_figh.setSuffix(" in")
        self.sp_figh.setValue(6.4)
        f.addRow(self.ck_lock)
        wh = QtWidgets.QHBoxLayout()
        wh.addWidget(QtWidgets.QLabel("W")); wh.addWidget(self.sp_figw)
        wh.addWidget(QtWidgets.QLabel("H")); wh.addWidget(self.sp_figh)
        f.addRow("Size", self._host(wh))
        hint = QtWidgets.QLabel("locked → figure stays this many inches, so "
                                "exported font size never changes with the "
                                "app window (scroll if it doesn't fit)")
        hint.setWordWrap(True)
        hint.setStyleSheet("color: #4b5563; font-size: 8.5pt;")
        f.addRow(hint)
        rv.addWidget(box)

        box = QtWidgets.QGroupBox("Markers")
        bv = QtWidgets.QVBoxLayout(box)
        self.b_marker = QtWidgets.QPushButton("📍 Marker mode")
        self.b_marker.setCheckable(True)
        self.b_marker.setProperty("flavor", "ghost")
        b_mkclear = QtWidgets.QPushButton("Clear markers")
        b_mkclear.setProperty("flavor", "ghost")
        mrow = QtWidgets.QHBoxLayout()
        mrow.addWidget(self.b_marker); mrow.addWidget(b_mkclear)
        bv.addLayout(mrow)
        hint = QtWidgets.QLabel("left-click: add at the nearest data point\n"
                                "right-click: delete the nearest marker")
        hint.setStyleSheet("color: #4b5563; font-size: 8.5pt;")
        bv.addWidget(hint)
        rv.addWidget(box)

        box = QtWidgets.QGroupBox("Traces")
        bv = QtWidgets.QVBoxLayout(box)
        self.lst = QtWidgets.QListWidget()
        self.lst.setMaximumHeight(120)
        bv.addWidget(self.lst)
        row = QtWidgets.QHBoxLayout()
        b_rm = QtWidgets.QPushButton("Remove"); b_rm.setProperty("flavor", "ghost")
        b_clr = QtWidgets.QPushButton("Clear all"); b_clr.setProperty("flavor", "warn")
        row.addWidget(b_rm); row.addWidget(b_clr)
        bv.addLayout(row)
        rv.addWidget(box)

        box = QtWidgets.QGroupBox("Selected trace")
        f = QtWidgets.QFormLayout(box)
        self.cb_ldim = QtWidgets.QComboBox()
        self.cb_xsrc = QtWidgets.QComboBox()
        self.cb_sweep = QtWidgets.QComboBox()
        self.le_label = QtWidgets.QLineEdit()
        self.le_label.setPlaceholderText("legend text for this trace")
        self.le_sweeplabel = QtWidgets.QLineEdit()
        self.le_sweeplabel.setPlaceholderText("per-line, e.g. T = {v} K   "
                                              "({v}=value, {n}=index)")
        f.addRow("Line along", self.cb_ldim)
        f.addRow("X values", self.cb_xsrc)
        f.addRow("Sweep dim", self.cb_sweep)
        f.addRow("Legend label", self.le_label)
        f.addRow("Sweep label", self.le_sweeplabel)
        rv.addWidget(box)

        self.slider_box = QtWidgets.QGroupBox("Sliders (slice the other dims)")
        self.slider_form = QtWidgets.QVBoxLayout(self.slider_box)
        rv.addWidget(self.slider_box)

        box = QtWidgets.QGroupBox("Export / project")
        g = QtWidgets.QGridLayout(box)
        b_fig = QtWidgets.QPushButton("Export figure…")
        b_csv = QtWidgets.QPushButton("Export CSV…"); b_csv.setProperty("flavor", "ghost")
        b_psave = QtWidgets.QPushButton("Save project…")
        b_pload = QtWidgets.QPushButton("Load project…"); b_pload.setProperty("flavor", "ghost")
        g.addWidget(b_fig, 0, 0); g.addWidget(b_csv, 0, 1)
        g.addWidget(b_psave, 1, 0); g.addWidget(b_pload, 1, 1)
        rv.addWidget(box)
        rv.addStretch(1)
        rscroll = self._vscroll(rhost, 330)
        h.addWidget(rscroll)

        # wiring
        b_open.clicked.connect(self.on_open)
        b_close.clicked.connect(self.on_close_file)
        b_add.clicked.connect(self.on_add_trace)
        self.tree.itemSelectionChanged.connect(self._show_info)
        self.tree.itemDoubleClicked.connect(lambda *_: self.on_add_trace())
        self.lst.currentRowChanged.connect(self._select_trace)
        self.lst.itemChanged.connect(self._vis_changed)
        b_rm.clicked.connect(self.on_remove_trace)
        b_clr.clicked.connect(self.on_clear_traces)
        self.cb_ldim.currentIndexChanged.connect(lambda _i: self._editor_changed("line_dim"))
        self.cb_xsrc.currentIndexChanged.connect(lambda _i: self._editor_changed("xsrc"))
        self.cb_sweep.currentIndexChanged.connect(lambda _i: self._editor_changed("sweep"))
        self.le_label.editingFinished.connect(lambda: self._editor_changed("label"))
        self.le_sweeplabel.editingFinished.connect(
            lambda: self._editor_changed("sweep_label"))
        self.cb_mode.currentIndexChanged.connect(self._cfg_changed)
        for w in (self.le_title, self.le_xlab, self.le_ylab, self.le_zlab):
            w.editingFinished.connect(self._cfg_changed)
        for w in (self.ck_leg, self.ck_grid, self.ck_logx, self.ck_logy):
            w.toggled.connect(self._cfg_changed)
        self.cb_legloc.currentIndexChanged.connect(self._cfg_changed)
        self.cb_cmap.currentIndexChanged.connect(self._cfg_changed)
        self.cb_xscale.currentIndexChanged.connect(self._cfg_changed)
        self.cb_yscale.currentIndexChanged.connect(self._cfg_changed)
        self.ck_lock.toggled.connect(self._cfg_changed)
        self.sp_figw.valueChanged.connect(self._cfg_changed)
        self.sp_figh.valueChanged.connect(self._cfg_changed)
        b_mkclear.clicked.connect(self.on_clear_markers)
        self.canvas.mpl_connect("button_press_event", self._on_plot_click)
        b_fig.clicked.connect(self.on_export_fig)
        b_csv.clicked.connect(self.on_export_csv)
        b_psave.clicked.connect(self.on_save_project)
        b_pload.clicked.connect(self.on_load_project)
        self.setAcceptDrops(True)

    @staticmethod
    def _host(layout):
        w = QtWidgets.QWidget()
        w.setLayout(layout)
        return w

    @staticmethod
    def _vscroll(widget, width):
        s = QtWidgets.QScrollArea()
        s.setWidgetResizable(True)
        s.setFrameShape(QtWidgets.QFrame.NoFrame)
        s.setHorizontalScrollBarPolicy(QtCore.Qt.ScrollBarAlwaysOff)
        s.setWidget(widget)
        sb = QtWidgets.QApplication.style().pixelMetric(
            QtWidgets.QStyle.PM_ScrollBarExtent)
        s.setFixedWidth(width + sb + 6)
        s.setStyleSheet("QScrollArea { background: transparent; }")
        s.viewport().setAutoFillBackground(False)
        return s

    # ------------------------------------------------------------ drag&drop
    def dragEnterEvent(self, ev):
        if ev.mimeData().hasUrls():
            ev.acceptProposedAction()

    def dropEvent(self, ev):
        for url in ev.mimeData().urls():
            p = url.toLocalFile()
            if p.lower().endswith(".ncproj"):
                self.load_project(p)
            elif p:
                self.open_file(p)

    # -------------------------------------------------------------- files
    def open_file(self, path):
        path = _canon(path)
        if path in self.dsets:
            self.statusBar().showMessage(f"{os.path.basename(path)} is already open.")
            return True
        try:
            ds, warn = open_nc(path)
        except Exception as e:
            self.statusBar().showMessage(f"Cannot open {path}: {e}")
            return False
        self.dsets[path] = ds
        self._rebuild_tree()
        sug = suggest_traces(path, ds)
        if sug and not self.traces:
            for t in sug:
                self.traces.append(t)
            self._rebuild_trace_list(select=len(self.traces) - 1)
            self.redraw()
            self.statusBar().showMessage(
                f"Opened {os.path.basename(path)}{warn} — recognized "
                f"{ds.attrs.get('format')}; added default trace(s). "
                "Use the sliders to explore.")
        else:
            self.statusBar().showMessage(
                f"Opened {os.path.basename(path)}{warn} "
                f"({len(ds.data_vars)} variables). Select one and 'Add trace'.")
        return True

    def on_open(self):
        paths, _f = QtWidgets.QFileDialog.getOpenFileNames(
            self, "Open NetCDF file(s)",
            os.path.join(os.path.dirname(os.path.abspath(__file__)), "data"),
            "NetCDF (*.nc);;All files (*)")
        for p in paths:
            self.open_file(p)

    def on_close_file(self):
        it = self.tree.currentItem()
        if it is None:
            return
        while it.parent() is not None:
            it = it.parent()
        path = it.data(0, QtCore.Qt.UserRole)
        if path not in self.dsets:
            return
        n_used = sum(1 for t in self.traces if t["file"] == path)
        if n_used:
            ok = QtWidgets.QMessageBox.question(
                self, "Close file",
                f"{n_used} trace(s) use this file and will be removed. Close?",
                QtWidgets.QMessageBox.Yes | QtWidgets.QMessageBox.No)
            if ok != QtWidgets.QMessageBox.Yes:
                return
        try:
            self.dsets[path].close()
        except Exception:
            pass
        del self.dsets[path]
        keep = [i for i, t in enumerate(self.traces) if t["file"] != path]
        remap_idx = {old: new for new, old in enumerate(keep)}
        self.markers = [dict(m, trace=remap_idx[m["trace"]])
                        for m in self.markers if m["trace"] in remap_idx]
        self.traces = [self.traces[i] for i in keep]
        self._rebuild_tree()
        self._rebuild_trace_list()
        self.redraw()

    def _rebuild_tree(self):
        self.tree.clear()
        for path, ds in self.dsets.items():
            top = QtWidgets.QTreeWidgetItem([os.path.basename(path), ""])
            top.setToolTip(0, path)
            top.setData(0, QtCore.Qt.UserRole, path)
            for name, da in ds.data_vars.items():
                dims = " × ".join(f"{d}:{ds.sizes[d]}" for d in da.dims)
                child = QtWidgets.QTreeWidgetItem([str(name), dims])
                child.setData(0, QtCore.Qt.UserRole, (path, str(name)))
                if not _is_numeric(da):
                    child.setForeground(0, QtCore.Qt.gray)
                    child.setToolTip(0, "non-numeric (text) variable")
                top.addChild(child)
            # coordinates too: an axis like freq_Hz(freq) must be visible
            for name, ca in ds.coords.items():
                dims = " × ".join(f"{d}:{ds.sizes[d]}" for d in ca.dims)
                child = QtWidgets.QTreeWidgetItem([str(name), f"{dims} (coord)"])
                child.setData(0, QtCore.Qt.UserRole, (path, str(name)))
                child.setToolTip(0, "coordinate")
                if not _is_numeric(ca):
                    child.setForeground(0, QtCore.Qt.gray)
                top.addChild(child)
            self.tree.addTopLevelItem(top)
            top.setExpanded(True)

    def _sel_var(self):
        it = self.tree.currentItem()
        if it is None:
            return None
        d = it.data(0, QtCore.Qt.UserRole)
        if isinstance(d, tuple):
            return d
        return None

    def _show_info(self):
        it = self.tree.currentItem()
        if it is None:
            return
        d = it.data(0, QtCore.Qt.UserRole)
        lines = []
        if isinstance(d, tuple):
            path, var = d
            da = self.dsets[path][var]
            lines.append(f"{var}  ({da.dtype})")
            lines.append("dims: " + ", ".join(
                f"{dd}={self.dsets[path].sizes[dd]}" for dd in da.dims))
            for k, v in da.attrs.items():
                lines.append(f"  {k}: {_dec(v)}")
            if not _is_numeric(da) and da.size:
                try:
                    first = np.asarray(da.values).ravel()[0]
                    lines.append(f"  first value: {_dec(first)}")
                except Exception:
                    pass
        elif d in self.dsets:
            ds = self.dsets[d]
            lines.append(os.path.basename(d))
            lines.append(f"dims: " + ", ".join(
                f"{k}={v}" for k, v in ds.sizes.items()))
            for k, v in ds.attrs.items():
                lines.append(f"  {k}: {_dec(v)}")
        self.info.setPlainText("\n".join(lines))

    # -------------------------------------------------------------- traces
    def _trace_name(self, t):
        return (f"{t.get('label') or t['var']}   "
                f"[{t['var']} @ {os.path.basename(t['file'])}]")

    def _rebuild_trace_list(self, select=None):
        prev = self.cur
        self._updating = True
        try:
            self.lst.clear()             # currentRowChanged(-1) suppressed
            for t in self.traces:
                it = QtWidgets.QListWidgetItem(self._trace_name(t))
                it.setFlags(it.flags() | QtCore.Qt.ItemIsUserCheckable)
                it.setCheckState(QtCore.Qt.Checked if t.get("visible", True)
                                 else QtCore.Qt.Unchecked)
                self.lst.addItem(it)
            if select is None:
                select = min(prev, len(self.traces) - 1)
            self.lst.setCurrentRow(select if select is not None else -1)
        finally:
            self._updating = False
        self._select_trace(self.lst.currentRow())   # authoritative, once

    def on_add_trace(self):
        sel = self._sel_var()
        if sel is None:
            self.statusBar().showMessage("Select a variable in the tree first.")
            return
        path, var = sel
        da = self.dsets[path][var]
        if not _is_numeric(da):
            self.statusBar().showMessage(f"{var} is not numeric — cannot plot.")
            return
        if da.ndim == 0:
            self.statusBar().showMessage(f"{var} is a scalar — nothing to plot.")
            return
        line_dim = da.dims[-1]
        # only a convertible coordinate is usable as x (string/byte label
        # coords would crash the float cast; datetimes convert to seconds)
        coord_ok = (line_dim in da.coords and _x_ok(da.coords[line_dim]))
        xsrc = "coord" if coord_ok else "index"
        if not coord_ok:
            # a differently-named axis (freq_Hz on dim freq): auto-pick it
            # when unambiguous, or when exactly one candidate carries the
            # dim's name as a prefix
            cands = _dim_axis_candidates(self.dsets[path], line_dim)
            pref = [c for c in cands if c.startswith(str(line_dim))]
            if len(cands) == 1:
                xsrc = f"var:{cands[0]}"
            elif len(pref) == 1:
                xsrc = f"var:{pref[0]}"
        t = {"file": path, "var": var, "line_dim": str(line_dim),
             "xsrc": xsrc,
             "sweep": "", "slices": {str(d): 0 for d in da.dims if d != line_dim},
             "label": var, "sweep_label": "", "visible": True}
        self.traces.append(t)
        self._rebuild_trace_list(select=len(self.traces) - 1)
        self.redraw()

    def on_remove_trace(self):
        r = self.lst.currentRow()
        if 0 <= r < len(self.traces):
            self.traces.pop(r)
            self.markers = [dict(m, trace=m["trace"] - (m["trace"] > r))
                            for m in self.markers if m["trace"] != r]
            self._rebuild_trace_list(select=max(0, r - 1))
            self.redraw()

    def on_clear_traces(self):
        self.traces = []
        self.markers = []
        self._rebuild_trace_list(select=-1)
        self.redraw()

    def _vis_changed(self, item):
        if self._updating:
            return
        r = self.lst.row(item)
        if 0 <= r < len(self.traces):
            self.traces[r]["visible"] = item.checkState() == QtCore.Qt.Checked
            self.redraw()

    def _select_trace(self, row):
        if self._updating:
            return
        self.cur = row
        self._populate_editor()
        self._rebuild_sliders()

    def _populate_editor(self):
        self._updating = True
        try:
            self.cb_ldim.clear()
            self.cb_xsrc.clear()
            self.cb_sweep.clear()
            self.le_label.clear()
            self.le_sweeplabel.clear()
            if not (0 <= self.cur < len(self.traces)):
                return
            t = self.traces[self.cur]
            ds = self.dsets.get(t["file"])
            if ds is None or t["var"] not in ds:
                self.statusBar().showMessage(
                    f"trace '{t.get('label')}': variable {t.get('var')} not "
                    "in the file (changed on disk?) — not plottable.")
                return
            da = ds[t["var"]]
            dims = [str(d) for d in da.dims]
            self.cb_ldim.addItems(dims)
            self.cb_ldim.setCurrentText(t["line_dim"])
            # x sources: index, the dim's NUMERIC coord, or any numeric variable
            # whose dims are a subset of this variable's dims and include line_dim
            self.cb_xsrc.addItem("index")
            if (t["line_dim"] in da.coords
                    and _x_ok(da.coords[t["line_dim"]])):
                self.cb_xsrc.addItem("coord")
            for name, xa in ds.variables.items():
                name = str(name)
                if name == t["var"] or not _is_numeric(xa):
                    continue
                xdims = set(str(d) for d in xa.dims)
                if t["line_dim"] in xdims and xdims <= set(dims):
                    self.cb_xsrc.addItem(f"var:{name}")
            if self.cb_xsrc.findText(t["xsrc"]) < 0:
                t["xsrc"] = "index"
            self.cb_xsrc.setCurrentText(t["xsrc"])
            self.cb_sweep.addItem("(none)")
            for d in dims:
                if d != t["line_dim"]:
                    self.cb_sweep.addItem(d)
            self.cb_sweep.setCurrentText(t["sweep"] if t["sweep"] else "(none)")
            self.le_label.setText(t.get("label", t["var"]))
            self.le_sweeplabel.setText(t.get("sweep_label", ""))
            self.le_sweeplabel.setEnabled(bool(t["sweep"]))
        finally:
            self._updating = False

    def _editor_changed(self, what):
        if self._updating or not (0 <= self.cur < len(self.traces)):
            return
        t = self.traces[self.cur]
        if what == "line_dim":
            new = self.cb_ldim.currentText()
            if new and new != t["line_dim"]:
                t["line_dim"] = new
                if t["sweep"] == new:
                    t["sweep"] = ""
                ds = self.dsets[t["file"]]
                t["slices"] = {str(d): t["slices"].get(str(d), 0)
                               for d in ds[t["var"]].dims
                               if str(d) not in (new, t["sweep"])}
                self._populate_editor()
                self._rebuild_sliders()
        elif what == "xsrc":
            v = self.cb_xsrc.currentText()
            if v:
                t["xsrc"] = v
        elif what == "sweep":
            v = self.cb_sweep.currentText()
            v = "" if v == "(none)" else v
            if v != t["sweep"]:
                t["sweep"] = v
                self.le_sweeplabel.setEnabled(bool(v))
                ds = self.dsets[t["file"]]
                t["slices"] = {str(d): t["slices"].get(str(d), 0)
                               for d in ds[t["var"]].dims
                               if str(d) not in (t["line_dim"], v)}
                self._rebuild_sliders()
        elif what == "label":
            t["label"] = self.le_label.text().strip() or t["var"]
            self._updating = True
            it = self.lst.item(self.cur)
            if it is not None:
                it.setText(self._trace_name(t))
            self._updating = False
        elif what == "sweep_label":
            t["sweep_label"] = self.le_sweeplabel.text()
        self.redraw()

    # -------------------------------------------------------------- sliders
    def _rebuild_sliders(self):
        while self.slider_form.count():
            w = self.slider_form.takeAt(0).widget()
            if w is not None:
                w.setParent(None)   # detach NOW (deleteLater alone leaves the
                w.deleteLater()     # stale sliders alive until the event loop)
        if not (0 <= self.cur < len(self.traces)):
            return
        t = self.traces[self.cur]
        ds = self.dsets.get(t["file"])
        if ds is None or t["var"] not in ds:
            return
        da = ds[t["var"]]
        for d in [str(x) for x in da.dims]:
            if d in (t["line_dim"], t["sweep"]):
                continue
            n = int(ds.sizes[d])
            if n <= 0:
                self.slider_form.addWidget(
                    QtWidgets.QLabel(f"{d}: EMPTY (size 0) — not plottable"))
                continue
            row = QtWidgets.QWidget()
            rl = QtWidgets.QHBoxLayout(row)
            rl.setContentsMargins(0, 0, 0, 0)
            lab = QtWidgets.QLabel(d)
            lab.setMinimumWidth(52)
            sld = QtWidgets.QSlider(QtCore.Qt.Horizontal)
            sld.setRange(0, n - 1)
            idx = max(0, min(int(t["slices"].get(d, 0)), n - 1))
            t["slices"][d] = idx
            sld.setValue(idx)
            val = QtWidgets.QLabel()
            val.setMinimumWidth(88)
            val.setStyleSheet("font-family: Consolas, monospace; font-size: 8.5pt;")
            self._slider_lab(val, ds, d, idx, n)
            sld.valueChanged.connect(
                lambda v, dim=d, vl=val, dds=ds, nn=n: self._slide(dim, v, vl, dds, nn))
            rl.addWidget(lab)
            rl.addWidget(sld, 1)
            rl.addWidget(val)
            self.slider_form.addWidget(row)
        if self.slider_form.count() == 0:
            self.slider_form.addWidget(QtWidgets.QLabel("(no free dims)"))

    @staticmethod
    def _slider_lab(lab, ds, dim, idx, n):
        txt = f"{idx}/{n-1}"
        src = None
        if dim in ds.coords:
            src = ds.coords[dim]
        else:
            # show the differently-named axis value (freq_Hz on dim freq)
            cands = _dim_axis_candidates(ds, dim)
            if cands:
                pref = [c for c in cands if c.startswith(str(dim))]
                src = ds[pref[0] if pref else cands[0]]
        if src is not None:
            try:
                cv = np.asarray(src.values)[idx]
                if np.issubdtype(np.asarray(cv).dtype, np.datetime64):
                    txt = f"{idx}: {np.datetime_as_string(cv, unit='s')}"
                else:
                    txt = f"{idx}: {float(cv):.6g}"
            except Exception:
                pass
        lab.setText(txt)

    def _slide(self, dim, v, val_lab, ds, n):
        if not (0 <= self.cur < len(self.traces)):
            return
        self.traces[self.cur]["slices"][dim] = int(v)
        self._slider_lab(val_lab, ds, dim, int(v), n)
        self.redraw()

    # -------------------------------------------------------------- plotting
    def _sweep_vals(self, ds, dim):
        n = int(ds.sizes[dim])
        if dim in ds.coords:
            try:
                return _as_float(ds.coords[dim].values)
            except Exception:
                pass
        return np.arange(n, dtype=float)

    def trace_lines(self, t):
        """-> (lines, sweep_name) where lines = [(x, y, sweep_value|None)]."""
        ds = self.dsets.get(t["file"])
        if ds is None or t["var"] not in ds:
            return [], None
        da = ds[t["var"]]
        ldim = t["line_dim"]
        if ldim not in da.dims:
            return [], None
        sweep = t.get("sweep") or None
        if sweep is not None and sweep not in da.dims:
            sweep = None
        if any(int(ds.sizes[str(d)]) == 0 for d in da.dims):
            self.statusBar().showMessage(
                f"{t['var']}: a dimension has size 0 — nothing to plot.")
            return [], None
        sel = {}
        for d in [str(x) for x in da.dims]:
            if d in (ldim, sweep):
                continue
            sel[d] = max(0, min(int(t["slices"].get(d, 0)),
                                int(ds.sizes[d]) - 1))
        sub = da.isel(sel)

        def xvals(extra_sel):
            src = t.get("xsrc", "index")
            n = int(ds.sizes[ldim])
            if src == "coord" and ldim in ds.coords:
                try:
                    return _as_float(ds.coords[ldim].values)
                except Exception:       # string/byte label coordinate
                    return np.arange(n, dtype=float)
            if src.startswith("var:"):
                name = src[4:]
                if (name in ds.variables
                        and ldim in [str(d) for d in ds[name].dims]):
                    xa = ds[name]
                    xsel = {d: extra_sel.get(str(d), sel.get(str(d), 0))
                            for d in xa.dims if str(d) != ldim}
                    try:
                        return np.atleast_1d(_as_float(xa.isel(xsel).values))
                    except Exception:
                        return np.arange(n, dtype=float)
            return np.arange(n, dtype=float)

        lines = []
        if sweep is None:
            y = np.atleast_1d(_as_float(sub.transpose(ldim).values))
            lines.append((xvals({}), y, None))
        else:
            svals = self._sweep_vals(ds, sweep)
            n_s = int(ds.sizes[sweep])
            idxs = list(range(n_s))
            if n_s > MAX_SWEEP_LINES:
                idxs = list(np.linspace(0, n_s - 1, MAX_SWEEP_LINES).astype(int))
                self.statusBar().showMessage(
                    f"sweep '{sweep}' has {n_s} lines — showing "
                    f"{MAX_SWEEP_LINES} evenly spaced.")
            arr = sub.transpose(sweep, ldim)
            for i in idxs:
                y = np.atleast_1d(_as_float(arr.isel({sweep: i}).values))
                lines.append((xvals({sweep: i}), y,
                              float(svals[i]) if i < len(svals) else float(i)))
        return lines, sweep

    @staticmethod
    def _line_label(t, sweep, sval, j):
        """Legend text for one line. Single trace -> the base label; a sweep
        line -> the base label + '[sweep=value]', or the user's sweep-label
        template with {v}=value, {n}=index, {label}=base, {sweep}=dim name."""
        base = t.get("label") or t["var"]
        if sval is None:
            return base
        tmpl = t.get("sweep_label") or ""
        if tmpl.strip():
            return (tmpl.replace("{label}", base)
                        .replace("{sweep}", sweep or "")
                        .replace("{v}", f"{sval:.6g}")
                        .replace("{n}", str(j)))
        return f"{base} [{sweep}={sval:.6g}]"

    def _auto_labels(self):
        """Best-effort axis labels from the first visible trace."""
        for t in self.traces:
            if not t.get("visible", True):
                continue
            ds = self.dsets.get(t["file"])
            if ds is None or t["var"] not in ds:
                continue
            da = ds[t["var"]]
            yl = t["var"]
            if "units" in da.attrs:
                yl += f" ({_dec(da.attrs['units'])})"
            src = t.get("xsrc", "index")
            if src.startswith("var:"):
                name = src[4:]
                xl = name
                if name in ds.variables and "units" in ds[name].attrs:
                    xl += f" ({_dec(ds[name].attrs['units'])})"
            elif src == "coord":
                xl = t["line_dim"]
                if (t["line_dim"] in ds.coords
                        and "units" in ds.coords[t["line_dim"]].attrs):
                    xl += f" ({_dec(ds.coords[t['line_dim']].attrs['units'])})"
            else:
                xl = f"{t['line_dim']} (index)"
            return xl, yl
        return "", ""

    def redraw(self):
        cfg = self.plotcfg
        self.fig.clear()
        mode = cfg["mode"]
        is3d = mode == "3D waterfall"
        ax = self.fig.add_subplot(111, projection="3d" if is3d else None)
        cmap = _get_cmap(cfg["cmap"])
        auto_xl, auto_yl = self._auto_labels()
        cycle = ["#1565c0", "#c0392b", "#0d6b3f", "#7d3cff", "#e6a700",
                 "#00838f", "#ad1457", "#4e342e"]
        notes = []

        # pass 1: fetch every visible trace's lines; group sweep ranges by name
        fetched = []               # (trace_index, trace, lines, sweep_name)
        sweep_ranges = {}          # sweep name -> [lo, hi]
        skipped = 0
        for ti, t in enumerate(self.traces):
            if not t.get("visible", True):
                continue
            lines, sweep = self.trace_lines(t)
            if not lines:
                skipped += 1
                continue
            fetched.append((ti, t, lines, sweep))
            if sweep:
                fin = [s for (_x, _y, s) in lines
                       if s is not None and np.isfinite(s)]
                if fin:
                    lo, hi = min(fin), max(fin)
                    r = sweep_ranges.setdefault(sweep, [lo, hi])
                    r[0], r[1] = min(r[0], lo), max(r[1], hi)
        # one shared norm+colorbar only when every sweeping trace sweeps the
        # SAME quantity; otherwise per-trace norms and no colorbar
        shared_name = list(sweep_ranges)[0] if len(sweep_ranges) == 1 else None
        if len(sweep_ranges) > 1:
            notes.append("traces sweep different quantities — shared "
                         "colorbar suppressed")

        def norm_for(sweep, lines):
            if sweep is None:
                return None
            if shared_name is not None:
                lo, hi = sweep_ranges[shared_name]
            else:
                fin = [s for (_x, _y, s) in lines
                       if s is not None and np.isfinite(s)]
                if not fin:
                    return None
                lo, hi = min(fin), max(fin)
            return Normalize(lo, hi if hi > lo else lo + 1)

        xf = PREFIX_FACTOR.get(cfg.get("xunit", ""), 1.0)
        yf = PREFIX_FACTOR.get(cfg.get("yunit", ""), 1.0)
        self._plotted = []
        for ti, t, lines, sweep in fetched:
            nrm = norm_for(sweep, lines)
            base_col = cycle[ti % len(cycle)]
            if sweep and len(lines) > 12 and cfg["legend"] and mode == "2D lines":
                notes.append(f"'{t.get('label') or t['var']}': {len(lines)} "
                             "sweep lines — legend omitted (use Rainbow)")
            for j, (x, y, sval) in enumerate(lines):
                m = min(len(x), len(y))
                x, y = x[:m] / xf, y[:m] / yf
                s_ok = sval is not None and np.isfinite(sval)
                col = cmap(nrm(sval)) if (s_ok and nrm is not None) else base_col
                lbl = None
                if sval is None or len(lines) <= 12:
                    lbl = self._line_label(t, sweep, sval, j)
                if is3d:
                    yy = np.full(m, sval if s_ok else float(ti))
                    ax.plot(x, yy, y, lw=0.9, color=col, label=lbl)
                else:
                    ax.plot(x, y, lw=1.0, color=col, label=lbl)
                    self._plotted.append((ti, j, x, y))
        if not is3d:
            self._draw_markers(ax, {ti: lines for ti, _t, lines, _s in fetched},
                               xf, yf)
        elif self.markers:
            notes.append("markers are shown in the 2D views only")
        ax.set_title(cfg["title"], fontsize=10)
        # unit prefixes fold into AUTO labels; user-typed labels stay verbatim
        ax.set_xlabel(cfg["xlabel"] or _scaled_label(auto_xl,
                                                     cfg.get("xunit", "")),
                      fontsize=9)
        yl = cfg["ylabel"] or _scaled_label(auto_yl, cfg.get("yunit", ""))
        if is3d:
            ax.set_ylabel(cfg["zlabel"] or (shared_name or "trace"), fontsize=9)
            ax.set_zlabel(yl, fontsize=9)
            ax.grid(cfg["grid"])
            if cfg["logx"] or cfg["logy"]:
                notes.append("log axes are not applied in the 3D view")
        else:
            ax.set_ylabel(yl, fontsize=9)
            ax.grid(cfg["grid"], alpha=0.3)
            if cfg["logx"]:
                ax.set_xscale("log")
            if cfg["logy"]:
                ax.set_yscale("log")
        if mode == "Rainbow":
            if shared_name is not None:
                lo, hi = sweep_ranges[shared_name]
                sm = cm.ScalarMappable(
                    norm=Normalize(lo, hi if hi > lo else lo + 1), cmap=cmap)
                sm.set_array([])
                cb = self.fig.colorbar(sm, ax=ax, pad=0.02)
                cb.set_label(shared_name, fontsize=8)
            elif not sweep_ranges:
                notes.append("Rainbow mode needs a trace with a sweep dim")
        if cfg["legend"]:
            handles, labels = ax.get_legend_handles_labels()
            if handles:
                ax.legend(fontsize=7, loc=cfg["legend_loc"])
        if skipped:
            notes.append(f"{skipped} trace(s) not plottable "
                         "(missing variable/dim or empty)")
        if notes:
            self.statusBar().showMessage(" | ".join(notes))
        self.canvas.draw_idle()

    # ------------------------------------------------------------- markers
    def _draw_markers(self, ax, lines_by_trace, xf, yf):
        """Markers are anchored to (trace, sweep line, point index), so they
        FOLLOW the trace when sliders scrub the data."""
        self._marker_pts = []
        for mi, mk in enumerate(self.markers):
            lines = lines_by_trace.get(mk.get("trace"))
            if not lines:
                continue
            j = max(0, min(int(mk.get("line", 0)), len(lines) - 1))
            x, y, _s = lines[j]
            m = min(len(x), len(y))
            if m == 0:
                continue
            k = max(0, min(int(mk.get("idx", 0)), m - 1))
            xs, ys = float(x[k]) / xf, float(y[k]) / yf
            if not (np.isfinite(xs) and np.isfinite(ys)):
                continue
            ax.plot([xs], [ys], "o", ms=8, mfc="none", mec="#c0392b",
                    mew=1.6, zorder=5)
            ax.annotate(f"{xs:.6g}, {ys:.6g}", (xs, ys),
                        textcoords="offset points", xytext=(7, 7), fontsize=7,
                        zorder=6,
                        bbox=dict(boxstyle="round,pad=0.2", fc="white",
                                  ec="#c0392b", alpha=0.85))
            self._marker_pts.append((mi, xs, ys))

    def _on_plot_click(self, ev):
        if not self.b_marker.isChecked():
            return
        if self.plotcfg["mode"] == "3D waterfall":
            self.statusBar().showMessage("markers work in the 2D views — "
                                         "switch the plot mode.")
            return
        if not self.fig.axes or ev.inaxes is not self.fig.axes[0] \
                or ev.x is None or ev.y is None:
            return
        ax = self.fig.axes[0]
        if ev.button == 1:            # add at the nearest data point
            hit = self._nearest_point(ax, ev.x, ev.y)
            if hit is not None:
                self.markers.append(hit)
                self.redraw()
            else:
                self.statusBar().showMessage("no data point near the click.")
        elif ev.button == 3:          # delete the nearest marker
            mi = self._nearest_marker(ax, ev.x, ev.y)
            if mi is not None:
                self.markers.pop(mi)
                self.redraw()

    def _nearest_point(self, ax, px, py):
        best, bd = None, MARKER_PICK_PX
        for ti, j, x, y in self._plotted:
            m = np.isfinite(x) & np.isfinite(y)
            if not m.any():
                continue
            idxs = np.flatnonzero(m)
            pts = ax.transData.transform(np.column_stack([x[idxs], y[idxs]]))
            d = np.hypot(pts[:, 0] - px, pts[:, 1] - py)
            i = int(np.argmin(d))
            if d[i] < bd:
                bd = float(d[i])
                best = {"trace": int(ti), "line": int(j),
                        "idx": int(idxs[i])}
        return best

    def _nearest_marker(self, ax, px, py):
        best, bd = None, MARKER_PICK_PX
        for mi, xs, ys in self._marker_pts:
            q = ax.transData.transform([[xs, ys]])[0]
            d = float(np.hypot(q[0] - px, q[1] - py))
            if d < bd:
                bd, best = d, mi
        return best

    def on_clear_markers(self):
        if self.markers:
            self.markers = []
            self.redraw()

    def _cfg_changed(self, *_):
        if self._updating:
            return
        c = self.plotcfg
        c["mode"] = self.cb_mode.currentText()
        c["title"] = self.le_title.text()
        c["xlabel"] = self.le_xlab.text()
        c["ylabel"] = self.le_ylab.text()
        c["zlabel"] = self.le_zlab.text()
        c["legend"] = self.ck_leg.isChecked()
        c["legend_loc"] = self.cb_legloc.currentText()
        c["grid"] = self.ck_grid.isChecked()
        c["logx"] = self.ck_logx.isChecked()
        c["logy"] = self.ck_logy.isChecked()
        c["cmap"] = self.cb_cmap.currentText()
        xu = self.cb_xscale.currentText()
        yu = self.cb_yscale.currentText()
        c["xunit"] = "" if xu == "—" else xu
        c["yunit"] = "" if yu == "—" else yu
        c["lock_size"] = self.ck_lock.isChecked()
        c["figw"] = float(self.sp_figw.value())
        c["figh"] = float(self.sp_figh.value())
        self.sp_figw.setEnabled(c["lock_size"])
        self.sp_figh.setEnabled(c["lock_size"])
        self._apply_plot_size()
        self.redraw()

    def _apply_plot_size(self):
        """Locked: fix the figure to figw×figh inches (deterministic export
        text). Unlocked: let the canvas fill the window as before."""
        c = self.plotcfg
        if c.get("lock_size"):
            dpi = self.fig.get_dpi() or 100.0
            w_in = float(c.get("figw", 7.6))
            h_in = float(c.get("figh", 6.4))
            self.canvas_scroll.setWidgetResizable(False)
            self.canvas.setFixedSize(max(1, int(round(w_in * dpi))),
                                     max(1, int(round(h_in * dpi))))
            self.fig.set_size_inches(w_in, h_in)   # exact for savefig
        else:
            self.canvas.setMinimumSize(0, 0)
            self.canvas.setMaximumSize(16777215, 16777215)
            self.canvas_scroll.setWidgetResizable(True)

    def _apply_cfg_widgets(self):
        self._updating = True
        try:
            c = self.plotcfg
            self.cb_mode.setCurrentText(c["mode"])
            self.le_title.setText(c["title"])
            self.le_xlab.setText(c["xlabel"])
            self.le_ylab.setText(c["ylabel"])
            self.le_zlab.setText(c["zlabel"])
            self.ck_leg.setChecked(c["legend"])
            self.cb_legloc.setCurrentText(c["legend_loc"])
            self.ck_grid.setChecked(c["grid"])
            self.ck_logx.setChecked(c["logx"])
            self.ck_logy.setChecked(c["logy"])
            self.cb_cmap.setCurrentText(c["cmap"])
            self.cb_xscale.setCurrentText(c.get("xunit") or "—")
            self.cb_yscale.setCurrentText(c.get("yunit") or "—")
            self.ck_lock.setChecked(bool(c.get("lock_size", False)))
            self.sp_figw.setValue(float(c.get("figw", 7.6)))
            self.sp_figh.setValue(float(c.get("figh", 6.4)))
            self.sp_figw.setEnabled(bool(c.get("lock_size", False)))
            self.sp_figh.setEnabled(bool(c.get("lock_size", False)))
        finally:
            self._updating = False
        self._apply_plot_size()

    # -------------------------------------------------------------- export
    def on_export_fig(self):
        path, filt = QtWidgets.QFileDialog.getSaveFileName(
            self, "Export figure", time.strftime("ncplot_%Y%m%d_%H%M%S"),
            "PNG image (*.png);;PDF vector (*.pdf);;SVG vector (*.svg)")
        if not path:
            return
        if os.path.splitext(path)[1].lower() not in (".png", ".pdf", ".svg"):
            path += {"PNG": ".png", "PDF": ".pdf", "SVG": ".svg"}.get(
                filt.split(" ")[0], ".png")
        try:
            self.fig.savefig(path, dpi=200 if path.endswith(".png") else None,
                             facecolor="white")
            self.statusBar().showMessage(f"Exported {path}")
        except Exception as e:
            self.statusBar().showMessage(f"Export error: {e}")

    def on_export_csv(self):
        # what you see is what you export: the axis unit scaling applies
        xu = self.plotcfg.get("xunit", "")
        yu = self.plotcfg.get("yunit", "")
        xf = PREFIX_FACTOR.get(xu, 1.0)
        yf = PREFIX_FACTOR.get(yu, 1.0)
        rows = []          # long format: label, sweep, x, y
        for t in self.traces:
            if not t.get("visible", True):
                continue
            lines, sweep = self.trace_lines(t)
            for x, y, sval in lines:
                m = min(len(x), len(y))
                lab = t.get("label") or t["var"]
                for k in range(m):
                    rows.append((lab, "" if sval is None else f"{sval:.9g}",
                                 x[k] / xf, y[k] / yf))
        if not rows:
            self.statusBar().showMessage("Nothing plotted — nothing to export.")
            return
        path, _f = QtWidgets.QFileDialog.getSaveFileName(
            self, "Export plotted data",
            time.strftime("ncplot_%Y%m%d_%H%M%S.csv"), "CSV (*.csv)")
        if not path:
            return
        try:
            with open(path, "w") as fh:
                fh.write("# NC Explorer export (long format)\n")
                if xf != 1.0 or yf != 1.0:
                    fh.write(f"# axis unit scale: x ÷ {xf:g} ({xu or '1'}), "
                             f"y ÷ {yf:g} ({yu or '1'}) — as displayed\n")
                fh.write("trace,sweep,x,y\n")
                for lab, sv, x, y in rows:
                    lab = str(lab).replace('"', '""')   # CSV-escape quotes
                    fh.write(f"\"{lab}\",{sv},{x:.9g},{y:.9g}\n")
            self.statusBar().showMessage(f"Exported {len(rows)} rows -> {path}")
        except Exception as e:
            self.statusBar().showMessage(f"CSV export error: {e}")

    # -------------------------------------------------------------- project
    def on_save_project(self):
        path, _f = QtWidgets.QFileDialog.getSaveFileName(
            self, "Save visualization project",
            time.strftime("ncplot_%Y%m%d_%H%M%S.ncproj"),
            "NC Explorer project (*.ncproj);;JSON (*.json)")
        if not path:
            return
        try:
            # relative paths too, so projects survive Dropbox moves/machines
            projdir = os.path.dirname(os.path.abspath(path))
            rels = []
            for p in self.dsets.keys():
                try:
                    rels.append(os.path.relpath(p, projdir))
                except ValueError:      # different drive letter
                    rels.append(None)
            proj = {"format": PROJECT_FORMAT,
                    "created": time.strftime("%Y-%m-%d %H:%M:%S"),
                    "files": list(self.dsets.keys()),
                    "files_rel": rels,
                    "plot": dict(self.plotcfg),
                    "traces": [dict(t) for t in self.traces],
                    "markers": [dict(m) for m in self.markers]}
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(proj, fh, indent=2)
            self.statusBar().showMessage(f"Project saved -> {path}")
        except Exception as e:
            self.statusBar().showMessage(f"Project save error: {e}")

    def on_load_project(self):
        path, _f = QtWidgets.QFileDialog.getOpenFileName(
            self, "Load visualization project", "",
            "NC Explorer project (*.ncproj *.json);;All files (*)")
        if path:
            self.load_project(path)

    def load_project(self, path):
        try:
            with open(path, "r", encoding="utf-8") as fh:
                proj = json.load(fh)
            if proj.get("format") != PROJECT_FORMAT:
                raise ValueError("not an NC Explorer project file")
        except Exception as e:
            self.statusBar().showMessage(f"Project load error: {e}")
            return
        missing = []
        remap = {}
        projdir = os.path.dirname(os.path.abspath(path))
        files = proj.get("files", [])
        rels = proj.get("files_rel", [None] * len(files))
        try:
            for i, f in enumerate(files):
                # resolve: saved absolute -> saved relative-to-project ->
                # basename next to the project (Dropbox on another machine)
                cands = [f]
                if i < len(rels) and rels[i]:
                    cands.append(os.path.join(projdir, rels[i]))
                cands.append(os.path.join(projdir, os.path.basename(str(f))))
                hit = next((c for c in cands if c and os.path.exists(c)), None)
                if hit is None or not self.open_file(hit):
                    missing.append(str(f))
                else:
                    remap[_canon(f)] = _canon(hit)
            # traces from the project replace whatever auto-suggestion added;
            # sanitize every field (hand-edited/stale projects must not crash)
            newtraces = []
            skipped_traces = 0
            proj_to_new = {}     # project trace position -> new index (markers)
            for pidx, t in enumerate(proj.get("traces", [])):
                try:
                    f = remap.get(_canon(str(t.get("file", ""))),
                                  _canon(str(t.get("file", ""))))
                    if f not in self.dsets:
                        skipped_traces += 1
                        continue
                    ds = self.dsets[f]
                    var = str(t.get("var", ""))
                    if var not in ds:
                        skipped_traces += 1
                        continue
                    dims = [str(d) for d in ds[var].dims]
                    ldim = str(t.get("line_dim", ""))
                    if ldim not in dims:
                        ldim = dims[-1]
                    sweep = str(t.get("sweep", "") or "")
                    if sweep and (sweep not in dims or sweep == ldim):
                        sweep = ""
                    slices = t.get("slices")
                    slices = ({str(k): max(0, int(v))
                               for k, v in slices.items()}
                              if isinstance(slices, dict) else {})
                    proj_to_new[pidx] = len(newtraces)
                    newtraces.append({
                        "file": f, "var": var, "line_dim": ldim,
                        "sweep": sweep, "slices": slices,
                        "xsrc": str(t.get("xsrc", "index")),
                        "label": str(t.get("label", var)),
                        "sweep_label": str(t.get("sweep_label", "")),
                        "visible": bool(t.get("visible", True))})
                except Exception:
                    skipped_traces += 1
            self.traces = newtraces
            # markers: remap to surviving trace indices; drop the stale ones
            newmarkers = []
            for m in proj.get("markers", []) or []:
                try:
                    pt = int(m.get("trace", -1))
                    if pt in proj_to_new:
                        newmarkers.append({"trace": proj_to_new[pt],
                                           "line": max(0, int(m.get("line", 0))),
                                           "idx": max(0, int(m.get("idx", 0)))})
                except Exception:
                    pass
            self.markers = newmarkers
            # absent keys reset to defaults (never keep stale session state)
            self.plotcfg = dict(DEFAULT_PLOTCFG)
            for k, v in (proj.get("plot", {}) or {}).items():
                if k not in self.plotcfg:
                    continue
                dv = DEFAULT_PLOTCFG[k]
                if isinstance(dv, bool):
                    if isinstance(v, bool):
                        self.plotcfg[k] = v
                elif isinstance(dv, float):     # JSON may store 8 as int
                    if isinstance(v, (int, float)) and not isinstance(v, bool):
                        self.plotcfg[k] = float(v)
                elif isinstance(v, type(dv)):
                    self.plotcfg[k] = v
        except Exception as e:
            self.statusBar().showMessage(f"Project load error: {e}")
            return
        self._apply_cfg_widgets()
        self._rebuild_trace_list(select=0 if self.traces else -1)
        self.redraw()
        msg = (f"Project loaded: {len(self.traces)} trace(s), "
               f"{len(self.dsets)} file(s).")
        if skipped_traces:
            msg += f"  {skipped_traces} stale trace(s) skipped."
        if missing:
            msg += f"  MISSING files skipped: {', '.join(missing)}"
            QtWidgets.QMessageBox.warning(
                self, "Missing files",
                "These data files were not found; their traces were "
                "skipped:\n" + "\n".join(missing))
        self.statusBar().showMessage(msg)

    def closeEvent(self, event):
        for ds in self.dsets.values():
            try:
                ds.close()
            except Exception:
                pass
        super().closeEvent(event)


def main():
    app = QtWidgets.QApplication(sys.argv)
    app.setStyleSheet(STYLESHEET)
    win = ExplorerWindow([p for p in sys.argv[1:] if not p.startswith("-")])
    win.show()
    sys.exit(app.exec_())


if __name__ == "__main__":
    main()
