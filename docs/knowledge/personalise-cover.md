---
name: personalise-cover
description: "Staff-side \"Personalise cover\" (occasion + guest name on the menu cover) in the Capiche + Aiko FOOD editors, matching the Menual vendor app"
metadata: 
  node_type: memory
  type: project
  originSessionId: dd29cd90-79fd-49fd-9b88-6e90a1b2a4c4
---

**Personalise-cover feature (2026-07-16, DEPLOYED 2026-07-16 (version cebd5a86); wrangler re-logged-in via browser OAuth).** Yash pointed at the vendor app **menual.hellodigitworks.com/bookends** (by hellodigitworks — a customer-facing menu layer running on Bookends' Capiche/Aiko menus) and asked to bring its **personalised-cover** feature in-house. Chose: STAFF-SIDE, in the Chucky FOOD editors (`deploy/public/{capiche,aiko}/index.html`), Capiche + Aiko.

**What it does:** a header **✨ Personalise** button opens a dark modal — occasion dropdown (—/Welcome/Birthday/Anniversary/Congratulations/Let's Celebrate/Custom message…) + guest-name field. It byte-stamps the occasion + guest onto the cover page (page 0) of the menu PDF; Export PDF then outputs the personalised menu. Same stamping tech as everything else (append to the page-0 content stream).

**Engine (per editor):** `persona={occasion,guest}` state; `COVER` config; `personaLine(spec,text)` (centered or right-aligned via `spec.align/right`); `personaCover(p)` returns `{del:[spans],add:'stamp'}` for the cover page; wired into `regenerate` right before `spliceBytes` (del spans via `keepFont`) and appended to `addStr`. In `memSnapshot`/`memApply`. UI: `openPersona()` modal + `OCCASIONS` + `#persona` button + CSS (`.persov/.perscard/.cropbtn`). `schedulePreview()` refreshes live.

**Per-menu cover placement (tuned to MATCH Menual's look — Yash sent screenshots):**
- **Capiche** (`capiche.pdf` p0, 842×595 landscape = full menu; left panel = branding): stamp in the gap UNDER the "Capiche" logo, ABOVE the "15\" PIZZA / 00 FLOUR…" tagline. Centered `cx:113` (**2026-07-18 fix**: was `cx:135`, looked off-centre — Yash: "not centre align … centre align to capiche logo". The logo wordmark centroid is ~110 and the designer centred the tagline block at ~113; `cx:113` lines the occasion+guest up under the logo. Measured via red-pixel centroid of the wordmark, excluding the top-right badge which pulls a naive bbox to ~182). **Soft coral** `0.95 0.62 0.57 rg`, AOMonoBold `/T1_2`, occ size 13 (y 472) + guest 11.5 (y 454). `del:[]` (empty gap, nothing to hide). Deployed af355009.
- **Aiko** (`aiko.pdf` p0, 595×842 portrait, top has an "Aiko is our way of doing comfort…" intro at top-RIGHT): the intro is REPLACED — `coverDel()` finds the intro BT..ET block (delFind 'Aiko is our way' → delEnd 'made with care') and deletes it, then stamps occasion+guest in its place. **Grey** `0.72 0.72 0.72 rg`, right-aligned to `right:575`, /TT0 (MonospaceTypewriter — full charset), occ size 21 (y 800) + guest 17 (y 774).

Fonts on covers: capiche p0 = AOMonoBold `/T1_2`, AOMonoBlack `/T1_3`, DKLiquidEmbrace `/TT0` (the hand script — SUBSET, avoid); aiko p0 = MonospaceTypewriter `/TT0`, GhostCallsDialog2 `/TT2`, Geist `/TT3`. Use AOMono/Monospace (full charset), not the subset script.

**Verified:** live preview (capiche) + harness renders (both) match Menual's placement/colour/size; empty persona is INERT (byte-identical output pre-vs-post the change on both editors — proven vs the pre-change backup; aiko p0 always differs from pristine due to its baseline allergen re-stamp, unrelated). Harness `foodh.js` gained `PERSONA` env + `#persona` DOM stub. Backup zip current. **Still needs deploy** (wrangler `login` / CLOUDFLARE_API_TOKEN — see [[capiche-drinks-editors]] deploy note). Guest-facing public version was deferred (Yash chose staff-side first). See [[chucky-aiko-editor]] [[roomier-text-limits]] [[audit-as-viewer]].
