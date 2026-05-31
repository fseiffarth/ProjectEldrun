# Migrate ProjectEldrun to Tauri + Rust + React + TypeScript

## Context

ProjectEldrun is a GTK4/Python desktop workspace for AI-assisted development. The goal is
to rewrite the current `noollama` version using Tauri v2 (Rust backend) + React +
TypeScript (WebView frontend), gaining a modern component-based UI, TypeScript safety,
and a more accessible tech stack while preserving current-state data compatibility and
the Linux desktop workflows that define Eldrun.

This is a ground-up rewrite. No Python/GTK code survives as-is, and the migration should
not reintroduce removed Ollama features. Ollama belongs in a separate future design note
after Tauri parity exists.

**Platform targets:** Linux is the parity target. The Tauri shell, React UI, and much of
the PTY layer can be portable, but Eldrun as a workspace manager is Linux-first. Windows
and macOS builds are future experimental shells unless OS-specific app, window, default
application, download-routing, and workspace integrations are implemented. Linux-specific
crates (`xcb`, `zbus`) stay in `[target.'cfg(target_os = "linux")'.dependencies]`.

**Schedule framing:** 12 focused weeks is a prototype target, not a confident parity
promise. Treat the schema harness, terminal subsystem, workspace backends, and external
window tracking as the migration's highest-risk areas.

---

## Architecture Overview

```
src/                          # React + TypeScript frontend
  components/
    layout/                   # Window shell, panels
    terminal/                 # xterm.js terminal tabs
    projects/                 # Pills, dialogs, file tree
    header/                   # Status lamps, clock, app toolbar
  hooks/                      # useTerminal, useProject, useSettings …
  stores/                     # Zustand global state
  types/                      # Shared TS interfaces mirroring Rust structs

src-tauri/
  src/
    main.rs
    commands/
      terminal.rs             # PTY lifecycle, env, I/O
      projects.rs             # Project CRUD, scaffold
      settings.rs             # Settings load/save
      workspace.rs            # X11 workspace / window management
      network.rs              # Connectivity probe
      apps.rs                 # Launch helpers, role mapping
      files.rs                # File tree, MIME detection
      time_tracker.rs         # Session tracking
    platform/
      mod.rs                  # WorkspaceBackend trait + auto-detect factory
      x11.rs                  # xcb EWMH — Linux X11 window/desktop ops
      wayland_kde.rs          # KWin JS scripting + zbus — KDE Wayland desktop ops
      windows.rs              # Windows stub (VirtualDesktop API — future)
      macos.rs                # macOS stub (Mission Control / Spaces — future)
      null.rs                 # No-op backend (non-Linux or unsupported compositor)
    state.rs                  # AppState (Arc<Mutex<…>>)
```

**IPC pattern:** Rust ↔ React via Tauri commands (`invoke`) for request/response and Tauri
events (`emit_all` / `listen`) for push notifications (terminal output, network status,
time ticks, workspace/window updates). Terminal output must be batched and bounded before
crossing IPC; do not emit one unbounded event stream per byte/chunk without backpressure.

---

## Key Technology Choices

| Concern | Choice | Linux-only? |
|---------|--------|-------------|
| Terminal UI | `xterm.js` (`@xterm/xterm` + `@xterm/addon-fit`) | No — WebView |
| PTY management | `portable-pty` crate | No — Win/Mac/Linux |
| Async runtime | Tokio | No |
| JSON persistence | `serde_json` + pinned Linux state path | Linux path is fixed to existing app state |
| MIME detection | `mime_guess` (extension) + `infer` (magic bytes) | No — replaces `xdg-mime` subprocess |
| File/URL opening | Linux default-app resolver + `opener` fallback | Default-app parity is Linux-specific |
| Network adapter type | `network-interface` crate + TCP probe | No — replaces sysfs read |
| State (frontend) | Zustand | No |
| Styling | Tailwind CSS + CSS variables | No |
| Drag-to-reorder | `@dnd-kit/core` | No |
| Workspace abstraction | `WorkspaceBackend` trait + null backend | Linux parity only; other OSes are stubs |
| X11 window ops | `xcb` crate | **Yes** — `cfg(target_os = "linux")` only |
| DBus | `zbus` crate | **Yes** — `cfg(target_os = "linux")` only |
| XDG sandbox env | `#[cfg(target_os = "linux")]` block in `terminal.rs` | **Yes** — entire block gated |

---

## Scope Lock

The Tauri migration targets the current `noollama` branch, not older Ollama-enabled
releases.

- **In scope:** current project management, root/project/agent terminals, Claude/Codex
  tabs, file tree, settings, default app mappings, global app toolbar, time tracking,
  browser download routing if explicitly retained, and Linux workspace integration.
