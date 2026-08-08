---
name: chucky-current-state
description: "Verified snapshot of the whole Chucky system — architecture, six editors, fieldmap schemas, deployment, preview, tests, known bugs, live/local divergence, security, and the recommended order of work"
metadata:
  type: project
---

# Chucky — current state

A verified snapshot of the system as it stands in this repository. Everything here was checked
against the actual files, PDFs and the live site; where something was **not** verified it says so.
Read `../../CLAUDE.md` first — this document does not replace it, it records what is true *now*.

> Scope note: browser behaviour (responsive layout, mobile UX, live preview rendering, cross-browser)
> was **not** testable in the environment this audit ran in. Nothing here asserts it.

---

## 1. Architecture

```
Original designer PDF (uncompressed content streams)
        ↓
fieldmap.json  — byte spans + geometry + fonts + layout metadata
        ↓
editor engine  — one inline <script> per editor
        ↓
spliceBytes()  — surgical, non-overlapping byte replacement
        ↓
print-ready PDF (original artwork preserved)
```

Load-bearing invariants, all currently holding:

- **Content streams stay uncompressed, no object streams.** Verified across all six base PDFs
  (capiche/aiko/churnd/drinks 2 pages each, capiche-surat 2, capiche-ahm 4 — zero `/Filter`, zero
  `/Type /ObjStm`). A FlateDecoded stream invalidates every byte span in the fieldmap.
- **Pristine-stream caching** — each page's original bytes are held untouched; edits are computed
  against them, never against a previous edit.
- **Non-overlap contract** — `spliceBytes` sorts ops and assumes they never overlap; overlapping ops
  corrupt the stream from that point onward. `mergeSpans()` exists to guarantee this.
- **Empty edits are byte-identical.** Verified on capiche, capiche-surat, capiche-ahm. Aiko is a
  known exception (see §8).

**This architecture is the product.** Do not re-typeset menus as HTML/CSS.

---

## 2. The six editors are genuinely different

They look alike; they are not. Assuming otherwise has already caused bugs.

| Editor | Model | Notes |
|---|---|---|
| `/capiche/` | food, `fields[]` | 37 dishes, 2 pages, allergen markers, NEW badge, personalise-cover |
| `/aiko/` | food, `fields[]` | 46 dishes, adds `grams` role + `header` role (category text), section reorder |
| `/churnd/` | price-tier, `items[]` | **No descriptions.** 3 price columns. PDF is a **2-up sheet**: every item has two `name_spans` and both must be spliced (handled correctly) |
| `/drinks/` (Aiko) | **band-model rebuild** | Not byte-splicing. Remove = `BANDS.splice()` + regenerate. Gradients instead of markers |
| `/capiche-surat/` | drinks, `pages[].items[]` | markers, NEW badge, SPECIALS bar, photo crop/frame, drag reorder, multi-line names |
| `/capiche-ahm/` | drinks, `pages[].items[]` | byte-identical twin of Surat outside content; 3 menu pages |

---

## 3. Feature matrix (verified)

`Y` = present · `–` = absent · `n/a` = not applicable to that menu's design

| Feature | CAPICHE | AIKO | CHURND | DRINKS | SURAT | AHM |
|---|---|---|---|---|---|---|
| Name edit | Y | Y | Y | Y | Y | Y |
| Multi-line name | – | – | – | – | Y | Y |
| Description edit | Y | Y | n/a | Y | Y | Y |
| Price edit | Y | Y | Y (3 tiers) | Y | Y | Y |
| Volume / grams | n/a | Y (grams) | n/a | Y | Y | Y |
| **ADD** | Y ⚠ | Y ⚠ | Y | Y | Y | Y |
| **REMOVE** | Y | Y | Y | Y | Y | Y |
| Markers | Y | Y | n/a | n/a | Y | Y |
| NEW badge | Y | Y | – | – | Y | Y |
| SPECIALS bar | n/a | n/a | n/a | n/a | Y | Y |
| Reflow | Y | Y | minimal | n/a | Y | Y |
| **Reorder** | **–** | Y | **–** | Y | Y | Y |
| Photo upload/crop | – | – | – | – | Y | Y |
| Category (header) text | – | Y (engine only, no UI) | – | – | – | – |
| Personalise cover | Y | Y | – | – | – | – |
| Embedded preview | Y | Y | Y | Y | Y | Y |
| Preview click-to-jump (`pv*`) | Y | Y | Y | Y | Y | Y |
| Standalone `/preview/` | Y | Y | Y | Y | Y | Y |
| Export | Y | Y | Y | Y | Y | Y |
| Working harness | Y | Y | **NONE** | Y* | Y | Y |

