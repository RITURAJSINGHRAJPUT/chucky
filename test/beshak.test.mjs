// Beshak editor regression suite.
//
//   node test/beshak.test.mjs        (also runs as part of `npm test`)
//
// Beshak needs its own suite because the shared helpers in test/lib/pdf.js inspect PAGE content
// streams, and Beshak's pages are 80-byte stubs that draw a Form XObject — every editable byte is
// one level down. So byte-identity, operator balance and uncompressedness are all checked against
// the streams the fieldmap actually names.
//
// Every layout claim here is RENDERED and read back (CLAUDE.md hard rule 4): byte checks alone
// would not notice a name that overprints its own allergen icons.
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import { renderPages, renderRegion, textLines } from './lib/render.mjs';

const require = createRequire(import.meta.url);
const { ROOT, outDir } = require('./lib/out.js');
const { operatorBalance } = require('./lib/pdf.js');
const { detectMarkers } = require('../src/beshak/build_beshak.js');
const { PDFDocument, PDFRef } = require('pdf-lib');

const ED = path.join(ROOT, 'deploy', 'public', 'beshak');
const SRC = path.join(ED, 'beshak.pdf');
const FM = JSON.parse(fs.readFileSync(path.join(ED, 'fieldmap.json'), 'utf8'));
const OUT = outDir('beshak');

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail: detail || '' });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? '  — ' + detail : ''}`);
}
async function guard(name, fn) {
  try { const [ok, d] = await fn(); record(name, ok, d); }
  catch (e) { record(name, false, 'threw: ' + String((e && e.message) || e).slice(0, 160)); }
}

/** Run the editor headless with a given edit state and return the exported file's path. */
function run(outName, edits, env) {
  const out = path.join(OUT, outName);
  execFileSync(process.execPath, [path.join(ROOT, 'beshakh.js'), out, JSON.stringify(edits || {})],
    { cwd: ROOT, env: { ...process.env, ...(env || {}) }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000 });
  return out;
}

/** The streams the fieldmap names, as raw buffers. */
async function editableStreams(src) {
  const doc = await PDFDocument.load(fs.readFileSync(src));
  const out = {};
  for (const [sid, info] of Object.entries(FM.streams)) {
    const [n, g] = info.ref.split(' ').map(Number);
    const o = doc.context.lookup(PDFRef.of(n, g));
    out[sid] = { buf: Buffer.from(o.contents), filtered: !!o.dict.get(require('pdf-lib').PDFName.of('Filter')) };
  }
  return out;
}

const dish = (name) => FM.fields.find((f) => f.role === 'name' && f.display === name);
const kid = (id, role) => FM.fields.find((f) => f.of === id && f.role === role);
const linesOf = (pdf, page) => textLines(pdf, page).map((l) => l.text);
const saysOn = (pdf, page, txt) => linesOf(pdf, page).some((t) => t.replace(/\s+/g, ' ').includes(txt));


/** Text width the way the engine measures it, so the test can predict where a cluster lands. */
const famOf = (f) => FM.res_to_family[f.page + f.font];
function widthOf(text, fam, size, kern) {
  const F = FM.families[fam];
  let w = 0, n = 0;
  for (const ch of text) {
    const c = F.uni2cid[ch];
    w += (c !== undefined && F.widths[c] !== undefined) ? F.widths[c] : 500;
    n++;
  }
  return (w / 1000) * size - Math.max(0, n - 1) * ((kern || 0) / 1000) * size;
}

/**
 * Markers actually printed beside one dish, read off the rendered page.
 * Bounds come from the fieldmap rather than from the rendered text layer: both pages set two or
 * three columns on the SAME baseline, and mupdf happily merges them into one text line, which
 * would widen the search across the page and pick up a neighbour's icons.
 */
async function markersOn(pdf, d, nameText, dy) {
  const price = kid(d.id, 'price');
  const gram = kid(d.id, 'gram');
  const name = nameText === undefined ? d.display : nameText;
  const fam = famOf(d);
  const dx = widthOf(name, fam, d.size, d.kern) - widthOf(d.display, fam, d.size, d.kern);
  const from = d.x + widthOf(name, fam, d.size, d.kern) + 1;
  const found = await detectMarkers(pdf, d.page, from, price.x - 1.5, d.y + (dy || 0));
  const g0 = gram.bbox[0] + dx, g1 = gram.bbox[2] + dx;
  const real = found.filter((m) => !(m.x + m.w > g0 - 0.6 && m.x < g1 + 0.6));
  return { types: real.map((m) => m.type), real, from, dx };
}

await (async function main() {
  // ---------------------------------------------------------------- invariants
  await guard('build: every editable stream is uncompressed', async () => {
    const S = await editableStreams(SRC);
    const bad = Object.entries(S).filter(([, v]) => v.filtered).map(([k]) => k);
    return [!bad.length, bad.length ? bad.join(',') : `${Object.keys(S).length} streams`];
  });

  await guard('build: fieldmap covers every dish on the menu', async () => {
    const names = FM.fields.filter((f) => f.role === 'name');
    const withPrice = names.filter((n) => kid(n.id, 'price')).length;
    const withGram = names.filter((n) => kid(n.id, 'gram')).length;
    return [names.length === 26 && withPrice === 26 && withGram === 26,
      `${names.length} dishes, ${withPrice} priced, ${withGram} sized`];
  });

  const empty = run('empty.pdf', {});
  await guard('empty edit: exports byte-identical streams', async () => {
    const A = await editableStreams(SRC), B = await editableStreams(empty);
    const diff = Object.keys(A).filter((k) => !A[k].buf.equals(B[k].buf));
    return [!diff.length, diff.length ? diff.map((k) => `${k} ${A[k].buf.length}->${B[k].buf.length}`).join(', ') : `${Object.keys(A).length} streams`];
  });

  await guard('empty edit: renders pixel-identical to the source', async () => {
    const a = renderPages(SRC, path.join(OUT, 'src'), { dpi: 110 });
    const b = renderPages(empty, path.join(OUT, 'empty'), { dpi: 110 });
    const diffs = a.map((p, i) => {
      const A = fs.readFileSync(p.file), B = fs.readFileSync(b[i].file);
      return A.equals(B) ? null : `p${i}`;
    }).filter(Boolean);
    return [!diffs.length, diffs.join(',')];
  });

  // ---------------------------------------------------------------- text edits
  const palak = dish('Palak Patta Chaat');
  const nameEdit = run('name.pdf', { [palak.id]: 'Papdi Kachori' });
  await guard('name edit: new name is set, old one gone', async () => {
    const ls = linesOf(nameEdit, 0).join(' | ');
    return [ls.includes('Papdi Kachori') && !ls.includes('Palak Patta Chaat'), ''];
  });
  await guard('name edit: operators stay balanced', async () => {
    const S = await editableStreams(nameEdit);
    const bad = Object.entries(S).filter(([, v]) => !operatorBalance(v.buf).ok).map(([k]) => k);
    return [!bad.length, bad.join(',')];
  });
  await guard('name edit: the size label and icons move with the text, no overprint', async () => {
    // "Papdi Kachori" is shorter than "Palak Patta Chaat", so the whole cluster must slide LEFT
    const { types, real, from } = await markersOn(nameEdit, palak, 'Papdi Kachori');
    const moved = real.length && real[0].x < palak.marker_boxes[0].x;
    const clear = real.every((m) => m.x >= from - 0.6);          // nothing overprinting the name
    return [types.join(',') === 'dairy,jain' && moved && clear,
      `markers=[${types}] firstX=${real[0] ? real[0].x : '-'} was ${palak.marker_boxes[0].x}`];
  });

  const descField = kid(palak.id, 'desc');
  const longDesc = 'Crackling spinach, beetroot curd, green chutney, hibiscus chutney, pomegranate and toasted peanuts';
  const descEdit = run('desc.pdf', { [descField.id]: longDesc });
  await guard('description edit: wraps across the baked lines and keeps every word', async () => {
    const ls = linesOf(descEdit, 0);
    const joined = ls.join(' ').replace(/\s+/g, ' ');
    const words = longDesc.split(/[\s,]+/).filter((w) => w.length > 3);
    const missing = words.filter((w) => !joined.includes(w));
    return [missing.length === 0, missing.length ? 'missing: ' + missing.join(',') : `${ls.length} lines rendered`];
  });

  const priceField = kid(palak.id, 'price');
  const gramField = kid(palak.id, 'gram');
  const bits = run('bits.pdf', { [priceField.id]: '520', [gramField.id]: '260 gm' });
  await guard('price and size label edits render', async () => {
    const ls = linesOf(bits, 0).join(' | ');
    return [ls.includes('520') && ls.includes('260 gm'), ''];
  });

  // ---------------------------------------------------------------- markers
  const markerP0 = run('mk_p0.pdf', {}, { MARKERS: JSON.stringify({ [palak.id]: ['dairy', 'gluten', 'sesame'] }) });
  await guard('page 1 markers: vector jain removed, gluten + sesame added', async () => {
    const { types } = await markersOn(markerP0, palak);
    return [types.slice().sort().join(',') === 'dairy,gluten,sesame', `got [${types}]`];
  });

  const naan = dish('Sourdough Naan');
  const markerP1 = run('mk_p1.pdf', {}, { MARKERS: JSON.stringify({ [naan.id]: ['jain'] }) });
  await guard('page 2 markers: the raster-baked dairy and gluten are patched out', async () => {
    const { types } = await markersOn(markerP1, naan);
    return [types.join(',') === 'jain', `got [${types}]`];
  });

  const markerAdd = run('mk_add.pdf', {}, { MARKERS: JSON.stringify({ [naan.id]: ['dairy', 'gluten', 'sesame', 'jain'] }) });
  await guard('page 2 markers: all four can be set at once', async () => {
    const { types } = await markersOn(markerAdd, naan);
    return [types.slice().sort().join(',') === 'dairy,gluten,jain,sesame', `got [${types}]`];
  });

  // ---------------------------------------------------------------- remove + reflow
  const col = FM.columns.find((c) => c.id === palak.col);
  const below = col.ids[1];
  const removeOne = run('remove.pdf', {}, { REMOVED: JSON.stringify([palak.id]) });
  await guard('remove: the dish disappears', async () => {
    const ls = linesOf(removeOne, 0).join(' | ');
    return [!ls.includes('Palak Patta Chaat') && !ls.includes('Crackling Spinach'), ''];
  });
  await guard('remove: the dish below rides up by the freed slot', async () => {
    const target = FM.fields.find((f) => f.id === below);
    const before = textLines(SRC, 0).find((l) => l.text.includes(target.display.split(' ')[0]));
    const after = textLines(removeOne, 0).find((l) => l.text.includes(target.display.split(' ')[0]));
    if (!before || !after) return [false, 'could not locate "' + target.display + '" before/after'];
    const moved = after.top - before.top;
    return [Math.abs(moved - palak.slot) < 2.5, `moved ${moved.toFixed(1)}pt, slot is ${palak.slot}pt`];
  });
  await guard('remove: markers ride up with their dish and nothing is orphaned', async () => {
    const target = FM.fields.find((f) => f.id === below);
    const want = (target.markers || []).join(',');
    const moved = await markersOn(removeOne, target, undefined, palak.slot);
    const leftBehind = await markersOn(removeOne, target);
    return [moved.types.join(',') === want && !leftBehind.types.length,
      `at new y [${moved.types}] want [${want}]; left behind [${leftBehind.types}]`];
  });
  await guard('remove: operators stay balanced', async () => {
    const S = await editableStreams(removeOne);
    const bad = Object.entries(S).filter(([, v]) => !operatorBalance(v.buf).ok).map(([k]) => k);
    return [!bad.length, bad.join(',')];
  });

  // ---------------------------------------------------------------- add
  const addOne = run('add.pdf', {}, {
    ADDED: JSON.stringify([{ col: col.id, index: 1, name: 'Corn Chaat', desc: 'Sweet corn, chaat masala, lime', price: '380', gram: '220 gm', markers: ['dairy', 'jain'] }]),
  });
  await guard('add: the new dish prints with its price and description', async () => {
    const ls = linesOf(addOne, 0).join(' | ');
    return [ls.includes('Corn Chaat') && ls.includes('380') && ls.includes('Sweet corn'), ''];
  });
  await guard('add: operators stay balanced', async () => {
    const S = await editableStreams(addOne);
    const bad = Object.entries(S).filter(([, v]) => !operatorBalance(v.buf).ok).map(([k]) => k);
    return [!bad.length, bad.join(',')];
  });

  // ---------------------------------------------------------------- charset guard
  await guard('charset: a character the menu font lacks is refused, not silently dropped', async () => {
    // the display face has no capital Z (nothing on the menu uses one)
    const has = FM.allowed.name.includes('Z');
    const out = run('badchar.pdf', { [palak.id]: 'Zucchini Chaat' });
    const ls = linesOf(out, 0).join(' | ');
    // regenerate must leave the baked name alone rather than write a broken glyph run
    return [!has && ls.includes('Palak Patta Chaat'), has ? 'font unexpectedly has Z' : 'baked name kept'];
  });

  await guard('charset: an ADDED dish is gated too, not silently dropped', async () => {
    const { bootHarness } = require('../beshakh.js');
    const H = await bootHarness();
    H.added = [{ col: col.id, index: 1, name: 'Zucchini Kebab', price: '380', gram: '200 gm', desc: 'Grilled', markers: [] }];
    const blocked = H.addedIssues(H.added[0]).filter((i) => i.kind === 'char');
    H.added = [{ col: col.id, index: 1, name: 'Corn Chaat', price: '380', gram: '200 gm', desc: 'Sweet corn', markers: [] }];
    const clean = H.addedIssues(H.added[0]).filter((i) => i.kind === 'char');
    return [blocked.length === 1 && clean.length === 0,
      `bad name -> ${blocked.length} issue(s) "${blocked[0] ? blocked[0].msg : ''}"; good name -> ${clean.length}`];
  });

  await guard('charset: an added dish with a missing glyph never reaches the page', async () => {
    const out = run('add_badchar.pdf', {}, {
      ADDED: JSON.stringify([{ col: col.id, index: 1, name: 'Zucchini Kebab', price: '380', gram: '200 gm', desc: 'Grilled', markers: [] }]),
    });
    const ls = linesOf(out, 0).join(' | ');
    const S = await editableStreams(out);
    const balanced = Object.values(S).every((v) => operatorBalance(v.buf).ok);
    return [!ls.includes('Zucchini') && !ls.includes('ucchini') && balanced,
      balanced ? 'nothing half-written' : 'stream corrupted'];
  });

  // ---------------------------------------------------------------- viewer audit
  await guard('render audit: both pages of a fully edited menu still parse and paint', async () => {
    const big = run('audit.pdf', {
      [palak.id]: 'Papdi Kachori',
      [descField.id]: longDesc,
      [priceField.id]: '520',
    }, {
      MARKERS: JSON.stringify({ [palak.id]: ['dairy', 'gluten'], [naan.id]: ['jain'] }),
      REMOVED: JSON.stringify([dish('Masala Chaas').id]),
    });
    const pages = renderPages(big, path.join(OUT, 'audit'), { dpi: 150 });
    const sizes = pages.map((p) => fs.statSync(p.file).size);
    renderRegion(big, path.join(OUT, 'audit_apps.png'), { page: 0, x0: 36, yTop: 500, x1: 560, yBot: 290, dpi: 200 });
    renderRegion(big, path.join(OUT, 'audit_breads.png'), { page: 1, x0: 30, yTop: 500, x1: 580, yBot: 280, dpi: 200 });
    return [pages.length === 2 && sizes.every((s) => s > 20000), `page png sizes ${sizes.join(', ')}`];
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\nBeshak: ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) { console.log('failed: ' + failed.map((f) => f.name).join('; ')); process.exit(1); }
})();
