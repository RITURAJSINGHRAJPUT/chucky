#!/usr/bin/env node
// Chucky regression suite.
//
//   npm test              fast pass (~2-4 min)
//   FULL=1 npm test       adds the exhaustive per-dish removal sweeps (~10-15 min)
//
// Two things make this different from the harnesses it drives:
//
//  1. It RENDERS. Every harness before this stopped at bytes, which is exactly why the ADD-font
//     corruption shipped: the bytes are perfectly valid, the glyphs are wrong. Layout checks here
//     read the PDF the way a customer does.
//  2. Known bugs are pinned as declared KNOWN-FAIL cases rather than described in prose. The suite
//     is green-except-known; when a fix lands, its case flips to PASS and the declaration is removed.
//     An unexpected pass is reported too — a KNOWN-FAIL that starts passing means someone fixed it
//     and the declaration is now lying.

const { execFileSync } = require('child_process');
const fs = require('fs'), path = require('path');
const { ROOT, outDir, outFile } = require('./lib/out');
const { checkUncompressed, byteIdentical, operatorBalance, pageStreams, charsetViolations } = require('./lib/pdf');

const FULL = !!process.env.FULL;
const ED = d => path.join(ROOT, 'deploy', 'public', d);
const OUT = outDir('regress');
const results = [];
let R = null;   // render helpers, loaded async

const KNOWN = {
  'aiko: empty-edit byte identity':
    'page 0 gains ~10.6KB of re-emitted /GS0 gs /TT0 Tf state blocks. Present at HEAD, pre-dates this suite.',
};

function record(name, ok, detail) {
  const known = KNOWN[name];
  const status = ok ? (known ? 'UNEXPECTED-PASS' : 'PASS') : (known ? 'KNOWN-FAIL' : 'FAIL');
  results.push({ name, status, detail: detail || '' });
  const mark = { PASS: '  ok  ', FAIL: ' FAIL ', 'KNOWN-FAIL': ' known', 'UNEXPECTED-PASS': ' !pass' }[status];
  console.log(`${mark} ${name}${detail ? '  — ' + detail : ''}`);
}
const guard = async (name, fn) => { try { const [ok, d] = await fn(); record(name, ok, d); }
                                    catch (e) { record(name, false, 'threw: ' + String(e.message || e).slice(0, 120)); } };

function run(script, args, env) {
  return execFileSync(process.execPath, [path.join(ROOT, script), ...args],
    { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000 }).toString();
}
// `markers` is foodh.js's optional 4th argv (dish id -> desired marker set), not an env var
const food   = (d, out, edits, env, markers) => { run('foodh.js', [ED(d), out, JSON.stringify(edits || {}), ...(markers ? [JSON.stringify(markers)] : [])], env); return out; };
const foodAR = (d, out, edits, env) => { run('foodh_ar.js', [ED(d), out, JSON.stringify(edits || {})], env); return out; };
const drinks = (d, prefix, scen)    => { run('markerh.js', [ED(d), prefix, JSON.stringify(scen)]); return `${prefix}_${scen[0].name}.pdf`; };

const EDITORS = [
  ['capiche', 'capiche.pdf'], ['aiko', 'aiko.pdf'], ['churnd', 'churnd.pdf'],
  ['drinks', 'drinks.pdf'], ['capiche-surat', 'menu.pdf'], ['capiche-ahm', 'menu.pdf'],
];

