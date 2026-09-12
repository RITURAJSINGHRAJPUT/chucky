// ===================== BESHAK — editor shell =====================
// Everything the person using the editor touches: the cards, the marker chips, add/remove,
// search + section rail, spell-check, live preview, Export and Publish. The byte engine above
// is untouched by any of it — this layer only ever changes `edits` / `removed` / `added` /
// `markerEdits` and then asks for a regenerate.

const MEM_BRAND = 'beshak';
let ready = false;
let activePage = 0;   // named to match the shared bug-reporter, which reads it
let previewTimer = null;
let pdfjsDoc = null;

const ALLERGEN_ICONS = {
  dairy: '<svg viewBox="0 0 12 22" aria-hidden="true"><path d="M3 6.5V3.2h6v3.3l1.6 2.4V20H1.4V8.9L3 6.5Z" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="3.4" y="1" width="5.2" height="1.8" rx=".9" fill="currentColor"/></svg>',
  gluten: '<svg viewBox="0 0 12 22" aria-hidden="true"><path d="M6 21V8" stroke="currentColor" stroke-width="1.5"/><ellipse cx="6" cy="2.6" rx="1.6" ry="2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M6 6.5 2 8.5v2l4-2 4 2v-2ZM6 10.5l-4 2v2l4-2 4 2v-2ZM6 14.5l-4 2v2l4-2 4 2v-2Z" fill="currentColor"/></svg>',
  sesame: '<svg viewBox="0 0 22 22" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.4"><ellipse cx="5" cy="7" rx="2" ry="1.4" transform="rotate(-25 5 7)"/><ellipse cx="11" cy="4" rx="2" ry="1.4" transform="rotate(20 11 4)"/><ellipse cx="17" cy="8" rx="2" ry="1.4" transform="rotate(-15 17 8)"/><ellipse cx="7" cy="13" rx="2" ry="1.4" transform="rotate(15 7 13)"/><ellipse cx="13" cy="11" rx="2" ry="1.4" transform="rotate(-30 13 11)"/><ellipse cx="16" cy="16" rx="2" ry="1.4" transform="rotate(25 16 16)"/><ellipse cx="9" cy="18" rx="2" ry="1.4" transform="rotate(-20 9 18)"/></g></svg>',
  jain: '<svg viewBox="0 0 12 22" aria-hidden="true"><path d="M8.6 2v12.2a4.4 4.4 0 0 1-8.1 2.4" fill="none" stroke="currentColor" stroke-width="2.2"/></svg>',
};
const MARKER_LABEL = { dairy: 'Dairy', gluten: 'Gluten', sesame: 'Sesame', jain: 'Jain possible' };

// ============================================================ edit-state plumbing
const curText = (f) => (edits[f.id] !== undefined ? edits[f.id] : f.display);
const memBaseVer = () => 'v' + (pdfBytesOrig ? pdfBytesOrig.length : 0);

function memSnapshot() {
  return { edits: JSON.parse(JSON.stringify(edits)), removed: removed.slice(), added: JSON.parse(JSON.stringify(added)), markerEdits: JSON.parse(JSON.stringify(markerEdits)) };
}
function memApply(s) {
  for (const k of Object.keys(edits)) delete edits[k];
  Object.assign(edits, s.edits || {});
  removed = s.removed || [];
  added = s.added || [];
  markerEdits = s.markerEdits || {};
}
function memRebuild() { buildEditor(); schedulePreview(); }

