use crate::schema::{agent_prompts::ProjectAgentPrompt, AgentScheduleRule, ScheduledAgentPrompt};
use serde::{Deserialize, Serialize};

pub const MAX_CONTROL_MESSAGE: usize = 64 * 1024;
pub const MIN_COLS: u16 = 20;
pub const MAX_COLS: u16 = 400;
pub const MIN_ROWS: u16 = 5;
pub const MAX_ROWS: u16 = 200;
pub const MAX_INPUT_FRAME: usize = 64 * 1024;
pub const MAX_OUTPUT_QUEUE: usize = 1024 * 1024;
pub const TERMINAL_PROTOCOL: &str = "eldrun-terminal.v1";
/// The catalog truncates a tab label to this many characters when it
/// publishes one, so a rename that came back longer would silently disagree
/// with the row the phone is looking at. Rejected at the edge instead.
pub const MAX_TAB_LABEL: usize = 120;

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

/// Phone-editable schedule fields. Receipts are desktop-owned and therefore are
/// not accepted in a mutation body.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MobileScheduleInput {
    pub enabled: bool,
    pub message: String,
    pub rule: AgentScheduleRule,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ScheduleMutation {
    Create {
        schedule: MobileScheduleInput,
    },
    Update {
        schedule_id: String,
        schedule: MobileScheduleInput,
    },
    Delete {
        schedule_id: String,
    },
}

/// Phone-editable fields of a project-collected prompt. Ids and timestamps are
/// desktop-owned.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MobilePromptInput {
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum PromptMutation {
    Create {
        prompt: MobilePromptInput,
    },
    Update {
        prompt_id: String,
        prompt: MobilePromptInput,
    },
    Delete {
        prompt_id: String,
    },
    /// Aim a collected prompt at one agent tab now. The desktop turns it into a
    /// one-time schedule at its *own* current minute, so the phone never has to
    /// reason about the desktop's clock, and delivery keeps the scheduler's
    /// idle gate, claim and receipt.
    Send {
        prompt_id: String,
        tmux_session: String,
    },
}

