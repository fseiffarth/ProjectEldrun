use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OsKind {
    Windows,
    Macos,
    Unix,
}

impl OsKind {
    pub fn current() -> Self {
        if cfg!(target_os = "windows") {
            Self::Windows
        } else if cfg!(target_os = "macos") {
            Self::Macos
        } else {
            Self::Unix
        }
    }
}

/// The PATH-lookup executable for `os`: `where` on Windows, `which` elsewhere.
/// `which` does not exist on Windows, so any detection that hardcodes it reports
/// every Windows install as missing.
pub fn path_finder(os: OsKind) -> &'static str {
    match os {
        OsKind::Windows => "where",
        OsKind::Macos | OsKind::Unix => "which",
    }
}

/// Build a [`std::process::Command`] for `bin` that never flashes a console
/// window on Windows. Console tools (TeX engines, `bibtex`, `synctex`, `where`)
/// are GUI-less subprocesses we only read output from; without `CREATE_NO_WINDOW`
/// each invocation pops a transient console window, and a single TeX compile
/// spawns several. No-op on non-Windows targets.
pub fn command_no_window(bin: impl AsRef<OsStr>) -> Command {
    let mut cmd = Command::new(bin);
    augment_command_path(&mut cmd);
    hide_command_window(&mut cmd);
    cmd
}

fn hide_command_window(_cmd: &mut Command) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW (winbase.h): don't allocate a console for the child.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        _cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

/// True when `bin` resolves on Eldrun's effective PATH on the current OS.
/// Windows lookup expands PATHEXT and all platforms include supplemental
/// per-user/package-manager directories.
pub fn binary_on_path(bin: &str) -> bool {
    resolve_executable(bin).is_some()
}

/// Standard directories macOS package managers (Homebrew, MacTeX) install CLI
/// tools into but which a Finder/Dock-launched GUI app's inherited PATH omits —
/// so a tool can be installed yet unreachable by bare name. The macOS analogue of
/// the per-user dirs in [`launch_search_dirs`].
const MACOS_EXTRA_DIRS: &[&str] = &[
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
    "/opt/local/bin",
    "/opt/local/sbin",
    "/Library/TeX/texbin",
];

fn supplemental_path_dirs_for(
    os: OsKind,
    home: &Path,
    local_app_data: Option<&OsStr>,
    app_data: Option<&OsStr>,
    program_files: Option<&OsStr>,
) -> Vec<PathBuf> {
    let mut dirs = vec![
        home.join(".local").join("bin"),
        home.join(".cargo").join("bin"),
        home.join(".opencode").join("bin"),
    ];
    match os {
        OsKind::Macos => dirs.extend(MACOS_EXTRA_DIRS.iter().map(PathBuf::from)),
        OsKind::Windows => {
            if let Some(local) = local_app_data {
                let local = PathBuf::from(local);
                dirs.push(local.join("Microsoft").join("WindowsApps"));
                dirs.push(local.join("Programs").join("Ollama"));
                // Per-user winget install of MiKTeX (`winget install --id
                // MiKTeX.MiKTeX -e`, the command the "Install MiKTeX" button runs) —
                // without this, a fresh install stays invisible to Eldrun's own
                // process until it's relaunched, since a Windows PATH change made by
                // an installer never reaches an already-running process's env.
                dirs.push(
                    local
                        .join("Programs")
                        .join("MiKTeX")
                        .join("miktex")
                        .join("bin")
                        .join("x64"),
                );
                // Codex's standalone Windows installer (releases.openai.com/codex/
                // install.ps1) writes here and updates the User PATH registry for
                // *future* sessions only — the same "invisible until relaunch" gap.
                dirs.push(
                    local
                        .join("Programs")
                        .join("OpenAI")
                        .join("Codex")
                        .join("bin"),
                );
                dirs.push(local.join("bin"));
            }
            if let Some(roaming) = app_data {
                dirs.push(PathBuf::from(roaming).join("npm"));
            }
            // Machine-wide MiKTeX install (`winget install --scope machine`, or the
            // classic non-winget installer, which defaults here).
            if let Some(pf) = program_files {
                dirs.push(
                    PathBuf::from(pf)
                        .join("MiKTeX")
                        .join("miktex")
                        .join("bin")
                        .join("x64"),
                );
            }
        }
        OsKind::Unix => {}
    }
    dirs
}

