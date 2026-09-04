import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  localWallClock,
  relativeToNow,
  scheduleStatus,
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
import {
  EMPTY_SENT_FILTER,
  SENT_RESULTS,
  SENT_WINDOWS,
  filterSentPrompts,
  isSentFilterActive,
  sentAgents,
  sentTags,
  type SentPromptFilter,
} from "../../lib/agentPromptFilter";
import { scheduledPromptMarks } from "../../lib/agentPromptScheduled";
import {
  EMPTY_LIBRARY_FILTER,
  filterCollectedPrompts,
  formatTags,
  isLibraryFilterActive,
  parseTags,
  tagCounts,
  type LibraryFilter,
} from "../../lib/agentPromptTags";
import { useI18nStore, useT } from "../../lib/i18n";
import { reorderedIds } from "../../lib/listReorder";
import { jumpToTab } from "../../lib/tabJump";
import { useListReorder } from "../../hooks/useListReorder";
import { useActivityStore } from "../../stores/activity";
import { continueKey, useAgentContinueStore } from "../../stores/agentContinue";
import {
  queuePromptForTab,
  sendCollectedPrompt,
  useAgentPromptsStore,
  type ProjectAgentPrompt,
  type SentAgentPrompt,
} from "../../stores/agentPrompts";
import { persistScheduleBinding, scheduleCacheKey, useAgentSchedulesStore } from "../../stores/agentSchedules";
import { useSettingsStore } from "../../stores/settings";
import { isResumableAgentTab, useTabsStore, type TabEntry } from "../../stores/tabs";
import { Dropdown } from "../common/Dropdown";
import { MarkdownPromptField } from "../common/MarkdownPromptField";
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

/** The tab-ring vocabulary, read here as words: the same three states a tab's
 *  border paints (working / needs a decision / finished-and-unread), plus the
 *  idle fourth a border has no mark for because it draws nothing. */
type AgentState = "working" | "decision" | "done" | "idle";

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

/** Agent state is painted in the tab ring's own colours (`--status-*`), not the
 *  schedule palette: the pill and the border around the tab it names are saying
 *  the same thing, so they must not say it in two different colours. */
