import type { TabKind } from "../stores/tabs";

const CSI = "\x1b[";
const claimedInitialInputs = new Set<string>();

/** xterm answers terminal identity probes by emitting CSI ... c back through
 *  `onData`, for example secondary DA: `ESC [ > 0 ; 276 ; 0 c`. During an
 *  auto-run tab startup that response can land in readline before Eldrun types
 *  `initialInput`, making the shell execute `0;276;0c...` instead of the command.
 *  Suppress only the standalone identity replies while an auto-input is pending;
 *  normal interactive terminal programs can still receive them afterward. */
export function isTerminalIdentityResponse(data: string): boolean {
  return new RegExp(`^(?:${CSI.replace("[", "\\[")}[?>]?[0-9;]*c)+$`).test(data);
}

/** Clear any startup junk already sitting in a shell's readline buffer before
 *  auto-typing a command. No-op for agent TUIs: their prompt behavior is not a
 *  POSIX shell line editor. */
export function initialInputForPty(input: string, kind: TabKind): string {
  return kind === "shell" ? `\x15${input}` : input;
}

/** Claim the right to auto-submit `input` for `ptyId`. React dev remounts,
 *  duplicate panes, or duplicate ready events must not type the same run command
 *  twice into one shell. */
export function claimInitialInput(ptyId: string, input: string): boolean {
  const key = `${ptyId}\0${input}`;
  if (claimedInitialInputs.has(key)) return false;
  claimedInitialInputs.add(key);
  return true;
}

export function clearClaimedInitialInputsForTest(): void {
  claimedInitialInputs.clear();
}
