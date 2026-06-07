use std::fs;
use std::path::Path;

use crate::paths;

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

/// State directory for Eldrun's JSON files.
///
/// Linux: `~/.local/share/eldrun/` — matches the Python app's hard-coded path
/// so that Python rollback finds the same files Rust wrote.
/// Windows: `%APPDATA%\eldrun\`
/// macOS:   `~/Library/Application Support/eldrun/`
pub fn state_dir() -> std::path::PathBuf {
    if cfg!(target_os = "windows") {
        let base = std::env::var("APPDATA")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| paths::home_dir());
        std::path::PathBuf::from(base).join("eldrun")
    } else if cfg!(target_os = "macos") {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
        std::path::PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join("eldrun")
    } else {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/root".to_string());
        std::path::PathBuf::from(home)
            .join(".local")
            .join("share")
            .join("eldrun")
    }
}

/// Working directory for terminals that are not attached to a project.
pub fn root_work_dir() -> std::path::PathBuf {
    paths::root_work_dir()
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
        let dy = if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 {
            366
        } else {
            365
        };
        if days < dy {
            break;
        }
        days -= dy;
        year += 1;
    }
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let month_lens: [u64; 12] = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut month = 1u64;
    for &ml in &month_lens {
        if days < ml {
            break;
        }
        days -= ml;
        month += 1;
    }
    format!(
        "{year:04}-{month:02}-{:02}T{h:02}:{m:02}:{s:02}+00:00",
        days + 1
    )
}

// ── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── today_utc ──────────────────────────────────────────────────────────

    #[test]
    fn today_utc_has_date_format() {
        let s = today_utc();
        assert_eq!(s.len(), 10, "expected YYYY-MM-DD");
        let parts: Vec<&str> = s.split('-').collect();
        assert_eq!(parts.len(), 3);
        let y: u32 = parts[0].parse().expect("year numeric");
        let m: u32 = parts[1].parse().expect("month numeric");
        let d: u32 = parts[2].parse().expect("day numeric");
        assert!(y >= 2024, "year sanity");
        assert!((1..=12).contains(&m), "month range");
        assert!((1..=31).contains(&d), "day range");
    }

    #[test]
    fn today_utc_is_deterministic_within_same_day() {
        assert_eq!(today_utc(), today_utc());
    }

    // ── iso_now ────────────────────────────────────────────────────────────

    #[test]
    fn iso_now_has_utc_offset() {
        let s = iso_now();
        assert!(s.ends_with("+00:00"), "must end with +00:00, got: {s}");
    }

    #[test]
    fn iso_now_contains_t_separator() {
        let s = iso_now();
        assert!(s.contains('T'), "ISO 8601 requires T separator: {s}");
    }

    #[test]
    fn iso_now_year_matches_today() {
        let today = today_utc();
        let now = iso_now();
        let year = &today[..4];
        assert!(
            now.starts_with(year),
            "iso_now year must match today: now={now} today={today}"
        );
    }

    // ── state_dir ─────────────────────────────────────────────────────────

    #[test]
    fn state_dir_ends_with_eldrun() {
        let dir = state_dir();
        let last = dir.file_name().and_then(|n| n.to_str()).unwrap_or("");
        assert_eq!(last, "eldrun", "state_dir must end in 'eldrun': {:?}", dir);
    }

    // ── root_work_dir ─────────────────────────────────────────────────────

    #[test]
    fn root_work_dir_ends_with_root() {
        let dir = root_work_dir();
        let last = dir.file_name().and_then(|n| n.to_str()).unwrap_or("");
        assert_eq!(last, "root", "root_work_dir must end in 'root': {:?}", dir);
    }

    #[test]
    fn root_work_dir_parent_is_eldrun() {
        let dir = root_work_dir();
        let parent = dir
            .parent()
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
            .unwrap_or("");
        assert_eq!(parent, "eldrun");
    }

    // ── write_json / read_json ─────────────────────────────────────────────

    #[test]
    fn write_json_creates_parent_dirs() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("deep/nested/dir/data.json");
        write_json(&path, &vec![1u32, 2, 3]).unwrap();
        assert!(path.exists());
    }

    #[test]
    fn write_read_json_roundtrip_vec() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("list.json");
        let data = vec!["alpha".to_string(), "beta".to_string(), "gamma".to_string()];
        write_json(&path, &data).unwrap();
        let back: Vec<String> = read_json(&path).unwrap();
        assert_eq!(back, data);
    }

    #[test]
    fn write_read_json_roundtrip_map() {
        use std::collections::HashMap;
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("map.json");
        let mut m = HashMap::new();
        m.insert("key".to_string(), 42u32);
        write_json(&path, &m).unwrap();
        let back: HashMap<String, u32> = read_json(&path).unwrap();
        assert_eq!(back["key"], 42);
    }

    #[test]
    fn read_json_error_on_missing_file() {
        let result: Result<Vec<String>, _> =
            read_json(std::path::Path::new("/nonexistent/file.json"));
        assert!(result.is_err());
    }

    #[test]
    fn read_json_error_on_invalid_json() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("bad.json");
        std::fs::write(&path, b"not valid json{{{").unwrap();
        let result: Result<Vec<String>, _> = read_json(&path);
        assert!(result.is_err());
    }

    #[test]
    fn write_json_overwrites_existing_content() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("overwrite.json");
        write_json(&path, &vec!["first"]).unwrap();
        write_json(&path, &vec!["second", "third"]).unwrap();
        let back: Vec<String> = read_json(&path).unwrap();
        assert_eq!(back, vec!["second", "third"]);
    }
}
