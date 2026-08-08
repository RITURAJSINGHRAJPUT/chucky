// Byte-level PDF inspection shared by the regression suite. Complements render.mjs: this checks the
// invariants (uncompressed streams, byte identity, balanced operators); render.mjs checks what a
// customer sees. Both matter — the ADD-font bug is invisible here and obvious there.
const fs = require('fs');
const { PDFDocument, PDFName } = require('pdf-lib');

/** Raw content-stream bytes for every page. */
async function pageStreams(src) {
  const doc = await PDFDocument.load(src instanceof Uint8Array ? src : fs.readFileSync(src));
  return doc.getPages().map(p => {
    const s = doc.context.lookup(p.node.Contents());
    return Buffer.from(s.getContents ? s.getContents() : s.contents);
  });
}

/** HARD RULE 3: content streams uncompressed, no object streams. */
async function checkUncompressed(src) {
  const buf = src instanceof Uint8Array ? Buffer.from(src) : fs.readFileSync(src);
  const doc = await PDFDocument.load(buf);
  const filtered = [];
  doc.getPages().forEach((p, i) => {
    const c = doc.context.lookup(p.node.Contents());
    if (c && c.dict && c.dict.get(PDFName.of('Filter'))) filtered.push(i);
  });
  const objStm = (buf.toString('latin1').match(/\/Type\s*\/ObjStm/g) || []).length;
  return { ok: !filtered.length && !objStm, filteredPages: filtered, objStm, pages: doc.getPageCount() };
}

/** Empty-edit exports must reproduce the source byte-for-byte. */
async function byteIdentical(srcPath, outBytes) {
  const A = await pageStreams(srcPath), B = await pageStreams(outBytes);
  if (A.length !== B.length) return { ok: false, detail: `page count ${A.length} -> ${B.length}` };
  const diff = A.map((a, i) => a.equals(B[i]) ? null : `p${i} (${a.length}->${B[i].length}B)`).filter(Boolean);
  return { ok: !diff.length, detail: diff.join(', ') };
}

/**
 * Operator sanity. A deletion that welds the byte before to the byte after turns `Q`+`q` into the
 * bogus operator `Qq`, after which parsers abandon the rest of the stream and every dish below
 * vanishes — so unbalanced q/Q or BT/ET is a corruption signal, not a style nit.
 */
function operatorBalance(streamBuf) {
  const s = streamBuf.toString('latin1');
  let q = 0, minq = 0, bt = 0, minbt = 0;
  const re = /(^|[\s)\]>])(q|Q|BT|ET)(?=[\s/[(<]|$)/g;
  let m;
  while ((m = re.exec(s))) {
    const op = m[2];
    if (op === 'q') q++; else if (op === 'Q') { q--; if (q < minq) minq = q; }
    else if (op === 'BT') bt++; else if (op === 'ET') { bt--; if (bt < minbt) minbt = bt; }
  }
  const welds = s.match(/Qq|qQ|ETBT|TjTj/g) || [];
  return { ok: q === 0 && bt === 0 && minq >= 0 && minbt >= 0 && !welds.length, q, bt, welds: welds.length };
}

/** Every string the editor writes must be representable by the subset font (FM.allowed[role]). */
function charsetViolations(text, allowed) {
  if (allowed == null) return [];
  return [...new Set(String(text ?? '').split(''))].filter(c => allowed.indexOf(c) < 0 && c !== '\n');
}

module.exports = { pageStreams, checkUncompressed, byteIdentical, operatorBalance, charsetViolations };
