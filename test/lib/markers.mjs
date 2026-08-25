// Measure a marker cluster the way a customer sees it: from rendered ink, not from bytes.
//
// Why pixels rather than the content stream. Only one Capiche marker (the Jain "J") is text, so
// `textLines()` cannot see the other five at all; and the whole class of bug being fixed here is
// "the bytes are valid, the placement is wrong". Byte checks are what let the ADD-font corruption
// ship (CLAUDE.md HARD RULE 4). Reading ink also means the assertions do not depend on the layout
// code they are testing — a spacing test written in terms of `iconBox()` would happily agree with
// `iconBox()`'s own 0.52pt error.
//
// Measured baked geometry that calibrates the defaults below (Capiche, page 0, 600dpi):
//   MARGHERITA     dairy 3.720 | gap 2.280 | gluten 4.680 | gap 0.960 | J 4.080
//   CHILLI BUTTER  dairy 3.840 | gap 2.160 | gluten 4.680 | gap 0.960 | J 4.080 | gap 1.800 |
//                  NEW badge 20.040   then 3.960pt to the price
// The NEW badge reads as ONE run: its starburst overlaps its letters, so there is no empty column
// inside it. That is what makes column segmentation viable at all.
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const fs = require('fs');
const mupdf = await import('mupdf');

const openDoc = (src) => mupdf.Document.openDocument(
  src instanceof Uint8Array || Buffer.isBuffer(src) ? new Uint8Array(src) : fs.readFileSync(src),
  'application/pdf');

/**
 * Ink runs inside a region, in PDF user space (y UP), left to right.
 *
 * A "run" is a maximal band of pixel columns containing ink. Runs are split on ANY empty column
 * and merged afterwards by the caller, because the right merge distance is a property of the
 * artwork, not of this function.
 *
 * @returns [{x0, x1, w, top, bot, h}]
 */
export function inkRuns(src, page, { x0, x1, yTop, yBot, dpi = 600, threshold = 240 }) {
  const doc = openDoc(src), pg = doc.loadPage(page);
  const H = pg.getBounds()[3], s = dpi / 72;
  const rect = [x0 * s, (H - yTop) * s, x1 * s, (H - yBot) * s].map(Math.round);
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, rect, false);
  pix.clear(255);
  const dev = new mupdf.DrawDevice(mupdf.Matrix.scale(s, s), pix);
  pg.run(dev, mupdf.Matrix.identity);
  dev.close();

  const W = pix.getWidth(), Hp = pix.getHeight(), px = pix.getPixels();
  const n = pix.getNumberOfComponents();
  const inked = (cx, cy) => {
    const o = (cy * W + cx) * n;
    return px[o] < threshold || px[o + 1] < threshold || px[o + 2] < threshold;
  };

  const runs = [];
  let cur = null;
  for (let cx = 0; cx < W; cx++) {
    let any = false, top = -1, bot = -1;
    for (let cy = 0; cy < Hp; cy++) {
      if (!inked(cx, cy)) continue;
      any = true; if (top < 0) top = cy; bot = cy;
    }
    if (any) {
      if (!cur) cur = { a: cx, b: cx, t: top, u: bot };
      else { cur.b = cx; cur.t = Math.min(cur.t, top); cur.u = Math.max(cur.u, bot); }
    } else if (cur) { runs.push(cur); cur = null; }
  }
  if (cur) runs.push(cur);

  // back to PDF user space; y is up, so the pixel TOP row is the larger y
  return runs.map(r => {
    const px0 = x0 + r.a / s, px1 = x0 + (r.b + 1) / s;
    const pTop = yTop - r.t / s, pBot = yTop - (r.u + 1) / s;
    return { x0: px0, x1: px1, w: px1 - px0, top: pTop, bot: pBot, h: pTop - pBot };
  });
}

