//! Project-scoped screenshots: capture the screen and write the PNG into the
//! active project's `screenshots/` folder.
//!
//! Eldrun's global "Screenshot" app already launches a region-capture tool, but
//! each tool otherwise saves to its own default location (`~/Pictures`, a prompt,
//! …). This command instead drives the capture's *output path* into the project
//! so the shot lands beside the code it documents. The destination is confined
//! to the project root, mirroring `clipboard`/`fs`.
//!
//! The shot is *also* put on the system clipboard, so it can be pasted straight
//! into a chat or an agent tab without going hunting for the file (see
//! [`clipboard::copy_image_to_clipboard`]). Copying is best-effort and off the
//! critical path: the file is the product, the clipboard is a convenience.
//!
//! The platform-neutral layer (destination dir + timestamped filename) is shared;
//! the actual capture is delegated to a per-OS [`platform`] backend:
//! - **Linux** spawns an interactive native region tool (`spectacle`/`grim`/…),
//!   directed to write its PNG into the project's `screenshots/` folder.
//! - **Windows** grabs the whole virtual screen natively via GDI and encodes it
//!   to PNG with the `png` crate — no external tool required.
//! - **macOS** drives the built-in `screencapture` CLI in interactive region
//!   mode, writing the PNG into the project's `screenshots/` folder.
//! - **Any other OS** returns an error rather than failing to build.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::commands::fs::enforce_confinement;

/// How long, after the capture tool exits, we keep looking for the PNG it was
/// supposed to write before giving up on the clipboard copy.
#[cfg(any(target_os = "linux", target_os = "macos"))]
const SHOT_WAIT: std::time::Duration = std::time::Duration::from_secs(2);
#[cfg(any(target_os = "linux", target_os = "macos"))]
const SHOT_POLL: std::time::Duration = std::time::Duration::from_millis(100);

/// Capture a screenshot into `<project_dir>/screenshots/`.
///
/// `exec` is the command configured for the global Screenshot app (a full path
/// or bare name); the Linux backend uses it to pick a tool it can direct, while
/// the Windows backend ignores it (it always does a native grab). Returns the
/// directory the shot lands in; the project's filesystem watch surfaces the new
/// PNG in the file tree.
#[tauri::command]
pub fn capture_project_screenshot(project_dir: String, exec: Option<String>) -> Result<String, String> {
    let dir = ensure_screenshots_dir(&project_dir)?;
    platform::capture(&dir, exec.as_deref())?;
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

/// Spawn a capture tool detached and, once it exits, copy the PNG it produced
/// onto the clipboard.
///
/// Region selection blocks the *tool*, not Eldrun, so the shot does not exist
/// until the child is gone — the wait therefore happens on a background thread,
/// which also reaps the child (as `spawn_reaped` otherwise would). `expected` is
/// the path the tool was directed at, or `None` for tools that name the file
/// themselves (flameshot), where the newest PNG to appear is taken instead. A
/// cancelled capture writes no file at all, so finding nothing is a normal
/// outcome and stays silent.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn spawn_and_copy(
    mut cmd: std::process::Command,
    dir: &std::path::Path,
    expected: Option<PathBuf>,
) -> std::io::Result<()> {
    // Filesystem mtimes can be coarser than `SystemTime::now()`, so leave slack
    // rather than let a just-written file look older than the spawn.
    let since = SystemTime::now()
        .checked_sub(SHOT_WAIT)
        .unwrap_or_else(SystemTime::now);
    let mut child = cmd.spawn()?;
    let dir = dir.to_path_buf();
    std::thread::spawn(move || {
        if child.wait().is_err() {
            return;
        }
        // The PNG lands as the tool exits; poll briefly for it to appear (and to
        // be readable — a decode can lose a race with the tool's final flush).
        let polls = SHOT_WAIT.as_millis() / SHOT_POLL.as_millis();
        for _ in 0..polls {
            if let Some(shot) = locate_shot(&dir, expected.as_deref(), since) {
                if crate::commands::clipboard::copy_png_file_to_clipboard(&shot).is_ok() {
                    return;
                }
            }
            std::thread::sleep(SHOT_POLL);
        }
    });
    Ok(())
}

