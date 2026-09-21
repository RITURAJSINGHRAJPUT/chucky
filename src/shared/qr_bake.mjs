#!/usr/bin/env node
// qr_bake.mjs — make every QR code already printed on a menu EDITABLE (resize / move / remove).
//
//   node src/shared/qr_bake.mjs [--write] [--brand=capiche|aiko]
//
// A QR in the artwork is a few hundred vector ops sitting inline in the page content stream. The
// editors address their text by BYTE OFFSET into that stream, so the QR's bytes cannot be pulled
// out or wrapped without moving every span after it. Instead, length-preservingly:
//
//   1. the QR's own contiguous slice of ops moves into a Form XObject tagged /ChuckyQR, and
//   2. the slice in the page stream becomes `/CkQRn Do` + space padding — SAME byte length.
//
// The page renders identically (a Form inherits the graphics state at its Do, which is exactly
// the state the inline ops ran in), no fieldmap span moves, and the editors' QR tool (src/shared/
// qrtool) can then resize / move / hide a QR by rewriting just that XObject's /Matrix and /BBox —
// never touching the page stream the byte engine owns. Untouched => byte-identical export.
//
// Every job is RENDER-VERIFIED before writing: the baked page must rasterise pixel-identical to
// the original, and the page with the Form hidden must have no ink left in the QR's zone.
// Idempotent: a page that already carries the tag is skipped. Re-run after a base-PDF rebuild
// (and after crosspromo_bake.mjs, which is what draws the FSSAI QRs in the first place).
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const fs = require('fs');
const path = require('path');
const { PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFString, PDFDict } = require('pdf-lib');
const mupdf = await import('mupdf');

const WRITE = process.argv.includes('--write');
const ONLY = (process.argv.find(a => /^--brand=/.test(a)) || '').replace('--brand=', '');

/* zones are PDF user space (y up), the QR's module box as rendered; found by decoding a 400dpi
   render of every page (cv2 detectAndDecodeMulti) — these four are ALL the QRs in all menus */
const JOBS = [
  { brand: 'capiche', pdf: 'deploy/public/capiche/capiche.pdf', page: 0, name: 'CkQR1',
    label: 'Instagram QR', url: 'https://www.instagram.com/pizza.capiche/',
    zone: { x0: 75.77, x1: 150.91, y0: 96.36, y1: 171.5 } },
  { brand: 'capiche', pdf: 'deploy/public/capiche/capiche.pdf', page: 1, name: 'CkQR2',
    label: 'FSSAI licence QR', url: 'https://fassai.bookends.co.in/',
    zone: { x0: 739.8, x1: 797.9, y0: 74.5, y1: 132.7 } },
  { brand: 'aiko', pdf: 'deploy/public/aiko/aiko.pdf', page: 1, name: 'CkQR1',
    label: 'FSSAI licence QR', url: 'https://fassai.bookends.co.in/',
    zone: { x0: 34.4, x1: 92.6, y0: 95.9, y1: 154.1 } },
  { brand: 'aiko', pdf: 'deploy/public/aiko/aiko.pdf', page: 1, name: 'CkQR2',
    label: 'Linktree QR', url: 'https://linktr.ee/qr/5cbcfaf0-12ce-440e-87f4-3da27fedd56f?utm_source=qr_code',
    zone: { x0: 492.3, x1: 567.4, y0: 40.4, y1: 115.5 } },
];

const PAINT = new Set(['f', 'f*', 'F', 'B', 'B*', 'b', 'b*', 'S', 's', 'n']);
const PATH = new Set(['m', 'l', 'c', 'v', 'y', 'h', 're', 'W', 'W*']);
const lastOp = ln => { const t = ln.replace(/%.*$/, '').trim().split(/\s+/); return t[t.length - 1] || ''; };
const qDelta = ln => { const t = ln.replace(/%.*$/, '').trim().split(/\s+/);
  return t.filter(x => x === 'q').length - t.filter(x => x === 'Q').length; };

/* The QR's ops as ONE contiguous, q/Q-balanced, text-free slice [lo,hi) of whole lines. Anchors
   are ops carrying ABSOLUTE page coordinates (re / m / l / absolute c, and translate-only cm group
   origins); relative coordinates inside a cm group are small and skipped, as in extractArt. */
