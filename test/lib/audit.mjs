// Layout audits over a RENDERED export. These read the PDF the way a customer does, which is the
// only way to catch the failures HARD RULE 4 lists: overlap, clipping, dropped letters, markers
// landing on the wrong row.
import { textLines } from './render.mjs';

/**
 * Text lines that physically collide (overlap both vertically AND horizontally).
 * `menuMaxX` ignores the photo rail, whose overlays legitimately sit on top of imagery.
 */
export function overlaps(src, page = 0, { menuMaxX = Infinity, tol = 0.01 } = {}) {
  const L = textLines(src, page).filter(l => l.x0 < menuMaxX);
  const hits = [];
  for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) {
    const a = L[i], b = L[j];
    if (b.top <= a.bot + tol) continue;                       // b starts at/below a's bottom
    if (Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 0.5)    // and they share x
      hits.push({ a: a.text, b: b.text, aBox: [a.bot, a.top], bBox: [b.bot, b.top] });
  }
  return hits;
}

/**
 * Lines that break out of their row box. Rows come from `photo_tile` — the drinks menus' real row
 * grid, which is also where the divider rules are drawn (reflow_data.py derives `pitch` from it).
 * Only meaningful for editors whose fieldmap carries photo_tile (capiche-surat / capiche-ahm).
 */
export function rowBoxCrossings(src, fmPage, page = 0, { menuMaxX = Infinity, tol = 0.75 } = {}) {
  const boxes = (fmPage.items || [])
    .filter(it => it.photo_tile && it.photo_tile.length === 4)
    .map(it => ({ name: it.name, bot: it.photo_tile[1], top: it.photo_tile[1] + it.photo_tile[3] }));
  if (!boxes.length) return [];
  const out = [];
  for (const l of textLines(src, page)) {
    if (l.x0 >= menuMaxX) continue;
    if (boxes.some(b => l.bot >= b.bot - tol && l.top <= b.top + tol)) continue;
    const spans = boxes.filter(b => l.top > b.bot && l.bot < b.top).map(b => b.name);
    out.push({ text: l.text, ink: [l.bot, l.top], spansRows: spans });
  }
  return out;
}

/** Compare against a baseline render; report only findings the baseline did NOT already have. */
export function newFindings(baseline, current) {
  const key = o => JSON.stringify(o);
  const seen = new Set(baseline.map(key));
  return current.filter(o => !seen.has(key(o)));
}

/** Does this rendered page contain the given text at all? (dropped-letter / missing-content check) */
export function hasText(src, page, needle) {
  return textLines(src, page).some(l => l.text.includes(needle));
}

/**
 * Vertical clearance, in points, between the ink of two rendered lines: how far the LOWEST line
 * matching `aNeedle` sits above the topmost line matching `bNeedle`. Positive means `a` clears `b`;
 * <= 0 means they touch or overlap. `overlaps()` only reports pairs that also share x, so this is
 * the sharper assertion when you know exactly which two things must not collide.
 * Returns null if either needle is absent — callers should treat that as a failure, not a pass.
 */
export function clearance(src, page, aNeedle, bNeedle) {
  const L = textLines(src, page);
  const a = L.filter(l => l.text.includes(aNeedle)).pop();
  const b = L.find(l => l.text.includes(bNeedle));
  return (a && b) ? +(a.bot - b.top).toFixed(3) : null;
}

/** Every rendered line whose text matches, as ink boxes — for counting duplicates of stamped art. */
export function linesMatching(src, page, re) {
  return textLines(src, page).filter(l => re.test(l.text));
}
