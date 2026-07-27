// Band-model harness — boots the new drinks engine, exercises regenerate/add/remove/gradient,
// asserts on output bytes, saves rebuilt PDFs for a pymupdf viewer audit.
const fs=require('fs'), path=require('path'), vm=require('vm');
const {JSDOM}=require('jsdom');
const PDFLib=require('pdf-lib');
const DIR=path.join(__dirname,'..','..','deploy','public','drinks');
const html=fs.readFileSync(path.join(DIR,'index.html'),'utf8');
const engine=(html.match(/<script>([\s\S]*?)<\/script>/g)||[]).map(s=>s.replace(/^<script>|<\/script>$/g,'')).find(s=>s.includes('PDFDocument'));

const dom=new JSDOM('<!doctype html><body><div id="boot"><div id="bootmsg"></div></div><span id="flagpill"></span><button id="export"></button><section id="editor"></section><div id="ptag"></div><span id="ptag"></span><canvas id="preview"></canvas><div id="busy"></div><div id="previewPane"></div><div id="fontnote"></div><div class="tabs"><button data-pg="1" class="on"></button><button data-pg="0"></button></div><div id="rail"></div><input id="q"><div id="scrim"></div>', {url:'http://localhost/'});
const win=dom.window;
global.window=win; global.document=win.document; global.navigator=win.navigator;
win.matchMedia=win.matchMedia||(()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}}));
global.matchMedia=win.matchMedia; win.devicePixelRatio=1;
global.localStorage={_d:{},getItem(k){return this._d[k]||null;},setItem(k,v){this._d[k]=v;}}; win.localStorage=global.localStorage;
global.PDFLib=PDFLib; win.PDFLib=PDFLib;
global.pdfjsLib={GlobalWorkerOptions:{},getDocument:()=>({promise:Promise.resolve({getPage:()=>Promise.resolve({getViewport:()=>({width:280,height:595}),render:()=>({promise:Promise.resolve()})}),destroy(){},numPages:2})})};
win.pdfjsLib=global.pdfjsLib;
global.fetch=(f)=>{ f=String(f).split('?')[0]; const p=path.join(DIR,f); const buf=fs.readFileSync(p); return Promise.resolve({json:()=>Promise.resolve(JSON.parse(buf.toString('utf8'))),arrayBuffer:()=>Promise.resolve(buf.buffer.slice(buf.byteOffset,buf.byteOffset+buf.byteLength))}); };
global.TextEncoder=TextEncoder; global.TextDecoder=TextDecoder;

const epilogue=`;globalThis.__h={ regenerate, buildPage, gradientFor, get BANDS(){return BANDS;}, set BANDS(v){BANDS=v;}, get FM(){return FM;}, get GEO(){return GEO;}, ready:()=>!!(typeof FM!=='undefined'&&FM&&pageStreams.length&&BANDS&&BANDS.length) };`;
const ctx=win; vm.createContext(ctx);
['PDFLib','pdfjsLib','fetch','localStorage','TextEncoder','TextDecoder','console','setTimeout','clearTimeout','matchMedia','devicePixelRatio'].forEach(k=>{ ctx[k]=global[k]||win[k]; });
ctx.window=win; ctx.document=win.document; ctx.globalThis=ctx;
vm.runInContext(engine+epilogue, ctx);
const H=ctx.__h;

function str(b){ let s=''; for(let i=0;i<b.length;i++) s+=String.fromCharCode(b[i]); return s; }
let pass=0,fail=0;
const ok=(c,m)=>{ if(c){pass++;console.log('  ✓ '+m);} else {fail++;console.log('  ✗ '+m);} };

(async()=>{
  for(let i=0;i<200 && !H.ready();i++) await new Promise(r=>setTimeout(r,25));
  if(!H.ready()){ console.log('BOOT FAILED'); process.exit(1); }

  // baseline regenerate
  let b=await H.regenerate();
  ok((await PDFLib.PDFDocument.load(b)).getPageCount()===2,'baseline: rebuild parses, 2 pages');
  ok(str(b).indexOf('(KALA KHATTA SODA)')>=0,'baseline: first band name present as literal');
  ok(str(b).indexOf('(IYOSHI COLA)')>=0,'baseline: soft-drink line present');
  ok(str(b).indexOf(' re f')>=0,'baseline: gradient strips emitted (re f)');
  fs.writeFileSync('/private/tmp/claude-501/-Users-apple/dd29cd90-79fd-49fd-9b88-6e90a1b2a4c4/scratchpad/drinks_rebuilt.pdf', Buffer.from(b));

  // edit a name
  H.BANDS[0].name='ELDERFLOWER FIZZ';
  b=await H.regenerate();
  ok(str(b).indexOf('(ELDERFLOWER FIZZ)')>=0,'name edit rebuilds');
  H.BANDS[0].name='KALA KHATTA SODA';

  // ADD a drink
  const before=H.BANDS.filter(x=>x.type==='signature').length;
  const g=H.gradientFor('fresh mango and lime soda');
  H.BANDS.splice(before,0,{type:'signature',C0:g[0],C1:g[1],name:'MANGO LIME',desc:'Mango, lime, soda',price:'360'});
  b=await H.regenerate();
  ok(H.BANDS.filter(x=>x.type==='signature').length===before+1,'add: signature count +1');
  ok(str(b).indexOf('(MANGO LIME)')>=0,'add: new drink name in stream');
  ok((await PDFLib.PDFDocument.load(b)).getPageCount()===2,'add: still parses');
  fs.writeFileSync('/private/tmp/claude-501/-Users-apple/dd29cd90-79fd-49fd-9b88-6e90a1b2a4c4/scratchpad/drinks_added.pdf', Buffer.from(b));

  // gradient sanity: mango -> warm (R>G>B on C1 dark end roughly), distinct from neutral
  const gm=H.gradientFor('mango passionfruit');
  const gn=H.gradientFor('house special');
  ok(JSON.stringify(gm)!==JSON.stringify(gn),'gradient: flavor differs from neutral fallback');
  ok(gm[0][0]>gm[0][2],'gradient: mango start is warm (R>B)');

  // REMOVE a drink (the one we added)
  const idx=H.BANDS.findIndex(x=>x.name==='MANGO LIME');
  H.BANDS.splice(idx,1);
  b=await H.regenerate();
  ok(str(b).indexOf('(MANGO LIME)')<0,'remove: drink gone from stream');
  ok(H.BANDS.filter(x=>x.type==='signature').length===before,'remove: back to original count');

  // soft line edit
  const soft=H.BANDS.find(x=>x.type==='soft');
  soft.lines[2].price='300';
  b=await H.regenerate();
  ok(str(b).indexOf('(300)')>=0,'soft: price edit rebuilds');

  // color tweak reflected
  H.BANDS[1].C0=[0.1,0.9,0.2];
  b=await H.regenerate();
  ok(str(b).indexOf('0.1 0.9 0.2 rg')>=0,'gradient: manual C0 tweak emitted in strips');

  console.log('\n'+(fail===0?'PASS':'FAIL')+' — '+pass+' passed, '+fail+' failed');
  process.exit(fail?1:0);
})().catch(e=>{console.error('THREW',e);process.exit(1);});
