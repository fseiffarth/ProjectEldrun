//! Which Python runs the code viewer's Run/Debug buttons (#87).
//!
//! Naming the interpreter is the whole problem. Running a project's script with a
//! bare `python3` when its dependencies live in a venv fails with
//! `ModuleNotFoundError`, and that reads to the user as "Eldrun's Run button is
//! broken" rather than "wrong interpreter" — so getting this right is what makes
//! Run trustworthy at all.
//!
//! Two layers, in this order:
//!
//! 1. **The project's explicit choice** (`Project::python_interpreter`), set in the
//!    pill's "Python interpreter…" dialog. Always wins, and once set costs nothing
//!    to honour — no probing at all.
//! 2. **Auto-detect**, which is what an unconfigured project gets. It probes the
//!    environment managers people actually use, because a `.venv/` scan alone
//!    silently mis-fires on every conda/Poetry project.
//!
//! Auto-detect deliberately only *auto-selects* an environment that is
//! unambiguously this project's: an in-tree venv, this project's Poetry env, the
//! shell's active `VIRTUAL_ENV`/`CONDA_PREFIX`, a pyenv version pinned by
//! `.python-version`. Named conda envs are **listed** for the dialog but never
//! auto-picked — choosing one of the user's N unrelated envs on their behalf would
//! be a guess, and a wrong guess here is indistinguishable from a bug.
//!
//! Remote projects probe **the host**, over the pooled ControlMaster, with a single
//! constant `sh` script (`run_remote_script`) — the interpreter that matters is the
//! one on the machine the run tab will actually run on.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::schema::project::Project;
use crate::schema::projects::ProjectsList;
use crate::storage;

/// One interpreter the user could pick, as offered by the dialog.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PyInterpreter {
    /// Where it came from: `venv` | `poetry` | `conda` | `pyenv` | `active` | `system`.
    /// Drives the dialog's grouping and the auto-select precedence below.
    pub kind: String,
    /// The command Run/Debug executes. Relative (`.venv/bin/python`) for an in-tree
    /// venv — the run tab's cwd is the project root — absolute otherwise.
    pub path: String,
    /// Human label for the dropdown, e.g. `conda: ml-env`.
    pub label: String,
}

/// Precedence for auto-detect. Lower sorts first, and the first entry wins.
/// A `conda` (named, not active) env never auto-wins — see the module note.
fn auto_rank(kind: &str) -> u8 {
    match kind {
        "venv" => 0,    // in the project tree: unambiguous
        "poetry" => 1,  // this project's env, per poetry itself
        "active" => 2,  // the shell Eldrun was launched from
        "pyenv" => 3,   // usually pinned by an in-tree .python-version
        "system" => 5,
        _ => 4, // "conda" (named): offered, never auto-selected
    }
}

/// True when auto-detect may select this kind on its own.
fn auto_selectable(kind: &str) -> bool {
    matches!(kind, "venv" | "poetry" | "active" | "pyenv" | "system")
}

const WINDOWS: bool = cfg!(windows);

fn default_interpreter() -> String {
    if WINDOWS { "python".into() } else { "python3".into() }
}

/// The venv directory names we look for in the project root, in preference order.
const VENV_DIRS: [&str; 3] = [".venv", "venv", "env"];

/// The interpreter inside a venv root, relative to it.
fn venv_python_rel() -> &'static str {
    if WINDOWS { "Scripts\\python.exe" } else { "bin/python" }
}

// ── Local discovery ──────────────────────────────────────────────────────────

/// Run a helper program and return its trimmed stdout, or None if it isn't
/// installed / failed. Every probe here is *optional* by design: a machine with no
/// conda must not make interpreter discovery fail, it must simply offer no conda.
fn probe(dir: &Path, program: &str, args: &[&str]) -> Option<String> {
    let out = crate::paths::command_no_window(program)
        .args(args)
        .current_dir(dir)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() { None } else { Some(s) }
}

