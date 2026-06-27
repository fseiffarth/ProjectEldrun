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
    let mut stream =
        TcpStream::connect("127.0.0.1:11434").map_err(|_| "not_running".to_string())?;
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
        return Err(friendly_ollama_error(&msg));
    }

    Ok(body)
}

/// Rewrite a raw Ollama error into a clearer, actionable message for the failure
/// modes that otherwise surface as an opaque HTTP 500 / "internal server error"
/// (e.g. when driven through vibe). Currently detects a broken install whose
/// inference runner (`llama-server`) is missing: Ollama answers API requests but
/// cannot load any model, so every generate/chat call 500s. Unrecognised errors
/// pass through unchanged. Pure + tested.
fn friendly_ollama_error(raw: &str) -> String {
    let lower = raw.to_ascii_lowercase();
    if lower.contains("llama-server") && lower.contains("not found") {
        return format!(
            "Ollama's inference runner (llama-server) is missing, so Ollama can \
            serve its API but cannot load any model — the install is incomplete. \
            Reinstall Ollama with `{OLLAMA_INSTALL_CMD}`."
        );
    }
    raw.to_string()
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

/// The official, distro-agnostic Ollama install command. Kept as a constant so
/// the backend installer and the UI's copy-to-clipboard fallback stay in sync.
pub const OLLAMA_INSTALL_CMD: &str = "curl -fsSL https://ollama.com/install.sh | sh";

/// Install Ollama via its official install script (Linux/macOS).
///
/// Runs `curl -fsSL https://ollama.com/install.sh | sh` and streams its combined
/// stdout+stderr to the frontend line-by-line via `ollama-install-progress`
/// events (`{ line }`) so the UI can show live progress. The script needs root
/// to drop the binary into `/usr/local` and register the systemd service; it
/// invokes `sudo` itself, so a fully non-interactive run only succeeds when sudo
/// is passwordless or Eldrun runs as root. When it can't elevate, the UI falls
/// back to the manual step-by-step instructions (and the same copyable command).
/// Returns the install log on success, or the tail of the output on failure.
#[tauri::command]
pub async fn install_ollama(app: tauri::AppHandle) -> Result<String, String> {
    use std::io::{BufRead, BufReader};
    use tauri::Emitter;

    if ollama_is_installed().await {
        return Ok("Ollama is already installed.".to_string());
    }

    if !cfg!(any(target_os = "linux", target_os = "macos")) {
        return Err("Automatic install is only supported on Linux/macOS. \
            Download Ollama from https://ollama.com/download."
            .to_string());
    }

    let emit = |line: &str| {
        let _ = app.emit("ollama-install-progress", serde_json::json!({ "line": line }));
    };
    emit("Starting Ollama installer…");

    // Merge stderr into stdout (`2>&1`) so a single reader sees every line in
    // order, then stream each line to the UI as it arrives.
    let mut child = std::process::Command::new("sh")
        .arg("-c")
        .arg(format!("{OLLAMA_INSTALL_CMD} 2>&1"))
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
    let combined = lines.join("\n");
    let combined = combined.trim().to_string();

    if !status.success() {
        let tail: Vec<&str> = combined.lines().rev().take(20).collect();
        let tail = tail.into_iter().rev().collect::<Vec<_>>().join("\n");
        return Err(if tail.is_empty() {
            format!(
                "installer exited unsuccessfully ({status}). It likely needs sudo — \
                run `{OLLAMA_INSTALL_CMD}` in a terminal."
            )
        } else {
            tail
        });
    }

    // The post-install check is the real source of truth: a script can print a
    // sudo warning to stderr yet still have placed the binary, or vice versa.
    if !ollama_is_installed().await {
        return Err(format!(
            "installer ran but `ollama` is still not on PATH. It likely needs \
            sudo — run `{OLLAMA_INSTALL_CMD}` in a terminal.\n\n{combined}"
        ));
    }

    emit("Done.");
    Ok(if combined.is_empty() {
        "Ollama installed.".to_string()
    } else {
        combined
    })
}

// ── Vibe (local-model agent runtime) ──────────────────────────────────────
//
// Local Ollama models are driven through Mistral's `vibe` CLI (the Local Model
// tab spawns `vibe` with a per-model VIBE_HOME). Vibe is a separate install
// from Ollama itself, so without it the tab fails with "unable to spawn vibe".
// We surface install/detection here, alongside the Ollama installer, so the
// Ollama settings window can guide the user through the full prerequisite.

/// The official Vibe install command. Installs via `uv` into the user's
/// home (`~/.local/bin`); needs no `sudo`. Kept as a constant so the backend
/// installer and the UI's copy-to-clipboard fallback stay in sync.
pub const VIBE_INSTALL_CMD: &str = "curl -LsSf https://mistral.ai/vibe/install.sh | bash";

/// True when the `vibe` binary is reachable. Checks `PATH` (via `which`) and the
/// well-known user install locations the installer uses, since Eldrun's inherited
/// `PATH` may omit `~/.local/bin` even when a login shell would include it.
#[tauri::command]
pub async fn vibe_is_installed() -> bool {
    let on_path = std::process::Command::new("which")
        .arg("vibe")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if on_path {
        return true;
    }
    let home = crate::paths::home_dir();
    [".local/bin/vibe", ".cargo/bin/vibe"]
        .iter()
        .any(|rel| home.join(rel).exists())
}

/// Install the Vibe CLI via its official install script (Linux/macOS).
///
/// Runs `curl -LsSf https://mistral.ai/vibe/install.sh | bash` and streams its
/// combined stdout+stderr to the frontend line-by-line via `vibe-install-progress`
/// events (`{ line }`) so the UI can show live progress. The script installs into
/// the user's home (no `sudo`), so this runs non-interactively. Returns the install
/// log on success, or the tail of the output on failure.
#[tauri::command]
pub async fn install_vibe(app: tauri::AppHandle) -> Result<String, String> {
    use std::io::{BufRead, BufReader};
    use tauri::Emitter;

    if vibe_is_installed().await {
        return Ok("Vibe is already installed.".to_string());
    }

    if !cfg!(any(target_os = "linux", target_os = "macos")) {
        return Err("Automatic install is only supported on Linux/macOS. \
            See https://docs.mistral.ai/getting-started/quickstarts/vibe-code/install-cli."
            .to_string());
    }

    let emit = |line: &str| {
        let _ = app.emit("vibe-install-progress", serde_json::json!({ "line": line }));
    };
    emit("Starting Vibe installer…");

    let mut child = std::process::Command::new("sh")
        .arg("-c")
        .arg(format!("{VIBE_INSTALL_CMD} 2>&1"))
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
            format!("installer exited unsuccessfully ({status}). Run `{VIBE_INSTALL_CMD}` in a terminal.")
        } else {
            tail
        });
    }

    // The post-install check is the real source of truth.
    if !vibe_is_installed().await {
        return Err(format!(
            "installer ran but `vibe` is still not detected. It may need a new shell so \
            `~/.local/bin` is on PATH — run `{VIBE_INSTALL_CMD}` in a terminal.\n\n{combined}"
        ));
    }

    emit("Done.");
    Ok(if combined.is_empty() {
        "Vibe installed.".to_string()
    } else {
        combined
    })
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

// ── Interrupted-pull tracking ─────────────────────────────────────────────
// A pull that is in flight is recorded in a small JSON file so that if Eldrun
// exits or crashes mid-download the model can be resumed on the next launch
// (Ollama's /api/pull continues a partially-fetched model). The entry is added
// when a pull starts and removed only on success; a caught error or a crash
// leaves it behind so the UI can offer "Continue".

fn pending_pulls_path() -> std::path::PathBuf {
    crate::storage::state_dir().join("ollama_pending_pulls.json")
}

fn read_pending_pulls() -> Vec<String> {
    crate::storage::read_json::<Vec<String>>(&pending_pulls_path()).unwrap_or_default()
}

fn mark_pending_pull(model: &str, active: bool) {
    let mut list = read_pending_pulls();
    let existed = list.iter().any(|m| m == model);
    if active {
        if existed {
            return;
        }
        list.push(model.to_string());
    } else {
        if !existed {
            return;
        }
        list.retain(|m| m != model);
    }
    let _ = crate::storage::write_json(&pending_pulls_path(), &list);
}

/// Model refs whose download was interrupted (Eldrun closed/crashed mid-pull).
/// The UI reconciles these against the installed list and offers to resume them.
#[tauri::command]
pub async fn list_pending_ollama_pulls() -> Vec<String> {
    read_pending_pulls()
}

/// An orphaned partial layer left in Ollama's blob cache by an interrupted pull.
/// Ollama keys blobs by content digest with no on-disk name link, so a partial
/// whose manifest was never written can't be mapped back to a model — we can
/// only surface it (size) and offer to delete it to reclaim space.
#[derive(serde::Serialize)]
pub struct PartialBlob {
    /// Short content digest, e.g. "6e9f90f02bb3".
    pub digest: String,
    /// Bytes on disk for the resumable partial layer.
    pub size: u64,
    /// Absolute path of the main `-partial` file (passed back to delete it).
    pub path: String,
}

