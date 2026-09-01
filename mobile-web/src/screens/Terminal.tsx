import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { ApiError, api, MAX_INBOX_FILE, uploadToInbox, type TabRow } from "../api";
import { TERMINAL_PROTOCOL } from "../terminal/protocol";
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
import { sessionStatus, shortenPath, type SessionStatus } from "../terminal/statusLine";
import { readSelectPrompt, selectKeys } from "../terminal/selectPrompt";
import { currentMode, modeChoices, shiftTabKey } from "../terminal/agentModes";
import { agentInputWrites } from "../terminal/composer";
import {
  prepareOnDeviceSpeech,
  sanitizeVoiceTranscript,
  speechRecognitionConstructor,
  speechRecognitionError,
  speechRecognitionSupported,
  transcriptsFrom,
  type MobileSpeechRecognition,
} from "../voiceInput";

const VOICE_UNAVAILABLE = "Voice typing is not available in this browser. Use the keyboard microphone instead.";
const PING_INTERVAL = 20_000;
/** Floor between two rebuilds of the reading view. */
const READABLE_INTERVAL = 120;
/** Two missed pongs. A half-open TCP connection — routine on cellular — leaves
 * `readyState` at OPEN indefinitely, so the socket looked connected and every
 * keystroke was silently buffered into a dead link. */
const PONG_GRACE = PING_INTERVAL * 2 + 5_000;

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

/** How long the model sheet waits for the session to draw the picker `/model`
 * opens. Past it the sheet steps aside: the dialog — or the reason there is
 * none — is in the session output, and the arrow keys still answer it. */
const MODEL_PICKER_WAIT = 6_000;
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
};

/** A file on its way from the phone into the project inbox, or one that did
 * not make it. A delivered one leaves the list: its `@` reference is in the
 * draft, which is the record. */
interface InboxUpload {
  id: number;
  name: string;
  failure?: string;
}

/** One logical line of the session, with the colours the program actually
 * emitted. Style is never inferred from the text — see `readableScreen`. */
function ReadableRow({ line }: { line: ReadableLine }) {
  if (line.spans.length === 0) return <div className="readable-blank" aria-hidden="true" />;
  return <div className="readable-line">{line.spans.map((span, index) => (
    span.className || span.color || span.background
      ? <span key={index} className={span.className} style={{ color: span.color, background: span.background }}>{span.text}</span>
      : <span key={index}>{span.text}</span>
  ))}</div>;
}

/** A revealed block of earlier output. Memoized on the frozen chunk's stable
 * `lines` reference, so the per-frame rebuild of the live tail costs nothing
 * for however much history is on screen. */
