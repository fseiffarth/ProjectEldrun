//! Whole-system resource snapshot for the htop-like monitor pane.
//!
//! A single read-only command: it returns one cumulative [`SystemSnapshot`]
//! (every process + per-core CPU + memory/swap/load). Live CPU/MEM percentages
//! are derived on the frontend by diffing two successive snapshots, so — unlike
//! the per-project readout in `commands::debug` — there is no in-command sleep or
//! shared sampler state to race between panes. Sampling itself lives in
//! [`crate::sysstat`]; this is just the Tauri surface.

use crate::gpustat::{self, GpuProc, GpuSample};
use crate::sysstat::{self, SystemSnapshot};

/// One whole-system sample. `supported` is `false` on non-Linux targets, where
/// the pane shows a "Linux only" placeholder instead of an empty table.
///
/// `project_id` selects the machine, mirroring `disk_usage_scan`: when it names a
/// project with a `remote` spec, the sample is taken on the **host** — its `/proc`
/// read over the shared ControlMaster (`REMOTE_SNAPSHOT_SCRIPT`) and assembled by
/// the same pure parsers — inside `spawn_blocking` so the SSH round-trip never
/// runs on the UI thread. Any other value (a local project, `None`, or a project
/// with no remote) samples this machine. `host_id` picks which of the project's
/// hosts to sample (primary or a `compute_hosts` worker); defaults to the primary
/// (`remote::PRIMARY_HOST`), mirroring every other multi-host command. The pane
/// passes `project_id` only while its source toggle points at a host; a
/// disconnected host is gated out on the frontend, so a dead pool is never dialed
/// here.
///
/// `careful` selects the collection mode, and is authoritative in **both**
/// directions: `true` = the reduced careful collection (no foreign account
/// names, argv, GPU processes or sessions leave the host), `false` = the full
/// reading a local sample gets. It is the machine's stored mode — careful for
/// every remote machine until the user says that one is theirs, keyed by SSH
/// target in `settings.careful_hosts` (`src/lib/carefulHost.ts`) — so the pane
/// passes it on every poll and the answer holds from the first sample.
///
/// `None` means the caller has no answer to pass, and only then does anything
/// guess: the host's own SLURM probe, plus this process's memory of what earlier
/// probes of the same target found ([`crate::services::hpc_mode`]). That memory
/// deliberately does **not** override an explicit `false` — it exists to stop a
/// flaky *probe* from talking a cluster down, not to overrule the user.
#[tauri::command]
pub async fn system_monitor_snapshot(
    project_id: Option<String>,
    host_id: Option<String>,
    careful: Option<bool>,
) -> Result<SystemSnapshot, String> {
    let host_id = host_id.unwrap_or_else(|| crate::services::remote::PRIMARY_HOST.to_string());
    if let Some(target) = project_id
        .as_deref()
        .and_then(|pid| crate::services::remote::remote_target_for_host(pid, &host_id))
    {
        let spec = target.spec.clone();
        let key = crate::services::hpc_mode::key_for(&spec);
        let mode = careful.or_else(|| {
            crate::services::hpc_mode::is_known_careful(&key).then_some(true)
        });
        return tokio::task::spawn_blocking(move || {
            let out = crate::services::ssh_exec::run_remote_script(
                &spec,
                &sysstat::remote_snapshot_script(mode),
            )?;
            let snap = sysstat::parse_remote_snapshot(&String::from_utf8_lossy(&out.stdout));
            crate::services::hpc_mode::remember(&key, snap.careful);
            Ok::<_, String>(snap)
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

/// Per-process GPU memory for the monitor pane's process breakdown. A separate,
/// heavier read (a `/proc` `fdinfo` walk for amdgpu, a `nvidia-smi` spawn for
/// compute clients) than the whole-device snapshot, so only the pane calls it —
/// the always-visible header readout never pays for it. Local-only and best-effort:
/// an empty list means "no per-process data available", not "no GPU processes".
#[tauri::command]
pub async fn gpu_process_snapshot() -> Result<Vec<GpuProc>, String> {
    Ok(gpustat::process_snapshot())
}
