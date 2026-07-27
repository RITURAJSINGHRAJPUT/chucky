// Standalone test of the NEW-badge parser against the real capiche pristine stream.
const fs=require('fs'), path=require('path'), zlib=require('zlib');
const DIR=path.join(__dirname,'..','..','deploy','public','capiche');
const PDFLib=require('pdf-lib');

// ---- the parser under test (will be ported into index.html) ----
function _badges(bytes){
  const s=(typeof bytes==='string')?bytes:new TextDecoder('latin1').decode(bytes);
  // every filled path part: q 1 0 0 1 X Y cm ... f Q  (flat, no nested Q)
  const partRe=/q 1 0 0 1 (-?[\d.]+) (-?[\d.]+) cm\n(?:[^Q]*?)\nf\nQ/g;
  const parts=[]; let m;
  while((m=partRe.exec(s))){
    // color op immediately preceding this part
    const pre=s.slice(Math.max(0,m.index-40), m.index);
    const red=/0 0\.988 1 0 k\s*$/.test(pre);
    const black=/0 0 0 0 k\s*$/.test(pre);
    parts.push({s:m.index, e:m.index+m[0].length, x:+m[1], y:+m[2], red, black,
                colStart: red? m.index-pre.length+pre.search(/0 0\.988 1 0 k\s*$/) : m.index});
  }
  const badges=[];
  for(let i=0;i<parts.length;i++){
    const p=parts[i]; if(!p.red) continue;                 // starburst must be red
    if(p.e-p.s > 900) continue;                            // decor blobs are big; real starburst ~473B
    // gather the 3 letter parts: contiguous in the stream right after the starburst, sitting on it
    let j=i+1, lo=p.s, hi=p.e, letters=0, prevEnd=p.e;
    while(j<parts.length && letters<3){
      const q=parts[j];
      if(q.red) break;
      if(q.s-prevEnd<150 && Math.abs(q.y-p.y)<9 && q.x>=p.x-32 && q.x<=p.x+40 && (q.e-q.s)<900){ lo=Math.min(lo,q.s); hi=Math.max(hi,q.e); prevEnd=q.e; letters++; j++; }
      else break;
    }
    badges.push({span:[Math.min(p.colStart,lo), hi], x:p.x, y:p.y, letters});
    i=j-1;
  }
  return badges;
}

// ---- read page 1 pristine (uncompressed capiche.pdf) ----
(async()=>{
  const bytes=new Uint8Array(fs.readFileSync(path.join(DIR,'capiche.pdf')));
  const doc=await PDFLib.PDFDocument.load(bytes);
  const fm=JSON.parse(fs.readFileSync(path.join(DIR,'fieldmap.json'),'utf8'));
  for(const pg of [0,1]){
    const page=doc.getPage(pg);
    const ref=page.node.get(PDFLib.PDFName.of('Contents'));
    const stream=doc.context.lookup(ref);
    const pris=stream.contents;
    const badges=_badges(pris);
    console.log(`\n=== page ${pg}: ${badges.length} NEW badges ===`);
    const names=fm.fields.filter(f=>f.page===pg&&f.role==='name');
    for(const b of badges){
      // owner: name in the SAME column (badge to the right, within ~210pt), nearest |dy|
      let best=null,bd=1e9;
      for(const nf of names){ const dy=Math.abs(nf.y-b.y); const dx=b.x-nf.x; if(dx<-4||dx>270) continue; const d=dy+dx*0.05; if(dy<16 && d<bd){bd=d;best=nf;} }
      console.log(`  badge x=${b.x.toFixed(1)} y=${b.y.toFixed(1)} letters=${b.letters} span=[${b.span[0]},${b.span[1]}] len=${b.span[1]-b.span[0]} -> ${best?best.display+' ('+best.id+')':'?? DROP (decor/no owner)'}`);
    }
  }
})();
