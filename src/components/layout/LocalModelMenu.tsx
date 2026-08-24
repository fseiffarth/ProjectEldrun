import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSettingsStore } from "../../stores/settings";
import { useQuiesce, saverInterval } from "../../stores/power";
import { useOllamaAutoloadStore } from "../../stores/ollamaAutoload";
import { useOllamaUpgradeStore } from "../../stores/ollamaUpgrade";
import { useOllamaStatus } from "../../lib/ollamaStatus";
import { UntestedTag } from "../common/UntestedTag";
import {
  checkOllamaUpdates,
  loadOllamaModel,
  ollamaGpuStatus,
  ollamaVersionStatus,
  type LoadDevice,
  type OllamaGpuStatus,
  type OllamaModelUpdate,
  type OllamaVersionStatus,
} from "../../lib/localDrivers";
import { runInstallInTab, type InstallShellKind } from "../../lib/installCommand";
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
import { useHeaderHoverMenuStore } from "../../stores/headerHoverMenu";
import { useSkillsOverlayStore } from "../../stores/skills";

const MENU_ID = "local-model";

/** Subset of the backend `OllamaModelInfo` the menu needs (installed models). */
interface LocalModelInfo {
  name: string;
  parameter_size: string | null;
  quantization: string | null;
  running: boolean;
  /** VRAM bytes in use; non-zero → running on GPU. */
  size_vram: number;
  /** Total size on disk. Roughly what loading it will cost in RAM (or VRAM),
      which is the question the Machine group's meters above are there for. */
  size: number;
  /**
   * Ollama's own capability list. **Empty means "couldn't ask"**, never "none"
   * — see the backend's `model_capabilities`. Hence `lacksTools` below tests
   * for a non-empty list that omits `tools`, rather than for the absence of
   * `tools`: an empty list must not mark a model as unable to run agents.
   */
  capabilities?: string[];
}

/**
 * True only when Ollama positively said this model has no tool-calling support
 * — the thing that makes it unusable for Codex, Claude Code, OpenCode, Droid
 * and OpenClaw, all of which drive a model through tool calls. Everything else
 * (an empty list, an older backend that doesn't send the field) is *unknown*
 * and reads as fine, because a marker that appears when a probe fails teaches
 * the user to ignore it.
 */
function lacksTools(m: LocalModelInfo): boolean {
  const caps = m.capabilities;
  return !!caps && caps.length > 0 && !caps.includes("tools");
}

/**
 * Ollama says this model produces embeddings and cannot complete text at all.
 * Shown *instead of* the no-tools chip, never beside it: every embedding model
 * also lacks tools, so both would be true — but "no tools" understates this one
 * badly. It reads as "usable, just not for agent tabs", when in fact the model
 * cannot answer a prompt at all, and someone picking it as their default local
 * model would find nothing works rather than one thing missing.
 */
function isEmbeddingOnly(m: LocalModelInfo): boolean {
  const caps = m.capabilities;
  return !!caps && caps.includes("embedding") && !caps.includes("completion");
}

/**
 * A capability Ollama positively reported. Absence is *unknown*, never "no" —
 * the same rule `lacksTools` follows, and the reason these tags only ever
 * appear rather than being negated: an empty list means the probe failed (see
 * `LocalModelInfo.capabilities`), and a badge drawn from a failed probe is
 * worse than no badge.
 */
