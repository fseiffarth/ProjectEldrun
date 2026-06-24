//! Project-scoped screenshots: capture an interactive screen region and write
//! the PNG into the active project's `screenshots/` folder.
//!
//! Eldrun's global "Screenshot" app already launches a region-capture tool, but
//! each tool otherwise saves to its own default location (`~/Pictures`, a prompt,
//! …). This command instead drives the tool's *output path* into the project so
//! the capture lands beside the code it documents. It prefers the tool the user
//! configured for the Screenshot global app; if that tool isn't one we know how
//! to direct (or none is configured), it falls back to the first available
//! native region-capture tool. The destination is confined to the project root,
//! mirroring `clipboard`/`fs`.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::commands::fs::enforce_confinement;

/// Native region-capture tools we know how to drive, in preference order. The
/// first one present on `PATH` is used when the global Screenshot app has no
/// usable command. `grim` additionally needs `slurp` for region selection.
const NATIVE_TOOLS: &[&str] = &[
    "spectacle",
    "gnome-screenshot",
    "flameshot",
    "grim",
    "scrot",
    "maim",
    "xfce4-screenshooter",
    "ksnip",
    "shutter",
    "import",
];

/// Capture an interactive screen region into `<project_dir>/screenshots/`.
///
/// `exec` is the command configured for the global Screenshot app (a full path
/// or bare name); when it names a tool we can direct, it is used, otherwise a
/// native tool is chosen. The capture tool is spawned detached — region
/// selection blocks the *tool*, not Eldrun — and the project's filesystem watch
/// surfaces the new PNG in the file tree. Returns the directory the shot will
/// land in (the exact filename is the tool's for dir-mode tools like flameshot).
#[tauri::command]
pub fn capture_project_screenshot(project_dir: String, exec: Option<String>) -> Result<String, String> {
    let dir = ensure_screenshots_dir(&project_dir)?;

    let configured = exec
        .as_deref()
        .map(str::trim)
        .filter(|e| !e.is_empty())
        .filter(|e| is_directable(&basename(e)));
    let program = match configured {
        Some(e) => e.to_string(),
        None => pick_native_tool()
            .ok_or_else(|| "no usable screenshot tool found; set one for the Screenshot global app".to_string())?,
    };

    let mut cmd = capture_command(&program, &dir)
        .ok_or_else(|| format!("don't know how to capture with '{}'", basename(&program)))?;
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    cmd.spawn()
        .map_err(|e| format!("launch {program}: {e}"))?;

    Ok(dir.to_string_lossy().to_string())
}

/// Create (and confine) `<project_dir>/screenshots/`, returning its canonical path.
fn ensure_screenshots_dir(project_dir: &str) -> Result<PathBuf, String> {
    let root = std::fs::canonicalize(project_dir).map_err(|e| e.to_string())?;
    let dir = root.join("screenshots");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dir_c = std::fs::canonicalize(&dir).map_err(|e| e.to_string())?;
    enforce_confinement(&root, &dir_c)?;
    Ok(dir_c)
}

/// Build the capture `Command` for a tool, routing its output into `dir`. Tools
/// that take an explicit output file get a timestamped path; tools that only
/// take a directory (flameshot) or self-name (`import`) write into `dir` too.
/// Returns `None` for tools we don't know how to direct.
fn capture_command(program: &str, dir: &Path) -> Option<Command> {
    let base = basename(program);
    let file = dir.join(screenshot_filename());
    let f = file.to_string_lossy().to_string();
    let d = dir.to_string_lossy().to_string();

    let mut cmd = Command::new(program);
    match base.as_str() {
        // region + headless save, no desktop notification, -o output
        "spectacle" => cmd.args(["-r", "-b", "-n", "-o", &f]),
        "gnome-screenshot" => cmd.args(["--area", "--file", &f]),
        // flameshot names the file itself; -p sets the directory it saves into
        "flameshot" => cmd.args(["gui", "--path", &d]),
        "scrot" => cmd.args(["--select", &f]),
        "maim" => cmd.args(["--select", &f]),
        "xfce4-screenshooter" => cmd.args(["--region", "--save", &f]),
        "ksnip" => cmd.args(["--rectarea", "-s", &f]),
        "shutter" => cmd.args(["--select", "--exit_after_capture", "-o", &f]),
        // ImageMagick: bare `import <file>` lets the user click/drag a region
        "import" => cmd.arg(&f),
        // Wayland: slurp selects the region, grim captures it — needs a shell
        "grim" => {
            let mut sh = Command::new("sh");
            sh.arg("-c").arg(format!("grim -g \"$(slurp)\" {}", shell_quote(&f)));
            return Some(sh);
        }
        _ => return None,
    };
    Some(cmd)
}

/// Whether `capture_command` knows how to direct a tool's output, by basename.
fn is_directable(base: &str) -> bool {
    NATIVE_TOOLS.contains(&base)
}

/// First native tool present on `PATH` (grim additionally requires `slurp`).
fn pick_native_tool() -> Option<String> {
    NATIVE_TOOLS.iter().copied().find(|&tool| {
        on_path(tool) && (tool != "grim" || on_path("slurp"))
    }).map(String::from)
}

/// Whether an executable named `name` exists on `PATH`.
fn on_path(name: &str) -> bool {
    match std::env::var_os("PATH") {
        Some(path) => std::env::split_paths(&path).any(|dir| dir.join(name).is_file()),
        None => false,
    }
}

fn basename(exec: &str) -> String {
    Path::new(exec)
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default()
}

/// `Screenshot-YYYYMMDD-HHMMSS.png` in UTC — sortable and collision-resistant.
fn screenshot_filename() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0) as i64;
    let (y, mo, d) = civil_from_days(secs.div_euclid(86_400));
    let tod = secs.rem_euclid(86_400);
    let (h, mi, s) = (tod / 3600, (tod % 3600) / 60, tod % 60);
    format!("Screenshot-{y:04}{mo:02}{d:02}-{h:02}{mi:02}{s:02}.png")
}

/// Civil date from days since the Unix epoch (Howard Hinnant's algorithm).
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Minimal single-quote shell escaping for a path embedded in `sh -c`.
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filename_has_expected_shape() {
        let name = screenshot_filename();
        assert!(name.starts_with("Screenshot-"));
        assert!(name.ends_with(".png"));
        // Screenshot-YYYYMMDD-HHMMSS.png == 11 + 8 + 1 + 6 + 4
        assert_eq!(name.len(), 30);
    }

    #[test]
    fn civil_from_days_known_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(18_993), (2022, 1, 1));
    }

    #[test]
    fn basename_lowercases_and_strips_dir() {
        assert_eq!(basename("/usr/bin/Spectacle"), "spectacle");
        assert_eq!(basename("flameshot"), "flameshot");
    }

    #[test]
    fn directable_matches_known_tools() {
        assert!(is_directable("scrot"));
        assert!(is_directable("grim"));
        assert!(!is_directable("totally-unknown-tool"));
    }

    #[test]
    fn shell_quote_escapes_single_quotes() {
        assert_eq!(shell_quote("/a/b.png"), "'/a/b.png'");
        assert_eq!(shell_quote("/o'dir/x.png"), r"'/o'\''dir/x.png'");
    }
}
