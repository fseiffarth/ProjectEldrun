import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";

/**
 * Renderer memory watchdog.
 *
 * The webview renderer (WebKitWebProcess on Linux) holds a window's whole JS
 * heap and, in a long session with heavy HMR, can grow without bound until it
 * OOM-aborts — a 44 GB leak observed 2026-07-31, which apport then amplified
 * into a multi-GB core dump on a near-full disk. WebKitGTK does not implement
 * `performance.memory`, so the renderer can't watch its own heap; the backend
 * reads each renderer's RSS from `/proc` (`webview_renderer_rss`) and this hook
 * acts on it.
 *
 * When THIS window's renderer crosses `RENDERER_CEILING_MB` we
 * `location.reload()`: a full reload drops the entire JS heap at once (the
 * nuclear GC WebKitGTK won't do on its own), and the app restores its tab
 * layout while backend-owned PTYs reattach. So a reload costs xterm scrollback
 * and any unsaved in-webview draft, but converts an unavoidable OOM crash
 * (which loses all of that anyway, plus a giant core dump) into a ~1 s flicker.
 *
 * Two rules exist because of one incident (2026-09-01). The reading is
 * **per window**: every Eldrun window — the main one, each popout — runs this
 * hook and reloads only itself. The first version read the largest renderer
 * under the app and always reloaded the main window; with a popout holding
 * 4.7 GB, the main window (at 1.4 GB) reloaded itself every 30 s, freeing
 * nothing, for as long as the popout stayed open. And a reload is **not
 * repeated inside a cooldown**: if the same window is still over the ceiling
 * shortly after a watchdog reload, the memory is evidently not its JS heap,
 * and reloading again would only repeat the cost. The last reload's time
 * survives the reload itself in `sessionStorage`, which is per window.
 *
 * **Which renderer is ours** is something no engine we ship on will say
 * (WebKitGTK 2.52 no longer exports `webkit_web_view_get_web_process_identifier`;
 * WebView2 and WKWebView never had one), so each window finds out by itself:
 * it samples every renderer's RSS, allocates and touches a `PROBE_BYTES` buffer,
 * samples again, and the one pid that grew by that much is its own process.
 * Done once per window (the answer is cached in `sessionStorage` across our own
 * reloads — same process — and re-derived only when that pid is gone, i.e. the
 * renderer was replaced after a crash), then **claimed** with the backend so
 * every window's readout can name the others. With a single renderer there is
 * nothing to probe. If the probe stays ambiguous (another renderer allocating
 * heavily at the same instant) it is retried at the next poll a few times, then
 * the window falls back to acting on the largest renderer, under the cooldown.
 *
 * The ceiling is deliberately high: a healthy renderer sits around 1 GB, so
 * 4 GB only ever trips on a genuine runaway — well before system memory
 * pressure, far below the 44 GB catastrophe. Change `RENDERER_CEILING_MB` to
 * retune, or set it past any real value to disable.
 */
const POLL_MS = 30_000;
/** First attribution runs shortly after mount rather than at the first poll,
 *  so the debug readout can name the window early. */
const ATTRIBUTE_AFTER_MS = 2_000;
export const RENDERER_CEILING_MB = 4096;
/** How long a window that just reloaded refuses to reload again while still
 *  over the ceiling. Long enough that a reload loop is impossible; short enough
 *  that a *new* runaway after a legitimate reload is still caught. */
export const RELOAD_COOLDOWN_MS = 10 * 60_000;
/** The attribution probe: allocated and touched once, freed right after. Big
 *  enough to stand clear of anything another renderer does in the same ~100 ms
 *  (an xterm burst is tens of MB), small enough to be a blink at 192 MiB. */
export const PROBE_BYTES = 192 * 1024 * 1024;
/** The probed renderer must have grown by at least this … */
export const PROBE_MIN_DELTA_KIB = 96 * 1024;
/** … and no other renderer by more than this, or the answer is ambiguous. */
export const PROBE_MAX_OTHER_DELTA_KIB = 48 * 1024;
const PROBE_ATTEMPTS = 3;
const RELOAD_AT_KEY = "eldrun:renderer-watchdog-reload-at";
const OWN_PID_KEY = "eldrun:renderer-watchdog-own-pid";

