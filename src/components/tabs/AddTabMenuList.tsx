import { Fragment, useState } from "react";

/** One pickable row in the add-tab menu. */
export interface AddMenuEntry {
  /** React key — unique within the entry's group. */
  key: string;
  label: string;
  /** Dot glyph in front of the label (defaults to "●"). */
  dot?: string;
  /** Dot color (a TAB_ACCENT value or any CSS color). */
  color: string;
  disabled?: boolean;
  onPick: () => void;
}

/** One labelled section of the add-tab menu. */
export interface AddMenuGroup {
  label: string;
  entries: AddMenuEntry[];
  /** Non-pickable explainer rendered when the group has no entries (only while
   *  the search box is empty — a hint is not a search result). */
  hint?: string;
}

/**
 * The searchable body of the "+" add-tab menu, shared by the main-window
 * `TabBar` and the detached popout's `NewTabMenu` so both filter identically.
 * The search box is auto-focused, so "click + and type" filters immediately;
 * a query narrows entries by label (a group-label match keeps its whole
 * group, so "files" surfaces both file panes), Enter picks the first
 * pickable match, and Escape clears the query before it closes the menu.
 */
export function AddTabMenuList({ groups }: { groups: AddMenuGroup[] }) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();

  const visible = q
    ? groups
        .map((g) => ({
          label: g.label,
          hint: undefined,
          entries: g.label.toLowerCase().includes(q)
            ? g.entries
            : g.entries.filter((e) => e.label.toLowerCase().includes(q)),
        }))
        .filter((g) => g.entries.length > 0)
    : groups;

  // The entry Enter would pick — highlighted so the shortcut is discoverable.
  // Compared by identity below, so entry keys only need per-group uniqueness.
  const first = q
    ? visible.flatMap((g) => g.entries).find((e) => !e.disabled)
    : undefined;

  return (
    <>
      <input
        className="tab-new-menu-search"
        type="text"
        placeholder="Search…"
        value={query}
        autoFocus
        spellCheck={false}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && first) {
            e.preventDefault();
            first.onPick();
          } else if (e.key === "Escape" && query) {
            // First Escape clears the query; only an empty-query Escape is
            // allowed to bubble on to the menu's document-level close handler.
            e.stopPropagation();
            setQuery("");
          }
        }}
      />
      {visible.length === 0 && <div className="tab-new-menu-hint">No matches</div>}
      {visible.map((g) => (
        <Fragment key={g.label}>
          <div className="tab-new-menu-group-label">{g.label}</div>
          {g.entries.map((e) => (
            <button
              key={e.key}
              className={`tab-new-menu-item${e === first ? " enter-target" : ""}`}
              disabled={e.disabled}
              onClick={e.onPick}
            >
              <span className="tab-new-menu-dot" style={{ color: e.color }}>
                {e.dot ?? "●"}
              </span>
              {e.label}
            </button>
          ))}
          {g.entries.length === 0 && g.hint && (
            <div className="tab-new-menu-hint">{g.hint}</div>
          )}
        </Fragment>
      ))}
    </>
  );
}
