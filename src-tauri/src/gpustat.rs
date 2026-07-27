//! Whole-system GPU memory sampling for the GPU readouts (header, system
//! monitor, local-model menu).
//!
//! This is the *device's* memory, not one process's share of it: the number that
//! answers "how much GPU memory is left before I load a model?". Ollama's own
//! `/api/ps` figure (`commands::ollama::total_vram_in_use`) remains a line in the
//! breakdown, no longer the whole reading.
//!
//! A GPU's memory comes in **two pools** and both are reported, because on an
//! integrated GPU only one of them is real: the dedicated **VRAM** carve-out
//! (typically 512 MB on an APU — the framebuffer, and permanently ~full, so
//! reading it alone says nothing) and the **shared** pool the driver maps out of
//! system RAM (`GTT` on amdgpu — where a model actually lands). On a discrete
//! card the shared pool is ~0 and the combined figure collapses to plain device
//! VRAM. Callers sum the two; this module keeps them apart so the UI can show the
//! split.
//!
//! Sources, in the order they are tried:
//! - **DRM sysfs** (Linux): `/sys/class/drm/card*/device/mem_info_*` +
//!   `gpu_busy_percent`. Plain file reads — no tool, no root, cheap enough to
//!   poll. Exposed by `amdgpu`; Intel's `i915` does not expose it (its memory
//!   accounting lives behind root-only debugfs), so an Intel-only box reports no
//!   GPU memory rather than a wrong one.
//! - **`nvidia-smi`** (Linux + Windows): the only portable read of NVIDIA memory.
//!   A process spawn, so its absence is remembered ([`NVIDIA_RETRY`]) instead of
//!   being paid for on every poll.
//! - Anything else (macOS, unknown drivers) samples nothing and the UI falls back
//!   to the Ollama figure.

use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// One GPU's memory (and utilization, when the driver reports it).
///
/// `vram_*` is dedicated device memory; `shared_*` is system memory mapped for
/// the GPU (amdgpu's GTT), which is `0` on a discrete card. `busy_percent` is
/// `None` when the driver won't say — distinct from `Some(0.0)`, an idle GPU.
///
/// The trailing scalars are the *sensor* readings — temperature, power, clocks,
/// fan, PCIe link and driver version — each `None` when the driver or platform
/// won't report it (an APU exposes no `power1_cap`, a laptop's `nvidia-smi`
/// answers `[N/A]` in power-saving). They come from the *same* cheap sysfs /
/// `nvidia-smi` read as the memory figures, so every surface that already samples
/// a GPU gets them for free. Per-**process** GPU usage is deliberately *not* here:
/// it is a separate, heavier walk ([`process_snapshot`]) only the monitor pane pays
/// for, so the always-visible header readout stays cheap.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct GpuSample {
    pub name: String,
    pub driver: String,
    pub vram_used: u64,
    pub vram_total: u64,
    pub shared_used: u64,
    pub shared_total: u64,
    pub busy_percent: Option<f64>,
    /// Edge/core temperature, °C.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temp_c: Option<f64>,
    /// Instantaneous board power draw, watts.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub power_w: Option<f64>,
    /// Board power limit/cap, watts — the ceiling `power_w` is measured against.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub power_cap_w: Option<f64>,
    /// Core (shader) clock, MHz.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sclk_mhz: Option<u64>,
    /// Memory clock, MHz.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mclk_mhz: Option<u64>,
    /// Fan speed as 0–100% of its range (not RPM).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fan_percent: Option<f64>,
    /// Kernel/driver version string (`nvidia-smi` only; amdgpu exposes none per-card).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub driver_version: Option<String>,
    /// Current PCIe link generation (1–5) and lane width (e.g. 16).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pcie_gen: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pcie_width: Option<u32>,
}

/// One process's share of GPU memory, for the monitor pane's per-process list.
///
/// A *gauge* (bytes resident on the GPU right now), not a cumulative counter, so
/// it needs no delta between samples — unlike engine-time utilization, which is
/// why this carries memory only. `name` is the process's `comm` (Linux) or the
/// `process_name` `nvidia-smi` reports.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct GpuProc {
    pub pid: u32,
    pub name: String,
    pub mem_bytes: u64,
}

/// Upper bound on cache reuse. Three surfaces poll this independently (header,
/// monitor pane, model menu); without the cache a `nvidia-smi` spawn would be
/// paid three times over per tick.
const CACHE_TTL: Duration = Duration::from_millis(1000);

/// How long a missing `nvidia-smi` is believed. Long enough that the common case
/// (no NVIDIA GPU) costs one failed spawn rather than one per poll, short enough
/// that installing the driver doesn't require an app restart to be noticed.
const NVIDIA_RETRY: Duration = Duration::from_secs(60);

static CACHE: Mutex<Option<(Instant, Vec<GpuSample>)>> = Mutex::new(None);
static NVIDIA_MISSING_UNTIL: Mutex<Option<Instant>> = Mutex::new(None);