const HistoryLines = memo(function HistoryLines({ lines }: { lines: readonly ReadableLine[] }) {
  return <>{lines.map((line) => <ReadableRow key={line.key} line={line} />)}</>;
});

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
  const host = useRef<HTMLDivElement>(null);
  const readableHost = useRef<HTMLElement>(null);
  const composerInput = useRef<HTMLTextAreaElement>(null);
  /** Re-reads the emulated screen on demand — used when Focus is opened, so the
   * reading view is current instead of waiting for the next output byte. */
  const refreshReadable = useRef<() => void>(() => {});
  const write = useRef<(value: string) => boolean>(() => false);
  const recognition = useRef<MobileSpeechRecognition>();
  const connectedRef = useRef(false);
  const voiceRequest = useRef(0);
  const voiceTranscript = useRef("");
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
  const [view, setView] = useState<"focus" | "terminal">("focus");
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
  const [lastSent, setLastSent] = useState("");
  const [copied, setCopied] = useState(false);
  const [voiceAvailable] = useState(() => speechRecognitionSupported());
  const [listening, setListening] = useState(false);
  const [preparingVoice, setPreparingVoice] = useState(false);
  const [voicePreview, setVoicePreview] = useState("");
  const [voiceStatus, setVoiceStatus] = useState("");
  const [voiceFailure, setVoiceFailure] = useState(() => voiceAvailable ? "" : VOICE_UNAVAILABLE);
  /** Whether the model sheet is up. It opens on the tap that sends `/model`,
   * before the session has drawn the picker it lists. */
  const [modelSheet, setModelSheet] = useState(false);
  const [modeSheet, setModeSheet] = useState(false);
  /** The composer's **+**: a phone file into the project inbox, or an `@`. */
  const [addSheet, setAddSheet] = useState(false);
  const [uploads, setUploads] = useState<InboxUpload[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
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
    setView("focus");
    setDraft("");
    setLines([]);
    setClipped(false);
    setEarlier({ chunks: [], open: [], dropped: false });
    setRevealed(1);
    setAtBottom(true);
    setLastSent("");
    setCopied(false);
    setStoppedReason("");
    setAltScreen(false);
    setCtrl(false);
    setSendFailed(false);
    setModelSheet(false);
    setModeSheet(false);
    setAddSheet(false);
    setUploads([]);
    uploadRun.current += 1;
    setSwitching("");
    setSwitchFailed("");
    sawPicker.current = false;
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
    const trimEvent = (term as unknown as {
      _core?: { _bufferService?: { buffers?: { normal?: { lines?: { onTrim?: TrimEvent } } } } };
    })._core?._bufferService?.buffers?.normal?.lines?.onTrim;
    const trimWatch = typeof trimEvent === "function"
      ? trimEvent((amount) => shiftHistory(history, amount))
      : undefined;
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
      const stream = readableHost.current;
      // The reading view is unmounted in Terminal view, so re-reading the whole
      // screen there was pure waste on a phone battery.
      if (!stream) return;
      lastReadable = Date.now();
      const followOutput = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 120;
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
      if (followOutput) {
        cancelAnimationFrame(readableScrollFrame);
        readableScrollFrame = requestAnimationFrame(() => {
          stream.scrollTo({ top: stream.scrollHeight });
          setAtBottom(true);
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
        readableFrame = requestAnimationFrame(renderReadable);
      }, wait);
    };
    refreshReadable.current = updateReadable;
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    let ws: WebSocket | null = null;
    let stopped = false;
    let reconnectTimer: number | undefined;
    let reconnectAttempt = 0;
    let lastPong = 0;
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
    const applySize = () => {
      if (windowSize) {
        if (term.cols !== windowSize.cols || term.rows !== windowSize.rows) {
          term.resize(windowSize.cols, windowSize.rows);
        }
      } else {
        fit.fit();
      }
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
        setConnected(true);
        setSendFailed(false);
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
          setVoiceStatus("");
          setVoiceFailure("Voice typing stopped because the terminal disconnected. Reconnect and try again.");
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
    let resizeTimer = 0;
    let resizeFrame = 0;
    const resize = () => {
      cancelAnimationFrame(resizeFrame);
      cancelAnimationFrame(readableFrame);
      cancelAnimationFrame(readableScrollFrame);
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
      clearTimeout(resizeTimer);
      clearTimeout(readableTimer);
      cancelAnimationFrame(resizeFrame);
      cancelAnimationFrame(readableFrame);
      cancelAnimationFrame(readableScrollFrame);
      window.removeEventListener("pagehide", release);
      window.removeEventListener("resize", resize);
      window.visualViewport?.removeEventListener("resize", resize);
      resizeObserver?.disconnect();
      removeTouchScroll();
    };
  }, [tab.id]);
  useEffect(() => { if (view === "focus") refreshReadable.current(); }, [view]);
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
    setDraft("");
  };
  /** The facts the session prints below its own input box — the composer
   * chips' labels. Absent fields leave the chip on its generic label. */
  const status = useMemo(() => (tab.kind === "agent" ? sessionStatus(lines) : null), [tab.kind, lines]);
  // The mode walk reads the status between two presses, outside React's render.
  useEffect(() => { statusRef.current = status; }, [status]);
  /** The picker `/model` opened, read off the screen while the sheet is up — a
   * list of the session's own rows, not a list of models Eldrun believes in. */
  const picker = useMemo(() => (modelSheet ? readSelectPrompt(lines) : null), [modelSheet, lines]);
  useEffect(() => {
    if (!modelSheet) return;
    if (picker) {
      sawPicker.current = true;
      return;
    }
    // Gone after it was listed: answered here, on the desktop, or dismissed.
    if (sawPicker.current) {
      setModelSheet(false);
      return;
    }
    // Never drawn: the session may have no `/model` picker at all. Step out of
    // the way rather than hold an empty sheet over its output.
    const timer = window.setTimeout(() => setModelSheet(false), MODEL_PICKER_WAIT);
    return () => window.clearTimeout(timer);
  }, [modelSheet, picker]);
  /** `/model` opens the agent's own picker in the session; the sheet lists the
   * rows it drew, and a tap answers it with the same keys the arrow row sends —
   * so nothing here decides what the models are. */
  const selectModel = () => {
    if (modelSheet) return;
    sawPicker.current = false;
    if (!sendAgentText("/model")) return;
    setModelSheet(true);
  };
  const chooseModel = (key: string) => {
    if (!picker) return;
    clearPending();
    deliver(selectKeys(picker.current, Number(key)));
    setModelSheet(false);
  };
  const closeModelSheet = () => {
    // The dialog is the session's own and still open: close it there too,
    // rather than leaving a modal behind that the reader can no longer see.
    if (picker) type("\u001b");
    setModelSheet(false);
  };
  /** The modes this session has, decided by the mode it is showing with the
   * tab's agent label as the tie-break (and, for a family whose default mode
   * draws no text at all, as the way in). Empty for a session no family
   * claims — the chip then keeps cycling, as before. */
  const agentLabel = tab.agent_label ?? tab.label;
  /** Shift+Tab — the mode cycle Claude Code, Codex and Qwen Code all bind,
   * encoded the way this family's TUI reads it (`shiftTabKey`). The chip label
   * follows the status line the TUI redraws, so the feedback is real. */
  const shiftTab = shiftTabKey(agentLabel);
  const cycleMode = () => press(shiftTab);
  const modes = useMemo(() => modeChoices(status?.mode, agentLabel), [status?.mode, agentLabel]);
  const activeMode = currentMode(modes, status?.mode, status != null);
  const openModeSheet = () => {
    if (modes.length === 0) {
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
    if (switching || !connected) return;
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
  const sheetUp = modelSheet || modeSheet;
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
        setUploads((current) => [...current, { id, name, failure: UPLOAD_FAILURES.file_too_large }]);
        continue;
      }
      setUploads((current) => [...current, { id, name }]);
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
  const pickAdd = (key: string) => {
    setAddSheet(false);
    if (key === "phone") {
      fileInput.current?.click();
    } else {
      addContext();
    }
  };
  const copyReadable = async () => {
    try {
      // Copy exactly what the reading view is showing: the revealed history,
      // the open chunk, then the live tail.
      await navigator.clipboard.writeText(readableText([
        ...visibleChunks.flatMap((chunk) => chunk.lines),
        ...earlier.open,
        ...lines,
      ]));
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
    setAtBottom(true);
  };
  const stopVoice = () => recognition.current?.stop();
  const startVoice = async () => {
    if (!connectedRef.current || recognition.current || preparingVoice) return;
    const Recognition = speechRecognitionConstructor();
    if (!Recognition) {
      setVoiceFailure(VOICE_UNAVAILABLE);
      return;
    }
    const request = voiceRequest.current + 1;
    voiceRequest.current = request;
    const language = navigator.language || "en-US";
    setPreparingVoice(true);
    setVoiceStatus("Checking for on-device dictation…");
    setVoiceFailure("");
    const mode = await prepareOnDeviceSpeech(Recognition, language);
    if (voiceRequest.current !== request) return;
    setPreparingVoice(false);
    if (!connectedRef.current) {
      setVoiceStatus("");
      setVoiceFailure("Voice typing stopped because the terminal disconnected. Reconnect and try again.");
      return;
    }
    if (mode === "installed") {
      setVoiceStatus(`On-device ${language} dictation is installed. Tap Dictate again.`);
      return;
    }
    const next = new Recognition();
    next.continuous = true;
    next.interimResults = true;
    next.lang = language;
    next.maxAlternatives = 1;
    next.processLocally = mode === "local";
    voiceTranscript.current = "";
    setVoicePreview("");
    setVoiceFailure("");
    next.onstart = () => {
      setListening(true);
      setVoiceStatus(mode === "local" ? "Listening on this device…" : "Listening with the phone speech service…");
    };
    next.onresult = (event) => {
      const parts = transcriptsFrom(event);
      const final = sanitizeVoiceTranscript(parts.final);
      const interim = sanitizeVoiceTranscript(parts.interim);
      if (final) {
        // Speech is inserted into the current prompt but deliberately not
        // submitted. The user can review/edit it before pressing Enter.
        const separator = voiceTranscript.current ? " " : "";
        setDraft((current) => `${current}${current && !current.endsWith(" ") ? " " : ""}${final}`);
        voiceTranscript.current = `${voiceTranscript.current}${separator}${final}`;
      }
      setVoicePreview(`${voiceTranscript.current}${voiceTranscript.current && interim ? " " : ""}${interim}`);
    };
    next.onerror = (event) => {
      setVoiceStatus("");
      const message = speechRecognitionError(event.error);
      if (message) setVoiceFailure(message);
    };
    next.onend = () => {
      if (recognition.current === next) recognition.current = undefined;
      setListening(false);
      setVoiceStatus("");
    };
    recognition.current = next;
    try {
      next.start();
    } catch {
      recognition.current = undefined;
      setVoiceStatus("");
      setVoiceFailure("Voice typing could not start. Try again or use the keyboard microphone.");
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
  const dictateLabel = listening ? "Stop dictation" : preparingVoice ? "Preparing dictation" : "Dictate";
  const pickerOptions: SheetOption[] = (picker?.options ?? []).map((option) => ({
    key: String(option.index),
    label: option.label,
    description: option.description,
    current: option.index === picker?.current,
  }));
  const modeOptions: SheetOption[] = modes.map((choice) => ({
    key: choice.value,
    label: choice.label,
    description: choice.description,
    current: choice.value === activeMode,
    pending: choice.value === switching,
  }));
  const failedMode = modes.find((choice) => choice.value === switchFailed);
  /** What the reading view paints: the live screen, or the frame it held when
   * a composer sheet opened. */
  const shown = frozenLines ?? lines;
  const addOptions: SheetOption[] = [
    { key: "phone", label: "From this phone", description: "A photo, screenshot or file — saved to the project's inbox and referenced in the message", current: false },
    { key: "project", label: "A project file (@)", description: "Type a path after the @ for the agent to read", current: false },
  ];
  return <main className={`terminal-screen ${tab.kind}-tab`} style={viewportHeight ? { height: viewportHeight } : undefined}><header><button className="back" onClick={back}>‹</button><div className="terminal-title"><h1>{tab.label}</h1><small>{tab.kind === "agent" ? "Agent session" : "Shell session"}</small></div><div className="terminal-view-switch" aria-label="Output view"><button className={view === "focus" ? "selected" : ""} aria-pressed={view === "focus"} onClick={() => setView("focus")}>Focus</button><button className={view === "terminal" ? "selected" : ""} aria-pressed={view === "terminal"} onClick={() => setView("terminal")}>Terminal</button></div><span className={connected ? "lamp" : "lamp off"} /></header>
    <div className="terminal-body">
      <div ref={host} className={`terminal${view === "focus" ? " focus-source" : ""}`} />
      {view === "focus" && altScreen && <div className="alt-screen-notice"><strong>Full-screen program</strong><span>This session is drawing its own screen, which has no scrollback to read. Switch to Terminal to see it.</span><button className="primary" onClick={() => setView("terminal")}>Open Terminal view</button></div>}
      {view === "focus" && !altScreen && <>
        <section ref={readableHost} className="readable-output" aria-label="Session output" aria-live="polite"
          onScroll={(event) => {
            const stream = event.currentTarget;
            setAtBottom(stream.scrollHeight - stream.scrollTop - stream.clientHeight < 120);
          }}>
          {shown.length === 0 && visibleChunks.length === 0 && earlier.open.length === 0
            ? <div className="readable-empty"><strong>Waiting for output</strong><span>The exact terminal is running behind this view.</span></div>
            : <div className="readable-lines">
                {clipped && <div className="readable-notice">{TRUNCATION_NOTICE}</div>}
                {hiddenLines > 0 && <button className="readable-earlier" onClick={showEarlier}>Show earlier output ({hiddenLines.toLocaleString()} lines)</button>}
                {hiddenLines === 0 && earlier.dropped && <div className="readable-notice">{TRUNCATION_NOTICE}</div>}
                {visibleChunks.map((chunk) => <HistoryLines key={chunk.id} lines={chunk.lines} />)}
                {earlier.open.map((line) => <ReadableRow key={line.key} line={line} />)}
                {shown.map((line) => <ReadableRow key={line.key} line={line} />)}
              </div>}
        </section>
        {lines.length > 0 && <div className="readable-tools">
          <button onClick={() => void copyReadable()} aria-label="Copy the session text">{copied ? "Copied" : "Copy"}</button>
        </div>}
        {!atBottom && <button className="readable-jump" onClick={jumpToLatest}>Jump to latest ↓</button>}
      </>}
    </div>
    <div className="terminal-controls">
      {tab.kind === "agent" && (voiceFailure || voicePreview || voiceStatus) && <div className={voiceFailure ? "voice-feedback error" : "voice-feedback"} role={voiceFailure ? "alert" : "status"} aria-live="polite">{voiceFailure || (voicePreview ? `Heard: ${voicePreview}` : voiceStatus)}</div>}
      {stoppedReason && <div className="voice-feedback error" role="alert">{stoppedReason}</div>}
      {sendFailed && !stoppedReason && <div className="voice-feedback error" role="alert">That did not reach the desktop — the connection dropped. It will retry on its own.</div>}
      {lastSent && <div className="last-sent"><span>Sent</span><p>{lastSent}</p></div>}
      {uploads.map((upload) => upload.failure
        ? <div key={upload.id} className="inbox-upload error" role="alert"><strong>{upload.name}</strong><span>{upload.failure}</span><button onClick={() => dismissUpload(upload.id)} aria-label={`Dismiss ${upload.name}`}>✕</button></div>
        : <div key={upload.id} className="inbox-upload" role="status"><strong>{upload.name}</strong><span>Sending to the project inbox…</span></div>)}
      {status && (status.path || status.branch || status.context) && <div className="session-facts" title={status.path}>
        {status.path && <span className="fact-path">{shortenPath(status.path)}</span>}
        {status.branch && <span className="fact-branch">⎇ {status.branch}</span>}
        {status.context && <span className="fact-context">{status.context} context</span>}
      </div>}
      <div className="prompt-composer">
        <textarea ref={composerInput} value={draft} disabled={!connected} rows={1} aria-label={tab.kind === "agent" ? "Message agent" : "Shell command"} placeholder={connected ? (tab.kind === "agent" ? "Message the agent…" : "Type a command…") : "Reconnecting…"} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submitDraft(); } }} />
        <div className="composer-bar">
          {tab.kind === "agent" && <>
            <input ref={fileInput} type="file" multiple hidden aria-hidden="true" tabIndex={-1} data-testid="inbox-file-input" onChange={(event) => { attachFromPhone(event.target.files); event.target.value = ""; }} />
            <button className="composer-add" disabled={!connected} onClick={() => setAddSheet(true)} aria-label="Add to the message" aria-haspopup="dialog" aria-expanded={addSheet} title="Add a photo or file from this phone, or a project file (@)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg></button>
            <button className="composer-chip" disabled={!connected} onClick={selectModel} aria-haspopup="dialog" aria-expanded={modelSheet} title="Choose the model (/model)">{status?.model ?? "Model"}</button>
            <button className="composer-chip" disabled={!connected} onClick={openModeSheet} aria-haspopup={modes.length > 0 ? "dialog" : undefined} aria-expanded={modes.length > 0 ? modeSheet : undefined} title={modes.length > 0 ? "Choose the permission mode" : "Switch mode (Shift+Tab)"}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2 4.5 13.5H11L10 22l8.5-11.5H12L13 2Z" /></svg>{status?.mode ?? activeMode ?? "Mode"}</button>
          </>}
          <span className="composer-spacer" />
          {tab.kind === "agent" && <button className={`composer-dictate${listening ? " listening" : ""}`} disabled={!connected || !voiceAvailable || preparingVoice} title={voiceAvailable ? "Dictate a message" : "Voice typing is unavailable in this browser; use the keyboard microphone."} aria-label={dictateLabel} aria-pressed={listening} onClick={listening ? stopVoice : () => void startVoice()}>{listening ? <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1" /></svg> : <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M6 11a6 6 0 0 0 12 0M12 17v4M8 21h8" /></svg>}</button>}
          <button className="send-icon" disabled={!connected || !draft.trim()} onClick={submitDraft} aria-label="Send" title="Send"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 4 16 8-16 8 3-8-3-8Z" /><path d="M7 12h13" /></svg></button>
        </div>
      </div>
      <div className="keys">
      <button className={ctrl ? "selected" : ""} aria-pressed={ctrl} disabled={!connected} onClick={() => setCtrl((on) => !on)}>Ctrl</button><button disabled={!connected} onClick={() => press("\u001b")}>Esc</button><button disabled={!connected} onClick={() => press("\t")}>Tab</button><button disabled={!connected} onClick={() => press("\u001b[D")}>←</button><button disabled={!connected} onClick={() => press("\u001b[A")}>↑</button><button disabled={!connected} onClick={() => press("\u001b[B")}>↓</button><button disabled={!connected} onClick={() => press("\u001b[C")}>→</button><button disabled={!connected} onClick={() => press("\r")}>Enter</button><button disabled={!connected} onClick={() => press("\u007f")}>⌫</button><button className="danger" disabled={!connected} onClick={() => window.confirm("Send interrupt (Ctrl+C)?") && type("\u0003")}>Interrupt</button>
      </div>
    </div>
    {modelSheet && <OptionSheet
      title="Select model"
      options={pickerOptions}
      waiting={connected ? "Waiting for the session's model picker…" : "Waiting for the connection…"}
      busy={false}
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
    {modeSheet && <OptionSheet
      title="Permission mode"
      note={failedMode
        ? { text: `This session did not switch to ${failedMode.label}; it is back in the mode it was in.`, error: true }
        : undefined}
      options={modeOptions}
      waiting="This session reports no mode."
      busy={switching !== ""}
      onPick={(key) => void applyMode(key)}
      onClose={() => { if (!switching) setModeSheet(false); }}
    />}
  </main>;
}
