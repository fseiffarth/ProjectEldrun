//! MCP authorization is backend policy, never a model instruction or a hint.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;

use super::root_mcp::Caller;

pub const MAX_BODY: usize = 128 * 1024;
pub const MAX_RESPONSE: usize = 512 * 1024;
pub const MAX_ROWS: usize = 100;
pub const MAX_PENDING: usize = 500;
pub const MAX_PENDING_PER_TAB: usize = 100;
pub const MAX_LOG_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, Serialize)]
pub struct Audit {
    pub session: String,
    pub caller: Caller,
    pub tool: String,
    pub outcome: &'static str,
    pub elapsed_ms: u64,
    pub time: u64,
    pub target: Option<String>,
    pub reason: Option<&'static str>,
}
static AUDIT: std::sync::Mutex<std::collections::VecDeque<Audit>> =
    std::sync::Mutex::new(std::collections::VecDeque::new());
pub fn audit(
    session: &super::root_mcp::Session,
    name: &str,
    outcome: &'static str,
    elapsed: std::time::Duration,
) {
    audit_reason(session, name, outcome, elapsed, None);
}

pub fn audit_reason(session: &super::root_mcp::Session, name: &str, outcome: &'static str, elapsed: std::time::Duration, reason: Option<&'static str>) {
    let mut rows = AUDIT.lock().unwrap_or_else(|p| p.into_inner());
    if rows.len() >= 500 {
        rows.pop_front();
    }
    rows.push_back(Audit {
        target: session.identity.schedule_target.as_ref().map(|b| b.target.clone()),
        reason,
        session: session.id.clone(),
        caller: session.identity.caller,
        // Do not echo arbitrary method names (which may contain private text).
        tool: if tool(name).is_some() || super::schedule_mcp::tool_names().contains(&name) {
            name
        } else {
            "protocol"
        }
        .into(),
        outcome,
        elapsed_ms: elapsed.as_millis().min(u64::MAX as u128) as u64,
        time: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
    });
}
pub fn audit_rows() -> Vec<Audit> {
    AUDIT
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .iter()
        .cloned()
        .collect()
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Policy {
    pub enabled: bool,
    pub local_only: bool,
    pub mail: bool,
    /// `Settings::root_mcp_mail_local_only`: mail for local-model tabs only.
    pub mail_local_only: bool,
    pub review: String,
}
impl Policy {
    pub fn load(path: &Path) -> Result<Self, String> {
        // Missing is NOT evidence of a fresh install: the file may have been
        // removed mid-session. Spawn and requests both refuse until initialized.
        let settings: crate::schema::Settings = crate::storage::read_json(path)
            .map_err(|_| "MCP security settings are unavailable".to_string())?;
        Ok(Self::from_settings(&settings))
    }
    pub fn from_settings(s: &crate::schema::Settings) -> Self {
        Self {
            enabled: s.root_mcp(),
            local_only: s.root_mcp_local_only(),
            mail: s.root_mcp_mail(),
            mail_local_only: s.root_mcp_mail_local_only(),
            review: s
                .root_mcp_review
                .as_deref()
                .filter(|v| matches!(*v, "all" | "destructive" | "off"))
                .unwrap_or("all")
                .to_string(),
        }
    }
    pub fn serves(&self, caller: Caller) -> bool {
        if caller == Caller::Scheduler { return false; }
        self.enabled
            && (!self.local_only || caller == Caller::LocalModel)
            && (caller != Caller::Reader || self.serves_mail(caller))
    }
    /// Whether `caller` is listed and served the mail tools. Only the mail
    /// switch and its local-only companion decide it; [`Self::serves`] still
    /// gates the endpoint as a whole. A reader is never a local model, so
    /// local-only mail serves it nothing.
    pub fn serves_mail(&self, caller: Caller) -> bool {
        self.mail && (!self.mail_local_only || caller == Caller::LocalModel)
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Scope {
    pub all: bool,
    pub ids: Vec<String>,
}
impl Scope {
    pub fn contains(&self, id: &str) -> bool {
        self.all || self.ids.iter().any(|v| v == id)
    }
    fn unrestricted() -> Self {
        Self {
            all: true,
            ids: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Access {
    pub calendars: Scope,
    pub projects: Scope,
    pub accounts: Scope,
    pub families: Vec<String>,
    pub write: bool,
}
impl Access {
    pub fn initial(caller: Caller) -> Self {
        let reader = caller == Caller::Reader;
        Self {
            calendars: if reader {
                Scope::default()
            } else {
                Scope::unrestricted()
            },
            projects: if reader {
                Scope::default()
            } else {
                Scope::unrestricted()
            },
            accounts: Scope::unrestricted(),
            families: if reader {
                vec!["mail".into()]
            } else {
                vec![
                    "calendar".into(),
                    "board".into(),
                    "projects".into(),
                    "mail".into(),
                ]
            },
            write: true,
        }
    }
    pub fn validate(&self) -> Result<(), String> {
        if self.families.len() > 4
            || self
                .families
                .iter()
                .any(|f| !matches!(f.as_str(), "calendar" | "board" | "projects" | "mail"))
            || [&self.calendars, &self.projects, &self.accounts]
                .iter()
                .any(|s| s.ids.len() > 1000 || s.ids.iter().any(|id| id.len() > 256))
        {
            return Err("Invalid MCP access grant".into());
        }
        Ok(())
    }
    pub fn allows(&self, caller: Caller, name: &str) -> bool {
        tool(name).is_some_and(|t| {
            t.serves(caller)
                && (t.family == "session" || self.families.iter().any(|f| f == t.family))
                && (!t.write || self.write)
        })
    }
    pub fn row(&self, kind: &str, row: &Value) -> bool {
        let id = |key: &str| row[key].as_str().unwrap_or("");
        match kind {
            "event" => self.calendars.contains(id("calendar_id")),
            "task" => {
                self.calendars.contains(id("calendar_id"))
                    && self.projects.contains(id("project_id"))
            }
            "calendar" => self.calendars.contains(id("id")),
            // Changing shared board structure requires the entire board scope.
            "board" => self.calendars.all && self.projects.all,
            _ => false,
        }
    }
    pub fn filter_calendar(&self, data: &mut Value) {
        for (key, kind) in [
            ("events", "event"),
            ("tasks", "task"),
            ("calendars", "calendar"),
        ] {
            if let Some(rows) = data[key].as_array_mut() {
                rows.retain(|r| self.row(kind, r));
            }
        }
    }
}

pub struct ToolPolicy {
    pub family: &'static str,
    pub write: bool,
    pub destructive: bool,
    root: bool,
    reader: bool,
}
impl ToolPolicy {
    pub fn serves(&self, caller: Caller) -> bool {
        if caller == Caller::Scheduler { return false; }
        if caller == Caller::Reader {
            self.reader
        } else {
            self.root
        }
    }
}

/// Every name must be deliberately assigned. Unknown names never inherit a role.
pub fn tool(name: &str) -> Option<ToolPolicy> {
    let (family, write, destructive, root, reader) = match name {
        "proposals_list" => ("session", false, false, true, true),
        "projects_list"
        | "projects_git_status"
        | "sync_status"
        | "time_summary"
        | "usage_recap"
        | "project_activity"
        | "boxes_list" => ("projects", false, false, true, false),
        "calendar_list" | "calendar_free_busy" => ("calendar", false, false, true, true),
        "calendar_create" | "calendar_add_event" => ("calendar", true, false, true, true),
        // Root only: a reader is handed no attachment, and a file's text must
        // not reach the calendar through it (`root_mcp_import`).
        "calendar_import_ics" => ("calendar", true, false, true, false),
        "calendar_update_event" | "calendar_move_events" | "calendar_delete_event" => {
            ("calendar", true, true, true, true)
        }
        "todo_list" => ("board", false, false, true, true),
        "todo_add" | "todo_complete" | "todo_reopen" | "todo_move" => {
            ("board", true, false, true, true)
        }
        "todo_update" | "todo_delete" => ("board", true, true, true, true),
        "mail_accounts_list" | "mail_drafts_list" => ("mail", false, false, true, true),
        "mail_folders" | "mail_search" | "mail_read" | "mail_thread" => {
            ("mail", false, false, false, true)
        }
        "mail_draft_create" => ("mail", true, false, true, true),
        "mail_draft_update" | "mail_draft_delete" => ("mail", true, true, true, true),
        _ => return None,
    };
    Some(ToolPolicy {
        family,
        write,
        destructive,
        root,
        reader,
    })
}

/// The schemas here use only these primitive types, required, enum, and bounds.
/// Reject additional arguments instead of silently ignoring misspellings.
pub fn validate(schema: &Value, value: &Value) -> Result<(), String> {
    let valid = match schema["type"].as_str() {
        Some("object") => value.is_object(),
        Some("array") => value.is_array(),
        Some("string") => value.is_string(),
        Some("boolean") => value.is_boolean(),
        Some("integer") => value.is_i64() || value.is_u64(),
        _ => false,
    };
    if !valid {
        return Err("Invalid argument type".into());
    }
    if let Some(s) = value.as_str() {
        // 32 KiB unless the schema names its own bound (a whole `.ics` file).
        let max = schema["maxLength"].as_u64().map_or(32 * 1024, |n| n as usize);
        if s.len() > max {
            return Err(format!("Argument text exceeds {} KiB", max / 1024));
        }
    }
    if let Some(n) = value.as_f64() {
        if schema["minimum"].as_f64().is_some_and(|min| n < min)
            || schema["maximum"].as_f64().is_some_and(|max| n > max)
        {
            return Err("Argument is outside its permitted range".into());
        }
    }
    if schema["enum"]
        .as_array()
        .is_some_and(|v| !v.contains(value))
    {
        return Err("Invalid argument choice".into());
    }
    if let Some(rows) = value.as_array() {
        if rows.len() > MAX_ROWS {
            return Err("Too many argument items".into());
        }
        for v in rows {
            validate(&schema["items"], v)?;
        }
    }
    if let Some(fields) = value.as_object() {
        if let Some(required) = schema["required"].as_array() {
            for key in required.iter().filter_map(Value::as_str) {
                if !fields.contains_key(key) {
                    return Err(format!("`{key}` is required"));
                }
            }
        }
        for (key, v) in fields {
            let property = schema["properties"].get(key).ok_or("Unknown argument")?;
            validate(property, v)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn settings_errors_do_not_reopen_access() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        assert!(Policy::load(&path).is_err());
        for invalid in ["{", "null", "{\"root_mcp\":\"true\"}"] {
            std::fs::write(&path, invalid).unwrap();
            assert!(Policy::load(&path).is_err());
        }
        std::fs::write(&path, "{}").unwrap();
        assert!(Policy::load(&path).unwrap().serves(Caller::Agent));
    }
    /// Every mail switch × local-only × class. The companion narrows mail
    /// only: it never widens it, never touches the other tools, and a reader
    /// (always a cloud CLI) loses the endpoint with it.
    #[test]
    fn mail_local_only_keeps_mail_to_local_models() {
        let classes = [Caller::Agent, Caller::LocalModel, Caller::Reader, Caller::Scheduler];
        for mail in [false, true] {
            for mail_local_only in [false, true] {
                let policy = Policy { enabled: true, local_only: false, mail, mail_local_only, review: "all".into() };
                for caller in classes {
                    let expected = mail && (!mail_local_only || caller == Caller::LocalModel);
                    assert_eq!(policy.serves_mail(caller), expected, "mail={mail} local={mail_local_only} {caller:?}");
                }
                assert_eq!(policy.serves(Caller::Reader), mail && !mail_local_only, "reader: mail={mail} local={mail_local_only}");
                assert!(policy.serves(Caller::Agent), "the other tools stay on: mail={mail} local={mail_local_only}");
                assert!(policy.serves(Caller::LocalModel));
                assert!(!policy.serves(Caller::Scheduler));
            }
        }
    }

    #[test]
    fn mail_local_only_is_read_from_settings_and_absent_means_off() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let load = |body: &str| {
            std::fs::write(&path, body).unwrap();
            Policy::load(&path).unwrap()
        };
        let off = load(r#"{"root_mcp_mail":true}"#);
        assert!(!off.mail_local_only);
        assert!(off.serves_mail(Caller::Agent) && off.serves_mail(Caller::Reader));
        let on = load(r#"{"root_mcp_mail":true,"root_mcp_mail_local_only":true}"#);
        assert!(on.mail_local_only);
        assert!(!on.serves_mail(Caller::Agent) && !on.serves_mail(Caller::Reader));
        assert!(on.serves_mail(Caller::LocalModel));
        // Alone it opens nothing: mail stays off until its own switch is on.
        let alone = load(r#"{"root_mcp_mail_local_only":true}"#);
        assert!(!alone.serves_mail(Caller::LocalModel));
        let explicit_off = load(r#"{"root_mcp_mail":true,"root_mcp_mail_local_only":false}"#);
        assert!(explicit_off.serves_mail(Caller::Agent));
        // A wrongly typed value is unreadable settings, which refuse everything.
        std::fs::write(&path, r#"{"root_mcp_mail":true,"root_mcp_mail_local_only":"yes"}"#).unwrap();
        assert!(Policy::load(&path).is_err());
    }

    #[test]
    fn new_tools_and_reader_data_are_denied() {
        assert!(tool("calendar_new_tool").is_none());
        for name in super::super::root_mcp::tool_names() {
            assert!(tool(name).is_some(), "unclassified tool: {name}");
        }
        let reader = Access::initial(Caller::Reader);
        assert!(!reader.allows(Caller::Reader, "calendar_list"));
        assert!(!reader.row("task", &json!({"project_id":"", "calendar_id":"default"})));
        let mut root = Access::initial(Caller::Agent);
        root.write = false;
        assert!(root.allows(Caller::Agent, "calendar_list"));
        assert!(!root.allows(Caller::Agent, "calendar_add_event"));
    }
}
