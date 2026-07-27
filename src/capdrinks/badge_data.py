#!/usr/bin/env python3
"""Add NEW-badge + SPECIALS-bar toggle data to the Capiche drinks fieldmaps, in place.

Usage: badge_data.py <ahm_dir> <surat_dir> [--write]      (dry run unless --write)

The first directory is the BADGE DONOR: only capiche-ahm has baked starburst art, so its bytes
become the reusable `micons.newbadge` program written into BOTH fieldmaps.

WHY THE "BADGE SPAN" IS NOT THE extra_spans ENTRY
-------------------------------------------------
Illustrator packed each badge, the two row-divider rules, AND that drink's SPECIALS bar into one
full-page-clip group. reflow_data.py captures the whole group, which is right for drink REMOVAL
(delete everything) but catastrophic for a badge TOGGLE (it would take the dividers and the bar
with it). So we record a second, INNER span covering only the art:

    [5710,5745)  q / 0 595.276 280.63 -595.276 re / W n      <- clip open      (keep)
    [5745,6849)  [optional colour op] starburst + N + E + W  <- badge_span     (toggle)
    [6849,6949)  the two row-divider rects                   <- keep
    [6949,6999)  SPECIALS bar                                <- specials_span  (toggle)
    [6998,7000)  Q                                           <- clip close     (keep)

CRITICAL: badge_span must START BEFORE the optional colour operator, not after it. Badges 2 and 3
carry `0 0.993 1 0  scn` (red) just inside the clip; leave that behind and the row dividers inherit
red. Starting the span at the colour op means the engine's keepState() sees the span through to the
white `0 0 0 0 scn` that follows the letters and re-emits THAT, so the dividers stay white. Verified
against the shipped keepState: all three inner ranges return "0 0 0 0  scn\n".

extra_spans is left completely untouched -- that is what keeps removal behaving exactly as today.
"""
import pikepdf, re, json, sys, os, shutil, time

# --- geometry constants, all measured from the baked art (see the gate assertions below) ---
SPEC_H          = 8.177     # bar height, constant in both editors
SPEC_TEXT_DY    = 2.13      # text baseline above the bar's bottom edge
SPEC_TEXT_SIZE  = 5
SPEC_TEXT_TC    = 0.025
SPEC_TEXT_TW    = -0.025
SPEC_TEXT_ADV   = 0.63      # AOMonoBold /Widths are all 630/1000
OWNER_TOL       = 24.0      # nearest-top_y agreement check (same as fix_extras.MAX_OWNER_DIST)
TILE_TOL        = 0.1       # bar y vs photo_tile[1]; max observed error is 0.039

CLIP  = re.compile(r'q\s*\n0 [\d.]+ [\d.]+ -[\d.]+ re\s*\nW n\s*\n')   # stops BEFORE any colour op
BADGE = re.compile(r'q\s*\n0 [\d.]+ [\d.]+ -[\d.]+ re\s*\nW n\s*\n'
                   r'(?:[\d.]+ [\d.]+ [\d.]+ [\d.]+\s+scn\s*\n)?'
                   r'q 1 0 0 1 (-?[\d.]+) (-?[\d.]+) cm\n0 0 m\n-1\.')
BAR   = re.compile(r'([\d.]+ [\d.]+ [\d.]+ [\d.]+)\s+scn\s*\n'
                   r'([\d.]+) (-?[\d.]+) ([\d.]+) 8\.177 re\s*\nf')
BARTX = re.compile(r'BT[\s\S]{0,160}?\(SPECIALS\)Tj[\s\S]{0,30}?ET')
CM    = re.compile(r'1 0 0 1 (-?[\d.]+) (-?[\d.]+) cm')


def qend(t, st):
    """End offset (exclusive) of the balanced q...Q group starting at st."""
    d = 0; i = st; n = len(t)
    while i < n:
        c = t[i]
        if c == 'q' and (i == 0 or t[i-1] in ' \n') and i+1 < n and t[i+1] in ' \n':
            d += 1
        elif c == 'Q' and (i == 0 or t[i-1] in ' \n') and (i+1 >= n or t[i+1] in ' \n'):
            d -= 1
            if d == 0:
                return i+1
        i += 1
    return st