// ============================================================ validation
/** Characters the menu's own fonts cannot set, plus a light spell check on edited text. */
let DICT = null;
const deacc = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
function wordAllowed(w) {
  if (!DICT) return true;
  const t = deacc(w).toLowerCase().replace(/^[^a-z]+|[^a-z]+$/g, '');
  if (t.length < 3) return true;
  if (DICT.has(t)) return true;
  if (t.endsWith('s') && DICT.has(t.slice(0, -1))) return true;
  return t.split(/[-/]/).every((p) => p.length < 3 || DICT.has(p));
}
function typosIn(text) {
  return (String(text).match(/[A-Za-zÀ-ɏ'’-]+/g) || []).filter((w) => !wordAllowed(w));
}

function fieldIssues(f) {
  const val = curText(f);
  const role = f.role === 'gram' ? 'gram' : f.role;
  const bad = missingChars(val, famOf(f));
  const out = [];
  if (bad.length) out.push({ kind: 'char', msg: 'This menu’s font has no ' + bad.map((c) => (c === ' ' ? 'space' : '“' + c + '”')).join(', ') });
  if (role === 'price' && !/^\d+$/.test(val.trim())) out.push({ kind: 'char', msg: 'Prices are digits only' });
  if (edits[f.id] !== undefined && (role === 'name' || role === 'desc')) {
    const t = typosIn(val);
    if (t.length) out.push({ kind: 'spell', msg: 'Check spelling: ' + t.slice(0, 3).join(', ') });
  }
  return out;
}

/**
 * Issues on an added dish. These are checked separately because an added item is not an
 * FM.field — and without this an unavailable glyph would just make the new dish print nothing,
 * which is the silent-drop failure the other editors already gate against.
 */
function addedIssues(a) {
  const out = [];
  const check = (label, text, fam) => {
    const bad = missingChars(text || '', fam);
    if (bad.length) out.push({ kind: 'char', msg: label + ': this menu’s font has no ' + bad.map((c) => (c === ' ' ? 'space' : '“' + c + '”')).join(', ') });
  };
  check('Name', a.name, FM.res_to_family[nameFamKeyFor(a)]);
  check('Size', a.gram, FM.res_to_family[nameFamKeyFor(a)]);
  check('Price', a.price, FM.res_to_family[nameFamKeyFor(a)]);
  const dcol = FM.columns.find((c) => c.id === a.col);
  const dref = dcol && FM.fields.find((f) => f.role === 'desc' && f.of === dcol.ids[0]);
  if (dref) check('Description', a.desc, famOf(dref));
  if (a.price && !/^\d*$/.test(String(a.price).trim())) out.push({ kind: 'char', msg: 'Price: digits only' });
  if (!String(a.name || '').trim()) out.push({ kind: 'char', msg: 'Name: an added dish needs a name' });
  return out;
}
/** The display face used by a column, keyed the way res_to_family expects. */
function nameFamKeyFor(a) {
  const c = FM.columns.find((x) => x.id === a.col);
  const ref = c && byId[c.ids[c.ids.length - 1]];
  return ref ? ref.page + ref.font : 0 + '/R45';
}

function allIssues() {
  const out = [];
  for (const f of FM.fields) {
    if (f.role === 'name' && removed.includes(f.id)) continue;
    if (f.of && removed.includes(f.of)) continue;
    for (const i of fieldIssues(f)) out.push({ field: f, ...i });
  }
  for (const a of added) for (const i of addedIssues(a)) out.push({ added: a, ...i });
  return out;
}

function syncFlagPill() {
  const el = document.getElementById('flagpill');
  if (!el) return;
  const issues = allIssues();
  const blocking = issues.filter((i) => i.kind === 'char');
  if (blocking.length) { el.className = 'pill bad'; el.textContent = blocking.length + ' to fix'; }
  else if (issues.length) { el.className = 'pill warn'; el.textContent = '· ' + issues.length + ' to review'; }
  else { el.className = 'pill ok'; el.textContent = 'All clear'; }
  return blocking.length;
}

// ============================================================ the editor cards
function sectionsForPage(page) {
  const seen = [];
  for (const c of FM.columns) if (c.page === page && !seen.includes(c.section)) seen.push(c.section);
  return seen;
}

function dishesIn(page, section) {
  const ids = [];
  for (const c of FM.columns) if (c.page === page && c.section === section) ids.push(...c.ids);
  return ids.map((id) => byId[id]).sort((a, b) => (a.x - b.x) || (b.y - a.y));
}

function buildEditor() {
  const host = document.getElementById('editor');
  if (!host) return;
  host.innerHTML = '';
  for (const section of sectionsForPage(activePage)) {
    const dishes = dishesIn(activePage, section);
    const live = dishes.filter((d) => !removed.includes(d.id));
    const addedHere = added.filter((a) => (FM.columns.find((c) => c.id === a.col) || {}).section === section
      && (FM.columns.find((c) => c.id === a.col) || {}).page === activePage);
    const wrap = document.createElement('div');
    wrap.className = 'secgrp';
    wrap.innerHTML = `<h2 class="sechd" id="sec-${esc(section)}">${esc(section)}<span class="cnt">${live.length + addedHere.length}</span></h2>`;
    for (const d of dishes) wrap.appendChild(dishCard(d));
    for (const a of addedHere) wrap.appendChild(addedCard(a));
    const addBtn = document.createElement('button');
    addBtn.className = 'additem';
    addBtn.textContent = '+ Add item to ' + section;
    addBtn.onclick = () => openAdd(section);
    wrap.appendChild(addBtn);
    host.appendChild(wrap);
  }
  syncRail();
  syncFlagPill();
}

function fieldRow(f, label, opts) {
  const o = opts || {};
  const row = document.createElement('label');
  row.className = 'frow' + (o.wide ? ' wide' : '');
  const c = colOf(byId[f.of] || f) || { width: 240 };
  const width = f.role === 'name' ? Math.max(60, ((kidsOf[f.of] || {}).price ? 0 : 0) + c.width * 0.6) : c.width;
  const max = maxCharsFor(f.role === 'price' ? 40 : width, f.size, f.role === 'gram' ? 'gram' : f.role);
  const val = curText(f);
  row.innerHTML = `<span class="flbl">${esc(label)}</span>`;
  const input = document.createElement(o.area ? 'textarea' : 'input');
  input.value = val;
  input.maxLength = f.role === 'desc' ? max * (f.lines.length + 2) : max;
  input.dataset.fid = f.id;
  if (f.role === 'price') input.inputMode = 'numeric';
  input.oninput = () => {
    if (input.value === f.display) delete edits[f.id]; else edits[f.id] = input.value;
    markIssues(row, f);
    onChange();
  };
  row.appendChild(input);
  const note = document.createElement('span');
  note.className = 'fnote';
  row.appendChild(note);
  markIssues(row, f);
  return row;
}

function markIssues(row, f) {
  const note = row.querySelector('.fnote');
  const issues = fieldIssues(f);
  row.classList.toggle('bad', issues.some((i) => i.kind === 'char'));
  row.classList.toggle('warn', issues.length > 0 && !issues.some((i) => i.kind === 'char'));
  if (note) note.textContent = issues.length ? issues[0].msg : '';
}

function dishCard(d) {
  const card = document.createElement('article');
  card.className = 'card' + (removed.includes(d.id) ? ' gone' : '');
  card.dataset.name = (curText(d) + ' ' + ((kidsOf[d.id] || {}).desc ? curText(kidsOf[d.id].desc) : '')).toLowerCase();
  const k = kidsOf[d.id] || {};
  const head = document.createElement('div');
  head.className = 'chead';
  head.innerHTML = `<span class="cnum">${esc(d.section)}</span>`;
  const del = document.createElement('button');
  del.className = 'cdel';
  del.title = removed.includes(d.id) ? 'Put this item back' : 'Remove this item';
  del.textContent = removed.includes(d.id) ? '↺' : '✕';
  del.onclick = () => {
    if (removed.includes(d.id)) removed = removed.filter((x) => x !== d.id); else removed.push(d.id);
    buildEditor();
    onChange();
  };
  head.appendChild(del);
  card.appendChild(head);

  card.appendChild(fieldRow(d, 'Name'));
  if (k.gram) card.appendChild(fieldRow(k.gram, 'Size'));
  if (k.price) card.appendChild(fieldRow(k.price, 'Price'));
  if (k.desc) card.appendChild(fieldRow(k.desc, 'Description', { area: true, wide: true }));
  card.appendChild(markerChips(d));
  return card;
}

function markerChips(d) {
  const wrap = document.createElement('div');
  wrap.className = 'afchk';
  const cur = markerEdits[d.id] || d.markers || [];
  for (const t of FM.marker_order) {
    const on = cur.includes(t);
    const lab = document.createElement('label');
    lab.innerHTML = `<input type="checkbox"${on ? ' checked' : ''}><span class="mkico">${ALLERGEN_ICONS[t]}</span>${esc(MARKER_LABEL[t])}`;
    lab.querySelector('input').onchange = (e) => {
      const now = (markerEdits[d.id] || d.markers || []).slice();
      const i = now.indexOf(t);
      if (e.target.checked) { if (i < 0) now.push(t); } else if (i >= 0) now.splice(i, 1);
      markerEdits[d.id] = FM.marker_order.filter((x) => now.includes(x));
      onChange();
    };
    wrap.appendChild(lab);
  }
  return wrap;
}

function addedCard(a) {
  const card = document.createElement('article');
  card.className = 'card added';
  card.dataset.name = (a.name || '').toLowerCase();
  card.innerHTML = `<div class="chead"><span class="cnum">New item</span></div>`;
  const del = document.createElement('button');
  del.className = 'cdel';
  del.textContent = '✕';
  del.onclick = () => { added = added.filter((x) => x !== a); buildEditor(); onChange(); };
  card.querySelector('.chead').appendChild(del);
  const mk = (label, key, area) => {
    const row = document.createElement('label');
    row.className = 'frow' + (area ? ' wide' : '');
    row.innerHTML = `<span class="flbl">${esc(label)}</span>`;
    const inp = document.createElement(area ? 'textarea' : 'input');
    inp.value = a[key] || '';
    inp.oninput = () => { a[key] = inp.value; if (card._sync) card._sync(); onChange(); };
    row.appendChild(inp);
    return row;
  };
  card.appendChild(mk('Name', 'name'));
  card.appendChild(mk('Size', 'gram'));
  card.appendChild(mk('Price', 'price'));
  card.appendChild(mk('Description', 'desc', true));
  const note = document.createElement('div');
  note.className = 'addnote';
  card.appendChild(note);
  card._sync = () => {
    const iss = addedIssues(a);
    note.textContent = iss.length ? iss[0].msg : '';
    card.classList.toggle('bad', iss.length > 0);
  };
  card._sync();
  const chips = document.createElement('div');
  chips.className = 'afchk';
  for (const t of FM.marker_order) {
    const lab = document.createElement('label');
    lab.innerHTML = `<input type="checkbox"${(a.markers || []).includes(t) ? ' checked' : ''}><span class="mkico">${ALLERGEN_ICONS[t]}</span>${esc(MARKER_LABEL[t])}`;
    lab.querySelector('input').onchange = (e) => {
      a.markers = a.markers || [];
      if (e.target.checked) a.markers.push(t); else a.markers = a.markers.filter((x) => x !== t);
      a.markers = FM.marker_order.filter((x) => a.markers.includes(x));
      onChange();
    };
    chips.appendChild(lab);
  }
  card.appendChild(chips);
  return card;
}

function openAdd(section) {
  const cols = FM.columns.filter((c) => c.page === activePage && c.section === section);
  if (!cols.length) return;
  // put it in the column with the most room left below its last dish
  const col = cols.slice().sort((a, b) => b.bottom - a.bottom)[0];
  const n = added.filter((a) => a.col === col.id).length + 1;
  added.push({ col: col.id, index: n, name: 'New item', desc: '', price: '', gram: '', markers: [] });
  buildEditor();
  onChange();
}

// ============================================================ rail + search
function syncRail() {
  const rail = document.getElementById('rail');
  if (!rail) return;
  rail.querySelectorAll('.railsec').forEach((n) => n.remove());
  for (const s of sectionsForPage(activePage)) {
    const live = dishesIn(activePage, s).filter((d) => !removed.includes(d.id)).length
      + added.filter((a) => (FM.columns.find((c) => c.id === a.col) || {}).section === s).length;
    const b = document.createElement('button');
    b.className = 'railsec';
    b.innerHTML = `${esc(s)}<span class="cnt">${live}</span>`;
    b.onclick = () => { const el = document.getElementById('sec-' + s); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
    rail.appendChild(b);
  }
  rail.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', +b.dataset.pg === activePage));
}

function filterItems(q) {
  const t = String(q || '').trim().toLowerCase();
  document.querySelectorAll('#editor .card').forEach((c) => {
    c.style.display = (!t || (c.dataset.name || '').includes(t)) ? '' : 'none';
  });
  document.querySelectorAll('#editor .secgrp').forEach((g) => {
    const any = [...g.querySelectorAll('.card')].some((c) => c.style.display !== 'none');
    g.style.display = (!t || any) ? '' : 'none';
  });
}

function togglePrev(on) {
  const p = document.getElementById('previewPane');
  if (!p) return;
  const want = on === undefined ? !p.classList.contains('open') : on;
  p.classList.toggle('open', want);
  document.getElementById('scrim').classList.toggle('on', want && window.innerWidth <= 640);
}
function closeDrawers() { togglePrev(false); document.getElementById('scrim').classList.remove('on'); }

// ============================================================ change plumbing
function onChange() {
  syncFlagPill();
  schedulePreview();
  if (ready) { try { MEM.tick(); } catch (_) { /* memory is best-effort */ } }
}

function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => { renderPreview().catch(() => {}); }, 260);
}

// ============================================================ preview / export
async function renderPreview() {
  const canvas = document.getElementById('preview');
  if (!canvas || typeof pdfjsLib === 'undefined') return;
  const busy = document.getElementById('busy');
  if (busy) busy.style.display = '';
  try {
    const bytes = await regenerate();
    const doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
    pdfjsDoc = doc;
    const page = await doc.getPage(activePage + 1);
    const wrap = document.getElementById('wrap');
    const vw = Math.max(240, (wrap ? wrap.clientWidth : 480) - 8);
    const vp0 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: vw / vp0.width });
    canvas.width = vp.width; canvas.height = vp.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    const tag = document.getElementById('ptag');
    if (tag) tag.textContent = '— Page ' + (activePage + 1);
  } catch (e) {
    if (!/Cancelled/i.test(String(e && e.message))) throw e;
  } finally { if (busy) busy.style.display = 'none'; }
}

