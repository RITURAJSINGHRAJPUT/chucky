// ============ EDIT MEMORY — autosave + resume + version history (per brand) ============
// Glue each editor must define BEFORE this block:
//   const MEM_BRAND = 'aiko-drinks';        // unique key
//   function memSnapshot(){ return {...}; }  // serialisable current edit state (order-stable)
//   function memApply(state){ ... }          // mutate editor vars from a saved state
//   function memRebuild(){ ... }             // rebuild UI + regenerate + render after apply
//   let   memBaseVer = '';                   // fingerprint of the base PDF (for #6 update detection)
const MEM = (function(){
  const K='chucky_mem_'+MEM_BRAND, AUTO=K+':auto', SNAPS=K+':snaps';
  let initial='', timer=null, statusEl=null, panel=null, ready=false;
  const J=o=>{ try{return JSON.stringify(o);}catch(_){return '';} };
  const P=s=>{ try{return JSON.parse(s);}catch(_){return null;} };
  function ago(t){ const s=Math.max(0,(Date.now()-t)/1000);
    if(s<45) return 'just now'; if(s<3600) return Math.round(s/60)+'m ago';
    if(s<86400) return Math.round(s/3600)+'h ago'; return Math.round(s/86400)+'d ago'; }
  const dirty=()=> J(memSnapshot())!==initial;
  function setStatus(txt,cls){ if(!statusEl)return; statusEl.querySelector('.memtxt').textContent=txt; statusEl.dataset.state=cls||''; statusEl.style.display=txt?'':'none'; }
  function tick(){
    if(!ready) return;
    clearTimeout(timer);
    if(!dirty()){ try{localStorage.removeItem(AUTO);}catch(_){}; setStatus('',''); return; }
    setStatus('Saving…','saving');
    timer=setTimeout(()=>{ try{ localStorage.setItem(AUTO, J({t:Date.now(), base:memBaseVer, s:memSnapshot()})); setStatus('Saved','ok'); }catch(_){ setStatus('',''); } }, 500);
  }
  function snapshot(label){ if(!dirty()) return; try{ const a=P(localStorage.getItem(SNAPS))||[];
    a.unshift({t:Date.now(), label:label||'edit', base:memBaseVer, s:memSnapshot()});
    localStorage.setItem(SNAPS, J(a.slice(0,12))); }catch(_){} }
  const snaps=()=> P(localStorage.getItem(SNAPS))||[];
  function restore(state){ try{ memApply(state); memRebuild(); }catch(e){ console.error('restore failed',e); } tick(); }
  // ---------- UI ----------
  function build(){
    if(document.getElementById('memwrap')) return;
    const css=document.createElement('style'); css.textContent=`
    #memwrap{position:fixed;left:16px;bottom:16px;z-index:60;font:12px/1.4 var(--mono,ui-monospace,monospace)}
    #memstat{display:none;align-items:center;gap:7px;background:rgba(20,18,12,.92);color:#CFC6B4;border:1px solid rgba(244,236,221,.16);
      border-radius:999px;padding:6px 12px;cursor:pointer;backdrop-filter:blur(6px);user-select:none;box-shadow:0 10px 30px -14px #000}
    #memstat:hover{border-color:rgba(244,236,221,.34)}
    #memstat .dot{width:7px;height:7px;border-radius:50%;background:#8F8676;flex:none}
    #memstat[data-state=ok] .dot{background:#7BC96F} #memstat[data-state=saving] .dot{background:#E0A44A;animation:mempulse 1s infinite}
    @keyframes mempulse{50%{opacity:.35}}
    #mempanel{display:none;position:absolute;left:0;bottom:42px;width:280px;max-height:340px;overflow:auto;background:rgba(18,16,11,.98);
      border:1px solid rgba(244,236,221,.16);border-radius:12px;padding:10px;box-shadow:0 24px 60px -24px #000}
    #mempanel.on{display:block} #mempanel h4{margin:2px 4px 8px;font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:#8F8676;font-weight:600}
    .memrow{display:flex;align-items:center;gap:8px;padding:7px 8px;border-radius:8px;cursor:pointer;color:#CFC6B4}
    .memrow:hover{background:rgba(244,236,221,.07)} .memrow .ml{flex:1;min-width:0} .memrow .mt{font-size:10.5px;color:#8F8676}
    .memrow .mr{font-size:10px;color:#8F8676} .memrow.empty{color:#6f6858;cursor:default}
    #membar{position:fixed;left:0;right:0;top:0;z-index:70;display:none;align-items:center;justify-content:center;gap:14px;
      padding:10px 16px;background:linear-gradient(90deg,#2A1F12,#1c150c);border-bottom:1px solid rgba(224,164,74,.4);
      color:#F4ECDD;font:13px/1.4 var(--mono,ui-monospace,monospace);box-shadow:0 8px 24px -12px #000}
    #membar.on{display:flex} #membar b{color:#E0A44A}
    #membar button{font:inherit;font-size:12px;padding:5px 13px;border-radius:8px;cursor:pointer;border:1px solid rgba(244,236,221,.28);background:transparent;color:#F4ECDD}
    #membar button.pri{background:#E0A44A;border-color:#E0A44A;color:#1a1508;font-weight:600}
    #membar button:hover{filter:brightness(1.1)}
    @media(max-width:640px){#memwrap{left:10px;bottom:10px}#mempanel{width:min(280px,86vw)}}`;
    document.head.appendChild(css);
    const wrap=document.createElement('div'); wrap.id='memwrap';
    wrap.innerHTML='<div id="memstat" title="Edit memory — click for history"><span class="dot"></span><span class="memtxt"></span> · History</div><div id="mempanel"></div>';
    document.body.appendChild(wrap);
    const bar=document.createElement('div'); bar.id='membar'; document.body.appendChild(bar);
    statusEl=document.getElementById('memstat'); panel=document.getElementById('mempanel');
    statusEl.addEventListener('click',togglePanel);
    document.addEventListener('click',e=>{ if(panel&&!wrap.contains(e.target)) panel.classList.remove('on'); });
  }
  function togglePanel(e){ e&&e.stopPropagation(); if(!panel)return; const open=!panel.classList.contains('on'); if(open)renderPanel(); panel.classList.toggle('on',open); }
  function renderPanel(){
    const list=snaps(); let h='<h4>Version history</h4>';
    if(!list.length) h+='<div class="memrow empty">No saved versions yet.<br>Exports and edits are saved here.</div>';
    else list.forEach((v,i)=>{ h+='<div class="memrow" data-i="'+i+'"><span class="ml"><div>'+esc(v.label)+'</div><div class="mt">'+ago(v.t)+(v.base!==memBaseVer?' · older menu':'')+'</div></span><span class="mr">restore</span></div>'; });
    panel.innerHTML=h;
    panel.querySelectorAll('.memrow[data-i]').forEach(r=>r.addEventListener('click',()=>{ const v=snaps()[+r.dataset.i]; if(v){ snapshot('before restore'); restore(v.s); panel.classList.remove('on'); } }));
  }
  function esc(s){ return (s+'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
  function checkResume(){
    const a=P(localStorage.getItem(AUTO)); if(!a||!a.s||J(a.s)===initial) return;
    const bar=document.getElementById('membar'); if(!bar) return;
    const stale=a.base && memBaseVer && a.base!==memBaseVer;
    bar.innerHTML='<span>'+(stale?'You have edits from a <b>previous version</b> of this menu ('+ago(a.t)+').':'You left <b>unsaved edits</b> here '+ago(a.t)+'.')+'</span>'
      +'<button class="pri" id="memres">Resume them</button><button id="memfresh">Start fresh</button>';
    bar.classList.add('on');
    bar.querySelector('#memres').addEventListener('click',()=>{ restore(a.s); bar.classList.remove('on'); });
    bar.querySelector('#memfresh').addEventListener('click',()=>{ try{localStorage.removeItem(AUTO);}catch(_){}; bar.classList.remove('on'); tick(); });
  }
  function init(){ try{ initial=J(memSnapshot()); }catch(_){ initial=''; } ready=true; build(); checkResume(); }
  return { init, tick, snapshot, restore, ago };
})();