/// Every GPU this machine will talk about, memoized for [`CACHE_TTL`]. Returns an
/// empty vec (never an error) on a platform or driver we can't read, so callers
/// treat "no GPU information" as a display fallback rather than a failure.
pub fn snapshot() -> Vec<GpuSample> {
    if let Some((at, gpus)) = CACHE.lock().ok().and_then(|c| c.clone()) {
        if at.elapsed() < CACHE_TTL {
            return gpus;
        }
    }

    let gpus = sample();
    if let Ok(mut cache) = CACHE.lock() {
        *cache = Some((Instant::now(), gpus.clone()));
    }
    gpus
}

/// The two sources are disjoint by construction, so there is nothing to
/// de-duplicate: [`drm_sample`] only keeps cards that expose `mem_info_*` (i.e.
/// `amdgpu`), and the proprietary NVIDIA driver exposes none — its cards come
/// from `nvidia-smi` alone.
fn sample() -> Vec<GpuSample> {
    let mut gpus = drm_sample();
    gpus.extend(nvidia_sample());
    gpus
}

// ── DRM sysfs (Linux) ────────────────────────────────────────────────────────

/// The sysfs files backing one DRM card, read as strings. Split out from the
/// filesystem walk so [`parse_drm_card`] stays pure and testable on a machine
/// with no such GPU (i.e. CI).
/// The sysfs files backing one DRM card, read as strings. `pub(crate)` — the
/// remote-snapshot parser in [`crate::sysstat`] rebuilds one of these from the
/// host's files (shipped over SSH) and runs it through the same [`parse_drm_card`],
/// so the local and host AMD readings share one code path.
#[derive(Default)]
pub(crate) struct DrmFiles {
    driver: String,
    vendor: String,
    device: String,
    vram_used: Option<String>,
    vram_total: Option<String>,
    gtt_used: Option<String>,
    gtt_total: Option<String>,
    busy: Option<String>,
    // Sensor reads. `temp`/`power`/`power_cap` come from the card's hwmon subdir
    // (millidegrees / microwatts); `pwm`/`pwm_max` give a fan percent; `sclk`/`mclk`
    // are the `pp_dpm_*` clock tables (the active state is flagged `*`); the two
    // `link_*` files describe the current PCIe link.
    temp: Option<String>,
    power: Option<String>,
    power_cap: Option<String>,
    pwm: Option<String>,
    pwm_max: Option<String>,
    sclk: Option<String>,
    mclk: Option<String>,
    link_speed: Option<String>,
    link_width: Option<String>,
}

fn parse_u64(s: Option<&String>) -> u64 {
    s.and_then(|v| v.trim().parse::<u64>().ok()).unwrap_or(0)
}

/// A hwmon millidegree/milliunit reading (`temp1_input` is °C×1000) as its base unit.
fn parse_milli(s: Option<&String>) -> Option<f64> {
    s.and_then(|v| v.trim().parse::<f64>().ok())
        .map(|m| m / 1000.0)
}

/// A hwmon micro-unit reading (`power1_average` is watts×1e6) as its base unit.
fn parse_micro(s: Option<&String>) -> Option<f64> {
    s.and_then(|v| v.trim().parse::<f64>().ok())
        .map(|m| m / 1_000_000.0)
}

/// Fan speed as 0–100% from a raw `pwm1` (0–`pwm1_max`, default 255) reading.
fn parse_pwm_percent(pwm: Option<&String>, max: Option<&String>) -> Option<f64> {
    let pwm = pwm.and_then(|v| v.trim().parse::<f64>().ok())?;
    let max = max
        .and_then(|m| m.trim().parse::<f64>().ok())
        .filter(|m| *m > 0.0)
        .unwrap_or(255.0);
    Some((pwm / max * 100.0).clamp(0.0, 100.0))
}

/// amdgpu's `pp_dpm_sclk`/`pp_dpm_mclk` list every DPM state, one per line
/// (`1: 1000Mhz *`), with the **active** one flagged `*`. Returns its MHz.
fn parse_active_clock_mhz(s: Option<&String>) -> Option<u64> {
    let line = s?.lines().find(|l| l.contains('*'))?;
    line.split_whitespace().find_map(|tok| {
        tok.to_ascii_lowercase()
            .strip_suffix("mhz")
            .and_then(|n| n.parse::<u64>().ok())
    })
}

/// PCIe generation from a `current_link_speed` string (`"16.0 GT/s PCIe"`),
/// mapping the transfer rate to the gen that introduced it.
fn pcie_gen_from_speed(s: Option<&String>) -> Option<u32> {
    let gts = s?.split_whitespace().next()?.parse::<f64>().ok()?;
    Some(if gts >= 32.0 {
        5
    } else if gts >= 16.0 {
        4
    } else if gts >= 8.0 {
        3
    } else if gts >= 5.0 {
        2
    } else {
        1
    })
}

