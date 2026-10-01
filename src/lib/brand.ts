/**
 * The app's name — the ONE frontend place it is spelled. Display text reads
 * `BRAND.display` (the i18n dictionaries through their `{app}` placeholder),
 * so a rename edits this file and its Rust twin `src-tauri/src/brand.rs`,
 * nothing else. The phone PWA imports this module too.
 */
export const BRAND = {
  /** The name as shown to the user. */
  display: "Eldrun",
  /** Lowercase form for file names, storage keys and protocol names. */
  slug: "eldrun",
  /** Prefix of the app's environment variables. */
  envPrefix: "ELDRUN_",
} as const;

const APP_PLACEHOLDER = /\{app\}/g;

/** Fill a dictionary's `{app}` placeholders with the display name. Done once
 *  where a dictionary is loaded, so `translate()` never has to know. */
export function fillBrand<T extends Record<string, string | undefined>>(
  dict: T,
): { [K in keyof T]: string } {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(dict)) {
    if (value === undefined) continue;
    out[key] = value.includes("{app}")
      ? value.replace(APP_PLACEHOLDER, BRAND.display)
      : value;
  }
  return out as { [K in keyof T]: string };
}
