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
  wasApplied,
} from "../api";
import { describeFailure } from "../connection";
import { useT } from "../../../src/lib/i18n";
import { isUntested } from "../../../src/lib/untested";
import { BRAND } from "../../../src/lib/brand";

/** Per-tab scheduled prompts, opened from the project tab overview — the phone's
 * counterpart to the desktop Agents view, and deliberately not from inside the
 * session, so scheduling a prompt never means attaching a terminal. Everything
 * here goes through the opaque tab id; the phone never learns the desktop's
 * project id, tmux name or target id. */
const MOBILE_WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function mobileLocalDateTime(): string {
  const date = new Date(Date.now() + 60 * 60 * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** "In … h … min": whole minutes ahead, or null for what the boxes must not
 * accept (blank both, negative, fractional, zero). */
function delayMinutes(hours: string, minutes: string): number | null {
  const h = hours.trim() === "" ? 0 : Number(hours);
  const m = minutes.trim() === "" ? 0 : Number(minutes);
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || m < 0) return null;
  const total = h * 60 + m;
  return total > 0 ? total : null;
}

/** An instant as the desktop's wall clock (`YYYY-MM-DDTHH:MM`), which is what a
 * one-time rule stores: the phone may sit in another zone than the desktop.
 * Falls back to the phone's own clock when the zone is unknown. */
function desktopMinute(at: Date, timeZone: string): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  if (timeZone) {
    try {
      const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
        timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
      }).formatToParts(at).map((part) => [part.type, part.value]));
      return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
    } catch {
      // An unknown zone name: the phone's clock below.
    }
  }
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** The form's kinds: the stored rule types plus "in", a one-time rule whose
 * instant is taken from the clock at Save and stored as `once`. */
type FormKind = ScheduleRule["type"] | "in";

function scheduleRuleLabel(rule: ScheduleRule): string {
  if (rule.type === "once") return rule.at.replace("T", " ");
  if (rule.type === "daily") return `Daily · ${rule.time}`;
  return `${rule.weekdays.map((day) => MOBILE_WEEKDAYS[day - 1]).join(", ")} · ${rule.time}`;
}

