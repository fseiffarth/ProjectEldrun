//! The stored conversation behind an agent tab, read for the phone's Focus
//! view.
//!
//! Focus reads a session off the terminal screen: the rows tmux keeps, at
//! the desktop window's width, bounded by the pane's scrollback and cut short
//! by every full-screen redraw. The agent keeps a better record of the same
//! conversation — Claude's `~/.claude/projects/<cwd>/<id>.jsonl`, Codex's
//! rollout — in which every prompt and every answer is one record with a
//! timestamp, from the first turn on. This module turns that file into the
//! entries the phone lays out as a chat, resolved the same way the model tag
//! and the last-prompt line are ([`agent_session::read_agent_transcript`]):
//! the tab's own session, the live id (after a `/clear`) first — and, unlike
//! those, never the launch id's file once a live id is recorded, since after
//! a `/clear` that is the conversation the reader just cleared.
//!
//! What is read is deliberately narrow: the prompts the user submitted and
//! the text the agent answered with. Tool calls and their results, thinking
//! blocks, attachments, the reminders the CLI attaches to a prompt and the
//! notes it leaves for itself are not the conversation and are stepped over —
//! on a phone the answer is what is wanted, not the edit-by-edit status the
//! terminal shows beside it. Everything is bounded: a tail of the file, a cap
//! on the number of entries, a cap on the text of each. The file is written
//! by the agent and read onto a phone.
//!
//! A subagent the agent spawned is one `agent` entry in its place — what it
//! was sent to do and what kind of agent it is — carrying an opaque handle
//! ([`subagent_token`]) that reads *that* subagent's own conversation the same
//! way. Each CLI keeps them apart and says whose they are: Claude writes
//! `<session>/subagents/agent-<id>.jsonl` beside a `.meta.json` naming the tool
//! call that spawned it, Codex records a spawn edge per child thread in its
//! state store, OpenCode a `parent_id` per child session. A handle is only
//! ever resolved among the subagents of the tab's own session.
//!
//! A read answers with a `version` fingerprint of the file; a caller that
//! passes the one it last saw gets `unchanged` back without a parse, which is
//! what lets the phone poll while the agent is answering.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

use crate::services::agent_session::{self, TranscriptKind};

/// How much of a transcript's tail is read. A Claude session with a day of
/// tool results behind it runs to tens of megabytes, most of it tool output
/// this never shows; the tail holds the conversation a phone reader is
/// actually catching up on, and what fell before it is announced as
/// `truncated` rather than silently missing.
const TAIL_BYTES: u64 = 6 * 1024 * 1024;
/// Entries answered when the caller names no limit.
pub const DEFAULT_LIMIT: usize = 120;
/// The most entries one answer carries, whatever the caller asks for.
pub const MAX_LIMIT: usize = 1000;
/// Longest text of one prompt. The full prompt is the user's own words, so
/// the bound is generous; a pasted log is cut and marked.
const MAX_PROMPT_CHARS: usize = 6_000;
/// Longest text of one answer record (its text blocks joined).
const MAX_ANSWER_CHARS: usize = 12_000;
/// Longest task line on a subagent's entry: what it was sent to do, as a
/// title — the whole task is the first prompt of its own conversation.
const MAX_AGENT_CHARS: usize = 200;
/// Longest subagent kind (`Explore`, a Codex role, an OpenCode agent).
const MAX_ROLE_CHARS: usize = 48;
/// How deep a subagent's own subagents are followed.
pub(crate) const MAX_SUBAGENT_DEPTH: usize = 8;

/// One turn of the conversation as the phone shows it.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct TranscriptEntry {
    /// `prompt` (the user's), `answer` (the agent's text) or `agent` (a
    /// subagent it spawned; `text` is what it was sent to do).
    pub kind: String,
    pub text: String,
    /// The record's own timestamp, as written (RFC 3339), when it has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
    /// The text was cut at its bound; the entry shows what fit.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub cut: bool,
    /// On an `agent` entry: the handle that reads this subagent's own
    /// conversation ([`subagent_token`]). Absent while its CLI has not yet
    /// recorded where that conversation lives.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent: Option<String>,
    /// On an `agent` entry: the kind of subagent, as its CLI names it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
}

/// What a tab's stored session answers with. Always a value, never an error:
/// an agent that keeps no transcript Eldrun reads comes back `available:
/// false` with the reason, and the phone shows the screen instead.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentTranscript {
    pub available: bool,
    /// Why not, when `available` is false: `unsupported` (an agent whose
    /// transcript is not read), `no_session` (the tab has no session id yet),
    /// `no_transcript` (nothing on disk for it), `no_subagent` (the handle
    /// names no subagent of this session), `read_failed`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Fingerprint of the file the entries came from — pass it back to be
    /// answered `unchanged` while the file has not moved.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// The file is as the caller last saw it; `entries` is empty and stale
    /// content should be kept.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub unchanged: bool,
    #[serde(default)]
    pub entries: Vec<TranscriptEntry>,
    /// Earlier turns exist that this answer does not carry — beyond the tail
    /// read, or beyond the entry limit. A larger `limit` reaches the latter.
    #[serde(default)]
    pub truncated: bool,
    /// The session's own usage figures, where its transcript records them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<TranscriptUsage>,
}

/// What Claude's status line shows beside the model — context left, the
/// 5-hour and the weekly window — for a CLI that draws none of it on screen
/// but writes it down: Codex puts its rate limits and the context it used
/// into every `token_count` event of its rollout. Only figures the record
/// carried are set.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptUsage {
    /// Percent of the context window left, counted as Codex's own footer does.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_left: Option<u8>,
    /// The rolling session window (Codex's 5-hour one).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<UsageWindow>,
    /// The weekly window.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub week: Option<UsageWindow>,
}

/// One rate-limit window: how much of it is used, and when it rolls over.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    /// Percent used, 0–100.
    pub used: u8,
    /// Unix seconds of the reset, when the record gives one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<u64>,
}

impl AgentTranscript {
    pub fn unavailable(reason: &str) -> Self {
        Self {
            available: false,
            reason: Some(reason.to_string()),
            ..Default::default()
        }
    }
}

