use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::{Duration, Instant};

// Families that only support embeddings, not chat completions.
const EMBEDDING_FAMILIES: &[&str] = &["bert", "clip", "nomic-bert"];

fn is_chat_capable(family: &str) -> bool {
    !EMBEDDING_FAMILIES.iter().any(|f| family.contains(f))
}

fn ollama_listening() -> bool {
    TcpStream::connect_timeout(
        &"127.0.0.1:11434".parse().unwrap(),
        Duration::from_millis(200),
    )
    .is_ok()
}

/// Ensure the Ollama server is running, starting it in the background if not.
/// Waits up to 8 seconds for it to become reachable.
#[tauri::command]
pub async fn ensure_ollama_running() -> Result<(), String> {
    if ollama_listening() {
        return Ok(());
    }

    std::process::Command::new("ollama")
        .arg("serve")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("failed to start ollama serve: {e}"))?;

    let deadline = Instant::now() + Duration::from_secs(8);
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(300));
        if ollama_listening() {
            return Ok(());
        }
    }

    Err("ollama serve started but did not become reachable within 8 s".to_string())
}

/// Query the Ollama REST API and return chat-capable model names.
/// Returns Err("not_running") when the Ollama server is not reachable.
#[tauri::command]
pub async fn list_ollama_models() -> Result<Vec<String>, String> {
    let mut stream = TcpStream::connect("127.0.0.1:11434")
        .map_err(|_| "not_running".to_string())?;

    stream
        .write_all(b"GET /api/tags HTTP/1.0\r\nHost: localhost\r\n\r\n")
        .map_err(|e| format!("ollama request: {e}"))?;

    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(|e| format!("ollama read: {e}"))?;

    let body = response
        .split("\r\n\r\n")
        .nth(1)
        .ok_or("invalid ollama response")?;

    let v: serde_json::Value =
        serde_json::from_str(body).map_err(|e| format!("ollama json: {e}"))?;

    let models = v["models"]
        .as_array()
        .ok_or("no models field in ollama response")?;

    let names: Vec<String> = models
        .iter()
        .filter_map(|m| {
            let name = m["name"].as_str()?;
            let family = m["details"]["family"].as_str().unwrap_or("");
            if is_chat_capable(family) {
                Some(name.to_owned())
            } else {
                None
            }
        })
        .collect();

    Ok(names)
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
