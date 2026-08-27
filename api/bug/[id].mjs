// POST|PATCH /api/bug/:id — update a bug record's triage fields (status/approved/resolution).
// Gated by ?k=BUG_KEY. Parses `id` from the URL path itself rather than relying on Vercel's
// dynamic-segment param extraction — the same defensive fallback already used identically in both
// deploy/worker.js and netlify/functions/api.mjs, so it doesn't matter whether that extraction
// works as expected here.
import { cors, J, authed, readRec, putBug, MAX_STATE, sanitizePatch } from '../lib/bugstore.mjs';
import { storeReady } from '../lib/kv.mjs';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  const url = new URL(req.url);
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (req.method !== 'POST' && req.method !== 'PATCH') return J({ ok: false, error: 'method not allowed' }, 405);
  if (!authed(url)) return J({ ok: false, error: 'forbidden' }, 403);
  if (!storeReady()) return J({ ok: false, error: 'store not configured' }, 500);

  const id = url.pathname.split('/').pop();
  const rec = await readRec(id);
  if (!rec) return J({ ok: false }, 404);

  const raw = await req.text();
  if (raw.length > MAX_STATE) return J({ ok: false, error: 'payload too large' }, 413);
  let patch;
  try { patch = JSON.parse(raw); } catch { return J({ ok: false, error: 'bad json' }, 400); }
  Object.assign(rec, sanitizePatch(patch));
  await putBug(id, rec);
  return J({ ok: true });
}
