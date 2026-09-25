/**
 * The Models & agents overlay (`models/ModelsOverlay`): the room the header's
 * processor-chip button opens. Settings' panels and the skills library are
 * stubbed — what is locked in here is the overlay's own contract:
 *
 *  - closed, it renders nothing; open, it is a labelled dialog;
 *  - four tabs; a visited pane stays mounted (install logs are component
 *    state) and is `hidden` when not shown;
 *  - Escape closes unless something inside took it, the root console is up on
 *    top of it, or the key was aimed outside its frame; only a press on the
 *    backdrop itself dismisses;
 *  - `openOverlay(tab)` deep-links, and its own doors (Manage local models…,
 *    the autostart notice's "Ollama…") switch to the Ollama tab — never out
 *    to Settings;
 *  - a pull started before it opened already shows on the Local models tab
 *    (the shared `stores/agents/ollamaActivity`), which reads the models but
 *    not the agents it doesn't show, and lays out as the dropdown does:
 *    the Local Models band, then Machine;
 *  - the Agents tab re-reads which CLIs the root MCP server is wired to when
 *    the agent registry changes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act, waitFor, within } from "@testing-library/react";

const h = vi.hoisted(() => ({
  skillsVisible: [] as boolean[],
  agentsPanelMounts: 0,
  machine: { supported: false } as Record<string, unknown>,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../components/layout/SettingsSubPanels", async () => {
  const { useEffect } = await import("react");
  return {
    AgentsPanel: ({ installedExtras }: { installedExtras?: (a: unknown) => unknown }) => {
      useEffect(() => {
        h.agentsPanelMounts += 1;
      }, []);
      return (
        <div data-testid="agents-panel">
          {installedExtras?.({ id: "claude", label: "Claude Code", bin: "claude", installed: true }) as never}
        </div>
      );
    },
    OllamaPanel: () => <div data-testid="ollama-panel" />,
  };
});
vi.mock("../../components/skills/SkillsLibraryView", () => ({
  SkillsLibraryView: ({ visible }: { visible?: boolean }) => {
    h.skillsVisible.push(visible !== false);
    return <div data-testid="skills-view" />;
  },
}));

import { invoke } from "@tauri-apps/api/core";
import { ModelsOverlayHost } from "../../components/models/ModelsOverlay";
import { useModelsOverlayStore } from "../../stores/modelsOverlay";
import {
  __resetOllamaActivityForTests,
  useOllamaActivityStore,
} from "../../stores/agents/ollamaActivity";
import { notifyAgentRegistryChanged } from "../../lib/agents/agentRegistry";
import { resetOllamaStatusPoller } from "../../lib/ollamaStatus";
import { useSettingsStore } from "../../stores/settings";
import { useRootOverlayStore } from "../../stores/rootOverlay";
import { resetOllamaAutoload, useOllamaAutoloadStore } from "../../stores/agents/ollamaAutoload";

const invokeMock = vi.mocked(invoke);
const calls = (cmd: string) => invokeMock.mock.calls.filter(([c]) => c === cmd);

beforeEach(() => {
  // The tab and the frame persist; keep each test from reading the last one's.
  localStorage.clear();
  h.skillsVisible.length = 0;
  h.agentsPanelMounts = 0;
  h.machine = { supported: false };
  useRootOverlayStore.setState({ open: false });
  invokeMock.mockReset();
  invokeMock.mockImplementation(((cmd: string) => {
    if (cmd === "root_mcp_status") return Promise.resolve({ wired_clis: ["claude"] });
    if (cmd === "list_ollama_models_detailed")
      return Promise.resolve([
        {
          name: "qwen:7b",
          parameter_size: "7B",
          quantization: "Q4",
          running: true,
          size_vram: 0,
          size: 1,
          capabilities: ["completion", "tools"],
        },
      ]);
    if (cmd === "list_agents") return Promise.resolve([]);
    if (cmd === "ollama_status") return Promise.resolve("loaded");
    if (cmd === "machine_load_snapshot") return Promise.resolve(h.machine);
    if (cmd === "gpu_memory_snapshot") return Promise.resolve([]);
    return Promise.resolve(null);
  }) as never);
  __resetOllamaActivityForTests();
  resetOllamaStatusPoller();
  resetOllamaAutoload();
  useModelsOverlayStore.setState({ open: false, tab: "agents" });
  useSettingsStore.setState({ settings: { ollama_model: "qwen:7b" } } as never);
});

afterEach(() => {
  cleanup();
  resetOllamaStatusPoller();
});

const open = (tab?: "agents" | "models" | "ollama" | "skills") =>
  act(() => useModelsOverlayStore.getState().openOverlay(tab));

const pane = (id: string) => document.getElementById(`models-overlay-pane-${id}`);

describe("ModelsOverlay", () => {
  it("renders nothing while closed and a labelled dialog when open", () => {
    const { container } = render(<ModelsOverlayHost />);
    expect(container.innerHTML).toBe("");
    open();
    expect(screen.getByRole("dialog", { name: "Models & agents" })).toBeTruthy();
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual([
      "Agents & CLIs",
      "Local models",
      "Ollama",
      expect.stringContaining("Skills"),
    ]);
  });

  it("switches tabs and keeps a visited pane mounted, hidden", () => {
    render(<ModelsOverlayHost />);
    open("agents");
    expect(pane("agents")?.hidden).toBe(false);
    expect(pane("ollama")).toBeNull();
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Ollama" }), { button: 0 });
    expect(pane("ollama")?.hidden).toBe(false);
    expect(pane("agents")?.hidden).toBe(true);
    expect(screen.getByRole("tab", { name: "Ollama" }).getAttribute("aria-selected")).toBe("true");
    // Back again: the agents pane was kept, never remounted.
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Agents & CLIs" }), { button: 0 });
    expect(pane("agents")?.hidden).toBe(false);
    expect(h.agentsPanelMounts).toBe(1);
    expect(useModelsOverlayStore.getState().tab).toBe("agents");
    expect(localStorage.getItem("eldrun.modelsOverlayTab")).toBe("agents");
  });

  it("activates a tab from the keyboard and roves focus with the arrows", () => {
    render(<ModelsOverlayHost />);
    open("agents");
    const agentsTab = screen.getByRole("tab", { name: "Agents & CLIs" });
    expect(document.activeElement).toBe(agentsTab);
    fireEvent.keyDown(agentsTab, { key: "ArrowRight" });
    const modelsTab = screen.getByRole("tab", { name: "Local models" });
    expect(document.activeElement).toBe(modelsTab);
    expect(modelsTab.tabIndex).toBe(0);
    expect(agentsTab.tabIndex).toBe(-1);
    // Arrowing moves focus only; Enter activates.
    expect(useModelsOverlayStore.getState().tab).toBe("agents");
    fireEvent.keyDown(modelsTab, { key: "Enter" });
    expect(useModelsOverlayStore.getState().tab).toBe("models");
  });

  it("closes on Escape unless something inside already took it", () => {
    render(<ModelsOverlayHost />);
    open();
    const ev = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    ev.preventDefault();
    act(() => {
      window.dispatchEvent(ev);
    });
    expect(useModelsOverlayStore.getState().open).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useModelsOverlayStore.getState().open).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("leaves an Escape aimed outside its frame, or at the root console on top, alone", () => {
    render(
      <>
        <ModelsOverlayHost />
        <button type="button">elsewhere</button>
      </>,
    );
    open();
    // Focus in something outside the frame (the root console's chrome).
    fireEvent.keyDown(screen.getByRole("button", { name: "elsewhere" }), { key: "Escape" });
    expect(useModelsOverlayStore.getState().open).toBe(true);
    // The root console open above it: its Escape, not ours — even from inside.
    act(() => useRootOverlayStore.setState({ open: true }));
    fireEvent.keyDown(screen.getByRole("tab", { name: "Agents & CLIs" }), { key: "Escape" });
    expect(useModelsOverlayStore.getState().open).toBe(true);
    act(() => useRootOverlayStore.setState({ open: false }));
    // Inside the frame (or on <body>) it is ours.
    fireEvent.keyDown(screen.getByRole("tab", { name: "Agents & CLIs" }), { key: "Escape" });
    expect(useModelsOverlayStore.getState().open).toBe(false);
  });

  it("moves strip focus to the ends with Home / End", () => {
    render(<ModelsOverlayHost />);
    open("agents");
    fireEvent.keyDown(screen.getByRole("tab", { name: "Agents & CLIs" }), { key: "End" });
    expect(document.activeElement?.id).toBe("models-overlay-tab-skills");
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement?.id).toBe("models-overlay-tab-agents");
    expect(useModelsOverlayStore.getState().tab).toBe("agents");
  });

  it("closes on a backdrop press, not on one inside the window", () => {
    const { container } = render(<ModelsOverlayHost />);
    open();
    fireEvent.mouseDown(screen.getByRole("dialog"));
    expect(useModelsOverlayStore.getState().open).toBe(true);
    fireEvent.mouseDown(container.querySelector(".models-overlay-backdrop")!);
    expect(useModelsOverlayStore.getState().open).toBe(false);
  });

  it("deep-links to a tab", () => {
    render(<ModelsOverlayHost />);
    open("ollama");
    expect(screen.getByTestId("ollama-panel")).toBeTruthy();
    expect(pane("agents")).toBeNull();
    expect(screen.getByRole("tab", { name: "Ollama" }).getAttribute("aria-selected")).toBe("true");
  });

  it("switches to the Ollama tab from its own doors, never out to Settings", async () => {
    useOllamaActivityStore.setState({ installed: true });
    useOllamaAutoloadStore.setState({
      phase: "skipped",
      pending: ["llama:8b"],
      models: ["llama:8b"],
      dismissed: false,
    });
    const spy = vi.spyOn(window, "dispatchEvent");
    try {
      render(<ModelsOverlayHost />);
      open("models");
      fireEvent.click(await within(pane("models")!).findByText("Manage local models…"));
      expect(useModelsOverlayStore.getState().tab).toBe("ollama");
      expect(pane("ollama")?.hidden).toBe(false);
      expect(screen.getByTestId("ollama-panel")).toBeTruthy();
      // Back to Local models: the autostart notice's chip is the same door.
      fireEvent.mouseDown(screen.getByRole("tab", { name: "Local models" }), { button: 0 });
      expect(pane("models")?.hidden).toBe(false);
      fireEvent.click(await within(pane("models")!).findByText("Ollama…"));
      expect(useModelsOverlayStore.getState()).toMatchObject({ open: true, tab: "ollama" });
      expect(pane("ollama")?.hidden).toBe(false);
      const settingsEvents = spy.mock.calls.filter(([e]) => (e as Event).type === "eldrun:open-settings");
      expect(settingsEvents).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("points aria-controls only at panes that are rendered", () => {
    render(<ModelsOverlayHost />);
    open("agents");
    const ollamaTab = screen.getByRole("tab", { name: "Ollama" });
    expect(screen.getByRole("tab", { name: "Agents & CLIs" }).getAttribute("aria-controls")).toBe(
      "models-overlay-pane-agents",
    );
    expect(ollamaTab.hasAttribute("aria-controls")).toBe(false);
    fireEvent.mouseDown(ollamaTab, { button: 0 });
    expect(ollamaTab.getAttribute("aria-controls")).toBe("models-overlay-pane-ollama");
  });

  it("passes the skills library its visibility", () => {
    render(<ModelsOverlayHost />);
    open("skills");
    expect(h.skillsVisible[h.skillsVisible.length - 1]).toBe(true);
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Ollama" }), { button: 0 });
    expect(h.skillsVisible[h.skillsVisible.length - 1]).toBe(false);
  });

  it("shows a pull started before it opened on the Local models tab", async () => {
    useOllamaActivityStore.setState({ installed: true, downloads: { "mistral:7b": { pct: 40 } } });
    render(<ModelsOverlayHost />);
    open("models");
    expect(await screen.findByText("40%")).toBeTruthy();
    expect(screen.getByText("mistral:7b")).toBeTruthy();
    // Becoming visible reads the list, as a hover does.
    expect(await screen.findByText("qwen:7b")).toBeTruthy();
    expect(calls("list_ollama_models_detailed").length).toBeGreaterThan(0);
    // …but not the agents: this tab doesn't show them.
    expect(calls("list_agents")).toHaveLength(0);
  });

  it("lays the Local models tab out as the dropdown: Local Models band, then Machine", async () => {
    h.machine = {
      supported: true,
      cpu_percent: 10,
      num_cores: 8,
      load_avg: [0.5, 0.5, 0.5],
      mem_total_bytes: 16e9,
      mem_used_bytes: 4e9,
      swap_total_bytes: 0,
      swap_used_bytes: 0,
      cpu_temp_c: null,
    };
    useOllamaActivityStore.setState({ installed: true });
    render(<ModelsOverlayHost />);
    open("models");
    await screen.findByText("qwen:7b");
    const machine = await screen.findByText("Machine");
    const bands = [...pane("models")!.querySelectorAll(".tab-new-menu-group-label")].map((el) => ({
      text: el.textContent,
      sub: el.classList.contains("is-sub"),
    }));
    expect(bands[0]).toEqual({ text: "Local Models", sub: false });
    expect(bands.find((b) => b.text === "Running models")?.sub).toBe(true);
    // Machine comes last, after the models' own sub-bands.
    expect(bands[bands.length - 1].text).toBe("Machine");
    expect(machine).toBeTruthy();
  });

  it("re-reads the wired CLIs when the agent registry changes", async () => {
    render(<ModelsOverlayHost />);
    open("agents");
    await waitFor(() => expect(calls("root_mcp_status")).toHaveLength(1));
    // The installed card carries the dropdown's chips, MCP included once wired.
    expect(await screen.findByRole("button", { name: "MCP" })).toBeTruthy();
    act(() => notifyAgentRegistryChanged());
    await waitFor(() => expect(calls("root_mcp_status")).toHaveLength(2));
  });
});