/// The PNG a capture just produced: the path the tool was directed at, or — for
/// tools that choose their own filename — the newest PNG in `dir` written since
/// the tool was spawned. `None` when the capture was cancelled and wrote nothing.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn locate_shot(
    dir: &std::path::Path,
    expected: Option<&std::path::Path>,
    since: SystemTime,
) -> Option<PathBuf> {
    if let Some(path) = expected {
        return path.is_file().then(|| path.to_path_buf());
    }
    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter(|entry| {
            entry
                .path()
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("png"))
        })
        .filter_map(|entry| {
            let mtime = entry.metadata().ok()?.modified().ok()?;
            (mtime >= since).then_some((mtime, entry.path()))
        })
        .max_by_key(|(mtime, _)| *mtime)
        .map(|(_, path)| path)
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

// ── Linux backend (drive an interactive native region tool) ──────────────────
#[cfg(target_os = "linux")]
mod platform {
    //! Spawns the user-configured (or first available) native region-capture
    //! tool, routing its output into the project's `screenshots/` folder. The
    //! tool is spawned detached — region selection blocks the *tool*, not Eldrun
    //! — and the project's filesystem watch surfaces the new PNG.

    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};

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

    /// Pick a tool (configured `exec` if directable, else the first native one on
    /// `PATH`) and spawn it detached, writing into `dir`.
    pub fn capture(dir: &Path, exec: Option<&str>) -> Result<(), String> {
        let configured = exec
            .map(str::trim)
            .filter(|e| !e.is_empty())
            .filter(|e| is_directable(&basename(e)));
        let program = match configured {
            Some(e) => e.to_string(),
            None => pick_native_tool().ok_or_else(|| {
                "no usable screenshot tool found; set one for the Screenshot global app".to_string()
            })?,
        };

        let (mut cmd, expected) = capture_command(&program, dir)
            .ok_or_else(|| format!("don't know how to capture with '{}'", basename(&program)))?;
        cmd.stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        crate::paths::augment_command_path(&mut cmd);
        super::spawn_and_copy(cmd, dir, expected).map_err(|e| format!("launch {program}: {e}"))?;
        Ok(())
    }

    /// Build the capture `Command` for a tool, routing its output into `dir`, plus
    /// the file it will write. Tools that take an explicit output file get a
    /// timestamped path; flameshot only takes a directory and names the file
    /// itself, so it reports no expected path. Returns `None` for tools we don't
    /// know how to direct.
    pub fn capture_command(program: &str, dir: &Path) -> Option<(Command, Option<PathBuf>)> {
        let base = basename(program);
        let file = dir.join(super::screenshot_filename());
        let f = file.to_string_lossy().to_string();
        let d = dir.to_string_lossy().to_string();

        let mut cmd = Command::new(program);
        match base.as_str() {
            // region + headless save, no desktop notification, -o output
            "spectacle" => cmd.args(["-r", "-b", "-n", "-o", &f]),
            "gnome-screenshot" => cmd.args(["--area", "--file", &f]),
            // flameshot names the file itself; -p sets the directory it saves into
            "flameshot" => {
                cmd.args(["gui", "--path", &d]);
                return Some((cmd, None));
            }
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
                return Some((sh, Some(file)));
            }
            _ => return None,
        };
        Some((cmd, Some(file)))
    }

    /// Whether `capture_command` knows how to direct a tool's output, by basename.
    pub fn is_directable(base: &str) -> bool {
        NATIVE_TOOLS.contains(&base)
    }

    /// First native tool present on `PATH` (grim additionally requires `slurp`).
    fn pick_native_tool() -> Option<String> {
        NATIVE_TOOLS
            .iter()
            .copied()
            .find(|&tool| on_path(tool) && (tool != "grim" || on_path("slurp")))
            .map(String::from)
    }

    /// Whether an executable named `name` exists on `PATH`.
    fn on_path(name: &str) -> bool {
        match std::env::var_os("PATH") {
            Some(path) => std::env::split_paths(&path).any(|dir| dir.join(name).is_file()),
            None => false,
        }
    }

    pub fn basename(exec: &str) -> String {
        Path::new(exec)
            .file_name()
            .map(|n| n.to_string_lossy().to_lowercase())
            .unwrap_or_default()
    }

    /// Minimal single-quote shell escaping for a path embedded in `sh -c`.
    pub fn shell_quote(s: &str) -> String {
        format!("'{}'", s.replace('\'', r"'\''"))
    }
}

// ── Windows backend (Win32 GDI virtual-screen grab) ──────────────────────────
#[cfg(target_os = "windows")]
mod platform {
    //! Native full virtual-screen capture via GDI. Windows has no equally
    //! ubiquitous interactive region CLI, so rather than shelling out we grab the
    //! entire virtual screen (every monitor) with `BitBlt` + `GetDIBits` and
    //! encode it to PNG with the `png` crate, writing the file directly into the
    //! project's `screenshots/` folder. This is deterministic — it always
    //! produces image data — and needs no external tool. The configured `exec`
    //! (which names a Linux tool) is ignored. Every GDI object acquired here is
    //! released on both the success and error paths.

