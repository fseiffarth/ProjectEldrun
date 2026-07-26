# Full app-wide i18n — Implementation Plan (Group N, TODO #92)

> **Status: IN PROGRESS.** Settings dialog + all sub-panels, all of
> `components/layout/`, all of `components/common/`, all 16 of 16
> `.tsx` files in `components/projects/`, all 8 of 8 files in
> `components/header/`, all 9 of 9 files in `components/tabs/`, all 8 of 8
> files in `components/calendar/`, all 15 of 15 `.tsx` files in
> `components/files/`, and now **all ~34 files in `components/embed/`
> proper** — the last remaining one, `FileViewerPane.tsx` (6655 lines, the
> largest single file in the app), is now done too — are fully translated
> across all 5 languages (en/de/es/fr/it). Only `embed/deck/` (15 files, a
> deliberately-skipped subdirectory — see below) remains in `embed/`.
> `src/lib/i18n.ts` holds **2841 keys**, all with parity across every
> language (verified by the key-count script below). `npx tsc --noEmit` and
> the full vitest suite (2102 tests) are green throughout — this doc exists
> so the remaining files can be picked up in a fresh session without
> re-deriving the approach.
>
> **Note on this `components/embed/` batch:** translated `DiffView.tsx`,
> `EmbedPane.tsx`, `SqliteView.tsx`, `NotebookView.tsx`, `MediaView.tsx`,
> `OdtView.tsx`, `SyncMergeView.tsx`, `ContextFilePicker.tsx`,
> `CompareView.tsx`, `ImageAnnotator.tsx`, `PresentationOverlay.tsx`,
> `GifView.tsx`, `TableView.tsx`, `YamlGrid.tsx`, `YamlTree.tsx`, and all of
> `embed/pdf/` (`PdfViewer.tsx` + the `outline.ts`/`pdfDoc.ts` pure helpers).
> ~300 keys added. Two things worth knowing for the next session:
> 1. **The initial grep-density check under-counts badly for this directory.**
>    Several files that scored 0 hits (`DiffView.tsx`, `EmbedPane.tsx`,
>    `SqliteView.tsx`) still had 2-4 real strings — the density regex only
>    matches `>Text<` on ONE line, and this codebase wraps JSX text onto its
>    own line very often (`<div>\n  Loading…\n</div>`). Treat a 0-hit score in
>    this directory as "read it anyway," not "skip it" — don't trust the grep
>    alone here the way earlier batches could.
> 2. **Pure lib helpers needed the "extra parameter" treatment again**, same
>    shape as `newTabItems.ts`/`recurrence.ts` from earlier batches:
>    `embed/pdf/outline.ts`'s `loadOutline`/`resolveItems`/`resolveItem` grew an
>    `untitledLabel` parameter (defaults to the English literal `"Untitled"` so
>    `PdfOutline.test.ts` keeps passing unchanged), and `pdfDoc.ts`'s
>    `buildPdf` grew optional `emptyMsg`/`sourceClosedMsg` parameters for the
>    same reason (`PdfSave.test.ts` regex-matches the default English text, so
>    the defaults had to stay byte-for-byte identical to the original
>    strings). `TableView.tsx`'s `delimiterLabel` and `YamlGrid.tsx`'s
>    `itemTitle`/`titleFor`/`crumbTitle` took the more common shape instead —
>    `t` threaded as an explicit first/typed parameter, no default, since
>    nothing outside the component calls them.
>
> **Two new `t`-shadow instances found** (same class of bug as every earlier
> batch — grep `\(t\)|\(t =>|const t ` before calling a file done):
> `TableView.tsx`'s `flashTimers.current.forEach((t) => clearTimeout(t))`
> (renamed to `timer`), `YamlTree.tsx`'s three-in-one — the Escape-key
> listener's `const t = e.target`, the paste-cursor row's
> `onClick={(e) => { const t = e.target; ... }}`, and `ImageAnnotator.tsx`'s
> `onPointerMove`'s `const t = toolRef.current` (all renamed: `target`,
> `clicked`, `tool`). None of these called the translator inside their scope
> (so nothing was silently broken), but all four would have been landmines
> for the next edit in that function.
>
> **Common keys minted this batch, reusable everywhere:** `common.undo` /
> `common.redo` (didn't exist before — `FileViewerPane.tsx`'s own
> `UndoRedoButtons` still hardcodes "Undo"/"Redo" in English; wire it to these
> two when that file's batch comes up) and `imageZoom.*` (zoom
> in/out/fit/actual-size/controls-label — shared by `GifView.tsx` and
> `PdfViewer.tsx`'s near-identical zoom toolbars; **`FileViewerPane.tsx`'s own
> `ImageView` has the same zoom toolbar a third time and should reuse this
> namespace instead of minting its own**).
>
> **`FileViewerPane.tsx` (6655 lines, the largest single file in the app) is
> now done too**, split across 5 sub-batches in one session rather than the
> "own fresh-context session(s)" the earlier note assumed it would need —
> the file turned out tractable read top-to-bottom in ~500-800 line chunks.
> ~140 keys added. Notes for the next file this size:
> 1. **`ImageView`'s zoom toolbar did reuse `imageZoom.*`** as the prior
>    batch's note predicted — confirms that namespace is now shared by three
>    viewers (`GifView.tsx`, `PdfViewer.tsx`, `FileViewerPane.tsx`'s
>    `ImageView`) with zero new zoom keys minted.
> 2. **`UndoRedoButtons` was wired to `common.undo`/`common.redo`** as the
>    embed/ batch flagged it should be — the two keys that batch minted sat
>    unused until this one.
> 3. **Two more module-level `Record<K, string>` label tables needed the
>    "resolve via `t()` at the call site" treatment**, same shape as
>    `newTabItems.ts`/`recurrence.ts` from earlier batches:
>    `AC_MODE_LABELS` (completion-length mode names — replaced by a small
>    `acModeLabel(mode, t)` helper reusing the **already-existing**
>    `projectSettings.sentence`/`.block`/`.scope` keys from the Settings
>    dialog, so autocomplete's status line and its dropdown now share exactly
>    the same three translated words instead of a fourth hardcoded copy) and
>    `SBATCH_FIELD_LABELS` (the `#SBATCH` directive-form field names —
>    replaced by `SBATCH_FIELD_LABEL_KEYS: Record<string, TranslationKey>`
>    reusing the **already-existing** `hpcWizard.sbatch*` keys from
>    `HpcPipelineWizard.tsx`'s identical directive form, one exact duplicate
>    field set; only `account` needed a genuinely new key,
>    `hpcWizard.sbatchAccount`, since the wizard's own table happened to omit
>    it). **Lesson:** before minting a label table for a form/field-name
>    record, grep the rest of the codebase for another component editing the
>    same underlying concept (SLURM directives, autocomplete modes, viewer
>    zoom) — a near-identical table minted independently elsewhere is common
>    in this app and cross-file reuse cuts the key count substantially.
> 4. **A module-level string built from a platform check needed the same
>    "move inside the component" treatment as `OPEN_LINK_HINT`** two batches
>    ago: `TEX_INSTALL_LABEL = IS_WINDOWS ? "Install MiKTeX" : "Install
>    LaTeX"` was a top-level const (can't call `useT()`) — moved inline as
>    `texInstallLabel` computed at the top of `TexView` once `t` was in
>    scope. Grep a file for `IS_WINDOWS ? "..." : "..."` / `IS_MAC ? "..." :
>    "..."` module-level ternaries before calling a batch done — they read as
>    plain constants and are easy to miss next to the (correctly untranslated)
>    `TEX_INSTALL_CMD` shell command right beside it.
> 5. **No new `t`-shadow instances this time** — the file's few `(t) => ...`
>    arrow params (`(t) => t.key === tabKey`-style tab-loop variables, a
>    `setCaretTick((t) => t + 1)`, two delete-ghost timer-id params) all sat
>    in module-level functions or in scopes where `useT()`'s `t` was never
>    introduced nearby, except two inside `CodeEditor` (`setCaretTick`'s
>    updater and the delete-ghost timer helpers) which were renamed (`n`,
>    `timer`) proactively since `CodeEditor` is the file's largest component
>    and any subsequent edit in it would have hit the shadow blind.
>
> **`embed/deck/` was deliberately skipped this batch — do NOT casually pick
> it up.** `git status` at the start of this session showed it already
> mid-refactor: ~2200 uncommitted lines across `DeckView.tsx` (+732),
> `DeckPresenter.tsx` (+287), `DeckInspector.tsx` (+317), `DeckStage.tsx`
> (+163), `DeckAudienceApp.tsx` (+147), plus brand-new untracked files
> (`DeckThemePanel.tsx`, `FontField.tsx`, `deckFonts.ts`) — a theme-panel/
> font-picker feature landing from a concurrent or prior session, unrelated to
> i18n. `npx tsc --noEmit` was clean throughout this session despite that, so
> the deck feature work is at least internally consistent; it just was not
> safe to start layering translation edits on top of a file mid-rewrite by
> someone else. **Before translating `embed/deck/`:** re-run `git status`/
> `git diff HEAD --stat -- src/components/embed/deck/` first — if those files
> are still churning, translate something else instead and come back later.
>
> **Note on `components/calendar/`:** genuinely not started (0 of 8 files used
> `useT()`). The bigger finding here: **month/weekday names should never be a
> hand-translated table** — `MONTHS`/`WEEKDAY_LABELS`/`WEEKDAY_INITIALS`
> arrays were hardcoded English in 3 different files (`CalendarPane.tsx`,
> `CalendarSidebar.tsx`, `MonthView.tsx`, `EventDialog.tsx`), and
> `formatLongDate()` (`lib/calendarTime.ts`) already took a `locale` param
> that **every call site ignored**, plus `CalendarPane.tsx`'s `AllDayBar` hard-
> coded `toLocaleDateString("en", …)` outright — so month/weekday names were
> silently always-English regardless of app language, a second instance of
> the header/-class bug even though `useT()` had never touched these files.
> Fixed by adding `monthName(locale, month)` / `weekdayLabel(locale, day,
> form)` helpers to `calendarTime.ts` built on `Intl`/`toLocaleDateString` —
> **no translation table at all**, since the browser already gets this right
> per-locale — and threading `useI18nStore((s) => s.lang)` through every call
> site (mirrors the existing precedent in `ActivityCalendar.tsx`). Three pure
> lib helpers needed the same `t`-as-parameter treatment as `newTabItems.ts`
> above: `lib/recurrence.ts`'s `describeRrule` (now `(rule, t, lang)` — the
> weekday list in "Weekly on Monday, Friday" also goes through
> `weekdayLabel`), `lib/alarms.ts`'s `describeLead` (now `(minutesBefore, t)`),
> and `lib/calendarCategories.ts`'s `CATEGORIES` array (gained a `labelKey`
> field + `categoryLabel(category, t)` resolver, same shape as
> `newTabItems.ts`'s `itemLabel`). Updated the call sites in
> `stores/alarms.ts` (an OS-notification builder, not a component — reads
> `useI18nStore.getState().lang` imperatively and builds a local `t` via
> `translate()`) and three test files (`Recurrence.test.ts`, `Alarms.test.ts`,
> mirroring the `CustomAgents.test.ts` pattern). Also found and fixed a second
> `for (const t of …)` shadow of the new `useT()` translator in
> `CalendarPane.tsx`'s `importIcs` (renamed loop var to `tk`), same class of
> bug as `TabBar.tsx`'s `(t) => t.key` shadows.
>
> **Note on `components/tabs/`:** genuinely not started when picked up (0 of 9
> files used `useT()`), unlike the header/ false-negative below. Two of the 9
> files (`Subwindow.tsx`, `TabPane.tsx`) needed no keys — pure layout/render-
> switch components with no user-facing text of their own. `newTabItems.ts`
> (not itself a component) holds `SHELL_ITEMS`, a **module-level static array**
> evaluated once at import time — it can't call `useT()` — so its two generic
> labels ("Shell"/"Files"; the `AGENT_ITEMS` labels are brand names and stay
> literal) got a `labelKey?: TranslationKey` field plus an `itemLabel(item, t)`
> resolver, called from the consuming components (`TabBar.tsx`,
> `NewTabMenu.tsx`) which have `t` in scope — the same "pure helper takes `t`
> as an explicit parameter" shape established for `CredentialPasteBar.tsx`'s
> `sshPasteEntries`/`vpnPasteEntries`. `buildStaticTabSpec` and
> `agentMenuEntries` both grew a required `t` parameter for the same reason;
> every call site (including `src/lib/codexHooks.ts`'s non-component caller,
> which passes a throwaway `(key) => key` since its one call site's item never
> has a `labelKey`) and `src/__tests__/CustomAgents.test.ts` (now imports
> `translate` and builds a fixed `en` `t` locally, mirroring
> `CredentialPaste.test.tsx`) were updated. Adding `const t = useT()` to
> `TabBar.tsx` also surfaced several **pre-existing `(t) => t.key === …`
> arrow-param shadows** (`t` used as the loop var for "tab" long before this
> batch) — renamed to `tb` at each call site so they don't shadow the new
> translator.
>
> **Note on `components/header/`:** when this batch was picked up, every file
> in the directory (`MachinesIndicator.tsx`, `VpnIndicator.tsx`,
> `AppResourceDisplay.tsx`, `AppTimerDisplay.tsx`, `ConnTypeIcon.tsx`,
> `RemoteConnMenu.tsx`, `WindowControls.tsx`, `Clock.tsx`) was **already**
> wired with `useT()`/`t()` — apparently done by the concurrent session
> mentioned below, ahead of this doc's tracking. The actual gap found and
> fixed was **not missing component wiring but missing translations**: the
> concurrent session had added ~145 `machines.*` keys plus 16 others
> (`carefulHost.hintHpcTagged`, `hpcHost.*`, `savePassword.*`,
> `autoConnect.offWhileHpc`/`hpcTitle`, `remoteLogin.pollGaveUp`,
> `remoteMachines.dropConnectFailed`) to the **English block only** — `de` was
> additionally missing 11 of those, `es`/`fr`/`it` all 16. Since
> `translate()`'s fallback silently serves English when a language is
> missing a key, this was invisible in the UI and exactly the class of bug
> that motivated this whole plan (the user's original report was "language
> settings only changing half the descriptions"). All 161 gaps were
> translated and inserted; 1525/1525 parity confirmed across all 5 languages.
> **Lesson for future batches:** a 0-hit grep score on a file does not mean
> "nothing to translate" — it can mean "already fully wired." Before
> concluding a batch, also diff the target language blocks against `en` for
> missing keys (see the parity-check pattern in "Verify" below) even for
> files that look done; a component using `t()` throughout can still be
> silently English-only in 4 of 5 languages if whoever wired it forgot the
> other language blocks.
>
> **Note on `components/files/`:** genuinely not started (0 of 15 files used
> `useT()`). Two new hazards turned up here, both worth checking for in any
> future batch: (1) a batch-insert Python script that writes a raw `"\n"`
> (Python's actual-newline escape, not the two-character `\\n`) into a
> multi-line confirm/alert string breaks the generated `i18n.ts` — TypeScript
> sees an unterminated string literal and the **whole file** fails to parse,
> which surfaced as a wall of unrelated-looking `tsc` errors; always end a
> batch-insert script with `.replace("\n", "\\n")` on every value, and if
> `tsc` erupts into hundreds of parse errors after an insert, suspect this
> before anything else. (2) an `Edit` call on `DownloadsSection.tsx`
> introduced a **literal NUL byte** into the file (`paths.join(" ")` became
> `paths.join("\x00")` — cause unconfirmed, possibly a tool/encoding hazard
> rather than anything in the edit's own arguments); `git diff --stat` showed
> the file as `Bin … -> Bin …` (binary) instead of a normal text diff, and
> `grep` silently returned nothing (no error) instead of matching — that
> silent-empty-grep-on-a-text-file combo is the tell. Fixed by reading the
> file as bytes in Python and replacing `b"\x00"` with a space. **Lesson:**
> after editing a file in a batch this large, spot-check `git diff --stat`
> for a `Bin` marker or pipe the file through `grep -qP '\x00'` — a `grep`
> that matches nothing is not proof of a clean file if the file might be
> binary-flagged. Also reconfirmed two known patterns from the notes above:
> markup-preserving splits (`{t("x.pre")} <strong>{val}</strong> {t("x.post")}`)
> sometimes need a *three*-way split when two separate spans of emphasis sit
> in one sentence (`ProjectFilesView.tsx`'s auto-sync-anyway confirm, and
> `FileTree.tsx`'s two delete/paste confirms) — don't flatten the whole
> sentence into one key just because the first draft did; and the `t`-shadow
> class of bug reappeared twice more (`ProjectFilesPane.tsx`'s
> `VIEWER_PREF_TYPES.map((t) => …)` renamed to `vt`, `ProjectFilesView.tsx`'s
> `for (const t of scopeTabs)` renamed to `tab`, and its `typeTags.map((t) =>
> …)` renamed to `tag`) — grep a file for `(t)` / `(t =>` / `const t ` other
> than your own `const t = useT()` before calling a batch done.

## Background

The user reported: *"language settings are only changing half of the
descriptions from one language to another"*. Investigation found the cause:
Eldrun already has a complete, dependency-free i18n system
(`src/lib/i18n.ts` — flat `lang → key → text` maps, English as source of
truth with graceful fallback, a zustand store for live switching, no reload
needed) but it was wired into only the top-level Settings dialog. Every other
surface in the app — including the Settings dialog's own sub-panels — had
hardcoded English strings. The user asked for **complete** app-wide coverage,
including button text, confirmed after seeing the scale ("keep going through
all batches").

## What's done

| Batch | Files | Keys added (approx) |
|---|---|---|
| Settings dialog + sub-panels | `SettingsPanel.tsx`, `SettingsSubPanels.tsx` | ~350 |
| `components/layout/` (all 19 `.tsx`) | AppShell, HeaderBar, GlobalAppBar, GlobalAppMenu, ProjectSwitcher, RightPanel, VpnPasswordPrompt, DetachedApp, DetachedCenterPanel, CenterPanel, LocalModelMenu, HowToStart, RemoteFeaturesPrompt, LessonsMenu (LogoIcon/HintHost/TourHost needed no keys — SVG-only / no own text) | ~180 |
| `components/common/` (all 17 `.tsx`) | TourCoachmark, HintBubble, UntestedTag, VpnTunnelUpNotice, ConnectionLog, FolderPickerDialog, ProjectBlobPane, PageStrip, RemoteUsageWarningDialog, HostKeyConfirmDialog, LocalLossDialog (Dropdown/OrbitSpinner/Toggle/PasswordInput/ConnLamp/TourCoachmark's siblings needed none) | ~112 |
| `components/projects/` — **16 of 16 done** | ProjectSearch, CategoryEditor, BoxPill, ActivityCalendar, RemotePaneHold, ExtendToRemoteDialog, PythonInterpreterWindow, RemoteFolderBrowser, BigFolderExcludeDialog, **ProjectPill.tsx** (the app's single largest component, ~2000 lines, ~10 sub-dialogs + the full right-click context menu), **RemoteConnectDialog.tsx**, **RemoteMachinesWindow.tsx**, **HpcPipelineWizard.tsx**, **ProjectDialog.tsx**, **RemoteProjectSection.tsx**, **CredentialPasteBar.tsx**, **TerminalSignInToggle.tsx**, **ProjectHoverCard.tsx**, **CarefulHostToggle.tsx** (new file, landed mid-plan by a concurrent session) | ~210 + ~430 |
| `components/header/` (all 8 `.tsx`) | Already wired by a concurrent session; this batch filled in ~161 missing translations (161 keys had `en` only or partial coverage) | ~161 |
| `components/tabs/` (all 9 `.tsx`) | TabBar (largest — full right-click menu + drag), Subwindow/TabPane (no keys needed), agentModes/dragGeometry helpers, `newTabItems.ts` `labelKey` pattern | ~150 |
| `components/calendar/` (all 8 `.tsx`) | CalendarPane, TimeGrid, MonthView, AgendaView/TasksView, EventDialog, CalendarSidebar, AlarmPopup + `calendarTime.ts`/`recurrence.ts`/`alarms.ts`/`calendarCategories.ts` helpers; month/weekday names moved to `Intl`-backed helpers instead of a translation table | ~180 |
| `components/files/` — **15 of 15 done** | SubwindowFilesSidebar, ProjectFilesTab, QuickOpen, SearchPanel, GitChangeTree, importDrop, SetDefaultAppDialog, DownloadsSection, ProjectFilesSettings, FileTreeSearch, ProjectFilesPane, FileBrowser, **GitHistory.tsx** (git lockstep bar, worktrees, commit window), **ProjectFilesView.tsx** (1970 lines — view switcher, git action bar, orange/sessions/jobs views, HPC workspace banner), **FileTree.tsx** (3684 lines, largest single file in the app — context menu, 4 modal dialogs, sync overlay, drag/drop, run/compile buttons) | ~410 |
| `components/embed/` — **17 of ~34 done** (everything except `FileViewerPane.tsx` and `embed/deck/`) | DiffView, EmbedPane, SqliteView, NotebookView, MediaView, OdtView, SyncMergeView, ContextFilePicker, CompareView, ImageAnnotator, PresentationOverlay, GifView, TableView, YamlGrid, YamlTree, **embed/pdf/PdfViewer.tsx** (2081 lines — zoom/find/print toolbar, contents sidebar, page rail) + `outline.ts`/`pdfDoc.ts` pure helpers | ~300 |
| `components/embed/FileViewerPane.tsx` — **the last file in `embed/` proper** | 6655 lines, the app's largest single file — shared viewer plumbing (`ViewerHeader`, edit-history/editable-file hooks, `SaveButton`/`PrintButton`/`UndoRedoButtons`, find/replace bar), `CodeEditor` (syntax highlight, autocomplete, grammar check, git-blame gutter, breakpoints, Run/Debug, SLURM bar), `TextView`, `MarkdownView`, `TexView` (compile toolbar, SyncTeX), `ImageView` (zoom, reused `imageZoom.*`) | ~140 |

Total so far: **2841 keys**, all 5 languages at parity (script below confirms
this after every batch).

### Notes from finishing `components/projects/`
- `sshPasteEntries`/`vpnPasteEntries` (`CredentialPasteBar.tsx`) and
  `statusLabel`/`formatTime`/`formatCpu` (`ProjectHoverCard.tsx`) are pure
  functions outside any component, so they can't call `useT()` — they now take
  a `t` translator as their **first parameter**, threaded in from the calling
  component. `vpnStatusHint` in `RemoteProjectSection.tsx` follows the same
  pattern. Reuse this shape (`t` as first arg) for any other pure
  string-building helper the remaining files turn up.
- `src/__tests__/CredentialPaste.test.tsx` needed updating for the new
  `sshPasteEntries(t, opts)`/`vpnPasteEntries(t, opts)` signature — it now
  imports `translate` from `lib/i18n` and builds a fixed `en` `t` locally
  (`translate("en", key, params)`), since a plain unit test has no React
  context for `useT()`.
- `PROVIDER_CLI_INSTALL` moved out of `ProjectDialog.tsx` into
  `lib/installCommand.ts` by a concurrent session mid-edit — another instance
  of the known concurrent-editing hazard below; `tsc` stayed clean throughout,
  confirming compatibility.
- The i18n key-count script's totals in this doc (and the ones you'll compute
  next) are a moving target under concurrent editing — always re-run it
  yourself rather than trusting a stale number here.

## What's left

### Remaining directories (not yet started)
- **`components/embed/deck/`** (15 files: `DeckView.tsx`, `DeckPresenter.tsx`,
  `DeckInspector.tsx`, `DeckStage.tsx`, `DeckAudienceApp.tsx`,
  `DeckSlideView.tsx`, `DeckObjectView.tsx`, `DeckThemePanel.tsx`,
  `FontField.tsx`, `DeckAnimate.tsx`, `DeckNotes.tsx`, `DeckTexPanel.tsx`,
  `IconPicker.tsx`, plus the non-component `deckAssets.ts`/`deckBase.ts`/
  `deckFonts.ts`/`gifPlayback.ts` helpers) — **re-check `git status` /
  `git diff HEAD --stat -- src/components/embed/deck/` before starting.** At
  the start of this session it was ~2200 lines into an uncommitted
  theme-panel/font-picker feature landing from elsewhere; translating on top
  of a file mid-rewrite risks fighting that session's edits. If it's settled
  by the time you read this, it's just another `embed/` batch — same
  methodology.
- `components/monitoring/` + `components/stats/` (6 files)
- `App.tsx` + final whole-repo verification pass (this was Task #11 in the
  original session's todo list — a last grep sweep for anything missed, plus
  updating `src/lib/i18n.ts`'s own doc comment to say coverage is complete
  rather than "wired through Settings only").

### Content data files (separate, not yet scoped)
`src/lib/hints.ts` (contextual hint copy), `src/lib/tour.ts` (guided-tour step
copy), `src/lib/lessons.ts` (lesson picker copy) hold real UI prose but are
data files, not components — `HintHost`/`TourHost`/`LessonsMenu` render their
`title`/`body` fields directly as plain strings. These need their own
`TranslationKey`-based restructuring (mirroring what was done for
`HELP_SECTIONS` in `SettingsPanel.tsx` — see that file's `HelpItem`/
`HelpSection` interfaces for the pattern: store `titleKey`/`descKey` instead
of raw strings, resolve via `t()` at render time). Not started.

## Methodology (proven across ~860 keys — reuse this exactly)

### 1. Scope a file before reading it
For files under a few hundred lines, just `Read` the whole thing. For larger
files, grep first to gauge density and avoid reading dead weight:
```bash
grep -cE 'title="[A-Za-z]|aria-label="[A-Za-z]|placeholder="[A-Za-z]|>[A-Z][a-zA-Z ,.…'"'"']{3,60}<' path/to/File.tsx
```
This regex misses multi-line JSX text (a paragraph split across lines) and
template-literal titles (`` title={`...`} ``) — for anything that scores 0
hits but "feels" like it should have text, read it directly rather than
trusting the grep.

### 2. Add keys in one batch script per file (or small group of files)
Keys are added via a Python heredoc that inserts new lines just before each
language block's closing brace. This was run from the repo root every time:
```bash
cd "$(git rev-parse --show-toplevel)" && python3 - <<'PYEOF'
path = "src/lib/i18n.ts"
with open(path) as f:
    content = f.read()

K = {}
def add(key, en, de, es, fr, it):
    K[key] = (en, de, es, fr, it)

add("someNamespace.someKey", "English text", "Deutscher Text", "Texto en español", "Texte en français", "Testo in italiano")
# ... more add() calls ...

langs = ["en", "de", "es", "fr", "it"]
def block_bounds(name):
    import re
    re_start = re.compile(r"const " + name + r"(?::\s*Dict)?\s*=\s*\{")
    m = re_start.search(content)
    start = m.end()
    rest = content[start:]
    end_marker = rest.find("\n} as const;")
    end2 = rest.find("\n};")
    end = end_marker if (end_marker != -1 and (end2 == -1 or end_marker < end2)) else end2
    return start, start + end

inserts = []
for name in langs:
    s, e = block_bounds(name)
    inserts.append((e, name))
inserts.sort(key=lambda x: -x[0])  # insert from the end backwards so earlier offsets stay valid
lang_index = {"en":0, "de":1, "es":2, "fr":3, "it":4}
for pos, name in inserts:
    i = lang_index[name]
    lines = []
    for key, vals in K.items():
        val = vals[i].replace('"', '\\"')
        lines.append(f'  "{key}": "{val}",')
    insertion = "\n" + "\n".join(lines)
    content = content[:pos] + insertion + content[pos:]

with open(path, "w") as f:
    f.write(content)
print("done", len(K), "keys")
PYEOF
```
Only the **`en` block** is the source-of-truth key set (`TranslationKey =
keyof typeof en`), but all 5 blocks must get every key or `translate()`'s
fallback-to-English silently masks a missing translation forever — always
add to all 5 in the same script.

### 2b. Verify key parity + no duplicates after every batch
```bash
node -e '
const fs = require("fs");
const src = fs.readFileSync("src/lib/i18n.ts", "utf8");
function block(name){
  const re = new RegExp("const "+name+"(?::\\s*Dict)?\\s*=\\s*\\{");
  const m = re.exec(src);
  const start = m.index + m[0].length;
  const rest = src.slice(start);
  const endMarker = rest.indexOf("\n} as const;");
  const end2 = rest.indexOf("\n};");
  const end = endMarker !== -1 && (end2 === -1 || endMarker < end2) ? endMarker : end2;
  return rest.slice(0, end);
}
for (const name of ["en","de","es","fr","it"]) {
  const chunk = block(name);
  const keys = [...chunk.matchAll(/"([a-zA-Z0-9_.]+)":/g)].map(m=>m[1]);
  const seen = new Set(); const dupes=[];
  for (const k of keys) { if (seen.has(k)) dupes.push(k); seen.add(k); }
  console.log(name, keys.length, "dupes:", dupes);
}
'
```
All 5 counts must match and `dupes` must be empty every time.

### 3. Wire the component
- Import `useT` (and `type TranslationKey` if the file needs a lookup table
  keyed by some union type — see `GIT_ICON_TITLE_KEY` / `MODEL_ROLES` for the
  pattern of converting a `Record<X, string>` into a `Record<X, TranslationKey>`
  and resolving with `t()` at render time).
- Add `const t = useT();` as the **first line** of every component function
  that needs it (including small nested dialog/window components defined in
  the same file — each one needs its own call, hooks don't propagate down
  through props).
- For prose with inline `<code>`/`<strong>`/`<em>` markup, split the
  translation into multiple keys around the markup boundary rather than
  flattening it to one key — this preserves the visual emphasis in every
  language. Example pattern used throughout:
  ```tsx
  {t("foo.helpPre")} <code>literalToken</code> {t("foo.helpPost")}
  ```
  Technical literals inside `<code>` (command names, package names, paths)
  are **not** translated — only the surrounding prose.
- For simple pluralization (no ICU in this system — it's flat string keys),
  add two keys per case (`fooCountOne` / `fooCountMany`) and branch on
  `count === 1` in the component; pass `{ count }` as the `t()` params object.
- Reuse existing keys aggressively before adding new ones — `common.cancel`,
  `common.back`, `common.add`, `common.remove`, `common.delete`,
  `common.rename`, `common.connect`, `common.close`, `common.next`,
  `common.saving`/`common.save`, `common.loading`, `common.recheck` all exist
  and are shared across dozens of call sites. Check `i18n.ts`'s `common.*`
  block before minting a file-specific synonym.
- Never translate: product/brand names (`Eldrun`), proper nouns (GitHub,
  GitLab, Ollama, Docker), file extensions/paths, shell commands, CSS/HTML
  attribute values, technical unit abbreviations (CPU, GPU, MB) — these stay
  as literal English/technical strings in every language, matching how the
  existing Settings-panel translations already treat them.

### 4. Verify after every file (or small batch of files)
```bash
npx tsc --noEmit -p .
```
Expect **zero new errors** in files you touched. Pre-existing errors from
concurrent editing elsewhere in the repo (see "Known hazard" below) are not
yours to fix — note them and move on.
```bash
npx vitest run 2>&1 | grep -E "^(PASS|FAIL) \("
```
Compare the failure count to the baseline before you started this session's
batch — new failures are yours to investigate; the same pre-existing count
is fine to proceed past.

Final sweep per file, to catch anything the initial grep missed:
```bash
grep -nE 'title="[A-Za-z]|aria-label="[A-Za-z]|placeholder="[A-Za-z]|>[A-Z][a-zA-Z ,.…'"'"']{3,60}<' path/to/File.tsx | grep -v "aria-hidden"
```
Should be empty before moving to the next file.

## Known hazard: concurrent editing in this repo

While this plan was being executed, another session was actively working in
the **same working tree** on an unrelated feature (a `carefulHost`/
credential-paste/host-key-confirm/HPC-workspace/deck-presenter cluster of
work — see the untracked files under `src-tauri/src/commands/`,
`src/components/embed/deck/`, `src/lib/hostKey.ts`, `src/lib/keyring.ts`,
`src/stores/pillDrag.ts`, `src/components/projects/CredentialPasteBar.tsx`,
`src/components/projects/TerminalSignInToggle.tsx`). This caused two kinds of
noise while translating:

1. **Transient compile errors** in files that concurrent session was
   mid-editing (`ProjectPill.tsx`'s drag logic, `RemoteConnectDialog.tsx`,
   `RemoteProjectSection.tsx`, `MachinesIndicator.tsx`, `ProjectDialog.tsx`,
   `BoxPill.tsx` all showed errors like `Cannot find name 'PILL_DRAG_TYPE'` at
   various points that were **not** caused by this i18n work and resolved on
   their own once the concurrent session finished that file). Before
   concluding an error is yours to fix, check whether the error references
   symbols/imports you never touched.
2. **A `git reset --hard` ran twice** during the session (visible in
   `git reflog`) — apparently the other session's own working-tree cleanup.
   Both times, re-verification via `git diff HEAD --stat` (not the
   index-relative `git diff --stat`, which can show a stale/misleading empty
   result — this caused one false alarm mid-session) confirmed this i18n
   work's edits survived intact both times. **If a future session sees what
   looks like lost work, re-check with `git diff HEAD --stat -- <path>` before
   concluding anything is actually gone** — don't trust a single anomalous
   read in a repo with concurrent editors.

Before resuming this plan: run `npx tsc --noEmit -p .` first. If it's clean,
the concurrent work has settled and it's safe to proceed through the
remaining files including `RemoteConnectDialog.tsx`/`MachinesIndicator.tsx`.
If not, `git status`/`git log` to see what's mid-flight and route around it
(work on a different directory first, as this session did).

## Batch order suggestion for the next session

1. **`components/embed/deck/`** — the only file set left in `embed/` at all.
   Re-check it isn't still mid-refactor first (see the note above — as of
   the `FileViewerPane.tsx` batch it was still ~2158 uncommitted lines in,
   unchanged from the batch before); if settled, it's an ordinary ~15-file
   batch.
2. `components/monitoring/` + `components/stats/`.
3. `App.tsx`, then the content-data-file restructuring (hints/tour/lessons),
   then a final whole-repo grep sweep + update `i18n.ts`'s own top-of-file
   doc comment (it still says "Currently wired through the Settings dialog's
   main panel" — that sentence should be removed/updated once this plan is
   fully closed out).
</content>
