//! The **root console's MCP endpoint** — the extra rights an agent gets by
//! running in the root scope, and nowhere else.
//!
//! The root scope is the cross-project management console (the Ctrl+Shift+R
//! overlay). An agent there is asked for things no project agent should be able
//! to do: "add a calendar entry on Friday at 14:00, one hour", "put a card on
//! the board for project X", "which projects are there". Those are Eldrun's own
//! stores, so Eldrun serves them itself, as MCP tools over loopback HTTP.
//!
//! **Who may call it** is the whole design, and it is one bearer token:
//!
//! - minted per app run from the OS CSPRNG, held in memory, **never written to
//!   disk** — a project agent's fence sees `/` read-only, so a token in a file
//!   would be a token it can read;
//! - handed out in exactly one place, [`apply_to_spawn`], which the PTY spawn
//!   path calls only for a *local agent whose scope is root* (`project_id ==
//!   None`). The scope comes from the spawn request, the same trusted input
//!   that already decides the fence roots — a project agent cannot make Tauri
//!   calls, so it cannot ask for a root spawn;
//! - unreadable from a fenced project agent: bubblewrap gives it its own pid
//!   namespace and a fresh `/proc`, so neither the root agent's environment nor
//!   its argv is visible. An agent the user chose to run **unfenced** shares
//!   the uid and can read `/proc/<pid>/environ` — that is what turning the
//!   fence off means, and it is said in `docs/context/root_console.md` rather
//!   than papered over here.
//!
//! The port is loopback-only and a request carrying an `Origin` header is
//! refused, so a web page cannot reach the tools through the user's browser
//! even if it guessed the port.
//!
//! This module is `AppHandle`-free: the HTTP listener and the frontend event
//! live in `commands::root_mcp`. A write returns a [`Change`] describing the row
//! it made, which the command layer emits so the window's calendar store (and
//! its CalDAV push, which is frontend-owned) learns of it.
//!
//! **Never the phone.** Nothing here is reachable from `mobile_control`: the
//! catalog is built from `projects.json` and `boxes.json`, the root scope is in
//! neither, and `discovery` refuses the id outright. Root Claude tabs also spawn
//! without `--remote-control` (see `commands::terminal`).

use std::path::Path;
use std::sync::OnceLock;

use serde_json::{json, Value};

use crate::schema::calendar::{add_minutes, CalendarEvent, CalendarTask};
use crate::terminal::PtyOptions;

/// The env var a root agent finds its token in. Codex reads it by name
/// (`bearer_token_env_var`); it is set for every root agent so a CLI wired up by
/// hand can use it too.
pub const TOKEN_ENV: &str = "ELDRUN_ROOT_MCP_TOKEN";
/// The endpoint, for the same by-hand wiring.
pub const URL_ENV: &str = "ELDRUN_ROOT_MCP_URL";
/// The server name the agent CLIs list the tools under.
pub const SERVER_NAME: &str = "eldrun";

const PROTOCOL_VERSION: &str = "2025-03-26";

/// What the running app serves: where, and the secret that opens it.
#[derive(Debug, Clone)]
pub struct Runtime {
    pub port: u16,
    pub token: String,
}

static RUNTIME: OnceLock<Runtime> = OnceLock::new();

/// Record the live listener. First caller wins — there is one per process.
pub fn set_runtime(runtime: Runtime) {
    let _ = RUNTIME.set(runtime);
}

pub fn runtime() -> Option<&'static Runtime> {
    RUNTIME.get()
}

/// 32 random bytes, hex. `None` when the OS has no entropy to give — the
/// endpoint then simply does not start; a guessable token is not a fallback.
pub fn mint_token() -> Option<String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).ok()?;
    Some(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

pub fn endpoint_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/mcp")
}

/// Constant-time bearer check. `header` is the raw `Authorization` value.
pub fn authorized(header: Option<&str>, token: &str) -> bool {
    use subtle::ConstantTimeEq;
    let Some(presented) = header.and_then(|h| h.strip_prefix("Bearer ")) else {
        return false;
    };
    presented.as_bytes().ct_eq(token.as_bytes()).into()
}

// ── Spawn wiring ────────────────────────────────────────────────────────────

/// Whether this spawn is a root-console agent: a recognised agent CLI, run
/// locally, in the root scope. The caller has already resolved `is_agent`.
pub fn is_root_agent(opts: &PtyOptions, is_agent: bool) -> bool {
    is_agent && opts.project_id.is_none()
}

fn basename(cmd: &str) -> &str {
    cmd.rsplit(['/', '\\']).next().unwrap_or(cmd)
}

/// Hand a root agent the endpoint. Pure over `runtime` so it is testable.
///
/// The CLI is told about the server on its **own command line**, never through
/// its config files — Eldrun does not write another application's config
/// (`feedback: no foreign app paths`), and a flag dies with the tab, so a
/// project agent started later inherits nothing.
///
/// - **Claude**: `--mcp-config <inline json>`, last in argv (the flag is
///   variadic; nothing positional may follow it).
/// - **Codex**: `-c mcp_servers.eldrun.…` overrides, first in argv so they
///   precede a `resume <id>` subcommand. The token is named, not inlined.
/// - Every other agent gets the env pair only, until its CLI has a
///   per-invocation way to name a server.
pub fn apply_to_spawn_with(opts: &mut PtyOptions, runtime: &Runtime) {
    let url = endpoint_url(runtime.port);
    opts.env.insert(TOKEN_ENV.to_string(), runtime.token.clone());
    opts.env.insert(URL_ENV.to_string(), url.clone());
    match basename(&opts.cmd) {
        "claude" if !opts.args.iter().any(|a| a == "--mcp-config") => {
            let config = json!({
                "mcpServers": {
                    SERVER_NAME: {
                        "type": "http",
                        "url": url,
                        "headers": { "Authorization": format!("Bearer {}", runtime.token) },
                    }
                }
            });
            opts.args.push("--mcp-config".to_string());
            opts.args.push(config.to_string());
        }
        "codex" if !opts.args.iter().any(|a| a.starts_with("mcp_servers.eldrun.")) => {
            let overrides = [
                "-c".to_string(),
                format!("mcp_servers.{SERVER_NAME}.url=\"{url}\""),
                "-c".to_string(),
                format!("mcp_servers.{SERVER_NAME}.bearer_token_env_var=\"{TOKEN_ENV}\""),
            ];
            opts.args.splice(0..0, overrides);
        }
        _ => {}
    }
}

/// [`apply_to_spawn_with`] against the live listener; a no-op while none is up.
pub fn apply_to_spawn(opts: &mut PtyOptions) {
    if let Some(runtime) = runtime() {
        apply_to_spawn_with(opts, runtime);
    }
}

// ── Tools ───────────────────────────────────────────────────────────────────