⚠ ADD produces corrupted output — see §8. \* only after fixing hard-coded paths — see §7.

**HARD RULE 6** (every editor keeps ADD and REMOVE): satisfied.
**HARD RULE 5** (build for all brands): violated on reorder — Capiche and Churn'd lack it.

---

## 4. Fieldmap schemas — four incompatible shapes

| Editor | Top-level keys | Page key |
|---|---|---|
| capiche | `fields, allowed, adv, page_sizes, sections, icons, add_const, nav_sections, jfont_by_page` | *(per-field `page`)* |
| aiko | `fields, sections, add_const, icons, allowed, adv, page_sizes` | *(per-field `page`)* |
| churnd | `brand, pdf, menu_page, row_h, page_sizes, sections, items, tm_shifts, allowed` | `menu_page` |
| drinks | `brand, pdf, menu_page, page_sizes, fields, items, allowed, bands, geo` | `menu_page` |
| capiche-surat / -ahm | `brand, pdf, menu_pages, page_sizes, pages, price_font, price_size, allowed, row_h, jmark, micons, mk_const` | `menu_pages[]` |

This fragmentation is the direct cause of two real problems: `foodh.js` cannot boot Churn'd
(requires `FM.fields`, Churn'd has `items`), and `markerh.js` cannot boot Aiko-drinks (reads
`FM.menu_pages`, which is `menu_page` there).

`allowed` is a **per-role charset** the editor enforces via `cleanField()`. It is not cosmetic — the
embedded fonts are subsets and genuinely lack glyphs (§8).

---

## 5. Deployment — unresolved

Two live paths exist and the repo does not say which is authoritative:

- **Cloudflare Worker** `bookends-chucky` — `deploy/worker.js` + `deploy/wrangler.jsonc`, static
  assets via the `ASSETS` binding, KV namespace `BUGS` (45-day TTL). **Verified serving today.**
- **Netlify** — `netlify.toml` publishes `deploy/public`, `netlify/functions/api.mjs` is a careful
  1:1 port of the Worker's bug API onto Netlify Blobs (with a manual TTL sweep, since Blobs has no
  native expiry). `netlify.toml` states the Worker is *deliberately* left on the old URL.

There is **no `.netlify` link and no Netlify URL recorded anywhere in the repo**, so which URL staff
actually open is unknown from the repository alone. CLAUDE.md §2/§4 still document only the wrangler
route, and §7's claim that `BUG_KEY` lives in `wrangler.jsonc` in the clear is **out of date** — it
was removed and the file now says to treat the old value as burned.

`/preview/` needs no routing config on either host (Worker falls through to `ASSETS`, Netlify
publishes the directory).

---

## 6. Preview architecture

Three layers, all showing the **real generated PDF** — no HTML approximation anywhere:

1. **Embedded preview** — pdf.js canvas inside each editor, debounced re-render.
2. **`pv*` click-to-jump overlay** — invisible boxes over the rendered page, positioned in *percent*
   so they stay aligned at any scale; clicking one scrolls to that dish's card and flashes it. Boxes
   follow removal reflow. Ported from production into all six editors.
3. **`/preview/` standalone** (`deploy/public/preview/index.html`) — full-page viewer: all pages,
   zoom, fit-width, fit-page, page nav with typable indicator, full screen, Print, Download, return
   to editor. Loading and error states throughout.

**Handoff:** the editor opens `/preview/#<jobId>` *synchronously* in the click handler (opening it
after the `await` makes browsers treat it as a pop-up and block it), then calls its own
`regenerate()` — the same call Export makes — and writes the bytes into IndexedDB under that id.
Only a random job id enters the URL. Nothing is uploaded. The record is one-shot (deleted on read)
and stale jobs are swept after 10 minutes. Preview and export are **the same bytes by construction**.

**Not verified:** the browser leg of that handoff (jsdom has no IndexedDB). Verified up to and
including the bytes handed over.

**Dependency risk:** pdf.js and pdf-lib load from `cdnjs.cloudflare.com` with **no SRI**. The editors
are non-functional offline, and a cdnjs compromise would run arbitrary code inside the tool that
produces print-ready menus. Vendoring or SRI is the fix; it would also remove the documented
"preview hangs in sandboxes" caveat.

---

## 7. Test coverage

**Exists:** `foodh.js` (food text edits), `foodh_ar.js` (add/remove via `REMOVED`/`ADDED`/`ORDER`
env vars), `markerh.js` (drinks markers/add/remove), `framh.js` (drinks photo framing),
`src/drinks/harness_bands.js` (Aiko drinks — **14 assertions, all passing**).

