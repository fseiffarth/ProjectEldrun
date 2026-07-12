import { useTabsStore } from "../stores/tabs";
import { useProjectsStore } from "../stores/projects";

/**
 * One-click "install in a terminal tab" helper.
 *
 * Eldrun's policy is that any install-via-command flow (Ollama models, agent
 * CLIs, and external tools like a LaTeX/TeX distribution or sshfs) must be a
 * single click that opens a fresh terminal tab and *runs* the command — never a
 * "copy this command and run it yourself" manual step.
 *
 * The command is typed into the freshly-spawned shell via the tab's
 * `initialInput`; `TerminalView` submits it with a trailing CR once the shell is
 * ready, so the install actually executes. Interactive prompts (a `sudo`
 * password, MiKTeX's installer, etc.) are answered directly in that visible
 * terminal — Eldrun never has to handle them.
 *
 * The tab opens in the **root** scope (installs are machine-global, not project
 * scoped). The active project is deliberately left unchanged — switching scope
 * from a settings click would be jarring — so a brief toast points the user at
 * the root terminal where the install is running.
 */
export type InstallShellKind = "bash" | "powershell" | "default";

/** Explicit terminal program for an installer shell. Shell-specific syntax must
 * never be submitted to the host's unrelated default shell. */
export function installShellCommand(shellKind: InstallShellKind): string {
  if (shellKind === "bash") return "/bin/bash";
  if (shellKind === "powershell") return "powershell.exe";
  return "";
}

export function runInstallInTab(
  label: string,
  command: string,
  shellKind: InstallShellKind,
): void {
  const rootDir = useProjectsStore.getState().rootDir ?? "";
  useTabsStore.getState().addTabToScope("root", {
    label,
    cmd: installShellCommand(shellKind),
    cwd: rootDir, // empty resolves to ~/eldrun/root on the backend
    kind: "shell",
    initialInput: command,
  });
  useProjectsStore.setState({
    switchToast: `Installing ${label} — running in the root terminal`,
  });
}
