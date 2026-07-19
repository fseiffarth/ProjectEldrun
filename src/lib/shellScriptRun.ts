import { relativePathWithin } from "./paths";
import type { TabLocation } from "../stores/tabs";
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
 *  rows, and explicitly pin the tab locality to match the selected side. */
export function shellScriptRunPlan(opts: {
  project: ProjectEntry | null | undefined;
  treeRoot: string;
  syncSource?: "remote" | "local";
  scriptPath: string;
  interp: ScriptShell;
}): ShellScriptRunPlan | null {
  const remote = opts.project?.remote;
  const isRemoteProject = !!remote;
  const runsRemote = isRemoteProject && opts.syncSource !== "local";
  const root = runsRemote ? remote.remote_path : opts.treeRoot;
  const scriptRel = scriptRelFromRoot(root, opts.scriptPath);
  if (!scriptRel) return null;
  return {
    cwd: root,
    scriptRel,
    initialInput: shellRunCommand(opts.interp, scriptRel),
    location: isRemoteProject ? (runsRemote ? "remote" : "local") : undefined,
  };
}
