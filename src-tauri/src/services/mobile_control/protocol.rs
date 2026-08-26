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

/// The deliberately small task surface exposed to a paired Mobile device.
/// Calendar/task ids remain host-generated opaque values; the phone never sees
/// ids from `calendar.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TodoCard {
    pub id: String,
    pub title: String,
    pub column: String,
    pub done: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub due: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    pub priority: u8,
    pub percent: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rank: Option<f64>,
    pub calendar_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub subtasks: Vec<TodoSubtask>,
}

/// A checklist row deliberately carries only the editable fields. Its id is
/// opaque exactly like the containing card's; the desktop resolves it against
/// the current task before writing calendar.json.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TodoSubtask {
    pub id: String,
    pub title: String,
    pub done: bool,
}

/// The editable half of a card. This is separate from [`TodoCard`] so derived
/// fields such as `done` cannot be forged by a phone request.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TodoTaskInput {
    pub title: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub due: Option<String>,
    pub priority: u8,
    pub percent: u8,
    pub column: String,
    pub calendar_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub subtasks: Vec<TodoSubtask>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TodoCalendar {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TodoProject {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TodoColumn {
    pub id: String,
    pub name: String,
    pub position: i64,
    pub done: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TodoBoardSnapshot {
    pub columns: Vec<TodoColumn>,
    pub tasks: Vec<TodoCard>,
    #[serde(default)]
    pub calendars: Vec<TodoCalendar>,
    #[serde(default)]
    pub projects: Vec<TodoProject>,
}

/// A display-only alert row for Mobile. The desktop keeps the source ids and
/// action capabilities: a paired phone only needs the same bounded timeline of
/// urgent mail, upcoming events, and due tasks that the desktop renders.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MobileAlertItem {
    pub kind: String,
    pub severity: String,
    pub title: String,
    pub detail: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
    pub all_day: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub minutes_away: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub days_away: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MobileAlertsSnapshot {
    /// Mirrors the desktop Alerts switch. A disabled desktop feed is distinct
    /// from an enabled feed that simply has no current rows.
    pub enabled: bool,
    pub items: Vec<MobileAlertItem>,
}

/// One already-expanded calendar occurrence.  IDs are opaque, scoped to the
/// paired-device protocol, and are resolved only by the running desktop.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MobileCalendarEvent {
    pub id: String,
    pub calendar_id: String,
    pub occurrence_start: String,
    pub start: String,
    pub end: String,
    pub all_day: bool,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conference: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    pub color: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    pub recurring: bool,
}

/// A calendar row with an opaque id.  Sync/account metadata remains in the
/// desktop process; the mobile client can manage the same ordinary calendar
/// properties as the desktop sidebar.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MobileCalendarInfo {
    pub id: String,
    pub name: String,
    pub color: String,
    pub visible: bool,
    pub readonly: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_url: Option<String>,
    pub caldav: bool,
}

/// The editable event fields. Identity and CalDAV bookkeeping never cross the
/// mobile boundary; the desktop preserves them while applying an edit.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MobileCalendarEventInput {
    pub calendar_id: String,
    pub start: String,
    pub end: String,
    pub all_day: bool,
    pub title: String,
    #[serde(default)]
    pub location: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub conference: String,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum CalendarAction {
    CreateEvent {
        event: MobileCalendarEventInput,
    },
    UpdateEvent {
        event_id: String,
        event: MobileCalendarEventInput,
    },
    DeleteEvent {
        event_id: String,
    },
    CreateCalendar {
        name: String,
        color: String,
    },
    UpdateCalendar {
        calendar_id: String,
        name: String,
        color: String,
        visible: bool,
    },
    DeleteCalendar {
        calendar_id: String,
    },
}

/// A bounded month snapshot. `truncated` is explicit so a very busy month never
/// silently looks complete after the desktop-control message cap.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MobileCalendarSnapshot {
    /// `YYYY-MM`, echoed from the validated request.
    pub month: String,
    /// 0 = Sunday, 1 = Monday; mirrors the user's desktop calendar preference.
    pub week_start: u8,
    pub calendars: Vec<MobileCalendarInfo>,
    pub events: Vec<MobileCalendarEvent>,
    pub truncated: bool,
}

