import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import type { ProjectBox } from "../types";
import { resolveProjectDirectory } from "../types";
import { useProjectsStore } from "./projects";
import { cmdToKind, useTabsStore } from "./tabs";

/** Scope-id prefix for box-rooted tabs, disjoint from project ids and "root". */
export const BOX_SCOPE_PREFIX = "box:";

export function boxScopeId(boxId: string): string {
  return `${BOX_SCOPE_PREFIX}${boxId}`;
}

/**
 * Derive the per-project `box_id` inverse from the authoritative box
 * `member_ids` (B2: member_ids wins; a stale `box_id` is overridden). Pure —
 * returns the corrected projects list without mutating any store. The box store
 * applies this on load IN MEMORY only; it is never written back on load (a write
 * happens only on the next mutating action).
 */
export function deriveBoxIds<T extends { id: string; box_id?: string }>(
  projects: T[],
  boxes: ProjectBox[],
): T[] {
  const inverse = new Map<string, string>();
  for (const box of boxes) {
    for (const memberId of box.member_ids) inverse.set(memberId, box.id);
  }
  return projects.map((p) => {
    const derived = inverse.get(p.id);
    if (derived === p.box_id) return p;
    if (derived === undefined) {
      if (p.box_id === undefined) return p;
      const { box_id: _drop, ...rest } = p as T & { box_id?: string };
      return rest as T;
    }
    return { ...p, box_id: derived };
  });
}

interface BoxesStore {
  boxes: ProjectBox[];
  loaded: boolean;
  /** Load boxes and derive `box_id` on every project (in-memory; no write). */
  load: () => Promise<void>;
  createBox: (name: string) => Promise<ProjectBox>;
  renameBox: (boxId: string, name: string) => Promise<void>;
  /** Delete a box and REQUIRED-clear `box_id` on every former member. */
  deleteBox: (boxId: string) => Promise<void>;
  /** Assign a project to a box (or null to ungroup); persists both files. */
  assignToBox: (projectId: string, boxId: string | null) => Promise<void>;
  /** Open a box as a session-only scope rooted in its (lazily created) folder. */
  openBox: (boxId: string) => Promise<void>;
}

/** Persist the current projects list via save_projects (mirrors projects store). */
async function persistProjects(): Promise<void> {
  const projects = useProjectsStore.getState().projects;
  await invoke<void>("save_projects", { projects });
}

