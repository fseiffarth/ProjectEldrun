/**
 * The untested register — every `UntestedTag` pill in the app, in one table.
 *
 * A feature that is built but not live-verified wears the pill (see
 * `components/common/UntestedTag`). The pills used to be scattered across ~120
 * files, so clearing one feature meant hunting its markup down; here each pill
 * is one row, and confirming a feature is a one-line edit:
 *
 *   npm run untested -- list mail          # what is still tagged, and where
 *   npm run untested -- tested mail.       # stamp a whole prefix as verified
 *   npm run untested -- sweep              # delete the markup of stamped rows
 *
 * `tested` set → `isUntested()` is false → the pill stops rendering everywhere
 * that id is used, immediately. `sweep` is the later cleanup that takes the
 * markup and the row out of the source; nothing forces it to run first.
 *
 * Ids are the label's i18n key where the pill sits on one, else
 * `<file>.<n>`; the id is what the call site passes, so it must stay stable.
 * A new pill adds its row here — `src/__tests__/shell/UntestedRegistry.test.ts`
 * fails on a call site with no row, and on a row no call site uses.
 */

export type UntestedEntry = {
  /** The subsystem, for grouping in `npm run untested -- list`. */
  area: string;
  /** Which control wears the pill, in the words the user sees. */
  what: string;
  /** ISO date the user confirmed this feature live. Set → pill hidden. */
  tested?: string;
};

