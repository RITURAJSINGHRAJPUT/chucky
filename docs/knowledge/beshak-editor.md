---
name: beshak-editor
description: Beshak (5th brand) — how its artwork differs from every other Chucky editor, and what that forced
metadata:
  type: project
---

# Beshak — the fifth brand

**Live path:** `/beshak/` · **`MEM_BRAND`:** `beshak` · **Source artwork:** `incoming/Beshak_DineIn_Menu.pdf`
**Build:** `npm run beshak:build` (data + editor) · **Test:** `npm run test:beshak` (also folded into `npm test`)

Two A4 pages: APPS / BREADS / MAINS on page 1; DRINKS / DESSERT on page 2. 30 dishes, each with a
name, a "250 gm" / "300 ml" size label, a price, a description, and up to three allergen markers
(dairy · gluten · jain).

> **Built from the 12 Sep 2026 artwork.** That drop changed the menu's shape, not just its
> wording: sections moved between pages, MAINS gained a third column, the dish count went 26 → 30,
> and **sesame was dropped from the legend entirely**. Before it, page 2's markers and section
> rules were baked into a full-page raster; they are all drawn in the content stream now. If you
> are reading this against an older PDF, the four "Why Beshak needed its own everything" points
> below still hold except §4, which that drop retired.

---

## Why Beshak needed its own everything

The other four brands' artwork all shares a shape: one content stream per page, simple fonts, text
sitting directly in that stream. Beshak breaks all three assumptions, and every unusual thing in
`src/beshak/` traces back to one of them.

### 1. The editable bytes are not in the page content stream

Each page's `Contents` is an ~80-byte stub:

```
q 0.1 0 0 0.1 0 0 cm  /NonStruct/R7 BDC  1 g  0 0 5955 8422.5 re f  EMC  /R110 Do  Q
```

Everything is inside that one Form XObject, drawn at **0.1 scale** — so coordinates inside the
artwork are in tenths of a point (`ART = 10` in the engine). The "250 gm" labels are one level
further down again, each in its own tiny sibling XObject positioned by its `/BBox`.

Consequences, all visible in the fieldmap:
* Pristine bytes are kept **per stream** (`FM.streams`, `PRISTINE[id]`), not per page; every field
  says which stream its spans index.
* A size label can only be moved or hidden through the `/RNNN Do` that draws it — its own BBox
  fixes it in place. That call site is stored as `do_span`.
* `test/lib/pdf.js`'s `byteIdentical` / `pageStreams` are useless here (they'd compare the stubs and
  always pass), which is why `test/beshak.test.mjs` re-implements those checks against `FM.streams`.

### 2. Identity-H text: every glyph is a 2-byte CID

All five faces are subset `CIDFontType2` with `/Encoding /Identity-H`, and the distiller wrote one
glyph per string with a kern between them:

```
[(\x00\x12)0.0719(\x00\x82)0.0719(\x00\x8D)…]TJ      % "Pal…"
```

So writing text means going through the font's ToUnicode map, which the fieldmap ships as
`families[fam].uni2cid` plus per-CID `widths`. The engine re-emits the same one-glyph-per-string
shape using the field's **median baked kern**, so edited text keeps the artwork's tracking.

⚠️ Beshak sets `1 0 0 1 x y Tm` with the size on the `Tf`. Td offsets are therefore already in text
units and must **not** be multiplied by the font size — that multiplication is a Capiche-ism
(Capiche bakes the size into the text matrix) and copying it here puts every second line in the
wrong place.

### 3. The fonts are subsets, and that limits what can be typed

Each family is embedded **twice**, once per page, each subset to the glyphs that page happens to
use. `src/beshak/fontmerge.js` merges the two into their union and writes it into both font objects
(GIDs are preserved across the subsets — verified: every CID the two copies share decodes to the
same character), which is what lets page 1 type letters that only page 2 had.

Even merged, the display face is 50 glyphs. **`FM.allowed.name` has no `E H I L O Q X Y Z` and no
`b q v x z`**, because nothing on the menu uses them. The editor surfaces this per field and blocks
export, the same way Churn'd handles its missing `Q`/`X`. To lift it, the design team has to supply
a PDF with the fonts fully embedded (not subsetted); nothing in this repo can invent the outlines.

⚠️ When rebuilding a merged TrueType, carry the **left side bearing** through `hmtx`, not just the
advance width. Zeroing the lsb shifts every glyph horizontally — it rendered as a ~0.7pt creep that
looked like a kerning bug and cost a while to find.

### 4. The three markers are not drawn the same way

