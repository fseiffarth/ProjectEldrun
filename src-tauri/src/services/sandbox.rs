//! Docker sandbox for agent tabs.
//!
//! When a project's sandbox toggle is on, each agent tab (Claude/Codex/Gemini/
//! Vibe) is launched inside an ephemeral `docker run --rm` container that mounts
//! **only the project directory**, so the agent physically cannot reach host
//! files outside the project. Plain shell/files tabs are never sandboxed (the
//! frontend only sets `PtyOptions.sandbox` for `kind:"agent"` tabs of a
//! sandbox-enabled, non-remote project).
//!
//! Lifecycle: one ephemeral container per agent tab; `--rm` reaps it when the
//! tab's PTY exits. No shared/long-lived container state to manage.
//!
//! ## Session-resume & auth mount contract (correctness-critical)
//!
//! Agent resume (`agent_session::resolve_{claude,codex}_session`) and the
//! SessionStart hook assume the agent process sees the **host's** `~/.claude`,
//! `~/.codex`, and `<state_dir>/live_sessions` **at identical absolute paths**,
//! as a user whose `$HOME` matches the host. If any of these is wrong, resume
//! silently degrades to a fresh session and auth silently fails. The container
//! therefore:
//! - runs `--user <host-uid>:<host-gid>` so files written under `~/.claude` stay
//!   host-owned and `*_session_exists` can read them back next launch;
//! - sets `-e HOME=<host home>` (absolute) since resolvers/hook compute from it;
//! - bind-mounts host-path == container-path for the project dir, `~/.claude`,
//!   `~/.codex`, and the whole eldrun `state_dir` (covers `live_sessions/` and
//!   the hook script whose absolute path is baked into `~/.claude/settings.json`),
//!   plus best-effort `~/.config` (Gemini creds) when it exists;
//! - forwards `ELDRUN_TAB_UID`/`TERM`/`COLORTERM` and every `opts.env` entry, and
//!   re-exports agent-auth vars (`ssh_exec::AGENT_AUTH_ENV`) read off the host
//!   process env (the container inherits nothing).
//!
//! All paths are built from Rust path helpers as absolute strings — never relying
//! on `$HOME` shell-expansion, because `docker` is exec'd directly (no shell).

use std::collections::BTreeMap;
use std::process::Command;

use crate::paths;
use crate::storage;
use crate::terminal::PtyOptions;

/// Default image used when a project does not override it. Building/providing
/// this image is the user's responsibility; see `docker/agent-sandbox/`.
pub const DEFAULT_IMAGE: &str = "eldrun-agent-sandbox:latest";

/// Build the full `docker run …` argv that wraps `cmd cmd_args`. Pure: all
/// host-derived inputs are passed in, so this is unit-testable without touching
/// the environment, the filesystem, or docker. The resulting argv runs `cmd`
/// inside the container with only the mounts listed here.
#[allow(clippy::too_many_arguments)]
pub fn docker_run_args(
    image: &str,
    home: &str,
    state_dir: &str,
    uid: u32,
    gid: u32,
    cwd: &str,
    env: &BTreeMap<String, String>,
    auth_env: &BTreeMap<String, String>,
    extra_mounts: &[String],
    cmd: &str,
    cmd_args: &[String],
) -> Vec<String> {
    let mut a = vec![
        "run".to_string(),
        "--rm".to_string(),
        "-i".to_string(),
        "-t".to_string(),
        "--user".to_string(),
        format!("{uid}:{gid}"),
        "-e".to_string(),
        format!("HOME={home}"),
        "-w".to_string(),
        cwd.to_string(),
        // Identical-path mounts: the project dir (the only project bytes exposed)
        // and the agent state/auth dirs the resume machinery depends on.
        "-v".to_string(),
        format!("{cwd}:{cwd}"),
        "-v".to_string(),
        format!("{home}/.claude:{home}/.claude"),
        "-v".to_string(),
        format!("{home}/.codex:{home}/.codex"),
        "-v".to_string(),
        format!("{state_dir}:{state_dir}"),
    ];
    for m in extra_mounts {
        a.push("-v".to_string());
        a.push(m.clone());
    }
    a.push("-e".to_string());
    a.push("TERM=xterm-256color".to_string());
    a.push("-e".to_string());
    a.push("COLORTERM=truecolor".to_string());
    for (k, v) in env {
        a.push("-e".to_string());
        a.push(format!("{k}={v}"));
    }
    for (k, v) in auth_env {
        a.push("-e".to_string());
        a.push(format!("{k}={v}"));
    }
    a.push(image.to_string());
    a.push(cmd.to_string());
    a.extend(cmd_args.iter().cloned());
    a
}

