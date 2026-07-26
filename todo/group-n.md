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
    `components/common/`, all 16 of 16 files in `components/projects/`
    (including `ProjectPill.tsx`, the app's largest component), all 8 of 8
    files in `components/header/`, all 9 of 9 files in `components/tabs/`,
    and all 8 of 8 files in `components/calendar/` are done (1791 keys,
    5-language parity verified, `tsc`/vitest green throughout — 2017 tests).
    Three bugs worth knowing about surfaced along the way: (1) the `header/`
    batch found every file already wired with `useT()` by a concurrent
    session, but ~161 keys (`machines.*` plus a handful of others) existed
    only in the English block — `translate()`'s fallback masked this
    silently, exactly the class of bug TODO #92 exists to fix; fixed by
    backfilling all 4 other languages. (2) the `tabs/` batch's
    `newTabItems.ts` holds a module-level static array (`SHELL_ITEMS`) that
    can't call `useT()` directly — needed a `labelKey` field + resolver-
    function pattern instead (see the plan doc). (3) the `calendar/` batch
    found month/weekday names hand-rolled as hardcoded-English arrays in 4
    files, **and** `calendarTime.ts`'s `formatLongDate()` already accepted a
    `locale` param that every call site was ignoring — replaced the arrays
    entirely with `Intl`-based `monthName`/`weekdayLabel` helpers (no
    translation table needed, the browser already gets this right
    per-locale) and threaded the current language through every call site.
    Remaining: `files/`, `embed/`+`embed/deck/`+`embed/pdf/`,
    `monitoring/`+`stats/`, `App.tsx`, plus restructuring the hint/tour/lesson
    content data files (`src/lib/hints.ts`, `tour.ts`, `lessons.ts`) which
    hold real UI prose as plain strings today. The plan doc has the exact
    batch-script methodology, key-naming conventions, and a note on a
    concurrent-editing hazard hit mid-session (transient compile errors / a
    `git reset --hard` in another session's working tree, both resolved) —
    read it before resuming rather than re-deriving the approach. **Also
    check for the header/-style gap in any remaining directory**: a file
    already using `t()` throughout can still be silently English-only in the
    other 4 languages if whoever wired it forgot those blocks — diff key sets
    against `en`, don't just grep for hardcoded strings. Watch for the
    tabs/-style gap too: a plain array/record living outside any component
    needs the `labelKey` + resolver pattern, not a direct `useT()` call. And
    watch for the calendar/-style gap: a date-formatting helper that already
    takes a `locale`/`lang` param but whose call sites never pass it is a
    silent English-only bug hiding in plain sight — grep for the helper's
    call sites, not just for hardcoded strings.

---
