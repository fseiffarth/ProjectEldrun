## Group N — Internationalization (i18n)
*Files: `src/lib/i18n.ts` (the translation store — flat `lang → key → text`
maps for en/de/es/fr/it), every component under `src/components/`. Full
resumable plan: [`docs/i18n_translation_plan.md`](../docs/i18n_translation_plan.md).*

92. **Full app-wide translation coverage.** The i18n system
    (`src/lib/i18n.ts`) is complete and dependency-free, but was originally
    wired into only the Settings dialog's main panel — every sub-panel and
    every other component in the app hardcoded English text, which is what
    the user saw as "language settings only changing half of the
    descriptions". **In progress**, tracked file-by-file in the plan doc:
    Settings dialog + sub-panels, all of `components/layout/`, all of
    `components/common/`, and 11 of 16 files in `components/projects/`
    (including `ProjectPill.tsx`, the app's largest component) are done
    (~860 keys, 5-language parity verified, `tsc`/vitest green throughout).
    Remaining: 5 files in `components/projects/`, then
    `components/header/`, `tabs/`, `calendar/`, `files/`,
    `embed/`+`embed/deck/`+`embed/pdf/`, `monitoring/`+`stats/`, `App.tsx`,
    plus restructuring the hint/tour/lesson content data files
    (`src/lib/hints.ts`, `tour.ts`, `lessons.ts`) which hold real UI prose as
    plain strings today. The plan doc has the exact batch-script methodology,
    key-naming conventions, and a note on a concurrent-editing hazard hit
    mid-session (transient compile errors / a `git reset --hard` in another
    session's working tree, both resolved) — read it before resuming rather
    than re-deriving the approach.

---
