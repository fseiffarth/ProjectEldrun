//! Publishing a project's git repository to a hosting provider (GitHub or
//! GitLab), via the provider's official CLI (`gh` / `glab`).
//!
//! Publishing creates a remote repo from the project's git working tree and
//! pushes to it. The project's push target (`git_type`) is then updated to
//! `remote-<visibility>` and its `git_provider` recorded.
//!
//! Provider parity:
//! - GitHub uses `gh repo create … --source=. --remote=origin --push`, which
//!   creates the repo, wires `origin`, and pushes the existing history in one go.
//! - GitLab's `glab repo create` has no `--source/--push`: it creates the
//!   project and adds the `origin` remote, so we follow it with an explicit
//!   `git push -u origin HEAD` to upload the existing commits.
//!
//! A project's bytes may live locally or on an SSH work-remote host. For a
//! remote project the publish must originate where the repo actually is, so the
//! CLI invocation runs over `ssh` on the remote host (mirroring `commands::ssh`:
//! `BatchMode`, validated argv, no shell string built from untrusted input — the
//! remote path/name are single-quoted for the remote shell). Remote publishing
//! relies on the work-remote host's own `gh`/`glab` auth (we don't forward the
//! token over ssh), matching the prior GitHub behavior.

use std::path::PathBuf;
use std::process::Command;

use serde_json::Value;

use crate::commands::projects::{normalize_git_type, sanitize_name};
use crate::schema::project::Project;
use crate::schema::projects::ProjectsList;
use crate::services::ssh_common::{ssh_base_args, validate_arg};
use crate::storage;

/// A supported git-hosting provider.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Provider {
    GitHub,
    GitLab,
}

impl Provider {
    /// Parse the frontend's provider string. Defaults to GitHub when omitted so
    /// older callers (and the historical single-provider behavior) keep working.
    fn parse(s: &str) -> Result<Self, String> {
        match s.trim().to_ascii_lowercase().as_str() {
            "" | "github" => Ok(Provider::GitHub),
            "gitlab" => Ok(Provider::GitLab),
            other => Err(format!("provider must be 'github' or 'gitlab', got '{other}'")),
        }
    }

    /// The canonical string persisted in `git_provider`.
    fn as_str(self) -> &'static str {
        match self {
            Provider::GitHub => "github",
            Provider::GitLab => "gitlab",
        }
    }

    /// The env var that lets the CLI authenticate non-interactively from a token
    /// (used for local publishing; the absent case falls back to the CLI's own
    /// `… auth login`).
    fn token_env(self) -> &'static str {
        match self {
            Provider::GitHub => "GH_TOKEN",
            Provider::GitLab => "GITLAB_TOKEN",
        }
    }

    /// The username an https credential helper presents alongside a PAT. Both
    /// providers ignore the username for PAT auth, but we use each one's
    /// convention.
    fn cred_username(self) -> &'static str {
        match self {
            Provider::GitHub => "x-access-token",
            Provider::GitLab => "oauth2",
        }
    }
}

