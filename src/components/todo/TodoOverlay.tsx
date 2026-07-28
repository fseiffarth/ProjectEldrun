import { useEffect } from "react";

import { useSettingsStore } from "../../stores/settings";
import { useTodoStore } from "../../stores/todo";
import { useT } from "../../lib/i18n";
import { UntestedTag } from "../common/UntestedTag";
import { TodoPane } from "./TodoPane";

/**
 * The header ☑ button's overlay — the todo board's only surface, and the third
 * member of the `MailOverlay` / `CalendarOverlay` family, built the same way for
 * the same reason: a *tab* belongs to a scope, and your to-do list is not a
 * property of whichever project you happen to be looking at.
 *
 * There is deliberately no todo **tab**. The store is the calendar's — one
 * `calendar.json` across every scope — so a scoped tab could only ever show the
 * same board while still being left behind by a project switch, which is exactly
 * the redundancy that retired the mail tab.
 *
 * One gate, `todo_board`, off by default and with no experimental flag above it:
 * the board's cards *are* the calendar's tasks, so it reads one shipped local
 * file and reaches nothing. Switching the gate off takes the surface away rather
 * than leaving it on screen over a button that is no longer there — the same
 * withdrawal rule both sibling overlays follow.
 *
 * **Not mounted in a popout.** `DetachedApp` has no header, so there would be no
 * way to open it, and `useTodoStore` is per-window zustand: a second board would
 * hold its own stale filters and its own in-flight drag.
 */
export function TodoOverlayHost() {
  const t = useT();
  const enabled = useSettingsStore((s) => s.settings?.todo_board ?? false);
  const open = useTodoStore((s) => s.overlayOpen);

  const live = enabled && open;

  useEffect(() => {
    if (!live) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        useTodoStore.getState().closeOverlay();
      }
    };
    // Every text input inside the pane stops its own Escape — it has to, because
    // `stopPropagation` does not stop sibling listeners on `window`, so an
    // unguarded Escape while renaming a card would reach this and tear the board
    // down mid-edit. What arrives here is only an Escape nothing else claimed.
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [live]);

  if (!live) return null;

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        // Backdrop only: a card drag that starts on the board and ends out here
        // must not be read as "dismiss".
        if (e.target === e.currentTarget) useTodoStore.getState().closeOverlay();
      }}
    >
      <div
        className="project-dialog dialog-framed todo-overlay"
        role="dialog"
        aria-modal="true"
        aria-label={t("todo.overlayTitle")}
      >
        <div className="settings-title-row">
          <h2>
            {t("todo.overlayTitle")} <UntestedTag />
          </h2>
          <button
            type="button"
            className="dialog-close-btn"
            title={t("common.close")}
            aria-label={t("common.close")}
            onClick={() => useTodoStore.getState().closeOverlay()}
          >
            ×
          </button>
        </div>
        <div className="todo-overlay-body">
          <TodoPane />
        </div>
      </div>
    </div>
  );
}
