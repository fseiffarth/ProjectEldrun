import { relativePathWithin } from "./paths";
import { isRemoteLocation, type TabLocation } from "../stores/tabs";
import type { ProjectEntry } from "../types";

export type ScriptShell = "bash" | "zsh" | "fish" | "ksh" | "powershell" | "cmd";

export interface ShellScriptRunPlan {
  cwd: string;
  scriptRel: string;
  initialInput: string;
  location?: TabLocation;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Which interpreter runs a script of this extension, keyed by lowercased ending.
 *  The cross-platform shells run everywhere; `.ps1`/`.bat`/`.cmd` are Windows-only
 *  here (`pwsh` on Linux is too rarely installed to advertise the action). Returns
 *  null for an ending we don't know how to run, so no Run button is offered. */
export function shellRunnerFor(
  extension: string | null,
  platform: "windows" | string,
): ScriptShell | null {
  const ext = (extension ?? "").toLowerCase();
  const win = platform === "windows";
  switch (ext) {
    case ".sh":
    case ".bash":
      return "bash";
    case ".zsh":
      return "zsh";
    case ".fish":
      return "fish";
    case ".ksh":
      return "ksh";
    case ".ps1":
      return win ? "powershell" : null;
    case ".bat":
    case ".cmd":
      return win ? "cmd" : null;
    default:
      return null;
  }
}

/** The command line that runs `scriptRel` under `interp`. PowerShell and cmd take
 *  a flag before the path; the POSIX shells take it as a bare argument. */
export function shellRunCommand(interp: ScriptShell, scriptRel: string): string {
  const quoted = shellQuote(scriptRel);
  if (interp === "powershell") return `powershell -File ${quoted}`;
  if (interp === "cmd") return `cmd /c ${quoted}`;
  return `${interp} ${quoted}`;
}

export function scriptRelFromRoot(root: string, absPath: string): string | null {
  const rel = relativePathWithin(root, absPath);
  return rel && rel.trim() ? rel : null;
}

/** Build the foreground terminal-tab run for a shell script from the tree side the
 *  user is browsing. Mount-free remote listings return host paths, while the
 *  tree's `projectDir` is the local state dir; using that dir to relativize a
 *  host path produced `bash ''`. Use the host `remote_path` for remote-source
 *  rows to compute the script's project-relative path.
 *
 *  WHERE the script runs is the project's run-host preference (`runHostPref`, the
 *  machine chosen in the `RunHostPicker`) when set — so "pick machine X ⇒ shells
 *  run on X" holds for a script Run exactly as for a Python Run — falling back to
 *  the browsed side. `scriptRel` is project-relative, so it resolves against the
 *  chosen host's own project root (the backend re-cds into the target host's
 *  `remote_path`) or the local mirror, whichever the run location names — the two
 *  sides mirror the same tree. */
export function shellScriptRunPlan(opts: {
  project: ProjectEntry | null | undefined;
  treeRoot: string;
  syncSource?: "remote" | "local";
  scriptPath: string;
  interp: ScriptShell;
  /** The project's run-host preference (`useRunHostPrefStore`), if any. */
  runHostPref?: TabLocation;
}): ShellScriptRunPlan | null {
  const remote = opts.project?.remote;
  const isRemoteProject = !!remote;
  const browsedRemote = isRemoteProject && opts.syncSource !== "local";
  // The script's project-relative path, computed from the side it was browsed on
  // (that is the side `scriptPath` belongs to).
  const browsedRoot = browsedRemote ? remote.remote_path : opts.treeRoot;
  const scriptRel = scriptRelFromRoot(browsedRoot, opts.scriptPath);
  if (!scriptRel) return null;
  // The run location: the chosen machine wins; unset ⇒ the browsed side.
  const location: TabLocation | undefined = isRemoteProject
    ? (opts.runHostPref ?? (browsedRemote ? "remote" : "local"))
    : undefined;
  // The tab cwd must match the run side so `scriptRel` resolves: the host project
  // root for a remote run (the backend re-cds into the *target* host's remote_path
  // anyway), the local mirror for a local run.
  const runsRemote = location ? isRemoteLocation(location) : false;
  const cwd = runsRemote && remote ? remote.remote_path : opts.treeRoot;
  return {
    cwd,
    scriptRel,
    initialInput: shellRunCommand(opts.interp, scriptRel),
    location,
  };
}
