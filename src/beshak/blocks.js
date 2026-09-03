// Split a main artwork stream into TOP-LEVEL q..Q blocks (plus the stray ops between them)
// and compute each block's geometric bounding box from its path/text coordinates.
//
// Marker icons come in two flavours in this artwork: some are `q <outline> W n /RNNN Do Q`
// (the outline clips a painted XObject), others are plain filled paths. Bounding every
// top-level block catches both, and the bbox size is what tells dairy from gluten from jain.
const { tokenize } = require('./lib');

// Operators whose trailing numeric operands are coordinates in user space.
const COORD_OPS = { m: 2, l: 2, c: 6, v: 4, y: 4, re: 4 };

function topLevelBlocks(s) {
  const isTok = (i, ch) => s[i] === ch && (i === 0 || /[\s\]>)]/.test(s[i - 1])) && (i + 1 >= s.length || /[\s\n\r]/.test(s[i + 1] || ' '));
  const blocks = [];
  let depth = 0, start = -1;
  for (let i = 0; i < s.length; i++) {
    if (isTok(i, 'q')) { if (depth === 0) start = i; depth++; }
    else if (isTok(i, 'Q')) { depth--; if (depth === 0 && start >= 0) { blocks.push([start, i + 1]); start = -1; } if (depth < 0) depth = 0; }
  }
  return blocks;
}

// Bounding box of the drawing ops inside a chunk of content stream.
function bboxOf(chunk) {
  const toks = tokenize(chunk);
  let nums = [];
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  let n = 0;
  const add = (x, y) => { if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y; n++; };
  for (const tk of toks) {
    if (tk.t === 'num') { nums.push(tk.v); continue; }
    if (tk.t !== 'op') { nums = []; continue; }
    const need = COORD_OPS[tk.v];
    if (need && nums.length >= need) {
      const a = nums.slice(-need);
      if (tk.v === 're') { add(a[0], a[1]); add(a[0] + a[2], a[1] + a[3]); }
      else for (let i = 0; i + 1 < a.length; i += 2) add(a[i], a[i + 1]);
    }
    nums = [];
  }
  if (!n) return null;
  return { x: minx, y: miny, w: maxx - minx, h: maxy - miny };
}

// Does this block paint (rather than only clip)? Icons that are plain fills end in f/f*/B.
function paintKind(chunk) {
  const has = (re) => re.test(chunk);
  if (/\/R\d+\s+Do/.test(chunk)) return 'do';
  if (has(/(^|[\s\n])f\*?[\s\n]/)) return 'fill';
  if (has(/(^|[\s\n])S[\s\n]/)) return 'stroke';
  return 'other';
}

module.exports = { topLevelBlocks, bboxOf, paintKind };