/// A card is only reported when it states a **VRAM total**: that is the marker
/// that this driver does memory accounting at all. Without it (Intel `i915`, the
/// NVIDIA blob) every byte figure would be a zero pretending to be a measurement.
/// Set one [`DrmFiles`] field by its sysfs basename, for the remote parser that
/// receives the host's files as `key`/`value` pairs. An empty `value` (a file the
/// host didn't have) is the caller's cue to skip, so this is only handed real ones.
pub(crate) fn set_drm_field(files: &mut DrmFiles, key: &str, value: &str) {
    let owned = || Some(value.to_string());
    match key {
        "driver" => files.driver = value.to_string(),
        "vendor" => files.vendor = value.to_string(),
        "device" => files.device = value.to_string(),
        "vram_used" => files.vram_used = owned(),
        "vram_total" => files.vram_total = owned(),
        "gtt_used" => files.gtt_used = owned(),
        "gtt_total" => files.gtt_total = owned(),
        "busy" => files.busy = owned(),
        "temp" => files.temp = owned(),
        "power" => files.power = owned(),
        "power_cap" => files.power_cap = owned(),
        "pwm" => files.pwm = owned(),
        "pwm_max" => files.pwm_max = owned(),
        "sclk" => files.sclk = owned(),
        "mclk" => files.mclk = owned(),
        "link_speed" => files.link_speed = owned(),
        "link_width" => files.link_width = owned(),
        _ => {}
    }
}

pub(crate) fn parse_drm_card(index: u32, files: &DrmFiles) -> Option<GpuSample> {
    let vram_total = parse_u64(files.vram_total.as_ref());
    if vram_total == 0 {
        return None;
    }

    Some(GpuSample {
        name: gpu_name(&files.vendor, &files.device, index),
        driver: files.driver.clone(),
        vram_used: parse_u64(files.vram_used.as_ref()),
        vram_total,
        shared_used: parse_u64(files.gtt_used.as_ref()),
        shared_total: parse_u64(files.gtt_total.as_ref()),
        busy_percent: files
            .busy
            .as_ref()
            .and_then(|b| b.trim().parse::<f64>().ok()),
        temp_c: parse_milli(files.temp.as_ref()),
        power_w: parse_micro(files.power.as_ref()),
        power_cap_w: parse_micro(files.power_cap.as_ref()),
        sclk_mhz: parse_active_clock_mhz(files.sclk.as_ref()),
        mclk_mhz: parse_active_clock_mhz(files.mclk.as_ref()),
        fan_percent: parse_pwm_percent(files.pwm.as_ref(), files.pwm_max.as_ref()),
        // amdgpu exposes no clean per-card driver version in sysfs; leave it unset
        // rather than surface the kernel release, which isn't the GPU driver.
        driver_version: None,
        pcie_gen: pcie_gen_from_speed(files.link_speed.as_ref()),
        pcie_width: files
            .link_width
            .as_ref()
            .and_then(|w| w.trim().parse::<u32>().ok()),
    })
}

#[cfg(target_os = "linux")]
fn drm_sample() -> Vec<GpuSample> {
    use std::fs;

    let Ok(entries) = fs::read_dir("/sys/class/drm") else {
        return Vec::new();
    };

    let mut cards: Vec<(u32, GpuSample)> = Vec::new();
    for entry in entries.flatten() {
        // Only whole cards ("card1"), not their connectors ("card1-DP-1").
        let name = entry.file_name();
        let Some(index) = name
            .to_str()
            .and_then(|n| n.strip_prefix("card"))
            .and_then(|n| n.parse::<u32>().ok())
        else {
            continue;
        };

        let dev = entry.path().join("device");
        let read = |file: &str| fs::read_to_string(dev.join(file)).ok();
        // Temperature/power/fan live under the card's hwmon instance, whose index
        // isn't stable (`hwmon/hwmonN`), so take the first one the card exposes.
        let hwmon = fs::read_dir(dev.join("hwmon")).ok().and_then(|it| {
            it.flatten()
                .map(|e| e.path())
                .find(|p| {
                    p.file_name()
                        .and_then(|n| n.to_str())
                        .is_some_and(|n| n.starts_with("hwmon"))
                })
        });
        let hread = |file: &str| {
            hwmon
                .as_ref()
                .and_then(|h| fs::read_to_string(h.join(file)).ok())
        };
        let files = DrmFiles {
            driver: read("uevent")
                .and_then(|u| {
                    u.lines()
                        .find_map(|l| l.strip_prefix("DRIVER=").map(str::to_string))
                })
                .unwrap_or_default(),
            vendor: read("vendor").unwrap_or_default().trim().to_string(),
            device: read("device").unwrap_or_default().trim().to_string(),
            vram_used: read("mem_info_vram_used"),
            vram_total: read("mem_info_vram_total"),
            gtt_used: read("mem_info_gtt_used"),
            gtt_total: read("mem_info_gtt_total"),
            busy: read("gpu_busy_percent"),
            // `power1_average` is the smoothed draw; some cards only expose the
            // instantaneous `power1_input`, so fall back to it.
            temp: hread("temp1_input"),
            power: hread("power1_average").or_else(|| hread("power1_input")),
            power_cap: hread("power1_cap"),
            pwm: hread("pwm1"),
            pwm_max: hread("pwm1_max"),
            sclk: read("pp_dpm_sclk"),
            mclk: read("pp_dpm_mclk"),
            link_speed: read("current_link_speed"),
            link_width: read("current_link_width"),
        };

        if let Some(sample) = parse_drm_card(index, &files) {
            cards.push((index, sample));
        }
    }

    cards.sort_by_key(|(index, _)| *index);
    cards.into_iter().map(|(_, sample)| sample).collect()
}

