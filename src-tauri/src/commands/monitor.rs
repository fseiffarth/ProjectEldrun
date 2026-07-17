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
///
/// `project_id` selects the machine, mirroring `disk_usage_scan`: when it names a
/// project with a `remote` spec, the sample is taken on the **host** — its `/proc`
/// read over the shared ControlMaster (`REMOTE_SNAPSHOT_SCRIPT`) and assembled by
/// the same pure parsers — inside `spawn_blocking` so the SSH round-trip never
/// runs on the UI thread. Any other value (a local project, `None`, or a project
/// with no remote) samples this machine. The pane passes the id only while its
/// source toggle is on "remote"; a disconnected host is gated out on the frontend,
/// so a dead pool is never dialed here.
#[tauri::command]
pub async fn system_monitor_snapshot(
    project_id: Option<String>,
) -> Result<SystemSnapshot, String> {
    if let Some(target) = project_id
        .as_deref()
        .and_then(crate::services::remote::remote_target_for)
    {
        let spec = target.spec.clone();
        return tokio::task::spawn_blocking(move || {
            let out = crate::services::ssh_exec::run_remote_script(
                &spec,
                sysstat::REMOTE_SNAPSHOT_SCRIPT,
            )?;
            Ok::<_, String>(sysstat::parse_remote_snapshot(&String::from_utf8_lossy(
                &out.stdout,
            )))
        })
        .await
        .map_err(|e| e.to_string())?;
    }
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
