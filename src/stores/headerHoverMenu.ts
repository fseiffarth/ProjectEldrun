import { create } from "zustand";

/**
 * Which header hover-menu (GlobalAppMenu, LocalModelMenu, Mail/Calendar/Todo
 * indicators, VpnIndicator) is open right now — ONE id, shared across all of
 * them. Each menu opens instantly on mouseenter but closes only after a 250ms
 * grace timer (so the pointer can travel from the button down into the
 * dropdown); with independent `useState`s that grace period is what let two
 * adjacent menus render at once — the mouse leaves A (A's timer starts) and
 * enters B (B opens immediately) before A's timer fires. Routing both through
 * one id fixes it structurally: opening B overwrites `openId` in the same
 * frame, so A's derived `open` (`openId === "A"`) flips false immediately
 * instead of waiting out its own timer. `close` is a no-op once a different
 * menu has already claimed `openId`, so a late-firing close from A can never
 * clobber B.
 */
interface HeaderHoverMenuState {
  openId: string | null;
  open: (id: string) => void;
  close: (id: string) => void;
}

export const useHeaderHoverMenuStore = create<HeaderHoverMenuState>((set) => ({
  openId: null,
  open: (id) => set({ openId: id }),
  close: (id) => set((s) => (s.openId === id ? { openId: null } : s)),
}));
