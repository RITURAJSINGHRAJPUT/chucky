#!/usr/bin/env node
// CAPICHE — ADD-ONS block (the page-0 footer price list) full verification.
//
//   node test/capiche.addons.mjs
//
// The block is four baked "name …leader… price" rows (GHASLET HOT SAUCE / PARMESAN, TRUFFLE
// AIOLI / BURRATA CHEESE / TRUFFLE) recorded in FM.addons by src/capiche/addon_data.js and
// edited rewrite-only by addonOps() in the engine. Every baked row is tested individually —
// rename, price change, long name, remove, restore, reorder — plus add-new-row, the optional
// heading, dish-interaction, and persistence. No sampling (CLAUDE.md §18-equivalent).
//
// Verification levels:
//   L1 static      engine warnings, control bytes
//   L2 structural  q/Q + BT/ET balance, byte identity at rest
//   L3 behavioural edit -> export -> the value is there and the old one is not
//   L4 render      ink read back from a raster; leader/name/price clearance measured
import { createRequire } from 'module';
import { bootEditor, exportBytes } from './lib/engine.mjs';
import { inkRuns, textLines } from './lib/markers.mjs';

const require = createRequire(import.meta.url);
const path = require('path');
const { ROOT } = require('./lib/out.js');
const { operatorBalance, pageStreams, byteIdentical } = require('./lib/pdf.js');

const DIR = path.join(ROOT, 'deploy', 'public', 'capiche');
const SRC = path.join(DIR, 'capiche.pdf');

const results = [];
const rec = (name, ok, detail) => {
  results.push({ name, ok, detail });
  if (!ok) console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
};
const section = (t) => console.log(`\n${t}\n${'-'.repeat(t.length)}`);

const E = await bootEditor(DIR, { expose: [
  'addons', 'addonsInit', 'addonsSnap', 'addonOps', 'addonCapacity', 'addonNameMax',
  'addonRowGeo', 'addonLive', 'memSnapshot', 'memApply', 'furnitureRuleYs',
] });
const FM = E.FM;
const A = FM.addons;
if (!A) { console.log('FM.addons missing — run src/capiche/addon_data.js --write first'); console.log('0 passed, 1 failed'); process.exit(1); }
const AD = () => E.bind.addons;           // live engine state
const FIELD = {}; for (const f of FM.fields) FIELD[f.id] = f;
const SLOT_YS = A.rows.map(r => r.y);

console.log(`\nCAPICHE ADD-ONS verification — ${A.rows.length} baked rows, capacity ${E.bind.addonCapacity()}`);

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------
/** text lines on page 0 whose vertical centre sits on a row baseline, right column only */
const rowLines = (pdf, y) => textLines(pdf, 0)
  .filter(l => l.x0 > 500 && Math.abs((l.top + l.bot) / 2 - (y + 2)) < 6);
const pageText0 = (pdf) => textLines(pdf, 0).map(l => l.text).join('\n');

async function structural(tag, pdf) {
  const streams = await pageStreams(pdf);
  for (const [i, s] of streams.entries()) {
    const b = operatorBalance(s);
    rec(`${tag}: page ${i} operators balanced`, b.ok, b.detail);
  }
  const w = E.takeWarnings();
  rec(`${tag}: no engine warnings`, w.length === 0, w.join(' | ').slice(0, 120));
}

/** ink measured over one row band; the leader hairline included */
const rowInk = (pdf, y) => inkRuns(pdf, 0, { x0: 538, x1: 812, yTop: y + 4.5, yBot: y - 3, dpi: 600 });

