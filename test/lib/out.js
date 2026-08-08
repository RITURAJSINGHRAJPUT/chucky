// Where test artefacts go. ONE place, repo-relative, gitignored — so no harness ever again hard-codes
// a path from whoever's machine happened to write it (four committed files used to point at
// /private/tmp/claude-501/-Users-apple/..., which fails instantly on any other computer).
// Override with CHUCKY_TEST_OUT if you want artefacts somewhere else.
const fs = require('fs'), path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const DIR = process.env.CHUCKY_TEST_OUT || path.join(ROOT, 'test-output');

function outDir(sub) {
  const d = sub ? path.join(DIR, sub) : DIR;
  fs.mkdirSync(d, { recursive: true });
  return d;
}
const outFile = (name, sub) => path.join(outDir(sub), name);

module.exports = { ROOT, DIR, outDir, outFile };
