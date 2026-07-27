#!/usr/bin/env python3
"""Augment a built Capiche-drinks fieldmap with VOLUME data so the editor can edit the
drink volume ([300ML]) like it edits the price.

Why this script exists: build.py's tokenizer only matches plain `(text)Tj`, but the volume
is a KERNED `[..]TJ` array, so group.py's volume regex never fires and `vol_span` is null on
every item. reflow_data.py *does* capture the run geometrically (by its own size-5 Tm) — it
just files it into `extra_spans` without decoding it. This script promotes it.

Adds, per drink item:
  it['vol_span']  = [start, end]        # byte span of `5 0 0 5 x y Tm\n[..]TJ`
  it['vol']       = '300'               # the editable number
  it['vol_pre']   = '['                 # literal prefix to re-emit
  it['vol_suf']   = 'ML]'               # literal suffix (case is per-item: one drink is `ml`)
  it['vol_pos']   = {'x':.., 'y':.., 'size':5.0}
  it['vol_gap']   = 4.54                # measured x gap from the end of the desc's last line.
                                        # Self-calibrating: some drinks separate desc and volume
                                        # with an explicit `( )Tj` run, others rely on a trailing
                                        # space inside the desc text itself.
  it['desc_geom'] = {th,size,x0,y0,tc,tw,lead}   # so the engine can re-place the volume

The span is deliberately LEFT IN extra_spans, following the dairy precedent in marker_data.py:
drink REMOVAL still deletes the volume bytes through the existing extra_spans loop, and
vol_span is used only for the EDIT path (which skips removed drinks).

The PDF is never re-saved, so every existing byte offset stays valid.

Usage: vol_data.py <public/<editor>>   (dir holding fieldmap.json + menu.pdf)
"""
import sys, json, re, pikepdf

DIR = sys.argv[1].rstrip('/')
ADV = 0.630          # AOMono advance (em) — /Widths is [0, 630] for T1_0 and T1_1

fm = json.load(open(f'{DIR}/fieldmap.json'))
pdf = pikepdf.open(f'{DIR}/menu.pdf')

VOL_RE  = re.compile(r'^5 0 0 5 (-?[\d.]+) (-?[\d.]+) Tm')
LIT_RE  = re.compile(r'\(((?:[^()\\]|\\.)*)\)')
TM_RE   = re.compile(r'([\d.]+) 0 0 ([\d.]+) (-?[\d.]+) (-?[\d.]+) Tm')
TD_RE   = re.compile(r'(-?[\d.]+) (-?[\d.]+) Td')
TC_RE   = re.compile(r'(-?[\d.]+) Tc')
TW_RE   = re.compile(r'(-?[\d.]+) Tw')


def unesc(s):
    return re.sub(r'\\([()\\])', r'\1', s)


def span_text(raw, sp):
    """Decode a text-showing span to its plain string (handles both `(..)Tj` and `[..]TJ`)."""
    return ''.join(unesc(m.group(1)) for m in LIT_RE.finditer(raw[sp[0]:sp[1]]))


def advance(text, th, tc, tw):
    """Width of `text` in PDF units. AOMono is monospace, so every glyph advances 0.63 em.
    Tc applies per character and Tw per space, both scaled by the horizontal text scale."""
    return len(text) * (ADV * th + tc * th) + text.count(' ') * tw * th


GS_RE = re.compile(
    r'(?:(?<=[\s\n])|^)(q|Q)(?=[\s\n]|$)'      # 1: gstate push/pop
    r'|/(CS\d+) cs'                             # 2: colour space
    r'|((?:-?[\d.]+\s+)+)(scn|rg|g|k)(?=[\s\n])')  # 3,4: fill colour


def colour_at(raw, off):
    """Fill colour in effect at byte `off`, as a ready-to-emit operator string.

    Must honour q/Q nesting: a colour set inside a `q .. Q` block is restored on Q, so simply
    taking the last colour operator before `off` picks up marker red and badge fills that were
    never actually in effect there. `scn` also needs its colour space re-selected, so it is
    paired with the `cs` that was live at the same point.
    """
    cs, col, stack = None, None, []
    for m in GS_RE.finditer(raw, 0, off):
        if m.group(1) == 'q':
            stack.append((cs, col))
        elif m.group(1) == 'Q':
            if stack:
                cs, col = stack.pop()
        elif m.group(2):
            cs = m.group(2)
        else:
            col = (m.group(3).strip(), m.group(4))
    if not col:
        return '0 0 0 rg'
    ops, kind = col
    if kind == 'scn':
        return f'/{cs} cs {ops} scn' if cs else '0 0 0 rg'
    return f'{ops} {kind}'


