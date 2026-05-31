# ProjectEldrun - Feature Checklist

This file is a manual verification matrix built from `TODO.md`,
`TODO_history.md`, `plan_0.md`, `plan_1.md`, `DOCUMENTATION.md`, the current
`app/` code, tests, and recent commit history.

Use the three checkbox columns during manual QA:

- `Done`: the feature works end to end.
- `Partial`: some part works, but scope is incomplete or unverified.
- `Issue`: a bug, crash, missing behavior, or UX problem was found.

Do not launch a second Eldrun instance from an agent terminal while checking
these items. Runtime checks should be done in the already-running Eldrun
instance or after the user restarts Eldrun.

## Source Snapshot

- Plans: `plan_0.md`, `plan_1.md`, `plan_kde.md` (completed)
- Current/open TODOs: `TODO.md`
- Completed history: `TODO_history.md`
- Documentation: `DOCUMENTATION.md`, `README.md`, `CLAUDE.md`, `AGENTS.md`
- Recent commits: workspace fixes, global app toolbar, screenshot support,
  graceful shutdown, Git hosting, GNOME workspace support, agent tab work,
  project search, time tracking, network monitor, settings, panel polish,
  KDE Plasma backend (X11 + Wayland), crash logging.
- New files: `app/ollama_client.py`, `app/ollama_dialog.py`, `app/app_picker.py`,
  `app/downloads_manager.py`, `app/workspace_core.py`, `app/backends/__init__.py`,
  `app/backends/kde_kwin.py`, `app/backends/cinnamon_x11.py`,
  `app/backends/gnome.py`, `app/backends/null.py`,
  `tests/test_ollama_client.py`, `tests/test_window_layout_logic.py`,
  `tests/test_kde_kwin.py`.
- Major changes since last snapshot: KDE Plasma backend (Phase 6a X11, Phase 6b
  Wayland) adds virtual desktop isolation for KDE 5 and KDE 6 sessions; crash
  logging via `faulthandler` + `sys.excepthook` in `eldrun.py`; `GLib.timeout_add(500,
  ...)` replaces `GLib.idle_add` for `_restore_project_apps()` to fix a GTK4
  frame-clock reentrance crash; 520 tests passing. Version bumped to 0.0.17.

## Grouped Subfeature Checklists

These groups split the large features into smaller checks. Mark each subfeature
independently before marking the broader feature in later sections as done.

### Project Creation, Import, and Persistence

| Group | Subfeature | Code State | Done | Partial | Issue | Manual checks |
|---|---|---:|---|---|---|---|
| New project | Name validation | Implemented | [ ] | [ ] | [ ] | Empty/invalid names are blocked; valid names enable create. |
| New project | Path preview | Implemented | [ ] | [ ] | [ ] | Preview path updates from sanitized project name. |
| New project | Existing path warning | Implemented | [ ] | [ ] | [ ] | Existing destination blocks or warns before create. |
| New project | Directory creation | Implemented | [ ] | [ ] | [ ] | Project directory is created under managed project root. |
| New project | Git init | Implemented | [ ] | [ ] | [ ] | New project has `.git/` and initial scaffold commit. |
| New project | Scaffold files | Implemented | [ ] | [ ] | [ ] | Required scaffold files exist after create. |
| New project | Registry update | Implemented | [ ] | [ ] | [ ] | Project appears in `projects.json` and bottom bar. |
| New project | Terminal activation | Implemented | [ ] | [ ] | [ ] | Newly created project opens its terminal immediately. |
| Import | Folder chooser | Implemented | [ ] | [ ] | [ ] | Folder chooser selects source directory. |
| Import | Name prefill | Implemented | [ ] | [ ] | [ ] | Project name starts from selected folder name. |
| Import | Destination preview | Implemented | [ ] | [ ] | [ ] | Preview updates with name/mode. |
| Import | Scaffold gap-fill | Implemented | [ ] | [ ] | [ ] | Missing scaffold files are created without overwriting unrelated files. |
| Import | Registry update | Implemented | [ ] | [ ] | [ ] | Imported project appears in project list and persists. |
| Import | Data safety | Implemented | [ ] | [ ] | [ ] | Import does not delete or corrupt the source project. |
| Persistence | Global index ownership | Implemented | [ ] | [ ] | [ ] | Status/position stay in global index. |
| Persistence | Local metadata ownership | Implemented | [ ] | [ ] | [ ] | Project-local state stays in `project.json`. |
| Persistence | Restart restore | Implemented | [ ] | [ ] | [ ] | Active/current projects reload correctly after restart. |

### Agents, Tabs, and Tasks

