//! Persisted per-project network usage (SSH-link bytes), bucketed by UTC day.
//!
//! Companion to the live Network Traffic tab (`commands::network`), which is
//! in-memory only. The background sampler (`services::net_usage`) diffs each
//! connected remote project's ControlMaster byte counters and folds the deltas
//! in here, so a project's cumulative usage survives across tab opens/closes and
//! restarts. The frontend derives "today / this month / overall" from the
//! per-day map (`activity_for`), exactly as the time-tracking tab derives its
//! totals from `time_log::activity_for`.
//!
//! Only **SSH-link bytes per remote project** are stored: Eldrun pools one
//! ControlMaster per active remote project, so those counters are genuinely
//! per-project. Host-wide interface counters are not attributable to a project
//! and are never recorded here, so local projects have no entry.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::storage;

/// File name of the usage store inside `state_dir()`.
pub const USAGE_FILE: &str = "net_usage.json";

/// Received/transmitted byte totals for one (day, project) bucket.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ByteCounts {
    #[serde(default)]
    pub rx: u64,
    #[serde(default)]
    pub tx: u64,
}

/// Rolling per-day network-usage summary: date ("YYYY-MM-DD") → project_id →
/// cumulative {rx, tx} for that day. A bounded map (like `TimeSummary`) so
/// folding a delta is an O(map) read-modify-write and reading one day is O(1).
///
/// Serialized shape:
/// ```json
/// {
///   "version": 1,
///   "days": { "2026-07-03": { "<project-id>": { "rx": 1234, "tx": 5678 } } }
/// }
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetUsageSummary {
    /// Schema version for forward compatibility.
    #[serde(default = "default_version")]
    pub version: u32,
    /// date ("YYYY-MM-DD") → project_id → cumulative {rx, tx} for that day.
    #[serde(default)]
    pub days: HashMap<String, HashMap<String, ByteCounts>>,
}

fn default_version() -> u32 {
    1
}

impl Default for NetUsageSummary {
    fn default() -> Self {
        NetUsageSummary {
            version: 1,
            days: HashMap::new(),
        }
    }
}

impl NetUsageSummary {
    /// Cumulative {rx, tx} recorded for `project_id` on `date`.
    pub fn usage_on(&self, project_id: &str, date: &str) -> ByteCounts {
        self.days
            .get(date)
            .and_then(|by_project| by_project.get(project_id))
            .copied()
            .unwrap_or_default()
    }

    /// Add `rx`/`tx` bytes to `project_id`'s totals for `date` (creating buckets
    /// as needed). A zero delta is a no-op so idle projects never create empty
    /// buckets. Saturating so a pathological counter can never overflow.
    pub fn add(&mut self, project_id: &str, date: &str, rx: u64, tx: u64) {
        if rx == 0 && tx == 0 {
            return;
        }
        let entry = self
            .days
            .entry(date.to_string())
            .or_default()
            .entry(project_id.to_string())
            .or_default();
        entry.rx = entry.rx.saturating_add(rx);
        entry.tx = entry.tx.saturating_add(tx);
    }

    /// Per-date totals for `project_id` (or every project when empty), matching
    /// the shape `commands::net_usage::get_net_usage` returns.
    pub fn activity_for(&self, project_id: &str) -> HashMap<String, ByteCounts> {
        let mut out: HashMap<String, ByteCounts> = HashMap::new();
        for (date, by_project) in &self.days {
            for (pid, counts) in by_project {
                if project_id.is_empty() || pid == project_id {
                    let acc = out.entry(date.clone()).or_default();
                    acc.rx = acc.rx.saturating_add(counts.rx);
                    acc.tx = acc.tx.saturating_add(counts.tx);
                }
            }
        }
        out
    }
}

// ── On-disk helpers ────────────────────────────────────────────────────────

fn usage_path() -> std::path::PathBuf {
    storage::state_dir().join(USAGE_FILE)
}

/// Load the usage summary, defaulting to empty when the file is absent or
/// unparseable (a brand-new install, or a partial write) rather than erroring.
pub fn load() -> NetUsageSummary {
    let path = usage_path();
    if path.exists() {
        storage::read_json(&path).unwrap_or_default()
    } else {
        NetUsageSummary::default()
    }
}

