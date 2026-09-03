// Trace an inked shape out of a rendered region into PDF path ops.
//
// Page 1's dairy/gluten/sesame markers are not vectors — they are baked into the page's
// background raster (verified by blanking the image: only the Jain "J" survives). To let the
// editor add and remove them there, we need them AS PATHS. So: rasterise the icon on its own at
// a very high resolution, walk the ink boundary, simplify, and emit a polygon. At the 8pt size
// these render, a boundary simplified to a hundredth of a point is indistinguishable.
const fs = require('fs');

/**
 * Ink COVERAGE field of a PDF region (0 = paper, 1 = full ink), one sample per device pixel.
 * The icons we have to trace live in a ~305dpi background raster, so their true edges are the
 * antialiased ramp between paper and ink. Thresholding that ramp throws the sub-pixel edge
 * position away and leaves a staircase; keeping the coverage lets us cut the boundary at 50%
 * with interpolation and recover a smooth outline.
 */
async function inkField(src, { page, x0, yTop, x1, yBot, dpi = 1200 }) {
  const mupdf = await import('mupdf');
  const doc = mupdf.Document.openDocument(fs.readFileSync(src), 'application/pdf');
  const pg = doc.loadPage(page);
  const H = pg.getBounds()[3];
  const s = dpi / 72;
  const rect = [x0 * s, (H - yTop) * s, x1 * s, (H - yBot) * s].map(Math.round);
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, rect, false);
  pix.clear(255);
  const dev = new mupdf.DrawDevice(mupdf.Matrix.scale(s, s), pix);
  pg.run(dev, mupdf.Matrix.identity);
  dev.close();
  const px = pix.getPixels(), w = pix.getWidth(), h = pix.getHeight(), st = pix.getNumberOfComponents();
  const f = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    // the artwork is one flat red on white, so darkness of the lightest channel tracks coverage
    f[i] = 1 - Math.min(px[i * st], px[i * st + 1], px[i * st + 2]) / 255;
  }
  return { f, w, h, scale: s, x0, yTop };
}

/** Ink mask of a PDF region. Returns { w, h, at(x,y), x0, yTop, scale } in device pixels. */
async function inkMask(src, { page, x0, yTop, x1, yBot, dpi = 2400, threshold = 128 }) {
  const mupdf = await import('mupdf');
  const doc = mupdf.Document.openDocument(fs.readFileSync(src), 'application/pdf');
  const pg = doc.loadPage(page);
  const H = pg.getBounds()[3];
  const s = dpi / 72;
  const rect = [x0 * s, (H - yTop) * s, x1 * s, (H - yBot) * s].map(Math.round);
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, rect, false);
  pix.clear(255);
  const dev = new mupdf.DrawDevice(mupdf.Matrix.scale(s, s), pix);
  pg.run(dev, mupdf.Matrix.identity);
  dev.close();
  const px = pix.getPixels(), w = pix.getWidth(), h = pix.getHeight(), st = pix.getNumberOfComponents();
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    // ink = anything meaningfully darker than paper on any channel
    const r = px[i * st], g = px[i * st + 1], b = px[i * st + 2];
    mask[i] = (Math.min(r, g, b) < threshold || (r - b) > 60) ? 1 : 0;
  }
  return { mask, w, h, scale: s, x0, yTop };
}

/** Connected ink components (4-neighbour), largest first. */
function components(M) {
  const { mask, w, h } = M;
  const lab = new Int32Array(w * h).fill(-1);
  const out = [];
  const stack = [];
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || lab[i] >= 0) continue;
    const id = out.length;
    let minx = w, miny = h, maxx = -1, maxy = -1, n = 0;
    stack.push(i); lab[i] = id;
    while (stack.length) {
      const p = stack.pop();
      const x = p % w, y = (p - x) / w;
      n++;
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (y < miny) miny = y; if (y > maxy) maxy = y;
      const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1];
      for (const q of nb) if (q >= 0 && mask[q] && lab[q] < 0) { lab[q] = id; stack.push(q); }
    }
    out.push({ id, minx, miny, maxx, maxy, n });
  }
  return out.sort((a, b) => b.n - a.n);
}

