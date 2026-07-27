#!/usr/bin/env python3
"""Group raw text runs into drinks (name/desc/price/vol) with byte spans. Usage: group.py <outdir>"""
import json, sys, re
OUT=sys.argv[1]
fm=json.load(open(f'{OUT}/fieldmap_raw.json'))
def group_page(recs, reg_font):
    recs=sorted(recs, key=lambda r:(-r['y'], r['x']))
    items=[]; cur=None
    for r in recs:
        t=r['text']
        is_name = r['size']>=12 and 'AOMonoRegular' in '' or r['size']>=12
        if r['size']>=12:  # name line
            if cur is None or cur.get('_closed'):
                cur={'name_spans':[r['span']], 'name':t, 'desc_spans':[], 'desc':'', 'vol_span':None, 'vol':'',
                     'price_span':None, 'price':'', 'price_pos':None, 'marker':False, '_ytop':r['y']}
                items.append(cur)
            elif cur.get('_afterbody'):
                cur['_closed']=True
                cur={'name_spans':[r['span']], 'name':t, 'desc_spans':[], 'desc':'', 'vol_span':None, 'vol':'',
                     'price_span':None, 'price':'', 'price_pos':None, 'marker':False, '_ytop':r['y']}
                items.append(cur)
            else:
                cur['name_spans'].append(r['span']); cur['name']+=t
            continue
        if cur is None: continue
        cur['_afterbody']=True
        st=t.strip()
        if re.fullmatch(r'\[[\dA-Za-z]+ML\]', st, re.I):  # volume
            cur['vol_span']=r['span']; cur['vol']=t
        elif st=='J':
            cur['marker']=True
        elif r['font']==reg_font and re.fullmatch(r'[\d]+', st) and int(st)>=20:  # price = AOMonoRegular digits
            cur['price_span']=r['span']; cur['price']=st; cur['price_pos']={'x':r['x'],'y':r['y'],'size':r['size']}
        # Description line (AOMonoBold body). Section headers ("V60 POUR OVER (HOT & ICED)")
        # are the SAME size as body text, so size alone can't separate them — but descriptions
        # are always sentence-case while headers are all-caps. Without this guard the header is
        # swallowed as a desc line of whichever drink is current, and editing that drink's
        # description then overwrites the header in the PDF. Trade-off: an all-caps description
        # would be dropped here — a far safer failure than destroying page furniture.
        elif st and r['size']>=6 and any(c.islower() for c in st):
            cur['desc_spans'].append(r['span']); cur['desc']+=(('' if not cur['desc'] else ' ')+t)
    # clean helper keys, drop SPECIALS-only artifacts (name 'SPECIALS' small handled as desc? size 5 -> desc)
    for it in items:
        for k in ('_closed','_afterbody','_ytop'): it.pop(k,None)
        it['name']=it['name'].strip()
    return [it for it in items if it['name']]
for pg in fm['pages']:
    pg['items']=group_page(pg['recs'], pg.get('reg_font','T1_1'))
    del pg['recs']
json.dump(fm, open(f'{OUT}/fieldmap.json','w'))
import os; os.remove(f'{OUT}/fieldmap_raw.json')
for pg in fm['pages']:
    print(f"page{pg['page']}: {len(pg['items'])} drinks")
    for it in pg['items']:
        print(f"   {it['name'][:22]:22} | {it['desc'][:30]:30} | {it['vol']:9} | {it['price']:4} | {'J' if it['marker'] else ''}")
