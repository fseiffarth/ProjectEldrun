# Eldrun

> **You don't open applications — you open projects.**
> Eldrun is a project-centric desktop layer that swaps your whole working
> context as one unit, with AI agent terminals and in-app file viewers built in.

Built with **Tauri 2 + React + TypeScript**, with optional KDE/X11 workspace
integration. Linux-first.

---

## Why Eldrun

When you juggle several projects at once, every project's windows — browsers,
terminals, file managers, docs, agents — pile onto one desktop. Switching from
project A to project B means digging through dozens of windows for the handful
that belong where you're going, and losing the rest in the noise.

Eldrun flips the model. **Select a project, and the desktop becomes that
project:** its windows come forward, the previous project's windows park out of
the way, the downloads folder and default-app mappings re-route, and time
tracking switches. One project visible at a time, everything else cleanly out of
sight.

Inside a project, Eldrun is an operational cockpit — a root control terminal for
the workspace, agent terminals scoped to the project (Claude, Codex, Gemini, or
a local Ollama model), a tiling tab layout, a hover-revealed file panel with
built-in viewers, and cross-project app controls that follow you between
projects.

## Vision

> Select a project → Eldrun restores its complete working context.

Eldrun is a **project-centric desktop layer**, not just an app that launches or
embeds other apps. The core product is the window/workspace layer: projects own
their windows and desktop context, and switching projects swaps that context as
a single unit. The agent terminals, file viewers, and app launcher ride on top —
they're what lives *inside* a project once its desktop is restored.

A project's context already spans terminals, files, apps, windows, Git state,
and layout; the direction of travel adds notes, AI/task metadata, and workflow
state, so a project carries everything it needs to be resumed exactly where you
left it.

Today the implementation targets **Linux (X11 and KDE Wayland)** — the fastest
path to reliable window control. The long-term shape is a stable Eldrun core
behind pluggable compositor backends (X11, KDE/KWin, Hyprland, GNOME Shell, i3,
Sway, and other Wayland environments), and eventually an Eldrun-native
compositor for full control of projects, windows, and layout.

See [VISION.md](docs/VISION.md) for the full strategy and platform rationale.

## At a glance

![Eldrun functionality map](screenshots/eldrun-functionality.svg)

**①** pick a project and the desktop swaps to it. **②** inside, a tiling tab
layout hosts agent terminals, shells, and native file viewers. **③** the
project-desktop layer (window parking, downloads, default apps, time tracking)
follows the active project automatically, with the right panel (Files · Git ·
Search) and the global app toolbar alongside.

## How Eldrun compares

Agent orchestrators (Vibe Kanban, Conductor, Claude Squad, the Claude Code
desktop app) manage agent *processes inside a repo* — task delegation, git
worktrees, diff review, merge flow. They are excellent at parallelizing work
within one codebase, but they have no notion of your desktop: they won't move
your windows, re-route downloads, or switch default apps when you change focus.

Manual approaches cover only one slice each: KDE Activities and one virtual
desktop per project handle windows but have no project model and no restore;
tmux and scripts like `workon` restore terminal layouts but ignore everything
outside the terminal.

Eldrun occupies the gap none of them fill: project ownership of *windows and
desktop context*, with agent terminals built in. It is complementary to the
task orchestrators rather than a replacement — you can run one inside an Eldrun
project terminal for parallel task delegation while Eldrun handles switching the
desktop between projects.

![Current Eldrun screen](screenshots/eldrun-current.png)

## Stack

- **Frontend:** React 18, TypeScript, Vite, Tailwind CSS, Zustand
- **Terminal UI:** xterm.js (`@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-web-links`)
- **Backend:** Rust, Tauri v2
- **PTY:** `portable-pty` crate
- **Workspace:** `zbus` (DBus) and `xcb` (X11) — Linux only

## Requirements

- Linux desktop (X11 or KDE Wayland)
- Rust toolchain (`rustup`) and Node 18+
- `sshfs` + FUSE (optional, only for remote/SSH projects)

