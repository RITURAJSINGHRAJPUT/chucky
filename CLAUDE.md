# Chucky menu editors — the one guide (read me first)

This single file is the whole handoff: what the project is, how to get access, how to set it up,
how to work on it (including with Claude Code), how to deploy, and the rules/gotchas that matter.
Deep reference notes live in `docs/knowledge/` and are pointed to where relevant.

> If you're **Claude Code**: this file is your project brief — follow the "HARD RULES" section.
> If you're the **new maintainer (human)**: start at §1 (Get access) then §2 (Set up).

---

## What this is

**Chucky** is a set of browser-based, **byte-level PDF menu editors** for the Bookends F&B group
(brands: **Capiche** pizza/food, **Aiko** comfort food, **Churn'd** desserts, plus drinks menus for
Aiko and Capiche). Restaurant staff open an editor in the browser, change dish names / descriptions /
prices / allergen markers / photos, and **export a print-ready PDF that is the real designed menu
with surgical edits** — not an HTML re-creation.

**Live (Cloudflare Worker):** https://bookends-chucky.capichesecretmenu.workers.dev

| Path | Editor |
|------|--------|
| `/chucky/` | Editor hub (tiles) |
| `/capiche/` · `/aiko/` · `/churnd/` | Food editors |
| `/drinks/` (Aiko) · `/capiche-surat/` · `/capiche-ahm/` | Drinks editors |
| `/bugs/` | Bug-report queue dashboard |

---

## 1. Get access (owner does this once)

Two things are gated. Nothing else.

**a) Cloudflare — to deploy.** The site is one Worker, `bookends-chucky`, on the owner's Cloudflare
account. The owner invites the new maintainer to that account so the live URLs and data stay the same:
- Cloudflare dashboard → **Manage Account → Members → Invite Member**
- Their email; role **Administrator** (simplest) or a Workers-scoped custom role (needs Workers
  Scripts + Workers KV + Account Settings read).
- They accept the invite, then authenticate with their **own** login (`wrangler login`) or their own
  API token — no token is ever shared.

**b) The code — "editor access".** Put this project where they can push:
- Create a **private** GitHub repo, push this folder, add them as a collaborator with **Write**:
  ```bash
  # from this folder, after unzipping / cloning
  git remote add origin git@github.com:<owner>/chucky.git
  git push -u origin main
  # then GitHub → repo → Settings → Collaborators → Add (Write access)
  ```
- Or simply hand them the zip and let them host it. Either way, **keep it private** — it contains the
  restaurant's menu PDFs and the `BUG_KEY` value (see §7).

---

## 2. Set up (new maintainer, first time)

```bash
git clone <repo>            # or unzip the handoff archive
cd chucky
npm install                 # jsdom + pdf-lib + wrangler

# Python tools (render audits + drinks builds)
pip3 install pymupdf pikepdf Pillow

# Cloudflare auth (pick one)
cd deploy
npx wrangler login          # browser OAuth against the invited account
#   — or —  export CLOUDFLARE_API_TOKEN=<a token you create in Cloudflare>

npx wrangler deploy         # deploys public/ + worker.js
```
Verify: open `/chucky/` on the live URL and **hard-refresh** (Cmd/Ctrl+Shift+R — editors are cached).

Everyday change loop: edit files under `deploy/public/…` → `cd deploy && npx wrangler deploy` →
hard-refresh. Wrangler only uploads changed assets.

**Requirements:** Node 18+ (built on 24); Python 3 with `pymupdf` (render audits), `pikepdf` +
`Pillow` (drinks build pipeline).

---

## 3. The core idea (governs every change)

Each editor ships three things in `deploy/public/<editor>/`:
1. **`<brand>.pdf`** — the real designer PDF, saved with **UNCOMPRESSED content streams** (no
   FlateDecode) so the editor can read each page's stream as plain bytes.
2. **`fieldmap.json`** — for every editable dish: the **byte spans** of its name/description/price
   text (and markers) inside the page content stream, plus positions, sizes, fonts, and layout
   metadata (sections, dividers, icons, colors).
3. **`index.html`** — the whole editor (UI + engine) in one file. It fetches the PDF with **pdf-lib**,
   reads each page's `Contents` bytes, and to render an edit **splices new `(text)Tj` / `[..]TJ`
   operators into those bytes at the recorded spans**, then re-saves the PDF.