    use std::ffi::c_void;
    use std::path::Path;

    use windows::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC,
        GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
        HDC, HGDIOBJ, SRCCOPY,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
        SM_YVIRTUALSCREEN,
    };

    /// Grab the virtual screen, write the PNG into `dir`, and put the same pixels
    /// on the clipboard. Unlike the spawn-a-tool backends, the buffer is already
    /// in hand here, so the copy needs no wait — and a clipboard failure must not
    /// fail a capture whose file landed fine. `_exec` is unused on Windows (the
    /// native grab is always preferred).
    pub fn capture(dir: &Path, _exec: Option<&str>) -> Result<(), String> {
        let (width, height, rgba) = grab_virtual_screen()?;
        let file = dir.join(super::screenshot_filename());
        encode_png_file(&file, width, height, &rgba)?;
        let _ = crate::commands::clipboard::copy_image_to_clipboard(
            width as usize,
            height as usize,
            rgba,
        );
        Ok(())
    }

    /// Capture all monitors as a single top-down RGBA buffer `(width, height, px)`.
    fn grab_virtual_screen() -> Result<(u32, u32, Vec<u8>), String> {
        // SAFETY: every GDI handle acquired below is released before this function
        // returns, on both the success and error paths.
        unsafe {
            let x = GetSystemMetrics(SM_XVIRTUALSCREEN);
            let y = GetSystemMetrics(SM_YVIRTUALSCREEN);
            let width = GetSystemMetrics(SM_CXVIRTUALSCREEN);
            let height = GetSystemMetrics(SM_CYVIRTUALSCREEN);
            if width <= 0 || height <= 0 {
                return Err("virtual screen has no area".to_string());
            }

            let screen_dc = GetDC(None);
            if screen_dc.is_invalid() {
                return Err("GetDC failed for the screen".to_string());
            }
            let result = capture_to_buffer(screen_dc, x, y, width, height);
            ReleaseDC(None, screen_dc);
            result
        }
    }

    /// BitBlt the screen region into a memory bitmap, then read it back as RGBA.
    /// Caller owns `screen_dc`; the memory DC and bitmap are created and freed here.
    unsafe fn capture_to_buffer(
        screen_dc: HDC,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
    ) -> Result<(u32, u32, Vec<u8>), String> {
        let mem_dc = CreateCompatibleDC(Some(screen_dc));
        if mem_dc.is_invalid() {
            return Err("CreateCompatibleDC failed".to_string());
        }
        let bitmap = CreateCompatibleBitmap(screen_dc, width, height);
        if bitmap.is_invalid() {
            let _ = DeleteDC(mem_dc);
            return Err("CreateCompatibleBitmap failed".to_string());
        }
        let prev = SelectObject(mem_dc, HGDIOBJ(bitmap.0));

        let result = (|| {
            BitBlt(mem_dc, 0, 0, width, height, Some(screen_dc), x, y, SRCCOPY)
                .map_err(|e| format!("BitBlt failed: {e}"))?;

            // Negative biHeight requests top-down rows, so the buffer is already in
            // the row order the PNG encoder expects.
            let header = BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0 as u32,
                ..Default::default()
            };
            let mut info = BITMAPINFO {
                bmiHeader: header,
                ..Default::default()
            };

            let mut buffer = vec![0u8; (width as usize) * (height as usize) * 4];
            let scanlines = GetDIBits(
                mem_dc,
                bitmap,
                0,
                height as u32,
                Some(buffer.as_mut_ptr() as *mut c_void),
                &mut info,
                DIB_RGB_COLORS,
            );
            if scanlines == 0 {
                return Err("GetDIBits failed".to_string());
            }
            // GDI delivers BGRA with an unused alpha byte; convert to opaque RGBA.
            for px in buffer.chunks_exact_mut(4) {
                px.swap(0, 2);
                px[3] = 0xFF;
            }
            Ok((width as u32, height as u32, buffer))
        })();

        let _ = SelectObject(mem_dc, prev);
        let _ = DeleteObject(HGDIOBJ(bitmap.0));
        let _ = DeleteDC(mem_dc);
        result
    }

    /// Encode an RGBA buffer to a PNG file (matching `clipboard`'s encoder setup).
    fn encode_png_file(path: &Path, width: u32, height: u32, rgba: &[u8]) -> Result<(), String> {
        let file = std::fs::File::create(path).map_err(|e| e.to_string())?;
        let writer = std::io::BufWriter::new(file);
        let mut encoder = png::Encoder::new(writer, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
        writer.write_image_data(rgba).map_err(|e| e.to_string())?;
        Ok(())
    }
}

