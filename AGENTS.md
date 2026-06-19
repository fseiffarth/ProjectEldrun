# ProjectEldrun

## Purpose

ProjectEldrun, or Eldrun, is a Tauri desktop workspace for AI-assisted
development. It manages a root control terminal, one terminal per active
project, a bottom project switcher, a right-side project file browser, global
app launching, file opening, time tracking, and optional workspace backend
integration.

## Current Architecture

- The frontend is React/TypeScript under `src/`.
- The Tauri/Rust backend is under `src-tauri/`.
- Frontend layout lives mainly in `src/components/layout/`, especially
  `AppShell.tsx`, `HeaderBar.tsx`, `CenterPanel.tsx`, `RightPanel.tsx`,
  `ProjectSwitcher.tsx`, and `GlobalAppBar.tsx`.
- Terminal UI lives in `src/components/terminal/TerminalView.tsx`; terminal
  backend commands live in `src-tauri/src/commands/terminal.rs` and
  `src-tauri/src/terminal/`.
- File browsing UI lives in `src/components/files/`; filesystem commands live
  mostly in `src-tauri/src/commands/projects.rs`.
- External app launching and tracked windows live in
  `src-tauri/src/commands/apps.rs`.
- Settings and persisted schema types live in `src/stores/`, `src/types/`, and
  `src-tauri/src/schema/`.
- Workspace integration lives in `src-tauri/src/platform/`. X11 and KDE
  Wayland paths are best-effort; unsupported desktops fall back to the null
  backend.

## State And Project Conventions

- Managed projects normally live under `~/eldrun/projects/<sanitized-name>/`.
  The root terminal uses `~/eldrun/root/`.
- Global state lives in `~/.local/share/eldrun/`, especially `projects.json`,
  `settings.json`, `default_apps.json`, `time_log.json`, and
  `active_session.json`.
- Project-local state lives in each project's `project.json`; current open-app
  metadata is stored in `project.json["open_apps"]`.
- New/imported projects are scaffolded with `AGENTS.md`, `CLAUDE.md`,
  `GEMINI.md`, `.claude/settings.json`, `.gitignore`, `TODO.md`, `ROADMAP.md`,
  `STATUS.md`, and `DOCUMENTATION.md`.
- `TODO.md` uses grouped IDs such as `G1.1`. When adding a TODO, place it in
  the matching group, create a new group if no current group fits, or merge
  groups if the TODO depends on distinct areas that should be tracked together.
- Avoid unrelated rewrites in docs, generated state, built assets, project
  metadata, `dist/`, `target/`, and backup files.

## Development Workflow

- Prefer small, focused changes that match the existing React/TypeScript and
  Rust/Tauri style.
- Use `rg` for code search.
- Do not launch Eldrun from an agent terminal for verification. Opening a
  second Eldrun instance can corrupt workspace state; ask the user to run or
  restart the existing instance when runtime validation is needed.
- Do not run `npm run tauri`, `npm run dev`, `cargo tauri dev`, or
  `./start-eldrun-tauri.sh` unless the user explicitly asks and confirms it is
  safe to launch a new instance.
- When changing frontend behavior, prefer local component state and existing
  Zustand stores over adding new global state.
- When changing backend commands, keep Tauri command payload names compatible
  with the camelCase keys used by the frontend.
- Preserve Python-era JSON shapes where the Rust schema already supports them;
  existing user state should round-trip cleanly.

## Verification

Before handing off code changes, run the checks that apply to the files you
changed:

```bash
npm run build
```

```bash
cd src-tauri && cargo test
```

If `cargo` is unavailable in the environment, state that clearly in the final
handoff. For whitespace checks, also run:

```bash
git diff --check
```

Every push to GitHub should generate a new packaged artifact from
`.github/workflows/ci-cd.yml`; the local equivalent is `npm run package`,
which installs the packaged AppImage outside the checkout so branch switches
do not affect the running app. GitHub Releases are only published for
`v0.<minor>.0` tags, so patch-only bumps like `0.1.1 -> 0.1.2` do not create
new releases.

## Running Locally

Human-only by default. Agents must not run these commands while an Eldrun
instance may already be active.

Preferred Tauri launcher:

```bash
./start-eldrun-tauri.sh
```

Development run:

```bash
npm run tauri dev
```
