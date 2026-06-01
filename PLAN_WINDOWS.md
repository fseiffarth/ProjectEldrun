# Plan: Windows Backend Port

Target: make `cargo build --target x86_64-pc-windows-msvc` compile and produce a
working Eldrun binary on Windows 10 (build 1903+) or Windows 11.

---

## 1. Cargo.toml — dependencies and targets

**File:** `src-tauri/Cargo.toml`

**Changes needed:**

Add a Windows-specific dependency block for process inspection and crash logging:

```toml
[target.'cfg(target_os = "windows")'.dependencies]
windows = { version = "0.58", features = [
    "Win32_Foundation",
    "Win32_System_Threading",
    "Win32_NetworkManagement_IpHelper",
    "Win32_NetworkManagement_Ndis",
] }
```

Add `nsis` (or `msi`) to `tauri.conf.json` bundle targets (see §7).

`portable-pty`, `opener`, `serde`, `serde_json`, `tokio`, `tauri`, and
`mime_guess` are all cross-platform — no changes required there.

---

## 2. `storage.rs` — state directory and root work directory

**File:** `src-tauri/src/storage.rs`

`state_dir()` hard-codes `~/.local/share/eldrun/` via the `HOME` env var.
Windows does not set `HOME`; it uses `APPDATA` (`%APPDATA%`) or `LOCALAPPDATA`.

**Replace `state_dir()` with:**

```rust
pub fn state_dir() -> std::path::PathBuf {
    #[cfg(target_os = "windows")]
    {
        let base = std::env::var("APPDATA")
            .unwrap_or_else(|_| std::env::var("USERPROFILE")
                .unwrap_or_else(|_| "C:\\Users\\Default".to_string()));
        return std::path::PathBuf::from(base).join("eldrun");
    }
    #[cfg(not(target_os = "windows"))]
    {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/root".to_string());
        std::path::PathBuf::from(home)
            .join(".local")
            .join("share")
            .join("eldrun")
    }
}
```

**Replace `root_work_dir()` with:**

```rust
pub fn root_work_dir() -> std::path::PathBuf {
    #[cfg(target_os = "windows")]
    {
        let home = std::env::var("USERPROFILE")
            .unwrap_or_else(|_| "C:\\Users\\Default".to_string());
        return std::path::PathBuf::from(home).join("eldrun").join("root");
    }
    #[cfg(not(target_os = "windows"))]
    {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/root".to_string());
        std::path::PathBuf::from(home).join("eldrun").join("root")
    }
}
```

**Note:** The `.local/share/eldrun/` path is intentionally kept for Linux to
maintain backward compatibility with the Python app. The Windows path starts
fresh, so no migration concern.

---

## 3. `lib.rs` — crash logger signal handlers

**File:** `src-tauri/src/lib.rs`

Signal handlers are guarded by `#[cfg(unix)]` and compile-away on Windows — no
compilation error. However, Windows gets no crash logging for fatal exceptions.

**Add a Windows-specific crash hook in `install_crash_logger()`:**

```rust
#[cfg(target_os = "windows")]
unsafe {
    use windows::Win32::System::Threading::SetUnhandledExceptionFilter;
    // Store path in a static so the filter closure can reach it.
    static CRASH_PATH: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();
    CRASH_PATH.get_or_init(|| path.clone());

    extern "system" fn exception_filter(
        _: *mut windows::Win32::System::Diagnostics::Debug::EXCEPTION_POINTERS,
    ) -> i32 {
        if let Some(p) = CRASH_PATH.get() {
            crate::append_to_log(p, "=== CRASH: unhandled exception ===");
        }
        1 // EXCEPTION_EXECUTE_HANDLER — terminates the process
    }
    SetUnhandledExceptionFilter(Some(exception_filter));
}
```

The existing `#[cfg(unix)]` `CRASH_LOG_FD` static and `libc::sigaction` block are
untouched and skip on Windows automatically.

---

## 4. `commands/workspace.rs` — `network_conn_type()`

**File:** `src-tauri/src/commands/workspace.rs`

`detect_conn_type()` reads `/sys/class/net/` which does not exist on Windows.
The `#[tauri::command]` wrapper calls it unconditionally.

**Wrap `detect_conn_type` in cfg blocks and add a Windows version:**

```rust
#[tauri::command]
pub fn network_conn_type() -> String {
    #[cfg(target_os = "linux")]
    return detect_conn_type(Path::new("/sys/class/net"));
    #[cfg(target_os = "windows")]
    return detect_conn_type_windows();
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    return "disconnected".to_string();
}

#[cfg(target_os = "windows")]
fn detect_conn_type_windows() -> String {
    use windows::Win32::NetworkManagement::IpHelper::{GetAdaptersInfo, IP_ADAPTER_INFO};
    use windows::Win32::NetworkManagement::Ndis::IfOperStatusUp;
    // Walk the adapter list via GetAdaptersInfo; return "wlan" if any
    // wireless adapter is up, "lan" if any wired adapter is up, else "disconnected".
    // Full implementation: allocate a buffer, call GetAdaptersInfo, iterate.
    // Alternatively parse `netsh interface show interface` output via Command::new("netsh").
    "disconnected".to_string() // stub; replace with real implementation
}
```

