import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { CanvasAddon } from "@xterm/addon-canvas";
import { WebglAddon } from "@xterm/addon-webgl";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "../../stores/settings";
import { useProjectsStore } from "../../stores/projects";
import { useT } from "../../lib/i18n";
import { useExperimental } from "../../lib/experimental";
import { cmdToKind, isDetachedPtyId, type TabKind } from "../../stores/tabs";
import { notePtySpawn, noteUserInput, splitPtyId, useActivityStore } from "../../stores/activity";
import { useAgentTaskStore } from "../../stores/agentTask";
import { noteInput } from "../../lib/promptCount";
import { METRIC, agentPromptLeaf, sub } from "../../lib/usageMetrics";
import { ROOT_SCOPE, bumpUsage, markAgentActive } from "../../stores/usage";
import { onTerminalExit, onTerminalOutput, onTerminalReady, onTerminalReplay } from "../../lib/terminalBus";
import { hpcGuardRefusal } from "../../lib/hpcGuard";
import { useHpcGuardStore } from "../../stores/hpcGuardPrompt";
import { claimInitialInput, decodeOsc52Clipboard, initialInputForPty, isTerminalIdentityResponse, isTerminalReport, stripTerminalQueries } from "../../lib/terminalControl";
import { clearPtyInput, writePtyInput } from "../../lib/terminalInput";
import "@xterm/xterm/css/xterm.css";

// Hoisted to module scope: keystroke input fires this on every key, so we reuse
// one encoder rather than allocating a `new TextEncoder()` per keystroke. The
// resulting `Uint8Array` is passed straight to `pty_write` (Tauri v2 ships typed
// arrays to a `Vec<u8>` command directly), avoiding the per-key `Array.from`.
const PTY_ENCODER = new TextEncoder();

interface Props {
  id: string;
  cmd: string;
  args?: string[];
  env?: Record<string, string>;
  initialInput?: string;
  cwd: string;
  // When true, never run this tab over ssh even for remote projects (e.g.
  // locally-bound Ollama agents). Forwarded to the backend spawn.
  localOnly?: boolean;
  // When true, run this (agent) tab inside a Docker sandbox that mounts only the
  // project dir. Set only for agent tabs of a sandbox-enabled local project.
  sandbox?: boolean;
  // The owning project's id for a project-scope tab (null/undefined for the root
  // scope and connection terminals). Forwarded to the backend spawn so it can
  // detect remoteness explicitly (resolve the project's RemoteSpec) instead of
  // sniffing the cwd. Harmless for local projects — they resolve to no remote.
  projectId?: string | null;
  // Which of the project's remote hosts this tab runs on (multi-host remote,
  // `docs/multi_host_remote_plan.md`): "primary" / undefined for the primary
  // remote, a worker id for a `host:<id>` locality. Forwarded to the backend so
  // it resolves the right worker's RemoteSpec. Ignored for local projects/tabs.
  remoteHostId?: string | null;
  // Persistent remote sessions (TODO #85): the stable tmux session name to spawn-
  // or-attach this remote spawn into, so the run survives an SSH drop / relaunch.
  // Set only for remote shell/script tabs of a persist-enabled project. No-op locally.
  tmuxSession?: string | null;
  // Attach this tab to an existing named tmux session instead of spawning one
  // (TODO #85 Sessions view). Takes precedence over `tmuxSession`. No-op locally.
  tmuxAttach?: string | null;
  /** Host-bound marker id (#150) — see `lib/hostBound.ts`. */
  hostBoundUid?: string | null;
  // Whether this pane is laid out on screen (single-mode active tab, or any
  // pane in grid mode). Drives display + xterm fit.
  visible: boolean;
  // Whether this pane holds keyboard focus / shows the active highlight.
  focused: boolean;
  // #42: ATTACH-ONLY mode for the detached subwindow. The detached window opens
  // a SECOND TerminalView for the SAME PTY id (output is broadcast via app.emit,
  // so it just also receives the stream). It must NOT spawn the PTY (that would
  // kill+respawn the live one, destroying scrollback) and must NOT kill it on
  // unmount (the main window's still-mounted pane owns the PTY lifetime). Such a
  // terminal opens blank and only shows output produced AFTER it attached.
  attachOnly?: boolean;
  // When true (agent tabs), the pane is font-zoomable: Ctrl+wheel and
  // Ctrl +/-/0 scale the font, with the level shared across all agent panes.
  zoomable?: boolean;
  // When true, do NOT kill the PTY when this view unmounts. Used by the
  // non-headless connection terminals embedded in the project dialog: the
  // OpenVPN/SSH login they run must outlive the dialog (the new project relies
  // on the tunnel/master being up), so closing the dialog leaves the PTY
  // running rather than tearing the connection down. This view owns the PTY
  // (it spawns it, unlike `attachOnly`), it just declines to reap it on unmount.
  persistOnUnmount?: boolean;
}

