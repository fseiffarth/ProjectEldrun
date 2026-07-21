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
    /// Owning user's name, resolved from the machine's own passwd database
    /// (`/etc/passwd` locally, `getent passwd` on a remote host) so the pane can
    /// group the process table by user — the same per-user "who's loading the
    /// host" statistic the connect-time usage dialog shows. Empty when the
    /// backend can't resolve an owner (Windows/macOS, an unmapped uid), which the
    /// frontend reads as "no per-user data" and hides the section. An unmapped
    /// uid falls back to `#<uid>` rather than an empty string.
    #[serde(default)]
    pub user: String,
}

/// One interactive login session on the sampled host, from `who`. Mirrors the
/// connect-time remote-usage dialog's `UserSession`: `user` is the login name,
/// `tty` the terminal, `detail` the rest of the `who` line verbatim (login time,
/// origin `(host)`). Populated **only on the remote path** — the local pane never
/// shows the "Logged in" panel, since local sampling is always just this user.
#[derive(Serialize, Clone, Default)]
pub struct LoginSession {
    pub user: String,
    pub tty: String,
    pub detail: String,
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
    /// Every GPU the machine will report memory for; empty when none can be read
    /// (macOS, an Intel-only box, no `nvidia-smi`). See [`crate::gpustat`].
    pub gpus: Vec<crate::gpustat::GpuSample>,
    /// Per-process GPU memory. Populated only on the **remote** path (sampled on
    /// the host alongside the snapshot); the local pane fills it from the dedicated
    /// `gpu_process_snapshot` command instead, so this stays empty locally.
    #[serde(default)]
    pub gpu_procs: Vec<crate::gpustat::GpuProc>,
    /// Whole-package CPU temperature in °C, when a CPU hwmon sensor exposes one
    /// (`coretemp` on Intel, `k10temp`/`zenpower` on AMD Zen). `None` when no such
    /// sensor is present, or on a backend that can't read one (Windows/macOS/other)
    /// — never a fake zero, matching the GPU sensors.
    #[serde(default)]
    pub cpu_temp_c: Option<f64>,
    /// Hottest DIMM temperature in °C, when the board exposes an on-module thermal
    /// sensor (`jc42` on DDR3/DDR4, `spd5118` on DDR5). The *max* across modules, so
    /// it reads as "how hot is memory". `None` when no such sensor is present (most
    /// desktops don't wire one) or the backend can't read one — never a fake zero.
    #[serde(default)]
    pub mem_temp_c: Option<f64>,
    /// Interactive login sessions on the host (from `who`), backing the pane's
    /// "Logged in" panel — the same per-user session view the connect-time
    /// remote-usage dialog shows. Populated only on the **remote** path; empty
    /// locally (the panel is remote-only, since local sampling is always just this
    /// user, so it would be a single trivial row).
    #[serde(default)]
    pub sessions: Vec<LoginSession>,
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
///
/// The GPUs are stapled on here rather than inside each backend: they are read
/// from a different place entirely ([`crate::gpustat`] — DRM sysfs or
/// `nvidia-smi`, both of which have their own per-OS story) and an empty list is
/// a legitimate answer on every platform, including a supported one.
pub fn system_snapshot() -> SystemSnapshot {
    let mut snapshot = platform::system_snapshot();
    snapshot.gpus = crate::gpustat::snapshot();
    snapshot
}

// ── Pure `/proc` parsers ─────────────────────────────────────────────────────
// Factored out of the Linux backend so they can be unit-tested from string
// fixtures without a live `/proc`. Compiled on *every* host OS (not just Linux)
// because `parse_remote_snapshot` reuses them to parse a remote Linux host's
// `/proc` fetched over SSH — the host is Linux even when this machine is not.

/// Parse one `cpu`/`cpuN` line of `/proc/stat` into cumulative busy/total ticks.
/// `total` is the sum of every column; `busy = total − idle − iowait`.
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

/// Parse `getent passwd` / `/etc/passwd` content into a uid → username map. Each
/// line is `name:passwd:uid:gid:gecos:home:shell`; only `name` (field 0) and
/// `uid` (field 2) are read, malformed lines skipped. The *first* name wins when
/// two entries share a uid (a deliberate alias), so the mapping is stable.
fn parse_passwd(content: &str) -> HashMap<u32, String> {
    let mut map: HashMap<u32, String> = HashMap::new();
    for line in content.lines() {
        let mut it = line.split(':');
        let name = it.next().unwrap_or("");
        let _passwd = it.next();
        let Some(uid) = it.next().and_then(|s| s.trim().parse::<u32>().ok()) else {
            continue;
        };
        if !name.is_empty() {
            map.entry(uid).or_insert_with(|| name.to_string());
        }
    }
    map
}

/// Resolve a numeric uid to a display name via a passwd map, falling back to
/// `#<uid>` for a uid the map doesn't cover (an NSS-only account the file walk
/// missed, or a process whose owner was removed) rather than an empty string.
fn username_for(uid: u32, map: &HashMap<u32, String>) -> String {
    map.get(&uid)
        .cloned()
        .unwrap_or_else(|| format!("#{uid}"))
}

/// Parse `who` output into one [`LoginSession`] per non-blank line. Each line is
/// `user  tty  <login-time> (<origin>)`; the first two whitespace fields are the
/// user and tty, everything after is kept verbatim as `detail`. Matches
/// `services::remote_usage::parse_who` so the pane's "Logged in" panel reads
/// identically to the connect-time dialog's.
fn parse_who(content: &str) -> Vec<LoginSession> {
    content
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| {
            let mut parts = l.split_whitespace();
            let user = parts.next()?.to_string();
            let tty = parts.next().unwrap_or("").to_string();
            let detail = parts.collect::<Vec<_>>().join(" ");
            Some(LoginSession { user, tty, detail })
        })
        .collect()
}

/// hwmon `name` values that identify a CPU **package** temperature sensor: Intel
/// exposes `coretemp`, AMD Zen `k10temp` (or the out-of-tree `zenpower`), some
/// ARM/embedded boards `cpu_thermal`. Anything else (a GPU's `amdgpu`, a
/// mainboard SuperIO chip, an NVMe drive) is deliberately excluded — a wrong
/// sensor reported as "CPU" is worse than reporting none.
fn is_cpu_hwmon(name: &str) -> bool {
    matches!(name.trim(), "coretemp" | "k10temp" | "zenpower" | "cpu_thermal")
}

/// hwmon `name` values that identify an on-DIMM **memory** temperature sensor:
/// `jc42` (the JEDEC JC42.4 sensor on DDR3/DDR4 modules) and `spd5118` (the DDR5
/// SPD-hub temperature sensor). One hwmon appears per populated module that has
/// one, so the reader takes the *hottest*. Anything else is excluded — a
/// mainboard/SuperIO channel mislabelled as memory would be worse than none.
fn is_mem_hwmon(name: &str) -> bool {
    matches!(name.trim(), "jc42" | "spd5118")
}

/// Choose the reading that best represents the whole CPU package from one hwmon's
/// temperature channels, each a `(label, milli_celsius)` pair. Prefers an explicit
/// package/control label — `Package id 0` (Intel `coretemp`), `Tctl`/`Tdie` (AMD
/// `k10temp`) — over a per-core channel; failing that, the first channel
/// (`temp1_input`), which is the package on a single-channel sensor. Returns °C
/// (millidegrees ÷ 1000), or `None` when there are no channels.
fn pick_cpu_temp(channels: &[(Option<String>, f64)]) -> Option<f64> {
    let preferred = channels.iter().find(|(label, _)| {
        label.as_deref().is_some_and(|l| {
            let l = l.trim();
            l.starts_with("Package") || l == "Tctl" || l == "Tdie"
        })
    });
    preferred
        .or_else(|| channels.first())
        .map(|(_, milli)| milli / 1000.0)
}

// ── Remote (`ssh`) whole-system snapshot ────────────────────────────────────
// A remote project's System Monitor reads the *host's* `/proc` over the shared
// ControlMaster, exactly as the Disk Usage pane reads the host's `du`. The
// snapshot shape is identical to the local one, so the frontend pane needs no
// per-source branch — only the pure parsers above, fed the host's `/proc` bytes.

