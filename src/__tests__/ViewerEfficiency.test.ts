import { afterEach, describe, expect, it, vi } from "vitest";
import { DraftSaver } from "../components/embed/draftSaver";
import { indexedLine, lineStarts } from "../components/embed/lineIndex";
import { PreviewImages } from "../components/embed/previewImages";

afterEach(() => vi.useRealTimers());
describe("draft scheduling", () => {
  it("debounces and bounds continuous typing at two seconds", async () => {
    vi.useFakeTimers();
    const write = vi.fn(async () => {});
    const saver = new DraftSaver(write);
    for (let i = 0; i < 7; i++) {
      saver.update(String(i), "disk", true, true);
      await vi.advanceTimersByTimeAsync(300);
    }
    expect(write).toHaveBeenCalledExactlyOnceWith("6");
    saver.update("last", "6", true, true);
    await vi.advanceTimersByTimeAsync(399);
    expect(write).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(write).toHaveBeenLastCalledWith("last");
  });
  it("serializes delayed writes and flush awaits newer edits", async () => {
    let finish!: () => void;
    const write = vi.fn().mockImplementationOnce(() => new Promise<void>((r) => { finish = r; })).mockResolvedValue(undefined);
    const saver = new DraftSaver(write);
    saver.update("first", "disk", true, true);
    const saving = saver.flush();
    saver.update("second", "disk", true, true);
    const explicit = saver.flush();
    expect(write).toHaveBeenCalledTimes(1);
    finish();
    await Promise.all([saving, explicit]);
    expect(write.mock.calls.map(([text]) => text)).toEqual(["first", "second"]);
    saver.dispose();
  });
  it("flushes teardown, but leaves autosave-off drafts alone until explicit Save", async () => {
    vi.useFakeTimers();
    const write = vi.fn(async () => {});
    const saver = new DraftSaver(write);
    saver.update("off", "disk", true, false);
    await vi.advanceTimersByTimeAsync(3000);
    saver.dispose();
    expect(write).not.toHaveBeenCalled();
    await saver.flush();
    expect(write).toHaveBeenCalledWith("off");
    saver.update("pending", "off", true, true);
    saver.dispose();
    await saver.flush();
    expect(write).toHaveBeenLastCalledWith("pending");
  });
  it("retains failed edits for explicit retry", async () => {
    const write = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    const saver = new DraftSaver(write);
    const status = vi.fn();
    saver.onStatus = status;
    saver.update("draft", "disk", true, false);
    await saver.flush();
    expect(status).toHaveBeenLastCalledWith(false, "Error: offline");
    await saver.flush();
    expect(write).toHaveBeenCalledTimes(2);
  });
});
it("indexes newline boundaries, EOF and many diagnostics", () => {
  const text = "abc\ndef\n";
  const starts = lineStarts(text);
  expect([0, 3, 4, 7, 8].map((n) => indexedLine(starts, n))).toEqual([1, 1, 2, 2, 3]);
  const many = lineStarts("x\n".repeat(10000));
  for (let i = 0; i <= 10000; i++) expect(indexedLine(many, i * 2)).toBe(i + 1);
});
it("deduplicates images, bounds reads and releases removed and teardown URLs", async () => {
  const create = vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:${Math.random()}`);
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const finishes: (() => void)[] = [];
  const read = vi.fn(() => new Promise<Uint8Array>((r) => finishes.push(() => r(new Uint8Array([1])))));
  const images = new PreviewImages(read, () => "image/png");
  images.retain(new Set(["a", "b", "c", "d", "e"]));
  const a = images.load("a");
  expect(images.load("a")).toBe(a);
  const all = [a, ...["b", "c", "d", "e"].map((p) => images.load(p))];
  expect(read).toHaveBeenCalledTimes(4);
  finishes.splice(0).forEach((done) => done());
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(5));
  finishes.splice(0).forEach((done) => done());
  await Promise.all(all);
  images.retain(new Set(["a"]));
  expect(revoke).toHaveBeenCalledTimes(4);
  await images.load("a");
  expect(read).toHaveBeenCalledTimes(5);
  images.dispose();
  expect(revoke).toHaveBeenCalledTimes(5);
  create.mockRestore(); revoke.mockRestore();
});