/// Interpreters visible from a LOCAL project directory.
///
/// Done natively rather than by shelling out a script because it must also work on
/// Windows, where there is no `sh` and the interpreter sits at `Scripts\python.exe`.
pub fn discover_local(dir: &Path) -> Vec<PyInterpreter> {
    let mut out: Vec<PyInterpreter> = Vec::new();

    // 1. venvs in the project tree.
    for name in VENV_DIRS {
        let py = dir.join(name).join(venv_python_rel());
        if py.is_file() {
            out.push(PyInterpreter {
                kind: "venv".into(),
                // Relative: the run tab's cwd IS the project root, and a relative
                // path keeps working if the project is moved. Native separators —
                // `cmd.exe` will not exec `.venv/Scripts/python.exe`.
                path: PathBuf::from(name)
                    .join(venv_python_rel())
                    .to_string_lossy()
                    .into_owned(),
                label: format!("{name} (in this project)"),
            });
        }
    }

    // 2. Poetry — the env lives outside the tree, so nothing else can find it.
    if let Some(p) = probe(dir, "poetry", &["env", "info", "-p"]) {
        let py = PathBuf::from(&p).join(venv_python_rel());
        if py.is_file() {
            out.push(PyInterpreter {
                kind: "poetry".into(),
                path: py.to_string_lossy().into_owned(),
                label: format!("poetry ({})", basename_of(&p)),
            });
        }
    }

    // 3. The environment Eldrun itself was launched inside.
    for (var, kind) in [("VIRTUAL_ENV", "active"), ("CONDA_PREFIX", "active")] {
        if let Ok(root) = std::env::var(var) {
            if root.is_empty() {
                continue;
            }
            let py = PathBuf::from(&root).join(venv_python_rel());
            if py.is_file() {
                out.push(PyInterpreter {
                    kind: kind.into(),
                    path: py.to_string_lossy().into_owned(),
                    label: format!("active ${var} ({})", basename_of(&root)),
                });
            }
        }
    }

    // 4. Named conda envs — offered, never auto-picked.
    if let Some(list) = probe(dir, "conda", &["env", "list"]) {
        for env in parse_conda_envs(&list) {
            let py = PathBuf::from(&env.1).join(venv_python_rel());
            if py.is_file() {
                out.push(PyInterpreter {
                    kind: "conda".into(),
                    path: py.to_string_lossy().into_owned(),
                    label: format!("conda: {}", env.0),
                });
            }
        }
    }

    // 5. pyenv — honours an in-tree `.python-version`, since we probe from `dir`.
    if let Some(p) = probe(dir, "pyenv", &["which", "python"]) {
        if Path::new(&p).is_file() {
            out.push(PyInterpreter {
                kind: "pyenv".into(),
                path: p.clone(),
                label: format!("pyenv ({})", basename_of(&p)),
            });
        }
    }

    // 6. The system interpreter — always last, always present as a fallback.
    out.push(PyInterpreter {
        kind: "system".into(),
        path: default_interpreter(),
        label: format!("system ({})", default_interpreter()),
    });

    dedupe_and_rank(out)
}

/// `conda env list` → `(name, prefix)` pairs. Its output is columns with a `*`
/// marking the active env:
/// ```text
/// # conda environments:
/// #
/// base                  *  /home/u/miniconda3
/// ml-env                   /home/u/miniconda3/envs/ml-env
/// ```
pub fn parse_conda_envs(stdout: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let fields: Vec<&str> = line.split_whitespace().collect();
        // Name first, prefix last; the optional `*` sits between them.
        if fields.len() < 2 {
            continue;
        }
        let name = fields[0];
        let prefix = fields[fields.len() - 1];
        if name == "*" || !prefix.starts_with('/') && !prefix.contains(":\\") {
            continue;
        }
        out.push((name.to_string(), prefix.to_string()));
    }
    out
}

fn basename_of(p: &str) -> String {
    p.rsplit(['/', '\\']).next().unwrap_or(p).to_string()
}

/// Drop duplicate interpreter paths (a poetry env can also be the active one) and
/// order by auto-detect precedence, so `first()` IS the auto-detected choice.
fn dedupe_and_rank(mut list: Vec<PyInterpreter>) -> Vec<PyInterpreter> {
    list.sort_by_key(|i| auto_rank(&i.kind));
    let mut seen = std::collections::HashSet::new();
    list.retain(|i| seen.insert(i.path.clone()));
    list
}

// ── Remote discovery ─────────────────────────────────────────────────────────

/// The host-side probe. A **constant** POSIX-`sh` script (the `run_remote_script`
/// contract: nothing may be interpolated into it), run with the project's remote
/// dir as cwd so `poetry`/`pyenv` resolve *this* project's environment. Emits one
/// `kind\tpath\tlabel` line per interpreter — collapsing what would otherwise be
/// six SSH round trips into one.
const REMOTE_PROBE: &str = r#"
emit() { printf '%s\t%s\t%s\n' "$1" "$2" "$3"; }
for d in .venv venv env; do
  [ -x "$d/bin/python" ] && emit venv "$d/bin/python" "$d (in this project)"
