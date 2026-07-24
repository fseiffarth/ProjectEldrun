import { Fragment, useEffect } from "react";
import { LESSONS } from "../../lib/lessons";
import { useTourStore } from "../../stores/tour";
import { useT } from "../../lib/i18n";

/**
 * The lesson picker: a small modal listing the task "lessons" (add a project,
 * install an agent, use a local model, …). Picking one closes the dialog and
 * starts that lesson through the shared tour engine
 * (`useTourStore.startLesson`). Re-openable any time from the gear menu /
 * Settings; reuses the `.modal-backdrop` + `.settings-dialog` skeleton (and,
 * like `HowToStart`, brings its own Esc handler).
 */
export function LessonsMenu({ onClose }: { onClose: () => void }) {
  const t = useT();
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
        aria-label={t("lessons.title")}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="settings-title-row">
          <h2>{t("lessons.title")}</h2>
          <button type="button" className="dialog-close-btn" onClick={onClose}>×</button>
        </div>
        <p className="settings-help">{t("lessons.intro")}</p>

        <div className="lessons-list">
          {LESSONS.map((lesson, i) => {
            // LESSONS is sorted by category (easy → hard), so a header is shown
            // whenever the tier changes from the previous lesson.
            const newSection = i === 0 || LESSONS[i - 1].category !== lesson.category;
            return (
              <Fragment key={lesson.id}>
                {newSection && (
                  <h3 className="lessons-section-title">{lesson.category}</h3>
                )}
                <button
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
              </Fragment>
            );
          })}
        </div>
      </div>
    </div>
  );
}