def desc_geom(raw, it):
    """Parse the baked description block: h-scale, size, origin, spacing, line leading."""
    spans = it.get('desc_spans') or []
    if not spans:
        return None
    bt = raw.rfind('BT', 0, spans[0][0])
    if bt < 0:
        return None
    head = raw[bt:spans[0][0]]
    m = TM_RE.search(head)
    if not m:
        return None
    th, size, x0, y0 = (float(m.group(1)), float(m.group(2)),
                        float(m.group(3)), float(m.group(4)))
    lead = -1.2
    if len(spans) >= 2:
        t = re.search(r'0 (-?[\d.]+) Td', raw[spans[0][1]:spans[1][0]])
        if t:
            lead = float(t.group(1))
    # Tc/Tw in effect at the START of the last line (they can be reset between lines)
    upto = raw[bt:spans[-1][0]]
    tcs, tws = TC_RE.findall(upto), TW_RE.findall(upto)
    tc = float(tcs[-1]) if tcs else 0.0
    tw = float(tws[-1]) if tws else 0.0
    # any horizontal Td displacement accumulated before the last line
    dx = sum(float(a) for a, b in TD_RE.findall(upto)) * th
    return {'th': round(th, 4), 'size': round(size, 4), 'x0': round(x0, 4),
            'y0': round(y0, 4), 'tc': tc, 'tw': tw, 'lead': lead, 'dx': round(dx, 4)}


rows, bad, n_vol = [], [], 0
for pg in fm['pages']:
    raw = bytes(pdf.pages[pg['page']].Contents.read_bytes()).decode('latin-1')
    for idx, it in enumerate(pg['items']):
        hits = [sp for sp in it.get('extra_spans', []) if raw[sp[0]:sp[0] + 8] == '5 0 0 5 ']
        if len(hits) != 1:
            bad.append(f"p{pg['page']} item{idx} {it.get('name')!r}: {len(hits)} volume spans")
            it['vol_span'] = None
            continue
        sp = hits[0]
        body = raw[sp[0]:sp[1]]
        m = VOL_RE.match(body)
        if not m:
            bad.append(f"p{pg['page']} item{idx} {it.get('name')!r}: no size-5 Tm")
            it['vol_span'] = None
            continue
        vx, vy = float(m.group(1)), float(m.group(2))
        txt = span_text(raw, sp)                      # e.g. '[300ML]'
        d = re.search(r'\d+', txt)
        if not d:
            bad.append(f"p{pg['page']} item{idx} {it.get('name')!r}: no digits in {txt!r}")
            it['vol_span'] = None
            continue
        it['vol_span'] = sp
        it['vol'] = d.group(0)
        it['vol_pre'] = txt[:d.start()]
        it['vol_suf'] = txt[d.end():]
        it['vol_raw'] = txt
        it['vol_pos'] = {'x': round(vx, 4), 'y': round(vy, 4), 'size': 5.0}
        # Fill colour in effect where the volume is drawn. It sits INSIDE the description's
        # BT..ET block, so it inherits that block's colour rather than setting its own. The
        # RMSB fallback stamp (for digits missing from the subset font) must re-state it, since
        # the stamp is appended at the end of the stream where that state is long gone.
        it['vol_color'] = colour_at(raw, sp[0])
        n_vol += 1

        g = desc_geom(raw, it)
        it['desc_geom'] = g
        if g:
            last = span_text(raw, it['desc_spans'][-1])
            pred_x = g['x0'] + g['dx'] + advance(last, g['th'], g['tc'], g['tw'])
            n_lines = len(it['desc_spans'])
            pred_y = g['y0'] + g['lead'] * g['size'] * (n_lines - 1)
            it['vol_gap'] = round(vx - pred_x, 4)
            rows.append((pg['page'], idx, it.get('name'), txt, round(vx - pred_x, 2),
                         round(vy - pred_y, 3), last))
        else:
            it['vol_gap'] = None

json.dump(fm, open(f'{DIR}/fieldmap.json', 'w'))

print(f"[{DIR}] volume spans: {n_vol}")
if bad:
    print('  UNRESOLVED:')
    for b in bad:
        print('   ', b)
print(f"  {'pg':>2} {'#':>2}  {'drink':<22} {'vol':<9} {'xgap':>7} {'yerr':>7}  last desc line")
for p, i, nm, txt, xg, ye, last in rows:
    flag = '  <-- Y MISMATCH' if abs(ye) > 0.5 else ''
    print(f"  {p:>2} {i:>2}  {(nm or '')[:22]:<22} {txt:<9} {xg:>7} {ye:>7}  {last!r}{flag}")
