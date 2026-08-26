//! The native print manager: which printers this machine can reach, what is
//! queued on them, and the few actions a queue is worth opening for.
//!
//! It replaces the `print_manager` *global app* slot — the button that launched
//! whatever external printer GUI the user had configured — for the reason the
//! mail/calendar/file-manager roles were retired before it: the thing behind the
//! button is a list and a handful of verbs, and Eldrun can render a list.
//!
//! Two backends, picked by target OS, both **read-only by default**:
//!
//!  - **CUPS** (Linux, macOS): `lpstat`/`lpq` to read, `cancel`/`lpoptions`/
//!    `cupsenable`/`cupsdisable`/`lp` to act. Every read runs with `LC_ALL=C`,
//!    because these tools translate their output — "is idle" becomes "ist im
//!    Leerlauf" under a German locale and every parser here would go blind.
//!  - **Windows**: one PowerShell script per read, returning JSON.
//!
//! Three rules the whole module keeps:
//!
//!  1. **Nothing is spawned through a shell.** Names reach `Command` as argv
//!     entries, so a printer called `; rm -rf ~` is a printer with a silly name
//!     and not a command. The Windows path is the exception that proves it — a
//!     PowerShell script *is* a string — so every name interpolated there goes
//!     through [`ps_quote`] after [`check_printer_name`] has already refused the
//!     characters that make quoting interesting.
//!  2. **Every read is capped in time** ([`run_capped`]). `lpstat` talks to a
//!     CUPS server that may be a machine on the other end of a dead VPN, and it
//!     waits; a Tauri command that waits with it takes the window down with it.
//!     Hence the cap *and* `spawn_blocking`.
//!  3. **A missing print system is a state, not an error.** No `lpstat` on PATH
//!     (a container, a minimal install) resolves to `supported: false` plus a
//!     sentence, so the pane says what is wrong instead of rendering an empty
//!     table that reads as "no printers".

use std::collections::HashMap;
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde::Serialize;

/// How long any single probe/action may take before it is killed. Generous
/// enough for a cold CUPS daemon, short enough that a wedged one is a message
/// on screen rather than a pane that never resolves.
const RUN_TIMEOUT: Duration = Duration::from_secs(8);

/// One printer as the pane renders it. Every string is best-effort: a field the
/// print system did not report stays empty and the row simply omits it, rather
/// than showing a placeholder that looks like a reading.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct PrinterInfo {
    pub name: String,
    pub description: String,
    pub location: String,
    /// `idle` | `printing` | `stopped` | `unknown` — a small closed set the
    /// frontend tones by; anything unrecognized degrades to `unknown`, never to
    /// a healthy-looking value.
    pub state: String,
    /// The reason line a stopped printer carries ("(paused)", "Out of paper").
    pub state_message: String,
    /// Whether the queue accepts new jobs. A printer can be *stopped* but still
    /// accepting (jobs pile up), which is exactly the state a user opens a print
    /// manager to discover, so the two are separate fields rather than one.
    pub accepting: bool,
    pub is_default: bool,
}

/// One queued job.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct PrintJob {
    /// The id the print system cancels by: `Printer-42` on CUPS, the plain
    /// number on Windows. Passed back verbatim to [`print_job_cancel`].
    pub id: String,
    /// The numeric part, used to join a CUPS job to its `lpq` title.
    pub number: u32,
    pub printer: String,
    pub user: String,
    /// The document name. CUPS does not report it in `lpstat -o` at all, so it
    /// is joined in from `lpq -a`; a job whose title could not be recovered
    /// shows its id instead of a blank row.
    pub title: String,
    pub size_bytes: u64,
    /// As reported, unparsed: CUPS prints a locale-formatted timestamp and
    /// re-deriving an epoch from it would be a second parser to get wrong.
    pub submitted: String,
    /// `printing` | `pending` | `held` | `unknown`.
    pub state: String,
}

/// One whole reading of the machine's print system — printers *and* jobs in a
/// single command, because they are polled together and two commands would make
/// the pane show a job on a printer it has not listed yet.
#[derive(Debug, Clone, Default, Serialize)]
pub struct PrintSnapshot {
    /// False when there is no usable print system here. The pane renders `note`
    /// instead of an empty table.
    pub supported: bool,
    /// `cups` | `windows` | `none`.
    pub backend: String,
    pub default_printer: Option<String>,
    pub printers: Vec<PrinterInfo>,
    pub jobs: Vec<PrintJob>,
    /// A sentence for the user when something is off (no tooling, a probe that
    /// timed out). Empty on a clean read.
    pub note: String,
}

// ── Process plumbing ─────────────────────────────────────────────────────────

