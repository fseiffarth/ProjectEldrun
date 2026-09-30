//! Eldrun-owned commands reachable from local, fenced and container tabs:
//! `eldrun-send`, and one **agent shim** per registry CLI (`agent_shim`).
//!
//! The shims sit at the front of every tab's PATH. In a shell tab (never
//! fenced) a typed `claude` reaches the shim, which asks Eldrun's own binary
//! to build the tab's fence and execs into it — same scope home, same shared
//! logins as an agent tab. Inside a fence the shim steps aside and execs the
//! real CLI from the rest of PATH. Written at every startup, so they always
//! name the running Eldrun.
use std::{fs, io, path::{Path, PathBuf}};

pub fn bin_dir() -> PathBuf { crate::storage::state_dir().join("bin") }

pub fn install() -> io::Result<()> {
    let exe = std::env::current_exe().ok();
    install_in(&bin_dir(), exe.as_deref(), &crate::commands::agents::agent_bins())
}

fn install_in(dir: &Path, exe: Option<&Path>, clis: &[&str]) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    // The POSIX script is needed even on Windows for Docker containers.
    write_script(dir, "eldrun-send", include_bytes!("../../../scripts/eldrun-send.sh"))?;
    #[cfg(windows)]
    {
        write_script(dir, "eldrun-send.cmd", include_bytes!("../../../scripts/eldrun-send.cmd"))?;
        write_script(dir, "eldrun-send.ps1", include_bytes!("../../../scripts/eldrun-send.ps1"))?;
    }
    if let Some(exe) = exe {
        for cli in clis {
            write_script(dir, cli, shim_script(cli, exe, dir).as_bytes())?;
        }
    }
    Ok(())
}

/// The shim for `cli`: exec the fence through `exe`, or — already inside a
/// fence, or in the root console's Host session, which is unfenced by the
/// user's explicit choice — the real CLI found on PATH minus this directory.
/// POSIX `sh`; no bypass flag.
///
/// Only the *lookup* skips this directory; the CLI runs with PATH as it came,
/// so `eldrun-send` (which lives here too) stays reachable from the agent and
/// every shell it opens. Trimming the exported PATH lost it in every fenced
/// tab (2026-09-29).
pub(crate) fn shim_script(cli: &str, exe: &Path, dir: &Path) -> String {
    let quote = |s: &str| format!("'{}'", s.replace('\'', "'\\''"));
    format!(
        "#!/bin/sh\n\
         # Eldrun agent shim: runs {cli} fenced in this tab's scope (services::agent_shim).\n\
         if [ -n \"${{ELDRUN_AGENT_FENCE:-}}\" ] || [ -n \"${{ELDRUN_HOST_SESSION:-}}\" ]; then\n\
         \x20   real=$(PATH=$(printf '%s' \"$PATH\" | tr ':' '\\n' | grep -vx -- {dir} | paste -sd: -); command -v {cli_q}) || {{\n\
         \x20       echo {not_found} >&2\n\
         \x20       exit 127\n\
         \x20   }}\n\
         \x20   exec \"$real\" \"$@\"\n\
         fi\n\
         exec {exe} --agent-shim {cli_q} \"$@\"\n",
        cli = cli,
        cli_q = quote(cli),
        not_found = quote(&format!("{cli}: command not found")),
        dir = quote(&dir.to_string_lossy()),
        exe = quote(&exe.to_string_lossy()),
    )
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
        install_in(dir.path(), None, &[]).unwrap();
        let script = dir.path().join("eldrun-send");
        let modified = fs::metadata(&script).unwrap().modified().unwrap();
        install_in(dir.path(), None, &[]).unwrap();
        assert_eq!(fs::metadata(&script).unwrap().modified().unwrap(), modified);
        fs::write(&script, "drift").unwrap();
        install_in(dir.path(), None, &[]).unwrap();
        assert_eq!(fs::read(&script).unwrap(), include_bytes!("../../../scripts/eldrun-send.sh"));
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(script).unwrap().permissions().mode() & 0o777, 0o755);
        }
    }

    #[test]
    fn a_shim_execs_eldrun_outside_a_fence_and_the_real_cli_inside_one() {
        let dir = tempfile::tempdir().unwrap();
        install_in(dir.path(), Some(Path::new("/opt/eldrun's bin/eldrun")), &["claude", "cursor-agent"]).unwrap();
        let shim = fs::read_to_string(dir.path().join("cursor-agent")).unwrap();
        assert!(shim.starts_with("#!/bin/sh\n"));
        assert!(shim.contains("exec '/opt/eldrun'\\''s bin/eldrun' --agent-shim 'cursor-agent' \"$@\""));
        assert!(shim.contains("ELDRUN_AGENT_FENCE"));
        assert!(shim.contains("ELDRUN_HOST_SESSION"));
        assert!(shim.contains(&format!("grep -vx -- '{}'", dir.path().to_string_lossy())));
        assert!(!shim.contains("--unfenced"));
        assert!(dir.path().join("claude").is_file());
    }

    /// Inside a fence the shim runs the real CLI, which still sees this
    /// directory on PATH — `eldrun-send` must stay reachable from the agent.
    #[cfg(unix)]
    #[test]
    fn a_fenced_shim_runs_the_real_cli_with_eldrun_send_still_on_path() {
        use std::os::unix::fs::PermissionsExt;
        let shims = tempfile::tempdir().unwrap();
        let real = tempfile::tempdir().unwrap();
        install_in(shims.path(), Some(Path::new("/nonexistent/eldrun")), &["fakecli"]).unwrap();
        let cli = real.path().join("fakecli");
        fs::write(&cli, "#!/bin/sh\necho \"args=$*\"\ncommand -v eldrun-send\n").unwrap();
        fs::set_permissions(&cli, fs::Permissions::from_mode(0o755)).unwrap();
        let path = std::env::join_paths([shims.path(), real.path(), Path::new("/usr/bin"), Path::new("/bin")]).unwrap();
        let out = std::process::Command::new(shims.path().join("fakecli"))
            .arg("hi")
            .env("PATH", &path)
            .env("ELDRUN_AGENT_FENCE", "1")
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(out.status.success(), "{stdout} {}", String::from_utf8_lossy(&out.stderr));
        assert!(stdout.contains("args=hi"), "the real CLI ran, not the shim again: {stdout}");
        assert!(
            stdout.contains(&shims.path().join("eldrun-send").to_string_lossy().into_owned()),
            "eldrun-send is on the CLI's PATH: {stdout}"
        );

        // No real CLI anywhere but the shim: a clear error, never a loop.
        let path = std::env::join_paths([shims.path(), Path::new("/usr/bin"), Path::new("/bin")]).unwrap();
        let out = std::process::Command::new(shims.path().join("fakecli"))
            .env("PATH", &path)
            .env("ELDRUN_AGENT_FENCE", "1")
            .output()
            .unwrap();
        assert_eq!(out.status.code(), Some(127));
        assert!(String::from_utf8_lossy(&out.stderr).contains("fakecli: command not found"));
    }
}
