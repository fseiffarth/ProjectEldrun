import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { sanitizeName } from "../projects/scaffold";
import { useT } from "../../lib/i18n";

/** One subdirectory row, mirroring the Rust `DirEntry` (commands::fs). */
interface DirEntry {
  name: string;
  path: string;
}

/** The listing returned by the `list_dirs` command (Rust `DirListing`). */
interface DirListing {
  path: string;
  parent: string | null;
  entries: DirEntry[];
}

interface Props {
  /** Directory to open the browser at (defaults to home when empty/omitted). */
  initialPath?: string;
  title: string;
  /** Label for the confirm button (e.g. "Move here"). */
  confirmLabel: string;
  /**
   * When set, render a labeled text input for a folder name (its sanitized form
   * is previewed live). The entered value is passed as the second `onConfirm`
   * arg. Omit to keep the picker a pure directory chooser.
   */
  nameLabel?: string;
  /** Initial value for the optional name field. */
  nameInitial?: string;
  /**
   * Called with the currently-browsed directory when the user confirms. When a
   * name field is shown (`nameLabel`), the entered folder name is passed too.
   */
  onConfirm: (dir: string, name?: string) => void;
  onClose: () => void;
}

/**
 * An in-app ("native to Eldrun") folder-browser popup — an alternative to the OS
 * folder-chooser dialog. Browses the local filesystem via the unconfined
 * `list_dirs` command: click a folder to descend, ⬆ to go up, then confirm to
 * return the current directory. Follows the app modal convention (portal +
 * `.modal-backdrop` + a settings-style dialog).
 */
export function FolderPickerDialog({ initialPath, title, confirmLabel, nameLabel, nameInitial, onConfirm, onClose }: Props) {
  const t = useT();
  const [listing, setListing] = useState<DirListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState(nameInitial ?? "");

  const load = useCallback((path: string) => {
    setLoading(true);
    setError(null);
    invoke<DirListing>("list_dirs", { path })
      .then((res) => setListing(res))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load(initialPath?.trim() || "");
  }, [load, initialPath]);

  useEffect(() => {
    setName(nameInitial ?? "");
  }, [nameInitial]);

  // Escape closes, mirroring the app's other modals.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const cur = listing?.path ?? initialPath ?? "";

  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="settings-dialog folder-picker-dialog"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="settings-title-row">
          <h2>{title}</h2>
          <button type="button" className="dialog-close-btn" onClick={onClose}>×</button>
        </div>

        <div className="folder-picker-nav">
          <button
            type="button"
            disabled={!listing?.parent}
            onClick={() => listing?.parent && load(listing.parent)}
            title={t("folderPicker.upOneFolder")}
          >
            ⬆ {t("folderPicker.up")}
          </button>
          <span className="folder-picker-cur" title={cur}>{cur || "…"}</span>
        </div>

        <div className="folder-picker-list">
          {error ? (
            <p className="settings-help folder-picker-error">{error}</p>
          ) : loading && !listing ? (
            <p className="settings-help">{t("common.loading")}</p>
          ) : listing && listing.entries.length === 0 ? (
            <p className="settings-help">{t("folderPicker.noSubfolders")}</p>
          ) : (
            listing?.entries.map((entry) => (
              <button
                key={entry.path}
                type="button"
                className="folder-picker-item"
                onClick={() => load(entry.path)}
                title={entry.path}
              >
                <span className="folder-picker-icon">📁</span>
                <span className="folder-picker-name">{entry.name}</span>
              </button>
            ))
          )}
        </div>

        {nameLabel !== undefined && (
          <div className="folder-picker-name-row">
            <label className="folder-picker-name-label">
              <span>{nameLabel}</span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                spellCheck={false}
              />
            </label>
            <span className="settings-help folder-picker-name-preview">
              {t("folderPicker.folderPrefix")} {sanitizeName(name) || "…"}
            </span>
          </div>
        )}

        <div className="settings-actions folder-picker-actions">
          <button type="button" onClick={onClose}>{t("common.cancel")}</button>
          <button
            type="button"
            className="primary"
            disabled={!cur}
            onClick={() => onConfirm(cur, nameLabel !== undefined ? name : undefined)}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
