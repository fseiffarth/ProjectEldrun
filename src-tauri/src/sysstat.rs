//! Lightweight per-process CPU/memory sampling for the project resource readout.
//!
//! Used to surface a project's live CPU/RSS usage in the project-switcher pill
//! popup. A project's "processes" are the PTY child shells plus every descendant
//! they have spawned (an agent CLI, its subprocesses, etc.), so usage reflects
//! the whole working tree rooted at the project's terminals.
//!
//! The platform-neutral layer (process-tree cache + BFS, sum helpers) is shared;
//! the actual sampling is delegated to a per-OS [`platform`] backend:
//! - **Linux** reads `/proc` (`stat`/`status`/`cmdline`).
//! - **Windows** uses ToolHelp snapshots + `GetProcessTimes`/`GetProcessMemoryInfo`.
//! - **Any other OS** falls back to empty/zero results, so callers degrade to a
//!   `0` readout instead of failing to build.
//!
//! CPU time is reported in opaque "ticks": [`sum_jiffies`] returns a tick count
//! and [`clk_tck`] the ticks-per-second, so the caller's
//! `busy_secs = ticks / clk_tck()` formula is correct on every backend (Linux
//! jiffies + USER_HZ; Windows 100-ns units + 10_000_000).

use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Cumulative CPU jiffies for one core (or the machine aggregate), as read from
/// `/proc/stat`. `busy = total − idle − iowait`. CPU **percentages** are derived
/// on the frontend from the delta of two successive snapshots
/// (`(busy_now − busy_prev) / (total_now − total_prev)`), so these counters carry
/// no timestamp of their own — the ratio is wall-clock-independent.
#[derive(Serialize, Clone, Copy, Default)]
pub struct CpuTimes {
    pub busy: u64,
    pub total: u64,
}

/// One process in a [`SystemSnapshot`]. `cpu_jiffies` is the cumulative
/// utime+stime; the frontend turns successive samples into a live CPU%.
#[derive(Serialize, Clone, Default)]
pub struct ProcSample {
    pub pid: u32,
    pub ppid: u32,
    pub comm: String,
    pub cmdline: String,
    pub state: String,
    pub rss_kib: u64,
    pub cpu_jiffies: u64,
    pub threads: u32,
}

/// A single whole-system sample backing the htop-like monitor pane. Everything
/// here is a *cumulative* counter or an instantaneous gauge; the pane computes
/// per-core and per-process CPU% by diffing two of these (see the module notes on
/// [`CpuTimes`]). `supported` is `false` on platforms without a `/proc`-style
/// enumeration, letting the UI show a graceful "Linux only" placeholder.
#[derive(Serialize, Clone, Default)]
pub struct SystemSnapshot {
    pub supported: bool,
    pub clk_tck: u64,
    pub num_cores: u32,
    pub cpu: CpuTimes,
    pub per_core: Vec<CpuTimes>,
    pub mem_total_kib: u64,
    pub mem_available_kib: u64,
    pub swap_total_kib: u64,
    pub swap_free_kib: u64,
    pub load_avg: [f64; 3],
    pub uptime_secs: f64,
    pub processes: Vec<ProcSample>,
}

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

/// Ticks per second for the current backend (Linux USER_HZ, Windows 100-ns
/// units). Used to convert [`sum_jiffies`] ticks → seconds.
pub fn clk_tck() -> u64 {
    platform::clk_tck()
}

/// All pids that are `roots` or descendants of a root, deduplicated.
///
/// Resolving the tree means enumerating every process, which is the per-sample
/// hot path. To avoid repeating that on every CPU sample (e.g. each pill hover),
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

