#!/usr/bin/env node
// Exhaustive marker combination matrix.
//
//   node test/markers.matrix.mjs             fast tier  (a geometry-spanning subset of dishes)
//   FULL=1 node test/markers.matrix.mjs      every dish x every combination
//   CALIBRATE=1 node test/markers.matrix.mjs re-derive MARKER_GAP from the artwork
//
// Design note. One export sets the SAME combination on EVERY dish, so 64 exports cover all 2368
// dish-cases and — more importantly — every assertion is made against a FULL PAGE with all dishes
// re-stamped at once. That is deliberate: the previous "re-stamp everything" attempt printed six
// markers on every dish and pushed badges onto the prices, and it survived because the checks of
// the day were per-dish. Per-dish checks passing while the page is visibly wrong is the exact
// failure mode this file exists to catch.
//
// Everything is measured from RENDERED INK (test/lib/markers.mjs), never from the layout code
// being tested — a spacing assertion written in terms of iconBox() would happily agree with
// iconBox()'s own errors.
import { createRequire } from 'module';
import { bootEditor, exportBytes } from './lib/engine.mjs';
import { inkRuns, mergeRuns, gapsOf, markerBand, measureNameRight, rowContext,
         subtractBackground, strandedInk } from './lib/markers.mjs';

const require = createRequire(import.meta.url);
const path = require('path');
const { ROOT } = require('./lib/out.js');
const { operatorBalance, pageStreams, checkUncompressed } = require('./lib/pdf.js');

const FULL = !!process.env.FULL;
const CALIBRATE = !!process.env.CALIBRATE;
const DIR = path.join(ROOT, 'deploy', 'public', 'capiche');

/* DPI matters to the assertions, not just to speed. At 600dpi one pixel is 0.12pt, so a perfectly
   uniform row still measures as 2.040 / 2.160 / 2.040 — a 0.12pt "spread" that is pure raster
   quantisation. Measuring at 1200dpi puts a pixel at 0.06pt, so a 0.10pt tolerance is comfortably
   above the noise floor and still far below any real spacing error (the defects this replaces were
   0.36-0.52pt). */
const DPI = 1200;
/* Tolerance for RENDER-vs-layout agreement only. Two independently-quantised ink edges plus the
   ink/no-ink threshold give ~±0.12pt at this DPI; 0.20 sits above that and still far below the
   0.36-0.52pt errors this work removed. Exact spacing is asserted on the layout, not here. */
const RASTER_TOL = 0.20;

const results = [];
const rec = (name, ok, detail) => { results.push({ name, ok, detail }); if (!ok) console.log(`  FAIL  ${name} — ${detail}`); };

const E = await bootEditor(DIR);
const TYPES = E.bind.MARKER_TYPES;
const GEOM_GAP = E.bind.MARKER_GAP;
const FIELD = {}; for (const f of E.FM.fields) FIELD[f.id] = f;
const dishes = E.FM.fields.filter(f => f.role === 'name' && f.markerBase);

console.log(`\nCapiche marker matrix  (${FULL ? 'FULL' : 'fast'} mode)`);
console.log(`  markers ${TYPES.join(', ')}  ->  ${1 << TYPES.length} combinations`);
console.log('-'.repeat(78));

// ---- per-dish measurement context, from a render with no markers anywhere --------------------
E.reset();
for (const f of dishes) E.setMarkers(f.id, []);
const bare = await exportBytes(E);
const CTX = {};
for (const f of dishes) {
  const { desc, priceLeft } = rowContext(E.FM, f);
  const wide = markerBand(f, { desc, priceLeft, nameRight: f.x - 2 });
  const nameRight = wide.x1 > wide.x0 ? measureNameRight(bare, f, wide) : f.x;
  /* The band starts LEFT of where the row can possibly begin, not at the name's right edge.
     Anchoring it to the name was wrong twice over: MuPDF's 'preserve-whitespace' text bbox
     includes a name's TRAILING SPACE (CHILLI BUTTER CORN has one), which put the band 2.8pt inside
     the first marker and measured a 3.72pt bottle as 0.90pt; and on dishes with un-removable baked
     artwork the "name edge" was the stray artwork. Name ink inside the band is removed by
     background subtraction instead, which needs no assumption about where the name ends. */
  const band = markerBand(f, { desc, priceLeft, nameRight: E.bind.clusterStart(f) - 1.8 });
  /* Widen past the price so an overrun is MEASURED rather than silently clipped out of the window.
     Where a dish has no price in its own column, bound the window by what a marker row could
     possibly occupy instead — the widest set is 52.8pt, so clusterStart+75 is generous. An earlier
     `f.x + 265` fallback reached 178pt across the page and reported the NEXT COLUMN's markers as
     un-removable artwork on BUTTER GARLIC MUSHROOMS. */
  const x1 = priceLeft != null ? priceLeft + 45 : E.bind.clusterStart(f) + 75;
  CTX[f.id] = { f, desc, priceLeft, nameRight, band: { ...band, x1 } };
}

