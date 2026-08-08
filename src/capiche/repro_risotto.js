// Reproduce the risotto-removal orphan: boot the real capiche engine in jsdom,
// remove TOMATO BUTTER RISOTTO (1:40), regenerate, write the edited PDF for a pymupdf render.
const fs=require('fs'), path=require('path'), vm=require('vm');
const {JSDOM}=require('jsdom');
const {outDir}=require('../../test/lib/out');   // repo-relative, gitignored artefact dir
const PDFLib=require('pdf-lib');
const DIR=path.join(__dirname,'..','..','deploy','public','capiche');
const html=fs.readFileSync(path.join(DIR,'index.html'),'utf8');
const scripts=(html.match(/<script>([\s\S]*?)<\/script>/g)||[]).map(s=>s.replace(/^<script>|<\/script>$/g,''));
const engine=scripts.find(s=>s.includes('PDFDocument')&&s.includes('regenerate'));

const dom=new JSDOM('<!doctype html><body>'+
 '<div id="boot"><div id="bootmsg"></div></div><span id="flagpill"></span><button id="export"></button>'+
 '<section id="editor"></section><div id="ptag"></div><canvas id="preview"></canvas><div id="busy"></div>'+
 '<div id="previewPane"></div><div id="fontnote"></div><div id="rail"></div><input id="q"><div id="scrim"></div>'+
 '<div id="popover"></div><div id="celebrate"><div class="cbline"></div><div class="cbsub"></div></div><div id="chuckysay"></div>'+
 '<div class="tabs"><button data-pg="0" class="on"></button><button data-pg="1"></button></div>'+
 '</body>', {url:'http://localhost/'});
const win=dom.window;
global.window=win; global.document=win.document; global.navigator=win.navigator;
win.matchMedia=win.matchMedia||(()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}}));
global.matchMedia=win.matchMedia; win.devicePixelRatio=1;
global.localStorage={_d:{},getItem(k){return this._d[k]||null;},setItem(k,v){this._d[k]=v;}}; win.localStorage=global.localStorage;
global.sessionStorage={_d:{},getItem(k){return this._d[k]||null;},setItem(k,v){this._d[k]=v;}}; win.sessionStorage=global.sessionStorage;
global.PDFLib=PDFLib; win.PDFLib=PDFLib;
global.pdfjsLib={GlobalWorkerOptions:{},getDocument:()=>({promise:Promise.resolve({getPage:()=>Promise.resolve({getViewport:()=>({width:842,height:595}),render:()=>({promise:Promise.resolve()})}),destroy(){},numPages:2})})};
win.pdfjsLib=global.pdfjsLib;
global.fetch=(f)=>{ f=String(f).split('?')[0]; const p=path.join(DIR,f); const buf=fs.readFileSync(p); return Promise.resolve({json:()=>Promise.resolve(JSON.parse(buf.toString('utf8'))),arrayBuffer:()=>Promise.resolve(buf.buffer.slice(buf.byteOffset,buf.byteOffset+buf.byteLength))}); };
global.TextEncoder=TextEncoder; global.TextDecoder=TextDecoder;

const epilogue=`;globalThis.__h={ get removed(){return removed;}, get markerEdits(){return markerEdits;}, set markerEdits(v){markerEdits=v;}, regenerate, structuralForPage, _blocks, _cluster, pageColumns, _badges, badgeOwner, badgeOps, get FM(){return FM;}, get ps(){return pageStreams;}, ready:()=>!!(typeof FM!=='undefined'&&FM&&pageStreams.length) };`;
const ctx=win; vm.createContext(ctx);
['PDFLib','pdfjsLib','fetch','localStorage','sessionStorage','TextEncoder','TextDecoder','console','setTimeout','clearTimeout','matchMedia','devicePixelRatio'].forEach(k=>{ ctx[k]=global[k]||win[k]; });
ctx.window=win; ctx.document=win.document; ctx.globalThis=ctx;
try{ vm.runInContext(engine+epilogue, ctx); }catch(e){ console.error('ENGINE THREW',e); process.exit(1); }
const H=ctx.__h;

(async()=>{
  for(let i=0;i<300 && !H.ready();i++) await new Promise(r=>setTimeout(r,25));
  if(!H.ready()){ console.log('BOOT FAILED (FM/pageStreams not ready)'); process.exit(1); }
  // baseline (no edits)
  let b=await H.regenerate();
  fs.writeFileSync(path.join(outDir(), 'capiche_baseline.pdf'), Buffer.from(b));
  // remove TOMATO BUTTER RISOTTO
  const target=H.FM.fields.find(f=>f.role==='name'&&f.page===1&&(f.display||'').toUpperCase().includes('TOMATO BUTTER RISOTTO'));
  console.log('target:', target && target.id, target && target.display);
  const P=(outDir()+path.sep);
  // Scenario A: remove TOMATO BUTTER RISOTTO (its badge must disappear, survivors keep theirs)
  H.removed.clear(); H.removed.add(target.id);
  b=await H.regenerate(); fs.writeFileSync(P+'capiche_removed.pdf', Buffer.from(b));
  // Scenario B: remove PINK BURRATA (its block also HOLDS risotto's badge — risotto's must survive)
  const pink=H.FM.fields.find(f=>f.role==='name'&&f.page===1&&(f.display||'').toUpperCase().includes('PINK BURRATA'));
  H.removed.clear(); H.removed.add(pink.id);
  { const pris=H.ps[1].pristine; const st=H.structuralForPage(1,pris); const bd=H.badgeOps(pris,1,st.removedSlots);
    console.log('PINK removedSlots:', JSON.stringify(st.removedSlots));
    console.log('deletes:', JSON.stringify(st.deletes));
    const badges=H._badges(pris);
    for(const bb of badges){ const own=H.badgeOwner(bb,1); console.log('  badge x',bb.x.toFixed(1),'y',bb.y.toFixed(1),'span',JSON.stringify(bb.span),'owner',own&&own.display,'inPinkDelete', st.deletes.some(d=>d[0]<=bb.span[0]&&bb.span[1]<=d[1])); }
    console.log('badgeOps:', bd.ops.map(o=>({s:o.s,e:o.e,del:o.rep.length===0})));
    // replicate the carve to see if risotto badge [314737,315840] ends up deleted
    const protect=[...bd.spans].sort((a,b)=>a[0]-b[0]); let dels=[];
    for(const d of st.deletes){ const inside=protect.filter(v=>d[0]<=v[0]&&v[1]<=d[1]).sort((a,b)=>a[0]-b[0]);
      if(!inside.length){dels.push(d);continue;} let cur=d[0]; for(const v of inside){ if(v[0]>cur)dels.push([cur,v[0]]); cur=v[1]; } if(cur<d[1])dels.push([cur,d[1]]); }
    const risotto=[314737,315840];
    console.log('final carved dels:', JSON.stringify(dels));
    console.log('risotto badge deleted by coarse?', dels.some(d=>d[0]<=risotto[0]&&risotto[1]<=d[1]));
    console.log('risotto badge partially overlapped?', dels.some(d=>!(d[1]<=risotto[0]||risotto[1]<=d[0]))); }
  b=await H.regenerate(); fs.writeFileSync(P+'capiche_pink.pdf', Buffer.from(b));
  console.log('wrote capiche_baseline.pdf + capiche_removed.pdf + capiche_pink.pdf');
  process.exit(0);
})().catch(e=>{console.error('THREW',e);process.exit(1);});
