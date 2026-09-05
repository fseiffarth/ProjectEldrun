## Group H — Cross-Platform: Windows & macOS Support (new feature)
*Files: `src-tauri/src/platform/*`, `services/`,
`terminal/` (PTY), `commands/` (downloads, crash logging), `src-tauri/tauri.conf.json`
(bundle targets), `.github/workflows/ci-cd.yml` (package jobs). Both OSes already
have cross-platform foundations — platform-aware state paths, default-shell
fallback, browser profile paths, network detection — so this is follow-up work,
not a from-scratch port. Builds on / supersedes the OS half of #19 (Group C).*

*Intentional gaps (decided, not forgotten — do not re-open without new facts):*
- *Windows:* `make_sticky` (no public show-on-all-desktops API), window
  **embedding** (no safe cross-process reparenting), ControlMaster and with it
  the ssh-link monitor + `net_usage` sampler (Win32-OpenSSH has no mux support).
- *macOS:* window **embedding** (impossible), **per-window** parking of foreign
  apps (only app-granularity `NSRunningApplication hide/unhide`; per-window needs
  private CGS/SkyLight APIs — rejected as build-fragile), popout self-parking
  (hiding our own app would hide the MAIN window — deferred), `make_sticky`
  (no public Spaces API), system-monitor process table limited to the calling
  user's processes when unprivileged (`proc_pidinfo` visibility).
- *Both:* the network pane's per-connection table (interfaces only; an
  explanatory warning is shown in the pane).