```bash
# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Tauri system dependencies (Debian / Ubuntu)
sudo apt install libwebkit2gtk-4.1-dev libssl-dev libgtk-3-dev \
    libayatana-appindicator3-dev librsvg2-dev

# Install JS deps
npm install
```

## Run

```bash
./start-eldrun-tauri.sh
```

Or for a development build with hot-reload:

```bash
npm run tauri dev
```

The desktop launchers are `Eldrun.desktop` for the normal packaged app and
`EldrunHotReload.desktop` for hot reload. They already point at this
checkout's scripts, so you can install them as-is:

```bash
cp Eldrun*.desktop ~/.local/share/applications/
update-desktop-database ~/.local/share/applications/
```

## Agent Support

Eldrun launches agents in xterm.js PTY tabs. The table below describes the
current integration state.

### CLI agents (xterm.js terminal tabs)

| Agent                                      | Integrated | Tested  | Notes                                                                                                                                               |
| ------------------------------------------ | ---------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Claude** (`claude`)                      | Yes        | Yes     | Default agent command. Full tab lifecycle, layout persistence, project-scoped sandbox env.                                                          |
| **Codex** (`codex`)                        | Yes        | Yes     | Selectable as default agent command in Settings. Same tab lifecycle as Claude.                                                                      |
| **Gemini** (`gemini`)                      | Yes        | Yes     | Selectable as default agent command in Settings. Same tab lifecycle as Claude and Codex.                                                            |
| **Vibe** (`vibe`)                          | Yes        | No      | Listed as a selectable agent command; same tab lifecycle.                                                                                           |
| **Ollama via Vibe** (`vibe` + local model) | Yes        | Partial | Installed Ollama models appear under Local Agents. Each local tab gets an isolated per-model `VIBE_HOME` under `~/.local/share/eldrun/vibe_local/`. |
| **Shell**                                  | Yes        | Yes     | Plain interactive shell tab in the project directory.                                                                                               |
| Mistral CLI                                | No         | No      | Not integrated. Can be used in a plain shell tab.                                                                                                   |
| Qwen CLI                                   | No         | No      | Not integrated.                                                                                                                                     |
| Grok CLI                                   | No         | No      | Not integrated.                                                                                                                                     |

The active agent command (`claude`, `codex`, `gemini`, or `vibe`) is set in
Settings. If the configured command is not found in `$PATH`, Eldrun falls back
to the system shell. Project-bound terminals also receive a best-effort project
sandbox: the child process runs in the project directory with project-local XDG
config, cache, data, state, and temp locations under
`<project>/.eldrun/sandbox/`. The root orchestration terminal keeps the normal
workspace environment.

**Session resume.** Claude and Codex tabs that carry a session id are persisted
across restarts and respawned with their prior conversation. Eldrun installs a
`SessionStart` hook (into `~/.claude/settings.json` and `~/.codex/config.toml`)
that records each tab's live session id keyed by an `ELDRUN_TAB_UID` env var, so
resume follows the live session even across a `/clear`. (Codex hooks need a
one-time `/hooks` trust before they fire; Gemini and Vibe tabs are still
dropped.)

Local Ollama models are available from the tab `+` menu when Ollama is
installed and reachable. Eldrun can start the Ollama service, list installed
models, and create a `vibe` tab for a selected model. The per-model `VIBE_HOME`
config pins `active_model`, registers the Ollama provider, and disables Vibe
tool calls for local models so local tabs do not mutate global `~/.vibe`
configuration.

## Platform Support

| Platform                  | Status             | Notes                                                                                        |
| ------------------------- | ------------------ | -------------------------------------------------------------------------------------------- |
| **Linux — X11**           | Yes                | Two-desktop workspace parking model (EWMH/xcb). Primary development target.                  |
| **Linux — KDE Wayland**   | Yes                | Per-project virtual desktop model via KWin DBus scripting. KDE 5 and KDE 6 supported.        |
| **Linux — other Wayland** | Partial            | Null backend (no workspace switching, no sticky windows). Terminal and file management work. |
| **Windows**               | Experimental shell | Null workspace backend. No native window/default-app/download integrations.                  |
| **macOS**                 | Experimental shell | Null workspace backend. No native window/default-app/download integrations.                  |

