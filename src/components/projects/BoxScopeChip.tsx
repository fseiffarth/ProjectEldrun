import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ProjectBox } from "../../types";
import { BOX_SCOPE_PREFIX } from "../../stores/boxes";
import { ROOT_SCOPE } from "../../stores/tabs";
import { useBoxEditorStore } from "../../stores/boxEditor";
import { usePillDragStore } from "../../stores/pillDrag";
import { useHeaderHoverMenuStore } from "../../stores/headerHoverMenu";
import { useT } from "../../lib/i18n";
import { StarIcon } from "../layout/StarIcon";
import { TrashProjectIcon } from "./TrashProjectIcon";
import { ScopeSetStatusBars } from "./PillStatusBars";

/** This chip's entry in the shared header hover-menu id (stores/headerHoverMenu). */
const SCOPE_MENU_ID = "box-scope-chip";

interface Props {
  boxes: ProjectBox[];
  /** The box whose slice the pill strip is showing (`null` = every project). */
  selectedId: string | null;
  /** Pick a box (also opens its scope) or `null` to go back to all projects. */
  onSelect: (boxId: string | null) => void;
  onRename: (boxId: string, name: string) => void;
  onDelete: (boxId: string) => void;
  /** The selected box's scope is the current one — the `active` treatment on
   *  the box's own pill, driven off `scope` exactly as every project pill
   *  beside it is. */
  active?: boolean;
  /** A project pill's pointer-drag is over the selected box's pill (see
   *  ProjectPill's `startPillDrag`, which hit-tests `data-box-id` across the
   *  whole pills region — the pill sits outside the scrolling strip). */
  forcedDragOver?: boolean;
  /** The built-in Trash workspace, when it exists (it always should). */
  trash?: { id: string; name: string } | null;
  /** The root terminal's scope is the current one. */
  rootActive?: boolean;
  /** The Trash workspace's scope is the current one. */
  trashActive?: boolean;
  onSelectRoot: () => void;
  onSelectTrash: () => void;
  /** Keyboard-steering station digits, while steering mode is active. */
  rootStation?: number;
  trashStation?: number;
}

/**
 * The scope chip: ONE control at the head of the pill row standing for every
 * scope that is *not* a project pill — the root terminal, the Trash workspace,
 * and the boxes — left of the scrolling project strip.
 *
 * It started as the boxes control (#13/#41), replacing the per-box pills that
 * used to sit *among* the projects: boxes and projects were two different kinds
 * of thing wearing one shape in one row, and under the overlay model a box's
 * members were on screen twice at once. The chip ended that — its dropdown is
 * the only place boxes are listed, and picking one **slices the strip** to that
 * box's members.
 *
 * The selected box then gets a **pill of its own** immediately right of the
 * chip, rather than being worn on the chip's own face (user, 2026-09-04). The
 * two jobs had been folded into one control: the chip was both the list you
 * open to go somewhere and the thing that says where you are, so re-entering
 * the box you are already looking at meant opening a menu to pick the row
 * already marked current. Splitting them gives the box a standing, clickable
 * destination — a tab in the row, like the projects beside it — while the
 * dropdown stays exactly what it was. This is not the old per-box pills coming
 * back: only the ONE selected box is ever on the row, in the fixed leading
 * segment, so boxes still cost the scrolling strip no width.
 *
 * Root and Trash then joined it, for the same reason and by the same argument:
 * they are built-in scopes, not projects, and each was spending a permanent
 * pill's worth of header on a destination visited by name rather than by
 * pointing. Folding them in leaves the leading segment as a single control that
 * answers "where am I" — Root · Trash · a box · or nothing, meaning an ordinary
 * project — and gives the whole row back to the projects.
 *
 * The slice is a *view*, not the scope: clicking a member switches to that
 * project (dropping the chip's `active` accent) while the strip stays put, so
 * hopping between a box's projects never reshuffles the row under the pointer.
 * "All projects" is always in the menu, so a slice can never trap anyone away
 * from a project it doesn't list — and picking Root or Trash lifts the slice
 * outright, since neither is inside any box and a strip left filtered by a box
 * nobody is in reads as a strip that has lost projects.
 */
