#!/usr/bin/env node
// crosspromo_bake.mjs — the FSSAI QR + caption on each menu's BACK page.
//
//   node src/shared/crosspromo_bake.mjs [--write] [--brand=capiche|aiko]
//
// CAPICHE page 1 (bottom-right, right edge x=810):
//   - the कपीश logo + "Prices are not inclusive… / Serving… / at our Sister Restaurant AIKO"
//     block rides UP by 74pt (in-place, length-preserving — no span moves),
//   - the owner's FSSAI QR (vector rects from backups/qr/FSSAI QR.jpeg) below it + caption,
// AIKO page 1 (bottom-left):
//   - the DAIRY/GLUTEN/SESAME/JAIN legend rides UP by 52pt,
//   - the same FSSAI QR + caption between the legend and the 'Sister Restaurant' block.
//
// All additions are APPENDED (spans never move); all moves are length-preserving in-place
// rewrites (see shiftOps). Idempotent: refuses a stream that already carries the transplant.
// Re-run after any base-PDF rebuild.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const fs = require('fs');
const path = require('path');
const { PDFDocument, PDFName, PDFNumber, PDFRawStream } = require('pdf-lib');
import { fmtN, fitNums, shiftOps } from './pdf_bake_utils.mjs';
export { fmtN, fitNums, shiftOps };   // re-exported for anything still importing them from here

const WRITE = process.argv.includes('--write');
const ONLY = (process.argv.find(a => /^--brand=/.test(a)) || '').replace('--brand=', '');
const MARK = '% crosspromo';   // idempotence marker written into the appendix

export async function pageStreamOf(pdfPath, pageIdx) {
  const doc = await PDFDocument.load(fs.readFileSync(pdfPath));
  const page = doc.getPages()[pageIdx];
  return Buffer.from(doc.context.lookup(page.node.get(PDFName.of('Contents'))).contents).toString('latin1');
}

/* Extract a self-contained vector-art slice (a QR) from a donor stream: every op whose anchor
   falls in `zone`, as ONE contiguous byte slice (gated), preceded by the fill op in effect.
   The slice must be q/Q balanced and font-free (no Tf/BT), which both menu QRs are. */
export function extractArt(s, zone) {
  const z = zone, items = [];
  let m;
  const pats = [
    [/q 1 0 0 1 (-?[\d.]+) (-?[\d.]+) cm/g, 1, 2],
    [/(?<=\n)(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) re(?=\n)/g, 1, 2],
    [/(?<=\n)(-?[\d.]+) (-?[\d.]+) (m|l)(?=\n)/g, 1, 2],
  ];
  for (const [re, xi, yi] of pats) {
    while ((m = re.exec(s))) {
      const x = +m[xi], y = +m[yi];
      if (Math.abs(x) < 20) continue;                    // group-relative coords are tiny
      if (x >= z.x0 && x <= z.x1 && y >= z.y0 && y <= z.y1) items.push({ o: m.index, e: m.index + m[0].length, x, y });
    }
  }
  const cre = /(?<=\n)(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) c(?=\n)/g;
  while ((m = cre.exec(s))) { const n = m.slice(1, 7).map(Number);
    if (Math.abs(n[0]) >= 20 && n[4] >= z.x0 && n[4] <= z.x1 && n[5] >= z.y0 && n[5] <= z.y1) items.push({ o: m.index, e: m.index + m[0].length, x: n[4], y: n[5] }); }
  if (!items.length) throw new Error('no art found in the donor zone');
  items.sort((a, b) => a.o - b.o);
  let lo = items[0].o, hi = items[items.length - 1].e;
  // extend hi to the balanced end of the last group (it may open a q..Q)
  let depth = 0;
  for (let k = lo; k < s.length; k++) {
    const isOp = (s[k - 1] === '\n' || s[k - 1] === ' ') && (s[k + 1] === '\n' || s[k + 1] === ' ');
    if (isOp && s[k] === 'q') depth++;
    else if (isOp && s[k] === 'Q') { depth--; if (depth < 0) throw new Error('unbalanced donor slice'); }
    if (k >= hi && depth === 0) { hi = k + 1; break; }
  }
  // include the fill op in effect at the start
  const pre = s.slice(Math.max(0, lo - 400), lo);
  const fill = (pre.match(/(?:^|\n)((?:[\d.]+ ){0,3}[\d.]+ (?:k|g|rg))(?=\n)/g) || []).pop();
  const slice = s.slice(lo, hi);
  if (/\bTf\b|\bBT\b/.test(slice)) throw new Error('donor slice contains text ops — not self-contained');
  // pad with newlines: a q/Q at the very edge of the slice has no neighbour for the lookarounds
  const padded = '\n' + slice + '\n';
  const q = (padded.match(/(?<=[\s])q(?=[\s])/g) || []).length, Q = (padded.match(/(?<=[\s])Q(?=[\s])/g) || []).length;
  if (q !== Q) throw new Error(`donor slice q/Q unbalanced: ${q}/${Q}`);
  // the tightest coordinate box (anchors only; module paths extend ~2pt beyond)
  const bx0 = Math.min(...items.map(i => i.x)), bx1 = Math.max(...items.map(i => i.x));
  const by0 = Math.min(...items.map(i => i.y)), by1 = Math.max(...items.map(i => i.y));
  return { art: (fill ? fill.trim() + '\n' : '') + slice, box: { x0: bx0, x1: bx1, y0: by0, y1: by1 }, bytes: hi - lo };
}

