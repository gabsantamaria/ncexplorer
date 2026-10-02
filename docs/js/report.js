// report.js — the two "Report" dialogs: a multi-page vector PDF of the selected
// tabs made right here (Plotly → SVG → jsPDF, one page per tab), and a
// standalone Python script (pyexport.js) that regenerates the same pages —
// derived quantities included — as a multi-page vector PDF with matplotlib.

import { h, modal } from "./ui.js";

export function openReportDialog(ctx, kind) {
  const { state } = ctx;
  const isPy = kind === "python";
  const rows = state.tabs.map((tb, i) => {
    const n = tb.traces.filter((t) => t.visible !== false).length;
    return { i, tb, n };
  });
  const checks = [];
  const pick = h("div", { class: "tab-pick" });
  for (const r of rows) {
    const cb = h("input", { type: "checkbox" });
    cb.checked = r.n > 0;
    cb.disabled = r.n === 0;
    cb.onchange = updateState;
    checks.push({ cb, i: r.i });
    const meta = r.n ? `${r.n} trace${r.n === 1 ? "" : "s"}` + (r.tb.plotcfg.lock_size ? ` · ${r.tb.plotcfg.figw}×${r.tb.plotcfg.figh} in` : "")
      : "empty";
    pick.appendChild(h("label", { title: r.n ? "" : "nothing plotted in this tab" }, cb,
      h("span", { text: r.tb.name + (r.i === state.active ? "  (active)" : "") }), h("span", { class: "tp-meta", text: meta })));
  }
  const all = h("button", { class: "link", text: "all", onclick: () => { checks.forEach((c) => { if (!c.cb.disabled) c.cb.checked = true; }); updateState(); } });
  const none = h("button", { class: "link", text: "none", onclick: () => { checks.forEach((c) => { c.cb.checked = false; }); updateState(); } });
  const only = h("button", { class: "link", text: "active only", onclick: () => { checks.forEach((c) => { c.cb.checked = c.i === state.active && !c.cb.disabled; }); updateState(); } });

  const stamp = ctx.stamp();
  const nameInp = h("input", { type: "text", value: isPy ? "ncx_report.pdf" : `ncx_report_${stamp}.pdf` });
  const info = h("div", { class: "hint" });
  const body = h("div", {},
    h("p", { class: "hint", html: isPy
      ? "Downloads a standalone <b>Python script</b> that rebuilds the selected tabs — data slicing, derived quantities "
        + "and cosmetics — as a <b>multi-page vector PDF</b> (one page per tab) with matplotlib. It is commented so you "
        + "can edit it as a starting point for custom processing."
      : "Creates one <b>vector PDF</b> with a page per selected tab, each at its own size (locked size, or the current "
        + "plot size)." }),
    h("div", { class: "tab-pick-acts" }, h("b", { text: "Tabs" }), all, none, only),
    pick,
    h("div", { class: "form-grid" }, h("label", { text: isPy ? "PDF the script writes" : "File name" }), nameInp),
    info);

  let pyBox = null;
  if (isPy) {
    pyBox = h("pre", { class: "code" });
    body.appendChild(h("h4", { text: "How to run it" }));
    body.appendChild(pyBox);
    body.appendChild(h("p", { class: "hint", html: "Requires <code>numpy</code>, <code>xarray</code>, <code>matplotlib</code>, plus "
      + "<code>scipy</code> for NetCDF-3 files and <code>h5netcdf</code> (or <code>netCDF4</code>) for NetCDF-4/HDF5 files. "
      + "Put the script next to the .nc files, or pass <code>--data-dir</code>. "
      + "Options: <code>--out</code>, <code>--png</code>/<code>--svg</code> (one image per page), <code>--dpi</code>." }));
  }

  function selected() { return checks.filter((c) => c.cb.checked).map((c) => c.i); }
  function neededFiles(idx) {
    const files = new Set();
    for (const i of idx) for (const t of state.tabs[i].traces) if (t.visible !== false) files.add(t.file);
    return [...files];
  }
  function updateState() {
    const idx = selected();
    const files = neededFiles(idx);
    const miss = new Set(ctx.missingFiles().map((f) => f.toLowerCase()));
    const missing = files.filter((f) => miss.has(f.toLowerCase()));
    info.textContent = idx.length
      ? `${idx.length} page(s) · data: ${files.join(", ") || "—"}` + (missing.length && !isPy ? ` · not open (skipped): ${missing.join(", ")}` : "")
      : "Select at least one tab.";
    if (pyBox) pyBox.textContent = `python ${scriptName} --data-dir "path/to/folder/with/the/.nc files"`
      + `\n# writes ${nameInp.value || "ncx_report.pdf"} next to the script (or --out other.pdf)`;
    const b = m.button("go");
    if (b) b.disabled = !idx.length;
  }
  const scriptName = `ncx_report_${stamp}.py`;

  const m = modal({
    title: isPy ? "Python script → multi-page PDF report" : "PDF report of tabs",
    body, enterButton: "go",
    buttons: [
      { spacer: true },
      { label: "Cancel", kind: "ghost", id: "cancel" },
      { label: isPy ? "Download script" : "Create PDF", kind: "primary", id: "go", onClick: async (mctx) => {
        const idx = selected();
        if (!idx.length) return false;
        let name = (nameInp.value || "").trim() || "ncx_report.pdf";
        if (!/\.pdf$/i.test(name)) name += ".pdf";
        name = name.replace(/[\\/:*?"<>|]+/g, "_");
        const btn = mctx.button("go");
        btn.disabled = true;
        try {
          if (isPy) {
            const { buildReportScript } = await import("./pyexport.js");
            const project = ctx.buildProject(state);
            const text = buildReportScript(project, { tabs: idx, pdfName: name,
              generatedAt: new Date().toISOString(), source: "" });
            const blob = new Blob([text], { type: "text/x-python" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url; a.download = scriptName;
            document.body.appendChild(a); a.click();
            setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 0);
            ctx.toast(`Downloaded ${scriptName} (${idx.length} page${idx.length === 1 ? "" : "s"}). Run it next to the .nc files.`, "ok");
            return true;
          }
          btn.textContent = "Rendering…";
          const ok = await ctx.exportReportPDF(idx, name, (msg) => { info.textContent = msg; });
          return ok ? true : (btn.disabled = false, btn.textContent = "Create PDF", false);
        } catch (e) {
          ctx.toast((isPy ? "Could not build the script: " : "PDF report error: ") + e.message, "error");
          btn.disabled = false;
          return false;
        }
      } },
    ],
  });
  nameInp.oninput = updateState;
  updateState();
}
