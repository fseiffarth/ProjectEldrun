import { useSettingsStore } from "../../stores/settings";
import { useT } from "../../lib/i18n";

/**
 * The header's 🔔: the on/off switch for the Alerts group (urgent mail, the next
 * appointments, due/overdue cards) that stacks below the project file tree.
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
 * So it sits here instead, between the ☑ board and the 🧠 model menu — with the
 * other global *apps*, all of which are the same kind of thing: one control, one
 * machine-wide state, reachable from anywhere including a project-less window.
 *
 * It wears its neighbours' chrome exactly — `.global-apps-menu-btn` inside a
 * `.global-apps-menu`, with `.alerts-toggle-btn` joined to the ✉/🗓/☑ rule sets
 * in `styles/mail-todo.css` rather than given a fourth treatment of its own. On
 * is the same `aria-pressed` fill those three use for "the overlay is open"; the
 * only difference is that this one's pressed state stands rather than following
 * an overlay, and nothing in the pixels needs to say so.
 *
 * The button is deliberately always rendered, never gated on the setting it
 * writes: it IS the way back from the group's ×, so hiding it while the group is
 * off would leave that × a one-way door out of a default-on feature. Being the
 * same key the Project Settings dialog writes, the two can never disagree.
 *
 * One thing did not survive the move: the toolbar button could switch the pane
 * to the files view when revealing the group, since it was inside that pane. A
 * header button has no pane to steer, so revealing while the panel shows Git or
 * Apps arms the group where it already lives rather than jumping there.
 */
export function AlertsToggle() {
  const enabled = useSettingsStore((s) => s.settings?.files_alerts ?? true);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const t = useT();
  const label = enabled ? t("filesAlerts.headerHide") : t("filesAlerts.headerShow");

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
        <span className="alerts-toggle-icon" aria-hidden="true">
          🔔
        </span>
      </button>
    </div>
  );
}
