use crate::schema::settings::WindowState;
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

/// Persist only the main window's geometry, leaving every other setting on disk
/// untouched.
///
/// Deliberately NOT routed through `save_settings`: the frontend's
/// `updateSettings` writes the *whole* settings object back from its in-memory
/// cache, and this is called on a debounce every time the user drags or resizes
/// the window. Going through the full object would rewrite the entire
/// user-facing settings file on every window nudge, and would clobber any setting
/// changed elsewhere since the cache was filled. Read-modify-write of the single
/// field here keeps a window drag from ever touching an unrelated setting.
#[tauri::command]
pub fn save_window_state(state: WindowState) -> Result<(), String> {
    let path = storage::state_dir().join("settings.json");
    let mut settings: Settings = if path.exists() {
        storage::read_json(&path).map_err(|e| e.to_string())?
    } else {
        Settings::default()
    };
    settings.window_state = Some(state);
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
    #[cfg(target_os = "macos")]
    {
        detect_macos_global_apps()
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        None
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

/// Seed the global-app toolbar with stock macOS apps for the common roles. Each
/// `exec` points at the launchable binary inside the bundle's `Contents/MacOS/`
/// (not the `.app` path) so the existing `Command::new(exec)` launch path works.
/// Roles whose app is absent (e.g. iTerm) are skipped; the toolbar is never empty
/// on a stock install since Safari/Finder/Mail are always present.
#[cfg(target_os = "macos")]
fn detect_macos_global_apps()
-> Option<std::collections::HashMap<String, crate::schema::settings::GlobalAppEntry>> {
    use crate::schema::settings::GlobalAppEntry;
    use std::collections::HashMap;

    // role -> ordered candidate executable paths (first existing wins).
    let candidates: [(&str, Vec<String>); 7] = [
        (
            "browser",
            vec![
                "/Applications/Safari.app/Contents/MacOS/Safari".to_string(),
                "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome".to_string(),
                "/Applications/Firefox.app/Contents/MacOS/firefox".to_string(),
            ],
        ),
        (
            "mail",
            vec!["/System/Applications/Mail.app/Contents/MacOS/Mail".to_string()],
        ),
        (
            "file_manager",
            vec!["/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder".to_string()],
        ),
        (
            "system_monitor",
            vec![
                "/System/Applications/Utilities/Activity Monitor.app/Contents/MacOS/Activity Monitor"
                    .to_string(),
            ],
        ),
        (
            "notes",
            vec!["/System/Applications/Notes.app/Contents/MacOS/Notes".to_string()],
        ),
        (
            "media_player",
            vec![
                "/System/Applications/QuickTime Player.app/Contents/MacOS/QuickTime Player"
                    .to_string(),
                "/System/Applications/Music.app/Contents/MacOS/Music".to_string(),
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
