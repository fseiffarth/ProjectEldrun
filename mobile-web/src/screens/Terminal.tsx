import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { TabRow } from "../api";
import { TERMINAL_PROTOCOL } from "../terminal/protocol";

export function Terminal({ tab, back }: { tab: TabRow; back: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const write = useRef<(value: string) => void>(() => {});
  const [ctrl, setCtrl] = useState(false);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    if (!host.current) return;
    const term = new XTerm({ cursorBlink: true, fontSize: 14, scrollback: 4000, theme: { background: "#0b0d13", foreground: "#e7e9f2", cursor: "#f4c95d" } });
    const fit = new FitAddon(); term.loadAddon(fit); term.open(host.current); fit.fit();
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${scheme}://${location.host}/api/v1/tabs/${tab.id}/terminal`, TERMINAL_PROTOCOL);
    write.current = (value) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(new TextEncoder().encode(value));
    };
    ws.binaryType = "arraybuffer";
    ws.onopen = () => { setConnected(true); ws.send(JSON.stringify({ type: "ready" })); ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows })); };
    ws.onclose = () => { setConnected(false); term.clear(); term.write("\r\nHost unavailable. Terminal output is not retained offline.\r\n"); };
    ws.onmessage = (event) => { if (event.data instanceof ArrayBuffer) term.write(new Uint8Array(event.data)); };
    const data = term.onData((value) => { if (ws.readyState === WebSocket.OPEN) ws.send(new TextEncoder().encode(value)); });
    let resizeTimer = 0;
    const resize = () => { fit.fit(); clearTimeout(resizeTimer); resizeTimer = window.setTimeout(() => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows })), 100); };
    window.addEventListener("resize", resize);
    const ping = window.setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "ping" })), 20_000);
    return () => { write.current = () => {}; if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "detached" })); ws.close(); data.dispose(); term.dispose(); clearInterval(ping); clearTimeout(resizeTimer); window.removeEventListener("resize", resize); };
  }, [tab.id]);
  const type = (value: string) => write.current(value);
  return <main className="terminal-screen"><header><button className="back" onClick={back}>‹</button><h1>{tab.label}</h1><span className={connected ? "lamp" : "lamp off"} /></header><div ref={host} className="terminal" onClick={() => input.current?.focus()} />
    <textarea ref={input} className="input-proxy" aria-label="Terminal keyboard input" autoCapitalize="none" autoCorrect="off" spellCheck={false} onInput={(event) => { const value = event.currentTarget.value; if (value) type(ctrl ? String.fromCharCode(value.toUpperCase().charCodeAt(0) & 31) : value); event.currentTarget.value = ""; setCtrl(false); }} />
    <div className="keys"><button className={ctrl ? "selected" : ""} onClick={() => setCtrl(!ctrl)}>Ctrl</button><button onClick={() => type("\u001b")}>Esc</button><button onClick={() => type("\t")}>Tab</button><button onClick={() => type("\u001b[D")}>←</button><button onClick={() => type("\u001b[A")}>↑</button><button onClick={() => type("\u001b[B")}>↓</button><button onClick={() => type("\u001b[C")}>→</button><button onClick={() => type("\r")}>Enter</button><button onClick={() => type("\u007f")}>⌫</button><button className="danger" onClick={() => window.confirm("Send interrupt (Ctrl+C)?") && type("\u0003")}>Interrupt</button></div>
  </main>;
}
