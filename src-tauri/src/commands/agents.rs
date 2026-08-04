//! Agent-CLI management: detect and install the AI coding-agent command-line
//! tools Eldrun can launch as agent tabs (Claude, Codex, Gemini, Mistral/vibe,
//! Aider, OpenCode, Cursor, Copilot, Grok, Qwen, OpenClaw).
//!
//! This mirrors the local-model install flow in `commands::ollama` (see
//! `install_vibe`), but is registry-driven so the set of agents lives in one
//! table (`AGENTS`). Each spec carries the binary name, the official one-line
//! install command, and any well-known user install locations to also check,
//! since Eldrun's inherited `PATH` may omit `~/.local/bin` / npm's global bin
//! even when a login shell would include them.

/// A single installable agent CLI.
#[derive(Clone, Copy)]
struct AgentSpec {
    /// Stable id used by the frontend and `install-progress` events.
    id: &'static str,
    /// Human-readable label.
    label: &'static str,
    /// Binary name to probe on `PATH` (`where` on Windows, `which` elsewhere).
    bin: &'static str,
    /// Official non-interactive install command (Linux/macOS, run in `sh`).
    install_cmd: &'static str,
    /// Official non-interactive install command on Windows, when one exists.
    /// `None` means there is no one-line Windows installer — the UI then points
    /// at `docs` instead. Commands using `irm`/`iex` are PowerShell-only; plain
    /// `npm`/`python` commands run in either PowerShell or Command Prompt (see
    /// `windows_shell`).
    install_cmd_windows: Option<&'static str>,
    /// Extra home-relative paths to check when the PATH lookup misses (PATH gaps).
    extra_paths: &'static [&'static str],
    /// Docs URL shown when automatic install isn't possible.
    docs: &'static str,
}

/// The shell a Windows install command must be run in, derived from the command
/// itself: `irm … | iex` is PowerShell-only; `npm`/`python` installs work in
/// either PowerShell or the classic Command Prompt.
fn windows_shell(cmd: &str) -> &'static str {
    if cmd.contains("iex") || cmd.trim_start().starts_with("irm") {
        "PowerShell"
    } else {
        "PowerShell or Command Prompt"
    }
}

fn windows_shell_kind(cmd: &str) -> &'static str {
    if cmd.contains("iex") || cmd.trim_start().starts_with("irm") {
        "powershell"
    } else {
        "default"
    }
}

/// The install command + the shell it runs in, for the host OS. On Windows the
/// command is `None` when no one-line installer exists.
fn platform_install(spec: &AgentSpec) -> (Option<&'static str>, String, &'static str) {
    if cfg!(target_os = "windows") {
        let shell = spec
            .install_cmd_windows
            .map(windows_shell)
            .unwrap_or("PowerShell")
            .to_string();
        let kind = spec
            .install_cmd_windows
            .map(windows_shell_kind)
            .unwrap_or("powershell");
        (spec.install_cmd_windows, shell, kind)
    } else {
        (Some(spec.install_cmd), "bash".to_string(), "bash")
    }
}

