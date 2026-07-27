#!/usr/bin/env python3
"""Augment fieldmap items with reflow data: top_y, photo_span, marker_span, price_pos already present.
Usage: reflow_data.py <outdir>"""
import pikepdf, re, json, sys
OUT=sys.argv[1]
fm=json.load(open(f'{OUT}/fieldmap.json'))
pdf=pikepdf.open(f'{OUT}/menu.pdf')
ROW=60.0
for pg in fm['pages']:
    pi=pg['page']; page=pdf.pages[pi]
    raw=bytes(page.Contents.read_bytes()).decode('latin-1')
    reg='/'+pg['reg_font']
    # 1) name tops: reg-font size>=12 Tm runs -> group consecutive into drink names, take first y
    names=[]  # (y, byte)
    curfont=None; size=0; x=0; y=0
    tok=re.compile(r'/(T1_\d) [\d.]+ Tf|(-?[\d.]+) (-?[\d.]+) Td|([\d.]+) 0 0 ([\d.]+) (-?[\d.]+) (-?[\d.]+) Tm|\(((?:[^()\\]|\\.)*)\)Tj')
    runs=[]
    for m in tok.finditer(raw):
        if m.group(1): curfont='/'+m.group(1)
        elif m.group(2) is not None: x+=float(m.group(2)); y+=float(m.group(3))
        elif m.group(4) is not None: size=float(m.group(5)); x=float(m.group(6)); y=float(m.group(7))
        elif m.group(8) is not None:
            runs.append({'text':re.sub(r'\\([()\\])',r'\1',m.group(8)),'y':round(y,1),'size':round(size,1),'font':curfont,'byte':m.start()})
    # drink tops = size>=12 runs, first of each consecutive group
    tops=[]; prev_was_name=False
    for r in sorted(runs,key=lambda r:-r['byte']):  # stream order
        pass
    # simpler: iterate in stream order, a name run with size>=12; a new drink starts when gap in name lines
    name_runs=[r for r in sorted(runs,key=lambda r:-r['y']) if r['size']>=12]
    # group by y proximity (<16 apart = same name)
    groups=[]; cur=None
    for r in name_runs:
        if cur is None or (cur[-1]['y']-r['y'])>16: cur=[r]; groups.append(cur)
        else: cur.append(r)
    top_ys=[max(g,key=lambda r:r['y'])['y'] for g in groups]
    # 2) photo blocks (clip-mapped), on-page only. cm may be rotated -> general 6-number affine
    photos=[]
    for m in re.finditer(r'(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) re\s*\nW n\s*\nq\s*\n(?:-?[\d.]+ ){5}-?[\d.]+ cm\s*\n(/Im\d+) Do\s*\nQ\s*\nQ', raw):
        x,yy,w,h=map(float,m.group(1,2,3,4))
        yc=yy+h/2
        if -5<=yc<=600 and h<120:  # on-page row tiles (exclude big bleed)
            photos.append({'yc':round(yc,1),'span':[m.start(),m.end()],'tile':[round(x,1),round(yy,1),round(w,1),round(h,1)]})
    # 3) J markers
    jmarks=[]
    for m in re.finditer(r'\(J\)Tj', raw):
        pre=raw[max(0,m.start()-120):m.start()]
        tm=re.findall(r'([\d.]+) 0 0 [\d.]+ (-?[\d.]+) (-?[\d.]+) Tm', pre)
        bt=raw.rfind('BT',0,m.start()); et=raw.find('ET',m.end())+2
        if tm and bt>=0 and et>0: jmarks.append({'y':float(tm[-1][2]),'span':[bt,et]})

    # extra decorative elements to delete when a drink is removed: vol [..ML], NEW badge, SPECIALS bar
    def qend(txt, st):
        d=0; i=st; n=len(txt)
        while i<n:
            c=txt[i]
            if c=='q' and (i==0 or txt[i-1] in ' \n') and i+1<n and txt[i+1] in ' \n': d+=1
            elif c=='Q' and (i==0 or txt[i-1] in ' \n') and (i+1>=n or txt[i+1] in ' \n'):
                d-=1
                if d==0: return i+1
            i+=1
        return st
    extras=[]
    # vol = size-5 text ([..ML] TJ or (..) Tj) — capture by its own size-5 Tm (letters may be kern-split)
    for m in re.finditer(r'5 0 0 5 (-?[\d.]+) (-?[\d.]+) Tm\s*\n((?:\[(?:\([^)]*\)|[^\]])*?\]TJ)|(?:\((?:[^()\\]|\\.)*\)Tj))', raw):
        body=m.group(3)
        if '(SPECIALS)' in body: continue   # SPECIALS handled below
        extras.append({'y':float(m.group(2)),'span':[m.start(),m.end()]})
    # SPECIALS red bar (spot colour scn) + its (SPECIALS) text
    for m in re.finditer(r'[\d.]+ [\d.]+ [\d.]+ [\d.]+\s+scn\s*\n[\d.]+ (-?[\d.]+) [\d.]+ 8\.177 re\s*\nf', raw):
        e=m.end(); extras.append({'y':float(m.group(1)),'span':[m.start(),e]})
        tb=re.search(r'BT[\s\S]{0,160}?\(SPECIALS\)Tj[\s\S]{0,30}?ET', raw[e:e+420])
        if tb: extras.append({'y':float(m.group(1)),'span':[e+tb.start(), e+tb.end()]})
    # NEW badge starburst (full-page-clip wrapped) — delete whole q..Q.
    # ⚠ The colour op is OPTIONAL. On ahm page 1 the first badge has NO `scn`: it renders red by
    # INHERITING the fill left by the Jain marker text immediately before it. Requiring the scn
    # here made that badge fall through to the allergen-icon rule below, which captures only the
    # starburst path and left the white "NEW" letters owned by nobody.
    badge_ranges=[]
    for m in re.finditer(r'q\s*\n0 [\d.]+ [\d.]+ -[\d.]+ re\s*\nW n\s*\n(?:[\d.]+ [\d.]+ [\d.]+ [\d.]+\s+scn\s*\n)?q 1 0 0 1 (-?[\d.]+) (-?[\d.]+) cm\n0 0 m\n-1\.', raw):
        sp=[m.start(), qend(raw,m.start())]; badge_ranges.append((sp[0],sp[1]))
        extras.append({'y':float(m.group(2)),'span':sp,'kind':'raised'})
    # allergen vector icons (dairy/gluten milk-bottle): capture the INNER filled path (leave the
    # full-page clip that wraps it — the outer clip also holds the photo).
    for m in re.finditer(r'q\s*\n[\d.]+ [\d.]+ [\d.]+ -[\d.]+ re\s*\nW n\s*\n(q 1 0 0 1 (-?[\d.]+) (-?[\d.]+) cm\n0 0 m)', raw):
        if any(a<=m.start()<b for a,b in badge_ranges): continue   # the badge group owns this clip
        st=m.start(1); e=qend(raw,st)
        if e-st<3200: extras.append({'y':float(m.group(3)),'span':[st, e],'kind':'raised'})

    # assign to items (items already top-to-bottom order)
    items=pg['items']
    n=len(items)
    # photo -> drink: greedy 1:1 (each photo used once), nearest drink-row center (ty-30)
    used=set()
    # actual per-drink height (pitch): distance to the next drink's top; the last drink's
    # "height" is its own baseline y (content runs down to the page bottom ~0).
    for i,it in enumerate(items):
        ty = top_ys[i] if i<len(top_ys) else None
        if ty is None: it['pitch']=ROW
        elif i<n-1 and top_ys[i+1] is not None: it['pitch']=round(ty-top_ys[i+1],1)
        else: it['pitch']=round(ty,1)
    # content height of each drink (baseline down to its lowest element) for add-slot math
    for it in items:
        nlines=max(1,len(it.get('name_spans',[]) or [1]))
        dlines=len(it.get('desc_spans',[]) or [])
        it['content_h']=round(nlines*15.6 + (dlines*9+6 if dlines else 0) + 10, 1)
    for i,it in enumerate(items):
        ty = top_ys[i] if i<len(top_ys) else None
        it['top_y']=ty
        if ty is not None and photos:
            cand=[(abs(p['yc']-ty),j) for j,p in enumerate(photos) if j not in used]
            if cand:
                dist,j=min(cand)
                if dist<32: it['photo_span']=photos[j]['span']; it['photo_tile']=photos[j]['tile']; used.add(j)
        # marker span
        if it.get('marker') and ty is not None and jmarks:
            best=min(jmarks,key=lambda j:abs(j['y']-ty))
            if abs(best['y']-ty)<40: it['marker_span']=best['span']
        # extras (vol/SPECIALS) in this drink's band [ty-pitch, ty]
        if ty is not None:
            it['extra_spans']=[e['span'] for e in extras
                               if e.get('kind')!='raised' and ty-it['pitch']+6 <= e['y'] <= ty+6]
    # NEW badges and allergen icons are RAISED vector art: their `cm` origin sits ~8-10pt ABOVE the
    # name baseline, so the band test above files them under the drink ABOVE — which is why removing
    # a drink used to delete its NEIGHBOUR's NEW badge. Assign by NEAREST top_y instead, the same
    # rule marker_data.py uses for the baked J and the dairy icon. Widening the band is NOT a fix:
    # consecutive bands would overlap and one badge would land in two drinks. Runs after the loop
    # because it appends to extra_spans. (24pt >> the observed 7.8-10.3 raise, << the ~66pt pitch.)
    for e in extras:
        if e.get('kind')!='raised': continue
        cand=[(abs(t-e['y']),i) for i,t in enumerate(top_ys) if t is not None]
        if not cand: continue
        dist,i=min(cand)
        if dist<24 and i<n: items[i].setdefault('extra_spans',[]).append(e['span'])
    # POST-PASS — the real row pitch is the PHOTO-STRIP GRID (uniform), not the text-top delta.
    # Text tops vary with 1- vs 2-line names; reflowing by them leaves holes (pitch<row) or
    # overlaps (pitch>row). Runs here because photo_tile is only assigned above.
    for i,it in enumerate(items):
        t=it.get('photo_tile'); nt=items[i+1].get('photo_tile') if i+1<n else None
        if t and nt: it['pitch']=round(t[1]-nt[1],1)
        elif t:      it['pitch']=round(t[3],1)
    print(f"page{pi}: {n} drinks, tops={[round(t) for t in top_ys]}, {len(photos)} photos, {len(jmarks)} J")
fm['row_h']=ROW
json.dump(fm,open(f'{OUT}/fieldmap.json','w'))
