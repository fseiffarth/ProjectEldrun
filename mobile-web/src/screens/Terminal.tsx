import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { ApiError, api, type TabRow } from "../api";
import { TERMINAL_PROTOCOL } from "../terminal/protocol";
import { readableScreen, readableText, TRUNCATION_NOTICE, type ReadableLine } from "../terminal/readableScreen";
import { type TerminalEvent } from "../terminal/protocol";
import { installTerminalTouchScroll } from "../terminal/touchScroll";
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

export function Terminal({ tab, back }: { tab: TabRow; back: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const readableHost = useRef<HTMLElement>(null);
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
  const [atBottom, setAtBottom] = useState(true);
  const [lastSent, setLastSent] = useState("");
  const [copied, setCopied] = useState(false);
  const [voiceAvailable] = useState(() => speechRecognitionSupported());
  const [listening, setListening] = useState(false);
  const [preparingVoice, setPreparingVoice] = useState(false);
  const [voicePreview, setVoicePreview] = useState("");
  const [voiceStatus, setVoiceStatus] = useState("");
  const [voiceFailure, setVoiceFailure] = useState(() => voiceAvailable ? "" : VOICE_UNAVAILABLE);

  useEffect(() => {
    setView("focus");
    setDraft("");
    setLines([]);
    setClipped(false);
    setAtBottom(true);
    setLastSent("");
    setCopied(false);
    setStoppedReason("");
    setAltScreen(false);
    setCtrl(false);
    setSendFailed(false);
    return () => {
      window.clearTimeout(copiedTimer.current);
      sendTimers.current.forEach(window.clearTimeout);
      sendTimers.current = [];
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
      scrollback: 4000,
      // A shell/agent prompt remains part of PTY output, but it must not look
      // like an editable field on the phone.
      theme: { background: "#0b0d13", foreground: "#e7e9f2", cursor: "#0b0d13", cursorAccent: "#0b0d13" },
    });
    const fit = new FitAddon(); term.loadAddon(fit); term.open(host.current); fit.fit();
    bracketedPaste.current = () => term.modes.bracketedPasteMode === true;
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
      // when the program exits. Say so instead of showing a collapsing view.
      setAltScreen(buffer.type === "alternate");
      const screen = readableScreen(buffer);
      setLines(screen.lines);
      setClipped(screen.clipped);
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
          term.reset();
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
    // Agents own a line editor inside their TUI: reset its line, deliver the
    // draft, submit — every piece its own write, never one chunk (see
    // AGENT_KEY_GAP), and inside bracketed paste markers where the pane has the
    // mode on. Only the first write can be confirmed synchronously; a later one
    // that fails raises the dropped-connection notice through `type`.
    sendTimers.current.forEach(window.clearTimeout);
    sendTimers.current = [];
    const writes = agentInputWrites(draft, bracketedPaste.current());
    if (!type(writes[0])) return;
    const step = (index: number) => {
      if (index >= writes.length) return;
      // The submit gets the longer pause: it is the one write whose arrival in
      // the same read as the text would be swallowed as part of a paste.
      const gap = index === writes.length - 1 ? AGENT_SUBMIT_GAP : AGENT_KEY_GAP;
      later(gap, () => { if (type(writes[index])) step(index + 1); });
    };
    step(1);
    setLastSent(draft);
    setDraft("");
  };
  const copyReadable = async () => {
    try {
      await navigator.clipboard.writeText(readableText(lines));
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
          {lines.length === 0
            ? <div className="readable-empty"><strong>Waiting for output</strong><span>The exact terminal is running behind this view.</span></div>
            : <div className="readable-lines">
                {clipped && <div className="readable-notice">{TRUNCATION_NOTICE}</div>}
                {lines.map((line) => <ReadableRow key={line.key} line={line} />)}
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
      <div className="prompt-composer"><textarea value={draft} disabled={!connected} rows={1} aria-label={tab.kind === "agent" ? "Message agent" : "Shell command"} placeholder={connected ? (tab.kind === "agent" ? "Message the agent…" : "Type a command…") : "Reconnecting…"} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submitDraft(); } }} /><div className="prompt-composer-actions">{tab.kind === "agent" && <button className={`composer-dictate${listening ? " listening" : ""}`} disabled={!connected || !voiceAvailable || preparingVoice} title={voiceAvailable ? "Dictate a message" : "Voice typing is unavailable in this browser; use the keyboard microphone."} aria-label={dictateLabel} aria-pressed={listening} onClick={listening ? stopVoice : () => void startVoice()}>{listening ? <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1" /></svg> : <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M6 11a6 6 0 0 0 12 0M12 17v4M8 21h8" /></svg>}</button>}<button className="send-icon" disabled={!connected || !draft.trim()} onClick={submitDraft} aria-label="Send" title="Send"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 4 16 8-16 8 3-8-3-8Z" /><path d="M7 12h13" /></svg></button></div></div>
      <div className="keys">
      <button className={ctrl ? "selected" : ""} aria-pressed={ctrl} disabled={!connected} onClick={() => setCtrl((on) => !on)}>Ctrl</button><button disabled={!connected} onClick={() => press("\u001b")}>Esc</button><button disabled={!connected} onClick={() => press("\t")}>Tab</button><button disabled={!connected} onClick={() => press("\u001b[D")}>←</button><button disabled={!connected} onClick={() => press("\u001b[A")}>↑</button><button disabled={!connected} onClick={() => press("\u001b[B")}>↓</button><button disabled={!connected} onClick={() => press("\u001b[C")}>→</button><button disabled={!connected} onClick={() => press("\r")}>Enter</button><button disabled={!connected} onClick={() => press("\u007f")}>⌫</button><button className="danger" disabled={!connected} onClick={() => window.confirm("Send interrupt (Ctrl+C)?") && type("\u0003")}>Interrupt</button>
      </div>
    </div>
  </main>;
}
