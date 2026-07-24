import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { resolveProjectDirectory, type ProjectEntry } from "../../types";
import { useProjectsStore } from "../../stores/projects";
import { useRemoteStatusStore } from "../../stores/remoteStatus";
import { useBigFoldersStore } from "../../stores/bigFolders";
import { joinRemotePath, sanitizeName } from "./scaffold";
import { useRemoteSession, type RemoteStep } from "./useRemoteSession";
import { RemoteProjectSection } from "./RemoteProjectSection";
import { targetLabel } from "../header/MachinesIndicator";
import type { DroppedGlobalMachine } from "../../stores/remoteMachines";
import { useT } from "../../lib/i18n";

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
 *
 * `initialMachine` seeds the SSH address from a global machine
 * (`MachinesIndicator`) dropped onto this (local-only) project's pill — this
 * dialog becomes the "make this machine the project's primary" flow. It only
 * prefills the address field; the user still authenticates here (the global
 * machine's own connection is a separate pooled session keyed by its own id,
 * not by this project), though a saved password for that host target is
 * picked up automatically since the keychain is keyed by host, not project.
 */
export function ExtendToRemoteDialog({
  project,
  initialMachine,
  onClose,
}: {
  project: ProjectEntry;
  initialMachine?: DroppedGlobalMachine;
  onClose: () => void;
}) {
  const t = useT();
  // The remote path leaf and local-mirror-relative name both use the project's
  // sanitized name, matching direct remote creation (kind "new").
  const safeName = sanitizeName(project.name);
  const extendProjectToRemote = useProjectsStore((s) => s.extendProjectToRemote);

  const remote = useRemoteSession({ kind: "new" });
  const {
    isRemoteProject,
    toggleRemoteProject,
    winManual,
    isRemote,
    step,
    setStep,
    remoteBrowsePath,
    setRemoteChosenPath,
    remoteChosenPath,
    remoteReady,
    remotePassword,
    onSshAddressChange,
    buildRemoteSpec,
  } = remote;

  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Footer step machine, borrowed verbatim from the new-project dialog so the
  // extend flow gets the same Back/Next navigation (the details step must be
  // able to step back to re-pick the remote folder). Windows non-headless skips
  // the browse step (it types the path in connect).
  const remoteSteps: RemoteStep[] = winManual
    ? ["connect", "details"]
    : ["connect", "browse", "details"];
  const stepIdx = remoteSteps.indexOf(step);
  const goBack = () => setStep(remoteSteps[Math.max(0, stepIdx - 1)]);
  const goNext = () => setStep(remoteSteps[Math.min(remoteSteps.length - 1, stepIdx + 1)]);
  const canNext =
    step === "connect"
      ? winManual
        ? remoteChosenPath.trim() !== ""
        : isRemote
      : step === "browse"
        ? remoteChosenPath.trim() !== ""
        : false;

  // This dialog is always remote — enable remote mode on mount so the tooling
  // probe + recent addresses/configs load and RemoteProjectSection renders.
  // Dropped from a global machine: also seed the address field so the user
  // only has to authenticate, not re-type the host.
  useEffect(() => {
    if (!isRemoteProject) toggleRemoteProject(true);
    if (initialMachine) onSshAddressChange(targetLabel(initialMachine));
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
      setError(t("extendRemote.connectFirstError"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      await extendProjectToRemote(project.id, spec);
      // Reaching this step required a live, authenticated SSH session (the flow
      // browsed/created the remote folder over it). Carry that straight over to the
      // now-remote project rather than dropping it to a "Connect" prompt: open its
      // pooled SSH/SFTP channel and light the SSH lamp green. Fire-and-forget — the
      // lamp reflects connecting → connected as it resolves.
      //
      // Hand it the credential the dialog authenticated with (empty for a key-auth
      // host). Riding the still-live ControlMaster password-less would connect too,
      // but the backend reads a password-less connect with nothing in the keychain as
      // *key* auth and records `key_auth: true` — on a password host that is a lie the
      // project keeps, and auto-connect later believes.
      // A single attempt right after `remote_mkdir_p` can lose to a host session
      // that hasn't finished settling yet — mirrors `ensureRemotePool`'s retry
      // cadence (used on ordinary project activation) instead of parking the lamp
      // on "error" forever after one transient hiccup, with the live ControlMaster
      // underneath never actually going away.
      const status = useRemoteStatusStore.getState();
      status.setSsh(project.id, "connecting");
      const connectPassword = remotePassword || null;
      let connectAttempts = 0;
      const maxConnectAttempts = 6;
      const tryConnect = () => {
        void invoke("remote_connect", {
          projectId: project.id,
          password: connectPassword,
          // With no password to hand over (non-headless, or a key host), this can only
          // be riding the master the dialog's login left up — say so, so the backend
          // doesn't record the very `key_auth: true` lie the comment above describes.
          viaLogin: !connectPassword,
        })
          .then(() => useRemoteStatusStore.getState().setSsh(project.id, "connected"))
          .catch((err) => {
            if (++connectAttempts >= maxConnectAttempts) {
              console.warn("remote_connect after extend failed", err);
              useRemoteStatusStore.getState().setSsh(project.id, "error");
              return;
            }
            setTimeout(tryConnect, 4000);
          });
      };
      tryConnect();
      // The existing local folder is about to become a synced working copy, so
      // this is the last cheap moment to ask which of its giant folders (a
      // `.venv`, a build dir, a data drop) should never cross. The prompt walks
      // the local side straight away and fills in the host column when the
      // connect above lands.
      useBigFoldersStore.getState().openOnce(project.id);
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  const remotePath = joinRemotePath(remoteChosenPath || "/", safeName || project.name);
  // The local files stay in place, so the mirror is the project's current dir.
  const localPath = resolveProjectDirectory(project);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="project-dialog dialog-framed" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings-title-row">
          <h2>{t("extendRemote.title", { name: project.name })}</h2>
          <button type="button" className="dialog-close-btn" onClick={onClose}>×</button>
        </div>
        <div className="dialog-scroll">
        <p className="ssh-optional-hint">
          {initialMachine ? (
            <>
              {t("extendRemote.attachPre")} <strong>{initialMachine.label || initialMachine.host}</strong>{" "}
              {t("extendRemote.attachMid")}
            </>
          ) : (
            t("extendRemote.attachGeneric")
          )}
        </p>

        <RemoteProjectSection
          kind="new"
          safeName={safeName}
          onClose={onClose}
          onUseThisFolder={useThisRemoteFolder}
          remote={remote}
        />

        {step === "details" && (
          <div className="project-dialog-path extend-summary">
            <span>{t("extendRemote.summaryLede")}</span>
            <div className="extend-path-row">
              <span className="extend-path-label">{t("extendRemote.local")}</span>
              <code className="extend-remote-path">{localPath}</code>
            </div>
            <div className="extend-path-row">
              <span className="extend-path-label">{t("extendRemote.remote")}</span>
              <code className="extend-remote-path">{remotePath}</code>
            </div>
          </div>
        )}

        {error && <div className="project-dialog-error">{error}</div>}

        <div className="project-dialog-actions">
          <button type="button" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </button>
          {stepIdx > 0 && (
            <button type="button" disabled={busy} onClick={goBack}>
              {t("common.back")}
            </button>
          )}
          {step !== "details" ? (
            <button type="button" disabled={!canNext || busy} onClick={goNext}>
              {t("common.next")}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void submit()}
              disabled={busy || !remoteReady}
              title={t(remoteReady ? "extendRemote.readyTitle" : "extendRemote.notReadyTitle")}
            >
              {busy ? t("extendRemote.extending") : t("extendRemote.extendToRemote")}
            </button>
          )}
        </div>
        </div>
      </div>
    </div>
  );
}
