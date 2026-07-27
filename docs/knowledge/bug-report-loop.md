---
name: bug-report-loop
description: "In-app \"Report a bug\" button -> Worker API + KV -> /bugs dashboard; autonomous-fix loop pending an authorization-model decision"
metadata: 
  node_type: memory
  type: project
  originSessionId: dd29cd90-79fd-49fd-9b88-6e90a1b2a4c4
---

In-app bug reporting for the Chucky editors, so Yash reports a glitch from the app and Claude fixes it without him returning to chat / re-uploading screenshots. Built 2026-07-13.

**Shipped (live on bookends-chucky worker):**
- The static-assets-only worker was rearchitected into a real Worker script: `deploy/worker.js` + `wrangler.jsonc` gained `main`, `assets.binding:"ASSETS"` (assets now served via `env.ASSETS.fetch`), a KV namespace `BUGS` (id 53a121594626447e9579fcef063fdd64), and a `BUG_KEY` var.
- API: `POST /api/bug` (public — stores {id,t,status,editor,page,desc,url,state,shot} in KV, 45d TTL); `GET /api/bugs?k=BUG_KEY[&status=&lite=1]` (key-gated list; lite drops the base64 shot); `POST /api/bug/{id}?k=BUG_KEY` (key-gated status/resolution update). Anything else → static editor assets.
- BUG_KEY value is stored at scratchpad `bugkey.txt` (bk_… ). Gate is a plain var, not a secret — fine for this low-sensitivity ops tool.
- Report button: shared `src/shared/report.js`, injected as a separate `<script>` before `</body>` in ALL 6 editors (aiko/capiche/churnd/drinks/capiche-surat/capiche-ahm). Floating "🐞 Report a bug" pill (bottom-right). On send it attaches a preview-canvas snapshot (`#preview` → toDataURL jpeg 0.5) + the current edit state (`memSnapshot()`, read as globals since editor engines are classic non-module scripts → top-level lets/functions are on window) and POSTs to /api/bug.
- Dashboard: `deploy/public/bugs/index.html` (live at /bugs/). Lists reports with status pills (new=red / needs-auth=amber / fixed=green), snapshot thumbnails w/ lightbox, resolution notes, filter chips, and Approve/Mark-fixed/Reopen buttons that POST status updates. Key entered once → localStorage `chucky_bugkey` (kept out of served HTML). This is the "I don't have to open a chat" surface.

**Autonomy model (the triage rule the dashboard copy promises):** low-risk fixes → Claude ships + marks `fixed` with a resolution note; judgment calls → marks `needs-auth` with a proposed fix for Yash to Approve. Approve flips status→new+approved for the next run to apply.

**PENDING — the autonomous-fix loop itself is NOT built yet.** It needs a scheduled Claude task (mcp scheduled-tasks / CronCreate) that polls `/api/bugs?status=new`, reproduces via the audit harness, fixes, and either auto-deploys (safe) or marks needs-auth. Blocked on a decision Yash must make: the autonomy boundary + cadence, AND the real constraint that unattended cron runs may not be able to `wrangler deploy` through permission prompts (safest design = propose-in-dashboard + deploy on approval). Ask before wiring auto-deploy to the live customer site. See [[chucky-aiko-editor]] [[capiche-drinks-editors]].
