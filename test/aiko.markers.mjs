#!/usr/bin/env node
// AIKO — marker correctness.
//
//   node test/aiko.markers.mjs
//
// Aiko is not a Capiche variant: its geometry is declared per marker in `add_const.marker_geo`
// rather than measured, it keeps a byte-faithful move-only path for unchanged marker sets, and its
// Korea flag is harvested from the artwork at runtime. These checks pin the three defects found in
// the Phase 2 audit and the invariants that were only holding by luck.
import { createRequire } from 'module';
import { bootEditor, exportBytes } from './lib/engine.mjs';
import { inkRuns, mergeRuns } from './lib/markers.mjs';

const require = createRequire(import.meta.url);
const path = require('path');
const fs = require('fs');
const { ROOT } = require('./lib/out.js');
const { pageStreams, operatorBalance } = require('./lib/pdf.js');

const DIR = path.join(ROOT, 'deploy', 'public', 'aiko');
const results = [];
const rec = (n, ok, d) => { results.push({ n, ok, d }); if (!ok) console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`); };
const head = t => console.log(`\n${t}\n${'-'.repeat(t.length)}`);

const E = await bootEditor(DIR, { expose: ['markerAnchor', 'markerGeomFor', 'templateBox', 'pageColumns'] });
const F = {}; for (const f of E.FM.fields) F[f.id] = f;
const names = E.FM.fields.filter(f => f.role === 'name');
const boot = E.takeWarnings();
console.log(`\nAIKO markers — ${names.length} dishes`);

// ---------------------------------------------------------------------------------------------
head('1. Every marker anchor sits on its own dish, in its own column');
{
  /* The fieldmap gave SRI LANKAN CURRY (0:63, x 26.99) a marker_bx of 435.87 — copied from AVO
     CRISPY RICE, its row-neighbour in the NEXT column, whose anchor is 433.84. Toggling any marker
     stamped dairy and gluten onto that neighbour: allergen icons on the wrong dish. */
  let bad = [];
  for (const f of names) {
    const a = E.bind.markerAnchor(f);
    const col = (E.bind.pageColumns(f.page) || []).find(c => f.x >= c.min && f.x < c.max);
    if (col && (a < col.min || a >= col.max)) bad.push(`${f.id} anchor ${a.toFixed(1)} outside its column [${col.min}..${col.max}]`);
    else if (a < f.x) bad.push(`${f.id} anchor ${a.toFixed(1)} left of its name x ${f.x}`);
  }
  rec('no dish anchors its markers outside its own column', !bad.length, bad.slice(0, 3).join('; '));

  // and the specific dish, end to end: its icons must render on ITS row, not the neighbour's
  const f = F['0:63'], nb = names.find(q => q.page === f.page && Math.abs(q.y - f.y) < 1 && q.id !== f.id);
  E.reset(); E.setMarkers('0:63', ['dairy', 'gluten']);
  const pdf = await exportBytes(E);
  const mine = mergeRuns(inkRuns(pdf, f.page, { x0: f.x, x1: f.x + 260, yTop: f.y + 14, yBot: f.y + 1, dpi: 900 }), 1.0);
  rec('0:63 renders its own markers on its own row', mine.length >= 2,
      `${mine.length} ink runs right of its name` + (nb ? ` (neighbour ${nb.id})` : ''));
}

// ---------------------------------------------------------------------------------------------
head('2. The NEW badge is drawn at the size the menu already prints');
{
  /* The badge template is stored UNSCALED and `icon_scale_applied` (0.6267) was never applied, so
     ticking NEW stamped a badge 1.6x the printed one. Measured across the eight baked badges the
     real ink is 12.48-12.54pt. */
  const g = E.bind.markerGeomFor('new'), t = E.bind.templateBox('new');
  rec('the badge geometry is derived from the artwork and the scale', !!(g && g.scale && t),
      JSON.stringify(g));
  rec('derived width matches the baked badge (12.48-12.54pt)', g && Math.abs(g.w - 12.51) < 0.2,
      `derived ${g ? g.w.toFixed(3) : '?'}pt`);

  // render one and measure it
  const f = names.find(q => !(q.baked || []).includes('new') && q.marker_bx != null && q.page === 0);
  E.reset(); E.setMarkers(f.id, [...(f.allergens || []), 'new']);
  const pdf = await exportBytes(E);
  const runs = mergeRuns(inkRuns(pdf, f.page, { x0: E.bind.markerAnchor(f) - 4, x1: E.bind.markerAnchor(f) + 70,
                                                yTop: f.y + 16, yBot: f.y - 4, dpi: 1200 }), 1.0);
  const badge = runs[runs.length - 1];
  rec(`a stamped badge measures like a baked one (${f.id})`, badge && Math.abs(badge.w - 12.55) < 0.25,
      badge ? `rendered ${badge.w.toFixed(3)}pt` : 'no ink');
}

// ---------------------------------------------------------------------------------------------
head('3. A baked NEW badge survives an unrelated marker toggle');
{
  /* Eight dishes print a badge that no `baked`/`allergens` list mentioned. Its bytes ARE inside
     `marker_stamps`, so the re-stamp deleted them and redrew a cluster from `desired`, which could
     never contain `new` — the badge silently vanished. Verified by render before the fix. */
  const adopted = names.filter(f => (f.baked || []).includes('new'));
  rec('the baked badges are recorded on the dishes that print them', adopted.length === 8,
      `${adopted.length} dishes carry 'new' (expected 8)`);
  rec('adoption is announced, not silent', boot.filter(w => /NEW badge/.test(w)).length === adopted.length,
      `${boot.filter(w => /NEW badge/.test(w)).length} warnings`);

  let lost = [];
  for (const f of adopted) {
    const keep = (f.allergens || []).filter(m => m !== 'jain' && m !== 'sesame');
    if (keep.length === (f.allergens || []).length) continue;      // nothing to drop on this dish
    E.reset(); E.setMarkers(f.id, keep);
    const pdf = await exportBytes(E);
    const s = (await pageStreams(pdf))[f.page].toString('latin1');
    // the badge's own gold fill must still be present on that page
    if (!s.includes('0.933 0.698 0.169 rg')) lost.push(`${f.id} page lost the badge fill entirely`);
  }
  rec('dropping an unrelated marker keeps the NEW badge', !lost.length, lost.slice(0, 3).join('; '));
}

// ---------------------------------------------------------------------------------------------
head('4. Byte identity is no worse, and the known-fail is exactly the two divergent dishes');
{
  E.reset();
  const out = await exportBytes(E);
  const A = await pageStreams(path.join(DIR, 'aiko.pdf')), B = await pageStreams(out);
  const d = A.map((a, i) => B[i].length - a.length);
  rec('page 1 is byte-identical on an empty edit', d[1] === 0, `p1 ${d[1]}B`);
  /* Page 0 is NOT byte-identical, by design: two dishes have allergens the artwork lacks, so the
     engine corrects the printed PDF on every export. That is menu-truth being enforced, confirmed
     by the product owner. Pinned here as an exact expectation rather than a vague known-fail. */
  const diverge = names.filter(f => [...(f.allergens || [])].sort().join(',') !== [...(f.baked || [])].sort().join(','));
  rec('exactly two dishes drive the page-0 difference', diverge.length === 2,
      diverge.map(f => `${f.id} ${JSON.stringify((f.display || '').trim())} wants ${JSON.stringify(f.allergens)} has ${JSON.stringify(f.baked)}`).join('; '));
  rec('the page-0 difference is the marker correction, and is stable', d[0] > 0 && d[0] < 20000, `p0 +${d[0]}B`);
  for (let p = 0; p < B.length; p++) {
    const b = operatorBalance(B[p]);
    rec(`p${p} operators balanced on an empty edit`, b.ok, `q=${b.q} bt=${b.bt} welds=${b.welds}`);
  }
}

// ---------------------------------------------------------------------------------------------
const failed = results.filter(r => !r.ok);
console.log(`\n${'='.repeat(70)}`);
console.log(`  ${results.length - failed.length} passed   ${failed.length} failed   (0 skipped)`);
if (failed.length) { console.log('\n  FAILURES:'); for (const r of failed) console.log(`    ${r.n} — ${r.d}`); }
console.log('');
process.exit(failed.length ? 1 : 0);
