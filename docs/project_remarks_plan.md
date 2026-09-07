# Project-wide File Remarks (REMARKS.md) — Implementation Plan

## Context

Attach remarks to individual project files, collected in a navigable top-level
`REMARKS.md`. Design decisions:

- **REMARKS.md is the canonical store** — one convention-structured, git-committed
  markdown file at the project root; no JSON shadow store. Follows the PDF-notes
  doctrine ("a comment only Eldrun can see may as well not have been written"),
  and `project.json` is gitignored so remarks there wouldn't travel with the
  repo.
- **Anchoring: file + optional line** (`./src/foo.ts:123`). Lines are hints, not
  tracked positions.
- **Four UI surfaces**: file-tree "Add remark…" + badge, remarks pane with
  next/prev walk, remark → todo-board card, editor "add remark at line".
- **Todo link is one-way**: one-shot conversion with a `TaskFileLink`
  back-reference chip; no state sync between card completion and remark checkbox
  (matches the existing mail/event link convention).
- **REMARKS.md is a scaffold file**: added to `SCAFFOLD_FILES`, so every
  new/imported project gets it at creation (with the format note baked in), and
  every existing project receives it automatically through
  `repair_project_scaffold_at` — no per-project setup. Linked from
  `PROJECT_SCAFFOLD` and `AGENTS_SCAFFOLD`.

Naming: "remark" already means PDF sticky note (`pdfNotes.ts`, `PdfNotesPane`).
User-facing strings say "file remark"/"project remarks", i18n namespace
`projectRemarks.*`. Feature gated behind new experimental flag `project_remarks`
(entry-point only); new controls carry `<UntestedTag />`.

## REMARKS.md format spec

```markdown
# Remarks

Per-file remarks. One bullet per remark:
`- [ ] [<path>:<line>](./<path>:<line>) — text`. Line optional, a hint only.
Tick a box to resolve a remark. Everything else in this file is yours.

## src/foo.ts

- [ ] [src/foo.ts:123](./src/foo.ts:123) — Why is this cast safe?
  Indented continuation lines belong to the remark above.
- [x] [src/foo.ts](./src/foo.ts) — Rename this module.
```

Rules (defensive parse, park-don't-drop — model: `normalizeDeck` in
`src/lib/viewers/deck/sidecar.ts`):

1. A remark = top-level `- [ ] `/`- [x] ` list item whose first inline element is
   a local link (per `isLocalHref`), href optionally ending `:<line>[:<col>]`.
   Text = rest after a stripped ` — `/` - ` separator + indented continuations.
2. **The bullet's href is canonical**, not the `## <path>` heading — headings are
   a serializer grouping convention; the parser accepts bullets anywhere. Paths
   normalized project-relative; a path escaping the root parses but is flagged
   `invalidPath` and never drives navigation.
   **The serializer always emits `./`-prefixed hrefs** — `isLocalHref`
   (`src/lib/viewers/markdown.ts:55`) is true for `./foo.ts:123` but a bare
   `foo.ts:123` false-positives as a URL scheme.
3. Checkbox = done state → the existing markdown preview's `toggleTaskCheckbox`
   click-to-toggle works for free.
4. Everything outside conforming bullets is preserved **verbatim**; edits splice
   only the target remark's line span; parse→no-op is byte-identical.
5. Stale remarks (missing target file) are a UI state, never auto-deleted.
6. No ids in the file. Runtime identity = source span; every mutation re-reads,
   re-parses, relocates by `(file, line, first-text-line, ordinal)` before
   splicing — a concurrent hand edit degrades to "not found, reload".

## Phase 1 — pure module `src/lib/projectRemarks.ts` (new)

Style model: `src/lib/viewers/mdGraph.ts` / `src/lib/todoBoard.ts` (pure, no I/O).

```ts
export const REMARKS_FILE = "REMARKS.md";
export interface ProjectRemark {
  file: string; line: number | null; text: string; done: boolean;
  srcStart: number; srcEnd: number;   // [start,end) line span
  invalidPath: boolean;
}
export function parseRemarks(src: string): ProjectRemark[];
export function remarkCountsByFile(remarks: ProjectRemark[]): Record<string, number>; // open only
export function formatRemarkBullet(file, line, text): string;
export function addRemark(src, file, line, text): string;           // appends under ## heading, creates if needed
export function editRemarkText(src, remark, text): string | null;   // null = not found
export function removeRemark(src, remark): string | null;
export function setRemarkDone(src, remark, done): string | null;
export const REMARKS_TEMPLATE: string;  // mirror of Rust REMARKS_SCAFFOLD
export function resolveRemarkAbsPath(projectDir, rel): string | null; // re-validate before any jump
```