/// The built-in agent registry. The order here is the order the UI lists them.
const AGENTS: &[AgentSpec] = &[
    AgentSpec {
        id: "claude",
        label: "Claude",
        bin: "claude",
        install_cmd: "curl -fsSL https://claude.ai/install.sh | bash",
        install_cmd_windows: Some("irm https://claude.ai/install.ps1 | iex"),
        extra_paths: &[".local/bin/claude"],
        docs: "https://docs.anthropic.com/en/docs/claude-code/setup",
    },
    AgentSpec {
        id: "codex",
        label: "Codex",
        bin: "codex",
        install_cmd: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
        install_cmd_windows: Some("irm https://chatgpt.com/codex/install.ps1 | iex"),
        extra_paths: &[".local/bin/codex"],
        docs: "https://github.com/openai/codex",
    },
    AgentSpec {
        id: "gemini",
        label: "Gemini",
        bin: "gemini",
        install_cmd: "npm install -g @google/gemini-cli",
        install_cmd_windows: Some("npm install -g @google/gemini-cli"),
        extra_paths: &[".local/bin/gemini"],
        docs: "https://github.com/google-gemini/gemini-cli",
    },
    AgentSpec {
        id: "vibe",
        label: "Mistral",
        bin: "vibe",
        install_cmd: "curl -LsSf https://mistral.ai/vibe/install.sh | bash",
        // No one-line Windows installer; the UI points at `docs`.
        install_cmd_windows: None,
        extra_paths: &[".local/bin/vibe", ".cargo/bin/vibe"],
        docs: "https://docs.mistral.ai/getting-started/quickstarts/vibe-code/install-cli",
    },
    AgentSpec {
        id: "aider",
        label: "Aider",
        bin: "aider",
        install_cmd: "python -m pip install aider-install && aider-install",
        install_cmd_windows: Some("python -m pip install aider-install && aider-install"),
        extra_paths: &[".local/bin/aider"],
        docs: "https://aider.chat/docs/install.html",
    },
    AgentSpec {
        id: "opencode",
        label: "OpenCode",
        bin: "opencode",
        install_cmd: "curl -fsSL https://opencode.ai/install | bash",
        install_cmd_windows: Some("npm install -g opencode-ai"),
        extra_paths: &[".opencode/bin/opencode", ".local/bin/opencode"],
        docs: "https://opencode.ai/docs/",
    },
    AgentSpec {
        id: "cursor-agent",
        label: "Cursor",
        bin: "cursor-agent",
        install_cmd: "curl https://cursor.com/install -fsS | bash",
        // No one-line Windows installer; the UI points at `docs`.
        install_cmd_windows: None,
        extra_paths: &[".local/bin/cursor-agent"],
        docs: "https://cursor.com/docs/cli/installation",
    },
    AgentSpec {
        id: "copilot",
        label: "Copilot",
        bin: "copilot",
        install_cmd: "npm install -g @github/copilot",
        install_cmd_windows: Some("npm install -g @github/copilot"),
        extra_paths: &[".local/bin/copilot"],
        docs: "https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli",
    },
    AgentSpec {
        id: "grok",
        label: "Grok",
        bin: "grok",
        install_cmd: "npm install -g @vibe-kit/grok-cli",
        install_cmd_windows: Some("npm install -g @vibe-kit/grok-cli"),
        extra_paths: &[".local/bin/grok"],
        docs: "https://github.com/superagent-ai/grok-cli",
    },
    AgentSpec {
        id: "qwen",
        label: "Qwen",
        bin: "qwen",
        install_cmd: "npm install -g @qwen-code/qwen-code",
        install_cmd_windows: Some("npm install -g @qwen-code/qwen-code"),
        extra_paths: &[".local/bin/qwen"],
        docs: "https://github.com/QwenLM/qwen-code",
    },
    AgentSpec {
        id: "openclaw",
        label: "OpenClaw",
        bin: "openclaw",
        install_cmd: "npm install -g openclaw",
        install_cmd_windows: Some("npm install -g openclaw"),
        extra_paths: &[".local/bin/openclaw"],
        docs: "https://docs.openclaw.ai",
    },
];

/// Public view of one agent + whether it is currently installed.
#[derive(serde::Serialize)]
pub struct AgentInfo {
    pub id: String,
    pub label: String,
    pub bin: String,
    /// The install command for the host OS, or empty when there is no one-line
    /// installer on this platform (Windows-only case — fall back to `docs`).
    pub install_cmd: String,
    /// The shell `install_cmd` is meant to run in: `bash` on Linux/macOS,
    /// `PowerShell` or `PowerShell or Command Prompt` on Windows.
    pub shell: String,
    /// Machine-readable terminal shell policy for the frontend.
    pub shell_kind: String,
    /// `npm uninstall -g <pkg>` for an npm-installed agent, empty otherwise —
    /// the terminal fallback the frontend offers next to "Remove" when the
    /// one-click uninstall hits a permission error (a system-wide npm global
    /// directory owned by root, common on non-nvm Linux Node installs, needs a
    /// sudo prompt Eldrun cannot answer itself).
    pub uninstall_cmd: String,
    /// `install_cmd` prefixed with `sudo`, or empty when that wouldn't make
    /// sense (Windows, or a non-npm installer — see `sudo_variant`). Offered as
    /// a second one-click "run with elevated rights" terminal button beside the
    /// plain command, since the plain one is what most installs actually need
    /// (nvm and other per-user Node installs) and forcing `sudo` into the
    /// default one-click install would root-own files for that majority.
    pub install_cmd_sudo: String,
    /// `uninstall_cmd` prefixed with `sudo`, same rule as `install_cmd_sudo`.
    pub uninstall_cmd_sudo: String,
    pub docs: String,
    pub installed: bool,
}

fn find_spec(id: &str) -> Option<&'static AgentSpec> {
    AGENTS.iter().find(|a| a.id == id)
}

/// POSIX login-shell script used by the explicit "install on remote machine"
/// action. Agent ids resolve through the same registry as local installation,
/// so the frontend never supplies executable text. Probe before and after: a
/// repeat click is harmless, and installer success without a reachable binary
/// is reported as failure rather than as a false green result.
fn remote_install_script(spec: &AgentSpec) -> String {
    format!(
        "if command -v {bin} >/dev/null 2>&1; then \
           echo '{label} is already installed on this machine.'; \
           exit 0; \
         fi; \
         echo 'Installing {label} on this machine...'; \
         {install}; \
         install_status=$?; \
         if [ \"$install_status\" -ne 0 ]; then exit \"$install_status\"; fi; \
         hash -r 2>/dev/null || true; \
         if command -v {bin} >/dev/null 2>&1; then \
           echo '{label} installed successfully.'; \
         else \
           echo '{label} installer finished, but {bin} is not on the login-shell PATH.' >&2; \
           exit 127; \
         fi",
        bin = spec.bin,
        label = spec.label,
        install = spec.install_cmd,
    )
}

