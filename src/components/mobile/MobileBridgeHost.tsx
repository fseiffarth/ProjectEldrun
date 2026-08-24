import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useProjectsStore } from "../../stores/projects";
import {
  RESUMABLE_AGENTS,
  useTabsStore,
  type TabEntry,
} from "../../stores/tabs";
import { useSettingsStore } from "../../stores/settings";
import { resolveProjectDirectory } from "../../types";
import {
  AGENT_ITEMS,
  SHELL_ITEMS,
  buildStaticTabSpec,
  customAgentToItem,
  type StaticMenuItem,
} from "../tabs/newTabItems";
import { supportsAgentMode, withAgentMode, type AgentMode } from "../tabs/agentModes";
import { useT } from "../../lib/i18n";

const MOBILE_DESKTOP_EVENT = "eldrun-mobile-desktop-request";

interface AgentInfo { bin: string; installed: boolean }
interface CatalogAgent { id: string; label: string; modes: string[] }
interface CreateRequest {
  project_id: string;
  kind: "shell" | "agent";
  agent_id?: string;
  mode?: string;
  idempotency_key: string;
}
type DesktopRequest =
  | { type: "catalog"; request_id: string }
  | { type: "create"; request_id: string; request: CreateRequest };
type DesktopResponse =
  | { status: "catalog"; agents: CatalogAgent[] }
  | { status: "created"; tmux_session: string }
  | { status: "error"; code: string; message: string };

interface CatalogChoice { public: CatalogAgent; item: StaticMenuItem }

async function agentChoices(): Promise<CatalogChoice[]> {
  const settings = useSettingsStore.getState().settings;
  const installed = new Set(
    (await invoke<AgentInfo[]>("list_agents"))
      .filter((entry) => entry.installed)
      .map((entry) => entry.bin),
  );
  const disabled = new Set(settings?.disabled_agents ?? []);
  const builtins = AGENT_ITEMS.filter(
    (item) =>
      installed.has(item.cmd) &&
      !disabled.has(item.cmd) &&
      item.cmd in RESUMABLE_AGENTS,
  );
  const custom = (settings?.custom_agents ?? [])
    .filter((item) => item.resumeArgs?.length)
    .map(customAgentToItem);
  const customFound = custom.length
    ? new Set(await invoke<string[]>("probe_binaries", { bins: custom.map((item) => item.cmd) }))
    : new Set<string>();
  const items = [...builtins, ...custom.filter((item) => customFound.has(item.cmd))];
  return Promise.all(
    items.map(async (item) => ({
      item,
      public: {
        id: await invoke<string>("mobile_opaque_id", { domain: "agent", value: item.cmd }),
        label: item.label,
        modes:
          settings?.agent_mode_toggle && supportsAgentMode(item.cmd)
            ? ["plan", "auto"]
            : [],
      },
    })),
  );
}

async function create(request: CreateRequest, t: ReturnType<typeof useT>): Promise<DesktopResponse> {
  const projects = useProjectsStore.getState();
  const project = projects.projects.find((entry) => entry.id === request.project_id);
  if (!project || project.remote || project.sandbox?.enabled || project.vm?.enabled || !project.eldrun_mobile_access) {
    return { status: "error", code: "project_ineligible", message: "Project is not enabled for Mobile access" };
  }
  const cwd = resolveProjectDirectory(project);
  if (!cwd) return { status: "error", code: "project_ineligible", message: "Project folder is unavailable" };
  await projects.activateProject(project.id);
  const requestHash = await invoke<string>("mobile_opaque_id", {
    domain: "request",
    value: request.idempotency_key,
  });

  let spec: Omit<TabEntry, "key">;
  if (request.kind === "shell") {
    if (request.agent_id || request.mode) {
      return { status: "error", code: "invalid_request", message: "Shell requests cannot name an agent or mode" };
    }
    spec = buildStaticTabSpec(SHELL_ITEMS[0], cwd, project.name, t);
  } else {
    const choices = await agentChoices();
    const choice = choices.find((entry) => entry.public.id === request.agent_id);
    if (!choice) return { status: "error", code: "unknown_agent", message: "Agent is unavailable" };
    if (request.mode && !choice.public.modes.includes(request.mode)) {
      return { status: "error", code: "unsupported_mode", message: "Agent mode is unavailable" };
    }
    spec = buildStaticTabSpec(choice.item, cwd, project.name, t);
    if (request.mode) {
      spec = {
        ...spec,
        args: withAgentMode(spec.cmd, spec.args ?? [], request.mode as AgentMode),
        agentMode: request.mode as AgentMode,
      };
    }
  }
  let created: TabEntry;
  try {
    created = await useTabsStore.getState().hydrateThenCreateInScope({
      scope: project.id,
      cwd,
      localFile: project.local_file,
      requestHash,
      spec,
    });
  } catch (error) {
    return { status: "error", code: "persist_failed", message: String(error) };
  }
  if (!created.tmuxSession) {
    return { status: "error", code: "launch_failed", message: "Persistent terminal session was not created" };
  }
  return { status: "created", tmux_session: created.tmuxSession };
}

let mutationQueue: Promise<unknown> = Promise.resolve();

export function MobileBridgeHost() {
  const t = useT();
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<DesktopRequest>(MOBILE_DESKTOP_EVENT, (event) => {
      const request = event.payload;
      const run = async () => {
        let response: DesktopResponse;
        try {
          response = request.type === "catalog"
            ? { status: "catalog", agents: (await agentChoices()).map((entry) => entry.public) }
            : await create(request.request, t);
        } catch (error) {
          response = { status: "error", code: "desktop_error", message: String(error) };
        }
        if (!disposed) {
          await invoke("mobile_desktop_respond", {
            requestId: request.request_id,
            response,
          }).catch(() => {});
        }
      };
      if (request.type === "create") {
        mutationQueue = mutationQueue.then(run, run);
      } else {
        void run();
      }
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [t]);
  return null;
}