/** One webview renderer as the backend reports it (`commands::debug::RendererRss`). */
export interface RendererRss {
  /** Label of the window that claimed this renderer; `""` while unclaimed, or
   *  when the backend could not attribute at all (`pid === 0`). */
  label: string;
  /** The claiming window's title (`"Eldrun win-1"`); `""` when unclaimed. */
  title: string;
  /** `0` = the older backend's unattributed largest-renderer reading. */
  pid: number;
  rss_kib: number;
}

/**
 * Every renderer's resident size. Falls back to the older unattributed
 * largest-renderer command against a backend that predates the per-renderer
 * one — including a stale binary still running behind a hot-reloaded frontend.
 * Resolves to `[]` when neither can answer: a watchdog that cannot measure
 * simply does nothing.
 */
export async function readRendererRss(): Promise<RendererRss[]> {
  try {
    const rows = await invoke<unknown>("webview_renderer_rss");
    // A mocked or foreign backend can answer anything; only well-formed rows
    // count, and a non-array (e.g. `null`) is "cannot measure", not a crash.
    if (Array.isArray(rows)) {
      return rows.filter(
        (r): r is RendererRss =>
          typeof r === "object" &&
          r !== null &&
          typeof (r as RendererRss).pid === "number" &&
          typeof (r as RendererRss).rss_kib === "number" &&
          typeof (r as RendererRss).label === "string" &&
          typeof (r as RendererRss).title === "string",
      );
    }
  } catch {
    // Backend predating the per-renderer command: fall through to the older one.
  }
  try {
    const kib = await invoke<unknown>("webview_rss_kib");
    return typeof kib === "number" && kib > 0
      ? [{ label: "", title: "", pid: 0, rss_kib: kib }]
      : [];
  } catch {
    return [];
  }
}

/** The probe's verdict, pure: which pid grew by the probe and no other did. */
export function pickProbedPid(
  before: readonly Pick<RendererRss, "pid" | "rss_kib">[],
  after: readonly Pick<RendererRss, "pid" | "rss_kib">[],
  minDeltaKib = PROBE_MIN_DELTA_KIB,
  maxOtherDeltaKib = PROBE_MAX_OTHER_DELTA_KIB,
): number | null {
  const base = new Map(before.map((r) => [r.pid, r.rss_kib]));
  const deltas = after
    .filter((r) => r.pid > 0 && base.has(r.pid))
    .map((r) => ({ pid: r.pid, delta: r.rss_kib - (base.get(r.pid) ?? 0) }))
    .sort((a, b) => b.delta - a.delta);
  const best = deltas[0];
  if (!best || best.delta < minDeltaKib) return null;
  const second = deltas[1];
  if (second && second.delta > maxOtherDeltaKib) return null;
  return best.pid;
}

/**
 * The entry this window's watchdog acts on. With a known own pid, that
 * renderer (or nothing, if the pid is gone — the caller re-attributes). Without
 * one: the unattributed reading if the backend gave one; else, only once
 * attribution has been given up on, the largest renderer — the old behaviour,
 * safe now under the reload cooldown. `null` = nothing to act on.
 */
export function ownRenderer(
  all: readonly RendererRss[],
  ownPid: number | null,
  fallbackToLargest: boolean,
): RendererRss | null {
  if (ownPid !== null) return all.find((r) => r.pid === ownPid) ?? null;
  const unattributed = all.find((r) => r.pid === 0);
  if (unattributed) return unattributed;
  if (!fallbackToLargest || all.length === 0) return null;
  return all.reduce((a, b) => (b.rss_kib > a.rss_kib ? b : a));
}

export type WatchdogVerdict =
  | { action: "none" }
  | { action: "reload"; mb: number }
  | { action: "hold"; mb: number; sinceReloadMs: number };

