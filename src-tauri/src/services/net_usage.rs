//! Background sampler that accrues per-project SSH-link traffic into the
//! persisted store (`schema::net_usage`).
//!
//! Every active remote project rides its own pooled ControlMaster, whose TCP
//! socket carries all of that project's multiplexed channels (terminal, SFTP,
//! sync, git). This loop reads that socket's cumulative `bytes_sent` /
//! `bytes_received` counters for each connected project on a timer — regardless
//! of whether the Network Traffic tab is open — diffs them against the previous
//! sample, and folds the deltas into the current UTC hour bucket (and thereby
//! the current UTC day). That is what makes the tab's "this hour / today / this
//! week / this month / overall" totals reflect real usage rather than only what
//! was observed while watching.
//!
//! Reset handling mirrors the pane's client-side `rateFromSamples`: when a
//! project's ControlMaster restarts (its `connection_id` changes) or its
//! counters run backwards, we re-baseline and record nothing for that step, so a
//! fresh master's whole-lifetime counter is never booked as one spike.
//!
//! Linux-only: the counters come from `ss`, matching `commands::network`. On
//! other platforms [`start`] is a no-op.

use crate::services::remote::RemotePoolState;

/// How often to sample each connected project's link counters.
#[cfg(target_os = "linux")]
const SAMPLE_INTERVAL_SECS: u64 = 5;
/// Flush the in-memory accumulator to disk every this-many ticks (~30 s). The
/// bytes for a project persist in memory between flushes, so a slower cadence
/// only widens the tail lost on a hard kill — not steady-state accuracy.
#[cfg(target_os = "linux")]
const FLUSH_EVERY_TICKS: u64 = 6;

/// Start the background traffic sampler. Spawns a single detached task that runs
/// for the life of the process. A no-op on non-Linux platforms.
pub fn start(pool: RemotePoolState) {
    #[cfg(target_os = "linux")]
    {
        tauri::async_runtime::spawn(run(pool));
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = pool;
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use std::collections::HashMap;
    use std::time::Duration;

    use super::{FLUSH_EVERY_TICKS, SAMPLE_INTERVAL_SECS};
    use crate::commands::network::linux_ssh_link;
    use crate::schema::net_usage::{self, ByteCounts};
    use crate::services::remote::{self, RemotePoolState};
    use crate::storage;

    /// The last observed cumulative counters for one project's ControlMaster.
    /// `connection_id` identifies the specific master+socket so a restart is
    /// detected and does not book the new master's lifetime total as a delta.
    struct Baseline {
        connection_id: Option<String>,
        rx: u64,
        tx: u64,
    }

    pub(super) async fn run(pool: RemotePoolState) {
        let mut baselines: HashMap<String, Baseline> = HashMap::new();
        let mut pending: HashMap<String, ByteCounts> = HashMap::new();
        let mut tick: u64 = 0;

        loop {
            tokio::time::sleep(Duration::from_secs(SAMPLE_INTERVAL_SECS)).await;
            tick += 1;

            let ids = remote::connected_ids(&pool).await;

            // A project that dropped out of the pool since last tick has
            // disconnected: forget its baseline (so a reconnect re-baselines
            // rather than counting the new master's lifetime counter) and flush
            // soon to capture its tail before the pending bytes can be lost.
            let mut disconnected = false;
            let live: std::collections::HashSet<&String> = ids.iter().collect();
            let gone: Vec<String> = baselines
                .keys()
                .filter(|id| !live.contains(id))
                .cloned()
                .collect();
            for id in gone {
                baselines.remove(&id);
                disconnected = true;
            }

            for id in &ids {
                let pid = id.clone();
                let snap = tauri::async_runtime::spawn_blocking(move || linux_ssh_link(&pid))
                    .await
                    .ok();
                let Some(snap) = snap else { continue };

                // Not actually carrying counters (master not found / `ss`
                // unavailable): drop the baseline so the next good sample
                // re-baselines instead of diffing against stale numbers.
                if !snap.connected || snap.connection_id.is_none() {
                    baselines.remove(id);
                    continue;
                }

                let cur = Baseline {
                    connection_id: snap.connection_id.clone(),
                    rx: snap.rx_bytes,
                    tx: snap.tx_bytes,
                };

                match baselines.get(id) {
                    // New project, restarted master, or counters ran backwards:
                    // re-baseline, record nothing this step.
                    None => {}
                    Some(prev)
                        if prev.connection_id != cur.connection_id
                            || cur.rx < prev.rx
                            || cur.tx < prev.tx => {}
                    Some(prev) => {
                        let d_rx = cur.rx - prev.rx;
                        let d_tx = cur.tx - prev.tx;
                        if d_rx != 0 || d_tx != 0 {
                            let acc = pending.entry(id.clone()).or_default();
                            acc.rx = acc.rx.saturating_add(d_rx);
                            acc.tx = acc.tx.saturating_add(d_tx);
                        }
                    }
                }
                baselines.insert(id.clone(), cur);
            }

            if disconnected || tick % FLUSH_EVERY_TICKS == 0 {
                flush(&mut pending).await;
            }
        }
    }

    /// Persist and clear the accumulated deltas in one read-modify-write, off the
    /// async runtime thread. Nonzero-only, so an idle interval never rewrites the
    /// file.
    ///
    /// Bytes are booked to the hour (and day) the *flush* falls in, not the hour
    /// each sample fell in. With a ~30 s flush cadence, an hour boundary can
    /// therefore misattribute at most the last flush interval's bytes to the new
    /// hour — invisible in a per-hour total, and the day is unaffected except in
    /// the one flush that straddles midnight.
    async fn flush(pending: &mut HashMap<String, ByteCounts>) {
        let drained: Vec<(String, ByteCounts)> = pending
            .drain()
            .filter(|(_, c)| c.rx != 0 || c.tx != 0)
            .collect();
        if drained.is_empty() {
            return;
        }
        let _ = tauri::async_runtime::spawn_blocking(move || {
            let mut summary = net_usage::load();
            let hour = storage::hour_utc();
            for (id, c) in &drained {
                summary.add(id, &hour, c.rx, c.tx);
            }
            let _ = net_usage::save(&mut summary);
        })
        .await;
    }
}

#[cfg(target_os = "linux")]
use linux::run;