/// Rewrite `opts` to run its command inside a Docker sandbox. No-op when
/// `opts.sandbox` is false. Errors (so `pty_spawn` surfaces the message in the
/// terminal) when docker or the image is unavailable, rather than silently
/// running the agent on the host.
pub fn wrap_pty_options_docker(opts: &mut PtyOptions) -> Result<(), String> {
    if !opts.sandbox {
        return Ok(());
    }
    // Defence-in-depth: sandbox is local-only. Never docker-wrap a remote
    // project (resolved explicitly from the tab's owning project id).
    if opts
        .project_id
        .as_deref()
        .is_some_and(|id| crate::services::remote::remote_target_for(id).is_some())
    {
        return Ok(());
    }

    let image = DEFAULT_IMAGE.to_string();
    preflight(&image)?;

    let home = paths::home_dir_string();
    let state_dir = storage::state_dir().to_string_lossy().into_owned();
    let (uid, gid) = host_uid_gid();

    // opts.env is already resolved (ELDRUN_TAB_UID, resume args' env, etc.).
    let env: BTreeMap<String, String> = opts.env.clone().into_iter().collect();
    let auth_env = host_auth_env();
    let extra_mounts = optional_mounts(&home);

    let args = docker_run_args(
        &image,
        &home,
        &state_dir,
        uid,
        gid,
        &opts.cwd,
        &env,
        &auth_env,
        &extra_mounts,
        &opts.cmd,
        &opts.args,
    );

    opts.cmd = "docker".to_string();
    opts.args = args;
    // Env now rides inside the docker argv as `-e` flags; the docker client
    // itself needs nothing from opts.env.
    opts.env.clear();
    Ok(())
}

/// Verify docker is installed and the image is present locally.
fn preflight(image: &str) -> Result<(), String> {
    let version = Command::new("docker").arg("--version").output();
    match version {
        Ok(o) if o.status.success() => {}
        _ => {
            return Err(
                "Docker sandbox: 'docker' not found or not runnable. Install Docker, or disable \
                 the sandbox toggle for this project."
                    .to_string(),
            )
        }
    }
    let inspect = Command::new("docker")
        .args(["image", "inspect", image])
        .output();
    match inspect {
        Ok(o) if o.status.success() => Ok(()),
        _ => Err(format!(
            "Docker sandbox: image '{image}' not found. Build it with \
             `docker build -t {image} docker/agent-sandbox`, or disable the sandbox toggle."
        )),
    }
}

/// Best-effort extra mounts that only make sense when they exist on the host.
fn optional_mounts(home: &str) -> Vec<String> {
    let mut mounts = Vec::new();
    let config = format!("{home}/.config");
    if std::path::Path::new(&config).is_dir() {
        mounts.push(format!("{config}:{config}"));
    }
    mounts
}

/// Agent-auth env vars present on the host process, forwarded into the
/// container (which inherits no environment). Sorted for determinism.
fn host_auth_env() -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for &k in crate::services::ssh_exec::AGENT_AUTH_ENV {
        if let Ok(v) = std::env::var(k) {
            if !v.is_empty() {
                out.insert(k.to_string(), v);
            }
        }
    }
    out
}

#[cfg(unix)]
fn host_uid_gid() -> (u32, u32) {
    // Safe: geteuid/getegid have no preconditions and cannot fail.
    unsafe { (libc::geteuid(), libc::getegid()) }
}

