//! WorkspaceBackend trait and auto-detect factory.
//!
//! Detection order (matching the Python app's backends/__init__.py):
//!   1. KDE Wayland — WAYLAND_DISPLAY set + XDG_CURRENT_DESKTOP contains "kde"/"plasma"
//!   2. KDE X11     — XDG_CURRENT_DESKTOP contains "kde"/"plasma" (no WAYLAND_DISPLAY)
//!   3. Cinnamon X11 — XDG_CURRENT_DESKTOP contains "cinnamon"
//!   4. GNOME        — XDG_CURRENT_DESKTOP contains "gnome" (stub — null behavior)
//!   5. Null         — everything else

use serde::{Deserialize, Serialize};

pub mod null;

#[cfg(target_os = "linux")]
pub mod wayland_kde;
#[cfg(target_os = "windows")]
pub mod windows;
/// Pure parking logic for the Windows backend. Compiled on every OS (not
/// `#[cfg]`-gated) so its safety-critical unit tests run on any platform; the
/// Win32 FFI that consumes it lives in `windows.rs`.
pub mod windows_park;
#[cfg(target_os = "linux")]
pub mod x11;

// ── Backend trait ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceInfo {
    /// Human-readable name for the status lamp.
    pub label: String,
    /// Current desktop/workspace index (0-based).
    pub current_desktop: Option<usize>,
    /// Total number of desktops/workspaces.
    pub desktop_count: Option<usize>,
}

pub trait WorkspaceBackend: Send + Sync {
    fn name(&self) -> &'static str;
    fn info(&self) -> WorkspaceInfo;
    /// Make a tracked window visible according to this backend's workspace
    /// model. X11 moves it to desktop 0; other backends may restore/raise it.
    fn show_window(&self, window_id: u64) -> Result<(), String>;
    /// Hide a tracked window according to this backend's workspace model. X11
    /// parks it on desktop 1, the Eldrun hidden workspace.
    fn hide_window(&self, window_id: u64) -> Result<(), String>;
    /// Compatibility helper for older command paths. Backend implementations
    /// should normally only need to implement show_window/hide_window.
    fn switch_to_project(
        &self,
        _project_id: Option<&str>,
        _previous_project_id: Option<&str>,
        previous_window_ids: &[u64],
        current_window_ids: &[u64],
    ) -> Result<(), String> {
        for &window_id in previous_window_ids {
            self.hide_window(window_id)?;
        }
        for &window_id in current_window_ids {
            self.show_window(window_id)?;
        }
        Ok(())
    }
    /// Whether this backend can host a frameless embedded external window
    /// (e.g. via X11 reparenting). Only X11 returns true; every other backend
    /// (null, KDE-Wayland, Windows) degrades the file→tab embed feature to a
    /// plain external launch. Default false so new backends are safe.
    fn supports_embedding(&self) -> bool {
        false
    }
    /// Called at startup to make Eldrun visible on all desktops (sticky).
    fn make_sticky(&self, eldrun_pid: u32) -> Result<(), String>;
    /// Called when the app exits — restore original desktop configuration.
    fn cleanup(&self) -> Result<(), String>;

    /// Mark an Eldrun-owned window id as PARKABLE (#42). Detached subwindows
    /// share Eldrun's `eldrun` WM_CLASS, which is normally never parked so the
    /// MAIN window is never hidden. A detached subwindow is a *different* window
    /// that DOES want to follow the project-switch hide/show path, so it is
    /// explicitly opted in by id here.
    ///
    /// STRUCTURAL SAFETY: implementations MUST refuse the main window id so the
    /// "Eldrun's own window is never parked" invariant holds even if a caller is
    /// buggy. The default no-op (null/Wayland/Windows) is safe — those backends
    /// don't desktop-park at all.
    fn set_parkable(&self, _window_id: u64) {}
    /// Remove a window id from the parkable override (on dock-back / close).
    fn unset_parkable(&self, _window_id: u64) {}
    /// Record the MAIN Eldrun window's id so `set_parkable` can structurally
    /// refuse to ever add it to the override. Called once at startup when the
    /// main window's X11 id is resolved. Default no-op.
    fn set_main_window_id(&self, _window_id: u64) {}

    /// Move an already-mapped window to absolute physical root coordinates so it
    /// lands on the monitor containing (x, y). Used to place an externally
    /// launched app on the screen where a file was dropped. Best-effort; the
    /// default is a no-op for backends that cannot position foreign windows
    /// (KDE-Wayland forbids a client positioning another app's window, and
    /// null/Windows do not implement it), which degrades gracefully to "the WM
    /// places it wherever it likes".
    fn position_window(&self, _window_id: u64, _x: i32, _y: i32) -> Result<(), String> {
        Ok(())
    }
}

// ── Factory ────────────────────────────────────────────────────────────────

pub fn detect_backend() -> Box<dyn WorkspaceBackend> {
    #[cfg(target_os = "windows")]
    {
        return Box::new(windows::WindowsBackend::new());
    }

    #[cfg(target_os = "linux")]
    {
        let desktop = std::env::var("XDG_CURRENT_DESKTOP")
            .unwrap_or_default()
            .to_lowercase();
        let wayland = std::env::var("WAYLAND_DISPLAY").is_ok();

        if wayland && (desktop.contains("kde") || desktop.contains("plasma")) {
            match wayland_kde::KdeWaylandBackend::try_new() {
                Ok(b) => return Box::new(b),
                Err(e) => eprintln!("workspace backend kde-wayland unavailable: {e}"),
            }
        }

        if desktop.contains("kde") || desktop.contains("plasma") {
            match x11::X11Backend::try_new() {
                Ok(b) => return Box::new(b),
                Err(e) => eprintln!("workspace backend x11 unavailable: {e}"),
            }
        }

        if desktop.contains("cinnamon") || desktop.contains("x-cinnamon") {
            match x11::X11Backend::try_new() {
                Ok(b) => return Box::new(b),
                Err(e) => eprintln!("workspace backend x11 unavailable: {e}"),
            }
        }
    }

    // Fallback for every non-Windows platform (Linux desktops that matched no
    // backend above, plus macOS/other). On Windows the early return above is the
    // only path, so gating this keeps it from being flagged as unreachable.
    #[cfg(not(target_os = "windows"))]
    {
        return Box::new(null::NullBackend);
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_backend_always_returns_a_backend() {
        let b = detect_backend();
        let name = b.name();
        assert!(
            ["null", "x11", "kde-wayland", "windows"].contains(&name),
            "unknown backend name: {name}"
        );
    }

    #[test]
    fn detected_backend_info_does_not_panic() {
        let b = detect_backend();
        let _ = b.info(); // must not panic
    }

    #[test]
    fn detected_backend_show_hide_window_zero_does_not_panic() {
        let b = detect_backend();
        // 0 is an invalid window ID — backend must handle it gracefully.
        let _ = b.show_window(0);
        let _ = b.hide_window(0);
    }

    #[test]
    fn null_backend_satisfies_workspace_backend_trait() {
        let b: Box<dyn WorkspaceBackend> = Box::new(null::NullBackend);
        assert_eq!(b.name(), "null");
        assert!(b.cleanup().is_ok());
    }

    #[test]
    fn workspace_info_label_is_not_empty() {
        let b = detect_backend();
        let info = b.info();
        assert!(!info.label.is_empty(), "WorkspaceInfo.label must not be empty");
    }
}