// ---------------------------------------------------------------------------------------------
section('1. at rest');
// ---------------------------------------------------------------------------------------------
{
  E.reset(); E.takeWarnings();
  const pdf = await exportBytes(E);
  rec('no edits -> byte-identical page streams', await byteIdentical(SRC, pdf));
  rec('no edits -> zero engine warnings', E.takeWarnings().length === 0);
  rec('addonOps emits zero ops at rest', E.bind.addonOps(0).ops.length === 0 && E.bind.addonOps(0).add === '');
  const base = textLines(SRC, 0);
  rec('no heading baked above the block', !base.some(l => l.x0 > 500 && l.bot > 106 && l.top < 158), 'artwork must have no heading');
  // the leader pins survive: all four extras baselines are still reported
  rec('furnitureRuleYs pins 4 leader baselines', E.bind.furnitureRuleYs(0).length === 4);
}

// ---------------------------------------------------------------------------------------------
section('2. rename — every baked row');
// ---------------------------------------------------------------------------------------------
for (let i = 0; i < A.rows.length; i++) {
  const slot = A.rows[i], baked = slot.name.text;
  const nu = 'ROW ' + 'ABCD'[i] + ' RENAMED';
  E.reset(); E.takeWarnings();
  AD().rows[i].name = nu;
  const pdf = await exportBytes(E);
  const lines = rowLines(pdf, slot.y);
  rec(`rename[${i}] "${baked}" -> "${nu}": new text renders on its row`, lines.some(l => l.text.includes(nu)), JSON.stringify(lines.map(l => l.text)));
  // exact-line match, scoped to the block: "TRUFFLE" is also a pizza name and part of another row
  const blockLines = SLOT_YS.flatMap(y => rowLines(pdf, y));
  rec(`rename[${i}]: old text gone from the block`, !blockLines.some(l => l.text.trim() === baked));
  // leader follows the new name end and still stops short of the price
  const g = E.bind.addonRowGeo(nu, AD().rows[i].price);
  const ink = rowInk(pdf, slot.y);
  const afterName = ink.filter(r => r.x0 > g.nameEnd + 1 && r.x1 < g.priceLeft - 0.5);
  rec(`rename[${i}]: leader present between name and price`, afterName.length > 0 && Math.max(...afterName.map(r => r.x1)) - Math.min(...afterName.map(r => r.x0)) > 8,
      `nameEnd=${g.nameEnd.toFixed(1)} priceLeft=${g.priceLeft.toFixed(1)} ink=${ink.map(r => r.x0.toFixed(0) + '-' + r.x1.toFixed(0)).join(',')}`);
  rec(`rename[${i}]: no ink runs into the price`, !ink.some(r => r.x0 < g.priceLeft - 0.5 && r.x1 > g.priceLeft + 0.5), 'leader or name crosses the price left edge');
  await structural(`rename[${i}]`, pdf);
}

// ---------------------------------------------------------------------------------------------
section('3. price change — every baked row (with digit-count changes)');
// ---------------------------------------------------------------------------------------------
const NEW_PRICES = ['90/300', '1250', '95', '9999'];   // row order: GHASLET, PARMESAN, BURRATA, TRUFFLE
for (let i = 0; i < A.rows.length; i++) {
  const slot = A.rows[i], oldP = FIELD[slot.price_id].text, nu = NEW_PRICES[i];
  E.reset(); E.takeWarnings();
  AD().rows[i].price = nu;
  const pdf = await exportBytes(E);
  const lines = rowLines(pdf, slot.y);
  rec(`price[${i}] ${oldP} -> ${nu}: renders on its row`, lines.some(l => l.text === nu), JSON.stringify(lines.map(l => l.text)));
  rec(`price[${i}]: old price gone from its row`, !lines.some(l => l.text === oldP));
  const pl = lines.find(l => l.text === nu);
  rec(`price[${i}]: right-aligned to the common edge`, pl && Math.abs(pl.x1 - A.right_edge) < 2.5, pl && `x1=${pl.x1.toFixed(1)} vs ${A.right_edge}`);
  // the leader must have followed the price's new left edge (the pre-existing extras bug)
  const g = E.bind.addonRowGeo(AD().rows[i].name, nu);
  const ink = rowInk(pdf, slot.y);
  rec(`price[${i}]: leader stops short of the new price`, !ink.some(r => r.x0 < g.priceLeft - 0.5 && r.x1 > g.priceLeft + 0.5),
      `priceLeft=${g.priceLeft.toFixed(1)}`);
  await structural(`price[${i}]`, pdf);
}