- **Out of scope:** Ollama dialog/search/client behavior, X11 embedding inside the WebView,
  and full Windows/macOS workspace parity.
- **Intentional redesign:** app tabs become external-window tracking. Restore is
  best-effort launch/raise, not embedded window resurrection.
- **Compatibility rule:** before any UI migration work rewrites user state, Rust must
  prove it can load, preserve, and round-trip current JSON files without losing unknown
  fields or breaking rollback to the Python app.

## Feature Fate

| Feature | Status | Notes |
|---------|--------|-------|
| VTE terminals (agent + project + root) | **Redesigned, high risk** | xterm.js + portable-pty PTY backend with resize, lifecycle, batching, backpressure, paste, key handling, and scrollback limits |
| Tab management + persistence | **Ported** | React tabs, `tab_layout` in project.json |
| Project CRUD + scaffolding | **Ported** | Rust (serde_json) |
| Settings manager | **Ported** | Rust (serde_json + Tauri path API) |
| Time tracking | **Ported** | Rust + Tauri events for UI updates |
| Network monitor | **Ported** | Tokio + `network-interface` crate + TCP probe; Tauri events to frontend |
| File tree + default apps | **Ported, Linux parity first** | React TreeView; preserve `default_apps.json`; Linux default-app resolution remains more than `opener::open()` |
| Bottom panel / project pills | **Ported** | React + @dnd-kit drag-to-reorder |
| Global apps toolbar | **Ported, Linux parity first** | React toolbar + role registry, visibility toggles, launch-or-raise, sticky/global windows, screenshot handling, URI routing, protected app names |
| CSS themes (4) | **Ported** | Tailwind CSS variables |
| Workspace management (KDE/Cinnamon) | **Ported (X11 + KDE Wayland)** | X11: two-desktop parking model; KDE Wayland: per-project virtual desktop model via DBus/KWin |
| X11 window embedding | **Dropped, model redesign required** | Fundamentally incompatible with Tauri WebView; replace app tabs with external-window tracking |
| Windows / macOS support | **Stubbed, experimental** | `WorkspaceBackend` trait returns null backend; usable shell requires OS-specific app/window/default-app/download integrations |
| Project stats scanner | **Ported** | Tokio background task |
| Downloads manager | **Decision required** | Current parity means `~/eldrun/downloads` symlink plus Firefox/Chromium preference edits with backups/locking; otherwise mark deliberate regression |
| Crash logging | **Ported** | `std::panic::set_hook` to crash.log |
| Header (clock, lamps, buttons) | **Ported** | React + Tauri window controls API |

---

## Phased Implementation Roadmap

### Phase 0 — Scope Lock and Parity Contract
**Goal:** Freeze what the Tauri rewrite must preserve before code is written.

- Confirm migration source is the current `noollama` branch.
- Remove Ollama from migration scope, shortcuts, IPC events, settings, tests, and UI copy.
- Define intentional regressions and redesigns:
  - no X11 embedding in the Tauri WebView;
  - app tabs become external-window tracker entries;
  - Windows/macOS are experimental shells until native integrations exist;
  - browser preference editing for downloads is either explicitly retained or marked as a deliberate regression.
- Define the local security model:
  - Tauri commands are allowlisted by capability;
  - file operations validate canonicalized paths and symlinks;
  - project-scoped commands require paths inside registered project roots unless explicitly marked global;
  - PTY spawning is limited to known shell/agent commands plus validated user shell paths;
  - destructive operations require backend validation and cannot be triggered by frontend route state alone.

### Phase 1 — Schema and Compatibility Harness
**Goal:** Rust can load and save current state without breaking rollback to Python.

- Pin Linux state to `~/.local/share/eldrun/`; do not rely on Tauri's generated
  `app_data_dir()` unless it is verified to be the same path and locked down.
- Inventory schemas for:
  - `projects.json`;
  - `settings.json`;
  - `default_apps.json`;
  - `time_log.json`;
  - `active_session.json`;
  - each project `project.json`;
  - `project.json["open_apps"]`;
  - `project.json["tab_layout"]`.
- For each schema, document required fields, optional fields, legacy fields,
  `noollama`-removed fields, default values, and unknown-field preservation.
- Add real sample fixtures from current `noollama` state.
- Implement serde models that preserve unknown fields and perform backup-before-write.
- Add round-trip tests proving the Python app can still recover after Rust writes state.

### Phase 2 — Tauri Shell Without Workspace Features
**Goal:** Window renders with correct layout and basic state read-only flows.

