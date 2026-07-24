//! Which remote hosts Eldrun treats as **HPC hosts**, and therefore samples
//! carefully.
//!
//! A shared cluster login node runs under usage rules an ordinary dev box does
//! not (`docs/context/hpc_careful_mode.md`): other users' account names may not
//! be determined, information about them that happens to be readable may not be
//! used, and a login node is not to carry a sustained background load. Eldrun's
//! two host probes — the monitor snapshot (`sysstat::REMOTE_SNAPSHOT_SCRIPT`)
//! and the connect-time usage check (`services::remote_usage`) — therefore have
//! a *careful* variant that collects strictly less.
//!
//! **Detection lives on the host**: each probe script asks whether SLURM is on
//! `PATH` and reports the answer back in its own output, so nothing here has to
//! guess from a hostname (which would be both unreliable and, for a hostname of
//! someone's institution, not ours to hardcode). This module is only the
//! *memory* of that answer, keyed by SSH target, so a caller that has no probe
//! result in hand — the connect path, deciding whether to fire the usage check
//! at all — can still act on what the last probe learned.
//!
//! The memory is process-lifetime only and deliberately one-way: a host may be
//! marked careful, and nothing un-marks it while Eldrun runs. A false "careful"
//! costs a slightly thinner monitor pane; a false "ordinary" costs a rule
//! violation, so the asymmetry is the point.

use std::collections::HashSet;
use std::sync::Mutex;

use crate::schema::project::RemoteSpec;

static CAREFUL_HOSTS: Mutex<Option<HashSet<String>>> = Mutex::new(None);

/// Identity of an SSH target for this registry: `user@host:port`, matching how
/// `services::ssh_common` addresses a host. Two projects pointing at the same
/// login node share one entry, which is correct — carefulness is a property of
/// the machine, not of the project that happened to probe it.
pub fn key(user: &Option<String>, host: &str, port: Option<u16>) -> String {
    format!(
        "{}@{}:{}",
        user.as_deref().unwrap_or(""),
        host.to_ascii_lowercase(),
        port.unwrap_or(22)
    )
}

/// [`key`] for a project host's spec.
pub fn key_for(spec: &RemoteSpec) -> String {
    key(&spec.user, &spec.host, spec.port)
}

/// Record what a probe found. Only `true` is remembered (see the module note on
/// the one-way asymmetry).
pub fn remember(key: &str, careful: bool) {
    if !careful {
        return;
    }
    let mut guard = CAREFUL_HOSTS.lock().unwrap();
    guard.get_or_insert_with(HashSet::new).insert(key.to_string());
}

/// Whether a previous probe reported this target as an HPC host. `false` for a
/// target never probed — the probes themselves detect on the host, so an unknown
/// target is never sampled wrongly, it just isn't gated yet.
pub fn is_known_careful(key: &str) -> bool {
    CAREFUL_HOSTS
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|s| s.contains(key))
}

/// The user's **explicit** per-machine answer from `settings.careful_hosts`
/// (the system monitor's Light/Detailed switch, and the connect dialog's "Go
/// easy on this machine"), or `None` where they have not answered for this
/// target. Keyed by [`key`], which is byte-identical to the frontend's
/// `targetKey` — a divergence would silently look up a host nobody wrote.
///
/// Read from disk rather than cached: settings are written whole by the
/// frontend, so there is no invalidation to get wrong, and every caller is
/// already one SSH round trip deep.
pub fn stored_answer(key: &str) -> Option<bool> {
    load_settings()?.careful_hosts?.get(key).copied()
}

fn load_settings() -> Option<crate::schema::Settings> {
    let path = crate::storage::state_dir().join("settings.json");
    crate::storage::read_json(&path).ok()
}

/// Whether the user has tagged this target **HPC** (`settings.hpc_hosts`, the
/// tick on the login form and the badge on the machine's row).
///
/// This is the gate every *behaviour* hangs off — the disk-usage scan, the
/// giant-folder census, the auto byte-sync and lockstep loops, silent
/// auto-connect. Unlike careful mode there is no default and no probe: nothing
/// tags a host but the user, because nothing else can know whether a machine's
/// operators mind (`sbatch` on `PATH` says a scheduler exists, not that the node
/// is shared). An untagged host therefore behaves exactly as it always has.
pub fn is_tagged_hpc(key: &str) -> bool {
    load_settings()
        .and_then(|s| s.hpc_hosts)
        .and_then(|m| m.get(key).copied())
        .unwrap_or(false)
}

/// [`is_tagged_hpc`] for a host spec.
pub fn is_hpc_spec(spec: &RemoteSpec) -> bool {
    is_tagged_hpc(&key_for(spec))
}