#[cfg(not(target_os = "linux"))]
fn drm_sample() -> Vec<GpuSample> {
    Vec::new()
}

// ── Card naming ──────────────────────────────────────────────────────────────

/// Memo for [`gpu_name`], keyed `"vendor:device"`. `pci.ids` is ~1.5 MB; without
/// this it would be re-scanned on every cache miss, i.e. once a second.
static NAME_CACHE: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

/// Where a Linux system keeps the PCI vendor/device name database. Sysfs carries
/// only the numeric ids, so this is the only way to say "Radeon 890M" rather than
/// "AMD GPU 1" — and it is a nicety, so its absence is not an error.
const PCI_IDS_PATHS: [&str; 3] = [
    "/usr/share/hwdata/pci.ids",
    "/usr/share/misc/pci.ids",
    "/usr/share/pci.ids",
];

/// A human name for a card: its marketing name from `pci.ids` when that database
/// is installed, otherwise the vendor plus the DRM card index.
fn gpu_name(vendor: &str, device: &str, index: u32) -> String {
    let vendor_id = strip_hex(vendor);
    let device_id = strip_hex(device);
    let fallback = || match vendor_label(&vendor_id) {
        Some(vendor) => format!("{vendor} GPU {index}"),
        None => format!("GPU {index}"),
    };

    if vendor_id.is_empty() || device_id.is_empty() {
        return fallback();
    }

    let key = format!("{vendor_id}:{device_id}");
    let Ok(mut cache) = NAME_CACHE.lock() else {
        return fallback();
    };
    let names = cache.get_or_insert_with(HashMap::new);
    if let Some(hit) = names.get(&key) {
        return hit.clone();
    }

    let name = PCI_IDS_PATHS
        .iter()
        .find_map(|path| std::fs::read_to_string(path).ok())
        .and_then(|db| pci_ids_lookup(&db, &vendor_id, &device_id))
        .unwrap_or_else(fallback);
    names.insert(key, name.clone());
    name
}

/// Sysfs writes ids as `0x1002`; `pci.ids` indexes them as `1002`.
fn strip_hex(id: &str) -> String {
    id.trim()
        .trim_start_matches("0x")
        .to_ascii_lowercase()
        .to_string()
}

fn vendor_label(vendor_id: &str) -> Option<&'static str> {
    match vendor_id {
        "1002" => Some("AMD"),
        "10de" => Some("NVIDIA"),
        "8086" => Some("Intel"),
        _ => None,
    }
}

/// Find a device's name in a `pci.ids` database. The format is indentation-scoped:
/// a vendor at column 0, its devices one tab in, their subsystems two tabs in —
/// so a device line only means anything *under* the right vendor, and the
/// two-tab lines must be skipped rather than matched.
fn pci_ids_lookup(db: &str, vendor_id: &str, device_id: &str) -> Option<String> {
    let mut in_vendor = false;
    for line in db.lines() {
        if line.starts_with('#') || line.trim().is_empty() {
            continue;
        }
        if !line.starts_with('\t') {
            if in_vendor {
                return None; // Left our vendor's block without a match.
            }
            in_vendor = line
                .split_whitespace()
                .next()
                .is_some_and(|id| id.eq_ignore_ascii_case(vendor_id));
            continue;
        }
        if !in_vendor || line.starts_with("\t\t") {
            continue; // Another vendor's device, or a subsystem line.
        }
        let mut parts = line.trim_start().splitn(2, char::is_whitespace);
        if parts
            .next()
            .is_some_and(|id| id.eq_ignore_ascii_case(device_id))
        {
            let name = parts.next().unwrap_or_default().trim();
            if !name.is_empty() {
                return Some(name.to_string());
            }
        }
    }
    None
}

// ── nvidia-smi (Linux + Windows) ─────────────────────────────────────────────

fn nvidia_sample() -> Vec<GpuSample> {
    if let Ok(missing_until) = NVIDIA_MISSING_UNTIL.lock() {
        if missing_until.is_some_and(|until| Instant::now() < until) {
            return Vec::new();
        }
    }

    let output = crate::paths::command_no_window("nvidia-smi")
        .args([
            "--query-gpu=name,memory.used,memory.total,utilization.gpu,\
temperature.gpu,power.draw,power.limit,clocks.sm,clocks.mem,fan.speed,\
driver_version,pcie.link.gen.current,pcie.link.width.current",
            "--format=csv,noheader,nounits",
        ])
        .output();

    match output {
        Ok(out) if out.status.success() => {
            parse_nvidia_smi(&String::from_utf8_lossy(&out.stdout))
        }
        _ => {
            if let Ok(mut missing_until) = NVIDIA_MISSING_UNTIL.lock() {
                *missing_until = Some(Instant::now() + NVIDIA_RETRY);
            }
            Vec::new()
        }
    }
}