/// A row a tool wrote, for the window to merge and (CalDAV) push.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Change {
    /// `"event"` | `"task"`.
    pub kind: &'static str,
    /// `"upsert"` | `"delete"`.
    pub op: &'static str,
    pub row: Value,
    /// The write touched only Eldrun's own board fields (`column`/`rank`), which
    /// no CalDAV server stores — the window merges the row and pushes nothing,
    /// exactly as a drag on the board does.
    pub local: bool,
}

/// An overlay a tool asked the window to show. Not a [`Change`]: nothing was
/// written, so there is no row to merge and nothing for CalDAV.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct OverlayOpen {
    /// `"mail"` | `"calendar"` | `"todo"`.
    pub overlay: &'static str,
    /// `todo_open` only: the card to open the board on.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
}

/// What a call leaves for the command layer to tell the window.
#[derive(Debug, Default)]
pub struct Effects {
    pub changes: Vec<Change>,
    pub open: Option<OverlayOpen>,
}

impl Effects {
    fn wrote(changes: Vec<Change>) -> Self {
        Effects { changes, open: None }
    }
}

/// Where the tools read and write. Paths, so tests drive a tempdir.
pub struct Stores<'a> {
    pub calendar: &'a Path,
    pub projects: &'a Path,
    /// Read only, for the gates the `*_open` tools answer against.
    pub settings: &'a Path,
}

pub fn tool_names() -> Vec<&'static str> {
    vec![
        "projects_list",
        "calendar_list",
        "calendar_add_event",
        "calendar_delete_event",
        "todo_list",
        "todo_add",
        "todo_complete",
        "todo_reopen",
        "todo_update",
        "todo_move",
        "todo_delete",
        "mail_open",
        "calendar_open",
        "todo_open",
    ]
}

/// MCP tool annotations: what a tool does, stated so the client can decide
/// whether to ask. Codex prompts before any tool that does not say it is
/// read-only; the annotation only describes the tool — the approval stays the
/// CLI's own (`docs/context/root_console.md`).
fn tool_annotations(name: &str) -> Value {
    // An `*_open` tool shows an overlay the user closes with Escape: it reads
    // and writes no store, which is what the hint is about.
    let read_only = matches!(
        name,
        "projects_list" | "calendar_list" | "todo_list" | "mail_open" | "calendar_open" | "todo_open"
    );
    // Overwrites or removes what the user wrote. A complete/reopen/move is
    // undone by its opposite gesture; an add only adds.
    let destructive = matches!(name, "calendar_delete_event" | "todo_delete" | "todo_update");
    if read_only {
        json!({ "readOnlyHint": true, "openWorldHint": false })
    } else {
        // No `openWorldHint`: a write to a CalDAV-backed calendar is pushed
        // to its server by the window.
        json!({ "readOnlyHint": false, "destructiveHint": destructive })
    }
}

fn tool_definitions() -> Value {
    let mut tools = tool_schemas();
    for tool in tools.as_array_mut().into_iter().flatten() {
        let name = tool["name"].as_str().unwrap_or_default().to_string();
        tool["annotations"] = tool_annotations(&name);
    }
    tools
}

fn tool_schemas() -> Value {
    let stamp = "Local wall-clock time, \"YYYY-MM-DDTHH:MM\" (or \"YYYY-MM-DD\" when all_day).";
    json!([
        {
            "name": "projects_list",
            "description": "List every Eldrun project: id, name, status (current/active/inactive), folder, and whether it runs on a remote host.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "calendar_list",
            "description": "List the user's calendars and the events that start inside [from, to). Recurring events are returned as their master row with its rrule, not expanded.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "from": { "type": "string", "description": "Inclusive lower bound, \"YYYY-MM-DD\"." },
                    "to": { "type": "string", "description": "Exclusive upper bound, \"YYYY-MM-DD\"." }
                }
            }
        },
        {
            "name": "calendar_add_event",
            "description": "Add an event to the user's Eldrun calendar. Give `start` and either `end` or `duration_minutes` (default 60).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "title": { "type": "string" },
                    "start": { "type": "string", "description": stamp },
                    "end": { "type": "string", "description": "Exclusive end, same format as start." },
                    "duration_minutes": { "type": "integer", "minimum": 1, "description": "Used when `end` is absent. Default 60." },
                    "all_day": { "type": "boolean" },
                    "location": { "type": "string" },
                    "notes": { "type": "string" },
                    "calendar": { "type": "string", "description": "Calendar id or name; the default calendar when absent." }
                },
                "required": ["title", "start"]
            }
        },
        {
            "name": "calendar_delete_event",
            "description": "Delete one event by id (as returned by calendar_list / calendar_add_event). A recurring event is deleted as a whole series.",
            "inputSchema": {
                "type": "object",
                "properties": { "id": { "type": "string" } },
                "required": ["id"]
            }
        },
        {
            "name": "todo_list",
            "description": "List the to-do board: its columns and cards. Completed cards are left out unless include_completed is true.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "include_completed": { "type": "boolean" },
                    "project": { "type": "string", "description": "Only cards linked to this project (id or name)." }
                }
            }
        },
        {
            "name": "todo_add",
            "description": "Add a card to the to-do board, optionally linked to a project and with a due time.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "title": { "type": "string" },
                    "notes": { "type": "string" },
                    "due": { "type": "string", "description": stamp },
                    "project": { "type": "string", "description": "Project id or name to link the card to." },
                    "column": { "type": "string", "description": "Board column id or name; the first column when absent." },
                    "tags": { "type": "array", "items": { "type": "string" } }
                },
                "required": ["title"]
            }
        },
        {
            "name": "todo_complete",
            "description": "Mark one to-do card done, by id.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string" },
                    "completed_at": { "type": "string", "description": "Local \"YYYY-MM-DDTHH:MM\"; the card's due/creation stamp is used when absent." }
                },
                "required": ["id"]
            }
        },
        {
            "name": "todo_reopen",
            "description": "Mark a completed to-do card as not done again, by id. It leaves the done column for the board's intake column.",
            "inputSchema": {
                "type": "object",
                "properties": { "id": { "type": "string" } },
                "required": ["id"]
            }
        },
        {
            "name": "todo_update",
            "description": "Edit one to-do card, by id. Only the fields given change; an empty string clears `notes`, `due` or `project`, and `tags` replaces the whole list. Use todo_move for the column and todo_complete / todo_reopen for done-ness.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string" },
                    "title": { "type": "string" },
                    "notes": { "type": "string" },
                    "due": { "type": "string", "description": stamp },
                    "project": { "type": "string", "description": "Project id or name to link the card to." },
                    "tags": { "type": "array", "items": { "type": "string" } },
                    "priority": { "type": "integer", "minimum": 0, "maximum": 9, "description": "iCalendar priority: 0 unset, 1 highest, 9 lowest." }
                },
                "required": ["id"]
            }
        },
        {
            "name": "todo_move",
            "description": "Move one to-do card to another board column (or reorder it inside its own). Moving into the done column completes the card; moving out of it reopens it.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string" },
                    "column": { "type": "string", "description": "Board column id or name (see todo_list)." },
                    "position": { "type": "integer", "minimum": 0, "description": "0-based slot in the column, top first; the bottom when absent." },
                    "completed_at": { "type": "string", "description": "Used when the move completes the card; same rule as todo_complete." }
                },
                "required": ["id", "column"]
            }
        },
        {
            "name": "todo_delete",
            "description": "Delete one to-do card for good, by id. There is no undo — prefer todo_complete for a card that is merely finished.",
            "inputSchema": {
                "type": "object",
                "properties": { "id": { "type": "string" } },
                "required": ["id"]
            }
        },
        {
            "name": "mail_open",
            "description": "Show the mail overlay in the Eldrun window, over whatever is open. The root console closes to make room (Ctrl+Shift+R brings it back). Fails when the mail client is switched off in Settings.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "calendar_open",
            "description": "Show the calendar overlay in the Eldrun window, over whatever is open. The root console closes to make room (Ctrl+Shift+R brings it back). Fails when the calendar's header button is switched off in Settings.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "todo_open",
            "description": "Show the to-do board overlay in the Eldrun window, over whatever is open; with `id`, open it on that card. The root console closes to make room (Ctrl+Shift+R brings it back). Fails when the to-do board is switched off in Settings.",
            "inputSchema": {
                "type": "object",
                "properties": { "id": { "type": "string", "description": "A card id (see todo_list) to open the board on." } }
            }
        }
    ])
}

