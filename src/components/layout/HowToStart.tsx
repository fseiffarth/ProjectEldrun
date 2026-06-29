import { useEffect } from "react";
import { HOW_TO_START_STEPS } from "../../lib/hints";

/**
 * The first-run "How to start" instruction: a single scannable modal shown once
 * on the first launch of an empty install, and re-openable from Settings / the
 * gear menu. Reuses the `.modal-backdrop` + `.settings-dialog` skeleton from
 * `SettingsDialog` (and, unlike it, brings its own Esc handler). Content comes
 * from `HOW_TO_START_STEPS` so it stays in lockstep with the Feature Guide.
 */
export function HowToStart({ onClose }: { onClose: () => void }) {
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
        aria-label="How to start"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="settings-title-row">
          <h2>Welcome to Eldrun</h2>
          <button type="button" className="dialog-close-btn" onClick={onClose}>×</button>
        </div>
        <p className="settings-help">
          Eldrun keeps your AI-assisted development in one window. Here's how to get going:
        </p>

        <ol className="how-to-start-steps">
          {HOW_TO_START_STEPS.map((step, i) => (
            <li key={step.title} className="how-to-start-step">
              <span className="how-to-start-num">{i + 1}</span>
              <div>
                <div className="how-to-start-step-title">{step.title}</div>
                <div className="settings-help">{step.body}</div>
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
            Open Feature Guide...
          </button>
          <button type="button" className="how-to-start-got-it" onClick={onClose}>
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
