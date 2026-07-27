---
name: roomier-text-limits
description: Yash wants more characters allowed in dish names + descriptions in the food editors (current line/char caps too tight)
metadata: 
  node_type: memory
  type: feedback
  originSessionId: dd29cd90-79fd-49fd-9b88-6e90a1b2a4c4
---

2026-07-14: On the FOOD menu editors (Dairy/Gluten/Jain/Ghaslet/NEW markers — e.g. Capiche/Aiko/Churn'd food), the name/description character limits are too tight. Yash hit "too long · 1 line max" on a legit dish ("DOUGHBALLS – A GHASLET SPECIAL" / "BAKED PIZZA DOUGH WITH WHIPPED GHASLET BUTTER [180GMS]") and said we should **allow more characters in names and descriptions**.

**Why:** real dish names/descriptions routinely exceed the current per-line/line-count budget; the hard cap blocks valid edits.

**Chosen model (Yash picked):** "use the space + auto-shrink" — a field uses every line that physically fits, and only if it's STILL too long does the font shrink. Only reject when even the smallest size can't fit.

**SHIPPED 2026-07-14 for DESCRIPTIONS in both food editors (aiko + capiche; churnd has no name/desc fields).** Result: aiko 34/45 descs gained room (mostly 1→2), capiche 10/39 (tighter layout). Deployed b0b33762.

**How it works (key insight — no re-stamp needed):** a baked desc is ONE text block `<font> 1 Tf <sz> 0 0 <sz> x y Tm (l0)Tj [0 <lead> Td (l1)Tj]... ET`. Extra lines are spliced INTO THE LAST BAKED SPAN as `Tj / 0 <lead> Td / (line)` pairs — the block's own trailing Tj closes the final line. Auto-shrink is just a Tm size swap (find the Tm by scanning back to the enclosing `BT`). This reuses the baked font/colour/position exactly, rides reflow like any other span, and needs no delete+append or marker coupling. Engine helpers live next to wrapFor/isOverflow: `pageText/descLead/descTm/gapBelowF/maxLinesAt/fitDesc`; `wrapFor` routes desc through fitDesc so every "too long" readout updates for free.

**GOTCHAS (both caught by viewer-audit renders, not by reasoning):** (1) the usable floor is the DIVIDER RULE between dishes, not the next field's baseline — measuring to the next field let a 3rd line cross the rule. Use `_dividerLines()` and clamp. (2) A field's baseline is NOT a safe floor either — glyphs rise above it; use `g.y + g.size*0.72`. (3) Cap growth at **baked+2**: a last-in-column desc had an 80pt gap and the math allowed 9 lines (absurd, and that space can hold art/headers absent from `fields`). (4) The menu's own tightest baked clearance above a rule is ~1.4pt — use that as DESC_CLEAR to maximise room without touching. Verified: unedited menus render pixel-identical pre/post change (aiko's page0 always differs from pristine — that's its pre-existing allergen menu-truth correction, not a regression). Harness: `foodh.js`.

**NAMES — attempted 2026-07-14, REVERTED (not shipped). Read this before retrying.**
Names CANNOT grow lines: the description sits only ~10pt below the name baseline, so a 2nd name line lands on the description. So names = shrink-to-fit only. But shrink alone is NOT enough — attempts surfaced two collisions in a row, each caught only by a render:
1. **Markers collide.** Baked markers sit right after the ORIGINAL name (e.g. capiche 0:18 "GARLIC PIE", markerBase x=643.98), so a longer name renders straight through the icons. Markers must MOVE with the name. Wiring that works: derive the advance empirically as `perChar=(markerAnchorX - f.x - GAP)/bakedLastLineLen` (exact for the baked name), compute `nameMarkerX = f.x + newLastLineLen*perChar*(newSize/f.size) + GAP`, add a `nameMoved(f)` predicate, and force a marker re-stamp for renamed dishes — aiko: relax the `desired==baked` skip + use the new bx with `markerGroup`; capiche: add name-moved dishes to `mkDishes`, use the new x in `stampMarkers`, AND make `badgeOps` skip them too (else double NEW badge). aiko uses `marker_bx`+`marker_stamps`; capiche uses `markerBase`+`markerSpans` — two different systems.
2. **Then the PRICE collides.** With markers following, a long name pushes the icons onto the price. **`max_chars` is NOT a usable name budget** — for capiche 0:18 max_chars=24 at size 13 (~9.29/char) ends at x≈767, past its price at x=751.55, even with no markers. The real budget must be computed per dish: `nameEnd_max = (leftmost price.x on the same row) - pad - markerClusterWidth - GAP`, then shrink until it fits. Marker cluster width: aiko has `allerWidth(al)`; capiche can derive from add_const `icon_*` cumulative x-offsets (dairy 0, gluten 5.52, j 7.93, spicy 14.92, badge 39.67).
Reverted because each fix revealed another collision and this is live customer menus. Redo it as a focused piece: compute the price-bounded budget FIRST, then shrink, then move markers — and render-audit every dish that has markers + two prices. Descriptions are unaffected and remain live.
See [[chucky-aiko-editor]] [[audit-as-viewer]] [[build-for-both-brands]].
