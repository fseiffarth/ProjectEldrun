/**
 * Run and debug a Python file from the native code viewer (#py).
 *
 * Both buttons do the same structural thing: open a **terminal tab** in the
 * project and type a command into it. That is deliberate, and it is what makes
 * the feature work everywhere Eldrun already works, for free — a shell tab on a
 * remote (SSH) project runs on the host, and one on a containerised project runs
 * inside the container, because the tab is the thing that carries locality and
 * sandboxing. A bespoke "run" IPC path would have to re-derive both and would get
 * them wrong.
 *
 * It also means the process is a *visible, interactive terminal*: a script that
 * prompts for input works, Ctrl+C works, and the shell survives the program's
 * exit so the output (and the traceback) stays on screen and ↑ re-runs it. This
 * is the same one-click-open-a-tab-and-run policy as `installCommand.ts`.
 *
 * Debugging is pdb, driven from the gutter's breakpoints: they are handed to it
 * as `-c "b file:N"` commands, followed by `-c continue` so the session runs
 * straight to the first one instead of halting on line 1. With no breakpoints set
 * we omit the `continue` and let pdb stop at the top of the file, which is the
 * only sensible reading of "debug this with no breakpoints".
 */

import { invoke } from "@tauri-apps/api/core";
import { basename, dirname } from "./paths";
import { useTabsStore } from "../stores/tabs";

export type PyPlatform = "windows" | "unix";

/** The env vars that mark a terminal tab as a viewer-launched run/debug of a
 *  specific file. They are real env vars (the process can see them), and they are
 *  also how a re-run finds the tab it should replace — a tab has no free-form
 *  metadata, and matching on the label would collide across two `main.py`s in
 *  different directories. */
export const PY_TARGET_ENV = "ELDRUN_PY_TARGET";
export const PY_MODE_ENV = "ELDRUN_PY_MODE";

export type PyRunMode = "run" | "debug";

/** Quote one shell argument. `cmd.exe` (Windows' default shell, via COMSPEC) has
 *  no single-quote syntax, so the two platforms genuinely differ. */