/// Run `bin args…` with a hard time cap, returning `(ok, stdout, stderr)`.
///
/// Reads both pipes on their own threads for `tex.rs`'s reason: a child that
/// fills a pipe buffer while nobody reads deadlocks, which would make the cap
/// fire on a perfectly healthy machine with many printers. `LC_ALL=C`/`LANG=C`
/// are set on every call because the parsers below read English CUPS output.
fn run_capped(bin: &str, args: &[&str]) -> Result<(bool, String, String), String> {
    let mut child = crate::paths::command_no_window(bin)
        .args(args)
        .env("LC_ALL", "C")
        .env("LANG", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("{bin}: {e}"))?;

    let mut out_pipe = child.stdout.take();
    let mut err_pipe = child.stderr.take();
    let out_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(p) = out_pipe.as_mut() {
            let _ = std::io::Read::read_to_end(p, &mut buf);
        }
        buf
    });
    let err_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(p) = err_pipe.as_mut() {
            let _ = std::io::Read::read_to_end(p, &mut buf);
        }
        buf
    });

    let deadline = Instant::now() + RUN_TIMEOUT;
    let status = loop {
        match child.try_wait().map_err(|e| format!("{bin}: {e}"))? {
            Some(s) => break Some(s),
            None if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            None => std::thread::sleep(Duration::from_millis(40)),
        }
    };

    let stdout = String::from_utf8_lossy(&out_reader.join().unwrap_or_default()).into_owned();
    let stderr = String::from_utf8_lossy(&err_reader.join().unwrap_or_default()).into_owned();
    match status {
        Some(s) => Ok((s.success(), stdout, stderr)),
        None => Err(format!(
            "{bin} did not answer within {}s — the print server may be unreachable",
            RUN_TIMEOUT.as_secs()
        )),
    }
}

/// The message an action reports when the tool ran but refused. CUPS says what
/// it means on stderr ("Forbidden", "Operation was not allowed") and that text
/// is the one thing the user can act on, so it is passed through rather than
/// replaced with a generic failure.
fn action_error(bin: &str, ok: bool, out: String, err: String) -> Result<(), String> {
    if ok {
        return Ok(());
    }
    let msg = err.trim();
    let msg = if msg.is_empty() { out.trim() } else { msg };
    Err(if msg.is_empty() {
        format!("{bin} failed")
    } else {
        msg.to_string()
    })
}

/// Printer names come from the frontend, which got them from us — but a
/// destination can also be typed into the CUPS default field, and the Windows
/// backend interpolates the name into a *script*. So the shape is checked once,
/// here, before any of that: printable, no quotes/backticks/`$`/`;`/newlines,
/// bounded length. CUPS itself forbids space, `/` and `#` in a queue name;
/// Windows printer names routinely contain spaces, so space is allowed and the
/// stricter CUPS rule is left to CUPS.
fn check_printer_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > 128 {
        return Err("that is not a printer name".into());
    }
    let bad = |c: char| {
        c.is_control()
            || matches!(
                c,
                '\'' | '"' | '`' | '$' | ';' | '|' | '&' | '\\' | '<' | '>'
            )
    };
    if name.chars().any(bad) {
        return Err("that is not a printer name".into());
    }
    Ok(())
}

/// A CUPS job id (`Printer-42`) or a bare number, as handed back from a
/// snapshot. Same argument as [`check_printer_name`], same closed shape.
fn check_job_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 160 {
        return Err("that is not a job id".into());
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '@'))
    {
        return Err("that is not a job id".into());
    }
    Ok(())
}

// ── CUPS parsers (pure) ──────────────────────────────────────────────────────