/**
 * The window a dish's marker cluster can occupy: right of the name, left of the price, and
 * vertically between the description's ascenders and the top of the tallest marker.
 *
 * Getting this wrong is the easiest way to measure the wrong thing. A first attempt used
 * `yBot = name.y - 6`, which reached 531.06 while MARGHERITA's description tops out at 531.1 — so
 * every "marker" measurement was actually reading the description text, identically for all six
 * marker types. The band is therefore derived from the neighbouring fields, not from a constant.
 *
 * `nameRight` is not computed from the engine's own advance model (that would make the test agree
 * with the code it is testing); pass the value measured from a zero-marker render, via
 * `measureNameRight()`.
 */
export function markerBand(field, { desc, priceLeft, nameRight, topPad = 14, floorPad = 4 } = {}) {
  const descTop = desc ? desc.y + (desc.size || 6.5) * 0.78 : -Infinity;
  /* A WRAPPED name bakes its markers beside its LAST line, not its first — the engine anchors them
     at `markerBase[1] - (lines-1)*size*1.2`. `field.y` is the first line, so a band built on it sits
     ~15.6pt above the markers of any 2-line dish and measures nothing at all (BUTTER GARLIC
     MUSHROOMS, STICKY TOFFEE PUDDING, PISTACHIO MOUSSE CAKE, CHOCOLATE CRUNCH CAKE,
     CARAMELISED ONION PASTA). Track the same baseline the engine stamps against. */
  const nLines = (field.lines || []).length || 1;
  const base = field.y - (nLines - 1) * (field.size || 13) * 1.2;
  return {
    x0: (nameRight != null ? nameRight + 0.3 : field.markerBase[0] - 10),
    x1: (priceLeft != null ? priceLeft - 0.3 : field.markerBase[0] + 90),
    yTop: base + topPad,
    // stay clear of the description, but never clip the NEW badge, whose ink dips below the baseline
    yBot: Math.max(base - floorPad, descTop + 0.4),
  };
}

/**
 * The neighbouring fields that bound a dish's marker cluster: its description (below) and the
 * first price to its RIGHT.
 *
 * The price must be selected by "first one right of the cluster anchor", not "leftmost on the row".
 * The food pages are multi-column, so a dish on page 1 shares its y with prices belonging to a
 * different column entirely — picking the leftmost gave CASSATA a priceLeft of 245.21 while its own
 * name ends at 587.24, i.e. a negative-width search band and zero markers found.
 */
export function rowContext(FM, field, { rowTol = 8, descGap = 26, colReach = 200 } = {}) {
  const anchor = field.markerBase ? field.markerBase[0] : field.x;
  const sameRow = q => q.page === field.page && Math.abs(q.y - field.y) < rowTol;
  /* `colReach` keeps the search inside the dish's own COLUMN. These pages are multi-column, so a
     price sharing a dish's y can belong to a different column entirely: BUTTER GARLIC MUSHROOMS
     (name x 27.97) would otherwise adopt a price 410pt away at x 529.66, giving it a 410pt-wide
     "marker band" that sweeps across the neighbouring column. No marker row is anywhere near that
     wide, so anything beyond colReach is another column's price, not this dish's. */
  const prices = FM.fields.filter(q => q.role === 'price' && sameRow(q) && q.x > anchor && q.x - anchor <= colReach)
    .sort((a, b) => a.x - b.x);
  const desc = FM.fields.find(q => q.role === 'desc' && q.page === field.page &&
                                   Math.abs(q.x - field.x) < 40 && q.y < field.y && field.y - q.y < descGap);
  return { desc, price: prices[0] || null, priceLeft: prices.length ? prices[0].x : null };
}

/**
 * Where the dish name's ink really ends, measured from a render with every marker cleared.
 *
 * Uses the TEXT layer, not the rightmost ink. Rightmost-ink was wrong: eight dishes carry a baked
 * chilli that `fieldmap.json` never recorded, so clearing the markers leaves it stranded on the row
 * and "the last ink run" was the abandoned chilli rather than the name — putting the search band
 * to the RIGHT of the very markers it was supposed to measure, on exactly those dishes.
 * The name is text and the markers are vector (bar the Jain "J", which is absent from a
 * markers-cleared render), so the text layer is unambiguous here.
 */
