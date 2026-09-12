// ===================== BESHAK — byte-level menu engine =====================
// Loads the real designed PDF, splices new text/markers into its content streams, and re-saves.
// Nothing here re-typesets the menu: an untouched session exports bytes identical to the source.
//
// Three things make Beshak different from the other brands, and they shape the whole file:
//  * Editable bytes live in Form XObjects, not page content streams, so pristine bytes are kept
//    per STREAM (`PRISTINE[id]`) and every field says which stream its spans index.
//  * Text is Identity-H — each glyph is a 2-byte CID inside its own tiny string in a kerned TJ
//    array — so writing text means re-encoding through the font's unicode->CID table.
//  * On page 2 the dairy/gluten/sesame markers are baked into the background raster. Removing one
//    means painting its (pure white) box out; anything still wanted is re-stamped as a vector.

const { PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef } = PDFLib;

let FM = null;                 // fieldmap.json
let pdfDoc = null;             // pdf-lib document
let pdfBytesOrig = null;       // the pristine file, for version fingerprinting
const PRISTINE = {};           // streamId -> original bytes as a latin1 string
const STREAM_REF = {};         // streamId -> PDFRef
const STREAM_DICT = {};        // streamId -> PDFDict

// ---- edit state (this, and only this, is what Publish and edit-memory persist) ----
const edits = {};              // fieldId -> new text
let removed = [];              // name-field ids that are hidden
let added = [];                // {col, name, desc, price, gram, markers}
let markerEdits = {};          // name-field id -> array of marker types

const ART = 10;                // artwork units per point (the page draws its XObject at 0.1)
const byId = {};               // fieldId -> field
const kidsOf = {};             // name id -> {desc, price, gram}

// ============================================================ small utilities
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const r2 = (v) => Math.round(v * 100) / 100;

/** Escape raw bytes (held as latin1 chars) into a PDF literal string body. */
function escPdf(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const ch = bytes[i], c = bytes.charCodeAt(i);
    if (ch === '(' || ch === ')' || ch === '\\') out += '\\' + ch;
    else if (c === 13) out += '\\r';
    else if (c === 10) out += '\\n';
    else if (c < 32 || c === 127) out += '\\' + c.toString(8).padStart(3, '0');
    else out += ch;
  }
  return out;
}

/**
 * Apply byte-span replacements to a stream. Ops are applied right-to-left so earlier spans keep
 * their offsets; overlapping ops are dropped rather than silently corrupting the stream.
 */
function applyOps(text, ops) {
  const sorted = ops.slice().sort((a, b) => b.s - a.s);
  let out = text, guard = Infinity;
  for (const o of sorted) {
    if (o.e > guard) continue;
    out = out.slice(0, o.s) + o.t + out.slice(o.e);
    guard = o.s;
  }
  return out;
}

// ---- font access -------------------------------------------------------------
const famOf = (f) => FM.res_to_family[f.page + f.font];
const familyOf = (f) => FM.families[famOf(f)];

/** Text -> CIDs, or null if the menu's font has no glyph for some character. */
function toCids(text, fam) {
  const F = FM.families[fam];
  const out = [];
  for (const ch of text) {
    const c = F.uni2cid[ch];
    if (c === undefined) return null;
    out.push(c);
  }
  return out;
}
/** Characters this font cannot set — surfaced in the UI rather than silently dropped. */
function missingChars(text, fam) {
  const F = FM.families[fam];
  const bad = [];
  for (const ch of text) if (F.uni2cid[ch] === undefined && !bad.includes(ch)) bad.push(ch);
  return bad;
}

/** One show-op: every glyph its own string, separated by the field's baked tracking. */
function showOp(cids, kern) {
  if (!cids || !cids.length) return '';
  const parts = cids.map((c) => '(' + escPdf(String.fromCharCode(c >> 8) + String.fromCharCode(c & 255)) + ')');
  return '[' + parts.join(String(kern || 0)) + ']TJ';
}

function textWidth(text, fam, size, kern) {
  const F = FM.families[fam];
  let w = 0, n = 0;
  for (const ch of text) {
    const c = F.uni2cid[ch];
    w += (c !== undefined && F.widths[c] !== undefined) ? F.widths[c] : 500;
    n++;
  }
  // TJ kerns tighten the run by kern/1000 em per gap
  return (w / 1000) * size - Math.max(0, n - 1) * ((kern || 0) / 1000) * size;
}