| Group | Subfeature | Code State | Done | Partial | Issue | Manual checks |
|---|---|---:|---|---|---|---|
| Default terminal | Root terminal cwd | Implemented | [ ] | [ ] | [ ] | Root terminal starts in `~/eldrun/root/`. |
| Default terminal | Project terminal cwd | Implemented | [ ] | [ ] | [ ] | Project terminal starts in active project directory. |
| Default terminal | Agent command setting | Implemented | [ ] | [ ] | [ ] | Default command follows Settings (`claude`/`codex`). |
| Default terminal | Missing command fallback | Implemented | [ ] | [ ] | [ ] | Missing command falls back to shell. |
| Default terminal | Respawn on exit | Implemented | [ ] | [ ] | [ ] | Closing terminal child respawns it. |
| Tab bar | Header placement | Implemented | [ ] | [ ] | [ ] | Tab strip is in header center and remains visible. |
| Tab bar | Add Claude/Codex | Implemented | [ ] | [ ] | [ ] | Right-click tab bar adds selected CLI agent. |
| Tab bar | Add shell terminal | Implemented | [ ] | [ ] | [ ] | Right-click tab bar adds plain terminal tab. |
| Tab bar | Rename tab | Implemented | [ ] | [ ] | [ ] | Right-click tab can rename. |
| Tab bar | Close tab | Implemented | [ ] | [ ] | [ ] | Close button terminates/removes tab. |
| Tab bar | Empty state | Implemented | [ ] | [ ] | [ ] | Closing all tabs shows no-terminal state. |
| Tab bar | Number reuse | Implemented | [ ] | [ ] | [ ] | Closing numbered tab lets next tab reuse lowest available number. |
| Tab bar | Drag reorder | Implemented | [ ] | [ ] | [ ] | Dragging tabs changes order without losing active page. |
| Tasks | Manual set task | Implemented | [ ] | [ ] | [ ] | Right-click tab -> Set task stores normalized title. |
| Tasks | Mark done | Implemented | [ ] | [ ] | [ ] | Mark done changes status and tooltip. |
| Tasks | Clear task | Implemented | [ ] | [ ] | [ ] | Clear removes task from UI and project metadata. |
| Tasks | Tooltip preview | Implemented | [ ] | [ ] | [ ] | Hover shows status, preview, and updated timestamp. |
| Tasks | Project persistence | Implemented | [ ] | [ ] | [ ] | Tasks persist in `project.json["agent_tasks"]`. |
| Tasks | New-agent prompt field | Implemented | [ ] | [ ] | [ ] | Optional task field appears in New agent popover. |
| Tasks | Prompt feeds CLI agent | Implemented | [ ] | [ ] | [ ] | Task text is sent into new Claude/Codex terminal. |
| Local model tab flow | Model list loading | Implemented | [ ] | [ ] | [ ] | Ollama models appear when `/api/tags` works. |
| Local model tab flow | Dialog launch | Implemented | [ ] | [ ] | [ ] | Selecting local model opens Ollama dialog with prompt/model. |

### Ollama and Local AI

| Group | Subfeature | Code State | Done | Partial | Issue | Manual checks |
|---|---|---:|---|---|---|---|
| Client | Host setting lookup | Implemented | [ ] | [ ] | [ ] | Requests use configured `ollama_host`. |
| Client | Model setting lookup | Implemented | [ ] | [ ] | [ ] | Requests use configured default model when none passed. |
| Client | Streaming chunks | Implemented | [ ] | [ ] | [ ] | Response chunks append in order. |
| Client | Done callback | Implemented | [ ] | [ ] | [ ] | Done callback fires when stream completes. |
| Client | Error callback | Implemented | [ ] | [ ] | [ ] | Connection failure shows error instead of crashing. |
| Model discovery | `/api/tags` request | Implemented | [ ] | [ ] | [ ] | Local model names are fetched from Ollama. |
| Model discovery | Failure fallback | Implemented | [ ] | [ ] | [ ] | Failed discovery returns empty list and does not block UI. |
| Dialog | Initial prompt | Implemented | [ ] | [ ] | [ ] | Dialog opens with provided prompt text. |
| Dialog | Explicit model | Implemented | [ ] | [ ] | [ ] | Dialog title/request use selected local model. |
| Dialog | Send button | Implemented | [ ] | [ ] | [ ] | Send starts stream and disables duplicate sends. |
| Dialog | Spinner state | Implemented | [ ] | [ ] | [ ] | Spinner runs while request streams and stops after done/error. |
| Dialog | Response view | Implemented | [ ] | [ ] | [ ] | Streamed text appears in response area. |
| Dialog | Escape close | Implemented | [ ] | [ ] | [ ] | Escape closes dialog. |
| Entry points | Ctrl+K | Implemented | [ ] | [ ] | [ ] | `Ctrl+K` opens Ollama dialog. |
| Entry points | Center inline bar | Implemented | [ ] | [ ] | [ ] | Center prompt opens dialog and clears entry. |
| Entry points | File-tree action | Implemented | [ ] | [ ] | [ ] | File context action opens file-focused prompt. |
| Settings | Host field | Implemented | [ ] | [ ] | [ ] | Host entry persists on Enter/focus leave. |
| Settings | Model field | Implemented | [ ] | [ ] | [ ] | Model entry persists on Enter/focus leave. |
| Settings | Autostart switch | Partial | [ ] | [ ] | [ ] | Toggle persists; daemon startup/cleanup still needs manual verification. |
| Missing AI roadmap | Privacy label | Not implemented | [ ] | [ ] | [ ] | No visible local/private label yet. |
| Missing AI roadmap | Terminal hints | Not implemented | [ ] | [ ] | [ ] | No scrollback hint strip yet. |
| Missing AI roadmap | Semantic search | Not implemented | [ ] | [ ] | [ ] | No embedding-ranked project search yet. |
| Missing AI roadmap | Startup suggestions | Not implemented | [ ] | [ ] | [ ] | No suggested projects on startup yet. |