- `cargo create-tauri-app` with React + TypeScript template (Tauri v2).
- Main window layout: header bar, center stack, right panel overlay, bottom bar.
- Tailwind CSS variables for the four current themes.
- Header: window controls, clock, network/workspace placeholders.
- Bottom panel: project pills, add/settings buttons, no workspace switching yet.
- Right panel: placeholder file tree reading fixture data through safe commands.
- Theme switching, settings display, and project list work without writing state except through the Phase 1 harness.

### Phase 3 — Terminal MVP
**Goal:** Prove xterm.js + PTY behavior before building the full tab model.

- Implement one root terminal and one project terminal first.
- `src-tauri/src/commands/terminal.rs`:
  - `portable-pty` PTY creation and child lifecycle tracking;
  - resize propagation from xterm fit events to PTY dimensions;
  - explicit shell fallback and exit handling;
  - crash-loop protection for fast respawns;
  - bounded per-PTY output channels;
  - batched/throttled IPC events to avoid WebView flooding;
  - UTF-8 lossy/binary-safe output handling;
  - Linux project sandbox env in a `#[cfg(target_os = "linux")]` block.
- React terminal component:
  - `xterm.js`, `@xterm/addon-fit`, and `@xterm/addon-web-links`;
  - bracketed paste, copy/paste integration, Ctrl/Alt/meta behavior, focus restore;
  - bounded scrollback default.
- Replace the fixed 350 ms task-feed race with an explicit terminal-ready event when possible; keep the delay only as fallback.

### Phase 4 — Project and File Management
**Goal:** Project CRUD and the right file panel work with safe backend validation.

- Port `project_manager.py` to `src-tauri/src/commands/projects.rs`.
- Project CRUD: create, import, delete, reorder, and scaffold writer.
- Port settings, time tracking, default-app data, and project stats commands.
- File tree command validates canonicalized paths and symlinks before list/open/rename/delete/create.
- Preserve hidden-file toggles, file stats, time display, context menus, and app picker.
- Default app handling preserves `default_apps.json` and Linux resolution behavior; `opener::open()` is only the fallback launcher, not the whole model.

### Phase 5 — Tabs and Agent Orchestration
**Goal:** Restore the daily coding workflow without workspace movement yet.

- Tab bar with close/rename/reorder and current auto-numbering behavior.
- Claude, Codex, Gemini, and plain shell tabs.
- `tab_layout` compatibility through the Phase 1 schema contract.
- URI routing from terminal links through the default/global app system.
- Terminal persistence policy is explicit: what survives project switches and what survives app restarts.
- Offline banner from `network-status-changed`.

### Phase 6 — External App and Window Model
**Goal:** Replace embedded app pages with tracked external windows.

- No embedded app pages in Tauri.
- Track external windows by PID, window ID, desktop UUID, resource class, and command where available.
- `project.json["open_apps"]` remains compatible but is treated as best-effort restore metadata.
- Right panel or toolbar shows external windows instead of embedded pages.
- Launch-or-raise, project restore, sticky/global windows, screenshot special handling,
  protected app names, and terminal URI routing are ported as Linux-first behavior.
- Restore means best-effort launch/raise and workspace assignment, not embedded restore.

### Phase 7 — Workspace Backends
**Goal:** Rebuild workspace behavior after terminals, files, and windows are testable.

- Start with `null.rs` backend for unsupported desktops and CI.
- `src-tauri/src/platform/wayland_kde.rs` — **KDE Wayland per-project desktop model**:
  - active when `WAYLAND_DISPLAY` is set and `XDG_CURRENT_DESKTOP` contains `kde`/`plasma`;
  - each project gets a dedicated KDE virtual desktop;
  - switching projects switches `VirtualDesktopManager.current` via DBus;
  - Eldrun is made sticky at startup so it remains visible across all desktops;
  - KDE 5 and KDE 6 paths use DBus/KWin scripting where the current Python backend does.
- `src-tauri/src/platform/x11.rs` — **KDE/Cinnamon/GNOME-ish X11 parking model**:
  - EWMH via `xcb`;
  - two-workspace model: active project on workspace 0, hidden/background windows parked on workspace 1;
  - protect Eldrun and protected WM_CLASS/app names from movement;
  - cleanup restores tracked hidden windows and original desktop count.
- Decide explicitly whether KDE X11 stays with the two-desktop model or later moves toward per-project desktops.
- GNOME/non-KDE Wayland remains null backend unless a real compositor-specific implementation is added.

### Phase 8 — Downloads, Polish, Packaging, and Release
**Goal:** Prepare a migration release with a rollback path.

