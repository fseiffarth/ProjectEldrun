import { useState } from "react";
import { ApiError, closeTab, type TabRow } from "../api";

/** Close one tab from the phone — agent or shell. `RenameSheet`'s sibling: the
 * tab is named by its opaque id, the desktop owns the tab layout, and nothing
 * here works without desktop Eldrun open, which is why the failure says so
 * rather than "request failed".
 *
 * It asks rather than closing on the tap, because the row it sits under is one
 * thumb-width from the button that opens the terminal. What it asks is worth
 * spelling out: closing is the desktop's own ×, so the tab leaves the Eldrun
 * window while the session behind it keeps running — an agent mid-task is not
 * interrupted, and the desktop's Sessions view is where it is picked up again.
 * A phone must not be able to end a running agent by accident, and this sheet
 * is the reason it cannot. */
export function CloseSheet({ tab, onClose, onClosed }: {
  tab: TabRow;
  onClose: () => void;
  onClosed: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const confirm = async () => {
    setBusy(true);
    setError("");
    try {
      await closeTab(tab.id);
      onClosed();
    } catch (cause) {
      setError(cause instanceof ApiError && (cause.status === 503 || cause.code === "desktop_unavailable")
        ? "Open desktop Eldrun to close a tab."
        : "The tab could not be closed.");
      setBusy(false);
    }
  };

  return <div className="sheet-backdrop" role="presentation" onClick={onClose}>
    <section className="option-sheet schedule-sheet" role="dialog" aria-modal="true" aria-label={`Close ${tab.label}`} onClick={(event) => event.stopPropagation()}>
      <span className="sheet-grip" aria-hidden="true" />
      <header><button className="sheet-close" onClick={onClose} aria-label="Close">✕</button><h2>Close tab <small>Untested</small></h2><span className="sheet-close" aria-hidden="true" /></header>
      <p className="sheet-note">“{tab.label}” leaves the Eldrun window on the desktop. The session behind it keeps running and can be picked up again from the desktop's Sessions view — nothing running in it is stopped.</p>
      {error && <p className="sheet-note error" role="alert">{error}</p>}
      <div className="mobile-schedule-form">
        <div className="mobile-schedule-actions">
          <button disabled={busy} onClick={onClose}>Cancel</button>
          <button className="danger" disabled={busy} onClick={() => void confirm()}>{busy ? "Closing…" : "Close tab"}</button>
        </div>
      </div>
    </section>
  </div>;
}
