// Small view preferences the phone keeps for itself: a filter the reader set is
// theirs, not the desktop's, so these never cross the bridge. The desktop board
// has its own `hideDone` in `stores/todo` and deliberately does not persist it
// there — a filter that survives a relaunch is how a card goes missing. On the
// phone the same toggle sits above a one-column list that is re-mounted by every
// tab switch, so "hide done" was being asked for again a dozen times a session.

const PREFIX = "eldrun.mobile.";

type FlagStorage = Pick<Storage, "getItem" | "setItem">;

export type MobileFlag = "todoHideDone" | "todoHideArchived";

/**
 * `fallback` is what an unset flag means, and it is a real parameter rather than
 * a hardcoded `false` because "hide archived" ships **on**: an archive is where
 * cards are put to stop looking at them, so the phone that has never been told
 * otherwise should not open on a column of them. Only the two stored strings
 * answer the question — anything else (a cleared store, a hand-edited value)
 * falls back, so an on-by-default flag can never be turned off by accident.
 */
export function readFlag(name: MobileFlag, fallback = false, storage?: FlagStorage): boolean {
  try {
    const stored = (storage ?? localStorage).getItem(`${PREFIX}${name}`);
    return stored === "1" ? true : stored === "0" ? false : fallback;
  } catch {
    // Storage can be unavailable in a private browser; the flag keeps its
    // default for the session.
    return fallback;
  }
}

export function writeFlag(name: MobileFlag, value: boolean, storage?: FlagStorage): void {
  try {
    (storage ?? localStorage).setItem(`${PREFIX}${name}`, value ? "1" : "0");
  } catch {
    // See readFlag.
  }
}