/// Parse `lpstat -l -p` (English). Header lines look like
/// `printer Office is idle.  enabled since …`, followed by indented detail
/// lines; a stopped printer's header ends in `-` and carries its reason on the
/// next indented line.
pub fn parse_lpstat_printers(out: &str) -> Vec<PrinterInfo> {
    let mut printers: Vec<PrinterInfo> = Vec::new();
    // Set after a `disabled since … -` header: the next unlabelled indented
    // line is that printer's reason, not scenery.
    let mut expect_reason = false;

    for line in out.lines() {
        if let Some(rest) = line.strip_prefix("printer ") {
            expect_reason = false;
            let mut it = rest.splitn(2, ' ');
            let name = it.next().unwrap_or("").trim().to_string();
            if name.is_empty() {
                continue;
            }
            let tail = it.next().unwrap_or("");
            let lower = tail.to_ascii_lowercase();
            let state = if lower.contains("disabled") {
                "stopped"
            } else if lower.contains("printing") {
                "printing"
            } else if lower.contains("is idle") {
                "idle"
            } else {
                "unknown"
            };
            // `… since <date> -` means the reason follows on its own line.
            expect_reason = tail.trim_end().ends_with('-');
            printers.push(PrinterInfo {
                name,
                state: state.to_string(),
                // Absent an `lpstat -a` reading, assume the queue accepts —
                // that is the overwhelmingly common case and the accepting
                // pass overwrites it when it succeeds.
                accepting: true,
                ..Default::default()
            });
            continue;
        }
        if !line.starts_with([' ', '\t']) {
            expect_reason = false;
            continue;
        }
        let Some(current) = printers.last_mut() else {
            continue;
        };
        let body = line.trim();
        if body.is_empty() {
            continue;
        }
        if let Some(value) = body.strip_prefix("Description:") {
            current.description = value.trim().to_string();
        } else if let Some(value) = body.strip_prefix("Location:") {
            current.location = value.trim().to_string();
        } else if expect_reason {
            current.state_message = body.to_string();
            expect_reason = false;
        }
    }
    printers
}

/// Parse `lpstat -d`: `system default destination: Office`, or a line saying
/// there is none.
pub fn parse_lpstat_default(out: &str) -> Option<String> {
    out.lines()
        .find_map(|line| line.split_once("destination:"))
        .map(|(_, name)| name.trim().to_string())
        .filter(|name| !name.is_empty())
}

/// Parse `lpstat -a`: `Office accepting requests since …` /
/// `Office not accepting requests since …`.
pub fn parse_lpstat_accepting(out: &str) -> HashMap<String, bool> {
    let mut map = HashMap::new();
    for line in out.lines() {
        let Some((name, rest)) = line.trim_end().split_once(' ') else {
            continue;
        };
        if !rest.contains("accepting requests") {
            continue;
        }
        map.insert(name.to_string(), !rest.trim_start().starts_with("not "));
    }
    map
}

/// Parse `lpstat -o`:
/// `Office-42   florian   14336   Mon 28 Jul 2026 09:12:00 AM CEST`.
///
/// Split on whitespace for the first three fields only — the timestamp contains
/// spaces and is kept whole, because re-formatting a locale-formatted date is a
/// second thing to get wrong for no gain.
pub fn parse_lpstat_jobs(out: &str) -> Vec<PrintJob> {
    let mut jobs = Vec::new();
    for line in out.lines() {
        if line.starts_with([' ', '\t']) || line.trim().is_empty() {
            continue;
        }
        let mut it = line.split_whitespace();
        let (Some(id), Some(user), Some(size)) = (it.next(), it.next(), it.next()) else {
            continue;
        };
        let Ok(size_bytes) = size.parse::<u64>() else {
            continue; // Not a job line (a heading, an error message).
        };
        let (printer, number) = split_cups_job_id(id);
        jobs.push(PrintJob {
            id: id.to_string(),
            number,
            printer,
            user: user.to_string(),
            title: String::new(),
            size_bytes,
            submitted: it.collect::<Vec<_>>().join(" "),
            state: "pending".to_string(),
        });
    }
    jobs
}

/// `Office-42` → (`Office`, 42). A printer name may itself contain `-`, so the
/// split is on the LAST one, and only when what follows is a number.
fn split_cups_job_id(id: &str) -> (String, u32) {
    match id.rsplit_once('-') {
        Some((printer, num)) => match num.parse::<u32>() {
            Ok(n) => (printer.to_string(), n),
            Err(_) => (id.to_string(), 0),
        },
        None => (id.to_string(), 0),
    }
}

/// What `lpq -a` adds that `lpstat -o` cannot: the document name, and whether a
/// job is the active one. Returns job number → (title, state).
///
/// The file column can contain spaces, so the line is parsed from BOTH ends:
/// rank/owner/job from the left, `<n> bytes` from the right, and everything
/// between is the document name.
pub fn parse_lpq_titles(out: &str) -> HashMap<u32, (String, String)> {
    let mut map = HashMap::new();
    for line in out.lines() {
        let line = line.trim_end();
        if line.trim().is_empty() || line.starts_with("Rank") {
            continue;
        }
        let mut it = line.split_whitespace();
        let (Some(rank), Some(_owner), Some(job)) = (it.next(), it.next(), it.next()) else {
            continue;
        };
        let Ok(number) = job.parse::<u32>() else {
            continue; // A status line ("Office is ready and printing").
        };
        // Strip the trailing "<size> bytes" to leave the file column.
        let rest: Vec<&str> = it.collect();
        let title = match rest.split_last() {
            Some((last, head)) if last.eq_ignore_ascii_case("bytes") => match head.split_last() {
                Some((_size, name)) => name.join(" "),
                None => String::new(),
            },
            _ => rest.join(" "),
        };
        let state = match rank.to_ascii_lowercase().as_str() {
            "active" => "printing",
            "hold" | "held" => "held",
            _ => "pending",
        };
        map.insert(number, (title, state.to_string()));
    }
    map
}

