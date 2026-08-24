use serde::{Deserialize, Serialize};

pub const MAX_CONTROL_MESSAGE: usize = 64 * 1024;
pub const MIN_COLS: u16 = 20;
pub const MAX_COLS: u16 = 400;
pub const MIN_ROWS: u16 = 5;
pub const MAX_ROWS: u16 = 200;
pub const MAX_INPUT_FRAME: usize = 64 * 1024;
pub const MAX_OUTPUT_QUEUE: usize = 1024 * 1024;
pub const TERMINAL_PROTOCOL: &str = "eldrun-terminal.v1";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum CreateTabKind {
    Shell,
    Agent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateTabRequest {
    pub project_id: String,
    pub kind: CreateTabKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    pub idempotency_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum DesktopRequest {
    Catalog {
        request_id: String,
    },
    Create {
        request_id: String,
        request: CreateTabRequest,
    },
}

impl DesktopRequest {
    pub fn request_id(&self) -> &str {
        match self {
            Self::Catalog { request_id } | Self::Create { request_id, .. } => request_id,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentCatalogEntry {
    pub id: String,
    pub label: String,
    pub modes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
pub enum DesktopResponse {
    Catalog { agents: Vec<AgentCatalogEntry> },
    Created { tmux_session: String },
    Error { code: String, message: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum AdminRequest {
    Status,
    PairingCode,
    Devices,
    Revoke { device_id: String },
    ForgetAll,
    Shutdown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
pub enum AdminResponse {
    Ok,
    Host {
        running: bool,
        port: u16,
        origin: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        version: Option<String>,
    },
    PairingCode {
        code: String,
        expires_at: u64,
    },
    Devices {
        devices: Vec<AdminDevice>,
    },
    Error {
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AdminDevice {
    pub id: String,
    pub name: String,
    pub created_at: u64,
    pub last_seen_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum TerminalControl {
    Ready,
    Resize { cols: u16, rows: u16 },
    Ping,
    Detached,
}