### File Tree, File Actions, and Open Apps

| Group | Subfeature | Code State | Done | Partial | Issue | Manual checks |
|---|---|---:|---|---|---|---|
| File tree | Project switch rebuild | Implemented | [ ] | [ ] | [ ] | Tree changes to selected project. |
| File tree | Periodic refresh | Implemented | [ ] | [ ] | [ ] | External changes appear after timer. |
| File tree | Folder-first sort | Implemented | [ ] | [ ] | [ ] | Directories appear before files. |
| File tree | Hidden-file toggle | Implemented | [ ] | [ ] | [ ] | Hidden files show/hide correctly. |
| File tree | Scaffold-file toggle | Implemented | [ ] | [ ] | [ ] | Project scaffold files show/hide correctly. |
| File tree | Internal file exclusion | Implemented | [ ] | [ ] | [ ] | `.git`, project metadata, and color files stay hidden. |
| File tree | Long-name hover scroll | Implemented | [ ] | [ ] | [ ] | Long names are readable without layout breakage. |
| File actions | Folder expand/collapse | Implemented | [ ] | [ ] | [ ] | Double-click folder toggles expansion. |
| File actions | Open default app | Implemented | [ ] | [ ] | [ ] | Double-click file opens with resolved app. |
| File actions | Open With dialog | Implemented | [ ] | [ ] | [ ] | Manual app selection works. |
| File actions | Save project default | Implemented | [ ] | [ ] | [ ] | Selected app can become project default. |
| File actions | Save global default | Implemented | [ ] | [ ] | [ ] | Selected app can become global default. |
| File actions | New file | Implemented | [ ] | [ ] | [ ] | Context menu creates file in expected folder. |
| File actions | New folder | Implemented | [ ] | [ ] | [ ] | Context menu creates folder in expected folder. |
| File actions | Copy path | Implemented | [ ] | [ ] | [ ] | Clipboard receives selected path. |
| File actions | Reveal in file manager | Implemented | [ ] | [ ] | [ ] | File manager opens selected path/folder. |
| File actions | Rename | Implemented | [ ] | [ ] | [ ] | Rename updates filesystem and tree. |
| File actions | Delete | Implemented | [ ] | [ ] | [ ] | Delete asks confirmation and removes file/folder. |
| File actions | Properties | Implemented | [ ] | [ ] | [ ] | Properties dialog shows useful metadata. |
| Color labels | Pick color | Implemented | [ ] | [ ] | [ ] | File/folder color can be set. |
| Color labels | Persist color | Implemented | [ ] | [ ] | [ ] | Color remains after refresh/restart. |
| Color labels | Reset color | Implemented | [ ] | [ ] | [ ] | Reset removes saved color. |
| Open apps | Standalone tracking UI | Partial | [ ] | [ ] | [ ] | Open windows section shows standalone windows where available. |
| Open apps | Project cwd scoping | Not implemented | [ ] | [ ] | [ ] | TODO G4.4 still needs complete verification/implementation. |
| Open apps | Mode field | Not implemented | [ ] | [ ] | [ ] | TODO G4.1: no complete `"mode": "standalone"` policy. |
| Open apps | Restore standalone | Not implemented | [ ] | [ ] | [ ] | TODO G4.6: restore path incomplete. |
| Embedding | Center embed target | Partial / removed | [ ] | [ ] | [ ] | Plan 1 says embedding pipeline needs staged rewrite. |
| Embedding | Retry/recovery | Not implemented | [ ] | [ ] | [ ] | TODO G4.8: robust retry/fallback not complete. |

### Global Apps, Screenshots, and URI Routing