**Gaps:**

- **Churn'd has zero coverage and cannot boot any existing harness** (schema mismatch, §4).
- **Four committed test files hard-code the previous maintainer's macOS scratchpad**
  (`/private/tmp/claude-501/-Users-apple/…`): `src/drinks/harness.js`, `src/drinks/harness_bands.js`,
  `src/capiche/repro_risotto.js`, `src/capiche/test_markers.js`. They fail immediately elsewhere.
- `framh.js` requires `/tmp/frame_test.jpg`, a fixture **not in the repo**.
- **No test renders anything.** Every harness stops at bytes — which is exactly why the ADD font bug
  (§8) survived: it is invisible at the byte level and obvious in a render.
- No byte-identity regression test, despite that being the cleanest invariant available.
- CLAUDE.md §5 does not mention `src/drinks/harness*.js` at all.

**Render tooling:** CLAUDE.md specifies Python + PyMuPDF. Python is not installed on the current
maintainer's machine. MuPDF's WASM build (`mupdf` on npm) works cross-platform with no native build
and was used for every render audit in this document.

---

## 8. Known bugs

**ADD stamped the wrong font (Capiche page 0) — FIXED in Phase 0c.**
Font resource names are **page-local** in PDF, but `add_const.fonts` was a single global map.
`add_const.fonts.desc` is `/T1_0`, correct on page 1 but on page 0 a completely different (serif)
typeface with an incompatible encoding — adding a dish to a PIZZAS section printed
`TOMATO, ⊗SIL, MOZZARELLA` in serif with a `.notdef` blob. The *same* dish added to a page-1 section
rendered perfectly, which is what identified the cause.
Fixed by `pageFonts(p)` in both food editors: resolve the resource the page's OWN baked fields use,
falling back to `add_const.fonts`. This generalises `jfont_by_page`, which already did exactly this
for the J glyph. **Aiko was measured, not assumed:** it uses `/TT0` on *both* pages, so it never had
the mismatch — an earlier claim here that page 1 used `/TT2` came from a mis-indexed probe and is
withdrawn. Aiko gets the same resolver purely for parity and to keep a future artwork rebuild from
reintroducing the bug silently; it returns the values it replaces.
Note the resolver scans the whole stream prefix rather than a fixed window — on Aiko page 0 the
governing `Tf` is thousands of bytes back, and a small window silently finds nothing.
Pinned by the regression case *"capiche: ADD uses the target page font"*.

**ADD charset validation — NOT a bug. Earlier audit claim retracted.**
An earlier draft of this document claimed the add form skipped charset validation and would silently
print "TEST PIZZA" as "TEST PIA". That was **wrong**: it came from a harness writing directly into
`added`, behind the form, which no user can do. All six editors do validate, by one of two valid
mechanisms — Capiche/Aiko compute the offending characters and **disable the Add button**;
Churn'd/Aiko-drinks/Surat/Ahm **strip and warn** via `cleanName()`/`cleanField()` + `fontNote()`.
The charset ceiling itself is real and unchanged (Capiche names have no `Z`; Surat/Ahm names lack
`X, Q, V, 7, 9`) — it is simply enforced rather than ignored. Pinned by *"<editor>: ADD is gated on
the font charset"* across all six.

**Stored XSS in `/bugs/` — critical.**
`bugs/index.html:79` interpolates `b.shot` into `<img src="…">` **unescaped**, and `esc()` escapes
only `& < >` — not quotes — so `href="${esc(b.url)}"` is injectable too. Both fields arrive from the
**unauthenticated public** `POST /api/bug`, which only checks `typeof === 'string'`. Payload executes
in the dashboard operator's browser, which holds `chucky_bugkey` in `localStorage`.

