//! Lightweight per-process CPU sampling via `/proc` (Linux only).
//!
//! Used to surface a project's live CPU usage in the project-switcher pill popup.
//! A project's "processes" are the PTY child shells plus every descendant they
//! have spawned (an agent CLI, its subprocesses, etc.), so usage reflects the
//! whole working tree rooted at the project's terminals.
//!
//! On non-Linux targets these helpers are absent; the calling command returns 0.

#![cfg(target_os = "linux")]

use std::collections::HashMap;
use std::fs;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Generation counter bumped whenever a PTY is spawned or dies (see
/// [`invalidate_descendant_cache`]). A change forces [`descendant_pids`] to
/// rebuild its cached process tree instead of reusing the previous walk.
static PROC_TREE_GEN: AtomicU64 = AtomicU64::new(0);

/// Cache for [`descendant_pids`], keyed by the (sorted) root pid set. Holds the
/// generation it was built at and a freshness deadline; reused only while both
/// the generation is unchanged *and* the entry is younger than [`CACHE_TTL`].
struct DescendantCache {
    roots: Vec<u32>,
    pids: Vec<u32>,
    generation: u64,
    computed_at: Instant,
}

static DESCENDANT_CACHE: Mutex<Option<DescendantCache>> = Mutex::new(None);

/// Upper bound on cache reuse even if no spawn/death bumped the generation: a
/// process tree can grow/shrink without Eldrun spawning the PTY directly (an
/// agent forking children), so a short TTL keeps the readout from going stale.
const CACHE_TTL: Duration = Duration::from_millis(1500);

/// Invalidate the cached descendant-pid set. Called by the PTY layer on every
/// spawn and death so the next CPU sample reflects the new process tree without
/// waiting for the TTL. Cheap: a single atomic increment.
pub fn invalidate_descendant_cache() {
    PROC_TREE_GEN.fetch_add(1, Ordering::Relaxed);
}

/// Kernel clock ticks per second (USER_HZ). Used to convert jiffies → seconds.
pub fn clk_tck() -> u64 {
    // SAFETY: sysconf is async-signal-safe and takes no pointers.
    let v = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
    if v > 0 {
        v as u64
    } else {
        100
    }
}

/// All pids that are `roots` or descendants of a root, deduplicated.
///
/// Resolving the tree means walking all of `/proc`, which is the per-sample hot
/// path. To avoid repeating that walk on every CPU sample (e.g. each pill hover),
/// the result is cached keyed by the (sorted) root set. The cache is reused while
/// (a) the spawn/death generation counter is unchanged — the PTY layer calls
/// [`invalidate_descendant_cache`] on every spawn/death — and (b) the entry is
/// younger than [`CACHE_TTL`], a backstop for tree changes Eldrun didn't trigger
/// directly (an agent forking its own children).
pub fn descendant_pids(roots: &[u32]) -> Vec<u32> {
    if roots.is_empty() {
        return Vec::new();
    }
    let mut key = roots.to_vec();
    key.sort_unstable();
    key.dedup();

    let generation = PROC_TREE_GEN.load(Ordering::Relaxed);
    {
        let cache = DESCENDANT_CACHE.lock().unwrap();
        if let Some(entry) = cache.as_ref() {
            if entry.generation == generation
                && entry.roots == key
                && entry.computed_at.elapsed() < CACHE_TTL
            {
                return entry.pids.clone();
            }
        }
    }

    let pids = compute_descendant_pids(&key);

    let mut cache = DESCENDANT_CACHE.lock().unwrap();
    *cache = Some(DescendantCache {
        roots: key,
        pids: pids.clone(),
        generation,
        computed_at: Instant::now(),
    });
    pids
}

/// Walk `/proc` once to build a pid → ppid map, then collect every pid whose
/// ancestor chain reaches one of the roots. The uncached core of
/// [`descendant_pids`].
fn compute_descendant_pids(roots: &[u32]) -> Vec<u32> {
    use std::collections::{HashSet, VecDeque};

    // pid → ppid for every live process.
    let mut parent: HashMap<u32, u32> = HashMap::new();
    if let Ok(entries) = fs::read_dir("/proc") {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(pid) = name.to_str().and_then(|s| s.parse::<u32>().ok()) else {
                continue;
            };
            if let Some(ppid) = read_ppid(pid) {
                parent.insert(pid, ppid);
            }
        }
    }

    // children adjacency for a single BFS pass.
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for (&pid, &ppid) in &parent {
        children.entry(ppid).or_default().push(pid);
    }

    let mut seen: HashSet<u32> = HashSet::new();
    let mut queue: VecDeque<u32> = VecDeque::new();
    for &root in roots {
        if seen.insert(root) {
            queue.push_back(root);
        }
    }
    while let Some(pid) = queue.pop_front() {
        if let Some(kids) = children.get(&pid) {
            for &kid in kids {
                if seen.insert(kid) {
                    queue.push_back(kid);
                }
            }
        }
    }
    seen.into_iter().collect()
}

/// Sum of utime + stime (in jiffies) across `pids`. Dead pids are skipped.
pub fn sum_jiffies(pids: &[u32]) -> u64 {
    pids.iter().filter_map(|&pid| read_proc_time(pid)).sum()
}

/// Sum resident memory across `pids`, in KiB. Dead pids are skipped.
pub fn sum_rss_kib(pids: &[u32]) -> u64 {
    pids.iter().filter_map(|&pid| read_rss_kib(pid)).sum()
}

/// Parent pid for a live process.
pub fn ppid(pid: u32) -> Option<u32> {
    read_ppid(pid)
}

