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

/// Whether Claude agent tabs of `project_id` should spawn with
/// `--remote-control` (O#59): a project's own override, from the
/// `projects.json` entry's flattened `extra["remote_control"]` — like
/// `services::sandbox`'s spec reads, the state-dir mirror is the ONLY trusted
/// copy, never `project.json` (inside the project tree, and a container's own
/// rw mount). Absent project id, missing entry, or an absent/unparseable
/// override falls back to the global setting.
fn resolve_agent_remote_control(project_id: Option<&str>) -> bool {
    let list_path = storage::state_dir().join("projects.json");
    let list =
        storage::read_json::<crate::schema::projects::ProjectsList>(&list_path).unwrap_or_default();
    agent_remote_control_effective(&list, project_id, settings_agent_remote_control())
}

/// The pure O#59 decision, split out of [`resolve_agent_remote_control`] so it
/// is testable with an in-memory `ProjectsList` — no `state_dir()`/env
/// isolation needed. A project's own `remote_control` override wins; absent
/// project id, missing entry, or a non-bool/absent value falls back to
/// `global_default`.
fn agent_remote_control_effective(
    list: &[crate::schema::projects::ProjectEntry],
    project_id: Option<&str>,
    global_default: bool,
) -> bool {
    let Some(id) = project_id else {
        return global_default;
    };
    let Some(entry) = list.iter().find(|p| p.id == id) else {
        return global_default;
    };
    entry
        .extra
        .get("remote_control")
        .and_then(|v| v.as_bool())
        .unwrap_or(global_default)
}

/// Whether `cwd` sits inside `allowed`, compared component-wise (`Path::starts_with`)
/// so a sibling directory sharing a prefix (`…/proj2` vs `…/proj`) is never
/// mistaken for nesting. O#149's hard gate: mirrors `services::sandbox::cwd_is_within`
/// in shape, kept as a separate function because that one only ever *classifies*
/// a docker mount as rw/ro, while this one refuses the spawn outright.
fn cwd_within(cwd: &str, allowed: &std::path::Path) -> bool {
    std::path::Path::new(cwd).starts_with(allowed)
}