The simplest correct implementation for the stub: spawn `netsh interface show
interface` and parse its output — no extra crate needed. The `windows` crate
`GetAdaptersInfo` approach is more reliable but more verbose.

---

## 5. `commands/apps.rs` — app launching and window tracking

**File:** `src-tauri/src/commands/apps.rs`

### 5a. `check_pid_alive()`

Currently returns `false` on non-Linux via `#[cfg(not(target_os = "linux"))]`.
On Windows, implement with `OpenProcess`:

```rust
#[tauri::command]
pub fn check_pid_alive(pid: u32) -> bool {
    #[cfg(target_os = "linux")]
    return std::path::Path::new(&format!("/proc/{pid}")).exists();
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
        use windows::Win32::Foundation::CloseHandle;
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if let Ok(h) = handle {
                CloseHandle(h).ok();
                return true;
            }
        }
        return false;
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    false
}
```

### 5b. `desktop_files()` and `resolve_app_icon()`

`.desktop` files don't exist on Windows. The existing `#[cfg(not(target_os = "linux"))]`
stub for `list_x11_window_ids`, `find_window_for_pid`, and `find_new_x11_window`
already returns empty/None. The `desktop_files()` and `parse_desktop_entry()`
functions are not behind cfg guards — they will compile but return empty results
when the Linux paths don't exist.

**Change:** Move `desktop_files()` behind `#[cfg(target_os = "linux")]` and add
a Windows version that scans the Windows Registry for app registrations:

```rust
#[cfg(target_os = "windows")]
fn desktop_files() -> Vec<PathBuf> {
    Vec::new() // Windows icon resolution handled separately
}

#[cfg(target_os = "windows")]
pub fn resolve_app_icon(_exec: String) -> Option<String> {
    // Future: extract icon from EXE via SHGetFileInfo or ExtractIcon.
    None
}
```

The Linux version of `desktop_files()` and `resolve_app_icon()` can be wrapped
in `#[cfg(target_os = "linux")]`.

### 5c. X11 window tracking stubs

`list_x11_window_ids`, `find_window_for_pid`, `find_new_x11_window`, and the
`X11ClientWindow` struct are already `#[cfg(target_os = "linux")]` — they
compile away on Windows. `window_id` in `TrackedWindow` will always be `None`
on Windows.

A Windows-specific implementation could use `EnumWindows` +
`GetWindowThreadProcessId` to find the HWND for a launched PID. This is
optional for a first port since the NullBackend already handles workspace
switching as a no-op.

---

## 6. `commands/downloads.rs` — symlinks and browser paths

**File:** `src-tauri/src/commands/downloads.rs`

### 6a. `update_downloads_symlink()`

Uses `std::os::unix::fs::symlink` which does not exist on Windows.

**Wrap in cfg:**

```rust
#[tauri::command]
pub fn update_downloads_symlink(project_dir: String) -> Result<(), String> {
    #[cfg(unix)]
    {
        // existing Unix implementation unchanged
    }
    #[cfg(target_os = "windows")]
    {
        // Windows directory symlinks require SeCreateSymbolicLinkPrivilege
        // (available in Developer Mode or elevated). Use a junction instead:
        let home = std::env::var("USERPROFILE").unwrap_or_else(|_| "C:\\Users\\Default".to_string());
        let link = std::path::PathBuf::from(&home).join("eldrun").join("downloads");
        if link.exists() {
            std::fs::remove_dir(&link).map_err(|e| format!("remove junction: {e}"))?;
        }
        if let Some(parent) = link.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        std::os::windows::fs::symlink_dir(&project_dir, &link)
            .map_err(|e| format!("create junction: {e}"))
    }
}
```

`std::os::windows::fs::symlink_dir` creates a directory symbolic link, which
requires Developer Mode or admin rights. Consider making this command a no-op on
Windows and documenting the limitation — most Windows users do not use
`~/eldrun/downloads` routing.

### 6b. Browser profile paths on Windows

`configure_browser_downloads()` hard-codes `~/.mozilla/firefox` and
`.config/chromium`. Replace the path resolution with a platform-aware helper:

```rust
fn firefox_base() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        let appdata = std::env::var("APPDATA").unwrap_or_default();
        return PathBuf::from(appdata).join("Mozilla").join("Firefox");
    }
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").unwrap_or_default();
        return PathBuf::from(home)
            .join("Library").join("Application Support").join("Firefox");
    }
    #[cfg(target_os = "linux")]
    {
        let home = std::env::var("HOME").unwrap_or_default();
        return PathBuf::from(home).join(".mozilla").join("firefox");
    }
}

fn chromium_bases() -> Vec<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let local = std::env::var("LOCALAPPDATA").unwrap_or_default();
        return vec![
            PathBuf::from(&local).join("Google").join("Chrome").join("User Data"),
            PathBuf::from(&local).join("Chromium").join("User Data"),
        ];
    }
    // macOS / Linux implementations ...
}
```