function terminalTheme(scheme: string | undefined) {
  if (scheme === "light_lavender") {
    // Neutral slots form a wide lavender ramp (not grey) so Claude Code's ANSI
    // theme reads as lavender with strong contrast: `black` is a deep saturated
    // lavender for the emphasized sent-message block / removed-diff background,
    // `brightBlack` a clearly lighter lavender for dimmed previous messages /
    // added-diff background, and `white` a light lavender for borders/dim text.
    // The gap between black↔brightBlack↔white is deliberately large so the
    // states are easy to tell apart. green/red are kept saturated so the +/-
    // diff markers stay legible on top of the lavender line backgrounds.
    // selection* + cursorAccent are set (xterm otherwise defaults them to a
    // blue-grey) so selection/cursor also pick up the lavender hue.
    return {
      background: "#faf9fe",
      foreground: "#2c2348",
      cursor: "#7c5cdb",
      cursorAccent: "#faf9fe",
      selectionBackground: "#dccff2",
      selectionForeground: "#241d38",
      black: "#2f2358",
      red: "#d1242f",
      green: "#0f5a26",
      yellow: "#9a6700",
      blue: "#0969da",
      magenta: "#7c5cdb",
      cyan: "#1b7c83",
      white: "#cbc0ec",
      brightBlack: "#8878c4",
      brightRed: "#cf222e",
      brightGreen: "#1c7a39",
      brightYellow: "#bf8700",
      brightBlue: "#0550ae",
      brightMagenta: "#b48cf0",
      brightCyan: "#3192aa",
      brightWhite: "#2c2348",
    };
  }
  if (scheme === "light" || scheme === "fancy_light") {
    return {
      background: "#ffffff",
      foreground: "#24292f",
      cursor: "#24292f",
      black: "#24292f",
      red: "#d1242f",
      green: "#1a7f37",
      yellow: "#9a6700",
      blue: "#0969da",
      magenta: "#8250df",
      cyan: "#1b7c83",
      white: "#6e7781",
      brightBlack: "#57606a",
      brightRed: "#cf222e",
      brightGreen: "#2da44e",
      brightYellow: "#bf8700",
      brightBlue: "#0550ae",
      brightMagenta: "#6639ba",
      brightCyan: "#3192aa",
      brightWhite: "#24292f",
    };
  }

  return {
    background: "#0d1117",
    foreground: "#e6edf3",
    cursor: "#e6edf3",
    black: "#484f58",
    red: "#f85149",
    green: "#3fb950",
    yellow: "#e3b341",
    blue: "#388bfd",
    magenta: "#bc8cff",
    cyan: "#39c5cf",
    white: "#b1bac4",
    brightBlack: "#6e7681",
    brightRed: "#ff7b72",
    brightGreen: "#56d364",
    brightYellow: "#e3b341",
    brightBlue: "#58a6ff",
    brightMagenta: "#d2a8ff",
    brightCyan: "#39c5cf",
    brightWhite: "#e6edf3",
  };
}

// While a pane is hidden its PTY output is buffered instead of written into
// xterm — before the first open because xterm has no renderer to write into,
// and for every hidden spell after it because a `display: none` pane still
// pays full escape-sequence parsing + render scheduling per chunk. With many
// parallel agent tabs streaming (Eldrun's normal shape) that made background
// tabs the renderer's biggest standing cost. The buffer flushes when the pane
// is next shown; agent TUIs repaint whole screens, so the flush converges on
// the current frame. Cap the retained text so a chatty background agent can't
// grow this without bound; xterm trims to its own scrollback on flush anyway.
const PENDING_OUTPUT_CAP = 1_000_000;

// Agent-terminal zoom. Agent TUIs (Claude, Codex, …) render dense layouts, so
// zoomable agent panes let the user scale the font with Ctrl+wheel / Ctrl +/-/0.
// The chosen size is a single global preference (one knob for every agent pane),
// persisted in localStorage — mirrors the view-pref pattern used by FileTree /
// GitHistory — and broadcast on a window event so all open agent panes restyle
// live, not just the one being scrolled. Non-agent shells keep the fixed default.
const AGENT_FONT_KEY = "eldrun.agentTermFontSize";
const AGENT_ZOOM_EVENT = "eldrun-agent-zoom";
const DEFAULT_FONT_SIZE = 13;
const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 32;

function clampFontSize(n: number): number {
  return Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, Math.round(n)));
}

function readAgentFontSize(): number {
  try {
    const raw = localStorage.getItem(AGENT_FONT_KEY);
    if (raw) return clampFontSize(parseInt(raw, 10) || DEFAULT_FONT_SIZE);
  } catch {
    /* ignore storage failures */
  }
  return DEFAULT_FONT_SIZE;
}