/// Install a known agent CLI on one configured global remote machine.
///
/// This is an explicit user gesture, so the SSH dial is declared foreground.
/// Authentication follows the same saved-password/key/ControlMaster path as
/// the global machine monitor. The command itself is registry-owned and runs in
/// the remote account's login shell, where npm/nvm and user install paths live.
#[tauri::command]
pub async fn install_agent_remote(
    agent_id: String,
    machine_id: String,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let spec = find_spec(&agent_id)
            .ok_or_else(|| format!("unknown agent: {agent_id}"))?;
        let machine = crate::commands::global_machines::find_by_id(&machine_id)
            .ok_or_else(|| "remote machine is no longer configured".to_string())?;

        use crate::services::remote_credentials as creds;
        let _dial = crate::services::ssh_common::declared_dial(
            Some(false),
            &machine.user,
            &machine.host,
            machine.port,
        );
        let account = creds::ssh_account(&machine.user, &machine.host, machine.port);
        let password = creds::get(&account);
        let script = remote_install_script(spec);
        let quoted = crate::services::ssh_exec::shell_quote(&script);
        let command = format!("exec \"${{SHELL:-/bin/sh}}\" -lc {quoted}");
        crate::commands::ssh::run_ssh_auth(
            &machine.user,
            &machine.host,
            machine.port,
            password.as_deref(),
            &[&command],
        )
    })
    .await
    .map_err(|e| format!("remote agent installer task failed: {e}"))?
}

/// The same install, as a command line for a **visible terminal tab** instead of
/// a headless run.
///
/// `install_agent_remote` reports one string when it is over and nothing while it
/// runs, which is the wrong shape for the thing that actually goes wrong here: an
/// npm install on someone else's machine takes minutes, prints its progress, and
/// can stop on a question (a `sudo` password, an nvm shell that has to be sourced,
/// a host key). All of that is invisible headlessly, so a slow install and a hung
/// one look identical and a prompt is simply never answered.
///
/// Same registry-owned script (`remote_install_script`) and the same machine
/// lookup — the frontend supplies an agent id and a machine id, never executable
/// text. What differs is only the transport: `ssh -t` into the login shell, typed
/// into a root-scope shell tab, where the user reads the output and answers what
/// it asks.
///
/// Deliberately **not** registered with `credentials::note_minted_login`: this
/// command line does not stop at a login prompt, it goes on to run an installer,
/// so a "type my saved password" paste aimed at it could land in whatever prompt
/// the installer happens to be showing. The interactive login is still typed by
/// hand, or ridden for free off the shared ControlMaster.
#[tauri::command]
pub fn install_agent_remote_command(
    agent_id: String,
    machine_id: String,
) -> Result<String, String> {
    let spec = find_spec(&agent_id).ok_or_else(|| format!("unknown agent: {agent_id}"))?;
    let machine = crate::commands::global_machines::find_by_id(&machine_id)
        .ok_or_else(|| "remote machine is no longer configured".to_string())?;
    let script = remote_install_script(spec);
    let quoted = crate::services::ssh_exec::shell_quote(&script);
    let remote = format!("\"${{SHELL:-/bin/sh}}\" -lc {quoted}");
    crate::services::ssh_exec::interactive_exec_command(
        &machine.user,
        &machine.host,
        machine.port,
        &remote,
    )
}

/// Where `spec`'s binary actually lives — on `PATH` (including Eldrun's
/// supplemental Windows/macOS fallback dirs) or in one of its well-known
/// per-user install locations — or `None` when it isn't installed. The single
/// resolver behind both `spec_is_installed` and `uninstall_agent` (removal
/// deletes exactly the file detection found, never a guess).
///
/// PATH lookup goes through the shared cross-platform helper (`where` on Windows,
/// `which` elsewhere): `which` does not exist on Windows, so probing it directly
/// reported every Windows install — Claude included — as missing.
fn resolve_spec_path(spec: &AgentSpec) -> Option<std::path::PathBuf> {
    if let Some(path) = crate::paths::resolve_executable(spec.bin) {
        return Some(path);
    }
    let home = crate::paths::home_dir();
    spec.extra_paths.iter().find_map(|rel| {
        let base = home.join(rel);
        if base.exists() {
            return Some(base);
        }
        // On Windows the extra paths omit the executable extension that the
        // installer actually writes (e.g. `.local/bin/claude` → `claude.exe`).
        if cfg!(target_os = "windows") {
            for ext in ["exe", "cmd", "bat", "ps1"] {
                let cand = base.with_extension(ext);
                if cand.exists() {
                    return Some(cand);
                }
            }
        }
        None
    })
}

