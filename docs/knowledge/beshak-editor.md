---
name: beshak-editor
description: Beshak (5th brand) — how its artwork differs from every other Chucky editor, and what that forced
metadata:
  type: project
---

# Beshak — the fifth brand

**Live path:** `/beshak/` · **`MEM_BRAND`:** `beshak` · **Source artwork:** `incoming/Beshak_DineIn_Menu.pdf`
**Build:** `npm run beshak:build` (data + editor) · **Test:** `npm run test:beshak` (also folded into `npm test`)

Two A4 pages: APPS on page 1; DRINKS / BREADS / MAINS / DESSERT on page 2. 26 dishes, each with a
name, a "250 gm" / "300 ml" size label, a price, a description, and up to four allergen markers
(dairy · gluten · sesame · jain).

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

### 4. Page 2's dairy / gluten / sesame markers are pixels, not paths

Blanking the page's background image and re-rendering proves it: on page 2 only the Jain "J"
survives. The milk bottle, the wheat ear, the sesame cluster and the section rules under each
heading are all baked into a ~305dpi full-page raster.

That is worked around, not lived with:
* **Removing** a raster marker paints its box out. The artwork behind every marker slot is pure
  white (sampled, not assumed), so a `0 0 0 0 k … re f` box is invisible.
* **Adding** one stamps a vector. Dairy and Jain are lifted exactly from page 1's real vectors;
  gluten and sesame are traced from the raster by `src/beshak/trace.js`, which walks the **0.5
  iso-contour of the ink coverage** rather than thresholding to a bitmask — thresholding throws the
  sub-pixel edge away and leaves a visible staircase at print zoom.
* Sesame appears only in the legend, which draws its icons larger than the inline ones (measured:
  inline dairy 5.22×9.84pt vs legend 5.94×11.22), so the sesame trace is scaled by `0.877`.

An icon in the source is drawn as `q <outline> W n /RNNN Do Q` — the outline **clips** an XObject
that fills a rectangle. Clipping and filling both use the nonzero rule, so `<outline> f` under the
brand colour paints identical pixels while depending on nothing; that is what `stampMarker` emits,
and it is why a stamp works on either page.

### 5. Section bands come from the rules, not the headings

BREADS and MAINS share a baseline, and MAINS is set flush right over its own two columns — so
neither heading order nor heading x can say which dish belongs to which. What does separate them is
the **rule under each heading**, which spans exactly the block it introduces. On page 2 those rules
are in the raster, so `detectBands()` finds them as ink rather than as operators.

---

## Layout rules the engine follows

* **Cluster follows the name.** The designer set the *gap* between a name and its size label +
  icons, so an edited name slides the whole cluster by the width delta rather than leaving it
  parked. `clusterShift()` returns exactly `0` for an unedited dish — measuring against the stored
  `right` instead would return a hair of drift and re-stamp every marker, which quietly breaks the
  byte-identity guarantee.
* **Removal reflows its column.** Everything below a removed dish rides up by that dish's `slot`.
  PDF y grows upward, so riding up means **adding** the slot height. Any dish that moves has its
  raster markers patched out and re-stamped as vectors at the new spot, so nothing is left behind.
* **Marker order** is the legend's: dairy · gluten · sesame · jain.

---

## Files

```
src/beshak/
  lib.js            PDF loading + Identity-H content-stream parsing (shared by everything below)
  normalize.js      designer PDF -> editable PDF: uncompress editable streams, merge font subsets
  fontmerge.js      union of a family's two per-page subsets (TrueType glyf/loca/hmtx surgery)
  trace.js          ink coverage -> iso-contour -> path ops (the raster-only marker icons)
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

* Empty edit exports **byte-identical** streams (all 32) and a **pixel-identical** render.
* The normalisation step (uncompress + merged fonts) is pixel-identical to the designer's file at
  150dpi on both pages — the merge changes what *can* be typed, never what is already printed.
* Marker add/remove on both pages, name/desc/price/size edits, removal with reflow, add, and the
  charset gate (including on added dishes) are each rendered and read back.

## Not done

* **The cover.** Page 1's BESHAK logo is artwork, and the legend at the foot of page 2 is raster —
  neither is editable. No other editor edits its cover either (Churn'd's is also untouched).
* **Section headings** (APPS / DRINKS / …) are not renamable; the Gasoline face is subset to 22
  glyphs, so most words could not be set even if the UI offered it.
* **Reordering** dishes. Removal reflows a column, but there is no drag-to-reorder (only
  `foodh_ar.js`'s Capiche/Aiko path has that).
