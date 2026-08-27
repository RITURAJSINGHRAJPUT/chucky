// encode.test.mjs — structural + scan-back tests for the QR encoder.
//   node src/shared/qr/encode.test.mjs
import {
  qrEncode, buildCodewords, functionModules, placementOrder,
  formatBits, versionBits, MASKS, EC_PARAMS, TOTAL_CODEWORDS,
} from './encode.mjs';

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) passed++;
  else { failed++; console.error(`FAIL: ${label}`); }
}

const bytesOf = p => (typeof p === 'string' ? new TextEncoder().encode(p) : Uint8Array.from(p));

// Remainder bits appended after the codeword stream, per version.
const REMAINDER = [, 0, 7, 7, 7, 7, 7, 0, 0, 0, 0];

// --- helpers ---------------------------------------------------------------

function checkFinder(m, size, r0, c0) {
  for (let dr = 0; dr < 7; dr++) {
    for (let dc = 0; dc < 7; dc++) {
      const ring = dr === 0 || dr === 6 || dc === 0 || dc === 6;
      const core = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
      if (m[(r0 + dr) * size + (c0 + dc)] !== (ring || core ? 1 : 0)) return false;
    }
  }
  // separators: the in-bounds one-module light border around the 7x7
  for (let dr = -1; dr <= 7; dr++) {
    for (let dc = -1; dc <= 7; dc++) {
      if (dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6) continue;
      const r = r0 + dr, c = c0 + dc;
      if (r < 0 || r >= size || c < 0 || c >= size) continue;
      if (m[r * size + c] !== 0) return false;
    }
  }
  return true;
}

function timingOk(m, size) {
  for (let i = 8; i <= size - 9; i++) {
    const want = i % 2 === 0 ? 1 : 0;
    if (m[6 * size + i] !== want) return false;
    if (m[i * size + 6] !== want) return false;
  }
  return true;
}

// Read both format-info copies back out of the matrix.
function readFormats(m, size) {
  const g = (r, c) => m[r * size + c];
  let a = 0;
  for (let i = 0; i <= 5; i++) a |= g(i, 8) << i;
  a |= g(7, 8) << 6;
  a |= g(8, 8) << 7;
  a |= g(8, 7) << 8;
  for (let i = 9; i <= 14; i++) a |= g(8, 14 - i) << i;
  let b = 0;
  for (let i = 0; i <= 7; i++) b |= g(8, size - 1 - i) << i;
  for (let i = 8; i <= 14; i++) b |= g(size - 15 + i, 8) << i;
  return [a, b];
}

// BCH(15,5) self-check: after removing the 0x5412 mask the 15-bit word must be
// divisible by the generator 0x537.
function formatBchOk(f) {
  let v = f ^ 0x5412;
  for (let i = 14; i >= 10; i--) if ((v >>> i) & 1) v ^= 0x537 << (i - 10);
  return v === 0;
}

function decodeFormat(f) {
  const data = (f ^ 0x5412) >>> 10;
  const lvl = { 1: 'L', 0: 'M', 3: 'Q', 2: 'H' }[data >>> 3];
  return { ecLevel: lvl, mask: data & 7 };
}

// Version-info BCH(18,6) self-check: divisible by 0x1F25.
function versionBchOk(vbits) {
  let v = vbits;
  for (let i = 17; i >= 12; i--) if ((v >>> i) & 1) v ^= 0x1f25 << (i - 12);
  return v === 0;
}

// --- capacity table self-consistency --------------------------------------

for (const lvl of ['L', 'M', 'Q', 'H']) {
  for (let v = 1; v <= 10; v++) {
    const [ec, g1, d1, g2, d2] = EC_PARAMS[lvl][v];
    ok(ec * (g1 + g2) + g1 * d1 + g2 * d2 === TOTAL_CODEWORDS[v], `capacity total ${v}-${lvl}`);
    ok(g2 === 0 || d2 === d1 + 1, `group2 data length ${v}-${lvl}`);
  }
}

// --- (1) structural invariants for every ecLevel x mask ---------------------

for (const lvl of ['L', 'M', 'Q', 'H']) {
  for (let mk = 0; mk < 8; mk++) {
    const q = qrEncode('HELLO WORLD', { ecLevel: lvl, mask: mk });
    const { matrix: m, size } = q;
    ok(q.mask === mk && q.ecLevel === lvl, `echo of options ${lvl}/${mk}`);
    ok(checkFinder(m, size, 0, 0) && checkFinder(m, size, 0, size - 7) && checkFinder(m, size, size - 7, 0),
       `finders ${lvl}/${mk}`);
    ok(timingOk(m, size), `timing ${lvl}/${mk}`);
    ok(m[(size - 8) * size + 8] === 1, `dark module ${lvl}/${mk}`);
    const [f1, f2] = readFormats(m, size);
    ok(f1 === f2, `format copies agree ${lvl}/${mk}`);
    ok(formatBchOk(f1), `format BCH ${lvl}/${mk}`);
    const dec = decodeFormat(f1);
    ok(dec.ecLevel === lvl && dec.mask === mk, `format decodes ${lvl}/${mk}`);
    ok(f1 === formatBits(lvl, mk), `format matches formatBits ${lvl}/${mk}`);
  }
}

