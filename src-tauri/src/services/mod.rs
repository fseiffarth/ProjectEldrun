pub mod agent_prompts;
pub mod agent_session;
pub mod agent_tasks;
// One agent CLI's own usage panel (Claude's `/usage`), read in print mode
// without a tab: recipe table, envelope parsing, and the short-lived cache
// that keeps a phone reopening the status sheet from spawning a CLI each
// time.
pub mod agent_usage;
// Which release of each agent CLI is installed vs. the one Eldrun's parsers
// were checked against: the version recipes, the "verified against" notes from
// docs/third_party_update_checklist.md as data, and the day-long probe cache.
pub mod agent_versions;
// Default-on Linux filesystem boundary for local agent tabs.  The authority
// decision and root computation stay AppHandle-free; terminal spawn only applies
// the resulting bubblewrap argv.
pub mod agent_fence;
// The Claude credential mirror: one Eldrun-owned inode mounted into every
// fenced/contained tab in place of `~/.claude/.credentials.json`, kept in step
// with the host file by in-place writes — a file bind mount pins an inode, and
// Claude rotates that file by rename.
pub mod agent_creds;
// "Check for a new Eldrun" against the GitHub releases page: version compare,
// per-platform asset pick, staged download, per-platform install.
pub mod app_update;
pub mod big_folders;
// In-app browser (TODO J #61): reader-mode fetch+sanitize, the live-page window
// registry, and download quarantine. See docs/browser_plan_{b,c}.md.
pub mod browser_engine;
// CalDAV accounts (docs/caldav_plan.md): the WebDAV transport half. Hand-rolled
// on reqwest + roxmltree; iCalendar itself is still parsed by src/lib/ics.ts.
pub mod caldav;
// What the phone's composer may attach from the desktop: recent screenshots and
// pictures by opaque id, copied into the project inbox on request.
pub mod desktop_images;
pub mod codex_bind;
// Codex's own SQLite thread store (`~/.codex/state_<n>.sqlite`), read
// read-only for the model a Codex tab is running now that its releases
// no longer write the JSONL rollout the model tag used to come from.
pub mod codex_store;
pub mod git_credentials;
// The default branch (`main`) for repositories Eldrun creates, and the
// unpublished-`master` rename that runs just before a publish.
pub mod git_init;
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
pub mod mobile_control;
pub mod net_usage;
pub mod openvpn;
pub mod project_runtime;
pub mod prompt_blame;
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
// Dictionary-backed (Hunspell/spellbook) spell check for the native editors —
// the deterministic provider beside the opt-in LLM grammar check.
pub mod spell;
pub mod ssh_common;
pub mod ssh_exec;
pub mod state_gc;
pub mod sync_auto;
pub mod terminal_service;
pub mod tmux_local;
pub mod usage_stats;
// Project VMs (`docs/vm_projects_plan.md`): the third trust tier — the whole
// project inside a hardware-accelerated QEMU guest (KVM on Linux, HVF on
// macOS, WHPX on Windows) reached only over SSH/SFTP (no shared filesystem),
// plus its allowlisting egress proxy and the built-in cloud-init seed writer.
pub mod iso9660;
pub mod vm;
pub mod vm_proxy;
// Shared web-safety primitives (URL policy, host display, filename sanitizing)
// used by BOTH the mail client and the in-app browser. `mail_sanitize`
// re-exports what it used to own.
pub mod web_safety;
pub mod window_service;
pub mod window_state;
pub mod worker_sync;
