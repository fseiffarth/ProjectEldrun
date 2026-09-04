import { useEffect, useMemo, useRef, useState } from "react";
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
  /** The selected box's scope is the current one — the pill row's `active`
   *  treatment, driven off `scope` exactly as every pill beside it is. */
  active?: boolean;
  /** A project pill's pointer-drag is over the chip (see ProjectPill's
   *  `startPillDrag`, which hit-tests `data-box-id` across the whole pills
   *  region — the chip sits outside the scrolling strip). */
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
 * members were on screen twice at once. The chip ended that — it names the box
 * you are looking at, its dropdown is the only place boxes are listed, and
 * picking one **slices the strip** to that box's members.
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

  // What the chip NAMES right now. The built-in scopes win over the slice
  // because picking either clears the slice — so the chip always names the one
  // thing the leading segment currently stands for.
  const naming: "root" | "trash" | "box" | null = rootActive
    ? "root"
    : trashActive && trash
      ? "trash"
      : selected
        ? "box"
        : null;

  // The chip wears the pill row's working / waiting / finished strip, for the
  // reason the root pill did before it folded in here: these scopes hold
  // ordinary tabs running the same agents, and the one control standing for all
  // of them could otherwise only be read as "nothing is running in any of
  // them". It spans everything it can reach — root, Trash, every box — and
  // narrows to ONE scope only while a box slice is selected, because a slice is
  // a filter the user chose and the chip is then that box's control. Naming root
  // or Trash narrows nothing: that is where you are standing, not a filter, and
  // sitting in the root terminal is precisely when a box quietly waiting on a
  // decision must still be able to say so. Each bar opens its own tab
  // (`jumpToTab` enters a box scope on its own). Only boxes opened this session
  // have tabs at all; an unopened one runs nothing, so it has nothing to report
  // rather than a state that is being withheld.
  const barScopes = useMemo(() => {
    if (naming === "box" && selected) return [`${BOX_SCOPE_PREFIX}${selected.id}`];
    return [
      ROOT_SCOPE,
      ...(trash ? [trash.id] : []),
      ...boxes.map((b) => `${BOX_SCOPE_PREFIX}${b.id}`),
    ];
  }, [boxes, naming, selected, trash]);
  // Names only while the strip spans several scopes; narrowed to the box the
  // chip already names, prefixing every bar with it says nothing twice.
  const allScopeNames = useMemo(
    () => ({
      [ROOT_SCOPE]: t("boxChip.rootLabel"),
      ...(trash ? { [trash.id]: trash.name } : {}),
      ...Object.fromEntries(boxes.map((b) => [`${BOX_SCOPE_PREFIX}${b.id}`, b.name])),
    }),
    [boxes, trash, t],
  );
  const barNames = naming === "box" ? undefined : allScopeNames;

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
    if (selected) return t("boxChip.selectedTitle", { name: selected.name });
    return t("boxChip.pickerTitle");
  };

  const chipLabel = () => {
    if (naming === "root") return t("boxChip.rootLabel");
    if (naming === "trash") return trash?.name ?? "";
    if (selected) return selected.name;
    return null;
  };

  const station = naming === "root" ? rootStation : naming === "trash" ? trashStation : undefined;

  return (
    <>
      <div
        ref={chipRef}
        // The assign-to-box drop target. Only the SELECTED box is addressable
        // by a drag — dropping onto a chip means "into the box I am looking
        // at"; every other box is one right-click away on the pill itself
        // (its menu carries a checkbox row per box).
        data-box-id={selected?.id}
        className={`box-chip${active || rootActive || trashActive ? " active" : ""}${
          naming ? " filtering" : ""
        }${forcedDragOver ? " drag-over" : ""}`}
        onMouseEnter={reveal}
        onMouseLeave={scheduleClose}
        onContextMenu={(e) => {
          if (naming !== "box" || !selected) return;
          e.preventDefault();
          e.stopPropagation();
          dismiss();
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
            {naming === "box" && selected && (
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
        <ScopeSetStatusBars scopes={barScopes} nameByScope={barNames} />
        {/* Steering-mode station number, for the built-in scope the chip is
            naming — the root pill used to carry its own. */}
        {station != null && (
          <span className="steering-station-chip" aria-hidden>
            {station}
          </span>
        )}
      </div>

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