// The famous reference word: format info for M, mask 0 is 101010000010010.
ok(formatBits('M', 0) === 0b101010000010010, 'formatBits(M,0) reference value');

// --- (2) determinism --------------------------------------------------------

{
  const a = qrEncode('https://example.com', { ecLevel: 'M' });
  const b = qrEncode('https://example.com', { ecLevel: 'M' });
  ok(a.version === b.version && a.mask === b.mask && a.size === b.size,
     'deterministic version/mask');
  ok(a.matrix.length === b.matrix.length && a.matrix.every((v, i) => v === b.matrix[i]),
     'deterministic matrix');
  ok(a.toString() === b.toString() && a.toString().split('\n').length === a.size,
     'deterministic toString with size rows');
}

// --- (3) sizes, auto-version minimality, version info ----------------------

for (let v = 1; v <= 10; v++) {
  const q = qrEncode('x', { ecLevel: 'L', version: v, mask: 0 });
  ok(q.size === 21 + 4 * (v - 1), `size of version ${v}`);
  if (v >= 7) {
    const { matrix: m, size } = q;
    let tr = 0, bl = 0;
    for (let i = 0; i < 18; i++) {
      tr |= m[Math.floor(i / 3) * size + (size - 11 + (i % 3))] << i;
      bl |= m[(size - 11 + (i % 3)) * size + Math.floor(i / 3)] << i;
    }
    ok(tr === bl && tr === versionBits(v) && (tr >>> 12) === v && versionBchOk(tr),
       `version info blocks v${v}`);
  }
}
// v1-L holds 19 data codewords: 4+8+8n <= 152 means n <= 17.
ok(qrEncode('A'.repeat(17), { ecLevel: 'L' }).version === 1, 'auto-version picks v1 at 17 bytes L');
ok(qrEncode('A'.repeat(18), { ecLevel: 'L' }).version === 2, 'auto-version picks v2 at 18 bytes L');
// v9-H tops out at 4*12+4*13=100 data codewords -> 98 bytes; 99 needs v10.
ok(qrEncode(new Uint8Array(98), { ecLevel: 'H' }).version === 9, 'auto-version picks v9 at 98 bytes H');
ok(qrEncode(new Uint8Array(99), { ecLevel: 'H' }).version === 10, 'auto-version picks v10 at 99 bytes H');

// --- (4) scan the matrix back and re-derive the codeword sequence ----------

const scanCases = [
  { payload: 'short', version: 1, ecLevel: 'M', mask: null },
  { payload: 'https://example.com/menu?id=42', version: 5, ecLevel: 'Q', mask: 3 },
  { payload: Uint8Array.from({ length: 50 }, (_, i) => (i * 73 + 11) & 0xff), version: 7, ecLevel: 'H', mask: 5 },
  { payload: 'x'.repeat(200), version: 10, ecLevel: 'L', mask: null }, // 16-bit char count
  { payload: 'HELLO WORLD', version: 3, ecLevel: 'M', mask: 6 },
];

for (const tc of scanCases) {
  const q = qrEncode(tc.payload, { ecLevel: tc.ecLevel, version: tc.version, mask: tc.mask });
  const expect = buildCodewords(bytesOf(tc.payload), q.version, q.ecLevel);
  const order = placementOrder(q.version);
  const label = `v${q.version}-${q.ecLevel} mask ${q.mask}`;

  ok(order.length === TOTAL_CODEWORDS[q.version] * 8 + REMAINDER[q.version],
     `placement slot count ${label}`);

  // Minimal reader: replay the zigzag with the applied mask, collect the bits.
  const maskFn = MASKS[q.mask];
  const bits = order.map(([r, c]) => q.matrix[r * q.size + c] ^ (maskFn(r, c) ? 1 : 0));
  let bytesMatch = true;
  for (let i = 0; i < expect.length; i++) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i * 8 + j];
    if (b !== expect[i]) { bytesMatch = false; break; }
  }
  ok(bytesMatch, `scan-back codewords ${label}`);
  ok(bits.slice(expect.length * 8).every(b => b === 0), `remainder bits zero ${label}`);

  // The placement covers every non-function module exactly once.
  const { isFunc } = functionModules(q.version);
  const seen = new Uint8Array(q.size * q.size);
  let dup = false, onFunc = false;
  for (const [r, c] of order) {
    const i = r * q.size + c;
    if (seen[i]) dup = true;
    if (isFunc[i]) onFunc = true;
    seen[i] = 1;
  }
  let missed = false;
  for (let i = 0; i < seen.length; i++) if (!isFunc[i] && !seen[i]) missed = true;
  ok(!dup && !onFunc && !missed, `placement covers non-function modules ${label}`);
}

// --- report -----------------------------------------------------------------

console.log(`${passed} passed, ${failed} failed`);
if (failed === 0) {
  const q = qrEncode('https://example.com', { ecLevel: 'M' });
  console.log(`qrEncode('https://example.com',{ecLevel:'M'}): version ${q.version}, size ${q.size}, mask ${q.mask}`);
}
process.exit(failed ? 1 : 0);
