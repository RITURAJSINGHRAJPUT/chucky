// bookends-chucky worker: bug-report API in front of the static-asset editors.

/* ---- INPUT CLAMPS ---------------------------------------------------------------------------
   POST /api/bug is public and unauthenticated. These mirror netlify/lib/bugstore.mjs exactly —
   the two deployments must not drift, or one host ends up storing what the other rejects. */
const MAX_BODY  = 1_200_000;   // whole request; a snapshot is the only large field
const MAX_SHOT  =   900_000;   // ~660KB of image after base64
const MAX_STATE =   200_000;   // serialised editor state; was previously UNBOUNDED

// a snapshot must be an inline raster image — never data:text/html, never a bare string
const safeShot = (s) => (typeof s === 'string' && s.length <= MAX_SHOT &&
  /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(s)) ? s : null;

// links are opened by the dashboard operator; http(s) only, and bounded
const safeUrl = (u) => {
  if (typeof u !== 'string' || !u) return '';
  try { const x = new URL(u); return (x.protocol === 'http:' || x.protocol === 'https:') ? u.slice(0, 300) : ''; }
  catch { return ''; }
};

// keep the editor state, but never let it grow the record without bound
const clampState = (s) => {
  if (!s || typeof s !== 'object') return null;
  try { const j = JSON.stringify(s); return j.length > MAX_STATE ? { truncated: true, bytes: j.length } : s; }
  catch { return null; }
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = { 'access-control-allow-origin':'*', 'access-control-allow-methods':'POST,GET,OPTIONS', 'access-control-allow-headers':'content-type' };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    const J = (o, s=200) => new Response(JSON.stringify(o), { status:s, headers:{ 'content-type':'application/json', ...cors } });

    // report a bug (from the editor) — PUBLIC and unauthenticated, so everything here is hostile
    // input. Clamp it at the door: the /bugs/ dashboard renders these fields into markup, and its
    // operator's browser holds BUG_KEY in localStorage.
    if (url.pathname === '/api/bug' && request.method === 'POST') {
      try {
        const raw = await request.text();
        if (raw.length > MAX_BODY) return J({ ok:false, error:'payload too large' }, 413);
        const b = JSON.parse(raw);
        const id = 'bug_' + Date.now() + '_' + Math.random().toString(36).slice(2,8);
        const rec = { id, t: Date.now(), status:'new',
          editor: String(b.editor||'').slice(0,60),
          page: Number.isFinite(+b.page) ? +b.page : null,     // was stored unchecked
          desc: String(b.desc||'').slice(0,2000),
          url: safeUrl(b.url),                                 // http(s) only — no javascript:
          state: clampState(b.state),                          // was unbounded
          shot: safeShot(b.shot) };                            // must be an inline image
        await env.BUGS.put(id, JSON.stringify(rec), { expirationTtl: 60*60*24*45 });
        return J({ ok:true, id });
      } catch (e) { return J({ ok:false, error:String(e) }, 400); }
    }
    // list / read bugs (for the fixing agent) — gated by ?k=BUG_KEY
    if (url.pathname === '/api/bugs' && request.method === 'GET') {
      if (url.searchParams.get('k') !== env.BUG_KEY) return new Response('forbidden', { status:403 });
      const status = url.searchParams.get('status');
      const lite = url.searchParams.get('lite') === '1';
      const list = await env.BUGS.list({ prefix:'bug_' });
      const out = [];
      for (const k of list.keys) { const v = await env.BUGS.get(k.name); if(!v) continue; const r = JSON.parse(v);
        if (status && r.status !== status) continue; if (lite) delete r.shot; out.push(r); }
      out.sort((a,b)=>b.t-a.t);
      return J({ bugs: out });
    }
    // update a bug (agent marks triaged/fixed) — gated
    if (url.pathname.startsWith('/api/bug/') && (request.method==='POST'||request.method==='PATCH')) {
      if (url.searchParams.get('k') !== env.BUG_KEY) return new Response('forbidden', { status:403 });
      const id = url.pathname.split('/').pop(); const v = await env.BUGS.get(id); if(!v) return J({ok:false},404);
      const rec = JSON.parse(v); Object.assign(rec, await request.json());
      await env.BUGS.put(id, JSON.stringify(rec), { expirationTtl: 60*60*24*45 });
      return J({ ok:true });
    }
    // everything else → the static editor assets
    return env.ASSETS.fetch(request);
  }
};
