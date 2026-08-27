// Plain-node test script for src/shared/qr/decode.mjs — no framework.
// Run: node src/shared/qr/decode.test.mjs
import {
  qrDecodeMatrix, encodeFormat, decodeFormatValue,
  buildFunctionMap, dataModuleOrder, readCodewords,
  BLOCKS, FORMAT_POS1, formatPos2,
} from './decode.mjs';
import { rsEncode } from './gf.mjs';

let passed = 0;
let failed = 0;

function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`ok   - ${name}`);
  } else {
    failed++;
    console.log(`FAIL - ${name}${detail ? ` :: ${detail}` : ''}`);
  }
}

function eqBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const bitsOf = (v15) => Array.from({ length: 15 }, (_, i) => (v15 >> i) & 1);

// ---------------------------------------------------------------------------
// 1. Format info: all 8 masks x 4 levels round-trip through the BCH reader
// ---------------------------------------------------------------------------
{
  // Known spec vector: level L, mask 0 -> masked string 111011111000100.
  check('encodeFormat(L,0) matches spec vector 0x77c4', encodeFormat('L', 0) === 0x77c4,
    `got 0x${encodeFormat('L', 0).toString(16)}`);

  let clean = 0;
  let threeErr = 0;
  let erasePlus = 0;
  const combos = [];
  for (const level of ['L', 'M', 'Q', 'H']) {
    for (let mask = 0; mask < 8; mask++) {
      combos.push([level, mask]);
      const placed = encodeFormat(level, mask);

      // clean read
      const d0 = decodeFormatValue(bitsOf(placed));
      if (d0 && d0.ecLevel === level && d0.mask === mask && d0.distance === 0) clean++;

      // 3 bit errors (max correctable on a fully known copy)
      const bits3 = bitsOf(placed);
      for (const i of [1, 7, 14]) bits3[i] ^= 1;
      const d3 = decodeFormatValue(bits3);
      if (d3 && d3.ecLevel === level && d3.mask === mask && d3.distance === 3) threeErr++;

      // 2 erased bits + 1 bit error (2*1 + 2 = 4 <= 6)
      const bitsE = bitsOf(placed);
      bitsE[3] = -1;
      bitsE[10] = -1;
      bitsE[6] ^= 1;
      const dE = decodeFormatValue(bitsE);
      if (dE && dE.ecLevel === level && dE.mask === mask) erasePlus++;
    }
  }
  check('format round-trip clean: 32/32 level x mask combos', clean === combos.length, `${clean}/32`);
  check('format round-trip with 3 bit errors: 32/32', threeErr === combos.length, `${threeErr}/32`);
  check('format round-trip with 2 erasures + 1 error: 32/32', erasePlus === combos.length, `${erasePlus}/32`);
  check('format with 4 errors is never mis-accepted as the true word at dist<=3', (() => {
    const placed = encodeFormat('Q', 5);
    const bits = bitsOf(placed);
    for (const i of [0, 4, 8, 12]) bits[i] ^= 1;
    const d = decodeFormatValue(bits);
    // either rejected, or decoded to a DIFFERENT word (distance rules make the
    // true word unreachable at distance <= 3 after 4 flips)
    return d === null || !(d.ecLevel === 'Q' && d.mask === 5 && d.distance <= 3);
  })());
}