def find_badges(raw):
    """[{group, inner, origin:(x,y), parts:[(dx,dy,bytes)]}] for every baked starburst."""
    out = []
    for m in BADGE.finditer(raw):
        group = [m.start(), qend(raw, m.start())]
        inner = CLIP.match(raw, m.start()).end()          # BEFORE the optional colour op
        e = inner; parts = []
        for _ in range(4):
            k = raw.index('q 1 0 0 1 ', e)
            e = qend(raw, k)
            cm = CM.search(raw, k, k+64)
            parts.append((float(cm.group(1)), float(cm.group(2)), raw[k:e]))
        if e < len(raw) and raw[e] == '\n':
            e += 1
        ox, oy = parts[0][0], parts[0][1]
        out.append({'group': group, 'inner': [inner, e], 'origin': (ox, oy),
                    'parts': [(round(p[0]-ox, 4), round(p[1]-oy, 4), p[2]) for p in parts]})
    return out


def find_bars(raw):
    """[{span, text_span, geom:[x,y,w,h], text_pos:[x,y], color}] for every SPECIALS bar."""
    out = []
    for m in BAR.finditer(raw):
        e = m.end()
        t = BARTX.search(raw[e:e+420])
        if not t:
            continue
        tb = raw[e+t.start():e+t.end()]
        tm = re.search(r'([\d.]+) 0 0 [\d.]+ (-?[\d.]+) (-?[\d.]+) Tm', tb)
        out.append({'span': [m.start(), e], 'text_span': [e+t.start(), e+t.end()],
                    'geom': [float(m.group(2)), float(m.group(3)), float(m.group(4)), SPEC_H],
                    'text_pos': [float(tm.group(2)), float(tm.group(3))],
                    'color': m.group(1)})
    return out


def path_width(body):
    """Horizontal extent of a path program (same idea as the engine's iconW)."""
    ns = [float(x) for x in re.findall(r'-?[\d.]+', body.split('cm', 1)[1])]
    xs = ns[0::2]
    return max(xs) - min(xs) if xs else 0.0


def load(d):
    fm = json.load(open(f'{d}/fieldmap.json'))
    pdf = pikepdf.open(f'{d}/{fm.get("pdf","menu.pdf")}')
    raws = {p['page']: bytes(pdf.pages[p['page']].Contents.read_bytes()).decode('latin-1')
            for p in fm['pages']}
    return fm, raws


def annotate(d, label, donor_parts):
    """Returns (fm, newbadge_parts_or_None, report_lines). Mutates fm in memory only."""
    fm, raws = load(d)
    rep = []
    before = {id(it): list(it.get('extra_spans', [])) for p in fm['pages'] for it in p['items']}
    nb = None
    n_badge = n_bar = 0

    for pg in fm['pages']:
        raw = raws[pg['page']]
        items = pg['items']
        badges, bars = find_badges(raw), find_bars(raw)

        for it in items:
            it.setdefault('badge', False)
            it.setdefault('specials', False)

        for b in badges:
            # ownership by CONTAINMENT in the group entry reflow_data/fix_extras already assigned
            own = [i for i, it in enumerate(items)
                   if any(sp[0] <= b['group'][0] and sp[1] >= b['group'][1]
                          for sp in it.get('extra_spans', []))]
            assert len(own) == 1, f'{label} p{pg["page"]} badge {b["group"]}: {len(own)} owners'
            i = own[0]; it = items[i]
            # cross-check against the geometric rule
            tops = [(abs(x['top_y'] - b['origin'][1]), j)
                    for j, x in enumerate(items) if x.get('top_y') is not None]
            dist, near = min(tops)
            assert near == i and dist < OWNER_TOL, \
                f'{label} badge {b["group"]}: containment says {i}, nearest top_y says {near} ({dist:.1f}pt)'
            it['badge'] = True
            it['badge_span'] = b['inner']
            it['badge_pos'] = [round(b['origin'][0] - path_width(b['parts'][0][2]), 4),
                               round(b['origin'][1], 4)]
            n_badge += 1
            rep.append(f"  p{pg['page']} BADGE  inner={b['inner']} group={b['group']} "
                       f"-> [{i}] {it['name']!r}  left={it['badge_pos'][0]}")
            if nb is None:
                nb = b['parts']

        for s in bars:
            cand = [(abs(x['photo_tile'][1] - s['geom'][1]), j)
                    for j, x in enumerate(items) if x.get('photo_tile')]
            assert cand, f'{label} p{pg["page"]} bar {s["span"]}: no photo tiles'
            dist, i = min(cand)
            assert dist < TILE_TOL, f'{label} bar {s["span"]}: nearest tile {dist:.3f}pt away'
            it = items[i]
            it['specials'] = True
            it['specials_span'] = s['span']
            it['specials_text_span'] = s['text_span']
            it['specials_geom'] = [round(v, 4) for v in s['geom']]
            it['specials_text_pos'] = [round(v, 4) for v in s['text_pos']]
            n_bar += 1
            rep.append(f"  p{pg['page']} SPECS  bar={s['span']} text={s['text_span']} "
                       f"-> [{i}] {it['name']!r}  y={s['geom'][1]} (tile {it['photo_tile'][1]})")

    # ---- gate 1: extra_spans untouched ----
    for p in fm['pages']:
        for it in p['items']:
            assert before[id(it)] == list(it.get('extra_spans', [])), \
                f'{label}: extra_spans mutated on {it["name"]!r}'

    # ---- gate 2: the derived right-align formula reproduces the baked text x ----
    adv = 8*(SPEC_TEXT_ADV*SPEC_TEXT_SIZE + SPEC_TEXT_TC)
    pads = []
    for p in fm['pages']:
        for it in p['items']:
            if not it.get('specials'):
                continue
            g, t = it['specials_geom'], it['specials_text_pos']
            pads.append(round(g[0]+g[2]-adv-t[0], 4))
            assert abs(t[1] - (g[1]+SPEC_TEXT_DY)) < 0.01, f'{label}: text dy off on {it["name"]!r}'
    pad = round(sum(pads)/len(pads), 4) if pads else 3.149
    assert not pads or max(pads)-min(pads) < 0.01, f'{label}: inconsistent right pad {pads}'

    # ---- write the globals ----
    parts = nb or donor_parts
    if parts:
        col = (fm.get('jmark', {}).get('color') or '0 0 0 1') + ' k'
        fm.setdefault('micons', {})['newbadge'] = [
            {'bytes': CM.sub('1 0 0 1 0 0 cm', p[2], count=1),
             'dx': p[0], 'dy': p[1],
             'color': col if k == 0 else '0 0 0 0 k'}
            for k, p in enumerate(parts)]
    mk = fm.setdefault('mk_const', {})
    mk['w_j'] = 0.63
    mk['dy_badge'] = 8.54
    mk['gap_badge'] = 3.23
    mk['spec'] = {'h': SPEC_H, 'text_dy': SPEC_TEXT_DY, 'text_size': SPEC_TEXT_SIZE,
                  'text_tc': SPEC_TEXT_TC, 'text_tw': SPEC_TEXT_TW,
                  'text_adv': SPEC_TEXT_ADV, 'text_right_pad': pad}

    rep.append(f'  totals: {n_badge} badges, {n_bar} bars; right_pad={pad}')
    return fm, (nb or None), rep


