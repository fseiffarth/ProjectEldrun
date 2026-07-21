import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "../../stores/settings";
import { runInstallInTab } from "../../lib/installCommand";
import type { CustomAgent } from "../../types";

interface Props {
  onClose: () => void;
}

/** Split a whitespace-separated arg string into an argv, honoring simple
 *  single/double quoting so a value with spaces stays one arg. Empty → []. */
function parseArgs(raw: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3] ?? "");
  }
  return out;
}

/** A minted id that doesn't depend on crypto being present in every webview. */
function mintId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `ca-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

/**
 * Manage the user's custom agents (Settings.custom_agents): list the existing
 * ones with a delete button, and an add form (label, command, optional args,
 * optional "continue last session" resume flag). Persisted globally via
 * `updateSettings`, so a new agent shows up in every add-tab menu's Agents group.
 *
 * A custom agent is only a launch command — Eldrun spawns `cmd` (+ args/env) as
 * an `agent` tab. The resume flag is the one extra capability: set it and the
 * tab survives a restart (cwd-continue tier, like Qwen/OpenCode/Gemini); leave it
 * blank and the tab is launch-only, dropped on restart like Aider.
 */
export function CustomAgentDialog({ onClose }: Props) {
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const agents = useMemo(() => settings?.custom_agents ?? [], [settings]);

  const [label, setLabel] = useState("");
  const [cmd, setCmd] = useState("");
  const [argsText, setArgsText] = useState("");
  const [resumeText, setResumeText] = useState("");
  const [installText, setInstallText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Installed status of each agent's command, so a missing one can offer its
  // one-click install. `null` until the probe resolves (rows render without a
  // status hint rather than flashing "not installed").
  const [installed, setInstalled] = useState<Set<string> | null>(null);
  useEffect(() => {
    const cmds = agents.map((a) => a.cmd);
    if (cmds.length === 0) {
      setInstalled(new Set());
      return;
    }
    invoke<string[]>("probe_binaries", { bins: cmds })
      .then((found) => setInstalled(new Set(found)))
      .catch(() => setInstalled(new Set()));
  }, [agents]);

  const persist = async (next: CustomAgent[]) => {
    setBusy(true);
    setError(null);
    try {
      await updateSettings({ custom_agents: next });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    const name = label.trim();
    const command = cmd.trim();
    if (!name || !command) {
      setError("A label and a command are both required.");
      return;
    }
    const args = parseArgs(argsText);
    const resumeArgs = parseArgs(resumeText);
    const install = installText.trim();
    const agent: CustomAgent = {
      id: mintId(),
      label: name,
      cmd: command,
      ...(args.length ? { args } : {}),
      ...(resumeArgs.length ? { resumeArgs } : {}),
      ...(install ? { installCmd: install } : {}),
    };
    await persist([...agents, agent]);
    setLabel("");
    setCmd("");
    setArgsText("");
    setResumeText("");
    setInstallText("");
  };

  const remove = (id: string) => void persist(agents.filter((a) => a.id !== id));

  // Run an agent's install command in a fresh root terminal tab (Eldrun's
  // install-via-tab policy). Closes the dialog so the terminal is in view.
  const install = (a: CustomAgent) => {
    if (!a.installCmd) return;
    runInstallInTab(`Install ${a.label}`, a.installCmd, "default");
    onClose();
  };

  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="settings-dialog custom-agent-dialog"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="settings-title-row">
          <h2>Custom agents</h2>
          <button type="button" className="dialog-close-btn" onClick={onClose}>×</button>
        </div>
        <div className="dialog-scroll">
        <p className="settings-help">
          Add any command-line agent so it appears in the <strong>Agents</strong>{" "}
          section of the new-tab menu. Eldrun launches the command in the project
          directory as an agent tab.
        </p>

        {agents.length > 0 && (
          <div className="custom-agent-list">
            {agents.map((a) => {
              const missing = installed != null && !installed.has(a.cmd);
              return (
                <div className="custom-agent-row" key={a.id}>
                  <span className="custom-agent-row-label">{a.label}</span>
                  <code className="custom-agent-row-cmd">
                    {[a.cmd, ...(a.args ?? [])].join(" ")}
                  </code>
                  {a.resumeArgs?.length ? (
                    <span className="custom-agent-row-tag" title="Survives a restart">
                      resumable
                    </span>
                  ) : null}
                  {missing &&
                    (a.installCmd ? (
                      <button
                        type="button"
                        className="custom-agent-install"
                        title={`Run: ${a.installCmd}`}
                        onClick={() => install(a)}
                      >
                        Install
                      </button>
                    ) : (
                      <span
                        className="custom-agent-row-missing"
                        title="Command not found on PATH"
                      >
                        not found
                      </span>
                    ))}
                  <button
                    type="button"
                    className="custom-agent-remove"
                    title="Remove this agent"
                    disabled={busy}
                    onClick={() => remove(a.id)}
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        )}

        <div className="custom-agent-form">
          <label className="custom-agent-field">
            <span>Label</span>
            <input
              value={label}
              placeholder="e.g. My Agent"
              autoFocus
              onChange={(e) => setLabel(e.target.value)}
            />
          </label>
          <label className="custom-agent-field">
            <span>Command</span>
            <input
              value={cmd}
              placeholder="e.g. my-agent  (binary name or full path)"
              spellCheck={false}
              onChange={(e) => setCmd(e.target.value)}
            />
          </label>
          <label className="custom-agent-field">
            <span>Arguments <em>(optional)</em></span>
            <input
              value={argsText}
              placeholder="e.g. --model gpt-x"
              spellCheck={false}
              onChange={(e) => setArgsText(e.target.value)}
            />
          </label>
          <label className="custom-agent-field">
            <span>Resume flag <em>(optional)</em></span>
            <input
              value={resumeText}
              placeholder="e.g. --continue  (keeps the tab across a restart)"
              spellCheck={false}
              onChange={(e) => setResumeText(e.target.value)}
            />
          </label>
          <label className="custom-agent-field">
            <span>Install command <em>(optional)</em></span>
            <input
              value={installText}
              placeholder="e.g. npm install -g @scope/my-agent"
              spellCheck={false}
              onChange={(e) => setInstallText(e.target.value)}
            />
          </label>
          <p className="settings-help">
            An install command lets Eldrun install the agent for you: when its
            binary isn&apos;t found, an <strong>Install</strong> button runs the
            command in a new root terminal tab. Any one-liner works (npm, pipx,
            curl&nbsp;| sh, …).
          </p>
          <p className="settings-help">
            A resume flag lets Eldrun relaunch the agent on its most recent session
            after a restart. Leave it blank if the agent has no such flag — the tab
            will simply start fresh next time.
          </p>
        </div>

        {error && <div className="settings-error">{error}</div>}

        <div className="project-dialog-actions">
          <button type="button" onClick={onClose}>Done</button>
          <button
            type="button"
            disabled={busy || !label.trim() || !cmd.trim()}
            onClick={() => void add()}
          >
            Add agent
          </button>
        </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
