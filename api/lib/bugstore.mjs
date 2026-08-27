// Bug-queue storage for Vercel — the third copy of this contract (Cloudflare Worker:
// deploy/worker.js, Netlify: netlify/lib/bugstore.mjs, this one). Deliberately a separate copy,
// not a shared import across the three hosts: netlify/lib/bugstore.mjs's own header comment
// already establishes the pattern here ("mirror deploy/worker.js EXACTLY... must not drift, or
// one host stores what the other rejects") via a drift-guard test (test/bugapi.test.mjs), not
// extraction — a shared module would need to work unmodified inside three different runtimes'
// module resolution for ~40 lines of pure functions, which isn't worth the coupling.
//
// Storage: Upstash Redis (api/lib/kv.mjs) instead of Cloudflare KV / Netlify Blobs. Unlike the
// Netlify port (which had to hand-roll TTL sweeping because Blobs has no expiry), Redis has native
// per-key TTL, so the 45-day bug-record expiry here is real (SET ... EX), not app-code-simulated.
// The `t` field and the defensive filter in listLive() are still kept as cheap insurance.
import { redis } from './kv.mjs';

export const TTL_S = 60 * 60 * 24 * 45;   // 45 days, matching both other hosts
const PREFIX = 'bug_';

// NOTE: the Worker's CORS methods list omits PATCH even though /api/bug/:id accepts it (a
// pre-existing minor bug on that host, not backported here or to the Netlify copy — see the plan
// this was built from). This is a new deploy target with no existing behaviour to preserve, so
// this copy is simply correct from the start.
export const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST,GET,PATCH,OPTIONS',
  'access-control-allow-headers': 'content-type',
};

export const J = (o, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json', ...cors } });

// Gate for the read/update bug routes: `?k=<BUG_KEY>` or 403. Generic over the env var name so
// the menu-state (Publish) routes can reuse this with a different, separate key (PUBLISH_KEY).
export const authed = (url, envVar = 'BUG_KEY') => {
  const k = process.env[envVar];
  return !!k && url.searchParams.get('k') === k;
};

export const readRec = async (key) => {
  try { return await redis.get(key); } catch { return null; }
};

// Load every live bug record, deleting expired ones as we go — same defensive sweep the Netlify
// port does, kept here even though Redis TTL should already have removed them; a record that
// somehow missed its TTL (e.g. write raced a crash before the EX landed) shouldn't linger forever.
export async function listLive() {
  const keys = await redis.keys(PREFIX + '*');
  const cutoff = Date.now() - TTL_S * 1000;
  const out = [];
  for (const key of keys) {
    const rec = await readRec(key);
    if (!rec) continue;
    if (typeof rec.t === 'number' && rec.t < cutoff) { await redis.del(key).catch(() => {}); continue; }
    out.push(rec);
  }
  return out;
}

export const newId = () => PREFIX + Date.now() + '_' + Math.random().toString(36).slice(2, 8);

export const putBug = (key, rec) => redis.set(key, rec, { ex: TTL_S });

/* ---- INPUT CLAMPS ---------------------------------------------------------------------------
   POST /api/bug is public and unauthenticated. These mirror deploy/worker.js and
   netlify/lib/bugstore.mjs EXACTLY — three hosts must not drift, or one stores what another
   rejects. test/bugapi.test.mjs asserts all three agree. */
export const MAX_BODY  = 1_200_000;   // whole request; a snapshot is the only large field
export const MAX_SHOT  =   900_000;   // ~660KB of image after base64
export const MAX_STATE =   200_000;   // serialised editor state

// a snapshot must be an inline raster image — never data:text/html, never a bare string
export const safeShot = (s) => (typeof s === 'string' && s.length <= MAX_SHOT &&
  /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(s)) ? s : null;

// links are opened by the dashboard operator; http(s) only, and bounded
export const safeUrl = (u) => {
  if (typeof u !== 'string' || !u) return '';
  try { const x = new URL(u); return (x.protocol === 'http:' || x.protocol === 'https:') ? u.slice(0, 300) : ''; }
  catch { return ''; }
};

// keep the editor state, but never let it grow the record without bound
export const clampState = (s) => {
  if (!s || typeof s !== 'object') return null;
  try { const j = JSON.stringify(s); return j.length > MAX_STATE ? { truncated: true, bytes: j.length } : s; }
  catch { return null; }
};

// Only triage fields are writable on PATCH — prevents a key-holder from rewriting an entire
// record (re-injecting a shot/url the POST clamps reject, overwriting id, etc).
export const STATUSES = new Set(['new', 'triaged', 'fixed', 'needs-auth']);
export const sanitizePatch = (b) => {
  const out = {};
  if (b && typeof b === 'object') {
    if (typeof b.status === 'string' && STATUSES.has(b.status)) out.status = b.status;
    if (typeof b.approved === 'boolean') out.approved = b.approved;
    if (typeof b.resolution === 'string') out.resolution = b.resolution.slice(0, 2000);
  }
  return out;
};