All three are now in the content stream on both pages (the pre-Sep-2026 artwork baked page 2's
into a raster; `trace.js`'s header still describes that world). But they split two ways, and
`iconInventory()` in the builder keys off exactly that:

* **dairy** and **jain** are drawn as `q <outline> W n /RNNN Do Q` — the outline **clips** an
  XObject that fills a rectangle. Clipping and filling both use the nonzero rule, so
  `<outline> f` under the brand colour paints identical pixels while depending on nothing. That
  is what lets the builder lift them as reusable stamps and `stampMarker` re-emit them anywhere.
* **gluten** clips a plain rectangle and paints an **image** through it — there is no outline to
  lift. Its stamp is traced off the printed page by `src/beshak/trace.js`, which walks the **0.5
  iso-contour of the ink coverage** rather than thresholding to a bitmask (thresholding throws
  the sub-pixel edge away and leaves a visible staircase at print zoom). The trace region is
  derived from an instance found in the stream, not hard-coded, so it follows the artwork.

The distiller writes gluten as **two adjacent blocks** (the bare `re W* n`, then the same rect
plus the `Do`). Both have to go when the marker is removed, so `iconInventory()` merges them into
the single span that deletes it — take only the first and the icon stays on the page.

All three measure ~8.2–8.6pt tall, so size alone cannot tell them apart. Counting enclosed white
gaps can: the wheat ear has one per grain (~9), the milk bottle a few (~3), and the Jain "J" none
— and the "J" is the only wide one (~5.4pt against ~4.4). That is the rule in both the stream
inventory and `detectMarkers()`, the render-audit path the tests read exports through.

### 5. Section bands come from the rules, not the headings

BREADS and MAINS share a baseline, and MAINS is set flush right over its own columns — so neither
heading order nor heading x can say which dish belongs to which. What does separate them is the
**rule under each heading**, which spans exactly the block it introduces. `detectBands()` finds
those rules as ink rather than as operators, which is what let it keep working when page 2's rules
moved out of the raster.

⚠️ A heading can rule **several** segments: MAINS sets three columns and the designer broke its
rule over each of them. So a band carries `spans[]`, not one `x0..x1`, and because two headings
share a baseline their segments arrive mixed together — each segment goes to the nearest heading
at or left of it. Keeping only the segment nearest the heading (what the builder did when MAINS
had two columns) silently drops the third column's dishes into whatever section sits above them.

---

## Layout rules the engine follows

* **Cluster follows the name.** The designer set the *gap* between a name and its size label +
  icons, so an edited name slides the whole cluster by the width delta rather than leaving it
  parked. `clusterShift()` returns exactly `0` for an unedited dish — measuring against the stored
  `right` instead would return a hair of drift and re-stamp every marker, which quietly breaks the
  byte-identity guarantee.
* **Removal reflows its column.** Everything below a removed dish rides up by that dish's `slot`.
  PDF y grows upward, so riding up means **adding** the slot height. Any dish that moves has its
  markers deleted by span and re-stamped at the new spot, so nothing is left behind.
* **The last dish in a column needs a measured slot.** It has no neighbour below to measure
  against, and the column's *average* pitch is not enough on its own: Sourdough Naan sets three
  description lines where BREADS averages two, so an added dish placed at the average landed on
  top of its last line. Its slot is the larger of the average and its own printed height plus the
  tightest name-to-last-line clearance the designer used in that column.
* **Marker order** is the legend's: dairy · gluten · jain.
* **`marker_gap` is measured, not chosen.** The engine spends it before the first icon and between
  each pair, so a value tuned for older artwork (it was 4.6) sets every re-stamped cluster about
  2pt per gap wider than the baked ones beside it. The builder takes the median gap the designer
  actually used — 2.4pt here.

---

## Files

```
src/beshak/
  lib.js            PDF loading + Identity-H content-stream parsing (shared by everything below)
  normalize.js      designer PDF -> editable PDF: uncompress editable streams, merge font subsets
  fontmerge.js      union of a family's two per-page subsets (TrueType glyf/loca/hmtx surgery)
  trace.js          ink coverage -> iso-contour -> path ops (the gluten icon, which is an image)
  marker_extract.js lifts the real vector dairy/jain outlines out of the artwork
  blocks.js         top-level q..Q splitting + geometric bounds
  icons.js          XObject draw-site inventory
  build_beshak.js   THE BUILDER: beshak.pdf + fieldmap.json
  build_editor.js   assembles index.html from engine.js + ui.js + shared/memory.js + Aiko's shell CSS
  engine.js         the byte engine (regenerate, encoding, markers, reflow)
  ui.js             cards, chips, add/remove, search, preview, export, publish
  dump.js dumpx.js  read-only inspection tools used while building this
beshakh.js          jsdom harness — boots the SHIPPED index.html
test/beshak.test.mjs  22 checks, all rendered
```

`index.html` is generated but **committed**, like every other editor: `node src/beshak/build_editor.js`
after touching `engine.js` or `ui.js`, then `node --check` the inline script (hard rule 1) and rerun
the suite.

---

## Verified

* Empty edit exports **byte-identical** streams (all 36) and a **pixel-identical** render.
* The normalisation step (uncompress + merged fonts) is pixel-identical to the designer's file at
  150dpi on both pages — the merge changes what *can* be typed, never what is already printed.
* Marker add/remove on both pages, name/desc/price/size edits, removal with reflow, add, and the
  charset gate (including on added dishes) are each rendered and read back.
* All 30 dishes carry a price, a size label and their printed markers, and every dish lands in the
  section its rule puts it under (the three-column MAINS block included).

## Not done

* **The cover.** Page 1's BESHAK logo is artwork and no field is built for the legend at the foot
  of page 2, so neither is editable. No other editor edits its cover either (Churn'd's is also
  untouched).
* **The standing copy.** "Proudly Vegetarian. Entirely Delicious." is set in the display face and
  reads exactly like a dish name; the builder drops it because it sits under no section rule *and*
  has no price, and says so on the build log. Copy that gains a price would need a real rule.
* **Section headings** (APPS / DRINKS / …) are not renamable; the Gasoline face is subset to 22
  glyphs, so most words could not be set even if the UI offered it.
* **Reordering** dishes. Removal reflows a column, but there is no drag-to-reorder (only
  `foodh_ar.js`'s Capiche/Aiko path has that).
