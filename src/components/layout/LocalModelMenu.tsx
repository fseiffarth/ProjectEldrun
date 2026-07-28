import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSettingsStore } from "../../stores/settings";
import { useEnergySaver, saverInterval } from "../../stores/power";
import { useOllamaAutoloadStore } from "../../stores/ollamaAutoload";
import { useOllamaStatus } from "../../lib/ollamaStatus";
import { UntestedTag } from "../common/UntestedTag";
import {
  formatBytes,
  formatTempC,
  gpuAdapterTooltip,
  gpuBusy,
  gpuHottest,
  gpuPercent,
  gpuTone,
  gpuTotals,
  type GpuSample,
} from "../../lib/gpu";
import { useT, type TranslationKey } from "../../lib/i18n";

/** Subset of the backend `OllamaModelInfo` the menu needs (installed models). */
interface LocalModelInfo {
  name: string;
  parameter_size: string | null;
  quantization: string | null;
  running: boolean;
  /** VRAM bytes in use; non-zero → running on GPU. */
  size_vram: number;
}

/**
 * The machine's CPU + memory load (backend `MachineLoadSample`). The GPU half of
 * the same question comes from `gpu_memory_snapshot`; these two are separate
 * commands because the GPU read is cached and instant while this one spans a
 * 300 ms sampling window (a CPU percentage is a ratio of two readings).
 */
interface MachineLoad {
  supported: boolean;
  cpu_percent: number;
  num_cores: number;
  load_avg: [number, number, number];
  mem_total_bytes: number;
  mem_used_bytes: number;
  swap_total_bytes: number;
  swap_used_bytes: number;
  cpu_temp_c: number | null;
  /** Hottest DIMM, where the board wires an on-module sensor (`jc42`/`spd5118`).
      `null` — the usual answer — is "no sensor", never a cold reading. */
  mem_temp_c?: number | null;
}

/** Subset of the backend `AgentInfo` the menu lists (installed agent CLIs). */
interface AgentInfo {
  id: string;
  label: string;
  installed: boolean;
}

/**
 * The tasks a loaded model can be tagged for. Each maps to a key under
 * `settings.ollama_roles`; a model wearing a tag is the one used for that task
 * (autocomplete + grammar in the editor, "Local Model" agent tabs), so several
 * resident models can each own a different job. A task with no tag falls back to
 * the default `ollama_model`. Mirrors the consumers in `FileViewerPane`/`TabBar`.
 */
const MODEL_ROLES: Array<{ key: string; labelKey: TranslationKey }> = [
  { key: "autocomplete", labelKey: "localModel.role.autocomplete" },
  { key: "grammar", labelKey: "localModel.role.grammar" },
  { key: "tabs", labelKey: "localModel.role.tabs" },
];


/**
 * One row of the Machine group: a fixed label, the reading, a secondary fact,
 * and the meter under all three. The meter carries the tone (green/amber/red by
 * *ratio*, `gpuTone` — a pure percentage function despite the name), so the text
 * stays plain and one glance across three bars answers "will the next model fit"
 * without reading a single number.
 */
