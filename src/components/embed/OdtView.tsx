import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { unzipSync } from "fflate";
import { ViewerHeader, useViewerState } from "./FileViewerPane";
import { extractOdt, renderOdtDocument } from "../../lib/viewers/odt";

// Re-read the file this long after an external change is detected (mirrors the
// other viewers' diff-aware reload cadence).
const RELOAD_POLL_MS = 1500;

/**
 * Read-only in-app viewer for OpenDocument Text (`.odt`) files (#51, lightweight
 * approach). An `.odt` is a ZIP, so it's loaded as raw bytes via `read_file_bytes`
 * (not `read_file_text`), unzipped in-process with fflate, and rendered to safe
 * HTML by the pure `renderOdtDocument`. Like the table/notebook viewers it polls
 * `file_mtime` and silently re-renders when the document changes on disk.
 *
 * SECURITY: the injected HTML comes solely from `renderOdtDocument`, which builds
 * it tag-by-tag from a whitelist and escapes all text/attributes (no DOMPurify) —
 * see the module header. The faithful path remains "Open externally".
 */
export function OdtView({
  path,
  onOpenExternally,
  tabKey,
}: {
  path: string;
  onOpenExternally: () => void;
  tabKey?: string;
}) {
  // tabKey accepted for call-site parity; no persisted reader position yet.
  useViewerState(tabKey);

  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastMtime = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const bytes = await invoke<number[]>("read_file_bytes", { path });
      const entries = unzipSync(new Uint8Array(bytes));
      const { contentXml, images } = extractOdt(entries);
      setHtml(renderOdtDocument(contentXml, { images }));
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [path]);

  // Initial load + mtime baseline.
  useEffect(() => {
    setHtml(null);
    setError(null);
    lastMtime.current = null;
    void load();
    invoke<number>("file_mtime", { path })
      .then((m) => { lastMtime.current = m; })
      .catch(() => {});
  }, [path, load]);

  // Diff-aware reload: poll mtime; re-render on an external advance.
  useEffect(() => {
    if (html == null) return;
    let cancelled = false;
    const id = setInterval(() => {
      invoke<number>("file_mtime", { path })
        .then((m) => {
          if (cancelled || lastMtime.current == null || m <= lastMtime.current) return;
          lastMtime.current = m;
          void load();
        })
        .catch(() => {});
    }, RELOAD_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [path, html, load]);

  const loaded = html != null;
  return (
    <div className="file-viewer odt-viewer">
      <ViewerHeader onOpenExternally={onOpenExternally} />
      <div className="odt-viewer-body">
        {error != null ? (
          <div className="file-viewer-error">Failed to render document: {error}</div>
        ) : !loaded ? (
          <div className="file-viewer-loading">Loading…</div>
        ) : html.trim().length === 0 ? (
          <div className="file-viewer-loading">This document is empty.</div>
        ) : (
          <div className="odt-document" dangerouslySetInnerHTML={{ __html: html }} />
        )}
      </div>
    </div>
  );
}
