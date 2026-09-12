// Inventory the marker icons. Each icon is drawn in the main XObject as a self-contained
//   q  <clip rect> re W n  <glyph outline path> W n  /RNNN Do  Q
// block, where /RNNN is a tiny Form XObject whose /BBox gives the icon's exact position and
// size (in the artwork's 0.1pt units). So: find every `/RNNN Do` inside the main stream,
// pair it with its q..Q byte span, and classify by BBox size.
const { loadDoc } = require('./lib');
const { PDFName } = require('pdf-lib');

const SRC = process.env.BESHAK_SRC || 'incoming/Beshak_DineIn_Menu.pdf';

function mainXObjectName(stub) {
  const m = [...stub.matchAll(/\/(R\d+)\s+Do/g)];
  return m.length ? m[m.length - 1][1] : null;
}

// Walk back/forward from a `/RNNN Do` at `doOff` to the enclosing balanced q..Q.
function qBlockAround(s, doOff) {
  const isTok = (i, ch) => s[i] === ch && (i === 0 || /[\s\]>)]/.test(s[i - 1])) && (i + 1 >= s.length || /[\s\n\r]/.test(s[i + 1]));
  let depth = 0, start = -1;
  for (let i = doOff; i >= 0; i--) {
    if (isTok(i, 'Q')) depth++;
    else if (isTok(i, 'q')) { if (depth === 0) { start = i; break; } depth--; }
  }
  if (start < 0) return null;
  depth = 0;
  for (let i = start; i < s.length; i++) {
    if (isTok(i, 'q')) depth++;
    else if (isTok(i, 'Q')) { depth--; if (depth === 0) return [start, i + 1]; }
  }
  return null;
}

async function inventory(src = SRC) {
  const { ctx, raw, pages } = await loadDoc(src);
  const out = [];
  for (const P of pages) {
    const stub = raw(P.page.node.get(PDFName.of('Contents'))).toString('latin1');
    const mainName = mainXObjectName(stub);
    const mainRef = P.xobjects.get(PDFName.of(mainName));
    const s = raw(mainRef).toString('latin1');
    const items = [];
    const re = /\/(R\d+)\s+Do/g;
    let m;
    while ((m = re.exec(s))) {
      const name = m[1];
      if (name === mainName) continue;
      const ref = P.xobjects.get(PDFName.of(name));
      if (!ref) continue;
      const o = ctx.lookup(ref);
      const d = o.dict.toString().replace(/\s+/g, ' ');
      if (/\/Subtype\s*\/Image/.test(d)) continue;
      const bb = (d.match(/\/BBox \[([^\]]*)\]/) || [, ''])[1].trim().split(/\s+/).map(Number);
      if (bb.length !== 4) continue;
      const span = qBlockAround(s, m.index);
      items.push({
        name, ref: ref.toString(), page: P.pi,
        // artwork units are 0.1pt; the page draws the main XObject under `0.1 0 0 0.1` .
        x: bb[0] / 10, y: bb[1] / 10, w: (bb[2] - bb[0]) / 10, h: (bb[3] - bb[1]) / 10,
        doOff: m.index, span,
        hasText: /\/Font/.test(d),
      });
    }
    out.push({ page: P.pi, mainName, mainRef, stream: s, items });
  }
  return out;
}

if (require.main === module) {
  inventory().then((pp) => {
    for (const P of pp) {
      console.log(`##### page ${P.page} main=/${P.mainName} (${P.stream.length}b) — ${P.items.length} XObject draws`);
      const byClass = {};
      for (const it of P.items) {
        const cls = `${it.w.toFixed(2)}x${it.h.toFixed(2)}`;
        (byClass[cls] = byClass[cls] || []).push(it);
      }
      for (const [cls, arr] of Object.entries(byClass).sort((a, b) => b[1].length - a[1].length)) {
        console.log(`  size ${cls.padEnd(14)} n=${String(arr.length).padStart(2)}  text=${arr[0].hasText}`);
        for (const it of arr) console.log(`      ${it.name.padEnd(6)} x=${it.x.toFixed(2).padStart(7)} y=${it.y.toFixed(2).padStart(7)} span=${it.span ? it.span.join('-') : 'NONE'}`);
      }
    }
  }).catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { inventory, qBlockAround, mainXObjectName };
