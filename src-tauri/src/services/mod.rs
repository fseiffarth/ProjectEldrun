pub mod agent_session;
pub mod big_folders;
// In-app browser (TODO J #61): reader-mode fetch+sanitize, the live-page window
// registry, and download quarantine. See docs/browser_plan_{b,c}.md.
pub mod browser_engine;
// CalDAV accounts (docs/caldav_plan.md): the WebDAV transport half. Hand-rolled
// on reqwest + roxmltree; iCalendar itself is still parsed by src/lib/ics.ts.
pub mod caldav;
pub mod codex_bind;
pub mod git_credentials;
pub mod git_peer;
pub mod hpc_mode;
pub mod local_loss;
// Local-model mail assistant (Group Q, #203–#208): the loopback-only /api/chat
// helper, prompt builders and defensive JSON parsers. AI never touches the net.
pub mod mail_ai;
pub mod mail_authres;
pub mod mail_crypt;
pub mod mail_crypto;
pub mod mail_engine;
pub mod mail_filters;
pub mod mail_pgp;
pub mod mail_sanitize;
pub mod mail_store;
pub mod net_usage;
pub mod openvpn;
pub mod project_runtime;
pub mod remote;
pub mod remote_agents;
pub mod remote_credentials;
pub mod remote_sync;
pub mod remote_usage;
pub mod restore_service;
// The project container bind-mounts host paths straight into a Linux container
// and maps the host uid/gid, so it is Unix-only today *at runtime*: Windows
// refuses at the `pty_spawn` call site (and `up_for_project` no-ops) rather
// than running a tab unwrapped. The module itself compiles everywhere — the
// kill/lifecycle seams (PtyRegistry, project switch, app exit) call into it
// unconditionally.
pub mod sandbox;
pub mod sftp;
pub mod skills;
pub mod ssh_common;
pub mod ssh_exec;
pub mod sync_auto;
pub mod terminal_service;
pub mod tmux_local;
pub mod usage_stats;
// Shared web-safety primitives (URL policy, host display, filename sanitizing)
// used by BOTH the mail client and the in-app browser. `mail_sanitize`
// re-exports what it used to own.
pub mod web_safety;
pub mod window_service;
pub mod worker_sync;
pub mod window_state;
