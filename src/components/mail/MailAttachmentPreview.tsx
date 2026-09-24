import { previewIsPdf } from "../../lib/mail";
import { useT } from "../../lib/i18n";
import type { MailPreviewBlob } from "../../types/mail";
import { MailPdfPreview } from "./MailPdfPreview";

/**
 * The one attachment preview, shared by a received message's attachment rows
 * (`MailMessageView`, bytes from `mail_attachment_preview`) and the composer's
 * staged chips (`MailComposeDialog`, bytes from `mail_staged_preview` — the
 * sealed outbox copy a send attaches). Both hand over bounded bytes over IPC;
 * nothing here touches the filesystem.
 *
 * Images render from a `data:` URI; a PDF is drawn page by page onto canvases
 * (`MailPdfPreview` — no text layer, no links); anything textual renders as
 * escaped text in a `<pre>`; everything else says so rather than offering a
 * way out of the app.
 */
export function AttachmentPreview({ blob }: { blob: MailPreviewBlob }) {
  const t = useT();
  const isPdf = previewIsPdf(blob);
  const isImage = !isPdf && blob.mime.startsWith("image/") && blob.mime !== "image/svg+xml";
  const isText = !isPdf && (blob.mime.startsWith("text/") || blob.mime === "application/json");

  let text = "";
  if (isText) {
    try {
      text = new TextDecoder().decode(
        Uint8Array.from(atob(blob.bytes_b64), (c) => c.charCodeAt(0)),
      );
    } catch {
      text = "";
    }
  }

  return (
    <div className="mail-attachment-preview">
      {isImage && (
        <img
          className="mail-attachment-image"
          src={`data:${blob.mime};base64,${blob.bytes_b64}`}
          alt=""
        />
      )}
      {isPdf && <MailPdfPreview bytesB64={blob.bytes_b64} truncated={blob.truncated} />}
      {isText && <pre className="mail-attachment-text">{text}</pre>}
      {!isImage && !isText && !isPdf && (
        <div className="mail-note">{t("mail.previewUnavailable")}</div>
      )}
      {/* A cut-off PDF already says it is too large; "shortened" would be false comfort. */}
      {blob.truncated && !isPdf && <div className="mail-note">{t("mail.previewTruncated")}</div>}
    </div>
  );
}
