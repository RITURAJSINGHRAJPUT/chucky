#!/usr/bin/env node
// Inject the shared QR tool into every editor.
//
//   npm run qr:inject          (node src/shared/qrtool/build.mjs [--check])
//
// Editors ship as ONE self-contained file each, so the tool is copied in rather than loaded —
// but from ONE source (qrtool.src.js + the repo's own QR encoder), between the markers
// /* QRTOOL:BEGIN … */ … /* QRTOOL:END */, so the copies can never drift. --check fails if any
// editor's copy is stale (the regression suite runs it).
//
// Beshak's index.html is itself generated (src/beshak/build_editor.js), so its copy lives in
// src/beshak/ui.js and the editor is re-assembled afterwards.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..', '..');
const CHECK = process.argv.includes('--check');
const rd = p => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

const TARGETS = [
  'deploy/public/capiche/index.html', 'deploy/public/aiko/index.html', 'deploy/public/churnd/index.html',
  'deploy/public/drinks/index.html', 'deploy/public/capiche-surat/index.html', 'deploy/public/capiche-ahm/index.html',
  'src/beshak/ui.js',
];

const strip = s => s.replace(/^import .*$/gm, '').replace(/^export (?=(const|function|let|class)\b)/gm, '');
const encoder = ['src/shared/qr/gf.mjs', 'src/shared/qr/encode.mjs'].map(p => `// --- ${p}\n` + strip(rd(p))).join('\n')
  .split('\n').map(l => l ? '  ' + l : l).join('\n');
export const BLOCK = rd('src/shared/qrtool/qrtool.src.js').replace('  //@@ENCODER@@', () => encoder).trimEnd();
const RE = /\/\* QRTOOL:BEGIN[\s\S]*?\/\* QRTOOL:END \*\//;

let stale = 0, beshak = false;
for (const t of TARGETS) {
  const f = path.join(ROOT, t), src = fs.readFileSync(f, 'utf8');
  const nl = src.includes('\r\n') ? '\r\n' : '\n';
  if (!RE.test(src)) { console.error(`  ${t}: no QRTOOL markers — add the glue first`); process.exitCode = 1; continue; }
  const out = src.replace(RE, () => BLOCK.replace(/\n/g, nl));
  if (out === src) { console.log(`  ${t}: up to date`); continue; }
  if (CHECK) { console.error(`  ${t}: STALE — run npm run qr:inject`); stale++; continue; }
  fs.writeFileSync(f, out);
  console.log(`  ${t}: injected`);
  if (t.startsWith('src/beshak/')) beshak = true;
}
if (beshak) {
  execFileSync(process.execPath, [path.join(ROOT, 'src/beshak/build_editor.js')], { cwd: ROOT, stdio: 'inherit' });
}
if (CHECK && stale) process.exitCode = 1;
