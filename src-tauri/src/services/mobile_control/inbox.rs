//! The phone → project drop box behind the Focus composer's **+**.
//!
//! A file picked on the phone lands in the project's own `.eldrun/inbox/` —
//! a directory the desktop already git-ignores, hides from the tree and skips
//! in sync — and the phone gets back a *project-relative* reference
//! (`.eldrun/inbox/<file>`) to put after an `@` in the message. That relative
//! reference is the one deliberate exception to "paths never cross the browser
//! API": it carries no host component, resolves only from inside the session's
//! own working directory, and is exactly what the agent needs to read the
//! file. The absolute path stays on the desktop.
//!
//! The project tree is attacker-controlled by policy (`AGENTS.md`), so the
//! write is defensive: the file name is rebuilt from a safe alphabet and
//! stamped, the file is created with `create_new` (never overwriting), and the
//! inbox directory must canonicalize *below* the project root — a planted
//! `.eldrun` symlink cannot redirect the bytes elsewhere.

use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

/// Project-relative directory the phone's files land in.
pub const INBOX_DIR: &str = ".eldrun/inbox";
/// One file the phone may send. A phone photo is a few MiB; a short video
/// clip fits; a movie does not belong in an agent prompt.
pub const MAX_INBOX_FILE: usize = 24 * 1024 * 1024;
/// What one inbox may hold in total before uploads are refused — the inbox is
/// never pruned by Eldrun, so the cap is what keeps a forgotten one bounded.
pub const MAX_INBOX_TOTAL: u64 = 1024 * 1024 * 1024;
/// Characters kept of the phone's file name, stem and extension together.
const MAX_NAME: usize = 80;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stored {
    /// The file name as written (stamped, sanitized, made unique).
    pub name: String,
    /// `INBOX_DIR/name` — what the phone puts after the `@`.
    pub reference: String,
    pub size: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub enum InboxError {
    /// The body had no bytes.
    Empty,
    /// The body exceeds `MAX_INBOX_FILE`.
    TooLarge,
    /// The inbox already holds `MAX_INBOX_TOTAL`.
    Full,
    /// The project root is gone, or the inbox does not resolve below it.
    Unavailable,
    Io(String),
}

impl InboxError {
    /// The wire code the phone maps to a message.
    pub fn code(&self) -> &'static str {
        match self {
            InboxError::Empty => "empty_file",
            InboxError::TooLarge => "file_too_large",
            InboxError::Full => "inbox_full",
            InboxError::Unavailable => "project_unavailable",
            InboxError::Io(_) => "write_failed",
        }
    }
}

/// A file name rebuilt from the phone's: the last path component only, drawn
/// from letters, digits, `.`, `-` and `_`, never starting with a dot, bounded
/// in length with its extension kept. Empty in, `attachment` out.
pub fn safe_name(raw: &str) -> String {
    let leaf = raw
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .trim();
    let mut cleaned = String::with_capacity(leaf.len());
    let mut last_was_gap = true;
    for c in leaf.chars() {
        if c.is_alphanumeric() || c == '.' || c == '-' {
            cleaned.push(c);
            last_was_gap = false;
        } else if !last_was_gap {
            cleaned.push('_');
            last_was_gap = true;
        }
    }
    // A gap right before the extension dot is noise, not a separator.
    let cleaned = cleaned.replace("_.", ".");
    let cleaned = cleaned.trim_matches(|c| c == '.' || c == '_' || c == '-');
    if cleaned.is_empty() {
        return "attachment".to_string();
    }
    // Keep a short extension when trimming an overlong stem.
    let (stem, ext) = match cleaned.rsplit_once('.') {
        Some((stem, ext))
            if !stem.is_empty() && !ext.is_empty() && ext.chars().count() <= 12 =>
        {
            (stem, Some(ext))
        }
        _ => (cleaned, None),
    };
    let budget = MAX_NAME.saturating_sub(ext.map_or(0, |e| e.chars().count() + 1)).max(1);
    let stem: String = stem.chars().take(budget).collect();
    match ext {
        Some(ext) => format!("{stem}.{ext}"),
        None => stem,
    }
}

/// `YYYYMMDD-HHMMSS` in UTC — ordering and uniqueness, not a display clock.
fn stamp(now: SystemTime) -> String {
    let secs = now.duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    // Howard Hinnant's civil-from-days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}{month:02}{day:02}-{:02}{:02}{:02}",
        rem / 3_600,
        (rem % 3_600) / 60,
        rem % 60
    )
}

fn inbox_total(dir: &Path) -> Result<u64, InboxError> {
    let mut total = 0u64;
    for entry in fs::read_dir(dir).map_err(|e| InboxError::Io(e.to_string()))? {
        let entry = entry.map_err(|e| InboxError::Io(e.to_string()))?;
        if let Ok(meta) = entry.metadata() {
            if meta.is_file() {
                total = total.saturating_add(meta.len());
            }
        }
    }
    Ok(total)
}

/// Writes `bytes` into `root/.eldrun/inbox/` under a stamped, sanitized,
/// unique name. `root` must be the project's canonical directory.
pub fn store(root: &Path, raw_name: &str, bytes: &[u8]) -> Result<Stored, InboxError> {
    store_at(root, raw_name, bytes, SystemTime::now())
}

