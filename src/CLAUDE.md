# ProjectEldrun — Frontend File Map (`src/`)

Only the load-bearing files are listed; the tree is the source of truth. See
the root `CLAUDE.md` for project-wide context (running, persistence, dev
workflow); see `src-tauri/CLAUDE.md` for the backend file map.

**Entry & shell**

| File | Purpose |
|------|---------|
| `src/App.tsx` | Root component, theme injection, global key handlers. |
| `src/main.tsx` | React entry point. |
| `src/crashReporter.ts` | Captures/forwards WebKitGTK renderer crashes to the backend. |
| `src/types/index.ts` | Shared TypeScript types. |

**Layout (`src/components/layout/`)**

| File | Purpose |
|------|---------|
| `AppShell.tsx` | Top-level layout: header, center, right-panel wiring. |
| `HeaderBar.tsx` | Window drag handle + hosts the project switcher in the header. |
| `GlobalAppBar.tsx` | Global toolbar / app launcher (`GLOBAL_APP_ROLES`). |
| `GlobalAppMenu.tsx` | Context menu for a global-app toolbar button. |
| `CenterPanel.tsx` | Tab/subwindow tiling host; keeps all panes mounted across scope switches. |
| `DetachedCenterPanel.tsx` | Center-panel variant rendered inside a detached OS window. |
| `DetachedApp.tsx` | Root component for a popped-out/detached subwindow (#42). |
| `ProjectSwitcher.tsx` | Thin composition root: pill strip + search/dialog/settings wiring. Re-exports scaffold helpers. |
| `ProjectSearch.tsx` *(in `projects/`)* | Inactive-project/box search box + results popover. |
| `ProjectDialog.tsx` *(in `projects/`)* | New/Import project dialog incl. SSH + OpenVPN + scaffold-fill sub-flows. An import's source is a local folder **or** a GitHub/GitLab clone (`git_clone` lands the tree, then the ordinary import registers it in place). |
| `SettingsPanel.tsx` | Settings dialog + sub-panels (theme/git/layout, global apps, file-type apps, Ollama, shortcuts, help). |
| `RightPanel.tsx` | File-tree overlay panel (git status/history). Its Files view is `files/ProjectFilesPane` — the same component the Files (Project) tab renders. |
| `VpnPasswordPrompt.tsx` | Modal prompting for an OpenVPN password on activation. |
| `LogoIcon.tsx` | Inline SVG logo. |

**Projects, header widgets, tabs, terminal, files, embed, common**

| File | Purpose |
|------|---------|
| `projects/ProjectPill.tsx` | Individual project pill (click/close/drag-reorder/group). |
| `projects/BoxPill.tsx` | Project-box pill (meta-grouping, #13/#41). |
| `projects/ActivityCalendar.tsx` | Per-project activity calendar heatmap (unrelated to the calendar tab). |
| `projects/scaffold.ts` | Pure helpers: name sanitize, SSH-address parse, scaffold/description fill prompts. |
| `calendar/CalendarPane.tsx` | Calendar tab shell: toolbar, search, ICS import/export, view switch. |
| `calendar/TimeGrid.tsx` | Day/week hour grid: positioned blocks, drag-create/move/resize, now-line. |
| `calendar/MonthView.tsx` | Month + multiweek grid, with multi-day spanning bars. |
| `calendar/AgendaView.tsx` / `calendar/TasksView.tsx` | Flat upcoming list; to-do (VTODO) list. |
| `calendar/EventDialog.tsx` | Event editor (repeat, reminders, category) + this-vs-all-occurrences prompt. |
| `calendar/CalendarSidebar.tsx` | Mini-month + calendar list (color, visibility). |
| `calendar/AlarmPopup.tsx` | In-app reminder popup (snooze/dismiss); mounted in `AppShell`. |
| `header/Clock.tsx` | Header clock. |
| `header/AppTimerDisplay.tsx` | Active-project time-tracking readout. |
| `header/AppResourceDisplay.tsx` | CPU/RAM/GPU readout. The GPU row is the **device's** memory + utilization (`gpustat`), not Ollama's models — those are one line of its tooltip, and the whole reading only on a machine whose GPU can't be read, where it falls back to the old Ollama-only figure rather than showing a zero. |
| `header/ConnTypeIcon.tsx` | Local/remote (SSH) connection-type icon. |
| `header/VpnIndicator.tsx` | Machine-wide OpenVPN control: always present, lists stored `.ovpn`s, connects/disconnects a tunnel with or without a project behind it, names its holders, and arms one to connect on launch. |
| `header/WindowControls.tsx` | Minimize/maximize/close window buttons. |
| `tabs/TabBar.tsx` | Per-subwindow tab strip (add/rename/close, pointer-based DnD). |
| `tabs/Subwindow.tsx` | A single tiled subwindow (tab group). |
| `tabs/agentModes.ts` | Planner/doer capability table: which agents can be launched into a Plan/Auto mode **and** resume on the respawn that costs (Claude only), plus the idempotent arg rewrite. |
| `tabs/commitDrop.ts` / `tabs/commitFileDrop.ts` | Apply a tab/file drag-drop into the layout tree. |
| `tabs/dragGeometry.ts` | Drop-zone/split geometry math for tab drags. |
| `terminal/TerminalView.tsx` | xterm.js terminal wrapper + PTY I/O. |
| `files/FileTreeSearch.tsx` | The flat result list `FileTree` shows in place of the browsed listing while its search box holds a query. Two modes: **name** (literal case-insensitive substring match on paths from `list_project_paths`, basename hits ranked first — deliberately NOT a fuzzy subsequence, which matches nearly everything) and **content** (literal line search via `project_search`, the same backend the right panel's Search view uses). Every result does both **jump-to-path** (reveal + select in the tree, via `FileTree`'s `revealPath`) and **open** (content hits open at the matched line). Confined to the browsed folder by default (`scopeRel`) with a **root** toggle for the whole project — content search walks only the scope; filename results filter to it. Local-source only — both backends walk the canonical local path — so `FileTree` only shows the box for a non-remote-source tree. |
| `files/FileTree.tsx` | Project file tree with git markers, fs-watch refresh. Hosts the in-tree search box + `FileTreeSearch` results and owns `revealPath` (jump-to-path: navigate to a rel path's folder, select + scroll the row). Owns the file drag-and-drop: pointer-drag a file onto a tab bar (→ embed/split/popout, via `stores/drag` + `commitFileDrop`), onto a folder row to move it, ctrl+drag to export it to the OS. Its "Open in a new tab" is a *host* callback (`onOpenFolderTab`), not a store call — a tree with no way to own a tab (a box root, a popout running on a streamed copy of the tabs) simply doesn't pass one, instead of offering an action that would go nowhere. |
| `files/ProjectFilesPane.tsx` | **The** project file view — tree, sort row, remote sync row, Downloads — rendered *twice*: by `RightPanel` and by the Files (Project) tab. One component, so the panel and the tab can never drift into two different file views of the same project (the bargain `PageStrip` strikes between the print preview and the PDF rail). What each host still owns is exactly what must differ: the browsed folder (two views of one project must not yank each other around), the sort (the panel unmounts the pane for Git/Search and the order has to survive the trip back), and where the Remote/Local switch sits. Also home to `useFileSource` (defaults to whichever side is *usable* — a disconnected remote opens on the mirror, not on a Connect prompt) and `useRemoteBlocked` (the gate every SFTP/git probe needs: they are synchronous Tauri commands, so dispatching one at a dead session freezes the window). |
| `files/ProjectFilesTab.tsx` | The Files (Project) tab: `ProjectFilesPane` plus the chrome the panel keeps in its header (name, source switch, import / open-in-OS / downloads / settings). Its folder is the *tab's* (`TabEntry.folder`, persisted), which is what makes "Open in a new tab" on a folder mean anything after a restart. |
| `files/importDrop.tsx` | OS-file drop → copy into the project, with the collision prompt (`useImportDrop`). Shared by the panel and the tab so an import behaves the same wherever it lands. WebKitGTK withholds dropped paths from HTML5 drops and only leaks one via `text/html`, which is why the picker (`⬇`) — not the drop — is the reliable multi-file route. |
| `files/ProjectFilesSettings.tsx` | The tree's hide-these-endings lists (read from / written to the project's own `project.json`, hence shared by both file views) + the Project Settings dialog that edits them. |
| `files/FileBrowser.tsx` | The *other* files tab: a two-pane explorer (list/icons, columns, history). Deliberately not the tree — no drag-and-drop, no git markers; both are offered. |
| `files/GitHistory.tsx` | Commit history / commit / push UI. |
| `files/SetDefaultAppDialog.tsx` | Pick the default app for a file type. |
| `embed/EmbedPane.tsx` | Hosts an embedded external app window. |
| `embed/FileViewerPane.tsx` | In-app viewers (image, markdown, code, TeX/SyncTeX) + shared viewer plumbing. |
| `embed/YamlTree.tsx` | The YAML/JSON structure tree: the editable half of the viewer, the way the rendered preview is markdown's. It renders *rows*, but it edits *text* — every action splices the draft `TextView` already owns, so Tree and Source need no conversion between them and a tree edit is an ordinary dirty/undoable/saveable change. A flow (JSON) container is badged as such, because that is the style its edits will keep. A key wears its `#` comment on its **hover** and a `#` marker when it has one (a config file's comments are the half worth reading, so they are not hidden behind a hover — only their text is). Reordering is a **pointer** drag from the row's grip (HTML5 DnD does not work under WebKitGTK, and mid-gesture listeners get dropped, so every handler is bound to the grip up front); it lives in `YamlRows` because a node can only be reordered **among its siblings** — dragging a key into another mapping is a re-parent, not a reorder. |
| `embed/TableView.tsx` | The CSV/TSV table (and, read-only, the `.xlsx` sheet). Like `YamlTree`, it renders *rows* but edits *text* — a cell edit splices the draft `useEditableFile` owns, so it is an ordinary dirty/undoable/saveable change and every cell nobody touched keeps its bytes. Hence sort and filter carry each row's **source** index (`RowRef`): a splice must address the row a cell came *from*, not the row it sits on. The separator is a **guess the reader can overrule** — sniffed, then offered in the header (Auto/comma/semicolon/tab/pipe/custom); an override persists per tab, Auto does not. Columns hide by name from `ColumnsMenu` (click to hide, click again to show; multi-select, so it stays open), which is why the row filter searches only the **visible** columns and why hiding is dropped when the delimiter changes — a hidden column is an *index*, and another separator cuts the row into different ones. Only the visible rows render, which is why the column widths are measured over the whole file up front: sized to what is on screen, every column would resize as you scrolled. |
| `embed/pdf/PdfViewer.tsx` | The PDF viewer: pdf.js canvas stack, zoom/find/print toolbar, SyncTeX, page rail. Renders an *arrangement* (`pageModel`), not the file — so reorder/delete/turn/merge are array ops, and nothing is written until Save. |
| `embed/pdf/pdfDoc.ts` | The open source documents an arrangement draws from, and `buildPdf` — the ONLY place a PDF is written (pdf-lib, on save). |
| `common/PageStrip.tsx` | **The** page-thumbnail strip: drag-reorder, shift-select, turn, delete, right-click. Used twice — horizontally by the print preview, vertically as the PDF viewer's page rail. |
| `common/mountPageStrip.tsx` | `createRoot` adapter letting the imperative print modal host `PageStrip`. |
| `common/Dropdown.tsx`, `common/OrbitSpinner.tsx` | Shared primitives. |
| `common/ConnLamp.tsx` | Red/orange/green SSH/OpenVPN status lamp (dialog + header). |
| `common/LocalLossDialog.tsx` | Warns that lockstep or sync **destroyed something in the local mirror** (#28q). Mounted at the shell, like the alarm popup: a background pass can delete a file while the user is three tabs away. It reports, it does not confirm — the write has already happened; the gates that prevent one live upstream. |
| `stats/StatsRecap.tsx` | Usage recap dialog: agents/models used, prompts asked, file churn, commits, time per project, Day/Week/Month. |
| `stats/StatsRecapHost.tsx` | Decides when the recap is on screen: once per day at launch (anchored on *yesterday*), or on demand via the `eldrun:open-stats` event. Mounted in `AppShell`. |

**Stores (`src/stores/`), hooks, lib**

| File | Purpose |
|------|---------|
| `projects.ts` | Project list, active project, CRUD, `setActive`. |
| `tabs.ts` | Tab/subwindow layout tree per scope; tab persistence policy. |
| `boxes.ts` | Project boxes (meta-grouping) CRUD + membership. |
| `settings.ts` | App settings (theme, default agent, git profile, shortcuts, etc.). |
| `windows.ts` | Embedded app windows. |
| `detached.ts` | Detached/popped-out subwindow state (#42). |
| `drag.ts` | Isolated per-frame drag state (reference for fine-grained selectors). |
| `activity.ts` | PTY-output activity outside React (`lastOutputByPty`). |
| `timer.ts` | Per-project time-tracking state. |
| `usage.ts` | Usage counters: in-memory accumulator (`bumpUsage`) flushed in batches to `usage_bump`, + the recap's read store. |
| `calendar.ts` | Global calendars/events/tasks store (one `calendar.json` across all scopes). |
| `alarms.ts` | Reminder ticker: fires an OS notification + the in-app popup, exactly once each. |
| `linkRouting.ts` | Routing of clicked links/URIs to viewers or external apps. |
| `pdfSync.ts` | Bidirectional PDF/SyncTeX sync state. |
| `pdfDrag.ts` | Dragging PDF pages between page strips, incl. across two Eldrun windows: strip registry + the `PDF_DRAG_*`/`PDF_DROP_ACK` protocol (OS-cursor stream in physical desktop px; bytes ride the backend `pdf_clip` slot, never the event payload). |
| `editorJump.ts` | Cross-pane jump-to-location requests. |
| `vpnPrompt.ts` | State backing `VpnPasswordPrompt`. |
| `remoteStatus.ts` | Per-project live SSH/VPN connection state for the header lamps. |
| `localLoss.ts` | The active project's local-loss log (#28q). Pulled from the backend's on-disk record — not pushed as an event — so a deletion during a background pass, or while the app was closed, still surfaces. |
| `vpnStatus.ts` | **Machine-level** OpenVPN state, keyed by config path: the tunnel reroutes the whole OS, so it outlives the project view and is shared between projects. Owns the holder refcount (`releaseVpn`) and the `markVpn*` helpers. |
| `hooks/useKeyboard.ts` | Global keyboard-shortcut hook. |
| `lib/shortcuts.ts` | Shortcut definitions, chord parsing/resolution. |
| `lib/codexHooks.ts` | Codex hook-trust state + the one-click "open Codex on `/hooks`" fix. |
| `lib/vpnConnect.ts` | The silent-connect gate: ask `vpn_can_connect_silently` **before** connecting, because `pkexec` prompts the user before OpenVPN validates anything — a doomed attempt costs a polkit dialog, and the modal after it costs a second. Store-free, so `stores/projects` can use it. |
| `lib/vpnAutoConnect.ts` | "Connect on launch", armed per `.ovpn` (`settings.vpn_auto_connect`): the machine-level twin of a project's `remote.auto_connect`, and like it, never prompts — re-checked at launch, so a stale opt-in leaves the tunnel down. |
| `lib/viewers/{fileUtils,markdown,highlight,tex}.ts` | Pure viewer logic (XSS-safe markdown/highlight, TeX, file utils). |
| `lib/viewers/python.ts` | Python editor intelligence (#87), all pure — every fs touch is injected. Two halves: **breakpoints** (pdb refuses blank/comment lines, so a gutter click *snaps* to the next executable one; a line number re-points at the wrong statement when you type above it, so every edit *remaps* them) and **go-to-definition** (a *lexical* import-graph walk — relative levels, aliases, `__init__` re-exports, src-layout — not a type inferencer). Only names it can actually follow are underlined, so the ctrl+click affordance never lies. |
| `lib/pythonRun.ts` | Run/Debug a Python file (#87) by opening a **terminal tab** — not a bespoke exec path. That is what makes it inherit remote-host and container locality for free (the *tab* carries both) and stay a real interactive terminal (`input()`, `Ctrl+C`, output survives exit). Debug is pdb pre-loaded with the gutter's breakpoints (`-c "b f:N" … -c continue`). **Which** Python it runs is asked of the backend (`python_interpreter_for`), never re-derived here: two interpreter rankings that can disagree is a bug waiting to happen, and only the backend can see conda/poetry at all. |
| `lib/experimental.ts` | The experimental-flag gate: **off for everyone, on in debug mode** (unset ≠ false — it falls back to `settings.debug`, so a flag still moving is invisible to someone *using* Eldrun and present by default for someone *building* it). Read a flag via `useExperimental`, never `settings.<flag> ?? false` — that spelling is what makes a flag miss the debug default. Gates `agent_mode_toggle` and `python_run_debug`. |
| `lib/viewers/yaml.ts` | The YAML/JSON tree model + its edit ops, all pure. The tree is a **view on the text**: every edit is a surgical splice, never a re-serialization of the parsed model — the only way a config file's **comments** survive an edit, and what lets Tree and Source share one draft. **Both** YAML syntaxes are first-class: *block* (indentation) and *flow* (`{a: 1}` — i.e. **JSON**, inline or spread over lines). Which one a node is written in decides how it is edited (block → line splice, flow → span splice) and the tree keeps the author's choice, so `[a, b]` grows to `[a, b, c]` and is never quietly rewritten into block. `strict` (a `.json` file) is the only dialect knob: no plain scalars, so keys and strings are quoted. **Comments are a node's own, not scenery** — a `#` is the only place YAML documents a key, so each node reads the one behind its value *and* the run directly above it at its own indent, and `setComment` writes back wherever the author already wrote (a new one goes behind, which adds no line). The consequence is in the edits: a comment **travels with its node**, so deleting or reordering a key takes its description along rather than leaving it to re-attach itself to whichever key slid into that place. `moveNodeTo` is the one reorder op (the ↑/↓ buttons are `to = at ± 1`): a drag across five rows is **one** splice, not five swaps — every splice invalidates the offsets after it. A construct it could not rewrite without botching it (anchor, alias, merge key, plain scalar continued across lines) still *renders* but comes back `editable: false`; a line it can't classify at all fails the parse and defers to Source. |
| `lib/viewers/table.ts` | The CSV/TSV model + its edit ops, all pure. Two things it exists to say. **The separator is guessed, not known** — `.csv` never states which character separates the columns, so assuming comma from the extension is exactly what renders a `;`-delimited export as one tall column; `sniffDelimiter` scores each candidate by parsing a sample *with* it (a comma inside a quoted field cannot fool the `;` reading) and asking how rectangular the result is, rejecting any character that never splits a row however consistently it fails to appear. And **the table is a view on the text**: `parseTable` hands back each cell's source span, so `replaceCell`/`insertRowAfter`/`deleteRow` are surgical splices — the only way editing one cell leaves every other field's quoting, the file's line endings and its delimiter byte-for-byte alone. Same bargain `yaml.ts` strikes for comments. |
| `lib/viewers/pageModel.ts` | **The** page-arrangement model (`PageRef{id,src,page,rot}` list) shared by the print preview and the PDF page rail: move/delete/rotate/duplicate/insert, all pure. |
| `lib/usageRollup.ts` | Folds UTC day/hour buckets into today/week/month windows. Generic over the payload — shared by `NetworkTrafficPane` (bytes) and the recap (counters). |
| `lib/gpu.ts` | The GPU-memory arithmetic shared by its three surfaces (header row, system monitor, local-model menu), pure; sampling is the backend's `gpustat`. The one idea: **GPU memory is the two pools summed** — the dedicated VRAM carve-out *and* the shared pool mapped from system RAM — because on an APU the carve-out is only the framebuffer (~86% full forever, meaningless) while a model actually lands in the shared half; on a discrete card the shared half is 0 and the sum is plain VRAM. Hence `gpuTone` tones by **ratio**: the old row's absolute 1 GB/2 GB thresholds suited a figure counting only Ollama's models and would peg a device-wide one at "hot" permanently. |
| `lib/usageMetrics.ts` | The metric keys (mirrors `schema::usage_stats::metric`) + how a tab maps to an agent or a local model. |
| `lib/promptCount.ts` | "Enter with content pending = one submit" — the prompt/command heuristic, fed from `TerminalView`'s `onData`. |
| `lib/calendarTime.ts` | Calendar date math: local wall-clock stamps, exclusive ends, overlap layout. |
| `lib/recurrence.ts` | Recurrence expansion (`expandEvents`) + exdate/override editing. |
| `lib/ics.ts` | iCalendar parse/serialize (VEVENT/VTODO/VALARM/RRULE), folding + escaping. |
| `lib/alarms.ts` | Pure alarm logic: which reminders are due, fire-once keys, snooze. |
| `lib/calendarCategories.ts` | Event category → color palette. |
