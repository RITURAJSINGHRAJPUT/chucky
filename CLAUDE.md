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

Every editor also has a **Publish** button (next to Export): unlike Export, which downloads a PDF
for the person clicking it, Publish pushes the current edit-state to a small server-side store
(`/api/menu-state/:editor`) so *any device* that opens that editor afterward loads the last-published
state instead of always starting from the pristine baseline — it persists until the next Publish.
The baseline PDF/`fieldmap.json` are never modified by this; it's purely the same JSON edit-overlay
(`edits`/`removed`/`added`/marker state) that already drives `regenerate()`, now with a permanent
home instead of only `localStorage`. Gated by its own `PUBLISH_KEY` (separate from `BUG_KEY` — see
§7b). See `api/menu-state/[editor].mjs` and the `MEM_BRAND`-adjacent "Publish" block in each editor.

**Live (Cloudflare Worker):** https://bookends-chucky.capichesecretmenu.workers.dev
(A parallel Vercel deploy target also exists for maintainers without Cloudflare access — §1c/§7b.
Cloudflare remains the documented, primary host; Vercel is not a cutover.)

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
  restaurant's menu PDFs and the `BUG_KEY`/`PUBLISH_KEY` values (see §7, §7b).

**c) No Cloudflare access? Deploy to your own Vercel account instead.** A maintainer who isn't
invited to the Cloudflare account (§1a) can still run their own copy — Vercel needs no permission
from anyone else, since it's a project under *your* account. This is a parallel target, not a
replacement: it serves the same static `deploy/public/` plus a Vercel-native port of the bug-report
API and the Publish feature (`api/`, `vercel.json`). See §7b for setup and what's still needed
(an Upstash Redis integration for storage; `BUG_KEY`/`PUBLISH_KEY` as Vercel env vars instead of
Wrangler secrets).

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
vercel.json              # Vercel: outputDirectory=deploy/public, no-cache headers (§7b)
api/                     # Vercel-only: bug-report API port + the Publish (menu-state) API
  lib/kv.mjs             # Upstash Redis client wrapper
  lib/bugstore.mjs       # Vercel's own copy of the clamp/CORS/auth helpers (3rd copy — see below)
  bug.mjs bugs.mjs bug/[id].mjs        # POST /api/bug, GET /api/bugs, POST|PATCH /api/bug/:id
  menu-state/[editor].mjs              # GET/POST /api/menu-state/:editor — the Publish feature
deploy/
  wrangler.jsonc         # Worker: name=bookends-chucky, ASSETS=./public, KV BUGS (BUG_KEY is a
                         #   secret, NOT in this file)
  worker.js              # serves public/ + bug-report API (/api/bug, /api/bugs)
  public/
    index.html                      # Bookends landing
    chucky/index.html               # editor hub
    capiche/ aiko/ churnd/          # FOOD editors (index.html + <brand>.pdf + fieldmap.json + dicts)
    drinks/ capiche-surat/ capiche-ahm/   # DRINKS editors
    bugs/index.html                 # bug-queue dashboard
    menu/index.html                 # customer-facing page
netlify/                 # parallel Netlify port of the bug-report API (never promoted to primary —
                         #   see docs/knowledge/chucky-current-state.md §5)
