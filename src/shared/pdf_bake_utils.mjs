// pdf_bake_utils.mjs — pure helpers for length-preserving, byte-level PDF content-stream edits.
// Extracted out of crosspromo_bake.mjs so a sibling "bake" script (e.g. vegtag_bake.mjs) can
// import just the math without pulling in crosspromo_bake.mjs's own top-level script body (it
// runs its JOBS loop — including a process.exit(1) on its idempotence guard — as an import side
// effect, since it's written to also run standalone via `node crosspromo_bake.mjs`). This file
// has NO top-level side effects — safe to import from anywhere.
export const fmtN = v => { let s = (+v).toFixed(4).replace(/0+$/, '').replace(/\.$/, ''); return s || '0'; };

export function fitNums(vals, scaffoldLen, targetLen) {
  for (let dec = 4; dec >= 0; dec--) {
    let strs = vals.map(v => { let s = v.toFixed(dec); if (dec) s = s.replace(/0+$/, '').replace(/\.$/, ''); return s; });
    let len = scaffoldLen + strs.reduce((a, s) => a + s.length, 0);
    if (len === targetLen) return strs;
    if (len < targetLen) {
      for (let i = 0; i < strs.length && len < targetLen; i++) {
        if (!strs[i].includes('.')) { if (len + 2 > targetLen) continue; strs[i] += '.0'; len += 2; }
        while (len < targetLen && strs[i].length < 12) { strs[i] += '0'; len++; }
      }
      if (len === targetLen) return strs;
    }
  }
  return null;
}

/* Length-preserving vertical shift of every absolute op in a zone: translate-only cm origins,
   signed re rects, absolute m/l/c path segments, and 6-operand Tm text matrices. Zone membership
   is judged on the PRISTINE (pre-shift) coordinates. */
export function shiftOps(base, { dy, zone: z, expect, types = null }) {
  const s = base.toString('latin1');
  const inZ = (x, y) => x >= z.x0 && x <= z.x1 && y >= z.y0 && y <= z.y1;
  const edits = [];
  let m;
  const push = (t, o, len, pre, nums, suf) => {
    if (types && !types.includes(t === 'm' || t === 'l' ? 'ml' : t)) return;
    const strs = fitNums(nums, pre.length + suf.length + (nums.length - 1), len);
    if (!strs) throw new Error(`cannot length-fit ${t} at ${o}: ${JSON.stringify(s.slice(o, o + len))}`);
    edits.push({ o, len, rep: pre + strs.join(' ') + suf, t });
  };
  const cmre = /q 1 0 0 1 (-?[\d.]+) (-?[\d.]+) cm/g;
  while ((m = cmre.exec(s))) if (inZ(+m[1], +m[2]))
    push('cm', m.index, m[0].length, 'q 1 0 0 1 ', [+m[1], +m[2] + dy], ' cm');
  const rre = /(?<=\n)(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) re(?=\n)/g;
  while ((m = rre.exec(s))) if (inZ(+m[1], +m[2]))
    push('re', m.index, m[0].length, '', [+m[1], +m[2] + dy, +m[3], +m[4]], ' re');
  const mlre = /(?<=\n)(-?[\d.]+) (-?[\d.]+) (m|l)(?=\n)/g;
  while ((m = mlre.exec(s))) if (inZ(+m[1], +m[2]) && Math.abs(+m[1]) >= 20)
    push(m[3], m.index, m[0].length, '', [+m[1], +m[2] + dy], ' ' + m[3]);
  const cre = /(?<=\n)(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) c(?=\n)/g;
  while ((m = cre.exec(s))) { const n = m.slice(1, 7).map(Number);
    if (Math.abs(n[0]) < 20) continue;
    if (inZ(n[4], n[5])) push('c', m.index, m[0].length, '', [n[0], n[1] + dy, n[2], n[3] + dy, n[4], n[5] + dy], ' c'); }
  const tmre = /(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) Tm/g;
  while ((m = tmre.exec(s))) { const n = m.slice(1, 7).map(Number);
    if (inZ(n[4], n[5])) push('tm', m.index, m[0].length, '', [n[0], n[1], n[2], n[3], n[4], n[5] + dy], ' Tm'); }

  const byT = edits.reduce((a, e) => (a[e.t] = (a[e.t] || 0) + 1, a), {});
  console.log(`  shift: ${edits.length} ops ${JSON.stringify(byT)} up ${dy}pt`);
  if (expect != null && edits.length !== expect)
    throw new Error(`shift op count ${edits.length} != expected ${expect} — re-inventory before writing`);
  const out = Buffer.from(base);
  for (const e of edits) {
    if (e.rep.length !== e.len) throw new Error(`length drift at ${e.o}`);
    out.write(e.rep, e.o, 'latin1');
  }
  if (out.length !== base.length) throw new Error('shift changed the stream length');
  return out;
}
