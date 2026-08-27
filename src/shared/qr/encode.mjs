// encode.mjs — QR code matrix generator per ISO/IEC 18004.
// BYTE mode only, versions 1..10, EC levels L/M/Q/H. Dependency-free ES module.
//
//   qrEncode(payload, { ecLevel: 'M', version: null /* auto-min */, mask: null /* auto */ })
//     -> { version, ecLevel, mask, size, matrix: Uint8Array(size*size) /* row-major 0/1 */,
//          toString() /* '##'/'  ' ASCII art */ }
//
// Also exports the internals the test suite re-derives placement from:
//   buildCodewords(bytes, version, ecLevel)  — final interleaved data+EC codeword sequence
//   functionModules(version)                 — { size, base, isFunc } function-pattern plane
//   placementOrder(version)                  — [row, col] pairs in zigzag placement order
//   formatBits(ecLevel, mask), versionBits(version), MASKS, EC_PARAMS, TOTAL_CODEWORDS

import { rsEncode } from './gf.mjs';

// ---------------------------------------------------------------------------
// Capacity tables (ISO/IEC 18004 Table 9), versions 1..10.
// EC_PARAMS[level][version] = [ecPerBlock, g1Blocks, g1DataCW, g2Blocks, g2DataCW]
// ---------------------------------------------------------------------------

export const TOTAL_CODEWORDS = [, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346];

export const EC_PARAMS = {
  L: [, [7, 1, 19, 0, 0], [10, 1, 34, 0, 0], [15, 1, 55, 0, 0], [20, 1, 80, 0, 0],
       [26, 1, 108, 0, 0], [18, 2, 68, 0, 0], [20, 2, 78, 0, 0], [24, 2, 97, 0, 0],
       [30, 2, 116, 0, 0], [18, 2, 68, 2, 69]],
  M: [, [10, 1, 16, 0, 0], [16, 1, 28, 0, 0], [26, 1, 44, 0, 0], [18, 2, 32, 0, 0],
       [24, 2, 43, 0, 0], [16, 4, 27, 0, 0], [18, 4, 31, 0, 0], [22, 2, 38, 2, 39],
       [22, 3, 36, 2, 37], [26, 4, 43, 1, 44]],
  Q: [, [13, 1, 13, 0, 0], [22, 1, 22, 0, 0], [18, 2, 17, 0, 0], [26, 2, 24, 0, 0],
       [18, 2, 15, 2, 16], [24, 4, 19, 0, 0], [18, 2, 14, 4, 15], [22, 4, 18, 2, 19],
       [20, 4, 16, 4, 17], [24, 6, 19, 2, 20]],
  H: [, [17, 1, 9, 0, 0], [28, 1, 16, 0, 0], [22, 2, 13, 0, 0], [16, 4, 9, 0, 0],
       [22, 2, 11, 2, 12], [28, 4, 15, 0, 0], [26, 4, 13, 1, 14], [26, 4, 14, 2, 15],
       [24, 4, 12, 4, 13], [28, 6, 15, 2, 16]],
};

// Module-load self-check: every row must account for the version's total codewords.
for (const lvl of Object.keys(EC_PARAMS)) {
  for (let v = 1; v <= 10; v++) {
    const [ec, g1, d1, g2, d2] = EC_PARAMS[lvl][v];
    if (ec * (g1 + g2) + g1 * d1 + g2 * d2 !== TOTAL_CODEWORDS[v]) {
      throw new Error(`EC_PARAMS inconsistent at ${v}-${lvl}`);
    }
  }
}

