/**
 * **The** typed invoke surface for the native print manager — one wrapper per
 * `print_*` command, plus the pure helpers its pane renders through. The
 * convention `lib/mail.ts` and `lib/browser.ts` established: no component calls
 * `invoke("print_*")` itself.
 *
 * Three properties are load-bearing rather than stylistic:
 *
 *  1. **No wrapper takes a filesystem path.** There is no print-this-file
 *     command at all — {@link printTestPage} names a printer and the *backend*
 *     writes the page it sends. Printing a document you are looking at is
 *     already the viewers' job (`lib/viewers/print.ts`, the platform print
 *     dialog); this pane manages queues, so it never needs a path and therefore
 *     never offers one.
 *  2. **Every wrapper tolerates a missing command.** {@link printSnapshot}
 *     resolves to a definite "nothing is supported" answer rather than
 *     rejecting, so a frontend running against an older backend renders its
 *     explanation instead of an empty table.
 *  3. **State words are rendered, never inferred.** The backend maps CUPS and
 *     the Windows spooler onto one small closed set; {@link printerStateKey}
 *     degrades an unrecognized value to "unknown" rather than to something that
 *     looks healthy.
 */

import { invoke } from "@tauri-apps/api/core";
import type { PrintJob, PrintJobState, PrintSnapshot, PrinterInfo, PrinterState } from "../types/printing";
import type { TranslationKey } from "./i18n";
// One byte formatter, not two: a queued job's size reads exactly like a mail
// attachment's, and the mail module is where that definition already lives.
import { formatSize } from "./mail";

export { formatSize };

/** The answer a machine with no reachable print system gets. Also what a
 *  rejected invoke degrades to — a build whose backend predates this feature is
 *  in the same situation as a container with no CUPS, and should say so. */
const NO_PRINT_SYSTEM: PrintSnapshot = {
  supported: false,
  backend: "none",
  default_printer: null,
  printers: [],
  jobs: [],
  note: "",
};

/** One reading of the machine's printers and queues. Resolves, never rejects. */
export async function printSnapshot(): Promise<PrintSnapshot> {
  try {
    return await invoke<PrintSnapshot>("print_system_snapshot");
  } catch {
    return NO_PRINT_SYSTEM;
  }
}

/** Cancel one job. `printer` is only read by the Windows backend (its API needs
 *  the queue as well as the id); CUPS cancels by id alone. */
export function printJobCancel(printer: string, jobId: string): Promise<void> {
  return invoke<void>("print_job_cancel", { printer, jobId });
}

/** Cancel everything queued on one printer. */
export function printJobsCancelAll(printer: string): Promise<void> {
  return invoke<void>("print_jobs_cancel_all", { printer });
}

/** Make this the default printer (the *user's* default — no elevation). */
export function printSetDefault(printer: string): Promise<void> {
  return invoke<void>("print_set_default", { printer });
}

/**
 * Resume (`true`) or pause (`false`) a printer's queue. The one action here
 * that commonly needs rights the user may not have — CUPS answers "Forbidden"
 * outside the `lpadmin` group — so its rejection carries the print system's own
 * words and the pane shows them verbatim.
 */
export function printSetEnabled(printer: string, enabled: boolean): Promise<void> {
  return invoke<void>("print_set_enabled", { printer, enabled });
}

/** Send a short text page, so "is this thing connected?" has an answer that
 *  does not involve finding a document first. */
export function printTestPage(printer: string): Promise<void> {
  return invoke<void>("print_test_page", { printer });
}

// ── Pure render helpers ──────────────────────────────────────────────────────

const PRINTER_STATES: readonly PrinterState[] = ["idle", "printing", "stopped", "unknown"];
const JOB_STATES: readonly PrintJobState[] = ["printing", "pending", "held", "unknown"];

/** Narrow a backend state word to the set we have wording and a tone for. An
 *  unrecognized value becomes `unknown` — the direction that admits ignorance,
 *  never `idle`, which would paint a broken printer green. */
export function printerStateKey(state: string): PrinterState {
  return (PRINTER_STATES as readonly string[]).includes(state)
    ? (state as PrinterState)
    : "unknown";
}

export function jobStateKey(state: string): PrintJobState {
  return (JOB_STATES as readonly string[]).includes(state) ? (state as PrintJobState) : "unknown";
}

/** The lamp tone for a printer row. A queue that is stopped **or** refusing new
 *  jobs is "bad": both mean nothing the user sends will come out, and a printer
 *  that is merely not accepting is the case a green dot would hide. */
export function printerTone(printer: PrinterInfo): "good" | "busy" | "bad" | "unknown" {
  const state = printerStateKey(printer.state);
  if (state === "stopped" || !printer.accepting) return "bad";
  if (state === "printing") return "busy";
  if (state === "idle") return "good";
  return "unknown";
}

/** The i18n key for a printer's state word. */
export function printerStateLabelKey(printer: PrinterInfo): TranslationKey {
  const state = printerStateKey(printer.state);
  if (state === "stopped") return "printing.statePaused";
  if (state === "printing") return "printing.statePrinting";
  if (state === "idle") return "printing.stateIdle";
  return "printing.stateUnknown";
}

/** The i18n key for a job's state word. */
export function jobStateLabelKey(job: PrintJob): TranslationKey {
  const state = jobStateKey(job.state);
  if (state === "printing") return "printing.jobPrinting";
  if (state === "held") return "printing.jobHeld";
  if (state === "pending") return "printing.jobPending";
  return "printing.stateUnknown";
}

/** Jobs queued on one printer, in the order the print system reported them
 *  (queue order — deliberately not re-sorted, since that IS the information). */
export function jobsFor(jobs: PrintJob[], printer: string): PrintJob[] {
  return jobs.filter((job) => job.printer === printer);
}

/**
 * Jobs the snapshot listed against a printer it did not list — a real CUPS
 * state (a queue removed while its jobs drain, or a job whose id could not be
 * split back into a printer name). They are shown in their own group rather
 * than dropped: a job nobody can see is a job nobody can cancel.
 */
export function orphanJobs(snapshot: PrintSnapshot): PrintJob[] {
  const known = new Set(snapshot.printers.map((p) => p.name));
  return snapshot.jobs.filter((job) => !known.has(job.printer));
}
