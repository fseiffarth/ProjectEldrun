import { useEffect } from "react";
import { HOW_TO_START_STEPS, focusModeTip } from "../../lib/hints";
import { useT } from "../../lib/i18n";

/**
 * The first-run "How to start" instruction: a single scannable modal shown once
 * on the first launch of an empty install, and re-openable from Settings / the
 * gear menu. Reuses the `.modal-backdrop` + `.settings-dialog` split-scroll frame from
 * `SettingsDialog` (and, unlike it, brings its own Esc handler). Content comes
 * from `HOW_TO_START_STEPS` so it stays in lockstep with the Feature Guide.
 */
export function HowToStart({ onClose }: { onClose: () => void }) {
  const t = useT();
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
        aria-label={t("howToStart.title")}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="settings-title-row">
          <h2>{t("howToStart.title")}</h2>
          <button type="button" className="dialog-close-btn" onClick={onClose}>×</button>
        </div>
        {/* Same split-scroll frame as LessonsMenu: `.settings-dialog` clips
            (overflow:hidden, padding 0, gap 0) and this `.dialog-scroll` child
            does the scrolling — without it the steps sit flush to the edges and
            the button row below them is cut off on a short window. */}
        <div className="dialog-scroll">
        <p className="settings-help">{t("howToStart.intro")}</p>

        <ol className="how-to-start-steps">
          {HOW_TO_START_STEPS.map((step, i) => (
            <li key={step.titleKey} className="how-to-start-step">
              <span className="how-to-start-num">{i + 1}</span>
              <div>
                <div className="how-to-start-step-title">{t(step.titleKey)}</div>
                {/* Only step4's key has a {tip} placeholder; t() ignores unused params. */}
                <div className="settings-help">{t(step.bodyKey, { tip: focusModeTip(t) })}</div>
              </div>
            </li>
          ))}
        </ol>

        <div className="settings-link-row">
          <button
            type="button"
            onClick={() => {
              window.dispatchEvent(new CustomEvent("eldrun:open-settings", { detail: "help" }));
              onClose();
            }}
          >
            {t("howToStart.openFeatureGuide")}
          </button>
          <button
            type="button"
            onClick={() => {
              onClose();
              window.dispatchEvent(new Event("eldrun:start-tour"));
            }}
          >
            {t("howToStart.takeTour")}
          </button>
          <button
            type="button"
            onClick={() => {
              onClose();
              window.dispatchEvent(new Event("eldrun:open-lessons"));
            }}
          >
            {t("howToStart.lessons")}
          </button>
          <button type="button" className="how-to-start-got-it" onClick={onClose}>
            {t("howToStart.gotIt")}
          </button>
        </div>
        </div>
      </div>
    </div>
  );
}
