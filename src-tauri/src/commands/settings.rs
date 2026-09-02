use crate::schema::settings::WindowState;
use crate::schema::Settings;
use crate::storage;
use serde_json::{Map, Value};

#[tauri::command]
pub fn get_settings() -> Result<Settings, String> {
    let path = storage::state_dir().join("settings.json");
    let mut settings = if path.exists() {
        storage::read_json(&path).map_err(|e| e.to_string())?
    } else {
        Settings::default()
    };
    // Seed platform-appropriate global apps when none are configured. The
    // global-app toolbar only renders roles that have an entry, so a fresh
    // install (no `global_apps` in settings.json) shows an empty bar. On Linux
    // these were historically seeded by the legacy app; on Windows nothing
    // populated them, leaving the toolbar blank. Detection runs at read time and
    // is not persisted, so the bar appears immediately; the first edit in the
    // Global Apps settings panel writes the merged set back to disk.
    seed_default_global_apps(&mut settings);
    Ok(settings)
}

fn seed_default_global_apps(settings: &mut Settings) {
    if settings
        .global_apps
        .as_ref()
        .is_none_or(|apps| apps.is_empty())
    {
        if let Some(defaults) = default_global_apps() {
            settings.global_apps = Some(defaults);
        }
    }
}

#[tauri::command]
pub fn save_settings(settings: Settings) -> Result<(), String> {
    let path = storage::state_dir().join("settings.json");
    storage::write_json_atomic(&path, &settings).map_err(|e| e.to_string())
}

/// Atomically merge a frontend settings patch against the latest file.
///
/// Every webview has its own JS heap and therefore its own settings cache. A
/// frontend read followed by `save_settings` is two independent transactions:
/// another window can commit between them and have its unrelated change
/// overwritten by the stale whole object. This command keeps read + shallow
/// merge + write under `storage`'s process-wide JSON mutation lock and returns
/// the exact object that won, so every sender can broadcast the same snapshot.
#[tauri::command]
pub fn patch_settings(patch: Map<String, Value>) -> Result<Settings, String> {
    let path = storage::state_dir().join("settings.json");
    storage::patch_json(&path, Settings::default(), |settings| {
        seed_default_global_apps(settings);
        merge_settings_patch(settings, patch)?;
        Ok(settings.clone())
    })
}

fn merge_settings_patch(settings: &mut Settings, patch: Map<String, Value>) -> Result<(), String> {
    let mut value = serde_json::to_value(&*settings).map_err(|e| e.to_string())?;
    let current = value
        .as_object_mut()
        .ok_or_else(|| "settings must serialize as an object".to_string())?;
    current.extend(patch);
    *settings = serde_json::from_value(value).map_err(|e| e.to_string())?;
    Ok(())
}

/// Persist only the main window's geometry, leaving every other setting on disk
/// untouched.
///
/// Kept as a dedicated patch because this fires on a debounce every time the
/// user drags or resizes the main window; it must never replace unrelated keys.
#[tauri::command]
pub fn save_window_state(state: WindowState) -> Result<(), String> {
    let path = storage::state_dir().join("settings.json");
    storage::patch_json(&path, Settings::default(), |settings| {
        settings.window_state = Some(state);
        Ok(())
    })
}

/// Detect installed apps for the global-app toolbar roles on the current
/// platform. Only roles whose executable actually resolves are returned, so the
/// seeded buttons always launch something. Returns `None` when nothing is
/// detected (e.g. unsupported platform), leaving the toolbar empty as before.
fn default_global_apps(
) -> Option<std::collections::HashMap<String, crate::schema::settings::GlobalAppEntry>> {
    #[cfg(target_os = "windows")]
    {
        detect_windows_global_apps()
    }
    #[cfg(target_os = "macos")]
    {
        detect_macos_global_apps()
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        detect_linux_global_apps()
    }
}

