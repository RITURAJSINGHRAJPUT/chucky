// Dump every decoded text block on both Beshak pages (font, size, position, spans).
// Usage: node src/beshak/dump.js [page]
const { loadDoc, parseText } = require('./lib');
const { PDFName } = require('pdf-lib');

const SRC = process.env.BESHAK_SRC || 'incoming/Beshak_DineIn_Menu.pdf';
const ONLY = process.argv[2] !== undefined ? +process.argv[2] : null;

// The page content stream is a stub: `q 0.1 0 0 0.1 0 0 cm ... /RNNN Do Q`.
// Find the XObject it draws -- that is where the artwork (and all text) lives.
function mainXObjectName(streamText) {
  const m = [...streamText.matchAll(/\/(R\d+)\s+Do/g)];
  return m.length ? m[m.length - 1][1] : null;
}

(async () => {
  const { ctx, raw, pages } = await loadDoc(SRC);
  for (const P of pages) {
    if (ONLY !== null && P.pi !== ONLY) continue;
    const stub = raw(P.page.node.get(PDFName.of('Contents'))).toString('latin1');
    const mainName = mainXObjectName(stub);
    const mainRef = P.xobjects.get(PDFName.of(mainName));
    const s = raw(mainRef).toString('latin1');
    const blocks = parseText(s, P.fonts);
    console.log(`########## PAGE ${P.pi} — main XObject /${mainName} (${s.length} bytes), ${blocks.length} text blocks`);
    for (const F of Object.values(P.fonts)) console.log(`   font ${F.res} = ${F.fam}`);
    blocks.forEach((b, i) => {
      const F = P.fonts[b.font];
      const [x, y] = b.tm ? [b.tm[4], b.tm[5]] : [NaN, NaN];
      const txt = b.ops.filter((o) => o.kind !== 'td').map((o) => o.text).join(' | ');
      console.log(
        `[${String(i).padStart(3)}] ${(F ? F.fam : b.font).padEnd(22)} sz=${String(b.size).padEnd(8)}` +
        ` x=${x.toFixed(2).padStart(8)} y=${y.toFixed(2).padStart(8)} span=${b.btOff}-${b.etEnd}  ${JSON.stringify(txt)}`
      );
    });
  }
})().catch((e) => { console.error(e); process.exit(1); });