done
if command -v poetry >/dev/null 2>&1; then
  p=$(poetry env info -p 2>/dev/null)
  [ -n "$p" ] && [ -x "$p/bin/python" ] && emit poetry "$p/bin/python" "poetry ($(basename "$p"))"
fi
[ -n "$VIRTUAL_ENV" ] && [ -x "$VIRTUAL_ENV/bin/python" ] && \
  emit active "$VIRTUAL_ENV/bin/python" "active \$VIRTUAL_ENV ($(basename "$VIRTUAL_ENV"))"
[ -n "$CONDA_PREFIX" ] && [ -x "$CONDA_PREFIX/bin/python" ] && \
  emit active "$CONDA_PREFIX/bin/python" "active \$CONDA_PREFIX ($(basename "$CONDA_PREFIX"))"
if command -v conda >/dev/null 2>&1; then
  conda env list 2>/dev/null | awk '!/^#/ && NF >= 2 { print $1, $NF }' | while read -r n p; do
    [ -x "$p/bin/python" ] && emit conda "$p/bin/python" "conda: $n"
  done
fi
if command -v pyenv >/dev/null 2>&1; then
  p=$(pyenv which python 2>/dev/null)
  [ -n "$p" ] && [ -x "$p" ] && emit pyenv "$p" "pyenv ($(basename "$p"))"
fi
p=$(command -v python3 || command -v python)
[ -n "$p" ] && emit system "$p" "system ($p)"
exit 0
"#;

/// Parse the `kind\tpath\tlabel` lines the remote probe emits.
pub fn parse_remote_probe(stdout: &str) -> Vec<PyInterpreter> {
    let mut out = Vec::new();
    for line in stdout.lines() {
        let mut f = line.splitn(3, '\t');
        let (Some(kind), Some(path), Some(label)) = (f.next(), f.next(), f.next()) else {
            continue;
        };
        if kind.is_empty() || path.is_empty() {
            continue;
        }
        out.push(PyInterpreter {
            kind: kind.to_string(),
            path: path.to_string(),
            label: label.to_string(),
        });
    }
    dedupe_and_rank(out)
}

// ── Commands ─────────────────────────────────────────────────────────────────

/// Every interpreter offered for `project_dir` — the dialog's dropdown. Probes the
/// **host** for a remote project (that is where its run tab will run).
#[tauri::command]
pub fn python_interpreters(project_dir: String) -> Result<Vec<PyInterpreter>, String> {
    if let Some(target) = crate::services::remote::remote_target_for_dir(&project_dir) {
        let out = crate::services::ssh_exec::run_remote_script(&target.spec, REMOTE_PROBE)?;
        return Ok(parse_remote_probe(&String::from_utf8_lossy(&out.stdout)));
    }
    Ok(discover_local(Path::new(&project_dir)))
}

/// The interpreter Run/Debug should use *right now*: the project's explicit choice
/// if it has one (no probing), else the best auto-detected candidate, else the
/// system default. This is the only thing `lib/pythonRun.ts` needs to ask.
#[tauri::command]
pub fn python_interpreter_for(
    project_id: Option<String>,
    project_dir: String,
) -> Result<String, String> {
    if let Some(pinned) = project_id.as_deref().and_then(project_python) {
        return Ok(pinned);
    }
    let found = python_interpreters(project_dir).unwrap_or_default();
    Ok(found
        .into_iter()
        .find(|i| auto_selectable(&i.kind))
        .map(|i| i.path)
        .unwrap_or_else(default_interpreter))
}

/// A project's pinned interpreter, read from the always-local `projects.json`
/// mirror (falling back to `project.json` for entries predating the mirror) — the
/// same two-store read as the sandbox spec.
fn project_python(project_id: &str) -> Option<String> {
    let list_path = storage::state_dir().join("projects.json");
    let list: ProjectsList = storage::read_json(&list_path).ok()?;
    let entry = list.iter().find(|p| p.id == project_id)?;
    entry
        .extra
        .get("python_interpreter")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .or_else(|| {
            storage::read_json::<Project>(&PathBuf::from(&entry.local_file))
                .ok()?
                .python_interpreter
        })
        .filter(|s| !s.trim().is_empty())
}