fn str_arg<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty())
}

fn all_digits(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|b| b.is_ascii_digit())
}

/// `"YYYY-MM-DD"`, with a month and day that can exist.
fn valid_date(s: &str) -> bool {
    let mut parts = s.split('-');
    let (Some(y), Some(m), Some(d), None) = (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return false;
    };
    if !(all_digits(y, 4) && all_digits(m, 2) && all_digits(d, 2)) {
        return false;
    }
    let (m, d): (u32, u32) = (m.parse().unwrap_or(0), d.parse().unwrap_or(0));
    (1..=12).contains(&m) && (1..=31).contains(&d)
}

/// `"YYYY-MM-DDTHH:MM"`; a trailing `:SS` is accepted and dropped, because that
/// is what a model that knows ISO 8601 writes.
fn normalize_stamp(s: &str) -> Option<String> {
    let (date, time) = s.split_once('T')?;
    if !valid_date(date) {
        return None;
    }
    let mut parts = time.split(':');
    let (h, mi) = (parts.next()?, parts.next()?);
    if let Some(sec) = parts.next() {
        if !all_digits(sec, 2) || parts.next().is_some() {
            return None;
        }
    }
    if !(all_digits(h, 2) && all_digits(mi, 2)) {
        return None;
    }
    let (hn, mn): (u32, u32) = (h.parse().ok()?, mi.parse().ok()?);
    (hn < 24 && mn < 60).then(|| format!("{date}T{h}:{mi}"))
}

fn read_projects(path: &Path) -> Vec<crate::schema::projects::ProjectEntry> {
    crate::storage::read_json(path).unwrap_or_default()
}

/// Resolve "id or name" to a project id. A name must match exactly one project
/// (case-insensitively) — an ambiguous name links nothing rather than guessing.
fn resolve_project(path: &Path, wanted: &str) -> Result<String, String> {
    let projects = read_projects(path);
    if let Some(p) = projects.iter().find(|p| p.id == wanted) {
        return Ok(p.id.clone());
    }
    let by_name: Vec<_> = projects
        .iter()
        .filter(|p| p.name.eq_ignore_ascii_case(wanted))
        .collect();
    match by_name.as_slice() {
        [one] => Ok(one.id.clone()),
        [] => Err(format!("no project named '{wanted}' (see projects_list)")),
        _ => Err(format!("several projects are named '{wanted}'; pass the id instead")),
    }
}

fn projects_list(stores: &Stores) -> Result<Value, String> {
    let rows: Vec<Value> = read_projects(stores.projects)
        .iter()
        .filter(|p| !crate::paths::is_trash_project_id(&p.id))
        .map(|p| {
            json!({
                "id": p.id,
                "name": p.name,
                "status": p.status,
                "directory": p.extra.get("directory").and_then(Value::as_str).unwrap_or(""),
                "remote": p.extra.get("remote").is_some_and(|r| !r.is_null()),
            })
        })
        .collect();
    Ok(json!({ "projects": rows }))
}

fn calendar_list(stores: &Stores, args: &Value) -> Result<Value, String> {
    let from = str_arg(args, "from");
    let to = str_arg(args, "to");
    for bound in [from, to].into_iter().flatten() {
        if !valid_date(bound) {
            return Err(format!("'{bound}' is not a YYYY-MM-DD date"));
        }
    }
    let data = crate::commands::calendar::read_data(stores.calendar)?;
    // Stamps sort lexicographically, and a date is a prefix of its own day's
    // stamps, so plain string comparison is the range test.
    let events: Vec<&CalendarEvent> = data
        .events
        .iter()
        .filter(|e| e.rrule.is_some() || from.is_none_or(|f| e.start.as_str() >= f))
        .filter(|e| to.is_none_or(|t| e.start.as_str() < t))
        .collect();
    let calendars: Vec<Value> = data
        .calendars
        .iter()
        .map(|c| json!({ "id": c.id, "name": c.name, "readonly": c.readonly }))
        .collect();
    Ok(json!({ "calendars": calendars, "events": events }))
}

fn resolve_calendar(
    data: &crate::schema::calendar::CalendarData,
    wanted: Option<&str>,
) -> Result<String, String> {
    let Some(wanted) = wanted else {
        return Ok(String::new());
    };
    let found = data
        .calendars
        .iter()
        .find(|c| c.id == wanted)
        .or_else(|| data.calendars.iter().find(|c| c.name.eq_ignore_ascii_case(wanted)))
        .ok_or_else(|| format!("no calendar '{wanted}' (see calendar_list)"))?;
    if found.readonly {
        return Err(format!("calendar '{}' is read-only", found.name));
    }
    Ok(found.id.clone())
}

