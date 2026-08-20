#!/usr/bin/env node
// CAPICHE — a long dish name continues on a second line.
//
//   node test/capiche.namegrow.mjs
//
// Everything is measured from RENDERED INK or from the layout function itself, never from the
// wrapping code under test. The feature this covers was attempted once before and reverted
// (docs/knowledge/roomier-text-limits.md): a second name line lands where the description already
// is, so the row has to grow and take everything below it down. Check 3 is that exact failure.
import { createRequire } from 'module';
import { bootEditor, exportBytes } from './lib/engine.mjs';
import { inkRuns, mergeRuns, textLines, rowContext } from './lib/markers.mjs';

const require = createRequire(import.meta.url);
const path = require('path');
const fs = require('fs');
const { ROOT } = require('./lib/out.js');
const { operatorBalance, pageStreams, checkUncompressed } = require('./lib/pdf.js');

const DIR = path.join(ROOT, 'deploy', 'public', 'capiche');
const DPI = 900;
const results = [];
const rec = (n, ok, d) => { results.push({ n, ok, d }); if (!ok) console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`); };
const head = t => console.log(`\n${t}\n${'-'.repeat(t.length)}`);

const E = await bootEditor(DIR);
const names = E.FM.fields.filter(f => f.role === 'name');
const F = {}; for (const f of E.FM.fields) F[f.id] = f;

/** A value guaranteed to need one more line than the name currently uses.
    Sized against the dish's CURRENT capacity (budget x baked lines), not the budget alone — the
    five baked two-line names already hold twice a one-line budget, so a budget-sized string is not
    too long for them at all. */
const tooLong = f => {
  const cap = E.bind.nameBudgetChars(f) * ((f.lines || []).length || 1);
  const per = Math.max(3, Math.floor(E.bind.nameBudgetChars(f) / 3));
  // real words, so greedyWrap can actually break it — a single long token cannot wrap
  /* Distinct words. Repeating the same token made every wrapped line an identical string, so the
     render check could not tell line 1 from line 2 and measured a baseline gap of zero. Only
     letters the name font actually carries (no Q or Z). */
  const AB = 'ABCDEFGHIJKLMNOPRSTUVWXY';
  const w = []; let n = 0, i = 0;
  while (n <= cap + 4) { w.push(AB[i++ % AB.length].repeat(per)); n += per + 1; }
  return w.join(' ');
};

console.log(`\nCAPICHE name growth  —  ${names.length} dishes`);
console.log(`  lead ${E.bind.nameLineH(names[0]).toFixed(2)}pt · max extra lines ${E.bind.NAME_EXTRA_MAX}`);

// ---------------------------------------------------------------------------------------------
head('1. EVERY NAME, forced past one line — grows, or is refused with a reason');
const grew = [], refused = [];
{
  for (const f of names) {
    E.reset();
    E.setEdit(f.id, tooLong(f));
    const G = E.bind.growPlan(f.page);
    if (G.nameExtra[f.id] > 0) grew.push(f.id);
    else if (G.nameOver[f.id]) refused.push({ id: f.id, short: G.nameShort[f.id],
      stillLong: E.bind.wrapFor(f, tooLong(f), E.bind.NAME_EXTRA_MAX).overflow });
    else rec(`${f.id}: a too-long name either grows or is flagged`, false,
             'neither granted a line nor flagged as overflow — silent truncation');
  }
  rec('every dish either grows a line or says why', grew.length + refused.length === names.length,
      `${grew.length} grew, ${refused.length} refused, ${names.length - grew.length - refused.length} silent`);
  console.log(`     grew   : ${grew.length}/${names.length}`);
  console.log(`     refused: ${refused.length} — ${refused.map(r => r.id + (r.short ? ` (short ${r.short.toFixed(1)}pt)` : ' (needs >2 lines)')).join(', ') || '(none)'}`);
  /* A refusal must be explicable: either the column is short by a measurable amount, or the text is
     simply longer than two lines can hold. What is NOT acceptable is a refusal with no reason.
     A third case used to exist — a column "pinned" by the footer price list — but that was a
     containment for the reflow tear, and the tear is now fixed at its source. */
  const unexplained = refused.filter(r => !(r.short > 0) && !r.stillLong);
  rec('every refusal has a stated reason', !unexplained.length,
      unexplained.map(r => r.id).join(', '));
}

// ---------------------------------------------------------------------------------------------
head('2. A grown name renders TWO lines, and its markers ride the second one');
{
  let bad = [];
  for (const id of grew) {
    const f = F[id];
    E.reset(); E.setEdit(id, tooLong(f));
    const G = E.bind.growPlan(f.page);
    const want = E.bind.wrapFor(f, tooLong(f), G.nameExtra[id]).lines.filter(Boolean);
    const pdf = await exportBytes(E);
    if (E.takeWarnings().filter(w => /spliceBytes/.test(w)).length) { bad.push(`${id} splice warning`); continue; }

    const lead = E.bind.nameLineH(f);
    const col = textLines(pdf, f.page).filter(l => Math.abs(l.x0 - f.x) < 3);
    const joined = col.map(l => l.text.replace(/\s+/g, '')).join('');
    if (!want.every(w => joined.includes(w.replace(/\s+/g, '')))) { bad.push(`${id} text not rendered`); continue; }

    /* Consecutive baselines must be exactly one lead apart, and the markers ride the LAST line —
       which is line 3 for the five dishes that were already baked as two-liners, not line 2. */
    const at = w => col.find(l => l.text.replace(/\s+/g, '').includes(w.replace(/\s+/g, '')));
    const ls = want.map(at);
    if (ls.some(l => !l)) { bad.push(`${id} could not locate every line`); continue; }
    for (let i = 1; i < ls.length; i++) {
      const d = ls[i - 1].bot - ls[i].bot;
      if (Math.abs(d - lead) > 1.0) { bad.push(`${id} line ${i} gap ${d.toFixed(2)} vs lead ${lead.toFixed(2)}`); break; }
    }
    const l2 = ls[ls.length - 1];

    // markers must sit beside the LAST line, not the first
    const set = E.bind.dishMarkers(id);
    if (set.size) {
      const { desc, priceLeft } = rowContext(E.FM, f);
      const yMid = l2.bot + 2;
      const band = { x0: E.bind.rowAnchor(f) - 2, x1: (priceLeft || f.x + 240) + 30,
                     yTop: yMid + 11, yBot: yMid - 4, dpi: DPI };
      const cl = mergeRuns(inkRuns(pdf, f.page, band), 0.4)
        .filter(k => priceLeft == null || k.x0 < priceLeft - 0.5);
      if (!cl.length) bad.push(`${id} no marker ink beside line 2`);
    }
  }
  rec(`all ${grew.length} grown names render two lines with markers on the last`, !bad.length,
      `${bad.length} — ${bad.slice(0, 3).join('; ')}`);
}

// ---------------------------------------------------------------------------------------------
head('3. The description moves down with the name — the failure that killed the last attempt');
{
  let bad = [], checked = 0;
  for (const id of grew) {
    const f = F[id];
    const d = E.FM.fields.find(q => q.role === 'desc' && q.page === f.page &&
                                    Math.abs(q.x - f.x) < 14 && q.y < f.y && f.y - q.y < 30);
    if (!d) continue;
    const first = (d.display || '').trim().split(/[ ,]/)[0];
    if (!first) continue;
    /* Search a window around the description's own baked y, not the whole page. Description first
       words repeat constantly on a pizza menu — "POMODORO" opens eight of them — so a page-wide
       match returned the topmost dish's description every time and reported "moved 0.00". The row
       can only travel DOWN by a lead, so [-26, +3] is generous. */
    const at = (pdf) => { const l = textLines(pdf, d.page)
      .filter(x => Math.abs(x.x0 - d.x) < 6 && x.text.includes(first) && x.bot > d.y - 26 && x.bot < d.y + 3)
      .sort((a, b) => b.bot - a.bot)[0]; return l ? l.bot : null; };

    E.reset(); const before = at(await exportBytes(E));
    E.reset(); E.setEdit(id, tooLong(f)); const after = at(await exportBytes(E));
    if (before == null || after == null) continue;
    checked++;
    const moved = before - after, lead = E.bind.nameLineH(f);
    if (Math.abs(moved - lead) > 1.0) bad.push(`${id} desc moved ${moved.toFixed(2)} vs lead ${lead.toFixed(2)}`);
  }
  rec(`the description drops by exactly one lead (${checked} dishes with one)`, !bad.length,
      `${bad.length} — ${bad.slice(0, 3).join('; ')}`);
}

// ---------------------------------------------------------------------------------------------
head('4. Nothing overlaps, and the dish below moves down too');
{
  const A = await import('./lib/audit.mjs');
  const src = path.join(DIR, 'capiche.pdf');
  let bad = [];
  for (const id of grew.slice(0, 12)) {
    const f = F[id];
    const before = A.overlaps(src, f.page, { menuMaxX: 820 });
    E.reset(); E.setEdit(id, tooLong(f));
    const out = path.join(ROOT, 'test-output', 'probe', `ng_${id.replace(':', '_')}.pdf`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, await exportBytes(E));
    const after = A.overlaps(out, f.page, { menuMaxX: 820 });
    // order-independent key: `overlaps` may report the same pair with a and b swapped
    const key = o => [o.a, o.b].sort().join('  '), seen = new Set(before.map(key));
    const fresh = after.filter(o => !seen.has(key(o)));
    if (fresh.length) bad.push(`${id}: ${JSON.stringify(fresh[0].a).slice(0, 30)} <> ${JSON.stringify(fresh[0].b).slice(0, 30)}`);
  }
  rec('a grown name introduces no new overlap anywhere on its page', !bad.length,
      `${bad.length} — ${bad.slice(0, 2).join('; ')}`);
}

// ---------------------------------------------------------------------------------------------
head('5. SPICY TOMATO & CREAM can take the NEW badge once its name wraps');
{
  const f = F['1:27'];
  E.reset();
  const before = E.bind.markerFits(f, new Set(['dairy', 'gluten', 'new']));
  E.setEdit('1:27', 'SPICY TOMATO AND CREAM SAUCE');
  const after = E.bind.markerFits(f, new Set(['dairy', 'gluten', 'new']));
  rec('NEW is refused at the full one-line name', !before, 'it was already accepted');
  rec('NEW is accepted once the name wraps', after,
      `room ${E.bind.markerRoom(f).toFixed(1)}pt vs needed ${E.bind.clusterWidth(new Set(['dairy','gluten','new'])).toFixed(1)}pt`);
}

// ---------------------------------------------------------------------------------------------
head('6. Byte identity, and PDF invariants on every grown export');
{
  E.reset();
  const empty = await exportBytes(E);
  const A = await pageStreams(path.join(DIR, 'capiche.pdf')), B = await pageStreams(empty);
  rec('an unedited export is still byte-identical',
      A.every((a, i) => a.equals(B[i])),
      A.map((a, i) => a.equals(B[i]) ? null : `p${i} ${a.length}->${B[i].length}`).filter(Boolean).join(', '));

  let bad = [];
  for (const id of grew.slice(0, 12)) {
    E.reset(); E.setEdit(id, tooLong(F[id]));
    const pdf = await exportBytes(E);
    if (E.takeWarnings().filter(w => /spliceBytes/.test(w)).length) { bad.push(`${id} dropped splice op`); continue; }
    const st = await pageStreams(pdf);
    for (let p = 0; p < st.length; p++) {
      const b = operatorBalance(st[p]);
      if (!b.ok) { bad.push(`${id} p${p} q=${b.q} bt=${b.bt} welds=${b.welds}`); break; }
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(st[p].toString('latin1'))) { bad.push(`${id} p${p} control byte`); break; }
    }
    const u = await checkUncompressed(pdf);
    if (!u.ok) bad.push(`${id} ${JSON.stringify(u)}`);
  }
  rec('grown exports stay structurally valid', !bad.length, `${bad.length} — ${bad.slice(0, 3).join('; ')}`);
}

// ---------------------------------------------------------------------------------------------
head('7. Composition — growth alongside a description, an add and a remove');
{
  const f = F[grew[0]], page0 = names.filter(n => n.page === f.page && n.id !== f.id);
  const secs = E.bind.sectionsForPage(f.page);
  const sec = secs.find(s => E.bind.secCapacity(s) > 0) || secs[0];
  const d = E.FM.fields.find(q => q.role === 'desc' && q.page === f.page && Math.abs(q.x - f.x) < 14 && q.y < f.y);
  const cases = [
    ['name growth alone', () => { E.setEdit(f.id, tooLong(f)); }],
    ['+ a grown description', () => { E.setEdit(f.id, tooLong(f)); if (d) E.setEdit(d.id, (d.display || '') + ', EXTRA HERB, ROASTED GARLIC, CHILLI CRISP'); }],
    ['+ a removed dish', () => { E.setEdit(f.id, tooLong(f)); E.removed.add(page0[0].id); }],
    ['+ an added dish', () => { E.setEdit(f.id, tooLong(f)); E.added.push({ sec: sec._i, name: 'HOT CHIPS', desc: 'CACIO E PEPE', price: '940', price2: '1240', allergens: ['dairy'], _id: 1 }); }],
  ];
  let bad = [];
  for (const [label, setup] of cases) {
    E.reset(); setup();
    const pdf = await exportBytes(E);
    const w = E.takeWarnings().filter(x => /spliceBytes/.test(x));
    const st = await pageStreams(pdf);
    const b = operatorBalance(st[f.page]);
    if (w.length) bad.push(`${label}: splice warning`);
    else if (!b.ok) bad.push(`${label}: q=${b.q} welds=${b.welds}`);
  }
  rec('name growth composes with description growth, add and remove', !bad.length, bad.join('; '));
}

// ---------------------------------------------------------------------------------------------
const failed = results.filter(r => !r.ok);
console.log(`\n${'='.repeat(78)}`);
console.log(`  ${results.length - failed.length} passed   ${failed.length} failed   (0 skipped)`);
if (failed.length) { console.log('\n  FAILURES:'); for (const r of failed) console.log(`    ${r.n} — ${r.d}`); }
console.log('');
process.exit(failed.length ? 1 : 0);
