/** Git working-state → theme token. The ONE map for every surface that paints
 *  a git status color (the tree's markers, the git action bar's step dots) so
 *  the colors cannot drift between surfaces — and follow the theme: the light
 *  themes define their own --warning/--danger, which hardcoded dark-palette
 *  hexes used to override. */
export const GIT_STATE_COLOR: Record<string, string> = {
  modified: "var(--danger)", // tracked, unstaged working-tree change
  untracked: "var(--danger)", // new, not yet tracked
  staged: "var(--warning)", // staged, not committed
  unpushed: "var(--success)", // committed locally, not pushed
  ignored: "var(--text-muted)", // ignored by git
};
