import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ProjectPill } from "../projects/ProjectPill";
import { BoxScopeChip } from "../projects/BoxScopeChip";
import { usePillDragStore } from "../../stores/pillDrag";
import { ProjectSearch } from "../projects/ProjectSearch";
import { ProjectDialog } from "../projects/ProjectDialog";
import { SettingsDialog, type SettingsPanelKind } from "./SettingsPanel";
import { UntestedTag } from "../common/UntestedTag";
import { StarIcon } from "./StarIcon";
import { useHpcPipelineStore } from "../../stores/hpcPipeline";
import { useBigFoldersStore } from "../../stores/bigFolders";
import { useProjectsStore } from "../../stores/projects";
import { BOX_SCOPE_PREFIX, useBoxMembership, useBoxesStore } from "../../stores/boxes";
import { useBoxEditorStore } from "../../stores/boxEditor";
import { usePillSelectionStore } from "../../stores/pillSelection";
import { useHeaderHoverMenuStore } from "../../stores/headerHoverMenu";
import { TRASH_PROJECT_ID } from "../../lib/trashProject";
import { ROOT_SCOPE, useTabsStore } from "../../stores/tabs";
import { PillStatusBars } from "../projects/PillStatusBars";
import { useGitDirtyStore } from "../../stores/gitDirty";
import { useQuiesce, saverInterval } from "../../stores/power";
import { useFastMode } from "../../lib/fastMode";
import { resolveProjectDirectory, type ProjectEntry } from "../../types";
import { useT } from "../../lib/i18n";

// Re-exported for tests and any external callers that imported these scaffold
// helpers from ProjectSwitcher before the dialog was extracted (the public
// import surface of this module is intentionally kept stable).
export {
  agentForScaffoldFillMode,
  buildDescriptionFillPrompt,
  buildScaffoldFillPrompt,
  collectScaffoldAgentFills,
} from "../projects/scaffold";

/** This bar's entry in the shared header hover-menu id (stores/headerHoverMenu). */
const ADD_MENU_ID = "project-add";

