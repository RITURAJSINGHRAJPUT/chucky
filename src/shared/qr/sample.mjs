// sample.mjs — lift a QR module matrix out of a rendered PDF region.
//
// Renders the region at high dpi, finds the tight ink bbox, then scores candidate module counts
// (21..45 step 4) by finder-pattern + timing-pattern fit and samples each cell at its centre.
// Cells inside an explicit erase rectangle (the menu QRs have carved centres holding a logo)
// come back as -1 so the decoder treats them as erasures.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const fs = require('fs');
const mupdf = await import('mupdf');

export function renderGray(src, page, { x0, x1, yTop, yBot, dpi = 600 }) {
  const doc = mupdf.Document.openDocument(
    src instanceof Uint8Array || Buffer.isBuffer(src) ? new Uint8Array(src) : fs.readFileSync(src), 'application/pdf');
  const pg = doc.loadPage(page);
  const H = pg.getBounds()[3], s = dpi / 72;
  const rect = [x0 * s, (H - yTop) * s, x1 * s, (H - yBot) * s].map(Math.round);
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, rect, false);
  pix.clear(255);
  const dev = new mupdf.DrawDevice(mupdf.Matrix.scale(s, s), pix);
  pg.run(dev, mupdf.Matrix.identity);
  dev.close();
  const W = pix.getWidth(), Hp = pix.getHeight(), px = pix.getPixels(), n = pix.getNumberOfComponents();
  const g = new Uint8Array(W * Hp);
  for (let i = 0; i < W * Hp; i++) g[i] = (px[i * n] + px[i * n + 1] + px[i * n + 2]) / 3;
  return { g, W, H: Hp };
}

function tightBBox(g, W, H, thr = 128) {
  // per-row/column dark counts, then the LARGEST contiguous dark band (>=5 dark px, gaps <=8 px
  // bridged) — stray border hairlines and JPEG edge noise otherwise stretch the box
  const rowC = new Array(H).fill(0), colC = new Array(W).fill(0);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++)
    if (g[y * W + x] < thr) { rowC[y]++; colC[x]++; }
  const band = (counts) => {
    const runs = []; let start = null, gap = 0;
    for (let i = 0; i < counts.length; i++) {
      if (counts[i] >= 5) { if (start == null) start = i; gap = 0; }
      else if (start != null && ++gap > 8) { runs.push([start, i - gap]); start = null; }
    }
    if (start != null) runs.push([start, counts.length - 1 - gap]);
    if (!runs.length) throw new Error('no ink in region');
    return runs.reduce((a, b) => (b[1] - b[0] > a[1] - a[0] ? b : a));
  };
  const [y0, y1] = band(rowC), [x0, x1] = band(colC);
  return { x0, x1, y0, y1 };
}

/** average gray over the centre 40% of a cell */
function cellVal(g, W, bb, size, cx, cy) {
  const mw = (bb.x1 - bb.x0 + 1) / size, mh = (bb.y1 - bb.y0 + 1) / size;
  const px0 = bb.x0 + cx * mw + mw * 0.3, px1 = bb.x0 + cx * mw + mw * 0.7;
  const py0 = bb.y0 + cy * mh + mh * 0.3, py1 = bb.y0 + cy * mh + mh * 0.7;
  let sum = 0, n = 0;
  for (let y = Math.round(py0); y <= Math.round(py1); y++)
    for (let x = Math.round(px0); x <= Math.round(px1); x++) { sum += g[y * W + x]; n++; }
  return sum / Math.max(1, n);
}

function scoreSize(g, W, bb, size) {
  const dark = (x, y) => cellVal(g, W, bb, size, x, y) < 128;
  let score = 0;
  // the three finders: 7x7 ring pattern — check the distinctive cells
  const finder = (fx, fy) => {
    let s = 0;
    for (let i = 0; i < 7; i++) for (let j = 0; j < 7; j++) {
      const edge = i === 0 || i === 6 || j === 0 || j === 6;
      const core = i >= 2 && i <= 4 && j >= 2 && j <= 4;
      const want = edge || core;
      if (dark(fx + j, fy + i) === want) s++;
    }
    return s;
  };
  score += finder(0, 0) + finder(size - 7, 0) + finder(0, size - 7);
  // timing row+col alternate between the finders
  for (let k = 8; k < size - 8; k++) {
    if (dark(k, 6) === (k % 2 === 0)) score++;
    if (dark(6, k) === (k % 2 === 0)) score++;
  }
  return score / (147 + 2 * (size - 16));   // normalised
}

/**
 * @param erase  optional {x0,y0,x1,y1} in MODULE coordinates (inclusive) marked -1
 * @returns { size, matrix: Int8Array, score, bb }
 */
export function sampleQR(src, page, region, { dpi = 600, erase = null, sizes = [21, 25, 29, 33, 37, 41, 45, 49, 53, 57] } = {}) {
  const { g, W, H } = renderGray(src, page, { ...region, dpi });
  const bb = tightBBox(g, W, H);
  let best = null;
  for (const size of sizes) {
    const sc = scoreSize(g, W, bb, size);
    if (!best || sc > best.score) best = { size, score: sc };
  }
  const size = best.size;
  const matrix = new Int8Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (erase && x >= erase.x0 && x <= erase.x1 && y >= erase.y0 && y <= erase.y1) { matrix[y * size + x] = -1; continue; }
    matrix[y * size + x] = cellVal(g, W, bb, size, x, y) < 128 ? 1 : 0;
  }
  return { size, matrix, score: best.score, bb };
}

/** sample a QR from an image file (JPEG/PNG) instead of a PDF region */
export function sampleQRFromImage(imgPath, { erase = null, sizes = [21, 25, 29, 33, 37, 41, 45, 49, 53, 57] } = {}) {
  const img = new mupdf.Image(fs.readFileSync(imgPath));
  const pix = img.toPixmap();
  const W = pix.getWidth(), H = pix.getHeight(), px = pix.getPixels(), n = pix.getNumberOfComponents();
  const g = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) g[i] = n >= 3 ? (px[i * n] + px[i * n + 1] + px[i * n + 2]) / 3 : px[i * n];
  const bb = tightBBox(g, W, H);
  let best = null;
  for (const size of sizes) {
    const sc = scoreSize(g, W, bb, size);
    if (!best || sc > best.score) best = { size, score: sc };
  }
  const size = best.size;
  const matrix = new Int8Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (erase && x >= erase.x0 && x <= erase.x1 && y >= erase.y0 && y <= erase.y1) { matrix[y * size + x] = -1; continue; }
    matrix[y * size + x] = cellVal(g, W, bb, size, x, y) < 128 ? 1 : 0;
  }
  return { size, matrix, score: best.score, bb };
}

export function matrixToAscii(matrix, size) {
  let out = '';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) { const v = matrix[y * size + x]; out += v === 1 ? '##' : v === -1 ? '??' : '  '; }
    out += '\n';
  }
  return out;
}