export function measureNameRight(pdfNoMarkers, field, band) {
  const nLines = (field.lines || []).length || 1;
  const base = field.y - (nLines - 1) * (field.size || 13) * 1.2;   // markers sit beside the LAST line
  const rows = textLines(pdfNoMarkers, field.page)
    .filter(l => Math.abs(l.bot - base) < 7 && l.x0 > field.x - 6 && l.x0 < field.x + 40);
  /* Discount TRAILING SPACES. Structured text is extracted with 'preserve-whitespace', so the line
     bbox covers a trailing space's advance as if it were ink: "CHILLI BUTTER CORN " reported its
     name ending at 409.00 when the last glyph actually stops near 400.6, which then read as the
     marker row overlapping the name. The per-character width is derived from the line itself
     rather than a brand constant, which is exact for these monospaced faces. */
  if (rows.length) return Math.max(...rows.map(l => {
    const trail = (l.raw || '').length - (l.raw || '').replace(/\s+$/, '').length;
    const per = (l.raw || '').length ? (l.x1 - l.x0) / (l.raw || '').length : 0;
    return l.x1 - trail * per;
  }));
  const runs = inkRuns(pdfNoMarkers, field.page, band);   // fallback: a name that did not resolve as text
  return runs.length ? runs[runs.length - 1].x1 : field.x;
}

/**
 * Merge adjacent ink runs separated by less than `mergeGap` into one glyph-level cluster.
 *
 * Needed because some artwork is drawn as several disjoint sub-paths. The threshold is a judgement
 * call and is therefore explicit rather than hidden: it must sit ABOVE the largest gap inside a
 * single marker and BELOW the smallest gap between two markers. `calibrateMergeGap()` derives it
 * from isolated renders instead of guessing.
 */
export function mergeRuns(runs, mergeGap) {
  const out = [];
  for (const r of runs) {
    const last = out[out.length - 1];
    if (last && r.x0 - last.x1 < mergeGap) {
      last.x1 = r.x1; last.w = last.x1 - last.x0;
      last.top = Math.max(last.top, r.top); last.bot = Math.min(last.bot, r.bot);
      last.h = last.top - last.bot;
      last.parts++;
    } else out.push({ ...r, parts: 1 });
  }
  return out;
}

/** Gaps between consecutive clusters, ink edge to ink edge. */
export const gapsOf = (clusters) => clusters.slice(1).map((c, i) => c.x0 - clusters[i].x1);

/**
 * Drop ink that is already present with NO markers selected, so what remains is only what the
 * marker pass drew.
 *
 * Two kinds of background make a positional band unreliable on its own: the dish name's ink can
 * reach past where the text layer says the line ends, and eight dishes carry a baked chilli that
 * `fieldmap.json` never recorded, which survives every marker being cleared. Subtracting a
 * zero-marker render removes both without needing to guess where the row "should" start.
 * Background that lands in the row is not swept under the carpet — `strandedInk()` reports it.
 */
export function subtractBackground(runs, background, tol = 0.2) {
  return runs.filter(r => !background.some(b => Math.abs(b.x0 - r.x0) <= tol && Math.abs(b.x1 - r.x1) <= tol));
}

/** Ink sitting in the marker row when NO marker is selected — i.e. artwork nothing can remove. */
export function strandedInk(background, nameRight, tol = 0.3) {
  return background.filter(b => b.x0 > nameRight + tol);
}

/**
 * Derive a safe merge distance from per-marker isolated renders.
 *
 * @param {object} solo  markerId -> ink runs from a render with ONLY that marker present
 * @returns {{ mergeGap, maxInternal, detail }}  maxInternal is the widest gap seen inside any
 *          single marker; a caller whose inter-marker gap is not comfortably above it has no
 *          reliable way to segment and should say so rather than pick a number.
 */