/** Greedy word wrap to a pixel width, capped at maxLines (the last line keeps the overflow). */
function wrapText(text, fam, size, width, maxLines, kern) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? cur + ' ' + w : w;
    if (cur && textWidth(next, fam, size, kern) > width) { lines.push(cur); cur = w; }
    else cur = next;
    if (lines.length >= maxLines) break;
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  return lines;
}

const maxCharsFor = (width, size, role) => Math.max(4, Math.floor(width / (size * (FM.adv[role] || 0.5))));

// ============================================================ geometry helpers
const colOf = (nameField) => FM.columns.find((c) => c.id === nameField.col);

/** Live x where a name ends, honouring an edit that made it longer or shorter. */
function nameRight(f) {
  const t = edits[f.id] !== undefined ? edits[f.id] : f.display;
  return r2(f.x + textWidth(t, famOf(f), f.size, f.kern));
}

/**
 * How far the trailing cluster (gm label + markers) has to slide because the name changed
 * length. The designer set the GAP between the name and that cluster, so keeping the gap — not
 * the absolute position — is what stops a longer name from running into its own icons.
 *
 * This measures the edit against the baked text with the SAME width function, rather than
 * against the stored `right`: a name split into several show-ops does not measure identically
 * either way, and an unedited dish must come out at exactly zero or its markers would be
 * needlessly re-stamped and the export would stop being byte-identical.
 */
function clusterShift(f) {
  if (edits[f.id] === undefined) return 0;
  const fam = famOf(f);
  return r2(textWidth(edits[f.id], fam, f.size, f.kern) - textWidth(f.display, fam, f.size, f.kern));
}

/** Marker slots for a dish, left to right, after any name-length change and reflow. */
function markerSlots(f, types, dx, dy) {
  const k = kidsOf[f.id] || {};
  const baked = (f.marker_boxes || []);
  let x;
  if (baked.length) x = baked[0].x + dx;
  else if (k.gram && k.gram.bbox[0] > f.x) x = k.gram.bbox[2] + dx + FM.marker_gap;
  else x = nameRight(f) + FM.marker_gap;
  const out = [];
  for (const t of FM.marker_order) {
    if (!types.includes(t)) continue;
    const ic = FM.icons[t];
    out.push({ type: t, x: r2(x), y: r2(f.y + (FM.marker_dy[t] || -1) + dy) });
    x += ic.w / ART + FM.marker_gap;
  }
  return out;
}

/** PDF ops that paint one marker at a point, in artwork units. */
function stampMarker(type, x, y) {
  const ic = FM.icons[type];
  const sc = ic.scale && ic.scale !== 1 ? ` ${ic.scale} 0 0 ${ic.scale} 0 0 cm` : '';
  return `q 1 0 0 1 ${r2(x * ART)} ${r2(y * ART)} cm${sc} ${FM.brand_k}\n${ic.body}\nf Q\n`;
}

/**
 * Paint out a box in paper white. This is how a marker that is part of page 2's background
 * raster gets removed — the artwork behind every marker slot is flat white, so a filled box is
 * invisible. `0 0 0 0 k` keeps the file in the CMYK space the rest of the artwork uses.
 */
function patchBox(b, bleed) {
  const m = bleed === undefined ? 0.45 : bleed;
  return `q 0 0 0 0 k ${r2((b.x - m) * ART)} ${r2((b.y - m) * ART)} ${r2((b.w + 2 * m) * ART)} ${r2((b.h + 2 * m) * ART)} re f Q\n`;
}

// ============================================================ regenerate
/**
 * Rebuild the PDF from the pristine bytes plus the current edit state.
 * With no edits every stream is written back unchanged, so the export is byte-identical.
 */
