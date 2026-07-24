# Full app-wide i18n — Implementation Plan (Group N, TODO #92)

> **Status: IN PROGRESS.** Settings dialog + all sub-panels, all of
> `components/layout/`, all of `components/common/`, and now **all 16 of 16**
> `.tsx` files in `components/projects/` are fully translated across all 5
> languages (en/de/es/fr/it). `src/lib/i18n.ts` holds **~1284 keys**, all with
> parity across every language (verified by the key-count script below).
> `npx tsc --noEmit` and the full vitest suite (2000+ tests) are green
> throughout — this doc exists so the remaining files can be picked up in a
> fresh session without re-deriving the approach.

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

Total so far: **~1284 keys**, all 5 languages at parity (script below confirms
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
- `components/header/` (8 files) — `MachinesIndicator.tsx` was mid-edit by
  the concurrent session; re-check before starting.
- `components/tabs/` (9 files)
- `components/calendar/` (8 files)
- `components/files/` (15 files)
- `components/embed/` + `embed/deck/` + `embed/pdf/` (28 files)
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

1. Finish `components/projects/` (5 files above) once safe to touch.
2. `components/header/` (check `MachinesIndicator.tsx` compiles cleanly first).
3. `components/tabs/`, `components/calendar/`, `components/files/` — smaller,
   likely no concurrent-edit conflicts.
4. `components/embed/` + `embed/deck/` + `embed/pdf/` — largest remaining
   batch (28 files); `embed/deck/` is a newer, less-stable feature (the
   `deck_presenter_plan.md` work) — sanity-check it's not also mid-refactor.
5. `components/monitoring/` + `components/stats/`.
6. `App.tsx`, then the content-data-file restructuring (hints/tour/lessons),
   then a final whole-repo grep sweep + update `i18n.ts`'s own top-of-file
   doc comment (it still says "Currently wired through the Settings dialog's
   main panel" — that sentence should be removed/updated once this plan is
   fully closed out).
</content>
