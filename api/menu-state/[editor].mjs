// GET  /api/menu-state/:editor            PUBLIC, no key  -> {editor,t,base,state} | 404
// POST /api/menu-state/:editor?k=PUBLISH_KEY   GATED         body:{state,base} -> {ok:true,t}
//
// Publish: persists a `memSnapshot()`-shaped edit-state overlay per editor, so any device opening
// that editor loads the last-published state instead of always starting from the pristine
// baseline PDF. The baseline PDF/fieldmap.json are never touched by this — this is purely the
// same JSON overlay that already gets applied on top of the pristine baseline every time
// regenerate() runs client-side (POST /api/bug already sends this exact shape as its `state`
// field today; this just gives it a permanent, editor-keyed destination instead of a 45-day-TTL
// bug-report record).
//
// GET is deliberately public while POST is gated — the inverse of the bug-report asymmetry, and
// intentional: the whole point of Publish is that any device sees the current menu with zero
// friction (gating the read would mean every staffer needs a secret just to open an editor), and
// the returned `state` isn't new information disclosure — it's the same class of data
// (dish names/prices) every editor already fetches unauthenticated via fieldmap.json+PDF. Only
// the write, which lets one action change what everyone else sees, carries real stakes.
//
// PUBLISH_KEY is a SEPARATE key from BUG_KEY, not reused — a leaked BUG_KEY today only exposes
// bug-report contents and triage state; if it also gated Publish, the same leak could silently
// overwrite the live menu on every device. Keeping them separate lets each be shared/rotated
// independently.
import { cors, J, authed, clampState, MAX_STATE } from '../lib/bugstore.mjs';
import { redis, storeReady } from '../lib/kv.mjs';

export const config = { runtime: 'edge' };

// the real MEM_BRAND values used across the 6 editors (drinks/index.html uses 'aiko-drinks', not
// 'drinks') — validated before building a key so this route can't be used to read/write arbitrary
// key names. Exported so tests can check the allowlist directly.
export const EDITORS = new Set(['capiche', 'aiko', 'churnd', 'aiko-drinks', 'capiche-surat', 'capiche-ahm', 'beshak']);
export const stateKey = (editor) => 'menu_state_' + editor;

// Validation/auth is checked BEFORE the store-configured check (not after) — a 404/403/405 should
// not depend on whether storage happens to be provisioned, and it means these routes are testable
// without a live store (see test/menustate.test.mjs).
export default async function handler(req) {
  const url = new URL(req.url);
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

  const editor = decodeURIComponent(url.pathname.split('/').pop() || '');
  if (!EDITORS.has(editor)) return J({ ok: false, error: 'unknown editor' }, 404);

  if (req.method === 'GET') {
    if (!storeReady()) return J({ ok: false, error: 'store not configured' }, 500);
    let rec;
    try { rec = await redis.get(stateKey(editor)); } catch { rec = null; }
    if (!rec) return J({ ok: false, error: 'not found' }, 404);
    return J(rec);
  }

  if (req.method === 'POST') {
    if (!authed(url, 'PUBLISH_KEY')) return J({ ok: false, error: 'forbidden' }, 403);
    const raw = await req.text();
    if (raw.length > MAX_STATE) return J({ ok: false, error: 'payload too large' }, 413);
    let body;
    try { body = JSON.parse(raw); } catch { return J({ ok: false, error: 'bad json' }, 400); }
    if (!storeReady()) return J({ ok: false, error: 'store not configured' }, 500);
    const t = Date.now();
    const rec = {
      editor, t,
      base: String(body.base || '').slice(0, 200),
      state: clampState(body.state),
    };
    await redis.set(stateKey(editor), rec);   // no TTL — stays published until the next Publish
    return J({ ok: true, t });
  }

  return J({ ok: false, error: 'method not allowed' }, 405);
}
