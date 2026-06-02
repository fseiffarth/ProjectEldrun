use std::fs;
use std::path::{Path, PathBuf};

/// Point `~/eldrun/downloads` at `target_dir`.
pub fn route_downloads(target_dir: &str) -> Result<(), String> {
    let home = home_dir();
    let link = PathBuf::from(&home).join("eldrun").join("downloads");

    if let Ok(existing) = fs::read_link(&link) {
        if existing.to_string_lossy() == target_dir {
            return Ok(());
        }
        if link.is_dir() {
            fs::remove_dir(&link).map_err(|e| format!("remove symlink: {e}"))?;
        } else {
            fs::remove_file(&link).map_err(|e| format!("remove symlink: {e}"))?;
        }
    }

    if let Some(parent) = link.parent() {
        fs::create_dir_all(parent).ok();
    }
    create_dir_symlink(target_dir, &link)
}

fn create_dir_symlink(src: &str, link: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(src, link).map_err(|e| format!("create symlink: {e}"))
    }
    #[cfg(target_os = "windows")]
    {
        std::os::windows::fs::symlink_dir(src, link)
            .map_err(|e| format!("create symlink (requires Developer Mode): {e}"))
    }
    #[cfg(not(any(unix, target_os = "windows")))]
    {
        Err("directory symlinks not supported on this platform".to_string())
    }
}

pub fn home_dir() -> String {
    if cfg!(target_os = "windows") {
        std::env::var("USERPROFILE")
            .or_else(|_| {
                std::env::var("HOMEDRIVE")
                    .and_then(|d| std::env::var("HOMEPATH").map(|p| format!("{d}{p}")))
            })
            .unwrap_or_else(|_| "C:\\Users\\Default".to_string())
    } else {
        std::env::var("HOME").unwrap_or_else(|_| "/".to_string())
    }
}
