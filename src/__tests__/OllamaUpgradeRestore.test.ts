/**
 * Putting the models back after an Ollama upgrade (`stores/ollamaUpgrade`).
 *
 * The upgrade runs in a terminal tab, so there is no completion callback to
 * hang this on — the restart is *observed*, by polling the local version. That
 * makes three rules worth pinning, because each fails silently if it breaks:
 * a **changed** version is the only signal that starts the reload (an
 * unreadable one is the binary mid-replacement, not an answer), the wait is
 * **bounded** and running out is a reported state with a retry rather than a
 * silent give-up, and an upgrade with **nothing resident** starts no watcher at
 * all — this restores what was there, it never invents a load.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

const versionStatus = vi.fn();
vi.mock("../lib/localDrivers", () => ({
  ollamaVersionStatus: (...a: unknown[]) => versionStatus(...a),
}));

import { useOllamaUpgradeStore, resetOllamaUpgrade } from "../stores/ollamaUpgrade";

const phase = () => useOllamaUpgradeStore.getState().phase;
const begin = (from: string, models: string[]) =>
  useOllamaUpgradeStore.getState().begin(from, models);

/** Model names passed to `load_ollama_model`, in call order. */
const loadedCalls = () =>
  invoke.mock.calls
    .filter(([cmd]) => cmd === "load_ollama_model")
    .map(([, args]) => (args as { model: string }).model);

/** What the local `ollama --version` read answers from now on. */
const reports = (current: string) =>
  versionStatus.mockResolvedValue({
    current,
    latest: "",
    update_available: false,
    install_cmd: "",
    shell_kind: "",
    error: null,
  });

/** Advance the poll by one tick and let its promise chain settle. */
async function tick(ms = 5_000) {
  await vi.advanceTimersByTimeAsync(ms);
  await vi.waitFor(() => Promise.resolve());
}

beforeEach(() => {
  resetOllamaUpgrade();
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
  versionStatus.mockReset();
  reports("0.14.3");
  vi.useFakeTimers();
});

afterEach(() => {
  resetOllamaUpgrade();
  vi.useRealTimers();
});

describe("the snapshot", () => {
  it("starts no watcher when nothing was resident", async () => {
    begin("0.14.3", []);
    expect(phase()).toBe("idle");
    await tick();
    // Not merely "no load" — nothing is even *asked*, so an upgrade on a
    // machine with an empty memory costs no polling at all.
    expect(versionStatus).not.toHaveBeenCalled();
  });

  it("waits, watching the local version, when something was", async () => {
    begin("0.14.3", ["a:7b"]);
    expect(phase()).toBe("waiting");
    await tick();
    expect(versionStatus).toHaveBeenCalledWith(false); // local read, no network
    expect(loadedCalls()).toEqual([]); // same version — the server has not changed
  });
});

describe("the restart signal", () => {
  it("loads the snapshot back, in order, once the version changes", async () => {
    begin("0.14.3", ["a:7b", "b:3b"]);
    await tick();
    expect(loadedCalls()).toEqual([]);

    reports("0.15.2");
    await tick();
    await vi.waitFor(() => expect(phase()).toBe("done"));
    expect(loadedCalls()).toEqual(["a:7b", "b:3b"]);
  });

  it("keeps waiting while the version cannot be read at all", async () => {
    begin("0.14.3", ["a:7b"]);
    reports(""); // the binary is being replaced under us
    await tick();
    await tick();
    expect(phase()).toBe("waiting");
    expect(loadedCalls()).toEqual([]);
  });

  it("keeps waiting when the version read fails outright", async () => {
    begin("0.14.3", ["a:7b"]);
    versionStatus.mockRejectedValue(new Error("no binary"));
    await tick();
    expect(phase()).toBe("waiting");
  });
});

describe("when the restart never comes", () => {
  it("gives up out loud after the window, leaving something to click", async () => {
    begin("0.14.3", ["a:7b"]);
    await vi.advanceTimersByTimeAsync(16 * 60_000);
    expect(phase()).toBe("timeout");
    expect(loadedCalls()).toEqual([]);

    // …and the retry loads exactly the snapshot, restart or no restart.
    await useOllamaUpgradeStore.getState().reloadNow();
    expect(loadedCalls()).toEqual(["a:7b"]);
    expect(phase()).toBe("done");
  });

  it("stops watching when the user cancels, and forgets the snapshot", async () => {
    begin("0.14.3", ["a:7b"]);
    useOllamaUpgradeStore.getState().cancel();
    expect(phase()).toBe("idle");
    reports("0.15.2");
    await tick();
    await tick();
    expect(loadedCalls()).toEqual([]);
  });
});

describe("a model that will not come back", () => {
  it("is reported as an error, naming it, with the rest still loaded", async () => {
    invoke.mockImplementation((cmd: string, args?: unknown) =>
      cmd === "load_ollama_model" && (args as { model: string }).model === "b:3b"
        ? Promise.reject("model not found")
        : Promise.resolve(),
    );
    begin("0.14.3", ["a:7b", "b:3b"]);
    reports("0.15.2");
    await tick();
    await vi.waitFor(() => expect(phase()).toBe("error"));
    const s = useOllamaUpgradeStore.getState();
    expect(s.loaded).toEqual(["a:7b"]);
    expect(s.failed).toEqual({ "b:3b": "model not found" });
  });
});