/// Build a pid → ppid map from the backend, then collect every pid whose ancestor
/// chain reaches one of the roots. The uncached core of [`descendant_pids`].
fn compute_descendant_pids(roots: &[u32]) -> Vec<u32> {
    use std::collections::{HashSet, VecDeque};

    let parent = platform::parent_map();

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

/// Sum of busy CPU ticks across `pids` (Linux utime+stime jiffies; Windows
/// kernel+user 100-ns units). Dead pids are skipped.
pub fn sum_jiffies(pids: &[u32]) -> u64 {
    pids.iter().filter_map(|&pid| platform::proc_ticks(pid)).sum()
}

/// Sum resident memory across `pids`, in KiB. Dead pids are skipped.
pub fn sum_rss_kib(pids: &[u32]) -> u64 {
    pids.iter().filter_map(|&pid| platform::rss_kib(pid)).sum()
}

/// Parent pid for a live process, if resolvable on this backend.
pub fn ppid(pid: u32) -> Option<u32> {
    platform::ppid(pid)
}

/// Command line for a live process, if resolvable on this backend.
pub fn cmdline(pid: u32) -> Option<String> {
    platform::cmdline(pid)
}

/// A whole-system sample (all processes + per-core CPU + memory/load) for the
/// htop-like monitor pane. Delegates to the per-OS backend; non-`/proc` targets
/// return `SystemSnapshot { supported: false, .. }`.
pub fn system_snapshot() -> SystemSnapshot {
    platform::system_snapshot()
}

// ── Pure `/proc` parsers (Linux; compiled under test on any OS) ──────────────
// Factored out of the Linux backend so they can be unit-tested from string
// fixtures without a live `/proc`.

/// Parse one `cpu`/`cpuN` line of `/proc/stat` into cumulative busy/total ticks.
/// `total` is the sum of every column; `busy = total − idle − iowait`.
#[cfg(any(target_os = "linux", test))]
fn parse_cpu_line(line: &str) -> Option<CpuTimes> {
    let mut it = line.split_whitespace();
    it.next()?; // "cpu" / "cpuN" label
    let nums: Vec<u64> = it.filter_map(|t| t.parse::<u64>().ok()).collect();
    if nums.len() < 4 {
        return None;
    }
    let total: u64 = nums.iter().sum();
    let idle = nums[3];
    let iowait = nums.get(4).copied().unwrap_or(0);
    Some(CpuTimes {
        busy: total.saturating_sub(idle).saturating_sub(iowait),
        total,
    })
}

/// Parse `/proc/stat` into (aggregate, per-core) cumulative CPU times. The
/// aggregate is the `cpu ` line; each `cpuN` line is one core, in order.
#[cfg(any(target_os = "linux", test))]
fn parse_cpu_stat(content: &str) -> (CpuTimes, Vec<CpuTimes>) {
    let mut agg = CpuTimes::default();
    let mut per_core = Vec::new();
    for line in content.lines() {
        let Some(rest) = line.strip_prefix("cpu") else {
            continue;
        };
        match rest.chars().next() {
            Some(' ') => {
                if let Some(ct) = parse_cpu_line(line) {
                    agg = ct;
                }
            }
            Some(c) if c.is_ascii_digit() => {
                if let Some(ct) = parse_cpu_line(line) {
                    per_core.push(ct);
                }
            }
            _ => {}
        }
    }
    (agg, per_core)
}

/// Extract (MemTotal, MemAvailable, SwapTotal, SwapFree) from `/proc/meminfo`,
/// all in KiB. Missing keys default to 0.
#[cfg(any(target_os = "linux", test))]
fn parse_meminfo(content: &str) -> (u64, u64, u64, u64) {
    let get = |key: &str| -> u64 {
        content
            .lines()
            .find_map(|l| l.strip_prefix(key))
            .and_then(|r| r.split_whitespace().next())
            .and_then(|v| v.parse().ok())
            .unwrap_or(0)
    };
    (
        get("MemTotal:"),
        get("MemAvailable:"),
        get("SwapTotal:"),
        get("SwapFree:"),
    )
}

/// First three floats of `/proc/loadavg` (1/5/15-minute load averages).
#[cfg(any(target_os = "linux", test))]
fn parse_loadavg(content: &str) -> [f64; 3] {
    let mut it = content.split_whitespace();
    let mut next = || it.next().and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0);
    [next(), next(), next()]
}

