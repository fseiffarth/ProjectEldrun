use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::{Duration, Instant};

// ── Detailed model info ───────────────────────────────────────────────────

/// Full details for a locally installed Ollama model.
#[derive(serde::Serialize, Clone)]
pub struct OllamaModelInfo {
    pub name: String,
    /// Total disk size in bytes
    pub size: u64,
    /// e.g. "8B"
    pub parameter_size: Option<String>,
    /// e.g. "Q4_0"
    pub quantization: Option<String>,
    /// e.g. "llama"
    pub family: Option<String>,
    /// Currently loaded in memory
    pub running: bool,
    /// VRAM bytes in use (non-zero → GPU)
    pub size_vram: u64,
}

/// An entry in the built-in catalog of installable models.
#[derive(serde::Serialize, Clone)]
pub struct CatalogEntry {
    pub name: String,
    pub description: String,
    /// Available size tags e.g. ["1b", "3b", "7b"]
    pub tags: Vec<String>,
    /// Human-readable disk-size hint e.g. "1.3 GB – 2 GB"
    pub size_hint: String,
}

// ── HTTP helper ───────────────────────────────────────────────────────────

/// Send a request to the local Ollama REST API and return the response body.
/// Uses HTTP/1.0 to avoid chunked transfer encoding.
fn ollama_http(method: &str, path: &str, json_body: Option<&str>) -> Result<String, String> {
    let mut stream = TcpStream::connect("127.0.0.1:11434")
        .map_err(|_| "not_running".to_string())?;
    // 10-minute timeout accommodates large model pulls
    stream
        .set_read_timeout(Some(Duration::from_secs(600)))
        .map_err(|e| format!("set timeout: {e}"))?;

    let req = match json_body {
        Some(body) => format!(
            "{method} {path} HTTP/1.0\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.as_bytes().len()
        ),
        None => format!("{method} {path} HTTP/1.0\r\nHost: localhost\r\n\r\n"),
    };

    stream
        .write_all(req.as_bytes())
        .map_err(|e| format!("write: {e}"))?;

    let mut raw = String::new();
    stream
        .read_to_string(&mut raw)
        .map_err(|e| format!("read: {e}"))?;

    let status: u16 = raw
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|s| s.parse().ok())
        .unwrap_or(200);

    let body = raw.split("\r\n\r\n").nth(1).unwrap_or("").to_owned();

    if status >= 400 {
        let msg = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| v["error"].as_str().map(String::from))
            .unwrap_or_else(|| format!("HTTP {status}"));
        return Err(msg);
    }

    Ok(body)
}

// ── New management commands ───────────────────────────────────────────────

/// True when the `ollama` binary is available in PATH.
#[tauri::command]
pub async fn ollama_is_installed() -> bool {
    std::process::Command::new("which")
        .arg("ollama")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Return detailed info for every locally installed model, cross-referenced
/// with the running-models list from /api/ps.
#[tauri::command]
pub async fn list_ollama_models_detailed() -> Result<Vec<OllamaModelInfo>, String> {
    let tags_body = ollama_http("GET", "/api/tags", None)?;
    let tags: serde_json::Value =
        serde_json::from_str(&tags_body).map_err(|e| format!("tags json: {e}"))?;

    // Build name→size_vram map for running models; ignore /api/ps errors.
    let running: std::collections::HashMap<String, u64> = ollama_http("GET", "/api/ps", None)
        .ok()
        .and_then(|b| serde_json::from_str::<serde_json::Value>(&b).ok())
        .and_then(|v| v["models"].as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|m| {
            let name = m["name"].as_str()?.to_owned();
            let vram = m["size_vram"].as_u64().unwrap_or(0);
            Some((name, vram))
        })
        .collect();

    let models = tags["models"]
        .as_array()
        .ok_or("no models field in /api/tags")?;

    Ok(models
        .iter()
        .map(|m| {
            let name = m["name"].as_str().unwrap_or("").to_owned();
            let size = m["size"].as_u64().unwrap_or(0);
            let details = &m["details"];
            let size_vram = running.get(&name).copied().unwrap_or(0);
            OllamaModelInfo {
                size,
                parameter_size: details["parameter_size"].as_str().map(String::from),
                quantization: details["quantization_level"].as_str().map(String::from),
                family: details["family"].as_str().map(String::from),
                running: running.contains_key(&name),
                size_vram,
                name,
            }
        })
        .collect())
}

/// Unload a model from memory without deleting it (sets keep_alive=0).
#[tauri::command]
pub async fn stop_ollama_model(model: String) -> Result<(), String> {
    let body = serde_json::json!({"model": model, "keep_alive": 0}).to_string();
    ollama_http("POST", "/api/generate", Some(&body))?;
    Ok(())
}

/// Pull (download or update) a model from the Ollama registry.
/// Blocks until complete — may take minutes for large models.
#[tauri::command]
pub async fn pull_ollama_model(model: String) -> Result<(), String> {
    let body = serde_json::json!({"model": model, "stream": false}).to_string();
    let response = ollama_http("POST", "/api/pull", Some(&body))?;

    // Response may be multiple newline-delimited JSON objects; check last line.
    for line in response.lines().rev() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
            if let Some(err) = v["error"].as_str() {
                return Err(err.to_string());
            }
        }
        break;
    }
    Ok(())
}

