import { useRef } from "react";
import { GlobalAppBar } from "./GlobalAppBar";
import { useT } from "../../lib/i18n";
import { useHeaderHoverMenuStore } from "../../stores/headerHoverMenu";

const MENU_ID = "global-apps";

/**
 * Header button that reveals the global-app launcher as a hover dropdown.
 * Lives in the top frame, right of the project list; replaces the old
 * top-edge reveal strip.
 */
export function GlobalAppMenu() {
  const t = useT();
  // `open` is shared across every header hover-menu — see stores/headerHoverMenu
  // for why: it's what keeps switching from one menu straight into another from
  // showing both at once for the 250ms grace period.
  const open = useHeaderHoverMenuStore((s) => s.openId === MENU_ID);
  const openMenu = useHeaderHoverMenuStore((s) => s.open);
  const closeMenu = useHeaderHoverMenuStore((s) => s.close);
  const closeTimer = useRef<number | null>(null);

  const reveal = () => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    openMenu(MENU_ID);
  };

  const scheduleClose = () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => {
      closeMenu(MENU_ID);
      closeTimer.current = null;
    }, 250);
  };

  return (
    <div
      className="global-apps-menu no-drag"
      onMouseEnter={reveal}
      onMouseLeave={scheduleClose}
    >
      <button
        type="button"
        className="global-apps-menu-btn"
        title={t("globalAppMenu.title")}
        aria-label={t("globalAppMenu.title")}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        ▦
      </button>
      {open && <GlobalAppBar />}
    </div>
  );
}