// ---------------------------------------------------------------------------------------------
section('4. long names — budget honoured, no collision');
// ---------------------------------------------------------------------------------------------
{
  const LONG = 'GARLIC BUTTER BREAD WITH PARMESAN';   // 33 chars — must fit beside a 3-char price
  for (let i = 0; i < A.rows.length; i++) {
    E.reset(); E.takeWarnings();
    AD().rows[i].price = '140';
    AD().rows[i].name = LONG;
    const max = E.bind.addonNameMax('140');
    rec(`long[${i}]: budget admits the 33-char name`, LONG.length <= max, `max=${max}`);
    const pdf = await exportBytes(E);
    const lines = rowLines(pdf, A.rows[i].y);
    rec(`long[${i}]: renders complete`, lines.some(l => l.text.includes(LONG)), JSON.stringify(lines.map(l => l.text)));
    const g = E.bind.addonRowGeo(LONG, '140');
    const ink = rowInk(pdf, A.rows[i].y);
    rec(`long[${i}]: name+leader stay clear of the price`, !ink.some(r => r.x0 < g.priceLeft - 0.5 && r.x1 > g.priceLeft + 0.5));
    E.takeWarnings();
  }
  // the budget itself: a name over budget is what the UI blocks; the number must be sane
  const m3 = E.bind.addonNameMax('140'), m7 = E.bind.addonNameMax('120/400');
  rec('budget shrinks for a wider price', m7 < m3, `3-char=${m3} 7-char=${m7}`);
  rec('every baked name is within its own budget', A.rows.every((r, i) => r.name.text.length <= E.bind.addonNameMax(FIELD[r.price_id].text)));
}

// ---------------------------------------------------------------------------------------------
section('5. remove — every baked row (and 6. restore)');
// ---------------------------------------------------------------------------------------------
for (let i = 0; i < A.rows.length; i++) {
  const slot = A.rows[i], baked = slot.name.text;
  E.reset(); E.takeWarnings();
  AD().rows[i].removed = true;
  const pdf = await exportBytes(E);
  const blockLines = SLOT_YS.flatMap(y => rowLines(pdf, y));
  rec(`remove[${i}] "${baked}": name gone from the block`, !blockLines.some(l => l.text.trim() === baked));
  // content shifts up into the earlier slots; the LAST slot must be completely blank —
  // this is the render-level proof that a zero-length leader paints nothing
  const lastY = SLOT_YS[SLOT_YS.length - 1];
  const ink = rowInk(pdf, lastY);
  rec(`remove[${i}]: bottom slot is empty ink`, ink.length === 0, ink.map(r => `${r.x0.toFixed(0)}-${r.x1.toFixed(0)}`).join(','));
  // the three survivors occupy the top three slots, in order
  const live = A.rows.filter((_, k) => k !== i).map(r => r.name.text);
  for (let k = 0; k < live.length; k++) {
    const lines = rowLines(pdf, SLOT_YS[k]);
    rec(`remove[${i}]: slot ${k} now shows "${live[k]}"`, lines.some(l => l.text.includes(live[k])), JSON.stringify(lines.map(l => l.text)));
  }
  await structural(`remove[${i}]`, pdf);

  // restore -> byte-identical again
  AD().rows[i].removed = false;
  const back = await exportBytes(E);
  rec(`restore[${i}]: byte-identical after restore`, await byteIdentical(SRC, back));
  E.takeWarnings();
}

