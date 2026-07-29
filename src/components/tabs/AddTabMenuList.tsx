import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { UntestedTag } from "../common/UntestedTag";
import { useT } from "../../lib/i18n";

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
  /** Render the shared `<UntestedTag />` after the label (and give the button the
   *  `untested` class, so label and tag lay out in a row). A menu entry cannot
   *  carry a ReactNode label — the search box filters on `label` as a string — so
   *  the tag is a flag here rather than markup at the call site. */
  untested?: boolean;
  /** A sentence about a risk in picking this entry, shown as a `⚠` after the
   *  label with the sentence as its tooltip. A caution, never a block: the row
   *  stays pickable, which is the difference between this and `disabled`. Like
   *  `untested` it is a flag rather than markup, for that field's reason — the
   *  search box filters on `label` as a string, so a label cannot be a node. */
  caution?: string;
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
 * group, so "files" surfaces both file panes), and Escape clears the query
 * before it closes the menu.
 *
 * ↑/↓ walk the results and Enter picks the highlighted one. There is exactly
 * ONE cursor, and the pointer moves it too: the keyboard highlight and the
 * hover highlight are the same row, so arrowing after a hover continues from
 * where the pointer left off instead of from a second, invisible position.
 * That is also why the pointer half is bound to `pointermove` and not
 * `pointerenter` — a keyboard move that scrolls a row under a *stationary*
 * pointer fires enter events, which would drag the cursor back and make ↓
 * appear to stick.
 */
export function AddTabMenuList({ groups }: { groups: AddMenuGroup[] }) {
  const t = useT();
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

  // The pickable rows in render order — what ↑/↓ walk. Disabled entries are
  // skipped rather than stepped over, so the cursor never lands somewhere
  // Enter would do nothing from.
  const pickable = useMemo(
    () => visible.flatMap((g) => g.entries).filter((e) => !e.disabled),
    [visible],
  );

  // The cursor position, plus whether the user has moved it themselves. With a
  // live query row 0 is highlighted from the start (Enter picks the best match,
  // as it always did); with an empty query nothing is highlighted until an
  // arrow key or the pointer says so, so opening the menu doesn't preselect.
  const [cursor, setCursor] = useState(0);
  const [moved, setMoved] = useState(false);
  useEffect(() => {
    setCursor(0);
    setMoved(false);
  }, [q]);

  // Clamp rather than store-and-fix: the entry list shrinks under us when a
  // probe resolves (installed agents, local drivers), and a stale index would
  // otherwise point past the end for a frame.
  const idx = pickable.length ? Math.min(cursor, pickable.length - 1) : -1;
  const active = (q || moved) && idx >= 0 ? pickable[idx] : undefined;

  // Keep the highlighted row on screen while arrowing through a long list.
  const activeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (active) activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const step = (delta: number) => {
    if (!pickable.length) return;
    const live = Boolean(q) || moved; // is a row highlighted right now?
    setCursor((c) =>
      live
        // Wrap at both ends: this menu is short enough that the last entry is
        // quicker to reach with one ↑ than with a dozen ↓.
        ? (Math.min(c, pickable.length - 1) + delta + pickable.length) % pickable.length
        // Nothing highlighted yet: ↓ enters at the top, ↑ at the bottom.
        : delta > 0 ? 0 : pickable.length - 1,
    );
    setMoved(true);
  };

  return (
    <>
      <input
        className="tab-new-menu-search"
        type="text"
        placeholder={t("newTabMenu.searchPlaceholder")}
        value={query}
        autoFocus
        spellCheck={false}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            step(1);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            step(-1);
          } else if (e.key === "Home" && (q || moved)) {
            e.preventDefault();
            setMoved(true);
            setCursor(0);
          } else if (e.key === "End" && (q || moved)) {
            e.preventDefault();
            setMoved(true);
            setCursor(Math.max(0, pickable.length - 1));
          } else if (e.key === "Enter" && active) {
            e.preventDefault();
            active.onPick();
          } else if (e.key === "Escape" && query) {
            // First Escape clears the query; only an empty-query Escape is
            // allowed to bubble on to the menu's document-level close handler.
            e.stopPropagation();
            setQuery("");
          }
        }}
      />
      {visible.length === 0 && <div className="tab-new-menu-hint">{t("newTabMenu.noMatches")}</div>}
      {visible.map((g) => (
        <Fragment key={g.label}>
          <div className="tab-new-menu-group-label">{g.label}</div>
          {g.entries.map((e) => (
            <button
              key={e.key}
              ref={e === active ? activeRef : undefined}
              className={`tab-new-menu-item${e === active ? " enter-target" : ""}${
                e.untested ? " untested" : ""
              }`}
              disabled={e.disabled}
              onClick={e.onPick}
              // The pointer owns the same cursor the keys do. Guarded on an
              // actual change so a mouse resting on a row doesn't re-render
              // the menu on every move event.
              onPointerMove={() => {
                if (e.disabled || e === active) return;
                const at = pickable.indexOf(e);
                if (at < 0) return;
                setMoved(true);
                setCursor(at);
              }}
            >
              <span className="tab-new-menu-dot" style={{ color: e.color }}>
                {e.dot ?? "●"}
              </span>
              {e.label}
              {e.caution && (
                <span className="tab-new-menu-caution" title={e.caution} aria-label={e.caution}>
                  ⚠
                </span>
              )}
              {e.untested && <UntestedTag />}
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
