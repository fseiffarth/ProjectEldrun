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
    - [x] **30c — Native PID liveness.** ✅ Done. `check_pid_alive`
      (`commands/apps.rs`) no longer shells out to `tasklist` on Windows; it uses
      `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)` + `GetExitCodeProcess`,
      treating `STILL_ACTIVE` (259) as alive (a handle to an exited process still
      opens, so the exit code must be inspected — not just OpenProcess success).
      Linux `/proc` and macOS/Unix `kill(pid,0)` branches unchanged.
      - [x] 🤖 Automated test — covered by `cargo build --lib` compile + existing
        callers; no behavioral unit test (needs a live pid)
      - [ ] 🖐️ Manual test
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
    - [x] **30e — Screenshot capture on Windows.** ✅ Done. `commands/screenshot.rs`
      refactored to a cfg-selected `platform` submodule (Linux tool-spawn unchanged).
      Windows uses native Win32 GDI — `GetSystemMetrics(SM_*VIRTUALSCREEN)` for the
      full multi-monitor virtual screen, `GetDC`/`CreateCompatibleDC`/`BitBlt`/
      `GetDIBits`, BGRA→RGBA, then PNG-encoded via the existing `png` crate to a
      timestamped file (same public command + output dir as Linux). All GDI handles
      freed on success and error paths. Added `Win32_Graphics_Gdi`.
      - [x] 🤖 Automated test — shared filename/date tests retained; build verified
      - [ ] 🖐️ Manual test
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
    - [x] **30n — Windows disk-capacity probe** (2026-07-15; ✅ Done).
      `duscan::capacity_of` returned `None` on Windows, silently dropping the
      disk-usage pane's total/free capacity bar. Added a `#[cfg(windows)]` arm
      via `GetDiskFreeSpaceExW` (total + caller-available bytes, quota-aware —
      matching the Unix `f_blocks`/`f_bavail` semantics).
      - [x] 🤖 Automated test — `capacity_of_home_reports_a_plausible_volume`
        (runs on every OS)
      - [ ] 🖐️ Manual test — disk-usage pane shows the capacity bar on Windows
    - [x] **30o — no docker spawn at Windows startup** (2026-07-15; ✅ Done).
      Containers are Unix-only, but `sandbox::sweep_orphans` ran unconditionally
      at startup, spawning `docker --version` (and `docker ps` when Docker
      Desktop exists) for nothing on Windows. Now gated on `cfg!(unix)`.
      - [x] 🤖 Automated test — compile-covered; behavior is an early return
      - [ ] 🖐️ Manual test — n/a

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
    - [ ] **31f — macOS ssh-link traffic via nettop** (design note, no code).
      ControlMaster exists on macOS, so remote projects mux fine; what's
      missing is per-socket byte counters for the ssh-link monitor +
      `net_usage` sampler (`ss -ti` is Linux-only). Design: resolve the master
      pid from `ssh -O check` (as on Linux), then sample
      `nettop -P -x -L 1 -p <master-pid>` and parse its CSV (`bytes_in`/
      `bytes_out` columns) into the existing `SshLinkSnapshot`. Needs a mac to
      verify nettop's CSV shape/permissions before writing the parser.

---
