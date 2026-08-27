// GET /api/bugs — list bug reports (for the /bugs/ dashboard). Gated by ?k=BUG_KEY.
import { cors, J, authed, listLive } from './lib/bugstore.mjs';
import { storeReady } from './lib/kv.mjs';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  const url = new URL(req.url);
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (req.method !== 'GET') return J({ ok: false, error: 'method not allowed' }, 405);
  if (!authed(url)) return J({ ok: false, error: 'forbidden' }, 403);
  if (!storeReady()) return J({ ok: false, error: 'store not configured' }, 500);

  const status = url.searchParams.get('status');
  const lite = url.searchParams.get('lite') === '1';
  const out = [];
  for (const r of await listLive()) {
    if (status && r.status !== status) continue;
    if (lite) delete r.shot;
    out.push(r);
  }
  out.sort((a, b) => b.t - a.t);
  return J({ bugs: out });
}
