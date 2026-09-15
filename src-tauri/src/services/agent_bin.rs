//! Eldrun-owned commands reachable from local, fenced and container tabs.
use std::{fs, io, path::{Path, PathBuf}};

pub fn bin_dir() -> PathBuf { crate::storage::state_dir().join("bin") }

pub fn install() -> io::Result<()> { install_in(&bin_dir()) }

fn install_in(dir: &Path) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    // The POSIX script is needed even on Windows for Docker containers.
    write_script(dir, "eldrun-send", include_bytes!("../../../scripts/eldrun-send.sh"))?;
    #[cfg(windows)]
    {
        write_script(dir, "eldrun-send.cmd", include_bytes!("../../../scripts/eldrun-send.cmd"))?;
        write_script(dir, "eldrun-send.ps1", include_bytes!("../../../scripts/eldrun-send.ps1"))?;
    }
    Ok(())
}

fn write_script(dir: &Path, name: &str, bytes: &[u8]) -> io::Result<()> {
    let path = dir.join(name);
    if fs::read(&path).ok().as_deref() != Some(bytes) { fs::write(&path, bytes)?; }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o755))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn install_preserves_matching_bytes_and_repairs_drift() {
        let dir = tempfile::tempdir().unwrap();
        install_in(dir.path()).unwrap();
        let script = dir.path().join("eldrun-send");
        let modified = fs::metadata(&script).unwrap().modified().unwrap();
        install_in(dir.path()).unwrap();
        assert_eq!(fs::metadata(&script).unwrap().modified().unwrap(), modified);
        fs::write(&script, "drift").unwrap();
        install_in(dir.path()).unwrap();
        assert_eq!(fs::read(&script).unwrap(), include_bytes!("../../../scripts/eldrun-send.sh"));
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(script).unwrap().permissions().mode() & 0o777, 0o755);
        }
    }
}