// ── macOS backend (built-in `screencapture` CLI) ─────────────────────────────
#[cfg(target_os = "macos")]
mod platform {
    //! Drives macOS's built-in `screencapture` in interactive region mode,
    //! routing its output into the project's `screenshots/` folder. Like the Linux
    //! backend, the tool is spawned detached — region selection blocks the *tool*,
    //! not Eldrun — and the project's filesystem watch surfaces the new PNG. The
    //! configured `exec` is ignored (the OS tool is always used).

    use std::path::Path;
    use std::process::{Command, Stdio};

    /// Spawn `screencapture -i <file>` (interactive region capture) writing into
    /// `dir`. `_exec` is unused on macOS.
    pub fn capture(dir: &Path, _exec: Option<&str>) -> Result<(), String> {
        let file = dir.join(super::screenshot_filename());
        let mut cmd = crate::paths::command_no_window("screencapture");
        cmd.arg("-i")
            .arg(&file)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        super::spawn_and_copy(cmd, dir, Some(file))
            .map_err(|e| format!("launch screencapture: {e}"))?;
        Ok(())
    }
}

// ── Fallback backend (other OSes) ────────────────────────────────────────────
// Any remaining target has no native path wired yet; capture fails with a clear
// error rather than the crate failing to build.
#[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
mod platform {
    use std::path::Path;

    pub fn capture(_dir: &Path, _exec: Option<&str>) -> Result<(), String> {
        Err("screenshot capture is not supported on this platform".to_string())
    }
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

    #[cfg(target_os = "linux")]
    #[test]
    fn basename_lowercases_and_strips_dir() {
        assert_eq!(platform::basename("/usr/bin/Spectacle"), "spectacle");
        assert_eq!(platform::basename("flameshot"), "flameshot");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn directable_matches_known_tools() {
        assert!(platform::is_directable("scrot"));
        assert!(platform::is_directable("grim"));
        assert!(!platform::is_directable("totally-unknown-tool"));
    }

    /// The directed-output case: the tool's file is taken when it exists, and a
    /// cancelled capture (no file) yields nothing rather than an older shot.
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn locate_shot_uses_the_expected_path_when_written() {
        let dir = tempfile::tempdir().unwrap();
        let stale = dir.path().join("Screenshot-20200101-000000.png");
        std::fs::write(&stale, b"old").unwrap();
        let expected = dir.path().join("Screenshot-20260101-000000.png");
        let since = SystemTime::now() - SHOT_WAIT;

        assert_eq!(locate_shot(dir.path(), Some(&expected), since), None);
        std::fs::write(&expected, b"new").unwrap();
        assert_eq!(
            locate_shot(dir.path(), Some(&expected), since),
            Some(expected)
        );
    }

    /// The self-naming case (flameshot): the newest PNG written since the spawn
    /// wins, and PNGs predating it — or non-PNGs — are ignored.
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn locate_shot_picks_the_newest_png_since_spawn() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("old.png");
        std::fs::write(&old, b"old").unwrap();

        // Spawned now: anything already on disk is older than the cutoff.
        let since = SystemTime::now();
        assert_eq!(locate_shot(dir.path(), None, since), None);

        std::fs::write(dir.path().join("notes.txt"), b"txt").unwrap();
        let shot = dir.path().join("shot.png");
        std::fs::write(&shot, b"new").unwrap();
        assert_eq!(locate_shot(dir.path(), None, since), Some(shot));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn capture_command_reports_the_file_it_directs() {
        let dir = std::path::Path::new("/tmp/eldrun-shots");
        let (_, expected) = platform::capture_command("scrot", dir).unwrap();
        let expected = expected.expect("scrot is directed at an explicit file");
        assert_eq!(expected.parent(), Some(dir));
        assert!(expected.extension().is_some_and(|e| e == "png"));

        // flameshot names the file itself, so there is no path to expect.
        let (_, expected) = platform::capture_command("flameshot", dir).unwrap();
        assert_eq!(expected, None);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn shell_quote_escapes_single_quotes() {
        assert_eq!(platform::shell_quote("/a/b.png"), "'/a/b.png'");
        assert_eq!(platform::shell_quote("/o'dir/x.png"), r"'/o'\''dir/x.png'");
    }
}
