import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  localWallClock,
  relativeToNow,
  scheduleSummary,
  type ScheduledAgentPrompt,
} from "../../lib/agentSchedule";
import { formatTime } from "../../lib/calendarTime";
import { useUse24h } from "../../lib/timeFormat";
import {
  agentModelsFor,
  buildPreface,
  prefaceCommandsFor,
} from "../../lib/agentPrefaces";
import { useI18nStore, useT } from "../../lib/i18n";
import { useActivityStore } from "../../stores/activity";
import {
  queuePromptForTab,
  sendCollectedPrompt,
  useAgentPromptsStore,
  type ProjectAgentPrompt,
  type SentAgentPrompt,
} from "../../stores/agentPrompts";
import { scheduleCacheKey, useAgentSchedulesStore } from "../../stores/agentSchedules";
import { useSettingsStore } from "../../stores/settings";
import { isResumableAgentTab, useTabsStore, type TabEntry } from "../../stores/tabs";
import { Dropdown } from "../common/Dropdown";
import { UntestedTag } from "../common/UntestedTag";
import { AgentScheduleDialog } from "./AgentScheduleDialog";

interface Props {
  /** The scope whose agent tabs and prompts are shown: a project id, a box scope, or root. */
  scope: string;
  /** Laid out on screen; the countdown clock only runs while true. */
  active: boolean;
}

const EMPTY_TABS: TabEntry[] = [];
const EMPTY_PROMPTS: ProjectAgentPrompt[] = [];
const EMPTY_HISTORY: SentAgentPrompt[] = [];
const EMPTY_SCHEDULES: ScheduledAgentPrompt[] = [];
const CLOCK_MS = 30_000;
/** How long the copy button acknowledges a copied session id before reverting. */
const COPIED_MS = 1200;

type AgentState = "working" | "decision" | "idle";

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** The occurrence a history entry was due at, if it came from a schedule. */
function scheduledAt(entry: SentAgentPrompt): Date | null {
  return entry.scheduled_for ? localWallClock(entry.scheduled_for) : null;
}

function isAgentTab(tab: TabEntry): boolean {
  return (tab.kind === "agent" || tab.kind === "local_agent") && !!tab.scheduleTargetId;
}

function stateClass(state: AgentState): string {
  return state === "working" ? "due" : state === "decision" ? "failed" : "delivered";
}

/**
 * The per-tab prompt composer: prefix chips, the agent's own model pick, and the
 * message — aimed at ONE tab, the one it is rendered under, so nothing has to be
 * targeted first.
 *
 * The chips and the model are not a second way to launch an agent: they are
 * submitted as that CLI's own slash commands ahead of the prompt (see
 * `lib/agentPrefaces`), which is what keeps the agent's authority the agent's.
 * Delivery is the ordinary send-now queue, so this inherits the scheduler's
 * idle/decision gate rather than writing into the PTY behind it.
 */
