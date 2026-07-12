import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type {
  Alarm,
  Calendar,
  CalendarEvent,
  EventStatus,
  Freq,
  Occurrence,
  Rrule,
} from "../../types";
import { CATEGORIES } from "../../lib/calendarCategories";
import {
  allDayEndToLastDay,
  datePart,
  lastDayToAllDayEnd,
  minutesBetween,
  timePart,
} from "../../lib/calendarTime";
import { describeRrule } from "../../lib/recurrence";

/** The reminder offsets the dropdown offers, in minutes before the start. */
const REMINDER_CHOICES: { label: string; minutes: number }[] = [
  { label: "At the time of the event", minutes: 0 },
  { label: "5 minutes before", minutes: 5 },
  { label: "15 minutes before", minutes: 15 },
  { label: "30 minutes before", minutes: 30 },
  { label: "1 hour before", minutes: 60 },
  { label: "1 day before", minutes: 1440 },
];

const WEEKDAY_INITIALS = ["S", "M", "T", "W", "T", "F", "S"];

/** What the dialog was opened on. */
export interface EventDialogTarget {
  /** The stored event, or null when creating. */
  event: CalendarEvent | null;
  /** The occurrence clicked, when editing one instance of a series. */
  occurrence: Occurrence | null;
  /** Prefilled span for a new event (from a drag or a day double-click). */
  draftStart?: string;
  draftEnd?: string;
  draftAllDay?: boolean;
}

/** How an edit to a recurring event should apply. */
export type EditScope = "this" | "all";

interface Props {
  target: EventDialogTarget;
  calendars: Calendar[];
  defaultCalendarId: string;
  defaultReminderMinutes: number;
  onClose: () => void;
  /** Save. `scope` is meaningful only for a recurring event. */
  onSave: (event: CalendarEvent, scope: EditScope) => Promise<void> | void;
  onDelete: (event: CalendarEvent, scope: EditScope) => Promise<void> | void;
}

/** The dialog's editable form state. */
interface Form {
  calendarId: string;
  title: string;
  location: string;
  notes: string;
  category: string;
  status: EventStatus;
  allDay: boolean;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  repeats: boolean;
  freq: Freq;
  interval: number;
  byweekday: number[];
  /** `""` = forever, `"count"`, or `"until"`. */
  endMode: "" | "count" | "until";
  count: number;
  until: string;
  alarms: Alarm[];
}

/** Seed the form from the event/occurrence being edited, or from a new draft. */
function initialForm(
  target: EventDialogTarget,
  defaultCalendarId: string,
  defaultReminderMinutes: number,
): Form {
  const { event, occurrence } = target;

  // When editing one occurrence of a series, the form shows THAT occurrence's
  // times — not the master's — since that is what the user clicked on.
  const start = occurrence?.start ?? event?.start ?? target.draftStart ?? "";
  const end = occurrence?.end ?? event?.end ?? target.draftEnd ?? "";
  const allDay = occurrence?.allDay ?? event?.all_day ?? target.draftAllDay ?? false;
  const rrule = event?.rrule ?? null;

  return {
    calendarId: event?.calendar_id ?? defaultCalendarId,
    title: occurrence?.title ?? event?.title ?? "",
    location: occurrence?.location ?? event?.location ?? "",
    notes: occurrence?.notes ?? event?.notes ?? "",
    category: event?.category ?? "",
    status: (event?.status || "confirmed") as EventStatus,
    allDay,
    startDate: datePart(start),
    startTime: timePart(start) || "09:00",
    // An all-day event's end is exclusive on disk; the picker shows the LAST day,
    // which is what a user means by "ends on".
    endDate: allDay ? allDayEndToLastDay(end) : datePart(end),
    endTime: timePart(end) || "10:00",
    repeats: !!rrule,
    freq: rrule?.freq ?? "weekly",
    interval: rrule?.interval ?? 1,
    byweekday: rrule?.byweekday ?? [],
    endMode: rrule?.count ? "count" : rrule?.until ? "until" : "",
    count: rrule?.count ?? 10,
    until: rrule?.until ?? "",
    alarms:
      event?.alarms ??
      (defaultReminderMinutes > 0 && !event
        ? [{ minutes_before: defaultReminderMinutes }]
        : []),
  };
}

