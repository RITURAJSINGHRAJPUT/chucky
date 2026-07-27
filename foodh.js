// Boot a food editor (aiko/capiche) headless, apply text edits, write the output PDF.
const fs=require("fs"),path=require("path"),vm=require("vm");const {JSDOM}=require("jsdom");const PDFLib=require("pdf-lib");
const DIR=process.argv[2], OUT=process.argv[3], EDITS=JSON.parse(process.argv[4]);
const html=fs.readFileSync(path.join(DIR,"index.html"),"utf8");
const engine=(html.match(/<script>([\s\S]*?)<\/script>/g)||[]).map(s=>s.replace(/^<script>|<\/script>$/g,"")).find(s=>s.includes("PDFDocument")&&s.includes("regenerate"));
const dom=new JSDOM("<!doctype html><body><div id=\"boot\"><div id=\"bootmsg\"></div></div><span id=\"flagpill\"></span><button id=\"export\"></button><button id=\"persona\"></button><button id=\"savemenu\"></button><div id=\"membar\"></div><section id=\"editor\"></section><div id=\"ptag\"></div><canvas id=\"preview\"></canvas><div id=\"busy\"></div><div id=\"previewPane\"></div><div id=\"wrap\"></div><div id=\"fontnote\"></div><div id=\"rail\"><div id=\"tabs\"></div></div><input id=\"q\"><div id=\"scrim\"></div><span id=\"mascot\"></span><div id=\"brandname\"></div><div id=\"brandsub\"></div><div id=\"popover\"></div><div id=\"chuckysay\"></div><div id=\"celebrate\"><div class=\"cbline\"></div><div class=\"cbsub\"></div><div class=\"cbcat\"></div></div></body>",{url:"http://localhost/"});
const win=dom.window;global.window=win;global.document=win.document;global.navigator=win.navigator;
win.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});global.matchMedia=win.matchMedia;win.devicePixelRatio=1;
global.localStorage={getItem(){return null;},setItem(){},removeItem(){}};win.localStorage=global.localStorage;global.sessionStorage=global.localStorage;win.sessionStorage=global.localStorage;
global.PDFLib=PDFLib;win.PDFLib=PDFLib;
global.pdfjsLib={GlobalWorkerOptions:{},getDocument:()=>({promise:Promise.resolve({getPage:()=>Promise.resolve({getViewport:()=>({width:281,height:595}),render:()=>({promise:Promise.resolve()})}),destroy(){},numPages:4})})};win.pdfjsLib=global.pdfjsLib;
global.fetch=(f)=>{f=String(f).split("?")[0];const p=path.join(DIR,f);const buf=fs.readFileSync(p);return Promise.resolve({json:()=>Promise.resolve(JSON.parse(buf.toString("utf8"))),arrayBuffer:()=>Promise.resolve(buf.buffer.slice(buf.byteOffset,buf.byteOffset+buf.byteLength))});};
global.TextEncoder=TextEncoder;global.TextDecoder=TextDecoder;
const ctx=win;vm.createContext(ctx);["PDFLib","pdfjsLib","fetch","localStorage","sessionStorage","TextEncoder","TextDecoder","console","setTimeout","clearTimeout","matchMedia","devicePixelRatio"].forEach(k=>{ctx[k]=global[k]||win[k];});
ctx.window=win;ctx.document=win.document;ctx.globalThis=ctx;
vm.runInContext(engine+";globalThis.__h={get edits(){return edits;},set edits(v){edits=v;},get FM(){return FM;},regenerate,get persona(){return typeof persona!=='undefined'?persona:null;},set persona(v){ if(typeof persona!=='undefined') persona=v; },fitDesc:(typeof fitDesc!=='undefined'?fitDesc:null),maxLinesAt:(typeof maxLinesAt!=='undefined'?maxLinesAt:null),setMarkers:(id,arr)=>{ if(typeof markerEdits!=='undefined') markerEdits[id]=arr; else if(typeof allerEdits!=='undefined') allerEdits[id]=arr; },ready:()=>!!(typeof FM!=='undefined'&&FM&&pageStreams.length)};",ctx);
const H=ctx.__h;
(async()=>{
  for(let i=0;i<500&&!H.ready();i++)await new Promise(r=>setTimeout(r,25));
  if(!H.ready()){console.log("BOOT FAIL");process.exit(1);}
  const FIELD={}; for(const f of H.FM.fields) FIELD[f.id]=f;
  if(process.env.PERSONA && H.persona){ Object.assign(H.persona, JSON.parse(process.env.PERSONA)); }
  const MK=JSON.parse(process.argv[5]||'{}');
  for(const id in MK){ H.setMarkers(id, MK[id]); console.log('  markers',id,'->',MK[id].join(',')); }
  for(const id in EDITS){
    H.edits[id]=EDITS[id];
    const f=FIELD[id];
    if(f && H.fitDesc && f.role==='desc'){
      const fit=H.fitDesc(f, EDITS[id]);
      console.log(`  ${id}: size ${f.size}->${fit.size} cap=${H.maxLinesAt(f,fit.size)} baked=${f.line_spans.length} overflow=${fit.overflow}`);
      console.log(`    lines: ${JSON.stringify(fit.lines.filter(Boolean))}`);
    }
  }
  let b; try{ b=await H.regenerate(); }catch(e){ console.log("ERR",e.message); process.exit(1); }
  fs.writeFileSync(OUT, Buffer.from(b));
  console.log("wrote", OUT);
})().catch(e=>{console.log("THREW",e.message);process.exit(1);});