/// Join the two CUPS readings: titles and the active/held state come from
/// `lpq`, everything else from `lpstat`. A job `lpq` never mentioned keeps its
/// id as a title, so no row is blank.
fn merge_cups_jobs(
    mut jobs: Vec<PrintJob>,
    titles: &HashMap<u32, (String, String)>,
) -> Vec<PrintJob> {
    for job in &mut jobs {
        if let Some((title, state)) = titles.get(&job.number) {
            if !title.is_empty() {
                job.title = title.clone();
            }
            job.state = state.clone();
        }
        if job.title.is_empty() {
            job.title = job.id.clone();
        }
    }
    jobs
}

// ── CUPS backend ─────────────────────────────────────────────────────────────

#[cfg(not(target_os = "windows"))]
fn snapshot_impl() -> PrintSnapshot {
    if !crate::paths::binary_on_path("lpstat") {
        return PrintSnapshot {
            supported: false,
            backend: "none".into(),
            note: "no CUPS tooling found on this machine (lpstat is not on PATH)".into(),
            ..Default::default()
        };
    }

    let mut note = String::new();
    let mut printers = match run_capped("lpstat", &["-l", "-p"]) {
        // `lpstat -p` exits non-zero when there are simply no printers, so the
        // exit status is deliberately not consulted — the output is.
        Ok((_, out, err)) => {
            if out.trim().is_empty() && !err.trim().is_empty() {
                note = err.trim().to_string();
            }
            parse_lpstat_printers(&out)
        }
        Err(e) => {
            return PrintSnapshot {
                supported: true,
                backend: "cups".into(),
                note: e,
                ..Default::default()
            }
        }
    };

    let default_printer = run_capped("lpstat", &["-d"])
        .ok()
        .and_then(|(_, out, _)| parse_lpstat_default(&out));
    if let Some(name) = default_printer.as_deref() {
        for p in &mut printers {
            p.is_default = p.name == name;
        }
    }

    if let Ok((_, out, _)) = run_capped("lpstat", &["-a"]) {
        let accepting = parse_lpstat_accepting(&out);
        for p in &mut printers {
            if let Some(&ok) = accepting.get(&p.name) {
                p.accepting = ok;
            }
        }
    }

    let jobs = match run_capped("lpstat", &["-o"]) {
        Ok((_, out, _)) => {
            let titles = run_capped("lpq", &["-a"])
                .map(|(_, lpq, _)| parse_lpq_titles(&lpq))
                .unwrap_or_default();
            merge_cups_jobs(parse_lpstat_jobs(&out), &titles)
        }
        Err(e) => {
            note = e;
            Vec::new()
        }
    };

    PrintSnapshot {
        supported: true,
        backend: "cups".into(),
        default_printer,
        printers,
        jobs,
        note,
    }
}

#[cfg(not(target_os = "windows"))]
fn cancel_job_impl(_printer: &str, job_id: &str) -> Result<(), String> {
    check_job_id(job_id)?;
    let (ok, out, err) = run_capped("cancel", &[job_id])?;
    action_error("cancel", ok, out, err)
}

#[cfg(not(target_os = "windows"))]
fn cancel_all_impl(printer: &str) -> Result<(), String> {
    check_printer_name(printer)?;
    let (ok, out, err) = run_capped("cancel", &["-a", printer])?;
    action_error("cancel", ok, out, err)
}

#[cfg(not(target_os = "windows"))]
fn set_default_impl(printer: &str) -> Result<(), String> {
    check_printer_name(printer)?;
    // `lpoptions -d` sets the *user's* default (~/.cups/lpoptions), which needs
    // no admin rights — deliberately not `lpadmin -d`, which sets it for the
    // whole machine and would ask for a password Eldrun has no business asking.
    let (ok, out, err) = run_capped("lpoptions", &["-d", printer])?;
    action_error("lpoptions", ok, out, err)
}

#[cfg(not(target_os = "windows"))]
fn set_enabled_impl(printer: &str, enabled: bool) -> Result<(), String> {
    check_printer_name(printer)?;
    let bin = if enabled { "cupsenable" } else { "cupsdisable" };
    let (ok, out, err) = run_capped(bin, &[printer])?;
    action_error(bin, ok, out, err)
}

