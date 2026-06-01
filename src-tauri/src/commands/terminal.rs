use std::sync::{Arc, Mutex};

use tauri::{AppHandle, State};

use crate::storage;
use crate::terminal::{PtyOptions, PtyRegistry};

pub type RegistryState = Arc<Mutex<PtyRegistry>>;

#[tauri::command]
pub async fn pty_spawn(
    app: AppHandle,
    registry: State<'_, RegistryState>,
    mut opts: PtyOptions,
) -> Result<(), String> {
    // Resolve empty cwd to Eldrun's root workspace directory.
    if opts.cwd.is_empty() {
        let root_dir = storage::root_work_dir();
        std::fs::create_dir_all(&root_dir).map_err(|e| {
            format!(
                "create root workspace '{}': {e}",
                root_dir.to_string_lossy()
            )
        })?;
        opts.cwd = root_dir.to_string_lossy().into_owned();
    }

    // Crash-loop guard.
    {
        let mut reg = registry.lock().unwrap();
        if !reg.check_crash_loop(&opts.id) {
            return Err(format!(
                "terminal '{}' is crash-looping; not restarting",
                opts.id
            ));
        }
    }

    crate::terminal::spawn_pty(app, registry.inner().clone(), opts)
}

#[tauri::command]
pub async fn pty_write(
    registry: State<'_, RegistryState>,
    id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    registry
        .lock()
        .unwrap()
        .write(&id, &data)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn pty_resize(
    registry: State<'_, RegistryState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    crate::terminal::resize_pty(registry.inner(), &id, cols, rows)
}

#[tauri::command]
pub async fn pty_kill(registry: State<'_, RegistryState>, id: String) -> Result<(), String> {
    registry.lock().unwrap().kill(&id);
    Ok(())
}
