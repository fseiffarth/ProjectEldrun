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

    /// The provider's official CLI binary.
    fn cli(self) -> &'static str {
        match self {
            Provider::GitHub => "gh",
            Provider::GitLab => "glab",
        }
    }

    /// The `repo edit` argv that flips the current repo's visibility in place
    /// (no re-create). GitHub requires an explicit consent flag for the change.
    fn visibility_edit_args(self, visibility: &str) -> Vec<String> {
        match self {
            Provider::GitHub => vec![
                "repo".into(),
                "edit".into(),
                "--visibility".into(),
                visibility.into(),
                "--accept-visibility-change-consequences".into(),
            ],
            Provider::GitLab => vec![
                "repo".into(),
                "edit".into(),
                "--visibility".into(),
                visibility.into(),
            ],
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

/// Unpublish a project: forget its hosting push target **without** deleting
/// either its local history or the hosted repository. Removes the `origin`
/// remote (locally, or over ssh on the work-remote host where the repo lives),
/// resets `git_type` to `"local"`, and clears `git_provider`.
///
/// This is the safe inverse of `publish_project`: commits are never touched and
/// the GitHub/GitLab repo is left intact — only the local tree is detached from
/// it. Re-publishing later re-creates or re-attaches a remote.
#[tauri::command]
pub fn unpublish_project(project_id: String) -> Result<(), String> {
    let (idx, mut list) = find_entry(&project_id)?;
    let local_file = list[idx].local_file.clone();
    let project: Project =
        storage::read_json(&PathBuf::from(&local_file)).map_err(|e| e.to_string())?;

    let gt = project
        .git_type
        .as_deref()
        .map(normalize_git_type)
        .unwrap_or_default();
    if !gt.starts_with("remote") {
        return Err("Project is not published to a remote".to_string());
    }

    match project.remote.as_ref() {
        // Work-remote project: the repo (and its `origin`) live on the host.
        Some(remote) => {
            let base = ssh_base_args(&remote.user, &remote.host, remote.port)?;
            validate_arg("remote_path", &remote.remote_path)?;
            let path = shell_quote(&remote.remote_path);
            // A missing origin is fine — the goal state is simply "no origin".
            let script = format!("cd {path} && git remote remove origin 2>/dev/null || true");
            run_command(crate::paths::command_no_window("ssh").args(&base).arg(script))?;
        }
        None => {
            let dir = PathBuf::from(&project.directory);
            if !dir.is_dir() {
                return Err(format!(
                    "Project directory does not exist: {}",
                    project.directory
                ));
            }
            // Ignore failure (e.g. origin already absent) — desired end state is "no origin".
            let _ = crate::paths::command_no_window("git")
                .current_dir(&dir)
                .args(["remote", "remove", "origin"])
                .output();
        }
    }

    list[idx]
        .extra
        .insert("git_type".to_string(), Value::String("local".to_string()));
    list[idx].extra.remove("git_provider");
    storage::write_json(&storage::state_dir().join("projects.json"), &list)
        .map_err(|e| e.to_string())?;

    let proj_path = PathBuf::from(&local_file);
    if proj_path.exists() {
        if let Ok(mut p) = storage::read_json::<Project>(&proj_path) {
            p.git_type = Some("local".to_string());
            p.git_provider = None;
            let _ = storage::write_json(&proj_path, &p);
        }
    }
    Ok(())
}

/// Flip a published project's repository visibility (public ↔ private) in place
/// via the provider's `repo edit` verb — no re-create, so the repo, its URL, and
/// its history are preserved. Updates `git_type` to `remote-<visibility>`.
///
/// Runs locally, or over ssh on the work-remote host for a remote project
/// (relying on that host's provider auth, exactly like `publish_project`).
#[tauri::command]
pub fn set_project_visibility(project_id: String, visibility: String) -> Result<String, String> {
    let visibility = match visibility.trim() {
        "public" => "public",
        "private" => "private",
        other => {
            return Err(format!(
                "visibility must be 'public' or 'private', got '{other}'"
            ))
        }
    };

    let (idx, mut list) = find_entry(&project_id)?;
    let local_file = list[idx].local_file.clone();
    let project: Project =
        storage::read_json(&PathBuf::from(&local_file)).map_err(|e| e.to_string())?;

    let gt = project
        .git_type
        .as_deref()
        .map(normalize_git_type)
        .unwrap_or_default();
    if !gt.starts_with("remote") {
        return Err("Project is not published to a remote".to_string());
    }
    let provider = Provider::parse(project.git_provider.as_deref().unwrap_or("github"))?;

    let stdout = match project.remote.as_ref() {
        Some(remote) => {
            let base = ssh_base_args(&remote.user, &remote.host, remote.port)?;
            validate_arg("remote_path", &remote.remote_path)?;
            let script = remote_visibility_script(provider, &remote.remote_path, visibility);
            run_command(crate::paths::command_no_window("ssh").args(&base).arg(script))?
        }
        None => {
            let dir = PathBuf::from(&project.directory);
            if !dir.is_dir() {
                return Err(format!(
                    "Project directory does not exist: {}",
                    project.directory
                ));
            }
            let (_profile, token) = crate::commands::git_hosting::effective_git_creds(&project_id);
            local_set_visibility(provider, &dir, visibility, token.as_deref())?
        }
    };

    let new_git_type = normalize_git_type(&format!("remote-{visibility}"));
    list[idx]
        .extra
        .insert("git_type".to_string(), Value::String(new_git_type.clone()));
    storage::write_json(&storage::state_dir().join("projects.json"), &list)
        .map_err(|e| e.to_string())?;

    let proj_path = PathBuf::from(&local_file);
    if proj_path.exists() {
        if let Ok(mut p) = storage::read_json::<Project>(&proj_path) {
            p.git_type = Some(new_git_type);
            let _ = storage::write_json(&proj_path, &p);
        }
    }
    Ok(stdout.trim().to_string())
}

/// Migrate a published project to the **other** hosting provider. Because this
/// is a true migration (not a rename), the existing `origin` is moved aside to
/// `origin-old` — the old provider's repository is intentionally **left intact**
/// (we never delete someone's hosted repo) and stays reachable as `origin-old` —
/// then a fresh publish creates the repo on the new provider, wires `origin`,
/// and pushes. Records the new `git_provider` + `git_type` (via the reused
/// `publish_project`). Returns the create CLI's stdout (new repo URL).
#[tauri::command]
pub fn switch_project_provider(
    project_id: String,
    provider: Option<String>,
    visibility: String,
) -> Result<String, String> {
    let new_provider = Provider::parse(provider.as_deref().unwrap_or("github"))?;
    let visibility = match visibility.trim() {
        "public" | "private" => visibility.trim().to_string(),
        other => {
            return Err(format!(
                "visibility must be 'public' or 'private', got '{other}'"
            ))
        }
    };

    let (idx, list) = find_entry(&project_id)?;
    let local_file = list[idx].local_file.clone();
    let project: Project =
        storage::read_json(&PathBuf::from(&local_file)).map_err(|e| e.to_string())?;

    let gt = project
        .git_type
        .as_deref()
        .map(normalize_git_type)
        .unwrap_or_default();
    if !gt.starts_with("remote") {
        return Err("Project is not published — use Publish instead".to_string());
    }
    if project.git_provider.as_deref() == Some(new_provider.as_str()) {
        return Err(format!("Project is already on {}", new_provider.as_str()));
    }

    // Move the existing origin aside so a fresh publish can wire a new one. The
    // old hosted repo is intentionally left intact (reachable as origin-old).
    rename_origin_aside(&project)?;

    // Delegate the create+wire+push+persist to the normal publish path, now
    // targeting the new provider.
    publish_project(project_id, Some(new_provider.as_str().to_string()), visibility)
}

/// Run the provider's `repo edit --visibility` for a *local* project.
fn local_set_visibility(
    provider: Provider,
    dir: &PathBuf,
    visibility: &str,
    token: Option<&str>,
) -> Result<String, String> {
    let mut cmd = crate::paths::command_no_window(provider.cli());
    cmd.current_dir(dir).args(provider.visibility_edit_args(visibility));
    if let Some(tok) = token {
        cmd.env(provider.token_env(), tok);
    }
    run_command(&mut cmd)
}

/// Build the remote-host shell script that flips visibility over ssh. `visibility`
/// is a fixed `public`/`private` literal (validated by the caller); `remote_path`
/// is single-quoted for the remote shell.
fn remote_visibility_script(provider: Provider, remote_path: &str, visibility: &str) -> String {
    let path = shell_quote(remote_path);
    let args = provider.visibility_edit_args(visibility).join(" ");
    format!("cd {path} && {} {args}", provider.cli())
}

/// Rename a project's existing `origin` remote to `origin-old` (best effort),
/// dropping any stale prior `origin-old` first. Runs locally, or over ssh on the
/// work-remote host. Used by `switch_project_provider` so a fresh publish can
/// wire a new `origin` without clobbering the reference to the old repo.
fn rename_origin_aside(project: &Project) -> Result<(), String> {
    match project.remote.as_ref() {
        Some(remote) => {
            let base = ssh_base_args(&remote.user, &remote.host, remote.port)?;
            validate_arg("remote_path", &remote.remote_path)?;
            let path = shell_quote(&remote.remote_path);
            let script = format!(
                "cd {path} && git remote remove origin-old 2>/dev/null; \
                 git remote rename origin origin-old 2>/dev/null || true"
            );
            run_command(crate::paths::command_no_window("ssh").args(&base).arg(script))?;
        }
        None => {
            let dir = PathBuf::from(&project.directory);
            let _ = crate::paths::command_no_window("git")
                .current_dir(&dir)
                .args(["remote", "remove", "origin-old"])
                .output();
            let _ = crate::paths::command_no_window("git")
                .current_dir(&dir)
                .args(["remote", "rename", "origin", "origin-old"])
                .output();
        }
    }
    Ok(())
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

    #[test]
    fn github_visibility_edit_requires_consent_flag() {
        let args = Provider::GitHub.visibility_edit_args("private");
        assert_eq!(
            args,
            vec![
                "repo",
                "edit",
                "--visibility",
                "private",
                "--accept-visibility-change-consequences"
            ]
        );
    }

    #[test]
    fn gitlab_visibility_edit_has_no_consent_flag() {
        let args = Provider::GitLab.visibility_edit_args("public");
        assert_eq!(args, vec!["repo", "edit", "--visibility", "public"]);
    }

    #[test]
    fn remote_visibility_script_quotes_path_and_uses_cli() {
        let s = remote_visibility_script(Provider::GitLab, "/srv/proj", "public");
        assert_eq!(
            s,
            "cd '/srv/proj' && glab repo edit --visibility public"
        );
    }
}
