// Rebuild the Capiche FOOD-menu fieldmap from a new blueprint PDF.
// The editor groups fields purely geometrically, so we only need, per dish:
//   name/desc/price BT-block byte spans + positions + display, and marker spans/anchor.
// Template metadata (sections, icons, add_const, adv, allowed, nav_sections, jfont_by_page,
// page_sizes) is reused from the OLD fieldmap because the layout template is unchanged.
// Usage: node build_food.js <src.pdf> <old_fieldmap.json> <out_fieldmap.json> [--validate-page0]
const fs=require('fs');
const {PDFDocument,PDFName}=require('pdf-lib');

const SRC=process.argv[2], OLD_FM=process.argv[3], OUT=process.argv[4];
const VALIDATE=process.argv.includes('--validate-page0');

// ---- marker vector signatures (first path op after "0 0 m\n") ----
const MK_SIG={
  dairy:  '-0.455 -0.011 -0.876 0.098 -1.252 0.359',   // milk carton
  gluten: '0.216 0.592 0.874 0.832 1.428 0.487',       // wheat
  spicy:  '-0.001 0.001 l\n-0.042 0.083 -0.119 0.132',  // ghaslet flame (starts with a line)
  new:    '-1.453 -1.683 l\n-0.884 -3.832 l'            // NEW starburst badge
};

// ---------------- tokenizer ----------------
const DELIM=/[\s()<>\[\]{}\/%]/;
function tokenize(s){
  const toks=[]; let i=0; const n=s.length;
  while(i<n){
    const c=s[i];
    if(c===' '||c==='\n'||c==='\r'||c==='\t'||c==='\f'){ i++; continue; }
    if(c==='('){ let j=i+1, d=1; while(j<n){ const ch=s[j]; if(ch==='\\'){ j+=2; continue; } if(ch==='('){ d++; } else if(ch===')'){ d--; if(d===0){ j++; break; } } j++; }
      toks.push({t:'str', v:s.slice(i+1,j-1), span:[i,j]}); i=j; continue; }
    if(c==='<'){ // hex string or dict-open; skip one char (dicts rare in content streams)
      if(s[i+1]==='<'){ toks.push({t:'op',v:'<<',off:i}); i+=2; continue; }
      let j=i+1; while(j<n && s[j]!=='>')j++; toks.push({t:'hex',off:i,end:j+1}); i=j+1; continue; }
    if(c==='>'){ if(s[i+1]==='>'){ toks.push({t:'op',v:'>>',off:i}); i+=2; continue; } i++; continue; }
    if(c==='/'){ let j=i+1; while(j<n && !DELIM.test(s[j]))j++; toks.push({t:'name',v:s.slice(i,j),off:i}); i=j; continue; }
    if(c==='['||c===']'){ toks.push({t:c,off:i}); i++; continue; }
    let j=i; while(j<n && !DELIM.test(s[j]))j++;
    const w=s.slice(i,j);
    if(/^[-+]?[\d.]+$/.test(w) && /\d/.test(w)) toks.push({t:'num',v:parseFloat(w),off:i,end:j});
    else toks.push({t:'op',v:w,off:i,end:j});
    i=j;
  }
  return toks;
}

