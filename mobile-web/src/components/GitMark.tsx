import type { GitDot } from "../api";
import { useT, type TranslationKey } from "../../../src/lib/i18n";
import { isUntested } from "../../../src/lib/untested";

/** The desktop hover card's sentence per level — the full reading. */
const LONG: Record<GitDot, TranslationKey> = {
  dirty: "pill.gitDirty",
  staged: "pill.gitStaged",
  unpushed: "pill.gitUnpushed",
  broken: "pill.gitBroken",
};

/** A word or two, for a list row's caption. */
const SHORT: Record<GitDot, TranslationKey> = {
  dirty: "mobile.git.dirty",
  staged: "mobile.git.staged",
  unpushed: "mobile.git.unpushed",
  broken: "mobile.git.broken",
};

/**
 * A project's pending git state, in the colours of the desktop pill's folder
 * icon: red for changes not yet added, orange for staged but not committed,
 * green for committed but not pushed, grey for a repo whose `.git` is gone.
 * Clean shows nothing, as on the desktop.
 *
 * An `em`, not a `span`: it sits inside cards whose `span:first-child` rule
 * would lay it out as a grid.
 */
export function GitMark({ state, long = false }: { state: GitDot; long?: boolean }) {
  const t = useT();
  return <em className={`git-mark git-${state}`} title={t(LONG[state])}>
    <i aria-hidden="true" />{t(long ? LONG[state] : SHORT[state])}
    {long && isUntested("mobile.project.git") && <span className="untested">{t("mobile.newTab.untested")}</span>}
  </em>;
}
