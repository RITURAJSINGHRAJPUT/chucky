// The /bugs/ dashboard must neutralise hostile records that are ALREADY in the store.
//
// Server-side clamps stop new payloads, but records written before this change are still there and
// the dashboard has no idea where a record came from. So this drives the real render() from
// deploy/public/bugs/index.html in jsdom against poisoned records and asserts nothing executes and
// no attribute is broken out of.
//
//   node test/bugsdash.test.mjs
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { fileURLToPath } from 'url';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'deploy/public/bugs/index.html'), 'utf8');
const script = (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1];
if (!script) { console.log('dashboard script not found'); process.exit(1); }

// mirror the real page's controls — the script wires them up at load
const dom = new JSDOM('<!doctype html><body><div id="list"></div><span id="count"></span>' +
  '<button id="refresh"></button><button id="rekey"></button>' +
  '<span class="filt on" data-f="all"></span><span class="filt" data-f="new"></span>' +
  '<div class="lay" id="lay"><img id="layimg"></div></body>', { url: 'https://menu.example/bugs/' });
const win = dom.window;
let executed = false;
win.__pwned = () => { executed = true; };
win.alert = () => { executed = true; };
win.localStorage.setItem('chucky_bugkey', 'bk_secret');
win.prompt = () => 'bk_secret';
win.fetch = async () => ({ status: 200, json: async () => ({ bugs: [] }) });

// jsdom's window exposes `window` as a getter-only property, so run inside it rather than re-assigning
const ctx = vm.createContext(win);
vm.runInContext(script + ';window.__d={ set BUGS(v){ BUGS=v; }, render, esc, safeShot, safeUrl };', ctx);
const D = win.__d;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };

console.log('\n/bugs/ dashboard XSS neutralisation\n' + '-'.repeat(52));

const POISON = [
  { id: 'bug_1', t: Date.now(), status: 'new', editor: 'capiche', page: 0, desc: 'ok',
    shot: 'x" onerror="window.__pwned()" data-x="' },                                   // the original hole
  { id: 'bug_2', t: Date.now(), status: 'new', editor: '<img src=x onerror=window.__pwned()>',
    desc: '<script>window.__pwned()</script>', page: 1 },
  { id: 'bug_3', t: Date.now(), status: 'new', editor: 'aiko', desc: 'link',
    url: 'javascript:window.__pwned()' },
  { id: 'bug_4', t: Date.now(), status: '"><img src=x onerror=window.__pwned()>', editor: 'x', desc: 'y' },
  { id: 'bug_5', t: Date.now(), status: 'needs-auth', editor: 'x', desc: 'y',
    resolution: '</div><img src=x onerror=window.__pwned()>' },
  { id: '"><img src=x onerror=window.__pwned()>', t: Date.now(), status: 'needs-auth', editor: 'x', desc: 'y' },
  { id: 'bug_7', t: Date.now(), status: 'new', editor: 'x', desc: 'y',
    page: '<img src=x onerror=window.__pwned()>' },
  // a GENUINE report must still render fully — otherwise the hardening has broken the tool
  { id: 'bug_ok', t: Date.now(), status: 'new', editor: 'capiche', page: 0,
    desc: 'price is wrong on MARGHERITA',
    url: 'https://menu.example/capiche/',
    shot: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==' },
];

D.BUGS = POISON;
D.render();
const list = win.document.getElementById('list');

// jsdom does not run <img onerror> without resource loading, so assert on the DOM itself
ok(!executed, 'no injected handler executed during render');
ok(list.querySelectorAll('script').length === 0, 'no <script> element was created');
const withHandlers = [...list.querySelectorAll('*')].filter(el =>
  [...el.attributes].some(a => /^on/i.test(a.name)));
ok(withHandlers.length === 0, `no inline event handlers in the DOM (found ${withHandlers.length})`);

const imgs = [...list.querySelectorAll('img')];
ok(imgs.length === 1 && /^data:image\/png;base64,/.test(imgs[0].getAttribute('src') || ''),
   `exactly the one legitimate snapshot rendered, as an inline image (${imgs.length} imgs)`);

const hrefs = [...list.querySelectorAll('a')].map(a => a.getAttribute('href') || '');
ok(hrefs.length === 1 && /^https?:/.test(hrefs[0]),
   `exactly the one legitimate link rendered, http(s) (${hrefs.length} links)`);
ok(!list.innerHTML.includes('javascript:'), 'no javascript: URI survives into the markup');

// the payloads must still be VISIBLE as text — neutralised, not silently swallowed
ok(list.textContent.includes('<script>window.__pwned()</script>'),
   'a hostile description is shown as literal text');
ok(list.textContent.includes('snapshot rejected'), 'a rejected snapshot is reported, not hidden');

// and the key the attack targets is still only in localStorage
ok(!list.innerHTML.includes('bk_secret'), 'BUG_KEY never appears in rendered markup');

console.log('-'.repeat(52));
console.log(`  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