/// Permanently delete a locally installed model.
#[tauri::command]
pub async fn delete_ollama_model(model: String) -> Result<(), String> {
    let body = serde_json::json!({"model": model}).to_string();
    ollama_http("DELETE", "/api/delete", Some(&body))?;
    Ok(())
}

/// Return the built-in catalog of popular installable models.
#[tauri::command]
pub async fn list_installable_models() -> Vec<CatalogEntry> {
    vec![
        CatalogEntry {
            name: "llama3.2".into(),
            description: "Meta Llama 3.2 — fast, lightweight instruction model".into(),
            tags: vec!["1b".into(), "3b".into()],
            size_hint: "1.3 GB – 2.0 GB".into(),
        },
        CatalogEntry {
            name: "llama3.1".into(),
            description: "Meta Llama 3.1 — strong general-purpose model".into(),
            tags: vec!["8b".into(), "70b".into(), "405b".into()],
            size_hint: "4.7 GB – 229 GB".into(),
        },
        CatalogEntry {
            name: "qwen2.5".into(),
            description: "Alibaba Qwen 2.5 — multilingual, strong coding & reasoning".into(),
            tags: vec!["0.5b".into(), "1.5b".into(), "3b".into(), "7b".into(), "14b".into(), "32b".into(), "72b".into()],
            size_hint: "0.4 GB – 47 GB".into(),
        },
        CatalogEntry {
            name: "qwen2.5-coder".into(),
            description: "Alibaba Qwen 2.5 Coder — specialized code generation".into(),
            tags: vec![
                "0.5b".into(),
                "1.5b".into(),
                "3b".into(),
                "7b".into(),
                "14b".into(),
                "32b".into(),
            ],
            size_hint: "397 MB – 20 GB".into(),
        },
        CatalogEntry {
            name: "qwen3.5".into(),
            description: "Alibaba Qwen 3.5 — current multimodal model family".into(),
            tags: vec![
                "0.8b".into(),
                "2b".into(),
                "4b".into(),
                "9b".into(),
                "27b".into(),
                "35b".into(),
                "122b".into(),
            ],
            size_hint: "1.0 GB – 81 GB".into(),
        },
        CatalogEntry {
            name: "qwen3-coder".into(),
            description: "Alibaba Qwen3 Coder — coding model for agentic workflows".into(),
            tags: vec!["30b".into(), "480b".into()],
            size_hint: "19 GB – 290 GB".into(),
        },
        CatalogEntry {
            name: "qwen3-coder-next".into(),
            description: "Alibaba Qwen3 Coder Next — coding-focused local development model".into(),
            tags: vec!["q4_K_M".into(), "q8_0".into()],
            size_hint: "52 GB – 85 GB".into(),
        },
        CatalogEntry {
            name: "deepseek-r1".into(),
            description: "DeepSeek R1 — chain-of-thought reasoning model".into(),
            tags: vec![
                "1.5b".into(),
                "7b".into(),
                "8b".into(),
                "14b".into(),
                "32b".into(),
                "70b".into(),
                "671b".into(),
            ],
            size_hint: "1.1 GB – 404 GB".into(),
        },
        CatalogEntry {
            name: "deepseek-coder".into(),
            description: "DeepSeek Coder — code model trained on code and natural language".into(),
            tags: vec!["1.3b".into(), "6.7b".into(), "33b".into()],
            size_hint: "776 MB – 18 GB".into(),
        },
        CatalogEntry {
            name: "gemma3".into(),
            description: "Google Gemma 3 — efficient open model from Google".into(),
            tags: vec!["1b".into(), "4b".into(), "12b".into(), "27b".into()],
            size_hint: "815 MB – 17 GB".into(),
        },
        CatalogEntry {
            name: "gemma3n".into(),
            description: "Google Gemma 3n — efficient multimodal model for low-resource devices"
                .into(),
            tags: vec!["e2b".into(), "e4b".into()],
            size_hint: "5.6 GB – 7.5 GB".into(),
        },
        CatalogEntry {
            name: "phi4".into(),
            description: "Microsoft Phi-4 — small but capable reasoning model".into(),
            tags: vec!["14b".into()],
            size_hint: "9.1 GB".into(),
        },
        CatalogEntry {
            name: "mistral".into(),
            description: "Mistral 7B — fast European foundation model".into(),
            tags: vec!["7b".into()],
            size_hint: "4.1 GB".into(),
        },
        CatalogEntry {
            name: "mistral-large".into(),
            description: "Mistral Large 2 — flagship model for code, math, and reasoning".into(),
            tags: vec!["123b".into()],
            size_hint: "69 GB".into(),
        },
        CatalogEntry {
            name: "ministral-3".into(),
            description: "Mistral Ministral 3 — edge-oriented models with vision and tool support"
                .into(),
            tags: vec!["3b".into(), "8b".into(), "14b".into()],
            size_hint: "3.0 GB – 9.1 GB".into(),
        },
        CatalogEntry {
            name: "codellama".into(),
            description: "Meta Code Llama — code generation and completion".into(),
            tags: vec!["7b".into(), "13b".into(), "34b".into(), "70b".into()],
            size_hint: "3.8 GB – 39 GB".into(),
        },
        CatalogEntry {
            name: "granite3.3".into(),
            description: "IBM Granite 3.3 — compact enterprise-oriented language model".into(),
            tags: vec!["2b".into(), "8b".into()],
            size_hint: "1.5 GB – 4.9 GB".into(),
        },
        CatalogEntry {
            name: "olmo2".into(),
            description: "Allen AI OLMo 2 — fully open model family".into(),
            tags: vec!["7b".into(), "13b".into()],
            size_hint: "4.5 GB – 8.2 GB".into(),
        },
        CatalogEntry {
            name: "cogito".into(),
            description: "Deep Cogito — hybrid reasoning models across small and large sizes".into(),
            tags: vec![
                "3b".into(),
                "8b".into(),
                "14b".into(),
                "32b".into(),
                "70b".into(),
            ],
            size_hint: "2.0 GB – 43 GB".into(),
        },
        CatalogEntry {
            name: "smollm2".into(),
            description: "HuggingFace SmolLM2 — ultra-small on-device model".into(),
            tags: vec!["135m".into(), "360m".into(), "1.7b".into()],
            size_hint: "90 MB – 1.8 GB".into(),
        },
        CatalogEntry {
            name: "nomic-embed-text".into(),
            description: "Nomic Embed Text — high-quality text embeddings".into(),
            tags: vec!["latest".into()],
            size_hint: "274 MB".into(),
        },
        CatalogEntry {
            name: "mxbai-embed-large".into(),
            description: "mxbai-embed-large — best-in-class English embeddings".into(),
            tags: vec!["latest".into()],
            size_hint: "670 MB".into(),
        },
        CatalogEntry {
            name: "llava".into(),
            description: "LLaVA — vision + language model for image understanding".into(),
            tags: vec!["7b".into(), "13b".into(), "34b".into()],
            size_hint: "4.5 GB – 20 GB".into(),
        },
    ]
}