/// A `nvidia-smi` CSV field, or `None` when it is absent/blank or the `[N/A]` the
/// tool prints for a value the driver won't answer (a laptop GPU in power-saving,
/// a passthrough VM) — so an unreadable sensor is *unknown*, never a zero.
fn nv_field<'a>(fields: &[&'a str], i: usize) -> Option<&'a str> {
    fields
        .get(i)
        .map(|s| s.trim())
        .filter(|s| !s.is_empty() && !s.starts_with("[N/A") && *s != "N/A")
}

/// Parse the `nvidia-smi --query-gpu=…` line (see the query in [`nvidia_sample`]):
/// one comma-separated record per GPU, memory in **MiB**, clocks in MHz, power in
/// W, temperature in °C, fan and utilization in %. Column order is fixed by the
/// query; a driver too old for a trailing column simply omits it, so every field
/// past the memory triple is read defensively by index.
pub(crate) fn parse_nvidia_smi(stdout: &str) -> Vec<GpuSample> {
    const MIB: u64 = 1024 * 1024;

    stdout
        .lines()
        .filter_map(|line| {
            let fields: Vec<&str> = line.split(',').map(str::trim).collect();
            if fields.len() < 3 {
                return None;
            }
            let vram_total = fields[2].parse::<u64>().ok()? * MIB;
            let f64_at = |i| nv_field(&fields, i).and_then(|s| s.parse::<f64>().ok());
            let u64_at = |i| nv_field(&fields, i).and_then(|s| s.parse::<u64>().ok());
            let u32_at = |i| nv_field(&fields, i).and_then(|s| s.parse::<u32>().ok());
            Some(GpuSample {
                name: fields[0].to_string(),
                driver: "nvidia".to_string(),
                vram_used: fields[1].parse::<u64>().unwrap_or(0) * MIB,
                vram_total,
                shared_used: 0,
                shared_total: 0,
                busy_percent: f64_at(3),
                temp_c: f64_at(4),
                power_w: f64_at(5),
                power_cap_w: f64_at(6),
                sclk_mhz: u64_at(7),
                mclk_mhz: u64_at(8),
                fan_percent: f64_at(9),
                driver_version: nv_field(&fields, 10).map(str::to_string),
                pcie_gen: u32_at(11),
                pcie_width: u32_at(12),
            })
        })
        .collect()
}

// ── Per-process GPU memory (monitor pane only) ───────────────────────────────

/// Per-process GPU memory, cached for [`CACHE_TTL`] so the pane's poll and any
/// repeat caller share one walk. Deliberately *not* folded into [`snapshot`]: the
/// work here (all of `/proc`'s `fdinfo`, or a `nvidia-smi` spawn) is heavier than
/// the whole-device read, and only the monitor pane asks for it.
static PROC_CACHE: Mutex<Option<(Instant, Vec<GpuProc>)>> = Mutex::new(None);

/// Every process currently holding GPU memory, biggest first. Empty (never an
/// error) when nothing can be read — a driver that reports no per-process data,
/// or a non-Linux/no-`nvidia-smi` box — so the UI treats it as "not available".
pub fn process_snapshot() -> Vec<GpuProc> {
    if let Some((at, procs)) = PROC_CACHE.lock().ok().and_then(|c| c.clone()) {
        if at.elapsed() < CACHE_TTL {
            return procs;
        }
    }

    let mut procs = amd_fdinfo_procs();
    procs.extend(nvidia_proc_sample());
    procs.sort_by(|a, b| b.mem_bytes.cmp(&a.mem_bytes));

    if let Ok(mut cache) = PROC_CACHE.lock() {
        *cache = Some((Instant::now(), procs.clone()));
    }
    procs
}

/// NVIDIA's compute clients (`--query-compute-apps`), memory in **MiB**. Only the
/// compute context is listed — a pure-graphics process won't appear — which is the
/// portable, driver-agnostic read; the fuller `pmon` needs elevated access.
fn nvidia_proc_sample() -> Vec<GpuProc> {
    if let Ok(missing_until) = NVIDIA_MISSING_UNTIL.lock() {
        if missing_until.is_some_and(|until| Instant::now() < until) {
            return Vec::new();
        }
    }

    let output = crate::paths::command_no_window("nvidia-smi")
        .args([
            "--query-compute-apps=pid,process_name,used_memory",
            "--format=csv,noheader,nounits",
        ])
        .output();

    match output {
        Ok(out) if out.status.success() => parse_nvidia_apps(&String::from_utf8_lossy(&out.stdout)),
        _ => Vec::new(),
    }
}

/// Parse `nvidia-smi --query-compute-apps=pid,process_name,used_memory
/// --format=csv,noheader,nounits`: one `pid, name, MiB` line per client.
pub(crate) fn parse_nvidia_apps(stdout: &str) -> Vec<GpuProc> {
    const MIB: u64 = 1024 * 1024;

    stdout
        .lines()
        .filter_map(|line| {
            let f: Vec<&str> = line.split(',').map(str::trim).collect();
            if f.len() < 3 {
                return None;
            }
            let pid = f[0].parse::<u32>().ok()?;
            let mem = nv_field(&f, 2)
                .and_then(|s| s.parse::<u64>().ok())
                .unwrap_or(0)
                * MIB;
            Some(GpuProc {
                pid,
                name: f[1].to_string(),
                mem_bytes: mem,
            })
        })
        .collect()
}

