//! `agent_prompts.json`: the collected-prompt library and its send history.
//!
//! Two kinds of struct live here and they deserialize under opposite rules.
//! The `*Input` ones arrive over IPC from a frontend built from this same tree,
//! so they `deny_unknown_fields` and a caller's typo is loud. The persisted
//! ones are read back off disk, and a state file outlives the build that wrote
//! it: a packaged Eldrun, a frozen `package:dev` snapshot and a dev window all
//! read the same file, so the newest of them adding one optional field would
//! otherwise make every older build reject the whole library with
//! `unknown field ...` and show the user nothing. They tolerate unknown fields
//! and drop what they do not understand — the entry stays readable, and only
//! what the writer knew about survives a round trip through an older build.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// A prompt collected for a project without a tab binding. It becomes a
/// schedule (or a send-now one-time schedule) only when the user aims it at an
/// agent tab; until then it is text that belongs to the project.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectAgentPrompt {
    pub id: String,
    pub message: String,
    pub created_at: String,
    pub updated_at: String,
    /// Free-form labels (`refactor`, `tests`, `paper`), normalized lowercase
    /// tokens without whitespace. What makes the collection a library rather
    /// than a pile: a prompt is found by what it is for, not only by its words.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
}

/// A collected prompt that has been aimed at an agent tab, moved out of the
/// active list at send time. It records WHERE it went — the tab's label and,
/// when the tab has one, the agent session id — because "which session did I
/// tell that to" is the question the list exists to answer, and a session id
/// outlives the tab that carried it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SentAgentPrompt {
    pub id: String,
    pub message: String,
    /// When the prompt was first collected, carried over from the active entry.
    pub created_at: String,
    pub sent_at: String,
    pub tab_label: String,
    /// The agent session the prompt was aimed at. Absent for a tab that has no
    /// session id (a non-resumable agent), which is a fact worth showing rather
    /// than a blank to paper over.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// The prefix commands submitted ahead of the message, if any.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub preface: Vec<String>,
    /// The agent the tab runs (`claude`, `codex`, …). The label says *which
    /// tab*; this says *what it is*, and it is the one of the two that still
    /// means something once a tab called "Agent 3" is gone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    /// How the delivery ended — `delivered`, `missed` or `failed`, mirroring
    /// `ScheduleResult`. Absent while a prompt is queued and has not reached
    /// the agent yet, which is a state of its own rather than a failure.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    /// The occurrence the prompt was due at, as a local wall-clock key. Absent
    /// for a prompt that was never on a clock.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scheduled_for: Option<String>,
    /// The tags the prompt carried when it was collected, kept so the library
    /// stays searchable by tag after the send.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    /// Prompt blame (`services::prompt_blame`): the commit HEAD pointed at when
    /// the prompt was delivered — the state of the project the agent started
    /// from. Absent for a remote project, a scope without a repo, or an unborn
    /// HEAD.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
    /// The branch checked out at delivery, when HEAD was on one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// The files that changed between the delivery and the agent going idle —
    /// working-tree edits written after the send plus anything committed since
    /// `commit`. Recorded once, by `agent_prompt_blame`, when the scheduler sees
    /// the tab idle again; `files_at` says when.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub files_at: Option<String>,
}

/// Send-time facts the frontend supplies; the service owns `sent_at` and
/// carries `created_at` over from the active entry it is retiring.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SentAgentPromptInput {
    pub tab_label: String,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub preface: Vec<String>,
    #[serde(default)]
    pub agent: Option<String>,
    #[serde(default)]
    pub result: Option<String>,
    #[serde(default)]
    pub scheduled_for: Option<String>,
}

/// A prompt written straight onto the history without ever having been a
/// collected one: a scheduled delivery, which starts life as a rule on a tab
/// rather than as text in the project's list. The `id` is the caller's, so a
/// retry — or a send-now prompt already archived under the same id — updates
/// the entry it already wrote instead of leaving the list saying it twice.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecordedAgentPromptInput {
    pub id: String,
    pub message: String,
    /// When the rule behind the prompt was written, if the caller knows it.
    #[serde(default)]
    pub created_at: Option<String>,
    pub sent: SentAgentPromptInput,
}

