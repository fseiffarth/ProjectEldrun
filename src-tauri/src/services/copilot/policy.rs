//! Context authorization happens before document text reaches a subprocess.
use crate::schema::Settings;
use std::path::{Path, PathBuf};

#[derive(Debug, PartialEq, Eq)]
pub enum PolicyError {
    Disabled,
    Remote,
    NoConsent,
    LocalOnly,
    InvalidPath,
    OutsideProject,
}

/// `directory` and `remote` must come from the backend project resolver, not
/// the command's payload or the file's apparent path. Recheck on every sync.
pub fn authorize_project(
    settings: &Settings,
    project_id: &str,
    directory: &Path,
    remote: bool,
) -> Result<PathBuf, PolicyError> {
    if settings.code_completion_provider.as_deref() != Some("copilot")
        || !settings
            .copilot_completion
            .unwrap_or(settings.debug.unwrap_or(false))
    {
        return Err(PolicyError::Disabled);
    }
    if remote {
        return Err(PolicyError::Remote);
    }
    let policy = settings
        .completion_project_policies
        .as_ref()
        .and_then(|policies| policies.get(project_id))
        .ok_or(PolicyError::NoConsent)?;
    if policy.local_only {
        return Err(PolicyError::LocalOnly);
    }
    if !policy.copilot {
        return Err(PolicyError::NoConsent);
    }
    if !directory.is_absolute() {
        return Err(PolicyError::InvalidPath);
    }
    let root = directory
        .canonicalize()
        .map_err(|_| PolicyError::InvalidPath)?;
    // Consent contains the canonical path as it was at opt-in time. Do not
    // canonicalize it again: replacing a consented path with a symlink must
    // require new consent, even when the project id remains the same.
    if Path::new(&policy.directory) != root || !root.is_dir() {
        return Err(PolicyError::NoConsent);
    }
    Ok(root)
}

pub fn authorize_document(root: &Path, path: &Path) -> Result<PathBuf, PolicyError> {
    if !path.is_absolute() {
        return Err(PolicyError::InvalidPath);
    }
    let file = path.canonicalize().map_err(|_| PolicyError::InvalidPath)?;
    if !file.starts_with(root) || !file.is_file() {
        return Err(PolicyError::OutsideProject);
    }
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn settings(directory: &Path) -> Settings {
        // Opt-in records the canonical path (macOS /private/var, Windows \\?\).
        let directory = directory.canonicalize().unwrap();
        serde_json::from_value(json!({
            "code_completion_provider":"copilot", "copilot_completion":true,
            "completion_project_policies":{"one":{"directory":directory,"copilot":true}}
        }))
        .unwrap()
    }

    #[test]
    fn missing_settings_keep_ollama_and_require_explicit_consent() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            authorize_project(&Settings::default(), "one", dir.path(), false),
            Err(PolicyError::Disabled)
        );
        let mut config = settings(dir.path());
        assert!(authorize_project(&config, "one", dir.path(), false).is_ok());
        assert_eq!(
            authorize_project(&config, "two", dir.path(), false),
            Err(PolicyError::NoConsent)
        );
        assert_eq!(
            authorize_project(&config, "one", dir.path(), true),
            Err(PolicyError::Remote)
        );
        config
            .completion_project_policies
            .as_mut()
            .unwrap()
            .get_mut("one")
            .unwrap()
            .local_only = true;
        assert_eq!(
            authorize_project(&config, "one", dir.path(), false),
            Err(PolicyError::LocalOnly)
        );
        config.copilot_completion = Some(false);
        config.debug = Some(true);
        assert_eq!(
            authorize_project(&config, "one", dir.path(), false),
            Err(PolicyError::Disabled)
        );
    }

    #[test]
    fn consent_cannot_follow_a_repointed_project() {
        let one = tempfile::tempdir().unwrap();
        let two = tempfile::tempdir().unwrap();
        assert_eq!(
            authorize_project(&settings(one.path()), "one", two.path(), false),
            Err(PolicyError::NoConsent)
        );
        std::fs::write(two.path().join("code.ts"), "synthetic").unwrap();
        assert_eq!(
            authorize_document(one.path(), &two.path().join("code.ts")),
            Err(PolicyError::OutsideProject)
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlink_cannot_export_another_project() {
        let one = tempfile::tempdir().unwrap();
        let two = tempfile::tempdir().unwrap();
        let file = two.path().join("code.ts");
        std::fs::write(&file, "synthetic").unwrap();
        let link = one.path().join("link.ts");
        std::os::unix::fs::symlink(file, &link).unwrap();
        assert_eq!(
            authorize_document(one.path(), &link),
            Err(PolicyError::OutsideProject)
        );
    }

    #[test]
    fn settings_preserve_legacy_roles_and_unknown_policy_fields() {
        let value = json!({"ollama_model":"coder", "ollama_roles":{"autocomplete":"code","autocomplete_prose":"prose"},
            "python_setting":[1,2], "completion_project_policies":{"one":{"directory":"/project","copilot":true,"future":42}}});
        let config: Settings = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(config.code_completion_provider, None);
        assert_eq!(config.copilot_completion, None);
        let result = serde_json::to_value(config).unwrap();
        for key in ["ollama_model", "ollama_roles", "python_setting"] {
            assert_eq!(result[key], value[key]);
        }
        assert_eq!(result["completion_project_policies"]["one"]["future"], 42);
        assert!(result.get("code_completion_provider").is_none());
    }
}
