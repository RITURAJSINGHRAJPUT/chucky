#!/usr/bin/env python3
"""Fix extra_spans OWNERSHIP for NEW badges and allergen icons, in place.

Usage: fix_extras.py <editor_dir> [--write]     (default is a dry run)

WHY THIS EXISTS RATHER THAN A PIPELINE RE-RUN
---------------------------------------------
Two defects in reflow_data.py mis-file the decorative art that must be deleted when a drink is
removed:

  (a) CAPTURE (reflow_data.py:73-75) — the NEW-badge regex REQUIRES a `scn` colour operator
      between `W n` and the starburst's `cm`. On capiche-ahm page 1 the first badge has NO colour
      op of its own (it renders red by inheriting the fill from the Jain marker before it -- the
      same fact behind the "JAMUN JAMUN badge went black" bug). So that badge never matched the
      badge rule; it fell through to the allergen-icon rule below, which captures only the inner
      starburst path -- leaving the white "NEW" letters owned by nobody.

  (b) ASSIGNMENT (reflow_data.py:113) — extras are assigned by the band test
      `ty - pitch + 6 <= y <= ty + 6`. Badge and icon `cm` origins are RAISED: they sit 7.8-10.3pt
      ABOVE the drink's name baseline, so every one of them lands in the band of the drink ABOVE.
      Net effect: removing a drink deletes its NEIGHBOUR's NEW badge.
      Fixing this by widening the band would make consecutive bands overlap, so a badge would land
      in two drinks at once. Assign by NEAREST top_y instead -- the rule marker_data.py:141-152
      already uses for the baked J and the dairy icon.

Re-running the pipeline is NOT an option: build.py re-saves menu.pdf (embeds /RMSB), which moves
every byte offset in the fieldmap; and reflow_data.py runs BEFORE marker_data.py, so re-running it
would clobber the marker_span values marker_data.py deliberately re-derives.

SAFETY MODEL
------------
This script never recomputes the vol / SPECIALS-bar assignments. It only:
  1. finds the badge + icon spans in the PDF with the corrected capture,
  2. strips any span overlapping those out of every item's extra_spans,
  3. re-adds each one to the drink whose top_y is nearest.
Everything else in extra_spans is preserved by construction, and that is asserted before writing.
"""
import pikepdf, re, json, sys, os, shutil, time

MAX_OWNER_DIST = 24.0   # observed raise is 7.8-10.3pt; row pitch is ~66pt, so this cannot stray

def qend(txt, st):
    """End offset (exclusive) of the balanced q...Q group starting at st."""
    d = 0; i = st; n = len(txt)
    while i < n:
        c = txt[i]
        if c == 'q' and (i == 0 or txt[i-1] in ' \n') and i+1 < n and txt[i+1] in ' \n':
            d += 1
        elif c == 'Q' and (i == 0 or txt[i-1] in ' \n') and (i+1 >= n or txt[i+1] in ' \n'):
            d -= 1
            if d == 0:
                return i+1
        i += 1
    return st

def find_art(raw):
    """Badge + allergen-icon spans, with the corrected capture. Returns [{y, span, kind}]."""
    art = []
    # NEW badge starburst, full-page-clip wrapped. The colour op is OPTIONAL -- see (a) above.
    badge_re = re.compile(r'q\s*\n0 [\d.]+ [\d.]+ -[\d.]+ re\s*\nW n\s*\n'
                          r'(?:[\d.]+ [\d.]+ [\d.]+ [\d.]+\s+scn\s*\n)?'
                          r'q 1 0 0 1 (-?[\d.]+) (-?[\d.]+) cm\n0 0 m\n-1\.')
    badge_ranges = []
    for m in badge_re.finditer(raw):
        sp = [m.start(), qend(raw, m.start())]
        badge_ranges.append((sp[0], sp[1]))
        art.append({'y': float(m.group(2)), 'span': sp, 'kind': 'badge'})
    # allergen vector icons (dairy / gluten). Skip clips the badge rule already claimed, or a
    # colourless badge would be captured twice -- once whole, once as just its starburst path.
    for m in re.finditer(r'q\s*\n[\d.]+ [\d.]+ [\d.]+ -[\d.]+ re\s*\nW n\s*\n'
                         r'(q 1 0 0 1 (-?[\d.]+) (-?[\d.]+) cm\n0 0 m)', raw):
        if any(a <= m.start() < b for a, b in badge_ranges):
            continue
        st = m.start(1); e = qend(raw, st)
        if e - st < 3200:
            art.append({'y': float(m.group(3)), 'span': [st, e], 'kind': 'icon'})
    return art