/// Parse a `/proc/<pid>/stat` line into (comm, state, ppid, cpu_jiffies,
/// threads). `comm` sits between the first `(` and last `)` and may itself
/// contain spaces/parens, so fields are indexed *after* the last `)`:
/// index 0 = state (field 3), 1 = ppid (field 4), 11 = utime (14),
/// 12 = stime (15), 17 = num_threads (20).
#[cfg(any(target_os = "linux", test))]
fn parse_pid_stat(content: &str) -> Option<(String, String, u32, u64, u32)> {
    let open = content.find('(')?;
    let close = content.rfind(')')?;
    let comm = content.get(open + 1..close)?.to_string();
    let fields: Vec<&str> = content.get(close + 1..)?.split_whitespace().collect();
    let state = (*fields.first()?).to_string();
    let ppid: u32 = fields.get(1)?.parse().ok()?;
    let utime: u64 = fields.get(11)?.parse().ok()?;
    let stime: u64 = fields.get(12)?.parse().ok()?;
    let threads: u32 = fields.get(17)?.parse().ok()?;
    Some((comm, state, ppid, utime + stime, threads))
}

// ── Linux backend (`/proc`) ─────────────────────────────────────────────────
#[cfg(target_os = "linux")]
mod platform {
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

    /// pid → ppid for every live process, from a single `/proc` walk.
    pub fn parent_map() -> HashMap<u32, u32> {
        let mut parent: HashMap<u32, u32> = HashMap::new();
        if let Ok(entries) = fs::read_dir("/proc") {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let Some(pid) = name.to_str().and_then(|s| s.parse::<u32>().ok()) else {
                    continue;
                };
                if let Some(ppid) = ppid(pid) {
                    parent.insert(pid, ppid);
                }
            }
        }
        parent
    }

    /// utime + stime (jiffies) from `/proc/<pid>/stat` (fields 14 and 15).
    pub fn proc_ticks(pid: u32) -> Option<u64> {
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
    pub fn rss_kib(pid: u32) -> Option<u64> {
        let status = fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
        for line in status.lines() {
            let Some(rest) = line.strip_prefix("VmRSS:") else {
                continue;
            };
            return rest.split_whitespace().next()?.parse().ok();
        }
        None
    }

    /// Parent pid from `/proc/<pid>/stat` (field 4, after the comm field).
    pub fn ppid(pid: u32) -> Option<u32> {
        let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        // comm (field 2) may contain spaces/parens, so split after the last ')'.
        let rest = stat.rsplit_once(')')?.1;
        // rest = " S <ppid> ..." → fields[0]="" , [1]=state, [2]=ppid
        rest.split_whitespace().nth(1)?.parse().ok()
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
        if cmd.is_empty() {
            None
        } else {
            Some(cmd)
        }
    }

    /// Whole-system sample from `/proc`: aggregate + per-core CPU, memory/swap,
    /// load, uptime, and every process (one `/proc/<pid>/{stat,status,cmdline}`
    /// read each). Kernel threads (empty `cmdline`) fall back to `[comm]`.
    pub fn system_snapshot() -> super::SystemSnapshot {
        use super::{ProcSample, SystemSnapshot};

        let (cpu, per_core) =
            super::parse_cpu_stat(&fs::read_to_string("/proc/stat").unwrap_or_default());
        let (mem_total_kib, mem_available_kib, swap_total_kib, swap_free_kib) =
            super::parse_meminfo(&fs::read_to_string("/proc/meminfo").unwrap_or_default());
        let load_avg =
            super::parse_loadavg(&fs::read_to_string("/proc/loadavg").unwrap_or_default());
        let uptime_secs = fs::read_to_string("/proc/uptime")
            .ok()
            .and_then(|c| c.split_whitespace().next()?.parse::<f64>().ok())
            .unwrap_or(0.0);

        let mut processes = Vec::new();
        if let Ok(entries) = fs::read_dir("/proc") {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let Some(pid) = name.to_str().and_then(|s| s.parse::<u32>().ok()) else {
                    continue;
                };
                let Ok(stat) = fs::read_to_string(format!("/proc/{pid}/stat")) else {
                    continue;
                };
                let Some((comm, state, ppid, cpu_jiffies, threads)) = super::parse_pid_stat(&stat)
                else {
                    continue;
                };
                let cmdline = cmdline(pid).unwrap_or_else(|| format!("[{comm}]"));
                processes.push(ProcSample {
                    pid,
                    ppid,
                    comm,
                    cmdline,
                    state,
                    rss_kib: rss_kib(pid).unwrap_or(0),
                    cpu_jiffies,
                    threads,
                });
            }
        }

        SystemSnapshot {
            supported: true,
            clk_tck: clk_tck(),
            num_cores: per_core.len() as u32,
            cpu,
            per_core,
            mem_total_kib,
            mem_available_kib,
            swap_total_kib,
            swap_free_kib,
            load_avg,
            uptime_secs,
            processes,
        }
    }
}

