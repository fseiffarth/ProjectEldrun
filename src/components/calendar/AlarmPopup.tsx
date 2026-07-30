import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useAlarmStore } from "../../stores/alarms";
import { useCalendarStore } from "../../stores/calendar";
import { describeLead } from "../../lib/alarms";
import { formatLongDate, formatStampTime } from "../../lib/calendarTime";
import { useUse24h } from "../../lib/timeFormat";
import { useI18nStore, useT, type TranslationKey } from "../../lib/i18n";

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
/** The snooze offsets the buttons offer. */
const SNOOZE_KEYS: { key: TranslationKey; minutes: number }[] = [
  { key: "alarmPopup.snooze5", minutes: 5 },
  { key: "alarmPopup.snooze15", minutes: 15 },
  { key: "alarmPopup.snooze1h", minutes: 60 },
  { key: "alarmPopup.snoozeTomorrow", minutes: 24 * 60 },
];

export function AlarmPopup() {
  const t = useT();
  const use24h = useUse24h();
  const lang = useI18nStore((s) => s.lang);
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
          {active.length === 1 ? t("alarmPopup.reminderOne") : t("alarmPopup.reminderMany", { count: active.length })}
        </span>
        {active.length > 1 ? (
          <button className="cal-link-btn" onClick={dismissAll}>{t("alarmPopup.dismissAll")}</button>
        ) : null}
      </div>

      <div className="cal-alarm-list">
        {active.map((alarm) => (
          <div key={alarm.key} className="cal-alarm-row">
            <div className="cal-alarm-main">
              <div className="cal-alarm-event">{alarm.title || t("calendar.untitled")}</div>
              <div className="cal-alarm-when">
                {alarm.allDay
                  ? formatLongDate(alarm.start.split("T")[0], lang)
                  : `${formatStampTime(alarm.start, use24h)} · ${describeLead(alarm.minutesBefore, t)}`}
                {alarm.location ? ` · ${alarm.location}` : ""}
              </div>
            </div>

            <div className="cal-alarm-actions">
              <span className="cal-alarm-snooze-label">{t("alarmPopup.snoozeLabel")}</span>
              {SNOOZE_KEYS.map((s) => (
                <button
                  key={s.minutes}
                  className="cal-chip"
                  onClick={() => snooze(alarm.key, s.minutes)}
                  title={t("alarmPopup.remindAgainTitle", { label: t(s.key) })}
                >
                  {t(s.key)}
                </button>
              ))}
              <button
                className="cal-btn cal-btn-primary"
                onClick={() => dismiss(alarm.key)}
              >
                {t("alarmPopup.dismiss")}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>,
    document.body,
  );
}
