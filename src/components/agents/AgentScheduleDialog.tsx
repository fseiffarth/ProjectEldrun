import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  agentModelsFor,
  buildPreface,
  prefaceCommandsFor,
  splitPreface,
} from "../../lib/agentPrefaces";
import { isFinishedOneTime } from "../../lib/agentPromptSend";
import {
  desktopTimeZone,
  normalizedSchedulePreface,
  nextScheduleOccurrence,
  normalizedScheduleMessage,
  relativeToNow,
  scheduleStatus,
  scheduleSummary,
  sortSchedules,
  validateScheduleRule,
  type ScheduleRule,
  type ScheduleStatusKind,
  type ScheduledAgentPrompt,
} from "../../lib/agentSchedule";
import { formatTime, todayStr } from "../../lib/calendarTime";
import { useI18nStore, useT } from "../../lib/i18n";
import { useUse24h } from "../../lib/timeFormat";
import { scheduleCacheKey, useAgentSchedulesStore } from "../../stores/agentSchedules";
import { useSettingsStore } from "../../stores/settings";
import { isResumableAgentTab, type TabEntry } from "../../stores/tabs";
import { DateTimeField } from "../common/DateTimeField";
import { Dropdown } from "../common/Dropdown";
import { TimeField } from "../common/TimeField";
import { UntestedTag } from "../common/UntestedTag";

interface Props {
  scope: string;
  tab: TabEntry;
  onClose: () => void;
  /** Prefill for the add form — a collected prompt being turned into a rule. */
  initialMessage?: string;
}

// Zustand selectors are React external-store snapshots: their fallback must be
// referentially stable. A literal `[]` here makes a not-yet-loaded target look
// changed on every read, so opening the dialog loops until React tears down the
// whole app with "Maximum update depth exceeded".
const EMPTY_SCHEDULES: ScheduledAgentPrompt[] = [];

