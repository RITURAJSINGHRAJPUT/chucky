#!/usr/bin/env node
// QR tool (src/shared/qrtool) — every editor, audited AS A VIEWER.
//
//   node test/qrtool.test.mjs
//
// For each of the seven editors: an untouched state stays byte-identical; the artwork's own QRs
// are discovered; resizing / moving / removing one changes exactly its ink box (measured from a
// render); an ADDED QR decodes back to its link from the rendered page and leaves everything
// outside its box pixel-identical; "change link" replaces an artwork QR with one that decodes to
// the new link; and a snap()/load() round trip (what autosave + Publish carry) re-exports the
// same bytes.
import { createRequire } from 'module';
import { bootEditor } from './lib/engine.mjs';
import { renderGray, sampleQR } from '../src/shared/qr/sample.mjs';
import { qrDecodeMatrix } from '../src/shared/qr/decode.mjs';

const require = createRequire(import.meta.url);
const fs = require('fs');
const path = require('path');
const { ROOT, outDir } = require('./lib/out.js');
const { checkUncompressed } = require('./lib/pdf.js');
const mupdf = await import('mupdf');

const OUT = outDir('qrtool');
let pass = 0, fail = 0;
const rec = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

/* ink box (pt, y up) of everything dark inside a region */
function ink(bytes, page, r, dpi = 300) {
  const { g, W, H } = renderGray(bytes, page, { ...r, dpi });
  let x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (g[y * W + x] < 110) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (x1 < 0) return null;
  const k = 72 / dpi;
  return { x0: r.x0 + x0 * k, x1: r.x0 + (x1 + 1) * k, yTop: r.yTop - y0 * k, yBot: r.yTop - (y1 + 1) * k };
}
function inkMinus(bytes, without, page, r, dpi = 300) {
  const A = renderGray(bytes, page, { ...r, dpi }), B = renderGray(without, page, { ...r, dpi });
  let x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1;
  for (let y = 0; y < A.H; y++) for (let x = 0; x < A.W; x++) {
    const i = y * A.W + x; if (A.g[i] < 110 && B.g[i] >= 110) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) return null;
  const k = 72 / dpi;
  return { x0: r.x0 + x0 * k, x1: r.x0 + (x1 + 1) * k, yTop: r.yTop - y0 * k, yBot: r.yTop - (y1 + 1) * k };
}
function decodeAt(bytes, page, b) {
  const m = (b.x1 - b.x0) * 0.04;   // inside the white quiet zone: only the code's own ink
  try {
    const s = sampleQR(bytes, page, { x0: b.x0 - m, x1: b.x1 + m, yTop: b.y1 + m, yBot: b.y0 - m }, { dpi: 600 });
    return qrDecodeMatrix(s.matrix, s.size).text;
  } catch (e) { return 'ERR ' + e.message; }
}
function raster(bytes, page, dpi = 72) {
  const pix = mupdf.Document.openDocument(new Uint8Array(bytes), 'application/pdf').loadPage(page)
    .toPixmap(mupdf.Matrix.scale(dpi / 72, dpi / 72), mupdf.ColorSpace.DeviceRGB, false, true);
  return { w: pix.getWidth(), h: pix.getHeight(), px: pix.getPixels().slice() };
}
/* pixels that differ OUTSIDE box b (pt), 1pt slack for anti-aliasing */
function diffOutside(A, B, b, Hpt, dpi = 72) {
  let n = 0; const k = dpi / 72;
  for (let y = 0; y < A.h; y++) for (let x = 0; x < A.w; x++) {
    const X = x / k, Y = Hpt - y / k;
    if (X >= b.x0 - 1.5 && X <= b.x1 + 1.5 && Y >= b.y0 - 1.5 && Y <= b.y1 + 1.5) continue;
    const i = (y * A.w + x) * 3;
    if (Math.abs(A.px[i] - B.px[i]) + Math.abs(A.px[i + 1] - B.px[i + 1]) + Math.abs(A.px[i + 2] - B.px[i + 2]) > 40) n++;
  }
  return n;
}
const near = (a, b, tol = 1.2) => Math.abs(a - b) <= tol;
const r1 = v => Math.round(v * 10) / 10;

