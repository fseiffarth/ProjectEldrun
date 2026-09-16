# OS parity sweep — merged plan (2026-09-16)

Outcome of a six-voice review: round 1 had one auditor per OS (Linux,
Windows, macOS) inventory features and propose updates; round 2 had one
reviewer per OS adversarially re-verify all round-1 proposals against the code
and check each one's cross-OS impact. This document merges both rounds into
the list that was implemented on branch `os-parity-sweep`, the constraints the
reviewers attached, and what was deferred and why.

Nothing here was run on Windows or macOS hardware. Every user-visible item is
untested live; QA lines live in `todo/group-h-crossplatform.md`.

## Refuted or narrowed in round 2

| Round-1 claim | Round-2 verdict |
|---|---|
| Intel iGPUs missing on Linux is a bug | Refuted — documented choice (`vram_total` absent is not a zero). Deferred. |
| Windows needs a logoff/shutdown hook | Mostly refuted — tao 0.35 maps `WM_ENDSESSION` to `RunEvent::Exit` already. Residual: the ~5 s shutdown budget, needs hardware. |
| Mobile on Windows mints tmux sessions for local tabs | Refuted — `CenterPanel.tsx` already disables local persistence on Windows. Only the silent empty `tmux ls` remains. |
| ⌘C/⌘V broken in xterm on macOS | Refuted — Tauri's default Edit menu dispatches `copy:`/`paste:`; an explicit handler would double-paste. Any custom menu must keep Edit. |
| ⌘W on macOS kills the session abruptly | Corrected — it runs AppShell's full clean quit, which is still the wrong outcome for "close tab". |
| Image build should use the `default` shell on Windows | Wrong — `default` is cmd.exe, which does not honour `'…'` quoting. Use PowerShell plus OS-aware quoting. |
| Seatbelt should allow `/dev/ttys*` | Dropped — lets a fenced agent write into other tabs' terminals. |
| Fenced macOS agents need `~/Library/Keychains` read | Deferred — exposes the offline-crackable keychain blob; mach access to securityd is already open. Needs a Mac probe. |
| X11 backend on every X11 session | Deferred — `try_new` adds a WM workspace that survives a crash (persisted to xfconf on XFCE). Needs live XFCE/MATE/i3. |
| `PR_SET_PDEATHSIG` / `tail --pid` for the presenter inhibitor | Replaced — PDEATHSIG follows the forking *thread*; use a stdin pipe to `cat`. |

## Implemented list

Two implementers with disjoint file ownership (see "Ownership").

### Track A — platform, window, keyboard, config

- **A1 Presenter inhibitor dies with Eldrun (Linux, S/M).** `systemd-inhibit …
  cat` with `Stdio::piped()` stdin held in `Inhibitor::Child`; pure
  `linux_inhibit_argv`; `presenter_release_sleep()` in `RunEvent::Exit`
  (Windows arm: drop the sender only, no `join`). Fix the false comments and
  the `src-tauri/CLAUDE.md` presenter row.
- **A2 Per-window renderer reload cap (all OSes, S).** One pure budget helper;
  Linux/Windows hooks get a per-call counter moved into the closure, macOS a
  label-keyed map. Linux keeps the `TerminatedByApi` return before counting.
- **A3 Panel-toggle copy follows the desktop (Linux, S).** Delete
  `PANEL_TOGGLE_KEY`; use `livePanelToggleKey()`; `HowToStart` awaits
  `probeSuperKeyOwnership()`. Linux value stays byte-identical.
- **A4 Say when the desktop cannot park windows (Linux, M).** Trait method
  `can_park()` (default `true`, `NullBackend` `false`, KDE Wayland per its
  real ability) so no `macos.rs` edit; `workspace_capabilities` command; one
  Settings sentence with `UntestedTag`, Linux-only; key in all five dicts.
  Remove or reuse the dead `workspace_info` call in `HeaderBar.tsx`.
- **A5 One Wayland predicate + platform docs (Linux, S).** `apps.rs` and
  `platform/mod.rs` use `x11::session_is_wayland()` inside
  `#[cfg(target_os = "linux")]` blocks (a bare `cfg!` breaks the Windows
  build). Fix `mod.rs` detection doc, `wayland_kde.rs` sticky/KDE-5 claims and
  the `src-tauri/CLAUDE.md` rows (wayland_kde, browser `LIVE_SUPPORTED` true on
  Windows).
- **A6 deb metadata (Linux, S).** Drop `libappindicator3-1` (unused, universe
  on 26.04); add `recommends` bubblewrap/tmux/cups-client.
- **A7 Explicit macOS menu (macOS, M).** `cfg(target_os = "macos")` only;
  App (About, Services, Hide, Hide Others, custom Quit → `main.close()`), Edit
  (mandatory), Window (Minimize, Fullscreen). No `close_window`. Pure
  `macos_menu_plan()` under `cfg(any(macos, test))` with Linux tests.
- **A8 ⌘W from focused editors (macOS, S).** Gate strictly on
  `IS_MAC && metaKey && !ctrlKey`; covers `useKeyboard.ts` and
  `DetachedCenterPanel.tsx`. Ctrl+W must still reach terminals on Linux and
  Windows; ⌃W on macOS too.
- **A9 macOS window stays hidden until restore (S).** `"visible": false` in
  `tauri.macos.conf.json` (RFC 7396 replaced the array); Rust test reading
  the JSON.
- **A10 Staged clippy on macOS CI (S).** `components: clippy` + clippy step
  with `continue-on-error: true`.
- **A11 Stale comment** `lib.rs` signal block: logoff/shutdown reach
  `RunEvent::Exit` via tao.

