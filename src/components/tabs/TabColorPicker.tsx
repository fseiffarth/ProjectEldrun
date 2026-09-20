import { TAB_COLORS, TAB_COLOR_IDS, type TabColor } from "../../lib/theme/tabColors";
import { useT } from "../../lib/i18n";
import { UntestedTag } from "../common/UntestedTag";

/**
 * The colour row of a tab's right-click menu (#264).
 *
 * Shared by the main window's `TabBar` and the popout's own strip
 * (`DetachedCenterPanel`), which draw bespoke tab bars but must not draw
 * bespoke pickers — the popout's rename already drifted into a `window.prompt`
 * that way. One component, so a colour means the same thing and looks the same
 * in either window.
 *
 * A swatch grid rather than a drill-in submenu: nine choices is one glance and
 * one click, and a submenu would have put a colour two clicks deep in a menu
 * whose other rows are all one. The "no colour" chip leads, so clearing is as
 * reachable as setting — it is the row a mis-click is corrected with.
 */
export function TabColorPicker({
  current,
  onPick,
}: {
  current: TabColor | undefined;
  onPick: (color: TabColor | undefined) => void;
}) {
  const t = useT();
  return (
    <>
      <div className="tab-new-menu-group-label">
        {t("tabColor.menu")} <UntestedTag id="tabColor.menu" />
      </div>
      <div className="tab-color-swatches" role="group" aria-label={t("tabColor.menu")}>
        <button
          type="button"
          className={`tab-color-swatch tab-color-swatch--none${current ? "" : " is-current"}`}
          title={t("tabColor.none")}
          aria-label={t("tabColor.none")}
          aria-pressed={!current}
          onClick={() => onPick(undefined)}
        >
          ⃠
        </button>
        {TAB_COLOR_IDS.map((id) => (
          <button
            key={id}
            type="button"
            className={`tab-color-swatch${current === id ? " is-current" : ""}`}
            style={{ background: TAB_COLORS[id] }}
            title={t(`tabColor.${id}`)}
            aria-label={t(`tabColor.${id}`)}
            aria-pressed={current === id}
            onClick={() => onPick(id)}
          />
        ))}
      </div>
    </>
  );
}
