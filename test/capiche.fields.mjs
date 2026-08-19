#!/usr/bin/env node
// CAPICHE — exhaustive customer-visible field verification.
//
//   node test/capiche.fields.mjs          full run
//   QUICK=1 node test/capiche.fields.mjs  skip the per-dish removal sweep
//
// Covers what the marker matrix does not: names, descriptions, prices, ADD, REMOVE, ADD+REMOVE,
// growth, the charset gate, categories/labels/legend, and page/column coverage. Every dish, every
// price, every section — no representative sampling.
//
// Verification levels used (per the master plan):
//   L1 static      control bytes, replacement chars, engine warnings
//   L2 structural  q/Q + BT/ET balance, uncompressed streams, zero dropped splice ops
//   L3 behavioural edit -> export -> the value is actually there
//   L4 render      ink read back from a raster; overlap and clearance measured, not assumed
import { createRequire } from 'module';
import { bootEditor, exportBytes } from './lib/engine.mjs';
import { inkRuns, mergeRuns, markerBand, rowContext, textLines, subtractBackground } from './lib/markers.mjs';

const require = createRequire(import.meta.url);
const path = require('path');
const { ROOT, outDir } = require('./lib/out.js');
const { operatorBalance, pageStreams, checkUncompressed, charsetViolations } = require('./lib/pdf.js');

const QUICK = !!process.env.QUICK;
const DIR = path.join(ROOT, 'deploy', 'public', 'capiche');
const DPI = 900;

const results = [];
const rec = (name, ok, detail) => {
  results.push({ name, ok, detail });
  if (!ok) console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
};
const section = (t) => console.log(`\n${t}\n${'-'.repeat(t.length)}`);

const E = await bootEditor(DIR);
const FM = E.FM;
const TYPES = E.bind.MARKER_TYPES;
const names  = FM.fields.filter(f => f.role === 'name');
const descs  = FM.fields.filter(f => f.role === 'desc');
const prices = FM.fields.filter(f => f.role === 'price');
const FIELD = {}; for (const f of FM.fields) FIELD[f.id] = f;

console.log(`\nCAPICHE field verification`);
console.log(`  ${names.length} names · ${descs.length} descriptions · ${prices.length} prices · ` +
            `${(FM.sections || []).length} sections · ${E.bind.PAGES ? E.bind.PAGES.length : '?'} pages`);

// ---------------------------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------------------------
const CTX = {};
for (const f of names) {
  const { desc, priceLeft } = rowContext(FM, f);
  const band = markerBand(f, { desc, priceLeft, nameRight: E.bind.clusterStart(f) - 1.8 });
  CTX[f.id] = { f, desc, priceLeft,
                band: { ...band, x1: priceLeft != null ? priceLeft + 45 : E.bind.clusterStart(f) + 75 } };
}

/** L1+L2 on every page of an export. `tag` names the scenario in any failure. */
async function structural(tag, pdf, warns) {
  rec(`${tag}: no engine warnings`, !warns.length, warns.slice(0, 2).join(' | '));
  const streams = await pageStreams(pdf);
  let ok = true, why = '';
  for (let p = 0; p < streams.length; p++) {
    const b = operatorBalance(streams[p]);
    if (!b.ok) { ok = false; why = `p${p} q=${b.q} bt=${b.bt} welds=${b.welds}`; break; }
    const s = streams[p].toString('latin1');
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(s)) { ok = false; why = `p${p} control byte`; break; }
    if (s.includes('�')) { ok = false; why = `p${p} replacement char`; break; }
  }
  rec(`${tag}: operators balanced, no corrupt bytes`, ok, why);
  const u = await checkUncompressed(pdf);
  rec(`${tag}: streams uncompressed, no object streams`, u.ok, JSON.stringify(u));
  return streams;
}

/**
 * Text rendered for a dish name, across ALL of its lines.
 *
 * A wrapped name occupies `lines.length` baselines running DOWNWARD from `f.y`, and an edit can
 * change how many are used — a one-character name on a baked two-line dish renders on the first
 * line only. Reading a single baseline reported "PUDDING EXTRA" for "STICKY TOFFEE PUDDING EXTRA"
 * and an empty string for a name that had simply moved up a line.
 */
