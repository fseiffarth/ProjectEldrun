import { create } from "zustand";
import type { CalendarClipboardEntry } from "../../lib/calendar/calendarClipboard";

interface CalendarClipboardState {
  /** The one copied entry, or null when nothing has been copied yet. */
  entry: CalendarClipboardEntry | null;
  copy: (entry: CalendarClipboardEntry) => void;
  clear: () => void;
}

/**
 * The calendar clipboard behind right-click → Copy / Paste.
 *
 * A module-level store rather than pane state, for the same reason the file
 * clipboard is one: a copy made in one calendar tab pastes in another (and in
 * the calendar overlay), and the copy outlives the view switch — copy in the
 * month grid, navigate to next month, paste there.
 *
 * It holds a *snapshot*, not a reference to the source event: the original may
 * be edited or deleted between the copy and the paste, and a paste that then
 * silently produced something else — or nothing — would be worse than one that
 * produces what the user copied.
 */
export const useCalendarClipboardStore = create<CalendarClipboardState>((set) => ({
  entry: null,
  copy: (entry) => set({ entry }),
  clear: () => set({ entry: null }),
}));
