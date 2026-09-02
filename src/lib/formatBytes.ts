/**
 * The ONE general-purpose byte-size formatter (§9.1) — `"312 B"`, `"1.5 KB"`,
 * `"2.3 GB"`, up through TB. Grown from `lib/viewers/fileUtils`' `fmtSize`
 * (which now re-exports it), because the same ladder existed seven times over
 * with rounding and units guaranteed to drift.
 *
 * Deliberate variants that do NOT fold into this one:
 * - `lib/gpu.ts` `formatBytes` — GPU readouts print MB under a GiB (the
 *   nvidia-smi-shaped convention all three GPU surfaces share).
 * - `lib/diskUsage.ts` `formatBytes` — compact single-letter units (`K`/`M`/`G`)
 *   for the disk-usage pane's dense rows; pinned by its own tests.
 * - `dev/perfStats.ts` `fmtBytes` — dev-only compact form (`"4.2KB"`).
 * - `lib/mail.ts` `formatSize` keeps its ""-for-invalid guard (an attachment
 *   chip with no size renders nothing) but delegates the ladder here.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes < 1024 ** 4) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${(bytes / 1024 ** 4).toFixed(1)} TB`;
}