/// True when an agent's binary is reachable on `PATH` or in one of its
/// well-known user install locations.
fn spec_is_installed(spec: &AgentSpec) -> bool {
    resolve_spec_path(spec).is_some()
}

/// True when the given agent (by id) is installed. Unknown ids return false.
#[tauri::command]
pub async fn agent_is_installed(id: String) -> bool {
    find_spec(&id).map(spec_is_installed).unwrap_or(false)
}

/// True when Node.js' `npm` is reachable on `PATH`. Most agent CLIs install via
/// `npm install -g …`, so the Manage Agents panel uses this to decide whether to
/// surface its "install Node/npm first" helper.
#[tauri::command]
pub async fn npm_is_installed() -> bool {
    crate::paths::binary_on_path("npm")
}

/// Probe arbitrary commands (user-defined custom agents, which aren't in the
/// built-in `AGENTS` registry) for install status, returning the subset present.
/// A bare name is looked up on `PATH`; a value containing a path separator is
/// checked as a file path so a custom agent pointed at a full path resolves too.
#[tauri::command]
pub async fn probe_binaries(bins: Vec<String>) -> Vec<String> {
    bins.into_iter()
        .filter(|b| {
            if b.contains('/') || b.contains('\\') {
                std::path::Path::new(b).exists()
            } else {
                crate::paths::binary_on_path(b)
            }
        })
        .collect()
}

/// Sync install probe for callers outside the agent registry (e.g. the local-
/// model drivers in `commands::ollama`). Looks `bin` up in the registry first so
/// it reuses the known user install locations; falls back to a bare PATH lookup
/// for binaries the registry doesn't track (e.g. Droid).
pub fn binary_is_installed(bin: &str) -> bool {
    AGENTS
        .iter()
        .find(|a| a.bin == bin)
        .map(spec_is_installed)
        .unwrap_or_else(|| crate::paths::binary_on_path(bin))
}

/// Whether Codex is actually running Eldrun's `SessionStart` hook — the precise
/// path for resuming a tab's *current* conversation. Codex gates user-level hooks
/// behind a one-time trust approval (`/hooks`), and an untrusted one never fires,
/// silently; Eldrun then falls back to guessing the session from Codex's rollout
/// logs (`services::codex_bind`). The UI reads this to offer the one-click fix.
#[tauri::command]
pub async fn codex_hook_status() -> crate::services::agent_session::CodexHookState {
    crate::services::agent_session::codex_hook_state()
}

/// `cmd` prefixed with `sudo`, for the one-click "run with elevated rights"
/// terminal fallback beside a plain `npm install -g`/`npm uninstall -g`
/// command — the actual EACCES case (a system-wide, root-owned npm global
/// directory, the default on a non-nvm Linux/macOS Node install). Empty for
/// anything else: `sudo` doesn't exist on Windows, and a curl/irm/pip
/// installer targets the user's own home directory, where running it as root
/// would create root-owned files there instead of fixing anything.
fn sudo_variant(cmd: &str) -> String {
    if !cfg!(windows) && (cmd.starts_with("npm install -g ") || cmd.starts_with("npm uninstall -g ")) {
        format!("sudo {cmd}")
    } else {
        String::new()
    }
}

/// List every known agent CLI with its current installed status.
#[tauri::command]
pub async fn list_agents() -> Vec<AgentInfo> {
    AGENTS
        .iter()
        .map(|spec| {
            let (cmd, shell, shell_kind) = platform_install(spec);
            let install_cmd = cmd.unwrap_or("").to_string();
            let uninstall_cmd = cmd
                .and_then(npm_package_from_cmd)
                .map(|pkg| format!("npm uninstall -g {pkg}"))
                .unwrap_or_default();
            AgentInfo {
                id: spec.id.to_string(),
                label: spec.label.to_string(),
                bin: spec.bin.to_string(),
                install_cmd_sudo: sudo_variant(&install_cmd),
                install_cmd,
                shell,
                shell_kind: shell_kind.to_string(),
                uninstall_cmd_sudo: sudo_variant(&uninstall_cmd),
                uninstall_cmd,
                docs: spec.docs.to_string(),
                installed: spec_is_installed(spec),
            }
        })
        .collect()
}

