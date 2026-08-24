import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import {
  _clearAllPtyInputsForTest,
  writePtyInput,
} from "../lib/terminalInput";

const invokeMock = vi.mocked(invoke);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

beforeEach(() => {
  _clearAllPtyInputsForTest();
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
});

describe("terminal input pump", () => {
  it("sends the first key immediately and coalesces queued keys in FIFO order", async () => {
    let release!: () => void;
    invokeMock.mockImplementationOnce(
      () => new Promise<void>((resolve) => { release = resolve; }),
    );

    const a = writePtyInput("p:t", encoder.encode("a"));
    const b = writePtyInput("p:t", encoder.encode("b"));
    const c = writePtyInput("p:t", encoder.encode("c"));

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(decoder.decode((invokeMock.mock.calls[0][1] as { data: Uint8Array }).data)).toBe("a");

    release();
    await Promise.all([a, b, c]);
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(decoder.decode((invokeMock.mock.calls[1][1] as { data: Uint8Array }).data)).toBe("bc");
  });

  it("rejects queued input explicitly when the backend write fails", async () => {
    invokeMock.mockRejectedValueOnce(new Error("closed"));
    const first = writePtyInput("p:t", encoder.encode("a"));
    const second = writePtyInput("p:t", encoder.encode("b"));
    await expect(first).rejects.toThrow("closed");
    await expect(second).rejects.toThrow("closed");
  });
});
