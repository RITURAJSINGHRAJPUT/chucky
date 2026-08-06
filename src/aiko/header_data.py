#!/usr/bin/env python3
"""Expose Aiko's section headers as editable fields.

Usage: header_data.py <editor_dir> [--write]      (dry run unless --write)

Each section header is TWO text runs: a 16pt serif word in /TT1 ("Rice", "Noodles", ...) and a 12pt
gold script word in /TT2 ("grainy", "slurpy", ...). Both are real embedded TrueType with outlines,
so they are retypeable — but the subsets are tiny, and that is the binding constraint:

    /TT1 serif :  space D M N R S a c d e h i l m n o r s t u
    /TT2 script:  L S a e g h i l m n o p r s t u w y

Capitals are only D M N R S. "Ramen"/"Salads"/"Dosa" render; "Pizza"/"Curry"/"Bowls" cannot. The
charset and widths are stored on each field so the editor can validate keystrokes and re-place the
script word without re-parsing the PDF.

The words are drawn per KERNING GROUP, e.g.

    16 0 0 16 27.7271 799.4478 Tm (Ri)Tj 0 Tc 0 Tw (c)Tj 1.471 0 Td (e)Tj

so an edit must replace the WHOLE run with a single `Tm .. 0 Tc 0 Tw (word)Tj`; patching the string
literals alone would leave the stale `Td` kerning behind. The gold `rg` sits BETWEEN the two runs, so
it belongs to neither and survives a run-level replacement.
"""
import pikepdf, re, json, sys, os, shutil, time

# a run: its Tm, then show/Td/state ops up to the last )Tj before the next Tm or ET
# capture the Tm's FIRST operand position: "16 0 0 16 x y Tm" contains the size twice, so any
# rindex-style search lands on the 4th operand and the span starts mid-Tm.
# Find each Tm, then look BACK for the /TTn Tf that governs it. Simpler and safer than one
# combined regex: "16 0 0 16 x y Tm" repeats the size, so any rindex-style search for it lands on
# the 4th operand and the span would start mid-Tm (which silently blanked the retyped word).
TM = re.compile(r'(?P<sz>[\d.]+) 0 0 [\d.]+ (?P<x>-?[\d.]+) (?P<y>-?[\d.]+) Tm')
TF = re.compile(r'/(TT\d) 1 Tf')
SHOW = re.compile(r'\(((?:[^()\\]|\\.)*)\)\s*Tj')


def font_table(pdf, pno, name):
    f = pdf.pages[pno].Resources.Font['/' + name]
    fc = int(f['/FirstChar']); ws = [int(x) for x in f['/Widths']]
    charset = ''.join(chr(fc + i) for i, w in enumerate(ws) if w > 0)
    widths = {chr(fc + i): w for i, w in enumerate(ws) if w > 0}
    return charset, widths


def runs_of(raw, font):
    """Every /TTn run: {font,size,x,y,span,text} where span covers Tm-operands .. last )Tj."""
    out = []
    for m in TM.finditer(raw):
        tfs = list(TF.finditer(raw, max(0, m.start() - 400), m.start()))
        if not tfs or tfs[-1].group(1) != font:
            continue
        tm_start = m.start()
        end = m.end(); last = None; text = ''
        for s in SHOW.finditer(raw, m.end(), m.end() + 900):
            between = raw[end:s.start()]
            if 'Tm' in between or 'ET' in between:      # next run started
                break
            text += re.sub(r'\\(.)', r'\1', s.group(1))
            last = s.end(); end = s.end()
        if last is None:
            continue
        out.append({'font': font, 'size': float(m.group('sz')), 'x': float(m.group('x')),
                    'y': float(m.group('y')), 'span': [tm_start, last], 'text': text})
    return out


def owner_of(f, sections):
    """Index of the section a dish belongs to — nearest col_x within 140pt whose last_y is at or
    below it, minimising (y-last_y)+0.01*dx. Mirrors buildEditor()'s _secOf."""
    best, bs = None, float('inf')
    for i, s in enumerate(sections):
        if s['page'] != f['page']: continue
        dx = abs(s['col_x'] - f['x'])
        if dx > 140 or f['y'] < s['last_y'] - 2: continue
        sc = (f['y'] - s['last_y']) + dx * 0.01
        if sc < bs: bs, best = sc, i
    return best