fn calendar_add_event(stores: &Stores, args: &Value) -> Result<(Value, Change), String> {
    let title = str_arg(args, "title").ok_or("`title` is required")?;
    let raw_start = str_arg(args, "start").ok_or("`start` is required")?;
    let all_day = args.get("all_day").and_then(Value::as_bool).unwrap_or(false);

    let (start, end) = if all_day {
        let day = raw_start.split('T').next().unwrap_or(raw_start);
        if !valid_date(day) {
            return Err(format!("'{raw_start}' is not a YYYY-MM-DD date"));
        }
        let end = match str_arg(args, "end") {
            Some(e) if valid_date(e) && e > day => e.to_string(),
            Some(e) => return Err(format!("`end` '{e}' must be a date after `start` (it is exclusive)")),
            None => crate::schema::calendar::add_days(day, 1),
        };
        (day.to_string(), end)
    } else {
        let start = normalize_stamp(raw_start)
            .ok_or_else(|| format!("'{raw_start}' is not a local YYYY-MM-DDTHH:MM time"))?;
        let end = match str_arg(args, "end") {
            Some(e) => {
                let end = normalize_stamp(e)
                    .ok_or_else(|| format!("'{e}' is not a local YYYY-MM-DDTHH:MM time"))?;
                if end <= start {
                    return Err("`end` must be after `start`".into());
                }
                end
            }
            None => {
                let minutes = args.get("duration_minutes").and_then(Value::as_i64).unwrap_or(60);
                if !(1..=60 * 24 * 31).contains(&minutes) {
                    return Err("`duration_minutes` must be between 1 and 44640".into());
                }
                add_minutes(&start, minutes)
            }
        };
        (start, end)
    };

    let data = crate::commands::calendar::read_data(stores.calendar)?;
    let calendar_id = resolve_calendar(&data, str_arg(args, "calendar"))?;
    let event = CalendarEvent {
        calendar_id,
        start,
        end,
        all_day,
        title: title.to_string(),
        location: str_arg(args, "location").unwrap_or_default().to_string(),
        notes: str_arg(args, "notes").unwrap_or_default().to_string(),
        ..Default::default()
    };
    let created = crate::commands::calendar::create_event_at(stores.calendar, event)?;
    let row = serde_json::to_value(&created).map_err(|e| e.to_string())?;
    Ok((row.clone(), Change { kind: "event", op: "upsert", row, local: false }))
}

fn calendar_delete_event(stores: &Stores, args: &Value) -> Result<(Value, Change), String> {
    let id = str_arg(args, "id").ok_or("`id` is required")?;
    let data = crate::commands::calendar::read_data(stores.calendar)?;
    let event = data
        .events
        .iter()
        .find(|e| e.id == id)
        .ok_or_else(|| format!("event '{id}' not found"))?;
    // The row rides along so the window can address the CalDAV copy, which is
    // unreachable once the local row is gone.
    let row = serde_json::to_value(event).map_err(|e| e.to_string())?;
    crate::commands::calendar::delete_event_at(stores.calendar, id)?;
    Ok((json!({ "deleted": id }), Change { kind: "event", op: "delete", row, local: false }))
}

fn todo_list(stores: &Stores, args: &Value) -> Result<Value, String> {
    let include_completed = args.get("include_completed").and_then(Value::as_bool).unwrap_or(false);
    let project = match str_arg(args, "project") {
        Some(p) => Some(resolve_project(stores.projects, p)?),
        None => None,
    };
    let data = crate::commands::calendar::read_data(stores.calendar)?;
    let cards: Vec<&CalendarTask> = data
        .tasks
        .iter()
        .filter(|t| include_completed || t.completed.is_none())
        .filter(|t| project.as_ref().is_none_or(|p| &t.project_id == p))
        .collect();
    let columns: Vec<Value> = data
        .task_columns
        .iter()
        .map(|c| json!({ "id": c.id, "name": c.name }))
        .collect();
    Ok(json!({ "columns": columns, "cards": cards }))
}

/// A card's `due`: a bare date or a local stamp.
fn parse_due(d: &str) -> Result<String, String> {
    if valid_date(d) {
        return Ok(d.to_string());
    }
    normalize_stamp(d).ok_or_else(|| format!("'{d}' is not a local date or YYYY-MM-DDTHH:MM time"))
}

/// Resolve "id or name" to a board column id.
fn resolve_column(data: &crate::schema::calendar::CalendarData, wanted: &str) -> Result<String, String> {
    data.task_columns
        .iter()
        .find(|c| c.id == wanted)
        .or_else(|| data.task_columns.iter().find(|c| c.name.eq_ignore_ascii_case(wanted)))
        .map(|c| c.id.clone())
        .ok_or_else(|| format!("no board column '{wanted}' (see todo_list)"))
}

fn find_task(stores: &Stores, id: &str) -> Result<CalendarTask, String> {
    crate::commands::calendar::read_data(stores.calendar)?
        .tasks
        .into_iter()
        .find(|t| t.id == id)
        .ok_or_else(|| format!("card '{id}' not found"))
}

/// The stamp a completion gets. This crate has no local clock, so without an
/// explicit `completed_at` the card's own due/creation stamp stands in.
fn completion_stamp(task: &CalendarTask, args: &Value) -> Result<String, String> {
    match str_arg(args, "completed_at") {
        Some(s) => normalize_stamp(s).ok_or_else(|| format!("'{s}' is not a local YYYY-MM-DDTHH:MM time")),
        None => Ok(task
            .due
            .clone()
            .filter(|d| d.contains('T'))
            .or_else(|| Some(task.created.clone()).filter(|c| !c.is_empty()))
            .unwrap_or_else(|| "1970-01-01T00:00".to_string())),
    }
}

fn task_upsert(task: &CalendarTask) -> Result<(Value, Change), String> {
    let row = serde_json::to_value(task).map_err(|e| e.to_string())?;
    Ok((row.clone(), Change { kind: "task", op: "upsert", row, local: false }))
}

fn todo_add(stores: &Stores, args: &Value) -> Result<(Value, Change), String> {
    let title = str_arg(args, "title").ok_or("`title` is required")?;
    let due = str_arg(args, "due").map(parse_due).transpose()?;
    let project_id = match str_arg(args, "project") {
        Some(p) => resolve_project(stores.projects, p)?,
        None => String::new(),
    };
    let data = crate::commands::calendar::read_data(stores.calendar)?;
    let column = match str_arg(args, "column") {
        Some(wanted) => resolve_column(&data, wanted)?,
        // Empty: `normalize` files the card into the board's first column.
        None => String::new(),
    };
    let tags = args
        .get("tags")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default();
    let task = CalendarTask {
        title: title.to_string(),
        notes: str_arg(args, "notes").unwrap_or_default().to_string(),
        due,
        project_id,
        column,
        tags,
        ..Default::default()
    };
    task_upsert(&crate::commands::calendar::create_task_at(stores.calendar, task)?)
}

fn todo_complete(stores: &Stores, args: &Value) -> Result<(Value, Change), String> {
    let id = str_arg(args, "id").ok_or("`id` is required")?;
    let mut task = find_task(stores, id)?;
    task.completed = Some(completion_stamp(&task, args)?);
    task.percent = 100;
    // `normalize` moves a completed card into the board's done column.
    task_upsert(&crate::commands::calendar::update_task_at(stores.calendar, task)?)
}

