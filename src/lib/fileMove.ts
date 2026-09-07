/**
 * Drag-to-move target resolution — the pure core of FileTree's "release a
 * dragged file over a folder" gesture.
 *
 * Why this exists as a module: the drag hit-tests `document.elementFromPoint`,
 * which sees EVERY mounted tree — a box scope renders one `FileTree` per member
 * project, and a side-panel drag can cross into a Files (Project) tab of a
 * different project. The commit used to assume the target belonged to the
 * source tree and moved within `srcProjectDir` using the OTHER tree's rel path,
 * so a cross-project drop relocated the file *inside the source project* into a
 * folder path copied from the destination project (the "strangely moved
 * folders" bug). Every target therefore carries its tree's identity
 * (`data-move-root` / `data-move-remote`), and this resolver decides what a
 * drop there means — or that it means nothing.
 */

/** A `[data-move-rel]` element's identity, read off its DOM attributes. */
export interface MoveTargetInfo {
  /** Destination folder, relative to `root` ("" = that tree's root). */
  rel: string;
  /** The target tree's root directory (its `projectDir`). */
  root: string;
  /** Whether the target tree lists a remote (SFTP) source. */
  remote: boolean;
}

/** The dragging tree's identity. */
export interface MoveSourceInfo {
  /** The source tree's root directory (its `projectDir`). */
  root: string;
  /** The folder the dragged entries live in (the tree's browsed rel path). */
  folderRel: string;
  /** Whether the source tree lists a remote (SFTP) source. */
  remote: boolean;
}

export interface ResolvedMoveTarget {
  root: string;
  rel: string;
  /** True when the destination is a DIFFERENT tree's root (cross-project). */
  crossRoot: boolean;
}

/**
 * What dropping here would do: a same-tree move, a cross-root (cross-project)
 * move, or nothing (`null`).
 *
 * - Same root: dropping onto the folder the file already lives in is a no-op.
 * - Different root: only local↔local is offered. `move_path` is a local-fs
 *   command, so a move in or out of a remote (SFTP) listing cannot be honored —
 *   refusing the target up front (no highlight, no drop) beats a move that
 *   errors or, worse, resolves against the wrong tree.
 */
export function resolveMoveTarget(
  target: MoveTargetInfo | null,
  source: MoveSourceInfo,
): ResolvedMoveTarget | null {
  if (!target) return null;
  if (target.root === source.root) {
    if (target.rel === source.folderRel) return null;
    return { root: target.root, rel: target.rel, crossRoot: false };
  }
  if (source.remote || target.remote) return null;
  return { root: target.root, rel: target.rel, crossRoot: true };
}

/** Destination rel path for `name` dropped into `destFolderRel` ("" = root). */
export function moveDestRel(destFolderRel: string, name: string): string {
  return destFolderRel ? `${destFolderRel}/${name}` : name;
}

/**
 * Absolute path of the moved entry. Same-root moves keep the historical
 * tail-swap (`sourceAbs` ends with `sourceRel`, so the prefix is preserved
 * byte-for-byte); a cross-root move rebuilds from the destination root.
 */
export function movedEntryAbs(opts: {
  sourceAbs: string;
  sourceRel: string;
  destRel: string;
  destRoot: string;
  crossRoot: boolean;
}): string {
  const { sourceAbs, sourceRel, destRel, destRoot, crossRoot } = opts;
  if (!crossRoot) {
    return `${sourceAbs.slice(0, sourceAbs.length - sourceRel.length)}${destRel}`;
  }
  return `${destRoot.replace(/[/\\]+$/, "")}/${destRel}`;
}

/**
 * The directory a box member's tree lists for a given file-source side: the
 * remote project's state dir (which the backend resolves to the host) for
 * "remote", the local mirror for "local". Mirrors the single-project view's
 * rule in `ProjectFilesPane` — the persisted mirror override is authoritative,
 * `<state_dir>/mirror` is only the legacy fallback.
 */
export function remoteMemberTreeDir(
  stateDir: string,
  mirrorOverride: string | null,
  source: "remote" | "local",
): string {
  if (source === "remote") return stateDir;
  return (
    mirrorOverride ??
    (stateDir ? `${stateDir.replace(/[/\\]+$/, "")}/mirror` : stateDir)
  );
}
