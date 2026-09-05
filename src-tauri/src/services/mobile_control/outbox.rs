//! The project → phone picture box: what an agent shows on the phone.
//!
//! The mirror of `inbox.rs`. A terminal carries no pictures, so an agent that
//! wants the phone to *see* an image — a screenshot it took, a plot it
//! rendered, a diagram it read — copies the file into the project's own
//! `.eldrun/outbox/` (git-ignored, hidden from the tree, skipped by sync, and
//! inside the roots the agent fence lets it write). The Focus view lists that
//! folder and renders the images inline, the way a vendor's remote app shows
//! the image its agent just read. Nothing detects images in terminal text: a
//! path printed by the session is a guess, and Focus classifies nothing.
//!
//! The project tree is attacker-controlled by policy (`AGENTS.md`), so the
//! read is as defensive as the inbox write: the folder must canonicalize
//! *below* the project root (a planted `.eldrun` symlink cannot point the
//! phone at another directory), symlinks *inside* it are never followed (one
//! pointing at a picture elsewhere on the host would leak it), a file is
//! served only when its **bytes** are an image the browser renders — the
//! extension decides nothing, and SVG, which can carry script, is not an
//! image here — and the name that crosses to the phone is a leaf drawn from
//! the inbox's safe alphabet. The phone never names a path, only a leaf.

use std::{
    fs,
    io::Read,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

/// Project-relative directory an agent puts pictures for the phone in.
pub const OUTBOX_DIR: &str = ".eldrun/outbox";
/// One picture the phone will load. The inbox's ceiling, for the same reason:
/// a screenshot or a plot is a few MiB; a raw camera dump is not a message.
pub const MAX_OUTBOX_IMAGE: u64 = 24 * 1024 * 1024;
/// How many pictures the listing returns, newest first — a strip on a phone,
/// not a gallery, and a folder nobody prunes must stay cheap to list.
pub const MAX_LISTED: usize = 40;
/// The longest leaf that crosses.
const MAX_NAME: usize = 120;
/// Enough of a file to tell its format.
const SNIFF_BYTES: usize = 16;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct OutboxImage {
    /// The leaf the phone asks for again — the file name, validated.
    pub name: String,
    /// `image/png`, `image/jpeg`, `image/gif` or `image/webp`, from the bytes.
    pub kind: &'static str,
    pub size: u64,
    /// Unix seconds of the file's mtime — ordering, and "just now" on the phone.
    pub modified: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub enum OutboxError {
    /// The project root is gone, or the outbox does not resolve below it.
    Unavailable,
    /// No such name, or it names something that is not a servable image.
    NotFound,
    Io(String),
}

impl OutboxError {
    /// The wire code the phone maps to a message.
    pub fn code(&self) -> &'static str {
        match self {
            OutboxError::Unavailable => "project_unavailable",
            OutboxError::NotFound => "image_not_found",
            OutboxError::Io(_) => "read_failed",
        }
    }
}

/// Whether `name` is a leaf the outbox will list or serve: the inbox's safe
/// alphabet (letters, digits, `.`, `-`, `_`), never starting with a dot, no
/// separators, bounded. Anything else in the folder is simply not there.
pub fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_NAME
        && !name.starts_with('.')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
}

