/**
 * A tab's Important / Urgent mark: set from the tab's right-click menu, shown
 * on the tab itself and summed up on its project's pill, so a tab that needs
 * attention is findable without switching to its project first.
 *
 * Two levels, not a colour or a free label, and the same two the mail client
 * uses — with the same glyphs (`!` / `!!`), so a mark means one thing across
 * the app. At most one per tab: urgent already says "important, and now".
 */

export type TabMark = "important" | "urgent";

/** Menu order — the milder mark first, as the mail client lists them. */
export const TAB_MARKS: readonly TabMark[] = ["important", "urgent"];

/** Whether an unknown value (a layout file on disk, a popout edit) is a mark.
 *  Anything else reads as "unmarked". */
export function isTabMark(value: unknown): value is TabMark {
  return value === "important" || value === "urgent";
}

/** The mail client's glyph for the same mark (`MailIndicator`, `MailList`). */
export function tabMarkGlyph(mark: TabMark): string {
  return mark === "urgent" ? "!!" : "!";
}

/** One marked tab, as the project pill lists it. */
export interface MarkedTab {
  key: string;
  label: string;
  mark: TabMark;
}

/**
 * The marked tabs of one scope, urgent first, then in the scope's own tab
 * order — the pill's badge takes its level from the first and its click jumps
 * to it.
 */
export function markedTabs(
  tabs: readonly { key: string; label: string; mark?: TabMark }[] | undefined,
): MarkedTab[] {
  const out: MarkedTab[] = [];
  for (const tab of tabs ?? []) {
    if (isTabMark(tab.mark)) out.push({ key: tab.key, label: tab.label, mark: tab.mark });
  }
  // Stable: tabs of one level keep their bar order.
  return out.sort((a, b) => (a.mark === b.mark ? 0 : a.mark === "urgent" ? -1 : 1));
}