// ---------------------------------------------------------------------------
// 2. Zigzag reader on a synthetic v1 (21x21) matrix
// ---------------------------------------------------------------------------
{
  const size = 21;
  const fm = buildFunctionMap(1);
  const order = [...dataModuleOrder(size, fm)];

  check('v1 zigzag yields 208 data modules (26 codewords, 0 remainder)', order.length === 208,
    `got ${order.length}`);

  const expectFirst8 = [[20, 20], [20, 19], [19, 20], [19, 19], [18, 20], [18, 19], [17, 20], [17, 19]];
  check('first codeword occupies the bottom-right 2x4 block in spec order',
    JSON.stringify(order.slice(0, 8)) === JSON.stringify(expectFirst8),
    JSON.stringify(order.slice(0, 8)));

  // After the first (upward) pair ends at row 9, the next pair reads DOWNWARD
  // starting below the top-right finder zone: (9,18),(9,17),(10,18)...
  check('direction alternates at the column-pair boundary',
    JSON.stringify(order.slice(24, 27)) === JSON.stringify([[9, 18], [9, 17], [10, 18]]),
    JSON.stringify(order.slice(24, 27)));

  const seen = new Set(order.map(([r, c]) => r * size + c));
  check('zigzag positions are unique', seen.size === order.length);
  check('zigzag never visits timing column 6', order.every(([, c]) => c !== 6));
  check('zigzag never visits a function module', order.every(([r, c]) => !fm[r * size + c]));
  check('zigzag stays in bounds', order.every(([r, c]) => r >= 0 && r < size && c >= 0 && c < size));

  // Place 26 known codewords (mask 0 pre-applied by hand, independently of the
  // decoder's mask table) and read them back.
  const bytes = Uint8Array.from({ length: 26 }, (_, i) => (i * 7 + 3) & 0xff);
  const mask0 = (r, c) => (r + c) % 2 === 0;
  const m = new Int8Array(size * size);
  order.forEach(([r, c], k) => {
    const bit = (bytes[k >> 3] >> (7 - (k & 7))) & 1;
    m[r * size + c] = bit ^ (mask0(r, c) ? 1 : 0);
  });
  const rd = readCodewords(m, size, fm, 0);
  check('readCodewords round-trips 26 placed codewords through mask 0', eqBytes(rd.codewords, bytes));
  check('clean matrix reports no erased codewords', rd.erasures.length === 0);

  const [er, ec] = order[25]; // bit 25 -> codeword 3
  m[er * size + ec] = -1;
  const rd2 = readCodewords(m, size, fm, 0);
  check('a -1 module flags exactly its codeword as an erasure',
    JSON.stringify(rd2.erasures) === JSON.stringify([3]), JSON.stringify(rd2.erasures));
}

