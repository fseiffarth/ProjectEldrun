import { useRef, useState } from "react";
import { GlobalAppBar } from "./GlobalAppBar";
import { useT } from "../../lib/i18n";

/**
 * Header button that reveals the global-app launcher as a hover dropdown.
 * Lives in the top frame, right of the project list; replaces the old
 * top-edge reveal strip.
 */
export function GlobalAppMenu() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<number | null>(null);

  const reveal = () => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    setOpen(true);
  };

  const scheduleClose = () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => {
      setOpen(false);
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
