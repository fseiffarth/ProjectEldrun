//! LaTeX viewing / compilation support.
//!
//! The compile affordance is surfaced in the file tree only when a TeX engine
//! is found on `PATH` — the frontend gates its menu items on `tex_capability`.
//! `compile_tex` runs the chosen engine in the source file's own directory so
//! the `.aux`/`.pdf`/log artefacts land beside the source, and prefers
//! `latexmk` (which drives bibtex + the needed reruns itself) when present.
//! Without `latexmk` it falls back to running the engine directly, slotting a
//! `bibtex` pass in between runs when the generated `.aux` shows citations.

use std::fs;
use std::path::Path;
use std::process::Stdio;

use serde::Serialize;

/// Engines we know how to drive, in preference order. Each is a `pdf`-producing
/// LaTeX engine invoked the same way (`<engine> -interaction=nonstopmode …`).
const ENGINES: &[&str] = &["pdflatex", "lualatex", "xelatex"];

/// Which TeX tools are available locally. When `available` is false the
/// frontend hides the compile affordance entirely.
#[derive(Debug, Clone, Serialize, Default)]
pub struct TexCapability {
    /// True when at least one engine (or `latexmk`) is on `PATH`.
    pub available: bool,
    /// The subset of `ENGINES` found on `PATH`.
    pub engines: Vec<String>,
    /// Whether `bibtex` is on `PATH` (used for bibliography passes).
    pub bibtex: bool,
    /// Whether `latexmk` is on `PATH` (preferred build driver).
    pub latexmk: bool,
}

/// Outcome of a `compile_tex` run.
#[derive(Debug, Clone, Serialize)]
pub struct TexCompileResult {
    /// True when the build finished and a PDF exists on disk.
    pub success: bool,
    /// Absolute path to the produced PDF, when one was written.
    pub pdf_path: Option<String>,
    /// Human-readable description of the engine/driver used.
    pub engine: String,
    /// Tail of the combined stdout/stderr, for surfacing errors in the UI.
    pub log: String,
    /// True when the build log shows shell-escape (`\write18`) ran unrestricted
    /// or actually executed an external command. We never pass `-shell-escape`
    /// ourselves, so this only trips when a system `texmf.cnf` / `latexmkrc`
    /// turned it on behind our back — surfaced as a warning in the UI.
    pub shell_escape: bool,
}

/// A source location returned by SyncTeX reverse search (`synctex edit`): the
/// input `.tex` file plus 1-based line/column that produced a clicked PDF point.
#[derive(Debug, Clone, Serialize)]
pub struct SyncSource {
    /// Absolute path to the source file.
    pub input: String,
    /// 1-based source line.
    pub line: u32,
    /// 1-based source column (0 when SyncTeX did not report one).
    pub column: u32,
}

/// A PDF rectangle returned by SyncTeX forward search (`synctex view`): the page
/// and a box (big points, 72 dpi, origin at the page's top-left) the viewer can
/// scroll to and highlight.
#[derive(Debug, Clone, Serialize)]
pub struct SyncRect {
    /// 1-based PDF page.
    pub page: u32,
    /// Left edge in big points from the page's top-left.
    pub x: f64,
    /// Top edge in big points from the page's top-left.
    pub y: f64,
    /// Box width in big points.
    pub w: f64,
    /// Box height in big points.
    pub h: f64,
}

/// True if `bin` resolves on `PATH`. Uses the shared cross-platform probe so the
/// TeX toolchain is detected on Windows too (where `which` does not exist).
fn on_path(bin: &str) -> bool {
    crate::paths::binary_on_path(bin)
}

/// Probe `PATH` for the TeX toolchain. Cheap enough to call on demand.
pub fn detect_capability() -> TexCapability {
    let engines: Vec<String> = ENGINES
        .iter()
        .filter(|e| on_path(e))
        .map(|e| e.to_string())
        .collect();
    let latexmk = on_path("latexmk");
    TexCapability {
        available: latexmk || !engines.is_empty(),
        bibtex: on_path("bibtex"),
        latexmk,
        engines,
    }
}

#[tauri::command]
pub fn tex_capability() -> TexCapability {
    detect_capability()
}

struct RunOut {
    ok: bool,
    text: String,
}

/// How long a single TeX/bibtex invocation may run before it is killed.
///
/// `compile_tex` is a **synchronous** command, so a run that never returns holds
/// a Tauri worker thread for the rest of the session and the frontend has no way
/// to abort it — the deck editor and the TeX viewer both just sit on a spinner.
/// `-interaction=nonstopmode` already rules out the classic prompt-for-input
/// hang; what is left is a genuinely pathological document (a runaway macro, a
/// `\loop` with no exit), and for that a ceiling is the only defence. Ten minutes
/// is far beyond any healthy build, including a first run that is downloading
/// packages on MiKTeX.
const RUN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(600);

/// Run `bin args…` with `dir` as the working directory, capturing stdout+stderr.
/// Spawned via `command_no_window` so MiKTeX's console tools (engine, `bibtex`,
/// `synctex`) don't flash a console window per invocation on Windows.
///
/// Killed after {@link RUN_TIMEOUT}. The output is read on a worker thread rather
/// than with `output()` so the wait can time out at all: `output()` blocks until
/// the pipes close, which a wedged child never does.
fn run_in<S: AsRef<std::ffi::OsStr>>(dir: &Path, bin: &str, args: &[S]) -> Result<RunOut, String> {
    let mut child = crate::paths::command_no_window(bin)
        .args(args)
        .current_dir(dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("run {bin}: {e}"))?;

    // Drain both pipes on their own threads. A child that fills a pipe buffer
    // deadlocks if nobody is reading, which would make the timeout fire on
    // perfectly healthy builds with a lot of log output.
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

    let deadline = std::time::Instant::now() + RUN_TIMEOUT;
    let status = loop {
        match child.try_wait().map_err(|e| format!("wait {bin}: {e}"))? {
            Some(s) => break Some(s),
            None if std::time::Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            None => std::thread::sleep(std::time::Duration::from_millis(50)),
        }
    };

    let mut text = String::from_utf8_lossy(&out_reader.join().unwrap_or_default()).into_owned();
    text.push_str(&String::from_utf8_lossy(
        &err_reader.join().unwrap_or_default(),
    ));

    match status {
        Some(s) => Ok(RunOut {
            ok: s.success(),
            text,
        }),
        None => {
            text.push_str(&format!(
                "\n! Eldrun stopped {bin} after {} seconds — the build appears to be stuck.\n",
                RUN_TIMEOUT.as_secs()
            ));
            Ok(RunOut { ok: false, text })
        }
    }
}

/// True when the `.aux` references a bibliography (so a `bibtex` pass is wanted).
fn aux_needs_bibtex(aux: &Path) -> bool {
    fs::read_to_string(aux)
        .map(|s| s.contains("\\citation") || s.contains("\\bibdata"))
        .unwrap_or(false)
}

/// Keep only the last `MAX` bytes of the build log (on a char boundary), so the
/// UI gets the tail where TeX errors actually appear without shipping megabytes.
fn tail(log: &str) -> String {
    const MAX: usize = 8000;
    if log.len() <= MAX {
        return log.to_string();
    }
    let mut start = log.len() - MAX;
    while start < log.len() && !log.is_char_boundary(start) {
        start += 1;
    }
    format!("…\n{}", &log[start..])
}

