import { useCallback, useMemo, useState } from "react";
import type { InternalViewer } from "../../../lib/viewers/fileUtils";
import { fileIcon } from "../../../lib/viewers/fileUtils";
import type { TexFileNode, TexGraphicNode, TexStructure } from "../../../lib/viewers/tex";
import { useT } from "../../../lib/i18n";

/**
 * The workspace's "back to the file I was on" button, rendered in both the
 * sidebar's header and its folded rail — one component, so the two cannot end up
 * describing the same step differently.
 *
 * Shown DISABLED rather than hidden when there is nowhere to go back to: this is
 * the only navigation control the workspace has, and one that appears the moment
 * a file is opened is a control nobody finds before they need it.
 */
function TexBackButton({ onBack, backLabel }: { onBack?: () => void; backLabel?: string }) {
  const t = useT();
  const title = onBack
    ? t("texWorkspace.back", { name: backLabel ?? "" })
    : t("texWorkspace.backEmpty");
  return (
    <button
      type="button"
      className="tex-structure-chrome-btn tex-structure-back"
      title={title}
      aria-label={title}
      disabled={!onBack}
      onClick={onBack}
    >
      ←
    </button>
  );
}

/**
 * The folded structure sidebar: a thin vertical rail carrying the way back out
 * of the fold and the Back button beside it. The fold never leaves a bare pane
 * edge — a sidebar that can only be recovered from a settings panel (or not at
 * all) is a one-way door, and this tab has no other chrome to put the control in.
 */
export function TexStructureRail({
  onShow,
  onBack,
  backLabel,
}: {
  onShow: () => void;
  onBack?: () => void;
  backLabel?: string;
}) {
  const t = useT();
  return (
    <div className="tex-structure-rail">
      <button
        type="button"
        className="tex-structure-chrome-btn"
        title={t("texWorkspace.showStructure")}
        aria-label={t("texWorkspace.showStructure")}
        onClick={onShow}
      >
        ›
      </button>
      <TexBackButton onBack={onBack} backLabel={backLabel} />
    </div>
  );
}

/** Extension of a basename, lower-cased, for `fileIcon`. */
function extOf(name: string): string | null {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : null;
}

/** A file (child `.tex`) and its graphics, bucketed under the sectioning heading
 *  they sit beneath in their parent — the grouping the sidebar renders. */
interface SectionBucket {
  section: string; // "" = no heading (the file preamble / un-sectioned front)
  children: TexFileNode[];
  graphics: TexGraphicNode[];
}

/** Group a node's direct children and graphics by their `section`, preserving
 *  first-appearance order of the headings and, within each, child files before
 *  their graphics (the plan's v1 ordering). */
function bucketize(node: TexFileNode): SectionBucket[] {
  const order: string[] = [];
  const map = new Map<string, SectionBucket>();
  const ensure = (section?: string): SectionBucket => {
    const key = section ?? "";
    let b = map.get(key);
    if (!b) {
      b = { section: key, children: [], graphics: [] };
      map.set(key, b);
      order.push(key);
    }
    return b;
  };
  for (const c of node.children) ensure(c.section).children.push(c);
  for (const g of node.graphics) ensure(g.section).graphics.push(g);
  return order.map((k) => map.get(k)!);
}

/**
 * The TeX workspace's LEFT STRUCTURE SIDEBAR: a read-only tree of the main
 * document's inputted `.tex` children and its `\includegraphics` graphics,
 * grouped by the section heading each sits under. Clicking an entry asks the
 * host to switch the workspace's center view to that file (a child `.tex` → the
 * TeX editor, a graphic → the image viewer) — it NEVER opens a tab.
 *
 * Purely presentational: it takes the already-parsed `structure`, the active
 * path, and `onSelect`, and owns nothing but its own hover/resize interaction.
 * It deliberately imports only i18n + `fileIcon` (never `FileViewerPane`), so
 * the leaf stays out of the viewer's import graph.
 */
