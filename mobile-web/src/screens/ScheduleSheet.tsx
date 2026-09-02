import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  createSchedule,
  deleteSchedule,
  getSchedules,
  updateSchedule,
  type ScheduleRule,
  type ScheduledPrompt,
  type ScheduledPromptInput,
} from "../api";

/** Per-tab scheduled prompts, shared by the project tab-list shortcut and the
 * live agent terminal's Schedule chip. Everything here goes through the opaque
 * tab id; the phone never learns the desktop's project id, tmux name or target
 * id. */
const MOBILE_WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function mobileLocalDateTime(): string {
  const date = new Date(Date.now() + 60 * 60 * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function scheduleRuleLabel(rule: ScheduleRule): string {
  if (rule.type === "once") return rule.at.replace("T", " ");
  if (rule.type === "daily") return `Daily · ${rule.time}`;
  return `${rule.weekdays.map((day) => MOBILE_WEEKDAYS[day - 1]).join(", ")} · ${rule.time}`;
}

export function ScheduleSheet({ tabId, label, onClose, initialMessage }: { tabId: string; label?: string; onClose: () => void; initialMessage?: string }) {
  const [schedules, setSchedules] = useState<ScheduledPrompt[]>([]);
  const [timeZone, setTimeZone] = useState("");
  const [nextRuns, setNextRuns] = useState<Record<string, string>>({});
  const [offline, setOffline] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [message, setMessage] = useState(initialMessage ?? "");
  const [kind, setKind] = useState<ScheduleRule["type"]>("daily");
  const [time, setTime] = useState("09:00");
  const [once, setOnce] = useState(mobileLocalDateTime);
  const [weekdays, setWeekdays] = useState([1, 2, 3, 4, 5]);

  const apply = useCallback((value: { schedules: ScheduledPrompt[]; time_zone: string; next_runs: Record<string, string> }) => {
    setSchedules(value.schedules);
    setTimeZone(value.time_zone);
    setNextRuns(value.next_runs);
    setOffline(false);
    setError("");
  }, []);
  const fail = useCallback((cause: unknown) => {
    const unavailable = cause instanceof ApiError && (cause.status === 503 || cause.code === "desktop_unavailable");
    setOffline(unavailable);
    setError(unavailable ? "Open desktop Eldrun to manage scheduled prompts." : "Schedules could not be loaded.");
  }, []);
  const refresh = useCallback(
    () => getSchedules(tabId).then(apply, fail).finally(() => setLoading(false)),
    [apply, fail, tabId],
  );
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const reset = () => {
    setEditing(null);
    setMessage("");
    setKind("daily");
    setTime("09:00");
    setOnce(mobileLocalDateTime());
    setWeekdays([1, 2, 3, 4, 5]);
  };
  const edit = (schedule: ScheduledPrompt) => {
    setEditing(schedule.id);
    setMessage(schedule.message);
    setKind(schedule.rule.type);
    if (schedule.rule.type === "once") setOnce(schedule.rule.at);
    else setTime(schedule.rule.time);
    if (schedule.rule.type === "weekdays") setWeekdays(schedule.rule.weekdays);
  };
  const input = (): ScheduledPromptInput => ({
    enabled: schedules.find((schedule) => schedule.id === editing)?.enabled ?? true,
    message,
    rule: kind === "once"
      ? { type: "once", at: once }
      : kind === "daily"
        ? { type: "daily", time }
        : { type: "weekdays", weekdays: [...weekdays].sort(), time },
  });
  const save = async () => {
    if (!message.trim() || (kind === "weekdays" && weekdays.length === 0)) {
      setError("Enter a prompt and choose at least one weekday.");
      return;
    }
    setBusy(true);
    try {
      apply(editing
        ? await updateSchedule(tabId, editing, input())
        : await createSchedule(tabId, input()));
      reset();
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  };

  return <div className="sheet-backdrop" role="presentation" onClick={onClose}>
    <section className="option-sheet schedule-sheet" role="dialog" aria-modal="true" aria-label={label ? `Scheduled prompts for ${label}` : "Scheduled prompts"} onClick={(event) => event.stopPropagation()}>
      <span className="sheet-grip" aria-hidden="true" />
      <header><button className="sheet-close" onClick={onClose} aria-label="Close">✕</button><h2>Scheduled prompts <small>Untested</small></h2><span className="sheet-close" aria-hidden="true" /></header>
      {label && <p className="sheet-note">Tab: {label}</p>}
      {timeZone && <p className="sheet-note">Desktop time zone: {timeZone}</p>}
      <p className="sheet-note">Due prompts wait up to one hour for an idle point. They replace any unsent composer draft, even when the tab is focused, and run only while desktop Eldrun is open.</p>
      {error && <p className="sheet-note error" role="alert">{error}</p>}
      {loading ? <p className="sheet-note">Loading schedules…</p> : schedules.length === 0 ? <p className="sheet-note">No prompts are scheduled for this tab.</p> : <div className="mobile-schedule-list">{schedules.map((schedule) => <article key={schedule.id}>
        <strong>{scheduleRuleLabel(schedule.rule)}</strong><p>{schedule.message}</p>
        {nextRuns[schedule.id] && <small>Next: {nextRuns[schedule.id].replace("T", " ")} ({timeZone})</small>}
        {schedule.last && <small>Last: {schedule.last.result} · {new Date(schedule.last.at).toLocaleString()}</small>}
        <div><label><input type="checkbox" checked={schedule.enabled} disabled={busy || offline} onChange={() => {
          setBusy(true);
          void updateSchedule(tabId, schedule.id, { enabled: !schedule.enabled, message: schedule.message, rule: schedule.rule }).then(apply, fail).finally(() => setBusy(false));
        }} /> Enabled</label><button disabled={busy || offline} onClick={() => edit(schedule)}>Edit</button><button className="danger" disabled={busy || offline} onClick={() => { setBusy(true); void deleteSchedule(tabId, schedule.id).then(apply, fail).finally(() => setBusy(false)); }}>Delete</button></div>
      </article>)}</div>}
      <div className="mobile-schedule-form" aria-disabled={offline}>
        <h3>{editing ? "Edit schedule" : "Add schedule"}</h3>
        <label>Prompt<textarea rows={4} value={message} disabled={offline} onChange={(event) => setMessage(event.target.value)} /></label>
        <label>Recurrence<select value={kind} disabled={offline} onChange={(event) => setKind(event.target.value as ScheduleRule["type"])}><option value="once">One time</option><option value="daily">Daily</option><option value="weekdays">Selected weekdays</option></select></label>
        {kind === "once" ? <label>Desktop-local date and time<input type="datetime-local" value={once} disabled={offline} onChange={(event) => setOnce(event.target.value)} /></label> : <label>Desktop-local time<input type="time" value={time} disabled={offline} onChange={(event) => setTime(event.target.value)} /></label>}
        {kind === "weekdays" && <div className="mobile-schedule-weekdays">{MOBILE_WEEKDAYS.map((name, index) => <label key={name}><input type="checkbox" disabled={offline} checked={weekdays.includes(index + 1)} onChange={() => setWeekdays((current) => current.includes(index + 1) ? current.filter((day) => day !== index + 1) : [...current, index + 1])} />{name}</label>)}</div>}
        <div className="mobile-schedule-actions">{editing && <button disabled={busy} onClick={reset}>Cancel</button>}<button className="primary" disabled={busy || offline} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</button></div>
      </div>
    </section>
  </div>;
}