/// The latexmk flag that selects `engine`'s pdf mode.
fn latexmk_flag(engine: Option<&str>) -> &'static str {
    match engine {
        Some("lualatex") => "-pdflua",
        Some("xelatex") => "-pdfxe",
        _ => "-pdf", // pdflatex (latexmk default)
    }
}

/// SECURITY: reject any user-supplied extra flag that could turn on shell-escape
/// (`\write18`) — compiling untrusted `.tex` must never let document macros run
/// shell commands. We strip not just `-shell-escape`/`-enable-write18` but any
/// flag whose text mentions shell-escape / write18 (covers `-shell-escape`,
/// `--shell-escape`, `-enable-write18`, `-shell-restricted` toggles writing,
/// engine `-output-directory` variants are allowed separately). Guarded by
/// `compile_args_never_enable_shell_escape` / `filter_extra_flags_strips_shell_escape`.
fn flag_enables_shell_escape(arg: &str) -> bool {
    let a = arg.to_ascii_lowercase();
    a.contains("shell-escape") || a.contains("shellescape") || a.contains("write18")
}

/// Filter user-supplied extra flags down to ones that can NEVER enable
/// shell-escape. Anything mentioning shell-escape / write18 is dropped silently.
fn filter_extra_flags(extra: &[String]) -> Vec<String> {
    extra
        .iter()
        .filter(|f| !flag_enables_shell_escape(f))
        .cloned()
        .collect()
}

/// Arguments for a `latexmk` build of `file_name` with `engine`. This is the
/// single source of truth for the latexmk invocation, and it deliberately omits
/// any shell-escape flag — compiling untrusted `.tex` must never let document
/// macros run shell commands (guarded by `compile_args_never_enable_shell_escape`).
///
/// `out_dir`, when set, becomes latexmk's `-outdir=<dir>` so artefacts (incl. the
/// PDF) land there. `extra` carries already-filtered user flags (#54).
fn latexmk_args(
    engine: Option<&str>,
    file_name: &str,
    out_dir: Option<&str>,
    extra: &[String],
) -> Vec<String> {
    let mut args: Vec<String> = vec![
        latexmk_flag(engine).to_string(),
        "-interaction=nonstopmode".to_string(),
        // Always emit SyncTeX data so the viewer can map between PDF positions
        // and source lines (forward/reverse search). Harmless when unused.
        "-synctex=1".to_string(),
        // Print errors as `file:line: message` so the viewer can parse error
        // locations and offer jump-to-error (vs. the default `l.NNN` form whose
        // file has to be inferred from log parenthesis nesting). latexmk passes
        // this through to the engine.
        "-file-line-error".to_string(),
    ];
    if let Some(dir) = out_dir {
        args.push(format!("-outdir={dir}"));
    }
    for f in extra {
        args.push(f.clone());
    }
    args.push(file_name.to_string());
    args
}

/// Arguments for driving a TeX engine directly on `file_name` (the no-latexmk
/// path). Same shell-escape invariant as `latexmk_args`. `out_dir` maps to the
/// engine's `-output-directory=<dir>`; `extra` carries filtered user flags.
fn engine_args(file_name: &str, out_dir: Option<&str>, extra: &[String]) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-interaction=nonstopmode".to_string(),
        "-halt-on-error".to_string(),
        // Emit SyncTeX data for forward/reverse search (see latexmk_args).
        "-synctex=1".to_string(),
        // `file:line: message` error format for jump-to-error (see latexmk_args).
        "-file-line-error".to_string(),
    ];
    if let Some(dir) = out_dir {
        args.push(format!("-output-directory={dir}"));
    }
    for f in extra {
        args.push(f.clone());
    }
    args.push(file_name.to_string());
    args
}

/// Scan a build log for evidence that shell-escape (`\write18`) was active in an
/// *unrestricted* way: either explicitly enabled (not the safe "restricted"
/// default that only allows a fixed whitelist) or an external command actually
/// executed. Used to warn when a system config enabled it despite our args.
fn log_shows_shell_escape(log: &str) -> bool {
    log.lines().any(|line| {
        let l = line.to_ascii_lowercase();
        (l.contains("write18 enabled") && !l.contains("restricted"))
            || (l.contains("runsystem(") && l.contains("executed"))
    })
}

/// Compile a `.tex`.
///
/// **`async` and off the UI thread, deliberately.** A *synchronous* Tauri command
/// runs on the main thread (see the note at `commands/credentials.rs`), so this
/// used to freeze the entire window for the duration of `latexmk` — which the
/// {@link RUN_TIMEOUT} above bounds at ten minutes. Every deck TeX-figure add,
/// every Recompile and every starter-deck generation paid that (TODO V #105).
/// `spawn_blocking` keeps the body's blocking process I/O legal on the async
/// runtime while the webview stays live.
#[tauri::command]
pub async fn compile_tex(
    path: String,
    engine: Option<String>,
    out_dir: Option<String>,
    extra_flags: Option<Vec<String>>,
) -> Result<TexCompileResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        compile_tex_blocking(path, engine, out_dir, extra_flags)
    })
    .await
    .map_err(|e| format!("compile task failed: {e}"))?
}

