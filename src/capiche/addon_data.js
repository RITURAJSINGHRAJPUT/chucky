#!/usr/bin/env node
/* addon_data.js — record the Capiche ADD-ONS block into fieldmap.json as a top-level `addons` key.
 *
 * The block (page 0, bottom of the right column) is four "name …leader… price" rows:
 *   GHASLET HOT SAUCE - 30ML/180ML ......... 120/400
 *   PARMESAN, TRUFFLE AIOLI ................ 120
 *   BURRATA CHEESE ......................... 200
 *   TRUFFLE ................................ 240
 * The four PRICES are already price fields (0:58-0:61, the "extras" the editor shows as bare
 * chips). The four NAMES and the four vector leader rules are unmapped artwork — this script
 * finds them and records their byte spans so the editor can edit the whole row.
 *
 * Deliberately writes a NEW top-level key rather than new entries in fields[]: the dish
 * machinery (itemsForPage grouping, reflow, build_food.js --validate-page0) must keep seeing
 * exactly the fields it sees today. In particular furnitureRuleYs() derives its pin list from
 * the extras, so the prices stay ordinary price fields.
 *
 * Usage:  node src/capiche/addon_data.js deploy/public/capiche [--write]
 * Dry-run by default (prints the addons object + gate results). --write backs the fieldmap up
 * to backups/ first. Idempotent: re-running replaces the addons key and must change nothing else.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { PDFDocument, PDFName } = require('pdf-lib');

const DIR = process.argv[2];
const WRITE = process.argv.includes('--write');
if (!DIR) { console.error('usage: node src/capiche/addon_data.js <editor_dir> [--write]'); process.exit(2); }

const FM_PATH = path.join(DIR, 'fieldmap.json');
const fm = JSON.parse(fs.readFileSync(FM_PATH, 'utf8'));
const PDF_PATH = path.join(DIR, fs.readdirSync(DIR).find(f => /\.pdf$/i.test(f)));

// The geometry that identifies the block. Everything else is measured, not assumed.
const PAGE = 0;
const NAME_SIZE = 7.2142;         // the add-on name runs' Tm scale (desc font at a size no desc uses)
const X_MIN = 500, Y_MIN = 40, Y_MAX = 110;

const round2 = v => Math.round(v * 100) / 100;

async function pageStream(pdfPath, pageIdx) {
  const doc = await PDFDocument.load(fs.readFileSync(pdfPath));
  const page = doc.getPages()[pageIdx];
  const ref = page.node.get(PDFName.of('Contents'));
  const stream = doc.context.lookup(ref);
  return Buffer.from(stream.contents);
}

function fail(msg) { console.error('GATE FAILED: ' + msg); process.exit(1); }

(async () => {
  const buf = await pageStream(PDF_PATH, PAGE);
  const s = buf.toString('latin1');

  // ---- 1. the name runs: BT..ET blocks whose Tm scale is NAME_SIZE in the block's band --------
  // Illustrator writes one operator per line; the add-on names are single clean (text)Tj runs.
  // the Tm line may carry leading tracking ops ("0 Tw 7.2142 0 0 …")
  const nameRe = /BT\n(?:[^\n]+\n)*?(?:-?[\d.]+ T[cw] )*([\d.]+) 0 0 ([\d.]+) (-?[\d.]+) (-?[\d.]+) Tm\n\(((?:\\.|[^\\()])*)\)Tj\nET/g;
  const names = [];
  let m;
  while ((m = nameRe.exec(s))) {
    const [full, sa, sb, xs, ys, text] = m;
    if (+sa !== NAME_SIZE || +sb !== NAME_SIZE) continue;
    const x = +xs, y = +ys;
    if (x < X_MIN || y < Y_MIN || y > Y_MAX) continue;
    // operand spans, fieldmap conventions: tm_span = the 6 Tm operands, tj_span includes parens
    const tmStr = `${sa} 0 0 ${sb} ${xs} ${ys}`;
    const tmOff = m.index + full.indexOf(tmStr);
    const tjOff = m.index + full.indexOf('(' + text + ')Tj');
    names.push({
      text, x, y, size: +sa,
      block_span: [m.index, m.index + full.length],
      tm_span: [tmOff, tmOff + tmStr.length],
      tm_vals: [+sa, 0, 0, +sb, x, y],
      tj_span: [tjOff, tjOff + text.length + 2],
      has_tf: /\/T1_\d+ 1 Tf/.test(full),
    });
  }
  names.sort((a, b) => b.y - a.y);

  // ---- 2. the leader rules: q 1 0 0 1 X Y cm / 0 0 m / L 0 l / S / Q --------------------------
  const leadRe = /q 1 0 0 1 (-?[\d.]+) (-?[\d.]+) cm\n0 0 m\n([\d.]+) 0 l\nS\nQ/g;
  const leaders = [];
  while ((m = leadRe.exec(s))) {
    const x = +m[1], y = +m[2], len = +m[3];
    if (x < X_MIN || y < Y_MIN || y > Y_MAX) continue;
    leaders.push({ x, y, len, full_span: [m.index, m.index + m[0].length] });
  }

  // ---- 3. the price fields (already in the fieldmap) ------------------------------------------
  const prices = fm.fields.filter(f => f.role === 'price' && f.page === PAGE && f.y >= Y_MIN && f.y <= Y_MAX && f.x >= X_MIN);

  // ---- 4. pair rows by baseline ---------------------------------------------------------------
  const rows = names.map(n => {
    const price = prices.find(p => Math.abs(p.y - n.y) < 1.5);
    const leader = leaders.find(l => Math.abs(l.y - n.y) < 1.5);
    return { n, price, leader };
  });

  // ---- gates ----------------------------------------------------------------------------------
  if (names.length !== 4) fail(`expected 4 add-on name runs, found ${names.length}: ${names.map(n => n.text).join(' | ')}`);
  if (leaders.length !== 4) fail(`expected 4 leader rules, found ${leaders.length}`);
  if (prices.length !== 4) fail(`expected 4 orphan price fields in band, found ${prices.length}`);
  for (const r of rows) {
    if (!r.price) fail(`row "${r.n.text}" has no price field on its baseline`);
    if (!r.leader) fail(`row "${r.n.text}" has no leader rule on its baseline`);
    // spans must decode back to what we recorded
    const tj = s.slice(r.n.tj_span[0], r.n.tj_span[1]);
    if (tj !== '(' + r.n.text + ')') fail(`tj_span of "${r.n.text}" decodes to ${JSON.stringify(tj)}`);
    const tm = s.slice(r.n.tm_span[0], r.n.tm_span[1]);
    if (!tm.endsWith(String(r.n.tm_vals[5]))) fail(`tm_span of "${r.n.text}" decodes to ${JSON.stringify(tm)}`);
    const pj = s.slice(r.price.tj_span[0], r.price.tj_span[1]);
    if (pj !== '(' + r.price.text + ')') fail(`price tj_span of ${r.price.id} decodes to ${JSON.stringify(pj)}`);
  }
  // non-overlap across every span we will let the editor rewrite
  const spans = [];
  for (const r of rows) spans.push(r.n.tj_span, r.n.tm_span, r.price.tj_span, r.price.tm_span, r.leader.full_span);
  spans.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < spans.length; i++) if (spans[i][0] < spans[i - 1][1]) fail(`spans overlap at ${spans[i][0]}`);

  // ---- measured constants ---------------------------------------------------------------------
  // The whole group inherits `0.05 Tc`, so the real advance is (0.63 + 0.05) * size. Proof: the
  // price right edges only align on a common edge under that advance; verify both.
  const ADV = 0.63 + 0.05;
  const rights = rows.map(r => r.price.x + r.price.text.length * ADV * r.price.size);
  const rightEdge = rights.reduce((a, b) => a + b) / rights.length;
  for (const [i, r] of rows.entries()) {
    if (Math.abs(rights[i] - rightEdge) > 0.05) fail(`price right edges do not align under 0.68em advance: ${rights.map(v => v.toFixed(2)).join(', ')}`);
    const nameEnd = r.n.x + r.n.text.length * ADV * r.n.size;
    const gap = r.leader.x - nameEnd;
    if (gap < 2 || gap > 8) fail(`leader gap after "${r.n.text}" measures ${gap.toFixed(2)}pt — advance model is wrong`);
  }
  // name charset sanity (informative: the artwork is its own proof, but warn on surprises)
  const allowedDesc = (fm.allowed && fm.allowed.desc) || '';
  for (const r of rows) for (const ch of r.n.text) {
    if (allowedDesc.indexOf(ch) === -1) console.warn(`note: baked char ${JSON.stringify(ch)} in "${r.n.text}" is not in allowed.desc`);
  }

  // floor: the red "ON THE HOUSE" strapline bounds the block from below. Its Tm y is 17.6221 and
  // its cap-height ink tops out near y 27.3; keep new rows clear of it.
  const strap = /8\.4009 0 0 8\.4009 (54[\d.]+) ([\d.]+) Tm/.exec(s);
  const floorY = strap ? +strap[2] + 11.1 : 29;

  const addons = {
    page: PAGE,
    x: rows[0].n.x,
    name_size: NAME_SIZE,
    price_size: rows[0].price.size,
    tc: 0.05,                       // inherited tracking; advance = (adv + tc) * size
    right_edge: round2(rightEdge),  // common right edge prices align to
    leader_gap: 4.2,                // nameEnd -> leader start (measured 3.5-6.5 baked)
    leader_end_pad: 3.6,            // leader end -> price left (measured 3.2-4.0 baked)
    pitch: 11.68,                   // row pitch below the last baked row
    floor_y: round2(floorY),        // no ink below this (red strapline clearance)
    rows: rows.map(r => ({
      y: r.n.y,
      price_id: r.price.id,
      name: {
        text: r.n.text,
        block_span: r.n.block_span,
        tj_span: r.n.tj_span,
        tm_span: r.n.tm_span,
        tm_vals: r.n.tm_vals,
        has_tf: r.n.has_tf,
      },
      leader: { x: r.leader.x, y: r.leader.y, len: r.leader.len, full_span: r.leader.full_span },
    })),
  };

  // ---- idempotence gate: nothing but the addons key may change --------------------------------
  const before = JSON.stringify({ ...fm, addons: undefined });
  const out = { ...fm, addons };
  const after = JSON.stringify({ ...out, addons: undefined });
  if (before !== after) fail('non-addons fieldmap content changed');

  console.log(JSON.stringify(addons, null, 2));
  console.log(`rows: ${rows.map(r => `"${r.n.text}" = ${r.price.text} (${r.price.id})`).join(' | ')}`);

  if (!WRITE) { console.log('\ndry-run only — pass --write to update ' + FM_PATH); return; }

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const bak = path.join('backups', `capiche_fieldmap_addons_${stamp}.json`);
  fs.mkdirSync('backups', { recursive: true });
  fs.copyFileSync(FM_PATH, bak);
  fs.writeFileSync(FM_PATH, JSON.stringify(out));
  console.log(`wrote ${FM_PATH} (backup: ${bak})`);
})().catch(e => { console.error(e); process.exit(1); });
