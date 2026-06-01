use std::fs;
use std::path::Path;

/// Read and deserialize a JSON file.
pub fn read_json<T>(path: &Path) -> Result<T, Box<dyn std::error::Error>>
where
    T: serde::de::DeserializeOwned,
{
    let content = fs::read_to_string(path)?;
    Ok(serde_json::from_str(&content)?)
}

/// Serialize and write a JSON file.
pub fn write_json<T>(path: &Path, value: &T) -> Result<(), Box<dyn std::error::Error>>
where
    T: serde::Serialize,
{
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

/// Current date in UTC as "YYYY-MM-DD".
pub fn today_utc() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let days = (secs / 86400) as i64;
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

/// Current timestamp as ISO-8601 UTC string (seconds precision).
pub fn iso_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let total = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let s = total % 60;
    let m = (total / 60) % 60;
    let h = (total / 3600) % 24;
    let mut days = total / 86400;
    let mut year = 1970u64;
    loop {
        let dy = if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 { 366 } else { 365 };
        if days < dy { break; }
        days -= dy;
        year += 1;
    }
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let month_lens: [u64; 12] = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut month = 1u64;
    for &ml in &month_lens {
        if days < ml { break; }
        days -= ml;
        month += 1;
    }
    format!("{year:04}-{month:02}-{:02}T{h:02}:{m:02}:{s:02}+00:00", days + 1)
}