| Group | Subfeature | Code State | Done | Partial | Issue | Manual checks |
|---|---|---:|---|---|---|---|
| Registry | Role schema | Implemented | [ ] | [ ] | [ ] | Each role has `exec` and `visible`. |
| Registry | Missing exec defaults | Implemented | [ ] | [ ] | [ ] | Missing roles default visible with no command. |
| Resolution | Browser | Implemented | [ ] | [ ] | [ ] | Browser resolves from system default or fallback. |
| Resolution | Mail | Implemented | [ ] | [ ] | [ ] | Mail resolves from mailto default where available. |
| Resolution | Calendar | Implemented | [ ] | [ ] | [ ] | Calendar resolves from calendar MIME/default where available. |
| Resolution | Utility roles | Implemented | [ ] | [ ] | [ ] | File manager, password manager, monitor, notes, etc. resolve from defaults/PATH. |
| Settings | Visibility checkbox | Implemented | [ ] | [ ] | [ ] | Toggling role immediately updates toolbar. |
| Settings | Exec edit field | Implemented | [ ] | [ ] | [ ] | Editing executable persists. |
| Settings | Browse executable | Implemented | [ ] | [ ] | [ ] | Browse chooses an executable and updates role. |
| Toolbar | Icon button rendering | Implemented | [ ] | [ ] | [ ] | Visible roles render symbolic icon buttons. |
| Toolbar | Unresolved insensitive | Implemented | [ ] | [ ] | [ ] | Visible role without command is greyed out. |
| Launch | Existing window match | Implemented | [ ] | [ ] | [ ] | Matching existing app window is raised. |
| Launch | Fresh process | Implemented | [ ] | [ ] | [ ] | Missing window launches configured executable. |
| Launch | Sticky after found | Implemented | [ ] | [ ] | [ ] | Raised existing global app becomes sticky. |
| Launch | Sticky after launch | Implemented | [ ] | [ ] | [ ] | Newly launched global app becomes sticky. |
| Screenshot | Region capture command | Implemented | [ ] | [ ] | [ ] | Screenshot button invokes supported region capture tool. |
| Screenshot | Active project output | Implemented | [ ] | [ ] | [ ] | Screenshot saves under active project `tmp/screenshots`. |
| Screenshot | Root output | Implemented | [ ] | [ ] | [ ] | Screenshot saves under root screenshots when no project active. |
| Screenshot | Toast | Implemented | [ ] | [ ] | [ ] | Toast shows saved filename. |
| URI routing | HTTP/HTTPS | Not implemented | [ ] | [ ] | [ ] | TODO G6.7: route links through browser role. |
| URI routing | Mailto | Not implemented | [ ] | [ ] | [ ] | TODO G6.7: route mailto through mail role. |
| URI routing | Webcal | Not implemented | [ ] | [ ] | [ ] | TODO G6.7: route webcal through calendar role. |

### Workspaces, Time, Stats, Network, and Downloads

| Group | Subfeature | Code State | Done | Partial | Issue | Manual checks |
|---|---|---:|---|---|---|---|
| Workspaces | Enable setting | Implemented | [ ] | [ ] | [ ] | Toggle persists. |
| Workspaces | Mid-session allocation | Implemented | [ ] | [ ] | [ ] | Enabling creates workspaces for active projects. |
| Workspaces | Project activate switch | Implemented | [ ] | [ ] | [ ] | Activating project switches workspace. |
| Workspaces | Project close release | Implemented | [ ] | [ ] | [ ] | Closing project releases its workspace. |
| Workspaces | Shutdown cleanup | Implemented | [ ] | [ ] | [ ] | Quitting releases managed workspaces. |
| Workspaces | Eldrun sticky | Implemented | [ ] | [ ] | [ ] | Eldrun remains on all workspaces. |
| Workspaces | GNOME path | Implemented | [ ] | [ ] | [ ] | GNOME workspace control works or fails gracefully. |
| Workspaces | Cinnamon path | Implemented | [ ] | [ ] | [ ] | Cinnamon workspace control works or fails gracefully. |
| Workspaces | KDE X11 path | Implemented | [ ] | [ ] | [ ] | KDE DBus desktop CRUD + Xlib EWMH window ops; works or fails gracefully. |
| Workspaces | KDE Wayland path | Partial | [ ] | [ ] | [ ] | KWin scripting + DBus; KDE 5 window enumeration is best-effort. Needs live-session QA. |
| Time | Active session start | Implemented | [ ] | [ ] | [ ] | Activating project starts session. |
| Time | Session close | Implemented | [ ] | [ ] | [ ] | Switching/closing project records duration. |
| Time | Orphan cleanup | Implemented | [ ] | [ ] | [ ] | Crash/restart closes prior active session. |
| Time | Today totals | Implemented | [ ] | [ ] | [ ] | Today's totals update in UI. |
| Time | `STATUS.md` sync | Implemented | [ ] | [ ] | [ ] | Status file has current time-log section. |
| Stats | File scan | Implemented | [ ] | [ ] | [ ] | Project file-type stats update in metadata. |
| Stats | Hover display | Implemented | [ ] | [ ] | [ ] | Project pill stats popover displays file/time info. |
| Network | Connectivity probe | Implemented | [ ] | [ ] | [ ] | Offline/online changes are detected. |
| Network | Header lamp | Implemented | [ ] | [ ] | [ ] | Lamp color and tooltip update. |
| Network | Offline banner | Implemented | [ ] | [ ] | [ ] | Center banner appears offline. |
| Downloads | Active project symlink | Implemented | [ ] | [ ] | [ ] | `~/eldrun/downloads` points to active project downloads. |
| Downloads | Root symlink fallback | Implemented | [ ] | [ ] | [ ] | Root/no project points to root downloads. |
| Downloads | Firefox prefs | Implemented | [ ] | [ ] | [ ] | `downloads_manager` writes `prefs.js` and `user.js` in detected Firefox profile on startup. |
| Downloads | Chromium prefs | Implemented | [ ] | [ ] | [ ] | `downloads_manager` patches Chromium/Chrome `Preferences` JSON on startup. |

## Application Shell and Safety

