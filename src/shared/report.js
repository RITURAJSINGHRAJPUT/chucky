// ===== REPORT A BUG -> /api/bug (attaches a preview snapshot + current edit state) =====
(function(){
  if(document.getElementById('bugbtn')) return;
  const css=document.createElement('style'); css.textContent=`
  #bugbtn{position:fixed;right:16px;bottom:16px;z-index:62;background:rgba(20,18,12,.92);color:#CFC6B4;border:1px solid rgba(244,236,221,.16);border-radius:999px;padding:7px 13px;font:12px/1.4 ui-monospace,monospace;cursor:pointer;backdrop-filter:blur(6px);box-shadow:0 10px 30px -14px #000}
  #bugbtn:hover{border-color:rgba(240,97,107,.6);color:#F0616B}
  #bugmodal{position:fixed;inset:0;z-index:82;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.55);padding:16px}
  #bugmodal.on{display:flex}
  #bugcard{width:min(460px,94vw);background:#17150f;border:1px solid rgba(244,236,221,.18);border-radius:14px;padding:18px;font-family:ui-monospace,monospace;color:#F4ECDD;box-shadow:0 30px 70px -24px #000}
  #bugcard h3{margin:0 0 4px;font-size:15px}#bugcard p{margin:0 0 12px;font-size:11.5px;color:#8F8676;line-height:1.5}
  #bugcard textarea{width:100%;min-height:92px;background:#0f0d08;border:1px solid rgba(244,236,221,.18);border-radius:9px;color:#F4ECDD;font:inherit;font-size:13px;padding:10px;resize:vertical;box-sizing:border-box}
  #bugcard .r{display:flex;gap:8px;justify-content:flex-end;margin-top:12px;align-items:center}
  #bugcard button{font:inherit;font-size:12px;padding:7px 14px;border-radius:8px;cursor:pointer;border:1px solid rgba(244,236,221,.28);background:transparent;color:#F4ECDD}
  #bugcard button.pri{background:#F0616B;border-color:#F0616B;color:#1a0c0d;font-weight:600}
  #bugshot{font-size:11px;color:#7BC96F;margin-top:8px;flex:1;text-align:left}`;
  document.head.appendChild(css);
  const btn=document.createElement('div'); btn.id='bugbtn'; btn.textContent='🐞 Report a bug'; document.body.appendChild(btn);
  const modal=document.createElement('div'); modal.id='bugmodal';
  modal.innerHTML='<div id="bugcard"><h3>Report a bug</h3><p>Describe what looks wrong. A snapshot of the current preview and your edits are attached, so it can be reproduced and fixed without you re-doing anything.</p><textarea id="bugdesc" placeholder="e.g. after removing a drink and adding one, the new drink overlaps the last line"></textarea><div class="r"><span id="bugshot"></span><button id="bugcancel">Cancel</button><button class="pri" id="bugsend">Send report</button></div></div>';
  document.body.appendChild(modal);
  const snap=()=>{ try{ const c=document.getElementById('preview'); if(c&&c.width) return c.toDataURL('image/jpeg',0.5); }catch(_){} return null; };
  btn.onclick=()=>{ modal.classList.add('on'); document.getElementById('bugshot').textContent = snap()?'✓ preview snapshot attached':''; document.getElementById('bugdesc').focus(); };
  const close=()=>modal.classList.remove('on');
  document.getElementById('bugcancel').onclick=close;
  modal.addEventListener('click',e=>{ if(e.target===modal) close(); });
  document.getElementById('bugsend').onclick=async()=>{
    const desc=document.getElementById('bugdesc').value.trim(); if(!desc){ document.getElementById('bugdesc').focus(); return; }
    const sb=document.getElementById('bugsend'); sb.textContent='Sending…'; sb.disabled=true;
    let state=null; try{ if(typeof memSnapshot==='function') state=memSnapshot(); }catch(_){}
    const payload={ editor:(typeof MEM_BRAND!=='undefined'?MEM_BRAND:location.pathname), page:(typeof activePage!=='undefined'?activePage:null), desc, url:location.href, state, shot:snap() };
    try{ const r=await fetch('/api/bug',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)}); const j=await r.json();
      if(j.ok){ sb.textContent='Sent ✓'; setTimeout(()=>{ close(); sb.textContent='Send report'; sb.disabled=false; document.getElementById('bugdesc').value=''; },1000); }
      else { sb.textContent='Failed'; sb.disabled=false; }
    }catch(e){ sb.textContent='Failed — offline?'; sb.disabled=false; }
  };
})();