(async () => {
  R = await import('./lib/render.mjs');
  const A = await import('./lib/audit.mjs');
  console.log(`\nChucky regression suite  (${FULL ? 'FULL' : 'fast'} mode)\n${'-'.repeat(64)}`);

  // ---- 1. HARD RULE 3 -------------------------------------------------------------------------
  for (const [d, pdf] of EDITORS)
    await guard(`${d}: base PDF uncompressed, no object streams`, async () => {
      const r = await checkUncompressed(path.join(ED(d), pdf));
      return [r.ok, `${r.pages}pp, filtered=${r.filteredPages.length}, objStm=${r.objStm}`];
    });

  // ---- 2. empty edit must be byte-identical ---------------------------------------------------
  // Except /drinks/: that editor is a band-model REBUILD, not a byte-splicer — regenerate()
  // reconstructs the drinks list from BANDS every time, so identical output is not achievable by
  // design. It is covered instead by src/drinks/harness_bands.js (14 assertions).
  for (const [d, pdf] of EDITORS) {
    if (d === 'drinks') { record(`${d}: empty-edit byte identity`, true, 'n/a — band-model rebuild, covered by harness_bands.js'); continue; }
    await guard(`${d}: empty-edit byte identity`, async () => {
      const out = outFile(`${d}_empty.pdf`, 'regress');
      if (d === 'churnd') run('churndh.js', [out, '{}']);
      else if (d === 'drinks' || d.startsWith('capiche-')) drinks(d, path.join(OUT, `${d}_noop`), [{ name: 'noop', page: null, removed: [], markers: {} }]);
      else food(d, out, {});
      const real = (d === 'drinks' || d.startsWith('capiche-')) ? path.join(OUT, `${d}_noop_noop.pdf`) : out;
      const r = await byteIdentical(path.join(ED(d), pdf), fs.readFileSync(real));
      return [r.ok, r.detail];
    });
  }

  // ---- 3. removal: text gone, operators balanced ----------------------------------------------
  const removalCases = FULL
    ? { capiche: null, aiko: null }                       // null = every dish
    : { capiche: ['0:4', '0:26', '1:3', '1:57'], aiko: ['0:0', '0:75', '1:12'] };
  for (const [d, ids] of Object.entries(removalCases)) {
    const fm = JSON.parse(fs.readFileSync(path.join(ED(d), 'fieldmap.json'), 'utf8'));
    const names = fm.fields.filter(f => f.role === 'name');
    const list = ids ? names.filter(n => ids.includes(n.id)) : names;
    await guard(`${d}: removal (${list.length} dish${list.length > 1 ? 'es' : ''}) — text gone, operators balanced`, async () => {
      const bad = [];
      for (const n of list) {
        const out = outFile(`${d}_rm_${n.id.replace(':', '_')}.pdf`, 'regress');
        foodAR(d, out, {}, { REMOVED: JSON.stringify([n.id]) });
        const st = await pageStreams(out);
        const bal = operatorBalance(st[n.page]);
        if (!bal.ok) bad.push(`${n.id} operators q=${bal.q} bt=${bal.bt} welds=${bal.welds}`);
        const probe = (n.display || '').replace(/\\\d{3}/g, '').trim().split(/\s+/).find(w => w.length >= 4);
        if (probe) {
          const before = R.textLines(path.join(ED(d), fm.pdf || (d + '.pdf')), n.page).filter(l => l.text.includes(probe)).length;
          const after = R.textLines(out, n.page).filter(l => l.text.includes(probe)).length;
          if (before > 0 && after >= before) bad.push(`${n.id} "${probe}" still rendered (${before}->${after})`);
        }
        fs.unlinkSync(out);
      }
      return [!bad.length, bad.slice(0, 3).join('; ')];
    });
  }

  // ---- 4. multi-removal weld scan --------------------------------------------------------------
  await guard('capiche: multi-removal produces no welded operators', async () => {
    const sets = [['0:4', '0:8', '0:12'], ['0:0', '0:2', '0:4', '0:6', '0:8', '0:10'], ['1:3', '1:12', '1:45', '1:57']];
    const bad = [];
    for (const s of sets) {
      const out = outFile('cap_multi.pdf', 'regress');
      foodAR('capiche', out, {}, { REMOVED: JSON.stringify(s) });
      for (const st of await pageStreams(out)) { const b = operatorBalance(st); if (!b.ok) bad.push(`${s.length}-removal welds=${b.welds} q=${b.q}`); }
    }
    return [!bad.length, bad.join('; ')];
  });

  // ---- 5. MANGO PICANTE: multi-line name beside a grown description ---------------------------
  await guard('capiche-ahm: 2-line name + 3-line description stays inside its row', async () => {
    const f = drinks('capiche-ahm', path.join(OUT, 'ahm_mango'),
      [{ name: 'mango', page: 1, edits: { '4:name': 'MANGO\nPICANTE', '4:desc': 'Mango,\njalapenos,\npickle juice, lime' } }]);
    const fm = JSON.parse(fs.readFileSync(path.join(ED('capiche-ahm'), 'fieldmap.json'), 'utf8'));
    const ov = A.overlaps(f, 1, { menuMaxX: 175 });
    const cx = A.rowBoxCrossings(f, fm.pages[0], 1, { menuMaxX: 175 });
    const both = A.hasText(f, 1, 'MANGO') && A.hasText(f, 1, 'PICANTE');
    return [!ov.length && !cx.length && both, `overlaps=${ov.length} crossings=${cx.length} bothLines=${both}`];
  });

  // ---- 6. Aiko grams tag rides the last description line ---------------------------------------
  await guard('aiko: grams tag follows a re-flowed description', async () => {
    const out = food('aiko', outFile('aiko_grams.pdf', 'regress'),
      { '0:76': 'Cheese, tofu, green sauce, fried onion, red chillies, Water Chestnut' });
    const L = R.textLines(out, 0);
    const desc = L.find(l => l.text.startsWith('chillies, Water Chestnut'));
    const tag = L.find(l => l.text.includes('250gms'));
    if (!desc || !tag) return [false, 'desc or grams tag not found'];
    const gap = tag.x0 - desc.x1;
    return [gap > 0 && gap < 12, `gap=${gap.toFixed(2)}pt (must be >0 and snug)`];
  });

  // ---- 7. Aiko section reorder -----------------------------------------------------------------
  await guard('aiko: section reorder moves dishes on the page', async () => {
    const fm = JSON.parse(fs.readFileSync(path.join(ED('aiko'), 'fieldmap.json'), 'utf8'));
    const secs = fm.sections.filter(s => s.page === 0);
    const names = fm.fields.filter(f => f.role === 'name' && f.page === 0);
    const secOf = f => { let best = '', bs = Infinity;
      for (const s of secs) { const dx = Math.abs(s.col_x - f.x); if (dx > 140 || f.y < s.last_y - 2) continue;
        const sc = (f.y - s.last_y) + dx * 0.01; if (sc < bs) { bs = sc; best = s.label; } } return best; };
    const g = {}; for (const f of names) { const L = secOf(f); if (L) (g[L] = g[L] || []).push(f); }
    const label = Object.keys(g).find(k => g[k].length >= 4);
    const grp = g[label].sort((a, b) => b.y - a.y), rev = grp.slice().reverse();
    // foodh_ar.js, not foodh.js — only the add/remove harness wires the ORDER env var through
    const out = foodAR('aiko', outFile('aiko_reorder.pdf', 'regress'), {}, { ORDER: JSON.stringify({ ['0|' + label]: rev.map(f => f.id) }) });
    // last baked dish must now render ABOVE the first baked dish
    const uniq = s => { const c = {}; names.forEach(n => (n.display || '').split(/\s+/).forEach(w => { if (w.length >= 4) c[w] = (c[w] || 0) + 1; }));
      return (s.display || '').split(/\s+/).find(w => w.length >= 4 && c[w] === 1); };
    const a = uniq(grp[0]), b = uniq(grp[grp.length - 1]);
    if (!a || !b) return [false, 'no unique probes'];
    const L = R.textLines(out, 0), ya = L.find(l => l.text.includes(a)), yb = L.find(l => l.text.includes(b));
    return [!!(ya && yb) && yb.top > ya.top, `${label}: "${b}" now above "${a}"`];
  });

  // ---- 8. Churn'd 2-up sheet: an edit must land in BOTH copies ---------------------------------
  await guard("churnd: an edit lands in both copies of the 2-up sheet", async () => {
    const out = outFile('churnd_2up.pdf', 'regress');
    run('churndh.js', [out, JSON.stringify({ n0: 'BANOFFEE CAKE', p0_0: '199' })]);
    const L = R.textLines(out, 1);
    const names = L.filter(l => l.text.includes('BANOFFEE')), prices = L.filter(l => l.text.trim() === '199');
    return [names.length === 2 && prices.length === 2, `name copies=${names.length} price copies=${prices.length} (both must be 2)`];
  });

  // ---- 9. markers ------------------------------------------------------------------------------
  await guard('capiche-ahm: marker toggle keeps the row clean', async () => {
    const f = drinks('capiche-ahm', path.join(OUT, 'ahm_mk'),
      [{ name: 'mk', page: 1, markers: { 4: ['dairy', 'gluten', 'jain'] } }]);
    const fm = JSON.parse(fs.readFileSync(path.join(ED('capiche-ahm'), 'fieldmap.json'), 'utf8'));
    const cx = A.rowBoxCrossings(f, fm.pages[0], 1, { menuMaxX: 175 });
    return [!cx.length, `crossings=${cx.length}`];
  });

  // ---- 10. KNOWN-FAIL: ADD font selection ------------------------------------------------------
  await guard('capiche: ADD uses the target page font', async () => {
    const out = outFile('cap_addfont.pdf', 'regress');
    foodAR('capiche', out, {}, { ADDED: JSON.stringify([{ sec: 0, name: 'TEST DISH', desc: 'TOMATO, BASIL', price: '499', price2: '', allergens: [], _id: 1 }]) });
    const st = (await pageStreams(out))[0].toString('latin1');
    const i = st.indexOf('(TOMATO, BASIL)');
    const stamped = i < 0 ? null : (st.slice(0, i).match(/\/([A-Za-z0-9_]+) 1 Tf/g) || []).pop();
    // what the page's OWN baked descriptions use
    const fm = JSON.parse(fs.readFileSync(path.join(ED('capiche'), 'fieldmap.json'), 'utf8'));
    const d0 = fm.fields.find(f => f.role === 'desc' && f.page === 0);
    const base = (await pageStreams(path.join(ED('capiche'), 'capiche.pdf')))[0].toString('latin1');
    const off = Array.isArray(d0.lines?.[0]) ? d0.lines[0][0][0] : d0.line_spans?.[0]?.[0] ?? d0.span?.[0];
    const want = (base.slice(Math.max(0, off - 320), off).match(/\/([A-Za-z0-9_]+) 1 Tf/g) || []).pop();
    return [!!stamped && stamped === want, `stamped ${stamped} vs page font ${want}`];
  });

  // ---- 11. ADD charset is gated in the UI ------------------------------------------------------
  // The contract is NOT "the export sanitises text" — it is "the editor never lets unprintable text
  // be added". Every editor computes the offending characters and disables the Add button, so this
  // asserts the gate exists rather than driving the export (which a real user cannot reach directly:
  // the harnesses write into `added` behind the form, which is how this was briefly misdiagnosed as
  // a missing-validation bug).
  // Editors implement this two ways, both valid: BLOCK (compute the offending characters, disable the
  // Add button — capiche/aiko) or STRIP-AND-WARN (cleanField removes them, fontNote tells the user —
  // churnd/drinks/surat/ahm). What must never happen is unprintable text reaching the PDF silently,
  // so assert both halves: a charset-derived check AND a user-visible consequence.
  for (const d of ['capiche', 'aiko', 'churnd', 'drinks', 'capiche-surat', 'capiche-ahm']) {
    await guard(`${d}: ADD is gated on the font charset`, async () => {
      const src = fs.readFileSync(path.join(ED(d), 'index.html'), 'utf8');
      // deliberately mechanism-agnostic: the guard is named bad()/cleanField()/cleanName() depending
      // on the editor, so assert the CONTRACT (consults FM.allowed, and the user finds out) rather
      // than any one function name — otherwise the test breaks on a rename and lies on a rewrite.
      const checks = /FM\.allowed|ALLOWED[.[]/.test(src);
      const tellsUser = /\.disabled\s*=/.test(src) || /fontNote\s*\(/.test(src);
      const how = /function bad\(s,\s*allowed\)/.test(src) ? 'blocks' : 'strips+warns';
      return [checks && tellsUser, checks && tellsUser ? how : `consultsCharset=${checks} userVisible=${tellsUser}`];
    });
  }

  // and the charset data the gate relies on must actually exist
  await guard('every editor declares a per-role charset (FM.allowed)', async () => {
    const missing = [];
    for (const d of ['capiche', 'aiko', 'churnd', 'drinks', 'capiche-surat', 'capiche-ahm']) {
      const fm = JSON.parse(fs.readFileSync(path.join(ED(d), 'fieldmap.json'), 'utf8'));
      if (!fm.allowed || !Object.keys(fm.allowed).length) missing.push(d);
    }
    return [!missing.length, missing.length ? 'missing: ' + missing.join(', ') : 'all six'];
  });

  // ---- 11b. category (section heading) editing -------------------------------------------------
  // Each heading is a serif name + a gold handwritten label, both real text. The label also has a
  // stroked VECTOR copy of itself painted on top, which must be removed or the new word renders
  // over the old one — and `flourish_cm` points inside that overlay, so emitting both ops corrupts
  // the stream. Assert on the RENDER: new words present, old words gone.
  await guard('aiko: category name + decorative label are editable', async () => {
    const fm = JSON.parse(fs.readFileSync(path.join(ED('aiko'), 'fieldmap.json'), 'utf8'));
    const heads = fm.fields.filter(f => f.role === 'header' && f.kind === 'serif');
    const bad = [];
    for (const sf of heads) {
      const lf = fm.fields.find(q => q.id === sf.pair);
      // replacements must come from each font's own subset — see the charset note below
      const nv = sf.display === 'Noodles' ? 'Sides' : 'Noodles';
      const lv = lf.display === 'hearty' ? 'sweet' : 'hearty';
      const e = {}; e[sf.id] = nv; e[lf.id] = lv;
      const out = outFile(`aiko_cat_${sf.id.replace(':', '_')}.pdf`, 'regress');
      food('aiko', out, e);
      const L = R.textLines(out, sf.page);
      if (!L.some(l => l.text.includes(nv))) bad.push(`${sf.label}: new name missing`);
      if (!L.some(l => l.text.includes(lv))) bad.push(`${sf.label}: new label missing`);
      if (L.some(l => l.text.trim() === sf.display)) bad.push(`${sf.label}: old name still rendered`);
      if (L.some(l => l.text.trim() === lf.display)) bad.push(`${sf.label}: old label still rendered (vector overlay?)`);
      fs.unlinkSync(out);
    }
    return [!bad.length, bad.length ? bad.slice(0, 2).join('; ') : `${heads.length} pairs`];
  });

  /* ---- Dependent geometry follows the text it is anchored to -----------------------------------
     Three reported bugs shared one cause: the engine spliced new text in, but everything positioned
     RELATIVE to that text kept its pristine coordinates. These pin the two things that must move. */

  // A decorative label is placed by its serif word's right edge, so renaming the word must carry it.
  // Assert the OFFSET is preserved rather than "no overlap": the artwork deliberately sits the
  // script label over the serif word's tail (12pt of it, baked), and that look must survive.
  await guard('aiko: renaming a category carries its decorative label', async () => {
    const fm = JSON.parse(fs.readFileSync(path.join(ED('aiko'), 'fieldmap.json'), 'utf8'));
    const sf = fm.fields.find(f => f.role === 'header' && f.kind === 'serif' && f.display === 'Sides');
    const lf = fm.fields.find(q => q.id === sf.pair);
    const base = R.textLines(path.join(ED('aiko'), 'aiko.pdf'), sf.page);
    const b0 = base.find(l => l.text.trim() === sf.display), l0 = base.find(l => l.text.trim() === lf.display);
    const out = food('aiko', outFile('aiko_label_follow.pdf', 'regress'), { [sf.id]: 'Sides moin' });
    const cur = R.textLines(out, sf.page);
    const b1 = cur.find(l => l.text.trim() === 'Sides moin'), l1 = cur.find(l => l.text.trim() === lf.display);
    if (!b0 || !l0 || !b1 || !l1) return [false, 'heading or label line not found'];
    if (Math.abs(l1.x0 - l0.x0) < 1) return [false, `label did not move (x0 ${l0.x0} -> ${l1.x0})`];
    // same tuck under the word's tail, within a glyph's right-side bearing
    const tuck0 = b0.x1 - l0.x0, tuck1 = b1.x1 - l1.x0;
    return [Math.abs(tuck1 - tuck0) < 4,
      `label x0 ${l0.x0.toFixed(1)}->${l1.x0.toFixed(1)}, tuck ${tuck0.toFixed(1)}->${tuck1.toFixed(1)}pt`];
  });

  // Allergen icons are anchored to the name's right edge. A longer name used to print through them.
  for (const [ed, id, longer, icon] of [
    ['aiko', '0:0', 'TOM YUM SOUP MOIN SARFARAZ', null],
    ['capiche', '0:0', 'MARGHERITAXX', 'J'],
  ]) {
    await guard(`${ed}: a longer dish name carries its allergen markers`, async () => {
      const fm = JSON.parse(fs.readFileSync(path.join(ED(ed), 'fieldmap.json'), 'utf8'));
      const f = fm.fields.find(q => q.id === id);
      const src = path.join(ED(ed), fs.readdirSync(ED(ed)).find(n => n.endsWith('.pdf')));
      const before = A.overlaps(src, f.page, { menuMaxX: 520 });
      const out = food(ed, outFile(`${ed}_name_markers.pdf`, 'regress'), { [id]: longer });
      const after = A.overlaps(out, f.page, { menuMaxX: 520 });
      // reflow moves ink, and newFindings keys on the boxes, so compare by TEXT PAIR
      const tkey = o => o.a + ' ' + o.b, seen = new Set(before.map(tkey));
      const fresh = after.filter(o => !seen.has(tkey(o)));
      if (!A.hasText(out, f.page, longer)) return [false, 'the longer name did not render'];
      if (fresh.length) return [false, `new overlap: ${JSON.stringify(fresh[0].a)} <> ${JSON.stringify(fresh[0].b)}`];
      if (icon) {   // a text-drawn marker we can measure directly (Capiche's Jain "J")
        const g = (s) => (R.textLines(s, f.page).filter(l => l.text.trim() === icon && Math.abs(l.bot - f.y) < 6)[0] || {}).x0;
        const x0 = g(src), x1 = g(out);
        if (x0 == null || x1 == null) return [false, `marker "${icon}" not found`];
        if (x1 - x0 < 1) return [false, `marker "${icon}" did not move (${x0} -> ${x1})`];
        return [true, `no new overlaps; "${icon}" moved ${(x1 - x0).toFixed(1)}pt with the name`];
      }
      return [true, 'no new overlaps; icons cleared the longer name'];
    });
  }

  /* Korea is the ONLY marker with no icon template in FM.icons — it is drawn from vector
     primitives by flagBody(). The deployed build has no such branch, so `!ICONS[m]` skipped it and
     re-stamping any Korean dish DELETED its flag (verified by running the live build through this
     same harness). Pin both halves: drawn, and drawn exactly once. The generated flag's fills do
     not occur anywhere in the baked artwork, which is what makes the count meaningful. */
  await guard('aiko: a korea marker is stamped from the real artwork, exactly once', async () => {
    const fm = JSON.parse(fs.readFileSync(path.join(ED('aiko'), 'fieldmap.json'), 'utf8'));
    // a dish on page 0 that does NOT already carry the flag, so the count must rise by exactly one
    const dish = fm.fields.find(f => f.role === 'name' && f.page === 0 && (f.baked || []).length
                                  && !(f.baked || []).includes('korea'));
    const RED = /0\.773 0\.125 0\.196 rg/g;      // the artwork's own red, not a redrawn approximation
    const count = s => (s.match(RED) || []).length;
    const base = count((await pageStreams(path.join(ED('aiko'), 'aiko.pdf')))[0].toString('latin1'));
    if (!base) return [false, 'no baked korea flag on page 0 to copy from'];
    const want = [...(dish.baked || []), 'korea'];
    const out = food('aiko', outFile('aiko_korea.pdf', 'regress'), {}, null, { [dish.id]: want });
    const got = count((await pageStreams(out))[0].toString('latin1'));
    if (got === base) return [false, `${dish.display}: korea flag not drawn at all (live build's bug)`];
    return [got === base + 1, `${dish.display}: flags ${base} -> ${got} (must be +1 exactly)`];
  });

  // Icon templates carry no fill colour, so an appended cluster inherits whatever the page last
  // set — that is how an added gluten icon came out gold on THAI CURRY. The cluster must pin the ink.
  await guard('aiko: a re-stamped marker cluster pins its own ink colour', async () => {
    const fm = JSON.parse(fs.readFileSync(path.join(ED('aiko'), 'fieldmap.json'), 'utf8'));
    const dish = fm.fields.find(f => f.role === 'name' && /THAI CURRY/.test(f.display || ''));
    const want = [...new Set([...(dish.baked || []), 'gluten'])];
    const out = food('aiko', outFile('aiko_ink.pdf', 'regress'), {}, null, { [dish.id]: want });
    const s = (await pageStreams(out))[dish.page].toString('latin1');
    const grp = s.lastIndexOf('re\nW n\n');
    if (grp < 0) return [false, 'no appended marker group found'];
    const head = s.slice(grp, grp + 40);
    return [/re\nW n\n0 g\n/.test(head), `cluster prologue: ${JSON.stringify(head.slice(0, 24))} (must set "0 g")`];
  });

  /* Churn'd had no width check of any kind, so a long flavour name kept drawing straight through
     its own price columns and on into the second copy of the 2-up sheet. The cap is derived from
     the real geometry; this pins that it exists, that it is derived (not a guessed constant), and
     that it can never fire on untouched artwork. */
  await guard("churnd: a flavour name is capped to the width before its price columns", async () => {
    const src = fs.readFileSync(path.join(ED('churnd'), 'index.html'), 'utf8');
    if (!/function nameMaxChars/.test(src)) return [false, 'nameMaxChars() is gone — names are ungated again'];
    if (!/toolong/.test(src)) return [false, 'no overflow class wired into the export gate'];
    const fm = JSON.parse(fs.readFileSync(path.join(ED('churnd'), 'fieldmap.json'), 'utf8'));
    const ADV = 0.664, SZ = 12.5, PAD = 6;
    const cap = it => {
      const nx = it.name_x && it.name_x[0], px = it.prices && it.prices[0] && it.prices[0].x && it.prices[0].x[0];
      return (nx == null || px == null || px <= nx) ? 31 : Math.max(4, Math.floor((px - nx - PAD) / (ADV * SZ)));
    };
    const flagged = fm.items.filter(it => (it.name || '').length > cap(it));
    if (flagged.length) return [false, `cap rejects baked artwork: ${flagged.slice(0, 2).map(i => i.name).join('; ')}`];
    const longest = fm.items.reduce((a, b) => (b.name || '').length > (a.name || '').length ? b : a);
    const caps = [...new Set(fm.items.map(cap))].sort((a, b) => a - b);
    return [caps[0] > longest.name.length,
      `caps ${caps.join('/')} chars vs longest baked name ${longest.name.length} — headroom ${caps[0] - longest.name.length}`];
  });

  /* A description that needs another line now pushes the dishes beneath it down, instead of being
     silently shrunk to fit the designer's gap. The size assertion is the point: without it this
     passes on the OLD behaviour, which did render the text — just at 6.185pt instead of 7pt. */
  await guard('aiko: a description that needs a third line pushes the dishes below down', async () => {
    const SRC = path.join(ED('aiko'), 'aiko.pdf');
    const LONG = 'Broth, mushroom, tomatoes, bellpeppers, chilli, lemongrass, galangal, kaffir lime, fresh coriander';
    const out = food('aiko', outFile('aiko_grow.pdf', 'regress'), { '0:1': LONG });
    const bl = R.textLines(SRC, 0), cl = R.textLines(out, 0);
    const nameOf = L => L.find(l => l.text.startsWith('THAI SPRING ROLL'));
    const b = nameOf(bl), c = nameOf(cl);
    if (!b || !c) return [false, 'THAI SPRING ROLL not found'];
    if (!A.hasText(out, 0, 'fresh coriander')) return [false, 'the tail of the description did not print'];
    const descs = cl.filter(l => l.bot < 692 && l.bot > 660 && l.x0 < 60);
    if (descs.length < 3) return [false, `description rendered ${descs.length} line(s), expected 3`];
    // full size preserved: the grown lines are the same height as the baked one-liner
    const bh = (bl.find(l => l.text.startsWith('Broth,')) || {}).top - (bl.find(l => l.text.startsWith('Broth,')) || {}).bot;
    const ch = descs[0].top - descs[0].bot;
    if (Math.abs(ch - bh) > 0.6) return [false, `type shrank instead of pushing: line height ${bh} -> ${ch}`];
    const moved = b.bot - c.bot;
    if (moved <= 0.5) return [false, `dish below did not move down (${moved.toFixed(2)}pt)`];
    /* Calibrate against the artwork rather than a page-wide overlap sweep: mupdf's line boxes are
       9pt tall on an 8.4pt baseline pitch, so consecutive lines of ANY multi-line description report
       as overlapping — the baked page already does it in four places. What must hold is that the
       grown dish keeps at least the clearance the designer's own tightest pair already uses. */
    const tightestBaked = Math.min(...bl.filter(l => l.x0 < 60 && l.bot > 100)
      .map(l => { const below = bl.filter(n => n.x0 < 60 && n.bot < l.bot - 1).sort((a, b) => b.bot - a.bot)[0];
                  return below ? l.bot - below.bot : Infinity; }).filter(v => isFinite(v) && v > 0));
    const last = descs.sort((a, b) => a.bot - b.bot)[0];       // lowest rendered description line
    const gap = last.bot - c.bot;                              // down to the next dish's baseline
    if (gap < tightestBaked - 0.05)
      return [false, `only ${gap.toFixed(2)}pt to the dish below; the artwork's own tightest is ${tightestBaked.toFixed(2)}pt`];
    return [true, `3 lines at full size (h=${ch}), dish below moved down ${moved.toFixed(2)}pt, clearance ${gap.toFixed(2)}pt`];
  });

  /* Capiche growth, and growth composing with ADD / REMOVE. Capiche's structuralForPage addresses
     rows by baseline (no _rowId) and takes its sections from nav_sections, so the row->growth map
     is resolved the same way _rowSec is. Exercised in the RIGHT column of p0, which is the one with
     real headroom. `0:21` is APOLLO's description; `0:14`/`0:18` are ORTOLANA / GARLIC PIE. */
  {
    const CAP_LONG = 'POMODORO SAUCE, MOZZARELLA, FENNEL SALAMI, NDUJA, HOT HONEY, BASIL, CHILLI FLAKES, AGED PARMESAN, WILD ROCKET, TOASTED PINE NUTS';
    const mkAdd = (n, i) => ({ sec: 1, name: n, desc: 'TOMATO, BASIL, OLIVE OIL', price: '540', price2: '', allergens: ['dairy'], _id: 900 + i });
    const SCEN = [
      ['capiche: a grown description pushes the dishes below down', [], []],
      ['capiche: growth composes with an added dish', [], [mkAdd('TEST ALPHA', 1)]],
      ['capiche: growth composes with a removed dish', ['0:14'], []],
      ['capiche: growth composes with two removed dishes', ['0:14', '0:18'], []],
      ['capiche: growth composes with an add and a remove', ['0:14'], [mkAdd('TEST ALPHA', 1)]],
    ];
    const SRC = path.join(ED('capiche'), 'capiche.pdf');
    for (const [name, removed, added] of SCEN) {
      await guard(name, async () => {
        const env = {};
        if (removed.length) env.REMOVED = JSON.stringify(removed);
        if (added.length) env.ADDED = JSON.stringify(added);
        const out = foodAR('capiche', outFile(`cap_grow_${removed.length}${added.length}.pdf`, 'regress'),
          { '0:21': CAP_LONG }, env);
        const base = R.textLines(SRC, 0), cur = R.textLines(out, 0);
        // the description grew, and did NOT just shrink to fit the designer's gap
        if (!cur.some(l => /TOASTED PINE NUTS/i.test(l.text))) return [false, 'description tail did not print'];
        const b0 = base.find(l => /^POMODORO SAUCE, MOZZARELLA, FE/i.test(l.text));
        const c0 = cur.find(l => /^POMODORO SAUCE/i.test(l.text));
        if (!b0 || !c0) return [false, 'description not found'];
        if (Math.abs((c0.top - c0.bot) - (b0.top - b0.bot)) > 0.6) return [false, 'type shrank instead of pushing'];
        // consecutive lines of ANY multi-line description share ink boxes (9pt box, 8.4pt pitch),
        // so compare by text pair against the baked page and ignore the grown block's own lines
        const tk = o => o.a + ' ' + o.b, seen = new Set(A.overlaps(SRC, 0, { menuMaxX: 900 }).map(tk));
        const fresh = A.overlaps(out, 0, { menuMaxX: 900 }).filter(o => !seen.has(tk(o)))
          .filter(o => !/^(POMODORO SAUCE|FENNEL|HOT HONEY|CHILLI FLAKES|AGED PARMESAN|WILD ROCKET|TOASTED)/i.test(o.a));
        if (fresh.length) return [false, `new overlap: ${JSON.stringify(fresh[0].a).slice(0, 40)} <> ${JSON.stringify(fresh[0].b).slice(0, 36)}`];
        for (const id of removed) {
          const f = JSON.parse(fs.readFileSync(path.join(ED('capiche'), 'fieldmap.json'), 'utf8')).fields.find(q => q.id === id);
          if (f && cur.some(l => l.text.trim() === f.display)) return [false, `removed "${f.display}" still rendered`];
        }
        const placed = added.filter(a => cur.some(l => l.text.includes(a.name))).length;
        const bal = await operatorBalance(out);
        if (bal && bal.length) return [false, `operators unbalanced: ${JSON.stringify(bal[0])}`];
        return [true, `full size preserved, ${placed}/${added.length} added placed, no new overlaps`];
      });
    }
  }

  // The category fonts are SUBSETS holding only the glyphs the artwork already uses, so most
  // realistic renames are unrepresentable. Pin the ceiling so nobody "fixes" a rename by writing
  // characters the font cannot draw.
  await guard('aiko: category fonts are subsets and the limit is declared', async () => {
    const fm = JSON.parse(fs.readFileSync(path.join(ED('aiko'), 'fieldmap.json'), 'utf8'));
    const serif = fm.fields.find(f => f.role === 'header' && f.kind === 'serif');
    const script = fm.fields.find(f => f.role === 'header' && f.kind === 'script');
    const noP = serif.charset.indexOf('P') < 0;          // "Small Plates" is impossible
    const noSpace = script.charset.indexOf(' ') < 0;     // "TO SHARE" is impossible
    const declared = !!serif.charset && !!script.charset && !!serif.widths;
    return [noP && noSpace && declared,
      `serif=${JSON.stringify(serif.charset)} script=${JSON.stringify(script.charset)}`];
  });

  // ---- 12. bug-report API + dashboard security -------------------------------------------------
  // These have their own runners (they need jsdom / module loading); fold their verdicts in here so
  // `npm test` is the single gate.
  for (const [name, script] of [['bug API input clamps', 'test/bugapi.test.mjs'],
                                ['/bugs/ dashboard neutralises hostile records', 'test/bugsdash.test.mjs'],
                                ['capiche: ADD-ONS block fully editable', 'test/capiche.addons.mjs'],
                                ['cross-promo QRs + capiche FSSAI licence line', 'test/crosspromo.mjs']]) {
    await guard(name, async () => {
      try { const o = run(script, []); const m = /(\d+) passed, (\d+) failed/.exec(o);
            return [m && m[2] === '0', m ? `${m[1]} passed, ${m[2]} failed` : 'no summary line']; }
      catch (e) { const o = String(e.stdout || e.message); const m = /(\d+) passed, (\d+) failed/.exec(o);
                  return [false, m ? `${m[1]} passed, ${m[2]} failed` : String(e.message).slice(0, 90)]; }
    });
  }

  // ---- summary ---------------------------------------------------------------------------------
  const n = s => results.filter(r => r.status === s).length;
  console.log('-'.repeat(64));
  console.log(`  ${n('PASS')} passed   ${n('KNOWN-FAIL')} known-fail   ${n('FAIL')} failed   ${n('UNEXPECTED-PASS')} unexpected-pass`);
  if (n('UNEXPECTED-PASS')) {
    console.log('\n  A KNOWN-FAIL now passes — the bug is fixed. Remove its entry from KNOWN in test/regress.js:');
    results.filter(r => r.status === 'UNEXPECTED-PASS').forEach(r => console.log('   - ' + r.name));
  }
  if (n('FAIL')) {
    console.log('\n  FAILURES:');
    results.filter(r => r.status === 'FAIL').forEach(r => console.log(`   - ${r.name}: ${r.detail}`));
  }
  console.log(`\n  artefacts: ${OUT}\n`);
  process.exit(n('FAIL') ? 1 : 0);
})();