// ---- boundary extraction ----
// Every ink pixel contributes a directed edge along each side whose neighbour is blank, oriented
// so the ink is always on the walker's right. Chaining those edges head-to-tail therefore yields
// closed loops whose winding already distinguishes outlines from holes — which is exactly what a
// nonzero-winding `f` needs, so the traced icon fills with the right holes and no extra work.
function contours(mask, w, h) {
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h) ? 0 : mask[y * w + x];
  const next = new Map();          // "x,y" -> [to, ...]
  const push = (ax, ay, bx, by) => {
    const k = ax + ',' + ay;
    const arr = next.get(k);
    if (arr) arr.push([bx, by]); else next.set(k, [[bx, by]]);
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!at(x, y)) continue;
      if (!at(x, y - 1)) push(x, y, x + 1, y);
      if (!at(x + 1, y)) push(x + 1, y, x + 1, y + 1);
      if (!at(x, y + 1)) push(x + 1, y + 1, x, y + 1);
      if (!at(x - 1, y)) push(x, y + 1, x, y);
    }
  }
  const loops = [];
  for (const startKey of [...next.keys()]) {
    for (;;) {
      const seed = next.get(startKey);
      if (!seed || !seed.length) break;
      const [sx, sy] = startKey.split(',').map(Number);
      const pts = [[sx, sy]];
      let [cx, cy] = seed.shift();
      let guard = 0;
      while (!(cx === sx && cy === sy) && ++guard < 8 * w * h) {
        pts.push([cx, cy]);
        const arr = next.get(cx + ',' + cy);
        if (!arr || !arr.length) break;
        [cx, cy] = arr.shift();
      }
      if (pts.length > 7) loops.push(pts);
    }
  }
  return loops;
}

/**
 * Chaikin corner-cutting on a closed polygon. A pixel-boundary walk is a staircase; cutting its
 * corners turns those steps back into the smooth curve the artwork actually has. One pass at
 * trace resolution rounds by well under a hundredth of a point, so real corners survive.
 */