/// One amdgpu `fdinfo` file's relevant fields. A process opens the card through
/// many fds, but the fds of one rendering context share a `drm-client-id`, so the
/// caller dedups on it to avoid counting the same memory once per fd.
#[derive(Default)]
struct FdInfo {
    driver: String,
    client_id: Option<u64>,
    vram_kib: u64,
    gtt_kib: u64,
}

/// Parse a `/proc/<pid>/fdinfo/<fd>` file. Returns `None` for a non-DRM fd (a
/// socket, a plain file) — one with no `drm-driver` line.
fn parse_fdinfo(text: &str) -> Option<FdInfo> {
    let mut info = FdInfo::default();
    for line in text.lines() {
        if let Some(v) = line.strip_prefix("drm-driver:") {
            info.driver = v.trim().to_string();
        } else if let Some(v) = line.strip_prefix("drm-client-id:") {
            info.client_id = v.trim().parse::<u64>().ok();
        } else if let Some(v) = line.strip_prefix("drm-memory-vram:") {
            info.vram_kib = parse_kib(v);
        } else if let Some(v) = line.strip_prefix("drm-memory-gtt:") {
            info.gtt_kib = parse_kib(v);
        }
    }
    if info.driver.is_empty() {
        return None;
    }
    Some(info)
}

/// A `drm-memory-*` value, e.g. `"\t12345 KiB"`, as KiB.
fn parse_kib(v: &str) -> u64 {
    v.split_whitespace()
        .next()
        .and_then(|n| n.parse::<u64>().ok())
        .unwrap_or(0)
}

#[cfg(target_os = "linux")]
fn amd_fdinfo_procs() -> Vec<GpuProc> {
    use std::collections::HashSet;
    use std::fs;

    let Ok(entries) = fs::read_dir("/proc") else {
        return Vec::new();
    };

    let mut by_pid: HashMap<u32, u64> = HashMap::new();
    let mut names: HashMap<u32, String> = HashMap::new();
    // Dedup a context's memory across its many fds, machine-wide.
    let mut seen: HashSet<(u32, u64)> = HashSet::new();

    for entry in entries.flatten() {
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|n| n.parse::<u32>().ok())
        else {
            continue;
        };
        let Ok(fds) = fs::read_dir(entry.path().join("fdinfo")) else {
            continue;
        };

        let mut pid_bytes: u64 = 0;
        let mut matched = false;
        for fd in fds.flatten() {
            let Ok(text) = fs::read_to_string(fd.path()) else {
                continue;
            };
            let Some(info) = parse_fdinfo(&text) else {
                continue;
            };
            if info.driver != "amdgpu" {
                continue;
            }
            matched = true;
            // A fd with no client-id (rare on modern amdgpu) dedups per-pid, i.e.
            // is counted once — undercounting is the safer error than double.
            if !seen.insert((pid, info.client_id.unwrap_or(u64::MAX))) {
                continue;
            }
            pid_bytes += (info.vram_kib + info.gtt_kib) * 1024;
        }

        if matched && pid_bytes > 0 {
            by_pid.insert(pid, pid_bytes);
            names.insert(pid, proc_comm(pid));
        }
    }

    by_pid
        .into_iter()
        .map(|(pid, mem_bytes)| GpuProc {
            pid,
            name: names.remove(&pid).unwrap_or_default(),
            mem_bytes,
        })
        .collect()
}

#[cfg(not(target_os = "linux"))]
fn amd_fdinfo_procs() -> Vec<GpuProc> {
    Vec::new()
}

