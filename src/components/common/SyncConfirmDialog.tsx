import { useT } from "../../lib/i18n";
import { fmtSize } from "../../lib/viewers/fileUtils";
import { useSyncConfirmStore } from "../../stores/syncConfirm";
import { UntestedTag } from "./UntestedTag";

/**
 * The confirmation every byte-sync transfer asks for, mounted once at the shell
 * like the HPC guard and the host-key prompt (a transfer can be started from the
 * file tree, the file view's toolbar, or the diverged-files list — in the main
 * window or in a popout — and they all ask through one dialog).
 *
 * What it is for: a pull writes the host's bytes over the mirror's and a push
 * writes the mirror's over the host's, so each is destructive to whichever side
 * is receiving. The old one-click buttons made the safe case (the other side has
 * nothing) and the lossy one (the other side has edits held nowhere else) look
 * identical. This states which one you are in — direction, scope, file count,
 * size, how much of it lands on top of something, and by name the files whose
 * content would be gone — and then gets out of the way.
 *
 * The numbers are the backend's read-only `sync_transfer_preview`. They may be
 * missing (still loading, failed, or a tree too big to inspect up front); the
 * dialog says so and keeps asking, because a preview is information and the
 * click is the gate.
 */
export function SyncConfirmDialog() {
  const t = useT();
  const pending = useSyncConfirmStore((s) => s.pending);
  const proceed = useSyncConfirmStore((s) => s.proceed);
  const cancel = useSyncConfirmStore((s) => s.cancel);

  if (!pending) return null;
  const { direction, isDir, relPath, label, relPaths, force, preview, loading, error } = pending;
  const pull = direction === "pull";
  // An explicit file list (the diverged-files view's bulk resolve) is its own
  // scope: it is neither the folder it happens to sit under nor the whole
  // project, and saying either would misstate what is about to be overwritten.
  const scope = relPaths
    ? "selected"
    : relPath === ""
      ? "project"
      : isDir
        ? "folder"
        : "file";
  // Nothing to move — offer only a way out rather than a confirm button that
  // would transfer nothing.
  const empty = !!preview && preview.files === 0;

  return (
    // Backdrop-dismissable: "I didn't mean to click that" is the most likely
    // answer here and should cost exactly one click, in any direction.
    <div className="modal-backdrop" onMouseDown={cancel}>
      <div className="file-delete-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <h2>
          {t(pull ? "syncConfirm.pullTitle" : "syncConfirm.pushTitle")} <UntestedTag />
        </h2>
        <p>
          {t(
            pull
              ? scope === "selected"
                ? "syncConfirm.pullSelected"
                : scope === "project"
                  ? "syncConfirm.pullProject"
                  : scope === "folder"
                    ? "syncConfirm.pullFolder"
                    : "syncConfirm.pullFile"
              : scope === "selected"
                ? "syncConfirm.pushSelected"
                : scope === "project"
                  ? "syncConfirm.pushProject"
                  : scope === "folder"
                    ? "syncConfirm.pushFolder"
                    : "syncConfirm.pushFile",
            { name: label, count: relPaths?.length ?? 0 },
          )}
        </p>
        <div className="file-delete-path">
          {relPaths
            ? relPaths.slice(0, 8).join(", ") +
              (relPaths.length > 8 ? ", …" : "")
            : relPath || t("syncConfirm.wholeProjectPath")}
        </div>

        {loading && <p className="sync-confirm-note">{t("syncConfirm.checking")}</p>}
        {error && <p className="sync-confirm-note">{t("syncConfirm.previewFailed", { error })}</p>}
        {preview && (
          <>
            <p>
              {empty
                ? t("syncConfirm.nothingToTransfer")
                : t("syncConfirm.willTransfer", {
                    count: preview.files.toLocaleString(),
                    size: fmtSize(preview.bytes),
                  })}
            </p>
            {!preview.exact && !empty && (
              <p className="sync-confirm-note">{t("syncConfirm.notInspected")}</p>
            )}
            {preview.exact && preview.overwrites > 0 && (
              <p className="sync-confirm-note">
                {t(
                  pull ? "syncConfirm.overwritesLocal" : "syncConfirm.overwritesHost",
                  { count: preview.overwrites.toLocaleString() },
                )}
              </p>
            )}
            {preview.conflicts > 0 && (
              <p className="sync-confirm-note">
                {t("syncConfirm.blockedConflicts", {
                  count: preview.conflicts.toLocaleString(),
                })}
              </p>
            )}
            {preview.destructiveTotal > 0 && (
              // The load-bearing part: these files hold changes that exist on no
              // other side, and this transfer is what ends them.
              <div className="sync-confirm-loss">
                <strong>
                  {t(
                    pull ? "syncConfirm.lossLocalTitle" : "syncConfirm.lossHostTitle",
                    { count: preview.destructiveTotal.toLocaleString() },
                  )}
                </strong>
                <ul>
                  {preview.destructive.map((rel) => (
                    <li key={rel}>{rel}</li>
                  ))}
                </ul>
                {preview.destructiveTotal > preview.destructive.length && (
                  <span className="sync-confirm-note">
                    {t("syncConfirm.andMore", {
                      count: (
                        preview.destructiveTotal - preview.destructive.length
                      ).toLocaleString(),
                    })}
                  </span>
                )}
              </div>
            )}
          </>
        )}
        {force && <p className="sync-confirm-note">{t("syncConfirm.forceNote")}</p>}

        <div className="file-delete-actions">
          <button type="button" onClick={cancel}>
            {t("common.cancel")}
          </button>
          {!empty && (
            <button
              type="button"
              className={
                preview && preview.destructiveTotal > 0 ? "danger" : undefined
              }
              onClick={proceed}
            >
              {t(pull ? "syncConfirm.confirmPull" : "syncConfirm.confirmPush")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