**Capiche silently truncates over-long names.**
`wrapName()` slices to the baked line count, so "MANGO PICANTE" exports as "MANGO" — the word is
*dropped*. The drinks editors deliberately do the opposite ("merge rather than drop: an over-long
line is visibly wrong in the preview, a silently truncated one is not"). Capiche should adopt that.

**Aiko's empty-edit export is not byte-identical.**
Page 0 gains ~10.6 KB of re-emitted `/GS0 gs /TT0 1 Tf 0 Tc 0 Tw` state blocks even with no edits.
Present at `HEAD` and before any recent change. Not a corruption (renders correctly) but it breaks
the cleanest invariant we have.

**Category editing is blocked by two artwork facts** (Aiko, investigated in depth):
1. The gold decorative label is **text *and* stroked vector letterforms superimposed** — 15,566 bytes
   and 368 curve operators for "Starters" alone, in 8 `q..Q` groups spanning exactly the word's
   x-range. Editing only the text run yields a double image. *Deleting the vector layer and retyping
   renders cleanly* (verified), so it is solvable — the vector spans are locatable for all 7 labels.
2. The category fonts are **subsets**: `/TT1` (names) = `" DMNRSacdehilmnorstu"`, `/TT2` (labels) =
   `"LSaeghilmnoprstuwy"` with **no space glyph at all**. "Small Plates", "Dumplings" and "TO SHARE"
   are all unrepresentable. Lifting this needs fuller font subsets embedded — still byte-level, but a
   distinct piece of work needing the designer's font files.

Fixed this session: drinks export crash (`const nN` decremented → `regenerate()` threw and the whole
export failed whenever the clamp fired), drinks multi-line name fitting, `rowLayout` no-description
anchor, Aiko grams-tag overlap.

---

## 9. Live vs local

Live and local **diverged in both directions**. Neither was a superset. Reconciliation is partly done.

Ported into the repo: the `pv*` overlay (all six) and `safeDel`/`safeOp` (Capiche). `safeDel` guards
a deletion welding the byte before to the byte after (`Q`+`q` → `Qq`, after which parsers abandon the
rest of the stream and every dish below vanishes). **Honest note:** no weld was reproducible on this
lineage either before or after the guard — local's newer `mergeSpans` carve appears to keep spans on
operator boundaries — so it is defensive parity, not an active fix.

**Still live-only, and the one thing blocking any deploy:** the Surat/Ahm name-wrap subsystem —
`nameWrap`, `nameRoom`, `renderedNameLines`, `bakedLastLine`, `markerReserve`, `strayRowIcons`,
`tidyMarkerOps`, `numSpanIn`, `wrapTo`. `strayRowIcons` handles baked icons the fieldmap never
captured. Live's `nameRoom()` already uses `photo_tile` as the row box — the same source of truth the
local fitting fix independently derived.

The fork is dated by `capiche-drinks-editors.md`: multi-line names deployed 2026-07-15 (`ee8c6ef1`);
NEW-badge + SPECIALS toggles built 2026-07-27 and *"NOT yet deployed"* — the latter is the local-only
work. `backups/*_20260727_170244.html` predate **both** lineages and cannot serve as a base.

**Until that subsystem lands, deploying this repo removes working production features.**

---

## 10. Security risks

1. **Stored XSS in `/bugs/`** — see §8. Can exfiltrate `BUG_KEY`.
2. **The passphrase gate is decorative.** Only `/chucky/` and `/menu/` check it; every editor and
   `/bugs/` are reachable directly — verified live, HTTP 200 with full content, unauthenticated. The
   gate only hides the tile list, and the passphrase *and its SHA-256* are published in the repo's
   root `README.md`. This must not be treated as authorization.
3. **`POST /api/bug` is unauthenticated**, CORS `*`, no rate limit. `shot` is capped at 900 KB but
   **`state` has no size cap at all**.
4. **`BUG_KEY` travels in the query string** — lands in access logs, browser history, referrers.
   Its value is not in this repo's history and the scratchpad that held it is gone, so it likely
   needs reissuing.
5. **No SRI on CDN scripts** — see §6.
6. **If the repo goes public:** the passphrase + hash in `README.md`, the KV namespace id, the
   workers.dev hostname and the restaurant's artwork PDFs all become public. `wrangler.jsonc` has
   already had `BUG_KEY` correctly removed.

---

## 11. Recommended order

**Phase 0 — stabilise (in progress)**

- **0a** this document.
- **0b** testing baseline: `mupdf` as a devDependency + committed render/audit helpers; strip the
  machine-specific paths; add a Churn'd harness; a regression suite that *renders* and pins the known
  bugs as declared known-failures.
- **0c** ✅ done — ADD font selection via `pageFonts(p)`. The companion "ADD charset" item was
  investigated and **withdrawn**: no such bug exists (see §8).
- **0d** `/bugs/` XSS, payload caps, URL validation.
- **0e** Surat/Ahm name-wrap reconciliation. **No deploy is safe before this.**

**Then, in order of dependency rather than ambition:** category editing (needs the vector-overlay
strategy and a font-subset decision first), dish-editor expansion, markers/badges, typography and
colour tokens, images, cover, decorative elements, page management, structural editing, Layout Mode.

Two standing rules worth repeating: **one editor, one render audit, one deploy** — never batch
PDF-affecting changes across editors; and a feature is done only when the *rendered PDF* is correct,
not when the code compiles.
