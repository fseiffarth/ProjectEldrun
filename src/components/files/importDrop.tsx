import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Toggle } from "../common/Toggle";
import { basename, fromFileUri } from "../../lib/paths";

/**
 * Importing OS files into a project by dropping them onto a file view — shared
 * by the right panel and the "Files (Project)" tab, which must import
 * identically (same collision prompt, same destination folder rule).
 */

type ConflictChoice = "replace" | "rename" | "skip";

/** Heuristic: is this drag an external OS file drag (vs. an internal pill/text
 *  drag)? `dragDropEnabled` stays false so HTML5 DnD keeps working for the
 *  app's pointer/HTML drags; an OS file drag advertises Files/uri-list/html
 *  (WebKitGTK uses text/html here). During dragover WebKit may hide the type
 *  list, so an empty list is treated as a file drag too. */
export function isExternalFileDrag(dt: DataTransfer): boolean {
  const types = Array.from(dt.types ?? []);
  if (types.length === 0) return true;
  return (
    types.includes("Files") ||
    types.includes("text/uri-list") ||
    types.includes("text/html")
  );
}

/** Extract absolute local paths from an OS HTML5 file drop. WebKitGTK withholds
 *  `Files`/`text/uri-list` data here but leaks the `file://` URL inside
 *  `text/html`, so scan every text payload for `file://` URIs and dedupe.
 *  NOTE: this drag path is best-effort — some file managers only expose ONE
 *  file this way. Use the Import button for reliable multi-file selection. */
export function parseDroppedFilePaths(dataTransfer: DataTransfer): string[] {
  const sources = [
    dataTransfer.getData("text/uri-list"),
    dataTransfer.getData("text/plain"),
    dataTransfer.getData("text/html"),
  ];
  const FILE_URI = /file:\/\/[^\s"'<>]+/g;
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const raw of sources) {
    if (!raw) continue;
    for (const match of raw.match(FILE_URI) ?? []) {
      const p = fromFileUri(match);
      if (p && !seen.has(p)) {
        seen.add(p);
        paths.push(p);
      }
    }
  }
  return paths;
}

interface Options {
  /** Destination project root. Empty disables the drop. */
  projectDir: string;
  /** False for a box scope: several roots, so no single destination. */
  enabled: boolean;
  /** Project-relative folder the files land in, read at drop time. */
  destRel: string;
  /** Fired once the whole batch has been copied (e.g. to refresh git). */
  onImported?: () => void;
}

/**
 * OS file drop → copy into the project, prompting on name collisions. Returns
 * the drag handlers to spread onto the drop zone, the classes that paint it,
 * the conflict modal to render, and the file-picker fallback (WebKitGTK only
 * leaks one path per drag, so the picker is the reliable multi-file route).
 */
