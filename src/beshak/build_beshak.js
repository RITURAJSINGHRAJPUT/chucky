// Build the Beshak editor's data: a normalised PDF plus the fieldmap that drives the engine.
//
//   node src/beshak/build_beshak.js [outDir=deploy/public/beshak]
//
// Beshak differs from every other brand in this repo in three ways, and the fieldmap shape
// follows from them:
//   1. Nothing editable lives in a page's content stream. Each page draws ONE big Form XObject
//      that holds the artwork and the names/descriptions/prices, and the "250 gm" labels sit in
//      their own little sibling XObjects. So a field records WHICH STREAM it lives in as well as
//      its byte spans, and the engine keeps pristine bytes per stream instead of per page.
//   2. Text is Identity-H: every glyph is a 2-byte CID and each one is its own tiny string in a
//      kerned TJ array. Editing means re-encoding through the font's ToUnicode map, so the
//      fieldmap ships the unicode->CID table and the per-CID widths.
//   3. The markers are not uniform. dairy and jain are outlines that can be lifted and re-stamped
//      anywhere; gluten is an image XObject with no outline to lift, so its stamp is traced off
//      the printed page instead. All three are drawn in the stream, so all three delete by span.
const fs = require('fs');
const path = require('path');
const { PDFName } = require('pdf-lib');
const { loadDoc, parseText, widthOf } = require('./lib');
const { normalize } = require('./normalize');
const { mainXObjectName, qBlockAround } = require('./icons');
const { topLevelBlocks, bboxOf } = require('./blocks');
const { templateFromBlock, BRAND_K } = require('./marker_extract');
const { traceIcon, inkMask, components } = require('./trace');

const SRC = process.env.BESHAK_SRC || 'incoming/Beshak_DineIn_Menu.pdf';
const OUT_DIR = process.argv[2] || 'deploy/public/beshak';

const FAM = { name: 'GTAmericaTrial-CmBd', nameAlt: 'GTAmericaTrial-CmRg', desc: 'TestSohne-Buch', head: 'TGGasolineRegular', sym: 'NotoSans-Regular' };
const MARKERS = ['dairy', 'gluten', 'jain'];                 // the legend's order, left to right
const r2 = (v) => Math.round(v * 100) / 100;
const isPrice = (t) => /^\d{2,4}$/.test(t.trim());

// Every icon in this artwork is ~8.2-8.6pt tall and nothing else in a marker strip reaches 8,
// so this one threshold separates markers from the gm/ml label's digits in both detectors.
const MARKER_MIN_H = 7.6;
// Real section headings. The back page also sets "Elevated," / "not alienated" in the heading
// face — that is the tagline, not a section, and no dish sits under it.
const SECTION_LABELS = ['APPS', 'DRINKS', 'BREADS', 'MAINS', 'DESSERT'];

// ---------------------------------------------------------------- text runs
/**
 * One entry per show-op, carrying the position that op actually paints at. A block may move
 * down with Td mid-stream and carry on, so a block is NOT always one line.
 * Beshak sets `1 0 0 1 x y Tm` with the size on the Tf, so Td offsets are already in text
 * units and must NOT be scaled by the font size (that scaling is a Capiche-ism).
 */
function runsOf(streamText, fonts, streamId, page) {
  const out = [];
  for (const b of parseText(streamText, fonts)) {
    if (!b.tm) continue;
    const F = fonts[b.font];
    let ax = 0, ay = 0;
    for (const o of b.ops) {
      if (o.kind === 'td') { ax += o.dx; ay += o.dy; continue; }
      out.push({
        block: b, font: b.font, fam: F ? F.fam : '', size: r2(b.size),
        x: r2(b.tm[4] + ax), y: r2(b.tm[5] + ay),
        text: o.text, span: o.span, stream: streamId, page,
        tm_span: b.tmSpan, tm: b.tm.map(r2),
      });
    }
  }
  return out;
}

/**
 * Group runs that share a baseline into left-to-right visual lines, then split each baseline
 * wherever a wide horizontal gap appears. Both pages set two or three columns side by side, so
 * a shared baseline is NOT a shared line — without the gap split, "Boondi, Crackling Spinach,"
 * in the left column would swallow "Coriander, Housemade seasoning," from the right one.
 */