/// Build the process that runs `spec`'s installer for the host OS, with stdout
/// and stderr merged in-shell (the read loop only drains stdout — merging in the
/// shell keeps interleaving right and avoids a stderr-fill deadlock).
///
/// Linux/macOS run `install_cmd` via `sh`. Windows runs `install_cmd_windows`
/// via PowerShell when the command is PowerShell-only (`irm … | iex`), else via
/// `cmd /C` — plain `npm`/`python` installs may chain with `&&`, which Windows
/// PowerShell 5.1 does not parse but cmd does.
fn installer_command(spec: &AgentSpec) -> Result<std::process::Command, String> {
    #[cfg(windows)]
    {
        let cmd_str = spec.install_cmd_windows.ok_or_else(|| {
            format!(
                "{} has no one-line Windows installer. See {}.",
                spec.label, spec.docs
            )
        })?;
        let mut c;
        if windows_shell_kind(cmd_str) == "powershell" {
            c = crate::paths::command_no_window("powershell");
            c.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command"])
                // Scriptblock-wrap so `2>&1` merges the whole pipeline's error
                // stream, not just the last command's.
                .arg(format!("& {{ {cmd_str} }} 2>&1"));
        } else {
            c = crate::paths::command_no_window("cmd");
            // cmd doesn't take an argv — hand it the raw line un-requoted.
            use std::os::windows::process::CommandExt;
            c.raw_arg(format!("/C {cmd_str} 2>&1"));
        }
        Ok(c)
    }
    #[cfg(not(windows))]
    {
        if !cfg!(any(target_os = "linux", target_os = "macos")) {
            return Err(format!(
                "Automatic install is not supported on this OS. See {}.",
                spec.docs
            ));
        }
        let mut c = crate::paths::command_no_window("sh");
        c.arg("-c").arg(format!("{} 2>&1", spec.install_cmd));
        Ok(c)
    }
}

/// The command string to suggest re-running manually when the installer fails,
/// for the host OS.
fn manual_install_cmd(spec: &AgentSpec) -> &'static str {
    if cfg!(windows) {
        spec.install_cmd_windows.unwrap_or(spec.install_cmd)
    } else {
        spec.install_cmd
    }
}

/// Install an agent CLI via its official install command.
///
/// Streams the installer's combined stdout+stderr to the frontend line-by-line
/// via `agent-install-progress` events (`{ id, line }`) so the UI can show live
/// progress. Returns the install log on success, or the tail of the output on
/// failure. The post-install probe is the real source of truth.
#[tauri::command]
pub async fn install_agent(app: tauri::AppHandle, id: String) -> Result<String, String> {
    use std::io::{BufRead, BufReader};
    use tauri::Emitter;

    let spec = find_spec(&id).ok_or_else(|| format!("unknown agent: {id}"))?;

    if spec_is_installed(spec) {
        return Ok(format!("{} is already installed.", spec.label));
    }

    let id_owned = id.clone();
    let emit = move |line: &str| {
        let _ = app.emit(
            "agent-install-progress",
            serde_json::json!({ "id": id_owned, "line": line }),
        );
    };
    emit(&format!("Starting {} installer…", spec.label));

    let mut child = installer_command(spec)?
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to launch installer: {e}"))?;

    let mut lines: Vec<String> = Vec::new();
    if let Some(stdout) = child.stdout.take() {
        for line in BufReader::new(stdout).lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => break,
            };
            emit(&line);
            lines.push(line);
        }
    }

    let status = child
        .wait()
        .map_err(|e| format!("installer did not finish: {e}"))?;
    let combined = lines.join("\n").trim().to_string();

    if !status.success() {
        let tail: Vec<&str> = combined.lines().rev().take(20).collect();
        let tail = tail.into_iter().rev().collect::<Vec<_>>().join("\n");
        let mut msg = if tail.is_empty() {
            format!(
                "installer exited unsuccessfully ({status}). Run `{}` in a terminal.",
                manual_install_cmd(spec)
            )
        } else {
            tail
        };
        // EACCES on a headless install is almost always a root-owned npm global
        // directory (system-wide Node, no nvm) — this process has no TTY to run
        // `sudo` through, so point at the terminal fallback that can.
        let sudo_cmd = sudo_variant(manual_install_cmd(spec));
        if !sudo_cmd.is_empty() && is_permission_error(&msg) {
            msg.push_str(&format!(
                "\n\nThis needs elevated rights (a system-wide npm global directory owned by \
                root — common when Node was installed system-wide rather than per-user). Eldrun \
                never prompts for a password itself: use the \"Run with sudo\" button below, or \
                run `{sudo_cmd}` yourself in a terminal."
            ));
        }
        return Err(msg);
    }

    // The post-install check is the real source of truth.
    if !spec_is_installed(spec) {
        return Err(format!(
            "installer ran but `{}` is still not detected. It may need a new shell so \
            the install dir is on PATH — run `{}` in a terminal.\n\n{combined}",
            spec.bin,
            manual_install_cmd(spec)
        ));
    }

    emit("Done.");
    Ok(if combined.is_empty() {
        format!("{} installed.", spec.label)
    } else {
        combined
    })
}