/// Command line for a live process, with NUL separators normalized to spaces.
pub fn cmdline(pid: u32) -> Option<String> {
    let bytes = fs::read(format!("/proc/{pid}/cmdline")).ok()?;
    if bytes.is_empty() {
        return None;
    }
    let cmd = bytes
        .split(|b| *b == 0)
        .filter(|part| !part.is_empty())
        .map(|part| String::from_utf8_lossy(part))
        .collect::<Vec<_>>()
        .join(" ");
    if cmd.is_empty() { None } else { Some(cmd) }
}

/// Parent pid from `/proc/<pid>/stat` (field 4, after the comm field).
fn read_ppid(pid: u32) -> Option<u32> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // comm (field 2) may contain spaces/parens, so split after the last ')'.
    let rest = stat.rsplit_once(')')?.1;
    // rest = " S <ppid> ..." → fields[0]="" , [1]=state, [2]=ppid
    rest.split_whitespace().nth(1)?.parse().ok()
}

/// utime + stime (jiffies) from `/proc/<pid>/stat` (fields 14 and 15).
fn read_proc_time(pid: u32) -> Option<u64> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let rest = stat.rsplit_once(')')?.1;
    let fields: Vec<&str> = rest.split_whitespace().collect();
    // After ')' fields are 1-indexed as in proc(5): [0]=state(field 3).
    // utime=field 14 → index 11, stime=field 15 → index 12.
    let utime: u64 = fields.get(11)?.parse().ok()?;
    let stime: u64 = fields.get(12)?.parse().ok()?;
    Some(utime + stime)
}

/// Resident set size from `/proc/<pid>/status`, in KiB.
fn read_rss_kib(pid: u32) -> Option<u64> {
    let status = fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
    for line in status.lines() {
        let Some(rest) = line.strip_prefix("VmRSS:") else {
            continue;
        };
        return rest.split_whitespace().next()?.parse().ok();
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Serializes the cache-mechanics tests: they all mutate the process-global
    /// `DESCENDANT_CACHE`, so running them concurrently (or alongside other tests
    /// that call `descendant_pids`) would race on that shared entry.
    static CACHE_TEST_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn clk_tck_is_positive() {
        assert!(clk_tck() > 0, "USER_HZ must be positive");
    }

    #[test]
    fn descendant_pids_includes_its_own_root() {
        let _guard = CACHE_TEST_LOCK.lock().unwrap();
        let me = std::process::id();
        let pids = descendant_pids(&[me]);
        assert!(pids.contains(&me), "descendant set must contain the root pid itself");
    }

    #[test]
    fn descendant_pids_empty_for_no_roots() {
        assert!(descendant_pids(&[]).is_empty());
    }

    #[test]
    fn descendant_pids_serves_cache_hit_for_unchanged_generation() {
        let _guard = CACHE_TEST_LOCK.lock().unwrap();
        // Directly exercise the cache mechanics independent of the live process
        // tree (other parallel tests fork children, so the *real* tree is not a
        // stable fixture). Seed the cache with a synthetic entry, then confirm a
        // matching query returns it verbatim, and that bumping the generation or
        // changing the root set forces a real recompute.
        let fake_roots = vec![424242u32];
        let fake_pids = vec![424242u32, 999999u32];
        let gen = PROC_TREE_GEN.load(Ordering::Relaxed);
        {
            let mut cache = DESCENDANT_CACHE.lock().unwrap();
            *cache = Some(DescendantCache {
                roots: fake_roots.clone(),
                pids: fake_pids.clone(),
                generation: gen,
                computed_at: Instant::now(),
            });
        }
        // Same roots + same generation + fresh → cache hit returns the seeded set
        // (which could never come from a real /proc walk for pid 424242).
        assert_eq!(descendant_pids(&[424242]), fake_pids);

        // Invalidation bumps the generation, so the stale synthetic entry is no
        // longer reused — the rebuild walks /proc and 999999 is gone.
        invalidate_descendant_cache();
        assert_ne!(descendant_pids(&[424242]), fake_pids);
    }

    #[test]
    fn descendant_pids_cache_keys_on_root_set() {
        let _guard = CACHE_TEST_LOCK.lock().unwrap();
        // A seeded entry for one root set must not satisfy a query for another.
        let gen = PROC_TREE_GEN.load(Ordering::Relaxed);
        {
            let mut cache = DESCENDANT_CACHE.lock().unwrap();
            *cache = Some(DescendantCache {
                roots: vec![111111u32],
                pids: vec![111111u32, 222222u32],
                generation: gen,
                computed_at: Instant::now(),
            });
        }
        // Different roots → cache miss → recompute (no 222222 from a real walk).
        let other = descendant_pids(&[333333]);
        assert!(!other.contains(&222222));
    }

    #[test]
    fn sum_jiffies_counts_a_live_process_and_skips_dead_ones() {
        let me = std::process::id();
        // Burn a little CPU so this process has measurable user time.
        let mut acc: u64 = 0;
        for i in 0..2_000_000u64 {
            acc = acc.wrapping_add(i);
        }
        assert!(acc > 0);
        assert!(sum_jiffies(&[me]) > 0, "the running test process should report jiffies");
        // A pid that cannot exist contributes nothing rather than panicking.
        assert_eq!(sum_jiffies(&[u32::MAX]), 0);
    }

    #[test]
    fn sum_rss_counts_a_live_process_and_skips_dead_ones() {
        let me = std::process::id();
        assert!(sum_rss_kib(&[me]) > 0, "the running test process should report RSS");
        assert_eq!(sum_rss_kib(&[u32::MAX]), 0);
    }
}
