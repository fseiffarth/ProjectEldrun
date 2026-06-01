use std::fs;
use std::path::Path;
use std::time::SystemTime;

/// Read and deserialize a JSON file.
pub fn read_json<T>(path: &Path) -> Result<T, Box<dyn std::error::Error>>
where
    T: serde::de::DeserializeOwned,
{
    let content = fs::read_to_string(path)?;
    Ok(serde_json::from_str(&content)?)
}

/// Serialize and write a JSON file, creating a timestamped backup of the
/// existing file first.  The caller's data is never written if the backup
/// step fails, keeping the original intact.
pub fn write_json<T>(path: &Path, value: &T) -> Result<(), Box<dyn std::error::Error>>
where
    T: serde::Serialize,
{
    if path.exists() {
        let ts = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let file_stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("file");
        let backup_name = format!("{file_stem}.{ts}.bak.json");
        let bak_dir = path
            .parent()
            .unwrap_or(Path::new("."))
            .join("tmp")
            .join("bak");
        fs::create_dir_all(&bak_dir)?;
        let backup = bak_dir.join(backup_name);
        fs::copy(path, backup)?;
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(value)?;
    fs::write(path, json)?;
    Ok(())
}

/// Pinned Linux state directory — do not use Tauri's generated path; this
/// must match the Python app's hard-coded `~/.local/share/eldrun/` path so
/// that Python rollback finds the same files Rust wrote.
pub fn state_dir() -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/root".to_string());
    std::path::PathBuf::from(home)
        .join(".local")
        .join("share")
        .join("eldrun")
}

/// Working directory for terminals that are not attached to a project.
///
/// This mirrors the Python app's documented root terminal directory.
pub fn root_work_dir() -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/root".to_string());
    std::path::PathBuf::from(home).join("eldrun").join("root")
}
