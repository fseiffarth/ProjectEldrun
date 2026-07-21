/**
 * The guard around the file tree's per-folder size calls.
 *
 * Folder sizes are a **best-effort display aid** — the tree renders without them
 * and simply shows no size when one doesn't arrive. That is what makes them safe
 * to bound aggressively, and bounding them matters because of where they run: for
 * a remote project `dir_size`/`dir_size_breakdown` are a `du` over SSH, and the
 * tree fires **one per visible folder, all at once**.
 *
 * When the network under a remote project goes away — a dropped VPN tunnel, a
 * suspended laptop — those calls do not fail. A black-holed socket produces no
 * error, so each one blocks until ssh's own keepalive gives up (~45 s), and each
 * blocked call is holding a backend blocking-pool thread the whole time. Opening
 * one folder of thirty subfolders then means thirty stalled threads and a UI with
 * nothing to render, which is exactly how a lost tunnel turned into a frozen app.
 *
 * Three limits, each aimed at a different part of that:
 *
 *  - **Timeout** — a size that hasn't arrived in {@link TIMEOUT_MS} is treated as
 *    one that isn't coming. This does *not* cancel the backend call (a Tauri
 *    command in flight cannot be recalled); it frees the caller, which is the
 *    part that was stuck.
 *  - **Concurrency cap** — at most {@link MAX_CONCURRENT} in flight per project,
 *    so a wide folder queues instead of dispatching thirty calls into a network
 *    that is not answering.
 *  - **Circuit breaker** — {@link FAILURES_TO_OPEN} consecutive timeouts mean the
 *    host, not the folder, is the problem. The breaker then opens for
 *    {@link OPEN_MS} and every further request for that project is refused
 *    *immediately*, so the other twenty-nine folders cost nothing at all rather
 *    than each paying the timeout in turn. One success closes it again.
 *
 * Keyed by `projectDir`, because "is this host answering?" is a property of the
 * project's remote, not of any one folder. A local project's walk never times out
 * in practice, so the breaker stays shut and this is pure overhead-free
 * pass-through for it.
 */

/** Longest a folder size may take before it is written off. */
export const TIMEOUT_MS = 15_000;
/** Most size calls in flight at once, per project. */
export const MAX_CONCURRENT = 4;
/** Consecutive timeouts that mean the host is gone, not the folder slow. */
export const FAILURES_TO_OPEN = 3;
/** How long the breaker stays open before one request is let through to retry. */
export const OPEN_MS = 30_000;

/** Thrown when the breaker refuses a call outright. Callers treat it like any
 *  other failure — the size is simply left unresolved. */
export class DirSizeUnavailable extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "DirSizeUnavailable";
  }
}

interface ProjectGate {
  /** Consecutive timeouts since the last success. */
  failures: number;
  /** Epoch ms until which the breaker is open; 0 when shut. */
  openUntil: number;
  /** Calls currently in flight. */
  active: number;
  /** Waiters parked on the concurrency cap, released FIFO. */
  queue: Array<() => void>;
}

const gates = new Map<string, ProjectGate>();

function gateFor(projectDir: string): ProjectGate {
  let g = gates.get(projectDir);
  if (!g) {
    g = { failures: 0, openUntil: 0, active: 0, queue: [] };
    gates.set(projectDir, g);
  }
  return g;
}

function acquire(g: ProjectGate): Promise<void> {
  if (g.active < MAX_CONCURRENT) {
    g.active += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => g.queue.push(resolve));
}

function release(g: ProjectGate): void {
  const next = g.queue.shift();
  if (next) {
    // Hand the slot straight to the next waiter — `active` never drops.
    next();
    return;
  }
  g.active -= 1;
}

/**
 * Run one folder-size call under the timeout, the concurrency cap and the
 * breaker. Rejects (with {@link DirSizeUnavailable} when the breaker is open, or
 * a timeout error) rather than hanging; the caller leaves the size unresolved.
 *
 * `run` is a thunk, not a promise, so a queued call is not *started* until it has
 * a slot — passing an already-running promise would defeat the cap.
 */
export async function guardedDirSize<T>(projectDir: string, run: () => Promise<T>): Promise<T> {
  const g = gateFor(projectDir);
  if (g.openUntil > Date.now()) {
    throw new DirSizeUnavailable("folder sizes paused: the project's host is not responding");
  }
  await acquire(g);
  let timer: number | undefined;
  try {
    const result = await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = window.setTimeout(
          () => reject(new Error(`folder size timed out after ${TIMEOUT_MS}ms`)),
          TIMEOUT_MS,
        );
      }),
    ]);
    // Any answer at all proves the host is talking — shut the breaker.
    g.failures = 0;
    g.openUntil = 0;
    return result;
  } catch (e) {
    // Only a *timeout* is evidence about the host. A call that came back with an
    // error (an unreadable folder, a backend that lacks the command) answered
    // fine, and must not push the project toward a breaker trip.
    if (!(e instanceof DirSizeUnavailable) && timer !== undefined && isHostTimeout(e)) {
      g.failures += 1;
      if (g.failures >= FAILURES_TO_OPEN) g.openUntil = Date.now() + OPEN_MS;
    }
    throw e;
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
    release(g);
  }
}

/** Whether a rejection means *the host stopped answering* rather than the call
 *  itself failing — the distinction that decides whether a retry could ever
 *  help. Only this guard's own timeout qualifies. */
export function isHostTimeout(e: unknown): boolean {
  return e instanceof Error && e.message.includes("timed out");
}

/** Drop a project's gate — on project close, so a stale open breaker can't
 *  outlive the tree that tripped it. Exported for tests too. */
export function resetDirSizeGuard(projectDir?: string): void {
  if (projectDir === undefined) gates.clear();
  else gates.delete(projectDir);
}