| Feature | Code State | Done | Partial | Issue | Manual checks |
|---|---:|---|---|---|---|
| GTK4/Libadwaita desktop app entrypoint | Implemented | [ ] | [ ] | [ ] | App opens as Eldrun; GTK CSS loads; no startup traceback. |
| Single-instance protection | Implemented | [ ] | [ ] | [ ] | GIO unique-application ID; second launch presents existing window instead of creating a new instance. |
| Undecorated custom header | Implemented | [ ] | [ ] | [ ] | Header can drag window; network status, tab strip, clock, and window buttons fit. |
| Fullscreen default and F11 toggle | Implemented | [ ] | [ ] | [ ] | App starts fullscreen; F11 toggles fullscreen/restored state; tooltip updates. |
| Close confirmation and graceful quit | Implemented | [ ] | [ ] | [ ] | Close button shows warning; cancel keeps app open; confirm cleans up sessions/workspaces. |
| SIGTERM/SIGINT handling | Implemented | [ ] | [ ] | [ ] | App exits cleanly when terminated by desktop/session. |
| Agent launch safety documentation | Implemented | [ ] | [ ] | [ ] | `AGENTS.md` and `CLAUDE.md` clearly forbid agents from launching duplicate Eldrun instances. |

## Project Lifecycle and Persistence

| Feature | Code State | Done | Partial | Issue | Manual checks |
|---|---:|---|---|---|---|
| Global project index | Implemented | [ ] | [ ] | [ ] | `~/.local/share/eldrun/projects.json` tracks active/current/inactive projects and ordering. |
| Project-local metadata | Implemented | [ ] | [ ] | [ ] | Each project has `project.json`; global-only fields stay in global index. |
| New project dialog | Implemented | [ ] | [ ] | [ ] | Create project validates name, previews path, scaffolds files, opens terminal. |
| Project scaffold | Implemented | [ ] | [ ] | [ ] | New/imported projects include `AGENTS.md`, `CLAUDE.md`, `.claude/settings.json`, `.gitignore`, `TODO.md`, `ROADMAP.md`, `STATUS.md`, and `DOCUMENTATION.md`. |
| Git initialization for new projects | Implemented | [ ] | [ ] | [ ] | New project is a git repo with initial scaffold commit. |
| Import project dialog | Implemented | [ ] | [ ] | [ ] | Import supports folder picker, generated project name, mode/visibility selection, scaffold gap-fill. |
| Import modes | Implemented | [ ] | [ ] | [ ] | Keep/copy-style modes behave as documented and do not destroy source data. |
| Project close/deactivate | Implemented | [ ] | [ ] | [ ] | Closing a project removes pill/terminal, marks inactive, and returns active project to root if needed. |
| Close active project returns to root | Implemented | [ ] | [ ] | [ ] | Active project close selects root, hides project file panel, and keeps UI usable. |
| Project search | Implemented | [ ] | [ ] | [ ] | Search includes inactive projects, matches name/path case-insensitively, and activates unique match with Enter. |
| Project pill reorder | Implemented | [ ] | [ ] | [ ] | Dragging pills changes order and persists `position`. |
| Remote repo creation / Git hosting settings | Implemented | [ ] | [ ] | [ ] | Git profile URL/token can be set; project creation can create/push remote where configured. |

## Agents, Terminals, and Tabs

| Feature | Code State | Done | Partial | Issue | Manual checks |
|---|---:|---|---|---|---|
| Root orchestration terminal | Implemented | [ ] | [ ] | [ ] | Root opens in `~/eldrun/root/`, respawns on process exit, and is selected by Root control. |
| Per-project terminal | Implemented | [ ] | [ ] | [ ] | Activating a project opens/spawns an agent terminal in the project directory. |
| Project sandbox env | Implemented | [ ] | [ ] | [ ] | Project-bound terminals inherit project-local XDG config/cache/data/state/tmp paths under `<project>/.eldrun/sandbox/`; root stays unsandboxed. |
| Configurable default agent command | Implemented | [ ] | [ ] | [ ] | Settings switch between `claude` and `codex`; terminals respawn with selected command. |
| Shell fallback | Implemented | [ ] | [ ] | [ ] | If configured command is missing, terminal falls back to a shell. |
| Header tab strip | Implemented | [ ] | [ ] | [ ] | Agent/terminal tabs remain visible in the header, scroll horizontally, and show active styling. |
| Multiple Claude/Codex tabs | Implemented | [ ] | [ ] | [ ] | Right-click tab bar adds additional Claude/Codex tabs for current project. |
| Plain shell terminal tabs | Implemented | [ ] | [ ] | [ ] | Right-click tab bar adds a plain shell tab; tab can be renamed/closed. |
| Uniform tab close/rename | Implemented | [ ] | [ ] | [ ] | Default and additional agent tabs can be renamed/closed consistently. |
| Empty tab state | Implemented | [ ] | [ ] | [ ] | Closing all tabs shows no-terminal empty state and does not recreate a hidden tab. |
| Tab numbering reuse | Implemented | [ ] | [ ] | [ ] | Closing `Claude1`/`Codex1` allows expected low-number reuse. |
| Tab drag reorder | Implemented | [ ] | [ ] | [ ] | Dragging tabs reorders them without losing active terminal. |
| Agent task metadata | Implemented | [ ] | [ ] | [ ] | Right-click agent tab can set, mark done, clear task; tooltip shows preview/status/timestamp. |
| Agent task persistence | Implemented | [ ] | [ ] | [ ] | Project task metadata persists to `project.json["agent_tasks"]`. |
| New-agent prompt auto-task | Implemented | [ ] | [ ] | [ ] | Creating an agent with a task stores it and feeds it to Claude/Codex as initial input. |
| Local Ollama models in agent picker | Implemented | [ ] | [ ] | [ ] | Local models appear as `(local)` when Ollama responds; selecting one opens Ollama dialog rather than a VTE tab. |

