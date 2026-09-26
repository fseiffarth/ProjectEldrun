//! The shell-tab agent shim: `eldrun --agent-shim <cli> [args…]`.
//!
//! Shell tabs are the user's terminals and are never fenced, so typing
//! `cursor-agent` into one used to run it against the user's real home. Every
//! shell tab now has one shim per registry CLI at the front of its PATH
//! (`services::agent_bin`), a tiny script that execs this entry point. It
//! builds the same fence a tab of the tab's scope would get — the scope's
//! Eldrun-owned home, the shared logins, the project roots — and replaces
//! itself with it. There is no bypass flag: it launches the CLI Eldrun would
//! launch, fenced, or refuses. Running the binary by absolute path stays the
//! user's own shell, real home, no Eldrun logins.
//!
//! The scope comes from `ELDRUN_SCOPE`, which every tab Eldrun spawns carries
//! (`commands::terminal::pty_spawn`); outside an Eldrun tab the shim refuses.
//! Inside a fence (`ELDRUN_AGENT_FENCE`) the script never reaches here — it
//! execs the real CLI from the rest of PATH instead.

use std::collections::HashMap;
use std::path::PathBuf;

/// Everything the shim needs before it can build a fence, resolved from the
/// process environment. Pure over `env`.
pub fn plan(cli: &str, env: &HashMap<String, String>) -> Result<(Option<String>, PathBuf), String> {
    if cli.is_empty() || cli.contains('/') || cli.contains('\\') {
        return Err("agent shim: a registry CLI name, not a path".into());
    }
    if env.contains_key("ELDRUN_AGENT_FENCE") {
        return Err("agent shim: already inside a fence".into());
    }
    let scope = env
        .get("ELDRUN_SCOPE")
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            "agent shim: not an Eldrun tab (no ELDRUN_SCOPE); open the CLI from an Eldrun tab".to_string()
        })?;
    let project_id = (scope != crate::storage::ROOT_SCOPE).then(|| scope.clone());
    let cwd = std::env::current_dir().map_err(|e| format!("agent shim: cwd: {e}"))?;
    Ok((project_id, cwd))
}

/// Build the fenced command for `cli args…` in the calling tab's scope.
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub fn command(cli: &str, args: &[String]) -> Result<std::process::Command, String> {
    let env: HashMap<String, String> = std::env::vars().collect();
    let (project_id, cwd) = plan(cli, &env)?;
    if !crate::commands::agents::agent_bins().contains(&cli) {
        return Err(format!("agent shim: '{cli}' is not a registry CLI"));
    }
    let scope_id = crate::services::agent_home::scope_of(project_id.as_deref());
    let roots = crate::services::agent_fence::roots_for_scope(project_id.as_deref(), true)
        .ok_or_else(|| format!("agent shim: unknown scope '{scope_id}'"))?;
    if !roots.iter().any(|root| cwd.starts_with(root)) {
        return Err(format!(
            "agent shim: {} is outside the scope's roots; cd into the project first",
            cwd.display()
        ));
    }
    let home = crate::services::agent_home::prepare_scope_home(&scope_id, &roots)
        .map_err(|e| format!("agent shim: prepare home: {e}"))?;
    let mut opts = crate::terminal::PtyOptions {
        id: format!("shim:{}", std::process::id()),
        cmd: cli.to_string(),
        args: args.to_vec(),
        env: env.clone(),
        cwd: cwd.to_string_lossy().into_owned(),
        cols: 80,
        rows: 24,
        local_only: true,
        sandbox: false,
        agent: true,
        project_id: project_id.clone(),
        remote_host_id: None,
        tmux_session: None,
        tmux_attach: None,
        host_bound_uid: None,
        schedule_target_id: None,
        host_session: false,
    };
    let own = roots
        .iter()
        .filter(|root| cwd.starts_with(root))
        .max_by_key(|root| root.components().count())
        .cloned()
        .unwrap_or_else(|| cwd.clone());
    crate::services::agent_fence::add_box_root_args(&mut opts, &roots, &own);
    #[cfg(target_os = "linux")]
    crate::services::agent_fence::wrap_pty_options_bwrap(&mut opts, &roots, &scope_id, &home.dir)?;
    #[cfg(target_os = "macos")]
    crate::services::agent_fence::wrap_pty_options_sandbox_exec(&mut opts, &roots, &scope_id, &home.dir)?;
    let mut command = std::process::Command::new(&opts.cmd);
    command.args(&opts.args).current_dir(&opts.cwd);
    for (k, v) in &opts.env {
        command.env(k, v);
    }
    if let Some(path) = crate::paths::effective_path() {
        command.env("PATH", path);
    }
    Ok(command)
}

/// The entry point behind `eldrun --agent-shim`. Replaces the process on
/// success; every failure is printed and becomes the exit status.
pub fn run(cli: &str, args: &[String]) -> i32 {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        use std::os::unix::process::CommandExt;
        match command(cli, args) {
            Ok(mut command) => {
                let err = command.exec();
                eprintln!("agent shim: exec: {err}");
                126
            }
            Err(e) => {
                eprintln!("{e}");
                1
            }
        }
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = (cli, args);
        eprintln!("agent shim: no fence on this platform; open the CLI from an Eldrun agent tab");
        1
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shim_refuses_outside_a_tab_inside_a_fence_and_for_paths() {
        let mut env = HashMap::new();
        assert!(plan("claude", &env).is_err());
        env.insert("ELDRUN_SCOPE".into(), "root".into());
        let (project, _) = plan("claude", &env).unwrap();
        assert_eq!(project, None);
        env.insert("ELDRUN_SCOPE".into(), "p1".into());
        assert_eq!(plan("claude", &env).unwrap().0.as_deref(), Some("p1"));
        assert!(plan("/usr/bin/claude", &env).is_err());
        env.insert("ELDRUN_AGENT_FENCE".into(), "1".into());
        assert!(plan("claude", &env).is_err());
    }
}