/// Sentinel carried by a command that refused because its target is tagged HPC
/// and the user has not confirmed *this* run. Must match `src/lib/hpcGuard.ts`.
///
/// The shape is deliberately the one `UNKNOWN_HOST_KEY` already established
/// (`services::ssh_common::guard_first_contact`): everything the frontend needs
/// to raise a dialog and retry rides in the error string, so no call site has to
/// know in advance that its target might be a cluster. The alternative — asking
/// before every scan — would put the question in front of the 99% of users who
/// have no cluster at all.
pub const HPC_GUARD: &str = "ELDRUN_HPC_GUARD";

/// Build the refusal a gated command returns: `ELDRUN_HPC_GUARD <what> <target>`.
/// `what` is a stable slug the dialog switches its wording on (`du-scan`,
/// `census`, `login-node-run`), `target` the `user@host:port` being protected.
pub fn guard_error(what: &str, spec: &RemoteSpec) -> String {
    format!("{HPC_GUARD} {what} {}", key_for(spec))
}

/// [`is_tagged_hpc`] for a project's host (primary or a `compute_hosts` worker),
/// resolving the spec itself. `false` for a local project or an unknown host, so
/// a caller with only ids in hand can gate without plumbing a spec through.
pub fn project_host_is_hpc(project_id: &str, host_id: &str) -> bool {
    crate::services::remote::remote_target_for_host(project_id, host_id)
        .is_some_and(|t| is_hpc_spec(&t.spec))
}

/// Whether this host should be treated carefully **outside the monitor** — the
/// connect-time usage probe, which has no frontend answer passed down to it.
///
/// The user's explicit answer wins in both directions; with no answer it falls
/// back to what earlier probes learned, which is what the gate has always done.
/// Note this is deliberately *not* the frontend's careful-by-default rule: the
/// probe censors itself host-side either way, and defaulting it off here would
/// silently retire the busy-host warning for every remote project rather than
/// only for the machines the user called shared.
pub fn is_careful_host(spec: &RemoteSpec) -> bool {
    let key = key_for(spec);
    // The HPC tag outranks the Light/Detailed answer in one direction only: a
    // tagged machine is careful even if its careful answer says "this one is
    // mine". Those two say different things — "how much may Eldrun look at" and
    // "is this a shared cluster" — and there is no coherent reading of the second
    // that permits the first's full collection.
    is_tagged_hpc(&key) || stored_answer(&key).unwrap_or_else(|| is_known_careful(&key))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_normalizes_host_case_and_default_port() {
        assert_eq!(
            key(&Some("alice".into()), "Login.Example", None),
            key(&Some("alice".into()), "login.example", Some(22)),
        );
    }

    #[test]
    fn a_different_login_is_a_different_target() {
        assert_ne!(
            key(&Some("alice".into()), "login.example", None),
            key(&Some("bob".into()), "login.example", None),
        );
    }

    /// The asymmetry that keeps a flaky probe from *downgrading* a cluster: once
    /// a host has said "I am an HPC host", a later probe that fails to detect it
    /// (SLURM missing from a login shell's `PATH`, say) must not turn the
    /// reduced collection back off.
    #[test]
    fn careful_is_sticky_and_never_cleared() {
        let k = key(&Some("carol".into()), "sticky.example", None);
        remember(&k, true);
        remember(&k, false);
        assert!(is_known_careful(&k));
    }

    /// The wire contract with `src/lib/hpcGuard.ts`: sentinel, then the slug the
    /// dialog switches its wording on, then the target it names. Parsed by
    /// splitting on whitespace, so neither field may gain a space.
    #[test]
    fn guard_error_carries_the_slug_and_the_target() {
        // Built field-by-field: `RemoteSpec` has no `Default`, and the point of
        // the assertion is the exact three-token shape the frontend splits.
        let spec = RemoteSpec {
            user: Some("alice".into()),
            host: "login.example".into(),
            port: None,
            remote_path: "/home/alice/p".into(),
            openvpn: None,
            auto_connect: None,
            key_auth: None,
            persist_sessions: None,
            label: None,
            extra: Default::default(),
        };
        assert_eq!(
            guard_error("du-scan", &spec),
            "ELDRUN_HPC_GUARD du-scan alice@login.example:22"
        );
        assert_eq!(guard_error("du-scan", &spec).split_whitespace().count(), 3);
    }

    #[test]
    fn an_unprobed_target_is_not_known_careful() {
        assert!(!is_known_careful(&key(&None, "never-probed.example", None)));
    }
}