/// The stored conversation of the tab launched as `cmd` with launch id
/// `launch_id` in `tab_dir`: the last `limit` turns of its transcript, or
/// `unchanged` when `version` still names the file as it is. `subagent`, a
/// handle from one of its `agent` entries, reads that subagent's conversation
/// instead. `since` is the launch moment (epoch ms) of a tab opened fresh
/// rather than restored with its continue flag — only OpenCode, found by
/// folder, needs it. See [`AgentTranscript::reason`] for the ways this answers
/// without turns.
#[allow(clippy::too_many_arguments)]
pub fn agent_session_transcript(
    cmd: &str,
    project_id: Option<&str>,
    tab_dir: Option<&str>,
    since: Option<i64>,
    launch_id: &str,
    subagent: Option<&str>,
    version: Option<&str>,
    limit: usize,
) -> AgentTranscript {
    let limit = limit.clamp(1, MAX_LIMIT);
    if subagent.is_some_and(|token| !is_subagent_token(token)) {
        return AgentTranscript::unavailable("no_subagent");
    }
    if cmd == "opencode" {
        return opencode_transcript(project_id, tab_dir, since, subagent, version, limit);
    }
    let read = match cmd {
        "claude" => claude_transcript(project_id, launch_id, subagent, version, limit),
        "codex" => codex_transcript(project_id, launch_id, subagent, version, limit),
        _ => None,
    };
    if subagent.is_some() {
        return read.unwrap_or_else(|| AgentTranscript::unavailable("no_subagent"));
    }
    read.or_else(|| (cmd == "claude").then(|| fresh_claude_session(project_id, launch_id)).flatten())
        .or_else(|| (cmd == "codex").then(|| fresh_codex_session(project_id, launch_id)).flatten())
        .unwrap_or_else(|| {
            AgentTranscript::unavailable(if matches!(cmd, "claude" | "codex") {
                "no_transcript"
            } else {
                "unsupported"
            })
        })
}

/// The handle a subagent's entry carries: a digest of the id its CLI gave it,
/// so no id of the CLI's — a resume handle — crosses to the phone, and a
/// handle read back can only be matched against the subagents of the session
/// asked about, never followed as a name.
pub fn subagent_token(id: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(format!("eldrun-subagent:{id}").as_bytes());
    digest[..8].iter().map(|b| format!("{b:02x}")).collect()
}

/// A well-formed [`subagent_token`]: sixteen lowercase hex digits.
pub fn is_subagent_token(token: &str) -> bool {
    token.len() == 16 && token.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// The transcript file behind a Claude or Codex tab, resolved the way every
/// other read of it is ([`agent_session::read_agent_transcript_from`]), never
/// the launch id's once a live id is recorded.
fn session_file(cmd: &str, project_id: Option<&str>, launch_id: &str) -> Option<PathBuf> {
    agent_session::read_agent_transcript_from(
        cmd,
        project_id,
        launch_id,
        // Never the launch id's file once a live id is recorded: after a
        // `/clear` that file is the cleared conversation.
        false,
        |path, _| Some(path.to_path_buf()),
        // Codex's thread store keeps no messages (only a thread's first one),
        // so a release that writes no rollout has no conversation to read.
        |_, _| None,
    )
}

/// A Claude tab's conversation, or one of its subagents'. Claude keeps every
/// subagent of a session — a subagent's own included — in one folder beside
/// the session's file, `<id>/subagents/agent-<agent id>.jsonl`.
fn claude_transcript(
    project_id: Option<&str>,
    launch_id: &str,
    subagent: Option<&str>,
    version: Option<&str>,
    limit: usize,
) -> Option<AgentTranscript> {
    let main = session_file("claude", project_id, launch_id)?;
    let folder = main.with_extension("").join("subagents");
    let spawns = Spawns::Claude(&folder);
    match subagent {
        None => read_transcript_in(&main, TranscriptKind::Claude, &spawns, false, version, limit),
        Some(token) => {
            let file = claude_subagent_file(&folder, token)?;
            read_transcript_in(&file, TranscriptKind::Claude, &spawns, true, version, limit)
        }
    }
}

/// The subagent file in `folder` whose handle is `token`.
fn claude_subagent_file(folder: &Path, token: &str) -> Option<PathBuf> {
    std::fs::read_dir(folder).ok()?.flatten().map(|entry| entry.path()).find(|path| {
        path.file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| name.strip_prefix("agent-")?.strip_suffix(".jsonl"))
            .is_some_and(|id| subagent_token(id) == token)
    })
}

/// A Codex tab's conversation, or one of its subagents'. A subagent is a
/// thread of its own with a rollout of its own; which threads a thread
/// spawned is the state store's spawn-edge table
/// ([`crate::services::codex_store::spawned_threads`]).
fn codex_transcript(
    project_id: Option<&str>,
    launch_id: &str,
    subagent: Option<&str>,
    version: Option<&str>,
    limit: usize,
) -> Option<AgentTranscript> {
    let main = session_file("codex", project_id, launch_id)?;
    let thread = agent_session::read_live_session_for(project_id, launch_id)?;
    let stores = crate::services::codex_store::state_dbs(Some(project_id.unwrap_or("root")));
    let Some(token) = subagent else {
        let spawns = Spawns::Codex { stores: &stores, thread: &thread };
        return read_transcript_in(&main, TranscriptKind::Codex, &spawns, false, version, limit);
    };
    let child = stores.iter().find_map(|db| {
        crate::services::codex_store::descendant_threads(db, &thread, MAX_SUBAGENT_DEPTH)
            .into_iter()
            .find(|child| subagent_token(&child.id) == token)
    })?;
    let rollout = codex_rollout(&child)?;
    let spawns = Spawns::Codex { stores: &stores, thread: &child.id };
    read_transcript_in(&rollout, TranscriptKind::Codex, &spawns, false, version, limit)
}

/// A spawned thread's rollout: the path its row names, taken only when it is
/// a file under `~/.codex/sessions` whose name ends in the thread's id.
fn codex_rollout(thread: &crate::services::codex_store::SpawnedThread) -> Option<PathBuf> {
    let root = std::fs::canonicalize(crate::paths::home_dir().join(".codex").join("sessions")).ok()?;
    let path = std::fs::canonicalize(thread.rollout_path.as_deref()?).ok()?;
    let named = path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.ends_with(&format!("{}.jsonl", thread.id)));
    (named && path.starts_with(&root) && path.is_file()).then_some(path)
}

/// A Claude session the hook has recorded but Claude has not written yet —
/// right after a `/clear`, or a launch before its first turn: available and
/// empty, so the phone shows a fresh chat rather than the screen or the
/// conversation before it.
fn fresh_claude_session(project_id: Option<&str>, launch_id: &str) -> Option<AgentTranscript> {
    if !agent_session::is_uuid_shaped(launch_id) {
        return None;
    }
    let live = agent_session::read_live_session_for(project_id, launch_id)?;
    Some(AgentTranscript {
        available: true,
        version: Some(format!("new:{live}")),
        ..Default::default()
    })
}

