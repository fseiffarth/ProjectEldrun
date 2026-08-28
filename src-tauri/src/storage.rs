use std::fs;
use std::io::Write;
use std::path::Path;
use std::sync::Mutex;

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

/// Serialize and write a JSON file **atomically**: the bytes land in a temp file
/// beside the target and are then `rename`d over it, so a reader (or a crash)
/// never observes a half-written file.
///
/// [`write_json`] truncates in place, which is fine for a store with one writer
/// that rewrites it rarely. Prefer this for a store written from several places
/// (see `schema::usage_stats`, fed by both the frontend flush and the file
/// watcher). Same rename trick as `services::agent_session::write_live_session_in`.
pub fn write_json_atomic<T>(path: &Path, value: &T) -> Result<(), Box<dyn std::error::Error>>
where
    T: serde::Serialize,
{
    let _guard = JSON_MUTATION_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    write_json_atomic_unlocked(path, value)
}

/// Serialize one JSON read-modify-write transaction with every atomic writer in
/// this process. A missing file starts from `default`; an existing file must
/// deserialize successfully or `patch` is never called and its bytes are left
/// untouched.
///
/// Keep `patch` limited to the in-memory mutation. Calling
/// [`write_json_atomic`] from it would try to acquire the same lock again.
pub fn patch_json<T, R>(
    path: &Path,
    default: T,
    patch: impl FnOnce(&mut T) -> Result<R, String>,
) -> Result<R, String>
where
    T: serde::de::DeserializeOwned + serde::Serialize,
{
    let _guard = JSON_MUTATION_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut value = if path.exists() {
        read_json(path).map_err(|e| e.to_string())?
    } else {
        default
    };
    let result = patch(&mut value)?;
    write_json_atomic_unlocked(path, &value).map_err(|e| e.to_string())?;
    Ok(result)
}

/// One lock covers atomic replacements and the read side of [`patch_json`].
/// JSON state files are small; keeping the boundary process-wide avoids a lock
/// registry whose entries can outlive arbitrary state paths.
static JSON_MUTATION_LOCK: Mutex<()> = Mutex::new(());

fn write_json_atomic_unlocked<T>(path: &Path, value: &T) -> Result<(), Box<dyn std::error::Error>>
where
    T: serde::Serialize,
{
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    // The temp file must sit on the same filesystem as the target for `rename`
    // to be atomic, so it goes in the target's own directory rather than /tmp.
    // NamedTempFile also makes the sibling name unique: concurrent writers can
    // never rename or truncate one another's staging file.
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let mut staged = tempfile::NamedTempFile::new_in(parent)?;
    serde_json::to_writer_pretty(staged.as_file_mut(), value)?;
    staged.as_file_mut().write_all(b"\n")?;
    staged.as_file_mut().sync_all()?;
    staged.persist(path)?;
    Ok(())
}

