import { useEffect, useState } from "react";
import { resumeAuth } from "./auth";
import type { TabRow } from "./api";
import { Pair } from "./screens/Pair";
import { Home } from "./screens/Home";
import { Project } from "./screens/Project";
import { Terminal } from "./screens/Terminal";

type Screen = { kind: "home" } | { kind: "project"; id: string } | { kind: "terminal"; project: string; tab: TabRow };
export function App() {
  const [auth, setAuth] = useState<"loading" | "paired" | "unpaired" | "unavailable">("loading");
  const [screen, setScreen] = useState<Screen>({ kind: "home" });
  const resume = () => void resumeAuth().then(setAuth).catch(() => setAuth("unavailable"));
  useEffect(resume, []);
  if (auth === "loading") return <main className="screen splash">✦</main>;
  if (auth === "unavailable") return <main className="screen splash"><p>Host unavailable. No project or terminal data is loaded from cache.</p><button className="primary" onClick={resume}>Retry</button></main>;
  if (auth === "unpaired") return <Pair onDone={() => setAuth("paired")} />;
  if (screen.kind === "terminal") return <Terminal tab={screen.tab} back={() => setScreen({ kind: "project", id: screen.project })} />;
  if (screen.kind === "project") return <Project id={screen.id} back={() => setScreen({ kind: "home" })} terminal={(tab) => setScreen({ kind: "terminal", project: screen.id, tab })} />;
  return <Home open={(id) => setScreen({ kind: "project", id })} />;
}