/** The pure decision: below the ceiling nothing; over it, reload — unless this
 *  window already reloaded for the watchdog within the cooldown, in which case
 *  hold (a reload demonstrably does not free this memory). */
export function decideWatchdog(
  mb: number,
  lastReloadAt: number | null,
  now: number,
  ceilingMb = RENDERER_CEILING_MB,
  cooldownMs = RELOAD_COOLDOWN_MS,
): WatchdogVerdict {
  if (mb < ceilingMb) return { action: "none" };
  if (lastReloadAt !== null && now - lastReloadAt < cooldownMs) {
    return { action: "hold", mb, sinceReloadMs: now - lastReloadAt };
  }
  return { action: "reload", mb };
}

/** Short name for a renderer row: the claiming window's title minus the app
 *  name (`"Eldrun win-1"` → `"win-1"`), its label when there is no title, the
 *  pid while unclaimed, and a generic word for an unattributed reading. */
export function rendererName(r: Pick<RendererRss, "label" | "title" | "pid">): string {
  const title = r.title.replace(/^Eldrun\b[\s—–-]*/, "").trim();
  if (title) return title;
  if (r.label) return r.label;
  if (r.pid > 0) return `pid ${r.pid}`;
  return "renderer";
}

/** `912 MB` below a gibibyte, `4.6 GB` from there — one decimal, since the
 *  reading is glanced at beside a 4 GB ceiling. */
