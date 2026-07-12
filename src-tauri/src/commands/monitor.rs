//! Whole-system resource snapshot for the htop-like monitor pane.
//!
//! A single read-only command: it returns one cumulative [`SystemSnapshot`]
//! (every process + per-core CPU + memory/swap/load). Live CPU/MEM percentages
//! are derived on the frontend by diffing two successive snapshots, so — unlike
//! the per-project readout in `commands::debug` — there is no in-command sleep or
//! shared sampler state to race between panes. Sampling itself lives in
//! [`crate::sysstat`]; this is just the Tauri surface.

use crate::sysstat::{self, SystemSnapshot};

/// One whole-system sample. `supported` is `false` on non-Linux targets, where
/// the pane shows a "Linux only" placeholder instead of an empty table.
#[tauri::command]
pub async fn system_monitor_snapshot() -> Result<SystemSnapshot, String> {
    Ok(sysstat::system_snapshot())
}
