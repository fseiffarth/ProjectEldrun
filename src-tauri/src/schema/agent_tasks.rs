use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum AgentScheduleRule {
    Once { at: String },
    Daily { time: String },
    Weekdays { weekdays: Vec<u8>, time: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentScheduleResult {
    Delivered,
    Missed,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentScheduleLastRun {
    pub occurrence: String,
    pub result: AgentScheduleResult,
    pub at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScheduledAgentPrompt {
    pub id: String,
    pub enabled: bool,
    pub message: String,
    pub rule: AgentScheduleRule,
    /// Slash commands submitted to the agent one at a time, in order, BEFORE
    /// `message` — the composer's prefix chips and its `/model <name>` pick.
    /// They are separate submissions rather than extra lines of `message`
    /// because a CLI's `/clear` or `/model` takes the whole line: appending the
    /// prompt to it would make the command swallow the prompt instead of
    /// running. Empty for every schedule written before the composer existed,
    /// which is why it defaults rather than being required.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub preface: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last: Option<AgentScheduleLastRun>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentPromptTarget {
    #[serde(default)]
    pub schedules: Vec<ScheduledAgentPrompt>,
    /// Latest atomically claimed occurrence by schedule id. Claims intentionally
    /// survive a crash: an occurrence whose first input write may have happened
    /// is never retried after a reload.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub claims: BTreeMap<String, String>,
}

fn agent_tasks_version() -> u8 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentTasksFile {
    #[serde(default = "agent_tasks_version")]
    pub version: u8,
    #[serde(default)]
    pub projects: BTreeMap<String, BTreeMap<String, AgentPromptTarget>>,
}

impl Default for AgentTasksFile {
    fn default() -> Self {
        Self {
            version: agent_tasks_version(),
            projects: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentScheduleTargetBinding {
    pub project_id: String,
    pub schedule_target_id: String,
}
