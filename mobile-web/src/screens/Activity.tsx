import { useEffect, useState } from "react";
import { getActivity, type ActivityTab } from "../api";
import { classifyUnavailable, describeUnavailable, type UnavailableReason } from "../connection";

/**
 * Every agent tab that is working, waiting on a decision, or done — across
 * every project at once, in one flat list.
 *
 * The project overview answers "what is this project doing"; this answers the
 * question a phone is actually picked up to ask, which is "is anything waiting
 * for me". Grouping by project is what stood in the way of that: it made the
 * reader open each project in turn to find the one session that had stopped to
 * ask something. Nothing quiet is listed, so an empty list means an empty list.
 *
 * The desktop owns the classification — the sidecar never reads terminal
 * output — so with no desktop window open there is nothing to show, and the
 * screen says that rather than showing every tab as idle.
 */

/** One desktop round trip per poll, at the same cadence as the project
 * overview's, and stopped while the phone is showing something else. */
const POLL_MS = 5_000;

/** Ordered by the sidecar (waiting first, finished last); the phone only
 * renders. Each pill is the same one the project overview puts on a tab. */
export function Activity({ open, onConnection }: {
  open: (projectId: string, tab: ActivityTab) => void;
  /** The header's one lamp belongs to whichever list is live, and in this mode
   * that is this one — the project list behind it is not being polled at all. */
  onConnection: (reason: UnavailableReason | null) => void;
}) {
  const [tabs, setTabs] = useState<ActivityTab[]>([]);
  /** Until the first answer, an empty list is "still loading", not "nothing". */
  const [loaded, setLoaded] = useState(false);
  const [desktop, setDesktop] = useState(true);
  const [offline, setOffline] = useState<UnavailableReason | null>(null);
  useEffect(() => {
    let disposed = false;
    const controller = new AbortController();
    const load = () => {
      if (document.visibilityState !== "visible") return;
      void getActivity(controller.signal)
        .then((body) => {
          if (disposed) return;
          setTabs(body.tabs);
          setDesktop(body.desktop_available);
          setOffline(null);
          onConnection(null);
          setLoaded(true);
        })
        // Keep the last good list rather than blanking it: one dropped packet on
        // a flaky link should not wipe the screen the reader is looking at.
        .catch((error: unknown) => {
          if (disposed || controller.signal.aborted) return;
          const reason = classifyUnavailable(error);
          setOffline(reason);
          onConnection(reason);
        });
    };
    load();
    const timer = window.setInterval(load, POLL_MS);
    document.addEventListener("visibilitychange", load);
    return () => {
      disposed = true;
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, [onConnection]);
  return <>
    {offline && <p className="error connection-error">
      <strong>{describeUnavailable(offline).title}</strong>
      <span>{describeUnavailable(offline).hint}</span>
      <span>{tabs.length ? "Showing the last list this session loaded." : "Agent activity is never loaded from cache."}</span>
    </p>}
    {!loaded && !offline && <p className="projects-empty" role="status">Loading agent tabs…</p>}
    {loaded && !desktop && <p className="notice">Desktop unavailable — Eldrun on the desktop is what tells a working session from one waiting on you.</p>}
    {loaded && desktop && tabs.length === 0 && <p className="projects-empty">Nothing is working, waiting or done. Quiet tabs are not listed here — open a project to reach one.</p>}
    <section className="cards">{tabs.map((tab) => <button
      className="card"
      key={tab.id}
      disabled={!tab.available}
      onClick={() => open(tab.project_id, tab)}
    >
      <span><strong>{tab.label}</strong><small>{tab.project_label}{tab.viewer_busy ? " · open elsewhere" : tab.available ? "" : " · gone"}</small></span>
      <span className="card-trailing">{tab.agent_status && <small className={`agent-status ${tab.agent_status}`}>{tab.agent_status}</small>}<span>›</span></span>
    </button>)}</section>
  </>;
}
