#!/usr/bin/env python3
"""Repair Aiko description fields that were extracted from per-glyph-kerned text.

Usage: desc_fix.py <editor_dir> [--write]        (dry run unless --write)

THE BUG
-------
Illustrator draws some descriptions one glyph at a time:

    (c)Tj (h)Tj -0.019 Tc 0.019 Tw 1.161 0 Td (y )Tj 0 Tc 0 Tw 1.121 0 Td (h)Tj 0.591 0 Td (a)Tj ...

The original extractor kept only the MULTI-CHARACTER literals, so those fields ended up with
fragment text ("as ll il"), an `x` harvested from the first surviving fragment rather than the run's
own Tm (166.24 instead of 28.15), `line_spans` pointing at scattered 2-char pieces, and max_chars
stuck at the floor value 20. Descriptions authored as ONE whole-line Tj survived intact, which is
why the damage looks arbitrary.

Consequences in the editor: itemsForPage() pairs a description to a dish with |dx| < 8, so the
corrupt ones fall out of range and their dish shows NO description row, while a dish whose own field
is broken reaches down to the next intact one - FERRERO CRUNCH displays MANGO TRES LECHES's text.
That is not cosmetic: the edit handler keys on the paired field's id, so editing FERRERO CRUNCH
writes edits['1:52'] and splices into MANGO TRES LECHES's bytes. The wrong dish is silently
rewritten in the exported PDF.

THE REPAIR
----------
Re-derive each description from the PDF by walking its whole text run:
  * x / y / size from the run's own Tm;
  * text by concatenating every show operator, decoding PDF escapes - including the
    `\` + EOL LINE CONTINUATION (PDF 32000-1 7.3.4.2), which is currently stored raw and renders as
    a literal backslash in the UI (and would export blank: `\` has no glyph in the subset font);
  * one line_span per RENDERED line, covering that line's first `(` through its last `)`, so the
    emitter's `(text)` replacement swallows the inter-glyph Td kerning and re-emits a single Tj.

Page 0 is already correct (all 32 verified) and is asserted untouched.
"""
import pikepdf, re, json, sys, os, shutil, time

TOK = re.compile(
    r'\((?P<lit>(?:[^()\\]|\\.)*)\)\s*Tj'
    r'|\[(?P<arr>(?:[^\]\\]|\\.)*)\]\s*TJ'
    r'|(?P<tdx>-?[\d.]+) (?P<tdy>-?[\d.]+) Td'
    r'|(?P<sz>[\d.]+) [\d.-]+ [\d.-]+ (?P<sz2>[\d.]+) (?P<tx>-?[\d.]+) (?P<ty>-?[\d.]+) Tm'
    r'|(?P<et>\bET\b)')


def unescape(s):
    """Decode a PDF literal string, including the backslash+EOL line continuation."""
    out = []; i = 0; n = len(s)
    while i < n:
        c = s[i]
        if c != '\\':
            out.append(c); i += 1; continue
        i += 1
        if i >= n: break
        d = s[i]
        if d in '\r\n':                      # line continuation: both bytes vanish
            i += 1
            if d == '\r' and i < n and s[i] == '\n': i += 1
            continue
        out.append({'n': '\n', 'r': '\r', 't': '\t', 'b': '\b', 'f': '\f'}.get(d, d)); i += 1
    return ''.join(out)


def runs_for(raw):
    """Every Tm-anchored text run: {tm:(x,y,size), lines:[{span,text,y}]}."""
    out = []; cur = None
    for m in TOK.finditer(raw):
        g = m.groupdict()
        if g['sz'] is not None:
            if cur: out.append(cur)
            cur = {'x': float(g['tx']), 'y': float(g['ty']), 'size': float(g['sz']),
                   'lines': [], 'cy': float(g['ty'])}
            continue
        if not cur: continue
        if g['et'] is not None:
            out.append(cur); cur = None; continue
        if g['tdy'] is not None:
            cur['cy'] += float(g['tdy']) * cur['size']
            continue
        txt = g['lit'] if g['lit'] is not None else re.sub(r'\)[-\d.]*\(', '', g['arr'] or '')
        # the literal's own byte range: from its opening paren to its closing paren
        s = m.start(); e = raw.index(')', m.start()) + 1 if g['lit'] is not None else m.end()
        if g['lit'] is not None:
            s = raw.index('(', m.start()); e = s + 1 + len(g['lit']) + 1
        ln = None
        for L in cur['lines']:
            if abs(L['y'] - cur['cy']) < 0.5: ln = L; break
        if ln is None:
            ln = {'y': cur['cy'], 'span': [s, e], 'text': ''}
            cur['lines'].append(ln)
        ln['span'][0] = min(ln['span'][0], s); ln['span'][1] = max(ln['span'][1], e)
        ln['text'] += unescape(txt)
    if cur: out.append(cur)
    return out


