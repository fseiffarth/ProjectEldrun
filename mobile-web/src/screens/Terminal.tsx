import { useT, type TranslationKey } from "../../../src/lib/i18n";
import { useMessageMenu, type HoldHandlers } from "../components/MessageMenu";
import { OptionSheet, type SheetOption } from "../components/OptionSheet";
import { SpeechLangSheet, speechLangSummary } from "../components/SpeechLangPicker";
import { OutboxGallery } from "../components/OutboxGallery";
import { OutboxViewer } from "../components/OutboxViewer";
import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  ApiError,
  api,
  attachDesktopImage,
  deleteOutboxFile,
  getAgentStatus,
  getTranscript,
  listDesktopImages,
  listOutbox,
  MAX_INBOX_FILE,
  outboxFileUrl,
  reportSentPrompt,
  uploadToInbox,
  type DesktopImage,
  type OutboxFile,
  type SessionTranscript,
  type TabRow,
} from "../api";
import { DRAFT_SAVE_DELAY, readDraft, writeDraft } from "../drafts";
import { OUTBOX_POLL, sameOutbox } from "../outbox";
import { readFlag, readTerminalView, writeFlag, writeTerminalView, type TerminalViewChoice } from "../prefs";
import { readSpeechLang, speechTag, type SpeechLang } from "../speechLang";
import { TERMINAL_PROTOCOL, TERMINAL_SIZE } from "../terminal/protocol";
import { dedentLines, dedentRows, readableRange, readableScreen, readableText, TRUNCATION_NOTICE, type ReadableLine } from "../terminal/readableScreen";
import {
  absorbHistory,
  emptyHistory,
  lastHistoryText,
  shiftHistory,
  type HistoryChunk,
} from "../terminal/readableHistory";
import { type TerminalEvent } from "../terminal/protocol";
import { installTerminalTouchScroll } from "../terminal/touchScroll";
import { installWideOutputHint, type WideOutputHint } from "../terminal/wideOutput";
import { inputFrameStart, sessionStatus, statusFrameLines, type SessionStatus } from "../terminal/statusLine";
import { sessionLimits } from "../terminal/sessionUsage";
import { installFocusSwipe } from "../terminal/focusSwipe";
import {
  mergeSelectRows,
  missingSelectRow,
  readSelectPrompt,
  sameSelectStep,
  selectKeys,
  selectMoveKeys,
  selectSignature,
  type SelectOption,
  type SelectPrompt,
  type SelectStep,
} from "../terminal/selectPrompt";
import {
  isOpenCodeTab,
  openCodePickKeys,
  readOpenCodePicker,
  OPENCODE_MODEL_KEYS,
} from "../terminal/openCodeMini";
import {
  antigravityEffortKeys,
  isAntigravityTab,
  readAntigravityEffort,
  readAntigravityPicker,
  type AntigravityEffort,
} from "../terminal/antigravity";
import { currentMode, modeChoices, modeFixed, shiftTabKey } from "../terminal/agentModes";
import { agentInputWrites, bracketsAgentMessage } from "../terminal/composer";
import { agentWork } from "../terminal/agentBusy";
import { chatTurns, isPromptEcho } from "../terminal/chatTurns";
import { answerHtml } from "../terminal/answerMarkdown";
import { commandArgsInline, slashCommand, transcriptTurns, type SlashCommand } from "../terminal/transcriptTurns";
import { MAX_PENDING, pendingPrompt, withPending, type PendingPrompt } from "../terminal/pendingPrompts";
import { afterClear, clearMark, type ClearMark } from "../terminal/clearedSession";
import { ageLabel, sizeLabel } from "../terminal/fileLabels";
import { resetText, StatusSheet } from "./StatusSheet";
import { limitMeters, parseUsageReport, type LimitMeters } from "../../../shared/usageReport";
import { isUntested } from "../../../src/lib/untested";
import { forgetSlashCommand, readSlashCommands, rememberSlashCommand, slashCli, slashSuggestions, type SlashSuggestion } from "../slashCommands";
import {
  prepareOnDeviceSpeech,
  speechRecognitionConstructor,
  speechRecognitionSupported,
  advanceDictation,
  DICTATION_START,
  dictationPreview,
  readDictation,
  settleDictation,
  type DictationProgress,
} from "../voiceInput";
import { startDictation, type DictationSession } from "../voiceSession";
import { speak, speechOutputSupported, spokenText, stopSpeaking, unlockSpeech } from "../speechOutput";

/** A line the dictation strip shows: a key, not a sentence, so switching the
 * language retranslates what is already on screen. */
/** The microphone's level goes straight onto the dictate button as a CSS
 * variable: it changes a dozen times a second, and nothing else reads it. */
function paintMicLevel(button: HTMLElement | null, level: number | null) {
  if (level === null) button?.style.removeProperty("--mic-level");
  else button?.style.setProperty("--mic-level", level.toFixed(2));
}

type VoiceNote = { key: TranslationKey; language?: string };
const PING_INTERVAL = 20_000;
/** Floor between two rebuilds of the reading view. */
const READABLE_INTERVAL = 120;
/** Two missed pongs. A half-open TCP connection — routine on cellular — leaves
 * `readyState` at OPEN indefinitely, so the socket looked connected and every
 * keystroke was silently buffered into a dead link. */
const PONG_GRACE = PING_INTERVAL * 2 + 5_000;
/** How long a pong may take after the page comes back into view. A locked
 * phone keeps its socket in the OPEN state whether or not the link behind it
 * survived, so a reader who unlocked and typed was writing into a dead link
 * for up to PONG_GRACE — the composer looked connected and nothing arrived —
 * and only leaving the tab and reopening it reconnected. On resume the link
 * is asked to prove itself within this much, and closed (which reconnects)
 * if it does not. */
const RESUME_GRACE = 4_000;
/** How often Focus re-reads the stored session while it is in view. The read
 * carries the last fingerprint, so an unchanged transcript costs one small
 * request and no turns cross the link. */
const TRANSCRIPT_POLL = 5_000;
/** How long after the screen last changed the stored session is re-read: the
 * agent writes an answer to its transcript as it prints it, so a change on
 * screen is the earliest sign that the file has moved. */
const TRANSCRIPT_SETTLE = 1_200;
/** Turns fetched at first, and added per "Show earlier turns" tap. */
const TRANSCRIPT_STEP = 120;

/** An agent TUI parses one stdin chunk as one key event: a chunk that opens with
 * a control byte is read as that keypress and the remainder is dropped, so
 * `Ctrl-A Ctrl-K <text> CR` in a single frame arrived as a bare submit with no
 * text at all. `agentInputWrites` splits a message into the pieces; these gaps
 * keep the TUI's reads from coalescing them back into one chunk — the same
 * shape the desktop uses when it types a command into an agent tab.
 *
 * They are best-effort, and that is why the submit does not depend on them: a
 * phone's link can hold the text frame back and deliver it together with the
 * carriage return, and a Codex TUI reads that one chunk as a paste and never
 * submits. Bracketed paste is what closes the message unambiguously; the gaps
 * only still carry sessions whose pane has the mode off. */
const AGENT_KEY_GAP = 80;
const AGENT_SUBMIT_GAP = 200;

/** What the new-conversation button types. Every supported scrollback agent
 * reads `/clear` as "start a new chat" — Codex too, since it grew the command.
 * Codex's own `/new` is no longer a one-keystroke act: from 0.156 it opens a
 * "Where should the new conversation run?" picker, which the button's single
 * Enter leaves waiting on the desktop (2026-09-23). */
const NEW_CONVERSATION_COMMAND = "/clear";
const CODEX_AGENT = /codex/iu;

/** Session lines the phone keeps. Matches the desktop sidecar's replay depth
 * (`pty_bridge::MOBILE_SCROLLBACK_LINES`) and the tmux `history-limit` Eldrun
 * sets on its sessions — the three are one number by design, so what tmux
 * retains is what the replay carries and what this buffer can hold. */
const PHONE_SCROLLBACK = 10_000;
/** Rows past the live screen the per-frame tail rebuild re-reads. The screen
 * itself can still be repainted by the program; the margin is slack so the
 * history absorbs nothing a repaint could reach. */
const TAIL_MARGIN = 8;
/** Frozen history chunks each "Show earlier output" tap reveals (×400 lines). */
const REVEAL_CHUNKS = 2;
/** How far from its own bottom a scroller still counts as showing the newest
 * output. Terminal view needs only the rounding slack of one fractional cell
 * height; the reading view re-wraps, so it keeps the wider window a reader's
 * own scroll already uses there. */
const NEWEST_SLACK = 4;

/** How long the model sheet waits for the session to draw the picker `/model`
 * opens. Past it the sheet steps aside: the dialog — or the reason there is
 * none — is in the session output, and the arrow keys still answer it. */
const MODEL_PICKER_WAIT = 6_000;
/** How long the sheet waits, after a tap, for the step *after* the one it
 * answered: Codex follows the model list with a reasoning-level list, and that
 * one is drawn only once the session has read the Enter. Past it the dialog is
 * done and the sheet steps aside. */
const SELECT_NEXT_WAIT = 700;
/** Time given to a Shift+Tab before the redrawn status line is read back. One
 * reading-view rebuild (READABLE_INTERVAL) plus the TUI's own repaint. */
const MODE_SETTLE = 340;
/** Shift+Tab presses one mode switch may cost. Longer than either CLI's cycle,
 * so a mode that is genuinely offered is always reached — and a mode that is
 * not ends the walk where it started. */
const MODE_CYCLE_LIMIT = 6;

const CLOSE_REASONS: Record<string, string> = {
  access_revoked: "This device's access to the session was withdrawn.",
  idle_timeout: "The session was released after a period without contact.",
  invalid_terminal_control: "The connection sent something the desktop rejected.",
  invalid_terminal_size: "The connection sent something the desktop rejected.",
  input_frame_too_large: "The last input was too large to deliver.",
  resize_failed: "The desktop could not resize the session.",
  replaced: "This session was opened on another device or tab.",
  session_busy: "Another viewer is holding this session.",
  session_gone: "This session has ended on the desktop.",
};

/** Why a phone file did not reach the project inbox, by the desktop's code. */
const UPLOAD_FAILURES: Record<string, string> = {
  file_too_large: "is larger than 24 MB.",
  empty_file: "is empty.",
  inbox_full: "did not fit — the project's inbox is full.",
  project_unavailable: "could not be saved — the project folder is unavailable.",
  tab_not_found: "could not be saved — this session's project is no longer shared.",
  timeout: "took too long to send.",
  offline: "did not reach the desktop — the connection dropped.",
  // The desktop's own refusals when the file comes from its side.
  image_not_found: "is no longer on the desktop.",
  no_clipboard_image: "is gone — the desktop's clipboard no longer holds an image.",
  project_ineligible: "could not be saved — this project is no longer shared.",
  desktop_unavailable: "could not be copied — the desktop window is not answering.",
};

/** Why the desktop could not say what it has to attach. */
const DESKTOP_LIST_FAILURES: Record<string, string> = {
  desktop_unavailable: "The desktop window is not answering.",
  tab_not_found: "This session's project is no longer shared.",
  project_ineligible: "This project is no longer shared with the phone.",
  timeout: "The desktop took too long to answer.",
  offline: "The connection dropped.",
};

/** A file on its way into the project inbox — from the phone, or copied on
 * the desktop's side — or one that did not make it. A delivered one leaves
 * the list: its `@` reference is in the draft, which is the record. */
interface InboxUpload {
  id: number;
  name: string;
  /** Where the bytes come from; a desktop copy never leaves the desktop. */
  source: "phone" | "desktop";
  failure?: string;
}

/** How often an agent tab re-reads its CLI's usage panel for the facts row's
 * 5h/week figures. The desktop answers from a 60 s cache and otherwise runs
 * the CLI once (`services::agent_usage`), so this stays well above that. */
const LIMITS_POLL = 120_000;

/** Whether two reads of the stored session carry the same turns, so an
 * unchanged answer does not repaint the view. */
function sameTranscript(a: SessionTranscript, b: SessionTranscript): boolean {
  return a.available === b.available && a.truncated === b.truncated && a.version === b.version
    && a.entries.length === b.entries.length
    && a.entries.every((entry, index) => entry.kind === b.entries[index].kind && entry.text === b.entries[index].text && entry.cut === b.entries[index].cut);
}

/** "Screenshots · 3 min ago · 1.2 MB", or "Clipboard · 1920×1080". */
function desktopImageDescription(image: DesktopImage) {
  return [
    image.source,
    image.age_secs != null ? ageLabel(image.age_secs) : "",
    image.size != null ? sizeLabel(image.size) : "",
    image.width != null && image.height != null ? `${image.width}×${image.height}` : "",
  ].filter(Boolean).join(" · ");
}

/** One logical line of the session, with the colours the program actually
 * emitted. Style is never inferred from the text — see `readableScreen`.
 *
 * `plain` keeps the emphasis and drops the palette, for the one place the
 * phone shows a line as its own text rather than as the screen: a dialog's
 * question, whose rows below it are already the phone's list (`QuestionList`).
 * A TUI paints a dialog in its own theme — Codex draws its question on a
 * near-white card — and that card transplanted into this dark view is a white
 * slab with the reading view's own type inside it. */
const ReadableRow = memo(function ReadableRow({ line, plain }: { line: ReadableLine; plain?: boolean }) {
  if (line.spans.length === 0) return <div className="readable-blank" aria-hidden="true" />;
  return <div className="readable-line">{line.spans.map((span, index) => (
    span.className || (!plain && (span.color || span.background))
      ? <span key={index} className={span.className} style={plain ? undefined : { color: span.color, background: span.background }}>{span.text}</span>
      : <span key={index}>{span.text}</span>
  ))}</div>;
});

/** More new answers than this at once is a session that was swapped in or
 * caught up on, not one that is talking: read-aloud leaves those to the eye. */
const MAX_SPOKEN_AT_ONCE = 3;

/** A block of session lines. On an agent tab they read as a chat: the
 * agent's turns on the left as printed, each prompt the user submitted as a
 * bubble on the right — the TUI's own echo of it, see `chatTurns`. A shell has
 * no turns and paints flat. Memoized on the `lines` reference: a frozen
 * history chunk and the open chunk keep theirs, so the per-frame rebuild of
 * the live tail costs nothing for however much history is on screen. */
const ReadableTurns = memo(function ReadableTurns({ lines, chat, agent, promptLabel, columns = 0 }: {
  lines: readonly ReadableLine[];
  chat: boolean;
  agent?: string;
  promptLabel: string;
  /** The pane's width, for a CLI that wrapped its own rows against it. */
  columns?: number;
}) {
  const { hold, menu } = useMessageMenu();
  if (!chat) return <>{lines.map((line) => <ReadableRow key={line.key} line={line} />)}</>;
  return <>{chatTurns(lines, agent, columns).map((turn) => {
    const shown = turn.role === "user" ? (turn.prompt ?? turn.lines) : (turn.answer ?? turn.lines);
    const rows = shown.map((line) => <ReadableRow key={line.key} line={line} />);
    // A message is a bubble — a prompt or an answer; tool output and raw
    // screen rows are not one, and a hold on them opens nothing.
    const press = turn.role === "user" || turn.answer ? hold(`screen:${turn.key}`, () => readableText(shown)) : undefined;
    const command = turn.role === "user" ? slashCommand(readableText(shown)) : null;
    if (command) return <Fragment key={turn.key}><CommandDivider command={command} label={promptLabel} press={press} /></Fragment>;
    return turn.role === "user"
      ? <div key={turn.key} className="readable-turn user" role="group" aria-label={promptLabel} data-prompt={readableText(shown)} {...press}>{rows}</div>
      : <div key={turn.key} className={turn.answer ? "readable-turn agent answer" : "readable-turn agent"} {...press}>{rows}</div>;
  })}{menu}</>;
});

/** A slash command the reader sent (`slashCommand`): the command itself is
 * a turn of the CLI's own dial, so its name reads as a rule across the chat.
 * A one-word setting rides on the rule (`/model opus`); the text of a `/goal`
 * or `/plan` is the reader's own words, so it follows as an ordinary prompt
 * bubble. Both keep the prompt's hold menu. */
