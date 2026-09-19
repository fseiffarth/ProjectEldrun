// Stamped by `vite.mobile.config.ts` at bundle time. The version alone does not
// move between local re-bundles (it only bumps on push), so the phone also
// shows when its bundle was built — the way to tell by hand whether a refresh
// actually picked up the new one.
declare const __ELDRUN_MOBILE_BUILT_AT__: string | undefined;

const BUILT_AT = typeof __ELDRUN_MOBILE_BUILT_AT__ === "string" ? __ELDRUN_MOBILE_BUILT_AT__ : undefined;

/** `dd-mm hh:mm` in the phone's local time, or "" when the stamp is missing or unreadable. */
export function formatBuildStamp(iso: string | undefined = BUILT_AT): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getDate())}-${pad(date.getMonth() + 1)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
