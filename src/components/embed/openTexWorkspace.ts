import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { resolveTexRoot } from "../../lib/viewers/tex";
import { basename, dirname } from "../../lib/paths";

/**
 * The single open-a-LaTeX-file policy: open (or focus) the ONE "TeX workspace"
 * tab for the document `clickedPath` belongs to, and center it on `clickedPath`.
 *
 * The GOAL is "one tab, not a scatter": every place that used to open a `.tex`
 * as its own embed tab (the FileTree double-click, a drag-to-tab, Quick Open)
 * funnels through here instead. It resolves the build root (`resolve_tex_root`,
 * so a child `\input` file redirects to its main document) and dedupes on that
 * root, so there is exactly one workspace tab per main document. Opening a child
 * of an already-open workspace just focuses it and switches the center via
 * `texActivePath` — no second tab.
 *
 * Kept in this tiny module (imports only the tabs store, `resolveTexRoot` and
 * `paths`) rather than in the 7,000-line `FileViewerPane`, mirroring how
 * `openProjectFilesTab` is split out, so every call site can import it without
 * dragging the whole viewer graph (and its import cycles) along.
 *
 * `place` is the detached-popout / drop-target seam (like `openFileEntry`'s
 * `placeTab`): when given AND no existing workspace is found, it is handed the
 * fresh tab payload to place (into a popout, a split, a drop slot) instead of the
 * default `addTab` into the focused subwindow. An existing workspace is always
 * focused in place, since a workspace is a single-tab concept.
 */
export async function openTexWorkspace(
  clickedPath: string,
  place?: (tab: Omit<TabEntry, "key">) => void,
): Promise<void> {
  const root = await resolveTexRoot(clickedPath);
  const store = useTabsStore.getState();

  // Represent "center shows the main document" as texActivePath === root (store
  // the root path), not undefined, so focusing an existing workspace on its own
  // main is an ordinary merge write with nothing to clear.
  const activePath = clickedPath === root ? root : clickedPath;

  const existing = store.tabs.find(
    (t) => t.kind === "embed" && t.viewer === "texworkspace" && t.embedPath === root,
  );
  if (existing) {
    store.setActive(existing.key);
    store.setViewerState(existing.key, { texActivePath: activePath });
    return;
  }

  const tab: Omit<TabEntry, "key"> = {
    label: basename(root) || root,
    cmd: "",
    cwd: dirname(root) || "/",
    kind: "embed",
    embedPath: root,
    viewer: "texworkspace",
    // A fresh workspace centers on the main by default (texActivePath absent);
    // only seed it when a child was the file actually opened.
    viewerState: clickedPath === root ? undefined : { texActivePath: clickedPath },
  };

  if (place) {
    place(tab);
    return;
  }
  const entry = store.addTab(tab);
  store.setActive(entry.key);
}