fn ollama_listening() -> bool {
    TcpStream::connect_timeout(
        &"127.0.0.1:11434".parse().unwrap(),
        Duration::from_millis(200),
    )
    .is_ok()
}

/// Ensure the Ollama server is running, starting it in the background if not.
/// Prefers the system service (`systemctl start ollama`) so that all models
/// installed by the system user are visible. Falls back to spawning
/// `ollama serve` with `OLLAMA_MODELS` pointing to the system models
/// directory when detected.
/// Waits up to 8 seconds for the server to become reachable.
#[tauri::command]
pub async fn ensure_ollama_running() -> Result<(), String> {
    if ollama_listening() {
        return Ok(());
    }

    // Try the system service first — it runs as the ollama user and sees all
    // system-wide models (e.g. /usr/share/ollama/.ollama/models).
    let service_started = std::process::Command::new("systemctl")
        .args(["start", "ollama"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);

    if service_started {
        let deadline = Instant::now() + Duration::from_secs(8);
        if wait_for_ollama(deadline) {
            return Ok(());
        }
    }

    // Fall back to spawning a user process, but point it at the system models
    // directory if it exists so models installed via the system service are visible.
    let mut cmd = std::process::Command::new("ollama");
    cmd.arg("serve")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());

    if let Some(sys_models) = system_ollama_models_dir() {
        cmd.env("OLLAMA_MODELS", sys_models);
    }

    cmd.spawn()
        .map_err(|e| format!("failed to start ollama serve: {e}"))?;

    let deadline = Instant::now() + Duration::from_secs(8);
    if wait_for_ollama(deadline) {
        return Ok(());
    }

    Err("ollama serve started but did not become reachable within 8 s".to_string())
}

