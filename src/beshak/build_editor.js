// Assemble deploy/public/beshak/index.html from its parts.
//
//   node src/beshak/build_editor.js
//
// Editors in this repo ship as ONE self-contained file, and this keeps that true while letting
// the engine live in reviewable, `node --check`-able sources. The shell CSS is Aiko's, so every
// brand keeps the same shape and the same muscle memory; only the accent colour changes.
const fs = require('fs');
const path = require('path');

const OUT = process.argv[2] || 'deploy/public/beshak/index.html';
const AIKO = 'deploy/public/aiko/index.html';

// Beshak's brand red, taken from the artwork's own fill: 0.004 0.843 0.851 0.118 k.
const ACCENT = '#D04128';
const ACCENT_SOFT = 'rgba(208,65,40,.15)';
const ACCENT_LINE = 'rgba(208,65,40,.45)';

const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

function aikoStyle() {
  const st = read(AIKO).match(/<style>([\s\S]*?)<\/style>/)[1];
  return st
    .replace(/--red:#E9B833;--aiko:#E9B833;--aiko-soft:rgba\(233,184,51,\.13\);--aiko-line:rgba\(233,184,51,\.42\);/,
      // --ac is referenced with an Aiko-gold fallback deeper in this stylesheet; define it so the
      // one rule that uses it picks up Beshak's red instead of the wrong brand's colour.
      `--red:${ACCENT};--aiko:${ACCENT};--ac:${ACCENT};--aiko-soft:${ACCENT_SOFT};--aiko-line:${ACCENT_LINE};`)
    .replace(/::selection\{background:var\(--aiko\);color:#1a1400\}/, '::selection{background:var(--aiko);color:#fff}');
}

/** The one script in Aiko's page that is brand-agnostic: the bug reporter. */
function bugScript() {
  const scripts = [...read(AIKO).matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const s = scripts.find((x) => x.includes('/api/bug'));
  if (!s) throw new Error('could not find the bug-report script in ' + AIKO);
  return s;
}

// Card internals Aiko's stylesheet does not cover, in the same design language.
const CARDS_CSS = `
/* ---- Beshak cards ---- */
#editor{padding:18px 20px 120px;overflow-y:auto}
.secgrp{margin-bottom:26px}
.sechd{font-family:var(--serif);font-size:21px;font-weight:500;letter-spacing:.2px;color:var(--cream);
  border-top:1px solid var(--line);margin:0 0 12px;padding-top:18px;display:flex;align-items:baseline;gap:10px}
.sechd .cnt{font-size:11.5px;font-family:var(--mono);color:var(--muted)}
.card{position:relative}
.card.gone{opacity:.42}
.card.gone input,.card.gone textarea,.card.gone .afchk{pointer-events:none;filter:grayscale(1)}
.card.added{border-color:var(--aiko-line);background:var(--card2)}
.chead{display:flex;align-items:center;margin-bottom:9px}
.cnum{font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
.cdel{margin-left:auto;color:var(--muted);font-size:13px;line-height:1;padding:4px 7px;border-radius:7px;border:1px solid transparent}
.cdel:hover{color:var(--bad);border-color:rgba(229,103,94,.45)}
.frow{display:grid;grid-template-columns:74px 1fr;gap:8px 10px;align-items:center;margin-bottom:8px}
.frow.wide{align-items:start}
.flbl{font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);padding-top:1px}
.frow input,.frow textarea{width:100%;background:#100E09;border:1px solid var(--line2);border-radius:8px;
  color:var(--cream);font:inherit;font-size:13px;padding:7px 10px;transition:border-color .13s}
.frow textarea{min-height:52px;resize:vertical;line-height:1.5}
.frow input:focus,.frow textarea:focus{outline:none;border-color:var(--aiko-line)}
.frow.bad input,.frow.bad textarea{border-color:rgba(229,103,94,.6)}
.frow.warn input,.frow.warn textarea{border-color:rgba(224,145,43,.5)}
.fnote{grid-column:2;font-size:11px;color:var(--warn);min-height:0}
.frow.bad .fnote{color:var(--bad)}
.frow .fnote:empty{display:none}
.afchk{margin-top:10px!important}
.mkico{display:inline-flex}
.mkico svg{width:14px;height:15px}
.addnote{grid-column:1/-1;font-size:11px;color:var(--bad);margin-top:2px}
.addnote:empty{display:none}
.card.added.bad{border-color:rgba(229,103,94,.6)}
.additem{width:100%;margin-top:4px;padding:9px;border:1px dashed var(--line2);border-radius:10px;
  color:var(--muted);font-size:12px;letter-spacing:.02em;transition:.13s}
.additem:hover{color:var(--cream);border-color:var(--aiko-line);background:var(--aiko-soft)}
.railsec{display:flex;align-items:center;gap:8px;width:100%;text-align:left;font-size:12.5px;color:var(--cream-dim);
  padding:7px 9px;border-radius:8px;transition:.13s}
.railsec:hover{background:var(--aiko-soft);color:var(--cream)}
.railsec .cnt{margin-left:auto;font-size:11px;color:var(--muted)}
.pill.warn{color:var(--warn);border-color:rgba(224,145,43,.45);background:rgba(224,145,43,.09)}
#celebrate{position:fixed;inset:0;z-index:90;display:flex;align-items:center;justify-content:center;
  background:rgba(0,0,0,.5);pointer-events:none}
#celebrate .cbcard{background:var(--panel);border:1px solid var(--aiko-line);border-radius:20px;
  padding:28px 44px;text-align:center;box-shadow:0 30px 80px rgba(0,0,0,.6);animation:pop .45s cubic-bezier(.18,1.4,.4,1)}
#celebrate .cbmark{font-family:var(--serif);font-size:30px;letter-spacing:.16em;color:var(--aiko)}
#celebrate .cbline{margin-top:8px;font-size:13px;letter-spacing:.06em;color:var(--cream-dim)}
@keyframes pop{from{transform:scale(.86);opacity:0}to{transform:scale(1);opacity:1}}
`;

const WORDMARK = '<span class="bkmark" style="font-family:var(--serif);font-size:23px;letter-spacing:.17em;color:var(--aiko)">BESHAK</span>';

function markup() {
  return `<body>
<div id="boot">
  <div style="font-family:var(--serif);font-size:34px;letter-spacing:.2em;color:var(--aiko)">BESHAK</div>
  <div class="spin"></div>
  <div class="s" id="bootmsg">Warming up the kitchen…</div>
</div>
<header class="bar">
  <a class="brand" href="/chucky/" title="Back to the editor picker">${WORDMARK}<span class="tag">Menu Editor</span></a>
  <label class="search"><input id="q" placeholder="Search items…" oninput="filterItems(this.value)"><kbd>/</kbd></label>
  <div class="spacer"></div>
  <span id="flagpill" class="pill ok">All clear</span>
  <button class="prevtoggle" onclick="togglePrev()">Preview</button>
  <button id="fullprev" title="Open the current menu full-size in a new tab">Full Preview ↗</button>
  <button id="export">Export PDF</button>
  <button id="publish" title="Push the current menu live for everyone">Publish</button>
</header>
<main class="app">
  <nav class="rail" id="rail">
    <div class="tabs"><button data-pg="0" class="on">Page 1</button><button data-pg="1">Page 2</button></div>
    <div class="lbl2">Sections</div>
  </nav>
  <section id="editor"></section>
  <aside id="previewPane">
    <div class="plabel">Live preview <span id="ptag">— Page 1</span>
      <button class="prev-close" onclick="togglePrev(false)" style="margin-left:auto" aria-label="Close">✕</button></div>
    <div id="wrap"><canvas id="preview"></canvas><div id="busy">updating…</div></div>
  </aside>
</main>
<div class="scrim" id="scrim" onclick="closeDrawers()"></div>
<div id="popover"></div>`;
}

function build() {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Beshak · Menu Editor</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon.png" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=EB+Garamond:ital,wght@0,400;0,500;0,600;1,400&family=Lora:wght@400;500;600&family=DM+Mono:wght@300;400;500&display=swap" rel="stylesheet">
<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
<style>
${aikoStyle()}
${CARDS_CSS}
</style>
</head>
${markup()}
<script>
${read('src/beshak/engine.js').replace(/\nif \(typeof module[\s\S]*$/, '')}

${read('src/beshak/ui.js').replace(/\nif \(typeof module[\s\S]*$/, '')}

${read('src/shared/memory.js')}

boot().catch(e => {
  console.error(e);
  const m = document.getElementById('bootmsg');
  if (m) m.textContent = 'Could not open the menu: ' + ((e && e.message) || e);
});
</script>
<script>
${bugScript()}
</script>
</body>
</html>
`;
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, html);
  return { OUT, size: html.length };
}

if (require.main === module) {
  const { OUT: out, size } = build();
  console.log('wrote', out, size, 'bytes');
}
module.exports = { build };
