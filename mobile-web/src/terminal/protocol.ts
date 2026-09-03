export const TERMINAL_PROTOCOL = "eldrun-terminal.v1";
export type TerminalControl =
  | { type: "ready" }
  | { type: "resize"; cols: number; rows: number }
  | { type: "ping" }
  | { type: "detached" };

/** Server → client. Mirrors `TerminalEvent` in
 * `src-tauri/src/services/mobile_control/protocol.rs`. */
export type TerminalEvent =
  | { type: "pong" }
  | { type: "window"; cols: number; rows: number }
  | { type: "replay" }
  | { type: "closing"; reason: string; retry: boolean };

/** The geometry the desktop accepts in a `resize`. Mirrors `MIN_COLS` …
 * `MAX_ROWS` in `protocol.rs`: a size outside these is answered with
 * `invalid_terminal_size`, a close that never retries. */
export const TERMINAL_SIZE = { minCols: 20, maxCols: 400, minRows: 5, maxRows: 200 } as const;
