//! Whole-system resource snapshot for the htop-like monitor pane.
//!
//! A single read-only command: it returns one cumulative [`SystemSnapshot`]
//! (every process + per-core CPU + memory/swap/load). Live CPU/MEM percentages
//! are derived on the frontend by diffing two successive snapshots, so — unlike
//! the per-project readout in `commands::debug` — there is no in-command sleep or
//! shared sampler state to race between panes. Sampling itself lives in
//! [`crate::sysstat`]; this is just the Tauri surface.

use crate::gpustat::{self, GpuSample};
use crate::sysstat::{self, SystemSnapshot};

/// One whole-system sample. `supported` is `false` on non-Linux targets, where
/// the pane shows a "Linux only" placeholder instead of an empty table.
#[tauri::command]
pub async fn system_monitor_snapshot() -> Result<SystemSnapshot, String> {
    Ok(sysstat::system_snapshot())
}

/// GPU memory alone, for callers that want the device's memory without paying
/// for a whole process table (the local-model menu, which asks "what headroom is
/// left before I load this?"). Reads the same [`gpustat`] cache the snapshot
/// does. An empty list means no GPU could be read, not that there is no GPU.
#[tauri::command]
pub async fn gpu_memory_snapshot() -> Result<Vec<GpuSample>, String> {
    Ok(gpustat::snapshot())
}
