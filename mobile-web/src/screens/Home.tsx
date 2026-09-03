import { useEffect, useState } from "react";
import { api, type ActivityTab, type MobileAlertItem, type MobileAlerts, type ProjectRow } from "../api";
import { classifyUnavailable, describeUnavailable, type UnavailableReason } from "../connection";
import { readFlag, writeFlag } from "../prefs";
import { Activity } from "./Activity";
// Kept in lockstep with the desktop and mobile-host package versions by the
// release bump, so the phone always reports the build it is running.
import { version as APP_VERSION } from "../../../package.json";

const ALERT_ICON: Record<MobileAlertItem["kind"], string> = {
  mail: "✉",
  event: "🗓",
  task: "☑",
};

function relativeAlertTime(item: MobileAlertItem): string {
  if (item.minutes_away === undefined) return "No date";
  if (item.all_day) {
    const days = item.days_away ?? 0;
    if (days === 0) return "Today";
    return days < 0 ? `${Math.abs(days)}d overdue` : `In ${days}d`;
  }
  const minutes = item.minutes_away;
  if (minutes === 0) return "Now";
  const abs = Math.abs(minutes);
  const amount = abs >= 1440
    ? `${Math.floor(abs / 1440)}d`
    : abs >= 60
      ? `${Math.floor(abs / 60)}h`
      : `${abs}m`;
  return minutes < 0 ? `${amount} overdue` : `In ${amount}`;
}

function AlertRows({ alerts, todo, mail }: { alerts: MobileAlerts; todo: (card?: string) => void; mail: () => void }) {
  if (!alerts.enabled) return null;
  return <section className="mobile-alerts" aria-labelledby="mobile-alerts-heading">
    <h2 id="mobile-alerts-heading">Alerts</h2>
    {alerts.items.length === 0
      ? <p className="mobile-alerts-empty">Nothing needs attention.</p>
      : <div className="mobile-alert-list">{alerts.items.map((item, index) => {
        // A card row opens *its own* card: the alert has already named the one
        // thing that needs attention, and a board of forty is where finding it
        // again costs the search the row exists to save. A row the desktop
        // could not resolve to a card still opens the board.
        const open = item.kind === "mail"
          ? mail
          : item.kind === "task"
            ? () => todo(item.task_id)
            : undefined;
        const contents = <>
          <span className={`mobile-alert-dot ${item.severity}`} aria-hidden="true" />
          <span className="mobile-alert-icon" aria-hidden="true">{ALERT_ICON[item.kind]}</span>
          <span className="mobile-alert-copy"><strong>{item.title}</strong>{item.detail && <small>{item.detail}</small>}</span>
          <time>{relativeAlertTime(item)}</time>
        </>;
        return open
          ? <button className="mobile-alert-row" key={`${item.kind}-${item.at ?? ""}-${item.title}-${index}`} onClick={open}>{contents}</button>
          : <div className="mobile-alert-row" key={`${item.kind}-${item.at ?? ""}-${item.title}-${index}`}>{contents}</div>;
      })}</div>}
  </section>;
}

/** The three modes of the Projects section. `agents` is not a filter over the
 * project list but a different list entirely — every project's agent tabs that
 * are working, waiting or done, flat — so it is the one mode worth remembering
 * across the re-mounts a tab switch and a terminal visit cause. */
type HomeView = "active" | "agents" | "search";
const HOME_VIEWS: [HomeView, string][] = [["active", "Active"], ["agents", "Agents"], ["search", "Search"]];