// ---------------------------------------------------------------------------------------------
section('7. reorder');
// ---------------------------------------------------------------------------------------------
{
  E.reset(); E.takeWarnings();
  AD().rows.reverse();
  const pdf = await exportBytes(E);
  const want = A.rows.map(r => r.name.text).reverse();   // TRUFFLE first now
  for (let k = 0; k < want.length; k++) {
    const lines = rowLines(pdf, SLOT_YS[k]);
    rec(`reverse: slot ${k} shows "${want[k]}"`, lines.some(l => l.text.includes(want[k])), JSON.stringify(lines.map(l => l.text)));
    const priceWant = FIELD[A.rows[want.length - 1 - k].price_id].text;
    rec(`reverse: slot ${k} price is ${priceWant}`, lines.some(l => l.text === priceWant));
  }
  await structural('reverse', pdf);

  E.reset(); E.takeWarnings();
  const t = AD().rows[0]; AD().rows[0] = AD().rows[1]; AD().rows[1] = t;   // adjacent swap
  const pdf2 = await exportBytes(E);
  rec('swap: slot 0 shows PARMESAN row', rowLines(pdf2, SLOT_YS[0]).some(l => l.text.includes('PARMESAN')));
  rec('swap: slot 1 shows GHASLET row', rowLines(pdf2, SLOT_YS[1]).some(l => l.text.includes('GHASLET')));
  rec('swap: slots 2/3 untouched', rowLines(pdf2, SLOT_YS[2]).some(l => l.text.includes('BURRATA')) && rowLines(pdf2, SLOT_YS[3]).some(l => l.text.includes('TRUFFLE')));
  await structural('swap', pdf2);
}

// ---------------------------------------------------------------------------------------------
section('8. add new rows');
// ---------------------------------------------------------------------------------------------
{
  E.reset(); E.takeWarnings();
  const cap = E.bind.addonCapacity();
  rec('capacity is 6 (4 baked + 2 appended)', cap === 6, `cap=${cap}`);
  AD().rows.push({ key: 't1', name: 'GARLIC BREAD', price: '160', removed: false });
  AD().rows.push({ key: 't2', name: 'CHILLI OIL', price: '90', removed: false });
  const pdf = await exportBytes(E);
  const y5 = SLOT_YS[3] - A.pitch, y6 = SLOT_YS[3] - 2 * A.pitch;
  const l5 = rowLines(pdf, y5), l6 = rowLines(pdf, y6);
  rec('added row 5 renders at the next pitch', l5.some(l => l.text.includes('GARLIC BREAD')), JSON.stringify(l5.map(l => l.text)));
  rec('added row 5 price right-aligned', (() => { const p = l5.find(l => l.text === '160'); return p && Math.abs(p.x1 - A.right_edge) < 2.5; })());
  rec('added row 6 renders below it', l6.some(l => l.text.includes('CHILLI OIL')), JSON.stringify(l6.map(l => l.text)));
  const g5 = E.bind.addonRowGeo('GARLIC BREAD', '160');
  const ink5 = rowInk(pdf, y5);
  rec('added row 5 has a leader', ink5.some(r => r.x0 > g5.nameEnd && r.x1 < g5.priceLeft + 0.5 && r.w > 8));
  // nothing below the last permitted row (the red strapline zone stays clear)
  const below = inkRuns(pdf, 0, { x0: 538, x1: 812, yTop: y6 - 3.2, yBot: A.floor_y + 0.5, dpi: 600 });
  rec('no ink between row 6 and the strapline floor', below.length === 0, below.map(r => `${r.x0.toFixed(0)}-${r.x1.toFixed(0)}`).join(','));
  await structural('added rows', pdf);
}

// ---------------------------------------------------------------------------------------------
section('10. heading');
// ---------------------------------------------------------------------------------------------
{
  E.reset(); E.takeWarnings();
  AD().title = 'EXTRAS';
  const pdf = await exportBytes(E);
  const hy = A.rows[0].y + 18;
  const hl = textLines(pdf, 0).filter(l => l.x0 > 500 && Math.abs((l.top + l.bot) / 2 - (hy + 4)) < 9);
  rec('heading "EXTRAS" renders above the block', hl.some(l => l.text.includes('EXTRAS')), JSON.stringify(hl.map(l => l.text)));
  await structural('heading', pdf);
  E.reset(); E.takeWarnings();
  const pdf2 = await exportBytes(E);
  rec('clearing the heading returns to byte identity', await byteIdentical(SRC, pdf2));
  // charset facts the UI gate relies on
  rec("heading charset has no Z (so e.g. 'ZESTY' is blocked)", E.bind.ALLOWED.name.indexOf('Z') === -1);
  rec("'ADD ONS' / 'ADDITIONS' printable in the heading face", [...'ADD ONS', ...'ADDITIONS'].every(c => E.bind.ALLOWED.name.indexOf(c) >= 0));
}

