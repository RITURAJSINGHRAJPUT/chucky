// Merge the two subsets of each font family into one.
//
// Beshak's artwork embeds every family TWICE — once per page — and each copy is subsetted to
// only the glyphs that page happens to use. Both copies keep the ORIGINAL font's glyph
// numbering (verified: every CID the two subsets share decodes to the same character), so the
// union is just "take the richer subset and paste in the outlines it is missing".
//
// This matters because the editor can only ever type characters that exist as outlines. Merging
// takes the bold display face from 34/48 glyphs to their union, and the body face to 51+.
const { ttTables } = require('./lib');

const U16 = (b, o) => b.readUInt16BE(o);
const U32 = (b, o) => b.readUInt32BE(o);

function parse(buf) {
  const T = ttTables(buf);
  const indexToLoc = buf.readInt16BE(T.head.off + 50);
  const numGlyphs = U16(buf, T.maxp.off + 4);
  const loca = [];
  for (let g = 0; g <= numGlyphs; g++) {
    loca.push(indexToLoc === 0 ? U16(buf, T.loca.off + g * 2) * 2 : U32(buf, T.loca.off + g * 4));
  }
  // hmtx: `numberOfHMetrics` {advance, lsb} pairs, then lsb-only entries for the trailing
  // glyphs (which all share the last advance). Both halves matter — dropping the left side
  // bearing shifts every glyph horizontally.
  const numHM = U16(buf, T.hhea.off + 34);
  const adv = [], lsb = [];
  for (let g = 0; g < numGlyphs; g++) {
    if (g < numHM) {
      adv.push(U16(buf, T.hmtx.off + g * 4));
      lsb.push(buf.readInt16BE(T.hmtx.off + g * 4 + 2));
    } else {
      adv.push(U16(buf, T.hmtx.off + (numHM - 1) * 4));
      const o = T.hmtx.off + numHM * 4 + (g - numHM) * 2;
      lsb.push(o + 2 <= T.hmtx.off + T.hmtx.len ? buf.readInt16BE(o) : 0);
    }
  }
  return { buf, T, numGlyphs, loca, adv, lsb, indexToLoc };
}

const glyphBytes = (f, g) => (g + 1 < f.loca.length && f.loca[g + 1] > f.loca[g]
  ? f.buf.slice(f.T.glyf.off + f.loca[g], f.T.glyf.off + f.loca[g + 1]) : Buffer.alloc(0));

// GIDs a composite glyph depends on, so we never copy a composite without its parts.
function componentsOf(bytes) {
  if (bytes.length < 10 || bytes.readInt16BE(0) >= 0) return [];
  const out = [];
  let o = 10;
  for (;;) {
    if (o + 4 > bytes.length) break;
    const flags = bytes.readUInt16BE(o);
    out.push(bytes.readUInt16BE(o + 2));
    o += 4;
    o += (flags & 1) ? 4 : 2;                       // ARG_1_AND_2_ARE_WORDS
    if (flags & 8) o += 2;                          // WE_HAVE_A_SCALE
    else if (flags & 0x40) o += 4;                  // X_AND_Y_SCALE
    else if (flags & 0x80) o += 8;                  // TWO_BY_TWO
    if (!(flags & 0x20)) break;                     // MORE_COMPONENTS
  }
  return out;
}

function checksum(buf) {
  let sum = 0;
  const pad = Buffer.concat([buf, Buffer.alloc((4 - (buf.length % 4)) % 4)]);
  for (let i = 0; i < pad.length; i += 4) sum = (sum + pad.readUInt32BE(i)) >>> 0;
  return sum;
}