fn store_at(
    root: &Path,
    raw_name: &str,
    bytes: &[u8],
    now: SystemTime,
) -> Result<Stored, InboxError> {
    if bytes.is_empty() {
        return Err(InboxError::Empty);
    }
    if bytes.len() > MAX_INBOX_FILE {
        return Err(InboxError::TooLarge);
    }
    if !root.is_dir() {
        return Err(InboxError::Unavailable);
    }
    let dir = root.join(INBOX_DIR);
    fs::create_dir_all(&dir).map_err(|e| InboxError::Io(e.to_string()))?;
    // A `.eldrun` or `inbox` link planted in the tree must not carry the
    // bytes out of the project.
    let canonical_root = root.canonicalize().map_err(|_| InboxError::Unavailable)?;
    let canonical_dir = dir.canonicalize().map_err(|_| InboxError::Unavailable)?;
    if !canonical_dir.starts_with(&canonical_root) {
        return Err(InboxError::Unavailable);
    }
    if inbox_total(&canonical_dir)?.saturating_add(bytes.len() as u64) > MAX_INBOX_TOTAL {
        return Err(InboxError::Full);
    }
    let base = format!("{}-{}", stamp(now), safe_name(raw_name));
    let (stem, ext) = match base.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => (stem.to_string(), format!(".{ext}")),
        _ => (base.clone(), String::new()),
    };
    for attempt in 0u32..1_000 {
        let name = if attempt == 0 {
            base.clone()
        } else {
            format!("{stem}-{}{ext}", attempt + 1)
        };
        let path: PathBuf = canonical_dir.join(&name);
        match fs::OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                if let Err(error) = file.write_all(bytes).and_then(|()| file.flush()) {
                    let _ = fs::remove_file(&path);
                    return Err(InboxError::Io(error.to_string()));
                }
                return Ok(Stored {
                    reference: format!("{INBOX_DIR}/{name}"),
                    name,
                    size: bytes.len() as u64,
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(InboxError::Io(error.to_string())),
        }
    }
    Err(InboxError::Io("no free name in the inbox".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    const T0: u64 = 1_788_177_600; // 2026-08-31 12:00:00 UTC

    fn at(secs: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(secs)
    }

    #[test]
    fn the_stamp_is_a_civil_utc_date() {
        assert_eq!(stamp(at(T0)), "20260831-120000");
        assert_eq!(stamp(at(0)), "19700101-000000");
        assert_eq!(stamp(at(951_782_400)), "20000229-000000"); // leap day
    }

    #[test]
    fn a_file_name_is_rebuilt_from_a_safe_alphabet() {
        assert_eq!(safe_name("IMG_1234.jpg"), "IMG_1234.jpg");
        assert_eq!(safe_name("Screenshot 2026-08-31 at 12.00.png"), "Screenshot_2026-08-31_at_12.00.png");
        assert_eq!(safe_name("../../etc/passwd"), "passwd");
        assert_eq!(safe_name("C:\\Users\\me\\notes.txt"), "notes.txt");
        assert_eq!(safe_name(".hidden"), "hidden");
        assert_eq!(safe_name("..."), "attachment");
        assert_eq!(safe_name(""), "attachment");
        assert_eq!(safe_name("Größe.pdf"), "Größe.pdf");
        assert_eq!(safe_name("a\0b\n.txt"), "a_b.txt");
    }

    #[test]
    fn an_overlong_name_keeps_its_extension() {
        let long = format!("{}.jpeg", "x".repeat(200));
        let name = safe_name(&long);
        assert!(name.ends_with(".jpeg"));
        assert_eq!(name.chars().count(), MAX_NAME);
    }

    #[test]
    fn a_file_lands_stamped_in_the_inbox_and_is_never_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let first = store_at(root, "IMG_1.jpg", b"one", at(T0)).unwrap();
        assert_eq!(first.name, "20260831-120000-IMG_1.jpg");
        assert_eq!(first.reference, ".eldrun/inbox/20260831-120000-IMG_1.jpg");
        assert_eq!(first.size, 3);
        assert_eq!(fs::read(root.join(&first.reference)).unwrap(), b"one");

        let second = store_at(root, "IMG_1.jpg", b"two", at(T0)).unwrap();
        assert_eq!(second.name, "20260831-120000-IMG_1-2.jpg");
        assert_eq!(fs::read(root.join(&first.reference)).unwrap(), b"one");
        assert_eq!(fs::read(root.join(&second.reference)).unwrap(), b"two");
    }

    #[test]
    fn a_traversing_name_stays_inside_the_inbox() {
        let dir = tempfile::tempdir().unwrap();
        let stored = store_at(dir.path(), "../../escape.txt", b"x", at(T0)).unwrap();
        assert_eq!(stored.name, "20260831-120000-escape.txt");
        assert!(dir.path().join(INBOX_DIR).join(&stored.name).is_file());
        assert!(!dir.path().join("escape.txt").exists());
    }

    #[test]
    fn empty_oversized_and_rootless_uploads_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(store_at(dir.path(), "a.txt", b"", at(T0)), Err(InboxError::Empty));
        let big = vec![0u8; MAX_INBOX_FILE + 1];
        assert_eq!(store_at(dir.path(), "a.bin", &big, at(T0)), Err(InboxError::TooLarge));
        assert_eq!(
            store_at(&dir.path().join("missing"), "a.txt", b"x", at(T0)),
            Err(InboxError::Unavailable)
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_planted_symlink_cannot_redirect_the_bytes_out_of_the_project() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let root = dir.path().join("project");
        fs::create_dir_all(root.join(".eldrun")).unwrap();
        std::os::unix::fs::symlink(outside.path(), root.join(".eldrun").join("inbox")).unwrap();
        assert_eq!(
            store_at(&root, "leak.txt", b"x", at(T0)),
            Err(InboxError::Unavailable)
        );
        assert!(fs::read_dir(outside.path()).unwrap().next().is_none());
    }
}
