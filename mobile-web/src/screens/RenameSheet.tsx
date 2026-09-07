import { useState } from "react";
import { ApiError, MAX_TAB_LABEL, renameTab, type TabRow } from "../api";

/** Rename one agent tab from the phone. The label is the only thing that
 * crosses: the tab is named by its opaque id, and the desktop resolves that
 * back onto the tab layout it owns. Nothing here works without desktop Eldrun
 * open, which is why the failure says so rather than "request failed". */
export function RenameSheet({ tab, onClose, onRenamed }: {
  tab: TabRow;
  onClose: () => void;
  onRenamed: (label: string) => void;
}) {
  const [label, setLabel] = useState(tab.label);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const trimmed = label.trim();
  const tooLong = [...trimmed].length > MAX_TAB_LABEL;

  const save = async () => {
    if (!trimmed || tooLong) {
      setError(tooLong ? `Keep the name to ${MAX_TAB_LABEL} characters or fewer.` : "Enter a name.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const answer = await renameTab(tab.id, trimmed);
      onRenamed(answer.tab?.label ?? answer.label ?? trimmed);
    } catch (cause) {
      setError(cause instanceof ApiError && (cause.status === 503 || cause.code === "desktop_unavailable")
        ? "Open desktop Eldrun to rename a tab."
        : "The tab could not be renamed.");
    } finally {
      setBusy(false);
    }
  };

  return <div className="sheet-backdrop" role="presentation" onClick={onClose}>
    <section className="option-sheet schedule-sheet" role="dialog" aria-modal="true" aria-label={`Rename ${tab.label}`} onClick={(event) => event.stopPropagation()}>
      <span className="sheet-grip" aria-hidden="true" />
      <header><button className="sheet-close" onClick={onClose} aria-label="Close">✕</button><h2>Rename tab <small>Untested</small></h2><span className="sheet-close" aria-hidden="true" /></header>
      <p className="sheet-note">The name is the desktop's own tab label — renaming here renames it in the Eldrun window too.</p>
      {error && <p className="sheet-note error" role="alert">{error}</p>}
      <div className="mobile-schedule-form">
        <label>Tab name<input
          type="text"
          value={label}
          autoFocus
          maxLength={MAX_TAB_LABEL}
          disabled={busy}
          onChange={(event) => setLabel(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void save(); } }}
        /></label>
        <div className="mobile-schedule-actions">
          <button disabled={busy} onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy || !trimmed} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</button>
        </div>
      </div>
    </section>
  </div>;
}