function download(bytes, name) {
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
}

async function doExport() {
  if (syncFlagPill()) { alert('Some text can’t be printed in this menu’s fonts — fix the highlighted fields first.'); return; }
  const bytes = await regenerate();
  download(bytes, 'Beshak_Menu.pdf');
  try { MEM.push('export'); } catch (_) { /* history is best-effort */ }
  celebrate();
}

// ============================================================ publish
// Unlike Export, which hands a PDF to whoever clicked it, Publish pushes the current edit state
// to the server so any device opening this editor afterwards starts from it. It ships the same
// JSON that drives regenerate() — the baseline PDF and fieldmap are never touched.
const PUBKEY = 'chucky_publish_key';
function askPublishKey(prev) {
  const k = prompt(prev ? 'That publish key was rejected. Try again:' : 'Publish key:', '');
  if (k) { try { localStorage.setItem(PUBKEY, k); } catch (_) { /* private mode */ } }
  return k;
}
async function doPublish() {
  const btn = document.getElementById('publish');
  if (!btn) return;
  if (syncFlagPill()) { alert('Some text can’t be printed in this menu’s fonts — fix the highlighted fields first.'); return; }
  if (!confirm('Publish this menu? Everyone who opens the Beshak editor will start from it.')) return;
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = 'Publishing…';
  let key = '';
  try { key = localStorage.getItem(PUBKEY) || ''; } catch (_) { key = ''; }
  if (!key) key = askPublishKey('');
  const send = () => fetch('/api/menu-state/' + MEM_BRAND + '?k=' + encodeURIComponent(key), {
    method: 'POST', body: JSON.stringify({ state: memSnapshot(), base: memBaseVer() }),
  });
  try {
    await regenerate();                 // refuse to publish a state that will not even export
    if (!key) { btn.disabled = false; btn.textContent = label; return; }
    let res = await send();
    if (res.status === 403) {
      key = askPublishKey(key);
      if (!key) { btn.disabled = false; btn.textContent = label; return; }
      res = await send();
    }
    if (!res.ok) alert('Could not publish (server said ' + res.status + ').');
    else { btn.textContent = 'Published ✓'; setTimeout(() => { btn.textContent = label; }, 1600); }
  } catch (e) {
    alert('Could not publish: ' + ((e && e.message) || e));
  } finally { btn.disabled = false; if (btn.textContent === 'Publishing…') btn.textContent = label; }
}