// Walk tokens → text elements. Each element = one BT..ET block with one font/size and
// one or more lines (Tj runs; extra lines via Td). Records byte spans.
function parseElements(s){
  const toks=tokenize(s);
  const els=[]; let cur=null;
  let font=null, size=0, tmx=0, tmy=0, tdx=0, tdy=0;
  let nums=[], numToks=[], lastName=null, prevStr=null, tmSpan=null;
  for(let k=0;k<toks.length;k++){
    const tk=toks[k];
    if(tk.t==='num'){ nums.push(tk.v); numToks.push(tk); continue; }
    if(tk.t==='name'){ lastName=tk.v; nums=[]; numToks=[]; continue; }
    if(tk.t==='str'){ prevStr=tk; continue; }
    if(tk.t!=='op'){ nums=[]; numToks=[]; continue; }
    const op=tk.v;
    if(op==='BT'){ cur={font:null,size:0,x:0,y:0,lines:[],tmSpan:null,tmVals:null}; els.push(cur); tmx=tmy=tdx=tdy=0; nums=[]; numToks=[]; }
    else if(op==='ET'){ cur=null; nums=[]; numToks=[]; }
    else if(op==='Tf'){ font=lastName; if(cur) cur.font=font; nums=[]; numToks=[]; }
    else if(op==='Tm'){ if(nums.length>=6){ const a=nums.slice(-6); size=a[0]; tmx=a[4]; tmy=a[5]; tdx=tdy=0;
        tmSpan=[numToks[numToks.length-6].off, numToks[numToks.length-1].end];
        if(cur){ cur.size=size; cur.x=tmx; cur.y=tmy; cur.tmSpan=tmSpan; cur.tmVals=a.slice(); cur.font=font; } }
        nums=[]; numToks=[]; }
    else if(op==='Td'){ if(nums.length>=2){ const a=nums.slice(-2); tdx+=a[0]; tdy+=a[1]; } nums=[]; numToks=[]; }
    else if(op==='TJ'||op==='Tj'){ if(prevStr && cur){ cur.lines.push({span:prevStr.span.slice(), text:prevStr.v, x:tmx+tdx*size, y:tmy+tdy*size}); } prevStr=null; nums=[]; numToks=[]; }
    else { nums=[]; numToks=[]; }
  }
  return els.filter(e=>e.lines.length);
}
// Group an element's Tj runs into visual lines: same y (±1.5pt) = one line (multiple spans),
// mirroring how the old fieldmap stored multi-run names (e.g. BURRATA/HOT/HONEY). Returns
// { rows:[[run,...] per line, top→bottom], spanLines:[[span,...]], display }.
function groupLines(runs){
  const sorted=runs.slice().sort((a,b)=> b.y-a.y || a.x-b.x);
  const rows=[];
  for(const r of sorted){ const row=rows.find(R=>Math.abs(R[0].y-r.y)<1.5); if(row) row.push(r); else rows.push([r]); }
  rows.forEach(R=>R.sort((a,b)=>a.x-b.x));
  const spanLines=rows.map(R=>R.map(r=>r.span.slice()));
  const display=rows.map(R=>R.map(r=>r.text).join('')).join(' ');
  return { rows, spanLines, display };
}

// Find marker instances (dairy/gluten/spicy/new vectors + jain (J) text) with position + full span.
function parseMarkers(s){
  const out=[];
  // vector markers: q 1 0 0 1 X Y cm\n0 0 m\n<sig>
  const re=/q 1 0 0 1 (-?[\d.]+) (-?[\d.]+) cm\n0 0 m\n/g; let m;
  while(m=re.exec(s)){
    const after=s.slice(m.index+m[0].length, m.index+m[0].length+60);
    let type=null;
    for(const [t,sig] of Object.entries(MK_SIG)){ if(after.startsWith(sig)){ type=t; break; } }
    if(!type) continue;
    // find matching Q (depth count over q/Q tokens)
    let i=m.index, depth=0, end=-1;
    while(i<s.length){
      if(s[i]==='q' && (i===0||/\s/.test(s[i-1])) && /\s/.test(s[i+1]||' ')) depth++;
      else if(s[i]==='Q' && (i===0||/\s/.test(s[i-1])) && (i+1>=s.length||/\s/.test(s[i+1]))){ depth--; if(depth===0){ end=i+1; break; } }
      i++;
    }
    out.push({type, x:+m[1], y:+m[2], span:[m.index, end]});
  }
  // jain: (J) text inside a BT..ET. find (J)Tj then expand to enclosing BT/ET
  const jre=/\(J\)Tj/g;
  while(m=jre.exec(s)){
    const bt=s.lastIndexOf('BT', m.index); const et=s.indexOf('ET', m.index);
    if(bt<0||et<0) continue;
    // parse the Tm x,y inside this block
    const blk=s.slice(bt, et+2);
    const tm=/(-?[\d.]+) 0 0 (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) Tm/.exec(blk);
    const x=tm?+tm[3]:0, y=tm?+tm[4]:0;
    out.push({type:'jain', x, y, span:[bt, et+2]});
  }
  return out;
}

