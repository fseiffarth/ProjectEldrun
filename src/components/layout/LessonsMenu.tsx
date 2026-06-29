import { useEffect } from "react";
import { LESSONS } from "../../lib/lessons";
import { useTourStore } from "../../stores/tour";

/**
 * The lesson picker: a small modal listing the task "lessons" (add a project,
 * install an agent, use a local model, …). Picking one closes the dialog and
 * starts that lesson through the shared tour engine
 * (`useTourStore.startLesson`). Re-openable any time from the gear menu /
 * Settings; reuses the `.modal-backdrop` + `.settings-dialog` skeleton (and,
 * like `HowToStart`, brings its own Esc handler).
 */
export function LessonsMenu({ onClose }: { onClose: () => void }) {
  const startLesson = useTourStore((s) => s.startLesson);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop how-to-start-backdrop" onMouseDown={onClose}>
      <div
        className="settings-dialog how-to-start-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Lessons"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="settings-title-row">
          <h2>Lessons</h2>
          <button type="button" className="dialog-close-btn" onClick={onClose}>×</button>
        </div>
        <p className="settings-help">
          Short guided walkthroughs for common tasks. Pick one — it'll point things out step by step.
        </p>

        <div className="lessons-list">
          {LESSONS.map((lesson) => (
            <button
              key={lesson.id}
              type="button"
              className="lesson-item"
              onClick={() => {
                onClose();
                startLesson(lesson.steps);
              }}
            >
              <span className="lesson-item-title">{lesson.title}</span>
              <span className="lesson-item-blurb">{lesson.blurb}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