function AgentTabComposer({
  scope,
  tab,
  offered,
  models,
  onNotice,
  onError,
}: {
  scope: string;
  tab: TabEntry;
  offered: string[];
  models: string[];
  onNotice: (text: string) => void;
  onError: (text: string) => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);

  const preface = useMemo(
    () => buildPreface(offered, selected, model),
    [offered, selected, model],
  );

  const toggle = (command: string) => {
    setSelected((current) =>
      current.includes(command)
        ? current.filter((entry) => entry !== command)
        : [...current, command],
    );
  };

  const submit = async () => {
    const message = draft.trim();
    if (!message || !tab.scheduleTargetId) return;
    setBusy(true);
    onError("");
    onNotice("");
    try {
      const { pruned } = await queuePromptForTab(scope, tab.scheduleTargetId, message, { preface });
      onNotice(
        t("agentPrompts.queued", { tab: tab.label })
          + (pruned > 0 ? ` ${t("agentPrompts.pruned", { count: pruned })}` : ""),
      );
      setDraft("");
    } catch (cause) {
      onError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="agent-composer" data-testid="agent-composer">
      {offered.length > 0 ? (
        <div className="agent-composer-chips" role="group" aria-label={t("agentPrompts.prefixHeading")}>
          <span className="agent-composer-chips-label">{t("agentPrompts.prefixHeading")}</span>
          {offered.map((command) => (
            <button
              key={command}
              type="button"
              className={`agent-composer-chip${selected.includes(command) ? " active" : ""}`}
              aria-pressed={selected.includes(command)}
              title={t("agentPrompts.prefixChipTitle", { command })}
              onClick={() => toggle(command)}
            >
              {command}
            </button>
          ))}
        </div>
      ) : (
        <p className="settings-help">{t("agentPrompts.prefixNone")}</p>
      )}

      {models.length > 0 && (
        <label className="agent-composer-model">
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
        </label>
      )}

      <textarea
        rows={3}
        value={draft}
        placeholder={t("agentPrompts.composerPlaceholder", { tab: tab.label })}
        aria-label={t("agentPrompts.composerPlaceholder", { tab: tab.label })}
        onChange={(event) => setDraft(event.target.value)}
      />

      {preface.length > 0 && (
        <small className="agent-composer-preview">
          {t("agentPrompts.prefixPreview", { commands: preface.join(" · ") })}
        </small>
      )}

      <div className="agent-schedule-form-actions">
        <button
          className="settings-btn sm primary"
          type="button"
          disabled={busy || !draft.trim()}
          onClick={() => void submit()}
        >
          {t("agentPrompts.composerSend")}
        </button>
      </div>
    </div>
  );
}

/**
 * The Agents view of the file viewer's Files / Git / Apps / Agents row: every
 * agent tab of this scope that can carry schedules, with what each is doing,
 * when it next fires and a composer aimed at it — plus the scope's collected
 * prompts (text kept without a tab) and the record of the ones already sent.
 * Delivery itself stays with `AgentScheduleHost`; this view only writes
 * definitions.
 */
export function AgentSchedulesView({ scope, active }: Props) {
  const t = useT();
  const lang = useI18nStore((state) => state.lang);
  const use24h = useUse24h();
  const tabs = useTabsStore((state) => state.tabsByScope[scope] ?? EMPTY_TABS);
  const agentTabs = useMemo(() => tabs.filter(isAgentTab), [tabs]);
  const schedulesByTarget = useAgentSchedulesStore((state) => state.byTarget);
  const loadSchedules = useAgentSchedulesStore((state) => state.load);
  const busyByTab = useActivityStore((state) => state.busyByTab);
  const attentionByTab = useActivityStore((state) => state.attentionByTab);
  const prompts = useAgentPromptsStore((state) => state.byProject[scope] ?? EMPTY_PROMPTS);
  const history = useAgentPromptsStore((state) => state.historyByProject[scope] ?? EMPTY_HISTORY);
  const loadPrompts = useAgentPromptsStore((state) => state.load);
  const loadHistory = useAgentPromptsStore((state) => state.loadHistory);
  const upsertPrompt = useAgentPromptsStore((state) => state.upsert);
  const removePrompt = useAgentPromptsStore((state) => state.remove);
  const clearHistory = useAgentPromptsStore((state) => state.clearHistory);
  const settings = useSettingsStore((state) => state.settings);
  // Scoped, because this view's tabs are THIS scope's and the tab bar's active
  // scope need not be the same one.
  const renameTabInScope = useTabsStore((state) => state.renameTabInScope);

  const [now, setNow] = useState(() => new Date());
  const [dialog, setDialog] = useState<{ tabKey: string; message?: string } | null>(null);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  // Which agent tabs have their composer open. Open is the default (the field is
  // the point of the section), so this holds the tabs the user FOLDED — a set of
  // exceptions, the rule `stores/todo`'s collapsed checklists follow, so a tab
  // that appears later opens rather than inheriting somebody else's fold.
  const [folded, setFolded] = useState<string[]>([]);
  // The target picker a collected prompt's action opens. There is deliberately
  // no view-wide "target tab" any more: which agent a prompt is for is a
  // property of that send, asked at the moment it is made, not a mode the whole
  // list sits in and silently inherits.
  const [picking, setPicking] = useState<{ promptId: string; mode: "send" | "schedule" } | null>(null);
  // The session id whose copy button is currently showing its acknowledgement.
  const [copiedSession, setCopiedSession] = useState<string | null>(null);
  // The agent tab whose name is currently an input. Renaming lives here as well
  // as on the tab itself because this is the view where several agents are told
  // apart from one another — and the tab bar's own rename is behind a
  // right-click on a tab that may not even be in the visible group.
  const [renaming, setRenaming] = useState<string | null>(null);

  useEffect(() => {
    void loadPrompts(scope).catch((cause) => setError(String(cause)));
    void loadHistory(scope).catch(() => []);
    let disposed = false;
    let stop: (() => void) | undefined;
    void listen("agent-prompts-changed", () => {
      void loadPrompts(scope).catch(() => []);
      void loadHistory(scope).catch(() => []);
    }).then((unlisten) => {
      if (disposed) unlisten();
      else stop = unlisten;
    });
    return () => {
      disposed = true;
      stop?.();
    };
  }, [loadHistory, loadPrompts, scope]);

  // Counts and next runs need every target loaded, not only the ones a dialog
  // has opened; a load is one local read per tab.
  useEffect(() => {
    for (const tab of agentTabs) {
      if (tab.scheduleTargetId && !schedulesByTarget[scheduleCacheKey(scope, tab.scheduleTargetId)]) {
        void loadSchedules(scope, tab.scheduleTargetId).catch(() => []);
      }
    }
  }, [agentTabs, loadSchedules, schedulesByTarget, scope]);

  // A tab closed (or moved to another scope) while being renamed takes the
  // input with it — otherwise the field lingers over nothing.
  useEffect(() => {
    if (renaming && !agentTabs.some((tab) => tab.key === renaming)) setRenaming(null);
  }, [agentTabs, renaming]);

  useEffect(() => {
    if (!active) return;
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), CLOCK_MS);
    return () => clearInterval(timer);
  }, [active]);

  useEffect(() => {
    if (!copiedSession) return;
    const timer = setTimeout(() => setCopiedSession(null), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copiedSession]);

  const stateOf = (tab: TabEntry): AgentState => {
    const ptyId = `${scope}:${tab.key}`;
    if (attentionByTab[ptyId] === "decision") return "decision";
    return busyByTab[ptyId] ? "working" : "idle";
  };

  const resetForm = () => {
    setDraft("");
    setEditing(null);
    setError("");
  };

  const savePrompt = async () => {
    const message = draft.trim();
    if (!message) {
      setError(t("agentSchedule.messageRequired"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      await upsertPrompt(scope, { id: editing ?? crypto.randomUUID(), message });
      resetForm();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  /** Send a collected prompt at the tab just chosen in that row's picker. */
  const send = async (prompt: ProjectAgentPrompt, tab: TabEntry) => {
    if (!tab.scheduleTargetId) return;
    setBusy(true);
    setError("");
    setNotice("");
    setPicking(null);
    try {
      const { pruned } = await sendCollectedPrompt(
        scope,
        {
          scheduleTargetId: tab.scheduleTargetId,
          label: tab.label,
          sessionId: tab.sessionId,
          agent: tab.cmd,
        },
        prompt,
      );
      setNotice(
        t("agentPrompts.queued", { tab: tab.label })
          + (pruned > 0 ? ` ${t("agentPrompts.pruned", { count: pruned })}` : ""),
      );
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  /** Copy a session id whole, with a moment of acknowledgement in the button —
   *  the clipboard gives no feedback of its own. */
  const copySession = (id: string) => {
    navigator.clipboard?.writeText(id).catch(() => {});
    setCopiedSession(id);
  };

  /** Put a sent prompt back on the active list — it stays in the history. */
  const collectAgain = async (entry: SentAgentPrompt) => {
    setError("");
    try {
      await upsertPrompt(scope, { id: crypto.randomUUID(), message: entry.message });
    } catch (cause) {
      setError(String(cause));
    }
  };

  // `renameTabInScope` trims and ignores an empty name, so clearing the field
  // and pressing Enter leaves the tab named what it was.
  const commitRename = (key: string, value: string) => {
    renameTabInScope(scope, key, value);
    setRenaming(null);
  };

  const dialogTab = dialog ? agentTabs.find((tab) => tab.key === dialog.tabKey) : undefined;
  const newestFirst = useMemo(() => [...history].reverse(), [history]);

  /** A stored wall-clock instant printed the way the rest of the app prints
   *  clocks — the setting's 12/24-hour face, never the engine's. */
  const whenLabel = (at: Date): string => {
    const day = at.toLocaleDateString(lang, { weekday: "short", day: "numeric", month: "short" });
    return `${day} · ${formatTime(`${pad(at.getHours())}:${pad(at.getMinutes())}`, use24h)}`;
  };

  const targetPicker = (prompt: ProjectAgentPrompt) => (
    <div className="agent-prompts-picker" role="group" aria-label={t("agentPrompts.chooseTarget")}>
      <span className="agent-prompts-picker-label">{t("agentPrompts.chooseTarget")}</span>
      {agentTabs.map((tab) => (
        <button
          key={tab.key}
          className="settings-btn sm"
          type="button"
          disabled={busy}
          onClick={() => {
            if (picking?.mode === "schedule") {
              setPicking(null);
              setDialog({ tabKey: tab.key, message: prompt.message });
            } else {
              void send(prompt, tab);
            }
          }}
        >
          <span className={`agent-schedule-pill is-${stateClass(stateOf(tab))}`} aria-hidden="true" />
          {tab.label}
        </button>
      ))}
      <button className="settings-btn sm" type="button" onClick={() => setPicking(null)}>
        {t("common.cancel")}
      </button>
    </div>
  );

  return (
    <div className="side-panel-scroll agent-prompts-view" style={{ flex: 1, overflowY: "auto", padding: 6 }}>
      <section className="agent-prompts-section">
        <h3 className="settings-section-title">
          {t("agentPrompts.tabsHeading")}
          <UntestedTag />
        </h3>
        {agentTabs.length === 0 ? (
          <div className="file-tree-empty">{t("agentPrompts.noTabs")}</div>
        ) : (
          agentTabs.map((tab) => {
            const key = tab.scheduleTargetId ? scheduleCacheKey(scope, tab.scheduleTargetId) : "";
            const schedules = schedulesByTarget[key] ?? EMPTY_SCHEDULES;
            const summary = scheduleSummary(schedules, now);
            const state = stateOf(tab);
            const open = !folded.includes(tab.key);
            const offered = prefaceCommandsFor(tab.cmd, settings?.agent_preface_commands);
            const models = agentModelsFor(tab.cmd, settings?.agent_models);
            return (
              <div className="agent-prompts-tab" key={tab.key} data-testid="agent-prompts-tab">
                <div className="agent-prompts-tab-main">
                  {/* The tab's NAME leads. What it is doing is a state of that
                      agent, so it reads after the thing it is a state of —
                      a row of status pills down the left told you six times
                      what was happening before once telling you to whom. */}
                  <div className="agent-prompts-tab-head">
                    {renaming === tab.key ? (
                      <input
                        className="agent-prompts-rename"
                        defaultValue={tab.label}
                        autoFocus
                        aria-label={t("tabBar.renameAriaLabel")}
                        // Mount focused with the whole name selected, the same
                        // fast-retype the tab bar's inline rename gives.
                        ref={(el) => { if (el) el.select(); }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") commitRename(tab.key, event.currentTarget.value);
                          else if (event.key === "Escape") setRenaming(null);
                        }}
                        onBlur={(event) => commitRename(tab.key, event.target.value)}
                      />
                    ) : (
                      <>
                        <strong>{tab.label}</strong>
                        <button
                          className="agent-composer-chip agent-prompts-rename-btn"
                          type="button"
                          title={t("common.rename")}
                          aria-label={t("tabBar.renameAriaLabel")}
                          onClick={() => setRenaming(tab.key)}
                        >
                          {"\u270e"}
                        </button>
                      </>
                    )}
                    <span className={`agent-schedule-pill is-${stateClass(state)}`}>
                      {t(`agentPrompts.state.${state}`)}
                    </span>
                    <small>{tab.cmd}</small>
                    {!isResumableAgentTab(tab) && (
                      <small className="danger-text" title={t("agentSchedule.nonResumable")}>
                        {t("agentPrompts.nonResumable")}
                      </small>
                    )}
                  </div>
                  <small className="agent-prompts-tab-when">
                    {summary.total === 0
                      ? t("agentPrompts.noSchedules")
                      : summary.next
                        ? `${summary.enabled} · ${t("agentPrompts.nextRun", { relative: relativeToNow(summary.next, now, lang) })}`
                        : `${summary.enabled} · ${t("agentSchedule.noNext")}`}
                  </small>
                  {open && (
                    <AgentTabComposer
                      scope={scope}
                      tab={tab}
                      offered={offered}
                      models={models}
                      onNotice={setNotice}
                      onError={setError}
                    />
                  )}
                </div>
                <div className="agent-prompts-tab-actions">
                  <button
                    className={`agent-composer-chip${open ? " active" : ""}`}
                    type="button"
                    aria-pressed={open}
                    title={t("agentPrompts.composerToggleTitle")}
                    onClick={() =>
                      setFolded((current) =>
                        current.includes(tab.key)
                          ? current.filter((entry) => entry !== tab.key)
                          : [...current, tab.key],
                      )
                    }
                  >
                    {t("agentPrompts.composerToggle")}
                  </button>
                  <button
                    className="settings-btn sm"
                    type="button"
                    onClick={() => setDialog({ tabKey: tab.key })}
                    title={t("agentSchedule.menu")}
                  >
                    ◷ {t("agentPrompts.schedulesButton")}
                  </button>
                </div>
              </div>
            );
          })
        )}
      </section>

      <section className="agent-prompts-section">
        <h3 className="settings-section-title">{t("agentPrompts.heading")}</h3>
        <p className="settings-help">{t("agentPrompts.intro")}</p>
        {agentTabs.length === 0 && <p className="settings-help">{t("agentPrompts.sendNeedsTab")}</p>}
        {notice && <div className="agent-prompts-notice">{notice}</div>}
        {error && <div className="project-dialog-error">{error}</div>}
        {prompts.length === 0 && <div className="file-tree-empty">{t("agentPrompts.none")}</div>}
        {prompts.map((prompt) => (
          <div className="agent-prompts-row" key={prompt.id} data-testid="agent-prompts-row">
            <div className="agent-prompts-row-main">
              <span className="agent-prompts-message">{prompt.message}</span>
              <small>{t("agentPrompts.updated", { relative: relativeToNow(new Date(prompt.updated_at), now, lang) })}</small>
              {picking?.promptId === prompt.id && targetPicker(prompt)}
            </div>
            <div className="agent-prompts-row-actions">
              <button
                className="settings-btn sm primary"
                type="button"
                disabled={busy || agentTabs.length === 0}
                onClick={() => setPicking({ promptId: prompt.id, mode: "send" })}
              >
                {t("agentPrompts.send")}
              </button>
              <button
                className="settings-btn sm"
                type="button"
                disabled={agentTabs.length === 0}
                onClick={() => setPicking({ promptId: prompt.id, mode: "schedule" })}
              >
                {t("agentPrompts.schedule")}
              </button>
              <button
                className="settings-btn sm"
                type="button"
                onClick={() => { setEditing(prompt.id); setDraft(prompt.message); setError(""); }}
              >
                {t("common.edit")}
              </button>
              <button
                className="settings-btn sm danger"
                type="button"
                disabled={busy}
                onClick={() => void removePrompt(scope, prompt.id).catch((cause) => setError(String(cause)))}
              >
                {t("common.delete")}
              </button>
            </div>
          </div>
        ))}
        <div className="agent-prompts-form">
          <textarea
            rows={4}
            value={draft}
            placeholder={t("agentPrompts.placeholder")}
            aria-label={t("agentSchedule.message")}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="agent-schedule-form-actions">
            {editing && <button className="settings-btn" type="button" onClick={resetForm}>{t("common.cancel")}</button>}
            <button className="settings-btn primary" type="button" disabled={busy} onClick={() => void savePrompt()}>
              {editing ? t("agentPrompts.update") : t("agentPrompts.add")}
            </button>
          </div>
        </div>
      </section>

      <section className="agent-prompts-section">
        <h3 className="settings-section-title">
          {t("agentPrompts.historyHeading")}
          {history.length > 0 && (
            <button
              className="settings-btn sm danger"
              type="button"
              onClick={() => void clearHistory(scope).catch((cause) => setError(String(cause)))}
            >
              {t("agentPrompts.historyClear")}
            </button>
          )}
        </h3>
        <p className="settings-help">{t("agentPrompts.historyIntro")}</p>
        {newestFirst.length === 0 ? (
          <div className="file-tree-empty">{t("agentPrompts.historyNone")}</div>
        ) : (
          newestFirst.map((entry) => (
            <div className="agent-prompts-row" key={`${entry.id}-${entry.sent_at}`} data-testid="agent-prompts-sent">
              <div className="agent-prompts-row-main">
                {/* What happened to it leads: a prompt still waiting for a safe
                    idle point, one that reached the agent, and one that never
                    did all read as "sent" without this word. */}
                <div className="agent-prompts-sent-head">
                  <span className={`agent-schedule-pill is-${entry.result ?? "queued"}`}>
                    {entry.result
                      ? t(`agentSchedule.status.${entry.result}` as "agentSchedule.status.delivered")
                      : t("agentPrompts.historyQueued")}
                  </span>
                  {entry.agent && <small>{entry.agent}</small>}
                </div>
                <span className="agent-prompts-message">{entry.message}</span>
                <small>
                  {t("agentPrompts.historySentTo", {
                    relative: relativeToNow(new Date(entry.sent_at), now, lang),
                    tab: entry.tab_label,
                  })}
                </small>
                {scheduledAt(entry) && (
                  <small>
                    {t("agentPrompts.historyScheduledFor", { value: whenLabel(scheduledAt(entry)!) })}
                  </small>
                )}
                <small>
                  {t("agentPrompts.historyCollected", {
                    relative: relativeToNow(new Date(entry.created_at), now, lang),
                  })}
                </small>
                {/* The whole session id, not a prefix of it: it is the one
                    thing here that gets typed somewhere else (`--resume`, a
                    log grep), so it is shown in full and copied in one click. */}
                <small className="agent-prompts-session">
                  {entry.session_id ? (
                    <>
                      <span className="agent-prompts-session-id" title={entry.session_id}>
                        {t("agentPrompts.historySession", { id: entry.session_id })}
                      </span>
                      <button
                        className="agent-composer-chip agent-prompts-copy"
                        type="button"
                        title={t("agentPrompts.historySessionCopy")}
                        aria-label={t("agentPrompts.historySessionCopy")}
                        onClick={() => copySession(entry.session_id!)}
                      >
                        {copiedSession === entry.session_id ? "\u2713" : "\u29c9"}
                      </button>
                    </>
                  ) : (
                    t("agentPrompts.historyNoSession")
                  )}
                </small>
                {entry.preface && entry.preface.length > 0 && (
                  <small className="agent-composer-preview">
                    {t("agentPrompts.prefixPreview", { commands: entry.preface.join(" · ") })}
                  </small>
                )}
              </div>
              <div className="agent-prompts-row-actions">
                <button
                  className="settings-btn sm"
                  type="button"
                  onClick={() => void collectAgain(entry)}
                >
                  {t("agentPrompts.historyCollectAgain")}
                </button>
                <button
                  className="settings-btn sm danger"
                  type="button"
                  title={t("common.delete")}
                  onClick={() => void clearHistory(scope, entry.id).catch((cause) => setError(String(cause)))}
                >
                  ✕
                </button>
              </div>
            </div>
          ))
        )}
      </section>

      {dialog && dialogTab && (
        <AgentScheduleDialog
          scope={scope}
          tab={dialogTab}
          initialMessage={dialog.message}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