/// Pin (or clear, with `None`/blank) the project's interpreter. Written to both
/// stores, like the sandbox spec: the `projects.json` mirror is what the run path
/// reads, `project.json` keeps it with the project.
#[tauri::command]
pub fn set_project_python(
    project_id: String,
    interpreter: Option<String>,
) -> Result<Option<String>, String> {
    let value = interpreter
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let list_path = storage::state_dir().join("projects.json");
    let mut list: ProjectsList = if list_path.exists() {
        storage::read_json(&list_path).map_err(|e| e.to_string())?
    } else {
        Vec::new()
    };
    let entry = list
        .iter_mut()
        .find(|p| p.id == project_id)
        .ok_or_else(|| format!("project '{project_id}' not found"))?;

    match &value {
        Some(v) => {
            entry
                .extra
                .insert("python_interpreter".into(), serde_json::Value::String(v.clone()));
        }
        None => {
            entry.extra.remove("python_interpreter");
        }
    }
    let local_file = entry.local_file.clone();
    storage::write_json(&list_path, &list).map_err(|e| e.to_string())?;

    let proj_path = PathBuf::from(&local_file);
    if proj_path.exists() {
        if let Ok(mut project) = storage::read_json::<Project>(&proj_path) {
            project.python_interpreter = value.clone();
            storage::write_json(&proj_path, &project).map_err(|e| e.to_string())?;
        }
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conda_env_list_is_parsed_name_and_prefix() {
        let out = "# conda environments:\n#\nbase                  *  /home/u/miniconda3\nml-env                   /home/u/miniconda3/envs/ml-env\n";
        assert_eq!(
            parse_conda_envs(out),
            vec![
                ("base".to_string(), "/home/u/miniconda3".to_string()),
                (
                    "ml-env".to_string(),
                    "/home/u/miniconda3/envs/ml-env".to_string()
                ),
            ]
        );
    }

    #[test]
    fn conda_comments_and_short_lines_are_skipped() {
        assert!(parse_conda_envs("# nothing\n\ngarbage\n").is_empty());
    }

    #[test]
    fn remote_probe_lines_are_parsed() {
        let out = "venv\t.venv/bin/python\t.venv (in this project)\nsystem\t/usr/bin/python3\tsystem (/usr/bin/python3)\n";
        let got = parse_remote_probe(out);
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].kind, "venv");
        assert_eq!(got[0].path, ".venv/bin/python");
        assert_eq!(got[1].kind, "system");
    }

    #[test]
    fn malformed_probe_lines_are_dropped_not_fatal() {
        assert!(parse_remote_probe("garbage\nalso\tgarbage\n").is_empty());
    }

    #[test]
    fn ranking_puts_an_in_tree_venv_first_and_system_last() {
        let list = parse_remote_probe(
            "system\t/usr/bin/python3\tsystem\nconda\t/c/envs/x/bin/python\tconda: x\nvenv\t.venv/bin/python\t.venv\n",
        );
        assert_eq!(list[0].kind, "venv");
        assert_eq!(list.last().unwrap().kind, "system");
    }

    #[test]
    fn a_named_conda_env_is_offered_but_never_auto_selected() {
        // The dialog lists it; auto-detect must not pick one of N unrelated envs.
        assert!(!auto_selectable("conda"));
        assert!(auto_selectable("venv"));
        assert!(auto_selectable("poetry"));
        assert!(auto_selectable("system"));
    }

    #[test]
    fn duplicate_paths_collapse_to_the_higher_ranked_kind() {
        // A poetry env that is ALSO the active VIRTUAL_ENV must appear once.
        let list = parse_remote_probe(
            "active\t/e/x/bin/python\tactive\npoetry\t/e/x/bin/python\tpoetry (x)\n",
        );
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].kind, "poetry"); // ranked above "active"
    }

    #[test]
    fn local_discovery_finds_an_in_tree_venv_as_a_relative_path() {
        let tmp = std::env::temp_dir().join(format!("eldrun-py-{}", std::process::id()));
        let bin = tmp.join(".venv").join(if WINDOWS { "Scripts" } else { "bin" });
        std::fs::create_dir_all(&bin).unwrap();
        let py = bin.join(if WINDOWS { "python.exe" } else { "python" });
        std::fs::write(&py, b"#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&py, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        let found = discover_local(&tmp);
        // Relative, because the run tab's cwd is the project root.
        assert_eq!(found[0].kind, "venv");
        let expected = PathBuf::from(".venv")
            .join(venv_python_rel())
            .to_string_lossy()
            .into_owned();
        assert_eq!(found[0].path, expected);
        // The system interpreter is always offered as the last resort.
        assert!(found.iter().any(|i| i.kind == "system"));

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn local_discovery_with_no_venv_still_offers_the_system_interpreter() {
        let tmp = std::env::temp_dir().join(format!("eldrun-py-none-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let found = discover_local(&tmp);
        assert!(found.iter().any(|i| i.kind == "system"));
        assert!(!found.iter().any(|i| i.kind == "venv"));
        std::fs::remove_dir_all(&tmp).ok();
    }
}
