---
name: audit-as-viewer
description: "Before calling any menu \"done\", render it and read it as a viewer — every item, marker, price"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: dd29cd90-79fd-49fd-9b88-6e90a1b2a4c4
---

Yash: "aiko menu still got finalised without checking, never do this again. make sure you audit as a viewer, it has to be perfect." Twice now I shipped menus with visible defects (overlapping allergen markers that looked like emoji; an unspelled/placeholder dessert that exported).

**Why:** byte-tests passing ≠ the menu looks right. Rendering-level and content-level defects (garbled/overlapping icons, misspellings, stray words like "PDF", wrong prices) only show up when you actually LOOK.

**How to apply — before declaring any [[chucky-aiko-editor]] menu done:** render every page of the *runtime/exported* PDF (not just the static source) and READ it as a customer would — every item name (spelling), description (stray words), price, and marker (spacing/overlap). Fix what's wrong. Never call it "perfect" without this pass. Marker re-stamps must advance by each icon's real width (not anchor deltas) or they overlap.