/** Every tagged feature. One row per pill; `tested` retires it. */
export const UNTESTED = {
  "desktop.settingsNavigation": { area: "shell", what: "Grouped settings pages, the left-hand search box and per-page scroll restoration" },
  "desktop.modalFocus": { area: "common", what: "Modal focus containment, restoration and nested Escape" },
  "desktop.projectForms": { area: "projects", what: "Project form sections, field guidance and pinned actions" },
  "desktop.headerMenus": { area: "shell", what: "Header menu keyboard navigation" },
  "desktop.welcome": { area: "shell", what: "Project-first welcome and primary dismissal" },

  // --- agents — Agent sessions, schedules and the prompt chart ------
  "agentSchedule.title": { area: "agents", what: "AgentScheduleDialog · Scheduled prompts · {tab}" },
  "promptChart.heading": { area: "agents", what: "PromptChart · Prompt chart" },
  "agent.vibeResume": { area: "agents", what: "Mistral tab · exact conversation resume" },
  "agent.vibeLocalResume": { area: "agents", what: "Local Mistral model tab · exact conversation resume" },

  // --- browser — The built-in browser -------------------------------
  "browser.downloadTitle": { area: "browser", what: "BrowserDownloadDialog · Download this file?" },
  "browser.resumeTitle": { area: "browser", what: "BrowserStartPage · This tab was left on a page" },
  "browser.securityDetails": { area: "browser", what: "BrowserSecurityChip · Connection" },
  "browser.startTitle": { area: "browser", what: "BrowserStartPage · New browser tab" },
  "browserPane.1": { area: "browser", what: "BrowserPane · Open live page" },
  "browserPane.2": { area: "browser", what: "BrowserPane · Clear browsing data" },

  // --- calendar — Calendar and CalDAV -------------------------------
  "caldav.dialogNew": { area: "calendar", what: "CalDavAccountDialog · Add a CalDAV account" },
  "calDavAccountDialog.1": { area: "calendar", what: "CalDavAccountDialog · Send my changes to this server" },
  "caldavConflict.title": { area: "calendar", what: "CalDavConflictDialog · Changed somewhere else too" },
  "calendar.overlayTitle": { area: "calendar", what: "CalendarOverlay · Calendar" },
  "calendarSidebar.alerts": { area: "calendar", what: "CalendarSidebar · Alerts on/off per calendar (reminders + header badge)" },
  "calendarContextMenu.1": { area: "calendar", what: "CalendarContextMenu · Edit" },
  "calendarContextMenu.2": { area: "calendar", what: "CalendarContextMenu · Copy" },
  "calendarContextMenu.3": { area: "calendar", what: "CalendarContextMenu · Delete" },
  "calendarContextMenu.4": { area: "calendar", what: "CalendarContextMenu · Delete this occurrence" },
  "calendarContextMenu.5": { area: "calendar", what: "CalendarContextMenu · Delete the whole series" },
  "calendarContextMenu.6": { area: "calendar", what: "CalendarContextMenu · Paste" },
  "calendarMenu.newHere": { area: "calendar", what: "CalendarContextMenu · New event here" },
  "eventDialog.repeatOnField": { area: "calendar", what: "EventDialog · Repeats on" },
  "calendarPane.undoDeleteCalendar": { area: "calendar", what: "CalendarPane · Undo a deleted calendar" },
  "icsReview.title": { area: "calendar", what: "IcsImportReviewDialog · Before importing this calendar file" },

  // --- common — Shared dialogs and hosts ----------------------------
  "execTrustHost.1": { area: "common", what: "ExecTrustHost · {t(TITLES[request.kind] ?? \"execTrust.title.gitHooks\")}" },
  "hostKey.title": { area: "common", what: "HostKeyConfirmDialog · Is this the right machine?" },
  "hpcGuardDialog.1": { area: "common", what: "HpcGuardDialog · {t(copy.title)}" },
  "projectSwitcher.stopTitle": { area: "common", what: "StopProjectDialog · Stop this project's terminals?" },
  "syncConfirmDialog.1": { area: "common", what: "SyncConfirmDialog · {t(host ? \"syncConfirm.deleteHostTitle\" : \"syncConfirm.deleteLocalTitle\")}{\" \"}" },
  "syncConfirmDialog.2": { area: "common", what: "SyncConfirmDialog · {t(pull ? \"syncConfirm.pullTitle\" : \"syncConfirm.pushTitle\")}" },

  // --- dev — Developer-only surfaces --------------------------------
  "devPerfHost.1": { area: "dev", what: "DevPerfHost · Perf monitor" },

  // --- embed — Viewers: PDF, TeX, decks, tables ---------------------
  "bibCards.1": { area: "embed", what: "BibCards · ＋ entry" },
  "compareView.1": { area: "embed", what: "CompareView · Select a commit" },
  "deckView.presentationTitle": { area: "embed", what: "DeckView · Presentation" },
  "fileViewer.autocompleteLabel": { area: "embed", what: "FileViewerPane · Autocomplete" },
  "fileViewer.beamerToggle": { area: "embed", what: "FileViewerPane · Beamer" },
  "fileViewer.compileUnchangedMsg": { area: "embed", what: "FileViewerPane · Nothing changed since the last build — every source on disk still matches the previous ru…" },
  "fileViewer.texPreviewLabel": { area: "embed", what: "FileViewerPane · Preview" },
  "fileViewerPane.1": { area: "embed", what: "FileViewerPane · Interactive session…" },
  "fileViewerPane.2": { area: "embed", what: "FileViewerPane · Add file remark…" },
  "fileViewerPane.3": { area: "embed", what: "FileViewerPane · Remote images not loaded ({count}) · {hosts}" },
  "fileViewerPane.4": { area: "embed", what: "FileViewerPane · Structure" },
  "fileViewerPane.5": { area: "embed", what: "FileViewerPane · {name} doesn't exist yet." },
  "fileViewerPane.6": { area: "embed", what: "FileViewerPane · Browse…" },
  "fileViewerPane.7": { area: "embed", what: "FileViewerPane · Copy this error" },
  "fileViewerPane.8": { area: "embed", what: "FileViewerPane · Copy the whole compilation log" },
  "mdGraph.back": { area: "embed", what: "MarkdownView · Back to graph" },
  "mdGraph.zoom": { area: "embed", what: "MdGraphView · Zoom, pan, and markdown hover previews" },
  "pdfLinkDialog.1": { area: "embed", what: "PdfLinkDialog · Open this link?" },
  "pdfNoteLayer.1": { area: "embed", what: "PdfNoteLayer · Add remark here" },
  "pdfNotesPane.1": { area: "embed", what: "PdfNotesPane · Remarks" },
  "pdfSelectionBar.1": { area: "embed", what: "PdfSelectionBar · Copied" },
  "pdfViewer.1": { area: "embed", what: "PdfViewer · Contents" },
  "pdfViewer.2": { area: "embed", what: "PdfViewer · Back" },
  "pdfViewer.3": { area: "embed", what: "PdfViewer · Black out text" },
  "pdfViewer.4": { area: "embed", what: "PdfViewer · Remarks in this document" },
  "pdfViewer.5": { area: "embed", what: "PdfViewer · Metadata" },
  "pdfViewer.6": { area: "embed", what: "PdfViewer · {n} remarks on {pages} pages" },
  "pdfViewer.7": { area: "embed", what: "PdfViewer · Fullscreen" },
  "pdfViewer.8": { area: "embed", what: "PdfViewer · Capturing…" },
  "pdfViewer.printLabel": { area: "embed", what: "PdfViewer · Print the real PDF through the system print UI (Linux GTK, Windows WebView2, macOS PDFKit)" },
  "presentationOverlay.1": { area: "embed", what: "PresentationOverlay · Close presentation tools" },
  "texStructureSidebar.1": { area: "embed", what: "TexStructureSidebar · Structure" },
  "texWorkspace.newFileTitle": { area: "embed", what: "FileViewerPane · Add a file to this document" },
  "yamlGrid.1": { area: "embed", what: "YamlGrid · Card view of an empty YAML document" },
  "yamlGrid.2": { area: "embed", what: "YamlGrid · Card view's breadcrumb bar" },

  // --- files — Project files, tree and git --------------------------
  "fileBrowser.1": { area: "files", what: "FileBrowser · New Presentation" },
  "fileBrowser.2": { area: "files", what: "FileBrowser · New Presentation" },
  "fileTree.1": { area: "files", what: "FileTree · Arguments ($@) — {name}" },
  "fileTree.2": { area: "files", what: "FileTree · New Presentation" },
  "fileTree.3": { area: "files", what: "FileTree · {t(syncExcluded ? \"fileTree.includeInSync\" : \"fileTree.excludeFromSync\")}" },
  "fileTree.4": { area: "files", what: "FileTree · Send to project…" },
  "fileTree.5": { area: "files", what: "FileTree · Download to…" },
  "gitHistory.1": { area: "files", what: "GitHistory · Worktrees" },
  "gitHistory.loadMoreCommits": { area: "files", what: "GitHistory · Load older commits" },
  "gitPull.1": { area: "files", what: "Git · Pull preview (fetch, fast-forward, merge)" },
  "gitMerge.1": { area: "files", what: "Git · Merge-in-progress bar (commit / abort)" },
  "gitMergeView.1": { area: "embed", what: "Git merge view · Incoming diff and conflict resolve" },
  "importDrop.title": { area: "files", what: "importDrop · File already exists" },
  "projectFilesPane.1": { area: "files", what: "ProjectFilesPane · Project settings" },
  "projectFilesPane.2": { area: "files", what: "ProjectFilesPane · Large folders…" },
  "projectFilesView.1": { area: "files", what: "ProjectFilesView · Files" },
  "projectFilesView.2": { area: "files", what: "ProjectFilesView · Remote machines…" },
  "projectFilesView.3": { area: "files", what: "ProjectFilesView · {count} diverged" },
  "projectFilesView.4": { area: "files", what: "ProjectFilesView · {count} new local (not on the host)" },
  "projectFilesView.5": { area: "files", what: "ProjectFilesView · {s.name}" },
  "projectFilesView.6": { area: "files", what: "ProjectFilesView · Side panel, Jobs view" },
  "projectFilesView.7": { area: "files", what: "ProjectFilesView · Side panel, Windows view" },
  "projectRemarks.addMenu": { area: "files", what: "FileTree · Add file remark…" },
  "projectRemarks.addTitle": { area: "files", what: "AddRemarkDialog · Add file remark" },
  "projectSettings.migration": { area: "files", what: "ProjectFilesSettings · Migration" },
  "projectSettings.spellAddLanguage": { area: "files", what: "SpellDictionaryPicker · Add a language" },
  "projectSettings.spellLanguage": { area: "files", what: "SpellDictionaryPicker · Spelling dictionary" },
  "projectSettings.treeGrouping": { area: "files", what: "ProjectFilesSettings · Tree Grouping" },
  "remarksPane.1": { area: "files", what: "RemarksPane · Next remark" },
  "renameDialog.1": { area: "files", what: "RenameDialog · {t(isDir ? \"fileTree.renameFolderTitle\" : \"fileTree.renameFileTitle\")}" },

  // --- header — The header cluster: machines, VPN, dev build --------
  "devBuild.title": { area: "header", what: "DevBuildIndicator · Dev build", tested: "2026-09-20" },
  "devBuild.relaunchNow": { area: "header", what: "DevBuildIndicator · Relaunch now (onto the newer snapshot)" },
  "machinesIndicator.1": { area: "header", what: "MachinesIndicator · Choose which machines to write to a shareable JSON file. Only the host, port and label ar…", tested: "2026-09-20" },
  "machinesIndicator.10": { area: "header", what: "MachinesIndicator · to which project?" },
  "machinesIndicator.11": { area: "header", what: "MachinesIndicator · here — then removes it from the list. Projects it was added to keep their own copy." },
  "machinesIndicator.12": { area: "header", what: "MachinesIndicator · here and disconnects. Can't be undone." },
  "machinesIndicator.13": { area: "header", what: "MachinesIndicator · Save password" },
  "machinesIndicator.14": { area: "header", what: "MachinesIndicator · Save password" },
  "machinesIndicator.15": { area: "header", what: "MachinesIndicator · — off for an HPC cluster" },
  "machinesIndicator.16": { area: "header", what: "MachinesIndicator · HPC cluster (login node)" },
  "machinesIndicator.2": { area: "header", what: "MachinesIndicator · Reading file…" },
  "machinesIndicator.3": { area: "header", what: "MachinesIndicator · Save password" },
  "machinesIndicator.4": { area: "header", what: "MachinesIndicator · Connect on launch & VPN-up" },
  "machinesIndicator.5": { area: "header", what: "MachinesIndicator · Use a row's ⇥ button", tested: "2026-09-20" },
  "machinesIndicator.6": { area: "header", what: "MachinesIndicator · on every connected machine and disconnects them. Can't be undone." },
  "machines.utilAria": { area: "header", what: "MachinesIndicator · inline CPU/GPU utilization bars on Detailed machines" },
  "machinesIndicator.7": { area: "header", what: "MachinesIndicator · Remote host usage — check who's logged in and what's running on every machine here: CPU, …" },
  "machinesIndicator.8": { area: "header", what: "MachinesIndicator · — off while tagged HPC" },
  "machinesIndicator.9": { area: "header", what: "MachinesIndicator · HPC cluster (login node)" },
  "vpnIndicator.saveLoginCredentialsLabel": { area: "header", what: "VpnIndicator · Save login credentials", tested: "2026-09-20" },
  "vpnIndicator.unlockKeyring": { area: "header", what: "VpnIndicator · Unlock keyring", tested: "2026-09-20" },

  // --- layout — Settings, root console, menus, theming --------------
  "agentCron.title": { area: "layout", what: "SettingsSubPanels · Scheduled warm-up" },
  "agentSchedule.menu": { area: "layout", what: "DetachedCenterPanel · Schedule prompt…" },
  "detachedClose.title": { area: "layout", what: "DetachedCloseChoice · Close this window?" },
  "lessons.intro": { area: "layout", what: "LessonsMenu · Short guided walkthroughs for common tasks. Pick one — it points things out step by step,…" },
  "localModel.igpuDropped": { area: "layout", what: "LocalModelMenu · A model is loaded, but none of it is on the GPU. This Ollama version drops integrated GPU…" },
  "localModel.skillsLibrary": { area: "layout", what: "LocalModelMenu · Skills library…" },
  "localModelMenu.1": { area: "layout", what: "LocalModelMenu · MCP", tested: "2026-09-20" },
  "localModelMenu.2": { area: "layout", what: "LocalModelMenu · Dismiss this notice" },
  "localModelMenu.3": { area: "layout", what: "LocalModelMenu · Dismiss this notice" },
  "localModelMenu.4": { area: "layout", what: "LocalModelMenu · MCP", tested: "2026-09-20" },
  "mcpSecurity.title": { area: "layout", what: "RootMcpSecurity · MCP session access" },
  "mcpSecurity.audit": { area: "layout", what: "RootMcpSecurity · audit table with reason/target columns, unauthenticated rows, live refresh on session events, tab titles, revoke confirm" },
  "nav.scaffoldRepair.title": { area: "layout", what: "SettingsPanel · Repair Project Scaffold" },
  "nav.updates.title": { area: "layout", what: "UpdatesPanel · Updates" },
  "ollama.autostartTitle": { area: "layout", what: "SettingsSubPanels · Load on Eldrun start" },
  "ollama.modelLocationTitle": { area: "layout", what: "SettingsSubPanels · Model download location" },
  "projectSwitcher.addProjectsToBox": { area: "layout", what: "ProjectSwitcher · Add projects to Box" },
  "projectSwitcher.hpcPipeline": { area: "layout", what: "ProjectSwitcher · HPC pipeline…" },
  "projectSwitcher.newBox": { area: "layout", what: "ProjectSwitcher · New Box" },
  "overlayApprovals.button": { area: "layout", what: "OverlayApprovals · ✓ Approvals in the mail / calendar / to-do title bars" },
  "rootOverlay.viewers": { area: "layout", what: "RootOverlay · viewers, Files tabs and links opened in the console stay in root" },
  "rootOverlay.1": { area: "layout", what: "RootOverlay · ⚿ Eldrun tools + ✓ Approvals" },
  "rootReview.icsImport": { area: "layout", what: "RootReviewStrip · Calendar file staged by calendar_import_ics" },
  "rootReview.setting": { area: "layout", what: "SettingsPanel · Review root-agent writes" },
  "rootReview.title": { area: "layout", what: "RootReviewStrip · Agent proposals" },
  "screenshotSave.title": { area: "layout", what: "ScreenshotSaveOverlay · Save screenshot" },
  "settings.agentFenceCargoCredentials": { area: "layout", what: "SettingsSubPanels · Allow Cargo registry credential files" },
  "settings.agentFenceTitle": { area: "layout", what: "SettingsSubPanels · Agent fence" },
  "settings.browser": { area: "layout", what: "SettingsPanel · Browser" },
  "settings.calendarGlobalApp": { area: "layout", what: "SettingsPanel · Calendar in the header" },
  "settings.copilotCompletion": { area: "layout", what: "SettingsPanel · GitHub Copilot autocomplete" },
  "settings.corners": { area: "layout", what: "ThemeCustomizer · Corners" },
  "settings.cursor": { area: "layout", what: "ThemeCustomizer · Mouse cursor" },
  "settings.fastMode": { area: "layout", what: "SettingsPanel · Fast mode" },
  "settings.language": { area: "layout", what: "SettingsPanel · Language" },
  "settings.layout": { area: "layout", what: "SettingsPanel · Layout" },
  "settings.mailClient": { area: "layout", what: "SettingsPanel · Mail client" },
  "settings.mdGraph": { area: "layout", what: "SettingsPanel · Markdown link graph" },
  "settings.projectRemarks": { area: "layout", what: "SettingsPanel · Project file remarks" },
  "settings.rootMcp": { area: "layout", what: "SettingsPanel · Eldrun's tools (MCP) for root-console agents" },
  "scheduleMcp": { area: "agents", what: "Schedule MCP · local agent proposals, approval, quotas and delivery" },
  "settings.rootMcpLocalOnly": { area: "layout", what: "SettingsPanel · Only local models get these tools" },
  "settings.rootMcpMail": { area: "layout", what: "SettingsPanel · Agents get Eldrun's mail tools" },
  "settings.rootMcpMailLocalOnly": { area: "layout", what: "SettingsPanel · Only local models get the mail tools" },
  "settings.rootMcpMailLocalRead": { area: "layout", what: "SettingsPanel · Local models may read the mails you share (marked only, loopback Ollama, writes staged after a read)" },
  "settings.takeAdvancedTour": { area: "layout", what: "SettingsPanel · Advanced tour" },
  "settings.terminalWebgl": { area: "layout", what: "SettingsPanel · WebGL terminal renderer" },
  "settings.themeVars": { area: "layout", what: "SettingsPanel · Theme colors" },
  "settings.todoBoard": { area: "layout", what: "SettingsPanel · To-do board button in the header" },
  "settings.workspaceNoParking": { area: "layout", what: "SettingsPanel · This desktop can't hide other apps' windows, so switching projects leaves them on screen.…" },
  "settingsSubPanels.1": { area: "layout", what: "SettingsSubPanels · not detected" },
  "settingsSubPanels.2": { area: "layout", what: "SettingsSubPanels · Prompt composer" },
  "settingsSubPanels.3": { area: "layout", what: "SettingsSubPanels · Re-check version" },
  "settingsSubPanels.4": { area: "layout", what: "SettingsSubPanels · Install in a terminal" },
  "shortcutHelp.title": { area: "layout", what: "ShortcutHelpOverlay · Keyboard Shortcuts" },
  "statusCluster.settingLabel": { area: "layout", what: "SettingsPanel · Collapse header status indicators" },
  "theme.presets": { area: "layout", what: "ThemeCustomizer · Saved themes" },
  "theme.title": { area: "layout", what: "ThemeCustomizer · Theme colors" },
  "themeCustomizer.1": { area: "layout", what: "ThemeCustomizer · Top-bar and sub-window color groups" },
  "vpnPrompt.logInTerminal": { area: "layout", what: "VpnPasswordPrompt · Log in in terminal" },

  // --- lib — Keyboard shortcuts and printing ------------------------
  "print.copiesField": { area: "lib", what: "print · Copies field in the print dialog" },
  "print.queueProgress": { area: "lib", what: "print · Print queue progress strip" },
  "shortcut.cycleProjectBack": { area: "lib", what: "shortcuts · Cycle to previous project" },
  "shortcut.cycleBox": { area: "lib", what: "shortcuts · Cycle to next box" },
  "shortcut.cycleBoxBack": { area: "lib", what: "shortcuts · Cycle to previous box" },
  "shortcut.rootConsole": { area: "lib", what: "shortcuts · Open / close the root console" },
  "shortcut.shortcutHelp": { area: "lib", what: "shortcuts · Open shortcut help" },
  "shortcut.steeringMode": { area: "lib", what: "shortcuts · Enter keyboard steering mode" },
  "shortcut.texBack": { area: "lib", what: "shortcuts · TeX workspace: back to the previous file" },
  "shortcut.texCompile": { area: "lib", what: "shortcuts · TeX workspace: save and compile the document" },
  "shortcut.texUp": { area: "lib", what: "shortcuts · TeX workspace: up to the parent document" },
  "shortcut.menuHints": { area: "lib", what: "shortcuts · Menu rows show their chord (root console, shortcuts, tab close / close all, file Delete)" },

  // --- mail — The mail client ---------------------------------------
  "mail.accountDialogNew": { area: "mail", what: "MailAccountDialog · Add mail account" },
  "mail.agentDrafts": { area: "mail", what: "MailPane · Drafted by agents" },
  "mail.agentScope": { area: "mail", what: "MailAccountDialog · Agent access: off / marked messages only / whole account" },
  "mail.encryption.title": { area: "mail", what: "MailEncryptionDialog · Local mail encryption" },
  "mail.filters.title": { area: "mail", what: "MailFiltersDialog · Mail filters" },
  "mail.keys.title": { area: "mail", what: "MailKeysDialog · OpenPGP keys" },
  "mail.overlayTitle": { area: "mail", what: "MailOverlay · Mail" },
  "mail.overlayTabs": { area: "mail", what: "MailOverlay · Inbox / message / unsent-mail tabs" },
  "mailAi.notesLabel": { area: "mail", what: "MailComposeDialog · Notes for a drafted reply" },
  "mailAi.settingsTitle": { area: "mail", what: "MailAiSettings · Mail AI (local)" },
  "mailAi.settingsTitle#2": { area: "mail", what: "MailAiSettingsDialog · Mail AI (local)" },
  "mailAiMessageActions.1": { area: "mail", what: "MailAiMessageActions · Reading…" },
  "mailAiSettings.1": { area: "mail", what: "MailAiSettings · Local model — what it would mark" },
  "mailComposeDialog.1": { area: "mail", what: "MailComposeDialog · New message" },
  "mailList.1": { area: "mail", what: "MailList · From" },
  "mailList.2": { area: "mail", what: "MailList · {count} messages selected" },
  "mailList.3": { area: "mail", what: "MailList · Move to Important" },
  "mailList.4": { area: "mail", what: "MailList · Move to Urgent" },
  "mailList.5": { area: "mail", what: "MailList · Remove from the list" },
  "mailList.6": { area: "mail", what: "MailList · Move to Trash" },
  "mailList.7": { area: "mail", what: "MailList · Share with agents" },
  "mailList.8": { area: "mail", what: "MailList · Stop sharing with agents" },
  "mailList.9": { area: "mail", what: "MailList · Share everything from {address}" },
  "mailList.10": { area: "mail", what: "MailList · Share this whole folder" },
  "mailList.11": { area: "mail", what: "MailList · Shared (filter chip)" },
  "mailList.12": { area: "mail", what: "MailList · Server search scope note" },
  "mailMessageView.1": { area: "mail", what: "MailMessageView · SPF/DKIM headline on a message" },
  "mailMessageView.2": { area: "mail", what: "MailMessageView · Sender checks" },
  "mailMessageView.3": { area: "mail", what: "MailMessageView · Save attachment" },
  "mailMessageView.4": { area: "mail", what: "MailMessageView · Your replies to this message" },
  "mailMessageView.5": { area: "mail", what: "MailMessageView · Share with agents / Stop sharing" },
  "mailPane.1": { area: "mail", what: "MailPane · Empty this list ({count})" },
  "mailPdfPreview.1": { area: "mail", what: "MailPdfPreview · PDF, {count} pages" },

  // --- mobile — The phone PWA ---------------------------------------
  "mobile.boxAccess": { area: "mobile", what: "MobileSettings · Box access" },
  "mobile.focus.messageMenu": { area: "mobile", what: "Terminal · Reader click-hold menu on a chat message (copy, read aloud)" },
  "mobile.focus.onScreen": { area: "mobile", what: "Terminal · Reader on-screen transcript note" },
  "mobile.focus.readAloud": { area: "mobile", what: "Terminal · Reader auto-read toggle" },
  "mobile.focus.session": { area: "mobile", what: "Terminal · Reader session card" },
  "mobile.focus.statusLine": { area: "mobile", what: "Terminal · Reader status-line strip" },
  "mobile.focus.workingFacts": { area: "mobile", what: "Terminal · Reader elapsed time and tokens while the agent works" },
  "mobile.model.effort": { area: "mobile", what: "Terminal · Antigravity effort step in the model sheet" },
  "mobile.home.reorder": { area: "mobile", what: "Home · Drag to reorder the project list" },
  "mobile.mailActions": { area: "mobile", what: "MobileSettings · Mark read and star from the phone" },
  "mobile.mailRead": { area: "mobile", what: "MobileSettings · Read mail on the phone" },
  "mobile.mailReply": { area: "mobile", what: "MobileSettings · Reply from the phone" },
  "mobile.rootAccess": { area: "mobile", what: "MobileSettings · Root console on the phone (switch, review gate, pending count on the phone's row)" },
  "mobile.outbox.gallery": { area: "mobile", what: "OutboxGallery · Files the agent sent to the phone, Save on every tile" },
  "mobile.project.newTab": { area: "mobile", what: "NewTabSheet · The header's ＋ opens a shell or an agent" },
  "mobile.project.outbox": { area: "mobile", what: "Project · Shelf under the tab cards for the files the desktop sent (eldrun-send), with the header's picture button and the shelf's button on the whole gallery" },
  "mobile.project.reorder": { area: "mobile", what: "Project · Drag to reorder the desktop's tabs" },
  "mobile.project.modelTap": { area: "mobile", what: "Project · Tap a tab card's model to open the session with its model picker up" },
  "inbox.menuTitle": { area: "mobile", what: "InboxIndicator · Sent from your phone (global inbox)" },
  "mobile.home.sendToDesktop": { area: "mobile", what: "Home · Send a file to the desktop (global inbox)" },
  "mobile.setupTitle": { area: "mobile", what: "MobileSetupGuide · Set up Eldrun Mobile" },
  "mobile.speech.language": { area: "mobile", what: "Terminal · Reader voice-language picker" },
  "mobile.voice.keepListening": { area: "mobile", what: "Terminal · Dictation keeps listening through pauses, holds the screen awake, shows the mic level" },
  "mobile.voice.remote": { area: "mobile", what: "Terminal · Reader toggle: dictate with the phone's speech service instead of on-device" },
  "mobile.windowsTerminalsNote": { area: "mobile", what: "MobileSettings · On Windows the phone cannot open this computer's terminals or agent tabs: they attach thr…" },

  // --- monitoring — System monitor ----------------------------------
  "systemMonitorPane.1": { area: "monitoring", what: "SystemMonitorPane · Logged in" },
  "systemMonitorPane.2": { area: "monitoring", what: "SystemMonitorPane · By user" },

  // --- printing — Print manager -------------------------------------
  "printing.title": { area: "printing", what: "PrintManagerPane · Print Manager" },
  "printing.networkSet": { area: "printing", what: "PrintManagerPane · Default on this network (per-network default printer)" },
  "printing.networkDefaults": { area: "printing", what: "PrintManagerPane · Default printer per network list + auto-apply on network change" },

  // --- projects — Projects, remotes, boxes, VMs ---------------------
  "bigFolder.thisProject": { area: "projects", what: "BigFolderExcludeDialog · this project" },
  "boxEditor.title": { area: "projects", what: "BoxEditorDialog · Box editor" },
  "boxPill.membersGroup": { area: "projects", what: "BoxScopeChip · Per-box pills beside the chip (coloured, drop targets) + the box pill menu's Members checklist + member swatches on project pills" },
  "boxPill.colorGroup": { area: "projects", what: "BoxColorPicker · Box pill menu Colour row (palette, automatic, custom colour input)" },
  "boxChip.onRowLabel": { area: "projects", what: "BoxScopeChip · Dropdown checkboxes choosing which boxes get a pill on the row" },
  "carefulHost.label": { area: "projects", what: "CarefulHostToggle · Go easy on this machine" },
  "credentialPasteBar.1": { area: "projects", what: "CredentialPasteBar · ))}" },
  "extendToRemoteDialog.1": { area: "projects", what: "ExtendToRemoteDialog · Your machines" },
  "hpcHost.label": { area: "projects", what: "HpcHostToggle · HPC cluster (login node)" },
  "hpcWizard.title": { area: "projects", what: "HpcPipelineWizard · HPC pipeline" },
  "migrate.title": { area: "projects", what: "ProjectMigrationDialog · Migrate project" },
  "pill.alsoRenameFolder": { area: "projects", what: "ProjectPill · Also rename the project folder" },
  "pill.containerScopeLegend": { area: "projects", what: "ProjectPill · What runs in the container" },
  "pill.forgetProjectEllipsis": { area: "projects", what: "ProjectPill · Remove from Eldrun…" },
  "pill.publishFrom": { area: "projects", what: "ProjectPill · Publish from" },
  "pill.publishFrom#2": { area: "projects", what: "ProjectPill · Publish from" },
  "pill.vmMailReader": { area: "projects", what: "VmSettingsDialog · Mail reader" },
  "pill.vmSettingsTitle": { area: "projects", what: "VmSettingsDialog · VM — {name}" },
  "projectDialog.1": { area: "projects", what: "ProjectDialog · remote. Forking runs through the provider's CLI (" },
  "projectDialog.2": { area: "projects", what: "ProjectDialog · Filled in from the repository you are cloning: {provider}. It could not be told whether t…" },
  "projectDialog.3": { area: "projects", what: "ProjectDialog · The repository is created on {provider} and the first commit pushed as soon as the projec…" },
  "projectDialog.4": { area: "projects", what: "ProjectDialog · Inside a virtual machine (strongest isolation)" },
  "projectPill.1": { area: "projects", what: "ProjectPill · Move project…" },
  "projectPill.10": { area: "projects", what: "ProjectPill · Unpublish (keep repo)…" },
  "projectPill.11": { area: "projects", what: "ProjectPill · Git hosting…" },
  "projectPill.12": { area: "projects", what: "ProjectPill · Publish to GitHub / GitLab…" },
  "projectPill.13": { area: "projects", what: "ProjectPill · VM settings…" },
  "projectPill.14": { area: "projects", what: "ProjectPill · — not enforced: {reason}" },
  "projectPill.15": { area: "projects", what: "ProjectPill · Install bubblewrap…" },
  "projectPill.16": { area: "projects", what: "ProjectPill · Remote machines…" },
  "projectPill.17": { area: "projects", what: "ProjectPill · Restore layout saved in the folder…" },
  "projectPill.2": { area: "projects", what: "ProjectPill · Categories…" },
  "projectPill.3": { area: "projects", what: "ProjectPill · Repair scaffold files" },
  "projectPill.4": { area: "projects", what: "ProjectPill · Box these ({count})…" },
  "projectPill.5": { area: "projects", what: "ProjectPill · New box with {name}…" },
  "projectPill.6": { area: "projects", what: "ProjectPill · Edit boxes…" },
  "projectPill.7": { area: "projects", what: "ProjectPill · Enable git (git init)" },
  "projectPill.8": { area: "projects", what: "ProjectPill · Make private…" },
  "projectPill.9": { area: "projects", what: "ProjectPill · Move to GitHub…" },
  "projectPill.openInIde": { area: "projects", what: "ProjectPill / FileTree · Open in <IDE>" },
  "remoteConnectDialog.1": { area: "projects", what: "RemoteConnectDialog · Name" },
  "remoteConnectDialog.2": { area: "projects", what: "RemoteConnectDialog · Machine name" },
  "remoteConnectDialog.3": { area: "projects", what: "RemoteConnectDialog · Username" },
  "remoteConnectDialog.4": { area: "projects", what: "RemoteConnectDialog · — off while tagged HPC" },
  "remoteConnectDialog.5": { area: "projects", what: "RemoteConnectDialog · Disconnect & end jobs" },
  "remoteMachinesWindow.1": { area: "projects", what: "RemoteMachinesWindow · Primary" },
  "remoteMachinesWindow.2": { area: "projects", what: "RemoteMachinesWindow · Your machines" },
  "remoteMachinesWindow.3": { area: "projects", what: "RemoteMachinesWindow · Username" },
  "remoteMachinesWindow.4": { area: "projects", what: "RemoteMachinesWindow · Remote path for this machine's copy" },
  "savePasswordRow.1": { area: "projects", what: "SavePasswordRow · A terminal login is one Eldrun never sees, so it stores nothing new — and deletes nothing…" },
  "terminalSignIn.label": { area: "projects", what: "TerminalSignInToggle · Sign in in a terminal" },
  "transfer.export": { area: "projects", what: "ProjectExportDialog · Export project…" },
  "transfer.import": { area: "projects", what: "ProjectImportBundleDialog · Import project file…" },

  // --- skills — The skills library ----------------------------------
  "skillsLibrary.overlayTitle": { area: "skills", what: "SkillsOverlay · Skills Library" },

  // --- tabs — Tabs and the new-tab menus ----------------------------
  "agentWorktrees.1": { area: "tabs", what: "agentWorktrees · Which worktree to open a tab on" },
  "localModelGroup.1": { area: "tabs", what: "localModelGroup · Load the local model on the GPU" },
  "newTabMenu.boxMemberAgent": { area: "tabs", what: "TabBar · Claude — {name}" },
  "newTabMenu.boxMemberFiles": { area: "tabs", what: "NewTabMenu · Files — {name}" },
  "newTabMenu.boxMemberFiles#2": { area: "tabs", what: "TabBar · Files — {name}" },
  "newTabMenu.boxMemberShell": { area: "tabs", what: "NewTabMenu · Shell — {name}" },
  "newTabMenu.boxMemberShell#2": { area: "tabs", what: "TabBar · Shell — {name}" },
  "newTabMenu.browser": { area: "tabs", what: "NewTabMenu · Browser" },
  "newTabMenu.browser#2": { area: "tabs", what: "TabBar · Browser" },
  "newTabMenu.itemProjects3d#root": { area: "tabs", what: "NewTabMenu · 3D project cloud (root console)" },
  "newTabMenu.itemNetworkTraffic": { area: "tabs", what: "NewTabMenu · Network Traffic (root scope / popout)" },
  "newTabMenu.itemSystemMonitor": { area: "tabs", what: "NewTabMenu · System Monitor (root scope / popout)" },
  "printing.title#2": { area: "tabs", what: "NewTabMenu · Print Manager" },
  "printing.title#3": { area: "tabs", what: "TabBar · Print Manager" },
  "promptChart.heading#2": { area: "tabs", what: "NewTabMenu · Prompt chart" },
  "promptChart.heading#3": { area: "tabs", what: "TabBar · Prompt chart" },
  "skillsLibrary.title": { area: "tabs", what: "NewTabMenu · Skills Library" },
  "skillsLibrary.title#2": { area: "tabs", what: "TabBar · Skills Library" },
  "tabBar.1": { area: "tabs", what: "TabBar · Duplicate tab" },
  "tabBar.2": { area: "tabs", what: "TabBar · Schedule prompt…" },
  "tabColor.menu": { area: "tabs", what: "TabColorPicker · Colour" },
  "tabLocalityBadges.1": { area: "tabs", what: "TabLocalityBadges · Run on machine" },

  // --- todo — The to-do board ---------------------------------------
  "todo.overlayTitle": { area: "todo", what: "TodoOverlay · To-do board" },
} as const satisfies Record<string, UntestedEntry>;

/** Every id the register knows. A call site can only pass one of these. */
export type UntestedId = keyof typeof UNTESTED;

/**
 * Does this feature still wear the pill?
 *
 * Unknown ids answer `true` on purpose: a pill that outlives its row is loud
 * and gets noticed, where a silently hidden one would quietly claim a feature
 * was verified. The registry test catches the case either way.
 */
export function isUntested(id: UntestedId | string | undefined | null | false): boolean {
  if (!id) return false;
  const entry = (UNTESTED as Record<string, UntestedEntry>)[id];
  return entry ? !entry.tested : true;
}

/** The register as a plain list — `scripts/untested.mjs` and the settings
 *  panel read it this way rather than re-deriving the key order. */
export function untestedEntries(): (UntestedEntry & { id: string })[] {
  return Object.entries(UNTESTED as Record<string, UntestedEntry>).map(([id, e]) => ({ id, ...e }));
}
