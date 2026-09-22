# ProjectEldrun — Frontend File Map (`src/`)

Only the load-bearing files are listed; the tree is the source of truth. See
the root `AGENTS.md` for project rules; `docs/filemap_backend.md` is the
backend file map.

Deliberately **not** a `CLAUDE.md` (agents auto-load those). Grep it for the
file you touch. **One line per row**: what the file is for, plus an invariant
only when breaking it does damage. The *why* goes in code comments or
`docs/context/`, never here. Pre-2026-09-18 long-form rows: `docs/filemap_rationale/frontend.md`.

`src/lib` and `src/stores` group by domain under the same folder names (`agents/`
(+ `agents/prompt/`), `calendar/`, `remote/` (+ `hpc/`, `vpn/`), `terminal/`, `window/`,
`theme/`, `shortcuts/`, `projects/`, `drag/`, `viewers/`); shared helpers and the big
stores stay at the top. No `index.ts` barrels (`docs/src_restructure_plan.md`).

**Entry & shell**

| File | Purpose |
|------|---------|
| `src/App.tsx` | Root component, theme injection, global key handlers. |
| `src/main.tsx` | React entry point. |
| `src/crashReporter.ts` | Captures/forwards WebKitGTK renderer crashes to the backend. |
| `src/lib/window/rendererWatchdog.ts` | Renderer memory watchdog: reloads a window whose webview renderer passes 4 GB. Per window (AppShell + DetachedApp); own renderer pid is probed, not asked; 10-min reload cooldown. Tests: `RendererWatchdog.test.ts`. |
| `src/lib/window/strayFullscreen.ts` | Clears a stray OS fullscreen (it silently makes a popout unmovable). `isFullscreen()` can't be trusted, so it clears unconditionally; judgement in pure `mayClearStrayFullscreen`. |
| `src/types/index.ts` | Shared TypeScript types. |

**Layout (`src/components/layout/`)**

