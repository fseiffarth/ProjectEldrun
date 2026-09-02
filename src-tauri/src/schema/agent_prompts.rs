use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// A prompt collected for a project without a tab binding. It becomes a
/// schedule (or a send-now one-time schedule) only when the user aims it at an
/// agent tab; until then it is text that belongs to the project.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectAgentPrompt {
    pub id: String,
    pub message: String,
    pub created_at: String,
    pub updated_at: String,
}

/// A collected prompt that has been aimed at an agent tab, moved out of the
/// active list at send time. It records WHERE it went — the tab's label and,
/// when the tab has one, the agent session id — because "which session did I
/// tell that to" is the question the list exists to answer, and a session id
/// outlives the tab that carried it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
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
}

fn agent_prompts_version() -> u8 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentPromptsFile {
    #[serde(default = "agent_prompts_version")]
    pub version: u8,
    #[serde(default)]
    pub projects: BTreeMap<String, Vec<ProjectAgentPrompt>>,
    /// Sent prompts per project, oldest first. Defaults so a file written
    /// before the history existed still loads.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub history: BTreeMap<String, Vec<SentAgentPrompt>>,
}

impl Default for AgentPromptsFile {
    fn default() -> Self {
        Self {
            version: agent_prompts_version(),
            projects: BTreeMap::new(),
            history: BTreeMap::new(),
        }
    }
}