function toLines(runs, widthOfRun, tol = 1.2, colGap = 20) {
  const rows = [];
  for (const r of runs.slice().sort((a, b) => b.y - a.y || a.x - b.x)) {
    const R = rows.find((l) => Math.abs(l.y - r.y) < tol && Math.abs(l.size - r.size) < 2.5);
    if (R) R.runs.push(r); else rows.push({ y: r.y, size: r.size, runs: [r] });
  }
  const lines = [];
  for (const R of rows) {
    R.runs.sort((a, b) => a.x - b.x);
    let cur = null;
    let end = -Infinity;
    for (const r of R.runs) {
      if (!cur || r.x - end > colGap) { cur = { y: R.y, x: r.x, size: R.size, runs: [] }; lines.push(cur); }
      cur.runs.push(r);
      end = Math.max(end, r.x + widthOfRun(r));
    }
  }
  return lines;
}

/**
 * Section bands, measured off the printed page. Each heading is underlined by a rule that spans
 * exactly the block it introduces — which is the only thing that separates BREADS from MAINS,
 * since those two headings share a baseline and MAINS is set flush right over its own columns.
 * On page 1 the rules live in the background raster, so they have to be found as ink, not ops.
 */
async function detectBands(pdfPath, headings) {
  const { inkMask: mask } = require('./trace');
  const bands = [];
  for (const h of headings) {
    const R = { page: h.page, x0: 20, yTop: h.y - 3, x1: 585, yBot: h.y - 16, dpi: 300 };
    const M = await mask(pdfPath, R);
    const runs = [];
    for (let y = 0; y < M.h; y++) {
      let run = 0, start = 0;
      for (let x = 0; x <= M.w; x++) {
        const on = x < M.w && M.mask[y * M.w + x];
        if (on) { if (!run) start = x; run++; }
        else { if (run > M.w * 0.10) runs.push({ y, x0: start, x1: x - 1, len: run }); run = 0; }
      }
    }
    const picked = [];
    for (const r of runs.sort((a, b) => b.len - a.len)) {
      if (picked.some((p) => Math.abs(p.x0 - r.x0) < 20)) continue;
      picked.push(r);
    }
    const segs = picked
      .map((r) => ({ x0: r2(R.x0 + r.x0 / M.scale), x1: r2(R.x0 + r.x1 / M.scale), y: r2(R.yTop - r.y / M.scale) }))
      .sort((a, b) => a.x0 - b.x0);
    bands.push({ ...h, segs });
  }
  // A heading can rule SEVERAL segments — MAINS sets three columns here and the designer broke
  // its rule over each — and two headings can share a baseline (BREADS and MAINS do), so their
  // segments arrive mixed together. Give each segment to the nearest heading at or left of it,
  // which is the reading order the rules were drawn in.
  // resolved against the HEADING baselines, so do it before any band's y is moved to its rule
  const spans = bands.map((b) => b.segs.filter((s) => {
    const owner = bands
      .filter((o) => o.page === b.page && Math.abs(o.y - b.y) < 6 && o.x <= s.x0 + 12)
      .sort((p, q) => q.x - p.x)[0];
    return !owner || owner.label === b.label;
  }).map((s) => [s.x0, s.x1]));
  bands.forEach((b, i) => {
    b.spans = spans[i].length ? spans[i] : [[0, 600]];
    b.x0 = Math.min(...b.spans.map((s) => s[0]));
    b.x1 = Math.max(...b.spans.map((s) => s[1]));
    b.y = b.segs.length ? b.segs[0].y : r2(b.y - 8);
    delete b.segs;
  });
  return bands;
}

/** The distinct BT blocks a field occupies, so reflow can move every one of its Tm origins. */
function blocksOf(runs) {
  const out = [];
  for (const r of runs) {
    if (!r.tm_span) continue;
    if (out.some((b) => b.tm_span[0] === r.tm_span[0])) continue;
    out.push({ tm_span: r.tm_span, tm: r.tm });
  }
  return out;
}

// ---------------------------------------------------------------- markers
/**
 * Holes in an ink blob. The milk bottle has a couple (cap slot, body); the wheat ear has one per
 * grain, so counting them separates two icons that are otherwise nearly the same size.
 */
