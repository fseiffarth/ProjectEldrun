import { useState, type ReactNode } from "react";
import { Dropdown } from "../common/Dropdown";
import { fileIcon, folderIcon } from "../../lib/viewers/fileUtils";
import type { RemoteEntry } from "../../types";

/** Extension (".py", ".md", …) of a remote listing entry, for picking its
 *  file-type icon the same way the right-hand file tree does. A leading-dot
 *  name (e.g. ".gitignore") has no extension, so it falls back to the generic
 *  file icon. Shared by every remote folder picker. */
export function remoteEntryExt(name: string): string | null {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : null;
}

/**
 * The live remote folder picker (`.remote-browser` chrome): a breadcrumb + go-up
 * + recently-used jump, an inline "new folder" entry, the directory listing, and
 * a footer. It owns only the new-folder input's transient text; every other bit
 * of state (path, entries, busy/error) is the caller's, so the SAME browser
 * serves the new/extend project flow (`RemoteProjectSection`, over
 * `useRemoteSession`) and the add-worker-machine flow (`RemoteMachinesWindow`,
 * over one-shot SFTP) with no duplicated markup.
 */
export function RemoteFolderBrowser({
  path,
  entries,
  busy,
  error,
  recentPaths,
  onGoUp,
  onJumpPath,
  onEnterFolder,
  onUseFolder,
  onCreateFolder,
  footer,
  useFolderLabel = "Use this folder",
}: {
  path: string;
  entries: RemoteEntry[];
  busy: boolean;
  error: string;
  recentPaths: string[];
  onGoUp: () => void;
  onJumpPath: (p: string) => void;
  onEnterFolder: (entry: RemoteEntry) => void;
  onUseFolder: () => void;
  onCreateFolder: (name: string) => void;
  /** The `.remote-chosen` footer line — a "Will create: …" summary in the
   *  project flow, a plain hint in the add-machine flow. */
  footer: ReactNode;
  useFolderLabel?: string;
}) {
  const [newFolderName, setNewFolderName] = useState("");
  const submitNewFolder = () => {
    const name = newFolderName.trim();
    if (!name) return;
    onCreateFolder(name);
    setNewFolderName("");
  };

  return (
    <div className="remote-browser" role="group" aria-label="Remote folder browser">
      <div className="remote-browser-header">
        <button type="button" className="remote-up-btn" onClick={onGoUp} title="Go up">
          ..
        </button>
        <span className="remote-breadcrumb" title={path}>
          {path || "/"}
        </span>
        {recentPaths.length > 0 && (
          <Dropdown
            className="vpn-config-recent"
            value=""
            placeholder="Recently used…"
            title="Jump to a previously-used remote path for this host"
            onChange={(v) => {
              if (v) onJumpPath(v);
            }}
            options={recentPaths.map((p) => ({ value: p, label: p }))}
          />
        )}
        <button type="button" onClick={onUseFolder}>
          {useFolderLabel}
        </button>
      </div>
      <div className="remote-newfolder">
        <input
          type="text"
          className="remote-newfolder-input"
          placeholder="New folder name…"
          value={newFolderName}
          onChange={(e) => setNewFolderName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submitNewFolder();
            }
          }}
          disabled={busy}
        />
        <button
          type="button"
          onClick={submitNewFolder}
          disabled={busy || !newFolderName.trim()}
          title="Create a new folder here"
        >
          + Add folder
        </button>
      </div>
      <div className="remote-list">
        {busy && <div className="scaffold-empty">Listing...</div>}
        {!busy && error && <div className="project-dialog-error">{error}</div>}
        {!busy && !error && entries.length === 0 && (
          <div className="scaffold-empty">Empty folder.</div>
        )}
        {!busy &&
          !error &&
          entries.map((entry) => (
            <div
              key={entry.name}
              className={`remote-entry ${entry.is_dir ? "is-dir" : "is-file"}`}
              role={entry.is_dir ? "button" : undefined}
              tabIndex={entry.is_dir ? 0 : undefined}
              onClick={() => onEnterFolder(entry)}
              onKeyDown={(e) => {
                if (entry.is_dir && (e.key === "Enter" || e.key === " ")) {
                  e.preventDefault();
                  onEnterFolder(entry);
                }
              }}
            >
              <span className="remote-entry-icon file-icon">
                {entry.is_dir ? folderIcon() : fileIcon(remoteEntryExt(entry.name))}
              </span>
              <span className="remote-entry-name">{entry.name}</span>
            </div>
          ))}
      </div>
      <div className="remote-chosen">{footer}</div>
    </div>
  );
}