// ---------------------------------------------------------------------------
// 3. Block-structure sanity: total codewords for v1..6, all levels
// ---------------------------------------------------------------------------
{
  const totals = [26, 44, 70, 100, 134, 172];
  for (let v = 1; v <= 6; v++) {
    for (const level of ['L', 'M', 'Q', 'H']) {
      const [ecPer, groups] = BLOCKS[v][level];
      const total = groups.reduce((s, [n, len]) => s + n * (len + ecPer), 0);
      check(`v${v}-${level} block table totals ${totals[v - 1]} codewords`,
        total === totals[v - 1], `got ${total}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 4. End-to-end: hand-built v1-M symbol (mask 0) through qrDecodeMatrix
// ---------------------------------------------------------------------------

function buildDataCodewords(writeSegments, totalDataCw) {
  const bits = [];
  const write = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >> i) & 1); };
  writeSegments(write);
  write(0, Math.min(4, totalDataCw * 8 - bits.length)); // terminator
  while (bits.length % 8) bits.push(0);
  const bytes = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    bytes.push(b);
  }
  const pads = [0xec, 0x11];
  let p = 0;
  while (bytes.length < totalDataCw) bytes.push(pads[p++ % 2]);
  return Uint8Array.from(bytes);
}

// Build a v1 matrix: format info in both copies, codeword bits placed in zigzag
// order with mask 0 applied by the test's own mask function.
function buildV1Matrix(ecLevel, codewords) {
  const size = 21;
  const m = new Int8Array(size * size);
  const fm = buildFunctionMap(1);
  const fmtVal = encodeFormat(ecLevel, 0);
  const pos2 = formatPos2(size);
  for (let i = 0; i < 15; i++) {
    const bit = (fmtVal >> i) & 1;
    m[FORMAT_POS1[i][0] * size + FORMAT_POS1[i][1]] = bit;
    m[pos2[i][0] * size + pos2[i][1]] = bit;
  }
  const mask0 = (r, c) => (r + c) % 2 === 0;
  const order = [...dataModuleOrder(size, fm)];
  order.forEach(([r, c], k) => {
    const byte = k >> 3;
    const bit = byte < codewords.length ? (codewords[byte] >> (7 - (k & 7))) & 1 : 0;
    m[r * size + c] = bit ^ (mask0(r, c) ? 1 : 0);
  });
  return { m, size, order };
}

{
  const HELLO = [0x48, 0x45, 0x4c, 0x4c, 0x4f];
  const data = buildDataCodewords((write) => {
    write(0b0100, 4);          // BYTE mode
    write(HELLO.length, 8);    // v1-9 count is 8 bits
    for (const b of HELLO) write(b, 8);
  }, 16);                       // v1-M: 16 data codewords
  const codewords = Uint8Array.from([...data, ...rsEncode(data, 10)]);

  {
    const { m } = buildV1Matrix('M', codewords);
    const d = qrDecodeMatrix(m, 21);
    check('e2e clean v1-M decodes to "HELLO"', d.text === 'HELLO', JSON.stringify(d.text));
    check('e2e payload bytes match', eqBytes(d.payload, HELLO));
    check('e2e reports version 1, ecLevel M, mask 0, corrected 0',
      d.version === 1 && d.ecLevel === 'M' && d.mask === 0 && d.corrected === 0,
      `v${d.version} ${d.ecLevel} m${d.mask} c${d.corrected}`);
  }

  {
    // Flip every bit of codewords 1 and 5 -> two byte errors, RS must fix both.
    const { m, size, order } = buildV1Matrix('M', codewords);
    for (const k of [8, 9, 10, 11, 12, 13, 14, 15, 40, 41, 42, 43, 44, 45, 46, 47]) {
      const [r, c] = order[k];
      m[r * size + c] ^= 1;
    }
    const d = qrDecodeMatrix(m, 21);
    check('e2e corrects 2 corrupted codewords', d.text === 'HELLO' && d.corrected === 2,
      `text=${JSON.stringify(d.text)} corrected=${d.corrected}`);
  }

  {
    // Erase all modules of codewords 2 and 3 -> two erasures, well within 10 EC.
    const { m, size, order } = buildV1Matrix('M', codewords);
    for (let k = 16; k < 32; k++) {
      const [r, c] = order[k];
      m[r * size + c] = -1;
    }
    const d = qrDecodeMatrix(m, 21);
    check('e2e decodes through 2 erased codewords', d.text === 'HELLO',
      JSON.stringify(d.text));
  }

  {
    // Damage format copy 1 (2 flipped bits); copy 2 is clean and must win.
    const { m, size } = buildV1Matrix('M', codewords);
    for (const i of [0, 5]) {
      const [r, c] = FORMAT_POS1[i];
      m[r * size + c] ^= 1;
    }
    const d = qrDecodeMatrix(m, 21);
    check('e2e prefers the cleaner format copy', d.ecLevel === 'M' && d.mask === 0 && d.text === 'HELLO',
      `${d.ecLevel} m${d.mask}`);
  }

  {
    // ECI header (designator 26 = UTF-8) before the byte segment is skipped.
    const dataEci = buildDataCodewords((write) => {
      write(0b0111, 4);         // ECI mode
      write(26, 8);             // 1-byte designator
      write(0b0100, 4);         // BYTE mode
      write(HELLO.length, 8);
      for (const b of HELLO) write(b, 8);
    }, 16);
    const cwEci = Uint8Array.from([...dataEci, ...rsEncode(dataEci, 10)]);
    const { m } = buildV1Matrix('M', cwEci);
    const d = qrDecodeMatrix(m, 21);
    check('e2e tolerates and skips an ECI header', d.text === 'HELLO', JSON.stringify(d.text));
  }
}

// ---------------------------------------------------------------------------
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