// ── Windows backend (ToolHelp + Win32) ──────────────────────────────────────
#[cfg(target_os = "windows")]
mod platform {
    use std::collections::HashMap;
    use windows::Win32::Foundation::{CloseHandle, FILETIME, HANDLE};
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32First, Process32Next, PROCESSENTRY32, TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
    use windows::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    /// Windows has no USER_HZ; `GetProcessTimes` reports in 100-ns units, so the
    /// ticks-per-second the caller divides by is 10_000_000.
    pub fn clk_tck() -> u64 {
        10_000_000
    }

    /// pid → ppid for every live process, from a single ToolHelp snapshot.
    pub fn parent_map() -> HashMap<u32, u32> {
        let mut map = HashMap::new();
        // SAFETY: snapshot is closed before returning; the entry is fully
        // initialized (dwSize set) before Process32First reads it.
        unsafe {
            let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
                return map;
            };
            let mut entry = PROCESSENTRY32 {
                dwSize: std::mem::size_of::<PROCESSENTRY32>() as u32,
                ..Default::default()
            };
            if Process32First(snapshot, &mut entry).is_ok() {
                loop {
                    map.insert(entry.th32ProcessID, entry.th32ParentProcessID);
                    if Process32Next(snapshot, &mut entry).is_err() {
                        break;
                    }
                }
            }
            let _ = CloseHandle(snapshot);
        }
        map
    }

    /// Open a process for query, run `f` with the handle, and always close it.
    fn with_process<T>(pid: u32, f: impl FnOnce(HANDLE) -> Option<T>) -> Option<T> {
        // SAFETY: the handle is closed before returning regardless of `f`'s result.
        let handle =
            unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;
        let out = f(handle);
        unsafe {
            let _ = CloseHandle(handle);
        }
        out
    }

    /// kernel + user CPU time in 100-ns units, via `GetProcessTimes`.
    pub fn proc_ticks(pid: u32) -> Option<u64> {
        with_process(pid, |handle| {
            let mut creation = FILETIME::default();
            let mut exit = FILETIME::default();
            let mut kernel = FILETIME::default();
            let mut user = FILETIME::default();
            // SAFETY: all four FILETIME out-params are valid for the call.
            unsafe { GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) }
                .ok()?;
            Some(filetime_units(kernel) + filetime_units(user))
        })
    }

    /// Working-set size in KiB, via `GetProcessMemoryInfo`.
    pub fn rss_kib(pid: u32) -> Option<u64> {
        with_process(pid, |handle| {
            let mut counters = PROCESS_MEMORY_COUNTERS::default();
            // SAFETY: `counters` is valid and `cb` matches its size.
            unsafe {
                GetProcessMemoryInfo(
                    handle,
                    &mut counters,
                    std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
                )
            }
            .ok()?;
            Some(counters.WorkingSetSize as u64 / 1024)
        })
    }

    pub fn ppid(pid: u32) -> Option<u32> {
        parent_map().get(&pid).copied()
    }

    /// Not resolved on Windows (only used by the Linux-specific `tauri dev`
    /// process-root heuristic); returns `None` so callers fall back gracefully.
    pub fn cmdline(_pid: u32) -> Option<String> {
        None
    }

    fn filetime_units(ft: FILETIME) -> u64 {
        ((ft.dwHighDateTime as u64) << 32) | ft.dwLowDateTime as u64
    }

    /// Not implemented on Windows yet: the htop-like monitor is Linux-only for
    /// now, so return an unsupported snapshot and let the UI show a placeholder.
    pub fn system_snapshot() -> super::SystemSnapshot {
        super::SystemSnapshot::default()
    }
}