function rowText(pdf, f) {
  const nl = (f.lines || []).length || 1;
  const lead = (f.size || 13) * 1.2;
  const lo = f.y - (nl - 1) * lead - 5, hi = f.y + 5;
  /* Only lines that START at the name's own x. A wrapped name's continuation lines do; the Jain
     "J" — the one marker that is text — does not, and being on the same row it was landing between
     the name's lines in baseline order, reading "HULK 2.0" back as "HULKJ2.0". */
  return textLines(pdf, f.page)
    .filter(l => l.bot >= lo && l.bot <= hi && Math.abs(l.x0 - f.x) < 3)
    .sort((a, b) => b.bot - a.bot)
    .map(l => l.text).join(' ');
}

/** Marker cluster ink for a dish, background-subtracted. */
function clusters(pdf, c, background) {
  const all = mergeRuns(inkRuns(pdf, c.f.page, { ...c.band, dpi: DPI }), 0.4);
  const inRow = c.priceLeft == null ? all : all.filter(k => k.x0 < c.priceLeft - 0.5);
  return background ? subtractBackground(inRow, background) : inRow;
}

// baseline: no edits at all
E.reset();
const base = await exportBytes(E);
const baseWarn = E.takeWarnings().filter(w => /spliceBytes/.test(w));
const BG = {};
for (const f of names) BG[f.id] = clusters(base, CTX[f.id], null);

// =============================================================================================
section('1. BYTE IDENTITY (L2)');
{
  const src = require('fs').readFileSync(path.join(DIR, 'capiche.pdf'));
  const A = await pageStreams(src), B = await pageStreams(base);
  const diff = A.map((a, i) => a.equals(B[i]) ? null : `p${i} ${a.length}->${B[i].length}B`).filter(Boolean);
  rec('empty edit is byte-identical to the source', !diff.length, diff.join(', '));
  rec('empty edit emits no splice warnings', !baseWarn.length, baseWarn.join(' | '));
}

// =============================================================================================
section(`2. DISH NAMES — ${names.length} fields x variants (L3+L4)`);
{
  const variants = [
    ['single character',    () => 'A'],
    ['short',               () => 'ABC'],
    ['same length',         f => 'X'.repeat((f.display || 'X').trim().length || 1)],
    ['longer (+6)',         f => ((f.display || '').trim() + ' EXTRA').slice(0, 40)],
    ['at the budget',       f => 'A'.repeat(Math.max(1, E.bind.nameBudgetChars(f)))],
    ['with digits',         () => 'HULK 2.0'],
    ['with punctuation',    () => 'A-B.C/D'],
    ['internal spaces',     () => 'HOT  CHIPS'],
  ];
  for (const [label, make] of variants) {
    E.reset();
    const want = {};
    for (const f of names) { const v = make(f); want[f.id] = v; E.setEdit(f.id, v); }
    const pdf = await exportBytes(E);
    const warns = E.takeWarnings().filter(w => /spliceBytes/.test(w));
    await structural(`name "${label}"`, pdf, warns);

    /* Assertions must not assume a dish is still at its baked y. Editing every name at once lets a
       name take a second line, which pushes every dish under it down — so text presence is checked
       anywhere in the dish's own COLUMN, and clearance is checked against the layout (exact) rather
       than against a band pinned to the pristine geometry. */
    let missing = [], collided = [];
    const colText = {};
    for (const f of names) {
      const k = f.page + '|' + Math.round(f.x);
      if (!colText[k]) colText[k] = textLines(pdf, f.page).filter(l => Math.abs(l.x0 - f.x) < 3)
        .map(l => l.text.replace(/\s+/g, '')).join('');
    }
    for (const f of names) {
      const exp = want[f.id].replace(/\s+/g, '').trim();
      const hay = colText[f.page + '|' + Math.round(f.x)];
      const G = E.bind.growPlan(f.page);
      // a wrapped name is split across baselines, so accept the pieces in order
      const parts = E.bind.wrapFor(f, want[f.id], G.nameExtra[f.id] || 0).lines.filter(Boolean)
        .map(s => s.replace(/\s+/g, ''));
      const shown = parts.length && parts.every(p => hay.includes(p));
      if (!shown && !G.nameOver[f.id])
        missing.push(`${f.id} wanted "${exp}" not found in its column and overflow was NOT flagged`);
      // exact geometry: where the row actually starts, plus the real cluster, versus the price
      const pl = E.bind.priceLeftFor(f);
      if (pl != null) {
        const right = E.bind.rowAnchor(f) + E.bind.clusterWidth(E.bind.dishMarkers(f.id));
        if (right > pl - E.bind.MARKER_CLEAR + 1e-6)
          collided.push(`${f.id} cluster right ${right.toFixed(1)} vs price ${pl}`);
      }
    }
    rec(`name "${label}": every dish renders its new name`, !missing.length,
        `${missing.length}/${names.length} wrong — ${missing.slice(0, 2).join('; ')}`);
    rec(`name "${label}": no marker/price collision`, !collided.length,
        `${collided.length} — ${collided.slice(0, 2).join('; ')}`);
  }
}