/// Ollama blob directories to scan (env override, user home, system service),
/// de-duplicated and filtered to those that exist.
fn ollama_blob_dirs() -> Vec<std::path::PathBuf> {
    let mut dirs: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(m) = std::env::var("OLLAMA_MODELS") {
        if !m.is_empty() {
            dirs.push(std::path::PathBuf::from(m).join("blobs"));
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        dirs.push(std::path::PathBuf::from(home).join(".ollama/models/blobs"));
    }
    if let Some(sys) = system_ollama_models_dir() {
        dirs.push(sys.join("blobs"));
    }
    let mut seen = std::collections::HashSet::new();
    dirs.into_iter()
        .filter(|d| d.is_dir() && seen.insert(d.clone()))
        .collect()
}

/// Orphaned partial download layers sitting in Ollama's blob cache, largest
/// first. Each is an interrupted download with no recoverable model name.
#[tauri::command]
pub async fn list_orphan_partial_blobs() -> Vec<PartialBlob> {
    let mut out: Vec<PartialBlob> = Vec::new();
    for dir in ollama_blob_dirs() {
        let rd = match std::fs::read_dir(&dir) {
            Ok(r) => r,
            Err(_) => continue,
        };
        for entry in rd.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            // The main data file ends exactly in "-partial"; per-chunk metadata
            // files are "-partial-<N>", so counting only the former lists each
            // interrupted layer once.
            if !name.ends_with("-partial") {
                continue;
            }
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            let digest = name
                .strip_suffix("-partial")
                .unwrap_or(&name)
                .strip_prefix("sha256-")
                .unwrap_or(&name)
                .chars()
                .take(12)
                .collect::<String>();
            out.push(PartialBlob {
                digest,
                size,
                path: entry.path().to_string_lossy().to_string(),
            });
        }
    }
    out.sort_by(|a, b| b.size.cmp(&a.size));
    out
}

/// Delete an orphaned partial layer (the main `-partial` file plus its per-chunk
/// `-partial-<N>` siblings) to reclaim disk. Validated to a file named `*-partial`
/// inside a `blobs` directory so it can't be used to remove anything else.
#[tauri::command]
pub async fn delete_partial_blob(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    let name = p
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("invalid path")?
        .to_string();
    if !name.ends_with("-partial") {
        return Err("not a partial blob".into());
    }
    let dir = p.parent().ok_or("no parent directory")?;
    if dir.file_name().and_then(|n| n.to_str()) != Some("blobs") {
        return Err("not inside a blobs directory".into());
    }
    let mut removed = false;
    let mut last_err: Option<String> = None;
    if let Ok(rd) = std::fs::read_dir(dir) {
        for entry in rd.flatten() {
            let fname = entry.file_name().to_string_lossy().to_string();
            if fname == name || fname.starts_with(&format!("{name}-")) {
                match std::fs::remove_file(entry.path()) {
                    Ok(()) => removed = true,
                    Err(e) => last_err = Some(e.to_string()),
                }
            }
        }
    }
    if removed {
        Ok(())
    } else {
        Err(last_err.unwrap_or_else(|| "nothing to remove".into()))
    }
}

/// Forget an interrupted pull (e.g. the user dismisses it, or it finished).
#[tauri::command]
pub async fn clear_pending_ollama_pull(model: String) {
    mark_pending_pull(&model, false);
}

/// Load a model into memory now (an empty `/api/generate` warms it) and keep it
/// resident until explicitly unloaded (`keep_alive: -1`), so the user controls
/// residency by button rather than relying on first use to trigger the load.
#[tauri::command]
pub async fn load_ollama_model(model: String) -> Result<(), String> {
    let body = serde_json::json!({"model": model, "keep_alive": -1}).to_string();
    ollama_http("POST", "/api/generate", Some(&body))?;
    Ok(())
}

/// Pull (download or update) a model from the Ollama registry, streaming
/// download progress to the frontend. Emits `ollama-pull-progress` events
/// (`{ model, status, completed, total }`) line-by-line as Ollama reports
/// them so the UI can show a live percentage. Blocks until complete — may
/// take minutes for large models.
#[tauri::command]
pub async fn pull_ollama_model(app: tauri::AppHandle, model: String) -> Result<(), String> {
    use std::io::{BufRead, BufReader};
    use tauri::Emitter;

    let body = serde_json::json!({"model": model, "stream": true}).to_string();

    let stream =
        TcpStream::connect("127.0.0.1:11434").map_err(|_| "not_running".to_string())?;
    // 10-minute read timeout accommodates large model pulls between chunks.
    stream
        .set_read_timeout(Some(Duration::from_secs(600)))
        .map_err(|e| format!("set timeout: {e}"))?;

    let req = format!(
        "POST /api/pull HTTP/1.0\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
        body.as_bytes().len()
    );
    let mut writer = stream.try_clone().map_err(|e| format!("clone: {e}"))?;
    writer
        .write_all(req.as_bytes())
        .map_err(|e| format!("write: {e}"))?;

    // Record this as an in-flight pull; a crash/exit now leaves the entry behind
    // so the next launch can offer to resume it. Removed only on success below.
    mark_pending_pull(&model, true);

    let mut reader = BufReader::new(stream);

    // Consume the HTTP status line + headers up to the blank separator,
    // capturing the status code so a 4xx/5xx can surface as an error.
    let mut status_code = 200u16;
    let mut header = String::new();
    reader
        .read_line(&mut header)
        .map_err(|e| format!("read: {e}"))?;
    if let Some(code) = header.split_whitespace().nth(1).and_then(|s| s.parse().ok()) {
        status_code = code;
    }
    loop {
        let mut h = String::new();
        let n = reader.read_line(&mut h).map_err(|e| format!("read: {e}"))?;
        if n == 0 || h == "\r\n" || h == "\n" {
            break;
        }
    }

    // Stream the newline-delimited JSON body, forwarding each progress line.
    let mut last_err: Option<String> = None;
    loop {
        let mut line = String::new();
        let n = reader.read_line(&mut line).map_err(|e| format!("read: {e}"))?;
        if n == 0 {
            break;
        }
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
            if let Some(err) = v["error"].as_str() {
                last_err = Some(err.to_string());
                continue;
            }
            let _ = app.emit(
                "ollama-pull-progress",
                serde_json::json!({
                    "model": model,
                    "status": v["status"].as_str().unwrap_or_default(),
                    "completed": v["completed"].as_u64().unwrap_or(0),
                    "total": v["total"].as_u64().unwrap_or(0),
                }),
            );
        }
    }

    if let Some(err) = last_err {
        return Err(friendly_ollama_error(&err));
    }
    if status_code >= 400 {
        return Err(format!("HTTP {status_code}"));
    }
    // Completed cleanly — drop it from the interrupted-pull record.
    mark_pending_pull(&model, false);
    Ok(())
}

/// Permanently delete a locally installed model.
#[tauri::command]
pub async fn delete_ollama_model(model: String) -> Result<(), String> {
    let body = serde_json::json!({"model": model}).to_string();
    ollama_http("DELETE", "/api/delete", Some(&body))?;
    Ok(())
}

/// Total download size in bytes for an installable model tag, read from the
/// Ollama registry manifest. Used to show a model's size on hover before the
/// user commits to a pull. Shells out to `curl` (no Rust TLS dep) and sums the
/// manifest's config + layer sizes. `model` may be `name`, `name:tag`, or
/// `namespace/name:tag`; an absent tag defaults to `latest`.
#[tauri::command]
pub async fn ollama_registry_size(model: String) -> Result<u64, String> {
    validate_model_name(&model)?;

    let (name, tag) = match model.split_once(':') {
        Some((n, t)) => (n, t),
        None => (model.as_str(), "latest"),
    };
    // Bare names live under the implicit `library/` namespace on the registry.
    let repo = if name.contains('/') {
        name.to_string()
    } else {
        format!("library/{name}")
    };
    let url = format!("https://registry.ollama.ai/v2/{repo}/manifests/{tag}");

    // No shell — args are passed directly, and `validate_model_name` already
    // restricts the characters that reach the URL.
    let output = std::process::Command::new("curl")
        .args([
            "-fsSL",
            "-H",
            "Accept: application/vnd.docker.distribution.manifest.v2+json",
            &url,
        ])
        .output()
        .map_err(|e| format!("failed to query registry: {e}"))?;

    if !output.status.success() {
        return Err(format!("registry returned no manifest for {model}"));
    }

    let v: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("manifest json: {e}"))?;

    let layers_total: u64 = v["layers"]
        .as_array()
        .map(|arr| arr.iter().filter_map(|l| l["size"].as_u64()).sum())
        .unwrap_or(0);
    let config_size = v["config"]["size"].as_u64().unwrap_or(0);
    let total = layers_total + config_size;

    if total == 0 {
        return Err(format!("no size info in manifest for {model}"));
    }
    Ok(total)
}

// ── Live registry browse (ollama.com/search) ─────────────────────────────────
//
// Ollama exposes no JSON catalog API, but its search page is server-rendered
// HTML carrying stable `x-test-*` hooks. We fetch it with `curl` (no TLS dep,
// same as `ollama_registry_size`) and parse those hooks. This surfaces *every*
// model in the registry — far beyond the curated `list_installable_models` — and
// supports Ollama's own filters: free-text query, capability filter, sort, and
// pagination for lazy loading. NB: Ollama provides no country/year metadata, so
// "recency" comes only from its relative `updated` label and the `newest` sort.

/// One model row parsed from an ollama.com/search results page.
#[derive(serde::Serialize, Clone, PartialEq, Debug)]
pub struct RegistryModel {
    pub name: String,
    pub description: String,
    /// Capability badges: e.g. "tools", "vision", "thinking", "embedding", "audio".
    pub capabilities: Vec<String>,
    /// Parameter-size tags e.g. ["8b", "70b"] (also "e2b" for Gemma-3n variants).
    pub sizes: Vec<String>,
    /// Human pull count as shown, e.g. "65.8K".
    pub pulls: String,
    /// Relative update label as shown, e.g. "1 week ago".
    pub updated: String,
}

/// Percent-encode a search query for safe inclusion in the URL's query string.
/// Keeps RFC-3986 unreserved characters; everything else becomes %XX.
fn percent_encode_query(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push('%');
            out.push_str(&format!("{b:02X}"));
        }
    }
    out
}

/// Minimal HTML-entity unescape for the text fragments we extract (names,
/// descriptions). Covers the entities Ollama's templates actually emit.
fn html_unescape(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
        .replace("&nbsp;", " ")
}

/// Text content right after an attribute marker: find `marker`, then the next
/// '>', then return text up to the following '<' (unescaped, trimmed).
fn tag_text_after(card: &str, marker: &str) -> Option<String> {
    let i = card.find(marker)?;
    let rest = &card[i + marker.len()..];
    let gt = rest.find('>')?;
    let after = &rest[gt + 1..];
    let lt = after.find('<')?;
    Some(html_unescape(after[..lt].trim()))
}

