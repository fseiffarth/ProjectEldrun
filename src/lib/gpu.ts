/**
 * The GPU-memory arithmetic, shared by the three surfaces that show it (the
 * header readout, the system-monitor pane, the local-model menu). Pure — the
 * sampling lives in the backend's `gpustat`.
 *
 * The one thing worth internalizing is what "GPU memory" *is*. A GPU has two
 * pools and both are reported, because on an integrated GPU only one of them is
 * real: the dedicated **VRAM** carve-out (typically 512 MB on an APU — the
 * framebuffer, permanently ~full, so reading it alone says nothing useful) and
 * the **shared** pool the driver maps out of system RAM (amdgpu's GTT — where a
 * model actually lands). So the headline figure is the two summed: on a discrete
 * card the shared pool is 0 and it collapses to plain device VRAM, and on an APU
 * it becomes the number that answers "will this model fit?".
 */

/** One GPU, as sampled by the backend `gpustat::GpuSample`. */
export interface GpuSample {
  name: string;
  driver: string;
  /** Dedicated device memory. */
  vram_used: number;
  vram_total: number;
  /** System memory mapped for the GPU (GTT); 0 on a discrete card. */
  shared_used: number;
  shared_total: number;
  /** `null` when the driver won't report utilization — not the same as idle. */
  busy_percent: number | null;
}

/** Both pools of every adapter, summed: the machine's GPU memory. */
export function gpuTotals(gpus: GpuSample[]): { used: number; total: number } {
  return gpus.reduce(
    (acc, g) => ({
      used: acc.used + g.vram_used + g.shared_used,
      total: acc.total + g.vram_total + g.shared_total,
    }),
    { used: 0, total: 0 },
  );
}

/** Highest utilization across adapters; `null` when no driver reports any. */
export function gpuBusy(gpus: GpuSample[]): number | null {
  const busy = gpus.map((g) => g.busy_percent).filter((b): b is number => b != null);
  return busy.length > 0 ? Math.max(...busy) : null;
}

export function gpuPercent(used: number, total: number): number {
  if (!(total > 0)) return 0;
  return Math.min(100, Math.max(0, (used / total) * 100));
}

/**
 * Tone by **ratio**, not by absolute bytes. The old GPU row warned at 1 GB and
 * went hot at 2 GB — thresholds that made sense for a figure counting only
 * Ollama's models, and that a system-wide reading would trip permanently.
 */
export function gpuTone(used: number, total: number): "low" | "medium" | "high" {
  const pct = gpuPercent(used, total);
  if (pct >= 85) return "high";
  if (pct >= 60) return "medium";
  return "low";
}

/** Byte formatter shared by the GPU readouts (MB under a GiB, else GB). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const mib = bytes / 1024 / 1024;
  if (mib < 1024) return `${Math.round(mib)} MB`;
  return `${(mib / 1024).toFixed(1)} GB`;
}

/** One adapter, named and split back into its two pools. */
export function gpuAdapterTooltip(gpu: GpuSample): string {
  const head =
    gpu.busy_percent != null ? `${gpu.name} — ${Math.round(gpu.busy_percent)}% busy` : gpu.name;
  const vram = `  VRAM    ${formatBytes(gpu.vram_used)} / ${formatBytes(gpu.vram_total)}`;
  const shared =
    gpu.shared_total > 0
      ? `\n  Shared  ${formatBytes(gpu.shared_used)} / ${formatBytes(gpu.shared_total)}`
      : "";
  return `${head}\n${vram}${shared}`;
}

/**
 * The header's breakdown: every adapter's two pools, then Ollama's share of it
 * all — the figure this readout used to consist of, now one line of context.
 */
export function gpuTooltip(gpus: GpuSample[], ollamaBytes: number): string {
  return [...gpus.map(gpuAdapterTooltip), `Ollama models: ${formatBytes(ollamaBytes)}`].join("\n");
}
