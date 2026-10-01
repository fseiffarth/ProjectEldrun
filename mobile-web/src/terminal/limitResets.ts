import { resolveResetAt } from "../../../shared/usageReport";

/* The facts row's reset readouts, shared by the phone's facts row and status
 * sheet and the desktop Reader's facts row (`TerminalReaderFacts`). */

/** A compact time left for a reset the reader can place. Empty for an unknown
 * phrase or a reset that has already passed. */
export function resetCountdown(phrase: string, now: Date, readAt = now): string {
  const at = resolveResetAt(phrase, readAt);
  if (!at) return "";
  const minutes = Math.floor((at.getTime() - now.getTime()) / 60_000);
  if (minutes < 0) return "";
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * A window's rollover said exactly: weekday, date and clock in the phone's own
 * locale and timezone, plus how long is left. The CLI's words name a day or a
 * clock depending on its release and the window (`Mon 9am`, `6:20pm`,
 * `Sep 17, 2pm (Europe/Berlin)`) and are written on the desktop's clock, which
 * need not be the phone's. Placed through `resolveResetAt`, the same reading
 * auto-continue arms off, so the two cannot disagree; a phrase it cannot place
 * is shown in the CLI's own words rather than guessed at.
 */
export function resetText(phrase: string, now: Date, readAt = now): string {
  const at = resolveResetAt(phrase, readAt);
  if (!at) return `resets ${phrase}`;
  const when = new Intl.DateTimeFormat(undefined, {
    weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  }).format(at);
  const left = resetCountdown(phrase, now, readAt);
  return left ? `resets ${when} · in ${left}` : `resets ${when}`;
}
