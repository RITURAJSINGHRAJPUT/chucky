#!/usr/bin/env python3
"""Augment a built Capiche-drinks fieldmap with MARKER data so the editor can toggle
J / dairy / gluten per drink (like the food menu).

Adds, per drink item:
  it['mk_anchor'] = [x, y]   # where the marker cluster starts (right of the name's last line)
  it['dairy_span']           # byte span of a baked dairy vector (moved out of extra_spans)
Adds globally to the fieldmap:
  fm['jmark']  = {font, size, color}                 # (J) recipe from a baked marker
  fm['micons'] = {dairy:[parts], gluten:[parts]}     # reusable vector icons (from the food menu),
                                                       # recolored to the drinks' marker red + scale
  fm['mk_const'] = {scale, gap, jraise, dy_dairy, dy_gluten}
Also ensures /T1_2 (the AOMonoBlack "J" font) is registered on every menu page.

Usage: marker_data.py <public/<editor>>   (dir holding fieldmap.json + menu.pdf)
"""
import sys, json, re, pikepdf

DIR = sys.argv[1].rstrip('/')
NAME_ADV = 0.630          # AOMonoBold uppercase advance (em)
MARKER_RED = '0.008 0.98 0.973 0'   # the drinks' (J) fill, as device CMYK

fm = json.load(open(f'{DIR}/fieldmap.json'))
pdf = pikepdf.open(f'{DIR}/menu.pdf', allow_overwriting_input=True)

# ---- ensure /T1_2 on every menu page (copy the indirect font ref from a page that has it) ----
src_t1_2 = None
for pg in fm['pages']:
    fonts = pdf.pages[pg['page']].Resources.get('/Font')
    if fonts is not None and '/T1_2' in fonts:
        src_t1_2 = fonts['/T1_2']; break
added_font = False
if src_t1_2 is not None:
    for pg in fm['pages']:
        page = pdf.pages[pg['page']]
        res = page.Resources
        if '/Font' not in res:
            res.Font = pikepdf.Dictionary()
        if '/T1_2' not in res.Font:
            res.Font['/T1_2'] = src_t1_2
            added_font = True

def qend(txt, st):
    d=0;i=st;n=len(txt)
    while i<n:
        c=txt[i]
        if c=='q' and (i==0 or txt[i-1] in ' \n') and i+1<n and txt[i+1] in ' \n': d+=1
        elif c=='Q' and (i==0 or txt[i-1] in ' \n') and (i+1>=n or txt[i+1] in ' \n'):
            d-=1
            if d==0: return i+1
        i+=1
    return st

# allergen (dairy milk-bottle) capture — same recipe reflow_data uses for the inner path

