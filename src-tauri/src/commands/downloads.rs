//! Download routing — ~/eldrun/downloads symlink management.
//!
//! The current Python app edits Firefox/Chromium preferences to point their
//! download directories at ~/eldrun/downloads, which is a symlink that follows
//! the active project. This module preserves that behavior with safeguards:
//! - Backup of browser preference files before modification.
//! - File-lock awareness (skip if prefs.js is locked by running Firefox).
//! - Profile detection (searches standard profile directories).
//! - The ~/eldrun/downloads symlink always follows the active project.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

// ── Symlink management ────────────────────────────────────────────────────

/// Ensure ~/eldrun/downloads symlink points at the given project directory.
#[tauri::command]
pub fn update_downloads_symlink(project_dir: String) -> Result<(), String> {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/".to_string());
    let link = PathBuf::from(&home).join("eldrun").join("downloads");

    if let Ok(existing) = fs::read_link(&link) {
        if existing.to_string_lossy() == project_dir {
            return Ok(()); // Already correct.
        }
        fs::remove_file(&link).map_err(|e| format!("remove symlink: {e}"))?;
    }

    if let Some(parent) = link.parent() {
        fs::create_dir_all(parent).ok();
    }

    std::os::unix::fs::symlink(&project_dir, &link)
        .map_err(|e| format!("create symlink: {e}"))
}

// ── Browser preference editing ─────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadsStatus {
    pub symlink_ok: bool,
    pub firefox_updated: bool,
    pub chromium_updated: bool,
    pub notes: Vec<String>,
}

/// Update browser download preferences to ~/eldrun/downloads.
/// Creates backups and skips locked files.
#[tauri::command]
pub fn configure_browser_downloads() -> Result<DownloadsStatus, String> {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/".to_string());
    let target = format!("{home}/eldrun/downloads");
    let mut status = DownloadsStatus {
        symlink_ok: false,
        firefox_updated: false,
        chromium_updated: false,
        notes: Vec::new(),
    };

    // Check symlink.
    let link = PathBuf::from(&home).join("eldrun").join("downloads");
    status.symlink_ok = link.exists() && fs::read_link(&link).is_ok();

    // Firefox.
    let ff_base = PathBuf::from(&home).join(".mozilla").join("firefox");
    if ff_base.exists() {
        match update_firefox_prefs(&ff_base, &target) {
            Ok(updated) => {
                status.firefox_updated = updated;
                if !updated {
                    status.notes.push("Firefox prefs.js was locked; skipped".to_string());
                }
            }
            Err(e) => status.notes.push(format!("Firefox error: {e}")),
        }
    }

    // Chromium / Chrome.
    let chromium_paths = [
        ".config/chromium",
        ".config/google-chrome",
        ".config/google-chrome-beta",
    ];
    for rel in &chromium_paths {
        let base = PathBuf::from(&home).join(rel);
        if base.exists() {
            match update_chromium_prefs(&base, &target) {
                Ok(updated) => {
                    if updated {
                        status.chromium_updated = true;
                    } else {
                        status
                            .notes
                            .push(format!("{rel}: Preferences was locked; skipped"));
                    }
                }
                Err(e) => status.notes.push(format!("{rel} error: {e}")),
            }
        }
    }

    Ok(status)
}

// ── Firefox prefs.js editor ───────────────────────────────────────────────

fn update_firefox_prefs(ff_base: &Path, download_path: &str) -> Result<bool, String> {
    let profiles = find_firefox_profiles(ff_base);
    let mut any_updated = false;

    for profile_dir in profiles {
        let prefs = profile_dir.join("prefs.js");
        if !prefs.exists() {
            continue;
        }
        if is_locked(&profile_dir.join(".parentlock")) {
            continue;
        }
        let backup = backup_file(&prefs)?;
        let content = fs::read_to_string(&prefs).map_err(|e| e.to_string())?;

        let new_content = set_pref(
            &content,
            "browser.download.dir",
            &format!("\"{download_path}\""),
        );
        let new_content = set_pref(&new_content, "browser.download.folderList", "2");
        let new_content = set_pref(&new_content, "browser.download.useDownloadDir", "true");

        fs::write(&prefs, &new_content).map_err(|e| e.to_string())?;
        any_updated = true;
    }
    Ok(any_updated)
}

fn find_firefox_profiles(ff_base: &Path) -> Vec<PathBuf> {
    let mut profiles = Vec::new();
    if let Ok(entries) = fs::read_dir(ff_base) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.contains('.') || name == "Crash Reports" || name == "Pending Pings" {
                    continue;
                }
                profiles.push(path);
            }
        }
    }
    // Also check profiles.ini.
    let ini = ff_base.join("profiles.ini");
    if let Ok(content) = fs::read_to_string(&ini) {
        for line in content.lines() {
            if let Some(path_str) = line.strip_prefix("Path=") {
                let p = if path_str.starts_with('/') {
                    PathBuf::from(path_str)
                } else {
                    ff_base.join(path_str)
                };
                if p.exists() && !profiles.contains(&p) {
                    profiles.push(p);
                }
            }
        }
    }
    profiles
}

fn set_pref(content: &str, key: &str, value: &str) -> String {
    let pattern = format!("user_pref(\"{key}\"");
    let new_line = format!("user_pref(\"{key}\", {value});");
    if let Some(pos) = content.find(&pattern) {
        let end = content[pos..].find('\n').map(|i| pos + i + 1).unwrap_or(content.len());
        format!("{}{new_line}\n{}", &content[..pos], &content[end..])
    } else {
        format!("{content}{new_line}\n")
    }
}

// ── Chromium/Chrome Preferences editor ────────────────────────────────────

fn update_chromium_prefs(base: &Path, download_path: &str) -> Result<bool, String> {
    let default_dir = base.join("Default");
    let prefs_file = default_dir.join("Preferences");

    if !prefs_file.exists() {
        return Ok(false);
    }
    if is_locked(&base.join("SingletonLock")) {
        return Ok(false);
    }

    let content = fs::read_to_string(&prefs_file).map_err(|e| e.to_string())?;
    let mut prefs: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| format!("JSON parse: {e}"))?;

    backup_file(&prefs_file)?;

    if let Some(obj) = prefs.as_object_mut() {
        let download = obj
            .entry("download")
            .or_insert_with(|| serde_json::Value::Object(Default::default()))
            .as_object_mut()
            .ok_or("download is not an object")?;
        download.insert(
            "default_directory".to_string(),
            serde_json::Value::String(download_path.to_string()),
        );
        download.insert(
            "prompt_for_download".to_string(),
            serde_json::Value::Bool(false),
        );
    }

    let new_content = serde_json::to_string_pretty(&prefs).map_err(|e| e.to_string())?;
    fs::write(&prefs_file, new_content).map_err(|e| e.to_string())?;
    Ok(true)
}

// ── Shared helpers ────────────────────────────────────────────────────────

fn is_locked(lock_file: &Path) -> bool {
    lock_file.exists()
}

fn backup_file(path: &Path) -> Result<PathBuf, String> {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("file");
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    let backup_name = if ext.is_empty() {
        format!("{stem}.{ts}.bak")
    } else {
        format!("{stem}.{ts}.bak.{ext}")
    };
    let backup = path.with_file_name(backup_name);
    fs::copy(path, &backup).map_err(|e| format!("backup: {e}"))?;
    Ok(backup)
}