/* wrap donor art so its ink box [box] lands at [tx0, ty0, w] (uniform scale) */
export function placeArt(art, box, tx0, ty0, w, pageH, pageW) {
  const s = w / (box.x1 - box.x0);
  const tx = tx0 - s * box.x0, ty = ty0 - s * box.y0;
  return `\nq ${MARK}\n0 ${fmtN(pageH)} ${fmtN(pageW)} ${fmtN(-pageH)} re\nW n\n${fmtN(s)} 0 0 ${fmtN(s)} ${fmtN(tx)} ${fmtN(ty)} cm\n` + art + `\nQ\n`;
}

/* draw a sampled QR matrix as crisp vector rects (horizontal runs merged), true-black CMYK */
export function matrixQRArt(matrix, size, x0, y0, w, pageH, pageW) {
  const m = w / size;
  let ops = `\nq ${MARK}\n0 ${fmtN(pageH)} ${fmtN(pageW)} ${fmtN(-pageH)} re\nW n\n0 0 0 1 k\n`;
  let rects = 0;
  for (let row = 0; row < size; row++) {
    const y = y0 + (size - 1 - row) * m;   // matrix row 0 is the TOP of the code
    let col = 0;
    while (col < size) {
      if (matrix[row * size + col] === 1) {
        let run = 1; while (col + run < size && matrix[row * size + col + run] === 1) run++;
        ops += `${fmtN(x0 + col * m)} ${fmtN(y)} ${fmtN(run * m)} ${fmtN(m)} re\n`;
        rects++; col += run;
      } else col++;
    }
  }
  ops += 'f\nQ\n';
  return { ops, rects };
}

// The owner's FSSAI QR (backups/qr/FSSAI QR.jpeg, sampled to a v4 module matrix at score 1.0)
// goes in BOTH designated spots, drawn as vector rects — identical pattern, print-crisp.
const QR_IMAGE = 'backups/qr/FSSAI QR.jpeg';

const JOBS = [
  {
    brand: 'capiche', dir: 'deploy/public/capiche', pdf: 'capiche.pdf', page: 1,
    /* stack, top to bottom: कपीश logo (pristine ink 59-105.5, +83.3 -> 142.3-188.8), 10pt gap,
       the QR (74.3-132.3), 10pt gap, the three text lines (pristine 17.3-58.3, +6 -> 23.3-64.3),
       licence line at the bottom (y 12.5). The text is DRAWN TWICE (live Tm text + ~94 outlined
       glyph groups, same duality as the red banners); the कपीश itself is just 5 fat glyph groups
       whose origins sit in the upper band. Split: upper-band cm groups = logo; everything else
       in the zone (glyph-outline cm groups + the 3 Tm) = text. */
    /* With no licence line, the three text lines stay at their ORIGINAL artwork position
       (17.3-58.3, no shift). Stack: कपीश (+82.1 -> 141.1-187.6), 8.5pt gap, QR (74.6-132.6),
       "SCAN FOR FSSAI LICENSE" caption right under it (baseline 66.8), 8.5pt gap, text. */
    shifts: [
      { dy: 82.1, zone: { x0: 595, x1: 830, y0: 58.5, y1: 112 }, types: ['cm'], expect: 5 },  // कपीश glyphs
    ],
    qrAt: { x0: 739.86, y0: 74.6, w: 58 },   // centred on the caption axis (caption 727.72-810, centre 768.86)
    caption: { text: 'SCAN FOR FSSAI LICENSE', fontRole: 'desc', size: 5.5, y: 66.8, rx: 810,
               color: '0.727 0.668 0.652 0.813 k', tc: '0.05 Tc 0 Tw', adv_em: 0.68 },
  },
  {
    brand: 'aiko', dir: 'deploy/public/aiko', pdf: 'aiko.pdf', page: 1,
    shifts: [{ dy: 58, zone: { x0: 20, x1: 240, y0: 95, y1: 125 }, expect: 17 }],  // DAIRY/GLUTEN/SESAME/JAIN legend
    qrAt: { x0: 34.5, y0: 96, w: 58 },   // centred on the caption axis (caption 28-99.03, centre 63.5)
    caption: { text: 'Scan for FSSAI license', fontRole: 'desc', size: 5.5, y: 88.2, x: 28,
               color: '0 g', tc: '0 Tc 0 Tw', adv_em: 0.587 },
  },
];

