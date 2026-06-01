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
    fn show_window(&self, window_id: u64) -> Result<(), String>;
    fn hide_window(&self, window_id: u64) -> Result<(), String>;
    /// Bring `project_id`'s windows to the foreground desktop and park the
    /// previous project's windows on the hidden desktop. `None` targets the
    /// root terminal workspace.
    /// `previous_project_id` is the project being deactivated, with `None`
    /// representing the root terminal workspace.
    fn switch_to_project(
        &self,
        project_id: Option<&str>,
        previous_project_id: Option<&str>,
        previous_window_ids: &[u64],
        current_window_ids: &[u64],
    ) -> Result<(), String>;
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
