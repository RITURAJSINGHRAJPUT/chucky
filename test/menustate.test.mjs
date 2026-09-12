// Publish feature — /api/menu-state/:editor (api/menu-state/[editor].mjs).
//
// No live store is configured in this environment (no Upstash env vars), so this exercises every
// code path that resolves BEFORE a storage call is needed: the editor-name allowlist, method
// routing, and PUBLISH_KEY gating on POST — the handler is written so those checks all happen
// ahead of the store-configured check (see the comment in the route file). The one live-storage
// leg (an actual publish + read-back round trip) is not testable here and is called out in the
// plan for manual verification after deploy, same as the existing photo-handoff gap CLAUDE.md
// already documents as untestable in this environment.
//
//   node test/menustate.test.mjs
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const route = await import(pathToFileURL(path.join(ROOT, 'api/menu-state/[editor].mjs')).href);
const { default: handler, EDITORS, stateKey } = route;
const { clampState, MAX_STATE } = await import(pathToFileURL(path.join(ROOT, 'api/lib/bugstore.mjs')).href);

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };

const req = (method, pathname, { body, key } = {}) => {
  const url = 'https://x.example' + pathname + (key ? '?k=' + encodeURIComponent(key) : '');
  return new Request(url, { method, body: body !== undefined ? JSON.stringify(body) : undefined });
};

console.log('\nPublish API (menu-state)\n' + '-'.repeat(52));

// --- editor allowlist -----------------------------------------------------------------------
ok([...EDITORS].sort().join(',') === 'aiko,aiko-drinks,beshak,capiche,capiche-ahm,capiche-surat,churnd',
   'allowlist is exactly the 7 real MEM_BRAND values');

for (const editor of EDITORS) {
  ok(stateKey(editor) === 'menu_state_' + editor, `stateKey('${editor}') is namespaced correctly`);
}

{
  const r = await handler(req('GET', '/api/menu-state/not-a-real-editor'));
  ok(r.status === 404, 'GET on an unknown editor name -> 404 (never reaches storage)');
}
{
  const r = await handler(req('POST', '/api/menu-state/../../etc/passwd'));
  ok(r.status === 404, 'a path-traversal-shaped editor name is rejected, not sanitised-and-used');
}

// --- OPTIONS / CORS --------------------------------------------------------------------------
{
  const r = await handler(req('OPTIONS', '/api/menu-state/churnd'));
  ok(r.status === 200 || r.status === 204, 'OPTIONS preflight succeeds');
  ok(r.headers.get('access-control-allow-origin') === '*', 'CORS header present on preflight');
}

// --- method routing -------------------------------------------------------------------------
{
  const r = await handler(req('DELETE', '/api/menu-state/churnd'));
  ok(r.status === 405, 'unsupported method -> 405');
}

// --- POST gating: checked BEFORE the store, so this is testable with no live storage ---------
{
  const r = await handler(req('POST', '/api/menu-state/churnd', { body: { state: {}, base: 'v1' } }));
  ok(r.status === 403, 'POST with no ?k= -> 403 (forbidden), not silently accepted');
}
{
  const r = await handler(req('POST', '/api/menu-state/churnd', { body: { state: {}, base: 'v1' }, key: 'wrong' }));
  ok(r.status === 403, 'POST with a wrong key -> 403');
}
{
  // no PUBLISH_KEY env var is set in this test run, so authed() can never return true here —
  // this is exactly the same "unauthenticatable without the env var configured" shape the
  // existing bug-API gate already has, asserted the same way.
  ok(process.env.PUBLISH_KEY === undefined, 'sanity: PUBLISH_KEY is unset in this test run');
}

// --- GET is public: no key required, but note it still needs a configured store to actually
//     answer — asserted here only that it does NOT reject for lack of a key ------------------
{
  const r = await handler(req('GET', '/api/menu-state/churnd'));
  ok(r.status !== 403, 'GET requires no key (public read) — got ' + r.status + ', not 403');
  ok(r.status === 500, 'GET with no store configured fails clearly (500), not a silent empty 200');
  const body = await r.json();
  ok(body.ok === false && typeof body.error === 'string', 'failure body is a clear, typed error');
}

// --- payload size is bounded the same way bug-report state already is -------------------------
{
  const huge = { state: { blob: 'x'.repeat(MAX_STATE + 10) }, base: 'v1' };
  const r = await handler(req('POST', '/api/menu-state/churnd', { body: huge, key: 'irrelevant-still-403-first' }));
  // auth is checked before the size check too (see route order), so this still 403s — but the
  // clamp function itself must behave identically to the bug-report path regardless:
  ok(clampState(huge.state).truncated === true, 'an oversize state gets the same truncation marker as bug reports');
}

// --- bad JSON body on POST (auth still checked first) -----------------------------------------
{
  const url = 'https://x.example/api/menu-state/churnd?k=whatever';
  const r = await handler(new Request(url, { method: 'POST', body: 'not json{{{' }));
  ok(r.status === 403, 'malformed JSON with no valid key still 403s before ever parsing the body');
}

console.log('-'.repeat(52));
console.log(`  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
