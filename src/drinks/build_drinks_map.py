#!/usr/bin/env python3
"""build_drinks_map.py — Aiko Drinks Menu byte-level editor builder.
Each drink field (name/desc/price) is a kerned [..]TJ; edit = replace with [(NEW)]TJ.
Reads: src.pdf   Writes: ../../deploy/public/drinks/drinks.pdf + fieldmap.json"""
import pikepdf, json, re, os, io
HERE=os.path.dirname(os.path.abspath(__file__))
SRC=os.path.join(HERE,'src.pdf')
OUT=os.path.normpath(os.path.join(HERE,'..','..','deploy','public','drinks'))
os.makedirs(OUT,exist_ok=True)
MENU_PAGE=1

# 1) save uncompressed so content streams are plain-text for byte splicing
src=pikepdf.open(SRC)
src.save(os.path.join(OUT,'drinks.pdf'), compress_streams=False,
         stream_decode_level=pikepdf.StreamDecodeLevel.generalized)
src.close()

pdf=pikepdf.open(os.path.join(OUT,'drinks.pdf'))
buf=bytes(pdf.pages[MENU_PAGE].Contents.read_bytes()).decode('latin-1')

def decode_tj(arr):
    out='';i=0;n=len(arr)
    while i<n:
        if arr[i]=='(':
            j=i+1;s=''
            while j<n:
                if arr[j]=='\\': s+=arr[j+1];j+=2;continue
                if arr[j]==')': break
                s+=arr[j];j+=1
            out+=s;i=j+1
        else:i+=1
    return out

TJ=re.compile(r'\[((?:[^\[\]]|\\.)*)\]\s*TJ')
recs=[]
for m in TJ.finditer(buf):
    txt=decode_tj(m.group(1))
    pre=buf[max(0,m.start()-240):m.start()]
    tmm=re.findall(r'(-?\d+\.?\d*) 0 0 (-?\d+\.?\d*) (-?\d+\.?\d*) (-?\d+\.?\d*) Tm', pre)
    fs=re.findall(r'/(TT\d) (\d+(?:\.\d+)?) Tf', pre)
    tm=tmm[-1] if tmm else None
    recs.append({'text':txt,'span':[m.start(),m.end()],
                 'size':(float(tm[0]) if tm else None),
                 'x':(float(tm[2]) if tm else None),'y':(float(tm[3]) if tm else None),
                 'font':(fs[-1] if fs else None)})

# 2) group the 8 mocktails: name(size 9) then desc(size 7) then price(digits)
fields=[]; items=[]; fid=0
def addf(role,r):
    global fid
    f={'id':f'{MENU_PAGE}:{fid}','role':role,'text':r['text'],'span':r['span'],
       'x':r['x'],'y':r['y'],'size':r['size']}
    fields.append(f);fid+=1;return f['id']

# mocktails: iterate records, a name has size==9
i=0
mock=[]
for idx,r in enumerate(recs):
    if r['size']==9.0 and r['text'] and not r['text'].strip().isdigit():
        # this is a name; next size-7 non-digit = desc; the following all-digit = price
        name=r
        desc=None; price=None
        for j in range(idx+1, min(idx+4,len(recs))):
            t=recs[j]['text'].strip()
            if desc is None and recs[j]['size']==7.0 and not t.isdigit(): desc=recs[j]
            elif t.isdigit() and price is None: price=recs[j]; break
        mock.append((name,desc,price))
mock.sort(key=lambda t:-(t[0]['y'] or 0))
for name,desc,price in mock:
    it={'name':addf('name',name)}
    if desc: it['desc']=addf('desc',desc)
    if price: it['price']=addf('price',price)
    items.append(it)

# 3) soft-drinks block (bottom): name/price pairs, no desc. Identify by y<40 and pairs.
used={id(x) for m in mock for x in m if x}
soft=[r for r in recs if id(r) not in used and r['text'].strip()]
# pair: names are non-digit, prices are digit; match by nearest in stream order
soft_names=[r for r in soft if not r['text'].strip().isdigit()]
soft_prices=[r for r in soft if r['text'].strip().isdigit()]
for nm in soft_names:
    it={'name':addf('name',nm)}
    # nearest price in stream (soft prices share y~17-33); pair by order
    if soft_prices:
        pr=soft_prices.pop(0); it['price']=addf('price',pr)
    items.append(it)

# 4) allowed charsets = the MENU-PAGE font's REAL glyphs (Illustrator subset strips
#    outlines for unused chars but keeps cmap, so cmap lies — check glyf contours).
from fontTools.ttLib import TTFont
def real_charset(tag):
    fonts=pdf.pages[MENU_PAGE].Resources.Font or {}
    for t,f in fonts.items():
        if str(t)!=tag: continue
        fd=f.get('/FontDescriptor'); ff=fd.get('/FontFile2') if fd else None
        if not ff: return set()
        try:
            tt=TTFont(io.BytesIO(ff.read_bytes())); cmap=tt.getBestCmap(); glyf=tt['glyf']
            out=set()
            for cp,gname in cmap.items():
                if 32<=cp<=126 and (cp==32 or glyf[gname].numberOfContours!=0): out.add(chr(cp))
            return out
        except Exception: return set()
    return set()
# menu page /TT0 is the drink text font (MonospaceTypewriter). include chars actually used too.
used=set()
for f in fields: used |= set(f['text'])
menu_real=real_charset('/TT0')
name_allowed=''.join(sorted((menu_real|used) - set(c for c in (menu_real|used) if ord(c)>126)))
sizes=[[round(float(p.mediabox[2]-p.mediabox[0]),2),round(float(p.mediabox[3]-p.mediabox[1]),2)] for p in pdf.pages]
fmap={'brand':'aiko-drinks','pdf':'drinks.pdf','menu_page':MENU_PAGE,'page_sizes':sizes,
      'fields':fields,'items':items,
      'allowed':{'name':name_allowed,'desc':name_allowed,
                 'price':''.join(d for d in '0123456789' if d in name_allowed)}}
json.dump(fmap,open(os.path.join(OUT,'fieldmap.json'),'w'))
print('items:',len(items),'| fields:',len(fields))
for it in items:
    n=next(f for f in fields if f['id']==it['name'])
    d=next((f for f in fields if f['id']==it.get('desc')),None)
    p=next((f for f in fields if f['id']==it.get('price')),None)
    print(f"  {n['text']:28} | {(d['text'] if d else '—')[:34]:34} | {p['text'] if p else '—'}")
