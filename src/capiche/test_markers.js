// Marker-edit test: boot engine, toggle markers on several dishes, regenerate, save for render.
const fs=require('fs'), path=require('path'), vm=require('vm');
const {JSDOM}=require('jsdom'); const PDFLib=require('pdf-lib');
const DIR=path.join(__dirname,'..','..','deploy','public','capiche');
const html=fs.readFileSync(path.join(DIR,'index.html'),'utf8');
const engine=(html.match(/<script>([\s\S]*?)<\/script>/g)||[]).map(s=>s.replace(/^<script>|<\/script>$/g,'')).find(s=>s.includes('PDFDocument')&&s.includes('regenerate'));
const dom=new JSDOM('<!doctype html><body><div id="boot"><div id="bootmsg"></div></div><span id="flagpill"></span><button id="export"></button><section id="editor"></section><div id="ptag"></div><canvas id="preview"></canvas><div id="busy"></div><div id="previewPane"></div><div id="fontnote"></div><div id="rail"></div><input id="q"><div id="scrim"></div><div id="popover"></div><div id="celebrate"><div class="cbline"></div><div class="cbsub"></div></div><div id="chuckysay"></div><div class="tabs"><button data-pg="0" class="on"></button><button data-pg="1"></button></div></body>',{url:'http://localhost/'});
const win=dom.window; global.window=win; global.document=win.document; global.navigator=win.navigator;
win.matchMedia=win.matchMedia||(()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}}));
global.matchMedia=win.matchMedia; win.devicePixelRatio=1;
global.localStorage={_d:{},getItem(k){return this._d[k]||null;},setItem(k,v){this._d[k]=v;}}; win.localStorage=global.localStorage;
global.sessionStorage={_d:{},getItem(k){return this._d[k]||null;},setItem(k,v){this._d[k]=v;}}; win.sessionStorage=global.sessionStorage;
global.PDFLib=PDFLib; win.PDFLib=PDFLib;
global.pdfjsLib={GlobalWorkerOptions:{},getDocument:()=>({promise:Promise.resolve({getPage:()=>Promise.resolve({getViewport:()=>({width:842,height:595}),render:()=>({promise:Promise.resolve()})}),destroy(){},numPages:2})})};
win.pdfjsLib=global.pdfjsLib;
global.fetch=(f)=>{ f=String(f).split('?')[0]; const p=path.join(DIR,f); const buf=fs.readFileSync(p); return Promise.resolve({json:()=>Promise.resolve(JSON.parse(buf.toString('utf8'))),arrayBuffer:()=>Promise.resolve(buf.buffer.slice(buf.byteOffset,buf.byteOffset+buf.byteLength))}); };
global.TextEncoder=TextEncoder; global.TextDecoder=TextDecoder;
const epilogue=`;globalThis.__h={ get markerEdits(){return markerEdits;}, get FM(){return FM;}, regenerate, ready:()=>!!(typeof FM!=='undefined'&&FM&&pageStreams.length) };`;
const ctx=win; vm.createContext(ctx);
['PDFLib','pdfjsLib','fetch','localStorage','sessionStorage','TextEncoder','TextDecoder','console','setTimeout','clearTimeout','matchMedia','devicePixelRatio'].forEach(k=>{ ctx[k]=global[k]||win[k]; });
ctx.window=win; ctx.document=win.document; ctx.globalThis=ctx;
try{ vm.runInContext(engine+epilogue, ctx); }catch(e){ console.error('THREW',e); process.exit(1); }
const H=ctx.__h;
const P='/private/tmp/claude-501/-Users-apple/dd29cd90-79fd-49fd-9b88-6e90a1b2a4c4/scratchpad/';
(async()=>{
  for(let i=0;i<300 && !H.ready();i++) await new Promise(r=>setTimeout(r,25));
  if(!H.ready()){ console.log('BOOT FAILED'); process.exit(1); }
  const byName=n=>H.FM.fields.find(f=>f.role==='name'&&(f.display||'').toUpperCase().includes(n));
  const pom=byName('POMODORO'), ris=byName('TOMATO BUTTER RISOTTO'), ag=byName('AGLIO OLIO'), alf=byName('ALFREDO');
  // POMODORO [D G J] -> add spicy (ghaslet). RISOTTO [D G J N] -> drop new. AGLIO OLIO [D G] -> add jain+spicy+new. ALFREDO [D G J] -> drop gluten, add spicy.
  H.markerEdits[pom.id]=['dairy','gluten','jain','spicy'];
  H.markerEdits[ris.id]=['dairy','gluten','jain'];
  H.markerEdits[ag.id]=['dairy','gluten','jain','spicy','new'];
  H.markerEdits[alf.id]=['dairy','jain','spicy'];
  const b=await H.regenerate();
  fs.writeFileSync(P+'capiche_markers.pdf', Buffer.from(b));
  const doc=await PDFLib.PDFDocument.load(b); console.log('pages',doc.getPageCount());
  console.log('edited: POMODORO+ghaslet, RISOTTO−NEW, AGLIO OLIO+Jain+ghaslet+NEW, ALFREDO−gluten+ghaslet');
  process.exit(0);
})().catch(e=>{console.error('THREW',e);process.exit(1);});
