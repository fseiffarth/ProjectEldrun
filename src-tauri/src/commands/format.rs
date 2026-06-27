//! Source-formatting and syntax-checking command handlers backing the in-app
//! text viewer's "Format" button and inline validation banner.
//!
//! Formatting shells out to whatever external formatter is available for the
//! language — `prettier` (web/markup/JSON family), `black` (Python), `rustfmt`
//! (Rust), `gofmt` (Go) — each invoked over stdin→stdout so nothing touches
//! disk. Prettier is resolved from a project-local `node_modules/.bin` first
//! (walking up from the edited file) and only then from `PATH`, so a repo's
//! pinned formatter wins. When no tool is found the command returns a typed
//! `formatter-unavailable:<lang>` error and the frontend disables the button.
//!
//! Syntax checking is done in-process via `serde_json`/`serde_yaml`, which give
//! an exact line/column for the first parse error — more reliable than the
//! webview's `JSON.parse`, whose JavaScriptCore messages carry no position.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Serialize;

/// A resolved external formatter: the executable plus the args to invoke it with
/// (it always reads the source on stdin and writes the result to stdout).
struct Tool {
    program: PathBuf,
    args: Vec<String>,
    /// Directory to run the tool in (so prettier finds the repo's config), if
    /// the edited file's directory is known.
    cwd: Option<PathBuf>,
}

/// Find the first executable named `name` on `PATH`, if any.
fn on_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(name))
        .find(|cand| cand.is_file())
}

/// Walk up from `start` looking for a `node_modules/.bin/<name>` executable, so a
/// project's pinned prettier is preferred over a global one.
fn node_bin(start: &Path, name: &str) -> Option<PathBuf> {
    let mut dir = Some(start);
    while let Some(d) = dir {
        let cand = d.join("node_modules").join(".bin").join(name);
        if cand.is_file() {
            return Some(cand);
        }
        dir = d.parent();
    }
    None
}

/// The extension a synthetic stdin filename should carry for `lang`, so prettier
/// can infer its parser when the real path is unknown.
fn synth_ext(lang: &str) -> &str {
    match lang {
        "css" => "css",
        "scss" => "scss",
        "less" => "less",
        "html" => "html",
        "json" => "json",
        "js" => "js",
        "jsx" => "jsx",
        "ts" => "ts",
        "tsx" => "tsx",
        "yaml" => "yaml",
        "vue" => "vue",
        "graphql" => "graphql",
        "markdown" => "md",
        "python" => "py",
        "rust" => "rs",
        "go" => "go",
        _ => "txt",
    }
}

/// Languages prettier handles in this app.
fn is_prettier_lang(lang: &str) -> bool {
    matches!(
        lang,
        "css" | "scss"
            | "less"
            | "html"
            | "json"
            | "js"
            | "jsx"
            | "ts"
            | "tsx"
            | "yaml"
            | "vue"
            | "graphql"
            | "markdown"
    )
}

/// Resolve the formatter for `lang`, using `path` (when known) to find a
/// project-local prettier and to label prettier's stdin parser. Returns `None`
/// when no suitable tool is installed.
fn resolve_tool(lang: &str, path: Option<&str>) -> Option<Tool> {
    let file_dir = path
        .and_then(|p| Path::new(p).parent())
        .map(Path::to_path_buf);
    let file_name = path
        .and_then(|p| Path::new(p).file_name())
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| format!("stdin.{}", synth_ext(lang)));

    if is_prettier_lang(lang) {
        let program = file_dir
            .as_deref()
            .and_then(|d| node_bin(d, "prettier"))
            .or_else(|| on_path("prettier"))?;
        return Some(Tool {
            program,
            args: vec!["--stdin-filepath".into(), file_name],
            cwd: file_dir,
        });
    }

    let (bin, args): (&str, Vec<String>) = match lang {
        // `black -q -` formats stdin → stdout quietly.
        "python" => ("black", vec!["-q".into(), "-".into()]),
        // rustfmt and gofmt both read stdin and write stdout with no args.
        "rust" => ("rustfmt", vec![]),
        "go" => ("gofmt", vec![]),
        _ => return None,
    };
    let program = on_path(bin)?;
    Some(Tool {
        program,
        args,
        cwd: file_dir,
    })
}

