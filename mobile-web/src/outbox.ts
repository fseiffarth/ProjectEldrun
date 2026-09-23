import type { OutboxFile } from "./api";

/** How often a project's outbox is re-read while a screen showing it is on — a
 * directory listing on the sidecar, no desktop round trip, and skipped while
 * the page is hidden. The Focus screen's gallery and the project screen's
 * gallery read the same directory, so they read it at the same cadence. */
export const OUTBOX_POLL = 8_000;

/** Whether two outbox listings would paint the same tiles, so a poll that
 * found nothing new does not re-render every thumbnail. */
export function sameOutbox(a: readonly OutboxFile[], b: readonly OutboxFile[]) {
  return a.length === b.length && a.every((file, i) => file.name === b[i].name && file.modified === b[i].modified && file.size === b[i].size);
}
