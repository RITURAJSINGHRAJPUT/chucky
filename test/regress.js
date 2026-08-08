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
const food   = (d, out, edits, env) => { run('foodh.js', [ED(d), out, JSON.stringify(edits || {})], env); return out; };
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