def main():
    if len(sys.argv) < 2:
        print(__doc__); sys.exit(1)
    d = sys.argv[1].rstrip('/'); write = '--write' in sys.argv
    label = os.path.basename(d)
    fm = json.load(open(f'{d}/fieldmap.json'))
    pdf = pikepdf.open(f'{d}/{fm.get("pdf","aiko.pdf")}')
    print(f'=== {label} ===')

    p0_before = json.dumps([f for f in fm['fields'] if f['page'] == 0], sort_keys=True)
    fixed = added = 0

    for pno in sorted({f['page'] for f in fm['fields']}):
        if pno == 0:
            continue                                    # page 0 is already correct
        raw = bytes(pdf.pages[pno].Contents.read_bytes()).decode('latin-1')
        rs = runs_for(raw)
        names = sorted([f for f in fm['fields'] if f['page'] == pno and f['role'] == 'name'],
                       key=lambda f: -f['y'])
        descs = {f['id']: f for f in fm['fields'] if f['page'] == pno and f['role'] == 'desc'}
        used = set()
        for nf in names:
            # a dish's description is the run directly under its name, in its column
            cand = [r for r in rs
                    if abs(r['x'] - nf['x']) < 6 and 0 < nf['y'] - r['y'] < 22
                    and r['size'] < nf['size'] - 1 and r['lines']
                    and id(r) not in used]
            if not cand:
                continue
            run = min(cand, key=lambda r: nf['y'] - r['y']); used.add(id(run))
            lines = [L for L in run['lines'] if L['text'].strip()]
            if not lines: continue
            text = '\n'.join(L['text'].rstrip() for L in lines)
            spans = [L['span'] for L in lines]
            # the desc field for this dish is the next id; create it if the extractor dropped it
            base, idx = nf['id'].split(':')
            did = f'{base}:{int(idx)+1}'
            df = descs.get(did)
            if df is None:
                df = {'role': 'desc', 'page': pno, 'id': did}
                fm['fields'].append(df); added += 1
                tag = 'ADDED  '
            else:
                tag = 'fixed  ' if (df.get('x') != round(run['x'], 2) or
                                    len(df.get('line_spans', [])) != len(spans)) else 'ok     '
            if tag == 'ok     ':
                continue
            old = (df.get('x'), str(df.get('display'))[:26])
            df.update({'x': round(run['x'], 2), 'y': round(lines[0]['y'], 2),
                       'size': round(run['size'], 2), 'line_spans': spans,
                       'max_chars': max(20, max(len(L['text']) for L in lines)),
                       'display': text})
            fixed += 1
            print(f"  p{pno} {tag}{did:<6} {str(nf.get('display'))[:26]:<28}")
            print(f"        x {old[0]} -> {df['x']}   text {old[1]!r} -> {text[:40]!r}")

    # ---- gates ----
    assert json.dumps([f for f in fm['fields'] if f['page'] == 0], sort_keys=True) == p0_before, \
        'page 0 fields must not change'
    # every dish pairs to its OWN description under the editor's rule, and none is shared
    for pno in sorted({f['page'] for f in fm['fields']}):
        names = [f for f in fm['fields'] if f['page'] == pno and f['role'] == 'name']
        descs = [f for f in fm['fields'] if f['page'] == pno and f['role'] == 'desc']
        claimed = {}
        for nf in names:
            c = [x for x in descs if abs(x['x'] - nf['x']) < 8 and 0 < nf['y'] - x['y'] < 62]
            c.sort(key=lambda x: -x['y'])
            if not c: continue
            got = c[0]['id']
            assert got not in claimed, \
                f'p{pno}: {got} claimed by BOTH {claimed[got]} and {nf["id"]}'
            claimed[got] = nf['id']
    print(f'  gate OK: page 0 untouched; no description claimed by two dishes')
    print(f'  {fixed} description(s) repaired, {added} added')

    if not write:
        print('  DRY RUN -- pass --write to apply'); return
    stamp = time.strftime('%Y%m%d_%H%M%S')
    bak = f'backups/{label}_fieldmap_{stamp}.json'
    shutil.copy(f'{d}/fieldmap.json', bak)
    json.dump(fm, open(f'{d}/fieldmap.json', 'w'))
    print(f'  written. backup -> {bak}')


if __name__ == '__main__':
    main()