fn wait_for_ollama(deadline: Instant) -> bool {
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(300));
        if ollama_listening() {
            return true;
        }
    }
    false
}

/// Returns the path to the system-wide Ollama models directory if it exists
/// and contains at least one model manifest.
fn system_ollama_models_dir() -> Option<std::path::PathBuf> {
    let candidates = [
        "/usr/share/ollama/.ollama/models",
        "/var/lib/ollama/.ollama/models",
        "/var/lib/ollama/models",
    ];
    for path in &candidates {
        let p = std::path::Path::new(path);
        if p.join("manifests").exists() {
            return Some(p.to_owned());
        }
    }
    None
}

/// Query the Ollama REST API and return all installed model names.
/// Returns Err("not_running") when the Ollama server is not reachable.
#[tauri::command]
pub async fn list_ollama_models() -> Result<Vec<String>, String> {
    let body = ollama_http("GET", "/api/tags", None)?;
    let v: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("ollama json: {e}"))?;

    let models = v["models"]
        .as_array()
        .ok_or("no models field in ollama response")?;

    Ok(models
        .iter()
        .filter_map(|m| Some(m["name"].as_str()?.to_owned()))
        .collect())
}

/// Result of preparing a local Ollama agent for vibe.
#[derive(serde::Serialize)]
pub struct LocalAgentPrep {
    /// Path to the dedicated per-model VIBE_HOME directory. Pass as `VIBE_HOME=<vibe_home>`.
    pub vibe_home: String,
    /// Model alias — also set as `VIBE_ACTIVE_MODEL=<alias>` for redundancy.
    pub alias: String,
}

/// Prepare a dedicated per-model VIBE_HOME for a local Ollama tab.
///
/// Creates `~/.local/share/eldrun/vibe_local/{alias}/config.toml` with:
/// - `active_model = "{alias}"` so vibe selects the correct model even when
///   the `VIBE_ACTIVE_MODEL` env var is shadowed by the global `~/.vibe/config.toml`.
/// - `enabled_tools = ["__no_tools__"]` to disable tool calls for local models.
/// - A single provider + model block for this Ollama model.
///
/// Each Ollama tab gets its own VIBE_HOME subdirectory so there is no shared
/// mutable config state and `active_model` is always unambiguous.
#[tauri::command]
pub async fn prepare_local_agent(model: String) -> Result<LocalAgentPrep, String> {
    let alias = sanitize_alias(&model);
    let vibe_home = eldrun_vibe_local_dir_for(&alias)?;
    std::fs::create_dir_all(&vibe_home).map_err(|e| format!("create vibe_local dir: {e}"))?;

    let config_path = vibe_home.join("config.toml");

    let mut cfg = format!("active_model = \"{alias}\"\nenabled_tools = [\"__no_tools__\"]\n");
    cfg.push_str(&ollama_provider_block());
    cfg.push_str(&ollama_model_block(&model, &alias));

    std::fs::write(&config_path, cfg).map_err(|e| format!("write vibe_local config: {e}"))?;

    Ok(LocalAgentPrep {
        vibe_home: vibe_home.to_string_lossy().into_owned(),
        alias,
    })
}

