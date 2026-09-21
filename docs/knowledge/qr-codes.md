# QR codes — click to resize / move / change link / remove, "+ QR" to add

Every editor (all 7) has the same QR tool on its live preview:

- **Click a QR** → panel: **Size** (− / slider / +, shown in cm), **Move** (arrows = 0.5 mm, or
  drag the QR on the page), **Change link…**, **Reset**, **Remove** (a removed QR shows as a
  hatched box; click it → **Restore**).
- **+ QR** (top-right of the preview) → paste a link → a new code appears mid-page at 60 pt
  (~2.1 cm); drag it into place and size it. Warns under 1.8 cm.
- QR edits live in the normal edit state (`memSnapshot().qr`), so autosave, history and
  **Publish** carry them like any other edit.

## How it works (why nothing else moves)

The byte engine addresses text by offset into each page stream, so the QR tool never edits those
streams:

1. **Artwork QRs** were baked once (`npm run qr:bake` → `src/shared/qr_bake.mjs`) into Form
   XObjects tagged `/ChuckyQR` (+ `/ChuckyQRPage`, `/ChuckyQRLabel`, `/ChuckyQRUrl`). The QR's
   contiguous slice of ops moved into the Form and the slice in the page stream became
   `/CkQRn Do` + space padding — **same byte length**, so no fieldmap span moved. The bake is
   render-verified (baked page pixel-identical to the original; hiding the Form removes exactly
   the QR) and idempotent.
   At runtime resize/move = the Form's `/Matrix`, remove = `/BBox [0 0 0 0]`, untouched = the
   Form's original objects go back (byte-identical export).
2. **Added QRs** (and "change link", which hides the artwork QR and adds a fresh code at its
   size/centre) are drawn in an overlay stream: `/Contents` becomes
   `[ "q", <engine stream(s)>, "Q", overlay ]`. The q/Q isolates any state the artwork leaves
   open. Codes are generated in-browser by the repo's own encoder (`src/shared/qr/encode.mjs`,
   byte mode, EC level M, v1–10 ≈ 210 chars max), K-only black on a white 2-module quiet zone.
   Clearing the last added QR deletes the overlay objects so the export is byte-identical again.

Current artwork QRs: Capiche p1 Instagram, Capiche p2 FSSAI, Aiko p2 FSSAI + Linktree.
Churn'd, Beshak and the three drinks menus have none — they get "+ QR" only.

## Maintaining it

- **One source:** `src/shared/qrtool/qrtool.src.js`. `npm run qr:inject` copies it (with the
  encoder inlined) into every editor between `/* QRTOOL:BEGIN */ … /* QRTOOL:END */` — Beshak's
  copy goes into `src/beshak/ui.js` and the editor is re-assembled. `npm test` fails if any copy
  is stale. Never edit the injected copy.
- **Per-editor glue** (outside the markers): `QRK.apply(doc)` right before `doc.save()`,
  `QRK.hits(hl, activePage, W, H)` at the end of `pvSync()`, `qr:QRK.snap()` in `memSnapshot`,
  `QRK.load(st.qr)` in `memApply`, `QRK.init({refresh: () => schedulePreview()})`.
- **After rebuilding a base PDF** (new design drop): run `crosspromo_bake.mjs` as before, then
  `npm run qr:bake`. A NEW QR in the artwork needs a job (zone + label + url) in `qr_bake.mjs`;
  find zones by decoding a 400 dpi render of each page.
- **Test:** `npm run test:qr` (`test/qrtool.test.mjs`) — every editor: discovery, resize / shrink
  / move / remove measured from renders, added + relinked codes decoded back out of the rendered
  page, nothing outside an added QR changes, byte identity when cleared, state round trip, and a
  jsdom drive of the click panel.

## Gotchas

- Resizing grows about the QR's **centre**; a caption right under it (e.g. `@PIZZA.CAPICHE`) can
  be covered — move it up a little, or keep it small.
- Removing an artwork QR does not remove its **caption text** (e.g. "Scan for FSSAI license") —
  that's ordinary menu text.
- MuPDF's `Pixmap.getPixels()` is a view into WASM memory that the next render reuses —
  `.slice()` it before rendering again, or two renders silently compare equal.