/// POSIX-`sh` script run on the host (via `services::ssh_exec::run_remote_script`)
/// to capture one whole-system sample from its `/proc`.
///
/// **Constant** — `run_remote_script` embeds it verbatim (no quoting), so nothing
/// may be interpolated in; the only variable in that call is the `cd`-target
/// `remote_path`, which it quotes and which this script ignores. Output is
/// line-oriented and consumed by [`parse_remote_snapshot`]: a `CLK` line, then the
/// `@SECTION@` blocks carrying the raw kernel files verbatim. `@GPU@` carries the
/// host's GPUs — `NVSMI`/`NVPROC` lines are the `nvidia-smi` CSV verbatim (reusing
/// the same parsers as the local read), and `AMD\t<card>\t<key>\t<value>` lines
/// ship one DRM sysfs file each so `parse_drm_card` runs unchanged on them. The
/// `@WHO@` block carries the host's `who` output verbatim for the pane's "Logged
/// in" panel ([`parse_who`]). The
/// `@PASSWD@` block ships the host's `getent passwd` (or `/etc/passwd`) verbatim so
/// [`parse_passwd`] can map each process's owner uid to a name on the *host's*
/// account database, not this machine's. Under `@PROCS@` comes one `S`/`U`/`R`/`C`
/// quad per process (the raw `/proc/<pid>/stat` line, its owner uid from
/// `/proc/<pid>/status`, its `VmRSS` in KiB, and its NUL-flattened cmdline).
/// cmdline NULs become spaces so every field stays on one line, which is what lets
/// the parser split on line prefixes alone.
pub const REMOTE_SNAPSHOT_SCRIPT: &str = r#"
printf 'CLK\t%s\n' "$(getconf CLK_TCK 2>/dev/null || echo 100)"
printf '@STAT@\n'; cat /proc/stat 2>/dev/null
printf '@MEM@\n'; cat /proc/meminfo 2>/dev/null
printf '@LOAD@\n'; cat /proc/loadavg 2>/dev/null
printf '@UP@\n'; cat /proc/uptime 2>/dev/null
printf '@WHO@\n'; who 2>/dev/null
printf '@GPU@\n'
if command -v nvidia-smi >/dev/null 2>&1; then
  nvidia-smi --query-gpu=name,memory.used,memory.total,utilization.gpu,temperature.gpu,power.draw,power.limit,clocks.sm,clocks.mem,fan.speed,driver_version,pcie.link.gen.current,pcie.link.width.current --format=csv,noheader,nounits 2>/dev/null | sed 's/^/NVSMI\t/'
  nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader,nounits 2>/dev/null | sed 's/^/NVPROC\t/'
fi
for c in /sys/class/drm/card[0-9]*; do
  d="$c/device"
  [ -r "$d/mem_info_vram_total" ] || continue
  i=${c##*/}; i=${i#card}
  h=$(ls -d "$d"/hwmon/hwmon* 2>/dev/null | head -n1)
  printf 'AMD\t%s\tdriver\t%s\n' "$i" "$(sed -n 's/^DRIVER=//p' "$d/uevent" 2>/dev/null)"
  printf 'AMD\t%s\tvendor\t%s\n' "$i" "$(cat "$d/vendor" 2>/dev/null)"
  printf 'AMD\t%s\tdevice\t%s\n' "$i" "$(cat "$d/device" 2>/dev/null)"
  printf 'AMD\t%s\tvram_used\t%s\n' "$i" "$(cat "$d/mem_info_vram_used" 2>/dev/null)"
  printf 'AMD\t%s\tvram_total\t%s\n' "$i" "$(cat "$d/mem_info_vram_total" 2>/dev/null)"
  printf 'AMD\t%s\tgtt_used\t%s\n' "$i" "$(cat "$d/mem_info_gtt_used" 2>/dev/null)"
  printf 'AMD\t%s\tgtt_total\t%s\n' "$i" "$(cat "$d/mem_info_gtt_total" 2>/dev/null)"
  printf 'AMD\t%s\tbusy\t%s\n' "$i" "$(cat "$d/gpu_busy_percent" 2>/dev/null)"
  printf 'AMD\t%s\tsclk\t%s\n' "$i" "$(grep '\*' "$d/pp_dpm_sclk" 2>/dev/null | head -n1)"
  printf 'AMD\t%s\tmclk\t%s\n' "$i" "$(grep '\*' "$d/pp_dpm_mclk" 2>/dev/null | head -n1)"
  printf 'AMD\t%s\tlink_speed\t%s\n' "$i" "$(cat "$d/current_link_speed" 2>/dev/null)"
  printf 'AMD\t%s\tlink_width\t%s\n' "$i" "$(cat "$d/current_link_width" 2>/dev/null)"
  printf 'AMD\t%s\ttemp\t%s\n' "$i" "$(cat "$h/temp1_input" 2>/dev/null)"
  printf 'AMD\t%s\tpower\t%s\n' "$i" "$(cat "$h/power1_average" 2>/dev/null || cat "$h/power1_input" 2>/dev/null)"
  printf 'AMD\t%s\tpower_cap\t%s\n' "$i" "$(cat "$h/power1_cap" 2>/dev/null)"
  printf 'AMD\t%s\tpwm\t%s\n' "$i" "$(cat "$h/pwm1" 2>/dev/null)"
  printf 'AMD\t%s\tpwm_max\t%s\n' "$i" "$(cat "$h/pwm1_max" 2>/dev/null)"
done
printf '@CPUTEMP@\n'
for h in /sys/class/hwmon/hwmon*; do
  n=$(cat "$h/name" 2>/dev/null)
  case "$n" in coretemp|k10temp|zenpower|cpu_thermal) ;; *) continue ;; esac
  for t in "$h"/temp*_input; do
    [ -r "$t" ] || continue
    printf 'T\t%s\t%s\n' "$(cat "${t%_input}_label" 2>/dev/null)" "$(cat "$t" 2>/dev/null)"
  done
done
printf '@MEMTEMP@\n'
for h in /sys/class/hwmon/hwmon*; do
  n=$(cat "$h/name" 2>/dev/null)
  case "$n" in jc42|spd5118) ;; *) continue ;; esac
  printf 'M\t%s\n' "$(cat "$h/temp1_input" 2>/dev/null)"
