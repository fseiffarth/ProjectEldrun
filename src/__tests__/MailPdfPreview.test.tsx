/**
 * The mail attachment PDF preview (`components/mail/MailPdfPreview.tsx`).
 *
 * Three things matter and none of them is "the pixels look right": that a
 * PDF is recognised by its bytes rather than its declared type, that a blob
 * the IPC bound cut short is refused instead of parsed (a truncated PDF has no
 * cross-reference table, so pdf.js would only fail slower), and that the
 * document's Worker goes when the preview does — the leak `pdfLoad` exists to
 * prevent, on a surface that opens a fresh document per click.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const loadPdf = vi.fn();
vi.mock("../lib/viewers/pdfLoad", () => ({ loadPdf: (...a: unknown[]) => loadPdf(...a) }));

import { MailPdfPreview, PDF_PREVIEW_PAGE_STEP } from "../components/mail/MailPdfPreview";
import { previewIsPdf } from "../lib/mail";
import { translate, type TranslationKey } from "../lib/i18n";

const t = (key: string, vars?: Record<string, string>) =>
  translate("en", key as TranslationKey, vars);

/** base64 of `%PDF-1.7\n…` — the magic is what the detector keys on. */
const PDF_B64 = btoa("%PDF-1.7\nfake body");

function fakeDoc(numPages: number) {
  const destroy = vi.fn(() => Promise.resolve());
  const cancel = vi.fn();
  const page = {
    getViewport: ({ scale }: { scale: number }) => ({ width: 595 * scale, height: 842 * scale }),
    render: vi.fn(() => ({ promise: Promise.resolve(), cancel })),
  };
  const doc = {
    numPages,
    getPage: vi.fn(() => Promise.resolve(page)),
    loadingTask: { destroy },
  };
  return { doc, destroy, page, cancel };
}

describe("previewIsPdf", () => {
  it("keys on the %PDF magic, not the declared type", () => {
    const blob = (mime: string, bytes_b64: string) => ({ mime, bytes_b64, truncated: false });
    // A PDF sent as octet-stream is still a PDF …
    expect(previewIsPdf(blob("application/octet-stream", PDF_B64))).toBe(true);
    // … and a declared PDF whose bytes are a PNG is not.
    expect(previewIsPdf(blob("application/pdf", btoa("\x89PNG\r\n")))).toBe(false);
    expect(previewIsPdf({ bytes_b64: "" })).toBe(false);
  });
});

describe("MailPdfPreview", () => {
  let getContext: typeof HTMLCanvasElement.prototype.getContext;
  beforeEach(() => {
    loadPdf.mockReset();
    // jsdom has no canvas; a bare object is enough for pdf.js's mocked render.
    getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({})) as never;
  });
  afterEach(() => {
    cleanup();
    HTMLCanvasElement.prototype.getContext = getContext;
  });

  it("refuses a truncated blob without ever parsing it", () => {
    render(<MailPdfPreview bytesB64={PDF_B64} truncated={true} />);
    expect(screen.getByText(t("mail.previewPdfTooLarge"))).toBeTruthy();
    expect(loadPdf).not.toHaveBeenCalled();
  });

  it("renders the first pages, offers the rest in steps, and closes the document on unmount", async () => {
    const { doc, destroy, page } = fakeDoc(PDF_PREVIEW_PAGE_STEP + 2);
    loadPdf.mockResolvedValueOnce(doc);
    const view = render(<MailPdfPreview bytesB64={PDF_B64} truncated={false} />);

    await screen.findByText(t("mail.previewPdfPages", { count: String(PDF_PREVIEW_PAGE_STEP + 2) }));
    // The bytes handed to pdf.js are the decoded attachment, not the base64.
    const handed = loadPdf.mock.calls[0][0] as Uint8Array;
    expect(new TextDecoder().decode(handed.slice(0, 5))).toBe("%PDF-");

    const more = await screen.findByRole("button", {
      name: t("mail.previewPdfMore", { count: "2" }),
    });
    expect(screen.getAllByLabelText(/^Page \d+$/)).toHaveLength(PDF_PREVIEW_PAGE_STEP);
    await userEvent.click(more);
    await vi.waitFor(() =>
      expect(screen.getAllByLabelText(/^Page \d+$/)).toHaveLength(PDF_PREVIEW_PAGE_STEP + 2),
    );
    expect(screen.queryByRole("button")).toBeNull();
    await vi.waitFor(() => expect(page.render).toHaveBeenCalledTimes(PDF_PREVIEW_PAGE_STEP + 2));

    expect(destroy).not.toHaveBeenCalled();
    view.unmount();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("says so when pdf.js cannot open the bytes", async () => {
    loadPdf.mockRejectedValueOnce(new Error("Invalid PDF structure"));
    render(<MailPdfPreview bytesB64={PDF_B64} truncated={false} />);
    expect(await screen.findByText(t("mail.previewPdfFailed"))).toBeTruthy();
  });
});
