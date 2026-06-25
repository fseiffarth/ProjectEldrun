import { useState } from "react";
import { useReadonlyFile, ViewerHeader } from "./FileViewerPane";

/**
 * HTML/SVG rendered-preview viewer (Dev E). Renders `.html`/`.htm`/`.svg` with a
 * Preview ⇄ Source toggle (styled like the markdown viewer's mode buttons).
 *
 * PREVIEW renders the file inside a `<iframe srcDoc>` whose `sandbox` attribute
 * is the EMPTY STRING — the maximally restrictive sandbox: no `allow-scripts`,
 * no `allow-same-origin`, no forms/popups/etc. That means arbitrary JavaScript in
 * the page (or `<script>`/event handlers inside an SVG) CANNOT execute, so even a
 * hostile file renders safely as static markup. SOURCE shows the raw text
 * read-only, escaped via React children.
 *
 * LIMITATION (v1): because the document is delivered via `srcDoc` rather than a
 * real URL, it has no base directory. Relative resource references (external CSS,
 * `<img src="logo.png">`, etc.) won't resolve and appear broken/missing — inline
 * styles/markup and data: URIs render fine. This is acceptable for v1; "Open in
 * external app" remains available for files that need their full asset context.
 */
export function HtmlView({
  path,
  onOpenExternally,
  tabKey: _tabKey,
}: {
  path: string;
  onOpenExternally: () => void;
  tabKey?: string;
}) {
  const { content, error, loaded } = useReadonlyFile(path);
  const [mode, setMode] = useState<"preview" | "source">("preview");

  const fileName = path.slice(path.lastIndexOf("/") + 1);

  return (
    <div className="file-viewer">
      <ViewerHeader onOpenExternally={onOpenExternally}>
        <div className="file-viewer-modes">
          <button
            className={`file-viewer-mode${mode === "preview" ? " active" : ""}`}
            aria-pressed={mode === "preview"}
            onClick={() => setMode("preview")}
          >
            Preview
          </button>
          <button
            className={`file-viewer-mode${mode === "source" ? " active" : ""}`}
            aria-pressed={mode === "source"}
            onClick={() => setMode("source")}
          >
            Source
          </button>
        </div>
      </ViewerHeader>
      <div className="file-viewer-body">
        {error != null ? (
          <div className="file-viewer-error">{error}</div>
        ) : !loaded ? (
          <div className="file-viewer-loading">Loading…</div>
        ) : mode === "preview" ? (
          <iframe
            // sandbox="" is intentional and load-bearing: an empty value is the
            // most restrictive sandbox, so no script in the HTML/SVG can run.
            sandbox=""
            srcDoc={content ?? ""}
            title={`Preview of ${fileName}`}
            style={{
              width: "100%",
              height: "100%",
              border: "none",
              // Page content authored against a white page shouldn't have a dark
              // theme bleed through gaps; give the frame an explicit white base.
              background: "#fff",
            }}
          />
        ) : (
          <pre
            className="file-viewer-code-body"
            style={{
              margin: 0,
              padding: "8px 12px",
              overflow: "auto",
              whiteSpace: "pre",
              fontFamily:
                "var(--font-mono, ui-monospace, \"SF Mono\", Menlo, Consolas, monospace)",
            }}
          >
            {/* React children auto-escape, so raw HTML/SVG markup is shown as
                text rather than interpreted. */}
            {content}
          </pre>
        )}
      </div>
    </div>
  );
}