// price INK left edge (the fieldmap x is the text origin; ink is what collides)
for (const f of dishes) {
  const c = CTX[f.id];
  if (c.priceLeft == null) { c.priceInk = null; continue; }
  const runs = inkRuns(bare, f.page, { ...c.band, x0: c.priceLeft - 1.5, dpi: DPI });
  c.priceInk = runs.length ? runs[0].x0 : c.priceLeft;
}
// what is already in the row with nothing selected: name overhang, and un-removable baked artwork
for (const f of dishes) {
  const c = CTX[f.id];
  const all = mergeRuns(inkRuns(bare, f.page, { ...c.band, dpi: DPI }), 0.4);
  c.background = c.priceInk == null ? all : all.filter(k => k.x0 < c.priceInk - 0.15);
  c.stranded = strandedInk(c.background, c.nameRight);
}

const clustersFor = (pdf, c) => {
  const all = mergeRuns(inkRuns(pdf, c.f.page, { ...c.band, dpi: DPI }), 0.4);
  const inRow = c.priceInk == null ? all : all.filter(k => k.x0 < c.priceInk - 0.15);
  return subtractBackground(inRow, c.background);
};

// ---- CALIBRATE ------------------------------------------------------------------------------
if (CALIBRATE) {
  const W = {}; for (const t of TYPES) W[t] = E.bind.markerGeom(t).w;
  let best = Infinity, bind = null;
  for (const f of dishes) {
    const room = E.bind.markerRoom(f);
    if (!isFinite(room)) continue;
    for (let m = 1; m < (1 << TYPES.length); m++) {
      const sel = TYPES.filter((_, k) => (m >> k) & 1);
      const ink = sel.reduce((s, t) => s + W[t], 0), n = sel.length - 1;
      if (n < 1) continue;
      const g = (room - ink) / n;
      if (g < best) { best = g; bind = `${f.id} ${(f.display || '').trim()} / ${sel.join('+')}`; }
    }
  }
  console.log(`  ink widths ${JSON.stringify(Object.fromEntries(Object.entries(W).map(([k, v]) => [k, +v.toFixed(3)])))}`);
  console.log(`  largest uniform gap fitting EVERY combination on EVERY dish: ${best.toFixed(3)}pt`);
  console.log(`  bound by ${bind}`);
  console.log(`  (MARKER_GAP is ${GEOM_GAP}; combinations that exceed a dish's room are refused by markerFits)`);
  process.exit(0);
}

/* Rendered ink sits proud of the geometry by an antialiasing margin, so a geometric gap of G
   measures as G - bleed. MEASURE the bleed rather than assuming it: it depends on DPI and on the
   rasteriser, and a wrong constant turns every gap assertion into a false failure. Taken as the
   mean over the template markers, whose geometric widths come from the artwork's own path data. */
let BLEED = 0;
{
  const probe = dishes.find(f => E.bind.markerRoom(f) > 100) || dishes[0];
  const c = CTX[probe.id], samples = [];
  for (const t of ['dairy', 'gluten', 'spicy']) {
    E.reset(); E.setMarkers(probe.id, [t]);
    const cl = clustersFor(await exportBytes(E), c);   // NOT raw runs: the band deliberately
    if (cl.length === 1) samples.push(cl[0].w - E.bind.markerGeom(t).w);   // overshoots the price
  }
  BLEED = samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : 0;
  console.log(`  antialias bleed measured at ${DPI}dpi: ${BLEED.toFixed(3)}pt  (from ${samples.length} markers on ${probe.id})`);
}
const WANT_GAP = GEOM_GAP - BLEED;
console.log(`  geometric gap ${GEOM_GAP}pt  ->  expected in the raster ${WANT_GAP.toFixed(3)}pt ±${RASTER_TOL}\n`);