// Alignment pattern centre coordinates per version (Table E.1).
const ALIGN = [, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
               [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

// EC level indicator bits for the format information.
const EC_BITS = { L: 1, M: 0, Q: 3, H: 2 };

// The 8 data mask predicates (r = row, c = column); true = flip the module.
export const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r, c) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

// ---------------------------------------------------------------------------
// Format / version information (BCH-protected)
// ---------------------------------------------------------------------------

// 15-bit format info: 5 data bits (2 EC level + 3 mask) + BCH(15,5) remainder
// (generator 0x537), the whole thing XORed with 0x5412.
export function formatBits(ecLevel, mask) {
  const data = (EC_BITS[ecLevel] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

// 18-bit version info (v >= 7): 6 data bits + 12-bit BCH remainder (generator 0x1F25).
export function versionBits(version) {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
  return (version << 12) | rem;
}

// ---------------------------------------------------------------------------
// Data encoding — BYTE mode bit stream, padding, block split, RS, interleave
// ---------------------------------------------------------------------------

function dataCapacityCodewords(version, ecLevel) {
  const [, g1, d1, g2, d2] = EC_PARAMS[ecLevel][version];
  return g1 * d1 + g2 * d2;
}

function charCountBits(version) {
  return version <= 9 ? 8 : 16; // BYTE mode: 8 bits v1-9, 16 bits v10+
}

// Final interleaved codeword sequence (data blocks column-wise, then EC blocks
// column-wise) for a BYTE-mode payload.
export function buildCodewords(bytes, version, ecLevel) {
  const [ec, g1, d1, g2, d2] = EC_PARAMS[ecLevel][version];
  const dataCW = g1 * d1 + g2 * d2;
  const ccBits = charCountBits(version);

  const bits = [];
  const push = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  push(0b0100, 4);              // mode indicator: BYTE
  push(bytes.length, ccBits);   // character count
  for (const b of bytes) push(b, 8);
  if (bits.length > dataCW * 8) {
    throw new Error(`payload (${bytes.length} bytes) does not fit version ${version}-${ecLevel}`);
  }
  push(0, Math.min(4, dataCW * 8 - bits.length)); // terminator (possibly shortened)
  while (bits.length % 8 !== 0) bits.push(0);     // pad to codeword boundary

  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    data.push(b);
  }
  for (let alt = 0; data.length < dataCW; alt ^= 1) data.push(alt ? 0x11 : 0xec);

  // Split into blocks (group 1 then group 2), RS-encode each.
  const blocks = [];
  let off = 0;
  for (let i = 0; i < g1; i++) { blocks.push(data.slice(off, off + d1)); off += d1; }
  for (let i = 0; i < g2; i++) { blocks.push(data.slice(off, off + d2)); off += d2; }
  const ecBlocks = blocks.map(b => rsEncode(Uint8Array.from(b), ec));

  // Interleave: i-th data codeword of every block, then i-th EC codeword of every block.
  const out = [];
  const maxD = Math.max(d1, d2);
  for (let i = 0; i < maxD; i++) for (const b of blocks) if (i < b.length) out.push(b[i]);
  for (let i = 0; i < ec; i++) for (const b of ecBlocks) out.push(b[i]);
  return Uint8Array.from(out);
}

// ---------------------------------------------------------------------------
// Function patterns
// ---------------------------------------------------------------------------

// Build the function-pattern plane for a version: finders + separators, timing,
// alignment patterns, dark module, version info (v >= 7), and reservations for
// the format info (drawn per-mask later). Returns { size, base, isFunc }.
export function functionModules(version) {
  const size = 17 + 4 * version;
  const base = new Uint8Array(size * size);
  const isFunc = new Uint8Array(size * size);
  const set = (r, c, v) => { base[r * size + c] = v ? 1 : 0; isFunc[r * size + c] = 1; };

  // Timing patterns (row 6 and column 6): dark at even coordinates.
  for (let i = 8; i < size - 8; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }

  // Finder patterns with their light separators (drawn as a 9x9 clipped block).
  const finder = (fr, fc) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const r = fr + dr, c = fc + dc;
        if (r < 0 || r >= size || c < 0 || c >= size) continue;
        const ring = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6 &&
                     (dr === 0 || dr === 6 || dc === 0 || dc === 6);
        const core = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        set(r, c, ring || core);
      }
    }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);

  // Alignment patterns: 5x5 at every centre pair except the three finder corners.
  const centers = ALIGN[version];
  const last = centers.length ? centers[centers.length - 1] : -1;
  for (const cr of centers) {
    for (const cc of centers) {
      if ((cr === 6 && cc === 6) || (cr === 6 && cc === last) || (cr === last && cc === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          set(cr + dr, cc + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
        }
      }
    }
  }

  // Reserve the format info modules (both copies); actual bits depend on the mask.
  for (let i = 0; i <= 8; i++) {
    if (i === 6) continue; // timing modules keep their pattern
    set(8, i, 0);
    set(i, 8, 0);
  }
  for (let i = 0; i < 8; i++) {
    set(8, size - 1 - i, 0);
    set(size - 1 - i, 8, 0);
  }

  // Version information, v >= 7: 6x3 top-right and 3x6 bottom-left.
  if (version >= 7) {
    const vb = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const bit = (vb >>> i) & 1;
      const longC = size - 11 + (i % 3); // size-11 .. size-9
      const shortC = Math.floor(i / 3);  // 0 .. 5
      set(shortC, longC, bit); // top-right block
      set(longC, shortC, bit); // bottom-left block
    }
  }

  // Dark module — always dark, at (4*version + 9, 8) = (size-8, 8).
  set(size - 8, 8, 1);

  return { size, base, isFunc };
}

// Zigzag placement order over the non-function modules: column pairs from the
// right edge leftwards (skipping timing column 6), alternating up/down.
function orderFrom(size, isFunc) {
  const order = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = ((right + 1) & 2) === 0;
    for (let vert = 0; vert < size; vert++) {
      const row = upward ? size - 1 - vert : vert;
      for (let j = 0; j < 2; j++) {
        const col = right - j;
        if (!isFunc[row * size + col]) order.push([row, col]);
      }
    }
  }
  return order;
}

export function placementOrder(version) {
  const { size, isFunc } = functionModules(version);
  return orderFrom(size, isFunc);
}

