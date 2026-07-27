// bookends-chucky worker: bug-report API in front of the static-asset editors.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = { 'access-control-allow-origin':'*', 'access-control-allow-methods':'POST,GET,OPTIONS', 'access-control-allow-headers':'content-type' };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    const J = (o, s=200) => new Response(JSON.stringify(o), { status:s, headers:{ 'content-type':'application/json', ...cors } });

    // report a bug (from the editor) — public
    if (url.pathname === '/api/bug' && request.method === 'POST') {
      try {
        const b = await request.json();
        const id = 'bug_' + Date.now() + '_' + Math.random().toString(36).slice(2,8);
        const rec = { id, t: Date.now(), status:'new',
          editor: String(b.editor||'').slice(0,60), page: b.page ?? null,
          desc: String(b.desc||'').slice(0,2000), url: String(b.url||'').slice(0,300),
          state: (b.state && typeof b.state==='object') ? b.state : null,
          shot: (typeof b.shot==='string' && b.shot.length < 900000) ? b.shot : null };
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
