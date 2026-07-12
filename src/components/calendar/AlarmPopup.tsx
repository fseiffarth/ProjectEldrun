import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useAlarmStore } from "../../stores/alarms";
import { useCalendarStore } from "../../stores/calendar";
import { describeLead } from "../../lib/alarms";
import { formatLongDate, formatStampTime } from "../../lib/calendarTime";

/** The snooze offsets the buttons offer. */
const SNOOZES: { label: string; minutes: number }[] = [
  { label: "5 min", minutes: 5 },
  { label: "15 min", minutes: 15 },
  { label: "1 hour", minutes: 60 },
  { label: "Tomorrow", minutes: 24 * 60 },
];

/**
 * The in-app reminder popup — Thunderbird's alarm dialog.
 *
 * Mounted once at the app shell, not inside the calendar pane, so a reminder
 * reaches the user whatever they are looking at: there is no point firing an
 * alarm that only shows on the tab they are not on. It pairs with the OS
 * notification the alarm store sends; this is the half that can be snoozed.
 *
 * It renders nothing at all when no reminder is due, so it costs nothing to have
 * always mounted.
 */
export function AlarmPopup() {
  const active = useAlarmStore((s) => s.active);
  const dismiss = useAlarmStore((s) => s.dismiss);
  const dismissAll = useAlarmStore((s) => s.dismissAll);
  const snooze = useAlarmStore((s) => s.snooze);
  const start = useAlarmStore((s) => s.start);

  const loaded = useCalendarStore((s) => s.loaded);
  const load = useCalendarStore((s) => s.load);

  // Reminders must fire whether or not a calendar tab was ever opened, so the
  // shell — not the pane — is what guarantees the calendar is loaded and the
  // ticker running.
  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  useEffect(() => {
    if (loaded) start();
  }, [loaded, start]);

  if (active.length === 0) return null;

  return createPortal(
    <div className="cal-alarm-popup">
      <div className="cal-alarm-head">
        <span className="cal-alarm-title">
          {active.length === 1 ? "Reminder" : `${active.length} reminders`}
        </span>
        {active.length > 1 ? (
          <button className="cal-link-btn" onClick={dismissAll}>Dismiss all</button>
        ) : null}
      </div>

      <div className="cal-alarm-list">
        {active.map((alarm) => (
          <div key={alarm.key} className="cal-alarm-row">
            <div className="cal-alarm-main">
              <div className="cal-alarm-event">{alarm.title || "(untitled)"}</div>
              <div className="cal-alarm-when">
                {alarm.allDay
                  ? formatLongDate(alarm.start.split("T")[0])
                  : `${formatStampTime(alarm.start, true)} · ${describeLead(alarm.minutesBefore)}`}
                {alarm.location ? ` · ${alarm.location}` : ""}
              </div>
            </div>

            <div className="cal-alarm-actions">
              <span className="cal-alarm-snooze-label">Snooze</span>
              {SNOOZES.map((s) => (
                <button
                  key={s.minutes}
                  className="cal-chip"
                  onClick={() => snooze(alarm.key, s.minutes)}
                  title={`Remind me again in ${s.label}`}
                >
                  {s.label}
                </button>
              ))}
              <button
                className="cal-btn cal-btn-primary"
                onClick={() => dismiss(alarm.key)}
              >
                Dismiss
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>,
    document.body,
  );
}
