/**
 * #42: per-platform pointer/window-event flags for the detached drag-drop system.
 *
 * The divergent semantics split cleanly as Linux (WebKitGTK) vs {Windows
 * (WebView2/Chromium), macOS (WKWebView)}, so OS detection off `navigator.platform`
 * is sufficient and more robust than UA engine-parsing. Linux retains its EXACT
 * current values on all three flags, so the working platform is byte-for-byte
 * unchanged. Each flag is documented at its declaration; together they isolate
 * every event-semantics uncertainty into ONE file a single runtime session can flip.
 */
// OS detection lives in the dependency-free `platform.ts` single source of
// truth; re-exported here so existing `dragPlatform` importers keep working.
import { PLATFORM } from "./platform";
// TEMPORARY (Windows drag QA — remove together with every releaseDbg call):
// mirrors each gesture's terminal event into crash.log so a dead gesture can be
// diagnosed without devtools. `invoke` throws outside a Tauri webview (vitest),
// hence the try/catch.
import { invoke } from "@tauri-apps/api/core";

export { PLATFORM };

// TEMPORARY drag QA logger — see import note above.
function releaseDbg(message: string) {
  try {
    void invoke("report_frontend_error", { kind: "drag-debug", message, stack: null }).catch(() => {});
  } catch {
    /* diagnostics must never affect the gesture */
  }
}

export interface DragPlatform {
  /**
   * Whether a `pointercancel` ending a mouse drag should COMMIT the drop (vs.
   * ABORT it).
   *
   * - Linux/WebKitGTK fires `pointercancel` *instead of* `pointerup` (its native
   *   gesture/selection heuristic claims the stream), so a cancel must COMMIT.
   * - Windows/WebView2 (Chromium) ALSO ends these drags with `pointercancel`,
   *   not `pointerup`: we `preventDefault()` the pointerdown and `setPointerCapture`
   *   the dragged `.tab`, which `.tab.dragging` collapses to zero width — Chromium's
   *   drag heuristic then cancels the mouse pointer at release. So Windows commits
   *   on cancel too. (A GENUINE capture loss — alt-tab, a focus-stealing dialog —
   *   raises `blur` first, and `bindDragRelease` aborts on `blur` for
   *   capture-needing engines, so it never reaches this commit path.)
   * - macOS/WKWebView fires a real `pointerup`; a `pointercancel` there is a
   *   genuine capture loss → ABORT, not commit.
   */
  cancelCommits: boolean;
  /**
   * WebKitGTK keeps delivering the terminal pointer event to the source window
   * after the cursor leaves it (implicit grab); Chromium/WKWebView do not without
   * an explicit `setPointerCapture`. We need capture ONLY so the single terminal
   * `pointerup`/`pointercancel` lands on the source window — continuous position
   * is poll-driven (`startCursorPoll`), a much weaker dependency.
   */
  needsPointerCapture: boolean;
  /**
   * The whole-window `setPosition` follow during dock-back is cosmetic (the main
   * window already paints the dock preview + ghost). On Win/mac, `setPosition`
   * under a physically-held button can drop the webview's mouse capture and emit a
   * spurious `pointercancel` mid-drag, so it is disabled there. Linux keeps it.
   */
  followWindowOnDockDrag: boolean;
}

export const dragPlatform: DragPlatform =
  PLATFORM === "linux"
    ? { cancelCommits: true, needsPointerCapture: false, followWindowOnDockDrag: true }
    : PLATFORM === "windows"
      ? // WebView2 ends the drag with `pointercancel` (see cancelCommits), so it
        // must commit on cancel; it still needs explicit pointer capture and skips
        // the window-follow (both as on macOS).
        { cancelCommits: true, needsPointerCapture: true, followWindowOnDockDrag: false }
      : { cancelCommits: false, needsPointerCapture: true, followWindowOnDockDrag: false };

