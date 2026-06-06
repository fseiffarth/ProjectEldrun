# Plan: macOS Backend Port

Target: make `cargo build --target aarch64-apple-darwin` (Apple Silicon) and
`x86_64-apple-darwin` (Intel) compile and produce a working Eldrun app bundle on
macOS 13 Ventura or later.

---

## 1. Cargo.toml — dependencies and targets

**File:** `src-tauri/Cargo.toml`

No new crates are strictly required for a minimum working port. All current
dependencies (`portable-pty`, `opener`, `serde*`, `tokio`, `tauri`, `mime_guess`,
`infer`) are cross-platform. `libc` is already gated to `cfg(unix)` and macOS is
Unix — it compiles and is available for use.

`xcb` and `zbus` are `cfg(target_os = "linux")` and compile away on macOS.

Optional future addition for native macOS integrations (Spaces, Mission Control):

```toml
[target.'cfg(target_os = "macos")'.dependencies]
# objc2 = "0.5"  # Objective-C bridge — for native window management
```

---

## 2. `storage.rs` — state directory

**File:** `src-tauri/src/storage.rs`

`state_dir()` hard-codes `~/.local/share/eldrun/` which is a Linux convention.
macOS convention is `~/Library/Application Support/eldrun/`. The Linux path
will still work on macOS (it is just a directory), but Tauri's own data
directories and macOS conventions expect the `Library` path.

**Replace `state_dir()` with:**

```rust
pub fn state_dir() -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    #[cfg(target_os = "macos")]
    return std::path::PathBuf::from(home)
        .join("Library")
        .join("Application Support")
        .join("eldrun");
    #[cfg(not(target_os = "macos"))]
    std::path::PathBuf::from(home)
        .join(".local")
        .join("share")
        .join("eldrun")
}
```

`root_work_dir()` uses `~/eldrun/root/` which is fine on macOS — no change
needed.

---

## 3. `lib.rs` — crash logger signal handlers

**File:** `src-tauri/src/lib.rs`

Signal handlers are guarded by `#[cfg(unix)]`. macOS is Unix, so `libc` is
available and `libc::SIGSEGV`, `libc::SIGABRT`, `libc::SIGBUS`, `libc::SIGFPE`
all exist. The existing implementation **compiles and runs on macOS without any
changes**.

One macOS note: under the Hardened Runtime (required for notarization), the
`SA_SIGINFO` flag behaves correctly — no restrictions apply to signal handler
registration.

---

## 4. `platform/` — workspace backend

**File:** `src-tauri/src/platform/mod.rs`

`detect_backend()` falls through to `NullBackend` on any non-Linux OS. This is
the correct behavior for macOS — Eldrun will function without virtual desktop
management. The workspace-switch UI element will show "–" in the status bar.

**Future macOS workspace backend (optional, Phase N+1):**

macOS Spaces is not scriptable via a public API. Options:
- Use `CGSWorkspace` private APIs (undocumented, breaks with OS updates, not
  allowed in the App Store).
- Use Mission Control via Accessibility APIs (`AXUIElement`) — requires the
  user to grant Accessibility permission in System Settings.
- Accept NullBackend as permanent for macOS; document that virtual desktop
  switching is Linux-only.

**Recommendation:** keep NullBackend for macOS in the initial port.

---

## 5. `commands/workspace.rs` — `network_conn_type()`

**File:** `src-tauri/src/commands/workspace.rs`

`detect_conn_type()` reads `/sys/class/net/` which does not exist on macOS.

**Add a macOS branch:**

```rust
#[tauri::command]
pub fn network_conn_type() -> String {
    #[cfg(target_os = "linux")]
    return detect_conn_type(Path::new("/sys/class/net"));
    #[cfg(target_os = "macos")]
    return detect_conn_type_macos();
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    return "disconnected".to_string();
}

#[cfg(target_os = "macos")]
fn detect_conn_type_macos() -> String {
    // Parse `ifconfig -l` to list interface names, then check each with
    // `ifconfig <iface>` for "status: active".
    // Wireless interfaces start with "en" on Apple Silicon / Intel Macs
    // and are identifiable by the presence of "type: Wi-Fi" in networksetup output.
    //
    // Simplest correct approach: check `route get default` output.
    let output = std::process::Command::new("route")
        .args(["-n", "get", "default"])
        .output();
    let Ok(out) = output else { return "disconnected".to_string() };
    let text = String::from_utf8_lossy(&out.stdout);
    // Interface line looks like "  interface: en0"
    for line in text.lines() {
        let line = line.trim();
        if let Some(iface) = line.strip_prefix("interface:") {
            let iface = iface.trim();
            // en0 is typically Wi-Fi; en1+ may be Ethernet
            // Check networksetup -getinfo <iface> for hardware type
            let hw = std::process::Command::new("networksetup")
                .args(["-getinfo", iface])
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).to_lowercase())
                .unwrap_or_default();
            if hw.contains("wi-fi") || hw.contains("airport") {
                return "wlan".to_string();
            }
            return "lan".to_string();
        }
    }
    "disconnected".to_string()
}
```