/// Seed the global-app toolbar with common Linux desktop apps for the shared
/// roles. Unlike Windows/macOS, a Linux app has no fixed install path, so each
/// candidate is a binary name resolved via `PATH` (`crate::paths::resolve_executable`,
/// which already covers the GUI-launched-process PATH gap). Mail, calendar,
/// file-manager, system-monitor, notes and media-player roles are deliberately
/// absent, for the same reason as the other two platforms: Eldrun has its own
/// of each. There is no app guaranteed present on every distro, so — unlike
/// macOS (Safari) — the toolbar can still come back empty on a minimal
/// install; a role can always be set by hand in the Global Apps settings panel.
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn detect_linux_global_apps(
) -> Option<std::collections::HashMap<String, crate::schema::settings::GlobalAppEntry>> {
    use crate::schema::settings::GlobalAppEntry;
    use std::collections::HashMap;

    // role -> ordered candidate binary names on PATH (first found wins).
    let candidates: [(&str, &[&str]); 4] = [
        (
            "browser",
            &[
                "firefox",
                "google-chrome",
                "chromium-browser",
                "chromium",
                "brave-browser",
            ],
        ),
        ("password_manager", &["keepassxc", "bitwarden", "keepassx"]),
        (
            "screenshot",
            &[
                "spectacle",
                "flameshot",
                "gnome-screenshot",
                "ksnip",
                "shutter",
                "xfce4-screenshooter",
                "scrot",
                "maim",
            ],
        ),
        (
            "screen_recorder",
            &["kazam", "simplescreenrecorder", "vokoscreen", "peek", "obs"],
        ),
    ];

    let detected: HashMap<String, GlobalAppEntry> = candidates
        .into_iter()
        .filter_map(|(role, bins)| {
            bins.iter()
                .find_map(|bin| crate::paths::resolve_executable(bin))
                .map(|path| {
                    (
                        role.to_string(),
                        GlobalAppEntry {
                            exec: path.to_string_lossy().to_string(),
                            visible: true,
                            extra: HashMap::new(),
                        },
                    )
                })
        })
        .collect();

    if detected.is_empty() {
        None
    } else {
        Some(detected)
    }
}

/// First existing path among `candidates`, or `None`. Used to pick the
/// best-available executable for a role across install locations.
#[cfg(any(target_os = "windows", target_os = "macos"))]
fn first_existing(candidates: &[String]) -> Option<String> {
    candidates
        .iter()
        .find(|p| !p.is_empty() && std::path::Path::new(p).exists())
        .cloned()
}

/// Build a `\\`-joined path under an environment-variable-rooted directory,
/// returning an empty string when the variable is unset so the candidate is
/// skipped by [`first_existing`].
#[cfg(target_os = "windows")]
fn env_join(var: &str, tail: &str) -> String {
    match std::env::var(var) {
        Ok(root) if !root.is_empty() => format!("{root}\\{tail}"),
        _ => String::new(),
    }
}