// Draw the 15 format bits into both of their homes. Bit i means (bits >>> i) & 1.
function drawFormat(m, size, bits) {
  const b = i => (bits >>> i) & 1;
  // Copy 1, around the top-left finder.
  for (let i = 0; i <= 5; i++) m[i * size + 8] = b(i);
  m[7 * size + 8] = b(6);
  m[8 * size + 8] = b(7);
  m[8 * size + 7] = b(8);
  for (let i = 9; i <= 14; i++) m[8 * size + (14 - i)] = b(i);
  // Copy 2, split under the top-right and beside the bottom-left finders.
  for (let i = 0; i <= 7; i++) m[8 * size + (size - 1 - i)] = b(i);
  for (let i = 8; i <= 14; i++) m[(size - 15 + i) * size + 8] = b(i);
}

// ---------------------------------------------------------------------------
// Mask evaluation — the four penalty rules (N1=3, N2=3, N3=40, N4=10)
// ---------------------------------------------------------------------------

function penaltyScore(m, size) {
  let score = 0;

  // N1: runs of >= 5 same-coloured modules in a row/column: 3 + (len - 5).
  for (let axis = 0; axis < 2; axis++) {
    for (let a = 0; a < size; a++) {
      let runVal = -1, runLen = 0;
      for (let b = 0; b < size; b++) {
        const v = axis === 0 ? m[a * size + b] : m[b * size + a];
        if (v === runVal) runLen++;
        else {
          if (runLen >= 5) score += 3 + runLen - 5;
          runVal = v;
          runLen = 1;
        }
      }
      if (runLen >= 5) score += 3 + runLen - 5;
    }
  }

  // N2: every 2x2 block of a single colour: +3.
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = m[r * size + c];
      if (v === m[r * size + c + 1] && v === m[(r + 1) * size + c] && v === m[(r + 1) * size + c + 1]) {
        score += 3;
      }
    }
  }

  // N3: finder-like pattern 1011101 with 0000 on either side, rows and columns: +40.
  for (let axis = 0; axis < 2; axis++) {
    for (let a = 0; a < size; a++) {
      let w = 0;
      for (let b = 0; b < size; b++) {
        w = ((w << 1) | (axis === 0 ? m[a * size + b] : m[b * size + a])) & 0x7ff;
        if (b >= 10 && (w === 0b10111010000 || w === 0b00001011101)) score += 40;
      }
    }
  }

  // N4: 10 points per 5% that the dark-module proportion deviates from 50%.
  let dark = 0;
  for (let i = 0; i < m.length; i++) dark += m[i];
  score += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;

  return score;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export function qrEncode(payload, { ecLevel = 'M', version = null, mask = null } = {}) {
  if (!EC_PARAMS[ecLevel]) throw new Error(`unknown EC level ${JSON.stringify(ecLevel)}`);
  if (mask !== null && (!Number.isInteger(mask) || mask < 0 || mask > 7)) {
    throw new Error(`mask must be null or an integer 0..7, got ${mask}`);
  }
  const bytes = typeof payload === 'string'
    ? new TextEncoder().encode(payload)
    : Uint8Array.from(payload);

  const fits = v => 4 + charCountBits(v) + 8 * bytes.length <= 8 * dataCapacityCodewords(v, ecLevel);
  let v = version;
  if (v == null) {
    for (v = 1; v <= 10 && !fits(v); v++);
    if (v > 10) throw new Error(`payload (${bytes.length} bytes) exceeds version 10-${ecLevel} capacity`);
  } else {
    if (!Number.isInteger(v) || v < 1 || v > 10) throw new Error(`version must be 1..10, got ${v}`);
    if (!fits(v)) throw new Error(`payload (${bytes.length} bytes) does not fit version ${v}-${ecLevel}`);
  }

  const codewords = buildCodewords(bytes, v, ecLevel);
  const { size, base, isFunc } = functionModules(v);
  const order = orderFrom(size, isFunc);
  const totalBits = codewords.length * 8;

  const render = mk => {
    const m = base.slice();
    const maskFn = MASKS[mk];
    for (let i = 0; i < order.length; i++) {
      const [r, c] = order[i];
      const bit = i < totalBits ? (codewords[i >> 3] >>> (7 - (i & 7))) & 1 : 0; // remainder bits are 0
      m[r * size + c] = bit ^ (maskFn(r, c) ? 1 : 0);
    }
    drawFormat(m, size, formatBits(ecLevel, mk));
    return m;
  };

  let chosenMask = mask;
  let matrix;
  if (mask === null) {
    let best = Infinity;
    for (let mk = 0; mk < 8; mk++) {
      const m = render(mk);
      const p = penaltyScore(m, size);
      if (p < best) { best = p; chosenMask = mk; matrix = m; }
    }
  } else {
    matrix = render(mask);
  }

  return {
    version: v,
    ecLevel,
    mask: chosenMask,
    size,
    matrix,
    toString() {
      const rows = [];
      for (let r = 0; r < size; r++) {
        let line = '';
        for (let c = 0; c < size; c++) line += matrix[r * size + c] ? '##' : '  ';
        rows.push(line);
      }
      return rows.join('\n');
    },
  };
}
