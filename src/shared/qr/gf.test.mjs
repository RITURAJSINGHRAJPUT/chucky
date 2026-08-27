// Plain-node test script for src/shared/qr/gf.mjs — no framework.
// Run: node src/shared/qr/gf.test.mjs
import { rsEncode, rsDecode } from './gf.mjs';

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
const rand = mulberry32(0xc0ffee);
const randInt = (n) => Math.floor(rand() * n);

function distinctPositions(count, n) {
  const set = new Set();
  while (set.size < count) set.add(randInt(n));
  return [...set];
}

// ---------------------------------------------------------------------------
// 1. QR spec example (version 1-M): known data -> known EC codewords
// ---------------------------------------------------------------------------
const specData = Uint8Array.from([
  16, 32, 12, 86, 97, 128, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17,
]);
const specEc = [165, 36, 212, 193, 237, 54, 199, 135, 44, 85];
const gotEc = rsEncode(specData, 10);
check(
  'rsEncode matches QR spec example EC bytes',
  eqBytes(gotEc, specEc),
  `got [${[...gotEc]}]`
);

// ---------------------------------------------------------------------------
// 2. rsDecode round-trips clean codewords
// ---------------------------------------------------------------------------
{
  const clean = Uint8Array.from([...specData, ...gotEc]);
  const res = rsDecode(clean, 10, []);
  check('clean decode returns original data', eqBytes(res.data, specData));
  check('clean decode reports corrected === 0', res.corrected === 0);
}
{
  const data = Uint8Array.from({ length: 30 }, () => randInt(256));
  const ec = rsEncode(data, 16);
  const clean = Uint8Array.from([...data, ...ec]);
  const res = rsDecode(clean, 16, []);
  check('clean decode round-trips random data (ecCount=16)', eqBytes(res.data, data));
  check('clean random decode reports corrected === 0', res.corrected === 0);
}

// ---------------------------------------------------------------------------
// 3. Error and erasure correction, ecCount = 16
// ---------------------------------------------------------------------------
const K = 30;
const EC = 16;
const baseData = Uint8Array.from({ length: K }, () => randInt(256));
const baseCw = Uint8Array.from([...baseData, ...rsEncode(baseData, EC)]);
const N = baseCw.length;

for (let t = 1; t <= 8; t++) {
  const corrupted = Uint8Array.from(baseCw);
  for (const p of distinctPositions(t, N)) {
    corrupted[p] ^= 1 + randInt(255); // guaranteed nonzero flip
  }
  let ok = false;
  let msg = '';
  try {
    const res = rsDecode(corrupted, EC, []);
    ok = eqBytes(res.data, baseData) && res.corrected === t;
    if (!ok) msg = `corrected=${res.corrected}`;
  } catch (e) {
    msg = e.message;
  }
  check(`corrects ${t} random error byte${t > 1 ? 's' : ''}`, ok, msg);
}

{
  const positions = distinctPositions(16, N);
  const corrupted = Uint8Array.from(baseCw);
  for (const p of positions) corrupted[p] ^= 1 + randInt(255);
  let ok = false;
  let msg = '';
  try {
    const res = rsDecode(corrupted, EC, positions);
    ok = eqBytes(res.data, baseData) && res.corrected === 16;
    if (!ok) msg = `corrected=${res.corrected}`;
  } catch (e) {
    msg = e.message;
  }
  check('corrects 16 erasures (ecCount=16)', ok, msg);
}

// ---------------------------------------------------------------------------
// 4. 9 random errors with ecCount = 16 must throw 'unrecoverable'
// ---------------------------------------------------------------------------
{
  let allThrew = true;
  let msg = '';
  for (let trial = 0; trial < 10; trial++) {
    const corrupted = Uint8Array.from(baseCw);
    for (const p of distinctPositions(9, N)) corrupted[p] ^= 1 + randInt(255);
    try {
      rsDecode(corrupted, EC, []);
      allThrew = false;
      msg = `trial ${trial} did not throw`;
      break;
    } catch (e) {
      if (e.message !== 'unrecoverable') {
        allThrew = false;
        msg = `trial ${trial} threw '${e.message}'`;
        break;
      }
    }
  }
  check("throws 'unrecoverable' on 9 random errors (10 trials)", allThrew, msg);
}

// ---------------------------------------------------------------------------
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