export function ScheduleSheet({ tabId, label, onClose, initialMessage }: { tabId: string; label?: string; onClose: () => void; initialMessage?: string }) {
  const t = useT();
  const [schedules, setSchedules] = useState<ScheduledPrompt[]>([]);
  const [timeZone, setTimeZone] = useState("");
  const [nextRuns, setNextRuns] = useState<Record<string, string>>({});
  const [offline, setOffline] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [message, setMessage] = useState(initialMessage ?? "");
  const [kind, setKind] = useState<FormKind>("once");
  const [time, setTime] = useState("09:00");
  const [once, setOnce] = useState(mobileLocalDateTime);
  const [inHours, setInHours] = useState("1");
  const [inMinutes, setInMinutes] = useState("0");
  const [weekdays, setWeekdays] = useState([1, 2, 3, 4, 5]);

  const apply = useCallback((value: { schedules: ScheduledPrompt[]; time_zone: string; next_runs: Record<string, string>; desktop_available?: boolean }) => {
    setSchedules(value.schedules);
    setTimeZone(value.time_zone);
    setNextRuns(value.next_runs);
    // Listed off the host's files with no window open: the Mobile host
    // writes them itself (headless owner plan, H3); the note says so.
    setOffline(value.desktop_available === false);
    setError("");
  }, []);
  const fail = useCallback((cause: unknown) => {
    // Made on the desktop, only the refreshed list did not come back: say so,
    // rather than "could not be loaded" under a form that invites a resend.
    if (wasApplied(cause)) {
      setError(describeFailure(cause));
      return;
    }
    const unavailable = cause instanceof ApiError && (cause.status === 503 || cause.code === "desktop_unavailable");
    setOffline(unavailable);
    setError(unavailable ? `Open desktop ${BRAND.display} to manage scheduled prompts.` : "Schedules could not be loaded.");
  }, []);
  // Held only when the host itself could not answer (a 503): with the window
  // closed the host writes the rules itself (headless owner plan, H3).
  const held = offline && !!error;
  const refresh = useCallback(
    () => getSchedules(tabId).then(apply, fail).finally(() => setLoading(false)),
    [apply, fail, tabId],
  );
  useEffect(() => {
    // Gated like the project screen's poll: a sheet left open when the screen
    // went off kept a desktop round trip going every 5s all night.
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      void refresh();
    };
    void refresh();
    const timer = window.setInterval(tick, 5_000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [refresh]);

  const reset = () => {
    setEditing(null);
    setMessage("");
    setKind("once");
    setTime("09:00");
    setOnce(mobileLocalDateTime());
    setInHours("1");
    setInMinutes("0");
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
    rule: kind === "in"
      ? { type: "once", at: desktopMinute(new Date(Date.now() + (delayMinutes(inHours, inMinutes) ?? 0) * 60_000), timeZone) }
      : kind === "once"
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
    if (kind === "in" && delayMinutes(inHours, inMinutes) === null) {
      setError(t("agentSchedule.invalidRule"));
      return;
    }
    setBusy(true);
    try {
      apply(editing
        ? await updateSchedule(tabId, editing, input())
        : await createSchedule(tabId, input()));
      reset();
    } catch (cause) {
      if (wasApplied(cause)) reset();
      fail(cause);
    } finally {
      setBusy(false);
    }
  };

  return <div className="sheet-backdrop" role="presentation" onClick={onClose}>
    <section className="option-sheet schedule-sheet" role="dialog" aria-modal="true" aria-label={label ? `Scheduled prompts for ${label}` : "Scheduled prompts"} onClick={(event) => event.stopPropagation()}>
      <span className="sheet-grip" aria-hidden="true" />
      <header><button className="sheet-close" onClick={onClose} aria-label="Close">✕</button><h2>Scheduled prompts {isUntested("mobile.sheet.schedules") && <small>{t("mobile.newTab.untested")}</small>}</h2><span className="sheet-close" aria-hidden="true" /></header>
      {label && <p className="sheet-note">Tab: {label}</p>}
      {timeZone && <p className="sheet-note">Desktop time zone: {timeZone}</p>}
      <p className="sheet-note">Due prompts wait up to one hour for an idle point. They replace any unsent composer draft, even when the tab is focused, and run only while desktop {BRAND.display} is open.</p>
      {error && <p className="sheet-note error" role="alert">{error}</p>}
      {offline && !error && <p className="sheet-note" role="status">{t("mobile.headless.owner")} {isUntested("mobile.headless.schedules") && <span className="untested">{t("mobile.newTab.untested")}</span>}</p>}
      {loading ? <p className="sheet-note">Loading schedules…</p> : schedules.length === 0 ? <p className="sheet-note">No prompts are scheduled for this tab.</p> : <div className="mobile-schedule-list">{schedules.map((schedule) => <article key={schedule.id}>
        <strong>{scheduleRuleLabel(schedule.rule)}</strong><p>{schedule.message}</p>
        {nextRuns[schedule.id] && <small>Next: {nextRuns[schedule.id].replace("T", " ")} ({timeZone})</small>}
        {schedule.last && <small>Last: {schedule.last.result} · {new Date(schedule.last.at).toLocaleString()}</small>}
        <div><label><input type="checkbox" checked={schedule.enabled} disabled={busy || held} onChange={() => {
          setBusy(true);
          void updateSchedule(tabId, schedule.id, { enabled: !schedule.enabled, message: schedule.message, rule: schedule.rule }).then(apply, fail).finally(() => setBusy(false));
        }} /> Enabled</label><button disabled={busy || held} onClick={() => edit(schedule)}>Edit</button><button className="danger" disabled={busy || held} onClick={() => { setBusy(true); void deleteSchedule(tabId, schedule.id).then(apply, fail).finally(() => setBusy(false)); }}>Delete</button></div>
      </article>)}</div>}
      <div className="mobile-schedule-form" aria-disabled={held}>
        <h3>{editing ? "Edit schedule" : "Add schedule"}</h3>
        <label>Prompt<textarea rows={4} value={message} disabled={held} onChange={(event) => setMessage(event.target.value)} /></label>
        <label>Recurrence<select value={kind} disabled={held} onChange={(event) => setKind(event.target.value as FormKind)}><option value="once">One time</option><option value="in">{t("agentSchedule.in")}</option><option value="daily">Daily</option><option value="weekdays">Selected weekdays</option></select></label>
        {kind === "in" ? <div className="mobile-schedule-in">
          <span>{t("agentSchedule.inDelay")} {isUntested("mobile.sheet.scheduleIn") && <span className="untested">{t("mobile.newTab.untested")}</span>}</span>
          <div><input type="number" inputMode="numeric" min={0} step={1} value={inHours} disabled={held} aria-label={t("agentSchedule.inHours")} onChange={(event) => setInHours(event.target.value)} /><span>{t("agentSchedule.inHoursUnit")}</span><input type="number" inputMode="numeric" min={0} step={1} value={inMinutes} disabled={held} aria-label={t("agentSchedule.inMinutes")} onChange={(event) => setInMinutes(event.target.value)} /><span>{t("agentSchedule.inMinutesUnit")}</span></div>
        </div> : kind === "once" ? <label>Desktop-local date and time<input type="datetime-local" value={once} disabled={held} onChange={(event) => setOnce(event.target.value)} /></label> : <label>Desktop-local time<input type="time" value={time} disabled={held} onChange={(event) => setTime(event.target.value)} /></label>}
        {kind === "weekdays" && <div className="mobile-schedule-weekdays">{MOBILE_WEEKDAYS.map((name, index) => <label key={name}><input type="checkbox" disabled={held} checked={weekdays.includes(index + 1)} onChange={() => setWeekdays((current) => current.includes(index + 1) ? current.filter((day) => day !== index + 1) : [...current, index + 1])} />{name}</label>)}</div>}
        <div className="mobile-schedule-actions">{editing && <button disabled={busy} onClick={reset}>Cancel</button>}<button className="primary" disabled={busy || held} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</button></div>
      </div>
    </section>
  </div>;
}