/**
 * Bind the terminal-event listeners for a drag with engine-correct semantics, so
 * no call site can drift from the `cancelCommits` policy. Returns an unbind fn.
 *
 * - `pointerup`      → `onCommit(shiftKey)` (a real release).
 * - `pointercancel`  → `onCommit` when `cancelCommits` (WebKitGTK pointerup-proxy),
 *                       else `onAbort` (a genuine capture loss on Chromium/WKWebView).
 * - `keydown` Escape → `onAbort`.
 * - `window` `blur`  → `onAbort` ONLY on capture-needing engines (Win/mac), as a
 *                       backstop for a swallowed terminal event. Linux is excluded:
 *                       its implicit grab reliably delivers the release, and a
 *                       spurious WebKitGTK `blur` mid-drag must not abort the gesture
 *                       (keeps the working platform byte-for-byte unchanged).
 *
 * Shift at commit: the terminal event's OWN `shiftKey` cannot be trusted on
 * Windows — WebView2 ends these drags with a `pointercancel` it synthesizes
 * (see `cancelCommits`), and a synthesized pointer event carries NO modifier
 * state, so `ev.shiftKey` is always false there and the Shift gestures
 * (force-a-new-window on tab/file drops) never fired. The binding therefore
 * tracks the real Shift state itself — from keydown/keyup and from every
 * `pointermove` (whose modifiers are trustworthy on all engines) — and commits
 * with `ev.shiftKey || tracked`. Purely additive: a genuine `pointerup` with
 * `shiftKey: true` behaves exactly as before, so Linux is unchanged.
 *
 * Single-fire: the first terminal event unbinds the rest. Callers keep their own
 * idempotency guards (store `end()` is a no-op once cleared), so a redundant fire
 * elsewhere is harmless.
 */
export function bindDragRelease(opts: {
  target?: EventTarget;
  onCommit: (shiftKey: boolean) => void;
  onAbort: () => void;
}): () => void {
  const target = opts.target ?? window;
  let done = false;
  // Real Shift state, self-tracked because a WebView2-synthesized pointercancel
  // reports no modifiers (see the doc comment above). keydown/keyup catch a
  // Shift pressed while stationary; pointermove keeps it honest either way.
  let shiftHeld = false;
  const trackMove = (ev: PointerEvent) => {
    shiftHeld = ev.shiftKey;
  };
  const unbind = () => {
    if (target === window) {
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    } else {
      target.removeEventListener("pointerup", onUp as EventListener);
      target.removeEventListener("pointercancel", onCancel as EventListener);
    }
    window.removeEventListener("pointermove", trackMove);
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("keyup", onKeyUp);
    if (dragPlatform.needsPointerCapture) window.removeEventListener("blur", onBlur);
  };
  const fire = (fn: () => void) => {
    if (done) return;
    done = true;
    unbind();
    fn();
  };
  const onUp = (ev: PointerEvent) => {
    releaseDbg(`terminal pointerup shift=${ev.shiftKey} tracked=${shiftHeld}`); // TEMPORARY drag QA
    fire(() => opts.onCommit(ev.shiftKey || shiftHeld));
  };
  const onCancel = (ev: PointerEvent) => {
    // TEMPORARY drag QA
    releaseDbg(
      `terminal pointercancel commits=${dragPlatform.cancelCommits} shift=${ev.shiftKey} tracked=${shiftHeld}`,
    );
    fire(() =>
      dragPlatform.cancelCommits ? opts.onCommit(ev.shiftKey || shiftHeld) : opts.onAbort(),
    );
  };
  const onKey = (ev: KeyboardEvent) => {
    shiftHeld = ev.shiftKey;
    if (ev.key === "Escape") {
      releaseDbg("terminal escape → abort"); // TEMPORARY drag QA
      fire(opts.onAbort);
    }
  };
  const onKeyUp = (ev: KeyboardEvent) => {
    shiftHeld = ev.shiftKey;
  };
  const onBlur = () => {
    releaseDbg("terminal blur → abort"); // TEMPORARY drag QA
    fire(opts.onAbort);
  };
  if (target === window) {
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  } else {
    target.addEventListener("pointerup", onUp as EventListener);
    target.addEventListener("pointercancel", onCancel as EventListener);
  }
  window.addEventListener("pointermove", trackMove);
  window.addEventListener("keydown", onKey);
  window.addEventListener("keyup", onKeyUp);
  if (dragPlatform.needsPointerCapture) window.addEventListener("blur", onBlur);
  return unbind;
}
