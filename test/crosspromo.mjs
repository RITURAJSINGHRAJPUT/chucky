#!/usr/bin/env node
// Cross-promo + FSSAI licence verification (baked by src/shared/crosspromo_bake.mjs).
//
//   node test/crosspromo.mjs
//
// CAPICHE page 1: the कपीश block rides +74pt, AIKO's QR sits below it, and a RIGHT-anchored
// (rx=810) "FSSAI LIC. NO." line with an editable number sits under the QR — the line grows
// LEFTWARD as the number is typed. AIKO page 1: the allergen legend rides +52pt and CAPICHE's
// QR sits between it and the Sister Restaurant block. All render-verified.
import { createRequire } from 'module';
import { bootEditor, exportBytes } from './lib/engine.mjs';
import { inkRuns, textLines } from './lib/markers.mjs';
import { sampleQR, sampleQRFromImage } from '../src/shared/qr/sample.mjs';
import { qrDecodeMatrix } from '../src/shared/qr/decode.mjs';

const require = createRequire(import.meta.url);
const path = require('path');
const { ROOT } = require('./lib/out.js');
const { operatorBalance, pageStreams, byteIdentical, checkUncompressed } = require('./lib/pdf.js');

const results = [];
const rec = (name, ok, detail) => {
  results.push({ name, ok, detail });
  if (!ok) console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
};
const section = (t) => console.log(`\n${t}\n${'-'.repeat(t.length)}`);
const CAP = path.join(ROOT, 'deploy', 'public', 'capiche');
const AIK = path.join(ROOT, 'deploy', 'public', 'aiko');

// ---------------------------------------------------------------------------------------------
section('baked artwork — both brands');
// ---------------------------------------------------------------------------------------------
{
  for (const [brand, src, checks] of [
    ['capiche', path.join(CAP, 'capiche.pdf'), {
      page: 1,
      qr: { x0: 742, x1: 796, yTop: 131, yBot: 76 },                 // FSSAI QR centred on the caption axis
      qrSample: { x0: 736, x1: 802, yTop: 134, yBot: 72 },
      moved: [['sister text at its original position', { textAt: { needle: 'Sister Restaurant AIKO', yBot: 16, yTop: 34 } }],
              ['caption printed under the QR', { textAt: { needle: 'SCAN FOR FSSAI', yBot: 63, yTop: 74 } }]],
    }],
    ['aiko', path.join(AIK, 'aiko.pdf'), {
      page: 1,
      qr: { x0: 37, x1: 90, yTop: 153, yBot: 97 },                   // FSSAI QR centred on the caption axis
      qrSample: { x0: 31, x1: 96, yTop: 156, yBot: 94 },
      moved: [['legend at its raised position', { textAt: { needle: 'JAIN POSSIBLE', yBot: 160, yTop: 174 } }],
              ['caption printed under the QR', { textAt: { needle: 'Scan for FSSAI', yBot: 84, yTop: 95 } }],
              ['old legend position empty', { empty: { x0: 110, x1: 235, yTop: 114, yBot: 104 } }]],
    }],
  ]) {
    const un = await checkUncompressed(src);
    rec(`${brand}: content streams uncompressed`, un.ok, JSON.stringify(un.filteredPages));
    const ink = inkRuns(src, checks.page, { ...checks.qr, dpi: 200 });
    rec(`${brand}: FSSAI QR renders in its zone`, ink.length >= 1 && ink.reduce((a, r) => a + r.w, 0) > 30, `${ink.length} runs, w=${ink.reduce((a, r) => a + r.w, 0).toFixed(1)}`);
    // the definitive gate: the module matrix sampled back OUT of the baked page must equal the
    // owner's source image module-for-module (backups/qr/FSSAI QR.jpeg, v4 33x33)
    {
      const want = sampleQRFromImage(path.join(ROOT, 'backups', 'qr', 'FSSAI QR.jpeg'));
      const got = sampleQR(src, checks.page, checks.qrSample, { dpi: 900 });
      let diff = got.size !== want.size ? -1 : 0;
      if (diff === 0) for (let i = 0; i < want.size * want.size; i++) if (got.matrix[i] !== want.matrix[i]) diff++;
      rec(`${brand}: baked QR is module-exact vs the source image`, diff === 0 && got.score > 0.98,
          `size ${got.size} vs ${want.size}, diffs ${diff}, score ${got.score.toFixed(3)}`);
      // and it must DECODE, with zero corrections, to the owner's URL
      try {
        const d = qrDecodeMatrix(got.matrix, got.size);
        rec(`${brand}: baked QR decodes to the FSSAI URL`, d.text === 'https://fassai.bookends.co.in/' && d.corrected === 0,
            `${JSON.stringify(d.text)}, corrected ${d.corrected}`);
      } catch (e) { rec(`${brand}: baked QR decodes to the FSSAI URL`, false, e.message); }
    }
    for (const [name, c] of checks.moved) {
      if (c.textAt) {
        const hit = textLines(src, checks.page).some(l => l.text.includes(c.textAt.needle) && l.bot >= c.textAt.yBot && l.top <= c.textAt.yTop + 6);
        rec(`${brand}: ${name}`, hit);
      } else {
        rec(`${brand}: ${name}`, inkRuns(src, checks.page, { ...c.empty, dpi: 200 }).length === 0);
      }
    }
    for (const [i, s] of (await pageStreams(src)).entries()) {
      const b = operatorBalance(s);
      rec(`${brand}: page ${i} operators balanced`, b.ok, `q=${b.q} bt=${b.bt} welds=${b.welds}`);
    }
  }
}

// ---------------------------------------------------------------------------------------------
section('capiche — no licence line, spans intact');
// ---------------------------------------------------------------------------------------------
{
  const SRC = path.join(CAP, 'capiche.pdf');
  const E = await bootEditor(CAP, { expose: ['memSnapshot'] });
  rec('capiche: no FM.license (line removed on owner request)', !E.FM.license);
  // the caption "SCAN FOR FSSAI LICENCE" stays; only the "FSSAI LIC. NO." label is gone
  rec('capiche: no "FSSAI LIC. NO." label printed', !textLines(SRC, 1).some(l => l.text.includes('LIC. NO.')));

  E.reset(); E.takeWarnings();
  rec('capiche: byte-identical with no edits', (await byteIdentical(SRC, await exportBytes(E))).ok);

  // the baked file must not have broken span-based editing (shift was length-preserving)
  const nm = E.FM.fields.find(f => f.role === 'name' && f.page === 1);
  E.setEdit(nm.id, 'SPANCHECK');
  rec('capiche: p1 dish spans still valid', textLines(await exportBytes(E), 1).some(l => l.text.includes('SPANCHECK')));
  rec('capiche: no warnings from the span check', E.takeWarnings().length === 0);
  E.reset();
}

// ---------------------------------------------------------------------------------------------
section('aiko — spans still valid after legend shift');
// ---------------------------------------------------------------------------------------------
{
  const E = await bootEditor(AIK);
  E.reset(); E.takeWarnings();
  const nm = E.FM.fields.find(f => f.role === 'name' && f.page === 1);
  E.setEdit(nm.id, 'SPANCHECK');
  rec('aiko: p1 dish spans still valid', textLines(await exportBytes(E), 1).some(l => l.text.includes('SPANCHECK')));
  rec('aiko: no warnings from the span check', E.takeWarnings().filter(w => /spliceBytes/.test(w)).length === 0);
  E.reset();
}

const passed = results.filter(r => r.ok).length, failed = results.length - passed;
console.log('\n' + '-'.repeat(64));
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