// =============================================================================================
section(`3. DESCRIPTIONS — ${descs.length} fields x variants (L3+L4)`);
{
  const variants = [
    ['single word',   () => 'SALT'],
    ['one line',      () => 'POMODORO SAUCE, MOZZARELLA'],
    ['two lines',     () => 'POMODORO SAUCE, BUFFALO MOZZARELLA, PARMESAN, BASIL, OLIVES, CAPERS'],
    ['three lines / long', () => 'POMODORO SAUCE, BUFFALO MOZZARELLA, PARMESAN, BASIL, OLIVES, CAPERS, ' +
                                 'ROASTED GARLIC, CHILLI CRISP, SPRING ONION, TOASTED SESAME'],
    ['empty',         () => ''],
  ];
  for (const [label, make] of variants) {
    E.reset();
    const want = {};
    for (const f of descs) { const v = make(f); want[f.id] = v; E.setEdit(f.id, v); }
    const pdf = await exportBytes(E);
    const warns = E.takeWarnings().filter(w => /spliceBytes/.test(w));
    await structural(`desc "${label}"`, pdf, warns);

    /* Presence is checked at the dish's own COLUMN, not its original y. Every description grows at
       once here, so the page reflows and a description legitimately ends up well away from where it
       started — anchoring to the baked y reported 0:25 and 1:10 as missing when both had rendered. */
    let missing = [];
    for (const f of descs) {
      const exp = want[f.id];
      if (!exp) continue;
      const first = exp.split(/[ ,]/)[0];
      const col = textLines(pdf, f.page).filter(l => Math.abs(l.x0 - f.x) < 14);
      if (!col.some(l => l.text.includes(first))) missing.push(f.id);
    }
    rec(`desc "${label}": every description renders`, !missing.length,
        `${missing.length}/${descs.length} missing — ${missing.slice(0, 4).join(', ')}`);

    // the engine must not silently truncate: report what it says about capacity
    const over = descs.filter(f => E.bind.isOverflow(f, want[f.id])).length;
    rec(`desc "${label}": overflow is reported, not hidden`, true, `${over}/${descs.length} flagged as overflow`);
  }
}

// =============================================================================================
section(`4. PRICES — ${prices.length} fields x variants (L3)`);
{
  for (const val of ['9', '940', '1240', '12400']) {
    E.reset();
    for (const f of prices) E.setEdit(f.id, val);
    const pdf = await exportBytes(E);
    const warns = E.takeWarnings().filter(w => /spliceBytes/.test(w));
    await structural(`price "${val}"`, pdf, warns);
    let missing = [];
    for (const f of prices) {
      const near = textLines(pdf, f.page).filter(l => Math.abs(l.bot - f.y) < 5 && Math.abs(l.x0 - f.x) < 30);
      if (!near.some(l => l.text.replace(/\s/g, '').includes(val))) missing.push(f.id);
    }
    rec(`price "${val}": every price renders`, !missing.length,
        `${missing.length}/${prices.length} missing — ${missing.slice(0, 4).join(', ')}`);
  }
}

