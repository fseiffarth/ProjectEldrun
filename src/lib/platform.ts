/**
 * Single source of truth for OS detection in the frontend.
 *
 * Detected once from the webview's `navigator`. Every other detector
 * (`paths.ts`, `dragPlatform.ts`, viewers, shortcuts, …) re-exports or derives
 * from these flags so the logic never drifts across the codebase.
 *
 * IMPORTANT: this module must NOT import from `paths.ts`, `dragPlatform.ts`, or
 * any other app module — keep it dependency-free so it can be the bottom of the
 * import graph with no cycles.
 */

/** True on macOS (and iOS, harmless here). Detected once from the webview. */
export const IS_MAC: boolean =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || "");

/** True when running on Windows. `navigator.platform` is authoritative when
 *  present; otherwise we fall back to the UA string. */
export const IS_WINDOWS: boolean = (() => {
  if (typeof navigator === "undefined") return false;
  const platform = navigator.platform || "";
  if (platform) return /^win/i.test(platform);
  return /windows/i.test(navigator.userAgent || "");
})();

/** True on Linux — the fallback when the host is neither macOS nor Windows. */
export const IS_LINUX: boolean = !IS_MAC && !IS_WINDOWS;

/** The host OS as a single discriminant. Windows wins over the macOS check so
 *  the two are mutually exclusive even if a UA string is unusual. */
export const PLATFORM: "windows" | "macos" | "linux" = IS_WINDOWS
  ? "windows"
  : IS_MAC
    ? "macos"
    : "linux";
