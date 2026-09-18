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
/// Longest text of one answer, after the text blocks of one turn are joined.
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
/// `launch_id`: the last `limit` turns of its transcript, or `unchanged` when
/// `version` still names the file as it is. See [`AgentTranscript::reason`]
/// for the ways this answers without turns.
pub fn agent_session_transcript(
    cmd: &str,
    project_id: Option<&str>,
    launch_id: &str,
    version: Option<&str>,
    limit: usize,
) -> AgentTranscript {
    let limit = limit.clamp(1, MAX_LIMIT);
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
    let mut lines = text.lines();
    let mut truncated = false;
    if start > 0 {
        // Whatever came before the seek point is missing from the first line.
        lines.next();
        truncated = true;
    }
    let mut entries = parse_entries(lines, kind);
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
    })
}

/// The turns in `lines`, in order. Consecutive answer records are one turn:
/// Claude writes each text block of an answer as a record of its own, with
/// the tool calls it made in between, and the reader wants the answer whole.
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
        let bound = if role == "answer" { MAX_ANSWER_CHARS } else { MAX_PROMPT_CHARS };
        let Some(text) = clean_text(&raw) else {
            continue;
        };
        if role == "answer" {
            if let Some(last) = entries.last_mut().filter(|last| last.kind == "answer") {
                if !last.cut {
                    last.text.push_str("\n\n");
                    last.text.push_str(&text);
                    bound_entry(last, bound);
                }
                continue;
            }
        }
        let mut entry = TranscriptEntry {
            kind: role.to_string(),
            text,
            at,
            cut: false,
        };
        bound_entry(&mut entry, bound);
        entries.push(entry);
    }
    entries
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
/// reminders are not), or an `assistant` record's text blocks. Thinking and
/// tool-use blocks are stepped over, as is a sidechain (a subagent's) record.
fn claude_entry(value: &Value) -> Option<(&'static str, String)> {
    match value.get("type").and_then(Value::as_str)? {
        "user" => agent_session::claude_prompt_in_record(value).map(|text| ("prompt", text)),
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
    fn a_claude_transcript_reads_as_prompts_and_whole_answers() {
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
                // The two text blocks of one turn, the tool call and its
                // result between them left out, the escape byte dropped.
                ("answer", "Looking at the composer.\n\nDone: the button[0m clears the draft."),
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
        assert!(!stale.unchanged && stale.entries.len() == 3);

        // The limit keeps the newest turns and says that older ones exist.
        let last = read_transcript(&path, TranscriptKind::Claude, None, 2).unwrap();
        assert!(last.truncated);
        assert_eq!(kinds(&last).iter().map(|(k, _)| *k).collect::<Vec<_>>(), vec!["answer", "prompt"]);

        assert!(read_transcript(&dir.path().join("missing.jsonl"), TranscriptKind::Claude, None, 5).is_none());
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
        assert_eq!(read.entries.len(), 1);
        assert!(read.entries[0].cut);
        assert_eq!(read.entries[0].text.chars().count(), MAX_ANSWER_CHARS);

        let gemini = agent_session_transcript("gemini", None, "0f5f9b7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b", None, 5);
        assert!(!gemini.available);
        assert_eq!(gemini.reason.as_deref(), Some("unsupported"));
        // Not even a uuid: refused before any file is looked for.
        assert_eq!(agent_session_transcript("claude", None, "../x", None, 5).reason.as_deref(), Some("no_transcript"));
    }
}
