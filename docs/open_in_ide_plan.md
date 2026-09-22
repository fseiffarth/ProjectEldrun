# Open a project in its IDE — plan

Status: plan only (copied here on approval, 2026-09-22).

## Context

A project that was set up in an IDE carries that IDE's footprint in its tree —
`.idea/` (JetBrains), `.vs/` + `*.sln` (Visual Studio), `.vscode/` /
`*.code-workspace` (VS Code). Eldrun can already launch external apps per
project (`commands/apps.rs`: `do_launch`, the window registry, the side panel's
Apps view, project-switch parking) but has no "open this project in the IDE it
belongs to" affordance; the user has to leave Eldrun and open the folder by
hand. The outcome: one click on a project → the right IDE opens on that
project, and the IDE window is tracked like every other project-opened window.

Nothing in the repo detects project markers today (`projectTypeTags` is the
git/remote axis, not language/IDE), so detection is new; launching, tracking,
settings and the menus are reused.

## Decisions

- **Marker-based, per project.** A project offers exactly the IDEs whose
  markers are present. No marker → no entry (no clutter, no guessing). A
  generic "open in any editor" fallback is a follow-up, not v1.
- **The exec never comes from the project tree.** The tree is
  attacker-controlled (AGENTS.md invariant). Detection reads only marker
  *names* plus one attribute (`type=` of `.idea/*.iml`) to pick a product; the
  program launched is resolved from installed apps / PATH / the user's own
  override in `settings.json`, never from anything inside the folder. The
  project directory itself comes from `projects.json` via
  `services::remote::project_directory`, not from the frontend.
- **Override lives in settings, not in `global_apps`.** `global_apps` roles are
  toolbar buttons with project-less launches; an IDE launch needs the project
  dir. New key `settings.ide_launchers: { [ideId]: exec }` (empty by default).
  Per-project pinning is not needed: the marker already says which IDE.
- **Remote projects open the local lockstep mirror** — the same folder
  `pill.showOnDisk` reveals (`remote_mirror_status` / `remote_sync::mirror_dir`).
  Detection runs on the mirror, so no SSH probe, nothing to gate on
  connected. VS Code Remote-SSH / JetBrains Gateway are a follow-up.
- **Launched IDE windows are project-owned**: new origin `project_ide` added
  to `is_project_opened_origin`, so the window shows in the Apps view and
  parks on project switch like a file opened from the tree. `code` / JetBrains
  launchers that hand off to a running instance already land in the pid-0
  `KeepDemoted` path (`launched_exit_action`).
- **Two entry points, one component**: the project pill's context menu (View
  group, under "Show on disk") and the side panel file tree's root context
  menu (next to "Open in a new tab"). Both render the same `IdeMenuItems`.

## Detection table (`services/ide_detect.rs`, AppHandle-free)