// ============================================================ export celebration
const CHUCKY_LINES = ['KILLED IT 😎', 'CHEF’S KISS 🤌', 'SERVED 🍽️', 'COOKED. LITERALLY.', 'MENU SLAPS.',
  'PLATED. 🐾', 'CERTIFIED BANGER.', 'ATE. NO CRUMBS.', 'HOT OUT THE OVEN.', 'THAT’S A WRAP.'];
let lineSeed = 0;
function celebrate() {
  const day = Math.floor((Date.now() - new Date().getTimezoneOffset() * 60000) / 86400000);
  const txt = CHUCKY_LINES[(day + lineSeed++) % CHUCKY_LINES.length];
  const ov = document.createElement('div');
  ov.id = 'celebrate';
  ov.innerHTML = '<div class="cbcard"><div class="cbmark">BESHAK</div><div class="cbline">' + esc(txt) + '</div></div>';
  document.body.appendChild(ov);
  setTimeout(() => ov.remove(), 1900);
}

// ============================================================ wiring
function wire() {
  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
  on('export', () => { doExport().catch((e) => alert('Export failed: ' + ((e && e.message) || e))); });
  on('publish', () => { doPublish(); });
  on('fullprev', async () => {
    const bytes = await regenerate();
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  });
  document.querySelectorAll('.rail .tabs button').forEach((b) => {
    b.onclick = () => { activePage = +b.dataset.pg; buildEditor(); schedulePreview(); };
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
      e.preventDefault();
      const q = document.getElementById('q');
      if (q) q.focus();
    }
  });
  window.addEventListener('resize', () => { clearTimeout(previewTimer); previewTimer = setTimeout(() => renderPreview().catch(() => {}), 300); });
}