/// Publish a project's git repository to a hosting provider and record the new
/// push target.
///
/// `provider` is "github" or "gitlab" (defaulting to GitHub when empty).
/// `visibility` must be "public" or "private". Returns the CLI's stdout
/// (typically the new repository URL) on success, or the trimmed stderr on
/// failure.
#[tauri::command]
pub fn publish_project(
    project_id: String,
    provider: Option<String>,
    visibility: String,
) -> Result<String, String> {
    let provider = Provider::parse(provider.as_deref().unwrap_or("github"))?;
    let visibility = match visibility.trim() {
        "public" => "public",
        "private" => "private",
        other => {
            return Err(format!(
                "visibility must be 'public' or 'private', got '{other}'"
            ))
        }
    };

    let (entry_index, mut list) = find_entry(&project_id)?;
    let local_file = list[entry_index].local_file.clone();
    let project: Project =
        storage::read_json(&PathBuf::from(&local_file)).map_err(|e| e.to_string())?;

    // Repo names can't contain spaces/special chars; reuse the project name
    // sanitizer that already produces a safe slug for local directories.
    let repo_name = sanitize_name(&project.name);
    if repo_name.is_empty() {
        return Err("Project name does not yield a valid repository name".to_string());
    }

    // Effective per-project → global token. When set, run the CLI as that token's
    // account via the provider's token env var instead of relying on the ambient
    // `… auth login`.
    let (_profile, token) = crate::commands::git_hosting::effective_git_creds(&project_id);

    let stdout = match project.remote.as_ref() {
        // Remote project: run the CLI on the host where the bytes live, relying on
        // the remote host's own provider auth.
        Some(remote) => {
            let base = ssh_base_args(&remote.user, &remote.host, remote.port)?;
            validate_arg("remote_path", &remote.remote_path)?;
            let script =
                remote_publish_script(provider, &remote.remote_path, &repo_name, visibility);
            // `command_no_window` avoids a console-window flash on Windows.
            run_command(crate::paths::command_no_window("ssh").args(&base).arg(script))?
        }
        // Local project: run the CLI in the project directory.
        None => {
            let dir = PathBuf::from(&project.directory);
            if !dir.is_dir() {
                return Err(format!(
                    "Project directory does not exist: {}",
                    project.directory
                ));
            }
            local_publish(provider, &dir, &repo_name, visibility, token.as_deref())?
        }
    };

    // Reflect the new push target + provider in both projects.json and project.json.
    let new_git_type = normalize_git_type(&format!("remote-{visibility}"));
    list[entry_index]
        .extra
        .insert("git_type".to_string(), Value::String(new_git_type.clone()));
    list[entry_index].extra.insert(
        "git_provider".to_string(),
        Value::String(provider.as_str().to_string()),
    );
    storage::write_json(&storage::state_dir().join("projects.json"), &list)
        .map_err(|e| e.to_string())?;

    let proj_path = PathBuf::from(&local_file);
    if proj_path.exists() {
        if let Ok(mut p) = storage::read_json::<Project>(&proj_path) {
            p.git_type = Some(new_git_type);
            p.git_provider = Some(provider.as_str().to_string());
            let _ = storage::write_json(&proj_path, &p);
        }
    }

    Ok(stdout.trim().to_string())
}

/// Run the provider's create (and, for GitLab, an explicit push) for a *local*
/// project, returning the combined CLI stdout.
fn local_publish(
    provider: Provider,
    dir: &PathBuf,
    repo_name: &str,
    visibility: &str,
    token: Option<&str>,
) -> Result<String, String> {
    match provider {
        // `gh repo create` creates, wires origin, and pushes in one command.
        Provider::GitHub => {
            let mut cmd = crate::paths::command_no_window("gh");
            cmd.current_dir(dir).args([
                "repo",
                "create",
                repo_name,
                &format!("--{visibility}"),
                "--source=.",
                "--remote=origin",
                "--push",
            ]);
            if let Some(tok) = token {
                cmd.env(provider.token_env(), tok);
            }
            run_command(&mut cmd)
        }
        // `glab repo create` creates the project and adds `origin`, but does not
        // push existing history — so do that as a second, token-authenticated step.
        Provider::GitLab => {
            let mut create = crate::paths::command_no_window("glab");
            create.current_dir(dir).args([
                "repo",
                "create",
                repo_name,
                &format!("--{visibility}"),
                "--remoteName",
                "origin",
            ]);
            if let Some(tok) = token {
                create.env(provider.token_env(), tok);
            }
            let mut out = run_command(&mut create)?;

            let mut push = crate::paths::command_no_window("git");
            push.current_dir(dir);
            push_with_token(&mut push, provider, token);
            push.args(["push", "-u", "origin", "HEAD"]);
            out.push('\n');
            out.push_str(&run_command(&mut push)?);
            Ok(out)
        }
    }
}

