## Group N — Internationalization (i18n)
*Files: `src/lib/i18n.ts` (the translation store — flat `lang → key → text`
maps for en/de/es/fr/it), every component under `src/components/`. Full
resumable plan: [`docs/i18n_translation_plan.md`](../docs/i18n_translation_plan.md).*

92. **Full app-wide translation coverage. DONE.** The i18n system
    (`src/lib/i18n.ts`) was originally wired into only the Settings dialog's
    main panel — every sub-panel and every other component in the app
    hardcoded English text, which is what the user saw as "language settings
    only changing half of the descriptions". Every component under
    `src/components/` is now wired, plus the content-data files that hold
    real UI prose outside any component (`src/lib/hints.ts`'s contextual
    hints + first-run steps, `tour.ts`'s guided-tour steps, `lessons.ts`'s 23
    task lessons/~130 steps) — those needed a `titleKey`/`bodyKey`
    (`TranslationKey`) restructuring instead of a direct `useT()` call, same
    shape as the `tabs/`-style label-key pattern below. `src/lib/i18n.ts`
    holds **4130 keys** (verified 2026-07-28; was 3716 when written), full
    5-language parity verified, `tsc`/vitest green
    throughout (2201 tests). A few reusable lessons from the whole effort:
    (1) a file already using `t()` throughout can still be silently
    English-only in the other 4 languages if whoever wired it forgot those
    blocks (`header/`'s ~161-key gap) — diff key sets against `en`, don't
    just grep for hardcoded strings. (2) a plain array/record living outside
    any component (`tabs/`'s `newTabItems.ts`, `lessons.ts`'s
    `LESSON_CATEGORIES`) needs a `labelKey`/`titleKey` field + resolver-
    function pattern, not a direct `useT()` call. (3) a date-formatting
    helper that already takes a `locale`/`lang` param but whose call sites
    never pass it is a silent English-only bug hiding in plain sight
    (`calendar/`'s `formatLongDate()`) — grep for the helper's call sites,
    not just for hardcoded strings. Full history, batch-script methodology,
    and key-naming conventions: [`docs/i18n_translation_plan.md`](../docs/i18n_translation_plan.md).

---
