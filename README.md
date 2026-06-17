# Eldrun

**The problem:** when you develop several projects at once, every project's
windows — browsers, terminals, file managers, docs, agents — pile up on one
desktop. Switching from project A to project B means hunting through dozens of
windows for the handful that belong to where you're going, and losing the rest
in the noise.

**Eldrun's model:** you don't open applications, you open projects. Selecting a
project swaps the whole desktop to that project's context — its windows come
forward, the previous project's windows are parked out of the way, the
downloads folder and default-app mappings re-route, and time tracking switches.
One project visible at a time, everything else cleanly out of sight.

Inside each project, Eldrun is an operational cockpit: a root control terminal
for managing the workspace, one or more agent terminals scoped to the project
(Claude, Codex, Gemini, or a local Ollama model), a persistent project bar, a
hover-revealed file panel, and cross-project app controls that stay available as
you move between projects. It is built with Tauri 2 + React + TypeScript, with
optional KDE/X11 workspace integration.

## Vision

Eldrun is a project-centric desktop layer, not just an app that launches or
embeds other apps. The user-facing model is:

> Select a project → Eldrun restores that project's working context.

The core product is the window/workspace layer: projects own their windows and
desktop context, and switching projects swaps that context as one unit. The
agent terminals, file panel, and app launcher ride on top of that layer — they
are what lives inside a project once its desktop is restored. That context
should eventually include terminals, files, apps, windows, Git state, notes,
AI/task metadata, layout, and workflow state.

The current implementation is focused on Linux (X11 and KDE Wayland) because
that provides the fastest path to reliable window control. The longer-term
direction is a stable Eldrun core with desktop/compositor backends for Cinnamon
X11, KDE/KWin, Hyprland, GNOME Shell, i3, Sway, and other Wayland environments.

See [VISION.md](VISION.md) for the full strategy and platform rationale.

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

```text
+------------------------------------------------------------------+
| status/network        agent + terminal tabs       app controls   |
+------------------------------------------------------------------+
| global cross-project app toolbar (hover to reveal)               |
+------------------------------------------------------------------+
|                                                                  |
| xterm.js terminal or file browser                                | right panel
|                                                                  | (hover to
|                                                                  |  reveal)
+------------------------------------------------------------------+
| project switcher / bottom bar (hover to reveal)                  |
+------------------------------------------------------------------+
```

## Stack

- **Frontend:** React 18, TypeScript, Vite, Tailwind CSS, Zustand
- **Terminal UI:** xterm.js (`@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-web-links`)
- **Backend:** Rust, Tauri v2
- **PTY:** `portable-pty` crate
- **Workspace:** `zbus` (DBus) and `xcb` (X11) — Linux only

## Requirements

- Linux desktop (X11 or KDE Wayland)
- Rust toolchain (`rustup`) and Node 18+

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
- **Root control terminal**: opens in `~/eldrun/root/` with workspace-level
  context files.
- **Project terminals**: each active project gets a PTY tab scoped to its
  directory, with best-effort project-local XDG sandbox paths.
- **Project creation and import**: the `+` button creates a new git-backed
  project or imports an existing directory (keep in place, copy, or move).
- **Bottom project bar**: search, switch, and close projects; hover over a pill
  to see the project path, status, and today's active time.
- **Right file panel**: browse, open, create, rename, delete, and reveal project
  files. A second view lists tracked external windows.
- **Global app toolbar**: cross-project roles (Browser, Mail, Calendar, File
  Manager, Password Manager, Notes, Screenshot, etc.) with launch-or-raise and
  icon resolution.
- **Ollama model management**: the Settings Ollama panel shows installed
  models, running CPU/GPU state, parameter and quantization details, plus
  catalog install, update, unload, and delete controls.
- **Hover-revealed panels**: the global app bar, right file panel, and bottom
  project switcher all appear on pointer hover and disappear when the pointer
  leaves, keeping the center terminal unobstructed.

### Platform and packaging

- **Network indicator**: probes connectivity and shows online/offline plus wired
  or wireless state.
- **Keyboard shortcuts**: `F11` toggles fullscreen; `Super` toggles all panels.
- **Crash logging**: Rust panic hook appends to `~/.local/share/eldrun/crash.log`.
- **Packaging**: Debian `.deb` and AppImage targets.

## Current Limits

- X11 window embedding is not supported in the Tauri WebView; file opens use
  `xdg-open` and are tracked as external windows.
- KDE Wayland workspace management needs live-session QA.
- Extra terminal tab layout is persisted per project but does not survive PTY
  process exits (terminals respawn; the tab slot remains).
- Non-KDE Wayland compositors fall back to the null backend.

## Project Storage

Managed projects live under `~/eldrun/projects/<sanitized-name>/`.
Imported projects can also be registered in place.

Global Eldrun state lives in `~/.local/share/eldrun/`:

- `projects.json`: lightweight index with project id, name, status, ordering,
  and path to each project's local metadata file.
- `settings.json`: default agent command, theme, workspace-management setting,
  global app registry, and other user preferences.
- `default_apps.json`: global file-extension to application command map.
- `time_log.json` and `active_session.json`: session time tracking.
- `vibe_local/<model-alias>/config.toml`: isolated Vibe configuration for
  each local Ollama model tab.

Project-local state lives in each project's `project.json`, alongside
scaffolded files such as `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `TODO.md`,
`ROADMAP.md`, `STATUS.md`, and `DOCUMENTATION.md`.

See [DOCUMENTATION.md](DOCUMENTATION.md) for the detailed architecture, data
schemas, behavior notes, and known limitations.
