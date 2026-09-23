import { useEffect, useRef, useState, type TouchEvent } from "react";
import { useT } from "../../../src/lib/i18n";
import { outboxFileUrl, type OutboxFile, type OutboxScope } from "../api";
import { sizeLabel } from "../terminal/fileLabels";
import { isUntested } from "../../../src/lib/untested";

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

/** How far a finger has to travel sideways, in CSS pixels, before a swipe on
 * the picture steps to the next one rather than reading as a wobbly tap. */
const SWIPE = 48;

/**
 * One file the desktop sent, full screen. A picture opened from the gallery
 * steps through the gallery's other pictures in place — ‹ ›, a sideways swipe,
 * or the arrow keys — rather than making the reader close it, find the next
 * tile and open that: a run of plots is looked at one after another. Only the
 * pictures are stepped through; a text or a PDF is a different kind of look.
 */
export function OutboxViewer({ scope, file, pictures, onStep, onClose }: {
  scope: OutboxScope;
  file: OutboxFile;
  /** The pictures to step through, in the gallery's order (newest first).
   * Left out, or when `file` is not among them, the viewer shows one file. */
  pictures?: readonly OutboxFile[];
  /** Shows another of `pictures` in place of this one. */
  onStep?: (file: OutboxFile) => void;
  onClose: () => void;
}) {
  const t = useT();
  const url = outboxFileUrl(scope, file.name);
  const isImage = file.kind.startsWith("image/");
  const steps = isImage && onStep ? pictures ?? [] : [];
  const index = steps.findIndex((picture) => picture.name === file.name);
  // Newest first, so "next" is the older picture — the way the grid reads.
  const previous = index > 0 ? steps[index - 1] : null;
  const next = index >= 0 && index < steps.length - 1 ? steps[index + 1] : null;
  const touch = useRef<{ x: number; y: number } | null>(null);
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
  useEffect(() => {
    if (!onStep || (!previous && !next)) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.key === "ArrowLeft" ? previous : event.key === "ArrowRight" ? next : null;
      if (!target) return;
      event.preventDefault();
      onStep(target);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onStep, previous, next]);
  useEffect(() => {
    // Warm the neighbours, so a step lands on a picture rather than a blank
    // while it loads over the phone's radio.
    for (const neighbour of [previous, next]) {
      if (neighbour) new Image().src = outboxFileUrl(scope, neighbour.name);
    }
  }, [scope, previous, next]);

  const share = () => {
    if (!shareFile) return;
    void navigator.share({ files: [shareFile] }).catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === "AbortError")) setFailure(t("mobile.outbox.shareError"));
    });
  };
  /** A sideways swipe steps; one mostly up or down, or a second finger (a
   * pinch), is left alone. */
  const onTouchStart = (event: TouchEvent) => {
    touch.current = event.touches.length === 1 ? { x: event.touches[0].clientX, y: event.touches[0].clientY } : null;
  };
  const onTouchEnd = (event: TouchEvent) => {
    const start = touch.current;
    touch.current = null;
    const end = event.changedTouches[0];
    if (!start || !end || !onStep) return;
    const dx = end.clientX - start.x;
    const dy = end.clientY - start.y;
    if (Math.abs(dx) < SWIPE || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    const target = dx < 0 ? next : previous;
    if (target) onStep(target);
  };
  return <div className={`outbox-viewer${isText ? " outbox-text-sheet" : ""}`} role="dialog" aria-modal="true" aria-label={file.name}>
    <div className="outbox-viewer-head">
      <button className="sheet-close" onClick={onClose} aria-label={t("mobile.outbox.close")}>✕</button>
      <h2>{file.name}</h2>
      {index >= 0 && steps.length > 1
        ? <small>{t("mobile.outbox.position", { index: index + 1, count: steps.length })} · {sizeLabel(file.size)}{isUntested("mobile.outbox.step") && <span className="untested">{t("mobile.outbox.untested")}</span>}</small>
        : <small>{sizeLabel(file.size)}</small>}
      <a href={outboxFileUrl(scope, file.name, true)} download={file.name}>{t("mobile.outbox.save")}</a>
      {shareFile && <button onClick={share}>{t("mobile.outbox.share")}</button>}
    </div>
    {failure && <p role="alert">{failure}</p>}
    {isText ? <div className="outbox-text-body">
      <pre>{text ?? (failure ? "" : t("mobile.outbox.loading"))}</pre>
      {file.size > INLINE_LIMIT && <a href={url} target="_blank" rel="noopener noreferrer">{t("mobile.outbox.whole")}</a>}
    </div> : isImage ? <div className="outbox-viewer-stage" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd} onTouchCancel={() => { touch.current = null; }}>
      <img src={url} alt={file.name} />
      {previous && <button className="outbox-step outbox-step-previous" onClick={() => onStep?.(previous)} aria-label={t("mobile.outbox.previous")}><span aria-hidden="true">‹</span></button>}
      {next && <button className="outbox-step outbox-step-next" onClick={() => onStep?.(next)} aria-label={t("mobile.outbox.next")}><span aria-hidden="true">›</span></button>}
    </div>
      : file.kind === "application/pdf" ? <a href={url} target="_blank" rel="noopener noreferrer">{t("mobile.outbox.open", { name: file.name })}</a> : null}
  </div>;
}