function smooth(pts, iters = 2) {
  let cur = pts;
  for (let it = 0; it < iters; it++) {
    const out = [];
    for (let i = 0; i < cur.length; i++) {
      const a = cur[i], b = cur[(i + 1) % cur.length];
      out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
      out.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    cur = out;
  }
  return cur;
}

/** Douglas-Peucker on a closed polygon. */
function simplify(pts, tol) {
  const d2 = (p, a, b) => {
    const vx = b[0] - a[0], vy = b[1] - a[1];
    const L = vx * vx + vy * vy;
    let t = L ? ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / L : 0;
    t = Math.max(0, Math.min(1, t));
    const dx = p[0] - (a[0] + t * vx), dy = p[1] - (a[1] + t * vy);
    return dx * dx + dy * dy;
  };
  const rec = (s, e, keep) => {
    let idx = -1, best = tol * tol;
    for (let i = s + 1; i < e; i++) { const d = d2(pts[i], pts[s], pts[e]); if (d > best) { best = d; idx = i; } }
    if (idx < 0) return;
    rec(s, idx, keep); keep.add(idx); rec(idx, e, keep);
  };
  const keep = new Set([0, pts.length - 1]);
  rec(0, pts.length - 1, keep);
  return [...keep].sort((a, b) => a - b).map((i) => pts[i]);
}

// ---- marching squares on the coverage field, with linear interpolation ----
// Segment endpoints land where coverage crosses `iso`, so the outline follows the antialiased
// edge rather than the pixel grid. Segments are emitted with ink on a consistent side, which
// makes outer loops and holes wind oppositely — what a nonzero-winding `f` needs to punch the
// holes out of the milk bottle and the grains out of the wheat ear.
const MS_EDGES = {
  1: [['D', 'A']], 2: [['A', 'B']], 3: [['D', 'B']], 4: [['B', 'C']],
  6: [['A', 'C']], 7: [['D', 'C']], 8: [['C', 'D']], 9: [['C', 'A']],
  11: [['C', 'B']], 12: [['B', 'D']], 13: [['B', 'A']], 14: [['A', 'D']],
};

function isoContours(F, iso = 0.5) {
  const { f, w, h } = F;
  const at = (x, y) => f[y * w + x];
  const segs = [];
  const cut = (a, b) => (iso - a) / (b - a);
  for (let y = 0; y + 1 < h; y++) {
    for (let x = 0; x + 1 < w; x++) {
      const v00 = at(x, y), v10 = at(x + 1, y), v11 = at(x + 1, y + 1), v01 = at(x, y + 1);
      let c = (v00 > iso ? 1 : 0) | (v10 > iso ? 2 : 0) | (v11 > iso ? 4 : 0) | (v01 > iso ? 8 : 0);
      if (c === 0 || c === 15) continue;
      const pt = {
        A: [x + cut(v00, v10), y],
        B: [x + 1, y + cut(v10, v11)],
        C: [x + cut(v01, v11), y + 1],
        D: [x, y + cut(v00, v01)],
      };
      let pairs;
      if (c === 5 || c === 10) {
        // saddle: let the cell average decide which way the two strands connect
        const mid = (v00 + v10 + v11 + v01) / 4 > iso;
        pairs = c === 5 ? (mid ? [['D', 'C'], ['B', 'A']] : [['D', 'A'], ['B', 'C']])
          : (mid ? [['A', 'B'], ['C', 'D']] : [['A', 'D'], ['C', 'B']]);
      } else pairs = MS_EDGES[c];
      for (const [a, b] of pairs) segs.push([pt[a], pt[b]]);
    }
  }
  // chain segments head-to-tail into closed loops
  const key = (p) => `${Math.round(p[0] * 512)},${Math.round(p[1] * 512)}`;
  const from = new Map();
  for (const s of segs) {
    const k = key(s[0]);
    const arr = from.get(k);
    if (arr) arr.push(s); else from.set(k, [s]);
  }
  const loops = [];
  for (const k0 of [...from.keys()]) {
    for (;;) {
      const bucket = from.get(k0);
      if (!bucket || !bucket.length) break;
      let seg = bucket.shift();
      const pts = [seg[0]];
      let guard = 0;
      while (seg && ++guard < segs.length + 8) {
        pts.push(seg[1]);
        if (key(seg[1]) === k0) break;
        const nb = from.get(key(seg[1]));
        if (!nb || !nb.length) break;
        seg = nb.shift();
      }
      if (pts.length > 4) loops.push(pts);
    }
  }
  return loops;
}

/**
 * Trace one icon into an origin-relative PDF path body in artwork units (0.1pt).
 * `tolPt` is the simplification tolerance in POINTS.
 */
async function traceIcon(src, region, { tolPt = 0.012, minPoints = 8 } = {}) {
  const F = await inkField(src, region);
  const loops = isoContours(F, 0.5);
  const tolPx = tolPt * (region.dpi || 1200) / 72;
  const r = (v) => Math.round(v * 100) / 100;
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  const polys = [];
  for (const loop of loops) {
    const simp = simplify(loop, tolPx);
    if (simp.length < minPoints) continue;
    const pts = simp.map(([px, py]) => {
      const ax = (region.x0 + px / F.scale) * 10;
      const ay = (region.yTop - py / F.scale) * 10;
      if (ax < minx) minx = ax; if (ax > maxx) maxx = ax;
      if (ay < miny) miny = ay; if (ay > maxy) maxy = ay;
      return [ax, ay];
    });
    polys.push(pts);
  }
  if (!polys.length) return null;
  const body = polys.map((pts) => pts.map(([x, y], i) => `${r(x - minx)} ${r(y - miny)} ${i ? 'l' : 'm'}`).join('\n') + '\nh').join('\n');
  return { body, w: r(maxx - minx), h: r(maxy - miny), loops: polys.length };
}

module.exports = { inkMask, inkField, components, contours, isoContours, simplify, smooth, traceIcon };
