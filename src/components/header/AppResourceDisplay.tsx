import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "../../stores/settings";

interface AppResourceUsage {
  cpu_percent: number;
  rss_bytes: number;
  process_count: number;
  /** VRAM bytes in use by Ollama models; 0 when no model is resident on GPU. */
  vram_bytes: number;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  const mib = bytes / 1024 / 1024;
  if (mib < 1024) return `${Math.round(mib)} MB`;
  return `${(mib / 1024).toFixed(1)} GB`;
}

function usageTone(kind: "cpu" | "ram" | "gpu", value: number): "low" | "medium" | "high" {
  // CPU is a percentage; RAM/GPU are byte counts with their own thresholds.
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
    const id = window.setInterval(poll, 2_500);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [anyShown]);

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
      {showGpu && (
        <span
          className={`app-resource-row ${usageTone("gpu", usage.vram_bytes)}`}
          title="GPU VRAM in use by local models (Ollama)"
        >
          <span className="app-resource-symbol" aria-hidden>GPU</span>
          <span>{usage.vram_bytes > 0 ? formatBytes(usage.vram_bytes) : "—"}</span>
        </span>
      )}
    </div>
  );
}