/// A Codex tab whose session has not started yet: Codex mints its session id
/// itself and reports it to the hook only once the session starts, with its
/// first turn — so a new or restored tab has no id recorded until then.
/// Available and empty, as a fresh Claude session is, rather than "not found"
/// on every Codex tab until it is prompted. Local tabs only: a remote tab's
/// hook records on the remote host, never here, so it would wait forever.
fn fresh_codex_session(project_id: Option<&str>, launch_id: &str) -> Option<AgentTranscript> {
    if !agent_session::is_uuid_shaped(launch_id)
        || agent_session::read_live_session_for(project_id, launch_id).is_some()
        || project_id.is_some_and(|id| crate::services::remote::remote_target_for(id).is_some())
    {
        return None;
    }
    Some(AgentTranscript {
        available: true,
        version: Some(format!("new:{launch_id}")),
        ..Default::default()
    })
}

/// An OpenCode tab's conversation, from OpenCode's session store
/// (`services::opencode_store`): the newest session of the tab's folder —
/// created since `since` for a tab opened fresh, so it never shows the
/// folder's previous conversation — or, with `subagent`, one of the child
/// sessions it spawned. A remote tab's OpenCode writes a store on
/// the remote host, so it has none here to read.
fn opencode_transcript(
    project_id: Option<&str>,
    tab_dir: Option<&str>,
    since: Option<i64>,
    subagent: Option<&str>,
    version: Option<&str>,
    limit: usize,
) -> AgentTranscript {
    let Some(dir) = tab_dir.filter(|dir| Path::new(dir).is_absolute()) else {
        return AgentTranscript::unavailable("no_session");
    };
    if project_id.is_some_and(|id| crate::services::remote::remote_target_for(id).is_some()) {
        return AgentTranscript::unavailable("unsupported");
    }
    let db = crate::services::opencode_store::db_path();
    if !db.is_file() {
        return AgentTranscript::unavailable("no_transcript");
    }
    crate::services::opencode_store::session_transcript(&db, dir, since, subagent, version, limit)
        .unwrap_or_else(|| AgentTranscript::unavailable("read_failed"))
}

/// The file's fingerprint: its length and modification time. Both move on
/// every append, and neither costs a read.
fn fingerprint(meta: &std::fs::Metadata) -> String {
    let stamp = meta
        .modified()
        .ok()
        .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("{}:{stamp}", meta.len())
}

/// Where the subagents a transcript's agent spawned are found.
enum Spawns<'a> {
    /// None looked for.
    None,
    /// Claude: each `Agent` tool call in the transcript, matched to its
    /// subagent by the `.meta.json` Claude writes beside that subagent's file
    /// in this folder, naming the call.
    Claude(&'a Path),
    /// Codex: the threads `thread` spawned, per its state stores.
    Codex { stores: &'a [PathBuf], thread: &'a str },
}

/// Read the transcript at `path` — its tail, then the last `limit` entries.
/// `None` only when the file cannot be read; a session with no turn yet is an
/// empty, available transcript.
pub fn read_transcript(
    path: &Path,
    kind: TranscriptKind,
    version: Option<&str>,
    limit: usize,
) -> Option<AgentTranscript> {
    read_transcript_in(path, kind, &Spawns::None, false, version, limit)
}

/// [`read_transcript`], with the subagents it spawned as `agent` entries.
/// `sidechain` reads a Claude subagent's own file, every record of which is
/// flagged as one — the flag that keeps them out of the session's
/// conversation is what they all share there.
fn read_transcript_in(
    path: &Path,
    kind: TranscriptKind,
    spawns: &Spawns,
    sidechain: bool,
    version: Option<&str>,
    limit: usize,
) -> Option<AgentTranscript> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path).ok()?;
    let meta = file.metadata().ok()?;
    let mut current = fingerprint(&meta);
    // A subagent's `.meta.json` can land after the call that spawned it was
    // written, while the session's file sits still until the subagent is done.
    if let Spawns::Claude(folder) = spawns {
        if let Ok(folder) = std::fs::metadata(folder) {
            current = format!("{current}:{}", fingerprint(&folder));
        }
    }
    if version == Some(current.as_str()) {
        return Some(AgentTranscript {
            available: true,
            version: Some(current),
            unchanged: true,
            ..Default::default()
        });
    }
    let len = meta.len();
    let start = len.saturating_sub(TAIL_BYTES);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::with_capacity((len - start) as usize);
    file.read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf);
    let mut lines: Vec<&str> = text.lines().collect();
    let mut truncated = false;
    if start > 0 {
        // Whatever came before the seek point is missing from the first line.
        lines.remove(0);
        truncated = true;
    }
    let usage = match kind {
        TranscriptKind::Codex => codex_usage(&lines),
        TranscriptKind::Claude => None,
    };
    let (mut entries, calls) = parse_entries(lines.into_iter(), kind, sidechain);
    match spawns {
        Spawns::None => {}
        Spawns::Claude(folder) => {
            if !calls.is_empty() {
                let spawned = claude_spawned(folder);
                for (index, call) in calls {
                    entries[index].subagent = spawned.get(&call).map(|id| subagent_token(id));
                }
            }
        }
        Spawns::Codex { stores, thread } => {
            let children = stores
                .iter()
                .map(|db| crate::services::codex_store::spawned_threads(db, thread))
                .find(|children| !children.is_empty())
                .unwrap_or_default();
            let placed = children.iter().filter_map(codex_agent_entry).collect();
            insert_by_time(&mut entries, placed, truncated);
        }
    }
    if entries.len() > limit {
        let drop = entries.len() - limit;
        entries.drain(..drop);
        truncated = true;
    }
    Some(AgentTranscript {
        available: true,
        reason: None,
        version: Some(current),
        unchanged: false,
        entries,
        truncated,
        usage,
    })
}

/// The subagents in a Claude session's `folder`, by the tool call that
/// spawned each: `toolu_…` → the agent id its file is named by.
fn claude_spawned(folder: &Path) -> std::collections::HashMap<String, String> {
    let mut spawned = std::collections::HashMap::new();
    let Ok(entries) = std::fs::read_dir(folder) else {
        return spawned;
    };
    for path in entries.flatten().map(|entry| entry.path()) {
        let Some(id) = path
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| name.strip_prefix("agent-")?.strip_suffix(".meta.json"))
        else {
            continue;
        };
        // A few hundred bytes; anything much larger is not Claude's.
        if std::fs::metadata(&path).map_or(true, |meta| meta.len() > 64 * 1024) {
            continue;
        }
        let call = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .and_then(|meta| meta.get("toolUseId").and_then(Value::as_str).map(str::to_string));
        if let Some(call) = call {
            spawned.insert(call, id.to_string());
        }
    }
    spawned
}