// Rebuild a font file from `base`, swapping in new glyf/loca/hmtx/maxp/hhea tables.
function build(base, glyphs, advances, bearings) {
  const numGlyphs = glyphs.length;
  const glyf = [];
  const loca = Buffer.alloc((numGlyphs + 1) * 4);
  let off = 0;
  for (let g = 0; g < numGlyphs; g++) {
    loca.writeUInt32BE(off, g * 4);
    let b = glyphs[g];
    if (b.length % 4) b = Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))]);
    glyf.push(b);
    off += b.length;
  }
  loca.writeUInt32BE(off, numGlyphs * 4);
  const hmtx = Buffer.alloc(numGlyphs * 4);
  for (let g = 0; g < numGlyphs; g++) {
    hmtx.writeUInt16BE(advances[g] & 0xffff, g * 4);
    hmtx.writeInt16BE(bearings[g] | 0, g * 4 + 2);
  }

  const head = Buffer.from(base.buf.slice(base.T.head.off, base.T.head.off + base.T.head.len));
  head.writeInt16BE(1, 50);                 // indexToLocFormat = long
  head.writeUInt32BE(0, 8);                 // checkSumAdjustment
  const maxp = Buffer.from(base.buf.slice(base.T.maxp.off, base.T.maxp.off + base.T.maxp.len));
  maxp.writeUInt16BE(numGlyphs, 4);
  const hhea = Buffer.from(base.buf.slice(base.T.hhea.off, base.T.hhea.off + base.T.hhea.len));
  hhea.writeUInt16BE(numGlyphs, 34);        // numberOfHMetrics

  const tables = {};
  for (const name of Object.keys(base.T)) {
    if (name === 'glyf' || name === 'loca' || name === 'hmtx' || name === 'head' || name === 'maxp' || name === 'hhea') continue;
    tables[name] = base.buf.slice(base.T[name].off, base.T[name].off + base.T[name].len);
  }
  tables.head = head; tables.maxp = maxp; tables.hhea = hhea;
  tables.loca = loca; tables.hmtx = hmtx; tables.glyf = Buffer.concat(glyf);

  const names = Object.keys(tables).sort();
  const n = names.length;
  let sr = 1, es = 0;
  while (sr * 2 <= n) { sr *= 2; es++; }
  const dir = Buffer.alloc(12 + n * 16);
  dir.writeUInt32BE(0x00010000, 0);
  dir.writeUInt16BE(n, 4);
  dir.writeUInt16BE(sr * 16, 6);
  dir.writeUInt16BE(es, 8);
  dir.writeUInt16BE(n * 16 - sr * 16, 10);
  let pos = dir.length;
  const bodies = [];
  names.forEach((name, i) => {
    let b = tables[name];
    const rec = 12 + i * 16;
    dir.write(name.padEnd(4), rec, 4, 'latin1');
    dir.writeUInt32BE(checksum(b), rec + 4);
    dir.writeUInt32BE(pos, rec + 8);
    dir.writeUInt32BE(b.length, rec + 12);
    const padded = b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))]) : b;
    bodies.push(padded);
    pos += padded.length;
  });
  return Buffer.concat([dir, ...bodies]);
}

/**
 * Merge two subsets of the same font. Returns { ttf, gids } where gids is the set of GIDs
 * that now have real outlines.
 */
function mergeSubsets(bufA, bufB) {
  const A = parse(bufA), B = parse(bufB);
  const base = A.numGlyphs >= B.numGlyphs ? A : B;
  const other = base === A ? B : A;
  const numGlyphs = Math.max(A.numGlyphs, B.numGlyphs);

  const glyphs = [], advances = [], bearings = [];
  const gids = new Set();
  for (let g = 0; g < numGlyphs; g++) {
    let bytes = g < base.numGlyphs ? glyphBytes(base, g) : Buffer.alloc(0);
    let adv = g < base.numGlyphs ? base.adv[g] : 0;
    let lsb = g < base.numGlyphs ? base.lsb[g] : 0;
    if (!bytes.length && g < other.numGlyphs) {
      const ob = glyphBytes(other, g);
      if (ob.length) { bytes = ob; adv = other.adv[g]; lsb = other.lsb[g]; }
    }
    if (bytes.length) gids.add(g);
    glyphs.push(bytes);
    advances.push(adv);
    bearings.push(lsb);
  }
  // A composite pulled in from `other` may reference parts that only exist there too.
  let changed = true;
  while (changed) {
    changed = false;
    for (const g of [...gids]) {
      for (const c of componentsOf(glyphs[g])) {
        if (c < numGlyphs && !glyphs[c].length) {
          const from = glyphBytes(base, c).length ? base : other;
          const b = glyphBytes(from, c);
          if (b.length) { glyphs[c] = b; advances[c] = from.adv[c]; bearings[c] = from.lsb[c]; gids.add(c); changed = true; }
        }
      }
    }
  }
  return { ttf: build(base, glyphs, advances, bearings), gids, numGlyphs, unitsPerEm: U16(base.buf, base.T.head.off + 18) };
}

module.exports = { mergeSubsets, parse, glyphBytes };
