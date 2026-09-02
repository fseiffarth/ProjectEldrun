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
  automated tests passing, ⚠️ phone QA pending). The ◷ beside each agent tab on
  the project's tab list and the Schedule chip in its terminal manage the same
  one-time/daily/weekday definitions through authenticated opaque-tab
  endpoints. The phone sees the desktop time zone but never the raw
  project id, tmux name, path, or schedule target id. With the sidecar still
  reachable and desktop Eldrun closed, terminal access remains available while
  the sheet disables writes and says to open desktop Eldrun.
  - 2026-09-02 fix: "Schedules could not be loaded" / save failing on the phone
    was the desktop answering `tab_not_found` for every restored agent tab —
    the restore path computed the schedule target id on its resume-check helper
    object and never put it on the tab entry (see group-s). Not yet re-verified
    on a phone; the embedded PWA needs a restart to pick up the moved control.
  - [ ] 🖐️ Manual phone QA — CRUD a schedule and see the desktop dialog/indicator
    refresh; edit it on desktop and see the open sheet refresh; close desktop
    Eldrun and verify the explanatory disabled state without losing terminal
    access; verify auth/origin rejection from an unpaired client.
  - [ ] ✅ Works
  - [ ] ❌ Doesn't work

---
