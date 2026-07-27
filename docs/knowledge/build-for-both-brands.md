---
name: build-for-both-brands
description: "When Yash says build, build for BOTH brands — separate code, identical interface"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: dd29cd90-79fd-49fd-9b88-6e90a1b2a4c4
---

Yash: "when I say build I say build for both but keeping each other development separate but the seamless interface should be same for both."

**Why:** Chucky serves multiple Bookends brands (Capiche, Aiko, more later). A feature should land everywhere, and the UX must feel like one product.

**How to apply:** Apply each new feature/UI to **every** brand editor + the landing. Keep code **separate per file** (each brand's `deploy/public/<brand>/index.html` carries its own self-contained copy — don't couple them into a shared import) but make the **interface identical** (same components, same look, same behavior). This **supersedes the earlier "don't touch the Capiche editor" rule** — but still only touch UI/chrome on Capiche, never its byte-verified PDF engine. See [[chucky-aiko-editor]].