#[cfg(target_os = "linux")]
fn proc_comm(pid: u32) -> String {
    std::fs::read_to_string(format!("/proc/{pid}/comm"))
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn files(pairs: &[(&str, &str)]) -> DrmFiles {
        let get = |key: &str| {
            pairs
                .iter()
                .find(|(k, _)| *k == key)
                .map(|(_, v)| v.to_string())
        };
        DrmFiles {
            driver: get("driver").unwrap_or_default(),
            vendor: get("vendor").unwrap_or_default(),
            device: get("device").unwrap_or_default(),
            vram_used: get("vram_used"),
            vram_total: get("vram_total"),
            gtt_used: get("gtt_used"),
            gtt_total: get("gtt_total"),
            busy: get("busy"),
            temp: get("temp"),
            power: get("power"),
            power_cap: get("power_cap"),
            pwm: get("pwm"),
            pwm_max: get("pwm_max"),
            sclk: get("sclk"),
            mclk: get("mclk"),
            link_speed: get("link_speed"),
            link_width: get("link_width"),
        }
    }

    #[test]
    fn amdgpu_apu_reports_both_pools() {
        let sample = parse_drm_card(
            1,
            &files(&[
                ("driver", "amdgpu"),
                ("vendor", "0x1002"),
                ("device", "0x150e"),
                ("vram_used", "440770560\n"),
                ("vram_total", "536870912\n"),
                ("gtt_used", "18052190208\n"),
                ("gtt_total", "65855619072\n"),
                ("busy", "95\n"),
            ]),
        )
        .expect("a card exposing mem_info_vram_total is reported");

        assert_eq!(sample.driver, "amdgpu");
        assert_eq!(sample.vram_used, 440_770_560);
        assert_eq!(sample.vram_total, 536_870_912);
        assert_eq!(sample.shared_used, 18_052_190_208);
        assert_eq!(sample.shared_total, 65_855_619_072);
        assert_eq!(sample.busy_percent, Some(95.0));
    }

    #[test]
    fn card_without_memory_accounting_is_skipped() {
        // Intel i915 / the NVIDIA blob: a DRM card with no `mem_info_*` at all.
        // Reporting it would mean showing 0 B of 0 B as if it were a measurement.
        assert!(parse_drm_card(0, &files(&[("driver", "i915"), ("vendor", "0x8086")])).is_none());
    }

    #[test]
    fn drm_busy_absent_is_none_not_zero() {
        let sample = parse_drm_card(
            0,
            &files(&[
                ("driver", "amdgpu"),
                ("vram_used", "1024"),
                ("vram_total", "2048"),
            ]),
        )
        .expect("memory alone is enough to report a card");
        assert_eq!(sample.busy_percent, None, "unknown utilization is not idle");
        assert_eq!(sample.shared_total, 0, "a card with no GTT files has none");
    }

    #[test]
    fn nvidia_dgpu_has_no_shared_pool() {
        let gpus = parse_nvidia_smi("NVIDIA GeForce RTX 4090, 1234, 24564, 37\n");
        assert_eq!(gpus.len(), 1);
        assert_eq!(gpus[0].name, "NVIDIA GeForce RTX 4090");
        assert_eq!(gpus[0].driver, "nvidia");
        assert_eq!(gpus[0].vram_used, 1234 * 1024 * 1024);
        assert_eq!(gpus[0].vram_total, 24564 * 1024 * 1024);
        assert_eq!(gpus[0].shared_used, 0);
        assert_eq!(gpus[0].shared_total, 0);
        assert_eq!(gpus[0].busy_percent, Some(37.0));
    }

    #[test]
    fn nvidia_multi_gpu_and_unavailable_fields() {
        let gpus = parse_nvidia_smi(
            "NVIDIA A100, 0, 40960, [N/A]\nNVIDIA A100, 8192, 40960, 100\n\n",
        );
        assert_eq!(gpus.len(), 2, "blank lines are not GPUs");
        assert_eq!(gpus[0].busy_percent, None, "[N/A] utilization is unknown");
        assert_eq!(gpus[1].busy_percent, Some(100.0));
    }

    #[test]
    fn nvidia_garbage_is_ignored() {
        assert!(parse_nvidia_smi("Failed to initialize NVML: Driver/library version mismatch\n")
            .is_empty());
    }

    #[test]
    fn pci_ids_finds_device_under_its_own_vendor() {
        let db = "\
# Comment
1002  Advanced Micro Devices, Inc. [AMD/ATI]
\t150e  Strix [Radeon 880M / 890M]
\t\t1d05 5006  Some Laptop
\t164e  Raphael
10de  NVIDIA Corporation
\t150e  Not our card
";
        assert_eq!(
            pci_ids_lookup(db, "1002", "150e").as_deref(),
            Some("Strix [Radeon 880M / 890M]")
        );
        assert_eq!(
            pci_ids_lookup(db, "10de", "150e").as_deref(),
            Some("Not our card"),
            "a device id is only meaningful under its vendor"
        );
        assert_eq!(pci_ids_lookup(db, "1002", "9999"), None);
        assert_eq!(pci_ids_lookup(db, "8086", "150e"), None);
    }

    #[test]
    fn gpu_name_falls_back_to_vendor_and_index() {
        // No ids at all → cannot consult pci.ids, so the label must still be
        // recognizable rather than empty.
        assert_eq!(gpu_name("", "", 1), "GPU 1");
        assert_eq!(gpu_name("0x10de", "", 0), "NVIDIA GPU 0");
        assert_eq!(gpu_name("0x8086", "", 2), "Intel GPU 2");
    }

    #[test]
    fn amd_sensors_are_converted_to_base_units() {
        let sample = parse_drm_card(
            1,
            &files(&[
                ("driver", "amdgpu"),
                ("vram_used", "1024"),
                ("vram_total", "2048"),
                ("temp", "58000\n"),        // 58.000 °C
                ("power", "34560000\n"),    // 34.56 W
                ("power_cap", "65000000\n"),
                ("pwm", "128"),             // ~50% of 255
                ("sclk", "0: 200Mhz\n1: 1000Mhz\n2: 2900Mhz *\n"),
                ("mclk", "0: 96Mhz *\n1: 1200Mhz\n"),
                ("link_speed", "16.0 GT/s PCIe"),
                ("link_width", "16"),
            ]),
        )
        .expect("a card exposing vram_total is reported");

        assert_eq!(sample.temp_c, Some(58.0));
        assert_eq!(sample.power_w, Some(34.56));
        assert_eq!(sample.power_cap_w, Some(65.0));
        assert_eq!(sample.sclk_mhz, Some(2900), "the DPM state flagged * is active");
        assert_eq!(sample.mclk_mhz, Some(96));
        assert_eq!(sample.pcie_gen, Some(4), "16 GT/s is PCIe 4.0");
        assert_eq!(sample.pcie_width, Some(16));
        assert_eq!(sample.driver_version, None);
        let fan = sample.fan_percent.expect("pwm1 gives a fan percent");
        assert!((fan - 50.2).abs() < 0.2, "128/255 ≈ 50%, got {fan}");
    }

    #[test]
    fn amd_missing_sensors_stay_unknown_not_zero() {
        // A card with memory but no hwmon/clock/pcie files: every sensor is None,
        // never a fabricated 0 that would read as "0 °C / idle fan".
        let sample = parse_drm_card(
            0,
            &files(&[("driver", "amdgpu"), ("vram_used", "1"), ("vram_total", "2")]),
        )
        .unwrap();
        assert_eq!(sample.temp_c, None);
        assert_eq!(sample.power_w, None);
        assert_eq!(sample.sclk_mhz, None);
        assert_eq!(sample.fan_percent, None);
        assert_eq!(sample.pcie_gen, None);
    }

    #[test]
    fn pcie_gen_maps_transfer_rate_to_generation() {
        let g = |s: &str| pcie_gen_from_speed(Some(&s.to_string()));
        assert_eq!(g("2.5 GT/s PCIe"), Some(1));
        assert_eq!(g("5.0 GT/s PCIe"), Some(2));
        assert_eq!(g("8.0 GT/s PCIe"), Some(3));
        assert_eq!(g("16.0 GT/s PCIe"), Some(4));
        assert_eq!(g("32.0 GT/s PCIe"), Some(5));
        assert_eq!(pcie_gen_from_speed(None), None);
    }

    #[test]
    fn nvidia_smi_reads_the_full_sensor_row() {
        let gpus = parse_nvidia_smi(
            "NVIDIA GeForce RTX 4090, 1234, 24564, 37, 61, 210.5, 450, 2520, 10501, 41, 550.107.02, 4, 16\n",
        );
        assert_eq!(gpus.len(), 1);
        let g = &gpus[0];
        assert_eq!(g.busy_percent, Some(37.0));
        assert_eq!(g.temp_c, Some(61.0));
        assert_eq!(g.power_w, Some(210.5));
        assert_eq!(g.power_cap_w, Some(450.0));
        assert_eq!(g.sclk_mhz, Some(2520));
        assert_eq!(g.mclk_mhz, Some(10501));
        assert_eq!(g.fan_percent, Some(41.0));
        assert_eq!(g.driver_version.as_deref(), Some("550.107.02"));
        assert_eq!(g.pcie_gen, Some(4));
        assert_eq!(g.pcie_width, Some(16));
    }

    #[test]
    fn nvidia_smi_na_sensors_are_unknown_and_short_rows_still_parse() {
        // A laptop dGPU in power-saving answers [N/A] for power/clocks; an older
        // driver simply omits the trailing pcie columns.
        let gpus = parse_nvidia_smi("NVIDIA A2000, 512, 8192, [N/A], 45, [N/A], [N/A]\n");
        assert_eq!(gpus.len(), 1);
        let g = &gpus[0];
        assert_eq!(g.vram_total, 8192 * 1024 * 1024);
        assert_eq!(g.busy_percent, None);
        assert_eq!(g.temp_c, Some(45.0));
        assert_eq!(g.power_w, None);
        assert_eq!(g.sclk_mhz, None, "an absent column is unknown, not zero");
        assert_eq!(g.pcie_gen, None);
    }

    #[test]
    fn nvidia_compute_apps_parse_to_bytes() {
        let procs = parse_nvidia_apps("1234, python, 512\n9, ollama, 4096\n\n");
        assert_eq!(procs.len(), 2, "blank lines are not processes");
        assert_eq!(procs[0].pid, 1234);
        assert_eq!(procs[0].name, "python");
        assert_eq!(procs[0].mem_bytes, 512 * 1024 * 1024);
        assert_eq!(procs[1].mem_bytes, 4096 * 1024 * 1024);
    }

    #[test]
    fn fdinfo_reads_amdgpu_memory_and_client_id() {
        let info = parse_fdinfo(
            "pos:\t0\ndrm-driver:\tamdgpu\ndrm-client-id:\t42\n\
drm-memory-vram:\t131072 KiB\ndrm-memory-gtt:\t8192 KiB\n",
        )
        .expect("a DRM fd is recognized");
        assert_eq!(info.driver, "amdgpu");
        assert_eq!(info.client_id, Some(42));
        assert_eq!(info.vram_kib, 131072);
        assert_eq!(info.gtt_kib, 8192);
    }

    #[test]
    fn fdinfo_ignores_non_drm_fds() {
        // A socket / regular file has no drm-driver line and must not be counted.
        assert!(parse_fdinfo("pos:\t0\nflags:\t02\nmnt_id:\t9\n").is_none());
    }
}
