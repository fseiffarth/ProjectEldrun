import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { invoke } from "@tauri-apps/api/core";
import { listen, Event } from "@tauri-apps/api/event";
import { useSettingsStore } from "../../stores/settings";
import "@xterm/xterm/css/xterm.css";

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
  cwd: string;
  active: boolean;
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

export function TerminalView({ id, cmd, args = [], cwd, active }: Props) {
  const colorScheme = useSettingsStore((s) => s.settings?.color_scheme);
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const unlistenOutput = useRef<(() => void) | null>(null);
  const unlistenReady = useRef<(() => void) | null>(null);
  const unlistenExit = useRef<(() => void) | null>(null);
  const argsKey = JSON.stringify(args);

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
    term.open(containerRef.current);
    fit.fit();

    termRef.current = term;
    fitRef.current = fit;

    // Wire keyboard input → PTY write.
    term.onData((data) => {
      const bytes = Array.from(new TextEncoder().encode(data));
      invoke("pty_write", { id, data: bytes }).catch(console.error);
    });

    const setupAndSpawn = async () => {
      const outputListener = await listen<TerminalOutput>(
        "terminal-output",
        (ev: Event<TerminalOutput>) => {
          if (ev.payload.id === id) {
            termRef.current?.write(ev.payload.data);
          }
        },
      );

      const readyListener = await listen("terminal-ready", (ev: Event<{ id: string }>) => {
        if (ev.payload.id === id) {
          termRef.current?.write("\r\n");
        }
      });

      const exitListener = await listen<TerminalExit>(
        "terminal-exit",
        (ev: Event<TerminalExit>) => {
          if (ev.payload.id === id) {
            termRef.current?.write(
              "\r\n\x1b[33m[process exited]\x1b[0m\r\n",
            );
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

      try {
        await invoke("pty_spawn", {
          opts: { id, cmd, args, cwd, cols: term.cols, rows: term.rows },
        });
      } catch (e) {
        if (!cancelled) {
          term.write(`\r\n\x1b[31m[spawn error: ${e}]\x1b[0m\r\n`);
        }
      }
    };

    setupAndSpawn();

    // Resize observer.
    const ro = new ResizeObserver(() => {
      if (fitRef.current && termRef.current) {
        fitRef.current.fit();
        invoke("pty_resize", {
          id,
          cols: termRef.current.cols,
          rows: termRef.current.rows,
        }).catch(() => {});
      }
    });
    if (containerRef.current) ro.observe(containerRef.current);

    return () => {
      cancelled = true;
      ro.disconnect();
      unlistenOutput.current?.();
      unlistenReady.current?.();
      unlistenExit.current?.();
      unlistenOutput.current = null;
      unlistenReady.current = null;
      unlistenExit.current = null;
      invoke("pty_kill", { id }).catch(() => {});
      term.dispose();
    };
  }, [id, cmd, cwd, argsKey]);

  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = terminalTheme(colorScheme);
    }
  }, [colorScheme]);

  // Re-fit when the tab becomes visible.
  useEffect(() => {
    if (active && fitRef.current && termRef.current) {
      fitRef.current.fit();
      termRef.current.focus();
    }
  }, [active]);

  return (
    <div
      ref={containerRef}
      style={{
        flex: 1,
        minHeight: 0,
        position: "relative",
        display: active ? "flex" : "none",
        flexDirection: "column",
        background: colorScheme === "light" || colorScheme === "fancy_light" ? "#ffffff" : "#0d1117",
      }}
    />
  );
}