**NEVER rebuild a menu as HTML/CSS and print that.** The point is byte-faithful edits of the original
artwork. If you're re-typesetting the menu, stop — that's the wrong approach.

Also fetched per editor: `base_words.json` (generic English spell dictionary, reusable) +
`culinary.json` (culinary spell terms).

---

## 4. HARD RULES (do not skip)

1. **Syntax-check any engine you edit.** The engine is one big inline `<script>`; extract it and
   `node --check`:
   ```bash
   node -e 'const fs=require("fs");const h=fs.readFileSync("deploy/public/capiche/index.html","utf8");const e=(h.match(/<script>([\s\S]*?)<\/script>/g)||[]).map(s=>s.replace(/^<script>|<\/script>$/g,"")).find(s=>s.includes("regenerate"));fs.writeFileSync("/tmp/eng.js",e)' && node --check /tmp/eng.js
   ```
2. **Deploy from `deploy/`:** `cd deploy && npx wrangler deploy`.
3. **PDFs must stay uncompressed** when (re)built — pikepdf save with
   `compress_streams=False, stream_decode_level=generalized`, object streams disabled. A FlateDecoded
   content stream breaks every byte span.
4. **AUDIT AS A VIEWER before calling anything done.** Render the exported PDF and read it like a
   customer — overlaps, wrong prices, dropped letters, typos, mis-placed markers. Don't ship on
   reasoning alone. Two routes, use whichever you have:
   - **Node (no Python needed):** `test/lib/render.mjs` — `renderPages()` / `renderRegion()` /
     `textLines()`, backed by the `mupdf` devDependency. Just `npm install`.
   - **Python:** `import fitz` → `page.get_pixmap()` (needs `pip3 install pymupdf`).

   Byte-level checks alone are NOT sufficient: the ADD-font corruption produced perfectly valid
   bytes and visibly broken glyphs, and survived because nothing in the suite rasterised anything.
5. **Build for ALL brands.** A requested feature applies to every relevant editor; code stays
   per-editor (separate files) but the interface is identical. Drinks editors come as a set (Aiko,
   Capiche Surat, Capiche Ahmedabad) — do all of them.
6. **Every editor keeps ADD and REMOVE** items — never edit-only.
7. **Remind the user to hard-refresh** (Cmd+Shift+R) after every deploy.

---

## 5. How the engine works & how to build/test

**Engine (`deploy/public/<editor>/index.html`):** on boot, load `<brand>.pdf`, store each page's
pristine `Contents` bytes, build the UI from `FM.fields`. `regenerate()` collects splice ops
(name/desc/price edits, marker add/remove, added-dish stamps, removed-dish deletions + reflow),
applies them with `spliceBytes`, and re-saves. Empty edits ⇒ byte-identical output. Fields group into
dish cards **geometrically** (by x/y), so field ids only need to be unique.

**Rebuild a menu from a NEW design PDF** (only when the design team ships a new one — the base PDFs
already in the repo are enough to *edit* today):
- **Food:** `node src/capiche/build_food.js <new.pdf> deploy/public/<editor>/fieldmap.json <out.json> --validate-page0`
  then swap the new PDF + `<out.json>` into `deploy/public/<editor>/`. Method + gotchas:
  `docs/knowledge/capiche-food-rebuild.md`.
- **Drinks:** the Python pipeline in `src/capdrinks/` — see `docs/knowledge/capiche-drinks-editors.md`.
- Design source files (PDF/.ai) come from the **design team**; they're not in this repo. The latest
  food blueprint is in `incoming/`.

**Test.** Start with the suite, then reach for a harness to reproduce one case:

- **`npm test`** — regression suite (`test/regress.js`). Renders as well as diffing bytes, and pins
  the known bugs as declared **KNOWN-FAIL** cases, so the run is green-except-known. `FULL=1 npm test`
  adds the exhaustive per-dish removal sweeps. When a fix lands its case flips to PASS and the suite
  tells you to delete the declaration from `KNOWN` in `test/regress.js`.
- Artefacts (renders, exported PDFs, fixtures) go to `test-output/` — gitignored, override with
  `CHUCKY_TEST_OUT`. Never hard-code an output path into a harness.