/**
 * The event editor.
 *
 * Reuses the app's canonical dialog shell (`.modal-backdrop` > `.settings-dialog`
 * with an accent `.settings-title-row` header and divider), so it reads
 * identically to every other modal. Being portaled, it sets its text color
 * explicitly — `body` carries none, so an inherited color would render black.
 *
 * Editing an occurrence of a recurring event asks the "this one / the whole
 * series" question on save, exactly once, rather than up front — most edits are
 * to a single occurrence and the prompt would otherwise be pure friction.
 */
export function EventDialog({
  target,
  calendars,
  defaultCalendarId,
  defaultReminderMinutes,
  onClose,
  onSave,
  onDelete,
}: Props) {
  const [form, setForm] = useState<Form>(() =>
    initialForm(target, defaultCalendarId, defaultReminderMinutes),
  );
  /** Set when a recurring event needs its scope confirmed; holds the pending act. */
  const [scopeAsk, setScopeAsk] = useState<"save" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const creating = target.event === null;
  const recurring = !!target.event?.rrule;

  useEffect(() => {
    setForm(initialForm(target, defaultCalendarId, defaultReminderMinutes));
    setScopeAsk(null);
    setError(null);
  }, [target, defaultCalendarId, defaultReminderMinutes]);

  const patch = (p: Partial<Form>) => setForm((f) => ({ ...f, ...p }));

  const ruleSummary = useMemo(
    () => (form.repeats ? describeRrule(buildRrule(form)) : "Does not repeat"),
    [form],
  );

  /** The form, back as a stored event. */
  function toEvent(): CalendarEvent | null {
    const title = form.title.trim();
    if (!title) {
      setError("A title is required.");
      return null;
    }
    if (!form.startDate) {
      setError("A start date is required.");
      return null;
    }

    const start = form.allDay ? form.startDate : `${form.startDate}T${form.startTime}`;
    const endDay = form.endDate || form.startDate;
    const end = form.allDay
      ? lastDayToAllDayEnd(endDay)
      : `${endDay}T${form.endTime}`;

    if (!form.allDay && minutesBetween(start, end) <= 0) {
      setError("The event must end after it starts.");
      return null;
    }
    if (form.allDay && lastDayToAllDayEnd(endDay) <= form.startDate) {
      setError("The event must end on or after the day it starts.");
      return null;
    }

    const base = target.event;
    return {
      id: base?.id ?? "",
      calendar_id: form.calendarId,
      start,
      end,
      all_day: form.allDay,
      title,
      location: form.location.trim(),
      notes: form.notes.trim(),
      category: form.category,
      status: form.status,
      rrule: form.repeats ? buildRrule(form) : null,
      // Exdates/overrides belong to the series and must survive an edit to it.
      exdates: base?.exdates ?? [],
      overrides: base?.overrides ?? [],
      alarms: form.alarms,
    };
  }

  function attemptSave() {
    setError(null);
    const event = toEvent();
    if (!event) return;
    // Editing one occurrence of a series → ask which it applies to.
    if (recurring && target.occurrence) {
      setScopeAsk("save");
      return;
    }
    void onSave(event, "all");
  }

  function attemptDelete() {
    if (!target.event) return;
    if (recurring && target.occurrence) {
      setScopeAsk("delete");
      return;
    }
    void onDelete(target.event, "all");
  }

  function resolveScope(scope: EditScope) {
    const pending = scopeAsk;
    setScopeAsk(null);
    if (pending === "delete") {
      if (target.event) void onDelete(target.event, scope);
      return;
    }
    const event = toEvent();
    if (event) void onSave(event, scope);
  }

  const toggleWeekday = (d: number) =>
    patch({
      byweekday: form.byweekday.includes(d)
        ? form.byweekday.filter((x) => x !== d)
        : [...form.byweekday, d].sort((a, b) => a - b),
    });

  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="settings-dialog cal-event-dialog"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="settings-title-row">
          <h2>{creating ? "New event" : "Edit event"}</h2>
          <button type="button" className="dialog-close-btn" onClick={onClose}>×</button>
        </div>

        {scopeAsk ? (
          /* The this-one-or-all question. It replaces the form rather than
             stacking a second modal on top of it — one decision, in place. */
          <div className="cal-scope-ask">
            <p className="settings-help">
              <strong>{form.title || "This event"}</strong> repeats.{" "}
              {scopeAsk === "delete"
                ? "Delete only the occurrence you clicked, or the whole series?"
                : "Apply your changes to only the occurrence you clicked, or to the whole series?"}
            </p>
            <div className="cal-form-actions">
              <button className="cal-btn cal-btn-primary" onClick={() => resolveScope("this")}>
                {scopeAsk === "delete" ? "Delete this occurrence" : "This occurrence only"}
              </button>
              <button className="cal-btn" onClick={() => resolveScope("all")}>
                {scopeAsk === "delete" ? "Delete the whole series" : "All occurrences"}
              </button>
              <button className="cal-link-btn" onClick={() => setScopeAsk(null)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="cal-event-form">
            <label className="cal-field">
              <span className="cal-field-label">Title</span>
              <input
                className="cal-input"
                type="text"
                autoFocus
                value={form.title}
                onChange={(e) => patch({ title: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") attemptSave();
                }}
              />
            </label>

            <label className="cal-field">
              <span className="cal-field-label">Location</span>
              <input
                className="cal-input"
                type="text"
                value={form.location}
                onChange={(e) => patch({ location: e.target.value })}
              />
            </label>

            <label className="cal-check-row">
              <input
                type="checkbox"
                checked={form.allDay}
                onChange={(e) => patch({ allDay: e.target.checked })}
              />
              <span>All day</span>
            </label>

            <div className="cal-field-row">
              <label className="cal-field">
                <span className="cal-field-label">Starts</span>
                <div className="cal-datetime">
                  <input
                    className="cal-input"
                    type="date"
                    value={form.startDate}
                    onChange={(e) => patch({ startDate: e.target.value })}
                  />
                  {!form.allDay ? (
                    <input
                      className="cal-input"
                      type="time"
                      value={form.startTime}
                      onChange={(e) => patch({ startTime: e.target.value })}
                    />
                  ) : null}
                </div>
              </label>

              <label className="cal-field">
                <span className="cal-field-label">Ends</span>
                <div className="cal-datetime">
                  <input
                    className="cal-input"
                    type="date"
                    value={form.endDate}
                    onChange={(e) => patch({ endDate: e.target.value })}
                  />
                  {!form.allDay ? (
                    <input
                      className="cal-input"
                      type="time"
                      value={form.endTime}
                      onChange={(e) => patch({ endTime: e.target.value })}
                    />
                  ) : null}
                </div>
              </label>
            </div>

            <div className="cal-field-row">
              <label className="cal-field">
                <span className="cal-field-label">Calendar</span>
                <select
                  className="cal-input"
                  value={form.calendarId}
                  onChange={(e) => patch({ calendarId: e.target.value })}
                >
                  {calendars.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </label>

              <label className="cal-field">
                <span className="cal-field-label">Category</span>
                <select
                  className="cal-input"
                  value={form.category}
                  onChange={(e) => patch({ category: e.target.value })}
                >
                  <option value="">None</option>
                  {CATEGORIES.map((c) => (
                    <option key={c.key} value={c.key}>{c.label}</option>
                  ))}
                </select>
              </label>

              <label className="cal-field">
                <span className="cal-field-label">Status</span>
                <select
                  className="cal-input"
                  value={form.status}
                  onChange={(e) => patch({ status: e.target.value as EventStatus })}
                >
                  <option value="confirmed">Confirmed</option>
                  <option value="tentative">Tentative</option>
                  <option value="cancelled">Cancelled</option>
                </select>
              </label>
            </div>

            {/* ── Repeat ─────────────────────────────────────────────────── */}
            <div className="cal-section">
              <label className="cal-check-row">
                <input
                  type="checkbox"
                  checked={form.repeats}
                  onChange={(e) => patch({ repeats: e.target.checked })}
                />
                <span>Repeat</span>
                <span className="cal-rule-summary">{ruleSummary}</span>
              </label>

              {form.repeats ? (
                <div className="cal-repeat">
                  <div className="cal-field-row">
                    <label className="cal-field">
                      <span className="cal-field-label">Every</span>
                      <input
                        className="cal-input cal-input-num"
                        type="number"
                        min={1}
                        value={form.interval}
                        onChange={(e) =>
                          patch({ interval: Math.max(1, Number(e.target.value) || 1) })
                        }
                      />
                    </label>
                    <label className="cal-field">
                      <span className="cal-field-label">&nbsp;</span>
                      <select
                        className="cal-input"
                        value={form.freq}
                        onChange={(e) => patch({ freq: e.target.value as Freq })}
                      >
                        <option value="daily">day(s)</option>
                        <option value="weekly">week(s)</option>
                        <option value="monthly">month(s)</option>
                        <option value="yearly">year(s)</option>
                      </select>
                    </label>
                  </div>

                  {form.freq === "weekly" ? (
                    <div className="cal-weekdays">
                      {WEEKDAY_INITIALS.map((w, d) => (
                        <button
                          key={d}
                          type="button"
                          className={`cal-weekday-btn${form.byweekday.includes(d) ? " cal-weekday-on" : ""}`}
                          onClick={() => toggleWeekday(d)}
                          title={
                            ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d]
                          }
                        >
                          {w}
                        </button>
                      ))}
                    </div>
                  ) : null}

                  <div className="cal-field-row">
                    <label className="cal-field">
                      <span className="cal-field-label">Ends</span>
                      <select
                        className="cal-input"
                        value={form.endMode}
                        onChange={(e) =>
                          patch({ endMode: e.target.value as Form["endMode"] })
                        }
                      >
                        <option value="">Never</option>
                        <option value="count">After N times</option>
                        <option value="until">On a date</option>
                      </select>
                    </label>

                    {form.endMode === "count" ? (
                      <label className="cal-field">
                        <span className="cal-field-label">Times</span>
                        <input
                          className="cal-input cal-input-num"
                          type="number"
                          min={1}
                          value={form.count}
                          onChange={(e) =>
                            patch({ count: Math.max(1, Number(e.target.value) || 1) })
                          }
                        />
                      </label>
                    ) : null}

                    {form.endMode === "until" ? (
                      <label className="cal-field">
                        <span className="cal-field-label">Until</span>
                        <input
                          className="cal-input"
                          type="date"
                          value={form.until}
                          onChange={(e) => patch({ until: e.target.value })}
                        />
                      </label>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>

            {/* ── Reminders ──────────────────────────────────────────────── */}
            <div className="cal-section">
              <div className="cal-section-head">
                <span className="cal-field-label">Reminders</span>
                <button
                  type="button"
                  className="cal-link-btn"
                  onClick={() => patch({ alarms: [...form.alarms, { minutes_before: 15 }] })}
                >
                  + Add reminder
                </button>
              </div>

              {form.alarms.length === 0 ? (
                <div className="cal-hint">No reminders.</div>
              ) : (
                form.alarms.map((alarm, i) => (
                  <div key={i} className="cal-alarm-row">
                    <select
                      className="cal-input"
                      value={alarm.minutes_before}
                      onChange={(e) => {
                        const alarms = [...form.alarms];
                        alarms[i] = { minutes_before: Number(e.target.value) };
                        patch({ alarms });
                      }}
                    >
                      {REMINDER_CHOICES.map((c) => (
                        <option key={c.minutes} value={c.minutes}>{c.label}</option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="cal-link-btn cal-link-danger"
                      onClick={() => patch({ alarms: form.alarms.filter((_, j) => j !== i) })}
                    >
                      Remove
                    </button>
                  </div>
                ))
              )}
            </div>

            <label className="cal-field">
              <span className="cal-field-label">Notes</span>
              <textarea
                className="cal-input cal-textarea"
                value={form.notes}
                onChange={(e) => patch({ notes: e.target.value })}
              />
            </label>

            {error ? <div className="cal-error">{error}</div> : null}

            <div className="cal-form-actions">
              <button className="cal-btn cal-btn-primary" onClick={attemptSave}>
                Save
              </button>
              {!creating ? (
                <button className="cal-btn cal-btn-danger" onClick={attemptDelete}>
                  Delete
                </button>
              ) : null}
              <button className="cal-link-btn" onClick={onClose}>Cancel</button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** The form's repeat fields, as a stored rule. */
function buildRrule(form: Form): Rrule {
  return {
    freq: form.freq,
    interval: Math.max(1, form.interval),
    byweekday: form.freq === "weekly" ? form.byweekday : [],
    bymonthday: null,
    until: form.endMode === "until" && form.until ? form.until : null,
    count: form.endMode === "count" ? Math.max(1, form.count) : null,
  };
}