#[cfg(not(target_os = "windows"))]
fn print_file_impl(printer: &str, path: &str, title: &str) -> Result<(), String> {
    check_printer_name(printer)?;
    let (ok, out, err) = run_capped("lp", &["-d", printer, "-t", title, path])?;
    action_error("lp", ok, out, err)
}

// ── Windows backend ──────────────────────────────────────────────────────────

/// Single-quote a value for a PowerShell literal string. [`check_printer_name`]
/// has already refused `'` (and everything else that makes quoting delicate), so
/// this is the second of two gates, not the only one.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn ps_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// Run a PowerShell script and hand back stdout. `-NoProfile` so a user profile
/// can neither slow the probe down nor print into the JSON we are about to
/// parse.
#[cfg(target_os = "windows")]
fn run_powershell(script: &str) -> Result<(bool, String, String), String> {
    run_capped(
        "powershell",
        &[
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ],
    )
}

/// `Get-Printer`'s `PrinterStatus` / `Get-PrintJob`'s `JobStatus` are flag
/// enums serialized as text; map the ones that mean something to the same closed
/// set the CUPS side produces, and let everything else be `unknown`.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn windows_printer_state(status: &str) -> &'static str {
    let s = status.to_ascii_lowercase();
    if s.contains("error") || s.contains("offline") || s.contains("paused") {
        "stopped"
    } else if s.contains("printing") || s.contains("processing") {
        "printing"
    } else if s.contains("normal") || s.contains("idle") {
        "idle"
    } else {
        "unknown"
    }
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn windows_job_state(status: &str) -> &'static str {
    let s = status.to_ascii_lowercase();
    if s.contains("paused") {
        "held"
    } else if s.contains("printing") || s.contains("spooling") {
        "printing"
    } else if s.is_empty() {
        "unknown"
    } else {
        "pending"
    }
}

/// PowerShell's `ConvertTo-Json` collapses a one-element array into a bare
/// object, so every list is read through this rather than as an array.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn json_rows(value: Option<&serde_json::Value>) -> Vec<serde_json::Value> {
    match value {
        Some(serde_json::Value::Array(items)) => items.clone(),
        Some(serde_json::Value::Object(_)) => vec![value.cloned().unwrap_or_default()],
        _ => Vec::new(),
    }
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn json_str(row: &serde_json::Value, key: &str) -> String {
    row.get(key)
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .trim()
        .to_string()
}

/// Parse the one JSON document the Windows probe returns. Kept separate from
/// the spawn so it is testable on any OS — Windows is CI-verified only here, so
/// the shape must at least be pinned by a test that runs everywhere.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn parse_windows_snapshot(json: &str) -> Result<PrintSnapshot, String> {
    let root: serde_json::Value =
        serde_json::from_str(json.trim()).map_err(|e| format!("print system: {e}"))?;
    let default_printer = root
        .get("default")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let printers = json_rows(root.get("printers"))
        .iter()
        .map(|row| {
            let name = json_str(row, "Name");
            PrinterInfo {
                is_default: default_printer.as_deref() == Some(name.as_str()),
                state: windows_printer_state(&json_str(row, "PrinterStatus")).to_string(),
                description: json_str(row, "Comment"),
                location: json_str(row, "Location"),
                state_message: String::new(),
                // Windows has no "not accepting" queue state of its own; a
                // paused printer is reported through PrinterStatus above.
                accepting: true,
                name,
            }
        })
        .filter(|p| !p.name.is_empty())
        .collect();

    let jobs = json_rows(root.get("jobs"))
        .iter()
        .map(|row| {
            let number = row.get("Id").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            let title = json_str(row, "DocumentName");
            PrintJob {
                id: number.to_string(),
                number,
                printer: json_str(row, "PrinterName"),
                user: json_str(row, "UserName"),
                size_bytes: row.get("Size").and_then(|v| v.as_u64()).unwrap_or(0),
                submitted: json_str(row, "SubmittedTime"),
                state: windows_job_state(&json_str(row, "JobStatus")).to_string(),
                title: if title.is_empty() {
                    number.to_string()
                } else {
                    title
                },
            }
        })
        .collect();

    Ok(PrintSnapshot {
        supported: true,
        backend: "windows".into(),
        default_printer,
        printers,
        jobs,
        note: String::new(),
    })
}

#[cfg(target_os = "windows")]
const WINDOWS_SNAPSHOT_SCRIPT: &str = "\
$ErrorActionPreference='SilentlyContinue';\
$p=@(Get-Printer | Select-Object Name,Comment,Location,PrinterStatus);\
$j=@(Get-Printer | Get-PrintJob | Select-Object Id,PrinterName,UserName,DocumentName,JobStatus,Size,SubmittedTime);\
$d=(Get-CimInstance Win32_Printer -Filter 'Default=True' | Select-Object -First 1).Name;\
[pscustomobject]@{printers=$p;jobs=$j;default=$d} | ConvertTo-Json -Depth 4 -Compress";

