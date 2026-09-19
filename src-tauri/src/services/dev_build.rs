//! What the background "Eldrun (dev)" freeze is doing, read for the header's
//! dev-build chip (`header/DevBuildIndicator.tsx`).
//!
//! The build is `scripts/package-dev-auto.sh`'s, queued by the `post-commit`
//! hook (see `docs/context/dev_builds.md`). This module never starts, stops or
//! queues one — it reads the files that script already keeps for `--status`:
//! the lock directory and its pid, the pending marker, the installed-commit
//! stamp, the last failure, and the tail of the log, whose own lines say which
//! step a pass has reached.
//!
//! Only a binary built from a checkout knows where that checkout is:
//! `ELDRUN_DEV_SOURCE_ROOT` is exported by `package-dev.sh` and the hot-reload
//! launcher and read at compile time, so a released Eldrun (CI builds, the
//! AppImage) has no source root, reads nothing, and shows no chip.

use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use serde::Serialize;

/// The checkout this binary was built from, or `None` for a release build.
pub const SOURCE_ROOT: Option<&str> = option_env!("ELDRUN_DEV_SOURCE_ROOT");

/// How much of the log's end is read. One pass writes ~25 KB (vite's asset
/// listing dominates), so this holds the running pass and the one before it,
/// whose duration is the estimate.
const LOG_TAIL_BYTES: u64 = 256 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BuildState {
    /// No build process alive.
    Idle,
    /// The build process is alive but waiting for commits to settle
    /// (`ELDRUN_DEV_BUILD_SETTLE`) before its next pass.
    Waiting,
    /// A pass is running.
    Building,
}

/// Which step of `package-dev.sh --head` the running pass has reached, from the
/// last marker line the log holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BuildPhase {
    /// Checking the commit out into the freeze tree.
    Prepare,
    /// `tsc && vite build`.
    Frontend,
    /// `npm run mobile:build`.
    Mobile,
    /// The release `cargo build`.
    Cargo,
    /// Checking and installing the finished binary.
    Install,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FailedBuild {
    pub commit: String,
    pub status: String,
    pub when: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevBuildStatus {
    pub state: BuildState,
    /// Set while `Building`.
    pub phase: Option<BuildPhase>,
    /// Short commit the running pass builds.
    pub commit: Option<String>,
    /// Epoch seconds the running pass started.
    pub started_at: Option<i64>,
    /// How long the last successful pass in the log took, in seconds — the
    /// chip's estimate. `None` when the log holds none.
    pub estimate_secs: Option<i64>,
    /// A commit landed that the running (or next) pass will build.
    pub queued: bool,
    /// The last pass that failed, until one succeeds.
    pub failed: Option<FailedBuild>,
    /// Short commit of the installed snapshot.
    pub installed: Option<String>,
    /// Commits on `HEAD` the installed snapshot does not have.
    pub behind: Option<u32>,
    /// This process is the frozen binary and a newer one has been installed
    /// over it since it started: a relaunch picks the new one up.
    pub relaunch: bool,
    pub log_path: String,
}

/// What a log tail says about the passes in it. Pure; see [`parse_log`].
#[derive(Debug, Default, PartialEq)]
pub struct LogSummary {
    /// A pass that started and has not reported finishing: (start, commit, phase).
    pub open_pass: Option<(Option<i64>, String, BuildPhase)>,
    /// Duration of the last pass that finished with status 0.
    pub last_success_secs: Option<i64>,
}

/// Read the passes out of the tail of `package-dev-auto.log`.
///
/// The script's own lines (`<iso> building <root> @ <sha>`,
/// `<iso> pass N (<sha>) finished with status S`) bracket each pass; between
/// them, npm's and cargo's banners say which step is running.
pub fn parse_log(text: &str) -> LogSummary {
    let mut summary = LogSummary::default();
    let mut open: Option<(Option<i64>, String, BuildPhase)> = None;
    for line in text.lines() {
        let trimmed = line.trim();
        if let Some((ts, rest)) = line.split_once(' ') {
            if let Some(commit) = rest.strip_prefix("building ").and_then(|r| r.rsplit_once(" @ ")) {
                open = Some((parse_iso8601(ts), commit.1.trim().to_string(), BuildPhase::Prepare));
                continue;
            }
            if rest.starts_with("pass ") && rest.contains(" finished with status ") {
                if let Some((start, _, phase)) = open.take() {
                    // Only a pass that got as far as installing is a build: one
                    // that found the tree unchanged takes no time and estimates
                    // nothing.
                    let ok = rest.trim_end().ends_with(" status 0") && phase == BuildPhase::Install;
                    if let (true, Some(start), Some(end)) = (ok, start, parse_iso8601(ts)) {
                        summary.last_success_secs = Some((end - start).max(0));
                    }
                }
                continue;
            }
        }
        let Some((_, _, phase)) = open.as_mut() else {
            continue;
        };
        // npm's banner, `> <package>@<version> <script>`; the line after it
        // (`> tsc && vite build && …`) is the script's body, not a banner.
        let script = trimmed
            .strip_prefix("> ")
            .and_then(|r| r.split_once(' '))
            .filter(|(package, _)| package.contains('@'))
            .map(|(_, script)| script.trim());
        if script == Some("build") {
            *phase = BuildPhase::Frontend;
        } else if script == Some("mobile:build") {
            *phase = BuildPhase::Mobile;
        } else if trimmed.starts_with("package-dev: published the phone bundle")
            || trimmed.starts_with("Compiling ")
        {
            *phase = BuildPhase::Cargo;
        } else if trimmed.starts_with("Finished `release`") {
            *phase = BuildPhase::Install;
        }
    }
    summary.open_pass = open;
    summary
}

/// Epoch seconds of `date -Is` output (`2026-09-18T15:26:39+02:00`), or `None`.
pub fn parse_iso8601(s: &str) -> Option<i64> {
    let s = s.trim();
    let (date, time) = s.split_once('T')?;
    let mut d = date.splitn(3, '-').map(|p| p.parse::<i64>().ok());
    let (y, m, day) = (d.next()??, d.next()??, d.next()??);
    if !(1..=12).contains(&m) || !(1..=31).contains(&day) {
        return None;
    }
    let (clock, offset) = if let Some(clock) = time.strip_suffix('Z') {
        (clock, 0)
    } else {
        let at = time.rfind(['+', '-'])?;
        let (clock, off) = time.split_at(at);
        let sign = if off.starts_with('-') { -1 } else { 1 };
        let (oh, om) = off[1..].split_once(':').unwrap_or((&off[1..], "0"));
        (clock, sign * (oh.parse::<i64>().ok()? * 3600 + om.parse::<i64>().ok()? * 60))
    };
    let mut c = clock.splitn(3, ':').map(|p| p.parse::<i64>().ok());
    let (h, mi, sec) = (c.next()??, c.next()??, c.next()??);
    let days = crate::schema::calendar::days_from_civil(y as i32, m as u32, day as u32);
    Some(days * 86_400 + h * 3600 + mi * 60 + sec - offset)
}

/// Where the script keeps its files: fixed per user, like the binary it
/// installs, never the (sandboxable) state dir.
fn app_dir() -> PathBuf {
    crate::paths::home_dir().join(".local/share/eldrun")
}

fn read_trimmed(path: &Path) -> Option<String> {
    let text = fs::read_to_string(path).ok()?;
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_string())
}

