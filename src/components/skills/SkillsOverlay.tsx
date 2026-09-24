import { useEffect } from "react";
import { useSkillsOverlayStore } from "../../stores/skills";
import { useT } from "../../lib/i18n";
import { UntestedTag } from "../common/UntestedTag";
import { useFloatingFrame } from "../common/useFloatingFrame";
import { SkillsGlyph } from "../header/HeaderGlyphs";
import { SkillsLibraryView } from "./SkillsLibraryView";

/**
 * The Models & agents menu's Skills Library overlay — the **machine-level** door
 * into the same library the project tab hosts (`docs/skills_plan.md`).
 *
 * It exists because two thirds of this feature were never project-scoped: the
 * source list and every cached clone live in the state dir, shared by every
 * project, and until the personal install scope existed there was no way to
 * open any of it without a project — adding a source, a machine-wide act, meant
 * first having a project tab to do it from. The Models & agents menu is where
 * the machine's agents and models already live, so a skill — an agent
 * capability, installed per machine exactly like an agent CLI — belongs beside
 * them.
 *
 * It renders the *same* `SkillsLibraryView` the tab renders, with `projectDir`
 * `null`, so the two surfaces are two views of one library and cannot drift;
 * all this host adds is a window around it. That window is the header overlays'
 * one chrome — the root console's floating subwindow (`.root-overlay.subwindow`)
 * that `MailOverlay` wears, moved, resized and filled by `useFloatingFrame`,
 * whose title bar is mark, tab strip and controls. The strip holds a single
 * fixed tab: the view is one pane (sources, installs, catalog and preview side
 * by side), with no top-level split a second tab could honestly name, so the
 * tab is there for the bar's anatomy — the same always-present first tab as
 * mail's Inbox — and names the one scope this surface can install into.
 *
 * Deliberately **not** a replacement for the tab. Mail's tab was retired
 * because its store was global and a scoped tab could only show the same
 * mailbox; here the scope is real — the tab is the one surface that knows which
 * project you mean, and it is the only place a project-scoped install can be
 * asked for.
 */
export function SkillsOverlayHost() {
  const open = useSkillsOverlayStore((s) => s.open);
  if (!open) return null;
  return <SkillsOverlay />;
}

function SkillsOverlay() {
  const t = useT();
  // Moves, resizes and fills like the root console; remembered per overlay.
  const { frameRef, frameStyle, frameClass, barProps, grips, fillButton } =
    useFloatingFrame("eldrun.skillsOverlayFrame");
  // `barProps.title` is the move hint; on the whole bar it would hover over the
  // tab too, so it goes on the mark alone (the root console's placement).
  const { title: moveHint, ...barRest } = barProps;
  const close = () => useSkillsOverlayStore.getState().close();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // An Escape something inside already took is not ours.
      if (e.key === "Escape" && !e.defaultPrevented) {
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
  }, []);

  return (
    <div
      className="modal-backdrop root-overlay-backdrop app-overlay-backdrop skills-overlay-backdrop"
      onMouseDown={(e) => {
        // Backdrop only — a drag that starts inside the pane and ends out here
        // (selecting text in a preview) must not be read as "dismiss".
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={frameRef}
        className={`root-overlay subwindow focused skills-overlay ${frameClass}`}
        style={frameStyle}
        role="dialog"
        aria-modal="true"
        aria-label={t("skillsLibrary.overlayTitle")}
      >
        {grips}
        {/* The root console's bar: mark, tab strip, controls. The bar is the
            move handle; the tab and buttons keep their own press. */}
        <div {...barRest} className={`tab-bar root-overlay-bar ${barRest.className}`}>
          <div className="root-overlay-mark app-overlay-mark skills-overlay-mark" title={moveHint}>
            <SkillsGlyph className="skills-overlay-glyph" />
            <span className="app-overlay-label skills-overlay-label">{t("skillsLibrary.overlayTitle")}</span>
            <UntestedTag id="skillsLibrary.overlayTitle" />
          </div>
          <div className="tab-strip skills-tab-strip" role="tablist">
            {/* The one pane, always shown and never closed — mail's Inbox tab. */}
            <div role="tab" tabIndex={0} aria-selected="true" className="tab skills-tab active">
              <span className="tab-label">{t("skillsLibrary.overlayTab")}</span>
            </div>
          </div>
          <div className="tab-controls root-overlay-controls">
            {fillButton}
            <button
              type="button"
              className="subwindow-hide"
              title={t("common.close")}
              aria-label={t("common.close")}
              onClick={close}
            >
              ×
            </button>
          </div>
        </div>
        <div className="subwindow-body skills-overlay-body" role="tabpanel">
          {/* No project: this surface belongs to the machine, so the personal
              scope is the only one it can honestly offer. A project install is
              the project tab's, where there is a project to name. */}
          <SkillsLibraryView projectDir={null} />
        </div>
      </div>
    </div>
  );
}