### Track B — files, sandbox, downloads, mobile, fence

- **B1 Rename falls back to copy+delete only when it must (all OSes, S/M).**
  `paths::is_cross_device(e)` = `kind() == CrossesDevices`, plus cfg-gated
  raw 18 (unix) / 17 (windows) — never compare raw codes across OSes (17 is
  `EEXIST` on Linux). `move_tree` falls back on `is_cross_device || dst.exists()`
  to keep interrupted-archive resume; `fs.rs` and the other two `projects.rs`
  sites return the rename error otherwise.
- **B2 Container orphan sweep on Windows (S).** Replace `!cfg!(unix)` with
  `!paths::binary_on_path("docker")`; pure gate + test; fix the comment.
- **B3 Image build shell and quoting (Windows, S).** Pure
  `install_shell_quote(path, windows)`; frontend passes
  `IS_WINDOWS ? "powershell" : "bash"` in `ProjectPill.tsx`/`ProjectDialog.tsx`.
- **B4 Download marking (Windows + macOS, M).** `web_safety::mark_downloaded`:
  Windows writes `:Zone.Identifier` (`ZoneId=3`, `HostUrl=about:internet`)
  only if absent, best-effort; macOS sets `com.apple.quarantine` via
  `libc::setxattr`; no-op elsewhere. Callers: mail attachment saves, browser
  download move. No new path-taking command.
- **B5 Sidecar tmux through Eldrun's PATH (all OSes, S).** `command_no_window`
  for `ls`/capture/window-size; the portable-pty attach gets an absolute
  resolved tmux and `PATH=effective_path()` but **no** creation flags.
- **B6 Honest Mobile terminals on Windows (S).** `cfg(windows)` early return in
  discovery; one `MobileSettings` note with `UntestedTag`.
- **B7 Tailscale app-bundled CLI (macOS, S).** Pure `tailscale_program`
  with injected `exists`; Windows `%ProgramFiles%\Tailscale\tailscale.exe`
  fallback.
- **B8 Seatbelt device writes (macOS, S).** Allow `/dev/null`, `/dev/zero`,
  `/dev/tty`, `/dev/dtracehelper`, `(subpath "/dev/fd")` right after
  `(deny file-write*)`; no `ttys`; fix the doc comment.
- **B9 Container CLIs on macOS PATH (S).** macOS arm only: `~/.docker/bin`,
  `~/.orbstack/bin`, `/Applications/Docker.app/Contents/Resources/bin`.
- **B10 Distro-aware fence install hint (Linux, M).** Pure
  `package_install_cmd(os_release, pkg)`; bubblewrap only in v1; the pill hides
  the button when `None`.
- **B11 Clear the Windows dead-code warnings (M).** Narrow to
  `cfg(any(<real OSes>, test))`; helpers used by `sandbox_exec_inputs` keep
  `target_os = "macos"`. No blanket `allow`.
- **B12 macOS fence limits in docs (S).** `docs/context/agent_authority.md`
  (mach/securityd reachable) and `README.md` (`xattr -dr
  com.apple.quarantine` for the unsigned DMG).

### Ownership

Track A owns `lib.rs`, `commands/presenter.rs`, `platform/*`,
`commands/apps.rs`, `commands/workspace.rs`, `tauri*.conf.json`, the CI
workflow, `src-tauri/CLAUDE.md`, `src/lib/hints.ts`, `SettingsPanel.tsx`,
`HowToStart.tsx`, `useKeyboard.ts`, `DetachedCenterPanel.tsx`,
`HeaderBar.tsx`. Track B owns `paths.rs`, `commands/fs.rs`,
`commands/projects.rs`, `services/sandbox.rs`, `services/agent_fence.rs`,
`services/web_safety.rs`, `commands/mail.rs`, `commands/browser.rs`,
`services/mobile_control/*`, `MobileSettings.tsx`, `ProjectPill.tsx`,
`ProjectDialog.tsx`, the B11 files, `docs/context/agent_authority.md`,
`README.md`. `src/lib/i18n.ts` and its dicts are shared (small, separate
edits). This plan and `todo/` are the coordinator's.

## Deferred

| Item | Why |
|---|---|
| X11 backend on any X11 session | Mutates WM workspace count, survives crashes; needs live XFCE/MATE/i3. |
| KDE Wayland `info()` via D-Bus properties | Needs live KWin; invisible until A4 consumes it. |
| Intel/xe iGPU readout | Design choice; `vram_total: Option` ripples through TS and the remote parser. |
| GNOME projector blanking via portal Inhibit | Needs a live GNOME check. |
| Distro hints beyond the fence | Nothing else fails closed. |
| Windows renderer restart | WebView2 shares renderers across same-origin windows; one kill may take all. |
| Container credential freshness on Windows | Needs Docker Desktop to see whether rename-over propagates. |
| Windows shutdown time budget | Measure teardown on hardware first. |
| Roaming `%APPDATA%` state dir | Needs a migration; niche. |
| Phone-side "no terminals on Windows" copy | New mobile API field + mobile-web i18n. |
| Job Object for ConPTY children | Needs hardware to see current crash reaping. |
| Keychain file read for fenced Claude on macOS | Security trade-off; probe on a Mac first. |
| Login-shell PATH import on macOS | Runs user rc files; fixed dirs cover known tools. |
| `macOptionIsMeta`, ⌘\ panel toggle, fullscreen restore | Product decisions; breaks international Option input. |
| `NSLocalNetworkUsageDescription`, richer macOS crash log | Optional / low value vs. signal-handler risk. |