/// A spawned Codex thread as its parent's `agent` entry, at the moment it was
/// created: its task, and its role and nickname as the kind.
fn codex_agent_entry(child: &crate::services::codex_store::SpawnedThread) -> Option<TranscriptEntry> {
    let kind = [child.role.as_deref(), child.nickname.as_deref()]
        .into_iter()
        .flatten()
        .filter(|part| !part.trim().is_empty())
        .collect::<Vec<_>>()
        .join(" · ");
    let mut entry = agent_entry(&child.task, Some(&kind), child.created_ms.map(crate::services::prompt_blame::epoch_ms_to_iso))?;
    entry.subagent = Some(subagent_token(&child.id));
    Some(entry)
}

/// Place `placed` among `entries` by time: each after the last entry that is
/// not later than it. One that predates what a tail read (`truncated`) kept is
/// dropped rather than shown at the top of turns it came long before.
pub(crate) fn insert_by_time(entries: &mut Vec<TranscriptEntry>, placed: Vec<TranscriptEntry>, truncated: bool) {
    fn epoch_ms(entry: &TranscriptEntry) -> Option<i64> {
        chrono::DateTime::parse_from_rfc3339(entry.at.as_deref()?).ok().map(|at| at.timestamp_millis())
    }
    let first = entries.iter().find_map(epoch_ms);
    for entry in placed {
        let Some(at) = epoch_ms(&entry) else {
            continue;
        };
        if truncated && first.is_none_or(|first| at < first) {
            continue;
        }
        let index = entries
            .iter()
            .rposition(|shown| epoch_ms(shown).is_some_and(|shown| shown <= at))
            .map_or(0, |index| index + 1);
        entries.insert(index, entry);
    }
}

/// Tokens Codex counts as the fixed cost of any conversation (instructions,
/// tools) and leaves out of its "context left" — the footer's own baseline.
const CODEX_BASELINE_TOKENS: i64 = 12_000;
/// A window this long or shorter is the session one; longer is the week.
const SESSION_WINDOW_MAX_MINUTES: i64 = 24 * 60;