done
printf '@PASSWD@\n'; getent passwd 2>/dev/null || cat /etc/passwd 2>/dev/null
printf '@PROCS@\n'
for d in /proc/[0-9]*; do
  [ -r "$d/stat" ] || continue
  s=$(cat "$d/stat" 2>/dev/null) || continue
  [ -n "$s" ] || continue
  ru=$(awk '/^Uid:/{u=$2} /^VmRSS:/{r=$2} END{print (u==""?0:u)" "(r==""?0:r)}' "$d/status" 2>/dev/null)
  u=${ru%% *}; r=${ru##* }
  c=$(tr '\0' ' ' < "$d/cmdline" 2>/dev/null)
  printf 'S\t%s\n' "$s"
  printf 'U\t%s\n' "${u:-0}"
  printf 'R\t%s\n' "${r:-0}"
  printf 'C\t%s\n' "$c"
done
"#;

/// Assemble a [`SystemSnapshot`] from the output of [`REMOTE_SNAPSHOT_SCRIPT`],
/// reusing the same pure `/proc` parsers the local Linux backend uses. `supported`
/// is always `true` (the host is assumed Linux; a host with no `/proc` simply
/// yields zeroed CPU/memory and an empty process table). The `@GPU@` block is fed
/// through the very same `gpustat` parsers as the local read, so a host GPU shows
/// with the same memory/sensor detail; `gpu_procs` carries the host's per-process
/// GPU memory (NVIDIA only — the AMD `fdinfo` walk is local-only, too heavy to run
/// per remote poll).
pub fn parse_remote_snapshot(raw: &str) -> SystemSnapshot {
    use std::collections::BTreeMap;
    enum Sec {
        None,
        Stat,
        Mem,
        Load,
        Up,
        Who,
        Gpu,
        CpuTemp,
        MemTemp,
        Passwd,
        Procs,
    }
    let mut sec = Sec::None;
    let mut clk: u64 = 100;
    let mut stat_buf = String::new();
    let mut mem_buf = String::new();
    let mut load_buf = String::new();
    let mut up_buf = String::new();
    let mut who_buf = String::new();
    // The host's passwd db (shipped under @PASSWD@), accumulated then parsed into a
    // uid → name map the instant @PROCS@ starts — fully built before any process
    // line, so `flush` can resolve each owner immediately.
    let mut passwd_buf = String::new();
    let mut uid_to_name: HashMap<u32, String> = HashMap::new();
    let mut processes: Vec<ProcSample> = Vec::new();
    // GPU accumulators: the `nvidia-smi` CSV rebuilt line-by-line for its parsers,
    // and one `DrmFiles` per AMD card index assembled from its shipped sysfs files.
    let mut nvsmi = String::new();
    let mut nvproc = String::new();
    let mut amd_cards: BTreeMap<u32, crate::gpustat::DrmFiles> = BTreeMap::new();
    // CPU hwmon channels shipped as `T\t<label>\t<milli_celsius>` under @CPUTEMP@.
    let mut cpu_temp_channels: Vec<(Option<String>, f64)> = Vec::new();
    // Hottest DIMM temp in °C, from `M\t<milli>` lines under @MEMTEMP@ (one per module).
    let mut mem_temp_c: Option<f64> = None;

    // A process is assembled from its consecutive S/U/R/C lines; `flush` finalizes
    // the pending one when the next `S` arrives (or at end of input).
    let mut p_stat: Option<String> = None;
    let mut p_uid: Option<u32> = None;
    let mut p_rss: u64 = 0;
    let mut p_cmd: Option<String> = None;

    fn flush(
        processes: &mut Vec<ProcSample>,
        p_stat: &mut Option<String>,
        p_uid: &mut Option<u32>,
        p_rss: &mut u64,
        p_cmd: &mut Option<String>,
        uid_to_name: &HashMap<u32, String>,
    ) {
        if let Some(line) = p_stat.take() {
            if let Some((comm, state, ppid, cpu_jiffies, threads)) = parse_pid_stat(&line) {
                // The pid is field 1 of the stat line, before `(comm)`.
                let pid = line
                    .trim_start()
                    .split('(')
                    .next()
                    .and_then(|p| p.trim().parse::<u32>().ok())
                    .unwrap_or(0);
                let cmdline = p_cmd
                    .take()
                    .filter(|c| !c.trim().is_empty())
                    .unwrap_or_else(|| format!("[{comm}]"));
                // An owner uid the host didn't report (unreadable status) leaves the
                // user empty rather than mislabelling it `#0` (root).
                let user = p_uid
                    .take()
                    .map(|uid| username_for(uid, uid_to_name))
                    .unwrap_or_default();
                processes.push(ProcSample {
                    pid,
                    ppid,
                    comm,
                    cmdline,
                    state,
                    rss_kib: *p_rss,
                    cpu_jiffies,
                    threads,
                    user,
                });
            }
        }
        *p_uid = None;
        *p_rss = 0;
        *p_cmd = None;
    }

    for line in raw.lines() {
        match line {
            "@STAT@" => {
                sec = Sec::Stat;
                continue;
            }
            "@MEM@" => {
                sec = Sec::Mem;
                continue;
            }
            "@LOAD@" => {
                sec = Sec::Load;
                continue;
            }
            "@UP@" => {
                sec = Sec::Up;
                continue;
            }
            "@WHO@" => {
                sec = Sec::Who;
                continue;
            }
            "@GPU@" => {
                sec = Sec::Gpu;
                continue;
            }
            "@CPUTEMP@" => {
                sec = Sec::CpuTemp;
                continue;
            }
            "@MEMTEMP@" => {
                sec = Sec::MemTemp;
                continue;
            }
            "@PASSWD@" => {
                sec = Sec::Passwd;
                continue;
            }
            "@PROCS@" => {
                // @PASSWD@ has fully arrived by now (it precedes @PROCS@), so parse
                // it into the uid → name map before the first process line.
                uid_to_name = parse_passwd(&passwd_buf);
                sec = Sec::Procs;
                continue;
            }
            _ => {}
        }
        if let Some(rest) = line.strip_prefix("CLK\t") {
            if let Ok(v) = rest.trim().parse::<u64>() {
                if v > 0 {
                    clk = v;
                }
            }
            continue;
        }
        match sec {
            Sec::Stat => {
                stat_buf.push_str(line);
                stat_buf.push('\n');
            }
            Sec::Mem => {
                mem_buf.push_str(line);
                mem_buf.push('\n');
            }
            Sec::Load => {
                load_buf.push_str(line);
                load_buf.push('\n');
            }
            Sec::Up => {
                up_buf.push_str(line);
                up_buf.push('\n');
            }
            Sec::Who => {
                who_buf.push_str(line);
                who_buf.push('\n');
            }
            Sec::Gpu => {
                if let Some(rest) = line.strip_prefix("NVSMI\t") {
                    nvsmi.push_str(rest);
                    nvsmi.push('\n');
                } else if let Some(rest) = line.strip_prefix("NVPROC\t") {
                    nvproc.push_str(rest);
                    nvproc.push('\n');
                } else if let Some(rest) = line.strip_prefix("AMD\t") {
                    // `<index>\t<key>\t<value>`; an empty value = a file the host
                    // didn't expose, so skip it rather than store a blank.
                    let mut it = rest.splitn(3, '\t');
                    if let (Some(idx), Some(key), Some(val)) = (it.next(), it.next(), it.next()) {
                        if !val.is_empty() {
                            if let Ok(idx) = idx.parse::<u32>() {
                                crate::gpustat::set_drm_field(
                                    amd_cards.entry(idx).or_default(),
                                    key,
                                    val,
                                );
                            }
                        }
                    }
                }
            }
            Sec::CpuTemp => {
                // `T\t<label>\t<milli>`; an empty label ⇒ no `tempN_label` file,
                // an empty/garbage value ⇒ a channel the host couldn't read (skip).
                if let Some(rest) = line.strip_prefix("T\t") {
                    let mut it = rest.splitn(2, '\t');
                    let label = it.next().unwrap_or("").trim();
                    if let Some(milli) = it.next().and_then(|v| v.trim().parse::<f64>().ok()) {
                        let label = (!label.is_empty()).then(|| label.to_string());
                        cpu_temp_channels.push((label, milli));
                    }
                }
            }
            Sec::MemTemp => {
                // `M\t<milli>`; keep the hottest module, skipping blanks/garbage.
                if let Some(rest) = line.strip_prefix("M\t") {
                    if let Ok(milli) = rest.trim().parse::<f64>() {
                        let c = milli / 1000.0;
                        mem_temp_c = Some(mem_temp_c.map_or(c, |h| h.max(c)));
                    }
                }
            }
            Sec::Passwd => {
                passwd_buf.push_str(line);
                passwd_buf.push('\n');
            }
            Sec::Procs => {
                if let Some(rest) = line.strip_prefix("S\t") {
                    flush(
                        &mut processes,
                        &mut p_stat,
                        &mut p_uid,
                        &mut p_rss,
                        &mut p_cmd,
                        &uid_to_name,
                    );
                    p_stat = Some(rest.to_string());
                } else if let Some(rest) = line.strip_prefix("U\t") {
                    p_uid = rest.trim().parse().ok();
                } else if let Some(rest) = line.strip_prefix("R\t") {
                    p_rss = rest.trim().parse().unwrap_or(0);
                } else if let Some(rest) = line.strip_prefix("C\t") {
                    p_cmd = Some(rest.to_string());
                }
            }
            Sec::None => {}
        }
    }
    flush(
        &mut processes,
        &mut p_stat,
        &mut p_uid,
        &mut p_rss,
        &mut p_cmd,
        &uid_to_name,
    );

    let (cpu, per_core) = parse_cpu_stat(&stat_buf);
    let (mem_total_kib, mem_available_kib, swap_total_kib, swap_free_kib) = parse_meminfo(&mem_buf);
    let load_avg = parse_loadavg(&load_buf);
    let uptime_secs = up_buf
        .split_whitespace()
        .next()
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(0.0);

    // AMD cards (via the shared `parse_drm_card`) then NVIDIA (via the shared
    // `parse_nvidia_smi`), so the host reading matches the local one field-for-field.
    let mut gpus: Vec<crate::gpustat::GpuSample> = amd_cards
        .into_iter()
        .filter_map(|(idx, files)| crate::gpustat::parse_drm_card(idx, &files))
        .collect();
    gpus.extend(crate::gpustat::parse_nvidia_smi(&nvsmi));
    let gpu_procs = crate::gpustat::parse_nvidia_apps(&nvproc);
    let cpu_temp_c = pick_cpu_temp(&cpu_temp_channels);
    let sessions = parse_who(&who_buf);

    SystemSnapshot {
        supported: true,
        clk_tck: clk,
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
        gpus,
        gpu_procs,
        cpu_temp_c,
        mem_temp_c,
        sessions,
    }
}

// ── Pure Windows decoders (compiled under test on any OS) ───────────────────
// Factored out of the Windows backend so they can be unit-tested from byte
// fixtures without a live Win32 (pattern: the `/proc` parsers above).

/// Byte size of one `SYSTEM_PROCESSOR_PERFORMANCE_INFORMATION` entry as
/// returned by `NtQuerySystemInformation` class 8: five LARGE_INTEGER times
/// (Idle, Kernel, User, Dpc, Interrupt) + ULONG InterruptCount + padding.
#[cfg(any(target_os = "windows", test))]
const PROCESSOR_PERF_ENTRY_BYTES: usize = 48;

/// Parse the raw buffer written by `NtQuerySystemInformation(8, …)` into one
/// [`CpuTimes`] per processor. KernelTime INCLUDES IdleTime (same convention as
/// `GetSystemTimes`), so `total = kernel + user` and `busy = total − idle`. A
/// trailing partial entry is ignored; negative times (never expected) clamp to 0.
#[cfg(any(target_os = "windows", test))]
fn parse_processor_perf_buffer(buf: &[u8]) -> Vec<CpuTimes> {
    buf.chunks_exact(PROCESSOR_PERF_ENTRY_BYTES)
        .map(|chunk| {
            let time = |off: usize| {
                i64::from_le_bytes(chunk[off..off + 8].try_into().unwrap()).max(0) as u64
            };
            let (idle, kernel, user) = (time(0), time(8), time(16));
            let total = kernel + user;
            CpuTimes {
                busy: total.saturating_sub(idle),
                total,
            }
        })
        .collect()
}

/// Decode a NUL-terminated ANSI `CHAR` buffer (a `PROCESSENTRY32.szExeFile`,
/// or a macOS `proc_bsdinfo.pbi_comm`) into a `String`, lossily for non-UTF-8
/// bytes.
#[cfg(any(target_os = "windows", target_os = "macos", test))]
fn decode_ansi_nul(raw: &[i8]) -> String {
    let bytes: Vec<u8> = raw
        .iter()
        .take_while(|&&c| c != 0)
        .map(|&c| c as u8)
        .collect();
    String::from_utf8_lossy(&bytes).into_owned()
}

// ── Pure macOS decoders (compiled under test on any OS) ─────────────────────

/// Convert the flat tick array written by `host_processor_info`
/// (`PROCESSOR_CPU_LOAD_INFO`: 4 cumulative `u32` tick counters per core, in
/// CPU_STATE order user/system/idle/nice) into one [`CpuTimes`] per core, with
/// ticks scaled to nanoseconds (`ns_per_tick = 1e9 / clk_tck`). The macOS
/// "tick" unit for per-PROCESS times is already nanoseconds (`clk_tck()` is
/// 1e9), so machine times MUST be converted to ns too — the frontend divides
/// per-process by machine deltas and the units have to match. `busy` is
/// user+system+nice; `total` adds idle. A trailing partial chunk is ignored.
#[cfg(any(target_os = "macos", test))]
fn parse_host_processor_ticks(ticks: &[u32], ns_per_tick: u64) -> Vec<CpuTimes> {
    const CPU_STATE_USER: usize = 0;
    const CPU_STATE_SYSTEM: usize = 1;
    const CPU_STATE_IDLE: usize = 2;
    const CPU_STATE_NICE: usize = 3;
    ticks
        .chunks_exact(4)
        .map(|c| {
            let busy = (c[CPU_STATE_USER] as u64
                + c[CPU_STATE_SYSTEM] as u64
                + c[CPU_STATE_NICE] as u64)
                * ns_per_tick;
            CpuTimes {
                busy,
                total: busy + c[CPU_STATE_IDLE] as u64 * ns_per_tick,
            }
        })
        .collect()
}

/// Map a BSD `pbi_status` process state to the Linux-style single letter the
/// monitor pane already renders: SRUN→R, SSLEEP→S, SSTOP→T, SZOMB→Z (SIDL→I;
/// anything unknown → empty).
#[cfg(any(target_os = "macos", test))]
fn bsd_process_state(status: u32) -> String {
    match status {
        1 => "I", // SIDL — process being created
        2 => "R", // SRUN
        3 => "S", // SSLEEP
        4 => "T", // SSTOP
        5 => "Z", // SZOMB
        _ => "",
    }
    .to_string()
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

    /// Whole-package CPU temperature in °C from the first CPU hwmon that exposes
    /// one, or `None`. Scans `/sys/class/hwmon/hwmon*`, matches the sensor by its
    /// `name` ([`super::is_cpu_hwmon`]), reads every `tempN_input` with its optional
    /// `tempN_label`, and lets [`super::pick_cpu_temp`] choose the package channel.
    /// No tool spawn and no root — the same cheap sysfs read the GPU sensors use.
    pub fn cpu_temp_c() -> Option<f64> {
        for entry in fs::read_dir("/sys/class/hwmon").ok()?.flatten() {
            let base = entry.path();
            let name = fs::read_to_string(base.join("name")).unwrap_or_default();
            if !super::is_cpu_hwmon(&name) {
                continue;
            }
            let mut channels: Vec<(Option<String>, f64)> = Vec::new();
            for i in 1..=32u32 {
                let Ok(raw) = fs::read_to_string(base.join(format!("temp{i}_input"))) else {
                    continue;
                };
                let Ok(milli) = raw.trim().parse::<f64>() else {
                    continue;
                };
                let label = fs::read_to_string(base.join(format!("temp{i}_label")))
                    .ok()
                    .map(|s| s.trim().to_string());
                channels.push((label, milli));
            }
            if let Some(t) = super::pick_cpu_temp(&channels) {
                return Some(t);
            }
        }
        None
    }

    /// Hottest DIMM temperature in °C across every on-module memory sensor
    /// (`jc42`/`spd5118`, one hwmon per populated module), or `None` when the board
    /// exposes none. `temp1_input` is the module's only channel. Same cheap sysfs
    /// read the CPU/GPU sensors use — no tool spawn, no root.
    pub fn mem_temp_c() -> Option<f64> {
        let mut hottest: Option<f64> = None;
        for entry in fs::read_dir("/sys/class/hwmon").ok()?.flatten() {
            let base = entry.path();
            let name = fs::read_to_string(base.join("name")).unwrap_or_default();
            if !super::is_mem_hwmon(&name) {
                continue;
            }
            let Ok(raw) = fs::read_to_string(base.join("temp1_input")) else {
                continue;
            };
            let Ok(milli) = raw.trim().parse::<f64>() else {
                continue;
            };
            let c = milli / 1000.0;
            hottest = Some(hottest.map_or(c, |h| h.max(c)));
        }
        hottest
    }

    /// Whole-system sample from `/proc`: aggregate + per-core CPU, memory/swap,
    /// load, uptime, and every process (one `/proc/<pid>/{stat,status,cmdline}`
    /// read each). Kernel threads (empty `cmdline`) fall back to `[comm]`.
    pub fn system_snapshot() -> super::SystemSnapshot {
        use super::{ProcSample, SystemSnapshot};
        use std::os::unix::fs::MetadataExt;

        // Resolve each process's owner uid to a name via the machine's own
        // `/etc/passwd`, read once. NSS-only accounts (LDAP/SSSD) the file walk
        // misses fall back to `#<uid>` in `username_for` — the remote path uses
        // `getent`, which is NSS-aware, so this file read is the local-only gap.
        let passwd = super::parse_passwd(&fs::read_to_string("/etc/passwd").unwrap_or_default());

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
                // The process's owner is the uid owning its `/proc/<pid>` dir.
                let user = fs::metadata(format!("/proc/{pid}"))
                    .map(|m| super::username_for(m.uid(), &passwd))
                    .unwrap_or_default();
                processes.push(ProcSample {
                    pid,
                    ppid,
                    comm,
                    cmdline,
                    state,
                    rss_kib: rss_kib(pid).unwrap_or(0),
                    cpu_jiffies,
                    threads,
                    user,
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
            gpus: Vec::new(), // filled by `system_snapshot()`, not by this backend
            gpu_procs: Vec::new(),
            cpu_temp_c: cpu_temp_c(),
            mem_temp_c: mem_temp_c(),
            sessions: Vec::new(), // remote-only (the pane's "Logged in" panel)
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

    /// Per-core cumulative CPU times via `NtQuerySystemInformation` class 8
    /// (`SystemProcessorPerformanceInformation`). The windows crate does not
    /// bind this ntdll call, so it is declared manually; a failed query
    /// degrades to an empty per-core list (the pane then shows only the
    /// aggregate bar). The raw buffer decode is the pure, unit-tested
    /// [`super::parse_processor_perf_buffer`].
    fn query_per_core_times() -> Vec<super::CpuTimes> {
        #[link(name = "ntdll")]
        extern "system" {
            fn NtQuerySystemInformation(
                class: u32,
                info: *mut core::ffi::c_void,
                len: u32,
                return_len: *mut u32,
            ) -> i32;
        }
        const SYSTEM_PROCESSOR_PERFORMANCE_INFORMATION: u32 = 8;
        // 64 KiB holds > 1300 processors at 48 bytes each.
        let mut buf = vec![0u8; 64 * 1024];
        let mut ret_len: u32 = 0;
        // SAFETY: the buffer length is passed exactly; ntdll writes at most
        // that many bytes and reports how many in `ret_len`, which bounds the
        // parse below. A non-zero NTSTATUS means nothing was written.
        let status = unsafe {
            NtQuerySystemInformation(
                SYSTEM_PROCESSOR_PERFORMANCE_INFORMATION,
                buf.as_mut_ptr() as *mut core::ffi::c_void,
                buf.len() as u32,
                &mut ret_len,
            )
        };
        if status != 0 {
            return Vec::new();
        }
        buf.truncate((ret_len as usize).min(buf.len()));
        super::parse_processor_perf_buffer(&buf)
    }

    /// Whole-system sample via Win32: `GetSystemTimes` (aggregate CPU; kernel
    /// time INCLUDES idle, so total = kernel+user and busy = total−idle),
    /// ntdll per-core times, `GlobalMemoryStatusEx` (swap ≈ pagefile −
    /// physical, both counters include RAM), `GetTickCount64` uptime, and one
    /// ToolHelp walk for the process table. Windows has no load average, so
    /// `load_avg` stays `[0.0; 3]` and the pane hides it. All CPU counters are
    /// 100-ns units to match `proc_ticks`/`clk_tck` — the frontend divides
    /// per-process ticks by machine ticks, so the units MUST agree.
    pub fn system_snapshot() -> super::SystemSnapshot {
        use super::{CpuTimes, ProcSample, SystemSnapshot};
        use windows::Win32::System::SystemInformation::{
            GetSystemInfo, GetTickCount64, GlobalMemoryStatusEx, MEMORYSTATUSEX, SYSTEM_INFO,
        };
        use windows::Win32::System::Threading::GetSystemTimes;

        let mut idle = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        // SAFETY: three valid FILETIME out-params, written on success only.
        let cpu = if unsafe {
            GetSystemTimes(
                Some(&mut idle as *mut _),
                Some(&mut kernel as *mut _),
                Some(&mut user as *mut _),
            )
        }
        .is_ok()
        {
            let total = filetime_units(kernel) + filetime_units(user);
            CpuTimes {
                busy: total.saturating_sub(filetime_units(idle)),
                total,
            }
        } else {
            CpuTimes::default()
        };

        let per_core = query_per_core_times();

        let mut mem = MEMORYSTATUSEX {
            dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
            ..Default::default()
        };
        // SAFETY: `mem` is valid and its dwLength is set as the API requires.
        let (mem_total_kib, mem_available_kib, swap_total_kib, swap_free_kib) =
            if unsafe { GlobalMemoryStatusEx(&mut mem) }.is_ok() {
                (
                    mem.ullTotalPhys / 1024,
                    mem.ullAvailPhys / 1024,
                    mem.ullTotalPageFile.saturating_sub(mem.ullTotalPhys) / 1024,
                    mem.ullAvailPageFile.saturating_sub(mem.ullAvailPhys) / 1024,
                )
            } else {
                (0, 0, 0, 0)
            };

        let num_cores = {
            let mut info = SYSTEM_INFO::default();
            // SAFETY: plain out-param write into a valid SYSTEM_INFO.
            unsafe { GetSystemInfo(&mut info) };
            info.dwNumberOfProcessors
        };

        // SAFETY: no arguments; returns milliseconds since boot.
        let uptime_secs = unsafe { GetTickCount64() } as f64 / 1000.0;

        // One ToolHelp walk for identity fields (pid/ppid/name/threads), then
        // per-pid CPU/RSS queries. A pid we cannot open (system/elevated)
        // keeps its identity row with zeroed usage, matching the Linux
        // behavior of unreadable /proc entries as closely as possible.
        let mut processes = Vec::new();
        // SAFETY: snapshot is closed before returning; the entry is fully
        // initialized (dwSize set) before Process32First reads it.
        unsafe {
            if let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) {
                let mut entry = PROCESSENTRY32 {
                    dwSize: std::mem::size_of::<PROCESSENTRY32>() as u32,
                    ..Default::default()
                };
                if Process32First(snapshot, &mut entry).is_ok() {
                    loop {
                        let pid = entry.th32ProcessID;
                        let comm = super::decode_ansi_nul(&entry.szExeFile);
                        processes.push(ProcSample {
                            pid,
                            ppid: entry.th32ParentProcessID,
                            cmdline: format!("[{comm}]"),
                            comm,
                            state: String::new(),
                            rss_kib: rss_kib(pid).unwrap_or(0),
                            cpu_jiffies: proc_ticks(pid).unwrap_or(0),
                            threads: entry.cntThreads,
                            // No cheap per-process owner lookup here; the pane hides
                            // the per-user section when no process reports one.
                            user: String::new(),
                        });
                        if Process32Next(snapshot, &mut entry).is_err() {
                            break;
                        }
                    }
                }
                let _ = CloseHandle(snapshot);
            }
        }

        SystemSnapshot {
            supported: true,
            clk_tck: clk_tck(),
            num_cores,
            cpu,
            per_core,
            mem_total_kib,
            mem_available_kib,
            swap_total_kib,
            swap_free_kib,
            load_avg: [0.0; 3],
            uptime_secs,
            processes,
            gpus: Vec::new(), // filled by `system_snapshot()`, not by this backend
            gpu_procs: Vec::new(),
            cpu_temp_c: None, // no cheap CPU thermal read on this backend
            mem_temp_c: None, // nor a memory thermal read
            sessions: Vec::new(), // remote-only (the pane's "Logged in" panel)
        }
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

    // ── whole-system snapshot (mach host FFI) ───────────────────────────────
    //
    // The mach host calls below are not in the `libc` crate, so they are
    // declared manually (same raw-FFI pattern as the libproc calls above; all
    // live in the always-linked libSystem).

    extern "C" {
        fn mach_host_self() -> u32;
        fn host_processor_info(
            host: u32,
            flavor: i32,
            out_processor_count: *mut u32,
            out_processor_info: *mut *mut u32,
            out_processor_info_count: *mut u32,
        ) -> i32;
        fn host_statistics64(host: u32, flavor: i32, info: *mut i32, count: *mut u32) -> i32;
        fn vm_deallocate(task: u32, address: usize, size: usize) -> i32;
        static mach_task_self_: u32;
    }

    /// `PROCESSOR_CPU_LOAD_INFO`.
    const CPU_LOAD_INFO: i32 = 2;
    /// `HOST_VM_INFO64`.
    const HOST_VM_INFO64: i32 = 4;
    /// sysctl MIB names (numeric so no reliance on libc exposing each const).
    const CTL_KERN: i32 = 1;
    const KERN_BOOTTIME: i32 = 21;
    const CTL_VM: i32 = 2;
    const VM_SWAPUSAGE: i32 = 5;
    const CTL_HW: i32 = 6;
    const HW_MEMSIZE: i32 = 24;

    /// The head of `struct vm_statistics64` — only the leading fixed-width
    /// counters this module reads. `host_statistics64` copies out at most the
    /// count we pass, so declaring a prefix is sound (the kernel truncates to
    /// the caller's count; it never writes past it).
    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    struct VmStatistics64Head {
        free_count: u32,
        active_count: u32,
        inactive_count: u32,
        wire_count: u32,
    }

    /// Generic fixed-size sysctl read. `None` when the kernel rejects the MIB
    /// or writes a different size than expected.
    fn sysctl_read<T>(mib: &mut [i32]) -> Option<T> {
        // SAFETY: every T used here is a plain-old-data sysctl out-struct
        // (u64 / libc::timeval / libc::xsw_usage), for which an all-zero bit
        // pattern is a valid value; sysctl writes at most `len` bytes into it
        // and updates `len`, and the result is used only when the kernel
        // reported writing the full struct.
        unsafe {
            let mut out: T = std::mem::zeroed();
            let mut len = std::mem::size_of::<T>();
            let rc = libc::sysctl(
                mib.as_mut_ptr(),
                mib.len() as u32,
                &mut out as *mut T as *mut libc::c_void,
                &mut len,
                std::ptr::null_mut(),
                0,
            );
            (rc == 0 && len == std::mem::size_of::<T>()).then_some(out)
        }
    }

    /// Per-core cumulative CPU times in nanoseconds, via `host_processor_info`.
    /// Failure degrades to an empty per-core list. The raw tick decode is the
    /// pure, unit-tested [`super::parse_host_processor_ticks`].
    fn per_core_times(ns_per_tick: u64) -> Vec<super::CpuTimes> {
        let mut cpu_count: u32 = 0;
        let mut info: *mut u32 = std::ptr::null_mut();
        let mut info_count: u32 = 0;
        // SAFETY: all three out-params are valid; on KERN_SUCCESS the kernel
        // vm_allocates `info` (info_count u32s), which we copy out of and then
        // vm_deallocate exactly once with the byte size it reported.
        unsafe {
            let rc = host_processor_info(
                mach_host_self(),
                CPU_LOAD_INFO,
                &mut cpu_count,
                &mut info,
                &mut info_count,
            );
            if rc != 0 || info.is_null() {
                return Vec::new();
            }
            let ticks = std::slice::from_raw_parts(info, info_count as usize).to_vec();
            let _ = vm_deallocate(
                mach_task_self_,
                info as usize,
                info_count as usize * std::mem::size_of::<u32>(),
            );
            super::parse_host_processor_ticks(&ticks, ns_per_tick)
        }
    }

    /// Whole-system sample via mach/sysctl/libproc. All CPU counters are in
    /// nanoseconds to match `proc_ticks`/`clk_tck` (1e9) — the frontend
    /// divides per-process by machine deltas, so the units MUST agree; the
    /// host tick counters are converted via `1e9 / _SC_CLK_TCK`.
    ///
    /// Visibility caveat: unprivileged `proc_pidinfo` only inspects the
    /// calling user's processes, so other users' (and most system) processes
    /// appear without CPU/RSS detail — they are skipped entirely rather than
    /// listed as zero rows (TODO 31c).
    pub fn system_snapshot() -> super::SystemSnapshot {
        use super::{ProcSample, SystemSnapshot};

        // SAFETY: sysconf takes no pointers.
        let clk = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
        let ns_per_tick = if clk > 0 { 1_000_000_000 / clk as u64 } else { 10_000_000 };

        let per_core = per_core_times(ns_per_tick);
        let cpu = super::CpuTimes {
            busy: per_core.iter().map(|c| c.busy).sum(),
            total: per_core.iter().map(|c| c.total).sum(),
        };

        let mem_total_kib = sysctl_read::<u64>(&mut [CTL_HW, HW_MEMSIZE])
            .map(|bytes| bytes / 1024)
            .unwrap_or(0);
        // SAFETY: sysconf takes no pointers.
        let page_kib = {
            let ps = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
            if ps > 0 { ps as u64 / 1024 } else { 4 }
        };
        let mem_available_kib = {
            let mut head = VmStatistics64Head::default();
            let mut count = (std::mem::size_of::<VmStatistics64Head>()
                / std::mem::size_of::<i32>()) as u32;
            // SAFETY: `head` is a valid prefix buffer and `count` is its exact
            // size in integer_t units; the kernel copies out at most `count`.
            let rc = unsafe {
                host_statistics64(
                    mach_host_self(),
                    HOST_VM_INFO64,
                    &mut head as *mut VmStatistics64Head as *mut i32,
                    &mut count,
                )
            };
            if rc == 0 {
                // free + inactive ≈ reclaimable, the usual "available" proxy.
                (head.free_count as u64 + head.inactive_count as u64) * page_kib
            } else {
                0
            }
        };

        let (swap_total_kib, swap_free_kib) =
            sysctl_read::<libc::xsw_usage>(&mut [CTL_VM, VM_SWAPUSAGE])
                .map(|xsw| (xsw.xsu_total / 1024, xsw.xsu_avail / 1024))
                .unwrap_or((0, 0));

        let mut load_avg = [0.0f64; 3];
        // SAFETY: getloadavg writes at most 3 doubles into the array.
        unsafe {
            let _ = libc::getloadavg(load_avg.as_mut_ptr(), 3);
        }

        let uptime_secs = sysctl_read::<libc::timeval>(&mut [CTL_KERN, KERN_BOOTTIME])
            .map(|boot| {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs() as i64;
                (now - boot.tv_sec).max(0) as f64
            })
            .unwrap_or(0.0);

        // Process table: pids we can't inspect (other users, most system
        // daemons — see the visibility caveat above) are skipped.
        let mut processes = Vec::new();
        for pid in all_pids() {
            let Some(task) = task_info(pid) else {
                continue;
            };
            let Some(bsd) = bsd_info(pid) else {
                continue;
            };
            let comm = super::decode_ansi_nul(&bsd.pbi_comm);
            processes.push(ProcSample {
                pid,
                ppid: bsd.pbi_ppid,
                cmdline: format!("[{comm}]"),
                comm,
                state: super::bsd_process_state(bsd.pbi_status),
                rss_kib: task.pti_resident_size / 1024,
                cpu_jiffies: task.pti_total_user.wrapping_add(task.pti_total_system),
                threads: task.pti_threadnum.max(0) as u32,
                // Owner name isn't resolved here (only the calling user's processes
                // are visible anyway); the pane hides the per-user section when no
                // process reports one.
                user: String::new(),
            });
        }

        SystemSnapshot {
            supported: true,
            clk_tck: clk_tck(), // 1e9 — everything above is in ns
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
            gpus: Vec::new(), // filled by `system_snapshot()`, not by this backend
            gpu_procs: Vec::new(),
            cpu_temp_c: None, // no cheap CPU thermal read on this backend
            mem_temp_c: None, // nor a memory thermal read
            sessions: Vec::new(), // remote-only (the pane's "Logged in" panel)
        }
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
    fn is_cpu_hwmon_matches_only_cpu_sensors() {
        assert!(is_cpu_hwmon("coretemp"));
        assert!(is_cpu_hwmon("k10temp"));
        assert!(is_cpu_hwmon("zenpower"));
        assert!(is_cpu_hwmon("cpu_thermal\n"), "trailing newline is trimmed");
        assert!(!is_cpu_hwmon("amdgpu"), "a GPU sensor is not the CPU");
        assert!(!is_cpu_hwmon("nvme"));
        assert!(!is_cpu_hwmon(""));
    }

    #[test]
    fn pick_cpu_temp_prefers_package_channel() {
        // Intel coretemp: `Package id 0` wins over the per-core channels.
        let intel = vec![
            (Some("Core 0".to_string()), 45000.0),
            (Some("Package id 0".to_string()), 52000.0),
            (Some("Core 1".to_string()), 47000.0),
        ];
        assert_eq!(pick_cpu_temp(&intel), Some(52.0));

        // AMD k10temp: `Tctl` wins over `Tccd1`.
        let amd = vec![
            (Some("Tccd1".to_string()), 58000.0),
            (Some("Tctl".to_string()), 61000.0),
        ];
        assert_eq!(pick_cpu_temp(&amd), Some(61.0));

        // No labels at all: fall back to the first channel (temp1_input).
        let bare = vec![(None, 40000.0), (None, 99000.0)];
        assert_eq!(pick_cpu_temp(&bare), Some(40.0));

        // No channels: unknown, never a fake zero.
        assert_eq!(pick_cpu_temp(&[]), None);
    }

    #[test]
    fn remote_snapshot_reads_cpu_temp() {
        let raw = "\
CLK\t100
@STAT@
cpu  1 2 3 4 5 6 7 8
@CPUTEMP@
T\tCore 0\t45000
T\tPackage id 0\t53000
@PROCS@
";
        let snap = parse_remote_snapshot(raw);
        assert_eq!(snap.cpu_temp_c, Some(53.0), "host package temp is surfaced");
    }

    #[test]
    fn is_mem_hwmon_matches_only_dimm_sensors() {
        assert!(is_mem_hwmon("jc42"), "DDR3/DDR4 on-module sensor");
        assert!(is_mem_hwmon("spd5118\n"), "DDR5 SPD hub, newline trimmed");
        assert!(!is_mem_hwmon("coretemp"), "a CPU sensor is not memory");
        assert!(!is_mem_hwmon("amdgpu"));
        assert!(!is_mem_hwmon(""));
    }

    #[test]
    fn remote_snapshot_reads_hottest_dimm_temp() {
        let raw = "\
CLK\t100
@STAT@
cpu  1 2 3 4 5 6 7 8
@MEMTEMP@
M\t41000
M\t46500
M\t44000
@PROCS@
";
        let snap = parse_remote_snapshot(raw);
        assert_eq!(snap.mem_temp_c, Some(46.5), "hottest module wins");
    }

    #[test]
    fn remote_snapshot_has_no_mem_temp_when_section_empty() {
        let raw = "CLK\t100\n@STAT@\ncpu  1 2 3 4 5 6 7 8\n@MEMTEMP@\n@PROCS@\n";
        assert_eq!(parse_remote_snapshot(raw).mem_temp_c, None);
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

    // ── Windows byte decoders (pure; run on any OS) ─────────────────────────

    /// Build one 48-byte SYSTEM_PROCESSOR_PERFORMANCE_INFORMATION entry.
    fn perf_entry(idle: i64, kernel: i64, user: i64) -> Vec<u8> {
        let mut out = Vec::with_capacity(PROCESSOR_PERF_ENTRY_BYTES);
        for v in [idle, kernel, user, 0i64, 0i64] {
            out.extend_from_slice(&v.to_le_bytes());
        }
        out.extend_from_slice(&[0u8; 8]); // InterruptCount + padding
        out
    }

    #[test]
    fn parse_processor_perf_buffer_derives_busy_and_total() {
        let mut buf = perf_entry(1_000, 1_500, 300); // kernel includes idle
        buf.extend(perf_entry(0, 200, 100));
        let cores = parse_processor_perf_buffer(&buf);
        assert_eq!(cores.len(), 2);
        assert_eq!(cores[0].total, 1_800);
        assert_eq!(cores[0].busy, 800); // (kernel − idle) + user
        assert_eq!(cores[1].total, 300);
        assert_eq!(cores[1].busy, 300);
    }

    #[test]
    fn parse_processor_perf_buffer_ignores_partial_tail_and_clamps() {
        // A short trailing chunk (returned length mid-entry) is dropped, and a
        // negative time (corrupt input) clamps to 0 instead of wrapping.
        let mut buf = perf_entry(-5, -10, 40);
        buf.extend_from_slice(&[0u8; 20]);
        let cores = parse_processor_perf_buffer(&buf);
        assert_eq!(cores.len(), 1);
        assert_eq!(cores[0].total, 40);
        assert_eq!(cores[0].busy, 40);
        assert!(parse_processor_perf_buffer(&[]).is_empty());
    }

    #[test]
    fn decode_ansi_nul_stops_at_nul_and_is_lossy() {
        let mut raw = [0i8; 16];
        for (i, b) in b"explorer.exe".iter().enumerate() {
            raw[i] = *b as i8;
        }
        raw[13] = b'x' as i8; // garbage after the NUL must be ignored
        assert_eq!(decode_ansi_nul(&raw), "explorer.exe");
        assert_eq!(decode_ansi_nul(&[-28, 0]), "\u{fffd}"); // lone 0xE4 byte
        assert_eq!(decode_ansi_nul(&[]), "");
    }

    // ── macOS decoders (pure; run on any OS) ────────────────────────────────

    #[test]
    fn parse_host_processor_ticks_scales_to_ns_and_sums_busy() {
        // Two cores, CPU_STATE order user/system/idle/nice, clk_tck=100 →
        // ns_per_tick = 10_000_000.
        let ticks = [100u32, 50, 800, 10, 0, 0, 1000, 0];
        let cores = parse_host_processor_ticks(&ticks, 10_000_000);
        assert_eq!(cores.len(), 2);
        assert_eq!(cores[0].busy, (100 + 50 + 10) * 10_000_000);
        assert_eq!(cores[0].total, (100 + 50 + 10 + 800) * 10_000_000);
        assert_eq!(cores[1].busy, 0);
        assert_eq!(cores[1].total, 1000 * 10_000_000);
    }

    #[test]
    fn parse_host_processor_ticks_ignores_partial_tail() {
        // A truncated final chunk (interrupted copy-out) is dropped, and huge
        // cumulative counters don't overflow at ns scale within u64.
        let cores = parse_host_processor_ticks(&[u32::MAX, 0, u32::MAX, 0, 7, 7], 10_000_000);
        assert_eq!(cores.len(), 1);
        assert_eq!(cores[0].busy, u32::MAX as u64 * 10_000_000);
        assert!(parse_host_processor_ticks(&[1, 2, 3], 1).is_empty());
    }

    #[test]
    fn bsd_process_state_maps_to_linux_letters() {
        assert_eq!(bsd_process_state(2), "R"); // SRUN
        assert_eq!(bsd_process_state(3), "S"); // SSLEEP
        assert_eq!(bsd_process_state(4), "T"); // SSTOP
        assert_eq!(bsd_process_state(5), "Z"); // SZOMB
        assert_eq!(bsd_process_state(1), "I"); // SIDL
        assert_eq!(bsd_process_state(0), "");
        assert_eq!(bsd_process_state(99), "");
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

    #[test]
    fn parse_remote_snapshot_assembles_from_script_output() {
        // A minimal but complete capture in the wire format REMOTE_SNAPSHOT_SCRIPT
        // emits: a CLK line, `@SECTION@` blocks of raw kernel files (incl. `who`),
        // then S/R/C triples per process. One core, 8 GiB RAM, two processes — one
        // with a real cmdline, one kernel thread (empty cmdline → `[comm]` fallback).
        let raw = "CLK\t100\n\
@STAT@\n\
cpu  100 0 50 800 0 0 0 0 0 0\n\
cpu0 100 0 50 800 0 0 0 0 0 0\n\
intr 12345\n\
@MEM@\n\
MemTotal:        8192000 kB\n\
MemAvailable:    4096000 kB\n\
SwapTotal:       2048000 kB\n\
SwapFree:        2048000 kB\n\
@LOAD@\n\
0.50 0.40 0.30 1/234 5678\n\
@UP@\n\
123456.78 987654.32\n\
@WHO@\n\
alice    pts/0        2026-07-18 09:12 (203.0.113.5)\n\
alice    pts/1        2026-07-18 09:20 (203.0.113.5)\n\
bob      tty1         2026-07-17 22:03\n\
@PROCS@\n\
S\t42 (bash) S 1 42 42 0 -1 4194304 100 0 0 0 12 8 0 0 20 0 3 0 999 0 0\n\
R\t2048\n\
C\t/usr/bin/bash -i\n\
S\t7 (kworker/0:1) I 2 0 0 0 -1 69238880 0 0 0 0 5 2 0 0 20 0 1 0 50 0 0\n\
R\t0\n\
C\t\n";

        let snap = parse_remote_snapshot(raw);
        assert!(snap.supported);
        assert_eq!(snap.clk_tck, 100);
        assert_eq!(snap.num_cores, 1);
        assert_eq!(snap.per_core.len(), 1);
        // total = sum of all columns; busy = total − idle − iowait (800 idle here).
        assert_eq!(snap.cpu.total, 100 + 50 + 800);
        assert_eq!(snap.cpu.busy, 150);
        assert_eq!(snap.mem_total_kib, 8_192_000);
        assert_eq!(snap.mem_available_kib, 4_096_000);
        assert_eq!(snap.swap_total_kib, 2_048_000);
        assert_eq!(snap.load_avg, [0.50, 0.40, 0.30]);
        assert_eq!(snap.uptime_secs as u64, 123_456);
        assert!(snap.gpus.is_empty());

        assert_eq!(snap.processes.len(), 2);
        let bash = &snap.processes[0];
        assert_eq!(bash.pid, 42);
        assert_eq!(bash.ppid, 1);
        assert_eq!(bash.comm, "bash");
        assert_eq!(bash.state, "S");
        assert_eq!(bash.rss_kib, 2048);
        assert_eq!(bash.cpu_jiffies, 12 + 8);
        assert_eq!(bash.threads, 3);
        assert_eq!(bash.cmdline, "/usr/bin/bash -i");
        // Kernel thread: empty cmdline falls back to `[comm]`.
        let kworker = &snap.processes[1];
        assert_eq!(kworker.pid, 7);
        assert_eq!(kworker.rss_kib, 0);
        assert_eq!(kworker.cmdline, "[kworker/0:1]");

        // `who` → login sessions for the "Logged in" panel: three sessions across
        // two users, the tail of each line kept verbatim as `detail`.
        assert_eq!(snap.sessions.len(), 3);
        assert_eq!(snap.sessions[0].user, "alice");
        assert_eq!(snap.sessions[0].tty, "pts/0");
        assert!(snap.sessions[0].detail.contains("203.0.113.5"));
        assert_eq!(snap.sessions[2].user, "bob");
        assert_eq!(snap.sessions[2].tty, "tty1");
    }

    #[test]
    fn parse_passwd_maps_uid_to_name() {
        let content = "\
root:x:0:0:root:/root:/bin/bash
alice:x:1000:1000:Alice:/home/alice:/bin/bash
bob:x:1001:1001::/home/bob:/bin/zsh
# a comment line is skipped
malformed-no-uid
daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin
";
        let map = parse_passwd(content);
        assert_eq!(map.get(&0).map(String::as_str), Some("root"));
        assert_eq!(map.get(&1000).map(String::as_str), Some("alice"));
        assert_eq!(map.get(&1001).map(String::as_str), Some("bob"));
        assert_eq!(map.get(&1).map(String::as_str), Some("daemon"));
        // A known uid resolves to its name; an unknown one falls back to `#<uid>`.
        assert_eq!(username_for(1000, &map), "alice");
        assert_eq!(username_for(4242, &map), "#4242");
    }

    #[test]
    fn parse_remote_snapshot_resolves_process_owner() {
        // The @PASSWD@ block feeds the uid→name map; each process's `U` line names
        // its owner uid, resolved against that map (an unmapped uid → `#<uid>`).
        let raw = "CLK\t100\n\
@PASSWD@\n\
root:x:0:0:root:/root:/bin/bash\n\
alice:x:1000:1000:Alice:/home/alice:/bin/bash\n\
@PROCS@\n\
S\t42 (bash) S 1 42 42 0 -1 4194304 100 0 0 0 12 8 0 0 20 0 3 0 999 0 0\n\
U\t1000\n\
R\t2048\n\
C\t/usr/bin/bash -i\n\
S\t1 (systemd) S 0 1 1 0 -1 4194560 200 0 0 0 5 5 0 0 20 0 1 0 5 0 0\n\
U\t0\n\
R\t4096\n\
C\t/sbin/init\n\
S\t99 (weird) S 1 99 99 0 -1 4194304 1 0 0 0 1 1 0 0 20 0 1 0 100 0 0\n\
U\t7777\n\
R\t128\n\
C\tweird\n";

        let snap = parse_remote_snapshot(raw);
        assert_eq!(snap.processes.len(), 3);
        assert_eq!(snap.processes[0].user, "alice");
        assert_eq!(snap.processes[1].user, "root");
        // An owner uid with no passwd entry falls back to `#<uid>`.
        assert_eq!(snap.processes[2].user, "#7777");
    }

    #[test]
    fn parse_remote_snapshot_reads_the_gpu_section() {
        // The `@GPU@` wire format: an AMD card shipped file-by-file, an NVIDIA card
        // as raw nvidia-smi CSV, and one NVIDIA compute process. A blank AMD value
        // (a file the host didn't expose) must be skipped, not stored.
        let raw = "CLK\t100\n\
@GPU@\n\
NVSMI\tNVIDIA RTX A4000, 2048, 16376, 55, 63, 90.0, 140, 1800, 7000, 44, 550.90.07, 4, 16\n\
NVPROC\t4321, python, 1536\n\
AMD\t1\tdriver\tamdgpu\n\
AMD\t1\tvendor\t0x1002\n\
AMD\t1\tvram_used\t440770560\n\
AMD\t1\tvram_total\t536870912\n\
AMD\t1\tgtt_used\t18052190208\n\
AMD\t1\tgtt_total\t65855619072\n\
AMD\t1\tbusy\t72\n\
AMD\t1\ttemp\t58000\n\
AMD\t1\tsclk\t2: 2900Mhz *\n\
AMD\t1\tlink_speed\t\n\
@PROCS@\n";

        let snap = parse_remote_snapshot(raw);
        assert_eq!(snap.gpus.len(), 2, "one AMD card + one NVIDIA card");

        // AMD card comes first (built from the shipped sysfs files).
        let amd = &snap.gpus[0];
        assert_eq!(amd.driver, "amdgpu");
        assert_eq!(amd.vram_total, 536_870_912);
        assert_eq!(amd.shared_total, 65_855_619_072);
        assert_eq!(amd.busy_percent, Some(72.0));
        assert_eq!(amd.temp_c, Some(58.0));
        assert_eq!(amd.sclk_mhz, Some(2900));
        assert_eq!(amd.pcie_gen, None, "a blank link_speed line was skipped");

        // NVIDIA card, parsed by the same CSV reader as the local path.
        let nv = &snap.gpus[1];
        assert_eq!(nv.driver, "nvidia");
        assert_eq!(nv.temp_c, Some(63.0));
        assert_eq!(nv.power_w, Some(90.0));
        assert_eq!(nv.driver_version.as_deref(), Some("550.90.07"));

        assert_eq!(snap.gpu_procs.len(), 1);
        assert_eq!(snap.gpu_procs[0].pid, 4321);
        assert_eq!(snap.gpu_procs[0].mem_bytes, 1536 * 1024 * 1024);
    }
}
