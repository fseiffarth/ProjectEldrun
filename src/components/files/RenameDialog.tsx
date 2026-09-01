import { useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../lib/i18n";
import { UntestedTag } from "../common/UntestedTag";

/**
 * Renaming a file or folder, in Eldrun's own chrome.
 *
 * Both file surfaces used to call `window.prompt()`, which WebKitGTK renders as
 * a bare browser alert headed with the page origin — "localhost:1420 says" in a
 * dev window, a blank system box in a packaged one. It ignores the theme, cannot
 * say what folder the file is in, and reports a failed rename by throwing the
 * typed name away.
 *
 * Shared rather than written twice: `FileTree` (the panel/Files-tab tree) and
 * `FileBrowser` (the middle file browser) both rename, and a rename that looks
 * and behaves differently depending on which pane you started it from is exactly
 * the drift the shared-viewer rule exists to stop. Rides `.file-delete-dialog`,
 * the chrome the tree's other prompts already use.
 */
export function RenameDialog({
  entryName,
  isDir,
  folder,
  onCancel,
  onRename,
}: {
  /** Current name, pre-filled into the field. */
  entryName: string;
  /** Folders get the folder wording and no extension-aware selection. */
  isDir: boolean;
  /** Containing folder, named so the user can see *which* copy this is. */
  folder: string;
  onCancel: () => void;
  /** Performs the rename. Rejecting keeps the dialog open with the message on
   *  it; resolving leaves closing to the caller (which unmounts this). */
  onRename: (next: string) => Promise<void>;
}) {
  const t = useT();
  const [name, setName] = useState(entryName);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const trimmed = name.trim();
  const submittable = !busy && trimmed.length > 0 && trimmed !== entryName;

  async function submit() {
    if (!submittable) return;
    // A path separator would not rename but move — refused here rather than left
    // to the backend, so the message lands next to the field that caused it.
    if (trimmed.includes("/") || trimmed.includes("\\")) {
      setError(t("fileTree.invalidFileName"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onRename(trimmed);
    } catch (e) {
      // Kept open with the failure on it: the name is usually one character away
      // from working (a collision, a bad character), and closing would make the
      // user type it again.
      setError(String(e));
      setBusy(false);
    }
  }

  return createPortal(
    <div className="modal-backdrop" onMouseDown={() => !busy && onCancel()}>
      <div className="file-delete-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <h2>
          {t(isDir ? "fileTree.renameFolderTitle" : "fileTree.renameFileTitle")} <UntestedTag />
        </h2>
        <p>
          <strong>{entryName}</strong> {t("fileTree.renameInPre")} <strong>{folder}</strong>{" "}
          {t("fileTree.renameToPost")}
        </p>
        <input
          className="file-paste-name"
          autoFocus
          aria-label={t("fileTree.renameToPrompt")}
          value={name}
          disabled={busy}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
            if (e.key === "Escape") onCancel();
          }}
          // Selects the stem, not the extension: renaming a file almost never
          // means renaming ".tsx", so the suffix stays put while the part being
          // changed is already highlighted.
          onFocus={(e) => {
            const dot = isDir ? -1 : entryName.lastIndexOf(".");
            e.currentTarget.setSelectionRange(0, dot > 0 ? dot : entryName.length);
          }}
        />
        {error && <div className="file-delete-path file-delete-error">{error}</div>}
        <div className="file-delete-actions">
          <button type="button" onClick={onCancel} disabled={busy}>
            {t("common.cancel")}
          </button>
          <button type="button" onClick={submit} disabled={!submittable}>
            {t("common.rename")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** The containing folder's display name for `folder`, from an entry's absolute
 *  path — the project root falls back to a phrase rather than an empty string. */
export function containingFolderLabel(absPath: string, rootLabel: string): string {
  const parent = absPath.slice(0, absPath.lastIndexOf("/"));
  const base = parent.slice(parent.lastIndexOf("/") + 1);
  return base || rootLabel;
}