## Main Features

### Project desktop (the differentiator)

- **Workspace management**: X11 two-desktop parking model and KDE Wayland
  per-project virtual desktop model; global app windows stay visible across
  all project switches.
- **External window tracking**: file opens use `xdg-open`; launched windows are
  tracked by PID and shown in the right panel instead of embedded in the UI.
- **Downloads routing**: `~/eldrun/downloads` symlink always points to the active
  project's `tmp/downloads/`; Firefox and Chromium preferences are updated
  automatically.
- **Default app mapping**: file extensions use per-project overrides, global
  defaults, system MIME defaults, or a manual "Open With" picker.
- **Time tracking**: Eldrun records active project sessions and shows today's
  elapsed time on project pills.

### Project cockpit

- **Agent-terminal orchestration**: create Claude, Codex, Gemini, or plain shell
  tabs from the tab bar; create local Ollama-backed Vibe tabs from installed
  models; rename, close, and reorder them by drag and drop. Tab layout is
  persisted per project.
- **Tiling subwindows**: the center panel is a tiling layout — drag a tab onto
  another subwindow's left/right/top/bottom edge to split that direction into a
  new pane, or onto its center to move the tab in. Splits resize with draggable
  dividers, each subwindow keeps its own tab bar, and the whole tree is persisted
  per project. A subwindow's tab bar also offers a **pop-out** button that
  detaches that group into its own borderless OS window; the detached window is
  tracked as a project-owned window and parks/restores with its project on switch.
  Dock it back with the ⤓ button (re-docks into the main layout; session-only, so
  it re-docks on restart too). Closing the popped-out window instead closes its
  tabs for good — they are not docked back and do not restore on next launch.
- **Project boxes (meta-project grouping)**: group related projects into a *box*
  that appears as its own pill in the project switcher. Drop a project pill onto a
  box to add it; click the box to open a box-scoped shell rooted in a per-box
  folder under `~/.local/share/eldrun/boxes/<name>/`; hover to list members and
  click one to jump to it. Opening a box writes/refreshes managed
  `CLAUDE.md`/`GEMINI.md`/`AGENTS.md` link blocks in the box folder pointing at
  each member's root and matching agent doc (edits outside the managed markers are
  preserved). Box membership lives in a sibling `boxes.json`, so `projects.json`
  is untouched. Box scopes are session-only for now — a box's tabs are not
  restored across project switch or restart.
- **Root control terminal**: opens in `~/eldrun/root/` with workspace-level
  context files.
- **Project terminals**: each active project gets a PTY tab scoped to its
  directory, with best-effort project-local XDG sandbox paths.
- **Project creation and import**: the `+` button creates a new git-backed
  project or imports an existing directory (keep in place, copy, or move).
- **Remote (SSH) projects**: optionally point a project at a remote host. Enter
  an SSH address (`user@host[:port]`), connect, and browse the remote filesystem
  in-app to pick the project root. Eldrun `sshfs`-mounts it locally so the file
  tree, terminal cwd, and git work unchanged. Terminal and agent tabs run **on
  the remote host** over `ssh -tt` (multiplexed over a ControlMaster socket),
  with the agent CLI auto-detected/bootstrapped on the remote and authenticated
  with the remote's own login. VPN-gated hosts bring up an OpenVPN tunnel first.
  Auth uses your existing SSH setup (keys / agent / `~/.ssh/config`,
  `BatchMode`); requires `sshfs`/FUSE on the local machine.
- **Publish to GitHub**: a local (or SSH-remote) git project can be published to
  a new GitHub repository from the project pill menu. Choose public or private;
  Eldrun runs `gh repo create … --source=. --push` via the system `gh` CLI (over
  `ssh` on the host where the bytes live for remote projects), then records the
  new push target (`git_type` becomes `remote-public`/`remote-private`). Requires
  the GitHub CLI (`gh`) installed and authenticated.