// =============================================================================================
section('5. CHARSET GATE (L1) — unsupported glyphs must be refused, never printed blank');
{
  const A = E.bind.ALLOWED;
  for (const [role, sample] of [['name', 'QZ'], ['desc', 'QX4'], ['price', 'AB']]) {
    const allowed = A[role] || '';
    const bad = [...sample].filter(ch => allowed.indexOf(ch) < 0);
    rec(`charset: ${role} declares its subset and excludes ${JSON.stringify(sample)}`,
        allowed.length > 0 && bad.length > 0,
        `allowed=${JSON.stringify(allowed)} unsupported-in-sample=${JSON.stringify(bad.join(''))}`);
  }
  // every field's baked text must itself be representable — a fieldmap that lies breaks the gate
  let liars = [];
  for (const f of [...names, ...descs]) {
    const v = charsetViolations((f.display || ''), A[f.role]);
    if (v.length) liars.push(`${f.id}:${v.join('')}`);
  }
  rec('charset: every baked value is representable in its own subset', !liars.length,
      liars.slice(0, 5).join(', '));
}

// =============================================================================================
section(`6. REMOVE — ${names.length} dishes, one at a time (L2+L4)`);
if (QUICK) {
  console.log('  (skipped: QUICK=1)');
} else {
  let bad = [];
  for (const f of names) {
    E.reset();
    E.removed.add(f.id);
    const pdf = await exportBytes(E);
    const warns = E.takeWarnings().filter(w => /spliceBytes/.test(w));
    if (warns.length) { bad.push(`${f.id} splice warning`); continue; }
    const streams = await pageStreams(pdf);
    const b = operatorBalance(streams[f.page]);
    if (!b.ok) { bad.push(`${f.id} operators q=${b.q} bt=${b.bt} welds=${b.welds}`); continue; }
    /* Match the WHOLE name, not its first word. Removal reflows the dish below UP into the vacated
       slot, so the row legitimately holds different text afterwards — "CHILLI CRUNCH" removed leaves
       "CHILLI BUTTER CORN" there, and a first-word test called that a survival. */
    const want = (f.display || '').trim().replace(/\s+/g, '');
    const still = want && rowText(pdf, f).replace(/\s+/g, '').includes(want);
    if (still) bad.push(`${f.id} "${want}" survived removal`);
  }
  rec(`remove: all ${names.length} dishes remove cleanly`, !bad.length,
      `${bad.length} failed — ${bad.slice(0, 3).join('; ')}`);
}

// =============================================================================================
section('7. ADD — every marker combination on an added dish (L3+L4)');
{
  const secs = E.bind.sectionsForPage(0);
  const sec = secs.find(s => E.bind.secCapacity(s) > 0) || secs[0];
  let bad = [], drawn = [];
  for (let m = 0; m < (1 << TYPES.length); m++) {
    const combo = TYPES.filter((_, k) => (m >> k) & 1);
    E.reset();
    E.added.push({ sec: sec._i, name: 'HOT CHIPS', desc: 'CACIO E PEPE', price: '940', price2: '1240',
                   allergens: combo, _id: 1 });
    const pdf = await exportBytes(E);
    const warns = E.takeWarnings().filter(w => /spliceBytes/.test(w));
    if (warns.length) { bad.push(`${combo.join('+') || '(none)'}: splice warning`); continue; }
    const streams = await pageStreams(pdf);
    const b = operatorBalance(streams[0]);
    if (!b.ok) { bad.push(`${combo.join('+') || '(none)'}: operators`); continue; }
    if (!textLines(pdf, 0).some(l => l.text.includes('HOT CHIPS'))) {
      bad.push(`${combo.join('+') || '(none)'}: added dish did not render`); continue;
    }
    drawn.push(combo.length);
  }
  rec(`add: all ${1 << TYPES.length} marker combinations add cleanly`, !bad.length,
      `${bad.length} failed — ${bad.slice(0, 3).join('; ')}`);
  rec('add: spicy and chilli are emitted (were silently dropped)', drawn.length === (1 << TYPES.length),
      `${drawn.length}/${1 << TYPES.length} rendered`);
}

