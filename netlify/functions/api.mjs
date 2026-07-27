// Bug-report API — a direct port of deploy/worker.js's routing onto Netlify Functions v2.
// Kept as ONE router (rather than a file per route) so it can be diffed against the Worker at a
// glance; the client contract in the editors and /bugs/ is unchanged:
//   POST   /api/bug          {editor,page,desc,url,state,shot} -> {ok,id}
//   GET    /api/bugs?k=      -> {bugs:[...]}   (supports &status= and &lite=1)
//   POST   /api/bug/:id?k=   merge patch into a record
// Static assets are served by Netlify from deploy/public (see netlify.toml), which is what the
// Worker's final `env.ASSETS.fetch(request)` fallback did.
import { store, listLive, readRec, newId, cors, J, authed } from '../lib/bugstore.mjs';

// When this function returns a non-2xx, Netlify retries the static-resolution chain — the same
// request arrives again as /api/bugs.html, /api/bugs.htm, /api/bugs/index.html, /api/bugs/index.htm
// — and each retry re-enters here. Without normalising, those retries match no route, fall to the
// 404 at the bottom, and THAT is the response the client ends up with: a wrong-key 403 silently
// became a 404, which breaks the /bugs/ dashboard's `if(r.status===403)` "Wrong key" branch.
// Stripping the suffixes makes every retry produce the same answer as the original request.
const routePath = (p) => p.replace(/\/index\.html?$/, '').replace(/\.html?$/, '') || '/';

export default async (req, context) => {
  const url = new URL(req.url);
  const path = routePath(url.pathname);
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  const s = store();

  // report a bug (from the editor) — public
  if (path === '/api/bug' && req.method === 'POST') {
    try {
      const b = await req.json();
      const id = newId();
      // identical clamps to the Worker — these bound what an editor can push into the store
      const rec = {
        id, t: Date.now(), status: 'new',
        editor: String(b.editor || '').slice(0, 60),
        page: b.page ?? null,
        desc: String(b.desc || '').slice(0, 2000),
        url: String(b.url || '').slice(0, 300),
        state: (b.state && typeof b.state === 'object') ? b.state : null,
        shot: (typeof b.shot === 'string' && b.shot.length < 900000) ? b.shot : null,
      };
      await s.setJSON(id, rec);
      return J({ ok: true, id });
    } catch (e) { return J({ ok: false, error: String(e) }, 400); }
  }

  // list / read bugs (for the fixing agent + the /bugs/ dashboard) — gated by ?k=BUG_KEY
  if (path === '/api/bugs' && req.method === 'GET') {
    if (!authed(url)) return J({ ok: false, error: 'forbidden' }, 403);
    const status = url.searchParams.get('status');
    const lite = url.searchParams.get('lite') === '1';
    const out = [];
    for (const r of await listLive(s)) {
      if (status && r.status !== status) continue;
      if (lite) delete r.shot;
      out.push(r);
    }
    out.sort((a, b) => b.t - a.t);
    return J({ bugs: out });
  }

  // update a bug (agent marks triaged/fixed) — gated
  if (path.startsWith('/api/bug/') && (req.method === 'POST' || req.method === 'PATCH')) {
    if (!authed(url)) return J({ ok: false, error: 'forbidden' }, 403);
    const id = context.params?.id || path.split('/').pop();
    const rec = await readRec(s, id);
    if (!rec) return J({ ok: false }, 404);
    Object.assign(rec, await req.json());
    await s.setJSON(id, rec);
    return J({ ok: true });
  }

  return J({ ok: false, error: 'not found' }, 404);
};

export const config = { path: ['/api/bug', '/api/bugs', '/api/bug/:id'] };