// ---- reference geometry: each marker alone, on every dish ------------------------------------
const REF = {};   // dishId -> markerId -> {x0,x1,w,top,bot}
for (const t of TYPES) {
  E.reset();
  const given = [];
  for (const f of dishes) if (E.bind.markerFits(f, new Set([t]))) { E.setMarkers(f.id, [t]); given.push(f); }
  const pdf = await exportBytes(E);
  for (const f of given) {
    const cl = clustersFor(pdf, CTX[f.id]);
    (REF[f.id] = REF[f.id] || {})[t] = cl.length === 1 ? cl[0] : null;
    if (cl.length !== 1) rec(`reference ${f.id} ${t}`, false, `expected 1 cluster, measured ${cl.length}`);
  }
}

// ---- the matrix ------------------------------------------------------------------------------
const subset = ['0:0', '0:26', '0:8', '1:27', '1:48', '1:9', '1:51', '1:36', '0:18', '1:60'];
const active = FULL ? dishes : dishes.filter(f => subset.includes(f.id));
console.log(`  dishes under test: ${active.length}${FULL ? '' : ` (fast subset: ${subset.join(', ')})`}`);

/* Artwork in the marker row that NO marker selection removes. Asserted once per dish rather than
   once per combination, so one fieldmap gap does not drown the run in 64 identical failures. */
const blocked = [];
for (const f of active) {
  const c = CTX[f.id];
  rec(`${f.id}: no un-removable marker artwork`, c.stranded.length === 0,
      c.stranded.map(s => `ink [${s.x0.toFixed(1)}..${s.x1.toFixed(1)}] (w ${s.w.toFixed(2)}) survives every marker being cleared`).join('; '));
  /* Layout cannot be measured on a row that contains artwork the engine does not know about: the
     stray ink merges with real markers and every downstream number is meaningless. Such dishes are
     reported ONCE, above, and excluded from the per-combination assertions — not silently, and not
     as 64 duplicate failures that would bury every other result. */
  if (c.stranded.length) blocked.push(f.id);
}
const measurable = active.filter(f => !blocked.includes(f.id));
if (blocked.length) console.log(`  layout NOT measurable on ${blocked.length} dish(es) — un-removable artwork in the row: ${blocked.join(', ')}\n`);

const unreachable = [];
let cases = 0;

