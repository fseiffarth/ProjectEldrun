/**
 * The print manager's wire types — the exact shapes `commands::printing`
 * serializes. Kept in `types/` rather than inside the pane because the pane and
 * `lib/printing.ts` both read them, and because a wire type that lives next to
 * its consumer is the one that quietly grows a field the backend never sends.
 */

/** The small closed set of printer states the backend maps every print system's
 *  vocabulary onto. Anything it does not recognize arrives as `unknown` — never
 *  as a healthy-looking value. */
export type PrinterState = "idle" | "printing" | "stopped" | "unknown";

/** Job states, same rule. */
export type PrintJobState = "printing" | "pending" | "held" | "unknown";

export interface PrinterInfo {
  name: string;
  description: string;
  location: string;
  state: PrinterState;
  /** The reason a stopped printer reports ("(paused)", "Out of paper"). */
  state_message: string;
  /**
   * Whether the queue takes new jobs. Deliberately separate from `state`: a
   * printer can be stopped but still accepting (work piles up silently), and
   * that combination is precisely what someone opens a print manager to find.
   */
  accepting: boolean;
  is_default: boolean;
}

export interface PrintJob {
  /** The id the print system cancels by (`Office-42` on CUPS, a number on
   *  Windows). Passed back verbatim — never reconstructed here. */
  id: string;
  number: number;
  printer: string;
  user: string;
  title: string;
  size_bytes: number;
  /** As the print system reported it: a locale-formatted string, not a date. */
  submitted: string;
  state: PrintJobState;
}

export interface PrintSnapshot {
  /** False when this machine has no usable print system. The pane then renders
   *  `note` instead of an empty table, which would read as "no printers". */
  supported: boolean;
  backend: "cups" | "windows" | "none";
  default_printer: string | null;
  printers: PrinterInfo[];
  jobs: PrintJob[];
  /** A sentence for the user when something is off; empty on a clean read. */
  note: string;
}
