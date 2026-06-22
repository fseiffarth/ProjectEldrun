import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ProjectBox, ProjectEntry } from "../../types";
import { useTabsStore } from "../../stores/tabs";
import { boxScopeId } from "../../stores/boxes";
import { PILL_DRAG_TYPE } from "./ProjectPill";

interface ContextMenuPos {
  x: number;
  y: number;
}

interface Props {
  box: ProjectBox;
  /** The box's active member projects, rendered in the hover dropdown. */
  members: ProjectEntry[];
  /** Click the pill → open the box scope (like opening a project). */
  onOpen: () => void;
  /** A project pill was dropped on the box → assign it to this box. */
  onAssign: (projectId: string) => void;
  /** Click a member in the dropdown → switch to that project. */
  onSelectMember: (projectId: string) => void;
  /** Remove a member from the box (ungroup it). */
  onRemoveMember: (projectId: string) => void;
  onRename: (name: string) => void;
  onDelete: () => void;
}

/**
 * A box rendered as a single project-style pill (`.project-pill.is-box`): a box
 * icon + the box name, with the member count as a badge. It looks like a
 * `ProjectPill` but differs in its hover affordance — instead of an info popup it
 * opens a dropdown LISTING the member projects (click one to switch to it).
 * Clicking the pill opens the box scope; dropping a project pill on it assigns
 * that project to the box (same `PILL_DRAG_TYPE` as pill reorder). Right-click
 * exposes Open / Rename / Delete.
 */
export function BoxPill({
  box,
  members,
  onOpen,
  onAssign,
  onSelectMember,
  onRemoveMember,
  onRename,
  onDelete,
}: Props) {
  const [dragOver, setDragOver] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuPos | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(box.name);
  const [pos, setPos] = useState<{ x: number; y: number; width: number } | null>(null);
  const pillRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number | null>(null);

  const scope = useTabsStore((s) => s.scope);
  const active = scope === boxScopeId(box.id);

  // Keep the dropdown anchored under the pill and follow horizontal pill
  // scrolling / window resizes while it is open.
  useEffect(() => {
    if (!menuOpen) {
      setPos(null);
      return;
    }
    const update = () => {
      const el = pillRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setPos({ x: r.left, y: r.bottom, width: r.width });
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!contextMenu) return;
    const dismiss = () => setContextMenu(null);
    window.addEventListener("pointerdown", dismiss);
    return () => window.removeEventListener("pointerdown", dismiss);
  }, [contextMenu]);

  useEffect(() => {
    return () => {
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    };
  }, []);

  // The pill and the (portaled) dropdown are separate DOM subtrees, so a plain
  // onMouseLeave would close the list the instant the pointer crosses the gap.
  // Debounce closing so the pointer can travel from pill to dropdown.
  const openMenu = () => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    setMenuOpen(true);
  };
  const scheduleClose = () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setMenuOpen(false), 120);
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenuOpen(false);
    const y = pillRef.current ? pillRef.current.getBoundingClientRect().bottom : e.clientY;
    setContextMenu({ x: e.clientX, y });
  };

  const commitRename = () => {
    const next = renameValue.trim();
    if (next && next !== box.name) onRename(next);
    setRenaming(false);
  };

  return (
    <>
      <div
        ref={pillRef}
        className={`project-pill is-box${active ? " active" : ""}${dragOver ? " drag-over" : ""}`}
        onMouseEnter={openMenu}
        onMouseLeave={scheduleClose}
        onContextMenu={handleContextMenu}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(PILL_DRAG_TYPE)) return;
          // Claim the drop so the underlying pills-row handler (ungroup) never
          // fires for a drop on the box pill.
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = "move";
          if (!dragOver) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          if (!e.dataTransfer.types.includes(PILL_DRAG_TYPE)) return;
          e.preventDefault();
          e.stopPropagation();
          setDragOver(false);
          const fromId = e.dataTransfer.getData(PILL_DRAG_TYPE);
          if (fromId) onAssign(fromId);
        }}
      >
        {renaming ? (
          <input
            className="project-box-rename-input"
            autoFocus
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") {
                setRenameValue(box.name);
                setRenaming(false);
              }
            }}
          />
        ) : (
          <button className="pill-main" onClick={onOpen} title={`${box.name} (box) — click to open`}>
            <span className="pill-folder-icon" aria-hidden>
              ▣
            </span>
            <span className="project-pill-label">{box.name}</span>
            <span className="project-box-member-count" title={`${members.length} member(s)`}>
              {members.length}
            </span>
          </button>
        )}
      </div>

      {/* Hover dropdown listing the member projects. */}
      {menuOpen &&
        pos &&
        createPortal(
          <div
            ref={listRef}
            className="project-box-dropdown"
            style={{ left: pos.x, top: pos.y, minWidth: pos.width }}
            onMouseEnter={openMenu}
            onMouseLeave={scheduleClose}
            onContextMenu={(e) => e.stopPropagation()}
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes(PILL_DRAG_TYPE)) return;
              e.preventDefault();
              e.stopPropagation();
              e.dataTransfer.dropEffect = "move";
            }}
            onDrop={(e) => {
              if (!e.dataTransfer.types.includes(PILL_DRAG_TYPE)) return;
              e.preventDefault();
              e.stopPropagation();
              const fromId = e.dataTransfer.getData(PILL_DRAG_TYPE);
              if (fromId) onAssign(fromId);
            }}
          >
            {members.length === 0 ? (
              <div className="project-box-dropdown-hint">No members</div>
            ) : (
              members.map((m) => (
                <div className="project-box-member-row" key={m.id}>
                  <button
                    type="button"
                    className="project-box-member-open"
                    onClick={() => {
                      setMenuOpen(false);
                      onSelectMember(m.id);
                    }}
                    title={`Switch to ${m.name}`}
                  >
                    <span className="pill-folder-icon" aria-hidden>
                      📁
                    </span>
                    {m.name}
                  </button>
                  <button
                    type="button"
                    className="project-box-member-remove"
                    onClick={() => onRemoveMember(m.id)}
                    title="Remove from box"
                  >
                    ×
                  </button>
                </div>
              ))
            )}
          </div>,
          document.body,
        )}

      {contextMenu &&
        createPortal(
          <div
            className="context-menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => {
                setContextMenu(null);
                onOpen();
              }}
            >
              Open box
            </button>
            <button
              onClick={() => {
                setContextMenu(null);
                setRenameValue(box.name);
                setRenaming(true);
              }}
            >
              Rename
            </button>
            <button
              className="danger"
              onClick={() => {
                setContextMenu(null);
                onDelete();
              }}
            >
              Delete box
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}
