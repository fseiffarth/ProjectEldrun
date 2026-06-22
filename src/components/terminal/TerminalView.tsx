import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { invoke } from "@tauri-apps/api/core";
import { listen, Event } from "@tauri-apps/api/event";
import { useSettingsStore } from "../../stores/settings";
import { isDetachedPtyId } from "../../stores/tabs";
import "@xterm/xterm/css/xterm.css";

// Hoisted to module scope: keystroke input fires this on every key, so we reuse
// one encoder rather than allocating a `new TextEncoder()` per keystroke. The
// resulting `Uint8Array` is passed straight to `pty_write` (Tauri v2 ships typed
// arrays to a `Vec<u8>` command directly), avoiding the per-key `Array.from`.
const PTY_ENCODER = new TextEncoder();

interface TerminalOutput {
  id: string;
  data: string;
}

interface TerminalExit {
  id: string;
  code: number | null;
}

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
}

function terminalTheme(scheme: string | undefined) {
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

export function TerminalView({ id, cmd, args = [], env = {}, initialInput, cwd, localOnly = false, visible, focused, attachOnly = false }: Props) {
  const colorScheme = useSettingsStore((s) => s.settings?.color_scheme);
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const unlistenOutput = useRef<(() => void) | null>(null);
  const unlistenReady = useRef<(() => void) | null>(null);
  const unlistenExit = useRef<(() => void) | null>(null);
  const initialInputSent = useRef(false);
  const initialEnterTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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

    const term = new Terminal({
      scrollback: 5000,
      allowProposedApi: false,
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
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

    // Wire keyboard input → PTY write.
    term.onData((data) => {
      invoke("pty_write", { id, data: PTY_ENCODER.encode(data) }).catch(console.error);
    });

    const setupAndSpawn = async () => {
      const outputListener = await listen<TerminalOutput>(
        "terminal-output",
        (ev: Event<TerminalOutput>) => {
          if (ev.payload.id === id) {
            // Record when the spawned program first produces output — used to
            // tell when an agent TUI has actually started so we don't type the
            // initialInput before it can accept keystrokes (see below).
            if (firstOutputAt.current === null) firstOutputAt.current = Date.now();
            writeTerm(ev.payload.data);
          }
        },
      );

      const readyListener = await listen("terminal-ready", (ev: Event<{ id: string }>) => {
        if (ev.payload.id === id) {
          writeTerm("\r\n");
          if (initialInput && !initialInputSent.current) {
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
              invoke("pty_write", { id, data: PTY_ENCODER.encode(initialInput) }).catch(console.error);
              initialEnterTimer.current = setTimeout(() => {
                invoke("pty_write", { id, data: new Uint8Array([0x0d]) }).catch(console.error);
              }, 200);
            };
            typeWhenReady();
          }
        }
      });

      const exitListener = await listen<TerminalExit>(
        "terminal-exit",
        (ev: Event<TerminalExit>) => {
          if (ev.payload.id === id) {
            writeTerm("\r\n\x1b[33m[process exited]\x1b[0m\r\n");
          }
        },
      );

      if (cancelled) {
        outputListener();
        readyListener();
        exitListener();
        return;
      }

      unlistenOutput.current = outputListener;
      unlistenReady.current = readyListener;
      unlistenExit.current = exitListener;

      // #42: an attach-only terminal (detached window) must NEVER spawn the PTY.
      // The PTY already exists, spawned by the main window's pane; pty_spawn with
      // a duplicate id would kill+respawn it, destroying scrollback / the agent
      // session. We only subscribe to the broadcast output/input by id.
      if (attachOnly) return;

      try {
        await invoke("pty_spawn", {
          opts: { id, cmd, args, env, cwd, cols: term.cols, rows: term.rows, local_only: localOnly },
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

    return () => {
      cancelled = true;
      if (initialEnterTimer.current) clearTimeout(initialEnterTimer.current);
      window.removeEventListener("resize", doFit);
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
      // down.
      if (!attachOnly && !isDetachedPtyId(id)) {
        invoke("pty_kill", { id }).catch(() => {});
      }
      term.dispose();
    };
  }, [id, cmd, cwd, initialInput, argsKey, envKey, localOnly, attachOnly]);

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
        background: colorScheme === "light" || colorScheme === "fancy_light" ? "#ffffff" : "#0d1117",
      }}
    />
  );
}
