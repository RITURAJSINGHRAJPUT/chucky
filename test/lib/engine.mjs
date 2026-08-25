// Boot an editor engine ONCE and drive it many times.
//
// Every existing harness (foodh.js, foodh_ar.js, markerh.js, …) spawns a process, boots jsdom,
// parses the PDF, exports one file and exits. That is fine for a handful of cases and hopeless for
// a combination matrix: 2^6 combinations across 37 dishes is thousands of exports, and the boot —
// not the export — is the expensive part.
//
// This is safe because `regenerate()` is REPLAYABLE: it splices every page from `ps.pristine`
// (a copy taken at load, deploy/public/capiche/index.html:2266) and reassigns the stream, so
// calling it again with different state reproduces the same result as a fresh boot. Verified by
// `sameAsColdBoot` in test/markers.matrix.mjs — if that assertion ever fails, this module is
// unsound and the matrix must go back to spawning processes.
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const fs = require('fs'), path = require('path'), vm = require('vm');

// Minimal DOM the engines touch on boot. Kept in one place so the six harnesses can stop each
// carrying their own drifted copy of it.
const SKELETON =
  '<!doctype html><body><div class="brand"></div><div id="boot"><div id="bootmsg"></div></div>' +
  '<span id="flagpill"></span><button id="export"></button><button id="persona"></button>' +
  '<button id="savemenu"></button><div id="membar"></div><section id="editor"></section>' +
  '<div id="ptag"></div><canvas id="preview"></canvas><div id="busy"></div><div id="previewPane"></div>' +
  '<div id="wrap"></div><div id="fontnote"></div><div id="rail"><div id="tabs"></div></div>' +
  '<input id="q"><div id="scrim"></div><span id="mascot"></span><div id="brandname"></div>' +
  '<div id="brandsub"></div><div id="popover"></div><div id="chuckysay"></div>' +
  '<div id="celebrate"><div class="cbline"></div><div class="cbsub"></div><div class="cbcat"></div></div></body>';

/* The engine is one big inline <script>; pick the one that actually holds the engine rather than
   the first, because the editors also carry small unrelated scripts. */
function engineSource(dir) {
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  const src = (html.match(/<script>([\s\S]*?)<\/script>/g) || [])
    .map(s => s.replace(/^<script>|<\/script>$/g, ''))
    .find(s => s.includes('PDFDocument') && s.includes('regenerate'));
  if (!src) throw new Error(`no engine <script> found in ${dir}/index.html`);
  return src;
}

/* Exposed inside the VM. Written as a string because it has to be evaluated in the engine's own
   scope to reach its module-level `let` bindings — they are not properties of any object.
   Every accessor is defensive: the six engines genuinely do not share variable names
   (markerEdits vs allerEdits, removed vs removedSet), and a missing one must read as absent,
   not throw during boot. */
const BRIDGE = `;globalThis.__engine = {
  ready: () => !!(typeof FM !== 'undefined' && FM && typeof pageStreams !== 'undefined' && pageStreams.length),
  get FM(){ return FM; },
  regenerate,
  get edits(){ return edits; },
  setEdit(id, v){ if(v == null) delete edits[id]; else edits[id] = v; },
  markerStore(){ return (typeof markerEdits !== 'undefined') ? markerEdits
                      : (typeof allerEdits !== 'undefined') ? allerEdits : null; },
  setMarkers(id, arr){ const m = this.markerStore(); if(!m) throw new Error('editor has no marker store'); m[id] = arr.slice(); },
  clearMarkers(id){ const m = this.markerStore(); if(m) delete m[id]; },
  get removed(){ return (typeof removed !== 'undefined') ? removed : null; },
  get added(){ return (typeof added !== 'undefined') ? added : null; },
  /* Module-level bindings cannot be set from outside the VM, so UI-level tests need an explicit
     setter to change page and re-render the editor. */
  setPage(p){ if(typeof activePage !== 'undefined') activePage = p; },
  rebuild(){ if(typeof buildEditor === 'function') buildEditor(); },
  /* Reset to a pristine edit state between matrix cases. Cheaper than re-booting and — because
     regenerate() never reads its own previous output — equivalent to one. */
  reset(){
    for(const k of Object.keys(edits)) delete edits[k];
    const m = this.markerStore(); if(m) for(const k of Object.keys(m)) delete m[k];
    if(typeof removed !== 'undefined' && removed && removed.clear) removed.clear();
    if(typeof added !== 'undefined' && Array.isArray(added)) added.length = 0;
    // ADD-ONS block (capiche): back to the baked rows + no heading
    try{ if(typeof addons !== 'undefined' && addons && typeof addonsInit === 'function') addonsInit(); }catch(_){}
  },
  bind: {},
};`;

