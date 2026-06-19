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

/// Remote (SSH) location metadata. A project is "remote" iff this is present.
/// The project's `directory` then points at the local sshfs mountpoint while
/// the bytes live on `host:remote_path`.
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
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

/// Optional OpenVPN tunnel for reaching a remote project's host. Only the
/// client config path is persisted; the password is prompted each time the
/// tunnel is brought up and is never written to disk.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenVpnSpec {
    /// Absolute path to the local `.ovpn` client config file.
    pub config: String,
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
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}
