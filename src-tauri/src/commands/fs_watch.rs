//! Filesystem watcher for the right-panel file tree.
//!
//! The tree renders one directory level at a time, so we watch exactly that
//! directory (non-recursively) and emit `fs-change` whenever it changes. The
//! frontend (`FileTree.tsx`) re-fetches the listing on that event, giving live
//! updates for files created/removed by terminals, agents, or other processes.
//!
//! A single watcher is active at a time (one `FileTree` is mounted for the
//! active project); `watch_dir` replaces any previous watcher, which drops and
//! unwatches it.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use notify::{recommended_watcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, State};

/// Currently-watched canonical directory and its live watcher. `None` when
/// nothing is being watched (panel closed / unmounted).
pub type FsWatchState = Arc<Mutex<Option<(PathBuf, notify::RecommendedWatcher)>>>;

pub fn new_state() -> FsWatchState {
    Arc::new(Mutex::new(None))
}

#[tauri::command]
pub fn watch_dir(
    app: AppHandle,
    state: State<'_, FsWatchState>,
    path: String,
) -> Result<(), String> {
    // Mount-free remote (Phase 2): inotify cannot see a remote (SFTP) tree, and a
    // remote project's watched dir is its non-fs mountpoint root. No-op so the
    // remote file tree just relies on manual refresh; the frontend already skips
    // watching for remote projects, this is belt-and-suspenders.
    if crate::services::remote::remote_target_for_dir(&path).is_some() {
        return Ok(());
    }
    let canonical = std::fs::canonicalize(&path).map_err(|e| e.to_string())?;

    let mut guard = state.lock().unwrap();
    if let Some((current, _)) = guard.as_ref() {
        if *current == canonical {
            return Ok(()); // already watching this directory
        }
    }

    let emit_path = canonical.to_string_lossy().to_string();
    let mut watcher = recommended_watcher(move |res: notify::Result<notify::Event>| {
        if res.is_ok() {
            let _ = app.emit("fs-change", &emit_path);
        }
    })
    .map_err(|e| e.to_string())?;

    watcher
        .watch(&canonical, RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;

    // Replacing the stored watcher drops the previous one, unwatching it.
    *guard = Some((canonical, watcher));
    Ok(())
}

#[tauri::command]
pub fn unwatch_dir(state: State<'_, FsWatchState>) -> Result<(), String> {
    *state.lock().unwrap() = None;
    Ok(())
}
