import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ProjectBox } from "../../types";
import { useBoxEditorStore } from "../../stores/boxEditor";
import { usePillDragStore } from "../../stores/pillDrag";
import { useT } from "../../lib/i18n";

interface Props {
  boxes: ProjectBox[];
  /** The box whose slice the pill strip is showing (`null` = every project). */
  selectedId: string | null;
  /** Pick a box (also opens its scope) or `null` to go back to all projects. */
  onSelect: (boxId: string | null) => void;
  onRename: (boxId: string, name: string) => void;
  onDelete: (boxId: string) => void;
  /** The selected box's scope is the current one — the pill row's `active`
   *  treatment, driven off `scope` exactly as every pill beside it is. */
  active?: boolean;
  /** A project pill's pointer-drag is over the chip (see ProjectPill's
   *  `startPillDrag`, which hit-tests `data-box-id` across the whole pills
   *  region — the chip sits outside the scrolling strip). */
  forcedDragOver?: boolean;
}

/**
 * The boxes control: ONE chip pinned beside the root-terminal pill, left of the
 * scrolling project strip, replacing the per-box pills that used to sit *among*
 * the projects (#13/#41).
 *
 * Boxes and projects were two different kinds of thing wearing one shape in one
 * row — a `.project-pill` click activated a project, an identical-looking one
 * switched to a `box:<id>` scope — and, under the overlay model, a box's members
 * were on screen twice at once: as their own pills and again inside the box
 * pill's hover dropdown. The chip ends both. It names the box you are looking
 * at, its dropdown is the only place boxes are listed, and picking one **slices
 * the strip** to that box's members, so the row below always holds exactly one
 * kind of thing and N boxes cost no strip width at all.
 *
 * The slice is a *view*, not the scope: clicking a member switches to that
 * project (dropping the chip's `active` accent) while the strip stays put, so
 * hopping between a box's projects never reshuffles the row under the pointer.
 * "All projects" is always in the menu, so a slice can never trap anyone away
 * from a project it doesn't list.
 *
 * Renders nothing at all when no box exists — the feature costs the header
 * nothing until it is used.
 */
