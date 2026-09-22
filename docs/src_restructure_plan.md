# src/lib + src/stores — group by domain

Status: **done 2026-09-18** — all thirteen moves landed, one commit per
domain, in the §6 order. Step 1 (path alias) was skipped: a codemod that
resolves every relative literal (imports, `import()`, `vi.mock`) against the
old tree and re-relativizes it made each move mechanical without it. The
`viewers/` split under **Later** is still open.

---

## 1. Why

`src/lib` has 118 files directly in the folder (only `viewers/` and
`i18nDicts/` are grouped); `src/stores` has 74. Files are found by grep, not
by browsing, and a subsystem's helpers are not visibly separate from shared
utilities. `lib/viewers/` (with `viewers/deck/`) already shows the target
shape: a domain folder, prefix dropped inside it.

## 2. Rules

- **Group by domain, never by kind** (no `utils/`, `hooks/`, `types/`).
- **Same folder names in both layers.** `lib/calendar/` and `stores/calendar/`,
  so one domain has one path in each layer. Stores never move into `lib`: the
  lib = logic / stores = Zustand state split stays.
- **Shared and 2-file groups stay at the top.** A folder is for 3+ files with
  a clear owner.
- **No `index.ts` barrels.** They breed import cycles and defeat the lazy
  pdf.js loading (`lib/viewers/pdfLoad.ts`). Import files directly.
- **Drop a redundant prefix only where the folder says it** (`agentPrompt*`
  → `agents/prompt/*`). Elsewhere keep the file name: a rename on top of a
  move costs blame and grep-ability for little gain.
- **`git mv`**, one domain per commit.

## 3. src/lib

| Folder | Files |
|---|---|
| `agents/` | agentCron, agentCronRun, agentFence, agentModel, agentPrefaces, agentRegistry, agentSchedule, agentUsage, agentUsageResets, agentWorktrees, codexHooks, fastMode, localDrivers, scheduledAgentInput, skills, promptCount |
| `agents/prompt/` | agentPrompt → `prompt.ts`; agentPrompt{Adopt,AutoTags,Chart,Drafts,Echo,Filter,Links,NewTab,Scheduled,Send,Tags,Timeline} → `adopt.ts`, `autoTags.ts`, … |
| `calendar/` | caldav, caldavPush, calendarCategories, calendarTime, calendarWriteHook, ics, icsSafety, recurrence, conference, alarms |
| `remote/` | remoteAutoReconnect, remoteConnect, remoteHosts, remoteImages, closeRemoteTab, hostBound, hostKey, hostKeyOnce, carefulHost, machineSync |
| `remote/hpc/` | hpcGuard, hpcHost, hpcWorkspace, slurm |
| `remote/vpn/` | vpnAutoConnect, vpnConnect, vpnGate |
| `terminal/` | terminalBus, terminalControl, terminalInput, terminalRegistry, ptyId, tmuxSession, shellScriptRun, pythonRun, pythonMainCache |
| `window/` | windowState, detachedVisibility, coords, dragPlatform, strayFullscreen, rendererWatchdog, screenshot, printing |
| `theme/` | themeTokens, cursorPacks, customScrollbar, tabColors, gitColors, categoryColor |
| `shortcuts/` | shortcuts, shortcutHint, superKey, tabJump, hints |
| `projects/` | fileMove, trashProject, dirSizeGuard, diskUsage, projectRemarks, projectSearch, sendToProject, fileViewSnapshots, sidePanelView |
| `viewers/` (exists) | + texPdfLink |

VPN sits under `remote/` (not its own top folder) so `stores/remote/vpn/`
can mirror it; the lib side alone has only 3 files. OpenVPN stays
machine-wide in behaviour — this is placement only.

**Stays at the top (~26):** i18n (+ `i18nDicts/`), paths, platform,
formatBytes, fuzzy, timeFormat, textSafety, experimental, experimentalSweep,
linkTarget, browser, installCommand, gpu, ollamaStatus, spellDictionaries,
keyring, listReorder, todoBoard, tour, lessons, alerts, alertDone, mail,
mailFilters, usageMetrics, usageRollup.

`i18n` stays put deliberately: 252 importers, including `mobile-web` (the
only lib module it imports), for no navigation gain.