async function regenerate() {
  const ops = {};                       // streamId -> [{s,e,t}]
  const tail = {};                      // streamId -> appended ops (stamps, patches, new text)
  const push = (sid, s, e, t) => { (ops[sid] = ops[sid] || []).push({ s, e, t }); };
  const append = (sid, t) => { tail[sid] = (tail[sid] || '') + t; };

  // ---- reflow: everything below a removed dish rides up by that dish's slot ----
  const shift = {};
  for (const c of FM.columns) {
    let dy = 0;
    for (const id of c.ids) {
      if (removed.includes(id)) { dy += byId[id].slot || c.pitch; continue; }
      shift[id] = dy;
    }
  }

  for (const f of FM.fields) {
    if (f.role !== 'name') continue;
    const gone = removed.includes(f.id);
    // PDF y grows upward, so riding up into a removed dish's slot means ADDING its height
    const dy = gone ? 0 : (shift[f.id] || 0);
    const k = kidsOf[f.id] || {};
    const dx = gone ? 0 : clusterShift(f);

    // -------- text --------
    for (const fld of [f, k.desc, k.price, k.gram].filter(Boolean)) {
      if (gone) {                                   // hide: drop every show-op it owns
        if (fld.role === 'gram') { if (fld.do_span) push(f.stream, fld.do_span[0], fld.do_span[1], ''); continue; }
        for (const o of fld.ops || []) push(fld.stream, o.span[0], o.span[1], '');
        for (const L of fld.lines || []) for (const o of L.ops) push(fld.stream, o.span[0], o.span[1], '');
        continue;
      }
      writeField(fld, f, dx, dy, push, append);
    }

    // -------- markers --------
    const want = gone ? [] : (markerEdits[f.id] || f.markers || []);
    const baked = f.marker_boxes || [];
    const bakedTypes = baked.map((m) => m.type);
    const moved = dx !== 0 || dy !== 0;
    const changed = moved || want.length !== bakedTypes.length || want.some((t) => !bakedTypes.includes(t));
    if (!changed) continue;                          // untouched dish: leave its bytes alone

    for (const m of baked) {
      if (m.span) push(f.stream, m.span[0], m.span[1], '');   // a vector marker: delete it
      else append(f.stream, patchBox(m));                     // baked into the raster: paint it out
    }
    for (const s of markerSlots(f, want, dx, dy)) append(f.stream, stampMarker(s.type, s.x, s.y));
  }

  // ---- added dishes ----
  for (const a of added) {
    const c = FM.columns.find((x) => x.id === a.col);
    if (!c) continue;
    append('p' + c.page, addedDishOps(a, c));
  }

  // ---- write every stream back ----
  for (const sid of Object.keys(PRISTINE)) {
    let text = PRISTINE[sid];
    if (ops[sid] && ops[sid].length) text = applyOps(text, ops[sid]);
    if (tail[sid]) text = text + '\n' + tail[sid];
    setStream(sid, text);
  }
  return pdfDoc.save({ useObjectStreams: false });
}

/** Write one field's current text back into its baked spans (and move it if reflow says so). */
function writeField(fld, name, dx, dy, push, append) {
  const fam = famOf(fld);
  const val = edits[fld.id] !== undefined ? edits[fld.id] : null;

  // reflow / cluster movement: rewrite the Tm origin of every block the field occupies
  if (dy !== 0 || (dx !== 0 && (fld.role === 'gram'))) {
    if (fld.role === 'gram') {
      // a label XObject is placed by its own BBox, so it can only be moved at the call site
      if (fld.do_span) {
        const inner = PRISTINE[name.stream].slice(fld.do_span[0], fld.do_span[1]);
        push(name.stream, fld.do_span[0], fld.do_span[1],
          `q 1 0 0 1 ${r2(dx * ART)} ${r2(dy * ART)} cm ${inner} Q`);
      }
    } else {
      for (const b of fld.blocks || []) {
        const tm = b.tm.slice();
        push(fld.stream, b.tm_span[0], b.tm_span[1], `${tm[0]} ${tm[1]} ${tm[2]} ${tm[3]} ${r2(tm[4])} ${r2(tm[5] + dy)}`);
      }
    }
  }

  if (val === null) return;                          // not edited: leave the baked glyphs alone

  if (fld.role === 'desc') {
    const c = colOf(name) || { width: 240 };
    const lines = wrapText(val, fam, fld.size, c.width, fld.lines.length + extraLines(name, fld), fld.kern);
    fld.lines.forEach((L, i) => {
      const text = lines[i] || '';
      const cids = text ? toCids(text, fam) : [];
      L.ops.forEach((o, j) => push(fld.stream, o.span[0], o.span[1], j === 0 ? showOp(cids, fld.kern) : ''));
    });
    // any line the baked text did not have gets appended as its own text block
    for (let i = fld.lines.length; i < lines.length; i++) {
      const cids = toCids(lines[i], fam);
      if (!cids) continue;
      const y = fld.lines[fld.lines.length - 1].y + dy - fld.pitch * (i - fld.lines.length + 1);
      append(fld.stream, textBlock(fld.font, fld.size, fld.x + 0, y, showOp(cids, fld.kern)));
    }
    return;
  }

  const cids = toCids(val, fam);
  if (!cids) return;                                 // unprintable character: keep what was there
  (fld.ops || []).forEach((o, i) => push(fld.stream, o.span[0], o.span[1], i === 0 ? showOp(cids, fld.kern) : ''));
}

