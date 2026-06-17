//! Lightweight per-process CPU sampling via `/proc` (Linux only).
//!
//! Used to surface a project's live CPU usage in the bottom-bar pill popup.
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