## Local AI and Ollama

| Feature | Code State | Done | Partial | Issue | Manual checks |
|---|---:|---|---|---|---|
| Ollama client streaming | Implemented | [ ] | [ ] | [ ] | `OllamaClient` threads `/api/generate` stream; chunks dispatched via `GLib.idle_add`; done/error callbacks fire correctly. |
| Ollama settings | Implemented | [ ] | [ ] | [ ] | Settings window can edit host, model, and autostart flag; values persist on Enter/focus-leave. |
| Ctrl+K Ollama dialog | Implemented | [ ] | [ ] | [ ] | `Ctrl+K` opens Ask Ollama dialog with configured model. |
| Center inline Ollama bar | Implemented | [ ] | [ ] | [ ] | Prompt in center bar opens dialog prefilled with prompt and clears entry. |
| File-tree Ask Ollama action | Implemented | [ ] | [ ] | [ ] | Right-click file -> Ask Ollama opens dialog with file-oriented prompt. |
| Ollama local model picker | Implemented | [ ] | [ ] | [ ] | Agent popover lists models from `/api/tags`; selection opens dialog with selected model. |
| Ollama autostart | Implemented | [ ] | [ ] | [ ] | If enabled and host is localhost, Eldrun starts `ollama serve`; process terminated on quit. |
| Local AI privacy label | Not implemented | [ ] | [ ] | [ ] | TODO G5.3: add visible local/private label to AI-generated suggestions. |
| Context-aware terminal hints | Not implemented | [ ] | [ ] | [ ] | TODO G5.4: scrollback-to-Ollama hint strip is absent. |
| Intelligent project search | Not implemented | [ ] | [ ] | [ ] | TODO G5.5: embedding-based ranking is absent. |
| Startup project suggestions | Not implemented | [ ] | [ ] | [ ] | TODO G5.6: no AI project suggestions on startup. |
| App/file suggestions per project | Not implemented | [ ] | [ ] | [ ] | TODO G5.7: no suggested files/apps section. |

## Layout, Panels, and Navigation

| Feature | Code State | Done | Partial | Issue | Manual checks |
|---|---:|---|---|---|---|
| Full-screen center workspace | Implemented | [ ] | [ ] | [ ] | Center terminal/app area is primary surface and expands under overlays. |
| Right file panel overlay | Implemented | [ ] | [ ] | [ ] | Right panel appears over center content, not as a paned column. |
| Right edge hover reveal | Implemented | [ ] | [ ] | [ ] | Hidden right panel appears on edge hover and hides on leave. |
| Right context-menu hold-open | Implemented | [ ] | [ ] | [ ] | Right panel does not auto-hide while a file context menu is open. |
| Right panel restore width | Implemented | [ ] | [ ] | [ ] | Hiding/showing panels does not double or corrupt right panel width. |
| Bottom project bar overlay | Implemented | [ ] | [ ] | [ ] | Bottom bar appears over center panel and does not shrink or jump center content. |
| Bottom edge hover reveal | Implemented | [ ] | [ ] | [ ] | Bottom bar appears on lower-edge hover and hides on leave. |
| Bottom popover hold-open | Implemented | [ ] | [ ] | [ ] | Bottom bar stays visible while project stats/settings/search popover is open. |
| Super key panel toggle | Implemented | [ ] | [ ] | [ ] | Pressing Super toggles panels while Eldrun is focused. |
| Header global app toolbar layout | Implemented | [ ] | [ ] | [ ] | Toolbar is centered below header and hides if no roles are visible. |
| Screenshot toast placement | Implemented | [ ] | [ ] | [ ] | Screenshot confirmation appears above bottom overlay. |

## File Tree, Default Apps, and Open Windows