export function TexStructureSidebar({
  structure,
  activePath,
  width,
  onSelect,
  onResize,
  onHide,
  onNewFile,
  onBack,
  backLabel,
}: {
  structure: TexStructure;
  /** Absolute path of the file currently centered, for the active highlight. */
  activePath: string;
  /** Current sidebar width in px. */
  width: number;
  /** Switch the center to `path`, rendered with `viewer`. */
  onSelect: (path: string, viewer: InternalViewer) => void;
  /** Persist a drag-resized width (fired on pointer-up, not per move). */
  onResize: (width: number) => void;
  /** Fold the sidebar away to its rail. */
  onHide: () => void;
  /** Open the host's "add a file to this document" prompt (#tex-structure-newfile).
   *  Absent = the host has nowhere to create one, and the button is not shown. */
  onNewFile?: () => void;
  /** Go back to the previously centered file; absent = nothing to go back to. */
  onBack?: () => void;
  /** Basename of what `onBack` would return to, for the button's title. */
  backLabel?: string;
}) {
  const t = useT();
  const [liveWidth, setLiveWidth] = useState<number | null>(null);
  const shownWidth = liveWidth ?? width;

  const startResize = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      const startX = e.clientX;
      const startW = shownWidth;
      let last = startW;
      const onMove = (ev: PointerEvent) => {
        last = Math.max(140, Math.min(520, startW + (ev.clientX - startX)));
        setLiveWidth(last);
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        setLiveWidth(null);
        if (last !== startW) onResize(last);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [shownWidth, onResize],
  );

  const root = structure.root;

  // The whole tree flattened for keyboard nav is overkill for v1; render the
  // root as the "main" row, then its section-grouped buckets recursively.
  const rootBuckets = useMemo(() => bucketize(root), [root]);

  const renderFileRow = (node: TexFileNode, depth: number) => (
    <button
      key={`f:${node.path}`}
      type="button"
      className={`tex-structure-row tex-structure-file${node.path === activePath ? " is-active" : ""}`}
      style={{ paddingLeft: 8 + depth * 14 }}
      aria-current={node.path === activePath ? "true" : undefined}
      title={node.path}
      onClick={() => onSelect(node.path, "tex")}
    >
      <span className="tex-structure-icon" aria-hidden="true">{fileIcon(extOf(node.label))}</span>
      <span className="tex-structure-label">{node.label}</span>
    </button>
  );

  const renderGraphicRow = (g: TexGraphicNode, depth: number) => (
    <button
      key={`g:${g.path}`}
      type="button"
      className={`tex-structure-row tex-structure-graphic${g.path === activePath ? " is-active" : ""}`}
      style={{ paddingLeft: 8 + depth * 14 }}
      aria-current={g.path === activePath ? "true" : undefined}
      title={g.path}
      onClick={() => onSelect(g.path, g.viewer)}
    >
      <span className="tex-structure-icon" aria-hidden="true">🖼</span>
      <span className="tex-structure-label">{g.label}</span>
    </button>
  );

  // Recursively render a node's buckets. A child file row is followed by its own
  // buckets one level deeper, so the tree reads as the document's nesting.
  const renderBuckets = (node: TexFileNode, depth: number): React.ReactNode =>
    bucketize(node).map((b, i) => (
      <div key={`b:${node.path}:${i}`} className="tex-structure-section">
        {b.section && (
          <div className="tex-structure-heading" style={{ paddingLeft: 8 + depth * 14 }}>
            {b.section}
          </div>
        )}
        {b.children.map((c) => (
          <div key={`c:${c.path}`}>
            {renderFileRow(c, depth)}
            {renderBuckets(c, depth + 1)}
          </div>
        ))}
        {b.graphics.map((g) => renderGraphicRow(g, depth))}
      </div>
    ));

  return (
    <div className="tex-structure-sidebar" style={{ width: shownWidth }}>
      <div className="tex-structure-header">
        <TexBackButton onBack={onBack} backLabel={backLabel} />
        <span className="tex-structure-title">{t("texWorkspace.structureTitle")}</span>
        {onNewFile && (
          <button
            type="button"
            className="tex-structure-chrome-btn tex-structure-new"
            title={t("texWorkspace.newFile")}
            aria-label={t("texWorkspace.newFile")}
            onClick={onNewFile}
          >
            ＋
          </button>
        )}
        <button
          type="button"
          className="tex-structure-chrome-btn tex-structure-fold"
          title={t("texWorkspace.hideStructure")}
          aria-label={t("texWorkspace.hideStructure")}
          onClick={onHide}
        >
          ‹
        </button>
      </div>
      <div className="tex-structure-body">
        {renderFileRow(root, 0)}
        {rootBuckets.map((b, i) => (
          <div key={`rb:${i}`} className="tex-structure-section">
            {b.section && (
              <div className="tex-structure-heading" style={{ paddingLeft: 8 }}>
                {b.section}
              </div>
            )}
            {b.children.map((c) => (
              <div key={`c:${c.path}`}>
                {renderFileRow(c, 1)}
                {renderBuckets(c, 2)}
              </div>
            ))}
            {b.graphics.map((g) => renderGraphicRow(g, 1))}
          </div>
        ))}
        {rootBuckets.length === 0 && (
          <div className="tex-structure-empty">{t("texWorkspace.structureEmpty")}</div>
        )}
      </div>
      <div
        className="tex-structure-resize"
        role="separator"
        aria-orientation="vertical"
        onPointerDown={startResize}
      />
    </div>
  );
}
