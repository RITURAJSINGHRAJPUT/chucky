// Boot the Beshak editor headless, apply an edit state, write the resulting PDF.
//
//   node beshakh.js <out.pdf> '<EDITS_json>'
//   env: MARKERS='{"1:0":["dairy","jain"]}'  REMOVED='["0:0"]'  ADDED='[{"col":"c0","name":"…"}]'
//
// Same shape as foodh.js/churndh.js: run the SHIPPED index.html in a jsdom+vm sandbox so the test
// exercises the file that actually deploys, not a copy of it.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');
const PDFLib = require('pdf-lib');

const DIR = process.env.BESHAK_DIR || 'deploy/public/beshak';
const OUT = process.argv[2] || path.join(process.env.CHUCKY_TEST_OUT || 'test-output', 'beshak_out.pdf');
const EDITS = JSON.parse(process.argv[3] || '{}');

const SHELL = '<!doctype html><body>'
  + '<div id="boot"><div id="bootmsg"></div></div>'
  + '<span id="flagpill"></span><button class="prevtoggle"></button>'
  + '<button id="fullprev"></button><button id="export"></button><button id="publish"></button>'
  + '<input id="q"><div class="spacer"></div>'
  + '<nav class="rail" id="rail"><div class="tabs"><button data-pg="0"></button><button data-pg="1"></button></div></nav>'
  + '<section id="editor"></section>'
  + '<aside id="previewPane"><div class="plabel"><span id="ptag"></span></div>'
  + '<div id="wrap"><canvas id="preview"></canvas><div id="busy"></div></div></aside>'
  + '<div class="scrim" id="scrim"></div><div id="popover"></div></body>';

function sandbox() {
  const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
  const engine = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1]).find((s) => s.includes('PDFDocument') && s.includes('regenerate'));
  if (!engine) throw new Error('no engine script found in ' + DIR + '/index.html');

  const dom = new JSDOM(SHELL, { url: 'http://localhost/' });
  const win = dom.window;
  global.window = win; global.document = win.document; global.navigator = win.navigator;
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  global.matchMedia = win.matchMedia; win.devicePixelRatio = 1;
  const store = {};
  global.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
  win.localStorage = global.localStorage; global.sessionStorage = global.localStorage; win.sessionStorage = global.localStorage;
  global.PDFLib = PDFLib; win.PDFLib = PDFLib;
  // pdf.js is only used for the on-screen preview; a stub keeps boot from hanging headless
  global.pdfjsLib = {
    GlobalWorkerOptions: {},
    getDocument: () => ({ promise: Promise.resolve({ getPage: () => Promise.resolve({ getViewport: () => ({ width: 421, height: 595 }), render: () => ({ promise: Promise.resolve() }) }), destroy() {}, numPages: 2 }) }),
  };
  win.pdfjsLib = global.pdfjsLib;
  global.fetch = (f) => {
    const rel = String(f).split('?')[0];
    if (rel.startsWith('/api/')) return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
    const buf = fs.readFileSync(path.join(DIR, rel));
    return Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve(JSON.parse(buf.toString('utf8'))),
      arrayBuffer: () => Promise.resolve(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)),
    });
  };
  global.TextEncoder = TextEncoder; global.TextDecoder = TextDecoder;
  global.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);

  const ctx = win;
  vm.createContext(ctx);
  for (const k of ['PDFLib', 'pdfjsLib', 'fetch', 'localStorage', 'sessionStorage', 'TextEncoder', 'TextDecoder',
    'console', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'matchMedia', 'devicePixelRatio',
    'requestAnimationFrame', 'Blob', 'URL', 'alert', 'confirm', 'prompt']) {
    ctx[k] = global[k] !== undefined ? global[k] : win[k];
  }
  ctx.alert = () => {}; ctx.confirm = () => true; ctx.prompt = () => '';
  ctx.window = win; ctx.document = win.document; ctx.globalThis = ctx;

  const expose = ';globalThis.__h={'
    + 'get FM(){return FM;},'
    + 'get edits(){return edits;},'
    + 'get removed(){return removed;}, set removed(v){removed=v;},'
    + 'get added(){return added;}, set added(v){added=v;},'
    + 'get markerEdits(){return markerEdits;}, set markerEdits(v){markerEdits=v;},'
    + 'get pristine(){return PRISTINE;},'
    + 'regenerate, buildEditor, boot, wrapText, textWidth, markerSlots, fieldIssues, addedIssues, memSnapshot, memApply,'
    + 'ready:()=>!!(typeof FM!=="undefined" && FM && Object.keys(PRISTINE).length)};';
  vm.runInContext(engine + expose, ctx);
  return ctx.__h;
}

async function bootHarness() {
  const H = sandbox();
  for (let i = 0; i < 600 && !H.ready(); i++) await new Promise((r) => setTimeout(r, 25));
  if (!H.ready()) throw new Error('BOOT FAIL — engine never finished loading');
  return H;
}

module.exports = { bootHarness, DIR };

if (require.main === module) {
  (async () => {
    const H = await bootHarness();
    if (process.env.REMOVED) H.removed = JSON.parse(process.env.REMOVED);
    if (process.env.ADDED) H.added = JSON.parse(process.env.ADDED);
    if (process.env.MARKERS) H.markerEdits = JSON.parse(process.env.MARKERS);
    for (const id of Object.keys(EDITS)) H.edits[id] = EDITS[id];
    const bytes = await H.regenerate();
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, Buffer.from(bytes));
    console.log('wrote', OUT, bytes.length, 'bytes');
  })().catch((e) => { console.error('THREW', e && e.stack || e); process.exit(1); });
}