| Feature | Code State | Done | Partial | Issue | Manual checks |
|---|---:|---|---|---|---|
| Project file tree | Implemented | [ ] | [ ] | [ ] | Tree rebuilds on project switch; folders first; hidden/scaffold filters work. |
| File tree refresh timer | Implemented | [ ] | [ ] | [ ] | External file changes appear after refresh without changing active project. |
| File open through default app chain | Implemented | [ ] | [ ] | [ ] | Double-click file uses project default, global default, system MIME, or Open With fallback. |
| Open With dialog | Implemented | [ ] | [ ] | [ ] | Can choose app and optionally save project/global default. |
| App picker from `.desktop` files | Implemented | [ ] | [ ] | [ ] | `app_picker.py` dialog searches installed `.desktop` apps with MIME-suggested section and live filter; stores chosen executable. |
| Per-project default app map | Implemented | [ ] | [ ] | [ ] | Project-specific app choices override global choices. |
| Global default app bootstrap | Implemented | [ ] | [ ] | [ ] | System MIME defaults populate global default-app map where available. |
| File Type Apps settings | Implemented | [ ] | [ ] | [ ] | Settings window edits global and project file-type app mappings. |
| File context menu | Implemented | [ ] | [ ] | [ ] | Open, Open With, New File, New Folder, Copy Path, Reveal, Color, Rename, Delete, Properties work. |
| Per-path color labels | Implemented | [ ] | [ ] | [ ] | Color labels persist in `.eldrun_colors.json` and reset works. |
| Long filename hover scroll | Implemented | [ ] | [ ] | [ ] | Long tree rows horizontally scroll or reveal enough text on hover. |
| Open windows section | Partial | [ ] | [ ] | [ ] | Right overlay lists standalone windows; project scoping and restore are incomplete per G4 TODOs. |
| Open-app project scoping | Not implemented | [ ] | [ ] | [ ] | TODO G4.4: verify windows are filtered by process cwd; current code may still be partial. |
| Standalone open-app mode field | Not implemented | [ ] | [ ] | [ ] | TODO G4.1: `open_apps` entries do not consistently carry `"mode": "standalone"`. |
| Standalone open-app baseline | Not implemented | [ ] | [ ] | [ ] | TODO G4.5: reliable standalone-first file open is not fully complete. |
| Standalone app restore | Not implemented | [ ] | [ ] | [ ] | TODO G4.6: relaunch standalone entries on reactivation is not complete. |
| X11 embedding pipeline | Partial / removed | [ ] | [ ] | [ ] | Plan 1 says embedding was broken/removed; verify current behavior and update docs/TODOs. |
| Embedded app theme propagation | Not implemented | [ ] | [ ] | [ ] | TODO G3.5: theme toggles are not propagated into embedded apps. |

## Global Cross-Project Apps

| Feature | Code State | Done | Partial | Issue | Manual checks |
|---|---:|---|---|---|---|
| Global app role registry | Implemented | [ ] | [ ] | [ ] | `settings.json["global_apps"]` has role entries with `exec` and `visible`. |
| Startup role resolution | Implemented | [ ] | [ ] | [ ] | Browser/mail/calendar/etc. resolve from system defaults or `$PATH` where possible. |
| Global app settings UI | Implemented | [ ] | [ ] | [ ] | Each role can be shown/hidden and executable edited/browsed. |
| Toolbar role buttons | Implemented | [ ] | [ ] | [ ] | Visible roles show symbolic icon buttons; unresolved roles are insensitive. |
| Launch-or-raise singleton | Implemented | [ ] | [ ] | [ ] | Clicking role raises existing matching window or launches a new one. |
| Sticky global app windows | Implemented | [ ] | [ ] | [ ] | Raised/launched global apps stay visible across workspaces on X11. |
| Screenshot role | Implemented | [ ] | [ ] | [ ] | Screenshot tool saves to active project/root `tmp/screenshots` and shows toast. |
| URI scheme routing | Not implemented | [ ] | [ ] | [ ] | TODO G6.7: terminal/file-tree links do not route through global app launcher yet. |

## Workspaces and Window Management

| Feature | Code State | Done | Partial | Issue | Manual checks |
|---|---:|---|---|---|---|
| Workspace management setting | Implemented | [ ] | [ ] | [ ] | Toggle persists and enabling mid-session allocates workspaces for active projects. |
| Cinnamon workspace integration | Implemented | [ ] | [ ] | [ ] | Projects map to Cinnamon workspaces; close/shutdown releases assignments. |
| GNOME workspace support | Implemented | [ ] | [ ] | [ ] | GNOME Shell Eval/DBus path or fallback works where supported. |
| `wmctrl` fallback | Implemented | [ ] | [ ] | [ ] | Workspace activation falls back gracefully when DBus path is unavailable. |
| Eldrun sticky window | Implemented | [ ] | [ ] | [ ] | Eldrun remains visible across managed workspaces. |
| Project workspace assignment order | Implemented | [ ] | [ ] | [ ] | Workspaces follow bottom pill order and remain correct after close/reorder. |
| Non-KDE Wayland boundary | Implemented | [ ] | [ ] | [ ] | Non-KDE Wayland workspace/window paths fail gracefully without crashing. |

## Time, Stats, Network, and Downloads

