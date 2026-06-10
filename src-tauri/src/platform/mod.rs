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
    /// Called at startup to make Eldrun visible on all desktops (sticky).
    fn make_sticky(&self, eldrun_pid: u32) -> Result<(), String>;
    /// Called when the app exits — restore original desktop configuration.
    fn cleanup(&self) -> Result<(), String>;
}

// ── Factory ────────────────────────────────────────────────────────────────

pub fn detect_backend() -> Box<dyn WorkspaceBackend> {
    #[cfg(target_os = "windows")]
    {
        return Box::new(windows::WindowsBackend);
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

    Box::new(null::NullBackend)
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