/// All text contents for a marker that repeats within a single card (e.g. the
/// capability and size badges).
fn all_tag_texts(card: &str, marker: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut pos = 0;
    while let Some(i) = card[pos..].find(marker) {
        let start = pos + i + marker.len();
        let Some(gt) = card[start..].find('>') else { break };
        let after = start + gt + 1;
        if let Some(lt) = card[after..].find('<') {
            let text = html_unescape(card[after..after + lt].trim());
            if !text.is_empty() {
                out.push(text);
            }
        }
        pos = after;
    }
    out
}

/// Parse the ollama.com/search HTML into model rows. Pure + tested: each
/// `<li x-test-model …>` becomes one `RegistryModel`.
fn parse_search_html(html: &str) -> Vec<RegistryModel> {
    // Each result card starts at an `x-test-model` marker; the first split chunk
    // is the page header before any card, so skip it.
    html.split("x-test-model")
        .skip(1)
        .filter_map(|card| {
            let name = tag_text_after(card, "x-test-search-response-title")?;
            if name.is_empty() {
                return None;
            }
            // Description is the first <p> with the max-w-lg class.
            let description = tag_text_after(card, "class=\"max-w-lg").unwrap_or_default();
            Some(RegistryModel {
                name,
                description,
                capabilities: all_tag_texts(card, "x-test-capability"),
                sizes: all_tag_texts(card, "x-test-size"),
                pulls: tag_text_after(card, "x-test-pull-count").unwrap_or_default(),
                updated: tag_text_after(card, "x-test-updated").unwrap_or_default(),
            })
        })
        .collect()
}

/// Browse the full Ollama registry via its search page. Returns one page
/// (~20 rows) of results so the frontend can lazy-load; an empty vec means no
/// more pages. `capability` filters by a single capability ("" = any);
/// `sort` is "newest" or anything else (popular, the default). `page` is 1-based.
#[tauri::command]
pub async fn search_ollama_registry(
    query: String,
    capability: String,
    sort: String,
    page: u32,
) -> Result<Vec<RegistryModel>, String> {
    let page = page.max(1);
    let mut url = format!(
        "https://ollama.com/search?q={}&page={page}",
        percent_encode_query(query.trim())
    );
    // Only forward a capability we recognise, so we never inject arbitrary params.
    const CAPS: [&str; 6] = ["tools", "vision", "thinking", "embedding", "audio", "cloud"];
    if CAPS.contains(&capability.as_str()) {
        url.push_str(&format!("&c={capability}"));
    }
    if sort == "newest" {
        url.push_str("&o=newest");
    }

    // No shell — args passed directly; the URL is built only from a validated
    // capability/sort and a percent-encoded query.
    let output = std::process::Command::new("curl")
        .args(["-fsSL", &url])
        .output()
        .map_err(|e| format!("failed to query registry: {e}"))?;

    if !output.status.success() {
        return Err("ollama.com search request failed".to_string());
    }

    let html = String::from_utf8_lossy(&output.stdout);
    Ok(parse_search_html(&html))
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
            tags: vec![
                "0.5b".into(),
                "1.5b".into(),
                "3b".into(),
                "7b".into(),
                "14b".into(),
                "32b".into(),
                "72b".into(),
            ],
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
            description: "Deep Cogito — hybrid reasoning models across small and large sizes"
                .into(),
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

/// True when the Ollama server is reachable on its default port. Cheap enough
/// (200 ms TCP connect) to poll from the UI for a live status indicator.
#[tauri::command]
pub async fn ollama_is_running() -> bool {
    ollama_listening()
}

/// Three-state health of the local Ollama server for the header status lamp:
/// - `"stopped"` — server unreachable (lamp red),
/// - `"idle"` — server up but no model loaded in memory (lamp yellow),
/// - `"loaded"` — at least one model currently loaded in memory (lamp green).
///
/// One round trip: `/api/ps` lists the models resident in memory, and a
/// successful response also proves the server is reachable, so it doubles as
/// the running check.
#[tauri::command]
pub async fn ollama_status() -> &'static str {
    match ollama_http("GET", "/api/ps", None) {
        Err(_) => "stopped",
        Ok(body) => {
            let loaded = serde_json::from_str::<serde_json::Value>(&body)
                .ok()
                .and_then(|v| v["models"].as_array().map(|a| !a.is_empty()))
                .unwrap_or(false);
            if loaded {
                "loaded"
            } else {
                "idle"
            }
        }
    }
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

// ── Local code/text autocomplete (TODO Group M #45) ──────────────────────────
//
// DECISION A: completion is LOCAL OLLAMA ONLY and OPT-IN. We reuse `ollama_http`
// against the local `/api/chat` endpoint — no remote endpoint is ever contacted.
// The frontend gates the call behind a per-type `autocomplete` setting (default
// OFF) and runs it against whichever model is currently loaded in memory; if none
// is loaded / Ollama isn't reachable this returns `not_running` and the UI shows a
// "load a local model" hint.
//
// We use /api/chat (not /api/generate) with a dedicated system role: a general
// instruct/chat model like llama3.2 otherwise reads the surrounding text as a
// *task* and replies "Here is the reformatted version…" instead of continuing it.

/// System message that turns a general instruct/chat model into a fill-in-the-
/// middle completion engine: it must INSERT between BEFORE and AFTER (not author a
/// fresh reply). How *much* to insert is left to the per-request TASK hint (see
/// [`CompletionMode`]) so the same engine serves sentence, block, and whole-scope
/// completions. Verified against llama3.2:3b. Pure + sent as the chat `system` role.
const COMPLETION_SYSTEM: &str = "You are a fill-in-the-middle autocomplete engine inside a code/text \
editor. You receive the text BEFORE the cursor and the text AFTER the cursor. Output ONLY the raw text \
to INSERT at the cursor so that BEFORE + your insertion + AFTER reads as one correct, natural, continuous \
piece of text. Continue directly from the end of BEFORE and join smoothly into the start of AFTER. Insert \
exactly what the TASK asks for and no more. Never repeat, rewrite, or quote any text from BEFORE or AFTER. \
No preamble, no quotes, no code fences, no explanations, no labels.";

/// How much of a completion to generate (#45 modes). Chosen per file type in
/// settings and cycled live with Ctrl+Shift+Space. Drives both the TASK hint in
/// [`completion_prompt`] and the `num_predict` output cap.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum CompletionMode {
    /// Finish the current word/sentence/line only (default; least intrusive).
    Sentence,
    /// Finish the current code block / paragraph (may span several lines).
    Block,
    /// Complete the whole enclosing function or scope.
    Scope,
}

impl CompletionMode {
    /// Parse the frontend's mode string; anything unknown/absent falls back to the
    /// conservative `Sentence` mode.
    fn parse(s: &str) -> Self {
        match s {
            "block" => Self::Block,
            "scope" => Self::Scope,
            _ => Self::Sentence,
        }
    }

    /// Output cap (tokens). Larger modes need more room, but each stays bounded so
    /// a local model can't run away generating the rest of the file.
    fn num_predict(self) -> u32 {
        match self {
            Self::Sentence => 128,
            Self::Block => 256,
            Self::Scope => 512,
        }
    }
}

/// True when the cursor sits in the middle of a sentence — i.e. the last
/// non-space/tab character of `prefix` is a word/comma rather than a sentence
/// terminator, a newline, or the start of the document. Used to bias the model
/// toward finishing the current sentence first. Pure + tested.
fn is_mid_sentence(prefix: &str) -> bool {
    match prefix.trim_end_matches([' ', '\t']).chars().last() {
        None => false,
        Some(c) => !matches!(c, '.' | '!' | '?' | ':' | ';' | '\n'),
    }
}

/// Line-comment token(s) for `language`, used to recognise an "intent comment" the
/// user wrote to describe the code they want next (e.g. `// new for loop to compute
/// the sum`). Known code languages map to their comment syntax; prose-ish languages
/// (markdown / plain text / unknown-empty) return an empty slice so headings like
/// `# Title` are never mistaken for a code-intent comment; any other named (but
/// unrecognised) language falls back to the two most common tokens. Pure + tested.
fn line_comment_tokens(language: &str) -> &'static [&'static str] {
    match language.to_ascii_lowercase().as_str() {
        "rust" | "c" | "cpp" | "c++" | "h" | "hpp" | "java" | "javascript" | "js" | "jsx"
        | "typescript" | "ts" | "tsx" | "go" | "swift" | "kotlin" | "kt" | "scala" | "dart"
        | "php" | "csharp" | "cs" | "c#" | "objc" | "objectivec" | "groovy" | "rust-objc" => {
            &["//"]
        }
        "python" | "py" | "ruby" | "rb" | "bash" | "sh" | "shell" | "zsh" | "perl" | "pl" | "r"
        | "yaml" | "yml" | "toml" | "makefile" | "make" | "dockerfile" | "elixir" | "ex"
        | "nix" => &["#"],
        "sql" | "lua" | "haskell" | "hs" | "ada" | "elm" => &["--"],
        "lisp" | "clojure" | "clj" | "scheme" | "racket" | "asm" => &[";"],
        "tex" | "latex" | "matlab" | "erlang" | "erl" => &["%"],
        // Prose / unknown-empty: do not treat any line as a code-intent comment.
        "" | "markdown" | "md" | "mdx" | "text" | "plain" | "txt" | "rst" | "html" | "xml"
        | "css" => &[],
        // Some other named code-ish language we don't have a table entry for.
        _ => &["//", "#"],
    }
}