def main():
    if len(sys.argv) < 3:
        print(__doc__); sys.exit(1)
    ahm, surat = sys.argv[1].rstrip('/'), sys.argv[2].rstrip('/')
    write = '--write' in sys.argv
    results = []
    donor = None
    for d, exp_badge, exp_bar in ((ahm, 3, 3), (surat, 0, 2)):
        label = os.path.basename(d)
        print(f'=== {label} ===')
        fm, parts, rep = annotate(d, label, donor)
        if parts:
            donor = parts
        for line in rep:
            print(line)
        nb = sum(1 for p in fm['pages'] for it in p['items'] if it.get('badge'))
        ns = sum(1 for p in fm['pages'] for it in p['items'] if it.get('specials'))
        assert (nb, ns) == (exp_badge, exp_bar), f'{label}: expected {exp_badge}/{exp_bar}, got {nb}/{ns}'
        assert fm.get('micons', {}).get('newbadge'), f'{label}: no newbadge program'
        p0 = fm['micons']['newbadge']
        assert len(p0) == 4 and abs(path_width(p0[0]['bytes']) - 16.055) < 1e-2, \
            f'{label}: newbadge width {path_width(p0[0]["bytes"])}'
        want = [(-10.6669, -1.4840), (-9.1589, -1.5700), (-4.8466, 0.3543)]
        for k, (dx, dy) in enumerate(want, 1):
            assert abs(p0[k]['dx']-dx) < 1e-3 and abs(p0[k]['dy']-dy) < 1e-3, \
                f'{label}: part {k} offsets {p0[k]["dx"]},{p0[k]["dy"]}'
        print(f'  gate OK: {nb} badges / {ns} bars, newbadge 4 parts w={path_width(p0[0]["bytes"]):.3f}')
        results.append((d, label, fm))

    if not write:
        print('\nDRY RUN -- pass --write to apply'); return
    stamp = time.strftime('%Y%m%d_%H%M%S')
    for d, label, fm in results:
        bak = f'backups/{label}_fieldmap_{stamp}.json'
        shutil.copy(f'{d}/fieldmap.json', bak)
        json.dump(fm, open(f'{d}/fieldmap.json', 'w'))
        print(f'{label}: written, backup -> {bak}')


if __name__ == '__main__':
    main()
