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
| `ProjectDialog.tsx` *(in `projects/`)* | New/Import project dialog incl. SSH + OpenVPN + scaffold-fill sub-flows. |
| `SettingsPanel.tsx` | Settings dialog + sub-panels (theme/git/layout, global apps, file-type apps, Ollama, shortcuts, help). |
| `RightPanel.tsx` | File-tree overlay panel (git status/history). |
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
| `header/AppResourceDisplay.tsx` | Per-project CPU/resource readout. |
| `header/ConnTypeIcon.tsx` | Local/remote (SSH) connection-type icon. |
| `header/WindowControls.tsx` | Minimize/maximize/close window buttons. |
| `tabs/TabBar.tsx` | Per-subwindow tab strip (add/rename/close, pointer-based DnD). |
| `tabs/Subwindow.tsx` | A single tiled subwindow (tab group). |
| `tabs/commitDrop.ts` / `tabs/commitFileDrop.ts` | Apply a tab/file drag-drop into the layout tree. |
| `tabs/dragGeometry.ts` | Drop-zone/split geometry math for tab drags. |
| `terminal/TerminalView.tsx` | xterm.js terminal wrapper + PTY I/O. |
| `files/FileTree.tsx` | Project file tree with git markers, fs-watch refresh. |
| `files/FileBrowser.tsx` | File browser pane. |
| `files/GitHistory.tsx` | Commit history / commit / push UI. |
| `files/SetDefaultAppDialog.tsx` | Pick the default app for a file type. |
| `embed/EmbedPane.tsx` | Hosts an embedded external app window. |
| `embed/FileViewerPane.tsx` | In-app viewers (PDF, image, markdown, code, TeX/SyncTeX). |
| `common/Dropdown.tsx`, `common/OrbitSpinner.tsx` | Shared primitives. |
| `common/ConnLamp.tsx` | Red/orange/green SSH/OpenVPN status lamp (dialog + header). |

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
| `calendar.ts` | Global calendars/events/tasks store (one `calendar.json` across all scopes). |
| `alarms.ts` | Reminder ticker: fires an OS notification + the in-app popup, exactly once each. |
| `linkRouting.ts` | Routing of clicked links/URIs to viewers or external apps. |
| `pdfSync.ts` | Bidirectional PDF/SyncTeX sync state. |
| `editorJump.ts` | Cross-pane jump-to-location requests. |
| `vpnPrompt.ts` | State backing `VpnPasswordPrompt`. |
| `remoteStatus.ts` | Per-project live SSH/VPN connection state for the header lamps. |
| `hooks/useKeyboard.ts` | Global keyboard-shortcut hook. |
| `lib/shortcuts.ts` | Shortcut definitions, chord parsing/resolution. |
| `lib/viewers/{fileUtils,markdown,highlight,tex}.ts` | Pure viewer logic (XSS-safe markdown/highlight, TeX, file utils). |
| `lib/calendarTime.ts` | Calendar date math: local wall-clock stamps, exclusive ends, overlap layout. |
| `lib/recurrence.ts` | Recurrence expansion (`expandEvents`) + exdate/override editing. |
| `lib/ics.ts` | iCalendar parse/serialize (VEVENT/VTODO/VALARM/RRULE), folding + escaping. |
| `lib/alarms.ts` | Pure alarm logic: which reminders are due, fire-once keys, snooze. |
| `lib/calendarCategories.ts` | Event category → color palette. |
