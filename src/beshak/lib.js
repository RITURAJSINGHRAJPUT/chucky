// Shared helpers for the Beshak build: PDF stream access + Identity-H text parsing.
//
// Beshak's artwork is unlike the other brands': the page content stream is a stub that
// draws ONE top-level Form XObject, and all the editable text lives inside that XObject
// (plus a handful of tiny sibling XObjects that hold the allergen icon glyphs). Fonts are
// subset CIDFontType2 with /Encoding /Identity-H, so every glyph is a 2-byte big-endian
// CID and the ToUnicode CMap is the only way back to readable text.
const fs = require('fs');
const zlib = require('zlib');
const { PDFDocument, PDFName } = require('pdf-lib');

// ---- TrueType table directory ----
function ttTables(b) {
  const num = b.readUInt16BE(4);
  const t = {};
  let off = 12;
  for (let i = 0; i < num; i++) {
    t[b.slice(off, off + 4).toString('latin1')] = { off: b.readUInt32BE(off + 8), len: b.readUInt32BE(off + 12) };
    off += 16;
  }
  return t;
}

function cmapFromToUnicode(buf) {
  const s = buf.toString('latin1');
  const map = {};
  let blk;
  const rr = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((blk = rr.exec(s))) {
    const re = /<([0-9a-fA-F]{4})>\s*<([0-9a-fA-F]{4})>\s*<([0-9a-fA-F]{4,})>/g;
    let m;
    while ((m = re.exec(blk[1]))) {
      const lo = parseInt(m[1], 16), hi = parseInt(m[2], 16), u = parseInt(m[3].slice(0, 4), 16);
      for (let c = lo; c <= hi; c++) map[c] = String.fromCharCode(u + (c - lo));
    }
  }
  const cr = /beginbfchar([\s\S]*?)endbfchar/g;
  while ((blk = cr.exec(s))) {
    const re = /<([0-9a-fA-F]{4})>\s*<([0-9a-fA-F]{4,})>/g;
    let m;
    while ((m = re.exec(blk[1]))) map[parseInt(m[1], 16)] = String.fromCharCode(parseInt(m[2].slice(0, 4), 16));
  }
  return map;
}