#[cfg(not(unix))]
fn host_uid_gid() -> (u32, u32) {
    (0, 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn args(strs: &[&str]) -> Vec<String> {
        strs.iter().map(|s| s.to_string()).collect()
    }

    /// Index of `needle` in `v`, or None.
    fn pos(v: &[String], needle: &str) -> Option<usize> {
        v.iter().position(|s| s == needle)
    }

    /// True if `v` contains the consecutive pair `flag value`.
    fn has_flag_value(v: &[String], flag: &str, value: &str) -> bool {
        v.windows(2).any(|w| w[0] == flag && w[1] == value)
    }

    #[test]
    fn claude_tab_argv_has_mounts_user_home_and_preserves_args() {
        let envs = env(&[("ELDRUN_TAB_UID", "tab-1")]);
        let out = docker_run_args(
            "img:latest",
            "/home/alice",
            "/home/alice/.local/share/eldrun",
            1000,
            1000,
            "/home/alice/eldrun/projects/p1",
            &envs,
            &BTreeMap::new(),
            &[],
            "claude",
            &args(&["--resume", "uuid-1"]),
        );

        assert_eq!(out[0], "run");
        assert!(out.contains(&"--rm".to_string()));
        assert!(has_flag_value(&out, "--user", "1000:1000"));
        assert!(has_flag_value(&out, "-e", "HOME=/home/alice"));
        assert!(has_flag_value(&out, "-w", "/home/alice/eldrun/projects/p1"));
        // Identical-path mounts.
        assert!(has_flag_value(
            &out,
            "-v",
            "/home/alice/eldrun/projects/p1:/home/alice/eldrun/projects/p1"
        ));
        assert!(has_flag_value(&out, "-v", "/home/alice/.claude:/home/alice/.claude"));
        assert!(has_flag_value(&out, "-v", "/home/alice/.codex:/home/alice/.codex"));
        assert!(has_flag_value(
            &out,
            "-v",
            "/home/alice/.local/share/eldrun:/home/alice/.local/share/eldrun"
        ));
        // Tab uid forwarded.
        assert!(has_flag_value(&out, "-e", "ELDRUN_TAB_UID=tab-1"));
        // Image precedes the command, original args preserved in order after it.
        let img = pos(&out, "img:latest").expect("image present");
        assert_eq!(out[img + 1], "claude");
        assert_eq!(out[img + 2], "--resume");
        assert_eq!(out[img + 3], "uuid-1");
    }

    #[test]
    fn codex_tab_preserves_resume_args() {
        let out = docker_run_args(
            "img:latest",
            "/home/alice",
            "/home/alice/.local/share/eldrun",
            1000,
            1000,
            "/home/alice/eldrun/projects/p1",
            &BTreeMap::new(),
            &BTreeMap::new(),
            &[],
            "codex",
            &args(&["resume", "live-id"]),
        );
        let img = pos(&out, "img:latest").expect("image present");
        assert_eq!(&out[img + 1..], &["codex", "resume", "live-id"]);
    }

    #[test]
    fn auth_env_forwarded_before_image() {
        let auth = env(&[("ANTHROPIC_API_KEY", "sk-test")]);
        let out = docker_run_args(
            "img:latest",
            "/home/alice",
            "/state",
            1000,
            1000,
            "/proj",
            &BTreeMap::new(),
            &auth,
            &[],
            "claude",
            &[],
        );
        assert!(has_flag_value(&out, "-e", "ANTHROPIC_API_KEY=sk-test"));
        let key = out
            .iter()
            .position(|s| s == "ANTHROPIC_API_KEY=sk-test")
            .unwrap();
        let img = pos(&out, "img:latest").unwrap();
        assert!(key < img, "auth env must precede the image");
    }

    #[test]
    fn extra_mounts_are_added() {
        let out = docker_run_args(
            "img:latest",
            "/home/alice",
            "/state",
            1000,
            1000,
            "/proj",
            &BTreeMap::new(),
            &BTreeMap::new(),
            &args(&["/home/alice/.config:/home/alice/.config"]),
            "gemini",
            &[],
        );
        assert!(has_flag_value(
            &out,
            "-v",
            "/home/alice/.config:/home/alice/.config"
        ));
    }

    #[test]
    fn wrap_is_noop_when_sandbox_disabled() {
        let mut opts = PtyOptions {
            id: "t".to_string(),
            cmd: "claude".to_string(),
            args: args(&["--session-id", "x"]),
            env: Default::default(),
            cwd: "/proj".to_string(),
            cols: 80,
            rows: 24,
            local_only: false,
            sandbox: false,
            project_id: None,
        };
        wrap_pty_options_docker(&mut opts).unwrap();
        assert_eq!(opts.cmd, "claude");
        assert_eq!(opts.args, args(&["--session-id", "x"]));
    }
}