/* Reach engine internals (MARKER_TYPES, iconBox, stampMarkers, …) for measurement.
 *
 * This MUST go through a closure, not eval. The engine is compiled by vm.runInContext, and V8 puts
 * a vm script's top-level const/let in a lexical scope that a direct eval inside that script cannot
 * resolve — `eval('MARKER_TYPES')` reports "not defined" while the getter `get FM(){ return FM; }`
 * two lines above returns the object perfectly well. Verified empirically; do not "simplify" this
 * back to eval.
 *
 * Each name gets a live getter (so callers see current values, not a boot-time snapshot) and is
 * probed once at bind time, so a name absent from this editor is simply omitted rather than
 * throwing during boot — the six engines do not share a vocabulary.
 */
const bindNames = (names) => names.map(n =>
  `try { (function(){ var _p = ${n}; Object.defineProperty(globalThis.__engine.bind, ${JSON.stringify(n)},` +
  ` { get: function(){ return ${n}; }, configurable: true }); })(); } catch(_) {}`).join('\n');

/* Internals the marker work needs to measure. Names absent from a given editor are skipped. */
export const DEFAULT_EXPOSE = [
  'MARKER_TYPES', 'MARKER_LABEL', 'MARKER_ICON', 'MK_DEFS', 'BRAND', 'AC', 'ADV', 'FIELD', 'ICONS',
  'SECTIONS', 'iconBox', 'stampMarkers', 'chilliTemplate', 'chilliWidth', 'markerBody', 'pageFonts',
  'itemsForPage', 'structuralForPage', 'dishMarkers', 'wrapName', 'wrapFor', 'mkSlotW', 'markerRunW',
  'markerGeom', 'layoutMarkers', 'clusterWidth', 'clusterStart', 'markerRoom', 'markerFits',
  'priceLeftFor', 'MARKER_GAP', 'MARKER_CLEAR', 'MARKER_LEAD', 'MARKER_MID',
  'ALLOWED', 'nameBudgetChars', 'wrapFor', 'isOverflow', 'fitDesc', 'maxLinesAt', 'wrapDesc',
  'secCapacity', 'sectionsForPage', 'dividersFor', 'PAGES', 'MARKER_LABEL',
  'nameAdv', 'nameWidth', 'readRunTracking', 'adoptStrayMarkers', 'pageText',
  'growPlan', 'nameLead', 'nameLineH', 'nameLines', 'nameMaxLines', 'bakedNameLines',
  'rowAnchor', 'colGeo', 'NAME_EXTRA_MAX',
];

/**
 * Boot one editor headless. Returns the bridge; call `regenerate()` as often as you like.
 * @param {string} dir  e.g. deploy/public/capiche
 * @param {object} [opts]  { expose: string[] } extra engine bindings to surface on `.bind`
 */