function CommandDivider({ command, label, press }: {
  command: SlashCommand;
  label: string;
  press?: HoldHandlers;
}) {
  const inline = commandArgsInline(command.args);
  return <>
    <div className="readable-command" role="separator" aria-label={label} data-prompt={command.args ? `${command.name} ${command.args}` : command.name} {...press}>
      <span className="readable-command-text">{inline && command.args ? `${command.name} ${command.args}` : command.name}</span>
    </div>
    {!inline && <div className="readable-turn user command-args" role="group" aria-label={label} {...press}>
      <p className="transcript-text">{command.args}</p>
    </div>}
  </>;
}

/** One answer of the stored session as formatted text (`answerHtml`: the
 * formatting only — nothing in it opens or loads). Memoized on the text, so a
 * poll that brings a new turn does not re-render every answer above it. */
const AnswerText = memo(function AnswerText({ text }: { text: string }) {
  const html = useMemo(() => answerHtml(text), [text]);
  return <div className="transcript-md" dangerouslySetInnerHTML={{ __html: html }} />;
});

/** The prompts and answers of the stored session (`api.getTranscript`), laid
 * out the same way as the screen's chat — bubbles on the right for the
 * reader's own prompts, the agent's answers on the left — from the record the
 * agent itself keeps, which reaches back past the pane's scrollback and
 * carries no tool status. `cut` marks text the desktop bounded. */
const TranscriptTurns = memo(function TranscriptTurns({ entries, cutLabel, promptLabel }: {
  entries: SessionTranscript["entries"];
  cutLabel: string;
  promptLabel: string;
}) {
  // One bubble per record, keyed by its time (`transcriptTurns`).
  const turns = useMemo(() => transcriptTurns(entries), [entries]);
  const { hold, menu } = useMessageMenu();
  return <>{turns.map((turn) => <Fragment key={turn.key}>
    {turn.command
      ? <CommandDivider command={turn.command} label={promptLabel} press={hold(turn.key, () => turn.text)} />
      : turn.kind === "prompt"
      ? <div className="readable-turn user" role="group" aria-label={promptLabel} data-prompt={turn.text} {...hold(turn.key, () => turn.text)}>
          <p className="transcript-text">{turn.text}</p>
          {turn.cut && <small className="transcript-cut">{cutLabel}</small>}
        </div>
      : <div className="readable-turn agent answer" {...hold(turn.key, () => turn.text)}>
          <AnswerText text={turn.text} />
          {turn.cut && <small className="transcript-cut">{cutLabel}</small>}
        </div>}
  </Fragment>)}{menu}</>;
});

/** The stored preference key for a tab: the agent behind it, or the shell. */
function viewAgentOf(tab: TabRow): string {
  return tab.kind === "agent" ? (tab.agent_label ?? "agent") : "shell";
}

/** The view a tab opens in: the reader's last choice for its agent, else Focus
 * on an agent tab — the stored session is the one reading of it that holds
 * whole turns — and Terminal on a shell. A Focus nobody chose hands over to
 * Terminal once the session turns out not to read (see `viewChosen`). */
function initialView(tab: TabRow): TerminalViewChoice {
  return readTerminalView(viewAgentOf(tab)) ?? (tab.kind === "agent" ? "focus" : "terminal");
}

/** Why an agent tab's stored session is not shown, for the dimmed toggle. */
function noSessionReason(transcript: SessionTranscript | null): TranslationKey {
  if (!transcript) return "mobile.focus.sessionLoading";
  switch (transcript.reason) {
    case "unsupported": return "mobile.focus.sessionUnsupported";
    case "no_session": return "mobile.focus.sessionNoId";
    case "no_transcript": return "mobile.focus.sessionMissing";
    default: return "mobile.focus.sessionUnreadable";
  }
}

/**
 * The question the session is waiting on, as a phone list: the dialog's own
 * rows, under the number it printed beside each one, each a tap that answers
 * it. It sits inline in the reading view rather than in a sheet — the question
 * is part of the conversation, and a modal over it would hide what it asks.
 *
 * Like `OptionSheet` it renders what the caller resolved and reports taps
 * back: no parsing, no keystrokes. The row the dialog highlights is marked as
 * the one Enter would take, not as an answer already given.
 */
/** A range of read lines without the blank rows at its ends — the gutter a
 * dialog leaves around its own text, which is a paragraph break only when
 * there is something on both sides of it. */
function withoutEdgeBlanks(lines: readonly ReadableLine[]): ReadableLine[] {
  let first = 0;
  let end = lines.length;
  while (first < end && lines[first].text === "") first += 1;
  while (end > first && lines[end - 1].text === "") end -= 1;
  return lines.slice(first, end);
}

function QuestionList({ prompt, question, sent, sendingLabel, onPick }: {
  prompt: SelectPrompt;
  /** The dialog's own question — the lines `prompt.question` points at. It is
   * the list's heading here, so it is shown in the reading view's own voice
   * (`plain`): a TUI paints its dialog in its own theme, and Codex's light
   * card dropped into this dark view is a white slab. */
  question: readonly ReadableLine[];
  /** The printed number of the row a tap answered with, while the session has
   * not redrawn yet: that row says so, and no row can be tapped again. */
  sent?: number;
  sendingLabel: string;
  onPick: (option: SelectOption) => void;
}) {
  return <>
    {question.length > 0 && <div className="question-ask">
      {question.map((line) => <ReadableRow key={line.key} line={line} plain />)}
    </div>}
    <ul className="option-list question-list">{prompt.options.map((option) => <li key={option.number}>
      <button
        className={option.index === prompt.current ? "current" : ""}
        aria-current={option.index === prompt.current || undefined}
        disabled={sent !== undefined}
        onClick={() => onPick(option)}>
        <span className="question-number" aria-hidden="true">{option.number}</span>
        <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
        {sent === option.number && <span className="sheet-pending" role="status">{sendingLabel}</span>}
      </button>
    </li>)}</ul>
  </>;
}

/** `pickModel`: the tab card's model was tapped, so the session opens with its
 * model picker already up — once, as soon as the session has drawn. */