Remark text goes through `stripFormatControls` (`src/lib/textSafety.ts`);
multi-line input → 2-space-indented continuations.

Tests `src/__tests__/ProjectRemarks.test.ts`: spec-doc parse; byte-stable no-op;
add under existing/new heading; splices leave other bytes untouched; hand-written
variants (`* ` bullets parked, `:12:5`, `%20` hrefs); path traversal →
`invalidPath`; CRLF tolerance.

## Phase 2 — `path:line` markdown navigation (flag-free, general win)

- `src/lib/viewers/markdown.ts`: add shared `splitLineHint(href): {href, line}`
  (digit-only suffix; `C:\…` drive letters don't match). Unit test that
  `isLocalHref("./src/foo.ts:123")` is true.
- `src/components/embed/FileViewerPane.tsx` `onPreviewClick`: run
  `splitLineHint` before `resolveLocalHref`; after `openLinkedFile(...)`, when
  `line != null` → `useEditorJumpStore.getState().requestJump(target, line)`.
  Working composition precedent: `SearchPanel.openResult`
  (`src/components/files/SearchPanel.tsx`). Grep for other `resolveLocalHref`
  call sites and apply the same strip.
- `src/lib/viewers/mdGraph.ts` `extractLocalLinkTargets`: strip the line hint so
  `./foo.ts:123` dedupes with `./foo.ts` and isn't marked `missing`. Extend
  `src/__tests__/MdGraph.test.ts`.

## Phase 3 — store, badge, context menu, dialog

**`src/stores/projectRemarks.ts` (new)**, modeled on `src/stores/sync.ts`
(`byProject[projectId]` map):

- Entry: `{remarks, countsByFile, fileMissing, mtime, loading, error}`.
- Actions: `load`, `refreshIfStale` (one `fileMtime` round trip), `add`,
  `setDone`, `edit`, `remove`. Every mutation: read fresh → pure edit → write →
  re-parse → set state; `null` from the pure edit → error + reload. `add` on a
  missing file writes `REMARKS_TEMPLATE` + bullet.
- All I/O via `src/components/embed/fileAccess.ts`
  (`readFileText`/`writeFileText`/`fileMtime`) — local-or-SFTP transparent.
- Refresh: on first demand per project; `refreshIfStale` when the remarks view
  becomes visible and after in-app saves of `*/REMARKS.md`. **No background
  poll** (remote-cost rule, `PaneVisibleContext`).

**`src/components/files/FileTree.tsx`**:

- Badge: in the row-decoration block beside `<GitMarker>` / `file-sync-slot`, a
  new fixed-width `.file-remark-slot` count pill for files with open remarks;
  gated on `useExperimental("project_remarks")` && projectId. Directories: no
  rollup in v1.
- Context menu "Add file remark…": copy the "Send to project…" triple exactly —
  state, button in the single-entry branch with `<UntestedTag />`, dialog beside
  `SendToProjectDialog`. Files only.
- `FileBrowser.tsx`'s second context menu: **skip in v1** (no project scope).

**`src/components/files/AddRemarkDialog.tsx` (new)** — shared by tree + editor.
Standard dialog chrome, explicit text color (portaled-dialog rule). Props
`{projectId, projectDir, file, line?, onClose}`; Save → `store.add`.

## Phase 4 — remarks view in ProjectFilesView

New **`View` value `"remarks"`** (not a section — wants full pane height + a walk
toolbar, like sessions/jobs) in `src/components/files/ProjectFilesView.tsx`;
toolbar toggle beside sessions/jobs, flag-gated, `<UntestedTag />`. The shared
component means all hosts (side panel, Files tab, sidebar, detached) get it for
free.

**`src/components/files/RemarksPane.tsx` (new)** — interaction model:
`src/components/embed/pdf/PdfNotesPane.tsx`:

- Rows grouped by file, document order: done checkbox, `file:line` chip, text
  (React text nodes, `stripFormatControls`), edit, delete (confirm),
  "Make a card".
- Ring walk: ‹/› + count, wraps; stepping jumps.
- Click-to-jump: `resolveRemarkAbsPath` re-validation, then open-tab +
  `requestJump` via an `openFile(path, line)` prop wired like SearchPanel's.
- Stale probe: visible-only (`usePaneVisible`), one `fileMtime` per unique file
  per load, missing targets dimmed "file not found", never auto-deleted.
- Empty state: sentence + "Open REMARKS.md" button.

## Phase 5 — editor "Add remark at line"

`src/components/embed/FileViewerPane.tsx` `TextView`: `CodeEditor` already
exposes a caret getter via `caretApiRef` (only TexView uses it today). Add the
ref in TextView, pass it to its `CodeEditor`. Toolbar button (flag-gated, file
inside projectDir): caret offset → `offsetToLineCol(draft, off).line` →
project-relative path → `AddRemarkDialog` prefilled. MarkdownView edit mode:
same button only if cheap; else TextView-only v1 (markdown files can hold their
own notes) — noted as a follow-up.

## Phase 6 — remark → todo card (`TaskFileLink`)

- `src/types/index.ts` (after `TaskEventLink`):
  `TaskFileLink {project_id?, path, line?, text?}` (identifiers + a snapshot
  frozen at conversion; `project_id` never validated — existing convention).
  `CalendarTask` gains `file?: TaskFileLink | null`; extend the "at most one of
  mail/event" doc note to include `file`.
- `src-tauri/src/schema/calendar.rs`: mirror struct beside `TaskMailLink`,
  `pub file: Option<TaskFileLink>` beside `event`, `skip_serializing_if`;
  round-trip test beside the existing one.
- **CalDAV round-trip (load-bearing)**: in `merge_caldav_calendar_at`
  (`src-tauri/src/commands/calendar.rs`, the board-state-kept block that already
  preserves `mail`/`event`/`project_id`) add `task.file = local.file.clone();`
  + a merge test. Push is safe (`ics.ts` never serializes board fields).
  Confirm `carry_extra` carries unknown keys for older builds.
- `src/lib/todoBoard.ts`: `taskFromRemark(remark, projectId, conv)` through
  `convertedCard`; title = first text line; notes source line = glyph + data
  (`📌 src/foo.ts:123`, module rule); sets the `file` link + top-level
  `project_id`. Tests beside the existing todoBoard tests.
- RemarksPane "Make a card": wire like `TodoMailRail`'s `taskFromMail` call
  (calendarId/columnId defaults, `create_task` via stores).
- Card chip: beside the mail/event chip render, a file chip `basename:line`,
  dimmed when the project is unresolvable; click → resolve project dir →
  `resolveRemarkAbsPath` → `jumpToSource(absPath, line ?? 1)` (handles
  cross-window routing).

## Phase 7 — scaffold, flag, i18n, docs

- `src-tauri/src/commands/projects.rs`: new `REMARKS_SCAFFOLD` const (the
  template from the spec incl. the format note, so the file teaches its own
  convention); `SCAFFOLD_FILES` entry after TODO.md; link lines in
  `PROJECT_SCAFFOLD` + `AGENTS_SCAFFOLD`. `repair_project_scaffold_at` picks it
  up automatically for existing projects. Update the rust scaffold tests and
  `src/__tests__/ScaffoldRepair.test.ts`.
- `src/components/projects/scaffold.ts` `buildScaffoldFillPrompt`: a clause
  telling fill agents the bullet format and to leave the format note intact.
- Flag `project_remarks`: `Settings` in `src/types/index.ts` **and**
  `src-tauri/src/schema/settings.rs`; `EXPERIMENTAL_FLAGS` in
  `src/lib/experimental.ts`; read only via `useExperimental`. Not a tab kind.
- i18n: all keys under `projectRemarks.*` in the `en` block of
  `src/lib/i18n.ts`.
- Docs: `src/CLAUDE.md` rows for the 4 new files; `src-tauri/CLAUDE.md`
  calendar.rs row notes the `file` link. TODO follow-ups (FileBrowser menu, dir
  rollup badge, MarkdownView editor button, fs_watch live badges) →
  `todo/group-m-viewers.md`.

## Verification

1. `npm run build` (the only type-check), `npm test`,
   `cargo test --manifest-path src-tauri/Cargo.toml`.
2. `npm run lint`; `cargo clippy --manifest-path src-tauri/Cargo.toml
   --all-targets -- -D warnings` (mind CI's newer stable).
3. Backend edits (projects.rs, calendar.rs, schema/*): run
   `npm run backend:stale`, report the result. Never launch/restart Eldrun.
4. Live click-through (user-run): flag on → right-click file → Add remark →
   badge appears → remarks view walk + jump (incl. `./path:123` links in
   REMARKS.md's own preview) → editor add-at-line → Make a card → chip click
   jumps → scaffold repair on an old project creates REMARKS.md → CalDAV sync
   keeps the file chip. `UntestedTag`s stay until each item is confirmed tested.
5. Before push: `git add -A && scripts/privacy-check.sh`.

## Risks / notes

- Line hints drift as files change — accepted; pane wording "near line N".
- A store write while REMARKS.md sits dirty in an open editor tab surfaces via
  the existing `externalChange` banner in `useEditableFile` — correct behavior.
- Rust/TS template duplication (`REMARKS_SCAFFOLD` vs `REMARKS_TEMPLATE`): pin
  with a test or document the drift risk.
- Remote projects: one read per activation + one mtime per view-show; live
  badges under external edits are a follow-up (`fs_watch`).
