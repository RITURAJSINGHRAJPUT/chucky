// Walk every Form XObject reachable from a page and decode its text with that
// XObject's OWN font resources (the small ones carry their own /Font dict).
// Usage: node src/beshak/dumpx.js [page]
const { loadDoc, parseText, cmapFromToUnicode } = require('./lib');
const { PDFName } = require('pdf-lib');

const SRC = process.env.BESHAK_SRC || 'incoming/Beshak_DineIn_Menu.pdf';
const ONLY = process.argv[2] !== undefined ? +process.argv[2] : null;

(async () => {
  const { ctx, raw, pages } = await loadDoc(SRC);

  const fontCache = new Map();
  function fontsOf(resDict) {
    const out = {};
    if (!resDict) return out;
    const fdict = ctx.lookup(resDict.get(PDFName.of('Font')));
    if (!fdict) return out;
    for (const k of fdict.keys()) {
      const ref = fdict.get(k);
      const key = k.toString() + '@' + ref.toString();
      if (!fontCache.has(key)) {
        const f = ctx.lookup(ref);
        const base = f.get(PDFName.of('BaseFont')).toString().replace(/^\//, '');
        const cid2uni = cmapFromToUnicode(raw(f.get(PDFName.of('ToUnicode'))));
        fontCache.set(key, { res: k.toString(), base, fam: base.split('+')[1] || base, cid2uni, ref: ref.toString() });
      }
      out[k.toString()] = fontCache.get(key);
    }
    return out;
  }

  for (const P of pages) {
    if (ONLY !== null && P.pi !== ONLY) continue;
    console.log(`########## PAGE ${P.pi}`);
    const seen = new Set();
    const walk = (xoDict, depth, label) => {
      if (!xoDict) return;
      for (const k of xoDict.keys()) {
        const ref = xoDict.get(k);
        const tag = k.toString() + '@' + ref.toString();
        if (seen.has(tag)) continue;
        seen.add(tag);
        const o = ctx.lookup(ref);
        const d = o.dict.toString().replace(/\s+/g, ' ');
        if (/\/Subtype\s*\/Image/.test(d)) continue;
        const s = raw(ref).toString('latin1');
        const res = ctx.lookup(o.dict.get(PDFName.of('Resources')));
        const fonts = fontsOf(res);
        const blocks = parseText(s, fonts);
        const bbox = (d.match(/\/BBox \[([^\]]*)\]/) || [, '?'])[1].trim();
        if (blocks.length) {
          console.log(`${'  '.repeat(depth)}${k.toString()} ${ref.toString()} len=${s.length} bbox=[${bbox}]`);
          for (const b of blocks) {
            const F = fonts[b.font];
            const txt = b.ops.filter((o2) => o2.kind !== 'td').map((o2) => o2.text).join(' | ');
            const cids = b.ops.filter((o2) => o2.kind !== 'td').flatMap((o2) => o2.items.flatMap((it) => {
              const a = []; for (let i = 0; i + 1 < it.bytes.length; i += 2) a.push(((it.bytes.charCodeAt(i) << 8) | it.bytes.charCodeAt(i + 1)));
              return a;
            }));
            console.log(`${'  '.repeat(depth)}   ${(F ? F.fam : b.font)} sz=${b.size} tm=${b.tm ? b.tm.slice(4).map((v) => v.toFixed(2)).join(',') : '?'} ` +
              `text=${JSON.stringify(txt)} cids=[${cids.join(',')}] font=${F ? F.ref : '?'}`);
          }
        }
        if (res) walk(ctx.lookup(res.get(PDFName.of('XObject'))), depth + 1, k.toString());
      }
    };
    walk(P.xobjects, 0, 'page');
  }
})().catch((e) => { console.error(e); process.exit(1); });