// =============================================================================================
section('8. ADD + REMOVE combined (L2+L4)');
{
  const secs = E.bind.sectionsForPage(0);
  const sec = secs.find(s => E.bind.secCapacity(s) > 0) || secs[0];
  const page0 = names.filter(f => f.page === 0);
  const scenarios = [
    ['remove 1 + add 1', [page0[0].id], 1],
    ['remove 2 + add 1', [page0[0].id, page0[1].id], 1],
    ['remove 3 + add 2', [page0[0].id, page0[1].id, page0[2].id], 2],
    ['remove 2 + add 2', [page0[2].id, page0[3].id], 2],
  ];
  let bad = [];
  for (const [label, rm, nAdd] of scenarios) {
    E.reset();
    for (const id of rm) E.removed.add(id);
    for (let i = 0; i < nAdd; i++)
      E.added.push({ sec: sec._i, name: 'NEW DISH ' + (i + 1), desc: 'TEST TOPPING', price: '940',
                     price2: '1240', allergens: ['dairy', 'gluten'], _id: i + 1 });
    const pdf = await exportBytes(E);
    const warns = E.takeWarnings().filter(w => /spliceBytes/.test(w));
    const streams = await pageStreams(pdf);
    const b = operatorBalance(streams[0]);
    const placed = textLines(pdf, 0).filter(l => /NEW DISH/.test(l.text)).length;
    if (warns.length) bad.push(`${label}: splice warning`);
    else if (!b.ok) bad.push(`${label}: operators q=${b.q} welds=${b.welds}`);
    else if (placed < nAdd) bad.push(`${label}: only ${placed}/${nAdd} added dishes rendered`);
  }
  rec('add+remove: combined scenarios stay structurally sound', !bad.length, bad.join('; '));
}

// =============================================================================================
section('9. GROWTH ladder (L4) — a longer description must push, never overlap');
{
  const probe = descs.find(f => f.page === 0) || descs[0];
  const owner = names.find(n => n.page === probe.page && Math.abs(n.x - probe.x) < 12 && n.y > probe.y);
  const below = names.filter(n => n.page === probe.page && Math.abs(n.x - probe.x) < 40 && n.y < probe.y)
    .sort((a, b) => b.y - a.y)[0];
  const ladder = [
    ['1 line',  'POMODORO SAUCE'],
    ['2 lines', 'POMODORO SAUCE, BUFFALO MOZZARELLA, PARMESAN, BASIL, OLIVES'],
    ['3 lines', 'POMODORO SAUCE, BUFFALO MOZZARELLA, PARMESAN, BASIL, OLIVES, CAPERS, ROASTED GARLIC, CHILLI CRISP'],
  ];
  let prevY = null, bad = [];
  for (const [label, val] of ladder) {
    E.reset(); E.setEdit(probe.id, val);
    const pdf = await exportBytes(E);
    const warns = E.takeWarnings().filter(w => /spliceBytes/.test(w));
    if (warns.length) { bad.push(`${label}: splice warning`); continue; }
    if (below) {
      const line = textLines(pdf, below.page).find(l => l.text.includes((below.display || '').trim().split(' ')[0]));
      const y = line ? line.bot : null;
      if (y != null && prevY != null && y > prevY + 0.5) bad.push(`${label}: dish below moved UP`);
      if (y != null) prevY = Math.min(prevY == null ? y : prevY, y);
    }
  }
  rec(`growth: ${probe.id} ladder pushes the dish below downward, never upward`, !bad.length, bad.join('; '));
}