/// The deliberately small task surface exposed to a paired Mobile device.
/// Calendar/task ids remain host-generated opaque values; the phone never sees
/// ids from `calendar.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
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
pub struct TodoCalendar {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TodoProject {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TodoColumn {
    pub id: String,
    pub name: String,
    pub position: i64,
    pub done: bool,
    /// An archive column (`schema::calendar::TaskColumn::archived`): a resting
    /// place a card is filed into and left in. The phone's board carries its own
    /// "hide archived" switch, so it needs the flag rather than the column's
    /// *name* — the label is renameable and a rename must not change what a
    /// filter hides. `default` because the desktop bridge is the writer here and
    /// a desktop older than this field simply never sends it; the struct denies
    /// unknown fields, so a newer desktop's snapshot would be rejected wholesale
    /// without it.
    #[serde(default)]
    pub archived: bool,
    /// The intake column (`schema::calendar::TaskColumn::intake`): where a card
    /// with no home lands. The phone needs it for the same two things the desktop
    /// does — the column a new card is composed into, and where un-ticking a done
    /// card sends it — and it cannot be inferred from this list, because the board
    /// leads with the date columns and the intake one sits behind Doing. `default`
    /// for the reason `archived` documents above.
    #[serde(default)]
    pub intake: bool,
    /// The two columns a card's *deadline* decides
    /// (`schema::calendar::TaskColumn::{overdue,due_today}`). The phone needs
    /// them for the reason the desktop board does: between these two and the
    /// intake column a card's place is what its `due` says, so a move into one
    /// of them is refused rather than written and undone by the next snapshot.
    /// Without the flags the phone can only offer the move and then report the
    /// refusal as an error. `default` for the reason `archived` documents above.
    #[serde(default)]
    pub overdue: bool,
    #[serde(default)]
    pub due_today: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TodoBoardSnapshot {
    pub columns: Vec<TodoColumn>,
    pub tasks: Vec<TodoCard>,
    #[serde(default)]
    pub calendars: Vec<TodoCalendar>,
    #[serde(default)]
    pub projects: Vec<TodoProject>,
}

/// One alert row for Mobile: the same bounded timeline of urgent mail, upcoming
/// events and due tasks the desktop renders. Source ids stay desktop-side — the
/// only handles here are opaque and derived, and the one write they enable is
/// the strip's own ✓ (`AlertResolve`), which resolves a row and can delete
/// nothing.
#[derive(Debug, Clone, Serialize, Deserialize)]
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
    /// A card row's **opaque** task id — the same derived value the to-do board
    /// snapshot already hands this device, never `calendar.json`'s own id. It is
    /// here so a tapped card alert can open that card instead of dropping the
    /// reader at a board of forty, which is exactly the search the alert existed
    /// to save. Absent for every other kind.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    /// The row's **opaque** handle, minted by the desktop for this snapshot and
    /// resolvable only by it. It is what a phone hands back to press the strip's
    /// ✓ (`AlertResolve`) and it is not a widening of the boundary: it names a
    /// *row of this feed*, never the mail, event or card behind it, and the
    /// desktop resolves it by re-deriving the same handles over its own live
    /// feed — the pattern the mail routes already use with their page offset.
    /// Absent for a row the desktop could not mint one for, and such a row
    /// simply has no ✓ on the phone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alert_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MobileAlertsSnapshot {
    /// Mirrors the desktop Alerts switch. A disabled desktop feed is distinct
    /// from an enabled feed that simply has no current rows.
    pub enabled: bool,
    pub items: Vec<MobileAlertItem>,
}

/// One already-expanded calendar occurrence.  IDs are opaque, scoped to the
/// paired-device protocol, and are resolved only by the running desktop.
#[derive(Debug, Clone, Serialize, Deserialize)]
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
pub struct MobileMailFolder {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub unread: u32,
    pub total: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MobileMailAccount {
    pub id: String,
    pub label: String,
    pub address: String,
    pub folders: Vec<MobileMailFolder>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MobileMailSender {
    pub name: Option<String>,
    pub address: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MobileMailHeader {
    pub id: String,
    pub subject: String,
    pub sender: MobileMailSender,
    pub date: String,
    pub seen: bool,
    /// The IMAP `\\Flagged` star and `\\Answered` mark. Defaulted so a desktop
    /// that predates them still answers a folder request.
    #[serde(default)]
    pub flagged: bool,
    #[serde(default)]
    pub answered: bool,
    pub has_attachments: bool,
    pub preview: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MobileMailAttachment {
    pub filename: String,
    pub mime: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "view", rename_all = "snake_case")]
pub enum MobileMailView {
    Overview {
        accounts: Vec<MobileMailAccount>,
        /// Whether the desktop currently accepts [`DesktopRequest::MailMark`]
        /// and [`DesktopRequest::MailReply`] from a phone. Both are desktop
        /// settings the sidecar cannot read; it only relays the answer so the
        /// phone can hide the controls instead of discovering a refusal.
        #[serde(default)]
        actions: bool,
        #[serde(default)]
        reply: bool,
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

/// The only flag writes a phone may ask for. Delete and move are deliberately
/// absent: destructive from a pocketable device, and the desktop has undo
/// surfaces the phone lacks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MailMarkAction {
    Seen,
    Unseen,
    Flag,
    Unflag,
}

/// Longest reply body a phone may submit, in bytes. A phone reply is a short
/// answer typed on a small keyboard; anything longer belongs on the desktop.
pub const MAX_MAIL_REPLY_BYTES: usize = 16 * 1024;

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
    /// Tick or untick one card — completion *and* placement in a single edit,
    /// the desktop's `toggleTaskDone`. It is its own action rather than a `Move`
    /// into the Done column because a move is a placement and completion is not:
    /// the board refuses a placement its rules would immediately undo, so the
    /// phone's checkbox spoke the one dialect the board could not accept.
    Toggle {
        task_id: String,
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
    /// Every mobile-eligible project's agent-tab statuses in one answer, for
    /// the phone's cross-project activity list. A `Catalog` per project would be
    /// one desktop round trip per project on every poll, and the phone's flat
    /// list has no use for the rest of a catalog: no agent menu, and no
    /// schedule summaries, which cost a backend call per agent tab.
    Activity {
        request_id: String,
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
    /// Press one alert row's ✓. The phone carries no source ids, so the row is
    /// named by the opaque `alert_id` the snapshot published; the desktop
    /// resolves it against its own live feed and resolves the row the way that
    /// kind supports — a card is completed, a mail's local priority mark is
    /// cleared, a meeting is muted in the strip. Nothing here can delete a
    /// message, an appointment or a card (`lib/alertDone`).
    AlertResolve {
        request_id: String,
        alert_id: String,
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
    /// Set or clear one flag on one message. Carries the same `offset` the
    /// read requests do, because the desktop resolves an opaque message id by
    /// re-reading exactly the page that issued it.
    MailMark {
        request_id: String,
        folder_id: String,
        message_id: String,
        offset: u32,
        action: MailMarkAction,
    },
    /// Reply to one message with plain text. The phone supplies **only** the
    /// body: the recipient, subject, and threading headers are derived by the
    /// desktop from its own copy of the original, so a paired phone can answer
    /// people who already wrote to the user and nobody else.
    MailReply {
        request_id: String,
        folder_id: String,
        message_id: String,
        offset: u32,
        body: String,
    },
    Schedules {
        request_id: String,
        project_id: String,
        tmux_session: String,
    },
    ScheduleMutate {
        request_id: String,
        project_id: String,
        tmux_session: String,
        action: ScheduleMutation,
    },
    /// Rename one agent tab. The label is the only thing the phone supplies;
    /// the tab is named by the same `project_id` + `tmux_session` pair the
    /// schedule requests use, so no key or path crosses the boundary.
    RenameTab {
        request_id: String,
        project_id: String,
        tmux_session: String,
        label: String,
    },
    /// Close one tab — agent or shell — exactly as the desktop's own × does:
    /// non-destructively. The tab leaves the desktop's layout and its viewer
    /// dies; the tmux session behind it keeps running and stays reattachable
    /// from the desktop's Sessions view. Named by the same `project_id` +
    /// `tmux_session` pair the rename request uses, so no key or path crosses.
    CloseTab {
        request_id: String,
        project_id: String,
        tmux_session: String,
    },
    Prompts {
        request_id: String,
        project_id: String,
    },
    PromptMutate {
        request_id: String,
        project_id: String,
        action: PromptMutation,
    },
    /// The phone put this agent tab on screen (or took it off again). Nothing
    /// is read back: it stamps the desktop's "this output has been seen" mark
    /// for the tab, so a turn the user already watched on the phone stops
    /// being reported as `done` by the next catalog read. Addressed by the
    /// same `project_id` + `tmux_session` pair the other tab requests use.
    TabSeen {
        request_id: String,
        project_id: String,
        tmux_session: String,
    },
    /// The phone typed into this agent tab. Nothing is read back: it stamps the
    /// desktop's "this session was commanded" mark, which is what licenses the
    /// tab's later output to be classified as working or finished at all. The
    /// phone's keystrokes reach tmux through a client of the sidecar's own, so
    /// the desktop window never sees them and cannot stamp it itself. Carries no
    /// input — only that there *was* some — and is sent on the leading edge of a
    /// burst of typing rather than per keystroke.
    TabInput {
        request_id: String,
        project_id: String,
        tmux_session: String,
    },
    /// What one agent tab is doing, and what its CLI says about its own quota.
    /// Addressed by the same `project_id` + `tmux_session` pair the schedule and
    /// rename requests use, so no key, path or command crosses the boundary.
    /// `refresh` asks the desktop to run the CLI again instead of answering
    /// from its short-lived cache.
    AgentStatus {
        request_id: String,
        project_id: String,
        tmux_session: String,
        #[serde(default)]
        refresh: bool,
    },
    /// What the desktop can hand the phone's composer as an image: the
    /// clipboard's image and the recent files of the screenshot and picture
    /// folders (`services::desktop_images`). Only opaque ids and labels come
    /// back; the project is named so an ineligible one is refused before
    /// anything is read.
    DesktopImages {
        request_id: String,
        project_id: String,
    },
    /// Copy one of those images into the project's inbox — the same
    /// `.eldrun/inbox/` drop box a file sent from the phone lands in — and
    /// answer with the project-relative reference. `image_id` is one the
    /// desktop listed; a path never crosses.
    AttachDesktopImage {
        request_id: String,
        project_id: String,
        image_id: String,
    },
}

impl DesktopRequest {
    pub fn request_id(&self) -> &str {
        match self {
            Self::Catalog { request_id, .. }
            | Self::Activity { request_id }
            | Self::Activate { request_id, .. }
            | Self::Create { request_id, .. }
            | Self::Todo { request_id }
            | Self::Alerts { request_id }
            | Self::AlertResolve { request_id, .. }
            | Self::Calendar { request_id, .. }
            | Self::CalendarMutate { request_id, .. }
            | Self::TodoMutate { request_id, .. }
            | Self::MailOverview { request_id }
            | Self::MailFolder { request_id, .. }
            | Self::MailMessage { request_id, .. }
            | Self::MailMark { request_id, .. }
            | Self::MailReply { request_id, .. }
            | Self::Schedules { request_id, .. }
            | Self::ScheduleMutate { request_id, .. }
            | Self::RenameTab { request_id, .. }
            | Self::CloseTab { request_id, .. }
            | Self::Prompts { request_id, .. }
            | Self::PromptMutate { request_id, .. }
            | Self::TabSeen { request_id, .. }
            | Self::TabInput { request_id, .. }
            | Self::AgentStatus { request_id, .. }
            | Self::DesktopImages { request_id, .. }
            | Self::AttachDesktopImage { request_id, .. } => request_id,
        }
    }

    /// How long the sidecar waits for the desktop's answer to this request.
    ///
    /// A few requests outlive the control-message SLA for reasons of their
    /// own: a first message open may perform a bounded IMAP `BODY.PEEK`, a
    /// flag write or a reply talks to the IMAP/SMTP server before answering,
    /// and an agent status may spawn the agent's CLI in print mode to read its
    /// usage panel (`services::agent_usage::USAGE_TIMEOUT`). Everything else
    /// should still fail fast when the desktop is wedged.
    pub fn response_timeout(&self) -> std::time::Duration {
        std::time::Duration::from_secs(match self {
            Self::MailMessage { .. } | Self::MailMark { .. } => 35,
            Self::MailReply { .. } => 65,
            Self::AgentStatus { .. } => 25,
            _ => 10,
        })
    }

    /// The desktop's own deadline for producing that answer. Always below
    /// [`Self::response_timeout`], so a handler that overruns is reported as a
    /// stated failure rather than as a socket that died under the sidecar.
    pub fn desktop_timeout(&self) -> std::time::Duration {
        std::time::Duration::from_secs(match self {
            Self::MailMessage { .. } | Self::MailMark { .. } => 30,
            Self::MailReply { .. } => 60,
            Self::AgentStatus { .. } => 20,
            _ => 8,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentCatalogEntry {
    pub id: String,
    pub label: String,
    pub modes: Vec<String>,
}

/// A status already classified by the desktop activity store. This is an
/// internal desktop-control response, not the phone-facing API: the sidecar
/// maps `tmux_session` to an opaque tab id before serializing it to a client.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentTabStatus {
    pub tmux_session: String,
    /// `working`, `question`, or `done`.
    pub status: String,
    /// The model this tab last answered with, already shortened for display
    /// by the desktop (`lib/agentModel`), when its transcript names one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Desktop wall clock (ms since the epoch) of the tab's last output while
    /// working, and of the last turn it finished. Both are session-only on the
    /// desktop and absent until the tab has done the thing they name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub working_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub done_at: Option<u64>,
}

/// One agent tab's scheduled-prompt summary, already computed by the desktop
/// against its own clock and time zone. Like `AgentTabStatus` this is an
/// internal desktop-control row keyed by tmux name; the sidecar folds it onto
/// the opaque public tab before anything reaches the phone.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentTabSchedules {
    pub tmux_session: String,
    pub total: u32,
    pub enabled: u32,
    /// Desktop-local `YYYY-MM-DDTHH:MM` of the next run, when one is due.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next: Option<String>,
}

/// What one agent CLI answered when asked about its own quota.
///
/// The panel text travels **as the CLI printed it** and is parsed by the
/// reader (`mobile-web/src/terminal/usageReport.ts`). That is deliberate: the
/// format belongs to somebody else's CLI, so a change to it must degrade to a
/// block a person can still read rather than to an empty card. The phone's
/// "Terminal" half of the sheet shows exactly this text.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MobileAgentUsage {
    /// Display label of the CLI the panel came from ("Claude Code").
    pub label: String,
    /// False when this CLI has no usage readout reachable without a tab. The
    /// sheet then says so instead of showing an empty panel.
    pub supported: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw: Option<String>,
    /// Why there is no panel, in the CLI's own words where it had any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// True when this came from the desktop's short-lived cache rather than
    /// from a fresh run, so the reader can tell a stale figure from a live one.
    pub cached: bool,
}

/// Today's counters out of the desktop's own local rolling stats
/// (`usage_stats.json`), for the project the tab is in.
///
/// The grain is the store's, not the tab's, and the two fields differ in it:
/// `prompts` is counted per agent (`agent.prompt.<cmd>`), while the other three
/// are recorded for the project as a whole — one figure covering every agent tab
/// in it. Passed on as they are recorded and labelled that way on the phone,
/// rather than being silently attributed to the one agent the sheet is about.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MobileAgentTally {
    /// Prompts sent to *this agent* in this project today.
    pub prompts: u64,
    /// Seconds *any* agent tab in this project spent working today.
    pub worked_s: u64,
    /// Times any of them stopped to ask a decision.
    pub decisions: u64,
    /// Times any of them finished a turn.
    pub done: u64,
}

/// The agent-tab status sheet's whole payload: what the desktop knows about the
/// session, plus what its CLI says about the account behind it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MobileAgentStatus {
    /// `working`, `question`, `done` or `idle` — the same classification the
    /// catalog publishes, derived desktop-side from the tab's own output.
    pub state: String,
    /// The tab's label, and the agent behind it. Both are display strings the
    /// desktop already shows; neither is a command line.
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    /// The desktop's own name for the project, for the line the tally is about.
    pub project: String,
    pub today: MobileAgentTally,
    pub usage: MobileAgentUsage,
}

/// A file that landed in a project's `.eldrun/inbox/`, as the phone sees it:
/// the stored name, the project-relative reference it puts after an `@`, and
/// the size. Mirrors `inbox::Stored` on the wire.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MobileInboxAttachment {
    pub name: String,
    pub reference: String,
    pub size: u64,
}

/// What the desktop answers a [`DesktopRequest`] with.
///
/// **This enum and everything it carries are deliberately NOT
/// `deny_unknown_fields`.** Strictness here guards nothing — the peer is Eldrun
/// itself over a private socket in the state dir, not the paired browser, whose
/// every input type above stays strict — and it made the two halves of one app
/// version-fragile in exactly the direction this repo's dev workflow produces
/// daily: `src/` hot-reloads into a running window while the sidecar stays the
/// one compiled into the binary (`tauri dev` runs `--no-watch`; see AGENTS.md
/// and `npm run backend:stale`). A frontend that had learned to send one more
/// optional status field therefore handed the older sidecar a response it
/// refused *whole*, and the refusal is indistinguishable from a closed desktop:
/// the phone lost every agent tab from its Activity list and every "new agent
/// tab" button from a project — silently, and only for the projects whose tabs
/// happened to carry the new field.
///
/// The `#[serde(default)]`s below already buy the other direction (an older
/// desktop that does not send a field yet). Accepting fields we do not know is
/// the same bargain read forwards, and it costs nothing: an unknown field is
/// dropped, and the phone simply does without the column it names.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum DesktopResponse {
    Catalog {
        agents: Vec<AgentCatalogEntry>,
        #[serde(default)]
        statuses: Vec<AgentTabStatus>,
        /// Per-tab scheduled-prompt summaries, in the same shape and for the
        /// same reason as `statuses`. Defaulted so a desktop that predates the
        /// field still answers a catalog request.
        #[serde(default)]
        schedules: Vec<AgentTabSchedules>,
    },
    /// Answer to [`DesktopRequest::Activity`]: the agent tabs of every eligible
    /// project that are working, waiting on a decision, or done. Keyed by tmux
    /// name like `Catalog`'s `statuses`, and mapped onto opaque tab ids by the
    /// sidecar before anything reaches the phone.
    Activity {
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
    Schedules {
        schedules: Vec<ScheduledAgentPrompt>,
        time_zone: String,
        next_runs: std::collections::BTreeMap<String, String>,
    },
    /// The label the desktop actually stored, after its own trim — the phone
    /// renders that rather than the text it typed.
    Renamed {
        label: String,
    },
    /// Acknowledges a [`DesktopRequest::CloseTab`]. Carries nothing: the tab is
    /// simply gone from the desktop's layout, and the phone drops the row it
    /// just closed rather than waiting for the catalog to agree.
    Closed,
    Prompts {
        prompts: Vec<ProjectAgentPrompt>,
    },
    AgentStatus {
        report: MobileAgentStatus,
    },
    /// Acknowledges a [`DesktopRequest::TabSeen`] or [`DesktopRequest::TabInput`].
    /// Carries nothing: the phone never waits on either, and the sidecar only
    /// needs to know the desktop took the report.
    Seen,
    DesktopImages {
        images: Vec<crate::services::desktop_images::DesktopImage>,
    },
    /// A desktop image copied into the project inbox: the same three fields
    /// the phone's own upload gets back.
    Attached {
        attachment: MobileInboxAttachment,
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
        AgentTabSchedules, AgentTabStatus, DesktopRequest, DesktopResponse, MobileAlertItem,
        MobileAlertsSnapshot,
        MobileMailView, MobilePromptInput, MobileScheduleInput, PromptMutation, ScheduleMutation,
    };
    use crate::schema::AgentScheduleRule;

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
                model: Some("opus-4-1".into()),
                working_at: Some(1_700_000_000_000),
                done_at: None,
            }],
            schedules: vec![AgentTabSchedules {
                tmux_session: "eldrun-project-0--agent-123456789".into(),
                total: 3,
                enabled: 2,
                next: Some("2026-09-03T09:00".into()),
            }],
        };
        let response_json = serde_json::to_value(response).expect("serialize catalog response");
        assert_eq!(response_json["statuses"][0]["status"], "question");
        assert_eq!(response_json["statuses"][0]["model"], "opus-4-1");
        assert_eq!(response_json["statuses"][0]["working_at"], 1_700_000_000_000u64);
        assert!(response_json["statuses"][0].get("done_at").is_none());
        assert_eq!(response_json["schedules"][0]["enabled"], 2);
        assert_eq!(response_json["schedules"][0]["next"], "2026-09-03T09:00");
    }

