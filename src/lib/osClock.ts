import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

/**
 * The OS's 12/24-hour clock, the default for the app-wide clock while
 * `Settings.time_format_24h` is unset (`lib/timeFormat.ts`).
 *
 * Asked of the backend (`commands/os_clock.rs`), not the webview's `Intl`:
 * WebKitGTK's locale follows `LANG` and never GNOME's clock switch, and
 * WebView2's follows the browser UI language, not the Windows regional format.
 * The backend reports the desktop's explicit switch when it has one, and the
 * time locale otherwise — which ICU is then asked about here, since ICU is what
 * knows that `de-DE` reads 17:00 and `en-US` reads 5 PM.
 *
 * Its own file, not part of `timeFormat.ts`, so the settings store can start
 * the probe at load without importing a module that imports it back.
 */

/** `true`/`false` once the OS has answered; `null` before, or when it has no
 *  opinion — the language default then applies. */
export const useOsClockStore = create<{ use24h: boolean | null }>(() => ({ use24h: null }));

/** What a locale's own clock is, per ICU; `null` for a tag ICU rejects. */
export function localeUses24h(locale: string): boolean | null {
  try {
    const { hour12 } = new Intl.DateTimeFormat(locale, { hour: "numeric" }).resolvedOptions();
    if (typeof hour12 === "boolean") return !hour12;
  } catch {
    // Not a locale this ICU knows.
  }
  return null;
}

/** The backend's report → one answer. Takes `unknown`: a mocked or older
 *  backend may answer anything, and anything malformed is "no opinion". */
export function osUse24hFrom(report: unknown): boolean | null {
  if (!report || typeof report !== "object") return null;
  const { use24h, locale } = report as { use24h?: unknown; locale?: unknown };
  if (typeof use24h === "boolean") return use24h;
  if (typeof locale === "string" && locale) return localeUses24h(locale);
  return null;
}

let probed = false;

/** Ask once per window (each is its own JS runtime). Never throws. */
export function probeOsClock(): void {
  if (probed) return;
  probed = true;
  try {
    invoke("os_clock_format").then(
      (report) => useOsClockStore.setState({ use24h: osUse24hFrom(report) }),
      () => {},
    );
  } catch {
    // No Tauri runtime (tests) — the language default stands.
  }
}
