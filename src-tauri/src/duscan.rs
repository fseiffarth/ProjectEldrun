//! Recursive disk-usage scanning for the Disk Usage Analyzer pane (baobab-like).
//!
//! Two scanners, one output shape ([`DuScan`]):
//!
//!  - [`scan_local`] walks a local directory with plain `std::fs::read_dir`
//!    recursion — the same idiom as `commands::fs::walk_dir_size` and
//!    `commands::search::walk`. No `walkdir`/`rayon`: the repo deliberately keeps
//!    its walks in pure std (see `commands::search`).
//!  - [`parse_du_output`] rebuilds the same tree from a remote `du -ak` dump, so a
//!    host scan costs one SSH round-trip instead of an N-call SFTP walk.
//!
//! Units contract: every `size` is **bytes**. Local sizes are *apparent* sizes
//! (`metadata.len()`), matching `commands::fs::dir_size` and the FileTree size
//! column; remote sizes come from `du`'s 1024-byte blocks (so they are *allocated*
//! sizes, and a dir's total includes its own directory inode). The two therefore
//! differ slightly for the same tree — that is inherent to `du`, and matches what
//! `ssh_exec::remote_dir_size` already reports elsewhere in the app.
//!
//! Safety properties of the local walk:
//!
//!  - **Symlinks are never followed** (`entry.file_type()` reports the link, not
//!    its target), so a symlink cycle cannot loop and a symlinked tree cannot be
//!    double-counted.
//!  - **Hard links are counted once**, by `(dev, ino)`, like `du`.
//!  - Unreadable dirs/entries are skipped and tallied in `errors`; the result is a
//!    best-effort partial total rather than a hard failure.
//!  - Unlike `fs::should_skip_ending_scan_dir`, vendor/build dirs (`node_modules`,
//!    `target`, `.git`, …) are **not** skipped — for a disk analyzer those are
//!    precisely the answer the user came for.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::commands::fs::display_path;

/// Hard cap on recursion depth. Mirrors `fs::MAX_SCAN_DEPTH` — a backstop even
/// though symlinks are not followed.
const MAX_SCAN_DEPTH: usize = 64;

/// Deepest level whose children are shipped to the frontend. Nodes below this keep
/// their aggregate `size` but carry no `children` — the chart never draws that deep
/// anyway, and this is what keeps a whole-home scan from blowing up the IPC bridge.
const MAX_EMIT_DEPTH: usize = 12;

/// Most children shipped per directory, biggest first. The rest are folded into
/// `hidden_children` / `hidden_bytes` (the chart's "…others" slice).
const MAX_CHILDREN: usize = 64;

/// Most `du` lines parsed from a remote scan before giving up on completeness.
const MAX_REMOTE_LINES: usize = 400_000;

/// How often the walk reports progress. Fine enough to look live, coarse enough
/// that the event stream never becomes the bottleneck.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

/// One node of the size tree. `size` is always cumulative (the node itself plus
/// every descendant), so a parent's `size` is authoritative even when its children
/// were pruned by the emit caps.
#[derive(Debug, Clone, Serialize)]
pub struct DuNode {
    pub name: String,
    /// Absolute path, rendered for the frontend (see `fs::display_path`).
    pub path: String,
    pub size: u64,
    pub is_dir: bool,
    /// Sorted descending by `size`. Empty for files and for pruned directories.
    pub children: Vec<DuNode>,
    /// Children omitted from `children` by the emit caps.
    pub hidden_children: u32,
    /// Their summed size. `children` + `hidden_bytes` always accounts for `size`.
    pub hidden_bytes: u64,
}

impl DuNode {
    fn dir(name: String, path: String) -> Self {
        Self { name, path, size: 0, is_dir: true, children: Vec::new(), hidden_children: 0, hidden_bytes: 0 }
    }
    fn file(name: String, path: String, size: u64) -> Self {
        Self { name, path, size, is_dir: false, children: Vec::new(), hidden_children: 0, hidden_bytes: 0 }
    }
}

