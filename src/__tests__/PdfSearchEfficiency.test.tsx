import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { initialPages } from "../lib/viewers/pageModel";
import { useSearchText } from "../components/embed/pdf/useSearchText";
import { pageTextItemBoxes } from "../components/embed/pdf/pageText";
vi.mock("../components/embed/pdf/pageText", () => ({ pageTextItemBoxes: vi.fn() }));

it("pauses after in-flight work, resumes cached pages and invalidates recompiled documents and rotation", async () => {
  const extract = vi.mocked(pageTextItemBoxes);
  const finishes: (() => void)[] = [];
  extract.mockImplementation(() => new Promise((r) => finishes.push(() => r([]))));
  const doc = {} as PDFDocumentProxy;
  const pages = initialPages(5);
  const sources = new Map([[pages[0].src, { doc }]]);
  const view = renderHook(({ active, sources, pages }) => useSearchText(pages, sources, active), {
    initialProps: { active: false, sources, pages },
  });
  expect(extract).not.toHaveBeenCalled();
  view.rerender({ active: true, sources, pages });
  expect(extract).toHaveBeenCalledTimes(2);
  view.rerender({ active: false, sources, pages });
  await act(async () => { finishes.splice(0).forEach((done) => done()); });
  expect(extract).toHaveBeenCalledTimes(2);
  view.rerender({ active: true, sources, pages });
  await waitFor(() => expect(extract).toHaveBeenCalledTimes(4));
  await act(async () => { finishes.splice(0).forEach((done) => done()); });
  await waitFor(() => expect(extract).toHaveBeenCalledTimes(5));
  await act(async () => { finishes.splice(0).forEach((done) => done()); });
  expect(view.result.current).toHaveLength(5);
  extract.mockResolvedValue([]);
  const replacement = new Map([[pages[0].src, { doc: {} as PDFDocumentProxy }]]);
  view.rerender({ active: true, sources: replacement, pages });
  expect(view.result.current).toBeNull();
  await waitFor(() => expect(view.result.current).toHaveLength(5));
  expect(extract).toHaveBeenCalledTimes(10);
  view.rerender({ active: true, sources: replacement, pages: pages.map((p, i) => i ? p : { ...p, rot: 90 }) });
  await waitFor(() => expect(view.result.current).toHaveLength(5));
  expect(extract).toHaveBeenCalledTimes(11);
});
