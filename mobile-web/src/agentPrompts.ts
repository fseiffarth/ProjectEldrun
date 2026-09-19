import type { TabPrompt, TabRow } from "./api";

/**
 * The prompt lines a session card shows, newest first.
 *
 * The desktop sends the tail oldest-first (it is a transcript), and a phone
 * list is read from the top down: the newest prompt is the one the reader came
 * for, so it leads. Already bounded twice on the way here — by the desktop and
 * again by the sidecar — so this only turns it round.
 */
export function promptLines(tab: TabRow): TabPrompt[] {
  return [...(tab.prompts ?? [])].reverse();
}

/** The last prompt a session was given, or nothing when none was readable. */
export function lastPrompt(tab: TabRow): TabPrompt | undefined {
  return tab.prompts?.[tab.prompts.length - 1];
}

/**
 * When a prompt went, in the phone's own zone.
 *
 * The transcript's instant is a real one (the agent writes UTC), so it is
 * formatted here rather than sliced the way the desktop-local schedule string
 * is — a phone in another time zone than the workstation must not be told the
 * desktop's wall clock as if it were its own. A record with no instant, or one
 * that will not parse, yields an empty string and the row shows its text alone.
 */
export function promptClock(at: string | undefined, now = new Date()): string {
  if (!at) return "";
  const when = new Date(at);
  const stamp = when.getTime();
  if (!Number.isFinite(stamp)) return "";
  const time = when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const sameDay = when.getFullYear() === now.getFullYear()
    && when.getMonth() === now.getMonth()
    && when.getDate() === now.getDate();
  return sameDay ? time : `${when.toLocaleDateString([], { month: "2-digit", day: "2-digit" })} ${time}`;
}