fn todo_reopen(stores: &Stores, args: &Value) -> Result<(Value, Change), String> {
    let id = str_arg(args, "id").ok_or("`id` is required")?;
    let mut task = find_task(stores, id)?;
    task.completed = None;
    task.percent = 0;
    // Empty: an open card cannot stay in the done column, and `normalize` files
    // an unplaced one into the board's intake column. An archived card keeps
    // its place — archives are exempt from the done coupling.
    let data = crate::commands::calendar::read_data(stores.calendar)?;
    if data.task_columns.iter().any(|c| c.done && c.id == task.column) {
        task.column = String::new();
        task.rank = None;
    }
    task_upsert(&crate::commands::calendar::update_task_at(stores.calendar, task)?)
}

fn todo_update(stores: &Stores, args: &Value) -> Result<(Value, Change), String> {
    let id = str_arg(args, "id").ok_or("`id` is required")?;
    let mut task = find_task(stores, id)?;
    // Present-but-empty clears; absent keeps. `str_arg` cannot tell the two apart.
    let given = |key: &str| args.get(key).and_then(Value::as_str).map(str::trim);
    if let Some(title) = given("title") {
        if title.is_empty() {
            return Err("`title` cannot be empty".into());
        }
        task.title = title.to_string();
    }
    if let Some(notes) = given("notes") {
        task.notes = notes.to_string();
    }
    if let Some(due) = given("due") {
        task.due = if due.is_empty() { None } else { Some(parse_due(due)?) };
    }
    if let Some(project) = given("project") {
        task.project_id = if project.is_empty() {
            String::new()
        } else {
            resolve_project(stores.projects, project)?
        };
    }
    if let Some(tags) = args.get("tags").and_then(Value::as_array) {
        task.tags = tags.iter().filter_map(Value::as_str).map(str::to_string).collect();
    }
    if let Some(priority) = args.get("priority").and_then(Value::as_i64) {
        if !(0..=9).contains(&priority) {
            return Err("`priority` must be between 0 and 9".into());
        }
        task.priority = priority as u8;
    }
    task_upsert(&crate::commands::calendar::update_task_at(stores.calendar, task)?)
}