jmark = None
for pg in fm['pages']:
    pi = pg['page']
    raw = bytes(pdf.pages[pi].Contents.read_bytes()).decode('latin-1')

    # --- parse text positions (Tm + Td aware) to get name runs ---
    tok = re.compile(
        r'/(T1_\d|RMSB) [\d.]+ Tf'
        r'|(-?[\d.]+) (-?[\d.]+) Td'
        r'|([\d.]+) 0 0 ([\d.]+) (-?[\d.]+) (-?[\d.]+) Tm'
        r'|\(((?:[^()\\]|\\.)*)\)Tj')
    cx=cy=scale=0.0
    runs=[]  # (cy, cx, scale, text)
    for m in tok.finditer(raw):
        if m.group(1): pass
        elif m.group(2) is not None:
            cx += float(m.group(2))*scale; cy += float(m.group(3))*scale
        elif m.group(4) is not None:
            scale=float(m.group(5)); cx=float(m.group(6)); cy=float(m.group(7))
        elif m.group(8) is not None:
            runs.append([round(cy,2), round(cx,2), round(scale,3), re.sub(r'\\([()\\])',r'\1',m.group(8))])
    name_runs=[r for r in runs if r[2]>=12]

    # --- find the ACTUAL baked (J) markers on this page (the fieldmap's `marker` flags are
    #     unreliable), each as {span:[bt,et], x, y, size}. Re-derive marker/marker_span below. ---
    # 0 Tw is present on some J blocks and absent on others; color varies per menu -> capture it.
    jblocks=[]
    for m in re.finditer(r'BT\s*\n([\d. ]+?)\s*scn\s*\n/T1_2 1 Tf\s*\n0 Tc (?:0 Tw )?([\d.]+) 0 0 [\d.]+ ([\d.-]+) ([\d.-]+) Tm\s*\n\(J\)Tj\s*\nET', raw):
        jblocks.append({'span':[m.start(),m.end()],'x':float(m.group(3)),'y':float(m.group(4)),'size':float(m.group(2)),'color':m.group(1).strip()})
    if jmark is None and jblocks:
        jmark={'font':'/T1_2','size':jblocks[0]['size'],'color':jblocks[0]['color']}

    # baked dairy (milk-bottle) icons by their vector SIGNATURE: a `q 1 0 0 1 x y cm / 0 0 m`
    # path ~2400-2600 bytes, curve-heavy (c~59). Robust across pages with/without an outer clip
    # wrapper; excludes NEW-badge starbursts (small, line-based). Capture the inner q only, so
    # on clipped pages the wrapping clip (which also holds the photo) is left intact.
    all_hits=[]
    for m in re.finditer(r'q 1 0 0 1 (-?[\d.]+) (-?[\d.]+) cm\s*\n0 0 m', raw):
        st=m.start(); e=qend(raw,st)
        if 2400 < e-st < 2600 and raw[st:e].count(' c') > 40:
            all_hits.append((float(m.group(2)), [st,e]))   # (y, span)

    tops=[it.get('top_y') for it in pg['items']]
    # assign each name run to the drink whose top is the smallest top that is >= run.y
    # (names sit at or just below their own top, and strictly above the next drink's top)
    def drink_of(run_y):
        best=None
        for i,t in enumerate(tops):
            if t is None: continue
            if t+1.5 >= run_y and (best is None or t < tops[best]):
                best=i
        return best
    groups={i:[] for i in range(len(tops))}
    for r in name_runs:
        d=drink_of(r[0])
        if d is not None: groups[d].append(r)
    for idx,it in enumerate(pg['items']):
        ty=it.get('top_y')
        if ty is None:
            it['mk_anchor']=None; continue
        grp=groups[idx]
        if grp:
            last_y=min(r[0] for r in grp)
            line=[r for r in grp if abs(r[0]-last_y)<1]
            x0=min(r[1] for r in line); sc=line[0][2]
            nchars=sum(len(r[3]) for r in line)
            end_x = x0 + nchars*NAME_ADV*sc
        else:
            last_y=ty; end_x=60.0; sc=13.0
        # match this drink to a baked (J) block by vertical proximity (J sits ~5.9 above the
        # last-line baseline). This RE-DERIVES marker/marker_span (the source flags are wrong).
        want_y=last_y+5.9; best=None; bestd=8.0
        for jb in jblocks:
            if jb.get('_used'): continue
            d=abs(jb['y']-want_y)
            if d<bestd: bestd=d; best=jb
        if best is not None:
            best['_used']=True
            it['marker']=True; it['marker_span']=best['span']
            it['mk_anchor']=[round(best['x'],2), round(best['y'],2)]
        else:
            it['marker']=False
            it.pop('marker_span',None)
            it['mk_anchor']=[round(end_x+2.4,2), round(last_y+5.9,2)]
        it.pop('dairy_span',None)   # cleared; re-assigned globally below
    # assign each baked dairy icon to the drink whose MARKER LINE is closest (dairy is a raised
    # superscript at the same height as the J, i.e. ~mk_anchor[1] — NOT at the name baseline).
    # Keep dairy in extra_spans too (drink REMOVAL still deletes it); dairy_span is only used
    # for the marker-EDIT delete+restamp path.
    for ay,span in all_hits:
        best=None; bestd=11.0
        for i,it in enumerate(pg['items']):
            a=it.get('mk_anchor')
            if not a or it.get('dairy_span'): continue
            dd=abs(a[1]-ay)
            if dd<bestd: bestd=dd; best=i
        if best is not None: pg['items'][best]['dairy_span']=span

# ---- global marker constants + icons (reuse the food menu's dairy/gluten vectors) ----
food=json.load(open('deploy/public/capiche/fieldmap.json'))
MK_COLOR=(jmark['color'] if jmark else MARKER_RED)   # this menu's marker red, from its baked J
def recolor(parts):
    out=[]
    for p in parts:
        out.append({'bytes':p['bytes'],'dx':p.get('dx',0),'dy':p.get('dy',0),
                    'color':MK_COLOR+' k'})
    return out
fm['jmark']=jmark or {'font':'/T1_2','size':6.1435,'color':MARKER_RED}
fm['micons']={'dairy':recolor(food['icons']['dairy']),'gluten':recolor(food['icons']['gluten'])}
# food icons were sized for j_size 8.0719; scale to the drinks j size
# scale the food icons so their height ~= the J glyph size (dairy natural h≈6.96)
fm['mk_const']={'scale':round(fm['jmark']['size']/6.96,4),
                'gap':1.6,          # x gap between packed markers (pts)
                'jgap':3.0,         # gap from name end to first marker
                'dy_j':0.0,'dy_dairy':-0.2,'dy_gluten':-0.2}

json.dump(fm,open(f'{DIR}/fieldmap.json','w'))
if added_font:
    pdf.save(f'{DIR}/menu.pdf', compress_streams=False,
             stream_decode_level=pikepdf.StreamDecodeLevel.generalized)
    print(f"[{DIR}] /T1_2 registered on pages missing it; menu.pdf re-saved (uncompressed)")
print(f"[{DIR}] jmark={fm['jmark']}  scale={fm['mk_const']['scale']}  "
      f"anchors set for {sum(1 for pg in fm['pages'] for it in pg['items'] if it.get('mk_anchor'))} drinks")
