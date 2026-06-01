//! No-op workspace backend — used on non-Linux, unsupported compositors,
//! or when X11/DBus connections fail. Never errors; always reports a safe state.

use super::{WorkspaceBackend, WorkspaceInfo};

pub struct NullBackend;

impl WorkspaceBackend for NullBackend {
    fn name(&self) -> &'static str {
        "null"
    }

    fn info(&self) -> WorkspaceInfo {
        WorkspaceInfo {
            label: "–".to_string(),
            current_desktop: None,
            desktop_count: None,
        }
    }

    fn switch_to_project(
        &self,
        _project_id: Option<&str>,
        _previous_project_id: Option<&str>,
        _previous_window_ids: &[u32],
        _current_window_ids: &[u32],
    ) -> Result<(), String> {
        Ok(())
    }

    fn make_sticky(&self, _eldrun_pid: u32) -> Result<(), String> {
        Ok(())
    }

    fn cleanup(&self) -> Result<(), String> {
        Ok(())
    }
}
