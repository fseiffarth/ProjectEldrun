import { GlobalAppBar } from "./GlobalAppBar";
import { useT } from "../../lib/i18n";
import { useHeaderMenu } from "../../hooks/useHeaderMenu";
import { AppsGlyph } from "../header/HeaderGlyphs";

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
  const menu = useHeaderMenu(MENU_ID);
  const { open, reveal, scheduleClose } = menu;

  return (
    <div
      ref={menu.ref}
      onKeyDown={menu.onKeyDown}
      onBlur={menu.onBlur}
      className="global-apps-menu no-drag"
      onMouseEnter={reveal}
      onMouseLeave={scheduleClose}
    >
      <button
        type="button"
        className="global-apps-menu-btn"
        // The tour spotlights this button; `.global-apps-menu-btn` alone is
        // shared with every header indicator, so it gets its own anchor.
        data-hint-anchor="global-apps"
        title={t("globalAppMenu.title")}
        aria-label={t("globalAppMenu.title")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={reveal}
      >
        <AppsGlyph className="global-apps-menu-icon" />
      </button>
      {open && <GlobalAppBar />}
    </div>
  );
}
