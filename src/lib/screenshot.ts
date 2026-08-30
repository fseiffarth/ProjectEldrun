/**
 * The global Screenshot app's in-app capture seam.
 *
 * Pressing the header's Screenshot button used to always spawn an OS
 * region-capture tool. But when the thing being captured is a PDF on screen,
 * the viewer can do strictly better than a screen grab: it rasterises the
 * selected region from the rendered page canvas (document-sharp, DPR-exact,
 * with pending blackouts burned in), which is what its old ✂ toolbar tool did.
 * That tool is now armed by the Screenshot button instead of a per-viewer
 * button, so there is ONE capture entry point rather than two.
 *
 * The handshake is a synchronous, claimable window event: the launcher
 * dispatches, a visible PDF viewer claims (`detail.claimed = true`), and the
 * launcher reads the flag back to decide whether the external tool still needs
 * to run. First visible viewer wins — the flag is checked before it is set, so
 * two viewers on screen never both arm.
 */
export const SCREENSHOT_CAPTURE_EVENT = "eldrun:screenshot-capture";

export type ScreenshotCaptureDetail = { claimed: boolean };

/** Offer the screenshot request to any visible in-app claimant (currently the
 *  PDF viewer). Returns true when one claimed it — the caller must then NOT
 *  spawn the external capture tool. */
export function requestInAppCapture(): boolean {
  const detail: ScreenshotCaptureDetail = { claimed: false };
  window.dispatchEvent(new CustomEvent(SCREENSHOT_CAPTURE_EVENT, { detail }));
  return detail.claimed;
}

/** `Screenshot-YYYYMMDD-HHMMSS.png` in UTC — the exact shape the backend's
 *  `capture_project_screenshot` writes, so in-app shots sort beside tool shots
 *  in the same `screenshots/` folder. */
export function screenshotFilename(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `Screenshot-${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}` +
    `-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}.png`
  );
}
