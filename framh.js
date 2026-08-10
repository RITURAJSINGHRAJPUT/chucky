const fs=require("fs"),path=require("path"),vm=require("vm");const {JSDOM}=require("jsdom");const PDFLib=require("pdf-lib");
const DIR=process.argv[2], OUT=process.argv[3], KEY=process.argv[4], FR=JSON.parse(process.argv[5]);
const html=fs.readFileSync(path.join(DIR,"index.html"),"utf8");
const engine=(html.match(/<script>([\s\S]*?)<\/script>/g)||[]).map(s=>s.replace(/^<script>|<\/script>$/g,"")).find(s=>s.includes("PDFDocument")&&s.includes("regenerate"));
const dom=new JSDOM("<!doctype html><body><div id=\"boot\"><div id=\"bootmsg\"></div></div><span id=\"flagpill\"></span><button id=\"export\"></button><button id=\"savemenu\"></button><div id=\"membar\"></div><section id=\"editor\"></section><div id=\"ptag\"></div><canvas id=\"preview\"></canvas><div id=\"busy\"></div><div id=\"previewPane\"></div><div id=\"fontnote\"></div><div id=\"rail\"><div id=\"tabs\"></div></div><input id=\"q\"><div id=\"scrim\"></div><span id=\"mascot\"></span><div id=\"brandname\"></div><div id=\"brandsub\"></div></body>",{url:"http://localhost/"});
const win=dom.window;global.window=win;global.document=win.document;global.navigator=win.navigator;
win.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});global.matchMedia=win.matchMedia;win.devicePixelRatio=1;
win.requestAnimationFrame=cb=>setTimeout(()=>cb(Date.now()),0);win.cancelAnimationFrame=id=>clearTimeout(id);global.requestAnimationFrame=win.requestAnimationFrame;global.cancelAnimationFrame=win.cancelAnimationFrame;
global.localStorage={getItem(){return null;},setItem(){},removeItem(){}};win.localStorage=global.localStorage;global.sessionStorage=global.localStorage;win.sessionStorage=global.localStorage;
win.URL.createObjectURL=()=>"blob:test";win.URL.revokeObjectURL=()=>{};global.URL=win.URL;global.Blob=win.Blob;
// jsdom has no canvas/Image: make gradeImage fail fast so embedPhoto takes the raw-bytes path
win.Image=class{ constructor(){ setTimeout(()=>{ if(this.onerror) this.onerror(new Error("no image in jsdom")); },0); } set src(v){} get src(){return "";} };
global.Image=win.Image;
global.PDFLib=PDFLib;win.PDFLib=PDFLib;
global.pdfjsLib={GlobalWorkerOptions:{},getDocument:()=>({promise:Promise.resolve({getPage:()=>Promise.resolve({getViewport:()=>({width:281,height:595}),render:()=>({promise:Promise.resolve()})}),destroy(){},numPages:4})})};win.pdfjsLib=global.pdfjsLib;
global.fetch=(f)=>{f=String(f).split("?")[0];const p=path.join(DIR,f);const buf=fs.readFileSync(p);return Promise.resolve({json:()=>Promise.resolve(JSON.parse(buf.toString("utf8"))),arrayBuffer:()=>Promise.resolve(buf.buffer.slice(buf.byteOffset,buf.byteOffset+buf.byteLength))});};
global.TextEncoder=TextEncoder;global.TextDecoder=TextDecoder;
const ctx=win;vm.createContext(ctx);["PDFLib","pdfjsLib","fetch","localStorage","sessionStorage","TextEncoder","TextDecoder","console","setTimeout","clearTimeout","matchMedia","devicePixelRatio","URL","Blob","Image"].forEach(k=>{ctx[k]=global[k]||win[k];});
ctx.window=win;ctx.document=win.document;ctx.globalThis=ctx;
vm.runInContext(engine+";globalThis.__h={get photoUploads(){return photoUploads;},get specialsEdits(){return typeof specialsEdits!=='undefined'?specialsEdits:{};},get badgeEdits(){return typeof badgeEdits!=='undefined'?badgeEdits:{};},embedPhoto,regenerate,ready:()=>!!(typeof FM!=='undefined'&&FM&&pageStreams.length)};",ctx);
const H=ctx.__h;
(async()=>{
  for(let i=0;i<500&&!H.ready();i++)await new Promise(r=>setTimeout(r,25));
  if(!H.ready()){console.log("BOOT FAIL");process.exit(1);}
  // 4-quadrant fixture, generated on demand — this used to read '/tmp/frame_test.jpg', a file that
  // is not in the repo, so a clean checkout failed with an ENOENT that looked like a code bug.
  const bytes=fs.readFileSync(process.env.FRAME_JPEG || await require('./test/lib/fixture').frameTestJpeg());
  const file={type:'image/jpeg', arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)};
  await H.embedPhoto(KEY, file);
  const up=H.photoUploads[KEY];
  if(!up){console.log("EMBED FAIL");process.exit(1);}
  Object.assign(up, FR);
  console.log("  framing:", JSON.stringify({zoom:up.zoom,dx:up.dx,dy:up.dy,rot:up.rot}));
  fs.writeFileSync(OUT, Buffer.from(await H.regenerate()));
  console.log("  wrote", OUT);
})().catch(e=>{console.log("THREW",e.message);process.exit(1);});
