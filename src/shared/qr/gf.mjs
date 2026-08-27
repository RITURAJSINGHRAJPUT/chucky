// GF(256) arithmetic and Reed-Solomon codes exactly as QR codes use them.
// Field: GF(2^8) with primitive polynomial 0x11D (x^8 + x^4 + x^3 + x^2 + 1).
// Generator element: alpha = 2. RS generator roots: alpha^0 .. alpha^(ecCount-1).
// Dependency-free ES module (Node 18+).

// ---------------------------------------------------------------------------
// Lookup tables
// ---------------------------------------------------------------------------

// EXP has 512 entries so gfMul can index EXP[LOG[a] + LOG[b]] without a modulo.
export const EXP = new Uint8Array(512);
export const LOG = new Uint8Array(256);

{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

// ---------------------------------------------------------------------------
// Scalar field ops
// ---------------------------------------------------------------------------

export function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

function gfDiv(a, b) {
  if (b === 0) throw new Error('division by zero in GF(256)');
  if (a === 0) return 0;
  return EXP[(LOG[a] - LOG[b] + 255) % 255];
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

// Generator polynomial prod_{i=0}^{ecCount-1} (x - alpha^i).
// Returned as a Uint8Array of coefficients, HIGHEST degree first
// (leading coefficient is always 1).
export function rsGeneratorPoly(ecCount) {
  let g = new Uint8Array([1]);
  for (let i = 0; i < ecCount; i++) {
    const next = new Uint8Array(g.length + 1);
    const a = EXP[i]; // alpha^i
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j]; // x * g(x)
      next[j + 1] ^= gfMul(g[j], a); // alpha^i * g(x)
    }
    g = next;
  }
  return g;
}

// EC codewords: the remainder of data(x) * x^ecCount divided by the generator.
export function rsEncode(data, ecCount) {
  const gen = rsGeneratorPoly(ecCount);
  const buf = new Uint8Array(data.length + ecCount);
  buf.set(data);
  for (let i = 0; i < data.length; i++) {
    const coef = buf[i];
    if (coef === 0) continue;
    for (let j = 1; j < gen.length; j++) {
      buf[i + j] ^= gfMul(gen[j], coef);
    }
    buf[i] = 0; // gen[0] === 1, quotient term eliminated
  }
  return buf.slice(data.length);
}

// ---------------------------------------------------------------------------
// Decoding helpers (decoder-internal polynomials are plain Arrays,
// LOWEST degree first)
// ---------------------------------------------------------------------------

// Evaluate a highest-degree-first byte polynomial (a codeword) at x (Horner).
function polyEvalHigh(msg, x) {
  let y = msg[0];
  for (let i = 1; i < msg.length; i++) y = gfMul(y, x) ^ msg[i];
  return y;
}

// Evaluate a lowest-degree-first polynomial at x.
function polyEvalLow(p, x) {
  let y = 0;
  let xp = 1;
  for (let i = 0; i < p.length; i++) {
    y ^= gfMul(p[i], xp);
    xp = gfMul(xp, x);
  }
  return y;
}

function polyMulLow(a, b) {
  const out = new Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === 0) continue;
    for (let j = 0; j < b.length; j++) out[i + j] ^= gfMul(a[i], b[j]);
  }
  return out;
}

function trim(p) {
  while (p.length > 1 && p[p.length - 1] === 0) p.pop();
  return p;
}

// out = a(x) + c * x^shift * b(x)   (lowest-first)
function xorScaledShift(a, b, c, shift) {
  const out = a.slice();
  while (out.length < b.length + shift) out.push(0);
  for (let i = 0; i < b.length; i++) out[i + shift] ^= gfMul(c, b[i]);
  return trim(out);
}

function calcSyndromes(cw, ecCount) {
  const synd = new Array(ecCount);
  let allZero = true;
  for (let j = 0; j < ecCount; j++) {
    const s = polyEvalHigh(cw, EXP[j]);
    synd[j] = s;
    if (s !== 0) allZero = false;
  }
  return { synd, allZero };
}

// Errors-and-erasures Berlekamp-Massey. gamma is the erasure locator
// (lowest-first, degree = numErasures); Lambda and B start from it, and the
// iteration begins after the first numErasures syndromes.
function berlekampMassey(synd, ecCount, gamma, numErasures) {
  let Lambda = gamma.slice();
  let B = gamma.slice();
  let L = numErasures;
  let m = 1;
  let b = 1;
  for (let r = numErasures; r < ecCount; r++) {
    let delta = 0;
    for (let i = 0; i < Lambda.length && i <= r; i++) {
      delta ^= gfMul(Lambda[i], synd[r - i]);
    }
    if (delta === 0) {
      m++;
      continue;
    }
    if (2 * L <= r + numErasures) {
      const T = Lambda.slice();
      Lambda = xorScaledShift(Lambda, B, gfDiv(delta, b), m);
      L = r + 1 - L + numErasures;
      B = T;
      b = delta;
      m = 1;
    } else {
      Lambda = xorScaledShift(Lambda, B, gfDiv(delta, b), m);
      m++;
    }
  }
  return trim(Lambda);
}

