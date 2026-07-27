#!/usr/bin/env python3
"""Build a Capiche drinks editor fieldmap. Byte-level name/desc edits (AOMono);
prices re-rendered in embedded RobotoMono (/RMSB) so any digit works.
Usage: build.py <src.pdf> <outdir> <brand>"""
import pikepdf, json, re, sys, os, io
from fontTools.ttLib import TTFont
HERE=os.path.dirname(os.path.abspath(__file__))
SRC, OUT, BRAND = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(OUT, exist_ok=True)
RMSB=os.path.join(HERE,'RobotoMono-SemiBold.ttf')

def embed_ttf(pdf, page, ttf_path, resname='/RMSB'):
    data=open(ttf_path,'rb').read(); tt=TTFont(ttf_path)
    upm=tt['head'].unitsPerEm; cmap=tt.getBestCmap(); hmtx=tt['hmtx']
    widths=[round((hmtx[cmap[c]][0] if c in cmap else 0)*1000.0/upm) for c in range(32,256)]
    h=tt['head']; bbox=[round(v*1000.0/upm) for v in (h.xMin,h.yMin,h.xMax,h.yMax)]
    asc=round(tt['hhea'].ascent*1000.0/upm); desc=round(tt['hhea'].descent*1000.0/upm)
    ff=pdf.make_stream(data); ff['/Length1']=len(data)
    fd=pdf.make_indirect(pikepdf.Dictionary(Type=pikepdf.Name('/FontDescriptor'),FontName=pikepdf.Name('/RobotoMono-SemiBold'),
        Flags=33,FontBBox=bbox,ItalicAngle=0,Ascent=asc,Descent=desc,CapHeight=asc,StemV=90,FontFile2=pdf.make_indirect(ff)))
    font=pdf.make_indirect(pikepdf.Dictionary(Type=pikepdf.Name('/Font'),Subtype=pikepdf.Name('/TrueType'),
        BaseFont=pikepdf.Name('/RobotoMono-SemiBold'),FirstChar=32,LastChar=255,Widths=widths,
        Encoding=pikepdf.Name('/WinAnsiEncoding'),FontDescriptor=fd))
    if '/Font' not in page.Resources: page.Resources.Font=pikepdf.Dictionary()
    page.Resources.Font[resname]=font

src=pikepdf.open(SRC)
src.save(os.path.join(OUT,'menu.pdf'), compress_streams=False, stream_decode_level=pikepdf.StreamDecodeLevel.generalized)
src.close()
pdf=pikepdf.open(os.path.join(OUT,'menu.pdf'), allow_overwriting_input=True)
# embed RMSB into every non-cover page
menu_pages=[i for i in range(len(pdf.pages)) if i>0]
for i in menu_pages: embed_ttf(pdf,pdf.pages[i],RMSB)

# real AOMono charsets (name Regular T1_1 size13, desc Bold T1_0 size7) for input filtering
def charset_of(page, basefont_sub):
    for k,v in (page.Resources.get('/Font') or {}).items():
        if basefont_sub in str(v.get('/BaseFont','')):
            fd=v.get('/FontDescriptor'); cs=str(fd.get('/CharSet')) if fd and '/CharSet' in fd.keys() else ''
            names=re.findall(r'/([A-Za-z0-9.]+)',cs)
            GN={'space':' ','exclam':'!','ampersand':'&','comma':',','period':'.','slash':'/','hyphen':'-','parenleft':'(','parenright':')','bracketleft':'[','bracketright':']','percent':'%'}
            for d,ch in {'zero':'0','one':'1','two':'2','three':'3','four':'4','five':'5','six':'6','seven':'7','eight':'8','nine':'9'}.items(): GN[d]=ch
            out=set()
            for n in names:
                if len(n)==1: out.add(n)
                elif n in GN: out.add(GN[n])
                elif n.lower()!=n and len(n)>1: out.add(n)  # e.g. 'A'? names are like 'A' single already
            # single upper letters appear as 'A'..'Z'; lowercase as 'a'..; add them
            return ''.join(sorted(out))
    return ''

def parse_page(pi):
    page=pdf.pages[pi]
    buf=bytes(page.Contents.read_bytes()).decode('latin-1')
    # walk Tj with byte spans; track font (Tf) and text-position (Tm/Td cumulative is complex; use Tm and Td)
    recs=[]; font=None; tm=None; tdx=0; tdy=0
    # tokenize by lines is messy; use regex over ops in order
    tok=re.compile(r'/(T1_\d) [\d.]+ Tf|(-?[\d.]+) (-?[\d.]+) Td|([\d.]+) 0 0 ([\d.]+) (-?[\d.]+) (-?[\d.]+) Tm|\(((?:[^()\\]|\\.)*)\)Tj')
    curfont=None; x=y=0; size=0
    for m in tok.finditer(buf):
        if m.group(1): curfont=m.group(1)
        elif m.group(2) is not None: x+=float(m.group(2)); y+=float(m.group(3))
        elif m.group(4) is not None: size=float(m.group(4)); x=float(m.group(6)); y=float(m.group(7))
        elif m.group(8) is not None:
            txt=re.sub(r'\\([()\\])',r'\1',m.group(8))
            recs.append({'text':txt,'span':[m.start(),m.end()],'font':curfont,'x':round(x,1),'y':round(y,1),'size':round(size,1)})
    return recs

sizes=[[round(float(p.mediabox[2]-p.mediabox[0]),2),round(float(p.mediabox[3]-p.mediabox[1]),2)] for p in pdf.pages]
name_allowed=charset_of(pdf.pages[menu_pages[0]],'AOMonoRegular')
desc_allowed=charset_of(pdf.pages[menu_pages[0]],'AOMonoBold')
def role_font(page, sub):
    for k,v in (page.Resources.get('/Font') or {}).items():
        if sub in str(v.get('/BaseFont','')): return str(k)
    return None
pages=[]
for pi in menu_pages:
    recs=parse_page(pi)
    pages.append({'page':pi,'recs':recs,
                  'reg_font':(role_font(pdf.pages[pi],'AOMonoRegular') or '/T1_1').replace('/',''),
                  'bold_font':(role_font(pdf.pages[pi],'AOMonoBold') or '/T1_0').replace('/','')})
fmap={'brand':BRAND,'pdf':'menu.pdf','menu_pages':menu_pages,'page_sizes':sizes,
      'pages':pages,'price_font':'/RMSB','price_size':7,
      'allowed':{'name':name_allowed,'desc':desc_allowed,'price':''.join(d for d in '0123456789' if d in name_allowed)}}
json.dump(fmap,open(os.path.join(OUT,'fieldmap_raw.json'),'w'))
pdf.save(os.path.join(OUT,'menu.pdf'), compress_streams=False, stream_decode_level=pikepdf.StreamDecodeLevel.generalized)
print('pages',menu_pages,'| name_allowed',repr(name_allowed),'| desc_allowed',repr(desc_allowed))
for pi in menu_pages:
    r=[x for x in pages if x['page']==pi][0]['recs']
    print(f'  page{pi}: {len(r)} text runs')