export function qrSpan(s, zone, pad = 0.6) {
  const z = { x0: zone.x0 - pad, x1: zone.x1 + pad, y0: zone.y0 - pad, y1: zone.y1 + pad };
  const inZ = (x, y) => x >= z.x0 && x <= z.x1 && y >= z.y0 && y <= z.y1;
  const lines = []; let o = 0;
  for (const t of s.split('\n')) { lines.push({ o, e: o + t.length, t }); o += t.length + 1; }
  const isAnchor = ({ t }) => {
    let m;
    if ((m = t.match(/^q 1 0 0 1 (-?[\d.]+) (-?[\d.]+) cm$/))) return inZ(+m[1], +m[2]);
    if ((m = t.match(/^(-?[\d.]+) (-?[\d.]+) -?[\d.]+ -?[\d.]+ re$/)) || (m = t.match(/^(-?[\d.]+) (-?[\d.]+) [ml]$/)))
      return Math.abs(+m[1]) >= 20 && inZ(+m[1], +m[2]);
    if ((m = t.match(/^(?:-?[\d.]+ ){4}(-?[\d.]+) (-?[\d.]+) c$/))) return Math.abs(+m[1]) >= 20 && inZ(+m[1], +m[2]);
    return false;
  };
  const idx = lines.map((l, i) => isAnchor(l) ? i : -1).filter(i => i >= 0);
  if (!idx.length) throw new Error('no QR ops in zone');
  const a = idx[0];
  let b = idx[idx.length - 1], depth = 0;
  for (let i = a; i <= b; i++) depth += qDelta(lines[i].t);
  // run on to the end of the last group: close its q..Q and paint its path
  while (b + 1 < lines.length) {
    const op = lastOp(lines[b].t);
    if (depth === 0 && (PAINT.has(op) || op === 'Q')) break;
    b++; depth += qDelta(lines[b].t);
    if (depth < 0) throw new Error('slice closes a q it did not open');
  }
  // an anchor must not sit mid-path: the op before the slice has to have finished a path
  const prev = lastOp(lines[a - 1].t);
  if (PATH.has(prev)) throw new Error(`slice starts inside an open path (prev op "${prev}")`);
  const lo = lines[a].o, hi = lines[b].e, slice = s.slice(lo, hi);
  let d = 0;
  for (const ln of slice.split('\n')) {
    d += qDelta(ln); if (d < 0) throw new Error('slice q/Q unbalanced');
    const op = lastOp(ln);
    if (/\bBT\b|\bTf\b|\bDo\b|[()\/<]/.test(ln.replace(/%.*$/, ''))) throw new Error('slice is not pure vector art: ' + ln);
    // top-level state changes would leak past the slice inline but not out of a Form
    if (d === 0 && /^(k|K|g|G|rg|RG|cs|CS|sc|scn|SC|SCN|gs|w|d|J|j|M|i|ri|cm)$/.test(op))
      throw new Error('slice sets graphics state at top level: ' + ln);
  }
  if (d !== 0) throw new Error('slice q/Q unbalanced at end');
  const ops = slice.split('\n').filter(l => l.trim()).length;
  return { lo, hi, ops };
}

