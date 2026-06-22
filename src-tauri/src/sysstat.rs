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
/// Walks `/proc` once to build a pid → ppid map, then collects every pid whose
/// ancestor chain reaches one of the roots.
pub fn descendant_pids(roots: &[u32]) -> Vec<u32> {
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

    #[test]
    fn clk_tck_is_positive() {
        assert!(clk_tck() > 0, "USER_HZ must be positive");
    }

    #[test]
    fn descendant_pids_includes_its_own_root() {
        let me = std::process::id();
        let pids = descendant_pids(&[me]);
        assert!(pids.contains(&me), "descendant set must contain the root pid itself");
    }

    #[test]
    fn descendant_pids_empty_for_no_roots() {
        assert!(descendant_pids(&[]).is_empty());
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