def main():
    if len(sys.argv) < 2:
        print(__doc__); sys.exit(1)
    d = sys.argv[1].rstrip('/'); write = '--write' in sys.argv
    label = os.path.basename(d)
    fm = json.load(open(f'{d}/fieldmap.json'))
    pdf = pikepdf.open(f'{d}/{fm.get("pdf","aiko.pdf")}')
    print(f'=== {label} ===')

    # snapshot the NON-header fields: a re-run must leave them untouched (headers themselves
    # are regenerated, so a previous run's header entries must not count as a difference)
    before = json.dumps([f for f in fm['fields'] if f.get('role') != 'header'], sort_keys=True)
    fm['fields'] = [f for f in fm['fields'] if f.get('role') != 'header']   # idempotent re-run
    fonts = {}
    made = []

    for sec_i, sec in enumerate(fm['sections']):
        pno = sec['page']
        raw = bytes(pdf.pages[pno].Contents.read_bytes()).decode('latin-1')
        for kind, font in (('serif', 'TT1'), ('script', 'TT2')):
            if (pno, font) not in fonts:
                fonts[(pno, font)] = font_table(pdf, pno, font)
            charset, widths = fonts[(pno, font)]
            # The section's OWN first dish. Filtering only on "same column and at/above last_y"
            # is not enough: two sections share a column (SIDES+MAINS, DIMSUM+SUSHI), so that
            # picks the topmost dish of the column and the lower section steals the upper
            # section's header. Assign each dish with the same rule the editor uses.
            first_y = max(f['y'] for f in fm['fields']
                          if f.get('page') == pno and f.get('role') == 'name'
                          and owner_of(f, fm['sections']) == sec_i)
            cand = [r for r in runs_of(raw, font)
                    if abs(r['x'] - sec['col_x']) < 150 and first_y < r['y'] < first_y + 60]
            if not cand:
                continue
            r = min(cand, key=lambda r: r['y'] - first_y)
            made.append({'role': 'header', 'page': pno, 'id': f'h{sec_i}:{kind}',
                         'section': sec_i, 'label': sec['label'], 'kind': kind,
                         'font': '/' + font, 'size': round(r['size'], 4),
                         'x': round(r['x'], 4), 'y': round(r['y'], 4),
                         'run_span': r['span'], 'display': r['text'],
                         'charset': charset, 'widths': widths,
                         'pair': f'h{sec_i}:' + ('script' if kind == 'serif' else 'serif')})

    # ---- gates ----
    seen = {}
    for h in made:
        raw = bytes(pdf.pages[h['page']].Contents.read_bytes()).decode('latin-1')
        got = ''.join(re.sub(r'\\(.)', r'\1', m.group(1))
                      for m in SHOW.finditer(raw, h['run_span'][0], h['run_span'][1] + 4))
        assert got.strip() == h['display'].strip(), f"{h['id']}: span decodes to {got!r} not {h['display']!r}"
        bad = [c for c in h['display'] if c not in h['charset']]
        assert not bad, f"{h['id']}: baked word uses {bad} outside its own subset"
        for o in seen.get(h['page'], []):
            assert h['run_span'][1] <= o[0] or h['run_span'][0] >= o[1], \
                f"{h['id']} overlaps another header run"
        seen.setdefault(h['page'], []).append(h['run_span'])
    per_sec = {}
    for h in made: per_sec.setdefault(h['section'], []).append(h['kind'])
    for i, ks in per_sec.items():
        assert sorted(ks) == ['script', 'serif'], f'section {i} got {ks}'

    fm['fields'].extend(made)
    non_header_after = json.dumps([f for f in fm['fields'] if f.get('role') != 'header'], sort_keys=True)
    assert non_header_after == json.dumps(json.loads(before), sort_keys=True), 'existing fields changed'

    for h in made:
        print(f"  {h['id']:<12} {h['label']:<9} {h['font']} {h['size']:>5}pt  "
              f"span={h['run_span']}  {h['display']!r}")
    print(f"  gate OK: {len(made)} header runs, all decode to their baked word, none overlap")
    print(f"  serif charset : {fonts[(1,'TT1')][0]!r}")
    print(f"  script charset: {fonts[(1,'TT2')][0]!r}")

    if not write:
        print('  DRY RUN -- pass --write to apply'); return
    stamp = time.strftime('%Y%m%d_%H%M%S')
    bak = f'backups/{label}_fieldmap_{stamp}.json'
    shutil.copy(f'{d}/fieldmap.json', bak)
    json.dump(fm, open(f'{d}/fieldmap.json', 'w'))
    print(f'  written. backup -> {bak}')


if __name__ == '__main__':
    main()
