/**
 * Group B (#231/#226/#233/#234): which window is this JS heap?
 *
 * A detached popout is a SECOND React root with its own Zustand heap. Its
 * `useTabsStore` holds no tabs and no layout — the group it renders arrives as
 * streamed props — so every store write a pane makes in a popout used to land in
 * an empty store and vanish: a Ctrl+clicked link in a popped-out README opened
 * nothing, a breakpoint set in a popped-out editor was gone at relaunch, a renamed
 * tmux session reattached to its old name. Rather than teach every one of those
 * call sites about windows, the STORES consult this context and forward the write
 * to the main window as the matching `DETACHED_EDIT` (or a dedicated event), so a
 * pane behaves identically wherever it is mounted.
 *
 * Deliberately dependency-free: `stores/tabs`, `stores/settings`, `stores/usage`
 * and `stores/activity` all import it, and it must import none of them back.
 * `DetachedApp` installs the context once at mount; the main window never does,
 * so `isDetachedWindow()` is the one honest answer to "does this heap own the
 * tabs" (what the panes used to receive as an `ownsTabs` prop).
 */

/** The edit shapes a popout may forward. Structurally the subset of
 *  `DetachedEditPayload` (stores/tabs) the store seam emits; kept as a loose
 *  record here so this module stays import-free. */
export type ForwardedEdit = { kind: string } & Record<string, unknown>;

export interface DetachedWindowContext {
  /** The scope the popout's group belongs to (a project id, `"root"`, `box:<id>`). */
  scope: string;
  /** The popout's identity in the main store's detached record. */
  groupId: string;
  /** The Tauri window label (`detached-<scope>-<gid>`). */
  label: string;
  /** The inner group a new tab should land in — the popout's focused pane,
   *  falling back to its first. Read at call time (focus moves). */
  targetGroupId: () => string;
  /** Stream an edit to the main window (`DETACHED_EDIT`). */
  pushEdit: (edit: ForwardedEdit) => void;
  /** Close one of the popout's tabs the way its × does (the last tab closes the
   *  whole window) — so `removeTab` from a pane routes through the same path. */
  closeTab: (key: string) => void;
}

let ctx: DetachedWindowContext | null = null;

export function setDetachedWindowContext(next: DetachedWindowContext | null): void {
  ctx = next;
}

/**
 * Install one popout context and return an ownership-aware cleanup.
 *
 * React development StrictMode deliberately runs an effect setup, cleanup and
 * setup again on first mount.  `DetachedApp` also installs during render so a
 * child mount effect can forward immediately; repeating the install here makes
 * the second StrictMode setup restore what its synthetic cleanup removed.  The
 * identity check prevents an old cleanup (HMR, or a replaced binding) from
 * clearing a newer context.
 */
export function installDetachedWindowContext(next: DetachedWindowContext): () => void {
  ctx = next;
  return () => {
    if (ctx === next) ctx = null;
  };
}

export function getDetachedWindowContext(): DetachedWindowContext | null {
  return ctx;
}

/** True inside a detached popout's heap; false in the main window (and in tests
 *  unless one installs a context). */
export function isDetachedWindow(): boolean {
  return ctx !== null;
}