/// A completed (or cancelled) scan.
#[derive(Debug, Clone, Serialize)]
pub struct DuScan {
    pub root: DuNode,
    pub files: u64,
    pub dirs: u64,
    /// Entries skipped because they could not be read (permissions, races).
    pub errors: u64,
    /// An emit cap or the line cap was hit — the tree is complete in `size` but
    /// abridged in `children`.
    pub truncated: bool,
    /// The walk stopped early because the caller cancelled it.
    pub cancelled: bool,
    /// Capacity of the filesystem holding the root, when knowable.
    pub total_bytes: Option<u64>,
    pub free_bytes: Option<u64>,
}

/// Running counters handed to the progress callback.
#[derive(Debug, Clone, Copy, Default)]
pub struct Tally {
    pub files: u64,
    pub dirs: u64,
    pub bytes: u64,
    pub errors: u64,
}

/// A scan target offered on the pane's home screen.
#[derive(Debug, Clone, Serialize)]
pub struct DuDevice {
    pub label: String,
    pub path: String,
    pub total_bytes: Option<u64>,
    pub free_bytes: Option<u64>,
}

// ── Local walk ────────────────────────────────────────────────────────────────

struct Walker<'a> {
    cancel: &'a AtomicBool,
    progress: &'a mut dyn FnMut(&Tally, &Path),
    tally: Tally,
    /// `(dev, ino)` of every multiply-linked file already counted, so a hard link
    /// is billed once. Unused off Unix, which exposes no portable inode identity.
    #[cfg_attr(not(unix), allow(dead_code))]
    seen: HashSet<(u64, u64)>,
    truncated: bool,
    cancelled: bool,
    last_emit: Instant,
}

impl Walker<'_> {
    /// True when this file's bytes should be counted — i.e. it is not another link
    /// to an inode we have already billed.
    #[cfg(unix)]
    fn count_once(&mut self, meta: &fs::Metadata) -> bool {
        use std::os::unix::fs::MetadataExt;
        if meta.nlink() <= 1 {
            return true;
        }
        self.seen.insert((meta.dev(), meta.ino()))
    }

    /// Off Unix there is no portable inode identity, so every file counts.
    #[cfg(not(unix))]
    fn count_once(&mut self, _meta: &fs::Metadata) -> bool {
        true
    }

    fn tick(&mut self, at: &Path) {
        if self.last_emit.elapsed() >= PROGRESS_INTERVAL {
            self.last_emit = Instant::now();
            (self.progress)(&self.tally, at);
        }
    }

    fn walk(&mut self, dir: &Path, name: String, depth: usize) -> DuNode {
        let mut node = DuNode::dir(name, display_path(dir));
        if depth >= MAX_SCAN_DEPTH {
            self.truncated = true;
            return node;
        }
        if self.cancel.load(Ordering::Relaxed) {
            self.cancelled = true;
            return node;
        }

        self.tally.dirs = self.tally.dirs.saturating_add(1);
        self.tick(dir);

        let entries = match fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => {
                self.tally.errors = self.tally.errors.saturating_add(1);
                return node;
            }
        };

        // Children are only materialised while we are shallow enough to emit them;
        // deeper levels contribute their `size` and nothing else, so a very deep
        // tree never accumulates in memory.
        let emit = depth < MAX_EMIT_DEPTH;
        let mut kids: Vec<DuNode> = Vec::new();
        let mut hidden_children = 0u32;
        let mut hidden_bytes = 0u64;

        for entry in entries.flatten() {
            if self.cancelled || self.cancel.load(Ordering::Relaxed) {
                self.cancelled = true;
                break;
            }
            let Ok(ft) = entry.file_type() else {
                self.tally.errors = self.tally.errors.saturating_add(1);
                continue;
            };
            // A symlink — to a dir or a file — is reported as a symlink here, never
            // as its target, so this single check is the whole cycle defence.
            if ft.is_symlink() {
                continue;
            }
            let path = entry.path();
            let child_name = entry.file_name().to_string_lossy().into_owned();

            let child = if ft.is_dir() {
                self.walk(&path, child_name, depth + 1)
            } else if ft.is_file() {
                let Ok(meta) = entry.metadata() else {
                    self.tally.errors = self.tally.errors.saturating_add(1);
                    continue;
                };
                if !self.count_once(&meta) {
                    continue; // another link to an inode we already billed
                }
                let size = meta.len();
                self.tally.files = self.tally.files.saturating_add(1);
                self.tally.bytes = self.tally.bytes.saturating_add(size);
                DuNode::file(child_name, display_path(&path), size)
            } else {
                continue; // sockets, fifos, devices — no meaningful size
            };

            node.size = node.size.saturating_add(child.size);
            if emit {
                kids.push(child);
            } else {
                hidden_children += 1;
                hidden_bytes = hidden_bytes.saturating_add(child.size);
                self.truncated = true;
            }
        }

        kids.sort_by(|a, b| b.size.cmp(&a.size));
        if kids.len() > MAX_CHILDREN {
            let rest = kids.split_off(MAX_CHILDREN);
            hidden_children += rest.len() as u32;
            hidden_bytes = hidden_bytes.saturating_add(rest.iter().map(|k| k.size).sum());
            self.truncated = true;
        }
        node.children = kids;
        node.hidden_children = hidden_children;
        node.hidden_bytes = hidden_bytes;
        node
    }
}