export const useBoxesStore = create<BoxesStore>((set, get) => ({
  boxes: [],
  loaded: false,

  load: async () => {
    const boxes = await invoke<ProjectBox[]>("get_boxes").catch(() => [] as ProjectBox[]);
    set({ boxes, loaded: true });
    // Derive box_id from member_ids onto the in-memory projects (B2). No write:
    // the corrected box_id is persisted only on the next mutating box action.
    useProjectsStore.setState((state) => ({
      projects: deriveBoxIds(state.projects, boxes),
    }));
  },

  createBox: async (name) => {
    const box = await invoke<ProjectBox>("create_box", { name });
    set((state) => ({ boxes: [...state.boxes, box] }));
    return box;
  },

  renameBox: async (boxId, name) => {
    const updated = await invoke<ProjectBox>("rename_box", { boxId, name });
    set((state) => ({
      boxes: state.boxes.map((b) => (b.id === boxId ? updated : b)),
    }));
  },

  deleteBox: async (boxId) => {
    const box = get().boxes.find((b) => b.id === boxId);
    await invoke<void>("delete_box", { boxId });
    set((state) => ({ boxes: state.boxes.filter((b) => b.id !== boxId) }));
    // REQUIRED (S1): clear box_id on every former member so no pill keeps a
    // dangling reference. Persist via save_projects.
    const memberIds = new Set(box?.member_ids ?? []);
    if (memberIds.size > 0) {
      useProjectsStore.setState((state) => ({
        projects: state.projects.map((p) => {
          if (!memberIds.has(p.id) || p.box_id === undefined) return p;
          const { box_id: _drop, ...rest } = p;
          return rest;
        }),
      }));
      await persistProjects();
    }
  },

  assignToBox: async (projectId, boxId) => {
    // The box the project is leaving (if any) — refreshed below if it survives.
    const prevBoxId = get().boxes.find((b) => b.member_ids.includes(projectId))?.id ?? null;
    // Update the authoritative member_ids on the affected box(es): remove the
    // project from any box it was in, then add it to the target (if any).
    let updatedBoxes: ProjectBox[] = [];
    set((state) => {
      updatedBoxes = state.boxes.map((b) => {
        const wasMember = b.member_ids.includes(projectId);
        if (b.id === boxId) {
          return wasMember ? b : { ...b, member_ids: [...b.member_ids, projectId] };
        }
        return wasMember
          ? { ...b, member_ids: b.member_ids.filter((id) => id !== projectId) }
          : b;
      });
      // A box is meaningless with a single member: any box (other than the one
      // just assigned TO) left with exactly one member dissolves — its lone
      // member is ejected (ungrouped) and the box is dropped. This is what makes
      // "drag a project out of a 2-member box" tear the whole box down.
      const ejected = new Set<string>();
      updatedBoxes = updatedBoxes.filter((b) => {
        if (b.id === boxId) return true;
        if (b.member_ids.length === 1) {
          ejected.add(b.member_ids[0]);
          return false;
        }
        return true;
      });
      // Mirror box_id onto the moved project + clear it on every ejected member.
      useProjectsStore.setState((pstate) => ({
        projects: pstate.projects.map((p) => {
          const leaving = ejected.has(p.id) || (p.id === projectId && boxId === null);
          if (leaving) {
            if (p.box_id === undefined) return p;
            const { box_id: _drop, ...rest } = p;
            return rest;
          }
          if (p.id === projectId && boxId !== null) return { ...p, box_id: boxId };
          return p;
        }),
      }));
      return { boxes: updatedBoxes };
    });
    // Persist both files (box membership + the projects' box_id back-references).
    await invoke<void>("save_boxes", { boxes: updatedBoxes });
    await persistProjects();
    // Refresh the box agent docs (member links) for each affected box that has
    // already been opened (has a folder). No-op backend-side when a box has no
    // folder yet or has dissolved. Best-effort — never block the assignment.
    const affected = new Set<string>();
    if (boxId) affected.add(boxId);
    if (prevBoxId) affected.add(prevBoxId);
    for (const id of affected) {
      const box = updatedBoxes.find((b) => b.id === id);
      if (box?.folder) {
        await invoke<void>("refresh_box_agent_docs", { boxId: id }).catch(() => {});
      }
    }
  },

  openBox: async (boxId) => {
    const box = get().boxes.find((b) => b.id === boxId);
    if (!box) return;
    // Lazily create the box folder and capture the resolved path back into state.
    const folder = await invoke<string>("ensure_box_folder", { boxId });
    set((state) => ({
      boxes: state.boxes.map((b) => (b.id === boxId ? { ...b, folder } : b)),
    }));
    // Activate a box scope (disjoint from project ids / "root"). NOTE: box scopes
    // are session-only this pass — switch_project_runtime does not persist or
    // restore them, so the box's tabs vanish on project switch / restart
    // (#41 Phase 2 cut; full box activation is a follow-on).
    const tabsStore = useTabsStore.getState();
    const scope = boxScopeId(boxId);
    tabsStore.setScope(scope);
    if ((tabsStore.tabsByScope[scope] ?? []).length === 0) {
      tabsStore.addTab({
        label: box.name,
        cmd: "",
        args: [],
        env: {},
        cwd: folder,
        kind: "shell",
      });
    }
  },
}));

/**
 * Build the search-result rows for the switcher: inactive projects matching the
 * query plus boxes matching by name, as a discriminated union (N3).
 */
export type SearchRow =
  | { kind: "project"; project: import("../types").ProjectEntry }
  | { kind: "box"; box: ProjectBox };

/** Convenience: resolve a member project's directory for box surfacing. */
export function memberDirectories(box: ProjectBox): string[] {
  const projects = useProjectsStore.getState().projects;
  return box.member_ids
    .map((id) => projects.find((p) => p.id === id))
    .map((p) => resolveProjectDirectory(p))
    .filter((d) => d.length > 0);
}

// Re-export so consumers building box agent tabs can derive kinds consistently.
export { cmdToKind };
