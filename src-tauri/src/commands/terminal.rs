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

    // Resolve agent-session resume args (Claude `--resume`, Codex `resume …`)
    // BEFORE any ssh wrapping. `wrap_pty_options` rewrites `opts.cmd` to "ssh",
    // after which the resolver (which dispatches on `cmd == "claude"|"codex"`)
    // would no longer recognise the tab — so a remote agent tab would never get
    // its resume args. Resolving here keeps remote Claude/Codex tabs resumable;
    // the resolved `--resume`/`resume` args ride along into the remote command
    // string built by `wrap_pty_options`. (For local tabs this is the same
    // resolution `spawn_pty` used to do; it no longer does, to avoid resolving
    // twice.)
    opts = crate::services::agent_session::resolve_agent_session(opts);

    // Sandbox (Docker) and ssh-remote wrapping are mutually exclusive: sandbox
    // is local-only. When `opts.sandbox` is set (frontend marks agent tabs of a
    // sandbox-enabled local project), wrap the resolved command into a
    // `docker run …` argv; otherwise fall back to ssh wrapping for remote
    // projects. Both run after agent-session resolution so resume args/env ride
    // into whichever wrapper applies.
    if opts.sandbox {
        crate::services::sandbox::wrap_pty_options_docker(&mut opts)?;
    } else if !opts.local_only {
        crate::services::ssh_exec::wrap_pty_options(&mut opts)?;
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

/// Live CPU usage (percent of a single core; may exceed 100 on multi-core work)
/// for the processes rooted at the given PTYs and all their descendants.
///
/// Samples `/proc` jiffies twice over a short interval. Linux-only; other
/// platforms return 0.0 so the UI can simply hide the figure.
#[tauri::command]
pub async fn project_cpu_percent(
    registry: State<'_, RegistryState>,
    pty_ids: Vec<String>,
) -> Result<f64, String> {
    #[cfg(target_os = "linux")]
    {
        use crate::sysstat;

        let roots: Vec<u32> = {
            let reg = registry.lock().unwrap();
            pty_ids.iter().filter_map(|id| reg.pid(id)).collect()
        };
        if roots.is_empty() {
            return Ok(0.0);
        }

        // Resolve the process tree once, then sample its busy time across a
        // fixed window. Newly spawned children mid-window simply contribute
        // less; that is acceptable for a coarse live readout.
        let pids = sysstat::descendant_pids(&roots);
        let interval = std::time::Duration::from_millis(300);
        let t0 = sysstat::sum_jiffies(&pids);
        tokio::time::sleep(interval).await;
        let t1 = sysstat::sum_jiffies(&pids);

        let busy_secs = t1.saturating_sub(t0) as f64 / sysstat::clk_tck() as f64;
        let pct = busy_secs / interval.as_secs_f64() * 100.0;
        Ok((pct * 10.0).round() / 10.0)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (registry, pty_ids);
        Ok(0.0)
    }
}