**Harnesses** (boot an engine in jsdom+vm, write a PDF):
- `node foodh.js <editor_dir> <out.pdf> '<EDITS_json>' ['<MARKERS_json>']`  (env `PERSONA` for cover)
- `node foodh_ar.js …` — same, plus add/remove/reorder via env `REMOVED` / `ADDED` / `ORDER`
  (only this one wires `ORDER`; `foodh.js` ignores it)
- `node markerh.js …` (drinks markers, all three drinks editors) · `node framh.js …` (photo framing;
  generates its own 4-quadrant fixture, override with `FRAME_JPEG`)
- `node churndh.js <out.pdf> '<EDITS_json>'` — Churn'd. It needs its own harness: its fieldmap uses
  `items[]` not `fields[]`, so the food harnesses can never boot it. Edit keys are `n<id>` / `p<id>_<col>`.
- `node src/drinks/harness_bands.js` — Aiko drinks (band-model rebuild), 14 assertions.
- If you add code calling `requestAnimationFrame`, harnesses need a rAF stub (framh.js has one).
- **Preview caveat:** the in-browser live preview loads pdf.js from a CDN; some sandboxes block that
  worker so preview hangs — environmental, not a data bug. The deployed site loads it fine.

---

## 6. Repo map

```
CLAUDE.md                # this guide
deploy/
  wrangler.jsonc         # Worker: name=bookends-chucky, ASSETS=./public, KV BUGS, var BUG_KEY
  worker.js              # serves public/ + bug-report API (/api/bug, /api/bugs)
  public/
    index.html                      # Bookends landing
    chucky/index.html               # editor hub
    capiche/ aiko/ churnd/          # FOOD editors (index.html + <brand>.pdf + fieldmap.json + dicts)
    drinks/ capiche-surat/ capiche-ahm/   # DRINKS editors
    bugs/index.html                 # bug-queue dashboard
    menu/index.html                 # customer-facing page
src/
  capiche/build_food.js  # FOOD fieldmap builder (Node + pdf-lib)
  capdrinks/*.py         # DRINKS build pipeline (Python + pikepdf) + RobotoMono-SemiBold.ttf
  drinks/  shared/       # Aiko-drinks builder/harnesses; shared memory.js + report.js
foodh.js markerh.js framh.js foodh_ar.js   # test harnesses
docs/knowledge/          # detailed engineering notes (READ when touching a tricky area)
backups/                 # timestamped safety copies   incoming/  # latest raw blueprint PDF
```

Deep reference in **`docs/knowledge/`** (with its own index README): the whole-system notes, the food
rebuild method, drinks pipeline, the `keepFont()` fontless-inherit bug, reflow pitch, marker
signatures, roomier-text fitting, personalise-cover, and the bug-report loop. Check there first when
something behaves oddly.

---

## 7. Cloudflare resources, secrets & open item

**Resources:** Worker `bookends-chucky` (`deploy/wrangler.jsonc` + `deploy/worker.js`); static assets
= `deploy/public/` (binding `ASSETS`); KV namespace `BUGS` (id `53a121594626447e9579fcef063fdd64`,
stores bug reports, ~45-day TTL); var `BUG_KEY` (gates the bug-queue read/update API). URL is the
`*.capichesecretmenu.workers.dev` subdomain.

*To run on a different Cloudflare account instead:* `npx wrangler kv namespace create BUGS` → put the
new id in `wrangler.jsonc`, change the Worker `name`, set your own `BUG_KEY`, deploy → new URL.

**Secrets/safety:**
- No API tokens are committed; `.gitignore` excludes `node_modules`, wrangler cache, `.env`,
  `.dev.vars`, `*.token`. Never commit a `cfat_…`/OAuth token.
- `BUG_KEY` **is** in `wrangler.jsonc` in the clear (it only guards the low-value bug queue). Fine
  while the repo is **private**. If it ever goes public, move it to a real secret
  (`wrangler secret put BUG_KEY`) and remove it from the config.
- The menu PDFs are the restaurant's artwork — keep the repo private.

**Open item:** the in-editor bug capture + `/bugs/` dashboard are live; an **autonomous daily
bug-fixer** was scoped but left pending an authorization-model decision
(`docs/knowledge/bug-report-loop.md`). Pick up there to close the loop.
