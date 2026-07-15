import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "../../stores/settings";
import { useEnergySaver, saverInterval } from "../../stores/power";
import {
  formatBytes,
  gpuBusy,
  gpuTone,
  gpuTooltip,
  gpuTotals,
  type GpuSample,
} from "../../lib/gpu";

interface AppResourceUsage {
  cpu_percent: number;
  rss_bytes: number;
  process_count: number;
  /** Ollama's *share* of the GPU: 0 when no model is resident. */
  vram_bytes: number;
  /** Every GPU in the machine; empty when none can be read (see `lib/gpu`). */
  gpus: GpuSample[];
}

function usageTone(kind: "cpu" | "ram", value: number): "low" | "medium" | "high" {
  // CPU is a percentage; RAM is a byte count with its own thresholds. The GPU
  // row tones by ratio instead (`gpuTone`) — its figure is the whole device's.
  const warn = kind === "cpu" ? 35 : 1024 * 1024 * 1024;
  const hot = kind === "cpu" ? 75 : 2 * 1024 * 1024 * 1024;
  if (value >= hot) return "high";
  if (value >= warn) return "medium";
  return "low";
}

export function AppResourceDisplay() {
  // Each row defaults ON (undefined → shown) and is independent of debug mode.
  const showCpu = useSettingsStore((s) => s.settings?.show_cpu_usage ?? true);
  const showRam = useSettingsStore((s) => s.settings?.show_ram_usage ?? true);
  const showGpu = useSettingsStore((s) => s.settings?.show_gpu_usage ?? true);
  const anyShown = showCpu || showRam || showGpu;
  const [usage, setUsage] = useState<AppResourceUsage | null>(null);
  const energySaver = useEnergySaver();

  useEffect(() => {
    if (!anyShown) {
      setUsage(null);
      return;
    }

    let cancelled = false;
    const poll = () => {
      invoke<AppResourceUsage>("debug_app_resource_usage")
        .then((next) => {
          if (!cancelled) setUsage(next);
        })
        .catch(() => {
          if (!cancelled) setUsage(null);
        });
    };

    poll();
    const id = window.setInterval(poll, saverInterval(2_500, energySaver));
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [anyShown, energySaver]);

  if (!anyShown || !usage) return null;

  return (
    <div className="app-resource-display" title={`${usage.process_count} Eldrun processes`}>
      {showCpu && (
        <span className={`app-resource-row ${usageTone("cpu", usage.cpu_percent)}`} title="CPU">
          <span className="app-resource-symbol" aria-hidden>CPU</span>
          <span>{usage.cpu_percent.toFixed(1)}%</span>
        </span>
      )}
      {showRam && (
        <span className={`app-resource-row ${usageTone("ram", usage.rss_bytes)}`} title="RAM">
          <span className="app-resource-symbol" aria-hidden>RAM</span>
          <span>{formatBytes(usage.rss_bytes)}</span>
        </span>
      )}
      {showGpu && <GpuRow gpus={usage.gpus} ollamaBytes={usage.vram_bytes} />}
    </div>
  );
}

/**
 * The whole device's memory (both pools, every adapter) plus its utilization —
 * not just what Ollama holds, which is what this row used to show and now shows
 * as one line of its tooltip.
 */
function GpuRow({ gpus, ollamaBytes }: { gpus: GpuSample[]; ollamaBytes: number }) {
  // No GPU we can read (macOS, an Intel-only box, no `nvidia-smi`): fall back to
  // exactly what this row did before — Ollama's models, and "—" when none are
  // loaded. Better a narrow reading than a zero pretending to be a measurement.
  if (gpus.length === 0) {
    return (
      <span
        className={`app-resource-row ${usageTone("ram", ollamaBytes)}`}
        title="GPU memory in use by local models (Ollama) — this machine's GPU reports no memory of its own"
      >
        <span className="app-resource-symbol" aria-hidden>GPU</span>
        <span>{ollamaBytes > 0 ? formatBytes(ollamaBytes) : "—"}</span>
      </span>
    );
  }

  const { used, total } = gpuTotals(gpus);
  const busy = gpuBusy(gpus);

  return (
    <span
      className={`app-resource-row ${gpuTone(used, total)}`}
      title={gpuTooltip(gpus, ollamaBytes)}
    >
      <span className="app-resource-symbol" aria-hidden>GPU</span>
      <span>
        {busy != null ? `${Math.round(busy)}% · ` : ""}
        {formatBytes(used)} / {formatBytes(total)}
      </span>
    </span>
  );
}