/// State directory for Eldrun's JSON files.
///
/// Linux: `~/.local/share/eldrun/` — matches the Python app's hard-coded path
/// so that Python rollback finds the same files Rust wrote.
/// Windows: `%APPDATA%\eldrun\`
/// macOS:   `~/Library/Application Support/eldrun/`
pub fn state_dir() -> std::path::PathBuf {
    // Test/dev override. The state dir is now written to by tests (the per-project
    // session state moved here out of the project tree), and a test suite that
    // writes into the developer's real `~/.local/share/eldrun/` is not a test
    // suite. Not a supported runtime knob — nothing sets it but the test harness,
    // and anything that could set it for the app already owns the process.
    if let Ok(dir) = std::env::var("ELDRUN_STATE_DIR") {
        if !dir.is_empty() {
            return std::path::PathBuf::from(dir);
        }
    }
    if cfg!(target_os = "windows") {
        let base = std::env::var("APPDATA")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| paths::home_dir());
        base.join("eldrun")
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

/// The scope id of the root terminal — the one scope that is not a project and
/// is always there. It is what the frontend's `tabsByScope`/usage keys call it
/// (`stores/tabs`' `ROOT_SCOPE`), what `load_tab_session`/`save_tab_layout`
/// receive as a `project_id`, and — `project_key` being the identity on an
/// all-alphanumeric string — the name of its directory under the state dir.
///
/// Declared here, beside [`root_work_dir`] and [`project_key`], because the
/// backend's whole knowledge of the root scope is "this id maps to that folder,
/// and it is in no project list".
pub const ROOT_SCOPE: &str = "root";

/// Working directory for terminals that are not attached to a project.
pub fn root_work_dir() -> std::path::PathBuf {
    paths::root_work_dir()
}

/// Reduce a project id to a single path-safe component, so it can name a
/// directory under the state dir without any part of it being read as a path.
///
/// The **one** copy of this reduction. It used to exist three times over
/// (`services::sandbox::sanitize_key`, `services::agent_session::
/// sanitize_project_key`, and now the per-project session dir), and three copies
/// of a path-safety rule is two too many: a project id that one of them mapped
/// differently would put two subsystems' state in different places for the same
/// project, silently.
pub fn project_key(id: &str) -> String {
    let safe: String = id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if safe.is_empty() {
        "x".to_string()
    } else {
        safe
    }
}

/// `<state_dir>/sessions/` — the root of the per-project session state that used
/// to live inside each project tree.
pub fn sessions_root() -> std::path::PathBuf {
    state_dir().join("sessions")
}

/// `<state_dir>/sessions/<project key>/` — where a project's tab layout,
/// `open_apps` and host-bound markers live.
///
/// **The reason this directory exists at all**: everything under it is read back
/// by the host as *executable intent* (a tab's `cmd`/`env`/`cwd`, an app to
/// launch, a decision to skip the container), and its previous home was inside
/// the project tree — i.e. inside the project container's writable rw mount, and
/// inside any repository that gets cloned or imported as a project. A boundary
/// whose writable area contains the control plane of the thing enforcing it is
/// not a boundary. Nothing here is mounted into any container.
pub fn project_session_dir(project_id: &str) -> std::path::PathBuf {
    sessions_root().join(project_key(project_id))
}

fn now_secs() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// Current date in UTC as "YYYY-MM-DD".
pub fn today_utc() -> String {
    let (y, m, d, ..) = epoch_to_utc(now_secs());
    format!("{y:04}-{m:02}-{d:02}")
}

/// Current UTC hour as "YYYY-MM-DDTHH" — a sortable stamp whose first ten
/// characters are exactly [`today_utc`], so an hour bucket always folds into the
/// right day bucket.
pub fn hour_utc() -> String {
    let (y, m, d, h, ..) = epoch_to_utc(now_secs());
    format!("{y:04}-{m:02}-{d:02}T{h:02}")
}

/// Current timestamp as ISO-8601 UTC string (seconds precision).
pub fn iso_now() -> String {
    let (y, mo, d, h, mi, s) = epoch_to_utc(now_secs());
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}+00:00")
}

