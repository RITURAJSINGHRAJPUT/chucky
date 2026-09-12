// Rasterise / measure a PDF so exports can be audited AS A VIEWER (CLAUDE.md HARD RULE 4).
//
// Uses MuPDF's WASM build (`mupdf` devDependency): no native toolchain, works on Windows/macOS/Linux,
// so every maintainer can run a render audit with just `npm install`. CLAUDE.md's PyMuPDF route still
// works if you have Python — this exists because the rule has to be runnable to be followed, and the
// ADD-font corruption survived precisely because nothing in the suite ever rasterised anything.
import * as fs from 'fs';

const mupdf = await import('mupdf');   // ESM-only package; top-level await is required

const open = (src) => mupdf.Document.openDocument(
  src instanceof Uint8Array ? src : fs.readFileSync(src), 'application/pdf');

/** Render whole pages to PNG. pages omitted = all. Returns [{page, file, w, h}] */
export function renderPages(src, outPrefix, { dpi = 150, pages = null } = {}) {
  const doc = open(src), n = doc.countPages(), s = dpi / 72;
  const want = pages || Array.from({ length: n }, (_, i) => i);
  const out = [];
  for (const p of want) {
    if (p < 0 || p >= n) continue;
    const pix = doc.loadPage(p).toPixmap(mupdf.Matrix.scale(s, s), mupdf.ColorSpace.DeviceRGB, false, true);
    const file = `${outPrefix}_p${p}.png`;
    fs.writeFileSync(file, pix.asPNG());
    out.push({ page: p, file, w: pix.getWidth(), h: pix.getHeight() });
  }
  return out;
}

/** Render one region (PDF user space, y-up) at high DPI — for close visual inspection. */
export function renderRegion(src, outFile, { page = 0, x0, yTop, x1, yBot, dpi = 400 }) {
  const doc = open(src), pg = doc.loadPage(page);
  const H = pg.getBounds()[3], s = dpi / 72;
  const rect = [x0 * s, (H - yTop) * s, x1 * s, (H - yBot) * s].map(Math.round);
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, rect, false);
  pix.clear(255);
  const dev = new mupdf.DrawDevice(mupdf.Matrix.scale(s, s), pix);
  pg.run(dev, mupdf.Matrix.identity);
  dev.close();
  fs.writeFileSync(outFile, pix.asPNG());
  return { file: outFile, w: pix.getWidth(), h: pix.getHeight() };
}

/**
 * Exact ink box per rendered text line, in PDF user space (y UP).
 * This is the measurement the byte-level harnesses cannot give you: it is what a customer sees.
 * Returns [{text, x0, x1, top, bot, h}] sorted top-to-bottom.
 */
export function textLines(src, page = 0) {
  const doc = open(src), pg = doc.loadPage(page), H = pg.getBounds()[3];
  const st = JSON.parse(pg.toStructuredText('preserve-whitespace').asJSON());
  const rows = [];
  for (const blk of st.blocks || []) for (const ln of blk.lines || []) {
    const t = (ln.text || '').trim(); if (!t) continue;
    const b = ln.bbox;
    rows.push({ text: t, x0: b.x, x1: b.x + b.w, top: H - b.y, bot: H - (b.y + b.h), h: b.h });
  }
  return rows.sort((a, b) => b.top - a.top);
}

/**
 * Every glyph on a page, with its own quad — finer than textLines(), which merges a line into one
 * font-metric box. That merge hides two things a click-target audit needs: where a glyph actually
 * sits, and which FONT drew it. A fallback font (Beshak's "/" comes from NotoSans, not the menu
 * face) carries a taller em box than the text around it, so a line box can claim ink that is not
 * there. Returns [{c, font, size, x, baseline, top, bot, x0, x1}] in PDF user space (y UP).
 */
export function textChars(src, page = 0) {
  const doc = open(src), pg = doc.loadPage(page), H = pg.getBounds()[3];
  const out = [];
  pg.toStructuredText('preserve-whitespace').walk({
    onChar(c, origin, font, size, quad) {
      out.push({
        c,
        font: (font && font.getName && font.getName()) || '',
        size,
        x: origin[0],
        baseline: H - origin[1],
        top: H - Math.min(quad[1], quad[5]),
        bot: H - Math.max(quad[3], quad[7]),
        x0: Math.min(quad[0], quad[4]),
        x1: Math.max(quad[2], quad[6]),
      });
    },
  });
  return out;
}

export const pageCount = (src) => open(src).countPages();