fn read_log_tail(path: &Path) -> String {
    let Ok(mut file) = fs::File::open(path) else {
        return String::new();
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let from = len.saturating_sub(LOG_TAIL_BYTES);
    if file.seek(SeekFrom::Start(from)).is_err() {
        return String::new();
    }
    let mut bytes = Vec::new();
    if file.read_to_end(&mut bytes).is_err() {
        return String::new();
    }
    let text = String::from_utf8_lossy(&bytes).into_owned();
    // A cut mid-line is not a line.
    match (from > 0, text.find('\n')) {
        (true, Some(at)) => text[at + 1..].to_string(),
        _ => text,
    }
}

/// Whether the build process holding the lock is alive. A lock left by a
/// crashed build (no such pid) is not a build.
fn lock_holder_alive(lock_dir: &Path) -> bool {
    let Some(pid) = read_trimmed(&lock_dir.join("pid")).and_then(|p| p.parse::<u32>().ok()) else {
        return false;
    };
    Path::new(&format!("/proc/{pid}")).exists()
}

fn commits_behind(root: &str, installed: &str) -> Option<u32> {
    let out = crate::paths::command_no_window("git")
        .args(["-C", root, "rev-list", "--count", &format!("{installed}..HEAD")])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout).trim().parse().ok()
}

/// Linux keeps `/proc/self/exe` pointing at the inode this process runs, and
/// marks it `(deleted)` once `install` has replaced the path.
fn replaced_under_us(binary: &Path) -> bool {
    let Ok(exe) = fs::read_link("/proc/self/exe") else {
        return false;
    };
    let exe = exe.to_string_lossy();
    exe.strip_suffix(" (deleted)")
        .is_some_and(|path| Path::new(path) == binary)
}

fn short(sha: &str) -> String {
    sha.chars().take(7).collect()
}

