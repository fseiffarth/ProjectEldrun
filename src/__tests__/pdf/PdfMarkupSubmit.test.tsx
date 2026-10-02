/**
 * The desktop markup mode's Submit (`usePdfMarkup` + `PdfMarkupBar`,
 * `docs/pdf_markup_rounds_plan.md` §2.6): the marks go to `pdf_markup_submit`,
 * the prompt it answers is queued for an agent tab of the project and held for
 * the CLI's own queue (`holdPhonePrompt`) — and only then do the marks move to
 * the sent side. Without an agent tab there is nothing to send to; a prompt the
 * scheduler refuses leaves the marks unsent.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  queuePromptForTab: vi.fn(),
  holdPhonePrompt: vi.fn(),
  loadLayer: vi.fn(),
  saveLayer: vi.fn(async () => true),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../../stores/agents/agentPrompts", () => ({ queuePromptForTab: mocks.queuePromptForTab }));
vi.mock("../../lib/agents/phoneHolds", () => ({ holdPhonePrompt: mocks.holdPhonePrompt }));
vi.mock("../../../mobile-web/src/markup/store", async (original) => ({
  ...(await original<typeof import("../../../mobile-web/src/markup/store")>()),
  loadLayer: mocks.loadLayer,
  saveLayer: mocks.saveLayer,
}));
vi.mock("../../../mobile-web/src/markup/rasterize", async (original) => ({
  ...(await original<typeof import("../../../mobile-web/src/markup/rasterize")>()),
  layerPng: vi.fn(async () => new Blob(["png"], { type: "image/png" })),
}));

import { PdfMarkupBar } from "../../components/embed/pdf/PdfMarkupBar";
import { usePdfMarkup } from "../../components/embed/pdf/usePdfMarkup";
import { useActivityStore } from "../../stores/activity";
import { useSettingsStore } from "../../stores/settings";
import type { Settings } from "../../types";
import { DEFAULT_PDF_MARKUP_APPLY } from "../../lib/viewers/pdfMarkup";
import { SETTLE_MS } from "../../../mobile-web/src/markup/submitState";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { EMPTY_LAYER, addMark, type Layer } from "../../../mobile-web/src/markup/layer";
import { BRAND, NAMES } from "../../lib/brand";

const PATH = "/home/u/paper/paper.pdf";
const SIZE: [number, number] = [595, 842];
const STROKE = { kind: "ink" as const, color: "red" as const, width: 1.7, points: [[10, 10, 0.5], [40, 30, 0.5]] as [number, number, number][] };
const LAYER = addMark(EMPTY_LAYER, 1, SIZE, STROKE);

function agentTab(key: string, scheduleTargetId: string, label: string): TabEntry {
  return { key, label, cmd: "claude", cwd: "/home/u/paper", kind: "agent", scheduleTargetId } as TabEntry;
}

function Harness() {
  const markup = usePdfMarkup({
    projectId: "p1",
    scope: "p1",
    path: PATH,
    active: true,
    visible: true,
    pageCount: 3,
    docSize: 9_000,
    docVersion: 0,
  });
  return <PdfMarkupBar markup={markup} page={1} onReload={() => {}} onDone={() => {}} />;
}

const submitButton = () => screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement;
const lastSaved = (): Layer | undefined => {
  const calls = mocks.saveLayer.mock.calls as unknown as [string, Layer][];
  return calls[calls.length - 1]?.[1];
};

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "file_mtime") return 1_790_000_000;
    if (command === "pdf_markup_submit") return { prompt: "Look at the marked copy.", marked: `${NAMES.inboxDir}/x-paper-marked.pdf` };
    return null;
  });
  mocks.queuePromptForTab.mockReset();
  mocks.queuePromptForTab.mockResolvedValue({ pruned: 0, id: "sched-1" });
  mocks.holdPhonePrompt.mockReset();
  mocks.loadLayer.mockReset();
  mocks.loadLayer.mockResolvedValue({ layer: LAYER, fingerprint: { size: 9_000, modified: 1_790_000_000 }, saved: 1 });
  mocks.saveLayer.mockClear();
  useTabsStore.setState({ tabsByScope: { p1: [agentTab("t1", "s1", "Claude")] } });
  useActivityStore.setState({ busyByTab: {}, attentionByTab: {} });
  useSettingsStore.setState({ settings: null });
});
afterEach(() => cleanup());

describe("desktop markup Submit", () => {
  it("bakes the marks, queues the prompt for the agent tab and holds it for its queue", async () => {
    render(<Harness />);
    await waitFor(() => expect(submitButton().disabled).toBe(false));
    expect(screen.getByText("→ Claude")).toBeTruthy();
    fireEvent.click(submitButton());
    await waitFor(() => expect(mocks.holdPhonePrompt).toHaveBeenCalledWith("sched-1"));
    const call = mocks.invoke.mock.calls.find(([command]) => command === "pdf_markup_submit")!;
    expect(call[1]).toEqual({
      projectId: "p1",
      path: PATH,
      pages: [{ n: 1, size: SIZE, marks: [STROKE], layerPng: btoa("png") }],
    });
    expect(mocks.queuePromptForTab).toHaveBeenCalledWith("p1", "s1", "Look at the marked copy.");
    // Queued first, held second — the hold names the schedule just made.
    expect(mocks.queuePromptForTab.mock.invocationCallOrder[0]).toBeLessThan(mocks.holdPhonePrompt.mock.invocationCallOrder[0]);
    // The round's marks moved to the sent side and the record keeps them.
    await waitFor(() => expect(lastSaved()).toEqual({ pages: {}, sent: { pages: LAYER.pages, rounds: 1 } }));
    expect(screen.getByText("Sent — waiting for the agent")).toBeTruthy();
    expect(submitButton().disabled).toBe(true);
  });

  it("sends the desktop's own Mark up prompt setting with the marks", async () => {
    useSettingsStore.setState({ settings: { ...useSettingsStore.getState().settings, pdf_markup_instruction: "  Fix only typos.  " } as Settings });
    render(<Harness />);
    await waitFor(() => expect(submitButton().disabled).toBe(false));
    fireEvent.click(submitButton());
    await waitFor(() => expect(mocks.holdPhonePrompt).toHaveBeenCalled());
    const call = mocks.invoke.mock.calls.find(([command]) => command === "pdf_markup_submit")!;
    expect(call[1]).toMatchObject({ instruction: "Fix only typos." });
  });

  it("offers Make these changes once the agent is done, queues the follow-up and offers it once", async () => {
    render(<Harness />);
    await waitFor(() => expect(submitButton().disabled).toBe(false));
    fireEvent.click(submitButton());
    await waitFor(() => expect(mocks.holdPhonePrompt).toHaveBeenCalledWith("sched-1"));
    expect(screen.queryByRole("button", { name: /Make these changes/ })).toBeNull();
    act(() => useActivityStore.setState({ busyByTab: { "p1:t1": true }, attentionByTab: {} }));
    expect(await screen.findByText("Agent is working…")).toBeTruthy();
    act(() => useActivityStore.setState({ busyByTab: {}, attentionByTab: {} }));
    const apply = await screen.findByRole("button", { name: /Make these changes/ }, { timeout: SETTLE_MS + 2_000 });
    mocks.queuePromptForTab.mockResolvedValueOnce({ pruned: 0, id: "sched-2" });
    fireEvent.click(apply);
    await waitFor(() => expect(mocks.holdPhonePrompt).toHaveBeenCalledWith("sched-2"));
    expect(mocks.queuePromptForTab).toHaveBeenLastCalledWith("p1", "s1", DEFAULT_PDF_MARKUP_APPLY);
    expect(await screen.findByText("Sent — waiting for the agent")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Make these changes/ })).toBeNull();
  });

  it("follows the agent tab: working at Submit shows it at work", async () => {
    useActivityStore.setState({ busyByTab: { "p1:t1": true }, attentionByTab: {} });
    render(<Harness />);
    await waitFor(() => expect(submitButton().disabled).toBe(false));
    fireEvent.click(submitButton());
    expect(await screen.findByText("Agent is working…")).toBeTruthy();
    act(() => useActivityStore.setState({ busyByTab: {}, attentionByTab: { "p1:t1": "decision" } }));
    expect(await screen.findByText("The agent is asking something — answer in its tab")).toBeTruthy();
  });

  it("keeps Submit off with a hint when the project has no agent tab", async () => {
    useTabsStore.setState({ tabsByScope: { p1: [] } });
    render(<Harness />);
    await waitFor(() => expect(mocks.loadLayer).toHaveBeenCalled());
    expect(screen.getAllByText("Open an agent tab in this project to send").length).toBeGreaterThan(0);
    expect(submitButton().disabled).toBe(true);
    fireEvent.click(submitButton());
    expect(mocks.invoke.mock.calls.some(([command]) => command === "pdf_markup_submit")).toBe(false);
  });

  it("leaves the marks unsent when the prompt is too long to queue", async () => {
    mocks.queuePromptForTab.mockRejectedValue(new Error("message_too_long"));
    render(<Harness />);
    await waitFor(() => expect(submitButton().disabled).toBe(false));
    fireEvent.click(submitButton());
    expect(await screen.findByText(/the prompt could not be queued \(the prompt is longer than an agent message may be\)/)).toBeTruthy();
    expect(mocks.holdPhonePrompt).not.toHaveBeenCalled();
    // Nothing moved: no record with sent marks, and Submit is there again.
    expect(mocks.saveLayer.mock.calls.length).toBe(0);
    expect(submitButton().disabled).toBe(false);
  });

  it("says why the backend refused, and sends nothing on", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "file_mtime") return 1_790_000_000;
      if (command === "pdf_markup_submit") throw "hidden_path";
      return null;
    });
    render(<Harness />);
    await waitFor(() => expect(submitButton().disabled).toBe(false));
    fireEvent.click(submitButton());
    expect(await screen.findByText(new RegExp(`Nothing was sent: PDFs in \\.git, \\.${BRAND.slug} or \\.env folders can't be marked up`))).toBeTruthy();
    expect(mocks.queuePromptForTab).not.toHaveBeenCalled();
  });

  it("sends to the tab picked when the project has several", async () => {
    useTabsStore.setState({ tabsByScope: { p1: [agentTab("t1", "s1", "Claude"), agentTab("t2", "s2", "Codex")] } });
    render(<Harness />);
    await waitFor(() => expect(submitButton().disabled).toBe(false));
    const picker = screen.getByRole("combobox") as HTMLSelectElement;
    expect([...picker.options].map((option) => option.textContent)).toEqual(["Claude", "Codex"]);
    fireEvent.change(picker, { target: { value: "s2" } });
    fireEvent.click(submitButton());
    await waitFor(() => expect(mocks.queuePromptForTab).toHaveBeenCalledWith("p1", "s2", "Look at the marked copy."));
  });

  it("falls back to another tab when the chosen one closes", async () => {
    useTabsStore.setState({ tabsByScope: { p1: [agentTab("t1", "s1", "Claude"), agentTab("t2", "s2", "Codex")] } });
    render(<Harness />);
    await waitFor(() => expect(submitButton().disabled).toBe(false));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "s2" } });
    act(() => useTabsStore.setState({ tabsByScope: { p1: [agentTab("t1", "s1", "Claude")] } }));
    expect(await screen.findByText("→ Claude")).toBeTruthy();
    fireEvent.click(submitButton());
    await waitFor(() => expect(mocks.queuePromptForTab).toHaveBeenCalledWith("p1", "s1", "Look at the marked copy."));
  });
});
