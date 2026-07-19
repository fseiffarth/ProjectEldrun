import {
  internalViewerFor,
  type FileEntry,
  type InternalViewer,
} from "../../lib/viewers/fileUtils";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { useWindowsStore } from "../../stores/windows";

/**
 * The single open-a-file policy shared by every file listing (the FileTree in
 * the right panel / subwindow sidebar / Files tab, and the FileBrowser). It is
 * the seam that makes a double-click mean the same thing everywhere:
 *
 *  - A file with a **native in-app viewer** (`internalViewerFor`) opens as an
 *    embed tab in the project's **focused subwindow** — reusing an already-open
 *    viewer tab for that exact file rather than stacking duplicates. In a
 *    detached popout the caller passes `placeTab` so the tab streams into that
 *    window (like the Python ▶ Run) instead of the main window's tab store.
 *  - A file with **no native viewer**, or an explicit `external` open
 *    (Shift+double-click), opens in the OS default app via `open_file`.
 *
 * `disabled` honours the per-type viewer opt-out (#48); omit it to treat every
 * viewer as enabled.
 */
export function openFileEntry(opts: {
  entry: FileEntry;
  /** Project root, used as the embed tab's cwd. */
  projectDir: string;
  /** Owning project id, forwarded to `open_file` for window tracking. */
  projectId: string | null;
  /** Telemetry origin passed to `open_file` (e.g. "right_file_tree"). */
  origin: string;
  /** Force the OS-default-app path regardless of any native viewer (Shift). */
  external: boolean;
  /** Native viewers the user opted out of (#48); omit = all enabled. */
  disabled?: ReadonlySet<InternalViewer>;
  /** Detached-popout placement override: stream the tab into that window
   *  instead of writing the (non-authoritative) local tab store. */
  placeTab?: (tab: Omit<TabEntry, "key">) => void;
}): void {
  const { entry, projectDir, projectId, origin, external, disabled, placeTab } = opts;
  if (entry.is_dir) return;

  const viewer = internalViewerFor(entry, disabled);
  if (external || !viewer) {
    useWindowsStore
      .getState()
      .openFile(entry.path, undefined, projectId, origin)
      .catch((e) => console.error(e));
    return;
  }

  const tab: Omit<TabEntry, "key"> = {
    label: entry.name,
    cmd: "",
    cwd: projectDir,
    kind: "embed",
    embedPath: entry.path,
    viewer,
  };

  if (placeTab) {
    placeTab(tab);
    return;
  }

  // Main window: focus an existing viewer tab for this exact file if one is
  // open (same path + viewer), else add a fresh one to the focused subwindow.
  const store = useTabsStore.getState();
  const prior = store.tabs.find(
    (t) => t.kind === "embed" && t.viewer === viewer && t.embedPath === entry.path,
  );
  if (prior) store.setActive(prior.key);
  else store.addTab(tab);
}
