// colormaps.js — small self-contained colormaps so rainbow line colors and the
// Plotly colorbar use identical colors (no dependency on Plotly's built-ins).

const MAPS = {
  Viridis: [[68,1,84],[59,82,139],[33,144,140],[93,201,99],[253,231,37]],
  Turbo:   [[48,18,59],[54,148,224],[97,220,90],[248,196,32],[165,14,1]],
  Jet:     [[0,0,131],[0,128,255],[124,255,121],[255,197,0],[128,0,0]],
  Rainbow: [[112,0,255],[0,140,255],[0,255,110],[255,220,0],[255,0,0]],
  CoolWarm:[[59,76,192],[153,180,236],[221,221,221],[229,145,120],[180,4,38]],
  Gray:    [[30,30,30],[110,110,110],[180,180,180],[225,225,225],[250,250,250]],
};
export const CMAP_NAMES = Object.keys(MAPS);

function lerp(a, b, t) { return Math.round(a + (b - a) * t); }

export function cmapColor(name, t) {
  const m = MAPS[name] || MAPS.Viridis;
  if (!Number.isFinite(t)) t = 0;
  t = Math.max(0, Math.min(1, t));
  const seg = (m.length - 1) * t;
  const i = Math.min(Math.floor(seg), m.length - 2);
  const f = seg - i;
  const c = [lerp(m[i][0], m[i + 1][0], f), lerp(m[i][1], m[i + 1][1], f),
             lerp(m[i][2], m[i + 1][2], f)];
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

export function cmapScale(name) {
  const m = MAPS[name] || MAPS.Viridis;
  return m.map((c, i) => [i / (m.length - 1), `rgb(${c[0]},${c[1]},${c[2]})`]);
}