export function formatRssKib(kib: number): string {
  const mb = kib / 1024;
  if (mb < 1024) return `${Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

function readSessionNumber(key: string): number | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function writeSessionNumber(key: string, n: number): void {
  try {
    sessionStorage.setItem(key, String(n));
  } catch {
    // No storage → no memory across reloads; each rule still holds within
    // this page's lifetime, and the probe simply runs again after a reload.
  }
}

function currentLabel(): string {
  try {
    return getCurrentWindow().label;
  } catch {
    return "";
  }
}

async function report(message: string): Promise<void> {
  try {
    // Land the reason in crash.log, so a user asking "why did my window
    // blink?" has an answer beside the native crashes.
    await invoke("report_frontend_error", { kind: "renderer-watchdog", message, stack: null });
  } catch {
    // Reporting must never block the decision.
  }
}

// ── Attribution: which renderer is this window's own ────────────────────────
// Module state is per window: a popout is its own JS context.

let ownPid: number | null = null;
let probeAttemptsLeft = PROBE_ATTEMPTS;
let attributing: Promise<number | null> | null = null;

/** True once the probe has been tried and failed `PROBE_ATTEMPTS` times. */
export function attributionGivenUp(): boolean {
  return ownPid === null && probeAttemptsLeft <= 0;
}

async function claim(pid: number): Promise<void> {
  try {
    await invoke("webview_renderer_claim", { pid });
  } catch {
    // An older backend has no claims; naming other windows is a nicety.
  }
}

/** Allocate + touch the probe buffer between two samples; the pid that grew
 *  is ours. The buffer is referenced after the second sample so the engine
 *  cannot drop it early. */
async function probeOwnPid(): Promise<number | null> {
  const before = await readRendererRss();
  const buf = new Uint8Array(PROBE_BYTES);
  buf.fill(1);
  const after = await readRendererRss();
  if (buf[buf.length - 1] !== 1) return null;
  return pickProbedPid(before, after);
}

/**
 * This window's renderer pid, deriving it if unknown: the cached answer if
 * that pid is still a live renderer, else the backend's existing claim for
 * this window (a reload keeps the process), else the single renderer if there
 * is only one, else the probe. Concurrent callers share one derivation.
 * `null` when the backend cannot attribute (unattributed reading) or the
 * probe was ambiguous this time.
 */
export async function ensureOwnRendererPid(): Promise<number | null> {
  if (attributing) return attributing;
  attributing = (async () => {
    try {
      const all = await readRendererRss();
      const live = all.filter((r) => r.pid > 0);
      if (live.length === 0) return null;
      if (ownPid !== null && live.some((r) => r.pid === ownPid)) return ownPid;

      const cached = readSessionNumber(OWN_PID_KEY);
      if (cached !== null && live.some((r) => r.pid === cached)) {
        ownPid = cached;
        await claim(cached);
        return cached;
      }
      const label = currentLabel();
      const claimed = label ? live.find((r) => r.label === label) : undefined;
      let pid: number | null = claimed?.pid ?? null;
      if (pid === null && live.length === 1) pid = live[0].pid;
      if (pid === null) {
        if (probeAttemptsLeft <= 0) return null;
        probeAttemptsLeft -= 1;
        pid = await probeOwnPid();
      }
      if (pid !== null) {
        ownPid = pid;
        probeAttemptsLeft = PROBE_ATTEMPTS;
        writeSessionNumber(OWN_PID_KEY, pid);
        await claim(pid);
      }
      return pid;
    } finally {
      attributing = null;
    }
  })();
  return attributing;
}

export function useRendererWatchdog(): void {
  useEffect(() => {
    let stopped = false;
    let tripped = false;
    let heldReported = false;
    const label = currentLabel();
    const foreignReported = new Set<number>();

    const check = async (): Promise<void> => {
      if (stopped || tripped) return;
      const all = await readRendererRss();
      if (stopped || tripped) return;

      let pid = ownPid;
      if (pid === null || !all.some((r) => r.pid === pid)) {
        pid = await ensureOwnRendererPid();
        if (stopped || tripped) return;
      }
      const own = ownRenderer(all, pid, attributionGivenUp());

      // Another window's renderer over the ceiling is that window's own
      // watchdog's to reload — but it is also where a "why is Eldrun slow"
      // answer lives, so say so once per renderer.
      for (const r of all) {
        if (r === own || r.pid === 0 || r.pid === pid) continue;
        const mb = r.rss_kib / 1024;
        if (mb >= RENDERER_CEILING_MB && !foreignReported.has(r.pid)) {
          foreignReported.add(r.pid);
          void report(
            `renderer '${rendererName(r)}' (pid ${r.pid}) is ${Math.round(mb)} MB ` +
              `≥ ${RENDERER_CEILING_MB} MB — its own window's watchdog reloads it, not '${label}'`,
          );
        }
      }
      if (!own) return;

      const mb = own.rss_kib / 1024;
      const verdict = decideWatchdog(mb, readSessionNumber(RELOAD_AT_KEY), Date.now());
      if (verdict.action === "none") return;
      if (verdict.action === "hold") {
        if (!heldReported) {
          heldReported = true;
          await report(
            `renderer RSS ${Math.round(mb)} MB still ≥ ${RENDERER_CEILING_MB} MB ceiling ` +
              `${Math.round(verdict.sinceReloadMs / 1000)} s after a watchdog reload of '${label}' ` +
              `— a reload does not free this memory; not reloading again for ` +
              `${Math.round(RELOAD_COOLDOWN_MS / 60_000)} min`,
          );
        }
        return;
      }

      tripped = true;
      await report(
        `renderer RSS ${Math.round(mb)} MB ≥ ${RENDERER_CEILING_MB} MB ceiling ` +
          `(pid ${own.pid || "?"}) — reloading window '${label}' to free its JS heap before it OOMs`,
      );
      writeSessionNumber(RELOAD_AT_KEY, Date.now());
      location.reload();
    };

    // Attribute early (a fresh renderer is small, so nothing else runs yet);
    // the first check is one interval in, never at mount.
    const attributeId = window.setTimeout(() => {
      if (!stopped) void ensureOwnRendererPid();
    }, ATTRIBUTE_AFTER_MS);
    const id = window.setInterval(() => void check(), POLL_MS);
    return () => {
      stopped = true;
      window.clearTimeout(attributeId);
      window.clearInterval(id);
    };
  }, []);
}
