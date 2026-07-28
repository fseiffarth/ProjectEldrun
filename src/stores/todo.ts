/**
 * The todo board's **session** state — and nothing that is written to disk.
 *
 * `useCalendarStore` stays the only owner of task persistence: the cards *are*
 * `calendar.json`'s tasks, so a second store that also wrote them would be two
 * writers for one file. What lives here is what a board needs and a calendar does
 * not — whether the overlay is up, the filters, the in-flight card drag, the
 * optimistic placement overlay, and the urgent-mail rail's cache.
 *
 * Three deliberate choices worth keeping:
 *
 * **The filters are not persisted.** A filter that survives a relaunch is how a
 * user loses cards: the board opens showing three of forty and nothing on screen
 * says why.
 *
 * **The drag lives here, not in `stores/drag`.** That store's `drag !== null` is
 * read by `CenterPanel`, `DetachedCenterPanel`, `FileTree` and
 * `dragPreviewLayout` as "a tab or file drag is in flight" — populating it for a
 * card drag would put the whole center panel into drag mode (panes
 * `pointer-events: none`) behind a modal, and make a popout broadcast reorder
 * targets for a gesture that has nothing to do with tabs.
 *
 * **The mail rail reads mail without touching the mail store.**
 * `useMailStore.openPriority` sets `selectedPriority` and replaces `headers` —
 * i.e. it retargets the mail overlay's list — so a rail that used it would move
 * the user's mailbox under them every 60 seconds. It calls `mailPriorityPage`
 * directly instead and keeps its own copy.
 */

import { create } from "zustand";

import type { MailHeader, MailPriority } from "../types/mail";
import { mailPriorityPage } from "../lib/mail";

/** A card drag in flight. Positions are viewport coordinates. */
export interface CardDrag {
  taskId: string;
  fromColumn: string;
  title: string;
  /** Measured at pickup — sizes both the ghost and the drop placeholder. */
  width: number;
  height: number;
  /** Where inside the card the pointer grabbed it. */
  grabDx: number;
  grabDy: number;
  pointerX: number;
  pointerY: number;
  overColumn: string | null;
  overIndex: number | null;
}

/** How many marked messages the rail asks for. A rail, not a second mailbox. */
const RAIL_PAGE = 25;

interface TodoStore {
  overlayOpen: boolean;
  openOverlay: () => void;
  closeOverlay: () => void;

  search: string;
  projectFilter: string | null | "none";
  tagFilter: string | null;
  hideDone: boolean;
  setSearch: (value: string) => void;
  setProjectFilter: (value: string | null | "none") => void;
  setTagFilter: (value: string | null) => void;
  setHideDone: (value: boolean) => void;
  clearFilters: () => void;

  cardDrag: CardDrag | null;
  startCardDrag: (drag: CardDrag) => void;
  moveCardDrag: (x: number, y: number) => void;
  setCardTarget: (column: string | null, index: number | null) => void;
  endCardDrag: () => void;

  /** Optimistic placements, keyed by task id — the anti-snap-back overlay. */
  pendingOrder: Record<string, { column: string; rank: number }>;
  stageMove: (taskId: string, column: string, rank: number) => void;
  settleMove: (taskId: string) => void;

  urgentMail: MailHeader[];
  importantMail: MailHeader[];
  urgentLoading: boolean;
  urgentError: string | null;
  /** Read both priority pages. A **local index read** — never a socket. */
  loadUrgentMail: () => Promise<void>;
  clearUrgentMail: () => void;

  error: string | null;
  setError: (message: string | null) => void;
}

export const useTodoStore = create<TodoStore>((set, get) => ({
  overlayOpen: false,
  openOverlay: () => set({ overlayOpen: true }),
  closeOverlay: () =>
    // Drop any in-flight drag with the surface it was happening on: the
    // pointerdown-bound release handler survives the unmount and would otherwise
    // commit a move onto a board nobody is looking at.
    set({ overlayOpen: false, cardDrag: null }),

  search: "",
  projectFilter: null,
  tagFilter: null,
  hideDone: false,
  setSearch: (search) => set({ search }),
  setProjectFilter: (projectFilter) => set({ projectFilter }),
  setTagFilter: (tagFilter) => set({ tagFilter }),
  setHideDone: (hideDone) => set({ hideDone }),
  clearFilters: () =>
    set({ search: "", projectFilter: null, tagFilter: null, hideDone: false }),

  cardDrag: null,
  startCardDrag: (cardDrag) => set({ cardDrag }),
  moveCardDrag: (x, y) =>
    set((s) => (s.cardDrag ? { cardDrag: { ...s.cardDrag, pointerX: x, pointerY: y } } : s)),
  setCardTarget: (column, index) =>
    set((s) =>
      s.cardDrag ? { cardDrag: { ...s.cardDrag, overColumn: column, overIndex: index } } : s,
    ),
  endCardDrag: () => set({ cardDrag: null }),

  pendingOrder: {},
  stageMove: (taskId, column, rank) =>
    set((s) => ({ pendingOrder: { ...s.pendingOrder, [taskId]: { column, rank } } })),
  settleMove: (taskId) =>
    set((s) => {
      if (!(taskId in s.pendingOrder)) return s;
      const next = { ...s.pendingOrder };
      delete next[taskId];
      return { pendingOrder: next };
    }),

  urgentMail: [],
  importantMail: [],
  urgentLoading: false,
  urgentError: null,

  loadUrgentMail: async () => {
    if (get().urgentLoading) return;
    set({ urgentLoading: true });
    const page = async (priority: MailPriority) => {
      const result = await mailPriorityPage(priority, 0, RAIL_PAGE, null).catch(
        (err) => {
          // A rail states a failure quietly; it is not the mail client's error
          // strip, and a red banner in a todo board for a mailbox nobody asked
          // about here would be noise.
          set({ urgentError: String(err) });
          return null;
        },
      );
      return result?.items ?? [];
    };
    set({ urgentError: null });
    const [urgent, important] = await Promise.all([page("urgent"), page("important")]);
    set({ urgentMail: urgent, importantMail: important, urgentLoading: false });
  },

  clearUrgentMail: () =>
    set({ urgentMail: [], importantMail: [], urgentError: null }),

  error: null,
  setError: (error) => set({ error }),
}));