/// Ensure the Ollama provider and the given model are registered in
/// `~/.vibe/config.toml` so that `VIBE_ACTIVE_MODEL=<alias>` works.
/// Returns the alias string to pass as `VIBE_ACTIVE_MODEL`.
#[tauri::command]
pub async fn ensure_vibe_ollama_model(model: String) -> Result<String, String> {
    let alias = sanitize_alias(&model);

    let config_path = dirs_vibe_config()?;

    let content = std::fs::read_to_string(&config_path).unwrap_or_default();

    let mut appended = String::new();

    if !content.contains("name = \"ollama\"") {
        appended.push_str(&ollama_provider_block());
    }

    let model_marker = format!("alias = \"{}\"", alias);
    if !content.contains(&model_marker) {
        appended.push_str(&ollama_model_block(&model, &alias));
    }

    if !appended.is_empty() {
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&config_path)
            .map_err(|e| format!("open vibe config: {e}"))?;
        file.write_all(appended.as_bytes())
            .map_err(|e| format!("write vibe config: {e}"))?;
    }

    Ok(alias)
}

fn sanitize_alias(model: &str) -> String {
    model.replace(':', "-")
}

/// Return the per-model VIBE_HOME path: `~/.local/share/eldrun/vibe_local/{alias}/`.
/// Each Ollama tab gets its own subdirectory so the configs are independent
/// and `active_model` is always unambiguous.
fn eldrun_vibe_local_dir_for(alias: &str) -> Result<std::path::PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    Ok(std::path::PathBuf::from(home)
        .join(".local")
        .join("share")
        .join("eldrun")
        .join("vibe_local")
        .join(alias))
}

fn dirs_vibe_config() -> Result<std::path::PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    let vibe_home = std::env::var("VIBE_HOME").unwrap_or_else(|_| format!("{home}/.vibe"));
    Ok(std::path::PathBuf::from(vibe_home).join("config.toml"))
}

fn ollama_provider_block() -> String {
    "\n[[providers]]\nname = \"ollama\"\napi_base = \"http://localhost:11434/v1\"\napi_key_env_var = \"\"\napi_style = \"openai\"\nbackend = \"generic\"\nreasoning_field_name = \"reasoning_content\"\nproject_id = \"\"\nregion = \"\"\n\n[providers.extra_headers]\n".to_owned()
}

