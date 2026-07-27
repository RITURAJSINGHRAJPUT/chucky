// Aiko Drinks byte-level harness — loads the real engine in jsdom + pdf-lib,
// drives name/desc/price edits through regenerate(), asserts on output bytes.
const fs=require('fs'), path=require('path'), vm=require('vm');
const {JSDOM}=require('jsdom');
const PDFLib=require('pdf-lib');
const DIR=path.join(__dirname,'..','..','deploy','public','drinks');
const html=fs.readFileSync(path.join(DIR,'index.html'),'utf8');
const engine=(html.match(/<script>([\s\S]*?)<\/script>/g)||[]).map(s=>s.replace(/^<script>|<\/script>$/g,'')).find(s=>s.includes('PDFDocument'));

const dom=new JSDOM('<!doctype html><body><div id="boot"><div id="bootmsg"></div></div><span id="flagpill"></span><button id="export"></button><section id="editor"></section><div id="ptag"></div><canvas id="preview"></canvas><div id="busy"></div><div id="previewPane"></div><div id="fontnote"></div><div class="tabs"><button data-pg="1"></button><button data-pg="0"></button></div><div id="rail"></div><div id="q"></div><div id="scrim"></div>', {url:'http://localhost/'});
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

const epilogue=`;globalThis.__h={ regenerate, edits, get FM(){return FM;}, get FIELD(){return FIELD;}, ready:()=>!!(typeof FM!=='undefined'&&FM&&pageStreams.length) };`;
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
  const fields=H.FM.fields;
  const firstName=fields.find(f=>f.role==='name');
  const firstDesc=fields.find(f=>f.role==='desc');
  const firstPrice=fields.find(f=>f.role==='price');

  // baseline
  let b=await H.regenerate(); ok((await PDFLib.PDFDocument.load(b)).getPageCount()===2,'baseline: 2 pages');
  ok(str(b).indexOf('('+firstName.text+')')<0,'baseline: names still kerned (no plain literal yet)');

  // name edit
  H.edits[firstName.id]='ELDERFLOWER FIZZ';
  b=await H.regenerate();
  ok(str(b).indexOf('(ELDERFLOWER FIZZ)')>=0,'name edit spliced');
  // desc edit
  H.edits[firstDesc.id]='Elderflower, lime, soda';
  b=await H.regenerate();
  ok(str(b).indexOf('(Elderflower, lime, soda)')>=0,'desc edit spliced');
  // price edit
  H.edits[firstPrice.id]='350';
  b=await H.regenerate();
  ok(str(b).indexOf('(350)')>=0,'price edit spliced');
  ok((await PDFLib.PDFDocument.load(b)).getPageCount()===2,'edited PDF parses, 2 pages');

  // revert -> back to pristine (no plain literal for that name)
  delete H.edits[firstName.id]; delete H.edits[firstDesc.id]; delete H.edits[firstPrice.id];
  b=await H.regenerate();
  ok(str(b).indexOf('(ELDERFLOWER FIZZ)')<0,'revert: edit removed');

  // save an edited version for visual audit
  H.edits[firstName.id]='ELDERFLOWER FIZZ';
  H.edits[firstDesc.id]='Elderflower, lime, soda';
  H.edits[firstPrice.id]='350';
  b=await H.regenerate();
  fs.writeFileSync('/private/tmp/claude-501/-Users-apple/dd29cd90-79fd-49fd-9b88-6e90a1b2a4c4/scratchpad/drinks_edited.pdf', Buffer.from(b));
  console.log('wrote drinks_edited.pdf');

  console.log('\n'+(fail===0?'PASS':'FAIL')+' — '+pass+' passed, '+fail+' failed');
  process.exit(fail?1:0);
})().catch(e=>{console.error('THREW',e);process.exit(1);});