| File | Purpose |
|------|---------|
| `AppShell.tsx` | Top-level layout: header, center, side-panel wiring. |
| `HeaderBar.tsx` | Window drag handle + the top bar's three zones: centre = project strip only; right = global apps (✉ 🗓 ☑), global menus (🧠 ▦ ⚙), then `header/StatusCluster`. |
| `GlobalAppBar.tsx` | Global toolbar / app launcher (`GLOBAL_APP_ROLES`). |
| `GlobalAppMenu.tsx` | Context menu for a global-app toolbar button. |
| `CenterPanel.tsx` | Tab/subwindow tiling host; keeps all panes mounted across scope switches. |
| `DetachedCenterPanel.tsx` | Center-panel variant inside a detached OS window. Title-strip double-click = fit-to-this-screen (`snap_detached_window`); double-click counted from `pointerdown` because the WM grab eats `dblclick`. |
| `DetachedApp.tsx` | Root component of a popped-out subwindow (#42). Holds the no-fullscreen guard (a fullscreen popout can't be moved): F11 maximizes here instead. |
| `DetachedCloseChoice.tsx` | What the WM ✕ on a popout asks: dock tabs back, close them, or cancel. Portaled dialog → sets an explicit color. |
| `ProjectSwitcher.tsx` | Thin composition root of the project bar: fixed `BoxScopeChip` segment, scrolling project strip, then + / search. Re-exports scaffold helpers. |
| `ProjectSearch.tsx` *(in `projects/`)* | Inactive-project/box search box + results popover. |
| `ProjectDialog.tsx` *(in `projects/`)* | New/Import project dialog: local folder, GitHub/GitLab clone or fork, SSH + OpenVPN + scaffold-fill sub-flows, and the project-container question (default on for imports, off for new). |
| `SettingsPanel.tsx` | Settings dialog + sub-panels (theme/git/layout, global apps, file-type apps, Ollama, shortcuts, help). Built entirely out of `settingsUi.tsx` — do not hand-roll a row, a card or a header here. |
| `settingsUi.tsx` | The settings design system (`SettingsHeader/Section/Card/SettingRow/ToggleRow/ToggleCard/SettingsList`, CSS under "Settings design system"). Every settings surface is built only from these. |
| `ThemeCustomizer.tsx` | Theme Customizer: the whole palette as one editable token list (swatch, name, example, hex, reset) + corner style and saved presets; rendered instead of the Settings dialog. |
| `UpdatesPanel.tsx` | Settings → Updates: check GitHub releases on mount (never in background), then download → install as separate steps. No path or URL crosses IPC. |
| `layout/AgentContinueHost.tsx` + `stores/agents/agentContinue.ts` + `shared/usageReport.ts` | Auto-continue per agent tab: reads the CLI's own usage panel (`agent_usage`), submits `continue` a minute after the soonest rollover. Not a scheduler — writes nothing to `agent_tasks.json`. |
| `mobile/MobileSettings.tsx` + `mobile/MobileBridgeHost.tsx` | Eldrun Mobile desktop surface (`docs/eldrun_mobile_agent_plan.md`): host/serve/pairing/device controls + the event bridge (agent catalog, tab creation, Alerts snapshot; `alert_resolve` goes through `lib/alertDone`). `mobileScope` is the one gate every handler passes — project, box, or root behind its switch + review gate (`docs/mobile_root_plan.md`). |
| `mobile/MobileSetupGuide.tsx` | The six-step setup overlay behind the header's phone icon while Mobile is off (`HowToStart`'s chrome). Runs the `tailscale serve` command in a root terminal, and deep-links Settings to its Mobile section (`SETTINGS_ANCHORS`). |
| `SidePanel.tsx` | File-tree overlay panel; thin host of the shared `files/ProjectFilesView`. Owns only panel chrome (📌 pin, resize, hidden-subwindows slot); also opens in the root scope (`~/eldrun/root`). |
| `RootOverlay.tsx` + `stores/rootOverlay.ts` | Root console (Ctrl+Shift+R, `docs/context/root_console.md`): root scope as one floating subwindow of attach-only PTY views. Always-mounted host merges `root-mcp-changed` rows, refreshes review counts; `openTabInRootConsole` is the door for flows that run in root. |
| `RootMcpSecurity.tsx` | Visible-only Settings fold: per-session read/write and tool-family grants, calendar/project/account scopes, revoke action and bounded audit display; no credential reaches the renderer. |
| `RootReviewStrip.tsx` + `stores/rootReview.ts` | Body of the proposals panel the console's ⚿ badge drops (store's `panel`), not a strip in the console body. Also lists agent-written mail drafts (`stores/mail` `agentDrafts`) as rows that open the composer, never an Approve, and `.ics` files an agent staged (`imports`; `IcsReportBody` + `stores/calendar/importIcs.ts`, the Import button's own importer, which marks the calendar `imported`). Root-agent proposals: literal before/after rows, invisible-control stripping, outbound effects, digest-bound ✓/✗ + bulk approval and conditional Undo; count feeds the console's own ✓ Approvals button (the only door — the project bar carries no copy), which drops the panel; the ⚿ chip beside it only reports the tools' state. |
| `VpnPasswordPrompt.tsx` | Modal prompting for an OpenVPN password on activation. |
| `LogoIcon.tsx` | Inline SVG logo (full ring/branches + spark), currently unused by the header — kept as the source design in case a full mark is wanted elsewhere. |
| `StarIcon.tsx` | The logo's gold spark. Only in the header's root button and a detached window's title strip — not per tab group. |

**Projects, header widgets, tabs, terminal, files, embed, common**

| File | Purpose |
|------|---------|
| `projects/ProjectPill.tsx` | Individual project pill (click/close/drag-reorder/group); "Remote machines…" opens `RemoteMachinesWindow`; VM projects get a ▣/▢ state glyph and "VM settings…". |
| `projects/ProjectExportDialog.tsx` | "Export project…" (pill menu): measures the tree, its `.git` and its rebuildable folders separately so each toggle shows what it costs, then writes one `.eldrunproj` via the save dialog. Names what never travels (keychain secrets, machine-bound sync state). |
| `projects/ProjectImportBundleDialog.tsx` | "Import Project File" (+ menu): reads a bundle's manifest first (nothing unpacked), shows what is in it and what is missing, then imports into a chosen folder. Refuses a remote bundle whose host folder is already a project here. |
| `projects/VmSettingsDialog.tsx` | VM tier knobs (`docs/context/vm_projects.md`): boot/shut down/rebuild, memory/cpus/disk, egress mode, GitHub/extra-host allowlist, blocked-CONNECT log. Sibling of `ContainerSettingsWindow`. |
| `projects/HpcPipelineWizard.tsx` | Guided HPC/SLURM pipeline wizard (+ menu → "HPC pipeline…"): Login → Project → Workspace → Load data → Run job → …; composes existing flows, never reimplements them. |
| `projects/RemoteMachinesWindow.tsx` | Unified remote hub (`docs/multi_host_remote_plan.md` §4.4): primary host first, then workers, + Add a machine (offers global machines). Connect/Manage opens the shared `RemoteConnectDialog`; workers get sync/pull-outputs/shared-fs toggles. |
| `projects/useRemoteBrowse.ts` | The one shared "log in to a host + browse over SFTP" state machine (used by `useRemoteSession` and `RemoteMachinesWindow`). A session is a frozen `(conn, password)` pair. |
| `projects/RemoteFolderBrowser.tsx` | The one remote folder-picker UI (breadcrumb, go-up, recent jump, new folder, listing); state comes from `useRemoteBrowse`. Exports `remoteEntryExt`. |
| `projects/TerminalSignInToggle.tsx` | "Sign in in a terminal" per-connect switch (default off) on both connect dialogs: swaps password fields for an embedded login terminal. Never writes the global setting; not on Windows. |
| `projects/CredentialPasteBar.tsx` | "Type it for me" bar above an embedded login terminal: pastes login name / saved password at the cursor. The secret never enters the frontend (`credential_paste_to_pty`). |
| `projects/BigFolderExcludeDialog.tsx` | "These folders are giant — sync them?" asked once at remote setup (via `stores/bigFolders`), both sides' sizes, excluded by default; mounted once as `BigFolderDialogHost`. |
| `projects/BoxScopeChip.tsx` | The scope chip at the head of the pill row: root terminal, Trash and boxes (#13/#41) in one dropdown, outside the scrolling strip. |
| `projects/BoxEditorDialog.tsx` | The box editor (rename / full member checkbox list / confirmed Dissolve / container-VM trust notice), mounted once in `AppShell` (`BoxEditorHost`), driven by `stores/boxEditor`. |
| `projects/ActivityCalendar.tsx` | Per-project activity calendar heatmap (unrelated to the calendar tab). |
| `projects/scaffold.ts` | Pure helpers: name sanitize, SSH-address parse, scaffold/description fill prompts. |
| `calendar/CalendarPane.tsx` | Calendar tab shell: toolbar, search, ICS import/export, view switch. |
| `calendar/TimeGrid.tsx` | Day/week hour grid: positioned blocks, drag-create/move/resize, now-line. |
| `calendar/MonthView.tsx` | Month + multiweek grid, with multi-day spanning bars. |
| `calendar/AgendaView.tsx` / `calendar/TasksView.tsx` | Flat upcoming list; to-do (VTODO) list. |
| `calendar/EventDialog.tsx` | Event editor (repeat, reminders, category, this-vs-all occurrences) + video-call field (`lib/calendar/conference.ts`). A link derived from location/notes is only hinted, never written into the field. |
| `calendar/CalendarSidebar.tsx` | Mini-month + calendar list (color, visibility); CalDAV calendars carry their own sync affordance (⇅ / … / amber ! with the backend's error as tooltip). |
| `calendar/CalendarContextMenu.tsx` | The calendar's one right-click menu, in every view: Edit/Copy, New here/Paste, and the delete scopes. A click on a block is both an event and a slot, so a full day can still be pasted into. |
| `calendar/CalDavAccountDialog.tsx` | CalDAV account editor (`docs/caldav_plan.md`), `MailAccountDialog`'s twin (`SavePasswordRow`, `true \| null` never `false`) plus server discovery → pick collections. No server presets. |
| `calendar/CalDavSyncHost.tsx` | Scheduled CalDAV sync (renders nothing), mounted once at the shell. Mail's rules: free with no account, first tick one interval away, `0` = never. |
| `calendar/CalDavConflictDialog.tsx` | The one answer to a CalDAV 412, mounted at the shell: keep mine (conditional overwrite on fresh ETag), use the server's, or decide later. No merge. |
| `calendar/IcsImportReviewDialog.tsx` | Shows what a picked `.ics` contains before import (`lib/calendar/icsSafety.ts`) and what Eldrun does about each finding; not raised for a clean file. Not a quarantine gate. |
| `common/useFloatingFrame.tsx` | Move / resize / fill for the header overlays (mail, calendar, to-do): the root console's frame math and grips as a hook; frame per overlay in localStorage. |
| `calendar/CalendarOverlay.tsx` | Calendar as a global app (`calendar_global_app`): header 🗓 overlay (`CalendarOverlayHost`) rendering the same `CalendarPane` a tab does. Twin of `MailOverlay`. |
| `calendar/AlarmPopup.tsx` | In-app reminder popup (snooze/dismiss); mounted in `AppShell`. |
| `todo/TodoOverlay.tsx` | Global to-do board overlay (`todo_board`), header ☑ (`TodoOverlayHost`), mounted last of the three overlay hosts (DOM order = z tie-break). No todo tab; not in popouts. |
| `todo/TodoPane.tsx` | Filter bar + board + two rails. Renders `applyPending(tasks, pendingOrder)` (the drag's optimistic overlay), never the raw store. |
| `todo/TodoBoard.tsx` | Board and owner of card drag: commit bound via `bindDragRelease` synchronously in pointerdown (WebKitGTK), capture on `documentElement`, `pointercancel` commits safely (no column → card stays). One backend write per drag (`todo_move_tasks`). |
| `todo/TodoColumn.tsx` / `todo/TodoCard.tsx` | Column (dragged card rendered out of its list) and card (checkbox, inline title, chips, checklist, mail link). Adding a card opens the full card dialog, not an inline composer. |
| `todo/TodoCardDialog.tsx` | Full card editor on an elevated backdrop, for adding (empty `task.id`) and editing. Checklist never drives `percent` (100% moves a card to Done). |
| `todo/TodoMailRail.tsx` / `todo/TodoAgendaRail.tsx` | Urgent-mail rail (calls `mailPriorityPage` directly, never `openPriority`; `mail_client` gate checked before invoke) and today/tomorrow agenda rail. Both convert into a card through one builder. |
| `mail/MailPane.tsx` | Embedded mail client (`mail_client` flag): folder rail (account-independent Important/Urgent + rules above, accounts/folders below) / header list / message view. |
| `mail/MailOverlay.tsx` | The mail surface: header ✉ overlay (`MailOverlayHost`) rendering `MailPane`. One gate, `mail_client` (the mail tab and `mail_global_app` are retired). |
| `mail/MailList.tsx` | Header list. Threat-model rules: addr-spec always shown beside display name; mail strings are plain text nodes. Column grid via shared `--mail-cols`, fixed widths except sender. |
| `mail/MailMessageView.tsx` | Message pane: body in `<iframe sandbox="">` (never `allow-scripts`/`allow-same-origin`) with inline `<meta>` CSP; links are `data-lid` markers opened after a confirm naming the host; remote content blocked with no unblock control. |
| `mail/MailEncryptionDialog.tsx` | Local mail-store encryption dialog (`docs/context/mail_encryption.md`): unlock / offer / status faces chosen by `MailEncryptionState`. Copy must not overstate what it protects. |
| `mail/MailKeysDialog.tsx` | OpenPGP keyring. Fingerprint shown in full, grouped in fours, never truncated; "checked with owner" is reversible; export is public-only. |
| `mail/MailAccountDialog.tsx` | Account editor. Save-password opt-in, default off, sends `true \| null` (never `false`, which clears). Uses shared `SavePasswordRow`; generic presets only. |
| `mail/MailFiltersDialog.tsx` | Keyword filters filing arriving mail into Important/Urgent. States its limits on its face (local mark, snippet not body, arriving mail + explicit re-run, Sent/Drafts/Trash/Junk out of scope). |
| `mail/MailComposeDialog.tsx` | Composer. Sign/Encrypt per message, default off, never remembered; missing-key check while writing. Attaching is backend-side (`mail_attach_pick`) — no filesystem path in the frontend. |
| `browser/BrowserPane.tsx` | In-app browser tab (`web_browser` flag): a DOM pane rendering sanitized reader mode (no in-pane native webview under WebKitGTK); real engine = separate hardened window. Mounting never touches the network. |
| `browser/BrowserReaderView.tsx` | Reader body: `MailMessageView`'s containment (`<iframe sandbox="">`, imported mail CSP, `readerLooksUnsafe` tripwire). No `dangerouslySetInnerHTML` in this dir (`BrowserTripwire.test.ts`). |
| `browser/BrowserAddressBar.tsx` | Address field as a security control: host at full weight and never truncated, userinfo flagged, punycode shown; `parseAddressInput` refuses non-http(s). |
| `browser/BrowserSecurityChip.tsx` | Security chip + popover: renders `SecurityState` verbatim; unknown `tls` degrades to unknown, never secure. |
| `browser/BrowserDownloadDialog.tsx` | Download consent: bytes already quarantined by the backend; Save raises the OS save dialog. No destination from the frontend, no "save all", no "open when done". |
| `browser/BrowserBlockedNotice.tsx` / `browser/BrowserStartPage.tsx` | Refused navigation as a page state (full URL, no override); loopback/private addresses get a one-tab, one-session "Open anyway, once". Plus the start page / resume card. |
| `browser/useBrowserEvents.ts` | Backend browser events installed once per window (refcount + generation counter). |
| `browser/BrowserDownloadHost.tsx` | The one download-consent dialog mount per window (`AppShell` + `DetachedApp`); owns the event listeners. |
| `skills/SkillsLibraryTab.tsx` / `skills/SkillsLibraryView.tsx` / `skills/SkillsOverlay.tsx` | Skills Library (`docs/skills_plan.md`): browse git-hosted skills, preview, copy into `.claude/skills/` or `~/.claude/skills/`. Install only from the preview panel. |
| `printing/PrintManagerPane.tsx` | Native print manager tab: printers, queues, make default / pause / test page / cancel. Machine-scoped (no project props), singleton per scope; `visible` gates polling. |
| `header/Clock.tsx` | Header clock. |
| `header/DevBuildIndicator.tsx` | Dev-build chip in the cluster: the background frozen-dev build's step/clock/estimate bar; hover menu opens a `tail -F` of its log, and in the frozen window offers "Relaunch now" onto a newer snapshot. Renders nothing in release builds. |
| `header/StatusCluster.tsx` | Machine-state readouts (connection, battery, Mobile, OpenVPN, Machines, CPU/RAM/GPU) as one collapsible cluster: collapsed = one worst-state `ConnLamp`; persists `Settings.header_status_expanded`. |
| `header/SettingsMenu.tsx` | Header ⚙ menu: settings, help, tours, lessons. `GlobalAppMenu`'s twin on the shared `headerHoverMenu` id. |
| `header/HeaderGlyphs.tsx` | The top bar's drawn icons (✉ 🗓 ☑ ▦ ⚙ as SVG): 16-unit grid, outlines y=2→14, the phone icon's line weight. Sized in `mail-todo.css`. |
| `header/AppTimerDisplay.tsx` | Active-project time-tracking readout. |
| `header/AppResourceDisplay.tsx` | CPU/RAM/GPU readout. GPU = device memory + utilization (`gpustat`); Ollama models only in the tooltip, or as fallback where the GPU can't be read. |
| `header/ConnTypeIcon.tsx` | Local/remote (SSH) connection-type icon. |
| `header/MachinesIndicator.tsx` | Global machines (SSH hosts no project owns). Opens on click, never hover; probe sweep rate-limited (60 s/machine) and skips HPC hosts. Reads `status` and `reachable` maps. |
| `header/MailIndicator.tsx` | Header ✉ (the only way into mail, `mail_client`). Red dot = unread inbox derived from the local index (`inboxUnread`), not an arrivals counter. |
| `header/CalendarIndicator.tsx` | Header 🗓 (`calendar_global_app`), `MailIndicator`'s twin. Badge is derived from store + clock each minute, never acknowledged. |
| `header/TodoIndicator.tsx` | Header ☑ (`todo_board`). Badge = open cards due today or overdue on visible calendars, derived not acknowledged; hover lists the cards. |
| `header/InboxIndicator.tsx` | Header tray for the **global inbox** (`<state_dir>/inbox/`, phone → Send to desktop). Renders only while files wait; badge = count, derived. Hover lists files (open / armed delete), click shows the folder. Polls `global_inbox_list` every 10 s while visible. |
| `header/VpnIndicator.tsx` | Machine-wide OpenVPN control: always present, lists stored `.ovpn`s, connects/disconnects a tunnel with or without a project behind it, names its holders, and arms one to connect on launch. |
| `header/WindowControls.tsx` | Minimize/maximize/close window buttons. |
| `tabs/TabBar.tsx` | Per-subwindow tab strip (add/rename/close, pointer-based DnD). |
| `tabs/TabColorPicker.tsx` + `lib/theme/tabColors.ts` | Tab user colour (#264): closed 8-hue palette (the calendar's); the id, not the hex, is persisted and crosses to the phone (`protocol::clean_tab_color`). |
| `tabs/agentWorktrees.ts` + `lib/agents/agentWorktrees.ts` | Agent tab in a linked worktree (#23): `useAgentWorktreePicker` asks before spawning an agent only when a linked worktree exists (local `git_worktree_list`); worktree = cwd, branch in label. Local projects only. |
| `tabs/localModelGroup.ts` | The "+" menus' local-model group (TabBar + popout share it). Agent rows only once the "tabs" model is on the GPU (`list_ollama_models_detailed` `size_vram`; CPU counts on a GPU-less machine); else one "Load onto GPU" row (`load_ollama_model` device `gpu`). Probes only while the menu is open. |
| `tabs/Subwindow.tsx` | A single tiled subwindow (tab group). Its body is a row: the measured pane region + (when the group's `filesOpen` is set) the docked per-subwindow file viewer. |
| `tabs/commitDrop.ts` / `tabs/commitFileDrop.ts` | Apply a tab/file drag-drop into the layout tree. |
| `tabs/dragGeometry.ts` | Drop-zone/split geometry math for tab drags. |
| `tabs/tabScopeContext.ts` | `TabScopeContext` (the root console provides `ROOT_SCOPE`) + `openTabInScope`: tabs a view opens land in that scope, not the active one — file-tree opens, diffs, compiled PDFs, Files-tab "Open in a new tab", TeX workspace. Null elsewhere = old `addTab` path. |
| `terminal/TerminalView.tsx` | xterm.js wrapper + PTY I/O. Attach-only views reconcile scrollback snapshot with live events by backend UTF-8 byte offsets. Registers the scheduled-input capability (`lib/agents/scheduledAgentInput`); hidden panes get only `terminal-activity` digests. |
| `files/FileTreeSearch.tsx` | Flat search results replacing the tree listing while the box holds a query: name (literal substring, not fuzzy) and content (`project_search`, its only frontend). Each hit can jump-to-path and open. |
| `files/FileTree.tsx` | Project file tree: git markers, fs-watch refresh, in-tree search, `revealPath`, file drag-and-drop (tab bar / folder / ctrl+drag to OS). "Open in a new tab" is a host callback (`onOpenFolderTab`). |
| `files/ProjectFilesPane.tsx` | The project file view (tree, sort, remote sync row, Downloads), rendered by `SidePanel` and the Files (Project) tab. Hosts own only browsed folder, sort, Remote/Local switch placement. Also `useFileSource` / `useIndependentFileSource`. |
| `files/ProjectFilesView.tsx` | The whole file viewer (Files / Git / Apps / Orange views, git bar + `GitHistory`, tracked windows, diverged files, hover card, …) around `ProjectFilesPane`; rendered by both `SidePanel` and the Files tab. Viewer features go here. |
| `agents/AgentSchedulesView.tsx` + `stores/agents/agentPrompts.ts` + `lib/agents/prompt/send.ts` + `lib/agents/agentPrefaces.ts` | Agents view (#249): the scope's agent tabs with state + schedules, and collected prompts (`agent_prompts.json`) with send / schedule / tags / history + prompt blame. "Send now" = a one-time schedule at the current minute, not a second PTY write route. Composer prefixes are the CLI's own slash commands, sent one per line before the prompt; no mode control. |
| `stores/agents/agentModels.ts` + `lib/agents/agentModel.ts` + `shared/agentSort.ts` | Model tag and ordering for Agents views (desktop + phone): the tag is the pane's own status line read the way Focus reads it (`agentTabModelTag` → `screenModelTag`), with the agent's transcript (`agent_tab_model`, shortened) behind it; Eldrun passes no model flag. |
| `agents/{PromptChartTab,PromptChart,PromptTimeline,PromptCard,PromptSessionCard,PromptChartLinks}.tsx` + `agents/usePromptChartDrag.ts` + `lib/agents/prompt/{chart,timeline,autoTags,links}.ts` | Prompt chart tab (#262, `PROMPTCHART_TAB_CMD`, singleton per scope): timeline/board of scheduled and chained prompts, session cards, links; agent schedule attribution, approval and delivery lineage. `PromptChartTab` is the thin host. |
| `agents/AgentScheduleProposal.tsx` + `agents/AgentScheduleMcpSettings.tsx` | Shared agent-origin chip and guarded Approve / Dismiss controls; off-by-default schedule MCP switch in Manage CLIs and trusted per-project levels. |
| `agents/PromptDraftBoard.tsx` + `lib/agents/prompt/drafts.ts` | Free draft board (project-scoped localStorage) sharing the chart's ports and drag hook; double-click empty spot = composer there. Chained (After) cards never take a time position; only the chain root gets a schedule. |
| `files/{AddRemarkDialog,RemarksPane}.tsx` | Project file remarks: shared add dialog and full-height grouped/walkable REMARKS.md view. Reads and writes stay project-scoped and demand-driven through `stores/projectRemarks`. |
| `files/ProjectFilesTab.tsx` | The Files (Project) tab: a thin host that renders `ProjectFilesView` (so it has *exactly* the panel's features). It resolves the project from its own `scope` and keeps the browsed folder on the *tab* (`TabEntry.folder`, persisted), which is what makes "Open in a new tab" on a folder mean anything after a restart. Passes no window-chrome slots. Also exports `openProjectFilesTab` (kept here to avoid a `ProjectFilesView`↔tab import cycle). |
| `files/SubwindowFilesSidebar.tsx` | Per-subwindow docked file viewer (◫): hosts `ProjectFilesTab`. State (`filesOpen`/`filesWidth`/`filesFolder`) lives on the layout `GroupNode` so it persists and travels with a detach. |
| `files/importDrop.tsx` | OS-file drop → copy into project with collision prompt (`useImportDrop`), shared by panel and tab. WebKitGTK withholds drop paths, so the ⬇ picker is the reliable route. Prompt wears `.file-delete-dialog`. |
| `files/ProjectFilesSettings.tsx` | Tree hide-by-ending lists (in `project.json`) + Project Settings dialog; also Tree Grouping toggles (`panel_separate_scaffold` / `panel_separate_gitignored`). |
| `files/SpellDictionaryPicker.tsx` | Spell-check dictionary rows: pick installed Hunspell dictionary (`Settings.spell_language`, machine-wide) and download more (`spell_install_language`). Names/split in `lib/spellDictionaries`. |
| `files/AlertsSection.tsx` + `files/useAlertsFeed.ts` | Alerts group (urgent mail, next appointments, due cards) rendered by `ProjectFilesView` under every view, not only the tree (`SidePanelAlertsEveryView.test.tsx`). |
| `files/SendToProjectDialog.tsx` | "Send to project…": pick a project, browse inside it (`list_dir`), copy via `import_external_file` (collision keeps both). Local destinations and local sources only. |
| `files/FileBrowser.tsx` | The *other* files tab: a two-pane explorer (list/icons, columns, history). Deliberately not the tree — no drag-and-drop, no git markers; both are offered. |
| `files/GitHistory.tsx` | Commit history / commit / push, lockstep bar, Worktrees (#23). Branch control is a dropdown for checkout, text input for create; worktree removal is confirmed and escalating (it deletes ignored files). |
| `files/GitPullPanel.tsx` | Pull preview (incoming/outgoing commits, upstream-changed files, fast-forward or merge) + the merge-in-progress bar (conflicts → `gitmerge` viewer, commit/abort). Opened from a branch's ↓N chip or the git bar's Pull. |
| `embed/GitMergeView.tsx` | `gitmerge` viewer: the sync resolver's `CompareView` fed by git — ours ⇄ theirs mid-merge (Resolve writes + stages), else HEAD ⇄ upstream look-only. Stateless: a restored tab re-asks the repo. |
| `files/SetDefaultAppDialog.tsx` | Pick the default app for a file type. |
| `embed/EmbedPane.tsx` | Hosts an embedded external app window. |
| `embed/FileViewerPane.tsx` | In-app viewers (image, markdown, code, TeX/SyncTeX) + shared plumbing. Markdown follows local links and `#fragment`s (`stores/viewers/mdAnchor`); autocomplete ghost/visibility/acceptance UI delegates streaming/model/cache work to `lib/viewers/completion/ollamaCompletionProvider.ts`; code-editor key helpers (`applyIndent`, `applyLineComment`, `applyAutoIndent`, `detectIndentUnit`). |
| `embed/MdGraphView.tsx` | Markdown relationship graph (`md_graph` flag): BFS rings of links from `lib/viewers/mdGraph.ts`; one bounded scope-confined read per look, never polled. |
| `embed/YamlTree.tsx` | YAML/JSON tree: renders rows but edits text (every action splices the draft), so edits are ordinary undoable changes. Pointer-drag reorder (HTML5 DnD is broken on WebKitGTK). |
| `embed/BibCards.tsx` | BibTeX card view: one card per entry, filter over all fields, per-card fold (`ViewerState.bibCollapsed`); Source is the other half. |
| `embed/YamlGrid.tsx` | Optional YAML/JSON card view ("Cards"): drill navigation — one main card, its level, its children; cards show scalar fields only. |
| `embed/TableView.tsx` | CSV/TSV table (read-only `.xlsx`). Edits splice text so untouched cells keep their bytes; sort/filter carry source row index (`RowRef`). Separator sniffed, overridable per tab; column hiding via `ColumnsMenu`. |
| `embed/GifView.tsx` | Animated-GIF viewer: decodes frames (`lib/viewers/gif.ts`) onto canvas with transport controls, sharing the image viewer's zoom/pan; falls back to native `<img>`. |
| `embed/pdf/PdfViewer.tsx` | PDF viewer: pdf.js canvas stack, zoom/find/print toolbar, SyncTeX, page rail, contents sidebar, painted link layer (`links.ts`). Always load through `lib/viewers/pdfLoad.ts`. |
| `embed/pdf/pdfDoc.ts` | Source documents of an arrangement + `buildPdf`, the only place a PDF is written (pdf-lib). Blackout redaction flattens marked sheets to pixels — never an overlay rectangle. |
| `embed/pdf/outline.ts` | Outline model (pure): embedded bookmarks → file pages, font-size heading fallback. `resolveDest`/`destTop` are the one destination resolver, shared with the link layer. |
| `embed/pdf/pageFingerprint.ts` | Cheap per-page fingerprint from the operator list so a recompile repaints only changed sheets. |
| `embed/pdf/links.ts` | The PDF's own hyperlinks: GoTo (via `outline.ts`) and URI (confirmed) only; Launch/GoToR/named actions/widgets not rendered. Uses `url`, never `unsafeUrl`; `routeUri` re-checks scheme. |
| `embed/pdf/pageText.ts` | Positioned text runs per page, shared by SyncTeX, Ctrl+F highlight and link coverage. `pageTextItemBoxes` (rotated space) vs `pageTextItemBoxesUnturned` (page space) — keep the split. |
| `embed/pdf/pageInk.ts` | "Does the page draw anything here?" from a raster rendered at `AnnotationMode.DISABLE`; the link layer's second stage and the only thing allowed to drop a link. |
| `embed/pdf/notes.ts` | The PDF's own `/Text` and `/Highlight` annotations as remarks; `links.ts`'s sibling, same `SyncRect` space. |
| `embed/pdf/PdfNoteLayer.tsx` | Remark markers + highlights, placement menu and remark card. `PdfNote.quads` decides pin vs highlight. |
| `embed/pdf/PdfNotesPane.tsx` | Remarks panel: every comment in one list in reading order (`placedNotes`); Next/Previous walk a ring (`stepNote`). |
| `embed/pdf/PdfTextLayer.tsx` | Selectable text layer (pdf.js `TextLayer`) over rendered pages. Not a mode — always on. |
| `embed/pdf/PdfSelectionBar.tsx` | Selection bar over selected text: 4 highlighter colours (swatch = action), highlight + remark, copy. |
| `embed/pdf/selection.ts` | Selection as geometry: DOM Range rects → big points per page, clipped per page, merged along lines. |
| `embed/pdf/scrollBox.ts` | `scrollIntoPdfBox`: the one way to scroll to a spot on a page. Never `Element.scrollIntoView` (it scrolls `overflow: hidden` ancestors too). |
| `embed/pdf/PdfLinkDialog.tsx` | Confirm before a PDF link leaves the app: `MailMessageView`'s link confirm, full URL never truncated, no "always open". |
| `embed/pdf/present.ts` | PDF present-window link (pure): `present-pdf-…` label derived from the PDF path (re-present reuses the window); only the path crosses, never bytes. |
| `embed/pdf/PdfPresentApp.tsx` | PDF present window: one sheet fitted on black, own heap, sleep inhibitor, off-screen paint then blit; fullscreens only after the first sheet paints. |
| `common/PageStrip.tsx` | **The** page-thumbnail strip: drag-reorder, shift-select, turn, delete, right-click. Used twice — horizontally by the print preview, vertically as the PDF viewer's page rail. |
| `common/mountPageStrip.tsx` | `createRoot` adapter letting the imperative print modal host `PageStrip`. |
| `common/Dropdown.tsx`, `common/OrbitSpinner.tsx` | Shared primitives. |
| `common/icons/{Icon,FileIcon}.tsx` | The shared line-icon set (24-grid, 1.7 stroke, `currentColor`, `em`-sized) that replaces colour emoji in the chrome; `FileIcon` renders `fileIconKind()` for every file list. New icons go here, not as emoji. |
| `common/ConnLamp.tsx` | Red/orange/green SSH/OpenVPN status lamp (dialog + header). |
| `common/TimeField.tsx` | Clock-entry field for the event dialog's start/end, drawn by Eldrun. Native `<input type="time">` is ruled out (engine-locale 12/24h face). |
| `common/DateField.tsx` | The one date-entry field. Replaces `<input type="date">` (process-locale segment order; undismissable WebKitGTK popover). |
| `common/DateTimeField.tsx` | Wall-clock instant field: `DateField` + `TimeField` + shortcut chips. Replaces `<input type="datetime-local">`; half a value is never reported. |
| `common/SyncConfirmDialog.tsx` | The confirmation every manual byte-sync pull/push asks, mounted once per window (`AppShell` + `DetachedApp`); says which side's bytes overwrite which. |
| `common/PromptDialogs.tsx` | The four in-app question shapes (`TextPromptDialog`, `ConfirmDialog`, `ChoiceDialog`, `MessageDialog`) on `.file-delete-dialog`, plus awaitable `useDialogs()`. Never `window.prompt/confirm/alert`. |
| `common/ExecTrustHost.tsx` + `lib/execTrust.ts` + `stores/execTrust.ts` | The ask-once "run this project's hooks / latexmkrc / prettier?" prompt; gated commands go through `invokeTrusted`. Mounted per window (AppShell, DetachedApp). |
| `common/LocalLossDialog.tsx` | Warns that lockstep or sync **destroyed something in the local mirror** (#28q). Mounted at the shell, like the alarm popup: a background pass can delete a file while the user is three tabs away. It reports, it does not confirm — the write has already happened; the gates that prevent one live upstream. |
| `stats/StatsRecap.tsx` | Usage recap dialog: agents/models used, prompts asked, autocomplete accept/dismiss by mode/model, file churn, commits, time per project, Day/Week/Month. |
| `stats/StatsRecapHost.tsx` | Decides when the recap is on screen: once per day at launch (anchored on *yesterday*), or on demand via the `eldrun:open-stats` event. Mounted in `AppShell`. |

**Stores (`src/stores/`), hooks, lib**

| File | Purpose |
|------|---------|
| `projects.ts` | Project list, active project, CRUD, `setActive`. Also owns scope restore: `restoreProjectScope` (one project's saved tabs into its own scope, no switch) and `restoreActiveProjectScopes` (every **active** pill at launch — active means its terminals were never stopped, so they resume without waiting for a click). |
| `tabs.ts` | Tab/subwindow layout tree per scope; tab persistence policy. |
| `boxes.ts` | Project boxes: N:M membership (`boxMembership`/`useBoxMembership`; `addToBox`/`removeFromBox`/`boxProjects` — no silent dissolve), the persisted `box:<id>` scope's restore + seed (`restoreBoxScope`), and the box-scope helpers (`boxFolderOfScope`, `boxMembersOfScope`). |
| `settings.ts` | App settings (theme, default agent, git profile, shortcuts, etc.). |
| `ollamaAutoload.ts` | Loads chosen Ollama models at start (`settings.ollama_autoload_models`). Suppressed by Energy Saver. |
| `windows.ts` | Embedded app windows. |
| `detached.ts` | Detached subwindow protocol (#42): channels, pure reducers, main-window host (`listenDetachedHost`) that reseeds popouts on store changes and mirrors tab statuses back. |
| `detachedContext.ts` | Popout store seam (#231): a popout's stores hold no tabs, so store actions consult this module and forward writes to the main window. Don't add per-call-site window logic. |
| `drag.ts` | Isolated per-frame drag state (reference for fine-grained selectors). |
| `activity.ts` | Working / decision / finished state of every PTY tab, published on a 300 ms tick. Agent hooks (`turnByPty`, from `services::agent_turn`) are authoritative; byte heuristics only as fallback. `busyKindByTab` says what a busy tab is busy *with* — agent turn, command, or both — and `busyStateClass` turns that into the strips' state class. |
| `timer.ts` | Per-project time-tracking state. |
| `usage.ts` | Usage counters: in-memory accumulator (`bumpUsage`) flushed in batches to `usage_bump`, + the recap's read store. |
| `hpcPipeline.ts` | Open/closed state of the HPC pipeline wizard (`HpcPipelineWizardHost` in `AppShell`). Mirrors `remoteMachines`. |
| `hpcJobs.ts` | In-memory list of SLURM jobs this session submitted (for the Jobs view before the next `squeue`). `squeue` is the truth; no persistence. |
| `caldav.ts` | CalDAV accounts + sync, a second store beside `calendar.ts`. Sync merges via `caldav_apply` (never a replace); failures visible per collection. |
| `calendar.ts` | Global calendars/events/tasks (one `calendar.json`); the only owner of task persistence (`moveTasks` = one write per drag, `setColumns`). |
| `calendar/clipboard.ts` | The calendar clipboard (one copied entry, a snapshot). Module-level, so a copy pastes in another calendar tab and outlives the navigation. |
| `todo.ts` | To-do board session state only (overlay flag, filters — never persisted, drag, optimistic overlay, mail cache, `collapsedSteps`, `focusTaskId`). |
| `browser.ts` | In-app browser store (#61). Nothing reaches the network on its own (`load`/`openLive` only, both clicks), actions tolerate a rejected invoke, downloads refused by default. |
| `mail.ts` | Global mail store. Every action tolerates a rejected invoke (lands in `error`); only `checkMail` reaches a server. Owns list order (`setSort` → `mail_headers`). |
| `skills.ts` | One boolean: is the Skills Library overlay shown. Holds no catalog copy on purpose. |
| `alarms.ts` | Reminder ticker: fires an OS notification + the in-app popup, exactly once each. |
| `linkRouting.ts` | Routing of clicked links/URIs to viewers or external apps. |
| `pdfSync.ts` | Bidirectional PDF/SyncTeX sync state. |
| `pdfDrag.ts` | PDF page drag between strips, incl. across windows (`PDF_DRAG_*`/`PDF_DROP_ACK`; bytes via backend `pdf_clip`). Also the drag-active signal behind the spring-loaded rail. |
| `editorJump.ts` | Cross-pane jump-to-location requests. |
| `mdAnchor.ts` | Cross-tab "scroll to this heading" requests for markdown links carrying a `#fragment` — `editorJump`'s shape for heading targets instead of lines, window-local because `openLinkedFile` routes into the clicking tab's own window. |
| `vpnPrompt.ts` | State backing `VpnPasswordPrompt`. |
| `headerStatus.ts` | What each `StatusCluster` member reports; widgets self-report (`null` = not a member); nothing here polls. |
| `remoteStatus.ts` | Live SSH/VPN state for header lamps: `byProject` = primary host, `byHost[projectId][hostId]` = workers; read via `sshOf`/`vpnOf`/`hostStateOf`. |
| `hostSessions.ts` | The project's tmux session list (#85): one poll per host shared by every surface. |
| `syncConfirm.ts` | `confirmSyncTransfer(req)`: resolves true only after an explicit yes; preview fetched after the dialog is up; a second ask while open is answered no. |
| `localLoss.ts` | The active project's local-loss log (#28q). Pulled from the backend's on-disk record — not pushed as an event — so a deletion during a background pass, or while the app was closed, still surfaces. |
| `presentation.ts` | Two counters readable outside their owners: `armed` (presentation overlay has marker/laser) and `presenting` (deck presenter on screen) — so Escape goes to the right listener. |
| `vpnStatus.ts` | Machine-level OpenVPN state keyed by config path; holder refcount (`releaseVpn`) and `markVpn*` helpers. |
| `hooks/useKeyboard.ts` | Global keyboard-shortcut hook. |
| `hooks/useListReorder.ts` + `lib/listReorder.ts` | The shared drag-a-row-into-place gesture for `{ id }[]` lists. Pointer events (not HTML5 DnD); the grip takes pointer capture. |
| `lib/shortcuts/shortcuts.ts` | Shortcut definitions, chord parsing/resolution. |
| `lib/agents/codexHooks.ts` | Codex hook-trust state + the one-click "open Codex on `/hooks`" fix. |
| `lib/remote/vpn/vpnConnect.ts` | Silent-connect gate: ask `vpn_can_connect_silently` before connecting (pkexec prompts before OpenVPN validates). Store-free. |
| `lib/remote/vpn/vpnAutoConnect.ts` | "Connect on launch" per `.ovpn` (`settings.vpn_auto_connect`), never prompts. Also `openVpnLoginInTerminal` + `pollVpnUp`, the one non-headless VPN login. |
| `lib/remote/vpn/vpnGate.ts` | VPN gate for mail/CalDAV accounts flagged `require_vpn`: scheduler skips while no tunnel is up. `useVpnTunnelUp` is tri-state (`null` before first reconcile). Enforcement is backend (`services::openvpn::account_gate`). |
| `lib/untested.ts` | The untested register: one row per `UntestedTag` pill (id → area, what, `tested` date). A stamped row hides its pill everywhere at once; `npm run untested -- list|tested|sweep` (`scripts/untested.mjs`) drives it. Ids are typed, so a swept row breaks its call sites at compile time. Tests: `UntestedRegistry.test.ts`. |
| `lib/i18n.ts` | The i18n module: every UI string for `en/de/es/fr/it`. English holds every key; others fall back. Non-English dicts code-split into `lib/i18nDicts/*.ts`. |
| `lib/remote/machineSync.ts` | Keeps a global machine and the project host it also is in step, bridged only by SSH target (`sameTarget`: host case-insensitive, default port 22). |
| `lib/viewers/completion/autocomplete.ts` | Caret-window bounds, type-through, line acceptance, bounded model/completion caches and the code/prose model pick (`ollama_roles.autocomplete{,_prose}`) for native editors. |
| `lib/viewers/completion/completionContext.ts` | Static local import/TeX discovery and same-project open-tab references, cancellation and UTF-8 byte budgets before completion IPC. |
| `lib/viewers/completion/completionProvider.ts` | Provider/candidate contract, UTF-16 positions, safe insertion ranges and original-item partial/full acceptance offsets for Group M #45a. |
| `lib/viewers/completion/copilotCompletionProvider.ts` | Copilot adapter (#45a): `copilotServes` gate (flag + provider + consenting local project + code language, else Ollama), completion/cancel IPC, and `CopilotFeedback` (shown once, cumulative partial, single full acceptance, close). Settings/consent/sign-in UI is `components/layout/CopilotCompletionCard.tsx`. |
| `lib/viewers/completion/ollamaCompletionProvider.ts` | Ollama adapter: model selection, cancellable streaming IPC and bounded provider-keyed cache, extracted from the editor. |
| `lib/viewers/mdGraph.ts` | Pure markdown-graph logic (#101): fence-aware link extraction, bounded BFS crawl, radial layout. Tests: `MdGraph.test.ts`. |
| `lib/projects/projectRemarks.ts` / `stores/projectRemarks.ts` | Defensive REMARKS.md parser/splicer plus local-or-SFTP I/O. Conforming bullets are editable; all other bytes are parked verbatim. |
| `lib/viewers/{fileUtils,markdown,highlight}.ts`, `lib/viewers/tex/tex.ts` | Pure viewer logic (XSS-safe markdown/highlight, TeX, file utils). `tex.ts` also resolves `\ref`/`\cite` keys to their `\label`/`.bib` entry via the editor-jump channel. |
| `lib/viewers/pdfLoad.ts` | `loadPdf`: the only way to open a PDF with pdf.js (sets the worker). Destroys the loading task on failure — a rejected load otherwise leaks a Worker. |
| `lib/viewers/tex/texPreview.ts` | TeX hover preview (frontend half): typesets a hovered formula via `tex_preview_snippet`; cache keyed by preamble + snippet text, not position. |
| `lib/viewers/tex/beamer.ts` | Beamer mode for the TeX editor (pure): overlay-spec recognition, wrap/re-target (never nest), `insertPause`, `nextOverlayNumber`, `beamerEditRange`. |
| `lib/projects/fileViewSnapshots.ts` | Side panel's last-known data in module scope so a reveal's first frame is populated (the panel unmounts when closed). Tests need `clearFileViewSnapshots()`. |
| `lib/viewers/python.ts` | Python editor intelligence (#87), pure: breakpoints snap to executable lines and remap on edit; go-to-definition is a lexical import-graph walk (only followable names underlined). |
| `lib/browser.ts` | Typed invoke surface for the browser (`browser_*`); no component invokes directly (`BrowserTripwire.test.ts`), no wrapper takes a path. `READER_FRAME_CSP` is `MAIL_FRAME_CSP` imported. |
| `lib/linkTarget.ts` | Pure URI routing table (#33) + address-bar commit rule. URLs Eldrun itself starts go external; URLs from untrusted content open in reader mode, never live in one click. |
| `lib/hardenPrototype.ts` | Freezes `Object.prototype` from `main.tsx` before bootstrap (#159), methods turned into override-safe accessors first — a bare freeze (Tauri's `freezePrototype`) breaks pdf-lib and would also hit browsed pages. |
| `lib/mail.ts` | Typed invoke surface for mail (`mail_*`); no wrapper takes a path (the sandbox boundary). Also `buildMessageSrcdoc`, `MAIL_FRAME_CSP`, `bodyLooksUnsafe` tripwire, `Authentication-Results` display rules. |
| `lib/remote/hpc/slurm.ts` | SLURM glue for HPC projects: pure `#SBATCH` parse/splice helpers (splice, never re-serialize) + tab glue (log window, submit). |
| `lib/spellDictionaries.ts` | Dictionary picker's pure half: Hunspell stem → BCP 47, names via `Intl.DisplayNames`, default choice, installed/downloadable split. |
| `lib/remote/hpc/hpcWorkspace.ts` | HPC workspaces (backend `commands::hpc_ws`): `ws*` invoke wrappers + shared pure helpers (`projectPathIn`, expiry labels/tones). Workspaces expire and get deleted. |
| `lib/agents/skills.ts` | Typed invoke surface for the Skills Library (`skills_*`); no manifest, installed list is a disk read; install addressed by `SkillTarget`, never a path. |
| `lib/agents/localDrivers.ts` | Typed invoke surface for local-model coding agents + model-update check. `listLocalDrivers(model)` hides agents a completion-only model (no tool calls) can't serve. |
| `lib/window/printing.ts` | Typed invoke surface for the print manager (`print_*`): queues only, no wrapper takes a path; `printSnapshot` resolves rather than rejects. |
| `lib/terminal/pythonRun.ts` | Run/Debug a Python file by opening a terminal tab (inherits remote/container locality); debug = pdb with gutter breakpoints. Interpreter asked of backend (`python_interpreter_for`). |
| `lib/agents/fastMode.ts` | Fast mode (`Settings.fast_mode`): the list of withdrawn costly display aids lives in this module's header (folder sizes, pill git dots, …). |
| `lib/theme/themeTokens.ts` | Theme Customizer allow-list of overridable CSS color tokens (grouped; ids are i18n keys). `normalizeThemeVars` is the gate; `THEME_COLOR_RE` accepts `#rrggbb` and `#rrggbbaa`. |
| `lib/theme/cursorPacks.ts` | Custom cursors (`Settings.ui_cursor`): three packs drawn at runtime to PNG on canvas in theme colors (WebKit has no SVG cursors). |
| `lib/experimental.ts` | Experimental-flag gate: off for users, on in debug mode (unset falls back to `settings.debug`). Read via `useExperimental`, never `settings.<flag> ?? false`. Also `EXPERIMENTAL_TAB_KINDS`/`withdrawnTabKinds`. |
| `lib/experimentalSweep.ts` | Closes tabs of a switched-off tab-owning experiment in every loaded scope (`closeTabsOfKinds`); installed once per window, re-run on settings change. Popouts sweep their own. |
| `lib/theme/customScrollbar.ts` | App-drawn scrollbars: WebKitGTK lacks `::-webkit-scrollbar` and only honours `scrollbar-width/color`, so the native bar is hidden and a thumb is painted. |
| `lib/terminal/tmuxSession.ts` | Persistent tmux sessions (#85): `newTmuxSessionName(scope, kind)` mints the stable `eldrun-<scope>--<kind>-<uuid>` persisted as `TabEntry.tmuxSession` (PTY ids aren't stable); `sessionKindFromName` inverts it. |
| `lib/remote/hostBound.ts` | Host-bound marker for local-model tabs in containerized projects (#150): uid minted once, registered via `register_host_bound_tab`, persisted as `TabEntry.hostBoundUid`. |
| `lib/agents/agentFence.ts` | Pure frontend contract for the agent fence: the settings allowlist defaults/parser and project-pill inherit/on/off + backend-status reason keys. `AgentFence.test.ts` keeps its default paths aligned with the Rust schema. Enforcement and root authority remain backend-only in `services::agent_fence`. |
| `lib/remote/closeRemoteTab.ts` | Tab close for persistent tabs (#85) is non-destructive: kills only the client, the tmux session lives on. Clean quit reaps local `eldrun-*` sessions only; remote sessions die only via the Sessions view's ×. |
| `lib/viewers/yaml.ts` | YAML/JSON tree model + edit ops (pure): every edit is a surgical splice, never re-serialization; block and flow (JSON) syntax both first-class and preserved. |
| `lib/viewers/tex/bib.ts` | BibTeX model + edit ops (pure), the one `.bib` reader (`tex.ts`'s `parseBibEntries` adapts it). All ops splice by source offsets, never re-serialize. |
| `lib/viewers/yamlGrid.ts` | YAML/JSON card-grid helpers (pure): `hasCards`, node classification; edits delegate to `yaml.ts` splices. Also the tabular model (`gridModelFor`/`hasGrid`). |
| `lib/viewers/table.ts` | CSV/TSV model + edit ops (pure): separator sniffed by parse rectangularity (`sniffDelimiter`); table is a view on the text (cells carry source spans). |
| `lib/viewers/gif.ts` | Pure GIF decoder (LZW, interlace, disposal): full-canvas RGBA per frame (bounded by `maxPixelBytes`), delays stored as authored, <20 ms played as 100 ms. |
| `lib/viewers/pageModel.ts` | Page-arrangement model (`PageRef{id,src,page,rot,marks?,notes?}`) for print preview and PDF rail: move/delete/rotate/duplicate/insert, pure. Marks/notes ride on the entry. |
| `lib/viewers/pdfNotes.ts` | PDF remarks, pure half (sticky notes and highlights; `isHighlight` = has `quads`); `quadsAnchor` places a highlight's card. |
| `lib/viewers/redact.ts` | PDF blackout marks, pure half: a mark is geometry in rotated big points, never the covered text; `snapToText` only grows a box. Burn-in is in `pdfDoc.ts`. |
| `lib/usageRollup.ts` | Folds UTC day/hour buckets into today/week/month windows. Generic over the payload — shared by `NetworkTrafficPane` (bytes) and the recap (counters). |
| `lib/gpu.ts` | GPU-memory arithmetic (pure) for header, monitor and model menu: memory = dedicated VRAM + shared pool; `gpuTone` tones by ratio. |
| `lib/usageMetrics.ts` | The metric keys (mirrors `schema::usage_stats::metric`) + how a tab maps to an agent or a local model. |
| `lib/agents/promptCount.ts` | "Enter with content pending = one submit" — the prompt/command heuristic, fed from `TerminalView`'s `onData`. |
| `lib/calendar/conference.ts` | The video-call link verdict every Join button reads: explicit field exact; derived only from a recognized meeting host or a URL-only location. |
| `lib/calendar/caldavPush.ts` | What bytes a CalDAV resource holds (pure): a resource groups a master + overrides by `caldav_href` (`resourceRows`, master first via `orderComponents`, `resourceIcs`). |
| `lib/calendar/calendarWriteHook.ts` | One-slot seam between calendar edits and CalDAV push (avoids a store import cycle). Upsert announced after the local write; delete before it, and a rejection stops the delete. |
| `lib/calendar/calendarClipboard.ts` | Copy/paste of an entry (pure): the copy keeps everything typed, drops identity (`id`/`uid`/`caldav_*`/`recurrence_id`) and the repeat rule; the paste rewrites only start/end. |
| `lib/calendar/icsSafety.ts` | Lists what's in an `.ics` before import (alarms with actions, `ATTACH`, app-scheme links, …) — pure. Not a scanner. |
| `lib/calendar/calendarTime.ts` | Calendar date math (local stamps, exclusive ends, overlap layout). `formatTime`/`formatStampTime` are the two clock renderers (via `lib/timeFormat`). |
| `lib/timeFormat.ts` | The one 12h/24h answer (`Settings.time_format_24h`), read by every surface that prints a wall clock. |
| `lib/todoBoard.ts` | To-do board pure logic: bucketing, ordering, filters, badge + `urgentTodos`/`daysLate`, rails, drag geometry, deadline chip (`dueDelta`); whole-day vs timed `due`. |
| `lib/calendar/recurrence.ts` | Recurrence expansion (`expandEvents`) + exdate/override editing. |
| `lib/calendar/caldav.ts` | Typed invoke surface for CalDAV (`caldav_*`), no path args. `parseChanges` parses fetched resources with `lib/calendar/ics.ts` (one iCal parser), grouped by resource href. |
| `lib/calendar/ics.ts` | iCalendar parse/serialize (VEVENT/VTODO/VALARM/RRULE). Video call as RFC 7986 `CONFERENCE` (+ `X-GOOGLE-CONFERENCE` on read); `UID` round-trips for CalDAV push. |
| `lib/calendar/alarms.ts` | Pure alarm logic: which reminders are due, fire-once keys, snooze. |
| `lib/alertDone.ts` | What the Alerts ✓ does (side panel + phone): card → `toggleTaskDone`, mail → clear local priority mark, … Nothing is ever deleted. |
| `lib/alerts.ts` | Alerts selectors (pure): merge mail/events/tasks, severity then time. `now` is a parameter; lookahead in whole days, no backward limit. |
| `lib/calendar/calendarCategories.ts` | Event category → color palette. |