/// Probe well-known install locations for the common global-app roles on
/// Windows. Every role is included only when found, so the toolbar can come
/// back empty. Mail, calendar, file-manager, system-monitor, notes and
/// media-player roles are deliberately absent: Eldrun has its own of each (the
/// Monitor tab, the editable file viewers, the in-tab media viewer), so seeding
/// an external app for them only offered a second, worse copy.
#[cfg(target_os = "windows")]
fn detect_windows_global_apps(
) -> Option<std::collections::HashMap<String, crate::schema::settings::GlobalAppEntry>> {
    use crate::schema::settings::GlobalAppEntry;
    use std::collections::HashMap;

    // role -> ordered candidate executable paths (first existing wins).
    let candidates: [(&str, Vec<String>); 3] = [
        (
            "browser",
            vec![
                env_join("ProgramFiles", "Google\\Chrome\\Application\\chrome.exe"),
                env_join(
                    "ProgramFiles(x86)",
                    "Google\\Chrome\\Application\\chrome.exe",
                ),
                env_join("ProgramFiles", "Mozilla Firefox\\firefox.exe"),
                env_join("ProgramFiles(x86)", "Mozilla Firefox\\firefox.exe"),
                env_join(
                    "ProgramFiles(x86)",
                    "Microsoft\\Edge\\Application\\msedge.exe",
                ),
                env_join("ProgramFiles", "Microsoft\\Edge\\Application\\msedge.exe"),
            ],
        ),
        (
            "screenshot",
            vec![env_join("WINDIR", "System32\\SnippingTool.exe")],
        ),
        (
            "password_manager",
            vec![
                env_join("ProgramFiles", "KeePassXC\\KeePassXC.exe"),
                env_join("ProgramFiles(x86)", "KeePass Password Safe 2\\KeePass.exe"),
            ],
        ),
    ];

    let detected: HashMap<String, GlobalAppEntry> = candidates
        .into_iter()
        .filter_map(|(role, paths)| {
            first_existing(&paths).map(|exec| {
                (
                    role.to_string(),
                    GlobalAppEntry {
                        exec,
                        visible: true,
                        extra: HashMap::new(),
                    },
                )
            })
        })
        .collect();

    if detected.is_empty() {
        None
    } else {
        Some(detected)
    }
}

/// Seed the global-app toolbar with stock macOS apps for the common roles. Each
/// `exec` points at the launchable binary inside the bundle's `Contents/MacOS/`
/// (not the `.app` path) so the existing `Command::new(exec)` launch path works.
/// Roles whose app is absent (e.g. iTerm) are skipped; the toolbar is never empty
/// on a stock install since Safari is always present. Mail, calendar,
/// file-manager, system-monitor, notes and media-player roles are deliberately
/// absent — Eldrun has its own of each (the Monitor tab, the editable file
/// viewers, the in-tab media viewer), so seeding Mail/Finder/Activity Monitor/
/// Notes/QuickTime here only offered a second, worse copy.
#[cfg(target_os = "macos")]
fn detect_macos_global_apps(
) -> Option<std::collections::HashMap<String, crate::schema::settings::GlobalAppEntry>> {
    use crate::schema::settings::GlobalAppEntry;
    use std::collections::HashMap;

    // role -> ordered candidate executable paths (first existing wins).
    let candidates: [(&str, Vec<String>); 2] = [
        (
            "browser",
            vec![
                "/Applications/Safari.app/Contents/MacOS/Safari".to_string(),
                "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome".to_string(),
                "/Applications/Firefox.app/Contents/MacOS/firefox".to_string(),
            ],
        ),
        (
            "screenshot",
            vec![
                "/System/Applications/Utilities/Screenshot.app/Contents/MacOS/Screenshot"
                    .to_string(),
            ],
        ),
    ];

    let detected: HashMap<String, GlobalAppEntry> = candidates
        .into_iter()
        .filter_map(|(role, paths)| {
            first_existing(&paths).map(|exec| {
                (
                    role.to_string(),
                    GlobalAppEntry {
                        exec,
                        visible: true,
                        extra: HashMap::new(),
                    },
                )
            })
        })
        .collect();

    if detected.is_empty() {
        None
    } else {
        Some(detected)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_patch_is_shallow_and_preserves_unrelated_fields() {
        let mut settings = Settings {
            color_scheme: Some("fancy_dark".into()),
            language: Some("de".into()),
            ..Settings::default()
        };
        let patch = serde_json::from_value::<Map<String, Value>>(serde_json::json!({
            "color_scheme": "soft_dark",
            "files_alerts_muted": ["one"]
        }))
        .unwrap();

        merge_settings_patch(&mut settings, patch).unwrap();

        assert_eq!(settings.color_scheme.as_deref(), Some("soft_dark"));
        assert_eq!(settings.language.as_deref(), Some("de"));
        assert_eq!(settings.files_alerts_muted, Some(vec!["one".into()]));
    }
}