#[cfg(target_os = "windows")]
fn snapshot_impl() -> PrintSnapshot {
    match run_powershell(WINDOWS_SNAPSHOT_SCRIPT) {
        Ok((_, out, err)) if !out.trim().is_empty() => match parse_windows_snapshot(&out) {
            Ok(snap) => snap,
            Err(e) => PrintSnapshot {
                supported: true,
                backend: "windows".into(),
                note: if err.trim().is_empty() {
                    e
                } else {
                    err.trim().into()
                },
                ..Default::default()
            },
        },
        Ok((_, _, err)) => PrintSnapshot {
            supported: false,
            backend: "none".into(),
            note: if err.trim().is_empty() {
                "the Windows print spooler reported nothing".into()
            } else {
                err.trim().to_string()
            },
            ..Default::default()
        },
        Err(e) => PrintSnapshot {
            supported: false,
            backend: "none".into(),
            note: e,
            ..Default::default()
        },
    }
}

#[cfg(target_os = "windows")]
fn cancel_job_impl(printer: &str, job_id: &str) -> Result<(), String> {
    check_printer_name(printer)?;
    check_job_id(job_id)?;
    let script = format!(
        "Remove-PrintJob -PrinterName {} -ID {}",
        ps_quote(printer),
        ps_quote(job_id)
    );
    let (ok, out, err) = run_powershell(&script)?;
    action_error("Remove-PrintJob", ok, out, err)
}

#[cfg(target_os = "windows")]
fn cancel_all_impl(printer: &str) -> Result<(), String> {
    check_printer_name(printer)?;
    let script = format!(
        "Get-PrintJob -PrinterName {0} | Remove-PrintJob",
        ps_quote(printer)
    );
    let (ok, out, err) = run_powershell(&script)?;
    action_error("Remove-PrintJob", ok, out, err)
}

#[cfg(target_os = "windows")]
fn set_default_impl(printer: &str) -> Result<(), String> {
    check_printer_name(printer)?;
    let script = format!(
        "$p=Get-CimInstance Win32_Printer -Filter (\"Name='\" + {0}.Replace(\"'\",\"''\") + \"'\"); \
         Invoke-CimMethod -InputObject $p -MethodName SetDefaultPrinter",
        ps_quote(printer)
    );
    let (ok, out, err) = run_powershell(&script)?;
    action_error("SetDefaultPrinter", ok, out, err)
}

#[cfg(target_os = "windows")]
fn set_enabled_impl(printer: &str, enabled: bool) -> Result<(), String> {
    check_printer_name(printer)?;
    let method = if enabled { "Resume" } else { "Pause" };
    let script = format!(
        "$p=Get-CimInstance Win32_Printer -Filter (\"Name='\" + {0}.Replace(\"'\",\"''\") + \"'\"); \
         Invoke-CimMethod -InputObject $p -MethodName {1}",
        ps_quote(printer),
        method
    );
    let (ok, out, err) = run_powershell(&script)?;
    action_error(method, ok, out, err)
}

#[cfg(target_os = "windows")]
fn print_file_impl(printer: &str, path: &str, _title: &str) -> Result<(), String> {
    check_printer_name(printer)?;
    let script = format!(
        "Get-Content -LiteralPath {0} | Out-Printer -Name {1}",
        ps_quote(path),
        ps_quote(printer)
    );
    let (ok, out, err) = run_powershell(&script)?;
    action_error("Out-Printer", ok, out, err)
}

// ── Tauri surface ────────────────────────────────────────────────────────────

/// One reading of the machine's print system. Async + `spawn_blocking`: every
/// probe below shells out, and a synchronous command would run the whole thing
/// on the main thread — which is how a printer behind a dead VPN freezes the
/// window rather than showing a message in a pane.
#[tauri::command]
pub async fn print_system_snapshot() -> PrintSnapshot {
    tauri::async_runtime::spawn_blocking(snapshot_impl)
        .await
        .unwrap_or_else(|e| PrintSnapshot {
            supported: false,
            backend: "none".into(),
            note: format!("the print system probe did not finish: {e}"),
            ..Default::default()
        })
}

/// Cancel one job. `printer` is only read by the Windows backend (its API needs
/// the queue as well as the id); CUPS cancels by id alone.
#[tauri::command]
pub async fn print_job_cancel(printer: String, job_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || cancel_job_impl(&printer, &job_id))
        .await
        .map_err(|e| e.to_string())?
}

