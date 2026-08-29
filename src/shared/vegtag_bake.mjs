#!/usr/bin/env node
// vegtag_bake.mjs — adds the green "pure veg" mark + "Proudly vegetarian. Entirely delicious."
// tagline to each menu's BACK page. Sibling to crosspromo_bake.mjs (reuses its shiftOps/fitNums/
// fmtN helpers rather than duplicating the coordinate math) with its own idempotence marker, since
// crosspromo_bake.mjs's own marker is already baked into both PDFs and its guard would refuse.
//
//   node src/shared/vegtag_bake.mjs [--write] [--brand=capiche|aiko]
//
// CAPICHE page 1 (bottom-left): the DAIRY/GLUTEN/JAIN POSSIBLE/CHILLI/GHASLET HOT SAUCE marker
//   legend (2 rows) rides UP by ~17.5pt, freeing a 3rd row at the old row-2 height — which already
//   sits almost exactly level with "HOT SAUCE, GARLIC AIOLI & CHILLI CRISP ON THE HOUSE!" in the
//   middle column — for the veg mark + tagline.
// AIKO page 1 (bottom-left): no shift — the veg mark + tagline are appended directly beside
//   "Price is not inclusive of tax.", same baseline, in the clear gap before the right-column
//   @aikomfort QR caption.
//
// All additions are APPENDED (spans never move); the Capiche shift is length-preserving in-place
// (see shiftOps in crosspromo_bake.mjs). Idempotent: refuses a stream that already carries the mark.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const fs = require('fs');
const path = require('path');
const { PDFDocument, PDFName, PDFNumber, PDFRawStream } = require('pdf-lib');
import { fmtN, shiftOps } from './pdf_bake_utils.mjs';

const WRITE = process.argv.includes('--write');
const ONLY = (process.argv.find(a => /^--brand=/.test(a)) || '').replace('--brand=', '');
const MARK = '% vegtag';   // idempotence marker written into the appendix — distinct from crosspromo's

/* A green-outlined square with a green filled circle inside — the standard "pure veg" mark.
   Self-contained (its own clip + colour ops), drawn in absolute page coordinates (no cm wrapper
   needed since this is original art, not extracted/rescaled donor art like the QR). */
function pureVegMarkArt(x0, y0, size, strokeOp, fillOp, lw, pageH, pageW) {
  // circle diameter/square-size ratio measured from the reference mark the user supplied
  // (docs/images.png): 253px circle in a 415px square = 0.61 -> r = size*0.305.
  const cx = x0 + size / 2, cy = y0 + size / 2, r = size * 0.305;
  const k = 0.5523 * r;
  let ops = `\nq ${MARK}\n0 ${fmtN(pageH)} ${fmtN(pageW)} ${fmtN(-pageH)} re\nW n\n`;
  ops += `${fmtN(lw)} w\n${strokeOp}\n${fmtN(x0)} ${fmtN(y0)} ${fmtN(size)} ${fmtN(size)} re\nS\n`;
  ops += `${fillOp}\n`;
  ops += `${fmtN(cx + r)} ${fmtN(cy)} m\n`;
  ops += `${fmtN(cx + r)} ${fmtN(cy + k)} ${fmtN(cx + k)} ${fmtN(cy + r)} ${fmtN(cx)} ${fmtN(cy + r)} c\n`;
  ops += `${fmtN(cx - k)} ${fmtN(cy + r)} ${fmtN(cx - r)} ${fmtN(cy + k)} ${fmtN(cx - r)} ${fmtN(cy)} c\n`;
  ops += `${fmtN(cx - r)} ${fmtN(cy - k)} ${fmtN(cx - k)} ${fmtN(cy - r)} ${fmtN(cx)} ${fmtN(cy - r)} c\n`;
  ops += `${fmtN(cx + k)} ${fmtN(cy - r)} ${fmtN(cx + r)} ${fmtN(cy - k)} ${fmtN(cx + r)} ${fmtN(cy)} c\n`;
  ops += `f\nQ\n`;
  return ops;
}

function taglineArt(text, font, size, x, y, color, tc, pageH, pageW) {
  return `\nq ${MARK}\n0 ${fmtN(pageH)} ${fmtN(pageW)} ${fmtN(-pageH)} re\nW n\n` +
    `BT\n${color}\n${font} 1 Tf\n0 Tr\n${tc} ${fmtN(size)} 0 0 ${fmtN(size)} ${fmtN(x)} ${fmtN(y)} Tm\n(${text})Tj\nET\nQ\n`;
}