// Load the doc plus every font used on each page (cid<->unicode, widths, raw TTF).
async function loadDoc(path) {
  const doc = await PDFDocument.load(fs.readFileSync(path));
  const ctx = doc.context;
  const raw = (r) => {
    const o = ctx.lookup(r);
    const d = o.dict.toString();
    return /FlateDecode/.test(d) ? zlib.inflateSync(Buffer.from(o.contents)) : Buffer.from(o.contents);
  };
  const pages = doc.getPages().map((p, pi) => {
    const res = ctx.lookup(p.node.get(PDFName.of('Resources')));
    const fdict = ctx.lookup(res.get(PDFName.of('Font')));
    const fonts = {};
    for (const k of fdict.keys()) {
      const ref = fdict.get(k);
      const f = ctx.lookup(ref);
      const base = f.get(PDFName.of('BaseFont')).toString().replace(/^\//, '');
      const dfRef = ctx.lookup(f.get(PDFName.of('DescendantFonts'))).get(0);
      const df = ctx.lookup(dfRef);
      const fd = ctx.lookup(df.get(PDFName.of('FontDescriptor')));
      const ffRef = fd.get(PDFName.of('FontFile2'));
      const cid2uni = cmapFromToUnicode(raw(f.get(PDFName.of('ToUnicode'))));
      const uni2cid = {};
      for (const [c, u] of Object.entries(cid2uni)) if (!(u in uni2cid)) uni2cid[u] = +c;
      const dw = df.get(PDFName.of('DW'));
      const W = ctx.lookup(df.get(PDFName.of('W')));
      const widths = {};
      const defW = dw ? dw.asNumber() : 1000;
      if (W && W.asArray) {
        const a = W.asArray();
        let i = 0;
        while (i < a.length) {
          const first = ctx.lookup(a[i]).asNumber();
          const nxt = ctx.lookup(a[i + 1]);
          if (nxt && nxt.asArray) {
            nxt.asArray().forEach((w, j) => { widths[first + j] = ctx.lookup(w).asNumber(); });
            i += 2;
          } else {
            const last = nxt.asNumber();
            const w = ctx.lookup(a[i + 2]).asNumber();
            for (let c = first; c <= last; c++) widths[c] = w;
            i += 3;
          }
        }
      }
      fonts[k.toString()] = {
        res: k.toString(), base, fam: base.split('+')[1] || base, sub: base.split('+')[0],
        cid2uni, uni2cid, widths, defW, ffRef, fontRef: ref, dfRef, fdRef: df.get(PDFName.of('FontDescriptor')),
        ttf: ffRef ? raw(ffRef) : null,
      };
    }
    const xo = ctx.lookup(res.get(PDFName.of('XObject')));
    return { pi, page: p, res, fonts, xobjects: xo };
  });
  return { doc, ctx, raw, pages };
}

// ---- content-stream tokenizer ----
const DELIM = /[\s()<>\[\]{}\/%]/;
function tokenize(s) {
  const toks = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '\f' || c === '\0') { i++; continue; }
    if (c === '(') {
      let j = i + 1, d = 1;
      while (j < n) {
        const ch = s[j];
        if (ch === '\\') { j += 2; continue; }
        if (ch === '(') d++;
        else if (ch === ')') { d--; if (d === 0) { j++; break; } }
        j++;
      }
      toks.push({ t: 'str', raw: s.slice(i + 1, j - 1), span: [i, j] });
      i = j; continue;
    }
    if (c === '<') {
      if (s[i + 1] === '<') { toks.push({ t: 'op', v: '<<', off: i }); i += 2; continue; }
      let j = i + 1;
      while (j < n && s[j] !== '>') j++;
      toks.push({ t: 'hex', off: i, end: j + 1 });
      i = j + 1; continue;
    }
    if (c === '>') { if (s[i + 1] === '>') { toks.push({ t: 'op', v: '>>', off: i }); i += 2; continue; } i++; continue; }
    if (c === '/') {
      let j = i + 1;
      while (j < n && !DELIM.test(s[j])) j++;
      toks.push({ t: 'name', v: s.slice(i, j), off: i, end: j });
      i = j; continue;
    }
    if (c === '[' || c === ']') { toks.push({ t: c, off: i, end: i + 1 }); i++; continue; }
    let j = i;
    while (j < n && !DELIM.test(s[j])) j++;
    const w = s.slice(i, j);
    if (/^[-+]?[\d.]+$/.test(w) && /\d/.test(w)) toks.push({ t: 'num', v: parseFloat(w), off: i, end: j });
    else toks.push({ t: 'op', v: w, off: i, end: j });
    i = j;
  }
  return toks;
}

// Undo PDF string escapes -> real bytes (held as latin1 chars).
function unescapePdf(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c !== '\\') { out += c; continue; }
    const d = raw[++i];
    if (d === 'n') out += '\n';
    else if (d === 'r') out += '\r';
    else if (d === 't') out += '\t';
    else if (d === 'b') out += '\b';
    else if (d === 'f') out += '\f';
    else if (d === '\n') { /* line continuation */ }
    else if (d >= '0' && d <= '7') {
      let o = d;
      while (o.length < 3 && raw[i + 1] >= '0' && raw[i + 1] <= '7') o += raw[++i];
      out += String.fromCharCode(parseInt(o, 8));
    } else out += d;
  }
  return out;
}

// Escape raw bytes back into a PDF literal string body.
function escapePdf(bytes) {
  let out = '';
  for (const ch of bytes) {
    const c = ch.charCodeAt(0);
    if (ch === '(' || ch === ')' || ch === '\\') out += '\\' + ch;
    else if (c === 13) out += '\\r';
    else if (c === 10) out += '\\n';
    else if (c < 32 || c === 127) out += '\\' + c.toString(8).padStart(3, '0');
    else out += ch;
  }
  return out;
}