// ============================================================ boot
async function boot() {
  const msg = (t) => { const el = document.getElementById('bootmsg'); if (el) el.textContent = t; };
  msg('Reading the menu…');
  const v = '?v=' + Date.now();
  const [fmRes, pdfRes, baseRes, culRes] = await Promise.all([
    fetch('fieldmap.json' + v), fetch('beshak.pdf' + v), fetch('base_words.json' + v), fetch('culinary.json' + v),
  ]);
  FM = await fmRes.json();
  pdfBytesOrig = new Uint8Array(await pdfRes.arrayBuffer());
  try {
    const base = await baseRes.json(), cul = await culRes.json();
    DICT = new Set([].concat(base.words || base, cul.words || cul).map((w) => String(w).toLowerCase()));
    for (const f of FM.fields) for (const w of String(f.display || '').match(/[A-Za-z]+/g) || []) DICT.add(w.toLowerCase());
  } catch (_) { DICT = null; }

  for (const f of FM.fields) {
    byId[f.id] = f;
    if (f.of) { kidsOf[f.of] = kidsOf[f.of] || {}; kidsOf[f.of][f.role] = f; }
  }

  msg('Opening the artwork…');
  pdfDoc = await PDFDocument.load(pdfBytesOrig, { updateMetadata: false });
  loadStreams();

  msg('Checking for a published menu…');
  try {
    const r = await fetch('/api/menu-state/' + MEM_BRAND + v);
    if (r.ok) {
      const j = await r.json();
      if (j && j.state) memApply(j.state);
    }
  } catch (_) { /* offline or not deployed: fall back to the pristine menu */ }

  buildEditor();
  wire();
  try { MEM.init(); } catch (_) { /* memory is optional */ }
  const b = document.getElementById('boot');
  if (b) b.style.display = 'none';
  ready = true;
  renderPreview().catch(() => {});
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildEditor, boot, regenerate, memSnapshot, memApply, fieldIssues, addedIssues, wrapText };
}