export function Home({ open, openTab, todo, mail }: {
  open: (id: string) => void;
  openTab: (projectId: string, tab: ActivityTab) => void;
  todo: (card?: string) => void;
  mail: () => void;
}) {
  const [view, setView] = useState<HomeView>(() => (readFlag("projectsAgents") ? "agents" : "active"));
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<ProjectRow[]>([]);
  /** Whether any list has come back yet. Until it has, an empty `rows` is
   * "still loading", not "nothing here" — and a first open with no active
   * project drew nothing at all under the heading, which read as broken. */
  const [loaded, setLoaded] = useState(false);
  /** Null while the list is loading fine; otherwise why it is not. */
  const [offline, setOffline] = useState<UnavailableReason | null>(null);
  const [alerts, setAlerts] = useState<MobileAlerts | null>(null);
  /** Only the agents mode is remembered: the other two differ by a query the
   * reader has to type anyway, and a Projects tab that opened on an empty
   * search box would be a worse landing than the active list. */
  const choose = (next: HomeView) => {
    setView(next);
    writeFlag("projectsAgents", next === "agents");
  };
  useEffect(() => {
    // The agents mode reads its own list; leaving this poll running behind it
    // would be a catalog load per tick for a list nothing is showing.
    if (view === "agents") return;
    // Without an abort, typing "ab" then "abc" on mobile data could land the
    // older response last and leave the wrong result set on screen.
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const suffix = view === "search" ? `?view=search&q=${encodeURIComponent(query)}` : "?view=active";
      void api<{ projects: ProjectRow[] }>(`/api/v1/projects${suffix}`, { signal: controller.signal })
        .then((body) => { setRows(body.projects); setOffline(null); setLoaded(true); })
        .catch((error: unknown) => { if (!controller.signal.aborted) setOffline(classifyUnavailable(error)); });
    }, view === "search" ? 180 : 0);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [view, query]);
  useEffect(() => {
    // Alerts sit under the project list and are deliberately not part of the
    // agents mode, which shows agent tabs and nothing else; polling a feed
    // that mode does not draw would be a minute-timer for nobody.
    if (view === "agents") return;
    let disposed = false;
    const load = () => {
      void api<{ alerts: MobileAlerts }>("/api/v1/alerts")
        .then((body) => { if (!disposed) setAlerts(body.alerts); })
        .catch(() => { if (!disposed) setAlerts(null); });
    };
    load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, 60_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [view]);
  return <main className="screen">
    <header className="home-header">
      <div className="home-brand" aria-label="Eldrun">
        <img className="home-logo" src="/icons/icon.svg" alt="" />
        <strong>Eldrun</strong>
      </div>
      {/* The global views used to live here as a header rail; they are tabs of
          their own now, so the bar at the bottom of every screen carries them. */}
      <div className="mobile-build"><small>Eldrun Mobile v{APP_VERSION}</small><span className={offline ? "lamp off" : "lamp"} /></div>
    </header>
    <div className="projects-row">
      <h1>{view === "agents" ? "Agents" : "Projects"}</h1>
    </div>
    <nav>{HOME_VIEWS.map(([id, label]) => <button
      key={id}
      className={view === id ? "selected" : ""}
      aria-pressed={view === id}
      onClick={() => choose(id)}
    >{label}</button>)}</nav>
    {view === "agents" && <Activity open={openTab} onConnection={setOffline} />}
    {view !== "agents" && <>
      {view === "search" && <input className="search" placeholder="Project name" value={query} autoFocus onChange={(event) => setQuery(event.target.value)} />}
      {offline && <p className="error connection-error">
        <strong>{describeUnavailable(offline).title}</strong>
        <span>{describeUnavailable(offline).hint}</span>
        <span>{rows.length ? "Showing the last list this session loaded." : "Project data is never loaded from cache."}</span>
      </p>}
      {!loaded && !offline && <p className="projects-empty" role="status">Loading projects…</p>}
      {loaded && rows.length === 0 && <p className="projects-empty">{view === "search"
        ? query.trim() ? "No project by that name has Eldrun Mobile access." : "Type a project's name to find it."
        : "No project is active right now. Search finds any project with Eldrun Mobile access."}</p>}
      <section className="cards">{rows.map((project) => <button className="card" key={project.id} onClick={() => open(project.id)}><span><strong>{project.label}</strong><small>{project.status}</small></span><span className="count">{project.live_sessions}</span></button>)}</section>
      {alerts && <AlertRows alerts={alerts} todo={todo} mail={mail} />}
    </>}
  </main>;
}
