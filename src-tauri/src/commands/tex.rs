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
use std::process::{Command, Stdio};

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
}

/// True if `bin` resolves on `PATH`.
fn on_path(bin: &str) -> bool {
    Command::new("which")
        .arg(bin)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
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

/// Run `bin args…` with `dir` as the working directory, capturing stdout+stderr.
fn run_in(dir: &Path, bin: &str, args: &[&str]) -> Result<RunOut, String> {
    let out = Command::new(bin)
        .args(args)
        .current_dir(dir)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("run {bin}: {e}"))?;
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&out.stderr));
    Ok(RunOut {
        ok: out.status.success(),
        text,
    })
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

#[tauri::command]
pub fn compile_tex(path: String, engine: Option<String>) -> Result<TexCompileResult, String> {
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

    // Only honour an explicitly requested engine we actually have; otherwise let
    // latexmk / the first installed engine decide.
    let engine = engine.filter(|e| cap.engines.iter().any(|g| g == e));
    let pdf = dir.join(format!("{stem}.pdf"));
    let mut log = String::new();

    if cap.latexmk {
        let flag = latexmk_flag(engine.as_deref());
        let out = run_in(
            dir,
            "latexmk",
            &[flag, "-interaction=nonstopmode", file_name],
        )?;
        log.push_str(&out.text);
        let success = out.ok && pdf.exists();
        return Ok(TexCompileResult {
            success,
            pdf_path: pdf.exists().then(|| pdf.to_string_lossy().into_owned()),
            engine: format!("latexmk {flag}"),
            log: tail(&log),
        });
    }

    // No latexmk: drive the engine directly. First pass, then a bibtex pass when
    // the aux shows citations, then reruns to settle references / ToC.
    let eng = engine.unwrap_or_else(|| cap.engines[0].clone());
    let engine_args = ["-interaction=nonstopmode", "-halt-on-error", file_name];

    let first = run_in(dir, &eng, &engine_args)?;
    log.push_str(&first.text);

    if cap.bibtex && aux_needs_bibtex(&dir.join(format!("{stem}.aux"))) {
        let bib = run_in(dir, "bibtex", &[stem.as_str()])?;
        log.push_str(&bib.text);
        for _ in 0..2 {
            log.push_str(&run_in(dir, &eng, &engine_args)?.text);
        }
    } else {
        // One extra pass resolves cross-references / table of contents.
        log.push_str(&run_in(dir, &eng, &engine_args)?.text);
    }

    Ok(TexCompileResult {
        success: pdf.exists(),
        pdf_path: pdf.exists().then(|| pdf.to_string_lossy().into_owned()),
        engine: eng,
        log: tail(&log),
    })
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn latexmk_flag_maps_engines() {
        assert_eq!(latexmk_flag(Some("lualatex")), "-pdflua");
        assert_eq!(latexmk_flag(Some("xelatex")), "-pdfxe");
        assert_eq!(latexmk_flag(Some("pdflatex")), "-pdf");
        assert_eq!(latexmk_flag(None), "-pdf");
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
        let err = compile_tex(txt.to_string_lossy().into_owned(), None).unwrap_err();
        assert!(err.contains("not a .tex file"), "got: {err}");
        let _ = fs::remove_dir_all(&dir);
    }
}