| Marker (top level of the project dir)                       | ide id           | Target passed to the launcher |
|-------------------------------------------------------------|------------------|-------------------------------|
| `.idea/` + `.idea/*.iml` `type="PYTHON_MODULE"`              | `pycharm`        | dir |
| `.idea/` + `.iml` `type="CPP_MODULE"` or `CMakeLists.txt`    | `clion`          | dir |
| `.idea/` + `.iml` `type="WEB_MODULE"`                        | `webstorm`       | dir |
| `.idea/.idea.<Name>/` (Rider's shape) or `.idea/` + `*.sln`  | `rider`          | `.sln` if exactly one, else dir |
| `.idea/` + `Cargo.toml`                                      | `rustrover`      | dir |
| `.idea/` + `go.mod`                                          | `goland`         | dir |
| `.idea/` otherwise                                           | `idea`           | dir |
| `.vs/` or `*.sln` / `*.slnx`                                 | `visual_studio`  | the `.sln` if exactly one, else dir |
| `.vscode/` or `*.code-workspace`                             | `vscode`         | `.code-workspace` if exactly one, else dir |

All JetBrains ids share one family (`jetbrains`) so a missing product launcher
falls back to any installed JetBrains IDE (`idea`, Toolbox's generic scripts)
before reporting "not found". `.vs/` is Visual Studio's per-user cache, so the
`.sln` is what gets opened; on Linux/macOS `visual_studio` is offered only when
Rider or VS Code can take the `.sln` (resolver falls through the family list
`rider → vscode`), otherwise it is listed unresolved.

Extras (`.fleet/`, `.zed/`, `*.xcodeproj`/`*.xcworkspace` → `open -a Xcode`,
Eclipse `.project`+`.classpath`, `*.sublime-project`) are one table row each
later; the table is data, not code paths.

## Resolution (`ide_detect::resolve_launcher(ide_id) -> Option<Launcher>`)

Order, first hit wins; result cached per process like `ICON_CACHE`, cleared
when `ide_launchers` changes:

1. `settings.ide_launchers[ide_id]` (user override, exec string).
2. PATH lookup of candidate binaries (per id: `pycharm`, `pycharm-professional`,
   `pycharm-community`, `charm`; `idea`, `intellij-idea-ultimate`…; `code`,
   `code-insiders`, `codium`, `cursor`; `rider`; `clion`; `rustrover`; …).
3. JetBrains Toolbox scripts dir: `~/.local/share/JetBrains/Toolbox/scripts`,
   `%LOCALAPPDATA%\JetBrains\Toolbox\scripts`,
   `~/Library/Application Support/JetBrains/Toolbox/scripts`.
4. `list_installed_apps()` (already scans `.desktop` incl. Flatpak/Snap
   exports, Windows Start-Menu `.lnk`, macOS bundles) matched on
   name/exec-basename patterns per id (`jetbrains-pycharm`,
   `com.jetbrains.PyCharm-*`, `com.visualstudio.code`, "Visual Studio Code",
   "PyCharm Professional", …). Pure matcher `pick_installed(id, &[InstalledApp])`
   so it is unit-testable on any OS.
5. Windows only, `visual_studio`: `vswhere.exe -latest -property productPath`
   under `%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\`.

`Launcher { exec, display_name, source }`; `exec` may be a multi-word
Flatpak line — `do_launch` → `split_exec_command` already handles that.

## Commands (`commands/ide.rs`, registered in `lib.rs`)

- `detect_project_ides(projectId) -> Vec<IdeCandidate>`
  `{ id, family, label, markerPath, target, exec: string|null, displayName: string|null }`.
  Resolves the dir (`project_directory`; for a remote project
  `remote_sync::mirror_dir`, only when it exists), runs detection, resolves
  each candidate's launcher. Cheap: a handful of `exists` checks plus one
  top-level `read_dir` for `*.sln`/`*.code-workspace`; called on menu open, no
  caching of the detection itself.
- `open_project_in_ide(projectId, ideId) -> TrackedWindow`
  Re-runs detection server-side (never trusts a frontend path), then
  `do_launch(registry, &launcher.exec, &[], Some(&target), Some(project_id),
  Some("ide"), ORIGIN_PROJECT_IDE)` via `run_off_thread`. Windows `.sln` with
  `devenv.exe` and macOS `.app` bundles go through the existing
  `launch_command` branches unchanged.
- `set_ide_launcher(ideId, exec: string|null)` — writes
  `settings.ide_launchers`, clears the resolver cache.

`apps.rs`: add `ORIGIN_PROJECT_IDE = "project_ide"` and include it in
`is_project_opened_origin` (+ its existing test).

`schema/settings.rs`: `ide_launchers: Option<HashMap<String, String>>`
(`skip_serializing_if`, round-trips old files untouched). `src/types/index.ts`
`Settings` gets the matching optional field.

## Frontend

- `src/components/projects/IdeMenuItems.tsx` (new): takes `projectId`,
  `onClose`; on mount invokes `detect_project_ides`; renders one
  `<button>` per candidate:
  - resolved → `t("pill.openInIde", { ide: displayName })`, click →
    `open_project_in_ide`, then `useWindowsStore.refresh(projectId)`.
  - unresolved → same label with `globalApps.notFoundPlaceholder` suffix,
    click → native file picker (`open({ directory: false })`, same as
    `GlobalAppBar.browseExecutable`) → `set_ide_launcher` → relaunch.
  - Right-click on a resolved row → "Choose executable…" (same picker) and
    "Use auto-detected" (clears the override). Title shows the resolved exec.
  - Renders nothing when the list is empty, so neither menu gains a group
    for marker-less projects.
  - Each button carries `<UntestedTag id="projectPill.openInIde" />` and the
    `untested` class, like `projectPill.1`.
- `ProjectPill.tsx` (~line 1951, View group): `<IdeMenuItems …/>` right after
  the "Show on disk" button. Pill already knows `project.remote`; mirror
  handling stays in the backend.
- `FileTree.tsx` root context menu (~line 4318, before the `<hr/>` after
  "Open in a new tab"): same component, gated on `treatLocal`-independent
  because the mirror path is resolved backend-side; only needs a project id
  (available as `scope`/project prop).
- i18n (`src/lib/i18n.ts` + `i18nDicts/{de,fr,es,it}.ts` — the shell i18n
  test requires every language to cover every English key):
  `pill.openInIde` "Open in {ide}", `pill.openInIdeTitle`,
  `pill.ideChooseExecutable` "Choose {ide} executable…",
  `pill.ideUseDetected` "Use the detected {ide}".
- `src/lib/untested.ts`: row `"projectPill.openInIde": { area: "projects",
  what: "ProjectPill / FileTree · Open in <IDE>" }`.
- Nothing new in Zustand; the windows store already refreshes from the
  `app-windows-changed` event.

## Ordered steps

1. Copy this plan to `docs/open_in_ide_plan.md`.
2. `src-tauri/src/services/ide_detect.rs`: marker table, `detect(dir)`,
   `pick_installed`, `resolve_launcher`, candidate tables per OS behind `cfg`
   where they differ (PATH names are the same list everywhere; Toolbox dir and
   `vswhere` are the only cfg pieces). Unit tests with `tempfile`: each row of
   the table, several markers at once, `.sln` count 1 vs 2, nothing detected,
   installed-app matching per id. Add `mod ide_detect;` to `services/mod.rs`.
3. `schema/settings.rs` `ide_launchers` + round-trip test alongside the
   `global_apps` one (~line 1235).
4. `commands/apps.rs`: `ORIGIN_PROJECT_IDE`, extend `is_project_opened_origin`.
5. `commands/ide.rs`: the three commands; register in `lib.rs` next to
   `commands::apps::list_installed_apps` (~line 1831).
6. Frontend: types, i18n (5 dicts), `untested.ts`, `IdeMenuItems.tsx`, wire
   into `ProjectPill.tsx` and `FileTree.tsx`.
7. Tests: `src/__tests__/projects/ProjectPillIdeMenu.test.tsx` modelled on
   `ProjectPillPublishMenu.test.tsx` — mock `invoke` for `detect_project_ides`
   returning a resolved and an unresolved candidate; assert both rows, the
   "(not found)" suffix, and that clicking a resolved row invokes
   `open_project_in_ide` with the ide id.
8. File maps: one row each for `services/ide_detect.rs`, `commands/ide.rs`
   (`docs/filemap_backend.md`) and `IdeMenuItems.tsx`
   (`docs/filemap_frontend.md`).
9. `npm run backend:stale` after the Rust edits; report its result.

## Verification

Gates (all at zero warnings): `npm run build`, `npm test`,
`cargo test --manifest-path src-tauri/Cargo.toml`, `npm run lint`,
`cargo clippy … --all-targets -- -D warnings`, `git diff --check`.

Live (user, after the backend is rebuilt — not run by the agent):
1. Right-click a project pill that has `.idea/` → View group shows
   "Open in PyCharm" (or the product the `.iml` names); click → the IDE opens
   on that folder; the side panel's Apps view lists it; switching projects
   parks it, switching back shows it.
2. Same on a project with `.vscode/` → "Open in Visual Studio Code"; with a
   `*.code-workspace` the workspace opens, not the bare folder.
3. A project with both markers shows both rows; a project with none shows no
   IDE rows at all.
4. A project whose IDE is not installed shows the "(not found)" row; picking
   an executable stores it in settings and launches; "Use the detected …"
   clears it.
5. Windows: a `.sln` project offers Visual Studio via `vswhere`; opens the
   `.sln`. Linux: the same project offers Rider / VS Code instead.
6. Remote project: the row opens the local mirror; absent mirror → no rows.

## Out of scope (follow-ups)

- Generic "open in editor" for marker-less projects.
- VS Code Remote-SSH / JetBrains Gateway for remote projects.
- A toolbar button that opens the *active* project's IDE.
- Extra IDE rows (Fleet, Zed, Xcode, Eclipse, Sublime).
