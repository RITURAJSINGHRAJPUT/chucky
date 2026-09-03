// Stage 1 of the Beshak build: turn the designer PDF into an EDITABLE one.
//
//  * every stream the editor has to splice into is stored UNCOMPRESSED (CLAUDE.md hard rule 3) —
//    the two page stubs, the two main artwork XObjects, and the little XObjects holding the
//    "250 gm" / "300 ml" labels. Images stay Flate/DCT so the file does not balloon.
//  * each font family's two per-page subsets are replaced by their merged union, written into
//    BOTH font objects, so page 0 and page 1 can type the same characters. Nothing in the
//    content streams changes: CIDs keep their meaning, so the artwork renders identically.
//
// Usage: node src/beshak/normalize.js [out.pdf]
const fs = require('fs');
const zlib = require('zlib');
const { PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFArray, PDFRef } = require('pdf-lib');
const { loadDoc } = require('./lib');
const { mergeSubsets } = require('./fontmerge');
const { setRawStream } = require('./rewrite');
const { mainXObjectName } = require('./icons');

const SRC = process.env.BESHAK_SRC || 'incoming/Beshak_DineIn_Menu.pdf';

function toUnicodeCMap(map) {
  const entries = Object.entries(map).map(([c, u]) => [+c, u]).sort((a, b) => a[0] - b[0]);
  const hex = (n, w = 4) => n.toString(16).toUpperCase().padStart(w, '0');
  const lines = [];
  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100);
    lines.push(`${chunk.length} beginbfchar`);
    for (const [c, u] of chunk) lines.push(`<${hex(c)}><${hex(u.charCodeAt(0))}>`);
    lines.push('endbfchar');
  }
  return `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CMapType 2 def
/CMapName/Beshak-Merged def
1 begincodespacerange
<0000><ffff>
endcodespacerange
${lines.join('\n')}
endcmap
CMapName currentdict /CMap defineresource pop
end end`;
}

// /W array: [cid [w] cid [w] ...] collapsed into runs of consecutive CIDs.
function widthArray(ctx, widths) {
  const cids = Object.keys(widths).map(Number).sort((a, b) => a - b);
  const out = [];
  let i = 0;
  while (i < cids.length) {
    let j = i;
    while (j + 1 < cids.length && cids[j + 1] === cids[j] + 1) j++;
    out.push(PDFNumber.of(cids[i]));
    out.push(ctx.obj(cids.slice(i, j + 1).map((c) => PDFNumber.of(widths[c]))));
    i = j + 1;
  }
  return ctx.obj(out);
}

async function normalize(src = SRC) {
  const L = await loadDoc(src);
  const { doc, ctx, raw, pages } = L;

  // ---- 1. merge each family's subsets and write the union into every copy ----
  const byFam = {};
  for (const P of pages) for (const F of Object.values(P.fonts)) (byFam[F.fam] = byFam[F.fam] || []).push(F);
  const famInfo = {};
  for (const [fam, arr] of Object.entries(byFam)) {
    const uniqueCids = {};
    for (const F of arr) Object.assign(uniqueCids, F.cid2uni);
    const widths = {};
    for (const F of arr) for (const [c, w] of Object.entries(F.widths)) widths[c] = w;
    let ttf = arr[0].ttf;
    if (arr.length > 1) ttf = mergeSubsets(arr[0].ttf, arr[1].ttf).ttf;
    const cmap = Buffer.from(toUnicodeCMap(uniqueCids), 'latin1');
    for (const F of arr) {
      const fdRef = F.fdRef;
      const fd = ctx.lookup(fdRef);
      setRawStream(ctx, fd.get(PDFName.of('FontFile2')), ttf);
      const fdict = ctx.lookup(F.fontRef);
      setRawStream(ctx, fdict.get(PDFName.of('ToUnicode')), cmap);
      const df = ctx.lookup(F.dfRef);
      df.set(PDFName.of('W'), widthArray(ctx, widths));
      // The subset tag no longer describes what is embedded; drop it so nothing claims a
      // subset that is really the union of two.
      const base = fdict.get(PDFName.of('BaseFont')).toString().replace(/^\/[A-Z]{6}\+/, '/BESHAK+');
      fdict.set(PDFName.of('BaseFont'), PDFName.of(base.slice(1)));
      df.set(PDFName.of('BaseFont'), PDFName.of(base.slice(1)));
      fd.set(PDFName.of('FontName'), PDFName.of(base.slice(1)));
    }
    famInfo[fam] = { cid2uni: uniqueCids, widths, chars: Object.values(uniqueCids).sort().join('') };
  }

  // ---- 2. uncompress every stream the editor splices into ----
  const editable = [];
  for (const P of pages) {
    const contentsRef = P.page.node.get(PDFName.of('Contents'));
    const stub = raw(contentsRef).toString('latin1');
    setRawStream(ctx, contentsRef, Buffer.from(stub, 'latin1'));

    const mainName = mainXObjectName(stub);
    const mainRef = P.xobjects.get(PDFName.of(mainName));
    setRawStream(ctx, mainRef, raw(mainRef));
    editable.push({ page: P.pi, kind: 'main', name: mainName, ref: mainRef.toString() });

    // sibling XObjects that carry text (the gm / ml labels and the legend words)
    for (const k of P.xobjects.keys()) {
      const ref = P.xobjects.get(k);
      const o = ctx.lookup(ref);
      const d = o.dict.toString().replace(/\s+/g, ' ');
      if (/\/Subtype\s*\/Image/.test(d) || k.toString() === '/' + mainName) continue;
      if (!/\/Font/.test(d)) continue;
      setRawStream(ctx, ref, raw(ref));
      editable.push({ page: P.pi, kind: 'label', name: k.toString().slice(1), ref: ref.toString() });
    }
  }

  const bytes = await doc.save({ useObjectStreams: false });
  return { bytes, famInfo, editable };
}

if (require.main === module) {
  const out = process.argv[2] || 'deploy/public/beshak/beshak.pdf';
  normalize().then(({ bytes, famInfo, editable }) => {
    fs.mkdirSync(require('path').dirname(out), { recursive: true });
    fs.writeFileSync(out, bytes);
    console.log('wrote', out, bytes.length, 'bytes');
    for (const [fam, i] of Object.entries(famInfo)) console.log('  font', fam.padEnd(24), Object.keys(i.cid2uni).length, 'chars', JSON.stringify(i.chars));
    console.log('  editable streams:', editable.length);
  }).catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { normalize };
