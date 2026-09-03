// Rebuild a Beshak PDF with chosen Form-XObject streams replaced by plain (uncompressed) bytes.
// Used by the normaliser and by throwaway experiments that need to see what a block draws.
const fs = require('fs');
const zlib = require('zlib');
const { PDFDocument, PDFName, PDFRawStream, PDFDict, PDFNumber } = require('pdf-lib');

// Replace the stream payload of an indirect object, dropping its /Filter so the bytes stay readable.
function setRawStream(ctx, ref, bytes) {
  const old = ctx.lookup(ref);
  const dict = old.dict;
  dict.delete(PDFName.of('Filter'));
  dict.delete(PDFName.of('DecodeParms'));
  dict.set(PDFName.of('Length'), PDFNumber.of(bytes.length));
  const next = PDFRawStream.of(dict, new Uint8Array(bytes));
  ctx.assign(ref, next);
  return next;
}

module.exports = { setRawStream };
