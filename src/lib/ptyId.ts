/**
 * The one parser for a composed PTY id (`<scope>:<tabKey>`).
 *
 * **A scope is not colon-free.** `"root"` and a project id are, but a box scope
 * is `box:<id>` — so `box:abc:agent-3` has *two* colons and cutting at the first
 * one yields the scope `"box"`. Every consumer had hand-rolled that cut, and
 * every one of them was wrong for a box: `isDetachedPtyId` looked up
 * `detachedGroupsByScope["box"]`, found nothing, and let the main window kill a
 * PTY it had just handed to a popout (a detached box tab came up as a dead black
 * pane); the activity store filed a box tab's usage under a scope called
 * `"box"`. This is the same defect `commands::subwindow::detached_query`
 * documents on the Rust side, where it made box-scope detach impossible.
 *
 * Deliberately a leaf module — no store imports — so both `stores/tabs` and
 * `stores/activity` can use it without a cycle. It owns
 * {@link BOX_SCOPE_PREFIX} for the same reason: `stores/boxes` re-exports the
 * constant from here rather than the two holding separate literals that can
 * drift apart.
 */

/** Scope-id prefix for box-rooted tabs, disjoint from project ids and "root".
 *  Mirrors `BOX_SCOPE_PREFIX` in `src-tauri/src/commands/boxes.rs`. */
export const BOX_SCOPE_PREFIX = "box:";

/**
 * Split a composed PTY id into its scope and tab key, or `null` when it carries
 * no tab key at all (a bare, colon-less id, or a lone `box:<id>` scope).
 *
 * The scope grammar is "an id, or `box:<id>`", so the cut is at the first colon
 * *after* the box prefix. Ids that are not tabs (a dialog's login/VPN terminal,
 * the install overlay) still split somewhere harmless: their callers look the
 * result up in per-scope maps that never hold them.
 */
export function splitPtyId(ptyId: string): { scope: string; key: string } | null {
  const from = ptyId.startsWith(BOX_SCOPE_PREFIX) ? BOX_SCOPE_PREFIX.length : 0;
  const idx = ptyId.indexOf(":", from);
  if (idx < 0) return null;
  return { scope: ptyId.slice(0, idx), key: ptyId.slice(idx + 1) };
}