/// The newest context and rate-limit figures in a Codex rollout's `lines`.
/// Each comes from the newest `token_count` event that carries it: an event
/// can hold the limits without the token counts, or the other way round.
fn codex_usage(lines: &[&str]) -> Option<TranscriptUsage> {
    let mut usage = TranscriptUsage::default();
    let mut limits_read = false;
    for line in lines.iter().rev() {
        if usage.context_left.is_some() && limits_read {
            break;
        }
        if !line.contains("\"token_count\"") {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(payload) = value
            .get("payload")
            .filter(|p| p.get("type").and_then(Value::as_str) == Some("token_count"))
        else {
            continue;
        };
        if usage.context_left.is_none() {
            usage.context_left = payload.get("info").and_then(codex_context_left);
        }
        if !limits_read {
            if let Some(limits) = payload.get("rate_limits").filter(|l| l.is_object()) {
                limits_read = true;
                for (key, fallback_session) in [("primary", true), ("secondary", false)] {
                    let Some(window) = limits.get(key).filter(|w| w.is_object()) else {
                        continue;
                    };
                    let Some(used) = window.get("used_percent").and_then(Value::as_f64) else {
                        continue;
                    };
                    let reading = UsageWindow {
                        used: used.clamp(0.0, 100.0).round() as u8,
                        resets_at: window.get("resets_at").and_then(Value::as_u64),
                    };
                    let session = window
                        .get("window_minutes")
                        .and_then(Value::as_i64)
                        .map_or(fallback_session, |minutes| minutes <= SESSION_WINDOW_MAX_MINUTES);
                    let slot = if session { &mut usage.session } else { &mut usage.week };
                    slot.get_or_insert(reading);
                }
            }
        }
    }
    (usage != TranscriptUsage::default()).then_some(usage)
}

/// Codex's "context left": the last request's tokens against the model's
/// window, both less the baseline every conversation carries.
fn codex_context_left(info: &Value) -> Option<u8> {
    let window = info.get("model_context_window")?.as_i64()?;
    let used = info.get("last_token_usage")?.get("total_tokens")?.as_i64()?;
    if window <= CODEX_BASELINE_TOKENS {
        return None;
    }
    let effective = window - CODEX_BASELINE_TOKENS;
    let used = (used - CODEX_BASELINE_TOKENS).max(0);
    let left = (effective - used).max(0) as f64 / effective as f64 * 100.0;
    Some(left.clamp(0.0, 100.0).round() as u8)
}

/// The turns in `lines`, in order. Each answer record is an entry of its own:
/// Claude writes each message of a turn as a record, with the tool calls it
/// made in between, and the phone shows them as separate bubbles — joined
/// into one they ran together ("Let me check…" glued to the final answer).
/// Beside them, each Claude `Agent` call's entry index and call id, for the
/// caller to match to its subagent.
fn parse_entries<'a>(
    lines: impl Iterator<Item = &'a str>,
    kind: TranscriptKind,
    sidechain: bool,
) -> (Vec<TranscriptEntry>, Vec<(usize, String)>) {
    let mut entries: Vec<TranscriptEntry> = Vec::new();
    let mut calls = Vec::new();
    for line in lines {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(mut value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if sidechain {
            if let Some(record) = value.as_object_mut() {
                record.remove("isSidechain");
            }
        }
        let records = match kind {
            TranscriptKind::Claude => claude_records(&value),
            TranscriptKind::Codex => codex_entry(&value).map(|(role, raw)| Record::Turn(role, raw)).into_iter().collect(),
        };
        let at = value
            .get("timestamp")
            .and_then(Value::as_str)
            .map(str::to_string);
        for record in records {
            match record {
                Record::Turn(role, raw) => entries.extend(transcript_entry(role, &raw, at.clone())),
                Record::Spawn { call, task, kind } => {
                    if let Some(entry) = agent_entry(&task, kind.as_deref(), at.clone()) {
                        calls.push((entries.len(), call));
                        entries.push(entry);
                    }
                }
            }
        }
    }
    (entries, calls)
}

/// What one record contributes.
enum Record {
    /// A prompt or an answer.
    Turn(&'static str, String),
    /// A subagent spawned by tool call `call`, sent to do `task`.
    Spawn { call: String, task: String, kind: Option<String> },
}

/// A subagent's entry: its task as one bounded line, its kind beside it.
/// `None` when neither says anything.
pub(crate) fn agent_entry(task: &str, kind: Option<&str>, at: Option<String>) -> Option<TranscriptEntry> {
    let line = |raw: &str, bound: usize| -> Option<(String, bool)> {
        let text = clean_text(raw)?.split_whitespace().collect::<Vec<_>>().join(" ");
        let cut = text.chars().count() > bound;
        Some((if cut { text.chars().take(bound).collect() } else { text }, cut))
    };
    let (text, cut) = line(task, MAX_AGENT_CHARS).unwrap_or_default();
    let role = kind.and_then(|kind| line(kind, MAX_ROLE_CHARS)).map(|(role, _)| role);
    if text.is_empty() && role.is_none() {
        return None;
    }
    Some(TranscriptEntry { kind: "agent".to_string(), text, at, cut, subagent: None, role })
}

/// One turn as the phone shows it: `raw` cleaned (`clean_text`) and cut at
/// its kind's bound. `None` when nothing is left to show. Shared by every
/// reader, whatever the agent keeps its conversation in.
pub(crate) fn transcript_entry(role: &str, raw: &str, at: Option<String>) -> Option<TranscriptEntry> {
    let bound = if role == "answer" { MAX_ANSWER_CHARS } else { MAX_PROMPT_CHARS };
    let mut entry = TranscriptEntry {
        kind: role.to_string(),
        text: clean_text(raw)?,
        at,
        ..Default::default()
    };
    bound_entry(&mut entry, bound);
    Some(entry)
}

/// Cut `entry.text` at `bound` characters, marking the cut.
fn bound_entry(entry: &mut TranscriptEntry, bound: usize) {
    if entry.text.chars().count() > bound {
        entry.text = entry.text.chars().take(bound).collect();
        entry.cut = true;
    }
}

/// The text fit to show: line endings normalized, control characters other
/// than the line break and the tab dropped, trimmed. Empty is no entry.
fn clean_text(raw: &str) -> Option<String> {
    let text: String = raw
        .replace("\r\n", "\n")
        .chars()
        .filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
        .collect();
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_string())
}

/// A Claude record as turns: a `user` record that is a prompt (the same
/// reading the last-prompt line makes — tool results, meta notes and
/// reminders are not), a prompt the user queued mid-turn (the prompt chart's
/// reading), or an `assistant` record's text blocks and the subagents its
/// `Agent` calls spawned. Thinking and other tool-use blocks are stepped
/// over, as is a sidechain (a subagent's) record.
fn claude_records(value: &Value) -> Vec<Record> {
    let sidechain = value.get("isSidechain").and_then(Value::as_bool) == Some(true);
    match value.get("type").and_then(Value::as_str) {
        Some("user") => agent_session::claude_prompt_in_record(value)
            .map(|text| Record::Turn("prompt", text))
            .into_iter()
            .collect(),
        // A prompt typed while Claude was working lives only here.
        Some("attachment") if !sidechain => agent_session::claude_queued_prompt(value)
            .map(|text| Record::Turn("prompt", text))
            .into_iter()
            .collect(),
        Some("assistant") if !sidechain => {
            let Some(content) = value.get("message").and_then(|m| m.get("content")) else {
                return Vec::new();
            };
            let (text, spawns) = match content {
                Value::String(text) => (text.clone(), Vec::new()),
                Value::Array(blocks) => (
                    blocks
                        .iter()
                        .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
                        .filter_map(|b| b.get("text").and_then(Value::as_str))
                        .collect::<Vec<_>>()
                        .join("\n\n"),
                    blocks.iter().filter_map(claude_spawn).collect(),
                ),
                _ => return Vec::new(),
            };
            let text = text.trim();
            (!text.is_empty())
                .then(|| Record::Turn("answer", text.to_string()))
                .into_iter()
                .chain(spawns)
                .collect()
        }
        _ => Vec::new(),
    }
}

/// A `tool_use` block that spawns a subagent — `Agent`, `Task` before it was
/// renamed — with the short description Claude gave it, or the start of the
/// task itself when it gave none.
fn claude_spawn(block: &Value) -> Option<Record> {
    if block.get("type").and_then(Value::as_str) != Some("tool_use")
        || !matches!(block.get("name").and_then(Value::as_str), Some("Agent" | "Task"))
    {
        return None;
    }
    let input = block.get("input");
    let field = |key: &str| input.and_then(|i| i.get(key)).and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty());
    Some(Record::Spawn {
        call: block.get("id").and_then(Value::as_str)?.to_string(),
        task: field("description").or_else(|| field("prompt")).unwrap_or_default().to_string(),
        kind: Some(field("subagent_type").unwrap_or("general-purpose").to_string()),
    })
}

