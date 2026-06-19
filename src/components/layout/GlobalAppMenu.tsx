import { useRef, useState } from "react";
import { GlobalAppBar } from "./GlobalAppBar";

/**
 * Header button that reveals the global-app launcher as a hover dropdown.
 * Lives in the top frame, right of the project list; replaces the old
 * top-edge reveal strip.
 */
export function GlobalAppMenu() {
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
        title="Global apps"
        aria-label="Global apps"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        ▦
      </button>
      {open && (
        <div className="global-apps-menu-dropdown">
          <GlobalAppBar />
        </div>
      )}
    </div>
  );
}