fn compile_tex_blocking(
    path: String,
    engine: Option<String>,
    out_dir: Option<String>,
    extra_flags: Option<Vec<String>>,
) -> Result<TexCompileResult, String> {
    let src = fs::canonicalize(&path).map_err(|e| format!("canonicalize {path}: {e}"))?;
    let is_tex = src
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("tex"))
        .unwrap_or(false);
    if !is_tex {
        return Err(format!("not a .tex file: {}", src.display()));
    }
    let dir = src
        .parent()
        .ok_or_else(|| "source file has no parent directory".to_string())?;
    let file_name = src
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "invalid file name".to_string())?;
    let stem = src
        .file_stem()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "invalid file name".to_string())?
        .to_string();

    let cap = detect_capability();
    if !cap.available {
        return Err("no TeX engine found on PATH".to_string());
    }

    // Resolve the optional output directory: a relative path is taken against the
    // source's directory, an absolute one is used as-is. Created if missing so the
    // engine can write into it. The PDF then lands there (not beside the source),
    // so `pdf_path` points into it.
    let out_dir = out_dir.and_then(|d| {
        let d = d.trim().to_string();
        if d.is_empty() {
            None
        } else {
            Some(d)
        }
    });
    let out_path = match &out_dir {
        Some(d) => {
            let p = Path::new(d);
            let abs = if p.is_absolute() {
                p.to_path_buf()
            } else {
                dir.join(p)
            };
            fs::create_dir_all(&abs)
                .map_err(|e| format!("create output dir {}: {e}", abs.display()))?;
            Some(abs)
        }
        None => None,
    };
    // The string form passed to the engine/latexmk flags.
    let out_arg = out_path.as_ref().map(|p| p.to_string_lossy().into_owned());

    // SECURITY: filter user-supplied flags so none can enable shell-escape.
    let extra = filter_extra_flags(&extra_flags.unwrap_or_default());

    // Only honour an explicitly requested engine we actually have; otherwise let
    // latexmk / the first installed engine decide.
    let engine = engine.filter(|e| cap.engines.iter().any(|g| g == e));
    // The PDF lands in the output dir if one was given, else beside the source.
    let pdf = match &out_path {
        Some(p) => p.join(format!("{stem}.pdf")),
        None => dir.join(format!("{stem}.pdf")),
    };
    let mut log = String::new();

    if cap.latexmk {
        let flag = latexmk_flag(engine.as_deref());
        let out = run_in(
            dir,
            "latexmk",
            &latexmk_args(engine.as_deref(), file_name, out_arg.as_deref(), &extra),
        )?;
        log.push_str(&out.text);
        let success = out.ok && pdf.exists();
        if success {
            // Record this file as the build root for every .tex it pulls in, so
            // pressing Compile in a child later redirects here (resolve_tex_root).
            record_root_mappings(&src);
        }
        return Ok(TexCompileResult {
            success,
            pdf_path: pdf.exists().then(|| pdf.to_string_lossy().into_owned()),
            engine: format!("latexmk {flag}"),
            shell_escape: log_shows_shell_escape(&log),
            log: tail(&log),
        });
    }

    // No latexmk: drive the engine directly. First pass, then a bibtex pass when
    // the aux shows citations, then reruns to settle references / ToC.
    let eng = engine.unwrap_or_else(|| cap.engines[0].clone());
    let engine_args = engine_args(file_name, out_arg.as_deref(), &extra);

    let first = run_in(dir, &eng, &engine_args)?;
    log.push_str(&first.text);

    // The aux lands in the output dir too when one is set.
    let aux = match &out_path {
        Some(p) => p.join(format!("{stem}.aux")),
        None => dir.join(format!("{stem}.aux")),
    };
    if cap.bibtex && aux_needs_bibtex(&aux) {
        // bibtex resolves its aux relative to its own CWD; run it in the output
        // dir when one is set so it finds the aux written there.
        let bib_dir = out_path.as_deref().unwrap_or(dir);
        let bib = run_in(bib_dir, "bibtex", std::slice::from_ref(&stem))?;
        log.push_str(&bib.text);
        for _ in 0..2 {
            log.push_str(&run_in(dir, &eng, &engine_args)?.text);
        }
    } else {
        // One extra pass resolves cross-references / table of contents.
        log.push_str(&run_in(dir, &eng, &engine_args)?.text);
    }

    let success = pdf.exists();
    if success {
        record_root_mappings(&src);
    }
    Ok(TexCompileResult {
        success,
        pdf_path: pdf.exists().then(|| pdf.to_string_lossy().into_owned()),
        engine: eng,
        shell_escape: log_shows_shell_escape(&log),
        log: tail(&log),
    })
}

// ── Font discovery ───────────────────────────────────────────────────────────
//
// The deck's type picker (TODO V #120). A Beamer plate is typeset in Computer
// Modern / Latin Modern, so with the standard-14 faces alone *every* layer
// caption sat in Helvetica on top of it — and a non-Latin talk was impossible,
// since those faces are WinAnsi-encoded.
//
// Deliberately a plain directory walk rather than fontconfig: the picker needs a
// **file path**, because the frontend embeds the bytes (the same bytes it
// measures with — see `deck/fonts.ts`), and `fc-list` is one more optional tool
// to depend on for a list this can produce itself.

/// One font file the deck can embed.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct FontFile {
    /// Absolute path — the key the frontend measures and embeds by.
    pub path: String,
    /// A human label: the file stem with separators normalised.
    pub name: String,
}

/// Font-file extensions pdf-lib's fontkit can actually embed. `.pfb`/`.otc` and
/// bitmap formats are excluded rather than offered and then failing at export.
const FONT_EXTS: &[&str] = &["ttf", "otf", "ttc", "woff", "woff2"];

/// Directories to walk, per platform. A user directory first so a font the user
/// installed themselves outranks a system copy of the same family in the list.
fn font_dirs() -> Vec<std::path::PathBuf> {
    let mut out: Vec<std::path::PathBuf> = Vec::new();
    // The crate's own resolver, not a new dependency — it already encodes the
    // per-OS rules (and the tests' overrides) every other path here goes through.
    let home = crate::paths::home_dir();
    #[cfg(target_os = "linux")]
    {
        out.push(home.join(".local/share/fonts"));
        out.push(home.join(".fonts"));
    }
    #[cfg(target_os = "macos")]
    out.push(home.join("Library/Fonts"));
    #[cfg(target_os = "windows")]
    out.push(home.join("AppData/Local/Microsoft/Windows/Fonts"));
    let _ = &home;
    #[cfg(target_os = "linux")]
    {
        out.push("/usr/share/fonts".into());
        out.push("/usr/local/share/fonts".into());
    }
    #[cfg(target_os = "macos")]
    {
        out.push("/Library/Fonts".into());
        out.push("/System/Library/Fonts".into());
    }
    #[cfg(target_os = "windows")]
    out.push("C:\\Windows\\Fonts".into());
    out
}

/// Turn a font file's stem into something a picker can show: `LiberationSerif-BoldItalic`
/// → `Liberation Serif Bold Italic`.
pub fn font_display_name(stem: &str) -> String {
    let spaced = stem.replace(['-', '_'], " ");
    let mut out = String::with_capacity(spaced.len() + 4);
    let mut prev_lower = false;
    for ch in spaced.chars() {
        // Split camel case, but never inside a run of capitals (an acronym).
        if prev_lower && ch.is_uppercase() {
            out.push(' ');
        }
        prev_lower = ch.is_lowercase() || ch.is_ascii_digit();
        out.push(ch);
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn collect_fonts(dir: &Path, depth: u32, out: &mut Vec<FontFile>) {
    // Font trees are shallow (`/usr/share/fonts/truetype/<family>/`), and an
    // unbounded walk of a symlinked home directory is how a "list the fonts" call
    // turns into a filesystem scan.
    if depth > 3 || out.len() > 4000 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        // `metadata` follows symlinks; a font directory that links to itself
        // would otherwise recurse until the depth cap, needlessly.
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            collect_fonts(&path, depth + 1, out);
            continue;
        }
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .unwrap_or_default();
        if !FONT_EXTS.contains(&ext.as_str()) {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        out.push(FontFile {
            name: font_display_name(stem),
            path: path.to_string_lossy().into_owned(),
        });
    }
}

/// Every embeddable font file on this machine, deduplicated by path and sorted
/// by display name. Never an error: a missing directory is simply one fewer
/// place to look.
#[tauri::command]
pub async fn list_fonts() -> Result<Vec<FontFile>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut out: Vec<FontFile> = Vec::new();
        for dir in font_dirs() {
            collect_fonts(&dir, 0, &mut out);
        }
        out.sort_by(|a, b| {
            a.name
                .to_lowercase()
                .cmp(&b.name.to_lowercase())
                .then(a.path.cmp(&b.path))
        });
        out.dedup_by(|a, b| a.path == b.path);
        Ok(out)
    })
    .await
    .map_err(|e| format!("font scan failed: {e}"))?
}

// ── SyncTeX: which source lines produced each page ───────────────────────────
//
// This is the producer half of the deck's slide anchoring (`sidecar.ts`'s
// `reconcile`, TODO V #100). The sidecar has always documented a `line` anchor as
// "strictly better than any content heuristic" — it survives inserting, deleting
// and reordering frames exactly as well as the author's own mental model — and
// has always *consumed* one. Nothing ever wrote it, so the mechanism did not
// exist at runtime and every deck fell back to fingerprinting.
//
// It is answered by reading the `.synctex.gz` the compile already emits
// (`-synctex=1` is passed unconditionally) rather than by shelling out to
// `synctex edit` once per page: a 200-page plate would be 200 process spawns for
// one reconcile.

