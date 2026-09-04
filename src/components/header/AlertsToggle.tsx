import { useSettingsStore } from "../../stores/settings";
import { useHeaderStatusReport } from "../../stores/headerStatus";
import { useT } from "../../lib/i18n";

/**
 * The header's bell: the on/off switch for the Alerts group (urgent mail, the
 * next appointments, due/overdue cards) that stacks below the project file tree.
 *
 * It used to be a button in `ProjectFilesView`'s toolbar, beside 📥 and ⚙ — the
 * project-local row. That was the wrong home for it, because the thing it
 * switches is not project-local: `files_alerts` is one machine-wide setting, and
 * the group it reveals draws the same mail, appointments and cards whichever
 * project is open (which is why `AlertsSection` wears the machine's chrome and
 * not the panel's). Living in the per-project toolbar, one switch was rendered
 * once per open file viewer and read as a property of the project whose files
 * were on screen.
 *
 * It then sat with the global *apps* (✉ 🗓 ☑), and now sits inside
 * `StatusCluster` with the machine-state readouts, for the reason those five
 * were folded in the first place: at rest it has nothing to say, and a bar full
 * of permanently lit controls is paid for by the project strip. As a cluster
 * member it reports `ok` while armed and `off` while switched off — dormant, not
 * a problem, so it never escalates itself out of the fold and never reddens the
 * summary lamp. Folded away, it is one click behind the cluster's own toggle.
 *
 * It wears its neighbours' chrome exactly — `.global-apps-menu-btn` inside a
 * `.global-apps-menu`, with `.alerts-toggle-btn` joined to the ✉/🗓/☑ rule sets
 * in `styles/mail-todo.css` rather than given a fourth treatment of its own. On
 * is the same `aria-pressed` fill those three use for "the overlay is open"; the
 * only difference is that this one's pressed state stands rather than following
 * an overlay, and nothing in the pixels needs to say so — which is also why the
 * bell is drawn identically whether alerts are on or off.
 *
 * The glyph is a **drawn** bell rather than 🔔, matching ✉ and ☑ (monochrome,
 * schematic, `currentColor`) instead of dropping one colour emoji into a row of
 * line art — and next to the cluster's own hand-drawn SVGs (`ConnTypeIcon`,
 * `BatteryIndicator`) an emoji would have been the odd one out twice over.
 *
 * The button is deliberately always rendered, never gated on the setting it
 * writes: it IS the way back from the group's ×, so hiding it while the group is
 * off would leave that × a one-way door out of a default-on feature. Being the
 * same key the Project Settings dialog writes, the two can never disagree.
 *
 * One thing did not survive the move out of the panel: the toolbar button could
 * switch the pane to the files view when revealing the group, since it was
 * inside that pane. A header button has no pane to steer, so revealing while the
 * panel shows Git or Apps arms the group where it already lives rather than
 * jumping there.
 */
export function AlertsToggle() {
  const enabled = useSettingsStore((s) => s.settings?.files_alerts ?? true);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const t = useT();
  const label = enabled ? t("filesAlerts.headerHide") : t("filesAlerts.headerShow");

  useHeaderStatusReport("alerts", {
    tone: enabled ? "ok" : "off",
    label: enabled ? t("filesAlerts.statusOn") : t("filesAlerts.statusOff"),
  });

  return (
    /* The wrapper the mail, calendar, to-do and brain buttons share:
       `.header-right` stretches its children to the full header height, so a
       bare 32px button would sit at the top of the frame instead of centered. */
    <div className="global-apps-menu alerts-toggle no-drag">
      <button
        type="button"
        className="global-apps-menu-btn alerts-toggle-btn"
        title={label}
        aria-label={label}
        aria-pressed={enabled}
        onClick={() => void updateSettings({ files_alerts: !enabled })}
      >
        <svg
          className="alerts-toggle-icon"
          viewBox="0 0 16 16"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
        >
          {/* dome: straight sides closed by a half-round top */}
          <path
            d="M4.9 10.6V7.3a3.1 3.1 0 0 1 6.2 0v3.3"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            fill="none"
          />
          {/* rim */}
          <line
            x1="3.5"
            y1="10.7"
            x2="12.5"
            y2="10.7"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
          />
          {/* clapper */}
          <path
            d="M6.8 12.2a1.3 1.3 0 0 0 2.4 0"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            fill="none"
          />
        </svg>
      </button>
    </div>
  );
}
