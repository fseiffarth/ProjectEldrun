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
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct GpuSample {
    pub name: String,
    pub driver: String,
    pub vram_used: u64,
    pub vram_total: u64,
    pub shared_used: u64,
    pub shared_total: u64,
    pub busy_percent: Option<f64>,
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
#[derive(Default)]
struct DrmFiles {
    driver: String,
    vendor: String,
    device: String,
    vram_used: Option<String>,
    vram_total: Option<String>,
    gtt_used: Option<String>,
    gtt_total: Option<String>,
    busy: Option<String>,
}

fn parse_u64(s: Option<&String>) -> u64 {
    s.and_then(|v| v.trim().parse::<u64>().ok()).unwrap_or(0)
}

/// A card is only reported when it states a **VRAM total**: that is the marker
/// that this driver does memory accounting at all. Without it (Intel `i915`, the
/// NVIDIA blob) every byte figure would be a zero pretending to be a measurement.
fn parse_drm_card(index: u32, files: &DrmFiles) -> Option<GpuSample> {
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
            "--query-gpu=name,memory.used,memory.total,utilization.gpu",
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

/// Parse `nvidia-smi --query-gpu=name,memory.used,memory.total,utilization.gpu
/// --format=csv,noheader,nounits`: one comma-separated line per GPU, memory in
/// **MiB**. A field the driver can't answer comes back as `[N/A]` (a laptop GPU
/// in power-saving, a passthrough VM), which parses to no utilization rather than
/// to zero.
fn parse_nvidia_smi(stdout: &str) -> Vec<GpuSample> {
    const MIB: u64 = 1024 * 1024;

    stdout
        .lines()
        .filter_map(|line| {
            let fields: Vec<&str> = line.split(',').map(str::trim).collect();
            if fields.len() < 3 {
                return None;
            }
            let vram_total = fields[2].parse::<u64>().ok()? * MIB;
            Some(GpuSample {
                name: fields[0].to_string(),
                driver: "nvidia".to_string(),
                vram_used: fields[1].parse::<u64>().unwrap_or(0) * MIB,
                vram_total,
                shared_used: 0,
                shared_total: 0,
                busy_percent: fields.get(3).and_then(|u| u.parse::<f64>().ok()),
            })
        })
        .collect()
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
}