export function calibrateMergeGap(solo) {
  let maxInternal = 0, worst = null;
  for (const [id, runs] of Object.entries(solo)) {
    for (let i = 1; i < runs.length; i++) {
      const g = runs[i].x0 - runs[i - 1].x1;
      if (g > maxInternal) { maxInternal = g; worst = id; }
    }
  }
  return { mergeGap: maxInternal + 0.4, maxInternal, worst,
           detail: worst ? `widest internal gap ${maxInternal.toFixed(3)}pt (${worst})`
                         : 'every marker draws as a single run' };
}

/** Text lines on a page, PDF user space, y UP — thin wrapper so callers need only this module. */
export function textLines(src, page = 0) {
  const doc = openDoc(src), pg = doc.loadPage(page), H = pg.getBounds()[3];
  const st = JSON.parse(pg.toStructuredText('preserve-whitespace').asJSON());
  const rows = [];
  for (const blk of st.blocks || []) for (const ln of blk.lines || []) {
    const raw = ln.text || '';
    const t = raw.trim(); if (!t) continue;
    const b = ln.bbox;
    rows.push({ text: t, raw, x0: b.x, x1: b.x + b.w, top: H - b.y, bot: H - (b.y + b.h) });
  }
  return rows.sort((a, b) => b.top - a.top);
}

// ---------------------------------------------------------------------------------------------
// Assertions. Each returns {ok, detail} so a caller can report the measurement either way — a
// bare boolean makes a failure impossible to diagnose from the log.
// ---------------------------------------------------------------------------------------------

/** Every gap equals `want` within `tol`. */
export function gapsUniform(clusters, want, tol = 0.05) {
  const g = gapsOf(clusters);
  if (g.length === 0) return { ok: true, detail: 'single marker — no gap to check', gaps: g };
  const bad = g.filter(v => Math.abs(v - want) > tol);
  return { ok: !bad.length, gaps: g,
           detail: `gaps [${g.map(v => v.toFixed(3)).join(', ')}] vs ${want.toFixed(3)}±${tol}` };
}

/**
 * A marker's vertical ink extent must not move when siblings are added or removed
 * (master plan §7). Compared against the singleton render of the same marker.
 */
export function verticalInvariant(observed, reference, tol = 0.05) {
  const dTop = Math.abs(observed.top - reference.top), dBot = Math.abs(observed.bot - reference.bot);
  return { ok: dTop <= tol && dBot <= tol,
           detail: `top ${observed.top.toFixed(3)} vs ${reference.top.toFixed(3)} (Δ${dTop.toFixed(3)}), ` +
                   `bot ${observed.bot.toFixed(3)} vs ${reference.bot.toFixed(3)} (Δ${dBot.toFixed(3)})` };
}

/** The cluster must stop before the price column (master plan §9). */
export function priceClearance(clusters, priceLeft, required) {
  if (!clusters.length) return { ok: true, detail: 'no markers', slack: Infinity };
  const right = clusters[clusters.length - 1].x1;
  const slack = priceLeft - right;
  return { ok: slack >= required, slack,
           detail: `clusterRight ${right.toFixed(2)} vs priceLeft ${priceLeft.toFixed(2)} — slack ${slack.toFixed(2)}pt (need ${required})` };
}

/**
 * Left-to-right order matches the declared print order, matched by ink width against each
 * marker's isolated signature. Width alone is ambiguous when two markers are within `tol`, so
 * ambiguous pairs are reported rather than silently "matched".
 */
export function markerOrder(clusters, expectedIds, signature, tol = 0.35) {
  if (clusters.length !== expectedIds.length) {
    return { ok: false, detail: `${clusters.length} clusters vs ${expectedIds.length} markers selected` };
  }
  const bad = [];
  expectedIds.forEach((id, i) => {
    const want = signature[id];
    if (!want) { bad.push(`${id}: no signature`); return; }
    const dw = Math.abs(clusters[i].w - want.w);
    if (dw > tol) bad.push(`slot ${i} expected ${id} (w ${want.w.toFixed(2)}) but ink is ${clusters[i].w.toFixed(2)}`);
  });
  return { ok: !bad.length, detail: bad.length ? bad.join('; ') : `order ${expectedIds.join(' → ')}` };
}