export function BoxScopeChip({
  boxes,
  selectedId,
  onSelect,
  onRename,
  onDelete,
  active,
  forcedDragOver,
  trash,
  rootActive,
  trashActive,
  onSelectRoot,
  onSelectTrash,
  rootStation,
  trashStation,
}: Props) {
  const t = useT();
  // Hover-opened through the SHARED header menu id, like the + menu and the
  // cluster menus beside it: one id means opening another header menu closes
  // this one in the same frame instead of both riding out their own 250 ms
  // closing grace. Click still reveals (a click also fires mouseenter, so a
  // toggle here would open on enter and shut again on the click).
  const menuOpen = useHeaderHoverMenuStore((s) => s.openId === SCOPE_MENU_ID);
  const openMenu = useHeaderHoverMenuStore((s) => s.open);
  const closeMenu = useHeaderHoverMenuStore((s) => s.close);
  const closeTimer = useRef<number | undefined>(undefined);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const chipRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLDivElement>(null);
  const sprung = useRef(false);

  const reveal = () => {
    window.clearTimeout(closeTimer.current);
    openMenu(SCOPE_MENU_ID);
  };
  const scheduleClose = () => {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => closeMenu(SCOPE_MENU_ID), 250);
  };
  const dismiss = () => {
    window.clearTimeout(closeTimer.current);
    closeMenu(SCOPE_MENU_ID);
  };
  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  const selected = selectedId ? (boxes.find((b) => b.id === selectedId) ?? null) : null;

  // What the chip NAMES right now — only the built-in scopes. A selected box
  // no longer folds into the chip's face: it gets a pill of its own beside it
  // (below), so the chip is the picker and the pill is the box.
  const naming: "root" | "trash" | null = rootActive
    ? "root"
    : trashActive && trash
      ? "trash"
      : null;

  // The chip itself carries NO status strip (user, 2026-09-07): it is the
  // shortest control on the row — an icon, a word and a caret — and a band of
  // bars across its bottom edge was more than it had room for. What it used to
  // tally is still on screen in the two places that do have the room: the
  // selected box's own pill beside it, and the dropdown rows, which are the
  // only enumeration of the boxes and say WHICH one wants something.

  // Spring-loaded during a pill drag (the PDF page rail's bargain): the strip
  // may be sliced, so the project being dragged is usually not one of the
  // box's own — and with the list folded away the only reachable target would
  // be the box already on screen. A drag in flight therefore opens the list and
  // every box row becomes its own drop target; it folds back unless the user
  // had opened it themselves.
  const pillDrag = usePillDragStore((s) => s.drag);
  const dragging = !!pillDrag;
  useEffect(() => {
    if (dragging) {
      if (!menuOpen) sprung.current = true;
      reveal();
      return;
    }
    if (!sprung.current) return;
    sprung.current = false;
    dismiss();
    // `menuOpen` is read only to remember whether the drag is what opened the
    // list; re-running on it would fold the list back mid-drag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // A press outside the chip and its portaled list, or Escape, closes both it
  // and the box context menu — the hover grace alone can't catch a pointer that
  // jumps straight out of the header.
  useEffect(() => {
    if (!menuOpen && !contextMenu) return;
    const onPointer = (e: PointerEvent) => {
      if (chipRef.current?.contains(e.target as Node)) return;
      // The box pill hosts the rename input and the box context menu, so a
      // press inside it must not fold either away under the pointer.
      if (pillRef.current?.contains(e.target as Node)) return;
      if ((e.target as HTMLElement).closest?.(".box-chip-menu")) return;
      dismiss();
      setContextMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        dismiss();
        setContextMenu(null);
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menuOpen, contextMenu]);

  const pick = (boxId: string | null) => {
    dismiss();
    onSelect(boxId);
  };

  const commitRename = () => {
    const next = renameValue.trim();
    if (selected && next && next !== selected.name) onRename(selected.id, next);
    setRenaming(false);
  };

  const chipTitle = () => {
    if (naming === "root") return t("header.rootProject");
    if (naming === "trash") return t("pill.trashProjectTitle");
    return t("boxChip.pickerTitle");
  };

  const chipLabel = () => {
    if (naming === "root") return t("boxChip.rootLabel");
    if (naming === "trash") return trash?.name ?? "";
    return null;
  };

  const station = naming === "root" ? rootStation : naming === "trash" ? trashStation : undefined;

  return (
    <>
      <div
        ref={chipRef}
        className={`box-chip${rootActive || trashActive ? " active" : ""}${
          naming || selected ? " filtering" : ""
        }`}
        onMouseEnter={reveal}
        onMouseLeave={scheduleClose}
      >
        <button
          type="button"
          className="box-chip-main"
          title={chipTitle()}
          onClick={(e) => {
            e.stopPropagation();
            reveal();
          }}
          onFocus={reveal}
        >
          {naming === "root" ? (
            <StarIcon className="box-chip-star" />
          ) : naming === "trash" ? (
            <TrashProjectIcon className="box-chip-trash-icon" />
          ) : (
            <span className="box-chip-icon" aria-hidden>
              ▣
            </span>
          )}
          {chipLabel() && <span className="box-chip-label">{chipLabel()}</span>}
          <span className="box-chip-caret" aria-hidden>
            ▾
          </span>
        </button>
        {/* Steering-mode station number, for the built-in scope the chip is
            naming — the root pill used to carry its own. */}
        {station != null && (
          <span className="steering-station-chip" aria-hidden>
            {station}
          </span>
        )}
      </div>

      {/* The selected box's own pill, right of the chip. The chip picks a box;
          the pill IS that box — it names it, counts its members, wears its own
          status strip, takes the drop of a project dragged "into the box I am
          looking at", and one click enters its scope without going back through
          a menu. Deliberately the chip's own box (`.box-chip`, minus the caret)
          rather than a shape of its own, so the leading segment stays one run.
          It is NOT a second copy of the boxes list: only the selected box is
          ever here, and every other box stays one hover of the chip away. */}
      {selected && (
        <div
          ref={pillRef}
          // The assign-to-box drop target. Only the SELECTED box is addressable
          // by a drag — dropping onto the pill means "into the box I am looking
          // at"; every other box is a row in the sprung-open chip list, or one
          // right-click away on the pill itself.
          data-box-id={selected.id}
          className={`box-chip box-scope-pill filtering${active ? " active" : ""}${
            forcedDragOver ? " drag-over" : ""
          }`}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            dismiss();
            const bottom = pillRef.current?.getBoundingClientRect().bottom ?? e.clientY;
            setContextMenu({ x: e.clientX, y: bottom });
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
                if (e.key === "Escape") setRenaming(false);
              }}
            />
          ) : (
            <button
              type="button"
              className="box-chip-main"
              title={t("boxScopePill.title", { name: selected.name })}
              onClick={(e) => {
                e.stopPropagation();
                onSelect(selected.id);
              }}
            >
              <span className="box-chip-icon" aria-hidden>
                ▣
              </span>
              <span className="box-chip-label">{selected.name}</span>
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
            </button>
          )}
          <ScopeSetStatusBars scopes={[`${BOX_SCOPE_PREFIX}${selected.id}`]} />
        </div>
      )}

      {menuOpen &&
        pos &&
        createPortal(
          <div
            className="box-chip-menu"
            style={{ left: pos.x, top: pos.y }}
            // The list is portaled to <body>, so the pointer travelling down
            // into it has LEFT the chip: without these the 250 ms grace would
            // fold it away under the cursor. It opens flush under the chip, so
            // there is no gap to cross.
            onMouseEnter={reveal}
            onMouseLeave={scheduleClose}
          >
            {/* The built-in scopes, ahead of the boxes and of "All projects":
                they are destinations, not slices, and picking either lifts the
                slice (neither is in any box). */}
            <button
              className={rootActive ? "is-current" : undefined}
              title={t("header.rootProject")}
              onClick={() => {
                dismiss();
                onSelectRoot();
              }}
            >
              <StarIcon className="box-chip-menu-star" />
              <span className="box-chip-menu-name">{t("boxChip.rootRow")}</span>
              <ScopeSetStatusBars
                scopes={[ROOT_SCOPE]}
                interactive={false}
                className="inline"
              />
              {rootStation != null && (
                <span className="box-chip-menu-count">{rootStation}</span>
              )}
            </button>
            {trash && (
              <button
                className={trashActive ? "is-current" : undefined}
                title={t("pill.trashProjectTitle")}
                onClick={() => {
                  dismiss();
                  onSelectTrash();
                }}
              >
                <TrashProjectIcon className="box-chip-menu-trash-icon" />
                <span className="box-chip-menu-name">{trash.name}</span>
                <ScopeSetStatusBars
                  scopes={[trash.id]}
                  interactive={false}
                  className="inline"
                />
                {trashStation != null && (
                  <span className="box-chip-menu-count">{trashStation}</span>
                )}
              </button>
            )}
            <div className="box-chip-menu-sep" />
            <button
              className={selectedId === null ? "is-current" : undefined}
              onClick={() => pick(null)}
            >
              {t("boxChip.allProjects")}
            </button>
            {boxes.length > 0 && <div className="box-chip-menu-sep" />}
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
                {/* The list is the only place boxes are enumerated, so it is
                    also the only place that can say WHICH box wants something
                    once the chip has folded back to one. Inert bars: the row is
                    already a button, and picking the box is the way in from
                    here. */}
                <ScopeSetStatusBars
                  scopes={[`${BOX_SCOPE_PREFIX}${b.id}`]}
                  interactive={false}
                  className="inline"
                />
                <span className="box-chip-menu-count">{b.member_ids.length}</span>
              </button>
            ))}
            <div className="box-chip-menu-sep" />
            <button
              onClick={() => {
                dismiss();
                useBoxEditorStore.getState().openCreate();
              }}
            >
              {t("projectSwitcher.newBox")}
            </button>
            <button
              onClick={() => {
                dismiss();
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