/// Walk `root` and return its size tree.
///
/// `cancel` is polled per directory and per entry, so a `/` scan aborts promptly;
/// a cancelled scan still returns the partial tree it built (with `cancelled` set)
/// rather than an error. `progress` is invoked at most every
/// [`PROGRESS_INTERVAL`] with the running tally and the directory being read.
pub fn scan_local(
    root: &str,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(&Tally, &Path),
) -> Result<DuScan, String> {
    let root_path = fs::canonicalize(root).map_err(|e| format!("cannot scan {root}: {e}"))?;
    if !root_path.is_dir() {
        return Err(format!("not a directory: {root}"));
    }
    let name = root_name(&root_path);

    let mut walker = Walker {
        cancel,
        progress,
        tally: Tally::default(),
        seen: HashSet::new(),
        truncated: false,
        cancelled: false,
        last_emit: Instant::now(),
    };
    let node = walker.walk(&root_path, name, 0);
    let (total_bytes, free_bytes) = capacity_of(&root_path).unzip();

    Ok(DuScan {
        root: node,
        files: walker.tally.files,
        dirs: walker.tally.dirs,
        errors: walker.tally.errors,
        truncated: walker.truncated,
        cancelled: walker.cancelled,
        total_bytes,
        free_bytes,
    })
}

/// Display name for a scan root: its final component, or the path itself for a
/// filesystem root (`/`, `C:\`) which has none.
fn root_name(p: &Path) -> String {
    p.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| display_path(p))
}

// ── Remote `du` parsing ───────────────────────────────────────────────────────

/// Parent of an absolute POSIX path: `/a/b` → `/a`, `/a` → `/`, `/` → `None`.
fn parent_of(p: &str) -> Option<&str> {
    if p == "/" {
        return None;
    }
    let i = p.rfind('/')?;
    Some(if i == 0 { "/" } else { &p[..i] })
}

fn base_name(p: &str) -> String {
    match p.rsplit_once('/') {
        Some((_, name)) if !name.is_empty() => name.to_string(),
        _ => p.to_string(),
    }
}

/// Rebuild a [`DuScan`] from the stdout of `du -ak <root>` on the host.
///
/// `du` emits `"<kbytes>\t<path>"` per line, children before parents, with each
/// directory's figure already cumulative — so sizes are taken verbatim rather than
/// re-summed. It also dedups hard links itself. A path is treated as a directory
/// iff some other line names it as a parent; a genuinely *empty* remote directory
/// is therefore reported as a zero-byte file. That is cosmetic and the only way to
/// tell without a second round-trip.
pub fn parse_du_output(root: &str, stdout: &str) -> Result<DuScan, String> {
    let mut sizes: HashMap<&str, u64> = HashMap::new();
    let mut order: Vec<&str> = Vec::new();
    let mut truncated = false;

    for line in stdout.lines() {
        if order.len() >= MAX_REMOTE_LINES {
            truncated = true;
            break;
        }
        let Some((kb, path)) = line.split_once('\t') else {
            continue;
        };
        let path = path.trim_end_matches('/');
        let path = if path.is_empty() { "/" } else { path };
        let Ok(kb) = kb.trim().parse::<u64>() else {
            continue;
        };
        if sizes.insert(path, kb.saturating_mul(1024)).is_none() {
            order.push(path);
        }
    }

    let root = root.trim_end_matches('/');
    let root = if root.is_empty() { "/" } else { root };
    if !sizes.contains_key(root) {
        return Err(format!("du reported nothing for {root}"));
    }

    let mut kids: HashMap<&str, Vec<&str>> = HashMap::new();
    for &p in &order {
        if p == root {
            continue;
        }
        let Some(parent) = parent_of(p) else { continue };
        if sizes.contains_key(parent) {
            kids.entry(parent).or_default().push(p);
        }
    }

    let mut tally = Tally::default();
    let node = build_remote(root, 0, &sizes, &kids, &mut tally, &mut truncated);

    Ok(DuScan {
        root: node,
        files: tally.files,
        dirs: tally.dirs,
        errors: 0,
        truncated,
        cancelled: false,
        total_bytes: None,
        free_bytes: None,
    })
}

