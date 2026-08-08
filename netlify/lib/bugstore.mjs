// Bug-queue storage, ported from the Cloudflare Worker's KV binding (deploy/worker.js) to
// Netlify Blobs. getStore().set/get/list map almost 1:1 onto env.BUGS.put/get/list.
//
// THE ONE REAL DIFFERENCE: KV expired records itself via `{ expirationTtl: 60*60*24*45 }`.
// Netlify Blobs has NO native expiry, so nothing would ever age out and the queue would grow
// forever — silently, since it isn't an error. We therefore carry the 45-day window ourselves:
// every read path calls sweep(), which drops anything older. Records store `t` (ms epoch) already,
// so no schema change was needed.
import { getStore } from '@netlify/blobs';

export const TTL_MS = 60 * 60 * 24 * 45 * 1000;   // 45 days, matching the Worker
const PREFIX = 'bug_';

export const store = () => getStore('bugs');

export const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST,GET,PATCH,OPTIONS',
  'access-control-allow-headers': 'content-type',
};

export const J = (o, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json', ...cors } });

// Gate for the read/update routes. Same contract as the Worker: `?k=<BUG_KEY>` or 403.
// BUG_KEY now comes from the environment instead of being committed in wrangler.jsonc.
export const authed = (url) => {
  const k = process.env.BUG_KEY;
  return !!k && url.searchParams.get('k') === k;
};

export const readRec = async (s, key) => {
  try { return await s.get(key, { type: 'json' }); } catch { return null; }
};

// Load every live record, deleting expired ones as we go (our stand-in for KV's expirationTtl).
export async function listLive(s) {
  const { blobs } = await s.list({ prefix: PREFIX });
  const cutoff = Date.now() - TTL_MS;
  const out = [];
  for (const b of blobs) {
    const rec = await readRec(s, b.key);
    if (!rec) continue;
    if (typeof rec.t === 'number' && rec.t < cutoff) { await s.delete(b.key).catch(() => {}); continue; }
    out.push(rec);
  }
  return out;
}

export const newId = () => PREFIX + Date.now() + '_' + Math.random().toString(36).slice(2, 8);

/* ---- INPUT CLAMPS ---------------------------------------------------------------------------
   POST /api/bug is public and unauthenticated. These mirror deploy/worker.js EXACTLY — the two
   deployments must not drift, or one host stores what the other rejects. The /bugs/ dashboard
   renders these fields into markup and its operator's browser holds BUG_KEY in localStorage. */
export const MAX_BODY  = 1_200_000;   // whole request; a snapshot is the only large field
export const MAX_SHOT  =   900_000;   // ~660KB of image after base64
export const MAX_STATE =   200_000;   // serialised editor state; was previously UNBOUNDED

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