/// If `line` is a single comment line, return its human-readable body (comment
/// token, any repeated token chars like `///`/`##`, surrounding `/* */`, and
/// whitespace stripped); otherwise `None`. Pure + tested.
fn strip_comment_line(line: &str, tokens: &[&str]) -> Option<String> {
    let t = line.trim();
    // Single-line block comment `/* … */` (C-family only).
    if tokens.contains(&"//") && t.starts_with("/*") {
        let body = t.trim_start_matches("/*").trim_end_matches("*/").trim();
        return Some(body.to_string());
    }
    for tok in tokens {
        if let Some(rest) = t.strip_prefix(tok) {
            // Drop extra repeats of the token's first char (`///`, `##`, `--!`).
            let lead = tok.chars().next().unwrap_or(' ');
            return Some(rest.trim_start_matches(lead).trim().to_string());
        }
    }
    None
}

/// Detect an "intent comment" sitting immediately before the caret and return its
/// combined text, so [`completion_prompt`] can switch from continuing prose to
/// *implementing the comment as code*. Fires when the caret is on a fresh (blank or
/// indent-only) line directly below a run of comment lines, or at the end of a
/// comment line itself; consecutive comment lines above are merged into one
/// instruction. Returns `None` for non-code languages, when there is no comment, or
/// when the text doesn't read like an instruction (needs ≥2 words and ≥3 letters,
/// so a lone `//` or a `// ----` divider never triggers). Pure + tested.
fn trailing_comment_intent(prefix: &str, language: &str) -> Option<String> {
    let tokens = line_comment_tokens(language);
    if tokens.is_empty() {
        return None;
    }
    let lines: Vec<&str> = prefix.split('\n').collect();
    let n = lines.len();
    if n == 0 {
        return None;
    }
    // Index of the last comment line of the block to read.
    let last = if lines[n - 1].trim().is_empty() {
        // Caret on its own fresh line: the comment block is just above it.
        if n < 2 {
            return None;
        }
        n - 2
    } else if strip_comment_line(lines[n - 1], tokens).is_some() {
        // Caret at the end of a comment line itself.
        n - 1
    } else {
        return None;
    };
    // Walk up the consecutive run of comment lines ending at `last`.
    let mut texts = Vec::new();
    let mut i = last as isize;
    while i >= 0 {
        match strip_comment_line(lines[i as usize], tokens) {
            Some(t) => texts.push(t),
            None => break,
        }
        i -= 1;
    }
    texts.reverse();
    let intent = texts
        .iter()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let letters = intent.chars().filter(|c| c.is_alphabetic()).count();
    if letters >= 3 && intent.split_whitespace().count() >= 2 {
        Some(intent)
    } else {
        None
    }
}

/// A reference file the user attached to inform a completion (#45 context files).
/// Its `content` is included (size-capped) as read-only CONTEXT in the prompt so
/// the local model can draw on sibling project files when completing the current
/// one. Deserialized from the frontend's `context` array.
#[derive(serde::Deserialize)]
pub struct ContextFile {
    pub name: String,
    pub content: String,
}

/// Per-file and total caps (bytes) on attached context, so a few large files can't
/// blow past a small local model's context window. Each file is truncated to the
/// per-file cap; files are included in order until the total cap is reached.
const MAX_CONTEXT_PER_FILE: usize = 6000;
const MAX_CONTEXT_TOTAL: usize = 24000;

/// Truncate `s` to at most `max` bytes, backing off to the nearest char boundary
/// so the result is always valid UTF-8. Pure.
fn truncate_chars(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].to_string()
}

/// Build the read-only CONTEXT preamble from attached reference files, size-capped
/// (see [`MAX_CONTEXT_PER_FILE`]/[`MAX_CONTEXT_TOTAL`]). Each file becomes a labelled
/// `--- <name> ---` block; empty/whitespace-only files are skipped. Returns an empty
/// string when there is nothing to include, so [`completion_prompt`] can omit the
/// section entirely. Pure + tested.
fn build_context_block(files: &[ContextFile]) -> String {
    let mut out = String::new();
    let mut total = 0usize;
    for f in files {
        if total >= MAX_CONTEXT_TOTAL {
            break;
        }
        let cap = MAX_CONTEXT_PER_FILE.min(MAX_CONTEXT_TOTAL - total);
        let body = truncate_chars(f.content.trim(), cap);
        if body.is_empty() {
            continue;
        }
        total += body.len();
        out.push_str("--- ");
        out.push_str(f.name.trim());
        out.push_str(" ---\n");
        out.push_str(&body);
        out.push_str("\n\n");
    }
    out
}

/// Build the user message paired with [`COMPLETION_SYSTEM`]: a per-caret TASK hint
/// plus the text before the caret (`prefix`) and after it (`suffix`) as labelled
/// sections, so the model inserts at the cursor rather than rewriting the document.
/// The TASK is selected by `mode`: `Sentence` keeps the insertion to the current
/// word/sentence/line (and, when mid-sentence, biases toward finishing it first),
/// `Block` completes the current block/paragraph, and `Scope` the whole enclosing
/// function or scope. When `context` is non-empty it is inserted as a read-only
/// REFERENCE FILES section before BEFORE/AFTER. Pure + tested.
fn completion_prompt(
    prefix: &str,
    suffix: &str,
    language: &str,
    mode: CompletionMode,
    context: &str,
) -> String {
    let lang = if language.is_empty() { "text" } else { language };
    // When the caret sits just after a natural-language comment, switch from
    // continuing text to *implementing that comment as code* (#45 intent comments).
    let task: String = if let Some(desc) = trailing_comment_intent(prefix, language) {
        format!(
            "TASK: The comment line(s) immediately above the cursor describe the code to write \
next: \"{desc}\". Output the {lang} code that implements that description, starting on a new line \
below the comment, matching the surrounding indentation and style, and joining smoothly into AFTER. \
Write only that code — do not repeat, rewrite, or extend the comment, and add no explanations."
        )
    } else {
        match mode {
            CompletionMode::Sentence => {
                if is_mid_sentence(prefix) {
                    "TASK: The cursor is in the middle of a sentence. Output only what completes the \
current word and sentence so it joins smoothly into AFTER. Keep it to a single sentence or line; do \
not begin a new paragraph."
                } else {
                    "TASK: Continue from the end of BEFORE with a brief, on-topic insertion that leads \
into AFTER. Keep it to one sentence or line; do not begin a new paragraph or topic."
                }
            }
            CompletionMode::Block => {
                "TASK: Continue from the end of BEFORE, completing the current line and the rest of the \
current code block, statement, or paragraph. You may span several lines, but stop at the end of that \
block — do not write the remainder of the document."
            }
            CompletionMode::Scope => {
                "TASK: Continue from the end of BEFORE, completing the entire enclosing function, block, \
or scope — its full body, with balanced brackets and indentation — so it joins into AFTER. Stop at \
the end of that function or scope; do not continue past it."
            }
        }
        .to_string()
    };
    let reference = if context.is_empty() {
        String::new()
    } else {
        format!(
            "REFERENCE FILES (read-only context from the project — use only to inform the \
insertion; never output, quote, or repeat them):\n{context}\n"
        )
    };
    format!("Language: {lang}\n{task}\n\n{reference}BEFORE:\n{prefix}\n\nAFTER:\n{suffix}")
}

/// Strip wrapping artefacts a chat model sometimes adds around a raw completion:
/// a leading conversational preamble line ("Here is the continuation:") and
/// leading/trailing code fences. Conservative — a preamble line is dropped only
/// when it clearly reads as a preface AND ends with ':', so real first lines are
/// never eaten. Pure + tested.
fn clean_completion(raw: &str) -> String {
    let mut s = raw.trim_matches('\n').to_string();

    // Defense in depth (the system prompt already forbids it): drop a leading
    // preamble line if the model added one anyway.
    if let Some(nl) = s.find('\n') {
        let first = s[..nl].trim();
        let lower = first.to_ascii_lowercase();
        let is_preamble = first.ends_with(':')
            && [
                "here is", "here's", "here are", "sure", "certainly", "of course",
                "the continuation", "continuation", "the reformatted", "the completed",
            ]
            .iter()
            .any(|p| lower.starts_with(p));
        if is_preamble {
            s = s[nl + 1..].trim_start_matches('\n').to_string();
        }
    }

    // Drop a leading ```lang fence and a trailing ``` if the model wrapped it.
    if s.starts_with("```") {
        if let Some(nl) = s.find('\n') {
            s = s[nl + 1..].to_string();
        }
        if let Some(idx) = s.rfind("```") {
            s = s[..idx].to_string();
        }
    }
    s
}

/// Smallest overlap we bother trimming, in chars — short enough to catch a
/// repeated word/operator ("fox", "a +") but above incidental 1–2 char matches.
const MIN_SEAM_OVERLAP: usize = 3;

/// Largest number of leading chars of `b` that are also a suffix of `a` (aligned
/// on char boundaries); 0 when there is no overlap. Completions are short, so the
/// quadratic scan is cheap. Pure + tested.
fn overlap_len(a: &str, b: &str) -> usize {
    let max = a.len().min(b.len());
    for k in (1..=max).rev() {
        if b.is_char_boundary(k)
            && a.is_char_boundary(a.len() - k)
            && a[a.len() - k..] == b[..k]
        {
            return k;
        }
    }
    0
}

/// Remove text the model echoed from the surrounding context, so only the genuinely
/// new insertion remains. Small models often repeat the word/line just before the
/// cursor (BEFORE "…return " → completion "return a + b") or pre-echo the text just
/// after it. Trims a leading run of `completion` that repeats the tail of `prefix`
/// and a trailing run that repeats the head of `suffix`, ignoring whitespace at the
/// seam. Pure + tested.
fn trim_context_overlap(prefix: &str, suffix: &str, completion: &str) -> String {
    // Leading overlap with the end of BEFORE.
    let head = completion.trim_start();
    let p = prefix.trim_end();
    let mut c = match overlap_len(p, head) {
        n if n >= MIN_SEAM_OVERLAP => head[n..].trim_start(),
        _ => completion,
    };

    // Trailing overlap with the start of AFTER.
    let tail = c.trim_end();
    let s = suffix.trim_start();
    if overlap_len(tail, s) >= MIN_SEAM_OVERLAP {
        let m = overlap_len(tail, s);
        c = tail[..tail.len() - m].trim_end();
    }
    c.to_string()
}

