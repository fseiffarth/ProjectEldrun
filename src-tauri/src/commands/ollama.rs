use std::io::Write;

/// Run `ollama list` and return the list of installed model names.
#[tauri::command]
pub async fn list_ollama_models() -> Result<Vec<String>, String> {
    let out = std::process::Command::new("ollama")
        .arg("list")
        .output()
        .map_err(|e| format!("ollama list: {e}"))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("ollama list failed: {stderr}"));
    }

    let text = String::from_utf8_lossy(&out.stdout);
    let models: Vec<String> = text
        .lines()
        .skip(1) // skip header row
        .filter_map(|line| {
            let name = line.split_whitespace().next()?;
            if name.is_empty() { None } else { Some(name.to_owned()) }
        })
        .collect();

    Ok(models)
}

/// Ensure the Ollama provider and the given model are registered in
/// `~/.vibe/config.toml` so that `VIBE_ACTIVE_MODEL=<alias>` works.
/// Returns the alias string to pass as `VIBE_ACTIVE_MODEL`.
#[tauri::command]
pub async fn ensure_vibe_ollama_model(model: String) -> Result<String, String> {
    let alias = sanitize_alias(&model);

    let config_path = dirs_vibe_config()?;

    let content = std::fs::read_to_string(&config_path)
        .unwrap_or_default();

    let mut appended = String::new();

    // Add provider block once.
    if !content.contains("name = \"ollama\"") {
        appended.push_str(&ollama_provider_block());
    }

    // Add model block for this specific model once.
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
    let vibe_home = std::env::var("VIBE_HOME")
        .unwrap_or_else(|_| format!("{home}/.vibe"));
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