| Feature | Code State | Done | Partial | Issue | Manual checks |
|---|---:|---|---|---|---|
| Project time tracking | Implemented | [ ] | [ ] | [ ] | Switching projects records sessions and aggregates today totals. |
| Orphan session close | Implemented | [ ] | [ ] | [ ] | Crash/restart closes previous active session in time log. |
| `STATUS.md` time log sync | Implemented | [ ] | [ ] | [ ] | Project status file gets total and recent-session table. |
| Project time bars | Implemented | [ ] | [ ] | [ ] | Project pills/rows show relative today time with tooltip. |
| Project file-type stats | Implemented | [ ] | [ ] | [ ] | Stats update in `project.json`; hover/right-click stats show file-type breakdown. |
| Network status lamp | Implemented | [ ] | [ ] | [ ] | Header lamp updates online/offline and tooltip shows state. |
| Network type indicator | Implemented | [ ] | [ ] | [ ] | Wired/wireless icon or label updates when detectable. |
| Offline banner | Implemented | [ ] | [ ] | [ ] | Center panel banner appears when offline. |
| Project/root downloads symlink | Implemented | [ ] | [ ] | [ ] | `~/eldrun/downloads` points to active project or root `tmp/downloads`. |
| Browser download directory preferences | Implemented | [ ] | [ ] | [ ] | `apply_browser_download_dir()` called on startup; writes Firefox profile prefs and Chromium Preferences JSON; assumes browser not yet running. |

## Settings, Theme, and Appearance

| Feature | Code State | Done | Partial | Issue | Manual checks |
|---|---:|---|---|---|---|
| Settings as modal window | Implemented | [ ] | [ ] | [ ] | Settings does not close while interacting with dropdowns/entries. |
| Terminal command setting | Implemented | [ ] | [ ] | [ ] | Switching command updates setting and respawns terminals. |
| Theme setting | Implemented | [ ] | [ ] | [ ] | Dark, Light, Fancy Dark, Fancy Bright apply to app and terminal colors. |
| Fancy theme legacy alias | Implemented | [ ] | [ ] | [ ] | Stored `fancy` maps to `fancy_dark`. |
| Debug mode toggle | Implemented | [ ] | [ ] | [ ] | Debug badge and debug state update live. |
| Global app settings section | Implemented | [ ] | [ ] | [ ] | Global app role UI opens from Settings and updates toolbar live. |
| File Type Apps settings section | Implemented | [ ] | [ ] | [ ] | Default app settings open from Settings and update file icons. |
| Standalone app theme env | Not implemented | [ ] | [ ] | [ ] | TODO G3.2: standalone launched apps do not receive `GTK_THEME` env. |

## Testing and Documentation

| Feature | Code State | Done | Partial | Issue | Manual checks |
|---|---:|---|---|---|---|
| Unit test suite | Implemented | [ ] | [ ] | [ ] | `python3 -m unittest` passes (520 tests). Covers project manager, settings, default apps, global apps, network, time tracking, workspace helpers, Ollama client, download routing, app picker, panel-adjacent logic, and KDE Plasma backend (X11 + Wayland, ~127 tests). |
| Syntax check command | Implemented | [ ] | [ ] | [ ] | `python3 -m py_compile ... app/panels/*.py app/backends/*.py` passes. |
| App docs | Partial | [ ] | [ ] | [ ] | `DOCUMENTATION.md` covers most features; Ollama and downloads manager sections may lag code. |
| Agent docs | Implemented | [ ] | [ ] | [ ] | `AGENTS.md` and `CLAUDE.md` describe workflow and no-duplicate-launch rule. |
| Feature checklist | Implemented | [ ] | [ ] | [ ] | This `Features.md` exists and is kept current as features change. |

## Open TODO Rollup

These are the main planned or incomplete areas from `TODO.md` and `plan_1.md`.
Use this rollup when deciding what to implement next.

| Area | Feature | Done | Partial | Issue | Notes |
|---|---|---|---|---|---|
| Theme | Standalone app theme env | [ ] | [ ] | [ ] | G3.2 |
| Theme | Embedded app theme propagation | [ ] | [ ] | [ ] | G3.5 |
| Open apps | Standalone mode field | [ ] | [ ] | [ ] | G4.1 |
| Open apps | Project-scoped open-app list | [ ] | [ ] | [ ] | G4.4 |
| Open apps | Standalone file-open baseline | [ ] | [ ] | [ ] | G4.5 |
| Open apps | Standalone app restore | [ ] | [ ] | [ ] | G4.6 |
| Open apps | Embedding hardening/verification | [ ] | [ ] | [ ] | G4.8 and `plan_1.md` |
| Local AI | Ollama daemon status indicator | [ ] | [ ] | [ ] | G5.1 partially started; no header status indicator yet. |
| Local AI | Per-project/local model selection | [ ] | [ ] | [ ] | G5.2 partially started via global settings and local picker. |
| Local AI | Privacy boundary label | [ ] | [ ] | [ ] | G5.3 |
| Local AI | Terminal hints | [ ] | [ ] | [ ] | G5.4 |
| Local AI | Semantic project search | [ ] | [ ] | [ ] | G5.5 |
| Local AI | Startup project suggestions | [ ] | [ ] | [ ] | G5.6 |
| Local AI | App/file suggestions | [ ] | [ ] | [ ] | G5.7 |
| Global apps | URI scheme routing | [ ] | [ ] | [ ] | G6.7 |
