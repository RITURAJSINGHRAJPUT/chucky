# Engineering knowledge

Working notes ported from the previous maintainer. They record the actual problems hit and how they
were solved — read the relevant one before touching that area.

| File | Covers |
|------|--------|
| `chucky-aiko-editor.md` | The whole system: editor shell, byte-level method, Aiko/Capiche/Churn'd food editors, divider engine, allergen icon sizing, section grouping. Start here. |
| `capiche-food-rebuild.md` | How to adopt a **new food blueprint PDF** with `src/capiche/build_food.js` (the reconstructed builder), plus all the parsing/marker/max_chars gotchas. |
| `capiche-drinks-editors.md` | Capiche Surat + Ahmedabad drinks editors: build pipeline, add/remove, markers, photo crop, named versions, deploy notes. Long but thorough. |
| `aiko-drinks-editor.md` | Aiko drinks editor (band-model rebuild, gradient-from-description). |
| `personalise-cover.md` | Staff-side occasion + guest-name stamping on Capiche/Aiko covers. |
| `roomier-text-limits.md` | The "use the space + auto-shrink" text-fitting for names/descriptions. |
| `fontless-block-inherit-bug.md` | The GARLIC BREAD "[180]" bug — deleting a span can strip a `Tf` later blocks inherit; fixed via `keepFont()`. |
| `bug-report-loop.md` | In-editor bug button → Worker API + KV → `/bugs/` dashboard; the pending autonomous-fixer idea. |
| `audit-as-viewer.md` · `editors-need-add-remove.md` · `build-for-both-brands.md` | Working principles the owner expects (also summarized in `../../CLAUDE.md`). |

Note: these files carry a little frontmatter and `[[wiki-links]]` from the notes system they came
from; the links just point to the sibling file of the same name.