    /// A desktop one build ahead of this sidecar must cost the phone the field
    /// it does not know and nothing else. This used to cost it everything: the
    /// response was `deny_unknown_fields`, so one unrecognized status key made
    /// the whole frame unparseable, `desktop_call` returned an error the caller
    /// could not tell from a closed desktop, and a project's agent tabs and its
    /// "new agent tab" buttons both vanished from the phone with nothing said.
    #[test]
    fn a_newer_desktop_costs_the_phone_only_the_field_this_build_lacks() {
        let from_a_newer_desktop = serde_json::json!({
            "status": "catalog",
            "agents": [{ "id": "agent-0", "label": "Claude", "modes": [] }],
            "statuses": [{
                "tmux_session": "eldrun-project-0--agent-123456789",
                "status": "working",
                "working_at": 1_700_000_000_000u64,
                "a_field_this_build_has_never_heard_of": "…",
            }],
            "schedules": [],
            "one_more_unknown_key": true,
        });
        let response: DesktopResponse =
            serde_json::from_value(from_a_newer_desktop).expect("decode a newer desktop's catalog");
        let DesktopResponse::Catalog {
            agents, statuses, ..
        } = response
        else {
            panic!("a catalog response must still decode as one");
        };
        assert_eq!(agents.len(), 1, "the agent menu survives the unknown field");
        assert_eq!(statuses[0].status, "working");
        assert_eq!(statuses[0].working_at, Some(1_700_000_000_000));
    }

