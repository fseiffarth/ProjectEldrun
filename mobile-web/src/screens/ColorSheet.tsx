import { useState } from "react";
import { ApiError, setTabColor, type TabRow } from "../api";
import { TAB_COLORS, TAB_COLOR_IDS, TAB_COLOR_LABELS } from "../tabColors";

/** Paint one tab from the phone, or clear its colour (#264).
 *
 * `RenameSheet`'s sibling, and deliberately shaped like it: the tab is named by
 * its opaque id, the desktop owns the tab layout, and nothing here works
 * without desktop Eldrun open — which is why the failure says so rather than
 * "request failed".
 *
 * It commits on the tap instead of holding a Save button. A colour is a label
 * rather than a destructive act (the close beside it is the one that asks), and
 * the swatch it lands on is the confirmation; what a phone needs from this is
 * one tap, not three. The sheet stays open after a pick so a second hue is one
 * more tap, and the ring follows the colour the DESKTOP answered with rather
 * than the one tapped, so a refused write cannot leave the sheet lying. */
export function ColorSheet({ tab, onClose, onColored }: {
  tab: TabRow;
  onClose: () => void;
  onColored: (color: string | undefined) => void;
}) {
  const [current, setCurrent] = useState<string | undefined>(tab.color);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const pick = async (color: string | null) => {
    setBusy(true);
    setError("");
    try {
      const answer = await setTabColor(tab.id, color);
      // The desktop persists asynchronously, so the route may answer with the
      // stored id alone rather than a caught-up row; either is the authority.
      const stored = answer.tab ? answer.tab.color : (answer.color ?? undefined);
      setCurrent(stored ?? undefined);
      onColored(stored ?? undefined);
    } catch (cause) {
      setError(cause instanceof ApiError && (cause.status === 503 || cause.code === "desktop_unavailable")
        ? "Open desktop Eldrun to colour a tab."
        : "The colour could not be set.");
    } finally {
      setBusy(false);
    }
  };

  return <div className="sheet-backdrop" role="presentation" onClick={onClose}>
    <section className="option-sheet schedule-sheet" role="dialog" aria-modal="true" aria-label={`Colour ${tab.label}`} onClick={(event) => event.stopPropagation()}>
      <span className="sheet-grip" aria-hidden="true" />
      <header><button className="sheet-close" onClick={onClose} aria-label="Close">✕</button><h2>Tab colour <small>Untested</small></h2><span className="sheet-close" aria-hidden="true" /></header>
      <p className="sheet-note">The colour is the desktop's own tab colour — picking one here paints “{tab.label}” in the Eldrun window too.</p>
      {error && <p className="sheet-note error" role="alert">{error}</p>}
      <div className="tab-color-grid" role="group" aria-label="Tab colour">
        <button
          type="button"
          className={`tab-color-chip none${current ? "" : " is-current"}`}
          disabled={busy}
          aria-pressed={!current}
          onClick={() => void pick(null)}
        >
          <span className="tab-color-chip-dot none" aria-hidden="true" />
          None
        </button>
        {TAB_COLOR_IDS.map((id) => (
          <button
            key={id}
            type="button"
            className={`tab-color-chip${current === id ? " is-current" : ""}`}
            disabled={busy}
            aria-pressed={current === id}
            onClick={() => void pick(id)}
          >
            <span className="tab-color-chip-dot" style={{ background: TAB_COLORS[id] }} aria-hidden="true" />
            {TAB_COLOR_LABELS[id] ?? id}
          </button>
        ))}
      </div>
      <div className="mobile-schedule-form">
        <div className="mobile-schedule-actions">
          <button disabled={busy} onClick={onClose}>{busy ? "Saving…" : "Done"}</button>
        </div>
      </div>
    </section>
  </div>;
}
