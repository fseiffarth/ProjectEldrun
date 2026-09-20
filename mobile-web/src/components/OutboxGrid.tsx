import { useT } from "../../../src/lib/i18n";
import { outboxFileUrl, type OutboxFile, type OutboxScope } from "../api";
import { ageLabel, sizeLabel } from "../terminal/fileLabels";

/**
 * The files themselves: a thumbnail for every picture, a card for everything
 * else, newest first — the one arrangement they are shown in, whether that is
 * the session's gallery sheet (`OutboxGallery`) or the shelf under the project
 * screen's tab cards. Both read the same project outbox through their own
 * scope, so one grid serves both rather than two that drift apart.
 *
 * A kind the browser neither shows nor reads is saved, not opened: the tile is
 * a download link, and no viewer is offered for bytes it would only garble.
 *
 * Every tile carries Save, whatever its kind: what the desktop sent is usually
 * sent to be kept, and a thumbnail carries no ⋯ to reach the file sheet with.
 */
export function OutboxGrid({ scope, files, onOpen, onDetails }: {
  scope: OutboxScope;
  /** Newest first, as the sidecar listed them. */
  files: readonly OutboxFile[];
  /** Opens one file: full screen here, or the browser's own PDF view. */
  onOpen: (file: OutboxFile) => void;
  /** The sheet for one file — where saving and sharing live. */
  onDetails: (file: OutboxFile) => void;
}) {
  const t = useT();
  const now = Math.floor(Date.now() / 1000);
  return <div className="outbox-gallery-grid">
    {files.map((file) => {
      const isImage = file.kind.startsWith("image/");
      const download = !isImage && !file.kind.startsWith("text/") && file.kind !== "application/pdf";
      const label = t("mobile.outbox.open", { name: file.name });
      const meta = `${ageLabel(Math.max(0, now - file.modified))} · ${sizeLabel(file.size)}`;
      const content = <>
        {isImage
          ? <img src={outboxFileUrl(scope, file.name)} alt="" loading="lazy" decoding="async" />
          : <span aria-hidden="true">{file.kind === "application/pdf" ? "PDF" : file.kind.startsWith("text/") ? "≡" : "↓"}</span>}
        <strong>{file.name}</strong>
        <span>{meta}</span>
      </>;
      return <div key={file.name} className="outbox-entry">
        {download
          ? <a className="outbox-file" href={outboxFileUrl(scope, file.name, true)} download={file.name} aria-label={label}>{content}</a>
          : <button className={isImage ? "outbox-thumb" : "outbox-file"} onClick={() => onOpen(file)} aria-label={label} title={file.name}>{content}</button>}
        <div className="outbox-entry-actions">
          {/* Saving is on the tile itself, for every kind — a picture included.
              It used to live one screen in, in the sheet the ⋯ opens, and a
              thumbnail has no ⋯: the only way to keep a picture the agent sent
              was to open it full screen first and find Save there. The link is
              the same `?download=1` byte stream the sheet's Save uses. */}
          <a className="outbox-save" href={outboxFileUrl(scope, file.name, true)} download={file.name} aria-label={t("mobile.outbox.saveFile", { name: file.name })}><span aria-hidden="true">⤓</span>{t("mobile.outbox.save")}</a>
          {!isImage && <button className="outbox-details" onClick={() => onDetails(file)} aria-label={t("mobile.outbox.actions", { name: file.name })}>⋯</button>}
        </div>
      </div>;
    })}
  </div>;
}
