import { useEffect } from "react";
import { useSkillsOverlayStore } from "../../stores/skills";
import { useT } from "../../lib/i18n";
import { UntestedTag } from "../common/UntestedTag";
import { SkillsLibraryView } from "./SkillsLibraryView";

/**
 * The 🧠 menu's Skills Library overlay — the **machine-level** door into the
 * same library the project tab hosts (`docs/skills_plan.md`).
 *
 * It exists because two thirds of this feature were never project-scoped: the
 * source list and every cached clone live in the state dir, shared by every
 * project, and until the personal install scope existed there was no way to
 * open any of it without a project — adding a source, a machine-wide act, meant
 * first having a project tab to do it from. The 🧠 menu is where the machine's
 * agents and models already live, so a skill — an agent capability, installed
 * per machine exactly like an agent CLI — belongs beside them.
 *
 * It renders the *same* `SkillsLibraryView` the tab renders, with `projectDir`
 * `null`, so the two surfaces are two views of one library and cannot drift;
 * all this host adds is a backdrop, a close affordance and a size. That is the
 * `MailOverlay` bargain, and this wears its chrome
 * (`.project-dialog.dialog-framed` + `.settings-title-row` + `.dialog-close-btn`)
 * for the same reason: a whole pane hosted in a dialog.
 *
 * Deliberately **not** a replacement for the tab. Mail's tab was retired
 * because its store was global and a scoped tab could only show the same
 * mailbox; here the scope is real — the tab is the one surface that knows which
 * project you mean, and it is the only place a project-scoped install can be
 * asked for.
 */
export function SkillsOverlayHost() {
  const t = useT();
  const open = useSkillsOverlayStore((s) => s.open);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        useSkillsOverlayStore.getState().close();
      }
    };
    // Escape closes the overlay from anywhere inside it, the view's text fields
    // included — nothing here is a draft that a close would lose (a half-typed
    // source URL is retyped in seconds, and an install is a click, not a form).
    // If a field ever gains state worth protecting, it stops its own Escape;
    // this listener only ever sees an unhandled one.
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        // Backdrop only — a drag that starts inside the pane and ends out here
        // (selecting text in a preview) must not be read as "dismiss".
        if (e.target === e.currentTarget) useSkillsOverlayStore.getState().close();
      }}
    >
      <div
        className="project-dialog dialog-framed skills-overlay"
        role="dialog"
        aria-modal="true"
        aria-label={t("skillsLibrary.overlayTitle")}
      >
        <div className="settings-title-row">
          <h2>
            {t("skillsLibrary.overlayTitle")} <UntestedTag />
          </h2>
          <button
            type="button"
            className="dialog-close-btn"
            title={t("common.close")}
            aria-label={t("common.close")}
            onClick={() => useSkillsOverlayStore.getState().close()}
          >
            ×
          </button>
        </div>
        <div className="skills-overlay-body">
          {/* No project: this surface belongs to the machine, so the personal
              scope is the only one it can honestly offer. A project install is
              the project tab's, where there is a project to name. */}
          <SkillsLibraryView projectDir={null} />
        </div>
      </div>
    </div>
  );
}