/// Build the remote-host shell script that performs the publish over ssh.
fn remote_publish_script(
    provider: Provider,
    remote_path: &str,
    repo_name: &str,
    visibility: &str,
) -> String {
    let path = shell_quote(remote_path);
    let name = shell_quote(repo_name);
    match provider {
        Provider::GitHub => format!(
            "cd {path} && gh repo create {name} --{visibility} --source=. --remote=origin --push"
        ),
        // Mirror the local two-step flow on the remote; the remote host's git
        // credentials/ssh auth carry the push.
        Provider::GitLab => format!(
            "cd {path} && glab repo create {name} --{visibility} --remoteName origin \
             && git push -u origin HEAD"
        ),
    }
}

/// Attach an ephemeral inline https credential helper that injects the effective
/// token (read from the child env, never argv/disk) so a `git push` to a freshly
/// created https remote authenticates. Harmless for ssh remotes — git won't call
/// an http helper. Mirrors the helper in `commands::git::git_push`.
fn push_with_token(cmd: &mut Command, provider: Provider, token: Option<&str>) {
    let Some(tok) = token else { return };
    let helper = format!(
        "!f() {{ test \"$1\" = get && echo username={} && echo \"password=$ELDRUN_GIT_TOKEN\"; }}; f",
        provider.cred_username()
    );
    cmd.args(["-c", "credential.helper=", "-c", &helper]);
    cmd.env("ELDRUN_GIT_TOKEN", tok);
    cmd.env("GIT_TERMINAL_PROMPT", "0");
}

/// Find a project entry by id, returning its index and the full (owned) list so
/// the caller can mutate + persist it.
fn find_entry(project_id: &str) -> Result<(usize, ProjectsList), String> {
    let list_path = storage::state_dir().join("projects.json");
    let list: ProjectsList = if list_path.exists() {
        storage::read_json(&list_path).map_err(|e| e.to_string())?
    } else {
        Vec::new()
    };
    let idx = list
        .iter()
        .position(|p| p.id == project_id)
        .ok_or_else(|| format!("project '{project_id}' not found"))?;
    Ok((idx, list))
}

/// Run a command, returning trimmed stdout on success or a useful error
/// (stderr, else stdout, else a generic message) on failure.
fn run_command(cmd: &mut Command) -> Result<String, String> {
    let output = cmd
        .output()
        .map_err(|e| format!("failed to run command: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if !stderr.is_empty() {
            return Err(stderr);
        }
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !stdout.is_empty() {
            return Err(stdout);
        }
        return Err("command failed".to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Single-quote a string for safe embedding in a remote `/bin/sh` command,
/// escaping any embedded single quotes.
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_quote_wraps_plain_value() {
        assert_eq!(shell_quote("/home/user/proj"), "'/home/user/proj'");
    }

    #[test]
    fn shell_quote_escapes_embedded_single_quotes() {
        assert_eq!(shell_quote("a'b"), r"'a'\''b'");
        // The result is a safe single-quoted shell token (no unescaped quote
        // breaks out of the quoting).
        assert!(shell_quote("; rm -rf /").starts_with('\''));
    }

    #[test]
    fn provider_parse_defaults_and_validates() {
        assert!(matches!(Provider::parse(""), Ok(Provider::GitHub)));
        assert!(matches!(Provider::parse("GitHub"), Ok(Provider::GitHub)));
        assert!(matches!(Provider::parse("gitlab"), Ok(Provider::GitLab)));
        assert!(Provider::parse("bitbucket").is_err());
    }

    #[test]
    fn github_remote_script_is_single_command_push() {
        let s = remote_publish_script(Provider::GitHub, "/srv/proj", "my-proj", "public");
        assert_eq!(
            s,
            "cd '/srv/proj' && gh repo create 'my-proj' --public --source=. --remote=origin --push"
        );
    }

    #[test]
    fn gitlab_remote_script_creates_then_pushes() {
        let s = remote_publish_script(Provider::GitLab, "/srv/proj", "my-proj", "private");
        assert!(s.contains("glab repo create 'my-proj' --private --remoteName origin"));
        assert!(s.contains("&& git push -u origin HEAD"));
    }
}
