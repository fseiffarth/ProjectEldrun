pub mod agent_session;
pub mod codex_bind;
pub mod git_credentials;
pub mod git_peer;
pub mod local_loss;
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
pub mod ssh_common;
pub mod ssh_exec;
pub mod sync_auto;
pub mod terminal_service;
pub mod tmux_local;
pub mod usage_stats;
pub mod window_service;
pub mod worker_sync;
pub mod window_state;
