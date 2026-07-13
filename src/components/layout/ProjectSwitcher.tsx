import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ProjectPill, PILL_DRAG_TYPE } from "../projects/ProjectPill";
import { BoxPill } from "../projects/BoxPill";
import { ProjectSearch } from "../projects/ProjectSearch";
import { ProjectDialog } from "../projects/ProjectDialog";
import { SettingsDialog, type SettingsPanelKind } from "./SettingsPanel";
import { useProjectsStore } from "../../stores/projects";
import { useBoxesStore } from "../../stores/boxes";
import { useTabsStore } from "../../stores/tabs";
import { useGitDirtyStore } from "../../stores/gitDirty";
import { useEnergySaver, saverInterval } from "../../stores/power";
import { resolveProjectDirectory, type ProjectBox, type ProjectEntry } from "../../types";

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
  const { projects, setActive, addProject, deactivateProject, reorderProjects } = useProjectsStore();
  const boxes = useBoxesStore((s) => s.boxes);
  const createBox = useBoxesStore((s) => s.createBox);
  const renameBox = useBoxesStore((s) => s.renameBox);
  const deleteBox = useBoxesStore((s) => s.deleteBox);
  const assignToBox = useBoxesStore((s) => s.assignToBox);
  const openBox = useBoxesStore((s) => s.openBox);
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

  // Project projection that drives the pill strip. Reduced to just the fields
  // the bucketing reads (id/position/box_id) plus a join-key, so the heavier
  // box-bucketing memos below only recompute when one of those changes — not on
  // every unrelated `projects` mutation (e.g. a status/name edit on an inactive
  // project, time/CPU updates) (Eff #11).
  const activeProjectsSignature = useMemo(
    () =>
      projects
        .filter((p) => p.status !== "inactive")
        .map(
          (p) =>
            // Include the git-provider axis (explicit `git_provider` and the
            // async-sniffed `detected_provider`) so a pill's type tags refresh
            // when `detect_git_providers` fills them in after load — otherwise
            // the memo pins a stale project object and the hover shows only the
            // base "git" tag while the right panel (which reads the live store)
            // shows git + GitHub. Both feed the same `projectTypeTags`; keep
            // their inputs in sync.
            `${p.id}:${p.position}:${typeof p.box_id === "string" ? p.box_id : ""}:${
              typeof p.git_type === "string" ? p.git_type : ""
            }:${typeof p.git_provider === "string" ? p.git_provider : ""}:${
              typeof p.detected_provider === "string" ? p.detected_provider : ""
            }`,
        )
        .sort()
        .join("|"),
    [projects],
  );

  const activeProjects = useMemo(() => {
    return projects
      .filter((p) => p.status !== "inactive")
      .sort((a, b) => a.position - b.position);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectsSignature]);

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
  const energySaver = useEnergySaver();
  useEffect(() => {
    if (gitDotTargets.length === 0) return;
    const refresh = useGitDirtyStore.getState().refresh;
    const run = () => gitDotTargets.forEach((t) => void refresh(t.id, t.dir));
    run();
    const id = window.setInterval(run, saverInterval(12000, energySaver));
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gitDotSignature, energySaver]);

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
    const box = await createBox("New Box");
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
          onProject={(project) => addProject(project)}
        />,
        document.body,
      )}
      {(dialog === "import" || dialog === "clone") && createPortal(
        <ProjectDialog
          kind="import"
          initialImportSource={dialog === "clone" ? "git" : "folder"}
          onClose={() => setDialog(null)}
          onProject={(project) => addProject(project)}
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
        <ProjectSearch
          projects={projects}
          boxes={boxes}
          onActivateProject={(id) => void setActive(id)}
          onOpenBox={(id) => void openBox(id)}
        />

        <div className="project-switcher-separator" />
        <div
          className={`project-pills-region${pillOverflow.left ? " overflow-left" : ""}${
            pillOverflow.right ? " overflow-right" : ""
          }`}
        >
          <button
            type="button"
            className="pills-scroll-btn left"
            tabIndex={-1}
            aria-label="Scroll projects left"
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
            // Ungrouped drop zone (S4): dropping a pill on the bare strip (not on
            // a pill or a BoxPill, both of which stopPropagation) ungroups it.
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes(PILL_DRAG_TYPE)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
            }}
            onDrop={(e) => {
              if (!e.dataTransfer.types.includes(PILL_DRAG_TYPE)) return;
              const fromId = e.dataTransfer.getData(PILL_DRAG_TYPE);
              if (!fromId) return;
              e.preventDefault();
              void assignToBox(fromId, null);
            }}
          >
            {switcherItems.map((item) =>
              item.kind === "box" ? (
                <BoxPill
                  key={`box:${item.box.id}`}
                  box={item.box}
                  members={item.members}
                  onOpen={() => void openBox(item.box.id)}
                  onAssign={(projectId) => void assignToBox(projectId, item.box.id)}
                  onSelectMember={(projectId) => void setActive(projectId)}
                  onRemoveMember={(projectId) => void assignToBox(projectId, null)}
                  onRename={(name) => void renameBox(item.box.id, name)}
                  onDelete={() => void deleteBox(item.box.id)}
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
                />
              ),
            )}
          </div>
          <button
            type="button"
            className="pills-scroll-btn right"
            tabIndex={-1}
            aria-label="Scroll projects right"
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
          ref={settingsMenuRef}
          onClick={(e) => e.stopPropagation()}
          onMouseEnter={revealSettingsMenu}
          onMouseLeave={scheduleCloseSettingsMenu}
        >
          <button
            className="project-switcher-action-btn"
            data-hint-anchor="settings"
            title="Settings"
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
                Settings
              </button>
              <button onClick={() => { setShowSettingsMenu(false); setSettingsPanel("help"); setShowSettings(true); }}>
                Feature Guide
              </button>
              <button onClick={() => { setShowSettingsMenu(false); window.dispatchEvent(new Event("eldrun:open-how-to-start")); }}>
                How to start
              </button>
              <button onClick={() => { setShowSettingsMenu(false); window.dispatchEvent(new Event("eldrun:start-tour")); }}>
                Take a tour
              </button>
              <button onClick={() => { setShowSettingsMenu(false); window.dispatchEvent(new Event("eldrun:open-lessons")); }}>
                Lessons
              </button>
            </div>
          )}
        </div>


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
            title="Add or import project"
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
                New Project
              </button>
              <button onClick={() => { setShowAddMenu(false); setDialog("import"); }}>
                Import Project
              </button>
              <button onClick={() => { setShowAddMenu(false); setDialog("clone"); }}>
                Import from GitHub/GitLab
              </button>
              <button
                onClick={() => {
                  setShowAddMenu(false);
                  void createBox("New Box");
                }}
              >
                New Box
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