/// Directories prepended to every child process PATH. GUI-launched applications
/// commonly miss per-user package directories on every supported OS.
pub fn extra_path_dirs() -> Vec<PathBuf> {
    supplemental_path_dirs_for(
        OsKind::current(),
        &home_dir(),
        std::env::var_os("LOCALAPPDATA").as_deref(),
        std::env::var_os("APPDATA").as_deref(),
        std::env::var_os("ProgramFiles").as_deref(),
    )
}

/// Prepend [`extra_path_dirs`] to `cmd`'s PATH env.
pub fn augment_command_path(cmd: &mut std::process::Command) {
    if let Some(path) = effective_path() {
        cmd.env("PATH", path);
    }
}

pub fn effective_path() -> Option<std::ffi::OsString> {
    let current = std::env::var_os("PATH").unwrap_or_default();
    let mut paths = extra_path_dirs();
    paths.extend(std::env::split_paths(&current));
    std::env::join_paths(&paths).ok()
}

fn launch_search_dirs() -> Vec<PathBuf> {
    extra_path_dirs()
}

/// Pure resolver: the first existing `bin` across `dirs`, trying each of `exts`
/// (an empty `exts` / `""` entry means no extension expansion). `exists` is
/// injected so this is unit-testable without touching the filesystem.
fn resolve_in_dirs(
    dirs: &[PathBuf],
    bin: &str,
    exts: &[&str],
    exists: &impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    for dir in dirs {
        let base = dir.join(bin);
        if exists(&base) {
            return Some(base);
        }
        for ext in exts {
            if ext.is_empty() {
                continue;
            }
            let cand = dir.join(format!("{bin}.{ext}"));
            if exists(&cand) {
                return Some(cand);
            }
        }
    }
    None
}

