import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { resolveProjectDirectory, type ProjectEntry } from "../../types";
import { useProjectsStore } from "../../stores/projects";
import { listInterpreters, type PyInterpreter } from "../../lib/pythonRun";

/**
 * Which Python the code viewer's Run/Debug buttons use for this project (#87).
 *
 * The default — and what almost every project should stay on — is **auto-detect**,
 * so the dialog leads with it and *shows what it currently resolves to* rather than
 * making the user trust an invisible decision. Pinning exists for the environments
 * auto-detect cannot pick on the user's behalf: one of N unrelated conda envs, an
 * interpreter outside the project tree, a second venv.
 *
 * The list is probed live (`python_interpreters`) — on a **remote** project that
 * probe runs on the *host*, which is the machine the run tab will actually run on,
 * so the paths offered here are the paths that will exist when Run is pressed.
 *
 * Shared: opened from the project pill's context menu and from the file viewer's
 * gear (Project Settings), so both surfaces edit the one pinned interpreter.
 */
export function PythonInterpreterWindow({
  project,
  onClose,
}: {
  project: ProjectEntry;
  onClose: () => void;
}) {
  const setProjectPython = useProjectsStore((s) => s.setProjectPython);
  const dir = resolveProjectDirectory(project);
  const AUTO = "";
  const CUSTOM = "__custom__";

  const [found, setFound] = useState<PyInterpreter[] | null>(null);
  const [probeError, setProbeError] = useState("");
  const pinned = project.python_interpreter ?? "";
  // A pinned path that isn't in the probed list is still legitimate (a hand-typed
  // one, or an env that has since gone away) — it opens as "Custom".
  const [choice, setChoice] = useState<string>(pinned || AUTO);
  const [custom, setCustom] = useState(pinned);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    listInterpreters(dir)
      .then((list) => {
        if (cancelled) return;
        setFound(list);
        // Re-home a pinned value that the probe did find, so it selects its own row.
        if (pinned && !list.some((i) => i.path === pinned)) setChoice(CUSTOM);
      })
      .catch((e) => {
        if (cancelled) return;
        setFound([]);
        setProbeError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [dir, pinned]);

  // What auto-detect would pick right now: the first entry the backend ranked as
  // auto-selectable. Named conda envs are offered but never auto-picked.
  const autoPick = found?.find((i) => i.kind !== "conda");

  const save = async () => {
    if (busy) return;
    const value =
      choice === AUTO ? null : choice === CUSTOM ? custom.trim() || null : choice;
    setBusy(true);
    setError("");
    try {
      await setProjectPython(project.id, value);
      onClose();
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  };

  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="project-dialog dialog-framed" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings-title-row">
          <h2>{project.name} — Python interpreter</h2>
          <button type="button" className="dialog-close-btn" onClick={onClose}>×</button>
        </div>
        <div className="dialog-scroll">
        <p className="settings-help">
          Used by the code viewer's Run and Debug buttons. Auto-detect is right for
          almost every project — pin one only when your environment lives somewhere
          Eldrun can't infer.
          {project.remote && " Probed on the host, since that is where this project runs."}
        </p>

        {found === null ? (
          <div className="file-viewer-loading">Looking for interpreters…</div>
        ) : (
          <>
            <label>
              Interpreter
              <select
                value={choice}
                onChange={(e) => setChoice(e.target.value)}
                disabled={busy}
              >
                <option value={AUTO}>
                  {autoPick
                    ? `Auto-detect — ${autoPick.path}`
                    : "Auto-detect"}
                </option>
                {found.map((i) => (
                  <option key={i.path} value={i.path}>
                    {i.label} — {i.path}
                  </option>
                ))}
                <option value={CUSTOM}>Custom path…</option>
              </select>
            </label>
            {choice === CUSTOM && (
              <label>
                Path to the interpreter
                <input
                  type="text"
                  value={custom}
                  placeholder="e.g. /opt/envs/ml/bin/python — relative paths resolve from the project root"
                  onChange={(e) => setCustom(e.target.value)}
                  spellCheck={false}
                  disabled={busy}
                />
              </label>
            )}
            {probeError && (
              <p className="settings-help">
                Couldn't probe for interpreters ({probeError}). You can still set one
                by hand.
              </p>
            )}
          </>
        )}

        {error && <div className="project-dialog-error">{error}</div>}
        <div className="project-dialog-actions">
          <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" onClick={() => void save()} disabled={busy || found === null}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