function StatMeter({
  label,
  value,
  note,
  detail,
  percent,
  title,
}: {
  label: string;
  value: string;
  /** A sensor reading beside the value (temperature, utilization); omitted when
      the driver won't report one, rather than shown as a zero. */
  note?: string | null;
  detail: string;
  /** 0–100; drives both the bar's width and its tone. */
  percent: number;
  title: string;
}) {
  const pct = Math.min(100, Math.max(0, percent));
  return (
    <div className="local-model-stat" title={title}>
      <div className="local-model-stat-head">
        <span className="local-model-stat-label">{label}</span>
        <span className="local-model-stat-value">{value}</span>
        {note && <span className="local-model-stat-note">{note}</span>}
        <span className="local-model-stat-detail">{detail}</span>
      </div>
      <div className="local-model-meter">
        <div
          className={`local-model-meter-fill ${gpuTone(pct, 100)}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

/**
 * Header button (left of the global-apps button) for the local (Ollama) models.
 * Hovering reveals the models currently loaded in memory (the running set from
 * `list_ollama_models_detailed`), each shown with a green "loaded" lamp. Clicking
 * a model's name makes it the default (`settings.ollama_model`); its task tags
 * (Autocomplete / Grammar / Tabs → `settings.ollama_roles`) pin individual jobs
 * to specific loaded models, so several can run different tasks in parallel. A
 * task with no tag falls back to the default model. Always shown: when Ollama
 * isn't installed (or no
 * models are present yet) the menu offers an "Install models…" entry that opens
 * the Ollama Settings panel, where Ollama itself and any model can be installed.
 */
export function LocalModelMenu() {
  const t = useT();
  const { settings, updateSettings } = useSettingsStore();
  const activeModel = settings?.ollama_model;
  const energySaver = useEnergySaver();
  const [installed, setInstalled] = useState(false);
  // Three-state Ollama health for the status lamp: "stopped" (server down, red),
  // "idle" (server up, no model in memory, yellow), "loaded" (a model is loaded
  // in memory, green).
  // Once Ollama is installed, the server's health is polled so the button shows a
  // live lamp without the user opening the menu. The poll itself is the app-wide
  // shared one (`lib/ollamaStatus`) — it is a machine-wide fact, and the file
  // viewer asks the same question per open tab, so a timer here as well meant the
  // same `/api/ps` round trip several times over.
  const status = useOllamaStatus(installed, saverInterval(5000, energySaver));
  const [open, setOpen] = useState(false);
  // Every installed model (from list_ollama_models_detailed). Resident ones are
  // selectable as the active local model; the rest can be loaded into memory.
  const [models, setModels] = useState<LocalModelInfo[]>([]);
  /** The machine's GPUs; empty when none can be read, and then no headroom line. */
  const [gpus, setGpus] = useState<GpuSample[]>([]);
  /** The machine's CPU + RAM; null until the first sample, and on a platform
      with no aggregate backend (`supported: false`) the block stays hidden. */
  const [machine, setMachine] = useState<MachineLoad | null>(null);
  // Installed agent CLIs (from list_agents), shown in the Agents section so the
  // ones already available are visible without opening "Manage agents".
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Models currently being loaded into memory, keyed by name (from the global
  // `ollama-load-progress` events emitted by `load_ollama_model`, so a load
  // started anywhere — here or the settings panel — shows here too). Ollama
  // streams no load percentage, so this is an indeterminate state, not a pct.
  const [loads, setLoads] = useState<Record<string, "loading" | "error">>({});
  // Live pull progress per model ref (from the global `ollama-pull-progress`
  // events emitted by `pull_ollama_model`), so downloads started anywhere show
  // here too. `pct` is null during the manifest/verify phases (no byte totals).
  const [downloads, setDownloads] = useState<Record<string, { pct: number | null }>>({});
  // Models whose download the user paused this session — each offers Resume/Delete.
  const [paused, setPaused] = useState<Set<string>>(new Set());
  // Resident models being unloaded from memory (stop_ollama_model in flight), so
  // the row can show "Unloading…" and disable the control until it settles.
  const [unloading, setUnloading] = useState<Set<string>>(new Set());
  const closeTimer = useRef<number | null>(null);

  // Detect whether Ollama is installed. Poll while it's still missing so that
  // installing Ollama mid-session is picked up without restarting Eldrun; stop
  // once detected (it won't be uninstalled live, and `ollama_status` polling
  // takes over from here — see below).
  useEffect(() => {
    if (installed) return;
    let cancelled = false;
    const check = () =>
      invoke<boolean>("ollama_is_installed")
        .then((ok) => {
          if (!cancelled) setInstalled(ok);
        })
        .catch(() => {});
    void check();
    const id = window.setInterval(check, saverInterval(5000, energySaver));
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [installed, energySaver]);

  // Track in-flight downloads regardless of which surface started them.
  useEffect(() => {
    const un = listen<{ model: string; status: string; completed: number; total: number }>(
      "ollama-pull-progress",
      (e) => {
        const { model, status, completed, total } = e.payload;
        if (status === "paused") {
          setDownloads((d) => {
            const { [model]: _drop, ...rest } = d;
            return rest;
          });
          setPaused((p) => new Set(p).add(model));
          return;
        }
        setDownloads((d) => {
          if (status === "success") {
            const { [model]: _done, ...rest } = d;
            return rest;
          }
          return {
            ...d,
            [model]: { pct: total > 0 ? Math.min(100, Math.floor((completed / total) * 100)) : null },
          };
        });
      },
    );
    return () => {
      void un.then((f) => f());
    };
  }, []);

  // Track in-flight loads-into-memory regardless of which surface started them.
  useEffect(() => {
    const un = listen<{ model: string; status: string }>("ollama-load-progress", (e) => {
      const { model, status } = e.payload;
      setLoads((d) => {
        if (status === "success") {
          const { [model]: _done, ...rest } = d;
          return rest;
        }
        return { ...d, [model]: status === "error" ? "error" : "loading" };
      });
      // Once a model becomes resident, re-read the list so it moves into the
      // selectable (loaded) section.
      if (status === "success") void fetchModels();
    });
    return () => {
      void un.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  // The GPU's own memory, polled only while the menu is open: the question this
  // menu raises is "will the next model fit?", which each model's `size_vram`
  // (its own share) cannot answer — only the free headroom on the device can.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const check = () =>
      invoke<GpuSample[]>("gpu_memory_snapshot")
        .then((g) => {
          if (!cancelled) setGpus(g);
        })
        .catch(() => {});
    void check();
    const id = window.setInterval(check, saverInterval(2000, energySaver));
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [open, energySaver]);

  // The CPU and RAM the *machine* is under, on the same open-only poll as the
  // GPU above and for the same reason: "will the next model fit, and is there
  // anything left to run it with?" is one question with three halves, and a
  // model that doesn't fit in VRAM lands in system RAM and answers on the CPU.
  // Machine-wide deliberately, not Eldrun's own tree (the header readout's
  // subject) — Ollama is a separate process, so the app's own figures would say
  // nothing about the thing this menu is about. The command carries no process
  // table, so a poll here is three small reads rather than the monitor pane's
  // whole-system snapshot.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const check = () =>
      invoke<MachineLoad>("machine_load_snapshot")
        .then((m) => {
          if (!cancelled) setMachine(m);
        })
        .catch(() => {});
    void check();
    const id = window.setInterval(check, saverInterval(2000, energySaver));
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [open, energySaver]);

  // Read the full installed-model list (resident + on-disk). Used on hover and
  // re-run after a load completes so a freshly-resident model moves up.
  const fetchModels = () => {
    setLoading(true);
    setError(null);
    return invoke<LocalModelInfo[]>("list_ollama_models_detailed")
      .then((all) => setModels(all))
      .catch((e: string) => {
        setModels([]);
        setError(e === "not_running" ? t("localModel.notRunning") : t("localModel.failedToLoadModels"));
      })
      .finally(() => setLoading(false));
  };

  // Probe the installed agent CLIs (cheap PATH lookups in the backend) so the
  // Agents section can list the ones already available.
  const fetchAgents = () => {
    invoke<AgentInfo[]>("list_agents")
      .then((all) => setAgents(all.filter((a) => a.installed)))
      .catch(() => {});
  };

  const reveal = () => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    setOpen(true);
    fetchAgents();
    if (!installed) return; // nothing to list yet — only the install entry shows
    void fetchModels();
  };

  // Warm a model into memory and keep it resident. The button reflects progress
  // via the `loads` map (driven by `ollama-load-progress`); we also optimistically
  // mark it loading immediately so the bar shows without waiting for the event.
  const loadIntoMemory = (model: string) => {
    setLoads((d) => ({ ...d, [model]: "loading" }));
    setError(null);
    invoke("load_ollama_model", { model })
      .then(() => fetchModels())
      .catch((e: string) => {
        setLoads((d) => ({ ...d, [model]: "error" }));
        setError(typeof e === "string" && e === "not_running" ? t("localModel.notRunning") : t("localModel.failedToLoadModel"));
      });
  };

  // Evict a resident model from memory (keep_alive=0) without deleting it from
  // disk. Re-reads the model list afterwards so the row drops out of the resident
  // section; the auto-assign effect then re-points tasks if a single model is left.
  const unloadFromMemory = (model: string) => {
    setUnloading((s) => new Set(s).add(model));
    setError(null);
    invoke("stop_ollama_model", { model })
      .then(() => fetchModels())
      .catch((e: string) =>
        setError(typeof e === "string" && e === "not_running" ? t("localModel.notRunning") : t("localModel.failedToUnloadModel")),
      )
      .finally(() =>
        setUnloading((s) => {
          const n = new Set(s);
          n.delete(model);
          return n;
        }),
      );
  };

  // Pause an in-flight download; the backend keeps the partial blobs and emits a
  // "paused" event that flips the row to Resume / Delete.
  const pausePull = (model: string) => {
    void invoke("pause_ollama_pull", { model });
  };

  // Resume a paused download — Ollama continues from the partial blobs.
  const resumePull = (model: string) => {
    setPaused((p) => {
      const n = new Set(p);
      n.delete(model);
      return n;
    });
    invoke("pull_ollama_model", { model }).catch(() => {});
  };

  // Delete a paused download's partial data.
  const deletePausedPull = (model: string) => {
    setPaused((p) => {
      const n = new Set(p);
      n.delete(model);
      return n;
    });
    void invoke("delete_ollama_pull", { model }).catch(() => {});
  };

  // Open the Ollama Settings panel (owned by ProjectSwitcher) to install Ollama
  // and/or browse the installable-models catalog.
  const openInstall = () => {
    setOpen(false);
    window.dispatchEvent(new CustomEvent("eldrun:open-settings", { detail: "ollama" }));
  };

  // Open the "Manage Agents" panel to install AI coding-agent CLIs (Claude,
  // Codex, Gemini, Mistral, Aider, OpenCode, Cursor, Copilot, Grok, Qwen) that
  // Eldrun can then launch as agent tabs.
  const openAgents = () => {
    setOpen(false);
    window.dispatchEvent(new CustomEvent("eldrun:open-settings", { detail: "agents" }));
  };

  const scheduleClose = () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => {
      setOpen(false);
      closeTimer.current = null;
    }, 250);
  };

  const select = (model: string | undefined) => {
    void updateSettings({ ollama_model: model });
    setOpen(false);
  };

  // When exactly one model is resident in memory, make it the model for
  // everything — the default plus every task tag (autocomplete/grammar/tabs) —
  // so loading a single model "just works" without wiring each task by hand.
  // Tracked per resident model via a ref so we auto-apply once per newly-loaded
  // sole model: manual reassignments the user makes afterwards (while that model
  // stays the only resident one) are preserved. Dropping to zero or rising to
  // two+ resident models re-arms it, so the next single-model load re-applies.
  const autoAppliedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!settings) return;
    const resident = models.filter((m) => m.running);
    if (resident.length !== 1) {
      autoAppliedFor.current = null;
      return;
    }
    const only = resident[0].name;
    if (autoAppliedFor.current === only) return;
    autoAppliedFor.current = only;
    const current = settings.ollama_roles ?? {};
    const already =
      settings.ollama_model === only && MODEL_ROLES.every((r) => current[r.key] === only);
    if (already) return;
    const allRoles: Record<string, string> = {};
    for (const r of MODEL_ROLES) allRoles[r.key] = only;
    void updateSettings({ ollama_model: only, ollama_roles: allRoles });
  }, [models, settings, updateSettings]);

  // "Load on Eldrun start": which models are warmed into memory at launch
  // (`settings.ollama_autoload_models`, honoured by `stores/ollamaAutoload`).
  // A chip per model rather than one global switch, because the whole point is
  // that different jobs want different models resident.
  const autoload = settings?.ollama_autoload_models ?? [];
  const toggleAutoload = (model: string) => {
    const next = autoload.includes(model)
      ? autoload.filter((m) => m !== model)
      : [...autoload, model];
    void updateSettings({ ollama_autoload_models: next });
  };

  // Per-task model tags. Each task maps to exactly one model; tagging a model for
  // a task it already owns clears the tag (toggle). Kept open so several tags can
  // be assigned in one pass. Unassigned tasks fall back to the default model.
  const roles = settings?.ollama_roles ?? {};
  const toggleRole = (role: string, model: string) => {
    const next = { ...roles };
    if (next[role] === model) delete next[role];
    else next[role] = model;
    void updateSettings({ ollama_roles: next });
  };

  // The launch-time autoload's one report to the user. The Energy Saver skip is
  // the case this exists for: the models the user armed are deliberately absent,
  // and without a line saying so that is indistinguishable from a broken switch.
  // A failed load is reported for the same reason — nobody is watching at launch.
  const autoPhase = useOllamaAutoloadStore((s) => s.phase);
  const autoDismissed = useOllamaAutoloadStore((s) => s.dismissed);
  const autoModels = useOllamaAutoloadStore((s) => s.models);
  const autoFailed = useOllamaAutoloadStore((s) => s.failed);
  const autoLoadNow = useOllamaAutoloadStore((s) => s.loadNow);
  const autoDismiss = useOllamaAutoloadStore((s) => s.dismiss);
  const showAutoNote =
    !autoDismissed && (autoPhase === "skipped" || autoPhase === "loading" || autoPhase === "error");
  // The same sentence, carried on the button's tooltip so it is readable without
  // opening the menu (the `!` marker is what points at it).
  const autoNoteTitle = !showAutoNote
    ? ""
    : autoPhase === "skipped"
      ? t("localModel.autostartSkipped", { names: autoModels.join(", ") })
      : autoPhase === "loading"
        ? t("localModel.autostartLoading", { names: autoModels.join(", ") })
        : t("localModel.autostartFailed", { error: Object.values(autoFailed)[0] ?? "" });

  // Resident models are selectable; the rest are offered as "load into memory".
  const running = models.filter((m) => m.running);
  const available = models.filter((m) => !m.running);
  const { used: gpuUsed, total: gpuTotal } = gpuTotals(gpus);
  const gpuBusyPct = gpuBusy(gpus);
  const showMachine = machine?.supported === true;
  // Windows reports no load average, so its zeroed triple is "no reading" rather
  // than an idle machine — printing `0.00` there would be a made-up measurement.
  const loadShown = showMachine && machine.load_avg.some((v) => v > 0);
  const cpuTemp = formatTempC(machine?.cpu_temp_c);
  // The two other thermal readings, each `null` wherever nothing answers: a DIMM
  // sensor is only wired on some boards, and a GPU driver may report memory
  // without reporting a temperature. Absent, never a zero — a fabricated 0 °C in
  // a row that is otherwise all real measurements is worse than a missing one.
  const memTemp = formatTempC(machine?.mem_temp_c);
  const gpuTemp = formatTempC(gpuHottest(gpus));
  const gpuNote =
    [gpuBusyPct != null ? t("localModel.gpuBusy", { pct: Math.round(gpuBusyPct) }) : null, gpuTemp]
      .filter(Boolean)
      .join(" · ") || null;
  const cpuTitle = !showMachine
    ? ""
    : [
        t("localModel.cpuTitle"),
        t("localModel.cpuCores", { cores: machine.num_cores }),
        loadShown
          ? t("localModel.cpuLoad", { load: machine.load_avg.map((v) => v.toFixed(2)).join(" ") })
          : null,
        cpuTemp,
      ]
        .filter(Boolean)
        .join("\n");
  const ramTitle = !showMachine
    ? ""
    : [
        t("localModel.ramTitle"),
        machine.swap_total_bytes > 0
          ? t("localModel.ramSwap", {
              used: formatBytes(machine.swap_used_bytes),
              total: formatBytes(machine.swap_total_bytes),
            })
          : null,
        memTemp ? t("localModel.ramTemp", { temp: memTemp }) : null,
      ]
        .filter(Boolean)
        .join("\n");

  return (
    <div className="global-apps-menu no-drag" onMouseEnter={reveal} onMouseLeave={scheduleClose}>
      <button
        type="button"
        className="global-apps-menu-btn local-model-btn"
        title={
          !installed
            ? t("localModel.installTitle")
            : `${t(
                status === "loaded"
                  ? "localModel.runningLoaded"
                  : status === "idle"
                    ? "localModel.running"
                    : "localModel.stopped",
              )}${activeModel ? t("localModel.modelSuffix", { name: activeModel }) : t("localModel.noModelSelected")}${
                autoNoteTitle ? `\n${autoNoteTitle}` : ""
              }`
        }
        aria-label={t("localModel.ariaLabel")}
        aria-haspopup="menu"
        aria-expanded={open}
        style={{ color: "var(--warning)" }}
      >
        🧠
        {installed && (
          <span
            className={`local-model-status-dot ${status}`}
            aria-hidden="true"
          />
        )}
        {/* The menu only opens on hover, so a notice living inside it would be
            invisible to someone who never opens it — which is precisely the
            person who armed a model at start and expects it to be there. */}
        {showAutoNote && autoPhase !== "loading" && (
          <span className="local-model-autostart-flag" aria-hidden="true">
            !
          </span>
        )}
      </button>
      {open && (
        <div className="tab-new-menu local-model-menu">
          {/* Agents · Local models · Machine, in that order: the two things you
              can *pick* first, then what is left to run them with. The section
              headers carry their own chrome here (`.local-model-menu` in
              themes.css) because this menu is the one that stacks four of them
              over rows that are themselves multi-line — an 9px accent word was
              not enough to break the list into parts. */}
          <div className="tab-new-menu-group-label">{t("localModel.agentsGroup")}</div>
          {agents.map((a) => (
            <div key={a.id} className="local-model-agent-row" title={t("localModel.agentInstalled", { label: a.label })}>
              {/* Green lamp mirrors a loaded model: this agent CLI is installed. */}
              <span className="local-model-lamp" aria-hidden="true" />
              <span className="local-model-loaded-name">{a.label}</span>
            </div>
          ))}
          <button className="tab-new-menu-item" onClick={openAgents}>
            <span className="tab-new-menu-dot" style={{ color: "transparent" }}>
              ●
            </span>
            {t("localModel.manageAgents")}
          </button>
          <div className="tab-new-menu-group-label">{t("localModel.localModelsGroup")}</div>
          {showAutoNote && (
            <div
              className={`local-model-autostart-note${
                autoPhase === "skipped" ? " saver" : autoPhase === "error" ? " failed" : ""
              }`}
            >
              {/* Corner ✕, not a chip in the action row: dismissing is not one of
                  the note's offers, and while loading it was that row's only
                  member — a lone ✕ floating where a button was expected. */}
              <button
                type="button"
                className="local-model-autostart-dismiss"
                title={t("localModel.autostartDismiss")}
                aria-label={t("localModel.autostartDismiss")}
                onClick={autoDismiss}
              >
                ✕
              </button>
              <div className="local-model-autostart-text">
                <span className="local-model-autostart-sentence">{autoNoteTitle}</span>
                <UntestedTag />
              </div>
              {autoPhase !== "loading" && (
                <div className="local-model-autostart-actions">
                  <button
                    type="button"
                    className="local-model-role-chip"
                    title={t("localModel.autostartLoadNowTitle")}
                    onClick={() => void autoLoadNow()}
                  >
                    {t("localModel.autostartLoadNow")}
                  </button>
                  {autoPhase === "skipped" && (
                    <button
                      type="button"
                      className="local-model-role-chip"
                      title={t("localModel.autostartSettingsTitle")}
                      onClick={openInstall}
                    >
                      {t("localModel.autostartSettings")}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
          {installed && (Object.keys(downloads).length > 0 || paused.size > 0) && (
            <div className="local-model-downloads">
              {Object.entries(downloads).map(([model, d]) => (
                <div key={model} className="local-model-download-row" title={t("localModel.downloadingTitle")}>
                  <div className="local-model-download-head">
                    <span className="local-model-loaded-name">{model}</span>
                    <span className="local-model-download-pct">
                      {d.pct != null ? `${d.pct}%` : "…"}
                    </span>
                    <button
                      type="button"
                      className="local-model-download-action"
                      title={t("localModel.pauseDownloadTitle")}
                      onClick={() => pausePull(model)}
                    >
                      {t("ollama.pause")}
                    </button>
                  </div>
                  <div className="ollama-download-bar">
                    <div
                      className={`ollama-download-bar-fill${d.pct == null ? " indeterminate" : ""}`}
                      style={d.pct != null ? { width: `${d.pct}%` } : undefined}
                    />
                  </div>
                </div>
              ))}
              {[...paused].map((model) => (
                <div key={`paused:${model}`} className="local-model-download-row" title={t("localModel.pausedTitle")}>
                  <div className="local-model-download-head">
                    <span className="local-model-loaded-name">{model}</span>
                    <span className="local-model-download-pct">{t("ollama.pausedBadge")}</span>
                    <button
                      type="button"
                      className="local-model-download-action"
                      title={t("localModel.resumeDownloadTitle")}
                      onClick={() => resumePull(model)}
                    >
                      {t("ollama.resume")}
                    </button>
                    <button
                      type="button"
                      className="local-model-download-action danger"
                      title={t("localModel.deletePartialDownloadTitle")}
                      onClick={() => deletePausedPull(model)}
                    >
                      {t("ollama.delete")}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {!installed ? (
            <div className="tab-new-menu-hint">{t("localModel.notInstalled")}</div>
          ) : loading && models.length === 0 ? (
            <div className="tab-new-menu-hint">{t("common.loading")}</div>
          ) : error ? (
            <div className="tab-new-menu-hint">{error}</div>
          ) : models.length === 0 ? (
            <div className="tab-new-menu-hint">
              {status === "stopped" ? t("localModel.serverStopped") : t("localModel.noModelsInstalled")}
            </div>
          ) : (
            <>
              {/* Resident models — selectable as the active local model. */}
              {running.length === 0 ? (
                <div className="tab-new-menu-hint">{t("ollama.noModelLoaded")}</div>
              ) : (
                running.map((m) => (
                  <div key={m.name} className="local-model-row">
                    <button
                      className="tab-new-menu-item local-model-pick"
                      title={t(
                        activeModel === m.name
                          ? "localModel.defaultLoadedTitle"
                          : "localModel.loadedClickDefaultTitle",
                      )}
                      onClick={() => select(m.name)}
                    >
                      {/* Green lamp: this model is resident in Ollama's memory. */}
                      <span className="local-model-lamp" aria-hidden="true" />
                      <span className="local-model-loaded-name">{m.name}</span>
                      {activeModel === m.name && (
                        <span className="local-model-default-tag">{t("localModel.defaultTag")}</span>
                      )}
                      <span className="local-model-loaded-badges">
                        {m.parameter_size && <span>{m.parameter_size}</span>}
                        {m.quantization && <span>{m.quantization}</span>}
                        <span className={m.size_vram > 0 ? "gpu" : "cpu"}>
                          {m.size_vram > 0 ? `GPU ${formatBytes(m.size_vram)}` : "CPU"}
                        </span>
                      </span>
                    </button>
                    {/* Task tags: pin this model to a job (autocomplete/grammar/
                        tabs). Several loaded models can each own a different one. */}
                    <div className="local-model-roles">
                      {MODEL_ROLES.map((r) => {
                        const on = roles[r.key] === m.name;
                        const roleLabel = t(r.labelKey);
                        return (
                          <button
                            key={r.key}
                            type="button"
                            className={`local-model-role-chip${on ? " on" : ""}`}
                            title={t(on ? "localModel.usedForRole" : "localModel.useForRole", {
                              role: roleLabel.toLowerCase(),
                              name: m.name,
                            })}
                            onClick={() => toggleRole(r.key, m.name)}
                          >
                            {roleLabel}
                          </button>
                        );
                      })}
                      {/* The row's own two verbs, grouped and right-aligned: the
                          task tags above are a wrapping set, these are a column. */}
                      <div className="local-model-row-actions">
                        {/* Load this model into memory on every Eldrun start. */}
                        <button
                          type="button"
                          className={`local-model-role-chip local-model-autostart-chip${
                            autoload.includes(m.name) ? " on" : ""
                          }`}
                          title={t(
                            autoload.includes(m.name)
                              ? "localModel.autostartOnTitle"
                              : "localModel.autostartOffTitle",
                            { name: m.name },
                          )}
                          onClick={() => toggleAutoload(m.name)}
                        >
                          {t("localModel.autostartChip")}
                        </button>
                        {/* Evict this model from memory (keeps it on disk). */}
                        <button
                          type="button"
                          className="local-model-role-chip local-model-unload"
                          disabled={unloading.has(m.name)}
                          title={t("localModel.unloadFromMemoryTitle", { name: m.name })}
                          onClick={() => unloadFromMemory(m.name)}
                        >
                          {unloading.has(m.name) ? t("localModel.unloading") : t("ollama.unload")}
                        </button>
                      </div>
                    </div>
                  </div>
                ))
              )}
              {/* Installed-but-not-resident models — click to load into memory. */}
              {available.length > 0 && (
                <>
                  <div className="tab-new-menu-group-label">{t("localModel.loadIntoMemoryGroup")}</div>
                  {available.map((m) => {
                    const st = loads[m.name];
                    return (
                      <div key={m.name} className="local-model-load-row">
                        <div className="local-model-load-line">
                          <span className="tab-new-menu-dot" style={{ color: "transparent" }}>
                            ●
                          </span>
                          <span className="local-model-loaded-name">{m.name}</span>
                          {m.parameter_size && (
                            <span className="local-model-loaded-badges">
                              <span>{m.parameter_size}</span>
                            </span>
                          )}
                          {/* Same trailing pair as a resident row: armed-for-launch,
                              then the row's verb — a column, not a ragged edge
                              trailing whatever width the model name happened to be. */}
                          <div className="local-model-row-actions">
                            {/* Arm it for the next launch without loading it now. */}
                            <button
                              type="button"
                              className={`local-model-role-chip local-model-autostart-chip${
                                autoload.includes(m.name) ? " on" : ""
                              }`}
                              title={t(
                                autoload.includes(m.name)
                                  ? "localModel.autostartOnTitle"
                                  : "localModel.autostartOffTitle",
                                { name: m.name },
                              )}
                              onClick={() => toggleAutoload(m.name)}
                            >
                              {t("localModel.autostartChip")}
                            </button>
                            <button
                              type="button"
                              className="local-model-role-chip local-model-load-action"
                              disabled={st === "loading"}
                              title={t(st === "error" ? "localModel.failedRetryTitle" : "localModel.loadIntoMemoryTitle")}
                              onClick={() => loadIntoMemory(m.name)}
                            >
                              {st === "loading" ? t("common.loading") : st === "error" ? t("localModel.failed") : t("ollama.load")}
                            </button>
                          </div>
                        </div>
                        {st === "loading" && (
                          <div className="ollama-download-bar local-model-load-bar">
                            <div className="ollama-download-bar-fill indeterminate" />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </>
              )}
            </>
          )}
          <button className="tab-new-menu-item" onClick={openInstall}>
            <span className="tab-new-menu-dot" style={{ color: "transparent" }}>
              ●
            </span>
            {installed ? t("localModel.manageLocalModels") : t("localModel.installOllamaEllipsis")}
          </button>
          {/* Its own group, and the menu's last, because it is neither an agent
              nor a model: it is what the machine has left for whichever of them
              you pick above it. Each row is the *device's* figure, never a
              model's share of it — what is free here is what the next model has
              to fit into — and a reading that cannot be taken is absent rather
              than zero (no GPU on an Intel-only box; no aggregate CPU/memory
              backend outside Linux/Windows/macOS; a DIMM sensor most boards
              don't wire), since a zero would read as "no room" or "stone cold".
              The meter is the point: a percentage toned green/amber/red says
              "will it fit" at a glance, which is the only question asked here. */}
          {(showMachine || gpus.length > 0) && (
            <>
              <div className="tab-new-menu-group-label local-model-machine-label">
                <span>{t("localModel.machineGroup")}</span>
                <UntestedTag />
              </div>
              <div className="local-model-stats">
                {showMachine && (
                  <>
                    <StatMeter
                      label="CPU"
                      value={t("localModel.cpuPercent", { pct: Math.round(machine.cpu_percent) })}
                      // Temperature only where a sensor answers. The tooltip
                      // carries the load average, a three-number reading no
                      // single row has room for.
                      note={cpuTemp}
                      detail={t("localModel.cpuCores", { cores: machine.num_cores })}
                      percent={machine.cpu_percent}
                      title={cpuTitle}
                    />
                    <StatMeter
                      label="RAM"
                      value={t("localModel.statUsedTotal", {
                        used: formatBytes(machine.mem_used_bytes),
                        total: formatBytes(machine.mem_total_bytes),
                      })}
                      // The hottest DIMM, on the boards that wire a sensor at
                      // all. Absent everywhere else — and absent is the common
                      // answer here, which is exactly why it must not be a zero.
                      note={memTemp}
                      detail={t("localModel.ramFree", {
                        free: formatBytes(
                          Math.max(0, machine.mem_total_bytes - machine.mem_used_bytes),
                        ),
                      })}
                      percent={gpuPercent(machine.mem_used_bytes, machine.mem_total_bytes)}
                      title={ramTitle}
                    />
                  </>
                )}
                {gpus.length > 0 && (
                  <StatMeter
                    label="GPU"
                    value={t("localModel.statUsedTotal", {
                      used: formatBytes(gpuUsed),
                      total: formatBytes(gpuTotal),
                    })}
                    // Utilization and temperature, each only when a driver
                    // reports it — `null` there means "the driver won't say",
                    // not an idle or a cold GPU. The free headroom keeps the
                    // row's end either way: it is the figure that answers
                    // whether the next model fits.
                    note={gpuNote}
                    detail={t("localModel.gpuFree", { free: formatBytes(Math.max(0, gpuTotal - gpuUsed)) })}
                    percent={gpuPercent(gpuUsed, gpuTotal)}
                    title={gpus.map(gpuAdapterTooltip).join("\n")}
                  />
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
