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
//! counters run backwards, we re-baseline for the diff.
//!
//! First-sight booking: a ControlMaster's `bytes_*` counters start at ~0 when it
//! comes up, so the *first* time we see a given `connection_id` its whole
//! cumulative value is real traffic for this project that nothing has booked yet
//! — we book it, then diff from there. This is what captures a burst that
//! completes *before* the sampler's first tick, most visibly the seed transfer a
//! fresh remote project pushes right after connecting (extend-to-remote). We must
//! not do this on *every* re-baseline, though: a transient `ss` failure drops our
//! baseline for a master we already track, and re-booking its cumulative would
//! double-count everything since it came up. So the booking is gated on the
//! `connection_id` being one we have *never* tracked this process — the PID in it
//! makes a genuinely new master distinguishable from one we simply lost sight of.
//! (A master that survives a crash and is re-attached within `ControlPersist` is
//! the one residual case where its pre-crash bytes book once; a rare, bounded
//! over-count, versus silently losing every seed.)
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

    /// What one sample contributes, given the previous baseline and whether this
    /// master's `connection_id` has been tracked before this process.
    #[derive(Debug, PartialEq)]
    enum Booking {
        /// Same master, counters advanced → the per-interval delta.
        Delta(u64, u64),
        /// A master never tracked before → book its cumulative counter from zero
        /// (its counters started at ~0 when it came up; captures a pre-first-sample
        /// burst such as the extend-to-remote seed). Caller marks it tracked.
        Fresh(u64, u64),
        /// A master we *have* tracked but whose baseline we lost (a transient `ss`
        /// failure) → book nothing; re-booking the cumulative would double-count.
        Rebaseline,
    }

    /// Pure booking decision (see the module doc). `cid_known` is whether this
    /// master's `connection_id` is already in the process's tracked set.
    fn decide_booking(prev: Option<&Baseline>, cur: &Baseline, cid_known: bool) -> Booking {
        match prev {
            Some(p)
                if p.connection_id == cur.connection_id && cur.rx >= p.rx && cur.tx >= p.tx =>
            {
                Booking::Delta(cur.rx - p.rx, cur.tx - p.tx)
            }
            // First sight, a restarted master (new connection_id), or a backwards
            // counter. Book from zero only when the connection_id is genuinely new.
            _ if cid_known => Booking::Rebaseline,
            _ => Booking::Fresh(cur.rx, cur.tx),
        }
    }

    pub(super) async fn run(pool: RemotePoolState) {
        let mut baselines: HashMap<String, Baseline> = HashMap::new();
        // Every `connection_id` we have ever booked a baseline for this process.
        // A `connection_id` absent here is a master we have never tracked, so its
        // cumulative counter is bookable-from-zero (see the module doc); one we
        // have tracked but lost (an `ss` hiccup) must re-baseline silently.
        let mut known_conns: std::collections::HashSet<String> = std::collections::HashSet::new();
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
                // Forget the master's connection_id too: a reconnect brings up a
                // fresh master (counter from ~0), which should book-from-zero, and
                // this keeps `known_conns` bounded by the *live* master count.
                if let Some(prev) = baselines.remove(&id) {
                    if let Some(cid) = prev.connection_id {
                        known_conns.remove(&cid);
                    }
                }
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
                // Guaranteed `Some` — the `is_none()` guard above `continue`d.
                let cid = snap.connection_id.clone().unwrap_or_default();

                let booked = match decide_booking(baselines.get(id), &cur, known_conns.contains(&cid))
                {
                    Booking::Delta(d_rx, d_tx) => Some((d_rx, d_tx)),
                    Booking::Fresh(d_rx, d_tx) => {
                        known_conns.insert(cid);
                        Some((d_rx, d_tx))
                    }
                    Booking::Rebaseline => None,
                };
                if let Some((d_rx, d_tx)) = booked {
                    if d_rx != 0 || d_tx != 0 {
                        let acc = pending.entry(id.clone()).or_default();
                        acc.rx = acc.rx.saturating_add(d_rx);
                        acc.tx = acc.tx.saturating_add(d_tx);
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

    #[cfg(test)]
    mod tests {
        use super::{decide_booking, Baseline, Booking};

        fn base(cid: &str, rx: u64, tx: u64) -> Baseline {
            Baseline { connection_id: Some(cid.to_string()), rx, tx }
        }

        #[test]
        fn same_master_advancing_books_the_delta() {
            let prev = base("pid1:a:b", 100, 40);
            let cur = base("pid1:a:b", 175, 55);
            assert_eq!(decide_booking(Some(&prev), &cur, true), Booking::Delta(75, 15));
        }

        #[test]
        fn first_sight_of_a_new_master_books_from_zero() {
            // No baseline yet and a connection_id never tracked → the whole
            // cumulative counter is the seed that landed before the first sample.
            let cur = base("pid1:a:b", 9000, 4000);
            assert_eq!(decide_booking(None, &cur, false), Booking::Fresh(9000, 4000));
        }

        #[test]
        fn restart_to_a_new_master_books_its_cumulative() {
            // Master restarted (new pid → new connection_id, counter reset). The new
            // id is unknown, so its from-zero counter is booked, not discarded.
            let prev = base("pid1:a:b", 9000, 4000);
            let cur = base("pid2:a:b", 120, 30);
            assert_eq!(decide_booking(Some(&prev), &cur, false), Booking::Fresh(120, 30));
        }

        #[test]
        fn lost_baseline_for_a_known_master_rebaselines_silently() {
            // A transient `ss` failure dropped our baseline (prev is None) but the
            // connection_id is still one we tracked → booking the cumulative again
            // would double-count, so book nothing.
            let cur = base("pid1:a:b", 9000, 4000);
            assert_eq!(decide_booking(None, &cur, true), Booking::Rebaseline);
        }

        #[test]
        fn backwards_counter_on_known_id_rebaselines() {
            // Same id but the counter regressed (should not happen for a cumulative
            // counter, but never book a negative) → re-baseline, no booking.
            let prev = base("pid1:a:b", 9000, 4000);
            let cur = base("pid1:a:b", 100, 30);
            assert_eq!(decide_booking(Some(&prev), &cur, true), Booking::Rebaseline);
        }
    }
}

#[cfg(target_os = "linux")]
use linux::run;