export function shellQuote(arg: string, platform: PyPlatform): string {
  if (platform === "windows") return `"${arg.replace(/"/g, '""')}"`;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** The last-resort interpreter when the backend can't be reached at all. */
export function systemInterpreter(platform: PyPlatform): string {
  return platform === "windows" ? "python" : "python3";
}

/** `<interp> <file>` — the Run button's command line. */
export function buildRunCommand(interp: string, file: string, platform: PyPlatform): string {
  return `${shellQuote(interp, platform)} ${shellQuote(file, platform)}`;
}

/**
 * The Debug button's command line: pdb, pre-loaded with the gutter's breakpoints.
 *
 * `python -m pdb -c "b f.py:12" -c continue f.py` sets the breakpoints before the
 * script starts and then runs to the first one. Without breakpoints the trailing
 * `continue` is omitted — otherwise pdb would run the program to completion and
 * "debug" would be indistinguishable from "run".
 */
export function buildDebugCommand(
  interp: string,
  file: string,
  breakpoints: number[],
  platform: PyPlatform,
): string {
  const parts = [shellQuote(interp, platform), "-m", "pdb"];
  const sorted = [...new Set(breakpoints)].sort((a, b) => a - b);
  for (const line of sorted) {
    parts.push("-c", shellQuote(`b ${file}:${line}`, platform));
  }
  if (sorted.length > 0) parts.push("-c", shellQuote("continue", platform));
  parts.push(shellQuote(file, platform));
  return parts.join(" ");
}

/** One interpreter the project could run — what `python_interpreters` offers the
 *  picker. `kind` is `venv|poetry|conda|pyenv|active|system`. */
export interface PyInterpreter {
  kind: string;
  path: string;
  label: string;
}

/** Every interpreter this project could use (the picker's list). Probes the HOST
 *  for a remote project — that is the machine the run tab will run on. */
export function listInterpreters(projectDir: string): Promise<PyInterpreter[]> {
  return invoke<PyInterpreter[]>("python_interpreters", { projectDir });
}

/** Pin the project's interpreter (or clear it back to auto-detect with `null`). */
export function setProjectPython(
  projectId: string,
  interpreter: string | null,
): Promise<string | null> {
  return invoke<string | null>("set_project_python", { projectId, interpreter });
}

/**
 * The interpreter to run with, right now.
 *
 * The backend owns the precedence (`commands::python`) — the project's pinned
 * choice if it has one, else the best auto-detected environment (in-tree venv →
 * poetry → active `VIRTUAL_ENV`/`CONDA_PREFIX` → pyenv → system). Deliberately not
 * re-implemented here: two rankings that can disagree is a bug waiting to happen,
 * and only the backend can see conda/poetry at all.
 */
export async function resolveInterpreter(
  projectId: string | null,
  projectDir: string,
  platform: PyPlatform,
): Promise<string> {
  try {
    return await invoke<string>("python_interpreter_for", { projectId, projectDir });
  } catch {
    // A disconnected/unreadable project is not a reason to refuse to run: fall
    // back to the system interpreter and let the terminal report the truth.
    return systemInterpreter(platform);
  }
}

export function currentPlatform(): PyPlatform {
  return navigator.userAgent.includes("Windows") ? "windows" : "unix";
}

/** The label a run/debug tab carries. */
export function pyTabLabel(mode: PyRunMode, file: string): string {
  return `${mode === "debug" ? "🐞" : "▶"} ${basename(file)}`;
}

/**
 * Open a terminal tab running `command` for `file`, replacing the previous
 * run/debug tab for that same file and mode.
 *
 * Replacing rather than reusing is the deliberate choice: re-typing the command
 * into a *live* tab would send it to whatever is already running there (a pdb
 * prompt, or a script blocked on input) instead of to a shell. Closing the old
 * tab kills that PTY, so every run starts from a known-clean process.
 */
export function openPythonTab(opts: {
  mode: PyRunMode;
  file: string;
  /** cwd for the tab — the project root, so relative paths and the venv resolve. */
  projectDir: string;
  /** The scope owning the tab: the project's id, or "root". */
  scope: string;
  command: string;
}): void {
  const { mode, file, projectDir, scope, command } = opts;
  const store = useTabsStore.getState();

  const prior = store.tabs.find(
    (t) =>
      t.kind === "shell" &&
      t.env?.[PY_TARGET_ENV] === file &&
      t.env?.[PY_MODE_ENV] === mode,
  );
  if (prior) store.removeTab(prior.key);

  const entry = useTabsStore.getState().addTabToScope(scope, {
    label: pyTabLabel(mode, file),
    cmd: "", // the host's default shell
    cwd: projectDir,
    kind: "shell",
    env: { [PY_TARGET_ENV]: file, [PY_MODE_ENV]: mode },
    initialInput: command,
  });
  useTabsStore.getState().setActive(entry.key);
}

/** Run `file` in a fresh terminal tab. */
export async function runPythonFile(opts: {
  file: string;
  projectDir: string;
  scope: string;
  /** The project whose pinned interpreter applies; null in the root scope. */
  projectId: string | null;
}): Promise<void> {
  const platform = currentPlatform();
  const interp = await resolveInterpreter(opts.projectId, opts.projectDir, platform);
  openPythonTab({
    mode: "run",
    file: opts.file,
    projectDir: opts.projectDir,
    scope: opts.scope,
    command: buildRunCommand(interp, opts.file, platform),
  });
}

/** Debug `file` under pdb, breaking on `breakpoints` (1-based lines). */
export async function debugPythonFile(opts: {
  file: string;
  projectDir: string;
  scope: string;
  projectId: string | null;
  breakpoints: number[];
}): Promise<void> {
  const platform = currentPlatform();
  const interp = await resolveInterpreter(opts.projectId, opts.projectDir, platform);
  openPythonTab({
    mode: "debug",
    file: opts.file,
    projectDir: opts.projectDir,
    scope: opts.scope,
    command: buildDebugCommand(interp, opts.file, opts.breakpoints, platform),
  });
}

/** The project root to run from: the project's directory when the viewer has one,
 *  else the file's own directory (a file opened in the root scope). */
export function runCwd(projectDir: string | null | undefined, file: string): string {
  return projectDir && projectDir.trim() ? projectDir : dirname(file) || "/";
}