function holeCount(mask, w, h, c) {
  const inside = (x, y) => x >= c.minx && x <= c.maxx && y >= c.miny && y <= c.maxy;
  const seen = new Uint8Array(w * h);
  let holes = 0;
  for (let y = c.miny; y <= c.maxy; y++) {
    for (let x = c.minx; x <= c.maxx; x++) {
      const i = y * w + x;
      if (mask[i] || seen[i]) continue;
      const stack = [i];
      seen[i] = 1;
      let touchesEdge = false, n = 0;
      while (stack.length) {
        const p = stack.pop();
        const px = p % w, py = (p - px) / w;
        n++;
        if (px === c.minx || px === c.maxx || py === c.miny || py === c.maxy) touchesEdge = true;
        for (const q of [px > 0 ? p - 1 : -1, px < w - 1 ? p + 1 : -1, py > 0 ? p - w : -1, py < h - 1 ? p + w : -1]) {
          if (q < 0) continue;
          const qx = q % w, qy = (q - qx) / w;
          if (!inside(qx, qy) || mask[q] || seen[q]) continue;
          seen[q] = 1; stack.push(q);
        }
      }
      if (!touchesEdge && n > 4) holes++;
    }
  }
  return holes;
}

/**
 * Every marker icon drawn in one stream, with the byte span that draws it.
 *
 * All three are drawn as `q <clip> W n ... /RNNN Do Q`, but they split cleanly:
 *   * dairy and jain clip with their own OUTLINE, so their block carries curve ops. The "J" is
 *     the wider of the two (~5.5pt against the bottle's ~4.6).
 *   * gluten clips with a plain rectangle and paints an image through it — no curves at all.
 *     The distiller emits that as two adjacent blocks (the bare `re W* n`, then the same rect
 *     plus the `Do`), and BOTH have to go when the marker is removed, so they are merged here.
 */
function iconInventory(streamText) {
  const raw = [];
  for (const [a, b] of topLevelBlocks(streamText)) {
    const bb = bboxOf(streamText.slice(a, b));
    if (!bb) continue;
    const w = bb.w / 10, h = bb.h / 10;
    if (w < 3.5 || w > 8 || h < MARKER_MIN_H || h > 12) continue;
    const chunk = streamText.slice(a, b);
    const curved = /(?:^|\s)[\d.-]+\s+[\d.-]+\s+[cvyl](?:\s|$)/.test(chunk);
    raw.push({
      type: !curved ? 'gluten' : (w >= 5.2 ? 'jain' : 'dairy'),
      x: r2(bb.x / 10), y: r2(bb.y / 10), w: r2(w), h: r2(h), span: [a, b],
    });
  }
  // merge gluten's clip/draw pair (same box, back to back) into the one span that removes it
  const out = [];
  for (const i of raw) {
    const prev = out[out.length - 1];
    if (prev && prev.type === 'gluten' && i.type === 'gluten'
      && Math.abs(prev.x - i.x) < 0.2 && Math.abs(prev.y - i.y) < 0.2 && i.span[0] - prev.span[1] <= 1) {
      prev.span[1] = i.span[1];
      continue;
    }
    out.push(i);
  }
  return out.sort((p, q) => q.y - p.y || p.x - q.x);
}

/**
 * Find the markers set beside one dish by looking at the printed page. This reads the RENDERED
 * ink rather than the operators, so it is the independent check on what a customer actually sees
 * — that is what makes it worth keeping now that the build itself reads markers off the stream
 * (`iconInventory`), and it is the route `test/beshak.test.mjs` audits exports through.
 *
 * All three icons are set at the same height in this artwork (~8.2-8.4pt), so size alone cannot
 * separate them. What does: the wheat ear encloses one white gap per grain, the milk bottle a
 * handful, and the Jain "J" none at all — and the "J" is the only wide one.
 */
async function detectMarkers(src, page, x0, x1, yBase, dpi = 1200) {
  const region = { page, x0, yTop: yBase + 11, x1, yBot: yBase - 4, dpi };
  const M = await inkMask(src, region);
  const comps = components(M).filter((c) => {
    const w = (c.maxx - c.minx) / M.scale, h = (c.maxy - c.miny) / M.scale;
    return c.n > 60 && w > 1 && w < 12 && h > 1.2 && h < 13;
  });
  const px2pt = (c) => ({
    x: r2(region.x0 + c.minx / M.scale), y: r2(region.yTop - c.maxy / M.scale),
    w: r2((c.maxx - c.minx + 1) / M.scale), h: r2((c.maxy - c.miny + 1) / M.scale),
  });
  const found = [];
  for (const c of comps) {
    const b = px2pt(c);
    // a gm/ml label's digits reach ~7.4pt at most; every marker is at least 8
    if (b.h < MARKER_MIN_H) continue;
    const holes = holeCount(M.mask, M.w, M.h, c);
    found.push({ type: holes >= 5 ? 'gluten' : (b.w >= 5 ? 'jain' : 'dairy'), ...b });
  }
  return found.sort((a, b) => a.x - b.x);
}

