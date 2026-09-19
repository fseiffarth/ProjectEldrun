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
//! A read answers with a `version` fingerprint of the file; a caller that
//! passes the one it last saw gets `unchanged` back without a parse, which is
//! what lets the phone poll while the agent is answering.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;

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

/// One turn of the conversation as the phone shows it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TranscriptEntry {
    /// `prompt` (the user's) or `answer` (the agent's text).
    pub kind: String,
    pub text: String,
    /// The record's own timestamp, as written (RFC 3339), when it has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
    /// The text was cut at its bound; the entry shows what fit.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub cut: bool,
}

/// What a tab's stored session answers with. Always a value, never an error:
/// an agent that keeps no transcript Eldrun reads comes back `available:
/// false` with the reason, and the phone shows the screen instead.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentTranscript {
    pub available: bool,
    /// Why not, when `available` is false: `unsupported` (an agent whose
    /// transcript is not read), `no_session` (the tab has no session id yet),
    /// `no_transcript` (nothing on disk for it), `read_failed`.
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
/// `unchanged` when `version` still names the file as it is. See
/// [`AgentTranscript::reason`] for the ways this answers without turns.
pub fn agent_session_transcript(
    cmd: &str,
    project_id: Option<&str>,
    tab_dir: Option<&str>,
    launch_id: &str,
    version: Option<&str>,
    limit: usize,
) -> AgentTranscript {
    let limit = limit.clamp(1, MAX_LIMIT);
    if cmd == "opencode" {
        return opencode_transcript(project_id, tab_dir, version, limit);
    }
    agent_session::read_agent_transcript_from(
        cmd,
        project_id,
        launch_id,
        // Never the launch id's file once a live id is recorded: after a
        // `/clear` that file is the cleared conversation.
        false,
        |path, kind| read_transcript(path, kind, version, limit),
        // Codex's thread store keeps no messages (only a thread's first one),
        // so a release that writes no rollout has no conversation to read.
        |_, _| None,
    )
    .or_else(|| (cmd == "claude").then(|| fresh_claude_session(project_id, launch_id)).flatten())
    .or_else(|| (cmd == "codex").then(|| fresh_codex_session(project_id, launch_id)).flatten())
    .unwrap_or_else(|| {
        AgentTranscript::unavailable(if matches!(cmd, "claude" | "codex") {
            "no_transcript"
        } else {
            "unsupported"
        })
    })
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
/// (`services::opencode_store`): the newest session of the tab's folder. A
/// remote tab's OpenCode writes a store on the remote host, so it has none
/// here to read.
fn opencode_transcript(
    project_id: Option<&str>,
    tab_dir: Option<&str>,
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
    crate::services::opencode_store::session_transcript(&db, dir, version, limit)
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

/// Read the transcript at `path` — its tail, then the last `limit` entries.
/// `None` only when the file cannot be read; a session with no turn yet is an
/// empty, available transcript.
pub fn read_transcript(
    path: &Path,
    kind: TranscriptKind,
    version: Option<&str>,
    limit: usize,
) -> Option<AgentTranscript> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path).ok()?;
    let meta = file.metadata().ok()?;
    let current = fingerprint(&meta);
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
    let mut entries = parse_entries(lines.into_iter(), kind);
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
fn parse_entries<'a>(lines: impl Iterator<Item = &'a str>, kind: TranscriptKind) -> Vec<TranscriptEntry> {
    let mut entries: Vec<TranscriptEntry> = Vec::new();
    for line in lines {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some((role, raw)) = (match kind {
            TranscriptKind::Claude => claude_entry(&value),
            TranscriptKind::Codex => codex_entry(&value),
        }) else {
            continue;
        };
        let at = value
            .get("timestamp")
            .and_then(Value::as_str)
            .map(str::to_string);
        entries.extend(transcript_entry(role, &raw, at));
    }
    entries
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
        cut: false,
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

/// A Claude record as a turn: a `user` record that is a prompt (the same
/// reading the last-prompt line makes — tool results, meta notes and
/// reminders are not), a prompt the user queued mid-turn (the prompt chart's
/// reading), or an `assistant` record's text blocks. Thinking and
/// tool-use blocks are stepped over, as is a sidechain (a subagent's) record.
fn claude_entry(value: &Value) -> Option<(&'static str, String)> {
    match value.get("type").and_then(Value::as_str)? {
        "user" => agent_session::claude_prompt_in_record(value).map(|text| ("prompt", text)),
        // A prompt typed while Claude was working lives only here.
        "attachment" if value.get("isSidechain").and_then(Value::as_bool) != Some(true) => {
            agent_session::claude_queued_prompt(value).map(|text| ("prompt", text))
        }
        "assistant" => {
            if value.get("isSidechain").and_then(Value::as_bool) == Some(true) {
                return None;
            }
            let content = value.get("message")?.get("content")?;
            let text = match content {
                Value::String(text) => text.clone(),
                Value::Array(blocks) => blocks
                    .iter()
                    .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
                    .filter_map(|b| b.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("\n\n"),
                _ => return None,
            };
            let text = text.trim();
            (!text.is_empty()).then(|| ("answer", text.to_string()))
        }
        _ => None,
    }
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

        let gemini = agent_session_transcript("gemini", None, None, "0f5f9b7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b", None, 5);
        assert!(!gemini.available);
        assert_eq!(gemini.reason.as_deref(), Some("unsupported"));
        // Not even a uuid: refused before any file is looked for.
        assert_eq!(agent_session_transcript("claude", None, None, "../x", None, 5).reason.as_deref(), Some("no_transcript"));
        assert_eq!(agent_session_transcript("codex", None, None, "../x", None, 5).reason.as_deref(), Some("no_transcript"));
        // OpenCode is found by the tab's folder; without one there is nothing to look up.
        assert_eq!(agent_session_transcript("opencode", None, None, "0f5f9b7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b", None, 5).reason.as_deref(), Some("no_session"));
        assert_eq!(agent_session_transcript("opencode", None, Some("relative/dir"), "0f5f9b7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b", None, 5).reason.as_deref(), Some("no_session"));
    }
}