- **Project switcher**: search, switch, and close projects; a running-task
  indicator spins on pills with live terminal output (even backgrounded
  projects); hover over a pill to see the project path, status, today's active
  time, and live CPU%.
- **Right file panel**: browse, open, create, rename, delete, copy/cut/paste,
  and reveal project files, with a breadcrumb trail and per-file git status
  markers (modified, untracked, staged, committed-but-unpushed, ignored). A
  **Git** view shows the current branch, clickable branch pills for checkout,
  and a commit list whose entries open an editable commit-message window (amend
  HEAD, agent-generated messages, or checkout). A **Search** view runs a
  project-wide literal content search and lists matching lines that jump straight
  into the in-app viewer. The panel can be pinned open instead of hover-revealed;
  additional views list tracked external windows.
- **In-app file viewers**: drag a file from the tree onto a subwindow's tab bar
  to open it in a tab. The viewer is chosen by extension. **Status legend:**
  ✅ shipping · 🚧 in progress (opens in the external default app until landed).

  | Viewer | File types | Status | What it does |
  | ------ | ---------- | :----: | ------------ |
  | **Text / code** | `.txt` `.json` `.py` `.rs` `.ts` `.bib` + many more, and extensionless files like `Dockerfile` | ✅ | Editable editor: line-number gutter, syntax highlighting, Tab/Shift+Tab indent, undo/redo (`Ctrl+Z`/`Ctrl+Shift+Z`), find (`Ctrl+F`) and find-and-replace (`Ctrl+R`) with match nav + case toggle, save (`Ctrl+S`). Unsaved lines marked in the gutter; auto-reloads on disk change with a non-destructive Reload / Keep-mine banner. Opt-in local autocomplete. |
  | **Markdown** | `.md` `.markdown` `.mdx` | ✅ | Rendered preview with an Edit/Preview toggle; links to local files are clickable. |
  | **LaTeX** | `.tex` | ✅ | Code editor + compile (when a TeX engine is on `PATH`) with output-folder and engine-flag options (shell-escape always stripped). Compile opens the PDF in its own tab; `Ctrl`/`Cmd`+Click follows `\input{…}`/`\includegraphics{…}`; `\ref{…}`/`\cite{…}` completion from `\label` keys and `.bib` entries; failed compiles list parsed errors (incl. `\input`-ed children) that jump to the line; **bidirectional SyncTeX sync** between editor and PDF, across tiled panes or detached windows. |
  | **PDF** | `.pdf` | ✅ | Rendered with a themed zoom toolbar. |
  | **Images** | `.png` `.jpg` `.gif` `.webp` … | ✅ | Zoom-to-cursor / pan; draggable out as an OS drop source. |
  | **Table / CSV** | `.csv` `.tsv` | ✅ | Read-only grid (RFC 4180-style parse); large files are windowed to keep the webview responsive. |
  | **Jupyter notebook** | `.ipynb` | ✅ | Read-only render of cells top-to-bottom — markdown cells, Python-highlighted code cells, and their classified outputs. |
  | **Diff / patch** | `.diff` `.patch` | ✅ | Color-coded add/del rendering that reads in light and dark themes. |
  | **OpenDocument Text** | `.odt` | ✅ | Read-only: unzips the archive and renders `content.xml` to a safe HTML subset (headings, lists, tables, images). |
  | **Spreadsheet** | `.xlsx` `.xls` `.xlsm` | 🚧 | Backend reader (calamine) into the table grid, with a sheet picker. |
  | **SQLite** | `.db` `.sqlite` `.sqlite3` | 🚧 | Read-only table browser: table list + paged row grid. |
  | **HTML / SVG** | `.html` `.htm` `.svg` | 🚧 | Sandboxed preview (no scripts) with a Preview ⇄ Source toggle. |
  | **Audio / video** | `.mp3` `.mp4` `.webm` `.wav` … | 🚧 | Native in-tab `<audio>`/`<video>` player. |

  Other office formats (`.docx`, `.pptx`, `.ods`, …) open in their external
  default app. Viewer behaviour is configured per file type under **Settings →
  Native Viewers**: the per-type autocomplete opt-in plus a global autosave
  switch. The text/LaTeX/Markdown editors carry an `A−`/`A+` text-size control
  (`Ctrl` +/−, `Ctrl`+0 to reset; scales the Markdown preview too), persisted
  per file type. Every viewer remembers where you left off — editor/PDF scroll
  position, PDF/image zoom, and image pan persist per tab, so reopening a file
  (or restarting Eldrun) restores your position instead of jumping to the top.
