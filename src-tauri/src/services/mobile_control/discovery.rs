use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    process::Command,
};

use base64ct::{Base64UrlUnpadded, Encoding};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Clone, Deserialize)]
struct ProjectRecord {
    id: String,
    name: String,
    status: String,
    #[serde(default)]
    directory: Option<String>,
    #[serde(default)]
    remote: Option<Value>,
    #[serde(default)]
    sandbox: Option<Value>,
    #[serde(default)]
    vm: Option<Value>,
    #[serde(default)]
    eldrun_mobile_access: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionFile {
    #[serde(default)]
    tab_layout: Vec<SavedTab>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedTab {
    label: String,
    cmd: String,
    cwd: String,
    kind: String,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    resume_args: Option<Vec<String>>,
    #[serde(default)]
    tmux_session: Option<String>,
    #[serde(default)]
    tmux_attach: Option<String>,
    #[serde(default)]
    ephemeral: bool,
}

#[derive(Debug, Clone)]
struct LiveTmux {
    activity: u64,
    cwd: PathBuf,
}

#[derive(Debug, Clone, Serialize)]
pub struct PublicProject {
    pub id: String,
    pub label: String,
    pub status: String,
    pub live_sessions: usize,
    pub last_activity: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PublicTab {
    pub id: String,
    pub label: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_label: Option<String>,
    pub available: bool,
    pub viewer_busy: bool,
    pub last_activity: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct ResolvedTab {
    pub public: PublicTab,
    pub tmux_name: String,
}

#[derive(Debug, Clone)]
pub struct ResolvedProject {
    pub public: PublicProject,
    pub raw_id: String,
    pub root: PathBuf,
    pub tabs: Vec<ResolvedTab>,
}

#[derive(Debug, Clone, Default)]
pub struct Catalog {
    pub projects: Vec<ResolvedProject>,
}

#[derive(Debug, Default)]
pub struct CatalogCache {
    last_valid: Option<Catalog>,
}

impl CatalogCache {
    pub fn load(&mut self, state_dir: &Path, host_key: &[u8]) -> Result<Catalog, String> {
        match Catalog::load(state_dir, host_key) {
            Ok(next) => {
                self.last_valid = Some(next.clone());
                Ok(next)
            }
            Err(error) => self.last_valid.clone().ok_or(error),
        }
    }
}

fn enabled(value: &Option<Value>) -> bool {
    value
        .as_ref()
        .and_then(|v| v.get("enabled"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn key_id(key: &[u8], domain: &str, parts: &[&str]) -> String {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC accepts all key sizes");
    mac.update(domain.as_bytes());
    mac.update(&[0]);
    for (i, part) in parts.iter().enumerate() {
        if i > 0 {
            mac.update(&[0]);
        }
        mac.update(part.as_bytes());
    }
    Base64UrlUnpadded::encode_string(&mac.finalize().into_bytes()[..20])
}

pub fn opaque_control_id(state_dir: &Path, domain: &str, value: &str) -> Result<String, String> {
    if !matches!(domain, "agent" | "request") {
        return Err("invalid opaque id domain".into());
    }
    let key = fs::read(state_dir.join("mobile-control/host.key"))
        .map_err(|e| format!("read host key: {e}"))?;
    if key.len() != 32 {
        return Err("invalid host key".into());
    }
    Ok(key_id(&key, domain, &[value]))
}

fn project_key(id: &str) -> String {
    let out: String = id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if out.is_empty() {
        "x".into()
    } else {
        out
    }
}

fn expected_tmux(project_id: &str, kind: &str, name: &str) -> bool {
    let prefix = format!("eldrun-{}--{kind}-", project_key(project_id));
    name.starts_with(&prefix)
        && name.len() > prefix.len() + 8
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn resumable(tab: &SavedTab) -> bool {
    const BUILTIN: &[&str] = &[
        "claude",
        "codex",
        "qwen",
        "opencode",
        "copilot",
        "cursor-agent",
        "grok",
        "gemini",
        "agy",
        "vibe",
    ];
    tab.session_id.is_some()
        && (BUILTIN.contains(&tab.cmd.as_str())
            || tab.resume_args.as_ref().is_some_and(|v| !v.is_empty()))
}

fn canonical_below(path: &Path, root: &Path) -> bool {
    path.canonicalize()
        .ok()
        .is_some_and(|p| p.starts_with(root))
}

fn live_tmux() -> HashMap<String, LiveTmux> {
    let format = "#{session_name}\t#{session_activity}\t#{pane_current_path}";
    let Ok(out) = Command::new("tmux").args(["ls", "-F", format]).output() else {
        return HashMap::new();
    };
    if !out.status.success() {
        return HashMap::new();
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| {
            let mut p = line.splitn(3, '\t');
            let name = p.next()?.to_string();
            let activity = p.next()?.parse().ok()?;
            let cwd = PathBuf::from(p.next()?);
            Some((name, LiveTmux { activity, cwd }))
        })
        .collect()
}

impl Catalog {
    pub fn load(state_dir: &Path, host_key: &[u8]) -> Result<Self, String> {
        let bytes =
            fs::read(state_dir.join("projects.json")).map_err(|e| format!("read projects: {e}"))?;
        let projects: Vec<ProjectRecord> =
            serde_json::from_slice(&bytes).map_err(|e| format!("parse projects: {e}"))?;
        let live = live_tmux();
        let mut resolved = Vec::new();
        for project in projects {
            if !project.eldrun_mobile_access
                || project.remote.is_some()
                || enabled(&project.sandbox)
                || enabled(&project.vm)
            {
                continue;
            }
            let Some(root_raw) = project.directory.as_deref() else {
                continue;
            };
            let Ok(root) = Path::new(root_raw).canonicalize() else {
                continue;
            };
            let session_path = state_dir
                .join("sessions")
                .join(project_key(&project.id))
                .join("terminals.json");
            let session: SessionFile = match fs::read(&session_path) {
                Ok(bytes) => serde_json::from_slice(&bytes)
                    .map_err(|error| format!("parse session {}: {error}", project.id))?,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    SessionFile { tab_layout: vec![] }
                }
                Err(error) => return Err(format!("read session {}: {error}", project.id)),
            };
            let mut tabs = Vec::new();
            // project-tree-read: ok — this is the state-dir terminal-session snapshot.
            for tab in session.tab_layout {
                let eligible_kind = tab.kind == "shell" || (tab.kind == "agent" && resumable(&tab));
                if !eligible_kind
                    || tab.ephemeral
                    || tab.tmux_attach.is_some()
                    || !canonical_below(Path::new(&tab.cwd), &root)
                {
                    continue;
                }
                let Some(tmux) = tab.tmux_session.as_deref() else {
                    continue;
                };
                if !expected_tmux(&project.id, &tab.kind, tmux) {
                    continue;
                }
                let live_row = live
                    .get(tmux)
                    .filter(|row| canonical_below(&row.cwd, &root));
                let public = PublicTab {
                    id: key_id(host_key, "tab", &[&project.id, tmux]),
                    label: tab.label.chars().take(120).collect(),
                    kind: tab.kind.clone(),
                    agent_label: (tab.kind == "agent")
                        .then(|| tab.label.chars().take(120).collect()),
                    available: live_row.is_some(),
                    viewer_busy: false,
                    last_activity: live_row.map(|r| r.activity),
                };
                tabs.push(ResolvedTab {
                    public,
                    tmux_name: tmux.to_string(),
                });
            }
            let last_activity = tabs.iter().filter_map(|t| t.public.last_activity).max();
            let public = PublicProject {
                id: key_id(host_key, "project", &[&project.id]),
                label: project.name.chars().take(120).collect(),
                status: project.status,
                live_sessions: tabs.iter().filter(|t| t.public.available).count(),
                last_activity,
            };
            resolved.push(ResolvedProject {
                public,
                raw_id: project.id,
                root,
                tabs,
            });
        }
        Ok(Self { projects: resolved })
    }

    pub fn project(&self, id: &str) -> Option<&ResolvedProject> {
        self.projects.iter().find(|p| p.public.id == id)
    }
    pub fn tab(&self, id: &str) -> Option<(&ResolvedProject, &ResolvedTab)> {
        self.projects
            .iter()
            .find_map(|p| p.tabs.iter().find(|t| t.public.id == id).map(|t| (p, t)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opaque_ids_are_domain_separated_and_stable() {
        let key = [7u8; 32];
        assert_eq!(
            key_id(&key, "project", &["a"]),
            key_id(&key, "project", &["a"])
        );
        assert_ne!(key_id(&key, "project", &["a"]), key_id(&key, "tab", &["a"]));
        assert!(!key_id(&key, "project", &["secret-project"]).contains("secret"));
    }

    #[test]
    fn exact_session_names_only() {
        assert!(expected_tmux("p1", "shell", "eldrun-p1--shell-123456789"));
        assert!(!expected_tmux("p1", "shell", "eldrun-p2--shell-123456789"));
        assert!(!expected_tmux("p1", "shell", "eldrun-p1--agent-123456789"));
    }

    #[test]
    fn cache_retains_last_valid_snapshot_during_partial_write() {
        let dir = tempfile::tempdir().expect("state dir");
        fs::write(dir.path().join("projects.json"), b"[]").expect("projects");
        let mut cache = CatalogCache::default();
        assert!(cache.load(dir.path(), &[7; 32]).is_ok());
        fs::write(dir.path().join("projects.json"), b"[").expect("partial projects");
        assert!(cache.load(dir.path(), &[7; 32]).is_ok());
    }
}
