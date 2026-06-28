use crate::schema::Settings;
use crate::storage;

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
    if settings
        .global_apps
        .as_ref()
        .map_or(true, |apps| apps.is_empty())
    {
        if let Some(defaults) = default_global_apps() {
            settings.global_apps = Some(defaults);
        }
    }
    Ok(settings)
}

#[tauri::command]
pub fn save_settings(settings: Settings) -> Result<(), String> {
    let path = storage::state_dir().join("settings.json");
    storage::write_json(&path, &settings).map_err(|e| e.to_string())
}

/// Detect installed apps for the global-app toolbar roles on the current
/// platform. Only roles whose executable actually resolves are returned, so the
/// seeded buttons always launch something. Returns `None` when nothing is
/// detected (e.g. unsupported platform), leaving the toolbar empty as before.
fn default_global_apps()
-> Option<std::collections::HashMap<String, crate::schema::settings::GlobalAppEntry>> {
    #[cfg(target_os = "windows")]
    {
        detect_windows_global_apps()
    }
    #[cfg(not(target_os = "windows"))]
    {
        None
    }
}

/// First existing path among `candidates`, or `None`. Used to pick the
/// best-available executable for a role across install locations.
#[cfg(target_os = "windows")]
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
/// Windows. Always-present system tools (Explorer, Notepad, Task Manager) are
/// effectively guaranteed, so the toolbar is never empty; browser/mail/etc. are
/// included only when found.
#[cfg(target_os = "windows")]
fn detect_windows_global_apps()
-> Option<std::collections::HashMap<String, crate::schema::settings::GlobalAppEntry>> {
    use crate::schema::settings::GlobalAppEntry;
    use std::collections::HashMap;

    // role -> ordered candidate executable paths (first existing wins).
    let candidates: [(&str, Vec<String>); 8] = [
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
                env_join("ProgramFiles(x86)", "Microsoft\\Edge\\Application\\msedge.exe"),
                env_join("ProgramFiles", "Microsoft\\Edge\\Application\\msedge.exe"),
            ],
        ),
        ("file_manager", vec![env_join("WINDIR", "explorer.exe")]),
        ("notes", vec![env_join("WINDIR", "System32\\notepad.exe")]),
        (
            "system_monitor",
            vec![env_join("WINDIR", "System32\\Taskmgr.exe")],
        ),
        (
            "screenshot",
            vec![env_join("WINDIR", "System32\\SnippingTool.exe")],
        ),
        (
            "media_player",
            vec![
                env_join("ProgramFiles(x86)", "Windows Media Player\\wmplayer.exe"),
                env_join("ProgramFiles", "Windows Media Player\\wmplayer.exe"),
            ],
        ),
        (
            "mail",
            vec![
                env_join("ProgramFiles", "Microsoft Office\\root\\Office16\\OUTLOOK.EXE"),
                env_join(
                    "ProgramFiles(x86)",
                    "Microsoft Office\\root\\Office16\\OUTLOOK.EXE",
                ),
            ],
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
