import { useI18nStore, useT } from "../../lib/i18n";
import {
  addDays,
  datePart,
  timePart,
  todayStr,
  weekdayOf,
} from "../../lib/calendarTime";
import { DateField } from "./DateField";
import { TimeField } from "./TimeField";

/**
 * **The** wall-clock instant field: a day and an hour entered as two controls
 * that each do one job, plus a row of shortcuts for the instants people actually
 * schedule.
 *
 * It replaces `<input type="datetime-local">`, which is the worst of both native
 * widgets at once — six segments in an engine-locale order, a 12-vs-24-hour face
 * `Settings.time_format_24h` cannot reach, and WebKitGTK's undismissable
 * calendar popover — in one box that is hard to aim at and impossible to correct
 * without starting over. Splitting it is the whole point: `common/DateField`
 * picks the day from a drawn calendar, `common/TimeField` takes the hour in the
 * clock the setting chose, and the shortcuts mean the common cases ("in an
 * hour", "tomorrow morning") need neither.
 *
 * The value on the wire is the app's own local wall-clock stamp,
 * `"YYYY-MM-DDTHH:MM"` — what `schema::calendar`, `lib/calendarTime` and the
 * scheduled-prompt rules already store — or `""` when the day is cleared. Half a
 * value is never reported: an hour with no day is not an instant, so clearing
 * the date clears the whole field.
 */
interface Props {
  /** The stored instant, `"YYYY-MM-DDTHH:MM"`, or `""` for none. */
  value: string;
  /** Called with a new `"YYYY-MM-DDTHH:MM"`, or `""` when cleared. */
  onChange: (stamp: string) => void;
  /** Earliest selectable day, `"YYYY-MM-DD"` (the hour is not constrained). */
  minDate?: string;
  /** Show the shortcut row. On by default — it is why this field exists. */
  presets?: boolean;
  /** Offer a Clear button in the calendar (a caller whose instant is optional). */
  clearable?: boolean;
  disabled?: boolean;
  /** The box class both halves wear, so the field matches its dialog's inputs. */
  inputClassName?: string;
  "aria-label"?: string;
}

/** The hour a shortcut lands on when it names a part of the day rather than one. */
const MORNING = "09:00";
const EVENING = "18:00";

function stamp(date: string, time: string): string {
  return `${date}T${time}`;
}

/** `now + n` hours as a stamp, rounded down to the minute. */
export function inHours(now: Date, hours: number): string {
  const at = new Date(now.getTime() + hours * 3600_000);
  const pad = (v: number) => String(v).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** The next Monday strictly after `today`, as a date. */
export function nextMonday(today: string): string {
  const ahead = (8 - weekdayOf(today)) % 7 || 7;
  return addDays(today, ahead);
}

export function DateTimeField({
  value,
  onChange,
  minDate,
  presets = true,
  clearable,
  disabled,
  inputClassName = "cal-input",
  "aria-label": ariaLabel,
}: Props) {
  const t = useT();
  const lang = useI18nStore((state) => state.lang);
  const date = datePart(value);
  const time = timePart(value) || "00:00";
  const today = todayStr();

  const shortcuts: { key: string; label: string; to: () => string }[] = [
    { key: "hour", label: t("dateTime.inAnHour"), to: () => inHours(new Date(), 1) },
    { key: "evening", label: t("dateTime.thisEvening"), to: () => stamp(today, EVENING) },
    { key: "tomorrow", label: t("dateTime.tomorrowMorning"), to: () => stamp(addDays(today, 1), MORNING) },
    { key: "monday", label: t("dateTime.nextMonday"), to: () => stamp(nextMonday(today), MORNING) },
  ];

  return (
    <div className="datetime-field" role="group" aria-label={ariaLabel}>
      <div className="datetime-field-row">
        <DateField
          className={inputClassName}
          value={date}
          min={minDate}
          clearable={clearable}
          disabled={disabled}
          aria-label={t("dateTime.date")}
          // An hour with no day is not an instant: clearing the date clears the
          // field, and a first day adopts whatever hour is already showing.
          onChange={(next) => onChange(next ? stamp(next, time) : "")}
        />
        <TimeField
          className={inputClassName}
          value={date ? time : ""}
          disabled={disabled || !date}
          aria-label={t("dateTime.time")}
          // The clock cannot mint a day; with none picked yet the shortcuts or
          // the calendar go first, which is also what `disabled` above says.
          onChange={(next) => { if (date) onChange(stamp(date, next || "00:00")); }}
        />
        <span className="datetime-field-echo">
          {date ? new Date(`${date}T${time}`).toLocaleDateString(lang, { weekday: "long" }) : ""}
        </span>
      </div>
      {presets ? (
        <div className="datetime-field-presets">
          {shortcuts.map((shortcut) => (
            <button
              key={shortcut.key}
              type="button"
              className="datetime-chip"
              disabled={disabled}
              onClick={() => onChange(shortcut.to())}
            >
              {shortcut.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