const { sampleQRFromImage } = await import('./qr/sample.mjs');
const QR = sampleQRFromImage(QR_IMAGE);
if (QR.score < 0.98) throw new Error(`QR image sampled poorly (score ${QR.score.toFixed(3)}) — check ${QR_IMAGE}`);
console.log(`FSSAI QR: v${(QR.size - 17) / 4} (${QR.size}x${QR.size}), sample score ${QR.score.toFixed(4)}`);

for (const job of JOBS) {
  if (ONLY && job.brand !== ONLY) continue;
  console.log(`\n== ${job.brand}`);
  const pdfPath = path.join(job.dir, job.pdf), fmPath = path.join(job.dir, 'fieldmap.json');
  const fm = JSON.parse(fs.readFileSync(fmPath, 'utf8'));
  const doc = await PDFDocument.load(fs.readFileSync(pdfPath));
  const page = doc.getPages()[job.page];
  const ref = page.node.get(PDFName.of('Contents'));
  const stream = doc.context.lookup(ref);
  let base = Buffer.from(stream.contents);
  if (base.toString('latin1').includes(MARK)) { console.error(`${job.brand}: already baked — refusing`); process.exit(1); }

  // sequential per-element shifts: each pass classifies against the buffer as it stands, so the
  // zones are chosen to be disjoint in PRISTINE y and to not receive ops another pass moved
  for (const sh of job.shifts) base = shiftOps(base, sh);

  const [W, H] = [page.getWidth(), page.getHeight()];
  const qrArt = matrixQRArt(QR.matrix, QR.size, job.qrAt.x0, job.qrAt.y0, job.qrAt.w, H, W);
  console.log(`  FSSAI QR: ${qrArt.rects} rects at (${job.qrAt.x0},${job.qrAt.y0}) w ${job.qrAt.w}`);
  let appendix = qrArt.ops;

  const resolveFont = role => {
    const f = fm.fields.find(q => q.page === job.page && q.role === role) || fm.fields.find(q => q.role === role);
    const off = f.lines ? f.lines[0][0][0] : f.line_spans ? f.line_spans[0][0] : f.tj_span[0];
    const m = (base.toString('latin1').slice(0, off).match(/\/[A-Za-z0-9_]+ 1 Tf/g) || []).pop();
    if (!m) throw new Error(`no ${role} Tf found`);
    return m.replace(/ 1 Tf$/, '');
  };

  // "Scan for FSSAI license" caption under the QR, in the menu's own small-text face
  if (job.caption) {
    const C = job.caption;
    const font = resolveFont(C.fontRole);
    const w = C.text.length * C.adv_em * C.size;
    const cx0 = C.rx != null ? C.rx - w : C.x;          // right-anchored (capiche) or left (aiko)
    appendix += `BT\n${C.color}\n${font} 1 Tf\n0 Tr\n${C.tc} ${fmtN(C.size)} 0 0 ${fmtN(C.size)} ${fmtN(cx0)} ${fmtN(C.y)} Tm\n(${C.text})Tj\nET\n`;
    console.log(`  caption "${C.text}" ${font}@${fmtN(cx0)},${C.y}`);
  }

  if (!WRITE) { console.log('  dry-run only'); continue; }

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  fs.mkdirSync('backups', { recursive: true });
  fs.copyFileSync(pdfPath, path.join('backups', `${job.brand}_${job.pdf}_precrosspromo_${stamp}`));
  fs.copyFileSync(fmPath, path.join('backups', `${job.brand}_fieldmap_precrosspromo_${stamp}.json`));

  const merged = Buffer.concat([base, Buffer.from(appendix, 'latin1')]);
  stream.dict.set(PDFName.of('Length'), PDFNumber.of(merged.length));
  doc.context.assign(ref, PDFRawStream.of(stream.dict, new Uint8Array(merged)));
  fs.writeFileSync(pdfPath, await doc.save({ useObjectStreams: false }));

  const re = await PDFDocument.load(fs.readFileSync(pdfPath));
  re.getPages().forEach((p, i) => {
    if (re.context.lookup(p.node.get(PDFName.of('Contents'))).dict.get(PDFName.of('Filter'))) throw new Error(`page ${i} gained a Filter`);
  });
  fs.writeFileSync(fmPath, JSON.stringify(fm));
  console.log(`  ${job.brand}: baked`);
}
if (!WRITE) console.log('\npass --write to bake');