const EDITORS = [
  { name: 'capiche', qrs: { 0: 1, 1: 1 } }, { name: 'aiko', qrs: { 1: 2 } }, { name: 'churnd', qrs: {} },
  { name: 'beshak', qrs: {} }, { name: 'drinks', qrs: {} }, { name: 'capiche-surat', qrs: {} }, { name: 'capiche-ahm', qrs: {} },
];
const LINK = 'https://www.instagram.com/pizza.capiche/';
const LINK2 = 'https://bookends.co.in/menu?src=qr';

async function boot(name) {
  if (name === 'beshak') {
    const { bootHarness } = require('../beshakh.js');
    const H = await bootHarness();
    return { regen: async () => Buffer.from(await H.regenerate()), Q: H.QRK };
  }
  const E = await bootEditor(path.join(ROOT, 'deploy', 'public', name), { expose: ['QRK'] });
  return { regen: async () => Buffer.from(await E.regenerate()), Q: E.bind.QRK, E };
}
const pageSize = (bytes, p) => { const b = mupdf.Document.openDocument(new Uint8Array(bytes), 'application/pdf').loadPage(p).getBounds(); return [b[2] - b[0], b[3] - b[1]]; };

for (const ed of EDITORS) {
  console.log(`\n${ed.name}\n${'-'.repeat(ed.name.length)}`);
  let T;
  try { T = await boot(ed.name); } catch (e) { rec(`${ed.name}: boots with the QR tool`, false, e.message); continue; }
  const { Q, regen } = T;
  if (!Q) { rec(`${ed.name}: QR tool present`, false, 'QRK not exposed'); continue; }
  const base = await regen();
  rec(`${ed.name}: untouched export byte-identical on a second pass`, Buffer.compare(base, await regen()) === 0);

  // ---- the artwork's own QRs ----
  const found = Q.list();
  const byPage = {}; for (const q of found) byPage[q.page] = (byPage[q.page] || 0) + 1;
  rec(`${ed.name}: finds the artwork's QRs`, JSON.stringify(byPage) === JSON.stringify(ed.qrs), JSON.stringify(byPage));

  for (const q of found) {
    const b = q.box, cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2, w = b.x1 - b.x0;
    const zone = { x0: b.x0 - w, x1: b.x1 + w, yTop: b.y1 + w, yBot: b.y0 - w };
    /* the QR's own ink = what is dark with it drawn but not with it hidden (the zone also holds
       captions / logos that must not count) */
    Q.remove(q.id); const hidden = await regen(); Q.restore(q.id); Q.reset(q.id);
    const qink = bytes => inkMinus(bytes, hidden, q.page, zone);
    const i0 = qink(base);
    // bigger
    Q.setSize(q.id, w * 1.5);
    let out = await regen(); let i1 = qink(out);
    rec(`${ed.name}: ${q.label} p${q.page} resizes to 150% about its centre`,
      i0 && i1 && near(i1.x1 - i1.x0, (i0.x1 - i0.x0) * 1.5, 1.5) && near((i1.x0 + i1.x1) / 2, (i0.x0 + i0.x1) / 2, 1),
      i1 ? `ink ${r1(i0.x1 - i0.x0)} -> ${r1(i1.x1 - i1.x0)}pt` : 'no ink');
    // smaller, with the - button
    Q.reset(q.id); for (let k = 0; k < 3; k++) Q.grow(q.id, -1);
    out = await regen(); i1 = qink(out);
    rec(`${ed.name}: ${q.label} p${q.page} shrinks with three "−" clicks (70%)`,
      i1 && near(i1.x1 - i1.x0, (i0.x1 - i0.x0) * 0.7, 1.5), i1 ? `ink ${r1(i1.x1 - i1.x0)}pt` : 'no ink');
    // move
    Q.reset(q.id); Q.move(q.id, 12, -8);
    out = await regen(); i1 = qink(out);
    rec(`${ed.name}: ${q.label} p${q.page} moves (+12, −8)pt`, i1 && near(i1.x0 - i0.x0, 12, 1) && near(i1.yTop - i0.yTop, -8, 1),
      i1 ? `dx ${r1(i1.x0 - i0.x0)} dy ${r1(i1.yTop - i0.yTop)}` : 'no ink');
    // remove / restore
    Q.reset(q.id); Q.remove(q.id);
    out = await regen();
    rec(`${ed.name}: ${q.label} p${q.page} removes cleanly`, ink(out, q.page, { x0: b.x0, x1: b.x1, yTop: b.y1, yBot: b.y0 }) === null);
    Q.restore(q.id); Q.reset(q.id);
    rec(`${ed.name}: ${q.label} p${q.page} reset -> byte-identical again`, Buffer.compare(await regen(), base) === 0);
    // change link
    const nid = Q.setLink(q.id, LINK2);
    out = await regen();
    const nb = Q.list().find(x => x.id === nid).box;
    rec(`${ed.name}: ${q.label} p${q.page} "change link" prints a code for the new link in its place`,
      decodeAt(out, q.page, nb) === LINK2 && near(nb.x1 - nb.x0, w, 0.01) && near((nb.x0 + nb.x1) / 2, cx, 0.01) && near((nb.y0 + nb.y1) / 2, cy, 0.01),
      decodeAt(out, q.page, nb));
    Q.load({});
  }

  // ---- ADD a QR on the first page and the last ----
  const [W, H] = pageSize(base, 0);
  const id = Q.add({ page: 0, url: LINK, cx: W / 2, cy: H / 2, size: 70 });
  let out = await regen();
  const box = Q.list(0).find(x => x.id === id).box;
  const got = decodeAt(out, 0, box);
  rec(`${ed.name}: an added QR decodes to its link from the rendered page`, got === LINK, got);
  const un = await checkUncompressed(out);
  rec(`${ed.name}: export with an added QR keeps streams uncompressed`, un.ok, JSON.stringify(un.filteredPages));
  const qz = 70 / 25 * 2 + 0.5;   // quiet zone ≈ 2 modules either side (v3 = 29 modules for this link)
  const outside = diffOutside(raster(base, 0), raster(out, 0), { x0: box.x0 - qz, x1: box.x1 + qz, y0: box.y0 - qz, y1: box.y1 + qz }, H);
  rec(`${ed.name}: nothing outside the added QR changes on the page`, outside === 0, `${outside} px`);
  if (ed.name === 'capiche') fs.writeFileSync(path.join(OUT, `${ed.name}_added.pdf`), out);

  Q.setSize(id, 110); Q.move(id, -20, 30);
  out = await regen();
  const b2 = Q.list(0).find(x => x.id === id).box;
  rec(`${ed.name}: the added QR resizes + moves and still scans`, decodeAt(out, 0, b2) === LINK && near(b2.x1 - b2.x0, 110, 0.01), `${r1(b2.x1 - b2.x0)}pt`);

  // ---- state round trip (autosave / history / Publish carry exactly this) ----
  const snap = JSON.parse(JSON.stringify(Q.snap()));
  Q.load({}); rec(`${ed.name}: clearing QR state -> byte-identical to untouched`, Buffer.compare(await regen(), base) === 0);
  Q.load(snap); rec(`${ed.name}: snap()/load() round trip re-exports the same bytes`, Buffer.compare(await regen(), out) === 0);
  Q.remove(id); rec(`${ed.name}: removing the added QR -> byte-identical to untouched`, Buffer.compare(await regen(), base) === 0);
  Q.load({ added: [{ url: 'x'.repeat(400), page: 0, cx: 10, cy: 10, size: 50 }, { url: 'javascript:alert(1)', page: 0, cx: 1, cy: 1, size: 1e9 }] });
  rec(`${ed.name}: load() drops an unencodable link and clamps size`, Q.list().length === found.length + 1 && Q.sizeOf(Q.list().find(x => x.kind === 'added').id) === 220);
  Q.load({});
}