/// Convert a Unix timestamp to UTC calendar fields:
/// (year, month, day, hour, minute, second).
pub(crate) fn epoch_to_utc(secs: u64) -> (u64, u64, u64, u64, u64, u64) {
    let s = secs % 60;
    let m = (secs / 60) % 60;
    let h = (secs / 3600) % 24;
    let mut days = secs / 86400;
    let mut year = 1970u64;
    loop {
        let dy = if is_leap_year(year) { 366 } else { 365 };
        if days < dy {
            break;
        }
        days -= dy;
        year += 1;
    }
    let month_lens: [u64; 12] = [
        31,
        if is_leap_year(year) { 29 } else { 28 },
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
    (year, month, days + 1, h, m, s)
}

pub(crate) fn is_leap_year(y: u64) -> bool {
    (y.is_multiple_of(4) && !y.is_multiple_of(100)) || y.is_multiple_of(400)
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

    // ── hour_utc ───────────────────────────────────────────────────────────

    #[test]
    fn hour_utc_has_hour_stamp_format() {
        let s = hour_utc();
        assert_eq!(s.len(), 13, "expected YYYY-MM-DDTHH, got {s}");
        let (date, hour) = s.split_once('T').expect("T separator");
        assert_eq!(date.len(), 10);
        let h: u32 = hour.parse().expect("hour numeric");
        assert!(h <= 23, "hour range: {h}");
    }

    #[test]
    fn hour_utc_is_prefixed_by_today_utc() {
        // net_usage derives the day bucket from the hour stamp's first ten
        // chars, so a divergence here would silently misfile every byte.
        let hour = hour_utc();
        let today = today_utc();
        assert_eq!(
            &hour[..10],
            today,
            "hour_utc must carry today_utc's date: hour={hour} today={today}"
        );
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

    // ── is_leap_year ───────────────────────────────────────────────────────

    #[test]
    fn year_divisible_by_4_is_leap() {
        assert!(is_leap_year(2024));
        assert!(is_leap_year(2000));
        assert!(is_leap_year(1600));
    }

    #[test]
    fn year_divisible_by_100_but_not_400_is_not_leap() {
        assert!(!is_leap_year(1900));
        assert!(!is_leap_year(1800));
        assert!(!is_leap_year(2100));
    }

    #[test]
    fn year_not_divisible_by_4_is_not_leap() {
        assert!(!is_leap_year(2023));
        assert!(!is_leap_year(2025));
        assert!(!is_leap_year(1999));
    }

    // ── epoch_to_utc ───────────────────────────────────────────────────────

    #[test]
    fn epoch_zero_is_unix_epoch() {
        let (y, mo, d, h, m, s) = epoch_to_utc(0);
        assert_eq!((y, mo, d, h, m, s), (1970, 1, 1, 0, 0, 0));
    }

    #[test]
    fn epoch_midnight_jan_2_1970() {
        let (y, mo, d, h, m, s) = epoch_to_utc(86400);
        assert_eq!((y, mo, d, h, m, s), (1970, 1, 2, 0, 0, 0));
    }

    #[test]
    fn epoch_end_of_1970() {
        // Dec 31 1970 23:59:59 = 86400*365 - 1 = 31535999
        let (y, mo, d, ..) = epoch_to_utc(31535999);
        assert_eq!((y, mo, d), (1970, 12, 31));
    }

    #[test]
    fn epoch_jan_1_2000() {
        // 2000-01-01T00:00:00Z = 946684800
        let (y, mo, d, h, m, s) = epoch_to_utc(946684800);
        assert_eq!((y, mo, d, h, m, s), (2000, 1, 1, 0, 0, 0));
    }

    #[test]
    fn epoch_feb_29_leap_year() {
        // 2000-02-29T00:00:00Z = 951782400
        let (y, mo, d, ..) = epoch_to_utc(951782400);
        assert_eq!((y, mo, d), (2000, 2, 29));
    }

    #[test]
    fn epoch_time_components_are_correct() {
        // 1717414496 = 2024-06-03T11:34:56Z (verified: 1717372800 + 41696)
        let (y, mo, d, h, m, s) = epoch_to_utc(1717414496);
        assert_eq!((y, mo, d), (2024, 6, 3));
        assert_eq!((h, m, s), (11, 34, 56));
    }

    #[test]
    fn epoch_seconds_wrap_at_60() {
        let (_, _, _, _, _, s) = epoch_to_utc(59);
        assert_eq!(s, 59);
        let (_, _, _, _, _, s2) = epoch_to_utc(60);
        assert_eq!(s2, 0);
    }

    #[test]
    fn epoch_minutes_wrap_at_60() {
        let (_, _, _, _, m, _) = epoch_to_utc(3599); // 59m59s
        assert_eq!(m, 59);
        let (_, _, _, _, m2, _) = epoch_to_utc(3600); // 1h0m0s
        assert_eq!(m2, 0);
    }

    #[test]
    fn today_and_iso_now_agree_on_the_date() {
        let today = today_utc();
        let now = iso_now();
        assert!(
            now.starts_with(&today),
            "iso_now must share today_utc's date: now={now} today={today}"
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

    // ── write_json_atomic ─────────────────────────────────────────────────

    #[test]
    fn write_json_atomic_roundtrips() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("atomic.json");
        write_json_atomic(&path, &vec![7u32, 8, 9]).unwrap();
        let back: Vec<u32> = read_json(&path).unwrap();
        assert_eq!(back, vec![7, 8, 9]);
    }

    #[test]
    fn write_json_atomic_creates_parent_dirs() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("deep/nested/atomic.json");
        write_json_atomic(&path, &vec![1u32]).unwrap();
        assert!(path.exists());
    }

    #[test]
    fn write_json_atomic_overwrites_and_leaves_no_temp_behind() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("data.json");
        write_json_atomic(&path, &vec!["first"]).unwrap();
        write_json_atomic(&path, &vec!["second"]).unwrap();
        let back: Vec<String> = read_json(&path).unwrap();
        assert_eq!(back, vec!["second"]);
        // The rename must have consumed the temp file; a leftover would
        // accumulate one stale sibling per write.
        let strays: Vec<_> = std::fs::read_dir(tmp.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(strays.is_empty(), "temp files left behind: {strays:?}");
    }

    #[test]
    fn patch_json_refuses_to_replace_corrupt_existing_file() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("data.json");
        std::fs::write(&path, b"{broken").unwrap();

        let result = patch_json(&path, Vec::<u32>::new(), |values| {
            values.push(7);
            Ok(())
        });

        assert!(result.is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"{broken");
    }

    #[test]
    fn patch_json_serializes_concurrent_read_modify_write() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("counter.json");
        write_json_atomic(&path, &0_u32).unwrap();
        let path = std::sync::Arc::new(path);
        let mut threads = Vec::new();
        for _ in 0..8 {
            let path = path.clone();
            threads.push(std::thread::spawn(move || {
                for _ in 0..25 {
                    patch_json(path.as_ref(), 0_u32, |counter| {
                        *counter += 1;
                        Ok(())
                    })
                    .unwrap();
                }
            }));
        }
        for thread in threads {
            thread.join().unwrap();
        }

        assert_eq!(read_json::<u32>(path.as_ref()).unwrap(), 200);
    }
}
