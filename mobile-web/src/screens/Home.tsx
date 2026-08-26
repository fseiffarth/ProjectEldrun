import { useEffect, useState } from "react";
import { api, type MobileAlertItem, type MobileAlerts, type ProjectRow } from "../api";
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

function AlertRows({ alerts, todo, mail }: { alerts: MobileAlerts; todo: () => void; mail: () => void }) {
  if (!alerts.enabled) return null;
  return <section className="mobile-alerts" aria-labelledby="mobile-alerts-heading">
    <h2 id="mobile-alerts-heading">Alerts</h2>
    {alerts.items.length === 0
      ? <p className="mobile-alerts-empty">Nothing needs attention.</p>
      : <div className="mobile-alert-list">{alerts.items.map((item, index) => {
        const open = item.kind === "mail" ? mail : item.kind === "task" ? todo : undefined;
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

export function Home({ open, todo, mail, calendar }: { open: (id: string) => void; todo: () => void; mail: () => void; calendar: () => void }) {
  const [view, setView] = useState<"active" | "search">("active");
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<ProjectRow[]>([]);
  const [offline, setOffline] = useState(false);
  const [alerts, setAlerts] = useState<MobileAlerts | null>(null);
  useEffect(() => {
    // Without an abort, typing "ab" then "abc" on mobile data could land the
    // older response last and leave the wrong result set on screen.
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const suffix = view === "search" ? `?view=search&q=${encodeURIComponent(query)}` : "?view=active";
      void api<{ projects: ProjectRow[] }>(`/api/v1/projects${suffix}`, { signal: controller.signal })
        .then((body) => { setRows(body.projects); setOffline(false); })
        .catch(() => { if (!controller.signal.aborted) setOffline(true); });
    }, view === "search" ? 180 : 0);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [view, query]);
  useEffect(() => {
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
  }, []);
  return <main className="screen">
    <header className="home-header">
      <div className="home-brand" aria-label="Eldrun">
        <img className="home-logo" src="/icons/icon.svg" alt="" />
        <strong>Eldrun</strong>
      </div>
      <div className="home-tools" aria-label="Global views">
        <button className="home-tool" onClick={todo}>☑ <span>To-do</span></button>
        <button className="home-tool" onClick={mail}>✉ <span>Mail</span></button>
        <button className="home-tool" onClick={calendar}>🗓 <span>Calendar</span></button>
      </div>
    </header>
    <div className="projects-row">
      <h1>Projects</h1>
      <div className="mobile-build"><small>Eldrun Mobile v{APP_VERSION}</small><span className={offline ? "lamp off" : "lamp"} /></div>
    </div>
    <nav><button className={view === "active" ? "selected" : ""} onClick={() => setView("active")}>Active</button><button className={view === "search" ? "selected" : ""} onClick={() => setView("search")}>Search</button></nav>
    {view === "search" && <input className="search" placeholder="Project name" value={query} autoFocus onChange={(event) => setQuery(event.target.value)} />}
    {offline && <p className="error">Host unavailable{rows.length ? " — showing the last list this session loaded." : ". Project data is never loaded from cache."}</p>}
    <section className="cards">{rows.map((project) => <button className="card" key={project.id} onClick={() => open(project.id)}><span><strong>{project.label}</strong><small>{project.status}</small></span><span className="count">{project.live_sessions}</span></button>)}</section>
    {alerts && <AlertRows alerts={alerts} todo={todo} mail={mail} />}
  </main>;
}
