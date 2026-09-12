// Pull the DAIRY and JAIN marker outlines out of the artwork as reusable, origin-relative
// path templates.
//
// In the source each icon is drawn as:
//     q  <clip rect> re W n   <outline path>   W n   /RNNN Do  Q
// i.e. the outline is used as a CLIP and the XObject fills a rectangle through it. Clipping and
// filling both use the nonzero winding rule, so `<outline path> f` under the brand colour paints
// exactly the same pixels while depending on nothing but itself — which is what lets the engine
// stamp a marker anywhere, on either page.
const { tokenize } = require('./lib');

const BRAND_K = '0.004 0.843 0.851 0.118 k';   // the menu's red, as used by the baked icons
const PATH_OPS = new Set(['m', 'l', 'c', 'v', 'y', 'h', 're']);
const COORD_COUNT = { m: 2, l: 2, c: 6, v: 4, y: 4, re: 4 };

/**
 * Read the outline path out of an icon q..Q block and re-emit it relative to its own
 * bottom-left corner. Returns { body, w, h } with body in the artwork's 0.1pt units.
 */
function templateFromBlock(chunk) {
  const toks = tokenize(chunk);
  // The block holds two `W n` clips: the leading rectangle, then the glyph outline. Take the
  // ops between them -- that run is the outline itself.
  const wIdx = [];
  toks.forEach((t, i) => { if (t.t === 'op' && t.v === 'W') wIdx.push(i); });
  if (wIdx.length < 2) return null;
  const from = wIdx[0] + 2, to = wIdx[1];
  const ops = [];
  let nums = [];
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (let i = from; i < to; i++) {
    const t = toks[i];
    if (t.t === 'num') { nums.push(t.v); continue; }
    if (t.t !== 'op') { nums = []; continue; }
    if (!PATH_OPS.has(t.v)) { nums = []; continue; }
    const need = COORD_COUNT[t.v] || 0;
    const a = need ? nums.slice(-need) : [];
    if (need && a.length < need) { nums = []; continue; }
    ops.push({ op: t.v, a });
    for (let k = 0; k + 1 < a.length; k += 2) {
      if (a[k] < minx) minx = a[k];
      if (a[k] > maxx) maxx = a[k];
      if (a[k + 1] < miny) miny = a[k + 1];
      if (a[k + 1] > maxy) maxy = a[k + 1];
    }
    nums = [];
  }
  if (!ops.length || !isFinite(minx)) return null;
  const r = (v) => Math.round(v * 100) / 100;
  const body = ops.map(({ op, a }) => {
    if (op === 'h') return 'h';
    const out = a.map((v, k) => r(k % 2 === 0 ? v - minx : v - miny));
    return out.join(' ') + ' ' + op;
  }).join('\n');
  return { body, w: r(maxx - minx), h: r(maxy - miny) };
}

/** PDF ops that stamp a template at (x, y) in artwork units. */
function stamp(tpl, x, y) {
  return `q 1 0 0 1 ${Math.round(x * 100) / 100} ${Math.round(y * 100) / 100} cm ${BRAND_K}\n${tpl.body}\nf Q\n`;
}

module.exports = { templateFromBlock, stamp, BRAND_K };