/// A deliberately narrower mail contract than the desktop client uses. Mobile
/// may browse the local index and read one message, but it receives no server
/// paths, link targets, attachment bytes, or mutation controls.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MobileMailFolder {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub unread: u32,
    pub total: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MobileMailAccount {
    pub id: String,
    pub label: String,
    pub address: String,
    pub folders: Vec<MobileMailFolder>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MobileMailSender {
    pub name: Option<String>,
    pub address: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MobileMailHeader {
    pub id: String,
    pub subject: String,
    pub sender: MobileMailSender,
    pub date: String,
    pub seen: bool,
    pub has_attachments: bool,
    pub preview: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MobileMailAttachment {
    pub filename: String,
    pub mime: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "view", rename_all = "snake_case", deny_unknown_fields)]
pub enum MobileMailView {
    Overview {
        accounts: Vec<MobileMailAccount>,
    },
    Folder {
        folder: MobileMailFolder,
        messages: Vec<MobileMailHeader>,
        total: u32,
        offset: u32,
    },
    Message {
        message: MobileMailHeader,
        body: String,
        truncated: bool,
        attachments: Vec<MobileMailAttachment>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum TodoAction {
    Create {
        task: TodoTaskInput,
    },
    Move {
        task_id: String,
        column: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        index: Option<usize>,
    },
    Update {
        task_id: String,
        task: TodoTaskInput,
    },
    Delete {
        task_id: String,
    },
    ColumnCreate {
        name: String,
    },
    ColumnRename {
        column_id: String,
        name: String,
    },
    ColumnMove {
        column_id: String,
        delta: i8,
    },
    ColumnDelete {
        column_id: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum DesktopRequest {
    Catalog {
        request_id: String,
        /// When supplied, include the desktop-derived status of this project's
        /// agent tabs. Tmux names stay inside the trusted desktop/sidecar link;
        /// the sidecar resolves them back onto its opaque public tab ids.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        project_id: Option<String>,
    },
    Activate {
        request_id: String,
        project_id: String,
    },
    Create {
        request_id: String,
        request: CreateTabRequest,
    },
    Todo {
        request_id: String,
    },
    Alerts {
        request_id: String,
    },
    Calendar {
        request_id: String,
        /// A validated `YYYY-MM` civil month. The desktop expands recurrence
        /// only across this month's six-week grid.
        month: String,
    },
    CalendarMutate {
        request_id: String,
        month: String,
        action: CalendarAction,
    },
    TodoMutate {
        request_id: String,
        action: TodoAction,
    },
    MailOverview {
        request_id: String,
    },
    MailFolder {
        request_id: String,
        folder_id: String,
        offset: u32,
    },
    MailMessage {
        request_id: String,
        folder_id: String,
        message_id: String,
        offset: u32,
    },
}

impl DesktopRequest {
    pub fn request_id(&self) -> &str {
        match self {
            Self::Catalog { request_id, .. }
            | Self::Activate { request_id, .. }
            | Self::Create { request_id, .. }
            | Self::Todo { request_id }
            | Self::Alerts { request_id }
            | Self::Calendar { request_id, .. }
            | Self::CalendarMutate { request_id, .. }
            | Self::TodoMutate { request_id, .. }
            | Self::MailOverview { request_id }
            | Self::MailFolder { request_id, .. }
            | Self::MailMessage { request_id, .. } => request_id,
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

/// A status already classified by the desktop activity store. This is an
/// internal desktop-control response, not the phone-facing API: the sidecar
/// maps `tmux_session` to an opaque tab id before serializing it to a client.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentTabStatus {
    pub tmux_session: String,
    /// `working`, `question`, or `done`.
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
pub enum DesktopResponse {
    Catalog {
        agents: Vec<AgentCatalogEntry>,
        #[serde(default)]
        statuses: Vec<AgentTabStatus>,
    },
    Activated,
    Created {
        tmux_session: String,
    },
    Todo {
        board: TodoBoardSnapshot,
    },
    Alerts {
        alerts: MobileAlertsSnapshot,
    },
    Calendar {
        calendar: MobileCalendarSnapshot,
    },
    Mail {
        mail: MobileMailView,
    },
    Error {
        code: String,
        message: String,
    },
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

/// Server → client control frames. The phone needs three things it cannot infer
/// from the byte stream: the tmux window geometry it must adopt (otherwise tmux
/// pans a narrow client across a wide window and silently crops every line),
/// an explicit replay boundary (so a reattach replaces the screen instead of
/// appending a second copy of it), and the reason a socket is closing (so a
/// revoked device is told that, not "reconnecting…").
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum TerminalEvent {
    Pong,
    Window { cols: u16, rows: u16 },
    Replay,
    Closing { reason: String, retry: bool },
}

impl TerminalEvent {
    pub fn to_frame(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{\"type\":\"pong\"}".into())
    }
}

#[cfg(test)]
mod tests {
    use super::{
        AgentTabStatus, DesktopRequest, DesktopResponse, MobileAlertItem, MobileAlertsSnapshot,
        MobileMailView,
    };

    #[test]
    fn catalog_statuses_stay_on_the_internal_control_plane() {
        let request = DesktopRequest::Catalog {
            request_id: "request-0".into(),
            project_id: Some("project-0".into()),
        };
        let request_json = serde_json::to_value(request).expect("serialize catalog request");
        assert_eq!(request_json["project_id"], "project-0");

        let response = DesktopResponse::Catalog {
            agents: vec![],
            statuses: vec![AgentTabStatus {
                tmux_session: "eldrun-project-0--agent-123456789".into(),
                status: "question".into(),
            }],
        };
        let response_json = serde_json::to_value(response).expect("serialize catalog response");
        assert_eq!(response_json["statuses"][0]["status"], "question");
    }

    #[test]
    fn activate_message_round_trips() {
        let request = DesktopRequest::Activate {
            request_id: "request-1".into(),
            project_id: "project-1".into(),
        };
        let json = serde_json::to_value(&request).expect("serialize activation request");
        assert_eq!(json["type"], "activate");
        assert_eq!(json["project_id"], "project-1");
        let restored: DesktopRequest =
            serde_json::from_value(json).expect("deserialize activation request");
        assert_eq!(restored.request_id(), "request-1");

        let response = serde_json::to_value(DesktopResponse::Activated)
            .expect("serialize activation response");
        assert_eq!(response["status"], "activated");
    }

    #[test]
    fn mail_message_request_and_response_are_tagged() {
        let request = DesktopRequest::MailMessage {
            request_id: "request-2".into(),
            folder_id: "opaque-folder".into(),
            message_id: "opaque-message".into(),
            offset: 25,
        };
        let json = serde_json::to_value(&request).expect("serialize mail request");
        assert_eq!(json["type"], "mail_message");
        assert_eq!(json["offset"], 25);
        assert_eq!(request.request_id(), "request-2");

        let response = DesktopResponse::Mail {
            mail: MobileMailView::Message {
                message: super::MobileMailHeader {
                    id: "opaque-message".into(),
                    subject: "Hello".into(),
                    sender: super::MobileMailSender {
                        name: Some("Ada".into()),
                        address: "ada@example.test".into(),
                    },
                    date: "2026-08-25T12:00:00Z".into(),
                    seen: true,
                    has_attachments: false,
                    preview: "Preview".into(),
                },
                body: "Body".into(),
                truncated: false,
                attachments: vec![],
            },
        };
        let json = serde_json::to_value(response).expect("serialize mail response");
        assert_eq!(json["status"], "mail");
        assert_eq!(json["mail"]["view"], "message");
    }

    #[test]
    fn alerts_are_a_display_only_snapshot() {
        let request = DesktopRequest::Alerts {
            request_id: "request-3".into(),
        };
        let json = serde_json::to_value(request).expect("serialize alerts request");
        assert_eq!(json["type"], "alerts");

        let response = DesktopResponse::Alerts {
            alerts: MobileAlertsSnapshot {
                enabled: true,
                items: vec![MobileAlertItem {
                    kind: "task".into(),
                    severity: "soon".into(),
                    title: "Ship mobile alerts".into(),
                    detail: "Eldrun".into(),
                    at: Some("2026-08-25T17:00".into()),
                    all_day: false,
                    minutes_away: Some(30),
                    days_away: Some(0),
                }],
            },
        };
        let json = serde_json::to_value(response).expect("serialize alerts response");
        assert_eq!(json["status"], "alerts");
        assert_eq!(json["alerts"]["items"][0]["kind"], "task");
        assert!(json["alerts"]["items"][0].get("source").is_none());
    }

    #[test]
    fn calendar_snapshot_carries_opaque_event_identity() {
        let request = DesktopRequest::Calendar {
            request_id: "request-4".into(),
            month: "2026-08".into(),
        };
        let request_json = serde_json::to_value(request).expect("serialize calendar request");
        assert_eq!(request_json["type"], "calendar");
        assert_eq!(request_json["month"], "2026-08");

        let response = DesktopResponse::Calendar {
            calendar: super::MobileCalendarSnapshot {
                month: "2026-08".into(),
                week_start: 1,
                calendars: vec![super::MobileCalendarInfo {
                    id: "opaque-calendar".into(),
                    name: "Personal".into(),
                    color: "#7c6cff".into(),
                    visible: true,
                    readonly: false,
                    source_url: None,
                    caldav: false,
                }],
                events: vec![super::MobileCalendarEvent {
                    id: "opaque-event".into(),
                    calendar_id: "opaque-calendar".into(),
                    occurrence_start: "2026-08-26T09:00".into(),
                    start: "2026-08-26T09:00".into(),
                    end: "2026-08-26T10:00".into(),
                    all_day: false,
                    title: "Planning".into(),
                    location: Some("Studio".into()),
                    color: "#7c6cff".into(),
                    status: None,
                    notes: None,
                    conference: None,
                    category: None,
                    recurring: false,
                }],
                truncated: false,
            },
        };
        let response_json = serde_json::to_value(response).expect("serialize calendar response");
        assert_eq!(response_json["status"], "calendar");
        assert_eq!(response_json["calendar"]["events"][0]["title"], "Planning");
        assert_eq!(response_json["calendar"]["events"][0]["id"], "opaque-event");
    }
}