function stateClass(state: AgentState): string {
  return `is-agent-${state}`;
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
}: {
  scope: string;
  tab: TabEntry;
  offered: string[];
  models: string[];
}) {
  const t = useT();
  const [draft, setDraft] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  // What the last send said, shown HERE rather than in the view-wide banner two
  // sections down: the receipt for a button belongs beside the button, and a
  // confirmation rendered below the collected prompts is one the sender never
  // sees. The queue itself is on the tab row above, so this is only the
  // acknowledgement of the click.
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

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
    setError("");
    setNotice("");
    try {
      const { pruned } = await queuePromptForTab(scope, tab.scheduleTargetId, message, { preface });
      setNotice(
        t("agentPrompts.queued", { tab: tab.label })
          + (pruned > 0 ? ` ${t("agentPrompts.pruned", { count: pruned })}` : ""),
      );
      setDraft("");
    } catch (cause) {
      setError(String(cause));
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

      <MarkdownPromptField
        rows={3}
        value={draft}
        placeholder={t("agentPrompts.composerPlaceholder", { tab: tab.label })}
        ariaLabel={t("agentPrompts.composerPlaceholder", { tab: tab.label })}
        onChange={setDraft}
        // Ctrl/⌘+Enter sends, because plain Enter has to stay a newline in a
        // prompt — the same split the schedule editor's textarea above uses.
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            if (!busy && draft.trim()) void submit();
          }
        }}
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
          title={t("agentPrompts.composerSendTitle")}
          onClick={() => void submit()}
        >
          {t("agentPrompts.composerSend")}
        </button>
      </div>

      {notice && <div className="agent-prompts-notice" data-testid="agent-composer-notice">{notice}</div>}
      {error && <div className="project-dialog-error">{error}</div>}
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
  const reorderPrompts = useAgentPromptsStore((state) => state.reorder);
  const clearHistory = useAgentPromptsStore((state) => state.clearHistory);
  const settings = useSettingsStore((state) => state.settings);
  // Scoped, because this view's tabs are THIS scope's and the tab bar's active
  // scope need not be the same one.
  const renameTabInScope = useTabsStore((state) => state.renameTabInScope);
  // Auto-continue: the persisted per-tab switch, and the live status the host
  // publishes for it (`components/layout/AgentContinueHost`).
  const setAutoContinue = useTabsStore((state) => state.setAutoContinueInScope);
  const continueByTarget = useAgentContinueStore((state) => state.byTarget);

  const [now, setNow] = useState(() => new Date());
  const [dialog, setDialog] = useState<{ tabKey: string; message?: string } | null>(null);
  const [draft, setDraft] = useState("");
  // The prompt whose row is currently an editor, and the text being edited.
  // Editing happens IN the row — the collected prompt is a block of text sitting
  // right there, and lifting it into the composer at the bottom of the section
  // moved it away from where it was read and left the list showing the old
  // wording. The composer below stays what it is: the field a NEW prompt is
  // written in. Its draft is kept apart so an unfinished new prompt survives an
  // edit made in the middle of writing it.
  const [editing, setEditing] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  // Tags are typed as one line (`refactor, tests`) beside the text, for the
  // new prompt and for the row being edited; `lib/agentPromptTags` turns the
  // line into the stored tokens and back.
  const [draftTags, setDraftTags] = useState("");
  const [editTags, setEditTags] = useState("");
  // What the collected list — the prompt library — is narrowed to: a search
  // over text and tags, and one tag chip. View state like the sent filter.
  const [library, setLibrary] = useState<LibraryFilter>(EMPTY_LIBRARY_FILTER);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  // Which agent tabs have their composer open. Folded is the default: with
  // several agents in a scope, a column of open composers pushed the schedules
  // and the collected prompts below the fold, so the list reads as a list and a
  // composer is one click away. This holds the tabs the user OPENED — a set of
  // exceptions, the rule `stores/todo`'s collapsed checklists follow, so a tab
  // that appears later starts folded rather than inheriting somebody else's
  // expansion.
  const [unfolded, setUnfolded] = useState<string[]>([]);
  // The target picker a collected prompt's action opens. There is deliberately
  // no view-wide "target tab" any more: which agent a prompt is for is a
  // property of that send, asked at the moment it is made, not a mode the whole
  // list sits in and silently inherits.
  const [picking, setPicking] = useState<{ promptId: string; mode: "send" | "schedule" } | null>(null);
  // Which copy button is currently showing its acknowledgement, by its own key
  // (`session:<id>`, `prompt:<id>`) rather than by the copied text: two rows can
  // hold the same sentence, and only the one that was clicked should tick.
  const [copied, setCopied] = useState<string | null>(null);
  // What the Sent prompts list is narrowed to. Held here, not persisted: it is
  // a way of reading the record, not a setting — the next visit starts on the
  // whole list rather than on somebody's forgotten filter.
  const [filter, setFilter] = useState<SentPromptFilter>(EMPTY_SENT_FILTER);
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

  // Same for a prompt deleted (here or in another window) while its row is an
  // editor: the field would otherwise hang over a row that no longer exists.
  useEffect(() => {
    if (editing && !prompts.some((prompt) => prompt.id === editing)) {
      setEditing(null);
      setEditDraft("");
    }
  }, [editing, prompts]);

  useEffect(() => {
    if (!active) return;
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), CLOCK_MS);
    return () => clearInterval(timer);
  }, [active]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  // Decision outranks working outranks done, the same precedence `TabBar` and
  // the pill status bars read: a question still waiting on the user beats a tab
  // merely working, which beats one that has simply finished unseen.
  const stateOf = (tab: TabEntry): AgentState => {
    const ptyId = `${scope}:${tab.key}`;
    if (attentionByTab[ptyId] === "decision") return "decision";
    if (busyByTab[ptyId]) return "working";
    return attentionByTab[ptyId] === "done" ? "done" : "idle";
  };

  /**
   * What auto-continue has to say about one tab, as a sentence — or `null`
   * while the switch is off, which is when the row says nothing at all.
   *
   * Every branch names a state the host actually publishes, including the two
   * refusals: an agent whose CLI has no usage panel, and a panel that named no
   * time this reader could place. A switch that is on and quietly doing nothing
   * is the one thing this must never look like.
   */
  const continueLabel = (tab: TabEntry): string | null => {
    if (!tab.autoContinue || !tab.scheduleTargetId) return null;
    const status = continueByTarget[continueKey(scope, tab.scheduleTargetId)];
    if (!status) return t("agentContinue.reading");
    switch (status.phase) {
      case "armed":
        return status.armedAt === undefined
          ? t("agentContinue.reading")
          : t("agentContinue.armed", {
              relative: relativeToNow(new Date(status.armedAt), now, lang),
              window: status.window ?? "",
              resets: status.resets ?? "",
            });
      case "sending":
        return t("agentContinue.sending");
      case "unsupported":
        return t("agentContinue.unsupported");
      case "unreadable":
        return t("agentContinue.unreadable");
      case "error":
        return t("agentContinue.error", { reason: status.error ?? "" });
      default:
        return t("agentContinue.reading");
    }
  };

  const resetForm = () => {
    setDraft("");
    setDraftTags("");
    setError("");
  };

  /** Leave an in-place edit without writing it; the row goes back to its text. */
  const cancelEdit = () => {
    setEditing(null);
    setEditDraft("");
    setEditTags("");
    setError("");
  };

  /** The composer at the foot of the section only ever ADDS. */
  const savePrompt = async () => {
    const message = draft.trim();
    if (!message) {
      setError(t("agentSchedule.messageRequired"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      await upsertPrompt(scope, { id: crypto.randomUUID(), message, tags: parseTags(draftTags) });
      resetForm();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  /** Commit the row that is currently an editor. The prompt keeps its id, so it
   *  keeps its place in the order and stays the same prompt to anything holding
   *  a reference to it. */
  const saveEdit = async (id: string) => {
    const message = editDraft.trim();
    if (!message) {
      setError(t("agentSchedule.messageRequired"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      await upsertPrompt(scope, { id, message, tags: parseTags(editTags) });
      cancelEdit();
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

  /** Copy one value whole, with a moment of acknowledgement in the button that
   *  did it — the clipboard gives no feedback of its own. `key` identifies the
   *  button, so the ✓ appears on the one that was pressed. */
  const copy = (text: string, key: string) => {
    navigator.clipboard?.writeText(text).catch(() => {});
    setCopied(key);
  };

  /** Put a sent prompt back on the active list — it stays in the history. */
  const collectAgain = async (entry: SentAgentPrompt) => {
    setError("");
    try {
      await upsertPrompt(scope, { id: crypto.randomUUID(), message: entry.message, tags: entry.tags });
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

  // Which collected prompts already went to scheduling. The rules live on the
  // tabs, so the mark is computed from what the section above has loaded — see
  // `lib/agentPromptScheduled` for why the link is the prompt's text.
  const scheduleMarks = useMemo(
    () =>
      scheduledPromptMarks(
        prompts,
        agentTabs.map((tab) => ({
          label: tab.label,
          schedules: tab.scheduleTargetId
            ? schedulesByTarget[scheduleCacheKey(scope, tab.scheduleTargetId)] ?? EMPTY_SCHEDULES
            : EMPTY_SCHEDULES,
        })),
        now,
      ),
    [agentTabs, now, prompts, schedulesByTarget, scope],
  );

  // A prompt with a live rule LEAVES the library and reads in its own section:
  // it is no longer text waiting to be aimed at something, it is a delivery
  // with a date. The three sections are one lifecycle — collected, scheduled,
  // sent — so a prompt is in exactly one of them. It comes back to the library
  // if the rule is deleted (the mark follows the rules, not an intention), and
  // it moves on to Sent prompts when a one-time rule fires, which is
  // `AgentScheduleHost`'s retire step.
  const collected = useMemo(() => prompts.filter((prompt) => !scheduleMarks[prompt.id]), [prompts, scheduleMarks]);
  const scheduled = useMemo(() => prompts.filter((prompt) => scheduleMarks[prompt.id]), [prompts, scheduleMarks]);

  // The collected list is an ORDERED one — the prompt to send first belongs at
  // the top — so it is dragged the way every other ordered list in the app is
  // (`hooks/useListReorder`: pointer events, not HTML5 DnD, which WebKitGTK does
  // not deliver). The gesture runs over the LIBRARY's rows, since those are the
  // ones on screen in that section; the commit then writes the whole file order
  // back with the scheduled prompts left in their own slots, so a reorder in one
  // section never silently shuffles the other. Naming the whole order rather
  // than a move also means a prompt added in another window between the read and
  // the write survives it.
  const collectedIds = useMemo(() => collected.map((prompt) => prompt.id), [collected]);
  const reorder = useListReorder(collected, (id, to) => {
    const next = reorderedIds(collectedIds, id, to);
    if (next === collectedIds) return;
    let taken = 0;
    const ids = prompts.map((prompt) => (scheduleMarks[prompt.id] ? prompt.id : next[taken++]));
    void reorderPrompts(scope, ids).catch((cause) => setError(String(cause)));
  });

  // The library, narrowed. A drag is only offered on the whole list: a drop
  // index into a filtered view names the wrong slot in the file's order.
  const visiblePrompts = useMemo(() => filterCollectedPrompts(collected, library), [collected, library]);
  const libraryFiltering = isLibraryFilterActive(library);
  const libraryTags = useMemo(() => tagCounts(collected), [collected]);

  // Newest first, and only what the filter admits. The count of the whole
  // history is kept beside it so a narrowed list says what it is hiding.
  const agentsInHistory = useMemo(() => sentAgents(history), [history]);
  const tagsInHistory = useMemo(() => sentTags(history), [history]);
  const newestFirst = useMemo(
    () => filterSentPrompts(history, filter, now).reverse(),
    [filter, history, now],
  );
  const filtering = isSentFilterActive(filter);

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
          <span className={`agent-schedule-pill ${stateClass(stateOf(tab))}`} aria-hidden="true" />
          {tab.label}
        </button>
      ))}
      <button className="settings-btn sm" type="button" onClick={() => setPicking(null)}>
        {t("common.cancel")}
      </button>
    </div>
  );

  /**
   * One prompt as a row — the same text and the same actions whether it sits in
   * the library or in the Scheduled section, because what a prompt *is* does not
   * change when a rule is made for it; only which list it reads under does.
   *
   * The row is stacked: the message takes the full width of its own line and the
   * buttons sit on the line under it. A column of buttons beside the text
   * squeezed the message into a gutter, and the message is what the row is for.
   *
   * The one thing `place` decides is the drag. The order being dragged is the
   * *library's* — one file, one order — so a scheduled row carries no grip at
   * all, and a filtered library row carries a disabled one that says why.
   */
  const promptRow = (prompt: ProjectAgentPrompt, index: number, place: "library" | "scheduled") => {
    const draggable = place === "library" && !libraryFiltering;
    return (
      <div
        className={
          "agent-prompts-row is-stacked"
          + (place === "scheduled" ? " is-gripless" : "")
          + (draggable && reorder.isDragging(prompt.id)
            ? " is-dragging"
            : draggable && reorder.drag
              ? " is-parting"
              : "")
        }
        key={prompt.id}
        data-testid="agent-prompts-row"
        ref={draggable ? reorder.rowRef(prompt.id) : undefined}
        style={draggable ? reorder.rowStyle(index) : undefined}
      >
        {/* The grip, not the row, carries the gesture: the row is a block of
            text and four buttons, all of which stay clickable. */}
        {place === "library"
          && (libraryFiltering ? (
            <button
              type="button"
              className="agent-prompts-grip"
              disabled
              title={t("agentPrompts.reorderFiltered")}
              aria-label={t("agentPrompts.reorderFiltered")}
            >
              {"⠿"}
            </button>
          ) : (
            <button
              type="button"
              className="agent-prompts-grip"
              title={t("agentPrompts.reorder")}
              aria-label={t("agentPrompts.reorderAria")}
              {...reorder.gripProps(prompt.id)}
            >
              {"⠿"}
            </button>
          ))}
        <div className="agent-prompts-row-main">
          {editing === prompt.id ? (
            <MarkdownPromptField
              className="agent-prompts-edit"
              rows={4}
              value={editDraft}
              autoFocus
              ariaLabel={t("agentPrompts.editAria")}
              onChange={setEditDraft}
              // Escape leaves it as it was; Ctrl/⌘+Enter writes it, because
              // plain Enter has to stay a newline in a prompt.
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  cancelEdit();
                } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault();
                  void saveEdit(prompt.id);
                }
              }}
            />
          ) : (
            <span className="agent-prompts-message">{prompt.message}</span>
          )}
          {editing === prompt.id ? (
            <input
              className="agent-prompts-tags-input"
              value={editTags}
              placeholder={t("agentPrompts.tagsPlaceholder")}
              aria-label={t("agentPrompts.tags")}
              onChange={(event) => setEditTags(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") cancelEdit();
                else if (event.key === "Enter") void saveEdit(prompt.id);
              }}
            />
          ) : (
            prompt.tags && prompt.tags.length > 0 && (
              <div className="agent-prompts-tags" data-testid="agent-prompts-row-tags">
                {prompt.tags.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    className={`agent-composer-chip agent-prompts-tag${library.tag === tag ? " active" : ""}`}
                    title={t("agentPrompts.tagFilterTitle", { tag })}
                    onClick={() => setLibrary((current) => ({ ...current, tag }))}
                  >
                    #{tag}
                  </button>
                ))}
              </div>
            )
          )}
          <small>{t("agentPrompts.updated", { relative: relativeToNow(new Date(prompt.updated_at), now, lang) })}</small>
          {/* What the rule is doing, on the row it belongs to: which tabs carry
              it and when it next fires — the whole reason this prompt is in the
              Scheduled section rather than in the library above it. */}
          {scheduleMarks[prompt.id] && (
            <div
              className="agent-prompts-scheduled"
              data-testid="agent-prompts-scheduled"
              title={t("agentPrompts.scheduledTitle", {
                count: String(scheduleMarks[prompt.id].count),
                tabs: scheduleMarks[prompt.id].tabs.join(", "),
              })}
            >
              <span
                className={
                  "agent-schedule-pill" + (scheduleMarks[prompt.id].next ? " is-armed" : "")
                }
              >
                {t("agentPrompts.scheduled")}
              </span>
              <small>
                {scheduleMarks[prompt.id].next
                  ? t("agentPrompts.scheduledOn", {
                      tabs: scheduleMarks[prompt.id].tabs.join(", "),
                      relative: relativeToNow(scheduleMarks[prompt.id].next as Date, now, lang),
                    })
                  : t("agentPrompts.scheduledPaused", {
                      tabs: scheduleMarks[prompt.id].tabs.join(", "),
                    })}
              </small>
            </div>
          )}
          {picking?.promptId === prompt.id && targetPicker(prompt)}
        </div>
        <div className="agent-prompts-row-actions">
          {editing === prompt.id ? (
            <>
              {/* While the row is an editor its other actions step aside:
                  sending or scheduling half-rewritten text is nobody's
                  intent, and the two buttons that are left say what the
                  unsaved field can do. */}
              <button
                className="settings-btn sm primary"
                type="button"
                disabled={busy || !editDraft.trim()}
                onClick={() => void saveEdit(prompt.id)}
              >
                {t("common.save")}
              </button>
              <button className="settings-btn sm" type="button" onClick={cancelEdit}>
                {t("common.cancel")}
              </button>
            </>
          ) : (
            <>
              {/* Copy is one click and no dialog: a collected prompt is text
                  written to be pasted somewhere — a terminal, an issue,
                  another agent — and asking for it back should not mean
                  selecting it. */}
              <button
                className="agent-composer-chip agent-prompts-copy"
                type="button"
                title={t("agentPrompts.copy")}
                aria-label={t("agentPrompts.copy")}
                onClick={() => copy(prompt.message, `prompt:${prompt.id}`)}
              >
                {copied === `prompt:${prompt.id}` ? "✓" : "⧉"}
              </button>
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
                onClick={() => {
                  setEditing(prompt.id);
                  setEditDraft(prompt.message);
                  setEditTags(formatTags(prompt.tags));
                  setPicking(null);
                  setError("");
                }}
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
            </>
          )}
        </div>
      </div>
    );
  };

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
            // Prompts whose hour has arrived and that are waiting for this agent
            // to fall idle — every "Send to this tab" is one of these for as long
            // as it takes to land. They have no NEXT occurrence (their occurrence
            // is the one now passing), so the summary line below could only ever
            // say "no next run" about them: a prompt the user had just sent
            // vanished into a row that said nothing was scheduled, which is what
            // made a send look like it had done nothing at all.
            const queued = schedules.filter((schedule) => scheduleStatus(schedule, now).kind === "due");
            const state = stateOf(tab);
            const open = unfolded.includes(tab.key);
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
                        {/* The name IS the way there. A row that names a tab and
                            says what it is waiting for has exactly one useful
                            next step, and clicking the thing you just read is
                            how every other list in the app takes it. */}
                        <button
                          className="agent-prompts-tab-name"
                          type="button"
                          title={t("agentPrompts.jumpTitle", { tab: tab.label })}
                          onClick={() => jumpToTab(scope, tab.key)}
                        >
                          <strong>{tab.label}</strong>
                        </button>
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
                    <span className={`agent-schedule-pill ${stateClass(state)}`}>
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
                        : queued.length > 0
                          ? `${summary.enabled} · ${t("agentPrompts.queuedCount", { count: queued.length })}`
                          : `${summary.enabled} · ${t("agentSchedule.noNext")}`}
                  </small>
                  {/* The waiting prompts themselves, in full: a queue you can
                      read is the difference between "it is waiting for the agent"
                      and "nothing happened". */}
                  {queued.length > 0 && (
                    <ul className="agent-prompts-queued" data-testid="agent-prompts-queued">
                      {queued.map((schedule) => (
                        <li key={schedule.id}>
                          <span className="agent-schedule-pill is-due">
                            {t("agentPrompts.queuedPill")}
                          </span>
                          <span className="agent-prompts-queued-text" title={t("agentPrompts.queuedHint")}>
                            {schedule.message}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {/* The switch says nothing while it is off; while it is on it
                      says what it is waiting for, including the two ways it can
                      have nothing to wait for. */}
                  {continueLabel(tab) && (
                    <small className="agent-prompts-tab-when" data-testid="agent-continue-status">
                      {"\u27f3 "}
                      {continueLabel(tab)}
                    </small>
                  )}
                  {open && (
                    <AgentTabComposer
                      scope={scope}
                      tab={tab}
                      offered={offered}
                      models={models}
                    />
                  )}
                </div>
                <div className="agent-prompts-tab-actions">
                  {/* The same jump as the name, spelled out: the name being a
                      link is discoverable only once you have hovered it. */}
                  <button
                    className="agent-composer-chip"
                    type="button"
                    title={t("agentPrompts.jumpTitle", { tab: tab.label })}
                    onClick={() => jumpToTab(scope, tab.key)}
                  >
                    {"\u2197 "}
                    {t("agentPrompts.jump")}
                  </button>
                  <button
                    className={`agent-composer-chip${open ? " active" : ""}`}
                    type="button"
                    aria-pressed={open}
                    title={t("agentPrompts.composerToggleTitle")}
                    onClick={() =>
                      setUnfolded((current) =>
                        current.includes(tab.key)
                          ? current.filter((entry) => entry !== tab.key)
                          : [...current, tab.key],
                      )
                    }
                  >
                    {t("agentPrompts.composerToggle")}
                  </button>
                  <button
                    className={`agent-composer-chip${tab.autoContinue ? " active" : ""}`}
                    type="button"
                    aria-pressed={!!tab.autoContinue}
                    data-testid="agent-continue-toggle"
                    title={t("agentContinue.toggleTitle")}
                    onClick={() => {
                      setAutoContinue(scope, tab.key, !tab.autoContinue);
                      // The switch lives on the tab, and a tab reaches disk only
                      // when the layout is next written — which for a scope that
                      // is not the active one may be never. Pin it now, the same
                      // way a schedule pins its binding.
                      void persistScheduleBinding(scope);
                    }}
                  >
                    {"\u27f3 "}
                    {t("agentContinue.toggle")}
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
        <h3 className="settings-section-title">
          {t("agentPrompts.heading")}
          <UntestedTag />
        </h3>
        <p className="settings-help">{t("agentPrompts.intro")}</p>
        {agentTabs.length === 0 && <p className="settings-help">{t("agentPrompts.sendNeedsTab")}</p>}
        {notice && <div className="agent-prompts-notice">{notice}</div>}
        {error && <div className="project-dialog-error">{error}</div>}
        {collected.length === 0 && <div className="file-tree-empty">{t("agentPrompts.none")}</div>}
        {/* The library search: text over prompt and tags, plus one chip per
            tag in use. It is what makes a few dozen collected prompts a
            library rather than a scroll — a prompt is found by what it is for. */}
        {collected.length > 0 && (
          <div className="agent-prompts-filters" role="group" aria-label={t("agentPrompts.libraryHeading")}>
            <input
              type="search"
              className="agent-prompts-filter-text"
              value={library.text}
              placeholder={t("agentPrompts.libraryText")}
              aria-label={t("agentPrompts.libraryText")}
              onChange={(event) => setLibrary((current) => ({ ...current, text: event.target.value }))}
            />
            {libraryTags.length > 0 && (
              <div className="agent-prompts-tags" role="group" aria-label={t("agentPrompts.tagsHeading")}>
                {libraryTags.map(({ tag, count }) => (
                  <button
                    key={tag}
                    type="button"
                    className={`agent-composer-chip agent-prompts-tag${library.tag === tag ? " active" : ""}`}
                    aria-pressed={library.tag === tag}
                    title={t("agentPrompts.tagFilterTitle", { tag })}
                    onClick={() =>
                      setLibrary((current) => ({ ...current, tag: current.tag === tag ? "" : tag }))
                    }
                  >
                    #{tag}
                    <span>{count}</span>
                  </button>
                ))}
              </div>
            )}
            {libraryFiltering && (
              <div className="agent-prompts-filter-foot">
                <small>{t("agentPrompts.filterCount", { shown: visiblePrompts.length, total: collected.length })}</small>
                <button className="settings-btn sm" type="button" onClick={() => setLibrary(EMPTY_LIBRARY_FILTER)}>
                  {t("agentPrompts.filterClear")}
                </button>
              </div>
            )}
          </div>
        )}
        {collected.length > 0 && visiblePrompts.length === 0 && (
          <div className="file-tree-empty">{t("agentPrompts.libraryNone")}</div>
        )}
        {visiblePrompts.map((prompt, index) => promptRow(prompt, index, "library"))}
        <div className="agent-prompts-form">
          <MarkdownPromptField
            rows={4}
            value={draft}
            placeholder={t("agentPrompts.placeholder")}
            ariaLabel={t("agentSchedule.message")}
            onChange={setDraft}
          />
          <input
            className="agent-prompts-tags-input"
            value={draftTags}
            placeholder={t("agentPrompts.tagsPlaceholder")}
            aria-label={t("agentPrompts.tags")}
            onChange={(event) => setDraftTags(event.target.value)}
          />
          <div className="agent-schedule-form-actions">
            <button className="settings-btn primary" type="button" disabled={busy} onClick={() => void savePrompt()}>
              {t("agentPrompts.add")}
            </button>
          </div>
        </div>
      </section>

      {/* Scheduled: the middle of the three lists, and the reason the library
          above it stays a library. A prompt that has become a rule is no longer
          waiting to be aimed at something, so it reads here with what it is
          waiting for; it goes back up if the rule is deleted, and down to Sent
          prompts once a one-time rule has fired. Always rendered, empty
          included — an absent section is where a feature goes unfound. */}
      <section className="agent-prompts-section">
        <h3 className="settings-section-title">
          {t("agentPrompts.scheduledHeading")}
          <UntestedTag />
        </h3>
        <p className="settings-help">{t("agentPrompts.scheduledIntro")}</p>
        {scheduled.length === 0 ? (
          <div className="file-tree-empty">{t("agentPrompts.scheduledNone")}</div>
        ) : (
          scheduled.map((prompt, index) => promptRow(prompt, index, "scheduled"))
        )}
      </section>

      <section className="agent-prompts-section">
        <h3 className="settings-section-title">
          {t("agentPrompts.historyHeading")}
          <UntestedTag />
          {history.length > 0 && (
            <button
              className="settings-btn sm danger"
              type="button"
              title={t("agentPrompts.historyClearTitle")}
              onClick={() => void clearHistory(scope).catch((cause) => setError(String(cause)))}
            >
              {t("agentPrompts.historyClear")}
            </button>
          )}
        </h3>
        <p className="settings-help">{t("agentPrompts.historyIntro")}</p>
        {/* Four facets, because the questions this list is opened with are
            narrow ones: what did I send Codex, what failed, what went out
            today, where did that one sentence go. They compose, and they are
            not persisted — a filter is a way of reading the record, not a
            setting the next visit should inherit. */}
        {history.length > 0 && (
          <div className="agent-prompts-filters" role="group" aria-label={t("agentPrompts.filterHeading")}>
            <input
              type="search"
              className="agent-prompts-filter-text"
              value={filter.text}
              placeholder={t("agentPrompts.filterText")}
              aria-label={t("agentPrompts.filterText")}
              onChange={(event) => setFilter((current) => ({ ...current, text: event.target.value }))}
            />
            <div className="agent-prompts-filter-row">
              {tagsInHistory.length > 0 && (
                <Dropdown
                  className="agent-prompts-filter-pick"
                  value={filter.tag}
                  title={t("agentPrompts.filterTag")}
                  placeholder={t("agentPrompts.filterTagAll")}
                  options={[
                    { value: "", label: t("agentPrompts.filterTagAll") },
                    ...tagsInHistory.map((tag) => ({ value: tag, label: `#${tag}` })),
                  ]}
                  onChange={(value) => setFilter((current) => ({ ...current, tag: value }))}
                />
              )}
              {agentsInHistory.length > 0 && (
                <Dropdown
                  className="agent-prompts-filter-pick"
                  value={filter.agent}
                  title={t("agentPrompts.filterAgent")}
                  placeholder={t("agentPrompts.filterAgentAll")}
                  options={[
                    { value: "", label: t("agentPrompts.filterAgentAll") },
                    ...agentsInHistory.map((agent) => ({ value: agent, label: agent })),
                  ]}
                  onChange={(value) => setFilter((current) => ({ ...current, agent: value }))}
                />
              )}
              <Dropdown
                className="agent-prompts-filter-pick"
                value={filter.result}
                title={t("agentPrompts.filterResult")}
                placeholder={t("agentPrompts.filterResultAll")}
                options={[
                  { value: "", label: t("agentPrompts.filterResultAll") },
                  ...SENT_RESULTS.map((result) => ({
                    value: result,
                    label:
                      result === "queued"
                        ? t("agentPrompts.historyQueued")
                        : t(`agentSchedule.status.${result}` as "agentSchedule.status.delivered"),
                  })),
                ]}
                onChange={(value) => setFilter((current) => ({ ...current, result: value }))}
              />
              <Dropdown
                className="agent-prompts-filter-pick"
                value={filter.window}
                title={t("agentPrompts.filterWindow")}
                options={SENT_WINDOWS.map((window) => ({
                  value: window,
                  label: t(`agentPrompts.window.${window}` as "agentPrompts.window.any"),
                }))}
                onChange={(value) =>
                  setFilter((current) => ({ ...current, window: value as SentPromptFilter["window"] }))
                }
              />
            </div>
            <div className="agent-prompts-filter-foot">
              <small>
                {filtering
                  ? t("agentPrompts.filterCount", { shown: newestFirst.length, total: history.length })
                  : t("agentPrompts.filterTotal", { total: history.length })}
              </small>
              {filtering && (
                <button
                  className="settings-btn sm"
                  type="button"
                  onClick={() => setFilter(EMPTY_SENT_FILTER)}
                >
                  {t("agentPrompts.filterClear")}
                </button>
              )}
            </div>
          </div>
        )}
        {newestFirst.length === 0 ? (
          <div className="file-tree-empty">
            {filtering ? t("agentPrompts.filterNone") : t("agentPrompts.historyNone")}
          </div>
        ) : (
          newestFirst.map((entry) => (
            <div
              className="agent-prompts-row is-stacked is-gripless"
              key={`${entry.id}-${entry.sent_at}`}
              data-testid="agent-prompts-sent"
            >
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
                {entry.tags && entry.tags.length > 0 && (
                  <div className="agent-prompts-tags">
                    {entry.tags.map((tag) => (
                      <button
                        key={tag}
                        type="button"
                        className={`agent-composer-chip agent-prompts-tag${filter.tag === tag ? " active" : ""}`}
                        title={t("agentPrompts.tagFilterTitle", { tag })}
                        onClick={() => setFilter((current) => ({ ...current, tag }))}
                      >
                        #{tag}
                      </button>
                    ))}
                  </div>
                )}
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
                        onClick={() => copy(entry.session_id!, `session:${entry.id}`)}
                      >
                        {copied === `session:${entry.id}` ? "\u2713" : "\u29c9"}
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
                {/* Prompt blame. `git blame` says which commit put a line
                    there; this says which prompt did: the commit the agent
                    started from, and — once the scheduler saw the tab idle
                    again — the files that changed while it worked. A file is
                    a button that turns into the text filter, so "which
                    prompts touched this file" is one click. */}
                {entry.commit && (
                  <small className="agent-prompts-session agent-prompts-blame" title={t("agentPrompts.blameTitle")}>
                    <span className="agent-prompts-session-id" data-testid="agent-prompts-blame">
                      {entry.branch
                        ? `${entry.branch} @ ${entry.commit.slice(0, 7)}`
                        : t("agentPrompts.blameCommit", { commit: entry.commit.slice(0, 7) })}
                    </span>
                    <button
                      className="agent-composer-chip agent-prompts-copy"
                      type="button"
                      title={t("agentPrompts.blameCopy")}
                      aria-label={t("agentPrompts.blameCopy")}
                      onClick={() => copy(entry.commit!, `commit:${entry.id}`)}
                    >
                      {copied === `commit:${entry.id}` ? "\u2713" : "\u29c9"}
                    </button>
                  </small>
                )}
                {entry.files_at ? (
                  entry.files && entry.files.length > 0 ? (
                    <details className="agent-prompts-files" data-testid="agent-prompts-files">
                      <summary>{t("agentPrompts.blameFiles", { count: entry.files.length })}</summary>
                      <ul>
                        {entry.files.map((file) => (
                          <li key={file}>
                            <button
                              type="button"
                              className="agent-prompts-file"
                              title={t("agentPrompts.blameFileFilter", { file })}
                              onClick={() => setFilter((current) => ({ ...current, text: file }))}
                            >
                              {file}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : (
                    <small>{t("agentPrompts.blameFilesNone")}</small>
                  )
                ) : (
                  entry.commit && entry.result === "delivered" && (
                    <small>{t("agentPrompts.blameFilesPending")}</small>
                  )
                )}
              </div>
              <div className="agent-prompts-row-actions">
                <button
                  className="agent-composer-chip agent-prompts-copy"
                  type="button"
                  title={t("agentPrompts.copy")}
                  aria-label={t("agentPrompts.copy")}
                  onClick={() => copy(entry.message, `sent:${entry.id}`)}
                >
                  {copied === `sent:${entry.id}` ? "\u2713" : "\u29c9"}
                </button>
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