/// A move can change more than the card it names (a column reindex), so every
/// changed row goes to the window; the reply is the moved card alone.
fn todo_move(stores: &Stores, args: &Value) -> Result<(Value, Vec<Change>), String> {
    let id = str_arg(args, "id").ok_or("`id` is required")?;
    let wanted = str_arg(args, "column").ok_or("`column` is required")?;
    let index = match args.get("position") {
        None | Some(Value::Null) => u32::MAX,
        Some(v) => v
            .as_u64()
            .map(|n| n.min(u64::from(u32::MAX)) as u32)
            .ok_or("`position` must be a non-negative integer")?,
    };
    // Resolve against the board the move itself is about to seed, so a column
    // can be named on a file that has never been dragged on.
    let mut data = crate::commands::calendar::read_data(stores.calendar)?;
    data.ensure_board();
    data.normalize();
    let column = resolve_column(&data, wanted)?;
    let task = data
        .tasks
        .iter()
        .find(|t| t.id == id)
        .ok_or_else(|| format!("card '{id}' not found"))?;
    let placement = crate::commands::calendar::TaskPlacement {
        id: id.to_string(),
        column,
        index,
        completed_stamp: Some(completion_stamp(task, args)?),
    };
    let was_done = task.percent >= 100;
    let changed = crate::commands::calendar::move_tasks_at(stores.calendar, vec![placement])?;
    let moved = match changed.iter().find(|t| t.id == id) {
        Some(task) => task.clone(),
        // Already in that slot: nothing changed, which is still a success.
        None => find_task(stores, id)?,
    };
    let changes = changed
        .iter()
        .map(|t| {
            // Only a move that completed or reopened the card changed anything a
            // server holds; the neighbours of a reindex never did.
            let local = t.id != id || (t.percent >= 100) == was_done;
            task_upsert(t).map(|(_, change)| Change { local, ..change })
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok((serde_json::to_value(&moved).map_err(|e| e.to_string())?, changes))
}

fn todo_delete(stores: &Stores, args: &Value) -> Result<(Value, Change), String> {
    let id = str_arg(args, "id").ok_or("`id` is required")?;
    // The row rides along, as for an event: the CalDAV copy is addressed by it.
    let row = serde_json::to_value(find_task(stores, id)?).map_err(|e| e.to_string())?;
    crate::commands::calendar::delete_task_at(stores.calendar, id)?;
    Ok((json!({ "deleted": id }), Change { kind: "task", op: "delete", row, local: false }))
}

/// Show one of the header overlays. Each has a settings gate the window's host
/// applies on its own, so a call against a closed gate would report success and
/// show nothing — the gate is read here to answer truthfully instead.
fn overlay_open(stores: &Stores, overlay: &'static str, args: &Value) -> Result<(Value, OverlayOpen), String> {
    // A missing or unreadable file is a fresh install: every gate at its default.
    let settings: crate::schema::Settings = crate::storage::read_json(stores.settings).unwrap_or_default();
    let (on, what) = match overlay {
        "mail" => (settings.mail_client(), "the mail client"),
        "calendar" => (settings.calendar_global_app.unwrap_or(false), "the calendar's header button"),
        _ => (settings.todo_board.unwrap_or(false), "the to-do board"),
    };
    if !on {
        return Err(format!("{what} is switched off in Eldrun's Settings; the user has to turn it on first"));
    }
    let task_id = match (overlay, str_arg(args, "id")) {
        ("todo", Some(id)) => Some(find_task(stores, id)?.id),
        _ => None,
    };
    Ok((json!({ "opened": overlay }), OverlayOpen { overlay, task_id }))
}

fn call_tool(stores: &Stores, name: &str, args: &Value) -> Result<(Value, Effects), String> {
    let opened = |r: Result<(Value, OverlayOpen), String>| {
        r.map(|(v, open)| (v, Effects { changes: Vec::new(), open: Some(open) }))
    };
    match name {
        "mail_open" => return opened(overlay_open(stores, "mail", args)),
        "calendar_open" => return opened(overlay_open(stores, "calendar", args)),
        "todo_open" => return opened(overlay_open(stores, "todo", args)),
        _ => {}
    }
    call_store_tool(stores, name, args).map(|(v, changes)| (v, Effects::wrote(changes)))
}

fn call_store_tool(stores: &Stores, name: &str, args: &Value) -> Result<(Value, Vec<Change>), String> {
    let wrote = |r: Result<(Value, Change), String>| r.map(|(v, c)| (v, vec![c]));
    match name {
        "projects_list" => projects_list(stores).map(|v| (v, Vec::new())),
        "calendar_list" => calendar_list(stores, args).map(|v| (v, Vec::new())),
        "calendar_add_event" => wrote(calendar_add_event(stores, args)),
        "calendar_delete_event" => wrote(calendar_delete_event(stores, args)),
        "todo_list" => todo_list(stores, args).map(|v| (v, Vec::new())),
        "todo_add" => wrote(todo_add(stores, args)),
        "todo_complete" => wrote(todo_complete(stores, args)),
        "todo_reopen" => wrote(todo_reopen(stores, args)),
        "todo_update" => wrote(todo_update(stores, args)),
        "todo_move" => todo_move(stores, args),
        "todo_delete" => wrote(todo_delete(stores, args)),
        other => Err(format!("unknown tool '{other}'")),
    }
}

// ── JSON-RPC ────────────────────────────────────────────────────────────────

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// Answer one JSON-RPC message. `None` for a notification (no `id`), which MCP
/// answers with `202 Accepted` and no body. Blocking: it reads and writes files.
pub fn handle_message(stores: &Stores, message: &Value) -> (Option<Value>, Effects) {
    let Some(id) = message.get("id").filter(|v| !v.is_null()).cloned() else {
        return (None, Effects::default());
    };
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    let ok = |result: Value| Some(json!({ "jsonrpc": "2.0", "id": id.clone(), "result": result }));
    match method {
        "initialize" => (
            ok(json!({
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": { "tools": {} },
                "serverInfo": { "name": SERVER_NAME, "version": env!("CARGO_PKG_VERSION") },
                "instructions": "Eldrun's cross-project console: the user's projects, calendar and to-do board, and the window's mail, calendar and to-do overlays. Times are local wall-clock, never UTC.",
            })),
            Effects::default(),
        ),
        "ping" => (ok(json!({})), Effects::default()),
        "tools/list" => (ok(json!({ "tools": tool_definitions() })), Effects::default()),
        "tools/call" => {
            let params = message.get("params").cloned().unwrap_or(Value::Null);
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let empty = json!({});
            let args = params.get("arguments").unwrap_or(&empty);
            // A failed tool is a *result* with `isError`, not a protocol error:
            // that is what lets the model read the message and correct itself.
            match call_tool(stores, name, args) {
                Ok((value, effects)) => (
                    ok(json!({
                        "content": [{ "type": "text", "text": value.to_string() }],
                        "isError": false,
                    })),
                    effects,
                ),
                Err(error) => (
                    ok(json!({
                        "content": [{ "type": "text", "text": error }],
                        "isError": true,
                    })),
                    Effects::default(),
                ),
            }
        }
        _ => (Some(rpc_error(id, -32601, "method not found")), Effects::default()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn opts(cmd: &str, args: &[&str], project_id: Option<&str>) -> PtyOptions {
        PtyOptions {
            cmd: cmd.to_string(),
            args: args.iter().map(|s| s.to_string()).collect(),
            project_id: project_id.map(str::to_string),
            env: HashMap::new(),
            id: "root:t".to_string(),
            cwd: String::new(),
            cols: 80,
            rows: 24,
            local_only: false,
            sandbox: false,
            agent: true,
            remote_host_id: None,
            tmux_session: None,
            tmux_attach: None,
            host_bound_uid: None,
        }
    }

    fn rt() -> Runtime {
        Runtime { port: 4321, token: "tok".into() }
    }

    struct Fixture {
        _dir: tempfile::TempDir,
        calendar: std::path::PathBuf,
        projects: std::path::PathBuf,
        settings: std::path::PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let calendar = dir.path().join("calendar.json");
            let projects = dir.path().join("projects.json");
            std::fs::write(
                &projects,
                r#"[{"id":"p1","name":"Alpha","status":"active","position":0,"local_file":"","directory":"/w/alpha"},
                    {"id":"p2","name":"Beta","status":"inactive","position":1,"local_file":"","remote":{"host":"h"}}]"#,
            )
            .unwrap();
            let settings = dir.path().join("settings.json");
            Fixture { _dir: dir, calendar, projects, settings }
        }
        fn stores(&self) -> Stores<'_> {
            Stores { calendar: &self.calendar, projects: &self.projects, settings: &self.settings }
        }
        fn call_fx(&self, name: &str, args: Value) -> (Value, Effects) {
            let msg = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call",
                              "params": { "name": name, "arguments": args } });
            let (reply, effects) = handle_message(&self.stores(), &msg);
            (reply.unwrap()["result"].clone(), effects)
        }
        fn call(&self, name: &str, args: Value) -> (Value, Vec<Change>) {
            let (result, effects) = self.call_fx(name, args);
            (result, effects.changes)
        }
    }

    fn text(result: &Value) -> Value {
        serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap_or(Value::Null)
    }

    #[test]
    fn only_a_root_scope_agent_is_a_root_agent() {
        assert!(is_root_agent(&opts("claude", &[], None), true));
        assert!(!is_root_agent(&opts("claude", &[], Some("p1")), true));
        assert!(!is_root_agent(&opts("claude", &[], Some("box:b")), true));
        // A root *shell* is not an agent and gets nothing.
        assert!(!is_root_agent(&opts("bash", &[], None), false));
    }

    #[test]
    fn claude_gets_an_inline_config_last_in_argv() {
        let mut o = opts("claude", &["--resume", "abc"], None);
        apply_to_spawn_with(&mut o, &rt());
        assert_eq!(&o.args[..2], ["--resume", "abc"]);
        assert_eq!(o.args[2], "--mcp-config");
        let cfg: Value = serde_json::from_str(&o.args[3]).unwrap();
        let server = &cfg["mcpServers"]["eldrun"];
        assert_eq!(server["url"], "http://127.0.0.1:4321/mcp");
        assert_eq!(server["headers"]["Authorization"], "Bearer tok");
        assert_eq!(o.env[TOKEN_ENV], "tok");
        // A respawn that re-runs the wiring must not stack the flag.
        apply_to_spawn_with(&mut o, &rt());
        assert_eq!(o.args.iter().filter(|a| *a == "--mcp-config").count(), 1);
    }

    #[test]
    fn codex_overrides_precede_the_resume_subcommand_and_name_the_token() {
        let mut o = opts("/usr/bin/codex", &["resume", "abc"], None);
        apply_to_spawn_with(&mut o, &rt());
        assert_eq!(o.args[0], "-c");
        assert_eq!(o.args[1], "mcp_servers.eldrun.url=\"http://127.0.0.1:4321/mcp\"");
        assert_eq!(o.args[3], "mcp_servers.eldrun.bearer_token_env_var=\"ELDRUN_ROOT_MCP_TOKEN\"");
        assert_eq!(&o.args[4..], ["resume", "abc"]);
        assert!(!o.args.iter().any(|a| a.contains("tok\"")), "the token is never in Codex's argv");
    }

    #[test]
    fn other_agents_get_the_env_pair_only() {
        let mut o = opts("gemini", &[], None);
        apply_to_spawn_with(&mut o, &rt());
        assert!(o.args.is_empty());
        assert_eq!(o.env[URL_ENV], "http://127.0.0.1:4321/mcp");
    }

    #[test]
    fn bearer_check() {
        assert!(authorized(Some("Bearer tok"), "tok"));
        assert!(!authorized(Some("Bearer to"), "tok"));
        assert!(!authorized(Some("tok"), "tok"));
        assert!(!authorized(None, "tok"));
    }

    #[test]
    fn minted_tokens_are_long_and_distinct() {
        let (a, b) = (mint_token().unwrap(), mint_token().unwrap());
        assert_eq!(a.len(), 64);
        assert_ne!(a, b);
    }

    #[test]
    fn notifications_get_no_reply_and_unknown_methods_an_error() {
        let f = Fixture::new();
        let (reply, _) = handle_message(&f.stores(), &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }));
        assert!(reply.is_none());
        let (reply, _) = handle_message(&f.stores(), &json!({ "jsonrpc": "2.0", "id": 7, "method": "nope" }));
        assert_eq!(reply.unwrap()["error"]["code"], -32601);
    }

    #[test]
    fn tools_list_matches_the_advertised_names() {
        let f = Fixture::new();
        let (reply, _) = handle_message(&f.stores(), &json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }));
        let listed: Vec<String> = reply.unwrap()["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(listed, tool_names());
    }

    #[test]
    fn only_the_list_tools_are_annotated_read_only() {
        let tools = tool_definitions();
        let tools = tools.as_array().unwrap();
        assert_eq!(tools.len(), tool_names().len());
        for tool in tools {
            let name = tool["name"].as_str().unwrap();
            let hints = &tool["annotations"];
            assert_eq!(hints["readOnlyHint"], name.ends_with("_list") || name.ends_with("_open"), "{name}");
            if name.ends_with("_delete") || name.ends_with("_delete_event") {
                assert_eq!(hints["destructiveHint"], true, "{name}");
            }
        }
    }

    #[test]
    fn an_event_defaults_to_one_hour_and_rolls_midnight() {
        let f = Fixture::new();
        let (result, change) = f.call("calendar_add_event", json!({ "title": "Review", "start": "2026-09-18T23:30:00" }));
        assert_eq!(result["isError"], false);
        let row = text(&result);
        assert_eq!(row["start"], "2026-09-18T23:30");
        assert_eq!(row["end"], "2026-09-19T00:30");
        let change = change.into_iter().next().unwrap();
        assert_eq!((change.kind, change.op), ("event", "upsert"));
        assert_eq!(change.row["id"], row["id"]);

        let (listed, _) = f.call("calendar_list", json!({ "from": "2026-09-18", "to": "2026-09-19" }));
        assert_eq!(text(&listed)["events"].as_array().unwrap().len(), 1);
        let (listed, _) = f.call("calendar_list", json!({ "from": "2026-09-19" }));
        assert_eq!(text(&listed)["events"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn explicit_duration_all_day_and_bad_input() {
        let f = Fixture::new();
        let (r, _) = f.call("calendar_add_event", json!({ "title": "A", "start": "2026-09-18T09:00", "duration_minutes": 90 }));
        assert_eq!(text(&r)["end"], "2026-09-18T10:30");
        let (r, _) = f.call("calendar_add_event", json!({ "title": "B", "start": "2026-09-30", "all_day": true }));
        assert_eq!(text(&r)["end"], "2026-10-01");

        for bad in [
            json!({ "title": "x", "start": "tomorrow" }),
            json!({ "title": "x", "start": "2026-13-01T09:00" }),
            json!({ "title": "x", "start": "2026-09-18T09:00", "end": "2026-09-18T08:00" }),
            json!({ "title": "x", "start": "2026-09-18T09:00", "duration_minutes": 0 }),
            json!({ "start": "2026-09-18T09:00" }),
            json!({ "title": "x", "start": "2026-09-18T09:00", "calendar": "nope" }),
        ] {
            let (r, change) = f.call("calendar_add_event", bad.clone());
            assert_eq!(r["isError"], true, "{bad}");
            assert!(change.is_empty());
        }
    }

    #[test]
    fn deleting_an_event_hands_the_row_over() {
        let f = Fixture::new();
        let (r, _) = f.call("calendar_add_event", json!({ "title": "Gone", "start": "2026-09-18T09:00" }));
        let id = text(&r)["id"].as_str().unwrap().to_string();
        let (r, change) = f.call("calendar_delete_event", json!({ "id": id }));
        assert_eq!(r["isError"], false);
        let change = change.into_iter().next().unwrap();
        assert_eq!(change.op, "delete");
        assert_eq!(change.row["title"], "Gone");
        let (r, _) = f.call("calendar_delete_event", json!({ "id": id }));
        assert_eq!(r["isError"], true);
    }

    #[test]
    fn a_card_links_to_a_project_by_name_and_completes() {
        let f = Fixture::new();
        let (r, change) = f.call("todo_add", json!({ "title": "Ship", "project": "alpha", "due": "2026-09-20" }));
        assert_eq!(r["isError"], false);
        let card = text(&r);
        assert_eq!(card["project_id"], "p1");
        assert_eq!(change[0].kind, "task");

        let (r, _) = f.call("todo_list", json!({ "project": "Beta" }));
        assert_eq!(text(&r)["cards"].as_array().unwrap().len(), 0);
        let (r, _) = f.call("todo_add", json!({ "title": "x", "project": "Gamma" }));
        assert_eq!(r["isError"], true);

        let id = card["id"].as_str().unwrap();
        let (r, _) = f.call("todo_complete", json!({ "id": id, "completed_at": "2026-09-17T12:00" }));
        assert_eq!(text(&r)["completed"], "2026-09-17T12:00");
        let (r, _) = f.call("todo_list", json!({}));
        assert_eq!(text(&r)["cards"].as_array().unwrap().len(), 0);
    }

    fn add_card(f: &Fixture, title: &str) -> String {
        let (r, _) = f.call("todo_add", json!({ "title": title }));
        text(&r)["id"].as_str().unwrap().to_string()
    }

    fn column_id(f: &Fixture, pick: impl Fn(&Value) -> bool) -> String {
        let data: Value = crate::storage::read_json(&f.calendar).unwrap();
        let cols = data["task_columns"].as_array().unwrap();
        cols.iter().find(|c| pick(c)).unwrap()["id"].as_str().unwrap().to_string()
    }

    #[test]
    fn a_card_is_edited_field_by_field_and_cleared_by_an_empty_string() {
        let f = Fixture::new();
        let (r, _) = f.call("todo_add", json!({ "title": "Draft", "notes": "n", "due": "2026-09-20", "project": "p1", "tags": ["a"] }));
        let id = text(&r)["id"].as_str().unwrap().to_string();

        let (r, change) = f.call("todo_update", json!({ "id": id, "title": "Final", "priority": 1, "tags": ["b", "c"] }));
        assert_eq!(r["isError"], false);
        let card = text(&r);
        assert_eq!(card["title"], "Final");
        assert_eq!(card["priority"], 1);
        assert_eq!(card["tags"], json!(["b", "c"]));
        // Untouched fields survive.
        assert_eq!((card["notes"].clone(), card["due"].clone(), card["project_id"].clone()), (json!("n"), json!("2026-09-20"), json!("p1")));
        assert_eq!((change[0].kind, change[0].op, change[0].local), ("task", "upsert", false));

        let (r, _) = f.call("todo_update", json!({ "id": id, "notes": "", "due": "", "project": "" }));
        let card = text(&r);
        assert!(card.get("notes").is_none() && card.get("due").is_none() && card.get("project_id").is_none());

        for bad in [
            json!({ "id": id, "title": " " }),
            json!({ "id": id, "due": "soon" }),
            json!({ "id": id, "priority": 12 }),
            json!({ "id": id, "project": "Gamma" }),
            json!({ "id": "nope", "title": "x" }),
        ] {
            let (r, change) = f.call("todo_update", bad.clone());
            assert_eq!(r["isError"], true, "{bad}");
            assert!(change.is_empty());
        }
        let (r, _) = f.call("todo_list", json!({}));
        assert_eq!(text(&r)["cards"][0]["title"], "Final", "a refused edit wrote nothing");
    }

    #[test]
    fn deleting_a_card_hands_the_row_over() {
        let f = Fixture::new();
        let id = add_card(&f, "Gone");
        let (r, change) = f.call("todo_delete", json!({ "id": id }));
        assert_eq!(text(&r)["deleted"], id.as_str());
        assert_eq!((change[0].kind, change[0].op), ("task", "delete"));
        assert_eq!(change[0].row["title"], "Gone");
        let (r, change) = f.call("todo_delete", json!({ "id": id }));
        assert_eq!(r["isError"], true);
        assert!(change.is_empty());
    }

    #[test]
    fn a_move_seeds_the_board_completes_into_done_and_reopens_out_of_it() {
        let f = Fixture::new();
        let (a, b) = (add_card(&f, "A"), add_card(&f, "B"));

        // The file has no board yet; the move creates it and the name resolves.
        let (r, change) = f.call("todo_move", json!({ "id": a, "column": "done", "completed_at": "2026-09-17T12:00" }));
        assert_eq!(r["isError"], false, "{r}");
        let done = column_id(&f, |c| c["done"] == true);
        let card = text(&r);
        assert_eq!((card["column"].as_str(), card["percent"].as_i64()), (Some(done.as_str()), Some(100)));
        assert_eq!(card["completed"], "2026-09-17T12:00");
        let moved = change.iter().find(|c| c.row["id"] == a.as_str()).unwrap();
        assert!(!moved.local, "a completion is something a server stores");

        // Reopen: out of done, no stamp left behind.
        let (r, _) = f.call("todo_reopen", json!({ "id": a }));
        let card = text(&r);
        assert_eq!(card["percent"], 0);
        assert!(card.get("completed").is_none());
        assert_ne!(card["column"], done.as_str());

        // A plain reorder is board-only, and a replay changes nothing.
        let home = text(&f.call("todo_list", json!({})).0)["cards"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["id"] == b.as_str())
            .unwrap()["column"]
            .as_str()
            .unwrap()
            .to_string();
        let (r, change) = f.call("todo_move", json!({ "id": b, "column": home, "position": 0 }));
        assert_eq!(r["isError"], false);
        assert!(change.iter().all(|c| c.local));
        let (r, change) = f.call("todo_move", json!({ "id": b, "column": home, "position": 0 }));
        assert_eq!(text(&r)["id"], b.as_str());
        assert!(change.is_empty());

        // Moving out of done reopens, which is not board-only.
        f.call("todo_complete", json!({ "id": b }));
        let (r, change) = f.call("todo_move", json!({ "id": b, "column": home }));
        assert_eq!(text(&r)["percent"], 0);
        assert!(!change.iter().find(|c| c.row["id"] == b.as_str()).unwrap().local);

        for bad in [
            json!({ "id": b, "column": "nowhere" }),
            json!({ "id": "nope", "column": home }),
            json!({ "id": b, "column": home, "position": -1 }),
            json!({ "id": b }),
        ] {
            let (r, change) = f.call("todo_move", bad.clone());
            assert_eq!(r["isError"], true, "{bad}");
            assert!(change.is_empty());
        }
    }

    #[test]
    fn an_overlay_opens_only_behind_its_own_settings_gate() {
        let f = Fixture::new();
        // No settings file: every gate at its default, which is off.
        for tool in ["mail_open", "calendar_open", "todo_open"] {
            let (r, fx) = f.call_fx(tool, json!({}));
            assert_eq!(r["isError"], true, "{tool}");
            assert!(fx.open.is_none() && fx.changes.is_empty());
        }

        // Mail is experimental: unset follows debug mode, an explicit off wins.
        std::fs::write(&f.settings, r#"{"debug":true,"calendar_global_app":true}"#).unwrap();
        let (r, fx) = f.call_fx("mail_open", json!({}));
        assert_eq!(text(&r)["opened"], "mail");
        assert_eq!(fx.open, Some(OverlayOpen { overlay: "mail", task_id: None }));
        let (_, fx) = f.call_fx("calendar_open", json!({}));
        assert_eq!(fx.open.unwrap().overlay, "calendar");
        assert_eq!(f.call_fx("todo_open", json!({})).0["isError"], true, "debug mode is not the board's gate");
        std::fs::write(&f.settings, r#"{"debug":true,"mail_client":false}"#).unwrap();
        assert_eq!(f.call_fx("mail_open", json!({})).0["isError"], true);
    }

    #[test]
    fn the_board_opens_on_a_card_that_exists() {
        let f = Fixture::new();
        std::fs::write(&f.settings, r#"{"todo_board":true}"#).unwrap();
        let id = add_card(&f, "Look here");
        let (r, fx) = f.call_fx("todo_open", json!({ "id": id }));
        assert_eq!(r["isError"], false);
        assert!(fx.changes.is_empty(), "showing a card writes nothing");
        assert_eq!(fx.open, Some(OverlayOpen { overlay: "todo", task_id: Some(id) }));
        let (_, fx) = f.call_fx("todo_open", json!({}));
        assert_eq!(fx.open, Some(OverlayOpen { overlay: "todo", task_id: None }));
        let (r, fx) = f.call_fx("todo_open", json!({ "id": "nope" }));
        assert_eq!(r["isError"], true);
        assert!(fx.open.is_none());
    }

    #[test]
    fn projects_list_reports_remoteness_and_hides_nothing_else() {
        let f = Fixture::new();
        let (r, _) = f.call("projects_list", json!({}));
        let projects = text(&r)["projects"].clone();
        assert_eq!(projects[0]["directory"], "/w/alpha");
        assert_eq!(projects[0]["remote"], false);
        assert_eq!(projects[1]["remote"], true);
    }
}