/// Single-shot local completion: given the text around the caret, ask the local
/// Ollama `model` for the insertion. Local-only (`ollama_http` talks to
/// 127.0.0.1:11434); returns `not_running` when Ollama isn't reachable.
#[tauri::command]
pub async fn complete_text(
    prefix: String,
    suffix: String,
    model: String,
    language: String,
    mode: Option<String>,
    context: Option<Vec<ContextFile>>,
) -> Result<String, String> {
    let mode = CompletionMode::parse(mode.as_deref().unwrap_or("sentence"));
    let context_block = context.as_deref().map(build_context_block).unwrap_or_default();
    let user = completion_prompt(&prefix, &suffix, &language, mode, &context_block);
    // Implementing a comment needs room for a whole statement/block even in the
    // conservative Sentence mode, so give intent completions at least the Block cap.
    let num_predict = if trailing_comment_intent(&prefix, &language).is_some() {
        mode.num_predict().max(CompletionMode::Block.num_predict())
    } else {
        mode.num_predict()
    };
    // `/api/chat` with a system role keeps a chat model from treating the text as
    // a task to rewrite. `stream: false` returns one JSON object; low temperature
    // + a mode-scaled output cap keep completions tight and deterministic.
    let body = serde_json::json!({
        "model": model,
        "stream": false,
        "messages": [
            { "role": "system", "content": COMPLETION_SYSTEM },
            { "role": "user", "content": user }
        ],
        "options": { "temperature": 0.1, "num_predict": num_predict }
    })
    .to_string();
    let response = ollama_http("POST", "/api/chat", Some(&body))?;
    let v: serde_json::Value =
        serde_json::from_str(&response).map_err(|e| format!("ollama json: {e}"))?;
    let text = v["message"]["content"].as_str().unwrap_or("");
    let text = clean_completion(text);
    Ok(trim_context_overlap(&prefix, &suffix, &text))
}

// ── Local grammar / spelling check (TODO Group M #45 follow-up) ───────────────
//
// Like the autocomplete above, this is LOCAL OLLAMA ONLY and OPT-IN: it reuses
// `ollama_http` against 127.0.0.1's `/api/chat`, never a remote endpoint. The
// editor sends the document text; the model returns a JSON list of issues, each
// with the offending substring, a category (spelling/grammar/style), a one-line
// message, and a suggested fix. The frontend resolves each issue to a character
// range and underlines it (colour by category). Offsets are NOT asked of the
// model — LLMs count characters unreliably — so we send the text with 1-based
// line-number prefixes and the model reports WHICH line each issue is on, which
// the frontend resolver uses to disambiguate duplicates.

/// One proofreading issue the local model found. `bad` is the exact offending
/// substring as it appears in the source (so the frontend can locate it); `line`
/// is its 1-based line in the submitted text, used as a resolution hint.
#[derive(serde::Serialize, Clone, PartialEq, Debug)]
pub struct GrammarIssue {
    /// 1-based line number in the submitted text.
    pub line: u32,
    /// The exact offending text as it appears in the source.
    pub bad: String,
    /// Suggested replacement ("" when the fix is simply to delete `bad`).
    pub suggestion: String,
    /// "spelling" | "grammar" | "style" (anything else is normalised to "grammar").
    pub category: String,
    /// Short human-readable explanation of the problem.
    pub message: String,
}

/// Largest document (chars) we submit for a grammar check, so a huge file can't
/// blow past a small local model's context window. Lines beyond the cap are not
/// checked; because the cap only drops a trailing slice, the 1-based line numbers
/// of everything before it stay valid for the frontend resolver.
const MAX_GRAMMAR_CHARS: usize = 12000;

/// System message turning a chat model into a strict proofreader that emits only
/// machine-readable JSON. Pure + sent as the chat `system` role.
const GRAMMAR_SYSTEM: &str = "You are a meticulous proofreader inside a text editor. You receive a \
document whose lines are each prefixed with \"<n>: \" (a 1-based line number then a colon and a space). \
Find ONLY genuine spelling, grammar, and punctuation mistakes — do not rewrite for style preference, do \
not flag correct text, and do not invent issues. Respond with ONLY a JSON array (no prose, no code \
fences) of objects, each exactly: {\"line\": <number>, \"bad\": \"<exact text from the document WITHOUT \
the line-number prefix>\", \"suggestion\": \"<corrected replacement for bad>\", \"category\": one of \
\"spelling\", \"grammar\", \"style\", \"message\": \"<short reason>\"}. The \"bad\" string must be copied \
verbatim from the document so it can be located, and kept as short as possible (the smallest span that \
contains the error). If there are no mistakes, respond with exactly [].";

/// Per-language preamble appended to the user message so the model ignores markup
/// it shouldn't proofread (LaTeX commands, Markdown syntax). Pure + tested.
fn grammar_language_hint(language: &str) -> &'static str {
    match language {
        "latex" | "tex" => {
            "This is a LaTeX document: ignore commands (\\command), math (between $...$ or \\[...\\]), \
labels, citations, and environment markers — proofread only the human-readable prose.\n"
        }
        "markdown" => {
            "This is Markdown: ignore code spans/blocks, link/image syntax, and formatting markers — \
proofread only the human-readable prose.\n"
        }
        _ => "",
    }
}

/// Prefix each line of `text` with its 1-based number and a colon, so the model
/// can report which line an issue is on. The numbering matches the frontend's
/// notion of a line (split on '\n'), so the resolver's line hint lines up. Pure +
/// tested.
fn number_lines(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + text.len() / 8 + 8);
    for (i, line) in text.split('\n').enumerate() {
        out.push_str(&format!("{}: {}\n", i + 1, line));
    }
    out
}

/// Extract the JSON array from a model reply that may carry stray prose or code
/// fences, then build issues from it. Tolerant: a reply with no array, or a
/// single malformed object, yields the issues that DID parse (a failed check
/// shows fewer/no marks rather than erroring). The category is normalised to one
/// of the three known kinds and entries with an empty `bad` are dropped. Pure +
/// tested.
fn parse_grammar_issues(raw: &str) -> Vec<GrammarIssue> {
    let start = match raw.find('[') {
        Some(i) => i,
        None => return Vec::new(),
    };
    let end = match raw.rfind(']') {
        Some(i) => i,
        None => return Vec::new(),
    };
    if end <= start {
        return Vec::new();
    }
    let arr: Vec<serde_json::Value> = serde_json::from_str(&raw[start..=end]).unwrap_or_default();
    arr.into_iter()
        .filter_map(|v| {
            let bad = v["bad"].as_str().unwrap_or("").to_string();
            if bad.trim().is_empty() {
                return None;
            }
            let line = v["line"].as_u64().unwrap_or(1).max(1) as u32;
            let category = match v["category"].as_str().unwrap_or("grammar") {
                "spelling" => "spelling",
                "style" => "style",
                _ => "grammar",
            }
            .to_string();
            Some(GrammarIssue {
                line,
                bad,
                suggestion: v["suggestion"].as_str().unwrap_or("").to_string(),
                category,
                message: v["message"].as_str().unwrap_or("").to_string(),
            })
        })
        .collect()
}