/// Whether a formatter for `lang` is available (drives the button's enabled
/// state). `path` lets a project-local prettier count.
#[tauri::command]
pub fn formatter_available(lang: String, path: Option<String>) -> bool {
    resolve_tool(&lang, path.as_deref()).is_some()
}

/// Format `text` as `lang` via the resolved external tool, returning the
/// formatted source. Errors:
///  - `formatter-unavailable:<lang>` when no tool is installed (frontend disables
///    the button and shows a hint),
///  - the tool's stderr (trimmed) when it exits non-zero (e.g. a syntax error).
#[tauri::command]
pub fn format_source(text: String, lang: String, path: Option<String>) -> Result<String, String> {
    let tool = resolve_tool(&lang, path.as_deref())
        .ok_or_else(|| format!("formatter-unavailable:{lang}"))?;

    let mut cmd = Command::new(&tool.program);
    cmd.args(&tool.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cwd) = &tool.cwd {
        cmd.current_dir(cwd);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("formatter-unavailable:{lang}: {e}"))?;

    // Write the source and drop the handle so the tool sees EOF, then collect
    // output. Dropping before `wait_with_output` avoids a stdin/stdout deadlock.
    {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "could not open formatter stdin".to_string())?;
        stdin
            .write_all(text.as_bytes())
            .map_err(|e| e.to_string())?;
    }

    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        let err = String::from_utf8_lossy(&output.stderr);
        let trimmed = err.trim();
        Err(if trimmed.is_empty() {
            format!("{} exited with a non-zero status", tool.program.display())
        } else {
            trimmed.to_string()
        })
    }
}

/// The first parse error in a checked document: 1-based `line`/`column` and the
/// parser's message. Columns/lines of 0 mean "position unknown".
#[derive(Debug, Serialize)]
pub struct SyntaxIssue {
    pub line: usize,
    pub column: usize,
    pub message: String,
}

/// Validate `text` as `lang` (`"json"` or `"yaml"`), returning the first parse
/// error or `None` when it is well-formed. Whitespace-only input is treated as
/// valid (an empty buffer isn't an error to surface while typing). Any other
/// `lang` is unchecked and returns `None`.
#[tauri::command]
pub fn check_syntax(text: String, lang: String) -> Option<SyntaxIssue> {
    if text.trim().is_empty() {
        return None;
    }
    match lang.as_str() {
        "json" => match serde_json::from_str::<serde::de::IgnoredAny>(&text) {
            Ok(_) => None,
            Err(e) => Some(SyntaxIssue {
                line: e.line(),
                column: e.column(),
                message: e.to_string(),
            }),
        },
        "yaml" => match serde_yaml::from_str::<serde_yaml::Value>(&text) {
            Ok(_) => None,
            Err(e) => {
                let (line, column) = e
                    .location()
                    .map(|loc| (loc.line(), loc.column()))
                    .unwrap_or((0, 0));
                Some(SyntaxIssue {
                    line,
                    column,
                    message: e.to_string(),
                })
            }
        },
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_ok_is_none() {
        assert!(check_syntax("{\"a\": 1}".into(), "json".into()).is_none());
    }

    #[test]
    fn json_error_reports_position() {
        let issue = check_syntax("{\"a\": }".into(), "json".into()).expect("should error");
        assert_eq!(issue.line, 1);
        assert!(issue.column > 0);
    }

    #[test]
    fn blank_input_is_valid() {
        assert!(check_syntax("   \n  ".into(), "json".into()).is_none());
        assert!(check_syntax("".into(), "yaml".into()).is_none());
    }

    #[test]
    fn yaml_ok_and_error() {
        assert!(check_syntax("a: 1\nb: 2\n".into(), "yaml".into()).is_none());
        // A tab in indentation is invalid YAML.
        assert!(check_syntax("a:\n\t- 1\n".into(), "yaml".into()).is_some());
    }

    #[test]
    fn unknown_lang_is_unchecked() {
        assert!(check_syntax("@@@ not checked".into(), "python".into()).is_none());
    }

    #[test]
    fn unavailable_formatter_is_typed_error() {
        // A language with no installed tool yields the typed sentinel; we can't
        // assume any formatter is installed in CI, so only assert the prefix when
        // it is in fact unavailable.
        if !formatter_available("rust".into(), None) {
            let err = format_source("fn  main(){}".into(), "rust".into(), None).unwrap_err();
            assert!(err.starts_with("formatter-unavailable:"));
        }
    }
}
