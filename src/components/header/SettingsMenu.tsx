import { UntestedTag } from "../common/UntestedTag";
import { MenuShortcut } from "../common/MenuShortcut";
import { useHeaderHoverMenuStore } from "../../stores/headerHoverMenu";
import { useHeaderMenu } from "../../hooks/useHeaderMenu";
import { useT } from "../../lib/i18n";
import { SettingsGlyph } from "./HeaderGlyphs";

const MENU_ID = "settings";

/**
 * The header's ⚙ — app settings, help, the tours and the lessons.
 *
 * It used to be the *project switcher's* leading button, which put three
 * controls belonging to one widget on both sides of a scrolling strip (⚙ left
 * of the pills, + and the search right of them) and left the + sitting flush
 * against the global-app cluster with nothing to say which of the two it
 * belonged to. Settings are the machine's, not a project's, so the gear belongs
 * with 🧠 ✉ 🗓 ☑ ▦ — after which everything left of the strip is a global app
 * and everything right of it acts on the project list.
 *
 * Built as `GlobalAppMenu`'s twin down to the class names: same wrapper, same
 * button chrome, and the same shared `headerHoverMenu` id — which is the real
 * reason to move it rather than merely re-order the DOM. The switcher's two
 * menus ran on their own timers, so the 250 ms grace one of them closes on let
 * it render *alongside* a cluster menu the pointer had already moved to; one
 * shared id makes that structurally impossible.
 *
 * Every entry is a `window` event, so this component owns no dialog: the
 * settings dialog stays mounted in `ProjectSwitcher`, which already listened
 * for `eldrun:open-settings` (the Local Model button's door into a specific
 * panel) long before the gear left it.
 */
export function SettingsMenu() {
  const t = useT();
  const menu = useHeaderMenu(MENU_ID);
  const { open, reveal, scheduleClose } = menu;
  const closeMenu = useHeaderHoverMenuStore((s) => s.close);

  const fire = (event: string, detail?: unknown) => {
    closeMenu(MENU_ID);
    window.dispatchEvent(
      detail === undefined ? new Event(event) : new CustomEvent(event, { detail }),
    );
  };

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
        data-hint-anchor="settings"
        title={t("settings.title")}
        aria-label={t("settings.title")}
        aria-haspopup="menu"
        aria-expanded={open}
        // Reveal rather than toggle: a click also fires mouseenter, so a toggle
        // here would open on enter and immediately shut (the rule every hover
        // menu in this header follows).
        onClick={reveal}
      >
        <SettingsGlyph className="settings-menu-icon" />
      </button>
      {open && (
        // The app's canonical dropdown-list chrome, shared with the switcher's
        // + menu — one look for one kind of thing, not a second copy of it.
        <div className="project-switcher-add-menu" role="menu">
          <button role="menuitem" onClick={() => fire("eldrun:open-settings", "main")}>
            {t("settings.title")}
          </button>
          <button role="menuitem" onClick={() => fire("eldrun:open-settings", "help")}>
            {t("nav.help.title")}
          </button>
          <button role="menuitem" onClick={() => fire("eldrun:open-shortcut-help")}>
            {t("shortcutHelp.title")}
            <MenuShortcut chord="shortcutHelp" />
          </button>
          <button role="menuitem" onClick={() => fire("eldrun:open-how-to-start")}>
            {t("projectSwitcher.howToStartMenu")}
          </button>
          <button role="menuitem" onClick={() => fire("eldrun:start-tour")}>
            {t("settings.takeTour")}
          </button>
          <button role="menuitem" onClick={() => fire("eldrun:start-advanced-tour")}>
            {t("settings.takeAdvancedTour")}
          </button>
          <button role="menuitem" onClick={() => fire("eldrun:open-lessons")}>
            {t("settings.lessons")}
          </button>
          <UntestedTag id="desktop.headerMenus" />
        </div>
      )}
    </div>
  );
}
