import { useEffect, useRef, useState } from "react";
import { useSettingsStore } from "../../stores/settings";
import { useT } from "../../lib/i18n";
import { UntestedTag } from "../common/UntestedTag";
import {
  FIXED_KEYS,
  SHORTCUT_DEFS,
  SHORTCUT_GROUPS,
  STEERING_KEYS,
  chordLabel,
  resolveChord,
  type ShortcutMap,
} from "../../lib/shortcuts";

/**
 * The keyboard-shortcut cheat sheet (part 2 of the keyboard-only steering
 * system) — opened by the `shortcutHelp` chord (F1 by default), by `?` inside
 * steering mode, and from the header ⚙ menu; all three doors dispatch the one
 * `eldrun:open-shortcut-help` window event this host listens for.
 *
 * Every key it shows renders from `lib/shortcuts` — `SHORTCUT_DEFS` through
 * `resolveChord`, so a user rebind shows its *effective* chord (marked
 * "customized"), plus the fixed `STEERING_KEYS`/`FIXED_KEYS` tables — never a
 * hardcoded chord string, so the sheet cannot drift from what `useKeyboard`
 * acts on. Mounted once in `AppShell` on the shared `.modal-backdrop` like the
 * overlay family there.
 */
export function ShortcutHelpOverlay() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const overrides = useSettingsStore(
    (s) => s.settings?.keyboard_shortcuts,
  ) as ShortcutMap | undefined;

  useEffect(() => {
    const openIt = () => setOpen(true);
    window.addEventListener("eldrun:open-shortcut-help", openIt);
    return () => window.removeEventListener("eldrun:open-shortcut-help", openIt);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    // Focus the scroll body so the sheet is keyboard-walkable from the F1/?
    // press that opened it — arrows and PageUp/Down scroll with no pointer.
    scrollRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) return null;

  const close = () => setOpen(false);

  return (
    /* The canonical framed-dialog chrome, applied as the calendar/mail overlays
       apply it (accent header band + divider, `.dialog-close-btn`); the
       `.dialog-scroll` child does the scrolling inside the frame's curve. */
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        className="project-dialog dialog-framed shortcut-help-overlay"
        role="dialog"
        aria-modal="true"
        aria-label={t("shortcutHelp.title")}
      >
        <div className="settings-title-row">
          <h2>
            {t("shortcutHelp.title")} <UntestedTag />
          </h2>
          <button
            type="button"
            className="dialog-close-btn"
            title={t("common.close")}
            aria-label={t("common.close")}
            onClick={close}
          >
            ×
          </button>
        </div>
        <div className="dialog-scroll" ref={scrollRef} tabIndex={-1}>
          {SHORTCUT_GROUPS.map((g) => (
            <section className="shortcut-help-section" key={g.id}>
              <h3>{t(g.labelKey)}</h3>
              {SHORTCUT_DEFS.filter((d) => d.group === g.id).map((d) => (
                <div className="shortcut-help-row" key={d.action}>
                  <kbd>{chordLabel(resolveChord(d.action, overrides))}</kbd>
                  <span className="shortcut-help-label">
                    {d.label}
                    {overrides?.[d.action] && (
                      <span className="shortcut-help-custom">
                        {" "}
                        ({t("shortcutHelp.customized")})
                      </span>
                    )}
                  </span>
                </div>
              ))}
            </section>
          ))}
          <section className="shortcut-help-section">
            <h3>{t("shortcutHelp.steeringTitle")}</h3>
            <p className="shortcut-help-intro">
              {t("shortcutHelp.steeringIntro", {
                chord: chordLabel(resolveChord("steeringMode", overrides)),
              })}
            </p>
            {STEERING_KEYS.map((k) => (
              <div className="shortcut-help-row" key={k.labelKey}>
                <kbd>{k.keys}</kbd>
                <span className="shortcut-help-label">
                  {t(k.labelKey)}
                  <span className="shortcut-help-desc"> — {t(k.descKey)}</span>
                </span>
              </div>
            ))}
          </section>
          <section className="shortcut-help-section">
            <h3>{t("shortcutHelp.fixedTitle")}</h3>
            {FIXED_KEYS.map((k) => (
              <div className="shortcut-help-row" key={k.labelKey}>
                <kbd>{k.keys}</kbd>
                <span className="shortcut-help-label">
                  {t(k.labelKey)}
                  <span className="shortcut-help-desc"> — {t(k.descKey)}</span>
                </span>
              </div>
            ))}
          </section>
          <p className="shortcut-help-footer">
            {t("shortcutHelp.footer", { panel: t("nav.shortcuts.title") })}
          </p>
        </div>
      </div>
    </div>
  );
}