const JOBS = [
  {
    brand: 'capiche', dir: 'deploy/public/capiche', pdf: 'capiche.pdf', page: 1,
    // both legend rows (icons' cm origins + labels' Tm) — measured directly from the live PDF:
    // DAIRY/GLUTEN/JAIN POSSIBLE (row 1, y~35-40) and CHILLI/GHASLET HOT SAUCE (row 2, y~18-22).
    // 10 ops total (5 icon cm + 5 label Tm); dy chosen to match the row-to-row gap exactly.
    shifts: [{ dy: 17.51, zone: { x0: 10, x1: 210, y0: 10, y1: 42 }, expect: 10 }],
    // new row lands at the freed old-row-2 height, matching where CHILLI's icon used to be —
    // and level with "HOT SAUCE, GARLIC AIOLI…" (native y ~17.6) in the middle column.
    // colour + border-weight ratio (lw/size = 24/415 = 0.058) both sampled from docs/images.png's
    // muted FSSAI green (RGB 55,140,59 -> CMYK ~0.61/0/0.58/0.45), not the brighter pure-green guess
    // used originally.
    // y0/tagline.y measured exactly against "HOT SAUCE, GARLIC AIOLI…"'s baseline (top-down
    // y=577.654) via PyMuPDF span origins — the earlier 17.3/18.18 guess sat 0.558pt too high.
    // x0 matches the CHILLI icon's own left edge (x0=26.623, measured from its drawn path) directly
    // above it, so the new row's icon sits in the same column as the row above — was 34, off by 7.377.
    mark: { x0: 26.623, y0: 16.742, size: 8, strokeOp: '0.61 0 0.58 0.45 K', fillOp: '0.61 0 0.58 0.45 k', lw: 0.46 },
    // /T1_0 here is AOMonoBlack, the same uppercase-only face the DAIRY/GLUTEN/etc labels use
    // (confirmed by render: the mixed-case tagline came out as "P . E ." — every lowercase letter
    // is missing from this font's embedded subset, matching the Q/Z gap found earlier this
    // session). Matches the legend's own all-caps style anyway, so uppercase is the right fix,
    // not just a workaround.
    // x shifted by the same -7.377 as mark.x0, keeping the same icon-to-text gap as before.
    tagline: { text: 'PROUDLY VEGETARIAN. ENTIRELY DELICIOUS.', font: '/T1_0', size: 7, x: 39.623, y: 17.622,
               color: '0.727 0.668 0.652 0.813 k', tc: '0.05 Tc -0.05 Tw' },
  },
  {
    brand: 'aiko', dir: 'deploy/public/aiko', pdf: 'aiko.pdf', page: 1,
    shifts: [],
    // beside "Price is not inclusive of tax." (native y~25.3-34.4, ends x~151) — clear of the
    // right-column @aikomfort QR caption (x~510) — same baseline the tax line sits on.
    // same muted FSSAI green + border-weight ratio as Capiche's job, in RGB (0.216,0.549,0.231).
    // y0/tagline.y measured exactly against "Price is not inclusive of tax."'s baseline (top-down
    // y=814.839) via PyMuPDF span origins — the earlier 24/25.3 guess sat 1.751pt too low.
    mark: { x0: 165, y0: 25.751, size: 8, strokeOp: '0.216 0.549 0.231 RG', fillOp: '0.216 0.549 0.231 rg', lw: 0.46 },
    // /TT0 here is a mixed-case face (used for the "Sister Restaurant…" block) — renders fine as-is.
    tagline: { text: 'Proudly vegetarian. Entirely delicious.', font: '/TT0', size: 7.0033, x: 178, y: 27.051,
               color: '0 g', tc: '0 Tc 0 Tw' },
  },
];

for (const job of JOBS) {
  if (ONLY && job.brand !== ONLY) continue;
  console.log(`\n== ${job.brand}`);
  const pdfPath = path.join(job.dir, job.pdf);
  const doc = await PDFDocument.load(fs.readFileSync(pdfPath));
  const page = doc.getPages()[job.page];
  const ref = page.node.get(PDFName.of('Contents'));
  const stream = doc.context.lookup(ref);
  let base = Buffer.from(stream.contents);
  if (base.toString('latin1').includes(MARK)) { console.error(`${job.brand}: already baked — refusing`); process.exit(1); }

  for (const sh of job.shifts) base = shiftOps(base, sh);

  const [W, H] = [page.getWidth(), page.getHeight()];
  const M = job.mark;
  let appendix = pureVegMarkArt(M.x0, M.y0, M.size, M.strokeOp, M.fillOp, M.lw, H, W);
  console.log(`  veg mark at (${M.x0},${M.y0}) size ${M.size}`);
  const T = job.tagline;
  appendix += taglineArt(T.text, T.font, T.size, T.x, T.y, T.color, T.tc, H, W);
  console.log(`  tagline "${T.text}" ${T.font}@${T.x},${T.y}`);

  if (!WRITE) { console.log('  dry-run only'); continue; }

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  fs.mkdirSync('backups', { recursive: true });
  fs.copyFileSync(pdfPath, path.join('backups', `${job.brand}_${job.pdf}_prevegtag_${stamp}`));

  const merged = Buffer.concat([base, Buffer.from(appendix, 'latin1')]);
  stream.dict.set(PDFName.of('Length'), PDFNumber.of(merged.length));
  doc.context.assign(ref, PDFRawStream.of(stream.dict, new Uint8Array(merged)));
  fs.writeFileSync(pdfPath, await doc.save({ useObjectStreams: false }));

  const re = await PDFDocument.load(fs.readFileSync(pdfPath));
  re.getPages().forEach((p, i) => {
    if (re.context.lookup(p.node.get(PDFName.of('Contents'))).dict.get(PDFName.of('Filter'))) throw new Error(`page ${i} gained a Filter`);
  });
  console.log(`  ${job.brand}: baked`);
}
if (!WRITE) console.log('\npass --write to bake');
