import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { ProjectPill, PILL_DRAG_TYPE } from "../projects/ProjectPill";
import { BoxPill } from "../projects/BoxPill";
import { GLOBAL_APP_ROLES } from "./GlobalAppBar";
import { useProjectsStore } from "../../stores/projects";
import { useBoxesStore } from "../../stores/boxes";
import { useSettingsStore } from "../../stores/settings";
import { DEFAULT_MIN_SUBWINDOW_PX, cmdToKind, useTabsStore } from "../../stores/tabs";
import type { GlobalAppEntry, KeyboardChord, ProjectBox, ProjectEntry, RemoteEntry, SshTooling, Theme } from "../../types";
import { resolveProjectDirectory, THEMES } from "../../types";
import {
  SHORTCUT_DEFS,
  chordFromEvent,
  chordLabel,
  resolveChord,
  type ShortcutAction,
  type ShortcutMap,
} from "../../lib/shortcuts";

const TERMINAL_OPTIONS = ["claude", "codex", "gemini", "vibe"];

interface OllamaModelInfo {
  name: string;
  size: number;
  parameter_size: string | null;
  quantization: string | null;
  family: string | null;
  running: boolean;
  size_vram: number;
}

interface CatalogEntry {
  name: string;
  description: string;
  tags: string[];
  size_hint: string;
}

interface ScaffoldPreviewItem {
  path: string;
  exists: boolean;
  kind: string;
}

const SCAFFOLD_FILL_OPTIONS = [
  { value: "none", label: "No filling" },
  { value: "manual", label: "Manual" },
  { value: "validation", label: "Validation" },
  { value: "agent_choice", label: "Agent choice" },
  { value: "claude", label: "Fill by Claude" },
  { value: "codex", label: "Fill by Codex" },
  { value: "gemini", label: "Fill by Gemini" },
  { value: "vibe", label: "Fill by Mistral" },
];

const AGENT_SCAFFOLD_FILL_MODES = new Set(["agent_choice", "claude", "codex", "gemini", "vibe"]);

interface ParsedSshAddress {
  user: string | null;
  host: string;
  port: number | null;
}

/**
 * Parse an SSH address of the form `[user@]host[:port]` (e.g. `me@box:2222`,
 * `box`, `me@box`). Returns null if no host can be extracted or the port is
 * not a valid number. The empty string yields null (= local, unchanged flow).
 */
function parseSshAddress(raw: string): ParsedSshAddress | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let user: string | null = null;
  let rest = trimmed;
  const at = rest.indexOf("@");
  if (at >= 0) {
    user = rest.slice(0, at) || null;
    rest = rest.slice(at + 1);
  }
  let port: number | null = null;
  const colon = rest.lastIndexOf(":");
  if (colon >= 0) {
    const portStr = rest.slice(colon + 1);
    const parsed = Number(portStr);
    if (!portStr || !Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
      return null;
    }
    port = parsed;
    rest = rest.slice(0, colon);
  }
  const host = rest.trim();
  if (!host) return null;
  return { user, host, port };
}

/** Join a remote directory path with a child segment using POSIX separators. */
function joinRemotePath(base: string, child: string): string {
  if (!base || base === "/") return `/${child}`;
  return `${base.replace(/\/+$/, "")}/${child}`;
}

function sanitizeName(name: string) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function projectDirectory(project: ProjectEntry) {
  return resolveProjectDirectory(project);
}

export function agentForScaffoldFillMode(fillMode: string, defaultAgentCmd: string) {
  return fillMode === "agent_choice" ? defaultAgentCmd : fillMode;
}

export function collectScaffoldAgentFills(
  preview: ScaffoldPreviewItem[],
  fillModes: Record<string, string>,
  defaultAgentCmd: string,
) {
  const filesByAgent = new Map<string, string[]>();
  for (const item of preview) {
    if (item.exists) continue;
    if (item.kind !== "file") continue;
    const fillMode = fillModes[item.path] ?? "none";
    if (!AGENT_SCAFFOLD_FILL_MODES.has(fillMode)) continue;
    const agent = agentForScaffoldFillMode(fillMode, defaultAgentCmd);
    const cmd = TERMINAL_OPTIONS.includes(agent) ? agent : "claude";
    filesByAgent.set(cmd, [...(filesByAgent.get(cmd) ?? []), item.path]);
  }
  return filesByAgent;
}

export function buildScaffoldFillPrompt(files: string[]) {
  const fileList = files.map((file) => `- ${file}`).join("\n");
  return [
    "Fill the Eldrun project scaffold files listed below.",
    "",
    "Instructions:",
    "- Inspect the project first so the files reflect the actual codebase and purpose.",
    "- Replace placeholder scaffold content with useful, project-specific guidance.",
    "- Preserve unrelated existing content and do not rewrite files outside this list.",
    "- Keep AGENTS.md practical for coding agents, including architecture, workflows, and constraints.",
    "",
    "Files to fill:",
    fileList,
  ].join("\n");
}

export function buildDescriptionFillPrompt(projectName: string) {
  return [
    `Write a concise Eldrun project description for "${projectName}".`,
    "",
    "Instructions:",
    "- Inspect the project first so the description reflects the actual codebase and purpose.",
    "- Update project.json by setting the top-level description field.",
    "- Keep it to one or two practical sentences suitable for a project switcher hover popup.",
    "- Preserve unrelated existing content and formatting where practical.",
  ].join("\n");
}

