use std::fs;
use std::path::Path;

use crate::paths;

/// Point `~/eldrun/downloads` at `target_dir`.
pub fn route_downloads(target_dir: &str) -> Result<(), String> {
    let link = paths::home_dir().join("eldrun").join("downloads");

    if let Ok(existing) = fs::read_link(&link) {
        if existing.to_string_lossy() == target_dir {
            return Ok(());
        }
        // read_link succeeded → link IS a symlink; always remove with remove_file.
        // (link.is_dir() follows the symlink and returns true for a dir target,
        // but remove_dir on a symlink-to-dir fails with ENOTDIR on Linux.)
        fs::remove_file(&link).map_err(|e| format!("remove symlink: {e}"))?;
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
    paths::home_dir_string()
}

// ── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, OnceLock};

    static ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

    fn env_lock() -> &'static Mutex<()> {
        ENV_LOCK.get_or_init(|| Mutex::new(()))
    }

    #[test]
    fn home_dir_uses_home_env() {
        let _guard = env_lock().lock().unwrap();
        unsafe { std::env::set_var("HOME", "/custom/home") };
        let result = home_dir();
        unsafe { std::env::remove_var("HOME") };
        assert_eq!(result, "/custom/home");
    }

    #[test]
    fn home_dir_falls_back_to_root_when_no_home() {
        let _guard = env_lock().lock().unwrap();
        let old = std::env::var("HOME").ok();
        unsafe { std::env::remove_var("HOME") };
        let result = home_dir();
        unsafe {
            match old {
                Some(h) => std::env::set_var("HOME", h),
                None => std::env::remove_var("HOME"),
            }
        }
        // Linux and other Unix paths share the storage fallback.
        assert_eq!(result, "/root");
    }

    #[test]
    fn route_downloads_creates_symlink() {
        let _guard = env_lock().lock().unwrap();
        let tmp = tempfile::tempdir().unwrap();
        let target_dir = tmp.path().join("target");
        std::fs::create_dir_all(&target_dir).unwrap();

        unsafe { std::env::set_var("HOME", tmp.path()) };
        let result = route_downloads(&target_dir.to_string_lossy());
        unsafe { std::env::remove_var("HOME") };

        assert!(result.is_ok(), "route_downloads failed: {result:?}");
        let link = tmp.path().join("eldrun/downloads");
        assert!(
            link.exists() || link.is_symlink(),
            "symlink must exist at {}",
            link.display()
        );
    }

    #[test]
    fn route_downloads_updates_existing_symlink() {
        let _guard = env_lock().lock().unwrap();
        let tmp = tempfile::tempdir().unwrap();
        let target1 = tmp.path().join("project_a");
        let target2 = tmp.path().join("project_b");
        std::fs::create_dir_all(&target1).unwrap();
        std::fs::create_dir_all(&target2).unwrap();

        unsafe { std::env::set_var("HOME", tmp.path()) };
        route_downloads(&target1.to_string_lossy()).unwrap();
        let result2 = route_downloads(&target2.to_string_lossy());
        unsafe { std::env::remove_var("HOME") };

        assert!(result2.is_ok(), "second route failed: {result2:?}");
        // The symlink should now point to target2.
        let link = tmp.path().join("eldrun/downloads");
        let resolved = std::fs::read_link(&link).unwrap();
        assert_eq!(resolved.to_string_lossy(), target2.to_string_lossy());
    }

    #[test]
    fn route_downloads_is_no_op_when_target_unchanged() {
        let _guard = env_lock().lock().unwrap();
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("my_project");
        std::fs::create_dir_all(&target).unwrap();

        unsafe { std::env::set_var("HOME", tmp.path()) };
        route_downloads(&target.to_string_lossy()).unwrap();
        let result = route_downloads(&target.to_string_lossy());
        unsafe { std::env::remove_var("HOME") };

        assert!(result.is_ok(), "idempotent call failed: {result:?}");
    }
}