// ---- the click-to-edit UI itself (jsdom: no layout, so this drives the real handlers, not pixels) ----
{
  console.log('\nUI (capiche, jsdom)\n-------------------');
  const E = await bootEditor(path.join(ROOT, 'deploy', 'public', 'capiche'), { expose: ['QRK'] });
  const Q = E.bind.QRK; await E.regenerate();
  const doc = globalThis.document, win = doc.defaultView;
  const stage = doc.createElement('div'); const hl = doc.createElement('div'); stage.appendChild(hl); doc.body.appendChild(stage);
  Q.hits(hl, 0, 841.89, 595.276);
  const ID = 'capiche-p0-CkQR1';
  const box = hl.querySelector('.qrk-box'), addBtn = stage.querySelector('.qrk-add');
  rec('UI: the artwork QR gets a clickable box, the page gets a "+ QR" button', !!box && !!addBtn && box.dataset.qr === ID);
  const ptr = (el, type) => { const ev = new win.Event(type, { bubbles: true }); Object.assign(ev, { button: 0, clientX: 10, clientY: 10, pointerId: 1 }); el.dispatchEvent(ev); };
  ptr(box, 'pointerdown'); ptr(box, 'pointerup');
  const panel = doc.querySelector('.qrk-panel');
  rec('UI: clicking the QR opens its panel with size, move, link and remove', !!panel &&
    ['minus', 'plus', 'L', 'R', 'U', 'D', 'link', 'reset', 'remove'].every(a => panel.querySelector(`[data-a="${a}"]`)));
  const click = a => doc.querySelector(`.qrk-panel [data-a="${a}"]`).dispatchEvent(new win.Event('click', { bubbles: true }));
  const w0 = Q.sizeOf(ID);
  click('plus'); click('plus');
  rec('UI: "+" twice grows it 20%', near(Q.sizeOf(ID), w0 * 1.2, 0.01), `${r1(w0)} -> ${r1(Q.sizeOf(ID))}pt · shows ${doc.querySelector('.qrk-val').textContent}`);
  click('minus');
  rec('UI: "−" shrinks it back a step', near(Q.sizeOf(ID), w0 * 1.1, 0.01));
  const c0 = Q.list(0)[0].box; click('R'); click('U'); const c1 = Q.list(0)[0].box;
  rec('UI: arrows nudge it 0.5mm right and up', near(c1.x0 - c0.x0, 1.4175, 0.001) && near(c1.y0 - c0.y0, 1.4175, 0.001));
  const rng = doc.querySelector('.qrk-panel input[type=range]'); rng.value = String(Math.round(w0 * 1.5)); rng.dispatchEvent(new win.Event('input', { bubbles: true }));
  rec('UI: the slider sets the size directly', near(Q.sizeOf(ID), Math.round(w0 * 1.5), 0.01));
  click('remove');
  rec('UI: Remove hides it and closes the panel', Q.list(0)[0].off && !doc.querySelector('.qrk-panel'));
  addBtn.dispatchEvent(new win.Event('click', { bubbles: true }));
  doc.querySelector('.qrk-panel input[type=url]').value = 'https://bookends.co.in/';
  doc.querySelector('.qrk-panel [data-a="go"]').dispatchEvent(new win.Event('click', { bubbles: true }));
  const added = Q.list(0).find(x => x.kind === 'added');
  rec('UI: "+ QR" → paste link → Add QR places a code mid-page and opens its panel',
    !!added && near((added.box.x0 + added.box.x1) / 2, 841.89 / 2, 0.01) && !!doc.querySelector('.qrk-panel [data-a="plus"]'));
  const snap = Q.snap();
  rec('UI: the edits are in the saved state (autosave / Publish)', snap.added.length === 1 && snap.base[ID].off === true);
}

console.log(`\nQR tool:${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