// ── macOS backend (libproc) ─────────────────────────────────────────────────
#[cfg(target_os = "macos")]
mod platform {
    use std::collections::HashMap;

    /// Ticks per second for [`proc_ticks`]: macOS task CPU times are nanoseconds,
    /// so one "tick" is one nanosecond and there are 1e9 per second.
    pub fn clk_tck() -> u64 {
        1_000_000_000
    }

    /// Fill a `proc_taskinfo` for `pid` (CPU time + RSS). `None` if the process is
    /// gone or the call did not write a full struct.
    fn task_info(pid: u32) -> Option<libc::proc_taskinfo> {
        // SAFETY: `proc_pidinfo` writes at most `size` bytes into `info`, which is
        // a zero-initialized, correctly-sized `proc_taskinfo`. We pass its real
        // size and accept the result only when the kernel wrote the whole struct,
        // so we never read uninitialized fields.
        unsafe {
            let mut info: libc::proc_taskinfo = std::mem::zeroed();
            let size = std::mem::size_of::<libc::proc_taskinfo>() as libc::c_int;
            let ret = libc::proc_pidinfo(
                pid as libc::c_int,
                libc::PROC_PIDTASKINFO,
                0,
                &mut info as *mut _ as *mut libc::c_void,
                size,
            );
            if ret == size { Some(info) } else { None }
        }
    }

    /// Fill a `proc_bsdinfo` for `pid` (used for the parent pid). Same contract as
    /// [`task_info`].
    fn bsd_info(pid: u32) -> Option<libc::proc_bsdinfo> {
        // SAFETY: identical contract to `task_info` but for the BSD-info flavor:
        // `info` is zero-initialized and correctly sized, and a short/failed write
        // (ret != size) is rejected before any field is read.
        unsafe {
            let mut info: libc::proc_bsdinfo = std::mem::zeroed();
            let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
            let ret = libc::proc_pidinfo(
                pid as libc::c_int,
                libc::PROC_PIDTBSDINFO,
                0,
                &mut info as *mut _ as *mut libc::c_void,
                size,
            );
            if ret == size { Some(info) } else { None }
        }
    }

    /// Total user + system CPU time for `pid`, in nanoseconds (the macOS "tick").
    pub fn proc_ticks(pid: u32) -> Option<u64> {
        let info = task_info(pid)?;
        Some(info.pti_total_user.wrapping_add(info.pti_total_system))
    }

    /// Resident set size for `pid`, in KiB (`pti_resident_size` is bytes).
    pub fn rss_kib(pid: u32) -> Option<u64> {
        let info = task_info(pid)?;
        Some(info.pti_resident_size / 1024)
    }

    /// Parent pid for `pid` via the BSD-info flavor.
    pub fn ppid(pid: u32) -> Option<u32> {
        Some(bsd_info(pid)?.pbi_ppid)
    }