export function ProjectSwitcher({ open = true }: { open?: boolean }) {
  const t = useT();
  const { projects, setActive, addProject, deactivateProject, reorderProjects } = useProjectsStore();
  const boxes = useBoxesStore((s) => s.boxes);
  const renameBox = useBoxesStore((s) => s.renameBox);
  const deleteBox = useBoxesStore((s) => s.deleteBox);
  const addToBox = useBoxesStore((s) => s.addToBox);
  const removeFromBox = useBoxesStore((s) => s.removeFromBox);
  const boxProjects = useBoxesStore((s) => s.boxProjects);
  const openBox = useBoxesStore((s) => s.openBox);
  const membership = useBoxMembership();
  const openHpcWizard = useHpcPipelineStore((s) => s.openWizard);
  // Multi-select (3b): Escape clears the Ctrl/Cmd-click pill selection.
  const anySelected = usePillSelectionStore((s) => s.selected.length > 0);
  useEffect(() => {
    if (!anySelected) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") usePillSelectionStore.getState().clear();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [anySelected]);
  // The currently-displayed scope is the single source of truth for which pill
  // is highlighted (the box chip keys off it too). Opening a box moves the scope but
  // not `activeId`, so highlighting on `activeId` would leave the previously
  // active project pill stuck-on while a box is open — drive it off scope.
  const scope = useTabsStore((s) => s.scope);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsPanel, setSettingsPanel] = useState<SettingsPanelKind>("main");
  // "clone" is the import dialog opened straight onto its GitHub/GitLab source —
  // the same dialog, so the source can still be switched back inside it.
  const [dialog, setDialog] = useState<"new" | "import" | "clone" | null>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);
  // The + menu is the switcher's ONLY menu now (the ⚙ moved into the header's
  // global cluster as `header/SettingsMenu`), and it rides the SHARED header
  // hover-menu id like every other menu in this bar. It used to run on its own
  // timer, which is what let it render *alongside* a cluster menu the pointer
  // had already moved to: one menu's 250 ms closing grace is the other menu's
  // opening frame. See stores/headerHoverMenu.
  const showAddMenu = useHeaderHoverMenuStore((s) => s.openId === ADD_MENU_ID);
  const openHeaderMenu = useHeaderHoverMenuStore((s) => s.open);
  const closeHeaderMenu = useHeaderHoverMenuStore((s) => s.close);
  const addCloseTimer = useRef<number | undefined>(undefined);

  const revealAddMenu = () => {
    setShowSettings(false);
    window.clearTimeout(addCloseTimer.current);
    openHeaderMenu(ADD_MENU_ID);
  };
  const scheduleCloseAddMenu = () => {
    window.clearTimeout(addCloseTimer.current);
    addCloseTimer.current = window.setTimeout(() => closeHeaderMenu(ADD_MENU_ID), 250);
  };

  useEffect(() => {
    if (!open) {
      closeHeaderMenu(ADD_MENU_ID);
      setShowSettings(false);
      setDialog(null);
    }
  }, [open, closeHeaderMenu]);

  // Dismiss the + dropdown on any pointer press outside its wrap (the wrap
  // stopPropagations, so the in-bar onClick alone never catches a click
  // elsewhere in the app) or on Escape. Mirrors common/Dropdown.tsx.
  useEffect(() => {
    if (!showAddMenu) return;
    const onDocPointer = (e: PointerEvent) => {
      if (addMenuRef.current?.contains(e.target as Node)) return;
      closeHeaderMenu(ADD_MENU_ID);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeHeaderMenu(ADD_MENU_ID);
    };
    document.addEventListener("pointerdown", onDocPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDocPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [showAddMenu, closeHeaderMenu]);
  const pillsScrollRef = useRef<HTMLDivElement>(null);
  const [pillOverflow, setPillOverflow] = useState({ left: false, right: false });

  // Allow other components (e.g. the header's Local Model button) to open the
  // settings dialog on a specific panel via a window event.
  useEffect(() => {
    const onOpenSettings = (e: Event) => {
      const panel = (e as CustomEvent).detail as SettingsPanelKind | undefined;
      setSettingsPanel(panel ?? "main");
      setShowSettings(true);
    };
    window.addEventListener("eldrun:open-settings", onOpenSettings);
    return () => window.removeEventListener("eldrun:open-settings", onOpenSettings);
  }, []);

  // The built-in Trash workspace is PINNED, not one of the strip's projects:
  // it is always present, always active, cannot be closed or reordered, and is
  // the one project every other one may need to reach — so it belongs in the
  // row's fixed leading segment beside ★ and the box chip, where it can never
  // scroll away, rather than as the first pill of a strip that scrolls. Being
  // out of `activeProjects` also takes it out of the slice, the reorder math
  // and the git-dot poll (its `git_type` is "none", so that was a `git status`
  // every 12 s on a folder that has no git).
  const trashProject = useMemo(
    () => projects.find((p) => p.id === TRASH_PROJECT_ID && p.status !== "inactive") ?? null,
    [projects],
  );

  const activeProjects = useMemo(() => {
    return projects
      .filter((p) => p.status !== "inactive" && p.id !== TRASH_PROJECT_ID)
      .sort((a, b) => a.position - b.position);
    // Keep the actual project objects live. A signature containing only the
    // bucketing fields pinned the old object when a local project finished
    // extending to remote, so ProjectPill never saw `remote` and did not add
    // its connection lamp until an unrelated signature field changed/reload.
    // The same stale-object bug affected any other pill-visible metadata that
    // was not copied into that signature.
  }, [projects]);

  // Per-pill git "dirty" dots: poll every active local project's git state on a
  // shared interval (one loop for all pills, deduped by project id) and store
  // the result in the gitDirty store, where each ProjectPill subscribes to its
  // own entry. Remote (sshfs) projects are skipped — running git over the mount
  // is slow. SidePanel also live-updates the active project's dot on edits.
  const gitDotTargets = useMemo(
    () =>
      activeProjects
        .filter((p) => !p.remote)
        .map((p) => ({ id: p.id, dir: resolveProjectDirectory(p) }))
        .filter((t) => !!t.dir),
    [activeProjects],
  );
  const gitDotSignature = useMemo(
    () => gitDotTargets.map((t) => `${t.id}:${t.dir}`).join("|"),
    [gitDotTargets],
  );
  const quiesce = useQuiesce();
  // Fast mode withdraws the dots entirely: this is a `git status` per local
  // project every 12 s, for projects the user is not currently in, and the dot
  // it feeds is the definition of an aid — the project's own file view says the
  // same thing, on the project being worked in, for free.
  const fastMode = useFastMode();
  useEffect(() => {
    if (gitDotTargets.length === 0 || fastMode) return;
    const refresh = useGitDirtyStore.getState().refresh;
    const run = () => gitDotTargets.forEach((t) => void refresh(t.id, t.dir));
    run();
    const id = window.setInterval(run, saverInterval(12000, quiesce));
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gitDotSignature, quiesce, fastMode]);

  // Which box's slice the strip is showing (`null` = every active project).
  // A *view*, deliberately not the scope: clicking a member switches to that
  // project without collapsing the slice, so hopping between a box's projects
  // never reshuffles the row under the pointer. Session-only — a slice is where
  // you are looking right now, not a setting.
  const [boxFilter, setBoxFilter] = useState<string | null>(null);
  const [boxCandidateFilter, setBoxCandidateFilter] = useState("");

  // Entering a box scope by any other door (the search popover, a restored
  // scope at launch, a popout's stream) selects its slice. One-way: leaving the
  // scope does NOT clear it, which is exactly what keeps the strip still while
  // its projects are being visited.
  useEffect(() => {
    if (!scope.startsWith(BOX_SCOPE_PREFIX)) return;
    const id = scope.slice(BOX_SCOPE_PREFIX.length);
    setBoxFilter((cur) => (cur === id ? cur : id));
  }, [scope]);

  // A dissolved box takes its slice with it, or the strip would stay filtered
  // by something no menu can select any more.
  useEffect(() => {
    if (boxFilter && !boxes.some((b) => b.id === boxFilter)) setBoxFilter(null);
  }, [boxes, boxFilter]);

  // Membership mode follows the selected slice rather than the current tab
  // scope. Opening a member changes `scope`, but the + and × controls must keep
  // editing the Box the strip is still showing.
  const currentBox = useMemo(
    () => (boxFilter ? boxes.find((b) => b.id === boxFilter) ?? null : null),
    [boxes, boxFilter],
  );
  const currentBoxMemberIds = useMemo(
    () => new Set(currentBox?.member_ids ?? []),
    [currentBox],
  );

  useEffect(() => {
    setBoxCandidateFilter("");
  }, [currentBox?.id]);

  /** Pick a box's slice (and open its scope) or go back to every project. */
  const selectBox = (boxId: string | null) => {
    setBoxFilter(boxId);
    if (boxId) void openBox(boxId);
  };

  // The pills the strip renders. A slice shows its box's members — plus the
  // project currently in scope even when it is not one, since a strip that
  // hides the project you are working in is a strip that has lost you.
  const visibleProjects = useMemo<ProjectEntry[]>(() => {
    if (!currentBox) return activeProjects;
    return activeProjects.filter((p) => currentBoxMemberIds.has(p.id) || p.id === scope);
  }, [activeProjects, currentBox, currentBoxMemberIds, scope]);

  const boxCandidates = useMemo(() => {
    if (!currentBox) return [];
    const needle = boxCandidateFilter.trim().toLocaleLowerCase();
    return activeProjects.filter(
      (project) =>
        !currentBoxMemberIds.has(project.id) &&
        (!needle || project.name.toLocaleLowerCase().includes(needle)),
    );
  }, [activeProjects, boxCandidateFilter, currentBox, currentBoxMemberIds]);

  // Pointer-driven pill reorder (stores/pillDrag): every OTHER visible project
  // pill "parts" to open the dragged one's landing slot — a `shiftPx` per id,
  // computed here (not in each pill) since it needs the FULL rendered order.
  // Mirrors MachinesIndicator's row-parting FLIP math, generalized to width:
  // removing an item of the dragged pill's own width from the strip and
  // reinserting it elsewhere shifts every OTHER pill between the old and new
  // slot by exactly that width, regardless of their own widths — so idx
  // (this pill's index in the full project-only list) vs. fromIdx (the
  // dragged pill's) and overIndex (the without-self landing index the drag
  // gesture computed) alone decide the shift; a box-assign or Alt-group
  // target suppresses it entirely (nothing will actually move).
  const pillDrag = usePillDragStore((s) => s.drag);
  const pillShifts = useMemo(() => {
    const shifts = new Map<string, number>();
    if (!pillDrag || pillDrag.overBoxId || pillDrag.groupTargetId) return shifts;
    const fromIdx = visibleProjects.findIndex((p) => p.id === pillDrag.id);
    if (fromIdx < 0) return shifts;
    visibleProjects.forEach((p, idx) => {
      if (idx === fromIdx) return;
      const shift =
        idx > fromIdx && idx <= pillDrag.overIndex
          ? -pillDrag.width
          : idx < fromIdx && idx >= pillDrag.overIndex
            ? pillDrag.width
            : 0;
      if (shift) shifts.set(p.id, shift);
    });
    return shifts;
  }, [pillDrag, visibleProjects]);

  // Signature of what the strip renders, so the overflow/edge-fade effect
  // re-runs when the slice changes and not just on a count change (S3) —
  // switching between two same-sized boxes is exactly that case.
  const bucketSignature = useMemo(
    () => `${boxFilter ?? ""}|${visibleProjects.map((p) => p.id).join(",")}`,
    [boxFilter, visibleProjects],
  );

  // Drive the edge-fade affordance: mark which side(s) of the pill row have
  // scrolled-off pills so CSS can fade only that edge. Re-checks on scroll,
  // window resize, and whenever the set of active pills changes.
  useEffect(() => {
    const el = pillsScrollRef.current;
    if (!el) return;
    const update = () => {
      const maxScroll = el.scrollWidth - el.clientWidth;
      setPillOverflow({
        left: el.scrollLeft > 1,
        right: el.scrollLeft < maxScroll - 1,
      });
    };
    // Redirect vertical wheel motion to horizontal scroll so the mouse wheel
    // moves the pill row when hovering it (the webview doesn't do this on its
    // own). Non-passive so preventDefault can suppress the no-op vertical scroll.
    const onWheel = (e: WheelEvent) => {
      if (e.deltaX !== 0) return;
      if (el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: false });
    // ResizeObserver is absent in jsdom (tests); guard so the effect no-ops it
    // there while the scroll/wheel/resize listeners still wire up.
    const ro =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    ro?.observe(el);
    window.addEventListener("resize", update);
    return () => {
      el.removeEventListener("scroll", update);
      el.removeEventListener("wheel", onWheel);
      ro?.disconnect();
      window.removeEventListener("resize", update);
    };
    // Re-run when the rendered bucket shape changes (count alone misses a
    // box ⇄ ungrouped regroup that keeps the same active-pill count) (S3).
  }, [bucketSignature]);

  // Alt-drop one pill onto another: spin up a fresh box holding both projects
  // (phone-style "drag onto" grouping). Additive — neither project leaves any
  // box it was already in; the user renames the new box via its chip.
  const groupProjects = async (fromId: string, toId: string) => {
    if (fromId === toId) return;
    await boxProjects([toId, fromId], { name: t("projectSwitcher.newBox") });
  };

  // Empty pill-strip space doubles as a window-drag handle: pressing the bare
  // strip (where no project pills are) starts a native window move, so the
  // project bar behaves like titlebar dead-space. Pills/boxes are nested
  // children, so a press on one lands on it (target !== currentTarget) and is
  // left alone. Bypasses the header's `.no-drag` by dragging directly. (#dnd)
  const startWindowDrag = (e: React.MouseEvent) => {
    // `button` (singular, 0 = left), not `buttons`: WebKitGTK reports
    // `buttons === 0` on the opening mousedown, which swallowed the drag on Linux.
    if (e.button !== 0) return;
    if (e.target !== e.currentTarget) return;
    getCurrentWindow().startDragging().catch(() => {});
  };

  const scrollPills = (dir: -1 | 1) => {
    const el = pillsScrollRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.max(120, el.clientWidth * 0.7), behavior: "smooth" });
  };

  // Continuous scroll while a chevron is hovered: rAF loop nudges the pill row
  // each frame until the pointer leaves (or the component unmounts).
  const hoverScrollRef = useRef<number | null>(null);
  const stopHoverScroll = () => {
    if (hoverScrollRef.current !== null) {
      cancelAnimationFrame(hoverScrollRef.current);
      hoverScrollRef.current = null;
    }
  };
  const startHoverScroll = (dir: -1 | 1) => {
    stopHoverScroll();
    const step = () => {
      const el = pillsScrollRef.current;
      if (!el) return;
      el.scrollLeft += dir * 6;
      hoverScrollRef.current = requestAnimationFrame(step);
    };
    hoverScrollRef.current = requestAnimationFrame(step);
  };
  useEffect(() => stopHoverScroll, []);

  /**
   * Add a just-created/imported project and, for a **remote** one, ask about its
   * giant folders once. An import in particular can register a folder holding a
   * `.venv`, a `node_modules` or a data drop, and byte-sync does not read
   * `.gitignore` — so without this the first sync pass is the moment the user
   * finds out. The prompt handles the not-yet-connected case itself (it walks
   * the local side and fills in the host column when the pool comes up).
   */
  const addAndAudit = async (project: ProjectEntry) => {
    await addProject(project);
    if (project.remote) useBigFoldersStore.getState().openOnce(project.id);
  };

  return (
    <>
      {showSettings && createPortal(
        <SettingsDialog onClose={() => setShowSettings(false)} initialPanel={settingsPanel} />,
        document.body,
      )}

      {dialog === "new" && createPortal(
        <ProjectDialog
          kind="new"
          onClose={() => setDialog(null)}
          onProject={(project) => void addAndAudit(project)}
        />,
        document.body,
      )}
      {(dialog === "import" || dialog === "clone") && createPortal(
        <ProjectDialog
          kind="import"
          initialImportSource={dialog === "clone" ? "git" : "folder"}
          onClose={() => setDialog(null)}
          onProject={(project) => void addAndAudit(project)}
        />,
        document.body,
      )}

      <div
        className="project-switcher"
        onClick={() => {
          setShowSettings(false);
          closeHeaderMenu(ADD_MENU_ID);
        }}
        // Suppress the webview's default Reload/Inspect menu over the bar so a
        // right-click only ever surfaces our own pill context menu.
        onContextMenu={(e) => e.preventDefault()}
      >
        {/* Divides the header's global cluster (🧠 ✉ 🗓 ☑ ▦ ⚙) from the project
            strip. What is left of this line belongs to the machine; what is
            right of it belongs to the project list. */}
        <div className="project-switcher-separator" />
        <div
          className={`project-pills-region${pillOverflow.left ? " overflow-left" : ""}${
            pillOverflow.right ? " overflow-right" : ""
          }`}
        >
          {/* The root terminal, as the row's first tab — a sibling of the
              scroll strip rather than a child of it, which is what pins it:
              the pills scroll past underneath and this one never leaves the
              left edge. It reads its state off `scope`, like every pill beside
              it (activeId would keep it lit while a box is open) — and it wears
              the same working/waiting/finished strip, because the root terminal
              runs the same agents in the same kind of tabs and a bare pill could
              only be read as "nothing is running in there". */}
          <div className={`root-pill${scope === "root" ? " active" : ""}`}>
            {/* The switch itself is an inner button with the strip as its
                SIBLING — the project pill's own shape (.project-pill wrapping
                .pill-main), and here for a second reason: a status bar is a
                button now, and a button inside a button is invalid markup. */}
            <button
              type="button"
              className="root-pill-main"
              title={t("header.rootProject")}
              aria-label={t("header.rootProject")}
              onClick={(e) => {
                e.stopPropagation();
                void setActive(null);
              }}
            >
              <StarIcon className="root-pill-star" />
            </button>
            <PillStatusBars scope={ROOT_SCOPE} />
          </div>
          {/* The Trash workspace, pinned right of the root terminal: a fixed
              leading segment of built-in scopes (★ root · 🗑 trash · ▣ box)
              that the project pills scroll past underneath. It is an ordinary
              ProjectPill — same shape, same status strip, same context menu —
              it just never moves and never scrolls out of reach. */}
          {trashProject && (
            <ProjectPill
              project={trashProject}
              active={scope === trashProject.id}
              onClick={() => {
                usePillSelectionStore.getState().clear();
                void setActive(trashProject.id);
              }}
              // Pinned: it cannot be closed (the backend re-creates it before
              // every save), reordered, or put in a box, so the three callbacks
              // that would do those things are inert here rather than absent —
              // the pill's own guards already hide the × and the drag.
              onClose={() => {}}
              onReorder={() => {}}
            />
          )}
          {/* Boxes: ONE chip beside the root pill rather than a pill per box
              among the projects. It sits outside .project-pills-scroll for the
              root pill's reason — the leading segment of the row answers
              "where am I", so it must never scroll away — and it slices the
              strip instead of adding to it (see BoxScopeChip). */}
          <BoxScopeChip
            boxes={boxes}
            selectedId={boxFilter}
            onSelect={selectBox}
            onRename={(boxId, name) => void renameBox(boxId, name)}
            onDelete={(boxId) => void deleteBox(boxId)}
            active={!!boxFilter && scope === `${BOX_SCOPE_PREFIX}${boxFilter}`}
            forcedDragOver={!!boxFilter && pillDrag?.overBoxId === boxFilter}
          />
          {/* Hairline between the fixed leading segment (★ · 🗑 · ▣) and the
              scrolling project strip, so the two zones read as two zones. */}
          <div className="pills-lead-sep" aria-hidden />
          <button
            type="button"
            className="pills-scroll-btn left"
            tabIndex={-1}
            aria-label={t("projectSwitcher.scrollLeft")}
            onMouseEnter={() => startHoverScroll(-1)}
            onMouseLeave={stopHoverScroll}
            onClick={(e) => {
              e.stopPropagation();
              scrollPills(-1);
            }}
          >
            ‹
          </button>
          <div
            className="project-pills-scroll"
            ref={pillsScrollRef}
            // Pressing the bare strip (no pill under the cursor) drags the
            // window; pills/boxes are nested so their press is left untouched.
            onMouseDown={startWindowDrag}
          >
            {visibleProjects.map((project) => {
              const isCurrentBoxMember = currentBoxMemberIds.has(project.id);
              const boxNames = currentBox
                ? isCurrentBoxMember
                  ? [currentBox.name]
                  : []
                : (membership.get(project.id) ?? [])
                    .map((boxId) => boxes.find((b) => b.id === boxId)?.name)
                    .filter((n): n is string => !!n);
              return (
                <ProjectPill
                  key={project.id}
                  project={project}
                  active={scope === project.id}
                  onClick={() => {
                    // A plain activation click clears the multi-selection (3b).
                    usePillSelectionStore.getState().clear();
                    void setActive(project.id);
                  }}
                  onClose={currentBox
                    ? isCurrentBoxMember
                      ? () => removeFromBox(project.id, currentBox.id)
                      : undefined
                    : () => deactivateProject(project.id)}
                  closeTitle={currentBox && isCurrentBoxMember
                    ? t("projectSwitcher.removeFromBox", {
                        name: project.name,
                        box: currentBox.name,
                      })
                    : undefined}
                  onReorder={(fromId, toId) => void reorderProjects(fromId, toId)}
                  onGroup={(fromId, toId) => void groupProjects(fromId, toId)}
                  onAssignToBox={(boxId) => void addToBox(project.id, boxId)}
                  boxNames={boxNames}
                  isDragged={pillDrag?.id === project.id}
                  dragDx={pillDrag?.id === project.id ? pillDrag.dx : undefined}
                  shiftPx={pillShifts.get(project.id)}
                  groupHintActive={pillDrag?.groupTargetId === project.id}
                />
              );
            })}
          </div>
          <button
            type="button"
            className="pills-scroll-btn right"
            tabIndex={-1}
            aria-label={t("projectSwitcher.scrollRight")}
            onMouseEnter={() => startHoverScroll(1)}
            onMouseLeave={stopHoverScroll}
            onClick={(e) => {
              e.stopPropagation();
              scrollPills(1);
            }}
          >
            ›
          </button>
        </div>
        <div className="project-switcher-separator" />

        <div
          className="project-switcher-add-wrap"
          ref={addMenuRef}
          onClick={(e) => e.stopPropagation()}
          onMouseEnter={revealAddMenu}
          onMouseLeave={scheduleCloseAddMenu}
        >
          <button
            className="project-switcher-add-btn"
            data-hint-anchor="add-project"
            title={t(currentBox
              ? "projectSwitcher.addProjectsToBox"
              : "projectSwitcher.addOrImport")}
            // Hover-opened, like its sibling header menus (GlobalAppMenu,
            // LocalModelMenu, VpnIndicator). Click reveals rather than toggling: a
            // click also fires mouseenter, so a toggle here would open on enter and
            // immediately shut.
            onClick={revealAddMenu}
            onFocus={revealAddMenu}
          >
            +
          </button>
          {showAddMenu && (
            <div className={`project-switcher-add-menu${currentBox ? " box-membership" : ""}`}>
              {currentBox ? (
                <>
                  <div className="project-switcher-box-add-title">
                    {t("projectSwitcher.addProjectsToBox")} <UntestedTag />
                  </div>
                  <input
                    className="project-switcher-box-add-filter"
                    value={boxCandidateFilter}
                    onChange={(e) => setBoxCandidateFilter(e.target.value)}
                    placeholder={t("projectSwitcher.filterBoxCandidates")}
                    aria-label={t("projectSwitcher.filterBoxCandidates")}
                    autoFocus
                  />
                  <div className="project-switcher-box-add-list">
                    {boxCandidates.map((project) => (
                      <button
                        type="button"
                        key={project.id}
                        data-project-id={project.id}
                        onClick={() => void addToBox(project.id, currentBox.id)}
                      >
                        {project.name}
                      </button>
                    ))}
                    {boxCandidates.length === 0 && (
                      <div className="project-switcher-box-add-empty">
                        {t("projectSwitcher.noBoxCandidates")}
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <button onClick={() => { closeHeaderMenu(ADD_MENU_ID); setDialog("new"); }}>
                    {t("projectSwitcher.newProject")}
                  </button>
                  <button onClick={() => { closeHeaderMenu(ADD_MENU_ID); setDialog("import"); }}>
                    {t("projectSwitcher.importProject")}
                  </button>
                  <button
                    className="untested"
                    onClick={() => { closeHeaderMenu(ADD_MENU_ID); setDialog("clone"); }}
                  >
                    {t("projectSwitcher.importFromGitHub")} <UntestedTag />
                  </button>
                  <button
                    className="untested"
                    onClick={() => { closeHeaderMenu(ADD_MENU_ID); openHpcWizard(); }}
                  >
                    {t("projectSwitcher.hpcPipeline")} <UntestedTag />
                  </button>
                  <button
                    className="untested"
                    onClick={() => {
                      closeHeaderMenu(ADD_MENU_ID);
                      useBoxEditorStore.getState().openCreate();
                    }}
                  >
                    {t("projectSwitcher.newBox")} <UntestedTag />
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {/* Right of the + rather than left of the pills: the box searches the
            projects that are *not* on the strip, so it belongs with the control
            that adds one, not in front of the ones already there. Its popover
            is right-anchored (see .project-search-popover) since it now opens
            near the header's right half. */}
        <ProjectSearch
          projects={projects}
          boxes={boxes}
          onActivateProject={(id) => void setActive(id)}
          onOpenBox={(id) => selectBox(id)}
        />
      </div>
    </>
  );
}
