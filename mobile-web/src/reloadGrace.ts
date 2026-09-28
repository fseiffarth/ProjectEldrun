/**
 * Pull-to-refresh on the phone must not bring the lock back. A reload starts
 * the page from scratch, and from scratch every open asks for the PIN or
 * fingerprint — so the gesture that means "show me the latest" cost an unlock.
 *
 * The page being left while unlocked and in use stamps the moment it went; the
 * next page may skip the lock only when every one of these holds:
 * - the browser says this load was a reload (not a launch, a link, or history);
 * - it was not a page the browser discarded and brought back (`wasDiscarded`);
 * - the stamp is seconds old, so a phone put down and picked up later asks.
 * The stamp is read once and removed either way.
 *
 * The flag this replaces was a bare "unlocked" in sessionStorage with none of
 * those checks, and an app the OS killed and reopened carried it — whoever
 * picked the phone up next walked straight in.
 */
const RELOAD_GRACE_KEY = "eldrun.mobile.reloadGrace";
/** A reload's gap between leaving and the new page asking is a second or two;
 * this leaves room for a slow phone without covering a phone set down. */
export const RELOAD_GRACE_MS = 15_000;

type GraceStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function sessionStore(): GraceStorage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function navigationType(): string | undefined {
  try {
    const entry = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    return entry?.type;
  } catch {
    return undefined;
  }
}

function wasDiscarded(): boolean {
  return (document as Document & { wasDiscarded?: boolean }).wasDiscarded === true;
}

/** Stamp the moment an unlocked, in-use page is left. */
export function noteUnlockedLeave(now = Date.now(), storage = sessionStore()): void {
  try {
    storage?.setItem(RELOAD_GRACE_KEY, String(now));
  } catch {
    // A blocked store just means the next load asks, as a cold open does.
  }
}

/** Whether this load is a reload of a page left unlocked moments ago. One-shot. */
export function takeReloadGrace(
  now = Date.now(),
  storage = sessionStore(),
  type = navigationType(),
  discarded = wasDiscarded(),
): boolean {
  let stamp: string | null = null;
  try {
    stamp = storage?.getItem(RELOAD_GRACE_KEY) ?? null;
    storage?.removeItem(RELOAD_GRACE_KEY);
  } catch {
    return false;
  }
  if (type !== "reload" || discarded || stamp === null || !/^\d+$/.test(stamp)) return false;
  const age = now - Number(stamp);
  return age >= 0 && age <= RELOAD_GRACE_MS;
}
