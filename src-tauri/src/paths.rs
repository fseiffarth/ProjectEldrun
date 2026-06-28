use std::path::{Path, PathBuf};

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
pub fn command_no_window(bin: &str) -> std::process::Command {
    #[allow(unused_mut)]
    let mut cmd = std::process::Command::new(bin);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW (winbase.h): don't allocate a console for the child.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// True when `bin` resolves on `PATH` on the current OS. Centralised so every
/// "is this CLI installed?" probe is correct cross-platform — see [`path_finder`].
pub fn binary_on_path(bin: &str) -> bool {
    command_no_window(path_finder(OsKind::current()))
        .arg(bin)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

/// Well-known per-user directories that package managers drop CLI tools into but
/// which a running GUI app's *inherited* PATH frequently omits — so a tool can be
/// installed yet unreachable by bare name. Mirrors the fallback locations the
/// "is it installed?" probes already check (`ollama_is_installed`,
/// `vibe_is_installed`, the agent registry's `extra_paths`); kept here so the
/// *launch* path resolves to the same places detection trusts.
fn launch_search_dirs() -> Vec<PathBuf> {
    let home = home_dir();
    let mut dirs = vec![
        home.join(".local").join("bin"),
        home.join(".cargo").join("bin"),
        home.join(".opencode").join("bin"),
    ];
    if cfg!(target_os = "windows") {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            let local = PathBuf::from(local);
            // winget / the Ollama GUI installer (per-user).
            dirs.push(local.join("Programs").join("Ollama"));
            dirs.push(local.join("Microsoft").join("WindowsApps"));
        }
        if let Some(appdata) = std::env::var_os("APPDATA") {
            // npm global bin (shims live here as .cmd).
            dirs.push(PathBuf::from(appdata).join("npm"));
        }
    }
    dirs
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
    let exts: &[&str] = if cfg!(target_os = "windows") {
        &["exe", "cmd", "bat", "ps1"]
    } else {
        &[]
    };
    resolve_in_dirs(&launch_search_dirs(), bin, exts, &|p| p.is_file())
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

pub fn root_work_dir() -> PathBuf {
    home_dir().join("eldrun").join("root")
}

pub fn boxes_root() -> PathBuf {
    home_dir().join("eldrun").join("boxes")
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
        let dirs = vec![PathBuf::from("/opt/bin"), PathBuf::from("/home/a/.local/bin")];
        let present = PathBuf::from("/home/a/.local/bin/vibe");
        let found = resolve_in_dirs(&dirs, "vibe", &[], &|p| p == present);
        assert_eq!(found, Some(present));
    }

    #[test]
    fn resolve_in_dirs_expands_windows_extensions_in_order() {
        let dirs = vec![PathBuf::from(r"C:\Users\a\.local\bin")];
        let present = PathBuf::from(r"C:\Users\a\.local\bin\vibe.exe");
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
}