export function useImportDrop({ projectDir, enabled, destRel, onImported }: Options) {
  const [dropActive, setDropActive] = useState(false);
  const [dropFlash, setDropFlash] = useState(false);
  const [conflict, setConflict] = useState<
    { name: string; remaining: number; resolve: (r: { choice: ConflictChoice; all: boolean }) => void } | null
  >(null);
  const [conflictAll, setConflictAll] = useState(false);
  const dropFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const canImport = enabled && !!projectDir;

  // The import runs asynchronously across a batch, so read the destination and
  // the completion callback from refs — a folder change mid-import must not
  // strand the loop on a stale closure.
  const destRelRef = useRef(destRel);
  destRelRef.current = destRel;
  const onImportedRef = useRef(onImported);
  onImportedRef.current = onImported;

  useEffect(() => {
    return () => {
      if (dropFlashTimer.current) clearTimeout(dropFlashTimer.current);
    };
  }, []);

  const flashDrop = () => {
    if (dropFlashTimer.current) clearTimeout(dropFlashTimer.current);
    setDropFlash(false);
    requestAnimationFrame(() => setDropFlash(true));
    dropFlashTimer.current = setTimeout(() => setDropFlash(false), 500);
  };

  // Ask the user how to resolve a name collision; resolves via the modal's
  // buttons. Returns the choice plus whether to apply it to all remaining.
  const askConflict = (name: string, remaining: number) =>
    new Promise<{ choice: ConflictChoice; all: boolean }>((resolve) => {
      setConflictAll(false);
      setConflict({ name, remaining, resolve });
    });

  // Copy each absolute source path into the project, prompting on collisions.
  const importPaths = (paths: string[]) => {
    if (!canImport || !projectDir || paths.length === 0) return;
    flashDrop();
    const destRelAtDrop = destRelRef.current;
    void (async () => {
      let blanket: ConflictChoice | null = null;
      for (let i = 0; i < paths.length; i++) {
        const sourcePath = paths[i];
        const name = basename(sourcePath) || sourcePath;
        const rel = destRelAtDrop ? `${destRelAtDrop}/${name}` : name;
        let choice: ConflictChoice = "rename";
        const exists = await invoke<boolean>("project_path_exists", { projectDir, relPath: rel }).catch(() => false);
        if (exists) {
          if (blanket) {
            choice = blanket;
          } else {
            const res = await askConflict(name, paths.length - 1 - i);
            setConflict(null);
            choice = res.choice;
            if (res.all) blanket = res.choice;
          }
        }
        if (choice === "skip") continue;
        try {
          await invoke("import_external_file", {
            projectDir,
            sourcePath,
            destRel: destRelAtDrop,
            replace: choice === "replace",
          });
        } catch (err) {
          console.error("import_external_file", sourcePath, err);
        }
      }
      // The tree auto-reloads via its fs-watch; the host may still want to
      // refresh anything derived from the files (e.g. git status counts).
      onImportedRef.current?.();
    })();
  };

  // HTML5 drag-and-drop (dragDropEnabled stays false so pointer drags — tabs,
  // splits, pills — keep working). Best-effort: WebKitGTK only leaks file paths
  // via text/html and sometimes just one; the Import button is the reliable
  // multi-file path.
  const onDragOver = (e: React.DragEvent) => {
    if (!canImport || !isExternalFileDrag(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    if (!dropActive) setDropActive(true);
  };

  const onDragLeave = (e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setDropActive(false);
  };

  const onDrop = (e: React.DragEvent) => {
    setDropActive(false);
    if (!canImport || !isExternalFileDrag(e.dataTransfer)) return;
    e.preventDefault();
    importPaths(parseDroppedFilePaths(e.dataTransfer));
  };

  // Reliable multi-file import: native OS file picker → same copy+conflict flow.
  const importViaDialog = async () => {
    if (!canImport) return;
    const picked = await openDialog({ multiple: true, directory: false }).catch(() => null);
    if (!picked) return;
    importPaths(Array.isArray(picked) ? picked : [picked]);
  };

  const conflictModal = conflict
    ? createPortal(
        <div
          className="modal-backdrop"
          onMouseDown={() => conflict.resolve({ choice: "skip", all: conflictAll })}
        >
          <div className="settings-dialog" style={{ maxWidth: 380 }} onMouseDown={(e) => e.stopPropagation()}>
            <div className="settings-title-row">
              <h2>File already exists</h2>
            </div>
            <p className="settings-help" style={{ wordBreak: "break-all" }}>
              <code>{conflict.name}</code> already exists in this folder. Replace it, or keep both (the new copy is renamed)?
            </p>
            {conflict.remaining > 0 && (
              <label className="viewer-pref-toggle" style={{ marginBottom: 8 }}>
                <Toggle
                  size="sm"
                  checked={conflictAll}
                  onChange={(e) => setConflictAll(e.target.checked)}
                />
                <span>Apply to the {conflict.remaining} remaining file{conflict.remaining > 1 ? "s" : ""}</span>
              </label>
            )}
            <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
              <button className="tab-add-btn" onClick={() => conflict.resolve({ choice: "skip", all: conflictAll })}>
                Skip
              </button>
              <button className="tab-add-btn" onClick={() => conflict.resolve({ choice: "rename", all: conflictAll })}>
                Keep both
              </button>
              <button
                className="tab-add-btn"
                style={{ color: "var(--danger, #f85149)" }}
                onClick={() => conflict.resolve({ choice: "replace", all: conflictAll })}
              >
                Replace
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )
    : null;

  return {
    canImport,
    dropActive,
    dropFlash,
    importViaDialog,
    conflictModal,
    handlers: {
      onDragEnter: onDragOver,
      onDragOver,
      onDragLeave,
      onDrop,
    },
  };
}
