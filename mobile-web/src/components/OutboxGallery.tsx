import { useT } from "../../../src/lib/i18n";
import { outboxFileUrl, type OutboxFile } from "../api";
import { ageLabel, sizeLabel } from "../terminal/fileLabels";
import { isUntested } from "../../../src/lib/untested";

/**
 * Everything the agent sent this tab (`eldrun-send`, the project's
 * `.eldrun/outbox/`), as a sheet of its own: a grid of thumbnails for the
 * pictures and a card for every other file, newest first.
 *
 * The files stay out of the chat — a picture pushed between the turns buries
 * the answer that mentions it, and a chat that rewrites itself as files arrive
 * is not a chat. The gallery is reached from the button beside the tab name,
 * which is there whenever the outbox holds anything, in both views.
 */
export function OutboxGallery({ tabId, files, onOpen, onDetails, onClose }: {
  tabId: string;
  /** Newest first, as the sidecar listed them. */
  files: readonly OutboxFile[];
  /** Opens one file: full screen here, or the browser's own PDF view. */
  onOpen: (file: OutboxFile) => void;
  /** The sheet for one file — where saving and sharing live. */
  onDetails: (file: OutboxFile) => void;
  onClose: () => void;
}) {
  const t = useT();
  const now = Math.floor(Date.now() / 1000);
  return <div className="sheet-backdrop" role="presentation" onClick={onClose}>
    <section className="option-sheet outbox-gallery" role="dialog" aria-modal="true" aria-label={t("mobile.outbox.region")} onClick={(event) => event.stopPropagation()}>
      <span className="sheet-grip" aria-hidden="true" />
      <header>
        <button className="sheet-close" onClick={onClose} aria-label={t("mobile.outbox.close")}>✕</button>
        <h2>{t("mobile.outbox.from")} {isUntested("mobile.outbox.gallery") && <small>{t("mobile.outbox.untested")}</small>}</h2>
        <span className="sheet-close" aria-hidden="true" />
      </header>
      {files.length === 0
        ? <p className="sheet-note">{t("mobile.outbox.galleryEmpty")}</p>
        : <>
          <p className="sheet-note">{t(files.length === 1 ? "mobile.outbox.countOne" : "mobile.outbox.count", { count: files.length })}</p>
          <div className="outbox-gallery-grid">
            {files.map((file) => {
              const isImage = file.kind.startsWith("image/");
              // A kind the browser neither shows nor reads is saved, not opened.
              const download = !isImage && !file.kind.startsWith("text/") && file.kind !== "application/pdf";
              const label = t("mobile.outbox.open", { name: file.name });
              const meta = `${ageLabel(Math.max(0, now - file.modified))} · ${sizeLabel(file.size)}`;
              const content = <>
                {isImage
                  ? <img src={outboxFileUrl(tabId, file.name)} alt="" loading="lazy" decoding="async" />
                  : <span aria-hidden="true">{file.kind === "application/pdf" ? "PDF" : file.kind.startsWith("text/") ? "≡" : "↓"}</span>}
                <strong>{file.name}</strong>
                <span>{meta}</span>
              </>;
              return <div key={file.name} className="outbox-entry">
                {download
                  ? <a className="outbox-file" href={outboxFileUrl(tabId, file.name, true)} download={file.name} aria-label={label}>{content}</a>
                  : <button className={isImage ? "outbox-thumb" : "outbox-file"} onClick={() => onOpen(file)} aria-label={label} title={file.name}>{content}</button>}
                {!isImage && <button className="outbox-details" onClick={() => onDetails(file)} aria-label={t("mobile.outbox.actions", { name: file.name })}>⋯</button>}
              </div>;
            })}
          </div>
        </>}
    </section>
  </div>;
}