type SearchRow =
  | { kind: "project"; project: ProjectEntry }
  | { kind: "box"; box: ProjectBox };

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
  const [settingsPanel, setSettingsPanel] = useState<SettingsPanel>("main");
  const [ollamaInstalled, setOllamaInstalled] = useState(false);
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [dialog, setDialog] = useState<"new" | "import" | null>(null);

  useEffect(() => {
    if (!open) {
      setShowSettingsMenu(false);
      setShowAddMenu(false);
      setShowSettings(false);
      setDialog(null);
    }
  }, [open]);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLDivElement>(null);
  const pillsScrollRef = useRef<HTMLDivElement>(null);
  const [pillOverflow, setPillOverflow] = useState({ left: false, right: false });

  useEffect(() => {
    invoke<boolean>("ollama_is_installed").then(setOllamaInstalled).catch(() => {});
  }, []);

  const results = useMemo<SearchRow[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    // Boxes first (distinct rows), then matching inactive projects. Boxes are
    // opt-in: a box's members stay independently searchable below.
    const boxRows: SearchRow[] = boxes
      .filter((b) => b.name.toLowerCase().includes(q))
      .sort((a, b) => a.position - b.position)
      .map((box) => ({ kind: "box", box }));
    const projectRows: SearchRow[] = projects
      .filter((p) => p.status === "inactive")
      .filter((p) => p.name.toLowerCase().includes(q) || projectDirectory(p).toLowerCase().includes(q))
      .sort((a, b) => a.position - b.position)
      .map((project) => ({ kind: "project", project }));
    return [...boxRows, ...projectRows];
  }, [projects, boxes, query]);

  const activeProjects = useMemo(() => {
    return projects
      .filter((p) => p.status !== "inactive")
      .sort((a, b) => a.position - b.position);
  }, [projects]);

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

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!searchRef.current?.contains(event.target as Node)) {
        setQuery("");
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, []);

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

  const activateSearchResult = (row: SearchRow) => {
    setQuery("");
    if (row.kind === "box") {
      void openBox(row.box.id);
    } else {
      void setActive(row.project.id);
    }
  };

  // Shift-drop one pill onto another: spin up a fresh box holding both projects
  // (phone-style "drag onto" grouping). Assign the drop target first, then the
  // dragged pill, so both land in the new box; the user renames it via the chip.
  const groupProjects = async (fromId: string, toId: string) => {
    if (fromId === toId) return;
    const box = await createBox("New Box");
    await assignToBox(toId, box.id);
    await assignToBox(fromId, box.id);
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
      {dialog === "import" && createPortal(
        <ProjectDialog
          kind="import"
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
        <div className="project-search-wrap" ref={searchRef} onClick={(e) => e.stopPropagation()}>
          <input
            className="project-search-entry"
            type="search"
            placeholder="Search inactive..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && results.length === 1) {
                activateSearchResult(results[0]);
              }
              // (results is a project|box union; activateSearchResult branches.)
              if (e.key === "Escape") {
                setQuery("");
              }
            }}
          />
          {query.trim() && (
            <div className="project-search-popover">
              {results.length === 0 ? (
                <div className="project-search-empty">No projects</div>
              ) : (
                results.map((row) =>
                  row.kind === "box" ? (
                    <button
                      key={`box:${row.box.id}`}
                      className="project-search-row is-box"
                      onClick={() => activateSearchResult(row)}
                    >
                      <span>
                        <span className="project-box-badge" aria-hidden>▣</span> {row.box.name}
                      </span>
                      <small>
                        Box · {row.box.member_ids.length} member
                        {row.box.member_ids.length === 1 ? "" : "s"}
                      </small>
                    </button>
                  ) : (
                    <button
                      key={row.project.id}
                      className="project-search-row"
                      onClick={() => activateSearchResult(row)}
                    >
                      <span>{row.project.name}</span>
                      {projectDirectory(row.project) && (
                        <small>{projectDirectory(row.project)}</small>
                      )}
                    </button>
                  ),
                )
              )}
            </div>
          )}
        </div>

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

        <div className="project-switcher-add-wrap" onClick={(e) => e.stopPropagation()}>
          <button
            className="project-switcher-action-btn"
            title="Settings"
            onClick={() => {
              setShowAddMenu(false);
              setShowSettingsMenu((v) => !v);
            }}
          >
            ⚙
          </button>
          {showSettingsMenu && (
            <div className="project-switcher-add-menu">
              <button onClick={() => { setShowSettingsMenu(false); setSettingsPanel("main"); setShowSettings(true); }}>
                Settings
              </button>
              {ollamaInstalled && (
                <button onClick={() => { setShowSettingsMenu(false); setSettingsPanel("ollama"); setShowSettings(true); }}>
                  Ollama Models
                </button>
              )}
              <button onClick={() => { setShowSettingsMenu(false); setSettingsPanel("help"); setShowSettings(true); }}>
                Feature Guide
              </button>
            </div>
          )}
        </div>


        <div className="project-switcher-add-wrap" onClick={(e) => e.stopPropagation()}>
          <button
            className="project-switcher-add-btn"
            title="Add or import project"
            onClick={() => {
              setShowSettings(false);
              setShowAddMenu((v) => !v);
            }}
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

interface HelpItem {
  term: string;
  desc: string;
}

interface HelpSection {
  title: string;
  intro?: string;
  items: HelpItem[];
}

const HELP_SECTIONS: HelpSection[] = [
  {
    title: "Workspace layout",
    intro:
      "Eldrun keeps your AI-assisted development in a single window. Press Super while Eldrun is focused to toggle the panels, and F11 for fullscreen.",
    items: [
      { term: "Root terminal (▣)", desc: "The control terminal that always lives at ~/eldrun/root/, independent of any project." },
      { term: "Project pills", desc: "One pill per active project in the project switcher. Click to switch; each project keeps its own terminal and tabs. Drag pills to reorder them." },
      { term: "Center panel & tabs", desc: "The active project's terminals. Right-click the tab bar to add a Claude/Codex/Gemini agent or a plain shell, rename, or close tabs. Drag tabs to reorder." },
      { term: "Right file panel", desc: "A file-tree overlay for the active project. Open files, rename, and toggle hidden file types. The panel remembers the last folder per project." },
    ],
  },
  {
    title: "Projects",
    items: [
      { term: "Add (+)", desc: "Create a New Project (scaffolds files and a git repo under ~/eldrun/projects/) or Import an existing folder without touching its contents." },
      { term: "Search inactive", desc: "The search box finds projects that aren't currently open; pick one to activate its pill and terminal." },
      { term: "Remote (SSH) projects", desc: "Projects on a remote host are sshfs-mounted locally and behave like any other project. Requires sshfs/FUSE installed." },
      { term: "Tasks", desc: "Right-click a tab to set, complete, or clear an agent task. Tasks persist in the project's project.json and can seed a new agent's prompt." },
    ],
  },
  {
    title: "AI & terminals",
    items: [
      { term: "Default agent", desc: "Choose the default terminal command (claude, codex, gemini, vibe) in Settings. Missing commands fall back to a shell; closed agents respawn." },
      { term: "Ollama models", desc: "When Ollama is installed, the gear menu shows local models. Ctrl+K opens the local-model prompt dialog for the active context." },
    ],
  },
  {
    title: "Settings & extras",
    items: [
      { term: "Settings (⚙)", desc: "Theme, default agent, Git hosting profile/token, workspace management, background scripts, and debug mode." },
      { term: "Workspace integration", desc: "Optional KDE/X11 virtual-desktop isolation per project when workspace management is enabled." },
      { term: "Time tracking", desc: "Eldrun records active session time so you can see how long you spend per project." },
    ],
  },
];

/**
 * Group L / #62 — let the user rebind the eight navigation chords. Click a
 * row's chord button to enter capture mode; the next non-modifier keydown is
 * stored as the override (persisted to `settings.keyboard_shortcuts`). "Reset"
 * clears an override back to its built-in default.
 */
function ShortcutsSettings({ onBack }: { onBack: () => void }) {
  const { settings, updateSettings } = useSettingsStore();
  const overrides = (settings?.keyboard_shortcuts ?? {}) as ShortcutMap;
  const [capturing, setCapturing] = useState<ShortcutAction | null>(null);

  const saveMap = (next: ShortcutMap) => {
    void updateSettings({ keyboard_shortcuts: next as Record<string, KeyboardChord> });
  };

  const rebind = (action: ShortcutAction, chord: KeyboardChord) => {
    saveMap({ ...overrides, [action]: chord });
  };

  const reset = (action: ShortcutAction) => {
    const next = { ...overrides };
    delete next[action];
    saveMap(next);
  };

  // While capturing, the next real key sets the chord. Capture at the window
  // level so the keystroke is grabbed even though our hidden field, not a
  // terminal, has focus; ignore lone modifiers so the user can hold them.
  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setCapturing(null);
        return;
      }
      const chord = chordFromEvent(e);
      if (!chord) return; // lone modifier — keep waiting
      e.preventDefault();
      e.stopPropagation();
      rebind(capturing, chord);
      setCapturing(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capturing, overrides]);

  return (
    <>
      <div className="settings-title-row">
        <h2>Keyboard Shortcuts</h2>
        <button type="button" onClick={onBack}>Back</button>
      </div>
      <p className="settings-help">
        Click a shortcut, then press the new key combination. F11 (OS fullscreen)
        and Escape (exit fullscreen) are fixed and cannot be rebound.
      </p>
      <div className="settings-list">
        {SHORTCUT_DEFS.map((def) => {
          const active = capturing === def.action;
          const effective = resolveChord(def.action, overrides);
          const isCustom = !!overrides[def.action];
          return (
            <div className="settings-row shortcut-row" key={def.action}>
              <span className="settings-role-label">{def.label}</span>
              <button
                type="button"
                className={`shortcut-capture-btn${active ? " capturing" : ""}`}
                onClick={() => setCapturing(active ? null : def.action)}
                title="Click, then press a key combination"
              >
                {active ? "Press keys…" : chordLabel(effective)}
              </button>
              <button
                type="button"
                className="settings-back-btn"
                disabled={!isCustom}
                onClick={() => reset(def.action)}
                title="Reset to default"
              >
                Reset
              </button>
            </div>
          );
        })}
      </div>
    </>
  );
}

