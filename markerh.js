// Boot a Capiche drinks editor headless, apply marker/add/remove scenarios, write output PDFs.
const fs=require("fs"),path=require("path"),vm=require("vm");const {JSDOM}=require("jsdom");const PDFLib=require("pdf-lib");
const DIR=process.argv[2];       // editor dir (deploy/public/capiche-surat)
const OUT=process.argv[3];       // output prefix
const SCEN=JSON.parse(process.argv[4]);  // [{name, page, removed:[idx], markers:{idx:[types]}, added:[{name,desc,price,markers}]}]
const html=fs.readFileSync(path.join(DIR,"index.html"),"utf8");
const engine=(html.match(/<script>([\s\S]*?)<\/script>/g)||[]).map(s=>s.replace(/^<script>|<\/script>$/g,"")).find(s=>s.includes("PDFDocument")&&s.includes("regenerate"));
const dom=new JSDOM("<!doctype html><body><div id=\"boot\"><div id=\"bootmsg\"></div></div><span id=\"flagpill\"></span><button id=\"export\"></button><button id=\"savemenu\"></button><div id=\"membar\"></div><section id=\"editor\"></section><div id=\"ptag\"></div><canvas id=\"preview\"></canvas><div id=\"busy\"></div><div id=\"previewPane\"></div><div id=\"fontnote\"></div><div id=\"rail\"><div id=\"tabs\"></div></div><input id=\"q\"><div id=\"scrim\"></div><span id=\"mascot\"></span><div id=\"brandname\"></div><div id=\"brandsub\"></div></body>",{url:"http://localhost/"});
const win=dom.window;global.window=win;global.document=win.document;global.navigator=win.navigator;
win.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});global.matchMedia=win.matchMedia;win.devicePixelRatio=1;
global.localStorage={getItem(){return null;},setItem(){},removeItem(){}};win.localStorage=global.localStorage;global.sessionStorage=global.localStorage;win.sessionStorage=global.localStorage;
global.PDFLib=PDFLib;win.PDFLib=PDFLib;global.pdfjsLib={GlobalWorkerOptions:{},getDocument:()=>({promise:Promise.resolve({getPage:()=>Promise.resolve({getViewport:()=>({width:281,height:595}),render:()=>({promise:Promise.resolve()})}),destroy(){},numPages:4})})};win.pdfjsLib=global.pdfjsLib;
global.fetch=(f)=>{f=String(f).split("?")[0];const p=path.join(DIR,f);const buf=fs.readFileSync(p);return Promise.resolve({json:()=>Promise.resolve(JSON.parse(buf.toString("utf8"))),arrayBuffer:()=>Promise.resolve(buf.buffer.slice(buf.byteOffset,buf.byteOffset+buf.byteLength))});};
global.TextEncoder=TextEncoder;global.TextDecoder=TextDecoder;
global.requestAnimationFrame=cb=>setTimeout(cb,0);win.requestAnimationFrame=global.requestAnimationFrame;   // buildEditor's auto-growing fields use rAF
const ctx=win;vm.createContext(ctx);["PDFLib","pdfjsLib","fetch","localStorage","sessionStorage","TextEncoder","TextDecoder","console","setTimeout","clearTimeout","matchMedia","devicePixelRatio","requestAnimationFrame"].forEach(k=>{ctx[k]=global[k]||win[k];});
ctx.window=win;ctx.document=win.document;ctx.globalThis=ctx;
vm.runInContext(engine+";globalThis.__h={get removed(){return removed;},set removed(v){removed=v;},get added(){return added;},set added(v){added=v;},get markerEdits(){return markerEdits;},set markerEdits(v){markerEdits=v;},get badgeEdits(){return typeof badgeEdits!=='undefined'?badgeEdits:{};},set badgeEdits(v){ if(typeof badgeEdits!=='undefined') badgeEdits=v; },get specialsEdits(){return typeof specialsEdits!=='undefined'?specialsEdits:{};},set specialsEdits(v){ if(typeof specialsEdits!=='undefined') specialsEdits=v; },get edits(){return edits;},set edits(v){edits=v;},get FM(){return FM;},regenerate,ready:()=>!!(typeof FM!=='undefined'&&FM&&pageStreams.length)};",ctx);const H=ctx.__h;
(async()=>{
  for(let i=0;i<400&&!H.ready();i++)await new Promise(r=>setTimeout(r,25));
  if(!H.ready()){console.log("BOOT FAIL");process.exit(1);}
  for(const sc of SCEN){
    H.removed=new Set(); H.added={}; H.markerEdits={}; H.edits={}; H.badgeEdits={}; H.specialsEdits={};   // reset ALL state between scenarios
    // page-key schemas differ: capiche-surat/ahm use `menu_pages[]`, the Aiko drinks editor uses a
    // singular `menu_page`. Reading only the first made this harness unable to boot /drinks/ at all.
    const pg = sc.page!=null? sc.page : (H.FM.menu_pages ? H.FM.menu_pages[0] : H.FM.menu_page);
    (sc.removed||[]).forEach(idx=> H.removed.add(pg+":"+idx));
    if(sc.markers) for(const k in sc.markers) H.markerEdits[pg+":"+k]=sc.markers[k];
    if(sc.badges) for(const k in sc.badges) H.badgeEdits[pg+":"+k]=sc.badges[k];
    if(sc.specials) for(const k in sc.specials) H.specialsEdits[pg+":"+k]=sc.specials[k];
    if(sc.edits) for(const k in sc.edits) H.edits[pg+":"+k]=sc.edits[k];
    if(sc.added&&sc.added.length) H.added[pg]=sc.added;
    let b; try{ b=await H.regenerate(); }catch(e){ console.log(sc.name,"ERR",e.message); continue; }
    fs.writeFileSync(OUT+"_"+sc.name+".pdf", Buffer.from(b));
    console.log("wrote",sc.name);
  }
  console.log("done", SCEN.length);
})().catch(e=>{console.log("THREW",e.message);process.exit(1);});
