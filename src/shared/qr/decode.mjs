// decode.mjs — decode a QR MODULE MATRIX (not an image) per ISO/IEC 18004, versions 1..10.
// Dependency-free ES module (Node 18+); Reed-Solomon comes from ./gf.mjs.
//
// Input matrix values: 1 = dark, 0 = light, -1 = unknown/erased. Erased modules are
// propagated as RS erasures (any codeword containing one or more -1 modules is flagged),
// which is what lets the menus' carved-centre QRs decode.
import { rsDecode } from './gf.mjs';

// ---------------------------------------------------------------------------
// Format information (15 bits, two copies)
// ---------------------------------------------------------------------------

const FORMAT_XOR = 0x5412;
// EC-level 2-bit field: M=00 L=01 H=10 Q=11
const EC_LEVELS = ['M', 'L', 'H', 'Q'];
const EC_BITS = { M: 0, L: 1, H: 2, Q: 3 };

// BCH(15,5) with generator g(x) = x^10+x^8+x^5+x^4+x^2+x+1 (0x537).
function bchFormatCodeword(data5) {
  let rem = data5 << 10;
  for (let i = 4; i >= 0; i--) {
    if (rem & (1 << (i + 10))) rem ^= 0x537 << i;
  }
  return ((data5 << 10) | rem) & 0x7fff;
}

// All 32 valid (pre-mask) format codewords, indexed by the 5 data bits.
const FORMAT_CODEWORDS = Array.from({ length: 32 }, (_, d) => bchFormatCodeword(d));

// The masked 15-bit value as it is placed in the matrix.
export function encodeFormat(ecLevel, mask) {
  if (!(ecLevel in EC_BITS)) throw new Error(`bad ec level ${ecLevel}`);
  return bchFormatCodeword((EC_BITS[ecLevel] << 3) | (mask & 7)) ^ FORMAT_XOR;
}

function popcount(x) {
  let n = 0;
  while (x) { x &= x - 1; n++; }
  return n;
}

// bits15: array of 15 entries (0 | 1 | -1), index = bit number (0 = LSB).
// Brute-force nearest valid codeword; erased bits are excluded from the distance.
// Accept when 2*errors + erasures <= 6 (BCH(15,5) has minimum distance 7),
// i.e. up to 3 bit errors on a fully known copy. Returns null when unreadable.
export function decodeFormatValue(bits15) {
  let value = 0;
  let known = 0;
  for (let i = 0; i < 15; i++) {
    if (bits15[i] === -1) continue;
    known |= 1 << i;
    if (bits15[i]) value |= 1 << i;
  }
  const erased = 15 - popcount(known);
  const unmasked = value ^ FORMAT_XOR;
  let best = null;
  for (let d = 0; d < 32; d++) {
    const dist = popcount((unmasked ^ FORMAT_CODEWORDS[d]) & known);
    if (!best || dist < best.dist) best = { dist, data: d };
  }
  if (2 * best.dist + erased > 6) return null;
  return {
    ecLevel: EC_LEVELS[best.data >> 3],
    mask: best.data & 7,
    distance: best.dist,
    erased,
  };
}

// Copy 1, around the top-left finder. Index = bit number (0 = LSB).
// Bits 0..5 run down column 8 (rows 0..5), bit 6 skips the timing row to
// (7,8), bits 7..8 turn the corner, bits 9..14 run left along row 8.
export const FORMAT_POS1 = [
  [0, 8], [1, 8], [2, 8], [3, 8], [4, 8], [5, 8], [7, 8], [8, 8],
  [8, 7], [8, 5], [8, 4], [8, 3], [8, 2], [8, 1], [8, 0],
];

// Copy 2, split between the top-right (bits 0..7, row 8, right edge inward)
// and the bottom-left (bits 8..14, column 8, rows size-7..size-1).
export function formatPos2(size) {
  const p = [];
  for (let i = 0; i <= 7; i++) p.push([8, size - 1 - i]);
  for (let i = 8; i <= 14; i++) p.push([size - 15 + i, 8]);
  return p;
}

// ---------------------------------------------------------------------------
// Function-pattern map
// ---------------------------------------------------------------------------

// Alignment pattern centre coordinates per version (1..10).
const ALIGN = [
  null,
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
];