/// The source lines SyncTeX attributes to one page of a compiled PDF.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PageLines {
    /// 1-based, as the PDF numbers it.
    pub page: u32,
    /// Distinct contributing lines of the **main** input file, ascending.
    pub lines: Vec<u32>,
}

/// Parse a decompressed SyncTeX file into per-page line sets.
///
/// The format is one record per line. `{N` opens page N and `}N` closes it;
/// inside, a box/glyph/kern/glue record is `<type><tag>,<line>[,<column>]:<geometry>`
/// where `<tag>` names an input file declared in the preamble as
/// `Input:<tag>:<path>`. Closing records (`]`, `)`) carry no tag.
///
/// `want_tag` restricts the harvest to one input file. That restriction is
/// load-bearing rather than an optimisation: line numbers from two different
/// files are not comparable, so mixing them would produce an anchor that silently
/// means nothing. A deck whose frames live in an `\input`ed file simply records no
/// line and falls back to the fingerprint, which is the honest outcome.
pub fn parse_synctex_pages(text: &str, want_tag: Option<u32>) -> Vec<PageLines> {
    let mut out: Vec<PageLines> = Vec::new();
    let mut page: Option<u32> = None;
    let mut lines: std::collections::BTreeSet<u32> = std::collections::BTreeSet::new();

    let flush = |page: &mut Option<u32>,
                 lines: &mut std::collections::BTreeSet<u32>,
                 out: &mut Vec<PageLines>| {
        if let Some(p) = page.take() {
            out.push(PageLines {
                page: p,
                lines: lines.iter().copied().collect(),
            });
            lines.clear();
        }
    };

    for raw in text.lines() {
        let l = raw.trim_end();
        let Some(c) = l.chars().next() else { continue };
        match c {
            '{' => {
                if let Ok(p) = l[1..].trim().parse::<u32>() {
                    flush(&mut page, &mut lines, &mut out);
                    page = Some(p);
                }
            }
            '}' => flush(&mut page, &mut lines, &mut out),
            // Box open/close-with-content, void boxes, and the glyph/kern/glue
            // records. `]` and `)` are the closers and carry no tag, so they are
            // not listed.
            '[' | '(' | 'v' | 'h' | 'x' | 'k' | 'g' | '$' | 'r' if page.is_some() => {
                if let Some((tag, line)) = parse_record_tag_line(&l[1..]) {
                    if want_tag.is_none_or(|w| w == tag) && line > 0 {
                        lines.insert(line);
                    }
                }
            }
            _ => {}
        }
    }
    flush(&mut page, &mut lines, &mut out);
    out.sort_by_key(|p| p.page);
    out
}

/// `"1,23:0,0:..."` → `(1, 23)`. Returns None for anything not shaped like a
/// record body, which is how the postamble's `Count:`-style lines are skipped
/// without enumerating them.
fn parse_record_tag_line(body: &str) -> Option<(u32, u32)> {
    let head = body.split(':').next()?;
    let mut parts = head.split(',');
    let tag = parts.next()?.trim().parse::<u32>().ok()?;
    let line = parts.next()?.trim().parse::<u32>().ok()?;
    Some((tag, line))
}

/// Find the `Input:` tag whose path has file stem `stem`, i.e. the document's own
/// main source rather than one of its includes or a package.
pub fn main_input_tag(text: &str, stem: &str) -> Option<u32> {
    for raw in text.lines() {
        let l = raw.trim();
        let Some(rest) = l.strip_prefix("Input:") else {
            // The Input block is contiguous and precedes the content; once past
            // it there is nothing left to find, and scanning a 40 MB body for a
            // prefix that cannot appear is pure cost.
            if l.starts_with("Content:") {
                return None;
            }
            continue;
        };
        let mut it = rest.splitn(2, ':');
        let tag = it.next()?.trim().parse::<u32>().ok();
        let path = it.next().unwrap_or("").trim();
        if let (Some(tag), Some(s)) = (tag, Path::new(path).file_stem().and_then(|s| s.to_str())) {
            if s == stem {
                return Some(tag);
            }
        }
    }
    None
}

/// Read the SyncTeX map beside `pdf` and report the source lines behind each page.
///
/// Returns an empty vector — never an error — when there is no map: a deck whose
/// plate was imported, or compiled by something that did not emit one, is an
/// ordinary case that falls back to content fingerprinting. Only a map that
/// exists and cannot be read is an error worth surfacing.
#[tauri::command]
pub async fn synctex_page_lines(pdf: String) -> Result<Vec<PageLines>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let pdf_path = Path::new(&pdf);
        let stem = match pdf_path.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => return Ok(Vec::new()),
        };
        let dir = pdf_path.parent().unwrap_or_else(|| Path::new("."));

        let gz = dir.join(format!("{stem}.synctex.gz"));
        let plain = dir.join(format!("{stem}.synctex"));
        let text = if gz.exists() {
            let bytes = fs::read(&gz).map_err(|e| format!("read {}: {e}", gz.display()))?;
            let mut out = String::new();
            use std::io::Read;
            flate2::read::GzDecoder::new(&bytes[..])
                .read_to_string(&mut out)
                .map_err(|e| format!("decompress {}: {e}", gz.display()))?;
            out
        } else if plain.exists() {
            fs::read_to_string(&plain).map_err(|e| format!("read {}: {e}", plain.display()))?
        } else {
            return Ok(Vec::new());
        };

        let tag = main_input_tag(&text, &stem);
        Ok(parse_synctex_pages(&text, tag))
    })
    .await
    .map_err(|e| format!("synctex task failed: {e}"))?
}

// ── SyncTeX forward/reverse search ───────────────────────────────────────────

/// Parse the `synctex edit` stdout into a `SyncSource`. The relevant block looks
/// like:
/// ```text
/// SyncTeX result begin
/// Output:doc.pdf
/// Input:/abs/path/chapter.tex
/// Line:42
/// Column:-1
/// …
/// SyncTeX result end
/// ```
/// The source file is on the `Input:` line; `Output:` names the PDF and is
/// ignored. `base` is the PDF's directory, used to absolutise a relative
/// `Input:` path.
fn parse_synctex_edit(out: &str, base: &Path) -> Option<SyncSource> {
    let mut input: Option<String> = None;
    let mut line: u32 = 0;
    let mut column: u32 = 0;
    for raw in out.lines() {
        let l = raw.trim();
        if let Some(v) = l.strip_prefix("Input:") {
            if input.is_none() {
                let p = Path::new(v.trim());
                let abs = if p.is_absolute() {
                    p.to_path_buf()
                } else {
                    base.join(p)
                };
                let abs = fs::canonicalize(&abs).unwrap_or(abs);
                input = Some(abs.to_string_lossy().into_owned());
            }
        } else if let Some(v) = l.strip_prefix("Line:") {
            if line == 0 {
                line = v.trim().parse().unwrap_or(0);
            }
        } else if let Some(v) = l.strip_prefix("Column:") {
            if column == 0 {
                // SyncTeX reports -1 when there is no column; clamp to 0.
                column = v.trim().parse().unwrap_or(0);
            }
        }
    }
    let input = input?;
    if line == 0 {
        return None;
    }
    Some(SyncSource {
        input,
        line,
        column,
    })
}