// The countdowns are the point of the status column, so they have to move on
// their own. A minute is the resolution `relativeToNow` prints at; the
// scheduler's own tick (15 s, `AgentScheduleHost`) is unrelated and stays there.
const CLOCK_MS = 30_000;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function defaultOnce(): string {
  const date = new Date(Date.now() + 60 * 60 * 1000);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function AgentScheduleDialog({ scope, tab, onClose, initialMessage }: Props) {
  const t = useT();
  const lang = useI18nStore((state) => state.lang);
  const use24h = useUse24h();
  const targetId = tab.scheduleTargetId;
  const cacheKey = targetId ? scheduleCacheKey(scope, targetId) : "";
  const stored = useAgentSchedulesStore((state) => state.byTarget[cacheKey] ?? EMPTY_SCHEDULES);
  // A one-time rule that has run is a receipt, not a plan: it lives on in the
  // side panel's Sent prompts, with the tab, agent, session and both times the
  // delivery had. `AgentScheduleHost` retires them; this filter is what keeps
  // one that is still on its way out of a menu about the future.
  const schedules = useMemo(
    () => stored.filter((schedule) => !isFinishedOneTime(schedule)),
    [stored],
  );
  const loading = useAgentSchedulesStore((state) => !!state.loading[cacheKey]);
  const load = useAgentSchedulesStore((state) => state.load);
  const upsert = useAgentSchedulesStore((state) => state.upsert);
  const remove = useAgentSchedulesStore((state) => state.remove);
  const [editing, setEditing] = useState<string | null>(null);
  const [message, setMessage] = useState(initialMessage ?? "");
  const [kind, setKind] = useState<ScheduleRule["type"]>("daily");
  const [time, setTime] = useState("09:00");
  const [once, setOnce] = useState(defaultOnce);
  const [weekdays, setWeekdays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  // The prefix commands and model this rule types AHEAD of its prompt — the
  // side panel composer's chips and model pick, on the schedule form, because a
  // prompt that needs `/clear` and a model at 9:00 needs them every 9:00. They
  // are the agent's own slash commands, submitted one at a time before the
  // message; Eldrun still chooses nothing (see `lib/agentPrefaces`).
  const [selected, setSelected] = useState<string[]>([]);
  const [model, setModel] = useState("");
  // Commands a saved rule carries that this agent no longer offers. Kept as
  // chips of their own so editing a schedule cannot silently drop one.
  const [extraCommands, setExtraCommands] = useState<string[]>([]);
  const [now, setNow] = useState(() => new Date());
  const settings = useSettingsStore((state) => state.settings);
  const baseOffered = useMemo(
    () => prefaceCommandsFor(tab.cmd, settings?.agent_preface_commands),
    [settings?.agent_preface_commands, tab.cmd],
  );
  const offered = useMemo(
    () => [...baseOffered, ...extraCommands.filter((command) => !baseOffered.includes(command))],
    [baseOffered, extraCommands],
  );
  const models = useMemo(
    () => agentModelsFor(tab.cmd, settings?.agent_models),
    [settings?.agent_models, tab.cmd],
  );
  const preface = useMemo(
    () => buildPreface(offered, selected, model),
    [offered, selected, model],
  );
  const weekdayNames = useMemo(() => [
    t("agentSchedule.mon"), t("agentSchedule.tue"), t("agentSchedule.wed"),
    t("agentSchedule.thu"), t("agentSchedule.fri"), t("agentSchedule.sat"),
    t("agentSchedule.sun"),
  ], [t]);

  useEffect(() => {
    if (targetId) void load(scope, targetId).catch((cause) => setError(String(cause)));
  }, [load, scope, targetId]);

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), CLOCK_MS);
    return () => clearInterval(timer);
  }, []);

  /** A stored instant as this app prints clocks — never `toLocaleString`, whose
   *  12-vs-24-hour face comes from the engine rather than from the setting. */
  const whenLabel = (at: Date): string => {
    const day = at.toLocaleDateString(lang, { weekday: "short", day: "numeric", month: "short" });
    return `${day} · ${formatTime(`${pad(at.getHours())}:${pad(at.getMinutes())}`, use24h)}`;
  };

  const ruleText = (rule: ScheduleRule): string => {
    if (rule.type === "once") {
      const at = new Date(rule.at);
      return Number.isNaN(at.getTime()) ? rule.at : `${t("agentSchedule.once")} · ${whenLabel(at)}`;
    }
    if (rule.type === "daily") return `${t("agentSchedule.daily")} · ${formatTime(rule.time, use24h)}`;
    return `${rule.weekdays.map((day) => weekdayNames[day - 1]).join(", ")} · ${formatTime(rule.time, use24h)}`;
  };

  const reset = () => {
    setEditing(null);
    setMessage("");
    setKind("daily");
    setTime("09:00");
    setOnce(defaultOnce());
    setWeekdays([1, 2, 3, 4, 5]);
    setSelected([]);
    setModel("");
    setExtraCommands([]);
    setError("");
  };

  const beginEdit = (schedule: ScheduledAgentPrompt) => {
    setEditing(schedule.id);
    setMessage(schedule.message);
    setKind(schedule.rule.type);
    if (schedule.rule.type === "once") setOnce(schedule.rule.at);
    else setTime(schedule.rule.time);
    if (schedule.rule.type === "weekdays") setWeekdays(schedule.rule.weekdays);
    const parsed = splitPreface(schedule.preface);
    setSelected(parsed.commands);
    setExtraCommands(parsed.commands.filter((command) => !baseOffered.includes(command)));
    setModel(parsed.model);
    setError("");
  };

  const save = async () => {
    if (!targetId) return;
    const rule: ScheduleRule = kind === "once"
      ? { type: "once", at: once }
      : kind === "daily"
        ? { type: "daily", time }
        : { type: "weekdays", weekdays: [...weekdays].sort(), time };
    const ruleError = validateScheduleRule(rule);
    if (ruleError) {
      setError(t("agentSchedule.invalidRule"));
      return;
    }
    let clean: string;
    try {
      clean = normalizedScheduleMessage(message);
    } catch (cause) {
      setError(String(cause).includes("too_long")
        ? t("agentSchedule.messageTooLong")
        : t("agentSchedule.messageRequired"));
      return;
    }
    setSaving(true);
    setError("");
    try {
      const prior = schedules.find((item) => item.id === editing);
      const commands = normalizedSchedulePreface(preface);
      await upsert(scope, targetId, {
        id: editing ?? crypto.randomUUID(),
        enabled: prior?.enabled ?? true,
        message: clean,
        // Omitted rather than `[]` when nothing is picked, so a rule without
        // prefix commands serializes exactly as it did before the form had them.
        ...(commands ? { preface: commands } : {}),
        rule,
        last: prior?.last,
      });
      reset();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setSaving(false);
    }
  };

  // The one-time form's own warning: a rule in the past validates (it is a real
  // instant) and then simply never fires, which from the list alone reads as a
  // schedule that silently did nothing.
  const oncePast = kind === "once"
    && !!once
    && !Number.isNaN(new Date(once).getTime())
    && new Date(once).getTime() < now.getTime();

  const summary = scheduleSummary(schedules, now);

  if (!targetId) return null;
  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="settings-dialog agent-schedule-dialog"
        style={{ color: "var(--text-primary)" }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="settings-title-row">
          <h2>{t("agentSchedule.title", { tab: tab.label })} <UntestedTag /></h2>
          <button type="button" className="dialog-close-btn" onClick={onClose}>×</button>
        </div>
        <div className="dialog-scroll agent-schedule-scroll">
          {/* The status board: what this tab is going to do, before any of the
              rules that say so. A tab with nothing enabled is the case the old
              list could not state at all. */}
          <div className="agent-schedule-summary">
            <div className="agent-schedule-summary-counts">
              <strong>{summary.enabled}</strong>
              <span>{t("agentSchedule.summaryEnabled", { total: String(summary.total) })}</span>
            </div>
            <div className="agent-schedule-summary-next">
              {summary.next
                ? <>
                    <span className="agent-schedule-summary-when">{whenLabel(summary.next)}</span>
                    <small>{relativeToNow(summary.next, now, lang)}</small>
                  </>
                : <span className="agent-schedule-summary-when muted">{t("agentSchedule.noNext")}</span>}
            </div>
            <small className="agent-schedule-summary-zone">
              {t("agentSchedule.timeZone", { zone: desktopTimeZone() })}
            </small>
          </div>

          <div className="agent-schedule-notice">
            <p>{t("agentSchedule.warning")}</p>
            <p>{t("agentSchedule.openOnly")}</p>
            {!isResumableAgentTab(tab) && <p className="danger-text">{t("agentSchedule.nonResumable")}</p>}
          </div>

          <section className="agent-schedule-list">
            <h3>{t("agentSchedule.saved")}</h3>
            {loading && schedules.length === 0 ? <p>{t("common.loading")}</p> : null}
            {!loading && schedules.length === 0 ? <p className="settings-help">{t("agentSchedule.none")}</p> : null}
            {sortSchedules(schedules, now).map((schedule) => {
              const status = scheduleStatus(schedule, now);
              const next = nextScheduleOccurrence(schedule, now);
              return (
                <div className={`agent-schedule-row is-${status.kind}`} key={schedule.id}>
                  <div className="agent-schedule-row-main">
                    <div className="agent-schedule-row-head">
                      <span className={`agent-schedule-pill is-${status.kind}`}>
                        {t(`agentSchedule.status.${status.kind}` as `agentSchedule.status.${ScheduleStatusKind}`)}
                      </span>
                      <strong>{ruleText(schedule.rule)}</strong>
                    </div>
                    <span>{schedule.message}</span>
                    {schedule.preface && schedule.preface.length > 0 && (
                      <small className="agent-composer-preview">
                        {t("agentPrompts.prefixPreview", { commands: schedule.preface.join(" · ") })}
                      </small>
                    )}
                    <small className="agent-schedule-row-when">
                      {next
                        ? t("agentSchedule.nextAt", {
                            value: whenLabel(next.at),
                            relative: relativeToNow(next.at, now, lang),
                          })
                        : t("agentSchedule.noNext")}
                      {status.kind === "due" ? ` · ${t("agentSchedule.dueHint")}` : ""}
                      {schedule.last
                        ? ` · ${t("agentSchedule.last", {
                            result: t(`agentSchedule.result.${schedule.last.result}`),
                            value: whenLabel(new Date(schedule.last.at)),
                          })}`
                        : ""}
                    </small>
                  </div>
                  <div className="agent-schedule-row-actions">
                    <label>
                      <input
                        type="checkbox"
                        checked={schedule.enabled}
                        onChange={() => void upsert(scope, targetId, { ...schedule, enabled: !schedule.enabled }).catch((cause) => setError(String(cause)))}
                      />
                      {t("agentSchedule.enabled")}
                    </label>
                    <button className="settings-btn sm" type="button" onClick={() => beginEdit(schedule)}>{t("common.edit")}</button>
                    <button className="settings-btn sm danger" type="button" onClick={() => void remove(scope, targetId, schedule.id).catch((cause) => setError(String(cause)))}>{t("common.delete")}</button>
                  </div>
                </div>
              );
            })}
          </section>

          <section className="agent-schedule-form">
            <h3>{editing ? t("agentSchedule.edit") : t("agentSchedule.add")}</h3>
            <label>
              <span>{t("agentSchedule.message")}</span>
              <textarea value={message} onChange={(event) => setMessage(event.target.value)} rows={5} />
            </label>
            {/* Before the prompt: the agent's own slash commands, typed one at
                a time ahead of the message, exactly as the side panel composer
                sends them. The model goes last — a `/clear` before it would
                drop some CLIs back to their default. */}
            <div className="agent-schedule-field">
              <span>{t("agentPrompts.prefixHeading")}</span>
              {offered.length > 0 ? (
                <div className="agent-composer-chips" role="group" aria-label={t("agentPrompts.prefixHeading")}>
                  {offered.map((command) => (
                    <button
                      key={command}
                      type="button"
                      className={`agent-composer-chip${selected.includes(command) ? " active" : ""}`}
                      aria-pressed={selected.includes(command)}
                      title={t("agentPrompts.prefixChipTitle", { command })}
                      onClick={() =>
                        setSelected((current) =>
                          current.includes(command)
                            ? current.filter((entry) => entry !== command)
                            : [...current, command],
                        )
                      }
                    >
                      {command}
                    </button>
                  ))}
                </div>
              ) : (
                <small className="settings-help">{t("agentPrompts.prefixNone")}</small>
              )}
            </div>
            {models.length > 0 && (
              <div className="agent-schedule-field">
                <span>{t("agentPrompts.model")}</span>
                <Dropdown
                  value={model}
                  placeholder={t("agentPrompts.modelUnchanged")}
                  title={t("agentPrompts.modelTitle")}
                  options={[
                    { value: "", label: t("agentPrompts.modelUnchanged") },
                    ...models.map((name) => ({ value: name, label: name })),
                  ]}
                  onChange={setModel}
                />
              </div>
            )}
            {preface.length > 0 && (
              <div className="agent-schedule-field">
                <span />
                <small className="agent-composer-preview">
                  {t("agentPrompts.prefixPreview", { commands: preface.join(" · ") })}
                </small>
              </div>
            )}
            <label>
              <span>{t("agentSchedule.recurrence")}</span>
              <select value={kind} onChange={(event) => setKind(event.target.value as ScheduleRule["type"])}>
                <option value="once">{t("agentSchedule.once")}</option>
                <option value="daily">{t("agentSchedule.daily")}</option>
                <option value="weekdays">{t("agentSchedule.weekdays")}</option>
              </select>
            </label>
            {kind === "once" ? (
              // A <div>, not a <label>: a <button> is a labelable element, so
              // wrapping the picker in one would make a click on the word
              // "Local date and time" pop the calendar open.
              <div className="agent-schedule-field">
                <span>{t("agentSchedule.dateTime")}</span>
                {/* A day picked from a drawn calendar and an hour in the clock
                    the setting chose — `<input type="datetime-local">` could
                    offer neither, and its six engine-ordered segments were the
                    hardest thing in this dialog to aim at. */}
                <DateTimeField
                  value={once}
                  onChange={setOnce}
                  minDate={todayStr(now)}
                  aria-label={t("agentSchedule.dateTime")}
                />
              </div>
            ) : (
              <label>
                <span>{t("agentSchedule.time")}</span>
                <TimeField className="cal-input" value={time} onChange={setTime} aria-label={t("agentSchedule.time")} />
              </label>
            )}
            {kind === "weekdays" && (
              <div className="agent-schedule-weekdays">
                {weekdayNames.map((name, index) => {
                  const day = index + 1;
                  return <label key={day}><input type="checkbox" checked={weekdays.includes(day)} onChange={() => setWeekdays((current) => current.includes(day) ? current.filter((value) => value !== day) : [...current, day])} />{name}</label>;
                })}
              </div>
            )}
            {oncePast && <div className="agent-schedule-warn">{t("agentSchedule.pastOnce")}</div>}
            {error && <div className="project-dialog-error">{error}</div>}
            <div className="agent-schedule-form-actions">
              {editing && <button className="settings-btn" type="button" onClick={reset}>{t("common.cancel")}</button>}
              <button className="settings-btn primary" type="button" disabled={saving} onClick={() => void save()}>{saving ? t("common.saving") : t("common.save")}</button>
            </div>
          </section>
        </div>
      </div>
    </div>,
    document.body,
  );
}