// Chien search: return the position values p (powers of x, i.e. p = n-1-index)
// where Lambda(alpha^{-p}) === 0, or null if the root count does not match
// the locator degree.
function findErrataPositions(Lambda, n) {
  const degree = Lambda.length - 1;
  const positions = [];
  for (let p = 0; p < n; p++) {
    const xinv = EXP[(255 - (p % 255)) % 255]; // alpha^{-p}
    if (polyEvalLow(Lambda, xinv) === 0) positions.push(p);
  }
  return positions.length === degree ? positions : null;
}

// Omega(x) = S(x) * Lambda(x) mod x^ecCount   (lowest-first)
function computeOmega(synd, Lambda, ecCount) {
  const out = new Array(ecCount).fill(0);
  for (let i = 0; i < Lambda.length; i++) {
    if (Lambda[i] === 0) continue;
    for (let j = 0; j < synd.length && i + j < ecCount; j++) {
      out[i + j] ^= gfMul(Lambda[i], synd[j]);
    }
  }
  return trim(out);
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

// codewords: Uint8Array of data followed by ec (length n = k + ecCount).
// erasures: array of known-bad positions, as indices into `codewords`.
// Returns { data: Uint8Array (corrected data part), corrected: number }.
// Throws Error('unrecoverable') when correction fails; success is verified
// by recomputing all syndromes on the corrected codeword.
export function rsDecode(codewords, ecCount, erasures = []) {
  const n = codewords.length;
  const dataLen = n - ecCount;
  if (!Number.isInteger(ecCount) || ecCount <= 0 || dataLen < 0 || n > 255) {
    throw new Error('unrecoverable');
  }
  const cw = Uint8Array.from(codewords);

  const erasSet = [...new Set(erasures)];
  for (const e of erasSet) {
    if (!Number.isInteger(e) || e < 0 || e >= n) throw new Error('unrecoverable');
  }
  if (erasSet.length > ecCount) throw new Error('unrecoverable');

  const first = calcSyndromes(cw, ecCount);
  if (first.allZero) {
    return { data: cw.slice(0, dataLen), corrected: 0 };
  }
  const synd = first.synd;

  // Erasure locator Gamma(x) = prod (1 + X_j x), X_j = alpha^{n-1-index}.
  let gamma = [1];
  for (const e of erasSet) {
    gamma = polyMulLow(gamma, [1, EXP[(n - 1 - e) % 255]]);
  }

  const Lambda = berlekampMassey(synd, ecCount, gamma, erasSet.length);
  const degree = Lambda.length - 1;
  // Capacity: 2*errors + erasures <= ecCount, errors = degree - erasures.
  if (2 * degree - erasSet.length > ecCount) throw new Error('unrecoverable');

  const positions = findErrataPositions(Lambda, n);
  if (!positions) throw new Error('unrecoverable');

  const omega = computeOmega(synd, Lambda, ecCount);

  // Forney: e = X * Omega(X^{-1}) / Lambda'(X^{-1})   (roots at alpha^0..,
  // i.e. b = 0, so the extra factor is X itself).
  let corrected = 0;
  for (const p of positions) {
    const X = EXP[p % 255];
    const Xinv = EXP[(255 - (p % 255)) % 255];
    const Xinv2 = gfMul(Xinv, Xinv);
    // Formal derivative: only odd-degree terms of Lambda survive.
    let lp = 0;
    let xpow = 1; // Xinv^(i-1) for i = 1, 3, 5, ...
    for (let i = 1; i < Lambda.length; i += 2) {
      lp ^= gfMul(Lambda[i], xpow);
      xpow = gfMul(xpow, Xinv2);
    }
    if (lp === 0) throw new Error('unrecoverable');
    const magnitude = gfMul(X, gfDiv(polyEvalLow(omega, Xinv), lp));
    if (magnitude !== 0) {
      cw[n - 1 - p] ^= magnitude;
      corrected++;
    }
  }

  const recheck = calcSyndromes(cw, ecCount);
  if (!recheck.allZero) throw new Error('unrecoverable');

  return { data: cw.slice(0, dataLen), corrected };
}