/// Reverse search: which source line produced the point `(x, y)` (big points
/// from the page top-left) on `page` of `pdf`. Returns `Ok(None)` when SyncTeX
/// is unavailable or has no answer, so the UI can degrade silently.
///
/// The `.synctex(.gz)` beside the PDF is read directly
/// (`commands::synctex::resolve`) rather than by shelling out, because the CLI
/// answers a click that is not squarely on a glyph — the left margin, a
/// paragraph indent, the slack after a short line — with the *enclosing box's*
/// tag, and pdfTeX labels that box with wherever `\par` happened to fire. On a
/// three-file document that is a different `.tex` file for every such click, so
/// the jump lands in the wrong editor. See that module for the record dump.
///
/// `synctex edit` remains the fallback for a PDF with no map beside it (an
/// out-of-tree build) or a map this parser could not make sense of; the CLI is
/// also what supplies the column, which the map never records.
///
/// Async so the read + gunzip runs off the main thread: a sync `#[tauri::command]`
/// is called on it, and a large document's map is megabytes.
#[tauri::command]
pub async fn synctex_edit(
    pdf: String,
    page: u32,
    x: f64,
    y: f64,
) -> Result<Option<SyncSource>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let pdf_path = Path::new(&pdf);
        let dir = pdf_path.parent().unwrap_or_else(|| Path::new("."));
        if let Some((input, line)) = crate::commands::synctex::resolve(pdf_path, page, x, y) {
            return Ok(Some(SyncSource {
                input,
                line,
                column: 0,
            }));
        }
        if !on_path("synctex") {
            return Ok(None);
        }
        let spec = format!("{page}:{x}:{y}:{pdf}");
        let out = run_in(dir, "synctex", &["edit", "-o", &spec])?;
        Ok(parse_synctex_edit(&out.text, dir))
    })
    .await
    .map_err(|e| format!("synctex task failed: {e}"))?
}

/// Parse the `synctex view` stdout into every record block it emitted, in order.
/// A forward query returns ONE block per node the source position maps to — one
/// per horizontal box on the line, and one per visual line when a source line
/// wraps — so the caller can pick the box matching the clicked column / row
/// rather than guessing from a single line box. Each block looks like:
/// ```text
/// SyncTeX result begin
/// Page:3
/// x:123.4
/// y:567.8
/// h:120.0
/// v:560.0
/// W:380.0
/// H:12.0
/// Page:3
/// …
/// SyncTeX result end
/// ```
/// We use `h` for the left edge and `W`/`H` for size; all in big points from the
/// page top-left. SyncTeX's `v` is the box *bottom* (baseline+depth), not its
/// top — verified empirically against `synctex edit` — so the rect's top edge is
/// `v - H`. Using `v` directly placed the highlight about one line too low. A new
/// `Page:` line starts a new record; an incomplete trailing block is dropped.
fn parse_synctex_view(out: &str) -> Vec<SyncRect> {
    /// Fields accumulated for the record currently being read.
    struct Partial {
        page: u32,
        h: Option<f64>,
        v: Option<f64>,
        w: Option<f64>,
        ht: Option<f64>,
    }

    let mut recs: Vec<SyncRect> = Vec::new();
    let mut cur: Option<Partial> = None;

    // Emit the accumulated record if it has the two fields a box needs (left edge
    // `h` and bottom `v`); width/height default to 0 when SyncTeX omitted them.
    let flush = |cur: &mut Option<Partial>, recs: &mut Vec<SyncRect>| {
        if let Some(p) = cur.take() {
            if let (Some(x), Some(v)) = (p.h, p.v) {
                let height = p.ht.unwrap_or(0.0).abs();
                recs.push(SyncRect {
                    page: p.page,
                    x,
                    // `v` is the box bottom; the rect's top is one box-height above.
                    y: v - height,
                    w: p.w.unwrap_or(0.0).abs(),
                    h: height,
                });
            }
        }
    };

    for raw in out.lines() {
        let l = raw.trim();
        if let Some(s) = l.strip_prefix("Page:") {
            // A new node begins; bank the previous one first.
            flush(&mut cur, &mut recs);
            cur = Some(Partial {
                page: s.trim().parse().unwrap_or(0),
                h: None,
                v: None,
                w: None,
                ht: None,
            });
        } else if let Some(p) = cur.as_mut() {
            let set = |slot: &mut Option<f64>, v: &str| {
                if slot.is_none() {
                    if let Ok(n) = v.trim().parse() {
                        *slot = Some(n);
                    }
                }
            };
            if let Some(s) = l.strip_prefix("h:") {
                set(&mut p.h, s);
            } else if let Some(s) = l.strip_prefix("v:") {
                set(&mut p.v, s);
            } else if let Some(s) = l.strip_prefix("W:") {
                set(&mut p.w, s);
            } else if let Some(s) = l.strip_prefix("H:") {
                set(&mut p.ht, s);
            }
        }
    }
    flush(&mut cur, &mut recs);
    recs
}

/// Forward search: where in `pdf` does `input:line:column` land. Returns every
/// SyncTeX record block (the line's constituent boxes / wrapped rows), in order;
/// the frontend picks the one matching the clicked column. Empty when SyncTeX is
/// unavailable or has no answer.
///
/// The `.synctex(.gz)` beside the PDF is read directly
/// (`commands::synctex::view`) first, for the same reason reverse search is: the
/// CLI's `synctex view -i` matches the input against the *exact* path string
/// SyncTeX recorded, so an absolute vs. `./`-prefixed vs. symlinked spelling that
/// doesn't match character-for-character silently returns nothing — "can't locate
/// the cursor" even with the caret squarely on body text. The native reader
/// matches the source file by canonicalised path, so spelling can't defeat it.
///
/// `synctex view` remains the fallback for a PDF whose map this parser could not
/// make sense of, or one with no map beside it.
#[tauri::command]
pub fn synctex_view(
    pdf: String,
    input: String,
    line: u32,
    column: u32,
) -> Result<Vec<SyncRect>, String> {
    let pdf_path = Path::new(&pdf);
    let native = crate::commands::synctex::view(pdf_path, &input, line);
    if !native.is_empty() {
        return Ok(native
            .into_iter()
            .map(|(page, x, y, w, h)| SyncRect { page, x, y, w, h })
            .collect());
    }
    let dir = pdf_path.parent().unwrap_or_else(|| Path::new("."));
    if !on_path("synctex") {
        return Ok(Vec::new());
    }
    let spec = format!("{line}:{column}:{input}");
    let out = run_in(dir, "synctex", &["view", "-i", &spec, "-o", &pdf])?;
    Ok(parse_synctex_view(&out.text))
}

// ── Subtex → main-tex root mapping ───────────────────────────────────────────

/// Commands that pull another `.tex` into the document. Matches the file-include
/// subset of the frontend's `TEX_REF_COMMANDS` (`src/components/files/tex.ts`).
const INCLUDE_COMMANDS: &[&str] = &["input", "include", "subfile", "subfileinclude"];

/// Path of the persisted child→root map.
fn tex_roots_path() -> std::path::PathBuf {
    crate::storage::state_dir().join("tex_roots.json")
}