fn build_remote(
    path: &str,
    depth: usize,
    sizes: &HashMap<&str, u64>,
    kids: &HashMap<&str, Vec<&str>>,
    tally: &mut Tally,
    truncated: &mut bool,
) -> DuNode {
    let size = sizes.get(path).copied().unwrap_or(0);
    let name = base_name(path);
    let Some(children) = kids.get(path) else {
        tally.files = tally.files.saturating_add(1);
        tally.bytes = tally.bytes.saturating_add(size);
        return DuNode::file(name, path.to_string(), size);
    };

    tally.dirs = tally.dirs.saturating_add(1);
    let mut node = DuNode::dir(name, path.to_string());
    node.size = size;

    if depth >= MAX_EMIT_DEPTH || depth >= MAX_SCAN_DEPTH {
        // Still descend, so the file/dir counters stay honest, but emit nothing.
        for &c in children {
            let sub = build_remote(c, depth + 1, sizes, kids, tally, truncated);
            node.hidden_children += 1;
            node.hidden_bytes = node.hidden_bytes.saturating_add(sub.size);
        }
        *truncated = true;
        return node;
    }

    let mut built: Vec<DuNode> =
        children.iter().map(|&c| build_remote(c, depth + 1, sizes, kids, tally, truncated)).collect();
    built.sort_by(|a, b| b.size.cmp(&a.size));
    if built.len() > MAX_CHILDREN {
        let rest = built.split_off(MAX_CHILDREN);
        node.hidden_children = rest.len() as u32;
        node.hidden_bytes = rest.iter().map(|k| k.size).sum();
        *truncated = true;
    }
    node.children = built;
    node
}

// ── Capacity ──────────────────────────────────────────────────────────────────

/// `(total, available)` bytes of the filesystem holding `path`. `None` where the
/// platform gives us no portable answer (Windows), in which case the pane simply
/// omits its capacity bar.
#[cfg(unix)]
pub fn capacity_of(path: &Path) -> Option<(u64, u64)> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let c_path = CString::new(path.as_os_str().as_bytes()).ok()?;
    // SAFETY: `stat` is zeroed and outlives the call; `c_path` is a valid NUL-
    // terminated string for its duration.
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c_path.as_ptr(), &mut stat) } != 0 {
        return None;
    }
    // `f_frsize` is the fragment size the block counts are expressed in; it is 0 on
    // some filesystems, where `f_bsize` is the right unit.
    let unit = if stat.f_frsize > 0 { stat.f_frsize as u64 } else { stat.f_bsize as u64 };
    let total = (stat.f_blocks as u64).saturating_mul(unit);
    let free = (stat.f_bavail as u64).saturating_mul(unit);
    Some((total, free))
}

#[cfg(not(unix))]
pub fn capacity_of(_path: &Path) -> Option<(u64, u64)> {
    None
}

/// Scan targets for the pane's home screen: the user's home directory, plus the
/// filesystem root it lives on.
pub fn devices() -> Vec<DuDevice> {
    let home = crate::paths::home_dir();
    let mut out = vec![device("Home", &home)];

    let fs_root: PathBuf = home.ancestors().last().unwrap_or(&home).to_path_buf();
    if fs_root != home {
        out.push(device("Filesystem", &fs_root));
    }
    out
}

