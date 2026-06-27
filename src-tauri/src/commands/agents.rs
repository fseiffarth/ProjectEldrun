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
    /// Binary name to probe on `PATH` (via `which`).
    bin: &'static str,
    /// Official non-interactive install command (Linux/macOS).
    install_cmd: &'static str,
    /// Extra home-relative paths to check when `which` misses (PATH gaps).
    extra_paths: &'static [&'static str],
    /// Docs URL shown when automatic install isn't possible.
    docs: &'static str,
}

/// The built-in agent registry. The order here is the order the UI lists them.
const AGENTS: &[AgentSpec] = &[
    AgentSpec {
        id: "claude",
        label: "Claude",
        bin: "claude",
        install_cmd: "curl -fsSL https://claude.ai/install.sh | bash",
        extra_paths: &[".local/bin/claude"],
        docs: "https://docs.anthropic.com/en/docs/claude-code/setup",
    },
    AgentSpec {
        id: "codex",
        label: "Codex",
        bin: "codex",
        install_cmd: "npm install -g @openai/codex",
        extra_paths: &[".local/bin/codex"],
        docs: "https://github.com/openai/codex",
    },
    AgentSpec {
        id: "gemini",
        label: "Gemini",
        bin: "gemini",
        install_cmd: "npm install -g @google/gemini-cli",
        extra_paths: &[".local/bin/gemini"],
        docs: "https://github.com/google-gemini/gemini-cli",
    },
    AgentSpec {
        id: "vibe",
        label: "Mistral",
        bin: "vibe",
        install_cmd: "curl -LsSf https://mistral.ai/vibe/install.sh | bash",
        extra_paths: &[".local/bin/vibe", ".cargo/bin/vibe"],
        docs: "https://docs.mistral.ai/getting-started/quickstarts/vibe-code/install-cli",
    },
    AgentSpec {
        id: "aider",
        label: "Aider",
        bin: "aider",
        install_cmd: "python -m pip install aider-install && aider-install",
        extra_paths: &[".local/bin/aider"],
        docs: "https://aider.chat/docs/install.html",
    },
    AgentSpec {
        id: "opencode",
        label: "OpenCode",
        bin: "opencode",
        install_cmd: "curl -fsSL https://opencode.ai/install | bash",
        extra_paths: &[".opencode/bin/opencode", ".local/bin/opencode"],
        docs: "https://opencode.ai/docs/",
    },
    AgentSpec {
        id: "cursor-agent",
        label: "Cursor",
        bin: "cursor-agent",
        install_cmd: "curl https://cursor.com/install -fsS | bash",
        extra_paths: &[".local/bin/cursor-agent"],
        docs: "https://cursor.com/docs/cli/installation",
    },
    AgentSpec {
        id: "copilot",
        label: "Copilot",
        bin: "copilot",
        install_cmd: "npm install -g @github/copilot",
        extra_paths: &[".local/bin/copilot"],
        docs: "https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli",
    },
    AgentSpec {
        id: "grok",
        label: "Grok",
        bin: "grok",
        install_cmd: "npm install -g @vibe-kit/grok-cli",
        extra_paths: &[".local/bin/grok"],
        docs: "https://github.com/superagent-ai/grok-cli",
    },
    AgentSpec {
        id: "qwen",
        label: "Qwen",
        bin: "qwen",
        install_cmd: "npm install -g @qwen-code/qwen-code",
        extra_paths: &[".local/bin/qwen"],
        docs: "https://github.com/QwenLM/qwen-code",
    },
    AgentSpec {
        id: "openclaw",
        label: "OpenClaw",
        bin: "openclaw",
        install_cmd: "npm install -g openclaw",
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
    pub install_cmd: String,
    pub docs: String,
    pub installed: bool,
}

fn find_spec(id: &str) -> Option<&'static AgentSpec> {
    AGENTS.iter().find(|a| a.id == id)
}

/// True when an agent's binary is reachable on `PATH` or in one of its
/// well-known user install locations.
fn spec_is_installed(spec: &AgentSpec) -> bool {
    let on_path = std::process::Command::new("which")
        .arg(spec.bin)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if on_path {
        return true;
    }
    let home = crate::paths::home_dir();
    spec.extra_paths.iter().any(|rel| home.join(rel).exists())
}

/// True when the given agent (by id) is installed. Unknown ids return false.
#[tauri::command]
pub async fn agent_is_installed(id: String) -> bool {
    find_spec(&id).map(spec_is_installed).unwrap_or(false)
}

/// List every known agent CLI with its current installed status.
#[tauri::command]
pub async fn list_agents() -> Vec<AgentInfo> {
    AGENTS
        .iter()
        .map(|spec| AgentInfo {
            id: spec.id.to_string(),
            label: spec.label.to_string(),
            bin: spec.bin.to_string(),
            install_cmd: spec.install_cmd.to_string(),
            docs: spec.docs.to_string(),
            installed: spec_is_installed(spec),
        })
        .collect()
}

/// Install an agent CLI via its official install command (Linux/macOS).
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

    if !cfg!(any(target_os = "linux", target_os = "macos")) {
        return Err(format!(
            "Automatic install is only supported on Linux/macOS. See {}.",
            spec.docs
        ));
    }

    let id_owned = id.clone();
    let emit = move |line: &str| {
        let _ = app.emit(
            "agent-install-progress",
            serde_json::json!({ "id": id_owned, "line": line }),
        );
    };
    emit(&format!("Starting {} installer…", spec.label));

    let mut child = std::process::Command::new("sh")
        .arg("-c")
        .arg(format!("{} 2>&1", spec.install_cmd))
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
                spec.install_cmd
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
            spec.bin, spec.install_cmd
        ));
    }

    emit("Done.");
    Ok(if combined.is_empty() {
        format!("{} installed.", spec.label)
    } else {
        combined
    })
}
