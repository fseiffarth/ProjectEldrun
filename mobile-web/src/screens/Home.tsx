import { useEffect, useState } from "react";
import { api, type ProjectRow } from "../api";

export function Home({ open }: { open: (id: string) => void }) {
  const [view, setView] = useState<"active" | "search">("active");
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<ProjectRow[]>([]);
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const suffix = view === "search" ? `?view=search&q=${encodeURIComponent(query)}` : "?view=active";
      void api<{ projects: ProjectRow[] }>(`/api/v1/projects${suffix}`).then((body) => { setRows(body.projects); setOffline(false); }).catch(() => { setRows([]); setOffline(true); });
    }, view === "search" ? 180 : 0);
    return () => clearTimeout(timer);
  }, [view, query]);
  return <main className="screen">
    <header><div className="brand"><span className="spark">✦</span><h1>Projects</h1></div><span className={offline ? "lamp off" : "lamp"} /></header>
    <nav><button className={view === "active" ? "selected" : ""} onClick={() => setView("active")}>Active</button><button className={view === "search" ? "selected" : ""} onClick={() => setView("search")}>Search</button></nav>
    {view === "search" && <input className="search" placeholder="Project name" value={query} autoFocus onChange={(event) => setQuery(event.target.value)} />}
    {offline && <p className="error">Host unavailable. Project data is never loaded from cache.</p>}
    <section className="cards">{rows.map((project) => <button className="card" key={project.id} onClick={() => open(project.id)}><span><strong>{project.label}</strong><small>{project.status}</small></span><span className="count">{project.live_sessions}</span></button>)}</section>
  </main>;
}