// ---------------------------------------------------------------------------------------------
section('11. interaction with dish machinery');
// ---------------------------------------------------------------------------------------------
{
  // an addon edit + removing the right column's LAST dish (PICANTE 0:30) — the removal's divider
  // sweep must consume a real divider, never a pinned leader (dividerOps kill guard)
  E.reset(); E.takeWarnings();
  AD().rows[0].name = 'HOUSE HOT SAUCE - 30ML';
  E.removed.add('0:30');
  const pdf = await exportBytes(E);
  rec('interaction: renamed row renders', rowLines(pdf, SLOT_YS[0]).some(l => l.text.includes('HOUSE HOT SAUCE')));
  rec('interaction: PICANTE gone', !pageText0(pdf).includes('PICANTE'));
  // the other three rows must be untouched, leaders included: same ink layout as the pristine PDF
  for (let k = 1; k < 4; k++) {
    const got = rowInk(pdf, SLOT_YS[k]);
    const ref = inkRuns(SRC, 0, { x0: 538, x1: 812, yTop: SLOT_YS[k] + 4.5, yBot: SLOT_YS[k] - 3, dpi: 600 });
    const span = r => r.length ? [Math.min(...r.map(x => x.x0)), Math.max(...r.map(x => x.x1))] : [0, 0];
    const [g0, g1] = span(got), [r0, r1] = span(ref);
    rec(`interaction: row ${k} ink unchanged by the dish removal`, Math.abs(g0 - r0) < 0.7 && Math.abs(g1 - r1) < 0.7,
        `got ${g0.toFixed(1)}-${g1.toFixed(1)} vs ${r0.toFixed(1)}-${r1.toFixed(1)}`);
  }
  await structural('interaction', pdf);
  E.removed.clear();
}

// ---------------------------------------------------------------------------------------------
section('12. persistence');
// ---------------------------------------------------------------------------------------------
{
  E.reset(); E.takeWarnings();
  AD().rows[2].name = 'BURRATA + STRACCIATELLA';
  AD().rows[2].price = '260';
  AD().title = 'ADD ONS';
  const snap = E.bind.memSnapshot();
  const want = await exportBytes(E);
  // wreck the state, then restore from the snapshot
  E.reset();
  AD().rows.reverse(); AD().rows[0].name = 'WRECKED'; AD().title = '';
  E.bind.memApply(snap);
  const got = await exportBytes(E);
  rec('snapshot -> apply reproduces the exact bytes', Buffer.compare(Buffer.from(want), Buffer.from(got)) === 0);
  rec('snapshot carries the addons state', !!(snap.addons && snap.addons.rows && snap.addons.title === 'ADD ONS'));

  // legacy autosave (pre-panel): an addon price living in `edits` must fold into the row
  E.reset(); E.takeWarnings();
  E.bind.memApply({ edits: { '0:60': '999' } });
  rec('legacy price edit migrates into its row', AD().rows.some(r => r.price === '999') && !('0:60' in E.edits));
  const pdf = await exportBytes(E);
  const row = A.rows.findIndex(r => r.price_id === '0:60');
  rec('legacy price renders on the right row', rowLines(pdf, SLOT_YS[row]).some(l => l.text === '999'));
  E.reset(); E.takeWarnings();
}

// ---------------------------------------------------------------------------------------------
const passed = results.filter(r => r.ok).length, failed = results.length - passed;
console.log('\n' + '-'.repeat(64));
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
