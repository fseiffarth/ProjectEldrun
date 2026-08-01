import { invoke } from "@tauri-apps/api/core";
import { useEffect } from "react";

/**
 * Renderer memory watchdog.
 *
 * The webview renderer (WebKitWebProcess on Linux) holds the whole UI's JS heap
 * and, in a long session with heavy HMR, can grow without bound until it
 * OOM-aborts — a 44 GB leak observed 2026-07-31, which apport then amplified
 * into a multi-GB core dump on a near-full disk. WebKitGTK does not implement
 * `performance.memory`, so the renderer can't watch its own heap; the backend
 * reads the renderer's RSS from `/proc` (`webview_rss_kib`) and this hook acts
 * on it.
 *
 * When the largest renderer crosses `CEILING_MB` we `location.reload()`: a full
 * reload drops the entire JS heap at once (the nuclear GC WebKitGTK won't do on
 * its own), and the app restores its tab layout while backend-owned PTYs
 * reattach. So a reload costs xterm scrollback and any unsaved in-webview draft,
 * but converts an unavoidable OOM crash (which loses all of that anyway, plus a
 * giant core dump) into a ~1 s flicker.
 *
 * The ceiling is deliberately high: a healthy renderer sits around 1 GB, so
 * 4 GB only ever trips on a genuine runaway — well before system memory
 * pressure, far below the 44 GB catastrophe. Change `CEILING_MB` to retune, or
 * set it past any real value to disable. Main window only (wired in AppShell):
 * it is the long-lived renderer that accumulates the full component graph; a
 * popout is lighter and shorter-lived. A popout-specific watchdog can come
 * later — this reloads the main window, so it does not target a popout leak.
 */
const POLL_MS = 30_000;
const CEILING_MB = 4096;

export function useRendererWatchdog(): void {
  useEffect(() => {
    let stopped = false;
    let tripped = false;

    const check = async (): Promise<void> => {
      if (stopped || tripped) return;
      let kib: number;
      try {
        kib = await invoke<number>("webview_rss_kib");
      } catch {
        // Older backend without the command, or an unreadable process tree:
        // a watchdog that cannot measure simply does nothing.
        return;
      }
      const mb = kib / 1024;
      if (mb < CEILING_MB) return;

      tripped = true;
      try {
        // Land the reason in crash.log *before* the reload, so a user asking
        // "why did my window blink?" has an answer beside the native crashes.
        await invoke("report_frontend_error", {
          kind: "renderer-watchdog",
          message:
            `renderer RSS ${Math.round(mb)} MB ≥ ${CEILING_MB} MB ceiling ` +
            `— reloading to free the JS heap before it OOMs`,
          stack: null,
        });
      } catch {
        // Reporting must never block the reload.
      }
      location.reload();
    };

    // First check is one interval in, never at mount: a fresh renderer is small,
    // and a reload loop is impossible because a reload starts it small again.
    const id = window.setInterval(() => void check(), POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, []);
}