    /// Process args on macOS are only reachable via `sysctl KERN_PROCARGS2`; the
    /// sole caller is a Linux-only "tauri dev" heuristic, so we skip it.
    pub fn cmdline(_pid: u32) -> Option<String> {
        None
    }

    /// pid → ppid for every live process: enumerate all pids with
    /// `proc_listallpids`, then resolve each parent via [`ppid`].
    pub fn parent_map() -> HashMap<u32, u32> {
        let mut parent: HashMap<u32, u32> = HashMap::new();
        for pid in all_pids() {
            if let Some(pp) = ppid(pid) {
                parent.insert(pid, pp);
            }
        }
        parent
    }

    /// All live pids via `proc_listallpids`. Empty vec on failure.
    ///
    /// `proc_listallpids` returns a *count* of pids (it divides the kernel's
    /// byte count by `sizeof(pid_t)`): with a null buffer it reports how many
    /// pids exist, and with a real buffer it reports how many it filled in.
    fn all_pids() -> Vec<u32> {
        // SAFETY: the first call passes a null buffer / zero size, so the kernel
        // only reports the pid count and writes nothing. We then size a buffer to
        // that count plus slack (covering processes spawned between the two
        // calls), pass its length in *bytes*, and use the returned pid count to
        // bound how many entries we read back — never more than we allocated.
        unsafe {
            let count = libc::proc_listallpids(std::ptr::null_mut(), 0);
            if count <= 0 {
                return Vec::new();
            }
            let cap = count as usize + 64;
            let mut pids = vec![0i32; cap];
            let filled = libc::proc_listallpids(
                pids.as_mut_ptr() as *mut libc::c_void,
                (cap * std::mem::size_of::<i32>()) as libc::c_int,
            );
            if filled <= 0 {
                return Vec::new();
            }
            pids.truncate(filled as usize);
            pids.into_iter()
                .filter(|&p| p > 0)
                .map(|p| p as u32)
                .collect()
        }
    }

    /// Not implemented on macOS yet: the htop-like monitor is Linux-only for now,
    /// so return an unsupported snapshot and let the UI show a placeholder.
    pub fn system_snapshot() -> super::SystemSnapshot {
        super::SystemSnapshot::default()
    }
}

// ── Fallback backend (other OSes) ───────────────────────────────────────────
// Targets with no `/proc`, no ToolHelp, and no libproc; the readout degrades to
// zero rather than failing to compile.
#[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
mod platform {
    use std::collections::HashMap;

    pub fn clk_tck() -> u64 {
        // Arbitrary positive value; `sum_jiffies` is always 0 here so the derived
        // CPU percentage is 0 regardless, and callers never divide by zero.
        100
    }

    pub fn parent_map() -> HashMap<u32, u32> {
        HashMap::new()
    }

    pub fn proc_ticks(_pid: u32) -> Option<u64> {
        None
    }

    pub fn rss_kib(_pid: u32) -> Option<u64> {
        None
    }

    pub fn ppid(_pid: u32) -> Option<u32> {
        None
    }

    pub fn cmdline(_pid: u32) -> Option<String> {
        None
    }

    /// No `/proc`-style enumeration here: return an unsupported snapshot so the
    /// monitor pane degrades to a placeholder rather than failing to build.
    pub fn system_snapshot() -> super::SystemSnapshot {
        super::SystemSnapshot::default()
    }
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
        assert!(clk_tck() > 0, "ticks-per-second must be positive");
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
        // (which could never come from a real process walk for pid 424242).
        assert_eq!(descendant_pids(&[424242]), fake_pids);

        // Invalidation bumps the generation, so the stale synthetic entry is no
        // longer reused — the rebuild walks the real tree and 999999 is gone.
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