/// The VM tier's spawn-refusal decision (`docs/vm_projects_plan.md`), pure so
/// the no-local-fallback guard is testable: for a VM project a local spawn is
/// refused outright (the untrusted agent stepping outside the boundary, never
/// a downgrade), and a spawn while the VM is down refuses with the
/// `ELDRUN_VM_DOWN` sentinel the frontend turns into a boot action. `None`
/// (spawn proceeds) for every non-VM project.
fn vm_spawn_refusal(
    is_vm: bool,
    vm_running: bool,
    local_only: bool,
    tab_id: &str,
) -> Option<String> {
    if !is_vm {
        return None;
    }
    if local_only {
        return Some(
            "This project lives inside its VM — tabs never run on the host. \
             Open the tab on the VM instead."
                .to_string(),
        );
    }
    if !vm_running {
        return Some(format!(
            "ELDRUN_VM_DOWN: the VM for this project is not running; tab '{tab_id}' was not spawned. Boot the VM (activate the project or click its lamp) and retry."
        ));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::projects::ProjectEntry;
    use std::collections::HashMap;
    use std::path::Path;

    // ── vm_spawn_refusal: the VM tier's no-local-fallback guard ────────────

    #[test]
    fn non_vm_projects_spawn_freely() {
        assert_eq!(vm_spawn_refusal(false, false, true, "t1"), None);
        assert_eq!(vm_spawn_refusal(false, false, false, "t1"), None);
    }

    #[test]
    fn vm_local_spawn_is_refused_even_with_the_vm_up() {
        // The refusal is about the boundary, not availability: a host shell
        // for a VM project is never a fallback, running VM or not.
        assert!(vm_spawn_refusal(true, true, true, "t1").is_some());
        assert!(vm_spawn_refusal(true, false, true, "t1").is_some());
    }

    #[test]
    fn vm_down_refuses_with_the_boot_sentinel() {
        let msg = vm_spawn_refusal(true, false, false, "t1").unwrap();
        assert!(msg.starts_with("ELDRUN_VM_DOWN:"), "{msg}");
    }

    #[test]
    fn vm_up_remote_spawn_proceeds() {
        assert_eq!(vm_spawn_refusal(true, true, false, "t1"), None);
    }

    #[test]
    fn cwd_within_accepts_project_dir_and_subdirs() {
        assert!(cwd_within("/home/u/proj", Path::new("/home/u/proj")));
        assert!(cwd_within(
            "/home/u/proj/.eldrun/worktrees/feature-x",
            Path::new("/home/u/proj")
        ));
    }

    #[test]
    fn cwd_within_rejects_sibling_and_unrelated_paths() {
        assert!(!cwd_within("/home/u/proj2", Path::new("/home/u/proj")));
        assert!(!cwd_within("/etc", Path::new("/home/u/proj")));
    }

    fn entry(id: &str, remote_control: Option<bool>) -> ProjectEntry {
        let mut extra = HashMap::new();
        if let Some(v) = remote_control {
            extra.insert("remote_control".to_string(), serde_json::Value::Bool(v));
        }
        ProjectEntry {
            id: id.to_string(),
            name: id.to_string(),
            status: "inactive".to_string(),
            position: 0,
            local_file: String::new(),
            extra,
        }
    }

    #[test]
    fn no_project_id_falls_back_to_global() {
        assert!(agent_remote_control_effective(&[], None, true));
        assert!(!agent_remote_control_effective(&[], None, false));
    }

    #[test]
    fn unknown_project_falls_back_to_global() {
        let list = vec![entry("p1", Some(false))];
        assert!(agent_remote_control_effective(&list, Some("p2"), true));
    }

    #[test]
    fn project_override_wins_over_global_in_both_directions() {
        let list = vec![entry("p1", Some(false)), entry("p2", Some(true))];
        assert!(!agent_remote_control_effective(&list, Some("p1"), true));
        assert!(agent_remote_control_effective(&list, Some("p2"), false));
    }

    #[test]
    fn no_override_inherits_the_global_default() {
        let list = vec![entry("p1", None)];
        assert!(agent_remote_control_effective(&list, Some("p1"), true));
        assert!(!agent_remote_control_effective(&list, Some("p1"), false));
    }
}

#[tauri::command]
pub async fn pty_spawn(
    app: AppHandle,
    registry: State<'_, RegistryState>,
    pool: State<'_, crate::services::remote::RemotePoolState>,
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

    // The renderer's two authority flags (`sandbox`, `local_only`) are re-derived
    // here from `projects.json` in the state dir — the one project record a
    // containerized agent cannot write, unlike the persisted tab layout the
    // renderer rehydrates them from (which lives inside the project tree). Without
    // this a planted layout entry declaring `location: "local"` skipped both the
    // docker wrap and the ssh wrap and ran its argv on the host. Runs first, so
    // every step below sees the enforced values.
    crate::services::sandbox::enforce_spawn_authority(&mut opts);

    // Trash is an agent-only workspace. The project record cannot be weakened
    // from its writable folder, and this spawn gate also refuses stale UI tabs
    // or renderer-crafted shell commands before anything reaches the host.
    if opts
        .project_id
        .as_deref()
        .is_some_and(crate::paths::is_trash_project_id)
        && !crate::services::sandbox::is_agent_cmd(&opts.cmd)
    {
        return Err("The Trash project accepts recognised agent CLIs only.".to_string());
    }

    // VM-tier hard refusals (`docs/vm_projects_plan.md`): for a VM project the
    // remote→local fallback that exists elsewhere is not a perf surprise but
    // the untrusted agent stepping outside the boundary — so a local spawn is
    // refused outright, and a spawn while the VM is down refuses with a
    // sentinel (the frontend offers a boot action) rather than downgrading to
    // a host shell. Checked against the state-dir `projects.json` (the record
    // an in-VM agent cannot write), like the authority flags above.
    if let Some(pid) = opts.project_id.as_deref() {
        let is_vm = crate::services::remote::remote_target_for(pid)
            .is_some_and(|t| crate::services::vm::is_vm_spec(&t.spec));
        if let Some(refusal) = vm_spawn_refusal(
            is_vm,
            is_vm && crate::services::vm::is_running(pid),
            opts.local_only,
            &opts.id,
        ) {
            return Err(refusal);
        }
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

    // O#149: `cwd` is caller-supplied and, unlike `sandbox`/`local_only` above,
    // was never checked against the project it claims to belong to — a tab could
    // carry a trusted `project_id` (which decides sandbox/local_only, and rides
    // into the resume/remote-control logic below) next to a `cwd` naming an
    // unrelated path, and nothing stopped it from spawning there with that
    // project's authority. Exempt only a truly-remote, non-`local_only` tab:
    // its `cwd` names a path on the far host, which this process has no way to
    // check (the ssh-wrapped command below does the `cd` on that side).
    if let Some(pid) = opts.project_id.clone() {
        // Box scope (`box:<id>`): the tab may live in the box folder, any member
        // project's root, or a remote member's local mirror — the co-accessible
        // set the box exists to create. An unknown box fails closed, same
        // posture as an unknown project below.
        if let Some(box_id) = crate::commands::boxes::box_id_of_scope(&pid) {
            let roots = crate::commands::boxes::box_allowed_roots(box_id)
                .ok_or_else(|| format!("terminal: unknown box scope '{pid}'"))?;
            if !roots.iter().any(|root| cwd_within(&opts.cwd, root)) {
                return Err(format!(
                    "terminal: refusing to spawn tab '{}' at '{}' — outside box scope '{pid}' (allowed: box folder + member roots)",
                    opts.id, opts.cwd
                ));
            }
        } else {
            let is_remote = crate::services::remote::remote_target_for(&pid).is_some();
            if !is_remote || opts.local_only {
                let allowed: std::path::PathBuf = if is_remote {
                    // local_only tab of a remote project: cwd was just resolved
                    // above to exactly this, so this only ever rejects a caller
                    // that skipped that resolution and supplied its own cwd.
                    crate::services::remote_sync::mirror_dir(&pid)
                } else {
                    crate::services::sandbox::project_dir_for(&pid)
                        .map(std::path::PathBuf::from)
                        .ok_or_else(|| {
                            format!("terminal: project '{pid}' has no known directory")
                        })?
                };
                if !cwd_within(&opts.cwd, &allowed) {
                    return Err(format!(
                        "terminal: refusing to spawn tab '{}' at '{}' — outside project '{pid}''s directory ({})",
                        opts.id,
                        opts.cwd,
                        allowed.display()
                    ));
                }
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

    // Resolve the fourth authority axis while cmd/cwd still describe the agent
    // itself.  A local project member gets its own root plus the union of every
    // box it belongs to; a box-scoped tab gets that box's roots.  Remote agents
    // are reported as not applicable (local paths mean nothing on the far host).
    // Root resolution is backend-owned and unknown scopes fail closed.
    let remote_agent_run = !opts.local_only
        && opts
            .project_id
            .as_deref()
            .is_some_and(|id| crate::services::remote::remote_target_for(id).is_some());
    let agent_spawn = crate::services::agent_fence::is_agent(&opts);
    let fence_roots = if agent_spawn && !remote_agent_run {
        Some(
            crate::services::agent_fence::roots_for_scope(
                opts.project_id.as_deref(),
                opts.local_only,
            )
            .ok_or_else(|| {
                format!(
                    "Agent fence: unknown project or box scope '{}'; agent '{}' was not started.",
                    opts.project_id.as_deref().unwrap_or("root"),
                    opts.id
                )
            })?,
        )
    } else {
        None
    };

    // Agent-native working-root flags are portable metadata, not the OS
    // boundary: pass them on every platform for local multi-root runs.  Pick the
    // root containing cwd as "own" so box-scoped member tabs do not receive a
    // redundant flag for the directory they already started in.
    if let Some(roots) = fence_roots.as_deref() {
        let own = roots
            .iter()
            .filter(|root| std::path::Path::new(&opts.cwd).starts_with(root))
            .max_by_key(|root| root.components().count())
            .cloned()
            .unwrap_or_else(|| std::path::PathBuf::from(&opts.cwd));
        crate::services::agent_fence::add_box_root_args(&mut opts, roots, &own);
    }

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
        if let Some(uid) = opts
            .env
            .get("ELDRUN_TAB_UID")
            .filter(|_| !is_remote)
            .cloned()
        {
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

    // Claude remote control (global setting `agent_remote_control`, default ON,
    // overridable per project — O#59): spawn `claude` agent tabs with
    // `--remote-control` so the running session can be monitored/steered from
    // the Claude app/web. Only Claude has this flag. Applied here — after
    // session resolution but before ssh/docker wrapping — so it rides into the
    // wrapped command for remote/sandboxed tabs too. Guarded against
    // duplicates so a re-spawn never stacks the flag.
    if opts.cmd == "claude"
        && resolve_agent_remote_control(opts.project_id.as_deref())
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
        // `wrap_pty_options` below spawns a bare `ssh` with no BatchMode and no
        // askpass — it only ever rides an already-authenticated ControlMaster.
        // The pool is normally primed at project activation, but that master can
        // die quietly (keepalive kill on a dropped VPN/laptop sleep, or an HPC
        // job's long queue wait past `ControlPersist`) long before this tab opens.
        // Re-run the same silent connect used at activation here, best-effort:
        // on a healthy headless host this re-authenticates via the saved
        // password/askpass with no prompt, so the tab's own ssh always has a live
        // master to ride; on a genuinely unreachable host it fails harmlessly and
        // today's raw-ssh fallback (with its native prompt) still applies.
        if let Some(project_id) = opts.project_id.clone() {
            let host_id = opts
                .remote_host_id
                .clone()
                .unwrap_or_else(|| crate::services::remote::PRIMARY_HOST.to_string());
            // …but that convenience is also an unattended dial. This same call
            // runs for a tab *restored at relaunch*, where nobody has asked for
            // anything: it would open a ControlMaster on the host and, for a
            // tmux-wrapped tab, a tmux server with it. On a machine tagged HPC
            // that is precisely what the tag forbids, so refuse with the
            // `HPC_GUARD` sentinel and let the frontend offer "connect and open".
            // Once the user *has* connected the project the pool holds a standing
            // authorization (`services::remote::connect_host`), so a tab opened
            // by hand after that is allowed — which is the only distinction this
            // seam can make: `pty_spawn` receives identical options for a restore
            // and for a click.
            if let Some(target) =
                crate::services::remote::remote_target_for_host(&project_id, &host_id)
            {
                let spec = &target.spec;
                crate::services::ssh_common::authorize_dial(
                    &spec.user,
                    &spec.host,
                    spec.port,
                    crate::services::ssh_common::ambient_intent(&spec.user, &spec.host, spec.port),
                )?;
            }
            let _ = crate::services::remote::connect_host(&pool, &project_id, &host_id, None).await;
        }
        crate::services::ssh_exec::wrap_pty_options(&mut opts)?;
    }

    // Apply the outer bubblewrap boundary after docker/ssh selection but before
    // local tmux.  This keeps the tmux server on the host while the command
    // *inside* its session is fenced.  A missing/blocked bwrap fails closed.
    let mut fenced_registration: Option<(String, String)> = None;
    if let Some(roots) = fence_roots.as_deref() {
        let decision = crate::services::agent_fence::decide(
            &opts,
            roots.to_vec(),
            remote_agent_run,
            crate::services::agent_fence::policy_enabled(opts.project_id.as_deref()),
            cfg!(target_os = "linux"),
            crate::services::agent_fence::bwrap_available(),
        );
        match decision {
            crate::services::agent_fence::FenceDecision::Fenced { .. }
                if opts.cmd != "ssh" && opts.cmd != "docker" =>
            {
                let scope_id = opts
                    .project_id
                    .clone()
                    .unwrap_or_else(|| "root".to_string());
                #[cfg(target_os = "linux")]
                crate::services::agent_fence::wrap_pty_options_bwrap(&mut opts, roots, &scope_id)?;
                fenced_registration = Some((opts.id.clone(), scope_id));
            }
            crate::services::agent_fence::FenceDecision::Unavailable { install_hint } => {
                return Err(format!(
                    "Agent fence: bubblewrap is unavailable, so this agent was not started. Install it with `{install_hint}`, or turn the Agent fence off for this project."
                ));
            }
            _ => {}
        }
    }

    // Persistent LOCAL (tmux) sessions (TODO #85): a tab that resolved to a LOCAL
    // spawn — i.e. ssh/docker wrapping did NOT rewrite it — and carries a
    // `tmux_session` name is wrapped in a tmux session on this machine, so the run
    // survives an Eldrun crash and the tab reattaches on restart. A remote tab is
    // now `cmd == "ssh"` (its tmux is inside the remote command) and a container tab
    // is `cmd == "docker"`, so both are skipped. No-op on Windows / without tmux.
    #[cfg(unix)]
    if opts.tmux_session.is_some()
        && opts.cmd != "ssh"
        && (opts.cmd != "docker"
            || opts
                .project_id
                .as_deref()
                .is_some_and(crate::paths::is_trash_project_id))
    {
        crate::services::tmux_local::wrap_pty_options_local(&mut opts);
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

    let result = crate::terminal::spawn_pty(app, registry.inner().clone(), opts);
    if result.is_ok() {
        if let Some((tab_id, scope_id)) = fenced_registration {
            crate::services::agent_fence::register_tab(&tab_id, &scope_id);
        }
    }
    result
}

/// Honest per-scope fence status for the project-pill menu.  This performs no
/// spawn and uses the same cached bubblewrap probe and backend authority inputs
/// as `pty_spawn`.
#[tauri::command]
pub fn agent_fence_status(project_id: String) -> crate::services::agent_fence::AgentFenceStatus {
    crate::services::agent_fence::status_for_scope(&project_id)
}

/// List the tmux sessions running on the **local** machine (TODO #85), for a local
/// project's Sessions view. Empty on Windows / without tmux / no server.
#[tauri::command]
pub async fn local_tmux_list() -> Result<Vec<crate::services::ssh_exec::TmuxSession>, String> {
    if !crate::services::tmux_local::tmux_available() {
        return Ok(Vec::new());
    }
    tauri::async_runtime::spawn_blocking(|| {
        let out = crate::paths::command_no_window("tmux")
            .args(crate::services::tmux_local::local_tmux_ls_args())
            .output();
        match out {
            Ok(o) => crate::services::ssh_exec::parse_tmux_ls(&String::from_utf8_lossy(&o.stdout)),
            Err(_) => Vec::new(),
        }
    })
    .await
    .map_err(|e| e.to_string())
}

/// Kill a **local** tmux session (TODO #85) — the explicit-close / Sessions-view
/// kill of a local persistent tab. No-op on Windows / without tmux.
#[tauri::command]
pub async fn local_tmux_kill(session: String) -> Result<(), String> {
    if !crate::services::tmux_local::tmux_available() {
        return Ok(());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let output = crate::paths::command_no_window("tmux")
            .args(crate::services::tmux_local::local_tmux_kill_args(&session))
            .output()
            .map_err(|e| format!("could not run tmux: {e}"))?;
        if !output.status.success() {
            let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
            // Explicit close is idempotent: a session that already exited is
            // already in the desired state.
            if detail.contains("can't find session")
                || detail.contains("no server running")
                || detail.contains("failed to connect to server")
            {
                return Ok(());
            }
            return Err(if detail.is_empty() {
                format!("tmux could not kill session '{session}'")
            } else {
                format!("tmux could not kill session '{session}': {detail}")
            });
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// End every tmux session Eldrun created on the local machine during a clean
/// application quit. This deliberately lists the daemon rather than only the
/// tabs currently hydrated in the frontend: a session recovered from an earlier
/// crash may belong to an inactive project and therefore have no mounted tab in
/// this run yet. The `eldrun-` prefix is reserved for sessions Eldrun mints, so
/// user-managed sessions are never affected.
///
/// This command is called only by the frontend's normal close path. A renderer
/// or process crash never reaches it, leaving the sessions alive for restore.
#[tauri::command]
pub async fn local_tmux_kill_eldrun_sessions() -> Result<(), String> {
    if !crate::services::tmux_local::tmux_available() {
        return Ok(());
    }
    tauri::async_runtime::spawn_blocking(|| {
        let listed = crate::paths::command_no_window("tmux")
            .args(crate::services::tmux_local::local_tmux_ls_args())
            .output()
            .map_err(|e| format!("could not list tmux sessions: {e}"))?;
        // `tmux ls` returns non-zero when no server is running, which is already
        // the desired end state for the quit path.
        if !listed.status.success() {
            return Ok(());
        }
        let sessions =
            crate::services::ssh_exec::parse_tmux_ls(&String::from_utf8_lossy(&listed.stdout));
        let mut failures = Vec::new();
        for session in sessions {
            // Trash sessions are deliberately mobile-persistent. Their host
            // tmux owns the attach point while the strictly isolated container
            // remains the process/filesystem boundary, so a clean Eldrun quit
            // must not turn a phone detach into an agent kill.
            if session
                .name
                .starts_with(&format!("eldrun-{}--", crate::paths::TRASH_PROJECT_ID))
            {
                continue;
            }
            if !crate::services::tmux_local::is_eldrun_local_tmux_session(&session.name) {
                continue;
            }
            let output = crate::paths::command_no_window("tmux")
                .args(crate::services::tmux_local::local_tmux_kill_args(
                    &session.name,
                ))
                .output()
                .map_err(|e| format!("could not run tmux: {e}"))?;
            if !output.status.success() {
                let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
                // A session can exit between `ls` and `kill-session`; that is
                // indistinguishable from a successful cleanup.
                if !detail.contains("can't find session")
                    && !detail.contains("no server running")
                    && !detail.contains("failed to connect to server")
                {
                    failures.push(if detail.is_empty() {
                        session.name
                    } else {
                        format!("{}: {detail}", session.name)
                    });
                }
            }
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(format!(
                "could not stop every Eldrun local tmux session: {}",
                failures.join("; ")
            ))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Rename a **local** tmux session (TODO #85). `new_name` must be a safe tmux name.
#[tauri::command]
pub async fn local_tmux_rename(session: String, new_name: String) -> Result<(), String> {
    if !crate::services::ssh_exec::valid_tmux_session_name(&new_name) {
        return Err("a session name may only contain letters, digits, '-' and '_'".to_string());
    }
    if !crate::services::tmux_local::tmux_available() {
        return Ok(());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let _ = crate::paths::command_no_window("tmux")
            .args(crate::services::tmux_local::local_tmux_rename_args(
                &session, &new_name,
            ))
            .output();
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn pty_write(
    registry: State<'_, RegistryState>,
    id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    // Watch for an Eldrun-minted interactive login command being typed in, which is
    // what marks this PTY as a legitimate destination for the matching saved
    // credential (see `commands::credentials`).
    crate::commands::credentials::note_pty_input(&id, &data);
    let sender = registry.lock().unwrap().input_sender(&id);
    if let Some(sender) = sender {
        sender
            .send(data)
            .await
            .map_err(|_| format!("terminal '{id}' is no longer accepting input"))?;
    }
    Ok(())
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

/// A pane's visibility report (visible-only streaming): a hidden pane's PTY
/// stops emitting `terminal-output` over IPC entirely — the backend buffers it
/// and condenses throttled `terminal-activity` digests for the pill
/// indicators — and re-showing drains the buffer as one `terminal-replay`.
/// See the routing block in `terminal/mod.rs`.
#[tauri::command]
pub async fn pty_set_visible(
    app: AppHandle,
    id: String,
    viewer_id: String,
    visible: bool,
    update_seq: u64,
) -> Result<(), String> {
    crate::terminal::route_set_visible(&app, &id, &viewer_id, visible, update_seq);
    Ok(())
}

#[tauri::command]
pub async fn pty_remove_view(id: String, viewer_id: String, update_seq: u64) -> Result<(), String> {
    crate::terminal::route_remove_view(&id, &viewer_id, update_seq);
    Ok(())
}

/// Hold a marker-watch on a PTY: stream its output as if its pane were
/// visible, for the login flows that scan a possibly-hidden terminal's raw
/// stream (`useRemoteSession`/`useRemoteReconnect`).
#[tauri::command]
pub async fn pty_watch(app: AppHandle, id: String) -> Result<(), String> {
    crate::terminal::route_watch(&app, &id);
    Ok(())
}

#[tauri::command]
pub async fn pty_unwatch(id: String) -> Result<(), String> {
    crate::terminal::route_unwatch(&id);
    Ok(())
}

#[tauri::command]
pub async fn pty_kill(registry: State<'_, RegistryState>, id: String) -> Result<(), String> {
    // The terminal is gone, so its login marking must not outlive it and bless a
    // future PTY that reuses the id.
    crate::commands::credentials::forget_login_pty(&id);
    registry.lock().unwrap().kill(&id);
    crate::services::agent_fence::on_tab_gone(&id);
    Ok(())
}

/// Kill every live PTY belonging to one project scope. PTY ids are
/// `<scope>:<tab-key>`; the delimiter is part of the match so similarly named
/// projects cannot affect each other.
#[tauri::command]
pub async fn pty_kill_scope(
    registry: State<'_, RegistryState>,
    scope: String,
) -> Result<Vec<String>, String> {
    let ids = registry.lock().unwrap().ids_for_scope(&scope);
    for id in &ids {
        crate::commands::credentials::forget_login_pty(id);
        crate::terminal::route_remove_all_views(id);
        registry.lock().unwrap().kill(id);
        crate::services::agent_fence::on_tab_gone(id);
    }
    Ok(ids)
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

/// Register a tab as a **host-bound local-model tab** — the one kind of tab that
/// keeps running on the host when the project's container toggle is on.
///
/// Called by `TabBar` / `NewTabMenu` at the moment such a tab is created, with the
/// uuid the tab persists as `hostBoundUid`. The grant is a file in the state dir
/// (`services::sandbox::register_host_bound_tab`), which is what makes it survive
/// a relaunch — the tab's key and PTY id do not — without the decision riding on
/// anything a project's own files can state.
#[tauri::command]
pub fn register_host_bound_tab(project_id: String, uid: String) -> Result<(), String> {
    crate::services::sandbox::register_host_bound_tab(&project_id, &uid)
}