On Windows the Chromium `Default/Preferences` path is inside `User Data\Default\`
rather than the Linux `Default/`. Adjust `update_chromium_prefs()` accordingly.

---

## 7. `tauri.conf.json` — Windows bundle targets

**File:** `src-tauri/tauri.conf.json`

Add Windows targets and keep Linux targets:

```json
"bundle": {
  "active": true,
  "targets": ["deb", "appimage", "nsis"],
  "icon": ["icons/32x32.png", "icons/128x128.png", "icons/128x128@2x.png",
           "icons/icon.icns", "icons/icon.ico"],
  "linux": {
    "deb": { "depends": ["libwebkit2gtk-4.1-0", "libgtk-3-0", "libappindicator3-1"] }
  },
  "windows": {
    "nsis": {
      "installMode": "perMachine"
    },
    "webviewInstallMode": {
      "type": "downloadBootstrapper"
    }
  },
  "category": "Development"
}
```

The `"nsis"` target produces a standard `.exe` installer. `"msi"` is the
alternative (WiX-based); either works for distribution.

`webviewInstallMode: downloadBootstrapper` ensures the WebView2 runtime is
installed if not already present (it comes bundled with Windows 11; most Win10
machines already have it via Edge).

---

## 8. Terminal — default shell on Windows

**File:** `src/stores/projects.ts` (frontend) or wherever `pty_spawn` is called.

The `cmd` field in `PtyOptions` must be a valid shell path. On Linux/macOS this
is typically `bash` or `$SHELL`. On Windows the equivalents are:

- `powershell.exe` (PowerShell 5, always present on Win10+)
- `pwsh.exe` (PowerShell 7+, optional)
- `cmd.exe` (basic CMD)

**In the Rust backend (`terminal/mod.rs`), add a platform default:**

```rust
fn default_shell() -> String {
    #[cfg(target_os = "windows")]
    return std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string());
    #[cfg(not(target_os = "windows"))]
    return std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
}
```

If `opts.cmd` is empty in `pty_spawn`, fall back to `default_shell()` rather
than failing. The frontend should also be updated to pass `""` when the user
has not chosen a shell, letting the backend pick the platform default.

---

## 9. PTY / ConPTY compatibility

`portable-pty` on Windows uses **ConPTY** (Windows Pseudo Console API), which
requires Windows 10 build 1903 (May 2019 Update) or later. No code changes
needed in the PTY module itself — `NativePtySystem` already dispatches to
ConPTY on Windows.

Known limitations of ConPTY vs. Unix PTY:
- `get_size()` does not reflect actual terminal dimensions until after the first
  resize — call `resize_pty` once after spawn with the initial `cols`/`rows`.
- Some ANSI escape sequences (mouse reporting, alternate screen) work correctly;
  test with xterm.js on a Windows build to verify.

---

## 10. CI/CD — Windows build job

**File:** `.github/workflows/ci-cd.yml`

Add a `windows-build` job:

```yaml
windows-build:
  runs-on: windows-latest
  steps:
    - uses: actions/checkout@v4
    - uses: dtolnay/rust-toolchain@stable
    - uses: actions/setup-node@v4
      with: { node-version: '20' }
    - run: npm ci
    - run: npm run build
    - run: cargo test --manifest-path src-tauri/Cargo.toml
    - run: npm run tauri build -- --bundles nsis
```

---

## Summary of required file changes

| File | Change |
|------|--------|
| `src-tauri/Cargo.toml` | Add `[target.'cfg(windows)'.dependencies]` with `windows` crate |
| `src-tauri/src/storage.rs` | `state_dir()` / `root_work_dir()` — Windows paths via `APPDATA`/`USERPROFILE` |
| `src-tauri/src/lib.rs` | `install_crash_logger()` — add `cfg(windows)` `SetUnhandledExceptionFilter` |
| `src-tauri/src/commands/workspace.rs` | `network_conn_type()` — add Windows stub/impl |
| `src-tauri/src/commands/apps.rs` | `check_pid_alive()` via `OpenProcess`; cfg-guard `desktop_files()` |
| `src-tauri/src/commands/downloads.rs` | Symlink via `symlink_dir`; browser paths via `APPDATA`/`LOCALAPPDATA` |
| `src-tauri/tauri.conf.json` | Add `nsis` bundle target and `windows` bundle section |
| `src-tauri/src/terminal/mod.rs` | Add `default_shell()` fallback using `COMSPEC` |
| `.github/workflows/ci-cd.yml` | Add `windows-latest` build job |
