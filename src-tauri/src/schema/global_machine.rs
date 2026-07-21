use serde::{Deserialize, Serialize};

/// A globally connected worker machine: authenticated once via the ordinary
/// login mechanism (`commands::ssh::ssh_connect`) with **no** `remote_path` set —
/// project-free by construction, unlike [`super::project::RemoteSpec`]. Later
/// drag-and-dropped onto an SSH project to become a `shared_fs`
/// [`super::project::ComputeHost`] there (a value COPY of this identity, not a
/// reference — removing it from a project never touches this registry).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GlobalMachine {
    /// Stable id, minted on add.
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    pub host: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    /// Display name; falls back to `host` wherever shown.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// Opt-in to a *silent* connect on launch and whenever a VPN tunnel comes up
    /// (the machine-wide twin of a project's `RemoteSpec::auto_connect`). Like it,
    /// the auto path never prompts: it probes first and connects only when the host
    /// is reachable with no user input, so a stale opt-in degrades to "stay off".
    /// `#[serde(default)]` so a `global_machines.json` written before this field
    /// existed still loads.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_connect: Option<bool>,
}

impl GlobalMachine {
    pub fn display_label(&self) -> &str {
        self.label.as_deref().unwrap_or(&self.host)
    }
}