const openMu = bytes => mupdf.Document.openDocument(bytes, 'application/pdf');
function raster(bytes, page, dpi = 144) {
  const pix = openMu(bytes).loadPage(page).toPixmap(mupdf.Matrix.scale(dpi / 72, dpi / 72), mupdf.ColorSpace.DeviceRGB, false, true);
  return { w: pix.getWidth(), h: pix.getHeight(), px: pix.getPixels().slice() };   // copy: getPixels() is a view into WASM memory the next render reuses
}
/* differing pixels, and their box in PDF space */
function diffBox(A, B, H, dpi = 144) {
  let n = 0, x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1;
  for (let y = 0; y < A.h; y++) for (let x = 0; x < A.w; x++) {
    const i = (y * A.w + x) * 3;
    if (Math.abs(A.px[i] - B.px[i]) + Math.abs(A.px[i + 1] - B.px[i + 1]) + Math.abs(A.px[i + 2] - B.px[i + 2]) > 30) {
      n++; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
  }
  const k = 72 / dpi;
  return { n, box: n ? { x0: x0 * k, x1: (x1 + 1) * k, y0: H - (y1 + 1) * k, y1: H - y0 * k } : null };
}

const byPdf = {};
for (const j of JOBS) if (!ONLY || j.brand === ONLY) (byPdf[j.pdf] = byPdf[j.pdf] || []).push(j);

let failed = false;
for (const [pdfPath, jobs] of Object.entries(byPdf)) {
  console.log(`\n== ${pdfPath}`);
  const orig = fs.readFileSync(pdfPath);
  const doc = await PDFDocument.load(orig);
  let did = 0;
  for (const job of jobs) {
    const page = doc.getPages()[job.page];
    const H = page.getHeight();
    const cref = page.node.get(PDFName.of('Contents'));
    const stream = doc.context.lookup(cref);
    if (stream.dict.get(PDFName.of('Filter'))) throw new Error('compressed page stream');
    const s = Buffer.from(stream.contents).toString('latin1');
    if (s.includes(`/${job.name} Do`)) { console.log(`  p${job.page} ${job.label}: already baked — skip`); continue; }
    const { lo, hi, ops } = qrSpan(s, job.zone);
    const call = `/${job.name} Do`;
    const rep = call + ' '.repeat(hi - lo - call.length);
    const next = s.slice(0, lo) + rep + s.slice(hi);
    if (next.length !== s.length) throw new Error('length changed');

    const m = 1;   // BBox margin: the paths' own ink never reaches past the module box
    const z = job.zone;
    const fdict = doc.context.obj({
      Type: 'XObject', Subtype: 'Form', FormType: 1,
      BBox: [z.x0 - m, z.y0 - m, z.x1 + m, z.y1 + m].map(v => +v.toFixed(3)),
      Resources: {},
      ChuckyQR: PDFString.of(`${job.brand}-p${job.page}-${job.name}`),
      ChuckyQRPage: job.page,
      ChuckyQRLabel: PDFString.of(job.label),
      ChuckyQRUrl: PDFString.of(job.url),
    });
    const body = Buffer.from(s.slice(lo, hi), 'latin1');
    fdict.set(PDFName.of('Length'), PDFNumber.of(body.length));
    const fref = doc.context.register(PDFRawStream.of(fdict, new Uint8Array(body)));
    const res = page.node.Resources();
    let xo = res.lookupMaybe(PDFName.of('XObject'), PDFDict);
    if (!xo) { xo = doc.context.obj({}); res.set(PDFName.of('XObject'), xo); }
    if (xo.get(PDFName.of(job.name))) throw new Error(`/${job.name} already in resources`);
    xo.set(PDFName.of(job.name), fref);
    stream.dict.set(PDFName.of('Length'), PDFNumber.of(next.length));
    doc.context.assign(cref, PDFRawStream.of(stream.dict, new Uint8Array(Buffer.from(next, 'latin1'))));
    job._H = H; job._fref = fref; job._ops = ops; job._bytes = hi - lo;
    did++;
    console.log(`  p${job.page} ${job.label}: ${ops} ops, ${hi - lo} bytes [${lo},${hi}) -> ${call}`);
  }
  if (!did) continue;
  const baked = await doc.save({ useObjectStreams: false });

  // ---- render audit ----
  for (const job of jobs.filter(j => j._fref)) {
    const A = raster(orig, job.page), B = raster(baked, job.page);
    const d = diffBox(A, B, job._H);
    const ok1 = d.n === 0;
    console.log(`  audit p${job.page} ${job.label}: baked vs original ${ok1 ? 'pixel-identical' : d.n + ' px differ ' + JSON.stringify(d.box)}`);
    // hide the Form: everything that disappears must lie inside the QR zone, and the zone empties
    const hid = await PDFDocument.load(baked);
    const f = hid.context.lookup(job._fref);
    f.dict.set(PDFName.of('BBox'), hid.context.obj([0, 0, 0, 0]));
    const C = raster(await hid.save({ useObjectStreams: false }), job.page);
    const h = diffBox(A, C, job._H), z = job.zone;
    const inside = h.box && h.box.x0 >= z.x0 - 1.5 && h.box.x1 <= z.x1 + 1.5 && h.box.y0 >= z.y0 - 1.5 && h.box.y1 <= z.y1 + 1.5;
    const cover = h.box && (h.box.x1 - h.box.x0) > (z.x1 - z.x0) * 0.9 && (h.box.y1 - h.box.y0) > (z.y1 - z.y0) * 0.9;
    console.log(`  audit p${job.page} ${job.label}: hiding it removes ${h.n} px in ${JSON.stringify(h.box && Object.fromEntries(Object.entries(h.box).map(([k, v]) => [k, +v.toFixed(1)])))} — ${inside && cover ? 'exactly the QR' : 'WRONG'}`);
    if (!ok1 || !inside || !cover) failed = true;
  }
  const pd = await PDFDocument.load(baked);
  pd.getPages().forEach((p, i) => {
    if (pd.context.lookup(p.node.get(PDFName.of('Contents'))).dict.get(PDFName.of('Filter'))) { console.log(`  page ${i} gained a Filter`); failed = true; }
  });
  if (process.env.QR_DUMP) fs.writeFileSync(path.join("test-output", path.basename(pdfPath, ".pdf") + "_qrbaked.pdf"), baked);
  if (failed) { console.error('  AUDIT FAILED — not written'); process.exitCode = 1; continue; }
  if (process.env.QR_DUMP) fs.writeFileSync(path.join("test-output", path.basename(pdfPath, ".pdf") + "_qrbaked.pdf"), baked);
  if (!WRITE) { console.log('  dry-run only (pass --write)'); continue; }
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  fs.mkdirSync('backups', { recursive: true });
  fs.copyFileSync(pdfPath, path.join('backups', `${path.basename(pdfPath, '.pdf')}_preqrbake_${stamp}.pdf`));
  fs.writeFileSync(pdfPath, baked);
  console.log(`  written ${pdfPath}`);
}
