import { useT, type TranslationKey } from "../../../src/lib/i18n";
import { OutboxViewer } from "../components/OutboxViewer";
import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  ApiError,
  api,
  attachDesktopImage,
  getAgentStatus,
  getTranscript,
  listDesktopImages,
  listOutbox,
  MAX_INBOX_FILE,
  outboxFileUrl,
  uploadToInbox,
  type DesktopImage,
  type OutboxFile,
  type SessionTranscript,
  type TabRow,
} from "../api";
import { readTerminalView, writeTerminalView, type TerminalViewChoice } from "../prefs";
import { TERMINAL_PROTOCOL, TERMINAL_SIZE } from "../terminal/protocol";
import { readableRange, readableScreen, readableText, TRUNCATION_NOTICE, type ReadableLine } from "../terminal/readableScreen";
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
import { inputFrameStart, sessionStatus, shortenPath, statusFrameLines, type SessionStatus } from "../terminal/statusLine";
import { installFocusSwipe } from "../terminal/focusSwipe";
import { readSelectPrompt, selectKeys, selectSignature } from "../terminal/selectPrompt";
import {
  isOpenCodeTab,
  openCodePickKeys,
  readOpenCodePicker,
  OPENCODE_MODEL_KEYS,
} from "../terminal/openCodeMini";
import { currentMode, modeChoices, modeFixed, shiftTabKey } from "../terminal/agentModes";
import { agentInputWrites } from "../terminal/composer";
import { chatTurns, isPromptEcho } from "../terminal/chatTurns";
import { answerHtml } from "../terminal/answerMarkdown";
import { transcriptTurns } from "../terminal/transcriptTurns";
import { MAX_PENDING, pendingPrompt, withPending, type PendingPrompt } from "../terminal/pendingPrompts";
import { oldestFirst, placeOutbox, type OutboxPlacement } from "../terminal/outboxTimeline";
import { resetText, StatusSheet } from "./StatusSheet";
import { limitMeters, parseUsageReport, type LimitMeters } from "../../../shared/usageReport";
import {
  prepareOnDeviceSpeech,
  speechRecognitionConstructor,
  speechRecognitionError,
  speechRecognitionSupported,
  advanceDictation,
  DICTATION_START,
  dictationPreview,
  readDictation,
  settleDictation,
  type DictationProgress,
  type MobileSpeechRecognition,
} from "../voiceInput";

/** A line the dictation strip shows: a key, not a sentence, so switching the
 * language retranslates what is already on screen. */
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