export function Terminal({ tab, back, pickModel = false }: { tab: TabRow; back: () => void; pickModel?: boolean }) {
  const t = useT();
  const host = useRef<HTMLDivElement>(null);
  const wideHint = useRef<HTMLDivElement>(null);
  const readableHost = useRef<HTMLElement>(null);
  const composerInput = useRef<HTMLTextAreaElement>(null);
  /** Re-reads the emulated screen on demand — used when Focus is opened, so the
   * reading view is current instead of waiting for the next output byte. */
  const refreshReadable = useRef<() => void>(() => {});
  const write = useRef<(value: string) => boolean>(() => false);
  const recognition = useRef<DictationSession>();
  const dictateButton = useRef<HTMLButtonElement>(null);
  const connectedRef = useRef(false);
  const voiceRequest = useRef(0);
  const voiceProgress = useRef<DictationProgress>(DICTATION_START);
  const copiedTimer = useRef<number>();
  const sendTimers = useRef<number[]>([]);
  /** Whether the attached pane has bracketed paste on right now. xterm tracks
   * the mode from the same stream it renders, and tmux forwards the pane's
   * DECSET 2004 to every client, so the phone knows what the agent supports
   * without asking the desktop. */
  const bracketedPaste = useRef<() => boolean>(() => false);
  const [viewportHeight, setViewportHeight] = useState<number>();
  const [connected, setConnected] = useState(false);
  const [stoppedReason, setStoppedReason] = useState("");
  const [altScreen, setAltScreen] = useState(false);
  /** The alternate screen's visible frame, on an agent tab. It is not session
   * output — it is repainted whole and has no scrollback behind it — so it
   * reaches neither the reading view nor the history; it is read for the two
   * facts only the live screen carries: the choice the session is waiting on,
   * and whether its turn is still running. */
  const [altFrame, setAltFrame] = useState<ReadableLine[]>([]);
  const [ctrl, setCtrl] = useState(false);
  const [sendFailed, setSendFailed] = useState(false);
  /** `initialView`: the reader's choice for this agent, else Focus on an
   * agent tab and Terminal on a shell. */
  const [view, setView] = useState<TerminalViewChoice>(() => initialView(tab));
  /** Whether `view` is the reader's own choice. Only a default Focus falls
   * back to Terminal when the stored session does not read; a Focus the
   * reader picked stays, reading the screen instead. */
  const viewChosen = useRef(readTerminalView(viewAgentOf(tab)) !== null);
  const chooseView = (next: TerminalViewChoice) => {
    viewChosen.current = true;
    setView(next);
    writeTerminalView(viewAgentOf(tab), next);
  };
  /** The composer's text, restored from the phone's own store (`drafts.ts`):
   * leaving for the tab list unmounts this screen and the phone cold-starts the
   * PWA whenever it likes, and a message half-typed on the way to the desk was
   * gone by the time the reader came back to finish it. */
  const [draft, setDraft] = useState(() => readDraft(tab.id));
  /** The draft as it stands, for the two writers below — neither of them may
   * re-subscribe per keystroke. */
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [lines, setLines] = useState<ReadableLine[]>([]);
  const [clipped, setClipped] = useState(false);
  /** The screen the live readers look at: the scrollback's tail, or — while a
   * fullscreen agent draws on the alternate screen — the frame it is holding.
   * Everything read off the screen rather than out of the stored session (the
   * status facts, the model picker, the question waiting on the reader,
   * whether the turn is still running) reads this. The reading view and the
   * history never do: an alternate screen has no scrollback to grow them
   * from. */
  const liveScreen = useMemo(() => (altScreen ? altFrame : lines), [altScreen, altFrame, lines]);
  /** The absorbed earlier output, republished for render whenever it grows.
   * The log itself lives in a ref inside the terminal effect; this is only the
   * render snapshot (chunk references are stable, so revealing is cheap). */
  const [earlier, setEarlier] = useState<{ chunks: HistoryChunk[]; open: ReadableLine[]; dropped: boolean }>(
    { chunks: [], open: [], dropped: false },
  );
  /** How many frozen chunks are revealed above the open chunk + tail. */
  const [revealed, setRevealed] = useState(1);
  /** Scroll position captured when revealing, so prepended lines do not shove
   * the text the reader was looking at (WebKit has no overflow-anchor). */
  const revealAnchor = useRef<{ height: number; top: number }>();
  const [atBottom, setAtBottom] = useState(true);
  /** `atBottom`, readable from a callback that must not resubscribe to see it
   * change — the reading view's resize observer below. */
  const atBottomRef = useRef(true);
  const followReadable = (value: boolean) => {
    atBottomRef.current = value;
    setAtBottom(value);
  };
  /** The reader's newest prompt while its bubble is scrolled off the top of
   * Focus, pinned there so the answer below is read against the question
   * that asked for it; empty while the bubble itself is in view. Read off
   * the chat as drawn (`data-prompt`), so the stored session and the screen
   * reading pin alike. */
  const [pinnedPrompt, setPinnedPrompt] = useState("");
  const pinnedPromptEl = useRef<HTMLElement | null>(null);
  const checkPinnedPrompt = useCallback(() => {
    const stream = readableHost.current;
    const prompts = stream?.querySelectorAll<HTMLElement>("[data-prompt]");
    const last = prompts && prompts.length > 0 ? prompts[prompts.length - 1] : null;
    // A bubble with no height is one not laid out (a hidden page), not one
    // scrolled away.
    const box = last?.getBoundingClientRect();
    const above = !!stream && !!box && box.height > 0 && box.bottom <= stream.getBoundingClientRect().top;
    pinnedPromptEl.current = above ? last : null;
    setPinnedPrompt(above ? (last?.dataset.prompt ?? "").trim() : "");
  }, []);
  /** Whether Terminal view is panned to the newest rows. Kept from the box's
   * own scroll events rather than measured when it is wanted: a resize is the
   * moment the answer is needed and the moment it is already gone, because
   * shrinking the box raises its maximum scroll offset without moving
   * `scrollTop` — the bottom slides under the composer and the box reads as
   * scrolled up ever after. */
  const atNewest = useRef(true);
  const [lastSent, setLastSent] = useState("");
  /** The CLI this tab runs, as the composer's `/` menu keys its store, and the
   * slash commands this phone has sent that CLI before (`slashCommands.ts`). */
  const slashCliKey = slashCli(tab.agent_label ?? tab.label);
  const [usedSlash, setUsedSlash] = useState(() => readSlashCommands(slashCliKey));
  const [copied, setCopied] = useState(false);
  const [voiceAvailable] = useState(() => speechRecognitionSupported());
  const [speechAvailable] = useState(() => speechOutputSupported());
  const [listening, setListening] = useState(false);
  const [preparingVoice, setPreparingVoice] = useState(false);
  const [voicePreview, setVoicePreview] = useState("");
  const [voiceStatus, setVoiceStatus] = useState<VoiceNote | null>(null);
  const [voiceFailure, setVoiceFailure] = useState<VoiceNote | null>(null);
  /** Whether the model sheet is up. It opens on the tap that sends `/model`,
   * before the session has drawn the picker it lists. */
  const [modelSheet, setModelSheet] = useState(false);
  /** The step a tap answered, while the session is still painting it. A
   * multi-step dialog draws its next list in the same place, so the sheet
   * holds until what is on screen is a *different* list (`sameSelectStep`) —
   * or until nothing is, which is where the dialog ends. */
  const [answered, setAnswered] = useState<SelectStep | null>(null);
  /** Every row of the step on screen seen since the sheet opened. A windowed
   * picker (Claude Code's, at 24 lines, draws three of its five models) is
   * only ever a slice, so the list is what the slices add up to. */
  const [knownStep, setKnownStep] = useState<SelectStep | null>(null);
  /** The walk that makes a windowed picker draw the rows it hides: the row the
   * highlight started on, and the row the last arrow keys were sent to. The
   * highlight goes back where it was once every row is listed. */
  const [reveal, setReveal] = useState<{ origin: number; target: number } | null>(null);
  /** A walk whose keys never showed on screen is not tried again until the
   * sheet reopens; the rows already seen stay listed. */
  const revealStuck = useRef(false);
  /** Antigravity keeps the model and its effort on one dialog, and draws the
   * effort slider only for the row its highlight is on: the model a tap chose,
   * while the highlight is still walking there. Nothing is accepted until the
   * walk lands and the effort it then offers has been read. */
  const [effortFor, setEffortFor] = useState<{ number: number; label: string } | null>(null);
  /** The model the sheet is asking the effort for, once the walk has landed. */
  const [effortStep, setEffortStep] = useState<string | null>(null);
  const [modeSheet, setModeSheet] = useState(false);
  /** The status chip's sheet: the session's state and the CLI's own usage
   * panel. Opening it asks the desktop, which may run the CLI once. */
  const [statusSheet, setStatusSheet] = useState(false);
  /** The account's session (5h) and weekly windows, read off the same usage
   * panel the status sheet shows — the facts row prints them beside the
   * context figure. Empty until a read answers or for a CLI without one. */
  const [limits, setLimits] = useState<LimitMeters>({});
  /** The composer's **+**: a phone file into the project inbox, an image
   * already on the desktop, or an `@`. */
  const [addSheet, setAddSheet] = useState(false);
  /** The "From the desktop" list: `null` while the desktop is being asked. */
  const [desktopSheet, setDesktopSheet] = useState(false);
  const [desktopImages, setDesktopImages] = useState<DesktopImage[] | null>(null);
  const [desktopFailure, setDesktopFailure] = useState("");
  const [uploads, setUploads] = useState<InboxUpload[]>([]);
  /** The pictures the agent left in the project's `.eldrun/outbox/` for this
   * phone (the desktop's `outbox.rs`), newest first — the gallery beside the
   * tab name, and the one way an image reaches the phone from a session: a
   * terminal carries none, and Focus classifies nothing, so a path printed
   * by the agent is never guessed at. */
  const [outbox, setOutbox] = useState<OutboxFile[]>([]);
  /** This screen reads the project's outbox through its own tab — the project
   * screen reads the same files through the project (`OutboxScope`). */
  const outboxScope = useMemo(() => ({ tab: tab.id }), [tab.id]);
  /** The pictures among them, which the full-screen viewer steps through. */
  const outboxPictures = useMemo(() => outbox.filter((file) => file.kind.startsWith("image/")), [outbox]);
  /** Whether the gallery sheet is up (the button beside the tab name). */
  const [gallery, setGallery] = useState(false);
  /** The picture open full-screen. */
  const [outboxOpen, setOutboxOpen] = useState<OutboxFile | null>(null);
  /** The stored session behind an agent tab (`getTranscript`): `null` until
   * the first read answers. Focus reads from it whenever it is available and
   * the reader has not switched the view to the screen. */
  const [transcript, setTranscript] = useState<SessionTranscript | null>(null);
  /** Prompts the composer sent that the stored session does not hold yet,
   * shown as the reader's bubbles at the end of the session chat. */
  const [pending, setPending] = useState<PendingPrompt[]>([]);
  const pendingId = useRef(0);
  /** Where the stored session stood when this phone cleared it
   * (`clearedSession.ts`): until the new chat has a transcript of its own, what
   * the desktop answers with is the conversation just cleared. */
  const [clearedAt, setClearedAt] = useState<ClearMark | null>(null);
  /** The new-conversation button was tapped while Codex worked — Codex refuses
   * `/clear` then, and says so only on the desktop's screen. */
  const [clearRefused, setClearRefused] = useState(false);
  const liveBusy = useMemo(() => agentWork(liveScreen) !== null, [liveScreen]);
  // Once the turn is over the button works again; the note goes with it.
  useEffect(() => { if (clearRefused && !liveBusy) setClearRefused(false); }, [clearRefused, liveBusy]);
  const [focusSource, setFocusSource] = useState<"session" | "screen">("session");
  const [readAloud, setReadAloud] = useState(() => readFlag("focusReadAloud"));
  const [voiceRemote, setVoiceRemote] = useState(() => readFlag("voiceRemote"));
  /** Only a phone with an on-device recognizer for the dictation language has
   * anything to choose. Android's Chrome has the API but no model, so `available`
   * existing is not enough: without the probe the menu offered a choice the
   * phone ignored, dictating with its speech service either way. */
  const [voiceLocalOffered, setVoiceLocalOffered] = useState(false);
  /** The language read-aloud and dictation use, and whether its picker is
   * open. Only the picker reads this state — the speaking and listening sites
   * ask `speechTag()` for the stored value at the moment they need it, so a
   * change reaches them without a re-render of anything. */
  const [speechLang, setSpeechLang] = useState<SpeechLang>(() => readSpeechLang());
  const [speechLangSheet, setSpeechLangSheet] = useState(false);
  useEffect(() => {
    const Recognition = speechRecognitionConstructor();
    if (!Recognition?.available) {
      setVoiceLocalOffered(false);
      return;
    }
    let live = true;
    Recognition.available({ langs: [speechTag()], processLocally: true, quality: "dictation" })
      .then((availability) => { if (live) setVoiceLocalOffered(availability !== "unavailable"); })
      .catch(() => { if (live) setVoiceLocalOffered(false); });
    return () => { live = false; };
  }, [speechLang]);
  /** Whether the list under the Focus button is open: where an agent tab's
   * Focus reads from, the stored session or the screen. A dimmed Session row
   * says why it cannot be read — a phone shows no tooltip. */
  const [focusMenu, setFocusMenu] = useState(false);
  /** Whether Focus shows the strip with the rows the agent draws under its
   * input box (cwd, model, mode, context…). A left→right swipe opens it, a
   * right→left swipe or its ✕ closes it; never persisted. */
  const [statusStrip, setStatusStrip] = useState(false);
  /** Turns asked for; grows with "Show earlier turns". */
  const [transcriptLimit, setTranscriptLimit] = useState(TRANSCRIPT_STEP);
  /** Bumped by every change of the screen: the settle timer re-reads the
   * session after it. */
  const [screenTick, setScreenTick] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  /** The same drop, restricted to pictures and videos: an `accept` of media
   * types is what makes Android open the photo picker (and iOS the library)
   * instead of the file browser a bare file input lands in. */
  const galleryInput = useRef<HTMLInputElement>(null);
  /** Bumped when the tab changes so a late upload result lands nowhere. */
  const uploadRun = useRef(0);
  const uploadSeq = useRef(0);
  /** The reading view as it stood when a composer sheet opened. While the
   * sheet is up the session repaints under it — the `/model` picker, a status
   * line per Shift+Tab — and that churn is the sheet's *input*, not something
   * to read: the sheet lists the picker and confirms the walk from the live
   * `lines`; what is painted behind it stays still. */
  const [frozenLines, setFrozenLines] = useState<ReadableLine[] | null>(null);
  const linesRef = useRef<ReadableLine[]>([]);
  linesRef.current = lines;
  /** The pane's width in columns, as the session sees it. A CLI that wraps its
   * own output — OpenCode does — wrapped it against exactly this, which is
   * what lets the reading view put those rows back together and re-wrap them
   * at the phone's width. Carried in a ref: it changes with the pane, not with
   * the frame, and every reader of it re-runs on `lines` anyway. */
  const paneColumns = useRef(0);
  /** The mode a Shift+Tab walk is currently trying to reach. */
  const [switching, setSwitching] = useState("");
  /** A mode the walk went a full cycle without reaching. */
  const [switchFailed, setSwitchFailed] = useState("");
  /** Whether the picker was ever on screen while the model sheet was open —
   * only then does its disappearance mean the dialog is done. */
  const sawPicker = useRef(false);
  /** Cancels an in-flight mode walk when the tab changes or the user picks
   * again; the walk reads the status line between presses. */
  const modeWalk = useRef(0);
  const statusRef = useRef<SessionStatus | null>(null);

  useEffect(() => {
    setView(initialView(tab));
    viewChosen.current = readTerminalView(viewAgentOf(tab)) !== null;
    // The draft is the tab's, not the screen's: this tab's own half-typed
    // message, which is nothing at all for most of them (`drafts.ts`).
    setDraft(readDraft(tab.id));
    setTranscript(null);
    setPending([]);
    setClearedAt(null);
    setClearRefused(false);
    setFocusSource("session");
    setFocusMenu(false);
    setStatusStrip(false);
    setTranscriptLimit(TRANSCRIPT_STEP);
    setLines([]);
    setClipped(false);
    setEarlier({ chunks: [], open: [], dropped: false });
    setRevealed(1);
    followReadable(true);
    atNewest.current = true;
    setLastSent("");
    setCopied(false);
    setStoppedReason("");
    setAltScreen(false);
    setAltFrame([]);
    setCtrl(false);
    setSendFailed(false);
    setModelSheet(false);
    setModeSheet(false);
    setStatusSheet(false);
    setLimits({});
    setAddSheet(false);
    setDesktopSheet(false);
    setUploads([]);
    uploadRun.current += 1;
    setSwitching("");
    setSwitchFailed("");
    setAnswered(null);
    setKnownStep(null);
    setReveal(null);
    sawPicker.current = false;
    // Dictation belongs to the tab it was started in. Its recognizer is aborted
    // by the effect beside `startVoice` with the handlers detached first, so no
    // `onend` ever arrives to take the old tab's words and "listening" down.
    voiceProgress.current = DICTATION_START;
    setVoicePreview("");
    setVoiceStatus(null);
    setVoiceFailure(null);
    setListening(false);
    setPreparingVoice(false);
    return () => {
      window.clearTimeout(copiedTimer.current);
      sendTimers.current.forEach(window.clearTimeout);
      sendTimers.current = [];
      // Abandons a mode walk still waiting between two Shift+Tabs.
      modeWalk.current += 1;
    };
  }, [tab.id]);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const syncHeight = () => setViewportHeight(viewport.height);
    syncHeight();
    viewport.addEventListener("resize", syncHeight);
    return () => viewport.removeEventListener("resize", syncHeight);
  }, []);

  // The one full-bleed screen has to be the one screen the *document* cannot
  // scroll. `body` keeps a 100dvh floor for the scrolling sections while this
  // screen is sized to the visual viewport, so the document is taller than what
  // is on glass — and everything a phone does about that is a scroll that takes
  // the header with it. Three ways in practice: arriving from the bottom of a
  // long project screen, or from far down the agents list, keeps that scroll
  // offset; focusing the composer makes the browser
  // scroll the header away to seat the keyboard; and an agent tab has its own
  // way in, because `addContext` and the two attach paths focus the composer
  // *for* the reader, so the scroll arrives unasked after a tap on the ＋ sheet.
  // The header carries the back chevron, and the body below it eats
  // vertical drags (`touch-action:none` plus the drag handler in
  // terminal/touchScroll.ts), so once it is off screen there is no way back to
  // the project at all. Take the overflow away for as long as the terminal is
  // mounted — and pull the page back up first, since hiding the overflow under a
  // scrolled document leaves it scrolled, which is the same trap with no scroll
  // bar left to escape it.
  useLayoutEffect(() => {
    if (window.scrollY !== 0) window.scrollTo(0, 0);
    document.body.classList.add("terminal-open");
    return () => document.body.classList.remove("terminal-open");
  }, []);


  useEffect(() => {
    if (!host.current) return;
    const term = new XTerm({
      // The rendered terminal is an output and scroll surface. Text always
      // comes from the native composer below, which is more reliable on phone
      // keyboards and keeps accidental taps from editing a live agent prompt.
      disableStdin: true,
      cursorBlink: false,
      cursorStyle: "bar",
      cursorInactiveStyle: "bar",
      cursorWidth: 2,
      fontSize: 14,
      scrollback: PHONE_SCROLLBACK,
      // A shell/agent prompt remains part of PTY output, but it must not look
      // like an editable field on the phone.
      theme: { background: "#0b0d13", foreground: "#e7e9f2", cursor: "#0b0d13", cursorAccent: "#0b0d13" },
    });
    const fit = new FitAddon(); term.loadAddon(fit); term.open(host.current); fit.fit();
    bracketedPaste.current = () => term.modes.bracketedPasteMode === true;
    // The history log needs to know when xterm trims scrollback (row indices
    // shift), and xterm has no public event for it — so this rides the internal
    // buffer list's own trim emitter, guarded: when a future xterm renames it,
    // the view falls back to the bounded whole-screen rebuild instead of
    // showing wrong lines.
    const history = emptyHistory();
    type TrimEvent = (listener: (amount: number) => void) => { dispose(): void };
    const trimEventOf = () => (term as unknown as {
      _core?: { _bufferService?: { buffers?: { normal?: { lines?: { onTrim?: TrimEvent } } } } };
    })._core?._bufferService?.buffers?.normal?.lines?.onTrim;
    let trimWatch: { dispose(): void } | undefined;
    // `term.reset()` — the replay boundary below — builds a *new* normal
    // buffer, and a listener on the old one's trim emitter then never fires
    // again. Left as it was, the first reconnect silently detached the log from
    // trims: once the 10k scrollback filled, `history.end` stopped following the
    // buffer and the absorbed rows drifted onto the wrong lines. Re-armed after
    // every reset instead.
    const watchTrim = () => {
      trimWatch?.dispose();
      const trimEvent = trimEventOf();
      trimWatch = typeof trimEvent === "function"
        ? trimEvent((amount) => shiftHistory(history, amount))
        : undefined;
    };
    watchTrim();
    const resetHistory = () => {
      history.chunks = [];
      history.open = [];
      history.end = 0;
      history.droppedLines = 0;
      history.lost = false;
      setEarlier({ chunks: [], open: [], dropped: false });
    };
    let readableFrame = 0;
    let readableScrollFrame = 0;
    let readableTimer = 0;
    let lastReadable = 0;
    const renderReadable = () => {
      const buffer = term.buffer?.active;
      if (!buffer) return;
      paneColumns.current = term.cols;
      const stream = readableHost.current;
      // The reading view is unmounted in Terminal view. A shell tab has no
      // other reader of these lines, so re-reading the screen there is pure
      // waste on a phone battery — but an agent tab's model and mode facts still do:
      // the mode walk confirms every Shift+Tab against the redrawn status line
      // and the model sheet lists the picker, both from `lines`. Left stale in
      // Terminal view, a walk pressed its full lap and reported a failure on a
      // session that had switched on the second press. The lazy history keeps
      // this to the live tail, so the rebuild is cheap; only the scroll follow
      // needs the stream.
      if (!stream && tab.kind !== "agent") return;
      lastReadable = Date.now();
      const followOutput = stream != null && stream.scrollHeight - stream.scrollTop - stream.clientHeight < 120;
      // The alternate screen has no scrollback, so the reading view would show
      // only the visible frame, rebuild it on every redraw, and lose the lot
      // when the program exits. Say so instead of showing a collapsing view —
      // and never absorb its frames into the history: they are a full-screen
      // program's repaints, not session output.
      const alternate = buffer.type === "alternate";
      setAltScreen(alternate);
      if (alternate) {
        // An agent CLI can draw its whole session here — Claude Code does under
        // `"tui": "fullscreen"`, OpenCode's full TUI always — and then a
        // question it is waiting on sits on this frame and nowhere else: the
        // stored session only grows at message boundaries, and there is no
        // scrollback the reading view could grow from. So the frame is read for
        // the live readers, and still absorbed nowhere.
        if (tab.kind === "agent") setAltFrame(readableScreen(buffer).lines);
        return;
      }
      setAltFrame((held) => (held.length > 0 ? [] : held));
      if (trimWatch) {
        // Rows that left the tail window are converted once and kept; only the
        // tail — the live screen plus a margin — is re-read per frame.
        const grew = absorbHistory(buffer, history, term.rows + TAIL_MARGIN);
        const tail = readableRange(buffer, history.end, buffer.length, lastHistoryText(history));
        while (tail.length > 0 && tail[tail.length - 1].text === "") tail.pop();
        setLines(tail);
        if (grew) {
          setEarlier({
            chunks: [...history.chunks],
            open: history.open,
            dropped: history.droppedLines > 0 || history.lost,
          });
        }
        setClipped(false);
      } else {
        const screen = readableScreen(buffer);
        setLines(screen.lines);
        setClipped(screen.clipped);
      }
      if (stream && followOutput) {
        cancelAnimationFrame(readableScrollFrame);
        readableScrollFrame = requestAnimationFrame(() => {
          stream.scrollTo({ top: stream.scrollHeight });
          followReadable(true);
        });
      }
    };
    // A busy agent repaints many times a second. Rebuilding the reading view on
    // every one of those frames burned battery and made the text jitter under a
    // reader's eyes without adding anything they could follow.
    const updateReadable = () => {
      if (readableTimer) return;
      const wait = Math.max(0, READABLE_INTERVAL - (Date.now() - lastReadable));
      readableTimer = window.setTimeout(() => {
        readableTimer = 0;
        cancelAnimationFrame(readableFrame);
        readableFrame = requestAnimationFrame(() => {
          renderReadable();
          // The tick's one reader is the session settle read, which only an
          // agent tab has (`sessionFocus`). On a shell tab in Terminal view
          // `renderReadable` changes no state, so bumping it anyway re-rendered
          // this whole screen ~8×/s for as long as a command streamed.
          if (tab.kind === "agent") setScreenTick((tick) => tick + 1);
        });
      }, wait);
    };
    refreshReadable.current = updateReadable;
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    let ws: WebSocket | null = null;
    let stopped = false;
    let reconnectTimer: number | undefined;
    let reconnectAttempt = 0;
    let lastPong = 0;
    /** Pongs received on the current socket — what the resume check compares,
     * since two timestamps in one millisecond would read as no pong. */
    let pongs = 0;
    // Returns whether the bytes were handed to an open socket. Callers that
    // confirm something to the user must not claim success on a `false`.
    write.current = (value) => {
      if (ws?.readyState !== WebSocket.OPEN) return false;
      ws.send(new TextEncoder().encode(value));
      return true;
    };
    // tmux sizes a window to its widest client and pans every narrower one
    // across it. Adopting the window geometry the server reports is what keeps
    // the phone from receiving a silently cropped, cursor-following slice; the
    // offscreen emulator's column count never had to match the physical screen.
    let windowSize: { cols: number; rows: number } | undefined;
    let wide: WideOutputHint | undefined;
    let anchorFrame = 0;
    // The screen is as tall as the desktop window, so on a phone its last rows
    // — the live prompt and the newest output — sit below the fold. Show that
    // end of it; the rows above are one drag away (terminal/touchScroll.ts).
    // Deferred a frame because xterm sizes the screen element on its own
    // render, after this returns.
    const anchorNewest = () => {
      cancelAnimationFrame(anchorFrame);
      anchorFrame = requestAnimationFrame(() => {
        const box = host.current;
        if (box) box.scrollTop = box.scrollHeight;
        atNewest.current = true;
        wide?.sync();
      });
    };
    const applySize = () => {
      const rows = term.rows;
      if (windowSize) {
        if (term.cols !== windowSize.cols || term.rows !== windowSize.rows) {
          term.resize(windowSize.cols, windowSize.rows);
        }
      } else {
        fit.fit();
        // Without a window frame the fitted size is what goes to the desktop,
        // and a size outside the protocol's bounds is answered with a close
        // that never retries. A landscape phone with its keyboard up fits fewer
        // rows than the floor; clamp to what the desktop accepts.
        const cols = Math.min(TERMINAL_SIZE.maxCols, Math.max(TERMINAL_SIZE.minCols, term.cols));
        const rows = Math.min(TERMINAL_SIZE.maxRows, Math.max(TERMINAL_SIZE.minRows, term.rows));
        if (cols !== term.cols || rows !== term.rows) term.resize(cols, rows);
      }
      // A changed row count moves the view, and so does a box that was showing
      // the newest rows before this resize — the keyboard opening and the
      // composer growing both shrink it, and without this the live prompt and
      // the newest output slide under the composer and stay there. A reader
      // panned up into the screen keeps their place through either.
      if (term.rows !== rows || atNewest.current) anchorNewest();
      wide?.sync();
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      }
    };
    const connect = () => {
      if (stopped) return;
      const next = new WebSocket(`${scheme}://${location.host}/api/v1/tabs/${tab.id}/terminal`, TERMINAL_PROTOCOL);
      ws = next;
      next.binaryType = "arraybuffer";
      next.onopen = () => {
        if (stopped || ws !== next) return;
        reconnectAttempt = 0;
        connectedRef.current = true;
        lastPong = Date.now();
        pongs = 0;
        setConnected(true);
        setSendFailed(false);
        // A retryable close (`idle_timeout`) explained itself and then
        // reconnected; the explanation must not outlive the outage, or it sat
        // over the composer for the rest of the session.
        setStoppedReason("");
        next.send(JSON.stringify({ type: "ready" }));
        applySize();
      };
      // An error is always followed by `close`, which does the reconnecting;
      // this exists so the failure is not an unhandled event.
      next.onerror = () => {
        if (ws === next) connectedRef.current = false;
      };
      next.onclose = () => {
        if (stopped || ws !== next) return;
        connectedRef.current = false;
        voiceRequest.current += 1;
        setConnected(false);
        setPreparingVoice(false);
        const activeRecognition = recognition.current;
        if (activeRecognition) {
          recognition.current = undefined;
          activeRecognition.abort();
          paintMicLevel(dictateButton.current, null);
          setListening(false);
          setVoiceStatus(null);
          setVoiceFailure({ key: "mobile.voice.disconnected" });
        }
        // The server attaches to the persisted tmux session again on reconnect,
        // so its screen/history is replayed. Do not clear the local screen: it
        // keeps the last rendered state useful while a phone wakes or switches
        // between Wi-Fi and cellular.
        if (stopped) {
          term.write("\r\n\x1b[31m[Session closed by the desktop.]\x1b[0m\r\n");
          return;
        }
        term.write("\r\n\x1b[33m[Connection interrupted; reconnecting…]\x1b[0m\r\n");
        const delay = Math.min(1_000 * 2 ** reconnectAttempt, 15_000);
        reconnectAttempt += 1;
        // A session that ended on the desktop refuses the upgrade at the HTTP
        // layer, so no `closing` frame can ever say why — the phone would show
        // "reconnecting…" forever. After two straight failures, ask the tab
        // endpoint; a transient network failure keeps the reconnect loop.
        if (reconnectAttempt >= 2) {
          void api<{ tab: TabRow }>(`/api/v1/tabs/${tab.id}`)
            .then((body) => { if (!body.tab.available) throw new ApiError(410, "session_gone"); })
            .catch((reason) => {
              if (stopped || !(reason instanceof ApiError)) return;
              if (reason.status !== 404 && reason.status !== 410) return;
              stopped = true;
              clearTimeout(reconnectTimer);
              setStoppedReason(CLOSE_REASONS.session_gone);
            });
        }
        reconnectTimer = window.setTimeout(connect, delay);
      };
      next.onmessage = (event) => {
        if (ws !== next) return;
        if (event.data instanceof ArrayBuffer) {
          term.write(new Uint8Array(event.data), updateReadable);
          return;
        }
        if (typeof event.data !== "string") return;
        let control: TerminalEvent;
        try {
          control = JSON.parse(event.data) as TerminalEvent;
        } catch {
          return;
        }
        if (control.type === "pong") {
          lastPong = Date.now();
          pongs += 1;
          return;
        }
        if (control.type === "replay") {
          // The server is about to resend the session. Without an explicit
          // boundary the replay was appended to whatever was already on screen,
          // so each reconnect left another copy of the same agent turn — and a
          // reader could not tell one destructive command from three.
          // The history log goes with it: the replay re-delivers the session,
          // so keeping the absorbed copy would double every line.
          term.reset();
          watchTrim();
          resetHistory();
          setLines([]);
          return;
        }
        if (control.type === "window") {
          windowSize = { cols: control.cols, rows: control.rows };
          applySize();
          return;
        }
        if (control.type === "closing") {
          if (!control.retry) {
            stopped = true;
            clearTimeout(reconnectTimer);
          }
          setStoppedReason(CLOSE_REASONS[control.reason] ?? `The desktop closed the session (${control.reason}).`);
        }
      };
    };
    connect();
    // xterm retains an internal textarea for accessibility even with stdin
    // disabled. Explicitly disable and remove it from tab order so a tap can
    // neither summon a second keyboard nor become a second input route.
    if (term.textarea) {
      term.textarea.disabled = true;
      term.textarea.tabIndex = -1;
      term.textarea.setAttribute("aria-hidden", "true");
    }
    const terminalHost = host.current;
    const removeTouchScroll = installTerminalTouchScroll(terminalHost, term);
    // Both the drag handler and `anchorNewest` scroll the box, and both arrive
    // here. `NEWEST_SLACK` absorbs the sub-pixel cell height that leaves a
    // fitted screen a fraction short of its own scroll extent.
    const followNewest = () => {
      atNewest.current =
        terminalHost.scrollHeight - terminalHost.scrollTop - terminalHost.clientHeight <= NEWEST_SLACK;
    };
    terminalHost.addEventListener("scroll", followNewest, { passive: true });
    // A fresh session starts at column one, whatever the previous tab was
    // panned to.
    terminalHost.scrollLeft = 0;
    if (wideHint.current) wide = installWideOutputHint(terminalHost, wideHint.current);
    anchorNewest();
    let resizeTimer = 0;
    let resizeFrame = 0;
    // A pending reading-view frame is left alone: the keyboard opening fires a
    // burst of viewport resizes, and cancelling the frame here dropped the
    // rebuild of whatever output had just arrived — the next byte, if any,
    // was the only thing that brought it back.
    const resize = () => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(applySize, 100);
      });
    };
    // A backgrounded PWA can be frozen before React unmounts, so the release
    // has to go out on `pagehide` too — otherwise the server holds the tab.
    const release = () => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "detached" }));
    };
    window.addEventListener("pagehide", release);
    window.addEventListener("resize", resize);
    window.visualViewport?.addEventListener("resize", resize);
    // A phone can change the terminal's usable width without firing a window
    // resize (for example when browser chrome or a split-screen divider moves).
    // Keep xterm and the PTY in lockstep so long output is reflowed at the
    // visible right edge instead of leaving a stale, wider canvas behind.
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver(resize);
    resizeObserver?.observe(terminalHost);
    const ping = window.setInterval(() => {
      if (ws?.readyState !== WebSocket.OPEN) return;
      // The server answers every ping. Silence past the grace window means the
      // link is gone even though the browser still reports OPEN, so force the
      // close that drives the normal reconnect.
      if (lastPong && Date.now() - lastPong > PONG_GRACE) {
        ws.close();
        return;
      }
      ws.send(JSON.stringify({ type: "ping" }));
    }, PING_INTERVAL);
    // The page came back into view — a phone unlocked, the app switched back
    // to. A socket that closed while it was away has its reconnect waiting on
    // a backoff timer that was frozen with the page: run it now. One the
    // browser still reports OPEN is asked for a pong within RESUME_GRACE and
    // closed otherwise, which is what drives the ordinary reconnect; before
    // this the composer stayed enabled on a dead link until PONG_GRACE ran
    // out, and typing went nowhere.
    let resumeTimer = 0;
    const resume = () => {
      if (stopped || document.visibilityState !== "visible") return;
      const current = ws;
      if (!current || current.readyState === WebSocket.CLOSED) {
        clearTimeout(reconnectTimer);
        reconnectAttempt = 0;
        connect();
        return;
      }
      if (current.readyState !== WebSocket.OPEN) return;
      const seen = pongs;
      current.send(JSON.stringify({ type: "ping" }));
      clearTimeout(resumeTimer);
      resumeTimer = window.setTimeout(() => {
        if (stopped || ws !== current || current.readyState !== WebSocket.OPEN) return;
        if (pongs === seen) {
          reconnectAttempt = 0;
          current.close();
        }
      }, RESUME_GRACE);
      updateReadable();
    };
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("pageshow", resume);
    return () => {
      stopped = true;
      connectedRef.current = false;
      voiceRequest.current += 1;
      refreshReadable.current = () => {};
      write.current = () => false;
      bracketedPaste.current = () => false;
      clearTimeout(reconnectTimer);
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "detached" }));
      ws?.close();
      trimWatch?.dispose();
      term.dispose();
      clearInterval(ping);
      clearTimeout(resumeTimer);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("pageshow", resume);
      clearTimeout(resizeTimer);
      clearTimeout(readableTimer);
      cancelAnimationFrame(resizeFrame);
      cancelAnimationFrame(readableFrame);
      cancelAnimationFrame(readableScrollFrame);
      cancelAnimationFrame(anchorFrame);
      window.removeEventListener("pagehide", release);
      window.removeEventListener("resize", resize);
      window.visualViewport?.removeEventListener("resize", resize);
      resizeObserver?.disconnect();
      terminalHost.removeEventListener("scroll", followNewest);
      removeTouchScroll();
      wide?.dispose();
    };
  }, [tab.id]);
  useEffect(() => { if (view === "focus") refreshReadable.current(); }, [view]);
  // The reading view has the problem Terminal view's box has: the keyboard
  // opening, or the composer growing under a long draft, shrinks it without
  // moving its scroll offset, so the newest turn slides under the composer.
  // There it also stops following output, because the follow test is the
  // distance to the bottom the shrink just opened up — nothing came back until
  // the reader found "Jump to latest". Put it back on the newest whenever it
  // was there before the resize.
  useEffect(() => {
    const stream = readableHost.current;
    if (!stream || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (!atBottomRef.current) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => stream.scrollTo({ top: stream.scrollHeight }));
    });
    observer.observe(stream);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
    // The stored session mounts the reading view over a full-screen program
    // too, so its availability re-runs this as well.
  }, [view, altScreen, focusSource, transcript?.available]);
  // A default Focus on a session that does not read (no session id yet, an
  // agent whose transcript is not read, no desktop) would only re-read the
  // screen: open Terminal instead, without writing that as the reader's choice.
  useEffect(() => {
    // A just-sent prompt is still a useful Reader conversation when Codex has
    // not produced a readable rollout yet. Keep its local bubble on screen
    // instead of swapping to the terminal and making it vanish mid-turn.
    if (!viewChosen.current && view === "focus" && transcript?.available === false
      && (!CODEX_AGENT.test(tab.agent_label ?? tab.label) || pending.length === 0)) setView("terminal");
  }, [view, transcript, pending, tab.agent_label, tab.label]);
  /** Whether Focus is reading the stored session rather than the screen. */
  const sessionFocus = tab.kind === "agent" && view === "focus" && focusSource === "session";
  const transcriptVersion = useRef<string | undefined>();
  const transcriptRequest = useRef<AbortController>();
  useEffect(() => { transcriptVersion.current = transcript?.version; }, [transcript]);
  /** Reads the stored session: on open, every TRANSCRIPT_POLL while the page
   * is visible, and TRANSCRIPT_SETTLE after the screen last changed. A read
   * that answers `unchanged` keeps what is shown; one that fails keeps it too
   * and the next read retries. An unavailable session (a shell, an agent
   * whose transcript is not read, no desktop) hands Focus to the screen. */
  useEffect(() => {
    if (tab.kind !== "agent" || view !== "focus") return;
    let stopped = false;
    const read = () => {
      if (stopped || document.visibilityState === "hidden") return;
      transcriptRequest.current?.abort();
      const controller = new AbortController();
      transcriptRequest.current = controller;
      void getTranscript(tab.id, transcriptVersion.current, transcriptLimit, controller.signal).then(
        (next) => {
          if (stopped || controller.signal.aborted) return;
          // A malformed answer is a failed read: keep what is shown.
          if (!next || typeof next !== "object" || next.unchanged) return;
          setTranscript((current) => current && sameTranscript(current, next) ? current : next);
        },
        () => {},
      );
    };
    read();
    const timer = window.setInterval(read, TRANSCRIPT_POLL);
    document.addEventListener("visibilitychange", read);
    return () => {
      stopped = true;
      transcriptRequest.current?.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", read);
    };
  }, [tab.id, tab.kind, view, transcriptLimit]);
  useEffect(() => {
    if (!sessionFocus || screenTick === 0) return;
    const timer = window.setTimeout(() => {
      transcriptRequest.current?.abort();
      const controller = new AbortController();
      transcriptRequest.current = controller;
      void getTranscript(tab.id, transcriptVersion.current, transcriptLimit, controller.signal).then(
        (next) => {
          if (controller.signal.aborted || !next || typeof next !== "object" || next.unchanged) return;
          setTranscript((current) => current && sameTranscript(current, next) ? current : next);
        },
        () => {},
      );
    }, TRANSCRIPT_SETTLE);
    return () => window.clearTimeout(timer);
  }, [screenTick, sessionFocus, tab.id, transcriptLimit]);
  /** The stored session is what Focus paints: available, and not switched
   * away from. Until the first read answers, the screen is shown, so the view
   * never opens blank. */
  // Codex can report a fresh session before it has a rollout to read, then
  // temporarily report `no_transcript` while it binds that rollout. A prompt
  // sent from this phone remains part of the Reader during that hand-off.
  const sessionShown = sessionFocus && (transcript?.available === true
    || (pending.length > 0 && CODEX_AGENT.test(tab.agent_label ?? tab.label)));
  /** The session chat's entries: the stored ones, with each prompt sent
   * from here held in its place (`withPending`). */
  /** The new chat's records while the one cleared from here is still what the
   * desktop answers with; `null` once another session is read. */
  const sinceClear = useMemo(() => afterClear(transcript?.entries ?? [], clearedAt), [transcript, clearedAt]);
  const storedEntries = useMemo(() => sinceClear ?? transcript?.entries ?? [], [sinceClear, transcript]);
  const sessionEntries = useMemo(() => withPending(storedEntries, pending), [storedEntries, pending]);
  /** Read-aloud: each answer that arrives at the end of the stored session is
   * spoken once. What the first read brought is history, as is anything
   * "earlier" reveals above it or a whole other session swapped in — only a
   * short new tail is news. Nothing is said over dictation: the microphone
   * would hear it. */
  const spokenKeys = useRef<Set<string> | null>(null);
  useEffect(() => {
    spokenKeys.current = null;
    return stopSpeaking;
  }, [tab.id]);
  useEffect(() => {
    if (!sessionShown || !transcript) return;
    const turns = transcriptTurns(transcript.entries);
    const seen = spokenKeys.current;
    spokenKeys.current = new Set(turns.map((turn) => turn.key));
    if (!seen || !readAloud || listening) return;
    let known = -1;
    turns.forEach((turn, index) => { if (seen.has(turn.key)) known = index; });
    const fresh = turns.slice(known + 1).filter((turn) => turn.kind === "answer");
    if (fresh.length === 0 || fresh.length > MAX_SPOKEN_AT_ONCE) return;
    const code = t("mobile.speech.code");
    for (const turn of fresh) speak(turn.key, spokenText(turn.text, code), speechTag());
  }, [sessionShown, transcript, readAloud, listening, t]);
  useEffect(() => {
    if (listening || !sessionShown) stopSpeaking();
  }, [listening, sessionShown]);
  // A new turn in the stored session, or a file the agent sent into the
  // Focus chat, scrolls the view to it, as new screen output does, unless
  // the reader has scrolled up to read.
  useLayoutEffect(() => {
    if (!sessionShown || !atBottom) return;
    const stream = readableHost.current;
    if (stream && typeof stream.scrollTo === "function") stream.scrollTo({ top: stream.scrollHeight });
  }, [sessionShown, transcript, pending, atBottom]);
  /** Reads the outbox now and every `OUTBOX_POLL` while the page is visible;
   * coming back to the page reads it at once. A listing that could not be
   * fetched keeps what was shown — the next poll retries. */
  useEffect(() => {
    setOutbox([]);
    setGallery(false);
    setOutboxOpen(null);
    let stopped = false;
    let inflight: AbortController | undefined;
    const poll = () => {
      if (stopped || document.visibilityState === "hidden") return;
      inflight?.abort();
      const controller = new AbortController();
      inflight = controller;
      void listOutbox({ tab: tab.id }, controller.signal).then(
        (images) => {
          if (stopped || controller.signal.aborted || !Array.isArray(images)) return;
          setOutbox((current) => sameOutbox(current, images) ? current : images);
        },
        () => {},
      );
    };
    poll();
    const timer = window.setInterval(poll, OUTBOX_POLL);
    document.addEventListener("visibilitychange", poll);
    return () => {
      stopped = true;
      inflight?.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [tab.id]);
  /** Reads the usage panel now and every `LIMITS_POLL` while the page is
   * visible. A CLI with no usage readout stops the polling; a failed read keeps
   * what was shown — the next poll retries. */
  useEffect(() => {
    if (tab.kind !== "agent") return;
    let stopped = false;
    let last = 0;
    const poll = () => {
      if (stopped || document.visibilityState === "hidden") return;
      if (Date.now() - last < LIMITS_POLL / 2) return;
      last = Date.now();
      void getAgentStatus(tab.id).then(
        (report) => {
          // A malformed answer is a failed read: keep what is shown.
          if (stopped || !report?.usage) return;
          if (report.usage.supported === false) {
            stopped = true;
            return;
          }
          if (report.usage.raw) setLimits(limitMeters(parseUsageReport(report.usage.raw)));
        },
        () => {},
      );
    };
    poll();
    const timer = window.setInterval(poll, LIMITS_POLL);
    document.addEventListener("visibilitychange", poll);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [tab.id, tab.kind]);
  useEffect(() => {
    if (!outboxOpen && !gallery) return;
    // The viewer opens from the gallery, so Escape closes the top one first.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (outboxOpen) setOutboxOpen(null);
      else setGallery(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [outboxOpen, gallery]);
  /** A PDF opens in the browser's own viewer; a picture or text full-screen here. */
  const openOutbox = useCallback((file: OutboxFile) => {
    if (file.kind === "application/pdf") window.open(outboxFileUrl({ tab: tab.id }, file.name), "_blank", "noopener");
    else setOutboxOpen(file);
  }, [tab.id]);
  /** Removes one of the files the agent sent, from the tile's own confirm — the
   * same removal the project screen's shelf does, through this tab's scope. The
   * row goes now rather than at the next poll, and the sheet closes with the
   * last file rather than standing empty over the session. */
  const removeOutbox = useCallback(async (file: OutboxFile) => {
    await deleteOutboxFile({ tab: tab.id }, file.name);
    setOutbox((current) => {
      const left = current.filter((row) => row.name !== file.name);
      if (left.length === 0) setGallery(false);
      return left;
    });
    setOutboxOpen((open) => open?.name === file.name ? null : open);
  }, [tab.id]);
  /** Chunks above the revealed window stay in memory but out of the DOM — the
   * lazy half of the earlier-output log. */
  const hiddenChunks = Math.max(0, earlier.chunks.length - revealed);
  const visibleChunks = useMemo(
    () => earlier.chunks.slice(hiddenChunks),
    [earlier.chunks, hiddenChunks],
  );
  const hiddenLines = useMemo(
    () => earlier.chunks.slice(0, hiddenChunks).reduce((sum, chunk) => sum + chunk.lines.length, 0),
    [earlier.chunks, hiddenChunks],
  );
  const showEarlier = () => {
    const stream = readableHost.current;
    if (stream) revealAnchor.current = { height: stream.scrollHeight, top: stream.scrollTop };
    setRevealed((count) => count + REVEAL_CHUNKS);
  };
  // Revealing prepends content, which would shove the line the reader tapped
  // beside out of view; restore the reading position by the height delta.
  useLayoutEffect(() => {
    const anchor = revealAnchor.current;
    const stream = readableHost.current;
    if (!anchor || !stream) return;
    revealAnchor.current = undefined;
    stream.scrollTop = anchor.top + (stream.scrollHeight - anchor.height);
  }, [revealed]);
  const type = (value: string) => {
    const delivered = write.current(value);
    setSendFailed(!delivered);
    return delivered;
  };
  /** A single keypress, unmodified — what an agent's select prompts, `less` and
   * `vim` actually read. The composer's line-editor prefix would be meaningless
   * or destructive there. */
  const press = (value: string) => {
    const payload = ctrl && value.length === 1
      ? String.fromCharCode(value.toUpperCase().charCodeAt(0) & 0x1f)
      : value;
    const delivered = type(payload);
    if (ctrl) setCtrl(false);
    return delivered;
  };
  /** Run `send` after `delay`, cancelled when the screen switches tabs. */
  const later = (delay: number, send: () => void) => {
    sendTimers.current.push(window.setTimeout(send, delay));
  };
  /** Drops writes still queued behind their gaps. */
  const clearPending = () => {
    sendTimers.current.forEach(window.clearTimeout);
    sendTimers.current = [];
  };
  /** Delivers a run of writes one at a time, never as one chunk (see
   * AGENT_KEY_GAP). Only the first can be confirmed synchronously; a later one
   * that fails raises the dropped-connection notice through `type`. Shared by
   * the composer's Send and by the sheet that answers a TUI dialog with the
   * same arrow/Enter keys the on-screen key row sends. */
  const deliver = (writes: string[]) => {
    if (writes.length === 0) return true;
    if (!type(writes[0])) return false;
    const step = (index: number) => {
      if (index >= writes.length) return;
      // The submit gets the longer pause: it is the one write whose arrival in
      // the same read as the text would be swallowed as part of a paste.
      const gap = index === writes.length - 1 ? AGENT_SUBMIT_GAP : AGENT_KEY_GAP;
      later(gap, () => { if (type(writes[index])) step(index + 1); });
    };
    step(1);
    return true;
  };
  /** One message into the agent's line editor: reset its line, deliver the
   * text, submit — inside bracketed paste markers where the pane has the mode
   * on and the family wants them (`bracketsAgentMessage`). Shared by the
   * composer's Send and the composer chips' slash commands. */
  const sendAgentText = (text: string) => {
    clearPending();
    const bracketed = bracketsAgentMessage(tab.agent_label ?? tab.label, bracketedPaste.current());
    return deliver(agentInputWrites(text, bracketed));
  };
  /** Once dictated words have left the composer — sent or cleared — "Heard:"
   * stops quoting them. They stay counted as inserted: a recognizer that is
   * still listening reads them back, and they must not return to the draft.
   * Listening itself goes on. */
  const forgetDictation = () => {
    voiceProgress.current = settleDictation(voiceProgress.current);
    setVoicePreview("");
  };
  const submitDraft = () => {
    if (!connected || !draft.trim()) return;
    // Only confirm what actually left the device. `readyState === OPEN` on a
    // half-open cellular link silently buffers, and "Sent" was shown regardless.
    if (tab.kind !== "agent") {
      // A shell has no soft newline: each line is its own command line.
      if (!type(`${draft.replace(/\r?\n/g, "\r")}\r`)) return;
      setLastSent(draft);
      setDraft("");
      return;
    }
    if (!sendAgentText(draft)) return;
    setLastSent(draft);
    // A slash command is the CLI's, not a turn: the session never records it,
    // so a bubble for it would wait forever. `/clear` also ends the chat the
    // earlier bubbles were waiting in.
    if (/^\s*\//u.test(draft)) {
      if (/^\s*\/clear\b/u.test(draft)) startedOver();
      rememberSlashCommand(slashCliKey, draft);
      setUsedSlash(readSlashCommands(slashCliKey));
    } else {
      const sent = pendingPrompt(++pendingId.current, draft, storedEntries);
      setPending((current) => [...current, sent].slice(-MAX_PENDING));
      // The phone knows the words before they leave; the desktop records them
      // as this tab's prompt — the only record of it for an agent whose
      // transcript is not read (OpenCode's cards list these).
      void reportSentPrompt(tab.id, draft).catch(() => {});
    }
    setDraft("");
    forgetDictation();
  };
  /** Codex at work: it answers `/clear` with "disabled while a task is in
   * progress" and keeps the conversation. */
  const codexBusy = () => CODEX_AGENT.test(tab.agent_label ?? tab.label) && liveBusy;
  /** A `/clear` just left for the agent: the chat shown starts over. What the
   * session held stays hidden until the new one is read, unless Codex was busy
   * and refused it — then the conversation goes on, and so does the chat. */
  const startedOver = () => {
    setPending([]);
    if (!codexBusy()) setClearedAt(clearMark(transcript?.entries ?? []));
  };
  /** The field's new-conversation button sends the selected CLI's command at
   * once — no confirm dialog. The draft is left alone. A Codex that is working
   * would refuse it, so the button says so here instead. */
  const clearConversation = () => {
    if (codexBusy()) {
      setClearRefused(true);
      return;
    }
    setClearRefused(false);
    if (sendAgentText(NEW_CONVERSATION_COMMAND)) startedOver();
  };
  /** The composer's `/` menu: the commands that continue the draft, the
   * reader's own first. Picking one only fills the field — the reader still
   * sends it, so a stray tap never runs `/clear` on a session. */
  const slashMenu = useMemo(
    () => (tab.kind === "agent" && connected ? slashSuggestions(draft, slashCliKey, usedSlash) : []),
    [tab.kind, connected, draft, slashCliKey, usedSlash],
  );
  const pickSlash = (suggestion: SlashSuggestion) => {
    setDraft(suggestion.args ? `${suggestion.line} ` : suggestion.line);
    composerInput.current?.focus();
  };
  const forgetSlash = (line: string) => {
    forgetSlashCommand(slashCliKey, line);
    setUsedSlash(readSlashCommands(slashCliKey));
    composerInput.current?.focus();
  };
  /** The composer's ✕: an empty draft, and the dictation transcript with it. */
  const clearDraft = () => {
    setDraft("");
    forgetDictation();
    composerInput.current?.focus();
  };
  /** Keep the draft a moment after the typing stops. Per keystroke would put a
   * synchronous store write between the reader and their next letter, and the
   * only thing the delay can cost is text that is still on the screen. */
  useEffect(() => {
    const timer = window.setTimeout(() => writeDraft(tab.id, draftRef.current), DRAFT_SAVE_DELAY);
    return () => window.clearTimeout(timer);
  }, [tab.id, draft]);
  /** …and once more when this screen goes away, which the delay above would
   * otherwise eat: leaving for the tab list unmounts it, and a phone putting the
   * PWA away kills it without unmounting anything (`pagehide` is the last word
   * either way — `beforeunload` never fires on iOS). */
  useEffect(() => {
    const flush = () => writeDraft(tab.id, draftRef.current);
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [tab.id]);
  /** The tab's own name for its agent, which is what every family rule is
   * scoped by: the mode tables, the prompt echo Kimi Code draws, and the whole
   * of OpenCode's mini interface, whose frame has no marker to be found by. */
  const agentLabel = tab.agent_label ?? tab.label;
  const openCode = tab.kind === "agent" && isOpenCodeTab(agentLabel);
  const antigravity = tab.kind === "agent" && isAntigravityTab(agentLabel);
  /** The facts the session prints below its own input box — the facts row's
   * labels. Absent fields leave a button on its generic label. */
  const status = useMemo(
    () => (tab.kind === "agent" ? sessionStatus(liveScreen, agentLabel) : null),
    [tab.kind, liveScreen, agentLabel],
  );
  // The mode walk reads the status between two presses, outside React's render.
  useEffect(() => { statusRef.current = status; }, [status]);
  /** Codex draws neither its context nor its limits on screen and has no
   * usage panel the desktop can run, but writes both into its rollout: the
   * stored session's figures fill in what the screen and the panel leave out,
   * so its facts row reads like Claude's. */
  // The cleared conversation's figures are not the new chat's.
  const storedUsage = sinceClear ? undefined : transcript?.usage;
  const contextLeft = status?.context ?? (storedUsage?.contextLeft != null ? `${storedUsage.contextLeft}%` : undefined);
  const shownLimits = limits.session || limits.week ? limits : sessionLimits(storedUsage, new Date(Date.now()));
  /** The picker the model chip opened, read off the screen while the sheet is
   * up — a list of the session's own rows, not a list of models Eldrun
   * believes in. Neither OpenCode's nor Antigravity's is the numbered dialog
   * the others draw, so each is read by its own shape (`openCodeMini`,
   * `antigravity`). */
  const picker = useMemo(
    () => {
      if (!modelSheet) return null;
      if (openCode) return readOpenCodePicker(liveScreen);
      if (antigravity) return readAntigravityPicker(liveScreen);
      return readSelectPrompt(liveScreen, agentLabel);
    },
    [modelSheet, openCode, antigravity, liveScreen, agentLabel],
  );
  /** The step the sheet is showing: the picker on screen, unless it is the one
   * a tap just answered and the session has not redrawn yet. */
  const pickerStep = picker && answered && sameSelectStep(answered, picker) ? null : picker;
  /** The step as far as it is known: the rows on screen plus those an earlier
   * slice of the same picker drew. OpenCode's list is never windowed, and a
   * tapped group heading narrows it into a list of its own. */
  const listedStep = useMemo<SelectStep | null>(
    () => (!pickerStep ? null : openCode ? pickerStep : mergeSelectRows(knownStep, pickerStep)),
    [pickerStep, openCode, knownStep],
  );
  useEffect(() => { if (listedStep && !openCode) setKnownStep(listedStep); }, [listedStep, openCode]);
  /** The printed number of the row the dialog highlights right now. */
  const pickerAt = pickerStep?.options[pickerStep.current]?.number;
  /** The effort stops Antigravity's dialog is offering right now — the ones
   * belonging to the model its highlight is on, which is why they are read
   * again after every walk rather than kept with the row. */
  const effortSlider = useMemo<AntigravityEffort | null>(
    () => (modelSheet && antigravity ? readAntigravityEffort(liveScreen) : null),
    [modelSheet, antigravity, liveScreen],
  );
  useEffect(() => {
    if (!modelSheet) return;
    if (pickerStep) {
      sawPicker.current = true;
      // A step is up, so nothing is left to hold for: a dialog that comes back
      // to a list already answered (Codex's "More reasoning…" has an esc back)
      // is a step again, not the stale paint of the answer.
      if (answered) setAnswered(null);
      return;
    }
    // The answered list, still on screen: the session has not read the Enter
    // yet. Hold — the next step, if there is one, replaces it in place. If the
    // session never moves off it, the answer did not land: give the list back
    // rather than hold a sheet the tap can no longer leave.
    if (answered && picker) {
      const stuck = window.setTimeout(() => setAnswered(null), MODEL_PICKER_WAIT);
      return () => window.clearTimeout(stuck);
    }
    if (sawPicker.current) {
      // Gone after it was listed: answered here, on the desktop, or dismissed.
      // After a tap the gap is given to the step that may still follow.
      if (!answered) {
        setModelSheet(false);
        return;
      }
      const next = window.setTimeout(() => {
        setModelSheet(false);
        setAnswered(null);
      }, SELECT_NEXT_WAIT);
      return () => window.clearTimeout(next);
    }
    // Never drawn: the session may have no `/model` picker at all. Step out of
    // the way rather than hold an empty sheet over its output.
    const timer = window.setTimeout(() => setModelSheet(false), MODEL_PICKER_WAIT);
    return () => window.clearTimeout(timer);
  }, [modelSheet, picker, pickerStep, answered]);
  /** A windowed picker says how many rows it is not drawing: the highlight is
   * walked to each one it hides, which scrolls it into view, and back. Only
   * arrow keys — nothing is accepted — and only while nothing was tapped. */
  useEffect(() => {
    if (!modelSheet || openCode || answered || !pickerStep || !listedStep || pickerAt === undefined || revealStuck.current) return;
    if (reveal && pickerAt !== reveal.target) {
      // The keys have not landed yet. If they never do, stop walking.
      const stuck = window.setTimeout(() => {
        revealStuck.current = true;
        setReveal(null);
      }, MODEL_PICKER_WAIT);
      return () => window.clearTimeout(stuck);
    }
    const target = missingSelectRow(listedStep, pickerStep) ?? reveal?.origin;
    if (target === undefined || target === pickerAt) {
      if (reveal) setReveal(null);
      return;
    }
    if (!deliver(selectMoveKeys(pickerAt, target))) {
      setReveal(null);
      return;
    }
    setReveal({ origin: reveal?.origin ?? pickerAt, target });
    // `deliver` is a fresh closure every render; the walk runs on the frames.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelSheet, openCode, answered, pickerStep, listedStep, pickerAt, reveal]);
  /** The highlight has reached the model an Antigravity tap chose, so the
   * dialog has redrawn its slider for *that* model: a model with stops asks
   * for one here, and a model with none — every Claude model it offers — is
   * accepted now, because there is nothing left to ask. Until the walk lands
   * the screen still shows the row it left, so nothing is pressed on a frame
   * that has not caught up; a walk whose keys never show gives the list back. */
  useEffect(() => {
    if (!effortFor) return;
    if (!pickerStep || pickerAt !== effortFor.number) {
      const stuck = window.setTimeout(() => setEffortFor(null), MODEL_PICKER_WAIT);
      return () => window.clearTimeout(stuck);
    }
    if (effortSlider && effortSlider.stops.length > 1) {
      setEffortStep(effortFor.label);
      setEffortFor(null);
      return;
    }
    if (deliver(["\r"]) && listedStep) setAnswered(listedStep);
    setEffortFor(null);
    // `deliver` is a fresh closure every render; the step runs on the frames.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effortFor, pickerStep, pickerAt, effortSlider, listedStep]);
  /** `/model` opens the agent's own picker in the session; the sheet lists the
   * rows it drew, and a tap answers it with the same keys the arrow row sends —
   * so nothing here decides what the models are.
   *
   * Neither OpenCode interface has a `/model`. In mini the words would be
   * submitted to the model as a prompt, a turn the reader never asked for; in
   * the full TUI the command is `/models`, so `/model` only opened the slash
   * completion and left it sitting in the composer. Both open the same picker
   * from the command palette, so the chip presses the keys that get there
   * (`OPENCODE_MODEL_KEYS`) instead of typing a command. */
  const selectModel = () => {
    if (modelSheet) return;
    sawPicker.current = false;
    revealStuck.current = false;
    setAnswered(null);
    setKnownStep(null);
    setReveal(null);
    setEffortFor(null);
    setEffortStep(null);
    if (openCode) {
      clearPending();
      if (!deliver(OPENCODE_MODEL_KEYS)) return;
    } else if (!sendAgentText("/model")) return;
    setModelSheet(true);
  };
  /** The card's model tap, answered once the socket is up and the session has
   * drawn its first frame: sent any earlier, `/model` lands before the agent's
   * prompt exists, and the sheet's own wait for the picker would run out on
   * the attach rather than on the agent. */
  const pickModelPending = useRef(pickModel && tab.kind === "agent");
  useEffect(() => {
    if (!pickModelPending.current || !connected || liveScreen.length === 0) return;
    pickModelPending.current = false;
    selectModel();
  });
  /** Answers the step on screen. The sheet does not close on the tap: `/model`
   * is one step in Claude Code and two in Codex, which asks for a reasoning
   * level next, and which it is, is the session's answer to give — the sheet
   * lists whatever it draws next, and closes when it draws nothing.
   *
   * OpenCode's picker is answered by typing into its search field rather than
   * by walking a highlight this cannot see (`openCodePickKeys`); tapping one of
   * its group headings narrows the list, which the sheet reads as the next
   * step. */
  const chooseModel = (key: string) => {
    // Mid-walk the highlight is not where the frame says; the sheet is busy.
    if (!pickerStep || !listedStep || reveal || effortFor) return;
    clearPending();
    const picked = listedStep.options.find((option) => option.number === Number(key));
    if (!picked) return;
    // Antigravity's dialog applies the model and its effort together, on one
    // Enter: the tap only walks the highlight there, and what happens next is
    // the effort the dialog then draws for it.
    if (antigravity) {
      if (pickerAt === undefined || !deliver(selectMoveKeys(pickerAt, picked.number))) return;
      setEffortFor({ number: picked.number, label: picked.label });
      return;
    }
    // Walked by printed number: a windowed picker's rows on screen are a slice.
    const writes = openCode
      ? openCodePickKeys(picked.label)
      : pickerAt === undefined ? [] : selectKeys(pickerAt, picked.number);
    if (writes.length === 0 || !deliver(writes)) return;
    setAnswered(listedStep);
  };
  /** Answers Antigravity's effort step: the slider is moved with the same
   * ←/→ its own keyboard row names, and the Enter that follows is the one
   * that applies the model and the effort at once. */
  const chooseEffort = (key: string) => {
    if (!effortSlider || !listedStep) return;
    clearPending();
    const target = Number(key);
    if (!effortSlider.stops[target]) return;
    if (!deliver([...antigravityEffortKeys(effortSlider.current, target), "\r"])) return;
    setAnswered(listedStep);
    setEffortStep(null);
  };
  const closeModelSheet = () => {
    // The dialog is the session's own and still open: close it there too,
    // rather than leaving a modal behind that the reader can no longer see.
    if (picker) type("\u001b");
    setModelSheet(false);
    setAnswered(null);
    setReveal(null);
    setEffortFor(null);
    setEffortStep(null);
  };
  /** Shift+Tab — the mode cycle Claude Code, Codex and Qwen Code all bind,
   * encoded the way this family's TUI reads it (`shiftTabKey`). The chip label
   * follows the status line the TUI redraws, so the feedback is real. */
  /** The chip's lamp comes from the row this screen was opened with, and that
   * row is frozen for the whole session (it even survives a restart, via
   * `lastPlace`). A `done` on it is by definition already read — the tab is on
   * screen — so it is not shown here, the same way the desktop's tab bar hides
   * the viewed tab's own glow. The desktop retires the flag for real when the
   * attach reports the tab seen. */
  const lamp = tab.agent_status === "done" ? "idle" : tab.agent_status ?? "idle";
  const shiftTab = shiftTabKey(agentLabel);
  const cycleMode = () => press(shiftTab);
  /** The modes this session has, decided by the mode it is showing with the
   * tab's agent label as the tie-break (and, for a family whose default mode
   * draws no text at all, as the way in). Empty for a session no family
   * claims — the chip then keeps cycling, as before. */
  const modes = useMemo(() => modeChoices(status?.mode, agentLabel), [status?.mode, agentLabel]);
  const activeMode = currentMode(modes, status?.mode, status != null);
  /** A family whose mode no key here can change (OpenCode's mini interface).
   * The sheet lists its modes as a readout: nothing is pressed, and the chip
   * never cycles into a session that ignores the key. */
  const fixedMode = modeFixed(agentLabel);
  const openModeSheet = () => {
    if (modes.length === 0 && !fixedMode) {
      cycleMode();
      return;
    }
    setSwitchFailed("");
    setModeSheet(true);
  };
  /** Walks the Shift+Tab cycle to the tapped mode, reading the redrawn status
   * line after every press. No cycle order is assumed: the walk stops when the
   * session reports the mode that was asked for, or when a full lap has brought
   * it back to where it started — which is also what leaves a mode the session
   * does not offer with nothing changed. */
  const applyMode = async (value: string) => {
    if (switching || !connected || fixedMode) return;
    const start = statusRef.current?.mode;
    if (currentMode(modes, start, statusRef.current != null) === value) {
      setModeSheet(false);
      return;
    }
    const walk = modeWalk.current + 1;
    modeWalk.current = walk;
    setSwitchFailed("");
    setSwitching(value);
    for (let step = 0; step < MODE_CYCLE_LIMIT; step += 1) {
      if (!type(shiftTab)) break;
      await new Promise((resolve) => { window.setTimeout(resolve, MODE_SETTLE); });
      if (modeWalk.current !== walk) return;
      const now = statusRef.current?.mode;
      if (currentMode(modes, now, statusRef.current != null) === value) {
        setSwitching("");
        setModeSheet(false);
        return;
      }
      // Back where it started ends the walk — but only on a positively read
      // mode: with a silent-mode family, `undefined` is also what a mid-redraw
      // frame reports, and breaking on it would end a legitimate walk early.
      if (step > 0 && now !== undefined && now === start) break;
    }
    if (modeWalk.current !== walk) return;
    setSwitching("");
    setSwitchFailed(value);
  };
  const sheetUp = modelSheet || modeSheet || statusSheet || desktopSheet || gallery || outboxOpen !== null;
  useLayoutEffect(() => {
    setFrozenLines(sheetUp ? linesRef.current : null);
  }, [sheetUp]);
  /** Adds an `@` for the agent's file mentions to the draft — context is
   * resolved by the agent from the submitted message, not by the phone. */
  const addContext = () => {
    setDraft((current) => `${current}${current && !current.endsWith(" ") ? " " : ""}@`);
    composerInput.current?.focus();
  };
  /** Appends one token to the draft with a space on each side as needed. */
  const appendToDraft = (token: string) => {
    setDraft((current) => `${current}${current && !current.endsWith(" ") ? " " : ""}${token} `);
  };
  /** Sends the picked files into the project inbox one by one and writes each
   * one's `@` reference into the draft as it lands. The reference is the
   * desktop's — the phone never composes a path. */
  const attachFromPhone = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const run = uploadRun.current;
    for (const file of Array.from(files)) {
      const id = ++uploadSeq.current;
      const name = file.name || "attachment";
      if (file.size > MAX_INBOX_FILE) {
        setUploads((current) => [...current, { id, name, source: "phone", failure: UPLOAD_FAILURES.file_too_large }]);
        continue;
      }
      setUploads((current) => [...current, { id, name, source: "phone" }]);
      void uploadToInbox(tab.id, file, name).then(
        (attachment) => {
          if (uploadRun.current !== run) return;
          setUploads((current) => current.filter((upload) => upload.id !== id));
          appendToDraft(`@${attachment.reference}`);
        },
        (error: unknown) => {
          if (uploadRun.current !== run) return;
          const code = error instanceof ApiError ? error.code : "";
          const failure = UPLOAD_FAILURES[code] ?? "could not be sent to the desktop.";
          setUploads((current) => current.map((upload) => upload.id === id ? { ...upload, failure } : upload));
        },
      );
    }
    composerInput.current?.focus();
  };
  const dismissUpload = (id: number) => setUploads((current) => current.filter((upload) => upload.id !== id));
  /** Opens the desktop's list and asks for it. The list is read once per
   * opening — the sheet shows what the desktop had when it was asked, and a
   * screenshot taken meanwhile is one close-and-reopen away. */
  const openDesktopSheet = () => {
    const run = uploadRun.current;
    setDesktopImages(null);
    setDesktopFailure("");
    setDesktopSheet(true);
    void listDesktopImages(tab.id).then(
      (images) => { if (uploadRun.current === run) setDesktopImages(images); },
      (error: unknown) => {
        if (uploadRun.current !== run) return;
        const code = error instanceof ApiError ? error.code : "";
        setDesktopFailure(DESKTOP_LIST_FAILURES[code] ?? "The desktop could not list its images.");
        setDesktopImages([]);
      },
    );
  };
  /** Asks the desktop to copy one listed image into the project inbox and
   * writes the reference into the draft as it lands — the same row and the
   * same `@` a file sent from the phone gets. */
  const attachFromDesktop = (imageId: string) => {
    const image = desktopImages?.find((entry) => entry.id === imageId);
    setDesktopSheet(false);
    if (!image) return;
    const run = uploadRun.current;
    const id = ++uploadSeq.current;
    setUploads((current) => [...current, { id, name: image.name, source: "desktop" }]);
    void attachDesktopImage(tab.id, image.id).then(
      (attachment) => {
        if (uploadRun.current !== run) return;
        setUploads((current) => current.filter((upload) => upload.id !== id));
        appendToDraft(`@${attachment.reference}`);
      },
      (error: unknown) => {
        if (uploadRun.current !== run) return;
        const code = error instanceof ApiError ? error.code : "";
        const failure = UPLOAD_FAILURES[code] ?? "could not be copied into the project inbox.";
        setUploads((current) => current.map((upload) => upload.id === id ? { ...upload, failure } : upload));
      },
    );
    composerInput.current?.focus();
  };
  const pickAdd = (key: string) => {
    setAddSheet(false);
    if (key === "phone") {
      fileInput.current?.click();
    } else if (key === "gallery") {
      galleryInput.current?.click();
    } else if (key === "desktop") {
      openDesktopSheet();
    } else {
      addContext();
    }
  };
  /** What the reading view paints: the live screen, or the frame it held when
   * a composer sheet opened — minus the session's own input frame, which the
   * composer and its chips already are. */
  const shown = frozenLines ?? lines;
  const painted = useMemo(
    () => (tab.kind === "agent" ? shown.slice(0, inputFrameStart(shown, agentLabel)) : shown),
    [tab.kind, shown, agentLabel],
  );
  /** The rows the session draws under its input box — the frame `painted`
   * cuts away — for the swipe-in status strip. From the same `shown`, so a
   * frame frozen behind a sheet stays consistent; always the xterm screen,
   * even while Focus reads the stored session. */
  const frameStatus = useMemo(
    // A fullscreen agent's rows are on its frame instead, where nothing is
    // frozen behind a sheet: the frame is what the session is drawing now.
    // Dedented, because a fullscreen TUI centres its box — OpenCode's sits 70
    // columns in on a wide pane — and the strip is a phone-width readout of
    // those rows, not a scale model of the desktop window. On the scrollback,
    // where the rows start at the margin, this takes nothing away.
    () => (tab.kind === "agent" ? dedentRows(statusFrameLines(altScreen ? liveScreen : shown, agentLabel)) : []),
    [tab.kind, altScreen, liveScreen, shown, agentLabel],
  );
  const statusSwipe = tab.kind === "agent" && view === "focus" && (!altScreen || liveScreen.length > 0);
  useEffect(() => {
    const stream = readableHost.current;
    if (!statusSwipe || !stream) return;
    return installFocusSwipe(stream, {
      onSwipeRight: () => setStatusStrip(true),
      onSwipeLeft: () => setStatusStrip(false),
    });
  }, [statusSwipe]);
  /** Agent tabs read as a chat (`ReadableTurns`); a shell's output has no
   * turns to lay out. */
  const chat = tab.kind === "agent";
  /** The live screen after the last prompt echo — what the session is
   * drawing right now. Shown under the stored session while it holds a
   * choice the session is waiting on, which the transcript cannot carry. */
  const liveTail = useMemo(() => {
    if (!sessionShown) return [];
    // On the alternate screen that tail is the frame itself, cut at its input
    // box the way `painted` cuts the scrollback's: a fullscreen agent draws its
    // session there, so a question of its own reaches the phone in no other
    // way. A frame that holds no dialog reaches the reader in no other way
    // either — only `liveQuestion` reads this, never the view.
    const screen = altScreen ? liveScreen.slice(0, inputFrameStart(liveScreen, agentLabel)) : painted;
    let start = 0;
    screen.forEach((line, index) => { if (isPromptEcho(line, agentLabel)) start = index + 1; });
    return screen.slice(start);
  }, [sessionShown, altScreen, liveScreen, painted, agentLabel]);
  /** The choice the session is waiting on, read off the live screen. On the
   * phone it is answered by tapping a row, so what is kept is the dialog
   * itself — its rows, and where on the tail they start — not just that there
   * is one. */
  const liveQuestion = useMemo(
    () => (liveTail.length > 0 ? readSelectPrompt(liveTail, agentLabel) : null),
    [liveTail, agentLabel],
  );
  /** The dialog's own question — the block right above its rows, which the
   * list below shows as its heading — and the screen it was drawn onto, which
   * stays as the session drew it. Blank rows at either seam are the dialog's
   * own gutter, not a paragraph of anybody's. */
  const questionAsk = useMemo(
    () => (liveQuestion ? dedentLines(withoutEdgeBlanks(liveTail.slice(liveQuestion.question, liveQuestion.start))) : []),
    [liveQuestion, liveTail],
  );
  const questionContext = useMemo(
    () => (liveQuestion ? withoutEdgeBlanks(liveTail.slice(liveQuestion.context, liveQuestion.question)) : []),
    [liveQuestion, liveTail],
  );
  /** What the list on screen *is*, as a string: a stable dep for the effects
   * below, which must not restart on every repaint of the same question. */
  const questionSignature = liveQuestion ? selectSignature(liveQuestion) : "";
  /** The question a tap just answered, while the session has not redrawn yet:
   * its rows stay listed, but nothing can be tapped twice. */
  const [questionSent, setQuestionSent] = useState<{ signature: string; number: number } | null>(null);
  const sentSignature = questionSent?.signature ?? "";
  useEffect(() => {
    if (!sentSignature) return;
    // Redrawn as something else — answered, or moved on: the list is live again.
    if (questionSignature !== sentSignature) {
      setQuestionSent(null);
      return;
    }
    // Still the same question after the keys had time to land: the answer did
    // not arrive. Give the list back rather than leave a dead block on screen.
    const stuck = window.setTimeout(() => setQuestionSent(null), MODEL_PICKER_WAIT);
    return () => window.clearTimeout(stuck);
  }, [sentSignature, questionSignature]);
  /** Answers the question on screen with the row tapped — the same arrow keys
   * and Enter the on-screen key row sends, so a tapped row lands exactly as a
   * walked one. Nothing here decides what the options are. */
  const answerQuestion = (option: SelectOption) => {
    if (!liveQuestion || questionSent) return;
    clearPending();
    if (!deliver(selectKeys(liveQuestion.current, option.index))) return;
    setQuestionSent({ signature: questionSignature, number: option.number });
  };
  /** The stored session only grows at message boundaries, so a turn busy in
   * tool calls looked finished. The live screen's interrupt hint says it is
   * not; a choice on screen is waiting on the reader instead. */
  const sessionWork = useMemo(
    () => (sessionShown && !liveQuestion ? agentWork(liveScreen) : null),
    [sessionShown, liveQuestion, liveScreen],
  );
  const sessionBusy = sessionWork !== null;
  /** What the working row says beside the dots: the elapsed time and the
   * tokens the agent's own spinner prints, in its words. A family that prints
   * neither leaves the line as it was. */
  const workFacts = [
    sessionWork?.elapsed,
    sessionWork?.tokens ? t("mobile.focus.workingTokens", { count: sessionWork.tokens }) : undefined,
  ].filter((fact): fact is string => !!fact);
  /** Who the working row names: the model's family word as the session prints
   * it (`Opus 4.5` → `Opus`), or the tab's published model behind it; a tab
   * with neither keeps the generic "Agent". */
  const workingModel = (status?.model ?? tab.agent_model)?.trim().split(/\s+/)[0];
  /** The screen's lines as the reading view shows them: the revealed history,
   * the open chunk, then the live tail. */
  const screenStream = useMemo(
    () => [...visibleChunks.flatMap((chunk) => chunk.lines), ...earlier.open, ...painted],
    [visibleChunks, earlier.open, painted],
  );
  /** A shell's Focus has no messages to hold for a menu (`useMessageMenu`), so
   * it copies what the reading view shows: the revealed history, the open
   * chunk, then the live tail. */
  const copyReadable = async () => {
    try {
      await navigator.clipboard.writeText(readableText(screenStream));
      setCopied(true);
      window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  };
  // New turns push the prompt up as surely as a scroll does.
  useLayoutEffect(checkPinnedPrompt, [checkPinnedPrompt, view, sessionShown, sessionEntries, screenStream]);
  const jumpToLatest = () => {
    const stream = readableHost.current;
    if (!stream) return;
    stream.scrollTo({ top: stream.scrollHeight, behavior: "smooth" });
    followReadable(true);
  };
  const stopVoice = () => recognition.current?.stop();
  const startVoice = async () => {
    if (!connectedRef.current || recognition.current || preparingVoice) return;
    const Recognition = speechRecognitionConstructor();
    if (!Recognition) {
      setVoiceFailure({ key: "mobile.voice.unavailable" });
      return;
    }
    const request = voiceRequest.current + 1;
    voiceRequest.current = request;
    const language = speechTag();
    setPreparingVoice(true);
    setVoiceStatus({ key: "mobile.voice.checking" });
    setVoiceFailure(null);
    // Read at the tap, like the language: the menu's choice applies to the
    // next dictation without this closure having to follow it.
    const mode = readFlag("voiceRemote") ? "remote" : await prepareOnDeviceSpeech(Recognition, language);
    if (voiceRequest.current !== request) return;
    setPreparingVoice(false);
    if (!connectedRef.current) {
      setVoiceStatus(null);
      setVoiceFailure({ key: "mobile.voice.disconnected" });
      return;
    }
    if (mode === "installed") {
      setVoiceStatus({ key: "mobile.voice.installed", language });
      return;
    }
    voiceProgress.current = DICTATION_START;
    setVoicePreview("");
    setVoiceFailure(null);
    // The session restarts the browser's recognizer through pauses, so
    // "listening" holds from the tap until the stop (`voiceSession.ts`).
    const session: DictationSession = startDictation(Recognition, { lang: language, local: mode === "local" }, {
      onStart: () => {
        setListening(true);
        setVoiceStatus({ key: mode === "local" ? "mobile.voice.listeningLocal" : "mobile.voice.listeningRemote" });
      },
      onResult: (event) => {
        const reading = readDictation(event);
        const step = advanceDictation(voiceProgress.current, reading.heard);
        voiceProgress.current = step.progress;
        // Speech is inserted into the current prompt but deliberately not
        // submitted. The user can review/edit it before pressing Enter.
        if (step.insert) setDraft((current) => `${current}${current && !current.endsWith(" ") ? " " : ""}${step.insert}`);
        setVoicePreview(dictationPreview(step.progress, reading.interim));
      },
      // A new recognizer's result list starts empty: everything the last one
      // heard is in the draft already, and none of it is read back.
      onRestart: () => { voiceProgress.current = DICTATION_START; },
      onError: (message) => setVoiceFailure({ key: message }),
      onLevel: (level) => paintMicLevel(dictateButton.current, level),
      onEnd: () => {
        if (recognition.current === session) recognition.current = undefined;
        setListening(false);
        setVoiceStatus(null);
      },
    });
    recognition.current = session;
  };
  useEffect(() => () => {
    voiceRequest.current += 1;
    const active = recognition.current;
    recognition.current = undefined;
    if (active) {
      active.abort();
      paintMicLevel(dictateButton.current, null);
    }
  }, [tab.id]);
  const dictateLabel = t(listening ? "mobile.voice.stop" : preparingVoice ? "mobile.voice.preparing" : "mobile.voice.dictate");
  const sayVoice = (note: VoiceNote) => t(note.key, note.language ? { language: note.language } : undefined);
  /** A browser without Web Speech says so from the start: no action clears
   * that, so it is derived rather than stored beside the failures that do. */
  const voiceProblem: VoiceNote | null = voiceFailure ?? (voiceAvailable ? null : { key: "mobile.voice.unavailable" });
  const voiceLine = voiceProblem ? sayVoice(voiceProblem)
    : voicePreview ? t("mobile.voice.heard", { text: voicePreview })
    : voiceStatus ? sayVoice(voiceStatus) : "";
  /** What the sheet paints: the live step, or — between the tap and the
   * session's redraw — the answered one, listed but not tappable, so the sheet
   * does not blink empty on the way to the next step. */
  /** The model chip's label: the model the session prints, with the reasoning
   * effort beside it where the session prints one too (Antigravity). Without a
   * readable status it falls back to the tab's published model — the desktop's
   * reading of this same line, composed the same way, or the transcript's id
   * behind it. */
  const modelChip = status?.model
    ? (status.effort ? `${status.model} · ${status.effort}` : status.model)
    : tab.agent_model ?? "Model";
  const shownStep = listedStep ?? (answered && picker ? answered : null);
  /** The highlighted row — where it was before a reveal walk moved it. */
  const shownAt = reveal?.origin ?? picker?.options[picker.current]?.number;
  const pickerOptions: SheetOption[] = (shownStep?.options ?? []).map((option) => ({
    key: String(option.number),
    label: option.label,
    description: option.description,
    current: option.number === shownAt,
  }));
  /** Antigravity's effort step: the stops its slider is drawing for the model
   * the sheet just walked to, in its own words. */
  const effortOptions: SheetOption[] = (effortStep && effortSlider ? effortSlider.stops : []).map((stop, index) => ({
    key: String(index),
    label: stop.label,
    description: stop.description,
    current: index === effortSlider?.current,
  }));
  const modeOptions: SheetOption[] = modes.map((choice) => ({
    key: choice.value,
    label: choice.label,
    description: choice.description,
    current: choice.value === activeMode,
    pending: choice.value === switching,
  }));
  const failedMode = modes.find((choice) => choice.value === switchFailed);
  const addOptions: SheetOption[] = [
    { key: "phone", label: "From this phone", description: "A photo, screenshot or file — saved to the project's inbox and referenced in the message", current: false },
    { key: "gallery", label: "From the gallery", description: "Photos and videos from this phone's gallery — saved to the project's inbox and referenced in the message", current: false },
    { key: "desktop", label: "From the desktop", description: "The desktop's clipboard image or a recent screenshot or picture — copied to the project's inbox and referenced in the message", current: false },
    { key: "project", label: "A project file (@)", description: "Type a path after the @ for the agent to read", current: false },
  ];
  const desktopOptions: SheetOption[] = (desktopImages ?? []).map((image) => ({
    key: image.id,
    label: image.name,
    description: desktopImageDescription(image),
    current: false,
  }));
  return <main className={`terminal-screen ${tab.kind}-tab`} style={viewportHeight ? { height: viewportHeight } : undefined}><header><button className="back" onClick={back}>‹</button><div className="terminal-title"><h1>{tab.label}</h1><small>{t(tab.kind === "agent" ? "mobile.focus.agentSession" : "mobile.focus.shellSession")}</small></div>{outbox.length > 0 && <button className="terminal-gallery" onClick={() => setGallery(true)} aria-label={t("mobile.outbox.galleryOpen", { count: outbox.length })} title={t("mobile.outbox.region")}><span aria-hidden="true">🖼</span><small>{outbox.length}</small></button>}<div className="terminal-view-switch" aria-label={t("mobile.focus.outputView")}><button className={view === "focus" ? "selected" : ""} aria-pressed={view === "focus"} aria-haspopup={chat ? "menu" : undefined} aria-expanded={chat ? focusMenu : undefined} onClick={() => {
      // An agent tab's Reader is a list once it is up: where it reads from.
      if (chat && view === "focus") setFocusMenu((open) => !open);
      else chooseView("focus");
    }}>{t("mobile.focus.reader")}{chat && <span className="view-caret" aria-hidden="true" />}</button><button className={view === "terminal" ? "selected" : ""} aria-pressed={view === "terminal"} onClick={() => { setFocusMenu(false); chooseView("terminal"); }}>{t("mobile.focus.terminal")}</button></div><span className={connected ? "lamp" : "lamp off"} /></header>
    {focusMenu && chat && view === "focus" && <div className="focus-menu-backdrop" role="presentation" onClick={() => setFocusMenu(false)}>
      <div className="focus-menu" role="menu" aria-label={t("mobile.focus.source")} onClick={(event) => event.stopPropagation()}>
        {/* Dimmed when the stored session cannot be read (an agent whose
            transcript Eldrun does not read, no session id yet); the row then
            says which, rather than doing nothing. */}
        <button role="menuitemradio" aria-checked={sessionShown} aria-disabled={transcript?.available ? undefined : "true"} className={transcript?.available ? undefined : "unavailable"} onClick={() => {
          if (!transcript?.available) return;
          setFocusSource("session");
          setFocusMenu(false);
        }}>
          <span><strong>{t("mobile.focus.session")} {isUntested("mobile.focus.session") && <em>{t("mobile.focus.untested")}</em>}</strong><small>{transcript?.available ? t("mobile.focus.sessionHint") : t(noSessionReason(transcript))}</small></span>
          {sessionShown && <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 13 4.5 4.5L19 7" /></svg>}
        </button>
        <button role="menuitemradio" aria-checked={!sessionShown} onClick={() => {
          setFocusSource("screen");
          setFocusMenu(false);
        }}>
          <span><strong>{t("mobile.focus.screen")}</strong><small>{t("mobile.focus.screenHint")}</small></span>
          {!sessionShown && <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 13 4.5 4.5L19 7" /></svg>}
        </button>
        {/* Spoken from the stored session only: its answers arrive whole, where
            the screen's are still being drawn. */}
        <button role="menuitemcheckbox" aria-checked={readAloud && speechAvailable} aria-disabled={speechAvailable ? undefined : "true"} className={speechAvailable ? undefined : "unavailable"} onClick={() => {
          if (!speechAvailable) return;
          // The tap is the gesture a browser wants before a page may speak.
          if (readAloud) stopSpeaking();
          else unlockSpeech();
          writeFlag("focusReadAloud", !readAloud);
          setReadAloud(!readAloud);
          setFocusMenu(false);
        }}>
          <span><strong>{t("mobile.speech.auto")} {isUntested("mobile.focus.readAloud") && <em>{t("mobile.focus.untested")}</em>}</strong><small>{t(speechAvailable ? "mobile.speech.autoHint" : "mobile.speech.unavailable")}</small></span>
          {readAloud && speechAvailable && <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 13 4.5 4.5L19 7" /></svg>}
        </button>
        <button role="menuitemcheckbox" aria-checked={voiceRemote && voiceLocalOffered} aria-disabled={voiceLocalOffered ? undefined : "true"} className={voiceLocalOffered ? undefined : "unavailable"} onClick={() => {
          if (!voiceLocalOffered) return;
          writeFlag("voiceRemote", !voiceRemote);
          setVoiceRemote(!voiceRemote);
        }}>
          <span><strong>{t("mobile.voice.remote")} {isUntested("mobile.voice.remote") && <em>{t("mobile.focus.untested")}</em>}</strong><small>{t(voiceLocalOffered ? "mobile.voice.remoteHint" : "mobile.voice.remoteOnly")}</small></span>
          {voiceRemote && voiceLocalOffered && <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 13 4.5 4.5L19 7" /></svg>}
        </button>
        {/* The one language for both directions — what an answer is read in
            and what dictation is listened for. The phone's own is the default,
            and the row says which language that turned out to be. */}
        <button role="menuitem" aria-haspopup="dialog" aria-expanded={speechLangSheet} onClick={() => {
          setFocusMenu(false);
          setSpeechLangSheet(true);
        }}>
          <span><strong>{t("mobile.speech.language")} {isUntested("mobile.speech.language") && <em>{t("mobile.focus.untested")}</em>}</strong><small>{speechLangSummary(speechLang, t)}</small></span>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
        </button>
      </div>
    </div>}
    <div className="terminal-body">
      <div ref={host} className={`terminal${view === "focus" ? " focus-source" : ""}`} />
      <div ref={wideHint} className="terminal-wide-hint" aria-hidden="true" />
      {/* The stored session does not depend on the screen, so a full-screen
          agent (OpenCode's TUI) still reads as a chat in Focus. */}
      {view === "focus" && altScreen && !sessionShown && <div className="alt-screen-notice"><strong>{t("mobile.focus.altScreen")}</strong><span>{t("mobile.focus.altScreenHint")}</span>{openCode && !transcript?.available && <span>{t("mobile.focus.openCodeMini")}</span>}{tab.kind === "agent" && transcript?.available && <button onClick={() => setFocusSource("session")}>{t("mobile.focus.sessionHint")}</button>}<button className="primary" onClick={() => chooseView("terminal")}>{t("mobile.focus.altScreenOpen")}</button></div>}
      {view === "focus" && (!altScreen || sessionShown) && <>
        <section ref={readableHost} className="readable-output" aria-label="Session output" aria-live="polite"
          onScroll={(event) => {
            const stream = event.currentTarget;
            followReadable(stream.scrollHeight - stream.scrollTop - stream.clientHeight < 120);
            checkPinnedPrompt();
          }}>
          {sessionShown
            ? (transcript && sessionEntries.length === 0 && !liveQuestion && !sessionBusy
              ? <div className="readable-empty"><strong>{t("mobile.transcript.empty")}</strong><span>{t("mobile.transcript.emptyHint")}</span></div>
              : <div className="readable-lines chat transcript" data-testid="session-transcript">
                  {transcript?.truncated && !sinceClear && <button className="readable-earlier" onClick={() => setTranscriptLimit((limit) => limit + TRANSCRIPT_STEP)}>{t("mobile.transcript.earlier")}</button>}
                  <TranscriptTurns entries={sessionEntries} cutLabel={t("mobile.transcript.cut")} promptLabel={t("mobile.transcript.prompt")} />
                  {liveQuestion && <div className="transcript-screen" role="group" aria-label={t("mobile.transcript.question")}>
                    <small>{t("mobile.transcript.question")}{isUntested("mobile.focus.onScreen") && <> · {t("mobile.focus.untested")}</>}</small>
                    {/* The screen the dialog was drawn onto, as the screen drew
                        it — in Claude Code's permission dialog the file and the
                        diff it is asking about. Bounded by `readSelectPrompt`
                        to what the rows answer: the turn above it is already in
                        the conversation, and an unprompted session's banner is
                        not a question. The rows themselves are replaced by the
                        list below — a highlight walked with arrow keys is not
                        something a phone can do — and the question above them
                        is that list's heading. */}
                    {questionContext.length > 0 && <ReadableTurns lines={questionContext} chat={chat} agent={agentLabel} promptLabel={t("mobile.transcript.prompt")} columns={paneColumns.current} />}
                    <QuestionList prompt={liveQuestion} question={questionAsk} sent={sentSignature === questionSignature ? questionSent?.number : undefined} sendingLabel={t("mobile.transcript.answering")} onPick={answerQuestion} />
                  </div>}
                  {sessionBusy && <div className="transcript-working" role="status">
                    <span className="transcript-working-dots" aria-hidden="true"><i /><i /><i /></span>
                    {workingModel ? t("mobile.focus.workingModel", { model: workingModel }) : t("mobile.focus.working")}
                    {workFacts.length > 0 && <small className="transcript-working-facts">
                      {workFacts.join(" · ")}
                      {isUntested("mobile.focus.workingFacts") && <em> · {t("mobile.focus.untested")}</em>}
                    </small>}
                  </div>}
                </div>)
            : painted.length === 0 && visibleChunks.length === 0 && earlier.open.length === 0
            ? <div className="readable-empty"><strong>Waiting for output</strong><span>The exact terminal is running behind this view.</span></div>
            : <div className={chat ? "readable-lines chat" : "readable-lines"}>
                {clipped && <div className="readable-notice">{TRUNCATION_NOTICE}</div>}
                {hiddenLines > 0 && <button className="readable-earlier" onClick={showEarlier}>Show earlier output ({hiddenLines.toLocaleString()} lines)</button>}
                {hiddenLines === 0 && earlier.dropped && <div className="readable-notice">{TRUNCATION_NOTICE}</div>}
                {/* An agent's output is laid out as ONE stream: grouped piece by
                    piece, a turn that ran from the history into the live
                    screen was cut in two where they met — and that seam moved
                    every time rows scrolled into the history. A shell has no
                    turns, so it keeps the memoized chunks. */}
                {chat
                  ? <ReadableTurns lines={screenStream} chat agent={agentLabel} promptLabel={t("mobile.transcript.prompt")} columns={paneColumns.current} />
                  : <>
                    {visibleChunks.map((chunk) => <ReadableTurns key={chunk.id} lines={chunk.lines} chat={false} promptLabel={t("mobile.transcript.prompt")} />)}
                    <ReadableTurns lines={earlier.open} chat={false} promptLabel={t("mobile.transcript.prompt")} />
                    <ReadableTurns lines={painted} chat={false} promptLabel={t("mobile.transcript.prompt")} />
                  </>}
              </div>}
        </section>
        {pinnedPrompt && <button className="readable-pinned-prompt" aria-label={t("mobile.focus.lastPrompt")}
          onClick={() => pinnedPromptEl.current?.scrollIntoView({ block: "start", behavior: "smooth" })}>
          <span className="readable-pinned-prompt-text">{pinnedPrompt}</span>
          {isUntested("mobile.focus.pinnedPrompt") && <em>{t("mobile.focus.untested")}</em>}
        </button>}
        {statusStrip && statusSwipe && <div className="focus-statusline" role="status" aria-label={t("mobile.focus.statusLine")}>
          <div className="focus-statusline-head"><strong>{t("mobile.focus.statusLine")} {isUntested("mobile.focus.statusLine") && <small>{t("mobile.focus.untested")}</small>}</strong><button onClick={() => setStatusStrip(false)} aria-label={t("mobile.focus.statusLineHide")}>✕</button></div>
          {frameStatus.length
            ? frameStatus.map((row, i) => <div key={i} className="focus-statusline-row">{row}</div>)
            : <div className="focus-statusline-empty">{t("mobile.focus.statusLineEmpty")}</div>}
        </div>}
        {/* A chat copies message by message and picks its source under the
            Focus button, so nothing floats over its newest lines. */}
        {!chat && lines.length > 0 && <div className="readable-tools">
          <button onClick={() => void copyReadable()} aria-label="Copy the session text">{copied ? "Copied" : "Copy"}</button>
        </div>}
        {!atBottom && <button className="readable-jump" onClick={jumpToLatest}>Jump to latest ↓</button>}
      </>}
    </div>
    <div className="terminal-controls">
      {tab.kind === "agent" && voiceLine && <div className={voiceProblem ? "voice-feedback error" : "voice-feedback"} role={voiceProblem ? "alert" : "status"} aria-live="polite">{voiceLine}{listening && !voiceProblem && !voicePreview && isUntested("mobile.voice.keepListening") && <em>{t("mobile.focus.untested")}</em>}</div>}
      {stoppedReason && <div className="voice-feedback error" role="alert">{stoppedReason}</div>}
      {sendFailed && !stoppedReason && <div className="voice-feedback error" role="alert">That did not reach the desktop — the connection dropped. It will retry on its own.</div>}
      {clearRefused && liveBusy && <div className="voice-feedback" role="status">{t("mobile.composer.clearBusy")}{isUntested("mobile.composer.clearBusy") && <> · <em>{t("mobile.focus.untested")}</em></>}</div>}
      {lastSent && !sessionShown && <div className="last-sent"><span>Sent</span><p>{lastSent}</p></div>}
      {uploads.map((upload) => upload.failure
        ? <div key={upload.id} className="inbox-upload error" role="alert"><strong>{upload.name}</strong><span>{upload.failure}</span><button onClick={() => dismissUpload(upload.id)} aria-label={`Dismiss ${upload.name}`}>✕</button></div>
        : <div key={upload.id} className="inbox-upload" role="status"><strong>{upload.name}</strong><span>{upload.source === "desktop" ? "Copying from the desktop…" : "Sending to the project inbox…"}</span></div>)}
      {(tab.kind === "agent" || status?.branch || contextLeft || shownLimits.session || shownLimits.week) && <div className="session-facts">
        {/* An agent tab's model, mode and status lead the row as tappable facts:
            the composer keeps the whole bar for the draft and its buttons. */}
        {tab.kind === "agent" && <>
          <button className="fact-action" onClick={() => setStatusSheet(true)} aria-haspopup="dialog" aria-expanded={statusSheet} title="Session status and the agent's own usage"><span className={`fact-lamp ${lamp}`} aria-hidden="true" /><span className="fact-action-label">Status</span></button>
          <button className="fact-action" disabled={!connected} onClick={selectModel} aria-haspopup="dialog" aria-expanded={modelSheet} title="Choose the model (/model)"><span className="fact-action-label">{modelChip}</span></button>
          <button className="fact-action" disabled={!connected} onClick={openModeSheet} aria-haspopup={modes.length > 0 ? "dialog" : undefined} aria-expanded={modes.length > 0 ? modeSheet : undefined} title={modes.length > 0 ? "Choose the permission mode" : "Switch mode (Shift+Tab)"}><span className="fact-action-label">{status?.mode ?? activeMode ?? "Mode"}</span></button>
        </>}
        {status?.branch && <span className="fact-branch">⎇ {status.branch}</span>}
        {contextLeft && <span className="fact-context">{contextLeft} context</span>}
        {shownLimits.session && <span className={`fact-limit${shownLimits.session.percent >= 90 ? " high" : ""}`} title={shownLimits.session.resets ? resetText(shownLimits.session.resets, new Date()) : undefined}>{t("mobile.facts.session", { percent: Math.round(100 - shownLimits.session.percent) })}</span>}
        {shownLimits.week && <span className={`fact-limit${shownLimits.week.percent >= 90 ? " high" : ""}`} title={shownLimits.week.resets ? resetText(shownLimits.week.resets, new Date()) : undefined}>{t("mobile.facts.week", { percent: Math.round(100 - shownLimits.week.percent) })}</span>}
      </div>}
      <div className="prompt-composer">
        {slashMenu.length > 0 && <div className="slash-menu" role="group" aria-label={t("mobile.slash.title")}>
          <div className="slash-menu-head">{t("mobile.slash.title")} {isUntested("mobile.composer.slash") && <em>{t("mobile.focus.untested")}</em>}</div>
          {/* Pointer-down is held back so a tap does not take the focus off
              the field: the keyboard stays up for the argument. */}
          {slashMenu.map((suggestion) => <div key={suggestion.line} className={`slash-row${suggestion.used ? " used" : ""}`}>
            <button className="slash-pick" onPointerDown={(event) => event.preventDefault()} onClick={() => pickSlash(suggestion)}>
              <strong>{suggestion.line}</strong>
              {suggestion.used ? <small>{t("mobile.slash.recent")}{suggestion.description ? ` · ${suggestion.description}` : ""}</small> : suggestion.description && <small>{suggestion.description}</small>}
            </button>
            {suggestion.used && <button className="slash-forget" onPointerDown={(event) => event.preventDefault()} onClick={() => forgetSlash(suggestion.line)} aria-label={t("mobile.slash.forget", { command: suggestion.line })} title={t("mobile.slash.forget", { command: suggestion.line })}>✕</button>}
          </div>)}
        </div>}
        <div className="composer-field">
          <textarea ref={composerInput} value={draft} disabled={!connected} rows={1} aria-label={tab.kind === "agent" ? "Message agent" : "Shell command"} placeholder={connected ? (tab.kind === "agent" ? "Message the agent…" : "Type a command…") : "Reconnecting…"} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey) return;
            // Enter confirms a candidate inside an IME composition (CJK keyboards,
            // and 229 is what Android keyboards report mid-composition); that
            // one belongs to the keyboard, not to the send.
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            event.preventDefault();
            submitDraft();
          }} />
          {/* One slot: with a draft it empties the draft; empty, an agent tab's
              field offers /clear there instead, which costs the chip row nothing. */}
          {draft
            ? <button className="composer-clear" onClick={clearDraft} aria-label={t("mobile.composer.clear")} title={t("mobile.composer.clear")}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg></button>
            : tab.kind === "agent" && <button className="composer-clear" disabled={!connected} onClick={clearConversation} aria-label={t("mobile.composer.clearChat")} title={t("mobile.composer.clearChat")}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4V5Z" /><path d="m10 8.5 4 4M14 8.5l-4 4" /></svg></button>}
        </div>
        <div className="composer-bar">
          {tab.kind === "agent" && <>
            <input ref={fileInput} type="file" multiple hidden aria-hidden="true" tabIndex={-1} data-testid="inbox-file-input" onChange={(event) => { attachFromPhone(event.target.files); event.target.value = ""; }} />
            <input ref={galleryInput} type="file" accept="image/*,video/*" multiple hidden aria-hidden="true" tabIndex={-1} data-testid="inbox-gallery-input" onChange={(event) => { attachFromPhone(event.target.files); event.target.value = ""; }} />
            <button className="composer-add" disabled={!connected} onClick={() => setAddSheet(true)} aria-label="Add to the message" aria-haspopup="dialog" aria-expanded={addSheet} title="Add a photo or file from this phone, pictures from its gallery, an image from the desktop, or a project file (@)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg></button>
          </>}
          <span className="composer-spacer" />
          {tab.kind === "agent" && <button className={`composer-dictate${listening ? " listening" : ""}`} disabled={!connected || !voiceAvailable || preparingVoice} title={t(voiceAvailable ? "mobile.voice.hint" : "mobile.voice.hintUnavailable")} aria-label={dictateLabel} aria-pressed={listening} ref={dictateButton} onClick={listening ? stopVoice : () => void startVoice()}>{listening ? <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1" /></svg> : <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M6 11a6 6 0 0 0 12 0M12 17v4M8 21h8" /></svg>}</button>}
          <button className="send-icon" disabled={!connected || !draft.trim()} onClick={submitDraft} aria-label="Send" title="Send"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 4 16 8-16 8 3-8-3-8Z" /><path d="M7 12h13" /></svg></button>
        </div>
      </div>
      <div className="keys">
      <button className={ctrl ? "selected" : ""} aria-pressed={ctrl} disabled={!connected} onClick={() => setCtrl((on) => !on)}>Ctrl</button><button disabled={!connected} onClick={() => press("\u001b")}>Esc</button><button disabled={!connected} onClick={() => press("\t")}>Tab</button><button disabled={!connected} onClick={() => press("\u001b[D")}>←</button><button disabled={!connected} onClick={() => press("\u001b[A")}>↑</button><button disabled={!connected} onClick={() => press("\u001b[B")}>↓</button><button disabled={!connected} onClick={() => press("\u001b[C")}>→</button><button disabled={!connected} onClick={() => press("\r")}>Enter</button><button disabled={!connected} onClick={() => press("\u007f")}>⌫</button><button className="danger" disabled={!connected} onClick={() => window.confirm("Send interrupt (Ctrl+C)?") && type("\u0003")}>Interrupt</button>
      </div>
    </div>
    {modelSheet && (effortStep
      ? <OptionSheet
        title={t("mobile.model.effortTitle", { model: effortStep })}
        note={{ text: isUntested("mobile.model.effort")
          ? `${t("mobile.model.effortHint")} · ${t("mobile.focus.untested")}`
          : t("mobile.model.effortHint") }}
        options={effortOptions}
        waiting={connected ? "Waiting for the session…" : "Waiting for the connection…"}
        busy={effortOptions.length === 0}
        onPick={chooseEffort}
        onClose={closeModelSheet}
      />
      : <OptionSheet
        title={shownStep?.title ?? "Select model"}
        options={pickerOptions}
        waiting={!connected
          ? "Waiting for the connection…"
          : answered ? "Waiting for the session…" : "Waiting for the session's model picker…"}
        busy={shownStep != null && (pickerStep == null || reveal != null || effortFor != null)}
        onPick={chooseModel}
        onClose={closeModelSheet}
      />)}
    {speechLangSheet && <SpeechLangSheet chosen={speechLang} onChoose={setSpeechLang} onClose={() => setSpeechLangSheet(false)} />}
    {addSheet && <OptionSheet
      title="Add to the message"
      options={addOptions}
      waiting=""
      busy={false}
      onPick={pickAdd}
      onClose={() => setAddSheet(false)}
    />}
    {desktopSheet && <OptionSheet
      title="From the desktop"
      note={desktopFailure
        ? { text: desktopFailure, error: true }
        : desktopImages?.length ? { text: "Pick one to copy it into the project's inbox and reference it in the message." } : undefined}
      options={desktopOptions}
      waiting={desktopImages === null
        ? "Looking on the desktop…"
        : desktopFailure ? "Close and try again." : "Nothing to attach — copy an image or take a screenshot on the desktop first."}
      busy={false}
      onPick={attachFromDesktop}
      onClose={() => setDesktopSheet(false)}
    />}
    {modeSheet && <OptionSheet
      title="Permission mode"
      note={failedMode
        ? { text: `This session did not switch to ${failedMode.label}; it is back in the mode it was in.`, error: true }
        : fixedMode ? { text: t("mobile.focus.modeFixed") } : undefined}
      options={modeOptions}
      waiting={fixedMode ? t("mobile.focus.modeFixed") : "This session reports no mode."}
      busy={switching !== "" || fixedMode}
      onPick={(key) => void applyMode(key)}
      onClose={() => { if (!switching) setModeSheet(false); }}
    />}
    {statusSheet && <StatusSheet tab={tab} live={status} onLimits={setLimits} onClose={() => setStatusSheet(false)} />}
    {/* The viewer covers the phone; the gallery stays chosen behind it, so
        closing the file lands back on the grid. */}
    {gallery && !outboxOpen && <OutboxGallery scope={outboxScope} files={outbox} onOpen={openOutbox} onDetails={setOutboxOpen} onDelete={removeOutbox} onClose={() => setGallery(false)} />}
    {outboxOpen && <OutboxViewer key={`${tab.id}/${outboxOpen.name}`} scope={outboxScope} file={outboxOpen} pictures={outboxPictures} onStep={setOutboxOpen} onClose={() => setOutboxOpen(null)} />}

  </main>;
}
