#!/usr/bin/env python3
"""Calibration: stamp J+dairy+gluten on every drink at its mk_anchor using the exact recipe
the JS engine will use, then render with pymupdf so we can eyeball positioning/size/colour.
Usage: calib_markers.py <public/<editor>> <page_index> <out.png>"""
import sys,json,re,pikepdf,fitz
DIR=sys.argv[1]; PGI=int(sys.argv[2]); OUT=sys.argv[3]
fm=json.load(open(f'{DIR}/fieldmap.json'))
J=fm['jmark']; MIC=fm['micons']; K=fm['mk_const']
pdf=pikepdf.open(f'{DIR}/menu.pdf')

def icon_stamp(parts, tx, ty, s):
    # replace the icon's own cm origin with (tx,ty) and scale by s; path coords are
    # relative to that origin ("0 0 m" start), so this repositions+scales the whole glyph.
    out=''
    for p in parts:
        b=re.sub(r'1 0 0 1 (-?[\d.]+) (-?[\d.]+) cm',
                 f'{s:.4f} 0 0 {s:.4f} {tx+p.get("dx",0):.3f} {ty+p.get("dy",0):.3f} cm',
                 p['bytes'],count=1)
        out+=p['color']+' '+b+'\n'
    return out

# icon natural widths (from path bbox) so packing doesn't overlap
def icon_w(parts):
    xs=[]
    for p in parts:
        m=re.search(r'1 0 0 1 (-?[\d.]+) ',p['bytes']); x0=float(m.group(1)) if m else 0
        for mm in re.finditer(r'(-?[\d.]+) (-?[\d.]+) (?:l|m)|(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) c',p['bytes']):
            pass
    # simpler: bbox of the first part's coords
    nums=[float(x) for x in re.findall(r'-?[\d.]+',parts[0]['bytes'].split('cm',1)[1])]
    xs=nums[0::2]
    return (max(xs)-min(xs)) if xs else 6.0

DW=icon_w(MIC['dairy']); GW=icon_w(MIC['gluten'])
JW=J['size']*0.63

def cluster(ax,ay,S):
    out='\nq\n'; ix=ax; js=J['size']; s=K['scale']
    if 'dairy' in S:
        out+=icon_stamp(MIC['dairy'], ix, ay+K['dy_dairy'], s); ix+=DW*s+K['gap']
    if 'gluten' in S:
        out+=icon_stamp(MIC['gluten'], ix, ay+K['dy_gluten'], s); ix+=GW*s+K['gap']
    if 'jain' in S:
        out+=('BT '+J['color']+' k /'+J['font'].strip('/')+' 1 Tf 0 Tc 0 Tw '
              f'{js:.4f} 0 0 {js:.4f} {ix:.3f} {ay+K["dy_j"]:.3f} Tm (J)Tj ET\n')
        ix+=JW+K['gap']
    out+='Q\n'; return out

pg=next(p for p in fm['pages'] if p['page']==PGI)
append=''
for it in pg['items']:
    a=it.get('mk_anchor')
    if a: append+=cluster(a[0],a[1],{'jain','dairy','gluten'})
page=pdf.pages[PGI]
old=bytes(page.Contents.read_bytes())
page.Contents.write(old+append.encode('latin-1'))
pdf.save('/tmp/_calib.pdf', compress_streams=False, stream_decode_level=pikepdf.StreamDecodeLevel.generalized)

doc=fitz.open('/tmp/_calib.pdf')
doc[PGI].get_pixmap(dpi=150).save(OUT)
print("rendered",OUT,"| DW",round(DW,2),"GW",round(GW,2),"JW",round(JW,2),"scale",K['scale'])
