---
name: fontless-block-inherit-bug
description: "Food-menu text blocks with no Tf inherit an earlier block's font — deleting a span that carries that Tf silently re-fonts later text (letters vanish)"
metadata: 
  node_type: memory
  type: project
  originSessionId: dd29cd90-79fd-49fd-9b88-6e90a1b2a4c4
---

**The "GARLIC BREAD" bug (2026-07-14, found + fixed, deployed e3068a7e).** Yash reported GARLIC BREAD's description rendering as just `[180]` in the Capiche preview instead of "STUFFED WITH CREAM CHEESE & HERB BUTTER [180GMS]".

**Root cause (NOT the roomier-text change — pre-existing):** some text blocks in these menus do **not set their own font**. Compare Capiche page 1:
- `1:23` DOUGHBALLS desc: `BT /T1_0 1 Tf  0 Tw 6.5 0 0 6.5 x y Tm (…)Tj ET`  ← sets its font
- `1:25` GARLIC BREAD desc: `BT 0.727 0.668 0.652 0.813 k  0.05 Tc 6.5 0 0 6.5 x y Tm (…)Tj ET`  ← **no Tf**, inherits from earlier in the stream

The `Tf` that `1:25` inherited lived at byte 262223 — *inside DOUGHBALLS' baked Jain marker span* `[262194,262290]` (`BT <k> /T1_0 1 Tf … (J)Tj ET`). Toggling DOUGHBALLS' markers makes the marker engine DELETE that baked stamp, taking the `/T1_0 1 Tf` with it. `1:25` then inherits a digit-only subset font, so only `[`,`1`,`8`,`0`,`]` have glyphs → renders `[180]`. Every letter silently disappears.

**Fix:** when deleting a span, leave its last `Tf` behind — same graphics state, nothing drawn:
```js
function keepFont(sp, p){                    // in aiko + capiche, next to the desc helpers
  const seg=pageText(p).slice(sp[0],sp[1]);
  const m=seg.match(/\/[A-Za-z0-9_]+ [\d.]+ Tf/g);
  return m? m[m.length-1]+'\n' : '';
}
```
Applied at BOTH delete sites in each editor: `dels` (dish removal) and `allerDelSpans` (aiko) / `mkDelSpans` (capiche). Verified: repro (toggle markers on the dish ABOVE, with NO edit to the victim) → `[180]`; after fix → full text; whole page clean; no-edit output pixel-identical in both editors.

**Lesson / watch for this:** any byte-level span DELETE can strip graphics/text state that later blocks depend on (font here, but the same applies to colour `k`/`scn`, `Tc`, `Tw`). Symptom is spooky-action-at-a-distance: editing dish A breaks the *rendering of dish B below it*. If a menu shows missing letters or only digits/brackets survive, suspect a stripped `Tf`. See [[roomier-text-limits]] [[chucky-aiko-editor]] [[audit-as-viewer]].

**UPDATE (2026-07-27) — the drinks editors WERE exposed, via colour.** This note used to claim
[[capiche-drinks-editors]] were safe because they stamp J/dairy/gluten with device colour + explicit
font. That reasoning covered the *stamped* markers but not the *baked* art next to them. On
capiche-ahm page 1 the NEW badge starburst above MANGO PICANTE carries **no colour operator of its
own** — it renders brand red purely by inheriting the `0 0.993 1 0  scn` set by the baked Jain "J"
immediately before it. Renaming the drink (or toggling its markers) deletes that `marker_span`, and
the badge fell back to the body-text grey `0.73 0.668 0.652 0.816 scn` and printed **dark**. Two
`Tw` variants existed too (PINA COLADA's `marker_span` carries `0 Tc 0 Tw`, whose loss retightened
the next drink's description).

Fixed by generalising `keepFont` into **`keepState`** in both `capiche-ahm/index.html` and
`capiche-surat/index.html`: preserve every state operator inside a deleted span that is *still in
effect at the span's end*. Two things `keepFont`'s regex approach cannot do and `keepState` must:
- **track `q`/`Q` depth relative to the span start** — the other two badges set their red *inside* a
  balanced `q…Q`, so it does not leak and must NOT be replayed. Levels can go negative (`photo_span`
  ends one `Q` below where it opens) — never assume balance, never rebalance.
- **skip `(...)` literals** — deleted `desc_spans` contain description text, and a `q` inside a
  string would otherwise read as save-state.

Preserve only POSITION-INVARIANT state (`cs CS gs` colour, `Tf Tc Tw Tz TL Ts Tr`). Never add
`cm`/`Tm`/`Td`/`W`: that is the only reason this composes with `reflowOps` (which rewrites every
`Tm`/`cm`/`re`) without overlapping ops. Emit `cs` before the fill — `scn` operands are read in the
current colour space.

Verified: no-edit output stream byte-identical in both editors; the badge probe goes red=0/dark=7918
→ red=7828/dark=0 on rename; the only pixel change in the whole page is the badge box; the `Tw` case
becomes pixel-identical to the unedited base. The food editors have NOT been audited for the
colour/`Tw` variants — `keepFont` there should eventually become `keepState` too.