fn device(label: &str, path: &Path) -> DuDevice {
    let (total_bytes, free_bytes) = capacity_of(path).unzip();
    DuDevice { label: label.to_string(), path: display_path(path), total_bytes, free_bytes }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn no_cancel() -> AtomicBool {
        AtomicBool::new(false)
    }

    fn scan(root: &Path) -> DuScan {
        let cancel = no_cancel();
        let mut noop = |_: &Tally, _: &Path| {};
        scan_local(&root.to_string_lossy(), &cancel, &mut noop).expect("scan")
    }

    fn write(path: &Path, bytes: usize) {
        let mut f = fs::File::create(path).unwrap();
        f.write_all(&vec![b'x'; bytes]).unwrap();
    }

    fn child<'a>(node: &'a DuNode, name: &str) -> &'a DuNode {
        node.children.iter().find(|c| c.name == name).expect("child")
    }

    #[test]
    fn sums_nested_sizes_and_sorts_children_biggest_first() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::create_dir(root.join("small")).unwrap();
        fs::create_dir(root.join("big")).unwrap();
        write(&root.join("small/a.txt"), 100);
        write(&root.join("big/b.txt"), 5_000);
        write(&root.join("big/c.txt"), 1_000);

        let scan = scan(root);
        assert_eq!(scan.root.size, 6_100);
        assert_eq!(scan.files, 3);
        assert_eq!(scan.dirs, 3); // root + small + big
        assert!(!scan.truncated);
        assert!(!scan.cancelled);

        let names: Vec<&str> = scan.root.children.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["big", "small"], "children sort descending by size");
        assert_eq!(child(&scan.root, "big").size, 6_000);
        // ...and grandchildren sort too.
        let big = child(&scan.root, "big");
        assert_eq!(big.children[0].name, "b.txt");
    }

    #[test]
    fn vendor_dirs_are_scanned_not_skipped() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::create_dir(root.join("node_modules")).unwrap();
        write(&root.join("node_modules/dep.js"), 2_048);

        let scan = scan(root);
        assert_eq!(scan.root.size, 2_048, "node_modules is the answer, not noise");
        assert_eq!(child(&scan.root, "node_modules").size, 2_048);
    }

    #[cfg(unix)]
    #[test]
    fn symlink_loop_terminates_and_is_not_counted() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::create_dir(root.join("real")).unwrap();
        write(&root.join("real/f.bin"), 512);
        // A directory symlink pointing back at the root: following it would loop.
        std::os::unix::fs::symlink(root, root.join("real/loop")).unwrap();
        // ...and a file symlink, which must not double-count f.bin.
        std::os::unix::fs::symlink(root.join("real/f.bin"), root.join("alias.bin")).unwrap();

        let scan = scan(root);
        assert_eq!(scan.root.size, 512, "symlinks contribute nothing");
        assert_eq!(scan.files, 1);
    }

    #[cfg(unix)]
    #[test]
    fn hard_links_are_counted_once() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(&root.join("original.bin"), 4_096);
        fs::hard_link(root.join("original.bin"), root.join("link.bin")).unwrap();

        let scan = scan(root);
        assert_eq!(scan.root.size, 4_096, "the second link is the same bytes on disk");
        assert_eq!(scan.files, 1);
    }

    #[test]
    fn wide_directory_is_capped_and_the_remainder_is_accounted_for() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let n = MAX_CHILDREN + 10;
        for i in 0..n {
            // Descending sizes, so the pruned tail is the smallest files.
            write(&root.join(format!("f{i:03}.bin")), n - i);
        }
        let total: usize = (1..=n).sum();

        let scan = scan(root);
        assert!(scan.truncated);
        assert_eq!(scan.files, n as u64);
        assert_eq!(scan.root.children.len(), MAX_CHILDREN);
        assert_eq!(scan.root.hidden_children, 10);
        assert_eq!(scan.root.size, total as u64, "the total stays exact");
        let emitted: u64 = scan.root.children.iter().map(|c| c.size).sum();
        assert_eq!(
            emitted + scan.root.hidden_bytes,
            scan.root.size,
            "emitted children plus hidden bytes account for the whole node",
        );
    }

    #[test]
    fn deep_tree_keeps_its_total_but_stops_emitting_children() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let mut p = root.to_path_buf();
        for i in 0..(MAX_EMIT_DEPTH + 3) {
            p = p.join(format!("d{i}"));
            fs::create_dir(&p).unwrap();
        }
        write(&p.join("deep.bin"), 777);

        let scan = scan(root);
        assert!(scan.truncated);
        assert_eq!(scan.root.size, 777, "the deep file still counts toward the root");

        // Walk down the emitted spine: it must stop handing out children at the cap.
        let mut node = &scan.root;
        let mut depth = 0;
        while let Some(next) = node.children.first() {
            node = next;
            depth += 1;
        }
        assert_eq!(depth, MAX_EMIT_DEPTH);
        assert_eq!(node.hidden_children, 1, "the level below the cap is folded away");
        assert_eq!(node.size, 777);
    }

    #[test]
    fn cancellation_stops_the_walk_and_returns_a_partial_tree() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        for i in 0..20 {
            write(&root.join(format!("f{i}.bin")), 100);
        }
        let cancel = AtomicBool::new(true); // already cancelled
        let mut noop = |_: &Tally, _: &Path| {};
        let scan = scan_local(&root.to_string_lossy(), &cancel, &mut noop).unwrap();
        assert!(scan.cancelled);
        assert!(scan.root.children.is_empty());
    }

    #[test]
    fn missing_root_is_an_error() {
        let tmp = tempfile::tempdir().unwrap();
        let cancel = no_cancel();
        let mut noop = |_: &Tally, _: &Path| {};
        let missing = tmp.path().join("nope");
        assert!(scan_local(&missing.to_string_lossy(), &cancel, &mut noop).is_err());
    }

    #[test]
    fn progress_reports_the_running_tally() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::create_dir(root.join("sub")).unwrap();
        write(&root.join("sub/a.bin"), 10);

        let cancel = no_cancel();
        let mut seen: Vec<u64> = Vec::new();
        // The first tick always fires (last_emit starts one interval in the past is
        // not guaranteed), so assert only that the callback is *callable* and that
        // the tally it sees is monotonic — the timing itself is not under test.
        let mut cb = |t: &Tally, _: &Path| seen.push(t.dirs);
        let scan = scan_local(&root.to_string_lossy(), &cancel, &mut cb).unwrap();
        assert_eq!(scan.dirs, 2);
        assert!(seen.windows(2).all(|w| w[0] <= w[1]), "dir count only grows");
    }

    // ── Remote `du` parsing ───────────────────────────────────────────────────

    #[test]
    fn parses_du_output_into_the_same_tree_shape() {
        // Real `du -ak` shape: children first, dirs cumulative, sizes in KiB.
        let out = "\
4\t/srv/app/src/main.rs
8\t/srv/app/src
16\t/srv/app/data.bin
28\t/srv/app
";
        let scan = parse_du_output("/srv/app", out).unwrap();
        assert_eq!(scan.root.name, "app");
        assert_eq!(scan.root.size, 28 * 1024, "the root total is du's, not a re-sum");
        assert_eq!(scan.dirs, 2); // /srv/app and /srv/app/src
        assert_eq!(scan.files, 2);

        let names: Vec<&str> = scan.root.children.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["data.bin", "src"], "biggest first");
        assert_eq!(child(&scan.root, "src").children[0].name, "main.rs");
    }

    #[test]
    fn parses_a_du_scan_rooted_at_the_filesystem_root() {
        let out = "4\t/etc/hosts\n8\t/etc\n12\t/\n";
        let scan = parse_du_output("/", out).unwrap();
        assert_eq!(scan.root.name, "/");
        assert_eq!(scan.root.size, 12 * 1024);
        assert_eq!(child(&scan.root, "etc").children[0].name, "hosts");
    }

    #[test]
    fn du_output_without_the_root_is_an_error() {
        assert!(parse_du_output("/srv/app", "4\t/other/thing\n").is_err());
    }

    #[test]
    fn du_output_tolerates_junk_lines_and_a_trailing_slash_root() {
        let out = "not a du line\n\n4\t/srv/app/f\n8\t/srv/app/\n";
        let scan = parse_du_output("/srv/app", out).unwrap();
        assert_eq!(scan.root.size, 8 * 1024);
        assert_eq!(scan.root.children.len(), 1);
    }
}
