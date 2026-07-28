import { useEffect } from "react";
import { useMailStore } from "../../stores/mail";
import { useExperimental } from "../../lib/experimental";
import { useT } from "../../lib/i18n";
import { UntestedTag } from "../common/UntestedTag";
import { MailPane } from "./MailPane";

/**
 * The header mail button's overlay — **the** mail surface, floated over the
 * window instead of tiled into a scope.
 *
 * There was a mail *tab* as well, and it was redundant from the start: the store
 * is global (one mailbox across every scope), so the tab showed the same mailbox
 * wherever it was opened while still belonging to a project you then switched
 * away from. It is retired; this host is now `MailPane`'s only caller, and all it
 * adds is a backdrop, a close affordance and a size.
 *
 * One gate, not two. `mail_global_app` used to sit under `mail_client` to decide
 * whether the header button appeared *as well as* the tab; with the tab gone that
 * second switch could only ever mean "keep mail on, and make it unreachable", so
 * `mail_client` — the experimental flag that owns the whole feature — is the only
 * thing asked. Switching it off takes the overlay away rather than leaving it on
 * screen over a feature the settings say is gone, the same rule
 * `experimentalSweep` applies to a withdrawn tab.
 */
export function MailOverlayHost() {
  const t = useT();
  const mailClient = useExperimental("mail_client");
  const open = useMailStore((s) => s.overlayOpen);

  const live = mailClient && open;

  useEffect(() => {
    if (!live) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        useMailStore.getState().closeOverlay();
      }
    };
    // Capture: the pane hosts dialogs and a search field, and Escape reaching a
    // window-level listener first would close the overlay out from under them.
    // They stop propagation themselves, so this only ever sees an unhandled one.
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [live]);

  if (!live) return null;

  return (
    /* `.project-dialog.dialog-framed` + `.settings-title-row` + `.dialog-close-btn`
       — the app's canonical dialog chrome (accent top rail, accent-washed title
       band, shared close button), applied exactly as GlobalMachineMonitorDialog
       applies it to the system-monitor pane. This overlay is the same shape of
       thing: a whole pane hosted in a dialog, sized by its own rule and clipped
       by a body that never scrolls (the pane manages its own scrolling). */
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        // Backdrop only — a drag that starts inside the pane and ends out here
        // (selecting text, dragging the list) must not be read as "dismiss".
        if (e.target === e.currentTarget) useMailStore.getState().closeOverlay();
      }}
    >
      <div
        className="project-dialog dialog-framed mail-overlay"
        role="dialog"
        aria-modal="true"
        aria-label={t("mail.overlayTitle")}
      >
        <div className="settings-title-row">
          <h2>
            {t("mail.overlayTitle")} <UntestedTag />
          </h2>
          <button
            type="button"
            className="dialog-close-btn"
            title={t("common.close")}
            aria-label={t("common.close")}
            onClick={() => useMailStore.getState().closeOverlay()}
          >
            ×
          </button>
        </div>
        <div className="mail-overlay-body">
          <MailPane />
        </div>
      </div>
    </div>
  );
}