/// The npm package spec an `npm install -g <pkg>` command installs, or `None`
/// for a curl/irm script installer (which has no npm package to remove — its
/// binary is deleted directly instead). Used so uninstall targets the exact
/// package the installer added rather than guessing from the agent id.
fn npm_package_from_cmd(cmd: &str) -> Option<&str> {
    cmd.trim()
        .strip_prefix("npm install -g ")?
        .split_whitespace()
        .next()
}

/// Run `cmd` to completion and return its combined stdout+stderr, trimmed.
/// `Err` carries that same output (or a status-only message when the command
/// produced none) on a non-zero exit.
fn run_capture(mut cmd: std::process::Command) -> Result<String, String> {
    let output = cmd
        .output()
        .map_err(|e| format!("failed to run command: {e}"))?;
    let mut combined = String::from_utf8_lossy(&output.stdout).into_owned();
    combined.push_str(&String::from_utf8_lossy(&output.stderr));
    let combined = combined.trim().to_string();
    if !output.status.success() {
        return Err(if combined.is_empty() {
            format!("command exited unsuccessfully ({})", output.status)
        } else {
            combined
        });
    }
    Ok(combined)
}

/// True when an error message reads as a permission/lock failure rather than
/// a genuine "nothing to remove" — `EACCES`/"permission denied" (a system-wide
/// npm global directory owned by root, the default on a non-nvm Linux Node
/// install) and `EPERM`/`EBUSY` (a file locked by a running process, common on
/// Windows). Used to swap in guidance pointing at a terminal Eldrun can't
/// elevate on the user's behalf, instead of a bare stack of npm's own output.
fn is_permission_error(msg: &str) -> bool {
    let lower = msg.to_lowercase();
    ["eacces", "eperm", "ebusy", "permission denied"]
        .iter()
        .any(|needle| lower.contains(needle))
}

/// Build the `npm uninstall -g <pkg>` process for the host OS (same shell
/// choice as the npm branch of `installer_command`: `cmd /C` on Windows, `sh -c`
/// elsewhere).
fn npm_uninstall_command(pkg: &str) -> std::process::Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut c = crate::paths::command_no_window("cmd");
        c.raw_arg(format!("/C npm uninstall -g {pkg} 2>&1"));
        c
    }
    #[cfg(not(windows))]
    {
        let mut c = crate::paths::command_no_window("sh");
        c.arg("-c").arg(format!("npm uninstall -g {pkg} 2>&1"));
        c
    }
}