/// The media type the first bytes announce, for the formats every phone
/// browser renders in an `<img>`. `None` is "not an image here" — a text
/// file, a PDF, an SVG, a truncated header.
pub fn sniff(head: &[u8]) -> Option<&'static str> {
    if head.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if head.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if head.starts_with(b"GIF87a") || head.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if head.len() >= 12 && head.starts_with(b"RIFF") && &head[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

/// The outbox directory, proven to sit below the project root — or `None`
/// when there is no outbox yet, which is the ordinary case and not an error.
fn outbox_dir(root: &Path) -> Result<Option<std::path::PathBuf>, OutboxError> {
    if !root.is_dir() {
        return Err(OutboxError::Unavailable);
    }
    let dir = root.join(OUTBOX_DIR);
    if fs::symlink_metadata(&dir).is_err() {
        return Ok(None);
    }
    let canonical_root = root.canonicalize().map_err(|_| OutboxError::Unavailable)?;
    let canonical_dir = dir.canonicalize().map_err(|_| OutboxError::Unavailable)?;
    if !canonical_dir.starts_with(&canonical_root) || !canonical_dir.is_dir() {
        return Err(OutboxError::Unavailable);
    }
    Ok(Some(canonical_dir))
}

/// Reads the first bytes of a regular, non-symlink, bounded file under the
/// outbox and says what image it is — or `None` for anything the phone must
/// not be handed.
fn probe(dir: &Path, name: &str) -> Option<(fs::Metadata, &'static str)> {
    if !valid_name(name) {
        return None;
    }
    let path = dir.join(name);
    // `symlink_metadata` does not follow: a link inside the outbox is refused
    // as such, wherever it points.
    let meta = fs::symlink_metadata(&path).ok()?;
    if !meta.is_file() || meta.len() == 0 || meta.len() > MAX_OUTBOX_IMAGE {
        return None;
    }
    let mut head = [0u8; SNIFF_BYTES];
    let mut file = fs::File::open(&path).ok()?;
    let mut filled = 0;
    while filled < SNIFF_BYTES {
        match file.read(&mut head[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(_) => return None,
        }
    }
    let kind = sniff(&head[..filled])?;
    Some((meta, kind))
}

fn unix_secs(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// The images in `root/.eldrun/outbox/`, newest first, at most `MAX_LISTED`.
/// A project without an outbox lists nothing. Files that are not servable
/// images are left out silently — the folder is the agent's to fill and the
/// listing is what the phone can actually show.
pub fn list(root: &Path) -> Result<Vec<OutboxImage>, OutboxError> {
    let Some(dir) = outbox_dir(root)? else {
        return Ok(Vec::new());
    };
    let mut images = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| OutboxError::Io(e.to_string()))? {
        let entry = entry.map_err(|e| OutboxError::Io(e.to_string()))?;
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let Some((meta, kind)) = probe(&dir, &name) else {
            continue;
        };
        images.push(OutboxImage {
            name,
            kind,
            size: meta.len(),
            modified: meta.modified().map(unix_secs).unwrap_or(0),
        });
    }
    images.sort_by(|a, b| b.modified.cmp(&a.modified).then_with(|| b.name.cmp(&a.name)));
    images.truncate(MAX_LISTED);
    Ok(images)
}

/// One image's bytes and media type, by the leaf the listing handed out.
pub fn read(root: &Path, name: &str) -> Result<(Vec<u8>, &'static str), OutboxError> {
    let Some(dir) = outbox_dir(root)? else {
        return Err(OutboxError::NotFound);
    };
    let Some((meta, kind)) = probe(&dir, name) else {
        return Err(OutboxError::NotFound);
    };
    let path = dir.join(name);
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    // Bounded again on the way in: the size was read before the file was,
    // and a file growing under the read must not grow the response.
    fs::File::open(&path)
        .and_then(|file| file.take(MAX_OUTBOX_IMAGE).read_to_end(&mut bytes))
        .map_err(|e| OutboxError::Io(e.to_string()))?;
    Ok((bytes, kind))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR-body";
    const JPEG: &[u8] = b"\xff\xd8\xff\xe0\0\x10JFIF-body";

    fn outbox(root: &Path) -> std::path::PathBuf {
        let dir = root.join(OUTBOX_DIR);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn touch(dir: &Path, name: &str, bytes: &[u8], age: Duration) {
        let path = dir.join(name);
        fs::write(&path, bytes).unwrap();
        let file = fs::File::options().write(true).open(&path).unwrap();
        file.set_modified(SystemTime::now() - age).unwrap();
    }

    #[test]
    fn the_bytes_decide_the_kind_not_the_name() {
        assert_eq!(sniff(PNG), Some("image/png"));
        assert_eq!(sniff(JPEG), Some("image/jpeg"));
        assert_eq!(sniff(b"GIF89a\x01\x00"), Some("image/gif"));
        assert_eq!(sniff(b"RIFF\x10\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(sniff(b"<svg xmlns=\"http://www.w3.org/2000/svg\">"), None);
        assert_eq!(sniff(b"%PDF-1.7"), None);
        assert_eq!(sniff(b"\x89PN"), None);
        assert_eq!(sniff(b""), None);
    }

    #[test]
    fn only_a_safe_leaf_is_a_name() {
        assert!(valid_name("plot.png"));
        assert!(valid_name("20260905-120000-shot_1.jpeg"));
        assert!(!valid_name(""));
        assert!(!valid_name(".hidden.png"));
        assert!(!valid_name("../escape.png"));
        assert!(!valid_name("sub/dir.png"));
        assert!(!valid_name("back\\slash.png"));
        assert!(!valid_name("sp ace.png"));
        assert!(!valid_name("Größe.png"));
        assert!(!valid_name(&"x".repeat(MAX_NAME + 1)));
    }

    #[test]
    fn a_project_without_an_outbox_lists_nothing_and_a_missing_root_is_unavailable() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(list(dir.path()), Ok(Vec::new()));
        assert_eq!(read(dir.path(), "plot.png"), Err(OutboxError::NotFound));
        assert_eq!(list(&dir.path().join("missing")), Err(OutboxError::Unavailable));
    }

    #[test]
    fn images_list_newest_first_and_only_real_images_by_a_safe_name() {
        let dir = tempfile::tempdir().unwrap();
        let box_dir = outbox(dir.path());
        touch(&box_dir, "old.png", PNG, Duration::from_secs(3_600));
        touch(&box_dir, "new.jpg", JPEG, Duration::from_secs(60));
        // The extension says image; the bytes say text. Not listed.
        touch(&box_dir, "fake.png", b"hello, not a picture", Duration::from_secs(10));
        // Script can hide in an SVG; it is not an image here.
        touch(&box_dir, "vector.svg", b"<svg onload=\"alert(1)\"/>", Duration::from_secs(10));
        touch(&box_dir, "empty.png", b"", Duration::from_secs(10));
        touch(&box_dir, ".hidden.png", PNG, Duration::from_secs(10));
        touch(&box_dir, "with space.png", PNG, Duration::from_secs(10));
        fs::create_dir_all(box_dir.join("folder.png")).unwrap();

        let listed = list(dir.path()).unwrap();
        let names: Vec<&str> = listed.iter().map(|i| i.name.as_str()).collect();
        assert_eq!(names, ["new.jpg", "old.png"]);
        assert_eq!(listed[0].kind, "image/jpeg");
        assert_eq!(listed[0].size, JPEG.len() as u64);
        assert!(listed[0].modified > listed[1].modified);

        let (bytes, kind) = read(dir.path(), "old.png").unwrap();
        assert_eq!(bytes, PNG);
        assert_eq!(kind, "image/png");
        for refused in ["fake.png", "vector.svg", "empty.png", ".hidden.png", "with space.png", "folder.png", "../old.png", "gone.png"] {
            assert_eq!(read(dir.path(), refused), Err(OutboxError::NotFound), "{refused}");
        }
    }

    #[test]
    fn the_listing_is_capped() {
        let dir = tempfile::tempdir().unwrap();
        let box_dir = outbox(dir.path());
        for i in 0..(MAX_LISTED + 5) {
            touch(&box_dir, &format!("p{i:03}.png"), PNG, Duration::from_secs(i as u64));
        }
        let listed = list(dir.path()).unwrap();
        assert_eq!(listed.len(), MAX_LISTED);
        assert_eq!(listed[0].name, "p000.png");
    }

    #[test]
    fn an_oversized_file_is_not_an_image_here() {
        let dir = tempfile::tempdir().unwrap();
        let box_dir = outbox(dir.path());
        let path = box_dir.join("huge.png");
        let file = fs::File::create(&path).unwrap();
        file.set_len(MAX_OUTBOX_IMAGE + 1).unwrap();
        drop(file);
        // A sparse file: the header is zeros, so it would fail the sniff too —
        // make it a real PNG header to prove the size alone refuses it.
        let mut file = fs::File::options().write(true).open(&path).unwrap();
        std::io::Write::write_all(&mut file, PNG).unwrap();
        drop(file);
        assert_eq!(list(dir.path()).unwrap(), Vec::new());
        assert_eq!(read(dir.path(), "huge.png"), Err(OutboxError::NotFound));
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_never_followed_in_or_out_of_the_outbox() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let secret = outside.path().join("private.png");
        fs::write(&secret, PNG).unwrap();

        // A link *inside* the outbox pointing at a picture elsewhere.
        let root = dir.path().join("linked-file");
        let box_dir = outbox(&root);
        std::os::unix::fs::symlink(&secret, box_dir.join("leak.png")).unwrap();
        touch(&box_dir, "own.png", PNG, Duration::from_secs(1));
        let names: Vec<String> = list(&root).unwrap().into_iter().map(|i| i.name).collect();
        assert_eq!(names, ["own.png"]);
        assert_eq!(read(&root, "leak.png"), Err(OutboxError::NotFound));

        // The outbox itself as a link out of the project.
        let root = dir.path().join("linked-dir");
        fs::create_dir_all(root.join(".eldrun")).unwrap();
        std::os::unix::fs::symlink(outside.path(), root.join(OUTBOX_DIR)).unwrap();
        assert_eq!(list(&root), Err(OutboxError::Unavailable));
        assert_eq!(read(&root, "private.png"), Err(OutboxError::Unavailable));
    }
}