const isPrice=t=>/^[\d]+$/.test(t.trim());
function main(){
  const bytes=new Uint8Array(fs.readFileSync(SRC));
  return PDFDocument.load(bytes).then(doc=>{
    const oldFM=JSON.parse(fs.readFileSync(OLD_FM,'utf8'));
    const NAME_FONT=oldFM.add_const.fonts.name;   // /T1_3
    const PRICE_FONT=oldFM.add_const.fonts.price;  // /T1_4
    const jfont=oldFM.jfont_by_page;               // {0:/T1_2,1:/T1_0}
    const AC=oldFM.add_const;
    const pageFields={};
    for(const pg of [0,1]){
      const stream=Buffer.from(doc.context.lookup(doc.getPage(pg).node.get(PDFName.of('Contents'))).contents).toString('latin1');
      const els=parseElements(stream);
      const markers=parseMarkers(stream);
      const descFont=jfont[pg];   // AOMonoBold resource name for this page (desc + J share it)
      // classify elements
      const names=[], descs=[], prices=[];
      for(const e of els){
        if(e.font===NAME_FONT && e.size>=12){ names.push(e); }
        else if(e.font===PRICE_FONT && e.lines.length===1 && isPrice(e.lines[0].text)){ prices.push(e); }
        else if(e.font===descFont && e.size>=5 && e.size<12 && !(e.lines.length===1 && e.lines[0].text==='J')){ descs.push(e); }
      }
      // build fields
      const fields=[]; let idc=0;
      for(const nm of names){
        const id=pg+':'+(idc++);
        const G=groupLines(nm.lines);
        const display=G.display;
        // markers belonging to this name: near name.y (within name span rows) and x to the right of name start
        const spanRows=15.5*(G.rows.length-1);
        // markers cluster to the right of the name; NEW badge rides ~14pt above the baseline, so widen the top
        const myMk=markers.filter(mk=> mk.x>nm.x+4 && mk.x<nm.x+320 && mk.y<=nm.y+18 && mk.y>=nm.y-spanRows-9);
        const mset=[...new Set(myMk.map(mk=>mk.type))];
        // markerBase: base x of the dairy slot (= dairy pos, since icon_dairy[0]=0), y=name y
        let baseX=null;
        const byType={}; myMk.forEach(mk=>{ byType[mk.type]=mk; });
        if(byType.dairy) baseX=byType.dairy.x - AC.icon_dairy[0];
        else if(byType.gluten) baseX=byType.gluten.x - AC.icon_gluten[0];
        else if(byType.jain) baseX=byType.jain.x - AC.icon_j[0];
        else if(byType.spicy) baseX=byType.spicy.x - AC.icon_spicy[0];
        const markerSpans={};
        for(const mk of myMk){ if(!markerSpans[mk.type]) markerSpans[mk.type]=mk.span.slice(); }
        const nameMc=maxCharsFor(nm.x, pg, 'name', nm.size, G.rows, oldFM);
        const nf={ role:'name', lines:G.spanLines, td_spans:[], x:round2(nm.x), y:round2(nm.y), size:Math.round(nm.size), max_chars:nameMc, id, page:pg, display };
        if(mset.length){ nf.markers=orderMarkers(mset); nf.markerSpans=markerSpans; nf.markerBase=[round2(baseX), round2(nm.y)]; }
        fields.push(nf);
        // desc: same x (±6), just below name
        const d=descs.filter(x=>Math.abs(x.x-nm.x)<6 && nm.y>x.y && nm.y-x.y<62).sort((a,b)=>b.y-a.y)[0];
        if(d){ d._used=true; const dMc=maxCharsFor(d.x, pg, 'desc', d.size, d.lines.map(l=>({text:l.text})), oldFM);
          fields.push({ role:'desc', line_spans:d.lines.map(l=>l.span.slice()), x:round2(d.x), y:round2(d.y), size:round2(d.size), max_chars:dMc, id:pg+':'+(idc++), page:pg, display:d.lines.map(l=>l.text).join('').replace(/\s+$/,'') }); }
        // prices: to the right, same row(s)
        const pr=prices.filter(x=> x.x>nm.x && x.x<nm.x+300 && x.y<=nm.y+6 && x.y>=nm.y-spanRows-7 && !x._used).sort((a,b)=>a.x-b.x);
        for(const p of pr){ p._used=true; fields.push({ role:'price', text:p.lines[0].text, tj_span:p.lines[0].span.slice(), tm_span:p.tmSpan.slice(), tm_vals:p.tmVals.slice(), x:round2(p.x), y:round2(p.y), size:round2(p.size), id:pg+':'+(idc++), page:pg }); }
      }
      pageFields[pg]={fields, counts:{names:names.length,descs:descs.length,prices:prices.length,markers:markers.length}};
    }
    if(VALIDATE){ validatePage0(pageFields[0].fields, oldFM); return; }
    // assemble output: keep old page0 fields verbatim (byte-identical page), rebuild page1
    const oldP0=oldFM.fields.filter(f=>f.page===0);
    const newFields=[...oldP0, ...pageFields[1].fields];
    const out=Object.assign({}, oldFM, { fields:newFields });
    out.sections=recomputeSections(oldFM.sections, newFields);
    fs.writeFileSync(OUT, JSON.stringify(out));
    console.log('page1 built:', JSON.stringify(pageFields[1].counts));
    console.log('page1 dishes:', pageFields[1].fields.filter(f=>f.role==='name').map(f=>f.display+(f.markers?' ['+f.markers.join(',')+']':'')).join(' | '));
    console.log('wrote', OUT, '('+newFields.length+' fields; p0='+oldP0.length+' p1='+pageFields[1].fields.length+')');
  });
}
function orderMarkers(set){ const O=['dairy','gluten','jain','spicy','new']; return O.filter(t=>set.includes(t)); }
function round2(v){ return Math.round(v*100)/100; }
// max_chars = per-line char capacity from the section geometry (roomier-text intent), never
// less than the longest baked line so the existing content always renders on its baked line count.
function maxCharsFor(x, pg, role, size, rows, oldFM){
  const sec=(oldFM.sections||[]).find(s=>s.page===pg && Math.abs(s.col_x-x)<6);
  const adv=0.63;
  let cap;
  if(role==='name'){ const w=sec? (sec.price_right - sec.col_x) : 210; cap=Math.floor(w/(size*adv)); }
  else { const w=sec? sec.divider_w : 235; cap=Math.floor(w/(size*adv)); }
  const longest=Math.max(1, ...rows.map(r=>rowLen(r)));
  return Math.max(cap, longest);
}
function rowLen(r){ // a row is either [runs] (name) or {text} (desc line)
  if(Array.isArray(r)) return r.reduce((a,x)=>a+(x.text||'').length,0);
  return (r.text||'').length;
}
function recomputeSections(oldSecs, fields){
  return oldSecs.map(sec=>{
    const ns=Object.assign({}, sec);
    const inSec=fields.filter(f=>f.page===sec.page && f.role==='name' && Math.abs(f.x-sec.col_x)<6);
    if(inSec.length){ const last=inSec.slice().sort((a,b)=>a.y-b.y)[0]; ns.last_id=last.id; ns.last_y=last.y; ns.last_name_lines=last.lines.length;
      const d=fields.find(f=>f.page===sec.page&&f.role==='desc'&&Math.abs(f.x-last.x)<6&&last.y>f.y&&last.y-f.y<62);
      ns.last_desc_lines=d?d.line_spans.length:(sec.last_desc_lines||1); }
    return ns;
  });
}
function validatePage0(built, oldFM){
  const oldP0=oldFM.fields.filter(f=>f.page===0);
  const on=oldP0.filter(f=>f.role==='name'), bn=built.filter(f=>f.role==='name');
  console.log('=== VALIDATE page0 ===');
  console.log('names: old',on.length,'built',bn.length);
  // match by display
  let ok=0, bad=0;
  for(const o of on){
    const b=bn.find(x=>x.display.replace(/\s+/g,' ')===o.display.replace(/\s+/g,' '));
    if(!b){ console.log('  MISSING name:',JSON.stringify(o.display)); bad++; continue; }
    const oSpan=JSON.stringify(o.lines), bSpan=JSON.stringify(b.lines);
    const posOk=Math.abs(b.x-o.x)<0.6 && Math.abs(b.y-o.y)<0.6;
    const spanOk=oSpan===bSpan;
    const mkOk=JSON.stringify(o.markers||[])===JSON.stringify(b.markers||[]);
    if(spanOk&&posOk&&mkOk) ok++; else { bad++; console.log('  DIFF',JSON.stringify(o.display),'span',spanOk,'pos',posOk,'mk',mkOk,'| old.mk',JSON.stringify(o.markers),'built.mk',JSON.stringify(b.markers),'| oldLines',oSpan,'builtLines',bSpan); }
  }
  console.log('name match ok:',ok,'bad:',bad);
  // prices
  const op=oldP0.filter(f=>f.role==='price'), bp=built.filter(f=>f.role==='price');
  console.log('prices: old',op.length,'built',bp.length);
  const od=oldP0.filter(f=>f.role==='desc'), bd=built.filter(f=>f.role==='desc');
  console.log('descs: old',od.length,'built',bd.length);
}
main().catch(e=>{console.error('THREW',e);process.exit(1);});