function HelpPanel({ onBack }: { onBack: () => void }) {
  return (
    <>
      <div className="settings-title-row">
        <h2>Eldrun Help</h2>
        <button type="button" onClick={onBack}>Back</button>
      </div>

      <p className="settings-help">
        A quick guide to what each part of Eldrun does. Hover the toolbar buttons for shortcuts too.
      </p>

      {HELP_SECTIONS.map((section) => (
        <div key={section.title} className="help-section">
          <div className="settings-section-title">{section.title}</div>
          {section.intro && <p className="settings-help">{section.intro}</p>}
          <dl className="help-list">
            {section.items.map((item) => (
              <div key={item.term} className="help-row">
                <dt>{item.term}</dt>
                <dd>{item.desc}</dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
    </>
  );
}

type SettingsPanel = "main" | "global" | "filetypes" | "ollama" | "shortcuts" | "help";

function SettingsDialog({
  onClose,
  initialPanel = "main",
}: {
  onClose: () => void;
  initialPanel?: SettingsPanel;
}) {
  const { settings, setTheme, updateSettings } = useSettingsStore();
  const [panel, setPanel] = useState<SettingsPanel>(initialPanel);
  const [gitProfileUrl, setGitProfileUrl] = useState(settings?.git_profile_url ?? "");
  const [gitToken, setGitToken] = useState(settings?.git_token ?? "");
  const [ollamaInstalled, setOllamaInstalled] = useState(false);

  useEffect(() => {
    invoke<boolean>("ollama_is_installed").then(setOllamaInstalled).catch(() => {});
  }, []);

  useEffect(() => {
    setGitProfileUrl(settings?.git_profile_url ?? "");
    setGitToken(settings?.git_token ?? "");
  }, [settings?.git_profile_url, settings?.git_token]);

  const terminal = settings?.terminal_command ?? "claude";
  const currentTheme = (settings?.color_scheme ?? "fancy_dark") as Theme;

  const saveGitProfileUrl = () => {
    void updateSettings({ git_profile_url: gitProfileUrl.trim() });
  };

  const saveGitToken = () => {
    void updateSettings({ git_token: gitToken.trim() });
  };

  return (
    <div className="modal-backdrop settings-backdrop" onMouseDown={onClose}>
      <div className="settings-dialog" onMouseDown={(e) => e.stopPropagation()}>
        {panel === "main" && (
          <>
            <div className="settings-title-row">
              <h2>Settings</h2>
              <button type="button" className="dialog-close-btn" onClick={onClose}>×</button>
            </div>

            <div className="settings-row">
              <label htmlFor="terminal-command">Terminal</label>
              <select
                id="terminal-command"
                value={terminal}
                onChange={(e) => void updateSettings({ terminal_command: e.target.value })}
              >
                {TERMINAL_OPTIONS.map((cmd) => (
                  <option key={cmd} value={cmd}>{cmd}</option>
                ))}
              </select>
            </div>

            <div className="settings-row">
              <label htmlFor="color-scheme">Theme</label>
              <select
                id="color-scheme"
                value={currentTheme}
                onChange={(e) => void setTheme(e.target.value as Theme)}
              >
                {THEMES.map((theme) => (
                  <option key={theme.value} value={theme.value}>{theme.label}</option>
                ))}
              </select>
            </div>

            <label className="settings-switch-row">
              <span>Manage workspaces</span>
              <input
                type="checkbox"
                checked={settings?.workspace_management ?? false}
                onChange={(e) => void updateSettings({ workspace_management: e.target.checked })}
              />
            </label>

            <label className="settings-switch-row">
              <span>Run scripts in background</span>
              <input
                type="checkbox"
                checked={settings?.run_scripts_in_background ?? true}
                onChange={(e) => void updateSettings({ run_scripts_in_background: e.target.checked })}
              />
            </label>

            <label className="settings-switch-row">
              <span>Debug mode</span>
              <input
                type="checkbox"
                checked={settings?.debug ?? false}
                onChange={(e) => void updateSettings({ debug: e.target.checked })}
              />
            </label>

            <div className="settings-section-title">Layout</div>
            <p className="settings-help">
              Smallest a subwindow may be made by dragging a split divider.
              Defaults to {DEFAULT_MIN_SUBWINDOW_PX}px when left blank.
            </p>
            <div className="settings-row">
              <label htmlFor="min-subwindow-width">Min subwindow width (px)</label>
              <input
                id="min-subwindow-width"
                type="number"
                min={20}
                step={10}
                placeholder={String(DEFAULT_MIN_SUBWINDOW_PX)}
                value={settings?.min_subwindow_width ?? ""}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  void updateSettings({
                    min_subwindow_width: Number.isFinite(v) && v >= 20 ? v : undefined,
                  });
                }}
              />
            </div>
            <div className="settings-row">
              <label htmlFor="min-subwindow-height">Min subwindow height (px)</label>
              <input
                id="min-subwindow-height"
                type="number"
                min={20}
                step={10}
                placeholder={String(DEFAULT_MIN_SUBWINDOW_PX)}
                value={settings?.min_subwindow_height ?? ""}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  void updateSettings({
                    min_subwindow_height: Number.isFinite(v) && v >= 20 ? v : undefined,
                  });
                }}
              />
            </div>

            <div className="settings-section-title">Git Hosting</div>
            <label className="settings-field">
              Profile URL
              <input
                value={gitProfileUrl}
                placeholder="https://github.com/username"
                onChange={(e) => setGitProfileUrl(e.target.value)}
                onBlur={saveGitProfileUrl}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveGitProfileUrl();
                }}
              />
            </label>
            <label className="settings-field">
              Access token
              <input
                type="password"
                value={gitToken}
                placeholder="ghp_... / glpat-..."
                onChange={(e) => setGitToken(e.target.value)}
                onBlur={saveGitToken}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveGitToken();
                }}
              />
            </label>

            <div className="settings-link-row">
              <button type="button" onClick={() => setPanel("global")}>Global Apps...</button>
              <button type="button" onClick={() => setPanel("filetypes")}>File Type Apps...</button>
              {ollamaInstalled && (
                <button type="button" onClick={() => setPanel("ollama")}>Ollama...</button>
              )}
              <button type="button" onClick={() => setPanel("shortcuts")}>Keyboard Shortcuts...</button>
              <button type="button" onClick={() => setPanel("help")}>Feature Guide...</button>
            </div>
          </>
        )}
        {panel === "global" && <GlobalAppsSettings onBack={() => setPanel("main")} />}
        {panel === "filetypes" && <FileTypeSettings onBack={() => setPanel("main")} />}
        {panel === "ollama" && <OllamaPanel onBack={() => setPanel("main")} />}
        {panel === "shortcuts" && <ShortcutsSettings onBack={() => setPanel("main")} />}
        {panel === "help" && <HelpPanel onBack={() => setPanel("main")} />}
      </div>
    </div>
  );
}