---

## 6. `commands/apps.rs` — app launching and window tracking

**File:** `src-tauri/src/commands/apps.rs`

### 6a. `check_pid_alive()`

Returns `false` on `#[cfg(not(target_os = "linux"))]`. On macOS, the correct
approach is `kill(pid, 0)` which is available via `libc` (already a dependency
on all Unix):

```rust
#[tauri::command]
pub fn check_pid_alive(pid: u32) -> bool {
    #[cfg(target_os = "linux")]
    return std::path::Path::new(&format!("/proc/{pid}")).exists();
    #[cfg(unix)]
    // kill(pid, 0) returns 0 if the process exists and is reachable.
    return unsafe { libc::kill(pid as i32, 0) == 0 };
    #[cfg(not(unix))]
    false
}
```

### 6b. `desktop_files()` and `resolve_app_icon()`

`.desktop` files do not exist on macOS. The current code searches
`/usr/share/applications` and similar — these paths simply return empty
directories on macOS, so `desktop_files()` returns an empty `Vec` and
`resolve_app_icon()` returns `None`. This already compiles and runs correctly
without code changes, but wastes a directory scan.

**Optimization (not required for boot):** wrap `desktop_files()` in
`#[cfg(target_os = "linux")]` and add a macOS stub that scans `/Applications`
for `.app` bundles:

```rust
#[cfg(target_os = "macos")]
fn resolve_app_icon_macos(exec: &str) -> Option<String> {
    // Scan /Applications for <name>.app/Contents/Info.plist,
    // extract CFBundleIconFile, read the .icns from Resources/.
    // Convert to PNG via ImageMagick or return the .icns as a data URL.
    None // stub
}
```

### 6c. X11 window tracking stubs

`list_x11_window_ids`, `find_window_for_pid`, `find_new_x11_window`, and
`X11ClientWindow` are all `#[cfg(target_os = "linux")]` — they compile away on
macOS. `window_id` in `TrackedWindow` will always be `None` on macOS.

A macOS-specific implementation to find the window for a PID would use the
Accessibility API or `CGWindowListCopyWindowInfo`. This is optional for the
initial port — launched apps are tracked by PID alone on macOS.

---

## 7. `commands/downloads.rs` — symlinks and browser paths

**File:** `src-tauri/src/commands/downloads.rs`

### 7a. `update_downloads_symlink()`

`std::os::unix::fs::symlink` is available on macOS — **no change needed**.
The symlink at `~/eldrun/downloads` will work identically on macOS.

### 7b. Browser profile paths on macOS

`configure_browser_downloads()` looks for `~/.mozilla/firefox` and
`.config/chromium`. These don't exist on macOS. Add a macOS branch to the
profile discovery helpers:

```rust
fn firefox_base() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    #[cfg(target_os = "macos")]
    return PathBuf::from(&home)
        .join("Library").join("Application Support").join("Firefox");
    #[cfg(not(target_os = "macos"))]
    PathBuf::from(&home).join(".mozilla").join("firefox")
}

fn chromium_bases() -> Vec<PathBuf> {
    let home = std::env::var("HOME").unwrap_or_default();
    #[cfg(target_os = "macos")]
    return vec![
        PathBuf::from(&home).join("Library").join("Application Support")
            .join("Google").join("Chrome"),
        PathBuf::from(&home).join("Library").join("Application Support")
            .join("Chromium"),
    ];
    #[cfg(not(target_os = "macos"))]
    vec![
        PathBuf::from(&home).join(".config").join("chromium"),
        PathBuf::from(&home).join(".config").join("google-chrome"),
        PathBuf::from(&home).join(".config").join("google-chrome-beta"),
    ]
}
```

Then use `firefox_base()` and `chromium_bases()` inside `configure_browser_downloads()`
instead of the hard-coded paths.

---

## 8. `tauri.conf.json` — macOS bundle targets

**File:** `src-tauri/tauri.conf.json`

Add `dmg` to the bundle targets and add a `macOS` section:

```json
"bundle": {
  "active": true,
  "targets": ["deb", "appimage", "dmg"],
  "icon": ["icons/32x32.png", "icons/128x128.png", "icons/128x128@2x.png",
           "icons/icon.icns", "icons/icon.ico"],
  "linux": {
    "deb": { "depends": ["libwebkit2gtk-4.1-0", "libgtk-3-0", "libappindicator3-1"] }
  },
  "macOS": {
    "minimumSystemVersion": "13.0"
  },
  "category": "Development"
}
```