def overlaps(a, b):
    return a[0] < b[1] and b[0] < a[1]

def main():
    if len(sys.argv) < 2:
        print(__doc__); sys.exit(1)
    d = sys.argv[1].rstrip('/')
    write = '--write' in sys.argv
    fm = json.load(open(f'{d}/fieldmap.json'))
    pdf = pikepdf.open(f'{d}/{fm.get("pdf","menu.pdf")}')
    label = os.path.basename(d)
    print(f'=== {label} ===')

    other_before, other_after = [], []
    changed = 0
    for pg in fm['pages']:
        raw = bytes(pdf.pages[pg['page']].Contents.read_bytes()).decode('latin-1')
        art = find_art(raw)
        items = pg['items']
        tops = [it.get('top_y') for it in items]

        # 1) snapshot the spans we must NOT disturb, and strip art out of every item
        for it in items:
            keep, dropped = [], []
            for sp in it.get('extra_spans', []):
                if any(overlaps(sp, a['span']) for a in art): dropped.append(sp)
                else:                                          keep.append(sp)
            other_before.extend(tuple(sp) for sp in keep)
            it['extra_spans'] = keep

        # 2) re-assign each piece of art to the drink whose top_y is nearest
        for a in art:
            cand = [(abs(t - a['y']), i) for i, t in enumerate(tops) if t is not None]
            if not cand:
                print(f"  page{pg['page']} {a['kind']} y={a['y']:.2f} -> NO CANDIDATE (skipped)")
                continue
            dist, i = min(cand)
            if dist >= MAX_OWNER_DIST:
                print(f"  page{pg['page']} {a['kind']} y={a['y']:.2f} -> nearest {dist:.1f}pt away, "
                      f"OVER LIMIT (skipped)")
                continue
            items[i].setdefault('extra_spans', []).append(a['span'])
            print(f"  page{pg['page']} {a['kind']:<5} y={a['y']:7.2f} span={a['span']} "
                  f"-> [{i}] {items[i]['name']!r} (d={dist:.2f})")
            changed += 1

        for it in items:
            it['extra_spans'] = sorted(it.get('extra_spans', []))
        for it in items:
            for sp in it['extra_spans']:
                if not any(overlaps(sp, a['span']) for a in art):
                    other_after.append(tuple(sp))

    # 3) gate: every non-art span must survive untouched
    if sorted(other_before) != sorted(other_after):
        lost = set(other_before) - set(other_after)
        gained = set(other_after) - set(other_before)
        print(f'  !! ABORT: non-art spans changed. lost={sorted(lost)[:5]} gained={sorted(gained)[:5]}')
        sys.exit(2)
    print(f'  gate OK: {len(other_before)} non-art spans preserved exactly; {changed} art spans reassigned')

    if not write:
        print('  DRY RUN -- pass --write to apply'); return
    stamp = time.strftime('%Y%m%d_%H%M%S')
    bak = f'backups/{label}_fieldmap_{stamp}.json'
    shutil.copy(f'{d}/fieldmap.json', bak)
    json.dump(fm, open(f'{d}/fieldmap.json', 'w'))
    print(f'  written. backup -> {bak}')

if __name__ == '__main__':
    main()
