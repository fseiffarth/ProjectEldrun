import { useEffect, useState } from "react";
import { useT } from "../../../src/lib/i18n";
import { outboxFileUrl, type OutboxFile } from "../api";

const INLINE_LIMIT = 1024 * 1024;

/** Read only the preview bytes; cancel the stream once the inline cap is met. */
export async function readTextPreview(response: Response): Promise<string> {
  if (!response.ok || !response.body) throw new Error("read_failed");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let remaining = INLINE_LIMIT;
  let text = "";
  try {
    while (remaining > 0) {
      const { value, done } = await reader.read();
      if (done) break;
      const part = value.subarray(0, remaining);
      text += decoder.decode(part, { stream: true });
      remaining -= part.length;
    }
    return text + decoder.decode();
  } finally { await reader.cancel(); }
}

export function OutboxViewer({ tabId, file, onClose }: { tabId: string; file: OutboxFile; onClose: () => void }) {
  const t = useT();
  const url = outboxFileUrl(tabId, file.name);
  const [text, setText] = useState<string | null>(null);
  const [shareFile, setShareFile] = useState<File | null>(null);
  const [failure, setFailure] = useState("");
  const isText = file.kind.startsWith("text/");
  const canShare = typeof navigator.share === "function" && typeof navigator.canShare === "function";
  useEffect(() => {
    const controller = new AbortController();
    setText(null);
    setShareFile(null);
    setFailure("");
    if (isText) void fetch(url, { signal: controller.signal }).then(readTextPreview).then(
      (body) => { if (!controller.signal.aborted) setText(body); },
      () => { if (!controller.signal.aborted) setFailure(t("mobile.outbox.error")); },
    );
    // Prepare on opening, so the share call itself retains the tap's activation.
    if (canShare) void fetch(url, { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error("read_failed");
      const blob = await response.blob();
      const prepared = new File([blob], file.name, { type: file.kind });
      if (!controller.signal.aborted && navigator.canShare({ files: [prepared] })) setShareFile(prepared);
    }).catch(() => { /* Saving remains available when sharing is unsupported. */ });
    return () => controller.abort();
  }, [url, file.name, file.kind, isText, canShare, t]);

  const share = () => {
    if (!shareFile) return;
    void navigator.share({ files: [shareFile] }).catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === "AbortError")) setFailure(t("mobile.outbox.shareError"));
    });
  };
  return <div className={`outbox-viewer${isText ? " outbox-text-sheet" : ""}`} role="dialog" aria-modal="true" aria-label={file.name}>
    <div className="outbox-viewer-head">
      <button className="sheet-close" onClick={onClose} aria-label={t("mobile.outbox.close")}>✕</button>
      <h2>{file.name}</h2>
      <small>{Math.round(file.size / 1024)} KB</small>
      <a href={outboxFileUrl(tabId, file.name, true)} download={file.name}>{t("mobile.outbox.save")}</a>
      {shareFile && <button onClick={share}>{t("mobile.outbox.share")}</button>}
    </div>
    {failure && <p role="alert">{failure}</p>}
    {isText ? <div className="outbox-text-body">
      <pre>{text ?? (failure ? "" : t("mobile.outbox.loading"))}</pre>
      {file.size > INLINE_LIMIT && <a href={url} target="_blank" rel="noopener noreferrer">{t("mobile.outbox.whole")}</a>}
    </div> : file.kind.startsWith("image/") ? <img src={url} alt={file.name} />
      : file.kind === "application/pdf" ? <a href={url} target="_blank" rel="noopener noreferrer">{t("mobile.outbox.open", { name: file.name })}</a> : null}
  </div>;
}