for (let m = 0; m < (1 << TYPES.length); m++) {
  const combo = TYPES.filter((_, k) => (m >> k) & 1);
  const label = combo.length ? combo.join('+') : '(none)';

  E.reset();
  const given = [];
  for (const f of measurable) {
    const set = new Set(combo);
    if (combo.length && !E.bind.markerFits(f, set)) {
      unreachable.push({ dish: f.id, display: (f.display || '').trim(), combo: label,
                         need: E.bind.clusterWidth(set), room: E.bind.markerRoom(f) });
      continue;                       // the UI cannot reach this state; nothing to render
    }
    E.setMarkers(f.id, combo);
    given.push(f);
  }
  E.takeWarnings();
  const pdf = await exportBytes(E);

  // -- whole-file invariants, once per export
  const warns = E.takeWarnings().filter(w => /spliceBytes/.test(w));
  rec(`${label}: no dropped splice ops`, warns.length === 0, warns[0] || '');
  const streams = await pageStreams(pdf);
  for (let p = 0; p < streams.length; p++) {
    const b = operatorBalance(streams[p]);
    rec(`${label}: p${p} operators balanced`, b.ok, `q=${b.q} bt=${b.bt} welds=${b.welds}`);
    const s = streams[p].toString('latin1');
    rec(`${label}: p${p} no control bytes`, !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(s), 'control byte in stream');
  }

  // -- per dish
  for (const f of given) {
    cases++;
    const c = CTX[f.id];
    const cl = clustersFor(pdf, c);
    const tag = `${label} @ ${f.id}`;

    rec(`${tag}: marker count`, cl.length === combo.length,
        `measured ${cl.length} clusters, selected ${combo.length}`);
    if (cl.length !== combo.length) continue;
    if (!combo.length) continue;

    /* SPACING AND VERTICAL POSITION ARE ASSERTED ON THE LAYOUT ITSELF, EXACTLY.
       They are geometric facts, and a rasteriser cannot confirm them to the precision the
       requirement needs: at 1200dpi an ink edge quantises to 0.06pt and each of a gap's two edges
       rounds independently, so a provably uniform row still measures 2.04 / 2.10 / 2.16 / 2.22.
       Chasing that with a looser tolerance would only have made the test blind to real 0.1pt
       errors. layoutMarkers() is pure, so it is checked at 1e-9 and the render is then used for
       what only a render can show: that the markers are actually drawn, are the right artwork,
       are in the right order, and hit nothing. */
    const L = E.bind.layoutMarkers(new Set(combo), 0, 0);
    const lg = L.slice(1).map((m, i) => m.inkLeft - L[i].inkRight);
    rec(`${tag}: uniform gaps (layout, exact)`, lg.every(v => Math.abs(v - GEOM_GAP) < 1e-9),
        `[${lg.map(v => v.toFixed(6)).join(', ')}] vs ${GEOM_GAP}`);
    // vertical position must be a function of the marker alone, never of which siblings are present
    const solo = Object.fromEntries(TYPES.map(t => [t, E.bind.layoutMarkers(new Set([t]), 0, 0)[0]]));
    const badV = L.map(m => {
      const s = solo[m.id];
      return (s && Math.abs(m.mid - m.geom.cy - (s.mid - s.geom.cy)) > 1e-9)
        ? `${m.id} y depends on its siblings` : null;
    }).filter(Boolean);
    rec(`${tag}: vertical invariance (layout, exact)`, !badV.length, badV.join('; '));

    // the render must agree with the layout on WIDTH ORDER — this is what catches wrong artwork
    const wrong = combo.map((t, i) => {
      const want = E.bind.markerGeom(t).w + BLEED;
      return Math.abs(cl[i].w - want) > 0.5
        ? `slot ${i} expected ${t} (w~${want.toFixed(2)}) but ink is ${cl[i].w.toFixed(2)}` : null;
    }).filter(Boolean);
    rec(`${tag}: print order`, !wrong.length, wrong.join('; '));

    // and the emitter must not drift from the layout by more than rasterisation can explain
    const g = gapsOf(cl);
    const drift = g.filter(v => Math.abs(v - WANT_GAP) > RASTER_TOL);
    rec(`${tag}: rendered gaps match the layout`, !drift.length,
        `[${g.map(v => v.toFixed(3)).join(', ')}] vs ${WANT_GAP.toFixed(3)}±${RASTER_TOL}`);

    // no collision with the price
    if (c.priceInk != null) {
      const slack = c.priceInk - cl[cl.length - 1].x1;
      rec(`${tag}: price clearance`, slack >= 0,
          `clusterRight ${cl[cl.length - 1].x1.toFixed(2)} vs price ink ${c.priceInk.toFixed(2)} — slack ${slack.toFixed(2)}pt`);
    }
    // no collision with the dish name
    rec(`${tag}: clears the name`, cl[0].x0 >= c.nameRight,
        `cluster starts ${cl[0].x0.toFixed(2)}, name ink ends ${c.nameRight.toFixed(2)}`);
  }
}

// ---- report -----------------------------------------------------------------------------------
const failed = results.filter(r => !r.ok);
console.log('-'.repeat(78));
console.log(`  ${results.length - failed.length} passed   ${failed.length} failed   (${cases} dish-cases, ${1 << TYPES.length} combinations)`);

if (unreachable.length) {
  const byDish = {};
  for (const u of unreachable) (byDish[u.dish] = byDish[u.dish] || []).push(u);
  console.log(`\n  UNREACHABLE STATES — refused by markerFits(), never rendered, never silently skipped:`);
  for (const [id, list] of Object.entries(byDish)) {
    const room = list[0].room, worst = Math.max(...list.map(u => u.need));
    console.log(`    ${id} ${list[0].display.slice(0, 24).padEnd(25)} ${String(list.length).padStart(2)} of ${(1 << TYPES.length) - 1} combos — ` +
                `room ${room.toFixed(1)}pt, widest refused set needs ${worst.toFixed(1)}pt`);
    console.log(`        every refused set contains: ${TYPES.filter(t => list.every(u => u.combo.split('+').includes(t))).join(', ') || '(no common marker)'}`);
  }
}
console.log('');
process.exit(failed.length ? 1 : 0);