/// Single-shot local grammar/spelling check: send the document `text` to the
/// local Ollama `model` and return the issues it found. Local-only (`ollama_http`
/// talks to 127.0.0.1:11434); returns `not_running` when Ollama isn't reachable.
/// `language` (the file's syntax language, e.g. "latex"/"markdown") tailors the
/// prompt so markup isn't proofread as prose.
#[tauri::command]
pub async fn check_grammar(
    text: String,
    model: String,
    language: String,
) -> Result<Vec<GrammarIssue>, String> {
    let truncated = truncate_chars(&text, MAX_GRAMMAR_CHARS);
    let numbered = number_lines(&truncated);
    let hint = grammar_language_hint(&language);
    let user = format!("{hint}Proofread this document:\n\n{numbered}");
    // `/api/chat` with a system role keeps a chat model from treating the text as
    // a task; `stream: false` returns one JSON object; temperature 0 + a generous
    // output cap let it list every issue deterministically.
    let body = serde_json::json!({
        "model": model,
        "stream": false,
        "messages": [
            { "role": "system", "content": GRAMMAR_SYSTEM },
            { "role": "user", "content": user }
        ],
        "options": { "temperature": 0.0, "num_predict": 1024 }
    })
    .to_string();
    let response = ollama_http("POST", "/api/chat", Some(&body))?;
    let v: serde_json::Value =
        serde_json::from_str(&response).map_err(|e| format!("ollama json: {e}"))?;
    let content = v["message"]["content"].as_str().unwrap_or("");
    Ok(parse_grammar_issues(content))
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
    validate_model_name(&model)?;
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
    validate_model_name(&model)?;
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

// ── Local-model coding agents (ollama launch + fallbacks) ─────────────────────
//
// Beyond Mistral's `vibe` (see `prepare_local_agent`), the single active local
// Ollama model can drive other coding agents. The preferred path is Ollama's own
// `ollama launch <agent> --model <model>` (shipped v0.15): it wires Claude Code,
// Codex, OpenCode and Droid to the local server — including Claude Code's
// Anthropic-compatible endpoint, which we can't hand-roll the way vibe gets an
// OpenAI one. When `ollama launch` is unavailable we fall back to a direct
// invocation for the agents that natively accept a local Ollama endpoint.

/// A coding agent that can drive the local Ollama model.
#[derive(Clone, Copy)]
struct LocalDriver {
    /// Stable id used by the frontend picker and `prepare_local_launch`.
    id: &'static str,
    /// Human-readable label.
    label: &'static str,
    /// `ollama launch <sub> --model <model>` subcommand, when supported.
    launch_sub: Option<&'static str>,
    /// Direct fallback when `ollama launch` is unavailable: the binary to spawn
    /// and its args (with the `{model}` placeholder substituted). `None` means
    /// the agent can only be wired up by `ollama launch` itself.
    fallback: Option<(&'static str, &'static [&'static str])>,
}

/// Registry of local-model coding agents, in picker order. `vibe` is intentionally
/// absent — it keeps its bespoke per-model VIBE_HOME path in `prepare_local_agent`.
const LOCAL_DRIVERS: &[LocalDriver] = &[
    LocalDriver {
        id: "claude",
        label: "Claude Code",
        launch_sub: Some("claude"),
        // Claude Code needs an Anthropic-compatible endpoint, which only
        // `ollama launch` stands up — no reliable hand-rolled fallback.
        fallback: None,
    },
    LocalDriver {
        id: "codex",
        label: "Codex",
        launch_sub: Some("codex"),
        // `codex --oss -m <model>` talks to the local Ollama server directly.
        fallback: Some(("codex", &["--oss", "-m", "{model}"])),
    },
    LocalDriver {
        id: "opencode",
        label: "OpenCode",
        launch_sub: Some("opencode"),
        // OpenCode's built-in `ollama` provider; `--model ollama/<model>` selects it.
        fallback: Some(("opencode", &["--model", "ollama/{model}"])),
    },
    LocalDriver {
        id: "droid",
        label: "Droid",
        launch_sub: Some("droid"),
        // Droid is configured via ~/.factory/config.json; only `ollama launch`
        // writes that wiring for us.
        fallback: None,
    },
    LocalDriver {
        id: "openclaw",
        label: "OpenClaw",
        launch_sub: Some("openclaw"),
        // Launch-only: `ollama launch openclaw` installs OpenClaw if missing and
        // stands up its gateway against the local Ollama endpoint. There's no
        // documented standalone flag to point `openclaw` at a local server, so
        // no hand-rolled fallback.
        fallback: None,
    },
];

/// True when the installed Ollama exposes the `launch` subcommand (v0.15+).
/// Cheap probe: `ollama launch --help` exits 0 only when the subcommand exists.
fn ollama_has_launch() -> bool {
    std::process::Command::new("ollama")
        .args(["launch", "--help"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Build the fallback launch spec for a driver, substituting `{model}`. Pure +
/// tested; `prepare_local_launch` uses it only when `ollama launch` is missing.
fn fallback_spec(driver: &LocalDriver, model: &str) -> Option<LocalLaunchSpec> {
    driver.fallback.map(|(bin, args)| LocalLaunchSpec {
        cmd: bin.to_string(),
        args: args.iter().map(|a| a.replace("{model}", model)).collect(),
    })
}

/// One local-model driver plus whether Eldrun currently has a way to launch it.
#[derive(serde::Serialize)]
pub struct LocalDriverInfo {
    pub id: String,
    pub label: String,
    /// True when `ollama launch` supports it (and is available) or a direct
    /// fallback exists. The menu hides drivers that are currently unreachable.
    pub available: bool,
}

/// List the local-model coding agents (Claude Code, Codex, OpenCode, Droid) with
/// their availability, so the Local Model menu can offer them alongside
/// Mistral/vibe. Probes `ollama launch` once.
#[tauri::command]
pub async fn list_local_drivers() -> Vec<LocalDriverInfo> {
    let has_launch = ollama_has_launch();
    LOCAL_DRIVERS
        .iter()
        .map(|d| LocalDriverInfo {
            id: d.id.to_string(),
            label: d.label.to_string(),
            available: (d.launch_sub.is_some() && has_launch) || d.fallback.is_some(),
        })
        .collect()
}

/// The command + args to spawn for a local-model agent tab.
#[derive(serde::Serialize)]
pub struct LocalLaunchSpec {
    pub cmd: String,
    pub args: Vec<String>,
}

/// Resolve how to drive the local Ollama `model` through `agent` (one of the
/// [`LOCAL_DRIVERS`] ids). Prefers `ollama launch <agent> --model <model>`; falls
/// back to a direct invocation when launch is unavailable. Errors when the agent
/// is unknown, or it is launch-only and `ollama launch` is missing. The model is
/// validated and passed as a discrete arg (no shell), so it can't inject.
#[tauri::command]
pub async fn prepare_local_launch(agent: String, model: String) -> Result<LocalLaunchSpec, String> {
    validate_model_name(&model)?;
    let driver = LOCAL_DRIVERS
        .iter()
        .find(|d| d.id == agent)
        .ok_or_else(|| format!("unknown local driver: {agent}"))?;

    if let Some(sub) = driver.launch_sub {
        if ollama_has_launch() {
            return Ok(LocalLaunchSpec {
                cmd: "ollama".to_string(),
                args: vec![
                    "launch".to_string(),
                    sub.to_string(),
                    "--model".to_string(),
                    model,
                ],
            });
        }
    }

    fallback_spec(driver, &model).ok_or_else(|| {
        format!(
            "{} can only drive a local model through `ollama launch`, which isn't \
             available. Update Ollama (v0.15+) to enable it.",
            driver.label
        )
    })
}

fn sanitize_alias(model: &str) -> String {
    model.replace(':', "-")
}

/// Reject model names that could break out of — or inject keys into — the TOML we
/// write into vibe's `config.toml`. `model` is interpolated raw inside a basic
/// TOML string (`name = "{model}"`); a `"` would close that string and a newline
/// would let an attacker append arbitrary TOML keys/tables. Control chars are
/// also illegal in TOML basic strings. We allow only the characters that appear
/// in real Ollama model refs (`<namespace>/<name>:<tag>`): ASCII alphanumerics
/// and `. _ - : /` plus `@` (digest refs). Empty names are rejected too.
fn validate_model_name(model: &str) -> Result<(), String> {
    let model = model.trim();
    if model.is_empty() {
        return Err("model name must not be empty".to_string());
    }
    if let Some(bad) = model
        .chars()
        .find(|c| !(c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ':' | '/' | '@')))
    {
        return Err(format!(
            "invalid character {bad:?} in model name '{model}'"
        ));
    }
    Ok(())
}

/// Return the per-model VIBE_HOME path: `~/.local/share/eldrun/vibe_local/{alias}/`.
/// Each Ollama tab gets its own subdirectory so the configs are independent
/// and `active_model` is always unambiguous.
fn eldrun_vibe_local_dir_for(alias: &str) -> Result<std::path::PathBuf, String> {
    Ok(crate::paths::home_dir()
        .join(".local")
        .join("share")
        .join("eldrun")
        .join("vibe_local")
        .join(alias))
}

fn dirs_vibe_config() -> Result<std::path::PathBuf, String> {
    let vibe_home = std::env::var_os("VIBE_HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| crate::paths::home_dir().join(".vibe"));
    Ok(vibe_home.join("config.toml"))
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

    // ── model-name validation (TOML injection defense) ───────────────────────

    #[test]
    fn validate_model_name_accepts_real_refs() {
        for ok in [
            "llama3.2:1b",
            "qwen2.5-coder:7b",
            "library/llama3:latest",
            "registry.example.com/ns/model:tag",
            "model@sha256",
            "phi-4",
        ] {
            assert!(validate_model_name(ok).is_ok(), "{ok} should be accepted");
        }
    }

    #[test]
    fn validate_model_name_rejects_toml_injection() {
        // A `"` closes the TOML basic string; a newline lets the attacker append
        // arbitrary keys/tables. Both — and other shell/TOML metacharacters and
        // control chars — must be rejected.
        for bad in [
            "model\"\nmalicious_key = \"x",
            "model\nenabled_tools = []",
            "a\"b",
            "back`tick",
            "with space",
            "tab\tinside",
            "",
            "   ",
        ] {
            assert!(
                validate_model_name(bad).is_err(),
                "{bad:?} should be rejected"
            );
        }
    }

    // ── local-driver registry (ollama launch + fallbacks) ────────────────────

    #[test]
    fn codex_fallback_substitutes_model_for_oss_mode() {
        let d = LOCAL_DRIVERS.iter().find(|d| d.id == "codex").unwrap();
        let spec = fallback_spec(d, "qwen2.5-coder:7b").expect("codex has a fallback");
        assert_eq!(spec.cmd, "codex");
        assert_eq!(spec.args, vec!["--oss", "-m", "qwen2.5-coder:7b"]);
    }

    #[test]
    fn opencode_fallback_prefixes_the_ollama_provider() {
        let d = LOCAL_DRIVERS.iter().find(|d| d.id == "opencode").unwrap();
        let spec = fallback_spec(d, "llama3.2").expect("opencode has a fallback");
        assert_eq!(spec.cmd, "opencode");
        assert_eq!(spec.args, vec!["--model", "ollama/llama3.2"]);
    }

    #[test]
    fn launch_only_drivers_have_no_fallback() {
        // Claude Code / Droid need `ollama launch`; there is no hand-rolled spec.
        for id in ["claude", "droid"] {
            let d = LOCAL_DRIVERS.iter().find(|d| d.id == id).unwrap();
            assert!(
                fallback_spec(d, "any:model").is_none(),
                "{id} must be launch-only"
            );
            assert!(d.launch_sub.is_some(), "{id} must support ollama launch");
        }
    }

    #[test]
    fn model_block_with_validated_name_has_no_stray_quotes_or_newlines_in_value() {
        // Defense in depth: once validated, the interpolated name can never break
        // out of its `name = "<...>"` TOML string.
        let model = "qwen2.5-coder:7b";
        assert!(validate_model_name(model).is_ok());
        let block = ollama_model_block(model, &sanitize_alias(model));
        let name_line = block
            .lines()
            .find(|l| l.starts_with("name = "))
            .expect("name line");
        assert_eq!(name_line, "name = \"qwen2.5-coder:7b\"");
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
        assert!(
            cfg.contains("enabled_tools = [\"__no_tools__\"]"),
            "tool calls must be disabled for local models"
        );
        assert!(
            cfg.contains("name = \"ollama\""),
            "ollama provider block required"
        );
        assert!(
            cfg.contains(&format!("name = \"{model}\"")),
            "model name must appear"
        );
        assert!(
            cfg.contains(&format!("alias = \"{alias}\"")),
            "model alias must appear"
        );
    }

    // ── friendly error mapping: broken Ollama runner (#vibe 500) ─────────────

    #[test]
    fn friendly_ollama_error_detects_missing_runner() {
        // The exact shape Ollama returns when its llama-server binary is absent —
        // this is what surfaces through vibe as an "internal server error".
        let raw = "error starting llama-server: llama-server binary not found \
            (checked: /usr/local/lib/ollama/llama-server, ...). Run 'cmake -S \
            llama/server --preset cpu && cmake --build --preset cpu' first";
        let msg = friendly_ollama_error(raw);
        assert!(
            msg.contains("inference runner") && msg.contains("incomplete"),
            "missing-runner error should be rewritten to an actionable message, got: {msg}"
        );
        // It points the user at the reinstall command.
        assert!(msg.contains(OLLAMA_INSTALL_CMD));
        // And it no longer leaks the raw cmake/build hint.
        assert!(!msg.contains("cmake"));
    }

    #[test]
    fn friendly_ollama_error_is_case_insensitive() {
        let msg = friendly_ollama_error("LLAMA-SERVER binary NOT FOUND");
        assert!(msg.contains("inference runner"));
    }

    #[test]
    fn friendly_ollama_error_passes_through_unrelated() {
        // Errors we don't special-case must be returned verbatim, not swallowed.
        for raw in ["model 'foo' not found, try pulling it first", "out of memory", "HTTP 500"] {
            assert_eq!(friendly_ollama_error(raw), raw);
        }
    }

    // ── registry search HTML parsing ─────────────────────────────────────────

    // Trimmed-down but structurally faithful fixture of two ollama.com/search
    // result cards (same `x-test-*` hooks the live page emits).
    const SEARCH_FIXTURE: &str = r#"
      <ul role="list">
      <li x-test-model class="flex">
        <a href="/library/glm-5.2">
          <h2><span x-test-search-response-title>glm-5.2</span></h2>
          <p class="max-w-lg break-words text-md">GLM-5.2 is Z.ai&#39;s flagship model &amp; more.</p>
          <span x-test-capability class="...">tools</span>
          <span x-test-capability class="...">thinking</span>
          <span x-test-size class="...">8b</span>
          <span x-test-size class="...">355b</span>
          <span x-test-pull-count>65.8K</span>
          <span x-test-updated>1 week ago</span>
        </a>
      </li>
      <li x-test-model class="flex">
        <a href="/library/nomic-embed-text">
          <h2><span x-test-search-response-title>nomic-embed-text</span></h2>
          <p class="max-w-lg break-words text-md">High-quality text embeddings.</p>
          <span x-test-capability class="...">embedding</span>
          <span x-test-size class="...">latest</span>
          <span x-test-pull-count>30M</span>
          <span x-test-updated>1 year ago</span>
        </a>
      </li>
      </ul>"#;

    #[test]
    fn parse_search_html_extracts_all_fields() {
        let models = parse_search_html(SEARCH_FIXTURE);
        assert_eq!(models.len(), 2);

        let glm = &models[0];
        assert_eq!(glm.name, "glm-5.2");
        // HTML entities are unescaped.
        assert_eq!(glm.description, "GLM-5.2 is Z.ai's flagship model & more.");
        assert_eq!(glm.capabilities, vec!["tools", "thinking"]);
        assert_eq!(glm.sizes, vec!["8b", "355b"]);
        assert_eq!(glm.pulls, "65.8K");
        assert_eq!(glm.updated, "1 week ago");

        let nomic = &models[1];
        assert_eq!(nomic.name, "nomic-embed-text");
        assert_eq!(nomic.capabilities, vec!["embedding"]);
        assert_eq!(nomic.sizes, vec!["latest"]);
    }

    #[test]
    fn parse_search_html_empty_when_no_cards() {
        assert!(parse_search_html("<html><body>no results</body></html>").is_empty());
    }

    #[test]
    fn percent_encode_query_escapes_unsafe_chars() {
        assert_eq!(percent_encode_query("llama 3.2"), "llama%203.2");
        assert_eq!(percent_encode_query("a&b=c"), "a%26b%3Dc");
        assert_eq!(percent_encode_query("qwen2.5-coder"), "qwen2.5-coder");
    }

    // ── completion prompt construction (#45) ──────────────────────────────────

    #[test]
    fn completion_prompt_includes_prefix_suffix_and_language() {
        let p = completion_prompt("let x =", " + 1;", "rust", CompletionMode::Sentence, "");
        assert!(p.contains("let x ="), "prefix must be embedded");
        assert!(p.contains(" + 1;"), "suffix must be embedded");
        assert!(p.contains("rust"), "language must be named");
        // Prefix appears before suffix so the model fills in the middle.
        assert!(p.find("let x =").unwrap() < p.find(" + 1;").unwrap());
    }

    #[test]
    fn completion_prompt_defaults_empty_language_to_text() {
        let p = completion_prompt("a", "b", "", CompletionMode::Sentence, "");
        assert!(p.contains("Language: text"), "empty language defaults to text");
    }

    #[test]
    fn completion_prompt_labels_before_and_after_sections() {
        // The BEFORE/AFTER framing is what stops a chat model rewriting the doc.
        let p = completion_prompt("pre", "post", "rust", CompletionMode::Sentence, "");
        assert!(p.contains("BEFORE:\npre"));
        assert!(p.contains("AFTER:\npost"));
        assert!(p.find("BEFORE:").unwrap() < p.find("AFTER:").unwrap());
    }

    #[test]
    fn build_context_block_labels_files_and_skips_empty() {
        let files = vec![
            ContextFile { name: "util.rs".into(), content: "fn helper() {}".into() },
            ContextFile { name: "blank.rs".into(), content: "   \n  ".into() },
            ContextFile { name: "types.rs".into(), content: "struct Foo;".into() },
        ];
        let block = build_context_block(&files);
        assert!(block.contains("--- util.rs ---\nfn helper() {}"));
        assert!(block.contains("--- types.rs ---\nstruct Foo;"));
        // Whitespace-only files contribute nothing.
        assert!(!block.contains("blank.rs"));
        // No files → empty string, so the prompt omits the section.
        assert_eq!(build_context_block(&[]), "");
    }

    #[test]
    fn build_context_block_caps_total_size() {
        let big = "x".repeat(20_000);
        let files = vec![
            ContextFile { name: "a".into(), content: big.clone() },
            ContextFile { name: "b".into(), content: big.clone() },
            ContextFile { name: "c".into(), content: big },
        ];
        let block = build_context_block(&files);
        // Each file is per-file capped and the total is bounded; allow for the
        // labels/separators on top of the included bytes.
        assert!(block.len() <= MAX_CONTEXT_TOTAL + 256, "total context stays bounded");
        // The first file always makes it in.
        assert!(block.contains("--- a ---"));
    }

    #[test]
    fn truncate_chars_respects_utf8_boundaries() {
        // Cutting mid-multibyte must back off to a valid boundary, never panic.
        let s = "a\u{00e9}b"; // 'é' is 2 bytes → byte index 2 splits it
        assert_eq!(truncate_chars(s, 2), "a");
        assert_eq!(truncate_chars(s, 100), s);
    }

    #[test]
    fn completion_prompt_embeds_reference_files_before_the_cursor_sections() {
        let ctx = build_context_block(&[ContextFile {
            name: "lib.rs".into(),
            content: "pub fn answer() -> i32 { 42 }".into(),
        }]);
        let p = completion_prompt("let x = ", "", "rust", CompletionMode::Sentence, &ctx);
        assert!(p.contains("REFERENCE FILES"));
        assert!(p.contains("pub fn answer"));
        // Reference context precedes the BEFORE/AFTER framing.
        assert!(p.find("REFERENCE FILES").unwrap() < p.find("BEFORE:").unwrap());
        // With no context the section is omitted entirely.
        let plain = completion_prompt("let x = ", "", "rust", CompletionMode::Sentence, "");
        assert!(!plain.contains("REFERENCE FILES"));
    }

    #[test]
    fn completion_mode_parse_and_caps_scale_by_mode() {
        assert_eq!(CompletionMode::parse("block"), CompletionMode::Block);
        assert_eq!(CompletionMode::parse("scope"), CompletionMode::Scope);
        // Unknown / absent → the conservative default.
        assert_eq!(CompletionMode::parse("sentence"), CompletionMode::Sentence);
        assert_eq!(CompletionMode::parse("bogus"), CompletionMode::Sentence);
        // Caps grow with scope so bigger modes have room to finish.
        assert!(
            CompletionMode::Sentence.num_predict() < CompletionMode::Block.num_predict()
                && CompletionMode::Block.num_predict() < CompletionMode::Scope.num_predict()
        );
    }

    #[test]
    fn completion_prompt_block_and_scope_drop_the_single_sentence_bias() {
        // Block/scope allow multi-line output; they must NOT carry the sentence
        // mode's "do not begin a new paragraph" restriction.
        let mid = "fn add(a: i32, b: i32) {\n    ";
        let block = completion_prompt(mid, "\n}", "rust", CompletionMode::Block, "");
        assert!(block.contains("block"));
        assert!(!block.contains("middle of a sentence"));

        let scope = completion_prompt(mid, "\n}", "rust", CompletionMode::Scope, "");
        assert!(scope.contains("function") && scope.contains("scope"));
        assert!(!scope.contains("middle of a sentence"));
    }

    #[test]
    fn trailing_comment_intent_detects_comment_above_a_fresh_line() {
        // Caret on a fresh indented line directly below a `//` comment.
        let p = "fn main() {\n    // new for loop to compute the sum\n    ";
        assert_eq!(
            trailing_comment_intent(p, "rust").as_deref(),
            Some("new for loop to compute the sum")
        );
        // Caret at the end of the comment line itself (no newline yet).
        let p2 = "# compute the average of the list";
        assert_eq!(
            trailing_comment_intent(p2, "python").as_deref(),
            Some("compute the average of the list")
        );
    }

    #[test]
    fn trailing_comment_intent_merges_consecutive_comment_lines() {
        let p = "    // compute the sum of all even numbers\n    /// and return the result\n    ";
        assert_eq!(
            trailing_comment_intent(p, "rust").as_deref(),
            Some("compute the sum of all even numbers and return the result")
        );
        // Single-line block comment is recognised in C-family languages.
        let blk = "/* build the lookup table */\n";
        assert_eq!(
            trailing_comment_intent(blk, "typescript").as_deref(),
            Some("build the lookup table")
        );
    }

    #[test]
    fn trailing_comment_intent_ignores_non_instructions_and_prose() {
        // Real code on the caret line → not an intent comment.
        assert_eq!(trailing_comment_intent("let x = 1;\n", "rust"), None);
        // Dividers / lone tokens don't read as instructions.
        assert_eq!(trailing_comment_intent("// ----\n", "rust"), None);
        assert_eq!(trailing_comment_intent("//\n", "rust"), None);
        // Comment is no longer adjacent to the caret (intervening code line).
        let gap = "// describe the loop\nlet y = 2;\n";
        assert_eq!(trailing_comment_intent(gap, "rust"), None);
        // Markdown headings must never be treated as code-intent comments.
        assert_eq!(trailing_comment_intent("# My Heading\n", "markdown"), None);
        // Shebang line is not a natural-language instruction.
        assert_eq!(trailing_comment_intent("#!/bin/bash\n", "bash"), None);
    }

    #[test]
    fn completion_prompt_switches_to_implement_mode_for_intent_comments() {
        let p = "fn main() {\n    // new for loop to compute the sum\n    ";
        let prompt = completion_prompt(p, "\n}", "rust", CompletionMode::Sentence, "");
        // Implements the comment as code rather than continuing prose.
        assert!(prompt.contains("implements that description"));
        assert!(prompt.contains("new for loop to compute the sum"));
        assert!(!prompt.contains("middle of a sentence"));
        // Without a trailing comment it keeps the ordinary sentence behaviour.
        let plain = completion_prompt("let x = ", "", "rust", CompletionMode::Sentence, "");
        assert!(!plain.contains("implements that description"));
    }

    #[test]
    fn is_mid_sentence_detects_unfinished_sentences() {
        // Mid-sentence: ends on a word, comma, or trailing space after a word.
        assert!(is_mid_sentence("The main advantages are"));
        assert!(is_mid_sentence("I am writing to "));
        assert!(is_mid_sentence("a, b,"));
        // Not mid-sentence: terminator, newline, or empty (start of document).
        assert!(!is_mid_sentence("Done."));
        assert!(!is_mid_sentence("Why?"));
        assert!(!is_mid_sentence("Header:"));
        assert!(!is_mid_sentence("paragraph end.\n"));
        assert!(!is_mid_sentence(""));
    }

    #[test]
    fn completion_prompt_biases_to_finishing_the_sentence_when_mid_sentence() {
        let mid = completion_prompt("I am writing to ", " Best regards", "text", CompletionMode::Sentence, "");
        assert!(mid.contains("middle of a sentence"));
        assert!(mid.contains("complete") || mid.contains("completes"));
        // At a sentence boundary it switches to the plain-continuation hint.
        let cont = completion_prompt("First line.\n", "", "text", CompletionMode::Sentence, "");
        assert!(!cont.contains("middle of a sentence"));
        assert!(cont.contains("Continue"));
    }

    #[test]
    fn clean_completion_strips_code_fences() {
        assert_eq!(clean_completion("foo()\n"), "foo()");
        assert_eq!(clean_completion("```rust\nfoo()\n```"), "foo()\n");
        // No fence → unchanged (bar a trailing newline trim).
        assert_eq!(clean_completion("plain"), "plain");
    }

    #[test]
    fn clean_completion_strips_conversational_preamble() {
        // The exact failure the user hit: a chat model prefacing the answer.
        assert_eq!(
            clean_completion("Here is the reformatted version of the text:\nreturn a + b"),
            "return a + b",
        );
        assert_eq!(clean_completion("Sure, here you go:\nx = 1"), "x = 1");
        // A real first line that merely ends in ':' is NOT a preamble — keep it.
        assert_eq!(
            clean_completion("def foo():\n    return 1"),
            "def foo():\n    return 1",
        );
        // A normal multi-line completion is untouched.
        assert_eq!(clean_completion("a + b\nc + d"), "a + b\nc + d");
    }

    #[test]
    fn trim_context_overlap_drops_echoed_prefix_tail() {
        // The exact case from llama3.2:3b: BEFORE ends with "return ", model echoes it.
        assert_eq!(
            trim_context_overlap("    return ", "\n\nprint(x)", "return a + b"),
            "a + b",
        );
        // Repeated trailing word.
        assert_eq!(
            trim_context_overlap("The quick brown fox", " over the dog", "fox jumps"),
            "jumps",
        );
    }

    #[test]
    fn trim_context_overlap_drops_echoed_suffix_head() {
        // Model pre-echoes the start of AFTER at the end of its insertion.
        assert_eq!(
            trim_context_overlap("a = ", " + 1", "compute() + 1"),
            "compute()",
        );
    }

    #[test]
    fn trim_context_overlap_keeps_unrelated_completion() {
        // No overlap → returned unchanged.
        assert_eq!(
            trim_context_overlap("I am writing to ", " Best regards", "express my thanks"),
            "express my thanks",
        );
        // A 1–2 char incidental match is below the threshold, so it is NOT trimmed.
        assert_eq!(trim_context_overlap("foo a", "", "a list of items"), "a list of items");
    }

    #[test]
    fn overlap_len_finds_seam() {
        assert_eq!(overlap_len("    return", "return a"), 6);
        assert_eq!(overlap_len("brown fox", "fox jumps"), 3);
        assert_eq!(overlap_len("hello", "world"), 0);
    }

    // ── grammar check: line numbering + JSON parsing ──────────────────────────

    #[test]
    fn number_lines_prefixes_each_line_one_based() {
        assert_eq!(number_lines("a\nb"), "1: a\n2: b\n");
        // A trailing newline produces a final (empty) numbered line; harmless.
        assert_eq!(number_lines("only"), "1: only\n");
    }

    #[test]
    fn parse_grammar_issues_reads_a_clean_array() {
        let raw = r#"[{"line":2,"bad":"teh","suggestion":"the","category":"spelling","message":"typo"}]"#;
        let issues = parse_grammar_issues(raw);
        assert_eq!(issues.len(), 1);
        assert_eq!(
            issues[0],
            GrammarIssue {
                line: 2,
                bad: "teh".into(),
                suggestion: "the".into(),
                category: "spelling".into(),
                message: "typo".into(),
            }
        );
    }

    #[test]
    fn parse_grammar_issues_strips_prose_and_fences() {
        // Models sometimes wrap the array in prose or a ```json fence; we extract
        // the outermost [...] regardless.
        let raw = "Sure! Here are the issues:\n```json\n[{\"line\":1,\"bad\":\"alot\",\"suggestion\":\"a lot\",\"category\":\"grammar\",\"message\":\"two words\"}]\n```";
        let issues = parse_grammar_issues(raw);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].bad, "alot");
        assert_eq!(issues[0].category, "grammar");
    }

    #[test]
    fn parse_grammar_issues_normalises_category_and_drops_empty_bad() {
        let raw = r#"[
            {"line":1,"bad":"x","category":"weird","message":"m"},
            {"line":1,"bad":"   ","category":"spelling","message":"blank"},
            {"line":3,"bad":"y","category":"style"}
        ]"#;
        let issues = parse_grammar_issues(raw);
        assert_eq!(issues.len(), 2, "blank-bad entry is dropped");
        // Unknown category → grammar; missing suggestion/message default to "".
        assert_eq!(issues[0].category, "grammar");
        assert_eq!(issues[0].suggestion, "");
        // Known categories pass through.
        assert_eq!(issues[1].category, "style");
    }

    #[test]
    fn parse_grammar_issues_empty_or_no_array() {
        assert!(parse_grammar_issues("[]").is_empty());
        assert!(parse_grammar_issues("no issues found").is_empty());
        assert!(parse_grammar_issues("").is_empty());
    }

    #[test]
    fn grammar_language_hint_targets_markup_languages() {
        assert!(grammar_language_hint("latex").contains("LaTeX"));
        assert!(grammar_language_hint("tex").contains("LaTeX"));
        assert!(grammar_language_hint("markdown").contains("Markdown"));
        // Plain text / code → no special markup hint.
        assert_eq!(grammar_language_hint("text"), "");
        assert_eq!(grammar_language_hint("rust"), "");
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
        assert_eq!(
            model_block_count, 1,
            "calling prepare_local_agent twice must not duplicate the model block"
        );
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
        assert_eq!(
            cfg.lines().next().unwrap_or(""),
            format!("active_model = \"{alias}\""),
            "active_model must be first so global config cannot shadow it"
        );
        assert!(cfg.contains(&format!("alias = \"{alias}\"")));
    }

    fn first_available_model() -> Option<String> {
        let mut stream = TcpStream::connect("127.0.0.1:11434").ok()?;
        stream
            .write_all(b"GET /api/tags HTTP/1.0\r\nHost: localhost\r\n\r\n")
            .ok()?;
        let mut response = String::new();
        std::io::Read::read_to_string(&mut stream, &mut response).ok()?;
        let body = response.split("\r\n\r\n").nth(1)?;
        let v: serde_json::Value = serde_json::from_str(body).ok()?;
        v["models"]
            .as_array()?
            .iter()
            .find_map(|m| Some(m["name"].as_str()?.to_owned()))
    }
}
