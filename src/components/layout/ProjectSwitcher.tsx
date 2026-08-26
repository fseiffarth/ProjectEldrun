import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ProjectPill } from "../projects/ProjectPill";
import { BoxPill } from "../projects/BoxPill";
import { usePillDragStore } from "../../stores/pillDrag";
import { ProjectSearch } from "../projects/ProjectSearch";
import { ProjectDialog } from "../projects/ProjectDialog";
import { SettingsDialog, type SettingsPanelKind } from "./SettingsPanel";
import { UntestedTag } from "../common/UntestedTag";
import { StarIcon } from "./StarIcon";
import { useHpcPipelineStore } from "../../stores/hpcPipeline";
import { useBigFoldersStore } from "../../stores/bigFolders";
import { useProjectsStore } from "../../stores/projects";
import { useBoxesStore } from "../../stores/boxes";
import { ROOT_SCOPE, useTabsStore } from "../../stores/tabs";
import { PillStatusBars } from "../projects/PillStatusBars";
import { useGitDirtyStore } from "../../stores/gitDirty";
import { useQuiesce, saverInterval } from "../../stores/power";
import { resolveProjectDirectory, type ProjectBox, type ProjectEntry } from "../../types";
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

export function ProjectSwitcher({ open = true }: { open?: boolean }) {
  const t = useT();
  const { projects, setActive, addProject, deactivateProject, reorderProjects } = useProjectsStore();
  const boxes = useBoxesStore((s) => s.boxes);
  const createBox = useBoxesStore((s) => s.createBox);
  const renameBox = useBoxesStore((s) => s.renameBox);
  const deleteBox = useBoxesStore((s) => s.deleteBox);
  const assignToBox = useBoxesStore((s) => s.assignToBox);
  const openBox = useBoxesStore((s) => s.openBox);
  const openHpcWizard = useHpcPipelineStore((s) => s.openWizard);
  // The currently-displayed scope is the single source of truth for which pill
  // is highlighted (BoxPill keys off it too). Opening a box moves the scope but
  // not `activeId`, so highlighting on `activeId` would leave the previously
  // active project pill stuck-on while a box is open — drive it off scope.
  const scope = useTabsStore((s) => s.scope);
  const [showSettings, setShowSettings] = useState(false);
  const [showSettingsMenu, setShowSettingsMenu] = useState(false);
  const [settingsPanel, setSettingsPanel] = useState<SettingsPanelKind>("main");
  const [showAddMenu, setShowAddMenu] = useState(false);
  // "clone" is the import dialog opened straight onto its GitHub/GitLab source —
  // the same dialog, so the source can still be switched back inside it.
  const [dialog, setDialog] = useState<"new" | "import" | "clone" | null>(null);
  const settingsMenuRef = useRef<HTMLDivElement>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);
  // Hover-opened, like the header's sibling menus (GlobalAppMenu, LocalModelMenu,
  // VpnIndicator): a short close delay on mouseleave so crossing the gap between
  // the button and its dropdown doesn't flicker-close it.
  const settingsCloseTimer = useRef<number | undefined>(undefined);
  const addCloseTimer = useRef<number | undefined>(undefined);

  const revealSettingsMenu = () => {
    window.clearTimeout(addCloseTimer.current);
    setShowAddMenu(false);
    window.clearTimeout(settingsCloseTimer.current);
    setShowSettingsMenu(true);
  };
  const scheduleCloseSettingsMenu = () => {
    window.clearTimeout(settingsCloseTimer.current);
    settingsCloseTimer.current = window.setTimeout(() => setShowSettingsMenu(false), 180);
  };
  const revealAddMenu = () => {
    setShowSettings(false);
    window.clearTimeout(settingsCloseTimer.current);
    setShowSettingsMenu(false);
    window.clearTimeout(addCloseTimer.current);
    setShowAddMenu(true);
  };
  const scheduleCloseAddMenu = () => {
    window.clearTimeout(addCloseTimer.current);
    addCloseTimer.current = window.setTimeout(() => setShowAddMenu(false), 180);
  };

  useEffect(() => {
    if (!open) {
      setShowSettingsMenu(false);
      setShowAddMenu(false);
      setShowSettings(false);
      setDialog(null);
    }
  }, [open]);

  // Dismiss the ⚙/+ dropdowns on any pointer press outside their wrap (the
  // wraps stopPropagation, so the in-bar onClick alone never catches a click
  // elsewhere in the app) or on Escape. Mirrors common/Dropdown.tsx.
  useEffect(() => {
    if (!showSettingsMenu && !showAddMenu) return;
    const onDocPointer = (e: PointerEvent) => {
      const target = e.target as Node;
      if (settingsMenuRef.current?.contains(target)) return;
      if (addMenuRef.current?.contains(target)) return;
      setShowSettingsMenu(false);
      setShowAddMenu(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setShowSettingsMenu(false);
        setShowAddMenu(false);
      }
    };
    document.addEventListener("pointerdown", onDocPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDocPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [showSettingsMenu, showAddMenu]);
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

  const activeProjects = useMemo(() => {
    return projects
      .filter((p) => p.status !== "inactive")
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
  // is slow. RightPanel also live-updates the active project's dot on edits.
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
  useEffect(() => {
    if (gitDotTargets.length === 0) return;
    const refresh = useGitDirtyStore.getState().refresh;
    const run = () => gitDotTargets.forEach((t) => void refresh(t.id, t.dir));
    run();
    const id = window.setInterval(run, saverInterval(12000, quiesce));
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gitDotSignature, quiesce]);

  // Bucket the active pills into boxes (by `box_id`) + an ungrouped remainder,
  // interleaved by switcher position. A pill whose `box_id` points at a missing
  // box (e.g. after a delete the sweep didn't reach) falls back to ungrouped (S1).
  const boxesById = useMemo(() => {
    const map = new Map<string, ProjectBox>();
    for (const b of boxes) map.set(b.id, b);
    return map;
  }, [boxes]);

  type SwitcherItem =
    | { kind: "box"; box: ProjectBox; members: ProjectEntry[]; position: number }
    | { kind: "project"; project: ProjectEntry; position: number };

  const switcherItems = useMemo<SwitcherItem[]>(() => {
    const membersByBox = new Map<string, ProjectEntry[]>();
    const ungrouped: ProjectEntry[] = [];
    for (const p of activeProjects) {
      const boxId = typeof p.box_id === "string" ? p.box_id : undefined;
      if (boxId && boxesById.has(boxId)) {
        const list = membersByBox.get(boxId) ?? [];
        list.push(p);
        membersByBox.set(boxId, list);
      } else {
        ungrouped.push(p);
      }
    }
    const items: SwitcherItem[] = [];
    // Place each box at the position of its first (lowest-position) member so it
    // interleaves sensibly with ungrouped pills; empty boxes are not rendered in
    // the pill strip (they remain reachable via search).
    for (const box of boxes) {
      const members = membersByBox.get(box.id) ?? [];
      if (members.length === 0) continue;
      items.push({ kind: "box", box, members, position: members[0].position });
    }
    for (const p of ungrouped) items.push({ kind: "project", project: p, position: p.position });
    return items.sort((a, b) => a.position - b.position);
  }, [activeProjects, boxes, boxesById]);

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
  const projectItems = useMemo(
    () =>
      switcherItems.filter(
        (it): it is Extract<SwitcherItem, { kind: "project" }> => it.kind === "project",
      ),
    [switcherItems],
  );
  const pillShifts = useMemo(() => {
    const shifts = new Map<string, number>();
    if (!pillDrag || pillDrag.overBoxId || pillDrag.groupTargetId) return shifts;
    const fromIdx = projectItems.findIndex((it) => it.project.id === pillDrag.id);
    if (fromIdx < 0) return shifts;
    projectItems.forEach((it, idx) => {
      if (idx === fromIdx) return;
      const shift =
        idx > fromIdx && idx <= pillDrag.overIndex
          ? -pillDrag.width
          : idx < fromIdx && idx >= pillDrag.overIndex
            ? pillDrag.width
            : 0;
      if (shift) shifts.set(it.project.id, shift);
    });
    return shifts;
  }, [pillDrag, projectItems]);

  // Signature of the bucketing so the overflow/edge-fade effect re-runs when
  // membership moves between a box and ungrouped (not just on count change) (S3).
  const bucketSignature = useMemo(
    () =>
      switcherItems
        .map((it) =>
          it.kind === "box"
            ? `b:${it.box.id}:${it.members.map((m) => m.id).join(",")}`
            : `p:${it.project.id}`,
        )
        .join("|"),
    [switcherItems],
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

  // Shift-drop one pill onto another: spin up a fresh box holding both projects
  // (phone-style "drag onto" grouping). Assign the drop target first, then the
  // dragged pill, so both land in the new box; the user renames it via the chip.
  const groupProjects = async (fromId: string, toId: string) => {
    if (fromId === toId) return;
    const box = await createBox(t("projectSwitcher.newBox"));
    await assignToBox(toId, box.id);
    await assignToBox(fromId, box.id);
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
          setShowSettingsMenu(false);
          setShowAddMenu(false);
        }}
        // Suppress the webview's default Reload/Inspect menu over the bar so a
        // right-click only ever surfaces our own pill context menu.
        onContextMenu={(e) => e.preventDefault()}
      >
        <div
          className="project-switcher-add-wrap"
          ref={settingsMenuRef}
          onClick={(e) => e.stopPropagation()}
          onMouseEnter={revealSettingsMenu}
          onMouseLeave={scheduleCloseSettingsMenu}
        >
          <button
            className="project-switcher-action-btn"
            data-hint-anchor="settings"
            title={t("settings.title")}
            // Hover-opened, like its sibling header menus (GlobalAppMenu,
            // LocalModelMenu, VpnIndicator). Click reveals rather than toggling: a
            // click also fires mouseenter, so a toggle here would open on enter and
            // immediately shut.
            onClick={revealSettingsMenu}
            onFocus={revealSettingsMenu}
          >
            ⚙
          </button>
          {showSettingsMenu && (
            <div className="project-switcher-add-menu">
              <button onClick={() => { setShowSettingsMenu(false); setSettingsPanel("main"); setShowSettings(true); }}>
                {t("settings.title")}
              </button>
              <button onClick={() => { setShowSettingsMenu(false); setSettingsPanel("help"); setShowSettings(true); }}>
                {t("nav.help.title")}
              </button>
              <button onClick={() => { setShowSettingsMenu(false); window.dispatchEvent(new Event("eldrun:open-how-to-start")); }}>
                {t("projectSwitcher.howToStartMenu")}
              </button>
              <button onClick={() => { setShowSettingsMenu(false); window.dispatchEvent(new Event("eldrun:start-tour")); }}>
                {t("settings.takeTour")}
              </button>
              <button onClick={() => { setShowSettingsMenu(false); window.dispatchEvent(new Event("eldrun:start-advanced-tour")); }}>
                {t("settings.takeAdvancedTour")}
              </button>
              <button onClick={() => { setShowSettingsMenu(false); window.dispatchEvent(new Event("eldrun:open-lessons")); }}>
                {t("settings.lessons")}
              </button>
            </div>
          )}
        </div>
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
              title={t("header.rootTerminal")}
              aria-label={t("header.rootTerminal")}
              onClick={(e) => {
                e.stopPropagation();
                void setActive(null);
              }}
            >
              <StarIcon className="root-pill-star" />
            </button>
            <PillStatusBars scope={ROOT_SCOPE} />
          </div>
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
            {switcherItems.map((item) =>
              item.kind === "box" ? (
                <BoxPill
                  key={`box:${item.box.id}`}
                  box={item.box}
                  members={item.members}
                  onOpen={() => void openBox(item.box.id)}
                  onSelectMember={(projectId) => void setActive(projectId)}
                  onRemoveMember={(projectId) => void assignToBox(projectId, null)}
                  onRename={(name) => void renameBox(item.box.id, name)}
                  onDelete={() => void deleteBox(item.box.id)}
                  forcedDragOver={pillDrag?.overBoxId === item.box.id}
                />
              ) : (
                <ProjectPill
                  key={item.project.id}
                  project={item.project}
                  active={scope === item.project.id}
                  onClick={() => setActive(item.project.id)}
                  onClose={() => deactivateProject(item.project.id)}
                  onReorder={(fromId, toId) => void reorderProjects(fromId, toId)}
                  onGroup={(fromId, toId) => void groupProjects(fromId, toId)}
                  onAssignToBox={(boxId) => void assignToBox(item.project.id, boxId)}
                  isDragged={pillDrag?.id === item.project.id}
                  dragDx={pillDrag?.id === item.project.id ? pillDrag.dx : undefined}
                  shiftPx={pillShifts.get(item.project.id)}
                  groupHintActive={pillDrag?.groupTargetId === item.project.id}
                />
              ),
            )}
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
            title={t("projectSwitcher.addOrImport")}
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
            <div className="project-switcher-add-menu">
              <button onClick={() => { setShowAddMenu(false); setDialog("new"); }}>
                {t("projectSwitcher.newProject")}
              </button>
              <button onClick={() => { setShowAddMenu(false); setDialog("import"); }}>
                {t("projectSwitcher.importProject")}
              </button>
              <button
                className="untested"
                onClick={() => { setShowAddMenu(false); setDialog("clone"); }}
              >
                {t("projectSwitcher.importFromGitHub")} <UntestedTag />
              </button>
              <button
                className="untested"
                onClick={() => { setShowAddMenu(false); openHpcWizard(); }}
              >
                {t("projectSwitcher.hpcPipeline")} <UntestedTag />
              </button>
              <button
                className="untested"
                onClick={() => {
                  setShowAddMenu(false);
                  void createBox(t("projectSwitcher.newBox"));
                }}
              >
                {t("projectSwitcher.newBox")} <UntestedTag />
              </button>
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
          onOpenBox={(id) => void openBox(id)}
        />
      </div>
    </>
  );
}