function ageLabel(seconds: number) {
  if (seconds < 60) return "just now";
  if (seconds < 3_600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3_600)} h ago`;
  return `${Math.round(seconds / 86_400)} d ago`;
}

function sizeLabel(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/** How often the project's outbox is re-read while this screen is on — a
 * directory listing on the sidecar, no desktop round trip, and skipped while
 * the page is hidden. */
const OUTBOX_POLL = 8_000;

/** How often an agent tab re-reads its CLI's usage panel for the facts row's
 * 5h/week figures. The desktop answers from a 60 s cache and otherwise runs
 * the CLI once (`services::agent_usage`), so this stays well above that. */
const LIMITS_POLL = 120_000;

/** Whether two outbox listings would paint the same strip, so a poll that
 * found nothing new does not re-render every thumbnail. */
/** Whether two reads of the stored session carry the same turns, so an
 * unchanged answer does not repaint the view. */
function sameTranscript(a: SessionTranscript, b: SessionTranscript): boolean {
  return a.available === b.available && a.truncated === b.truncated && a.version === b.version
    && a.entries.length === b.entries.length
    && a.entries.every((entry, index) => entry.kind === b.entries[index].kind && entry.text === b.entries[index].text && entry.cut === b.entries[index].cut);
}

function sameOutbox(a: OutboxFile[], b: OutboxFile[]) {
  return a.length === b.length && a.every((image, i) => image.name === b[i].name && image.modified === b[i].modified && image.size === b[i].size);
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
 * emitted. Style is never inferred from the text — see `readableScreen`. */
const ReadableRow = memo(function ReadableRow({ line }: { line: ReadableLine }) {
  if (line.spans.length === 0) return <div className="readable-blank" aria-hidden="true" />;
  return <div className="readable-line">{line.spans.map((span, index) => (
    span.className || span.color || span.background
      ? <span key={index} className={span.className} style={{ color: span.color, background: span.background }}>{span.text}</span>
      : <span key={index}>{span.text}</span>
  ))}</div>;
});

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
  if (!chat) return <>{lines.map((line) => <ReadableRow key={line.key} line={line} />)}</>;
  return <>{chatTurns(lines, agent, columns).map((turn) => turn.role === "user"
    ? <div key={turn.key} className="readable-turn user" role="group" aria-label={promptLabel}>
        {(turn.prompt ?? turn.lines).map((line) => <ReadableRow key={line.key} line={line} />)}
      </div>
    : <div key={turn.key} className={turn.answer ? "readable-turn agent answer" : "readable-turn agent"}>
        {(turn.answer ?? turn.lines).map((line) => <ReadableRow key={line.key} line={line} />)}
      </div>)}</>;
});

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
const TranscriptTurns = memo(function TranscriptTurns({ entries, cutLabel, promptLabel, placement, renderFiles }: {
  entries: SessionTranscript["entries"];
  cutLabel: string;
  promptLabel: string;
  /** Where the files the agent sent sit between the turns (`placeOutbox`). */
  placement: OutboxPlacement;
  renderFiles: (files: readonly OutboxFile[]) => ReactNode;
}) {
  // One bubble per record, keyed by its time (`transcriptTurns`).
  const turns = useMemo(() => transcriptTurns(entries), [entries]);
  return <>{renderFiles(placement.before)}{turns.map((turn) => <Fragment key={turn.key}>
    {turn.kind === "prompt"
      ? <div className="readable-turn user" role="group" aria-label={promptLabel}>
          <p className="transcript-text">{turn.text}</p>
          {turn.cut && <small className="transcript-cut">{cutLabel}</small>}
        </div>
      : <div className="readable-turn agent answer">
          <AnswerText text={turn.text} />
          {turn.cut && <small className="transcript-cut">{cutLabel}</small>}
        </div>}
    {renderFiles(placement.after.get(turn.index) ?? [])}
  </Fragment>)}</>;
});

/** One file the agent sent (`eldrun-send`) as a message of its own in the
 * Focus chat, on the agent's side: a picture shows itself and opens full
 * screen on a tap, like an image in a messenger; any other file is a card
 * that opens, or downloads, the way the strip's entry does. Where it sits in
 * the chat is `outboxTimeline`'s call. */
function OutboxMessage({ tabId, file, onOpen, onDetails }: { tabId: string; file: OutboxFile; onOpen: (file: OutboxFile) => void; onDetails: (file: OutboxFile) => void }) {
  const t = useT();
  const isImage = file.kind.startsWith("image/");
  const download = !isImage && !file.kind.startsWith("text/") && file.kind !== "application/pdf";
  const label = t("mobile.outbox.open", { name: file.name });
  const card = <>
    <span aria-hidden="true">{file.kind === "application/pdf" ? "PDF" : file.kind.startsWith("text/") ? "≡" : "↓"}</span>
    <strong>{file.name}</strong>
  </>;
  return <div className="readable-turn agent outbox-message" role="group" aria-label={t("mobile.outbox.from")}>
    {isImage
      ? <button className="outbox-message-image" onClick={() => onOpen(file)} aria-label={label} title={file.name}><img src={outboxFileUrl(tabId, file.name)} alt="" loading="lazy" decoding="async" /></button>
      : download
        ? <a className="outbox-message-file" href={outboxFileUrl(tabId, file.name, true)} download={file.name} aria-label={label}>{card}</a>
        : <button className="outbox-message-file" onClick={() => onOpen(file)} aria-label={label} title={file.name}>{card}</button>}
    <small className="outbox-message-meta">
      <span>{isImage ? `${file.name} · ` : ""}{ageLabel(Math.max(0, Math.floor(Date.now() / 1000) - file.modified))}{!isImage && ` · ${sizeLabel(file.size)}`}</span>
      <em>{t("mobile.outbox.untested")}</em>
      {!isImage && <button className="outbox-details" onClick={() => onDetails(file)} aria-label={t("mobile.outbox.actions", { name: file.name })}>⋯</button>}
    </small>
  </div>;
}

/** The stored preference key for a tab: the agent behind it, or the shell. */
function viewAgentOf(tab: TabRow): string {
  return tab.kind === "agent" ? (tab.agent_label ?? "agent") : "shell";
}

interface SheetOption {
  key: string;
  label: string;
  description?: string;
  /** The option the session is in right now. */
  current: boolean;
  /** The option a switch is being applied to. */
  pending?: boolean;
}

/**
 * A choice the session offers, as a phone list: the sheet the composer chips
 * open instead of leaving the reader to walk a TUI dialog with the arrow keys.
 * It renders what the caller resolved — the dialog's own rows, or the modes a
 * session's status line says it has — and reports taps back. No parsing, no
 * keystrokes.
 */
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

function OptionSheet({ title, note, options, waiting, busy, onPick, onClose }: {
  title: string;
  note?: { text: string; error?: boolean };
  options: SheetOption[];
  /** Shown while the list is still empty. */
  waiting: string;
  busy: boolean;
  onPick: (key: string) => void;
  onClose: () => void;
}) {
  return <div className="sheet-backdrop" role="presentation" onClick={onClose}>
    <section className="option-sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(event) => event.stopPropagation()}>
      <span className="sheet-grip" aria-hidden="true" />
      <header>
        <button className="sheet-close" onClick={onClose} aria-label="Close">✕</button>
        <h2>{title}</h2>
        <span className="sheet-close" aria-hidden="true" />
      </header>
      {note && <p className={note.error ? "sheet-note error" : "sheet-note"} role={note.error ? "alert" : undefined}>{note.text}</p>}
      {options.length === 0
        ? <p className="sheet-note">{waiting}</p>
        : <ul className="option-list">{options.map((option) => <li key={option.key}>
            <button className={option.current ? "current" : ""} aria-current={option.current || undefined} disabled={busy} onClick={() => onPick(option.key)}>
              <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
              {option.pending
                ? <span className="sheet-pending" role="status">Switching…</span>
                : option.current && <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 13 4.5 4.5L19 7" /></svg>}
            </button>
          </li>)}</ul>}
    </section>
  </div>;
}

export function Terminal({ tab, back }: { tab: TabRow; back: () => void }) {
  const t = useT();
  const host = useRef<HTMLDivElement>(null);
  const wideHint = useRef<HTMLDivElement>(null);
  const readableHost = useRef<HTMLElement>(null);
  const composerInput = useRef<HTMLTextAreaElement>(null);
  /** Re-reads the emulated screen on demand — used when Focus is opened, so the
   * reading view is current instead of waiting for the next output byte. */
  const refreshReadable = useRef<() => void>(() => {});
  const write = useRef<(value: string) => boolean>(() => false);
  const recognition = useRef<MobileSpeechRecognition>();
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
  const [ctrl, setCtrl] = useState(false);
  const [sendFailed, setSendFailed] = useState(false);
  /** Terminal by default; whatever the reader last chose for this agent
   * afterwards (`prefs.readTerminalView`). */
  const [view, setView] = useState<TerminalViewChoice>(() => readTerminalView(viewAgentOf(tab)));
  const chooseView = (next: TerminalViewChoice) => {
    setView(next);
    writeTerminalView(viewAgentOf(tab), next);
  };
  const [draft, setDraft] = useState("");
  const [lines, setLines] = useState<ReadableLine[]>([]);
  const [clipped, setClipped] = useState(false);
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
  /** Whether Terminal view is panned to the newest rows. Kept from the box's
   * own scroll events rather than measured when it is wanted: a resize is the
   * moment the answer is needed and the moment it is already gone, because
   * shrinking the box raises its maximum scroll offset without moving
   * `scrollTop` — the bottom slides under the composer and the box reads as
   * scrolled up ever after. */
  const atNewest = useRef(true);
  const [lastSent, setLastSent] = useState("");
  const [copied, setCopied] = useState(false);
  const [voiceAvailable] = useState(() => speechRecognitionSupported());
  const [listening, setListening] = useState(false);
  const [preparingVoice, setPreparingVoice] = useState(false);
  const [voicePreview, setVoicePreview] = useState("");
  const [voiceStatus, setVoiceStatus] = useState<VoiceNote | null>(null);
  const [voiceFailure, setVoiceFailure] = useState<VoiceNote | null>(null);
  /** Whether the model sheet is up. It opens on the tap that sends `/model`,
   * before the session has drawn the picker it lists. */
  const [modelSheet, setModelSheet] = useState(false);
  /** The step a tap answered (`selectSignature`), while the session is still
   * painting it. A multi-step dialog draws its next list in the same place, so
   * the sheet holds until what is on screen is a *different* list — or until
   * nothing is, which is where the dialog ends. */
  const [answered, setAnswered] = useState("");
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
   * phone (the desktop's `outbox.rs`), newest first — the strip above the
   * composer, and the one way an image reaches the phone from a session: a
   * terminal carries none, and Focus classifies nothing, so a path printed
   * by the agent is never guessed at. */
  const [outbox, setOutbox] = useState<OutboxFile[]>([]);
  /** Names the strip's ✕ hid; a picture that arrives afterwards still shows. */
  const [outboxHidden, setOutboxHidden] = useState<Set<string>>(() => new Set());
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
  const [focusSource, setFocusSource] = useState<"session" | "screen">("session");
  /** Whether the tools row says why the Session toggle is dimmed. A phone
   * shows no tooltip, so the reason is spelled out on a tap instead. */
  const [sessionWhy, setSessionWhy] = useState(false);
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
    setView(readTerminalView(viewAgentOf(tab)));
    setDraft("");
    setTranscript(null);
    setPending([]);
    setFocusSource("session");
    setSessionWhy(false);
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
    setAnswered("");
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
  // long project screen, where "New shell" sits, or from far down the agents
  // list, keeps that scroll offset; focusing the composer makes the browser
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
      // waste on a phone battery — but an agent tab's composer chips still do:
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
      if (alternate) return;
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
          activeRecognition.onstart = null;
          activeRecognition.onresult = null;
          activeRecognition.onerror = null;
          activeRecognition.onend = null;
          activeRecognition.abort();
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
  }, [view, altScreen]);
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
  const sessionShown = sessionFocus && transcript?.available === true;
  /** The session chat's entries: the stored ones, with each prompt sent
   * from here held in its place (`withPending`). */
  const sessionEntries = useMemo(() => withPending(transcript?.entries ?? [], pending), [transcript, pending]);
  // A new turn in the stored session, or a file the agent sent into the
  // Focus chat, scrolls the view to it, as new screen output does, unless
  // the reader has scrolled up to read.
  useLayoutEffect(() => {
    if (!(sessionShown || (view === "focus" && outbox.length > 0)) || !atBottom) return;
    const stream = readableHost.current;
    if (stream) stream.scrollTo({ top: stream.scrollHeight });
  }, [sessionShown, transcript, pending, outbox, view, atBottom]);
  /** Reads the outbox now and every `OUTBOX_POLL` while the page is visible;
   * coming back to the page reads it at once. A listing that could not be
   * fetched keeps what was shown — the next poll retries. */
  useEffect(() => {
    setOutbox([]);
    setOutboxHidden(new Set());
    setOutboxOpen(null);
    let stopped = false;
    let inflight: AbortController | undefined;
    const poll = () => {
      if (stopped || document.visibilityState === "hidden") return;
      inflight?.abort();
      const controller = new AbortController();
      inflight = controller;
      void listOutbox(tab.id, controller.signal).then(
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
    if (!outboxOpen) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOutboxOpen(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [outboxOpen]);
  const outboxShown = useMemo(() => outbox.filter((image) => !outboxHidden.has(image.name)), [outbox, outboxHidden]);
  const hideOutbox = () => setOutboxHidden(new Set(outbox.map((image) => image.name)));
  /** A PDF opens in the browser's own viewer; a picture or text full-screen here. */
  const openOutbox = useCallback((file: OutboxFile) => {
    if (file.kind === "application/pdf") window.open(outboxFileUrl(tab.id, file.name), "_blank", "noopener");
    else setOutboxOpen(file);
  }, [tab.id]);
  /** The files as messages in the Focus chat (`OutboxMessage`). The strip's ✕
   * does not reach them: a message stays where it was posted. */
  const renderOutbox = useCallback((files: readonly OutboxFile[]) => files.map((file) => (
    <OutboxMessage key={`outbox:${file.name}`} tabId={tab.id} file={file} onOpen={openOutbox} onDetails={setOutboxOpen} />
  )), [tab.id, openOutbox]);
  const outboxPlacement = useMemo(
    () => placeOutbox(sessionEntries, outbox, transcript?.truncated === true),
    [sessionEntries, transcript?.truncated, outbox],
  );
  /** The screen has no times to place a file by, so the files close its chat. */
  const screenOutbox = useMemo(() => oldestFirst(outbox), [outbox]);
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
   * on. Shared by the composer's Send and the composer chips' slash commands. */
  const sendAgentText = (text: string) => {
    clearPending();
    return deliver(agentInputWrites(text, bracketedPaste.current()));
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
      if (/^\s*\/clear\b/u.test(draft)) setPending([]);
    } else {
      const sent = pendingPrompt(++pendingId.current, draft, transcript?.entries ?? []);
      setPending((current) => [...current, sent].slice(-MAX_PENDING));
    }
    setDraft("");
    forgetDictation();
  };
  /** The field's /clear button: the fresh conversation typing `/clear` gives, asked
   * first because the agent forgets the chat. The draft is left alone. */
  const clearConversation = () => {
    if (!window.confirm(t("mobile.composer.clearChatConfirm"))) return;
    if (sendAgentText("/clear")) setPending([]);
  };
  /** The composer's ✕: an empty draft, and the dictation transcript with it. */
  const clearDraft = () => {
    setDraft("");
    forgetDictation();
    composerInput.current?.focus();
  };
  /** The tab's own name for its agent, which is what every family rule is
   * scoped by: the mode tables, the prompt echo Kimi Code draws, and the whole
   * of OpenCode's mini interface, whose frame has no marker to be found by. */
  const agentLabel = tab.agent_label ?? tab.label;
  const openCode = tab.kind === "agent" && isOpenCodeTab(agentLabel);
  /** The facts the session prints below its own input box — the composer
   * chips' labels. Absent fields leave the chip on its generic label. */
  const status = useMemo(
    () => (tab.kind === "agent" ? sessionStatus(lines, agentLabel) : null),
    [tab.kind, lines, agentLabel],
  );
  // The mode walk reads the status between two presses, outside React's render.
  useEffect(() => { statusRef.current = status; }, [status]);
  /** The picker the model chip opened, read off the screen while the sheet is
   * up — a list of the session's own rows, not a list of models Eldrun
   * believes in. OpenCode's is not the numbered dialog the others draw, so it
   * is read by its own shape (`openCodeMini`). */
  const picker = useMemo(
    () => (modelSheet ? (openCode ? readOpenCodePicker(lines) : readSelectPrompt(lines)) : null),
    [modelSheet, openCode, lines],
  );
  /** The step the sheet is showing: the picker on screen, unless it is the one
   * a tap just answered and the session has not redrawn yet. */
  const pickerStep = picker && selectSignature(picker) === answered ? null : picker;
  useEffect(() => {
    if (!modelSheet) return;
    if (pickerStep) {
      sawPicker.current = true;
      // A step is up, so nothing is left to hold for: a dialog that comes back
      // to a list already answered (Codex's "More reasoning…" has an esc back)
      // is a step again, not the stale paint of the answer.
      if (answered) setAnswered("");
      return;
    }
    // The answered list, still on screen: the session has not read the Enter
    // yet. Hold — the next step, if there is one, replaces it in place. If the
    // session never moves off it, the answer did not land: give the list back
    // rather than hold a sheet the tap can no longer leave.
    if (answered && picker) {
      const stuck = window.setTimeout(() => setAnswered(""), MODEL_PICKER_WAIT);
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
        setAnswered("");
      }, SELECT_NEXT_WAIT);
      return () => window.clearTimeout(next);
    }
    // Never drawn: the session may have no `/model` picker at all. Step out of
    // the way rather than hold an empty sheet over its output.
    const timer = window.setTimeout(() => setModelSheet(false), MODEL_PICKER_WAIT);
    return () => window.clearTimeout(timer);
  }, [modelSheet, picker, pickerStep, answered]);
  /** `/model` opens the agent's own picker in the session; the sheet lists the
   * rows it drew, and a tap answers it with the same keys the arrow row sends —
   * so nothing here decides what the models are.
   *
   * OpenCode mini has no `/model`: the words would be submitted to the model
   * as a prompt, which is a turn the reader never asked for. Its picker lives
   * behind the command palette, so the chip presses the keys that open it
   * there (`OPENCODE_MODEL_KEYS`) instead of typing a command. */
  const selectModel = () => {
    if (modelSheet) return;
    sawPicker.current = false;
    setAnswered("");
    if (openCode) {
      clearPending();
      if (!deliver(OPENCODE_MODEL_KEYS)) return;
    } else if (!sendAgentText("/model")) return;
    setModelSheet(true);
  };
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
    if (!pickerStep) return;
    clearPending();
    const picked = pickerStep.options.find((option) => option.index === Number(key));
    const writes = openCode
      ? (picked ? openCodePickKeys(picked.label) : [])
      : selectKeys(pickerStep.current, Number(key));
    if (writes.length === 0 || !deliver(writes)) return;
    setAnswered(selectSignature(pickerStep));
  };
  const closeModelSheet = () => {
    // The dialog is the session's own and still open: close it there too,
    // rather than leaving a modal behind that the reader can no longer see.
    if (picker) type("\u001b");
    setModelSheet(false);
    setAnswered("");
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
  const sheetUp = modelSheet || modeSheet || statusSheet || desktopSheet || outboxOpen !== null;
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
    () => (tab.kind === "agent" ? statusFrameLines(shown, agentLabel) : []),
    [tab.kind, shown, agentLabel],
  );
  const statusSwipe = tab.kind === "agent" && view === "focus" && !altScreen;
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
    let start = 0;
    painted.forEach((line, index) => { if (isPromptEcho(line, agentLabel)) start = index + 1; });
    return painted.slice(start);
  }, [sessionShown, painted, agentLabel]);
  const liveQuestion = useMemo(() => liveTail.length > 0 && readSelectPrompt(liveTail) != null, [liveTail]);
  /** The screen's lines as the reading view shows them: the revealed history,
   * the open chunk, then the live tail. */
  const screenStream = useMemo(
    () => [...visibleChunks.flatMap((chunk) => chunk.lines), ...earlier.open, ...painted],
    [visibleChunks, earlier.open, painted],
  );
  const copyReadable = async () => {
    try {
      // Copy exactly what the reading view is showing: the stored session's
      // turns, or the revealed history, the open chunk, then the live tail.
      await navigator.clipboard.writeText(sessionShown
        ? (transcript?.entries ?? []).map((entry) => entry.kind === "prompt" ? `> ${entry.text}` : entry.text).join("\n\n")
        : readableText(screenStream));
      setCopied(true);
      window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  };
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
    const language = navigator.language || "en-US";
    setPreparingVoice(true);
    setVoiceStatus({ key: "mobile.voice.checking" });
    setVoiceFailure(null);
    const mode = await prepareOnDeviceSpeech(Recognition, language);
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
    const next = new Recognition();
    next.continuous = true;
    next.interimResults = true;
    next.lang = language;
    next.maxAlternatives = 1;
    next.processLocally = mode === "local";
    voiceProgress.current = DICTATION_START;
    setVoicePreview("");
    setVoiceFailure(null);
    next.onstart = () => {
      setListening(true);
      setVoiceStatus({ key: mode === "local" ? "mobile.voice.listeningLocal" : "mobile.voice.listeningRemote" });
    };
    next.onresult = (event) => {
      const reading = readDictation(event);
      const step = advanceDictation(voiceProgress.current, reading.heard);
      voiceProgress.current = step.progress;
      // Speech is inserted into the current prompt but deliberately not
      // submitted. The user can review/edit it before pressing Enter.
      if (step.insert) setDraft((current) => `${current}${current && !current.endsWith(" ") ? " " : ""}${step.insert}`);
      setVoicePreview(dictationPreview(step.progress, reading.interim));
    };
    next.onerror = (event) => {
      setVoiceStatus(null);
      const message = speechRecognitionError(event.error);
      if (message) setVoiceFailure({ key: message });
    };
    next.onend = () => {
      if (recognition.current === next) recognition.current = undefined;
      setListening(false);
      setVoiceStatus(null);
    };
    recognition.current = next;
    try {
      next.start();
    } catch {
      recognition.current = undefined;
      setVoiceStatus(null);
      setVoiceFailure({ key: "mobile.voice.startFailed" });
    }
  };
  useEffect(() => () => {
    voiceRequest.current += 1;
    const active = recognition.current;
    recognition.current = undefined;
    if (active) {
      active.onstart = null;
      active.onresult = null;
      active.onerror = null;
      active.onend = null;
      active.abort();
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
  const shownStep = pickerStep ?? (answered ? picker : null);
  const pickerOptions: SheetOption[] = (shownStep?.options ?? []).map((option) => ({
    key: String(option.index),
    label: option.label,
    description: option.description,
    current: option.index === shownStep?.current,
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
  return <main className={`terminal-screen ${tab.kind}-tab`} style={viewportHeight ? { height: viewportHeight } : undefined}><header><button className="back" onClick={back}>‹</button><div className="terminal-title"><h1>{tab.label}</h1><small>{tab.kind === "agent" ? "Agent session" : "Shell session"}</small></div><div className="terminal-view-switch" aria-label="Output view"><button className={view === "focus" ? "selected" : ""} aria-pressed={view === "focus"} onClick={() => chooseView("focus")}>Focus</button><button className={view === "terminal" ? "selected" : ""} aria-pressed={view === "terminal"} onClick={() => chooseView("terminal")}>Terminal</button></div><span className={connected ? "lamp" : "lamp off"} /></header>
    <div className="terminal-body">
      <div ref={host} className={`terminal${view === "focus" ? " focus-source" : ""}`} />
      <div ref={wideHint} className="terminal-wide-hint" aria-hidden="true" />
      {view === "focus" && altScreen && <div className="alt-screen-notice"><strong>Full-screen program</strong><span>This session is drawing its own screen, which has no scrollback to read. Switch to Terminal to see it.</span>{openCode && <span>{t("mobile.focus.openCodeMini")}</span>}<button className="primary" onClick={() => chooseView("terminal")}>Open Terminal view</button></div>}
      {view === "focus" && !altScreen && <>
        <section ref={readableHost} className="readable-output" aria-label="Session output" aria-live="polite"
          onScroll={(event) => {
            const stream = event.currentTarget;
            followReadable(stream.scrollHeight - stream.scrollTop - stream.clientHeight < 120);
          }}>
          {sessionShown
            ? (transcript && sessionEntries.length === 0 && !liveQuestion && outbox.length === 0
              ? <div className="readable-empty"><strong>{t("mobile.transcript.empty")}</strong><span>{t("mobile.transcript.emptyHint")}</span></div>
              : <div className="readable-lines chat transcript" data-testid="session-transcript">
                  {transcript?.truncated && <button className="readable-earlier" onClick={() => setTranscriptLimit((limit) => limit + TRANSCRIPT_STEP)}>{t("mobile.transcript.earlier")}</button>}
                  <TranscriptTurns entries={sessionEntries} cutLabel={t("mobile.transcript.cut")} promptLabel={t("mobile.transcript.prompt")} placement={outboxPlacement} renderFiles={renderOutbox} />
                  {liveQuestion && <div className="transcript-screen" role="group" aria-label={t("mobile.transcript.onScreen")}>
                    <small>{t("mobile.transcript.onScreen")}</small>
                    <ReadableTurns lines={liveTail} chat={chat} agent={agentLabel} promptLabel={t("mobile.transcript.prompt")} columns={paneColumns.current} />
                  </div>}
                </div>)
            : painted.length === 0 && visibleChunks.length === 0 && earlier.open.length === 0 && outbox.length === 0
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
                {renderOutbox(screenOutbox)}
              </div>}
        </section>
        {statusStrip && statusSwipe && <div className="focus-statusline" role="status" aria-label={t("mobile.focus.statusLine")}>
          <div className="focus-statusline-head"><strong>{t("mobile.focus.statusLine")} <small>{t("mobile.focus.untested")}</small></strong><button onClick={() => setStatusStrip(false)} aria-label={t("mobile.focus.statusLineHide")}>✕</button></div>
          {frameStatus.length
            ? frameStatus.map((row, i) => <div key={i} className="focus-statusline-row">{row}</div>)
            : <div className="focus-statusline-empty">{t("mobile.focus.statusLineEmpty")}</div>}
        </div>}
        {(lines.length > 0 || sessionShown) && <div className="readable-tools">
          {chat && <small>{sessionShown ? `${t("mobile.focus.session")} · ${t("mobile.focus.untested")}` : sessionWhy && !transcript?.available ? t(noSessionReason(transcript)) : "Chat layout · Untested"}</small>}
          {/* On every agent tab, so the choice is where the reader looks for
              it; dimmed when the stored session cannot be read (an agent
              whose transcript Eldrun does not read, no session id yet), and a
              tap then says which rather than doing nothing. */}
          {chat && (transcript?.available
            ? <button onClick={() => setFocusSource((source) => source === "session" ? "screen" : "session")} aria-pressed={sessionShown} title={sessionShown ? t("mobile.focus.screenHint") : t("mobile.focus.sessionHint")}>{sessionShown ? t("mobile.focus.screen") : t("mobile.focus.session")}</button>
            : <button className="unavailable" aria-disabled="true" aria-expanded={sessionWhy} title={t(noSessionReason(transcript))} onClick={() => setSessionWhy((shown) => !shown)}>{t("mobile.focus.session")}</button>)}
          <button onClick={() => void copyReadable()} aria-label="Copy the session text">{copied ? "Copied" : "Copy"}</button>
        </div>}
        {!atBottom && <button className="readable-jump" onClick={jumpToLatest}>Jump to latest ↓</button>}
      </>}
    </div>
    <div className="terminal-controls">
      {tab.kind === "agent" && voiceLine && <div className={voiceProblem ? "voice-feedback error" : "voice-feedback"} role={voiceProblem ? "alert" : "status"} aria-live="polite">{voiceLine}</div>}
      {stoppedReason && <div className="voice-feedback error" role="alert">{stoppedReason}</div>}
      {sendFailed && !stoppedReason && <div className="voice-feedback error" role="alert">That did not reach the desktop — the connection dropped. It will retry on its own.</div>}
      {/* Focus posts the files into its chat instead (`OutboxMessage`); the
          strip is for the Terminal view, and a full-screen program's notice. */}
      {outboxShown.length > 0 && !(view === "focus" && !altScreen) && <div className="outbox-strip" role="region" aria-label={t("mobile.outbox.region")}>
        <div className="outbox-strip-head"><strong>{t("mobile.outbox.from")} <small>{t("mobile.outbox.untested")}</small></strong><span>{t(outboxShown.length === 1 ? "mobile.outbox.countOne" : "mobile.outbox.count", { count: outboxShown.length })}</span><button onClick={hideOutbox} aria-label={t("mobile.outbox.hide")}>✕</button></div>
        <div className="outbox-thumbs">
          {outboxShown.map((file) => {
            const isImage = file.kind.startsWith("image/");
            const download = !isImage && !file.kind.startsWith("text/") && file.kind !== "application/pdf";
            const label = t("mobile.outbox.open", { name: file.name });
            const content = <>
              {isImage ? <img src={outboxFileUrl(tab.id, file.name)} alt="" loading="lazy" decoding="async" /> : <span aria-hidden="true">{file.kind === "application/pdf" ? "PDF" : file.kind.startsWith("text/") ? "≡" : "↓"}</span>}
              {!isImage && <strong>{file.name}</strong>}
              <span>{ageLabel(Math.max(0, Math.floor(Date.now() / 1000) - file.modified))}{!isImage && ` · ${sizeLabel(file.size)}`}</span>
            </>;
            return <div key={file.name} className="outbox-entry">
              {download ? <a className="outbox-file" href={outboxFileUrl(tab.id, file.name, true)} download={file.name} aria-label={label}>{content}</a>
                : <button className={isImage ? "outbox-thumb" : "outbox-file"} onClick={() => openOutbox(file)} aria-label={label} title={file.name}>{content}</button>}
              {!isImage && <button className="outbox-details" onClick={() => setOutboxOpen(file)} aria-label={t("mobile.outbox.actions", { name: file.name })}>⋯</button>}
            </div>;
          })}
        </div>
      </div>}
      {lastSent && !sessionShown && <div className="last-sent"><span>Sent</span><p>{lastSent}</p></div>}
      {uploads.map((upload) => upload.failure
        ? <div key={upload.id} className="inbox-upload error" role="alert"><strong>{upload.name}</strong><span>{upload.failure}</span><button onClick={() => dismissUpload(upload.id)} aria-label={`Dismiss ${upload.name}`}>✕</button></div>
        : <div key={upload.id} className="inbox-upload" role="status"><strong>{upload.name}</strong><span>{upload.source === "desktop" ? "Copying from the desktop…" : "Sending to the project inbox…"}</span></div>)}
      {(status?.path || status?.branch || status?.context || limits.session || limits.week) && <div className="session-facts" title={status?.path}>
        {status?.path && <span className="fact-path">{shortenPath(status.path)}</span>}
        {status?.branch && <span className="fact-branch">⎇ {status.branch}</span>}
        {status?.context && <span className="fact-context">{status.context} context</span>}
        {limits.session && <span className={`fact-limit${limits.session.percent >= 90 ? " high" : ""}`} title={limits.session.resets ? resetText(limits.session.resets, new Date()) : undefined}>{t("mobile.facts.session", { percent: Math.round(limits.session.percent) })}</span>}
        {limits.week && <span className={`fact-limit${limits.week.percent >= 90 ? " high" : ""}`} title={limits.week.resets ? resetText(limits.week.resets, new Date()) : undefined}>{t("mobile.facts.week", { percent: Math.round(limits.week.percent) })}</span>}
      </div>}
      <div className="prompt-composer">
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
            <div className="composer-chips">
              <button className="composer-chip" disabled={!connected} onClick={selectModel} aria-haspopup="dialog" aria-expanded={modelSheet} title="Choose the model (/model)"><span className="composer-chip-label">{status?.model ?? "Model"}</span></button>
              <button className="composer-chip" disabled={!connected} onClick={openModeSheet} aria-haspopup={modes.length > 0 ? "dialog" : undefined} aria-expanded={modes.length > 0 ? modeSheet : undefined} title={modes.length > 0 ? "Choose the permission mode" : "Switch mode (Shift+Tab)"}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2 4.5 13.5H11L10 22l8.5-11.5H12L13 2Z" /></svg><span className="composer-chip-label">{status?.mode ?? activeMode ?? "Mode"}</span></button>
              <button className="composer-chip" onClick={() => setStatusSheet(true)} aria-haspopup="dialog" aria-expanded={statusSheet} title="Session status and the agent's own usage"><span className={`composer-chip-lamp ${lamp}`} aria-hidden="true" /><span className="composer-chip-label">Status</span></button>
            </div>
          </>}
          {tab.kind !== "agent" && <span className="composer-spacer" />}
          {tab.kind === "agent" && <button className={`composer-dictate${listening ? " listening" : ""}`} disabled={!connected || !voiceAvailable || preparingVoice} title={t(voiceAvailable ? "mobile.voice.hint" : "mobile.voice.hintUnavailable")} aria-label={dictateLabel} aria-pressed={listening} onClick={listening ? stopVoice : () => void startVoice()}>{listening ? <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1" /></svg> : <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M6 11a6 6 0 0 0 12 0M12 17v4M8 21h8" /></svg>}</button>}
          <button className="send-icon" disabled={!connected || !draft.trim()} onClick={submitDraft} aria-label="Send" title="Send"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 4 16 8-16 8 3-8-3-8Z" /><path d="M7 12h13" /></svg></button>
        </div>
      </div>
      <div className="keys">
      <button className={ctrl ? "selected" : ""} aria-pressed={ctrl} disabled={!connected} onClick={() => setCtrl((on) => !on)}>Ctrl</button><button disabled={!connected} onClick={() => press("\u001b")}>Esc</button><button disabled={!connected} onClick={() => press("\t")}>Tab</button><button disabled={!connected} onClick={() => press("\u001b[D")}>←</button><button disabled={!connected} onClick={() => press("\u001b[A")}>↑</button><button disabled={!connected} onClick={() => press("\u001b[B")}>↓</button><button disabled={!connected} onClick={() => press("\u001b[C")}>→</button><button disabled={!connected} onClick={() => press("\r")}>Enter</button><button disabled={!connected} onClick={() => press("\u007f")}>⌫</button><button className="danger" disabled={!connected} onClick={() => window.confirm("Send interrupt (Ctrl+C)?") && type("\u0003")}>Interrupt</button>
      </div>
    </div>
    {modelSheet && <OptionSheet
      title={shownStep?.title ?? "Select model"}
      options={pickerOptions}
      waiting={!connected
        ? "Waiting for the connection…"
        : answered ? "Waiting for the session…" : "Waiting for the session's model picker…"}
      busy={shownStep != null && pickerStep == null}
      onPick={chooseModel}
      onClose={closeModelSheet}
    />}
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
    {outboxOpen && <OutboxViewer key={`${tab.id}/${outboxOpen.name}`} tabId={tab.id} file={outboxOpen} onClose={() => setOutboxOpen(null)} />}

  </main>;
}