export function BoxScopeChip({
  boxes,
  selectedId,
  onSelect,
  onRename,
  onDelete,
  active,
  forcedDragOver,
}: Props) {
  const t = useT();
  const [menuOpen, setMenuOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const chipRef = useRef<HTMLDivElement>(null);
  const sprung = useRef(false);

  const selected = selectedId ? (boxes.find((b) => b.id === selectedId) ?? null) : null;

  // Spring-loaded during a pill drag (the PDF page rail's bargain): the strip
  // may be sliced, so the project being dragged is usually not one of the
  // box's own — and with the list folded away the only reachable target would
  // be the box already on screen. A drag in flight therefore opens the list and
  // every row becomes its own drop target; it folds back unless the user had
  // opened it themselves.
  const pillDrag = usePillDragStore((s) => s.drag);
  const dragging = !!pillDrag;
  useEffect(() => {
    if (dragging) {
      setMenuOpen((open) => {
        if (!open) sprung.current = true;
        return true;
      });
      return;
    }
    if (!sprung.current) return;
    sprung.current = false;
    setMenuOpen(false);
  }, [dragging]);

  // Keep the dropdown anchored under the chip while it is open (the header can
  // reflow around it — the pill strip's overflow chevrons appear and vanish).
  useEffect(() => {
    if (!menuOpen) {
      setPos(null);
      return;
    }
    const update = () => {
      const el = chipRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setPos({ x: r.left, y: r.bottom });
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [menuOpen]);

  // Click-opened, not hover-opened like the ⚙/+ menus beside it: the chip is a
  // drop target for a pill drag, and a list unfolding under the cursor mid-drag
  // is exactly what must not happen.
  useEffect(() => {
    if (!menuOpen && !contextMenu) return;
    const onPointer = (e: PointerEvent) => {
      if (chipRef.current?.contains(e.target as Node)) return;
      if ((e.target as HTMLElement).closest?.(".box-chip-menu")) return;
      setMenuOpen(false);
      setContextMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenuOpen(false);
        setContextMenu(null);
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen, contextMenu]);

  if (boxes.length === 0) return null;

  const pick = (boxId: string | null) => {
    setMenuOpen(false);
    onSelect(boxId);
  };

  const commitRename = () => {
    const next = renameValue.trim();
    if (selected && next && next !== selected.name) onRename(selected.id, next);
    setRenaming(false);
  };

  return (
    <>
      <div
        ref={chipRef}
        // The assign-to-box drop target. Only the SELECTED box is addressable
        // by a drag — dropping onto a chip means "into the box I am looking
        // at"; every other box is one right-click away on the pill itself
        // (its menu carries a checkbox row per box).
        data-box-id={selected?.id}
        className={`box-chip${active ? " active" : ""}${selected ? " filtering" : ""}${
          forcedDragOver ? " drag-over" : ""
        }`}
        onContextMenu={(e) => {
          if (!selected) return;
          e.preventDefault();
          e.stopPropagation();
          setMenuOpen(false);
          const bottom = chipRef.current?.getBoundingClientRect().bottom ?? e.clientY;
          setContextMenu({ x: e.clientX, y: bottom });
        }}
      >
        {renaming && selected ? (
          <input
            className="project-box-rename-input"
            autoFocus
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") setRenaming(false);
            }}
          />
        ) : (
          <button
            type="button"
            className="box-chip-main"
            title={
              selected
                ? t("boxChip.selectedTitle", { name: selected.name })
                : t("boxChip.title")
            }
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((v) => !v);
            }}
          >
            <span className="box-chip-icon" aria-hidden>
              ▣
            </span>
            {selected && <span className="box-chip-label">{selected.name}</span>}
            {selected && (
              <span
                className="project-box-member-count"
                title={t(
                  selected.member_ids.length === 1
                    ? "boxPill.memberCountOne"
                    : "boxPill.memberCountMany",
                  { count: selected.member_ids.length },
                )}
              >
                {selected.member_ids.length}
              </span>
            )}
            <span className="box-chip-caret" aria-hidden>
              ▾
            </span>
          </button>
        )}
      </div>

      {menuOpen &&
        pos &&
        createPortal(
          <div className="box-chip-menu" style={{ left: pos.x, top: pos.y }}>
            <button
              className={selectedId === null ? "is-current" : undefined}
              onClick={() => pick(null)}
            >
              {t("boxChip.allProjects")}
            </button>
            <div className="box-chip-menu-sep" />
            {boxes.map((b) => (
              <button
                key={b.id}
                // A drop target in its own right while a pill drag is in
                // flight (see the spring-loaded open above); ProjectPill's
                // hit-test sweeps `[data-box-id]` across the document, so a
                // portaled row counts exactly as the chip does.
                data-box-id={b.id}
                className={`${b.id === selectedId ? "is-current" : ""}${
                  pillDrag?.overBoxId === b.id ? " drag-over" : ""
                }`.trim()}
                onClick={() => pick(b.id)}
                title={t(
                  b.member_ids.length === 1 ? "boxPill.memberCountOne" : "boxPill.memberCountMany",
                  { count: b.member_ids.length },
                )}
              >
                <span className="box-chip-menu-icon" aria-hidden>
                  ▣
                </span>
                <span className="box-chip-menu-name">{b.name}</span>
                <span className="box-chip-menu-count">{b.member_ids.length}</span>
              </button>
            ))}
            <div className="box-chip-menu-sep" />
            <button
              onClick={() => {
                setMenuOpen(false);
                useBoxEditorStore.getState().openCreate();
              }}
            >
              {t("projectSwitcher.newBox")}
            </button>
            <button
              onClick={() => {
                setMenuOpen(false);
                useBoxEditorStore.getState().openEditor(null);
              }}
            >
              {t("pill.editBoxesEllipsis")}
            </button>
          </div>,
          document.body,
        )}

      {contextMenu &&
        selected &&
        createPortal(
          <div
            className="context-menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => {
                setContextMenu(null);
                onSelect(selected.id);
              }}
            >
              {t("boxPill.openBox")}
            </button>
            <button
              onClick={() => {
                setContextMenu(null);
                setRenameValue(selected.name);
                setRenaming(true);
              }}
            >
              {t("common.rename")}
            </button>
            <button
              onClick={() => {
                setContextMenu(null);
                useBoxEditorStore.getState().openEditor(selected.id);
              }}
            >
              {t("boxPill.editBoxEllipsis")}
            </button>
            <button
              className="danger"
              onClick={() => {
                setContextMenu(null);
                onDelete(selected.id);
              }}
            >
              {t("boxPill.deleteBox")}
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}