function GlobalAppsSettings({ onBack }: { onBack: () => void }) {
  const { settings, updateSettings } = useSettingsStore();
  const [apps, setApps] = useState<Record<string, GlobalAppEntry>>(settings?.global_apps ?? {});

  useEffect(() => {
    setApps(settings?.global_apps ?? {});
  }, [settings?.global_apps]);

  const saveApps = (next: Record<string, GlobalAppEntry>) => {
    setApps(next);
    void updateSettings({ global_apps: next });
  };

  const updateRole = (role: string, patch: Partial<GlobalAppEntry>) => {
    const current = apps[role] ?? { exec: "", visible: true };
    saveApps({ ...apps, [role]: { ...current, ...patch } });
  };

  const chooseExecutable = async (role: string) => {
    const picked = await open({ directory: false, multiple: false });
    if (typeof picked === "string") {
      updateRole(role, { exec: picked });
    }
  };

  return (
    <>
      <div className="settings-title-row">
        <h2>Global Apps</h2>
        <button type="button" onClick={onBack}>Back</button>
      </div>
      <p className="settings-help">Apps that stay visible across workspaces. Checked apps appear in the top toolbar.</p>
      <div className="settings-list">
        {GLOBAL_APP_ROLES.map((role) => {
          const entry = apps[role.key] ?? { exec: "", visible: true };
          return (
            <div className="global-app-settings-row" key={role.key}>
              <input
                type="checkbox"
                checked={entry.visible !== false}
                onChange={(e) => updateRole(role.key, { visible: e.target.checked })}
                title={`Show ${role.label}`}
              />
              <span className="settings-role-icon" aria-hidden>{role.fallback}</span>
              <span className="settings-role-label">{role.label}</span>
              <input
                value={entry.exec}
                placeholder="not found"
                onChange={(e) => setApps({ ...apps, [role.key]: { ...entry, exec: e.target.value } })}
                onBlur={(e) => updateRole(role.key, { exec: e.target.value.trim() })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") updateRole(role.key, { exec: e.currentTarget.value.trim() });
                }}
              />
              <button type="button" onClick={() => void chooseExecutable(role.key)}>...</button>
            </div>
          );
        })}
      </div>
    </>
  );
}

function FileTypeSettings({ onBack }: { onBack: () => void }) {
  const [apps, setApps] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState({ ext: "", app: "" });
  const [error, setError] = useState("");

  useEffect(() => {
    invoke<Record<string, string>>("get_default_apps")
      .then(setApps)
      .catch((err) => setError(String(err)));
  }, []);

  const saveApps = (next: Record<string, string>) => {
    setApps(next);
    invoke<void>("save_default_apps", { defaultApps: next }).catch((err) => setError(String(err)));
  };

  const normalizeExt = (ext: string) => {
    const trimmed = ext.trim();
    if (!trimmed) return "";
    return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
  };

  const chooseExecutable = async (ext: string) => {
    const picked = await open({ directory: false, multiple: false });
    if (typeof picked === "string") {
      saveApps({ ...apps, [ext]: picked });
    }
  };

  const addEntry = () => {
    const ext = normalizeExt(draft.ext);
    const app = draft.app.trim();
    if (!ext || !app) return;
    saveApps({ ...apps, [ext]: app });
    setDraft({ ext: "", app: "" });
  };

  return (
    <>
      <div className="settings-title-row">
        <h2>File Type Apps</h2>
        <button type="button" onClick={onBack}>Back</button>
      </div>
      <p className="settings-help">Double-clicking a project file opens it with the app below.</p>
      {error && <div className="project-dialog-error">{error}</div>}
      <div className="settings-list">
        {Object.entries(apps).sort(([a], [b]) => a.localeCompare(b)).map(([ext, app]) => (
          <div className="filetype-settings-row" key={ext}>
            <input
              value={ext}
              onChange={(e) => {
                const nextExt = normalizeExt(e.target.value);
                const { [ext]: old, ...rest } = apps;
                if (nextExt) saveApps({ ...rest, [nextExt]: old });
              }}
            />
            <input
              value={app}
              onChange={(e) => setApps({ ...apps, [ext]: e.target.value })}
              onBlur={(e) => saveApps({ ...apps, [ext]: e.target.value.trim() })}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveApps({ ...apps, [ext]: e.currentTarget.value.trim() });
              }}
            />
            <button type="button" onClick={() => void chooseExecutable(ext)}>...</button>
            <button
              type="button"
              onClick={() => {
                const { [ext]: _removed, ...rest } = apps;
                saveApps(rest);
              }}
              title="Remove"
            >
              ×
            </button>
          </div>
        ))}
        <div className="filetype-settings-row">
          <input
            value={draft.ext}
            placeholder=".ext"
            onChange={(e) => setDraft({ ...draft, ext: e.target.value })}
          />
          <input
            value={draft.app}
            placeholder="app command"
            onChange={(e) => setDraft({ ...draft, app: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") addEntry();
            }}
          />
          <button type="button" onClick={addEntry}>Add</button>
        </div>
      </div>
    </>
  );
}

function fmtBytes(n: number): string {
  if (n === 0) return "0 B";
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(0) + " MB";
  return (n / (1024 * 1024 * 1024)).toFixed(1) + " GB";
}