30. **Windows support follow-ups.** Windows is past the compile stage (state
    paths, shell fallback, browser profiles, network detection, app-icon
    helpers, NSIS packaging, and a Windows CI package job all exist). Native
    window tracking/parking (`EnumWindows` + SW_HIDE model, `windows.rs` +
    pure `windows_park.rs`), the PID liveness API (30c), and the
    unhandled-exception crash hook (30g) are all built now. Remaining:
    validate a real build/runtime on Win 10 1903+ and Win 11 (incl. ConPTY
    behavior in xterm.js). (Browser download-preference editing was removed —
    Eldrun no longer touches any browser's download path; see #60.)

    **Cross-platform detection audit (2026-06-27).** A sweep for Linux-only code
    paths that broke on Windows, fixing the directly-portable ones and tracking
    the rest as the sub-items below.
    - [x] **30a — Cross-platform binary detection.** ✅ Done. Every "is this CLI
      installed?" probe hardcoded `Command::new("which")`, which does not exist on
      Windows, so all agents (Claude included), the TeX toolchain, `sshfs`,
      `sshpass`, and `openvpn`/`pkexec` reported as missing. Centralized one
      `crate::paths::binary_on_path` (`where` on Windows, `which` elsewhere, via
      `paths::path_finder(OsKind)`); `commands/agents.rs`, `commands/tex.rs`,
      `commands/ollama.rs`, `services/ssh_mount.rs`, `services/openvpn.rs` all
      route through it. Agent extra-path fallback also matches Windows exe
      extensions (`.exe`/`.cmd`/`.bat`/`.ps1`).
      - [x] 🤖 Automated test — `paths::path_finder_is_where_on_windows_which_elsewhere`
      - [ ] 🖐️ Manual test — "Manage agents" lists installed agents on Windows
        - [ ] ✅ Works
        - [ ] ❌ Doesn't work
    - [x] **30b — Cross-platform per-process CPU/RSS sampling.** ✅ Done. `sysstat`
      was entirely `#![cfg(target_os = "linux")]`, so `project_cpu_percent` and
      `debug_app_resource_usage` returned 0 on Windows. Refactored into a shared
      cache/BFS layer over a per-OS backend: Linux `/proc`, **Windows** ToolHelp
      snapshot (`CreateToolhelp32Snapshot`) for the process tree +
      `GetProcessTimes` (kernel+user, 100-ns units) + `GetProcessMemoryInfo`
      (working set), and a zero fallback for other OSes. CPU "ticks"/`clk_tck()`
      abstraction keeps the caller's `busy_secs = ticks / clk_tck()` formula valid
      on every backend. Added `Win32_System_{Diagnostics_ToolHelp,ProcessStatus,
      Threading}` to the `windows` crate features. `terminal.rs`/`debug.rs` no
      longer gate on Linux.
      - [x] 🤖 Automated test — `sysstat` tests now run on Windows too
        (`sum_jiffies`/`sum_rss_kib` against the live process, tree walk, cache)
      - [ ] 🖐️ Manual test — pill popup shows live CPU/RSS on Windows
        - [ ] ✅ Works
        - [ ] ❌ Doesn't work
    - [x] **30c — Native PID liveness.** ✅ Done. `check_pid_alive`
      (`commands/apps.rs`) no longer shells out to `tasklist` on Windows; it uses
      `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)` + `GetExitCodeProcess`,
      treating `STILL_ACTIVE` (259) as alive (a handle to an exited process still
      opens, so the exit code must be inspected — not just OpenProcess success).
      Linux `/proc` and macOS/Unix `kill(pid,0)` branches unchanged.
      - [x] 🤖 Automated test — covered by `cargo build --lib` compile + existing
        callers; no behavioral unit test (needs a live pid)
      - [ ] 🖐️ Manual test
        - [ ] ✅ Works
        - [ ] ❌ Doesn't work
    - [x] **30d — App discovery + launching on Windows.** ✅ Done. Linux XDG
      `.desktop` discovery is gated behind `cfg(not(windows))`; Windows now enumerates
      Start-Menu `.lnk` shortcuts (`%ProgramData%` + `%APPDATA%`, recursive, deduped
      by resolved target) for `list_installed_apps`, resolves targets/icons via the
      existing `IShellLinkW` scaffold, and `run_script_detached` runs `.ps1` via
      `powershell -NoProfile -ExecutionPolicy Bypass -File` and `.bat`/`.cmd`/assoc
      via `cmd /C` instead of `bash`. Launch/open/embed commands keep their
      signatures. Degrades gracefully: `xdg-mime` handler resolution no-ops (falls
      back to configured/explicit handlers), icon rasterization is best-effort, and
      `os_embeddable` is false (no Windows embedding backend yet).
      - [x] 🤖 Automated test — `cargo test --lib apps` (incl. a Windows-gated
        interpreter-selection test) passes
      - [ ] 🖐️ Manual test
        - [ ] ✅ Works
        - [ ] ❌ Doesn't work
    - [x] **30e — Screenshot capture on Windows.** ✅ Done. `commands/screenshot.rs`
      refactored to a cfg-selected `platform` submodule (Linux tool-spawn unchanged).
      Windows uses native Win32 GDI — `GetSystemMetrics(SM_*VIRTUALSCREEN)` for the
      full multi-monitor virtual screen, `GetDC`/`CreateCompatibleDC`/`BitBlt`/
      `GetDIBits`, BGRA→RGBA, then PNG-encoded via the existing `png` crate to a
      timestamped file (same public command + output dir as Linux). All GDI handles
      freed on success and error paths. Added `Win32_Graphics_Gdi`.
      - [x] 🤖 Automated test — shared filename/date tests retained; build verified
      - [ ] 🖐️ Manual test
        - [ ] ✅ Works
        - [ ] ❌ Doesn't work
    - [x] **30f — VPN-gated projects on Windows.** ✅ Done — and since upgraded
      twice: first from the original graceful-degradation stub to a **real
      backend** (direct `openvpn.exe` spawn — worked only from an elevated
      Eldrun), then (2026-07-16) to an **unelevated interactive-service flow**:
      `connect_streaming` now asks `OpenVPNServiceInteractive` over
      `\\.\pipe\openvpn\service` first (UTF-16LE startup message; the SYSTEM
      service spawns `openvpn.exe` with the user's token and does the
      privileged adapter/route work itself via `--msg-channel`), readiness is
      tailed from `--log` via the shared `wait_for_ready_logfile`, and teardown
      is a user-level `taskkill` + dropping the control pipe (the service
      reverts routes via its undo lists — and kills the tunnel if Eldrun dies,
      so it can't outlive the app). Non-admins need one-time membership in the
      "OpenVPN Administrators" local group (the refusal message says exactly
      that, with the `net localgroup` one-liner); the direct spawn remains only
      as fallback when the service is missing. Windows `disconnect` also gained
      the `disconnect_interactive` call Linux/macOS always had. Linux pkexec
      path unchanged.
      - [x] 🤖 Automated test — `cargo test --lib openvpn` passes on Windows
        (svc startup-message encoding, reply parsing, cmdline quoting)
      - [ ] 🖐️ Manual test — connect a VPN-gated project from an *unelevated*
        Eldrun with `OpenVPNServiceInteractive` running (expect the group-
        membership refusal first if not in "OpenVPN Administrators")
        - [ ] ✅ Works
        - [ ] ❌ Doesn't work
    - [x] **30g — Windows crash hook** (2026-07-11; ✅ Done · 🧪 CI-unverified).
      The native-fault analog of the Unix signal handlers: `install_seh_filter`
      (`lib.rs`) opens crash.log at startup, keeps the raw HANDLE in
      `CRASH_LOG_HANDLE`, and registers a `SetUnhandledExceptionFilter` that
      `WriteFile`s one `=== CRASH: code=0x… addr=0x… ===` line before returning
      `EXCEPTION_CONTINUE_SEARCH`. Formatting is allocation-free via the
      un-gated `format_crash_line` (the heap may be corrupt mid-crash). Added
      `Win32_System_{Diagnostics_Debug,IO,Kernel}` features.
      - [x] 🤖 Automated test — `format_crash_line_*` (4 tests, run on Linux)
      - [ ] 🖐️ Manual test — force a native crash on Windows; crash.log gains a
        `=== CRASH:` line with the exception code
        - [ ] ✅ Works
        - [ ] ❌ Doesn't work
    - [x] **30h — Windows whole-system monitor** (2026-07-11; ✅ Done · 🧪
      CI-unverified). `sysstat.rs` Windows backend fills a real
      `SystemSnapshot`: aggregate CPU via `GetSystemTimes` (kernel includes
      idle), per-core via a manual `NtQuerySystemInformation(8)` extern decoded
      by the pure `parse_processor_perf_buffer`, memory/swap via
      `GlobalMemoryStatusEx` (swap = pagefile − physical, saturating),
      `GetTickCount64` uptime, one ToolHelp walk for the process table
      (`decode_ansi_nul` for names). All CPU counters stay 100-ns units so the
      frontend's per-process ÷ machine tick math keeps matching units; no load
      average on Windows (`[0.0; 3]`).
      - [x] 🤖 Automated test — `parse_processor_perf_buffer_*`,
        `decode_ansi_nul_*` (run on Linux)
      - [ ] 🖐️ Manual test — System Monitor pane shows live CPU/mem/processes
        on Windows
        - [ ] ✅ Works
        - [ ] ❌ Doesn't work
    - [x] **30i — Windows local network snapshot** (2026-07-11; ✅ Done · 🧪
      CI-unverified). `commands/network.rs` Windows `local_snapshot` via
      `GetIfTable2`: alias name (UTF-16, `utf16_nul_to_string`), octet
      counters, `OperStatus == Up`, ifType 24 = loopback; empty-alias filter
      rows skipped. Per-connection details stay `None` with a pane warning.
      The ssh-link monitor + `net_usage` sampler stay OFF on Windows by design
      (no ControlMaster mux — see the intentional-gaps register above).
      - [x] 🤖 Automated test — `utf16_alias_decoding_stops_at_nul` (Linux-run)
      - [ ] 🖐️ Manual test — Network pane lists adapters with live byte counts
        on Windows
        - [ ] ✅ Works
        - [ ] ❌ Doesn't work
    - [x] **30j — Windows SSH password auth via askpass** (2026-07-11; ✅ Done ·
      🧪 CI-unverified). Password auth no longer hard-requires `sshpass`: when
      the installed OpenSSH honors `SSH_ASKPASS_REQUIRE` (≥ 8.4 —
      `parse_openssh_version` + `version_supports_askpass_require`, probed once
      via `ssh -V` in `ssh_supports_askpass`), Eldrun writes an
      `ap-{pid}-{seq}.cmd` shim that echoes the secret through **PowerShell**
      from the child-only `ELDRUN_ASKPASS` env var (never `@echo %VAR%` — cmd
      would re-parse `& | < > ^` in a password). Win10-inbox OpenSSH 8.1 falls
      back to `sshpass`; with neither, a clear "needs OpenSSH 8.4+ or sshpass"
      error. All three password branches (probe, one-shot SFTP, pooled master)
      chain askpass → sshpass → error; `SshTooling.password_auth` and the
      dialog warning updated.
      - [x] 🤖 Automated test — `parses_openssh_version_banners`,
        `askpass_require_needs_openssh_8_4`,
        `windows_askpass_shim_echoes_env_without_cmd_interpolation` (Linux-run)
      - [ ] 🖐️ Manual test — password-SSH project connects without sshpass on
        Win11 (OpenSSH ≥ 8.4) and via sshpass on Win10 1903
        - [ ] ✅ Works
        - [ ] ❌ Doesn't work
    - [x] **30k — Windows position_window + popout occlusion** (2026-07-11; ✅
      Done · 🧪 CI-unverified). `platform/windows.rs` overrides
      `position_window` (`SetWindowPos` with `SWP_NOSIZE|SWP_NOZORDER|
      SWP_NOACTIVATE`) so a file-drop-launched app lands on the drop monitor,
      and adds `frontmost_window_under_cursor` (`GetCursorPos` →
      `WindowFromPoint` → `GA_ROOT`) wired into `detached_window_frontmost` so
      an occluded popout refuses a drop-merge (#42 parity with X11).
      - [x] 🤖 Automated test — compile-gated (`cargo check --target
        x86_64-pc-windows-msvc`); the pure occlusion logic is X11/macOS-side
      - [ ] 🖐️ Manual test — file drop places the app on the drop monitor; a
        popout behind the main window refuses the drop-merge
        - [ ] ✅ Works
        - [ ] ❌ Doesn't work

    - [x] **30l — Windows panel-toggle key: F9, not the Win key** (2026-07-15;
      ✅ Done). The lone-Meta panel toggle was enabled on Windows, but the lone
      Win key belongs to the OS: Start opens on key *release* at the shell
      level (`preventDefault()` can't stop it), and every global Win+X shortcut
      pressed while Eldrun is focused fired a lone "Meta" keydown first,
      spuriously toggling the panels. Lone Super is now Linux-only; Windows
      uses **F9** (`useKeyboard.ts`), and the onboarding/help copy
      (`hints.ts PANEL_TOGGLE_KEY`, `SettingsPanel.tsx`) says so.
      - [x] 🤖 Automated test — existing shortcut tests unaffected; behavior is
        a fixed key branch
      - [ ] 🖐️ Manual test — F9 toggles panels on Windows; Win+X no longer
        flickers them
        - [ ] ✅ Works
        - [ ] ❌ Doesn't work
    - [x] **30m — Windows one-click agent install** (2026-07-15; ✅ Done).
      `install_agent` hard-refused off Linux/macOS even though the registry
      already carried `install_cmd_windows` for most agents. Now
      `installer_command` picks the interpreter per command — PowerShell for
      `irm … | iex`, `cmd /C` for plain npm/python lines (which may chain with
      `&&`; Windows PowerShell 5.1 doesn't parse that) — with stdout+stderr
      merged in-shell as on Linux. The Manage Agents panel shows the Install
      button whenever the platform has a one-line installer (was `!IS_WINDOWS`);
      agents without one (Mistral/vibe, Cursor) keep the docs-link fallback.
      - [x] 🤖 Automated test —
        `windows_installer_command_picks_interpreter_per_command` (Windows-run)
      - [ ] 🖐️ Manual test — one-click install of an agent on Windows streams
        its log and flips to "installed"
        - [ ] ✅ Works
        - [ ] ❌ Doesn't work
    - [x] **30n — Windows disk-capacity probe** (2026-07-15; ✅ Done).
      `duscan::capacity_of` returned `None` on Windows, silently dropping the
      disk-usage pane's total/free capacity bar. Added a `#[cfg(windows)]` arm
      via `GetDiskFreeSpaceExW` (total + caller-available bytes, quota-aware —
      matching the Unix `f_blocks`/`f_bavail` semantics).
      - [x] 🤖 Automated test — `capacity_of_home_reports_a_plausible_volume`
        (runs on every OS)
      - [ ] 🖐️ Manual test — disk-usage pane shows the capacity bar on Windows
        - [ ] ✅ Works
        - [ ] ❌ Doesn't work
    - [x] **30o — no docker spawn at Windows startup** (2026-07-15; ✅ Done).
      Containers are Unix-only, but `sandbox::sweep_orphans` ran unconditionally
      at startup, spawning `docker --version` (and `docker ps` when Docker
      Desktop exists) for nothing on Windows. Now gated on `cfg!(unix)`.
      - [x] 🤖 Automated test — compile-covered; behavior is an early return
      - [ ] 🖐️ Manual test — n/a
        - [ ] ✅ Works
        - [ ] ❌ Doesn't work

31. **macOS support follow-ups.** macOS has initial cross-platform code (state
    paths, default shell, browser profiles, network detection, Unix symlinks),
    and native window tracking/parking now exists (31b — `CGWindowList` +
    `NSRunningApplication`, no Accessibility permission, no private APIs; it
    replaced the null-backend fallback). Remaining: add bundle support when
    distribution is needed (`dmg`/`app` target, `minimumSystemVersion`, CI
    artifact handling); add Hardened Runtime entitlements **only** if
    signing/notarization is pursued — do **not** enable App Sandbox (PTY needs
    unrestricted POSIX PTY access); validate a real build on Apple Silicon (and
    Intel if needed); add native app-icon resolution for `.app` bundles if the UI
    needs resolved macOS icons.
    - [~] **31a — Native CPU/RSS sampling backend.** ✅ Code-complete, ⚠️
      **unverified** (compiles only on macOS; written/reviewed on a Windows host).
      Added a `#[cfg(target_os = "macos")] mod platform` in `sysstat.rs` using
      libproc: `proc_pidinfo(PROC_PIDTASKINFO)` → `pti_total_user + pti_total_system`
      (nanoseconds; `clk_tck()` = 1e9) and `pti_resident_size` for RSS;
      `proc_pidinfo(PROC_PIDTBSDINFO)` → `pbi_ppid`; `proc_listallpids` for the tree.
      Fallback cfg narrowed to `not(any(linux, windows, macos))`. Callers
      (`terminal.rs`/`debug.rs`/`terminal/mod.rs`) are already cross-platform.
      - [ ] 🤖 Automated test — `sysstat` tests run on macOS (currently only
        compile-verifiable on a mac); no macOS CI yet
      - [ ] 🖐️ Manual test — needs a real macOS build to confirm the libc bindings
        (`proc_taskinfo`/`proc_bsdinfo`/`proc_listallpids`) resolve in pinned
        `libc 0.2`; if any is absent, add a minimal `extern "C"`/`#[repr(C)]` decl.
        - [ ] ✅ Works
        - [ ] ❌ Doesn't work
    - [~] **31b — macOS workspace backend** (2026-07-11; ✅ Code-complete, ⚠️
      **unverified** — compile-blind on Linux, no macOS SDK). macOS no longer
      falls to `NullBackend`: `platform/macos.rs` implements `WorkspaceBackend`
      over raw `extern "C"` FFI — `CGWindowListCopyWindowInfo` enumeration
      (id/pid/owner/layer/bounds need **no** Screen Recording permission) +
      `objc_msgSend` into `NSRunningApplication hide/unhide` (**no**
      Accessibility permission). Parking is **app-granularity** (per-window
      needs private CGS — rejected; see gaps register). Safety invariants:
      `pid == self` unconditionally never hidden (hide is app-wide → would take
      the MAIN window), protected owners (Dock/Finder/WindowServer/…) never
      hidden, cleanup/Drop unhides exactly what was hidden. Hidden apps leave
      the on-screen list, so hide time records window→pid in the pure, un-gated
      `macos_park::MacParkState`. Wiring: factory arm, `apps.rs` window
      resolvers (+ hide-time re-resolve on macOS like Windows), subwindow
      occlusion arm (popouts don't learn a CGWindowID yet), `lib.rs` binds the
      main window's `windowNumber`.
      - [x] 🤖 Automated test — full `macos_park` suite runs on Linux
        (protected-name matrix, structural main-window guard, park/show pid
        round-trip, `frontmost_at_point` occlusion cases)
      - [ ] 🖐️ Manual test — on a mac: project switch hides/shows foreign apps;
        Eldrun/Finder/Dock never hidden; quitting Eldrun unhides everything
        - [ ] ✅ Works
        - [ ] ❌ Doesn't work
    - [~] **31c — macOS whole-system monitor** (2026-07-11; ✅ Code-complete, ⚠️
      **unverified**, compile-blind). `sysstat.rs` macOS `system_snapshot`:
      per-core CPU via `host_processor_info` (ticks → **nanoseconds** so units
      match the ns-based per-process times; pure
      `parse_host_processor_ticks`), memory via `sysctl(HW_MEMSIZE)` + a manual
      `repr(C)` `vm_statistics64` head (`available ≈ free+inactive`), swap via
      `VM_SWAPUSAGE`, `getloadavg`, boot-time uptime; process table from
      libproc with `bsd_process_state` (SRUN/SSLEEP/SSTOP/SZOMB → R/S/T/Z).
      Unprivileged `proc_pidinfo` only sees the calling user's processes —
      inaccessible pids are skipped (see gaps register).
      - [x] 🤖 Automated test — `parse_host_processor_ticks_*`,
        `bsd_process_state_*` (Linux-run)
      - [ ] 🖐️ Manual test — System Monitor pane populates on a mac; CPU% of a
        busy process roughly matches Activity Monitor
        - [ ] ✅ Works
        - [ ] ❌ Doesn't work
    - [~] **31d — macOS local network snapshot** (2026-07-11; ✅ Code-complete,
      ⚠️ **unverified**, compile-blind). `network.rs` spawns `netstat -ibn`
      (chosen over the raw `NET_RT_IFLIST2` sysctl — hand-declared
      route-message layouts are silent-garbage risk when nothing can be run)
      parsed by the fixture-tested `parse_netstat_ibn` (`<Link#N>` rows only,
      end-indexed columns since the Address cell can be empty). Connections
      stay `None` with a pane warning, mirroring Windows.
      - [x] 🤖 Automated test — `parses_netstat_ibn_link_rows` (Linux-run,
        real-shaped fixture)
      - [ ] 🖐️ Manual test — Network pane lists en0/lo0/utun* with live byte
        counts on a mac
        - [ ] ✅ Works
        - [ ] ❌ Doesn't work
    - [~] **31e — macOS OpenVPN backend** (2026-07-11; ✅ Code-complete, ⚠️
      **unverified**, compile-blind). Replaces the "not yet supported" stubs:
      `osascript -e 'do shell script … with administrator privileges'` starts
      `openvpn --daemon --log <file>` (osascript blocks until the launched
      command exits — daemonizing is what makes it return), then the handshake
      is followed by tailing the logfile via the cfg-free, temp-file-tested
      `wait_for_ready_logfile`. A macOS-own registry keys config →
      pidfile/logfile (no Child); `is_connected` probes `kill(pid, 0)` with
      **EPERM = alive** (root daemon — this fixes the 28l "lamp never green"
      gap). Disconnect = admin-prompted `kill -TERM` (second prompt accepted
      for v1; management-interface teardown is the no-prompt follow-up).
      Interactive mode types `sudo openvpn --config … --auth-nocache`.
      - [x] 🤖 Automated test — `applescript_escape_*`,
        `macos_admin_shell_command_*`, `pidfile_pid_*`,
        `wait_for_ready_logfile_*` (Linux-run)
      - [ ] 🖐️ Manual test — VPN project on a mac: admin prompt → lamp green →
        disconnect (second prompt) → lamp red; interactive mode types
        `sudo openvpn …` into the root tab
        - [ ] ✅ Works
        - [ ] ❌ Doesn't work
    - [ ] **31f — macOS ssh-link traffic via nettop** (design note, no code).
      ControlMaster exists on macOS, so remote projects mux fine; what's
      missing is per-socket byte counters for the ssh-link monitor +
      `net_usage` sampler (`ss -ti` is Linux-only). Design: resolve the master
      pid from `ssh -O check` (as on Linux), then sample
      `nettop -P -x -L 1 -p <master-pid>` and parse its CSV (`bytes_in`/
      `bytes_out` columns) into the existing `SshLinkSnapshot`. Needs a mac to
      verify nettop's CSV shape/permissions before writing the parser.

209. **Getting the app onto a machine, and keeping it current.** The two ends
    of distribution that were never Eldrun's own: what the installer looks
    like, and how a user learns a newer build exists. Both landed 2026-08-26,
    both code-complete and **live-unverified** — the Windows half cannot be
    checked on Linux at all, and the Linux half needs an AppImage install and a
    real newer release to check against.
    - [x] **209a — Brand the Windows installer.** ✅ Done. `icon.ico` was
      already embedded in the exe (tauri-build does that from `bundle.icon`),
      but the NSIS template only defines `MUI_ICON`/`MUI_UNICON` when
      `installerIcon`/`uninstallerIcon` are set — unset, so the *setup* program
      shipped with the stock NSIS icon, which is what a user sees in Explorer
      and in the UAC prompt before anything is installed. Set both, plus
      `headerImage` (150×57) and `sidebarImage` (164×314), rendered from the
      brand SVG by `scripts/gen-installer-images.sh` into committed BMPs —
      committed because MUI reads only plain BMP and the Windows CI runner has
      no SVG renderer. `.gitattributes` marks image extensions `binary`: a
      24-bit BMP of a dark gradient can hold very few NUL bytes, so
      `text=auto`'s heuristic is not a safe thing to rely on when a CRLF
      rewrite would corrupt a build input.
      - [x] 🤖 Automated test — none possible; the bundler is the only consumer
      - [ ] 🖐️ Manual test — run the CI-built `.exe` on Windows: the setup
        program wears the Eldrun icon, the welcome/finish page shows the
        sidebar, and the inner pages show the header
        - [ ] ✅ Works
        - [ ] ❌ Doesn't work
    - [x] **209b — Check for a new release, and install it.** ✅ Done.
      Settings → Updates: `services::app_update` reads the project's
      `/releases/latest` from the GitHub API, compares numerically (a lexical
      compare calls 0.1.9 newer than 0.1.10), picks the artifact matching the
      running platform, downloads it with progress, and hands it to that
      platform's own installer. Deliberately **not** the Tauri updater plugin,
      which wants a signed `latest.json` and a CI signing key that do not
      exist here. Two rules hold the boundary, because this ends by running a
      downloaded binary: every asset URL is checked against this repository's
      release-download prefix (the JSON is network input), and **no command
      takes a URL or a path** — the download re-checks for itself and the
      install acts on what the download staged. **Restarting is never
      Eldrun's**: the AppImage path swaps the running file and says so, the
      NSIS path hands over to the installer (which offers to close Eldrun), a
      `.deb`/package-manager copy is only told where the file went.
      - [x] 🤖 Automated test — `services::app_update` (13: version compare,
        pre-release ordering, the URL allowlist incl. a look-alike host, asset
        pick per platform, untrusted asset names, release parsing) +
        `src/__tests__/UpdatesPanel.test.tsx` (5: no URL/path crosses the IPC
        boundary, nothing downloads on open, `manual` offers no install)
      - [ ] 🖐️ Manual test — with an AppImage install and a newer release
        published: open Settings → Updates, check, download, install, restart,
        and confirm the new version runs
        - [ ] ✅ Works
        - [ ] ❌ Doesn't work
      - [ ] **Open:** no automatic check. A check happens only when the panel
        is opened, so a user who never visits it never learns of a release. An
        opt-in "check on launch" (default off) is the obvious follow-up and was
        left out deliberately rather than forgotten — it is the one part that
        reaches the network unasked.

- [~] **31aa — Project boxes reach the phone** (2026-09-05; ✅ code-complete
  and automated tests passing, ⚠️ phone QA pending — and a rebuild + restart
  first: the sidecar's catalog, a backend command and the embedded PWA all
  changed). A box was the one scope with its own tabs the phone could not
  see: the sidecar walked `projects.json` only, and the plan listed box scopes
  under "excluded". A box is a scope of its own on the desktop — `box:<id>`,
  its own `sessions/box_<id>/` file, its own `eldrun-box_<id>--…` tmux names,
  tabs that run locally whatever its members are — so it now reaches the
  phone as one, behind a switch of its own: `eldrun_mobile_access` on the box
  record in `boxes.json`, a **Box access** list under Project access in Mobile
  settings (`set_box_mobile_access`, which also resolves the box folder). The
  sidecar lists an enabled box as a `kind: "box"` row (always "active"; the
  phone prints "▣ box" where a project row prints its status) and takes the
  tabs whose cwd is the box folder or a *local* member's root; a container, VM
  or remote member contributes no root, and a member's own switch is not
  consulted — nor does the box's switch list its members. The bridge resolves
  a `box:<id>` id through `mobileScope` beside project ids (catalog, activity,
  create, activate → `openBox`, rename, status, seen, inbox), and CenterPanel
  lets the box's switch stand in for the project's in the agent-tab tmux wrap,
  so a resumable agent opened in a box becomes attachable like a project's.
  Locked by `MobileBoxAccess.test.tsx`, the `MobileHome` badge case, and the
  `discovery.rs` / `host.rs` box tests.
  - [ ] 🖐️ Manual phone QA — Settings → Eldrun Mobile → Box access: switch a
    box on (a never-opened box gets its folder); the phone's Projects list
    shows it with "▣ box"; open it: the box's shell tabs and a Claude tab
    opened in the box after the switch are listed and attach; a member with
    its own switch off is *not* in the list; switch the box off: it vanishes
    from the phone within a poll.
  - [ ] ✅ Works
  - [ ] ❌ Doesn't work

- [~] **31g — Eldrun Mobile sidecar on macOS & Windows** (2026-08-26; ✅
  Code-complete, ⚠️ needs live QA on real macOS/Windows machines).
  The separate `eldrun-mobile-host` cargo bin is gone — the sidecar is a copy
  of the Eldrun binary run with `--mobile-host`, which is also what fixed the
  `package-macos` CI job (Tauri never lipo-merges secondary binaries into a
  `universal-apple-darwin` bundle, so the copy step failed on every macOS
  build). macOS installs a launchd LaunchAgent
  (`io.github.fseiffarth.eldrun.mobile-host`, `KeepAlive.SuccessfulExit=false`
  ≙ `Restart=on-failure`); Windows registers an HKCU Run-key autostart and
  speaks the admin/desktop control planes over tokio named pipes with a
  same-user token handshake (`services/mobile_control/admin.rs::pipe`) because
  `tokio::net::UnixStream` does not exist there. Windows terminal attach still
  requires tmux, so only the desktop-mediated surfaces (pairing, mail,
  calendar, to-dos) work there; the phone-install QR handoff (bash+jq) is
  hidden on Windows and state-dir-aware on macOS.
  - [ ] 🖐️ Manual test — macOS: enable Mobile in Settings, confirm the launch
    agent starts, pair a phone, attach a tmux tab
    - [ ] ✅ Works
    - [ ] ❌ Doesn't work
  - [ ] 🖐️ Manual test — Windows: enable Mobile, confirm the host starts and
    survives logoff/logon, pair a phone, open mail/calendar/to-dos
    - [ ] ✅ Works
    - [ ] ❌ Doesn't work

- [~] **31h — Mobile composer status chips** (2026-08-28; ✅ Code-complete, ⚠️
  needs live QA on a phone against a real Claude Code / Codex tab).
  The phone Terminal screen's composer now has the official Claude Code mobile
  shape: a ＋ button (inserts an `@` file mention into the draft), a model chip
  and a mode chip on a bar under the textarea, plus a small path · branch ·
  context readout above it. The labels come from
  `mobile-web/src/terminal/statusLine.ts`, which parses the status area the
  agent TUI draws *below its own input box* (path, branch, model, mode,
  context %) out of the readable screen — only below a recognized input
  prompt, only positive matches, generic "Model"/"Mode" labels otherwise.
  Tapping the model chip sends `/model` and the mode chip sends Shift+Tab, so
  the chip labels follow the TUI's own redraw — both taps now open a list sheet
  instead (see 31j). Tested in `src/__tests__/MobileStatusLine.test.ts`.
  - [ ] 🖐️ Manual test — on the phone, open a Claude tab: chips show the
    model/mode from the statusline, `/model` picker opens from the model chip,
    mode chip cycles plan/accept-edits, ＋ inserts `@` into the draft
    - [ ] ✅ Works
    - [ ] ❌ Doesn't work

- [~] **31x — Mobile Agents mode: every waiting session, no project grouping**
  (2026-09-03; ✅ code-complete and automated tests passing, ⚠️ phone QA pending
  — and a rebuild + restart first, since the phone serves the bundle baked into
  the binary). The phone is picked up to answer one question — *is anything
  waiting for me* — and the project grouping stood squarely in front of it: the
  reader opened each project in turn to find the one session that had stopped to
  ask something. The Projects tab now has a third mode beside Active and Search.
  **Agents** lists every agent tab that is working, waiting on a decision, or
  done, flat across every project the phone may reach, waiting-first and
  finished-last, each row carrying its project name and the same status pill the
  project overview draws. Tapping one goes straight into the session and back
  out to the list, not through the project it lives in; nothing quiet is listed,
  so an empty list means an empty list. The mode is remembered
  (`prefs.projectsAgents`) because a tab switch and every terminal visit
  re-mount the section, and re-picking it each time is the whole cost of using
  it as a triage list. New `GET /api/v1/activity` answers the whole list in one
  desktop round trip (`DesktopRequest::Activity` — a per-project `Catalog` call
  would be one round trip per project on every 5s poll, and the flat list needs
  neither the agent menu nor the schedule summaries). The desktop still owns the
  classification and the sidecar still never reads terminal output, so with no
  desktop window the screen says *that* rather than showing every tab as quiet;
  the bridge gates each project through the same `mobileProject` check as every
  other handler, so the Mobile switch and the remote/sandbox/VM tiers hold.
  Behind the mode, neither the project list nor the alerts feed is polled.
  Locked by `src/__tests__/MobileAgentsMode.test.tsx` and the `host.rs` activity
  route tests.
  - [ ] 🖐️ Manual phone QA — with two projects each holding a busy agent tab:
    open Projects → **Agents** and see both, waiting-first, each naming its
    project; tap one and land in the session, back out to the list still in
    Agents mode; leave to To-do and return (still Agents); switch to Active and
    return (Projects again); watch a tab's pill follow the desktop as it goes
    working → question → done; close desktop Eldrun and see the "Desktop
    unavailable" line instead of an empty-and-quiet reading; with everything
    idle, confirm the list is empty and says so
  - [ ] ✅ Works
  - [ ] ❌ Doesn't work

- [~] **31i — Mobile lazy terminal history, whole session** (2026-08-28;
  ✅ Code-complete, ⚠️ needs live QA on a phone; the tmux `history-limit` half
  needs a backend restart and takes effect per newly created session).
  The phone Focus view no longer clips at 400 lines: lines that scroll out of
  the live tail are absorbed once into frozen, memoized chunks
  (`mobile-web/src/terminal/readableHistory.ts` — trim-aware via xterm's
  internal `onTrim`, falls back to the old bounded view if that internal moves)
  and a "Show earlier output (N lines)" button at the top lazily reveals them
  page by page (~800 lines/tap, scroll-anchored), up to 20k lines in memory.
  Depth is one number by design: tmux sessions are now created with
  `history-limit 10000` (`ssh_exec::TMUX_HISTORY_LINES`, set *before*
  `new-session` in both the remote wrap and `tmux_local` — a pane copies the
  limit at creation), the sidecar replay captures the same depth
  (`pty_bridge::MOBILE_SCROLLBACK_LINES`), and the phone xterm's scrollback
  matches (`PHONE_SCROLLBACK`). Copy copies exactly what is revealed. Tested in
  `src/__tests__/MobileReadableScreen.test.ts` (lazy-history describe block).
  - [ ] 🖐️ Manual test — on the phone, open an agent tab with a long session:
    "Show earlier output" appears, reveals older lines without the view
    jumping, repeated taps walk back to the session start, reconnect (airplane
    mode toggle) replays without duplicating lines
    - [ ] ✅ Works
    - [ ] ❌ Doesn't work

- [~] **31j — Mobile model/mode chips open a list, not a TUI dialog**
  (2026-08-28; ✅ Code-complete, ⚠️ needs live QA on a phone against a real
  Claude Code / Codex tab).
  Both composer chips now open a bottom sheet with a tappable list — name,
  description, a check on the one the session is in — instead of leaving the
  reader to walk a dialog that reflows into nonsense at phone width.
  - **Model**: the chip still sends `/model`; the sheet lists the rows the
    session's *own* picker drew, read by `mobile-web/src/terminal/selectPrompt.ts`
    (a contiguous run of numbered rows carrying exactly one highlight marker —
    anything else is not a dialog and the sheet steps aside after 6s). A tap
    moves the highlight with the same ↑/↓ + Enter the on-screen key row sends;
    dismissing sends Esc. Nothing decides what the models are but the session.
  - **Mode**: neither CLI has a mode picker, so the sheet lists the family the
    session's *reported* mode belongs to (`terminal/agentModes.ts`: Claude
    default/accept edits/plan/bypass permissions, Codex read only/auto/full
    access) and applies one by pressing Shift+Tab until the redrawn status line
    reports it — no cycle order assumed, a full lap without a match leaves the
    session where it was and says so. A session whose mode no family claims
    keeps the old single-cycle tap. `statusLine` learned Codex's bare `auto`
    (anchored, so Claude's `auto-compact` and `~/…/auto/…` stay unmatched).
  Tested in `src/__tests__/MobileSelectPrompt.test.ts` and
  `src/__tests__/MobileOptionSheet.test.tsx`.
  - [ ] 🖐️ Manual test — on the phone, open a Claude tab: the model chip opens
    a list of the real models with the current one checked, tapping one
    switches it (chip label follows), ✕ closes both sheet and picker; the mode
    chip opens the four modes, tapping Plan lands in plan mode, tapping bypass
    on a session without it reports the failure and leaves the mode unchanged
    - [ ] ✅ Works
    - [ ] ❌ Doesn't work

- [~] **31l — Mobile Focus mode chips for all agent families** (2026-08-28;
  ✅ Code-complete, ⚠️ needs live QA on a phone).
  The mode sheet now covers every agent whose TUI actually prints its mode,
  keyed by the tab's agent label as well as the shown mode:
  - **Claude default** — Claude Code prints *nothing* in default mode, so the
    sheet never appeared for the most common state. A `silent` mode on the
    family reads an input frame with no mode text as "default" (label-gated:
    only a tab labelled Claude earns it), so the sheet opens, marks Default
    current, and a walk *to* default can confirm.
  - **Qwen Code** — full family (Ask permissions / Plan / Accept edits / Auto
    / YOLO); all five are on its Shift+Tab cycle and each draws indicator
    text (English locale), so every switch is verifiable. `statusLine` learned
    the shapes, the `*` YOLO prompt prefix, and decimal `45.2% context used`.
  - **Gemini CLI** — deliberately no family: since ~0.5 the approval mode is
    only prompt colour + aria-label, nothing the readable view can parse, so
    the chip keeps blind-cycling. Its `NN% used` context column is read.
  - Vibe/OpenCode are alt-screen TUIs (Focus already hands them to Terminal);
    Aider is a plain REPL. `scripts/backend-stale.sh` now also flags a stale
    *embedded* mobile bundle (mobile-web src newer than mobile-dist, or
    mobile-dist newer than the running process) — the phone serves the bundle
    baked in at compile time, which is how "Claude without the Terminal
    toggle" happened while every source file was right.
  - [ ] 🖐️ Manual test — on the phone: a Claude tab in default mode shows
    "default" on the mode chip and the sheet opens with Default checked;
    walking Default→Plan→Default confirms both ways; a Qwen tab lists five
    modes and lands on the tapped one (incl. YOLO, whose prompt turns `*`);
    a Gemini tab still blind-cycles but shows its `% used` as context
    - [ ] ✅ Works
    - [ ] ❌ Doesn't work

- [~] **31n — Mobile Focus: + attaches from the phone; sheets freeze the view**
  (2026-08-31; ✅ Code-complete, ⚠️ needs live QA on a phone — and a rebuild +
  restart first, since the phone serves the bundle baked into the binary).
  - **+ → "From this phone"** opens the phone's own picker (camera / photo
    library / files, multiple). Each file is `POST`ed raw to
    `/api/v1/tabs/{id}/inbox` (own 24 MiB body limit) and lands in the tab's
    project under `.eldrun/inbox/<UTC stamp>-<safe name>` — a folder the
    desktop already git-ignores, hides from the tree and skips in sync — and
    the phone writes `@.eldrun/inbox/<file>` into the draft as each one lands.
    The reference is *project-relative* on purpose: no host path crosses the
    browser API, and it is what the agent needs from its own cwd. "A project
    file (@)" is the old + behaviour. A pending/failed row sits above the
    composer (oversized files never leave the phone; failures name the reason).
    The write is defensive (`inbox.rs`): sanitized + stamped name,
    `create_new`, inbox must canonicalize below the project root.
  - **Frozen reading view**: while the model or mode sheet is up, the Focus
    pane keeps the frame it held when the sheet opened; the `/model` picker
    and the Shift+Tab status redraws are still *read* from the live screen
    (the sheet lists the picker, the walk confirms against it) but not painted
    behind it. Closing the sheet resumes the live view.
  - [ ] 🖐️ Manual test — on the phone: + → From this phone → pick a photo →
    "Sending…" row appears, then `@.eldrun/inbox/….jpg ` lands in the draft and
    the file is in `<project>/.eldrun/inbox/` on the desktop; send the message
    and Claude reads the image; pick a >24 MB video → refused without upload;
    + → A project file inserts a bare `@`. Open the Model sheet → the picker
    text does not appear behind the sheet; close it → the view resumes
    - [ ] ✅ Works
    - [ ] ❌ Doesn't work

- [~] **31u — Mobile Focus: + attaches an image from the desktop** (2026-09-03;
  ✅ Code-complete, ⚠️ needs live QA on a phone — and a rebuild + restart
  first: the phone serves the bundle baked into the binary, and the desktop
  bridge gained two requests). What the Claude app's paperclip does for an
  image on the *desktop*: a screenshot just taken, a picture just downloaded,
  the clipboard — without a hunt through a file picker on the wrong device.
  - **+ → "From the desktop"** opens a sheet the desktop fills (`GET
    /api/v1/tabs/{id}/desktop-images`): the clipboard's image when there is
    one, then the newest 40 images of the platform's screenshot/picture
    folders (Linux honours `user-dirs.dirs`; macOS lists the Desktop first)
    and Eldrun's own screenshot staging area — name, folder label, age, size.
    Picking one (`POST …/desktop-images` `{image_id}`) has the desktop copy it
    into the same `.eldrun/inbox/` a phone upload lands in, and the phone
    writes `@.eldrun/inbox/<file>` into the draft as it lands, with the same
    pending/failed row as a phone file.
  - **No path crosses.** Each file is named by an opaque id (a hash of its
    path, `services::desktop_images`); attaching re-scans the same folders for
    that id, so the phone can only ever name something the desktop would have
    listed. The sidecar refuses a malformed id before any desktop call. The
    clipboard is read on the desktop (`arboard`, bounded to 3 s so an X11
    transfer timeout cannot exhaust the bridge deadline) and encoded to PNG.
  - [ ] 🖐️ Manual test — take a screenshot on the desktop (or copy an image);
    on the phone: + → From the desktop → the sheet lists "Clipboard image ·
    W×H" first and the screenshot under "Screenshots"/"Eldrun screenshots" →
    pick one → "Copying from the desktop…" row, then `@.eldrun/inbox/….png `
    lands in the draft and the file is in `<project>/.eldrun/inbox/`; send and
    Claude reads it. Clear the clipboard, reopen the sheet → no clipboard row.
    With Eldrun closed → the sheet says the desktop is not answering.
    - [ ] ✅ Works
    - [ ] ❌ Doesn't work

- [~] **31w — Reconnect survives the binary being replaced under a live
  window** (2026-09-03; ✅ code-complete and automated tests passing, ⚠️ not
  live-verified — the fix reaches the running window only after a deliberate
  restart). Reconnect (and Settings → Mobile's enable) reinstalls the sidecar
  by copying the running Eldrun binary, and it took its source from
  `std::env::current_exe()` — which on Linux is `/proc/self/exe` *resolved to a
  path*. Replace the running image and that path comes back
  `…/eldrun (deleted)`: `mobile_host_apply` then died at its copy step with
  `read mobile host: No such file or directory (os error 2)` before the service
  manager was asked for anything, so the journal recorded nothing at all and
  Mobile could not be brought back without relaunching Eldrun. Every way the
  binary is replaced under a live window hits it — any `cargo build`/`cargo
  test` relinking `target/debug/eldrun` under the hot-reload window, the
  post-commit auto-freeze rewriting `~/.local/share/eldrun/eldrun-dev` under the
  frozen one, an in-app update — i.e. exactly when the user reaches for
  Reconnect, and now on every commit. The source is now the magic link
  itself, which opens the running inode whether or not a path still names it;
  other platforms have no such link and keep `current_exe`. Locked by
  `the_sidecar_is_copied_from_the_running_image_not_a_path_that_can_vanish`.
  - [ ] 🖐️ Manual test — with Eldrun running, rebuild it (or re-run
    `npm run package:dev`) so its binary is replaced, then press Reconnect in
    the Mobile menu: the host restarts (`journalctl --user -u
    eldrun-mobile-host` shows a fresh `Started`) instead of reporting
    `os error 2`, and the phone reaches it again.
  - [ ] ✅ Works
  - [ ] ❌ Doesn't work

- [~] **31o — Mobile names which machine failed, instead of "Host unavailable"**
  (2026-09-01; ✅ Code-complete, ⚠️ needs live QA on a phone — and a rebuild +
  restart first, since the phone serves the bundle baked into the binary).
  Prompted by a real outage: the phone had dropped off the tailnet for a day,
  and the only thing the app could say was "Host unavailable" with a Retry
  button, which is equally true when the sidecar is dead, when Eldrun itself is
  closed, and when the browser blocked the key store — four different fixes
  behind one sentence.
  - `mobile-web/src/connection.ts` classifies a failed request into one of nine
    reasons and pairs each with copy that names the machine to go and fix. The
    split that carries it: `api()` reports a transport failure as status `0`
    (nothing answered — off the tailnet, or the desktop is asleep), while an
    HTTP error means something *did* answer, and only the sidecar sends a JSON
    `error` code — so a gateway status carrying the bare `request_failed`
    fallback is the proxy's, i.e. the sidecar is not listening, whereas a `503`
    reading `desktop_unavailable` is the sidecar's own report that Eldrun is
    closed. Where the phone genuinely cannot tell two causes apart it names
    both rather than blaming one.
  - Shown on the unavailable splash (title + what to do + the raw `status code`
    for a bug report) and on the Home list's error line.
  - Fixes a real bug found on the way: `resumeAuth` treated *any* 403 as a
    rejected device, so a rejected **origin** — the host refusing the address
    the app was opened from, which re-pairing cannot fix — sent the reader to a
    pairing screen that could only fail again.
  - Tested in `src/__tests__/MobileConnectionError.test.ts` (10 cases).
  - [ ] 🖐️ Manual test — on the phone: turn Tailscale off → "Can't reach your
    desktop" naming Tailscale *and* a sleeping desktop, not "Host unavailable";
    turn airplane mode on → "This phone is offline" instead; with Tailscale up
    but Eldrun closed on the desktop → an error naming *Eldrun Mobile* /
    *Eldrun* rather than the phone; each shows a `status code` line
    - [ ] ✅ Works
    - [ ] ❌ Doesn't work

- [~] **31k — Mobile fingerprint unlock is the default** (2026-08-28;
  ✅ Code-complete, ⚠️ needs live QA on a phone).
  The local lock used to demand PIN *then* biometric; now the enrolled
  WebAuthn platform credential alone unlocks, prompted automatically as the
  locked screen opens (a browser that wants a user gesture — iOS Safari —
  gets a "Unlock with fingerprint" button instead), and the PIN is the
  fallback for a failed/unavailable authenticator. Either factor alone
  suffices — the lock guards casual access and the paired signing key is a
  non-exportable CryptoKey the PIN never encrypted. A successful biometric
  unlock clears the PIN lockout counter; a PIN lockout does not block the
  biometric path. An existing record with no credential (setup ran where
  `isUserVerifyingPlatformAuthenticatorAvailable()` said no — e.g. Firefox
  Android, or no OS screen lock at the time) is **retro-enrolled**: a
  successful PIN unlock on a now-capable browser raises the enrollment sheet
  (`maybeEnrollBiometric`, announced in the unlock copy first), so fingerprint
  becomes the default from the next unlock without re-pairing; a refused
  enrollment just stays PIN-only and offers again next time
  (`mobile-web/src/localLock.ts`, `mobile-web/src/screens/LocalUnlock.tsx`).
  A browser that exposes **no** platform authenticator now says so and names
  the remedy, rather than silently showing a PIN field: DuckDuckGo (and every
  other browser built on the system WebView) has no WebAuthn, which is why
  this never appeared on a phone before — the note points at Chrome/Safari
  and warns that re-pairing is the cost, a pairing being per-browser
  IndexedDB state.
  - [ ] 🖐️ Manual test — on the phone with a lock configured: a PIN-only
    record offers fingerprint enrollment right after a PIN unlock; from then
    on reopening the PWA raises the fingerprint sheet by itself (or shows the
    button on iOS), a fingerprint alone unlocks, cancelling it leaves the PIN
    path working, a fresh setup on a biometric-capable phone states
    PIN-as-fallback
    - [ ] ✅ Works
    - [ ] ❌ Doesn't work

- [~] **31m — Mobile to-do board: sticky filters, FAB, hide archived**
  (2026-08-30; ✅ Code-complete, ⚠️ needs live QA on a phone).
  Four changes to `mobile-web/src/screens/Todo.tsx`. **"Hide done" is
  remembered** (`mobile-web/src/prefs.ts`, `localStorage` under
  `eldrun.mobile.*`) — the screen is remounted by every tab switch, so the
  toggle was being re-ticked a dozen times a session; the search and the two
  pickers stay transient on purpose, since a filter that outlives the visit
  hides cards nobody chose to hide. **"Hide archived" is new and defaults
  on**: it hides cards resting in a column flagged `archived`, which "hide
  done" cannot reach (an *abandoned* archived card has `percent < 100`). That
  flag had to be added to the bridge — `protocol::TodoColumn.archived`
  (`#[serde(default)]`; the struct is `deny_unknown_fields`, so the desktop
  could not have sent it otherwise) and `MobileBridgeHost`'s snapshot — and is
  read off the flag, never the column's name, so a rename cannot change what
  the filter hides. **Add card is a FAB** floating above the tab bar (z-index
  between the bar and the editor backdrop); + Column stays as a small button
  at the top. **The search moved directly under the header** and the "synced
  through the desktop" notice to the foot of the screen. Tested in
  `src/__tests__/MobileTodoBoard.test.ts`.
  - [ ] 🖐️ Manual test — on the phone: tick "Hide done", leave the board and
    come back (still ticked); the board opens with archived cards hidden and
    the archive column still showing its count; unticking "Hide archived"
    reveals them and is remembered; the ＋ button adds a card and never sits
    under the tab bar or over the editor; the last column is fully scrollable
    past the button
    - [ ] ✅ Works
    - [ ] ❌ Doesn't work

- [~] **31t — Rename an agent tab from the phone** (2026-09-02; ✅ code-complete
  and automated tests passing, ⚠️ phone QA pending). A tab's name was the one
  thing the phone could read but never change, so a session opened from the sofa
  stayed "Claude" until the laptop was reachable. Each agent row on the project
  screen now carries a ✎ beside its ◷, opening a sheet that renames the tab
  through `PUT /api/v1/tabs/{id}` — authenticated, exact-origin, agent tabs only
  (`host::agent_tab_target`, the same resolver the schedule routes use). The
  sidecar owns no tab layout, so the write is a desktop-bridge call
  (`DesktopRequest::RenameTab`) that lands in `renameTabInScope`; the reply
  carries the label the desktop actually stored, and the route answers with the
  freshly-loaded catalog row so the list shows the new name without waiting a
  poll. A label is refused rather than silently rewritten when it is blank,
  longer than the catalog's 120-character publish cap, or carries control
  characters that would reach a terminal title verbatim — checked on both sides
  of the bridge, because the bridge is reachable without the route. Same
  composer-chip fix in passing: Model/mode/Schedule are flex containers with no
  `justify-content`, so a shrunk chip held its label against the left edge, and
  `text-overflow` never applied to a flex container's anonymous text — the
  labels now sit in a `.composer-chip-label` that centers and ellipsizes. The
  embedded PWA is compiled in, so this needs a rebuild + restart to reach a
  phone. Locked by `MobileTabRename.test.tsx` and the `host.rs` rename route
  test.
  - [ ] 🖐️ Manual phone QA — rename an agent tab from the project screen and
    watch the desktop tab title follow; reopen the PWA and see the new name;
    confirm a blank name cannot be saved and an over-long one is refused; with
    desktop Eldrun closed the sheet says to open it rather than failing
    silently; no ✎ appears on a shell tab; check the Model/mode/Schedule chips
    read centered in a narrow terminal.
  - [ ] ✅ Works
  - [ ] ❌ Doesn't work
- [~] **31ab — Close a tab from the phone** (2026-09-05; ✅ code-complete and
  automated tests passing, ⚠️ phone QA pending — and a rebuild + restart first:
  the sidecar route, the desktop bridge and the embedded PWA all changed). The
  phone could open tabs and never put one away, so a week of sofa sessions
  piled up as rows that only the laptop could clear. Every tab row on the
  project screen now carries a ✕ beside 31t's ✎ — **shell rows too**, which is
  where this parts from its neighbours: rename, schedules and the status chip
  are agent surfaces, and a shell tab is exactly as closeable as an agent one,
  so `host::tab_target` grew an `agent_only` flag and the agent-only routes
  pass `true` where `DELETE /api/v1/tabs/{id}` passes `false`.
  - **Closing is the desktop's ×, and nothing stronger.** The tab leaves the
    layout and its viewer dies; the tmux session behind it keeps running and
    stays reattachable from the desktop's Sessions view — `lib/closeRemoteTab`'s
    rule, applied rather than restated. A tap on a phone must not be able to
    end a running agent, which is also why the sheet says so in place of a
    yes/no confirm, and why the plan's deferred "tab termination" is still
    deferred: this is a *layout* action.
  - **The write is aimed at a named scope.** `removeTab` writes to whatever the
    desktop window is showing, and the phone is regularly looking at another
    project — so `useTabsStore.removeTabInScope` closes in the scope the request
    names, handles a tab living in a popout the way `closeDetachedGroup` does
    (its pane is mounted in that window, so nothing else would kill its PTY),
    and falls through to `removeTab` for the ordinary same-scope case.
  - **And it reaches disk.** CenterPanel's debounce persists the *active* scope
    only, so a close in a project the desktop is not showing would never be
    written and the phone's own catalog — which is read out of
    `sessions/<id>/terminals.json` — would list the closed tab for ever. The
    bridge writes the scope itself (`persistScopeLayout`, `stores/agentSchedules`'
    `persistScheduleBinding` renamed to what it always did, since a rename from
    the phone needed the same write and never made it). A project the desktop
    has not restored this session is restored first through
    `restoreProjectScope`, which reads that same file **without** activating the
    project: the user's window stays where they left it, and an inactive
    project's panes are not rendered, so nothing spawns a terminal on the way.
  - An open phone terminal on a closed tab is torn down within five seconds by
    `pty_bridge`'s existing authorization tick, which stops finding the tab in
    the catalog. Locked by `MobileTabClose.test.tsx` (store, bridge and screen)
    and the `host.rs` close-route test, which closes a *shell* tab and checks
    the agent-only routes still refuse one.
  - [ ] 🖐️ Manual phone QA — on the project screen press ✕ on a shell tab: the
    sheet names the tab and says the session keeps running; Cancel closes
    nothing; Close tab drops the row and the tab disappears from the desktop
    window; the same for an agent tab, in a project the desktop is *not*
    currently showing, and the desktop's tab strip loses it there too; relaunch
    Eldrun and the closed tab does not come back; with a phone terminal open on
    a tab, close that tab from the desktop and watch the phone say the session
    is gone rather than hanging; with desktop Eldrun closed the sheet says to
    open it rather than failing silently.
  - [ ] ✅ Works
  - [ ] ❌ Doesn't work

- [~] **31u — Mobile status chip: the session's state and the agent's own usage**
  (2026-09-02; ✅ code-complete and automated tests passing, ⚠️ phone QA
  pending — and a rebuild + restart first, since the phone serves the bundle
  baked into the binary). A **Status** chip joins ＋ / model / mode / ◷ Schedule
  on the agent composer, carrying the tab's own lamp, and opens a sheet with the
  same **Formatted | Terminal** switch the header uses for the session itself.
  - **Two sources, deliberately.** The state (working / waiting on you /
    finished / idle) and today's tally are the *desktop's* and cost nothing —
    the activity store's classification of that tab's output, and
    `usage_summary`'s counters. The quota panel is the *CLI's*, read by running
    `claude -p "/usage" --output-format json` once
    (`src-tauri/src/services/agent_usage.rs`). That run is client-side —
    `num_turns: 0`, zero tokens, ~0.5s — so asking how much quota is left
    spends none, which is the whole reason a phone may trigger it. Claude Code
    is the only recipe: `/status` is not available in print mode and no other
    CLI documents a non-interactive usage readout, so every other agent is
    reported **unsupported** rather than shown an empty panel.
  - **The raw text is always one tap away.** The panel travels exactly as the
    CLI printed it (ANSI stripped, 8 KiB cap that marks its cut) and
    `mobile-web/src/terminal/usageReport.ts` is the only thing that parses it —
    positive matches only, a line nothing claims kept as a note, and a panel
    nothing claimed at all reported as unrecognized *with* the raw block. A
    release that reshapes the format costs the reader a nicer layout, never the
    figures.
  - **The tally is labelled at the grain it is recorded.** `agent.prompt.<cmd>`
    is this agent's; worked seconds, decisions and finished turns are the
    *project's* — every agent tab in it — and the sheet says so rather than
    attributing all four to the agent it is about.
  - Bounds: a 60s desktop cache, a 10s floor under the sheet's own Refresh (so
    holding the button cannot spawn a process per tap), and one deadline per
    hop, each above the one below it — CLI 15s < desktop 20s < sidecar 25s <
    phone 30s. The three copies of the mail-message timeout `matches!` became
    `DesktopRequest::response_timeout`/`desktop_timeout` on the way.
  - Tested in `src/__tests__/MobileUsageReport.test.ts` (7) and
    `src/__tests__/MobileStatusSheet.test.tsx` (7), plus the service's own Rust
    tests.
  - [ ] 🖐️ Manual phone QA — on a Claude tab: the Status chip shows the tab's
    lamp and opens with the session state, the model/mode/context the composer
    already reads, and the 5h + weekly bars with their resets; Terminal shows
    the same panel as the CLI printed it; Refresh re-reads (and says "Cached"
    when it did not); on a Codex tab the sheet still shows the state and the
    tally but says Codex has no readable usage; with desktop Eldrun closed it
    names Eldrun rather than "request failed"
    - [ ] ✅ Works
    - [ ] ❌ Doesn't work

- [~] **31v — Mobile Focus stops above the session's own input box**
  (2026-09-02; ✅ code-complete and automated tests passing, ⚠️ phone QA pending
  — and a rebuild + restart first, since the phone serves the bundle baked into
  the binary). Every agent TUI pins the same block to the bottom of its screen:
  a labelled rule, the input box, the statusline, and a hint line naming keys a
  phone has no way to press. Focus painted all of it, so on a Claude Code
  session with a custom statusline four lines of chrome sat under every answer
  and pushed the reading the user came for off the top of a phone screen — while
  the composer right below it *is* that input box and its chips already carry
  the path, branch, model, mode and context. `inputFrameStart`
  (`mobile-web/src/terminal/statusLine.ts`, beside the parser that reads those
  same lines into the chips) returns where the frame begins and the reading view
  cuts there; Copy copies what is left. The scoping is `sessionStatus`'s — agent
  tabs only, the last 8 lines only — plus one guard: a select dialog's rows open
  with the input line's own marker (`❯ 1. Yes`), and hiding a question the
  session is waiting on would be the one unrecoverable mistake here, so a
  numbered row means no frame and nothing is cut. Blank rows and the box's
  labelled top rule directly above go with it, or the output would trail off
  into a rule and a gap. Tested in `src/__tests__/MobileSelectPrompt.test.ts`
  (3 cases).
  - [ ] 🖐️ Manual phone QA — open a Claude agent tab in Focus: the answer ends
    at the last real output line, with no rule, no `❯`, no statusline and no
    "auto mode on" hint under it; the model/mode/context chips still read
    correctly; Copy copies without the chrome; when the agent asks a permission
    question the numbered options stay visible and answerable; Terminal view is
    unchanged; a shell tab is unchanged.
    - [ ] ✅ Works
    - [ ] ❌ Doesn't work

- [~] **31s — Mobile Terminal view reaches the whole session** (2026-09-02;
  ✅ code-complete and automated tests passing, ⚠️ phone QA pending). tmux sizes
  a window to its widest attached client, so the bridge hands the phone the
  desktop's geometry (`pty_bridge::window_size`) rather than a cursor-following
  slice — but Terminal view then clipped it: `.terminal` was `overflow:hidden`,
  so everything past ~44 of ~180 columns was simply unreachable, and only Focus
  view (which re-wraps) could show it. The terminal element is now the
  horizontal scroller its own `touch-action:pan-x` always implied, and `.xterm`
  grows to `max-content` so xterm's cols-wide `.xterm-screen` has somewhere to
  overflow *into* and the themed background follows the panned-to columns.
  Vertical drags still scroll history: `terminal/touchScroll.ts` decides the
  axis once per gesture and hands a sideways drag back to the browser —
  necessary for the Touch Events fallback, whose `preventDefault` would
  otherwise eat the pan — and takes pointer capture only after a drag proves
  vertical. Because a phone draws no scrollbar at rest, `terminal/wideOutput.ts`
  fades whichever edge still hides output (a `ResizeObserver` catches the
  desktop widening the window mid-session).

  The **rows** are adopted from the same window, so the fold cut the other axis
  too, and there it hid the *newest* output: a 50-row screen in a ~20-row box
  left the live prompt permanently below the edge, unreachable — scrolling the
  buffer only moves history through the same clipped screen. The view now opens
  anchored to the last rows, and the vertical drag consumes the hidden rows
  before it reaches the scrollback, so one gesture runs continuously over
  `[scrollback] + [rows below the fold]`. A session that fits has no overflow to
  consume and scrolls history from the first pixel exactly as before, and only a
  changed row count re-anchors, so a reader panned up keeps their place. The
  embedded PWA is compiled in, so this needs a rebuild + restart to reach a
  phone. Locked by `MobileWideOutput.test.ts` and
  `MobileTerminalTouchScroll.test.ts`.
  - [ ] 🖐️ Manual phone QA — with a desktop-width tmux window, open Terminal
    view on a session with long lines: a sideways drag pans to the end of the
    line and back, an up/down drag still scrolls history (not the pan), the
    right edge fades while output continues past it and stops fading at the far
    right; Focus view shows no fades and still re-wraps; widening the desktop
    window mid-session brings the right fade back.
  - [ ] 🖐️ Manual phone QA (rows) — with a desktop window taller than the phone
    shows, Terminal view opens on the live prompt, not on the middle of the
    screen; dragging down reveals the rows above it and then runs on into
    scrollback without a jump; dragging back reaches the prompt again; a short
    session (desktop window no taller than the phone's box) scrolls history from
    the first pixel as before.
  - [ ] ✅ Works
  - [ ] ❌ Doesn't work
- [~] **31t — Mail writes from the phone: mark read/star and reply-only**
  (2026-09-03; ✅ code-complete and automated tests passing, ⚠️ phone QA
  pending). Mail was the one companion surface with no write at all, and the
  reason was the outbound threat model, not the architecture. Two writes now
  exist behind two separate default-off switches in Settings → Eldrun Mobile
  → *Mail from the phone*: `mail_actions` (mark read/unread, star/unstar via
  `POST …/messages/:id/mark`) and `mail_reply` (a plain-text reply via
  `POST …/messages/:id/reply` where the phone supplies only the text — the
  desktop derives recipient, subject, quote and `In-Reply-To` from the
  original, so a phone can answer people who already wrote and nobody else).
  Both are gated on the desktop bridge (`MobileBridgeHost`), never in the
  sidecar; the overview reports `actions`/`reply` so the phone hides the
  controls rather than discovering a refusal. Delete, move, fresh compose,
  attachments and OpenPGP stay on the desktop.
    - [ ] 🖐️ Manual test — both switches off: open a message on the phone;
      expect no Mark/Star buttons and no reply box, and the read-only notice.
    - [ ] 🖐️ Manual test — `mail_actions` on: Mark read / ★ Star on the phone;
      expect the row to update from the desktop's answer and the desktop mail
      client to show the same state after its next sync.
    - [ ] 🖐️ Manual test — `mail_reply` on: type a reply, tap *Send reply…*,
      expect the confirmation naming the sender's address; confirm; expect
      "Reply sent from the desktop", the ↩ mark on the row, the reply in the
      desktop's Sent folder threaded under the original, and the mail to
      arrive at the sender.
    - [ ] 🖐️ Manual test — flip a switch off while the phone has the message
      open; tap the control; expect the "Switched off in Eldrun" explanation.
- [~] **31s — The phone's `done` tag clears when the tab is read** (2026-09-02;
  ✅ code-complete and automated tests passing, ⚠️ phone QA pending). The
  `done` pill on the project screen is the desktop's own attention flag, and
  nothing on the phone ever retired it: opening the tab, reading the finished
  turn and backing out left the pill exactly where it was, so every tab the
  agent had ever finished a turn in stayed flagged until somebody switched to
  it on the laptop. Attaching a terminal now reports the tab seen
  (`DesktopRequest::TabSeen` → `clearAttention`), and so does detaching — the
  two edges of "it was on the phone's screen" — which is the same door the
  desktop's own tab switch uses: the output counts as read, and a live decision
  prompt deliberately survives it, because being looked at is not being
  answered. Fire-and-forget from the sidecar, so a wedged desktop cannot hold
  up the attach, and shell tabs (which raise no flag) send nothing. The
  composer's status lamp stops showing a stale `done` for the tab being read,
  since its row is frozen for the whole session. Backend + desktop change: this
  needs a rebuild + restart, and the embedded PWA is compiled in. Locked by
  `MobileTabSeen.test.tsx`, `MobileTerminalStatusLamp.test.tsx` and the
  `protocol.rs` seen-request test.
  - [ ] 🖐️ Manual phone QA — let an agent finish a turn with the phone
    elsewhere, see `done` on the project screen, open the tab and back out: the
    pill is gone (and gone on the desktop tab bar too); a tab still waiting on a
    question keeps its `question` pill after a look; with desktop Eldrun closed
    the terminal still attaches normally.
  - [ ] ✅ Works
  - [ ] ❌ Doesn't work
- [~] **31r — The phone comes back where it was** (2026-09-02; ✅ code-complete
  and automated tests passing, ⚠️ phone QA pending). Eldrun Mobile saved only
  the terminal it was last *sent into* (`rememberLastTab` fired on the way in
  and nothing ever fired on the way out), so one visit to a terminal became
  every later cold open's landing screen — backing out of it, or spending the
  session on the To-do board, changed nothing. The slot now holds the whole
  place (`mobile-web/src/lastPlace.ts`): the tab-bar section, and under
  Projects the project and the terminal on top of it, if any. It is derived
  from the app state in an effect rather than written by one navigation, so
  leaving a terminal or switching sections records the departure too. A saved
  tab the host no longer has degrades to that project's tab list instead of
  dropping the reader on the project list. The old `{projectId, tabId}` value
  still reads back as the terminal it named, so an update does not lose a
  phone's place. The embedded PWA is compiled in, so this needs a rebuild +
  restart to reach a phone. Locked by `MobileLastPlace.test.ts`.
  - [ ] 🖐️ Manual phone QA — open a terminal, back out of it, close and reopen
    the PWA: it lands on that project's tab list, not in the terminal; leave
    the app standing on To-do (or Calendar/Mail) and reopen: it lands there;
    open a terminal and reopen while it is open: it lands in the terminal;
    close the desktop tab and reopen the PWA: it lands on the project.
  - [ ] ✅ Works
  - [ ] ❌ Doesn't work
- [~] **31q — Mobile collected prompts** (2026-09-02; ✅ code-complete and
  automated tests passing, ⚠️ phone QA pending). "◷ Collected prompts" on the
  project screen opens the project's tab-free prompt list (desktop #249)
  through project-scoped, authenticated, exact-origin routes
  (`/api/v1/projects/{id}/prompts[/{prompt_id}[/send]]`). *Send now* posts an
  opaque agent-tab id; the sidecar checks the tab belongs to the same project
  and is an agent tab before the desktop turns the prompt into a one-time
  schedule at **its** current minute — the phone never computes desktop time.
  *Schedule…* opens the per-tab sheet (31p) prefilled. The embedded PWA is
  compiled in, so this needs a rebuild + restart to reach a phone. Locked by
  `MobileProjectPrompts.test.tsx` and the `host.rs` prompt route test.
  - [ ] 🖐️ Manual phone QA — add/edit/delete a prompt and see the desktop
    Agents view follow; Send now to an idle agent and watch it typed on the
    desktop; Schedule… lands in the tab sheet with the text; with desktop
    Eldrun closed the sheet disables writes and says so.
  - [ ] ✅ Works
  - [ ] ❌ Doesn't work
- [~] **31p — Mobile per-tab schedule sheet** (2026-09-01; ✅ code-complete and
  automated tests passing, ⚠️ phone QA pending). Every agent tab on the
  project's tab overview carries its own schedule line and a **◷ Schedules**
  button, which manage one-time/daily/weekday definitions through authenticated
  opaque-tab endpoints. The phone sees the desktop time zone but never the raw
  project id, tmux name, path, or schedule target id. With the sidecar still
  reachable and desktop Eldrun closed, terminal access remains available while
  the sheet disables writes and says to open desktop Eldrun.
  - 2026-09-02 fix: "Schedules could not be loaded" / save failing on the phone
    was the desktop answering `tab_not_found` for every restored agent tab —
    the restore path computed the schedule target id on its resume-check helper
    object and never put it on the tab entry (see group-s). Not yet re-verified
    on a phone; the embedded PWA needs a restart to pick up the moved control.
  - 2026-09-02: scheduling now lives **only** in the project tab overview, the
    way the desktop Agents view has it — the terminal's `◷ Schedule` composer
    chip is gone, and each agent tab prints the desktop's own summary line
    ("2 of 3 scheduled · next 09-03 09:00") beside ✎ Rename and ◷ Schedules.
    The summary rides with the catalog response (`AgentTabSchedules`), so the
    overview stays at one round trip per poll. Needs a rebuild **and** a
    desktop restart: both the sidecar and the bridge changed.
  - [ ] 🖐️ Manual phone QA — CRUD a schedule and see the desktop dialog/indicator
    refresh; edit it on desktop and see the open sheet refresh; close desktop
    Eldrun and verify the explanatory disabled state without losing terminal
    access; verify auth/origin rejection from an unpaired client.
  - [ ] ✅ Works
  - [ ] ❌ Doesn't work

---