fn ollama_model_block(model: &str, alias: &str) -> String {
    format!(
        "\n[[models]]\nname = \"{model}\"\nprovider = \"ollama\"\nalias = \"{alias}\"\ntemperature = 0.2\ninput_price = 0.0\noutput_price = 0.0\nthinking = \"off\"\nauto_compact_threshold = 200000\n"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    // ── Helper: simulate prepare_local_agent using a tmp base dir ─────────────

    fn write_agent_config(base: &std::path::Path, model: &str) -> (std::path::PathBuf, String) {
        let alias = sanitize_alias(model);
        let vibe_home = base.join(&alias);
        std::fs::create_dir_all(&vibe_home).unwrap();
        let config_path = vibe_home.join("config.toml");
        let mut cfg = format!("active_model = \"{alias}\"\nenabled_tools = [\"__no_tools__\"]\n");
        cfg.push_str(&ollama_provider_block());
        cfg.push_str(&ollama_model_block(model, &alias));
        std::fs::write(&config_path, &cfg).unwrap();
        (vibe_home, alias)
    }

    // ── active_model is always the first line of the per-model config ─────────

    #[test]
    fn prepare_local_agent_config_has_active_model_first() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let (vibe_home, alias) = write_agent_config(tmp.path(), "llama3:latest");

        let written = std::fs::read_to_string(vibe_home.join("config.toml")).unwrap();
        let first_line = written.lines().next().unwrap_or("");
        assert_eq!(first_line, format!("active_model = \"{alias}\""),
            "active_model must be the first config line so it is not shadowed by the global ~/.vibe/config.toml");
    }

    // ── each model gets its own directory so configs never collide ────────────

    #[test]
    fn prepare_local_agent_uses_per_alias_directory() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let (home_a, alias_a) = write_agent_config(tmp.path(), "llama3:latest");
        let (home_b, alias_b) = write_agent_config(tmp.path(), "qwen2:7b");

        // Directories are distinct.
        assert_ne!(home_a, home_b);
        assert!(home_a.ends_with(&alias_a));
        assert!(home_b.ends_with(&alias_b));

        // Each config's active_model matches its own alias — not the other's.
        let cfg_a = std::fs::read_to_string(home_a.join("config.toml")).unwrap();
        let cfg_b = std::fs::read_to_string(home_b.join("config.toml")).unwrap();
        assert!(cfg_a.contains(&format!("active_model = \"{alias_a}\"")));
        assert!(!cfg_a.contains(&format!("active_model = \"{alias_b}\"")));
        assert!(cfg_b.contains(&format!("active_model = \"{alias_b}\"")));
        assert!(!cfg_b.contains(&format!("active_model = \"{alias_a}\"")));
    }

    // ── config contains exactly the requested model, provider, and no-tools ──

    #[test]
    fn prepare_local_agent_config_structure() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let model = "mistral:latest";
        let (vibe_home, alias) = write_agent_config(tmp.path(), model);

        let cfg = std::fs::read_to_string(vibe_home.join("config.toml")).unwrap();
        assert!(cfg.contains("enabled_tools = [\"__no_tools__\"]"),
            "tool calls must be disabled for local models");
        assert!(cfg.contains("name = \"ollama\""), "ollama provider block required");
        assert!(cfg.contains(&format!("name = \"{model}\"")), "model name must appear");
        assert!(cfg.contains(&format!("alias = \"{alias}\"")), "model alias must appear");
    }

    // ── sanitize_alias turns ':' into '-' ─────────────────────────────────────

    #[test]
    fn sanitize_alias_replaces_colon() {
        assert_eq!(sanitize_alias("llama3:latest"), "llama3-latest");
        assert_eq!(sanitize_alias("qwen2:7b"), "qwen2-7b");
        assert_eq!(sanitize_alias("noname"), "noname");
    }

    // ── reload regression: writing the same model twice is idempotent ─────────

    #[test]
    fn prepare_local_agent_idempotent_on_same_model() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let model = "llama3:latest";
        let (vibe_home, alias) = write_agent_config(tmp.path(), model);
        // Write again — should produce identical content (no duplicated blocks).
        write_agent_config(tmp.path(), model);

        let cfg = std::fs::read_to_string(vibe_home.join("config.toml")).unwrap();
        let model_block_count = cfg.matches("[[models]]").count();
        assert_eq!(model_block_count, 1, "calling prepare_local_agent twice must not duplicate the model block");
        // active_model appears exactly once.
        let active_model_count = cfg.matches(&format!("active_model = \"{alias}\"")).count();
        assert_eq!(active_model_count, 1);
    }

    /// Integration test: only runs when Ollama is reachable and has models.
    #[test]
    fn prepare_local_agent_integration_if_ollama_running() {
        if TcpStream::connect_timeout(
            &"127.0.0.1:11434".parse().unwrap(),
            Duration::from_millis(300),
        )
        .is_err()
        {
            eprintln!("Ollama not running — skipping integration test");
            return;
        }

        let model = match first_available_model() {
            Some(m) => m,
            None => {
                eprintln!("No Ollama models found — skipping integration test");
                return;
            }
        };

        let tmp = tempfile::tempdir().expect("tempdir");
        let (vibe_home, alias) = write_agent_config(tmp.path(), &model);

        let cfg = std::fs::read_to_string(vibe_home.join("config.toml")).unwrap();
        assert_eq!(cfg.lines().next().unwrap_or(""),
            format!("active_model = \"{alias}\""),
            "active_model must be first so global config cannot shadow it");
        assert!(cfg.contains(&format!("alias = \"{alias}\"")));
    }

    fn first_available_model() -> Option<String> {
        let mut stream = TcpStream::connect("127.0.0.1:11434").ok()?;
        stream.write_all(b"GET /api/tags HTTP/1.0\r\nHost: localhost\r\n\r\n").ok()?;
        let mut response = String::new();
        std::io::Read::read_to_string(&mut stream, &mut response).ok()?;
        let body = response.split("\r\n\r\n").nth(1)?;
        let v: serde_json::Value = serde_json::from_str(body).ok()?;
        v["models"].as_array()?.iter().find_map(|m| {
            Some(m["name"].as_str()?.to_owned())
        })
    }
}
