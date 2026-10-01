import { Fragment, memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { useT } from "../../lib/i18n";
import {
  READER_STEP,
  mergeTranscript,
  readerReasonKey,
  readerRequest,
  type SessionTranscript,
} from "../../lib/agents/agentReader";
import { NO_LIVE, STOP_KEY, answerKeys, readReaderLive, sameReaderLive, type ReaderLive } from "../../lib/agents/readerLive";
import { onSentPrompt } from "../../lib/agents/sentPrompts";
import { sendSteeringPrompt } from "../../lib/shortcuts/steeringAgent";
import { writePtyInput } from "../../lib/terminal/terminalInput";
import { terminalFor } from "../../lib/terminal/terminalRegistry";
import { isInterruptInput, noteUserInput } from "../../stores/activity";
import { useUse24h } from "../../lib/timeFormat";
import { agentTabLabel, agentTabModelTag, useAgentModelsStore } from "../../stores/agents/agentModels";
import { useKeyboardSteeringStore } from "../../stores/keyboardSteering";
import { useTabsStore } from "../../stores/tabs";
import { SIGN_IN_CARD_CLASS } from "./TerminalSignInCard";
import { TerminalReaderFacts } from "./TerminalReaderFacts";
import { UntestedTag } from "../common/UntestedTag";
import { answerHtml } from "../../../mobile-web/src/terminal/answerMarkdown";
import { chatDayLabel, chatMoment, chatTime, dayOpeners } from "../../../mobile-web/src/terminal/chatTimes";
import { openSubagent, siblingPosition, stepSibling, type SubagentStep } from "../../../mobile-web/src/terminal/subagents";
import { commandArgsInline, transcriptTurns, type TranscriptTurn } from "../../../mobile-web/src/terminal/transcriptTurns";

/** How often a shown Reader asks for the transcript again. The backend
 * answers an unchanged file by its fingerprint, without a parse. */
const POLL_MS = 2000;
/** How long a sent prompt shows as sending while the transcript has not
 * recorded it yet — counted from the send, or from the last moment the agent
 * was seen working (a prompt queued behind a long turn is recorded only once
 * the CLI takes it up). */
const PENDING_MS = 60_000;
/** How soon after the pane's output the live screen is read again, and how
 * often regardless (the busy row's timer, a pane not created yet). */
const LIVE_SETTLE_MS = 250;
const LIVE_POLL_MS = 1500;
/** The phone's key pacing for a dialog answer: arrows apart, Enter later. */
const KEY_GAP_MS = 80;
const SUBMIT_GAP_MS = 200;
/** How long an answered dialog stays unclickable while the session redraws. */
const ANSWER_WAIT_MS = 3000;
const ENCODER = new TextEncoder();

async function typeKeys(ptyId: string, keys: string[]): Promise<void> {
  for (let index = 0; index < keys.length; index += 1) {
    const bytes = ENCODER.encode(keys[index]);
    noteUserInput(ptyId, isInterruptInput(keys[index]));
    await writePtyInput(ptyId, bytes);
    if (index + 1 < keys.length) {
      await new Promise((resolve) => setTimeout(resolve, index + 2 === keys.length ? SUBMIT_GAP_MS : KEY_GAP_MS));
    }
  }
}

/** The mark Claude Code asks agents to put on the option they would pick,
 * shown as a tag beside the label (the phone's `QuestionList` does the same). */
const RECOMMENDED = /\s+\(Recommended\)$/u;

/** The choice the session waits on, as buttons: what it was drawn onto (a
 * permission prompt's command or diff), an agent question's headers as chips,
 * its question, then one row per option. A click sends the arrow keys and
 * Enter a walked highlight would. */
function LiveQuestion({ live, answered, onAnswer }: {
  live: ReaderLive;
  answered: boolean;
  onAnswer: (index: number) => void;
}) {
  const t = useT();
  const question = live.question;
  if (!question) return null;
  return (
    <div className="terminal-reader-question" role="group" aria-label={t("terminal.reader.question")}>
      <small className="terminal-reader-question-head">{t("terminal.reader.question")}</small>
      {live.context.length > 0 && <pre className="terminal-reader-question-context">{live.context.join("\n")}</pre>}
      {live.tabs.length > 0 && (
        <div className="terminal-reader-question-tabs">
          {live.tabs.map((tab, index) => (
            <span key={index} className={tab.answered ? "answered" : undefined}>{tab.answered && "✓ "}{tab.label}</span>
          ))}
        </div>
      )}
      {live.ask.length > 0 && <p className="terminal-reader-question-ask">{live.ask.join("\n")}</p>}
      <div className="terminal-reader-options">
        {question.options.map((option) => {
          const recommended = RECOMMENDED.exec(option.label);
          return (
            <button
              key={`${option.index}:${option.label}`}
              type="button"
              className={option.index === question.current ? "terminal-reader-option current" : "terminal-reader-option"}
              disabled={answered}
              onClick={() => onAnswer(option.index)}
            >
              <span className="terminal-reader-option-number">{option.number}</span>
              <span className="terminal-reader-option-label">
                <span>
                  {recommended ? option.label.slice(0, recommended.index) : option.label}
                  {recommended && <em className="terminal-reader-recommended">{t("terminal.reader.recommended")}</em>}
                </span>
                {option.description && <small>{option.description}</small>}
              </span>
            </button>
          );
        })}
      </div>
      {!!question.hidden && <small className="terminal-reader-question-more">{t("terminal.reader.moreChoices")}</small>}
      {answered && <small className="terminal-reader-question-more" role="status">{t("terminal.reader.answering")}</small>}
    </div>
  );
}

interface PendingPrompt { id: number; text: string; sentAt: number }

/** One answer as formatted text (`answerHtml`, the phone's: formatting only,
 * nothing in it opens or loads). Memoized on the text, so a read that brings
 * a new turn does not re-render every answer above it. */
const AnswerText = memo(function AnswerText({ text }: { text: string }) {
  const html = useMemo(() => answerHtml(text), [text]);
  return <div className="markdown-body terminal-reader-md" dangerouslySetInnerHTML={{ __html: html }} />;
});

/** What a subagent's card or list row opens: its handle and what it says. */
type SubagentPick = Pick<TranscriptTurn, "subagent" | "text" | "role">;

function Turn({ turn, cutLabel, planLabel, agentLabel, use24h, onOpenAgent }: {
  turn: TranscriptTurn;
  cutLabel: string;
  planLabel: string;
  agentLabel: string;
  use24h: boolean;
  onOpenAgent: (turn: SubagentPick) => void;
}) {
  const moment = chatMoment(turn.stamp);
  const time = moment && <small className="terminal-reader-time">{chatTime(moment, use24h)}</small>;
  const cut = turn.cut && <small className="terminal-reader-cut">{cutLabel}</small>;
  if (turn.kind === "agent") {
    // The phone's `SubagentCard`: a click opens its own conversation. One whose
    // CLI has not yet recorded where that lives cannot be opened yet.
    const openable = !!turn.subagent;
    return (
      <button type="button" className="terminal-reader-subagent" disabled={!openable} onClick={() => onOpenAgent(turn)}>
        <span className="terminal-reader-subagent-body">
          <small>{turn.role ?? agentLabel} <UntestedTag id="terminal.reader.subagents" /></small>
          <span>{turn.text}{turn.cut && "…"}</span>
        </span>
        {openable && <span className="terminal-reader-subagent-chevron" aria-hidden="true">›</span>}
      </button>
    );
  }
  if (turn.command) {
    const inline = commandArgsInline(turn.command.args);
    return <>
      <div className="terminal-reader-command" role="separator">
        <span>{inline && turn.command.args ? `${turn.command.name} ${turn.command.args}` : turn.command.name}</span>
      </div>
      {!inline && <div className="terminal-reader-turn user"><p>{turn.command.args}</p>{time}</div>}
    </>;
  }
  if (turn.kind === "prompt") {
    return <div className="terminal-reader-turn user"><p>{turn.text}</p>{cut}{time}</div>;
  }
  return (
    <div className={turn.plan ? "terminal-reader-turn agent plan" : "terminal-reader-turn agent"}>
      {turn.plan && <small className="terminal-reader-plan-head">{planLabel}</small>}
      <AnswerText text={turn.text} />
      {cut}
      {time}
    </div>
  );
}

/**
 * The agent pane's Reader (`lib/agents/agentReader`): the stored conversation
 * as the phone's Focus Reader draws it — prompts on the right, answers on the
 * left as formatted text, slash commands as rules, a day chip where the day
 * changes — with a composer that sends through the prompt box's path
 * (`sendSteeringPrompt`, queued by the CLI while the agent works). Portaled
 * over the terminal, which keeps running and taking the PTY's output
 * underneath; the pane's own mouse handling leaves it alone
 * (`SIGN_IN_CARD_CLASS`). Reads only while the pane is shown.
 *
 * A subagent the agent spawned opens into its own conversation, as on the
 * phone (`mobile-web` `subagents.ts`): a bar above the chat goes back up (Esc
 * in the composer too) and steps between the subagents beside it, and a
 * "Subagents" list over the session names them all. Prompts always go to the
 * session, and sending one goes back to it.
 */
export function TerminalReaderView({ host, ptyId, scope, tabKey, cwd, visible, focused, onShowTerminal }: {
  host: HTMLElement;
  /** The pane's PTY: its live screen is read, answers and Stop typed into it. */
  ptyId: string;
  scope: string;
  tabKey: string;
  cwd: string | undefined;
  visible: boolean;
  focused: boolean;
  /** Back to the terminal, keyboard included (Esc in the composer, once no
   * subagent is open; the prompt strip's switch is the other way). */
  onShowTerminal: () => void;
}) {
  const t = useT();
  const tab = useTabsStore((state) => state.tabsByScope[scope]?.find((entry) => entry.key === tabKey));
  const [transcript, setTranscript] = useState<SessionTranscript | null>(null);
  const [limit, setLimit] = useState(READER_STEP);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const [pending, setPending] = useState<PendingPrompt[]>([]);
  const [readTick, setReadTick] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const stuck = useRef(true);
  const keepFromBottom = useRef<number | null>(null);
  const version = useRef<string | undefined>();
  const pendingId = useRef(0);
  /** The subagents walked into from the session, outermost first; empty
   * while the session itself is shown. */
  const [subagentPath, setSubagentPath] = useState<readonly SubagentStep[]>([]);
  const [subagentListOpen, setSubagentListOpen] = useState(false);
  const subagentListId = useId();
  const openStep = subagentPath[subagentPath.length - 1];
  const subToken = openStep?.token;
  /** The last read of a subagent's conversation, and whose it is — a read
   * that belongs to another subagent is never drawn under this one's bar. */
  const [subRead, setSubRead] = useState<{ token: string; transcript: SessionTranscript } | null>(null);
  const [subLimit, setSubLimit] = useState(READER_STEP);
  /** Where to scroll once the conversation just gone back up to is drawn. */
  const restoreScroll = useRef<number | null>(null);

  const [live, setLive] = useState<ReaderLive>(NO_LIVE);
  /** When a read last saw the agent at work: a sent prompt waits from then. */
  const workingSeenAt = useRef(0);
  const [answered, setAnswered] = useState("");
  const [picking, setPicking] = useState(false);
  /** Steering holds the keyboard (or its prompt box does): a composer on show
   * would take typing that goes to steering, so it stands aside — the Prompt
   * key (I) is how a prompt goes in then. */
  const steering = useKeyboardSteeringStore((state) => state.active || state.handedTo !== null);
  const agentLabel = tab ? agentTabLabel(tab) : "";
  const use24h = useUse24h();
  const modelsByTab = useAgentModelsStore((state) => state.byTab);
  const screenModels = useAgentModelsStore((state) => state.screenByTab);
  const modelTag = tab ? agentTabModelTag(scope, tab, modelsByTab, screenModels) : undefined;
  /** The working row's name for the agent, as the phone's says it: the model
   * the session prints, its first word (`Opus is working…`). */
  const workingModel = (live.status?.model ?? modelTag)?.trim().split(/\s+/)[0];
  const typeIntoPane = useCallback((keys: string[]) => typeKeys(ptyId, keys), [ptyId]);

  // The live screen: read on the pane's output (settled), and on a slow
  // clock for the busy row's timer and a terminal not created yet.
  useEffect(() => {
    if (!visible) return;
    let settle: ReturnType<typeof setTimeout> | undefined;
    let subscribed: { dispose: () => void } | undefined;
    const read = () => {
      settle = undefined;
      const term = terminalFor(ptyId);
      if (!term) return;
      if (!subscribed) subscribed = term.onWriteParsed(() => { settle ??= setTimeout(read, LIVE_SETTLE_MS); });
      const next = readReaderLive(term.buffer.active, agentLabel, term.cols);
      if (next.working) workingSeenAt.current = Date.now();
      setLive((previous) => (sameReaderLive(previous, next) ? previous : next));
    };
    read();
    const clock = setInterval(read, LIVE_POLL_MS);
    return () => {
      clearInterval(clock);
      if (settle) clearTimeout(settle);
      subscribed?.dispose();
    };
  }, [visible, ptyId, agentLabel]);

  // An answered dialog is clickable again once it is redrawn as something
  // else, or — the keys did not land — after a short wait.
  useEffect(() => {
    if (!answered) return;
    if (live.signature !== answered) {
      setAnswered("");
      return;
    }
    const stuckTimer = setTimeout(() => setAnswered(""), ANSWER_WAIT_MS);
    return () => clearTimeout(stuckTimer);
  }, [answered, live.signature]);

  const answer = (index: number) => {
    const question = live.question;
    const option = question?.options.find((entry) => entry.index === index);
    if (!question || !option || answered) return;
    setAnswered(live.signature);
    stuck.current = true;
    void typeKeys(ptyId, answerKeys(question, option)).catch(() => setAnswered(""));
  };
  const stop = () => void typeKeys(ptyId, [STOP_KEY]).catch(() => {});
  const shownLive = picking ? NO_LIVE : live;

  const tabRef = useRef(tab);
  tabRef.current = tab;
  const sessionId = tab?.sessionId;
  // A new session (a restart, a `/clear` the hook followed) is a new chat,
  // with subagents of its own.
  useEffect(() => {
    version.current = undefined;
    setTranscript(null);
    setSubagentPath([]);
    setSubagentListOpen(false);
  }, [sessionId]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let busy = false;
    const read = async () => {
      const current = tabRef.current;
      if (busy || !current) return;
      const args = readerRequest(scope, current, cwd, version.current, limit);
      if (!args) {
        setTranscript({ available: false, reason: "no_session", entries: [], truncated: false });
        return;
      }
      busy = true;
      const next = await invoke<SessionTranscript>("agent_tab_transcript", args)
        .catch((): SessionTranscript => ({ available: false, reason: "read_failed", entries: [], truncated: false }));
      busy = false;
      if (cancelled) return;
      if (!next.unchanged) version.current = next.version;
      setTranscript((previous) => mergeTranscript(previous, next));
    };
    void read();
    const timer = setInterval(() => void read(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [visible, scope, cwd, limit, sessionId, readTick]);

  // The open subagent's conversation, read as the session is: at once, then
  // every POLL_MS while shown — a subagent still at work keeps writing.
  useEffect(() => {
    if (!visible || !subToken) return;
    let cancelled = false;
    let busy = false;
    let subVersion: string | undefined;
    const read = async () => {
      const current = tabRef.current;
      if (busy || !current) return;
      const args = readerRequest(scope, current, cwd, subVersion, subLimit, subToken);
      if (!args) return;
      busy = true;
      const next = await invoke<SessionTranscript>("agent_tab_transcript", args)
        .catch((): SessionTranscript => ({ available: false, reason: "read_failed", entries: [], truncated: false }));
      busy = false;
      if (cancelled) return;
      if (!next.unchanged) subVersion = next.version;
      setSubRead((previous) => ({
        token: subToken,
        transcript: mergeTranscript(previous?.token === subToken ? previous.transcript : null, next),
      }));
    };
    void read();
    const timer = setInterval(() => void read(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [visible, scope, cwd, subToken, subLimit, sessionId]);

  const entries = useMemo(() => (transcript?.available ? transcript.entries : []), [transcript]);
  /** The open subagent's conversation, once read. */
  const subTranscript = subRead && subRead.token === subToken ? subRead.transcript : null;
  /** The conversation on screen — the session's, or the open subagent's —
   * which is where a card clicked in it was opened from. */
  const shownTranscript = openStep ? subTranscript : transcript;
  const levelEntries = useMemo(() => (shownTranscript?.available ? shownTranscript.entries : []), [shownTranscript]);
  const levelEntriesRef = useRef(levelEntries);
  levelEntriesRef.current = levelEntries;
  const turns = useMemo(() => transcriptTurns(levelEntries), [levelEntries]);
  const openers = useMemo(() => dayOpeners(turns.map((turn) => turn.stamp)), [turns]);
  const sessionAgents = useMemo(() => entries.filter((entry) => entry.kind === "agent"), [entries]);

  // Every prompt sent to this tab — this composer's or steering's prompt box —
  // shows as sending at once, the agent idle or at work (the CLI queues it).
  const sendTarget = tab?.scheduleTargetId;
  useEffect(() => {
    if (!sendTarget) return;
    return onSentPrompt(sendTarget, ({ text, sentAt }) => {
      pendingId.current += 1;
      const id = pendingId.current;
      setPending((items) => [...items, { id, text, sentAt }]);
      stuck.current = true;
      setReadTick((tick) => tick + 1);
      // It went to the session, never to a subagent: back to where it lands.
      setSubagentPath([]);
    });
  }, [sendTarget]);

  // A sent prompt shows until the transcript records it (by its words, at or
  // after the moment it went) or it has waited long enough to be let go.
  useEffect(() => {
    if (pending.length === 0) return;
    const now = Date.now();
    const waitingSince = (item: PendingPrompt) => Math.max(item.sentAt, workingSeenAt.current);
    const recorded = (item: PendingPrompt) => entries.some((entry) =>
      entry.kind === "prompt" && entry.text.trim() === item.text.trim()
      && (!entry.at || Date.parse(entry.at) >= item.sentAt - 5_000));
    const left = pending.filter((item) => now - waitingSince(item) < PENDING_MS && !recorded(item));
    if (left.length !== pending.length) {
      setPending(left);
      return;
    }
    // Nothing new may come in to look again: let the first one go on time.
    const due = Math.min(...left.map(waitingSince)) + PENDING_MS - now;
    const timer = setTimeout(() => setPending((items) => [...items]), due);
    return () => clearTimeout(timer);
  }, [entries, pending]);

  const onScroll = () => {
    const list = listRef.current;
    if (!list) return;
    stuck.current = list.scrollHeight - list.scrollTop - list.clientHeight < 24;
  };
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    if (restoreScroll.current !== null) {
      // Back up a level: where it was scrolled, once it is drawn again.
      if (!shownTranscript) return;
      list.scrollTop = restoreScroll.current;
      restoreScroll.current = null;
    } else if (keepFromBottom.current !== null) {
      // Earlier turns came in above: the ones being read stay where they were.
      list.scrollTop = list.scrollHeight - list.clientHeight - keepFromBottom.current;
      keepFromBottom.current = null;
    } else if (stuck.current) {
      list.scrollTop = list.scrollHeight;
    }
  }, [turns, pending, live, shownTranscript]);

  const showEarlier = () => {
    const list = listRef.current;
    if (list) keepFromBottom.current = list.scrollHeight - list.scrollTop - list.clientHeight;
    if (openStep) {
      setSubLimit((current) => current + READER_STEP);
      return;
    }
    version.current = undefined;
    setLimit((current) => current + READER_STEP);
  };

  /** Opens a subagent from the conversation on screen, which it goes back up
   * to where it was scrolled. One opened from the list keeps the list open
   * for the way back. Its conversation opens on its newest turn. */
  const openAgent = useCallback((turn: SubagentPick, fromList = false) => {
    const token = turn.subagent;
    if (!token) return;
    const top = listRef.current?.scrollTop ?? 0;
    setSubagentPath((path) => openSubagent(path, { token, task: turn.text, role: turn.role }, levelEntriesRef.current, top));
    if (!fromList) setSubagentListOpen(false);
    setSubLimit(READER_STEP);
    keepFromBottom.current = null;
    stuck.current = true;
  }, []);
  const subagentUp = () => {
    if (!openStep) return;
    restoreScroll.current = openStep.scrollTop;
    keepFromBottom.current = null;
    stuck.current = false;
    setSubLimit(READER_STEP);
    setSubagentPath((path) => path.slice(0, -1));
  };
  const subagentSibling = (delta: number) => {
    keepFromBottom.current = null;
    stuck.current = true;
    setSubLimit(READER_STEP);
    setSubagentPath((path) => stepSibling(path, delta));
  };

  // The keyboard goes to the composer whenever this pane is the focused one,
  // and back to it when steering lets go.
  useEffect(() => {
    if (focused && visible && !steering) composerRef.current?.focus();
  }, [focused, visible, steering]);

  const send = useCallback(async () => {
    const current = tabRef.current;
    const text = draft.trim();
    if (!current || !text || sending) return;
    setSending(true);
    setSendError("");
    try {
      // Shown as sending by the `onSentPrompt` listener above.
      await sendSteeringPrompt(current, text);
      setDraft("");
    } catch {
      setSendError(t("terminal.reader.sendFailed"));
    } finally {
      setSending(false);
    }
  }, [draft, sending, t]);

  const onComposerKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (openStep) subagentUp();
      else onShowTerminal();
    }
  };

  const now = new Date();
  const dayLabels = { today: t("mobile.transcript.today"), yesterday: t("mobile.transcript.yesterday") };
  const cutLabel = t("terminal.reader.cut");
  const planLabel = t("mobile.transcript.plan");
  const subagentLabel = t("terminal.reader.subagent");
  const empty = transcript?.available && turns.length === 0 && pending.length === 0 && !live.question && !live.working;
  /** Where the open subagent stands among its siblings, and the conversation
   * the bar goes back up to. */
  const position = openStep ? siblingPosition(openStep) : { index: -1, count: 0 };
  const backLabel = t("mobile.subagent.back", {
    name: subagentPath.length > 1 ? subagentPath[subagentPath.length - 2].task : t("mobile.subagent.main"),
  });
  const moreEarlier = !!transcript?.available && transcript.truncated;

  return createPortal(
    <div className={`terminal-reader ${SIGN_IN_CARD_CLASS}`} role="region" aria-label={t("terminal.reader.title")}>
      {openStep ? (
        <nav className="terminal-reader-subagent-bar" aria-label={subagentLabel}>
          <button type="button" className="terminal-reader-subagent-nav" onClick={subagentUp} aria-label={backLabel} title={`${backLabel} (Esc)`}>‹</button>
          <div className="terminal-reader-subagent-title">
            <small>{openStep.role ?? subagentLabel} <UntestedTag id="terminal.reader.subagents" /></small>
            <strong title={openStep.task}>{openStep.task || openStep.role}</strong>
          </div>
          {position.count > 1 && (
            <div className="terminal-reader-subagent-steps">
              <button type="button" className="terminal-reader-subagent-nav" disabled={position.index <= 0} onClick={() => subagentSibling(-1)} aria-label={t("mobile.subagent.previous")} title={t("mobile.subagent.previous")}>‹</button>
              <span>{t("mobile.subagent.position", { index: position.index + 1, count: position.count })}</span>
              <button type="button" className="terminal-reader-subagent-nav" disabled={position.index >= position.count - 1} onClick={() => subagentSibling(1)} aria-label={t("mobile.subagent.next")} title={t("mobile.subagent.next")}>›</button>
            </div>
          )}
        </nav>
      ) : transcript?.available && (sessionAgents.length > 0 || moreEarlier) && (
        // Every subagent of the session by name — "+" while earlier turns may
        // hold more, which the list's last row reads in.
        <nav className="terminal-reader-subagent-index" aria-label={t("mobile.subagent.indexRegion")}>
          <button
            type="button"
            className="terminal-reader-subagent-toggle"
            aria-expanded={subagentListOpen}
            aria-controls={subagentListId}
            onClick={() => setSubagentListOpen((open) => !open)}
          >
            <span>{t("mobile.subagent.index", { count: `${sessionAgents.length}${moreEarlier ? "+" : ""}` })}</span>
            <UntestedTag id="terminal.reader.subagents" />
            <span className={subagentListOpen ? "terminal-reader-subagent-caret open" : "terminal-reader-subagent-caret"} aria-hidden="true">▾</span>
          </button>
          {subagentListOpen && (
            <div id={subagentListId} className="terminal-reader-subagent-list">
              {sessionAgents.map((entry, index) => (
                <button type="button" key={`${entry.at ?? ""}:${index}`} disabled={!entry.subagent} onClick={() => openAgent(entry, true)}>
                  <small>{entry.role ?? subagentLabel}</small>
                  <span>{entry.text}{entry.cut && "…"}</span>
                </button>
              ))}
              {moreEarlier && (
                <button type="button" className="terminal-reader-subagent-earlier" onClick={showEarlier}>
                  {t("mobile.subagent.earlier")}
                </button>
              )}
            </div>
          )}
        </nav>
      )}
      <div ref={listRef} className="terminal-reader-list" onScroll={onScroll}>
        {shownTranscript?.available && shownTranscript.truncated && (
          <button type="button" className="terminal-reader-earlier" onClick={showEarlier}>
            {t("terminal.reader.earlier")}
          </button>
        )}
        {openStep ? (
          !subTranscript ? <div className="terminal-reader-empty">{t("mobile.subagent.loading")}</div>
          : !subTranscript.available ? (
            <div className="terminal-reader-empty">
              <strong>{t("mobile.subagent.missing")}</strong>
              <p>{t("mobile.subagent.missingHint")}</p>
              <button type="button" className="terminal-reader-earlier" onClick={subagentUp}>{backLabel}</button>
            </div>
          )
          : turns.length === 0 && <div className="terminal-reader-empty">{t("mobile.subagent.empty")}</div>
        ) : <>
          {!transcript?.available && (
            <div className="terminal-reader-empty">{t(readerReasonKey(transcript))}</div>
          )}
          {empty && <div className="terminal-reader-empty">{t("terminal.reader.empty")}</div>}
        </>}
        {turns.map((turn, index) => {
          const moment = chatMoment(turn.stamp);
          return (
            <Fragment key={turn.key}>
              {openers.has(index) && moment && (
                <div className="terminal-reader-day" role="separator">
                  <span>{chatDayLabel(moment, now, dayLabels)}</span>
                </div>
              )}
              <Turn turn={turn} cutLabel={cutLabel} planLabel={planLabel} agentLabel={subagentLabel} use24h={use24h} onOpenAgent={openAgent} />
            </Fragment>
          );
        })}
        {!openStep && pending.map((item) => (
          <div key={item.id} className="terminal-reader-turn user pending">
            <p>{item.text}</p>
            <small className="terminal-reader-time">{t("terminal.reader.sending")}</small>
          </div>
        ))}
        <LiveQuestion live={shownLive} answered={!!answered && answered === live.signature} onAnswer={answer} />
        {live.working && (
          <div className="terminal-reader-working" role="status">
            <span className="terminal-reader-working-dots" aria-hidden="true"><i /><i /><i /></span>
            <span>{workingModel ? t("terminal.reader.workingModel", { model: workingModel }) : t("terminal.reader.working")}</span>
            {(live.working.elapsed || live.working.tokens) && (
              <small>{[live.working.elapsed, live.working.tokens && t("terminal.reader.workingTokens", { count: live.working.tokens })].filter(Boolean).join(" · ")}</small>
            )}
            <button type="button" className="terminal-reader-stop" onClick={stop} title={t("terminal.reader.stopHint")}>
              {t("terminal.reader.stop")}
            </button>
          </div>
        )}
      </div>
      {tab && (
        <TerminalReaderFacts
          tab={tab}
          ptyId={ptyId}
          agentLabel={agentLabel}
          live={live}
          modelTag={modelTag}
          usage={transcript?.available ? transcript.usage : undefined}
          visible={visible}
          typeKeys={typeIntoPane}
          onPicking={setPicking}
        />
      )}
      {!steering && <div className="terminal-reader-composer">
        <textarea
          ref={composerRef}
          value={draft}
          rows={2}
          placeholder={t("terminal.reader.placeholder")}
          aria-label={t("terminal.reader.placeholder")}
          onChange={(e) => { setDraft(e.target.value); setSendError(""); }}
          onKeyDown={onComposerKey}
        />
        <button type="button" className="terminal-reader-send" disabled={!draft.trim() || sending} onClick={() => void send()}>
          {t("terminal.reader.send")}
        </button>
      </div>}
      {sendError && !steering && <div className="terminal-reader-error" role="alert">{sendError}</div>}
    </div>,
    host,
  );
}
