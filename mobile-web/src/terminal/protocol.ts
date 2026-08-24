export const TERMINAL_PROTOCOL = "eldrun-terminal.v1";
export type TerminalControl =
  | { type: "ready" }
  | { type: "resize"; cols: number; rows: number }
  | { type: "ping" }
  | { type: "detached" };

