use std::sync::{Arc, Mutex};

use tauri::{AppHandle, State};

use crate::storage;
use crate::terminal::{PtyOptions, PtyRegistry};

pub type RegistryState = Arc<Mutex<PtyRegistry>>;

/// Read the global `agent_remote_control` setting, defaulting ON when the
/// settings file or key is absent. A cheap per-spawn JSON read (spawns are
/// infrequent), kept here so the spawn path has no `AppHandle` dependency.
fn settings_agent_remote_control() -> bool {
    let path = storage::state_dir().join("settings.json");
    if !path.exists() {
        return crate::schema::Settings::default().agent_remote_control();
    }
    storage::read_json::<crate::schema::Settings>(&path)
        .map(|s| s.agent_remote_control())
        .unwrap_or(true)
}

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

    // SSH-sync Phase 1: a LOCAL-running tab on a REMOTE project runs in the
    // project's local mirror — it can't reach the remote tree. Resolve the cwd to
    // the mirror here (authoritative, OS-correct path) and ensure it exists, so a
    // local agent/shell tab spawns in the synced twin rather than a stale cwd.
    if opts.local_only {
        if let Some(pid) = opts.project_id.clone() {
            if crate::services::remote::remote_target_for(&pid).is_some() {
                let mirror = crate::services::remote_sync::mirror_dir(&pid);
                let _ = std::fs::create_dir_all(&mirror);
                opts.cwd = mirror.to_string_lossy().into_owned();
            }
        }
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

    // Codex resume, without the hook. Codex will not run Eldrun's SessionStart
    // hook until the user trusts it (`/hooks`), and an untrusted hook fails
    // silently — so nothing recorded a tab's live session id and every restored
    // Codex tab came back blank. Follow Codex's own rollout logs instead and
    // record the id in the same place the hook would have; `resolve_codex_session`
    // above then picks it up on the next spawn, unchanged. Tracked here, while
    // `cmd`/`cwd`/`env` still describe the tab itself — after the wrapping below
    // they describe `docker`/`ssh`.
    if opts.cmd == "codex" && crate::services::agent_session::codex_binder_enabled() {
        // A remote tab's Codex runs on the far host, so its rollouts (and its
        // cwd) are over there; the local sessions tree would only mis-attribute
        // someone else's. `local_only` tabs of a remote project are the exception
        // — they run here, in the local mirror cwd resolved above.
        let is_remote = !opts.local_only
            && opts
                .project_id
                .as_deref()
                .is_some_and(|id| crate::services::remote::remote_target_for(id).is_some());
        if let Some(uid) = opts.env.get("ELDRUN_TAB_UID").filter(|_| !is_remote).cloned() {
            // Args at this point are `["resume", <id>]` iff we just resumed a
            // recorded session — hand that id over so the binder claims it for
            // this tab rather than offering it to a sibling.
            let resumed = opts
                .args
                .iter()
                .position(|a| a == "resume")
                .and_then(|i| opts.args.get(i + 1))
                .cloned();
            crate::services::codex_bind::track(
                &opts.id,
                &uid,
                std::path::Path::new(&opts.cwd),
                resumed,
            );
        }
    }

    // Claude remote control (global setting `agent_remote_control`, default ON):
    // spawn `claude` agent tabs with `--remote-control` so the running session can
    // be monitored/steered from the Claude app/web. Only Claude has this flag.
    // Applied here — after session resolution but before ssh/docker wrapping — so
    // it rides into the wrapped command for remote/sandboxed tabs too. Guarded
    // against duplicates so a re-spawn never stacks the flag.
    if opts.cmd == "claude"
        && settings_agent_remote_control()
        && !opts.args.iter().any(|a| a == "--remote-control")
    {
        opts.args.push("--remote-control".to_string());
    }

    // Container (Docker) and ssh-remote wrapping are mutually exclusive: the
    // project container is local-only. When `opts.sandbox` is set (frontend
    // marks shell+agent tabs of a container-toggled local project), rewrite the
    // resolved command into a `docker exec` into the project's session-lived
    // container (created on demand); otherwise fall back to ssh wrapping for
    // remote projects. Both run after agent-session resolution so resume
    // args/env ride into whichever wrapper applies. `local_only` tabs (e.g.
    // Ollama `local_agent`) must run on the host verbatim, so they take neither
    // path — the `local_only` guard on the container branch preserves that
    // invariant even if a tab were ever marked both `sandbox` and `local_only`.
    if !opts.sandbox {
        // A respawn of a tab that was containerized before the toggle flipped
        // off: its old in-container process outlives the docker-exec client the
        // respawn replaces — reap it (cheap no-op for never-containerized tabs).
        crate::services::sandbox::kill_tab_process(&opts.id);
    }
    if opts.sandbox && !opts.local_only {
        #[cfg(unix)]
        crate::services::sandbox::wrap_pty_options_docker(&mut opts)?;
        // The container maps host paths into a Linux container, so on Windows
        // the container-side mount destinations would be host paths (`C:\…`)
        // that mean nothing inside it. Refuse rather than silently spawning a
        // tab the user asked to contain with no container at all.
        #[cfg(windows)]
        return Err("Project containers are not supported on Windows yet. Turn the container toggle off for this project to run this tab.".to_string());
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
/// Samples busy CPU ticks twice over a short interval via `sysstat` (Linux
/// `/proc`, Windows `GetProcessTimes`). On backends that don't sample (other
/// OSes) the ticks are always 0, so this returns 0.0 and the UI hides the figure.
#[tauri::command]
pub async fn project_cpu_percent(
    registry: State<'_, RegistryState>,
    pty_ids: Vec<String>,
) -> Result<f64, String> {
    use crate::sysstat;

    let roots: Vec<u32> = {
        let reg = registry.lock().unwrap();
        pty_ids.iter().filter_map(|id| reg.pid(id)).collect()
    };
    if roots.is_empty() {
        return Ok(0.0);
    }

    // Resolve the process tree once, then sample its busy time across a fixed
    // window. Newly spawned children mid-window simply contribute less; that is
    // acceptable for a coarse live readout.
    let pids = sysstat::descendant_pids(&roots);
    let interval = std::time::Duration::from_millis(300);
    let t0 = sysstat::sum_jiffies(&pids);
    tokio::time::sleep(interval).await;
    let t1 = sysstat::sum_jiffies(&pids);

    let busy_secs = t1.saturating_sub(t0) as f64 / sysstat::clk_tck() as f64;
    let pct = busy_secs / interval.as_secs_f64() * 100.0;
    Ok((pct * 10.0).round() / 10.0)
}
