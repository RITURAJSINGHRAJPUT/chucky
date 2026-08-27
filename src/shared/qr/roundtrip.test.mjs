// roundtrip.test.mjs — encode -> decode roundtrip tests for the QR modules.
// Plain node, no framework:  node src/shared/qr/roundtrip.test.mjs
//
// 1. Every version 1..8 x EC level L/M/Q/H x 3 payload lengths (short /
//    medium / near-capacity ASCII URLs): qrEncode with auto mask, then
//    qrDecodeMatrix(matrix) must return the identical payload and report
//    version / ecLevel / mask correctly.
// 2. Damage tolerance on version 4-M: K in {5, 15, 25} damaged data modules,
//    as bit-flip errors and as erasures (-1), plus a mixed case. Decodes
//    correctly while every block satisfies 2*errors + erasures <= 18, throws
//    beyond that capacity.
// 3. Centre-damage simulation (the menus' carved-centre QRs): a centred 7x7
//    square erased (-1) on a version 4-M code must still decode via the
//    erasure path.

import { qrEncode, placementOrder, EC_PARAMS } from './encode.mjs';
import { qrDecodeMatrix } from './decode.mjs';

let passed = 0;
let failed = 0;

function check(name, cond, detail = '') {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.log(`FAIL - ${name}${detail ? ` :: ${detail}` : ''}`);
  }
}

// Deterministic PRNG so runs are reproducible.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// 1. Version 1..8 x L/M/Q/H x short / medium / near-capacity payloads
// ---------------------------------------------------------------------------

const BASE_URL = 'https://menus.bookends.example/qr/' +
  'abcdefghijklmnopqrstuvwxyz0123456789'.repeat(6); // 250 ASCII chars

// BYTE-mode byte capacity for v1..9 (8-bit char count):
// floor((8*dataCW - 4 - 8) / 8) = dataCW - 2.
function byteCapacity(version, ecLevel) {
  const [, g1, d1, g2, d2] = EC_PARAMS[ecLevel][version];
  return g1 * d1 + g2 * d2 - 2;
}

