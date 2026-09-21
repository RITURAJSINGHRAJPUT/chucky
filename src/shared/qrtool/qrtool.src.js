/* QRTOOL:BEGIN — generated from src/shared/qrtool/qrtool.src.js by `npm run qr:inject`. Edit there, not here. */
/* ============ QR CODES — click one on the preview to resize / move / change link / remove; "+ QR" adds one ============
   Same tool, same interface in every editor. It never touches the page streams the byte engine owns:
   - A QR already in the artwork was baked (src/shared/qr_bake.mjs) into a Form XObject tagged /ChuckyQR.
     Resizing / moving it rewrites that Form's /Matrix; removing it zeroes its /BBox. Untouched => the
     Form's own pristine objects go back, so an unedited menu still exports byte-identical.
   - An ADDED QR is drawn in a separate overlay stream: the page's /Contents becomes
     [ "q", <the engine's own stream(s)>, "Q", overlay ] — the q/Q isolates whatever state the artwork
     leaves behind, and the engine keeps assigning its stream by ref exactly as before.
   Editor glue (4 lines each): QRK.apply(doc) just before doc.save(); QRK.hits(hitlayer, page, W, H) at the
   end of pvSync(); qr:QRK.snap() / QRK.load(st.qr) in memSnapshot/memApply; QRK.init({refresh}) at boot. */
