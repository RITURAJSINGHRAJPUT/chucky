// POST /api/bug — report a bug from an editor. PUBLIC and unauthenticated, so everything here is
// hostile input; clamped at the door. Third port of this route (Worker: deploy/worker.js,
// Netlify: netlify/functions/api.mjs) — see api/lib/bugstore.mjs for why this stays a separate copy.
import { cors, J, newId, putBug, MAX_BODY, safeShot, safeUrl, clampState } from './lib/bugstore.mjs';
import { storeReady } from './lib/kv.mjs';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (req.method !== 'POST') return J({ ok: false, error: 'method not allowed' }, 405);
  if (!storeReady()) return J({ ok: false, error: 'store not configured' }, 500);

  try {
    const raw = await req.text();
    if (raw.length > MAX_BODY) return J({ ok: false, error: 'payload too large' }, 413);
    const b = JSON.parse(raw);
    const id = newId();
    const rec = {
      id, t: Date.now(), status: 'new',
      editor: String(b.editor || '').slice(0, 60),
      page: Number.isFinite(+b.page) ? +b.page : null,
      desc: String(b.desc || '').slice(0, 2000),
      url: safeUrl(b.url),
      state: clampState(b.state),
      shot: safeShot(b.shot),
    };
    await putBug(id, rec);
    return J({ ok: true, id });
  } catch (e) {
    return J({ ok: false, error: String(e) }, 400);
  }
}
