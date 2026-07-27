#!/usr/bin/env python3
"""Re-derive photo_span / photo_tile with a corrected photo regex, in place.

Usage: photo_fix.py <editor_dir> [<editor_dir> ...] [--write]     (dry run unless --write)

THE BUG
-------
reflow_data.py:38 captures a drink's photo with

    (x) (y) (w) (h) re \n W n \n q \n <6 numbers> cm \n (/ImN) Do \n Q \n Q

but the FIRST photo on capiche-ahm page 1 carries an extra `/GS0 gs` line between the `q` and the
`cm`, so it never matched:

    q / 181.034 528.943 99.596 66.293 re / W n / q / GS0 gs / ... cm / /Im0 Do / Q / Q

Consequences, all from that one miss — LEMON ICED TEA ended up with:
  * photo_tile = null      -> the SPECIALS-bar chip is hidden (specialsPlace returns null) AND
                              photo uploads silently do nothing (index.html guards on
                              `up && it.photo_tile`)
  * photo_span = MINT MOJITO's -> removing LEMON ICED TEA deleted the NEXT drink's photo and left
                              its own /Im0 orphaned on the page

Only capiche-ahm p1 item 0 is affected; every other page and capiche-surat already resolve 1:1.
This script re-derives the mapping for every page it is given and asserts that nothing except a
previously-missing assignment changes.

Span convention: the recorded span starts at the `re` COORDINATES, not at the wrapping `q` — that
is how the other eight are stored, and deleting one therefore leaves a stray `q` behind. That
imbalance is pre-existing and harmless (nothing pops below it); staying consistent with the other
eight matters more than fixing it for one item.
"""
import pikepdf, re, json, sys, os, shutil, time

# `(?:/GS0 gs\s*\n)?` is the whole fix — everything else matches reflow_data.py:38.
PHOTO = re.compile(r'q\s*\n([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+) re\s*\nW n\s*\nq\s*\n'
                   r'(?:/GS0 gs\s*\n)?(?:-?[\d.]+ ){5}-?[\d.]+ cm\s*\n(/Im\d+) Do\s*\nQ\s*\nQ')
MAX_DIST = 32.0     # same tolerance reflow_data.py uses for photo -> drink


def photos_in(raw):
    out = []
    for m in PHOTO.finditer(raw):
        x, y, w, h = (float(m.group(k)) for k in (1, 2, 3, 4))
        out.append({'span': [m.start() + 2, m.end()],          # +2 skips the leading "q\n"
                    'tile': [round(x, 1), round(y, 1), round(w, 1), round(h, 1)],
                    'yc': round(y + h / 2, 1), 'im': m.group(5)})
    return out


def main():
    dirs = [a.rstrip('/') for a in sys.argv[1:] if not a.startswith('--')]
    write = '--write' in sys.argv
    if not dirs:
        print(__doc__); sys.exit(1)

    results = []
    for d in dirs:
        label = os.path.basename(d)
        fm = json.load(open(f'{d}/fieldmap.json'))
        pdf = pikepdf.open(f'{d}/{fm.get("pdf","menu.pdf")}')
        print(f'=== {label} ===')
        changed = 0
        for pg in fm['pages']:
            raw = bytes(pdf.pages[pg['page']].Contents.read_bytes()).decode('latin-1')
            photos = photos_in(raw)
            items = pg['items']
            assert len(photos) == len(items), \
                f'{label} p{pg["page"]}: {len(photos)} photos vs {len(items)} drinks'
            used = set()
            for i, it in enumerate(items):
                ty = it.get('top_y')
                if ty is None:
                    continue
                cand = [(abs(p['yc'] - ty), j) for j, p in enumerate(photos) if j not in used]
                assert cand, f'{label} p{pg["page"]} [{i}]: no photo left'
                dist, j = min(cand)
                assert dist < MAX_DIST, \
                    f'{label} p{pg["page"]} [{i}] {it["name"]!r}: nearest photo {dist:.1f}pt away'
                used.add(j)
                old_span, old_tile = it.get('photo_span'), it.get('photo_tile')
                new_span, new_tile = photos[j]['span'], photos[j]['tile']
                if old_span != new_span or old_tile != new_tile:
                    changed += 1
                    print(f"  p{pg['page']} [{i}] {it['name']!r} {photos[j]['im']}")
                    print(f"      span {old_span} -> {new_span}")
                    print(f"      tile {old_tile} -> {new_tile}")
                it['photo_span'], it['photo_tile'] = new_span, new_tile
            # every photo used exactly once, no drink sharing a span
            spans = [tuple(it['photo_span']) for it in items if it.get('photo_span')]
            assert len(spans) == len(set(spans)), f'{label} p{pg["page"]}: duplicate photo_span'
            assert len(used) == len(photos), f'{label} p{pg["page"]}: {len(photos)-len(used)} photo(s) unassigned'
        print(f'  gate OK: 1:1 photo<->drink on every page; {changed} assignment(s) corrected')
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
