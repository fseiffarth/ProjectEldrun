/**
 * `loadPdf` — the one way a PDF is opened with pdf.js (`lib/viewers/pdfLoad.ts`).
 *
 * The property under test is the failure path: a `getDocument()` whose promise
 * rejects still owns a Worker, and nothing but `loadingTask.destroy()` ends it.
 * Every opener used to `await getDocument(…).promise` and let the rejection
 * propagate, and each truncated mid-compile read of a LaTeX build left one
 * Worker thread behind (303 of them in the main window on 2026-09-08).
 */
import { describe, expect, it, vi } from "vitest";

const getDocument = vi.fn();
vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: (...args: unknown[]) => getDocument(...args),
}));

import { loadPdf } from "../lib/viewers/pdfLoad";

function task(promise: Promise<unknown>, destroy = vi.fn(() => Promise.resolve())) {
  return { promise, destroy };
}

describe("loadPdf", () => {
  it("returns the opened document and leaves its task to the caller", async () => {
    const doc = { numPages: 3 };
    const t = task(Promise.resolve(doc));
    getDocument.mockReturnValueOnce(t);
    await expect(loadPdf(new Uint8Array([1, 2, 3]))).resolves.toBe(doc);
    expect(t.destroy).not.toHaveBeenCalled();
    expect(getDocument).toHaveBeenCalledWith({ data: new Uint8Array([1, 2, 3]) });
  });

  it("destroys the task of a load that rejects, and rethrows the same error", async () => {
    const err = new Error("Unexpected end of file");
    const t = task(Promise.reject(err));
    getDocument.mockReturnValueOnce(t);
    await expect(loadPdf(new Uint8Array(200))).rejects.toBe(err);
    expect(t.destroy).toHaveBeenCalledTimes(1);
  });

  it("keeps the caller's error when destroying the failed task fails too", async () => {
    const err = new Error("Invalid PDF structure");
    const t = task(
      Promise.reject(err),
      vi.fn(() => Promise.reject(new Error("worker already gone"))),
    );
    getDocument.mockReturnValueOnce(t);
    await expect(loadPdf(new Uint8Array(200))).rejects.toBe(err);
    expect(t.destroy).toHaveBeenCalledTimes(1);
  });
});