export function TerminalView({ id, cmd, args = [], env = {}, initialInput, cwd, localOnly = false, sandbox = false, projectId = null, remoteHostId = null, tmuxSession = null, tmuxAttach = null, hostBoundUid = null, visible, focused, attachOnly = false, zoomable = false, persistOnUnmount = false }: Props) {
  const viewerId = useRef(crypto.randomUUID()).current;
  const viewerUpdateSeq = useRef(0);
  const colorScheme = useSettingsStore((s) => s.settings?.color_scheme);
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const unlistenOutput = useRef<(() => void) | null>(null);
  const unlistenReplay = useRef<(() => void) | null>(null);
  const unlistenReady = useRef<(() => void) | null>(null);
  const unlistenExit = useRef<(() => void) | null>(null);
  const initialInputSent = useRef(false);
  const initialInputPending = useRef(false);
  const initialEnterTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openWatchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firstOutputAt = useRef<number | null>(null);
  // xterm crashes if opened/written into a zero-size or display:none element
  // (its renderer never initializes, so syncScrollArea dereferences undefined).
  // Panes start hidden — and even the active pane is display:none until its rect
  // is measured — so we defer term.open()/fit() until the container has a layout
  // box, buffering PTY output until then. `doFitRef` lets the visibility effect
  // reach the open/fit logic that lives in the mount effect's scope.
  const openedRef = useRef(false);
  const pendingOutput = useRef("");
  const doFitRef = useRef<(() => void) | null>(null);
  const visibleRef = useRef(visible);
  // Announcement text for an accepted OSC 52 clipboard write, held in a ref because
  // the OSC handler is registered once inside the setup effect (see below).
  const t = useT();
  const clipboardNoticeRef = useRef(t("terminal.clipboardSetByProgram"));
  clipboardNoticeRef.current = t("terminal.clipboardSetByProgram");

  const focusedRef = useRef(focused);
  visibleRef.current = visible;
  focusedRef.current = focused;
  // The live colour scheme, readable from inside the spawn effect without being
  // one of its deps — that effect owns the PTY, so listing `colorScheme` there
  // would respawn every terminal on a theme change. `tryOpen` reads it to adopt
  // whatever the scheme became while the pane was still closed.
  const colorSchemeRef = useRef(colorScheme);
  colorSchemeRef.current = colorScheme;
  // Same bargain for the renderer choice: the flag must not be a dep of the
  // spawn effect (a settings flip must never respawn a PTY), and settings load
  // asynchronously, so the first panes of a session open before the flag is
  // even known. `applyRendererRef` lets the flag effect below re-pick the
  // renderer of an already-open terminal in place.
  const webglWanted = useExperimental("terminal_webgl");
  const webglWantedRef = useRef(webglWanted);
  webglWantedRef.current = webglWanted;
  const applyRendererRef = useRef<((wantWebgl: boolean) => void) | null>(null);
  const argsKey = JSON.stringify(args);
  const envKey = JSON.stringify(env);

  useEffect(() => {
    if (!containerRef.current) return;
    let cancelled = false;
    initialInputSent.current = false;
    initialInputPending.current = !!initialInput;

    const term = new Terminal({
      scrollback: 5000,
      allowProposedApi: false,
      cursorBlink: true,
      fontSize: zoomable ? readAgentFontSize() : DEFAULT_FONT_SIZE,
      // 'JetBrains Mono Variable' is bundled (fontsource, imported in main.tsx)
      // so it's always available; the rest of the stack is the fallback for a
      // renderer that can't load it — Consolas/Cascadia Mono are the guaranteed
      // Windows monospace fonts, kept ahead of the generic fallback so the
      // terminal isn't a bitmap font there.
      fontFamily:
        "'JetBrains Mono Variable', 'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Cascadia Mono', Consolas, Menlo, monospace",
      theme: terminalTheme(colorScheme),
    });

    const fit = new FitAddon();
    const links = new WebLinksAddon();
    term.loadAddon(fit);
    term.loadAddon(links);

    termRef.current = term;
    fitRef.current = fit;
    openedRef.current = false;
    pendingOutput.current = "";

    // Which renderer paints this terminal — the scroll-performance ladder.
    // xterm's default DOM renderer rebuilds styled spans for every visible row
    // on each scroll step, which under WebKitGTK with GPU compositing disabled
    // (WEBKIT_DISABLE_DMABUF_RENDERER=1) makes scrolling densely colored agent
    // output very slow — so every terminal gets the canvas renderer (glyph
    // cache, no DOM/layout work, still on the safe software path). WebGL is
    // the faster tier but rides the same GPU/driver territory the DMABUF
    // re-test failed on (docs/typing_latency_plan.md Step 4), so it is opt-in
    // via the `terminal_webgl` experimental flag and demotes itself: a
    // construction/load failure falls back to canvas in the same call, and a
    // context lost at runtime (driver reset, or the browser evicting the
    // oldest of too many live contexts — every open pane holds one) disposes
    // the addon and reloads canvas. A renderer must never take the terminal
    // down; canvas failing too (jsdom has no canvas at all) leaves the DOM
    // renderer. term.dispose() in the cleanup disposes whichever addon is
    // loaded, so no teardown is kept here.
    let canvasAddon: CanvasAddon | null = null;
    let webglAddon: WebglAddon | null = null;
    const dropCanvas = () => {
      if (!canvasAddon) return;
      const addon = canvasAddon;
      canvasAddon = null;
      try {
        addon.dispose();
      } catch {
        /* already torn down */
      }
    };
    const dropWebgl = () => {
      if (!webglAddon) return;
      const addon = webglAddon;
      webglAddon = null;
      try {
        addon.dispose();
      } catch {
        /* already torn down */
      }
    };
    const loadCanvas = () => {
      if (canvasAddon) return;
      try {
        canvasAddon = new CanvasAddon();
        term.loadAddon(canvasAddon);
      } catch {
        dropCanvas();
      }
    };
    const applyRenderer = (wantWebgl: boolean) => {
      if (cancelled || !openedRef.current) return;
      if (wantWebgl) {
        if (webglAddon) return;
        dropCanvas();
        try {
          webglAddon = new WebglAddon();
          webglAddon.onContextLoss(() => {
            dropWebgl();
            loadCanvas();
          });
          term.loadAddon(webglAddon);
        } catch {
          dropWebgl();
          loadCanvas();
        }
      } else {
        dropWebgl();
        loadCanvas();
      }
    };
    applyRendererRef.current = applyRenderer;

    // THE one way buffered output reaches xterm — every catch-up goes through
    // here, never through a bare `term.write`, because output written late is
    // not the same thing as output written live. A terminal *query* in it
    // (`ESC[>c` and friends) is answered by xterm the moment it is finally
    // parsed, and that answer goes into the PTY as if typed — which is how
    // `0;276;0c` (tmux's attach probe on a remote shell tab, replayed when the
    // pane was next shown) ends up as text on the shell's command line.
    // `stripTerminalQueries` takes out the queries it knows; `staleParse`
    // counts how much stale output xterm is still parsing so `onData` can
    // refuse the replies to any it doesn't. xterm's write callback fires when
    // that exact chunk is done parsing, so the window is precise rather than a
    // timeout: a live query written afterwards is parsed after the callback, and
    // its reply still reaches the program that asked for it.
    let staleParse = 0;
    const flushPending = () => {
      const buffered = pendingOutput.current;
      if (!buffered) return;
      pendingOutput.current = "";
      const catchUp = stripTerminalQueries(buffered);
      if (!catchUp) return;
      staleParse += 1;
      term.write(catchUp, () => {
        staleParse = Math.max(0, staleParse - 1);
      });
    };

    // Write PTY output to the terminal only while the pane is open AND visible;
    // buffer it otherwise — a hidden pane's xterm still parses and schedules
    // renders for every chunk, which is what background agent tabs must not
    // cost (see PENDING_OUTPUT_CAP). Draining the buffer before a direct write
    // keeps ordering safe even if a chunk lands between the visibility flip
    // and the flush-on-show in doFit.
    const writeTerm = (data: string) => {
      if (openedRef.current && visibleRef.current) {
        flushPending();
        term.write(data);
      } else {
        pendingOutput.current += data;
        // Trim with hysteresis: cutting exactly to the cap on every chunk past
        // it re-copies the whole buffer per chunk (a ~1 MB memcpy up to ~60×/s
        // per chatty hidden tab, forever). Letting it grow to 2× and cutting
        // back to the cap costs one copy per megabyte of new output instead.
        if (pendingOutput.current.length > PENDING_OUTPUT_CAP * 2) {
          pendingOutput.current = pendingOutput.current.slice(-PENDING_OUTPUT_CAP);
        }
      }
    };

    // True only when the container is actually laid out (visible, non-zero size).
    const hasLayout = () => {
      const el = containerRef.current;
      return (
        !!el && el.offsetParent !== null && el.clientWidth > 0 && el.clientHeight > 0
      );
    };

    // Open the terminal into its container the first time the pane is visible and
    // sized, then flush any output buffered while it was hidden.
    const tryOpen = () => {
      if (openedRef.current || cancelled) return;
      if (!visibleRef.current || !hasLayout() || !containerRef.current) return;
      term.open(containerRef.current);
      openedRef.current = true;
      // Renderer addons need the opened element — see the manager above.
      applyRenderer(webglWantedRef.current);
      // Adopt the current scheme now that there is a renderer to take it. The
      // terminal was constructed with whatever `colorScheme` was at setup — which
      // is `undefined` on a cold start, since settings load asynchronously — and
      // the theme effect deliberately skips a closed terminal, so without this a
      // pane opened after the settings landed would keep the fallback theme.
      term.options.theme = terminalTheme(colorSchemeRef.current);
      fit.fit();
      flushPending();
      invoke("pty_resize", { id, cols: term.cols, rows: term.rows }).catch(() => {});
      if (focusedRef.current) term.focus();
      // The pane may keep growing right after open — the startup fullscreen
      // transition (especially on a larger screen) and late web-font load both
      // change the final cell geometry after this first fit. Re-fit on the next
      // frame, shortly after, and once fonts settle so cols/rows match the final
      // pane size instead of the size at open time.
      requestAnimationFrame(() => { if (!cancelled) doFitRef.current?.(); });
      setTimeout(() => { if (!cancelled) doFitRef.current?.(); }, 300);
      document.fonts?.ready?.then(() => { if (!cancelled) doFitRef.current?.(); }).catch(() => {});
    };

    // What this tab counts as for the usage recap. A `local_agent` tab always
    // carries its model in the env Eldrun spawned it with, and that is the only
    // signal here that distinguishes it from the cloud agent of the same command
    // (a local model driven through `vibe` still has cmd "vibe") — TerminalView
    // is handed cmd/env, not the TabEntry's kind.
    const localModel = env.ELDRUN_LOCAL_MODEL || env.VIBE_ACTIVE_MODEL;
    const kind: TabKind = localModel ? "local_agent" : cmdToKind(cmd);
    const agentLeaf = agentPromptLeaf({ kind, cmd, env });
    // A shell tab can be RESUMED with no initialInput to type — a tmux reattach on
    // reconnect/relaunch. tmux probes the outer terminal on attach (secondary DA,
    // `ESC[>c`); xterm's reply arrives after tmux has handed the pane to the shell,
    // so it lands in readline as `^[[>0;276;0c`. Open the same startup-suppression
    // window (line 226 only opens it for an auto-run tab) for ANY shell tab, closed
    // on the first real keystroke in onData below — so the reattach junk is eaten
    // but a program the user later launches still gets its own identity replies.
    if (kind === "shell") initialInputPending.current = true;
    const scope = splitPtyId(id)?.scope ?? ROOT_SCOPE;

    /** One thing asked: a prompt to an agent, or a command in a shell. */
    const countSubmit = () => {
      if (agentLeaf) {
        bumpUsage(scope, sub(METRIC.AGENT_PROMPT, agentLeaf));
        // "Agent tabs you used today" — once per tab per day, however much you
        // then ask it.
        markAgentActive(scope, id, sub(METRIC.AGENT_ACTIVE, agentLeaf));
      } else if (kind === "shell") {
        bumpUsage(scope, METRIC.SHELL_COMMAND);
      }
    };

    // Wire keyboard input → PTY write. The input stamp is what licenses this
    // tab's later output to show as "working"/"done" (see noteUserInput).
    //
    // This is also the one place Eldrun sees everything the user asks an agent,
    // so the usage recap's "you asked them N things" is counted here (see
    // lib/promptCount): Enter with content pending = one submit.
    term.onData((data) => {
      if (staleParse > 0 && isTerminalReport(data)) {
        return; // an answer to a query xterm only just parsed out of replayed output
      }
      if (initialInputPending.current && isTerminalIdentityResponse(data)) {
        return; // swallow the startup / tmux-reattach identity reply (see above)
      }
      // A genuine user keystroke — a printable char or Enter, i.e. NOT an
      // ESC-prefixed control — closes the identity-suppression window. Terminal
      // auto-reports (cursor-position `\x1b[…R`, other DA replies) are ALSO delivered
      // through onData and are ESC-prefixed; they must NOT lift the gate, or a late
      // DA2 reply arriving on the tmux-attach probe burst right after one of them
      // would leak to the shell prompt as `^[[>0;276;0c` (the resume bug). A program
      // that needs DA detection is launched by keystrokes, which close the window
      // first, so its own replies still flow through.
      if (initialInputPending.current && data && !data.startsWith("\x1b")) {
        initialInputPending.current = false;
      }
      noteUserInput(id);
      if (noteInput(id, data) > 0) countSubmit();
      writePtyInput(id, PTY_ENCODER.encode(data)).catch(console.error);
    });

    // A terminal bell means the agent wants to be looked at NOW, so it shortcuts
    // the quiet window the activity store otherwise waits out before calling a
    // turn finished. It is only a hint, never the source of truth: agents ring it
    // optionally, and a pane that has never been opened has no xterm to parse it
    // at all. WHAT the agent wants (a decision vs a finished turn) is worked out
    // in the store from the raw output tail — reading the screen here would race
    // the paint, since onBell fires as xterm parses the BEL, before the prompt
    // that follows it in the same chunk has landed in the buffer.
    // xterm fires this only for a real BEL control, not an OSC title terminator,
    // so title changes don't false-trigger. Disposed with `term` on unmount.
    term.onBell(() => {
      useActivityStore.getState().noteBell(id);
    });

    // OSC 52 clipboard write: TUIs (Claude Code's own copy action among them)
    // set the system clipboard by writing `ESC ] 52 ; c ; <base64> BEL/ST`
    // rather than relying on a host-side mouse selection — the standard escape
    // for "copy this over SSH/tmux where the program can't reach the clipboard
    // itself". xterm parses OSC codes but performs no action on 52 without a
    // handler, so the CLI reports success (it only confirms the write *reached
    // the terminal*) while the OS clipboard silently keeps its old contents.
    // `c` is the only target register Eldrun has one clipboard for; a `?`
    // query (read-back) is intentionally left unhandled — implementing it would
    // let any program read whatever the user last copied elsewhere.
    // Gated rather than trusted: the payload is sanitized and capped by
    // `decodeOsc52Clipboard` (newlines stripped, read-back refused), and the write
    // is allowed only while THIS pane has the keyboard focus — so a background
    // agent, a build script or a remote host cannot silently swap the clipboard
    // out from under whatever the user is actually working in. Every accepted
    // write announces itself in the transient toast, so a clipboard the user did
    // not fill is never a surprise.
    const oscHandler = term.parser.registerOscHandler(52, (data) => {
      if (!focusedRef.current) return true;
      const text = decodeOsc52Clipboard(data);
      if (text === null) return true;
      navigator.clipboard?.writeText(text).catch(() => {});
      useProjectsStore.setState({ switchToast: clipboardNoticeRef.current });
      return true;
    });

    // Copy-on-select: a mouse-made selection (drag, double/triple-click) copies
    // itself to the clipboard with no chord needed, matching most native
    // terminals. Debounced so a drag firing onSelectionChange on every cell it
    // crosses doesn't issue a clipboard write per event — only once ~60ms after
    // the selection settles. Ctrl+Shift+C below stays as the explicit fallback
    // (e.g. a selection made without the mouse never fires this).
    let selectionCopyTimer: ReturnType<typeof setTimeout> | null = null;
    term.onSelectionChange(() => {
      const sel = term.getSelection();
      if (!sel) return;
      if (selectionCopyTimer) clearTimeout(selectionCopyTimer);
      selectionCopyTimer = setTimeout(() => {
        navigator.clipboard?.writeText(sel).catch(() => {});
      }, 60);
    });

    // Agent CLIs set the terminal title (OSC 0/2) to a short summary of what
    // they're doing — the same signal a native terminal shows in its tab. Capture
    // it per tab so the tab hover card can surface it as the agent task summary.
    // Disposed with `term` on unmount.
    term.onTitleChange((title) => {
      useAgentTaskStore.getState().setTabTitle(id, title);
    });

    // Copy/paste: xterm binds neither itself, so without this the terminal has no
    // way to copy a selection (the agent-terminal "can't copy" report). Use the
    // standard terminal chords — Ctrl+Shift+C copies the current selection, Ctrl+
    // Shift+V pastes clipboard text into the PTY — and deliberately leave plain
    // Ctrl+C alone so it still sends SIGINT to the running program (interrupting
    // an agent). Returning false swallows the chord so xterm doesn't also forward
    // it to the PTY as a control sequence.
    // Apply a new font size to this pane and (when `persist`) save + broadcast it
    // so every other open agent pane restyles to match. Refit on the next frame:
    // xterm needs a beat to re-measure the cell after fontSize changes before
    // FitAddon can read the new geometry.
    const applyFontSize = (size: number, persist: boolean) => {
      const next = clampFontSize(size);
      if (next !== term.options.fontSize) {
        term.options.fontSize = next;
        requestAnimationFrame(() => { if (!cancelled) doFitRef.current?.(); });
      }
      if (persist) {
        try {
          localStorage.setItem(AGENT_FONT_KEY, String(next));
        } catch {
          /* ignore storage failures */
        }
        window.dispatchEvent(new CustomEvent<number>(AGENT_ZOOM_EVENT, { detail: next }));
      }
    };

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      // Ctrl +/-/0 zoom (agent panes only). preventDefault stops WebKit's own
      // page-zoom; returning false stops xterm forwarding the chord to the PTY;
      // stopPropagation stops the WINDOW-level per-window zoom handler (useKeyboard
      // / DetachedApp) from ALSO webview-zooming — an agent pane zooms its FONT, not
      // the whole window.
      if (zoomable && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
        const cur = term.options.fontSize ?? DEFAULT_FONT_SIZE;
        if (e.code === "Equal") { e.preventDefault(); e.stopPropagation(); applyFontSize(cur + 1, true); return false; }
        if (e.code === "Minus") { e.preventDefault(); e.stopPropagation(); applyFontSize(cur - 1, true); return false; }
        if (e.code === "Digit0") { e.preventDefault(); e.stopPropagation(); applyFontSize(DEFAULT_FONT_SIZE, true); return false; }
      }
      if (!e.ctrlKey || !e.shiftKey) return true;
      if (e.code === "KeyC") {
        const sel = term.getSelection();
        if (sel) navigator.clipboard?.writeText(sel).catch(() => {});
        return false;
      }
      if (e.code === "KeyV") {
        navigator.clipboard
          ?.readText()
          .then((text) => {
            if (text) {
              noteUserInput(id);
              writePtyInput(id, PTY_ENCODER.encode(text)).catch(console.error);
            }
          })
          .catch(() => {});
        return false;
      }
      return true;
    });

    // Subscribed by id through the shared bus (lib/terminalBus) rather than each
    // pane calling `listen()` itself — the backend emits these window-wide, not
    // scoped per PTY, so one `listen()` per mounted terminal meant every output
    // chunk from every running PTY was dispatched to and filtered by every
    // mounted terminal (CenterPanel keeps every loaded active scope mounted).
    // The bus does that dispatch once, in O(1) per id, no matter how many panes
    // are mounted. Subscribing is synchronous, so these are wired up before
    // `setupAndSpawn` below ever awaits `pty_spawn` — no output can arrive first.
    unlistenOutput.current = onTerminalOutput(id, (data) => {
      // Record when the spawned program first produces output — used to tell
      // when an agent TUI has actually started so we don't type the
      // initialInput before it can accept keystrokes (see below).
      if (firstOutputAt.current === null) firstOutputAt.current = Date.now();
      writeTerm(data);
    });

    // The backend's replay of what streamed while this pane was hidden
    // (visible-only streaming — a hidden pane's PTY emits no terminal-output
    // at all; showing it drains the Rust-side buffer as one of these). It is
    // STALE output written late, so it goes through pendingOutput and
    // flushPending's stripTerminalQueries guard, never a bare term.write — a
    // terminal query in it would be answered on parse and typed into the
    // shell (the tmux attach-probe bug flushPending documents).
    unlistenReplay.current = onTerminalReplay(id, (data) => {
      if (firstOutputAt.current === null) firstOutputAt.current = Date.now();
      pendingOutput.current += data;
      if (pendingOutput.current.length > PENDING_OUTPUT_CAP * 2) {
        pendingOutput.current = pendingOutput.current.slice(-PENDING_OUTPUT_CAP);
      }
      if (openedRef.current && visibleRef.current) flushPending();
    });

    unlistenReady.current = onTerminalReady(id, () => {
      writeTerm("\r\n");
      if (initialInput && !initialInputSent.current) {
        if (!claimInitialInput(id, initialInput)) {
          initialInputSent.current = true;
          initialInputPending.current = false;
          return;
        }
        initialInputSent.current = true;
        // `terminal-ready` fires as soon as the PTY is spawned, but an agent
        // TUI (Claude, etc.) needs a beat to boot before it reads stdin.
        // Typing the command immediately means the keystrokes/Enter land
        // before the input box is live, so the text appears but never
        // submits. Wait until the program has produced output for a short
        // cushion (boot done) — capped by a hard timeout — then type the
        // text and submit it with a single Enter (CR) a beat later, as a
        // separate write so a trailing newline isn't swallowed by the TUI's
        // bracketed-paste/buffered input handling.
        const READY_CUSHION_MS = 1200;
        const MAX_WAIT_MS = 5000;
        const scheduledAt = Date.now();
        const typeWhenReady = () => {
          if (cancelled) return;
          const elapsed = Date.now() - scheduledAt;
          const firstOut = firstOutputAt.current;
          const ready =
            firstOut !== null && Date.now() - firstOut >= READY_CUSHION_MS;
          if (!ready && elapsed < MAX_WAIT_MS) {
            initialEnterTimer.current = setTimeout(typeWhenReady, 100);
            return;
          }
          // Typed on the user's behalf — they triggered the flow that
          // opened this tab with a command, so its work counts as asked-for.
          noteUserInput(id);
          writePtyInput(
            id,
            PTY_ENCODER.encode(initialInputForPty(initialInput, kind)),
          ).catch(console.error);
          initialEnterTimer.current = setTimeout(() => {
            initialInputPending.current = false;
            writePtyInput(id, new Uint8Array([0x0d])).catch(console.error);
          }, 200);
        };
        typeWhenReady();
      }
    });

    unlistenExit.current = onTerminalExit(id, () => {
      writeTerm("\r\n\x1b[33m[process exited]\x1b[0m\r\n");
    });

    const setupAndSpawn = async () => {
      // #42: an attach-only terminal (detached window) must NEVER spawn the PTY.
      // The PTY already exists, spawned by the main window's pane; pty_spawn with
      // a duplicate id would kill+respawn it, destroying scrollback / the agent
      // session. We only subscribe to the broadcast output/input by id.
      if (attachOnly) return;

      // A (re)spawn is a new program: wipe what the activity store recorded
      // about the previous occupant of this id, so a reopened project's resume
      // replay can't ride an old input stamp into a "working"/"done" glow.
      notePtySpawn(id);
      const spawn = () =>
        invoke("pty_spawn", {
          opts: { id, cmd, args, env, cwd, cols: term.cols, rows: term.rows, local_only: localOnly, sandbox, project_id: projectId ?? null, remote_host_id: remoteHostId ?? null, tmux_session: tmuxSession ?? null, tmux_attach: tmuxAttach ?? null, host_bound_uid: hostBoundUid ?? null },
        });
      try {
        await spawn();
      } catch (e) {
        if (cancelled) return;
        // **The HPC tag's refusal, made actionable** (G.24). `pty_spawn` dials the
        // host before wrapping a remote tab, and on a machine tagged HPC it
        // refuses with `hpc_mode`'s sentinel — deliberately, because it receives
        // identical options for a tab *restored at relaunch* (nobody asked for
        // that) and for a click. The backend's own comment says the frontend
        // should "offer connect and open"; nothing did, so the raw
        // `ELDRUN_HPC_GUARD connect user@host:22` was printed into the pane.
        //
        // Connecting the project is what actually lifts the refusal: the pool
        // holds a standing authorization once it is up
        // (`services::remote::connect_host`), which is the only distinction this
        // seam can make. So the retry is connect-then-spawn, not a flag.
        const refusal = hpcGuardRefusal(e);
        if (!refusal) {
          writeTerm(`\r\n\x1b[31m[spawn error: ${e}]\x1b[0m\r\n`);
          return;
        }
        const ok = await useHpcGuardStore.getState().request(refusal.kind, refusal.target);
        if (cancelled) return;
        if (!ok) {
          // Backing out is an answer, not a failure — say what did not happen and
          // how to get it, rather than leaving a blank pane.
          writeTerm(
            `\r\n\x1b[33m[${refusal.target} is tagged as a cluster login node, so this tab did not connect.\r\n` +
              `Connect the project from its pill to open tabs on it.]\x1b[0m\r\n`,
          );
          return;
        }
        try {
          await invoke("remote_connect", {
            projectId: projectId ?? null,
            hostId: remoteHostId ?? null,
            password: null,
          });
          if (cancelled) return;
          await spawn();
        } catch (retryErr) {
          if (!cancelled) writeTerm(`\r\n\x1b[31m[spawn error: ${retryErr}]\x1b[0m\r\n`);
        }
      }
    };

    setupAndSpawn();

    // Resize observer — handles container-level resizes (e.g. panel open/close)
    // and the hidden→visible transition (display:none→flex changes the box from
    // zero to its measured size, which fires the observer). While still unopened
    // this opens the terminal once it gains a layout box; afterwards it refits.
    const doFit = () => {
      if (!openedRef.current) {
        tryOpen();
        return;
      }
      if (fitRef.current && termRef.current && hasLayout()) {
        // A re-shown pane holds whatever streamed while it was hidden
        // (writeTerm buffers past a hidden pane's xterm) — flush it in the
        // same beat the pane regains its layout, before the refit, so the
        // catch-up isn't waiting on the next live chunk to drain it.
        if (visibleRef.current) flushPending();
        fitRef.current.fit();
        invoke("pty_resize", {
          id,
          cols: termRef.current.cols,
          rows: termRef.current.rows,
        }).catch(() => {});
      }
    };
    doFitRef.current = doFit;
    const ro = new ResizeObserver(doFit);
    if (containerRef.current) ro.observe(containerRef.current);

    // Window resize listener — WebKitGTK doesn't reliably fire ResizeObserver
    // for viewport-level changes (maximize, fullscreen toggle).
    window.addEventListener("resize", doFit);

    // Open watchdog (the "black agent tab" gate, esp. Windows/WebView2).
    // tryOpen() only runs from the ResizeObserver and the `visible` effect. When
    // a pane goes display:none → flex while `visible` was already true, the only
    // trigger is the ResizeObserver firing on that box change — and WebView2
    // occasionally drops that callback. The PTY has already spawned and is
    // buffering its output into pendingOutput, but xterm never opens, so the
    // pane stays black AND unresponsive (no open → no focus → keystrokes go
    // nowhere). This bounded poll guarantees we keep attempting tryOpen while the
    // pane is visible-but-unopened, so it can never get stuck closed. It costs a
    // few cheap ticks at mount, stops the instant the terminal opens, and is
    // capped by a wall-clock deadline so it can't spin forever (a legitimately
    // hidden pane is opened by the `visible` effect when it is next shown).
    const OPEN_WATCH_INTERVAL_MS = 150;
    const OPEN_WATCH_DEADLINE_MS = 8000;
    const watchStart = Date.now();
    const watchOpen = () => {
      openWatchTimer.current = null;
      if (cancelled || openedRef.current) return;
      if (visibleRef.current) tryOpen();
      if (openedRef.current || Date.now() - watchStart >= OPEN_WATCH_DEADLINE_MS) return;
      openWatchTimer.current = setTimeout(watchOpen, OPEN_WATCH_INTERVAL_MS);
    };
    openWatchTimer.current = setTimeout(watchOpen, OPEN_WATCH_INTERVAL_MS);

    // Agent-pane zoom: Ctrl+wheel scales the font; a window event keeps every
    // other open agent pane in sync with the shared level. Both are no-ops for
    // non-agent shells. The wheel listener is non-passive so it can preventDefault.
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const cur = termRef.current?.options.fontSize ?? DEFAULT_FONT_SIZE;
      applyFontSize(cur + (e.deltaY < 0 ? 1 : -1), true);
    };
    // Typed as the global EventListener because the `Event` identifier is shadowed
    // here by Tauri's generic Event<T> import.
    const onZoomEvent: EventListener = (e) => {
      const size = (e as CustomEvent<number>).detail;
      if (typeof size === "number") applyFontSize(size, false);
    };
    if (zoomable) {
      containerRef.current?.addEventListener("wheel", onWheel, { passive: false });
      window.addEventListener(AGENT_ZOOM_EVENT, onZoomEvent);
    }

    return () => {
      cancelled = true;
      clearPtyInput(id);
      if (initialEnterTimer.current) clearTimeout(initialEnterTimer.current);
      if (openWatchTimer.current) clearTimeout(openWatchTimer.current);
      if (selectionCopyTimer) clearTimeout(selectionCopyTimer);
      oscHandler.dispose();
      window.removeEventListener("resize", doFit);
      if (zoomable) {
        containerRef.current?.removeEventListener("wheel", onWheel);
        window.removeEventListener(AGENT_ZOOM_EVENT, onZoomEvent);
      }
      ro.disconnect();
      doFitRef.current = null;
      applyRendererRef.current = null;
      unlistenOutput.current?.();
      unlistenReplay.current?.();
      unlistenReady.current?.();
      unlistenExit.current?.();
      unlistenOutput.current = null;
      unlistenReplay.current = null;
      unlistenReady.current = null;
      unlistenExit.current = null;
      // #42: do NOT kill the PTY on unmount when (a) this is an attach-only
      // viewer (the detached window — the main pane owns it), or (b) this pane is
      // unmounting *because its tab was just detached* into a popped-out window
      // (the detached attach-only viewer is now reading this PTY; killing it
      // would leave that window a dead black pane). Only a real close tears it
      // down. (c) `persistOnUnmount` — a dialog-embedded connection terminal
      // whose tunnel/login must outlive the dialog.
      if (!attachOnly && !isDetachedPtyId(id) && !persistOnUnmount) {
        invoke("pty_kill", { id }).catch(() => {});
        // Drop the captured agent-task title so a closed tab's summary can't
        // linger against a future tab that reuses the key.
        const parts = id.split(":");
        useAgentTaskStore.getState().clearTabTitle(parts.length > 1 ? parts.slice(1).join(":") : id);
      }
      term.dispose();
      // Retire the lifecycle refs WITH the terminal they describe. Every guard in
      // this file asks one of these three whether there is a terminal to touch
      // (`openedRef` in the focus effect, `termRef` in the theme effect, both in
      // `doFit`), and a disposed xterm answers none of them for itself — it keeps
      // its object identity while tearing its renderer down, so a call that
      // arrives afterwards fails inside xterm with
      // "undefined is not an object (evaluating 'this._renderer.value.dimensions')"
      // rather than being refused. That is not hypothetical: this effect re-runs
      // whenever the spawn deps change (an agent mode flip, a container toggle,
      // a host switch) and unmounts on every tab close, while `colorScheme`,
      // focus and zoom are all driven from OUTSIDE it — so a theme or focus
      // change landing in the same tick as a teardown reached a dead terminal.
      // It was the single most common error in the crash log, thrown on every
      // launch as restored tabs settled. Clearing here restores the invariant the
      // guards assume: these refs describe a LIVE terminal or nothing.
      termRef.current = null;
      fitRef.current = null;
      openedRef.current = false;
    };
  }, [id, cmd, cwd, initialInput, argsKey, envKey, localOnly, sandbox, projectId, remoteHostId, tmuxSession, tmuxAttach, hostBoundUid, attachOnly, zoomable, persistOnUnmount]);

  // Re-theme a LIVE, OPEN terminal. Both halves of that guard are load-bearing,
  // and `termRef.current` alone was neither: assigning `options.theme` makes
  // xterm refresh through its renderer, and the renderer exists only between
  // `open()` and `dispose()`. Outside that window it throws
  // "undefined is not an object (evaluating 'this._renderer.value.dimensions')".
  // The closed case is the one that fired on every launch: `colorScheme` comes
  // from settings, which load a few seconds AFTER the restored tabs mount, so the
  // scheme arriving flipped this effect over a whole layout's worth of terminals
  // that had been constructed but not yet opened (hidden tabs, panes still
  // waiting on a layout box). `tryOpen` applies the scheme on open instead, so
  // skipping a closed terminal here costs nothing.
  useEffect(() => {
    if (openedRef.current && termRef.current) {
      termRef.current.options.theme = terminalTheme(colorScheme);
    }
  }, [colorScheme]);

  // Re-pick the renderer of a LIVE, OPEN terminal when the WebGL flag moves —
  // which includes settings simply arriving: they load a few seconds after the
  // restored tabs mount, so a pane opened before that read the flag as off and
  // would otherwise stay on canvas for the whole session. The ref is null (or
  // its closure self-guards on openedRef) outside the open()..dispose() window,
  // so a closed terminal is skipped exactly as the theme effect skips it.
  useEffect(() => {
    applyRendererRef.current?.(webglWanted);
  }, [webglWanted]);

  // Open (first time) or re-fit when the pane becomes visible or its cell
  // geometry changes (grid layout switches). The container ResizeObserver covers
  // most resizes, but a hidden→visible transition doesn't always fire it, so
  // drive the open/fit logic explicitly here.
  useEffect(() => {
    if (visible) doFitRef.current?.();
  }, [visible, id]);

  // Visible-only streaming: report pane visibility so the backend can stop
  // emitting a hidden pane's output over IPC entirely (it buffers in Rust and
  // condenses throttled `terminal-activity` digests for the pill indicators;
  // the buffer comes back as one `terminal-replay` when the pane is shown).
  // Each mounted view owns a stable token. Cleanup removes only that view, so a
  // hidden main pane can never silence a visible detached pane (or vice versa).
  useEffect(() => {
    const updateSeq = ++viewerUpdateSeq.current;
    invoke("pty_set_visible", { id, viewerId, visible, updateSeq }).catch(() => {});
  }, [id, viewerId, visible]);

  useEffect(() => {
    return () => {
      const updateSeq = ++viewerUpdateSeq.current;
      invoke("pty_remove_view", { id, viewerId, updateSeq }).catch(() => {});
    };
  }, [id, viewerId]);

  // Take keyboard focus only when this pane is the focused one (and opened).
  useEffect(() => {
    if (focused && openedRef.current && termRef.current) termRef.current.focus();
  }, [focused]);

  return (
    <div
      ref={containerRef}
      style={{
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        position: "relative",
        display: "flex",
        flexDirection: "column",
        // Agent panes get a touch more breathing room on the left and a bit less
        // on the right (the viewport scrollbar already insets the right edge), so
        // the text margins read as balanced. FitAddon accounts for this padding.
        ...(zoomable ? { paddingLeft: 10, paddingRight: 4 } : null),
        background:
          colorScheme === "light_lavender"
            ? "#faf9fe"
            : colorScheme === "light" || colorScheme === "fancy_light"
              ? "#ffffff"
              : "#0d1117",
      }}
    />
  );
}