export async function bootEditor(dir, opts = {}) {
  const { JSDOM } = require('jsdom');
  const PDFLib = require('pdf-lib');

  const dom = new JSDOM(SKELETON, { url: 'http://localhost/' });
  const win = dom.window;

  /* Some Node globals (`navigator` since 21) are defined getter-only. The CJS harnesses assign
     over them and appear to succeed only because CJS is sloppy mode, where writing to a
     getter-only property silently no-ops; this module is ESM, i.e. strict, so the same line
     throws. Nothing is lost either way: the engine runs with `ctx === win`, so it resolves
     `navigator`/`document` off the JSDOM window regardless of what the host global holds. */
  const put = (obj, k, v) => {
    try { obj[k] = v; if (obj[k] === v) return; } catch (_) { /* fall through */ }
    try { Object.defineProperty(obj, k, { value: v, configurable: true, writable: true }); } catch (__) { /* leave it */ }
  };
  const setGlobal = (k, v) => put(global, k, v);
  const setWin = (k, v) => put(win, k, v);

  // The engines read these off the global scope, not off `window`.
  setGlobal('window', win); setGlobal('document', win.document); setGlobal('navigator', win.navigator);
  setWin('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  setGlobal('matchMedia', win.matchMedia); setWin('devicePixelRatio', 1);
  const store = { getItem: () => null, setItem() {}, removeItem() {} };
  setGlobal('localStorage', store); setWin('localStorage', store);
  setGlobal('sessionStorage', store); setWin('sessionStorage', store);
  setGlobal('PDFLib', PDFLib); setWin('PDFLib', PDFLib);
  // preview only; a real pdf.js would pull a CDN worker that sandboxes block (CLAUDE.md §5)
  const pdfjsLib = { GlobalWorkerOptions: {}, getDocument: () => ({ promise: Promise.resolve({
    getPage: () => Promise.resolve({ getViewport: () => ({ width: 281, height: 595 }),
                                     render: () => ({ promise: Promise.resolve() }) }),
    destroy() {}, numPages: 4 }) }) };
  setGlobal('pdfjsLib', pdfjsLib); setWin('pdfjsLib', pdfjsLib);
  const localFetch = (f) => {
    const buf = fs.readFileSync(path.join(dir, String(f).split('?')[0]));
    return Promise.resolve({
      json: () => Promise.resolve(JSON.parse(buf.toString('utf8'))),
      arrayBuffer: () => Promise.resolve(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)),
    });
  };
  setGlobal('fetch', localFetch);
  setGlobal('TextEncoder', TextEncoder); setGlobal('TextDecoder', TextDecoder);
  // framh.js needed a rAF stub; provide it always so an engine that grows one does not break here
  const raf = cb => setTimeout(cb, 0), caf = id => clearTimeout(id);
  setGlobal('requestAnimationFrame', raf); setWin('requestAnimationFrame', raf);
  setGlobal('cancelAnimationFrame', caf); setWin('cancelAnimationFrame', caf);

  /* The VM context IS the JSDOM window, so seed it explicitly rather than reading back off the
     host global — a getter-only host global may have refused the assignment above, and the engine
     must not silently fall back to a JSDOM stub (its `fetch` would then miss the fieldmap). */
  const ctx = win;
  vm.createContext(ctx);
  /* spliceBytes warns (rather than throws) when it drops an overlapping op, and a dropped op is a
     corrupt export — the CASSATA badge collision surfaced exactly this way. Capture the engine's
     console so a test can turn that warning into a hard failure instead of losing it to stdout. */
  const warnings = [];
  const vmConsole = Object.create(console);
  vmConsole.warn = (...a) => { warnings.push(a.map(String).join(' ')); };
  const provided = { PDFLib, pdfjsLib, fetch: localFetch, localStorage: store, sessionStorage: store,
                     TextEncoder, TextDecoder, console: vmConsole, setTimeout, clearTimeout, setInterval,
                     clearInterval, matchMedia: win.matchMedia, devicePixelRatio: 1,
                     requestAnimationFrame: raf, cancelAnimationFrame: caf };
  for (const [k, v] of Object.entries(provided)) put(ctx, k, v);
  put(ctx, 'window', win); put(ctx, 'document', win.document); put(ctx, 'globalThis', ctx);

  const expose = [...new Set([...DEFAULT_EXPOSE, ...(opts.expose || [])])];
  vm.runInContext(engineSource(dir) + BRIDGE + '\n' + bindNames(expose), ctx);
  const E = ctx.__engine;

  for (let i = 0; i < 800 && !E.ready(); i++) await new Promise(r => setTimeout(r, 25));
  if (!E.ready()) throw new Error(`engine did not boot: ${dir}`);
  E.warnings = warnings;
  E.takeWarnings = () => warnings.splice(0, warnings.length);
  return E;
}

/** Regenerate to a Buffer without touching disk — the matrix renders from memory. */
export async function exportBytes(E) {
  return Buffer.from(await E.regenerate());
}