src/
  capiche/build_food.js  # FOOD fieldmap builder (Node + pdf-lib)
  capdrinks/*.py         # DRINKS build pipeline (Python + pikepdf) + RobotoMono-SemiBold.ttf
  drinks/  shared/       # Aiko-drinks builder/harnesses; shared memory.js + report.js
foodh.js markerh.js framh.js foodh_ar.js churndh.js        # test harnesses
test/bugapi.test.mjs     # drift-guard: Worker/Netlify/Vercel bug-API clamps must agree (3-way)
test/menustate.test.mjs  # Publish API: allowlist, gating, payload clamps
docs/knowledge/          # detailed engineering notes (READ when touching a tricky area)
backups/                 # timestamped safety copies   incoming/  # latest raw blueprint PDF
```

**Why `api/lib/bugstore.mjs` is a third copy, not a shared import:** `netlify/lib/bugstore.mjs`
already established this pattern — its own header comment says its constants "mirror
`deploy/worker.js` EXACTLY... the two deployments must not drift, or one host stores what the
other rejects," enforced by `test/bugapi.test.mjs` rather than by extraction. A shared module
would need to work unmodified inside three different runtimes' module resolution (Cloudflare
Worker isolate, Netlify Function, Vercel Edge Function) for ~40 lines of pure functions — not
worth the coupling. If you change a clamp/limit in one copy, change it in all three and rerun
`node test/bugapi.test.mjs`.

Deep reference in **`docs/knowledge/`** (with its own index README): the whole-system notes, the food
rebuild method, drinks pipeline, the `keepFont()` fontless-inherit bug, reflow pitch, marker
signatures, roomier-text fitting, personalise-cover, and the bug-report loop. Check there first when
something behaves oddly.

---

## 7. Cloudflare resources, secrets & open item

**Resources:** Worker `bookends-chucky` (`deploy/wrangler.jsonc` + `deploy/worker.js`); static assets
= `deploy/public/` (binding `ASSETS`); KV namespace `BUGS` (id `53a121594626447e9579fcef063fdd64`,
stores bug reports, ~45-day TTL); secret `BUG_KEY` (gates the bug-queue read/update API). URL is the
`*.capichesecretmenu.workers.dev` subdomain.

*To run on a different Cloudflare account instead:* `npx wrangler kv namespace create BUGS` → put the
new id in `wrangler.jsonc`, change the Worker `name`, set your own `BUG_KEY`, deploy → new URL.

**Secrets/safety:**
- No API tokens are committed; `.gitignore` excludes `node_modules`, wrangler cache, `.env`,
  `.dev.vars`, `*.token`. Never commit a `cfat_…`/OAuth token.
- `BUG_KEY` is **no longer in `wrangler.jsonc`** — it was removed, and the old value should be
  treated as burned because it lived in the repo in clear text. Set a fresh one before the next
  deploy: `cd deploy && npx wrangler secret put BUG_KEY` (on Netlify it is an environment variable,
  read via `process.env.BUG_KEY`). It is not recoverable from this repo's history.
  Known weaknesses, unchanged: the key travels in the **query string** (`?k=…`), so it lands in
  access logs, browser history and referrers; and both hosts send `access-control-allow-origin: *`.
- The menu PDFs are the restaurant's artwork — keep the repo private.

**Open item:** the in-editor bug capture + `/bugs/` dashboard are live; an **autonomous daily
bug-fixer** was scoped but left pending an authorization-model decision
(`docs/knowledge/bug-report-loop.md`). Pick up there to close the loop.

---

## 7b. Vercel (parallel option — build vs. what's still yours to do)

**What's built and verified** (against a local stand-in for `vercel dev` — no live Vercel/Upstash
account was available while building this, so the storage leg below is unverified against the
*real* Upstash REST API specifically, only against a hand-rolled mock of its wire protocol; treat
the first real deploy as the actual first test of that leg):
- `vercel.json` — static output (`deploy/public`, zero build step) + the same no-cache header rule
  `netlify.toml` uses for `index.html`.
- `api/` — Edge Functions (`runtime:'edge'`, Web-standard `Request`/`Response`, same signature as
  the Worker and Netlify Function) porting the 3 bug-report routes, plus the new
  `GET/POST /api/menu-state/:editor` Publish routes. Storage: Upstash Redis via
  `@upstash/redis` (REST-based, so Edge-compatible) — see `api/lib/kv.mjs`.
- The **Publish** feature itself, wired into all 6 editors (boot-time fetch-and-apply before
  `buildEditor()`, a `#publish` button next to `#export`, `PUBLISH_KEY` gating reusing the
  bug-dashboard's `askKey()`/`localStorage` pattern under a separate key). Two Editors
  (`capiche-surat`, `capiche-ahm`) carry uploaded photos in browser IndexedDB, never in the JSON
  state — Publish ships crop metadata only; a **fresh device won't have the photo pixels** for
  someone else's upload until it uploads its own. This is a known, accepted limitation, not a bug.

**What you still need to do** (needs your own Vercel account — not something that can be done from
this repo alone):
1. `vercel link` (or import the repo via the Vercel dashboard) — Root Directory stays the repo
   root (`api/` and `vercel.json`'s `outputDirectory` both resolve from there; see the comment at
   the top of `vercel.json` if you move anything).
2. **Storage → Marketplace → Upstash** (Redis) integration. The exact env var names it injects can
   vary (`KV_REST_API_URL`/`KV_REST_API_TOKEN` vs `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN`)
   — `api/lib/kv.mjs` reads both pairs, so whichever the dashboard sets just works; no code change
   needed unless the integration uses different names entirely.
3. Set **`BUG_KEY`** and **`PUBLISH_KEY`** as Vercel Environment Variables (Project Settings →
   Environment Variables) — plain env vars here, not Wrangler secrets. Pick a fresh `PUBLISH_KEY`;
   it's not the same value as `BUG_KEY` (see the "why separate" note above the Publish description
   at the top of this file) and isn't recoverable from anywhere in this repo.
4. Deploy (`vercel --prod`, or connect the GitHub repo for auto-deploy on push).
5. **First deploy only**, verify the one thing that couldn't be checked from this environment:
   open `/capiche/` (or any editor) on the new URL and confirm it boots — this is the
   directory-index resolution (`/capiche/` → `deploy/public/capiche/index.html`) that every other
   host already does the same way, but wasn't confirmed against real Vercel infra. Then verify one
   full Publish round-trip: edit a name, click Publish, open the same editor in a private window,
   confirm the edit is there.
6. Run `node test/bugapi.test.mjs` and `node test/menustate.test.mjs` after any change to
   `api/lib/bugstore.mjs` or the clamp constants — they must keep agreeing with the Worker and
   Netlify copies (see the repo-map note above).