/// Extract the `.tex` files directly included by `source` text. `\input{a}` →
/// `a.tex`; an explicit extension is kept. Relative paths stay relative (the
/// caller resolves them against the including file's directory).
fn parse_includes(source: &str) -> Vec<String> {
    let mut out = Vec::new();
    let bytes = source.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'\\' {
            i += 1;
            continue;
        }
        // Read the command name after the backslash.
        let mut j = i + 1;
        while j < bytes.len() && (bytes[j] as char).is_ascii_alphabetic() {
            j += 1;
        }
        let cmd = &source[i + 1..j];
        if INCLUDE_COMMANDS.contains(&cmd) && j < bytes.len() && bytes[j] == b'{' {
            // Read the brace argument.
            if let Some(close) = source[j + 1..].find('}') {
                let arg = source[j + 1..j + 1 + close].trim().to_string();
                if !arg.is_empty() {
                    let with_ext = if Path::new(&arg).extension().is_some() {
                        arg
                    } else {
                        format!("{arg}.tex")
                    };
                    out.push(with_ext);
                }
                i = j + 1 + close + 1;
                continue;
            }
        }
        i = j.max(i + 1);
    }
    out
}

/// Recursively collect every `.tex` file reachable from `root` via include
/// commands, as canonicalized absolute paths (excluding `root` itself). Bounded
/// by a visited set and a depth cap so a cyclic `\input` can't loop forever.
fn scan_tex_includes(root: &Path) -> Vec<std::path::PathBuf> {
    fn walk(
        file: &Path,
        depth: usize,
        seen: &mut std::collections::HashSet<std::path::PathBuf>,
        out: &mut Vec<std::path::PathBuf>,
    ) {
        if depth > 32 {
            return;
        }
        let Ok(text) = fs::read_to_string(file) else {
            return;
        };
        let dir = file.parent().unwrap_or_else(|| Path::new("."));
        for rel in parse_includes(&text) {
            let p = Path::new(&rel);
            let abs = if p.is_absolute() {
                p.to_path_buf()
            } else {
                dir.join(p)
            };
            let abs = fs::canonicalize(&abs).unwrap_or(abs);
            if seen.insert(abs.clone()) {
                out.push(abs.clone());
                walk(&abs, depth + 1, seen, out);
            }
        }
    }
    let mut seen = std::collections::HashSet::new();
    let root = fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    seen.insert(root.clone());
    let mut out = Vec::new();
    walk(&root, 0, &mut seen, &mut out);
    out
}

/// After a successful compile, persist `child → root` for every `.tex` `root`
/// includes, so a later Compile in a child builds `root` instead of the
/// fragment. Best-effort: failures to read/write the map are ignored.
fn record_root_mappings(root: &Path) {
    let root_abs = fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let children = scan_tex_includes(&root_abs);
    if children.is_empty() {
        return;
    }
    let path = tex_roots_path();
    let mut map: std::collections::HashMap<String, String> =
        crate::storage::read_json(&path).unwrap_or_default();
    let root_str = root_abs.to_string_lossy().into_owned();
    // Drop stale entries that pointed at this root but are no longer included.
    let child_set: std::collections::HashSet<String> = children
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    map.retain(|child, mapped_root| *mapped_root != root_str || child_set.contains(child));
    for child in &child_set {
        map.insert(child.clone(), root_str.clone());
    }
    let _ = crate::storage::write_json(&path, &map);
}

/// Read the `% !TEX root = …` magic comment from the head of `source`, resolved
/// against `dir`. Matches the de-facto editor convention (TeXShop/TeXstudio/…).
fn magic_root(source: &str, dir: &Path) -> Option<std::path::PathBuf> {
    for raw in source.lines().take(20) {
        let l = raw.trim_start();
        if !l.starts_with('%') {
            continue;
        }
        let body = l.trim_start_matches('%').trim();
        // Case-insensitive "!TEX root =" / "!TEX root:".
        let lower = body.to_ascii_lowercase();
        if let Some(rest) = lower.strip_prefix("!tex root") {
            let rest = rest.trim_start();
            let rest = rest.strip_prefix('=').or_else(|| rest.strip_prefix(':'))?;
            // Map back to the original-cased slice for the path value.
            let val = &body[body.len() - rest.len()..];
            let val = val.trim();
            if val.is_empty() {
                return None;
            }
            let p = Path::new(val);
            let abs = if p.is_absolute() {
                p.to_path_buf()
            } else {
                dir.join(p)
            };
            return Some(fs::canonicalize(&abs).unwrap_or(abs));
        }
    }
    None
}

