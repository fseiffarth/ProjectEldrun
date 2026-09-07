import { useCallback, useEffect, useRef } from "react";
import { useInstallOverlayStore } from "../../stores/installOverlay";
import { useProjectsStore } from "../../stores/projects";
import { useTabsStore } from "../../stores/tabs";
import { useT } from "../../lib/i18n";
import { UntestedTag } from "../common/UntestedTag";
import { TerminalView } from "../terminal/TerminalView";

/**
 * The install overlay — a centered terminal dialog over whatever is on screen,
 * mirroring the root-scope tab a one-click install (`runInstallInTab`) just
 * opened. The install used to run out of sight behind a scope switch, announced
 * only by a toast; here the user watches it and answers its prompts (a sudo
 * password, MiKTeX's installer) without leaving the project they clicked in.
 *
 * The `TerminalView` is **attach-only**: the PTY is owned by the root tab's own
 * pane (which spawned it and types the install command), this view merely
 * subscribes to the same stream. Closing the overlay therefore never touches
 * the install — it runs on in the root terminal, and the toast raised at close
 * says so. The visible-only output router handles the pair of views the same
 * way it handles a detached window's: each registers its own viewer, so the
 * overlay being visible streams output while the hidden root pane buffers
 * client-side, and after close the backend buffers for the root pane's next
 * show.
 *
 * Chrome is the app's canonical dialog scheme (`.project-dialog.dialog-framed`
 * + `.settings-title-row` + `.dialog-close-btn`), the `MailOverlay` shape.
 */
export function InstallOverlayHost() {
  const t = useT();
  const ptyId = useInstallOverlayStore((s) => s.ptyId);
  const label = useInstallOverlayStore((s) => s.label);
  // The root tab this overlay mirrors can be closed from the root scope's own
  // tab strip while the overlay is up; its PTY dies with it, so a dead
  // terminal must not stay floated over the app. Silent close, no toast —
  // "still running in the root terminal" would be exactly wrong.
  const tabAlive = useTabsStore(
    (s) => ptyId != null && (s.tabsByScope.root ?? []).some((tb) => `root:${tb.key}` === ptyId),
  );
  const bodyRef = useRef<HTMLDivElement>(null);

  const open = ptyId != null;

  // Closing is a hand-off, not an end: the toast points at where the install
  // keeps running (the same auto-clearing switchToast the old flow used). The
  // label is read at call time — a second install opened over the first
  // replaces the store's entry, and the toast must name what is actually there.
  const dismiss = useCallback(() => {
    const current = useInstallOverlayStore.getState().label;
    useInstallOverlayStore.getState().close();
    useProjectsStore.setState({
      switchToast: t("installOverlay.continuesToast", { label: current }),
    });
  }, [t]);

  useEffect(() => {
    if (open && !tabAlive) useInstallOverlayStore.getState().close();
  }, [open, tabAlive]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Escape typed INTO the terminal is input for the installer (a TUI's
      // cancel key, xterm forwards it to the PTY) — only a press from outside
      // the terminal reads as "dismiss".
      if (bodyRef.current && e.target instanceof Node && bodyRef.current.contains(e.target)) {
        return;
      }
      e.stopPropagation();
      dismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, dismiss]);

  if (!open || !tabAlive) return null;

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        // Backdrop only — a drag that starts inside the terminal (selecting
        // output) and ends out here must not be read as "dismiss".
        if (e.target === e.currentTarget) dismiss();
      }}
    >
      <div
        className="project-dialog dialog-framed install-overlay"
        role="dialog"
        aria-modal="true"
        aria-label={label}
      >
        <div className="settings-title-row">
          <h2>
            {label} <UntestedTag />
          </h2>
          <button
            type="button"
            className="dialog-close-btn"
            title={t("common.close")}
            aria-label={t("common.close")}
            onClick={dismiss}
          >
            ×
          </button>
        </div>
        <p className="install-overlay-hint">{t("installOverlay.hint")}</p>
        <div className="install-overlay-body" ref={bodyRef}>
          {/* Attach-only: never spawns, never re-types the command (the root
              pane's own TerminalView owns both), never reaps on unmount. */}
          <TerminalView id={ptyId} cmd="" cwd="" visible focused attachOnly />
        </div>
      </div>
    </div>
  );
}
