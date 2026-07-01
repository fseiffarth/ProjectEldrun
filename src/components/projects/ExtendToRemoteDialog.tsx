import { useEffect, useState } from "react";
import type { ProjectEntry } from "../../types";
import { useProjectsStore } from "../../stores/projects";
import { joinRemotePath, sanitizeName } from "./scaffold";
import { useRemoteSession } from "./useRemoteSession";
import { RemoteProjectSection } from "./RemoteProjectSection";

/**
 * "Extend to remote…" modal for an existing **local** project. It attaches a
 * remote SSH spec without uploading any data: the empty remote root is created
 * on the host (as when creating a remote project directly) and the project's
 * current local directory becomes its local mirror in place. The user pushes
 * files up later via the normal manual-sync UI.
 *
 * The whole connect → browse flow is the same machinery the new-project dialog
 * uses — `useRemoteSession` (state/effects) + `RemoteProjectSection` (the SSH /
 * OpenVPN / folder-browser UI) — so there's no duplicated remote logic here. The
 * project name is fixed, so the "details" step is just a confirm summary.
 */
export function ExtendToRemoteDialog({
  project,
  onClose,
}: {
  project: ProjectEntry;
  onClose: () => void;
}) {
  // The remote path leaf and local-mirror-relative name both use the project's
  // sanitized name, matching direct remote creation (kind "new").
  const safeName = sanitizeName(project.name);
  const extendProjectToRemote = useProjectsStore((s) => s.extendProjectToRemote);

  const remote = useRemoteSession({ kind: "new" });
  const {
    isRemoteProject,
    toggleRemoteProject,
    step,
    setStep,
    remoteBrowsePath,
    setRemoteChosenPath,
    remoteChosenPath,
    remoteReady,
    buildRemoteSpec,
  } = remote;

  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // This dialog is always remote — enable remote mode on mount so the tooling
  // probe + recent addresses/configs load and RemoteProjectSection renders.
  useEffect(() => {
    if (!isRemoteProject) toggleRemoteProject(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Commit the browsed folder as the parent and advance to the confirm step
  // (mirrors ProjectDialog's useThisRemoteFolder; name is fixed so no form).
  const useThisRemoteFolder = () => {
    setRemoteChosenPath(remoteBrowsePath || "/");
    setStep("details");
  };

  const submit = async () => {
    const spec = buildRemoteSpec(safeName);
    if (!spec) {
      setError("Connect and choose a remote folder first.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await extendProjectToRemote(project.id, spec);
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  const remotePath = joinRemotePath(remoteChosenPath || "/", safeName || project.name);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="project-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <h2>Extend “{project.name}” to remote</h2>
        <p className="ssh-optional-hint">
          Attach a remote SSH host to this project. The empty remote folder is
          created on the host; your existing local files become the synced working
          copy and stay put. Nothing is uploaded until you push it manually.
        </p>

        <RemoteProjectSection
          kind="new"
          safeName={safeName}
          onClose={onClose}
          onUseThisFolder={useThisRemoteFolder}
          remote={remote}
        />

        {step === "details" && (
          <div className="project-dialog-path">
            Will create <code>{remotePath}</code> on the host and pair it with this
            project’s local files.
          </div>
        )}

        {error && <div className="project-dialog-error">{error}</div>}

        <div className="project-dialog-actions">
          <button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy || !remoteReady}
            title={
              remoteReady
                ? "Attach the remote host to this project"
                : "Connect and choose a remote folder first"
            }
          >
            {busy ? "Extending…" : "Extend to remote"}
          </button>
        </div>
      </div>
    </div>
  );
}
