---
name: editors-need-add-remove
description: Every Chucky menu editor must support add AND remove items by default — never ship edit-only
metadata: 
  node_type: memory
  type: feedback
  originSessionId: dd29cd90-79fd-49fd-9b88-6e90a1b2a4c4
---

Yash: when building a menu editor, **add + remove items is a baseline requirement, not a follow-up.** He flagged that the Churn'd editor shipped edit-only ("did you not check add or remove function... now always make sure you have that prior").

**Why:** menus change — flavours/items get added and dropped constantly; an editor that can only rename/reprice isn't finished.

**How to apply:** for any new or existing [[chucky-aiko-editor]] brand, treat **edit name/desc/price + add item + remove item + export** as the minimum "done" bar (the Capiche/Aiko bar). Don't defer add/remove or call an editor complete without it. Byte-verify add + remove (with reflow) in the harness before shipping.