**Later:** split `viewers/` (29 files) into `markdown/` (markdown,
markdownEdit, markdownEnrich, mdGraph), `tex/` (tex, texPreview, beamer,
bib) and `completion/` (autocomplete, completionContext, completionProvider,
ollamaCompletionProvider) — only after the completion-provider work is
committed.

## 4. src/stores

| Folder | Stores |
|---|---|
| `agents/` | agentContinue, agentModels, agentPrompts, agentSchedules, agentTask, ollamaAutoload, ollamaUpgrade |
| `calendar/` | calendar, caldav, alarms |
| `remote/` | remoteMachines, remoteStatus, remoteUsage, hostBusy, hostSessions, hostKeyPrompt, globalMachines, globalMachineMonitor, runHostPref, sync, syncConfirm, connectDialog, fileSourcePref |
| `remote/hpc/` | hpcJobs, hpcPipeline, hpcGuardPrompt |
| `remote/vpn/` | vpnStatus, vpnPrompt |
| `drag/` | drag, pdfDrag, pillDrag, pillSelection, tabLand, detachAnim, windowMove |
| `viewers/` | mdAnchor, pdfSync, scrollSync, presentation, texCenter, texViewPref, editorJump, fileSources |

Placement notes (from header comments): `fileSources` is a viewer tab's
resolved file source → `viewers/`; `fileSourcePref` is which side of a
*remote* project a view shows → `remote/`; `pdfDrag` moves pages between
strips/windows → `drag/`; `stopProjectPrompt` guards `deactivateProject` →
top.

**Stays at the top (~40):** tabs, projects, settings (together ~450 of the
~1,000 store imports), activity, windows, detached, detachedContext,
subwindowNav, headerHoverMenu, headerStatus, boxes, boxEditor, mail, todo,
usage, tour, hints, skills, browser, power, timer, localLoss, gitDirty,
bigFolders, linkRouting, keyboardSteering, rootOverlay, projectRemarks,
stopProjectPrompt, fileClipboard, screenshotPending.

## 5. Cost

- No path alias today: every import is relative. ~1,135 `lib` import lines
  across ~590 files; ~1,000 `stores` import lines, ~560 of them to stores
  that move. Intra-lib relative imports (~100) change too.
- `mobile-web` imports only `lib/i18n`, which does not move.
- ~80 files under `docs/`, `todo/` and `AGENTS.md` mention `lib/…` or
  `stores/…` paths.

## 6. Steps

0. **Precondition:** clean tree on `develop` — today's uncommitted work
   touches `lib/viewers/`, `lib/i18n*` and `stores/headerStatus`. No other
   session mid-edit in `src/lib` or `src/stores`.
1. **Optional alias commit:** `@lib/` and `@stores/` in `vite.config.ts`,
   `tsconfig.json` (+ `tsconfig.mobile.json` if needed) and the vitest config,
   then codemod every import to it. After that each move is a plain
   find-and-replace. Worth it only if the whole plan goes ahead.
2. **Moves, least-imported first**, lib and stores of one domain together:
   `remote/vpn/` → `remote/hpc/` → `calendar/` → `agents/prompt/` →
   `agents/` → `terminal/` → `window/` → `theme/` → `shortcuts/` →
   `projects/` → `drag/` → `viewers/` → `remote/`.
3. **Per commit:** `git mv`, fix imports (including `vi.mock('…')` paths in
   `src/__tests__/`, which tsc does not check), update the matching
   `docs/filemap_frontend.md` rows and live docs (`AGENTS.md`,
   `docs/context/`, open `todo/` items). Leave frozen/historical docs
   (`docs/filemap_rationale/`, finished `*_plan.md`) alone.
4. **Gates per commit:** `npm run build`, `npm test` (test **count** must not drop),
   `npm run lint`, `git diff --check`. No backend change, so cargo gates are
   untouched. After each move, grep `src/__tests__` for the old path: a
   `vi.mock` pointing at a path that no longer exists stops applying without
   any error.

## 7. Not doing

- Moving the top-3 stores or `i18n`.
- Barrel files or re-export shims at old paths.
- Colocating stores inside `lib` domain folders.
