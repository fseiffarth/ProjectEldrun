## Group C — Workspace Switching / Platform Stability
*Files: `src-tauri/src/platform/x11.rs`, `wayland_kde.rs`, `null.rs`, `services/window_service.rs`, `services/project_runtime.rs`, `commands/workspace.rs`.*

15. **Securely move opened files/windows to the hidden workspace on switch
    (X11).** Fix the reported issue where files/windows opened in one project
    aren't reliably parked on the hidden desktop when switching. Investigate the
    move-retry logic (x11.rs ~retry 5×30ms) and window registry coverage.

16. **Make X11 workspace switching rock-solid.** Broader hardening of the
    two-desktop parking model — fix all known races/flakiness around
    show/hide/switch. (#15 is a specific symptom of this.)

17. **Preserve window z-order across switches.** Today `show_window` always
    raises to `Above` (x11.rs:120), losing stacking order. Track per-window
    z-order in the window registry/session and restore it on show.

18. **KDE Plasma i3-style workspace mode.** Explore an i3-like tiling/workspace
    behavior on KDE Plasma. Note: KDE Wayland per-window show/hide is currently a
    **no-op** (`wayland_kde.rs:74-80`) and needs KWin scripting first — this is
    research + sizable backend work.

19. **Cross-platform verification: Windows, macOS, KDE Plasma.** Verify the app
    runs and degrades gracefully where workspace backends are absent (null
    backend) and KDE works. Mostly QA + targeted fixes. OS-specific build,
    packaging, and native-window work is tracked separately in Group H (#30/#31).
    - **Premise partly stale:** Windows and macOS no longer fall back to the
      null backend — both have real backends (`platform/mod.rs:117,151`), with
      `null` at `:159` for everything else. So the null-degradation half applies
      only to other targets, and what's left here is KDE plus pure QA.
    - **Parity sweep (2026-09-03, ✅ Built · 🧪 Untested on hardware):** every
      Linux-only arm now has a Windows and macOS twin where the OS allows one.
      Each needs one live check on the real OS; none has been run yet:
      - [ ] 🖐️ Deck presenter keeps the screen awake — `caffeinate` (macOS),
        `SetThreadExecutionState` (Windows) — and releases on Present exit.
      - [ ] 🖐️ Spell check finds LibreOffice's `dict-*` dictionaries (Windows
        `Program Files`, macOS `/Applications/LibreOffice.app`) and
        `%APPDATA%\hunspell`.
      - [ ] 🖐️ macOS popout: a detached subwindow is parked/re-shown on project
        switch (its `NSWindow.windowNumber` is the CGWindowID).
      - [ ] 🖐️ Renderer watchdog: Windows lists `msedgewebview2` processes with
        a private-working-set split; a killed WebView2 renderer is logged to
        `crash.log` and the page reloads; on macOS a killed WebContent process
        reloads and logs.
      - [ ] 🖐️ Network pane: connection table populated on Windows (extended
        TCP/UDP tables) and macOS (`netstat -anv`); macOS SSH-link counters
        via `nettop` advance while an SFTP transfer runs.
      - [ ] 🖐️ GPU readouts: DXGI pools on a non-NVIDIA Windows box; Apple
        silicon unified pool + utilization via `ioreg`.
      - [ ] 🖐️ Boxes on Windows: member junctions appear in the box folder,
        traverse, and are removed (not their targets) when a member leaves.
      - [ ] 🖐️ File defaults: `embed_capability`'s `resolved_exec` names the
        shell association (Windows) / LaunchServices app (macOS).
      - [ ] 🖐️ macOS agent fence: a fenced `claude` cannot write outside the
        project, can write `~/.claude`, gets EPERM on `settings.json`, and
        still logs in.
      - [ ] 🖐️ Windows live browser page: no Edge permission prompt ever
        appears (camera/mic/geolocation requests are denied silently).
      - [ ] 🖐️ Windows project container (Docker Desktop): tabs land at
        `/c/…`, git and file viewers keep reading host bytes, session resume
        records land via the POSIX hook twin.
      - [ ] 🖐️ VM tier: doctor passes with `brew install qemu` (macOS, arm64
        guest on Apple silicon) / the qemu.org installer + WHPX (Windows);
        the built-in seed ISO boots cloud-init; shutdown works over QMP TCP.
      - [ ] 🖐️ Eldrun Mobile on Windows: the Settings section shows, the Run-key
        sidecar starts, and the PowerShell phone-install handoff prints the URL.

---