/// Cancel everything queued on one printer.
#[tauri::command]
pub async fn print_jobs_cancel_all(printer: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || cancel_all_impl(&printer))
        .await
        .map_err(|e| e.to_string())?
}

/// Make `printer` the default. On CUPS this is the *user's* default and needs no
/// elevation; on Windows it is the per-user default too.
#[tauri::command]
pub async fn print_set_default(printer: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || set_default_impl(&printer))
        .await
        .map_err(|e| e.to_string())?
}

/// Resume (`true`) or pause (`false`) a printer's queue. This is the one action
/// here that commonly needs rights the user may not have — CUPS answers
/// "Forbidden" for a user outside `lpadmin` — so the error text is passed
/// through verbatim for the pane to show.
#[tauri::command]
pub async fn print_set_enabled(printer: String, enabled: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || set_enabled_impl(&printer, enabled))
        .await
        .map_err(|e| e.to_string())?
}

/// Send a small text page to `printer`, so "is this thing actually connected?"
/// has an answer that does not involve finding a document first.
///
/// The page is written by Eldrun into the OS temp dir rather than taken from a
/// path the frontend supplies: the print manager deliberately has no
/// print-this-file command at all, so no caller can turn it into one.
#[tauri::command]
pub async fn print_test_page(printer: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        check_printer_name(&printer)?;
        let body = format!(
            "Eldrun print test\n\n\
             Printer: {printer}\n\
             If you are reading this on paper, the queue works.\n"
        );
        let path = std::env::temp_dir().join("eldrun-print-test.txt");
        std::fs::write(&path, body).map_err(|e| format!("test page: {e}"))?;
        let path_str = path.to_string_lossy().into_owned();
        print_file_impl(&printer, &path_str, "Eldrun print test")
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    const LPSTAT_P: &str = "\
printer Office_Laser is idle.  enabled since Mon 28 Jul 2026 09:12:00 AM CEST
\tDescription: Office laser, 2nd floor
\tLocation: Room 2.14
\tConnection: direct
printer Old_Inkjet disabled since Mon 28 Jul 2026 08:00:00 AM CEST -
\t(paused by the administrator)
\tDescription: Ancient inkjet
printer Lab-Plotter now printing Lab-Plotter-7.  enabled since Mon 28 Jul 2026 09:30:00 AM CEST
";

    #[test]
    fn lpstat_printers_reads_state_description_and_reason() {
        let printers = parse_lpstat_printers(LPSTAT_P);
        assert_eq!(printers.len(), 3);

        assert_eq!(printers[0].name, "Office_Laser");
        assert_eq!(printers[0].state, "idle");
        assert_eq!(printers[0].description, "Office laser, 2nd floor");
        assert_eq!(printers[0].location, "Room 2.14");
        assert_eq!(printers[0].state_message, "");

        assert_eq!(printers[1].name, "Old_Inkjet");
        assert_eq!(printers[1].state, "stopped");
        // The reason line belongs to the printer whose header ended in `-` …
        assert_eq!(printers[1].state_message, "(paused by the administrator)");
        // … and a labelled line after it is still read as a field.
        assert_eq!(printers[1].description, "Ancient inkjet");

        assert_eq!(printers[2].name, "Lab-Plotter");
        assert_eq!(printers[2].state, "printing");
    }

    #[test]
    fn lpstat_default_is_optional() {
        assert_eq!(
            parse_lpstat_default("system default destination: Office_Laser\n").as_deref(),
            Some("Office_Laser")
        );
        assert_eq!(
            parse_lpstat_default("no system default destination\n"),
            None
        );
        assert_eq!(parse_lpstat_default(""), None);
    }

    #[test]
    fn lpstat_accepting_distinguishes_not_accepting() {
        let map = parse_lpstat_accepting(
            "Office_Laser accepting requests since Mon 28 Jul 2026 09:12:00 AM CEST\n\
             Old_Inkjet not accepting requests since Mon 28 Jul 2026 08:00:00 AM CEST\n",
        );
        assert_eq!(map.get("Office_Laser"), Some(&true));
        assert_eq!(map.get("Old_Inkjet"), Some(&false));
    }

    #[test]
    fn lpstat_jobs_keeps_the_timestamp_whole() {
        let jobs = parse_lpstat_jobs(
            "Office_Laser-42       florian      14336   Mon 28 Jul 2026 09:12:00 AM CEST\n\
             Lab-Plotter-7         ada           4096   Mon 28 Jul 2026 09:30:00 AM CEST\n",
        );
        assert_eq!(jobs.len(), 2);
        assert_eq!(jobs[0].id, "Office_Laser-42");
        assert_eq!(jobs[0].number, 42);
        assert_eq!(jobs[0].printer, "Office_Laser");
        assert_eq!(jobs[0].user, "florian");
        assert_eq!(jobs[0].size_bytes, 14336);
        assert_eq!(jobs[0].submitted, "Mon 28 Jul 2026 09:12:00 AM CEST");
        // A printer name containing '-' still splits on the LAST one.
        assert_eq!(jobs[1].printer, "Lab-Plotter");
        assert_eq!(jobs[1].number, 7);
    }

    #[test]
    fn lpstat_jobs_ignores_non_job_lines() {
        assert!(parse_lpstat_jobs("lpstat: Error - no default destination\n").is_empty());
        assert!(parse_lpstat_jobs("").is_empty());
    }

    #[test]
    fn lpq_titles_survive_spaces_in_the_file_name() {
        let map = parse_lpq_titles(
            "Office_Laser is ready and printing\n\
             Rank    Owner   Job     File(s)                         Total Size\n\
             active  florian 42      quarterly report final.pdf      14336 bytes\n\
             1st     ada     7       notes.txt                       4096 bytes\n",
        );
        assert_eq!(
            map.get(&42),
            Some(&(
                "quarterly report final.pdf".to_string(),
                "printing".to_string()
            ))
        );
        assert_eq!(
            map.get(&7),
            Some(&("notes.txt".to_string(), "pending".to_string()))
        );
    }

    #[test]
    fn merge_falls_back_to_the_id_rather_than_a_blank_title() {
        let jobs = parse_lpstat_jobs(
            "Office_Laser-42   florian   14336   Mon 28 Jul 2026 09:12:00 AM CEST\n",
        );
        let merged = merge_cups_jobs(jobs, &HashMap::new());
        assert_eq!(merged[0].title, "Office_Laser-42");
        assert_eq!(merged[0].state, "pending");
    }

    #[test]
    fn names_and_ids_that_could_reach_a_shell_are_refused() {
        assert!(check_printer_name("Office_Laser").is_ok());
        assert!(check_printer_name("HP LaserJet 400").is_ok()); // Windows names have spaces
        assert!(check_printer_name("").is_err());
        assert!(check_printer_name("a'; rm -rf ~; '").is_err());
        assert!(check_printer_name("back`tick`").is_err());
        assert!(check_printer_name(&"x".repeat(200)).is_err());

        assert!(check_job_id("Office_Laser-42").is_ok());
        assert!(check_job_id("42").is_ok());
        assert!(check_job_id("42; reboot").is_err());
    }

    #[test]
    fn ps_quote_doubles_single_quotes() {
        assert_eq!(ps_quote("plain"), "'plain'");
        assert_eq!(ps_quote("it's"), "'it''s'");
    }

    #[test]
    fn windows_snapshot_reads_a_one_element_list_as_a_list() {
        // ConvertTo-Json collapses a single-element array into a bare object;
        // both shapes must read as one printer and one job.
        let snap = parse_windows_snapshot(
            r#"{"printers":{"Name":"HP LaserJet","Comment":"Front desk","Location":"Hall","PrinterStatus":"Normal"},
                "jobs":{"Id":3,"PrinterName":"HP LaserJet","UserName":"ada","DocumentName":"report.pdf","JobStatus":"Printing","Size":2048,"SubmittedTime":"2026-07-28T09:12:00"},
                "default":"HP LaserJet"}"#,
        )
        .expect("parses");
        assert_eq!(snap.printers.len(), 1);
        assert_eq!(snap.printers[0].name, "HP LaserJet");
        assert_eq!(snap.printers[0].state, "idle");
        assert!(snap.printers[0].is_default);
        assert_eq!(snap.jobs.len(), 1);
        assert_eq!(snap.jobs[0].id, "3");
        assert_eq!(snap.jobs[0].title, "report.pdf");
        assert_eq!(snap.jobs[0].state, "printing");
        assert_eq!(snap.default_printer.as_deref(), Some("HP LaserJet"));
    }

    #[test]
    fn windows_states_degrade_to_unknown_never_to_healthy() {
        assert_eq!(windows_printer_state("Normal"), "idle");
        assert_eq!(windows_printer_state("Printing"), "printing");
        assert_eq!(windows_printer_state("Offline"), "stopped");
        assert_eq!(windows_printer_state("Paused, Error"), "stopped");
        assert_eq!(windows_printer_state("Whatever-Is-New"), "unknown");
        assert_eq!(windows_job_state("Paused"), "held");
        assert_eq!(windows_job_state(""), "unknown");
    }
}