`"app"` (bare `.app`) can be used instead of or alongside `"dmg"` for
development; `"dmg"` is the right distribution target.

---

## 9. macOS entitlements for PTY and WebView

**File:** `src-tauri/entitlements.plist` (new file, referenced from `tauri.conf.json`)

For ad-hoc distribution (no App Store), no entitlements file is required.
For notarization (required for distribution outside the App Store without
Gatekeeper warnings), a Hardened Runtime entitlements file is needed:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <!-- Required for WebKit JIT compilation -->
  <key>com.apple.security.cs.allow-jit</key>
  <true/>
  <!-- Required for WebKit / JavaScriptCore -->
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
  <true/>
  <!-- Needed if loading unsigned plugins or dylibs -->
  <key>com.apple.security.cs.disable-library-validation</key>
  <true/>
</dict>
</plist>
```

Reference it in `tauri.conf.json`:

```json
"macOS": {
  "minimumSystemVersion": "13.0",
  "entitlements": "entitlements.plist",
  "signingIdentity": "-"
}
```

`"signingIdentity": "-"` means ad-hoc signing (no Apple Developer account needed).
Replace with your actual Developer ID certificate for notarized distribution.

**PTY note:** the `posix_openpt`/`grantpt`/`unlockpt` calls inside `portable-pty`
are standard POSIX; they work under the Hardened Runtime without extra
entitlements. The App Sandbox (`com.apple.security.app-sandbox: true`) would
restrict PTY creation — **do not enable the App Sandbox** for Eldrun.

---

## 10. Terminal — default shell on macOS

**File:** `src-tauri/src/terminal/mod.rs` (build_command)

macOS has defaulted to `zsh` since macOS Catalina (10.15). The frontend may
pass a hardcoded `bash` command to `pty_spawn`. Ensure the backend respects the
`SHELL` environment variable when `opts.cmd` is empty:

```rust
fn default_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| {
        #[cfg(target_os = "macos")]
        return "/bin/zsh".to_string();
        #[cfg(not(target_os = "macos"))]
        "/bin/bash".to_string()
    })
}
```

If `opts.cmd` is empty in `pty_spawn`, fall back to `default_shell()`.

---

## 11. CI/CD — macOS build job

**File:** `.github/workflows/ci-cd.yml`

Add a `macos-build` job:

```yaml
macos-build:
  runs-on: macos-latest
  steps:
    - uses: actions/checkout@v4
    - uses: dtolnay/rust-toolchain@stable
      with:
        targets: aarch64-apple-darwin
    - uses: actions/setup-node@v4
      with: { node-version: '20' }
    - run: npm ci
    - run: npm run build
    - run: cargo test --manifest-path src-tauri/Cargo.toml
    - run: npm run tauri build -- --bundles dmg
```

For a universal binary (runs natively on both Intel and Apple Silicon):

```yaml
    - run: npm run tauri build -- --bundles dmg --target universal-apple-darwin
```

This requires both `x86_64-apple-darwin` and `aarch64-apple-darwin` toolchains
installed (`rustup target add aarch64-apple-darwin x86_64-apple-darwin`).

---

## Summary of required file changes

| File | Change |
|------|--------|
| `src-tauri/src/storage.rs` | `state_dir()` — return `~/Library/Application Support/eldrun/` on macOS |
| `src-tauri/src/commands/workspace.rs` | `network_conn_type()` — add macOS impl using `route get default` + `networksetup` |
| `src-tauri/src/commands/apps.rs` | `check_pid_alive()` via `libc::kill(pid, 0)` on Unix |
| `src-tauri/src/commands/downloads.rs` | `firefox_base()` / `chromium_bases()` — macOS `Library/Application Support` paths |
| `src-tauri/tauri.conf.json` | Add `dmg` bundle target; add `macOS` section with min OS version |
| `src-tauri/entitlements.plist` | New file; Hardened Runtime entitlements for WebKit JIT + notarization |
| `src-tauri/src/terminal/mod.rs` | `default_shell()` fallback using `SHELL` / `/bin/zsh` |
| `.github/workflows/ci-cd.yml` | Add `macos-latest` build job |

**No changes needed in:**
- `lib.rs` (signal handlers already compile on macOS via `#[cfg(unix)]`)
- `platform/` (NullBackend used; X11/DBus gated to Linux)
- `terminal/mod.rs` PTY logic (`portable-pty` is cross-platform)
- `commands/downloads.rs` symlink code (`std::os::unix::fs::symlink` works on macOS)