/// The chip's reading, or `None` when this binary was not built from a checkout.
pub fn status() -> Option<DevBuildStatus> {
    let root = SOURCE_ROOT?;
    let dir = app_dir();
    let log_path = dir.join("package-dev-auto.log");
    let alive = lock_holder_alive(&dir.join("package-dev-auto.lock"));
    let summary = if alive {
        parse_log(&read_log_tail(&log_path))
    } else {
        LogSummary::default()
    };

    let (state, phase, commit, started_at) = match (alive, summary.open_pass) {
        (false, _) => (BuildState::Idle, None, None, None),
        (true, None) => (BuildState::Waiting, None, None, None),
        (true, Some((start, commit, phase))) => {
            (BuildState::Building, Some(phase), Some(commit), start)
        }
    };

    let failed = read_trimmed(&dir.join("package-dev-auto.failed")).map(|line| {
        let mut parts = line.splitn(3, ' ');
        FailedBuild {
            commit: parts.next().unwrap_or_default().to_string(),
            status: parts.next().unwrap_or_default().to_string(),
            when: parts.next().unwrap_or_default().to_string(),
        }
    });
    let stamp = read_trimmed(&dir.join("package-dev-auto.stamp"));
    let behind = stamp.as_deref().and_then(|sha| commits_behind(root, sha));

    Some(DevBuildStatus {
        state,
        phase,
        commit,
        started_at,
        estimate_secs: summary.last_success_secs,
        queued: dir.join("package-dev-auto.pending").exists(),
        failed,
        installed: stamp.as_deref().map(short),
        behind,
        relaunch: replaced_under_us(&dir.join("eldrun-dev")),
        log_path: log_path.to_string_lossy().into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso8601_honours_the_offset() {
        assert_eq!(parse_iso8601("1970-01-01T00:00:00+00:00"), Some(0));
        assert_eq!(parse_iso8601("1970-01-01T02:00:00+02:00"), Some(0));
        assert_eq!(parse_iso8601("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_iso8601("1969-12-31T19:00:00-05:00"), Some(0));
        assert_eq!(parse_iso8601("2026-09-18T15:26:39+02:00"), Some(1_789_737_999));
        assert_eq!(parse_iso8601("garbage"), None);
        assert_eq!(parse_iso8601("2026-13-01T00:00:00Z"), None);
    }

    const PASS_OK: &str = "\
=== PACKAGE:DEV (auto) 2026-09-18T14:40:00+02:00 ===
2026-09-18T14:40:30+02:00 building /r @ 47b2af1

> eldrun@0.1.72 build
> tsc && vite build && npm run mobile:build
✓ built in 16.37s
> eldrun@0.1.72 mobile:build
package-dev: published the phone bundle (47b2af1) to /r/target/mobile-pwa
   Compiling eldrun v0.1.72 (/r/target/freeze-tree/src-tauri)
    Finished `release` profile [optimized] target(s) in 2m 14s
Installed frozen binary: /h/eldrun-dev (0.1.72 @ 47b2af1, from head)
2026-09-18T14:48:19+02:00 pass 1 (47b2af1) finished with status 0
";

    #[test]
    fn a_finished_pass_is_the_estimate_and_nothing_is_open() {
        let s = parse_log(PASS_OK);
        assert_eq!(s.open_pass, None);
        assert_eq!(s.last_success_secs, Some(7 * 60 + 49));
    }

    #[test]
    fn the_running_pass_reports_its_latest_step() {
        let mut log = PASS_OK.to_string();
        log.push_str("2026-09-18T15:26:39+02:00 building /r @ 30ed347\n");
        let s = parse_log(&log);
        assert_eq!(
            s.open_pass,
            Some((parse_iso8601("2026-09-18T15:26:39+02:00"), "30ed347".into(), BuildPhase::Prepare))
        );
        let step = |extra: &str| parse_log(&format!("{log}{extra}")).open_pass.map(|p| p.2);
        assert_eq!(
            step("> eldrun@0.1.73 build\n> tsc && vite build && npm run mobile:build\n"),
            Some(BuildPhase::Frontend)
        );
        assert_eq!(step("> eldrun@0.1.73 mobile:build\n"), Some(BuildPhase::Mobile));
        assert_eq!(
            step("package-dev: published the phone bundle (30ed347) to /x\n"),
            Some(BuildPhase::Cargo)
        );
        assert_eq!(
            step("    Finished `release` profile [optimized] target(s) in 7m 01s\n"),
            Some(BuildPhase::Install)
        );
        // The earlier pass still supplies the estimate.
        assert_eq!(parse_log(&log).last_success_secs, Some(469));
    }

    #[test]
    fn a_failed_pass_is_no_estimate() {
        let log = "\
2026-09-18T10:00:00+02:00 building /r @ aaa
2026-09-18T10:01:00+02:00 pass 1 (aaa) finished with status 1
";
        let s = parse_log(log);
        assert_eq!(s.open_pass, None);
        assert_eq!(s.last_success_secs, None);
    }

    #[test]
    fn an_unchanged_tree_is_no_estimate() {
        let log = "\
2026-09-18T10:00:00+02:00 building /r @ aaa
2026-09-18T10:00:00+02:00 tree unchanged since the installed snapshot (aaa) — nothing to build
2026-09-18T10:00:01+02:00 pass 1 (aaa) finished with status 0
";
        assert_eq!(parse_log(log).last_success_secs, None);
    }
}
