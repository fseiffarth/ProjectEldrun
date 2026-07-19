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
        install_cmd: "npm install -g @openai/codex",
        install_cmd_windows: Some("npm install -g @openai/codex"),
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
    pub docs: String,
    pub installed: bool,
}

fn find_spec(id: &str) -> Option<&'static AgentSpec> {
    AGENTS.iter().find(|a| a.id == id)
}

/// True when an agent's binary is reachable on `PATH` or in one of its
/// well-known user install locations.
///
/// PATH lookup goes through the shared cross-platform helper (`where` on Windows,
/// `which` elsewhere): `which` does not exist on Windows, so probing it directly
/// reported every Windows install — Claude included — as missing.
fn spec_is_installed(spec: &AgentSpec) -> bool {
    if crate::paths::binary_on_path(spec.bin) {
        return true;
    }
    let home = crate::paths::home_dir();
    spec.extra_paths.iter().any(|rel| {
        let base = home.join(rel);
        if base.exists() {
            return true;
        }
        // On Windows the extra paths omit the executable extension that the
        // installer actually writes (e.g. `.local/bin/claude` → `claude.exe`).
        cfg!(target_os = "windows")
            && ["exe", "cmd", "bat", "ps1"]
                .iter()
                .any(|ext| base.with_extension(ext).exists())
    })
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

/// List every known agent CLI with its current installed status.
#[tauri::command]
pub async fn list_agents() -> Vec<AgentInfo> {
    AGENTS
        .iter()
        .map(|spec| {
            let (cmd, shell, shell_kind) = platform_install(spec);
            AgentInfo {
                id: spec.id.to_string(),
                label: spec.label.to_string(),
                bin: spec.bin.to_string(),
                install_cmd: cmd.unwrap_or("").to_string(),
                shell,
                shell_kind: shell_kind.to_string(),
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
        return Err(if tail.is_empty() {
            format!(
                "installer exited unsuccessfully ({status}). Run `{}` in a terminal.",
                manual_install_cmd(spec)
            )
        } else {
            tail
        });
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
            windows_shell("npm install -g @openai/codex"),
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
        let codex = find_spec("codex").unwrap(); // npm install -g …
        assert_eq!(
            installer_command(codex).unwrap().get_program(),
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
            windows_shell_kind("npm install -g @openai/codex"),
            "default"
        );
    }
}