/// A Codex rollout record as a turn: the `response_item` messages — the
/// user's `input_text` (minus the context Codex injects, as the last-prompt
/// reader skips it) and the assistant's `output_text`. The `event_msg` copies
/// of the same messages are not read, so nothing shows twice; function calls,
/// their outputs and reasoning items are stepped over.
fn codex_entry(value: &Value) -> Option<(&'static str, String)> {
    if value.get("type").and_then(Value::as_str)? != "response_item" {
        return None;
    }
    let payload = value.get("payload")?;
    if payload.get("type").and_then(Value::as_str)? != "message" {
        return None;
    }
    match payload.get("role").and_then(Value::as_str)? {
        "user" => agent_session::codex_prompt_in_record(value).map(|text| ("prompt", text)),
        "assistant" => {
            let text = payload
                .get("content")?
                .as_array()?
                .iter()
                .filter(|b| b.get("type").and_then(Value::as_str) == Some("output_text"))
                .filter_map(|b| b.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n\n");
            let text = text.trim();
            (!text.is_empty()).then(|| ("answer", text.to_string()))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(transcript: &AgentTranscript) -> Vec<(&str, &str)> {
        transcript
            .entries
            .iter()
            .map(|e| (e.kind.as_str(), e.text.as_str()))
            .collect()
    }

    #[test]
    fn a_claude_transcript_reads_as_prompts_and_one_bubble_per_message() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        std::fs::write(
            &path,
            concat!(
                "{\"type\":\"user\",\"timestamp\":\"2026-09-15T05:49:39.013Z\",\"message\":{\"role\":\"user\",\"content\":\"add a clear\\nbutton\"}}\n",
                "{\"type\":\"user\",\"isMeta\":true,\"message\":{\"role\":\"user\",\"content\":\"note to self\"}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"thinking\",\"thinking\":\"hmm\"}]}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Looking at the composer.\"}]}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"name\":\"Edit\",\"input\":{\"file_path\":\"a.tsx\"}}]}}\n",
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"t1\",\"content\":\"Updated a.tsx with 3 additions\"}]}}\n",
                "{\"type\":\"assistant\",\"isSidechain\":true,\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"subagent chatter\"}]}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Done: the button\\u001b[0m clears the draft.\"}]}}\n",
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"<system-reminder>x</system-reminder>\"}}\n",
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"<command-name>/model</command-name><command-args>opus</command-args>\"}}\n",
                "{\"type\":\"attachment\",\"attachment\":{\"type\":\"date\"}}\n",
                "not json\n",
            ),
        )
        .unwrap();
        let read = read_transcript(&path, TranscriptKind::Claude, None, DEFAULT_LIMIT).unwrap();
        assert!(read.available && !read.unchanged && !read.truncated);
        assert_eq!(
            kinds(&read),
            vec![
                ("prompt", "add a clear\nbutton"),
                // The two messages of one turn, each its own bubble, the
                // tool call and its result between them left out, the escape
                // byte dropped.
                ("answer", "Looking at the composer."),
                ("answer", "Done: the button[0m clears the draft."),
                ("prompt", "/model opus"),
            ]
        );
        assert_eq!(read.entries[0].at.as_deref(), Some("2026-09-15T05:49:39.013Z"));

        // The fingerprint the caller hands back is answered without a parse.
        let version = read.version.clone().expect("version");
        let again = read_transcript(&path, TranscriptKind::Claude, Some(&version), DEFAULT_LIMIT).unwrap();
        assert!(again.unchanged && again.entries.is_empty());
        assert_eq!(again.version, Some(version.clone()));
        let stale = read_transcript(&path, TranscriptKind::Claude, Some("0:0"), DEFAULT_LIMIT).unwrap();
        assert!(!stale.unchanged && stale.entries.len() == 4);

        // The limit keeps the newest turns and says that older ones exist.
        let last = read_transcript(&path, TranscriptKind::Claude, None, 2).unwrap();
        assert!(last.truncated);
        assert_eq!(kinds(&last).iter().map(|(k, _)| *k).collect::<Vec<_>>(), vec!["answer", "prompt"]);

        assert!(read_transcript(&dir.path().join("missing.jsonl"), TranscriptKind::Claude, None, 5).is_none());
    }

    #[test]
    fn a_prompt_typed_while_claude_worked_is_a_bubble_in_its_place() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        std::fs::write(
            &path,
            concat!(
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"fix the build\"}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Checking.\"}]}}\n",
                // The shapes a census of real sessions found, as written.
                "{\"type\":\"queue-operation\",\"operation\":\"enqueue\",\"content\":\"also the tests\"}\n",
                "{\"type\":\"attachment\",\"isSidechain\":false,\"timestamp\":\"2026-09-18T18:51:27.432Z\",\"attachment\":{\"type\":\"queued_command\",\"prompt\":\"also the tests\",\"commandMode\":\"prompt\",\"origin\":{\"kind\":\"human\"}}}\n",
                "{\"type\":\"attachment\",\"isSidechain\":false,\"attachment\":{\"type\":\"queued_command\",\"prompt\":[{\"type\":\"image\",\"source\":{}},{\"type\":\"text\",\"text\":\"and this screenshot\"}],\"commandMode\":\"prompt\",\"origin\":{\"kind\":\"human\"}}}\n",
                "{\"type\":\"attachment\",\"isSidechain\":false,\"attachment\":{\"type\":\"queued_command\",\"prompt\":\"<cross-session-message from=\\\"x\\\">hi</cross-session-message>\",\"commandMode\":\"prompt\",\"origin\":{\"kind\":\"peer\"},\"isMeta\":true}}\n",
                "{\"type\":\"attachment\",\"isSidechain\":false,\"attachment\":{\"type\":\"queued_command\",\"prompt\":\"<task-notification>done</task-notification>\",\"commandMode\":\"task-notification\"}}\n",
                "{\"type\":\"attachment\",\"isSidechain\":true,\"attachment\":{\"type\":\"queued_command\",\"prompt\":\"a note\",\"origin\":{\"kind\":\"coordinator\"}}}\n",
                "{\"type\":\"attachment\",\"attachment\":{\"type\":\"date\"}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Both fixed.\"}]}}\n",
            ),
        )
        .unwrap();
        let read = read_transcript(&path, TranscriptKind::Claude, None, DEFAULT_LIMIT).unwrap();
        assert_eq!(
            kinds(&read),
            vec![
                ("prompt", "fix the build"),
                ("answer", "Checking."),
                ("prompt", "also the tests"),
                ("prompt", "and this screenshot"),
                ("answer", "Both fixed."),
            ]
        );
        assert_eq!(read.entries[2].at.as_deref(), Some("2026-09-18T18:51:27.432Z"));
    }

    #[test]
    fn a_codex_rollout_reads_its_messages_once() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rollout.jsonl");
        std::fs::write(
            &path,
            concat!(
                "{\"type\":\"session_meta\",\"payload\":{\"id\":\"x\"}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"<environment_context>cwd</environment_context>\"}]}}\n",
                "{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"add a test\"}}\n",
                "{\"type\":\"response_item\",\"timestamp\":\"2026-09-15T06:00:00Z\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"add a test\"}]}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"name\":\"shell\",\"arguments\":\"{}\"}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call_output\",\"output\":\"ok\"}}\n",
                "{\"type\":\"event_msg\",\"payload\":{\"type\":\"agent_message\",\"message\":\"done\"}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"done\"}]}}\n",
            ),
        )
        .unwrap();
        let read = read_transcript(&path, TranscriptKind::Codex, None, DEFAULT_LIMIT).unwrap();
        assert_eq!(kinds(&read), vec![("prompt", "add a test"), ("answer", "done")]);
        assert_eq!(read.entries[0].at.as_deref(), Some("2026-09-15T06:00:00Z"));
        assert_eq!(read.usage, None);
    }

    #[test]
    fn a_codex_rollout_carries_its_context_and_limits() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rollout.jsonl");
        std::fs::write(
            &path,
            concat!(
                "{\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":null,\"rate_limits\":{\"primary\":{\"used_percent\":10.0,\"window_minutes\":300,\"resets_at\":1}}}}\n",
                // Codex 0.155's shape, the limits and the counts in one event.
                "{\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"last_token_usage\":{\"total_tokens\":90259},\"model_context_window\":258400},\"rate_limits\":{\"primary\":{\"used_percent\":15.0,\"window_minutes\":300,\"resets_at\":1789856635},\"secondary\":{\"used_percent\":89.4,\"window_minutes\":10080,\"resets_at\":1790243849}}}}\n",
                // A later event without figures does not blank them.
                "{\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":null,\"rate_limits\":null}}\n",
            ),
        )
        .unwrap();
        let read = read_transcript(&path, TranscriptKind::Codex, None, DEFAULT_LIMIT).unwrap();
        assert_eq!(
            read.usage,
            Some(TranscriptUsage {
                context_left: Some(68),
                session: Some(UsageWindow { used: 15, resets_at: Some(1789856635) }),
                week: Some(UsageWindow { used: 89, resets_at: Some(1790243849) }),
            })
        );
        let wire = serde_json::to_value(&read).unwrap();
        assert_eq!(wire["usage"]["contextLeft"], 68);
        assert_eq!(wire["usage"]["week"]["resetsAt"], 1790243849u64);
    }

    #[test]
    fn a_bubble_holds_what_the_user_typed_and_nothing_the_cli_appended() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        std::fs::write(
            &path,
            concat!(
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"<tool_use_error>File has not been read yet</tool_use_error>\"}}\n",
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"what changed?\"},{\"type\":\"text\",\"text\":\"<total_tokens>128000</total_tokens>\"}]}}\n",
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"ship it\\n<system-reminder>be careful</system-reminder>\"}}\n",
            ),
        )
        .unwrap();
        let read = read_transcript(&path, TranscriptKind::Claude, None, DEFAULT_LIMIT).unwrap();
        assert_eq!(kinds(&read), vec![("prompt", "what changed?"), ("prompt", "ship it")]);
    }

    #[test]
    fn long_text_is_cut_and_marked_and_an_unknown_agent_is_unsupported() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        let long = "x".repeat(MAX_ANSWER_CHARS + 10);
        std::fs::write(
            &path,
            format!("{{\"type\":\"assistant\",\"message\":{{\"role\":\"assistant\",\"content\":[{{\"type\":\"text\",\"text\":\"{long}\"}}]}}}}\n{{\"type\":\"assistant\",\"message\":{{\"role\":\"assistant\",\"content\":[{{\"type\":\"text\",\"text\":\"more\"}}]}}}}\n"),
        )
        .unwrap();
        let read = read_transcript(&path, TranscriptKind::Claude, None, DEFAULT_LIMIT).unwrap();
        assert_eq!(read.entries.len(), 2);
        assert!(read.entries[0].cut && !read.entries[1].cut);
        assert_eq!(read.entries[0].text.chars().count(), MAX_ANSWER_CHARS);

        let gemini = agent_session_transcript("gemini", None, None, None, "0f5f9b7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b", None, None, 5);
        assert!(!gemini.available);
        assert_eq!(gemini.reason.as_deref(), Some("unsupported"));
        // Not even a uuid: refused before any file is looked for.
        assert_eq!(agent_session_transcript("claude", None, None, None, "../x", None, None, 5).reason.as_deref(), Some("no_transcript"));
        assert_eq!(agent_session_transcript("codex", None, None, None, "../x", None, None, 5).reason.as_deref(), Some("no_transcript"));
        // OpenCode is found by the tab's folder; without one there is nothing to look up.
        assert_eq!(agent_session_transcript("opencode", None, None, None, "0f5f9b7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b", None, None, 5).reason.as_deref(), Some("no_session"));
        assert_eq!(agent_session_transcript("opencode", None, Some("relative/dir"), None, "0f5f9b7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b", None, None, 5).reason.as_deref(), Some("no_session"));
    }

    #[test]
    fn a_claude_subagent_is_an_entry_that_opens_its_own_conversation() {
        let dir = tempfile::tempdir().unwrap();
        let main = dir.path().join("s.jsonl");
        std::fs::write(
            &main,
            concat!(
                "{\"type\":\"user\",\"timestamp\":\"2026-09-24T10:00:00Z\",\"message\":{\"role\":\"user\",\"content\":\"look around\"}}\n",
                "{\"type\":\"assistant\",\"timestamp\":\"2026-09-24T10:00:01Z\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Sending two scouts.\"},{\"type\":\"tool_use\",\"id\":\"toolu_A\",\"name\":\"Agent\",\"input\":{\"description\":\"Map the\\nbackend\",\"prompt\":\"long task\",\"subagent_type\":\"Explore\"}}]}}\n",
                "{\"type\":\"assistant\",\"timestamp\":\"2026-09-24T10:00:02Z\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_B\",\"name\":\"Task\",\"input\":{\"prompt\":\"find the tests\"}}]}}\n",
                "{\"type\":\"assistant\",\"isSidechain\":true,\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"inline chatter\"}]}}\n",
                "{\"type\":\"assistant\",\"timestamp\":\"2026-09-24T10:05:00Z\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Both reported.\"}]}}\n",
            ),
        )
        .unwrap();
        let folder = dir.path().join("s").join("subagents");
        let spawns = Spawns::Claude(&folder);

        // Before Claude has written where the subagent lives: an entry, no handle.
        let early = read_transcript_in(&main, TranscriptKind::Claude, &spawns, false, None, DEFAULT_LIMIT).unwrap();
        assert_eq!(
            kinds(&early),
            vec![
                ("prompt", "look around"),
                ("answer", "Sending two scouts."),
                ("agent", "Map the backend"),
                ("agent", "find the tests"),
                ("answer", "Both reported."),
            ]
        );
        assert_eq!(early.entries[2].role.as_deref(), Some("Explore"));
        assert_eq!(early.entries[3].role.as_deref(), Some("general-purpose"));
        assert!(early.entries.iter().all(|e| e.subagent.is_none()));

        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("agent-a1b2.meta.json"), r#"{"agentType":"Explore","description":"Map the backend","toolUseId":"toolu_A"}"#).unwrap();
        std::fs::write(
            folder.join("agent-a1b2.jsonl"),
            concat!(
                "{\"type\":\"user\",\"isSidechain\":true,\"agentId\":\"a1b2\",\"timestamp\":\"2026-09-24T10:00:01Z\",\"message\":{\"role\":\"user\",\"content\":\"long task\"}}\n",
                "{\"type\":\"assistant\",\"isSidechain\":true,\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_C\",\"name\":\"Agent\",\"input\":{\"description\":\"Dig deeper\"}}]}}\n",
                "{\"type\":\"user\",\"isSidechain\":true,\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"toolu_C\",\"content\":\"x\"}]}}\n",
                "{\"type\":\"assistant\",\"isSidechain\":true,\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"The backend is in src-tauri.\"}]}}\n",
            ),
        )
        .unwrap();
        let late = read_transcript_in(&main, TranscriptKind::Claude, &spawns, false, early.version.as_deref(), DEFAULT_LIMIT).unwrap();
        // The session's file did not move, the folder did: not `unchanged`.
        assert!(!late.unchanged);
        let token = late.entries[2].subagent.clone().expect("handle");
        assert!(is_subagent_token(&token));
        assert_ne!(token, "a1b2");
        assert_eq!(late.entries[3].subagent, None);

        let file = claude_subagent_file(&folder, &token).expect("file");
        let sub = read_transcript_in(&file, TranscriptKind::Claude, &spawns, true, None, DEFAULT_LIMIT).unwrap();
        assert_eq!(
            kinds(&sub),
            vec![("prompt", "long task"), ("agent", "Dig deeper"), ("answer", "The backend is in src-tauri.")]
        );
        assert!(claude_subagent_file(&folder, &subagent_token("elsewhere")).is_none());
    }

    #[test]
    fn a_codex_subagent_is_placed_when_its_thread_was_created() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("state_5.sqlite");
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute_batch(
            "CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, created_at INTEGER NOT NULL,
               title TEXT NOT NULL, first_user_message TEXT NOT NULL DEFAULT '', agent_nickname TEXT,
               agent_role TEXT, created_at_ms INTEGER);
             CREATE TABLE thread_spawn_edges (parent_thread_id TEXT NOT NULL, child_thread_id TEXT NOT NULL PRIMARY KEY, status TEXT NOT NULL);
             INSERT INTO threads VALUES ('child', '/r/child.jsonl', 1789000030, 't', 'Check the\nlockfile', 'Kepler', 'explorer', 1789680030000);
             INSERT INTO threads VALUES ('grandchild', '/r/g.jsonl', 1789000040, 'Deeper', '', NULL, NULL, NULL);
             INSERT INTO threads VALUES ('stranger', '/r/s.jsonl', 1789000050, 'x', 'not ours', NULL, NULL, 1789000050000);
             INSERT INTO thread_spawn_edges VALUES ('root', 'child', 'running');
             INSERT INTO thread_spawn_edges VALUES ('child', 'grandchild', 'completed');
             INSERT INTO thread_spawn_edges VALUES ('other', 'stranger', 'running');",
        )
        .unwrap();
        drop(conn);
        let path = dir.path().join("rollout.jsonl");
        std::fs::write(
            &path,
            concat!(
                "{\"type\":\"response_item\",\"timestamp\":\"2026-09-15T00:00:00Z\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"audit deps\"}]}}\n",
                "{\"type\":\"response_item\",\"timestamp\":\"2026-09-17T21:20:40Z\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"Asked Kepler.\"}]}}\n",
            ),
        )
        .unwrap();
        let stores = [db.clone()];
        let read = read_transcript_in(&path, TranscriptKind::Codex, &Spawns::Codex { stores: &stores, thread: "root" }, false, None, DEFAULT_LIMIT).unwrap();
        // 1789680030000 ms is 2026-09-17T21:20:30Z: after the prompt, before the answer.
        assert_eq!(kinds(&read), vec![("prompt", "audit deps"), ("agent", "Check the lockfile"), ("answer", "Asked Kepler.")]);
        assert_eq!(read.entries[1].role.as_deref(), Some("explorer · Kepler"));
        assert_eq!(read.entries[1].subagent, Some(subagent_token("child")));

        let tree: Vec<String> = crate::services::codex_store::descendant_threads(&db, "root", MAX_SUBAGENT_DEPTH)
            .into_iter()
            .map(|t| t.id)
            .collect();
        assert_eq!(tree.len(), 2);
        assert!(tree.contains(&"child".to_string()) && tree.contains(&"grandchild".to_string()));
        assert_eq!(crate::services::codex_store::descendant_threads(&db, "root", 1).len(), 1);
        // A store without the edge table is one with no subagents.
        let bare = dir.path().join("bare.sqlite");
        rusqlite::Connection::open(&bare).unwrap().execute_batch("CREATE TABLE threads (id TEXT)").unwrap();
        assert!(crate::services::codex_store::spawned_threads(&bare, "root").is_empty());
    }

    #[test]
    fn a_placed_entry_older_than_the_tail_is_left_out() {
        let at = |s: &str| TranscriptEntry { kind: "answer".into(), text: s.into(), at: Some(s.into()), ..Default::default() };
        let agent = |s: &str| TranscriptEntry { kind: "agent".into(), text: s.into(), at: Some(s.into()), ..Default::default() };
        let mut entries = vec![at("2026-09-24T10:00:00Z"), at("2026-09-24T12:00:00Z")];
        let placed = vec![agent("2026-09-24T09:00:00Z"), agent("2026-09-24T11:00:00Z"), agent("2026-09-24T13:00:00Z")];
        insert_by_time(&mut entries, placed.clone(), true);
        assert_eq!(
            entries.iter().map(|e| (e.kind.as_str(), e.text.as_str())).collect::<Vec<_>>(),
            vec![
                ("answer", "2026-09-24T10:00:00Z"),
                ("agent", "2026-09-24T11:00:00Z"),
                ("answer", "2026-09-24T12:00:00Z"),
                ("agent", "2026-09-24T13:00:00Z"),
            ]
        );
        let mut whole = vec![at("2026-09-24T10:00:00Z")];
        insert_by_time(&mut whole, placed, false);
        assert_eq!(whole[0].text, "2026-09-24T09:00:00Z");
    }

    #[test]
    fn a_handle_that_is_not_one_is_refused_before_anything_is_read() {
        assert!(is_subagent_token(&subagent_token("a1b2")));
        for bad in ["", "../../etc/passwd", "ABCDEF0123456789", "0123456789abcdef0", "a1b2"] {
            assert!(!is_subagent_token(bad), "{bad}");
            let read = agent_session_transcript("claude", None, None, None, "0f5f9b7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b", Some(bad), None, 5);
            assert_eq!(read.reason.as_deref(), Some("no_subagent"));
        }
        // A well-formed handle on a tab with no session is no subagent — never
        // the fresh, empty chat the session itself would be.
        let read = agent_session_transcript("claude", None, None, None, "0f5f9b7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b", Some(&subagent_token("x")), None, 5);
        assert_eq!(read.reason.as_deref(), Some("no_subagent"));
    }
}