/** How many extra description lines will fit before running into the dish below. */
function extraLines(name, desc) {
  const c = colOf(name);
  if (!c) return 0;
  const i = c.ids.indexOf(name.id);
  const next = i >= 0 && i + 1 < c.ids.length ? byId[c.ids[i + 1]] : null;
  const bottom = desc.lines[desc.lines.length - 1].y;
  const floor = next ? next.y + 12 : 30;
  return Math.max(0, Math.floor((bottom - floor) / desc.pitch));
}

/** An absolute text block in the artwork's coordinate space. */
function textBlock(fontRes, size, x, y, show) {
  return `q\n10 0 0 10 0 0 cm BT\n${fontRes} ${size} Tf\n1 0 0 1 ${r2(x)} ${r2(y)} Tm\n${show}\nET\nQ\n`;
}

/** Ops for a dish the user added at the bottom of a column. */
function addedDishOps(a, c) {
  const last = byId[c.ids[c.ids.length - 1]];
  const liveIds = c.ids.filter((id) => !removed.includes(id));
  const bottomId = liveIds.length ? liveIds[liveIds.length - 1] : null;
  const bottom = bottomId ? byId[bottomId] : last;
  const bDesc = (kidsOf[bottom.id] || {}).desc;
  const dy = -(bottom.slot || c.pitch) * (a.index || 1);
  const y = r2(bottom.y + dy);
  const fam = { name: FM.res_to_family[c.page + last.font], desc: bDesc ? famOf(bDesc) : FM.families.desc };
  let out = '';

  const nCids = toCids(a.name || '', fam.name);
  if (nCids) out += textBlock(last.font, last.size, c.x, y, showOp(nCids, last.kern));

  const price = (kidsOf[bottom.id] || {}).price;
  if (a.price && price) {
    const pc = toCids(String(a.price), famOf(price));
    if (pc) out += textBlock(price.font, price.size, price.x, y + (price.y - bottom.y), showOp(pc, price.kern));
  }
  if (a.desc && bDesc) {
    const lines = wrapText(a.desc, famOf(bDesc), bDesc.size, c.width, 4, bDesc.kern);
    lines.forEach((t, i) => {
      const cs = toCids(t, famOf(bDesc));
      if (cs) out += textBlock(bDesc.font, bDesc.size, c.x, y - (bottom.y - bDesc.y) - i * bDesc.pitch, showOp(cs, bDesc.kern));
    });
  }
  const gram = (kidsOf[bottom.id] || {}).gram;
  if (a.gram && gram) {
    const gc = toCids(String(a.gram), famOf(gram));
    const gx = c.x + textWidth(a.name || '', fam.name, last.size, last.kern) + FM.marker_gap;
    if (gc) out += textBlock(gram.font, gram.size, gx, y + (gram.y - bottom.y), showOp(gc, gram.kern));
  }
  let mx = c.x + textWidth(a.name || '', fam.name, last.size, last.kern) + FM.marker_gap
    + (a.gram ? textWidth(String(a.gram), fam.name, 8, 0) + FM.marker_gap : 0);
  for (const t of FM.marker_order) {
    if (!(a.markers || []).includes(t)) continue;
    out += stampMarker(t, mx, y + (FM.marker_dy[t] || -1));
    mx += FM.icons[t].w / ART + FM.marker_gap;
  }
  return out;
}

// ============================================================ stream plumbing
function setStream(sid, text) {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  const dict = STREAM_DICT[sid];
  dict.delete(PDFName.of('Filter'));
  dict.delete(PDFName.of('DecodeParms'));
  dict.set(PDFName.of('Length'), PDFNumber.of(bytes.length));
  pdfDoc.context.assign(STREAM_REF[sid], PDFRawStream.of(dict, bytes));
}

function loadStreams() {
  for (const [sid, info] of Object.entries(FM.streams)) {
    const [num, gen] = info.ref.split(' ').map(Number);
    const ref = PDFRef.of(num, gen);
    const obj = pdfDoc.context.lookup(ref);
    STREAM_REF[sid] = ref;
    STREAM_DICT[sid] = obj.dict;
    let s = '';
    const b = obj.contents;
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    PRISTINE[sid] = s;
  }
}

// Exported only when this file is required directly by a test; in the browser `module` is
// absent and the engine simply lives on the page.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { regenerate, applyOps, showOp, toCids, wrapText, textWidth, markerSlots, stampMarker, patchBox };
}