    /// The other half of the bargain: what the *phone* sends stays strict, so
    /// relaxing the desktop's side widened nothing at the browser boundary.
    #[test]
    fn what_the_phone_sends_is_still_refused_when_it_carries_unknown_fields() {
        let mut from_a_phone = serde_json::json!({
            "message": "hello",
            "rule": { "type": "once", "at": "2026-09-05T09:00" },
            "enabled": true,
        });
        serde_json::from_value::<MobileScheduleInput>(from_a_phone.clone())
            .expect("the body without the extra key is otherwise valid");
        from_a_phone["cwd"] = serde_json::json!("/home/someone");
        assert!(
            serde_json::from_value::<MobileScheduleInput>(from_a_phone).is_err(),
            "an unknown key from the paired browser must still be refused"
        );
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
    fn tab_seen_names_the_tab_the_way_every_other_tab_request_does() {
        let request = DesktopRequest::TabSeen {
            request_id: "request-seen".into(),
            project_id: "raw-project".into(),
            tmux_session: "eldrun-project-0--agent-123456789".into(),
        };
        assert_eq!(request.request_id(), "request-seen");
        let json = serde_json::to_value(&request).expect("serialize seen request");
        assert_eq!(json["type"], "tab_seen");
        // The pair the desktop resolves the tab by — and nothing else. No key,
        // path or command rides along on the "I looked at it" report.
        assert_eq!(json["project_id"], "raw-project");
        assert_eq!(json.as_object().expect("object").len(), 4);
        let restored: DesktopRequest =
            serde_json::from_value(json).expect("deserialize seen request");
        assert!(matches!(restored, DesktopRequest::TabSeen { .. }));

        let response = serde_json::to_value(DesktopResponse::Seen).expect("serialize seen response");
        assert_eq!(response["status"], "seen");
    }

    #[test]
    fn schedule_mutations_are_strict_and_keep_target_identity_internal() {
        let request = DesktopRequest::ScheduleMutate {
            request_id: "request-schedule".into(),
            project_id: "raw-project".into(),
            tmux_session: "raw-tmux".into(),
            action: ScheduleMutation::Create {
                schedule: MobileScheduleInput {
                    enabled: true,
                    message: "Review the build".into(),
                    rule: AgentScheduleRule::Daily {
                        time: "09:30".into(),
                    },
                },
            },
        };
        let value = serde_json::to_value(&request).expect("serialize schedule mutation");
        assert_eq!(value["type"], "schedule_mutate");
        assert_eq!(request.request_id(), "request-schedule");

        let mut hostile = value;
        hostile["action"]["schedule"]["schedule_target_id"] = "must-not-cross".into();
        assert!(serde_json::from_value::<DesktopRequest>(hostile).is_err());

        let response = serde_json::to_value(DesktopResponse::Schedules {
            schedules: vec![],
            time_zone: "Europe/Berlin".into(),
            next_runs: std::collections::BTreeMap::new(),
        })
        .expect("serialize schedules response");
        let encoded = response.to_string();
        assert!(!encoded.contains("raw-project"));
        assert!(!encoded.contains("raw-tmux"));
        assert!(!encoded.contains("schedule_target"));
    }

    #[test]
    fn prompt_mutations_are_strict_and_send_names_only_the_tmux_session() {
        let request = DesktopRequest::PromptMutate {
            request_id: "request-prompt".into(),
            project_id: "raw-project".into(),
            action: PromptMutation::Send {
                prompt_id: "prompt-1".into(),
                tmux_session: "raw-tmux".into(),
            },
        };
        let value = serde_json::to_value(&request).expect("serialize prompt mutation");
        assert_eq!(value["type"], "prompt_mutate");
        assert_eq!(value["action"]["type"], "send");
        assert_eq!(request.request_id(), "request-prompt");

        // A phone body may not smuggle a rule or a target onto a send/create.
        let mut hostile = value.clone();
        hostile["action"]["schedule_target_id"] = "must-not-cross".into();
        assert!(serde_json::from_value::<DesktopRequest>(hostile).is_err());
        let mut create = serde_json::to_value(&DesktopRequest::PromptMutate {
            request_id: "request-create".into(),
            project_id: "raw-project".into(),
            action: PromptMutation::Create {
                prompt: MobilePromptInput {
                    message: "Review the build".into(),
                },
            },
        })
        .expect("serialize create");
        create["action"]["prompt"]["id"] = "phone-picked".into();
        assert!(serde_json::from_value::<DesktopRequest>(create).is_err());

        let response = serde_json::to_value(DesktopResponse::Prompts { prompts: vec![] })
            .expect("serialize prompts response");
        assert_eq!(response["status"], "prompts");
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
                    flagged: false,
                    answered: false,
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
                    task_id: Some("opaque-task".into()),
                    alert_id: Some("opaque-row".into()),
                }],
            },
        };
        let json = serde_json::to_value(response).expect("serialize alerts response");
        assert_eq!(json["status"], "alerts");
        assert_eq!(json["alerts"]["items"][0]["kind"], "task");
        assert!(json["alerts"]["items"][0].get("source").is_none());
        // The card reference that lets a tapped alert open its own card is the
        // board's own opaque id, so it stays the only task identity this device
        // ever holds.
        assert_eq!(json["alerts"]["items"][0]["task_id"], "opaque-task");
        // The row handle is the same kind of thing: derived, resolvable only by
        // the desktop, and the whole of what a phone sends back to press ✓.
        assert_eq!(json["alerts"]["items"][0]["alert_id"], "opaque-row");
    }

    #[test]
    fn an_alert_is_resolved_by_its_row_handle_and_nothing_else() {
        let request = DesktopRequest::AlertResolve {
            request_id: "request-3b".into(),
            alert_id: "opaque-row".into(),
        };
        let json = serde_json::to_value(request).expect("serialize alert resolve request");
        assert_eq!(json["type"], "alert_resolve");
        assert_eq!(json["alert_id"], "opaque-row");
        // No kind, no action, no source: what the ✓ does to a mail, a meeting or
        // a card is decided by the desktop from the row it resolves.
        assert!(json.get("kind").is_none());
        assert!(json.get("action").is_none());
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

    /// The terminal control plane, byte for byte as `mobile-web/src/terminal/
    /// protocol.ts` shapes it: every frame the phone sends decodes, nothing it
    /// does not name is accepted, and every server frame survives a round trip.
    #[test]
    fn terminal_frames_match_the_phones_wire_shapes_exactly() {
        use super::{TerminalControl, TerminalEvent};
        let control = |raw: &str| serde_json::from_str::<TerminalControl>(raw);
        assert!(matches!(control(r#"{"type":"ready"}"#), Ok(TerminalControl::Ready)));
        assert!(matches!(control(r#"{"type":"ping"}"#), Ok(TerminalControl::Ping)));
        assert!(matches!(
            control(r#"{"type":"detached"}"#),
            Ok(TerminalControl::Detached)
        ));
        assert!(matches!(
            control(r#"{"type":"resize","cols":80,"rows":24}"#),
            Ok(TerminalControl::Resize { cols: 80, rows: 24 })
        ));
        // Anything the protocol does not name is refused, never guessed at.
        // The one gap is serde's, and documented here so nobody relies on the
        // `deny_unknown_fields` on the enum for it: an internally tagged enum
        // enforces the attribute on its struct variants (`resize` above) but
        // not on its unit variants, whose extra fields are ignored — harmless,
        // since a unit variant carries nothing an extra field could reach.
        assert!(matches!(
            control(r#"{"type":"ping","extra":1}"#),
            Ok(TerminalControl::Ping)
        ));
        for bad in [
            r#"{"type":"resize","cols":80}"#,
            r#"{"type":"resize","cols":-1,"rows":24}"#,
            r#"{"type":"resize","cols":80,"rows":24,"pixel_width":1}"#,
            r#"{"type":"exec","cmd":"id"}"#,
            r#"{}"#,
            "[]",
            "",
        ] {
            assert!(control(bad).is_err(), "accepted {bad:?}");
        }
        for event in [
            TerminalEvent::Pong,
            TerminalEvent::Replay,
            TerminalEvent::Window {
                cols: 180,
                rows: 48,
            },
            TerminalEvent::Closing {
                reason: "replaced".into(),
                retry: false,
            },
        ] {
            let restored: TerminalEvent =
                serde_json::from_str(&event.to_frame()).expect("server frame round trip");
            assert_eq!(restored, event);
        }
    }
}
