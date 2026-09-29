import { useEffect, useMemo, useRef, useState } from "react";
import { useT, type TranslationKey } from "../../../src/lib/i18n";
import { isUntested } from "../../../src/lib/untested";
import { ApiError, listProjectFiles, openOutside, viewerFileUrl, type OutboxFile, type ProjectFileEntry, type ProjectFileListing, type ViewerScope } from "../api";
import { sizeLabel } from "../terminal/fileLabels";
import { installFocusSwipe } from "../terminal/focusSwipe";
import { OutboxViewer } from "./OutboxViewer";

/** One folder on the way down: its sealed token (none for the project root)
 * and the name the reader tapped. */
type Crumb = { token?: string; name: string };

/** A listed file as the viewer takes it, fetched by its token. */
function asViewerFile(entry: ProjectFileEntry): OutboxFile {
  return { name: entry.name, kind: entry.kind, size: entry.size, modified: entry.modified, ref: entry.token };
}

/** A listed time as the row prints it: the phone's own date and clock. */
function stampLabel(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** The line under a row's name: a file's size, then when it was created (where
 * the desktop's filesystem says) and last edited. */
function rowMeta(entry: ProjectFileEntry, t: ReturnType<typeof useT>): string {
  return [
    entry.kind !== "dir" ? sizeLabel(entry.size) : null,
    entry.created ? t("mobile.files.created", { when: stampLabel(entry.created) }) : null,
    entry.modified > 0 ? t("mobile.files.edited", { when: stampLabel(entry.modified) }) : null,
  ].filter(Boolean).join(" · ");
}

/** The message for a listing the sidecar refused. */
function failureKey(reason: unknown): TranslationKey {
  if (reason instanceof ApiError) {
    if (reason.code === "files_off") return "mobile.files.off";
    if (reason.code === "file_not_found") return "mobile.files.gone";
  }
  return "mobile.files.error";
}

/**
 * The project's own tree, read-only (`files.rs`, #31bo): folders to walk into
 * and files to open — a picture, a PDF or a text — in the outbox's full-screen
 * viewer, with its Save and Share. The "what did the agent just write" glance
 * without a shell. Nothing here can change a file.
 *
 * The phone never holds a path: each folder and file is a sealed token the
 * sidecar handed out, and the trail across the top is the tokens walked so far.
 *
 * A drawer from the left edge: the project screen opens it on a left→right
 * swipe, and a right→left swipe over it (or a tap beside it) puts it away.
 */
export function ProjectFiles({ projectId, label, onClose }: {
  projectId: string;
  /** The project's name, the trail's first crumb. */
  label: string;
  onClose: () => void;
}) {
  const t = useT();
  const [trail, setTrail] = useState<Crumb[]>([{ name: label }]);
  const [listing, setListing] = useState<ProjectFileListing | null>(null);
  const [failure, setFailure] = useState<TranslationKey | null>(null);
  const [fileOpen, setFileOpen] = useState<OutboxFile | null>(null);
  const scope = useMemo<ViewerScope>(() => ({ files: projectId }), [projectId]);
  const here = trail[trail.length - 1];
  const drawer = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setListing(null);
    setFailure(null);
    void listProjectFiles(projectId, here.token, controller.signal).then(
      (next) => { if (!controller.signal.aborted) setListing(next); },
      (reason) => { if (!controller.signal.aborted) setFailure(failureKey(reason)); },
    );
    return () => controller.abort();
  }, [projectId, here.token]);

  /** The folder's pictures, which the viewer steps through in listing order. */
  const pictures = useMemo(
    () => (listing?.entries ?? []).filter((entry) => entry.kind.startsWith("image/")).map(asViewerFile),
    [listing],
  );

  useEffect(() => {
    // The viewer opens over the sheet, so Escape closes the top one first.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (fileOpen) setFileOpen(null);
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fileOpen, onClose]);

  useEffect(() => {
    // Remounted with the drawer after a file was viewed, hence `fileOpen`.
    const host = drawer.current;
    if (fileOpen || !host) return;
    return installFocusSwipe(host, { onSwipeRight: () => {}, onSwipeLeft: onClose });
  }, [fileOpen, onClose]);

  const open = (entry: ProjectFileEntry) => {
    if (entry.kind === "dir") {
      setTrail((current) => [...current, { token: entry.token, name: entry.name }]);
      return;
    }
    const file = asViewerFile(entry);
    // A PDF opens in the browser's own viewer, as it does from the outbox.
    if (entry.kind === "application/pdf") void openOutside(viewerFileUrl(scope, file));
    else setFileOpen(file);
  };

  if (fileOpen) {
    return <OutboxViewer key={fileOpen.ref} scope={scope} file={fileOpen} pictures={pictures} onStep={setFileOpen} onClose={() => setFileOpen(null)} />;
  }
  return <div className="sheet-backdrop files-drawer-backdrop" role="presentation" onClick={onClose}>
    <section ref={drawer} className="option-sheet project-files" role="dialog" aria-modal="true" aria-label={t("mobile.files.title")} onClick={(event) => event.stopPropagation()}>
      <header>
        <button className="sheet-close" onClick={onClose} aria-label={t("mobile.files.close")}>✕</button>
        <h2>{t("mobile.files.title")} {isUntested("mobile.files.browse") && <small>{t("mobile.outbox.untested")}</small>}</h2>
        <span className="sheet-close" aria-hidden="true" />
      </header>
      <nav className="files-trail" aria-label={t("mobile.files.trail")}>
        {trail.map((crumb, index) => {
          const last = index === trail.length - 1;
          return <button key={`${index}:${crumb.token ?? ""}`} aria-current={last ? "location" : undefined} disabled={last}
            onClick={() => setTrail((current) => current.slice(0, index + 1))}>{crumb.name}</button>;
        })}
      </nav>
      <p className="sheet-note">{t("mobile.files.readOnly")}</p>
      {failure
        ? <p className="sheet-note error" role="alert">{t(failure)}</p>
        : !listing
          ? <p className="sheet-note">{t("mobile.files.loading")}</p>
          : listing.entries.length === 0
            ? <p className="sheet-note">{t("mobile.files.empty")}</p>
            : <ul className="option-list">{listing.entries.map((entry) => <li key={entry.token}>
              <button onClick={() => open(entry)} aria-label={entry.kind === "dir" ? t("mobile.files.openFolder", { name: entry.name }) : t("mobile.files.openFile", { name: entry.name })}>
                <span>
                  <strong><span aria-hidden="true">{entry.kind === "dir" ? "📁 " : entry.kind.startsWith("image/") ? "🖼 " : "📄 "}</span>{entry.name}</strong>
                  <small>{rowMeta(entry, t)}</small>
                </span>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
              </button>
            </li>)}</ul>}
      {listing?.truncated && <p className="sheet-note">{t("mobile.files.truncated", { count: listing.entries.length })}</p>}
    </section>
  </div>;
}
