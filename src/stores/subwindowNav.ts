import { create } from "zustand";

/**
 * Transient state for keyboard-driven subwindow navigation (Shift+↑/↓).
 *
 * Kept separate from the tabs store so entering/stepping the preview doesn't
 * churn the layout tree or move the real focus — focus only commits (via
 * `tabs.focusGroup`) when Shift is released. While `active`, `CenterPanel`'s
 * `FocusFrameOverlay` shows numbered badges over every subwindow and draws the
 * focus frame on `previewGroupId` instead of the committed focused group.
 *
 * `useKeyboard` mutates this imperatively via `getState()`; the overlay
 * subscribes reactively.
 */
interface SubwindowNavState {
  /** Nav mode on → badges visible, frame follows `previewGroupId`. */
  active: boolean;
  /** Group the preview frame currently sits on (null when inactive). */
  previewGroupId: string | null;
  /** Enter/continue nav mode, moving the preview to `groupId`. */
  preview: (groupId: string) => void;
  /** Leave nav mode (hide badges, drop the preview). */
  end: () => void;
}

export const useSubwindowNavStore = create<SubwindowNavState>((set) => ({
  active: false,
  previewGroupId: null,
  preview: (groupId) => set({ active: true, previewGroupId: groupId }),
  end: () => set({ active: false, previewGroupId: null }),
}));