- **Local autocomplete (opt-in, private)**: in the editable text/LaTeX/markdown
  viewers, `Ctrl+Space` requests a single completion from a **local Ollama**
  model (`Tab` accepts, `Esc` dismisses). It is OFF by default and per file
  type; nothing is sent anywhere unless you enable it, and if Ollama isn't
  running it fails silently — no remote calls, ever.
- **Global app toolbar**: cross-project roles (Browser, Mail, Calendar, File
  Manager, Password Manager, Notes, Screenshot, etc.) with launch-or-raise and
  icon resolution. The Screenshot role launches straight into interactive
  region selection when the configured tool supports it.
- **Ollama model management**: the Settings Ollama panel shows installed
  models, running CPU/GPU state, parameter and quantization details, plus
  catalog install, update, unload, and delete controls.
- **Hover-revealed panels**: the global app bar and right file panel appear on
  pointer hover and disappear when the pointer leaves, keeping the center
  terminal unobstructed; the right panel can also be pinned permanently open.

### Platform and packaging

- **Network indicator**: probes connectivity and shows online/offline plus wired
  or wireless state.
- **Keyboard shortcuts**: Eldrun opens fullscreen by default; `F11` toggles
  fullscreen; `Super` toggles all panels.
- **Crash logging**: Rust panic hook appends to `~/.local/share/eldrun/crash.log`.
- **Packaging**: Debian `.deb` and AppImage targets.

## Current Limits

- Live X11 window embedding (frameless reparenting of an external app into a
  tab) is not yet implemented; files render in built-in in-app viewers where
  available, otherwise open via `xdg-open` and are tracked as external windows.
- KDE Wayland workspace management needs live-session QA.
- Terminal/tab layout is persisted per project; shell, file-viewer, and
  resumable Claude/Codex agent tabs are restored on relaunch, but other agent
  tabs (Gemini, Vibe) and live PTY scrollback are not.
- Detached (popped-out) subwindows and project-box scopes are session-only: the
  former re-docks and the latter's tabs are dropped on project switch / restart.
- Non-KDE Wayland compositors fall back to the null backend.
- Some native viewers are still landing (spreadsheets, SQLite, HTML/SVG,
  audio/video — marked 🚧 above); until each lands, those types open in the
  external default app.

## Project Storage

Managed projects live under `~/eldrun/projects/<sanitized-name>/`.
Imported projects can also be registered in place.

Global Eldrun state lives in `~/.local/share/eldrun/`:

- `projects.json`: lightweight index with project id, name, status, ordering,
  and path to each project's local metadata file.
- `settings.json`: default agent command, theme, workspace-management setting,
  global app registry, and other user preferences.
- `default_apps.json`: global file-extension to application command map.
- `boxes.json`: project-box definitions (id, name, ordered `member_ids`,
  resolved `folder`, relations); kept separate so `projects.json` stays
  byte-compatible.
- `time_log.json` and `active_session.json`: session time tracking.
- `vibe_local/<model-alias>/config.toml`: isolated Vibe configuration for
  each local Ollama model tab.

Project-local state lives in each project's `project.json`, alongside
scaffolded files such as `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `TODO.md`,
`ROADMAP.md`, `STATUS.md`, and `DOCUMENTATION.md`.

See [DOCUMENTATION.md](DOCUMENTATION.md) for the detailed architecture, data
schemas, behavior notes, and known limitations.
