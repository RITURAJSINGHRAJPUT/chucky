// Churn'd harness — boot the real engine headless, apply edits/add/remove, write the output PDF.
//
// Churn'd could not be tested at all before this. It is the only editor whose fieldmap uses `items[]`
// rather than `fields[]`, so foodh.js/foodh_ar.js (`for(const f of H.FM.fields)`) can never boot it;
// and its engine calls `document.querySelector('.brand')` at load, which the food DOM stub lacks.
// Both are handled here.
//
// Churn'd is also a 2-UP SHEET: every item carries TWO name_spans (x≈19.5 and x≈440.3) and three
// price tiers, so an edit must land in both copies. The engine does that; this harness lets us prove it.
//
//   node churndh.js <out.pdf> '<EDITS_json>'
//     EDITS keys follow the engine's own convention:  "n<id>" = name,  "p<id>_<col>" = price
//     env REMOVED='["<id>",...]'   env ADDED='[{sec,name,prices:[...]}]'
//
// Example:
//   node churndh.js out.pdf '{"n0":"BIRTHDAY BASH","p0_0":"199"}'

const fs = require('fs'), path = require('path'), vm = require('vm');
const { JSDOM } = require('jsdom');
const PDFLib = require('pdf-lib');
const { outFile } = require('./test/lib/out');

const DIR = path.join(__dirname, 'deploy', 'public', 'churnd');
const OUT = process.argv[2] || outFile('churnd_out.pdf');
const EDITS = JSON.parse(process.argv[3] || '{}');

const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
const engine = (html.match(/<script>([\s\S]*?)<\/script>/g) || [])
  .map(s => s.replace(/^<script>|<\/script>$/g, ''))
  .find(s => s.includes('PDFDocument') && s.includes('regenerate'));
if (!engine) { console.log('ENGINE NOT FOUND'); process.exit(1); }

// `.brand` is the one Churn'd-specific requirement: the engine appends its home link into it at load
// and would throw on null. Everything else mirrors foodh.js's stub.
const dom = new JSDOM('<!doctype html><body><div class="brand"></div>' +
  '<div id="boot"><div id="bootmsg"></div></div><span id="flagpill"></span><button id="export"></button>' +
  '<button id="savemenu"></button><div id="membar"></div><section id="editor"></section><div id="ptag"></div>' +
  '<canvas id="preview"></canvas><div id="busy"></div><div id="previewPane"></div><div id="wrap"></div>' +
  '<div id="fontnote"></div><div id="rail"><div id="tabs"></div></div><input id="q"><div id="scrim"></div>' +
  '<span id="mascot"></span><div id="brandname"></div><div id="brandsub"></div><div id="popover"></div>' +
  '<div id="chuckysay"></div><div id="celebrate"><div class="cbline"></div><div class="cbsub"></div>' +
  '<div class="cbcat"></div></div></body>', { url: 'http://localhost/' });

const win = dom.window;
global.window = win; global.document = win.document; global.navigator = win.navigator;
win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
global.matchMedia = win.matchMedia; win.devicePixelRatio = 1;
global.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
win.localStorage = global.localStorage; global.sessionStorage = global.localStorage; win.sessionStorage = global.localStorage;
global.PDFLib = PDFLib; win.PDFLib = PDFLib;
global.pdfjsLib = { GlobalWorkerOptions: {}, getDocument: () => ({ promise: Promise.resolve({
  getPage: () => Promise.resolve({ getViewport: () => ({ width: 281, height: 595 }), render: () => ({ promise: Promise.resolve() }) }),
  destroy() {}, numPages: 2 }) }) };
win.pdfjsLib = global.pdfjsLib;
global.fetch = (f) => { f = String(f).split('?')[0]; const buf = fs.readFileSync(path.join(DIR, f));
  return Promise.resolve({ json: () => Promise.resolve(JSON.parse(buf.toString('utf8'))),
    arrayBuffer: () => Promise.resolve(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)) }); };
global.TextEncoder = TextEncoder; global.TextDecoder = TextDecoder;
global.requestAnimationFrame = cb => setTimeout(cb, 0); win.requestAnimationFrame = global.requestAnimationFrame;
global.cancelAnimationFrame = id => clearTimeout(id); win.cancelAnimationFrame = global.cancelAnimationFrame;

const ctx = win; vm.createContext(ctx);
['PDFLib', 'pdfjsLib', 'fetch', 'localStorage', 'sessionStorage', 'TextEncoder', 'TextDecoder', 'console',
 'setTimeout', 'clearTimeout', 'matchMedia', 'devicePixelRatio', 'requestAnimationFrame', 'cancelAnimationFrame']
  .forEach(k => { ctx[k] = global[k] || win[k]; });
ctx.window = win; ctx.document = win.document; ctx.globalThis = ctx;

vm.runInContext(engine + `;globalThis.__h={
  get FM(){return FM;},
  get edits(){return edits;},
  get removed(){return removed;}, set removed(v){removed=v;},
  get added(){return added;}, set added(v){added=v;},
  get pageStreams(){return pageStreams;},
  regenerate,
  ready:()=>!!(typeof FM!=='undefined'&&FM&&pageStreams.length)};`, ctx);
const H = ctx.__h;

(async () => {
  for (let i = 0; i < 500 && !H.ready(); i++) await new Promise(r => setTimeout(r, 25));
  if (!H.ready()) { console.log('BOOT FAIL'); process.exit(1); }

  if (process.env.REMOVED) H.removed = new Set(JSON.parse(process.env.REMOVED));
  if (process.env.ADDED) H.added = JSON.parse(process.env.ADDED);
  for (const k in EDITS) { H.edits[k] = EDITS[k]; console.log('  edit', k, '->', JSON.stringify(EDITS[k])); }

  let bytes;
  try { bytes = await H.regenerate(); }
  catch (e) { console.log('THREW', e.message); process.exit(1); }

  fs.writeFileSync(OUT, Buffer.from(bytes));
  console.log('wrote', OUT, `(${bytes.length}B, ${H.FM.items.length} items, menu_page=${H.FM.menu_page})`);
})().catch(e => { console.log('THREW', e.message); process.exit(1); });