const cidsOf = (str) => {
  const o = [];
  for (let i = 0; i + 1 < str.length; i += 2) o.push((str.charCodeAt(i) << 8) | str.charCodeAt(i + 1));
  return o;
};
const cidStr = (cids) => cids.map((c) => String.fromCharCode(c >> 8) + String.fromCharCode(c & 255)).join('');

// Walk a content stream -> text blocks. Each block = one BT..ET with its font/size/Tm and
// its show-ops, every one carrying byte spans so the engine can splice replacements in.
function parseText(s, fonts) {
  const toks = tokenize(s);
  const blocks = [];
  let cur = null;
  let font = null, size = 0, nums = [], lastName = null, pend = null;
  let arr = null, arrStart = -1;
  for (let k = 0; k < toks.length; k++) {
    const tk = toks[k];
    if (tk.t === 'num') { nums.push(tk); if (arr) arr.push({ kern: tk.v, off: tk.off, end: tk.end }); continue; }
    if (tk.t === 'name') { lastName = tk; nums = []; continue; }
    if (tk.t === 'str') { if (arr) arr.push({ str: tk }); else pend = tk; continue; }
    if (tk.t === '[') { arr = []; arrStart = tk.off; continue; }
    if (tk.t === ']') continue;
    if (tk.t !== 'op') { nums = []; continue; }
    const op = tk.v;
    if (op === 'BT') { cur = { btOff: tk.off, font: null, size: 0, tm: null, tmSpan: null, ops: [], etEnd: -1 }; blocks.push(cur); nums = []; }
    else if (op === 'ET') { if (cur) cur.etEnd = tk.end; cur = null; nums = []; }
    else if (op === 'Tf') {
      font = lastName ? lastName.v : null;
      if (cur) {
        cur.font = font;
        cur.fontSpan = [lastName.off, lastName.end];
        const sz = nums.length ? nums[nums.length - 1] : null;
        if (sz) { size = sz.v; cur.size = size; cur.sizeSpan = [sz.off, sz.end]; }
      }
      nums = [];
    } else if (op === 'Tm') {
      if (nums.length >= 6) {
        const a = nums.slice(-6);
        if (cur) { cur.tm = a.map((x) => x.v); cur.tmSpan = [a[0].off, a[5].end]; cur.font = cur.font || font; cur.size = cur.size || size; }
      }
      nums = [];
    } else if (op === 'Td' || op === 'TD') {
      if (nums.length >= 2 && cur) { const a = nums.slice(-2); cur.ops.push({ kind: 'td', dx: a[0].v, dy: a[1].v, span: [a[0].off, a[1].end] }); }
      nums = [];
    } else if (op === 'TJ' || op === 'Tj') {
      const F = fonts && cur ? fonts[cur.font] : null;
      const parts = op === 'TJ' && arr ? arr : (pend ? [{ str: pend }] : []);
      const items = parts.filter((p) => p.str).map((p) => ({ span: p.str.span.slice(), bytes: unescapePdf(p.str.raw) }));
      const text = items.map((it) => cidsOf(it.bytes).map((x) => (F && F.cid2uni[x] !== undefined ? F.cid2uni[x] : '�')).join('')).join('');
      if (cur) {
        cur.ops.push({
          kind: op,
          span: op === 'TJ' ? [arrStart, tk.end] : [items[0] ? items[0].span[0] : tk.off, tk.end],
          items, parts, text,
        });
      }
      arr = null; pend = null; nums = [];
    } else {
      if (op !== 'Tc' && op !== 'Tw' && op !== 'Tz' && op !== 'TL' && op !== 'Ts' && op !== 'Tr') arr = null;
      nums = [];
    }
  }
  return blocks.filter((b) => b.ops.some((o) => o.kind === 'TJ' || o.kind === 'Tj'));
}

// Text width in points for a CID run at a given font size (ignores TJ kerns).
function widthOf(F, cids, size) {
  let w = 0;
  for (const c of cids) w += (F.widths[c] !== undefined ? F.widths[c] : F.defW);
  return (w / 1000) * size;
}

module.exports = { loadDoc, parseText, tokenize, unescapePdf, escapePdf, cidsOf, cidStr, ttTables, cmapFromToUnicode, widthOf };