// Uint8Array(size*size): 1 = function module (never carries data), 0 = data module.
export function buildFunctionMap(version) {
  const size = 17 + 4 * version;
  const map = new Uint8Array(size * size);
  const mark = (r, c) => { map[r * size + c] = 1; };

  // Finders + separators + format areas (includes the dark module at (size-8, 8)).
  for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) mark(r, c);
  for (let r = 0; r < 9; r++) for (let c = size - 8; c < size; c++) mark(r, c);
  for (let r = size - 8; r < size; r++) for (let c = 0; c < 9; c++) mark(r, c);

  // Timing patterns.
  for (let k = 0; k < size; k++) { mark(6, k); mark(k, 6); }

  // Alignment patterns (5x5), skipping the three that would sit on finders.
  const centers = ALIGN[version];
  for (const r of centers) {
    for (const c of centers) {
      if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) mark(r + dr, c + dc);
    }
  }

  // Version information (two 6x3 blocks, versions 7+).
  if (version >= 7) {
    for (let r = 0; r < 6; r++) {
      for (let c = size - 11; c < size - 8; c++) { mark(r, c); mark(c, r); }
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Zigzag module order + codeword reading
// ---------------------------------------------------------------------------

// Standard placement order: right-to-left column pairs, alternating upward /
// downward, right column before left, skipping the vertical timing column (6).
export function* dataModuleOrder(size, funcMap) {
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col = 5;
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (const c of [col, col - 1]) {
        if (!funcMap[row * size + c]) yield [row, c];
      }
    }
    upward = !upward;
  }
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

// Unmask + read every data module in zigzag order into 8-bit codewords
// (MSB first). Remainder bits (an incomplete final byte) are dropped.
// erasures: indices of codewords that contained one or more -1 modules.
export function readCodewords(matrix, size, funcMap, maskId) {
  const maskFn = MASKS[maskId];
  if (!maskFn) throw new Error(`bad mask ${maskId}`);
  const codewords = [];
  const erasures = [];
  let acc = 0;
  let nbits = 0;
  let hasErased = false;
  for (const [r, c] of dataModuleOrder(size, funcMap)) {
    let v = matrix[r * size + c];
    if (v === -1) { hasErased = true; v = 0; }
    else if (maskFn(r, c)) v ^= 1;
    acc = (acc << 1) | v;
    if (++nbits === 8) {
      if (hasErased) erasures.push(codewords.length);
      codewords.push(acc);
      acc = 0; nbits = 0; hasErased = false;
    }
  }
  return { codewords: Uint8Array.from(codewords), erasures };
}

// ---------------------------------------------------------------------------
// Block structure (same tables the encoder uses)
// ---------------------------------------------------------------------------

// Per version, per level: [ecCodewordsPerBlock, [[blockCount, dataCodewords], ...]].
export const BLOCKS = {
  1:  { L: [7,  [[1, 19]]],  M: [10, [[1, 16]]],           Q: [13, [[1, 13]]],           H: [17, [[1, 9]]] },
  2:  { L: [10, [[1, 34]]],  M: [16, [[1, 28]]],           Q: [22, [[1, 22]]],           H: [28, [[1, 16]]] },
  3:  { L: [15, [[1, 55]]],  M: [26, [[1, 44]]],           Q: [18, [[2, 17]]],           H: [22, [[2, 13]]] },
  4:  { L: [20, [[1, 80]]],  M: [18, [[2, 32]]],           Q: [26, [[2, 24]]],           H: [16, [[4, 9]]] },
  5:  { L: [26, [[1, 108]]], M: [24, [[2, 43]]],           Q: [18, [[2, 15], [2, 16]]],  H: [22, [[2, 11], [2, 12]]] },
  6:  { L: [18, [[2, 68]]],  M: [16, [[4, 27]]],           Q: [24, [[4, 19]]],           H: [28, [[4, 15]]] },
  7:  { L: [20, [[2, 78]]],  M: [18, [[4, 31]]],           Q: [18, [[2, 14], [4, 15]]],  H: [26, [[4, 13], [1, 14]]] },
  8:  { L: [24, [[2, 97]]],  M: [22, [[2, 38], [2, 39]]],  Q: [22, [[4, 18], [2, 19]]],  H: [26, [[4, 14], [2, 15]]] },
  9:  { L: [30, [[2, 116]]], M: [22, [[3, 36], [2, 37]]],  Q: [20, [[4, 16], [4, 17]]],  H: [24, [[4, 12], [4, 13]]] },
  10: { L: [18, [[2, 68], [2, 69]]], M: [26, [[4, 43], [1, 44]]], Q: [24, [[6, 19], [2, 20]]], H: [28, [[6, 15], [2, 16]]] },
};

// ---------------------------------------------------------------------------
// Bit-stream parsing (BYTE mode; ECI headers tolerated and skipped)
// ---------------------------------------------------------------------------

function parseByteStream(data, version) {
  const totalBits = data.length * 8;
  let pos = 0;
  const readBits = (n) => {
    let v = 0;
    for (let i = 0; i < n; i++) {
      v = (v << 1) | ((data[pos >> 3] >> (7 - (pos & 7))) & 1);
      pos++;
    }
    return v;
  };
  const out = [];
  while (pos + 4 <= totalBits) {
    const mode = readBits(4);
    if (mode === 0b0000) break; // terminator
    if (mode === 0b0111) {
      // ECI designator: 1, 2 or 3 bytes depending on the leading bits.
      const b0 = readBits(8);
      if ((b0 & 0x80) === 0) { /* 1-byte designator, done */ }
      else if ((b0 & 0xc0) === 0x80) readBits(8);
      else if ((b0 & 0xe0) === 0xc0) readBits(16);
      else throw new Error('bad ECI designator');
      continue;
    }
    if (mode === 0b0100) {
      const count = readBits(version <= 9 ? 8 : 16);
      if (pos + count * 8 > totalBits) throw new Error('byte segment overruns data');
      for (let i = 0; i < count; i++) out.push(readBits(8));
      continue;
    }
    throw new Error(`unsupported mode 0b${mode.toString(2).padStart(4, '0')}`);
  }
  return Uint8Array.from(out);
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

// matrix: Int8Array | Array, row-major, size*size entries of 1 / 0 / -1.
// size is optional (the matrix is square, so it is derived when omitted).
// Returns { payload: Uint8Array, text, version, ecLevel, mask, corrected }.
export function qrDecodeMatrix(matrix, size = Math.round(Math.sqrt(matrix.length))) {
  if (!Number.isInteger(size) || size < 21 || (size - 17) % 4 !== 0) {
    throw new Error(`bad matrix size ${size}`);
  }
  const version = (size - 17) / 4;
  if (version > 10) throw new Error(`version ${version} unsupported (1..10)`);
  if (matrix.length !== size * size) {
    throw new Error(`matrix length ${matrix.length} != ${size * size}`);
  }

  // Format info: decode both copies, prefer the one with the smaller distance.
  const readBits = (positions) => positions.map(([r, c]) => matrix[r * size + c]);
  const f1 = decodeFormatValue(readBits(FORMAT_POS1));
  const f2 = decodeFormatValue(readBits(formatPos2(size)));
  let fmt = null;
  if (f1 && f2) {
    fmt = f2.distance < f1.distance || (f2.distance === f1.distance && f2.erased < f1.erased) ? f2 : f1;
  } else {
    fmt = f1 || f2;
  }
  if (!fmt) throw new Error('format information unreadable');
  const { ecLevel, mask } = fmt;

  // Read the interleaved codewords.
  const funcMap = buildFunctionMap(version);
  const { codewords, erasures } = readCodewords(matrix, size, funcMap, mask);

  const [ecPer, groups] = BLOCKS[version][ecLevel];
  const dataLens = [];
  for (const [n, len] of groups) for (let i = 0; i < n; i++) dataLens.push(len);
  const totalData = dataLens.reduce((a, b) => a + b, 0);
  const total = totalData + dataLens.length * ecPer;
  if (codewords.length < total) {
    throw new Error(`read ${codewords.length} codewords, need ${total}`);
  }
  const eraseSet = new Set(erasures);

  // De-interleave into blocks (data first, all blocks round-robin by index,
  // shorter blocks dropping out; then EC the same way).
  const nb = dataLens.length;
  const blocks = dataLens.map((len) => ({ cw: new Uint8Array(len + ecPer), erasures: [] }));
  let idx = 0;
  const maxData = Math.max(...dataLens);
  for (let i = 0; i < maxData; i++) {
    for (let b = 0; b < nb; b++) {
      if (i >= dataLens[b]) continue;
      blocks[b].cw[i] = codewords[idx];
      if (eraseSet.has(idx)) blocks[b].erasures.push(i);
      idx++;
    }
  }
  for (let i = 0; i < ecPer; i++) {
    for (let b = 0; b < nb; b++) {
      blocks[b].cw[dataLens[b] + i] = codewords[idx];
      if (eraseSet.has(idx)) blocks[b].erasures.push(dataLens[b] + i);
      idx++;
    }
  }

  // Reed-Solomon per block, erasures included.
  let corrected = 0;
  const data = new Uint8Array(totalData);
  let off = 0;
  for (const blk of blocks) {
    const res = rsDecode(blk.cw, ecPer, blk.erasures);
    corrected += res.corrected;
    data.set(res.data, off);
    off += res.data.length;
  }

  const payload = parseByteStream(data, version);
  let text = '';
  for (let i = 0; i < payload.length; i++) text += String.fromCharCode(payload[i]);
  return { payload, text, version, ecLevel, mask, corrected };
}