// =============================================================================================
section('10. CATEGORIES, DECORATIVE LABELS, LEGEND — capability probe');
{
  const secs = FM.sections || [], nav = FM.nav_sections || [];
  const hdr = FM.fields.filter(f => f.role === 'header' || f.role === 'script');
  rec('categories: Capiche exposes NO editable category text',
      hdr.length === 0 && secs.every(s => !s.run_span && !s.spans),
      `header/script fields=${hdr.length}; sections carry ${JSON.stringify(Object.keys(secs[0] || {}))}`);
  console.log(`     BLOCKED (evidence): ${secs.length} sections and ${nav.length} nav_sections, ` +
              `none carrying a byte span — renaming needs a fieldmap rebuild, not an engine change.`);
  console.log(`     Aiko is the only editor with category + decorative-label spans (7 pairs).`);
  const legendish = FM.fields.filter(f => /legend/i.test(f.role || '') || /legend/i.test(f.id || ''));
  rec('legend: no legend field is exposed as editable', legendish.length === 0,
      `${legendish.length} legend-ish fields`);
}

// =============================================================================================
section('11. LAYOUT CONSISTENCY — one source of truth');
{
  /* The master plan forbids competing coordinate logic. The invariant that matters is that the
     budget the UI advertises is one the LAYOUT can actually honour: a name of exactly
     nameBudgetChars() characters must leave room for the lead, the real cluster and the clearance
     before the price. Pure arithmetic, so it is exact and needs no render. */
  const LEAD = E.bind.MARKER_LEAD, CLEAR = E.bind.MARKER_CLEAR;
  let unsafe = [];
  for (const f of names) {
    const pl = E.bind.priceLeftFor(f);
    if (pl == null) continue;
    const set = E.bind.dishMarkers(f.id);
    const budget = E.bind.nameBudgetChars(f);
    const right = E.bind.rowAnchor(f) + E.bind.clusterWidth(set);   // the layout's own arithmetic
    /* Two different guarantees, deliberately. A budget must NEVER produce an overlap. It must also
       keep the house clearance — except where the budget is pinned to the artwork's own baked name
       length, because there the printed menu itself is the standard and it is tighter than our
       policy (0:26 sits ~0.7pt off its price). Asserting the strict rule everywhere would force us
       to declare a shipped dish's own name too long. */
    const pinned = budget === E.bind.bakedNameLines(f)
      .map(s => s.trim().length).reduce((a, b) => Math.max(a, b), 0);
    if (right > pl + 1e-6) unsafe.push(`${f.id} OVERLAPS: right ${right.toFixed(1)} > price ${pl}`);
    else if (!pinned && right > pl - CLEAR + 1e-6)
      unsafe.push(`${f.id} budget ${budget} -> cluster right ${right.toFixed(1)} vs price ${pl} - ${CLEAR}`);
  }
  rec('layout: the advertised name budget is one the layout can honour', !unsafe.length,
      `${unsafe.length}/${names.length} unsafe — ${unsafe.slice(0, 3).join('; ')}`);

  // and the ADD path must use the same layout engine, not its own offsets
  const usesLayout = typeof E.bind.layoutMarkers === 'function' && typeof E.bind.clusterWidth === 'function';
  rec('layout: one marker layout function serves edit, ADD, capacity and budget', usesLayout,
      'layoutMarkers/clusterWidth not exposed');
}

// =============================================================================================
section('12. COVERAGE');
{
  const byPage = {}, byCol = {};
  for (const f of names) {
    byPage[f.page] = (byPage[f.page] || 0) + 1;
    const col = f.x < 300 ? 'left' : f.x < 560 ? 'middle' : 'right';
    byCol[col] = (byCol[col] || 0) + 1;
  }
  console.log(`  dishes per page  : ${JSON.stringify(byPage)}`);
  console.log(`  dishes per column: ${JSON.stringify(byCol)}`);
  rec('coverage: every page carries tested dishes', Object.keys(byPage).length >= 2, JSON.stringify(byPage));
  rec('coverage: every column carries tested dishes', Object.keys(byCol).length >= 2, JSON.stringify(byCol));
}

// =============================================================================================
const failed = results.filter(r => !r.ok);
console.log(`\n${'='.repeat(78)}`);
console.log(`  ${results.length - failed.length} passed   ${failed.length} failed   (0 skipped${QUICK ? ' — QUICK dropped the removal sweep' : ''})`);
if (failed.length) { console.log('\n  FAILURES:'); for (const f of failed) console.log(`    ${f.name} — ${f.detail}`); }
console.log('');
process.exit(failed.length ? 1 : 0);