    // The sampling assertions below rely on a real process backend (Linux `/proc`
    // or Windows ToolHelp). On the zero fallback they would trivially fail, so
    // they are scoped to the two backends that actually sample.
    #[cfg(any(target_os = "linux", target_os = "windows"))]
    #[test]
    fn sum_jiffies_counts_a_live_process_and_skips_dead_ones() {
        let me = std::process::id();
        // Burn a little CPU so this process has measurable user time.
        let mut acc: u64 = 0;
        for i in 0..2_000_000u64 {
            acc = acc.wrapping_add(i);
        }
        assert!(acc > 0);
        assert!(sum_jiffies(&[me]) > 0, "the running test process should report ticks");
        // A pid that cannot exist contributes nothing rather than panicking.
        assert_eq!(sum_jiffies(&[u32::MAX]), 0);
    }

    #[cfg(any(target_os = "linux", target_os = "windows"))]
    #[test]
    fn sum_rss_counts_a_live_process_and_skips_dead_ones() {
        let me = std::process::id();
        assert!(sum_rss_kib(&[me]) > 0, "the running test process should report RSS");
        assert_eq!(sum_rss_kib(&[u32::MAX]), 0);
    }

    // ── /proc string parsers (pure; run on any OS) ──────────────────────────

    #[test]
    fn parse_cpu_stat_splits_aggregate_and_cores() {
        let stat = "\
cpu  100 20 30 1000 40 5 5 0 0 0
cpu0 60 10 15 500 20 3 2 0 0 0
cpu1 40 10 15 500 20 2 3 0 0 0
intr 12345
ctxt 67890
";
        let (agg, cores) = parse_cpu_stat(stat);
        // total = sum of all columns; busy = total - idle - iowait.
        assert_eq!(agg.total, 100 + 20 + 30 + 1000 + 40 + 5 + 5);
        assert_eq!(agg.busy, agg.total - 1000 - 40);
        assert_eq!(cores.len(), 2);
        assert_eq!(cores[0].total, 60 + 10 + 15 + 500 + 20 + 3 + 2);
        assert_eq!(cores[0].busy, cores[0].total - 500 - 20);
    }

    #[test]
    fn parse_meminfo_reads_selected_keys() {
        let mem = "\
MemTotal:       16308668 kB
MemFree:         1234567 kB
MemAvailable:    9876543 kB
Buffers:          123456 kB
SwapTotal:       2097148 kB
SwapFree:        2000000 kB
";
        let (total, avail, swap_total, swap_free) = parse_meminfo(mem);
        assert_eq!(total, 16_308_668);
        assert_eq!(avail, 9_876_543);
        assert_eq!(swap_total, 2_097_148);
        assert_eq!(swap_free, 2_000_000);
        // A missing key defaults to 0 rather than panicking.
        assert_eq!(parse_meminfo("MemTotal: 42 kB").1, 0);
    }

    #[test]
    fn parse_loadavg_reads_three_floats() {
        assert_eq!(parse_loadavg("0.52 0.58 0.59 1/1234 56789"), [0.52, 0.58, 0.59]);
        // Short/garbage input degrades to zeros.
        assert_eq!(parse_loadavg(""), [0.0, 0.0, 0.0]);
    }

    #[test]
    fn parse_pid_stat_handles_comm_with_spaces_and_parens() {
        // comm = "Web Content" (spaces); a naive whitespace split would misalign
        // every field — parsing must key off the last ')'.
        let line = "1234 (Web (Content)) S 1000 1234 1000 0 -1 4194560 \
100 0 0 0 4200 1300 0 0 20 0 27 0 999 0 0";
        let (comm, state, ppid, cpu, threads) = parse_pid_stat(line).unwrap();
        assert_eq!(comm, "Web (Content)");
        assert_eq!(state, "S");
        assert_eq!(ppid, 1000);
        assert_eq!(cpu, 4200 + 1300); // utime + stime
        assert_eq!(threads, 27);
    }
}