/// Persist the usage summary.
pub fn save(summary: &NetUsageSummary) -> Result<(), String> {
    storage::write_json(&usage_path(), summary).map_err(|e| e.to_string())
}

/// Fold `rx`/`tx` bytes for `project_id` into the current UTC day. O(map)
/// read-modify-write of a bounded file. A zero delta is skipped without
/// touching disk.
pub fn record(project_id: &str, rx: u64, tx: u64) {
    if project_id.is_empty() || (rx == 0 && tx == 0) {
        return;
    }
    let mut summary = load();
    summary.add(project_id, &storage::today_utc(), rx, tx);
    let _ = save(&summary);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_and_lookup_accumulates() {
        let mut s = NetUsageSummary::default();
        s.add("p1", "2026-07-03", 100, 40);
        s.add("p1", "2026-07-03", 50, 10);
        s.add("p2", "2026-07-03", 7, 3);
        s.add("p1", "2026-07-02", 9, 1);
        assert_eq!(s.usage_on("p1", "2026-07-03"), ByteCounts { rx: 150, tx: 50 });
        assert_eq!(s.usage_on("p2", "2026-07-03"), ByteCounts { rx: 7, tx: 3 });
        assert_eq!(s.usage_on("p1", "2026-07-02"), ByteCounts { rx: 9, tx: 1 });
        assert_eq!(s.usage_on("missing", "2026-07-03"), ByteCounts::default());
        assert_eq!(s.usage_on("p1", "1999-01-01"), ByteCounts::default());
    }

    #[test]
    fn add_ignores_zero_delta() {
        let mut s = NetUsageSummary::default();
        s.add("p1", "2026-07-03", 0, 0);
        assert!(s.days.is_empty());
        // A one-sided delta still records.
        s.add("p1", "2026-07-03", 0, 5);
        assert_eq!(s.usage_on("p1", "2026-07-03"), ByteCounts { rx: 0, tx: 5 });
    }

    #[test]
    fn add_saturates_instead_of_overflowing() {
        let mut s = NetUsageSummary::default();
        s.add("p1", "2026-07-03", u64::MAX, u64::MAX);
        s.add("p1", "2026-07-03", 10, 10);
        assert_eq!(
            s.usage_on("p1", "2026-07-03"),
            ByteCounts { rx: u64::MAX, tx: u64::MAX }
        );
    }

    #[test]
    fn activity_for_aggregates_per_date() {
        let mut s = NetUsageSummary::default();
        s.add("p1", "2026-07-03", 100, 20);
        s.add("p2", "2026-07-03", 5, 1);
        s.add("p1", "2026-07-02", 9, 3);

        let p1 = s.activity_for("p1");
        assert_eq!(p1.get("2026-07-03"), Some(&ByteCounts { rx: 100, tx: 20 }));
        assert_eq!(p1.get("2026-07-02"), Some(&ByteCounts { rx: 9, tx: 3 }));
        assert_eq!(p1.get("2026-07-01"), None);

        let all = s.activity_for("");
        assert_eq!(all.get("2026-07-03"), Some(&ByteCounts { rx: 105, tx: 21 }));
        assert_eq!(all.get("2026-07-02"), Some(&ByteCounts { rx: 9, tx: 3 }));
    }

    #[test]
    fn day_rollover_keys_separately() {
        let mut s = NetUsageSummary::default();
        s.add("p1", "2026-07-03", 100, 0);
        s.add("p1", "2026-07-04", 200, 0);
        assert_eq!(s.usage_on("p1", "2026-07-03").rx, 100);
        assert_eq!(s.usage_on("p1", "2026-07-04").rx, 200);
        assert_eq!(s.days.len(), 2);
    }

    #[test]
    fn summary_roundtrips_through_json() {
        let mut s = NetUsageSummary::default();
        s.add("p1", "2026-07-03", 42, 7);
        let json = serde_json::to_string(&s).unwrap();
        let back: NetUsageSummary = serde_json::from_str(&json).unwrap();
        assert_eq!(back.usage_on("p1", "2026-07-03"), ByteCounts { rx: 42, tx: 7 });
        assert_eq!(back.version, 1);
    }

    #[test]
    fn deserializes_empty_object_with_defaults() {
        let back: NetUsageSummary = serde_json::from_str("{}").unwrap();
        assert_eq!(back.version, 1);
        assert!(back.days.is_empty());
    }
}
