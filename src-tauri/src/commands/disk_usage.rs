//! Tauri surface for the Disk Usage Analyzer pane.
//!
//! Thin, like `commands::monitor`: the scanning itself lives in [`crate::duscan`]
//! (pure, unit-tested, `AppHandle`-free); this module only dispatches local vs
//! remote, streams progress, and owns the cancel registry.
//!
//! A scan can take minutes (`/`, a big `$HOME`), so every branch runs inside
//! `spawn_blocking` — a blocking body on a sync command runs on the UI thread and
//! freezes the whole window, which is exactly the failure the remote git commands
//! hit before. The caller mints a `scan_id`, listens for `disk-scan-progress`, and
//! can abort mid-walk with [`disk_usage_cancel`].

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::duscan::{self, DuDevice, DuScan, Tally};

/// Cancel flags for the scans currently in flight, keyed by the frontend's
/// `scan_id`. An entry lives only for the duration of its scan.
pub type DuScanState = Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>;

pub fn new_state() -> DuScanState {
    Arc::new(Mutex::new(HashMap::new()))
}

/// Progress payload for the `disk-scan-progress` event, keyed by `scan_id` so a
/// pane ignores other panes' scans. Bookended `start` / `dir` / `done` phases,
/// mirroring `commands::sync`'s `sync-progress`. snake_case on the wire.
#[derive(Debug, Clone, Serialize)]
struct DuProgress {
    scan_id: String,
    /// `start` | `dir` | `done`.
    phase: String,
    /// The directory being read (`phase == "dir"`), else the scan root.
    path: String,
    files: u64,
    dirs: u64,
    bytes: u64,
}

fn emit(app: &AppHandle, scan_id: &str, phase: &str, path: &str, t: &Tally) {
    let _ = app.emit(
        "disk-scan-progress",
        DuProgress {
            scan_id: scan_id.to_string(),
            phase: phase.to_string(),
            path: path.to_string(),
            files: t.files,
            dirs: t.dirs,
            bytes: t.bytes,
        },
    );
}

/// Scan `root` and return its size tree.
///
/// `project_id` selects the machine: a project with a `remote` spec scans on the
/// **host** (and `root` is a path over there), anything else scans locally. As in
/// `fs::dir_size`, remoteness is resolved *before* any local-fs access — a remote
/// project's stored directory is a local state dir, not the tree being measured.
#[tauri::command]
pub async fn disk_usage_scan(
    app: AppHandle,
    scan_id: String,
    root: String,
    project_id: Option<String>,
    state: State<'_, DuScanState>,
) -> Result<DuScan, String> {
    let remote = project_id
        .as_deref()
        .and_then(crate::services::remote::remote_target_for);

    let cancel = Arc::new(AtomicBool::new(false));
    if let Ok(mut map) = state.lock() {
        map.insert(scan_id.clone(), cancel.clone());
    }

    let result = if let Some(target) = remote {
        let spec = target.spec.clone();
        let root = root.clone();
        tokio::task::spawn_blocking(move || {
            crate::services::ssh_exec::remote_du_tree(&spec, &root)
        })
        .await
        .map_err(|e| e.to_string())?
    } else {
        let app2 = app.clone();
        let id = scan_id.clone();
        let root = root.clone();
        emit(&app, &scan_id, "start", &root, &Tally::default());
        tokio::task::spawn_blocking(move || {
            let mut on_progress = |t: &Tally, at: &std::path::Path| {
                emit(&app2, &id, "dir", &at.to_string_lossy(), t);
            };
            duscan::scan_local(&root, &cancel, &mut on_progress)
        })
        .await
        .map_err(|e| e.to_string())?
    };

    if let Ok(mut map) = state.lock() {
        map.remove(&scan_id);
    }
    let done = result
        .as_ref()
        .map(|s| Tally { files: s.files, dirs: s.dirs, bytes: s.root.size, errors: s.errors })
        .unwrap_or_default();
    emit(&app, &scan_id, "done", &root, &done);

    result
}

/// Ask an in-flight **local** scan to stop. It returns the partial tree it had
/// built, with `cancelled` set. A no-op for an unknown or already-finished
/// `scan_id` — and for a remote scan, which is a single `du` round-trip on the host
/// with no walk of ours to interrupt.
#[tauri::command]
pub fn disk_usage_cancel(scan_id: String, state: State<'_, DuScanState>) {
    if let Ok(map) = state.lock() {
        if let Some(flag) = map.get(&scan_id) {
            flag.store(true, Ordering::Relaxed);
        }
    }
}

/// Scan targets offered on the pane's home screen (home dir + its filesystem),
/// each with its capacity where the platform can tell us.
#[tauri::command]
pub async fn disk_usage_devices() -> Result<Vec<DuDevice>, String> {
    Ok(duscan::devices())
}