// ---------------------------------------------------------------- build
async function build({ outDir = OUT_DIR, src = SRC } = {}) {
  fs.mkdirSync(outDir, { recursive: true });

  const { bytes, famInfo } = await normalize(src);
  const pdfPath = path.join(outDir, 'beshak.pdf');
  fs.writeFileSync(pdfPath, bytes);

  const { ctx, raw, pages } = await loadDoc(pdfPath);

  // ---- streams the engine may splice into ----
  const streams = {};
  const pageInfo = [];
  for (const P of pages) {
    const stub = raw(P.page.node.get(PDFName.of('Contents'))).toString('latin1');
    const mainName = mainXObjectName(stub);
    const mainRef = P.xobjects.get(PDFName.of(mainName));
    const mainId = 'p' + P.pi;
    streams[mainId] = { page: P.pi, ref: mainRef.toString(), kind: 'main' };
    const labels = [];
    for (const k of P.xobjects.keys()) {
      const ref = P.xobjects.get(k);
      const d = ctx.lookup(ref).dict.toString().replace(/\s+/g, ' ');
      if (/\/Subtype\s*\/Image/.test(d) || k.toString() === '/' + mainName || !/\/Font/.test(d)) continue;
      const bb = (d.match(/\/BBox \[([^\]]*)\]/) || [, ''])[1].trim().split(/\s+/).map(Number);
      const id = 'x' + ref.objectNumber;
      streams[id] = { page: P.pi, ref: ref.toString(), kind: 'label' };
      labels.push({ id, ref, name: k.toString().slice(1), bbox: bb.map((v) => r2(v / 10)) });
    }
    const mainText = raw(mainRef).toString('latin1');
    // A label XObject is positioned by its own BBox, not by a transform at the call site, so the
    // only way to move or hide one is through the `/RNNN Do` that draws it. Record that span.
    for (const L of labels) {
      const m = new RegExp('/' + L.name + '\\s+Do').exec(mainText);
      L.do_span = m ? qBlockAround(mainText, m.index) : null;
    }
    pageInfo.push({ pi: P.pi, P, mainId, mainRef, stream: mainText, labels, size: P.page.getSize() });
  }

  // ---- marker icons, found in the stream ----
  const inventory = {};
  for (const PI of pageInfo) inventory[PI.pi] = iconInventory(PI.stream);

  // ---- marker icon templates ----
  // dairy and jain are real outlines, so their stamp is lifted straight out of the artwork.
  // gluten is drawn as an image XObject and has no outline to lift — it is traced off the
  // printed page instead, from an instance located above rather than a hard-coded region, so
  // the trace follows the artwork if the designer moves it.
  const icons = {};
  for (const kind of ['dairy', 'jain']) {
    const inst = pageInfo.flatMap((PI) => inventory[PI.pi].filter((i) => i.type === kind)
      .map((i) => ({ ...i, stream: PI.stream })))[0];
    if (!inst) throw new Error(`no ${kind} icon found in the artwork — retune iconInventory()`);
    const t = templateFromBlock(inst.stream.slice(inst.span[0], inst.span[1]));
    if (!t) throw new Error(`could not read the ${kind} outline out of its block`);
    icons[kind] = { body: t.body, w: t.w, h: t.h, source: 'vector' };
  }
  {
    const g0 = pageInfo.flatMap((PI) => inventory[PI.pi].filter((i) => i.type === 'gluten')
      .map((i) => ({ ...i, page: PI.pi })))[0];
    if (!g0) throw new Error('no gluten icon found in the artwork — retune iconInventory()');
    const pad = 0.4;
    const g = await traceIcon(src, {
      page: g0.page, x0: g0.x - pad, yTop: g0.y + g0.h + pad, x1: g0.x + g0.w + pad, yBot: g0.y - pad, dpi: 2400,
    }, { tolPt: 0.008 });
    if (!g) throw new Error('gluten trace found no contours');
    icons.gluten = { body: g.body, w: g.w, h: g.h, source: 'traced' };
  }

  // ---- fields ----
  const fields = [];
  const sections = [];
  let idc = 0;

  for (const PI of pageInfo) {
    const fonts = PI.P.fonts;
    const runs = runsOf(PI.stream, fonts, PI.mainId, PI.pi);

    for (const r of runs) {
      if (r.fam === FAM.head && r.size > 20) {
        const label = r.text.trim().toUpperCase();
        if (SECTION_LABELS.includes(label)) sections.push({ label, page: PI.pi, x: r.x, y: r.y });
      }
    }

    // name runs: the display face at heading size. Lone spaces and the NotoSans "/" in
    // "Biryani W/ Salan" are part of a name too, so they are kept as joiners.
    const isNameRun = (r) => (r.fam === FAM.name || r.fam === FAM.nameAlt || r.fam === FAM.sym) && r.size >= 12;
    const nameRuns = runs.filter(isNameRun);
    const priceRuns = nameRuns.filter((r) => isPrice(r.text));
    const nameWordRuns = nameRuns.filter((r) => !isPrice(r.text));
    const descRuns = runs.filter((r) => (r.fam === FAM.desc || r.fam === FAM.sym) && r.size >= 9 && r.size < 12 && r.text.length);

    const widthOfRun = (r) => {
      const F = fonts[r.font];
      if (!F) return r.text.length * r.size * 0.55;
      return widthOf(F, [...r.text].map((c) => F.uni2cid[c]).filter((c) => c !== undefined), r.size);
    };

    // -- names: same baseline, running left to right with only small gaps between parts --
    const nameGroups = [];

    for (const p of nameWordRuns.slice().sort((a, b) => b.y - a.y || a.x - b.x)) {
      const g = nameGroups.find((G) => Math.abs(G.y - p.y) < 1.5 && p.x >= G.maxx - 1.5 && p.x - G.maxx < 6);
      if (g) { g.parts.push(p); g.maxx = Math.max(g.maxx, p.x + widthOfRun(p)); }
      else if (p.text.trim()) nameGroups.push({ y: p.y, x: p.x, maxx: p.x + widthOfRun(p), parts: [p] });
    }
    // a group that is nothing but whitespace is a spacer, not a dish
    const dishes = nameGroups.filter((g) => g.parts.some((p) => p.text.trim()));

    // -- description lines --
    const descLines = toLines(descRuns, widthOfRun);

    // -- gram / ml labels --
    const labelFields = [];
    for (const L of PI.labels) {
      const lres = ctx.lookup(ctx.lookup(L.ref).dict.get(PDFName.of('Resources')));
      const lfonts = {};
      const fd = ctx.lookup(lres.get(PDFName.of('Font')));
      for (const k of fd.keys()) {
        const fref = fd.get(k).toString();
        const match = Object.values(fonts).find((F) => F.fontRef.toString() === fref);
        if (match) lfonts[k.toString()] = match;
      }
      const lruns = runsOf(raw(L.ref).toString('latin1'), lfonts, L.id, PI.pi);
      if (!lruns.length) continue;
      const text = lruns.map((r) => r.text).join('');
      if (!text.trim() || /[A-Z]{4}/.test(text)) continue;      // the DAIRY/GLUTEN/... legend words
      labelFields.push({ ...lruns[0], text, ops: lruns.map((r) => ({ span: r.span, text: r.text })), bbox: L.bbox, do_span: L.do_span });
    }

    for (const g of dishes) {
      const first = g.parts[0];
      const id = `${PI.pi}:${idc++}`;
      const nameField = {
        role: 'name', id, page: PI.pi, stream: PI.mainId, font: first.font,
        x: first.x, y: first.y, size: first.size,
        display: g.parts.map((p) => p.text).join('').replace(/\s+/g, ' ').trim(),
        ops: g.parts.map((p) => ({ span: p.span, text: p.text, font: p.font })),
        kern: medianKern(first.block),
        right: r2(g.maxx),
        blocks: blocksOf(g.parts),
      };
      fields.push(nameField);

      // description: consecutive lines under the name in the same column
      const mine = [];
      let prevY = first.y;
      for (const L of descLines) {
        if (L._used) continue;
        if (Math.abs(L.x - first.x) > 8) continue;
        if (L.y > first.y - 3) continue;
        const gap = prevY - L.y;
        if (gap > (mine.length ? 16 : 23)) break;
        L._used = true;
        mine.push(L);
        prevY = L.y;
      }
      if (mine.length) {
        fields.push({
          role: 'desc', id: `${PI.pi}:${idc++}`, page: PI.pi, stream: PI.mainId, of: id,
          x: mine[0].x, y: mine[0].y, size: mine[0].size, font: mine[0].runs[0].font,
          pitch: mine.length > 1 ? r2(mine[0].y - mine[1].y) : 11.25,
          lines: mine.map((L) => ({
            y: L.y, x: L.x,
            ops: L.runs.map((r) => ({ span: r.span, text: r.text, font: r.font, x: r.x })),
            text: L.runs.map((r) => r.text).join(''),
          })),
          display: mine.map((L) => L.runs.map((r) => r.text).join('')).join(' ').replace(/\s+/g, ' ').trim(),
          kern: medianKern(mine[0].runs[0].block),
          blocks: blocksOf(mine.flatMap((L) => L.runs)),
        });
      }

      const pr = priceRuns.filter((p) => !p._used && p.x > first.x && Math.abs(p.y - first.y) < 9).sort((a, b) => a.x - b.x)[0];
      if (pr) {
        pr._used = true;
        fields.push({
          role: 'price', id: `${PI.pi}:${idc++}`, page: PI.pi, stream: PI.mainId, of: id,
          x: pr.x, y: pr.y, size: pr.size, font: pr.font,
          ops: [{ span: pr.span, text: pr.text }], display: pr.text.trim(), kern: medianKern(pr.block),
          blocks: blocksOf([pr]),
        });
      }

      const gm = labelFields.filter((l) => !l._used && l.x > first.x - 2 && Math.abs(l.y - first.y) < 9).sort((a, b) => a.x - b.x)[0];
      if (gm) {
        gm._used = true;
        fields.push({
          role: 'gram', id: `${PI.pi}:${idc++}`, page: PI.pi, stream: gm.stream, of: id,
          x: gm.x, y: gm.y, size: gm.size, font: gm.font,
          ops: gm.ops, display: gm.text.trim(), bbox: gm.bbox, do_span: gm.do_span,
        });
      }
    }
  }

  // ---- markers, per dish ----
  const nameFields = fields.filter((f) => f.role === 'name');
  for (const n of nameFields) {
    const price = fields.find((f) => f.of === n.id && f.role === 'price');
    const gram = fields.find((f) => f.of === n.id && f.role === 'gram');
    // page 0 sets the gm label before the markers, page 1 after them, so scan the whole strip
    // between the name and the price and drop anything sitting inside the label's own box.
    const from = n.right + 1.0;
    const to = price ? price.x - 1.5 : from + 70;
    n.marker_geom = { from: r2(from), to: r2(to), base_y: n.y };
    if (to - from < 3) { n.markers = []; n.marker_boxes = []; continue; }
    const gbox = gram ? gram.bbox : null;
    // Every marker in this artwork is drawn in the stream, so the inventory gives an exact span
    // and box per icon. detectMarkers() still reads the same strip off the printed page — that
    // is what the tests audit exports through, and the two agreeing is checked below.
    const found = inventory[n.page]
      .filter((m) => m.x >= from - 1 && m.x + m.w <= to + 1 && Math.abs(m.y - n.y) < 6)
      .filter((m) => !(gbox && m.x + m.w > gbox[0] - 0.5 && m.x < gbox[2] + 0.5))
      .sort((a, b) => a.x - b.x);
    n.markers = found.map((m) => m.type);
    n.marker_boxes = found.map((m) => ({ type: m.type, x: m.x, y: m.y, w: m.w, h: m.h, span: m.span }));
  }

  // ---- section assignment: the nearest band above whose rule spans this dish's column ----
  const bands = await detectBands(pdfPath, sections);
  bands.sort((a, b) => a.page - b.page || b.y - a.y);
  for (const n of nameFields) {
    let best = null, bestD = Infinity;
    for (const b of bands) {
      if (b.page !== n.page) continue;
      const d = b.y - n.y;
      if (d < 0) continue;
      // a rule starts a little right of the column it introduces, so allow a small overhang
      if (!b.spans.some((s) => n.x >= s[0] - 15 && n.x <= s[1])) continue;
      if (d < bestD) { bestD = d; best = b; }
    }
    n.section = best ? best.label : 'MENU';
  }

  // Standing copy set in the display face reads exactly like a dish name — page 2's "Proudly
  // Vegetarian. Entirely Delicious." is the case here. What separates it from a real dish is
  // that it sits under no section rule AND carries no price; every dish on this menu has both.
  const strays = nameFields.filter((n) => n.section === 'MENU' && !fields.some((f) => f.of === n.id && f.role === 'price'));
  for (const s of strays) {
    console.warn(`  skipped (no section, no price): ${JSON.stringify(s.display)} p${s.page} x=${s.x} y=${s.y}`);
    const drop = new Set([s.id, ...fields.filter((f) => f.of === s.id).map((f) => f.id)]);
    for (let i = fields.length - 1; i >= 0; i--) if (drop.has(fields[i].id)) fields.splice(i, 1);
    nameFields.splice(nameFields.indexOf(s), 1);
  }

  sections.length = 0;
  sections.push(...bands);

  // ---- font tables the engine needs to encode typed text ----
  const families = {};
  for (const [fam, info] of Object.entries(famInfo)) {
    const uni2cid = {};
    for (const [c, u] of Object.entries(info.cid2uni)) if (!(u in uni2cid)) uni2cid[u] = +c;
    families[fam] = { uni2cid, widths: info.widths, chars: info.chars };
  }
  const resToFam = {};
  for (const PI of pageInfo) for (const [res, F] of Object.entries(PI.P.fonts)) resToFam[`${PI.pi}${res}`] = F.fam;

  // ---- how far each marker type sits off the name's baseline, measured from the artwork ----
  const marker_dy = {};
  for (const t of MARKERS) {
    const ds = nameFields.flatMap((n) => (n.marker_boxes || []).filter((m) => m.type === t).map((m) => m.y - n.y));
    if (ds.length) { ds.sort((a, b) => a - b); marker_dy[t] = r2(ds[ds.length >> 1]); }
  }

  // ---- how much air the designer left around an icon, measured from the artwork ----
  // The engine spends this twice: once before the first icon and once between each pair. It was
  // a hard-coded 4.6 for the previous artwork, which set every re-stamped cluster ~2pt per gap
  // wider than the baked ones beside it — visible at print zoom, so measure it instead.
  const gaps = [];
  for (const n of nameFields) {
    const boxes = n.marker_boxes || [];
    for (let i = 1; i < boxes.length; i++) gaps.push(boxes[i].x - (boxes[i - 1].x + boxes[i - 1].w));
    const gram = fields.find((f) => f.of === n.id && f.role === 'gram');
    // the outlier here is a dish whose label does not butt up against its icons at all
    if (boxes.length && gram && gram.bbox && gram.bbox[2] < boxes[0].x) gaps.push(boxes[0].x - gram.bbox[2]);
  }
  gaps.sort((a, b) => a - b);
  const marker_gap = gaps.length ? r2(gaps[gaps.length >> 1]) : 2.4;

  // ---- columns: the reflow unit. Removing a dish rides everything below it in the SAME
  // column up by that dish's slot height, exactly as the other brands' editors do.
  const columns = [];
  for (const n of nameFields) {
    let c = columns.find((C) => C.page === n.page && C.section === n.section && Math.abs(C.x - n.x) < 9);
    if (!c) { c = { id: `c${columns.length}`, page: n.page, section: n.section, x: n.x, ids: [] }; columns.push(c); }
    c.ids.push(n.id);
    n.col = c.id;
  }
  const byId = Object.fromEntries(fields.map((f) => [f.id, f]));
  for (const c of columns) {
    c.ids.sort((a, b) => byId[b].y - byId[a].y);
    c.x = r2(Math.min(...c.ids.map((i) => byId[i].x)));
    c.ids.forEach((id, i) => {
      const me = byId[id];
      const next = i + 1 < c.ids.length ? byId[c.ids[i + 1]] : null;
      me.slot = next ? r2(me.y - next.y) : null;
    });
    const pitches = c.ids.map((id) => byId[id].slot).filter((v) => v);
    c.pitch = pitches.length ? r2(pitches.reduce((a, b) => a + b, 0) / pitches.length) : 50;
    // The last dish in a column has no neighbour to measure against, and the column's average
    // pitch alone is not enough: a dish whose own description runs longer than the column's
    // average (Sourdough Naan sets three lines where BREADS averages two) would have an added
    // dish land on top of its last line. Give it whichever is larger — the average, or its own
    // printed height plus the tightest name-to-last-line clearance the designer used here.
    const lastLineY = (id) => {
      const d = fields.find((f) => f.of === id && f.role === 'desc');
      return d && d.lines.length ? Math.min(...d.lines.map((L) => L.y)) : byId[id].y;
    };
    const clears = c.ids.slice(0, -1).map((id, i) => lastLineY(id) - byId[c.ids[i + 1]].y).filter((v) => v > 0);
    const clear = clears.length ? Math.min(...clears) : 17;
    for (const id of c.ids) {
      if (byId[id].slot) continue;
      byId[id].slot = r2(Math.max(c.pitch, byId[id].y - lastLineY(id) + clear));
    }
    c.bottom = r2(byId[c.ids[c.ids.length - 1]].y);
  }
  // how wide text may run in each column: up to the next column of the same band, else to the
  // band's right edge. Never narrower than the widest line the designer already set there.
  for (const c of columns) {
    const band = bands.find((b) => b.page === c.page && b.label === c.section);
    const right = columns
      .filter((o) => o.page === c.page && o.section === c.section && o.x > c.x + 20)
      .reduce((m, o) => Math.min(m, o.x), Infinity);
    // the band's rule may be broken over several columns; this column runs to the end of the
    // segment it actually sits under, not to the whole band's right edge
    const seg = band && band.spans.find((s) => c.x >= s[0] - 15 && c.x <= s[1]);
    const edge = right !== Infinity ? right - 12 : (seg ? seg[1] : (band ? band.x1 : 560));
    const baked = Math.max(0, ...c.ids.map((id) => {
      const d = fields.find((f) => f.of === id && f.role === 'desc');
      if (!d) return 0;
      return Math.max(...d.lines.map((L) => {
        const last = L.ops[L.ops.length - 1];
        return (last.x || L.x) + (last.text.length * d.size * 0.57);
      }));
    }));
    c.width = r2(Math.max(edge - c.x, baked - c.x + 4));
  }

  // ---- per-family average advance, used for the editors' character limits ----
  const advOf = (fam) => {
    const F = families[fam];
    const ws = Object.keys(F.uni2cid).filter((ch) => /[A-Za-z]/.test(ch)).map((ch) => F.widths[F.uni2cid[ch]] || 500);
    return r2(ws.reduce((a, b) => a + b, 0) / ws.length / 1000);
  };

  const fm = {
    brand: 'beshak',
    built: new Date().toISOString().slice(0, 10),
    page_sizes: pageInfo.map((p) => [r2(p.size.width), r2(p.size.height)]),
    streams,
    families,
    res_to_family: resToFam,
    allowed: {
      name: families[FAM.name].chars,
      desc: families[FAM.desc].chars,
      price: '0123456789',
      gram: families[FAM.name].chars,
    },
    icons,
    marker_order: MARKERS,
    marker_dy,
    marker_gap,
    brand_k: BRAND_K,
    sections,
    columns,
    adv: { name: advOf(FAM.name), desc: advOf(FAM.desc), price: advOf(FAM.name), gram: advOf(FAM.name) },
    fields,
  };
  const fmPath = path.join(outDir, 'fieldmap.json');
  fs.writeFileSync(fmPath, JSON.stringify(fm));
  return { pdfPath, fmPath, fm };
}