/// Remove an installed agent CLI so it can be cleanly reinstalled — the
/// "Remove" action in Manage Agents, and the first half of "Reinstall".
///
/// An agent installed via `npm install -g <pkg>` is removed with the matching
/// `npm uninstall -g` — deleting just the PATH shim would leave the package
/// registered, so a subsequent install becomes a no-op re-link instead of a
/// fresh fetch. Every other agent (curl/irm script installers) drops exactly
/// the binary/shim `resolve_spec_path` found — enough to flip
/// `spec_is_installed` back to false and let the official installer run again
/// from scratch; any support files the installer left behind (an updater, a
/// packages cache) are none of Eldrun's business to guess at and clean up.
#[tauri::command]
pub async fn uninstall_agent(id: String) -> Result<String, String> {
    let spec = find_spec(&id).ok_or_else(|| format!("unknown agent: {id}"))?;

    let cmd_for_platform = if cfg!(windows) {
        spec.install_cmd_windows.unwrap_or(spec.install_cmd)
    } else {
        spec.install_cmd
    };

    if let Some(pkg) = npm_package_from_cmd(cmd_for_platform) {
        if !spec_is_installed(spec) {
            return Ok(format!("{} is not installed.", spec.label));
        }
        let out = run_capture(npm_uninstall_command(pkg)).map_err(|e| {
            if is_permission_error(&e) {
                format!(
                    "Permission denied — this machine's npm global directory needs \
                    elevated rights (common when Node was installed system-wide rather \
                    than per-user). Eldrun never prompts for a password itself: run \
                    `npm uninstall -g {pkg}` yourself in an elevated terminal (or via \
                    the terminal button below).\n\n{e}"
                )
            } else {
                e
            }
        })?;
        if spec_is_installed(spec) {
            return Err(format!(
                "npm uninstall ran but `{}` is still detected on PATH.\n\n{out}",
                spec.bin
            ));
        }
        return Ok(if out.is_empty() {
            format!("{} removed.", spec.label)
        } else {
            out
        });
    }

    let path = resolve_spec_path(spec).ok_or_else(|| format!("{} is not installed.", spec.label))?;
    std::fs::remove_file(&path).map_err(|e| {
        let shown = path.display();
        if e.kind() == std::io::ErrorKind::PermissionDenied {
            format!(
                "Permission denied removing {shown} — it's owned by another user \
                (likely installed as root/admin). Remove it yourself in an elevated \
                terminal (`rm {shown}`, or the OS equivalent)."
            )
        } else {
            format!("failed to remove {shown}: {e}")
        }
    })?;
    Ok(format!("{} removed ({}).", spec.label, path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_shell_flags_powershell_only_commands() {
        // `irm … | iex` is PowerShell syntax.
        assert_eq!(
            windows_shell("irm https://claude.ai/install.ps1 | iex"),
            "PowerShell"
        );
        // npm/python installs run in either shell.
        assert_eq!(
            windows_shell("npm install -g @google/gemini-cli"),
            "PowerShell or Command Prompt"
        );
    }

    #[test]
    fn claude_has_a_powershell_windows_installer() {
        let claude = find_spec("claude").expect("claude in registry");
        let win = claude
            .install_cmd_windows
            .expect("claude has a Windows installer");
        assert!(
            win.contains("irm"),
            "expected the PowerShell `irm` installer"
        );
        assert!(
            !win.contains("curl"),
            "Windows installer must not use curl/bash"
        );
    }

    #[test]
    fn npm_package_from_cmd_extracts_the_package_spec() {
        assert_eq!(
            npm_package_from_cmd("npm install -g @google/gemini-cli"),
            Some("@google/gemini-cli")
        );
        assert_eq!(
            npm_package_from_cmd("npm install -g opencode-ai"),
            Some("opencode-ai")
        );
        // curl/irm script installers have no npm package to uninstall.
        assert_eq!(
            npm_package_from_cmd("curl -fsSL https://claude.ai/install.sh | bash"),
            None
        );
        assert_eq!(
            npm_package_from_cmd("irm https://chatgpt.com/codex/install.ps1 | iex"),
            None
        );
    }

    #[test]
    fn is_permission_error_matches_npm_and_windows_lock_failures() {
        // Real npm output, old and new formats, both cases.
        assert!(is_permission_error("npm ERR! code EACCES\nnpm ERR! syscall rename"));
        assert!(is_permission_error("npm error code EACCES"));
        assert!(is_permission_error("Access is denied. (os error 5) EPERM"));
        assert!(is_permission_error("resource busy or locked, rename 'x' EBUSY"));
        assert!(is_permission_error("Permission denied (os error 13)"));
        assert!(!is_permission_error("npm ERR! 404 Not Found"));
        assert!(!is_permission_error("command exited unsuccessfully (exit status: 1)"));
    }

    #[test]
    fn sudo_variant_only_covers_plain_npm_commands() {
        assert_eq!(
            sudo_variant("npm install -g @vibe-kit/grok-cli"),
            if cfg!(windows) { String::new() } else { "sudo npm install -g @vibe-kit/grok-cli".to_string() }
        );
        assert_eq!(
            sudo_variant("npm uninstall -g @vibe-kit/grok-cli"),
            if cfg!(windows) { String::new() } else { "sudo npm uninstall -g @vibe-kit/grok-cli".to_string() }
        );
        // A curl/irm/pip installer targets the user's own home directory —
        // running it as root would create root-owned files there instead of
        // fixing anything, so it must never get a sudo variant.
        assert_eq!(sudo_variant("curl -fsSL https://claude.ai/install.sh | bash"), "");
        assert_eq!(
            sudo_variant("python -m pip install aider-install && aider-install"),
            ""
        );
        assert_eq!(sudo_variant(""), "");
    }

    #[test]
    fn uninstall_cmd_is_populated_only_for_npm_installed_agents() {
        // Gemini installs via npm on every platform, so its uninstall command
        // must be derivable regardless of host OS this test runs on.
        let gemini = find_spec("gemini").expect("gemini in registry");
        let (cmd, _, _) = platform_install(gemini);
        let uninstall = cmd
            .and_then(npm_package_from_cmd)
            .map(|pkg| format!("npm uninstall -g {pkg}"));
        assert_eq!(uninstall.as_deref(), Some("npm uninstall -g @google/gemini-cli"));

        // Claude's curl/irm script installer has no npm package, so no
        // uninstall command should be synthesized for it.
        let claude = find_spec("claude").expect("claude in registry");
        let (cmd, _, _) = platform_install(claude);
        assert!(cmd.and_then(npm_package_from_cmd).is_none());
    }

    #[test]
    fn every_npm_installed_agent_resolves_to_its_package() {
        // Every agent whose install command is npm-based must round-trip
        // through `npm_package_from_cmd`, since `uninstall_agent` relies on it
        // to target `npm uninstall -g` rather than deleting a shim.
        for spec in AGENTS {
            for cmd in [Some(spec.install_cmd), spec.install_cmd_windows].into_iter().flatten() {
                if cmd.trim_start().starts_with("npm install -g") {
                    assert!(
                        npm_package_from_cmd(cmd).is_some(),
                        "{}'s npm install command did not parse: {cmd}",
                        spec.id
                    );
                }
            }
        }
    }

    #[test]
    fn every_agent_serves_a_shell_label() {
        for spec in AGENTS {
            let (_cmd, shell, shell_kind) = platform_install(spec);
            assert!(!shell.is_empty(), "{} has no shell label", spec.id);
            assert!(
                matches!(shell_kind, "bash" | "powershell" | "default"),
                "{} has an invalid shell kind",
                spec.id
            );
        }
    }

    #[test]
    fn remote_install_uses_the_registry_command_and_probes_both_sides() {
        let gemini = find_spec("gemini").expect("gemini in registry");
        let script = remote_install_script(gemini);
        assert!(script.contains("npm install -g @google/gemini-cli"));
        assert_eq!(script.matches("command -v gemini").count(), 2);
        assert!(script.contains("hash -r"));
        assert!(script.contains("exit 127"));
    }

    /// The terminal variant runs the SAME script over an interactive ssh: same
    /// probe-install-probe text, a remote PTY (`-t`) so the installer's prompts
    /// are answerable, and the script carried as one shell-quoted argument.
    #[test]
    fn remote_install_terminal_command_runs_the_same_script_on_a_pty() {
        let gemini = find_spec("gemini").expect("gemini in registry");
        let script = remote_install_script(gemini);
        let quoted = crate::services::ssh_exec::shell_quote(&script);
        let remote = format!("\"${{SHELL:-/bin/sh}}\" -lc {quoted}");
        let cmd = crate::services::ssh_exec::interactive_exec_command(
            &Some("alice".to_string()),
            "host.example",
            Some(2222),
            &remote,
        )
        .expect("command builds");
        assert!(cmd.starts_with("'ssh' "));
        assert!(cmd.contains("'alice@host.example'"));
        assert!(cmd.contains("'-p' '2222'"));
        assert!(cmd.contains("'-t'"));
        // The whole remote command is one argv item, so the local shell can't
        // re-split the installer script on its spaces.
        assert!(cmd.contains("npm install -g @google/gemini-cli"));
        assert!(cmd.trim_end().ends_with('\''));
    }

    /// **Tripwire: the two install tables must not drift** (#28b).
    ///
    /// `services::remote_agents::RECIPES` restates a few of these rows as
    /// fragments of a remote shell script — it is a `services/` module and cannot
    /// reach this one — and the pair had already drifted once: this registry moved
    /// Claude to the official `install.sh` while the remote bootstrap went on
    /// running `npm install -g @anthropic-ai/claude-code`, so the same agent name
    /// installed two different binaries depending on which machine it landed on.
    ///
    /// Nothing forces the tables to agree at compile time, so it is asserted here:
    /// every remote recipe must name an agent this registry knows, with the same
    /// Unix install command. Adding an agent stays a one-row edit; adding it in
    /// only one of the two places is what fails.
    #[test]
    fn every_remote_recipe_matches_its_registry_row() {
        for recipe in crate::services::remote_agents::recipes() {
            let spec = AGENTS
                .iter()
                .find(|a| a.bin == recipe.bin)
                .unwrap_or_else(|| panic!("remote recipe '{}' names no known agent", recipe.bin));
            assert_eq!(
                spec.install_cmd, recipe.install,
                "'{}' installs differently locally and remotely",
                recipe.bin
            );
        }
    }

    /// Windows one-click install picks its interpreter per command: PowerShell
    /// for `irm … | iex`, `cmd /C` for plain npm/python lines (which may chain
    /// with `&&` — cmd parses that, Windows PowerShell 5.1 does not), and a
    /// clear error when there is no one-line Windows installer at all.
    #[cfg(windows)]
    #[test]
    fn windows_installer_command_picks_interpreter_per_command() {
        use std::ffi::OsStr;
        let claude = find_spec("claude").unwrap(); // irm | iex
        assert_eq!(
            installer_command(claude).unwrap().get_program(),
            OsStr::new("powershell")
        );
        let gemini = find_spec("gemini").unwrap(); // npm install -g …
        assert_eq!(
            installer_command(gemini).unwrap().get_program(),
            OsStr::new("cmd")
        );
        let vibe = find_spec("vibe").unwrap(); // no Windows installer
        assert!(installer_command(vibe).is_err());
    }

    #[test]
    fn windows_shell_kind_is_not_derived_from_display_text() {
        assert_eq!(
            windows_shell_kind("irm https://claude.ai/install.ps1 | iex"),
            "powershell"
        );
        assert_eq!(
            windows_shell_kind("npm install -g @google/gemini-cli"),
            "default"
        );
    }
}