/// Resolve the file that should actually be compiled for `path`:
///   1. an explicit `% !TEX root = …` magic comment, else
///   2. the stored child→root map (if the root still exists and still includes
///      this child), else
///   3. `path` itself.
#[tauri::command]
pub fn resolve_tex_root(path: String) -> Result<String, String> {
    let src = fs::canonicalize(&path).unwrap_or_else(|_| Path::new(&path).to_path_buf());
    let dir = src.parent().unwrap_or_else(|| Path::new("."));

    // 1. Magic comment wins.
    if let Ok(text) = fs::read_to_string(&src) {
        if let Some(root) = magic_root(&text, dir) {
            if root.exists() {
                return Ok(root.to_string_lossy().into_owned());
            }
        }
    }

    // 2. Stored map, verified.
    let src_str = src.to_string_lossy().into_owned();
    if let Ok(map) =
        crate::storage::read_json::<std::collections::HashMap<String, String>>(&tex_roots_path())
    {
        if let Some(root) = map.get(&src_str) {
            let root_path = Path::new(root);
            if root_path.exists()
                && scan_tex_includes(root_path)
                    .iter()
                    .any(|c| c.to_string_lossy() == *src_str)
            {
                return Ok(root.clone());
            }
        }
    }

    // 3. It is its own root.
    Ok(src_str)
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// A SyncTeX body shaped like the real thing: a preamble of `Input:` files,
    /// then two pages, the second of which is a Beamer overlay of the first — the
    /// case the whole line anchor exists for, since both come from the same frame
    /// and are therefore attributed to the same source lines.
    const SYNCTEX: &str = "\
SyncTeX Version:1
Input:1:/talks/main.tex
Input:2:/usr/share/texmf/beamer.sty
Content:
{1
[1,12:0,0:100,50,0
(1,14:10,10:80,20,0
h1,15:10,10:80,10,0
)
x2,99:5,5
]
}1
{2
[1,12:0,0:100,50,0
h1,15:10,10:80,10,0
h1,18:10,30:80,10,0
]
}2
Postamble:
Count:2
";

    #[test]
    fn font_names_are_readable_in_a_picker() {
        assert_eq!(
            font_display_name("LiberationSerif-BoldItalic"),
            "Liberation Serif Bold Italic"
        );
        assert_eq!(font_display_name("DejaVuSans"), "Deja Vu Sans");
        assert_eq!(font_display_name("lmroman10-regular"), "lmroman10 regular");
        // A run of capitals is an acronym, not words: don't shatter it.
        assert_eq!(font_display_name("NIMBUSSans"), "NIMBUSSans");
        assert_eq!(font_display_name("Some__Font  Name"), "Some Font Name");
    }

    #[test]
    fn only_embeddable_font_formats_are_offered() {
        // A format fontkit cannot embed must not reach the picker: offering it
        // and failing at export is the worst of both.
        let dir = std::env::temp_dir().join(format!("eldrun-fonts-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("nested")).unwrap();
        for name in ["Good.ttf", "Also.OTF", "Bitmap.pcf", "Notes.txt"] {
            fs::write(dir.join(name), b"x").unwrap();
        }
        fs::write(dir.join("nested/Deep.woff2"), b"x").unwrap();

        let mut out = Vec::new();
        collect_fonts(&dir, 0, &mut out);
        let mut names: Vec<&str> = out.iter().map(|f| f.name.as_str()).collect();
        names.sort_unstable();
        assert_eq!(names, vec!["Also", "Deep", "Good"]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_font_directory_is_not_an_error() {
        let mut out = Vec::new();
        collect_fonts(Path::new("/definitely/not/here"), 0, &mut out);
        assert!(out.is_empty());
    }

    #[test]
    fn synctex_pages_harvest_the_main_file_s_lines() {
        let tag = main_input_tag(SYNCTEX, "main");
        assert_eq!(tag, Some(1));
        let pages = parse_synctex_pages(SYNCTEX, tag);
        assert_eq!(
            pages,
            vec![
                PageLines {
                    page: 1,
                    lines: vec![12, 14, 15]
                },
                PageLines {
                    page: 2,
                    lines: vec![12, 15, 18]
                },
            ]
        );
        // The package's own tag is excluded: line numbers from two files are not
        // comparable, so mixing them would be an anchor that means nothing.
        assert!(!pages[0].lines.contains(&99));
    }

    #[test]
    fn overlay_pages_share_a_first_line() {
        // Both pages of the frame report 12 as their lowest line. That is not a
        // bug to fix here — it is the fact `reconcile` matches *within* the group
        // for, so the k-th slide on line L takes the k-th page L produced.
        let pages = parse_synctex_pages(SYNCTEX, Some(1));
        assert_eq!(pages[0].lines.first(), Some(&12));
        assert_eq!(pages[1].lines.first(), Some(&12));
    }

    #[test]
    fn a_map_with_no_matching_input_yields_no_lines() {
        // A deck whose frames live in an `\input`ed file records nothing rather
        // than an anchor built from another file's line numbering.
        assert_eq!(main_input_tag(SYNCTEX, "chapter"), None);
        let pages = parse_synctex_pages(SYNCTEX, Some(7));
        assert_eq!(pages.len(), 2);
        assert!(pages.iter().all(|p| p.lines.is_empty()));
    }

    #[test]
    fn postamble_lines_are_not_mistaken_for_records() {
        // `Count:2` sits outside any page and must not become line data.
        let pages = parse_synctex_pages(SYNCTEX, None);
        assert_eq!(pages.len(), 2);
    }

    #[test]
    fn latexmk_flag_maps_engines() {
        assert_eq!(latexmk_flag(Some("lualatex")), "-pdflua");
        assert_eq!(latexmk_flag(Some("xelatex")), "-pdfxe");
        assert_eq!(latexmk_flag(Some("pdflatex")), "-pdf");
        assert_eq!(latexmk_flag(None), "-pdf");
    }

    #[test]
    fn compile_args_never_enable_shell_escape() {
        // Compiling an untrusted `.tex` must never run the engine with
        // shell-escape / write18 enabled — that would let document macros
        // execute arbitrary shell commands. Guard the actual arg builders used
        // by `compile_tex` (its single source of truth) across every engine.
        let no_extra: Vec<String> = vec![];
        for engine in [None, Some("pdflatex"), Some("lualatex"), Some("xelatex")] {
            let args = latexmk_args(engine, "doc.tex", None, &no_extra);
            assert!(
                !args.iter().any(|a| flag_enables_shell_escape(a)),
                "latexmk args for {engine:?} enable shell-escape: {args:?}",
            );
        }

        let direct = engine_args("doc.tex", None, &no_extra);
        assert!(
            !direct.iter().any(|a| flag_enables_shell_escape(a)),
            "direct engine args enable shell-escape: {direct:?}",
        );
    }

    #[test]
    fn filter_extra_flags_strips_shell_escape() {
        // User-supplied extra flags must never smuggle in shell-escape, in any
        // of its spellings. Benign flags pass through unchanged.
        let input: Vec<String> = vec![
            "-shell-escape".into(),
            "--shell-escape".into(),
            "-enable-write18".into(),
            "-shell-escape=1".into(),
            "-synctex=1".into(),
            "-file-line-error".into(),
        ];
        let kept = filter_extra_flags(&input);
        assert!(
            !kept.iter().any(|f| flag_enables_shell_escape(f)),
            "filtered flags still enable shell-escape: {kept:?}",
        );
        assert!(kept.contains(&"-synctex=1".to_string()));
        assert!(kept.contains(&"-file-line-error".to_string()));
        assert_eq!(kept.len(), 2, "only the two benign flags survive: {kept:?}");

        // And the filtered flags, when fed into the arg builders, keep the
        // shell-escape invariant — even alongside the benign ones.
        let args = latexmk_args(None, "doc.tex", Some("build"), &kept);
        assert!(!args.iter().any(|a| flag_enables_shell_escape(a)));
    }

    #[test]
    fn out_dir_maps_to_correct_engine_args() {
        let no_extra: Vec<String> = vec![];
        // latexmk uses -outdir; the engine uses -output-directory.
        let mk = latexmk_args(None, "doc.tex", Some("/tmp/out"), &no_extra);
        assert!(
            mk.iter().any(|a| a == "-outdir=/tmp/out"),
            "latexmk should set -outdir: {mk:?}",
        );
        let eng = engine_args("doc.tex", Some("/tmp/out"), &no_extra);
        assert!(
            eng.iter().any(|a| a == "-output-directory=/tmp/out"),
            "engine should set -output-directory: {eng:?}",
        );
        // No out_dir → neither flag appears.
        let mk2 = latexmk_args(None, "doc.tex", None, &no_extra);
        assert!(!mk2.iter().any(|a| a.contains("outdir")));
    }

    #[test]
    fn log_shows_shell_escape_distinguishes_restricted() {
        // The safe default (restricted) must NOT trip the warning.
        assert!(!log_shows_shell_escape(
            "This is pdfTeX...\n restricted \\write18 enabled.\n"
        ));
        // Unrestricted enablement trips it.
        assert!(log_shows_shell_escape(
            "This is pdfTeX...\n \\write18 enabled.\n"
        ));
        // An actually-executed external command trips it.
        assert!(log_shows_shell_escape(
            "runsystem(rm -rf /tmp/x)...executed.\n"
        ));
        // A clean build does not.
        assert!(!log_shows_shell_escape(
            "Output written on doc.pdf (1 page).\n"
        ));
    }

    #[test]
    fn aux_needs_bibtex_detects_citations() {
        let dir = std::env::temp_dir().join(format!("eldrun-tex-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let aux = dir.join("doc.aux");

        fs::write(&aux, "\\relax\n\\citation{knuth}\n").unwrap();
        assert!(aux_needs_bibtex(&aux));

        fs::write(&aux, "\\relax\n").unwrap();
        assert!(!aux_needs_bibtex(&aux));

        // Missing aux → no bibtex pass.
        assert!(!aux_needs_bibtex(&dir.join("missing.aux")));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn tail_truncates_to_char_boundary() {
        let short = "ok";
        assert_eq!(tail(short), short);

        let long = "é".repeat(10_000); // multi-byte, > MAX
        let out = tail(&long);
        assert!(out.starts_with("…\n"));
        // The truncated remainder must itself be valid UTF-8 (no split char).
        assert!(out.is_char_boundary(out.len()));
    }

    #[test]
    fn compile_tex_rejects_non_tex() {
        let dir = std::env::temp_dir().join(format!("eldrun-tex-nt-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let txt = dir.join("notes.txt");
        fs::write(&txt, "hi").unwrap();
        // The blocking body, not the async command wrapper: the rejection is the
        // body's, and testing it here keeps this a plain synchronous test.
        let err =
            compile_tex_blocking(txt.to_string_lossy().into_owned(), None, None, None).unwrap_err();
        assert!(err.contains("not a .tex file"), "got: {err}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn arg_builders_always_emit_synctex() {
        let no_extra: Vec<String> = vec![];
        let mk = latexmk_args(None, "doc.tex", None, &no_extra);
        assert!(mk.iter().any(|a| a == "-synctex=1"), "latexmk: {mk:?}");
        let eng = engine_args("doc.tex", None, &no_extra);
        assert!(eng.iter().any(|a| a == "-synctex=1"), "engine: {eng:?}");
    }

    #[test]
    fn arg_builders_always_emit_file_line_error() {
        // `-file-line-error` makes the engine print `file:line: message`, which the
        // viewer parses for jump-to-error. Both build paths must request it.
        let no_extra: Vec<String> = vec![];
        let mk = latexmk_args(None, "doc.tex", None, &no_extra);
        assert!(
            mk.iter().any(|a| a == "-file-line-error"),
            "latexmk: {mk:?}"
        );
        let eng = engine_args("doc.tex", None, &no_extra);
        assert!(
            eng.iter().any(|a| a == "-file-line-error"),
            "engine: {eng:?}"
        );
    }

    #[test]
    fn parse_synctex_edit_extracts_source() {
        // Real `synctex edit` output: `Output:` is the PDF, `Input:` is the source.
        let out = "SyncTeX result begin\nOutput:doc.pdf\nInput:chapter.tex\nLine:42\nColumn:-1\nSyncTeX result end\n";
        let base = std::env::temp_dir();
        let s = parse_synctex_edit(out, &base).expect("a source");
        assert!(s.input.ends_with("chapter.tex"), "input: {}", s.input);
        assert_eq!(s.line, 42);
        // Column:-1 (no column) clamps to 0.
        assert_eq!(s.column, 0);
    }

    #[test]
    fn parse_synctex_edit_none_without_input() {
        // No Input:/Line: block → no answer. An Output:-only block (just the PDF
        // name, no source) must not be mistaken for a source location.
        assert!(
            parse_synctex_edit("SyncTeX result begin\nSyncTeX result end\n", Path::new("/"))
                .is_none()
        );
        assert!(parse_synctex_edit(
            "SyncTeX result begin\nOutput:doc.pdf\nSyncTeX result end\n",
            Path::new("/")
        )
        .is_none());
    }

    #[test]
    fn parse_synctex_view_extracts_rect() {
        let out = "SyncTeX result begin\nPage:3\nx:120.0\ny:560.0\nh:121.5\nv:559.0\nW:380.25\nH:12.0\nSyncTeX result end\n";
        let recs = parse_synctex_view(out);
        assert_eq!(recs.len(), 1);
        let r = &recs[0];
        assert_eq!(r.page, 3);
        assert_eq!(r.x, 121.5);
        // `v` (559.0) is the box bottom; the top edge is one box-height (H) above.
        assert_eq!(r.y, 559.0 - 12.0);
        assert_eq!(r.w, 380.25);
        assert_eq!(r.h, 12.0);
    }

    #[test]
    fn parse_synctex_view_extracts_all_records() {
        // A wrapped source line emits one record per visual row; every `Page:`
        // starts a new block. The frontend picks the row matching the column.
        let out = "SyncTeX result begin\n\
                   Page:1\nx:100.0\ny:200.0\nh:100.0\nv:200.0\nW:300.0\nH:12.0\n\
                   Page:1\nx:72.0\ny:214.0\nh:72.0\nv:214.0\nW:150.0\nH:12.0\n\
                   SyncTeX result end\n";
        let recs = parse_synctex_view(out);
        assert_eq!(recs.len(), 2);
        // First row.
        assert_eq!(recs[0].x, 100.0);
        assert_eq!(recs[0].y, 200.0 - 12.0);
        assert_eq!(recs[0].w, 300.0);
        // Second (wrapped) row, lower on the page.
        assert_eq!(recs[1].x, 72.0);
        assert_eq!(recs[1].y, 214.0 - 12.0);
        assert_eq!(recs[1].w, 150.0);
    }

    #[test]
    fn parse_synctex_view_empty_without_records() {
        // No node blocks → no rects (so the command yields an empty list).
        assert!(parse_synctex_view("SyncTeX result begin\nSyncTeX result end\n").is_empty());
        // An incomplete trailing block (no `v`) is dropped, not half-emitted.
        assert!(parse_synctex_view("Page:1\nx:1.0\nh:1.0\n").is_empty());
    }

    #[test]
    fn parse_includes_finds_tex_children() {
        let src = "\\documentclass{article}\n\\begin{document}\n\\input{intro}\n\\include{chapters/two.tex}\n\\includegraphics{fig.png}\n\\end{document}\n";
        let inc = parse_includes(src);
        assert_eq!(
            inc,
            vec!["intro.tex".to_string(), "chapters/two.tex".to_string()]
        );
    }

    #[test]
    fn scan_tex_includes_recurses() {
        let dir = std::env::temp_dir().join(format!("eldrun-tex-scan-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("chapters")).unwrap();
        let root = dir.join("main.tex");
        fs::write(&root, "\\input{chapters/one}\n").unwrap();
        fs::write(dir.join("chapters/one.tex"), "\\input{../two}\n").unwrap();
        fs::write(dir.join("two.tex"), "no includes\n").unwrap();

        let found = scan_tex_includes(&root);
        let names: std::collections::HashSet<String> = found
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert!(names.contains("one.tex"), "got: {names:?}");
        assert!(names.contains("two.tex"), "got: {names:?}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn magic_root_reads_tex_root_comment() {
        let dir = std::env::temp_dir();
        let root = magic_root(
            "% !TEX root = ../main.tex\n\\section{x}\n",
            Path::new("/proj/chapters"),
        );
        assert!(root.is_some());
        assert!(root.unwrap().to_string_lossy().ends_with("main.tex"));
        // Case-insensitive and colon form.
        assert!(magic_root("%!tex root: book.tex\n", &dir).is_some());
        // No magic comment → None.
        assert!(magic_root("\\documentclass{article}\n", &dir).is_none());
    }

    #[test]
    fn resolve_tex_root_prefers_magic_comment() {
        let dir = std::env::temp_dir().join(format!("eldrun-tex-root-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let main = dir.join("main.tex");
        fs::write(&main, "\\input{child}\n").unwrap();
        let child = dir.join("child.tex");
        let main_disp = fs::canonicalize(&main).unwrap();
        fs::write(
            &child,
            format!("% !TEX root = {}\n\\section{{x}}\n", main_disp.display()),
        )
        .unwrap();

        let resolved = resolve_tex_root(child.to_string_lossy().into_owned()).unwrap();
        assert_eq!(resolved, main_disp.to_string_lossy());

        // A file that is its own root resolves to itself.
        let solo = resolve_tex_root(main.to_string_lossy().into_owned()).unwrap();
        assert_eq!(solo, main_disp.to_string_lossy());
        let _ = fs::remove_dir_all(&dir);
    }
}
