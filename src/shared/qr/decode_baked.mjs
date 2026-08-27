// decode_baked.mjs — decode the two menus' baked QR codes (carved logo centres marked as
// erasures) and print their payloads.
//   node src/shared/qr/decode_baked.mjs
import { sampleQR, matrixToAscii } from './sample.mjs';
import { qrDecodeMatrix } from './decode.mjs';

const TARGETS = [
  { name: 'capiche (@PIZZA.CAPICHE, p0)', src: 'deploy/public/capiche/capiche.pdf', page: 0,
    region: { x0: 72, x1: 155, yTop: 176, yBot: 92 },
    erase: { x0: 11, y0: 11, x1: 21, y1: 17 } },          // the "Capiche" script box, v3 grid
  { name: 'aiko (@aikomfort, p1)', src: 'deploy/public/aiko/aiko.pdf', page: 1,
    region: { x0: 486, x1: 572, yTop: 120, yBot: 36 },
    erase: { x0: 17, y0: 19, x1: 32, y1: 30 } },          // the "AIko" box, v8 grid
];

for (const t of TARGETS) {
  const s = sampleQR(t.src, t.page, t.region, { dpi: 900, erase: t.erase });
  console.log(`\n== ${t.name}: size ${s.size} (v${(s.size - 17) / 4}), sample score ${s.score.toFixed(3)}, ` +
              `${[...s.matrix].filter(v => v === -1).length} erased modules`);
  try {
    const d = qrDecodeMatrix(s.matrix, s.size);
    console.log(`   ecLevel ${d.ecLevel} mask ${d.mask} corrected ${d.corrected}`);
    console.log(`   PAYLOAD: ${JSON.stringify(d.text)}`);
  } catch (e) {
    console.log(`   DECODE FAILED: ${e.message}`);
    console.log(matrixToAscii(s.matrix, s.size).split('\n').slice(0, 10).join('\n'));
  }
}
