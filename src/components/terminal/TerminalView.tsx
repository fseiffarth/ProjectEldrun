import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "../../stores/settings";
import { cmdToKind, isDetachedPtyId, type TabKind } from "../../stores/tabs";
import { notePtySpawn, noteUserInput, splitPtyId, useActivityStore } from "../../stores/activity";
import { useAgentTaskStore } from "../../stores/agentTask";
import { noteInput } from "../../lib/promptCount";
import { METRIC, agentPromptLeaf, sub } from "../../lib/usageMetrics";
import { ROOT_SCOPE, bumpUsage, markAgentActive } from "../../stores/usage";
import { onTerminalExit, onTerminalOutput, onTerminalReady } from "../../lib/terminalBus";
import { claimInitialInput, initialInputForPty, isTerminalIdentityResponse } from "../../lib/terminalControl";
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

// While a pane is hidden xterm has no renderer to write into, so its PTY output
// is buffered until the terminal is first opened. Cap the retained text so a
// chatty background agent can't grow this without bound; xterm trims to its own
// scrollback on flush anyway.
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

export function TerminalView({ id, cmd, args = [], env = {}, initialInput, cwd, localOnly = false, sandbox = false, projectId = null, remoteHostId = null, tmuxSession = null, tmuxAttach = null, visible, focused, attachOnly = false, zoomable = false, persistOnUnmount = false }: Props) {
  const colorScheme = useSettingsStore((s) => s.settings?.color_scheme);
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const unlistenOutput = useRef<(() => void) | null>(null);
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
  const focusedRef = useRef(focused);
  visibleRef.current = visible;
  focusedRef.current = focused;
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

    // Write PTY output to the terminal once it is open; buffer it otherwise so a
    // hidden pane doesn't lose its scrollback (and doesn't crash xterm's
    // not-yet-initialized renderer).
    const writeTerm = (data: string) => {
      if (openedRef.current) {
        term.write(data);
      } else {
        pendingOutput.current += data;
        if (pendingOutput.current.length > PENDING_OUTPUT_CAP) {
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
      fit.fit();
      if (pendingOutput.current) {
        term.write(pendingOutput.current);
        pendingOutput.current = "";
      }
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
      if (initialInputPending.current && isTerminalIdentityResponse(data)) {
        return;
      }
      noteUserInput(id);
      if (noteInput(id, data) > 0) countSubmit();
      invoke("pty_write", { id, data: PTY_ENCODER.encode(data) }).catch(console.error);
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
      // page-zoom; returning false stops xterm forwarding the chord to the PTY.
      if (zoomable && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
        const cur = term.options.fontSize ?? DEFAULT_FONT_SIZE;
        if (e.code === "Equal") { e.preventDefault(); applyFontSize(cur + 1, true); return false; }
        if (e.code === "Minus") { e.preventDefault(); applyFontSize(cur - 1, true); return false; }
        if (e.code === "Digit0") { e.preventDefault(); applyFontSize(DEFAULT_FONT_SIZE, true); return false; }
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
              invoke("pty_write", { id, data: PTY_ENCODER.encode(text) }).catch(console.error);
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
    // mounted terminal (CenterPanel keeps ALL tabs, ALL scopes, mounted forever).
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
          invoke("pty_write", {
            id,
            data: PTY_ENCODER.encode(initialInputForPty(initialInput, kind)),
          }).catch(console.error);
          initialEnterTimer.current = setTimeout(() => {
            initialInputPending.current = false;
            invoke("pty_write", { id, data: new Uint8Array([0x0d]) }).catch(console.error);
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
      try {
        await invoke("pty_spawn", {
          opts: { id, cmd, args, env, cwd, cols: term.cols, rows: term.rows, local_only: localOnly, sandbox, project_id: projectId ?? null, remote_host_id: remoteHostId ?? null, tmux_session: tmuxSession ?? null, tmux_attach: tmuxAttach ?? null },
        });
      } catch (e) {
        if (!cancelled) {
          writeTerm(`\r\n\x1b[31m[spawn error: ${e}]\x1b[0m\r\n`);
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
      if (initialEnterTimer.current) clearTimeout(initialEnterTimer.current);
      if (openWatchTimer.current) clearTimeout(openWatchTimer.current);
      window.removeEventListener("resize", doFit);
      if (zoomable) {
        containerRef.current?.removeEventListener("wheel", onWheel);
        window.removeEventListener(AGENT_ZOOM_EVENT, onZoomEvent);
      }
      ro.disconnect();
      doFitRef.current = null;
      unlistenOutput.current?.();
      unlistenReady.current?.();
      unlistenExit.current?.();
      unlistenOutput.current = null;
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
    };
  }, [id, cmd, cwd, initialInput, argsKey, envKey, localOnly, sandbox, projectId, remoteHostId, tmuxSession, tmuxAttach, attachOnly, zoomable, persistOnUnmount]);

  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = terminalTheme(colorScheme);
    }
  }, [colorScheme]);

  // Open (first time) or re-fit when the pane becomes visible or its cell
  // geometry changes (grid layout switches). The container ResizeObserver covers
  // most resizes, but a hidden→visible transition doesn't always fire it, so
  // drive the open/fit logic explicitly here.
  useEffect(() => {
    if (visible) doFitRef.current?.();
  }, [visible, id]);

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