function OllamaPanel({ onBack }: { onBack: () => void }) {
  const [models, setModels] = useState<OllamaModelInfo[]>([]);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [serverRunning, setServerRunning] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await invoke<OllamaModelInfo[]>("list_ollama_models_detailed");
      setModels(result);
      setServerRunning(true);
    } catch (e) {
      if (String(e).includes("not_running")) {
        setServerRunning(false);
        setModels([]);
      } else {
        setError(String(e));
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    invoke<CatalogEntry[]>("list_installable_models").then(setCatalog).catch(() => {});
    void refresh();
  }, []);

  const startServer = async () => {
    setError(null);
    try {
      await invoke("ensure_ollama_running");
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  const withBusy = async (key: string, fn: () => Promise<void>) => {
    setBusy((prev) => ({ ...prev, [key]: true }));
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy((prev) => ({ ...prev, [key]: false }));
    }
  };

  const installedNames = useMemo(() => new Set(models.map((m) => m.name)), [models]);
  const runningModels = models.filter((m) => m.running);
  const loadedLabel =
    runningModels.length === 0
      ? serverRunning
        ? "No model loaded"
        : "No loaded model"
      : `Loaded: ${runningModels.map((m) => m.name).join(", ")}`;

  return (
    <>
      <div className="settings-title-row">
        <h2>Ollama Models</h2>
        <button type="button" onClick={onBack}>Back</button>
      </div>

      <div className="ollama-status-bar">
        <span className={`ollama-status-dot ${runningModels.length > 0 ? "running" : "stopped"}`} />
        <span className="ollama-status-text">
          {serverRunning === null
            ? "Checking..."
            : serverRunning
              ? loadedLabel
              : "Server not running"}
        </span>
        {serverRunning === false && (
          <button type="button" className="ollama-action-btn" onClick={() => void startServer()}>
            Start
          </button>
        )}
        {serverRunning === true && (
          <button
            type="button"
            className="ollama-action-btn"
            disabled={loading}
            onClick={() => void refresh()}
          >
            {loading ? "..." : "Refresh"}
          </button>
        )}
      </div>

      {error && <div className="project-dialog-error">{error}</div>}

      <div className="settings-section-title">Installed Models</div>
      {loading ? (
        <div className="ollama-empty">Loading...</div>
      ) : models.length === 0 ? (
        <div className="ollama-empty">No models installed</div>
      ) : (
        <div className="settings-list">
          {models.map((m) => (
            <div className="ollama-model-row" key={m.name}>
              <div className="ollama-model-header">
                <span className="ollama-model-name">{m.name}</span>
                <span className="ollama-model-size">{fmtBytes(m.size)}</span>
              </div>
              <div className="ollama-model-details">
                {m.parameter_size && <span className="ollama-badge">{m.parameter_size}</span>}
                {m.quantization && <span className="ollama-badge">{m.quantization}</span>}
                {m.family && <span className="ollama-badge">{m.family}</span>}
                {m.running && (
                  <span className={`ollama-badge running${m.size_vram > 0 ? " gpu" : ""}`}>
                    {m.size_vram > 0 ? `GPU ${fmtBytes(m.size_vram)}` : "CPU"}
                  </span>
                )}
              </div>
              <div className="ollama-model-actions">
                {m.running && (
                  <button
                    type="button"
                    className="ollama-action-btn"
                    disabled={busy[`${m.name}:stop`]}
                    title="Unload from memory"
                    onClick={() =>
                      void withBusy(`${m.name}:stop`, () =>
                        invoke("stop_ollama_model", { model: m.name }),
                      )
                    }
                  >
                    {busy[`${m.name}:stop`] ? "..." : "Unload"}
                  </button>
                )}
                <button
                  type="button"
                  className="ollama-action-btn"
                  disabled={busy[`${m.name}:pull`]}
                  title="Check for update and download latest"
                  onClick={() =>
                    void withBusy(`${m.name}:pull`, () =>
                      invoke("pull_ollama_model", { model: m.name }),
                    )
                  }
                >
                  {busy[`${m.name}:pull`] ? "Updating..." : "Update"}
                </button>
                <button
                  type="button"
                  className="ollama-action-btn danger"
                  disabled={busy[`${m.name}:del`]}
                  title="Delete this model"
                  onClick={() =>
                    void withBusy(`${m.name}:del`, () =>
                      invoke("delete_ollama_model", { model: m.name }),
                    )
                  }
                >
                  {busy[`${m.name}:del`] ? "..." : "Delete"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="settings-section-title ollama-section-title-row">
        <span>Available to Install</span>
        <button
          type="button"
          className="ollama-action-btn"
          disabled={loading}
          onClick={() => void refresh()}
        >
          {loading ? "..." : "Refresh"}
        </button>
      </div>
      <div className="settings-list">
        {catalog.map((entry) => (
          <div className="ollama-catalog-row" key={entry.name}>
            <div className="ollama-catalog-header">
              <span className="ollama-model-name">{entry.name}</span>
              <span className="ollama-catalog-hint">{entry.size_hint}</span>
            </div>
            <div className="ollama-catalog-desc">{entry.description}</div>
            <div className="ollama-catalog-tags">
              {entry.tags.map((tag) => {
                const fullName = `${entry.name}:${tag}`;
                const isInstalled = installedNames.has(fullName);
                const isBusy = busy[`${fullName}:pull`];
                return (
                  <button
                    key={tag}
                    type="button"
                    className={`ollama-tag-btn${isInstalled ? " installed" : ""}`}
                    disabled={!!isBusy}
                    title={isInstalled ? `Update ${fullName}` : `Install ${fullName}`}
                    onClick={() =>
                      void withBusy(`${fullName}:pull`, () =>
                        invoke("pull_ollama_model", { model: fullName }),
                      )
                    }
                  >
                    {isBusy ? "..." : tag}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function ProjectDialog({
  kind,
  onClose,
  onProject,
}: {
  kind: "new" | "import";
  onClose: () => void;
  onProject: (project: ProjectEntry) => void | Promise<void>;
}) {
  const defaultAgentCmd = useSettingsStore((s) => s.settings?.default_agent_cmd ?? "claude");
  const [projectsRoot, setProjectsRoot] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [descriptionFillMode, setDescriptionFillMode] = useState("manual");
  const [gitType, setGitType] = useState("local");
  const [mode, setMode] = useState("keep");
  const [skipScaffold, setSkipScaffold] = useState(false);
  const [sourceDir, setSourceDir] = useState("");
  const [scaffoldPreview, setScaffoldPreview] = useState<ScaffoldPreviewItem[]>([]);
  const [scaffoldFillModes, setScaffoldFillModes] = useState<Record<string, string>>({});
  const [scaffoldError, setScaffoldError] = useState("");
  const [manualValidationConfirmed, setManualValidationConfirmed] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // --- SSH / remote project support (optional) ---
  // Whether this is a remote (SSH) project. The whole SSH section — address,
  // password, connect, and the remote browser — only appears when this is on.
  const [isRemoteProject, setIsRemoteProject] = useState(false);
  // Availability of sshfs/sshpass/openvpn, fetched the first time the remote
  // checkbox is enabled so missing tools are flagged up front rather than only
  // after a connect/mount fails. `null` until probed.
  const [sshTooling, setSshTooling] = useState<SshTooling | null>(null);
  const [sshAddress, setSshAddress] = useState("");
  const [sshPassword, setSshPassword] = useState("");
  const [sshStatus, setSshStatus] = useState<"idle" | "connecting" | "connected" | "error">("idle");
  const [sshError, setSshError] = useState("");
  // The SSH address that was successfully connected (frozen at connect time so
  // edits to the input don't silently change which host we browse/submit to).
  const [remoteConn, setRemoteConn] = useState<ParsedSshAddress | null>(null);
  // The password that was used for the successful connect, frozen so the remote
  // listing always reuses the same credential the connection was made with.
  const [remotePassword, setRemotePassword] = useState("");
  const [remoteBrowsePath, setRemoteBrowsePath] = useState("");
  const [remoteEntries, setRemoteEntries] = useState<RemoteEntry[]>([]);
  const [remoteListBusy, setRemoteListBusy] = useState(false);
  const [remoteListError, setRemoteListError] = useState("");
  // The remote folder the user committed to via "Use this folder".
  const [remoteChosenPath, setRemoteChosenPath] = useState("");
  // --- Optional OpenVPN tunnel for VPN-gated remote hosts ---
  // `vpnConfig` holds the Eldrun-stored `.ovpn` path (the picked file is copied
  // into Eldrun on selection). The password is transient — never persisted.
  const [vpnEnabled, setVpnEnabled] = useState(false);
  const [vpnConfig, setVpnConfig] = useState("");
  const [vpnPassword, setVpnPassword] = useState("");
  const [vpnStatus, setVpnStatus] = useState<"idle" | "connecting" | "connected" | "error">("idle");
  const [vpnError, setVpnError] = useState("");
  const isRemote = sshStatus === "connected" && remoteConn !== null;
  const safeName = sanitizeName(name);
  const targetDir = safeName && projectsRoot ? `${projectsRoot}/${safeName}` : "";

  useEffect(() => {
    invoke<string>("projects_root_dir").then(setProjectsRoot).catch(() => {});
  }, []);

  useEffect(() => {
    if (kind !== "import" || !sourceDir) {
      setScaffoldPreview([]);
      setScaffoldError("");
      return;
    }

    let cancelled = false;
    setScaffoldError("");
    invoke<ScaffoldPreviewItem[]>("preview_project_scaffold", { sourceDir })
      .then((items) => {
        if (cancelled) return;
        setScaffoldPreview(items);
        setScaffoldFillModes((current) => {
          const next: Record<string, string> = {};
          for (const item of items) next[item.path] = current[item.path] ?? "none";
          return next;
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setScaffoldPreview([]);
        setScaffoldError(String(err));
      });

    return () => {
      cancelled = true;
    };
  }, [kind, sourceDir]);

  useEffect(() => {
    setManualValidationConfirmed(false);
  }, [mode, sourceDir]);

  const chooseFolder = async () => {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked === "string") {
      setSourceDir(picked);
      if (!name.trim()) {
        setName(picked.split("/").filter(Boolean).pop() ?? "");
      }
    }
  };

  const chooseLocation = async () => {
    const picked = await open({ directory: true, multiple: false, defaultPath: projectsRoot || undefined });
    if (typeof picked === "string") {
      setProjectsRoot(picked.replace(/\/+$/, ""));
    }
  };

  // Drop any live remote session back to the disconnected state. Called when
  // the user edits a credential (address/password) or unchecks "remote".
  const resetSshSession = () => {
    setSshStatus("idle");
    setSshError("");
    setRemoteConn(null);
    setRemotePassword("");
    setRemoteEntries([]);
    setRemoteBrowsePath("");
    setRemoteChosenPath("");
    setRemoteListError("");
  };

  // Toggle remote mode. Turning it off tears down the SSH session and clears the
  // entered credentials so the dialog falls back to the local create/import flow.
  const toggleRemoteProject = (checked: boolean) => {
    setIsRemoteProject(checked);
    if (checked) {
      // Probe the remote tooling once so we can warn about anything missing
      // before the user fills in an address and hits Connect/Create.
      if (sshTooling === null) {
        invoke<SshTooling>("ssh_tooling_status").then(setSshTooling).catch(() => {});
      }
    }
    if (!checked) {
      setSshAddress("");
      setSshPassword("");
      resetSshSession();
      setVpnEnabled(false);
      setVpnConfig("");
      setVpnPassword("");
      setVpnStatus("idle");
      setVpnError("");
    }
  };

  // Pick a `.ovpn` config and copy it into Eldrun so the project no longer
  // depends on the original file's location (stored on first use).
  const browseVpnConfig = async () => {
    const picked = await open({
      multiple: false,
      filters: [{ name: "OpenVPN config", extensions: ["ovpn", "conf"] }],
    });
    if (typeof picked !== "string") return;
    try {
      const stored = await invoke<string>("openvpn_store_config", { config: picked });
      setVpnConfig(stored);
      setVpnStatus("idle");
      setVpnError("");
    } catch (e) {
      setVpnError(String(e));
    }
  };

  // Bring the tunnel up now so a VPN-gated host becomes reachable for browsing.
  const connectVpn = async () => {
    if (!vpnConfig) return;
    setVpnStatus("connecting");
    setVpnError("");
    try {
      await invoke("openvpn_connect", { config: vpnConfig, password: vpnPassword });
      setVpnStatus("connected");
    } catch (e) {
      setVpnStatus("error");
      setVpnError(String(e));
    }
  };

  // Disconnect/reset the remote session when the user edits the SSH address.
  const onSshAddressChange = (value: string) => {
    setSshAddress(value);
    if (sshStatus !== "idle") resetSshSession();
  };

  // Editing the password also invalidates a live session — the next connect
  // must re-authenticate with the new credential.
  const onSshPasswordChange = (value: string) => {
    setSshPassword(value);
    if (sshStatus !== "idle") resetSshSession();
  };

  const connectSsh = async () => {
    const parsed = parseSshAddress(sshAddress);
    if (!parsed) {
      setSshStatus("error");
      setSshError("Enter an address like user@host or host:2222");
      return;
    }
    // Empty password → key/agent auth (Option<String> None on the backend).
    const password = sshPassword ? sshPassword : null;
    setSshStatus("connecting");
    setSshError("");
    setRemoteChosenPath("");
    try {
      await invoke<void>("ssh_connect", {
        user: parsed.user,
        host: parsed.host,
        port: parsed.port,
        password,
      });
      const startDir = await invoke<string>("ssh_default_dir", {
        user: parsed.user,
        host: parsed.host,
        port: parsed.port,
        password,
      }).catch(() => "");
      setRemoteConn(parsed);
      setRemotePassword(sshPassword);
      setSshStatus("connected");
      setRemoteBrowsePath(startDir || "");
    } catch (err) {
      setSshStatus("error");
      setSshError(String(err));
      setRemoteConn(null);
    }
  };

  // Refresh the remote folder listing whenever the browse path changes.
  useEffect(() => {
    if (sshStatus !== "connected" || !remoteConn) {
      setRemoteEntries([]);
      return;
    }
    let cancelled = false;
    setRemoteListBusy(true);
    setRemoteListError("");
    invoke<RemoteEntry[]>("ssh_list_dir", {
      user: remoteConn.user,
      host: remoteConn.host,
      port: remoteConn.port,
      password: remotePassword ? remotePassword : null,
      path: remoteBrowsePath,
    })
      .then((entries) => {
        if (cancelled) return;
        setRemoteEntries(entries);
      })
      .catch((err) => {
        if (cancelled) return;
        setRemoteEntries([]);
        setRemoteListError(String(err));
      })
      .finally(() => {
        if (!cancelled) setRemoteListBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sshStatus, remoteConn, remotePassword, remoteBrowsePath]);

  const enterRemoteFolder = (entry: RemoteEntry) => {
    if (!entry.is_dir) return;
    setRemoteBrowsePath(joinRemotePath(remoteBrowsePath, entry.name));
  };

  const remoteGoUp = () => {
    const path = remoteBrowsePath.replace(/\/+$/, "");
    if (!path || path === "/") {
      setRemoteBrowsePath("/");
      return;
    }
    const idx = path.lastIndexOf("/");
    setRemoteBrowsePath(idx <= 0 ? "/" : path.slice(0, idx));
  };

  const useThisRemoteFolder = () => {
    setRemoteChosenPath(remoteBrowsePath || "/");
    if (kind === "import" && !name.trim()) {
      const segs = (remoteBrowsePath || "").split("/").filter(Boolean);
      if (segs.length) setName(segs[segs.length - 1]);
    }
  };

  const selectedScaffoldAgentFills = () => {
    return collectScaffoldAgentFills(scaffoldPreview, scaffoldFillModes, defaultAgentCmd);
  };

  const selectedDescriptionAgent = () => {
    if (!AGENT_SCAFFOLD_FILL_MODES.has(descriptionFillMode)) return "";
    const agent = agentForScaffoldFillMode(descriptionFillMode, defaultAgentCmd);
    return TERMINAL_OPTIONS.includes(agent) ? agent : "claude";
  };

  const openScaffoldAgentTabs = async (project: ProjectEntry, filesByAgent: Map<string, string[]>) => {
    if (filesByAgent.size === 0) return;
    const projectCwd = resolveProjectDirectory(project);
    if (!projectCwd) return;

    const tabsStore = useTabsStore.getState();
    tabsStore.setScope(project.id);
    for (const [cmd, files] of filesByAgent) {
      const promptPath = `.eldrun/scaffold-fill-${cmd.replace(/[^a-z0-9_-]/gi, "-")}.md`;
      await invoke("write_project_file", {
        projectDir: projectCwd,
        relPath: promptPath,
        content: buildScaffoldFillPrompt(files),
      });
      tabsStore.addTab({
        label: `Fill scaffolds (${cmd})`,
        cmd,
        args: [],
        env: {},
        initialInput: `Read ${promptPath} and complete the scaffold filling task described there.`,
        cwd: projectCwd,
        kind: cmdToKind(cmd),
      });
    }
  };

  const openDescriptionAgentTab = async (project: ProjectEntry, cmd: string) => {
    if (!cmd) return;
    const projectCwd = resolveProjectDirectory(project);
    if (!projectCwd) return;

    const promptPath = `.eldrun/project-description-${cmd.replace(/[^a-z0-9_-]/gi, "-")}.md`;
    await invoke("write_project_file", {
      projectDir: projectCwd,
      relPath: promptPath,
      content: buildDescriptionFillPrompt(project.name),
    });
    const tabsStore = useTabsStore.getState();
    tabsStore.setScope(project.id);
    tabsStore.addTab({
      label: `Fill description (${cmd})`,
      cmd,
      args: [],
      env: {},
      initialInput: `Read ${promptPath} and complete the project description task described there.`,
      cwd: projectCwd,
      kind: cmdToKind(cmd),
    });
  };

  const submit = async () => {
    setError("");
    setBusy(true);
    try {
      // Remote scaffold filling runs over the local mount; for v1 we skip the
      // local-disk-only scaffold-fill agent tabs on import when remote.
      const scaffoldAgentFills =
        kind === "import" && !isRemote && !skipScaffold
          ? selectedScaffoldAgentFills()
          : new Map<string, string[]>();
      const descriptionAgent = selectedDescriptionAgent();
      // Build the remote spec for the create/import request when an SSH session
      // is connected. NEW: the project name becomes a subdir under the browsed
      // path. IMPORT: the browsed path IS the project root.
      const remoteSpec =
        isRemote && remoteConn
          ? {
              user: remoteConn.user ?? undefined,
              host: remoteConn.host,
              port: remoteConn.port ?? undefined,
              remote_path:
                kind === "new"
                  ? joinRemotePath(remoteChosenPath, safeName)
                  : remoteChosenPath,
              openvpn: vpnEnabled && vpnConfig ? { config: vpnConfig } : undefined,
            }
          : undefined;
      const project =
        kind === "new"
          ? await invoke<ProjectEntry>("create_project", {
              req: { name, directory: targetDir, description, gitType, remote: remoteSpec },
            })
          : await invoke<ProjectEntry>("import_project", {
              req: {
                // Backend ignores sourceDir for remote but the field is required;
                // pass the browsed remote path as a stand-in.
                sourceDir: isRemote ? remoteChosenPath : sourceDir,
                name,
                description,
                gitType,
                mode: isRemote ? "keep" : mode,
                scaffoldFillModes,
                manualValidationConfirmed,
                skipScaffold,
                remote: remoteSpec,
              },
            });
      await onProject(project);
      await openScaffoldAgentTabs(project, scaffoldAgentFills);
      await openDescriptionAgentTab(project, descriptionAgent);
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const canSubmit = isRemoteProject
    ? // Remote mode: must be connected and have a chosen remote folder.
      !isRemote
      ? false
      : kind === "new"
        ? Boolean(name.trim() && safeName && remoteChosenPath)
        : Boolean(name.trim() && remoteChosenPath)
    : kind === "new"
      ? Boolean(name.trim() && targetDir && safeName)
      : Boolean(
          name.trim() &&
          sourceDir &&
          (mode === "keep" || safeName) &&
          (mode === "keep" || manualValidationConfirmed),
        );

  const missingFillableScaffoldCount = scaffoldPreview.filter((item) => !item.exists && item.kind === "file").length;

  const applyScaffoldFillAll = (fillMode: string) => {
    setScaffoldFillModes((current) => {
      const next = { ...current };
      for (const item of scaffoldPreview) {
        if (!item.exists && item.kind === "file") next[item.path] = fillMode;
      }
      return next;
    });
  };

  const scaffoldStatusText = (item: ScaffoldPreviewItem) => {
    if (item.path === ".git") return item.exists ? "Already there" : "Missing";
    return item.exists ? "Already there, will be kept" : "Missing, will be added";
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="project-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <h2>{kind === "new" ? "New Project" : "Import Project"}</h2>

        <label className="remote-project-toggle">
          <input
            type="checkbox"
            checked={isRemoteProject}
            onChange={(e) => toggleRemoteProject(e.target.checked)}
          />
          Remote (SSH) project
        </label>

        {isRemoteProject && sshTooling && (() => {
          const warnings: string[] = [];
          if (!sshTooling.sshfs) {
            warnings.push(
              "sshfs not found — remote projects can't be mounted. Install sshfs/FUSE.",
            );
          }
          if (sshPassword && !sshTooling.sshpass) {
            warnings.push(
              "sshpass not found — password auth won't work. Install sshpass, or use SSH keys (leave the password blank).",
            );
          }
          if (vpnEnabled && !sshTooling.openvpn) {
            warnings.push(
              "openvpn/pkexec not found — VPN-gated hosts can't connect. Install openvpn and polkit.",
            );
          }
          if (warnings.length === 0) return null;
          return (
            <div className="ssh-tooling-warning" role="alert">
              {warnings.map((w) => (
                <div key={w}>⚠ {w}</div>
              ))}
            </div>
          );
        })()}

        {isRemoteProject && (
          <div className="ssh-connect-fields" role="group" aria-label="OpenVPN tunnel">
            <label className="remote-project-toggle vpn-toggle">
              <input
                type="checkbox"
                checked={vpnEnabled}
                onChange={(e) => {
                  setVpnEnabled(e.target.checked);
                  if (!e.target.checked) {
                    setVpnPassword("");
                    setVpnStatus("idle");
                    setVpnError("");
                  }
                }}
              />
              Connect via OpenVPN
            </label>
            {vpnEnabled && (
              <>
                <label>
                  OpenVPN config{" "}
                  <span className="ssh-optional-hint">(copied into Eldrun on selection)</span>
                  <div className="folder-picker-row">
                    <input
                      className="ssh-address-input"
                      readOnly
                      value={vpnConfig}
                      placeholder="No .ovpn selected"
                      title={vpnConfig}
                    />
                    <button type="button" onClick={() => void browseVpnConfig()}>
                      Browse…
                    </button>
                  </div>
                </label>
                <label>
                  VPN password{" "}
                  <span className="ssh-optional-hint">(not stored; asked again on activation)</span>
                  <div className="folder-picker-row">
                    <input
                      className="ssh-password-input"
                      type="password"
                      value={vpnPassword}
                      placeholder="VPN passphrase"
                      onChange={(e) => {
                        setVpnPassword(e.target.value);
                        if (vpnStatus !== "idle") setVpnStatus("idle");
                      }}
                    />
                    <button
                      type="button"
                      disabled={!vpnConfig || vpnStatus === "connecting"}
                      onClick={() => void connectVpn()}
                    >
                      {vpnStatus === "connecting"
                        ? "Connecting…"
                        : vpnStatus === "connected"
                          ? "Connected"
                          : "Connect VPN"}
                    </button>
                  </div>
                </label>
                {vpnStatus === "error" && vpnError && (
                  <div className="project-dialog-error">{vpnError}</div>
                )}
              </>
            )}
            <label>
              SSH address
              <input
                className="ssh-address-input"
                value={sshAddress}
                placeholder="user@host or host:2222"
                onChange={(e) => onSshAddressChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && sshAddress.trim() && sshStatus !== "connecting") {
                    e.preventDefault();
                    void connectSsh();
                  }
                  if (e.key === "Escape") onClose();
                }}
              />
            </label>
            <label>
              Password <span className="ssh-optional-hint">(blank uses SSH key)</span>
              <div className="folder-picker-row">
                <input
                  className="ssh-password-input"
                  type="password"
                  value={sshPassword}
                  placeholder="leave empty for key/agent auth"
                  onChange={(e) => onSshPasswordChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && sshAddress.trim() && sshStatus !== "connecting") {
                      e.preventDefault();
                      void connectSsh();
                    }
                    if (e.key === "Escape") onClose();
                  }}
                />
                <button
                  type="button"
                  disabled={!sshAddress.trim() || sshStatus === "connecting"}
                  onClick={() => void connectSsh()}
                >
                  {sshStatus === "connecting"
                    ? "Connecting..."
                    : sshStatus === "connected"
                      ? "Connected"
                      : "Connect"}
                </button>
              </div>
            </label>
            {sshStatus === "error" && sshError && (
              <div className="project-dialog-error">{sshError}</div>
            )}
          </div>
        )}

        {isRemote && (
          <div className="remote-browser" role="group" aria-label="Remote folder browser">
            <div className="remote-browser-header">
              <button type="button" className="remote-up-btn" onClick={remoteGoUp} title="Go up">
                ..
              </button>
              <span className="remote-breadcrumb" title={remoteBrowsePath}>
                {remoteBrowsePath || "/"}
              </span>
              <button type="button" onClick={useThisRemoteFolder}>
                Use this folder
              </button>
            </div>
            <div className="remote-list">
              {remoteListBusy && <div className="scaffold-empty">Listing...</div>}
              {!remoteListBusy && remoteListError && (
                <div className="project-dialog-error">{remoteListError}</div>
              )}
              {!remoteListBusy && !remoteListError && remoteEntries.length === 0 && (
                <div className="scaffold-empty">Empty folder.</div>
              )}
              {!remoteListBusy &&
                !remoteListError &&
                remoteEntries.map((entry) => (
                  <div
                    key={entry.name}
                    className={`remote-entry ${entry.is_dir ? "is-dir" : "is-file"}`}
                    role={entry.is_dir ? "button" : undefined}
                    tabIndex={entry.is_dir ? 0 : undefined}
                    onClick={() => enterRemoteFolder(entry)}
                    onKeyDown={(e) => {
                      if (entry.is_dir && (e.key === "Enter" || e.key === " ")) {
                        e.preventDefault();
                        enterRemoteFolder(entry);
                      }
                    }}
                  >
                    <span className="remote-entry-icon">{entry.is_dir ? "[ ]" : "·"}</span>
                    <span className="remote-entry-name">{entry.name}</span>
                  </div>
                ))}
            </div>
            <div className="remote-chosen">
              {remoteChosenPath
                ? kind === "new"
                  ? `Will create: ${joinRemotePath(remoteChosenPath, safeName || "<name>")}`
                  : `Selected: ${remoteChosenPath}`
                : "Browse to a folder, then click “Use this folder”."}
            </div>
          </div>
        )}

        {kind === "import" && !isRemoteProject && (
          <label>
            Source folder
            <div className="folder-picker-row">
              <span title={sourceDir}>{sourceDir || "No folder selected"}</span>
              <button type="button" onClick={chooseFolder}>Browse...</button>
            </div>
          </label>
        )}

        {kind === "new" && !isRemoteProject && (
          <label>
            Location
            <div className="folder-picker-row">
              <span title={projectsRoot}>{projectsRoot || "No folder selected"}</span>
              <button type="button" onClick={chooseLocation}>Browse...</button>
            </div>
          </label>
        )}

        <label>
          Project name
          <input
            autoFocus
            value={name}
            placeholder="my-project"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canSubmit && !busy) void submit();
              if (e.key === "Escape") onClose();
            }}
          />
        </label>

        <label className="project-description-field">
          <div className="project-description-header">
            <span>Project description</span>
            <select
              aria-label="Project description fill mode"
              value={descriptionFillMode}
              onChange={(e) => setDescriptionFillMode(e.target.value)}
            >
              <option value="manual">Manual</option>
              <option value="agent_choice">Agent choice</option>
              <option value="claude">Claude</option>
              <option value="codex">Codex</option>
              <option value="gemini">Gemini</option>
              <option value="vibe">Mistral</option>
            </select>
          </div>
          <textarea
            value={description}
            placeholder="What this project is for"
            rows={3}
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
            }}
          />
        </label>

        <label>
          Git push target
          <select value={gitType} onChange={(e) => setGitType(e.target.value)}>
            <option value="local">Local only (no remote)</option>
            <option value="remote-private">Remote · private</option>
            <option value="remote-public">Remote · public</option>
          </select>
        </label>

        {kind === "import" && !isRemoteProject && (
          <label>
            Import mode
            <select value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="keep">Keep location (register in place)</option>
              <option value="copy">Copy to ~/eldrun/projects/</option>
              <option value="move">Move to ~/eldrun/projects/</option>
            </select>
          </label>
        )}

        {kind === "import" && isRemoteProject && (
          <div className="project-dialog-path">
            Remote import keeps the folder in place on the remote host.
          </div>
        )}

        {kind === "import" && (
          <label className="skip-scaffold-row">
            <input
              type="checkbox"
              checked={skipScaffold}
              onChange={(e) => setSkipScaffold(e.target.checked)}
            />
            Skip scaffolding (do not generate any scaffold files)
          </label>
        )}

        {kind === "import" && !isRemoteProject && !skipScaffold && (
          <div className="scaffold-popover" role="group" aria-label="Import scaffold guidance">
            <div className="scaffold-popover-title">Import guidance</div>
            <ol className="scaffold-steps">
              <li>Select the source folder and project metadata.</li>
              <li>
                {mode === "keep"
                  ? "Register the project in its current location."
                  : mode === "copy"
                    ? "Copy the project to the Eldrun projects folder after manual validation."
                    : "Move the project to the Eldrun projects folder after manual validation."}
              </li>
              <li>Create missing scaffold files and acknowledge files already there.</li>
              <li>Write project.json and add the project to the switcher.</li>
            </ol>

            {mode !== "keep" && (
              <label className="manual-validation-row">
                <input
                  type="checkbox"
                  checked={manualValidationConfirmed}
                  onChange={(e) => setManualValidationConfirmed(e.target.checked)}
                />
                I manually validated the {mode} destination and source folder.
              </label>
            )}

            <label className="scaffold-fill-all-row">
              <span>Fill all</span>
              <select
                value=""
                disabled={missingFillableScaffoldCount === 0}
                onChange={(e) => applyScaffoldFillAll(e.target.value)}
              >
                <option value="" disabled>
                  {missingFillableScaffoldCount === 0 ? "No missing files" : "Choose fill mode..."}
                </option>
                {SCAFFOLD_FILL_OPTIONS.map((option) => (
                  <option value={option.value} key={option.value}>{option.label}</option>
                ))}
              </select>
            </label>

            <div className="scaffold-list">
              {scaffoldPreview.map((item) => (
                <div className="scaffold-row" key={item.path}>
                  <div className="scaffold-file">
                    <span>{item.path}</span>
                    <small>{scaffoldStatusText(item)}</small>
                  </div>
                  {item.kind === "file" ? (
                    <select
                      value={item.exists ? "none" : scaffoldFillModes[item.path] ?? "none"}
                      disabled={item.exists}
                      onChange={(e) =>
                        setScaffoldFillModes((current) => ({ ...current, [item.path]: e.target.value }))
                      }
                    >
                      {SCAFFOLD_FILL_OPTIONS.map((option) => (
                        <option value={option.value} key={option.value}>{option.label}</option>
                      ))}
                    </select>
                  ) : (
                    <span className="scaffold-row-status">Status only</span>
                  )}
                </div>
              ))}
              {!sourceDir && <div className="scaffold-empty">Choose a source folder to preview scaffold files.</div>}
              {sourceDir && !scaffoldPreview.length && !scaffoldError && (
                <div className="scaffold-empty">Loading scaffold preview...</div>
              )}
              {scaffoldError && <div className="project-dialog-error">{scaffoldError}</div>}
            </div>
          </div>
        )}

        <div className="project-dialog-path">
          {isRemote
            ? remoteChosenPath
              ? kind === "new"
                ? `Remote destination: ${joinRemotePath(remoteChosenPath, safeName || "<name>")}`
                : `Remote location: ${remoteChosenPath}`
              : ""
            : kind === "new" || mode !== "keep"
              ? targetDir
                ? `Destination: ${targetDir}`
                : ""
              : sourceDir
                ? `Location: ${sourceDir}`
                : ""}
        </div>
        {error && <div className="project-dialog-error">{error}</div>}

        <div className="project-dialog-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" disabled={!canSubmit || busy} onClick={() => void submit()}>
            {busy ? "Working..." : kind === "new" ? "Create" : "Import"}
          </button>
        </div>
      </div>
    </div>
  );
}
