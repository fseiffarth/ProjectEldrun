import type { LimitMeters, UsageMeter } from "../../../shared/usageReport";
import type { SessionUsage, SessionUsageWindow } from "../api";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A reset instant in the words `resolveResetAt` reads (`Sep 20, 2026,
 * 3:43am (UTC)`), so the facts row's title says it the way it says Claude's. */
export function resetPhrase(at: Date): string {
  const hour = at.getUTCHours() % 12 || 12;
  const minute = String(at.getUTCMinutes()).padStart(2, "0");
  const meridiem = at.getUTCHours() < 12 ? "am" : "pm";
  return `${MONTHS[at.getUTCMonth()]} ${at.getUTCDate()}, ${at.getUTCFullYear()}, ${hour}:${minute}${meridiem} (UTC)`;
}

function meter(label: string, window: SessionUsageWindow | undefined, now: Date): UsageMeter | undefined {
  if (!window || !Number.isFinite(window.used)) return undefined;
  if (window.resetsAt == null) return { label, percent: window.used };
  const at = new Date(window.resetsAt * 1000);
  // A window that has rolled over since the record was written no longer
  // holds that figure; showing it would claim a quota already given back.
  if (at.getTime() <= now.getTime()) return undefined;
  return { label, percent: window.used, resets: resetPhrase(at) };
}

/** The 5-hour and weekly meters out of a stored session's usage (Codex writes
 * them into its rollout), in the shape the CLI-panel reading gives Claude's. */
export function sessionLimits(usage: SessionUsage | undefined, now: Date): LimitMeters {
  if (!usage) return {};
  return { session: meter("Current session", usage.session, now), week: meter("Current week", usage.week, now) };
}
