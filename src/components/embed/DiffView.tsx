import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ViewerHeader, useReadonlyFile } from "./FileViewerPane";
import { useProjectsStore } from "../../stores/projects";
import { resolveProjectDirectory } from "../../types";
import { relFromAbs } from "../../lib/viewers/fileUtils";
import { parseUnifiedDiff, type DiffLine } from "../../lib/viewers/diff";

/** True when `path` is a literal diff/patch file (read its raw content) rather
 *  than a source path (compute the diff via the backend). */
function isPatchFile(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".diff") || lower.endsWith(".patch");
}

// Low-alpha line backgrounds, keyed off the GitHub-ish add/del greens & reds so
// they read in both light and dark themes (the text colour stays the app's).
const ADD_BG = "rgba(63, 185, 80, 0.15)"; // #3fb950
const DEL_BG = "rgba(248, 81, 73, 0.15)"; // #f85149

function lineBackground(type: DiffLine["type"]): string | undefined {
  if (type === "add") return ADD_BG;
  if (type === "del") return DEL_BG;
  return undefined;
}

/** A single rendered diff line: two line-number gutter columns then the text.
 *  Text is rendered as React children, which auto-escapes — no raw HTML. */
function DiffLineRow({ line }: { line: DiffLine }) {
  const muted = line.type === "hunk" || line.type === "meta" || line.type === "nonewline";
  const marker =
    line.type === "add" ? "+" : line.type === "del" ? "-" : line.type === "context" ? " " : "";
  return (
    <div
      className="diff-line"
      style={{
        display: "flex",
        background: lineBackground(line.type),
        color: muted ? "var(--text-secondary, #8b949e)" : "var(--text-primary)",
        whiteSpace: "pre",
      }}
    >
      <span
        className="diff-gutter"
        style={{
          flex: "0 0 auto",
          width: "3.5em",
          textAlign: "right",
          paddingRight: "0.5em",
          color: "var(--text-secondary, #8b949e)",
          opacity: 0.7,
          userSelect: "none",
        }}
      >
        {line.oldNo ?? ""}
      </span>
      <span
        className="diff-gutter"
        style={{
          flex: "0 0 auto",
          width: "3.5em",
          textAlign: "right",
          paddingRight: "0.5em",
          borderRight: "1px solid var(--border-color)",
          color: "var(--text-secondary, #8b949e)",
          opacity: 0.7,
          userSelect: "none",
        }}
      >
        {line.newNo ?? ""}
      </span>
      <span className="diff-text" style={{ flex: "1 1 auto", paddingLeft: "0.5em" }}>
        {line.type === "hunk" || line.type === "nonewline" ? line.text : marker + line.text}
      </span>
    </div>
  );
}

/**
 * In-app unified-diff viewer (Dev 3 / TODO Group K). Renders a `.diff`/`.patch`
 * file's content, or — when `path` is a real source file — the working-tree diff
 * for that file fetched from the backend (`git_diff_file`). The diff is parsed
 * with `parseUnifiedDiff` and rendered with a two-column (old/new) line-number
 * gutter and add/del/context colouring. All line text is rendered as React
 * children (auto-escaped) — never as raw HTML.
 */
export function DiffView({
  path,
  projectId,
  mode = "git",
  onOpenExternally,
  tabKey: _tabKey,
}: {
  path: string;
  projectId: string | null;
  /** `"git"` (default) diffs the working tree via `git_diff_file`; `"sync"`
   *  diffs the local mirror against the current host over `sync_diff` (SSH
   *  projects). Patch/diff files always render their own raw content regardless. */
  mode?: "git" | "sync";
  onOpenExternally: () => void;
  tabKey?: string;
}) {
  const patchMode = isPatchFile(path);

  // Hooks must run unconditionally. In patch mode we use this file's content; in
  // source mode we ignore it (and fetch the diff via the backend instead).
  const fileState = useReadonlyFile(path);

  const project = useProjectsStore((s) => s.projects.find((p) => p.id === projectId));
  const projectDir = resolveProjectDirectory(project);
  const relPath = relFromAbs(projectDir, path);

  // Source-mode: fetch the diff on mount (and whenever the target changes) — the
  // working-tree diff via `git_diff_file`, or the host-vs-mirror diff via
  // `sync_diff` when this pane is a sync diff.
  const [gitText, setGitText] = useState<string | null>(null);
  const [gitError, setGitError] = useState<string | null>(null);
  useEffect(() => {
    if (patchMode) return;
    let cancelled = false;
    setGitText(null);
    setGitError(null);
    const req =
      mode === "sync"
        ? invoke<string>("sync_diff", { projectId, relPath })
        : invoke<string>("git_diff_file", { projectDir, relPath });
    req
      .then((text) => {
        if (!cancelled) setGitText(text);
      })
      .catch((e) => {
        if (!cancelled) setGitError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [patchMode, mode, projectId, projectDir, relPath]);

  const text = patchMode ? fileState.content : gitText;
  const error = patchMode ? fileState.error : gitError;
  const loaded = text != null;

  const files = useMemo(() => (text != null ? parseUnifiedDiff(text) : []), [text]);

  return (
    <ViewerHeader onOpenExternally={onOpenExternally}>
      <div
        className="diff-viewer"
        style={{
          position: "absolute",
          inset: 0,
          top: "var(--file-viewer-header-h, 36px)",
          overflow: "auto",
          background: "var(--bg-panel)",
          color: "var(--text-primary)",
          fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)",
          fontSize: "12px",
          lineHeight: "1.5",
        }}
      >
        {error != null ? (
          <div className="diff-error" style={{ padding: "1rem", color: "#f85149" }}>
            {error}
          </div>
        ) : !loaded ? (
          <div className="diff-loading" style={{ padding: "1rem", color: "var(--text-secondary, #8b949e)" }}>
            Loading diff…
          </div>
        ) : files.length === 0 ? (
          <div className="diff-empty" style={{ padding: "1rem", color: "var(--text-secondary, #8b949e)" }}>
            No changes.
          </div>
        ) : (
          files.map((file, fi) => (
            <div className="diff-file" key={`${file.newPath}:${fi}`}>
              <div
                className="diff-file-header"
                style={{
                  padding: "0.4em 0.75em",
                  background: "var(--bg-elevated, rgba(255,255,255,0.04))",
                  borderTop: fi > 0 ? "1px solid var(--border-color)" : undefined,
                  borderBottom: "1px solid var(--border-color)",
                  fontWeight: 600,
                  position: "sticky",
                  top: 0,
                }}
              >
                {file.newPath && file.newPath !== "/dev/null" ? file.newPath : file.oldPath}
              </div>
              {file.hunks.map((hunk, hi) => (
                <div className="diff-hunk" key={hi}>
                  {hunk.lines.map((line, li) => (
                    <DiffLineRow line={line} key={li} />
                  ))}
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </ViewerHeader>
  );
}