- Download manager:
  - always update `~/eldrun/downloads` symlink on Linux;
  - if retained, edit Firefox `prefs.js`, Firefox `user.js`, and Chromium `Preferences` with backups, file-lock awareness, and profile detection;
  - if deferred, document it as a deliberate regression in release notes.
- Keyboard shortcuts: F11 fullscreen, Super panel toggle, per-dialog Escape/Enter, and current non-Ollama shortcuts.
- Bottom panel drag-to-reorder and right-panel drag-over scroll.
- Crash logging writes under the pinned state directory on Linux.
- Packaging targets: Linux `deb` and AppImage first.
- Manual migration notes include backup location, rollback instructions, and known platform limits.

---

## Critical Rust Crates

```toml
# Cross-platform — compile everywhere
[dependencies]
tauri = { version = "2", features = ["protocol-asset"] }
portable-pty = "0.8"
tokio = { version = "1", features = ["full"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
mime_guess = "2"
infer = "0.16"
opener = "0.7"
network-interface = "2"
regex = "1"

# Linux-only — never enters the build graph on Windows or macOS
[target.'cfg(target_os = "linux")'.dependencies]
zbus = "4"
xcb = { version = "1", features = ["randr", "ewmh"] }
```

## Critical npm Packages

```json
"@xterm/xterm": "^5",
"@xterm/addon-fit": "^0.10",
"@xterm/addon-web-links": "^0.11",
"@dnd-kit/core": "^6",
"@dnd-kit/sortable": "^8",
"zustand": "^5",
"@tauri-apps/api": "^2",
"@tauri-apps/plugin-dialog": "^2",
"@tauri-apps/plugin-shell": "^2"
```

---

## Feature Parity Verification

At each phase, verify against the current GTK app:
1. **Phase 1**: Real `noollama` fixtures round-trip without dropping unknown fields; backups are created before first write; Python rollback can still load the files.
2. **Phase 3**: Root/project terminals handle resize, process exit, fast-crash protection, large output, paste, Ctrl/Alt/meta input, URI detection, and task feed readiness.
3. **Phase 6**: External app/window tracking preserves `open_apps` compatibility and restores by best-effort launch/raise instead of embedding.
4. **Phase 7**: KDE Wayland uses one virtual desktop per project; KDE/Cinnamon/GNOME-ish X11 uses the two-workspace parking model; unsupported desktops use the null backend.
5. **Phase 8**: Download routing behavior is either fully preserved, including browser preferences, or documented as a deliberate regression.
6. Final: Rust schema tests, Rust unit tests, frontend component tests, and a live desktop QA matrix pass for KDE X11, KDE Wayland, Cinnamon X11, and GNOME/null.

---

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| JSON state corruption | Schema inventory, real fixtures, unknown-field preservation, backup-before-write, rollback test with the Python app |
| Tauri app-data path mismatch | Pin Linux state to `~/.local/share/eldrun/`; use Tauri path APIs only after verifying the generated path is identical |
| xterm.js performance vs VTE for large scrollback | Cap scrollback, batch output, use bounded channels, throttle IPC, and add large-output tests |
| PTY lifecycle gaps | Test resize, shell exit, child kill, fast crash loops, binary/invalid UTF-8 output, paste, Ctrl/Alt/meta input, and terminal-ready task feed |
| Frontend injection causing local file/app access | Keep command allowlists, canonical path validation, project-root confinement, symlink handling, and backend-side checks for destructive operations |
| XDG sandbox env on non-Linux | Treat XDG sandboxing as Linux-only; Windows/macOS shells need separate design before parity claims |
| KDE Wayland regression to X11 two-desktop model | Implement a dedicated per-project virtual desktop backend matching current Phase 6b behavior |
| X11 window embedding dropped | Redesign app tabs as external windows tracked by PID/window ID/desktop UUID where available; document restore as best-effort launch/raise |
| Downloads browser-pref editing | Either port Firefox/Chromium preference editing with backup/locking safeguards or document the omission as an intentional regression |
| Global apps reduced to simple opener calls | Preserve role registry, visibility toggles, launch-or-raise, sticky windows, screenshot handling, URI routing, and protected app names |
| Windows/macOS scope creep | Label non-Linux builds experimental until native default-app, window, download, and workspace integrations exist |
| `mime_guess` misses uncommon types | `infer` magic-byte sniffing covers binaries; for truly unknown types fall back to `"application/octet-stream"` — same behaviour as current `xdg-mime` fallback |
| `opener` not found on headless Linux | `opener` calls `xdg-open`; on headless CI just skip integration tests that open files |
| `tauri.conf.json` bundle targets | Set `targets: ["deb", "appimage"]` for Linux first; Windows/macOS packages wait for platform-specific scope decisions |