for (let v = 1; v <= 8; v++) {
  for (const lvl of ['L', 'M', 'Q', 'H']) {
    const cap = byteCapacity(v, lvl);
    const lengths = [Math.min(6, cap), Math.max(1, Math.floor(cap / 2)), cap];
    for (const len of lengths) {
      const payload = BASE_URL.slice(0, len);
      const label = `v${v}-${lvl} len ${len}`;
      let q;
      try {
        q = qrEncode(payload, { ecLevel: lvl, version: v }); // mask auto
      } catch (e) {
        check(`${label} encodes`, false, e.message);
        check(`${label} meta`, false, 'encode threw');
        continue;
      }
      try {
        const d = qrDecodeMatrix(q.matrix); // size derived from the matrix
        check(`${label} payload roundtrips`, d.text === payload,
          `got ${JSON.stringify(d.text)}`);
        check(`${label} reports version/ecLevel/mask, corrected 0`,
          d.version === v && d.ecLevel === lvl && d.mask === q.mask && d.corrected === 0,
          `v${d.version} ${d.ecLevel} m${d.mask} (enc m${q.mask}) c${d.corrected}`);
      } catch (e) {
        check(`${label} payload roundtrips`, false, e.message);
        check(`${label} reports version/ecLevel/mask, corrected 0`, false, 'decode threw');
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Damage tolerance on version 4-M
// ---------------------------------------------------------------------------

// v4-M: 2 blocks, each 32 data + 18 EC codewords; 100 codewords total.
// Interleaved codeword index -> block: data (0..63) alternate, EC (64..99)
// alternate. Budget per block: 2*errors + erasures <= 18.
const V4M = { ecPer: 18, dataTotal: 64, cwTotal: 100 };
const blockOf = (cw) => (cw < V4M.dataTotal ? cw % 2 : (cw - V4M.dataTotal) % 2);

const DMG_PAYLOAD = 'https://bookends.example/aiko-menu?tbl=7';
const qDmg = qrEncode(DMG_PAYLOAD, { ecLevel: 'M', version: 4 });
const orderV4 = placementOrder(4); // matches the decoder's zigzag (proven in part 1)
const dataSlots = V4M.cwTotal * 8; // damage only real codeword bits, not remainder

// kinds: slot index -> 'error' | 'erasure'. Returns whether every block is
// within budget.
function withinBudget(slots, kinds) {
  const E = [0, 0];
  const R = [0, 0];
  const seen = new Map(); // cw -> 'error' | 'erasure' (erasure wins)
  slots.forEach((s, i) => {
    const cw = s >> 3;
    const kind = kinds[i];
    if (kind === 'erasure' || seen.get(cw) !== 'erasure') seen.set(cw, kind);
  });
  for (const [cw, kind] of seen) {
    if (kind === 'erasure') R[blockOf(cw)]++;
    else E[blockOf(cw)]++;
  }
  return [0, 1].every((b) => 2 * E[b] + R[b] <= V4M.ecPer);
}

// Draw K distinct random data-module slots whose damage lands on the wanted
// side of the block budget (deterministic: seeded PRNG, bounded redraws).
function drawDamage(K, kindFor, wantWithin, seed) {
  const rand = mulberry32(seed);
  for (let attempt = 0; attempt < 1000; attempt++) {
    const set = new Set();
    while (set.size < K) set.add(Math.floor(rand() * dataSlots));
    const slots = [...set];
    const kinds = slots.map((s, i) => kindFor(i));
    if (withinBudget(slots, kinds) === wantWithin) return { slots, kinds };
  }
  throw new Error(`could not draw damage K=${K} within=${wantWithin}`);
}

function applyDamage(slots, kinds) {
  const m = Int8Array.from(qDmg.matrix);
  slots.forEach((s, i) => {
    const [r, c] = orderV4[s];
    if (kinds[i] === 'erasure') m[r * qDmg.size + c] = -1;
    else m[r * qDmg.size + c] ^= 1;
  });
  return m;
}

const damageCases = [
  // All-error cases: each error codeword costs 2 of the 18-point budget, so
  // K=25 distinct random modules (~25 codewords over 2 blocks) exceeds it.
  { K: 5, kind: () => 'error', within: true, seed: 0xa11ce },
  { K: 15, kind: () => 'error', within: true, seed: 0xb0b },
  { K: 25, kind: () => 'error', within: false, seed: 0xc0de },
  // Erasure cases (half the cases use erasures): erasures cost 1, so even
  // K=25 stays inside the budget and must decode.
  { K: 5, kind: () => 'erasure', within: true, seed: 0xd06 },
  { K: 15, kind: () => 'erasure', within: true, seed: 0xe66 },
  { K: 25, kind: () => 'erasure', within: true, seed: 0xf00d },
  // Mixed errors + erasures exercises the errata Berlekamp-Massey path.
  { K: 25, kind: (i) => (i < 13 ? 'erasure' : 'error'), within: true, seed: 0xabba },
];

for (const tc of damageCases) {
  const kindName = tc.kind(0) === tc.kind(tc.K - 1) ? tc.kind(0) + 's' : 'mixed';
  const label = `v4-M damage K=${tc.K} ${kindName}`;
  const { slots, kinds } = drawDamage(tc.K, tc.kind, tc.within, tc.seed);
  const m = applyDamage(slots, kinds);
  if (tc.within) {
    try {
      const d = qrDecodeMatrix(m);
      check(`${label} decodes to the right payload`, d.text === DMG_PAYLOAD,
        `got ${JSON.stringify(d.text)}`);
      check(`${label} reports v4/M/mask ${qDmg.mask}`,
        d.version === 4 && d.ecLevel === 'M' && d.mask === qDmg.mask,
        `v${d.version} ${d.ecLevel} m${d.mask}`);
    } catch (e) {
      check(`${label} decodes to the right payload`, false, e.message);
      check(`${label} reports v4/M/mask ${qDmg.mask}`, false, 'decode threw');
    }
  } else {
    let threw = false;
    let wrong = false;
    try {
      const d = qrDecodeMatrix(m);
      wrong = d.text !== DMG_PAYLOAD;
    } catch (e) {
      threw = true;
    }
    check(`${label} beyond capacity throws`, threw,
      wrong ? 'returned a wrong payload instead of throwing' : 'returned the right payload');
  }
}

// ---------------------------------------------------------------------------
// 3. Centre-damage simulation: carved 7x7 centre on a v4-M code
// ---------------------------------------------------------------------------

{
  const { size, matrix, mask } = qDmg; // size 33, centre module (16,16)
  const m = Int8Array.from(matrix);
  const c0 = (size - 7) >> 1; // 13 .. 19
  let erased = 0;
  for (let r = c0; r < c0 + 7; r++) {
    for (let c = c0; c < c0 + 7; c++) {
      m[r * size + c] = -1;
      erased++;
    }
  }
  check('centre 7x7 erases 49 modules', erased === 49, `${erased}`);
  try {
    const d = qrDecodeMatrix(m);
    check('carved-centre v4-M decodes to the right payload', d.text === DMG_PAYLOAD,
      `got ${JSON.stringify(d.text)}`);
    check('carved-centre decode reports v4/M and the encoder mask',
      d.version === 4 && d.ecLevel === 'M' && d.mask === mask,
      `v${d.version} ${d.ecLevel} m${d.mask}`);
    check('carved-centre decode corrected at least one codeword', d.corrected > 0,
      `corrected=${d.corrected}`);
  } catch (e) {
    check('carved-centre v4-M decodes to the right payload', false, e.message);
    check('carved-centre decode reports v4/M and the encoder mask', false, 'decode threw');
    check('carved-centre decode corrected at least one codeword', false, 'decode threw');
  }
}

// ---------------------------------------------------------------------------
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
