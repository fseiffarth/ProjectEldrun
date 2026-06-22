import { useEffect, useMemo, useRef, useState } from "react";
import type { ProjectBox, ProjectEntry } from "../../types";
import { projectDirectory } from "./scaffold";

type SearchRow =
  | { kind: "project"; project: ProjectEntry }
  | { kind: "box"; box: ProjectBox };

/**
 * The inactive-project / box search box and its results popover. Owns its own
 * query state and click-outside dismissal; activation is delegated to the
 * parent via `onActivateProject` / `onOpenBox`.
 */
export function ProjectSearch({
  projects,
  boxes,
  onActivateProject,
  onOpenBox,
}: {
  projects: ProjectEntry[];
  boxes: ProjectBox[];
  onActivateProject: (projectId: string) => void;
  onOpenBox: (boxId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!searchRef.current?.contains(event.target as Node)) {
        setQuery("");
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, []);

  const activateSearchResult = (row: SearchRow) => {
    setQuery("");
    if (row.kind === "box") {
      onOpenBox(row.box.id);
    } else {
      onActivateProject(row.project.id);
    }
  };

  return (
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
  );
}
