import { useEffect, useState } from "react";
import { ProjectFilesTab } from "./ProjectFilesTab";

/** Default/clamp bounds for the per-subwindow file-viewer column (px). */
export const DEFAULT_GROUP_FILES_WIDTH = 300;
export const MIN_GROUP_FILES_WIDTH = 200;
export const MAX_GROUP_FILES_WIDTH = 640;

export function clampFilesWidth(w: number): number {
  return Math.min(MAX_GROUP_FILES_WIDTH, Math.max(MIN_GROUP_FILES_WIDTH, Math.round(w)));
}

interface Props {
  /** The owning scope (project id / "box:<id>" / "root") — identity for the viewer. */
  scope: string;
  /** Fallback tree root when the scope has no project (root scope / popout). */
  cwd: string;
  /** Persisted column width; unset → DEFAULT_GROUP_FILES_WIDTH. */
  width?: number;
  /** Commit a width after a resize drag ends (persisted onto the group node). */
  onWidthChange: (width: number) => void;
  /** The folder the viewer last browsed to, persisted on the group node. */
  folder?: string;
  /** Persist a folder change onto the group node (main) / stream it (popout). */
  onFolderChange?: (folder: string) => void;
  /** Whether this window owns the tab store (main window). Gates "Open in a new tab". */
  canOpenTabs?: boolean;
  /** Hide the docked viewer (double-click the resize edge). Same close path the
   *  ◫ tab-bar button uses. */
  onHide?: () => void;
}

/**
 * The per-subwindow right file viewer (a docked column on a subwindow's right
 * edge), toggled by the ◫ button in the subwindow's tab bar. The viewer itself
 * is the SAME `ProjectFilesTab` host the Files (Project) tab renders — and
 * therefore the same `ProjectFilesView` the right panel renders — so all three
 * surfaces can never drift apart. This wrapper owns only what a docked column
 * adds: the fixed width, and the left-edge resize handle.
 *
 * Width is LIVE-local during the drag (no store churn per pointer move) and
 * committed once on release via `onWidthChange` — the main window persists it
 * onto the group node; a popout streams a `files` edit back to the main window.
 */
export function SubwindowFilesSidebar({
  scope,
  cwd,
  width,
  onWidthChange,
  folder,
  onFolderChange,
  canOpenTabs,
  onHide,
}: Props) {
  const committed = clampFilesWidth(width ?? DEFAULT_GROUP_FILES_WIDTH);
  // Live width during a resize drag; null when idle (render the committed one).
  const [liveWidth, setLiveWidth] = useState<number | null>(null);

  // A width persisted elsewhere (another window, restore) wins when idle.
  useEffect(() => {
    setLiveWidth(null);
  }, [committed]);

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    const startX = e.clientX;
    const startW = committed;
    let last = startW;
    const onMove = (ev: PointerEvent) => {
      // The handle sits on the column's LEFT edge: dragging left grows it.
      last = clampFilesWidth(startW + (startX - ev.clientX));
      setLiveWidth(last);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setLiveWidth(null);
      if (last !== startW) onWidthChange(last);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <div className="subwindow-files" style={{ width: liveWidth ?? committed }}>
      <div
        className="subwindow-files-resize"
        title="Drag to resize · double-click to hide"
        onPointerDown={startResize}
        onDoubleClick={onHide}
      />
      {/* Compact: the docked column strips the header + view-switcher toolbar +
          sync/sort rows so the tree's find-files search box sits at the top. */}
      <ProjectFilesTab
        scope={scope}
        cwd={cwd}
        canOpenTabs={canOpenTabs}
        folder={folder}
        persistFolder={onFolderChange}
        visible
        compact
      />
    </div>
  );
}
