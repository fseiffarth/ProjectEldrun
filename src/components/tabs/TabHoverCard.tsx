import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { TabKind } from "../../stores/tabs";
import { TAB_ACCENT } from "./newTabItems";

/** Friendly, human-readable name for a tab kind, shown as the card's muted
 *  sub-line. Falls back to the raw kind for anything unmapped. */
const KIND_LABEL: Record<TabKind, string> = {
  agent: "AI agent",
  local_agent: "Local agent",
  shell: "Shell",
  files: "Files",
  embed: "Embedded app",
  projects3d: "Projects (3D)",
  network: "Network traffic",
  monitor: "System monitor",
  diskusage: "Disk usage",
  calendar: "Calendar",
};

/** Gap between the tab and the card, and the keep-inside-the-window margin. */
const GAP = 6;
const MARGIN = 8;

/**
 * Hover card for a tab — the tab-bar counterpart to `ProjectHoverCard`. Reuses
 * the project popup's row classes so the two hovers look identical, and adds the
 * agent task summary (captured from the terminal title). Rendered into a portal.
 *
 * `anchorX` is the tab's horizontal centre and `anchorY` its bottom edge. The
 * card measures itself and clamps into the viewport (a tab near the right/left
 * edge would otherwise push the centred card off-screen — "out of the app"), and
 * flips above the bar if it would overflow the bottom.
 */
export function TabHoverCard({
  label,
  kind,
  cwd,
  sessionId,
  summary,
  anchorX,
  anchorY,
}: {
  label: string;
  kind: TabKind;
  cwd: string;
  sessionId?: string;
  /** The agent task summary (terminal title); omitted when the tab set none. */
  summary?: string;
  anchorX: number;
  anchorY: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // null until measured — kept hidden for that first frame so the clamp doesn't
  // flash the card at the un-clamped position.
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    // Centre under the tab, then clamp horizontally within the window.
    let left = anchorX - width / 2;
    left = Math.max(MARGIN, Math.min(left, window.innerWidth - MARGIN - width));
    // Below the bar by default; flip above it if that would run off the bottom.
    let top = anchorY + GAP;
    if (top + height > window.innerHeight - MARGIN) {
      top = Math.max(MARGIN, anchorY - height - GAP);
    }
    setPos({ left, top });
  }, [anchorX, anchorY, label, kind, cwd, sessionId, summary]);

  return createPortal(
    <div
      ref={ref}
      className="project-pill-popup tab-popup"
      style={{
        left: pos?.left ?? anchorX,
        top: pos?.top ?? anchorY,
        // Own the position via left/top (with JS clamping); drop the shared
        // class's centring transform so the measured box maps 1:1 to the window.
        transform: "none",
        visibility: pos ? "visible" : "hidden",
      }}
    >
      <span className="tab-popup-header">
        <span className="tab-popup-dot" style={{ color: TAB_ACCENT[kind] }}>
          ●
        </span>
        <span className="tab-popup-label">{label}</span>
      </span>
      {summary && <span className="pill-popup-description">{summary}</span>}
      <span className="tab-popup-kind">{KIND_LABEL[kind] ?? kind}</span>
      {cwd && <span className="pill-popup-path">{cwd}</span>}
      {sessionId && (
        <span className="pill-popup-path-row">
          <span className="pill-popup-path-label">session</span>
          <span className="pill-popup-path">{sessionId}</span>
        </span>
      )}
    </div>,
    document.body,
  );
}