/// Editor-supplied fields. Timestamps are service-owned.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectAgentPromptInput {
    pub id: String,
    pub message: String,
    /// `None` leaves an existing prompt's tags as they are — the phone edits
    /// the text and knows nothing of tags — while `Some` replaces them, empty
    /// included. A new prompt with `None` starts untagged.
    #[serde(default)]
    pub tags: Option<Vec<String>>,
}

/// A visual/behavioural edge between two prompt cards. Endpoints name prompt
/// or history ids; `target` is the schedule target used when an `after` edge
/// queues its draft.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PromptLink {
    pub id: String,
    pub from: String,
    pub to: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PromptLinkInput {
    pub id: String,
    pub from: String,
    pub to: String,
    pub kind: String,
    #[serde(default)]
    pub target: Option<String>,
}

fn agent_prompts_version() -> u8 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentPromptsFile {
    #[serde(default = "agent_prompts_version")]
    pub version: u8,
    #[serde(default)]
    pub projects: BTreeMap<String, Vec<ProjectAgentPrompt>>,
    /// Sent prompts per project, oldest first. Defaults so a file written
    /// before the history existed still loads.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub history: BTreeMap<String, Vec<SentAgentPrompt>>,
    /// Prompt-card links per project. Additive and version-neutral so an older
    /// file remains readable.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub links: BTreeMap<String, Vec<PromptLink>>,
}

impl Default for AgentPromptsFile {
    fn default() -> Self {
        Self {
            version: agent_prompts_version(),
            projects: BTreeMap::new(),
            history: BTreeMap::new(),
            links: BTreeMap::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The regression this file's tolerance exists for: a build that wrote a
    /// field a reader has never heard of — `commit` was exactly this once —
    /// must not make the reader reject the whole library. The entry loads, the
    /// known fields are intact, and only the unknown one is dropped.
    #[test]
    fn unknown_fields_do_not_reject_the_file() {
        let json = r#"{
            "version": 1,
            "from_a_later_build": true,
            "projects": {
                "p1": [
                    {
                        "id": "a",
                        "message": "hello",
                        "created_at": "2026-01-01T00:00:00Z",
                        "updated_at": "2026-01-01T00:00:00Z",
                        "tags": ["tests"],
                        "pinned": true
                    }
                ]
            },
            "history": {
                "p1": [
                    {
                        "id": "b",
                        "message": "sent",
                        "created_at": "2026-01-01T00:00:00Z",
                        "sent_at": "2026-01-02T00:00:00Z",
                        "tab_label": "Agent 1",
                        "commit": "abcdef0123456789",
                        "branch": "develop",
                        "verdict": "from a later build"
                    }
                ]
            }
        }"#;

        let file: AgentPromptsFile = serde_json::from_str(json).expect("unknown fields must load");
        assert_eq!(file.version, 1);

        let prompt = &file.projects["p1"][0];
        assert_eq!(prompt.id, "a");
        assert_eq!(prompt.message, "hello");
        assert_eq!(prompt.tags, vec!["tests".to_string()]);

        let sent = &file.history["p1"][0];
        assert_eq!(sent.id, "b");
        assert_eq!(sent.tab_label, "Agent 1");
        assert_eq!(sent.commit.as_deref(), Some("abcdef0123456789"));
        assert_eq!(sent.branch.as_deref(), Some("develop"));
    }

    /// The other half of the split: an editor payload is not a state file, and
    /// a field the frontend made up is still refused rather than ignored.
    #[test]
    fn input_payloads_stay_strict() {
        let json = r#"{"id": "a", "message": "hi", "colour": "red"}"#;
        assert!(serde_json::from_str::<ProjectAgentPromptInput>(json).is_err());
    }
}