function hasCapability(m: LocalModelInfo, cap: string): boolean {
  return !!m.capabilities && m.capabilities.includes(cap);
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
 *
 * `pending` marks a tag whose *consumer* does not exist yet — the tag is stored
 * and shown, and nothing reads it. It is offered anyway because the assignment
 * is the user's statement about which model a job may use, and it has to be
 * answerable before the job exists rather than after: `mail` is the model a
 * future mail task (importance scoring, summaries) will run on, and until that
 * lands the chip says so in its tooltip rather than quietly implying a feature.
 */
const MODEL_ROLES: Array<{ key: string; labelKey: TranslationKey; pending?: boolean }> = [
  { key: "autocomplete", labelKey: "localModel.role.autocomplete" },
  { key: "grammar", labelKey: "localModel.role.grammar" },
  { key: "tabs", labelKey: "localModel.role.tabs" },
  // `mail` was `pending` until Group Q; the mail assistant (#204–#208) now reads
  // this role, so the chip is live — a resident model can be pinned to it and the
  // mail features run against it.
  { key: "mail", labelKey: "localModel.role.mail" },
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
 * The "can't run agents" marker on a model row. Shown on **both** lists —
 * resident and on-disk — because the fact belongs to the model, not to whether
 * it happens to be in memory: picking a completion-only model as the default is
 * what silently empties the + menu's Local Model group, and this is the only
 * place that decision is made.
 */
function NoToolsChip({ name, t }: { name: string; t: (k: TranslationKey, v?: Record<string, string>) => string }) {
  return (
    <span
      className="local-model-chip local-model-notools-chip"
      title={t("localModel.noToolsTitle", { name })}
    >
      {t("localModel.noToolsChip")}
    </span>
  );
}

/**
 * The stronger sibling of the no-tools chip: this model does embeddings only.
 * Same warning tone rather than a danger one, for the same reason — the model
 * is not broken, it simply answers a different question than the one this menu
 * is mostly about. See `isEmbeddingOnly` for why it replaces the other chip.
 */
function EmbeddingOnlyChip({
  name,
  t,
}: {
  name: string;
  t: (k: TranslationKey, v?: Record<string, string>) => string;
}) {
  return (
    <span
      className="local-model-chip local-model-notools-chip"
      title={t("localModel.embeddingTitle", { name })}
    >
      {t("localModel.embeddingChip")}
    </span>
  );
}

/**
 * A plain fact about a model — its quantization, its size on disk, a capability
 * Ollama reported. Deliberately NEUTRAL: the only coloured chip on a card is
 * the caveat (no-tools / embeddings-only), and that is the whole point of it.
 * A row of coloured facts beside it would cost the caveat exactly the
 * visibility it exists for.
 */
function ModelChip({ label, title }: { label: string; title: string }) {
  return (
    <span className="local-model-chip" title={title}>
      {label}
    </span>
  );
}

/**
 * The capability tags a model earns by reporting them: vision, thinking. Shared
 * by both lists so a model reads the same whether or not it happens to be in
 * memory — the facts belong to the model, not to its residency.
 */
function CapabilityChips({
  m,
  t,
}: {
  m: LocalModelInfo;
  t: (k: TranslationKey, v?: Record<string, string>) => string;
}) {
  return (
    <>
      {hasCapability(m, "vision") && (
        <ModelChip label={t("localModel.visionChip")} title={t("localModel.visionTitle", { name: m.name })} />
      )}
      {hasCapability(m, "thinking") && (
        <ModelChip label={t("localModel.thinkingChip")} title={t("localModel.thinkingTitle", { name: m.name })} />
      )}
    </>
  );
}

/**
 * The caveat chip, if this model has one — embeddings-only outranking no-tools,
 * never both. One component so the two lists cannot disagree about which of the
 * two a given model deserves.
 */
function CaveatChip({
  m,
  t,
}: {
  m: LocalModelInfo;
  t: (k: TranslationKey, v?: Record<string, string>) => string;
}) {
  if (isEmbeddingOnly(m)) return <EmbeddingOnlyChip name={m.name} t={t} />;
  if (lacksTools(m)) return <NoToolsChip name={m.name} t={t} />;
  return null;
}

/**
 * A model row's update control: the button when the registry has a newer
 * manifest, a muted "couldn't check" when it couldn't be reached, and nothing
 * at all otherwise — including before any check has run. Silence is the right
 * default here: an "up to date" tick nobody asked for would be a claim made
 * from no evidence.
 */
function UpdateAction({
  update,
  busy,
  onUpdate,
  t,
}: {
  update: OllamaModelUpdate | undefined;
  busy: boolean;
  onUpdate: () => void;
  t: (k: TranslationKey, v?: Record<string, string>) => string;
}) {
  if (!update) return null;
  if (update.error) {
    return (
      <span className="local-model-update-note" title={update.error}>
        {t("localModel.updateUnknown")}
      </span>
    );
  }
  if (!update.update_available) return null;
  return (
    <button
      type="button"
      className="local-model-role-chip local-model-update-action"
      disabled={busy}
      title={t("localModel.updateTitle", { name: update.model })}
      onClick={onUpdate}
    >
      {busy ? t("localModel.updating") : t("localModel.update")}
    </button>
  );
}

/**
 * Header button (left of the global-apps button) for the local (Ollama) models.
 * Hovering reveals the models currently loaded in memory (the running set from
 * `list_ollama_models_detailed`), each shown with a green "loaded" lamp. Clicking
 * a model's name makes it the default (`settings.ollama_model`); its task tags
 * (Autocomplete / Grammar / Tabs / Mail → `settings.ollama_roles`) pin individual jobs
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
  const quiesce = useQuiesce();
  const [installed, setInstalled] = useState(false);
  // Three-state Ollama health for the status lamp: "stopped" (server down, red),
  // "idle" (server up, no model in memory, yellow), "loaded" (a model is loaded
  // in memory, green).
  // Once Ollama is installed, the server's health is polled so the button shows a
  // live lamp without the user opening the menu. The poll itself is the app-wide
  // shared one (`lib/ollamaStatus`) — it is a machine-wide fact, and the file
  // viewer asks the same question per open tab, so a timer here as well meant the
  // same `/api/ps` round trip several times over.
  const status = useOllamaStatus(installed, saverInterval(5000, quiesce));
  // Shared across every header hover-menu (stores/headerHoverMenu) so switching
  // straight from another one closes it instantly instead of racing its own
  // close-grace timer. `setOpen` mirrors the old local-state setter's boolean
  // signature so the rest of this component reads unchanged.
  const open = useHeaderHoverMenuStore((s) => s.openId === MENU_ID);
  const openMenu = useHeaderHoverMenuStore((s) => s.open);
  const closeMenu = useHeaderHoverMenuStore((s) => s.close);
  const setOpen = (v: boolean) => (v ? openMenu(MENU_ID) : closeMenu(MENU_ID));
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
  // The last update check's verdict per model, and whether one is running.
  // Empty until the user clicks "Check for updates": this is the only thing in
  // the menu that reaches a registry, so it never runs on hover, on a timer or
  // at launch — a menu that phones home every time the pointer crosses the
  // header is exactly the standing traffic Energy Saver exists to remove.
  const [updates, setUpdates] = useState<Record<string, OllamaModelUpdate>>({});
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  // The Ollama *server's* version. The installed half is read on every open and
  // costs nothing (a local `ollama --version`); `latest` stays empty until the
  // same "Check for updates" click that checks the models fills it in. One
  // button for both, because "is any of this out of date" is one question.
  const [version, setVersion] = useState<OllamaVersionStatus | null>(null);
  // The update check's own outcome, deliberately NOT the menu's shared `error`:
  // that one is rendered *instead of* the model list, so routing a failed
  // update check through it replaced every model row with one error line — the
  // list is what the menu is for, and a check that couldn't run is no reason to
  // hide it. `null` = never checked, which is why "up to date" is a state of
  // its own rather than the absence of updates: silence before a check and
  // silence after one must not look the same.
  const [checkResult, setCheckResult] = useState<
    { ok: true; updates: number } | { ok: false; reason: string } | null
  >(null);
  // Whether Ollama can actually use this machine's GPU. Two independent jobs, so
  // it is read once per open rather than polled beside the memory gauges: it
  // gates the per-load CPU/GPU choice (`gpu_present` — with no GPU there is no
  // choice to offer), and it carries the integrated-GPU diagnosis, which costs
  // process spawns and is therefore not something to pay every two seconds.
  const [gpuStatus, setGpuStatus] = useState<OllamaGpuStatus | null>(null);
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
    const id = window.setInterval(check, saverInterval(5000, quiesce));
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [installed, quiesce]);

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


  // The GPU's own memory AND the machine's CPU/RAM, polled only while the menu is
  // open: the question this menu raises is "will the next model fit, and is there
  // anything left to run it with?" — which each model's `size_vram` (its own
  // share) cannot answer; only the device's free headroom and the machine load
  // can. Both are machine-wide (Ollama is a separate process, so Eldrun's own
  // figures say nothing about it) and both carry no process table, so a tick is a
  // handful of small reads. They share ONE interval — same cadence, same gating —
  // rather than two timers firing a frame apart for no benefit.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const check = () => {
      void invoke<GpuSample[]>("gpu_memory_snapshot")
        .then((g) => {
          if (!cancelled) setGpus(g);
        })
        .catch(() => {});
      void invoke<MachineLoad>("machine_load_snapshot")
        .then((m) => {
          if (!cancelled) setMachine(m);
        })
        .catch(() => {});
    };
    check();
    const id = window.setInterval(check, saverInterval(2000, quiesce));
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [open, quiesce]);

  // Whether Ollama is using that GPU at all — read **once per open**, not on the
  // poll above, because it spawns processes (`systemctl`, `ollama serve --help`)
  // to reach its verdict. The two questions look alike and are not: the poll
  // above asks how full the device is, this asks whether the device is being
  // used, and only the second can be answered wrongly by a setting.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    ollamaGpuStatus()
      .then((g) => {
        if (!cancelled) setGpuStatus(g);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Read the full installed-model list (resident + on-disk). Used on hover and
  // re-run after a load completes so a freshly-resident model moves up.
  const fetchModels = () => {
    setLoading(true);
    setError(null);
    return invoke<LocalModelInfo[]>("list_ollama_models_detailed")
      .then((all) => {
        setModels(all);
        // The same reading, handed to the autoload notice: this list is the
        // ground truth for "is it in memory", so a notice still naming a model
        // that is green-lamped two rows below it is fixed here rather than left
        // for the user to reconcile.
        useOllamaAutoloadStore.getState().noteResident(all.filter((m) => m.running).map((m) => m.name));
      })
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
    // Local read, no network — safe on a hover, unlike the `latest` half. Re-run
    // on every open so an upgrade performed outside Eldrun shows up, instead of
    // the version frozen at whenever it was first read. The earlier check's
    // `latest` is carried over, but its verdict is **dropped the moment the
    // installed version changes**: that is exactly the case where the user just
    // upgraded, and a notice still offering the upgrade they performed is the
    // one thing this must not do. A fresh click re-establishes it.
    ollamaVersionStatus(false)
      .then((v) =>
        setVersion((prev) => {
          if (!prev?.latest) return v;
          const stale = prev.current !== v.current;
          return { ...v, latest: prev.latest, update_available: !stale && prev.update_available };
        }),
      )
      .catch(() => {});
  };

  // Warm a model into memory and keep it resident. The button reflects progress
  // via the `loads` map (driven by `ollama-load-progress`); we also optimistically
  // mark it loading immediately so the bar shows without waiting for the event.
  //
  // `device` is the row's CPU/GPU choice, offered whenever this machine has a
  // GPU at all. The GPU status is re-read afterwards and not before: a load is
  // the one moment the answer can change, and asking a GPU request to land on
  // the CPU is exactly the case the notice below has to be able to explain.
  const loadIntoMemory = (model: string, device: LoadDevice = "auto") => {
    setLoads((d) => ({ ...d, [model]: "loading" }));
    setError(null);
    loadOllamaModel(model, device)
      .then(() => {
        void fetchModels();
        ollamaGpuStatus().then(setGpuStatus).catch(() => {});
      })
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

  // Ask the registry which installed models have a newer published version.
  // Explicit only (a button), and it survives a partial answer: a model the
  // registry couldn't be reached for comes back carrying its own `error`, which
  // the row shows as "couldn't check" rather than as "up to date".
  // One click, both questions — the models *and* the server they run on. They
  // are settled independently (`allSettled`): a registry that is down must not
  // suppress the Ollama-version answer, and vice versa, since the two reach
  // entirely different hosts.
  const checkUpdates = () => {
    setCheckingUpdates(true);
    setCheckResult(null);
    void Promise.allSettled([checkOllamaUpdates(), ollamaVersionStatus(true)]).then(
      ([models, server]) => {
        const serverOk = server.status === "fulfilled";
        if (serverOk) setVersion(server.value);

        if (models.status === "fulfilled") {
          setUpdates(Object.fromEntries(models.value.map((u) => [u.model, u])));
          setCheckResult({
            ok: true,
            updates:
              models.value.filter((u) => u.update_available).length +
              (serverOk && server.value.update_available ? 1 : 0),
          });
        } else {
          // Both invokes failing together says something a network error can't:
          // the commands aren't in the running backend. That is a *restart*,
          // not a connectivity problem, and reporting it as one would send the
          // user to look at their firewall.
          setCheckResult({
            ok: false,
            reason: serverOk ? t("localModel.updateCheckFailed") : t("localModel.updateCheckNoBackend"),
          });
        }
        setCheckingUpdates(false);
      },
    );
  };

  // Upgrade Ollama itself, in a visible terminal tab. Never a "copy this and
  // run it yourself": both installers need an interactive sudo/UAC answer, and
  // the tab is where the user gives it. Same one-click path as the first-time
  // install and every agent CLI (`runInstallInTab`).
  const upgradeOllama = () => {
    if (!version?.install_cmd) return;
    // Snapshot what is in memory *before* handing the installer the terminal:
    // the upgrade restarts the server, which evicts every resident model, and
    // this list is the only record that they were ever there. `stores/
    // ollamaUpgrade` watches for the new server and warms exactly these back
    // up; a snapshot of nothing starts no watcher.
    beginUpgradeRestore(
      version.current,
      models.filter((m) => m.running).map((m) => m.name),
    );
    setOpen(false);
    runInstallInTab(
      t("localModel.ollamaUpgradeTabLabel"),
      version.install_cmd,
      (version.shell_kind || "default") as InstallShellKind,
    );
  };

  // Re-pull a model whose tag now points at a newer manifest. This is an
  // ordinary `pull_ollama_model`, so it rides the existing progress events and
  // the existing pause/resume row — an "update" is a pull, and giving it a
  // second download path would be a second set of bugs. The verdict is dropped
  // as the pull starts: it named the digest we are replacing, so keeping it
  // would leave the row offering an update it is in the middle of applying.
  const updateModel = (model: string) => {
    setUpdates((u) => {
      const n = { ...u };
      delete n[model];
      return n;
    });
    invoke("pull_ollama_model", { model })
      .then(() => fetchModels())
      .catch(() => setError(t("localModel.updateFailed")));
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
  // Codex, Gemini, Google Antigravity, Mistral, Aider, OpenCode, Cursor,
  // Copilot, Grok, Qwen) that
  // Eldrun can then launch as agent tabs.
  const openAgents = () => {
    setOpen(false);
    window.dispatchEvent(new CustomEvent("eldrun:open-settings", { detail: "agents" }));
  };

  // Open the Skills Library overlay (`docs/skills_plan.md`). It sits in this
  // menu beside "Manage agents…" because a skill is the same kind of object as
  // the agent CLIs above it: installed per machine, then available to every
  // project — and because two thirds of the library (the sources and their
  // cached clones) were always machine state that could only be reached from a
  // project tab. The project-scoped install still lives in that tab, which is
  // the one surface that knows which project is meant.
  const openSkills = () => {
    setOpen(false);
    useSkillsOverlayStore.getState().openOverlay();
  };

  // The agent Eldrun picks on its own when a feature needs exactly one and the
  // user hasn't chosen per-instance (today: scaffold-fill "Agent choice"; more
  // features are expected to read this same setting rather than each growing
  // its own agent picker). Falls back to Claude, matching every existing reader.
  const defaultAgentCmd = settings?.default_agent_cmd ?? "claude";
  const setDefaultAgent = (id: string) => {
    void updateSettings({ default_agent_cmd: id });
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
  //
  // Excludes a model the *launch-time autoload* put there
  // (`useOllamaAutoloadStore`'s armed list): that model became resident from a
  // setting, not a click, so treating it as "the" pick clobbered whatever
  // default the user had actually chosen — every restart, the moment the
  // autoloaded model finished warming up and was briefly the only one loaded.
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
    if (useOllamaAutoloadStore.getState().models.includes(only)) return;
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

  // Putting the models back after an upgrade (`stores/ollamaUpgrade`). Reported
  // for the same reason the autoload below is: nobody is watching a restart
  // that takes minutes, and a load that starts by itself must say that it did.
  const beginUpgradeRestore = useOllamaUpgradeStore((s) => s.begin);
  const restorePhase = useOllamaUpgradeStore((s) => s.phase);
  const restoreModels = useOllamaUpgradeStore((s) => s.models);
  const restoreLoaded = useOllamaUpgradeStore((s) => s.loaded);
  const restoreFailed = useOllamaUpgradeStore((s) => s.failed);
  const restoreDismissed = useOllamaUpgradeStore((s) => s.dismissed);
  const restoreNow = useOllamaUpgradeStore((s) => s.reloadNow);
  const restoreCancel = useOllamaUpgradeStore((s) => s.cancel);
  const restoreDismiss = useOllamaUpgradeStore((s) => s.dismiss);
  const showRestoreNote = !restoreDismissed && restorePhase !== "idle";
  const restoreSentence = !showRestoreNote
    ? ""
    : restorePhase === "waiting"
      ? t("localModel.upgradeRestoreWaiting", { names: restoreModels.join(", ") })
      : restorePhase === "reloading"
        ? t("localModel.upgradeRestoreLoading", { names: restoreModels.join(", ") })
        : restorePhase === "done"
          ? t("localModel.upgradeRestoreDone", { names: restoreLoaded.join(", ") })
          : restorePhase === "timeout"
            ? t("localModel.upgradeRestoreTimeout", { names: restoreModels.join(", ") })
            : t("localModel.upgradeRestoreFailed", {
                names: Object.keys(restoreFailed).join(", "),
                error: Object.values(restoreFailed)[0] ?? "",
              });

  // The launch-time autoload's one report to the user. The Energy Saver skip is
  // the case this exists for: the models the user armed are deliberately absent,
  // and without a line saying so that is indistinguishable from a broken switch.
  // A failed load is reported for the same reason — nobody is watching at launch.
  const autoPhase = useOllamaAutoloadStore((s) => s.phase);
  const autoDismissed = useOllamaAutoloadStore((s) => s.dismissed);
  const autoModels = useOllamaAutoloadStore((s) => s.models);
  // What is *outstanding*, which is not the same as what was armed: a model the
  // machine-wide server already holds resident was never missing, and a notice
  // that named it anyway sat directly above that model's own green "loaded" row.
  const autoPending = useOllamaAutoloadStore((s) => s.pending);
  const autoFailed = useOllamaAutoloadStore((s) => s.failed);
  const autoLoadNow = useOllamaAutoloadStore((s) => s.loadNow);
  const autoDismiss = useOllamaAutoloadStore((s) => s.dismiss);
  const autoNoteResident = useOllamaAutoloadStore((s) => s.noteResident);
  // A phase with nothing left outstanding has nothing to say — silence is the
  // honest report there, not a sentence contradicted by the list under it.
  const showAutoNote =
    !autoDismissed &&
    ((autoPhase === "skipped" && autoPending.length > 0) ||
      autoPhase === "loading" ||
      (autoPhase === "error" && Object.keys(autoFailed).length > 0));
  // The same sentence, carried on the button's tooltip so it is readable without
  // opening the menu (the `!` marker is what points at it).
  const autoNoteTitle = !showAutoNote
    ? ""
    : autoPhase === "skipped"
      ? t("localModel.autostartSkipped", { names: autoPending.join(", ") })
      : autoPhase === "loading"
        ? t("localModel.autostartLoading", { names: autoModels.join(", ") })
        : t("localModel.autostartFailed", { error: Object.values(autoFailed)[0] ?? "" });

  // Keep that notice honest without waiting for a hover. The menu only reads the
  // model list when it opens, but the skip notice (and the button's `!`) live on
  // whether or not anyone opens it — so while one is up, a flip of the shared
  // status poll to "loaded" is the cue that *something* became resident, and it
  // may well be the model the notice claims is missing (loaded from the settings
  // panel, or by a process that isn't Eldrun). One read, then the notice narrows
  // or disappears. `noteResident` is a no-op when nothing moved, so this cannot
  // loop on its own dependencies.
  useEffect(() => {
    if (!installed || status !== "loaded") return;
    if (autoPhase !== "skipped" || autoPending.length === 0) return;
    let cancelled = false;
    invoke<LocalModelInfo[]>("list_ollama_models_detailed")
      .then((all) => {
        if (!cancelled) autoNoteResident(all.filter((m) => m.running).map((m) => m.name));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [installed, status, autoPhase, autoPending, autoNoteResident]);

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
          {/* Pinned title + scrolling region: the unified menu shape (the accent
              rail and the ::before wash live on this element, so it must not be
              the thing that scrolls — see `.menu-scroll-region`). This menu is
              the tallest one in the app: four sections, each row two or three
              lines, so on a short window it ran off the bottom edge. */}
          <div className="tab-new-menu-group-label">{t("localModel.agentsGroup")}</div>
          <div className="menu-scroll-region">
          {agents.map((a) => {
            const isDefault = a.id === defaultAgentCmd;
            return (
              <div key={a.id} className="local-model-agent-row" title={t("localModel.agentInstalled", { label: a.label })}>
                {/* Green lamp mirrors a loaded model: this agent CLI is installed. */}
                <span className="local-model-lamp" aria-hidden="true" />
                <span className="local-model-loaded-name">{a.label}</span>
                <div className="local-model-row-actions">
                  <button
                    type="button"
                    className={`local-model-role-chip${isDefault ? " on" : ""}`}
                    title={t(
                      isDefault ? "localModel.isDefaultAgentTitle" : "localModel.setDefaultAgentTitle",
                      { label: a.label },
                    )}
                    aria-pressed={isDefault}
                    disabled={isDefault}
                    onClick={() => setDefaultAgent(a.id)}
                  >
                    {t("localModel.setDefaultAgent")}
                  </button>
                </div>
              </div>
            );
          })}
          <button className="tab-new-menu-item" onClick={openAgents}>
            <span className="tab-new-menu-dot" style={{ color: "transparent" }}>
              ●
            </span>
            {t("localModel.manageAgents")}
          </button>
          <button className="tab-new-menu-item" onClick={openSkills}>
            <span className="tab-new-menu-dot" style={{ color: "transparent" }}>
              ●
            </span>
            {t("localModel.skillsLibrary")} <UntestedTag />
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
                      {/* Same tags as a "Load into memory" card, and deliberately
                          so: what a model can do belongs to the model, not to
                          whether it happens to be resident, so the two lists must
                          not describe one model differently. What this row adds is
                          the one fact that IS about residency — where it is
                          running. Disk size is the other list's: here the GPU/CPU
                          figure is the live and more useful number. */}
                      <span className="local-model-loaded-badges">
                        {m.parameter_size && <span>{m.parameter_size}</span>}
                        {m.quantization && <span>{m.quantization}</span>}
                        <CaveatChip m={m} t={t} />
                        <CapabilityChips m={m} t={t} />
                        <span className={m.size_vram > 0 ? "gpu" : "cpu"}>
                          {m.size_vram > 0 ? `GPU ${formatBytes(m.size_vram)}` : "CPU"}
                        </span>
                      </span>
                    </button>
                    {/* Task tags: pin this model to a job (autocomplete/grammar/
                        tabs/mail). Several loaded models can each own a different
                        one. A `pending` tag adds "nothing reads this yet" to its
                        tooltip — the chip must not imply a job that doesn't run. */}
                    <div className="local-model-roles">
                      {MODEL_ROLES.map((r) => {
                        const on = roles[r.key] === m.name;
                        const roleLabel = t(r.labelKey);
                        const title = t(on ? "localModel.usedForRole" : "localModel.useForRole", {
                          role: roleLabel.toLowerCase(),
                          name: m.name,
                        });
                        return (
                          <button
                            key={r.key}
                            type="button"
                            className={`local-model-role-chip${on ? " on" : ""}`}
                            title={
                              r.pending ? `${title} — ${t("localModel.roleNotWired")}` : title
                            }
                            onClick={() => toggleRole(r.key, m.name)}
                          >
                            {roleLabel}
                          </button>
                        );
                      })}
                      {/* The row's own two verbs, grouped and right-aligned: the
                          task tags above are a wrapping set, these are a column. */}
                      <div className="local-model-row-actions">
                        {/* Newer manifest in the registry — re-pull it. Shown
                            on a resident model too: being in memory says
                            nothing about the version on disk. */}
                        <UpdateAction
                          update={updates[m.name]}
                          busy={downloads[m.name] !== undefined}
                          onUpdate={() => updateModel(m.name)}
                          t={t}
                        />
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
              {/* The resident model is on the CPU, this machine has a GPU, and
                  the reason is the server's own integrated-GPU gate rather than
                  a model that didn't fit. Raised **only** on `igpu_dropped` —
                  the backend requires four facts to line up before setting it,
                  and blaming a setting for an ordinary out-of-VRAM would send
                  the user to reconfigure a system service for nothing. The fix
                  runs in a visible terminal (it needs a root password, and a
                  command that rewrites a service is one to read first) rather
                  than being applied behind their back. */}
              {gpuStatus?.igpu_dropped && (
                <div className="local-model-igpu-notice">
                  <div className="local-model-igpu-text">
                    {t("localModel.igpuDropped")} <UntestedTag />
                  </div>
                  {gpuStatus.fix_cmd ? (
                    <button
                      type="button"
                      className="tab-new-menu-item local-model-igpu-fix"
                      title={gpuStatus.fix_cmd}
                      onClick={() =>
                        runInstallInTab(
                          t("localModel.igpuFixLabel"),
                          gpuStatus.fix_cmd,
                          gpuStatus.shell_kind as InstallShellKind,
                        )
                      }
                    >
                      {t("localModel.igpuFixAction")}
                    </button>
                  ) : (
                    <div className="local-model-igpu-text">{t("localModel.igpuFixManual")}</div>
                  )}
                </div>
              )}
              {/* Installed-but-not-resident models — click to load into memory. */}
              {available.length > 0 && (
                <>
                  <div className="tab-new-menu-group-label">{t("localModel.loadIntoMemoryGroup")}</div>
                  {available.map((m) => {
                    const st = loads[m.name];
                    return (
                      <div key={m.name} className="local-model-load-row">
                        {/* Line 1 — what the model IS: its name at the left, its
                            dimensions at the right corner. The name takes the
                            slack, so the group is pinned to the card's right edge
                            however long the name is, and PARAMETER SIZE is last in
                            it: the corner itself is the one position that cannot
                            move, so the badge that is compared down the list gets
                            it, and a model missing a quantization or a disk figure
                            shifts only the chips inboard of it. */}
                        <div className="local-model-load-name-line">
                          <span className="tab-new-menu-dot" style={{ color: "transparent" }}>
                            ●
                          </span>
                          <span className="local-model-loaded-name">{m.name}</span>
                          <span className="local-model-load-facts">
                            {m.size > 0 && (
                              <ModelChip
                                label={formatBytes(m.size)}
                                title={t("localModel.diskSizeTitle", { size: formatBytes(m.size) })}
                              />
                            )}
                            {m.quantization && (
                              <ModelChip
                                label={m.quantization}
                                title={t("localModel.quantTitle", { value: m.quantization })}
                              />
                            )}
                            {m.parameter_size && <ModelChip label={m.parameter_size} title={t("localModel.paramTitle", { value: m.parameter_size })} />}
                          </span>
                        </div>
                        {/* Line 2 — what you can DO with it: the tags at the left
                            corner, the verbs at the right. Nothing of variable width
                            precedes the tags, so they start at the card's left edge
                            on every card; the actions are pushed to the right edge by
                            the slack between them. The CAVEAT leads the group for the
                            mirror of line 1's reason — it is the chip worth finding
                            down the list, so it gets the position that cannot move. */}
                        <div className="local-model-load-line">
                          <span className="local-model-load-caps">
                            <CaveatChip m={m} t={t} />
                            <CapabilityChips m={m} t={t} />
                          </span>
                          {/* Armed-for-launch, then the row's verb. */}
                          <div className="local-model-row-actions">
                            {/* Newer manifest in the registry — re-pull it. */}
                            <UpdateAction
                              update={updates[m.name]}
                              busy={downloads[m.name] !== undefined}
                              onUpdate={() => updateModel(m.name)}
                              t={t}
                            />
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
                            {/* Where to load it. Two buttons whenever the
                                machine has a GPU at all, one when it has none —
                                a "GPU" button on a machine with no GPU is a
                                control that can only fail. They are not a
                                preference stored anywhere: which processor
                                suits a model depends on the model and on what
                                else is resident, so it is asked per load, at
                                the moment the answer is known. `auto` (the old
                                single button) stays the no-GPU path and the
                                default everywhere else in the app, because
                                deferring to Ollama's scheduler is a real third
                                answer, not the absence of one. */}
                            {st === "loading" || st === "error" ? (
                              <button
                                type="button"
                                className="local-model-role-chip local-model-load-action"
                                disabled={st === "loading"}
                                title={t(
                                  st === "error"
                                    ? "localModel.failedRetryTitle"
                                    : "localModel.loadIntoMemoryTitle",
                                )}
                                onClick={() => loadIntoMemory(m.name)}
                              >
                                {st === "loading" ? t("common.loading") : t("localModel.failed")}
                              </button>
                            ) : gpuStatus?.gpu_present ? (
                              <>
                                <button
                                  type="button"
                                  className="local-model-role-chip local-model-load-action"
                                  title={t("localModel.loadOnGpuTitle", { name: m.name })}
                                  onClick={() => loadIntoMemory(m.name, "gpu")}
                                >
                                  {t("localModel.loadOnGpu")}
                                </button>
                                <button
                                  type="button"
                                  className="local-model-role-chip local-model-load-action"
                                  title={t("localModel.loadOnCpuTitle", { name: m.name })}
                                  onClick={() => loadIntoMemory(m.name, "cpu")}
                                >
                                  {t("localModel.loadOnCpu")}
                                </button>
                              </>
                            ) : (
                              <button
                                type="button"
                                className="local-model-role-chip local-model-load-action"
                                title={t("localModel.loadIntoMemoryTitle")}
                                onClick={() => loadIntoMemory(m.name)}
                              >
                                {t("ollama.load")}
                              </button>
                            )}
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
          {/* The menu's one outbound request, and the reason it is a button
              rather than part of the hover: Ollama has no "is there a newer
              version" API, so a check is a manifest-digest comparison against
              the registry — one HEAD per installed model. Cheap, but network,
              so it happens when it is asked for and at no other time. Verdicts
              land on the rows above; nothing appears against a model that is
              already current, because "up to date" is a claim with a shelf
              life and a stale tick is worse than no tick. */}
          {installed && models.length > 0 && (
            <div className="local-model-check-row">
              <button
                className="tab-new-menu-item"
                disabled={checkingUpdates}
                title={t("localModel.checkUpdatesTitle")}
                onClick={checkUpdates}
              >
                <span className="tab-new-menu-dot" style={{ color: "transparent" }}>
                  ●
                </span>
                {checkingUpdates ? t("localModel.checkingUpdates") : t("localModel.checkUpdates")}
                {/* The click must always report back — but only where nothing
                    else does. A *found* update now shows itself: the green
                    version pair beside this label, and an Update chip on each
                    model's own row, so an "N available" count here was the same
                    news a third time and the one number that could disagree with
                    the two things it was counting. What is left is the pair of
                    results that have no other surface: a clean check (every row
                    stays silent when it is current, so without this a good
                    result was indistinguishable from a dead button) and a failed
                    one, which speaks in the reason the check itself gave. */}
                {!checkingUpdates && checkResult && !(checkResult.ok && checkResult.updates > 0) && (
                  <span className="local-model-update-note">
                    {checkResult.ok ? t("localModel.updatesNone") : checkResult.reason}
                  </span>
                )}
                <UntestedTag />
              </button>
              {/* The version pair, and the whole reason this row is a `div` with
                  two children rather than one button: what the check found is
                  `v0.14.3 → v0.15.2`, and the *new number is the upgrade*. A
                  separate "Update" chip repeated the same fact in a second
                  place, and a control nested inside the check button would be a
                  button within a button — invalid markup, and one click landing
                  on two actions. Sibling, so the arrow-and-number is a real
                  button with a real hit area. It sits outside the check button
                  on the current path too: the row's `margin-left: auto` puts it
                  in the same place either way, and a version that is sometimes
                  part of the button's label and sometimes not would move.

                  The sentence the retired notice carried (a server a few minor
                  versions back is missing whole *features* rather than weights —
                  `ollama launch`, the only wiring that stands up an
                  Anthropic-compatible endpoint for Claude Code, does not exist
                  before v0.15) is the tooltip, together with what the click
                  does. Gated on `update_available`, i.e. both versions parsed
                  and `latest` genuinely newer — never on `latest` alone. */}
              {version?.current &&
                (version.update_available ? (
                  <button
                    type="button"
                    className="local-model-version-note has-update"
                    title={`${t("localModel.ollamaUpdateSentence", {
                      latest: version.latest,
                      current: version.current,
                    })} — ${t("localModel.ollamaUpgradeTitle", { latest: version.latest })}`}
                    onClick={upgradeOllama}
                  >
                    {t("localModel.ollamaVersion", { current: version.current })}
                    <span className="local-model-version-arrow" aria-hidden="true">
                      →
                    </span>
                    <span className="local-model-version-new">
                      {t("localModel.ollamaVersionLatest", { latest: version.latest })}
                    </span>
                  </button>
                ) : (
                  <span className="local-model-version-note">
                    {version.latest
                      ? t("localModel.ollamaVersionCurrent", { current: version.current })
                      : t("localModel.ollamaVersion", { current: version.current })}
                  </span>
                ))}
            </div>
          )}
          {/* The upgrade's other half: what happened to the models it evicted.
              Directly under the row that started it, and it reports every phase
              rather than only the failures — a restart the user is waiting
              through, a load they did not ask for and a load that did not
              happen are three things they cannot see from anywhere else (the
              server is machine-wide, the terminal tab shows the installer, not
              Ollama's memory). Toned like the autoload notice it borrows its
              chrome from: amber for the wait that ran out, red for a model that
              would not come back. */}
          {showRestoreNote && (
            <div
              className={`local-model-autostart-note${
                restorePhase === "timeout" ? " saver" : restorePhase === "error" ? " failed" : ""
              }`}
            >
              <button
                type="button"
                className="local-model-autostart-dismiss"
                title={t("localModel.autostartDismiss")}
                aria-label={t("localModel.autostartDismiss")}
                onClick={restoreDismiss}
              >
                ✕
              </button>
              <div className="local-model-autostart-text">
                <span className="local-model-autostart-sentence">{restoreSentence}</span>
                <UntestedTag />
              </div>
              {/* Waiting is the one phase with something to *stop*; the two
                  that ended without the models being back are the ones with
                  something to retry. A finished restore offers neither — the
                  models are in memory, and the note is only there to say so. */}
              {restorePhase === "waiting" && (
                <div className="local-model-autostart-actions">
                  <button
                    type="button"
                    className="local-model-role-chip"
                    title={t("localModel.upgradeRestoreCancelTitle")}
                    onClick={restoreCancel}
                  >
                    {t("localModel.upgradeRestoreCancel")}
                  </button>
                </div>
              )}
              {(restorePhase === "timeout" || restorePhase === "error") && (
                <div className="local-model-autostart-actions">
                  <button
                    type="button"
                    className="local-model-role-chip"
                    title={t("localModel.upgradeRestoreNowTitle")}
                    onClick={() => void restoreNow()}
                  >
                    {t("localModel.upgradeRestoreNow")}
                  </button>
                </div>
              )}
            </div>
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
        </div>
      )}
    </div>
  );
}
