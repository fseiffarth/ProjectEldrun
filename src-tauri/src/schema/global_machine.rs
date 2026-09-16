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

#[cfg(test)]
mod tests {
    use super::*;

    /// The display name falls back to the bare host, and a blank-but-present
    /// label is shown as-is (the command layer is what trims and drops it).
    #[test]
    fn display_label_falls_back_to_the_host() {
        let m: GlobalMachine =
            serde_json::from_str(r#"{"id":"m1","host":"gpu.example"}"#).unwrap();
        assert_eq!(m.display_label(), "gpu.example");
        let labelled = GlobalMachine {
            label: Some("gpu-2".into()),
            ..m
        };
        assert_eq!(labelled.display_label(), "gpu-2");
    }

    /// A `global_machines.json` written before `auto_connect` existed loads,
    /// and a disarmed machine (`None`) writes back without the key — the two
    /// are indistinguishable on disk by design.
    #[test]
    fn a_pre_auto_connect_record_loads_and_a_disarmed_one_omits_the_key() {
        let m: GlobalMachine =
            serde_json::from_str(r#"{"id":"m1","user":"alice","host":"h","port":2222}"#).unwrap();
        assert!(m.auto_connect.is_none());
        let out = serde_json::to_value(&m).unwrap();
        assert!(out.get("auto_connect").is_none());
        assert!(out.get("label").is_none());
        assert_eq!(out["port"], 2222);

        let armed = GlobalMachine {
            auto_connect: Some(true),
            ..m
        };
        assert_eq!(serde_json::to_value(&armed).unwrap()["auto_connect"], true);
        let bare: GlobalMachine = serde_json::from_str(r#"{"id":"m2","host":"h"}"#).unwrap();
        assert!(bare.user.is_none() && bare.port.is_none());
        assert_eq!(
            serde_json::to_value(&bare).unwrap(),
            serde_json::json!({"id":"m2","host":"h"})
        );
    }
}
