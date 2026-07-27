import { listen } from "@tauri-apps/api/event";

/**
 * Single global subscription per PTY-lifecycle event, fanned out to per-id
 * handlers. Every mounted `TerminalView` used to call `listen("terminal-output",
 * ...)` itself and filter `ev.payload.id === id` client-side — but the backend
 * emits these as plain window-wide events (`app.emit`, not scoped per PTY), so
 * every chunk from every running PTY was dispatched to and filtered by EVERY
 * mounted terminal (CenterPanel keeps all tabs, all scopes, mounted forever —
 * see its "flat pane layer" comment). That's O(mounted terminals) work per
 * output chunk, not O(1). Here there is exactly one `listen()` per event type
 * for the app's lifetime, doing an O(1) Map lookup to reach the right pane(s).
 */

interface TerminalOutput {
  id: string;
  data: string;
}

interface TerminalExit {
  id: string;
  code: number | null;
}

type OutputHandler = (data: string) => void;
type ReadyHandler = () => void;
type ExitHandler = (code: number | null) => void;

const outputHandlers = new Map<string, Set<OutputHandler>>();
const readyHandlers = new Map<string, Set<ReadyHandler>>();
const exitHandlers = new Map<string, Set<ExitHandler>>();

let started = false;

function ensureStarted() {
  if (started) return;
  started = true;

  listen<TerminalOutput>("terminal-output", (ev) => {
    const set = outputHandlers.get(ev.payload.id);
    if (!set) return;
    for (const h of set) h(ev.payload.data);
  }).catch(() => {});

  listen<{ id: string }>("terminal-ready", (ev) => {
    const set = readyHandlers.get(ev.payload.id);
    if (!set) return;
    for (const h of set) h();
  }).catch(() => {});

  listen<TerminalExit>("terminal-exit", (ev) => {
    const set = exitHandlers.get(ev.payload.id);
    if (!set) return;
    for (const h of set) h(ev.payload.code);
  }).catch(() => {});
}

function subscribe<H>(registry: Map<string, Set<H>>, id: string, handler: H): () => void {
  ensureStarted();
  let set = registry.get(id);
  if (!set) {
    set = new Set();
    registry.set(id, set);
  }
  set.add(handler);
  return () => {
    set.delete(handler);
    if (set.size === 0) registry.delete(id);
  };
}

export function onTerminalOutput(id: string, handler: OutputHandler): () => void {
  return subscribe(outputHandlers, id, handler);
}

export function onTerminalReady(id: string, handler: ReadyHandler): () => void {
  return subscribe(readyHandlers, id, handler);
}

export function onTerminalExit(id: string, handler: ExitHandler): () => void {
  return subscribe(exitHandlers, id, handler);
}