const QRK = (() => {
  // ---- encoder: src/shared/qr/gf.mjs + encode.mjs, inlined verbatim by the build ----
  //@@ENCODER@@

  const MIN_S = 0.4, MAX_S = 3, STEP = 0.1;             // existing QRs: scale factor
  const MIN_PT = 28, MAX_PT = 220, DEF_PT = 60;         // added QRs: code size in pt (1cm = 28.35pt)
  const QUIET = 2;                                      // white modules round an added code
  const SMALL_PT = 51;                                  // < 1.8cm: warn it may not scan from a table
  let st = { base: {}, added: [] };                     // base[id] = {s,dx,dy,off}; added[] = {id,page,url,cx,cy,size}
  let found = null;                                     // discovered per doc
  let hooks = { refresh() {} };
  let sel = null, stageRef = null, geo = null, timer = null;
  const encCache = {};

  const num = v => { const s = (+v).toFixed(3).replace(/0+$/, '').replace(/\.$/, ''); return s === '-0' ? '0' : s || '0'; };
  const cm = pt => (pt * 2.54 / 72).toFixed(1) + ' cm';
  const txt = o => o ? (o.decodeText ? o.decodeText() : String(o)) : '';
  const neutral = s => !s || (!s.off && Math.abs((s.s == null ? 1 : s.s) - 1) < 1e-9 && !s.dx && !s.dy);

  function encode(url) {
    if (!encCache[url]) encCache[url] = qrEncode(url, { ecLevel: 'M' });
    return encCache[url];
  }

  function discover(doc) {
    const { PDFName, PDFDict, PDFArray } = PDFLib;
    const list = [], pages = [];
    doc.getPages().forEach((pg, p) => {
      pages.push({ node: pg.node, orig: pg.node.get(PDFName.of('Contents')), refs: null });
      let res = null; try { res = pg.node.Resources(); } catch (_) {}
      const xo = res && res.lookupMaybe(PDFName.of('XObject'), PDFDict);
      if (!xo) return;
      for (const [, ref] of xo.entries()) {
        const obj = doc.context.lookup(ref); const d = obj && obj.dict;
        if (!d || !d.get(PDFName.of('ChuckyQR'))) continue;
        const onPage = d.get(PDFName.of('ChuckyQRPage'));
        if (onPage && onPage.asNumber && onPage.asNumber() !== p) continue;
        const bb = d.lookup(PDFName.of('BBox'), PDFArray).asArray().map(n => n.asNumber());
        list.push({ id: txt(d.get(PDFName.of('ChuckyQR'))), page: p, dict: d,
                    label: txt(d.get(PDFName.of('ChuckyQRLabel'))) || 'QR code', url: txt(d.get(PDFName.of('ChuckyQRUrl'))),
                    box: bb, bboxObj: d.get(PDFName.of('BBox')), matrixObj: d.get(PDFName.of('Matrix')) });
      }
    });
    found = { doc, list, pages };
  }

  /* the one place geometry is decided: a QR's current box in PDF space (y up) */
  function boxOf(q) {
    if (q.url != null && q.cx != null) {                 // added
      const h = q.size / 2; return { x0: q.cx - h, y0: q.cy - h, x1: q.cx + h, y1: q.cy + h };
    }
    const s = st.base[q.id] || {}, k = s.s == null ? 1 : s.s;
    const [x0, y0, x1, y1] = q.box, cx = (x0 + x1) / 2 + (s.dx || 0), cy = (y0 + y1) / 2 + (s.dy || 0);
    const hw = (x1 - x0) / 2 * k, hh = (y1 - y0) / 2 * k;
    return { x0: cx - hw, y0: cy - hh, x1: cx + hw, y1: cy + hh };
  }

  function overlayOps(a) {
    const { size: n, matrix } = encode(a.url), N = n + 2 * QUIET, m = a.size / n;
    let o = `q\n1 0 0 1 ${num(a.cx - a.size / 2 - QUIET * m)} ${num(a.cy - a.size / 2 - QUIET * m)} cm\n${num(m)} 0 0 ${num(m)} 0 0 cm\n`;
    o += `0 0 0 0 k\n0 0 ${N} ${N} re\nf\n0 0 0 1 k\n`;
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n;) {
        if (!matrix[r * n + c]) { c++; continue; }
        let e = c; while (e < n && matrix[r * n + e]) e++;
        o += `${QUIET + c} ${QUIET + n - 1 - r} ${e - c} 1 re\n`; c = e;
      }
    }
    return o + 'f\nQ\n';
  }

  /* called by the editor right before doc.save(): idempotent, derives everything from `st` */
  function apply(doc) {
    const { PDFName, PDFRawStream, PDFNumber } = PDFLib;
    if (!found || found.doc !== doc) discover(doc);
    for (const q of found.list) {
      const s = st.base[q.id], d = q.dict;
      if (neutral(s)) {                                   // put the artwork's own objects back
        d.set(PDFName.of('BBox'), q.bboxObj);
        if (q.matrixObj) d.set(PDFName.of('Matrix'), q.matrixObj); else d.delete(PDFName.of('Matrix'));
      } else if (s.off) {
        d.set(PDFName.of('BBox'), doc.context.obj([0, 0, 0, 0]));
      } else {
        const k = s.s == null ? 1 : s.s, [x0, y0, x1, y1] = q.box, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
        d.set(PDFName.of('BBox'), q.bboxObj);
        d.set(PDFName.of('Matrix'), doc.context.obj([k, 0, 0, k, +num(cx * (1 - k) + (s.dx || 0)), +num(cy * (1 - k) + (s.dy || 0))]));
      }
    }
    const raw = t => { const b = new Uint8Array(t.length); for (let i = 0; i < t.length; i++) b[i] = t.charCodeAt(i) & 255;
                       return PDFRawStream.of(doc.context.obj({ Length: PDFNumber.of(b.length) }), b); };
    // last page first, so clearing several pages' overlays unwinds the object count in order
    for (let p = found.pages.length - 1; p >= 0; p--) {
      const pi = found.pages[p];
      const mine = st.added.filter(a => a.page === p);
      if (!mine.length) {
        if (!pi.refs) continue;
        /* drop the overlay objects entirely: an orphan stream would still be written by save(), and
           the object count in the trailer with it — clearing the last added QR must give back the
           byte-identical export */
        pi.node.set(PDFName.of('Contents'), pi.orig);
        for (const r of [pi.refs.open, pi.refs.close, pi.refs.over]) doc.context.delete(r);
        if (doc.context.largestObjectNumber === pi.refs.top) doc.context.largestObjectNumber = pi.refs.before;
        pi.refs = null; continue;
      }
      if (!pi.refs) {
        const before = doc.context.largestObjectNumber;
        pi.refs = { before, open: doc.context.register(raw('q\n')), close: doc.context.register(raw('\nQ\n')), over: doc.context.register(raw('')) };
        pi.refs.top = doc.context.largestObjectNumber;
      }
      doc.context.assign(pi.refs.over, raw(mine.map(overlayOps).join('')));
      const inner = pi.orig && pi.orig.asArray ? pi.orig.asArray() : [pi.orig];
      pi.node.set(PDFName.of('Contents'), doc.context.obj([pi.refs.open, ...inner, pi.refs.close, pi.refs.over]));
    }
  }

  // ---------------- state API (also what the tests drive) ----------------
  const bump = () => { clearTimeout(timer); timer = setTimeout(() => { try { hooks.refresh(); } catch (e) { console.error(e); } }, 140); };
  const baseQ = id => found && found.list.find(q => q.id === id);
  const addQ = id => st.added.find(a => a.id === id);
  const bs = id => (st.base[id] = st.base[id] || { s: 1, dx: 0, dy: 0, off: false });
  function list(page) {
    const out = [];
    if (found) for (const q of found.list) if (page == null || q.page === page)
      out.push({ id: q.id, page: q.page, kind: 'artwork', label: q.label, url: q.url, off: !!(st.base[q.id] || {}).off, box: boxOf(q) });
    for (const a of st.added) if (page == null || a.page === page)
      out.push({ id: a.id, page: a.page, kind: 'added', label: 'QR code', url: a.url, off: false, box: boxOf(a) });
    return out;
  }
  function sizeOf(id) { const a = addQ(id); if (a) return a.size; const q = baseQ(id); const b = q && boxOf(q); return b ? b.x1 - b.x0 : 0; }
  function setSize(id, pt) {
    const a = addQ(id); if (a) { a.size = Math.max(MIN_PT, Math.min(MAX_PT, pt)); return; }
    const q = baseQ(id); if (!q) return; const s = bs(id);
    s.s = Math.max(MIN_S, Math.min(MAX_S, pt / (q.box[2] - q.box[0])));
  }
  function grow(id, dir) {                               // one click of - / +
    const a = addQ(id);
    if (a) setSize(id, a.size + dir * 5.67);             // 2mm a click
    else { const s = bs(id); s.s = Math.round(Math.max(MIN_S, Math.min(MAX_S, (s.s || 1) + dir * STEP)) * 100) / 100; }
  }
  function move(id, dx, dy) { const a = addQ(id); if (a) { a.cx += dx; a.cy += dy; return; } const s = bs(id); s.dx = (s.dx || 0) + dx; s.dy = (s.dy || 0) + dy; }
  function remove(id) { if (addQ(id)) st.added = st.added.filter(a => a.id !== id); else if (baseQ(id)) bs(id).off = true; }
  function restore(id) { if (st.base[id]) st.base[id].off = false; }
  function reset(id) { if (baseQ(id)) delete st.base[id]; }
  function checkUrl(url) {
    url = String(url || '').trim();
    if (!url) return { err: 'Paste the link the QR should open.' };
    try { encode(url); } catch (_) { return { err: 'That link is too long for a QR code (max ~210 characters).' }; }
    return { url };
  }
  function add(o) {
    const c = checkUrl(o.url); if (c.err) throw new Error(c.err);
    const a = { id: 'qa' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), page: o.page | 0, url: c.url,
                cx: +o.cx, cy: +o.cy, size: Math.max(MIN_PT, Math.min(MAX_PT, +o.size || DEF_PT)) };
    st.added.push(a); return a.id;
  }
  /* a new link for an existing QR = hide the artwork's one, draw a fresh code in its place at its size */
  function setLink(id, url) {
    const c = checkUrl(url); if (c.err) throw new Error(c.err);
    const a = addQ(id); if (a) { a.url = c.url; return id; }
    const q = baseQ(id); if (!q) return id;
    const b = boxOf(q); bs(id).off = true;
    return add({ page: q.page, url: c.url, cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2, size: b.x1 - b.x0 });
  }
  const snap = () => JSON.parse(JSON.stringify(st));
  function load(o) {
    st = { base: {}, added: [] };
    if (o && typeof o === 'object') {
      for (const [k, v] of Object.entries(o.base || {})) if (v && typeof v === 'object')
        st.base[k] = { s: +v.s || 1, dx: +v.dx || 0, dy: +v.dy || 0, off: !!v.off };
      for (const a of (Array.isArray(o.added) ? o.added : [])) {
        if (!a || checkUrl(a.url).err) continue;
        st.added.push({ id: String(a.id || ('qa' + st.added.length)), page: a.page | 0, url: String(a.url).trim(), cx: +a.cx || 0, cy: +a.cy || 0,
                        size: Math.max(MIN_PT, Math.min(MAX_PT, +a.size || DEF_PT)) });
      }
    }
    sel = null; closePanel();
  }
  function init(h) { hooks = Object.assign({ refresh() {} }, h || {}); }

  // ---------------- UI ----------------
  const CSS = `
.qrk-box{position:absolute;pointer-events:auto;cursor:grab;border-radius:3px;box-shadow:inset 0 0 0 1.5px rgba(40,120,255,.0);transition:box-shadow .12s,background .12s;z-index:3;touch-action:none}
.qrk-box:hover,.qrk-box.sel{box-shadow:inset 0 0 0 2px #2f7cf6,0 0 0 3px rgba(47,124,246,.18);background:rgba(47,124,246,.06)}
.qrk-box.drag{cursor:grabbing}
.qrk-box.off{box-shadow:inset 0 0 0 1.5px rgba(120,120,120,.8);background:repeating-linear-gradient(45deg,rgba(0,0,0,.05) 0 6px,transparent 6px 12px)}
.qrk-box .qrk-tag{position:absolute;left:0;top:-17px;font:600 10px/14px system-ui,sans-serif;background:#2f7cf6;color:#fff;padding:0 5px;border-radius:3px;white-space:nowrap;opacity:0;transition:opacity .12s;pointer-events:none}
.qrk-box:hover .qrk-tag,.qrk-box.sel .qrk-tag,.qrk-box.off .qrk-tag{opacity:1}
.qrk-box.off .qrk-tag{background:#777}
.qrk-add{position:absolute;right:8px;top:8px;z-index:4;font:600 12px/1 system-ui,sans-serif;padding:7px 10px;border-radius:8px;border:1px solid rgba(0,0,0,.15);background:#fff;color:#1b1b1b;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.12)}
.qrk-add:hover{background:#f1f5ff;border-color:#2f7cf6}
.qrk-panel{position:fixed;z-index:9999;width:292px;background:#fff;color:#1b1b1b;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.28);padding:12px 14px 14px;font:13px/1.35 system-ui,sans-serif}
.qrk-panel .qrk-h{display:flex;align-items:center;gap:8px;margin-bottom:10px}
.qrk-panel .qrk-h b{font-size:14px}
.qrk-panel .qrk-x{margin-left:auto;border:0;background:none;font-size:20px;line-height:1;cursor:pointer;color:#666;padding:0 2px}
.qrk-panel .qrk-sub{color:#666;font-size:11.5px;word-break:break-all;margin:-6px 0 10px}
.qrk-panel .qrk-row{display:flex;align-items:center;gap:6px;margin:8px 0}
.qrk-panel .qrk-row>span:first-child{width:38px;color:#555;font-size:12px}
.qrk-panel button.qb{min-width:30px;height:30px;border-radius:8px;border:1px solid #d5d5d5;background:#f7f7f7;cursor:pointer;font:600 15px/1 system-ui,sans-serif;color:#1b1b1b}
.qrk-panel button.qb:hover{border-color:#2f7cf6;background:#f1f5ff}
.qrk-panel input[type=range]{flex:1;min-width:0}
.qrk-panel .qrk-val{width:48px;text-align:right;font-variant-numeric:tabular-nums;font-size:12px}
.qrk-panel .qrk-acts{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}
.qrk-panel .qrk-acts button{flex:1;height:32px;border-radius:8px;border:1px solid #d5d5d5;background:#f7f7f7;cursor:pointer;font:600 12px system-ui,sans-serif;color:#1b1b1b;white-space:nowrap}
.qrk-panel .qrk-acts button:hover{border-color:#2f7cf6;background:#f1f5ff}
.qrk-panel .qrk-acts button.danger{color:#c62828}
.qrk-panel .qrk-acts button.primary{background:#2f7cf6;border-color:#2f7cf6;color:#fff}
.qrk-panel input[type=url]{width:100%;box-sizing:border-box;height:34px;border-radius:8px;border:1px solid #cfcfcf;padding:0 10px;font:13px system-ui,sans-serif}
.qrk-panel .qrk-warn{margin-top:8px;font-size:11.5px;color:#a35c00}
.qrk-panel .qrk-err{margin-top:6px;font-size:12px;color:#c62828}
.qrk-panel .qrk-hint{font-size:11px;color:#888}`;
  function css() { if (document.getElementById('qrk-css')) return; const s = document.createElement('style'); s.id = 'qrk-css'; s.textContent = CSS; document.head.appendChild(s); }
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* boxes over every QR on the page + the "+ QR" button; called at the end of the editor's pvSync() */
  function hits(hl, page, W, H) {
    if (!hl || typeof document === 'undefined') return;
    css();
    geo = { hl, page, W, H };
    const stage = hl.parentNode;
    if (stage && !stage.querySelector('.qrk-add')) {
      if (getComputedStyle(stage).position === 'static') stage.style.position = 'relative';
      const b = document.createElement('button'); b.className = 'qrk-add'; b.type = 'button';
      b.textContent = '+ QR'; b.title = 'Add a QR code to this page';
      b.addEventListener('click', e => { e.stopPropagation(); openAdd(b); });
      stage.appendChild(b);
    }
    stageRef = stage;
    hl.querySelectorAll('.qrk-box').forEach(n => n.remove());
    for (const q of list(page)) {
      const d = document.createElement('div');
      d.className = 'qrk-box' + (q.off ? ' off' : '') + (sel === q.id ? ' sel' : '');
      place(d, q.box);
      d.dataset.qr = q.id;
      d.title = q.off ? 'Removed QR — click to restore' : 'Click to resize, move, change link or remove · drag to move';
      d.innerHTML = `<span class="qrk-tag">${q.off ? 'QR removed' : '▣ ' + esc(q.label)}</span>`;
      drag(d, q.id);
      hl.appendChild(d);
    }
  }
  function place(d, b) {
    const { W, H } = geo;
    d.style.left = (b.x0 / W * 100) + '%'; d.style.width = ((b.x1 - b.x0) / W * 100) + '%';
    d.style.top = ((H - b.y1) / H * 100) + '%'; d.style.height = ((b.y1 - b.y0) / H * 100) + '%';
  }
  /* drag to move (page-space delta from the stage's on-screen size); a click without travel opens the panel */
  function drag(d, id) {
    d.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      const r = geo.hl.getBoundingClientRect(), kx = geo.W / r.width, ky = geo.H / r.height;
      const x0 = e.clientX, y0 = e.clientY, L = parseFloat(d.style.left), T = parseFloat(d.style.top);
      let moved = false;
      try { d.setPointerCapture(e.pointerId); } catch (_) {}
      const mv = ev => {
        const dx = ev.clientX - x0, dy = ev.clientY - y0;
        if (!moved && Math.hypot(dx, dy) < 4) return;
        moved = true; d.classList.add('drag');
        d.style.left = (L + dx / r.width * 100) + '%'; d.style.top = (T + dy / r.height * 100) + '%';
      };
      const up = ev => {
        d.removeEventListener('pointermove', mv); d.removeEventListener('pointerup', up); d.removeEventListener('pointercancel', up);
        d.classList.remove('drag');
        if (!moved) { openEdit(id, d); return; }
        move(id, (ev.clientX - x0) * kx, -(ev.clientY - y0) * ky);
        sel = id; bump(); if (panel && panel.dataset.id === id) openEdit(id, d);
      };
      d.addEventListener('pointermove', mv); d.addEventListener('pointerup', up); d.addEventListener('pointercancel', up);
    });
    d.addEventListener('click', e => e.stopPropagation());
  }

  let panel = null;
  function closePanel() { if (panel) { panel.remove(); panel = null; } if (typeof document !== 'undefined') document.removeEventListener('pointerdown', outside, true); }
  function outside(e) { if (panel && !panel.contains(e.target) && !(e.target.closest && e.target.closest('.qrk-box,.qrk-add'))) { sel = null; closePanel(); resync(); } }
  function resync() { if (geo) hits(geo.hl, geo.page, geo.W, geo.H); }
  function shell(anchor, html) {
    closePanel(); css();
    panel = document.createElement('div'); panel.className = 'qrk-panel'; panel.innerHTML = html;
    document.body.appendChild(panel);
    const a = anchor.getBoundingClientRect(), pw = panel.offsetWidth || 292, ph = panel.offsetHeight || 260;
    let left = a.right + 10, top = a.top;
    if (left + pw > innerWidth - 8) left = a.left - pw - 10;
    if (left < 8) left = Math.max(8, Math.min(innerWidth - pw - 8, a.left));
    if (top + ph > innerHeight - 8) top = innerHeight - ph - 8;
    panel.style.left = Math.max(8, left) + 'px'; panel.style.top = Math.max(8, top) + 'px';
    panel.querySelector('.qrk-x').onclick = () => { sel = null; closePanel(); resync(); };
    setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
    return panel;
  }
  function openEdit(id, anchor) {
    const q = list().find(x => x.id === id); if (!q) return;
    sel = id; resync();
    const isAdd = q.kind === 'added';
    const lo = isAdd ? MIN_PT : Math.round(MIN_S * (baseQ(id).box[2] - baseQ(id).box[0])), hi = isAdd ? MAX_PT : Math.round(MAX_S * (baseQ(id).box[2] - baseQ(id).box[0]));
    const p = shell(anchor, `
      <div class="qrk-h"><b>QR code</b><button class="qrk-x" title="Close">×</button></div>
      <div class="qrk-sub">${esc(q.label)}${q.url ? ' · ' + esc(q.url) : ''}</div>
      ${q.off ? `<div class="qrk-row">This QR is removed from the menu.</div>
      <div class="qrk-acts"><button class="primary" data-a="restore">Restore it</button><button data-a="link">New link…</button></div>` : `
      <div class="qrk-row"><span>Size</span><button class="qb" data-a="minus" title="Smaller">−</button>
        <input type="range" min="${lo}" max="${hi}" step="1" value="${Math.round(sizeOf(id))}">
        <button class="qb" data-a="plus" title="Bigger">+</button><span class="qrk-val"></span></div>
      <div class="qrk-row"><span>Move</span><button class="qb" data-a="L" title="Left">←</button><button class="qb" data-a="U" title="Up">↑</button>
        <button class="qb" data-a="D" title="Down">↓</button><button class="qb" data-a="R" title="Right">→</button><span class="qrk-hint">or drag it</span></div>
      <div class="qrk-warn" hidden></div>
      <div class="qrk-acts"><button data-a="link">Change link…</button>${isAdd ? '' : '<button data-a="reset">Reset</button>'}<button class="danger" data-a="remove">Remove</button></div>`}
      <div class="qrk-linkbox" hidden><div class="qrk-row"><input type="url" placeholder="https://…" value="${esc(q.url || '')}"></div>
        <div class="qrk-err" hidden></div><div class="qrk-acts"><button class="primary" data-a="setlink">Use this link</button></div></div>`);
    p.dataset.id = id;
    const val = p.querySelector('.qrk-val'), rng = p.querySelector('input[type=range]'), warn = p.querySelector('.qrk-warn');
    const show = () => {
      const s = sizeOf(id); if (val) val.textContent = cm(s); if (rng) rng.value = Math.round(s);
      if (warn) { warn.hidden = s >= SMALL_PT; warn.textContent = 'Small QR codes can be hard to scan — keep it at least 1.8 cm.'; }
      const q2 = list().find(x => x.id === id), box = q2 && geo && geo.hl.querySelector(`.qrk-box[data-qr="${id}"]`);
      if (box) place(box, q2.box);
    };
    show();
    if (rng) rng.addEventListener('input', () => { setSize(id, +rng.value); show(); bump(); });
    const nudge = 1.4175;                                  // 0.5 mm
    p.addEventListener('click', e => {
      const a = e.target.closest('[data-a]'); if (!a) return;
      const act = a.dataset.a;
      if (act === 'minus' || act === 'plus') { grow(id, act === 'plus' ? 1 : -1); show(); bump(); }
      else if ('LRUD'.includes(act)) { move(id, act === 'L' ? -nudge : act === 'R' ? nudge : 0, act === 'U' ? nudge : act === 'D' ? -nudge : 0); show(); bump(); }
      else if (act === 'remove') { remove(id); sel = null; closePanel(); resync(); bump(); }
      else if (act === 'restore') { restore(id); openEdit(id, anchor); bump(); }
      else if (act === 'reset') { reset(id); show(); bump(); }
      else if (act === 'link') { p.querySelector('.qrk-linkbox').hidden = false; const i = p.querySelector('input[type=url]'); i.focus(); i.select(); }
      else if (act === 'setlink') {
        const i = p.querySelector('input[type=url]'), er = p.querySelector('.qrk-err');
        try { const nid = setLink(id, i.value); sel = nid; closePanel(); resync(); bump(); }
        catch (x) { er.hidden = false; er.textContent = x.message; }
      }
    });
    const inp = p.querySelector('input[type=url]');
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') p.querySelector('[data-a=setlink]').click(); });
  }
  function openAdd(anchor) {
    if (!geo) return;
    sel = null; resync();
    const p = shell(anchor, `
      <div class="qrk-h"><b>Add a QR code</b><button class="qrk-x" title="Close">×</button></div>
      <div class="qrk-row"><input type="url" placeholder="Paste the link, e.g. https://instagram.com/…"></div>
      <div class="qrk-err" hidden></div>
      <div class="qrk-hint">It appears in the middle of this page — then drag it where you want it and set its size.</div>
      <div class="qrk-acts"><button class="primary" data-a="go">Add QR</button></div>`);
    const i = p.querySelector('input'), er = p.querySelector('.qrk-err');
    const go = () => {
      try {
        const id = add({ page: geo.page, url: i.value, cx: geo.W / 2, cy: geo.H / 2, size: DEF_PT });
        sel = id; closePanel(); resync(); bump();
        const box = geo.hl.querySelector(`.qrk-box[data-qr="${id}"]`); if (box) openEdit(id, box);
      } catch (x) { er.hidden = false; er.textContent = x.message; }
    };
    p.querySelector('[data-a=go]').onclick = go;
    i.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    setTimeout(() => i.focus(), 0);
  }

  return { apply, hits, init, snap, load, list, add, remove, restore, reset, setSize, grow, move, setLink, sizeOf, encode };
})();
/* QRTOOL:END */
