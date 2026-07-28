import { useEffect } from "react";
import { useCalendarStore } from "../../stores/calendar";
import { useSettingsStore } from "../../stores/settings";
import { useT } from "../../lib/i18n";
import { UntestedTag } from "../common/UntestedTag";
import { CalendarPane } from "./CalendarPane";

/**
 * The header calendar button's overlay — the twin of `MailOverlayHost`, and the
 * same bargain: it renders the *same* `CalendarPane` a calendar tab renders, not
 * a second calendar UI. The store is already global (one `calendar.json` across
 * every scope), so the overlay and any open tab are two views of one set of
 * events and cannot drift; all this adds is a size and a way to close it.
 */
export function CalendarOverlayHost() {
  const t = useT();
  const enabled = useSettingsStore((s) => s.settings?.calendar_global_app ?? false);
  const open = useCalendarStore((s) => s.overlayOpen);

  // Turning the setting off takes the surface away rather than leaving it on
  // screen over a button that is no longer there — the same withdrawal rule the
  // mail overlay follows for its two gates.
  const live = enabled && open;

  useEffect(() => {
    if (!live) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        useCalendarStore.getState().closeOverlay();
      }
    };
    // The pane hosts the event dialog and a search field, both of which stop
    // their own Escape — so this window-level listener only ever sees one
    // nothing else claimed.
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [live]);

  if (!live) return null;

  return (
    /* `.project-dialog.dialog-framed` + `.settings-title-row` + `.dialog-close-btn`
       — the app's canonical dialog chrome, applied exactly as the mail overlay
       and GlobalMachineMonitorDialog apply it: a whole pane hosted in a dialog,
       sized by its own rule, in a body that clips because the pane scrolls its
       own regions. */
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        // Backdrop only — a drag that starts on the grid and ends out here
        // (creating or resizing an event) must not be read as "dismiss".
        if (e.target === e.currentTarget) useCalendarStore.getState().closeOverlay();
      }}
    >
      <div
        className="project-dialog dialog-framed calendar-overlay"
        role="dialog"
        aria-modal="true"
        aria-label={t("calendar.overlayTitle")}
      >
        <div className="settings-title-row">
          <h2>
            {t("calendar.overlayTitle")} <UntestedTag />
          </h2>
          <button
            type="button"
            className="dialog-close-btn"
            title={t("common.close")}
            aria-label={t("common.close")}
            onClick={() => useCalendarStore.getState().closeOverlay()}
          >
            ×
          </button>
        </div>
        <div className="calendar-overlay-body">
          <CalendarPane visible />
        </div>
      </div>
    </div>
  );
}
