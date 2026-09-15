import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { useT } from "../../lib/i18n";
import { UntestedTag } from "../common/UntestedTag";

/** Pages rendered before the reader has to ask for more. A mailed PDF is
 *  usually a one- or two-page letter or invoice; a 60-page report is the case
 *  the button is for, and rasterizing all of it up front would cost seconds
 *  and tens of megabytes of canvas for pages nobody scrolls to. */
export const PDF_PREVIEW_PAGE_STEP = 6;

/** Widest raster in CSS px. The attachment column is narrower than this on
 *  every layout; the cap keeps a page's canvas from being sized for a monitor
 *  it will never fill. */
const MAX_PAGE_CSS_PX = 900;

/**
 * In-pane PDF preview for a mail attachment, drawn with pdf.js onto plain
 * canvases. Deliberately **canvas only**: no text layer, no link annotations, no
 * outline, no form fields. A PDF's links are a way out of the app, and the
 * whole attachment design exists so that nothing an attachment carries can
 * open anything. Reading it is the feature; acting on it is what *Save* is for.
 *
 * The bytes arrive bounded over IPC (`mail_attachment_preview`), and a PDF cut
 * off at that bound is not a PDF — the cross-reference table lives at the end —
 * so a truncated blob is reported as too large rather than fed to the parser.
 *
 * pdf.js is loaded on the first preview, the way the TeX hover card does it,
 * so the mail surface does not carry the renderer in its own chunk.
 */
export function MailPdfPreview({ bytesB64, truncated }: { bytesB64: string; truncated: boolean }) {
  const t = useT();
  const hostRef = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [failed, setFailed] = useState(false);
  const [wanted, setWanted] = useState(PDF_PREVIEW_PAGE_STEP);

  // Open the document; close it when the bytes change or the preview goes.
  useEffect(() => {
    if (truncated) return;
    let cancelled = false;
    let opened: PDFDocumentProxy | null = null;
    setDoc(null);
    setFailed(false);
    setWanted(PDF_PREVIEW_PAGE_STEP);
    void (async () => {
      try {
        const { loadPdf } = await import("../../lib/viewers/pdfLoad");
        const loaded = await loadPdf(base64Bytes(bytesB64));
        if (cancelled) {
          void loaded.loadingTask.destroy().catch(() => {});
          return;
        }
        opened = loaded;
        setDoc(loaded);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      // The document's Worker ends only with its task; see `pdfLoad`.
      if (opened) void opened.loadingTask.destroy().catch(() => {});
    };
  }, [bytesB64, truncated]);

  if (truncated) return <div className="mail-note">{t("mail.previewPdfTooLarge")}</div>;
  if (failed) return <div className="mail-note">{t("mail.previewPdfFailed")}</div>;

  const total = doc?.numPages ?? 0;
  const shown = Math.min(total, wanted);
  const remaining = total - shown;

  return (
    <div className="mail-attachment-pdf" ref={hostRef}>
      <div className="mail-attachment-pdf-head">
        <span>
          {doc ? t("mail.previewPdfPages", { count: String(total) }) : t("mail.previewPdfRendering")}
        </span>
        <UntestedTag />
      </div>
      {doc && (
        <div className="mail-attachment-pdf-pages">
          {Array.from({ length: shown }, (_, i) => (
            <PdfPreviewPage key={i + 1} doc={doc} pageNumber={i + 1} host={hostRef} />
          ))}
        </div>
      )}
      {remaining > 0 && (
        <button
          type="button"
          className="settings-btn"
          onClick={() => setWanted((n) => n + PDF_PREVIEW_PAGE_STEP)}
        >
          {t("mail.previewPdfMore", { count: String(Math.min(remaining, PDF_PREVIEW_PAGE_STEP)) })}
        </button>
      )}
    </div>
  );
}

/** One page, rasterized once at the column's width when it mounts. A render in
 *  flight is cancelled if the page unmounts first (the preview was closed, or
 *  another attachment's preview replaced it). */
function PdfPreviewPage({
  doc,
  pageNumber,
  host,
}: {
  doc: PDFDocumentProxy;
  pageNumber: number;
  host: React.RefObject<HTMLDivElement | null>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);
  const t = useT();

  useEffect(() => {
    let cancelled = false;
    let task: { cancel: () => void } | null = null;
    void (async () => {
      try {
        const page = await doc.getPage(pageNumber);
        const canvas = canvasRef.current;
        if (cancelled || !canvas) return;
        const base = page.getViewport({ scale: 1 });
        const columnWidth = Math.min(
          MAX_PAGE_CSS_PX,
          Math.max(120, (host.current?.clientWidth ?? 600) - 2),
        );
        // Raster at the device's pixel density so text stays sharp on a HiDPI
        // panel, but never above 2× — a 4× desktop scale would quadruple the
        // canvas memory for a page shown 600 px wide.
        const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
        const cssScale = columnWidth / Math.max(1, base.width);
        const viewport = page.getViewport({ scale: cssScale * dpr });
        canvas.width = Math.max(1, Math.ceil(viewport.width));
        canvas.height = Math.max(1, Math.ceil(viewport.height));
        canvas.style.width = `${Math.round(viewport.width / dpr)}px`;
        canvas.style.height = `${Math.round(viewport.height / dpr)}px`;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          setFailed(true);
          return;
        }
        const render = page.render({ canvas, canvasContext: ctx, viewport });
        task = render;
        await render.promise;
      } catch {
        // A cancelled render rejects too; only an *uncancelled* failure is news.
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, pageNumber, host]);

  return (
    <div className="mail-attachment-pdf-page">
      {failed ? (
        <div className="mail-note">{t("mail.previewPdfFailed")}</div>
      ) : (
        <canvas ref={canvasRef} aria-label={t("mail.previewPdfPageLabel", { n: String(pageNumber) })} />
      )}
    </div>
  );
}

/** Decode a base64 payload into bytes. */
function base64Bytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
