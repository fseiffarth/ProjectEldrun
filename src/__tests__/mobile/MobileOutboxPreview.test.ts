/**
 * `readTextPreview` (`mobile-web/src/components/OutboxViewer.tsx`): the inline
 * preview of a text file the agent put in the outbox reads only its first
 * mebibyte and then cancels the stream, so a 200 MB log opened on a phone costs
 * one mebibyte of radio. The viewer around it is covered by
 * MobileTerminalOutbox; this is the byte-level contract.
 */
import { describe, expect, it, vi } from "vitest";
import { readTextPreview } from "../../../mobile-web/src/components/OutboxViewer";

const MIB = 1024 * 1024;

function streamOf(chunks: Uint8Array[], onCancel = vi.fn()): Response {
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) controller.enqueue(chunks[index++]);
      else controller.close();
    },
    cancel: onCancel,
  });
  return new Response(body, { status: 200 });
}

describe("Eldrun Mobile outbox text preview", () => {
  it("returns the whole text of a small file", async () => {
    // Cancelling an already-closed stream is a no-op per spec, so `cancel` is
    // not observable here; the cap test below is where it must fire.
    const response = streamOf([new TextEncoder().encode("hello "), new TextEncoder().encode("world")]);
    await expect(readTextPreview(response)).resolves.toBe("hello world");
  });

  it("stops at the inline cap and cancels without reading further chunks", async () => {
    const first = new Uint8Array(MIB - 10).fill(0x61); // 'a'
    const second = new Uint8Array(100).fill(0x62); // 'b'
    let pulls = 0;
    const onCancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) controller.enqueue(first);
        else if (pulls === 2) controller.enqueue(second);
        else controller.enqueue(new Uint8Array(1000).fill(0x63));
      },
      cancel: onCancel,
    });
    const text = await readTextPreview(new Response(body, { status: 200 }));
    expect(text.length).toBe(MIB);
    expect(text.endsWith("a".repeat(10) + "b".repeat(10))).toBe(true);
    expect(text.includes("c")).toBe(false);
    expect(onCancel).toHaveBeenCalled();
  });

  it("decodes a multi-byte character split across two chunks", async () => {
    const bytes = new TextEncoder().encode("ok ✓ done");
    const cut = bytes.indexOf(0xe2) + 1; // inside the three-byte check mark
    const response = streamOf([bytes.subarray(0, cut), bytes.subarray(cut)]);
    await expect(readTextPreview(response)).resolves.toBe("ok ✓ done");
  });

  it("refuses a failed response and one with no body", async () => {
    await expect(readTextPreview(new Response("nope", { status: 404 }))).rejects.toThrow("read_failed");
    await expect(readTextPreview(new Response(null, { status: 200 }))).rejects.toThrow("read_failed");
  });

  it("returns an empty preview for an empty file", async () => {
    await expect(readTextPreview(streamOf([]))).resolves.toBe("");
  });
});
