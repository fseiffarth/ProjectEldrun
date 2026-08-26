import { useCallback, useEffect, useRef, useState } from "react";
import { hasPairedDevice, logoutAuth, resumeAuth } from "./auth";
import { setUnauthorizedHandler, type TabRow } from "./api";
import { forgetLastTab, rememberLastTab, restoreLastTab } from "./lastTab";
import { hasLocalUnlock } from "./localLock";
import { Pair } from "./screens/Pair";
import { LocalUnlock } from "./screens/LocalUnlock";
import { Home } from "./screens/Home";
import { Project } from "./screens/Project";
import { Terminal } from "./screens/Terminal";
import { Todo } from "./screens/Todo";
import { Mail } from "./screens/Mail";
import { Calendar } from "./screens/Calendar";

type Screen = { kind: "home" } | { kind: "todo" } | { kind: "mail" } | { kind: "calendar" } | { kind: "project"; id: string } | { kind: "terminal"; project: string; tab: TabRow };
const UNLOCKED_SESSION = "eldrun-mobile-local-unlocked";

function hasUnlockedSession(): boolean {
  return sessionStorage.getItem(UNLOCKED_SESSION) === "1";
}

function rememberUnlockedSession(): void {
  sessionStorage.setItem(UNLOCKED_SESSION, "1");
}

function forgetUnlockedSession(): void {
  sessionStorage.removeItem(UNLOCKED_SESSION);
}

export function App() {
  const [auth, setAuth] = useState<"loading" | "paired" | "unpaired" | "setup" | "locked" | "unavailable">("loading");
  const [screen, setScreen] = useState<Screen>({ kind: "home" });
  const authRef = useRef(auth);
  useEffect(() => {
    authRef.current = auth;
  }, [auth]);
  const resume = useCallback(() => {
    setAuth("loading");
    void resumeAuth().then(async (result) => {
      if (result === "paired") {
        rememberUnlockedSession();
        const restored = await restoreLastTab();
        setScreen(restored ? { kind: "terminal", project: restored.projectId, tab: restored.tab } : { kind: "home" });
      } else if (result === "unpaired") {
        forgetUnlockedSession();
        forgetLastTab();
      }
      setAuth(result);
    }).catch(() => setAuth("unavailable"));
  }, []);

  const begin = useCallback(() => {
    setAuth("loading");
    void Promise.all([hasPairedDevice(), hasLocalUnlock()]).then(([paired, locked]) => {
      if (!paired) {
        forgetUnlockedSession();
        forgetLastTab();
        setAuth("unpaired");
      } else if (locked && hasUnlockedSession()) {
        resume();
      } else {
        setAuth(locked ? "locked" : "setup");
      }
    }).catch(() => setAuth("unavailable"));
  }, [resume]);
  useEffect(() => begin(), [begin]);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      if (authRef.current !== "paired") return;
      forgetUnlockedSession();
      setScreen({ kind: "home" });
      setAuth("locked");
    });
    return () => setUnauthorizedHandler(undefined);
  }, []);

  useEffect(() => {
    const lock = () => {
      if (authRef.current !== "paired") return;
      // Detach terminal UI and remove its opaque route before a backgrounded
      // PWA can be shown again. The server receives a best-effort logout; the
      // next local unlock always performs the signed challenge login anew.
      forgetUnlockedSession();
      // The stored reference is an opaque, server-revalidated id, so it can
      // safely outlive the lock. Clearing it here made `restoreLastTab` dead on
      // a phone: backgrounding is the normal way to leave a PWA, so the tab was
      // always already forgotten by the time the user unlocked.
      setScreen({ kind: "home" });
      setAuth("locked");
      void logoutAuth().catch(() => undefined);
    };
    const lockWhenHidden = () => {
      if (document.visibilityState === "hidden") lock();
    };
    document.addEventListener("visibilitychange", lockWhenHidden);
    return () => {
      document.removeEventListener("visibilitychange", lockWhenHidden);
    };
  }, []);

  const openTerminal = (project: string, tab: TabRow) => {
    rememberLastTab(project, tab.id);
    setScreen({ kind: "terminal", project, tab });
  };
  if (auth === "loading") return <main className="screen splash">✦</main>;
  if (auth === "unavailable") return <main className="screen splash"><p>Host unavailable. No project or terminal data is loaded from cache.</p><button className="primary" onClick={begin}>Retry</button></main>;
  if (auth === "unpaired") return <Pair onDone={begin} />;
  if (auth === "setup") return <LocalUnlock setup onUnlocked={() => setAuth("locked")} />;
  if (auth === "locked") return <LocalUnlock setup={false} onUnlocked={resume} />;
  if (screen.kind === "terminal") return <Terminal tab={screen.tab} back={() => setScreen({ kind: "project", id: screen.project })} />;
  if (screen.kind === "todo") return <Todo back={() => setScreen({ kind: "home" })} />;
  if (screen.kind === "mail") return <Mail back={() => setScreen({ kind: "home" })} />;
  if (screen.kind === "calendar") return <Calendar back={() => setScreen({ kind: "home" })} />;
  if (screen.kind === "project") return <Project id={screen.id} back={() => setScreen({ kind: "home" })} terminal={(tab) => openTerminal(screen.id, tab)} />;
  return <Home open={(id) => setScreen({ kind: "project", id })} todo={() => setScreen({ kind: "todo" })} mail={() => setScreen({ kind: "mail" })} calendar={() => setScreen({ kind: "calendar" })} />;
}
