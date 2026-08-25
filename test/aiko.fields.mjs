#!/usr/bin/env node
// AIKO — name width, capacity, gating, labels and persistence.
//
//   node test/aiko.fields.mjs
//
// Companion to aiko.markers.mjs. Pins the Phase 2 findings that are not about marker artwork:
// the name budget, the export gate, the decorative-label overlay, and marker persistence.
import { createRequire } from 'module';
import { bootEditor, exportBytes } from './lib/engine.mjs';
import { inkRuns, textLines } from './lib/markers.mjs';

const require = createRequire(import.meta.url);
const path = require('path');
const fs = require('fs');
const { ROOT } = require('./lib/out.js');
const { pageStreams, operatorBalance } = require('./lib/pdf.js');

const DIR = path.join(ROOT, 'deploy', 'public', 'aiko');
const results = [];
const rec = (n, ok, d) => { results.push({ n, ok, d }); if (!ok) console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`); };
const head = t => console.log(`\n${t}\n${'-'.repeat(t.length)}`);

const E = await bootEditor(DIR, {
  expose: ['nameAdv', 'nameWidth', 'nameBudgetChars', 'markerClusterWidth', 'markerAnchor',
           'labelVectorSpan', 'memSnapshot', 'memApply', 'allerEdits', 'headerBadChars'] });
const names = E.FM.fields.filter(f => f.role === 'name');
console.log(`\nAIKO fields — ${names.length} dishes, ${E.FM.fields.length} fields`);

const priceRightOf = f => E.FM.fields
  .filter(q => q.role === 'price' && q.page === f.page && Math.abs(q.y - f.y) < 8 &&
               ((q.tm_vals && q.tm_vals[4] != null) ? q.tm_vals[4] : q.x) > f.x)
  .map(q => (q.tm_vals && q.tm_vals[4] != null) ? q.tm_vals[4] : q.x)
  .sort((a, b) => a - b)[0];

// ---------------------------------------------------------------------------------------------
head('1. The name advance accounts for the runs own tracking');
{
  /* The runs carry `-0.024 Tc 0.024 Tw`, so a character advances 0.563 em and a SPACE the full
     0.587 — the Tw cancels the Tc. Measured on TTEOKBOKKI (no spaces): glyph pitch 6.180pt. */
  const f = names.find(q => q.id === '0:16');
  const src = fs.readFileSync(path.join(DIR, 'aiko.pdf'));
  const runs = inkRuns(src, f.page, { x0: f.x - 2, x1: f.x + 200, yTop: f.y + 9, yBot: f.y - 2, dpi: 1200 });
  const starts = runs.map(r => r.x0);
  const d = starts.slice(1).map((v, i) => v - starts[i]).filter(v => v > 3 && v < 12).sort((a, b) => a - b);
  const measured = d[d.length >> 1];
  rec('nameAdv matches the measured glyph pitch', Math.abs(E.bind.nameAdv(f) - measured) < 0.1,
      `model ${E.bind.nameAdv(f).toFixed(3)} vs measured ${measured.toFixed(3)}pt`);
  rec('tracking is read per field, not assumed universal',
      new Set(names.map(q => q.tc)).size > 1,
      `distinct Tc values: ${JSON.stringify([...new Set(names.map(q => q.tc))])}`);
  // a space must cost more than a letter here, or the budget under-measures
  rec('a space is charged at its own advance',
      E.bind.nameWidth(f, 'A A') > E.bind.nameWidth(f, 'AAA') - 1e-9,
      `"A A" ${E.bind.nameWidth(f, 'A A').toFixed(3)} vs "AAA" ${E.bind.nameWidth(f, 'AAA').toFixed(3)}`);
}

// ---------------------------------------------------------------------------------------------
head('2. The advertised name budget leaves room for the marker row');
{
  /* The reservation used to look up `add_const.icon_dairy` etc — CAPICHE's key names, absent here —
     so it was always 0 and 42 of 46 dishes overran their own price at full budget. */
  const gap = (E.bind.AC && E.bind.AC.marker_gap != null) ? E.bind.AC.marker_gap : 4;
  let over = [], checked = 0;
  for (const f of names) {
    const px = priceRightOf(f);
    if (px == null) continue;
    checked++;
    const set = new Set(f.allergens || []);
    const b = E.bind.nameBudgetChars(f);
    const right = f.x + E.bind.nameWidth(f, 'A'.repeat(b)) + (set.size ? gap : 0) + E.bind.markerClusterWidth(set);
    if (right > px + 1e-6) over.push(`${f.id} budget ${b} -> ${right.toFixed(1)} vs price ${px.toFixed(1)}`);
  }
  rec(`no dish overruns its price at full budget (${checked} with a price)`, !over.length,
      `${over.length} — ${over.slice(0, 3).join('; ')}`);
  rec('the cluster reservation is non-zero when markers are present',
      E.bind.markerClusterWidth(new Set(['dairy', 'gluten'])) > 5,
      `dairy+gluten = ${E.bind.markerClusterWidth(new Set(['dairy', 'gluten'])).toFixed(2)}pt`);
  const bad = names.filter(f => String(f.display || '').trim().length > E.bind.nameBudgetChars(f));
  rec('every baked name still fits its own budget', !bad.length,
      bad.slice(0, 3).map(f => `${f.id} ${String(f.display).trim().length}>${E.bind.nameBudgetChars(f)}`).join(', '));
}

// ---------------------------------------------------------------------------------------------
head('3. Every decorative label resolves its vector overlay');
{
  /* DESSERTS is the last text block on page 1, so the "scan to the next BT" search returned -1 and
     h6:script had no overlay span: renaming it left a ghost outline and nudged one of five groups. */
  const scripts = E.FM.fields.filter(f => f.role === 'header' && f.kind === 'script');
  const nulls = scripts.filter(f => !E.bind.labelVectorSpan(f));
  rec(`all ${scripts.length} script labels resolve an overlay span`, !nulls.length,
      nulls.map(f => f.id).join(', '));

  // and renaming the previously-broken one leaves no stale ink behind
  const f = scripts.find(q => q.id === 'h6:script');
  E.reset(); E.setEdit('h6:script', 'slurpy');
  const pdf = await exportBytes(E);
  rec('renaming h6:script emits no dropped splice ops',
      !E.takeWarnings().filter(w => /spliceBytes/.test(w)).length, '');
  const ink = inkRuns(pdf, f.page, { x0: f.x - 4, x1: f.x + 120, yTop: f.y + 22, yBot: f.y - 10, dpi: 600 });
  const bare = inkRuns(fs.readFileSync(path.join(DIR, 'aiko.pdf')), f.page,
    { x0: f.x - 4, x1: f.x + 120, yTop: f.y + 22, yBot: f.y - 10, dpi: 600 });
  // the replacement is a different word, so the ink must CHANGE — a ghost would leave the old ink too
  rec('the old label ink does not survive the rename',
      ink.length && JSON.stringify(ink.map(r => +r.x0.toFixed(1))) !== JSON.stringify(bare.map(r => +r.x0.toFixed(1))),
      `${bare.length} runs before, ${ink.length} after`);
}

// ---------------------------------------------------------------------------------------------
head('4. A category name that cannot print blocks the export');
{
  /* `edits` was written even when the charset check failed, and updateGate counted glyph errors
     only from .name/.desc — so an unprintable category name shipped behind a green "All clear".
     The serif subset is 20 glyphs and has no `P`, so "Plates" is impossible. */
  const serif = E.FM.fields.find(f => f.role === 'header' && f.kind === 'serif');
  const bad = E.bind.headerBadChars(serif, 'Plates');
  rec('the charset check still rejects an unprintable category name', bad.length > 0,
      `headerBadChars -> ${JSON.stringify(bad)}`);
  const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
  rec('the gate counts unprintable section inputs', html.includes(".secinp.badglyph"),
      'updateGate does not look at .secinp');
  rec('the input is marked when it cannot print', html.includes("classList.toggle('badglyph'"),
      'no badglyph marker on the header input');
}

// ---------------------------------------------------------------------------------------------
head('5. Marker toggles persist');
{
  E.reset();
  const clean = JSON.stringify(E.bind.memSnapshot());
  E.setMarkers('0:20', ['dairy']);
  const snap = E.bind.memSnapshot();
  rec('allerEdits is serialised', !!snap.allerEdits && !!snap.allerEdits['0:20'], JSON.stringify(Object.keys(snap)));
  rec('a marker-only change makes the editor dirty', JSON.stringify(snap) !== clean, '');
  E.reset();
  E.bind.memApply(JSON.parse(JSON.stringify(snap)));
  rec('a restored snapshot brings the markers back',
      JSON.stringify(E.bind.allerEdits) === JSON.stringify({ '0:20': ['dairy'] }),
      JSON.stringify(E.bind.allerEdits));
}

// ---------------------------------------------------------------------------------------------
head('6. Structure is intact after all of the above');
{
  E.reset();
  E.setEdit('0:16', 'TTEOKBOKKI SPECIAL');
  E.setMarkers('0:20', ['dairy', 'gluten', 'new']);
  const pdf = await exportBytes(E);
  rec('no dropped splice ops', !E.takeWarnings().filter(w => /spliceBytes/.test(w)).length, '');
  const st = await pageStreams(pdf);
  for (let p = 0; p < st.length; p++) {
    const b = operatorBalance(st[p]);
    rec(`p${p} operators balanced`, b.ok, `q=${b.q} bt=${b.bt} welds=${b.welds}`);
    rec(`p${p} no control bytes`, !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(st[p].toString('latin1')), '');
  }
  rec('the edited name renders', textLines(pdf, 0).some(l => l.text.includes('TTEOKBOKKI SPECIAL')), '');
}

// ---------------------------------------------------------------------------------------------
const failed = results.filter(r => !r.ok);
console.log(`\n${'='.repeat(70)}`);
console.log(`  ${results.length - failed.length} passed   ${failed.length} failed   (0 skipped)`);
if (failed.length) { console.log('\n  FAILURES:'); for (const r of failed) console.log(`    ${r.n} — ${r.d}`); }
console.log('');
process.exit(failed.length ? 1 : 0);