// The distiller writes one glyph per string with a kern between them (a tracking setting).
// Replacement text reuses the median so edited text keeps the baked tracking.
function medianKern(block) {
  const ks = [];
  for (const o of block.ops) {
    if (!o.parts) continue;
    for (const p of o.parts) if (p.kern !== undefined) ks.push(p.kern);
  }
  if (!ks.length) return 0;
  ks.sort((a, b) => a - b);
  return Math.round(ks[ks.length >> 1] * 10000) / 10000;
}

module.exports = { build, medianKern, detectMarkers, FAM, MARKERS };

if (require.main === module) {
  build().then(({ fm, pdfPath, fmPath }) => {
    console.log('wrote', pdfPath, fs.statSync(pdfPath).size, 'b |', fmPath, fs.statSync(fmPath).size, 'b');
    console.log('icons:', Object.entries(fm.icons).map(([k, v]) => `${k}(${v.source} ${r2(v.w / 10)}x${r2(v.h / 10)}pt)`).join(' '));
    console.log('sections:', fm.sections.map((s) => `${s.label}@p${s.page}`).join(' '));
    console.log('allowed.name:', JSON.stringify(fm.allowed.name));
    console.log('allowed.desc:', JSON.stringify(fm.allowed.desc));
    const names = fm.fields.filter((f) => f.role === 'name');
    console.log('dishes:', names.length);
    for (const n of names) {
      const kids = fm.fields.filter((f) => f.of === n.id);
      const d = kids.find((k) => k.role === 'desc'), p = kids.find((k) => k.role === 'price'), g = kids.find((k) => k.role === 'gram');
      const mk = (n.marker_boxes || []).map((m) => m.type).join(',');
      console.log(`  p${n.page} ${n.section.padEnd(7)} ${JSON.stringify(n.display).padEnd(26)} gm=${(g ? g.display : '-').padEnd(7)}` +
        ` ${(p ? p.display : '-').padEnd(4)} mk=[${mk.padEnd(22)}] desc(${d ? d.lines.length : 0})=${JSON.stringify(d ? d.display.slice(0, 46) : '')}`);
    }
  }).catch((e) => { console.error(e); process.exit(1); });
}
