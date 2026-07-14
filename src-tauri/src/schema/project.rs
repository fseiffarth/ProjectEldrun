use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Per-extension file count and byte total inside `file_type_stats`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileTypeStat {
    pub count: i64,
    pub bytes: i64,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

/// One item in `time["recent_sessions"]`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecentSession {
    /// "YYYY-MM-DD"
    pub date: String,
    /// "YYYY-MM-DD HH:MM"
    pub start: String,
    pub duration_s: f64,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

/// `project.json["time"]` block.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimeInfo {
    pub total_s: f64,
    pub recent_sessions: Vec<RecentSession>,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

/// One entry in `project.json["open_apps"]`.
/// Fields are optional because the model evolved; older records may omit mode/pid.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenApp {
    pub exec: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    /// "standalone" | "embedded" — how the app was opened
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opened_at: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<i64>,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

/// One entry in `project.json["tab_layout"]`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TabEntry {
    pub key: String,
    pub label: String,
    pub cmd: String,
    pub cwd: String,
    /// Agent session UUID for resumable agent tabs (e.g. Claude's
    /// `--session-id <uuid>`), persisted so the session can be resumed on
    /// restore via `--resume <uuid>`. Absent for shell/files tabs and
    /// non-resumable agents. Serialized as `sessionId`.
    #[serde(rename = "sessionId", skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

/// Remote (SSH) location metadata. A project is "remote" iff this is present;
/// the explicit "is this project remote?" resolver is
/// `services::remote::remote_target_for` (replacing the old infer-from-mountpoint
/// signal). The bytes live on `host:remote_path`.
///
/// In the mount-free remote model (`docs/mountfree_remote_plan.md`) the project's
/// `directory` is **not** a real local path for a remote project — file, git, and
/// terminal commands resolve `host:remote_path` directly over SSH/SFTP, never the
/// local fs. (During the sshfs→SFTP transition `directory` may still hold a legacy
/// mountpoint; it is ignored for fs purposes once a phase routes that op remote.)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteSpec {
    /// SSH user, e.g. "alice"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    /// SSH host, e.g. "build.example.com"
    pub host: String,
    /// SSH port; None = default 22
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    /// Absolute path on the remote host that is the project root
    pub remote_path: String,
    /// Optional OpenVPN tunnel to bring up before reaching `host`. When present,
    /// the tunnel is connected (password prompted at activation, never stored)
    /// before the sshfs mount / ssh sessions.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub openvpn: Option<OpenVpnSpec>,
    /// Opt-in: connect this project automatically (launch + activation) instead of
    /// waiting for the user to bring it up from the pill's connection lamp. Only
    /// offered when the connection can complete with no prompt — a saved SSH
    /// password, or `key_auth` below. The auto-connect never prompts: if it can't
    /// authenticate silently it stops with a red lamp.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_connect: Option<bool>,
    /// Recorded (not user-set): the last successful connect to `host` used no
    /// password at all, so it authenticated via key/agent. This is the only way to
    /// know a host is passwordless without connecting, and it is what makes
    /// auto-connect available to key-auth projects (which have nothing in the
    /// keychain to check). Written by `remote_connect`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_auth: Option<bool>,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

/// Optional OpenVPN tunnel for reaching a remote project's host. The client
/// config path and (for `auth-user-pass` configs) the auth username are
/// persisted; the password/passphrase is prompted each time the tunnel is
/// brought up and is never written to disk (unless the user opts into the OS
/// keychain via "Save password").
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenVpnSpec {
    /// Absolute path to the local `.ovpn` client config file.
    pub config: String,
    /// Auth username for configs that use `auth-user-pass` (server-side
    /// username+password auth). Persisted (it is not a secret, like the SSH
    /// `user`); the matching password is still prompted/keychained separately and
    /// never written here. `None` for configs that don't need a username (e.g.
    /// certificate-only or encrypted-key-passphrase configs).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

/// Per-project container config (TODO #38). When present and `enabled`, every
/// terminal/agent tab of this project execs into ONE session-lived,
/// capability-dropped Docker container (`eldrun-<id>`) that mounts only the
/// project directory plus the minimal agent auth/state paths (see
/// `services::sandbox`), so a process inside cannot reach unrelated host files.
/// Absent (the default) = tabs run on the host exactly as before. Local
/// projects only. (Serde key stays `sandbox` so projects that enabled the old
/// per-tab agent sandbox upgrade in place — no migration.)
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SandboxSpec {
    /// Whether this project's tabs run inside the container.
    pub enabled: bool,
    /// Optional image override; falls back to the built-in default image when
    /// absent (and is ignored while `dockerfile` is set).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    /// In-repo Dockerfile (path relative to the project dir); when set, `up`
    /// builds `eldrun-<id>:latest` from it instead of pulling/expecting `image`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dockerfile: Option<String>,
    /// Max number of processes inside the container (`--pids-limit`). Guards
    /// against a fork-bombing agent. Falls back to a generous built-in default
    /// when absent (see `services::sandbox`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pids_limit: Option<u32>,
    /// Optional hard memory cap (`--memory`, e.g. "4g"). Absent = unlimited, so
    /// heavy in-container builds are not OOM-killed unless the user opts in.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory: Option<String>,
    /// Optional CPU cap (`--cpus`, e.g. "2"). Absent = unlimited.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpus: Option<String>,
    /// Optional docker network (`--network`, e.g. "none" for no egress, or a
    /// custom allowlist network). Absent = the default bridge (full egress).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub network: Option<String>,
    /// Run the container with a read-only root filesystem (`--read-only` +
    /// `--tmpfs /tmp`). Off by default because it breaks agents that write
    /// outside the mounted dirs (e.g. `~/.cache`); opt-in hardening.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub readonly_rootfs: bool,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

/// Per-project `project.json` file.
///
/// Most fields are optional because projects created by older app versions may
/// not have all fields, and this struct must survive forward-compatibility reads
/// (newer Python app wrote fields the Rust model doesn't know about → `extra`).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub directory: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_type: Option<String>,
    /// Per-project git-hosting profile URL (e.g. `https://github.com/me`) that
    /// overrides the global `settings.git_profile_url` for this project's push /
    /// publish. Non-secret, so it lives here; the matching token is kept in the
    /// OS keyring (see `services::git_credentials`), never in this file (which is
    /// inside the project's committed git tree).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_profile_url: Option<String>,
    /// Hosting provider this project was published to (`"github"` / `"gitlab"`),
    /// recorded at publish time so the UI can label the pill and pick the right
    /// CLI. Absent until the project is published to a remote.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_type_stats: Option<HashMap<String, FileTypeStat>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time_today_s: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time_total_s: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_updated: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_apps: Option<HashMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time: Option<TimeInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_tasks: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub open_apps: Option<Vec<OpenApp>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_layout: Option<Vec<TabEntry>>,
    /// Serialized split/group layout tree (opaque to the backend — the frontend
    /// owns its shape; `Value` round-trips it safely). Absent for legacy
    /// projects, in which case the frontend rebuilds a single root group.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_groups: Option<serde_json::Value>,
    /// Session UUIDs of agent tabs that were open (e.g. Claude's
    /// `--session-id <uuid>`), persisted so a session can be resumed later.
    /// The restore path does not consume this yet — it only keeps the UUIDs
    /// durable. Opaque shape owned by the frontend (round-tripped via `Value`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub open_tab_sessions: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote: Option<RemoteSpec>,
    /// For a remote (SSH) project, the local mirror root — the paired local
    /// working copy synced from the host. Chosen at import (defaults to a
    /// `<name>` subfolder of the top-level `eldrun/projects-ssh/` root) and relocatable via the
    /// pill's "Show on disk" when the mirror has been deleted. Absent for local
    /// projects and for remote projects predating configurable mirrors, which
    /// fall back to the default under the state dir. Mirrored into the
    /// `projects.json` entry's `extra["mirror"]`, which `remote_sync::mirror_dir`
    /// reads as the always-local source of truth.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mirror: Option<String>,
    /// Docker sandbox config for agent tabs. Absent = run agents on the host.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sandbox: Option<SandboxSpec>,
    /// The interpreter the code viewer's Run/Debug buttons use for this project
    /// (#87). Absent = **auto-detect** (see `commands::python`), which is what the
    /// overwhelming majority of projects want; this pins it for the ones auto-detect
    /// cannot see — a conda env, a Poetry venv outside the tree, a second venv.
    /// Stored as the command/path verbatim (relative paths resolve against the
    /// project root, which is the run tab's cwd). Mirrored into the `projects.json`
    /// entry's `extra["python_interpreter"]`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub python_interpreter: Option<String>,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}