fn windows_extensions(pathext: Option<&OsStr>) -> Vec<String> {
    let value = pathext
        .and_then(OsStr::to_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(".COM;.EXE;.BAT;.CMD;.PS1");
    let mut extensions = value
        .split(';')
        .map(|ext| ext.trim().trim_start_matches('.').to_ascii_lowercase())
        .filter(|ext| !ext.is_empty())
        .collect::<Vec<_>>();
    // PowerShell scripts are launchable through our explicit dispatcher even
    // though Windows' default PATHEXT usually omits .PS1.
    if !extensions.iter().any(|ext| ext == "ps1") {
        extensions.push("ps1".to_string());
    }
    extensions
}

fn resolve_executable_in_dirs(
    os: OsKind,
    dirs: &[PathBuf],
    bin: &str,
    pathext: Option<&OsStr>,
    exists: &impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    if bin.is_empty() {
        return None;
    }
    if bin.contains('/') || bin.contains('\\') {
        let path = PathBuf::from(bin);
        return exists(&path).then_some(path);
    }
    let exts = if os == OsKind::Windows {
        windows_extensions(pathext)
    } else {
        Vec::new()
    };
    let refs = exts.iter().map(String::as_str).collect::<Vec<_>>();
    resolve_in_dirs(dirs, bin, &refs, exists)
}

/// Resolve a command using the same effective PATH Eldrun applies at execution.
/// Windows resolution follows PATHEXT, including script shims.
pub fn resolve_executable(bin: &str) -> Option<PathBuf> {
    let current = std::env::var_os("PATH").unwrap_or_default();
    let mut dirs = extra_path_dirs();
    dirs.extend(std::env::split_paths(&current));
    resolve_executable_in_dirs(
        OsKind::current(),
        &dirs,
        bin,
        std::env::var_os("PATHEXT").as_deref(),
        &|path| path.is_file(),
    )
}

pub fn resolve_executable_in_dir(dir: &Path, bin: &str) -> Option<PathBuf> {
    resolve_executable_in_dirs(
        OsKind::current(),
        std::slice::from_ref(&dir.to_path_buf()),
        bin,
        std::env::var_os("PATHEXT").as_deref(),
        &|path| path.is_file(),
    )
}

fn command_for_program_for(os: OsKind, program: &Path) -> Command {
    let ext = program
        .extension()
        .and_then(OsStr::to_str)
        .unwrap_or("")
        .to_ascii_lowercase();
    let mut cmd = if os == OsKind::Windows && matches!(ext.as_str(), "cmd" | "bat") {
        let mut cmd = Command::new("cmd.exe");
        cmd.args(["/D", "/C"]).arg(program);
        cmd
    } else if os == OsKind::Windows && ext == "ps1" {
        let mut cmd = Command::new("powershell.exe");
        cmd.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(program);
        cmd
    } else {
        Command::new(program)
    };
    augment_command_path(&mut cmd);
    hide_command_window(&mut cmd);
    cmd
}

/// Build a command for a resolved executable. Windows command/batch shims run
/// through cmd.exe and PowerShell scripts through powershell.exe.
pub fn command_for_program(program: &Path) -> Command {
    command_for_program_for(OsKind::current(), program)
}

/// Spawn a process whose result is intentionally ignored, retaining the Child
/// in a background waiter so it cannot become a zombie or leak process handles.
pub fn spawn_reaped(mut cmd: Command) -> std::io::Result<u32> {
    let mut child: Child = cmd.spawn()?;
    let pid = child.id();
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(pid)
}

/// Resolve a bare tool name to an absolute executable path when it is installed
/// in a well-known per-user location but is NOT on the inherited PATH. Returns
/// `None` when the name already carries a path, already resolves on PATH (so the
/// caller should keep using the bare name), or matches nowhere. This closes the
/// gap where Eldrun *detects* a tool (ollama/vibe/agent CLIs) yet fails to
/// *launch* it on Windows because winget/uv/npm install dirs aren't on PATH.
pub fn resolve_offpath_binary(bin: &str) -> Option<PathBuf> {
    if bin.is_empty() || bin.contains('/') || bin.contains('\\') {
        return None;
    }
    if binary_on_path(bin) {
        return None;
    }
    resolve_executable_in_dirs(
        OsKind::current(),
        &launch_search_dirs(),
        bin,
        std::env::var_os("PATHEXT").as_deref(),
        &|p| p.is_file(),
    )
}

pub fn home_dir() -> PathBuf {
    home_dir_for(OsKind::current(), |key| std::env::var(key).ok())
}

pub fn home_dir_string() -> String {
    home_dir().to_string_lossy().into_owned()
}

pub fn home_dir_for<F>(os: OsKind, mut env: F) -> PathBuf
where
    F: FnMut(&str) -> Option<String>,
{
    match os {
        OsKind::Windows => {
            if let Some(userprofile) = non_empty(env("USERPROFILE")) {
                return PathBuf::from(userprofile);
            }
            if let (Some(drive), Some(path)) =
                (non_empty(env("HOMEDRIVE")), non_empty(env("HOMEPATH")))
            {
                return PathBuf::from(format!("{drive}{path}"));
            }
            PathBuf::from(r"C:\Users\Default")
        }
        OsKind::Macos => env("HOME")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/tmp")),
        OsKind::Unix => env("HOME")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/root")),
    }
}

pub fn projects_root() -> PathBuf {
    home_dir().join("eldrun").join("projects")
}

/// The default parent for remote (SSH) projects' local mirrors: a top-level
/// `eldrun/projects-ssh/` sibling of [`projects_root`], rather than a nested
/// `projects/ssh/` subfolder. Keeps synced remote working copies out of the
/// managed-local-projects tree.
pub fn projects_ssh_root() -> PathBuf {
    home_dir().join("eldrun").join("projects-ssh")
}

pub fn root_work_dir() -> PathBuf {
    home_dir().join("eldrun").join("root")
}

pub fn boxes_root() -> PathBuf {
    home_dir().join("eldrun").join("boxes")
}

/// Holding area for deleted projects: `~/eldrun/archive/<id>/`. A deleted
/// project's local folders (and a restore manifest) move here rather than being
/// erased, so it can be restored or permanently cleared from Settings. Only ever
/// emptied manually from the Settings "Archived projects" panel.
pub fn archive_root() -> PathBuf {
    home_dir().join("eldrun").join("archive")
}

fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env<'a>(values: &'a [(&str, &str)]) -> impl FnMut(&str) -> Option<String> + 'a {
        let map = values.iter().copied().collect::<HashMap<_, _>>();
        move |key| map.get(key).map(|value| (*value).to_string())
    }

    #[test]
    fn windows_home_prefers_userprofile() {
        let home = home_dir_for(
            OsKind::Windows,
            env(&[
                ("USERPROFILE", r"C:\Users\alice"),
                ("HOMEDRIVE", "D:"),
                ("HOMEPATH", r"\Users\bob"),
            ]),
        );
        assert_eq!(home, PathBuf::from(r"C:\Users\alice"));
    }

    #[test]
    fn windows_home_uses_homedrive_and_homepath() {
        let home = home_dir_for(
            OsKind::Windows,
            env(&[("HOMEDRIVE", "D:"), ("HOMEPATH", r"\Users\bob")]),
        );
        assert_eq!(home, PathBuf::from(r"D:\Users\bob"));
    }

    #[test]
    fn windows_home_has_stable_fallback() {
        let home = home_dir_for(OsKind::Windows, env(&[]));
        assert_eq!(home, PathBuf::from(r"C:\Users\Default"));
    }

    #[test]
    fn unix_home_uses_home() {
        let home = home_dir_for(OsKind::Unix, env(&[("HOME", "/home/alice")]));
        assert_eq!(home, PathBuf::from("/home/alice"));
    }

    #[test]
    fn unix_home_falls_back_to_root() {
        let home = home_dir_for(OsKind::Unix, env(&[]));
        assert_eq!(home, PathBuf::from("/root"));
    }

    #[test]
    fn path_finder_is_where_on_windows_which_elsewhere() {
        assert_eq!(path_finder(OsKind::Windows), "where");
        assert_eq!(path_finder(OsKind::Macos), "which");
        assert_eq!(path_finder(OsKind::Unix), "which");
    }

    #[test]
    fn resolve_in_dirs_finds_extensionless_match() {
        let dirs = vec![
            PathBuf::from("/opt/bin"),
            PathBuf::from("/home/a/.local/bin"),
        ];
        let present = PathBuf::from("/home/a/.local/bin/vibe");
        let found = resolve_in_dirs(&dirs, "vibe", &[], &|p| p == present);
        assert_eq!(found, Some(present));
    }

    #[test]
    fn resolve_in_dirs_expands_windows_extensions_in_order() {
        let dirs = vec![PathBuf::from(r"C:\Users\a\.local\bin")];
        // Build the expected path via `join` (as `resolve_in_dirs` does) so the
        // separator is correct on every OS: a hardcoded backslash literal only
        // equals `dir.join(..)` on Windows, so it failed on the Linux CI runner.
        let present = dirs[0].join("vibe.exe");
        let found = resolve_in_dirs(&dirs, "vibe", &["exe", "cmd", "bat"], &|p| p == present);
        assert_eq!(found, Some(present));
    }

    #[test]
    fn resolve_in_dirs_returns_none_when_absent() {
        let dirs = vec![PathBuf::from("/opt/bin")];
        let found = resolve_in_dirs(&dirs, "nope", &["exe"], &|_| false);
        assert_eq!(found, None);
    }

    #[test]
    fn supplemental_paths_cover_all_supported_os_families() {
        let home = Path::new("/home/alice");
        let unix = supplemental_path_dirs_for(OsKind::Unix, home, None, None, None);
        assert!(unix.contains(&home.join(".local/bin")));
        assert!(unix.contains(&home.join(".cargo/bin")));
        assert!(unix.contains(&home.join(".opencode/bin")));

        let mac = supplemental_path_dirs_for(OsKind::Macos, home, None, None, None);
        assert!(mac.contains(&PathBuf::from("/opt/homebrew/bin")));
        assert!(mac.contains(&PathBuf::from("/Library/TeX/texbin")));

        let windows = supplemental_path_dirs_for(
            OsKind::Windows,
            Path::new(r"C:\Users\alice"),
            Some(OsStr::new(r"C:\Users\alice\AppData\Local")),
            Some(OsStr::new(r"C:\Users\alice\AppData\Roaming")),
            Some(OsStr::new(r"C:\Program Files")),
        );
        assert!(windows
            .iter()
            .any(|path| path.ends_with(Path::new("Microsoft/WindowsApps"))));
        assert!(windows.iter().any(|path| path.ends_with(Path::new("npm"))));
        assert!(windows
            .iter()
            .any(|path| path.ends_with(Path::new("Programs/Ollama"))));
        assert!(windows
            .iter()
            .any(|path| path.ends_with(Path::new("Programs/MiKTeX/miktex/bin/x64"))));
        assert!(windows
            .iter()
            .any(|path| path.ends_with(Path::new("Programs/OpenAI/Codex/bin"))));
        assert!(windows.iter().any(|path| {
            path.starts_with(r"C:\Program Files") && path.ends_with(Path::new("MiKTeX/miktex/bin/x64"))
        }));
    }

    #[test]
    fn windows_resolution_honors_pathext() {
        let dir = PathBuf::from("tools");
        for (ext, expected) in [
            ("EXE", "fmt.exe"),
            ("CMD", "fmt.cmd"),
            ("BAT", "fmt.bat"),
            ("PS1", "fmt.ps1"),
        ] {
            let present = dir.join(expected);
            let pathext = format!(".{ext}");
            let found = resolve_executable_in_dirs(
                OsKind::Windows,
                std::slice::from_ref(&dir),
                "fmt",
                Some(OsStr::new(&pathext)),
                &|path| path == present,
            );
            assert_eq!(found, Some(present));
        }
        let script = dir.join("fmt.ps1");
        let found = resolve_executable_in_dirs(
            OsKind::Windows,
            std::slice::from_ref(&dir),
            "fmt",
            Some(OsStr::new(".EXE;.CMD")),
            &|path| path == script,
        );
        assert_eq!(found, Some(script));
    }

    #[test]
    fn windows_scripts_dispatch_through_their_interpreters() {
        let cmd = command_for_program_for(OsKind::Windows, Path::new(r"C:\tools\fmt.cmd"));
        assert_eq!(cmd.get_program(), "cmd.exe");
        assert!(cmd
            .get_args()
            .any(|arg| arg == OsStr::new(r"C:\tools\fmt.cmd")));

        let ps = command_for_program_for(OsKind::Windows, Path::new(r"C:\tools\fmt.ps1"));
        assert_eq!(ps.get_program(), "powershell.exe");
        assert!(ps
            .get_args()
            .any(|arg| arg == OsStr::new(r"C:\tools\fmt.ps1")));

        let exe = command_for_program_for(OsKind::Windows, Path::new(r"C:\tools\fmt.exe"));
        assert_eq!(exe.get_program(), OsStr::new(r"C:\tools\fmt.exe"));
    }

    #[cfg(unix)]
    #[test]
    fn fire_and_forget_children_are_reaped() {
        let mut cmd = command_no_window("sh");
        cmd.args(["-c", "exit 0"]);
        let pid = spawn_reaped(cmd).expect("spawn");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while std::time::Instant::now() < deadline {
            let result =
                unsafe { libc::waitpid(pid as libc::pid_t, std::ptr::null_mut(), libc::WNOHANG) };
            if result == -1 {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        panic!("background waiter did not reap pid {pid}");
    }

    #[test]
    fn resolve_offpath_binary_ignores_qualified_names() {
        // A name carrying a path separator is already explicit — leave it alone.
        assert_eq!(resolve_offpath_binary("/usr/bin/vibe"), None);
        assert_eq!(resolve_offpath_binary(r"C:\tools\vibe.exe"), None);
        assert_eq!(resolve_offpath_binary(""), None);
    }

    #[test]
    fn boxes_root_ends_with_boxes_under_eldrun() {
        let dir = boxes_root();
        let last = dir.file_name().and_then(|n| n.to_str()).unwrap_or("");
        assert_eq!(last, "boxes", "boxes_root must end in 'boxes': {dir:?}");
        let parent = dir
            .parent()
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
            .unwrap_or("");
        assert_eq!(parent, "eldrun", "boxes_root parent must be 'eldrun'");
    }

    #[test]
    fn archive_root_ends_with_archive_under_eldrun() {
        let dir = archive_root();
        let last = dir.file_name().and_then(|n| n.to_str()).unwrap_or("");
        assert_eq!(
            last, "archive",
            "archive_root must end in 'archive': {dir:?}"
        );
        let parent = dir
            .parent()
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
            .unwrap_or("");
        assert_eq!(parent, "eldrun", "archive_root parent must be 'eldrun'");
    }
}
